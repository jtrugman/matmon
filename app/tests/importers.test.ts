import { describe, expect, it } from 'vitest';
import { detect, importCsv, parseWithColumnMap } from '../src/lib/importers';

const FIDELITY = `Run Date,Action,Symbol,Description,Quantity,Price ($),Amount ($)
05/02/2026,DIVIDEND RECEIVED,AAPL,APPLE INC,,,104.30
04/29/2026,YOU BOUGHT,VOO,VANGUARD S&P 500 ETF,4,556.18,-2224.72
04/26/2026,REINVESTMENT,BND,VANGUARD TOTAL BOND,0.214,72.94,-15.62
04/22/2026,YOU SOLD,JEPI,JPM EQUITY PREMIUM INCOME ETF,30,61.84,1855.20
04/15/2026,DIVIDEND RECEIVED,VTI,VANGUARD TOTAL STOCK MKT ETF,,,1620.42`;

const SCHWAB = `Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
08/15/2024,Buy,AAPL,APPLE INC,10,180.50,0.00,-1805.00
08/14/2024 as of 08/13/2024,Cash Dividend,AAPL,APPLE INC,,,,24.00
07/15/2024,Sell,AAPL,APPLE INC,5,175.20,0.00,876.00
07/01/2024,Reinvest Shares,VTI,VANGUARD TOTAL STOCK MKT,0.5,250.00,0.00,-125.00`;

const JPM = `Trade Date,Settle Date,Transaction Type,Quantity,Symbol,Description,Price,Net Amount
2024-08-15,2024-08-17,Purchase,15,VTI,VANGUARD TOTAL STOCK,250.00,-3750.00
2024-08-01,2024-08-01,Dividend,0,VTI,VANGUARD TOTAL STOCK,0,32.40
2024-07-20,2024-07-22,Redemption,5,VTI,VANGUARD TOTAL STOCK,245.00,1225.00`;

const HUMAN_INTEREST = `Fund Name,Ticker,Shares,Unit Price,Market Value,Employee Contributions,Employer Contributions,As Of
Vanguard Total Stock Market,VTI,124.5,250.00,31125.00,18400,9200,2026-05-17
Vanguard Total Bond,BND,80.2,72.50,5814.50,8200,4100,2026-05-17`;

const UNKNOWN = `transaction_date,kind,ticker,units,unit_price
2024-08-15,buy,AAPL,10,180.50
2024-07-15,sell,AAPL,5,175.20`;

describe('detect', () => {
  it('routes Fidelity CSVs to fidelity importer', () => {
    const { importer } = detect(FIDELITY);
    expect(importer?.id).toBe('fidelity');
  });

  it('routes Schwab CSVs to schwab importer', () => {
    const { importer } = detect(SCHWAB);
    expect(importer?.id).toBe('schwab');
  });

  it('routes JPM CSVs to jpmorgan importer', () => {
    const { importer } = detect(JPM);
    expect(importer?.id).toBe('jpmorgan');
  });

  it('routes Human Interest CSVs to humanInterest importer', () => {
    const { importer } = detect(HUMAN_INTEREST);
    expect(importer?.id).toBe('humanInterest');
  });

  it('returns null importer for unknown headers', () => {
    const { importer } = detect(UNKNOWN);
    expect(importer).toBeNull();
  });
});

describe('Fidelity importer', () => {
  const result = importCsv(FIDELITY);

  it('detects 5 transactions', () => {
    expect(result.transactions).toHaveLength(5);
  });

  it('classifies dividends, buys, sells, and reinvests correctly', () => {
    const byAction = result.transactions.reduce<Record<string, number>>((acc, t) => {
      acc[t.action] = (acc[t.action] || 0) + 1;
      return acc;
    }, {});
    expect(byAction.dividend).toBe(2);
    expect(byAction.buy).toBe(1);
    expect(byAction.sell).toBe(1);
    expect(byAction.div_reinvest).toBe(1);
  });

  it('parses quantities as absolute values', () => {
    const buy = result.transactions.find(t => t.symbol === 'VOO');
    expect(buy?.quantity).toBe(4);
    expect(buy?.price).toBe(556.18);
  });

  it('records the brokerage in inferences', () => {
    expect(result.inferences.brokerage).toBe('Fidelity');
    expect(result.inferences.uniqueSymbols).toBe(5); // AAPL, VOO, BND, JEPI, VTI
  });

  it('every transaction has a non-empty rawHash for dedupe', () => {
    for (const t of result.transactions) expect(t.rawHash.length).toBeGreaterThan(0);
  });

  it('rawHashes are unique across rows', () => {
    const hashes = result.transactions.map(t => t.rawHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('Schwab importer', () => {
  const result = importCsv(SCHWAB);

  it('detects 4 transactions including the "as of" dated dividend', () => {
    expect(result.transactions).toHaveLength(4);
  });

  it('strips the " as of " suffix when parsing dates', () => {
    const div = result.transactions.find(t => t.action === 'dividend');
    expect(div).toBeTruthy();
    expect(div!.date.getFullYear()).toBe(2024);
  });

  it('maps Reinvest Shares to div_reinvest', () => {
    const reinvest = result.transactions.find(t => t.action === 'div_reinvest');
    expect(reinvest?.symbol).toBe('VTI');
  });

  it('handles zero fees', () => {
    expect(result.transactions[0].fees).toBe(0);
  });
});

describe('JP Morgan importer', () => {
  const result = importCsv(JPM);

  it('detects 3 transactions', () => {
    expect(result.transactions).toHaveLength(3);
  });

  it('maps Redemption to sell', () => {
    const sell = result.transactions.find(t => t.action === 'sell');
    expect(sell?.quantity).toBe(5);
  });

  it('parses ISO dates', () => {
    const tx = result.transactions[0];
    expect(tx.date.getFullYear()).toBe(2024);
  });

  it('reports brokerage as JP Morgan', () => {
    expect(result.inferences.brokerage).toBe('JP Morgan');
  });
});

describe('Human Interest importer (holdings-only)', () => {
  const result = importCsv(HUMAN_INTEREST);

  it('detects 2 positions and synthesizes transfer_in transactions', () => {
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.every(t => t.action === 'transfer_in')).toBe(true);
  });

  it('infers account type as 401k', () => {
    expect(result.inferences.accountType).toBe('401k');
  });
});

describe('Manual column-mapping fallback', () => {
  it('parses an unknown CSV when given column hints', () => {
    const r = parseWithColumnMap(
      UNKNOWN,
      { date: 'transaction_date', action: 'kind', symbol: 'ticker', quantity: 'units', price: 'unit_price' },
      { brokerage: 'Custom' },
    );
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0].symbol).toBe('AAPL');
    expect(r.inferences.brokerage).toBe('Custom');
  });

  it('captures unmapped action strings instead of silently dropping', () => {
    const csv = `date,kind,ticker
2024-08-15,buy,AAPL
2024-07-15,WeirdAction,VTI`;
    const r = parseWithColumnMap(csv, { date: 'date', action: 'kind', symbol: 'ticker' });
    expect(r.transactions).toHaveLength(1);
    expect(r.unmappedActionStrings).toContain('WeirdAction');
  });
});

describe('importCsv top-level entry', () => {
  it('returns importerId=null for unknown CSV', () => {
    const r = importCsv(UNKNOWN);
    expect(r.importerId).toBeNull();
    expect(r.transactions).toHaveLength(0);
  });

  it('sets importerId to the matched id', () => {
    expect(importCsv(FIDELITY).importerId).toBe('fidelity');
    expect(importCsv(SCHWAB).importerId).toBe('schwab');
    expect(importCsv(JPM).importerId).toBe('jpmorgan');
    expect(importCsv(HUMAN_INTEREST).importerId).toBe('humanInterest');
  });
});
