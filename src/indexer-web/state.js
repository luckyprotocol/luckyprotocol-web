// In-memory LUCKYPROTOCOL indexer state — UTXO-bound v1 (browser port).
//
// Mirrors the Rust indexer's `IndexerState` struct in
// luckyprotocol-indexer/src/indexer.rs. The shape MUST stay close
// to its parent so the same audit-log + balance queries the desktop's
// HTTP indexer answers can be answered locally without translation
// in api.js.
//
// Data layout (all in-memory; storage.js handles IDB persistence):
//
//   utxoBalances: Map<"txid:vout", { address, balances: Map<ticker, bigint> }>
//     Per-UTXO token balances. A UTXO not present here carries no
//     protocol tokens.
//
//   addressUtxos: Map<address, Set<"txid:vout">>
//     Reverse index so /balances/:address can answer in O(|addr's UTXOs|)
//     instead of scanning utxoBalances.
//
//   tokens: Map<ticker, { ticker, supply: bigint, minted: bigint,
//                         deployer, deployTxid, deployBlock }>
//     The deployed-token registry. Append-only modulo reorg restore.
//
//   bets / transfers / deploys: Array<{...}>
//     Audit logs. FIFO-capped (MAX_*_VEC) to bound memory. We use
//     plain arrays + the running *Offset so logical indices stay
//     stable across evictions (matching Rust's VecDeque + offset
//     semantics). pushBet / pushTransfer / pushDeploy do the cap +
//     offset bookkeeping.
//
//   byTxid: Map<txid, { kind: "bet"|"transfer"|"deploy", idx: bigint }>
//     Idempotency guard — a single tx contributes one audit-log
//     entry total (no duplicate processing in the same scan, no
//     double-record on re-apply after restore).
//
//   blockHashes: Map<height, hash>
//     Per-height block hash, for reorg detection.
//
//   indexedHeight: number — highest block fully applied.
//   tipHeight:     number — most-recently-observed chain tip (for stalled flag).
//
// Why bigint balances: token amounts are u64 in Rust; JS's Number tops
// out at 2^53. REQUIRED_TOKEN_SUPPLY is 21_000_000n which fits in Number
// fine, but the indexer must NEVER truncate — a future ticker with
// inflated supply or a sum-of-bets summing past 2^53 would silently
// corrupt the registry. Use bigint everywhere balances appear.

import { LCKPROTOCOL_V1_HEIGHT } from "./protocol.js";

// FIFO eviction caps — keep memory bounded under high traffic.
// Mirrors the Rust indexer's MAX_*_VEC. Logical indices stay stable
// across evictions via the *Offset counters.
export const MAX_BETS_VEC = 100_000;
export const MAX_TRANSFERS_VEC = 100_000;
export const MAX_DEPLOYS_VEC = 10_000;

// How often (in blocks) to snapshot to IndexedDB. Storage write
// frequency vs. restore-loss tradeoff. 12 matches the desktop
// indexer's SNAPSHOT_INTERVAL_BLOCKS so a snapshot-format swap is
// straightforward later if we want shared snapshots.
export const SNAPSHOT_INTERVAL_BLOCKS = 12;

/**
 * Canonical "txid:vout" key. Used as the primary key into
 * utxoBalances and as the membership token in addressUtxos.
 * Lowercase txid + decimal vout, no leading zeros — must match
 * Rust's `outpoint_key` exactly.
 */
export function outpointKey(txid, vout) {
  return `${String(txid).toLowerCase()}:${vout}`;
}

/**
 * Fresh empty indexer state. Always starts at activation height − 1
 * so the first block we apply is LCKPROTOCOL_V1_HEIGHT itself (the
 * scanner's loop is `for h = indexedHeight + 1 .. tip`).
 */
export function newState(network = "bitcoin") {
  return {
    network,
    activationHeight: LCKPROTOCOL_V1_HEIGHT,
    indexedHeight: LCKPROTOCOL_V1_HEIGHT - 1,
    tipHeight: 0,
    utxoBalances: new Map(),
    addressUtxos: new Map(),
    tokens: new Map(),
    bets: [],
    transfers: [],
    deploys: [],
    betOffset: 0n,
    transferOffset: 0n,
    deployOffset: 0n,
    byTxid: new Map(),
    blockHashes: new Map(),
    lastProgressAt: Math.floor(Date.now() / 1000),
    // The cold-scan window's "currently scanning block X" hint surfaced
    // to the UI. Reset to null once steady-state polling begins.
    scanCursor: null,
    // Most-recent diagnostic event surfaced to the SETTINGS panel.
    // Ring-buffered at length 16 to mirror the desktop's MAX_RECENT_ERRORS.
    recentErrors: [],
  };
}

// ---- Reverse-index helpers ----------------------------------------------

/**
 * Register that `address` controls UTXO `key`. Idempotent (Set semantics).
 * No-op if `address` is null/undefined — non-standard scripts that don't
 * parse to a single address have no reverse-index entry.
 */
export function trackAddressUtxo(state, address, key) {
  if (!address) return;
  let set = state.addressUtxos.get(address);
  if (!set) {
    set = new Set();
    state.addressUtxos.set(address, set);
  }
  set.add(key);
}

/**
 * Remove `key` from `address`'s set. Drops the address entry entirely
 * when the set goes empty so the map doesn't grow unboundedly with
 * one-shot single-use addresses.
 */
export function untrackAddressUtxo(state, address, key) {
  if (!address) return;
  const set = state.addressUtxos.get(address);
  if (!set) return;
  set.delete(key);
  if (set.size === 0) state.addressUtxos.delete(address);
}

// ---- FIFO push helpers — cap + offset bookkeeping ------------------------
// Every audit-log addition MUST go through one of these so the cap +
// byTxid coupling stays invariant. Returns the LOGICAL index of the
// new entry (offset-relative — stable across future evictions).

export function pushBet(state, bet) {
  while (state.bets.length >= MAX_BETS_VEC) {
    const old = state.bets.shift();
    if (!old) break;
    state.byTxid.delete(old.txid);
    state.betOffset += 1n;
  }
  const logical = state.betOffset + BigInt(state.bets.length);
  state.bets.push(bet);
  return logical;
}

export function pushTransfer(state, t) {
  while (state.transfers.length >= MAX_TRANSFERS_VEC) {
    const old = state.transfers.shift();
    if (!old) break;
    state.byTxid.delete(old.txid);
    state.transferOffset += 1n;
  }
  const logical = state.transferOffset + BigInt(state.transfers.length);
  state.transfers.push(t);
  return logical;
}

export function pushDeploy(state, d) {
  while (state.deploys.length >= MAX_DEPLOYS_VEC) {
    const old = state.deploys.shift();
    if (!old) break;
    state.byTxid.delete(old.txid);
    state.deployOffset += 1n;
  }
  const logical = state.deployOffset + BigInt(state.deploys.length);
  state.deploys.push(d);
  return logical;
}

// ---- Address-level balance query ----------------------------------------

/**
 * Sum a single address's per-UTXO balances into a per-ticker total.
 * Returns { TICKER: bigint, ... }. O(|address's UTXOs|) thanks to
 * the reverse index. Mirrors Rust's `address_balances`.
 *
 * Empty object if the address has never received protocol tokens.
 */
export function addressBalances(state, address) {
  const totals = {};
  const set = state.addressUtxos.get(address);
  if (!set) return totals;
  for (const key of set) {
    const entry = state.utxoBalances.get(key);
    if (!entry) continue;
    for (const [ticker, amt] of entry.balances) {
      const cur = totals[ticker] || 0n;
      totals[ticker] = cur + amt;
    }
  }
  return totals;
}

/**
 * Per-UTXO token balances for one address. Used by tx-web's coin
 * selector to do greedy minimum-UTXO selection. Returns
 *   [{ txid, vout, balances: { TICKER: number } }, ...]
 * matching the desktop indexer's `/utxos/:address` response shape.
 *
 * `balances` values are coerced to JS Number — safe because all
 * possible values fit in 2^53 (capped at REQUIRED_TOKEN_SUPPLY =
 * 21_000_000n). Number is what the existing tx-web layer expects
 * after the IPC round-trip from desktop, so matching keeps the
 * coin-selector untouched.
 */
export function addressUtxoBalances(state, address) {
  const out = [];
  const set = state.addressUtxos.get(address);
  if (!set) return out;
  for (const key of set) {
    const entry = state.utxoBalances.get(key);
    if (!entry || entry.balances.size === 0) continue;
    const [txid, voutStr] = key.split(":");
    const balances = {};
    for (const [ticker, amt] of entry.balances) {
      balances[ticker] = Number(amt);
    }
    out.push({ txid, vout: parseInt(voutStr, 10), balances });
  }
  return out;
}

// ---- Diagnostics ring buffer --------------------------------------------

export const MAX_RECENT_ERRORS = 16;

/**
 * Push a diagnostic event to the ring buffer. FIFO-evicts the oldest
 * once we hit MAX_RECENT_ERRORS. `ev.detail` MUST be a short, secret-
 * free string — these surface to the SETTINGS → INDEXER DIAGNOSTICS
 * panel verbatim.
 */
export function pushError(state, ev) {
  while (state.recentErrors.length >= MAX_RECENT_ERRORS) {
    state.recentErrors.shift();
  }
  state.recentErrors.push({
    at: Math.floor(Date.now() / 1000),
    ...ev,
  });
}

/**
 * Mark forward progress — called every time indexedHeight advances.
 * The stalled-detector in api.js compares this against now to decide
 * whether to flag a stalled scan.
 */
export function touchProgress(state) {
  state.lastProgressAt = Math.floor(Date.now() / 1000);
}
