// LUCKYPROTOCOL indexer adapter — HTTP only.
//
// Every chain-derived read in the web build goes through the official
// LUCKYPROTOCOL indexer at https://luckyprotocolai.com (or whatever
// `getGlobalIndexerUrl()` resolves to — advanced operators running
// their own mirror can override it via SETTINGS, but the default
// always points at the team-operated server).
//
// There is NO third-party fallback in this binary. If the indexer is
// unreachable, every read throws — the React layer surfaces that as
// the "Indexer down" state in the STATUS tile, but does NOT silently
// route to mempool.space or anywhere else. Mempool.space stays as the
// chain endpoint for exactly two things: pulling recommended fee
// rates and broadcasting freshly-signed transactions. Both live in
// `chain.js`, not here.
//
// Endpoints proxied here (one helper per indexer route):
//
//   GET /                              -> pingGlobalIndexer
//   GET /balances/:addr                -> fetchGlobalBalances
//   GET /utxos/:addr                   -> fetchGlobalUtxoBalances    (token UTXOs)
//   GET /btc-utxos/:addr               -> fetchGlobalBtcUtxos        (raw BTC UTXOs)
//   GET /bets/:addr                    -> fetchGlobalBets
//   GET /transfers/:addr               -> fetchGlobalTransfers
//   GET /tokens?...                    -> fetchGlobalTokensPaged
//   GET /tokens/:ticker/holders?...    -> fetchTokenHolders
//   GET /tx-status/:txid               -> fetchGlobalTxStatus
//   GET /block-height/:h               -> fetchGlobalBlockHash
//   GET /block-info/:h                 -> fetchGlobalBlockInfo
//   POST /poll-now                     -> nudgeIndexerPoll
//
// SETTINGS key (advanced):
//   localStorage["luckyprotocol.global_indexer_url"] — override default
//                                                     base URL.

const LS_URL_KEY = "luckyprotocol.global_indexer_url";

/**
 * Default HTTP base for the public LUCKYPROTOCOL indexer. End users
 * never need to change this — it points at the team-operated server.
 * Advanced operators running their own mirror can override via
 * `setGlobalIndexerUrl(...)` (writes the LS key above).
 */
export const DEFAULT_GLOBAL_INDEXER_URL = "https://luckyprotocolai.com";

const lsGet = (k) => {
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const lsSet = (k, v) => {
  try { window.localStorage.setItem(k, v); } catch { /* private mode */ }
};

export function getGlobalIndexerUrl() {
  const v = lsGet(LS_URL_KEY);
  return (v && v.trim()) || DEFAULT_GLOBAL_INDEXER_URL;
}
export function setGlobalIndexerUrl(url) {
  lsSet(LS_URL_KEY, url || DEFAULT_GLOBAL_INDEXER_URL);
}

/**
 * Always true in the web build — the wallet can't function without an
 * indexer, and the indexer is always reachable in principle (just an
 * HTTPS GET). Kept for backwards-compat with legacy call sites that
 * branched on this.
 */
export function isGlobalIndexerEnabled() {
  return true;
}
export function setGlobalIndexerEnabled(_on) {
  /* no-op — kept so legacy callsites don't crash */
}

// ---- HTTP transport -----------------------------------------------------

const _httpGet = async (path, signal) => {
  const base = getGlobalIndexerUrl().replace(/\/+$/, "");
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    // Network failure (DNS / offline / CORS preflight) — wrap with a
    // clearer message so React's error surface can show "indexer
    // unreachable" instead of the generic TypeError.
    throw new Error(`Indexer unreachable: ${url} — ${e.message || e}`);
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`Indexer ${path} -> HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return await res.json();
};

const _httpPost = async (path, body, signal) => {
  const base = getGlobalIndexerUrl().replace(/\/+$/, "");
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? "" : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Indexer POST ${path} -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return await res.json();
};

// ---- Legacy sidecar-lifecycle stubs --------------------------------------
// These existed for the desktop Tauri sidecar that owned the indexer
// process. The web build has no spawnable process — kept as no-ops
// so legacy SETTINGS code still compiles.

export async function startSidecarIndexer(_network) {
  return { running: true, url: getGlobalIndexerUrl() };
}
export async function stopSidecarIndexer() {
  return { running: false, url: getGlobalIndexerUrl() };
}
export async function getSidecarStatus() {
  return { running: true, url: getGlobalIndexerUrl() };
}

// ---- Read API — one wrapper per indexer route ----------------------------

/**
 * GET /. Health + tip envelope:
 *   { network, core_url, indexed_height, tip_height, address_count,
 *     utxo_count, bet_count, transfer_count, deploy_count, token_count,
 *     last_progress_at, stalled, recent_errors }
 */
export async function pingGlobalIndexer(_baseUrl, signal) {
  return _httpGet("/", signal);
}

/** GET /balances/:addr — returns the `{ TICKER: amount, ... }` map only. */
export async function fetchGlobalBalances(address, _baseUrl, signal) {
  const env = await _httpGet(`/balances/${encodeURIComponent(address)}`, signal);
  return (env && env.balances) || {};
}

/**
 * GET /utxos/:addr — token-UTXO breakdown for one address. Used by
 * tx-web's greedy minimum-UTXO coin selector for protocol token sends.
 */
export async function fetchGlobalUtxoBalances(address, _baseUrl, signal) {
  const env = await _httpGet(`/utxos/${encodeURIComponent(address)}`, signal);
  return (env && env.utxos) || [];
}

/**
 * GET /btc-utxos/:addr — raw Bitcoin UTXOs for one address. Used by
 * the wallet for balance display + fee funding (selecting BTC inputs
 * to pay protocol fees + miner fees). NOT served by the desktop's
 * Esplora — this is a LUCKYPROTOCOL-indexer-specific extension that
 * proxies bitcoind's `scantxoutset` under the hood.
 *
 * Returns: [{ txid, vout, sats, confirmed, block_height }]
 *   * `sats` is integer satoshis (not BTC).
 *   * `confirmed` is true iff the UTXO is in a block (not mempool).
 *   * `block_height` is the block the UTXO landed in (null when
 *     unconfirmed).
 *
 * Empty array (not null) means "no BTC at this address" — caller
 * should treat that as authoritative.
 */
export async function fetchGlobalBtcUtxos(address, _baseUrl, signal) {
  const env = await _httpGet(`/btc-utxos/${encodeURIComponent(address)}`, signal);
  return (env && env.utxos) || [];
}

/** GET /bets/:addr — bets log filtered to sender == address. */
export async function fetchGlobalBets(address, _baseUrl, signal) {
  const env = await _httpGet(`/bets/${encodeURIComponent(address)}`, signal);
  return (env && env.bets) || [];
}

/** GET /transfers/:addr — transfers log filtered to sender == address. */
export async function fetchGlobalTransfers(address, _baseUrl, signal) {
  const env = await _httpGet(`/transfers/${encodeURIComponent(address)}`, signal);
  return (env && env.transfers) || [];
}

/** Convenience: token registry items only (drops the paging envelope). */
export async function fetchGlobalTokens(_baseUrl, signal, opts = {}) {
  const page = await fetchGlobalTokensPaged(_baseUrl, signal, opts);
  return page.items || [];
}

/**
 * GET /tokens?limit=N&offset=N — paginated registry envelope
 *   { total, offset, limit, items: [...] }.
 */
export async function fetchGlobalTokensPaged(_baseUrl, signal, opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit != null)  params.set("limit",  String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const q = params.toString() ? `?${params.toString()}` : "";
  return await _httpGet(`/tokens${q}`, signal);
}

/**
 * GET /tokens/:ticker/holders?... — paginated holders for one ticker:
 *   { ticker, total, limit, offset, holders: [{ address, balance }, ...] }
 */
export async function fetchTokenHolders(ticker, _baseUrl, opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit != null)  params.set("limit",  String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const q = params.toString() ? `?${params.toString()}` : "";
  return await _httpGet(`/tokens/${encodeURIComponent(ticker)}/holders${q}`);
}

/**
 * GET /tx-status/:txid — confirmation state for one tx. Used after
 * broadcasting a protocol tx to poll until it lands in a block.
 * Returns:
 *   { txid, confirmed: bool, block_height: number|null,
 *     block_hash: string|null, block_time: number|null }
 * A 404 from the indexer means "tx not yet seen" — callers should
 * treat that as `confirmed: false` rather than a hard error. We catch
 * it here and synthesize the unconfirmed view.
 */
export async function fetchGlobalTxStatus(txid, signal) {
  try {
    return await _httpGet(`/tx-status/${encodeURIComponent(txid)}`, signal);
  } catch (e) {
    if (/HTTP 404/.test(String(e?.message))) {
      return {
        txid,
        confirmed: false,
        block_height: null,
        block_hash: null,
        block_time: null,
      };
    }
    throw e;
  }
}

/**
 * GET /block-height/:height — returns the block hash at `height`, or
 * `null` if `height` is past the current tip (block not yet mined).
 * Used by V2 BET settlement (waiting for the determining block).
 */
export async function fetchGlobalBlockHash(height, signal) {
  try {
    const env = await _httpGet(`/block-height/${height}`, signal);
    return env?.hash || env?.block_hash || null;
  } catch (e) {
    if (/HTTP 404/.test(String(e?.message))) return null;
    throw e;
  }
}

/**
 * GET /block-info/:height — returns `{ hash, time }` for the block at
 * `height`. `time` is seconds-since-epoch (block header timestamp).
 * Returns `null` if `height` is past the current tip.
 */
export async function fetchGlobalBlockInfo(height, signal) {
  try {
    const env = await _httpGet(`/block-info/${height}`, signal);
    if (!env) return null;
    return {
      hash: env.hash || env.block_hash,
      time: env.time ?? env.timestamp ?? null,
    };
  } catch (e) {
    if (/HTTP 404/.test(String(e?.message))) return null;
    throw e;
  }
}

/**
 * POST /poll-now — wake the indexer's poll loop immediately. Fire-and-
 * forget. Errors are swallowed (server may not support the route,
 * may be temporarily down — either way the next scheduled poll picks
 * up the work).
 */
export function nudgeIndexerPoll() {
  _httpPost("/poll-now", null).catch(() => { /* fire and forget */ });
}

/**
 * SETTINGS → RESCAN INDEXER. In the official-only architecture the
 * client doesn't control server-side scan state, so this is a no-op
 * + dev-warn. Left in place because the SETTINGS button still calls
 * it; we may wire it to a future `DELETE /snapshot` admin endpoint
 * but right now there's no remote control.
 */
export async function wipeAndRescanIndexer() {
  // eslint-disable-next-line no-console
  console.warn(
    "[indexer] wipeAndRescan: no-op — the official indexer at " +
    `${getGlobalIndexerUrl()} controls its own snapshot lifecycle. ` +
    "If state looks wrong, report it to the team."
  );
}
