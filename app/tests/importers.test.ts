import { describe, expect, it } from 'vitest';
import { detect, importCsv, parseWithColumnMap } from '../src/lib/importers';

// Multi-account export shape (with Account + Account Number columns). Matmon
// rejects Fidelity single-account exports at the import gate because they
// omit the account number entirely (no fingerprint for dedupe), so every
// Fidelity test fixture must carry the multi-account shape.
const FIDELITY = `Run Date,Account,Account Number,Action,Symbol,Description,Quantity,Price ($),Amount ($)
05/02/2026,Individual,Z00001234,DIVIDEND RECEIVED,AAPL,APPLE INC,,,104.30
04/29/2026,Individual,Z00001234,YOU BOUGHT,VOO,VANGUARD S&P 500 ETF,4,556.18,-2224.72
04/26/2026,Individual,Z00001234,REINVESTMENT,BND,VANGUARD TOTAL BOND,0.214,72.94,-15.62
04/22/2026,Individual,Z00001234,YOU SOLD,JEPI,JPM EQUITY PREMIUM INCOME ETF,30,61.84,1855.20
04/15/2026,Individual,Z00001234,DIVIDEND RECEIVED,VTI,VANGUARD TOTAL STOCK MKT ETF,,,1620.42`;

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

describe('Fidelity DISTRIBUTION with Type=Shares (share-based capital gains)', () => {
  // FINDING (HIGH, FIXED): Fidelity reports a fund capital-gains distribution
  // paid AS ADDITIONAL SHARES on a single row with action="DISTRIBUTION ..."
  // and Type="Shares". Both Quantity and Amount are populated; the Price
  // column is blank because the implicit per-share price is Amount/Quantity.
  //
  // Before the fix: the action mapper returned "dividend" (matching the
  // /distribution/ rule), which the portfolio aggregator treats as a no-op
  // for qty + cost. So a real $7,808.23 / 77.294-share distribution silently
  // never reached the portfolio. A user importing the example Fidelity file
  // saw cost basis off by ~$7.8K per account.
  //
  // After the fix: the Fidelity importer detects DISTRIBUTION + Type="Shares"
  // + Quantity > 0 + Amount > 0, re-tags the action as transfer_in (NOT
  // div_reinvest, because the user received shares with that cost basis,
  // not cash income), and synthesizes a per-share price = Amount/Quantity.
  // The portfolio aggregator adds the quantity to the position and the Amount
  // to the cost basis; the dividend milestones / lifetime-dividend rollups
  // correctly ignore it because it was not income.
  // Multi-account shape (Account + Account Number columns). The actual
  // share-distribution detection works regardless of how many accounts the
  // file holds; using the multi-account shape here keeps the test consistent
  // with the only Fidelity export shape Matmon accepts.
  const SHARE_DISTRIBUTION = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
04/21/2026,Individual,Z00001234,"DISTRIBUTION VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)",VGT,"VANGUARD WORLD FD INF TECH ETF",Shares,,77.294,,,,7808.23,40.95,
04/20/2026,Individual,Z00001234,"YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)",VGT,"VANGUARD WORLD FD INF TECH ETF",Cash,806.37,0.186,,,,-149.98,40.95,04/21/2026`;

  it('re-tags share distribution as transfer_in and synthesizes per-share price', () => {
    const result = importCsv(SHARE_DISTRIBUTION);
    expect(result.importerId).toBe('fidelity');
    expect(result.transactions).toHaveLength(2);
    const dist = result.transactions.find(t => Math.abs(t.quantity - 77.294) < 1e-9)!;
    expect(dist).toBeTruthy();
    // Tagged as transfer_in so the dividend milestones and Lifetime Div
    // rollups skip it; the portfolio aggregator still adds the qty + cost
    // basis because transfer_in is treated the same as buy.
    expect(dist.action).toBe('transfer_in');
    // Implicit price = 7808.23 / 77.294 ≈ 101.0185...
    expect(dist.price).toBeCloseTo(7808.23 / 77.294, 6);
    // The amount is preserved verbatim from the CSV (positive cash equivalent).
    expect(dist.amount).toBe(7808.23);
  });

  it('plain DIVIDEND RECEIVED (Type=Cash, qty=0) still classifies as dividend, NOT a share buy', () => {
    // Counterexample: a Type=Cash distribution with no quantity must STAY a
    // dividend (qty unchanged, cost unchanged). Only Type=Shares with non-zero
    // qty + amount should flip to div_reinvest.
    // Multi-account shape to satisfy Matmon's import gate (single-account
    // Fidelity exports are rejected up front because they omit the account
    // number used for dedup).
    const CASH_DIV = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
04/30/2026,Individual,Z00001234,"DIVIDEND RECEIVED FIDELITY TREASURY MONEY MARKET FUND (FZFXX) (Cash)",FZFXX,"FIDELITY TREASURY MONEY MARKET FUND",Cash,,0.000,,,,0.21,41.24,`;
    const result = importCsv(CASH_DIV);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].action).toBe('dividend');
    expect(result.transactions[0].quantity).toBe(0);
  });

  it('re-importing produces identical rawHashes (dedupe via imported_from survives the share-dist remap)', () => {
    // The rawHash includes the synthesized price, but the synthesis is a pure
    // function of the row's (amount, quantity), so two imports of the same CSV
    // text produce identical rawHashes for the share-distribution row. The DB
    // insertTransactions() uses imported_from = rawHash for dedupe.
    const r1 = importCsv(SHARE_DISTRIBUTION);
    const r2 = importCsv(SHARE_DISTRIBUTION);
    expect(r1.transactions.length).toBe(r2.transactions.length);
    for (let i = 0; i < r1.transactions.length; i++) {
      expect(r1.transactions[i].rawHash).toBe(r2.transactions[i].rawHash);
    }
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

  it('does NOT match a generic CSV with matching headers but no JPM markers', () => {
    // Before the fix, jpmorgan.matches() ended in `return looksLikeJpm || true`
    // so any CSV with the four base headers (Trade Date / Transaction Type /
    // Symbol / Net Amount) was claimed by JPM regardless of brokerage. The
    // fix requires either a Settle Date column or "J.P. Morgan" in the row
    // description. A synthetic Charles Schwab Bank CSV with the four base
    // headers should fall through to no-match so the column-mapping wizard
    // can take over instead of being silently parsed as JPM.
    const SYNTHETIC = `Trade Date,Transaction Type,Symbol,Net Amount,Description
2024-08-15,Purchase,VTI,-3750.00,Charles Schwab Bank · funds settlement
2024-08-01,Dividend,VTI,32.40,Charles Schwab Bank · cash dividend`;
    const { importer } = detect(SYNTHETIC);
    expect(importer).toBeNull();
    const result = importCsv(SYNTHETIC);
    expect(result.importerId).toBeNull();
    expect(result.transactions).toHaveLength(0);
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
