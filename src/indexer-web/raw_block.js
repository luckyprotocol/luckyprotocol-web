// Raw Bitcoin block parser — the FAST cold-scan path.
//
// Why this exists:
//   The paginated /block/:hash/txs/:start endpoint returns ~25 txs per
//   request. A busy block has ~3000 txs → ~120 HTTP round-trips just
//   to know which txs are LUCKYPROTOCOL-relevant. Multiply by 80k blocks
//   from activation height to tip and the cold scan takes DAYS.
//
//   This module parses the raw consensus-serialized block bytes locally
//   in ~10ms per MB. One HTTP request per block instead of ~120; the
//   per-block CPU work is irrelevant compared to network latency
//   savings. Cold scan goes from days to a few hours.
//
// What we extract per tx:
//   - txid (computed from non-witness bytes via double-SHA256)
//   - isCoinbase
//   - vins (just [prev_txid, prev_vout]) — used for spent-outpoint set
//     + token-UTXO membership check
//   - vouts: { value, script } — used for value + scriptPubKey
//     classification (we lazy-derive the address only when actually
//     needed, since the rare protocol-relevant txs benefit but the
//     vast majority of irrelevant ones can skip that work)
//   - payloadText: extracted LUCKYPROTOCOL OP_RETURN payload string
//     (or null if none / multi-OP_RETURN burn case)
//
// What we DON'T extract (and why):
//   - prevout address / value: would require fetching the parent tx
//     for each vin. For protocol-relevant txs we need this for
//     `sender` (audit-only). Solution: fall back to per-tx Esplora
//     fetch ONLY for the rare relevant txs (handled in scanner.js).
//   - witness data: not needed for any protocol-level decision; we
//     skip it during parsing for speed.

import { sha256 } from "@noble/hashes/sha2.js";
import { OutScript, Address } from "@scure/btc-signer/payment.js";
import { NETWORK } from "@scure/btc-signer";

// Bitcoin's mainnet address coder. Pinned to mainnet — LUCKYPROTOCOL is
// mainnet-only.
const ADDR_CODER = Address(NETWORK);

// ---- Low-level byte stream reader --------------------------------------
//
// micro-packed (@scure's parser framework) can decode the whole tx in one
// call but doesn't easily report bytes-consumed for sequential parsing
// inside a block. A hand-rolled stream is ~50 lines and lets us track
// the witness/non-witness byte ranges separately, which is what we need
// to compute txid (= SHA256d of the non-witness bytes).

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  u8() {
    return this.bytes[this.offset++];
  }
  u16le() {
    const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return v >>> 0;
  }
  u32le() {
    const v =
      (this.bytes[this.offset] |
        (this.bytes[this.offset + 1] << 8) |
        (this.bytes[this.offset + 2] << 16) |
        (this.bytes[this.offset + 3] << 24)) >>>
      0;
    this.offset += 4;
    return v;
  }
  u64le() {
    // Returns a BigInt — values can exceed 2^53.
    const lo = BigInt(this.u32le());
    const hi = BigInt(this.u32le());
    return lo | (hi << 32n);
  }
  bytes_(n) {
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  /**
   * Bitcoin CompactSize varint. Returns a JS Number (block sizes are
   * always well under 2^53). Format:
   *   0x00..0xfc → that byte itself
   *   0xfd → next u16le
   *   0xfe → next u32le
   *   0xff → next u64le (we throw — no real-world block has
   *           >2^32 of anything)
   */
  varint() {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) return this.u16le();
    if (first === 0xfe) return this.u32le();
    throw new Error("varint > 2^32 not supported");
  }
}

function sha256d(bytes) {
  return sha256(sha256(bytes));
}

// Hex-encode a Uint8Array (lowercase). Used to format txid.
function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

// Reverse a Uint8Array (returns a new array). Bitcoin txids are
// displayed as the reverse of the SHA256d byte order ("internal" vs
// "RPC byte order").
function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---- OP_RETURN payload extraction --------------------------------------
//
// Mirrors src/chain-web/esplora.js's decodeOpReturnPayload, but operates
// directly on the script bytes (no hex string round-trip). Returns the
// ASCII payload or null.
function extractPayloadFromScript(script) {
  if (!script || script.length < 2 || script[0] !== 0x6a) return null;
  const pushOp = script[1];
  let payload;
  if (pushOp >= 0x01 && pushOp <= 0x4b) {
    const len = pushOp;
    if (script.length !== 2 + len) return null;
    payload = script.subarray(2, 2 + len);
  } else if (pushOp === 0x4c && script.length >= 3) {
    const len = script[2];
    if (script.length !== 3 + len) return null;
    payload = script.subarray(3, 3 + len);
  } else if (pushOp === 0x4d && script.length >= 4) {
    const len = script[2] | (script[3] << 8);
    if (script.length !== 4 + len) return null;
    payload = script.subarray(4, 4 + len);
  } else {
    return null;
  }
  // ASCII gate: any byte outside printable ASCII isn't ours.
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] < 0x20 || payload[i] > 0x7e) return null;
  }
  const text = new TextDecoder().decode(payload);
  if (!text.startsWith("LUCKYPROTOCOL|")) return null;
  return text;
}

/**
 * Resolve a scriptPubKey to a bech32 / bech32m / base58 address string,
 * or null if the script isn't a standard pay-to-X.
 *
 * We use @scure/btc-signer's OutScript.decode (classifies the script
 * into { type, ... }) + Address(NETWORK).encode (formats per network).
 * Wrapped in try/catch because non-standard scripts (raw pubkey,
 * unknown witness versions, malformed scripts) make OutScript.decode
 * throw — for the indexer those are simply "no address" and don't
 * receive token assignments.
 */
function scriptToAddress(script) {
  if (!script || script.length === 0) return null;
  try {
    const out = OutScript.decode(script);
    if (!out) return null;
    return ADDR_CODER.encode(out);
  } catch (_e) {
    return null;
  }
}

// ---- Per-tx parsing -----------------------------------------------------

/**
 * Parse one tx starting at `reader.offset`. Returns
 *   {
 *     txid:         lowercase hex string,
 *     isCoinbase:   boolean,
 *     spentOutpoints: [[prev_txid, prev_vout], ...],
 *     vouts:        [{ value: bigint, script: Uint8Array }, ...],
 *     payloadText:  string | null,
 *     hasMultipleOpReturn: boolean,
 *   }
 *
 * Also advances the reader past this tx's bytes (including witness).
 *
 * txid computation:
 *   txid = SHA256d( version || vin_count || vins || vout_count || vouts || locktime )
 *   — NEVER includes the segwit marker, flag, or witness data, even
 *   for segwit txs. We track the start/end byte offsets of the non-
 *   witness portion to slice it for hashing.
 */
function parseTx(reader) {
  const txStartOffset = reader.offset;
  const versionOffset = reader.offset;
  reader.u32le(); // version (we don't use it but need to advance)

  // SegWit marker (0x00) + flag (0x01) detection. If present, the
  // varint that would otherwise be vin_count is replaced by these
  // two bytes; the real vin_count follows.
  let segwit = false;
  let inputsStartOffset;
  if (reader.bytes[reader.offset] === 0x00 && reader.bytes[reader.offset + 1] === 0x01) {
    segwit = true;
    reader.offset += 2;
    inputsStartOffset = reader.offset;
  } else {
    inputsStartOffset = reader.offset;
  }

  const vinCount = reader.varint();
  const spentOutpoints = [];
  let isCoinbase = false;
  for (let i = 0; i < vinCount; i++) {
    // 32-byte prev txid (little-endian / "internal byte order")
    const prevTxidBytes = reader.bytes_(32);
    const prevVout = reader.u32le();
    const scriptLen = reader.varint();
    reader.offset += scriptLen; // skip scriptSig
    reader.u32le(); // sequence

    // Coinbase: single input with txid = all-zero + vout = 0xffffffff.
    // We detect by checking the prev vout — cheap test.
    if (prevVout === 0xffffffff) {
      let allZero = true;
      for (let b = 0; b < 32; b++) {
        if (prevTxidBytes[b] !== 0) { allZero = false; break; }
      }
      if (allZero) {
        isCoinbase = true;
        continue;
      }
    }
    // Display txid is reversed-bytes of internal-byte-order.
    const prevTxidHex = bytesToHex(reverseBytes(prevTxidBytes));
    spentOutpoints.push([prevTxidHex, prevVout]);
  }

  const voutCount = reader.varint();
  const vouts = [];
  let payloadText = null;
  let opReturnCount = 0;
  for (let i = 0; i < voutCount; i++) {
    const value = reader.u64le();
    const scriptLen = reader.varint();
    const script = reader.bytes_(scriptLen);
    vouts.push({ value, script });
    // Inline OP_RETURN payload scan during parse — saves a second pass
    // and lets us bail out of LUCKYPROTOCOL detection cheaply.
    if (script.length > 0 && script[0] === 0x6a) {
      opReturnCount += 1;
      if (opReturnCount === 1) {
        payloadText = extractPayloadFromScript(script);
      } else {
        // Multi-OP_RETURN — per the indexer's rule, the entire tx is
        // protocol-invalid; clear the payload so applyTx treats it as
        // payloadless (input pool burns).
        payloadText = null;
      }
    }
  }

  const inputsEndOffset = reader.offset;
  // Skip witnesses if segwit. Each vin has its own witness stack:
  //   varint num_items, then per item: varint len + bytes
  if (segwit) {
    for (let i = 0; i < vinCount; i++) {
      const numItems = reader.varint();
      for (let j = 0; j < numItems; j++) {
        const itemLen = reader.varint();
        reader.offset += itemLen;
      }
    }
  }
  reader.u32le(); // locktime
  const txEndOffset = reader.offset;
  void txEndOffset; // (kept named for future use)

  // Compute txid: SHA256d over { version, vin_count, vins, vout_count,
  // vouts, locktime } — the bytes BEFORE the segwit marker+flag block,
  // then the inputs/outputs section, then the locktime. We assemble
  // these slices explicitly.
  let txidBytes;
  if (segwit) {
    // Non-witness bytes = [versionOffset..versionOffset+4) ++
    //                     [inputsStartOffset..inputsEndOffset) ++
    //                     [last 4 bytes: locktime]
    const lockTimeStart = reader.offset - 4;
    const a = reader.bytes.subarray(versionOffset, versionOffset + 4);
    const b = reader.bytes.subarray(inputsStartOffset, inputsEndOffset);
    const c = reader.bytes.subarray(lockTimeStart, lockTimeStart + 4);
    const joined = new Uint8Array(a.length + b.length + c.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    joined.set(c, a.length + b.length);
    txidBytes = sha256d(joined);
  } else {
    // Non-segwit: whole tx range is the txid preimage.
    txidBytes = sha256d(reader.bytes.subarray(txStartOffset, reader.offset));
  }
  // Bitcoin displays txid in reverse byte order.
  const txid = bytesToHex(reverseBytes(txidBytes));

  return {
    txid,
    isCoinbase,
    spentOutpoints,
    vouts,
    payloadText,
  };
}

// ---- Public API ---------------------------------------------------------

/**
 * Parse a raw consensus-serialized block. Returns an iterable
 * `{ txs: [parsedTx, ...] }` where each parsedTx has the shape
 * documented on parseTx.
 *
 * Block layout:
 *   80 bytes  - header (version, prev_block, merkle_root, time,
 *               bits, nonce)
 *   varint    - tx_count
 *   bytes...  - tx bytes back to back
 */
export function parseRawBlock(bytes) {
  const reader = new Reader(bytes);
  reader.offset = 80; // skip header
  const txCount = reader.varint();
  const txs = new Array(txCount);
  for (let i = 0; i < txCount; i++) {
    txs[i] = parseTx(reader);
  }
  return { txs };
}

/**
 * Build a TxContext (in the shape applyTx wants) from a parsed raw-block
 * tx. `senderAddress` is the audit-only sender — we leave it empty by
 * default because raw-block parsing doesn't have prevout info; the
 * caller (scanner.js) can fill it in via an Esplora /tx/:txid fetch
 * for the rare protocol-relevant txs where the deployer/sender field
 * matters.
 *
 * `voutAddresses` is computed lazily: we ONLY decode addresses for the
 * vouts of txs that ended up being protocol-relevant. The other 99.9%
 * of txs skip address-derivation entirely (raw-block-fast-path benefit).
 */
export function txContextFromParsedTx(parsed, blockHeight, blockHash, senderAddress = "") {
  const voutCount = parsed.vouts.length;
  const voutAddresses = new Array(voutCount).fill(null);
  const voutValues = new Array(voutCount).fill(0);
  const opReturnVouts = [];
  for (let i = 0; i < voutCount; i++) {
    const v = parsed.vouts[i];
    voutValues[i] = Number(v.value);
    if (v.script.length > 0 && v.script[0] === 0x6a) {
      opReturnVouts.push(i);
      // OP_RETURNs have no spendable address — leave at null.
    } else {
      voutAddresses[i] = scriptToAddress(v.script);
    }
  }
  return {
    txid: parsed.txid,
    blockHeight,
    blockHash,
    sender: senderAddress,
    spentOutpoints: parsed.spentOutpoints,
    voutCount,
    opReturnVouts,
    voutAddresses,
    voutValues,
  };
}

/**
 * Quick membership check: does this parsed tx spend any outpoint that
 * appears in `utxoBalancesMap` (the indexer's per-UTXO balance index)?
 * Returns true for the (rare) txs that need full applyTx treatment
 * even when they don't carry a LUCKYPROTOCOL OP_RETURN — those txs
 * route residual tokens via the strict-burn rule.
 */
export function txSpendsAnyUtxo(parsed, utxoBalancesMap) {
  for (const [txid, vout] of parsed.spentOutpoints) {
    if (utxoBalancesMap.has(`${txid}:${vout}`)) return true;
  }
  return false;
}
