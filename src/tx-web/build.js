// Common tx-build pipeline shared by DEPLOY / MINE / SEND.
//
// Steps every op goes through:
//   1. Fetch our address's UTXOs from Esplora.
//   2. Filter out user-supplied "unspendable" outpoints (token UTXOs
//      the caller doesn't want pulled into a non-SEND op).
//   3. Coin-select inputs to cover the sum of declared outputs + an
//      estimated miner fee at the chosen sat/vB rate.
//   4. Construct the tx with @scure/btc-signer, signing each P2WPKH
//      input with the unlocked session's private key.
//   5. Serialize to hex and broadcast via Esplora /tx POST.
//
// Output ordering matches the desktop tx.rs:
//   * vout indices in the OP_RETURN payload (win_out_idx, to_out_idx,
//     change_out_idx) MUST match where bdk_wallet writes the actual
//     outputs in the final tx. Rust uses `TxOrdering::Untouched`;
//     @scure/btc-signer's Transaction defaults to insertion order
//     so as long as we call `tx.addOutput*` in the right sequence,
//     we get the same vout layout.

import * as btc from "@scure/btc-signer";
import { getAddressUtxos, broadcastTx, getRecommendedFeeRate } from "../protocol/chain.js";
import { getSession } from "../wallet-web/session.js";
import { DUST_SATS } from "./payloads.js";

// Bytes-per-tx-component vsize estimates for fee budgeting. P2WPKH
// (which is what every LUCKYPROTOCOL reference-wallet input + change
// output uses) has well-known sizes per BIP141 — we use these to
// pre-estimate the fee without round-tripping through "build → measure
// → rebuild" with a higher fee.
const VSIZE_TX_OVERHEAD = 11;       // version + segwit marker + locktime + counters
const VSIZE_P2WPKH_INPUT = 68;      // outpoint + sequence + witness overhead (vsize, not bytes)
const VSIZE_P2WPKH_OUTPUT = 31;     // value + script-len + 22B P2WPKH script
const VSIZE_P2TR_OUTPUT = 43;       // value + script-len + 34B P2TR script (project fee addr)
const VSIZE_OPRETURN_BASE = 11;     // value (0) + script-len + OP_RETURN + push opcode

function estimateVsize({ inputCount, p2wpkhOutputs, p2trOutputs, opReturnBytes }) {
  return (
    VSIZE_TX_OVERHEAD +
    inputCount * VSIZE_P2WPKH_INPUT +
    p2wpkhOutputs * VSIZE_P2WPKH_OUTPUT +
    p2trOutputs * VSIZE_P2TR_OUTPUT +
    (opReturnBytes > 0 ? VSIZE_OPRETURN_BASE + opReturnBytes : 0)
  );
}

/**
 * Coin selection — greedy, smallest-first, with optional pinned
 * `mustInclude` outpoints and a deny-list of `excludeKeys` (outpoint
 * strings `txid:vout`). Returns the array of selected UTXO objects
 * (matching Esplora's wire shape: `{txid, vout, value, status}`) plus
 * the total value selected.
 *
 * "Smallest-first" gives the user good chip-consolidation behavior
 * for MINE: their smallest 546-sat dust gets spent first as the
 * winning-slot input, leaving larger UTXOs intact for SEND amounts.
 * The desktop wallet's BnB selector picks differently but the
 * indexer doesn't care which inputs we use; the end balances are
 * identical.
 */
function selectInputs({ utxos, target, mustInclude, excludeKeys }) {
  const exclude = new Set(excludeKeys || []);
  const include = mustInclude || [];

  const key = (u) => `${u.txid}:${u.vout}`;

  // Bring `mustInclude` UTXOs in first (caller wants these spent).
  // Then sort the remainder ascending and accumulate until target met.
  const pinned = include.filter((u) => !exclude.has(key(u)));
  const remaining = utxos
    .filter((u) => !exclude.has(key(u)) && !include.some((p) => key(p) === key(u)))
    .sort((a, b) => a.value - b.value);

  const selected = [...pinned];
  let total = pinned.reduce((s, u) => s + Number(u.value), 0);
  for (const u of remaining) {
    if (total >= target) break;
    selected.push(u);
    total += Number(u.value);
  }
  if (total < target) {
    throw new Error(
      `insufficient funds: need ${target} sats, have ${total} (selected ${selected.length} UTXOs)`,
    );
  }
  return { selected, total };
}

/**
 * Build, sign, and broadcast a tx with the given fixed outputs (the
 * caller already declared their exact ordering — recipient slot,
 * project fee, OP_RETURN — in `outputs`). The pipeline adds a single
 * change output to the user's own address AT THE END (matching
 * desktop's `drain_to(self)` semantics).
 *
 * Returns the broadcast result: `{ txid, fee_sats, vsize, payload }`.
 *
 * @param {Object} args
 * @param {Array<{type: 'address'|'opreturn'|'script', address?: string,
 *                value?: number|bigint, data?: Uint8Array, script?: Uint8Array}>}
 *        args.outputs   In-order outputs WITHOUT the change. Each entry
 *                       describes one vout.
 * @param {number} args.feeRateSatVb  Sat/vB rate. Caller falls through
 *                                    to getRecommendedFeeRate() if null.
 * @param {Array<{txid:string,vout:number}>} [args.mustInclude]  Outpoints
 *                                    the caller wants in the inputs (e.g.
 *                                    a specific chip for MINE).
 * @param {Array<{txid:string,vout:number}>} [args.unspendable]  Outpoints
 *                                    to NEVER select (token UTXOs).
 * @param {Uint8Array} [args.opReturnBytes]  The OP_RETURN payload bytes
 *                                    (already encoded by payloads.js).
 *                                    Used to size the fee estimate.
 *                                    Caller still has to put the
 *                                    matching 'opreturn' entry in
 *                                    `outputs`.
 */
export async function buildAndBroadcast({
  outputs,
  feeRateSatVb,
  mustInclude,
  unspendable,
  opReturnBytes,
}) {
  const session = getSession(); // throws if locked
  const { address, privateKey, publicKey } = session;

  // 1) UTXOs at our address.
  const utxos = await getAddressUtxos(address);
  if (utxos.length === 0) {
    throw new Error(`no UTXOs at ${address} — fund the wallet first`);
  }

  // 2) Resolve must-include outpoints to full UTXO records.
  const utxoIndex = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
  const mustIncludeFull = (mustInclude || []).map((o) => {
    const u = utxoIndex.get(`${o.txid}:${o.vout}`);
    if (!u) {
      throw new Error(`mustInclude UTXO ${o.txid}:${o.vout} not found at our address`);
    }
    return u;
  });
  const excludeKeys = (unspendable || []).map((o) => `${o.txid}:${o.vout}`);

  // 3) Fixed output value sum (excluding change which we add later).
  const fixedOutValue = outputs.reduce((s, o) => s + Number(o.value || 0), 0);

  // 4) Fee rate.
  let satVb = Number(feeRateSatVb);
  if (!Number.isFinite(satVb) || satVb <= 0) {
    satVb = await getRecommendedFeeRate();
  }
  // Clamp lower bound so we never produce a sub-relay-fee tx (mempool
  // policy minimum is ~1 sat/vB).
  satVb = Math.max(1, satVb);

  // 5) Iterative coin-selection + fee refinement. Start by selecting
  //    enough for fixed outputs + a placeholder fee, then re-estimate
  //    once we know the actual input count (which determines vsize).
  //    Two passes suffice — input count only changes by 1-2 between
  //    passes, fee diff stays under one input's worth.
  let selected, total;
  let fee = 0;
  for (let pass = 0; pass < 3; pass++) {
    const target = fixedOutValue + fee + DUST_SATS; // +dust headroom for change
    ({ selected, total } = selectInputs({
      utxos,
      target,
      mustInclude: mustIncludeFull,
      excludeKeys,
    }));
    // Count outputs as in the final tx: caller's outputs + 1 change
    // output (P2WPKH).
    const p2wpkhCount =
      outputs.filter((o) => o.type === "address" && isP2wpkhAddress(o.address)).length + 1; // +1 change
    const p2trCount =
      outputs.filter((o) => o.type === "address" && isP2trAddress(o.address)).length;
    const vsize = estimateVsize({
      inputCount: selected.length,
      p2wpkhOutputs: p2wpkhCount,
      p2trOutputs: p2trCount,
      opReturnBytes: opReturnBytes ? opReturnBytes.length : 0,
    });
    const newFee = Math.ceil(vsize * satVb);
    if (newFee === fee) break;
    fee = newFee;
  }

  const change = total - fixedOutValue - fee;
  if (change < 0) {
    throw new Error(`insufficient funds after fee (${fee} sats)`);
  }
  // If change is below dust, drop it into the fee instead of producing
  // an unspendable output. This is exactly what bdk does internally.
  const changeOmitted = change > 0 && change < DUST_SATS;
  const finalFee = changeOmitted ? fee + change : fee;

  // 6) Build tx with @scure/btc-signer.
  //
  // allowUnknownOutputs MUST be true: every LUCKYPROTOCOL op carries
  // a manually-constructed OP_RETURN output (carrying the
  // `LUCKYPROTOCOL|...` payload), and @scure/btc-signer's OutScript
  // classifier treats raw OP_RETURN scripts as "unknown" — it only
  // whitelists the spendable script types (p2wpkh / p2tr / p2sh /
  // etc.). Without this flag, addOutput({script: opReturnBytes})
  // throws "Transaction/output: unknown output script type" at
  // construct time, blocking every DEPLOY / MINE / SEND broadcast.
  //
  // This is safe: the OP_RETURN script is built by makeOpReturnScript
  // below (0x6a + push-len + payload), and the payload itself is
  // pre-validated by payloads.js (ASCII gate + 80-byte cap). We're
  // not opening the gate for arbitrary user-supplied scripts.
  const NETWORK = btc.NETWORK; // mainnet
  const tx = new btc.Transaction({
    allowUnknownInputs: false,
    allowUnknownOutputs: true,
    disableScriptCheck: false,
  });

  // Our own scriptPubKey, used to mark each spent UTXO's prevout for
  // segwit sighash. P2WPKH(ourPubkey) yields the same script as our
  // address.
  const ourP2WPKH = btc.p2wpkh(publicKey, NETWORK);
  const ourScript = ourP2WPKH.script;

  for (const u of selected) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: ourScript,
        amount: BigInt(u.value),
      },
      // P2WPKH uses default SIGHASH_ALL.
    });
  }

  // Outputs IN ORDER. The caller wrote them in the order the OP_RETURN
  // payload expects (e.g. recipient at vout 0, OP_RETURN at vout 1,
  // change at vout 2 for SEND).
  for (const o of outputs) {
    if (o.type === "address") {
      tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
    } else if (o.type === "opreturn") {
      // @scure/btc-signer doesn't have a single-call OP_RETURN helper;
      // build the script manually: <OP_RETURN> <push-byte-len> <data>.
      // For payloads ≤ 75 bytes the push opcode IS the length (direct
      // push). 76-80 bytes uses OP_PUSHDATA1.
      tx.addOutput({
        script: makeOpReturnScript(o.data),
        amount: 0n,
      });
    } else if (o.type === "script") {
      tx.addOutput({
        script: o.script,
        amount: BigInt(o.value || 0),
      });
    } else {
      throw new Error(`unknown output type: ${o.type}`);
    }
  }

  // Change output last (drain to self), only if non-dust.
  if (!changeOmitted && change > 0) {
    tx.addOutputAddress(address, BigInt(change), NETWORK);
  }

  // 7) Sign every input with the session's privkey.
  tx.sign(privateKey);
  tx.finalize();

  // 8) Serialize + broadcast.
  const rawBytes = tx.extract();
  const rawHex = bytesToHex(rawBytes);
  const txid = await broadcastTx(rawHex);

  return {
    txid,
    fee_sats: finalFee,
    vsize: tx.vsize,
    change_omitted: changeOmitted,
  };
}

// ---- Helpers --------------------------------------------------------------

function isP2wpkhAddress(addr) {
  return typeof addr === "string" && addr.startsWith("bc1q") && addr.length === 42;
}
function isP2trAddress(addr) {
  return typeof addr === "string" && addr.startsWith("bc1p") && addr.length === 62;
}

function makeOpReturnScript(data) {
  if (!(data instanceof Uint8Array)) {
    throw new Error("OP_RETURN data must be a Uint8Array");
  }
  if (data.length > 80) {
    throw new Error(`OP_RETURN data length ${data.length} > 80 (standardness)`);
  }
  if (data.length <= 75) {
    // OP_RETURN(0x6a) + direct push(len) + data
    const out = new Uint8Array(2 + data.length);
    out[0] = 0x6a;
    out[1] = data.length;
    out.set(data, 2);
    return out;
  }
  // OP_RETURN(0x6a) + OP_PUSHDATA1(0x4c) + len + data
  const out = new Uint8Array(3 + data.length);
  out[0] = 0x6a;
  out[1] = 0x4c;
  out[2] = data.length;
  out.set(data, 3);
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
