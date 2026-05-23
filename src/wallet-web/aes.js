// AES-256-GCM encrypt / decrypt via the Web Crypto API.
//
// GCM is an authenticated cipher — the 16-byte tag at the end of the
// ciphertext catches any tamper attempt before we hand decrypted bytes
// back to the caller. This is critical for wallet storage: if an
// attacker with file-system access (or a malicious browser extension)
// flips a bit in the IndexedDB ciphertext, decrypt() throws instead of
// silently returning a corrupted mnemonic that the user might
// unknowingly act on.
//
// Nonce hygiene: every encrypt() generates a fresh 12-byte random
// nonce. The nonce is prepended to the ciphertext at storage time
// (12 nonce bytes + N ciphertext bytes + 16 tag bytes). Re-using a
// nonce with the same key is catastrophic in GCM, so each commit /
// password change rotates it.

const KEY_USAGES = ["encrypt", "decrypt"];
const ALG = { name: "AES-GCM", length: 256 };

/**
 * Import a raw 32-byte key into a non-extractable CryptoKey usable by
 * encrypt/decrypt. Non-extractable means even if attacker JS gets a
 * reference to the CryptoKey object, it can't read the underlying bytes
 * back — they live inside the browser's crypto subsystem.
 */
async function importKey(rawKey) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) {
    throw new Error(`AES-256-GCM key must be 32 bytes; got ${rawKey?.length}`);
  }
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    ALG,
    /* extractable: */ false,
    KEY_USAGES,
  );
}

/**
 * Encrypt `plaintext` (Uint8Array) under `rawKey`. Returns a single
 * Uint8Array of `[nonce (12)] || [ciphertext+tag]`. Pack format chosen
 * so callers only persist ONE blob — separate fields invite get/set
 * bugs where the nonce and ct drift apart.
 */
export async function encrypt(plaintext, rawKey) {
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error("plaintext must be a Uint8Array");
  }
  const key = await importKey(rawKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  const out = new Uint8Array(nonce.length + ctWithTag.length);
  out.set(nonce, 0);
  out.set(ctWithTag, nonce.length);
  return out;
}

/**
 * Decrypt a blob produced by `encrypt`. Throws on tag mismatch (wrong
 * key, tampered ciphertext, or wrong AAD).
 */
export async function decrypt(packed, rawKey) {
  if (!(packed instanceof Uint8Array) || packed.length < 12 + 16) {
    throw new Error("ciphertext too short");
  }
  const key = await importKey(rawKey);
  const nonce = packed.subarray(0, 12);
  const ctWithTag = packed.subarray(12);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      ctWithTag,
    ),
  );
  return plaintext;
}
