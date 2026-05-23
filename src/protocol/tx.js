// Frontend transaction IPC layer.
// Two commands exposed today: send a single-recipient transaction and
// split a UTXO into many. All signing happens in the Rust backend
// (mnemonic decrypted with the user's password, BIP84 keys derived
// locally, PSBT signed with bdk_wallet, raw tx broadcast via Esplora —
// Alchemy first when configured, mempool.space fallback).
// Esplora endpoint selection is owned by the Rust backend; the
// Alchemy API key is stored in the app's data dir and
// the backend reads it per-call. JS no longer forwards alchemyKey on
// every invoke.
// Returns:
// { txid, fee_sats, vsize, raw_hex, network }
// so the UI can show a confirmation toast + a clickable mempool link.

// Web build: BTC tx ops are constructed locally with @scure/btc-signer
// and broadcast directly to mempool.space. See src/tx-web/.

import * as txWeb from "../tx-web/index.js";

/**
 * Build, sign, and broadcast a single-recipient transaction. Throws on:
 * - wrong password (cipher decrypt fails)
 * - dust output (< 546 sat)
 * - insufficient funds (TxBuilder fails coin selection)
 * - network mismatch (LUCKYPROTOCOL is mainnet-only; non-bc1 addresses rejected)
 * - Esplora broadcast rejection (e.g., already-spent input)
 * @param {object} params
 * @param {string} params.toAddress bech32 destination address
 * @param {number} params.amountSats integer sats to send
 * @param {string} params.password user's wallet password
 * @param {string} [params.network] "bitcoin" (mainnet only)
 * @param {number} [params.feeRateSatVb] override fee rate; default 5 sat/vB
 * @returns {Promise<{txid, fee_sats, vsize, raw_hex, network}>}
 */
export const sendToAddress = async ({
  toAddress,
  amountSats,
  password: _pw,
  network = "bitcoin",
  feeRateSatVb = null,
}) => {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  return await txWeb.sendToAddress({ toAddress, amountSats, feeRateSatVb });
};

/**
 * Split a chunk of BTC into N self-paying outputs. Used by the WALLET
 * screen's "create chips" flow — turns one big confirmed UTXO into
 * `count` smaller UTXOs of `amountSats` each, all back to the wallet's
 * first BIP84 receive address.
 * Same return shape as sendToAddress so the toast + mempool deep-link
 * code path is shared.
 * @param {object} params
 * @param {number} params.count 1..=200 — number of split outputs
 * @param {number} params.amountSats sats per output (>= 546 dust limit)
 * @param {string} params.password
 * @param {string} [params.network] "bitcoin" (default)
 * @param {number|null} [params.feeRateSatVb]
 * @returns {Promise<{txid, fee_sats, vsize, raw_hex, network}>}
 */
export const splitUtxo = async ({
  count,
  amountSats,
  password: _pw,
  network = "bitcoin",
  feeRateSatVb = null,
}) => {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  // Honor the caller's chosen chip size. Chip = BTC UTXO that funds a
  // future MINE / SEND fee; its size affects only how many sats are
  // burned on chain when that chip is consumed. NOT a protocol
  // constant — earlier we hard-coded DUST_SATS here and the user
  // saw every chip come out at 546 sats no matter what they typed
  // into the WALLET → SPLIT panel. Now passed through.
  return await txWeb.splitUtxo({
    chipCount: count,
    chipSatsEach: amountSats,
    feeRateSatVb,
  });
};
