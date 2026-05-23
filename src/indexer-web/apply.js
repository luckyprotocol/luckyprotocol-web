// LUCKYPROTOCOL apply_tx — the core indexer state machine (browser port).
//
// Mirrors luckyprotocol-indexer/src/indexer.rs::IndexerState::apply_tx
// byte-for-byte. If this disagrees with the Rust indexer on ANY tx,
// browser-local balances will diverge from the canonical chain view
// and the user sees wrong numbers — so every step here intentionally
// mirrors the Rust comments + ordering.
//
// Inputs:
//   state    — mutable IndexerState (from state.js::newState)
//   ctx      — TxContext:
//     {
//       txid:           string (lowercase hex),
//       blockHeight:    number,
//       blockHash:      string (lowercase hex),
//       sender:         string (audit-only; address that contributed the
//                       most input value),
//       spentOutpoints: Array<[txidStr, voutNum]>,
//       voutCount:      number,
//       opReturnVouts:  Array<number>,
//       voutAddresses:  Array<string|null>, // indexed by vout_idx
//       voutValues:     Array<number>,      // sats per vout
//     }
//   payload  — { kind: "deploy"|"bet"|"xfer", ... } from parsePayload,
//              or null if the tx had no recognized LUCKYPROTOCOL OP_RETURN.
//
// Returns true iff any state change occurred.

import {
  outpointKey,
  trackAddressUtxo,
  untrackAddressUtxo,
  pushBet,
  pushTransfer,
  pushDeploy,
} from "./state.js";
import { LCKPROTOCOL_V1_HEIGHT, settleBet, tierReward } from "./protocol.js";

// ---- Consensus constants (must match Rust protocol.rs) ------------------

export const REQUIRED_TOKEN_SUPPLY = 21_000_000n;
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460;
// SEND_PROTOCOL_FEE_SATS — consensus-enforced in cohort v950382+. Every
// SEND tx must include at least one output paying >= this many sats to
// PROJECT_FEE_ADDRESS or applyTx marks it `applied=false` (no balance
// transfer happens; residual still routes per change_out_idx). The fee
// gate is what makes /address/PROJECT_FEE_ADDRESS/txs a sound
// fast-bootstrap source: a wallet that emits SENDs without the fee is
// either non-protocol-aware (its TX gets ignored anyway) or trying to
// evade the bootstrap path (same outcome — ignored).
export const SEND_PROTOCOL_FEE_SATS = 546;
export const PROJECT_FEE_ADDRESS =
  "bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3";

// Reusable predicate: does this tx have at least one vout paying
// `>= minSats` to `PROJECT_FEE_ADDRESS`? Used by both the DEPLOY and
// SEND fee gates.
function _hasProjectFeeOutput(ctx, minSats) {
  for (let i = 0; i < ctx.voutValues.length; i++) {
    if (ctx.voutValues[i] >= minSats && ctx.voutAddresses[i] === PROJECT_FEE_ADDRESS) {
      return true;
    }
  }
  return false;
}

// ---- Helpers ------------------------------------------------------------

function isOpReturnVout(ctx, vout) {
  return ctx.opReturnVouts.includes(vout);
}

/**
 * Validate that `idx` points at a real, non-OP_RETURN vout. Returns
 * `idx` iff valid, `null` otherwise. Mirrors Rust's `validate_out_idx`.
 */
function validateOutIdx(ctx, idx) {
  if (idx == null) return null;
  if (idx >= ctx.voutCount) return null;
  if (isOpReturnVout(ctx, idx)) return null;
  return idx;
}

// ---- The apply pipeline -------------------------------------------------

/**
 * Apply one tx's combined effect (input-pool drain → payload edict →
 * residual routing → output commit) to `state`. Returns true iff
 * any state mutation occurred.
 *
 * Activation gate: pre-LCKPROTOCOL_V1_HEIGHT blocks short-circuit with
 * `false` — no pre-genesis state is replayed and no LUCKYPROTOCOL state
 * mutates from txs in those heights.
 */
export function applyTx(state, ctx, payload) {
  if (ctx.blockHeight < LCKPROTOCOL_V1_HEIGHT) return false;

  // === STEP 1: Build the input pool by draining spent UTXOs ============
  //
  // Every spent outpoint that appears in utxoBalances contributes its
  // token balances to the per-tx "input pool". The UTXO entry is
  // removed from state and its reverse-index entry untracked so
  // /balances/:address stops counting it immediately.
  //
  // After STEP 1, the input pool is a {ticker -> bigint} Map that
  // either flows through a payload edict (BET reward target, SEND
  // recipient + change) or routes via STEP 3's residual rules.
  const inputPool = new Map();
  for (const [stxid, svout] of ctx.spentOutpoints) {
    const key = outpointKey(stxid, svout);
    const entry = state.utxoBalances.get(key);
    if (!entry) continue;
    state.utxoBalances.delete(key);
    untrackAddressUtxo(state, entry.address, key);
    for (const [ticker, amt] of entry.balances) {
      const cur = inputPool.get(ticker) || 0n;
      inputPool.set(ticker, cur + amt);
    }
  }

  let changed = inputPool.size > 0;

  // === STEP 1b: Multi-ticker input rejection ===========================
  //
  // PROTOCOL.md §7.2 — a single tx may consume token UTXOs of AT MOST
  // ONE ticker. Mixing tickers in inputs is ambiguous (SEND payload
  // declares one ticker; the other(s) have no specified destination)
  // and resolving silently is a divergence vector. The strict rule
  // is "one ticker per tx or no tokens move" — the entire input pool
  // BURNS, and any payload below records as applied=false /
  // status=Invalid.
  //
  // Wallets that need to spend multiple tickers MUST construct one tx
  // per ticker. Our tx-web coin selector already enforces this; only
  // non-protocol-aware spenders trip this branch.
  if (inputPool.size > 1) {
    inputPool.clear();
  }

  // Idempotency: only audit-log + tokens map need txid dedup.
  // utxoBalances is naturally idempotent (UTXOs spent at most once on
  // the chain). Same posture as Rust's `already_logged`.
  const alreadyLogged = state.byTxid.has(ctx.txid);

  // === STEP 2: Apply the payload edict (if any) ========================
  //
  // outputAssignments accumulates per-vout token deposits. Keyed by
  // vout index; value is a Map<ticker, bigint> of credits to that vout.
  // STEP 3's residual routing also writes into this map (under the
  // SEND/MINE change_out_idx), and STEP 4 commits the merged result
  // into utxoBalances.
  const outputAssignments = new Map(); // vout -> Map<ticker, bigint>
  let explicitChangeIdx = null;

  if (payload && !alreadyLogged) {
    if (payload.kind === "bet") {
      changed = true;
      const winIdxValid = validateOutIdx(ctx, payload.winOutIdx);
      const tickerDeployed = state.tokens.has(payload.ticker);

      let status = "settled";
      let win = null;
      let reward = 0n;
      let capExhausted = false;

      if (!tickerDeployed || winIdxValid === null) {
        // BET against undeployed ticker, OR win_out_idx is OP_RETURN /
        // out-of-range. Protocol-rejected; no UTXO mutation, no
        // reward credit. Still recorded as Invalid so the UI can
        // surface "you bet on an undeployed ticker" etc.
        status = "invalid";
      } else {
        // Settle inline against the confirming block's hash —
        // identical to settleBet() in protocol.js.
        const outcome = settleBet(payload, ctx.blockHash);
        const predicateHit = outcome?.win === true;
        if (predicateHit) {
          const rawReward = tierReward(payload.tier);
          const reg = state.tokens.get(payload.ticker);
          if (reg) {
            const remaining = reg.supply - reg.minted;
            const credit = rawReward < remaining ? rawReward : remaining;
            reg.minted = reg.minted + credit;
            reward = credit;
            if (credit === 0n) capExhausted = true;
          }
        }
        win = reward > 0n;
        if (reward > 0n) {
          // Mint to the declared win output.
          const targetIdx = winIdxValid;
          let entry = outputAssignments.get(targetIdx);
          if (!entry) {
            entry = new Map();
            outputAssignments.set(targetIdx, entry);
          }
          const cur = entry.get(payload.ticker) || 0n;
          entry.set(payload.ticker, cur + reward);
        }
      }

      // v2 PROTOCOL: optional change_out_idx routes residual input
      // pool to the declared vout in STEP 3. Legacy 5-field MINEs
      // (changeOutIdx == undefined) burn residual under the strict
      // rule. Out-of-bounds / OP_RETURN-pointing change_out_idx is
      // silently downgraded to burn — same as SEND. BetView still
      // records the RAW declared index for audit.
      if (payload.changeOutIdx != null) {
        if (validateOutIdx(ctx, payload.changeOutIdx) !== null) {
          explicitChangeIdx = payload.changeOutIdx;
        }
      }

      const logical = pushBet(state, {
        txid: ctx.txid,
        block_height: ctx.blockHeight,
        block_hash: ctx.blockHash,
        sender: ctx.sender,
        tier: payload.tier,
        pick: payload.pick,
        ticker: payload.ticker,
        win_out_idx: payload.winOutIdx,
        change_out_idx: payload.changeOutIdx ?? null,
        status,
        reveal_block_height: null,
        reveal_block_hash: null,
        win,
        reward_smallest: Number(reward), // see state.js comment on Number coercion
        cap_exhausted: capExhausted,
      });
      state.byTxid.set(ctx.txid, { kind: "bet", idx: logical });
    } else if (payload.kind === "xfer") {
      changed = true;
      const toValid = validateOutIdx(ctx, payload.toOutIdx);
      const poolAmt = inputPool.get(payload.ticker) || 0n;
      // CONSENSUS FEE GATE (v950382+) — a SEND tx without a
      // qualifying PROJECT_FEE_ADDRESS output is recorded but NOT
      // applied: no balance transfer, recipient gets nothing,
      // residual still routes via change_out_idx (so the sender's
      // tokens aren't burned unfairly — they're recovered by
      // explicit change vs. the strict-burn fallback). Wallets that
      // omit the fee are either non-protocol-aware or trying to
      // dodge fast-bootstrap's PROJECT_FEE_ADDRESS index sweep;
      // either way the tx is invisible to /balances queries.
      const feePaid = _hasProjectFeeOutput(ctx, SEND_PROTOCOL_FEE_SATS);
      const applied =
        toValid !== null && poolAmt >= payload.amount && feePaid;

      if (applied) {
        // Credit recipient.
        let entry = outputAssignments.get(toValid);
        if (!entry) {
          entry = new Map();
          outputAssignments.set(toValid, entry);
        }
        const cur = entry.get(payload.ticker) || 0n;
        entry.set(payload.ticker, cur + payload.amount);
        // Decrement pool; remainder routes via explicitChangeIdx in STEP 3.
        const rem = poolAmt - payload.amount;
        if (rem === 0n) inputPool.delete(payload.ticker);
        else inputPool.set(payload.ticker, rem);
      }

      // Validate change index even on applied=false SENDs — the user
      // declared a destination, so residual flows there. Only payload-
      // less / DEPLOY / changeless spends BURN. (This applies whether
      // the SEND failed on insufficient pool, on missing fee, or on
      // an invalid to_out_idx.)
      if (payload.changeOutIdx != null) {
        if (validateOutIdx(ctx, payload.changeOutIdx) !== null) {
          explicitChangeIdx = payload.changeOutIdx;
        }
      }

      const logical = pushTransfer(state, {
        txid: ctx.txid,
        block_height: ctx.blockHeight,
        block_hash: ctx.blockHash,
        sender: ctx.sender,
        ticker: payload.ticker,
        amount: Number(payload.amount),
        to_out_idx: payload.toOutIdx,
        change_out_idx: payload.changeOutIdx ?? null,
        applied,
      });
      state.byTxid.set(ctx.txid, { kind: "transfer", idx: logical });
    } else if (payload.kind === "deploy") {
      changed = true;
      const already = state.tokens.has(payload.ticker);
      // CONSENSUS PROTOCOL FEE gate (PROTOCOL.md §5.1.2). A DEPLOY tx
      // MUST include at least one output paying ≥ DEPLOY_PROTOCOL_FEE_SATS
      // to PROJECT_FEE_ADDRESS. Without this gate the append-only
      // tokens registry is griefable at dust cost.
      const feePaid = _hasProjectFeeOutput(ctx, DEPLOY_PROTOCOL_FEE_SATS);
      const applied = !already && feePaid;
      if (applied) {
        state.tokens.set(payload.ticker, {
          ticker: payload.ticker,
          supply: REQUIRED_TOKEN_SUPPLY,
          minted: 0n,
          deployer: ctx.sender,
          deploy_txid: ctx.txid,
          deploy_block: ctx.blockHeight,
        });
      }
      const logical = pushDeploy(state, {
        txid: ctx.txid,
        block_height: ctx.blockHeight,
        block_hash: ctx.blockHash,
        deployer: ctx.sender,
        ticker: payload.ticker,
        supply: Number(REQUIRED_TOKEN_SUPPLY),
        applied,
      });
      state.byTxid.set(ctx.txid, { kind: "deploy", idx: logical });
    }
  }
  // No payload OR duplicate txid: fall through. The input-pool tokens
  // (if any) still need routing — STEP 3 handles them. Token UTXOs are
  // consumed at the Bitcoin layer regardless of our recognition, so
  // their tokens MUST go somewhere (BURN, by default).

  // === STEP 3: Route residual input pool — strict BURN policy ===========
  //
  // V2 PROTOCOL RULE (PROTOCOL.md §6.6 + §7.4): residual tokens are
  // preserved ONLY when the tx carries an op whose change_out_idx is
  // valid. Ops that can declare change_out_idx:
  //   - SEND (always, since v1)
  //   - MINE (since v2, optional 6th field)
  //
  // ANY other case BURNS:
  //   - DEPLOY payload
  //   - no payload
  //   - MINE without valid change_out_idx (legacy 5-field)
  //   - SEND with missing/invalid change_out_idx
  //
  // Rationale: prevents non-LUCKYPROTOCOL wallets from accidentally
  // moving tokens during UTXO consolidation, AND prevents a malicious
  // wallet from funneling other people's tokens to its own address by
  // spending a dust UTXO it happens to receive.
  if (inputPool.size > 0) {
    if (explicitChangeIdx !== null) {
      let entry = outputAssignments.get(explicitChangeIdx);
      if (!entry) {
        entry = new Map();
        outputAssignments.set(explicitChangeIdx, entry);
      }
      for (const [ticker, amt] of inputPool) {
        const cur = entry.get(ticker) || 0n;
        entry.set(ticker, cur + amt);
      }
      inputPool.clear();
    } else {
      // BURN — tokens destroyed. The audit-log entry above (if any)
      // already records applied=false / status=Invalid so the user
      // can see what happened.
      inputPool.clear();
    }
  }

  // === STEP 4: Commit output assignments to utxoBalances ===============
  //
  // For each accumulated vout-credit, materialize a UtxoEntry at that
  // outpoint and add the address to the reverse index. We track the
  // reverse index BEFORE mutating utxoBalances so a panicking borrow
  // can't desync the two maps (matches Rust ordering).
  for (const [voutIdx, balance] of outputAssignments) {
    if (balance.size === 0) continue;
    const key = outpointKey(ctx.txid, voutIdx);
    const address = ctx.voutAddresses[voutIdx] ?? null;
    trackAddressUtxo(state, address, key);
    let entry = state.utxoBalances.get(key);
    if (!entry) {
      entry = { address, balances: new Map() };
      state.utxoBalances.set(key, entry);
    }
    if (entry.address == null) entry.address = address;
    for (const [ticker, amt] of balance) {
      const cur = entry.balances.get(ticker) || 0n;
      entry.balances.set(ticker, cur + amt);
    }
  }

  return changed;
}
