import { describe, expect, it } from 'vitest';
import {
  MILESTONE_DEFS,
  detectNewUnlocks,
  type PortfolioState,
} from '../src/lib/milestones';
import type { Holding } from '../src/data';

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    sym: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    qty: 10,
    price: 318.45,
    basis: 168.2,
    sector: 'US Total Mkt',
    account: 'fid-tax',
    value: 3184.5,
    cost: 1682,
    gain: 1502.5,
    gainPct: 0.89,
    share: 0.1,
    spark: [],
    ...overrides,
  };
}

function state(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    totalValue: 0,
    holdings: [],
    transactionCount: 0,
    accountCount: 0,
    dividendCount: 0,
    dividendTotal: 0,
    oldestTransactionDate: null,
    now: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  };
}

describe('detectNewUnlocks · value thresholds', () => {
  it('fires first_100k when totalValue crosses 100k', () => {
    const before = detectNewUnlocks(state({ totalValue: 99_999 }), new Set());
    expect(before).not.toContain('first_100k');

    const after = detectNewUnlocks(state({ totalValue: 100_000 }), new Set());
    expect(after).toContain('first_100k');
    // Lower thresholds should also be in the list (the user hasn't unlocked them yet).
    expect(after).toContain('first_1k');
    expect(after).toContain('first_10k');
    // Higher ones should not fire.
    expect(after).not.toContain('first_500k');
    expect(after).not.toContain('first_million');
  });

  it('fires the full ladder at $1.2M', () => {
    const fired = detectNewUnlocks(state({ totalValue: 1_200_000 }), new Set());
    expect(fired).toEqual(
      expect.arrayContaining(['first_1k', 'first_10k', 'first_100k', 'first_500k', 'first_million']),
    );
    expect(fired).not.toContain('two_million');
  });
});

describe('detectNewUnlocks · dedupe', () => {
  it('does NOT re-fire an already-unlocked milestone', () => {
    const already = new Set(['first_100k', 'first_10k', 'first_1k']);
    const fired = detectNewUnlocks(state({ totalValue: 200_000 }), already);
    expect(fired).not.toContain('first_100k');
    expect(fired).not.toContain('first_10k');
    expect(fired).not.toContain('first_1k');
  });

  it('returns an empty array when every met milestone is already unlocked', () => {
    const already = new Set(MILESTONE_DEFS.map(d => d.key));
    const fired = detectNewUnlocks(
      state({
        totalValue: 1_500_000_000,
        accountCount: 5,
        transactionCount: 1_000,
        dividendCount: 100,
        dividendTotal: 50_000,
        holdings: Array.from({ length: 20 }).map((_, i) =>
          holding({ sym: `S${i}`, sector: ['Tech', 'Bonds', 'Health', 'Energy'][i % 4] }),
        ),
        oldestTransactionDate: new Date('2010-01-01'),
      }),
      already,
    );
    expect(fired).toEqual([]);
  });
});

describe('detectNewUnlocks · diversified', () => {
  it('requires both 10+ holdings AND 3+ sectors', () => {
    // 10 holdings, only 2 sectors: should NOT fire.
    const tooFewSectors = Array.from({ length: 10 }).map((_, i) =>
      holding({ sym: `S${i}`, sector: i < 5 ? 'Tech' : 'Bonds' }),
    );
    expect(detectNewUnlocks(state({ holdings: tooFewSectors }), new Set())).not.toContain(
      'diversified',
    );

    // 9 holdings, 3 sectors: should NOT fire.
    const tooFewHoldings = Array.from({ length: 9 }).map((_, i) =>
      holding({ sym: `S${i}`, sector: ['Tech', 'Bonds', 'Health'][i % 3] }),
    );
    expect(detectNewUnlocks(state({ holdings: tooFewHoldings }), new Set())).not.toContain(
      'diversified',
    );

    // 10 holdings, 3 sectors: should fire.
    const justRight = Array.from({ length: 10 }).map((_, i) =>
      holding({ sym: `S${i}`, sector: ['Tech', 'Bonds', 'Health'][i % 3] }),
    );
    expect(detectNewUnlocks(state({ holdings: justRight }), new Set())).toContain('diversified');
  });
});

describe('detectNewUnlocks · 100_transactions', () => {
  it('fires at exactly 100 rows', () => {
    const at99 = detectNewUnlocks(state({ transactionCount: 99 }), new Set());
    expect(at99).not.toContain('100_transactions');

    const at100 = detectNewUnlocks(state({ transactionCount: 100 }), new Set());
    expect(at100).toContain('100_transactions');

    const at101 = detectNewUnlocks(state({ transactionCount: 101 }), new Set());
    expect(at101).toContain('100_transactions');
  });
});

describe('detectNewUnlocks · tenure', () => {
  it('fires one_year_in only when oldest tx is >= 1 year old', () => {
    const now = new Date('2026-05-17T00:00:00Z');
    const elevenMonths = new Date('2025-06-30T00:00:00Z');
    const oneYearAndOneDay = new Date('2025-05-16T00:00:00Z');

    expect(
      detectNewUnlocks(state({ now, oldestTransactionDate: elevenMonths }), new Set()),
    ).not.toContain('one_year_in');

    expect(
      detectNewUnlocks(state({ now, oldestTransactionDate: oneYearAndOneDay }), new Set()),
    ).toContain('one_year_in');
  });

  it('fires five_years_in only when oldest tx is >= 5 years old', () => {
    const now = new Date('2026-05-17T00:00:00Z');
    const fourYears = new Date('2022-05-17T00:00:00Z');
    const sixYears = new Date('2020-05-17T00:00:00Z');

    expect(
      detectNewUnlocks(state({ now, oldestTransactionDate: fourYears }), new Set()),
    ).not.toContain('five_years_in');

    expect(
      detectNewUnlocks(state({ now, oldestTransactionDate: sixYears }), new Set()),
    ).toContain('five_years_in');
  });
});

describe('detectNewUnlocks · dividends and import', () => {
  it('first_import fires when accountCount >= 1', () => {
    expect(detectNewUnlocks(state({ accountCount: 0 }), new Set())).not.toContain('first_import');
    expect(detectNewUnlocks(state({ accountCount: 1 }), new Set())).toContain('first_import');
  });

  it('first_dividend fires on the first dividend tx', () => {
    expect(detectNewUnlocks(state({ dividendCount: 0 }), new Set())).not.toContain('first_dividend');
    expect(detectNewUnlocks(state({ dividendCount: 1 }), new Set())).toContain('first_dividend');
  });

  it('100_in_dividends and 1k_in_dividends gate on the cumulative total', () => {
    const fifty = detectNewUnlocks(state({ dividendCount: 5, dividendTotal: 50 }), new Set());
    expect(fifty).not.toContain('100_in_dividends');
    expect(fifty).not.toContain('1k_in_dividends');

    const hundred = detectNewUnlocks(state({ dividendCount: 5, dividendTotal: 100 }), new Set());
    expect(hundred).toContain('100_in_dividends');
    expect(hundred).not.toContain('1k_in_dividends');

    const thousand = detectNewUnlocks(state({ dividendCount: 5, dividendTotal: 1_000 }), new Set());
    expect(thousand).toContain('100_in_dividends');
    expect(thousand).toContain('1k_in_dividends');
  });
});
