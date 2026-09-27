import { describe, expect, it } from 'vitest';
import { insertAccount, insertTransactions, upsertPrice } from '../src/lib/db/repos';
import { buildPortfolio, rollupDayChange } from '../src/lib/portfolio';
import type { ParsedTransaction } from '../src/lib/importers/types';

function tx(o: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    date: new Date('2024-08-15T00:00:00Z'),
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

describe('Portfolio aggregation', () => {
  it('returns an empty MatmonData shape when there are no accounts in the DB', async () => {
    // Previous behavior: with zero accounts, buildPortfolio() returned
    // MATMON_DATA wholesale, leaking the $1.2M demo persona onto a real user
    // who completed onboarding without uploading a CSV. The view layer now
    // handles the empty state on its own.
    const p = await buildPortfolio();
    expect(p.accounts).toEqual([]);
    expect(p.holdings).toEqual([]);
    expect(p.activity).toEqual([]);
    expect(p.series).toEqual([]);
    expect(p.spy).toEqual([]);
    expect(p.totalValue).toBe(0);
    expect(p.totalDayChange).toBe(0);
    // accountTypes is the static catalog; it's safe and useful for empty-state UIs.
    expect(p.accountTypes.length).toBeGreaterThan(0);
  });

  it('rolls up buys into holdings with average cost basis', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 200, rawHash: 'b' }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL')!;
    expect(aapl).toBeTruthy();
    expect(aapl.qty).toBe(20);
    expect(aapl.cost).toBe(3000);
    expect(aapl.basis).toBeCloseTo(150, 4);
  });

  it('handles a sell by reducing qty at the running average cost', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 200, rawHash: 'b' }),
      tx({ symbol: 'AAPL', action: 'sell', quantity: 5, price: 250, rawHash: 'c' }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL')!;
    expect(aapl.qty).toBe(15);
    // Reduced 5 shares × avg(150) = 750 → cost basis 3000 - 750 = 2250
    expect(aapl.cost).toBeCloseTo(2250, 4);
  });

  it('zeroes out a fully sold position', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({ symbol: 'AAPL', action: 'sell', quantity: 10, price: 120, rawHash: 'b' }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL');
    expect(aapl?.qty ?? 0).toBe(0);
  });

  it('groups holdings per (account, symbol) so the same symbol in two accounts is two rows', async () => {
    await seedAccount('acct-1');
    await seedAccount('acct-2');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 5, price: 100, rawHash: '1' }),
    ]);
    await insertTransactions('acct-2', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 7, price: 110, rawHash: '2' }),
    ]);
    const p = await buildPortfolio();
    const apples = p.holdings.filter(h => h.sym === 'AAPL');
    expect(apples).toHaveLength(2);
    expect(apples.find(h => h.account === 'acct-1')!.qty).toBe(5);
    expect(apples.find(h => h.account === 'acct-2')!.qty).toBe(7);
  });

  it('treats transfer_in like a buy for qty/basis (holdings-only path)', async () => {
    await seedAccount('hi-401k', '401k');
    await insertTransactions('hi-401k', [
      tx({ symbol: 'VTI', action: 'transfer_in', quantity: 100, price: 250, rawHash: 'ti' }),
    ]);
    const p = await buildPortfolio();
    const vti = p.holdings.find(h => h.sym === 'VTI')!;
    expect(vti.qty).toBe(100);
    expect(vti.cost).toBe(25000);
  });

  it('rolls account values up from holdings', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
    ]);
    const p = await buildPortfolio();
    const acct = p.accounts.find(a => a.id === 'acct-1');
    expect(acct?.value).toBeGreaterThan(0);
    expect(p.totalValue).toBeCloseTo(acct!.value, 4);
  });

  it('share % of each holding sums to ~100%', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({ symbol: 'VTI', action: 'buy', quantity: 20, price: 300, rawHash: 'b' }),
    ]);
    const p = await buildPortfolio();
    const sum = p.holdings.reduce((s, h) => s + h.share, 0);
    expect(sum).toBeCloseTo(1, 4);
  });

  it('uses stored prices table before last-tx fallback (JPM holdings flow)', async () => {
    // JPM holdings importer writes market marks into the prices table at
    // import time, so a holdings-only import (where every tx price reflects
    // cost-basis-not-market) can still be valued at the real market mark.
    // The price-resolution priority is:
    //   1. fresh live quote cache
    //   2. stored prices table
    //   3. last-tx fallback
    // Without (2), this test would see qty * last-tx-price (the cost basis).
    await seedAccount('jpm-401k', '401k');
    await insertTransactions('jpm-401k', [
      // Cost basis tx: 100 shares of VTI at $200 (avg cost from years ago).
      tx({
        symbol: 'VTI',
        action: 'transfer_in',
        quantity: 100,
        price: 200,
        date: new Date('2020-01-15'),
        rawHash: 'jpm-vti-basis',
      }),
    ]);
    // The importer would then mark the current market value, e.g. $250.
    await upsertPrice('VTI', new Date('2025-01-01'), 250);

    const p = await buildPortfolio();
    const vti = p.holdings.find(h => h.sym === 'VTI')!;
    expect(vti).toBeTruthy();
    expect(vti.qty).toBe(100);
    // Resolved price should be the stored mark ($250), NOT the last-tx
    // basis ($200). Without the stored-prices step in the priority order,
    // this would be $200 and the user would underweight their holdings.
    expect(vti.price).toBe(250);
    expect(vti.value).toBe(100 * 250);
    // Gain is market value minus cost basis (qty * price - cost).
    expect(vti.cost).toBe(100 * 200);
    expect(vti.gain).toBe(100 * 250 - 100 * 200);
  });

  it('falls back to last seen price when no live quote is cached', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 5,
        price: 175,
        rawHash: 'b',
        date: new Date('2025-01-01'),
      }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL')!;
    // Most recent tx price = 175 (later date wins after sort)
    expect(aapl.price).toBe(175);
    expect(aapl.value).toBe(15 * 175);
  });
});

describe('Portfolio dayChange via prev_close', () => {
  it('populates dayChange and dayChangePct on holdings when prev_close is present', async () => {
    // Synthetic scenario from the spec: AMD qty 91, prev_close $420, price
    // $424.10 → dayChange = 91 × $4.10 = $373.10. The prices table mirrors
    // the Yahoo chart endpoint shape (close = today, prev_close = yesterday).
    await seedAccount('acct-amd');
    await insertTransactions('acct-amd', [
      tx({
        symbol: 'AMD',
        action: 'buy',
        quantity: 91,
        price: 100, // cost-basis price, irrelevant to dayChange math
        date: new Date('2024-01-01'),
        rawHash: 'amd-1',
      }),
    ]);
    await upsertPrice('AMD', new Date('2026-05-18'), 424.1, 'USD', 420);

    const p = await buildPortfolio();
    const amd = p.holdings.find(h => h.sym === 'AMD')!;
    expect(amd).toBeTruthy();
    expect(amd.qty).toBe(91);
    expect(amd.price).toBe(424.1);
    // Per-cent assertion on the headline number.
    expect(amd.dayChange).toBeCloseTo(373.1, 2);
    // Percent: 4.10 / 420 = 0.00976...
    expect(amd.dayChangePct).toBeCloseTo(0.00976, 4);
  });

  it('rolls per-holding dayChange up to account.dayChange and totalDayChange', async () => {
    // Two holdings in one account: AMD +$4.10 × 91 = +$373.10, NVDA -$2.00 ×
    // 50 = -$100. Account sum: +$273.10. Total sum: same.
    await seedAccount('acct-multi');
    await insertTransactions('acct-multi', [
      tx({
        symbol: 'AMD',
        action: 'buy',
        quantity: 91,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: 'amd-x',
      }),
      tx({
        symbol: 'NVDA',
        action: 'buy',
        quantity: 50,
        price: 100,
        date: new Date('2024-01-02'),
        rawHash: 'nvda-x',
      }),
    ]);
    await upsertPrice('AMD', new Date('2026-05-18'), 424.1, 'USD', 420);
    await upsertPrice('NVDA', new Date('2026-05-18'), 148, 'USD', 150);

    const p = await buildPortfolio();
    const acct = p.accounts.find(a => a.id === 'acct-multi')!;
    expect(acct.dayChange).toBeCloseTo(273.1, 2);
    expect(acct.dayChangePending).toBe(0);
    expect(p.totalDayChange).toBeCloseTo(273.1, 2);
  });

  it('excludes holdings without prev_close from the sum and surfaces them in dayChangePending', async () => {
    // Two holdings: one with prev_close, one without (e.g. JPM holdings
    // importer wrote market price but no prior close). The pending count
    // tracks the silent one so the UI can render the "(N symbols pending
    // today's data)" footer.
    await seedAccount('acct-mixed');
    await insertTransactions('acct-mixed', [
      tx({
        symbol: 'AMD',
        action: 'buy',
        quantity: 91,
        price: 100,
        date: new Date('2024-01-01'),
        rawHash: 'amd-mix',
      }),
      tx({
        symbol: 'VTI',
        action: 'buy',
        quantity: 100,
        price: 200,
        date: new Date('2024-01-02'),
        rawHash: 'vti-mix',
      }),
    ]);
    // AMD: has prev_close. VTI: explicit null prev_close (JPM holdings flow).
    await upsertPrice('AMD', new Date('2026-05-18'), 424.1, 'USD', 420);
    await upsertPrice('VTI', new Date('2026-05-18'), 320, 'USD', null);

    const p = await buildPortfolio();
    const amd = p.holdings.find(h => h.sym === 'AMD')!;
    const vti = p.holdings.find(h => h.sym === 'VTI')!;
    expect(amd.dayChange).toBeCloseTo(373.1, 2);
    expect(vti.dayChange).toBeNull();
    expect(vti.dayChangePct).toBeNull();
    const acct = p.accounts.find(a => a.id === 'acct-mixed')!;
    // Sum drops VTI, keeps AMD.
    expect(acct.dayChange).toBeCloseTo(373.1, 2);
    expect(acct.dayChangePending).toBe(1);
    // totalDayChange mirrors the same exclusion: only AMD's +$373.10.
    expect(p.totalDayChange).toBeCloseTo(373.1, 2);
  });
});

describe('rollupDayChange', () => {
  it('sums dayChange across holdings and computes the value-weighted percent', () => {
    // AMD: qty 91, price 424.1, dayChange +373.1 → prevValue = 91 × 420 = 38220
    // NVDA: qty 50, price 148, dayChange -100 → prevValue = 50 × 150 = 7500
    // sumChange = +273.10, prevTotal = 45720, pct ≈ +0.00598
    const out = rollupDayChange([
      { qty: 91, price: 424.1, dayChange: 373.1, dayChangePct: 0.00976 },
      { qty: 50, price: 148, dayChange: -100, dayChangePct: -0.0133 },
    ]);
    expect(out.dayChange).toBeCloseTo(273.1, 2);
    expect(out.dayChangePct).toBeCloseTo(273.1 / 45720, 4);
    expect(out.pendingCount).toBe(0);
  });

  it('counts holdings with null dayChange as pending and drops them from the sum', () => {
    const out = rollupDayChange([
      { qty: 91, price: 424.1, dayChange: 373.1, dayChangePct: 0.00976 },
      { qty: 100, price: 320, dayChange: null, dayChangePct: null },
      { qty: 10, price: 50, dayChange: null, dayChangePct: null },
    ]);
    expect(out.dayChange).toBeCloseTo(373.1, 2);
    expect(out.pendingCount).toBe(2);
    expect(out.dayChangePct).toBeCloseTo(373.1 / (91 * 420), 4);
  });

  it('returns dayChangePct = null when no holdings have prev data', () => {
    const out = rollupDayChange([
      { qty: 100, price: 320, dayChange: null, dayChangePct: null },
    ]);
    expect(out.dayChange).toBe(0);
    expect(out.dayChangePct).toBeNull();
    expect(out.pendingCount).toBe(1);
  });
});
