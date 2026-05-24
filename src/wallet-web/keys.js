// BIP39 mnemonic generation + BIP32 HD derivation + BIP84 P2WPKH
// address derivation. Uses the @scure/* + @noble/* libraries (paulmillr)
// rather than bitcoinjs-lib so we avoid the Buffer-polyfill mess in
// browser bundlers.
//
// Path: BIP84 mainnet first external receive address
//
//   m / 84' / 0'  / 0'    / 0       / 0
//       │     │     │       │         │
//       │     │     │       │         └─ address index
//       │     │     │       └─────────── chain (0=external, 1=change)
//       │     │     └─────────────────── account index
//       │     └───────────────────────── coin type (0=Bitcoin mainnet)
//       └─────────────────────────────── purpose (84=BIP84 native SegWit)
//
// The desktop wallet uses the same path so a mnemonic exported from
// the desktop app would derive the SAME address here, and vice-versa.

import { generateMnemonic as _bip39Generate, validateMnemonic as _bip39Validate, mnemonicToSeed as _bip39ToSeed } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

// Mnemonic strength in bits. 128 → 12 words (matches desktop build).
const MNEMONIC_BITS = 128;

// BIP84 mainnet first external receive address.
const BIP84_PATH = "m/84'/0'/0'/0/0";

/**
 * Generate a fresh 12-word BIP39 mnemonic using WebCrypto entropy.
 */
export function generateMnemonic() {
  return _bip39Generate(wordlist, MNEMONIC_BITS);
}

/**
 * Check whether `mnemonic` is a valid BIP39 phrase (checksum + wordlist).
 * Used for paste-import validation if we ever support it.
 */
export function validateMnemonic(mnemonic) {
  return _bip39Validate(mnemonic, wordlist);
}

/**
 * Convert a BIP39 mnemonic to a 64-byte BIP32 seed via PBKDF2-HMAC-SHA512
 * (the BIP39 spec's seed derivation). `passphrase` is the optional
 * BIP39 "25th word" — we don't expose it in the UI yet but keep the
 * parameter so a future advanced-mode toggle slots in cleanly.
 */
export async function mnemonicToSeed(mnemonic, passphrase = "") {
  return await _bip39ToSeed(mnemonic, passphrase);
}

/**
 * Derive the BIP84 m/84'/0'/0'/0/0 private + public key pair from a
 * 64-byte seed. Throws if the child has no private key (should never
 * happen for hardened paths from a master seed).
 */
export function deriveBip84(seed) {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(BIP84_PATH);
  if (!child.privateKey) {
    throw new Error(`BIP84 derivation produced no private key at ${BIP84_PATH}`);
  }
  return {
    privateKey: child.privateKey,
    publicKey: child.publicKey,
  };
}

/**
 * Encode a compressed secp256k1 public key as a P2WPKH bech32 address
 * on the configured network (mainnet only for LUCKYPROTOCOL). Returns
 * the `bc1q...` string.
 */
export function deriveAddress(publicKey, network = btc.NETWORK) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33) {
    throw new Error(`expected 33-byte compressed pubkey; got ${publicKey?.length}`);
  }
  const payment = btc.p2wpkh(publicKey, network);
  return payment.address;
}

/**
 * One-shot helper used at wallet-commit time: BIP39 mnemonic → P2WPKH
 * address. The intermediate private key is dropped on the floor — the
 * caller (`wallet-web/index.js::commitWallet`) only needs the address
 * for the public wallet info; the seed is re-derived from the
 * decrypted mnemonic when the user unlocks for signing.
 */
export async function mnemonicToAddress(mnemonic) {
  const seed = await mnemonicToSeed(mnemonic);
  const { publicKey } = deriveBip84(seed);
  return deriveAddress(publicKey);
}

// ============================================================================
// Raw private key support (for the "import existing wallet" priv-key path)
// ============================================================================

const HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Decode hex string to Uint8Array. Internal helper; throws on bad hex.
 */
function hexToBytes(hex) {
  if (!HEX_RE.test(hex)) throw new Error("expected 64-char hex string");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode Uint8Array → lowercase hex. Used to serialize the priv key
 * back into the encrypted-blob plaintext on commit.
 */
export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * Parse a Bitcoin private key in WIF (Wallet Import Format) or raw
 * 64-char hex. Returns a 32-byte Uint8Array. Throws if the input is
 * malformed, has the wrong network byte (mainnet only — 0x80), or
 * doesn't pass secp256k1's scalar bounds check.
 *
 * WIF format (mainnet):
 *   base58check([0x80, ...privKey32, 0x01_if_compressed])
 *
 * We accept both compressed (52 chars, starts K/L) and uncompressed
 * (51 chars, starts 5) — internally the private key is the same 32
 * bytes; only the pubkey-derivation flag differs. Since LUCKYPROTOCOL
 * uses P2WPKH which REQUIRES compressed pubkeys (BIP141), we always
 * derive a compressed pubkey downstream regardless of the WIF's
 * compressed flag. An uncompressed-WIF user wanting their old
 * legacy/uncompressed address back would not get the same address
 * here — that's intentional, we only support bc1q (P2WPKH).
 */
export function parsePrivateKey(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("private key required");

  // Raw hex path (64 lowercase/uppercase chars).
  if (HEX_RE.test(s)) {
    const bytes = hexToBytes(s.toLowerCase());
    if (!secp256k1.utils.isValidPrivateKey(bytes)) {
      throw new Error("invalid secp256k1 private key (out of curve order)");
    }
    return bytes;
  }

  // WIF path. base58check decodes the version+payload+checksum blob.
  let decoded;
  try {
    decoded = base58check(sha256).decode(s);
  } catch {
    throw new Error("not a valid WIF or 64-char hex private key");
  }
  if (decoded.length !== 33 && decoded.length !== 34) {
    throw new Error(`WIF wrong length (${decoded.length} bytes; expected 33 or 34)`);
  }
  if (decoded[0] !== 0x80) {
    throw new Error(`WIF wrong network prefix (0x${decoded[0].toString(16)}; expected 0x80 mainnet)`);
  }
  const priv = decoded.slice(1, 33);
  // Optional trailing 0x01 = compressed pubkey flag. We accept both;
  // see the docstring for why we always emit compressed downstream.
  if (decoded.length === 34 && decoded[33] !== 0x01) {
    throw new Error(`WIF trailing byte 0x${decoded[33].toString(16)} unrecognized (expected 0x01 for compressed)`);
  }
  if (!secp256k1.utils.isValidPrivateKey(priv)) {
    throw new Error("invalid secp256k1 private key (out of curve order)");
  }
  return priv;
}

/**
 * Derive the BIP84 P2WPKH (bc1q) address for a raw 32-byte private
 * key. Used by the import-priv-key flow to preview the address
 * before commit, AND inside unlockSession when the stored blob is
 * a priv-key wallet (no mnemonic to BIP32-derive from).
 */
export function privateKeyToAddress(privKeyBytes) {
  if (!(privKeyBytes instanceof Uint8Array) || privKeyBytes.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${privKeyBytes?.length}`);
  }
  const pubKey = secp256k1.getPublicKey(privKeyBytes, true); // compressed
  return deriveAddress(pubKey);
}

/**
 * Compute both the address AND the pubkey for a raw priv key. The
 * session-cache code path needs both (address for receive UI;
 * pubkey for tx-signing). Returns { address, publicKey } where
 * publicKey is the 33-byte compressed form.
 */
export function privateKeyToKeypair(privKeyBytes) {
  if (!(privKeyBytes instanceof Uint8Array) || privKeyBytes.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${privKeyBytes?.length}`);
  }
  const publicKey = secp256k1.getPublicKey(privKeyBytes, true);
  const address = deriveAddress(publicKey);
  return { address, publicKey };
}
