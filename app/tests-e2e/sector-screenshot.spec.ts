// Capture-only spec: seeds the instruments table with a VITAX sector entry,
// then visits the HoldingDetailView to confirm the header renders the real
// sector text instead of "Unknown · USD". Generates a screenshot for the
// regression report.

import { test, expect, type Page } from '@playwright/test';

async function startCold(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
}

test.describe('Sector rendering', () => {
  test('HoldingDetailView header shows real sector text from instruments table', async ({ page }) => {
    await startCold(page);

    // Seed the DB with a VITAX holding + sector row.
    await page.evaluate(() => {
      const today = new Date();
      const earliest = new Date(today);
      earliest.setUTCFullYear(earliest.getUTCFullYear() - 1);
      const store = {
        accounts: [
          {
            id: 'demo-vanguard',
            name: 'Vanguard Brokerage',
            brokerage: 'Vanguard',
            account_type: 'taxable',
            currency: 'USD',
            created_at: new Date().toISOString(),
          },
        ],
        transactions: [
          {
            id: 1,
            account_id: 'demo-vanguard',
            date: earliest.toISOString(),
            symbol: 'VITAX',
            action: 'buy',
            quantity: 100,
            price: 250.0,
            fees: 0,
            amount: -25000,
            currency: 'USD',
            notes: 'Vanguard Information Tech ETF',
            imported_from: 'seed',
          },
        ],
        prices: [
          {
            symbol: 'VITAX',
            date: new Date().toISOString(),
            close: 280.0,
            currency: 'USD',
            fetched_at: new Date().toISOString(),
            prev_close: 278.0,
          },
        ],
        instruments: [
          {
            symbol: 'VITAX',
            sector: 'Technology',
            industry: 'Information Technology',
            long_name: 'Vanguard Information Tech Index',
            fetched_at_ts: Date.now(),
            last_attempt_ts: Date.now(),
            last_result: 'ok',
          },
        ],
        settings: [
          { key: 'onboarding.completed.v1', value: 'yes' },
          { key: 'backfill.recovery.v1.complete', value: 'yes' },
          { key: 'dedupe.v1.complete', value: 'yes' },
        ],
        user_profile: [
          { id: 1, name: 'Justin', birth_year: 1990, retire_age: 65, household: 'single', theme: 'light' },
        ],
      };
      localStorage.setItem('matmon.dev.db.v1', JSON.stringify(store));
    });

    await page.reload();
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 10_000 });

    // Navigate to Holdings, then click VITAX.
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });
    await page.locator('.tbl tbody tr').filter({ hasText: 'VITAX' }).first().click();

    // The header should now show "Technology · Information Technology · USD".
    await expect(page.locator('.muted').filter({ hasText: /Technology/ }).first()).toBeVisible({
      timeout: 5_000,
    });

    // Screenshot the populated detail view.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/vitax-sector-populated.png',
      fullPage: false,
    });

    // The Holdings table should also show "Technology" in the Sector column.
    await page.locator('.back-btn').click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/holdings-sector-populated.png',
      fullPage: false,
    });
  });
});
