// LUCKYPROTOCOL indexer adapter — dispatcher between two backends:
//
//   Default mode (`http`):  hit the official LUCKYPROTOCOL indexer over
//   HTTPS — https://luckyprotocolai.com. Every read API is a direct
//   fetch(). Failures are HARD ERRORS (no silent fallback) — the user
//   either trusts the team's indexer or switches to browser mode.
//
//   Advanced mode (`browser`): the in-browser indexer at
//   src/indexer-web/ scans blocks directly from a public Esplora and
//   keeps derived state in IndexedDB. Zero-trust at the cost of
//   ~80 KB extra JS + a long cold-scan on first run. Activated by
//   flipping SETTINGS → "Self-verify in browser (advanced)" which
//   writes `luckyprotocol.indexer_mode = "browser"`.
//
// The React layer (LuckyProtocolApp.jsx) imports the same set of
// functions in either mode, so no caller needs an `if (mode === ...)`
// branch.
//
// SETTINGS keys:
//   localStorage["luckyprotocol.indexer_mode"]     — "http" | "browser"
//   localStorage["luckyprotocol.global_indexer_url"] — override default
//                                                     HTTP base (advanced
//                                                     users running their
//                                                     own mirror)

// ---- Setting plumbing ---------------------------------------------------

const LS_URL_KEY  = "luckyprotocol.global_indexer_url";
const LS_MODE_KEY = "luckyprotocol.indexer_mode";
// Legacy key kept for backwards-compat read; new SETTINGS UI no longer
// surfaces it (the toggle is on/off rather than a free-form URL).
const LS_USE_KEY  = "luckyprotocol.use_global_indexer";

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
 * Active dispatcher mode. Returns "http" (default — talks to
 * `getGlobalIndexerUrl()`) or "browser" (uses the in-browser
 * indexer in src/indexer-web/).
 */
export function getIndexerMode() {
  const v = lsGet(LS_MODE_KEY);
  return v === "browser" ? "browser" : "http";
}
export function setIndexerMode(mode) {
  lsSet(LS_MODE_KEY, mode === "browser" ? "browser" : "http");
}

/**
 * Backwards-compat — the React layer historically conditioned UI on
 * this flag. With the web build there's always an indexer available
 * (HTTP or browser), so we hard-return true.
 */
export function isGlobalIndexerEnabled() {
  return true;
}
export function setGlobalIndexerEnabled(_on) {
  // Persist the legacy key just in case some other code-path reads it.
  lsSet(LS_USE_KEY, "1");
}

// ---- HTTP transport (default mode) --------------------------------------

const _httpGet = async (path, signal) => {
  const base = getGlobalIndexerUrl().replace(/\/+$/, "");
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    // Network failure (DNS, CORS preflight rejection, TLS, offline) —
    // wrap with a clearer error so the React error surface can show
    // "indexer unreachable" rather than the generic TypeError.
    throw new Error(`Indexer unreachable: ${url} — ${e.message || e}`);
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`Indexer ${path} → HTTP ${res.status}${body ? `: ${body}` : ""}`);
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
  if (!res.ok) {
    throw new Error(`Indexer POST ${path} → HTTP ${res.status}`);
  }
  // The indexer's POST endpoints may legitimately return empty 204.
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return await res.json();
};

// ---- Browser indexer (lazy import) --------------------------------------
//
// The browser indexer (`src/indexer-web/`) is ~80 KB of JS plus all its
// chain-fetch helpers. We `await import()` it ONLY when the user has
// flipped SETTINGS into browser mode — default users on HTTP mode
// never pay that bundle cost.

let _browserMod = null;
let _browserBootKicked = false;

async function _loadBrowserMod() {
  if (_browserMod) return _browserMod;
  _browserMod = await import("../indexer-web/index.js");
  return _browserMod;
}

async function _ensureBrowserBooted() {
  const mod = await _loadBrowserMod();
  if (_browserBootKicked) return mod;
  _browserBootKicked = true;
  // boot() is idempotent + fire-and-forget — runs the cold scan in
  // the background, the React layer polls indexerStatus() for progress.
  mod.boot().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[browser indexer] boot failed:", e);
  });
  return mod;
}

// ---- Sidecar lifecycle stubs (legacy no-ops in web build) ---------------
//
// Pre-web (Tauri) builds had a separate sidecar process the React
// layer could start/stop. None of that applies to the web build — kept
// as no-ops so existing Settings UI hooks still resolve.

export async function startSidecarIndexer(_network) {
  if (getIndexerMode() === "browser") {
    await _ensureBrowserBooted();
  }
  return { running: true, url: getGlobalIndexerUrl() };
}
export async function stopSidecarIndexer() {
  return { running: false, url: getGlobalIndexerUrl() };
}
export async function getSidecarStatus() {
  return { running: true, url: getGlobalIndexerUrl() };
}

// ---- Public read API — dispatches by mode --------------------------------
//
// The signature for each `fetchGlobal*` keeps the legacy
// `(arg, baseUrl, signal)` shape so the React callsites compile
// unchanged from the Tauri-era code. `baseUrl` is ignored in BOTH
// modes (HTTP mode reads from `getGlobalIndexerUrl()`, browser mode
// reads its in-memory state).

/**
 * `GET /` — health envelope. Shape MUST match server.rs's HealthResponse
 * so the React poller in `_pollSyncOnce` can consume it unchanged:
 *   { network, core_url, indexed_height, tip_height, address_count,
 *     utxo_count, bet_count, transfer_count, deploy_count, token_count,
 *     last_progress_at, stalled, recent_errors }
 */
export async function pingGlobalIndexer(_baseUrl, signal) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.indexerStatus();
  }
  return _httpGet("/", signal);
}

/**
 * Per-address balance summary. Returns `{ TICKER: amount, ... }` — the
 * inner balances object (unwrapped from the indexer's `{ balances: {} }`
 * envelope, matching the legacy desktop adapter's behavior).
 */
export async function fetchGlobalBalances(address, _baseUrl, signal) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchBalances(address).balances;
  }
  const env = await _httpGet(`/balances/${encodeURIComponent(address)}`, signal);
  return (env && env.balances) || {};
}

/**
 * Per-UTXO balance breakdown for one address. Returns the `utxos`
 * array directly. Used by tx-web's greedy minimum-UTXO coin selector.
 * Empty array (not null) means "no token UTXOs" — the caller should
 * treat that as authoritative, NOT as an error.
 */
export async function fetchGlobalUtxoBalances(address, _baseUrl, signal) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchUtxoBalances(address).utxos;
  }
  const env = await _httpGet(`/utxos/${encodeURIComponent(address)}`, signal);
  return (env && env.utxos) || [];
}

/** Bets log filtered to sender == address. */
export async function fetchGlobalBets(address, _baseUrl, signal) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchBets(address).bets;
  }
  const env = await _httpGet(`/bets/${encodeURIComponent(address)}`, signal);
  return (env && env.bets) || [];
}

/** Transfers log filtered to sender == address. */
export async function fetchGlobalTransfers(address, _baseUrl, signal) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchTransfers(address).transfers;
  }
  const env = await _httpGet(`/transfers/${encodeURIComponent(address)}`, signal);
  return (env && env.transfers) || [];
}

/**
 * Token registry items array (every DEPLOY the indexer has seen). For
 * the paginated envelope `{ total, offset, limit, items }`, use
 * `fetchGlobalTokensPaged` directly.
 */
export async function fetchGlobalTokens(_baseUrl, signal, opts = {}) {
  const page = await fetchGlobalTokensPaged(_baseUrl, signal, opts);
  return page.items || [];
}

/**
 * Paginated token registry envelope `{ total, offset, limit, items }`.
 * Matches the indexer's response shape so the INDEX screen's pagination
 * UI works unchanged.
 */
export async function fetchGlobalTokensPaged(_baseUrl, signal, opts = {}) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchTokensPaged(opts);
  }
  const params = new URLSearchParams();
  if (opts.limit != null)  params.set("limit",  String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const q = params.toString() ? `?${params.toString()}` : "";
  return await _httpGet(`/tokens${q}`, signal);
}

/**
 * Holder list for one ticker — all addresses with positive balance,
 * sorted by balance descending. Returns
 *   { ticker, total, limit, offset, holders: [{ address, balance }, ...] }
 */
export async function fetchTokenHolders(ticker, _baseUrl, opts = {}) {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    return mod.fetchTokenHolders(ticker, opts);
  }
  const params = new URLSearchParams();
  if (opts.limit != null)  params.set("limit",  String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const q = params.toString() ? `?${params.toString()}` : "";
  return await _httpGet(`/tokens/${encodeURIComponent(ticker)}/holders${q}`);
}

/**
 * Wake the indexer's poll loop immediately. Used by the React sync
 * poller right after it observes a tip advance via its own
 * `/blocks/tip/height` probe — drops indexer-side lag from ~half a
 * poll cycle (~5s) to one HTTP round-trip.
 *
 * Browser mode: nudges the local poll loop directly.
 * HTTP mode: best-effort `POST /poll-now` to the remote indexer.
 * Both paths swallow errors — a missed nudge just means waiting one
 * more poll cycle for the new block to land.
 */
export function nudgeIndexerPoll() {
  if (getIndexerMode() === "browser") {
    _loadBrowserMod()
      .then((mod) => { if (mod.nudgePoll) mod.nudgePoll(); })
      .catch(() => { /* not booted yet — fine */ });
    return;
  }
  // HTTP mode — fire and forget.
  _httpPost("/poll-now", null).catch(() => {
    // Server might not support /poll-now (older indexer) or might be
    // down. Either way, the next scheduled poll picks up the work.
  });
}

/**
 * SETTINGS → RESCAN INDEXER.
 * Browser mode: wipes the IndexedDB snapshot and restarts cold scan.
 * HTTP mode: no-op — the server controls its own snapshot lifecycle;
 * client can't trigger a remote rescan. Logged as a warning so devs
 * notice if this gets wired up to a button in HTTP mode.
 */
export async function wipeAndRescanIndexer() {
  if (getIndexerMode() === "browser") {
    const mod = await _ensureBrowserBooted();
    await mod.wipeAndRescan();
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[indexer] wipeAndRescan is a no-op in HTTP mode — server controls scan state. " +
    "Switch SETTINGS → Self-verify (advanced) to enable client-side scan reset."
  );
}
