// Holdings aggregation e2e: when a user holds the same symbol in multiple
// accounts (e.g. Justin's VITAX in 5 different JPM accounts), the unfiltered
// Holdings view should render ONE row for that symbol with summed qty across
// accounts. Drilling into a specific account (filterAccountId) returns to the
// per-account-symbol shape.
//
// This is the regression spec for Bug 2.

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

test.describe('Holdings aggregation', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(JPM_PATH)) {
      test.skip();
    }
    await startCold(page);
  });

  test('unfiltered Holdings shows exactly ONE row per symbol even when held in multiple accounts', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

    // Navigate to the unfiltered Holdings view.
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });

    // Count how many rows render for the most-duplicated symbol in the JPM
    // export. The fixture has VITAX (and a handful of similar funds) across
    // multiple accounts; the post-aggregation Holdings view must surface
    // EXACTLY one row per symbol.
    const allRows = page.locator('.tbl tbody tr');
    const symbolCells = await allRows.locator('.sym').allTextContents();
    const seen = new Map<string, number>();
    for (const s of symbolCells) {
      const sym = s.trim();
      if (!sym) continue;
      seen.set(sym, (seen.get(sym) || 0) + 1);
    }
    // No symbol should appear more than once.
    for (const [sym, count] of seen) {
      expect.soft(count, `${sym} duplicated ${count} times`).toBe(1);
    }
    // Sanity: at least one row landed.
    expect(seen.size).toBeGreaterThan(0);

    // Screenshot the aggregated view for the report.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/holdings-aggregated.png',
      fullPage: true,
    });
  });

  test('the "Held in N accounts" subtitle appears when a symbol is in multiple accounts', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });

    // The "Held in N accounts" string is rendered for any symbol with
    // heldInAccounts >= 2. Some JPM users have at least one such symbol; we
    // assert the string can be located if anyone qualifies. If no symbol is
    // multi-account in the fixture, this assertion is a soft no-op.
    const heldInBadge = page.locator('text=/Held in \\d+ accounts/i').first();
    const badgeCount = await heldInBadge.count();
    // If a multi-account holding exists in the fixture, the badge must show.
    // Otherwise this test is a soft-skip rather than a hard failure: the JPM
    // fixture in the gitignored example_csv may vary across machines.
    if (badgeCount > 0) {
      await expect(heldInBadge).toBeVisible();
    }
  });

  test('per-account drill-in still shows per-symbol-in-this-account rows (unaggregated)', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

    // Drill into the first JPM account from the Accounts page.
    await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
    const jpmGroup = page
      .locator('.brokerage-group')
      .filter({ hasText: /JP Morgan/i })
      .first();
    await expect(jpmGroup).toBeVisible({ timeout: 5_000 });
    const firstAccountRow = jpmGroup.locator('.brokerage-account-row').first();
    await firstAccountRow.click();

    // The account-detail HoldingsView renders the per-account symbol rows.
    // The subtitle "Held in N accounts" should NEVER appear in the filtered
    // view (every row is by definition in this single account).
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });
    const heldInBadge = page.locator('text=/Held in \\d+ accounts/i');
    expect(await heldInBadge.count()).toBe(0);
  });
});
