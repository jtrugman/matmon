// End-to-end integration: CSV import → repos → portfolio aggregation.
// Exercises the same code path the UI uses.

import { describe, expect, it } from 'vitest';
import { importCsv } from '../src/lib/importers';
import { insertAccount, insertTransactions, listTransactions } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';

const FIDELITY = `Run Date,Action,Symbol,Description,Quantity,Price ($),Amount ($)
05/02/2026,DIVIDEND RECEIVED,AAPL,APPLE INC,,,104.30
04/29/2026,YOU BOUGHT,VOO,VANGUARD S&P 500 ETF,4,556.18,-2224.72
03/15/2026,YOU BOUGHT,AAPL,APPLE INC,20,240.00,-4800.00
02/10/2026,YOU BOUGHT,AAPL,APPLE INC,10,200.00,-2000.00
01/05/2026,YOU SOLD,AAPL,APPLE INC,5,220.00,1100.00`;

async function createAccount(id: string) {
  await insertAccount({
    id,
    name: 'Test',
    brokerage: 'Fidelity',
    account_type: 'taxable',
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
}

describe('Integration: CSV → DB → Portfolio', () => {
  it('full happy path: import a Fidelity CSV, holdings reflect correct quantities + average cost', async () => {
    await createAccount('fid-1');
    const parsed = importCsv(FIDELITY);
    expect(parsed.importerId).toBe('fidelity');
    const result = await insertTransactions('fid-1', parsed.transactions);
    expect(result.inserted).toBe(5);
    expect(result.skipped).toBe(0);

    const p = await buildPortfolio();
    const aapl = p.holdings.find(h => h.sym === 'AAPL' && h.account === 'fid-1')!;
    expect(aapl).toBeTruthy();
    // 20@240 + 10@200 = 30 shares, cost = 6800, avg ~226.67
    // sell 5 at avg ~226.67 → cost reduces by 1133.33 → qty 25, cost ~5666.67
    expect(aapl.qty).toBe(25);
    expect(aapl.cost).toBeCloseTo(6800 - (6800 / 30) * 5, 2);

    const voo = p.holdings.find(h => h.sym === 'VOO' && h.account === 'fid-1');
    expect(voo).toBeTruthy();
    expect(voo!.qty).toBe(4);
  });

  it('re-importing the same CSV is a no-op for holdings', async () => {
    await createAccount('fid-1');
    const parsed = importCsv(FIDELITY);
    await insertTransactions('fid-1', parsed.transactions);
    const before = await buildPortfolio();

    const second = await insertTransactions('fid-1', parsed.transactions);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(5);

    const after = await buildPortfolio();
    expect(after.totalValue).toBeCloseTo(before.totalValue, 4);
    expect(after.holdings.length).toBe(before.holdings.length);
  });

  it('two CSVs from different brokers create two account rollups under one portfolio', async () => {
    await createAccount('fid-1');
    await insertAccount({
      id: 'sch-1',
      name: 'Schwab',
      brokerage: 'Charles Schwab',
      account_type: 'roth_ira',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('fid-1', importCsv(FIDELITY).transactions);
    const SCH = `Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
08/15/2024,Buy,VTI,VANGUARD,50,300.00,0.00,-15000.00`;
    await insertTransactions('sch-1', importCsv(SCH).transactions);
    const p = await buildPortfolio();
    expect(p.accounts.find(a => a.id === 'fid-1')).toBeTruthy();
    expect(p.accounts.find(a => a.id === 'sch-1')).toBeTruthy();
    expect(p.accounts.length).toBe(2);
    const vti = p.holdings.find(h => h.sym === 'VTI' && h.account === 'sch-1');
    expect(vti?.qty).toBe(50);
  });

  it('transactions land in DB with stable timestamps', async () => {
    await createAccount('fid-1');
    const parsed = importCsv(FIDELITY);
    await insertTransactions('fid-1', parsed.transactions);
    const txs = await listTransactions('fid-1');
    expect(txs).toHaveLength(5);
    for (const t of txs) {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(t.imported_from).toBeTruthy();
    }
  });
});
