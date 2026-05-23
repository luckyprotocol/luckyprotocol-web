// FAST BOOTSTRAP — Pre-populate state via the PROJECT_FEE_ADDRESS
// address index instead of block-by-block scanning.
//
// Why this works (cohort v950382+):
//   All three protocol ops pay a fee to PROJECT_FEE_ADDRESS by
//   consensus:
//     - DEPLOY: >= 5460 sats (DEPLOY_PROTOCOL_FEE_SATS)
//     - MINE:   >= 546  sats (PROJECT_FEE_SATS)
//     - SEND:   >= 546  sats (SEND_PROTOCOL_FEE_SATS — added in v950382;
//                            indexer rejects SENDs without it)
//   So the address history of PROJECT_FEE_ADDRESS contains EVERY
//   protocol tx the chain has ever applied. Esplora's
//   `/address/:addr/txs/chain[/:last]` returns 25 confirmed txs per
//   page; a handful of pages covers the whole activation-to-tip
//   window in seconds.
//
//   Compared to the old per-block scan (cold-fetch every block from
//   activation to tip, ~1.5 MB each, parse, check for OP_RETURN):
//     before: 134 blocks × ~600ms = ~80 sec for empty + 1 sec/block
//     after:  ~1 page × ~300ms = ~0.3 sec (typical fresh-protocol stage)
//
// What this does NOT cover:
//   - BURN cases: a non-protocol tx that happens to spend a token
//     UTXO. Those don't pay the project fee (they're not
//     protocol-aware) and don't appear in PROJECT_FEE_ADDRESS history.
//     The follow_spends.js follower picks these up as a safety net,
//     and the steady-state catch-up also scans any blocks past
//     bootstrap so on-going BURNs land within a poll cycle.
//   - Reorgs deeper than the bootstrap-applied range. Same caveat as
//     the rest of the indexer.

import { fetchAddressTxsChain, extractLuckyprotocolPayload } from "../chain-web/esplora.js";
import { parsePayload, LCKPROTOCOL_V1_HEIGHT } from "./protocol.js";
import { applyTx, PROJECT_FEE_ADDRESS } from "./apply.js";
import { touchProgress, pushError } from "./state.js";

// Hard cap on paging — protects against infinite loops if Esplora
// returns a malformed last_seen_txid response. 1000 pages × 25 txs =
// 25,000 DEPLOY+MINE events, which is many years of full-throttle
// protocol activity.
const MAX_PAGES = 1000;

// Minimum spacing between page fetches. Same SUSTAINED_REQS_PER_SEC=4
// budget as the scanner; fast bootstrap is 1 HTTP per page so this
// caps it at ~4 pages/sec — fast enough that even a 1000-page wallet
// finishes in <5 minutes, slow enough that we don't trip the public
// Esplora 429 ceiling.
const PAGE_SPACING_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a TxContext from an Esplora tx object (the shape returned by
 * `/address/:addr/txs/chain`). Esplora already resolves vin prevouts
 * (with scriptpubkey_address + value), so unlike the raw-block path
 * we get sender for free — no follow-up /tx/:txid fetch needed.
 *
 * Returns null if the tx isn't confirmed yet (mempool-only entries
 * don't have a block_height; we ignore them during bootstrap).
 */
function _esploraTxToContext(tx) {
  const height = tx.status?.block_height;
  if (typeof height !== "number") return null;
  const blockHash = String(tx.status?.block_hash || "").toLowerCase();

  // Sender = input address that contributed the most value, matching
  // raw_block's TxContext.sender semantics.
  const spentOutpoints = [];
  const inputValueByAddress = new Map();
  for (const vin of tx.vin || []) {
    if (vin.is_coinbase) continue;
    if (vin.txid && typeof vin.vout === "number") {
      spentOutpoints.push([vin.txid, vin.vout]);
    }
    const addr = vin.prevout?.scriptpubkey_address;
    const value = Number(vin.prevout?.value || 0);
    if (addr) {
      inputValueByAddress.set(addr, (inputValueByAddress.get(addr) || 0) + value);
    }
  }
  let sender = "";
  let bestValue = -1;
  for (const [addr, value] of inputValueByAddress) {
    if (value > bestValue) {
      bestValue = value;
      sender = addr;
    }
  }

  const vouts = tx.vout || [];
  const voutCount = vouts.length;
  const opReturnVouts = [];
  const voutAddresses = new Array(voutCount).fill(null);
  const voutValues = new Array(voutCount).fill(0);
  for (let i = 0; i < voutCount; i++) {
    const v = vouts[i];
    voutAddresses[i] = v.scriptpubkey_address ?? null;
    voutValues[i] = Number(v.value || 0);
    if (v.scriptpubkey_type === "op_return") opReturnVouts.push(i);
  }

  return {
    txid: String(tx.txid || "").toLowerCase(),
    blockHeight: height,
    blockHash,
    sender,
    spentOutpoints,
    voutCount,
    opReturnVouts,
    voutAddresses,
    voutValues,
  };
}

/**
 * Run the fast-bootstrap pass. Returns the highest block_height we
 * applied an event from (or `null` if no protocol txs were found).
 * The orchestrator (index.js) uses this to advance `state.indexedHeight`
 * past the bootstrap window before kicking the steady-state catch-up.
 *
 * Bootstrap is BEST-EFFORT — if any HTTP step fails, we log to
 * `state.recentErrors` and return null; the caller falls back to the
 * traditional cold scan, which is correct (just slower).
 */
export async function fastBootstrap(state, signal) {
  if (signal?.aborted) throw new Error("scan aborted");

  // STEP 1: walk address history backwards until we hit a tx older
  // than activation, or run out of pages.
  const collected = [];
  let lastSeenTxid = null;
  let foundPreActivation = false;

  // eslint-disable-next-line no-console
  console.log("[indexer] fast-bootstrap: querying", PROJECT_FEE_ADDRESS, "tx history");

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) throw new Error("scan aborted");
    let txs;
    try {
      txs = await fetchAddressTxsChain(PROJECT_FEE_ADDRESS, lastSeenTxid);
    } catch (e) {
      pushError(state, {
        kind: "network",
        host: null,
        height: null,
        detail: `fast-bootstrap page ${page} failed: ${String(e?.message || e)}`,
      });
      // eslint-disable-next-line no-console
      console.warn("[indexer] fast-bootstrap page", page, "failed:", e?.message || e);
      return null;
    }
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      const h = tx.status?.block_height ?? 0;
      if (h < LCKPROTOCOL_V1_HEIGHT) {
        foundPreActivation = true;
        break;
      }
      collected.push(tx);
    }
    if (foundPreActivation || txs.length < 25) break;
    lastSeenTxid = txs[txs.length - 1].txid;
    // Be polite to public Esplora — 4 pages/sec ceiling.
    await sleep(PAGE_SPACING_MS);
  }

  // eslint-disable-next-line no-console
  console.log("[indexer] fast-bootstrap: collected", collected.length,
    "candidate txs from", PROJECT_FEE_ADDRESS);

  if (collected.length === 0) {
    touchProgress(state);
    return null;
  }

  // STEP 2: chronological sort. Esplora returns newest-first across
  // pages but ordering within a block is not guaranteed; sort by
  // (height, txid) so apply order is deterministic.
  collected.sort((a, b) => {
    const ha = a.status?.block_height ?? 0;
    const hb = b.status?.block_height ?? 0;
    if (ha !== hb) return ha - hb;
    return String(a.txid).localeCompare(String(b.txid));
  });

  // STEP 3: apply each tx. Most are DEPLOY/MINE — anything else (an
  // unrelated payment to PROJECT_FEE_ADDRESS without a LUCKYPROTOCOL
  // OP_RETURN, e.g. someone tipping the project) is silently
  // ignored after the parsePayload check returns null. Use the
  // height of the last applied tx as the new indexedHeight floor.
  let lastAppliedHeight = LCKPROTOCOL_V1_HEIGHT - 1;
  let applied = 0;
  for (const tx of collected) {
    if (signal?.aborted) throw new Error("scan aborted");
    const ctx = _esploraTxToContext(tx);
    if (!ctx) continue;
    const payloadText = extractLuckyprotocolPayload(tx);
    if (!payloadText) continue;
    const payload = parsePayload(payloadText);
    if (!payload) continue;
    // Also record the block hash so the steady-state catch-up can do
    // reorg detection against it.
    state.blockHashes.set(ctx.blockHeight, ctx.blockHash);
    applyTx(state, ctx, payload);
    applied += 1;
    if (ctx.blockHeight > lastAppliedHeight) {
      lastAppliedHeight = ctx.blockHeight;
    }
  }

  // eslint-disable-next-line no-console
  console.log("[indexer] fast-bootstrap: applied", applied,
    "LUCKYPROTOCOL events, last height", lastAppliedHeight);

  touchProgress(state);
  return applied > 0 ? lastAppliedHeight : null;
}
