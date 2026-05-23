// IndexedDB persistence for the browser LUCKYPROTOCOL indexer.
//
// Why IDB and not localStorage:
//   - The indexer state is potentially MB-sized (utxoBalances scales
//     with the number of token-bearing UTXOs; a healthy chain has
//     thousands). localStorage's 5-10MB cap + synchronous-blocking-on-
//     main-thread API would freeze the UI during snapshot writes.
//   - IDB is async + key-blob friendly + has a ~50MB quota out of the
//     box (more on Chromium / Firefox under "persistent" storage).
//   - We serialize the entire snapshot as one blob — no schema
//     migrations needed for in-snapshot field additions; bump
//     SCHEMA_VERSION + cold-rescan on mismatch.
//
// Storage layout (DB: luckyprotocol_indexer, store: snapshots):
//   key "primary" -> {
//     schemaVersion: 1,
//     network: "bitcoin",
//     activationHeight, indexedHeight, tipHeight,
//     utxoBalances: [["txid:vout", { address, balances: [[ticker, "amt-as-string"], ...] }], ...],
//     addressUtxos: [[address, ["txid:vout", ...]], ...],
//     tokens: [[ticker, { ..., supply: "21000000", minted: "..." }], ...],
//     bets / transfers / deploys: arrays of view objects,
//     betOffset / transferOffset / deployOffset: "stringified-bigint",
//     byTxid: [[txid, { kind, idx: "stringified-bigint" }], ...],
//     blockHashes: [[height, hash], ...],
//     lastSavedAt: unix-secs
//   }
//
// BigInt fields (offsets, balances, supply, minted, byTxid.idx) are
// stringified for JSON-safety (IDB structured-clone supports BigInt
// directly in modern browsers, but we stringify for forward-compat
// with browsers that proxy IDB through older shims). The reviver in
// loadSnapshot converts them back.

import { newState, MAX_RECENT_ERRORS } from "./state.js";
import { LCKPROTOCOL_V1_HEIGHT } from "./protocol.js";

const DB_NAME = "luckyprotocol_indexer";
const DB_VERSION = 1;
const STORE = "snapshots";
const PRIMARY_KEY = "primary";

// Bump on any field-shape change that would corrupt loads from older
// versions. Mismatched schemaVersion forces a cold rescan from
// activation height (the next boot rebuilds canonical state from chain).
//
// Version history:
//   1 — initial (cohort v949375). Stale on activation bump because the
//       indexedHeight in the snapshot points at a sub-950,382 block.
//   2 — cohort v950382 cutover. Forces every existing user to cold-
//       rescan from the new activation height.
//   3 — SEND consensus-fee gate added (apply.js SEND_PROTOCOL_FEE_SATS).
//       SENDs in pre-v3 snapshots may have been recorded `applied=true`
//       despite missing the fee; bump forces a clean rebuild so the
//       new gate retroactively excludes them.
export const SCHEMA_VERSION = 3;

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r), reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- Serialization ------------------------------------------------------

/**
 * Serialize the live indexer state into a JSON-safe object. Maps/Sets
 * become arrays of pairs; BigInts become stringified decimals.
 * recentErrors is intentionally NOT snapshotted — per-process state
 * resets on each browser session.
 */
function serializeState(state) {
  const utxoBalances = [];
  for (const [key, entry] of state.utxoBalances) {
    const balances = [];
    for (const [ticker, amt] of entry.balances) {
      balances.push([ticker, amt.toString()]);
    }
    utxoBalances.push([key, { address: entry.address ?? null, balances }]);
  }

  const addressUtxos = [];
  for (const [addr, set] of state.addressUtxos) {
    addressUtxos.push([addr, Array.from(set)]);
  }

  const tokens = [];
  for (const [ticker, reg] of state.tokens) {
    tokens.push([
      ticker,
      {
        ticker: reg.ticker,
        supply: reg.supply.toString(),
        minted: reg.minted.toString(),
        deployer: reg.deployer,
        deploy_txid: reg.deploy_txid,
        deploy_block: reg.deploy_block,
      },
    ]);
  }

  const byTxid = [];
  for (const [txid, ref] of state.byTxid) {
    byTxid.push([txid, { kind: ref.kind, idx: ref.idx.toString() }]);
  }

  const blockHashes = [];
  for (const [h, hash] of state.blockHashes) {
    blockHashes.push([h, hash]);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    network: state.network,
    activationHeight: state.activationHeight,
    indexedHeight: state.indexedHeight,
    tipHeight: state.tipHeight,
    utxoBalances,
    addressUtxos,
    tokens,
    bets: state.bets,
    transfers: state.transfers,
    deploys: state.deploys,
    betOffset: state.betOffset.toString(),
    transferOffset: state.transferOffset.toString(),
    deployOffset: state.deployOffset.toString(),
    byTxid,
    blockHashes,
    lastSavedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Inverse of serializeState. Defensive on every field — a corrupted or
 * outdated snapshot returns null and the orchestrator falls back to
 * newState() + cold rescan. NEVER throws on a malformed snapshot;
 * a partial scan history is worse than starting clean.
 */
function deserializeState(blob) {
  if (!blob || typeof blob !== "object") return null;
  if (blob.schemaVersion !== SCHEMA_VERSION) return null;

  try {
    const state = newState(blob.network || "bitcoin");
    state.activationHeight = blob.activationHeight || LCKPROTOCOL_V1_HEIGHT;
    state.indexedHeight =
      typeof blob.indexedHeight === "number"
        ? blob.indexedHeight
        : state.activationHeight - 1;
    state.tipHeight = blob.tipHeight || 0;

    for (const [key, entry] of blob.utxoBalances || []) {
      const balances = new Map();
      for (const [ticker, amtStr] of entry.balances || []) {
        balances.set(ticker, BigInt(amtStr));
      }
      state.utxoBalances.set(key, {
        address: entry.address ?? null,
        balances,
      });
    }

    for (const [addr, keys] of blob.addressUtxos || []) {
      state.addressUtxos.set(addr, new Set(keys));
    }

    for (const [ticker, reg] of blob.tokens || []) {
      state.tokens.set(ticker, {
        ticker: reg.ticker,
        supply: BigInt(reg.supply),
        minted: BigInt(reg.minted),
        deployer: reg.deployer,
        deploy_txid: reg.deploy_txid,
        deploy_block: reg.deploy_block,
      });
    }

    state.bets = Array.isArray(blob.bets) ? blob.bets : [];
    state.transfers = Array.isArray(blob.transfers) ? blob.transfers : [];
    state.deploys = Array.isArray(blob.deploys) ? blob.deploys : [];
    state.betOffset = BigInt(blob.betOffset || "0");
    state.transferOffset = BigInt(blob.transferOffset || "0");
    state.deployOffset = BigInt(blob.deployOffset || "0");

    for (const [txid, ref] of blob.byTxid || []) {
      state.byTxid.set(txid, { kind: ref.kind, idx: BigInt(ref.idx) });
    }

    for (const [h, hash] of blob.blockHashes || []) {
      state.blockHashes.set(h, hash);
    }

    return state;
  } catch (_e) {
    // Any reviver failure (bad BigInt string, mis-shaped entry) →
    // discard the whole snapshot. Cold rescan rebuilds canonical state.
    return null;
  }
}

// ---- Public API ---------------------------------------------------------

/**
 * Load the most-recent snapshot from IDB, or null if none exists / it's
 * unreadable. Caller (index.js::boot) treats null as "cold start from
 * activation height".
 */
export async function loadSnapshot() {
  try {
    const blob = await withStore("readonly", (store) => {
      return new Promise((res, rej) => {
        const req = store.get(PRIMARY_KEY);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    });
    return deserializeState(blob);
  } catch (_e) {
    // IDB unavailable (private browsing, quota, etc.) — caller starts cold.
    return null;
  }
}

/**
 * Atomically replace the persisted snapshot with the current live state.
 * Called from index.js's snapshot loop every SNAPSHOT_INTERVAL_BLOCKS,
 * and on graceful shutdown / `beforeunload`. Best-effort: failures log
 * but don't propagate — losing a snapshot just means the next boot
 * cold-rescans, not data loss (chain is the source of truth).
 */
export async function saveSnapshot(state) {
  try {
    const blob = serializeState(state);
    await withStore("readwrite", (store) => {
      return new Promise((res, rej) => {
        const req = store.put(blob, PRIMARY_KEY);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    });
    return true;
  } catch (e) {
    // Surface to console but don't throw — see comment above.
    // eslint-disable-next-line no-console
    console.warn("[indexer] snapshot save failed:", e);
    return false;
  }
}

/**
 * Wipe the persisted snapshot — used by Settings → RESET INDEXER and
 * by the schemaVersion-mismatch path. Next boot starts cold.
 */
export async function wipeSnapshot() {
  try {
    await withStore("readwrite", (store) => {
      return new Promise((res, rej) => {
        const req = store.delete(PRIMARY_KEY);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    });
    return true;
  } catch (_e) {
    return false;
  }
}

// Re-export so callers don't have to know the constant lives in state.js.
export { MAX_RECENT_ERRORS };
