// End-to-end integration: CSV import → repos → portfolio aggregation.
// Exercises the same code path the UI uses.

import { describe, expect, it } from 'vitest';
import { importCsv } from '../src/lib/importers';
import { insertAccount, insertTransactions, listTransactions } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';

// Multi-account export shape (Account + Account Number columns). Matmon
// rejects single-account Fidelity exports at the import gate, so every
// Fidelity-shape test fixture must include the account columns.
const FIDELITY = `Run Date,Account,Account Number,Action,Symbol,Description,Quantity,Price ($),Amount ($)
05/02/2026,Individual,Z00001234,DIVIDEND RECEIVED,AAPL,APPLE INC,,,104.30
04/29/2026,Individual,Z00001234,YOU BOUGHT,VOO,VANGUARD S&P 500 ETF,4,556.18,-2224.72
03/15/2026,Individual,Z00001234,YOU BOUGHT,AAPL,APPLE INC,20,240.00,-4800.00
02/10/2026,Individual,Z00001234,YOU BOUGHT,AAPL,APPLE INC,10,200.00,-2000.00
01/05/2026,Individual,Z00001234,YOU SOLD,AAPL,APPLE INC,5,220.00,1100.00`;

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
    // Chronological replay (the only correct order for running average cost):
    //   01/05/2026 SELL  5 @ 220  → nothing held, zeroed out (qty 0, cost 0)
    //   02/10/2026 BUY  10 @ 200  → qty 10, cost 2000
    //   03/15/2026 BUY  20 @ 240  → qty 30, cost 6800
    //   05/02/2026 DIVIDEND        → income only, no position change
    // Final: qty 30, cost 6800.
    expect(aapl.qty).toBe(30);
    expect(aapl.cost).toBeCloseTo(6800, 2);

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
