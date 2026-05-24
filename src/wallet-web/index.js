// Public API for the browser-native wallet.
//
// This module is the only thing `src/protocol/wallet.js` and the rest
// of the React app should import from. The submodules (argon2, aes,
// storage, keys, session) are implementation details.
//
// Function signatures intentionally mirror the desktop `protocol/wallet.js`
// shape so the React side doesn't care which backend is in use:
//
//   generateMnemonic()           → string
//   commitWallet(mn, pw, net)    → { address, network }
//   exportMnemonic(pw)           → string
//   verifyPassword(pw)           → void   (throws on wrong pw)
//   changePassword(old, new)     → void   (re-encrypts blob)
//   wipeWallet()                 → void
//   getWalletInfo()              → { address, network, createdAt } | null
//   unlockSession(pw)            → { address, network }   ← NEW (web-only)
//   isUnlocked()                 → boolean                ← NEW (web-only)
//   lockWallet()                 → void                   ← NEW (web-only)
//   getSessionPrivateKey()       → Uint8Array | null      ← NEW (web-only)
//
// The "NEW" entries don't exist in the desktop API because the desktop
// Rust backend handles session state internally — every signed op
// ships the password down, Rust validates + uses, then forgets. The
// web build can't afford that round-trip latency (Argon2 ~1s per op
// is unusable), so it caches the unlocked seed in tab memory.

import { deriveKey, randomSalt, ARGON2_PARAMS } from "./argon2.js";
import { encrypt, decrypt } from "./aes.js";
import { getWallet, putWallet, deleteWallet } from "./storage.js";
import {
  generateMnemonic as _gen,
  validateMnemonic,
  mnemonicToSeed,
  deriveBip84,
  deriveAddress,
  mnemonicToAddress,
} from "./keys.js";
import { setSession, isUnlocked, getSession, clearSession } from "./session.js";

// ---------------------------------------------------------------------------
// Blob shape persisted in IndexedDB:
//
//   {
//     schemaVersion: 1,
//     network: "bitcoin",
//     address: "bc1q...",
//     createdAt: <unix-ms>,
//     // Encrypted-at-rest mnemonic + parameters needed to re-derive the key
//     ciphertext: Uint8Array,   // nonce(12) || aes-gcm(mnemonic) || tag(16)
//     salt: Uint8Array,          // 16 bytes — feeds Argon2id
//     argon2: { t, m, p, dkLen } // parameters at commit time
//   }
//
// We persist the Argon2 params so future tuning (heavier defaults as
// browsers gain memory headroom) doesn't break unlock of existing
// wallets. Old blobs unlock with their original params; new blobs use
// whatever the current default is.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const DEFAULT_NETWORK = "bitcoin";

/** Generate a fresh 12-word BIP39 mnemonic. */
export function generateMnemonic() {
  return _gen();
}

/** True iff the mnemonic passes BIP39 checksum + wordlist. */
export { validateMnemonic };
/** BIP39 mnemonic → BIP84 bc1q address (mainnet). Used by the import
 * flow to preview the address before storage. */
export { mnemonicToAddress };

/**
 * Probe whether a wallet exists in IndexedDB. Returns a Promise<bool>.
 * Used by SHALL boot useState initializers (`firstRun`,
 * `needRiskAck`, `walletMeta`) to decide which onboarding step to
 * show. Cheap — single IDB read, no key derivation.
 */
export async function hasWalletAsync() {
  const blob = await getWallet();
  return blob != null;
}

/**
 * Encrypt `mnemonic` under `password` and persist to IndexedDB.
 * Returns the public wallet info ({ address, network }) so the caller
 * can update React state / localStorage mirror without re-reading.
 *
 * On success the wallet is ALSO left unlocked in session — the user
 * just typed the password during onboarding, no need to ask again
 * before they place their first bet.
 */
export async function commitWallet(mnemonic, password, network = DEFAULT_NETWORK) {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("invalid BIP39 mnemonic (checksum mismatch or unknown words)");
  }
  if (network !== DEFAULT_NETWORK) {
    // LUCKYPROTOCOL is mainnet-only — match desktop wallet::parse_network's strictness.
    throw new Error(`network not supported: ${network} (mainnet only)`);
  }
  if (!password || typeof password !== "string" || password.length < 1) {
    throw new Error("password must be a non-empty string");
  }

  // 1) Derive Argon2 key from password + fresh salt.
  const salt = randomSalt(16);
  const key = await deriveKey(password, salt);

  // 2) AES-GCM encrypt the mnemonic.
  const mnemonicBytes = new TextEncoder().encode(mnemonic);
  const ciphertext = await encrypt(mnemonicBytes, key);

  // 3) Derive the public address from the mnemonic.
  const address = await mnemonicToAddress(mnemonic);

  // 4) Persist the blob.
  const createdAt = Date.now();
  const blob = {
    schemaVersion: SCHEMA_VERSION,
    network,
    address,
    createdAt,
    ciphertext,
    salt,
    argon2: { ...ARGON2_PARAMS },
  };
  await putWallet(blob);

  // 5) Cache unlocked session — derive keys eagerly for the first signing op.
  const seed = await mnemonicToSeed(mnemonic);
  const { privateKey, publicKey } = deriveBip84(seed);
  setSession({ mnemonic, address, network, privateKey, publicKey });

  return { address, network };
}

/**
 * Decrypt the stored mnemonic with the given password and set the
 * in-memory session. Resolves to { address, network } on success,
 * throws on wrong password (AES-GCM tag mismatch) or "no wallet
 * stored" (blob missing).
 *
 * Idempotent — calling on an already-unlocked wallet returns the same
 * info without re-deriving.
 */
export async function unlockSession(password) {
  const blob = await getWallet();
  if (!blob) {
    throw new Error("no wallet on this device");
  }
  const key = await deriveKey(password, blob.salt, blob.argon2);
  let mnemonicBytes;
  try {
    mnemonicBytes = await decrypt(blob.ciphertext, key);
  } catch {
    // AES-GCM auth tag mismatch → wrong password (or corrupted blob).
    // Don't leak which.
    throw new Error("wrong password");
  }
  const mnemonic = new TextDecoder().decode(mnemonicBytes);
  const seed = await mnemonicToSeed(mnemonic);
  const { privateKey, publicKey } = deriveBip84(seed);

  setSession({
    mnemonic,
    address: blob.address,
    network: blob.network,
    privateKey,
    publicKey,
  });
  return { address: blob.address, network: blob.network };
}

/**
 * Verify a password without unlocking the session. Returns void on
 * success, throws "wrong password" on failure. Used by SettingsScreen's
 * "show recovery phrase" gate, where we don't want the side effect of
 * leaving the wallet unlocked for the rest of the session.
 */
export async function verifyPassword(password) {
  const blob = await getWallet();
  if (!blob) throw new Error("no wallet on this device");
  const key = await deriveKey(password, blob.salt, blob.argon2);
  try {
    await decrypt(blob.ciphertext, key);
  } catch {
    throw new Error("wrong password");
  }
}

/**
 * Return the plaintext mnemonic after re-verifying the password. We
 * deliberately re-Argon2 on every export rather than serving from
 * the cached session, so a "show recovery phrase" UI surface can't be
 * triggered without typing the password (defense against a malicious
 * browser extension that already has a session reference).
 */
export async function exportMnemonic(password) {
  const blob = await getWallet();
  if (!blob) throw new Error("no wallet on this device");
  const key = await deriveKey(password, blob.salt, blob.argon2);
  let mnemonicBytes;
  try {
    mnemonicBytes = await decrypt(blob.ciphertext, key);
  } catch {
    throw new Error("wrong password");
  }
  return new TextDecoder().decode(mnemonicBytes);
}

/**
 * Re-encrypt the stored mnemonic under a new password. Verifies the
 * old password first (so a user with stale clipboard can't accidentally
 * overwrite their wallet with garbage), then derives a fresh Argon2 key
 * with a fresh salt + fresh GCM nonce.
 */
export async function changePassword(oldPassword, newPassword) {
  const blob = await getWallet();
  if (!blob) throw new Error("no wallet on this device");
  if (!newPassword || newPassword.length < 1) {
    throw new Error("new password must be non-empty");
  }
  const oldKey = await deriveKey(oldPassword, blob.salt, blob.argon2);
  let mnemonicBytes;
  try {
    mnemonicBytes = await decrypt(blob.ciphertext, oldKey);
  } catch {
    throw new Error("wrong password");
  }

  // Fresh salt + fresh nonce — never reuse either for a different key.
  const newSalt = randomSalt(16);
  const newKey = await deriveKey(newPassword, newSalt);
  const newCiphertext = await encrypt(mnemonicBytes, newKey);

  await putWallet({
    ...blob,
    ciphertext: newCiphertext,
    salt: newSalt,
    argon2: { ...ARGON2_PARAMS },
  });
}

/**
 * Completely remove the wallet from IndexedDB and drop the in-memory
 * session. Caller (usually SettingsScreen "wipe wallet" flow) should
 * also clear any React state mirroring the wallet and any localStorage
 * caches before navigating back to first-run onboarding.
 */
export async function wipeWallet() {
  await deleteWallet();
  clearSession();
}

/**
 * Public info about the stored wallet — address, network, createdAt.
 * Returns null if no wallet stored. Does NOT touch the encrypted
 * mnemonic; safe to call anywhere.
 */
export async function getWalletInfo() {
  const blob = await getWallet();
  if (!blob) return null;
  return {
    address: blob.address,
    network: blob.network,
    createdAt: blob.createdAt,
  };
}

/** Re-export session helpers so callers don't need a second import. */
export { isUnlocked, clearSession as lockWallet };

/**
 * Get the BIP84-derived private key for the unlocked session, for
 * passing to the tx-construction layer (Phase 3). Throws if locked.
 */
export function getSessionPrivateKey() {
  const s = getSession();
  return s.privateKey;
}

/**
 * Get the BIP84-derived public key. Same gate as private key.
 */
export function getSessionPublicKey() {
  const s = getSession();
  return s.publicKey;
}
