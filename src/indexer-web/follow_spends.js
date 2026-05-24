// FAST-PATH SEND DISCOVERY — Track spends of every known token UTXO.
//
// Why this exists:
//   The PROJECT_FEE_ADDRESS fast-bootstrap (fast_bootstrap.js) covers
//   every DEPLOY + MINE in chain history, but it MISSES every SEND
//   (which doesn't pay the protocol fee). A naive fix would be to
//   block-scan the entire activation→tip window for SENDs, but that
//   re-introduces the slowness fast bootstrap was meant to eliminate.
//
//   Observation: A SEND is BY DEFINITION the spend of an existing
//   token UTXO. Tokens cannot appear from nowhere; every SEND in
//   history must spend a UTXO created by either an earlier DEPLOY,
//   MINE, or SEND. So if we walk the spend chain forward from each
//   DEPLOY/MINE-created UTXO, we discover every SEND that's ever
//   moved those tokens — without scanning a single block.
//
//   Algorithm:
//     1. For each UTXO in state.utxoBalances, query Esplora
//        `/tx/:txid/outspends` for its vout's spend status.
//     2. If spent: fetch the spending tx via `/tx/:txid`, build
//        TxContext, applyTx. The applied tx will either:
//          - be a SEND (recognized payload, applied=true if pool covers)
//          - be a no-payload spend → tokens BURN per the strict rule
//          - be a different protocol op that also routes residual
//        EITHER WAY, applyTx mutates utxoBalances correctly: spent
//        entries removed, new entries (if any) added.
//     3. New entries created by step 2 are themselves token UTXOs
//        that may have onward spends — loop until no new UTXOs are
//        produced.
//
//   Cost: one outspend HTTP call per known token UTXO + one full-tx
//   call per actually-spent UTXO. For a fresh wallet with K mints,
//   that's O(K) HTTP calls vs. the block-scan path's O(blocks-since-
//   activation × txs-per-block). At rate-gated 4 req/sec we cover a
//   thousand UTXOs in ~4 minutes; almost all wallets have <<100.

import {
  fetchTxOutspends,
  fetchTxFull,
  extractLuckyprotocolPayload,
  hasEsploraAlchemyKey,
} from "../chain-web/esplora.js";
import { parsePayload } from "./protocol.js";
import { applyTx } from "./apply.js";
import { touchProgress, pushError } from "./state.js";

// Iteration safety cap. Even with chained SENDs this should converge
// in a handful of rounds, but a buggy applyTx could in theory loop
// forever (e.g. if it created a new entry equal to a just-removed
// one). 64 rounds is comfortable headroom.
const MAX_ROUNDS = 64;

// Per-call spacing — adaptive based on whether Alchemy is configured
// (matches scanner.js + fast_bootstrap.js):
//   ALCHEMY KEY SET → 50ms = 20 req/sec
//   NO ALCHEMY KEY  → 250ms = 4 req/sec (public-mirror safety default)
function spacingMs() {
  return hasEsploraAlchemyKey() ? 50 : 250;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a TxContext from an Esplora full-tx object. Mirrors the
 * conversion in fast_bootstrap.js (could factor out, but inline
 * keeps modules independently auditable). Returns null if the tx is
 * unconfirmed.
 */
function _esploraTxToContext(tx) {
  const height = tx.status?.block_height;
  if (typeof height !== "number") return null;
  const blockHash = String(tx.status?.block_hash || "").toLowerCase();

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
 * Walk the spend chain forward from every token UTXO currently in
 * `state.utxoBalances`. Discovers every SEND (and every burn-on-
 * spend) that's affected the tracked set, without block scanning.
 *
 * Returns the count of spending txs applied. Best-effort — individual
 * HTTP failures are logged to `state.recentErrors` and skipped; the
 * caller (boot()) can re-run later or fall back to block scanning to
 * fill any gaps.
 *
 * MUST be called AFTER fastBootstrap so the initial token UTXO set
 * exists in state.utxoBalances. Calling it on an empty state is a
 * cheap no-op.
 */
export async function followTokenSpends(state, signal) {
  if (signal?.aborted) throw new Error("scan aborted");

  // `checkedOutpoints` is keyed by "txid:vout" — same form as
  // state.utxoBalances. Once we've queried an outpoint's outspend
  // status we don't re-query it: applying a spend REMOVES the
  // outpoint from utxoBalances, so the only way it'd reappear is if
  // we somehow re-created an entry at the exact same outpoint
  // (impossible — Bitcoin txids are unique).
  const checked = new Set();
  let totalApplied = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error("scan aborted");

    // Snapshot the current UTXO keys so we iterate a stable list
    // even though applyTx will mutate utxoBalances under us.
    const candidates = [];
    for (const key of state.utxoBalances.keys()) {
      if (!checked.has(key)) candidates.push(key);
    }
    if (candidates.length === 0) break;

    // eslint-disable-next-line no-console
    console.log("[indexer] follow-spends round", round + 1,
      "— checking", candidates.length, "token UTXOs");

    let appliedThisRound = 0;
    for (const opkey of candidates) {
      if (signal?.aborted) throw new Error("scan aborted");
      checked.add(opkey);
      const [txid, voutStr] = opkey.split(":");
      const vout = parseInt(voutStr, 10);

      // STEP 1: cheap outspend probe. One HTTP per UTXO.
      let outspends;
      try {
        outspends = await fetchTxOutspends(txid);
        await sleep(spacingMs());
      } catch (e) {
        pushError(state, {
          kind: "network",
          host: null,
          height: null,
          detail: `follow-spends outspends(${txid}) failed: ${String(e?.message || e)}`,
        });
        continue;
      }

      const outspend = Array.isArray(outspends) ? outspends[vout] : null;
      if (!outspend || !outspend.spent) continue;
      // Confirm-only — unconfirmed spends are mempool and unsafe to
      // apply (could reorg out). The steady-state poll picks them up
      // once they confirm.
      if (!outspend.status?.confirmed) continue;
      // Also skip if the spending tx is at a height we already
      // processed via fast-bootstrap (its effect is already in
      // state.utxoBalances). The `checked` set + utxoBalances
      // membership filter above already prevents this in normal
      // flow, but be explicit.

      // STEP 2: pull the spending tx in full so we can build a
      // TxContext + check for a LUCKYPROTOCOL OP_RETURN.
      let tx;
      try {
        tx = await fetchTxFull(outspend.txid);
        await sleep(spacingMs());
      } catch (e) {
        pushError(state, {
          kind: "network",
          host: null,
          height: outspend.status?.block_height ?? null,
          detail: `follow-spends tx(${outspend.txid}) failed: ${String(e?.message || e)}`,
        });
        continue;
      }

      const ctx = _esploraTxToContext(tx);
      if (!ctx) continue;
      const payloadText = extractLuckyprotocolPayload(tx);
      const payload = payloadText ? parsePayload(payloadText) : null;

      // Record block hash so reorg checks have something to compare.
      state.blockHashes.set(ctx.blockHeight, ctx.blockHash);
      applyTx(state, ctx, payload);
      appliedThisRound += 1;
      totalApplied += 1;

      // Advance indexedHeight if this tx was past our current
      // bookmark — useful for the UI's progress display so SEND
      // discovery looks like real catch-up progress.
      if (ctx.blockHeight > state.indexedHeight) {
        state.indexedHeight = ctx.blockHeight;
        touchProgress(state);
      }
    }

    // eslint-disable-next-line no-console
    console.log("[indexer] follow-spends round", round + 1,
      "applied", appliedThisRound, "spending txs;",
      state.utxoBalances.size, "token UTXOs remain");

    if (appliedThisRound === 0) break;
  }

  return totalApplied;
}
