// Public tx-construction API for the browser build.
//
// Function signatures mirror what the desktop `src/protocol/protocol.js`
// and `src/protocol/tx.js` modules export, so the React layer doesn't
// know whether it's calling Tauri Rust or browser-JS.
//
// Op layout reference (matches desktop tx.rs):
//
//   DEPLOY tx:
//     vout 0  →  546 sat dust to self        (proof-of-deploy UTXO)
//     vout 1  →  5460 sat to PROJECT_FEE_ADDRESS (DEPLOY_PROTOCOL_FEE_SATS)
//     vout 2  →  OP_RETURN "LUCKYPROTOCOL|DEPLOY|<ticker>"
//     vout 3+ →  change to self (drain)
//
//   MINE tx:
//     vout 0  →  546 sat dust to self        (win slot, win_out_idx=0)
//     vout 1  →  546 sat to PROJECT_FEE_ADDRESS (PROJECT_FEE_SATS)
//     vout 2  →  OP_RETURN "LUCKYPROTOCOL|<tier>|<pick>|<TICKER>|0|0"
//     vout 3+ →  change to self
//
//   SEND tx:
//     vout 0  →  546 sat dust to RECIPIENT    (token slot, to_out_idx=0)
//     vout 1  →  546 sat to PROJECT_FEE_ADDRESS (PROJECT_FEE_SATS — consensus
//                                                in cohort v950382+ so the
//                                                /address/PROJECT_FEE/txs
//                                                history covers DEPLOY+MINE
//                                                +SEND uniformly; see
//                                                fast_bootstrap.js)
//     vout 2  →  OP_RETURN "LUCKYPROTOCOL|SEND|<TICKER>|<amt>|0|3"
//     vout 3  →  change to self               (change_out_idx=3 — carries
//                                              BTC change + residual tokens)

import { buildAndBroadcast } from "./build.js";
import {
  buildDeployPayload,
  buildMinePayload,
  buildSendPayload,
  PROJECT_FEE_ADDRESS,
  PROJECT_FEE_SATS,
  DEPLOY_PROTOCOL_FEE_SATS,
  DUST_SATS,
} from "./payloads.js";
import { getSession } from "../wallet-web/session.js";
import { fetchGlobalUtxoBalances } from "../protocol/global_indexer.js";

/**
 * Auto-collected list of the wallet's currently-known token UTXOs.
 * Used as a default `unspendable` set for the pure-BTC paths
 * (sendToAddress / splitUtxo) so a routine BTC send never quietly
 * sweeps a token UTXO into its inputs — which would BURN the tokens
 * under the strict residual-routing rule (applyTx STEP 3).
 *
 * Hits the official indexer's `/utxos/:addr` over HTTPS — same data
 * the wallet already polls for the balance tile, just unwrapped to
 * the `{ txid, vout }` shape the coin-selector cares about. Returns
 * an empty array on any error (network fail, address not yet seen
 * by the indexer) — safe default: the coin selector will then treat
 * every UTXO as eligible for fee funding, which is the right thing
 * for an unfunded / unseen address.
 */
async function _autoTokenUnspendables(address) {
  try {
    const utxos = await fetchGlobalUtxoBalances(address);
    return (utxos || []).map((u) => ({ txid: u.txid, vout: u.vout }));
  } catch (_e) {
    return [];
  }
}

/**
 * Merge caller-supplied unspendable outpoints with the auto-collected
 * token set. De-duplicated by `txid:vout`. Caller's list wins (we
 * preserve any caller metadata on duplicates).
 */
function _mergeUnspendables(callerSupplied, autoCollected) {
  const out = new Map();
  for (const o of autoCollected) out.set(`${o.txid}:${o.vout}`, o);
  for (const o of (callerSupplied || [])) out.set(`${o.txid}:${o.vout}`, o);
  return Array.from(out.values());
}

/**
 * Publish a LUCKYPROTOCOL DEPLOY tx.
 * Returns `{ txid, fee_sats, vsize, network, ticker, payload }`.
 */
export async function publishDeploy({ ticker, network = "bitcoin", feeRateSatVb, unspendableOutpoints }) {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  const { address } = getSession(); // throws if locked

  const payload = buildDeployPayload(ticker);

  const result = await buildAndBroadcast({
    outputs: [
      { type: "address", address,                value: DUST_SATS },                 // vout 0
      { type: "address", address: PROJECT_FEE_ADDRESS, value: DEPLOY_PROTOCOL_FEE_SATS }, // vout 1
      { type: "opreturn", data: payload },                                          // vout 2
      // vout 3+ change appended by buildAndBroadcast
    ],
    feeRateSatVb,
    unspendable: unspendableOutpoints,
    opReturnBytes: payload,
  });

  return { ...result, network, ticker, payload: new TextDecoder().decode(payload) };
}

/**
 * Publish a LUCKYPROTOCOL MINE bet tx. v2 6-field payload (always emits
 * change_out_idx = win_out_idx = 0). `tier` ∈ {iron, bronze, silver, gold};
 * `pick` is the tier's grammar (odd/even or hex tail). `ticker` is the
 * mining target.
 *
 * `inputOutpoint` (optional) pins a specific UTXO as the bet's chip
 * input. `unspendableOutpoints` excludes any token-bearing UTXO from
 * coin selection (caller queries the indexer for these).
 */
export async function publishBet({
  tier,
  pick,
  ticker,
  network = "bitcoin",
  feeRateSatVb,
  inputOutpoint,
  unspendableOutpoints,
}) {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  const { address } = getSession();

  const payload = buildMinePayload({
    tier,
    pick: String(pick).toLowerCase(),
    ticker,
    winOutIdx: 0,
    changeOutIdx: 0,   // v2 — token residual lands at vout 0 alongside win
  });

  const result = await buildAndBroadcast({
    outputs: [
      { type: "address", address,                value: DUST_SATS },                  // vout 0 (win slot)
      { type: "address", address: PROJECT_FEE_ADDRESS, value: PROJECT_FEE_SATS },     // vout 1 (project fee)
      { type: "opreturn", data: payload },                                            // vout 2
      // vout 3+ change
    ],
    feeRateSatVb,
    mustInclude: inputOutpoint ? [inputOutpoint] : undefined,
    unspendable: unspendableOutpoints,
    opReturnBytes: payload,
  });

  return {
    ...result,
    network,
    ticker,
    tier,
    pick: String(pick).toLowerCase(),
    payload: new TextDecoder().decode(payload),
  };
}

/**
 * Publish a LUCKYPROTOCOL SEND (transfer) tx.
 * `amount` is in token-smallest-units. `inputOutpoints` (optional) pins
 * the token UTXOs to consume — caller passes ALL the user's token UTXOs
 * for the target ticker so the input pool covers the amount; greedy
 * minimum-UTXO selection is done at the caller layer in protocol.js
 * (mirrors desktop publish_transfer).
 */
export async function publishTransfer({
  ticker,
  amount,
  toAddress,
  network = "bitcoin",
  feeRateSatVb,
  inputOutpoints,
  unspendableOutpoints,
}) {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  if (typeof toAddress !== "string" || toAddress.length === 0) {
    throw new Error("toAddress is required");
  }
  getSession(); // ensure unlocked

  const payload = buildSendPayload({
    ticker,
    amount,
    toOutIdx: 0,
    changeOutIdx: 3,  // v950382+ — fee output bumped change_out_idx from 2 to 3
  });

  const result = await buildAndBroadcast({
    outputs: [
      { type: "address", address: toAddress,         value: DUST_SATS },        // vout 0 (recipient token slot)
      { type: "address", address: PROJECT_FEE_ADDRESS, value: PROJECT_FEE_SATS },// vout 1 (project fee — consensus-enforced)
      { type: "opreturn", data: payload },                                      // vout 2
      // vout 3 change-to-self (drain) appended automatically by buildAndBroadcast
    ],
    feeRateSatVb,
    mustInclude: inputOutpoints,           // token-carrying UTXOs first
    unspendable: unspendableOutpoints,     // other-ticker UTXOs blocked
    opReturnBytes: payload,
  });

  return {
    ...result,
    network,
    ticker,
    payload: new TextDecoder().decode(payload),
  };
}

/**
 * Plain BTC send — no OP_RETURN, no project fee, just user → toAddress.
 * Used by the WALLET screen's "send BTC" button.
 */
export async function sendToAddress({ toAddress, amountSats, feeRateSatVb, unspendableOutpoints }) {
  if (typeof toAddress !== "string" || toAddress.length === 0) {
    throw new Error("toAddress is required");
  }
  const amount = Number(amountSats);
  if (!Number.isInteger(amount) || amount < DUST_SATS) {
    throw new Error(`amountSats must be an integer >= ${DUST_SATS}`);
  }
  const { address } = getSession();

  // Auto-exclude every known token UTXO from coin selection. Without
  // this, a pure-BTC send can silently sweep a token UTXO into its
  // inputs and BURN the tokens (applyTx STEP 3 strict-burn rule).
  const merged = _mergeUnspendables(unspendableOutpoints, await _autoTokenUnspendables(address));

  const result = await buildAndBroadcast({
    outputs: [
      { type: "address", address: toAddress, value: amount }, // vout 0
      // vout 1 = change-to-self
    ],
    feeRateSatVb,
    unspendable: merged,
  });

  return { ...result };
}

/**
 * Split a single large BTC UTXO into many small "chips" so the user
 * can MINE individual chips without consuming an oversized UTXO.
 * Caller picks the chip size via `chipSatsEach`; we floor at
 * DUST_SATS=546 so no chip is below the BIP141 dust limit.
 *
 * Desktop version called Rust's `cmd_split_utxo`. Web version builds
 * a single tx with N+1 outputs (N chips + remainder change).
 */
export async function splitUtxo({ chipCount, chipSatsEach, feeRateSatVb, unspendableOutpoints }) {
  if (!Number.isInteger(chipCount) || chipCount < 1) {
    throw new Error("chipCount must be a positive integer");
  }
  // Honor caller's chip size, but never go below dust (BIP141 P2WPKH
  // floor — anything smaller would be rejected by relay policy and
  // we'd waste the whole tx's fee).
  const requested = Number(chipSatsEach);
  const chipValue =
    Number.isFinite(requested) && requested >= DUST_SATS
      ? Math.floor(requested)
      : DUST_SATS;
  const { address } = getSession();

  const outputs = [];
  for (let i = 0; i < chipCount; i++) {
    outputs.push({ type: "address", address, value: chipValue });
  }
  // Change goes at the end automatically.

  // Same safety as sendToAddress — auto-exclude token UTXOs. splitUtxo
  // is especially dangerous because it creates many DUST_SATS outputs
  // (which collide with token UTXOs in size), so a coin-selector that
  // grabs a token UTXO would mix it into the chip set and the user
  // loses tokens without any visible indicator.
  const merged = _mergeUnspendables(unspendableOutpoints, await _autoTokenUnspendables(address));

  const result = await buildAndBroadcast({
    outputs,
    feeRateSatVb,
    unspendable: merged,
  });
  return { ...result, chipCount };
}
