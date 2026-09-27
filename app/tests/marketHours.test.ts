import { describe, expect, it } from 'vitest';
import {
  describeMarketStatus,
  etCalendarParts,
  formatEtTime,
  formatEtWeekday,
  getMarketStatus,
} from '../src/lib/marketHours';

// Helper: build an absolute Date for a specific wall-clock time in ET.
// We compute the ET offset for the target moment via Intl, then offset
// the UTC ms accordingly. This lets us write tests like
// `etInstant(2026, 5, 18, 16, 1)` and trust we landed at 4:01pm ET
// regardless of where the test host machine is.
function etInstant(
  year: number,
  month: number, // 1-indexed
  day: number,
  hour: number,
  minute: number,
): Date {
  // First, approximate the moment by guessing a UTC offset. We'll iterate
  // once: build a Date assuming -240 (EDT), measure what Intl says the ET
  // offset actually is at that moment, and re-anchor.
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 4, minute));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(guess);
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const trimmed = tzName.replace(/^GMT/, '').trim();
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const body = trimmed.replace(/^[+-]/, '');
  const [hStr, mStr = '0'] = body.split(':');
  const offsetMin = sign * ((parseInt(hStr, 10) || 0) * 60 + (parseInt(mStr, 10) || 0));
  // True UTC ms = ET-wall ms - offset (offset is east of UTC).
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMin * 60_000;
  return new Date(utcMs);
}

describe('etCalendarParts', () => {
  it('projects a UTC instant into the ET calendar', () => {
    // 2026-05-18 (Mon) at 16:01 ET. We feed in an instant constructed
    // to land exactly there.
    const at = etInstant(2026, 5, 18, 16, 1);
    const parts = etCalendarParts(at);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(18);
    expect(parts.hour).toBe(16);
    expect(parts.minute).toBe(1);
    expect(parts.weekday).toBe(1); // Monday
  });

  it('honors DST: same wall-clock in January is EST, July is EDT', () => {
    const jan = etInstant(2026, 1, 15, 10, 0); // 10am ET Jan 15 2026 (EST = -5)
    const jul = etInstant(2026, 7, 15, 10, 0); // 10am ET Jul 15 2026 (EDT = -4)
    expect(etCalendarParts(jan).hour).toBe(10);
    expect(etCalendarParts(jul).hour).toBe(10);
    // Sanity: the two should resolve to different UTC offsets (the jan
    // version is 1h "later" in UTC for the same ET wall-clock).
    expect(jul.getUTCHours()).toBe(14); // 10am EDT = 14:00 UTC
    expect(jan.getUTCHours()).toBe(15); // 10am EST = 15:00 UTC
  });
});

describe('getMarketStatus', () => {
  it('Mon 10:00am ET → state: "open"', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 10, 0));
    expect(s.state).toBe('open');
    if (s.state === 'open') {
      // closesAt should be 4:00pm ET same day.
      expect(formatEtTime(s.closesAt)).toBe('4:00pm');
      expect(etCalendarParts(s.closesAt).day).toBe(18);
    }
  });

  it('Mon 4:01pm ET → state: "closed_today_post" (Justin\'s bug)', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 16, 1));
    expect(s.state).toBe('closed_today_post');
    if (s.state === 'closed_today_post') {
      expect(formatEtTime(s.openedAt)).toBe('9:30am');
      expect(formatEtTime(s.closedAt)).toBe('4:00pm');
    }
  });

  it('Mon 4:23pm ET (the literal scenario in Justin\'s screenshot) → closed_today_post', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 16, 23));
    expect(s.state).toBe('closed_today_post');
    expect(describeMarketStatus(s)).toBe('Markets closed at 4:00pm ET today');
  });

  it('Sat 12:00pm ET (Sat May 23 2026) → state: "closed_weekend", nextOpensAt = Tue May 26 9:30am ET (Memorial Day Mon)', () => {
    // Sat May 23 2026 → next open would be Mon May 25, but that's Memorial
    // Day on the NYSE calendar. The next-open math therefore correctly
    // advances to Tuesday May 26. This is the "holidays falling adjacent to
    // weekends" case the spec asks us to verify.
    const s = getMarketStatus(etInstant(2026, 5, 23, 12, 0)); // Sat
    expect(s.state).toBe('closed_weekend');
    if (s.state === 'closed_weekend') {
      expect(formatEtWeekday(s.nextOpensAt)).toBe('Tue');
      expect(formatEtTime(s.nextOpensAt)).toBe('9:30am');
      const p = etCalendarParts(s.nextOpensAt);
      expect(p.month).toBe(5);
      expect(p.day).toBe(26);
    }
  });

  it('Sat 12:00pm ET on a "normal" weekend (no adjacent holiday) → nextOpensAt = Mon 9:30am ET', () => {
    // Sat May 16 2026 → next open is Mon May 18 9:30am ET. No holiday in
    // the way. This is the canonical weekend case.
    const s = getMarketStatus(etInstant(2026, 5, 16, 12, 0)); // Sat
    expect(s.state).toBe('closed_weekend');
    if (s.state === 'closed_weekend') {
      expect(formatEtWeekday(s.nextOpensAt)).toBe('Mon');
      expect(formatEtTime(s.nextOpensAt)).toBe('9:30am');
      const p = etCalendarParts(s.nextOpensAt);
      expect(p.month).toBe(5);
      expect(p.day).toBe(18);
    }
  });

  it('Mon 7:00am ET → state: "closed_today_pre" with opensAt = today 9:30am ET', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 7, 0));
    expect(s.state).toBe('closed_today_pre');
    if (s.state === 'closed_today_pre') {
      expect(formatEtTime(s.opensAt)).toBe('9:30am');
      expect(etCalendarParts(s.opensAt).day).toBe(18);
    }
  });

  it('Jul 3 2026 (Independence Day observed Friday) 11am ET → closed_holiday', () => {
    // Jul 4 2026 falls on a Saturday, so the NYSE observes Independence
    // Day on Friday Jul 3.
    const s = getMarketStatus(etInstant(2026, 7, 3, 11, 0));
    expect(s.state).toBe('closed_holiday');
    if (s.state === 'closed_holiday') {
      expect(s.holidayName).toBe('Independence Day');
    }
  });

  it('Jul 4 2026 (Saturday) 11am ET → closed_weekend (not a holiday on the wall calendar)', () => {
    // Jul 4 itself is a Saturday in 2026. The holiday was observed Fri the 3rd
    // so the closure reason on the 4th is just "weekend".
    const s = getMarketStatus(etInstant(2026, 7, 4, 11, 0));
    expect(s.state).toBe('closed_weekend');
  });

  it('Jul 5 2027 (Independence Day observed Monday, since Jul 4 is Sunday) → closed_holiday', () => {
    // Jul 4 2027 is a Sunday, so the NYSE observes the holiday on Mon
    // Jul 5. Verifies the "next opens" math handles holidays falling on
    // weekends with observed Mondays.
    const s = getMarketStatus(etInstant(2027, 7, 5, 11, 0));
    expect(s.state).toBe('closed_holiday');
    if (s.state === 'closed_holiday') {
      expect(s.holidayName).toBe('Independence Day');
      // Tue Jul 6 9:30am ET.
      expect(formatEtWeekday(s.nextOpensAt)).toBe('Tue');
      const p = etCalendarParts(s.nextOpensAt);
      expect(p.year).toBe(2027);
      expect(p.month).toBe(7);
      expect(p.day).toBe(6);
    }
  });

  it('opens precisely at 9:30am ET (boundary check)', () => {
    const exactlyOpen = getMarketStatus(etInstant(2026, 5, 18, 9, 30));
    expect(exactlyOpen.state).toBe('open');
  });

  it('closes precisely at 4:00pm ET (boundary check)', () => {
    // 4:00:00 ET sharp → "closed today post". The session is open
    // [9:30, 16:00) inclusive-exclusive: the 4pm tick itself is the close.
    const exactlyClose = getMarketStatus(etInstant(2026, 5, 18, 16, 0));
    expect(exactlyClose.state).toBe('closed_today_post');
  });
});

describe('describeMarketStatus', () => {
  it('formats "open" with the close time', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 10, 0));
    expect(describeMarketStatus(s)).toBe('Markets open · closes 4:00pm ET');
  });

  it('formats "closed_today_post" with "closed 4:00pm ET today"', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 16, 23));
    expect(describeMarketStatus(s)).toBe('Markets closed at 4:00pm ET today');
  });

  it('formats "closed_today_pre" with the open time', () => {
    const s = getMarketStatus(etInstant(2026, 5, 18, 7, 0));
    expect(describeMarketStatus(s)).toBe('Markets open at 9:30am ET');
  });

  it('formats "closed_weekend" with the next-open day and time', () => {
    // Normal weekend (no adjacent holiday) → "open Mon at 9:30am ET".
    const s = getMarketStatus(etInstant(2026, 5, 16, 12, 0)); // Sat
    expect(describeMarketStatus(s)).toBe('Markets closed · open Mon at 9:30am ET');
  });

  it('formats "closed_holiday" with the holiday name', () => {
    const s = getMarketStatus(etInstant(2026, 7, 3, 11, 0));
    expect(describeMarketStatus(s)).toBe('Markets closed for Independence Day');
  });

  it('formats Christmas correctly', () => {
    const s = getMarketStatus(etInstant(2026, 12, 25, 11, 0));
    expect(describeMarketStatus(s)).toBe('Markets closed for Christmas Day');
  });

  it('formats Thanksgiving correctly', () => {
    const s = getMarketStatus(etInstant(2026, 11, 26, 11, 0));
    expect(describeMarketStatus(s)).toBe('Markets closed for Thanksgiving Day');
  });
});
