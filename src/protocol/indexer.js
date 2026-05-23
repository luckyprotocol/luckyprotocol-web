// LUCKYPROTOCOL local protocol indexer.
// "Indexer" in the BRC-20 / Runes sense: read confirmed LUCKYPROTOCOL OP_RETURN
// txs from the chain → derive token balances. This is the PERSONAL indexer
// — it only sees this app instance's bets (txids it has broadcast). The
// global indexer (luckyprotocol-indexer sidecar) crawls every LUCKYPROTOCOL
// OP_RETURN on the network for every UTXO.
// Storage shape (localStorage `luckyprotocol.indexed_balances.v1`):
// { HEXM: 12300000000, PEPE: 50000000000,... } // smallest units (1e8 = 1 token)
// Token issuance rule:
// - WIN bet → balance[ticker] += TIER_REWARDS[tier] * 1e8
// - LOSS bet → no change
// - Reward amounts taken from the existing TIERS table (consistency with
// the casino game UI). All tier rewards are in TOKEN-SMALLEST-UNITS,
// not BTC sats — there is no on-chain BTC payout.

const LS_BALANCES_KEY = "luckyprotocol.indexed_balances.v1";

// Protocol activation height (LUCKYPROTOCOL v1, UTXO-bound, genesis).
// Any LUCKYPROTOCOL tx confirmed in a block STRICTLY BEFORE this height
// is invalid. This app instance does NOT replay or recognize any
// pre-950,382 deploys / balances / bets / transfers, including any
// legacy `BTCASINO|*` payloads that may exist in earlier chain
// history AND any prior LUCKYPROTOCOL cohort traffic (949,375-950,381
// withdrawn during the web-build cutover).
// MUST stay in lockstep with src/indexer-web/protocol.js's
// LCKPROTOCOL_V1_HEIGHT constant.
export const LCKPROTOCOL_START_HEIGHT = 950_382;

/** Returns true if a confirmed-tx block height counts toward the protocol. */
export function isProtocolHeightValid(blockHeight) {
  return Number.isFinite(blockHeight) && blockHeight >= LCKPROTOCOL_START_HEIGHT;
}

// Reward amounts per tier, in TOKEN-SMALLEST-UNITS (1e8 = 1 whole token).
// These match the TIERS table in LuckyProtocolApp.jsx for visual continuity
// with the casino game rooms. Update both if you change one.
export const TIER_REWARDS_SMALLEST = {
  iron:   100,
  bronze: 1_000,
  silver: 10_000,
  gold:   200_000,
};

const lsGet = (k) => {
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
const lsSet = (k, v) => {
  try { window.localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

/** Returns the full balances map { TICKER: smallest_units }. Empty if no wins yet. */
export function getIndexedBalances() {
  const raw = lsGet(LS_BALANCES_KEY);
  return (raw && typeof raw === "object") ? raw : {};
}

/** Returns balance for one ticker (smallest units, 0 if not credited). */
export function getIndexedBalance(ticker) {
  return getIndexedBalances()[ticker] ?? 0;
}

/**
 * Credit a WIN bet's reward into the indexed balance for `ticker`.
 * Returns `{ credited, new_balance, capped }` describing the outcome.
 * Caller (the bet poller) MUST guard against double-crediting the same
 * txid — we don't dedupe here because we don't know the bet history.
 * SUPPLY CAP: when `opts.supplyCap` and `opts.alreadyMinted` are both
 * provided (i.e. caller pulled them from state.deployedTokens, which is
 * sourced from the global indexer's token registry), the credit is
 * clamped so `alreadyMinted + creditedReward <= supplyCap`. If the cap
 * is already hit, `credited = 0`.— without this, a hot
 * streak could inflate the local balance past the protocol-fixed 21M
 * supply, which the global indexer would never honor.
 * STRICT TICKER GATE: when `opts.requireDeployed === true` (the audit-
 * fixed default at the bet-poller call site), credit is refused for
 * tickers absent from `opts.knownTickers`. This matches the global
 * indexer's strict-mode rule: BET on an undeployed ticker is rejected,
 * so crediting locally would only paint a phantom balance.
 */
export function creditWinReward(ticker, tier, opts = {}) {
  const reward = TIER_REWARDS_SMALLEST[tier];
  if (!reward) {
    return { credited: 0, new_balance: getIndexedBalance(ticker), capped: false };
  }
  if (opts.requireDeployed && opts.knownTickers && !opts.knownTickers.has(ticker)) {
    return { credited: 0, new_balance: getIndexedBalance(ticker), capped: false };
  }
  let credit = reward;
  let capped = false;
  if (Number.isFinite(opts.supplyCap) && Number.isFinite(opts.alreadyMinted)) {
    const remaining = Math.max(0, opts.supplyCap - opts.alreadyMinted);
    if (credit > remaining) {
      credit = remaining;
      capped = true;
    }
  }
  if (credit <= 0) {
    return { credited: 0, new_balance: getIndexedBalance(ticker), capped };
  }
  const balances = getIndexedBalances();
  const next = (balances[ticker] ?? 0) + credit;
  balances[ticker] = next;
  lsSet(LS_BALANCES_KEY, balances);
  return { credited: credit, new_balance: next, capped };
}

/**
 * Reverse a previously-credited win. Used by the reorg-recovery path
 * in the bet poller: if a confirmed bet's block_hash later changes
 * (the confirming block fell out via reorg), the local +reward we
 * credited is no longer valid. Decrement the same amount we added,
 * floored at 0 so a buggy retry can't push the balance negative.
 * Returns {reversed, new_balance, prev_balance}. `reversed` is the
 * actual decrement applied (may be < requested if local balance is
 * already lower than the original credit — defensive against state
 * desync, but normally equals `amount`).
 */
export function reverseWinCredit(ticker, amount) {
  const balances = getIndexedBalances();
  const prev = balances[ticker] ?? 0;
  const reversed = Math.min(prev, amount);
  const next = prev - reversed;
  balances[ticker] = next;
  lsSet(LS_BALANCES_KEY, balances);
  return { reversed, new_balance: next, prev_balance: prev };
}

/**
 * For dev / wipe flows. Clears all indexed balances + transfer log.
 * (e.g. wallet wipe in Settings → Danger Zone should also clear state.)
 */
export function wipeIndexedBalances() {
  try { window.localStorage.removeItem(LS_BALANCES_KEY); } catch {}
  try { window.localStorage.removeItem(LS_TRANSFERS_KEY); } catch {}
}

/**
 * Targeted wipe — removes all balance entries whose ticker is in the
 * provided set. Used by the boot migration to clean up "ghost"
 * tickers (locally-discovered tokens with no actual on-chain DEPLOY
 * tx) that under the new protocol activation height are now invalid.
 * Leaves valid tickers' balances intact.
 * @param {Set<string>|string[]} tickers
 */
export function wipeIndexedBalancesForTickers(tickers) {
  const set = tickers instanceof Set ? tickers : new Set(tickers);
  if (set.size === 0) return;
  try {
    const raw = window.localStorage.getItem(LS_BALANCES_KEY);
    if (!raw) return;
    const balances = JSON.parse(raw);
    let changed = false;
    for (const t of Object.keys(balances)) {
      if (set.has(t)) { delete balances[t]; changed = true; }
    }
    if (changed) {
      window.localStorage.setItem(LS_BALANCES_KEY, JSON.stringify(balances));
    }
  } catch {}
}

// ============================================================================
// TRANSFER LEDGER
// ============================================================================
// Tracks outgoing XFER txs the local app has broadcast. On confirmation,
// the indexer debits the sender's balance by `amount`. Incoming transfers
// (where this wallet is the recipient) require a global indexer to spot —
// for now they're invisible to the local indexer.

const LS_TRANSFERS_KEY = "luckyprotocol.indexed_transfers.v1";

export function getOutgoingTransfers() {
  const raw = lsGet(LS_TRANSFERS_KEY);
  return Array.isArray(raw) ? raw : [];
}

export function recordOutgoingTransfer(record) {
  const list = getOutgoingTransfers();
 // Cap at 100 most recent so localStorage doesn't grow unbounded.
  const next = [record, ...list].slice(0, 100);
  lsSet(LS_TRANSFERS_KEY, next);
  return next;
}

export function updateOutgoingTransfer(txid, patch) {
  const list = getOutgoingTransfers();
  const next = list.map((t) => t.txid === txid ? { ...t, ...patch } : t);
  lsSet(LS_TRANSFERS_KEY, next);
  return next;
}

/**
 * Apply an OUTGOING transfer's debit to the indexed balance. Caller must
 * dedupe by tx confirmation status (the bet/transfer poller won't apply
 * the same debit twice). If the balance would go negative, the transfer
 * is treated as no-op (matches global indexer rules — under-funded XFER
 * is dropped).
 * Returns {applied: bool, new_balance, prev_balance}.
 */
export function debitOutgoingTransfer(ticker, amount) {
  const balances = getIndexedBalances();
  const prev = balances[ticker] ?? 0;
  if (prev < amount) {
    return { applied: false, new_balance: prev, prev_balance: prev };
  }
  const next = prev - amount;
  balances[ticker] = next;
  lsSet(LS_BALANCES_KEY, balances);
  return { applied: true, new_balance: next, prev_balance: prev };
}
