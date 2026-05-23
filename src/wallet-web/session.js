// In-memory unlocked session state.
//
// When the user successfully unlocks the wallet, we cache the
// decrypted mnemonic + derived keys here so subsequent signing
// operations don't re-Argon2 the password (which takes ~1s). The
// cache is plain JS object — lives only in tab memory, never
// persisted, cleared on tab close / page reload.
//
// Threat model note: in-memory mnemonic IS visible to:
//   * the user themselves via devtools (your tab, your secrets)
//   * any malicious script the page somehow loaded (XSS) — same
//     threat surface as ALL browser wallets (MetaMask, Xverse,
//     Unisat). Mitigated by strict CSP forbidding remote scripts.
//   * a browser exploit with cross-tab read access — out of scope.
//
// What it ISN'T visible to:
//   * disk-snapshot attackers — never touches storage
//   * different origins — JS memory is per-origin
//   * the next page load — gone on refresh
//
// The desktop build kept the unlocked seed in Rust process memory,
// asking the user for their password on every signed operation in
// long sessions. The web build trades a bit of that hardening for UX:
// users would revolt if every MINE click re-typed the password.

let _session = null;

/**
 * Set the unlocked session. Called by `unlockSession` in index.js
 * after a successful Argon2id + AES-GCM round. `data` carries:
 *   { mnemonic, address, network, privateKey, publicKey }
 */
export function setSession(data) {
  _session = data;
}

/**
 * True iff a session is currently unlocked.
 */
export function isUnlocked() {
  return _session != null;
}

/**
 * Read the unlocked session. Throws if locked — callers should gate on
 * `isUnlocked()` first to surface a friendly "please unlock" message
 * instead of a thrown error.
 */
export function getSession() {
  if (!_session) {
    throw new Error("wallet is locked — call unlockSession(password) first");
  }
  return _session;
}

/**
 * Drop the session. Called by `lockWallet` and `wipeWallet`. After
 * this, getSession() throws until a new unlock.
 *
 * We deliberately do NOT zero the underlying Uint8Arrays — JS has no
 * way to guarantee memory hygiene anyway (the GC can copy buffers
 * during compaction, leaving stale copies in old heap regions). The
 * best we can do is drop the reference so the GC eventually reclaims
 * the pages.
 */
export function clearSession() {
  _session = null;
}
