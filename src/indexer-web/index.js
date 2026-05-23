// Browser indexer orchestrator — singleton lifecycle.
//
// Responsibilities:
//   1. On first boot(): try to restore from IndexedDB snapshot. On
//      mismatch / corruption / fresh install, start cold from
//      LCKPROTOCOL_V1_HEIGHT.
//   2. Run the catch-up loop in the background (does NOT block boot();
//      the React UI binds to indexerStatus().scan_cursor for progress).
//   3. Keep a steady-state poll alive on a fixed interval to detect
//      new tip blocks.
//   4. Snapshot to IDB every SNAPSHOT_INTERVAL_BLOCKS blocks AND on
//      window 'beforeunload' (best-effort).
//
// Concurrency model: ONE scan can be in flight at a time. `_scanInFlight`
// is the mutex — both the initial cold-scan kick and every 30s poll
// tick funnel through `_catchUpToTip`, which is a no-op while another
// scan is running. WITHOUT this guard, the initial cold scan
// (long-running, e.g. 10+ minutes) and the periodic poll would BOTH
// mutate `state.indexedHeight` concurrently and the user would see
// the scan-cursor jitter back and forth in the UI (different
// concurrent loops at different blocks). The fix is to keep a single
// catch-up worker; the poll just re-arms it when it isn't already
// running.
//
// Module-level singleton state (no React Context). The api.js read
// functions pull from `_state` directly. The orchestrator owns the
// scanner promise + AbortController so a hot-reload during dev can
// cancel + restart cleanly.

import { newState, SNAPSHOT_INTERVAL_BLOCKS } from "./state.js";
import { loadSnapshot, saveSnapshot, wipeSnapshot } from "./storage.js";
import { coldScan } from "./scanner.js";
import { fastBootstrap } from "./fast_bootstrap.js";
import { followTokenSpends } from "./follow_spends.js";
import { getTipHeight } from "../chain-web/esplora.js";
import { LCKPROTOCOL_V1_HEIGHT } from "./protocol.js";

// Adaptive poll cadence — mirrors the desktop indexer's source.rs.
// When indexed_height == tip_height (caught up) we poll every
// POLL_INTERVAL_NORMAL_MS. When behind (catch-up still draining, or
// a new tip just landed) we drop to POLL_INTERVAL_FAST_MS so each
// new block lands in the UI within a poll cycle. Auto-reverts on
// catch-up.
const POLL_INTERVAL_NORMAL_MS = 10_000; // 10s — same as desktop normal
const POLL_INTERVAL_FAST_MS = 5_000;    // 5s — same as desktop fast

// External nudge — fires immediately if a caller (typically the React
// sync poller, which watches Esplora `/blocks/tip/height` on its own)
// detects a tip advance. The nudge wakes the poll loop right away
// instead of waiting up to POLL_INTERVAL_NORMAL_MS for the next
// scheduled tick. Drops observed lag from ~5s to ~one HTTP RTT.
let _pollNudgeResolver = null;

// ---- Singleton ---------------------------------------------------------

let _state = null;
let _ready = false;
let _booting = false;
let _abortCtrl = null;
let _pollTimer = null;
// MUTEX: only one catch-up scan runs at a time. The initial kick from
// boot() and every 30s poll tick both go through _catchUpToTip, which
// is a no-op when another scan is already in flight. Without this,
// concurrent scans race on state.indexedHeight and the UI cursor
// jumps backwards.
let _scanInFlight = false;
// Tracks the indexedHeight at the time of the most-recent persisted
// snapshot. Used by maybeSnapshot() to decide whether enough blocks
// have advanced to warrant another IDB write.
let _lastSnapshotHeight = -1;

export function isReady() {
  return _ready;
}

export function getState() {
  return _state;
}

/**
 * Initial boot: load snapshot → mark ready → kick first catch-up scan
 * → start periodic poll. Idempotent — calling twice is safe; the
 * second call is a no-op.
 *
 * Returns once the snapshot is loaded and tip is probed. The actual
 * catch-up scan runs in the background, and the React UI binds to
 * `indexerStatus().scan_cursor` for progress.
 */
export async function boot() {
  if (_booting || _ready) return;
  _booting = true;
  _abortCtrl = new AbortController();

  try {
    // STEP 1: restore from snapshot, or start fresh.
    const loaded = await loadSnapshot();
    const isColdStart = !loaded;
    _state = loaded || newState("bitcoin");
    _lastSnapshotHeight = _state.indexedHeight;

    // STEP 2: probe tip up front so the UI knows the catch-up target
    // (otherwise the overlay's progress denominator stays 0 until the
    // first scanBlock returns).
    try {
      _state.tipHeight = await getTipHeight();
    } catch (_e) {
      // Tip fetch failed — proceed anyway; the steady-state poll
      // will recover. _ready stays false until tip is known.
    }

    // STEP 2.5: FAST BOOTSTRAP for cold starts. Pull every DEPLOY +
    // MINE in chain history via the PROJECT_FEE_ADDRESS address index.
    // Skips empty-block scanning, drops first-sync time from minutes
    // to seconds.
    //
    // Done BEFORE flipping `_ready` so the UI doesn't briefly show
    // an empty token registry. If bootstrap fails (network error,
    // 4xx, etc.) we leave indexedHeight at activation-1 and let the
    // traditional catch-up handle the full range — the SCAN bar just
    // shows the old block-by-block progress in that case.
    if (isColdStart) {
      try {
        // PASS 1: pull every DEPLOY + MINE from PROJECT_FEE_ADDRESS
        // history. Builds the initial token UTXO set.
        const lastBootstrappedHeight = await fastBootstrap(_state, _abortCtrl?.signal);
        if (lastBootstrappedHeight != null) {
          _state.indexedHeight = lastBootstrappedHeight;
        }

        // PASS 2: walk forward from every token UTXO via Esplora
        // /tx/:txid/outspends, applying every SEND (or burn-on-
        // spend) that's touched our tracked set. This is what
        // catches the SENDs that fast bootstrap can't see (they
        // don't pay PROJECT_FEE_ADDRESS). Cheap — O(token UTXOs)
        // HTTP calls, rate-gated to 4 req/sec.
        if (_state.utxoBalances.size > 0) {
          await followTokenSpends(_state, _abortCtrl?.signal);
        }

        _lastSnapshotHeight = _state.indexedHeight;
        // Persist immediately so a refresh during the trailing
        // catch-up doesn't redo the bootstrap.
        await saveSnapshot(_state);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[indexer] fast-bootstrap errored, falling back to block-by-block scan:",
          e?.message || e);
        // Reset to activation-1 in case fastBootstrap got partway
        // through (the catch-up will redo from there).
        if (_state.indexedHeight < LCKPROTOCOL_V1_HEIGHT - 1) {
          _state.indexedHeight = LCKPROTOCOL_V1_HEIGHT - 1;
        }
      }
    }

    // Flip ready BEFORE the catch-up scan so the React UI can start
    // showing the overlay + querying indexerStatus(). Read APIs
    // against the restored snapshot are already authoritative for
    // everything up to indexedHeight.
    _ready = true;
    _booting = false;

    // Debug handle — paste `window.__INDEXER__.status()` in the browser
    // console to peek at the live state without spelunking through
    // React DevTools. Useful when SPEED stalls and you need to know
    // whether it's a stuck mutex, a frozen tip fetch, or an empty
    // scan range.
    if (typeof window !== "undefined") {
      window.__INDEXER__ = {
        status: () => ({
          ready: _ready,
          booting: _booting,
          scanInFlight: _scanInFlight,
          indexedHeight: _state?.indexedHeight,
          tipHeight: _state?.tipHeight,
          scanCursor: _state?.scanCursor,
          recentErrors: _state?.recentErrors?.slice(-5) ?? [],
        }),
        forceRescan: async () => {
          await _catchUpToTip();
        },
      };
    }

    // STEP 3: kick the catch-up scan in the background. This may take
    // many minutes on first ever boot (cold scan from activation
    // height to tip). Fire-and-forget; the UI binds to scan_cursor
    // for live progress.
    // eslint-disable-next-line no-console
    console.log("[indexer] boot complete — indexed=", _state.indexedHeight,
      "tip=", _state.tipHeight, "→ scanning",
      _state.tipHeight - _state.indexedHeight, "blocks");
    _catchUpToTip().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[indexer] catch-up errored:", e);
    });

    // STEP 4: start the steady-state poll. Each tick calls
    // _catchUpToTip — if it's still running from STEP 3, the mutex
    // short-circuits the tick. Once the initial catch-up finishes,
    // subsequent ticks fetch the latest tip + apply any new blocks
    // (usually 0 or 1 per tick).
    _startPolling();

    // Best-effort snapshot on tab close so we don't replay too much
    // on the next visit. beforeunload listeners must be sync, so we
    // fire-and-forget saveSnapshot.
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        if (_state) saveSnapshot(_state);
      });
    }
  } catch (e) {
    _booting = false;
    _ready = false;
    throw e;
  }
}

/**
 * Unified catch-up worker: fetch latest tip, scan every block from
 * indexedHeight+1 through tip. Guarded by `_scanInFlight` so
 * concurrent callers (boot's initial kick + every poll tick) are
 * serialized — the second caller no-ops while the first is running.
 *
 * This replaces the old separate `_runColdScan` + `pollOne` paths
 * which would race on state.indexedHeight and produce a jittery
 * progress cursor in the UI.
 */
async function _catchUpToTip() {
  if (!_state) return;
  if (_scanInFlight) return; // mutex: another catch-up is already running
  _scanInFlight = true;
  // eslint-disable-next-line no-console
  console.log("[indexer] catch-up start: indexed=", _state.indexedHeight,
    "tip=", _state.tipHeight);
  try {
    // Refresh tip before deciding the scan range. The poll tick path
    // needs this every iteration; the boot path benefits from it too
    // (covers the case where tip advanced during boot's IDB load).
    try {
      const newTip = await getTipHeight();
      // Tip regress (Esplora CDN serving a stale view, host failover
      // mid-block, etc.) — keep current tip, skip; never rewind.
      if (newTip >= _state.tipHeight) {
        _state.tipHeight = newTip;
      }
    } catch (_e) {
      // If tip fetch fails, fall through with the previously-known
      // tip. If that's still ahead of indexedHeight we can still
      // make progress on the gap.
    }

    const from = _state.indexedHeight + 1;
    const to = _state.tipHeight;
    if (from > to) return; // already caught up

    const before = _state.indexedHeight;
    await coldScan(
      _state,
      from,
      to,
      () => {
        maybeSnapshot();
      },
      _abortCtrl?.signal,
    );

    // After progress, force a final snapshot so the next boot can
    // resume cheaply without re-fetching the last batch.
    if (_state.indexedHeight > before) {
      await saveSnapshot(_state);
      _lastSnapshotHeight = _state.indexedHeight;
    }
    // eslint-disable-next-line no-console
    console.log("[indexer] catch-up done: applied",
      _state.indexedHeight - before, "blocks (now at", _state.indexedHeight, ")");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[indexer] catch-up failed:", e?.message || e);
  } finally {
    _scanInFlight = false;
  }
}

/**
 * Race a fixed sleep against an externally-triggered nudge promise.
 * Resolves when either fires. The nudge resolver is replaced on
 * every loop iteration so a single nudge() call only wakes the next
 * sleep, not all subsequent ones.
 */
function _waitNextTick(cadenceMs) {
  let nudge;
  const nudgePromise = new Promise((res) => { nudge = res; });
  _pollNudgeResolver = nudge;
  return Promise.race([
    new Promise((res) => setTimeout(res, cadenceMs)),
    nudgePromise,
  ]);
}

/**
 * External nudge — wakes the poll loop from its current sleep so the
 * next catch-up runs immediately. Idempotent: multiple nudges before
 * the loop wakes collapse into one wake.
 *
 * Called from the React sync poller when its independent
 * `/blocks/tip/height` probe sees the chain advance — much faster
 * than waiting up to POLL_INTERVAL_NORMAL_MS for the next scheduled
 * indexer tick.
 */
export function nudgePoll() {
  if (_pollNudgeResolver) {
    const r = _pollNudgeResolver;
    _pollNudgeResolver = null;
    r();
  }
}

function _startPolling() {
  if (_pollTimer) return;
  // Use a self-rescheduling async loop instead of setInterval so we
  // can pick the cadence (normal vs fast) AFTER each iteration based
  // on whether we're caught up. setInterval can't adapt mid-flight.
  let stopped = false;
  _pollTimer = { stop: () => { stopped = true; } };

  (async () => {
    while (!stopped) {
      try {
        await _catchUpToTip();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[indexer] poll error:", e);
      }
      if (stopped) break;
      // Cadence selection — fast while we're still draining a gap,
      // normal once we're at tip. Mirrors desktop source.rs's
      // current_poll_secs logic.
      const cadence = _state && _state.indexedHeight < _state.tipHeight
        ? POLL_INTERVAL_FAST_MS
        : POLL_INTERVAL_NORMAL_MS;
      await _waitNextTick(cadence);
    }
  })();
}

/**
 * Snapshot to IDB iff at least SNAPSHOT_INTERVAL_BLOCKS have advanced
 * since the last persisted snapshot. Best-effort; storage failures
 * are logged but don't stop the scan.
 */
function maybeSnapshot() {
  if (!_state) return;
  if (_state.indexedHeight - _lastSnapshotHeight < SNAPSHOT_INTERVAL_BLOCKS) {
    return;
  }
  _lastSnapshotHeight = _state.indexedHeight;
  // Fire-and-forget so we don't block the scan loop on disk I/O.
  saveSnapshot(_state);
}

/**
 * SETTINGS → RESCAN INDEXER entry point. Forces a clean cold-rescan:
 *   1. Cancel any in-flight scan via the AbortController.
 *   2. Tear down the singleton (state, timers, ready flag).
 *   3. Wipe the IndexedDB snapshot so loadSnapshot returns null next boot.
 *   4. Re-run boot() — which starts a fresh cold scan from activation.
 *
 * Resolves once the new boot() has finished its setup phase (snapshot
 * load + tip probe). The actual rescan continues in the background as
 * usual; the React caller can show a toast and let the existing
 * indexer-status overlay take over.
 *
 * Useful when:
 *   - the user suspects state corruption (balances look wrong)
 *   - a cohort bump just landed and you want to force a recompute
 *     without waiting for the schemaVersion-mismatch path to trip
 *   - dev / QA work
 */
export async function wipeAndRescan() {
  shutdown();
  await wipeSnapshot();
  // Drop the in-memory state so boot() takes the fresh-install path.
  _state = null;
  _lastSnapshotHeight = -1;
  await boot();
}

/**
 * Stop polling + abort any in-flight catch-up. Used by tests, by the
 * Settings → WIPE WALLET flow (which also nukes the indexer DB), and
 * by the RESCAN INDEXER button.
 */
export function shutdown() {
  if (_pollTimer) {
    // _pollTimer is now a { stop } handle, not a setInterval id.
    _pollTimer.stop?.();
    _pollTimer = null;
  }
  // Resolve any pending nudge so the awaiter doesn't dangle.
  if (_pollNudgeResolver) {
    const r = _pollNudgeResolver;
    _pollNudgeResolver = null;
    r();
  }
  if (_abortCtrl) {
    _abortCtrl.abort();
    _abortCtrl = null;
  }
  _ready = false;
  _booting = false;
  _scanInFlight = false;
  // Drop the abort signal too so the next boot creates a fresh one.
  // Without this, a wipe+rescan would reuse the already-aborted
  // controller and the new scan's signal.aborted check would
  // trip immediately, looking like an instant scan failure.
  _abortCtrl = null;
}

// ---- Re-export the public read API -------------------------------------
//
// Consumers (src/protocol/global_indexer.js) import everything from this
// one entrypoint — `indexerStatus`, `fetchBalances`, etc. — so the
// internal module split stays an implementation detail.
export {
  indexerStatus,
  fetchBalances,
  fetchUtxoBalances,
  fetchBets,
  fetchTransfers,
  fetchTokensPaged,
  fetchTokenHolders,
} from "./api.js";
