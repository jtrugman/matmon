// Historical price backfill orchestrator. Wraps fetchHistoricalDaily +
// bulkUpsertPrices for a batch of symbols, with progress callback and
// "already covered, skip" short-circuits so re-running the backfill after a
// small new import doesn't refetch 7000 days × N symbols.
//
// This is the bridge that lets the portfolio chart show a real
// mark-to-market NAV curve. Without this, buildRealSeries in portfolio.ts
// falls back to qty × current price which produces the +323% YTD garbage
// Justin reported.

import { bulkUpsertPrices, getPriceCoverage } from '../db/repos';
import { fetchHistoricalDaily } from './history';
import { isOffline } from './index';

/** Symbols that aren't real equities/ETFs. Yahoo's chart endpoint returns
 *  a useless meta-only response for these, so we skip them at the source
 *  rather than burn HTTP requests + log noise on every backfill run.
 *
 *  Keep this list synchronized with the cash-sweep filter in
 *  usePortfolio.refreshLivePrices and the portfolio NAV builder: a symbol
 *  that's a cash sweep should never appear in any of those three filters by
 *  inclusion alone. Centralizing the list here would be cleaner but pulls
 *  the import graph in directions that aren't worth it for ~half a dozen
 *  strings. */
const CASH_SWEEP_SYMBOLS = new Set<string>([
  'SPAXX',
  'FCASH',
  'FZFXX',
  'FDRXX',
  'VMRXX',
  'VMSXX',
  'VMFXX',
  'QACDS',
  'CASH',
]);

/** Drop cash-sweep / money-market tickers and dedupe. Exported for the
 *  callers (App.finishOnboarding, AddAccountView.confirmImport) so they
 *  filter symbols the same way the backfill orchestrator does. */
export function filterBackfillSymbols(symbols: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const s of symbols) {
    if (!s) continue;
    const upper = s.trim().toUpperCase();
    if (!upper) continue;
    if (CASH_SWEEP_SYMBOLS.has(upper)) continue;
    out.add(upper);
  }
  return Array.from(out);
}

export interface BackfillOptions {
  /** Force re-fetch even when stored coverage already spans the requested
   *  window. Default false: skip the symbol if `[earliestDate, today]` is
   *  fully covered by the prices table. The "Refresh history" button in
   *  Settings sets this to true so the user can rebuild after a Yahoo
   *  correction. */
  force?: boolean;
}

export interface BackfillResult {
  /** Symbols whose history was fully (or already) covered after the run. */
  ok: string[];
  /** Symbols that failed to fetch (network down, Yahoo returned nothing). */
  failed: string[];
}

/**
 * One day in ms. Yahoo's coverage check below uses this as the slack so we
 * don't pointlessly re-fetch when the user opens the app the day after their
 * last sync.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pull daily-close history for each symbol from `earliestDate` to today,
 * persisting into the `prices` table. Skips symbols whose stored coverage
 * already spans the window (unless `opts.force === true`). Fires the
 * progress callback once per symbol after the symbol finishes.
 *
 * Returns `{ ok, failed }` so the UI can surface a "history for 3 of 17
 * symbols failed" message. We never throw out of this function: the
 * portfolio still works with partial coverage (forward-fill papers over
 * gaps), so a single Yahoo blip can't cancel an entire onboarding flow.
 *
 * Offline mode is honored: if `isOffline()` returns true we return an
 * all-failed result immediately. The caller decides whether to surface that
 * as "you're offline, history won't backfill" or to silently continue.
 */
export async function backfillHistoricalPrices(
  symbols: string[],
  earliestDate: Date,
  onProgress?: (done: number, total: number, symbol: string) => void,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const cleaned = filterBackfillSymbols(symbols);
  if (cleaned.length === 0) return { ok: [], failed: [] };
  if (isOffline()) return { ok: [], failed: cleaned };

  const today = new Date();
  // Strip time-of-day so the coverage check is at day-granularity. Yahoo's
  // earliest-bar date for any given day is the UTC market open; comparing
  // against a 14:30 "earliestDate" would needlessly fail.
  const wantedStart = new Date(
    Date.UTC(
      earliestDate.getUTCFullYear(),
      earliestDate.getUTCMonth(),
      earliestDate.getUTCDate(),
    ),
  );
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  const force = opts.force === true;
  const ok: string[] = [];
  const failed: string[] = [];

  // Fast-fail circuit breaker. If the first 2 symbols both fail with no
  // bars (CORS block, Yahoo down, DNS), we assume something systemic and
  // mark the rest as failed without burning a real fetch budget on each.
  // This keeps the browser-dev e2e tests (where Yahoo is unreachable via
  // CORS) from timing out the onboarding spinner. In the Tauri build the
  // HTTP plugin sidesteps CORS, so the breaker never trips in production.
  // The first symbol's failure costs ~1.5s (one retry inside history.ts);
  // the second costs another ~1.5s; we then short-circuit the remaining
  // ~12 symbols and the whole backfill returns in ~3s.
  const FAIL_FAST_THRESHOLD = 2;
  let consecutiveFailures = 0;
  let circuitOpen = false;

  // We intentionally process symbols SEQUENTIALLY at this layer; the
  // request semaphore in yahoo.ts handles intra-symbol concurrency for
  // any internal parallelism we add later. Sequential here keeps progress
  // events monotonic and means a single retry doesn't fight 16 other
  // symbols for the request slot.
  for (let i = 0; i < cleaned.length; i++) {
    const sym = cleaned[i];
    try {
      if (!force) {
        const coverage = await getPriceCoverage(sym);
        if (coverage) {
          const earliestOk = +coverage.earliest <= +wantedStart + ONE_DAY_MS;
          // Latest within 1 day of today = "fresh enough", skip the fetch.
          const latestOk = +todayStart - +coverage.latest <= ONE_DAY_MS;
          if (earliestOk && latestOk) {
            ok.push(sym);
            consecutiveFailures = 0;
            onProgress?.(i + 1, cleaned.length, sym);
            continue;
          }
        }
      }
      if (circuitOpen) {
        // Circuit tripped earlier; don't fetch the rest.
        failed.push(sym);
        onProgress?.(i + 1, cleaned.length, sym);
        continue;
      }
      const bars = await fetchHistoricalDaily(sym, wantedStart, today);
      if (bars.length === 0) {
        failed.push(sym);
        consecutiveFailures++;
        if (consecutiveFailures >= FAIL_FAST_THRESHOLD) {
          circuitOpen = true;
        }
      } else {
        await bulkUpsertPrices(
          sym,
          bars.map(b => ({ date: new Date(`${b.date}T00:00:00.000Z`), close: b.close })),
        );
        ok.push(sym);
        consecutiveFailures = 0;
      }
    } catch {
      // Per-symbol failure is logged via the network log (history.ts) and
      // surfaces as a gap in the chart for THIS symbol only. We continue so
      // a single symbol can't cancel the rest of the backfill.
      failed.push(sym);
      consecutiveFailures++;
      if (consecutiveFailures >= FAIL_FAST_THRESHOLD) {
        circuitOpen = true;
      }
    } finally {
      onProgress?.(i + 1, cleaned.length, sym);
    }
  }
  return { ok, failed };
}
