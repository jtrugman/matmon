// End-to-end onboarding integration test.
//
// 354 isolated unit specs pass while the real onboarding flow still drops Justin
// on a Home view that greets him "there" and shows $0. The gap is integration:
// every component is fine but the seams between them are not exercised together.
// This spec walks the SAME code paths App.tsx#finishOnboarding walks (save
// profile, save goal, insertAccount, insertTransactions, upsertPrice,
// setSetting), then asserts the post-onboarding state buildPortfolio surfaces,
// the same way HomeView consumes it. If any of these assertions fail the fix
// lives in the production code, not in the test.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { importCsv } from '../src/lib/importers';
import {
  insertAccount,
  insertTransactions,
  saveUserProfile,
  loadUserProfile,
  saveGoalScenario,
  listAccounts,
  listTransactions,
  setSetting,
  upsertPrice,
} from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';
import { slugifyAccountId } from '../src/lib/db/accountId';
import { __resetDriverForTests } from '../src/lib/db/driver';
import { __resetReposForTests } from '../src/lib/db/repos';

const ONBOARDING_DONE_KEY = 'onboarding.completed.v1';

const baseProfile = {
  name: 'Justin',
  birthYear: 1985,
  retireAge: 67,
  household: 'partnered' as const,
  theme: 'light' as const,
};

describe('E2E: Full onboarding flow ending in a populated Home view', () => {
  it('user completes onboarding and uploads JPM holdings -> buildPortfolio reflects real data', async () => {
    // Step 1: save profile (mirrors what finishOnboarding does).
    await saveUserProfile(baseProfile);

    // Step 2: save goal scenario.
    await saveGoalScenario(3_000_000, baseProfile);

    // Step 3: import the JPM holdings CSV (skip if local-only fixture absent).
    const csvPath =
      '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';
    let csvText: string;
    try {
      csvText = readFileSync(csvPath, 'utf8');
    } catch {
      return;
    }

    const result = importCsv(csvText);
    expect(result.importerId).toBe('jpmHoldings');
    expect(result.accountsDetected && result.accountsDetected.length).toBeGreaterThan(0);

    // Step 4: insert each detected account via the SAME path App.tsx walks.
    const existingIds = (await listAccounts()).map(a => a.id);
    for (const acc of result.accountsDetected!) {
      const last4 = (acc.accountNumber || '').replace(/\D/g, '').slice(-4);
      const accountName = [last4, 'JP Morgan', acc.name].filter(Boolean).join(' ');
      const id = slugifyAccountId(accountName, 'JP Morgan', existingIds);
      existingIds.push(id);
      await insertAccount({
        id,
        name: accountName,
        brokerage: 'JP Morgan',
        account_type: acc.accountTypeHint === 'unknown' ? 'taxable' : acc.accountTypeHint,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });
      await insertTransactions(id, acc.transactions);
    }

    // Step 5: upsert market prices (jpmHoldings supplies these so portfolio
    // aggregation can value at market, not at cost basis).
    if (result.marketPrices) {
      for (const mp of result.marketPrices) {
        await upsertPrice(mp.symbol, mp.asOf, mp.price);
      }
    }

    // Step 6: set the "onboarding done" flag (mirrors finishOnboarding).
    await setSetting(ONBOARDING_DONE_KEY, 'yes');

    // ---- Now verify HomeView would render correctly. ----

    // userName should resolve to "Justin".
    const loadedProfile = await loadUserProfile();
    expect(loadedProfile?.name).toBe('Justin');

    // listAccounts must return inserted accounts.
    const accounts = await listAccounts();
    expect(accounts.length).toBeGreaterThan(0);

    // listTransactions must return inserted transactions.
    const txs = await listTransactions();
    expect(txs.length).toBeGreaterThan(0);

    // buildPortfolio must produce a non-zero totalValue.
    const portfolio = await buildPortfolio();
    expect(portfolio.totalValue).toBeGreaterThan(0);
    expect(portfolio.accounts.length).toBeGreaterThan(0);
    expect(portfolio.holdings.length).toBeGreaterThan(0);

    // Most holdings come from upsertPrice'd market data, so the bulk of the
    // portfolio should value at well above the cost-basis floor. The CSV does
    // contain one legitimately worthless penny-stock holding (HCMC at $0); we
    // tolerate that by checking the share of priced holdings, not every row.
    const pricedHoldings = portfolio.holdings.filter(h => h.value > 0);
    expect(pricedHoldings.length).toBeGreaterThan(portfolio.holdings.length * 0.9);
    // JPM CSV has roughly $700K in holdings; we don't pin to a specific number
    // (the file may evolve) but six figures is a safe floor.
    expect(portfolio.totalValue).toBeGreaterThan(100_000);
  });

  it('falls back gracefully when user skips uploading any CSV', async () => {
    await saveUserProfile(baseProfile);
    await setSetting(ONBOARDING_DONE_KEY, 'yes');

    const portfolio = await buildPortfolio();
    expect(portfolio.totalValue).toBe(0);
    expect(portfolio.accounts).toHaveLength(0);

    // userName should still resolve so the greeting shows "Justin" not "there".
    const loaded = await loadUserProfile();
    expect(loaded?.name).toBe('Justin');
  });

  it('survives a simulated app relaunch (driver+repos reset) without losing data', async () => {
    // Simulates what Justin saw: finish onboarding, quit the app, relaunch.
    // The data must still be there on the second launch. The browser shim
    // backs onto localStorage, so as long as the driver's tableWrite path
    // actually serialized to localStorage (not just in-memory) the rebuilt
    // driver instance on relaunch will rehydrate from the same blob.
    await saveUserProfile(baseProfile);
    await saveGoalScenario(3_000_000, baseProfile);
    await insertAccount({
      id: 'sim-relaunch-acct',
      name: 'Sim Account',
      brokerage: 'Fidelity',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('sim-relaunch-acct', [
      {
        date: new Date('2024-01-15T00:00:00.000Z'),
        symbol: 'VTI',
        action: 'buy',
        quantity: 50,
        price: 220,
        fees: 0,
        amount: null,
        currency: 'USD',
        notes: '',
        rawHash: 'relaunch-r1',
      },
    ]);
    await setSetting('onboarding.completed.v1', 'yes');

    // "Relaunch": drop the cached driver and repos init flag. localStorage
    // (the persistence layer for the browser shim) is left intact.
    __resetDriverForTests();
    __resetReposForTests();

    // After relaunch, everything must still resolve.
    const profileAfter = await loadUserProfile();
    expect(profileAfter?.name).toBe('Justin');
    const accountsAfter = await listAccounts();
    expect(accountsAfter.find(a => a.id === 'sim-relaunch-acct')).toBeDefined();
    const txsAfter = await listTransactions();
    expect(txsAfter.length).toBeGreaterThan(0);
    const portfolio = await buildPortfolio();
    expect(portfolio.totalValue).toBeGreaterThan(0);
  });

});
