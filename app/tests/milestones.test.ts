import { describe, expect, it } from 'vitest';
import {
  MILESTONE_DEFS,
  detectNewUnlocks,
  tallyDividends,
  unlockNew,
  type PortfolioState,
} from '../src/lib/milestones';
import { listAchievements, unlockAchievement } from '../src/lib/db/repos';
import { joinCatalogWithUnlocks, pickUpcoming } from '../src/views/AchievementsView';
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
    dayChange: null,
    dayChangePct: null,
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
    expect(detectNewUnlocks(state({ holdings: tooFewSectors }), new Set())).not.toContain('diversified');

    // 9 holdings, 3 sectors: should NOT fire.
    const tooFewHoldings = Array.from({ length: 9 }).map((_, i) =>
      holding({ sym: `S${i}`, sector: ['Tech', 'Bonds', 'Health'][i % 3] }),
    );
    expect(detectNewUnlocks(state({ holdings: tooFewHoldings }), new Set())).not.toContain('diversified');

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

    expect(detectNewUnlocks(state({ now, oldestTransactionDate: elevenMonths }), new Set())).not.toContain(
      'one_year_in',
    );

    expect(detectNewUnlocks(state({ now, oldestTransactionDate: oneYearAndOneDay }), new Set())).toContain(
      'one_year_in',
    );
  });

  it('fires five_years_in only when oldest tx is >= 5 years old', () => {
    const now = new Date('2026-05-17T00:00:00Z');
    const fourYears = new Date('2022-05-17T00:00:00Z');
    const sixYears = new Date('2020-05-17T00:00:00Z');

    expect(detectNewUnlocks(state({ now, oldestTransactionDate: fourYears }), new Set())).not.toContain(
      'five_years_in',
    );

    expect(detectNewUnlocks(state({ now, oldestTransactionDate: sixYears }), new Set())).toContain(
      'five_years_in',
    );
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

// Regression: when a real user imports a CSV that puts them above several value
// thresholds at once (the common case for anyone who has been investing for a
// while), the watcher must fire every milestone whose threshold has been crossed,
// not just the topmost one. We exercise the full DB-backed `unlockNew` path so
// the test catches regressions in the persist + dedupe layer too, not just the
// pure `detectNewUnlocks` function.
describe('unlockNew · backfill against an empty achievements table', () => {
  it('fires every value milestone <= totalValue on the first run (no priors)', async () => {
    // Sanity: starting state has nothing unlocked.
    expect(await listAchievements()).toEqual([]);

    const fired = await unlockNew([], 500_000, new Date('2026-05-17T00:00:00Z'));

    // Every value milestone with thresholdValue <= 500_000 should have fired.
    expect(fired).toEqual(expect.arrayContaining(['first_1k', 'first_10k', 'first_100k', 'first_500k']));
    // And nothing above 500k should have fired.
    expect(fired).not.toContain('first_million');
    expect(fired).not.toContain('two_million');

    // The DB should now reflect the same set.
    const persisted = (await listAchievements()).map(r => r.milestone_key);
    expect(persisted).toEqual(expect.arrayContaining(['first_1k', 'first_10k', 'first_100k', 'first_500k']));
  });

  it('is idempotent: re-running with the same state fires nothing new', async () => {
    const now = new Date('2026-05-17T00:00:00Z');
    const first = await unlockNew([], 500_000, now);
    expect(first.length).toBeGreaterThan(0);

    const second = await unlockNew([], 500_000, now);
    expect(second).toEqual([]);
  });

  it('only fires the still-missing milestones when some are already unlocked', async () => {
    // Pre-seed `first_1k` and `first_10k` as if a prior session already saw them.
    await unlockAchievement('first_1k');
    await unlockAchievement('first_10k');

    const fired = await unlockNew([], 200_000, new Date('2026-05-17T00:00:00Z'));

    // The two we pre-seeded should NOT re-fire (avoids spurious toast spam).
    expect(fired).not.toContain('first_1k');
    expect(fired).not.toContain('first_10k');
    // The newly-crossed ones should fire.
    expect(fired).toEqual(expect.arrayContaining(['first_100k']));
    // And anything above 200k should still be locked.
    expect(fired).not.toContain('first_500k');
  });
});

// "Coming up next" is the section that surfaces what the user is closest to
// hitting. It must rank by actual portfolio value, not by catalog order.
describe("pickUpcoming · ranks by the user's real totalValue", () => {
  it('at $500k, the next value milestone shown is first_million', () => {
    const joined = joinCatalogWithUnlocks(
      // Pretend the four lower value milestones have already been unlocked, since
      // that's the realistic post-backfill state for a $500k user.
      [
        { key: 'first_1k', date: new Date('2025-01-01') },
        { key: 'first_10k', date: new Date('2025-02-01') },
        { key: 'first_100k', date: new Date('2025-03-01') },
        { key: 'first_500k', date: new Date('2025-04-01') },
      ],
      new Date('2026-05-17T00:00:00Z'),
    );

    const upcoming = pickUpcoming(joined, 500_000);
    // The very first card MUST be first_million. That's the next value rung.
    expect(upcoming[0]?.key).toBe('first_million');
    // The list is capped at 3.
    expect(upcoming.length).toBeLessThanOrEqual(3);
    // It should NOT include anything the user has already unlocked.
    expect(upcoming.map(m => m.key)).not.toContain('first_500k');
    // And it should never include secrets.
    expect(upcoming.every(m => m.category !== 'secret')).toBe(true);
  });

  it('at $0 with nothing unlocked, the first card is first_1k (the nearest rung)', () => {
    const joined = joinCatalogWithUnlocks([], new Date('2026-05-17T00:00:00Z'));
    const upcoming = pickUpcoming(joined, 0);
    expect(upcoming[0]?.key).toBe('first_1k');
  });
});

// Bug B regression suite. Before the fix, a Fidelity-style paired
// (Cash Dividend, Reinvestment) export double-counted: $50 of real income
// became $100 of dividendTotal. The fix in tallyDividends() pairs the two
// rows by symbol + date + magnitude and counts the income only once. A
// solo div_reinvest (no paired dividend row) still counts because the
// reinvestment IS the only income signal.
describe('tallyDividends · pair (cash dividend, reinvestment) into one income event', () => {
  it('counts a same-day cash dividend + reinvest pair ONCE', () => {
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 50,
      },
      {
        date: '2026-01-15',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.5,
        price: 100,
        amount: -50,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(50);
    expect(dividendCount).toBe(1);
  });

  it('counts a solo div_reinvest (no paired dividend row) ONCE', () => {
    // Some brokerages collapse the paired (cash, shares) rows into a single
    // reinvestment line. The reinvestment IS the only income signal, so it
    // must still contribute to the lifetime dividend total.
    const txs = [
      {
        date: '2026-01-15',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.5,
        price: 100,
        amount: -50,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(50);
    expect(dividendCount).toBe(1);
  });

  it('counts a solo cash dividend (no reinvest) ONCE', () => {
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 50,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(50);
    expect(dividendCount).toBe(1);
  });

  it('pairs within +/- 3 days (settlement timing)', () => {
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 50,
      },
      {
        date: '2026-01-17',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.5,
        price: 100,
        amount: -50,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(50);
    expect(dividendCount).toBe(1);
  });

  it('does NOT pair across symbols (different securities = separate income)', () => {
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 50,
      },
      {
        date: '2026-01-15',
        action: 'div_reinvest',
        symbol: 'FXAIX',
        quantity: 0.5,
        price: 100,
        amount: -50,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(100);
    expect(dividendCount).toBe(2);
  });

  it('does NOT pair when magnitudes differ materially', () => {
    // A reinvestment of $40 against a dividend of $50 is NOT the same event
    // (maybe a portion went to cash). Treat as two separate income signals.
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 50,
      },
      {
        date: '2026-01-15',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.4,
        price: 100,
        amount: -40,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(90);
    expect(dividendCount).toBe(2);
  });

  it('handles multiple paired events without cross-contamination', () => {
    // Two separate months of dividends, each emitted as a (cash, reinvest)
    // pair. Total should be $30, count 2, not $60 / 4.
    const txs = [
      {
        date: '2026-01-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 15,
      },
      {
        date: '2026-01-15',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.15,
        price: 100,
        amount: -15,
      },
      {
        date: '2026-02-15',
        action: 'dividend',
        symbol: 'VGT',
        quantity: 0,
        price: 0,
        amount: 15,
      },
      {
        date: '2026-02-15',
        action: 'div_reinvest',
        symbol: 'VGT',
        quantity: 0.15,
        price: 100,
        amount: -15,
      },
    ];
    const { dividendCount, dividendTotal } = tallyDividends(txs);
    expect(dividendTotal).toBe(30);
    expect(dividendCount).toBe(2);
  });
});
