// LUCKYPROTOCOL OP_RETURN payload parser — decode side.
//
// Mirrors the Rust indexer's `protocol::parse_payload` byte-for-byte
// (luckyprotocol-indexer/src/protocol.rs). If this parser disagrees
// with the Rust indexer on a SINGLE input, our browser-local state
// will diverge from any reference indexer on the network — users
// would see different balances than the canonical chain. So every
// rule here is intentional and matches the indexer literal.
//
// Wire forms (ASCII, "|"-delimited):
//
//   DEPLOY: LUCKYPROTOCOL|DEPLOY|<ticker>
//   MINE:   LUCKYPROTOCOL|<tier>|<pick>|<ticker>|<win_out_idx>[|<change_out_idx>]
//   SEND:   LUCKYPROTOCOL|SEND|<ticker>|<amount>|<to_out_idx>[|<change_out_idx>]
//
// Returns null on any malformed payload. Caller treats null as
// "no LUCKYPROTOCOL operation here" — the tx is then processed
// only for residual routing (token UTXOs spent without a payload
// are burned per §6.6).

export const PROTOCOL_PREFIX = "LUCKYPROTOCOL";

// Activation height — earliest block where LUCKYPROTOCOL OP_RETURNs
// are valid. ANY tx at height < this is invisible to the protocol
// even if the OP_RETURN parses. Must stay in lockstep with the Rust
// indexer's `LCKPROTOCOL_V1_HEIGHT` (luckyprotocol-indexer/src/protocol.rs).
//
// Cohort history (each bump invalidates ALL prior snapshots + LS state):
//   949,375 — initial Rust-indexer cohort (withdrawn)
//   950,382 — web-cutover cohort (withdrawn during fee-model unification)
//   950,950 — **CURRENT cohort**. Marks the three-fee consensus
//             model activation: DEPLOY == 5,460, MINE == 546,
//             SEND == 546 (all EXACT, to PROJECT_FEE_ADDRESS). Also
//             unifies Rust+JS activation heights (they previously
//             diverged Rust 949,375 vs JS 950,382, a latent
//             state-drift bug).
export const LCKPROTOCOL_V1_HEIGHT = 950_950;

const MAX_OUT_IDX = 255;
const MAX_SEND_AMT = 21_000_000n; // = REQUIRED_TOKEN_SUPPLY
const VALID_TIERS = new Set(["iron", "bronze", "silver", "gold"]);

/**
 * Canonical decimal-uint format check — same rules as the Rust
 * indexer's `is_canonical_uint`. Bans leading zeros except the bare
 * "0", bans sign, whitespace, scientific notation, plus characters.
 * This is critical for cross-language consensus: Python / JS / Go all
 * accept "012" or " 12" or "12.0" with their default parseInt, but
 * the Rust indexer rejects them. If we silently accept here we
 * diverge.
 */
function isCanonicalUint(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.length > 20) return false; // u64::MAX is 20 digits
  if (!/^[0-9]+$/.test(s)) return false;
  if (s.length > 1 && s[0] === "0") return false;
  return true;
}

function validateTicker(t) {
  if (typeof t !== "string") return false;
  if (t.length < 1 || t.length > 8) return false;
  return /^[A-Z0-9]+$/.test(t);
}

function validatePick(tier, pick) {
  if (typeof pick !== "string") return false;
  switch (tier) {
    case "iron":   return pick === "odd" || pick === "even";
    case "bronze": return pick.length === 1 && /^[0-9a-f]$/.test(pick);
    case "silver": return pick.length === 2 && /^[0-9a-f]{2}$/.test(pick);
    case "gold":   return pick.length === 3 && /^[0-9a-f]{3}$/.test(pick);
    default:       return false;
  }
}

/**
 * Parse a LUCKYPROTOCOL OP_RETURN payload (the ASCII string AFTER
 * stripping the OP_RETURN opcode + push prefix — see esplora.js's
 * `decodeOpReturnPayload` for the script-level decode that produces
 * this input). Returns one of:
 *
 *   { kind: "deploy", ticker }
 *   { kind: "bet",    tier, pick, ticker, winOutIdx, changeOutIdx? }
 *   { kind: "xfer",   ticker, amount: bigint, toOutIdx, changeOutIdx? }
 *
 * Or null on any structural problem.
 */
export function parsePayload(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("|");
  if (parts.length < 3) return null;
  if (parts[0] !== PROTOCOL_PREFIX) return null;
  const opcode = parts[1];

  // BET (tier name is the opcode)
  if (VALID_TIERS.has(opcode)) {
    // LUCKYPROTOCOL|<tier>|<pick>|<ticker>|<win_out_idx>[|<change_out_idx>]
    // Strict: exactly 5 or 6 parts (no trailing junk).
    if (parts.length !== 5 && parts.length !== 6) return null;
    const tier = opcode;
    const pick = parts[2];
    const ticker = parts[3];
    const winOutIdxStr = parts[4];
    if (!validateTicker(ticker)) return null;
    if (!validatePick(tier, pick)) return null;
    if (!isCanonicalUint(winOutIdxStr)) return null;
    const winOutIdx = parseInt(winOutIdxStr, 10);
    if (winOutIdx > MAX_OUT_IDX) return null;
    let changeOutIdx;
    if (parts.length === 6) {
      const c = parts[5];
      if (!isCanonicalUint(c)) return null;
      const cv = parseInt(c, 10);
      if (cv > MAX_OUT_IDX) return null;
      changeOutIdx = cv;
    }
    return { kind: "bet", tier, pick, ticker, winOutIdx, changeOutIdx };
  }

  if (opcode === "SEND") {
    // LUCKYPROTOCOL|SEND|<ticker>|<amount>|<to>[|<change>]
    if (parts.length !== 5 && parts.length !== 6) return null;
    const ticker = parts[2];
    const amountStr = parts[3];
    const toIdxStr = parts[4];
    if (!validateTicker(ticker)) return null;
    if (!isCanonicalUint(amountStr)) return null;
    if (amountStr.length > 20) return null;
    let amount;
    try { amount = BigInt(amountStr); } catch { return null; }
    if (amount < 1n || amount > MAX_SEND_AMT) return null;
    if (!isCanonicalUint(toIdxStr)) return null;
    const toOutIdx = parseInt(toIdxStr, 10);
    if (toOutIdx > MAX_OUT_IDX) return null;
    let changeOutIdx;
    if (parts.length === 6) {
      const c = parts[5];
      if (!isCanonicalUint(c)) return null;
      const cv = parseInt(c, 10);
      if (cv > MAX_OUT_IDX) return null;
      // SEND: change_out_idx == to_out_idx is ambiguous; indexer rejects.
      if (cv === toOutIdx) return null;
      changeOutIdx = cv;
    }
    return { kind: "xfer", ticker, amount, toOutIdx, changeOutIdx };
  }

  if (opcode === "DEPLOY") {
    // LUCKYPROTOCOL|DEPLOY|<ticker>
    if (parts.length !== 3) return null;
    const ticker = parts[2];
    if (!validateTicker(ticker)) return null;
    return { kind: "deploy", ticker };
  }

  return null;
}

// ----- Settlement predicate + tier rewards ---------------------------------
// Mirrors `is_hit` + `tier_reward` from luckyprotocol-indexer/src/protocol.rs.
// LUCKYPROTOCOL is a probabilistic mint: each MINE tx names a tier + pick;
// the confirming block's HASH decides win/loss via a tail-match (or
// die-roll for iron).

const TIER_REWARDS = {
  iron:    100n,
  bronze:  1_000n,
  silver:  10_000n,
  gold:    200_000n,
};

export function tierReward(tier) {
  return TIER_REWARDS[tier] || 0n;
}

/**
 * Settle a MINE bet given the confirming block's hash (lowercase hex
 * string from Esplora). Returns { win: bool, reward: bigint }.
 * `payload.changeOutIdx` and the broader indexer state aren't relevant
 * to settlement — settlement is pure-function on (tier, pick, hash).
 */
export function settleBet(payload, blockHash) {
  if (!payload || payload.kind !== "bet") return null;
  if (typeof blockHash !== "string" || blockHash.length < 8) return null;
  const hash = blockHash.toLowerCase();

  if (payload.tier === "iron") {
    // Iron uses an unbiased die-roll over the hash's last hex char.
    const tail = hash.slice(-1);
    const die = (parseInt(tail, 16) % 6) + 1; // 1..6
    const win =
      (payload.pick === "odd"  && die % 2 === 1) ||
      (payload.pick === "even" && die % 2 === 0);
    return { win, reward: win ? tierReward("iron") : 0n, die };
  }

  // Bronze / silver / gold use exact tail match.
  const k = payload.tier === "bronze" ? 1 : payload.tier === "silver" ? 2 : 3;
  const tail = hash.slice(-k);
  const win = payload.pick === tail;
  return { win, reward: win ? tierReward(payload.tier) : 0n, target: tail };
}
