// Unit tests for aggregateHoldingsBySymbol: collapses per-(account, symbol)
// holdings into one row per symbol so the unfiltered Holdings view doesn't
// show a symbol N times when it lives in N accounts.
//
// Repro for Bug 2: Justin sees VITAX 5 times in his JPM imports because his
// data has VITAX in 5 different JPM accounts. The unfiltered Holdings page
// should show ONE VITAX row aggregated across the 5 accounts.

import { describe, expect, it } from 'vitest';
import { aggregateHoldingsBySymbol } from '../src/lib/portfolio';
import type { Holding } from '../src/data';

function holding(o: Partial<Holding> & Pick<Holding, 'sym' | 'account'>): Holding {
  // Default fixture: all the numeric / null fields set to "neutral" values so
  // a per-test override only specifies the bits it cares about.
  const qty = o.qty ?? 100;
  const price = o.price ?? 50;
  const cost = o.cost ?? qty * 40;
  const value = qty * price;
  const gain = value - cost;
  return {
    sym: o.sym,
    name: o.name ?? `${o.sym} Fund`,
    qty,
    price,
    basis: cost / qty,
    sector: o.sector ?? '',
    industry: o.industry ?? '',
    account: o.account,
    value,
    cost,
    gain,
    gainPct: cost > 0 ? gain / cost : 0,
    share: o.share ?? 0,
    spark: [],
    dayChange: o.dayChange ?? null,
    dayChangePct: o.dayChangePct ?? null,
    ...o,
  };
}

describe('aggregateHoldingsBySymbol', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateHoldingsBySymbol([])).toEqual([]);
  });

  it('passes through a single-symbol single-account input unchanged in shape', () => {
    const input = [holding({ sym: 'VTI', account: 'fid-1', qty: 100, price: 200, cost: 15_000 })];
    const out = aggregateHoldingsBySymbol(input);
    expect(out).toHaveLength(1);
    expect(out[0].sym).toBe('VTI');
    expect(out[0].qty).toBe(100);
    expect(out[0].cost).toBe(15_000);
    expect(out[0].value).toBe(20_000);
    expect(out[0].gain).toBe(5_000);
    // heldInAccounts === 1 (single account)
    expect(out[0].heldInAccounts).toBe(1);
  });

  it('collapses 5 VITAX rows across 5 accounts into ONE row with summed qty/cost/value', () => {
    // Mirrors Justin's actual data shape: VITAX in 5 different JPM accounts.
    const accounts = ['jpm-1', 'jpm-2', 'jpm-3', 'jpm-4', 'jpm-5'];
    const qtyPer = 107.96; // 539.8 / 5
    const costPer = 25_000;
    const pricePer = 464.5;
    const input = accounts.map(a =>
      holding({
        sym: 'VITAX',
        account: a,
        qty: qtyPer,
        price: pricePer,
        cost: costPer,
        name: 'Vanguard Information Tech ETF',
      }),
    );
    const out = aggregateHoldingsBySymbol(input);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.sym).toBe('VITAX');
    // qty = Σ qty
    expect(row.qty).toBeCloseTo(qtyPer * 5, 4);
    // cost = Σ cost
    expect(row.cost).toBeCloseTo(costPer * 5, 4);
    // value = Σ value
    expect(row.value).toBeCloseTo(qtyPer * pricePer * 5, 4);
    // basis recomputed from aggregated totals
    expect(row.basis).toBeCloseTo((costPer * 5) / (qtyPer * 5), 4);
    // gain = value - cost
    expect(row.gain).toBeCloseTo(qtyPer * pricePer * 5 - costPer * 5, 4);
    // heldInAccounts populated
    expect(row.heldInAccounts).toBe(5);
    // share recomputed against new aggregated total (with only one row this
    // should be 1.0)
    expect(row.share).toBeCloseTo(1, 4);
  });

  it('mixed: 3 symbols, one held in 2 accounts and two in 1 each, returns 3 rows', () => {
    const input = [
      holding({ sym: 'VITAX', account: 'a1', qty: 50, price: 400, cost: 15_000 }),
      holding({ sym: 'VITAX', account: 'a2', qty: 75, price: 400, cost: 22_500 }),
      holding({ sym: 'VOO', account: 'a1', qty: 100, price: 550, cost: 40_000 }),
      holding({ sym: 'AAPL', account: 'a2', qty: 200, price: 250, cost: 30_000 }),
    ];
    const out = aggregateHoldingsBySymbol(input);
    expect(out).toHaveLength(3);
    const bySym = new Map(out.map(h => [h.sym, h]));
    expect(bySym.get('VITAX')?.qty).toBe(125);
    expect(bySym.get('VITAX')?.cost).toBe(37_500);
    expect(bySym.get('VITAX')?.heldInAccounts).toBe(2);
    expect(bySym.get('VOO')?.heldInAccounts).toBe(1);
    expect(bySym.get('AAPL')?.heldInAccounts).toBe(1);
  });

  it('sums non-null dayChange and propagates null when EVERY input is null', () => {
    // Two accounts both reporting dayChange.
    const withDayChange = [
      holding({ sym: 'VITAX', account: 'a1', qty: 50, price: 400, dayChange: 100, dayChangePct: 0.005 }),
      holding({ sym: 'VITAX', account: 'a2', qty: 50, price: 400, dayChange: 50, dayChangePct: 0.003 }),
    ];
    expect(aggregateHoldingsBySymbol(withDayChange)[0].dayChange).toBe(150);

    // Two accounts both reporting null dayChange (pending price data).
    const allNull = [
      holding({ sym: 'X', account: 'a1', qty: 10, price: 100, dayChange: null }),
      holding({ sym: 'X', account: 'a2', qty: 20, price: 100, dayChange: null }),
    ];
    expect(aggregateHoldingsBySymbol(allNull)[0].dayChange).toBeNull();
    expect(aggregateHoldingsBySymbol(allNull)[0].dayChangePct).toBeNull();
  });

  it('share column re-sums to 1.0 after aggregation', () => {
    const input = [
      holding({ sym: 'VITAX', account: 'a1', qty: 100, price: 400 }),
      holding({ sym: 'VITAX', account: 'a2', qty: 100, price: 400 }),
      holding({ sym: 'VOO', account: 'a1', qty: 50, price: 550 }),
    ];
    const out = aggregateHoldingsBySymbol(input);
    const sumShare = out.reduce((s, h) => s + h.share, 0);
    expect(sumShare).toBeCloseTo(1, 4);
  });

  it('inherits sector from a non-empty input even when another row is empty', () => {
    // First row has no sector, second row has the real sector; the merge must
    // promote the real one onto the aggregate.
    const input = [
      holding({ sym: 'VITAX', account: 'a1', sector: '' }),
      holding({ sym: 'VITAX', account: 'a2', sector: 'Technology' }),
    ];
    const out = aggregateHoldingsBySymbol(input);
    expect(out[0].sector).toBe('Technology');
  });

  it('runs in O(n): does not blow up on a realistic VITAX-in-5-accounts case', () => {
    // Build a 50-holding fixture (one ticker × 50 accounts) and confirm it
    // returns in under 50ms on a slow machine. This isn't a precise complexity
    // assertion but it catches accidental O(n²) regressions.
    const input: Holding[] = [];
    for (let i = 0; i < 50; i++) {
      input.push(holding({ sym: 'VITAX', account: `acct-${i}`, qty: 10, price: 400 }));
    }
    const t0 = performance.now();
    const out = aggregateHoldingsBySymbol(input);
    const dur = performance.now() - t0;
    expect(out).toHaveLength(1);
    expect(out[0].heldInAccounts).toBe(50);
    expect(dur).toBeLessThan(50);
  });
});
