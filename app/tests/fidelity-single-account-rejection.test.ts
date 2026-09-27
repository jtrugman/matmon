// Pinned behaviour for the Fidelity import gate.
//
// Product decision (2026-05-18): Matmon's Fidelity importer ONLY accepts the
// multi-account transaction-history export. Single-account exports omit the
// Account Number column entirely, which breaks the dedup fingerprint we use
// to keep accounts organized across re-imports. Rather than build fragile
// fallbacks or silently rename the import, we reject the wrong file at the
// import gate with a helpful message pointing the user at the right export.
//
// This spec pins both sides of the contract:
//
//   1. The real example file `single_account_fidelity.csv` is rejected. The
//      message contains the key phrases the UI surfaces verbatim and a
//      machine-readable `rejectionKind` so view code can format the message
//      with brokerage-specific styling.
//
//   2. The real example file `multiple_accounts_fidelity.csv` STILL imports
//      cleanly, surfaces both detected accounts, and parses every row in the
//      file. This guards against the rejection rule being too greedy.
//
// Also exercises a handful of synthetic edge cases (small CSV with the
// canonical Fidelity headers but no Account column → rejection; small CSV
// with the multi-account columns → normal import) so the spec stays useful
// even on machines where the gitignored real example files aren't present.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importCsv } from '../src/lib/importers';

const EXAMPLE_DIR = resolve(process.cwd(), 'example_csv');
const SINGLE_FILE = resolve(EXAMPLE_DIR, 'single_account_fidelity.csv');
const MULTI_FILE = resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv');
const haveSingle = existsSync(SINGLE_FILE);
const haveMulti = existsSync(MULTI_FILE);

describe('Fidelity single-account export is rejected at the import gate', () => {
  (haveSingle ? it : it.skip)(
    'single_account_fidelity.csv: rejection message contains "multi-account export" and "All Accounts"',
    () => {
      const csv = readFileSync(SINGLE_FILE, 'utf8');
      const result = importCsv(csv);
      // No transactions are imported at all (clean reject, not partial).
      expect(result.transactions).toHaveLength(0);
      expect(result.importerId).toBeNull();
      expect(result.accountsDetected).toBeUndefined();
      // The rejection message is the literal string the UI surfaces to the
      // user. We assert on its key substrings so a typo doesn't slip past.
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!).toMatch(/multi-account export/i);
      expect(result.rejectionReason!).toMatch(/All Accounts/);
      // The numbered steps that walk the user through Fidelity's UI.
      expect(result.rejectionReason!).toMatch(/Accounts & Trade/);
      expect(result.rejectionReason!).toMatch(/Activity & Orders/);
      // Machine-readable tag so the UI can format with brokerage-specific
      // styling (icon, deep link to the brokerage's export page, etc.)
      // without substring-matching on the human-readable message.
      expect(result.rejectionKind).toBe('wrong-fidelity-export');
    },
  );

  (haveMulti ? it : it.skip)(
    'multiple_accounts_fidelity.csv: STILL imports successfully (2 accounts, all transactions parsed)',
    () => {
      const csv = readFileSync(MULTI_FILE, 'utf8');
      const result = importCsv(csv);
      // The rejection rule must not be too greedy. The multi-account file
      // imports normally and the importer surfaces both detected accounts.
      expect(result.importerId).toBe('fidelity');
      expect(result.rejectionReason).toBeUndefined();
      expect(result.rejectionKind).toBeUndefined();
      expect(result.accountsDetected).toBeDefined();
      expect(result.accountsDetected!).toHaveLength(2);
      expect(result.transactions.length).toBeGreaterThan(0);
      // Both accounts carry their own transaction slice.
      const sumByAccount = result.accountsDetected!.reduce(
        (n, a) => n + a.transactions.length,
        0,
      );
      expect(result.transactions.length).toBe(sumByAccount);
      // Each account surfaces a 4-digit last4 fingerprint for dedup.
      for (const acc of result.accountsDetected!) {
        expect(acc.last4).toMatch(/^\d{4}$/);
        expect(acc.accountNumber).toBeTruthy();
      }
    },
  );
});

describe('Fidelity import gate: synthetic edge cases', () => {
  // Tight synthetic CSVs so the spec still exercises the rejection logic on
  // machines without the gitignored real example files present.

  it('synthetic Fidelity-shape CSV without Account columns → rejection', () => {
    // The canonical Fidelity single-account header shape (13 columns, no
    // Account / Account Number). Any file matching this shape is rejected.
    const csv = `Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
05/02/2026,"YOU BOUGHT VOO",VOO,"VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,100.00,05/03/2026`;
    const result = importCsv(csv);
    expect(result.importerId).toBeNull();
    expect(result.transactions).toHaveLength(0);
    expect(result.rejectionReason).toMatch(/multi-account export/i);
    expect(result.rejectionKind).toBe('wrong-fidelity-export');
  });

  it('synthetic Fidelity-shape CSV WITH Account columns → normal import', () => {
    // Same content, multi-account shape (Account + Account Number columns).
    // The importer claims the file, parses the row, and emits a single
    // transaction. accountsDetected stays undefined when only one account
    // is present (the existing >= 2 threshold guards the picker UX).
    const csv = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
05/02/2026,"Individual","Z00001234","YOU BOUGHT VOO",VOO,"VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,05/03/2026`;
    const result = importCsv(csv);
    expect(result.importerId).toBe('fidelity');
    expect(result.transactions).toHaveLength(1);
    expect(result.rejectionReason).toBeUndefined();
    expect(result.rejectionKind).toBeUndefined();
    // Single-account inside a multi-account-shape file: the canonical
    // (Account, Account Number) fingerprint is still extracted on the
    // inferences side so upsertAccountByFingerprint can dedupe re-imports.
    expect(result.inferences.accountNumber).toBe('Z00001234');
    expect(result.inferences.last4).toBe('1234');
  });

  it('synthetic CSV with Account column populated on some rows but not the header → still rejected', () => {
    // Belt-and-suspenders: if a file omits the Account column from the
    // HEADER but somehow includes Account values on some rows (Papa-folded
    // malformed export), the importer's detection sweeps the row values too.
    // This synthetic case has the header missing the Account column, so it
    // gets rejected even though a stray Description column carries the
    // account name. (The scraper that recovers account NUMBERS from row
    // contents runs at the importer.parse() level, not the rejection level.)
    const csv = `Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
05/02/2026,"YOU BOUGHT VOO",VOO,"Individual Z00001234 VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,100.00,05/03/2026`;
    const result = importCsv(csv);
    // Still rejected: the rejection rule keys off the HEADER row, not the
    // contents of the Description field. Embedding the account number
    // inside the Description is not a valid replacement for the Account
    // Number column.
    expect(result.importerId).toBeNull();
    expect(result.rejectionKind).toBe('wrong-fidelity-export');
  });
});
