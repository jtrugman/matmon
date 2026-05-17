import { describe, expect, it } from 'vitest';
import {
  insertAccount,
  insertTransactions,
} from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';
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
  it('returns the static demo when there are no accounts in the DB', async () => {
    const p = await buildPortfolio();
    expect(p.accounts.length).toBeGreaterThan(0);
    expect(p.totalValue).toBeGreaterThan(0);
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
    await insertTransactions('acct-1', [tx({ symbol: 'AAPL', action: 'buy', quantity: 5, price: 100, rawHash: '1' })]);
    await insertTransactions('acct-2', [tx({ symbol: 'AAPL', action: 'buy', quantity: 7, price: 110, rawHash: '2' })]);
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

  it('falls back to last seen price when no live quote is cached', async () => {
    await seedAccount('acct-1');
    await insertTransactions('acct-1', [
      tx({ symbol: 'AAPL', action: 'buy', quantity: 10, price: 100, rawHash: 'a' }),
      tx({ symbol: 'AAPL', action: 'buy', quantity: 5, price: 175, rawHash: 'b', date: new Date('2025-01-01') }),
    ]);
    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL')!;
    // Most recent tx price = 175 (later date wins after sort)
    expect(aapl.price).toBe(175);
    expect(aapl.value).toBe(15 * 175);
  });
});
