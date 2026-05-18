// Accounts view: clicking ANYWHERE on an account row should navigate to that
// account's detail page. The old UI required clicking the small "Open" link
// in the right gutter; the new shape makes the entire row a button.
//
// This spec is the regression guard for Bug 4.

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';

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
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
}

test.describe('Accounts row click-anywhere', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(JPM_PATH)) {
      test.skip();
    }
    await startCold(page);
  });

  test('clicking anywhere on an account row (not just the "Open" affordance) navigates to detail', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    const jpmGroup = page
      .locator('.brokerage-group')
      .filter({ hasText: /JP Morgan/i })
      .first();
    await expect(jpmGroup).toBeVisible({ timeout: 5_000 });
    const firstRow = jpmGroup.locator('.brokerage-account-row').first();
    await expect(firstRow).toBeVisible();

    // Capture the account name BEFORE clicking so we can verify we landed
    // on its detail page.
    const accountName = (await firstRow.locator('.bar-name').textContent())?.trim() ?? '';
    expect(accountName.length).toBeGreaterThan(0);

    // Click the row in the LEFT region (over the name / type pip), NOT on
    // the "Open" affordance in the right gutter. The old shape would not
    // navigate from this click position.
    const namePart = firstRow.locator('.bar-name');
    await namePart.click();

    // We should land on an account-detail HoldingsView whose title matches.
    // The page title there is the account name; we use a substring match
    // because the canonical display may include a last-4 suffix.
    await expect(page.locator('.page-title')).toContainText(accountName, { timeout: 5_000 });

    // Screenshot of the row-click navigation working.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/accounts-row-click.png',
      fullPage: true,
    });
  });

  test('Enter key on a focused account row also triggers navigation', async ({ page }) => {
    await walkOnboardingWithJpm(page);
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    const jpmGroup = page
      .locator('.brokerage-group')
      .filter({ hasText: /JP Morgan/i })
      .first();
    await expect(jpmGroup).toBeVisible({ timeout: 5_000 });
    const firstRow = jpmGroup.locator('.brokerage-account-row').first();
    await firstRow.focus();
    const accountName = (await firstRow.locator('.bar-name').textContent())?.trim() ?? '';
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-title')).toContainText(accountName, { timeout: 5_000 });
  });
});
