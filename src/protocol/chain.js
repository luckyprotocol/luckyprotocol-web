// Frontend chain layer — thin glue around the official LUCKYPROTOCOL
// indexer (for everything chain-state-derived) plus mempool.space (for
// the two things the indexer doesn't serve: fee rates and tx broadcast).
//
// Why the split:
//   * Indexer (https://luckyprotocolai.com): zero-trust path. The team
//     runs Bitcoin Core + this indexer; users query derived state from
//     a server they can verify against the spec. Token balances, BTC
//     UTXOs (for wallet display + fee funding), tx-confirmation status,
//     and block-by-height all flow through here.
//   * mempool.space: censorship-resistant broadcast + live fee rates.
//     Broadcasting a signed tx to mempool.space gossips it to the
//     whole network within seconds — even a malicious indexer can't
//     suppress that. Fee rates come from mempool.space because the
//     indexer doesn't expose them (the node has the data, but we'd
//     rather offload a free public endpoint than wire it through).
//
// What used to live here:
//   * listAddressTxs / txToView — BTC tx history view. Removed:
//     wallet history now only shows LUCKYPROTOCOL bets and transfers
//     (via the indexer's /bets/:addr + /transfers/:addr endpoints).
//     Generic BTC tx history added noise and pulled users into the
//     "is this a token op or just a transfer?" mental model — we'd
//     rather keep the wallet focused on protocol events.
//   * getAlchemyKey / setAlchemyKey / *Sync — Alchemy is no longer
//     part of the chain pipeline at all. The Esplora multi-source
//     fallback was removed when chain-web/ was deleted.
//   * getChainState — Tauri-era cached snapshot; nothing to mirror
//     in the web build.

import {
  fetchGlobalBtcUtxos,
  fetchGlobalTxStatus,
  fetchGlobalBlockHash,
  fetchGlobalBlockInfo,
  pingGlobalIndexer,
} from "./global_indexer.js";

const inTauri = () =>
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// ---- BTC wallet sync ----------------------------------------------------

/**
 * One-shot sync of an address. Pulls raw BTC UTXOs from the official
 * indexer + the chain tip from the same `/` health payload, builds the
 * shape `hydrateWalletFromChain` consumes:
 *   {
 *     address,
 *     network,
 *     utxos: [{ txid, vout, sats, confirmed, block_height }],
 *     balance_confirmed_sats,
 *     balance_pending_sats,
 *     tip_height,
 *     fetched_at,
 *   }
 *
 * Both fetches issue in parallel — saves ~one HTTP RTT per sync.
 */
export const syncAddress = async (address, network = "bitcoin") => {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  const [utxos, health] = await Promise.all([
    fetchGlobalBtcUtxos(address),
    pingGlobalIndexer(),
  ]);

  let confirmedTotal = 0;
  let pendingTotal = 0;
  for (const u of utxos) {
    if (u.confirmed) confirmedTotal += Number(u.sats) || 0;
    else             pendingTotal   += Number(u.sats) || 0;
  }

  return {
    address,
    network,
    utxos,
    balance_confirmed_sats: confirmedTotal,
    balance_pending_sats: pendingTotal,
    tip_height: Number(health?.tip_height) || 0,
    fetched_at: Math.floor(Date.now() / 1000),
  };
};

/**
 * `getAddressUtxos(address)` — back-compat shim for tx-web/build.js.
 * Pre-refactor this was an Esplora call; now it's a wrapper around the
 * indexer's `/btc-utxos/:addr` that re-shapes the result into the
 * Esplora-flavored `{ txid, vout, value, status: {confirmed, block_height} }`
 * objects the coin-selection code expects. Keeping the wrapper instead
 * of rewriting tx-web because tx-web's shape conventions are stable +
 * tested, and translating once is cheaper than changing 5+ callsites.
 */
export const getAddressUtxos = async (address) => {
  const utxos = await fetchGlobalBtcUtxos(address);
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: Number(u.sats) || 0,
    status: {
      confirmed:    !!u.confirmed,
      block_height: u.block_height ?? null,
    },
  }));
};

// ---- mempool.space helpers — fee rates + tx broadcast --------------------
//
// The ONLY things in the chain pipeline that don't route through the
// official indexer. Both are deliberate choices:
//   * Fee rates: mempool.space serves a great free `/v1/fees/...` API
//     and we don't need to authenticate. The indexer COULD proxy this
//     but doing so just adds latency + a moving part for no real gain
//     (fees aren't part of protocol consensus).
//   * Broadcast: posting raw tx hex to mempool.space gossips it to
//     the whole Bitcoin network within seconds. This means even a
//     malicious operator running the official indexer can't suppress
//     a user's tx — they can refuse to INDEX it, but they can't
//     stop it from being mined. That's the right censorship-
//     resistance property for a wallet.

const MEMPOOL_BASE = "https://mempool.space/api";

/**
 * `POST /api/tx` with raw hex body. Mempool.space returns the txid as
 * plain text on success, or a 4xx with an error message on failure.
 * Throws on non-2xx so callers can show the broadcast error to the
 * user (e.g. "tx-version flag" / "bad-txns-vout-empty" / etc.).
 */
export const broadcastTx = async (rawHex) => {
  if (!rawHex || typeof rawHex !== "string") {
    throw new Error("broadcastTx: rawHex must be a non-empty hex string");
  }
  const url = `${MEMPOOL_BASE}/tx`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: rawHex,
  });
  if (!resp.ok) {
    let body = "";
    try { body = (await resp.text()).slice(0, 280); } catch { /* ignore */ }
    throw new Error(`broadcast HTTP ${resp.status}${body ? `: ${body}` : ""}`);
  }
  return (await resp.text()).trim();
};

/**
 * Single-number convenience around `fetchRecommendedFees`. Returns the
 * `halfHourFee` bucket — fast enough that a tx usually confirms within
 * ~30 min during normal mempool load, slow enough to not waste fees
 * during quiet periods. Used by tx-web/build.js as the default when
 * the caller didn't pass an explicit `feeRateSatVb`.
 */
export const getRecommendedFeeRate = async () => {
  const fees = await fetchRecommendedFees();
  const v = Number(fees?.halfHourFee);
  return Number.isFinite(v) && v > 0 ? v : 5;
};

const FALLBACK_FEES = {
  fastestFee: 8,
  halfHourFee: 5,
  hourFee: 3,
  economyFee: 2,
  minimumFee: 1,
  _fallback: true,
};

let _lastFeeSample = null;

/**
 * Fee buckets from `mempool.space/api/v1/fees/recommended`. Never
 * throws — on network failure returns the last successful sample
 * (this session), or a conservative static default if nothing's
 * been fetched yet. UI can show `(fallback)` / `(stale)` hints
 * via the `_fallback` / `_stale` flags.
 */
export async function fetchRecommendedFees(_network = "bitcoin") {
  try {
    const resp = await fetch(`${MEMPOOL_BASE}/v1/fees/recommended`, {
      headers: { accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`fee rate HTTP ${resp.status}`);
    const fees = await resp.json();
    _lastFeeSample = { ...fees, _at: Date.now() };
    return fees;
  } catch (_e) {
    if (_lastFeeSample) {
      const ageS = Math.floor((Date.now() - _lastFeeSample._at) / 1000);
      return { ..._lastFeeSample, _stale: true, _ageSec: ageS };
    }
    return { ...FALLBACK_FEES };
  }
}

let _lastNextBlockSample = null;

/**
 * Live "next unconfirmed block" fee profile from mempool.space. Used by
 * TopStatsBar's MIN FEE RATE tile. Returns:
 *   { minFee, medianFee, maxFee, nTx, _stale?, _ageSec?, _fallback? }
 * minFee is a float — UI should `.toFixed(2)` for display. Never throws.
 */
export async function fetchNextBlockFee(_network = "bitcoin") {
  try {
    const resp = await fetch(`${MEMPOOL_BASE}/v1/fees/mempool-blocks`, {
      headers: { accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`mempool-blocks HTTP ${resp.status}`);
    const arr = await resp.json();
    const first = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!first || !Array.isArray(first.feeRange) || first.feeRange.length === 0) {
      throw new Error("mempool-blocks response shape unexpected");
    }
    const fr = first.feeRange.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (fr.length === 0) throw new Error("mempool-blocks feeRange empty");
    const out = {
      minFee:    fr[0],
      medianFee: Number(first.medianFee) || fr[Math.floor(fr.length / 2)],
      maxFee:    fr[fr.length - 1],
      nTx:       Number(first.nTx) || 0,
    };
    _lastNextBlockSample = { ...out, _at: Date.now() };
    return out;
  } catch (_e) {
    if (_lastNextBlockSample) {
      const ageS = Math.floor((Date.now() - _lastNextBlockSample._at) / 1000);
      return { ..._lastNextBlockSample, _stale: true, _ageSec: ageS };
    }
    return { minFee: 1, medianFee: 2, maxFee: 8, nTx: 0, _fallback: true };
  }
}

// ---- Indexer-served chain queries (re-exports for ergonomics) -----------
//
// These exist as thin wrappers in `protocol.js`, but importing them
// from `chain.js` keeps the older code paths working (the desktop's
// chain.rs exposed `getTxStatus` / `getBlockHashAt` / `getBlockInfoAt`
// as part of its `chain.js` surface). Wrappers translate the indexer's
// JSON envelope to the historical shape `{ txid, confirmed,
// block_height, block_hash, block_time, fetched_at }`.

/**
 * Confirmation status for one tx. Indexer returns:
 *   { txid, confirmed, block_height, block_hash, block_time }
 * We add `fetched_at` to match the desktop's wire shape.
 */
export const getTxStatus = async (txid, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  const env = await fetchGlobalTxStatus(txid);
  return {
    txid,
    confirmed:    !!env?.confirmed,
    block_height: env?.block_height ?? null,
    block_hash:   env?.block_hash   ?? null,
    block_time:   env?.block_time   ?? null,
    fetched_at:   Math.floor(Date.now() / 1000),
  };
};

/**
 * Block hash at `height`, or `null` if the block isn't mined yet.
 * Used by V2 BET settlement (the determining block's hash is what
 * resolves win/loss).
 */
export const getBlockHashAt = async (height, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  return await fetchGlobalBlockHash(height);
};

/**
 * Block hash + timestamp at `height`, used by ALMANAC's historical
 * timeline view. `time` is seconds-since-epoch (block header time).
 * Returns `null` if the block isn't mined.
 */
export const getBlockInfoAt = async (height, network = "bitcoin") => {
  if (network !== "bitcoin") throw new Error("LUCKYPROTOCOL is mainnet-only");
  return await fetchGlobalBlockInfo(height);
};

// inTauri kept exported for any legacy gate that still wants the
// desktop-vs-web distinction; the web build always returns false.
export { inTauri };
