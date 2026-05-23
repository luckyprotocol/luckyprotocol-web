// Minimal Esplora REST client for the browser.
//
// The desktop build talked to Rust's bdk_wallet which wrapped its own
// Esplora client + rate-limit handling. In the web build the browser
// itself is the client, hitting mempool.space / blockstream.info
// directly over HTTPS. Both endpoints expose CORS so no proxy needed.
//
// This module is the SMALL slice of Esplora functionality required by
// Phase 3 (tx construction): UTXO fetch, tip height, fee estimate,
// broadcast. Phase 4 expands it to address-tx history, individual
// /tx/:txid lookups, the V2 raw-block fetch path, etc.

// Public Esplora endpoints, ordered most-reliable-first. Per-call we
// try in order and fall through on transient failures. We pin to
// mempool.space + blockstream.info because they both:
//   * expose CORS headers (mempool.space sends `Access-Control-Allow-
//     Origin: *`; blockstream.info same)
//   * implement the same /api/* path scheme
//   * accept raw-hex tx broadcast at POST /tx with Content-Type
//     text/plain (NOT application/json — common mistake)
const PUBLIC_ESPLORA_BASES = [
  "https://mempool.space/api",
  "https://blockstream.info/api",
];

// Synchronous Alchemy-key mirror. Updated from the React layer
// whenever the user saves/clears their key (see protocol/chain.js's
// setAlchemyKeySync). When non-null, the corresponding Alchemy
// base URL is PREPENDED to the failover chain — every HTTP call
// tries Alchemy first, only falling back to public Esplora if the
// user has no key or Alchemy itself fails.
//
// Alchemy benefits:
//   - no 429 rate limit (the user's quota is generous + per-key)
//   - usually lower latency from the user's region
//   - the indexer's cold-scan stops dogpiling public mirrors and
//     causing the "all hosts unavailable" cascade
let _alchemyKeyCache = null;
export function setEsploraAlchemyKey(key) {
  _alchemyKeyCache = (key && String(key).trim()) || null;
}
function _alchemyBase() {
  return _alchemyKeyCache
    ? `https://bitcoin-mainnet.g.alchemy.com/v2/${_alchemyKeyCache}`
    : null;
}

// User-provided custom endpoints (from Settings → BTC ENDPOINTS).
// Updated by setEsploraCustomEndpoints. Each entry is normalized to
// `{ kind, url, user?, password? }`. `kind` is one of:
//   - "core"    — Bitcoin Core JSON-RPC (priority #1)
//   - "esplora" — additional Esplora REST mirror
//   - "unisat"  — UniSat REST (placeholder; not used by indexer yet)
// `core` entries are NOT mixed into the path-based failover list —
// they have their own dispatch in coreRpc.js (RPC, not REST).
let _customEndpoints = [];
export function setEsploraCustomEndpoints(list) {
  _customEndpoints = Array.isArray(list)
    ? list
        .filter((ep) => ep && typeof ep.url === "string" && ep.url.trim().length > 0)
        .map((ep) => ({
          kind: String(ep.kind || "esplora").toLowerCase(),
          url: ep.url.trim().replace(/\/+$/, ""),
          user: ep.user || "",
          password: ep.password || "",
        }))
    : [];
}

/**
 * Currently-configured Bitcoin Core RPC endpoints. Returned in the
 * order the user saved them. Used by coreRpc.js — the REST path
 * pipeline ignores them.
 */
export function getCoreRpcEndpoints() {
  return _customEndpoints.filter((ep) => ep.kind === "core");
}

// Cheap synchronous probe used by the Core-first wrappers below to
// avoid even importing coreRpc.js when no Core endpoint is set.
function _hasCoreRpcLazy() {
  return _customEndpoints.some((ep) => ep.kind === "core");
}

/**
 * The live REST-Esplora endpoint list, recomputed per call so Settings
 * changes take effect immediately. Order:
 *   1. user-pinned "esplora" rows (in user order) — usually a private
 *      mirror (electrs / mempool/electrs / electrum-esplora-server)
 *   2. Alchemy (if key cached) — high rate limit, low latency
 *   3. mempool.space — fast public CDN
 *   4. blockstream.info — independent fallback
 *
 * NB: "core" entries are NOT in this list — they're path-incompatible
 * with Esplora REST and live in coreRpc.js's dispatch. The Core
 * priority lives in EACH api wrapper (getTipHeight / fetchBlockHashAt
 * / fetchBlockRaw), which tries Core first and only falls through
 * to this REST list if Core fails or isn't configured.
 *
 * Callers MUST use this helper instead of capturing PUBLIC_ESPLORA_BASES
 * directly so the Alchemy + custom injections work.
 */
function _esploraBases() {
  const userEsplora = _customEndpoints
    .filter((ep) => ep.kind === "esplora")
    .map((ep) => ep.url);
  const a = _alchemyBase();
  const out = [];
  for (const u of userEsplora) out.push(u);
  if (a) out.push(a);
  for (const b of PUBLIC_ESPLORA_BASES) out.push(b);
  return out;
}

// Per-host circuit breaker. Mirrors the pattern already used in
// LuckyProtocolApp.jsx's _fetchEsploraTip — after N consecutive
// failures we skip the host for COOLDOWN_MS so retry storms don't
// pin a dead endpoint.
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const HTTP_TIMEOUT_MS = 12_000;

const _circuit = new Map(); // base → { fails, openUntil }

function circuitAvailable(base) {
  const c = _circuit.get(base);
  if (!c) return true;
  if (c.openUntil > Date.now()) return false;
  return true;
}
function circuitRecordSuccess(base) {
  _circuit.set(base, { fails: 0, openUntil: 0 });
}
function circuitRecordFailure(base) {
  const c = _circuit.get(base) || { fails: 0, openUntil: 0 };
  c.fails += 1;
  if (c.fails >= CIRCUIT_FAIL_THRESHOLD) {
    c.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    c.fails = 0;
  }
  _circuit.set(base, c);
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try each Esplora base in order until one returns 2xx. `pathBuilder`
 * is a function that takes a base and returns the full URL — so the
 * caller can use the same helper for /address/.../utxo, /tx, etc.
 * `parser` converts the Response to the desired type.
 */
async function tryBases(pathBuilder, opts, parser) {
  let lastErr = null;
  for (const base of _esploraBases()) {
    if (!circuitAvailable(base)) continue;
    try {
      const url = pathBuilder(base);
      const resp = await fetchWithTimeout(url, opts);
      if (!resp.ok) {
        // 4xx is usually our bug (bad address, bad txid) — break out
        // and surface the error rather than silently failing over.
        if (resp.status >= 400 && resp.status < 500) {
          const body = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status} from ${base}: ${body.slice(0, 200)}`);
        }
        circuitRecordFailure(base);
        lastErr = new Error(`HTTP ${resp.status} from ${base}`);
        continue;
      }
      circuitRecordSuccess(base);
      return await parser(resp);
    } catch (e) {
      // AbortError, network failure, JSON parse — count as host failure.
      circuitRecordFailure(base);
      lastErr = e;
    }
  }
  throw lastErr || new Error("all Esplora hosts unavailable");
}

/**
 * Fetch all confirmed + unconfirmed UTXOs at `address`. Returns an
 * array of `{ txid, vout, value (sats), status: { confirmed,
 * block_height } }`. Empty array means no UTXOs (clean wallet or
 * unfunded address).
 */
export async function getAddressUtxos(address) {
  return await tryBases(
    (base) => `${base}/address/${encodeURIComponent(address)}/utxo`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Current chain tip height (integer). Used by the sync banner and
 * by tx-builder for `nLockTime = tip` (anti-fee-snipe).
 *
 * Priority: Bitcoin Core JSON-RPC (if configured + reachable) →
 * Esplora REST failover chain. The Core attempt times out at 8s; if
 * it fails fast (CORS rejection, auth fail, etc.) we transparently
 * fall through. After 3 consecutive Core failures the per-endpoint
 * circuit breaker in coreRpc.js opens and we skip Core for 60s.
 */
export async function getTipHeight() {
  if (_hasCoreRpcLazy()) {
    try {
      const { coreGetTipHeight } = await import("./coreRpc.js");
      return await coreGetTipHeight();
    } catch (_e) {
      // Fall through to Esplora — Core may be CORS-blocked or down.
    }
  }
  return await tryBases(
    (base) => `${base}/blocks/tip/height`,
    { method: "GET" },
    async (resp) => parseInt((await resp.text()).trim(), 10),
  );
}

/**
 * Recommended fee rate (sat/vB). Esplora's `/v1/fees/recommended`
 * returns `{ fastestFee, halfHourFee, hourFee, economyFee,
 * minimumFee }`. We default to `halfHourFee` — good UX without
 * paying for next-block urgency.
 */
export async function getRecommendedFeeRate() {
  const data = await tryBases(
    (base) => `${base}/v1/fees/recommended`,
    { method: "GET" },
    (resp) => resp.json(),
  );
  // Float, sat/vB. Clamp to >= 1 since some mempool implementations
  // return 0 during very quiet periods which would build invalid
  // 0-fee txs.
  const rate = Number(data.halfHourFee) || 1;
  return Math.max(1, rate);
}

/**
 * Broadcast a raw signed tx (hex string). Returns the new txid on
 * success, throws with the broadcast error otherwise.
 *
 * Esplora expects raw hex as the POST body with Content-Type
 * `text/plain`. Sending JSON or omitting the content-type is one
 * of the most common reasons a "correctly signed" tx gets rejected
 * with a 400; we set both explicitly here.
 */
export async function broadcastTx(rawHex) {
  if (typeof rawHex !== "string" || !/^[0-9a-fA-F]+$/.test(rawHex)) {
    throw new Error("broadcastTx: rawHex must be a hex string");
  }
  return await tryBases(
    (base) => `${base}/tx`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawHex,
    },
    async (resp) => (await resp.text()).trim(),
  );
}

/**
 * Fetch a previous tx's serialized bytes by txid. Returns a
 * Uint8Array of the raw consensus-serialized tx (hex from
 * /tx/:txid/hex, decoded). Needed to build SegWit witness
 * signatures: BIP143 sighash needs the spent prevout's amount
 * + scriptPubKey, but we already get both from /address/.../utxo,
 * so this is only used for paths we haven't covered yet
 * (e.g. external inputs not at our own address).
 */
export async function getTxRaw(txid) {
  return await tryBases(
    (base) => `${base}/tx/${encodeURIComponent(txid)}/hex`,
    { method: "GET" },
    async (resp) => {
      const hex = (await resp.text()).trim();
      return hexToBytes(hex);
    },
  );
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Outspend status for every vout of a tx, via `/tx/:txid/outspends`.
 * Returns an array indexed by vout, each entry shaped:
 *   { spent: bool, txid?: string, vin?: number, status?: { confirmed,
 *     block_height, block_hash, block_time } }
 *
 * Used by the browser indexer's UTXO-chain follower (fast_send.js)
 * to find SEND txs without scanning blocks: every SEND must spend a
 * known token UTXO, so querying outspends on each utxoBalances entry
 * surfaces every SEND that ever touched our tracked token set.
 */
export async function fetchTxOutspends(txid) {
  return await tryBases(
    (base) => `${base}/tx/${encodeURIComponent(txid)}/outspends`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Fetch the full Esplora tx object via `/tx/:txid` — vin prevouts +
 * vouts both resolved with scriptpubkey_address + value. Used by the
 * indexer's fast cold-scan path to look up the `sender` (audit-only)
 * for the rare protocol-relevant txs: raw-block parsing gives us prev
 * (txid, vout) but not the prev address, and we'd rather pay one
 * extra HTTP call per relevant tx than re-fetch the whole block's
 * paginated tx list.
 */
export async function fetchTxFull(txid) {
  return await tryBases(
    (base) => `${base}/tx/${encodeURIComponent(txid)}`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Confirmation status of a single tx via Esplora `/tx/:txid/status`.
 * Returns `{ confirmed, block_height, block_hash, block_time }`. Caller
 * (protocol.js::getTxStatus) wraps to add the LUCKYPROTOCOL-shaped
 * envelope and treats 404 as "not yet seen".
 */
export async function fetchTxStatus(txid) {
  return await tryBases(
    (base) => `${base}/tx/${encodeURIComponent(txid)}/status`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Block hash at height via Esplora `/block-height/:height`. Returns the
 * 64-char hex hash string. Caller (protocol.js::getBlockHashAt) treats
 * 404 as "block not yet mined".
 */
export async function fetchBlockHashAt(height) {
  // Bitcoin Core RPC priority — `getblockhash <h>` returns the same
  // lowercase hex hash format as Esplora `/block-height/:h`.
  if (_hasCoreRpcLazy()) {
    try {
      const { coreFetchBlockHashAt } = await import("./coreRpc.js");
      return await coreFetchBlockHashAt(height);
    } catch (_e) { /* fall through to Esplora */ }
  }
  return await tryBases(
    (base) => `${base}/block-height/${height}`,
    { method: "GET" },
    async (resp) => (await resp.text()).trim(),
  );
}

/**
 * Block hash + timestamp at height. Two-hop because Esplora doesn't
 * expose a height→{hash, time} endpoint directly. First fetch hash
 * via /block-height, then fetch the header via /block/:hash for the
 * `timestamp` field. The ALMANAC screen uses this for "mined-at"
 * relative-time labels alongside the bet outcome.
 */
export async function fetchBlockInfoAt(height) {
  const hash = await fetchBlockHashAt(height);
  if (!hash) return null;
  const block = await tryBases(
    (base) => `${base}/block/${encodeURIComponent(hash)}`,
    { method: "GET" },
    (resp) => resp.json(),
  );
  return { hash, time: Number(block.timestamp) || 0 };
}

/**
 * Fetch block header by hash. Returns the full Esplora block object
 * `{ id, height, timestamp, tx_count, size, weight, ... }`. The
 * browser indexer (indexer-web/scanner.js) uses `tx_count` to plan
 * the per-block fetchBlockTxs pagination.
 */
export async function fetchBlockHeader(hash) {
  return await tryBases(
    (base) => `${base}/block/${encodeURIComponent(hash)}`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Batch block metadata via Esplora `/blocks/:start_height`. Returns an
 * array of up to 10 consecutive block-info objects starting at
 * `startHeight` and walking DOWNWARD (Esplora convention). Each entry
 * carries `{ id, height, timestamp, tx_count, size, weight, ... }`.
 *
 * Used by the browser indexer to batch up the hash-by-height lookups:
 * fetching 10 hashes is ~1 HTTP round-trip instead of 10 sequential
 * `/block-height/:h` calls. Cuts cold-scan HTTP volume nearly in
 * half (was 2 reqs/block, now 1.1).
 *
 * Note Esplora's ordering quirk: `/blocks/:height` returns
 * `[height, height-1, height-2, ..., height-9]` (descending). Caller
 * must reverse if it needs ascending order.
 */
export async function fetchBlocksMeta(startHeight) {
  return await tryBases(
    (base) => `${base}/blocks/${startHeight}`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Fetch the raw consensus-serialized block bytes via Esplora
 * `/block/:hash/raw`. Returns a Uint8Array of the full block (header +
 * varint tx_count + tx bytes, no witness stripping). Used by the
 * browser indexer's fast path: parse once locally instead of paying
 * for ~120 HTTP round-trips of paginated /block/:hash/txs/:start.
 *
 * Typical block is 1-2 MB. Esplora serves this as a single response;
 * mempool.space's CDN caches it aggressively so repeated fetches
 * across a cold rescan are cheap.
 */
export async function fetchBlockRaw(hash) {
  // Bitcoin Core RPC priority — `getblock <hash> 0` returns raw hex,
  // coreFetchBlockRaw decodes to Uint8Array (same shape Esplora's
  // /block/:hash/raw arrayBuffer returns). LAN Core RPC is ~5–10×
  // faster than public Esplora for this call.
  if (_hasCoreRpcLazy()) {
    try {
      const { coreFetchBlockRaw } = await import("./coreRpc.js");
      return await coreFetchBlockRaw(hash);
    } catch (_e) { /* fall through to Esplora */ }
  }
  return await tryBases(
    (base) => `${base}/block/${encodeURIComponent(hash)}/raw`,
    { method: "GET" },
    async (resp) => new Uint8Array(await resp.arrayBuffer()),
  );
}

/**
 * Paginated block-txs fetch via Esplora `/block/:hash/txs/:start_index`.
 * Esplora returns 25 txs per page, starting at `startIndex` (which MUST
 * be a multiple of 25). Each tx is the full Esplora shape with vin
 * prevouts already resolved — exactly what the indexer needs for
 * apply_tx without extra round-trips per input.
 *
 * Caller (scanner.js) loops `startIndex = 0, 25, 50, ...` until the
 * returned array is shorter than 25.
 */
export async function fetchBlockTxs(hash, startIndex = 0) {
  return await tryBases(
    (base) =>
      `${base}/block/${encodeURIComponent(hash)}/txs/${startIndex}`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Most-recent ≤25 txs involving an address via Esplora `/address/:addr/txs`.
 * Returns the raw Esplora shape (vin / vout arrays with prevout context
 * resolved). Caller (chain.js::listAddressTxs) translates to the
 * desktop-API shape with direction + sent/received summary.
 *
 * Esplora's response is mempool-txs-first, then confirmed-tip-first.
 * For follow-up pagination call `fetchAddressTxsChain(addr, lastTxid)`.
 */
export async function getAddressTxs(address) {
  return await tryBases(
    (base) => `${base}/address/${encodeURIComponent(address)}/txs`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Paginated CONFIRMED-only tx history via `/address/:addr/txs/chain` (no
 * mempool entries). First page omits `lastSeenTxid`; subsequent pages
 * pass the txid of the LAST item in the previous page to walk
 * backwards through history. Each page returns up to 25 txs in
 * REVERSE chronological order (newest first).
 *
 * This is the engine of the browser indexer's fast-bootstrap path:
 * one HTTP call per 25 protocol-fee-paying txs gives us every DEPLOY
 * and every MINE the chain has ever seen, with zero empty-block
 * scanning. See indexer-web/fast_bootstrap.js for the caller.
 */
export async function fetchAddressTxsChain(address, lastSeenTxid = null) {
  return await tryBases(
    (base) =>
      lastSeenTxid
        ? `${base}/address/${encodeURIComponent(address)}/txs/chain/${encodeURIComponent(lastSeenTxid)}`
        : `${base}/address/${encodeURIComponent(address)}/txs/chain`,
    { method: "GET" },
    (resp) => resp.json(),
  );
}

/**
 * Decode an Esplora `vout.scriptpubkey` (hex string) and extract any
 * LUCKYPROTOCOL OP_RETURN payload it carries. Returns the ASCII payload
 * (e.g. "LUCKYPROTOCOL|DEPLOY|MYTOKEN") or null if the vout doesn't
 * carry a recognizable protocol payload.
 *
 * Mirrors the indexer's `extract_luckyprotocol_payload_from_raw_tx`
 * push-opcode coverage (direct push 0x01-0x4b, OP_PUSHDATA1 0x4c,
 * OP_PUSHDATA2 0x4d) so the JS display agrees byte-for-byte with the
 * Rust indexer's classification.
 */
function decodeOpReturnPayload(scriptHex) {
  if (typeof scriptHex !== "string" || scriptHex.length < 4) return null;
  const bytes = hexToBytes(scriptHex);
  if (bytes.length < 2 || bytes[0] !== 0x6a) return null;
  const pushOp = bytes[1];
  let payload;
  if (pushOp >= 0x01 && pushOp <= 0x4b) {
    const len = pushOp;
    if (bytes.length !== 2 + len) return null;
    payload = bytes.slice(2, 2 + len);
  } else if (pushOp === 0x4c && bytes.length >= 3) {
    const len = bytes[2];
    if (bytes.length !== 3 + len) return null;
    payload = bytes.slice(3, 3 + len);
  } else if (pushOp === 0x4d && bytes.length >= 4) {
    const len = bytes[2] | (bytes[3] << 8);
    if (bytes.length !== 4 + len) return null;
    payload = bytes.slice(4, 4 + len);
  } else {
    return null;
  }
  // Decode as ASCII. LUCKYPROTOCOL payloads are pure ASCII; if we see
  // any non-ASCII byte, this isn't ours.
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] < 0x20 || payload[i] > 0x7E) return null;
  }
  const text = new TextDecoder().decode(payload);
  if (!text.startsWith("LUCKYPROTOCOL|")) return null;
  return text;
}

/**
 * Scan a tx (Esplora shape) for its LUCKYPROTOCOL OP_RETURN payload.
 * Returns the string payload or null. Multi-OP_RETURN txs return null
 * (matches indexer's "burn-on-multi-OP_RETURN" rule — those txs are
 * protocol-invalid even if one OP_RETURN looks well-formed).
 */
export function extractLuckyprotocolPayload(tx) {
  let opReturnCount = 0;
  let found = null;
  for (const vout of tx.vout || []) {
    if (vout.scriptpubkey_type !== "op_return") continue;
    opReturnCount += 1;
    if (opReturnCount > 1) return null;
    const payload = decodeOpReturnPayload(vout.scriptpubkey);
    if (payload) found = payload;
  }
  return found;
}
