// Browser indexer — public read API.
//
// Mirrors the desktop indexer's HTTP endpoints (server.rs in
// luckyprotocol-indexer/) so the existing src/protocol/global_indexer.js
// shape can be re-implemented as local Map lookups instead of HTTP
// round-trips. Every function here corresponds to one endpoint:
//
//   GET /                            -> indexerStatus()
//   GET /balances/:address           -> fetchBalances(addr)
//   GET /utxos/:address              -> fetchUtxoBalances(addr)
//   GET /bets/:address               -> fetchBets(addr)
//   GET /transfers/:address          -> fetchTransfers(addr)
//   GET /tokens?limit&offset         -> fetchTokensPaged(opts)
//   GET /tokens/:ticker/holders      -> fetchTokenHolders(ticker, opts)
//
// The orchestrator (index.js) is what owns the singleton state; this
// module just translates queries against it. All return-shapes match
// the desktop HTTP responses byte-for-byte so the React layer
// (LuckyProtocolApp.jsx) doesn't need a separate web code path.

import {
  addressBalances,
  addressUtxoBalances,
  MAX_RECENT_ERRORS,
} from "./state.js";
import { getState, isReady } from "./index.js";

/**
 * GET / equivalent — full "indexer status" envelope. Used by
 * LuckyProtocolApp.jsx's _pollSyncOnce to gate the PREPARING THE INDEXER
 * overlay and surface "synced to block X of Y" stats.
 *
 * Adds two web-only fields beyond the desktop shape:
 *   - `scan_cursor` — the current cold-scan block, null during steady-state.
 *   - `ready` — whether the orchestrator has finished booting (snapshot
 *     load + first poll). Until `ready=true`, callers should treat
 *     balance lookups as "not yet authoritative".
 */
export function indexerStatus() {
  if (!isReady()) {
    return {
      ready: false,
      network: "bitcoin",
      tip_height: 0,
      indexed_height: 0,
      activation_height: 0,
      scan_cursor: null,
      token_count: 0,
      last_progress_at: 0,
      stalled: false,
      recent_errors: [],
    };
  }
  const s = getState();
  const now = Math.floor(Date.now() / 1000);
  // Match the desktop's 120s threshold from indexer.rs::STALL_THRESHOLD_SECS.
  // The orchestrator's poll cadence is 30s, so any gap >120s is 4+ missed
  // polls — well past transient-failure noise.
  const stalled = s.indexedHeight < s.tipHeight && now - s.lastProgressAt > 120;
  return {
    ready: true,
    network: s.network,
    tip_height: s.tipHeight,
    indexed_height: s.indexedHeight,
    activation_height: s.activationHeight,
    scan_cursor: s.scanCursor,
    // React's SYNC tile shows total deployed-token count in the
    // sidebar status row. Matches desktop's /-endpoint response.
    token_count: s.tokens.size,
    last_progress_at: s.lastProgressAt,
    stalled,
    // Ring buffer (FIFO, capped at MAX_RECENT_ERRORS) for diagnostics UI.
    recent_errors: s.recentErrors.slice(-MAX_RECENT_ERRORS),
  };
}

/**
 * GET /balances/:address equivalent.
 * Returns `{ address, balances: { TICKER: smallest_units, ... },
 * bet_count, transfer_count }`.
 *
 * `balances` values are Numbers (not bigints) to match the desktop
 * indexer's JSON shape. Safe because every value is bounded by
 * REQUIRED_TOKEN_SUPPLY = 21_000_000 which fits in Number trivially.
 */
export function fetchBalances(address) {
  if (!isReady()) {
    return { address, balances: {}, bet_count: 0, transfer_count: 0 };
  }
  const s = getState();
  const balsBig = addressBalances(s, address);
  const balances = {};
  for (const [t, amt] of Object.entries(balsBig)) {
    balances[t] = Number(amt);
  }
  // Counts: bets where sender == address, transfers where sender OR
  // recipient address == address. We don't precompute these — at
  // 100k cap on each log they iterate fast (< 5ms even on cold cache).
  let betCount = 0;
  for (const b of s.bets) if (b.sender === address) betCount++;
  let transferCount = 0;
  for (const t of s.transfers) {
    if (t.sender === address) transferCount++;
    // Recipient-side count would need vout-address resolution at
    // apply time; the desktop API only tracks the sender-side count
    // here so we match that.
  }
  return { address, balances, bet_count: betCount, transfer_count: transferCount };
}

/**
 * GET /utxos/:address equivalent. Per-UTXO breakdown used by tx-web's
 * greedy minimum-UTXO coin selector.
 * Returns `{ address, utxos: [{ txid, vout, balances: { TICKER: amount } }, ...] }`.
 * Only UTXOs with at least one non-zero ticker balance are returned.
 */
export function fetchUtxoBalances(address) {
  if (!isReady()) return { address, utxos: [] };
  const s = getState();
  return { address, utxos: addressUtxoBalances(s, address) };
}

/**
 * GET /bets/:address equivalent. Filters the global bets log to ones
 * sent FROM `address`. Returns `{ address, bets: [BetView, ...] }`.
 * Order matches the desktop indexer: chronological by block_height.
 */
export function fetchBets(address) {
  if (!isReady()) return { address, bets: [] };
  const s = getState();
  const bets = s.bets.filter((b) => b.sender === address);
  return { address, bets };
}

/**
 * Authoritative ON-CHAIN view of which tickers are deployed.
 *
 * Returns a Map<ticker, { supply, minted, deployBlock, deployer }>
 * built directly from the indexer's s.tokens registry (populated by
 * applyTx as it walks every DEPLOY/MINE/SEND in chain history).
 *
 * Why this exists separately from fetchTokensPaged: the LEDGER +
 * win-credit code paths only need a quick "is this ticker on the
 * chain, and what's its supply/minted cap?" lookup. They don't
 * want pagination, sorting, or the holders-count walk (which is
 * O(|utxoBalances|) per call).
 *
 * Returns an empty Map when the indexer isn't ready yet — callers
 * should fall back to the local deployedTokens cache in that case
 * (e.g. during the boot window before fast-bootstrap completes).
 *
 * Use this anywhere you'd otherwise check `state.deployedTokens`:
 *   - LEDGER's `activeTickers` predicate (was reading local cache,
 *     marked perfectly-valid MINEs as "INVALID" when the local
 *     status didn't say "active" — fixed in TransactionsScreen).
 *   - syntheticTx outcome loop's `knownTickers` set (was reading
 *     local cache, refused to credit valid WINs when the local
 *     registry hadn't synced the DEPLOY's status yet — fixed in
 *     App.jsx's _refreshOnChainBets loop).
 *
 * The desktop indexer's HTTP equivalent would be a hypothetical
 * `GET /tokens/registry` — not currently exposed because the only
 * caller (web build) uses this in-process Map directly.
 */
export function fetchIndexedTokenRegistry() {
  if (!isReady()) return new Map();
  const s = getState();
  const out = new Map();
  for (const [ticker, reg] of s.tokens) {
    out.set(ticker, {
      supply: Number(reg.supply),
      minted: Number(reg.minted),
      deployBlock: reg.deploy_block,
      deployer: reg.deployer,
    });
  }
  return out;
}

/**
 * GET /transfers/:address equivalent. Currently sender-only filter
 * (matches desktop). A future enhancement could include recipient-
 * side transfers by resolving to_out_idx → vout_address at apply time
 * and indexing into a recipient-side map, but the UI today only
 * surfaces "transfers I sent" for this filter.
 */
export function fetchTransfers(address) {
  if (!isReady()) return { address, transfers: [] };
  const s = getState();
  const transfers = s.transfers.filter((t) => t.sender === address);
  return { address, transfers };
}

/**
 * GET /tokens?limit&offset equivalent. Returns `{ total, offset, limit,
 * items: [TokenRegistryEntry, ...] }`. Sorted by deploy_block ASC then
 * deploy_txid ASC (deterministic — matches desktop).
 *
 * Per-entry shape:
 *   { ticker, supply: number, minted: number, holders: number,
 *     deployer, deploy_txid, deploy_block }
 *
 * `holders` is computed live by walking utxoBalances once and counting
 * distinct addresses per ticker that hold a non-zero balance. The
 * walk is O(|utxoBalances|), but utxoBalances is small (one entry per
 * token-bearing UTXO across the whole chain — typically <10k even at
 * heavy protocol use). LuckyProtocolApp's TOKEN INDEX screen polls
 * this on every refresh, so we don't memoize — the cost is
 * negligible and a stale memo would be more annoying than recomputing.
 *
 * Pre-fix this entry shape omitted `holders` entirely, which made the
 * UI's `holdersFor(t)` helper always fall through to "—" or "1" (the
 * local-wallet floor), never showing the real network-wide count.
 */
export function fetchTokensPaged({ limit, offset } = {}) {
  if (!isReady()) return { total: 0, offset: 0, limit: 0, items: [] };
  const s = getState();
  // ticker -> Set<address> with non-zero balance. One pass.
  const holdersByTicker = new Map();
  for (const [, entry] of s.utxoBalances) {
    if (!entry.address) continue;
    for (const [ticker, amt] of entry.balances) {
      if (amt === 0n) continue;
      let set = holdersByTicker.get(ticker);
      if (!set) { set = new Set(); holdersByTicker.set(ticker, set); }
      set.add(entry.address);
    }
  }
  const all = Array.from(s.tokens.values()).map((reg) => ({
    ticker: reg.ticker,
    supply: Number(reg.supply),
    minted: Number(reg.minted),
    holders: holdersByTicker.get(reg.ticker)?.size ?? 0,
    deployer: reg.deployer,
    deploy_txid: reg.deploy_txid,
    deploy_block: reg.deploy_block,
  }));
  all.sort((a, b) => {
    if (a.deploy_block !== b.deploy_block) {
      return a.deploy_block - b.deploy_block;
    }
    return a.deploy_txid.localeCompare(b.deploy_txid);
  });
  const total = all.length;
  const off = Math.max(0, offset || 0);
  // 500 = desktop's TOKENS_MAX_LIMIT, matches global_indexer.js comment.
  const lim = Math.min(500, Math.max(0, limit ?? 100));
  const items = all.slice(off, off + lim);
  return { total, offset: off, limit: lim, items };
}

/**
 * GET /tokens/:ticker/holders equivalent. Returns `{ ticker, total,
 * limit, offset, holders: [{ address, balance }, ...] }` sorted by
 * balance DESC. `balance` is a Number; total is the un-paginated
 * holder count.
 *
 * Computed on-the-fly: walks the entire utxoBalances map filtering for
 * `balances[ticker] > 0` and aggregates by address. O(|utxoBalances|),
 * which is fine for the rare-but-noticeable HOLDERS modal click — we
 * don't precompute holder lists because the per-ticker holder set
 * mutates on every SEND.
 */
export function fetchTokenHolders(ticker, { limit, offset } = {}) {
  if (!isReady()) {
    return { ticker, total: 0, limit: 0, offset: 0, holders: [] };
  }
  const s = getState();
  // address -> bigint sum of `ticker` balance across that address's UTXOs.
  const byAddr = new Map();
  for (const [, entry] of s.utxoBalances) {
    const amt = entry.balances.get(ticker);
    if (!amt || amt === 0n) continue;
    if (!entry.address) continue;
    byAddr.set(entry.address, (byAddr.get(entry.address) || 0n) + amt);
  }
  const all = [];
  for (const [address, amt] of byAddr) {
    all.push({ address, balance: Number(amt) });
  }
  all.sort((a, b) => b.balance - a.balance);
  const total = all.length;
  const off = Math.max(0, offset || 0);
  const lim = Math.min(500, Math.max(0, limit ?? 100));
  const holders = all.slice(off, off + lim);
  return { ticker, total, limit: lim, offset: off, holders };
}
