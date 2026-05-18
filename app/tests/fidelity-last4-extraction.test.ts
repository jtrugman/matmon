// Fidelity importer last4 extraction coverage.
//
// Matmon ONLY accepts the multi-account Fidelity export. Single-account
// exports omit the Account Number column entirely (the field we use as the
// dedup fingerprint), so they're now rejected at the import gate before
// last4 extraction even runs. This test file pins two related concerns:
//
//   1. The multi-account Fidelity History export (with "Account" + "Account
//      Number" columns) MUST surface a 4-digit fingerprint per account so
//      upsertAccountByFingerprint can dedupe re-imports back onto the
//      canonical row. Fidelity brokerage account numbers are alphanumeric
//      (leading capital letter followed by digits); HSA account numbers are
//      pure digits. Only the trailing 4 digits matter for fingerprinting.
//
//   2. Single-account Fidelity History exports are rejected up front. The
//      rejection message points the user at Fidelity's "All Accounts"
//      download option so they can re-export the correct file.
//
// The previous incarnation of this spec covered a "import single, then
// import multi, watch the duplicate row appear" cross-file scenario. That
// scenario is no longer possible (single-account imports are rejected), so
// those tests have been removed. The functional regression they protected
// against (duplicate account rows when last4 is missing) cannot happen
// anymore because we require last4 at the import gate.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importCsv } from '../src/lib/importers';
import { fidelityImporter } from '../src/lib/importers/fidelity';
import {
  insertTransactions,
  listAccounts,
  upsertAccountByFingerprint,
} from '../src/lib/db/repos';
import { slugifyAccountId } from '../src/lib/db/accountId';

const EXAMPLE_DIR = resolve(process.cwd(), 'example_csv');

/**
 * Mirror of the App.tsx + AddAccountView import-and-upsert pipeline, distilled
 * to the minimal handful of calls a multi-account import makes. Returns the
 * canonical account IDs that landed in the DB after the pass.
 */
async function importMultiAccount(csv: string, brokerage: string): Promise<string[]> {
  const result = importCsv(csv);
  if (!result.accountsDetected) {
    throw new Error('expected accountsDetected on multi-account import');
  }
  const existingIds = (await listAccounts()).map(a => a.id);
  const insertedIds: string[] = [];
  for (const acc of result.accountsDetected) {
    const last4 = acc.last4;
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
    insertedIds.push(id);
    await insertTransactions(id, acc.transactions);
  }
  return insertedIds;
}

describe('Fidelity multi-account import extracts last4 per account', () => {
  it('surfaces accountsDetected with 4-digit last4 for both Individual and HSA', () => {
    const csv = readFileSync(resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv'), 'utf8');
    const r = importCsv(csv);
    expect(r.importerId).toBe('fidelity');
    expect(r.accountsDetected).toBeDefined();
    expect(r.accountsDetected!).toHaveLength(2);

    const byName = new Map(r.accountsDetected!.map(a => [a.name, a]));
    const individual = byName.get('Individual');
    const hsa = byName.get('Health Savings Account');

    // We only assert on the SHAPE here so the test doesn't commit real
    // brokerage account number literals to the repo. The example CSV file is
    // gitignored; pinning the precise digits in committed tests would defeat
    // that gating.
    expect(individual).toBeDefined();
    expect(individual!.last4).toMatch(/^\d{4}$/);
    // Fidelity brokerage account shape: leading capital letter + digits.
    expect(individual!.accountNumber).toMatch(/^[A-Z]\d{7,9}$/);
    // last4 is the trailing 4 digits of the account number.
    expect(individual!.accountNumber.endsWith(individual!.last4)).toBe(true);

    expect(hsa).toBeDefined();
    expect(hsa!.last4).toMatch(/^\d{4}$/);
    // Fidelity HSA shape: pure-digit 8-10 char run.
    expect(hsa!.accountNumber).toMatch(/^\d{8,10}$/);
    expect(hsa!.accountNumber.endsWith(hsa!.last4)).toBe(true);
  });

  it('alphanumeric account numbers yield a 4-digit last4 (trailing digits only)', () => {
    // The lastFourOf() helper strips non-digits then takes the trailing 4. This
    // is the same shape the upsertAccountByFingerprint fallback expects.
    const csv = readFileSync(resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv'), 'utf8');
    const r = importCsv(csv);
    const individual = r.accountsDetected!.find(a => a.name === 'Individual')!;
    // "Z" + 7-9 digits → digits-only → trailing 4 = a 4-digit string.
    expect(individual.last4).toMatch(/^\d{4}$/);
    expect(individual.accountNumber).toMatch(/^[A-Z]\d{7,9}$/);
  });
});

describe('Fidelity single-account import is rejected at the import gate', () => {
  it('importCsv on single_account_fidelity.csv produces a structured rejection (no transactions)', () => {
    const csv = readFileSync(resolve(EXAMPLE_DIR, 'single_account_fidelity.csv'), 'utf8');
    const r = importCsv(csv);
    // No importer is allowed to claim the file: the file is REJECTED outright.
    expect(r.importerId).toBeNull();
    expect(r.transactions).toHaveLength(0);
    expect(r.accountsDetected).toBeUndefined();
    // The rejection message contains the key strings the UI surfaces verbatim.
    expect(r.rejectionReason).toBeDefined();
    expect(r.rejectionReason!).toMatch(/multi-account export/i);
    expect(r.rejectionReason!).toMatch(/All Accounts/);
    // Machine-readable tag so the UI can format the message with brokerage-
    // specific styling without substring-matching on the human text.
    expect(r.rejectionKind).toBe('wrong-fidelity-export');
  });

  it('scrapeAccountNumber recovers a Fidelity-shaped id from a "Account Number: <id>" cell value', () => {
    // The fallback scraper looks at row values for a "Account Number ..." label
    // pattern. A hypothetical Fidelity variant that emits a per-row "Account
    // Number" cell (without elevating it to its own column) would hide the
    // identifier inside the Description column. Today's file doesn't ship that
    // shape, but the scraper protects us against the variant.
    //
    // We exercise the parse() entry directly so we don't have to fight Papa's
    // header inference for this defensive case; the inputs are synthetic rows
    // matching the canonical Fidelity column names. The literal "Z00009999"
    // is an anonymized fingerprint that matches Fidelity's brokerage shape
    // (leading letter + 8 digits). Calling parse() directly bypasses the
    // import-gate rejection, which is the path we want to exercise.
    const result = fidelityImporter.parse([
      {
        'Run Date': '05/11/2026',
        Action: 'YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)',
        Symbol: 'VGT',
        Description: 'Account Number: Z00009999 VANGUARD WORLD FD INF TECH ETF',
        Type: 'Cash',
        'Price ($)': '113.89',
        Quantity: '1',
        'Amount ($)': '-113.89',
        'Settlement Date': '05/12/2026',
      },
    ]);
    // No "Account" column on the row, so sawAccountColumn stays false and the
    // scraper runs. The scraper finds "Account Number: Z00009999" → Z00009999.
    expect(result.inferences.accountNumber).toBe('Z00009999');
    expect(result.inferences.last4).toBe('9999');
  });

  it('scrapeAccountNumber recovers a Fidelity-shaped id leaked into a row KEY (Papa header folding)', () => {
    // When a stray "Brokerage Account Number <id>" header line is folded
    // into the field-name list (Papa's behavior for a single-cell line above a
    // data table), the id hides in the row's KEY set rather than its values.
    // The scraper sweeps both, so this still resolves. Exercises parse()
    // directly to bypass the import-gate rejection.
    const result = fidelityImporter.parse([
      {
        'Brokerage Account Number Z00009999': 'Run Date',
        'Run Date': '05/11/2026',
        Action: 'YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)',
        Symbol: 'VGT',
        'Price ($)': '113.89',
        Quantity: '1',
        'Amount ($)': '-113.89',
      },
    ]);
    expect(result.inferences.accountNumber).toBe('Z00009999');
    expect(result.inferences.last4).toBe('9999');
  });
});

describe('Multi-account Fidelity dedup: re-import keeps the count at 2', () => {
  it('multi then re-import multi: dedup keeps the count at 2', async () => {
    // Sanity that the standard multi-account dedup path still works: importing
    // the multi-account file twice produces 2 accounts, not 4. This isn't
    // strictly a Fidelity-importer test (the dedup logic lives in
    // upsertAccountByFingerprint), but it's the upper bound we want to hold
    // for the import path that ACTUALLY works.
    const multiCsv = readFileSync(resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv'), 'utf8');
    await importMultiAccount(multiCsv, 'Fidelity');
    expect((await listAccounts()).length).toBe(2);
    await importMultiAccount(multiCsv, 'Fidelity');
    expect((await listAccounts()).length).toBe(2);
  });
});
