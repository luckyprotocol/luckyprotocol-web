// LUCKYPROTOCOL OP_RETURN payload encoders.
//
// Byte-identical to the Rust `src-tauri/src/tx.rs` reference
// implementation (see PROTOCOL.md §4 wire format). The indexer
// (`luckyprotocol-indexer/src/protocol.rs::parse_payload`) strictly
// validates every field — if these encoders drift from the Rust
// version by a single byte, the indexer rejects the tx as malformed
// and the user loses their fee.
//
// Wire formats (ASCII, `|`-delimited, no trailing newline):
//
//   DEPLOY:   LUCKYPROTOCOL|DEPLOY|<ticker>
//   MINE v2:  LUCKYPROTOCOL|<tier>|<pick>|<ticker>|<win_out_idx>|<change_out_idx>
//   SEND:     LUCKYPROTOCOL|SEND|<ticker>|<amount>|<to_out_idx>|<change_out_idx>
//
// All integer fields are canonical decimal (no leading zeros except
// "0", no signs, no whitespace). Tickers are uppercase ASCII alnum,
// 1-8 chars. Ticker validation matches indexer rules.
//
// We also enforce the 80-byte OP_RETURN payload cap that Bitcoin
// standardness imposes — over that, miners drop the tx as non-standard.

const PROTOCOL_PREFIX = "LUCKYPROTOCOL";
const MAX_PAYLOAD_BYTES = 80;
const MAX_OUT_IDX = 255;

// LUCKYPROTOCOL is mainnet-only. Project fee address for DEPLOY (5460 sat)
// and MINE/SEND (546 sat) outputs. Hard-coded — any change here is a
// protocol consensus break.
export const PROJECT_FEE_ADDRESS =
  "bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3";
export const PROJECT_FEE_SATS = 546;          // MINE / SEND
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460; // DEPLOY
export const DUST_SATS = 546;                  // BIP141 dust limit for P2WPKH

const VALID_TIERS = new Set(["iron", "bronze", "silver", "gold"]);

function validateTicker(ticker) {
  if (typeof ticker !== "string") {
    throw new Error("ticker must be a string");
  }
  if (ticker.length < 1 || ticker.length > 8) {
    throw new Error(`ticker length ${ticker.length} not in [1, 8]`);
  }
  if (!/^[A-Z0-9]+$/.test(ticker)) {
    throw new Error(`ticker "${ticker}" must be A-Z 0-9 only`);
  }
}

function validateOutIdx(name, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_OUT_IDX) {
    throw new Error(`${name} = ${idx} out of range [0, ${MAX_OUT_IDX}]`);
  }
}

function asciiBytes(s) {
  // OP_RETURN payloads are pure ASCII — we never want UTF-8
  // multi-byte chars to sneak through (they'd inflate length past
  // 80B + the indexer's parser doesn't decode UTF-8). TextEncoder
  // would encode any non-ASCII as multi-byte, so we whitelist
  // 0x20-0x7E first and let TextEncoder handle the encoding of
  // those (which is 1:1 to ASCII).
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7E) {
      throw new Error(`non-ASCII byte 0x${c.toString(16)} at index ${i}`);
    }
  }
  return new TextEncoder().encode(s);
}

function capPayload(bytes) {
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `payload ${bytes.length} bytes exceeds OP_RETURN 80-byte standardness limit`,
    );
  }
  return bytes;
}

/**
 * `LUCKYPROTOCOL|DEPLOY|<ticker>`
 * Used by publishDeploy. The accompanying tx must also pay
 * DEPLOY_PROTOCOL_FEE_SATS (5460) to PROJECT_FEE_ADDRESS in some
 * output — indexer enforces this as a consensus rule.
 */
export function buildDeployPayload(ticker) {
  validateTicker(ticker);
  const raw = `${PROTOCOL_PREFIX}|DEPLOY|${ticker}`;
  return capPayload(asciiBytes(raw));
}

/**
 * `LUCKYPROTOCOL|<tier>|<pick>|<ticker>|<win_out_idx>[|<change_out_idx>]`
 *
 * `changeOutIdx` is OPTIONAL — protocol v1 (legacy, 5-field) burns
 * residual token input; v2 (6-field, used by every modern wallet)
 * routes residual to `change_out_idx`. The desktop reference wallet
 * always emits v2 with `change_out_idx === win_out_idx === 0` so the
 * 546-sat dust UTXO at vout 0 absorbs both the win mint AND any
 * accidentally-spent token residual. We mirror that default.
 */
export function buildMinePayload({ tier, pick, ticker, winOutIdx, changeOutIdx }) {
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`unknown tier "${tier}"`);
  }
  if (typeof pick !== "string" || pick.length === 0) {
    throw new Error("pick must be a non-empty string");
  }
  validateTicker(ticker);
  validateOutIdx("winOutIdx", winOutIdx);
  let raw;
  if (changeOutIdx === undefined || changeOutIdx === null) {
    raw = `${PROTOCOL_PREFIX}|${tier}|${pick}|${ticker}|${winOutIdx}`;
  } else {
    validateOutIdx("changeOutIdx", changeOutIdx);
    raw = `${PROTOCOL_PREFIX}|${tier}|${pick}|${ticker}|${winOutIdx}|${changeOutIdx}`;
  }
  return capPayload(asciiBytes(raw));
}

/**
 * `LUCKYPROTOCOL|SEND|<ticker>|<amount>|<to_out_idx>|<change_out_idx>`
 *
 * `amount` is in token-smallest-units (matches indexer's `u64` AMT
 * field). The reference wallet ALWAYS emits `change_out_idx` — it's
 * technically optional in the wire format but omitting it under
 * §6.6 strict-burn rules destroys any residual input pool, which is
 * never what the user wants.
 *
 * Reference tx layout (matches desktop publish_transfer):
 *   vout 0 — 546 sat dust to recipient (token slot, to_out_idx = 0)
 *   vout 1 — OP_RETURN with this payload
 *   vout 2 — drain to self (BTC change + residual token pool,
 *            change_out_idx = 2)
 */
export function buildSendPayload({ ticker, amount, toOutIdx, changeOutIdx }) {
  validateTicker(ticker);
  if (typeof amount !== "bigint" && typeof amount !== "number") {
    throw new Error("amount must be a number or bigint");
  }
  const amt = typeof amount === "bigint" ? amount : BigInt(amount);
  if (amt < 1n) {
    throw new Error("SEND amount must be >= 1");
  }
  // Match indexer's MAX_SEND_AMT (21M tokens × 1 = 21_000_000 — same
  // as REQUIRED_TOKEN_SUPPLY because we use smallest-units = whole
  // tokens for LUCKYPROTOCOL).
  if (amt > 21_000_000n) {
    throw new Error("SEND amount exceeds 21,000,000 cap");
  }
  validateOutIdx("toOutIdx", toOutIdx);
  validateOutIdx("changeOutIdx", changeOutIdx);
  if (toOutIdx === changeOutIdx) {
    // Indexer rejects same-index for to+change as ambiguous (see
    // protocol.rs parser). Catch client-side to surface a clearer
    // error.
    throw new Error("SEND toOutIdx === changeOutIdx ambiguous; pick distinct indices");
  }
  const raw = `${PROTOCOL_PREFIX}|SEND|${ticker}|${amt.toString()}|${toOutIdx}|${changeOutIdx}`;
  return capPayload(asciiBytes(raw));
}
