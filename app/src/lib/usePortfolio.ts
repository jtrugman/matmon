import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_MATMON_DATA, type MatmonData } from '../data';
import { buildPortfolio, refreshQuotes } from './portfolio';
import { unlockNew } from './milestones';
import {
  getPriceCoverage,
  getSetting,
  listAccounts,
  listTransactions,
  loadUserProfile,
  setSetting,
} from './db/repos';
import { backfillHistoricalPrices, filterBackfillSymbols } from './quotes/backfill';
import { backfillInstruments } from './quotes/sector';
import { diag } from './db/diag';
import { getMarketStatus } from './marketHours';

/**
 * Settings key for the one-shot recovery backfill. Users who onboarded BEFORE
 * the historical-backfill code shipped have an empty `prices` table; without
 * this recovery they'd see a permanently-empty chart until they manually hit
 * Settings, Market data, Refresh history. This flag flips to "yes" after
 * the first successful recovery so subsequent launches don't re-trigger it.
 * Bumping to v2 is the canonical way to re-run the recovery if a future
 * shipping bug invalidates the original.
 */
export const BACKFILL_RECOVERY_V1_KEY = 'backfill.recovery.v1.complete';

/**
 * Per-symbol "we last tried to backfill this and got nothing" sentinel set.
 * Stored as a single comma-separated settings value so we don't need to
 * touch the instruments table or the schema. The auto-heal reads this on
 * boot: a symbol on the list is RETRIED on subsequent loads even when the
 * overall recovery flag is set to "yes" (partial success leaves it on so
 * we don't reset every symbol's coverage; the failed symbols deserve
 * another chance because the failure was likely transient).
 *
 * The list is bounded by the user's holdings, so the worst case is ~50
 * symbols, well below any settings-table size concern.
 */
export const BACKFILL_FAILED_SYMBOLS_KEY = 'backfill.failed.symbols.v1';

/**
 * Settings key for the most recent "all symbols failed" event. When this
 * is set to a recent ISO timestamp the App renders a banner pointing the
 * user at Settings, Market data, Refresh history. Cleared once any
 * subsequent recovery lands at least one symbol's bars.
 */
export const BACKFILL_LAST_FAILURE_KEY = 'backfill.last.failure.ts';

/**
 * Returns true while the global recovery backfill is in flight. HoldingDetailView
 * reads this so a per-symbol auto-backfill on the chart doesn't fire a parallel
 * fetch while the global recovery is already loading every symbol's history.
 *
 * Module-level state because both the App (via usePortfolio) and the chart
 * (via HoldingDetailView) need a single shared signal. A React context would
 * also work but adds boilerplate; this is one bool that needs no listeners.
 */
let recoveryInFlight = false;
const recoveryWaiters: Array<() => void> = [];

export function isBackfillRecoveryInFlight(): boolean {
  return recoveryInFlight;
}

/**
 * Resolve when the recovery completes. Safe to call when no recovery is in
 * flight: resolves immediately. HoldingDetailView calls this on mount when
 * a recovery has just started elsewhere, so it can paint the chart from the
 * freshly-populated prices table instead of firing a duplicate fetch.
 */
export function awaitBackfillRecovery(): Promise<void> {
  if (!recoveryInFlight) return Promise.resolve();
  return new Promise<void>(resolve => recoveryWaiters.push(resolve));
}

function notifyRecoveryDone(): void {
  while (recoveryWaiters.length > 0) {
    const next = recoveryWaiters.shift();
    try {
      next?.();
    } catch {
      // A waiter callback throwing must not block the rest of the queue.
    }
  }
}

/**
 * Recovery progress snapshot piped from `backfillHistoricalPrices.onProgress`
 * to the view layer. `done` is the count of symbols whose backfill has
 * settled (success OR failure), `total` is the held-symbol denominator. When
 * `done >= total` the recovery is essentially complete; HomeView still keys
 * its loading indicator off `recoveryInFlight` because the post-backfill
 * portfolio rebuild needs a moment to land.
 */
export type RecoveryProgress = {
  done: number;
  total: number;
};

export function usePortfolio(): {
  data: MatmonData;
  loading: boolean;
  reload: () => Promise<void>;
  refreshLivePrices: () => Promise<void>;
  /** Most recently fired milestone keys (FIFO). App.tsx reads and clears. */
  newUnlocks: string[];
  clearNewUnlocks: () => void;
  /** First name from user_profile, or null pre-onboarding. Views can fall back. */
  userName: string | null;
  /**
   * Banner text to show while the one-shot recovery backfill is running. Null
   * when no recovery is in flight. App.tsx renders this as a small toast.
   */
  recoveryNotice: string | null;
  /**
   * True while the global auto-heal backfill is fetching historical bars.
   * HomeView reads this so the chart slot renders a prominent loading
   * indicator instead of the manual "Open Settings, then Refresh history"
   * empty state. Flips back to false once every symbol's fetch has settled
   * and the post-backfill portfolio rebuild lands.
   */
  recoveryInFlight: boolean;
  /**
   * Per-symbol progress while the recovery backfill is running. Null when no
   * recovery is in flight. HomeView formats this as "Loading chart history
   * ... (3 of 13 symbols)".
   */
  recoveryProgress: RecoveryProgress | null;
  /**
   * User-facing message when the most recent recovery attempt failed to
   * land ANY bars (e.g. Yahoo unreachable, every symbol returned EMPTY).
   * Null when the recovery succeeded or hasn't run. App.tsx renders this
   * as a sticky notice with a link to Settings, Market data, Refresh
   * history. Cleared by `clearRecoveryError()` so the dismissal doesn't
   * require a reload.
   */
  recoveryError: string | null;
  /** Dismiss the recovery error banner without re-running the recovery. */
  clearRecoveryError: () => void;
  /**
   * Reset the once-per-session recovery gate so the next reload() can fire
   * a fresh attempt. Used by Settings, Backfill diagnostics, Force re-run
   * after clearing the persisted flag.
   */
  resetRecoveryAttempt: () => void;
} {
  const [data, setData] = useState<MatmonData>(EMPTY_MATMON_DATA);
  const [loading, setLoading] = useState(true);
  const [newUnlocks, setNewUnlocks] = useState<string[]>([]);
  const [userName, setUserName] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [recoveryInFlightState, setRecoveryInFlightState] = useState(false);
  const [recoveryProgress, setRecoveryProgress] = useState<RecoveryProgress | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // We only attempt recovery once per app session. Without this guard a
  // sequence of reload() calls (onboarding finish, dedupe migration, manual
  // refresh) could each kick off a recovery before the v1-complete flag has
  // been persisted, racing the same symbols multiple times.
  const recoveryAttemptedRef = useRef(false);
  // True once we've fired the once-per-session live-quote refresh on launch.
  // Without this, every reload() (dedupe migration, post-onboarding, post-
  // recovery) would re-fire the refresh and burn quote-cache misses.
  const liveRefreshAttemptedRef = useRef(false);

  const runMilestoneWatcher = useCallback(async (built: MatmonData) => {
    try {
      const fired = await unlockNew(built.holdings, built.totalValue);
      if (fired.length) setNewUnlocks(prev => [...prev, ...fired]);
    } catch {
      // Milestone detection is best-effort. Never block the UI on a watcher failure.
    }
  }, []);

  // One-shot global backfill recovery. Triggers when:
  //   - the user has accounts AND holdings (so there's something to chart), AND
  //   - the prices table is empty for every held symbol (no history at all), AND
  //   - we haven't run recovery this session, AND
  //   - the recovery-complete flag isn't already set, OR a previously-failed
  //     symbol from the persisted failed-list still has zero coverage.
  //
  // This rescues users who onboarded before the backfill orchestrator shipped:
  // their DB has accounts + transactions but no prices history, so the
  // portfolio chart and every HoldingDetailView chart would otherwise be empty
  // forever. We log every step under [matmon-diag] so the recovery is visible
  // when debugging.
  //
  // Per-symbol retry semantics (added for real-Yahoo hardening): when the
  // recovery completes with mixed ok/failed, the failed symbol set is
  // persisted to settings. Subsequent loads probe coverage per-symbol;
  // any persisted-failed symbol that STILL has zero coverage gets retried
  // (the new fetch enters the same backfill pipeline, just with a shorter
  // work list). That way a 13-symbol portfolio where 3 hit a transient
  // 429 self-heals on the next launch without forcing the user back to
  // Settings.
  const maybeRunRecovery = useCallback(
    async (built: MatmonData): Promise<void> => {
      if (recoveryAttemptedRef.current) return;
      if (built.holdings.length === 0) return;
      try {
        const done = await getSetting(BACKFILL_RECOVERY_V1_KEY).catch(() => null);
        const failedListRaw = await getSetting(BACKFILL_FAILED_SYMBOLS_KEY).catch(() => null);
        const previouslyFailed = new Set<string>(
          (failedListRaw || '')
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(Boolean),
        );
        // Probe coverage for every held symbol. If ANY symbol already has
        // stored price history, this isn't a virgin DB so the global recovery
        // isn't needed. But if a previously-failed symbol still has zero
        // coverage, we treat that symbol alone as the recovery target so
        // the retry actually fetches it.
        const heldSymbols = filterBackfillSymbols(built.holdings.map(h => h.sym));
        if (heldSymbols.length === 0) return;
        let anyCoverage = false;
        const missingCoverageSymbols: string[] = [];
        for (const sym of heldSymbols) {
          const cov = await getPriceCoverage(sym).catch(() => null);
          if (cov && cov.count > 0) {
            anyCoverage = true;
          } else {
            missingCoverageSymbols.push(sym);
          }
        }
        // Auto-heal: if the flag is set but the prices table has NO coverage
        // at all for any held symbol, the flag was set by the buggy older
        // code path (App.tsx and the recovery completion handler used to
        // set it unconditionally). Treat the impossible state as "not
        // complete" and run the recovery. Without this, Justin's actual
        // portfolio.db (which has flag=yes and zero price rows) would never
        // self-recover.
        // Also auto-heal: if the flag is set but at least one symbol from
        // the persisted failed list still has no coverage, retry just
        // those.
        let retryOnlyFailed = false;
        if (done === 'yes' && anyCoverage) {
          // Check whether any previously-failed symbols still have no
          // coverage; if so, fall through to a partial retry path.
          const stillFailedAndUncovered = missingCoverageSymbols.filter(s =>
            previouslyFailed.has(s),
          );
          if (stillFailedAndUncovered.length === 0) {
            recoveryAttemptedRef.current = true;
            return;
          }
          retryOnlyFailed = true;
          diag('portfolio', 'backfill-recovery retrying failed symbols', {
            count: stillFailedAndUncovered.length,
            symbols: stillFailedAndUncovered.slice(0, 5),
          });
        }
        if (done === 'yes' && !anyCoverage) {
          diag('portfolio', 'backfill-recovery flag set but no coverage; re-running');
          // Fall through to the recovery path below.
        }
        if (anyCoverage && !retryOnlyFailed) {
          // Set the flag so we don't re-check on every reload(). The user
          // already has SOME history, so the per-chart auto-backfill (in
          // HoldingDetailView) handles any remaining gaps incrementally.
          recoveryAttemptedRef.current = true;
          await setSetting(BACKFILL_RECOVERY_V1_KEY, 'yes').catch(() => {});
          return;
        }
        // Compute earliest tx date across all symbols. We use the transactions
        // table directly rather than holding.basis derivations because a tx
        // history can extend back further than the current position.
        let earliest = new Date();
        const txs = await listTransactions().catch(() => []);
        for (const t of txs) {
          const d = new Date(t.date);
          if (d < earliest) earliest = d;
        }
        // If the user somehow has holdings but no transactions, bail. The
        // earliest date would default to "now" which would produce a
        // zero-bar window.
        const accts = await listAccounts().catch(() => []);
        if (txs.length === 0 || accts.length === 0) {
          recoveryAttemptedRef.current = true;
          return;
        }
        // Narrow the work list when we're only retrying previously-failed
        // symbols. Otherwise the full held-symbol set is the work list.
        const targetSymbols = retryOnlyFailed
          ? missingCoverageSymbols.filter(s => previouslyFailed.has(s))
          : heldSymbols;
        recoveryAttemptedRef.current = true;
        recoveryInFlight = true;
        setRecoveryInFlightState(true);
        diag('portfolio', 'backfill-recovery starting', {
          symbols: targetSymbols.length,
          earliest: earliest.toISOString().slice(0, 10),
          retryOnlyFailed,
        });
        // Seed both progress + notice up front so HomeView can flip from
        // empty-state to loading-state on the same render that buildPortfolio
        // resolved on. Without the synchronous seed, there's a single render
        // where chartSeries is short and recoveryInFlightState is still false,
        // which would flash the manual CTA before the indicator appears.
        setRecoveryProgress({ done: 0, total: targetSymbols.length });
        setRecoveryNotice(
          `Loading chart history... (0 of ${targetSymbols.length} symbols)`,
        );
        // Clear any prior failure banner the moment we start a new
        // attempt; the only way to flip it back on is the all-failed
        // branch below.
        setRecoveryError(null);
        // Fire-and-forget so the initial render isn't blocked. The recovery
        // runs in the background; we rebuild the portfolio progressively as
        // each symbol's bars land so the chart visibly fills in instead of
        // staying static until everything completes. Backfill never throws,
        // but we wrap just in case so the in-flight flag is always cleared.
        (async () => {
          // Throttle the mid-flight rebuilds so a 50-symbol portfolio doesn't
          // run 50 buildPortfolio() passes in 5 seconds. We rebuild every
          // 2 symbols (or on the final one), which keeps the chart feeling
          // alive without thrashing.
          const REBUILD_EVERY = 2;
          let lastRebuildAt = 0;
          let inflightRebuild: Promise<void> | null = null;
          const triggerRebuild = () => {
            if (inflightRebuild) return; // skip if a rebuild's already running
            inflightRebuild = (async () => {
              try {
                const partial = await buildPortfolio();
                setData(partial);
              } catch (e) {
                console.error('[matmon] portfolio mid-recovery rebuild failed', e);
              } finally {
                inflightRebuild = null;
              }
            })();
            void inflightRebuild;
          };

          try {
            const onProgress = (done: number, total: number, symbol: string) => {
              setRecoveryProgress({ done, total });
              setRecoveryNotice(
                `Loading chart history... (${done} of ${total} symbols)`,
              );
              diag('portfolio', 'backfill-recovery progress', {
                done,
                total,
                symbol,
              });
              const shouldRebuild =
                done === total || done - lastRebuildAt >= REBUILD_EVERY;
              if (shouldRebuild) {
                lastRebuildAt = done;
                triggerRebuild();
              }
            };
            const result = await backfillHistoricalPrices(
              targetSymbols,
              earliest,
              onProgress,
            );
            diag('portfolio', 'backfill-recovery complete', {
              ok: result.ok.length,
              failed: result.failed.length,
            });
            // Persist the flag only when the recovery actually landed at
            // least one symbol's bars in the prices table. If EVERY symbol
            // failed (CORS block in browser dev, Yahoo down, etc.) we leave
            // the flag OFF so the next launch retries. Setting the flag on
            // an all-failed run is the bug that strands real users on the
            // qty-accumulation legacy chart forever, because subsequent
            // launches skip the recovery and the prices table stays empty.
            // Partial-success (some ok, some failed) IS sufficient to
            // mark complete: the legacy fallback is only used when there
            // is literally zero coverage anywhere, so any ok symbol means
            // buildHistoricalSeries takes the real-mark code path.
            if (result.ok.length > 0) {
              await setSetting(BACKFILL_RECOVERY_V1_KEY, 'yes').catch(() => {});
              // Clear the prior all-failed timestamp; the recovery
              // landed bars so we no longer want the failure banner.
              await setSetting(BACKFILL_LAST_FAILURE_KEY, '').catch(() => {});
            } else {
              diag('portfolio', 'backfill-recovery landed no bars, leaving flag off');
              // All symbols failed. Persist the failure timestamp so the
              // banner survives a reload until the next attempt succeeds,
              // and surface a clear message immediately so the user sees
              // why the chart is empty.
              await setSetting(
                BACKFILL_LAST_FAILURE_KEY,
                new Date().toISOString(),
              ).catch(() => {});
              setRecoveryError(
                "Couldn't reach Yahoo Finance. Retry from Settings, Market data, Refresh history, or check your network.",
              );
            }
            // Persist the failed-symbol list so subsequent loads retry
            // ONLY those, without re-fetching the symbols that succeeded
            // this time. When result.failed is empty we clear the list
            // entirely; partial recovery shrinks it.
            const persistedFailed = result.failed.join(',');
            await setSetting(BACKFILL_FAILED_SYMBOLS_KEY, persistedFailed).catch(
              () => {},
            );
            // Kick off sector backfill in parallel with the portfolio
            // rebuild. We DON'T await: the rebuild gives the user a populated
            // chart immediately, and the sector data follows whenever it
            // lands. backfillInstruments has its own 90-day cooldown so a
            // re-run after a future recovery is cheap.
            void backfillInstruments(heldSymbols).then(sectorResult => {
              diag('portfolio', 'backfill-recovery sector complete', {
                ok: sectorResult.ok.length,
                notFound: sectorResult.notFound.length,
                failed: sectorResult.failed.length,
              });
              // Trigger one more rebuild so sectors are reflected in the UI.
              // The dual-rebuild pattern is fine: buildPortfolio is fast
              // (no network) and the user only sees the chart update.
              if (sectorResult.ok.length > 0) {
                buildPortfolio()
                  .then(setData)
                  .catch(e =>
                    console.error('[matmon] portfolio rebuild after sector backfill failed', e),
                  );
              }
            });
            // Rebuild the portfolio so the freshly-landed bars show up in
            // the chart immediately, without waiting for the user to
            // refresh.
            try {
              const rebuilt = await buildPortfolio();
              setData(rebuilt);
            } catch (e) {
              console.error('[matmon] portfolio rebuild after recovery failed', e);
            }
          } catch (e) {
            console.error('[matmon] backfill recovery threw', e);
          } finally {
            recoveryInFlight = false;
            notifyRecoveryDone();
            setRecoveryNotice(null);
            setRecoveryProgress(null);
            setRecoveryInFlightState(false);
          }
        })();
      } catch (e) {
        // Failure here is non-fatal. Mark attempted so we don't pound the
        // probe path repeatedly on every reload.
        recoveryAttemptedRef.current = true;
        console.error('[matmon] backfill-recovery probe failed', e);
      }
    },
    [],
  );

  // One-shot live-quote refresh on first load: keeps the dashboard feeling
  // "live" without the user clicking Refresh quotes. We gate on three
  // conditions so we never block the UI and never burn unnecessary fetches:
  //
  //   1. Coverage exists for the held symbols (otherwise the recovery probe
  //      below is firing the historical backfill and we'd duplicate work).
  //   2. The last successful live fetch was more than 1 hour ago (or never).
  //   3. The market was open within the last 24h (so quotes likely moved).
  //
  // Fired AS A FIRE-AND-FORGET coroutine: this never blocks the chart
  // render or the recovery probe. When quotes land, the rebuild path
  // updates the in-memory state and the chart refreshes automatically.
  const maybeRefreshLiveQuotes = useCallback(
    async (built: MatmonData): Promise<void> => {
      if (liveRefreshAttemptedRef.current) return;
      if (built.holdings.length === 0) return;
      // Skip when recovery is in flight: the user is already getting a
      // full historical backfill and the live tick would compete for slots.
      if (recoveryInFlight) return;

      const syms = filterBackfillSymbols(built.holdings.map(h => h.sym));
      if (syms.length === 0) return;

      // Gate 1: coverage. If even one held symbol has zero coverage, we
      // skip; the recovery probe will catch it instead.
      try {
        for (const sym of syms) {
          const cov = await getPriceCoverage(sym).catch(() => null);
          if (!cov || cov.count === 0) return;
        }
      } catch {
        return;
      }

      // Gate 2: last live fetch > 1h ago. We piggyback on the localStorage
      // timestamp that HomeView's "Prices as of" label already maintains.
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const LIVE_FETCH_TS_KEY = 'matmon.quotes.lastLiveFetch.ts';
      let lastLive: number | null = null;
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(LIVE_FETCH_TS_KEY);
          const n = raw ? Number(raw) : NaN;
          if (Number.isFinite(n) && n > 0) lastLive = n;
        }
      } catch {
        // localStorage can throw in private-browsing mode; treat as null.
      }
      if (lastLive != null && Date.now() - lastLive < ONE_HOUR_MS) return;

      // Gate 3: market open within the last 24h. We treat "open right now"
      // OR "closed today (pre or post)" OR "closed weekend with last open
      // < 24h ago" as eligible. A long holiday gap that hasn't had a real
      // market session in 2+ days would otherwise still fire here; the
      // 1h gate above keeps that from spamming the network so we accept
      // the imprecision.
      const status = getMarketStatus();
      const eligible =
        status.state === 'open' ||
        status.state === 'closed_today_pre' ||
        status.state === 'closed_today_post' ||
        status.state === 'closed_weekend';
      if (!eligible) return;

      // Gate 4: visibility. Don't burn Yahoo requests while the tab is
      // hidden. The autoRefresh module honors the same rule (the ticker
      // pauses on visibilitychange) so this load-time refresh stays
      // consistent. Once the tab is foregrounded again, the user will
      // click around and re-trigger natural reloads, OR the autoRefresh
      // ticker (when enabled) will fire on its next interval.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      liveRefreshAttemptedRef.current = true;
      diag('portfolio', 'auto live-refresh starting', {
        symbols: syms.length,
        lastLive: lastLive != null ? new Date(lastLive).toISOString() : null,
        marketState: status.state,
      });
      try {
        await refreshQuotes(syms, { force: true });
        const rebuilt = await buildPortfolio();
        setData(rebuilt);
        await runMilestoneWatcher(rebuilt);
        diag('portfolio', 'auto live-refresh complete');
      } catch (e) {
        // Surface via the network log; never block UI on Yahoo blips.
        console.error('[matmon] auto live-refresh failed', e);
      }
    },
    [runMilestoneWatcher],
  );

  const reload = useCallback(async () => {
    try {
      const built = await buildPortfolio();
      setData(built);
      const profile = await loadUserProfile().catch(() => null);
      // First word of the saved name; null when the user hasn't onboarded yet.
      const first = profile?.name?.trim().split(/\s+/)[0] || null;
      setUserName(first);
      await runMilestoneWatcher(built);
      // Kick off recovery probe AFTER the first render of real data. We
      // don't await the result here: the recovery itself is async and we
      // already render the empty chart with the corrected hint while it
      // runs.
      await maybeRunRecovery(built);
      // Background live-quote refresh on every load when coverage is
      // already present. Fire-and-forget; don't block the render or any
      // other reload caller.
      void maybeRefreshLiveQuotes(built);
    } finally {
      setLoading(false);
    }
  }, [maybeRunRecovery, runMilestoneWatcher, maybeRefreshLiveQuotes]);

  const refreshLivePrices = useCallback(async () => {
    // Filter out cash / sweep symbols (SPAXX, FCASH) and empty strings so we
    // never ship a degenerate symbol to the upstream. The Yahoo chart endpoint
    // returns a generic non-result for the cash sweeps which would otherwise
    // wedge slots in the concurrency semaphore.
    const syms = Array.from(new Set(data.holdings.map(h => h.sym))).filter(
      s => !!s && s !== 'SPAXX' && s !== 'FCASH',
    );
    if (syms.length === 0) return;
    try {
      // force: true bypasses the 5-minute provider cache so an explicit user
      // click after a recent fetch still fires real requests. Without this
      // flag the button looks dead within the cache window (the symptom
      // Justin reported as "Refresh quotes doesn't seem to do anything").
      await refreshQuotes(syms, { force: true });
      const rebuilt = await buildPortfolio();
      setData(rebuilt);
      await runMilestoneWatcher(rebuilt);
    } catch {
      // Surface failures via the network log; never block the UI on a Yahoo blip.
    }
  }, [data.holdings, runMilestoneWatcher]);

  const clearNewUnlocks = useCallback(() => setNewUnlocks([]), []);

  useEffect(() => {
    reload();
  }, [reload]);

  const clearRecoveryError = useCallback(() => setRecoveryError(null), []);

  /**
   * Reset the per-session "we already attempted recovery" gate so the next
   * reload() can fire a fresh attempt. The Force re-run button in Settings
   * uses this AFTER it clears the persisted flag + failed list so the
   * follow-up reload picks up the cleared state and runs the recovery
   * again, instead of being blocked by the once-per-session ref.
   */
  const resetRecoveryAttempt = useCallback(() => {
    recoveryAttemptedRef.current = false;
  }, []);

  return {
    data,
    loading,
    reload,
    refreshLivePrices,
    newUnlocks,
    clearNewUnlocks,
    userName,
    recoveryNotice,
    recoveryInFlight: recoveryInFlightState,
    recoveryProgress,
    recoveryError,
    clearRecoveryError,
    resetRecoveryAttempt,
  };
}
