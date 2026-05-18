// End-to-end specs that prove Refresh quotes actually does something and that
// the Settings > Privacy "Recent outbound calls" panel reflects live network
// activity. Justin reported both as silent bugs: the button looked dead, and
// the panel never matched what was on the wire.
//
// All three specs onboard with a real Fidelity CSV so there are holdings to
// refresh. We then intercept Yahoo Finance and logo.dev requests so we can
// prove the click fired traffic, and we drive the UI assertions against the
// actual rendered state (button label, spinner, network log rows).

import { test, expect, type Page } from '@playwright/test';

const FIDELITY_CSV = '/Users/justintrugman/Development/matmon/app/example_csv/multiple_accounts_fidelity.csv';

async function onboardWithFidelity(page: Page): Promise<void> {
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

  // Step 0: Welcome
  await page.getByRole('button', { name: /Let's set you up/i }).click();

  // Step 1: Profile
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Step 2: Goal (defaults)
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Step 3: Upload CSV
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(FIDELITY_CSV);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();

  // Step 4: Done
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();

  // Home
  await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });
}

test.describe('Refresh quotes and network log', () => {
  test('Test 1: clicking Refresh quotes triggers Yahoo chart requests on every click (no silent cache short-circuit)', async ({
    page,
  }) => {
    await onboardWithFidelity(page);

    // Intercept Yahoo Finance chart requests. We intentionally narrow to the
    // chart endpoint (not logo.dev) so we're proving QUOTE fetches, not
    // logo-prefetch leftovers from the onboarding import.
    const yahooChartRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (/finance\.yahoo\.com\/v8\/finance\/chart/.test(url)) {
        yahooChartRequests.push(url);
      }
    });

    // Sanity check: there's a total figure rendered. We do not assert the
    // value changes because the live quote may match the CSV last price.
    const totalBefore = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(totalBefore).toBeTruthy();
    expect(totalBefore).not.toContain('NaN');

    // First click: should fire Yahoo chart requests immediately.
    await page.getByRole('button', { name: /Refresh quotes/i }).click();
    await page.waitForTimeout(2500);
    const firstClickCount = yahooChartRequests.length;
    expect(firstClickCount).toBeGreaterThan(0);

    // Second click within the 5-minute cache TTL: WITHOUT a force flag the
    // provider's quote cache short-circuits the click into a no-op, which is
    // exactly the "nothing happens" symptom Justin reported. The fix passes
    // { force: true } from the manual refresh path so the user always gets
    // fresh requests when they explicitly click the button.
    await page.getByRole('button', { name: /Refresh quotes|Refreshing|Updated/i }).click();
    await page.waitForTimeout(2500);
    const secondClickCount = yahooChartRequests.length;

    // The second click MUST also trigger new chart requests. If it doesn't,
    // the button is silent for the user (no visible feedback + no network).
    expect(secondClickCount).toBeGreaterThan(firstClickCount);

    // After both refreshes, the total figure should still render a real value
    // (not NaN, not the em-dash fallback).
    const totalAfter = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(totalAfter).toBeTruthy();
    expect(totalAfter).not.toContain('NaN');
    expect(totalAfter.trim()).not.toBe('--');
  });

  test('Test 2: Settings Privacy panel shows live network log entries after quote refresh', async ({
    page,
  }) => {
    await onboardWithFidelity(page);

    // Trigger a refresh so the network log has fresh entries.
    await page.getByRole('button', { name: /Refresh quotes/i }).click();
    // Let the Yahoo round-trips land in the ring buffer.
    await page.waitForTimeout(2500);

    // Navigate to Settings via the sidebar (rendered as a div, click by text).
    await page.locator('.nav-item').filter({ hasText: /^Settings$/i }).click();

    // The "Recent outbound calls" section should now have at least one row
    // referencing query1.finance.yahoo.com. We give it a generous window
    // because the panel re-renders via useSyncExternalStore and we want to
    // catch slow propagation rather than flake.
    await expect(page.getByText(/query1\.finance\.yahoo\.com/i).first()).toBeVisible({ timeout: 5_000 });

    // And the old hardcoded "12 symbols · 388 B" placeholder must NOT be
    // present. (Sanity check that we're rendering real data, not a stub.)
    await expect(page.getByText(/12 symbols · 388 B/i)).not.toBeVisible();

    // Screenshot proof: capture Settings > Privacy showing real Yahoo entries.
    // Saved next to the spec rather than under test-results/ (which Playwright
    // wipes between runs) so the artifact stays around for review.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/refresh-quotes-network-log.png',
      fullPage: true,
    });
  });

  test('Test 3: Refresh quotes shows an inline spinner / status while fetching', async ({ page }) => {
    await onboardWithFidelity(page);

    // We want to observe the in-flight UI state: label changes from "Refresh
    // quotes" to "Refreshing..." while the await is pending. Yahoo can be
    // sub-second so we intercept and HOLD the response until we've grabbed
    // the spinner screenshot.
    let release: (() => void) | null = null;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    await page.route(/finance\.yahoo\.com\/v8\/finance\/chart/, async route => {
      await held;
      await route.continue();
    });

    const button = page.getByRole('button', { name: /Refresh quotes/i });
    await expect(button).toBeVisible();

    // Click and immediately assert the busy state appears. The label should
    // change to "Refreshing..." and the button should be visibly disabled.
    await button.click();

    // The button text should switch within a single tick. We're holding the
    // network so there's no race with completion.
    await expect(page.getByRole('button', { name: /Refreshing/i })).toBeVisible({ timeout: 2_000 });

    // Screenshot proof of the spinner state in flight. Saved next to the spec
    // for the same reason as Test 2: test-results/ is wiped between runs.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/refresh-quotes-spinner.png',
      fullPage: false,
    });

    // Release the held requests so the refresh can complete.
    if (release) release();

    // After completion, the button label should return to "Refresh quotes"
    // (or a brief "Updated" status). The transient "Refreshing..." state
    // should clear.
    await expect(page.getByRole('button', { name: /Refresh quotes|Updated/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});
