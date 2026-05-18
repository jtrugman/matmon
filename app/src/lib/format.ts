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
