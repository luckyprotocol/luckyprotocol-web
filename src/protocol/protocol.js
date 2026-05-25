// LUCKYPROTOCOL on-chain protocol IPC layer.
// Three operations:
// - publishBet({tier, pick, ticker, password}) → broadcasts a tx with an
// OP_RETURN output containing the bet payload (LUCKYPROTOCOL|tier|pick|ticker|win_out_idx).
// - getTxStatus(txid) → polls the Esplora server for confirmation
// status; once `confirmed=true`, the `block_hash` field decides win/miss
// via the same isHit() logic used by the in-jsx mock settle.
// - publishTransfer({ticker, amount, toAddress, password}) → builds an
// OP_RETURN XFER tx; indexer credits/debits balances on confirmation.
// - publishDeploy({ticker, supply, password}) → registers a new ticker.
// Esplora endpoint selection (Alchemy first / mempool.space fallback) is
// handled inside the Rust backend. The Alchemy API key lives in the
// app's data dir (managed via cmd_get_alchemy_key / cmd_set_alchemy_key);
// the JS layer no longer needs to forward it on every invoke.
// The bet's "stake" in this iteration is just the network fee — there's no
// on-chain escrow / payout (Bitcoin lacks the smart-contract primitives).
// Reward bookkeeping stays local; future iterations can add a centralized
// or covenant-backed payout layer.

// Web build: all `invoke()` calls have been replaced with direct
// browser-native implementations under `src/tx-web/` and
// `src/chain-web/`. The desktop `inTauri()` gate is gone — every
// function below is now a pure JS path.

import * as txWeb from "../tx-web/index.js";
// chainWeb is no longer a separate module — its surface lives in
// chain.js + global_indexer.js. We import the three functions we
// actually use (status / block-hash-by-height / block-info-by-height)
// and synthesize the namespace-import shape for the call sites below.
import {
  getTxStatus as chainWebGetTxStatus,
  getBlockHashAt as chainWebGetBlockHashAt,
  getBlockInfoAt as chainWebGetBlockInfoAt,
} from "./chain.js";
const chainWeb = {
  fetchTxStatus:    (txid)    => chainWebGetTxStatus(txid).then((r) => r),
  fetchBlockHashAt: (height)  => chainWebGetBlockHashAt(height),
  fetchBlockInfoAt: (height)  => chainWebGetBlockInfoAt(height),
};
import { changePassword as walletWebChangePassword } from "../wallet-web/index.js";

/**
 * @param {object} params
 * @param {"iron"|"bronze"|"silver"|"gold"} params.tier
 * @param {string} params.pick e.g. "odd", "7", "7f", "7af" — the user's pick for the round
 * @param {string} params.ticker e.g. "HEXM" — protocol token to be credited on WIN
 * @param {string} params.password
 * @param {string} [params.network] default "bitcoin"
 * @param {number|null} [params.feeRateSatVb] override fee rate
 * @returns {Promise<{txid, payload, tier, pick, ticker, fee_sats, vsize, network}>}
 */
export const publishBet = async ({
  tier, pick, ticker, password: _pw, network = "bitcoin", feeRateSatVb = null,
  inputOutpoint = null,
  unspendableOutpoints = [],
}) => {
  // `password` ignored in web build — session is unlocked at the
  // wallet-web layer; the in-memory privkey is already cached.
  return await txWeb.publishBet({
    tier,
    pick,
    ticker,
    network,
    feeRateSatVb,
    inputOutpoint,
    unspendableOutpoints,
  });
};

/**
 * @param {string} txid
 * @param {string} [network]
 * @returns {Promise<{txid, confirmed, block_height, block_hash, block_time, fetched_at}>}
 */
export const getTxStatus = async (txid, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  // Direct fetch against Esplora `/tx/:txid/status`. Match the shape
  // the desktop's cmd_get_tx_status returned: { txid, confirmed,
  // block_height, block_hash, block_time, fetched_at }.
  // 404 means "tx not yet seen by indexer" — return unconfirmed view
  // rather than throwing.
  try {
    const data = await chainWeb.fetchTxStatus(txid);
    return {
      txid,
      confirmed: !!data.confirmed,
      block_height: data.block_height ?? null,
      block_hash: data.block_hash ?? null,
      block_time: data.block_time ?? null,
      fetched_at: Math.floor(Date.now() / 1000),
    };
  } catch (e) {
    // Treat 404 as "not yet seen" — useful for fresh broadcasts where
    // Esplora's /tx/.../status returns 404 for ~30s after the tx
    // enters mempool.
    if (/HTTP 404/.test(String(e?.message))) {
      return {
        txid,
        confirmed: false,
        block_height: null,
        block_hash: null,
        block_time: null,
        fetched_at: Math.floor(Date.now() / 1000),
      };
    }
    throw e;
  }
};

/**
 * V2 BET settlement helper — fetch a block's hash by height. Returns null
 * if the height is past the current tip (block not yet mined). Callers
 * should poll until a non-null hash appears.
 * @param {number} height
 * @param {string} [network]
 * @returns {Promise<string|null>}
 */
export const getBlockHashAt = async (height, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  try {
    return await chainWeb.fetchBlockHashAt(height);
  } catch (e) {
    // 404 = block not yet mined.
    if (/HTTP 404/.test(String(e?.message))) return null;
    throw e;
  }
};

/**
 * ALMANAC helper — fetch a block's hash AND UNIX timestamp by height.
 * `time` is seconds-since-epoch (Esplora's `timestamp` field). Returns
 * null if the height is past the current tip.
 * @param {number} height
 * @param {string} [network]
 * @returns {Promise<{hash: string, time: number}|null>}
 */
export const getBlockInfoAt = async (height, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  try {
    return await chainWeb.fetchBlockInfoAt(height);
  } catch (e) {
    if (/HTTP 404/.test(String(e?.message))) return null;
    throw e;
  }
};

/**
 * Broadcast a LUCKYPROTOCOL SEND tx — moves N smallest units of `ticker` from
 * the signing wallet's address to `toAddress`. The tx itself is just an
 * OP_RETURN + change output; the actual debit/credit happens in the
 * indexer when the tx confirms.
 * @returns {Promise<{txid, payload, ticker, amount, to_address, fee_sats, vsize, network}>}
 */
export const publishTransfer = async ({
  ticker, amount, toAddress, password: _pw, network = "bitcoin", feeRateSatVb = null,
  inputOutpoints = [],
  unspendableOutpoints = [],
}) => {
  // The desktop's `inputOutpoints` came as `[[txid, vout], ...]` tuples
  // (Rust's `Vec<(String, u32)>` shape). Normalize to `[{txid, vout}, ...]`
  // for tx-web. We accept both shapes for backwards compat with any
  // caller that still uses the tuple form.
  const normalize = (arr) =>
    (arr || []).map((o) => Array.isArray(o) ? { txid: o[0], vout: o[1] } : o);
  return await txWeb.publishTransfer({
    ticker,
    amount,
    toAddress,
    network,
    feeRateSatVb,
    inputOutpoints: normalize(inputOutpoints),
    unspendableOutpoints: normalize(unspendableOutpoints),
  });
};

/**
 * Register a new LUCKYPROTOCOL token on-chain. Payload `LUCKYPROTOCOL|DEPLOY|ticker`.
 * First-write-wins per ticker; later DEPLOYs for the same ticker are no-op.
 * @param {object} params
 * @param {string} params.ticker 1-8 [A-Z0-9]
 * @param {number} params.supply smallest-units max supply (cap)
 * @param {string} params.password
 * @param {string} [params.network]
 * @param {number|null} [params.feeRateSatVb]
 * @param {Array<{txid:string,vout:number}>} [params.unspendableOutpoints]
 *   PROTOCOL.md §13.1 — every token-bearing UTXO in the wallet. DEPLOY
 *   doesn't preserve residual (§7.4), so any token UTXO accidentally
 *   pulled in as fee funding gets BURNED.
 * @returns {Promise<{txid, payload, ticker, supply, fee_sats, vsize, network}>}
 */
export const publishDeploy = async ({
  ticker, supply, password: _pw, network = "bitcoin", feeRateSatVb = null,
  unspendableOutpoints = [],
}) => {
  // `supply` is unused — LUCKYPROTOCOL hardcodes 21,000,000 token supply
  // per ticker (see indexer's REQUIRED_TOKEN_SUPPLY). Kept in the
  // signature for desktop-API compatibility.
  void supply;
  const result = await txWeb.publishDeploy({
    ticker,
    network,
    feeRateSatVb,
    unspendableOutpoints,
  });
  return { ...result, supply: 21_000_000 };
};

/**
 * Atomically re-encrypt the wallet under a new password. Verifies the
 * old password by attempting a decrypt; on success writes a fresh V2
 * wallet file with new salt/nonce/HMAC. Replaces the prior "wipe and
 * re-import mnemonic" UX.
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{network, address, created_at}>}
 */
export const changePassword = async (oldPassword, newPassword) => {
  // Re-encrypts the IndexedDB wallet blob under a new Argon2id-
  // derived key. See wallet-web/index.js for the details.
  await walletWebChangePassword(oldPassword, newPassword);
  // Match the desktop return shape so React state doesn't need a
  // separate code path. The caller doesn't use these fields today,
  // but a future "password rotation summary" UI might.
  return { ok: true };
};

/**
 * Settlement tail — last K hex chars of the confirming block's hash
 * (lowercase). Mirror of `settlement_tail` in
 * luckyprotocol-indexer/src/protocol.rs. Returns "" if the input is missing
 * or shorter than K.
 */
export const settlementTail = (hashN, k) => {
  if (!hashN) return "";
  const h = hashN.toLowerCase();
  if (h.length < k) return "";
  return h.slice(h.length - k);
};

/**
 * isHit / computeBetOutcome — outcome decided by `settlementTail(hashN, K)`
 * where K depends on tier (iron/bronze=1, silver=2, gold=3). Mirrors
 * `is_hit` in luckyprotocol-indexer/src/protocol.rs.
 * @param {string} tier
 * @param {string} pick
 * @param {string} hashN confirming block's hash (hex)
 * @returns {{win: boolean, target?: string, die?: number} | null}
 */
export const computeBetOutcome = (tier, pick, hashN) => {
  if (!hashN) return null;
  if (tier === "iron") {
    const tail = settlementTail(hashN, 1);
    if (!tail) return null;
    const die = (parseInt(tail, 16) % 6) + 1;
    if (pick === "odd")  return { win: die % 2 === 1, die };
    if (pick === "even") return { win: die % 2 === 0, die };
    return { win: false, die };
  }
  if (tier === "bronze") {
    const tail = settlementTail(hashN, 1);
    if (!tail) return null;
    return { win: pick.toLowerCase() === tail, target: tail };
  }
  if (tier === "silver") {
    const tail = settlementTail(hashN, 2);
    if (!tail) return null;
    return { win: pick.toLowerCase() === tail, target: tail };
  }
  if (tier === "gold") {
    const tail = settlementTail(hashN, 3);
    if (!tail) return null;
    return { win: pick.toLowerCase() === tail, target: tail };
  }
  return null;
};
