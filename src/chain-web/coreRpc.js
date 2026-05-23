// Bitcoin Core JSON-RPC adapter — browser side.
//
// Mirrors luckyprotocol-indexer/src/core_rpc.rs's interface (the
// desktop indexer's Bitcoin Core path) so the same protocol-fee /
// block-scan pipeline that runs against Esplora REST can also run
// against a self-hosted Bitcoin Core node.
//
// PRIORITY: when a user adds a `[core]` row in Settings → BTC
// ENDPOINTS, the corresponding RPC endpoint takes precedence over
// Alchemy and public Esplora for the three calls Core natively
// supports:
//   - getTipHeight                  (RPC: getblockcount)
//   - fetchBlockHashAt(height)      (RPC: getblockhash <height>)
//   - fetchBlockRaw(hash)           (RPC: getblock <hash> 0 — hex bytes)
//
// Calls that REQUIRE address-index data — fetchAddressTxsChain,
// fetchTxOutspends, getAddressUtxos, fetchTxFull — fall through to
// Esplora because Bitcoin Core does NOT index addresses without
// running a separate electrs/electrum-esplora process. We deliberately
// don't try to fake those via getblock+txindex scans (would scan
// every block) — that's what Esplora is for.
//
// CORS reality check: browsers can't POST to a vanilla Bitcoin Core
// `:8332` socket because Core doesn't emit CORS headers. The
// expected deployment is for the user to front their node with
// nginx/caddy/etc. adding `Access-Control-Allow-Origin: *` (the
// Settings panel mentions this). When CORS blocks the POST we fail
// cleanly and the higher-level pipeline falls back to the next
// endpoint — no infinite retry, no scary error toast.

import { getCoreRpcEndpoints } from "./esplora.js";

/**
 * Returns true if at least one Bitcoin Core RPC endpoint is configured.
 * Higher-level wrappers (getTipHeight etc.) check this first to decide
 * whether to attempt the RPC path before falling through to Esplora.
 */
export function hasCoreRpc() {
  return getCoreRpcEndpoints().length > 0;
}

const RPC_TIMEOUT_MS = 8000;

// Per-endpoint circuit breaker, parallel to esplora.js's. Bitcoin Core
// requests that fail fast (CORS rejection, auth 401, connection
// refused) shouldn't keep being retried on every block — open the
// breaker for COOLDOWN_MS once we hit FAIL_THRESHOLD consecutive
// failures so the pipeline silently routes around the dead node.
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;
const _coreBreaker = new Map(); // url -> { fails, openUntil }

function coreAvailable(url) {
  const b = _coreBreaker.get(url);
  if (!b) return true;
  if (b.openUntil > Date.now()) return false;
  return true;
}
function coreRecordSuccess(url) {
  _coreBreaker.set(url, { fails: 0, openUntil: 0 });
}
function coreRecordFailure(url) {
  const b = _coreBreaker.get(url) || { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= FAIL_THRESHOLD) {
    b.openUntil = Date.now() + COOLDOWN_MS;
    b.fails = 0;
  }
  _coreBreaker.set(url, b);
}

/**
 * Issue a JSON-RPC call against a configured Bitcoin Core endpoint.
 * Returns the `result` field on success, throws on:
 *   - network failure (CORS, DNS, connection refused)
 *   - HTTP 4xx/5xx other than 500 (500 is JSON-RPC method error)
 *   - JSON-RPC `error` field present in the response body
 *
 * `endpoint` is `{ url, user, password }` from getCoreRpcEndpoints().
 * Basic-Auth is computed via btoa — the browser version of
 * Rust's reqwest .basic_auth().
 */
async function _rpcCall(endpoint, method, params) {
  const body = JSON.stringify({
    jsonrpc: "1.0",
    id: "luckyprotocol-web",
    method,
    params: params || [],
  });
  const headers = { "Content-Type": "application/json" };
  if (endpoint.user || endpoint.password) {
    headers["Authorization"] =
      "Basic " + btoa(`${endpoint.user || ""}:${endpoint.password || ""}`);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok && resp.status !== 500) {
    throw new Error(`core-rpc ${method} HTTP ${resp.status}`);
  }
  const parsed = await resp.json();
  if (parsed.error) {
    throw new Error(`core-rpc ${method} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

/**
 * Try each configured Bitcoin Core endpoint in order until one succeeds.
 * Returns the `result` of the first 2xx + non-error response; throws
 * if every endpoint fails. Used by the public wrappers below.
 */
async function _tryCoreRpc(method, params) {
  const endpoints = getCoreRpcEndpoints();
  if (endpoints.length === 0) throw new Error("no Bitcoin Core endpoints configured");
  let lastErr = null;
  for (const ep of endpoints) {
    if (!coreAvailable(ep.url)) continue;
    try {
      const out = await _rpcCall(ep, method, params);
      coreRecordSuccess(ep.url);
      return out;
    } catch (e) {
      coreRecordFailure(ep.url);
      lastErr = e;
    }
  }
  throw lastErr || new Error(`core-rpc ${method}: all endpoints unavailable`);
}

// ---- Public wrappers (Esplora-compatible return shapes) -----------------

/**
 * Chain tip height. Esplora returns this as a plain integer; the
 * `getblockcount` RPC returns the same. No shape translation needed.
 */
export async function coreGetTipHeight() {
  const h = await _tryCoreRpc("getblockcount", []);
  const n = Number(h);
  if (!Number.isInteger(n)) throw new Error(`core-rpc getblockcount: bad result ${h}`);
  return n;
}

/**
 * Block hash by height. RPC returns a lowercase hex string; matches
 * Esplora `/block-height/:h` exactly.
 */
export async function coreFetchBlockHashAt(height) {
  return await _tryCoreRpc("getblockhash", [height]);
}

/**
 * Diagnose a single Bitcoin Core endpoint's reachability. Used by
 * Settings → BTC ENDPOINTS → TEST. Tries to call `getblockcount`
 * and returns a structured outcome the UI can render WITHOUT
 * leaking the user's RPC password into the toast.
 *
 *   { ok: true,  tipHeight }                                — success
 *   { ok: false, kind: "cors",       detail }               — CORS rejection
 *   { ok: false, kind: "network",    detail }               — DNS/conn refused
 *   { ok: false, kind: "auth",       detail }               — 401/403
 *   { ok: false, kind: "rpc",        detail }               — JSON-RPC error
 *   { ok: false, kind: "unknown",    detail }               — anything else
 *
 * CORS-rejection detection: in browsers, a CORS failure surfaces as
 * a `TypeError` from `fetch` with no `resp` object — the network
 * request actually went out, but the browser blocked JS from
 * reading the response. We can't tell CORS from connection-refused
 * with 100% certainty (both look like TypeError), but if the URL
 * parses + the host is reachable per a HEAD probe, TypeError is
 * overwhelmingly CORS in practice.
 */
export async function testCoreRpc(endpoint) {
  if (!endpoint || typeof endpoint.url !== "string" || !endpoint.url) {
    return { ok: false, kind: "unknown", detail: "endpoint URL missing" };
  }
  try {
    const tipHeight = await _rpcCall(endpoint, "getblockcount", []);
    if (!Number.isInteger(Number(tipHeight))) {
      return {
        ok: false,
        kind: "rpc",
        detail: `getblockcount returned non-integer: ${tipHeight}`,
      };
    }
    return { ok: true, tipHeight: Number(tipHeight) };
  } catch (e) {
    const msg = String(e?.message || e);
    // TypeError from fetch — browser blocked it. Common causes:
    //   - CORS missing the Access-Control-Allow-Origin header
    //   - Mixed-content (page is HTTPS, RPC is HTTP)
    //   - Connection refused (node down or wrong port)
    //   - DNS failure
    // We classify "TypeError + Failed to fetch" as CORS by default
    // because that's >90% of the real-world case; the others would
    // typically have more specific messages.
    if (e instanceof TypeError || /Failed to fetch|NetworkError/i.test(msg)) {
      const isMixedContent =
        typeof window !== "undefined" &&
        window.location?.protocol === "https:" &&
        endpoint.url.startsWith("http://");
      if (isMixedContent) {
        return {
          ok: false,
          kind: "cors",
          detail:
            "browser blocked HTTP request from this HTTPS page (mixed content). " +
            "Either serve the app over HTTP for local dev, or front your node with TLS.",
        };
      }
      return {
        ok: false,
        kind: "cors",
        detail:
          "browser blocked the request — either CORS headers are missing on the node, " +
          "or the host is unreachable. See the panel above for a one-click caddy recipe.",
      };
    }
    if (/HTTP 401|HTTP 403|Unauthorized/i.test(msg)) {
      return {
        ok: false,
        kind: "auth",
        detail: "RPC auth failed — check rpcuser/rpcpassword in bitcoin.conf",
      };
    }
    if (/error:/i.test(msg)) {
      return { ok: false, kind: "rpc", detail: msg };
    }
    return { ok: false, kind: "unknown", detail: msg };
  }
}

/**
 * Raw block bytes by hash. `getblock <hash> 0` returns the consensus-
 * serialized block as a hex string; we decode to Uint8Array so the
 * downstream `parseRawBlock` (raw_block.js) sees the same shape it
 * would get from Esplora's `/block/:hash/raw`.
 *
 * Verbosity=0 keeps the response small (just hex bytes) — the
 * desktop version uses verbosity=3 to get prevout-resolved tx
 * objects, but the web indexer parses raw bytes locally so
 * verbosity=0 is enough and faster on the wire.
 */
export async function coreFetchBlockRaw(hash) {
  const hex = await _tryCoreRpc("getblock", [hash, 0]);
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error(`core-rpc getblock 0: bad hex ${typeof hex}/${hex && hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
