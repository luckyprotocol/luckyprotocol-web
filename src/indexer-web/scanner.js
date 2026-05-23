// Block-by-block scanner — drives applyTx for the browser indexer.
//
// Strategy: PARALLEL PREFETCH + SERIAL APPLY.
//
//   Bottleneck analysis: with a single in-flight HTTP request the
//   scanner spends ~500ms per block waiting on TLS/CDN and ~70ms
//   parsing. CPU is idle most of the time. Switching to parallel
//   prefetch (CONCURRENT_FETCHES blocks downloading at once)
//   saturates the network pipe without overwhelming the public
//   Esplora endpoint.
//
//   We MUST apply blocks in strict height order — applyTx mutates
//   state.utxoBalances and a later block can spend a UTXO created
//   by an earlier one. So fetching is concurrent, but applying is
//   serial: a sliding window of fetches stays full, results land
//   into a per-height slot, and a single consumer drains slots in
//   height order.
//
//   Per-block work:
//     1. GET /block-height/:h           (small, ~70 bytes)
//     2. GET /block/:hash/raw           (1-2 MB)
//     3. parseRawBlock locally          (~70ms CPU)
//     4. for each protocol-relevant tx (rare):
//          GET /tx/:txid               (sender resolution)
//          applyTx
//
//   With CONCURRENT_FETCHES=8 the network pipeline stays saturated
//   and per-block wall time drops from ~600ms to ~120ms. A 1,000-
//   block cold scan finishes in ~2 minutes instead of ~10.
//
//   Public-Esplora rate limits: mempool.space is ~600 req/min,
//   blockstream.info similar. At 8 concurrent fetches × 2 reqs/block
//   = ~16 req/sec sustained, well under the limit, and our
//   per-host circuit breaker in chain-web/esplora.js handles
//   transient 429s by failover.

import {
  fetchBlockHashAt,
  fetchBlocksMeta,
  fetchBlockRaw,
  fetchTxFull,
} from "../chain-web/esplora.js";
import { parsePayload, LCKPROTOCOL_V1_HEIGHT } from "./protocol.js";
import { applyTx } from "./apply.js";
import { touchProgress, pushError } from "./state.js";
import {
  parseRawBlock,
  txContextFromParsedTx,
  txSpendsAnyUtxo,
} from "./raw_block.js";

// How many block-fetch pipelines run concurrently. We learned the hard
// way that 16 trips mempool.space + blockstream.info burst limits —
// both 429 within seconds, the circuit breakers open, and the scanner
// then enters a retry-storm that keeps the hosts rate-limited
// indefinitely. 4 is enough to overlap network latency with parse CPU
// without provoking the public Esplora.
//
// On top of this we add a global rate gate (_rateGate below) that caps
// the indexer at SUSTAINED_REQS_PER_SEC raw HTTP calls per second so
// even bursty retries can't exceed the providers' ceiling.
const CONCURRENT_FETCHES = 4;

// Sustained ceiling for indexer-originated HTTP calls. mempool.space's
// per-IP soft limit is ~10 req/sec; we share with the React layer's
// tip/syncAddress polls, so 4 req/sec for the indexer leaves headroom.
const SUSTAINED_REQS_PER_SEC = 4;

// Token-bucket-style minimum spacing between any two HTTP issuances.
// Computed from SUSTAINED_REQS_PER_SEC.
const MIN_REQ_SPACING_MS = Math.ceil(1000 / SUSTAINED_REQS_PER_SEC);

// Last HTTP issuance timestamp (ms). All scanner HTTP calls funnel
// through `_rateGate()` which waits until at least
// MIN_REQ_SPACING_MS has elapsed since the previous call. Module-
// level so concurrent pipeline slots actually serialize their
// network-side timing — without this, 4 concurrent slots would each
// fire 4 requests in the same millisecond.
let _lastReqAt = 0;
let _rateGateQueue = Promise.resolve();

/**
 * Token-bucket rate gate. Each caller `await _rateGate()` and is
 * unblocked once it's been at least MIN_REQ_SPACING_MS since the
 * previous unblock. Serializes concurrent prefetches into a polite
 * sustained-rate stream.
 */
async function _rateGate() {
  // Chain onto the previous gate-await so concurrent callers form a
  // queue rather than all reading `_lastReqAt` simultaneously.
  const prev = _rateGateQueue;
  let release;
  _rateGateQueue = new Promise((r) => { release = r; });
  try {
    await prev;
    const now = Date.now();
    const wait = Math.max(0, _lastReqAt + MIN_REQ_SPACING_MS - now);
    if (wait > 0) await sleep(wait);
    _lastReqAt = Date.now();
  } finally {
    release();
  }
}

// Hash-batch size. Esplora's `/blocks/:start_height` returns 10
// consecutive blocks per call; we cache hashes in this Map as we
// stream them in. Walked DOWN by Esplora (h, h-1, ..., h-9) so we
// reverse on the consuming side.
const HASH_BATCH = 10;

// Cache: height -> hash. Populated by `_ensureHash`; consumed by
// `_prefetchBlock`. Persists across coldScan calls in the module so a
// steady-state poll re-uses the previous tick's batched hashes
// instead of issuing fresh /block-height/:h calls.
const _hashCache = new Map();

/**
 * Make sure `_hashCache` contains the hash for `height`. If absent,
 * issue ONE batched /blocks/:start_height call to backfill 10
 * consecutive heights at once.
 *
 * Falls back to the single-height /block-height/:h endpoint if the
 * batch endpoint fails (some Esplora forks don't expose it). Worst
 * case we just do what the old code did.
 */
async function _ensureHash(height) {
  const cached = _hashCache.get(height);
  if (cached) return cached;
  // The batch endpoint walks down — pick a start such that `height` is
  // covered: start = height + (HASH_BATCH - 1), then it returns
  // [start, start-1, ..., start-9] which includes `height`.
  // Clamp `start` so we don't overshoot tip (Esplora returns
  // shorter arrays at the tip boundary).
  const start = height + HASH_BATCH - 1;
  try {
    await _rateGate();
    const blocks = await fetchBlocksMeta(start);
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b && typeof b.height === "number" && typeof b.id === "string") {
          _hashCache.set(b.height, b.id);
        }
      }
    }
  } catch (_e) {
    // Batch fetch failed — fall through to single-height path.
  }
  const found = _hashCache.get(height);
  if (found) return found;
  // Last-resort: single-height fetch. Same endpoint the original
  // scanner used, just no batching.
  await _rateGate();
  const hash = await fetchBlockHashAt(height);
  if (hash) _hashCache.set(height, hash);
  return hash;
}

// ---- Block prefetch (fetch only — does NOT touch state) ----------------

/**
 * Fetch one block's hash + raw bytes. Pure function — does NOT mutate
 * `state` or do any apply work. Safe to call concurrently for
 * different heights.
 *
 * Returns `{ height, hash, raw }`. Throws on network failure (caller
 * decides retry policy).
 */
async function _prefetchBlock(height, signal) {
  if (signal?.aborted) throw new Error("scan aborted");
  const hash = await _ensureHash(height);
  if (!hash) throw new Error(`prefetchBlock(${height}): no hash from Esplora`);
  if (signal?.aborted) throw new Error("scan aborted");
  await _rateGate();
  const raw = await fetchBlockRaw(hash);
  return { height, hash, raw };
}

// ---- Block apply (serial — mutates state) ------------------------------

/**
 * Apply one already-fetched block's relevant txs to state. Must be
 * called in strict height order — later blocks may depend on
 * utxoBalances entries created by earlier ones.
 */
async function _applyPrefetchedBlock(state, prefetched, signal) {
  const { height, hash, raw } = prefetched;
  if (signal?.aborted) throw new Error("scan aborted");
  state.blockHashes.set(height, hash);
  const { txs } = parseRawBlock(raw);

  for (const parsed of txs) {
    if (parsed.isCoinbase) continue;
    const payload = parsed.payloadText ? parsePayload(parsed.payloadText) : null;
    const spendsTokenUtxo = txSpendsAnyUtxo(parsed, state.utxoBalances);
    if (!payload && !spendsTokenUtxo) continue;

    // Sender resolution: one /tx/:txid call PER RELEVANT TX. Rare
    // enough that we don't bother concurrent-batching these.
    let sender = "";
    try {
      sender = await _resolveSender(parsed.txid);
    } catch (_e) {
      // Audit-only — empty string is fine; balance state unaffected.
    }
    if (signal?.aborted) throw new Error("scan aborted");

    const ctx = txContextFromParsedTx(parsed, height, hash, sender);
    applyTx(state, ctx, payload);
  }

  state.indexedHeight = height;
  touchProgress(state);
}

/**
 * Resolve the audit-only sender — "address that contributed the most
 * input value" — for a protocol-relevant tx. Goes through
 * chain-web's fetchTxFull so it inherits the multi-host fallover /
 * circuit-breaker behavior.
 *
 * Returns "" if the fetch fails or the tx has no resolvable input
 * addresses (raw-script vins, etc.). Sender is audit-only — never
 * affects balance computation — so an empty string is safe.
 */
async function _resolveSender(txid) {
  await _rateGate();
  const tx = await fetchTxFull(txid);
  const byAddr = new Map();
  for (const vin of tx.vin || []) {
    if (vin.is_coinbase) continue;
    const a = vin.prevout?.scriptpubkey_address;
    const v = Number(vin.prevout?.value || 0);
    if (a) byAddr.set(a, (byAddr.get(a) || 0) + v);
  }
  let best = "";
  let bestValue = -1;
  for (const [addr, value] of byAddr) {
    if (value > bestValue) {
      bestValue = value;
      best = addr;
    }
  }
  return best;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---- Cold scan (concurrent fetch + serial apply) -----------------------

/**
 * Walk every block from `fromHeight` to `toHeight` inclusive, applying
 * each one to `state`. Fetches up to CONCURRENT_FETCHES blocks in
 * parallel; applies them strictly in height order so applyTx's
 * cross-block dependencies stay correct.
 *
 * `onProgress(height, toHeight)` fires after each block successfully
 * applies. Caller passes `signal` (AbortController.signal) to support
 * "navigate away" cancellation. Throws an AbortError-shaped exception
 * if aborted; caller (index.js) catches and persists the partial
 * scan state so the next boot resumes from indexedHeight + 1.
 */
export async function coldScan(state, fromHeight, toHeight, onProgress, signal) {
  if (fromHeight > toHeight) return;
  // Bound fromHeight to never go below activation. Catches the case
  // where a snapshot got partially restored with indexedHeight = 0
  // (would otherwise burn time scanning 949,374 pre-activation
  // blocks, all of which short-circuit in applyTx anyway).
  const start = Math.max(fromHeight, LCKPROTOCOL_V1_HEIGHT);
  if (start > toHeight) return;

  // Sliding-window pipeline. Keep CONCURRENT_FETCHES requests in flight;
  // as each lands we kick the next prefetch and drain the front of the
  // queue (serial apply).
  let nextToFetch = start;
  const pending = new Map(); // height -> Promise<{height,hash,raw}>

  const kickNextFetch = () => {
    if (nextToFetch > toHeight) return;
    const h = nextToFetch++;
    pending.set(h, _prefetchBlockWithRetry(h, state, signal));
  };

  // Prime the pipeline.
  while (pending.size < CONCURRENT_FETCHES && nextToFetch <= toHeight) {
    kickNextFetch();
  }

  for (let h = start; h <= toHeight; h++) {
    if (signal?.aborted) throw new Error("scan aborted");
    state.scanCursor = h;

    const prefetchedPromise = pending.get(h);
    if (!prefetchedPromise) {
      // Shouldn't happen — pipeline priming ensures every h has a
      // pending entry — but be defensive.
      pending.set(h, _prefetchBlockWithRetry(h, state, signal));
    }
    const prefetched = await pending.get(h);
    pending.delete(h);

    // Re-arm the pipeline. Done BEFORE apply so the next download
    // overlaps with this block's apply work + sender-resolution
    // HTTP calls.
    kickNextFetch();

    try {
      await _applyPrefetchedBlock(state, prefetched, signal);
    } catch (e) {
      // Apply failed — log and retry once with a fresh fetch. If
      // the retry also fails, surface upstream so the orchestrator
      // can persist partial state and exit the loop.
      pushError(state, {
        kind: "network",
        host: null,
        height: h,
        detail: `apply failed: ${String(e?.message || e)}`,
      });
      if (signal?.aborted) throw new Error("scan aborted");
      await sleep(2000);
      const refetched = await _prefetchBlockWithRetry(h, state, signal);
      await _applyPrefetchedBlock(state, refetched, signal); // re-throw if it still fails
    }
    onProgress?.(h, toHeight);
    // Cheap progress beacon — one console line every 25 blocks so the
    // user can see the scan is alive without flooding devtools.
    if ((h - start) % 25 === 0 || h === toHeight) {
      // eslint-disable-next-line no-console
      console.log(`[indexer] applied block ${h} (${h - start + 1}/${toHeight - start + 1})`);
    }
  }

  state.scanCursor = null;
}

/**
 * Prefetch with unbounded retry + exponential backoff. Network blips
 * (TLS handshake reset, CDN edge 5xx, transient circuit-breaker open)
 * are common on consumer connections; if we bubbled the first failure
 * up the whole cold scan would die and the user would see SPEED 0.0
 * forever. Instead we keep retrying with backoff until aborted —
 * recoverable failures self-heal, unrecoverable ones surface as a
 * growing recent_errors list visible in the DIAGNOSTICS panel.
 *
 * Backoff: 1s, 2s, 4s, 8s, capped at 30s. AbortSignal breaks the loop
 * immediately.
 */
async function _prefetchBlockWithRetry(height, state, signal) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error("scan aborted");
    try {
      return await _prefetchBlock(height, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      attempt += 1;
      const msg = String(e?.message || e);
      // 429 (or all-hosts-unavailable, which usually means BOTH hosts
      // recently 429'd and the circuit breaker tripped) needs a much
      // longer cooldown than transient network blips. The breaker's
      // own cooldown is 60s; we wait at least that long so the retry
      // doesn't hit a still-open circuit and immediately fail again.
      const isRateLimited =
        msg.includes("429") || msg.includes("all Esplora hosts unavailable");
      let backoffMs;
      if (isRateLimited) {
        // Long, near-deterministic wait so retries don't dogpile.
        backoffMs = 60_000 + Math.floor(Math.random() * 15_000);
        // Also log this kind separately so users see "we're rate-
        // limited, waiting" rather than the generic exponential noise.
        pushError(state, {
          kind: "ratelimit",
          host: null,
          height,
          detail: `prefetch rate-limited (attempt ${attempt}): ${msg} — waiting ${Math.round(backoffMs / 1000)}s`,
        });
      } else {
        backoffMs = Math.min(30_000, 1000 * Math.pow(2, attempt - 1));
        pushError(state, {
          kind: "network",
          host: null,
          height,
          detail: `prefetch attempt ${attempt} failed: ${msg} (retrying in ${backoffMs}ms)`,
        });
      }
      // eslint-disable-next-line no-console
      console.warn(`[indexer] prefetch ${height} attempt ${attempt} failed:`,
        msg, "— retrying in", backoffMs, "ms");
      await sleep(backoffMs);
    }
  }
}

// NOTE: Steady-state polling lives in index.js's `_catchUpToTip`. That
// function is mutex-guarded so the initial cold-scan and the 30s poll
// never race on `state.indexedHeight`. An earlier draft of this file
// exported a separate `pollOne` helper, but it was replaced by the
// unified path to fix a UI bug where the scan cursor jittered backward
// during cold scan.
