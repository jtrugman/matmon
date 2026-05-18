// US market hours / status machine for the HomeView header.
//
// What this answers: given a moment in time, is the regular NYSE / NASDAQ
// session open right now, and if not, when is the next state change? We use
// this in HomeView to render strings like:
//
//   "Markets open · closes 4:00pm ET"
//   "Markets closed at 4:00pm ET today"
//   "Markets open at 9:30am ET"
//   "Markets closed · open Monday at 9:30am ET"
//   "Markets closed for Independence Day"
//
// Timezone strategy: every moment-of-day decision (is now after 4pm ET?) goes
// through Intl.DateTimeFormat with `timeZone: 'America/New_York'`, never
// hand-rolled DST math. We never assume the user's local clock matches ET.
// The "next open" math returns a real Date (anchored to the user's clock by
// the host) so callers can render it however they like.
//
// What this does NOT model: half-day early closes (1pm ET on Christmas Eve,
// day after Thanksgiving, etc.) are a polish pass on top of the
// regular-session machine and the spec calls them out as nice-to-have. Treat
// those days as closing at the regular 4pm ET. Pre-market / after-hours
// sessions are also outside the model: the regular session is what every
// quote provider's "regular market price" refers to, which is the only
// thing the HomeView header speaks to.

/**
 * Calendar of US market holiday observances. Each entry is a calendar date
 * (year, 1-indexed month, day) the market is closed plus the human-friendly
 * name of the holiday. We hard-code observances for 2026 and a sensible
 * forward window: when the market would otherwise be open but is closed
 * because of a federal holiday or NYSE-specific observance, the date appears
 * here.
 *
 * Note: when a holiday falls on a weekend, the NYSE observes it on the
 * adjacent weekday (Friday for Saturday, Monday for Sunday). The DATES
 * BELOW are the OBSERVED dates, NOT the actual federal-holiday dates. That
 * matches what we want for the closure check: the market is closed on the
 * observed date even if the federal name reads as a different calendar day.
 */
type Holiday = { year: number; month: number; day: number; name: string };

const US_MARKET_HOLIDAYS: Holiday[] = [
  // 2025: included so a Jan 1 2026 lookup with a stale clock still resolves.
  { year: 2025, month: 1, day: 1, name: "New Year's Day" },
  { year: 2025, month: 1, day: 20, name: 'Martin Luther King Jr. Day' },
  { year: 2025, month: 2, day: 17, name: "Presidents' Day" },
  { year: 2025, month: 4, day: 18, name: 'Good Friday' },
  { year: 2025, month: 5, day: 26, name: 'Memorial Day' },
  { year: 2025, month: 6, day: 19, name: 'Juneteenth' },
  { year: 2025, month: 7, day: 4, name: 'Independence Day' },
  { year: 2025, month: 9, day: 1, name: 'Labor Day' },
  { year: 2025, month: 11, day: 27, name: 'Thanksgiving Day' },
  { year: 2025, month: 12, day: 25, name: 'Christmas Day' },

  // 2026: primary year of operation.
  { year: 2026, month: 1, day: 1, name: "New Year's Day" },
  { year: 2026, month: 1, day: 19, name: 'Martin Luther King Jr. Day' },
  { year: 2026, month: 2, day: 16, name: "Presidents' Day" },
  { year: 2026, month: 4, day: 3, name: 'Good Friday' },
  { year: 2026, month: 5, day: 25, name: 'Memorial Day' },
  { year: 2026, month: 6, day: 19, name: 'Juneteenth' },
  { year: 2026, month: 7, day: 3, name: 'Independence Day' }, // Jul 4 is Saturday in 2026 → observed Fri Jul 3
  { year: 2026, month: 9, day: 7, name: 'Labor Day' },
  { year: 2026, month: 11, day: 26, name: 'Thanksgiving Day' },
  { year: 2026, month: 12, day: 25, name: 'Christmas Day' },

  // 2027: forward coverage so a "next open" search around year-end 2026
  // doesn't have to fall back to a default.
  { year: 2027, month: 1, day: 1, name: "New Year's Day" },
  { year: 2027, month: 1, day: 18, name: 'Martin Luther King Jr. Day' },
  { year: 2027, month: 2, day: 15, name: "Presidents' Day" },
  { year: 2027, month: 3, day: 26, name: 'Good Friday' },
  { year: 2027, month: 5, day: 31, name: 'Memorial Day' },
  { year: 2027, month: 6, day: 18, name: 'Juneteenth' }, // Jun 19 2027 is Saturday → observed Fri Jun 18
  { year: 2027, month: 7, day: 5, name: 'Independence Day' }, // Jul 4 2027 is Sunday → observed Mon Jul 5
  { year: 2027, month: 9, day: 6, name: 'Labor Day' },
  { year: 2027, month: 11, day: 25, name: 'Thanksgiving Day' },
  { year: 2027, month: 12, day: 24, name: 'Christmas Day' }, // Dec 25 2027 is Saturday → observed Fri Dec 24
];

export type MarketStatus =
  | { state: 'open'; closesAt: Date }
  | { state: 'closed_today_post'; openedAt: Date; closedAt: Date }
  | { state: 'closed_today_pre'; opensAt: Date }
  | { state: 'closed_weekend'; nextOpensAt: Date }
  | { state: 'closed_holiday'; nextOpensAt: Date; holidayName: string };

/**
 * Date object representing midnight ET on the same calendar day as `at`.
 * Used as an anchor for "today's session" math so we never accidentally
 * mix up the user's local day with the NY trading day. The returned Date
 * is in absolute time (UTC under the hood) but corresponds to 00:00 in
 * America/New_York on the ET-calendar day that contains `at`.
 */
function startOfDayInET(at: Date): Date {
  const parts = etCalendarParts(at);
  // Build a Date at midnight ET. We construct via "YYYY-MM-DDT00:00:00"
  // and the ET offset for that date; Intl already gave us the resolved
  // wall-clock parts so we just trust them here. For the offset we read
  // the timeZoneName which Intl returns as "GMT-04:00" or "GMT-05:00";
  // we parse the hours portion and build an absolute timestamp.
  const offsetMin = etOffsetMinutes(at);
  // ms = local epoch at midnight ET (= calendar parts as if UTC) minus the offset.
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  return new Date(utcMs - offsetMin * 60_000);
}

/**
 * Wall-clock parts (year / month / day / hour / minute / weekday) for `at`
 * expressed in America/New_York. Weekday is 0=Sun..6=Sat to match
 * Date#getDay(). Uses Intl so DST transitions are handled correctly without
 * us hand-rolling the rules.
 */
export function etCalendarParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  // Intl.DateTimeFormat with `timeZone: 'America/New_York'` is the canonical
  // way to project a UTC instant onto the NY calendar. We pull the parts
  // separately to avoid locale-dependent format strings.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(at);
  const m = new Map<string, string>();
  for (const p of parts) m.set(p.type, p.value);
  const WEEKDAYS: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: parseInt(m.get('year') || '0', 10),
    month: parseInt(m.get('month') || '0', 10),
    day: parseInt(m.get('day') || '0', 10),
    hour: parseInt(m.get('hour') || '0', 10),
    minute: parseInt(m.get('minute') || '0', 10),
    weekday: WEEKDAYS[m.get('weekday') || 'Sun'] ?? 0,
  };
}

/**
 * UTC offset for America/New_York at instant `at`, expressed in minutes
 * EAST of UTC. EDT (summer) = -240, EST (winter) = -300. Computed by
 * comparing the projected calendar parts to the actual UTC parts.
 */
function etOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  // Pull the offset string ("GMT-4", "GMT-04:00", or "GMT" for UTC).
  const parts = fmt.formatToParts(at);
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
  // Strip "GMT" prefix and parse "+HH:MM" / "-HH:MM" / "-H" / "+H".
  const trimmed = tzName.replace(/^GMT/, '').trim();
  if (trimmed === '') return 0;
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const body = trimmed.replace(/^[+-]/, '');
  const [hStr, mStr = '0'] = body.split(':');
  const hours = parseInt(hStr, 10) || 0;
  const minutes = parseInt(mStr, 10) || 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Build an absolute Date corresponding to a specific wall-clock time on the
 * ET calendar day of `at`. E.g. `etTimeOn(now, 9, 30)` → that day's 9:30am ET.
 * Honors DST automatically because the offset comes from Intl on the same
 * instant the caller passed in.
 */
function etTimeOn(at: Date, hour: number, minute: number): Date {
  const parts = etCalendarParts(at);
  // The offset to use is the offset on the TARGET wall-clock instant, which
  // is normally the same as the offset on `at`, except across the DST jump.
  // For our purposes (9:30am or 4pm on the same calendar day as `at`), the
  // offset is the same as `at`'s offset 99.99% of the time. The DST jump at
  // 2:00am ET happens before market open and after market close, so this
  // simplification is safe for 9:30 and 16:00 targets.
  const offsetMin = etOffsetMinutes(at);
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);
  return new Date(utcMs - offsetMin * 60_000);
}

/**
 * Is the ET calendar day of `at` a US market holiday? Returns the holiday
 * name if yes, null otherwise. Lookup is a linear scan over the small
 * holiday calendar above.
 */
function holidayName(at: Date): string | null {
  const parts = etCalendarParts(at);
  for (const h of US_MARKET_HOLIDAYS) {
    if (h.year === parts.year && h.month === parts.month && h.day === parts.day) {
      return h.name;
    }
  }
  return null;
}

/**
 * Is the ET calendar day of `at` a Saturday or Sunday?
 */
function isWeekend(at: Date): boolean {
  const wd = etCalendarParts(at).weekday;
  return wd === 0 || wd === 6;
}

/**
 * Step from `at` forward in time, day by day in ET, until we find a
 * weekday that is also not a US market holiday. Returns a Date set to
 * 9:30am ET on that day. The search caps at 14 days so a broken holiday
 * calendar can't loop forever.
 */
function findNextOpen(from: Date): Date {
  let cursor = from;
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(cursor) && !holidayName(cursor)) {
      // Only count this day as "opens here" if the 9:30am ET moment on it
      // is strictly after `from` (otherwise we'd return a moment in the past
      // when `from` is 9:30am ET sharp on a trading day).
      const open = etTimeOn(cursor, 9, 30);
      if (+open > +from) return open;
    }
    // Step to the next ET calendar day. We do this by advancing 24h and
    // then snapping to midnight ET so we don't drift across DST.
    cursor = new Date(+startOfDayInET(cursor) + 26 * 60 * 60 * 1000);
    cursor = startOfDayInET(cursor);
  }
  // Fallback: 9:30am ET tomorrow. Caller should never hit this.
  return etTimeOn(new Date(+startOfDayInET(from) + 26 * 60 * 60 * 1000), 9, 30);
}

/**
 * Current US market status. Default `now` is `new Date()` so production
 * code stays trivial; tests pass a fixed instant. Status is computed at
 * minute granularity (we round nothing; the open/close moments are at
 * 9:30:00 and 16:00:00 ET sharp).
 */
export function getMarketStatus(now: Date = new Date()): MarketStatus {
  const holiday = holidayName(now);
  if (holiday) {
    return {
      state: 'closed_holiday',
      nextOpensAt: findNextOpen(now),
      holidayName: holiday,
    };
  }
  if (isWeekend(now)) {
    return { state: 'closed_weekend', nextOpensAt: findNextOpen(now) };
  }
  // Weekday, non-holiday: compare against today's 9:30am and 4:00pm ET.
  const open = etTimeOn(now, 9, 30);
  const close = etTimeOn(now, 16, 0);
  if (+now < +open) {
    return { state: 'closed_today_pre', opensAt: open };
  }
  if (+now >= +open && +now < +close) {
    return { state: 'open', closesAt: close };
  }
  // Post-close on a trading day.
  return { state: 'closed_today_post', openedAt: open, closedAt: close };
}

/**
 * Format a Date as a lowercase am/pm "h:mmam"/"h:mmpm" string in the
 * America/New_York timezone. "9:30am" / "4:00pm" / "12:00pm" / "12:00am".
 * Mirrors src/lib/format.ts's `fmtTimeOfDay`, but always in ET (which is
 * what the HomeView header speaks to).
 */
export function formatEtTime(at: Date): string {
  const parts = etCalendarParts(at);
  let h = parts.hour;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(parts.minute).padStart(2, '0')}${ampm}`;
}

/**
 * Three-letter ET weekday for `at` ("Mon", "Tue", ...). Used when the
 * "next opens" day is more than 1 day from today and we want to render
 * the actual day name.
 */
export function formatEtWeekday(at: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
  return fmt.format(at);
}

/**
 * Compose the user-facing market status string for the HomeView header.
 * Pure helper so it's covered by tests without rendering the view.
 *
 * Outputs follow the spec:
 *   open                  → "Markets open · closes 4:00pm ET"
 *   closed_today_post     → "Markets closed at 4:00pm ET today"
 *   closed_today_pre      → "Markets open at 9:30am ET"
 *   closed_weekend        → "Markets closed · open Monday at 9:30am ET"
 *   closed_holiday        → "Markets closed for Independence Day"
 */
export function describeMarketStatus(status: MarketStatus): string {
  switch (status.state) {
    case 'open':
      return `Markets open · closes ${formatEtTime(status.closesAt)} ET`;
    case 'closed_today_post':
      return `Markets closed at ${formatEtTime(status.closedAt)} ET today`;
    case 'closed_today_pre':
      return `Markets open at ${formatEtTime(status.opensAt)} ET`;
    case 'closed_weekend':
      return `Markets closed · open ${formatEtWeekday(status.nextOpensAt)} at ${formatEtTime(status.nextOpensAt)} ET`;
    case 'closed_holiday':
      return `Markets closed for ${status.holidayName}`;
  }
}
