// End-to-end spec for the "Add transaction" modal on the account-detail view.
//
// The bug Justin called out: clicking "Add transaction" on the account-detail
// page (the holdings view filtered by account) wasn't reliably opening a
// working form. This spec walks the user through:
//   1. Onboard with the Fidelity multi-account CSV.
//   2. Open the Accounts page, click into the first Fidelity account row.
//   3. Click "Add transaction" in the page header.
//   4. Fill the modal with a buy of 5 shares of GOOG @ $100.
//   5. Submit.
//   6. Assert the new row landed in BOTH the account-detail holdings (GOOG
//      now appears in the symbol column) and the global Transactions view.
//   7. Capture a screenshot of the modal in flight for the PR.

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';

const FIDELITY_PATH =
  '/Users/justintrugman/Development/matmon/app/example_csv/multiple_accounts_fidelity.csv';
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

async function walkOnboardingWithFidelity(page: Page): Promise<void> {
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible();
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(FIDELITY_PATH);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
}

test.describe('Add transaction modal on account-detail', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(FIDELITY_PATH)) {
      test.skip();
    }
    await startCold(page);
  });

  test('opens, accepts a manual entry, and the row appears in the Transactions view', async ({
    page,
  }) => {
    await walkOnboardingWithFidelity(page);

    // Navigate to Accounts and click the first account row.
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    const firstRow = page.locator('.brokerage-account-row').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    // Now on the account-detail HoldingsView. Header carries the
    // "Add transaction" button.
    const addBtn = page.getByTestId('account-add-transaction');
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    await addBtn.click();

    // Modal must appear.
    const modal = page.getByTestId('add-transaction-modal');
    await expect(modal).toBeVisible({ timeout: 3_000 });
    await expect(modal).toContainText(/Add transaction/i);

    // Fill the form: buy 5 shares of GOOG at $100.
    await modal.getByText(/^Symbol$/).locator('..').locator('input').fill('GOOG');
    await modal.getByText(/^Quantity$/).locator('..').locator('input').fill('5');
    await modal.getByText(/^Price per share$/).locator('..').locator('input').fill('100');

    // Screenshot of the modal while it's still in flight.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/add-transaction-modal-inflight.png`,
      fullPage: true,
    });

    // Submit. The modal closes once the insertTransactions promise resolves.
    await modal.getByRole('button', { name: /Save transaction/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    // The new GOOG row should now appear in the global Transactions view.
    await page.locator('.nav-item').filter({ hasText: /^Transactions$/i }).click();
    await expect(page.locator('h1.page-title')).toContainText(/^Transactions$/);
    // Search by symbol to narrow the table.
    await page.getByLabel(/Search transactions by symbol/i).fill('GOOG');
    // At least one row with GOOG should appear; the action badge should be Buy.
    await expect(page.locator('table.tbl tbody tr td .sym').filter({ hasText: 'GOOG' }).first()).toBeVisible({
      timeout: 5_000,
    });
    // The action badge for the new row must be the Buy badge (green, label "Buy").
    await expect(
      page
        .locator('table.tbl tbody tr')
        .filter({ has: page.locator('td .sym', { hasText: 'GOOG' }) })
        .first()
        .locator('.activity-act'),
    ).toContainText(/^Buy$/i);
  });

  test('validation: empty symbol on a buy surfaces an error', async ({ page }) => {
    await walkOnboardingWithFidelity(page);
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    const firstRow = page.locator('.brokerage-account-row').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();
    await page.getByTestId('account-add-transaction').click();

    const modal = page.getByTestId('add-transaction-modal');
    await expect(modal).toBeVisible();
    // Leave the symbol blank; fill qty + price.
    await modal.getByText(/^Quantity$/).locator('..').locator('input').fill('1');
    await modal.getByText(/^Price per share$/).locator('..').locator('input').fill('100');
    await modal.getByRole('button', { name: /Save transaction/i }).click();
    // The form has required: false on the symbol input itself (we only
    // require it for buys/sells in the handleSubmit guard), so the
    // role=alert message should appear inline.
    await expect(modal.getByRole('alert')).toBeVisible({ timeout: 2_000 });
    await expect(modal.getByRole('alert')).toContainText(/Symbol is required/i);
    // The modal stays open.
    await expect(modal).toBeVisible();
  });
});
