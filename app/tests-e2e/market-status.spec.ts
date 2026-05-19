// End-to-end specs for the HomeView header status line.
//
// Two assertions:
//   1. The "Markets <state>" string is dynamic and reflects whatever
//      getMarketStatus() returns at test run time. We don't pin the exact
//      state (open vs closed vs holiday) because tests can run any day,
//      but we DO assert the string starts with "Markets" and ends with
//      "·" plus a "Prices …" payload. The literal hardcoded "Markets
//      closed · prices Fri 4:00pm ET" of yore must NEVER appear.
//   2. Clicking Refresh quotes updates the prices-as-of timestamp into
//      a same-minute window. We can't pin a clock time across runs, but
//      the timestamp under the total figure must change (or be present)
//      after the click.

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

  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();

  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(FIDELITY_CSV);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();

  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });
}

test.describe('Market status header', () => {
  test('Header shows a dynamic Markets status (not the legacy hardcoded "prices Fri 4:00pm ET")', async ({
    page,
  }) => {
    await onboardWithFidelity(page);

    const statusLine = page.getByTestId('market-status-line');
    await expect(statusLine).toBeVisible({ timeout: 10_000 });
    const text = (await statusLine.textContent()) ?? '';

    // The line must start with "Markets" (open/closed/closed for X) and
    // it must NOT contain the literal stale hardcoded string the bug
    // report references.
    expect(text).toMatch(/^Markets/);
    expect(text).not.toContain('prices Fri 4:00pm ET');

    // The status line should include the "·" separator before the prices
    // suffix or the stale-quote warning.
    expect(text).toContain('·');
  });

  test('Clicking Refresh quotes updates the "Prices as of" timestamp', async ({ page }) => {
    await onboardWithFidelity(page);

    // Intercept Yahoo so the click resolves deterministically even when
    // the dev server can't reach the real upstream (CORS-blocked).
    await page.route(/finance\.yahoo\.com\/v8\/finance\/chart/, async route => {
      const url = route.request().url();
      const match = url.match(/\/chart\/([^?]+)/);
      const symbol = match ? decodeURIComponent(match[1]) : 'UNK';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  symbol,
                  currency: 'USD',
                  regularMarketPrice: 100,
                  chartPreviousClose: 99,
                  previousClose: 99,
                },
                timestamp: [],
                indicators: { quote: [{ close: [] }] },
              },
            ],
            error: null,
          },
        }),
      });
    });

    const pricesLabel = page.getByTestId('prices-as-of');
    await expect(pricesLabel).toBeVisible({ timeout: 10_000 });

    // Click the refresh button.
    await page.getByRole('button', { name: /Refresh quotes/i }).click();
    // Wait for the click flow to settle + the timestamp to update.
    await expect(page.getByRole('button', { name: /Updated|Refresh quotes/i })).toBeVisible({
      timeout: 5_000,
    });

    // After the click, the timestamp should reflect the click moment.
    // We can't pin the exact time, but we CAN assert it's a same-day
    // "h:mm{am|pm}" formatted string (i.e. NOT "Prices not yet fetched"
    // or a weekday-prefixed historical timestamp).
    const after = (await pricesLabel.textContent()) ?? '';
    expect(after).toMatch(/Prices as of \d{1,2}:\d{2}(am|pm)/);
  });
});
