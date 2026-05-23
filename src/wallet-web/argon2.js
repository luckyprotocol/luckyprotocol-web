// Argon2id key derivation wrapper.
//
// Used to stretch a user-typed password into a 32-byte AES-256-GCM key
// that protects the BIP39 mnemonic at rest in IndexedDB. Parameter
// choice follows OWASP 2023 Password Storage Cheat Sheet:
//
//   m = 46,080 KiB (≈45 MiB)
//   t = 3 iterations
//   p = 1 parallelism (Web Crypto / single-threaded JS)
//   dkLen = 32 bytes (matches AES-256-GCM key size)
//
// We use the OWASP "alternate" profile (m=45MiB, t=3) rather than the
// "primary" (m=64MiB, t=3) so mobile browsers with tighter memory
// budgets (iOS Safari, low-end Android) can still derive the key
// without an OOM crash. On modern desktop the derivation runs in
// ~700ms-1.5s, perceived as a brief "unlocking…" spinner.
//
// noble's argon2id is synchronous; we wrap in `Promise.resolve()` so
// callers can await it consistently and so the microtask gives the
// event loop a chance to paint the spinner BEFORE the CPU burn.

import { argon2id } from "@noble/hashes/argon2.js";

export const ARGON2_PARAMS = Object.freeze({
  t: 3,
  m: 46_080,
  p: 1,
  dkLen: 32,
});

/**
 * Derive a 32-byte key from password + salt using Argon2id with the
 * OWASP 2023 alternate profile. `password` is NFKC-normalized so users
 * who type the same characters via different IMEs (accented chars,
 * fullwidth/halfwidth Japanese, etc.) get the same key.
 *
 * @param {string|Uint8Array} password
 * @param {Uint8Array} salt 16+ random bytes; persisted alongside the
 *   encrypted blob so we can re-derive the same key at unlock time.
 * @param {object} [params] override the default OWASP profile (e.g.
 *   for benchmarking or testing).
 * @returns {Promise<Uint8Array>} 32-byte key
 */
export async function deriveKey(password, salt, params = ARGON2_PARAMS) {
  // Yield once so a "deriving…" UI update can paint before the
  // synchronous Argon2 run pins the main thread for a second.
  await Promise.resolve();

  const passwordBytes = typeof password === "string"
    ? new TextEncoder().encode(password.normalize("NFKC"))
    : password;

  if (!(salt instanceof Uint8Array) || salt.length < 8) {
    throw new Error("salt must be at least 8 bytes (Argon2 minimum)");
  }

  return argon2id(passwordBytes, salt, params);
}

/**
 * Generate a cryptographically random salt of `bytes` bytes (default 16).
 * Used at wallet-commit time; the salt is persisted alongside the
 * ciphertext so unlock can re-derive the same key.
 */
export function randomSalt(bytes = 16) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}
