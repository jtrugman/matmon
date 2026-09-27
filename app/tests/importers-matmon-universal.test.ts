// Matmon Universal CSV importer specs.
//
// The universal template is the beta-unlock fallback for brokerages we don't
// have a native importer for (Human Interest 401(k) is the canonical use
// case). These specs cover:
//   1. Header detection (positive + negative)
//   2. Multi-account grouping into accountsDetected
//   3. All 12 supported action values normalize correctly
//   4. Empty / unknown action rows are skipped with a warning
//   5. Date parsing handles ISO, US, and UK formats
//   6. Signed-amount handling doesn't double-negate cash_out / sell rows
//   7. rowHash includes the account so two accounts' identical-looking rows
//      don't collide on dedupe
//   8. Round-trip parse -> insert -> buildPortfolio reconstructs holdings
//
// If any spec fails the bug is in production code, not the test.

import { describe, expect, it } from 'vitest';
import { detect, importCsv } from '../src/lib/importers';
import { matmonUniversalImporter } from '../src/lib/importers/matmonUniversal';
import { upsertAccountByFingerprint, insertTransactions } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';

const TEMPLATE_HEADER =
  'Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Brokerage,Account Type,Currency,Notes';

const SIMPLE_TEMPLATE = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,Vanguard S&P 500 ETF,5,440.50,2202.50,0.00,My Retirement 401k,Human Interest,trad_401k,USD,
2024-02-10,contribution,,,,,500.00,,My Retirement 401k,Human Interest,trad_401k,USD,Bi-weekly contribution
2024-03-15,dividend,VOO,Vanguard S&P 500 ETF,,,4.85,,My Retirement 401k,Human Interest,trad_401k,USD,Q1 dividend
2024-04-01,transfer_in,VTI,Vanguard Total Stock,12,225.00,2700.00,,My Brokerage,Custom,taxable,USD,Initial transfer
`;

describe('Matmon Universal importer · header detection', () => {
  it('claims a file with the canonical template header', () => {
    const { importer } = detect(SIMPLE_TEMPLATE);
    expect(importer?.id).toBe('matmonUniversal');
  });

  it('matches case-insensitively (lowercase headers)', () => {
    const lower = SIMPLE_TEMPLATE.replace(TEMPLATE_HEADER, TEMPLATE_HEADER.toLowerCase());
    const { importer } = detect(lower);
    expect(importer?.id).toBe('matmonUniversal');
  });

  it('does NOT claim a file missing required columns (no Brokerage)', () => {
    const missing = `Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Account Type,Currency,Notes
2024-01-15,buy,VOO,Vanguard,5,440,2200,0,Acc,trad_401k,USD,`;
    const { importer } = detect(missing);
    expect(importer?.id).not.toBe('matmonUniversal');
  });

  it('does NOT claim a file missing required columns (no Account)', () => {
    const missing = `Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Brokerage,Account Type,Currency,Notes
2024-01-15,buy,VOO,Vanguard,5,440,2200,0,Human Interest,trad_401k,USD,`;
    const { importer } = detect(missing);
    expect(importer?.id).not.toBe('matmonUniversal');
  });

  it('does not crash when matching against a Fidelity-shaped file', () => {
    const fidelity = `Run Date,Action,Symbol,Description,Quantity,Price ($),Amount ($)
05/02/2026,YOU BOUGHT,VOO,VANGUARD,4,556.18,-2224.72`;
    const { importer } = detect(fidelity);
    expect(importer?.id).not.toBe('matmonUniversal');
  });
});

describe('Matmon Universal importer · single-account parse', () => {
  const result = importCsv(SIMPLE_TEMPLATE);

  it('parses 4 transactions (3 mapped + 1 transfer)', () => {
    expect(result.transactions).toHaveLength(4);
  });

  it('records the dominant brokerage in inferences', () => {
    // 3 rows say Human Interest, 1 row says Custom; Human Interest wins.
    expect(result.inferences.brokerage).toBe('Human Interest');
  });

  it('classifies buy / contribution / dividend / transfer_in correctly', () => {
    const byAction = result.transactions.reduce<Record<string, number>>((acc, t) => {
      acc[t.action] = (acc[t.action] || 0) + 1;
      return acc;
    }, {});
    expect(byAction.buy).toBe(1);
    expect(byAction.cash_in).toBe(1); // contribution -> cash_in
    expect(byAction.dividend).toBe(1);
    expect(byAction.transfer_in).toBe(1);
  });

  it('multi-brokerage single-file splits into multiple detected accounts', () => {
    // SIMPLE_TEMPLATE has two distinct (Brokerage, Account) buckets:
    //   Human Interest / My Retirement 401k (3 rows)
    //   Custom / My Brokerage (1 row)
    // Both buckets should surface in accountsDetected.
    expect(result.accountsDetected).toBeDefined();
    expect(result.accountsDetected!).toHaveLength(2);
    const names = result.accountsDetected!.map(a => a.name).sort();
    expect(names).toEqual(['My Brokerage', 'My Retirement 401k']);
  });
});

describe('Matmon Universal importer · all 12 supported actions', () => {
  // One row per supported action. Every row should land in transactions
  // (with friendly-name normalization for contribution / withdrawal).
  const ALL_ACTIONS = `${TEMPLATE_HEADER}
2024-01-01,buy,VOO,,1,100,100,0,Acc,Custom,taxable,USD,
2024-01-02,sell,VOO,,1,110,110,0,Acc,Custom,taxable,USD,
2024-01-03,dividend,VOO,,,,5,,Acc,Custom,taxable,USD,
2024-01-04,interest,,,,,2,,Acc,Custom,taxable,USD,
2024-01-05,div_reinvest,VOO,,0.05,100,5,,Acc,Custom,taxable,USD,
2024-01-06,cash_in,,,,,500,,Acc,Custom,taxable,USD,
2024-01-07,cash_out,,,,,-100,,Acc,Custom,taxable,USD,
2024-01-08,contribution,,,,,500,,Acc,Custom,taxable,USD,
2024-01-09,withdrawal,,,,,-100,,Acc,Custom,taxable,USD,
2024-01-10,transfer_in,VTI,,5,200,1000,,Acc,Custom,taxable,USD,
2024-01-11,transfer_out,VTI,,2,200,400,,Acc,Custom,taxable,USD,
2024-01-12,fee,,,,,-5,,Acc,Custom,taxable,USD,
`;

  const result = importCsv(ALL_ACTIONS);

  it('parses every supported action', () => {
    expect(result.transactions).toHaveLength(12);
    expect(result.inferences.actionsUnknown).toBe(0);
  });

  it('normalizes contribution -> cash_in', () => {
    const tx = result.transactions.find(t => t.notes === '' && +t.date === Date.UTC(2024, 0, 8));
    expect(tx?.action).toBe('cash_in');
  });

  it('normalizes withdrawal -> cash_out', () => {
    const tx = result.transactions.find(t => +t.date === Date.UTC(2024, 0, 9));
    expect(tx?.action).toBe('cash_out');
  });

  it('preserves the other 10 action strings verbatim', () => {
    const expected: Array<[number, string]> = [
      [1, 'buy'],
      [2, 'sell'],
      [3, 'dividend'],
      [4, 'interest'],
      [5, 'div_reinvest'],
      [6, 'cash_in'],
      [7, 'cash_out'],
      [10, 'transfer_in'],
      [11, 'transfer_out'],
      [12, 'fee'],
    ];
    for (const [day, action] of expected) {
      const tx = result.transactions.find(t => +t.date === Date.UTC(2024, 0, day));
      expect(tx?.action, `day ${day}`).toBe(action);
    }
  });
});

describe('Matmon Universal importer · unknown / empty action handling', () => {
  it('skips rows with an unknown action and warns', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,purchase,VOO,Bad action,5,440,2200,0,Acc,Custom,taxable,USD,
2024-01-16,buy,VOO,Good row,5,440,2200,0,Acc,Custom,taxable,USD,
`;
    const result = importCsv(csv);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].symbol).toBe('VOO');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => /unknown action/i.test(w))).toBe(true);
    expect(result.unmappedActionStrings).toContain('purchase');
  });

  it('skips rows with an empty action and warns', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,,VOO,Missing action,5,440,2200,0,Acc,Custom,taxable,USD,
2024-01-16,buy,VOO,Good row,5,440,2200,0,Acc,Custom,taxable,USD,
`;
    const result = importCsv(csv);
    expect(result.transactions).toHaveLength(1);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => /missing action/i.test(w))).toBe(true);
  });

  it('skips rows with an unparseable date and warns', () => {
    const csv = `${TEMPLATE_HEADER}
not-a-date,buy,VOO,Bad date,5,440,2200,0,Acc,Custom,taxable,USD,
2024-01-16,buy,VTI,Good row,5,200,1000,0,Acc,Custom,taxable,USD,
`;
    const result = importCsv(csv);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].symbol).toBe('VTI');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => /could not parse date/i.test(w))).toBe(true);
  });
});

describe('Matmon Universal importer · date format handling', () => {
  it('parses ISO YYYY-MM-DD', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,`;
    const r = importCsv(csv);
    expect(+r.transactions[0].date).toBe(Date.UTC(2024, 0, 15));
  });

  it('parses US M/D/YYYY', () => {
    const csv = `${TEMPLATE_HEADER}
1/15/2024,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,`;
    const r = importCsv(csv);
    expect(+r.transactions[0].date).toBe(Date.UTC(2024, 0, 15));
  });

  it('parses MM/DD/YYYY with leading zeros', () => {
    const csv = `${TEMPLATE_HEADER}
01/15/2024,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,`;
    const r = importCsv(csv);
    expect(+r.transactions[0].date).toBe(Date.UTC(2024, 0, 15));
  });

  // UK DD/MM/YYYY is the gotcha: the shared parseDate uses M/D heuristics
  // (it cannot distinguish "15/01/2024" UK from "15/01/2024" US since the
  // first token is > 12, which doesn't fit M/D). Verifies the importer
  // surfaces a date for those rows rather than dropping them silently.
  it('handles DD/MM/YYYY by falling through to Date constructor (not silently dropped)', () => {
    const csv = `${TEMPLATE_HEADER}
15/01/2024,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,`;
    const r = importCsv(csv);
    // Either the row is parsed (some heuristic kicked in) or it's skipped
    // with a warning. The contract is that it doesn't crash and doesn't
    // silently disappear.
    if (r.transactions.length === 0) {
      expect(r.warnings).toBeDefined();
      expect(r.warnings!.some(w => /date/i.test(w))).toBe(true);
    } else {
      // Date constructor in this case will produce something parseable;
      // we only assert it's a valid Date (not NaN), regardless of which
      // exact interpretation it picked. This documents the current behavior
      // and lets us notice if parseDate's heuristics regress.
      expect(isNaN(+r.transactions[0].date)).toBe(false);
    }
  });
});

describe('Matmon Universal importer · signed amount handling', () => {
  it('preserves negative amount on cash_out without double-negating', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,cash_out,,,,,-500.00,,Acc,Custom,taxable,USD,
`;
    const r = importCsv(csv);
    expect(r.transactions[0].amount).toBe(-500);
  });

  it('preserves positive amount on cash_in', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,cash_in,,,,,500.00,,Acc,Custom,taxable,USD,
`;
    const r = importCsv(csv);
    expect(r.transactions[0].amount).toBe(500);
  });

  it('leaves Amount as null when the column is blank (buy with implied amount)', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,,0,Acc,Custom,taxable,USD,
`;
    const r = importCsv(csv);
    expect(r.transactions[0].amount).toBeNull();
    expect(r.transactions[0].quantity).toBe(5);
    expect(r.transactions[0].price).toBe(440);
  });
});

describe('Matmon Universal importer · rowHash uniqueness across accounts', () => {
  it('two accounts with identical-looking rows get distinct rawHash values', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Account A,Custom,taxable,USD,
2024-01-15,buy,VOO,,5,440,2200,0,Account B,Custom,taxable,USD,
`;
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0].rawHash).not.toBe(r.transactions[1].rawHash);
  });

  it('within a single account, the rawHash is stable and unique per row', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,
2024-02-15,buy,VOO,,5,440,2200,0,Acc,Custom,taxable,USD,
`;
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0].rawHash).not.toBe(r.transactions[1].rawHash);
    // Re-parse: hash should be deterministic.
    const r2 = importCsv(csv);
    expect(r2.transactions[0].rawHash).toBe(r.transactions[0].rawHash);
    expect(r2.transactions[1].rawHash).toBe(r.transactions[1].rawHash);
  });
});

describe('Matmon Universal importer · account-type normalization', () => {
  it('trad_401k -> 401k internally', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,trad_401k,USD,
`;
    const r = importCsv(csv);
    expect(r.inferences.accountType).toBe('401k');
  });

  it('roth_401k -> 401k internally', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,roth_401k,USD,
`;
    const r = importCsv(csv);
    expect(r.inferences.accountType).toBe('401k');
  });

  it('529 -> other internally', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,529,USD,
`;
    const r = importCsv(csv);
    expect(r.inferences.accountType).toBe('other');
  });

  it('brokerage -> taxable internally', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Acc,Custom,brokerage,USD,
`;
    const r = importCsv(csv);
    expect(r.inferences.accountType).toBe('taxable');
  });
});

describe('Matmon Universal importer · round-trip parse to portfolio', () => {
  // Smoke test the full pipeline: parse the template, insert into the DB,
  // rebuild the portfolio, and assert per-symbol qty/cost reflect the rows.
  it('Human Interest 401(k) template reconstructs holdings correctly', async () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,Vanguard S&P 500,5,440.50,2202.50,0,My 401k,Human Interest,trad_401k,USD,
2024-02-15,buy,VOO,Vanguard S&P 500,3,450.00,1350.00,0,My 401k,Human Interest,trad_401k,USD,
2024-03-15,dividend,VOO,Vanguard S&P 500,,,4.85,,My 401k,Human Interest,trad_401k,USD,
`;
    const result = importCsv(csv);
    expect(result.transactions).toHaveLength(3);

    // Single-account file -> accountsDetected is undefined, so insert under
    // a synthesized account row keyed by (brokerage, name).
    const { id: accountId } = await upsertAccountByFingerprint(
      {
        id: 'matmon-universal-test-401k',
        name: 'My 401k',
        brokerage: 'Human Interest',
        account_type: '401k',
        currency: 'USD',
        created_at: Date.now(),
      },
      '',
    );
    await insertTransactions(accountId, result.transactions);

    const portfolio = await buildPortfolio();
    // Holdings carry per-(account, symbol) lots; sum the VOO row for our
    // single test account.
    const vooLots = portfolio.holdings.filter(h => h.sym === 'VOO');
    expect(vooLots.length).toBeGreaterThan(0);
    const totalQty = vooLots.reduce((a, h) => a + h.qty, 0);
    const totalCost = vooLots.reduce((a, h) => a + h.cost, 0);
    // qty = 5 + 3 = 8 (dividend rows don't add to qty)
    expect(totalQty).toBeCloseTo(8, 6);
    // cost = 5 * 440.50 + 3 * 450.00 = 2202.50 + 1350.00 = 3552.50
    expect(totalCost).toBeCloseTo(3552.5, 2);
  });

  it('multi-account template splits per accountsDetected with disjoint rowHashes', () => {
    const csv = `${TEMPLATE_HEADER}
2024-01-15,buy,VOO,,5,440,2200,0,Account A,Custom,taxable,USD,
2024-01-15,buy,VTI,,10,200,2000,0,Account B,Custom,trad_ira,USD,
`;
    const result = importCsv(csv);
    expect(result.accountsDetected).toBeDefined();
    expect(result.accountsDetected!).toHaveLength(2);

    // Each detected account carries its own txn slice.
    const a = result.accountsDetected!.find(x => x.name === 'Account A')!;
    const b = result.accountsDetected!.find(x => x.name === 'Account B')!;
    expect(a.transactions).toHaveLength(1);
    expect(b.transactions).toHaveLength(1);
    expect(a.transactions[0].symbol).toBe('VOO');
    expect(b.transactions[0].symbol).toBe('VTI');
    // accountTypeHint is normalized
    expect(a.accountTypeHint).toBe('taxable');
    expect(b.accountTypeHint).toBe('trad_ira');
  });
});

describe('Matmon Universal importer · matches() unit', () => {
  it('matches() returns true for the canonical header set', () => {
    const headers = TEMPLATE_HEADER.split(',');
    expect(matmonUniversalImporter.matches(headers, {})).toBe(true);
  });

  it('matches() returns false when "amount" is missing', () => {
    const headers = ['Date', 'Action', 'Symbol', 'Account', 'Brokerage'];
    expect(matmonUniversalImporter.matches(headers, {})).toBe(false);
  });
});
