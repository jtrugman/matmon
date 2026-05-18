// Real-CSV onboarding end-to-end specs. Drives a Chromium against the live
// vite dev server with the actual JPM multi-account holdings export Justin
// runs in production. If any expect() fails the bug is in production code.
//
// Test A walks the entire onboarding flow with the real JPM file and asserts
// that the post-onboarding Home view shows the user's name, a non-zero total,
// and a JP Morgan brokerage tile with holding rows.
//
// Test B reruns the same flow then issues a page reload and asserts that the
// user lands directly on Home (not back in onboarding) with state intact.

import { test, expect, type Page } from '@playwright/test';

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
  // Welcome
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible();
  await page.getByRole('button', { name: /Let's set you up/i }).click();

  // Profile
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Goal: leave defaults
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Account upload: feed the real JPM file.
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(JPM_PATH);

  // JPM multi-account export: wait for at least one UploadRow to render with
  // a recognized brokerage label. The header "Ready to import" appears once
  // every detected account has been turned into an UploadRow.
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });

  // Click "Finish setup".
  await page.getByRole('button', { name: /Finish setup/i }).click();

  // STEP 5 (Done screen) MUST appear within 5 seconds. The "Take me to Matmon"
  // button is unique to the Done screen, so we anchor on it (the eyebrow
  // "You're set" also appears in the rail label, which would match twice).
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Welcome, Justin/i)).toBeVisible();

  // Click "Take me to Matmon".
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
}

test.describe('Matmon real-CSV onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await startCold(page);
  });

  test('Test A: onboarding with the real JPM holdings CSV ends on a populated Home', async ({ page }) => {
    await walkOnboardingWithJpm(page);

    // Home page renders the greeting with Justin's name.
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

    // Total figure: must be > $0, not NaN, not the em-dash fallback. The exact
    // dollar amount depends on the snapshot in the JPM file, so we assert on
    // the absence of the failure signatures rather than a fixed number.
    const totalText = await page.locator('.total-figure').first().textContent();
    expect(totalText).toBeTruthy();
    expect(totalText).not.toContain('$0.00');
    expect(totalText).not.toMatch(/^\$0$/);
    expect(totalText).not.toContain('NaN');
    expect((totalText ?? '').trim()).not.toBe('--');

    // Brokerages tile: JP Morgan must show up.
    await expect(page.getByText(/JP Morgan/i).first()).toBeVisible();

    // Holdings: navigate via the sidebar (which renders nav items as <div>,
    // not <button>, so we click by visible text). The Holdings table should
    // render at least one row from the JPM file.
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });
    const holdingRows = page.locator('.tbl tbody tr');
    expect(await holdingRows.count()).toBeGreaterThan(0);

    // Screenshot proof of Home with Justin's name + non-zero total. Captures
    // the full page after navigating back so reviewers can see the headline.
    await page.locator('.nav-item').filter({ hasText: /^Home$/i }).click();
    await expect(page.locator('.page-title')).toContainText('Justin');
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/after-onboarding.png',
      fullPage: true,
    });
  });

  test('Test B: after onboarding, a full page reload keeps the user on Home with data intact', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);

    // Sanity: landed on Home with Justin's name.
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

    // Reload the page (simulates relaunch on the browser-shim persistence model).
    await page.reload();

    // The onboarding intro must NOT come back, and the greeting must still
    // include Justin's name. The "Welcome to Matmon" intro only renders in
    // the OnboardingView; its absence after a reload proves the
    // onboarding.completed.v1 flag survived persistence.
    await expect(page.getByText(/Welcome to Matmon/i)).not.toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

    // And the total figure should still reflect real, non-zero data.
    const totalText = await page.locator('.total-figure').first().textContent();
    expect(totalText).toBeTruthy();
    expect(totalText).not.toContain('$0.00');
    expect(totalText).not.toMatch(/^\$0$/);
    expect((totalText ?? '').trim()).not.toBe('--');
  });
});
