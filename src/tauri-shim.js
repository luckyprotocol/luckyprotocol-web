// Tauri runtime shim for the web build.
//
// The desktop app's `protocol/*.js` modules import `invoke` from
// `@tauri-apps/api/core` to call Rust commands (`cmd_sync_address`,
// `cmd_publish_bet`, etc). In the web build there is no Tauri runtime
// and no Rust backend — every command needs a JS reimplementation.
//
// Rather than scatter `if (typeof window.__TAURI_INTERNALS__) ... else`
// branches through every callsite, we centralize the missing runtime
// in this single shim. Each module that used to do:
//
//   import { invoke } from "@tauri-apps/api/core";
//
// now does:
//
//   import { invoke } from "../tauri-shim.js";
//
// The shim's `invoke(cmd, args)` throws a structured error naming the
// command and which web port phase it belongs to. This guarantees:
//
//   1. The bundler doesn't barf on the missing @tauri-apps/api package.
//   2. The UI still loads — only the broken command paths throw.
//   3. When a user clicks an unimplemented action, devtools shows
//      exactly which Rust command needs porting.
//
// As individual commands get reimplemented in their own JS modules
// (e.g. browser wallet, bitcoinjs-lib tx construction, etc.), each
// callsite migrates off this shim to the real implementation. The shim
// then naturally empties out; when it's empty we delete it.
//
// `inTauri()` is also re-exported for legacy callsites that gate on
// "are we running inside the Tauri shell". In the web build the answer
// is always false; the shim returns false unconditionally so those
// branches take the (currently empty) web fallback path.

export function inTauri() {
  return false;
}

const COMMAND_TO_PHASE = {
  // Phase 2 — browser wallet (Argon2id + Web Crypto AES-GCM + IndexedDB)
  cmd_wallet_exists:       "Phase 2 (wallet)",
  cmd_generate_mnemonic:   "Phase 2 (wallet)",
  cmd_commit_wallet:       "Phase 2 (wallet)",
  cmd_export_mnemonic:     "Phase 2 (wallet)",
  cmd_verify_password:     "Phase 2 (wallet)",
  cmd_change_password:     "Phase 2 (wallet)",
  cmd_wipe_wallet:         "Phase 2 (wallet)",
  cmd_get_wallet_info:     "Phase 2 (wallet)",

  // Phase 3 — bitcoinjs-lib tx construction + signing
  cmd_publish_bet:         "Phase 3 (tx construction)",
  cmd_publish_transfer:    "Phase 3 (tx construction)",
  cmd_publish_deploy:      "Phase 3 (tx construction)",
  cmd_send_to_address:     "Phase 3 (tx construction)",
  cmd_split_utxo:          "Phase 3 (tx construction)",

  // Phase 4 — chain queries (mempool.space direct fetch)
  cmd_sync_address:        "Phase 4 (chain queries)",
  cmd_get_chain_state:     "Phase 4 (chain queries)",
  cmd_list_address_txs:    "Phase 4 (chain queries)",
  cmd_get_tx_status:       "Phase 4 (chain queries)",
  cmd_get_block_hash_at:   "Phase 4 (chain queries)",
  cmd_get_block_info_at:   "Phase 4 (chain queries)",

  // Phase 5 — browser indexer (port of luckyprotocol-indexer to TS/JS)
  cmd_start_indexer:       "Phase 5 (browser indexer)",
  cmd_stop_indexer:        "Phase 5 (browser indexer)",
  cmd_indexer_status:      "Phase 5 (browser indexer)",

  // Settings — Alchemy key, core-rpc — these don't apply in the web
  // build at all; the browser indexer talks directly to public Esplora.
  // Will be deleted from UI entirely in a later cleanup pass.
  cmd_get_alchemy_key:     "Phase 4 (chain queries) — may be removed",
  cmd_set_alchemy_key:     "Phase 4 (chain queries) — may be removed",
  cmd_set_core_rpc:        "Phase 4 (chain queries) — may be removed",

  // Misc
  cmd_open_external:                  "Phase 1 (UI cleanup) — use window.open instead",
  "plugin:opener|open_url":           "Phase 1 (UI cleanup) — use window.open instead",
};

export async function invoke(command, args) {
  const phase = COMMAND_TO_PHASE[command] || "unknown — not yet mapped";
  const err = new Error(
    `[tauri-shim] Rust command \`${command}\` is not available in the web build ` +
    `(needs reimplementation: ${phase}). ` +
    `Args were: ${args ? JSON.stringify(args).slice(0, 200) : "(none)"}.`
  );
  err.code = "TAURI_SHIM_NOT_IMPLEMENTED";
  err.command = command;
  err.phase = phase;
  throw err;
}
