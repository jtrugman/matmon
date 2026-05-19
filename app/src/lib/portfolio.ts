// Builds the MatmonData shape that views consume by aggregating real DB rows.
// No fallback to sample data: when the user has no accounts we return an empty
// portfolio shape and the view layer renders empty-state cards.

import {
  getInstrumentsForSymbols,
  getLatestPrice,
  listAccounts,
  listPriceHistory,
  listTransactions,
  upsertPrice,
} from './db/repos';
import { getProvider, isOffline } from './quotes';
import type { FetchQuotesOptions, Quote } from './quotes/types';
import { buildAchievements } from './achievements';
import {
  ACCOUNT_TYPES as ACCOUNT_TYPES_CATALOG,
  type Account,
  type AccountType,
  type Holding,
  type MatmonData,
  type ActivityItem,
  type SeriesPoint,
} from '../data';

const ACCOUNT_TYPES: AccountType[] = ACCOUNT_TYPES_CATALOG;

/**
 * Empty MatmonData shell returned when the user has zero accounts. We never
 * fabricate a sample portfolio here; view components handle the empty state
 * on their own (see HomeView's chart empty state, AchievementsView's "first
 * milestone" card, etc.).
 */
function emptyPortfolio(achievements: MatmonData['achievements'] = []): MatmonData {
  return {
    accounts: [],
    accountTypes: ACCOUNT_TYPES,
    holdings: [],
    activity: [],
    achievements,
    series: [],
    spy: [],
    totalValue: 0,
    totalDayChange: 0,
  };
}

// In-memory quote cache so repeated rebuilds don't re-hit Yahoo every second.
const quoteCache = new Map<string, Quote>();

/**
 * Live in-memory quote cache lookup. Returns the cached price ONLY when it's
 * fresh (within 15 min); otherwise returns null so the caller falls through
 * to the stored prices table and then to the last-tx fallback. The priority
 * order is:
 *   1. fresh live quote cache (this function)
 *   2. stored prices table (getLatestPrice)
 *   3. last-tx fallback (in the caller)
 * When offline we still return the cached price if present (regardless of
 * age) because we have no other way to refresh it; the stored prices table
 * is checked next regardless.
 */
async function priceFor(symbol: string): Promise<number | null> {
  if (isOffline()) return quoteCache.get(symbol)?.price ?? null;
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - +cached.fetchedAt < 15 * 60 * 1000) {
    return cached.price;
  }
  return null;
}

export async function refreshQuotes(symbols: string[], opts?: FetchQuotesOptions): Promise<Quote[]> {
  if (symbols.length === 0 || isOffline()) return [];
  const quotes = await getProvider().fetchQuotes(symbols, opts);
  for (const q of quotes) quoteCache.set(q.symbol, q);
  // Persist the live quote into the prices table so the (price, prev_close)
  // pair survives a reload and feeds buildPortfolio() the per-symbol day
  // change for the brokerage tiles. We deliberately key the row at the
  // wall-clock instant of the fetch rather than the trading-day UTC midnight:
  // a single user-initiated refresh shouldn't clobber the historical
  // backfill's "2026-05-18 00:00:00Z" close row for the same day. Best-effort
  // writes; a DB failure here must not block the in-memory cache update
  // that already happened above.
  for (const q of quotes) {
    try {
      await upsertPrice(q.symbol, q.fetchedAt, q.price, q.currency || 'USD', q.prevClose ?? null);
    } catch {
      // Silently continue; the in-memory quote cache still has the row,
      // so the current render shows the right price. Surface via the
      // network log if needed (callers can inspect).
    }
  }
  return quotes;
}

export async function buildPortfolio(): Promise<MatmonData> {
  const accountRows = await listAccounts();
  const txRows = await listTransactions();
  const achievements = await buildAchievements();

  if (accountRows.length === 0) {
    // No accounts yet: return an explicit empty shape. The view layer renders
    // empty-state cards for this case.
    return emptyPortfolio(achievements);
  }

  // Build holdings from transactions per (account, symbol).
  // CRITICAL: average-cost accounting is order-sensitive whenever a sell is
  // interleaved with buys at different prices, so we must replay transactions
  // CHRONOLOGICALLY. listTransactions() returns rows ORDER BY date DESC (and
  // the browser shim preserves insert order, which CSV exports usually give
  // DESC too), so we sort ASC here before iterating.
  type HoldKey = string;
  type HoldAcc = { account: string; sym: string; qty: number; cost: number; name: string };
  const holdings = new Map<HoldKey, HoldAcc>();

  const txRowsAsc = [...txRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Resolve a human-readable security name from the per-symbol transaction
  // notes. Importers (Fidelity, JPM, Schwab, Human Interest) all stash the
  // brokerage's "Description" column into the notes field; the most recent
  // non-empty value wins so re-imports refresh the label. We keep the symbol
  // as the fallback when nothing usable is stored.
  for (const t of txRowsAsc) {
    if (!t.symbol) continue;
    const k = `${t.account_id}::${t.symbol}`;
    const h: HoldAcc =
      holdings.get(k) || { account: t.account_id, sym: t.symbol, qty: 0, cost: 0, name: t.symbol };
    // Latest non-empty notes wins. Filter out the "(Cash)" / "(Shares)" lots
    // descriptor lines: those repeat the symbol and aren't a real name. Notes
    // shorter than 4 chars usually means we have a ticker only.
    const noteTrim = (t.notes || '').trim();
    if (noteTrim && noteTrim.length > 3 && noteTrim.toUpperCase() !== t.symbol.toUpperCase()) {
      h.name = noteTrim;
    }
    if (t.action === 'buy' || t.action === 'transfer_in' || t.action === 'div_reinvest') {
      h.qty += t.quantity;
      h.cost += t.quantity * t.price + t.fees;
    } else if (t.action === 'sell' || t.action === 'transfer_out') {
      // Average-cost reduction
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      h.qty -= t.quantity;
      h.cost -= avg * t.quantity;
      if (h.qty <= 0) {
        h.qty = 0;
        h.cost = 0;
      }
    }
    holdings.set(k, h);
  }

  // Pull the per-symbol sector / industry metadata in one bulk DB read so the
  // per-holding loop below doesn't issue one round-trip per row. Symbols
  // missing from the map fall back to empty strings, which the Holdings view
  // renders as a muted "--" cell.
  const uniqueSymbols = Array.from(
    new Set(Array.from(holdings.values()).map(h => h.sym)),
  );
  const instrumentsBySym = await getInstrumentsForSymbols(uniqueSymbols).catch(
    () => new Map<string, Awaited<ReturnType<typeof getInstrumentsForSymbols>> extends Map<infer _K, infer V> ? V : never>(),
  );

  // Price resolution: live quote cache first, then most recent price seen in txs.
  let totalValue = 0;
  let totalDayChange = 0;
  const holdingObjs: Holding[] = [];

  for (const h of holdings.values()) {
    // Skip pseudo-holdings created by dividend-only rows for a symbol the user
    // never actually owned shares of (and for symbols the user fully sold).
    // Without this guard the Holdings view shows "0 shares" rows for every
    // ticker that ever paid a dividend, polluting the position count and the
    // table. Cost basis is unaffected (the zero rows have cost=0 already).
    if (h.qty <= 0) continue;
    // Price resolution priority, in order:
    //   1. Live quote cache (when online and fresh).
    //   2. Stored prices table (e.g. JPM holdings importer writes the current
    //      market mark here at import time, so we don't conflate cost basis
    //      with market value for holdings-only imports).
    //   3. Last seen price in the transactions table (may be stale, but it's
    //      better than zero when there's no other signal).
    let price = await priceFor(h.sym);
    // prevClose is independent of the price source: even when the live cache
    // serves the current price we still want to surface the prev_close that
    // landed alongside it on the most recent fetch. Resolve from the in-memory
    // cache first (matches the live price), then fall through to the prices
    // table for users on a cold boot before any refresh.
    let prevClose: number | null = null;
    const cachedQuote = quoteCache.get(h.sym);
    if (cachedQuote && cachedQuote.prevClose > 0) {
      prevClose = cachedQuote.prevClose;
    }
    if (price == null) {
      const stored = await getLatestPrice(h.sym);
      if (stored && stored.price > 0) {
        price = stored.price;
        if (prevClose == null && stored.prevClose != null && stored.prevClose > 0) {
          prevClose = stored.prevClose;
        }
      }
    } else if (prevClose == null) {
      // Live cache served the price but no prev_close was present (shouldn't
      // happen for Yahoo chart-endpoint quotes, but defensively check stored
      // history). Read the prev_close from the prices table.
      const stored = await getLatestPrice(h.sym).catch(() => null);
      if (stored && stored.prevClose != null && stored.prevClose > 0) {
        prevClose = stored.prevClose;
      }
    }
    if (price == null) {
      const lastTx = txRows
        .filter(t => t.symbol === h.sym && t.price > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      price = lastTx?.price ?? 0;
    }
    const value = h.qty * price;
    const basis = h.qty > 0 ? h.cost / h.qty : 0;
    const gain = value - h.cost;
    // dayChange is the qty-weighted move between yesterday's close and today's
    // price. Null when prev_close is missing OR equals zero (Yahoo returns 0
    // for cash sweeps and pre-IPO bars). The null propagates up to the per-
    // brokerage tile aggregation so the "pending today's data" footer can
    // surface accurate symbol counts.
    let dayChange: number | null = null;
    let dayChangePct: number | null = null;
    if (prevClose != null && prevClose > 0 && price > 0) {
      const perShareMove = price - prevClose;
      dayChange = h.qty * perShareMove;
      dayChangePct = perShareMove / prevClose;
      totalDayChange += dayChange;
    }
    const instrumentRow = instrumentsBySym.get(h.sym);
    holdingObjs.push({
      sym: h.sym,
      // Real security name from imported transaction notes; falls back to the
      // symbol when no description ever landed (e.g. third-party CSV with no
      // Description column).
      name: h.name || h.sym,
      qty: h.qty,
      price,
      basis,
      // Sector classification comes from the instruments table, populated
      // lazily by the sector backfill (src/lib/quotes/sector.ts). Empty
      // string for symbols that haven't been fetched yet (or returned no
      // profile); the Holdings view renders a muted "--" cell in that case.
      sector: instrumentRow?.sector ?? '',
      industry: instrumentRow?.industry ?? '',
      account: h.account,
      value,
      cost: h.cost,
      gain,
      gainPct: h.cost > 0 ? gain / h.cost : 0,
      share: 0, // backfilled after totalValue computed
      // Real price history isn't surfaced through this aggregation yet, so
      // every holding got the same synthetic sine wave. Send an empty array;
      // HoldingsView falls back to a "--" cell when no series is present.
      spark: [],
      dayChange,
      dayChangePct,
    });
    totalValue += value;
  }

  for (const h of holdingObjs) h.share = totalValue > 0 ? h.value / totalValue : 0;

  // Roll up account values from holdings.
  const accountValueMap = new Map<string, number>();
  // dayChange per account: sum of holding.dayChange, excluding nulls. The
  // pending-symbol count tracks holdings dropped from the sum so the UI can
  // show a "(N symbols pending today's data)" footer when relevant.
  const accountDayChangeMap = new Map<string, number>();
  const accountPendingMap = new Map<string, number>();
  for (const h of holdingObjs) {
    accountValueMap.set(h.account, (accountValueMap.get(h.account) || 0) + h.value);
    if (h.dayChange == null) {
      accountPendingMap.set(h.account, (accountPendingMap.get(h.account) || 0) + 1);
    } else {
      accountDayChangeMap.set(
        h.account,
        (accountDayChangeMap.get(h.account) || 0) + h.dayChange,
      );
    }
  }

  const accounts: Account[] = accountRows.map(a => ({
    id: a.id,
    name: a.name,
    brokerage: a.brokerage,
    type: a.account_type,
    value: accountValueMap.get(a.id) || 0,
    dayChange: accountDayChangeMap.get(a.id) || 0,
    dayChangePending: accountPendingMap.get(a.id) || 0,
  }));

  // Recent activity: last 6 transactions
  const recent = txRows.slice(0, 6);
  const accountNameById = new Map(accountRows.map(a => [a.id, a.name]));
  const activity: ActivityItem[] = recent.map(t => {
    const amount = t.amount ?? (t.action === 'sell' ? t.quantity * t.price : -(t.quantity * t.price));
    const action: 'buy' | 'sell' | 'div' =
      t.action === 'dividend' || t.action === 'div_reinvest' ? 'div' : t.action === 'sell' ? 'sell' : 'buy';
    return {
      date: new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }),
      action,
      desc: `${t.symbol ?? '--'} · ${t.notes || (action === 'div' ? 'Dividend received' : `${t.quantity.toFixed(2)} shares @ $${t.price.toFixed(2)}`)}`,
      account: accountNameById.get(t.account_id) || 'Unknown',
      amount: action === 'div' ? Math.abs(amount) : amount,
    };
  });

  // achievements is loaded above from listAchievements() joined against
  // MILESTONE_CATALOG (see ./achievements.ts). All values come from the DB
  // unlock table, never from any hardcoded sample data.

  // Build a real daily NAV series by walking every trading day (sourced from
  // the prices table) and summing qty × close across all held symbols. Days
  // where a symbol has no Yahoo close get forward-filled from the prior
  // known close so the chart doesn't step-down on holidays / missing bars.
  //
  // This is the function that turned the chart from "qty-accumulation" into
  // "real mark-to-market": before the historical-prices backfill landed,
  // the previous implementation here multiplied every historical qty
  // snapshot by the SAME (current) price, which is why a JPM-only import
  // showed YTD = +323% (the user only got the qty in 2025; before that
  // qty=0 so the "value" jumps from 0 to today's value in one print).
  const series = await buildHistoricalSeries(txRowsAsc, holdingObjs, totalValue);

  // SPY benchmark series: pulled from the prices table if present so the
  // chart can render a "vs SPY (S&P 500)" overlay normalized to 100 at the
  // window start. We do NOT fetch SPY here; backfilling SPY history is
  // kicked off lazily from HomeView when the user toggles the benchmark
  // on (or implicitly at onboarding finish; see App.tsx). Reading from
  // the prices table keeps buildPortfolio() a pure local read.
  const spy = await loadBenchmarkSeries('SPY').catch(() => [] as SeriesPoint[]);

  return {
    accounts,
    accountTypes: ACCOUNT_TYPES,
    holdings: holdingObjs,
    activity: activity.length ? activity : [],
    achievements,
    series,
    spy,
    totalValue,
    totalDayChange,
  };
}

/**
 * Load a benchmark symbol's stored daily-close history from the prices
 * table and return it as a SeriesPoint[] sorted oldest-first. Returns an
 * empty array when nothing is stored yet. The chart layer normalizes the
 * benchmark to the portfolio's window-start value at render time, so we
 * deliberately do NOT pre-normalize here; the raw closes are what other
 * surfaces (per-holding chart, future "vs custom benchmark" feature) want.
 */
export async function loadBenchmarkSeries(symbol: string): Promise<SeriesPoint[]> {
  const rows = await listPriceHistory(symbol).catch(() => []);
  if (rows.length === 0) return [];
  // Already oldest-first.
  return rows.map(r => ({ date: r.date, value: r.close }));
}

/**
 * Clamp a chronological series to a [start, end] window. Used by HomeView
 * to feed the chart and the metrics tiles a series that matches the
 * segmented-control selection (1M / 3M / 6M / YTD / 1Y / 3Y / 5Y / ALL).
 *
 * Behavior:
 *   - `start` is clamped UP to the earliest available point (we never
 *     fabricate a pre-portfolio baseline). For YTD on a portfolio that
 *     started in March, that means the window effectively begins in March
 *     and the YTD tile reflects "performance since you joined the chart"
 *     rather than against an imaginary Jan 1 zero.
 *   - `end` is clamped DOWN to the latest available point.
 *   - Empty input or a degenerate [start>end] window returns [].
 *
 * Returns a fresh array; safe to mutate by callers.
 */
export function windowSeries(
  series: SeriesPoint[],
  start: Date,
  end: Date,
): SeriesPoint[] {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => +a.date - +b.date);
  const firstAvailable = +sorted[0].date;
  const lastAvailable = +sorted[sorted.length - 1].date;
  const lo = Math.max(+start, firstAvailable);
  const hi = Math.min(+end, lastAvailable);
  if (lo > hi) return [];
  return sorted.filter(p => +p.date >= lo && +p.date <= hi);
}

/**
 * Resolve a segmented-control segment ID (1M / 3M / 6M / YTD / 1Y / 3Y /
 * 5Y / ALL) to a [start, end] window relative to `now`. The chart and the
 * metrics tiles read from a SINGLE call site so the X-axis, the line, and
 * the YTD/1Y/etc. percentages always reflect the same window.
 *
 * For 'ALL', the start sentinel is a date well before any conceivable
 * portfolio (Jan 1 1970). The downstream `windowSeries` clamps it up to
 * the actual series start, so 'ALL' on a 2018-started portfolio renders
 * from 2018-2026 with no awkward pre-portfolio bars.
 */
export function segmentWindow(
  segment: '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL',
  now: Date,
): { start: Date; end: Date } {
  const end = now;
  let start: Date;
  switch (segment) {
    case '1M':
      start = new Date(+now - 30 * 86_400_000);
      break;
    case '3M':
      start = new Date(+now - 91 * 86_400_000);
      break;
    case '6M':
      start = new Date(+now - 182 * 86_400_000);
      break;
    case 'YTD':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    case '1Y':
      start = new Date(+now - 365 * 86_400_000);
      break;
    case '3Y':
      start = new Date(+now - 3 * 365 * 86_400_000);
      break;
    case '5Y':
      start = new Date(+now - 5 * 365 * 86_400_000);
      break;
    case 'ALL':
    default:
      start = new Date(0);
      break;
  }
  return { start, end };
}

/**
 * Normalize a chronological series to a baseline value of 100 at the
 * earliest point. Used by the chart's "vs SPY" overlay so the portfolio
 * and the benchmark are visually comparable regardless of dollar
 * magnitudes ($731K portfolio vs $592 SPY share price would not be
 * comparable; both rebased to 100 immediately answers "who's ahead").
 */
export function normalizeToBaseline(series: SeriesPoint[]): SeriesPoint[] {
  if (series.length === 0) return [];
  const baseline = series[0].value;
  if (!isFinite(baseline) || baseline === 0) return series.map(p => ({ ...p }));
  return series.map(p => ({ date: p.date, value: (p.value / baseline) * 100 }));
}

/**
 * Collapse per-(account, symbol) holdings into a single row per symbol. Used
 * by the Holdings view when NOT filtered to a single account: a user holding
 * VITAX in 5 separate JPM accounts should see ONE VITAX row in the unfiltered
 * view, not 5 duplicates. The per-account drill-in view keeps the unaggregated
 * shape (one row per symbol within that account) so the user can still see
 * "this is what JPM 2180 holds".
 *
 * Aggregation rules:
 *   - qty           = Σ qty across accounts
 *   - cost          = Σ cost across accounts
 *   - value         = Σ value across accounts (qty × price uses the live price,
 *                     which is the same across accounts for the same symbol,
 *                     so re-summing here equals qty_total × price)
 *   - basis         = cost / qty (recomputed from totals)
 *   - gain          = value - cost
 *   - gainPct       = gain / cost
 *   - dayChange     = Σ dayChange (null contributions skipped; if EVERY input
 *                     row is null we propagate null so the brokerage tile
 *                     "(N symbols pending)" math stays accurate)
 *   - dayChangePct  = dayChange / Σ qty × prevClose (recovered from price -
 *                     perShareMove on each input row; null when no row had
 *                     prev_close)
 *   - heldInAccounts = number of distinct account ids that contributed
 *
 * The first row's `name`, `sector`, `industry`, `sym`, `account`, and `spark`
 * fields are inherited (sector / name don't differ across accounts for the
 * same symbol; `account` is left pointing at the first one so HoldingDetailView
 * can still find one of the accounts; `spark` series is currently empty for
 * all holdings).
 *
 * `share` (% of portfolio) is recomputed against the new aggregated value
 * total so the column still sums to 1.0.
 *
 * O(n): one pass through `holdings`, then one pass to compute share. The
 * function is pure (no async, no I/O), which keeps it test-friendly.
 */
export function aggregateHoldingsBySymbol(holdings: Holding[]): Holding[] {
  if (holdings.length === 0) return [];

  type Acc = {
    base: Holding;
    qty: number;
    cost: number;
    value: number;
    dayChange: number;
    dayChangeContributions: number; // count of rows with non-null dayChange
    prevValueSum: number;
    accountIds: Set<string>;
  };
  const bySym = new Map<string, Acc>();
  for (const h of holdings) {
    const cur = bySym.get(h.sym);
    if (!cur) {
      bySym.set(h.sym, {
        base: h,
        qty: h.qty,
        cost: h.cost,
        value: h.value,
        dayChange: h.dayChange == null ? 0 : h.dayChange,
        dayChangeContributions: h.dayChange == null ? 0 : 1,
        prevValueSum: computePrevValue(h),
        accountIds: new Set([h.account]),
      });
      continue;
    }
    cur.qty += h.qty;
    cur.cost += h.cost;
    cur.value += h.value;
    if (h.dayChange != null) {
      cur.dayChange += h.dayChange;
      cur.dayChangeContributions += 1;
    }
    cur.prevValueSum += computePrevValue(h);
    cur.accountIds.add(h.account);
    // Prefer a non-empty sector / industry / name over an empty one. We don't
    // expect these to differ across accounts for the same symbol, but the
    // defensive merge keeps an unfilled row from clobbering a populated one.
    if (!cur.base.sector && h.sector) cur.base = { ...cur.base, sector: h.sector };
    if (!cur.base.industry && h.industry) cur.base = { ...cur.base, industry: h.industry };
    if (cur.base.name === cur.base.sym && h.name && h.name !== h.sym) {
      cur.base = { ...cur.base, name: h.name };
    }
  }

  const newTotalValue = Array.from(bySym.values()).reduce((s, a) => s + a.value, 0);
  const out: Holding[] = [];
  for (const acc of bySym.values()) {
    const gain = acc.value - acc.cost;
    const basis = acc.qty > 0 ? acc.cost / acc.qty : 0;
    const dayChange = acc.dayChangeContributions > 0 ? acc.dayChange : null;
    const dayChangePct = acc.prevValueSum > 0 && dayChange != null ? dayChange / acc.prevValueSum : null;
    out.push({
      ...acc.base,
      qty: acc.qty,
      cost: acc.cost,
      value: acc.value,
      basis,
      gain,
      gainPct: acc.cost > 0 ? gain / acc.cost : 0,
      share: newTotalValue > 0 ? acc.value / newTotalValue : 0,
      dayChange,
      dayChangePct,
      heldInAccounts: acc.accountIds.size,
    });
  }
  return out;
}

/**
 * Recover qty × prevClose for a single holding row, given price and dayChange.
 * Used by aggregateHoldingsBySymbol to compute a denominator for the
 * aggregated dayChangePct. Returns 0 when dayChange is null or when we can't
 * derive a positive prevClose (qty = 0, or the implied prevClose is non-positive).
 */
function computePrevValue(h: Holding): number {
  if (h.dayChange == null || h.qty <= 0) return 0;
  const perShareMove = h.dayChange / h.qty;
  const prevClose = h.price - perShareMove;
  if (prevClose <= 0) return 0;
  return h.qty * prevClose;
}

/**
 * Best-effort dollar-and-pct rollup of `dayChange` across the supplied
 * holdings. Returns the sum, the value-weighted percent, and how many
 * holdings were excluded because their `dayChange` was null. Used by the
 * brokerage tiles on HomeView to produce "+$1,234 today (+0.18%)" plus the
 * "(N symbols pending today's data)" footer.
 *
 * Percentage formula: sum(dayChange) / sum(prevValue), where prevValue =
 * qty × prevClose. We compute this rather than averaging holding-level
 * percentages because a $1 ticker moving 1% should not weigh the same as a
 * $500 ticker moving 1% in the per-account headline.
 */
export function rollupDayChange(
  holdings: Array<Pick<Holding, 'qty' | 'price' | 'dayChange' | 'dayChangePct'>>,
): { dayChange: number; dayChangePct: number | null; pendingCount: number } {
  let total = 0;
  let prevTotal = 0;
  let pending = 0;
  for (const h of holdings) {
    if (h.dayChange == null) {
      pending++;
      continue;
    }
    total += h.dayChange;
    // Recover qty × prevClose from price - perShareMove = prevClose. We
    // already know dayChange = qty × (price - prevClose), so
    // prevClose = price - dayChange/qty when qty > 0.
    if (h.qty > 0) {
      const perShareMove = h.dayChange / h.qty;
      const prevClose = h.price - perShareMove;
      if (prevClose > 0) prevTotal += h.qty * prevClose;
    }
  }
  const dayChangePct = prevTotal > 0 ? total / prevTotal : null;
  return { dayChange: total, dayChangePct, pendingCount: pending };
}

type TxRowMin = {
  date: string;
  symbol: string | null;
  action: string;
  quantity: number;
  account_id: string;
};

/**
 * Build a daily NAV series using REAL historical closes from the prices
 * table, with forward-fill across non-trading days. This replaced the
 * previous month-end-anchor proxy that valued every historical snapshot at
 * the holding's CURRENT price (the math that produced the +323% YTD
 * garbage on a JPM holdings-only import).
 *
 * Algorithm:
 *   1. Collect every (account, symbol) the user has ever held from the tx
 *      stream. Cash sweep "symbols" (SPAXX/QACDS/CASH) get a synthetic
 *      $1-per-unit price series since they have no Yahoo history.
 *   2. For each symbol, pull its full daily-close history from the prices
 *      table. Build a sorted array of dates and a parallel close[] array.
 *   3. Take the UNION of all symbols' history dates as the day axis (these
 *      are real trading days). For each day in the union, walk transactions
 *      ≤ that day to get current qty per (account, symbol), look up the
 *      symbol's close on that day (with forward-fill for missing days),
 *      and sum qty × close.
 *   4. Append "today" with the current resolved totalValue so YTD/1Y
 *      windows always have a most-recent anchor.
 *
 * If we have no historical price coverage at ALL (zero prices rows for
 * every held symbol), we fall back to the legacy month-end-anchor curve so
 * users without backfill still see SOMETHING. The fallback is intentionally
 * the broken old shape: empirically a wrong curve is worse than a missing
 * one for math, but it's better than a missing one for "is anything in
 * here" smoke-test. The fallback is also what existing tests pinned, so
 * keeping it preserves the test baseline while the real path runs whenever
 * the prices table is populated.
 */
async function buildHistoricalSeries(
  txRowsAsc: TxRowMin[],
  holdingObjs: Holding[],
  totalValueToday: number,
): Promise<SeriesPoint[]> {
  if (txRowsAsc.length === 0) return [];

  // Distinct symbols seen in transactions. Used both to pull prices and to
  // detect "no historical data anywhere" for the fallback decision.
  const symbolsHeld = new Set<string>();
  for (const t of txRowsAsc) {
    if (t.symbol) symbolsHeld.add(t.symbol);
  }
  if (symbolsHeld.size === 0) {
    // Pure cash flows (interest, dividends paid in cash) without any
    // securities: can't build a market-value series.
    return totalValueToday > 0
      ? [{ date: new Date(txRowsAsc[0].date), value: 0 }, { date: new Date(), value: totalValueToday }]
      : [];
  }

  // Pull historical closes for every symbol in one pass. We DON'T fan-fetch
  // here: backfillHistoricalPrices() is what populates the prices table at
  // import time (and via the Refresh history button). This function only
  // reads. That separation keeps buildPortfolio() a pure read of local data.
  const histBySymbol = new Map<string, { dates: number[]; closes: number[] }>();
  for (const sym of symbolsHeld) {
    const isCash = isCashSweepSym(sym);
    if (isCash) {
      // Cash sweeps have no Yahoo history. Mark as $1/share for every day
      // in the analysis window when we know we'll need a price for them.
      // We populate this lazily inside the day loop instead of pre-fanning.
      histBySymbol.set(sym, { dates: [], closes: [] });
      continue;
    }
    const rows = await listPriceHistory(sym).catch(() => []);
    // listPriceHistory returns oldest-first.
    const dates: number[] = [];
    const closes: number[] = [];
    for (const r of rows) {
      dates.push(+r.date);
      closes.push(r.close);
    }
    histBySymbol.set(sym, { dates, closes });
  }

  // If literally none of the symbols have any historical data, return a
  // degenerate two-point "today only" series. The previous behaviour was a
  // qty-accumulation curve (every historical qty snapshot valued at the
  // CURRENT price) which produced the diagonal line + inflated YTD that
  // Justin reported: a Jan 1 NAV computed by multiplying past-qty by
  // present-price is wrong by definition, and feeding that into the TWR
  // window math gave +283% YTD on a normal portfolio.
  //
  // With the legacy curve gone, the chart renders an explicit empty state
  // ("Your portfolio chart will fill in as your data lands here") AND the
  // metric tiles fall through to '--' when the windowed series has < 2
  // points. The user's call-to-action is the Refresh history button in
  // Settings (the recovery probe in usePortfolio.maybeRunRecovery also
  // self-heals on next launch when the flag is set but the prices table
  // is empty). Returning a lying curve is worse than no curve.
  const anyHistory = Array.from(histBySymbol.values()).some(h => h.dates.length > 0);
  if (!anyHistory && !hasAnyCashSweep(symbolsHeld)) {
    return [];
  }

  // Build the day axis: union of every symbol's price dates, clamped to
  // [earliestTxDate, today]. Trading days only (no synthetic fill).
  const earliestTx = +new Date(txRowsAsc[0].date);
  const todayMs = +new Date();
  const dayAxisSet = new Set<number>();
  for (const h of histBySymbol.values()) {
    for (const d of h.dates) {
      if (d >= earliestTx && d <= todayMs) dayAxisSet.add(d);
    }
  }
  // Always include today's wall-clock date so YTD has a current anchor.
  // Round to UTC midnight so it lines up with the rest of the axis.
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  dayAxisSet.add(todayUtc);
  // Also include the earliest-tx date so the first holdings get represented.
  dayAxisSet.add(earliestTx);

  const dayAxis = Array.from(dayAxisSet).sort((a, b) => a - b);
  if (dayAxis.length < 2) {
    // Degenerate window (one day or less of trading-day history). Don't
    // synthesize a curve; return empty and let the empty-state UX prompt
    // the user to wait for the backfill or hit Refresh history.
    return [];
  }

  // Per-symbol forward-fill cursor: while walking dayAxis ascending, advance
  // an index pointer through that symbol's dates[] array. The fwdClose stays
  // at the last close we've seen ≤ the current day.
  const cursorBySymbol = new Map<string, { i: number; fwdClose: number }>();
  for (const sym of symbolsHeld) {
    cursorBySymbol.set(sym, { i: 0, fwdClose: 0 });
  }

  // Per-(account, symbol) running qty as we walk through transactions in
  // chronological order. Same replay logic as the holdings rollup above.
  const qtyByKey = new Map<string, number>();
  let txCursor = 0;

  const series: SeriesPoint[] = [];

  for (const dayMs of dayAxis) {
    // Apply every tx with date ≤ this day.
    while (txCursor < txRowsAsc.length && +new Date(txRowsAsc[txCursor].date) <= dayMs) {
      const t = txRowsAsc[txCursor];
      if (t.symbol) {
        const k = `${t.account_id}::${t.symbol}`;
        const cur = qtyByKey.get(k) || 0;
        if (t.action === 'buy' || t.action === 'transfer_in' || t.action === 'div_reinvest') {
          qtyByKey.set(k, cur + t.quantity);
        } else if (t.action === 'sell' || t.action === 'transfer_out') {
          qtyByKey.set(k, Math.max(0, cur - t.quantity));
        }
      }
      txCursor++;
    }

    // Compute NAV for this day: Σ qty × close (forward-filled per symbol).
    let nav = 0;
    for (const [key, qty] of qtyByKey) {
      if (qty <= 0) continue;
      const sym = key.split('::')[1];
      let price = 0;
      if (isCashSweepSym(sym)) {
        // Cash sweeps: $1/unit, always.
        price = 1;
      } else {
        const hist = histBySymbol.get(sym);
        const cursor = cursorBySymbol.get(sym);
        if (hist && cursor) {
          // Advance the cursor through dates[] until we point at the LAST
          // date ≤ dayMs. The close at that index becomes the forward-fill.
          while (cursor.i < hist.dates.length && hist.dates[cursor.i] <= dayMs) {
            cursor.fwdClose = hist.closes[cursor.i];
            cursor.i++;
          }
          price = cursor.fwdClose;
        }
        // Why: if we have NO historical price for this symbol on this day,
        // skip it entirely (price stays 0, so qty * 0 = 0 contribution).
        // The prior fallback of `price = lastKnownPriceBySym` used today's
        // current price for every historical date, which on a portfolio
        // with zero real history produces a straight diagonal from
        // qty_2018 * today_price to qty_today * today_price. That diagonal
        // is a lie. Better to undercount NAV on days we don't have data
        // (the `nav > 0` filter below excludes those points entirely) and
        // let the empty-state UI render when no symbols have history.
        // Today's value is separately anchored to totalValueToday below.
      }
      nav += qty * price;
    }
    if (nav > 0) series.push({ date: new Date(dayMs), value: nav });
  }

  // The dayAxis last entry is today's UTC midnight. If totalValueToday > 0
  // and our computed NAV on that day differs (because today's Yahoo bar may
  // not have been backfilled yet), override the last point with the resolved
  // current total so YTD anchors on the live value.
  if (totalValueToday > 0 && series.length > 0) {
    const last = series[series.length - 1];
    last.value = totalValueToday;
  }

  if (series.length < 2) return [];
  return series;
}

/** Cash-sweep "symbols" are valued at $1/unit on every day; they don't
 *  have a Yahoo history. Keep the list in sync with backfill.ts. */
function isCashSweepSym(sym: string): boolean {
  const upper = sym.toUpperCase();
  return (
    upper === 'SPAXX' ||
    upper === 'FCASH' ||
    upper === 'FZFXX' ||
    upper === 'FDRXX' ||
    upper === 'VMRXX' ||
    upper === 'VMSXX' ||
    upper === 'VMFXX' ||
    upper === 'QACDS' ||
    upper === 'CASH'
  );
}

function hasAnyCashSweep(symbols: Set<string>): boolean {
  for (const s of symbols) if (isCashSweepSym(s)) return true;
  return false;
}

