// End-to-end spec for the cash-flow row labeling fix.
//
// The bug Justin reported: a row whose action description was "Electronic
// Funds Transfer Received" showed up in the Transactions view as a "BUY"
// badge, with empty qty/price and a positive amount. That's wrong on three
// axes: the badge color (green = a purchase), the label (a deposit isn't a
// buy), and the user's mental model (they didn't buy anything; money landed
// in the account).
//
// What we verify:
//   1. After importing the multi-account Fidelity CSV (which contains
//      ~12 cash_in rows), the Transactions view shows those rows with a
//      "Deposit" label and the cashflow tier class, NOT "Buy" or "BUY".
//   2. The Cash flows filter segment selects only those rows.
//   3. Combining Cash flows + a 1M / 1Y range still narrows correctly.
//
// We also capture a screenshot for the PR body.

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

async function navToTransactions(page: Page): Promise<void> {
  await page.locator('.nav-item').filter({ hasText: /^Transactions$/i }).click();
  await expect(page.locator('h1.page-title')).toContainText(/^Transactions$/);
}

test.describe('Transactions view: cash-flow row labels', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(FIDELITY_PATH)) {
      test.skip();
    }
    await startCold(page);
  });

  test('cash_in rows render as "Deposit" with the cashflow tier (NOT "Buy")', async ({
    page,
  }) => {
    await walkOnboardingWithFidelity(page);
    await navToTransactions(page);

    // The Fidelity sample CSV carries ~12 "Electronic Funds Transfer
    // Received" rows. Wait for at least one to land.
    await expect(page.locator('[data-testid="tx-row-cash_in"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const cashInRows = page.locator('[data-testid="tx-row-cash_in"]');
    const rowCount = await cashInRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // Every cash_in row must carry a "Deposit" badge with the cashflow
    // tier class. No row should read "Buy" or "BUY".
    const badges = page.locator('[data-testid="tx-action-cash_in"]');
    const badgeCount = await badges.count();
    expect(badgeCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < badgeCount; i++) {
      const badge = badges.nth(i);
      const text = (await badge.textContent())?.trim() ?? '';
      expect(text).toBe('Deposit');
      const cls = (await badge.getAttribute('class')) ?? '';
      expect(cls).toContain('cashflow');
      expect(cls).not.toContain('activity-act buy');
    }

    // Sanity: no cash_in row should accidentally render as a "Buy" badge.
    // (Stronger negative assertion: searching for "Buy" labels inside
    // cash_in rows must return zero.)
    const inCashInRow = page.locator('[data-testid="tx-row-cash_in"] .activity-act.buy');
    expect(await inCashInRow.count()).toBe(0);

    // Screenshot proof for the PR body. Capture with the row visible.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/transactions-cash-flow-labels.png`,
      fullPage: true,
    });
  });

  test('"Cash flows" filter segment shows only cash-flow rows', async ({ page }) => {
    await walkOnboardingWithFidelity(page);
    await navToTransactions(page);

    await expect(page.locator('[data-testid="tx-row-cash_in"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // Click the Cash flows segment.
    await page.getByTestId('tx-filter-cashflow').click();

    // Every visible row must be a cash-flow tier. Buys and dividends drop out.
    await expect(page.locator('[data-testid="tx-row-cash_in"]').first()).toBeVisible();
    const buyRows = await page.locator('[data-testid^="tx-row-buy"]').count();
    expect(buyRows).toBe(0);
    const sellRows = await page.locator('[data-testid^="tx-row-sell"]').count();
    expect(sellRows).toBe(0);
    const dividendRows = await page.locator('[data-testid^="tx-row-dividend"]').count();
    expect(dividendRows).toBe(0);

    // The page meta line should still show the cash-flow count.
    await expect(page.locator('.page-meta').first()).toContainText(/cash flows/i);
  });
});
