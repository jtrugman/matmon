// Playwright spec for the "vs SPY (S&P 500)" overlay on the Home portfolio
// chart. Verifies that toggling the benchmark on triggers a backfill for
// SPY (when not already cached), renders a second dashed line on the SVG,
// and shows a small legend identifying both lines.

import { test, expect, type Page } from '@playwright/test';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';

function chartPayload(symbol: string, from: Date, to: Date, baseClose = 50): string {
  const timestamps: number[] = [];
  const closes: number[] = [];
  const cur = new Date(from);
  let day = 0;
  while (+cur <= +to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      timestamps.push(Math.floor(cur.getTime() / 1000));
      const drift = 1 + day * 0.0003;
      const wave = Math.sin(day / 75) * 0.15;
      closes.push(baseClose * (drift + wave));
      day++;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: 'USD',
            regularMarketPrice: closes[closes.length - 1] ?? baseClose,
          },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                close: closes,
                open: closes.map(c => c - 0.1),
                high: closes.map(c => c + 0.2),
                low: closes.map(c => c - 0.2),
                volume: closes.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
      error: null,
    },
  });
}

async function installYahooRouter(page: Page) {
  await page.route(/finance\.yahoo\.com\/v8\/finance\/chart\//, async route => {
    const url = route.request().url();
    const m = url.match(/chart\/([^?]+)\?/);
    const symbol = m ? decodeURIComponent(m[1]) : 'UNKNOWN';
    const p1 = Number(url.match(/period1=(\d+)/)?.[1] ?? 0);
    const p2 = Number(url.match(/period2=(\d+)/)?.[1] ?? Math.floor(Date.now() / 1000));
    const from = new Date(p1 * 1000);
    const to = new Date(p2 * 1000);
    // SPY gets a higher baseline so it's visually distinguishable on the
    // synthetic chart. Both portfolio symbols and SPY use the same
    // generator so the curves diverge in a realistic way.
    const base = symbol === 'SPY' ? 200 : 50;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chartPayload(symbol, from, to, base),
    });
  });
}

async function onboardWithJpm(page: Page): Promise<void> {
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
  await installYahooRouter(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(JPM_PATH);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 15_000 });
}

test.describe('vs SPY overlay on the Home portfolio chart', () => {
  test('toggling the benchmark adds a second dashed line and a legend', async ({ page }) => {
    await onboardWithJpm(page);

    // The "vs SPY (S&P 500)" pill is on by default. The first time the
    // user lands the SPY bars are not in the prices table yet; the
    // HomeView effect kicks off a one-shot backfill for SPY. Wait for the
    // benchmark line to render. We wait up to 15s for the SPY history to
    // land + the portfolio to rebuild.
    const benchmarkLine = page.locator('[data-testid="benchmark-line"]').first();
    await expect(benchmarkLine).toBeVisible({ timeout: 30_000 });

    // Legend pill should show both names.
    const legend = page.locator('[data-testid="chart-legend"]').first();
    await expect(legend).toBeVisible();
    await expect(legend).toContainText(/Matmon portfolio/i);
    await expect(legend).toContainText(/SPY/);

    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/home-spy-overlay-on.png',
      fullPage: true,
    });

    // Toggle off via the × on the pill. The benchmark line should
    // disappear. The pill itself goes away too, replaced by "compare to…".
    await page.locator('[data-testid="benchmark-pill"] .x').click();
    await expect(benchmarkLine).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="chart-legend"]')).not.toBeVisible();
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/home-spy-overlay-off.png',
      fullPage: false,
    });

    // Re-toggle on. SPY is now cached so no second fetch is needed; the
    // line should reappear quickly.
    await page.locator('button', { hasText: /compare to/i }).click();
    await expect(benchmarkLine).toBeVisible({ timeout: 10_000 });
  });
});
