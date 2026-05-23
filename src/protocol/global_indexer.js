// Browser-local LUCKYPROTOCOL indexer adapter.
//
// In the desktop build, this module proxied HTTP requests to the
// luckyprotocol-indexer sidecar binary running at 127.0.0.1:8765
// (or to an external server URL the user pointed at). The web build
// has no server — instead we run a browser-local indexer
// (src/indexer-web/) that scans blocks directly from Esplora and
// keeps state in IndexedDB.
//
// This adapter keeps the EXACT shape the React layer
// (LuckyProtocolApp.jsx) imports — `pingGlobalIndexer`, `fetchGlobal*`,
// `isGlobalIndexerEnabled`, etc. — so the React code doesn't need a
// separate code path for web vs desktop. Each desktop HTTP call
// becomes a local Map lookup against the in-memory indexer state.
//
// Lifecycle:
//   - On first call to ANY of the fetch functions, we kick off the
//     browser indexer's boot() (idempotent / fire-and-forget).
//   - boot() loads the IDB snapshot, probes Esplora for tip, then
//     runs cold scan + steady-state poll in the background.
//   - All read APIs are synchronous against the in-memory state, but
//     wrapped in async signatures here so existing callers don't
//     need to change.
//
// Settings keys (kept for backwards-compat with desktop persisted state;
// none of them affect web behavior):
//   localStorage["luckyprotocol.global_indexer_url"]
//   localStorage["luckyprotocol.use_global_indexer"]
//   localStorage["luckyprotocol.indexer_mode"]

import {
  boot as bootBrowserIndexer,
  wipeAndRescan as wipeAndRescanBrowserIndexer,
  nudgePoll as nudgeBrowserIndexerPoll,
  indexerStatus,
  fetchBalances,
  fetchUtxoBalances,
  fetchBets,
  fetchTransfers,
  fetchTokensPaged,
  fetchTokenHolders as fetchTokenHoldersLocal,
} from "../indexer-web/index.js";

const LS_URL_KEY = "luckyprotocol.global_indexer_url";
const LS_USE_KEY = "luckyprotocol.use_global_indexer";
const LS_MODE_KEY = "luckyprotocol.indexer_mode";

// Vestigial constant — the desktop default sidecar URL. Kept for
// backwards-compat with any persisted user setting referencing it,
// but the URL is never actually fetched in the web build (every call
// site queries the local indexer state instead).
export const DEFAULT_GLOBAL_INDEXER_URL = "http://127.0.0.1:8765";

const lsGet = (k) => {
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const lsSet = (k, v) => {
  try { window.localStorage.setItem(k, v); } catch {}
};

export function getGlobalIndexerUrl() {
  return lsGet(LS_URL_KEY) || DEFAULT_GLOBAL_INDEXER_URL;
}
export function setGlobalIndexerUrl(url) {
  lsSet(LS_URL_KEY, url || DEFAULT_GLOBAL_INDEXER_URL);
}

// The web build's "indexer" is the in-browser one. It's always enabled
// (no opt-out — the wallet can't function without it). Returning true
// here makes _pollSyncOnce route through pingGlobalIndexer (which we've
// re-pointed at the local indexer's status envelope) instead of the
// Esplora-only tip path, giving the UI the PREPARING THE INDEXER
// overlay during cold scan + the diagnostics ring buffer afterwards.
export function isGlobalIndexerEnabled() {
  return true;
}
export function setGlobalIndexerEnabled(_on) {
  // no-op — see comment above
  lsSet(LS_USE_KEY, "1");
}

export function getIndexerMode() {
  const v = lsGet(LS_MODE_KEY);
  return v === "sidecar" ? "sidecar" : "external";
}
export function setIndexerMode(mode) {
  lsSet(LS_MODE_KEY, mode === "sidecar" ? "sidecar" : "external");
}

// ---- Sidecar lifecycle (no-op in web) -----------------------------------
// These existed for the desktop's Tauri sidecar (spawn the indexer
// binary, query its status). In the web build there's nothing to
// spawn — the indexer is the page itself. Return shapes that the
// SettingsScreen can safely consume without throwing.

export async function startSidecarIndexer(_network) {
  // The browser indexer is always running once boot() is called; we
  // return a synthetic "already running" status to satisfy any UI
  // path that calls this on Settings flip. boot() is idempotent.
  bootBrowserIndexer().catch(() => {});
  return { running: true, url: "browser:indexer" };
}
export async function stopSidecarIndexer() {
  // Web's indexer is module-singleton; we don't expose a "stop" to
  // the UI because the only safe way to shut it down is closing the
  // tab. Return success so the Settings toggle's optimistic update
  // doesn't snap back.
  return { running: false, url: "browser:indexer" };
}
export async function getSidecarStatus() {
  return { running: true, url: "browser:indexer" };
}

// ---- Boot guard --------------------------------------------------------
//
// First-call kickoff. Every fetch function below calls this; boot() is
// idempotent so concurrent / repeat calls are harmless. We deliberately
// DON'T await here — the caller's wait is bounded by their own polling
// cadence (30s in _pollSyncOnce), and blocking on full cold-scan would
// freeze the UI for minutes on first load.
let _bootKicked = false;
function _ensureBooted() {
  if (_bootKicked) return;
  _bootKicked = true;
  bootBrowserIndexer().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[indexer] boot failed:", e);
  });
}

/**
 * Hits "GET /" on the indexer — in the web build, returns the local
 * indexer's status envelope. Shape MUST match server.rs's HealthResponse
 * (the desktop sidecar's response) so the React layer's `_pollSyncOnce`
 * can consume it unchanged:
 *   { indexed_height, tip_height, token_count, last_progress_at,
 *     stalled, recent_errors }
 *
 * `baseUrl` and `signal` parameters are ignored in the web build —
 * kept in the signature so existing callsites compile.
 */
export async function pingGlobalIndexer(_baseUrl, _signal) {
  _ensureBooted();
  return indexerStatus();
}

/**
 * Per-address balance summary. Returns `{ balances: { TICKER: amount,
 * ... } }` — only the balances object (matches the desktop helper's
 * behavior of unwrapping the envelope before returning).
 */
export async function fetchGlobalBalances(address, _baseUrl, _signal) {
  _ensureBooted();
  return fetchBalances(address).balances;
}

/**
 * Per-UTXO balance breakdown for one address. Used by tx-web's
 * greedy minimum-UTXO coin selector. Returns the `utxos` array
 * directly. NEVER returns `null` in the web build — the local
 * indexer is always reachable; "no token UTXOs" is `[]`, which the
 * caller correctly treats as authoritative.
 */
export async function fetchGlobalUtxoBalances(address, _baseUrl, _signal) {
  _ensureBooted();
  return fetchUtxoBalances(address).utxos;
}

/** Bets log filtered to sender == address. */
export async function fetchGlobalBets(address, _baseUrl, _signal) {
  _ensureBooted();
  return fetchBets(address).bets;
}

/** Transfers log filtered to sender == address. */
export async function fetchGlobalTransfers(address, _baseUrl, _signal) {
  _ensureBooted();
  return fetchTransfers(address).transfers;
}

/**
 * Token registry — every LUCKYPROTOCOL DEPLOY the local indexer has seen.
 * Returns the items array. Use fetchGlobalTokensPaged for the full
 * envelope with `{ total, offset, limit, items }`.
 */
export async function fetchGlobalTokens(_baseUrl, _signal, opts = {}) {
  const page = await fetchGlobalTokensPaged(_baseUrl, _signal, opts);
  return page.items;
}

/**
 * Paginated token registry envelope `{ total, offset, limit, items }`.
 * Matches the desktop server's response so the INDEX screen's
 * pagination UI works unchanged.
 */
export async function fetchGlobalTokensPaged(_baseUrl, _signal, opts = {}) {
  _ensureBooted();
  return fetchTokensPaged(opts);
}

/**
 * Holder list for one ticker — all addresses with positive balance,
 * sorted by balance descending. Returns `{ ticker, total, limit,
 * offset, holders: [{ address, balance }, ...] }`.
 */
export async function fetchTokenHolders(ticker, _baseUrl, opts = {}) {
  _ensureBooted();
  return fetchTokenHoldersLocal(ticker, opts);
}

/**
 * Wake the browser indexer's poll loop immediately. Called from the
 * React sync poller (`_pollSyncOnce` in LuckyProtocolApp.jsx) when
 * its own `/blocks/tip/height` probe sees a new block — drops
 * observed indexer lag from ~half a poll cycle (5-10s) to one HTTP
 * round-trip. Matches the desktop indexer's external-nudge channel.
 *
 * No-op if the indexer hasn't booted yet or is already mid-iteration.
 * Safe to call as often as you like — multiple nudges before the
 * loop wakes collapse into a single wake.
 */
export function nudgeIndexerPoll() {
  try {
    nudgeBrowserIndexerPoll();
  } catch (_e) {
    // Indexer module not yet initialized (very early boot) — fine,
    // it'll catch up on its next scheduled tick.
  }
}

/**
 * SETTINGS → RESCAN INDEXER. Wipes the browser indexer's IndexedDB
 * snapshot and restarts the cold scan from activation height. Useful
 * when state corruption is suspected or a cohort bump just landed.
 *
 * Resolves once the new boot has finished its setup phase (snapshot
 * load + tip probe). The actual rescan continues in the background,
 * and the React layer's existing PREPARING THE INDEXER overlay will
 * take over for the progress display.
 */
export async function wipeAndRescanIndexer() {
  await wipeAndRescanBrowserIndexer();
}
