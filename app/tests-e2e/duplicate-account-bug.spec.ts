// Regression spec for the duplicate-account-on-reimport bug.
//
// Pre-fix: importing the same multi-account CSV multiple times spawned a fresh
// (empty) account row on every pass, because insertAccount slug-deduped against
// the IDs already present but used a different slug for each timestamped run.
// Justin's DB ended up with 16 JP Morgan accounts (4 unique * 4 re-imports), 12
// of which were empty skeletons.
//
// Post-fix: upsertAccountByFingerprint dedupes at insert time by (brokerage,
// last4), so repeated imports of the same CSV land on the canonical row and
// the rowHash dedupe inside insertTransactions takes care of the rest.
//
// This spec exercises that contract end-to-end with the real JPM CSV the
// user reported the bug against. Skips when the local CSV isn't present (the
// fixture is gitignored).

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

// Re-import the same JPM CSV via the Add Account flow. Walks Accounts page ->
// Add an Account -> drop file -> Import all -> done.
async function reimportJpmViaAddAccount(page: Page): Promise<void> {
  // Click the "Add Account" entry in the left sidebar (rendered as a div).
  await page.locator('.nav-item').filter({ hasText: /^Add Account$/i }).click();
  // Drop the file. The first <input type=file> is the dropzone.
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(JPM_PATH);
  // Multi-account picker step: click "Import all N".
  await expect(page.getByRole('button', { name: /Import all/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Import all/i }).click();
  // Wait for the "Saved." done screen.
  await expect(page.getByText(/^Saved\.$/)).toBeVisible({ timeout: 30_000 });
}

async function countJpmAccountsOnAccountsPage(page: Page): Promise<number> {
  await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
  // The brokerage-group head meta carries the "N accounts" text. Pull it from
  // the JP Morgan group specifically.
  const jpmGroup = page
    .locator('.brokerage-group')
    .filter({ hasText: /JP Morgan/i })
    .first();
  await expect(jpmGroup).toBeVisible({ timeout: 5_000 });
  // The row containing each non-add account inside the group.
  const accountRows = jpmGroup.locator('.brokerage-account-row');
  return await accountRows.count();
}

test.describe('Matmon duplicate-account regression', () => {
  test.beforeEach(async ({ page }) => {
    if (!existsSync(JPM_PATH)) {
      // Fixture is gitignored. Skip rather than fail on machines without it.
      test.skip();
    }
    await startCold(page);
  });

  test('importing the same JPM CSV three times leaves exactly the original account count', async ({
    page,
  }) => {
    // Pass 1: onboarding with the real JPM CSV. This is the initial import.
    await walkOnboardingWithJpm(page);

    // Sanity: at least one JPM account landed.
    const afterOnboarding = await countJpmAccountsOnAccountsPage(page);
    expect(afterOnboarding).toBeGreaterThan(0);
    const expected = afterOnboarding;

    // Pass 2: re-import the SAME CSV via Add Account. Pre-fix this would
    // double the JPM account count.
    await reimportJpmViaAddAccount(page);
    // Click "Reload to see it" so the in-memory portfolio refresh fires.
    await page.getByRole('button', { name: /Reload to see it/i }).click();
    const afterSecond = await countJpmAccountsOnAccountsPage(page);
    expect(afterSecond).toBe(expected);

    // Pass 3: do it AGAIN. Still no duplicates.
    await reimportJpmViaAddAccount(page);
    await page.getByRole('button', { name: /Reload to see it/i }).click();
    const afterThird = await countJpmAccountsOnAccountsPage(page);
    expect(afterThird).toBe(expected);

    // Every visible JPM account row should carry a non-zero dollar value,
    // confirming that nothing got demoted to a $0 skeleton row.
    const jpmGroup = page
      .locator('.brokerage-group')
      .filter({ hasText: /JP Morgan/i })
      .first();
    const rows = jpmGroup.locator('.brokerage-account-row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const text = await rows.nth(i).textContent();
      expect(text).toBeTruthy();
      // Skeleton rows pre-fix showed "$0.00". The fingerprint dedupe should
      // prevent any from appearing; the AccountsView filter is a second line
      // of defense even if dedupe misses.
      expect(text).not.toMatch(/\$0\.00\b/);
    }
  });
});
