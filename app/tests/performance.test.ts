import { describe, expect, it } from 'vitest';
import { annualizeTwr, flowsFromTransactions, twr, xirr } from '../src/lib/performance';

describe('xirr', () => {
  it('returns ~10% for a single 10% gain over one year', () => {
    const rate = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ]);
    expect(rate).toBeCloseTo(0.1, 3);
  });

  it('returns ~0% for a flat investment', () => {
    const rate = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1000 },
    ]);
    expect(rate).toBeCloseTo(0, 3);
  });

  it('handles irregular cash flows', () => {
    // -$1000 invested, +$200 dividend after 6 months, +$900 final value after 1 year
    const rate = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2024-07-01'), amount: 200 },
      { date: new Date('2025-01-01'), amount: 900 },
    ]);
    expect(rate).toBeCloseTo(0.105, 1);
  });

  it('returns NaN when there is no positive flow', () => {
    const rate = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: -500 },
    ]);
    expect(rate).toBeNaN();
  });

  it('returns NaN for empty / single-flow input', () => {
    expect(xirr([])).toBeNaN();
    expect(xirr([{ date: new Date(), amount: 100 }])).toBeNaN();
  });

  it('handles negative annualized return (loss)', () => {
    const rate = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 900 },
    ]);
    expect(rate).toBeCloseTo(-0.1, 2);
  });
});

describe('twr', () => {
  it('compounds two flat sub-periods correctly', () => {
    // No external flows, value goes 100 → 110 → 121.  That's 10% × 10% = 21%.
    const r = twr([
      { date: new Date('2024-01-01'), value: 100 },
      { date: new Date('2024-06-30'), value: 110 },
      { date: new Date('2024-12-31'), value: 121 },
    ]);
    expect(r).toBeCloseTo(0.21, 4);
  });

  it('removes the effect of a mid-period contribution', () => {
    // Start at 100. By June 30, market grew 10% to 110. Then we DEPOSIT 100 → 210.
    // By year end, grew another 10% to 231.
    // TWR should be 10% × 10% = 21%, NOT 131%.
    const r = twr(
      [
        { date: new Date('2024-01-01'), value: 100 },
        { date: new Date('2024-06-30'), value: 210 }, // 110 market + 100 deposit
        { date: new Date('2024-12-31'), value: 231 },
      ],
      [{ date: new Date('2024-06-30'), amount: -100 }], // deposit (money OUT of our pocket)
    );
    expect(r).toBeCloseTo(0.21, 4);
  });

  it('returns NaN for a single point', () => {
    expect(twr([{ date: new Date(), value: 100 }])).toBeNaN();
  });

  it('annualizeTwr converts cumulative to per-year', () => {
    // 21% over 2 years annualizes to ~10%
    const ann = annualizeTwr(0.21, 730);
    expect(ann).toBeCloseTo(0.1, 2);
  });

  it('annualizeTwr leaves <1mo periods unchanged', () => {
    expect(annualizeTwr(0.02, 10)).toBe(0.02);
  });
});

describe('flowsFromTransactions', () => {
  it('drops dividends + reinvests (internal flows)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'buy', quantity: 10, price: 100, fees: 0, amount: -1000 },
      { date: new Date('2024-06-01'), action: 'dividend', quantity: 0, price: 0, fees: 0, amount: 20 },
      {
        date: new Date('2024-06-15'),
        action: 'div_reinvest',
        quantity: 0.2,
        price: 100,
        fees: 0,
        amount: -20,
      },
      { date: new Date('2024-12-01'), action: 'sell', quantity: 5, price: 120, fees: 0, amount: 600 },
    ]);
    expect(flows).toHaveLength(2); // buy + sell only
    expect(flows[0].amount).toBe(-1000);
    expect(flows[1].amount).toBe(600);
  });

  it('derives amount from qty × price when amount column is null/0', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'buy', quantity: 10, price: 100, fees: 5, amount: 0 },
    ]);
    expect(flows[0].amount).toBe(-(1000 + 5));
  });

  // ─── Bug A regression suite ───────────────────────────────────────────
  // Five canonical scenarios from the spec. The historical bug emitted both
  // the cash_in AND the buy that consumed it as separate flows, so $1,000
  // of real deposit became -$2,000 of "money in" to XIRR. The fix pairs
  // boundary deposits with same-day-ish trades (+/- 3 days) so a single
  // deposit-then-buy pattern produces ONE external flow.

  it('scenario A: cash_in + same-day buy → one flow (the deposit)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'cash_in', quantity: 0, price: 0, fees: 0, amount: 1000 },
      {
        date: new Date('2024-01-01'),
        action: 'buy',
        symbol: 'VGT',
        quantity: 2,
        price: 500,
        fees: 0,
        amount: -1000,
      } as Parameters<typeof flowsFromTransactions>[0][number],
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1000);
  });

  it('scenario B: standalone buy (no cash_in) → one flow (the buy itself)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'buy', quantity: 2, price: 500, fees: 0, amount: -1000 },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1000);
  });

  it('scenario C: cash_in alone (no buy) → one flow (the deposit)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'cash_in', quantity: 0, price: 0, fees: 0, amount: 1000 },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1000);
  });

  it('scenario D: standalone dividend → zero external flows', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'dividend', quantity: 0, price: 0, fees: 0, amount: 50 },
    ]);
    expect(flows).toHaveLength(0);
  });

  it('scenario E: dividend + same-day div_reinvest → zero external flows', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'dividend', quantity: 0, price: 0, fees: 0, amount: 50 },
      {
        date: new Date('2024-01-01'),
        action: 'div_reinvest',
        quantity: 0.5,
        price: 100,
        fees: 0,
        amount: -50,
      },
    ]);
    expect(flows).toHaveLength(0);
  });

  // ─── Pairing edge cases ──────────────────────────────────────────────

  it('pairs a single deposit against multiple sibling buys on the same day', () => {
    // The Fidelity sample's actual shape: one $300 cash_in funds three buys
    // ($113.89 + $36.10 + $150 = ~$300) on the same day. Should emit ONE
    // flow of -$300, not four flows totaling -$600.
    const flows = flowsFromTransactions([
      { date: new Date('2026-05-11'), action: 'cash_in', quantity: 0, price: 0, fees: 0, amount: 300 },
      {
        date: new Date('2026-05-11'),
        action: 'buy',
        quantity: 1,
        price: 113.89,
        fees: 0,
        amount: -113.89,
      },
      {
        date: new Date('2026-05-11'),
        action: 'buy',
        quantity: 0.317,
        price: 113.88,
        fees: 0,
        amount: -36.1,
      },
      {
        date: new Date('2026-05-11'),
        action: 'buy',
        quantity: 0.582,
        price: 257.73,
        fees: 0,
        amount: -150,
      },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-300);
  });

  it('pairs a deposit with a buy 2 days later (within +/- 3 day window)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'cash_in', quantity: 0, price: 0, fees: 0, amount: 1000 },
      { date: new Date('2024-01-03'), action: 'buy', quantity: 2, price: 500, fees: 0, amount: -1000 },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1000);
  });

  it('does NOT pair when the buy is outside the +/- 3 day window', () => {
    // Deposit on Jan 1, buy on Jan 10 → too far apart to be funded by the
    // same boundary event. Emit both as separate flows.
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'cash_in', quantity: 0, price: 0, fees: 0, amount: 1000 },
      { date: new Date('2024-01-10'), action: 'buy', quantity: 2, price: 500, fees: 0, amount: -1000 },
    ]);
    expect(flows).toHaveLength(2);
    expect(flows[0].amount).toBe(-1000);
    expect(flows[1].amount).toBe(-1000);
  });

  it('pairs a sell with a same-day cash_out (one flow, the withdrawal)', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-06-01'), action: 'sell', quantity: 5, price: 200, fees: 0, amount: 1000 },
      { date: new Date('2024-06-01'), action: 'cash_out', quantity: 0, price: 0, fees: 0, amount: 1000 },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(1000);
  });

  it('multi-account: a deposit in account A does not cover a buy in account B', () => {
    // Same-day deposit and buy but different accounts: they must NOT pair.
    const flows = flowsFromTransactions([
      {
        date: new Date('2024-01-01'),
        action: 'cash_in',
        quantity: 0,
        price: 0,
        fees: 0,
        amount: 1000,
        account_id: 'acct-A',
      },
      {
        date: new Date('2024-01-01'),
        action: 'buy',
        quantity: 2,
        price: 500,
        fees: 0,
        amount: -1000,
        account_id: 'acct-B',
      },
    ]);
    expect(flows).toHaveLength(2);
    expect(flows.every(f => f.amount === -1000)).toBe(true);
  });

  it('multi-account: same-account deposit + buy still pair correctly', () => {
    const flows = flowsFromTransactions([
      {
        date: new Date('2024-01-01'),
        action: 'cash_in',
        quantity: 0,
        price: 0,
        fees: 0,
        amount: 1000,
        account_id: 'acct-A',
      },
      {
        date: new Date('2024-01-01'),
        action: 'buy',
        quantity: 2,
        price: 500,
        fees: 0,
        amount: -1000,
        account_id: 'acct-A',
      },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1000);
  });
});
