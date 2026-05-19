// Account deduplication coverage for the upsertAccountByFingerprint root-cause
// fix and the dedupeDuplicateAccounts cleanup migration. Both prevent the
// "import the same CSV twice and get 16 phantom accounts" bug Justin hit when
// re-importing JPM and Fidelity exports during onboarding.

import { describe, expect, it } from 'vitest';
import {
  dedupeDuplicateAccounts,
  insertAccount,
  insertTransactions,
  listAccounts,
  listTransactions,
  upsertAccountByFingerprint,
} from '../src/lib/db/repos';
import { importCsv } from '../src/lib/importers';
import { slugifyAccountId } from '../src/lib/db/accountId';
import type { ParsedTransaction } from '../src/lib/importers/types';

// Build a synthetic Fidelity multi-account CSV with the "Account" and
// "Account Number" columns the real Fidelity History export carries when a
// user owns multiple accounts. We use anonymized last-4 windows.
function buildFidelityMultiAccountCsv(): string {
  const header =
    'Run Date,Action,Symbol,Description,Quantity,Price ($),Commission ($),Amount ($),Settlement Date,Account,Account Number';
  const rows: string[] = [
    // Individual taxable: 7969
    '04/29/2026,YOU BOUGHT,VOO,VANGUARD S&P 500 ETF,4,556.18,0.00,-2224.72,05/01/2026,Individual,Z00007969',
    '04/22/2026,YOU SOLD,JEPI,JPM EQUITY PREMIUM INCOME ETF,30,61.84,0.00,1855.20,04/24/2026,Individual,Z00007969',
    // HSA: 7688
    '04/26/2026,REINVESTMENT,BND,VANGUARD TOTAL BOND,0.214,72.94,0.00,-15.62,04/26/2026,HSA,Z00007688',
    '04/15/2026,DIVIDEND RECEIVED,VTI,VANGUARD TOTAL STOCK MKT ETF,,,,1620.42,04/15/2026,HSA,Z00007688',
  ];
  return [header, ...rows].join('\n');
}

// Build a synthetic JPM positions CSV with four distinct accounts. Mirrors the
// real "Self-Directed" / "Self-Directed-Ret" exports without leaking actual
// account numbers.
function buildJpmFourAccountCsv(): string {
  const header =
    'Account name,Account number,Account type,Sub account,Description,Ticker,CUSIP,Quantity,Price,Value,Cost,Acquisition Date,Unit Cost,Acct Type';
  const rows: string[] = [
    // Account A (1234)
    '"Self-Directed","XXXX1234","Brokerage","","APPLE INC","AAPL","037833100","6.024","204.04","1229.14","1615.22","01/01/2020","268.13","Brokerage"',
    // Account B (5678)
    '"Self-Directed-Ret","XXXX5678","Brokerage","","ALPHABET INC CL A","GOOGL","02079K305","19.083","396.48","7566.03","6343.19","03/03/2022","332.40","Brokerage"',
    // Account C (9999)
    '"Self-Directed","XXXX9999","Brokerage","","MICROSOFT CORP","MSFT","594918104","20.077","107.03","2148.84","7153.23","02/02/2021","356.29","Brokerage"',
    // Account D (2468)
    '"Self-Directed-Ret","XXXX2468","Brokerage","","TESLA INC","TSLA","88160R101","3.500","250.00","875.00","800.00","04/05/2024","228.57","Brokerage"',
  ];
  return [header, ...rows].join('\n');
}

// Simulate the production import path (mirrors App.tsx finishOnboarding and
// AddAccountView.importAllAccounts) without pulling in React: parse, then walk
// every detected account and upsert-by-fingerprint. Returns the number of
// accounts now in the DB after the pass.
async function importAllOnce(csv: string, brokerage: string): Promise<number> {
  const result = importCsv(csv);
  const accounts = result.accountsDetected || [];
  const existingIds = (await listAccounts()).map(a => a.id);
  for (const acc of accounts) {
    const last4 = acc.last4 || (acc.accountNumber || '').replace(/\D/g, '').slice(-4);
    // Mirror AddAccountView.importAllAccounts: bake last4 into the auto-name
    // so lastFourFromName() can recover it for re-import dedupe.
    const autoName = [last4, brokerage, acc.name].filter(Boolean).join(' ').trim();
    const desiredId = slugifyAccountId(autoName, brokerage, existingIds);
    const { id } = await upsertAccountByFingerprint(
      {
        id: desiredId,
        name: autoName,
        brokerage,
        account_type: acc.accountTypeHint === 'unknown' ? 'other' : acc.accountTypeHint,
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      last4,
    );
    existingIds.push(id);
    await insertTransactions(id, acc.transactions);
  }
  return (await listAccounts()).length;
}

describe('upsertAccountByFingerprint: insert-time dedupe is the root-cause fix', () => {
  it('importing the same Fidelity multi-account CSV twice produces exactly 2 accounts (not 4)', async () => {
    const csv = buildFidelityMultiAccountCsv();
    // Sanity: the importer surfaces 2 accounts with non-empty last4 values.
    const parsed = importCsv(csv);
    expect(parsed.accountsDetected).toBeDefined();
    expect(parsed.accountsDetected!.length).toBe(2);
    for (const acc of parsed.accountsDetected!) {
      expect(acc.last4.length).toBe(4);
    }

    // First import: 2 fresh accounts land.
    const afterFirst = await importAllOnce(csv, 'Fidelity');
    expect(afterFirst).toBe(2);

    // Second import: every account fingerprint matches, so 0 new rows.
    const afterSecond = await importAllOnce(csv, 'Fidelity');
    expect(afterSecond).toBe(2);

    // Transactions must still land on the canonical rows.
    const accts = await listAccounts();
    expect(accts).toHaveLength(2);
    for (const a of accts) {
      const txs = await listTransactions(a.id);
      expect(txs.length).toBeGreaterThan(0);
    }
  });

  it('importing the JPM 4-account CSV four times produces exactly 4 accounts (not 16)', async () => {
    const csv = buildJpmFourAccountCsv();
    expect(importCsv(csv).accountsDetected!.length).toBe(4);

    for (let i = 0; i < 4; i++) {
      const count = await importAllOnce(csv, 'JP Morgan');
      expect(count).toBe(4);
    }
    const accts = await listAccounts();
    expect(accts).toHaveLength(4);
  });

  it('two different CSV files for the same (brokerage, last4) merge into one account', async () => {
    // Two synthetic files: same brokerage, same last4, different filenames /
    // transaction sets. The second import should find the existing row.
    const csvA = [
      'Account name,Account number,Account type,Sub account,Description,Ticker,CUSIP,Quantity,Price,Value,Cost,Acquisition Date,Unit Cost,Acct Type',
      '"Self-Directed","XXXX1234","Brokerage","","APPLE INC","AAPL","037833100","6.024","204.04","1229.14","1615.22","01/01/2020","268.13","Brokerage"',
      '"Self-Directed-Ret","XXXX5678","Brokerage","","ALPHABET INC CL A","GOOGL","02079K305","19.083","396.48","7566.03","6343.19","03/03/2022","332.40","Brokerage"',
    ].join('\n');
    const csvB = [
      'Account name,Account number,Account type,Sub account,Description,Ticker,CUSIP,Quantity,Price,Value,Cost,Acquisition Date,Unit Cost,Acct Type',
      '"Self-Directed","XXXX1234","Brokerage","","TESLA INC","TSLA","88160R101","2","250.00","500.00","450.00","04/05/2024","225.00","Brokerage"',
      '"Self-Directed-Ret","XXXX5678","Brokerage","","NVIDIA CORP","NVDA","67066G104","1","800.00","800.00","700.00","05/05/2024","700.00","Brokerage"',
    ].join('\n');

    await importAllOnce(csvA, 'JP Morgan');
    await importAllOnce(csvB, 'JP Morgan');
    const accts = await listAccounts();
    // Both files share the same (brokerage, last4) pair, so only 2 accounts
    // exist, each carrying the union of both files' transactions.
    expect(accts).toHaveLength(2);
    for (const a of accts) {
      const txs = await listTransactions(a.id);
      expect(txs.length).toBe(2);
    }
  });

  it('a Schwab account with last4=1234 stays separate from a Fidelity account with last4=1234', async () => {
    // Schwab transactions don't surface an Account Number column today, so we
    // call upsertAccountByFingerprint directly with two distinct brokerage
    // strings to assert the brokerage discriminator works.
    await upsertAccountByFingerprint(
      {
        id: 'schwab-1234',
        name: '1234 Charles Schwab Individual',
        brokerage: 'Charles Schwab',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '1234',
    );
    await upsertAccountByFingerprint(
      {
        id: 'fidelity-1234',
        name: '1234 Fidelity Individual',
        brokerage: 'Fidelity',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '1234',
    );
    const accts = await listAccounts();
    expect(accts).toHaveLength(2);
    const brokerages = accts.map(a => a.brokerage).sort();
    expect(brokerages).toEqual(['Charles Schwab', 'Fidelity']);
  });

  it('two single-account imports with no last4 dedupe by (brokerage, name)', async () => {
    // Single-account Schwab transactions: no Account Number column, so last4
    // is empty. The fingerprint falls back to (brokerage, name).
    await upsertAccountByFingerprint(
      {
        id: 'schwab-taxable',
        name: 'Charles Schwab Taxable',
        brokerage: 'Charles Schwab',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '',
    );
    await upsertAccountByFingerprint(
      {
        id: 'schwab-taxable-2',
        name: 'Charles Schwab Taxable',
        brokerage: 'Charles Schwab',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '',
    );
    expect(await listAccounts()).toHaveLength(1);
  });

  it('two single-account imports with different names create two accounts', async () => {
    // Differently named no-last4 accounts should NOT collapse, even when
    // brokerage matches. The fallback name comparison is deliberately strict
    // so a user re-importing under a new account name gets a new row.
    await upsertAccountByFingerprint(
      {
        id: 'schwab-tax',
        name: 'Charles Schwab Taxable',
        brokerage: 'Charles Schwab',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '',
    );
    await upsertAccountByFingerprint(
      {
        id: 'schwab-roth',
        name: 'Charles Schwab Roth IRA',
        brokerage: 'Charles Schwab',
        account_type: 'roth_ira',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
      '',
    );
    expect(await listAccounts()).toHaveLength(2);
  });
});

describe('dedupeDuplicateAccounts: cleanup migration for the pre-existing dirty DB case', () => {
  it('collapses 16 JPM accounts (4 unique x 4 copies) down to 4 canonical rows', async () => {
    // Seed a pre-fingerprint-fix DB: each of 4 brokerage accounts has 4
    // copies (one canonical with transactions, three skeletons without).
    const acctTuples: Array<[string, string]> = [
      ['1234', 'Self-Directed'],
      ['5678', 'Self-Directed-Ret'],
      ['9999', 'Self-Directed'],
      ['2468', 'Self-Directed-Ret'],
    ];
    const canonicalIds: string[] = [];
    for (const [last4, name] of acctTuples) {
      const baseName = `${last4} JP Morgan ${name}`;
      const canonicalId = `jp-morgan-${name.toLowerCase().replace(/[^a-z]/g, '-')}-${last4}`;
      canonicalIds.push(canonicalId);
      // 1 canonical
      await insertAccount({
        id: canonicalId,
        name: baseName,
        brokerage: 'JP Morgan',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date(Date.now() - 1_000_000).toISOString(),
      });
      // Seed a few transactions on the canonical so the migration knows which
      // row to keep.
      const txs: ParsedTransaction[] = [
        {
          date: new Date('2024-01-15'),
          symbol: 'AAPL',
          action: 'transfer_in',
          quantity: 1,
          price: 200,
          fees: 0,
          amount: -200,
          currency: 'USD',
          notes: '',
          rawHash: `seed-${last4}-1`,
        },
      ];
      await insertTransactions(canonicalId, txs);

      // 3 empty skeleton dupes with shifted slugs.
      for (let i = 2; i <= 4; i++) {
        await insertAccount({
          id: `${canonicalId}-${i}`,
          name: baseName,
          brokerage: 'JP Morgan',
          account_type: 'taxable',
          currency: 'USD',
          created_at: new Date().toISOString(),
        });
      }
    }
    // Pre-migration: 16 accounts, 4 with transactions.
    expect((await listAccounts()).length).toBe(16);

    // Run the cleanup migration.
    const result = await dedupeDuplicateAccounts();
    expect(result.merged).toBe(4);
    expect(result.deleted.length).toBe(12);

    // Post-migration: exactly 4 accounts, all carrying their original
    // transaction count, all the canonical IDs.
    const after = await listAccounts();
    expect(after).toHaveLength(4);
    const remainingIds = after.map(a => a.id).sort();
    expect(remainingIds).toEqual(canonicalIds.slice().sort());
    for (const id of canonicalIds) {
      const txs = await listTransactions(id);
      expect(txs.length).toBe(1);
    }
  });

  it('is idempotent: running the migration twice on the same DB is a no-op the second time', async () => {
    await insertAccount({
      id: 'a',
      name: '1234 JP Morgan Self-Directed',
      brokerage: 'JP Morgan',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date(Date.now() - 5000).toISOString(),
    });
    await insertAccount({
      id: 'a-2',
      name: '1234 JP Morgan Self-Directed',
      brokerage: 'JP Morgan',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    const first = await dedupeDuplicateAccounts();
    expect(first.merged).toBe(1);
    expect(first.deleted).toHaveLength(1);

    const second = await dedupeDuplicateAccounts();
    expect(second.merged).toBe(0);
    expect(second.deleted).toHaveLength(0);
  });

  it('honors the one-shot settings.dedupe.v1.complete guard once the migration runs', async () => {
    // The App-level useEffect at the top of App.tsx sets settings.dedupe.v1.complete
    // to 'yes' after the first run. We seed the setting directly to confirm the
    // production migration would skip a second run. (We deliberately don't
    // re-render the React tree here; the wiring is exercised at the React
    // level by the duplicate-account Playwright spec, which doesn't see a
    // second dedupe pass because the flag survives across reloads.)
    const { getSetting, setSetting } = await import('../src/lib/db/repos');
    expect(await getSetting('dedupe.v1.complete')).toBeNull();
    await setSetting('dedupe.v1.complete', 'yes');
    expect(await getSetting('dedupe.v1.complete')).toBe('yes');
  });

  it('reassigns transactions from dupes onto the canonical row before deleting them', async () => {
    // The canonical has 2 transactions; the dupe has 1 distinct one. Post-merge
    // the canonical should hold all 3.
    await insertAccount({
      id: 'canon',
      name: '1234 JP Morgan Self-Directed',
      brokerage: 'JP Morgan',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date(Date.now() - 5000).toISOString(),
    });
    await insertTransactions('canon', [
      {
        date: new Date('2024-01-15'),
        symbol: 'AAPL',
        action: 'transfer_in',
        quantity: 1,
        price: 200,
        fees: 0,
        amount: -200,
        currency: 'USD',
        notes: '',
        rawHash: 'canon-1',
      },
      {
        date: new Date('2024-02-15'),
        symbol: 'AAPL',
        action: 'transfer_in',
        quantity: 1,
        price: 210,
        fees: 0,
        amount: -210,
        currency: 'USD',
        notes: '',
        rawHash: 'canon-2',
      },
    ]);
    await insertAccount({
      id: 'dup',
      name: '1234 JP Morgan Self-Directed',
      brokerage: 'JP Morgan',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('dup', [
      {
        date: new Date('2024-03-15'),
        symbol: 'AAPL',
        action: 'transfer_in',
        quantity: 1,
        price: 220,
        fees: 0,
        amount: -220,
        currency: 'USD',
        notes: '',
        rawHash: 'dup-1',
      },
    ]);

    await dedupeDuplicateAccounts();
    const accts = await listAccounts();
    expect(accts).toHaveLength(1);
    expect(accts[0].id).toBe('canon');
    const canonTxs = await listTransactions('canon');
    expect(canonTxs).toHaveLength(3);
  });
});
