// IndexedDB wrapper for the wallet blob.
//
// Why IndexedDB instead of localStorage:
//   * localStorage is synchronous + capped at ~5-10 MB per origin —
//     fine for our use case sizewise but blocks the main thread on
//     every write. Argon2 derivation is already CPU-heavy; adding a
//     synchronous localStorage write at unlock time compounds the
//     unlock-spinner jank.
//   * localStorage stores STRINGS only. We'd be forced to base64-
//     encode the encrypted ciphertext, eating ~33% storage overhead.
//   * IndexedDB stores Uint8Array natively + async API. The wrapper
//     below promisifies the IDBRequest dance so callers see a clean
//     `await getWallet()` interface.
//
// The DB has one store (`wallets`) with a single record keyed `primary`.
// We only support one wallet per device — multi-wallet UX adds a layer
// of "which seed am I unlocking" cognitive load that hasn't been worth
// it in the desktop build either. If/when we add it, we change the
// keyPath from a literal to user-supplied wallet IDs.

const DB_NAME = "luckyprotocol_wallet";
const DB_VERSION = 1;
const STORE = "wallets";
const PRIMARY_KEY = "primary";

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable (server-side render?)"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      // If the DB version changes underneath us (another tab upgraded),
      // close ours so the user gets a clean reload next tick. Otherwise
      // we'd silently use a stale schema.
      req.result.onversionchange = () => {
        try { req.result.close(); } catch {}
        _dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      reject(new Error("IndexedDB open blocked — another tab may be upgrading"));
    };
  });
  return _dbPromise;
}

/**
 * Read the wallet blob from IndexedDB. Returns null if no wallet
 * exists. Caller should treat the returned object as opaque — it
 * carries the encrypted mnemonic + salt + nonce + Argon2 params
 * + public info (address + network + createdAt).
 */
export async function getWallet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(PRIMARY_KEY);
    req.onsuccess = () => {
      const r = req.result;
      if (!r) { resolve(null); return; }
      // Strip the IDB keyPath ("id") before returning so the blob shape
      // matches what putWallet writes.
      const { id: _id, ...blob } = r;
      resolve(blob);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persist a wallet blob. Overwrites any existing record. Caller is
 * responsible for the blob's contents — see commitWallet / changePassword.
 */
export async function putWallet(blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id: PRIMARY_KEY, ...blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IDB tx aborted"));
  });
}

/**
 * Delete the wallet blob. Used by `wipeWallet`. The IDB store itself
 * stays so re-creating a wallet doesn't need a schema migration.
 */
export async function deleteWallet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(PRIMARY_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IDB tx aborted"));
  });
}
