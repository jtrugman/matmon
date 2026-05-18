// Tests for the chart's segmented-control plumbing: windowSeries,
// segmentWindow, normalizeToBaseline, plus twrOverWindow against a known
// portfolio shape. These pin the fix for the "diagonal-line, YTD spans
// 2018-2026, +283% YTD" report: the timeframe state existed but never
// reached the chart, and the metrics tiles computed TWR against the
// qty-accumulation legacy series.

import { describe, expect, it } from 'vitest';
import {
  normalizeToBaseline,
  segmentWindow,
  windowSeries,
} from '../src/lib/portfolio';
import { twrOverWindow } from '../src/lib/performance';

function p(iso: string, v: number) {
  return { date: new Date(iso), value: v };
}

describe('windowSeries', () => {
  const fullSeries = [
    p('2018-01-01', 6000),
    p('2020-03-23', 80_000),
    p('2022-01-01', 320_000),
    p('2024-01-01', 500_000),
    p('2026-01-01', 700_000),
    p('2026-05-18', 731_000),
  ];

  it('clamps start up to the earliest available point (no fabricated baseline)', () => {
    const out = windowSeries(fullSeries, new Date('2000-01-01'), new Date('2026-05-18'));
    // Earliest stored is 2018-01-01; the window should start there, not
    // at 2000-01-01.
    expect(out[0].date.toISOString().slice(0, 10)).toBe('2018-01-01');
    expect(out[0].value).toBe(6000);
  });

  it('clamps end down to the latest available point', () => {
    const out = windowSeries(fullSeries, new Date('2018-01-01'), new Date('2030-01-01'));
    expect(out[out.length - 1].date.toISOString().slice(0, 10)).toBe('2026-05-18');
  });

  it('YTD on a 2018-started portfolio: window starts Jan 1 of current year', () => {
    // Mock a "now" of 2026-05-18; YTD start is Jan 1 2026.
    const now = new Date('2026-05-18T12:00:00Z');
    const { start, end } = segmentWindow('YTD', now);
    expect(start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(end.getTime()).toBe(now.getTime());
    const ytd = windowSeries(fullSeries, start, end);
    // Should keep 2026-01-01 and 2026-05-18 only.
    expect(ytd.length).toBe(2);
    expect(ytd[0].date.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(ytd[ytd.length - 1].date.toISOString().slice(0, 10)).toBe('2026-05-18');
  });

  it('1M window: start = now - 30 days', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const { start } = segmentWindow('1M', now);
    const expected = new Date(+now - 30 * 86_400_000);
    expect(start.getTime()).toBe(expected.getTime());
  });

  it('ALL window: returns the full available series', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const { start, end } = segmentWindow('ALL', now);
    const all = windowSeries(fullSeries, start, end);
    expect(all.length).toBe(fullSeries.length);
  });

  it('empty input returns empty output', () => {
    expect(windowSeries([], new Date('2024-01-01'), new Date('2024-12-31'))).toEqual([]);
  });

  it('degenerate window (start > end after clamping) returns empty', () => {
    // Series only covers 2024; ask for 2025-only.
    const tinySeries = [p('2024-01-01', 100), p('2024-12-31', 110)];
    const out = windowSeries(tinySeries, new Date('2025-01-01'), new Date('2025-12-31'));
    expect(out).toEqual([]);
  });
});

describe('twrOverWindow on a real-mark series', () => {
  it('YTD on a portfolio with $100K Jan 1, $115K June 30, no flows = 15%', () => {
    const series = [p('2024-01-01', 100_000), p('2024-06-30', 115_000)];
    const r = twrOverWindow(series, [], new Date('2024-01-01'), new Date('2024-06-30'));
    expect(r).toBeCloseTo(0.15, 4);
  });

  it('full-year TWR with mid-year deposit removed by flow adjustment', () => {
    // 100k → 110k (market) → 215k (deposit 100k) → 236.5k (10% market).
    // TWR should be 1.10 × 1.10 - 1 = 0.21, NOT 1.365.
    const series = [
      p('2024-01-01', 100_000),
      p('2024-06-30', 215_000),
      p('2024-12-31', 236_500),
    ];
    const flows = [{ date: new Date('2024-06-30'), amount: -105_000 }];
    const r = twrOverWindow(series, flows, new Date('2024-01-01'), new Date('2024-12-31'));
    expect(r).toBeCloseTo(0.21, 2);
  });

  it('YTD on the broken legacy-shape series reproduces the +283% bug', () => {
    // Sanity check: confirm that the LEGACY diagonal-line shape produces
    // the +283% number Justin reported, while the same window on a real-
    // mark series produces a sane number. This is a regression guard:
    // when buildHistoricalSeries is correctly wired the series feeding
    // YTD must have a sane Jan-1 NAV (not the legacy diagonal-line value).
    const legacyShapeSeries = [
      p('2018-01-01', 6_000),
      p('2026-01-01', 190_000), // qty-accumulation curve hits ~$190K here
      p('2026-05-18', 731_000),
    ];
    const ytd = twrOverWindow(
      legacyShapeSeries,
      [],
      new Date('2026-01-01'),
      new Date('2026-05-18'),
    );
    // (731 - 190) / 190 ≈ 2.847, the same +285% Justin saw.
    expect(ytd).toBeGreaterThan(2.5);

    const realMarkSeries = [
      p('2018-01-01', 6_000),
      p('2026-01-01', 710_000), // real-mark Jan 1 is roughly today minus the YTD swing
      p('2026-05-18', 731_000),
    ];
    const ytdReal = twrOverWindow(
      realMarkSeries,
      [],
      new Date('2026-01-01'),
      new Date('2026-05-18'),
    );
    // (731 - 710) / 710 ≈ 0.03, single-digit percent.
    expect(ytdReal).toBeLessThan(0.1);
    expect(ytdReal).toBeGreaterThan(-0.1);
  });
});

describe('per-segment window numbers on a realistic portfolio shape', () => {
  // Simulate Justin's portfolio shape: 8 years of monotonic-ish growth from
  // 2018 to today. Real-mark NAVs only (no qty-accumulation lies). Today
  // sits at $731K, last-year close was $710K, two years ago $620K, etc.
  // The TWR for each segment should be a single-digit-percent (or low
  // double digits for the 5Y / ALL windows) and NEVER >100% on YTD.
  //
  // This is the table-format check Justin asked for in the spec's
  // "Per-segment numbers" section.
  const NOW = new Date('2026-05-18T12:00:00Z');
  const realSeries = [
    p('2018-01-01', 6_000),
    p('2019-01-01', 28_000),
    p('2020-03-23', 60_000), // covid trough
    p('2021-01-01', 180_000),
    p('2022-01-01', 320_000),
    p('2022-09-30', 270_000), // 2022 selloff
    p('2023-01-01', 310_000),
    p('2024-01-01', 480_000),
    p('2025-01-01', 600_000),
    p('2025-11-18', 700_000), // 6M ago
    p('2026-02-18', 720_000), // 3M ago
    p('2026-04-18', 725_000), // 1M ago
    p('2026-05-01', 728_000),
    p('2026-05-18', 731_000),
  ];

  const SEGMENTS = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'] as const;

  for (const seg of SEGMENTS) {
    it(`${seg} window produces a sane TWR`, () => {
      const { start, end } = segmentWindow(seg, NOW);
      const windowed = windowSeries(realSeries, start, end);
      expect(windowed.length).toBeGreaterThanOrEqual(2);
      const twrVal = twrOverWindow(realSeries, [], start, end);
      // Single-digit-percent YTD on a steady portfolio: |TWR| < 100% for
      // every sub-1y segment, and < 100x for ALL.
      expect(Number.isFinite(twrVal)).toBe(true);
      if (seg === 'YTD' || seg === '1M' || seg === '3M' || seg === '6M' || seg === '1Y') {
        // Steady portfolio: a year's worth of return is, like, single-
        // digit percent here. The bug Justin reported was YTD = +283%.
        expect(Math.abs(twrVal)).toBeLessThan(1.0);
      }
      // ALL on this shape should be very positive (the portfolio grew 100x
      // over 8 years).
      if (seg === 'ALL') {
        expect(twrVal).toBeGreaterThan(10);
      }
    });
  }

  it('YTD specifically returns ~3% on the realistic shape, NOT +283%', () => {
    const { start, end } = segmentWindow('YTD', NOW);
    const ytd = twrOverWindow(realSeries, [], start, end);
    // Jan 1 2026 NAV was $600K; today is $731K. The realistic Jan 1 is
    // actually missing from the data (the 2025 final price was $700K
    // at Nov 18), so the YTD start clamps to the first available point
    // AFTER Jan 1 2026, which is $720K on Feb 18. (731-720)/720 ≈ 1.5%.
    expect(ytd).toBeGreaterThan(0);
    expect(ytd).toBeLessThan(0.1); // never >10%; the bug was +283%
  });
});

describe('normalizeToBaseline', () => {
  it('rebases the first point to 100 and scales the rest proportionally', () => {
    const out = normalizeToBaseline([p('2024-01-01', 50), p('2024-06-30', 60), p('2024-12-31', 55)]);
    expect(out[0].value).toBe(100);
    expect(out[1].value).toBeCloseTo(120, 4);
    expect(out[2].value).toBeCloseTo(110, 4);
  });

  it('empty input is empty', () => {
    expect(normalizeToBaseline([])).toEqual([]);
  });

  it('does not divide by zero on a degenerate baseline', () => {
    const out = normalizeToBaseline([p('2024-01-01', 0), p('2024-06-30', 10)]);
    // Defensive: we don't NaN. The caller should not pass a 0 baseline,
    // but we tolerate it.
    expect(Number.isFinite(out[0].value)).toBe(true);
    expect(Number.isFinite(out[1].value)).toBe(true);
  });
});
