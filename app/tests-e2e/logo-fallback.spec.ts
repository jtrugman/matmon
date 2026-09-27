// End-to-end spec for ticker + brokerage logo fallback states.
//
// What we verify:
//   1. After onboarding with a CSV containing tickers logo.dev doesn't have
//      (we use the JPM example which contains both familiar tickers and
//      obscure ones), every position row renders SOMETHING for its logo
//      slot. Either an <img> (the logo loaded) or a `.ticker-logo.monogram`
//      span with the symbol's first two letters.
//   2. The brokerage logo on the account-detail header similarly renders.
//
// We deliberately don't stub fetch or block logo.dev: the goal is to
// observe the live fallback behavior. If logo.dev happens to respond for
// every ticker in the dataset, the test still passes (image rendering is
// the success path); the monogram path is just defensive coverage.

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';
const SCREENSHOT_DIR = '/Users/justintrugman/Development/matmon/app/tests-e2e/screenshots';

async function startCold(page: Page) {
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[matmon-diag]') || text.includes('[matmon]')) {
      // eslint-disable-next-line no-console
      console.log(`  [browser] ${text}`);
    }
  });
  page.on('pageerror', err => {
    // eslint-disable-next-line no-console
    console.log(`  [browser-error] ${err.message}`);
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
}

async function walkOnboardingWithJpm(page: Page): Promise<void> {
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible();
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(JPM_PATH);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
}

test.describe('Logo fallback rendering', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(JPM_PATH)) {
      test.skip();
    }
    await startCold(page);
  });

  test('every position row has either an img or a monogram fallback', async ({ page }) => {
    await walkOnboardingWithJpm(page);
    // Navigate to Holdings.
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    await expect(page.locator('h1.page-title')).toContainText(/^Holdings$/);

    // Wait for the holdings table to mount.
    await expect(page.locator('table.tbl tbody tr').first()).toBeVisible({ timeout: 10_000 });
    const rows = page.locator('table.tbl tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Each row's first cell carries the TickerLogo. Either an <img> or a
    // .monogram span. Both render with the .ticker-logo class.
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const logo = row.locator('.ticker-logo').first();
      await expect(logo).toBeVisible();
      // Has either has-logo (image) OR monogram fallback. Both are valid.
      const cls = (await logo.getAttribute('class')) ?? '';
      expect(/has-logo|monogram/.test(cls)).toBe(true);

      // If it's a monogram, it should have 1-2 letters of the symbol.
      if (cls.includes('monogram')) {
        const text = (await logo.textContent())?.trim() ?? '';
        expect(text.length).toBeGreaterThanOrEqual(1);
        expect(text.length).toBeLessThanOrEqual(2);
        // Must match the symbol's first 2 letters (uppercase).
        const symCell = row.locator('.sym').first();
        const sym = (await symCell.textContent())?.trim().toUpperCase() ?? '';
        // Strip non-alpha (e.g. "BRK-B" → "BRKB") to match monogramFor.
        const expected = sym.replace(/[^A-Z0-9]/g, '').slice(0, 2);
        if (expected.length > 0) {
          expect(text).toBe(expected);
        }
      }
    }

    // Screenshot for the PR body.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/holdings-logo-fallback.png`,
      fullPage: true,
    });
  });

  test('brokerage logos on the Accounts page render an image for known brokerages', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    await expect(page.locator('h1.page-title')).toContainText(/^Accounts$/);

    // JPM is a known brokerage; the .brokerage-mark should carry an <img>.
    const jpmGroupHeader = page
      .locator('.brokerage-group-head')
      .filter({ hasText: /JP Morgan/i })
      .first();
    await expect(jpmGroupHeader).toBeVisible();
    const img = jpmGroupHeader.locator('img');
    await expect(img).toBeVisible();
  });
});
