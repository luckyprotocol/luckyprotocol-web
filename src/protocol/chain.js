// Frontend chain IPC layer.
// Routes UTXO sync through Tauri's `cmd_sync_address` (which hits
// either Alchemy's Bitcoin Esplora API — when the user has configured
// an Alchemy key — or mempool.space's public Esplora as fallback).
// As of the audit (), the Alchemy key lives in the Rust app_data_dir,
// NOT in the WebView's localStorage. The JS layer no longer needs to
// pass it on every invoke; the backend reads it from disk per-call.
// The Settings UI uses cmd_get_alchemy_key / cmd_set_alchemy_key to
// read/update it.
// When the app is loaded outside Tauri (Vite-only browser preview), these
// throw a clear error — there's no in-browser chain backend.

import { invoke } from "../tauri-shim.js";
import {
  getAddressUtxos as espGetAddressUtxos,
  getTipHeight as espGetTipHeight,
  getAddressTxs as espGetAddressTxs,
  extractLuckyprotocolPayload,
} from "../chain-web/esplora.js";

const inTauri = () =>
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/**
 * Hit the Esplora server for a single address. Returns:
 * {
 * address,
 * network,
 * utxos: [{ txid, vout, sats, confirmed, block_height }],
 * balance_confirmed_sats,
 * balance_pending_sats,
 * tip_height,
 * fetched_at
 * }
 */
export const syncAddress = async (address, network = "bitcoin") => {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  // Web build: two parallel Esplora hits — UTXO list + tip height.
  // Esplora's UTXO endpoint is the SOURCE OF TRUTH for what we hold;
  // the desktop wallet had to layer a bdk cache on top to bridge the
  // post-broadcast propagation window, but the web build doesn't sign
  // its own txs in some background process — every tx we broadcast,
  // we broadcast HERE in the browser, so we can locally remember
  // recent broadcasts if needed (deferred until we observe lag).
  const [utxosRaw, tipHeight] = await Promise.all([
    espGetAddressUtxos(address),
    espGetTipHeight(),
  ]);

  // Translate Esplora's wire shape ({ txid, vout, value, status }) to
  // the desktop API shape that hydrateWalletFromChain expects
  // ({ txid, vout, sats, confirmed, block_height }).
  let confirmedTotal = 0;
  let pendingTotal = 0;
  const utxos = utxosRaw.map((u) => {
    const confirmed = !!u.status?.confirmed;
    const value = Number(u.value) || 0;
    if (confirmed) confirmedTotal += value;
    else pendingTotal += value;
    return {
      txid: u.txid,
      vout: u.vout,
      sats: value,
      confirmed,
      block_height: u.status?.block_height ?? null,
    };
  });

  return {
    address,
    network,
    utxos,
    balance_confirmed_sats: confirmedTotal,
    balance_pending_sats: pendingTotal,
    tip_height: tipHeight,
    fetched_at: Math.floor(Date.now() / 1000),
  };
};

/**
 * Cached snapshot of the last successful sync_address call. Returns null
 * if no sync has happened this session. Cheap — purely in-memory read on
 * the Rust side, no HTTP.
 */
export const getChainState = async () => {
  if (!inTauri()) return null;
  return await invoke("cmd_get_chain_state");
};

/**
 * Fetch the most recent (≤25) transactions involving `address` from
 * Esplora. Each entry is parsed Rust-side into a {direction, sent,
 * received, fee, luckyprotocol_payload,...} view tailored for the
 * TRANSACTIONS screen.
 * Returns:
 * [{ txid, confirmed, block_height, block_time,
 * sent_sats, received_sats, net_sats, fee_sats,
 * direction: "incoming"|"outgoing"|"self",
 * luckyprotocol_payload: string|null }]
 */
export const listAddressTxs = async (address, network = "bitcoin") => {
  if (network !== "bitcoin") {
    throw new Error("LUCKYPROTOCOL is mainnet-only");
  }
  // Esplora returns the 25 most recent txs touching this address,
  // mempool first then chain-tip first. We translate to the desktop
  // API shape that the TRANSACTIONS screen expects.
  const txs = await espGetAddressTxs(address);
  return txs.map((tx) => txToView(tx, address));
};

/**
 * Translate one Esplora tx record to the desktop TxView shape. Mirrors
 * chain.rs's `to_tx_view` semantics:
 *   * sent_sats = sum of vin.prevout.value where prevout.address === ours
 *   * received_sats = sum of vout.value where vout.address === ours
 *   * direction:  outgoing if sent > 0 && received == 0
 *                 incoming if sent == 0 && received > 0
 *                 self     otherwise (both > 0 — change-spend pattern)
 *   * fee_sats = sum(vin.prevout.value) - sum(vout.value)
 *   * luckyprotocol_payload = extracted from any LUCKYPROTOCOL OP_RETURN
 *
 * The TRANSACTIONS screen sorts on block_height (NOT block_time, which
 * isn't strictly monotonic in Bitcoin) — we pass it through verbatim.
 */
function txToView(tx, ourAddress) {
  let sent = 0;
  let received = 0;
  let inputTotal = 0;
  let outputTotal = 0;

  for (const v of tx.vin || []) {
    const val = Number(v.prevout?.value) || 0;
    inputTotal += val;
    if (v.prevout?.scriptpubkey_address === ourAddress) {
      sent += val;
    }
  }
  for (const o of tx.vout || []) {
    const val = Number(o.value) || 0;
    outputTotal += val;
    if (o.scriptpubkey_address === ourAddress) {
      received += val;
    }
  }
  const fee = Math.max(0, inputTotal - outputTotal);

  let direction;
  if (sent > 0 && received > 0) direction = "self";
  else if (sent > 0)             direction = "outgoing";
  else if (received > 0)         direction = "incoming";
  else                            direction = "self"; // shouldn't happen — Esplora wouldn't return it

  return {
    txid: tx.txid,
    confirmed: !!tx.status?.confirmed,
    block_height: tx.status?.block_height ?? null,
    block_time: tx.status?.block_time ?? null,
    block_hash: tx.status?.block_hash ?? null,
    sent_sats: sent,
    received_sats: received,
    net_sats: received - sent,
    fee_sats: fee,
    direction,
    luckyprotocol_payload: extractLuckyprotocolPayload(tx),
  };
}

// localStorage key for the persisted Alchemy API key. The desktop
// build stored it in Rust's app_data_dir; the web build keeps it in
// LS since browsers can't write arbitrary files. Key name kept
// distinct from the legacy `luckyprotocol.alchemy_key.v1` so we
// can do a one-shot migration if needed.
const LS_ALCHEMY_KEY = "luckyprotocol.alchemy_key.v2";

/**
 * Read the user's stored Alchemy API key. Web: from localStorage.
 * Desktop: from Rust app_data_dir via IPC. Returns null when no key
 * is configured. Used by Settings to prefill the input + by
 * chain-web/esplora.js to prepend the Alchemy base URL to the
 * endpoint failover chain.
 */
export const getAlchemyKey = async () => {
  if (inTauri()) return await invoke("cmd_get_alchemy_key");
  try {
    const v = window.localStorage.getItem(LS_ALCHEMY_KEY);
    return v && v.length > 0 ? v : null;
  } catch { return null; }
};

/**
 * Persist the user's Alchemy API key (or clear it by passing null /
 * empty string). Web: localStorage write. Desktop: atomic Rust file
 * write. After persisting, callers should also update the sync
 * mirror via setAlchemyKeySync so chain-web's request pipeline
 * picks the new key up without an app restart.
 */
export const setAlchemyKey = async (key) => {
  if (inTauri()) return await invoke("cmd_set_alchemy_key", { key: key || null });
  try {
    if (key && String(key).trim()) {
      window.localStorage.setItem(LS_ALCHEMY_KEY, String(key).trim());
    } else {
      window.localStorage.removeItem(LS_ALCHEMY_KEY);
    }
  } catch { /* LS unavailable — silent; sync mirror still updates */ }
};

// ---- Synchronous Alchemy-key cache ---------------------------------------
// The persistent store lives in Rust (desktop) or localStorage (web);
// fetching is async. For hot-path callers (fee fetch, tip fetch, the
// browser indexer's HTTP pipeline) we keep a sync mirror updated by
// App boot + by Settings save. Exposed as helpers so LuckyProtocolApp
// .jsx can write it whenever its own __alchemyKeyCache changes.
//
// On the web build, every sync setter ALSO forwards the key into
// chain-web/esplora.js's `_alchemyKeyCache` via `setEsploraAlchemyKey`,
// which is what makes the indexer's HTTP failover chain actually
// USE the Alchemy endpoint. Without this forward the key would be
// stored but never consulted by the request path.
import { setEsploraAlchemyKey } from "../chain-web/esplora.js";
let _alchemyKeySync = null;
/** Sync getter — null when no Alchemy key is configured. */
export const getAlchemyKeySync = () => _alchemyKeySync;
/** Sync setter — keeps the chain.js cache + chain-web fetch pipeline
 *  in lockstep with the App-level cache. */
export const setAlchemyKeySync = (key) => {
  _alchemyKeySync = (key && String(key).trim()) || null;
  setEsploraAlchemyKey(_alchemyKeySync);
};
/**
 * Compose the Alchemy BTC RPC base URL, e.g.
 * "https://bitcoin-mainnet.g.alchemy.com/v2/<KEY>". Returns null when
 * no key is cached. Path appended by callers (e.g. `${base}/blocks/tip/height`).
 */
export const getAlchemyEsploraBase = () => {
  const k = _alchemyKeySync;
  return k ? `https://bitcoin-mainnet.g.alchemy.com/v2/${k}` : null;
};

// Fee-rate endpoint chain. mempool.space is the ONLY public source we
// can use here:
// - blockstream.info doesn't expose /v1/fees/recommended (404)
// - Alchemy's BTC RPC also doesn't expose it AND blocks CORS for the
// bare Esplora path, so even attempting it surfaces a CORS console
// error every time
// So when mempool.space is unreachable we fall through to a cached
// last-known sample (in-memory, this session), then to a conservative
// static default. The user can always type a fee rate manually.
const MEMPOOL_FEE_URL = "https://mempool.space/api/v1/fees/recommended";

// Conservative default fees in sat/vB. Used only when mempool.space is
// unreachable AND no prior sample is cached. Picked to be high enough
// that a fastestFee tx still confirms within ~10 min during typical
// mempool conditions, and low enough to not waste fees during quiet
// periods. The user can override via the FEE input box anyway.
const FALLBACK_FEES = {
  fastestFee: 8,
  halfHourFee: 5,
  hourFee: 3,
  economyFee: 2,
  minimumFee: 1,
  _fallback: true,  // marker so the UI can show a "(fallback)" hint
};

// Last successful sample, kept module-scoped so a failed FETCH LIVE
// can fall through to the most recent value rather than the static
// default. Cleared on app restart.
let _lastFeeSample = null;

/**
 * Fetch live fee buckets. Used by SettingsScreen → MINING FEE RATE →
 * "FETCH LIVE". Hits mempool.space; on any failure falls through to
 * the last-known sample then to a conservative static default. Never
 * throws.
 * Returns:
 * { fastestFee, halfHourFee, hourFee, economyFee, minimumFee,
 * _stale?: bool, _ageSec?: number,
 * _fallback?: bool }
 */
export async function fetchRecommendedFees(_network = "bitcoin") {
  try {
    const resp = await fetch(MEMPOOL_FEE_URL, {
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

// =============================================================================
// NEXT-BLOCK FEE PROFILE — /api/v1/fees/mempool-blocks[0]
// =============================================================================
// /v1/fees/recommended only returns integer sat/vB buckets, which loses
// precision for the live "what's the floor of block #1 right now" view —
// during quiet mempool periods the actual minimum fee can sit somewhere
// between 1.00 and 2.00 sat/vB and the recommended endpoint clamps both
// to "1". The mempool-blocks endpoint returns the projected upcoming
// blocks each with a `feeRange` array (lowest → highest fee rates
// currently in that block) and a `medianFee`, all as floats. We pull
// block[0] = next unconfirmed block.
//: TopStatsBar's MIN FEE RATE tile shows
// block[0].feeRange[0] formatted to 2 decimals — the actual lowest-fee
// tx that's about to be mined.
// =============================================================================
const MEMPOOL_BLOCKS_URL = "https://mempool.space/api/v1/fees/mempool-blocks";

let _lastNextBlockSample = null;

/**
 * Fetch the next-unconfirmed-block fee profile. Returns:
 * { minFee, medianFee, maxFee, nTx,
 * _stale?: bool, _ageSec?: number,
 * _fallback?: bool }
 * minFee = first element of the next block's feeRange (the lowest
 * sat/vB rate currently sitting in block #1). Floating-point —
 * caller should `.toFixed(2)` for display.
 * Never throws. Falls through to last-known sample → static default.
 */
export async function fetchNextBlockFee(_network = "bitcoin") {
  try {
    const resp = await fetch(MEMPOOL_BLOCKS_URL, {
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
