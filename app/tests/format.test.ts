import { describe, expect, it } from 'vitest';
import { fmtDate, fmtMoney, fmtPct, formatPricesAsOf } from '../src/lib/format';

describe('fmtMoney', () => {
  it('formats whole dollars with thousands separators', () => {
    expect(fmtMoney(1234567)).toBe('$1,234,567');
  });

  it('formats cents when requested', () => {
    expect(fmtMoney(1234.56, { cents: true })).toBe('$1,234.56');
  });

  it('formats negatives with a leading minus', () => {
    expect(fmtMoney(-50.5, { cents: true })).toBe('-$50.50');
  });

  it('compact notation uses M for millions', () => {
    expect(fmtMoney(1_206_452.82, { compact: true })).toBe('$1.21M');
  });

  it('compact notation uses K for thousands', () => {
    expect(fmtMoney(48720, { compact: true })).toBe('$49K');
  });

  it('compact notation passes through small values', () => {
    expect(fmtMoney(412, { compact: true })).toBe('$412');
  });

  it('returns double-hyphen placeholder for null/undefined', () => {
    expect(fmtMoney(null)).toBe('--');
    expect(fmtMoney(undefined)).toBe('--');
  });

  it('handles zero', () => {
    expect(fmtMoney(0)).toBe('$0');
    expect(fmtMoney(0, { cents: true })).toBe('$0.00');
  });
});

describe('fmtPct', () => {
  it('prefixes positives with +', () => {
    expect(fmtPct(0.124)).toBe('+12.40%');
  });

  it('keeps the minus on negatives', () => {
    expect(fmtPct(-0.083)).toBe('-8.30%');
  });

  it('respects decimals override', () => {
    expect(fmtPct(0.0825, 0)).toBe('+8%');
    expect(fmtPct(0.0825, 4)).toBe('+8.2500%');
  });

  it('handles null', () => {
    expect(fmtPct(null)).toBe('--');
  });
});

describe('fmtDate', () => {
  const d = new Date(2026, 4, 17); // May 17 2026

  it('default short format', () => {
    expect(fmtDate(d)).toBe('May 17');
  });

  it('month + year', () => {
    expect(fmtDate(d, 'monthYear')).toBe('May 2026');
  });

  it('year only', () => {
    expect(fmtDate(d, 'year')).toBe('2026');
  });
});

describe('formatPricesAsOf', () => {
  // Fixed reference "now" for deterministic snapshots. May 18 2026 (a Monday),
  // 3:00pm local. The local-time anchor matters: the helper compares calendar
  // days in local time, so swapping in UTC math here would flake.
  const now = new Date(2026, 4, 18, 15, 0, 0);

  it('returns the "not yet fetched" fallback when given null', () => {
    expect(formatPricesAsOf(null, now)).toBe('Prices not yet fetched');
    expect(formatPricesAsOf(undefined, now)).toBe('Prices not yet fetched');
  });

  it('shows lowercase am/pm time when the fetch landed today', () => {
    // 2:45pm same day
    const at = new Date(2026, 4, 18, 14, 45, 30);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of 2:45pm');
  });

  it('treats a morning fetch on the same day as same-day (am label)', () => {
    // 9:05am earlier the same day
    const at = new Date(2026, 4, 18, 9, 5, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of 9:05am');
  });

  it('shows weekday + time for yesterday', () => {
    // Sun May 17 11:32am, viewed from Mon May 18 3:00pm
    const at = new Date(2026, 4, 17, 11, 32, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of Sun 11:32am');
  });

  it('shows weekday + time for 3 days ago', () => {
    // Fri May 15 4:00pm, viewed from Mon May 18 3:00pm
    const at = new Date(2026, 4, 15, 16, 0, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of Fri 4:00pm');
  });

  it('falls back to "Month Day" once the fetch is older than 6 days', () => {
    // May 8 noon, viewed from May 18 3:00pm = 10 days ago
    const at = new Date(2026, 4, 8, 12, 0, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of May 8');
  });

  it('uses 12pm for noon and 12am for midnight', () => {
    expect(formatPricesAsOf(new Date(2026, 4, 18, 12, 0, 0), now)).toBe('Prices as of 12:00pm');
    expect(formatPricesAsOf(new Date(2026, 4, 18, 0, 0, 0), now)).toBe('Prices as of 12:00am');
  });

  it('same-day morning fetch shows am label', () => {
    // 8:15am on the same calendar day as `now` (3:00pm).
    const at = new Date(2026, 4, 18, 8, 15, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of 8:15am');
  });

  it('same-day afternoon fetch shows pm label', () => {
    // 2:30pm on the same calendar day as `now`.
    const at = new Date(2026, 4, 18, 14, 30, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of 2:30pm');
  });

  it('yesterday fetch (Sunday) shows "Sun <time>"', () => {
    // Sun May 17 6:00pm, viewed from Mon May 18 3:00pm.
    const at = new Date(2026, 4, 17, 18, 0, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of Sun 6:00pm');
  });

  it('three-days-ago fetch shows weekday + time', () => {
    // Fri May 15 4:00pm, viewed from Mon May 18 3:00pm.
    const at = new Date(2026, 4, 15, 16, 0, 0);
    expect(formatPricesAsOf(at, now)).toBe('Prices as of Fri 4:00pm');
  });

  it('returns the not-yet-fetched fallback for null input', () => {
    expect(formatPricesAsOf(null, now)).toBe('Prices not yet fetched');
  });
});
