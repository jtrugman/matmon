/**
 * Action display category. Drives both the rendered label (humanized name)
 * and the styling tier the badge picks (green for buys, red for sells,
 * purple for income, blue for cash flows, gray for fees/unknown).
 *
 * Why a separate tier from the raw action code: the action code zoo includes
 * 13 variants (buy, sell, dividend, div_reinvest, interest, cash_in,
 * cash_out, transfer_in, transfer_out, contribution, withdrawal, fee,
 * split, spinoff) but the user only needs five visual tiers to read the
 * table at a glance. Bucketing here keeps the .activity-act CSS short.
 */
export type ActionTier = 'buy' | 'sell' | 'income' | 'cashflow' | 'fee' | 'other';

/**
 * Display metadata for a single transaction action code. Used by the
 * TransactionsView and HoldingDetailView activity tables so the bucketing
 * of "what does this code mean to a human" lives in exactly one place.
 *
 * Mapping rules:
 *   buy                → "Buy",         green
 *   sell               → "Sell",        red
 *   dividend           → "Dividend",    purple (income)
 *   div_reinvest       → "Reinvest",    purple (income; same color as dividend)
 *   interest           → "Interest",    purple (income)
 *   cash_in            → "Deposit",     blue (cashflow)
 *   cash_out           → "Withdrawal",  blue (cashflow)
 *   transfer_in        → "Transfer in", blue (cashflow)
 *   transfer_out       → "Transfer out",blue (cashflow)
 *   contribution       → "Contribution",blue (cashflow)
 *   withdrawal         → "Withdrawal",  blue (cashflow)
 *   fee                → "Fee",         gray
 *   anything else      → action name title-cased, gray ("other")
 *
 * The bucket also drives the action-filter chip behavior: the "Cash flows"
 * segment matches every tier === 'cashflow' row regardless of which exact
 * code produced it.
 */
export function formatActionLabel(action: string): { label: string; tier: ActionTier } {
  switch (action) {
    case 'buy':
      return { label: 'Buy', tier: 'buy' };
    case 'sell':
      return { label: 'Sell', tier: 'sell' };
    case 'dividend':
      return { label: 'Dividend', tier: 'income' };
    case 'div_reinvest':
      return { label: 'Reinvest', tier: 'income' };
    case 'interest':
      return { label: 'Interest', tier: 'income' };
    case 'cash_in':
      return { label: 'Deposit', tier: 'cashflow' };
    case 'cash_out':
      return { label: 'Withdrawal', tier: 'cashflow' };
    case 'transfer_in':
      return { label: 'Transfer in', tier: 'cashflow' };
    case 'transfer_out':
      return { label: 'Transfer out', tier: 'cashflow' };
    case 'contribution':
      return { label: 'Contribution', tier: 'cashflow' };
    case 'withdrawal':
      return { label: 'Withdrawal', tier: 'cashflow' };
    case 'fee':
      return { label: 'Fee', tier: 'fee' };
    default: {
      // Title-case unknown action codes so an importer that adds a new
      // action (e.g. "split", "spinoff") still renders a readable badge.
      const cleaned = action.replace(/_/g, ' ').trim();
      if (cleaned.length === 0) return { label: 'Other', tier: 'other' };
      const titleCased = cleaned
        .split(' ')
        .map(w => (w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join(' ');
      return { label: titleCased, tier: 'other' };
    }
  }
}

/**
 * Action-filter segment IDs used by the Transactions view. The 'cashflow'
 * segment matches every row whose tier === 'cashflow' (cash_in, cash_out,
 * transfer_in, transfer_out, contribution, withdrawal) regardless of which
 * exact code produced it.
 */
export type ActionFilterId = 'all' | 'buy' | 'sell' | 'div' | 'cashflow';

/**
 * Predicate: does a transaction with the given tier belong in the named
 * filter segment?
 *
 *   'all'      → every row passes
 *   'buy'      → tier === 'buy'
 *   'sell'     → tier === 'sell'
 *   'div'      → tier === 'income' (dividend / div_reinvest / interest)
 *   'cashflow' → tier === 'cashflow' (deposits / withdrawals / transfers)
 *
 * Exported from format.ts so the TransactionsView module stays a
 * component-only export (Fast Refresh requirement) while the predicate
 * remains unit-testable in isolation.
 */
export function matchesActionFilter(filter: ActionFilterId, tier: ActionTier): boolean {
  if (filter === 'all') return true;
  if (filter === 'buy') return tier === 'buy';
  if (filter === 'sell') return tier === 'sell';
  if (filter === 'div') return tier === 'income';
  if (filter === 'cashflow') return tier === 'cashflow';
  return false;
}

export function fmtMoney(
  v: number | null | undefined,
  { compact = false, cents = false }: { compact?: boolean; cents?: boolean } = {},
): string {
  if (v == null) return '--';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (compact) {
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

export function fmtPct(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(decimals)}%`;
}

export function fmtDate(d: Date, fmt: 'short' | 'monthYear' | 'year' = 'short'): string {
  if (fmt === 'monthYear') return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  if (fmt === 'year') return d.getFullYear().toString();
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Lowercase am/pm time-of-day string for the "Prices as of" timestamp. We
 * roll our own instead of using toLocaleTimeString because the latter emits
 * "2:45 PM" (uppercase, with a space) and the spec calls for "2:45pm". We
 * also drop minute-leading zero ("9:05pm", not "9:05PM" or "09:05 PM").
 */
function fmtTimeOfDay(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

/**
 * Three-letter weekday abbreviation (en-US locale) used by the "Prices as of"
 * timestamp when the freshest fetch landed on a previous calendar day but
 * within the last 7 days.
 */
function fmtWeekday(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short' });
}

/**
 * Human-friendly "as of" label for the freshest successful price fetch on
 * Home. Returns one of:
 *
 *   "Prices as of 2:45pm"            within the same calendar day as now()
 *   "Prices as of Tue 11:32am"       different calendar day, within 7 days
 *   "Prices as of May 17"            older than 7 days
 *   "Prices not yet fetched"         when `at` is null (no successful fetch)
 *
 * The "today vs not today" boundary is calendar-day local time, NOT a 24-hour
 * delta: a fetch at 11pm last night reads as "Prices as of Tue 11:00pm" the
 * next morning, even though that's <24 hours ago. This matches how a user
 * thinks about "today's prices" much more closely than a sliding window.
 *
 * Callers pass `now` to enable deterministic tests. In production it defaults
 * to `new Date()`.
 */
export function formatPricesAsOf(at: Date | null | undefined, now: Date = new Date()): string {
  if (at == null) return 'Prices not yet fetched';
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `Prices as of ${fmtTimeOfDay(at)}`;
  // Day count between today and `at`, computed at calendar-day resolution so
  // a fetch yesterday at any hour shows the weekday label and a fetch eight
  // days ago shows the calendar date even if it's only 7 × 24h + 1 second
  // ago. This mirrors the "calendar boundary, not rolling window" rule the
  // sameDay check above also enforces.
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const atDay = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const dayDiff = Math.round((nowDay - atDay) / 86_400_000);
  if (dayDiff >= 1 && dayDiff <= 6) {
    return `Prices as of ${fmtWeekday(at)} ${fmtTimeOfDay(at)}`;
  }
  return `Prices as of ${fmtDate(at)}`;
}
