// Frontend wallet shim.
//
// In the desktop build this file routed everything to Tauri Rust
// commands. In the web build it routes everything to `src/wallet-web/`
// — a pure-browser implementation using Argon2id + AES-GCM + Web Crypto
// + IndexedDB for at-rest storage, and @scure/bip39 + @scure/bip32 +
// @scure/btc-signer for BIP39/32/84 + P2WPKH address derivation.
//
// We keep the public API surface identical to the desktop version so
// the rest of the React app (LuckyProtocolApp.jsx and friends) doesn't
// know which backend it's talking to. Sync accessors (hasWallet,
// getWalletAddress, getWalletNetwork) are backed by a localStorage
// mirror of the public info — refreshed by `syncWalletCache()` on boot.

import * as walletWeb from "../wallet-web/index.js";

const LS_WALLET = "luckyprotocol.wallet.v1";

// LUCKYPROTOCOL is mainnet-only.
export const DEFAULT_NETWORK = "bitcoin";

// ---- localStorage mirror (public info only — no key material) -------------

const lsGet = (k) => {
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    window.localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const lsDel = (k) => {
  try {
    window.localStorage.removeItem(k);
  } catch {}
};

// Sync accessors — read from the LS mirror, no async / no IDB.
// `syncWalletCache()` reconciles LS with the IDB authoritative state
// once on app boot; from then on these are safe to call from useState
// initializers and other synchronous contexts.
export const hasWallet = () => !!lsGet(LS_WALLET);
export const getWalletAddress = () => lsGet(LS_WALLET)?.address || null;
export const getWalletNetwork = () =>
  lsGet(LS_WALLET)?.network || DEFAULT_NETWORK;

/**
 * Reconcile the LS mirror with the IndexedDB authoritative state.
 * Called once on app boot from a setup useEffect. Returns the cache
 * state after sync — useful for the boot effect to update walletMeta
 * React state with a single value rather than a two-step read.
 *
 * Three reconciliation cases:
 *   * IDB has wallet, LS doesn't → populate LS mirror
 *   * LS has wallet, IDB doesn't → wipe stale LS (user opened a new
 *     browser profile? extension cleared storage?)
 *   * Both / neither agree → keep whatever LS says
 */
export const syncWalletCache = async () => {
  try {
    const info = await walletWeb.getWalletInfo();
    const cached = lsGet(LS_WALLET);
    if (!info && cached) {
      lsDel(LS_WALLET);
      return null;
    }
    if (info && !cached) {
      const cache = {
        address: info.address,
        network: info.network,
        createdAt: info.createdAt,
      };
      lsSet(LS_WALLET, cache);
      return cache;
    }
    return cached;
  } catch (e) {
    console.warn("[wallet] syncWalletCache failed", e);
    return lsGet(LS_WALLET);
  }
};

// ---- Public API (1:1 with desktop, all browser-native now) ----------------

export const generateMnemonic = async () => {
  return walletWeb.generateMnemonic();
};

// BIP39 checksum + wordlist validator. Used by the OnboardModal's
// import-existing-wallet flow to fail fast on a typo before asking
// the user for a password — much friendlier than letting commitWallet
// throw "invalid mnemonic" after the password step.
export const validateMnemonic = (mnemonic) => {
  return walletWeb.validateMnemonic(mnemonic);
};

// Address derivation preview. Used by the import flow to show the
// user the bc1q address they're about to commit, AND to enforce the
// "must be bc1q (BIP84 native SegWit)" guard before storage. For any
// valid BIP39 mnemonic on mainnet this always returns bc1q...
// because we derive via the fixed BIP84 path m/84'/0'/0'/0/0; the
// guard is defensive — a future schema change to a different
// derivation path would silently break the assumption otherwise.
export const mnemonicToAddress = async (mnemonic) => {
  return await walletWeb.mnemonicToAddress(mnemonic);
};

export const commitWallet = async (mnemonic, password, network = DEFAULT_NETWORK) => {
  const info = await walletWeb.commitWallet(mnemonic, password, network);
  lsSet(LS_WALLET, {
    address: info.address,
    network: info.network,
    createdAt: Date.now(),
  });
  return info;
};

export const exportMnemonic = async (password) => {
  return await walletWeb.exportMnemonic(password);
};

export const verifyPassword = async (password) => {
  await walletWeb.verifyPassword(password);
};

/**
 * Unlock the session — decrypts the mnemonic + derives keys into
 * tab memory so subsequent signing ops don't re-Argon2 each time.
 * In the desktop build this lives implicitly inside `cmd_publish_bet`
 * / `cmd_publish_transfer` etc. (every signed call ships the password);
 * the web build exposes it as a separate step because session-based
 * unlock is the only way to get sub-second signing UX.
 */
export const unlockSession = async (password) => {
  return await walletWeb.unlockSession(password);
};

/** True iff the wallet is unlocked in this tab's memory. */
export const isUnlocked = () => walletWeb.isUnlocked();

/** Drop the in-memory session. The encrypted blob stays in IDB. */
export const lockWallet = () => walletWeb.lockWallet();

export const changePassword = async (oldPassword, newPassword) => {
  await walletWeb.changePassword(oldPassword, newPassword);
};

export const wipeWallet = async () => {
  await walletWeb.wipeWallet();
  lsDel(LS_WALLET);
};
