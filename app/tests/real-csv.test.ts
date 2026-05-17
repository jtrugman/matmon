// Smoke tests against the real brokerage exports a user dropped into
// example_csv/. The directory is gitignored, so CI machines that don't have
// the files just skip these tests cleanly with a console note.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCsv } from '../src/lib/importers';

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = resolve(here, '..', 'example_csv');

const FILES = {
  singleFidelity: resolve(exampleDir, 'single_account_fidelity.csv'),
  multiFidelity: resolve(exampleDir, 'multiple_accounts_fidelity.csv'),
  schwabBalances: resolve(exampleDir, 'schwab_single_account.CSV'),
  schwabTransactions: resolve(exampleDir, 'single_scwab_transactions.csv'),
  jpmHoldings: resolve(exampleDir, 'jpm_multiple_accounts.csv'),
};

const haveExamples = existsSync(FILES.singleFidelity);
const haveSchwabTransactions = existsSync(FILES.schwabTransactions);
const haveJpmHoldings = existsSync(FILES.jpmHoldings);

if (!haveExamples) {
  // eslint-disable-next-line no-console
  console.info('[real-csv.test] example_csv/ not present, skipping real-CSV smoke tests.');
}

(haveExamples ? describe : describe.skip)('real brokerage CSVs', () => {
  it('single_account_fidelity.csv: detects as Fidelity, parses rows, no unmapped actions', () => {
    const result = importCsv(readFileSync(FILES.singleFidelity, 'utf8'));
    expect(result.importerId).toBe('fidelity');
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.unmappedActionStrings).toEqual([]);
    expect(result.inferences.actionsUnknown).toBe(0);
    // Single-account exports must NOT trigger the multi-account picker.
    expect(result.accountsDetected).toBeUndefined();
    expect(result.rejectionReason).toBeUndefined();
  });

  it('single_account_fidelity.csv: cash-transfer rows with literal-space Symbol become null', () => {
    const result = importCsv(readFileSync(FILES.singleFidelity, 'utf8'));
    // The "Electronic Funds Transfer Received" rows have Symbol=" " in the file.
    const efts = result.transactions.filter(t => t.action === 'cash_in');
    expect(efts.length).toBeGreaterThan(0);
    for (const t of efts) expect(t.symbol).toBeNull();
  });

  it('multiple_accounts_fidelity.csv: detects as Fidelity with 2+ accountsDetected entries', () => {
    const result = importCsv(readFileSync(FILES.multiFidelity, 'utf8'));
    expect(result.importerId).toBe('fidelity');
    expect(result.accountsDetected).toBeDefined();
    expect(result.accountsDetected!.length).toBeGreaterThanOrEqual(2);
    // The Individual + HSA combo should be tagged with the right account-type hints.
    const types = new Set(result.accountsDetected!.map(a => a.accountTypeHint));
    expect(types.has('hsa')).toBe(true);
    expect(types.has('taxable')).toBe(true);
    // The flat transactions array should still hold every row for backwards compat.
    const sumByAccount = result.accountsDetected!.reduce((n, a) => n + a.transactions.length, 0);
    expect(result.transactions.length).toBe(sumByAccount);
  });

  it('schwab_single_account.CSV: returns importerId null with a rejection reason about balances', () => {
    const result = importCsv(readFileSync(FILES.schwabBalances, 'utf8'));
    expect(result.importerId).toBeNull();
    expect(result.transactions.length).toBe(0);
    expect(result.rejectionReason).toBeDefined();
    expect(result.rejectionReason!.toLowerCase()).toMatch(/balance|position/);
  });
});

(haveSchwabTransactions ? describe : describe.skip)('real Schwab transaction CSV', () => {
  it('single_scwab_transactions.csv: detects as schwab with mapped actions', () => {
    const result = importCsv(readFileSync(FILES.schwabTransactions, 'utf8'));
    expect(result.importerId).toBe('schwab');
    expect(result.transactions.length).toBeGreaterThanOrEqual(5);
    expect(result.unmappedActionStrings).toEqual([]);
    expect(result.inferences.actionsUnknown).toBe(0);
    const firstAction = result.transactions[0].action;
    expect(['buy', 'sell', 'dividend', 'div_reinvest']).toContain(firstAction);
  });
});

(haveJpmHoldings ? describe : describe.skip)('real JP Morgan positions CSV', () => {
  it('jpm_multiple_accounts.csv: detects as jpmHoldings with multi-account detection', () => {
    const result = importCsv(readFileSync(FILES.jpmHoldings, 'utf8'));
    expect(result.importerId).toBe('jpmHoldings');
    expect(result.transactions.length).toBeGreaterThan(50);
    expect(result.unmappedActionStrings).toEqual([]);
    expect(result.inferences.actionsUnknown).toBe(0);
    expect(result.accountsDetected).toBeDefined();
    expect(result.accountsDetected!.length).toBeGreaterThanOrEqual(2);
    for (const tx of result.transactions) {
      expect(tx.action).toBe('transfer_in');
    }
    // Sanity-check that ticker parsing produced at least a handful of distinct
    // symbols. We deliberately avoid asserting on specific tickers here so the
    // committed test doesn't leak the shape of the user's real portfolio.
    const tickers = new Set(result.transactions.map(t => t.symbol));
    expect(tickers.size).toBeGreaterThanOrEqual(3);
    // The flat transactions array should equal the union of per-account slices.
    const sumByAccount = result.accountsDetected!.reduce((n, a) => n + a.transactions.length, 0);
    expect(result.transactions.length).toBe(sumByAccount);
  });
});
