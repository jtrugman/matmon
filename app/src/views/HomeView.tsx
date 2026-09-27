import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PageHead } from '../components/PageHead';
import { Timeframe } from '../components/Timeframe';
import { PortfolioChart } from '../components/charts/PortfolioChart';
import { Donut } from '../components/charts/Donut';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { EmptyState } from '../components/EmptyState';
import { fmtMoney, fmtPct, fmtDate, formatPricesAsOf } from '../lib/format';
import { annualizeTwr, flowsFromTransactions, twrOverWindow, xirr } from '../lib/performance';
import { getLatestPriceFetchTime, loadAllTransactions } from '../lib/db/repos';
import { latestSuccessfulQuoteFetch, networkLog } from '../lib/quotes/log';
import { describeMarketStatus, getMarketStatus } from '../lib/marketHours';
import {
  normalizeToBaseline,
  segmentWindow,
  windowSeries,
} from '../lib/portfolio';
import { backfillHistoricalPrices } from '../lib/quotes/backfill';
import type { MatmonData, SeriesPoint } from '../data';

/** Segmented-control segment IDs. Kept in sync with the Timeframe component's
 *  options array; centralized here so the segmentWindow() type accepts the
 *  same union the user clicks. */
type DateRangeSegment = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL';
const VALID_SEGMENTS: ReadonlyArray<DateRangeSegment> = [
  '1M',
  '3M',
  '6M',
  'YTD',
  '1Y',
  '3Y',
  '5Y',
  'ALL',
] as const;
function asSegment(v: string): DateRangeSegment {
  return (VALID_SEGMENTS as readonly string[]).includes(v) ? (v as DateRangeSegment) : 'ALL';
}

// useSyncExternalStore demands a referentially stable getSnapshot result
// between subscribe-fired updates. networkLog.list() allocates fresh, but
// latestSuccessfulQuoteFetch() returns a Date (immutable identity) so we
// cache it on a per-flip basis. The mirror module SettingsView already
// uses the same pattern with networkLog.list(); we replicate it here so
// HomeView and SettingsView agree on when the store has changed.
let pricesAsOfSnapshot: number | null = null;
let pricesAsOfDirty = true;
networkLog.subscribe(() => {
  pricesAsOfDirty = true;
});

function readLatestQuoteTime(): number | null {
  if (pricesAsOfDirty) {
    const d = latestSuccessfulQuoteFetch();
    pricesAsOfSnapshot = d ? d.getTime() : null;
    pricesAsOfDirty = false;
  }
  return pricesAsOfSnapshot;
}

/**
 * localStorage key for the most recent LIVE quote-refresh timestamp (ms since
 * epoch). We track this OUTSIDE the network log because the log conflates
 * live-quote requests with the historical-bar backfill: both hit
 * query1.finance.yahoo.com, both stamp `ok: true`, but only the live path
 * answers "when did we last refresh prices for the user". A historical
 * backfill at onboarding stamps `t: now` while its data is months old, which
 * was contaminating the "Prices as of …" label on Home.
 *
 * Writers: the Refresh quotes button (HomeView), and any new successful
 * Yahoo entry that appears in the network log AFTER HomeView mount (this
 * catches auto-refresh ticks the user opted into in Settings without
 * needing to plumb a callback through autoRefresh.ts).
 *
 * Readers: HomeView's "Prices as of …" label resolution.
 */
const LIVE_FETCH_TS_KEY = 'matmon.quotes.lastLiveFetch.ts';

/**
 * "Prices may be stale" threshold. Beyond 12 hours from the last live fetch
 * we show an explicit nudge in the header inviting the user to click
 * Refresh quotes. 12h matches the spec; it's roughly a "since you last
 * looked at this app yesterday afternoon" window.
 */
const STALE_QUOTE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

function readLiveFetchSetting(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LIVE_FETCH_TS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeLiveFetchSetting(ms: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LIVE_FETCH_TS_KEY, String(ms));
  } catch {
    // localStorage can throw in private-browsing mode; the in-memory log
    // still tracks the timestamp for this session, so a write failure is
    // a soft miss rather than a hard error.
  }
}

// Greeting pools. Every phrase is 3 words or fewer per Justin's spec. Pools
// rotate by time of day (morning/afternoon/evening/late) and weekday vs weekend
// (Sat/Sun get their own pool per slot). One phrase is picked at random on
// mount, so the same hour produces a fresh phrase on every reload.
const GREETINGS = {
  morningWeekday: [
    'Top of the morning',
    'Rise and shine',
    'Coffee’s on',
    'Early bird',
    'Morning, friend',
    'Up and at ’em',
  ],
  morningWeekend: [
    'Slow morning',
    'Lazy Sunday',
    'Pajama check',
    'Coffee’s on',
    'Easy does it',
    'Weekend brunch',
  ],
  afternoonWeekday: [
    'Afternoon check',
    'Hey there',
    'Quick look?',
    'Halfway home',
    'Lunch break?',
    'Mid-day peek',
  ],
  afternoonWeekend: [
    'Weekend mode',
    'Hey there',
    'Slow afternoon',
    'Lazy Saturday',
    'No rush',
    'Just chilling',
  ],
  eveningWeekday: [
    'Evening, friend',
    'Day’s done',
    'Welcome back',
    'After-hours peek',
    'Cozy hours',
    'Wind down',
  ],
  eveningWeekend: [
    'Evening, friend',
    'Wind down',
    'Soft evening',
    'Hey, you',
    'Weekend vibes',
    'Pajama time',
  ],
  lateWeekday: ['Up late?', 'Night owl', 'Burning oil', 'Past bedtime', 'Hello, night', 'Insomnia mode'],
  lateWeekend: ['Night owl', 'Late one?', 'Pajama o’clock', 'Past bedtime', 'Weekend night', 'Up late?'],
};

function pickGreeting(now: Date): string {
  const h = now.getHours();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  let pool: string[];
  if (h >= 5 && h < 12) pool = isWeekend ? GREETINGS.morningWeekend : GREETINGS.morningWeekday;
  else if (h >= 12 && h < 17) pool = isWeekend ? GREETINGS.afternoonWeekend : GREETINGS.afternoonWeekday;
  else if (h >= 17 && h < 21) pool = isWeekend ? GREETINGS.eveningWeekend : GREETINGS.eveningWeekday;
  else pool = isWeekend ? GREETINGS.lateWeekend : GREETINGS.lateWeekday;
  return pool[Math.floor(Math.random() * pool.length)];
}

function useGreeting() {
  // Pick once on mount so the phrase is stable while the view is open even as
  // async name resolution flips the title text from "there" to a real name.
  // A fresh reload of Home gives you a new phrase.
  return useMemo(() => pickGreeting(new Date()), []);
}

type Props = {
  data: MatmonData;
  chartVariant: 'area' | 'line' | 'bars';
  onNavigate: (view: string) => void;
  onAddAccount?: (brokerage?: string) => void;
  /**
   * Triggered when the user clicks the "Refresh quotes" button. The view tracks
   * its own busy state while the returned promise is pending so we can show a
   * spinner without leaking the implementation back up to App.tsx.
   */
  onRefreshQuotes?: () => void | Promise<void>;
  /**
   * Triggered after the lazy SPY backfill writes new rows into the prices
   * table. The chart's data.spy field is read at buildPortfolio() time, so
   * after fresh bars land we need a rebuild for the dashed SPY line to
   * actually show up. Without this hook the SPY pill toggles on, the
   * backfill fires successfully, but the chart silently stays single-line
   * until the user navigates away and back.
   */
  onReload?: () => void | Promise<void>;
  userName?: string | null;
  /**
   * True while the global auto-heal backfill is fetching historical bars.
   * When set, the chart's empty-state slot renders a prominent
   * "Loading chart history..." indicator instead of the manual
   * "Open Settings, then Refresh history" CTA. This is what makes the
   * auto-heal feel automatic instead of static.
   */
  recoveryInFlight?: boolean;
  /**
   * Per-symbol progress while the recovery backfill is running. Drives the
   * "(3 of 13 symbols)" suffix on the loading indicator. Null when no
   * recovery is in flight.
   */
  recoveryProgress?: { done: number; total: number } | null;
  /**
   * True while the initial portfolio load is in flight. Used together with
   * `recoveryInFlight` to drive the loading-indicator: between buildPortfolio
   * resolving and the recovery probe flipping the in-flight flag, `loading`
   * is still true, so we keep the indicator up during that gap rather than
   * flashing the manual CTA.
   */
  loading?: boolean;
};

// 1.6s afterglow on the post-refresh "Updated" status pill, then we revert to
// the idle "Refresh quotes" label. Long enough for the user to register the
// confirmation, short enough not to feel like a sticky badge.
const REFRESH_AFTERGLOW_MS = 1600;

export function HomeView({
  data,
  chartVariant,
  onNavigate,
  onAddAccount,
  onRefreshQuotes,
  onReload,
  userName,
  recoveryInFlight = false,
  recoveryProgress = null,
  loading = false,
}: Props) {
  const [timeframe, setTimeframe] = useState<DateRangeSegment>('5Y');
  const [showBenchmark, setShowBenchmark] = useState(true);
  // Backfill the SPY benchmark on demand. The first time the user toggles
  // the "vs SPY (S&P 500)" pill on (or on mount when it defaults to on
  // and the prices table is empty for SPY), we fire a one-shot backfill
  // covering the portfolio's history window. Subsequent toggles read the
  // already-cached bars from the prices table via the next buildPortfolio
  // call. backfillHistoricalPrices's coverage check skips the fetch when
  // SPY is already covered, so this is cheap on repeat.
  const [spyBackfillTriggered, setSpyBackfillTriggered] = useState(false);
  // Refresh-quotes button state. 'idle' → 'refreshing' on click, → 'done' for
  // a brief afterglow on success, back to 'idle'. We track this locally so
  // the button has visible feedback even when the upstream fetch is sub-second.
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'done'>('idle');

  // "Prices as of …" timestamp under the total figure. Resolved in priority
  // order:
  //   1. localStorage `matmon.quotes.lastLiveFetch.ts`, written by THIS
  //      view when the user clicks Refresh quotes (and updated when a new
  //      successful Yahoo entry appears in the in-memory networkLog after
  //      this view mounted, which covers the auto-refresh path).
  //   2. The freshest in-memory networkLog entry for query1.finance.yahoo.com
  //      with ok === true that landed AFTER this view mounted. (Pre-mount
  //      entries are excluded because they are usually historical-backfill
  //      hits from onboarding or import; same host, same status, but they
  //      tell us when we last fetched historical bars, not when we last
  //      pulled a live quote.)
  //   3. If both are empty, fall back to the highest fetched_at across
  //      the prices table, BUT only when it's plausibly recent (within
  //      the last day). A `fetched_at` from a multi-day-old backfill
  //      would otherwise render as a Friday timestamp on a Monday, which
  //      is exactly the bug Justin reported. Older fetched_at values
  //      collapse to "Prices not yet fetched" so the user is nudged to
  //      click Refresh quotes.
  //   4. If all of the above are empty: render "Prices not yet fetched".

  // Anchor: the moment this view first rendered. Used to ignore networkLog
  // entries that landed BEFORE mount (those are usually onboarding-time
  // historical-bar fetches, not live quotes the user kicked off).
  const [mountTimeMs] = useState<number>(() => Date.now());

  const subscribeNetworkLog = useCallback((cb: () => void) => networkLog.subscribe(cb), []);
  const latestQuoteMsFromLog = useSyncExternalStore(
    subscribeNetworkLog,
    readLatestQuoteTime,
    readLatestQuoteTime,
  );

  // The "live" timestamp we trust. Initialized from localStorage so a fresh
  // mount after a session restart still shows the last known live fetch.
  // Updated when (a) the user clicks Refresh quotes (handled below in the
  // click handler), or (b) a new successful Yahoo entry lands in the
  // networkLog AFTER mount.
  const [liveFetchMs, setLiveFetchMs] = useState<number | null>(() => readLiveFetchSetting());

  useEffect(() => {
    // Only honor log entries that landed AFTER this view mounted. The
    // historical-bar backfill at onboarding finish stamps the log with
    // `t: now` and would otherwise contaminate the "Prices as of …" label
    // with a timestamp that has nothing to do with live quotes.
    if (latestQuoteMsFromLog == null) return;
    if (latestQuoteMsFromLog < mountTimeMs) return;
    if (liveFetchMs != null && latestQuoteMsFromLog <= liveFetchMs) return;
    setLiveFetchMs(latestQuoteMsFromLog);
    writeLiveFetchSetting(latestQuoteMsFromLog);
  }, [latestQuoteMsFromLog, mountTimeMs, liveFetchMs]);

  // DB fallback. Kept as a last resort, gated by recency: a `fetched_at`
  // older than 24h is treated as too unreliable to surface (likely a
  // historical-backfill artifact, not a real live-quote timestamp).
  const [dbFallbackMs, setDbFallbackMs] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getLatestPriceFetchTime();
        if (!cancelled) setDbFallbackMs(d ? d.getTime() : null);
      } catch {
        if (!cancelled) setDbFallbackMs(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-read the DB fallback whenever the live-log timestamp ticks
    // forward. After a successful refresh writes new rows into the
    // prices table, this hop ensures the "Prices as of …" label keeps
    // working even if the in-memory log is later cleared (e.g. user
    // navigates to Settings → Privacy and clicks Clear).
  }, [latestQuoteMsFromLog]);

  const pricesAsOfLabel = useMemo(() => {
    const nowMs = Date.now();
    // Priority 1+2: the live timestamp we've already filtered for post-mount
    // freshness OR localStorage continuity.
    if (liveFetchMs != null) {
      return formatPricesAsOf(new Date(liveFetchMs));
    }
    // Priority 3: DB fallback, but only when reasonably recent. Anything
    // older than 24h is almost certainly a historical-backfill artifact.
    if (dbFallbackMs != null && nowMs - dbFallbackMs < 24 * 60 * 60 * 1000) {
      return formatPricesAsOf(new Date(dbFallbackMs));
    }
    return formatPricesAsOf(null);
  }, [liveFetchMs, dbFallbackMs]);

  // True when the live-quote timestamp is older than the 12-hour threshold.
  // We surface this as a "Prices may be stale" nudge in the header so the
  // user knows to click Refresh.
  const quotesAreStale = useMemo(() => {
    if (liveFetchMs == null) return false;
    return Date.now() - liveFetchMs > STALE_QUOTE_THRESHOLD_MS;
  }, [liveFetchMs]);

  // Market hours status. Computed once on mount, then refreshed every 60s
  // so the open/closed transition shows up without a full reload. Reading
  // the system clock here is fine: the underlying getMarketStatus call
  // projects into America/New_York via Intl, so user TZ does not matter.
  const [marketStatus, setMarketStatus] = useState(() => getMarketStatus());
  useEffect(() => {
    const tick = () => setMarketStatus(getMarketStatus());
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  const marketStatusLabel = useMemo(() => describeMarketStatus(marketStatus), [marketStatus]);
  // Greeting fallback: a saved profile name wins; otherwise a generic greeting
  // rather than the demo persona's first name. Real users without a profile
  // never see "Justin" hardcoded.
  const greetingPhrase = useGreeting();
  const greetingName = userName || 'there';

  // Pull real transactions from the DB once so the headline tiles (XIRR,
  // dividends panel) read from actual flows, not from the synthetic
  // generateTransactions() demo generator.
  const [realTxs, setRealTxs] = useState<Array<{
    date: Date;
    symbol: string | null;
    action: string;
    quantity: number;
    price: number;
    fees: number;
    amount: number | null;
    account_id: string;
    notes: string | null;
  }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAllTransactions();
        if (cancelled) return;
        setRealTxs(
          rows.map(r => ({
            date: new Date(r.date),
            symbol: r.symbol,
            action: r.action,
            quantity: r.quantity,
            price: r.price,
            fees: r.fees,
            amount: r.amount,
            account_id: r.account_id,
            notes: r.notes,
          })),
        );
      } catch {
        if (!cancelled) setRealTxs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.accounts]);

  const fullSeries = data.series;
  const fullSpy = data.spy;
  const hasSeries = fullSeries.length >= 2;

  // Single source of truth for the segmented control. The chart, the SPY
  // overlay, and the segment-aware metrics tile (the "1Y RETURN (TWR)"
  // value) ALL read from this windowed series so the visible curve and
  // the headline number can never drift. This is the fix for the
  // "diagonal-line, 2018-2026 X axis, +283% YTD" report: the segment
  // selection had no effect on either axis or on the tile math because
  // the timeframe state existed but was never piped anywhere.
  const now = useMemo(() => new Date(), []);
  const window = useMemo(() => segmentWindow(timeframe, now), [timeframe, now]);
  const chartSeries: SeriesPoint[] = useMemo(
    () => windowSeries(fullSeries, window.start, window.end),
    [fullSeries, window.start, window.end],
  );
  const hasChart = chartSeries.length >= 2;

  // SPY overlay: window the same way the portfolio is windowed, then
  // normalize both to a baseline of 100 at the window's first available
  // point so "your portfolio grew 12% while SPY grew 9%" is visible at a
  // glance. We deliberately do NOT plot raw dollar SPY shares against
  // raw dollar portfolio NAV: $731K and $592 are not comparable on the
  // same y-axis, and a dual-y-axis chart would require a second tick
  // ladder that adds noise without insight.
  const benchmarkRaw: SeriesPoint[] = useMemo(() => {
    if (!showBenchmark) return [];
    return windowSeries(fullSpy, window.start, window.end);
  }, [fullSpy, window.start, window.end, showBenchmark]);

  // Extreme-growth toggle. When a chart window covers a >5x portfolio
  // multiplier (typical of ALL on a portfolio that started near zero and
  // compounded for a decade), the index-from-100 percent labels overflow
  // into 6 to 8 digit strings like "+1,036,556%". The percent framing also
  // stops being meaningful at that range; the user is really asking "how
  // much money did this grow into," which reads cleaner as `$6K to $13M`.
  // For these windows the chart switches to absolute-dollar mode: the
  // portfolio series is plotted at raw NAV, the SPY series is rescaled to
  // start at the same dollar value as the portfolio so both lines share a
  // common Y anchor and their relative growth is still visually comparable.
  // For all other windows (1M through 5Y on a normal portfolio) the chart
  // stays in normalized-to-100 percent mode.
  const useAbsoluteMode = useMemo(() => {
    if (chartSeries.length < 2) return false;
    const start = chartSeries[0].value;
    const end = chartSeries[chartSeries.length - 1].value;
    if (start <= 0) return true;
    return end / start > 5;
  }, [chartSeries]);

  const normalizedPortfolio: SeriesPoint[] = useMemo(() => {
    if (chartSeries.length < 2) return chartSeries;
    // Absolute mode: raw NAV. Plotted directly so the Y axis reads in
    // dollar magnitudes ($6K, $1M, $13M etc.).
    if (useAbsoluteMode) return chartSeries;
    // Default mode: only normalize when the SPY overlay is showing, so
    // the Y axis can stay in dollar mode when SPY is hidden.
    if (!showBenchmark || benchmarkRaw.length < 2) return chartSeries;
    return normalizeToBaseline(chartSeries);
  }, [chartSeries, benchmarkRaw, showBenchmark, useAbsoluteMode]);

  const normalizedBenchmark: SeriesPoint[] = useMemo(() => {
    if (!showBenchmark || benchmarkRaw.length < 2) return [];
    if (useAbsoluteMode && chartSeries.length >= 2) {
      // Rescale SPY so it starts at the portfolio's first NAV value at
      // the window start. After rescale, SPY[0].value === chartSeries[0].value
      // and SPY's growth multiplier is preserved. This puts both series on
      // a common Y anchor so the user can read "if you'd parked the same
      // starting capital in SPY, you'd have this much instead" directly off
      // the chart.
      const portfolioStart = chartSeries[0].value;
      const spyStart = benchmarkRaw[0].value;
      if (spyStart <= 0 || !isFinite(spyStart)) return [];
      const scale = portfolioStart / spyStart;
      return benchmarkRaw.map(p => ({ date: p.date, value: p.value * scale }));
    }
    return normalizeToBaseline(benchmarkRaw);
  }, [benchmarkRaw, showBenchmark, useAbsoluteMode, chartSeries]);

  // YTD / 1Y / all-time returns are computed via `twrOverWindow` on the
  // FULL real daily NAV series (we don't reuse the windowed series here
  // because YTD always means Jan 1 → today, regardless of which segment
  // the user has selected on the chart). With the historical-prices
  // backfill landing real daily closes, the same TWR call on a real-mark
  // series produces single-digit-percent annualized returns for a normal
  // portfolio. Pre-fix this read the qty-accumulation curve and emitted
  // +283% YTD on Justin's portfolio.
  const currentYear = now.getFullYear();
  const { ytdRet, oneYearTwr, allTimeXirr, xirrSinceLabel } = useMemo(() => {
    let ytdRet = NaN;
    let oneYearTwr = NaN;
    let allTimeXirr = NaN;
    let xirrSinceLabel = '';

    // External flows from real transactions feed both TWR (flow-adjusted
    // window) and XIRR (all-time money-weighted). We pass account_id and
    // notes through so flowsFromTransactions can do its same-account
    // pairing (deposit + immediate buy = ONE external flow, not two) and
    // detect the internal-transfer sentinel that Fidelity importers attach
    // to fund-distribution share transfers.
    let flows: ReturnType<typeof flowsFromTransactions> = [];
    if (realTxs && realTxs.length >= 1) {
      flows = flowsFromTransactions(
        realTxs.map(t => ({
          date: t.date,
          action: t.action,
          quantity: t.quantity,
          price: t.price,
          fees: t.fees,
          amount: t.amount,
          account_id: t.account_id,
          notes: t.notes,
        })),
      );
    }

    if (hasSeries) {
      // YTD window: Jan 1 of current year through today, clamped to
      // earliest available NAV point if the user's portfolio starts later.
      const yearStart = new Date(Date.UTC(currentYear, 0, 1));
      const ytdCum = twrOverWindow(fullSeries, flows, yearStart, now);
      // TWR over the window is already cumulative; YTD is by definition a
      // <=1y window so we don't annualize.
      ytdRet = ytdCum;

      // 1Y window: today - 365d through today.
      const oneYearAgo = new Date(+now - 365 * 86_400_000);
      const oneYearCum = twrOverWindow(fullSeries, flows, oneYearAgo, now);
      if (isFinite(oneYearCum)) {
        // Always annualize; for a < 1y partial window annualizeTwr is a
        // no-op below 1 month, so this is a safe call.
        const days = Math.min(365, (+now - +oneYearAgo) / 86_400_000);
        oneYearTwr = annualizeTwr(oneYearCum, days);
      }
    }

    // XIRR uses REAL flows from the DB. If we don't have enough flows yet,
    // return NaN and let the tile show the missing-value placeholder. No
    // demo synthesis.
    if (realTxs && realTxs.length >= 2 && flows.length >= 1 && data.totalValue > 0) {
      const xirrFlows = [...flows, { date: now, amount: data.totalValue }];
      allTimeXirr = xirr(xirrFlows);
      const earliest = realTxs.reduce<Date>((min, t) => (t.date < min ? t.date : min), realTxs[0].date);
      xirrSinceLabel = `since ${fmtDate(earliest, 'monthYear')}`;
    }

    return { ytdRet, oneYearTwr, allTimeXirr, xirrSinceLabel };
  }, [hasSeries, fullSeries, realTxs, data.totalValue, currentYear, now]);

  // One-shot SPY backfill when the user enables the benchmark and the
  // prices table is empty for SPY. The check is conservative: we trigger
  // only when fullSpy is empty AND the portfolio has at least two points
  // (no SPY needed on a virgin DB). Subsequent toggles read from the
  // already-cached bars.
  useEffect(() => {
    if (!showBenchmark) return;
    if (spyBackfillTriggered) return;
    if (!hasSeries) return;
    if (fullSpy.length >= 2) return;
    const earliest = fullSeries[0].date;
    setSpyBackfillTriggered(true);
    void (async () => {
      try {
        const result = await backfillHistoricalPrices(['SPY'], earliest);
        // Trigger a portfolio rebuild so the freshly-landed SPY bars are
        // picked up into data.spy. Without this, the chart's dashed SPY
        // line stays hidden until the user re-renders Home (the bug the
        // spy-overlay.spec.ts caught: the backfill writes rows but the
        // chart never reads them because data.spy was empty at mount).
        if (result.ok.length > 0 && onReload) {
          await Promise.resolve(onReload());
        }
      } catch {
        // Best-effort. If Yahoo blocks us, the chart silently renders
        // without the SPY line; nothing else breaks.
      }
    })();
  }, [showBenchmark, spyBackfillTriggered, hasSeries, fullSpy.length, fullSeries, onReload]);

  const ytdDisplay = isFinite(ytdRet) ? fmtPct(ytdRet) : '--';
  const ytdClass = isFinite(ytdRet) && ytdRet < 0 ? 'down' : 'up';
  const oneYearTwrDisplay = isFinite(oneYearTwr) ? fmtPct(oneYearTwr) : '--';
  const allTimeXirrDisplay = isFinite(allTimeXirr) ? fmtPct(allTimeXirr) : '--';
  const oneYearTwrClass = isFinite(oneYearTwr) && oneYearTwr < 0 ? 'down' : 'up';
  const allTimeXirrClass = isFinite(allTimeXirr) && allTimeXirr < 0 ? 'down' : 'up';

  // Real YTD dividends, grouped by month for the current year. Empty list
  // means we render an explicit empty state instead of the hardcoded bars.
  const ytdDividends = useMemo(() => {
    if (!realTxs) return null;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const totals = new Map<number, number>();
    let total = 0;
    for (const t of realTxs) {
      if (t.action !== 'dividend' && t.action !== 'div_reinvest') continue;
      if (t.date.getFullYear() !== currentYear) continue;
      const amt = Math.abs(t.amount ?? 0);
      if (amt === 0) continue;
      const m = t.date.getMonth();
      totals.set(m, (totals.get(m) || 0) + amt);
      total += amt;
    }
    // Lifetime total dividends (sum of dividend amounts across all years).
    let lifetime = 0;
    for (const t of realTxs) {
      if (t.action !== 'dividend' && t.action !== 'div_reinvest') continue;
      lifetime += Math.abs(t.amount ?? 0);
    }
    const rows = Array.from(totals.entries())
      .map(([m, v]) => ({ mo: months[m], v }))
      .sort((a, b) => months.indexOf(a.mo) - months.indexOf(b.mo));
    return { rows, total, lifetime };
  }, [realTxs, currentYear]);

  const typeTotals = data.accountTypes
    .map(t => {
      const v = data.accounts.filter(a => a.type === t.id).reduce((s, a) => s + a.value, 0);
      return { ...t, value: v };
    })
    .filter(t => t.value > 0);

  // "Today" tile / hero delta: when EVERY holding has a null dayChange
  // (typical of a holdings-only import before the first live Refresh
  // quotes), the rolled-up totalDayChange is 0 not because the market
  // didn't move but because we have no prev_close data to compute the
  // move. Show '--' in that case so a $0 number doesn't masquerade as a
  // confident "+$0 today" reading. As soon as Refresh quotes lands a
  // prev_close, the same tile flips to a real number.
  const hasAnyDayChangeSignal = useMemo(
    () => data.holdings.some(h => h.dayChange != null),
    [data.holdings],
  );

  return (
    <div>
      <PageHead
        title={
          <span>
            <span style={{ color: 'var(--ink-3)' }}>{greetingPhrase},</span> {greetingName}.
          </span>
        }
        meta={
          <div>
            <div>
              {new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
            <div
              style={{ marginTop: 2, color: 'var(--ink-4)' }}
              data-testid="market-status-line"
            >
              {marketStatusLabel}
              {' · '}
              {quotesAreStale ? (
                <span data-testid="prices-stale-warning">
                  Prices may be stale. Refresh quotes for the latest.
                </span>
              ) : (
                pricesAsOfLabel
              )}
            </div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}>
              Add an Account
            </button>
            <button
              className="btn btn-primary"
              disabled={refreshState === 'refreshing'}
              aria-busy={refreshState === 'refreshing'}
              aria-live="polite"
              onClick={async () => {
                if (refreshState === 'refreshing') return;
                setRefreshState('refreshing');
                try {
                  await Promise.resolve(onRefreshQuotes?.());
                  // Stamp the live-fetch timestamp at the moment the refresh
                  // RESOLVED, not when it started. That way a long-running
                  // backfill in the same session can't fast-forward the
                  // "Prices as of" label before the click actually finished.
                  const now = Date.now();
                  setLiveFetchMs(now);
                  writeLiveFetchSetting(now);
                  setRefreshState('done');
                  // Brief afterglow so the user sees the success state, then
                  // revert to idle. The timeout is cleared on unmount via the
                  // closure; if the component is gone before it fires, the
                  // setState is a harmless no-op.
                  setTimeout(() => setRefreshState('idle'), REFRESH_AFTERGLOW_MS);
                } catch {
                  // Any failure already surfaces via the network log; reset
                  // the button so the user can retry.
                  setRefreshState('idle');
                }
              }}
            >
              {refreshState === 'refreshing' && (
                <span
                  className="btn-spinner"
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    marginRight: 8,
                    borderRadius: '50%',
                    border: '2px solid currentColor',
                    borderTopColor: 'transparent',
                    animation: 'matmon-spin 0.7s linear infinite',
                    verticalAlign: '-2px',
                  }}
                />
              )}
              {refreshState === 'refreshing'
                ? 'Refreshing...'
                : refreshState === 'done'
                  ? 'Updated'
                  : 'Refresh quotes'}
            </button>
          </div>
        }
      />

      <div className="card" style={{ padding: '28px 30px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="card-title">Total portfolio · all accounts</div>
            <div className="total-figure" style={{ marginTop: 10 }}>
              <span className="dollar">$</span>
              {Math.floor(data.totalValue).toLocaleString()}
              <span className="cents">.{(data.totalValue % 1).toFixed(2).slice(2)}</span>
            </div>
            <div
              className="muted prices-as-of"
              style={{
                fontSize: 11.5,
                fontFamily: 'var(--font-mono)',
                marginTop: 6,
                letterSpacing: '0.02em',
              }}
              data-testid="prices-as-of"
            >
              {pricesAsOfLabel}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              {hasAnyDayChangeSignal ? (
                <span className={`delta ${data.totalDayChange >= 0 ? 'up' : 'down'}`}>
                  <span className="arrow">{data.totalDayChange >= 0 ? '↑' : '↓'}</span>
                  {data.totalDayChange >= 0 ? '+' : ''}
                  {fmtMoney(data.totalDayChange, { cents: false })}
                  <span style={{ opacity: 0.7 }}>
                    {' '}
                    ·{' '}
                    {data.totalValue > 0
                      ? `${((data.totalDayChange / data.totalValue) * 100).toFixed(2)}%`
                      : '--'}
                  </span>
                </span>
              ) : (
                <span className="delta muted" data-testid="today-pending">
                  --
                  <span style={{ opacity: 0.7 }}> · pending today's data</span>
                </span>
              )}
              <span className="muted" style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)' }}>
                today
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Timeframe value={timeframe} onChange={v => setTimeframe(asSegment(v))} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {showBenchmark ? (
                <span className="compare-pill" data-testid="benchmark-pill">
                  vs SPY (S&P 500)
                  <span className="x" onClick={() => setShowBenchmark(false)}>
                    ×
                  </span>
                </span>
              ) : (
                <button className="compare-input" onClick={() => setShowBenchmark(true)}>
                  + compare to…
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }} data-testid="portfolio-chart-wrap">
          {hasChart ? (
            <PortfolioChart
              series={normalizedPortfolio}
              benchmark={normalizedBenchmark}
              showBenchmark={showBenchmark && normalizedBenchmark.length > 0}
              normalized={!useAbsoluteMode && normalizedBenchmark.length > 0}
              valueAxisFormatter={
                useAbsoluteMode
                  ? v => fmtMoney(v, { compact: true })
                  : normalizedBenchmark.length > 0
                    ? undefined
                    : v => fmtMoney(v, { compact: true })
              }
              hoverValueFormatter={
                useAbsoluteMode
                  ? v => fmtMoney(v, { compact: true })
                  : normalizedBenchmark.length > 0
                    ? v => `${(v - 100).toFixed(1)}%`
                    : v => fmtMoney(v, { compact: true })
              }
              variant={chartVariant}
              height={320}
            />
          ) : (
            <div
              style={{
                minHeight: 320,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              data-testid="portfolio-chart-empty"
            >
              {(() => {
                // Four distinct empty-state scenarios feed this branch:
                //   1. recovery in flight OR initial load gap with holdings:
                //      the auto-heal backfill is actively fetching (or
                //      about to start), so we show a visible loading
                //      indicator with per-symbol progress instead of the
                //      manual CTA. This is the difference between "feels
                //      automatic" and "feels broken."
                //   2. hasSeries true, current segment is empty: window
                //      didn't intersect the data. Suggest a longer range.
                //   3. hasSeries false, user has holdings AND no recovery
                //      in flight: the recovery already ran and failed for
                //      every symbol (Yahoo blocked us). Surface the
                //      manual "Refresh history" CTA so the user can force
                //      a retry from Settings.
                //   4. hasSeries false, no holdings: first launch. Send
                //      them to the import flow.
                const probableRecovery =
                  data.holdings.length > 0 && (recoveryInFlight || loading);
                if (probableRecovery) {
                  // Pull progress when we have it; otherwise show a
                  // generic "this should take a moment" copy. The wrapper
                  // div uses data-testid="chart-recovery-loading" so the
                  // e2e spec can assert visibility.
                  const total = recoveryProgress?.total ?? null;
                  const done = recoveryProgress?.done ?? 0;
                  const progressLine =
                    total != null
                      ? `Loading chart history... (${done} of ${total} symbols)`
                      : 'Loading chart history...';
                  return (
                    <div
                      data-testid="chart-recovery-loading"
                      role="status"
                      aria-live="polite"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 12,
                        padding: '24px 16px',
                        textAlign: 'center',
                      }}
                    >
                      <span
                        className="btn-spinner"
                        aria-hidden="true"
                        style={{
                          display: 'inline-block',
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          border: '3px solid var(--ink-4)',
                          borderTopColor: 'transparent',
                          animation: 'matmon-spin 0.8s linear infinite',
                        }}
                      />
                      <div
                        style={{
                          fontSize: 14,
                          color: 'var(--ink)',
                          fontWeight: 500,
                        }}
                      >
                        {progressLine}
                      </div>
                      {total != null && total > 0 && (
                        <div
                          aria-hidden="true"
                          style={{
                            width: 220,
                            height: 4,
                            background: 'var(--paper-3)',
                            borderRadius: 2,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.min(100, (done / total) * 100)}%`,
                              background: 'var(--accent)',
                              borderRadius: 2,
                              transition: 'width 200ms ease-out',
                            }}
                          />
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--ink-4)',
                          fontFamily: 'var(--font-mono)',
                          maxWidth: 320,
                        }}
                      >
                        Pulling Yahoo&rsquo;s daily-close history. The
                        chart fills in as bars land.
                      </div>
                    </div>
                  );
                }
                if (hasSeries) {
                  return (
                    <EmptyState
                      title="No data in this range yet."
                      body="Try a longer range."
                    />
                  );
                }
                if (data.holdings.length > 0) {
                  return (
                    <EmptyState
                      title="No price history yet."
                      body="Your chart fills in once Yahoo's daily-close history lands. Refresh history fetches that backlog in one shot."
                      ctaLabel="Open Settings → Refresh history"
                      onCta={() => onNavigate('settings')}
                    />
                  );
                }
                return (
                  <EmptyState
                    title="Your portfolio chart will fill in as your data lands here."
                    body="Drop a CSV to get the picture going."
                    onCta={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
                  />
                );
              })()}
            </div>
          )}
        </div>

        <div className="metric-grid">
          <div className="metric">
            <div className="metric-label">Today</div>
            {hasAnyDayChangeSignal ? (
              <div className={`metric-value ${data.totalDayChange >= 0 ? 'up' : 'down'}`}>
                {data.totalDayChange >= 0 ? '+' : ''}
                {fmtMoney(data.totalDayChange, { cents: false })}
                <span className="sub">
                  {data.totalValue > 0
                    ? `${((data.totalDayChange / data.totalValue) * 100).toFixed(2)}%`
                    : '--'}
                </span>
              </div>
            ) : (
              <div className="metric-value">
                --
                <span className="sub">pending today's data</span>
              </div>
            )}
          </div>
          <div className="metric">
            <div className="metric-label">YTD return</div>
            <div className={`metric-value ${ytdClass}`}>
              {ytdDisplay}
              <span className="sub">this year</span>
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">1Y return (TWR)</div>
            <div className={`metric-value ${oneYearTwrClass}`}>
              {oneYearTwrDisplay}
              <span className="sub">annualized</span>
            </div>
          </div>
          <div className="metric">
            <div
              className="metric-label"
              title={
                isFinite(allTimeXirr)
                  ? undefined
                  : 'XIRR needs at least two real cash flows. Import more transactions.'
              }
            >
              All-time XIRR
            </div>
            <div className={`metric-value ${allTimeXirrClass}`}>
              {allTimeXirrDisplay}
              <span className="sub">{xirrSinceLabel || 'needs 2+ flows'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title-row">
          <div className="card-title">Brokerages</div>
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {new Set(data.accounts.map(a => a.brokerage)).size} custodians · {data.accounts.length} accounts
          </span>
        </div>
        {data.accounts.length === 0 ? (
          <EmptyState
            compact
            title="No brokerages yet."
            body="Pick one to get rolling."
            onCta={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
          />
        ) : (
          <div className="brokerage-grid">
            {(() => {
              // Build a per-brokerage rollup directly from the holdings, not
              // the account-level dayChange. We need the prev_value sum
              // (qty × prevClose) to render an accurate value-weighted
              // percent on the tile, and that information lives at the
              // holding granularity. The pending count tracks how many
              // symbols dropped out of the sum because their prev_close
              // was null (typically holdings-only imports that haven't
              // been refreshed yet).
              type Tile = {
                name: string;
                value: number;
                count: number;
                dayChange: number;
                prevValue: number;
                pending: number;
              };
              const accountToBrokerage = new Map<string, string>();
              const accountCounted = new Set<string>();
              for (const a of data.accounts) accountToBrokerage.set(a.id, a.brokerage);
              const tiles = new Map<string, Tile>();
              const ensure = (name: string): Tile => {
                let t = tiles.get(name);
                if (!t) {
                  t = { name, value: 0, count: 0, dayChange: 0, prevValue: 0, pending: 0 };
                  tiles.set(name, t);
                }
                return t;
              };
              for (const a of data.accounts) {
                const t = ensure(a.brokerage);
                t.value += a.value;
                if (!accountCounted.has(a.id)) {
                  t.count += 1;
                  accountCounted.add(a.id);
                }
              }
              for (const h of data.holdings) {
                const brokerage = accountToBrokerage.get(h.account);
                if (!brokerage) continue;
                const t = ensure(brokerage);
                if (h.dayChange == null) {
                  t.pending += 1;
                } else {
                  t.dayChange += h.dayChange;
                  if (h.qty > 0) {
                    const perShareMove = h.dayChange / h.qty;
                    const prevClose = h.price - perShareMove;
                    if (prevClose > 0) t.prevValue += h.qty * prevClose;
                  }
                }
              }
              const ordered = Array.from(tiles.values()).sort((a, b) => b.value - a.value);
              return ordered.map(b => {
                const share = data.totalValue > 0 ? b.value / data.totalValue : 0;
                const pct = b.prevValue > 0 ? b.dayChange / b.prevValue : null;
                return (
                  <button
                    className="brokerage-tile"
                    key={b.name}
                    onClick={() => onNavigate('buckets')}
                    title={`View ${b.name} accounts`}
                  >
                    <BrokerageLogo name={b.name} />
                    <div className="brokerage-tile-name">{b.name}</div>
                    <div className="brokerage-tile-value">{fmtMoney(b.value, { cents: false })}</div>
                    <div className="brokerage-tile-meta">
                      {b.count} account{b.count === 1 ? '' : 's'} · {(share * 100).toFixed(1)}%
                    </div>
                    <div className={`brokerage-tile-delta ${b.dayChange >= 0 ? 'up' : 'down'}`}>
                      {b.dayChange >= 0 ? '+' : ''}
                      {fmtMoney(b.dayChange, { cents: false })} today
                      {pct != null && (
                        <span style={{ opacity: 0.75 }}> ({fmtPct(pct)})</span>
                      )}
                    </div>
                    {b.pending > 0 && (
                      <div
                        className="brokerage-tile-meta"
                        style={{ marginTop: 2, fontStyle: 'italic' }}
                      >
                        ({b.pending} symbol{b.pending === 1 ? '' : 's'} pending today&rsquo;s data)
                      </div>
                    )}
                  </button>
                );
              });
            })()}
            <button
              className="brokerage-add"
              onClick={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
              aria-label="Add an account"
            >
              <div className="brokerage-add-glyph">+</div>
              <div className="brokerage-add-label">Add an account</div>
              <div className="brokerage-add-sub">Drop a CSV from anywhere</div>
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18, marginTop: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Composition · by account type</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {typeTotals.length} types
            </span>
          </div>
          {data.holdings.length === 0 ? (
            <EmptyState
              compact
              title="Nothing to slice up yet."
              body="Add an account and your pie chart will appear."
              onCta={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
            />
          ) : (
            <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
              <Donut
                segments={typeTotals.map(t => ({ label: t.label, value: t.value, color: t.color }))}
                size={148}
                thickness={20}
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {typeTotals.map(t => (
                  <div
                    key={t.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '10px 1fr auto',
                      gap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color }} />
                    <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>{t.label}</span>
                    <span className="num muted" style={{ fontSize: 12 }}>
                      {data.totalValue > 0 ? `${((t.value / data.totalValue) * 100).toFixed(1)}%` : '--'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Accounts · {data.accounts.length}</div>
            <a
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
              onClick={() => onNavigate('buckets')}
            >
              Manage →
            </a>
          </div>
          {data.accounts.length === 0 ? (
            <EmptyState
              compact
              title="Your accounts will live here."
              body="Add your first."
              onCta={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
            />
          ) : (
            <div className="accounts-list">
              {data.accounts.map(a => {
                const t = data.accountTypes.find(x => x.id === a.type)!;
                const glyph = a.brokerage[0];
                return (
                  <div className="account-row" key={a.id}>
                    <div className="acct-glyph">{glyph}</div>
                    <div>
                      <div className="acct-name">{a.name}</div>
                      <div className="acct-meta">
                        {a.brokerage} · {t.label}
                      </div>
                    </div>
                    <div>
                      <div className="acct-value">{fmtMoney(a.value, { cents: true })}</div>
                      <div
                        className="acct-meta right"
                        style={{ color: a.dayChange >= 0 ? 'var(--gain)' : 'var(--loss)' }}
                      >
                        {a.dayChange >= 0 ? '+' : ''}
                        {fmtMoney(a.dayChange, { cents: true })}
                      </div>
                    </div>
                    <div className="acct-share">
                      {data.totalValue > 0 ? `${((a.value / data.totalValue) * 100).toFixed(1)}%` : '--'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, marginTop: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Recent activity</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              Last 14 days
            </span>
          </div>
          {data.activity.length === 0 ? (
            <EmptyState
              compact
              title="Quiet around here."
              body="Your activity feed will fill in once you import some history."
              onCta={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
            />
          ) : (
            <div>
              {data.activity.map((a, i) => (
                <div className="activity-row" key={i}>
                  <span className="activity-date">{a.date}</span>
                  <span>
                    <span className={`activity-act ${a.action}`}>
                      {a.action === 'div' ? 'Div' : a.action}
                    </span>
                    <span style={{ color: 'var(--ink)' }}>{a.desc}</span>
                  </span>
                  <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                    {a.account}
                  </span>
                  <span
                    className="activity-amt"
                    style={{ color: a.amount >= 0 ? 'var(--gain)' : 'var(--ink)' }}
                  >
                    {a.amount >= 0 ? '+' : ''}
                    {fmtMoney(a.amount, { cents: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Dividends · {currentYear} YTD</div>
            <span className="num muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {ytdDividends && ytdDividends.total > 0 ? fmtMoney(ytdDividends.total, { cents: false }) : '--'}
            </span>
          </div>
          {ytdDividends && ytdDividends.rows.length > 0 ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {(() => {
                  const peak = Math.max(...ytdDividends.rows.map(r => r.v), 1);
                  return ytdDividends.rows.map(m => (
                    <div
                      key={m.mo}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '36px 1fr 80px',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span className="num muted" style={{ fontSize: 11 }}>
                        {m.mo}
                      </span>
                      <div
                        style={{
                          height: 6,
                          background: 'var(--paper-3)',
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${(m.v / peak) * 100}%`,
                            background: 'var(--accent)',
                            borderRadius: 3,
                          }}
                        />
                      </div>
                      <span className="num right" style={{ fontSize: 12 }}>
                        {fmtMoney(m.v, { cents: false })}
                      </span>
                    </div>
                  ));
                })()}
              </div>
              <div
                className="disclaimer"
                style={{ borderTop: '1px solid var(--line-soft)', marginTop: 16, fontSize: 11 }}
              >
                Lifetime dividends ·{' '}
                <span className="num" style={{ color: 'var(--ink)' }}>
                  {fmtMoney(ytdDividends.lifetime, { cents: false })}
                </span>
              </div>
            </>
          ) : (
            <EmptyState
              compact
              title="No dividends yet this year."
              body="They'll show up here as they roll in."
              onCta={
                data.accounts.length === 0
                  ? () => (onAddAccount ? onAddAccount() : onNavigate('import'))
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
