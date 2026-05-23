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
