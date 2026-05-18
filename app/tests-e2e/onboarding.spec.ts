// End-to-end onboarding specs.
//
// These specs drive a real Chromium against `npm run dev`. The vitest suite
// covers every code path in isolation; this suite covers the *seams*:
//   1. Cold-boot the SPA, complete onboarding with a real CSV, assert that
//      Home shows the user's name (not "there") and a non-zero total.
//   2. Same flow without a CSV, then reload the page, assert state survives.
//   3. Clearing localStorage drops the user back to the onboarding intro
//      (sanity check on the persistence boundary).
//
// If any spec fails, the bug is in production code and not in this file.

import { test, expect } from '@playwright/test';

const FIDELITY_CSV = '/Users/justintrugman/Development/matmon/app/example_csv/multiple_accounts_fidelity.csv';

test.describe('Matmon onboarding end-to-end', () => {
  test.beforeEach(async ({ page }) => {
    // Forward browser console to the playwright reporter so the [matmon-diag]
    // logs we instrumented in driver.ts / repos.ts / seed.ts show up in the
    // playwright output. This is the difference between "test failed" and
    // "test failed and here's exactly which DB write didn't fire".
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
    // Clear any prior state so each test starts cold. We do this AFTER goto so
    // localStorage is reachable in the page's origin.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // Wait for the SPA to settle. The first paint may be the spinner shell
    // (onboarding === null), so we explicitly wait for either the welcome
    // screen or any other onboarding step header.
    await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
  });

  test('completes onboarding with a real CSV and lands on a populated Home', async ({ page }) => {
    // Step 0: Welcome
    await page.getByRole('button', { name: /Let's set you up/i }).click();

    // Step 1: Profile
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();

    // Step 2: Goal (default goal is fine)
    await page.getByRole('button', { name: /^Continue$/i }).click();

    // Step 3: Upload a real CSV
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(FIDELITY_CSV);
    await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Finish setup/i }).click();

    // Step 4: Done step. "You're set" appears in both the rail label AND the
    // welcome eyebrow, so we anchor on the unique CTA button instead.
    await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible();
    await page.getByRole('button', { name: /Take me to Matmon/i }).click();

    // Home should show Justin's name (the greeting was the symptom Justin first
    // reported: it rendered "Hey there" instead of "Hey Justin").
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });

    // Total figure must render and must not be the $0 / em-dash fallback. The
    // CSV has real buys so the portfolio value should be > 0.
    const totalFigure = page.locator('.total-figure').first();
    await expect(totalFigure).toBeVisible();
    const totalText = (await totalFigure.textContent()) ?? '';
    expect(totalText).not.toMatch(/^\$0(\.00)?$/);
    expect(totalText.trim()).not.toBe('--');
  });

  test('data persists across an in-app reload (localStorage survival)', async ({ page }) => {
    // Minimal onboarding, no CSV. We only need the name to survive.
    await page.getByRole('button', { name: /Let's set you up/i }).click();
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /Finish setup/i }).click();
    await page.getByRole('button', { name: /Take me to Matmon/i }).click();

    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });

    // Reload (simulates a relaunch in the browser shim's persistence model).
    await page.reload();

    // The onboarding intro must NOT come back, and the greeting must still
    // include Justin's name.
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });
    await expect(page.getByText(/Welcome to Matmon/i)).not.toBeVisible();
  });

  test('clearing localStorage resets the app back to onboarding (no zombie state)', async ({ page }) => {
    // Complete onboarding.
    await page.getByRole('button', { name: /Let's set you up/i }).click();
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /Finish setup/i }).click();
    await page.getByRole('button', { name: /Take me to Matmon/i }).click();
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });

    // Wipe storage and reload. We should land back in the welcome screen.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
  });
});
