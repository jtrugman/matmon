import { describe, expect, it } from 'vitest';
import { fmtDate, fmtMoney, fmtPct } from '../src/lib/format';

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

  it('returns em-dash for null/undefined', () => {
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(undefined)).toBe('—');
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
    expect(fmtPct(null)).toBe('—');
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
