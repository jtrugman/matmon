// Real-file fixture coverage for every brokerage importer.
//
// The CSV samples live in src/lib/importers/__fixtures__/<importer>/ so they
// can be opened, diffed, and inspected like real broker exports. This spec
// loads each fixture from disk, runs it through importCsv(), and validates
// the importer claims it, parses non-zero rows, and dedupes on re-import.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCsv } from '../src/lib/importers';
import { insertAccount, insertTransactions } from '../src/lib/db/repos';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', 'src', 'lib', 'importers', '__fixtures__');

function loadFixture(importer: string, name: string): string {
  return readFileSync(resolve(fixturesDir, importer, `${name}.csv`), 'utf8');
}

type Case = {
  dir: string;
  importerId: string;
  brokerage: string;
  accountType: string;
};

const CASES: Case[] = [
  { dir: 'fidelity',      importerId: 'fidelity',      brokerage: 'Fidelity',       accountType: 'taxable'  },
  { dir: 'schwab',        importerId: 'schwab',        brokerage: 'Charles Schwab', accountType: 'roth_ira' },
  { dir: 'jpmorgan',      importerId: 'jpmorgan',      brokerage: 'JP Morgan',      accountType: 'taxable'  },
  { dir: 'jpmHoldings',   importerId: 'jpmHoldings',   brokerage: 'JP Morgan',      accountType: 'taxable'  },
  { dir: 'humanInterest', importerId: 'humanInterest', brokerage: 'Human Interest', accountType: '401k'     },
];

async function makeAccount(id: string, brokerage: string, accountType: string) {
  await insertAccount({
    id,
    name: `Test ${brokerage}`,
    brokerage,
    account_type: accountType,
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
}

describe('CSV fixtures: every importer claims its own samples', () => {
  for (const c of CASES) {
    describe(`${c.importerId}`, () => {
      it('detects basic.csv and parses every row with no unmapped actions', () => {
        const csv = loadFixture(c.dir, 'basic');
        const result = importCsv(csv);

        expect(result.importerId).toBe(c.importerId);
        expect(result.transactions.length).toBeGreaterThan(0);
        expect(result.unmappedActionStrings).toEqual([]);
        expect(result.inferences.actionsUnknown).toBe(0);
      });

      it('detects realistic.csv and parses more than 50 transactions', () => {
        const csv = loadFixture(c.dir, 'realistic');
        const result = importCsv(csv);

        expect(result.importerId).toBe(c.importerId);
        expect(result.transactions.length).toBeGreaterThan(50);
        expect(result.inferences.uniqueSymbols).toBeGreaterThan(0);
      });

      it('re-importing basic.csv into the same account is fully deduped', async () => {
        const accountId = `${c.importerId}-basic`;
        await makeAccount(accountId, c.brokerage, c.accountType);
        const parsed = importCsv(loadFixture(c.dir, 'basic'));
        expect(parsed.transactions.length).toBeGreaterThan(0);

        const first = await insertTransactions(accountId, parsed.transactions);
        expect(first.inserted).toBe(parsed.transactions.length);
        expect(first.skipped).toBe(0);

        const second = await insertTransactions(accountId, parsed.transactions);
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(parsed.transactions.length);
      });

      it('re-importing realistic.csv into the same account is fully deduped', async () => {
        const accountId = `${c.importerId}-realistic`;
        await makeAccount(accountId, c.brokerage, c.accountType);
        const parsed = importCsv(loadFixture(c.dir, 'realistic'));
        expect(parsed.transactions.length).toBeGreaterThan(50);

        const first = await insertTransactions(accountId, parsed.transactions);
        expect(first.inserted).toBe(parsed.transactions.length);
        expect(first.skipped).toBe(0);

        const second = await insertTransactions(accountId, parsed.transactions);
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(parsed.transactions.length);
      });
    });
  }
});
