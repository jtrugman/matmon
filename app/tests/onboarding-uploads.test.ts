// Verifies the onboarding upload flow correctly splits multi-account CSVs
// into one OnboardingUpload per detected account, and that the importer's
// `accountsDetected` payload is respected.

import { describe, expect, it } from 'vitest';
import { importCsv } from '../src/lib/importers';

// Synthesizes a multi-account Fidelity-style CSV: two accounts in one file
// (the real export shape the user pasted in example_csv/).
const FIDELITY_MULTI = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
05/02/2026,"Individual","XXXX0001","YOU BOUGHT VOO",VOO,"VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,05/03/2026
04/29/2026,"Individual","XXXX0001","DIVIDEND RECEIVED VOO",VOO,"VANGUARD S&P 500 ETF",Cash,,,,,,12.40,
03/15/2026,"Health Savings Account","XXXX0002","YOU BOUGHT VTI",VTI,"VANGUARD TOTAL STOCK MKT ETF",Cash,318.45,5,,,,-1592.25,03/16/2026
02/10/2026,"Health Savings Account","XXXX0002","DIVIDEND RECEIVED VTI",VTI,"VANGUARD TOTAL STOCK MKT ETF",Cash,,,,,,8.20,
`;

describe('Onboarding multi-account ingestion', () => {
  it('Fidelity multi-account export yields accountsDetected with >= 2 entries', () => {
    const r = importCsv(FIDELITY_MULTI);
    expect(r.importerId).toBe('fidelity');
    expect(r.accountsDetected).toBeDefined();
    expect(r.accountsDetected!.length).toBe(2);
    const names = r.accountsDetected!.map(a => a.name).sort();
    expect(names).toEqual(['Health Savings Account', 'Individual']);
  });

  it('each detected account carries its own transaction slice', () => {
    const r = importCsv(FIDELITY_MULTI);
    const individual = r.accountsDetected!.find(a => a.name === 'Individual')!;
    const hsa = r.accountsDetected!.find(a => a.name === 'Health Savings Account')!;
    expect(individual.transactions.length).toBe(2);
    expect(hsa.transactions.length).toBe(2);
    // Every transaction in the Individual bucket comes from the Individual account
    for (const t of individual.transactions) {
      expect(['VOO', null]).toContain(t.symbol);
    }
    for (const t of hsa.transactions) {
      expect(['VTI', null]).toContain(t.symbol);
    }
  });

  it('account type hint identifies the HSA correctly', () => {
    const r = importCsv(FIDELITY_MULTI);
    const hsa = r.accountsDetected!.find(a => a.name === 'Health Savings Account')!;
    expect(hsa.accountTypeHint).toBe('hsa');
  });

  it('single-account file leaves accountsDetected undefined', () => {
    const singleAccount = `Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
05/02/2026,"YOU BOUGHT VOO",VOO,"VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,100.00,05/03/2026`;
    const r = importCsv(singleAccount);
    expect(r.importerId).toBe('fidelity');
    expect(r.accountsDetected).toBeUndefined();
  });
});
