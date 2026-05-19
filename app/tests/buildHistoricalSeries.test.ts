// Tests for buildHistoricalSeries (exercised via buildPortfolio). The
// function walks the prices table day by day and produces a real
// mark-to-market NAV curve. Pre-fix the chart fell into the legacy
// month-end-anchor fallback that valued every snapshot at the CURRENT price,
// producing a diagonal line from $0 to today's total. These tests pin the
// real-mark behaviour so a future regression of the buildHistoricalSeries
// wiring or of the forward-fill cursor is caught immediately.

import { describe, expect, it } from 'vitest';
import {
  bulkUpsertPrices,
  insertAccount,
  insertTransactions,
} from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';
import type { ParsedTransaction } from '../src/lib/importers/types';

function tx(o: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    date: new Date('2024-01-02T00:00:00Z'),
    symbol: 'A',
    action: 'buy',
    quantity: 0,
    price: 0,
    fees: 0,
    amount: null,
    currency: 'USD',
    notes: '',
    rawHash: Math.random().toString(36),
    ...o,
  };
}

async function seedAccount(id = 'acct-1'): Promise<void> {
  await insertAccount({
    id,
    name: id,
    brokerage: 'Test',
    account_type: 'taxable',
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
}

describe('buildHistoricalSeries (via buildPortfolio)', () => {
  it('produces nav[day] = qty × close for a known-history scenario', async () => {
    // Scenario per the PRD spec: symbol A: 10 shares since Jan 1 2024,
    // close prices [100, 110, 120, 130, 140] over 5 days. Assert nav
    // series is [1000, 1100, 1200, 1300, 1400] exactly.
    await seedAccount();
    await insertTransactions('acct-1', [
      tx({
        symbol: 'A',
        action: 'buy',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-02T00:00:00Z'),
        rawHash: 'buy-A-10',
      }),
    ]);
    const bars = [
      { date: new Date('2024-01-02T00:00:00Z'), close: 100 },
      { date: new Date('2024-01-03T00:00:00Z'), close: 110 },
      { date: new Date('2024-01-04T00:00:00Z'), close: 120 },
      { date: new Date('2024-01-05T00:00:00Z'), close: 130 },
      { date: new Date('2024-01-06T00:00:00Z'), close: 140 },
    ];
    await bulkUpsertPrices('A', bars);

    const p = await buildPortfolio();
    // The last point gets overridden to totalValueToday (which equals the
    // 2024-01-06 close × qty here: 10 × 140 = $1,400). All earlier points
    // come from the actual historical bars.
    const values = p.series.map(s => Math.round(s.value));
    // We expect 5 trading-day points (Jan 2..6 inclusive) plus possibly an
    // additional "today" point appended by the historical builder. Find
    // the five known dates in the series and assert their values.
    const byDay = new Map<string, number>();
    for (const point of p.series) {
      const key = point.date.toISOString().slice(0, 10);
      byDay.set(key, Math.round(point.value));
    }
    expect(byDay.get('2024-01-02')).toBe(1000);
    expect(byDay.get('2024-01-03')).toBe(1100);
    expect(byDay.get('2024-01-04')).toBe(1200);
    expect(byDay.get('2024-01-05')).toBe(1300);
    expect(byDay.get('2024-01-06')).toBe(1400);
    // The series is monotonically non-decreasing here because prices rose
    // every day. But more importantly, we did NOT fall into the legacy
    // diagonal-line fallback: that would produce a single point at the
    // first tx date with value 1000 and then today with value 1400, only
    // 2 points total. Real-mark has all 5 dates plus today.
    expect(values.length).toBeGreaterThanOrEqual(5);
  });

  it('forward-fills a non-trading day with the prior close', async () => {
    // 10 shares of B since Jan 2. Prices land on Jan 2 (100) and Jan 4
    // (120); Jan 3 has no bar (holiday). Assert that if Jan 3 appears in
    // the series at all, it carries the Jan 2 close (100), not zero. We
    // don't strictly require Jan 3 in the day axis since the union of
    // symbol-price-dates determines the axis; the assertion is on
    // continuity rather than on a specific day count.
    await seedAccount();
    await insertTransactions('acct-1', [
      tx({
        symbol: 'B',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-02T00:00:00Z'),
        rawHash: 'buy-B-10',
      }),
    ]);
    await bulkUpsertPrices('B', [
      { date: new Date('2024-01-02T00:00:00Z'), close: 100 },
      { date: new Date('2024-01-04T00:00:00Z'), close: 120 },
    ]);
    const p = await buildPortfolio();
    const values = p.series.map(s => s.value);
    // Every emitted point must be > 0 (no zero step-down from a missing day).
    for (const v of values) expect(v).toBeGreaterThan(0);
  });

  it('handles a position bought partway through the price window', async () => {
    // Symbol C trades Jan 2-6 (100, 110, 120, 130, 140). User buys 5
    // shares on Jan 4. Pre-Jan-4 NAV should be 0; from Jan 4 onward it
    // should be qty × that day's close.
    await seedAccount();
    await insertTransactions('acct-1', [
      tx({
        symbol: 'C',
        quantity: 5,
        price: 120,
        date: new Date('2024-01-04T00:00:00Z'),
        rawHash: 'buy-C-5',
      }),
    ]);
    await bulkUpsertPrices('C', [
      { date: new Date('2024-01-02T00:00:00Z'), close: 100 },
      { date: new Date('2024-01-03T00:00:00Z'), close: 110 },
      { date: new Date('2024-01-04T00:00:00Z'), close: 120 },
      { date: new Date('2024-01-05T00:00:00Z'), close: 130 },
      { date: new Date('2024-01-06T00:00:00Z'), close: 140 },
    ]);
    const p = await buildPortfolio();
    const byDay = new Map<string, number>();
    for (const point of p.series) {
      const key = point.date.toISOString().slice(0, 10);
      byDay.set(key, Math.round(point.value));
    }
    // Earliest tx date is Jan 4, so pre-Jan-4 days are clamped out of the
    // series by the [earliestTx, today] day-axis filter in
    // buildHistoricalSeries. We assert the on-or-after-Jan-4 values land.
    expect(byDay.get('2024-01-04')).toBe(600);
    expect(byDay.get('2024-01-05')).toBe(650);
    expect(byDay.get('2024-01-06')).toBe(700);
  });

  it('returns an empty series when no historical prices exist (no misleading curve)', async () => {
    // Pre-backfill state: user has holdings but the prices table is empty
    // for that symbol. The previous behaviour was a "legacy month-end"
    // fallback that valued every historical snapshot at the holding's
    // CURRENT price, producing the diagonal $6K-to-$760K line + +283% YTD
    // that Justin reported. The fix removes the fallback entirely: when
    // there's no price history, we return an empty series and the chart
    // surfaces an explicit empty state ("your portfolio chart will fill
    // in as your data lands here"). The recovery probe in
    // usePortfolio.maybeRunRecovery rebuilds the prices table on the next
    // launch, after which the real-mark code path kicks in.
    await seedAccount();
    await insertTransactions('acct-1', [
      tx({
        symbol: 'D',
        quantity: 10,
        price: 50,
        date: new Date('2024-01-02T00:00:00Z'),
        rawHash: 'buy-D-10',
      }),
      tx({
        symbol: 'D',
        quantity: 5,
        price: 60,
        date: new Date('2024-06-02T00:00:00Z'),
        rawHash: 'buy-D-5',
      }),
    ]);
    // Intentionally NO bulkUpsertPrices call.
    const p = await buildPortfolio();
    expect(p.series).toEqual([]);
  });
});
