// Regression coverage for the JPM holdings-importer math bug.
//
// Before the fix: jpmHoldings synthesized one transfer_in per tax lot and used
// the lot's Unit Cost as the transaction price. That left the portfolio with
// no live quote and no stored price, so the priceFor() fallback in portfolio.ts
// landed on the last-tx price (which IS the unit cost), making market value
// equal cost basis and unrealized gain exactly $0 for every JPM holding.
//
// After the fix: the importer also surfaces a marketPrices array (one entry
// per unique symbol, sourced from the file's Price + Pricing Date columns),
// the persistence layer upserts those into the prices table, and portfolio.ts
// reads from prices as a fallback BEFORE the last-tx-price fallback. End
// result: value = qty * current market price, not qty * unit cost.

import { describe, expect, it } from 'vitest';
import { importCsv } from '../src/lib/importers';
import { getLatestPrice, insertAccount, insertTransactions, upsertPrice } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';

// A tiny synthetic JPM positions CSV with just the columns the importer reads.
// Mirrors the real file's pricing-date string ("MM/DD/YYYY HH:MM:SS"). Three
// lots total: two VTI lots (acquired at $200 and $250), one QQQ lot (acquired
// at $300). Current marks: VTI $362, QQQ $475.
const JPM_HOLDINGS_CSV = `Account name,Account number,Account type,Sub account,Description,Ticker,CUSIP,Quantity,Price,Pricing Date,Acquisition Date,Unit Cost,Acct Type
"Self-Directed","...2180","Brokerage","","VANGUARD TOTAL STOCK MARKET ETF","VTI","922908769","10","362.00","05/15/2026 11:59:59","01/15/2024","200.00","C"
"Self-Directed","...2180","Brokerage","","VANGUARD TOTAL STOCK MARKET ETF","VTI","922908769","8","362.00","05/15/2026 11:59:59","07/20/2024","250.00","C"
"Self-Directed","...2180","Brokerage","","INVESCO QQQ TRUST SERIES 1","QQQ","46090E103","5","475.00","05/15/2026 11:59:59","03/01/2024","300.00","C"
FOOTNOTES,,,,,,,,,,,,
A,Footnote text we should ignore,,,,,,,,,,,`;

async function seedAccount(id: string) {
  await insertAccount({
    id,
    name: id,
    brokerage: 'JP Morgan',
    account_type: 'taxable',
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
}

describe('JPM holdings: market price flows through to portfolio gain math', () => {
  it('importer surfaces one market-price entry per unique ticker', () => {
    const result = importCsv(JPM_HOLDINGS_CSV);
    expect(result.importerId).toBe('jpmHoldings');
    // 3 lots collapse to 2 unique tickers.
    expect(result.marketPrices).toBeDefined();
    expect(result.marketPrices!).toHaveLength(2);

    const vti = result.marketPrices!.find(mp => mp.symbol === 'VTI');
    const qqq = result.marketPrices!.find(mp => mp.symbol === 'QQQ');
    expect(vti?.price).toBe(362);
    expect(qqq?.price).toBe(475);
    // Pricing Date "05/15/2026 11:59:59" parses through parseDate's MM/DD/YYYY
    // branch; the time is dropped (we only need a stable date key). parseDate
    // now builds via Date.UTC so we assert against UTC accessors.
    expect(vti?.asOf.getUTCFullYear()).toBe(2026);
    expect(vti?.asOf.getUTCMonth()).toBe(4); // May (0-indexed)
    expect(vti?.asOf.getUTCDate()).toBe(15);
  });

  it('upsertPrice + getLatestPrice round-trip', async () => {
    const d = new Date('2026-05-15T00:00:00Z');
    await upsertPrice('VTI', d, 362);
    const got = await getLatestPrice('VTI');
    expect(got).not.toBeNull();
    expect(got!.price).toBe(362);
    // upsertPrice replaces in place on the same date key (no duplicate rows).
    await upsertPrice('VTI', d, 999);
    const updated = await getLatestPrice('VTI');
    expect(updated!.price).toBe(999);
  });

  it('newer date wins for getLatestPrice', async () => {
    await upsertPrice('QQQ', new Date('2026-01-01'), 400);
    await upsertPrice('QQQ', new Date('2026-05-15'), 475);
    await upsertPrice('QQQ', new Date('2026-03-01'), 450);
    const got = await getLatestPrice('QQQ');
    expect(got!.price).toBe(475);
  });

  it('buildPortfolio values JPM holdings at market price, NOT cost basis', async () => {
    await seedAccount('jpm-taxable');
    const result = importCsv(JPM_HOLDINGS_CSV);

    // Mirror App.tsx's finishOnboarding ordering: transactions first, then
    // upsert each market price.
    await insertTransactions('jpm-taxable', result.transactions);
    for (const mp of result.marketPrices!) {
      await upsertPrice(mp.symbol, mp.asOf, mp.price);
    }

    const p = await buildPortfolio();
    const vti = p.holdings.find(h => h.sym === 'VTI' && h.account === 'jpm-taxable')!;
    const qqq = p.holdings.find(h => h.sym === 'QQQ' && h.account === 'jpm-taxable')!;
    expect(vti).toBeTruthy();
    expect(qqq).toBeTruthy();

    // VTI: 10 + 8 = 18 shares; cost = 10*200 + 8*250 = 2000 + 2000 = 4000.
    expect(vti.qty).toBe(18);
    expect(vti.cost).toBeCloseTo(4000, 4);

    // The bug: before the fix, vti.price would equal the last-tx price (250),
    // making value = 18*250 = 4500 and gain = 500. With the fix the value uses
    // the current market price (362) from the prices table:
    //   value = 18 * 362 = 6516
    //   gain  = 6516 - 4000 = 2516 (positive, non-zero, NOT zero)
    expect(vti.price).toBe(362);
    expect(vti.value).toBeCloseTo(18 * 362, 4);
    expect(vti.gain).toBeCloseTo(18 * 362 - 4000, 4);
    expect(vti.gain).toBeGreaterThan(0);
    // Hard regression assert: value MUST diverge from cost basis.
    expect(vti.value).not.toBeCloseTo(vti.cost, 2);

    // QQQ: 5 shares at $300 cost → market 475.
    expect(qqq.qty).toBe(5);
    expect(qqq.cost).toBeCloseTo(5 * 300, 4);
    expect(qqq.price).toBe(475);
    expect(qqq.value).toBeCloseTo(5 * 475, 4);
    expect(qqq.gain).toBeCloseTo(5 * 475 - 5 * 300, 4);
  });

  it('re-importing the same JPM file is a no-op (numbers unchanged)', async () => {
    await seedAccount('jpm-taxable');
    const first = importCsv(JPM_HOLDINGS_CSV);
    await insertTransactions('jpm-taxable', first.transactions);
    for (const mp of first.marketPrices!) {
      await upsertPrice(mp.symbol, mp.asOf, mp.price);
    }
    const before = await buildPortfolio();

    // Second import: same hashes, so insertTransactions dedupes. Same prices,
    // so upsertPrice no-ops in place on the (symbol, date) key.
    const second = importCsv(JPM_HOLDINGS_CSV);
    const counts = await insertTransactions('jpm-taxable', second.transactions);
    expect(counts.inserted).toBe(0);
    expect(counts.skipped).toBe(3);
    for (const mp of second.marketPrices!) {
      await upsertPrice(mp.symbol, mp.asOf, mp.price);
    }
    const after = await buildPortfolio();

    expect(after.totalValue).toBeCloseTo(before.totalValue, 4);
    expect(after.holdings.length).toBe(before.holdings.length);
    for (const h of after.holdings) {
      const same = before.holdings.find(b => b.sym === h.sym && b.account === h.account)!;
      expect(h.qty).toBeCloseTo(same.qty, 4);
      expect(h.cost).toBeCloseTo(same.cost, 4);
      expect(h.value).toBeCloseTo(same.value, 4);
      expect(h.gain).toBeCloseTo(same.gain, 4);
    }
  });
});
