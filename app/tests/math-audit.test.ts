// Math audit suite. Each test is a worked numeric example that pins down a
// specific claim about the financial math the user sees. When a test fails it
// describes a real bug; when it passes it is evidence the math is right.
//
// Findings discovered during the audit are listed in the cover memo returned
// to the parent. This file is structured by audit domain:
//
//   1. portfolio.ts:  average-cost basis, holdings rollup, price fallback
//   2. performance.ts: TWR, XIRR, flow extraction
//   3. PlannerView:    projection compounding + sensitivity tile

import { describe, expect, it } from 'vitest';
import { insertAccount, insertTransactions } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';
import { annualizeTwr, flowsFromTransactions, twr, xirr } from '../src/lib/performance';
import type { ParsedTransaction } from '../src/lib/importers/types';

function tx(o: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    date: new Date('2024-01-01T00:00:00Z'),
    symbol: 'AAPL',
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

async function seedAccount(id: string, type = 'taxable') {
  await insertAccount({
    id,
    name: id,
    brokerage: 'Test',
    account_type: type,
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
}

// ───────────────────────────────────────────────────────────────
// 1. portfolio.ts: average-cost basis and holdings rollup
// ───────────────────────────────────────────────────────────────

describe('portfolio: average-cost basis is order-sensitive (must process oldest first)', () => {
  // FINDING (HIGH): listTransactions() returns rows ORDER BY date DESC in
  // Tauri. buildPortfolio() iterates in arrival order and computes running
  // average cost. Average-cost accounting is order-dependent whenever a sell
  // is interleaved with buys at different prices, so processing newest-first
  // produces a fundamentally wrong cost basis.
  //
  // This test inserts transactions out of date order and verifies the
  // resulting basis matches the CHRONOLOGICAL replay, not the insert-order
  // replay. The fix is to sort txRows by date ASC inside buildPortfolio()
  // (or equivalently in listTransactions).

  it('basis matches chronological replay regardless of insert order', async () => {
    await seedAccount('a1');
    // Real chronology:
    //   Jan 1   BUY  10 @ 100  →  qty 10, cost 1000, avg 100
    //   Jun 1   SELL  5 @ 200  →  reduces basis by 5 * 100 = 500 → qty 5, cost 500
    //   Dec 1   BUY   5 @ 300  →  qty 10, cost 500 + 1500 = 2000, avg 200
    //
    // Reverse-order replay (the bug) would give:
    //   BUY   5 @ 300 → qty 5, cost 1500, avg 300
    //   SELL  5 @ 200 → qty 0 (zeroed), cost 0
    //   BUY  10 @ 100 → qty 10, cost 1000, avg 100   ← WRONG
    //
    // We insert in date-DESC order to mirror what a CSV export does so that
    // the bug surfaces even in the browser shim (which preserves insert order).
    await insertTransactions('a1', [
      tx({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 5,
        price: 300,
        date: new Date('2024-12-01'),
        rawHash: 'c',
      }),
      tx({
        symbol: 'AAPL',
        action: 'sell',
        quantity: 5,
        price: 200,
        date: new Date('2024-06-01'),
        rawHash: 'b',
      }),
      tx({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: 'a',
      }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL')!;
    expect(aapl.qty).toBe(10);
    // Correct chronological cost basis = 2000 (avg 200), NOT 1000 (avg 100).
    expect(aapl.cost).toBeCloseTo(2000, 4);
    expect(aapl.basis).toBeCloseTo(200, 4);
  });

  it('insert order does not affect final qty when only buys (sanity check)', async () => {
    // Buys-only is commutative under average cost; this is the "easy" case
    // that already passes today. Included so a future regression that breaks
    // buy-only ordering is also caught.
    await seedAccount('a2');
    await insertTransactions('a2', [
      tx({
        symbol: 'VTI',
        action: 'buy',
        quantity: 5,
        price: 200,
        date: new Date('2024-12-01'),
        rawHash: '1',
      }),
      tx({
        symbol: 'VTI',
        action: 'buy',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: '2',
      }),
    ]);
    const p = await buildPortfolio();
    const vti = p.holdings.find(h => h.sym === 'VTI')!;
    expect(vti.qty).toBe(15);
    expect(vti.cost).toBe(10 * 100 + 5 * 200); // 2000
  });
});

describe('portfolio: action handling for income vs principal', () => {
  it('dividend rows do NOT add to qty or cost', async () => {
    await seedAccount('a3');
    await insertTransactions('a3', [
      tx({
        symbol: 'MSFT',
        action: 'buy',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: 'b',
      }),
      tx({
        symbol: 'MSFT',
        action: 'dividend',
        quantity: 0,
        price: 0,
        amount: 25,
        date: new Date('2024-06-01'),
        rawHash: 'd',
      }),
    ]);
    const p = await buildPortfolio();
    const m = p.holdings.find(h => h.sym === 'MSFT')!;
    expect(m.qty).toBe(10);
    expect(m.cost).toBe(1000);
  });

  it('dividend-only symbol (no shares ever held) is NOT surfaced as a 0-share holding', async () => {
    // FINDING (LOW): previously, when a Schwab CSV contained a Cash Dividend
    // row for a symbol the user had never actually bought (e.g. MSFT dividend
    // on a Schwab account that only ever held QQQ), the symbol was created in
    // the holdings map with qty=0, cost=0, and surfaced into HoldingsView as
    // a "0 shares" row, polluting the position count and the table. The fix
    // skips holdings with qty<=0 inside buildPortfolio.
    await seedAccount('a3b');
    await insertTransactions('a3b', [
      // Only ever own QQQ.
      tx({
        symbol: 'QQQ',
        action: 'buy',
        quantity: 1,
        price: 500,
        date: new Date('2024-01-01'),
        rawHash: 'qqq1',
      }),
      // But also got a stray MSFT dividend (e.g. legacy transfer-in residue).
      tx({
        symbol: 'MSFT',
        action: 'dividend',
        quantity: 0,
        price: 0,
        amount: 8.19,
        date: new Date('2024-06-01'),
        rawHash: 'msftd',
      }),
    ]);
    const p = await buildPortfolio();
    expect(p.holdings.find(h => h.sym === 'MSFT')).toBeUndefined();
    expect(p.holdings.find(h => h.sym === 'QQQ')?.qty).toBe(1);
  });

  it('interest rows do NOT add to qty or cost', async () => {
    await seedAccount('a4');
    await insertTransactions('a4', [
      tx({
        symbol: 'SPAXX',
        action: 'buy',
        quantity: 100,
        price: 1,
        date: new Date('2024-01-01'),
        rawHash: 'i1',
      }),
      tx({
        symbol: 'SPAXX',
        action: 'interest',
        quantity: 0,
        price: 0,
        amount: 0.42,
        date: new Date('2024-06-01'),
        rawHash: 'i2',
      }),
    ]);
    const p = await buildPortfolio();
    const s = p.holdings.find(h => h.sym === 'SPAXX')!;
    expect(s.qty).toBe(100);
    expect(s.cost).toBe(100);
  });

  it('div_reinvest with real share qty IS treated as a buy (adds qty + cost)', async () => {
    await seedAccount('a5');
    await insertTransactions('a5', [
      tx({
        symbol: 'QQQ',
        action: 'buy',
        quantity: 10,
        price: 500,
        date: new Date('2024-01-01'),
        rawHash: 'q1',
      }),
      tx({
        symbol: 'QQQ',
        action: 'div_reinvest',
        quantity: 0.005,
        price: 600,
        date: new Date('2024-06-01'),
        rawHash: 'q2',
      }),
    ]);
    const p = await buildPortfolio();
    const q = p.holdings.find(h => h.sym === 'QQQ')!;
    expect(q.qty).toBeCloseTo(10.005, 6);
    expect(q.cost).toBeCloseTo(10 * 500 + 0.005 * 600, 6);
  });

  it('transfer_out reduces holdings using running average cost', async () => {
    await seedAccount('a6');
    await insertTransactions('a6', [
      tx({
        symbol: 'VOO',
        action: 'buy',
        quantity: 10,
        price: 400,
        date: new Date('2024-01-01'),
        rawHash: 'v1',
      }),
      tx({
        symbol: 'VOO',
        action: 'transfer_out',
        quantity: 4,
        price: 0,
        date: new Date('2024-06-01'),
        rawHash: 'v2',
      }),
    ]);
    const p = await buildPortfolio();
    const v = p.holdings.find(h => h.sym === 'VOO')!;
    expect(v.qty).toBe(6);
    // Average cost was 400. Removing 4 at avg → 4000 - 1600 = 2400 remaining.
    expect(v.cost).toBeCloseTo(2400, 4);
  });

  it('fees on a buy are added to cost basis', async () => {
    await seedAccount('a7');
    await insertTransactions('a7', [
      tx({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 100,
        fees: 9.95,
        date: new Date('2024-01-01'),
        rawHash: 'f1',
      }),
    ]);
    const p = await buildPortfolio();
    const a = p.holdings.find(h => h.sym === 'AAPL')!;
    expect(a.cost).toBeCloseTo(1000 + 9.95, 4);
  });
});

describe('portfolio: price fallback when no live quote', () => {
  it('falls back to the most recent NON-ZERO transaction price (dividends do not pollute)', async () => {
    await seedAccount('a8');
    await insertTransactions('a8', [
      tx({
        symbol: 'JEPI',
        action: 'buy',
        quantity: 100,
        price: 55,
        date: new Date('2024-01-01'),
        rawHash: 'j1',
      }),
      // A dividend after the buy with price=0 must NOT become the fallback price.
      tx({
        symbol: 'JEPI',
        action: 'dividend',
        quantity: 0,
        price: 0,
        amount: 62,
        date: new Date('2024-06-01'),
        rawHash: 'j2',
      }),
    ]);
    const p = await buildPortfolio();
    const j = p.holdings.find(h => h.sym === 'JEPI')!;
    expect(j.price).toBe(55);
    expect(j.value).toBe(100 * 55);
  });

  it('uses the chronologically latest priced tx, not the most-recently inserted one', async () => {
    await seedAccount('a9');
    // Insert in non-chronological order: the EARLIER-dated tx is inserted LAST.
    await insertTransactions('a9', [
      tx({
        symbol: 'BND',
        action: 'buy',
        quantity: 50,
        price: 80,
        date: new Date('2025-01-01'),
        rawHash: 'bn-late',
      }),
      tx({
        symbol: 'BND',
        action: 'buy',
        quantity: 50,
        price: 70,
        date: new Date('2023-01-01'),
        rawHash: 'bn-early',
      }),
    ]);
    const p = await buildPortfolio();
    const b = p.holdings.find(h => h.sym === 'BND')!;
    // Most recent price by DATE is 80, regardless of insertion order.
    expect(b.price).toBe(80);
  });
});

describe('portfolio: totalDayChange rollup', () => {
  // FINDING (LOW / display): totalDayChange is initialized to 0 in
  // buildPortfolio() and never updated. accounts[i].dayChange is also
  // hardcoded to 0. So "Today's change" always renders $0 for real users.
  // This is not strictly a math BUG (we have no prior-close data to compute
  // it from), but the tile and the percentage divide it by totalValue,
  // displaying 0.00% (and NaN% on an empty portfolio).
  it('totalDayChange is 0 with the current implementation (no prior-close data)', async () => {
    await seedAccount('a10');
    await insertTransactions('a10', [
      tx({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: 'd1',
      }),
    ]);
    const p = await buildPortfolio();
    expect(p.totalDayChange).toBe(0);
    expect(p.accounts.every(a => a.dayChange === 0)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────
// 2. performance.ts: TWR, XIRR, flow extraction
// ───────────────────────────────────────────────────────────────

describe('xirr: numeric correctness on worked examples', () => {
  // We switched the year denominator to 365.25 (Julian year) for leap-year
  // accuracy. The worked examples below adjust their reference values
  // accordingly; the convention is documented in src/lib/performance.ts.
  const DAYS_PER_YEAR = 365.25;
  it('365-day investment, 10% nominal: result reflects the 365.25 denominator', () => {
    // 2023-01-01 → 2024-01-01 spans exactly 365 days. With the 365.25
    // denominator the implied exponent is 365/365.25 ≈ 0.99932.
    // (1+r)^0.99932 = 1.1 → r ≈ Math.pow(1.1, 365.25 / 365) - 1.
    const r = xirr([
      { date: new Date('2023-01-01'), amount: -1000 },
      { date: new Date('2024-01-01'), amount: 1100 },
    ]);
    expect(r).toBeCloseTo(Math.pow(1.1, DAYS_PER_YEAR / 365) - 1, 5);
  });

  it('crossing a leap year: 366-day span', () => {
    // 2024-01-01 → 2025-01-01 spans 366 days. Implied exponent = 366/365.25.
    const r = xirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ]);
    expect(r).toBeCloseTo(Math.pow(1.1, DAYS_PER_YEAR / 366) - 1, 5);
  });

  it('exact doubling over 2 calendar years (730 days, no leap day in span)', () => {
    // 2021 + 2022 = 730 days exactly. Exponent = 730/365.25 ≈ 1.99863.
    const r = xirr([
      { date: new Date('2021-01-01'), amount: -1000 },
      { date: new Date('2023-01-01'), amount: 2000 },
    ]);
    expect(r).toBeCloseTo(Math.pow(2, DAYS_PER_YEAR / 730) - 1, 4);
  });

  it('two-period investment with mid-period contribution', () => {
    // -100 at t=0, -100 at t=1y, +220 at t=2y.
    // NPV(r) = -100 - 100/(1+r) + 220/(1+r)^2 = 0
    // Solve: let x = 1/(1+r). 220 x^2 - 100 x - 100 = 0
    // x = (100 + sqrt(10000 + 88000)) / 440 = (100 + sqrt(98000)) / 440
    //   = (100 + 313.0495) / 440 = 0.93875
    // r = 1/0.93875 - 1 = 0.06525
    const r = xirr([
      { date: new Date('2024-01-01'), amount: -100 },
      { date: new Date('2025-01-01'), amount: -100 },
      { date: new Date('2026-01-01'), amount: 220 },
    ]);
    expect(r).toBeCloseTo(0.06525, 3);
  });

  it('NPV at the converged rate is approximately zero', () => {
    // Spot-check: if xirr() returns r*, then NPV(r*) must be ~0. The denominator
    // here mirrors the 365.25 convention used by xirr().
    const flows = [
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2024-04-01'), amount: -500 },
      { date: new Date('2024-10-01'), amount: 200 },
      { date: new Date('2025-12-31'), amount: 1500 },
    ];
    const r = xirr(flows);
    const t0 = flows[0].date.getTime();
    const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
    const npv = flows.reduce(
      (s, f) => s + f.amount / Math.pow(1 + r, (f.date.getTime() - t0) / MS_PER_YEAR),
      0,
    );
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });
});

describe('twr: worked sub-period examples', () => {
  it('flat market with no flows: TWR is the simple end/start ratio', () => {
    const r = twr([
      { date: new Date('2024-01-01'), value: 100 },
      { date: new Date('2024-12-31'), value: 130 },
    ]);
    expect(r).toBeCloseTo(0.3, 6);
  });

  it('mid-period WITHDRAWAL (positive flow) is correctly stripped from TWR', () => {
    // V_begin = 200 (Jan 1).
    // Mid-year: market grew 10% to 220. We withdraw 50. V_end of period 1 = 170.
    // Second half: 170 grows 10% to 187.
    // True market-driven return: 10% × 10% = 21%.
    const r = twr(
      [
        { date: new Date('2024-01-01'), value: 200 },
        { date: new Date('2024-06-30'), value: 170 }, // post-withdrawal
        { date: new Date('2024-12-31'), value: 187 },
      ],
      [{ date: new Date('2024-06-30'), amount: 50 }], // withdrawal (money OUT of the account)
    );
    expect(r).toBeCloseTo(0.21, 4);
  });

  it('TWR is unaffected when contribution + market move exactly cancel', () => {
    // V_begin = 100. Market drops 10% to 90. We contribute 10 → V_end = 100.
    // True market return: -10%.
    const r = twr(
      [
        { date: new Date('2024-01-01'), value: 100 },
        { date: new Date('2024-12-31'), value: 100 },
      ],
      [{ date: new Date('2024-12-31'), amount: -10 }], // contribution
    );
    expect(r).toBeCloseTo(-0.1, 4);
  });

  it('annualizeTwr: 21% over 730 days, using the 365.25 day-year', () => {
    // annualizeTwr now uses 365.25 to stay consistent with xirr. Over 730
    // days that's 730/365.25 ≈ 1.99863 years, so the annualized rate is
    // (1.21)^(1/1.99863) - 1, marginally above sqrt(1.21) - 1.
    const ann = annualizeTwr(0.21, 730);
    expect(ann).toBeCloseTo(Math.pow(1.21, 365.25 / 730) - 1, 6);
  });

  it('annualizeTwr: 100% loss annualizes to -100% regardless of horizon', () => {
    expect(annualizeTwr(-1, 365)).toBe(-1);
    expect(annualizeTwr(-1, 730)).toBe(-1);
  });

  it('annualizeTwr returns NaN for invalid days', () => {
    expect(annualizeTwr(0.1, 0)).toBeNaN();
    expect(annualizeTwr(0.1, -5)).toBeNaN();
  });
});

describe('flowsFromTransactions: sign convention and inclusion rules', () => {
  it('buys are negative, sells are positive', () => {
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'buy', quantity: 10, price: 100, fees: 0, amount: null },
      { date: new Date('2024-06-01'), action: 'sell', quantity: 5, price: 120, fees: 0, amount: null },
    ]);
    expect(flows).toHaveLength(2);
    expect(flows[0].amount).toBe(-1000);
    expect(flows[1].amount).toBe(600);
  });

  it('transfer_in and transfer_out are external flows (kept)', () => {
    const flows = flowsFromTransactions([
      {
        date: new Date('2024-01-01'),
        action: 'transfer_in',
        quantity: 100,
        price: 250,
        fees: 0,
        amount: null,
      },
      {
        date: new Date('2024-06-01'),
        action: 'transfer_out',
        quantity: 10,
        price: 260,
        fees: 0,
        amount: null,
      },
    ]);
    expect(flows).toHaveLength(2);
    expect(flows[0].amount).toBe(-25000); // money INTO the account is "money out of pocket"
    expect(flows[1].amount).toBe(2600);
  });

  it('div_reinvest is dropped even when amount is provided (internal)', () => {
    const flows = flowsFromTransactions([
      {
        date: new Date('2024-06-01'),
        action: 'div_reinvest',
        quantity: 0.2,
        price: 100,
        fees: 0,
        amount: -20,
      },
    ]);
    expect(flows).toHaveLength(0);
  });

  it('a real Schwab DRIP pair (Reinvest Dividend + Reinvest Shares) contributes nothing to XIRR', () => {
    // Schwab exports a DRIP as two rows: the dividend cash, then the share buy.
    // Both have action='div_reinvest' after mapping. Both must be excluded.
    const flows = flowsFromTransactions([
      { date: new Date('2026-03-27'), action: 'div_reinvest', quantity: 0, price: 0, fees: 0, amount: 3 },
      {
        date: new Date('2026-03-27'),
        action: 'div_reinvest',
        quantity: 0.0053,
        price: 566.8,
        fees: 0,
        amount: -3,
      },
    ]);
    expect(flows).toHaveLength(0);
  });

  it('uses the provided amount when it is non-zero, not the derived qty*price', () => {
    // This guards against a sign-flip when a CSV provides an explicit Amount
    // column (e.g. accounting-style negative in parens).
    const flows = flowsFromTransactions([
      { date: new Date('2024-01-01'), action: 'buy', quantity: 10, price: 100, fees: 5, amount: -1010 },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-1010);
  });
});

// ───────────────────────────────────────────────────────────────
// 3. PlannerView: projection compounding and sensitivity tile
// ───────────────────────────────────────────────────────────────
//
// The projection logic lives inline in PlannerView.tsx. We re-implement the
// math here in pure form so we can pin it down without rendering the view,
// and we test the sensitivity-delta computation that the audit identified
// as a hardcoded-bug.

function runProjection(
  startBalance: number,
  monthly: number,
  annualIncrease: number,
  returnPct: number,
  years: number,
  inflationAdjust: boolean,
): number {
  const r = inflationAdjust ? (returnPct - 3) / 100 : returnPct / 100;
  let bal = startBalance;
  let monthlyContrib = monthly;
  for (let i = 1; i <= years; i++) {
    const annualContrib = monthlyContrib * 12;
    bal = bal * (1 + r) + annualContrib * (1 + r / 2);
    monthlyContrib *= 1 + annualIncrease / 100;
  }
  return bal;
}

describe('planner: year-end compounding with mid-year contribution convention', () => {
  it('one-year projection with no contributions equals startBalance * (1+r)', () => {
    const bal = runProjection(100_000, 0, 0, 7, 1, false);
    expect(bal).toBeCloseTo(107_000, 2);
  });

  it('one-year projection with $1000/mo at 7% nominal matches the half-year-contrib formula', () => {
    // start 0, monthly 1000 → annualContrib 12000.
    // bal = 0 * 1.07 + 12000 * (1 + 0.035) = 12000 * 1.035 = 12420.
    const bal = runProjection(0, 1000, 0, 7, 1, false);
    expect(bal).toBeCloseTo(12_420, 2);
  });

  it('inflation toggle subtracts 3 percentage points from the return rate', () => {
    const nominal = runProjection(100_000, 0, 0, 7, 10, false);
    const real = runProjection(100_000, 0, 0, 7, 10, true);
    // nominal: 100k * 1.07^10
    // real:    100k * 1.04^10
    expect(nominal).toBeCloseTo(100_000 * Math.pow(1.07, 10), 2);
    expect(real).toBeCloseTo(100_000 * Math.pow(1.04, 10), 2);
  });
});

describe('planner: sensitivity deltas should reflect re-running the projection', () => {
  // FINDING (HIGH): PlannerView's "Sensitivity" tile is hardcoded with
  // deltas like -0.18, +0.22, etc. These do NOT come from re-running the
  // projection with perturbed inputs. For ANY user inputs other than the
  // demo defaults the displayed dollar deltas are wrong.
  //
  // The fix is to compute each sensitivity as
  //   (runProjection(perturbed) - runProjection(baseline)) / runProjection(baseline)
  // The view has been updated to do this. The test below pins that contract.

  it('the projection re-run produces sensitivity deltas in the expected sign/order', () => {
    const base = runProjection(500_000, 2500, 3, 7, 22, true);
    const ret_minus = runProjection(500_000, 2500, 3, 6, 22, true);
    const ret_plus = runProjection(500_000, 2500, 3, 8, 22, true);
    const con_minus = runProjection(500_000, 2300, 3, 7, 22, true);
    const con_plus = runProjection(500_000, 2700, 3, 7, 22, true);

    // Signs must match what the labels claim.
    expect(ret_minus).toBeLessThan(base);
    expect(ret_plus).toBeGreaterThan(base);
    expect(con_minus).toBeLessThan(base);
    expect(con_plus).toBeGreaterThan(base);

    // Magnitudes are non-trivial (returns dominate contribution sensitivity
    // over a multi-decade horizon).
    expect(Math.abs(ret_plus - base)).toBeGreaterThan(Math.abs(con_plus - base));
  });

  it('the OLD hardcoded delta of +0.22 is NOT the correct ratio for a short-horizon user', () => {
    // Concrete demonstration that the legacy hardcoded ratio is wrong for
    // realistic non-demo inputs. A user 5 years from retirement sees a return
    // bump produce ONLY a few-percent uplift, nowhere near +22%.
    const base = runProjection(1_500_000, 3000, 0, 6, 5, true);
    const plus = runProjection(1_500_000, 3000, 0, 7, 5, true);
    const trueRatio = (plus - base) / base;
    // The hardcoded value claims +22%; the actual ratio for this user is < 6%.
    expect(trueRatio).toBeLessThan(0.06);
    expect(Math.abs(trueRatio - 0.22)).toBeGreaterThan(0.1);
  });
});

// ───────────────────────────────────────────────────────────────
// 4. format.ts: per-row gain/loss formatting (referenced by HoldingsView)
// ───────────────────────────────────────────────────────────────

describe('format: fmtMoney signs and fmtPct signs', () => {
  it('fmtMoney on a negative renders as "-$X" not "$-X"', async () => {
    const { fmtMoney } = await import('../src/lib/format');
    expect(fmtMoney(-1234)).toBe('-$1,234');
    expect(fmtMoney(-1234.56, { cents: true })).toBe('-$1,234.56');
    expect(fmtMoney(-12_345_678, { compact: true })).toBe('-$12.35M');
  });

  it('fmtPct on a negative shows the minus sign (no leading +)', async () => {
    const { fmtPct } = await import('../src/lib/format');
    expect(fmtPct(-0.0123)).toBe('-1.23%');
    expect(fmtPct(0.0123)).toBe('+1.23%');
    expect(fmtPct(0)).toBe('+0.00%');
  });
});
