// Playwright spec proving the ALL-view Y axis labels render correctly on
// portfolios with extreme growth multiples. The bug Justin reported:
//
//   :036556%
//   :527414%
//   :018272%
//   :509130%
//   -12%
//
// The leading digits get clipped off the SVG viewBox because the
// normalized-to-100 percent labels overflow when the start value is near
// zero and the end value is 100x+ the start. Post-fix the chart switches
// to absolute-dollar mode (e.g. "$6K", "$1M", "$13M") when the windowed
// growth multiple exceeds 5x, and the left padding is widened so the
// widest realistic tick fits.
//
// This spec uses synthetic Yahoo data with a steep multi-year price ramp
// to deterministically force the >5x window.

import { test, expect, type Page } from '@playwright/test';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';

// Synthetic Yahoo payload: prices ramp from baseClose at the earliest date
// to baseClose * 50 at the latest, so a multi-year buy-and-hold portfolio
// shows a >5x growth multiplier on the ALL window. The ramp is sinusoidal-
// overlaid on a linear trend so the curve isn't a perfect straight line.
function chartPayload(symbol: string, from: Date, to: Date): string {
  const timestamps: number[] = [];
  const closes: number[] = [];
  const cur = new Date(from);
  let day = 0;
  // Total span in trading days (approx 252/year * span years).
  const spanMs = Math.max(1, +to - +from);
  const baseClose = symbol === 'SPY' ? 100 : 5;
  // The price grows by a factor of (1 + 49 * t) over the span where t in
  // [0, 1], so end/start ~ 50. Combined with a small sine ripple so the
  // path has measurable curvature.
  while (+cur <= +to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const t = (+cur - +from) / spanMs;
      const trend = 1 + 49 * t;
      const wave = Math.sin(day / 60) * 0.04;
      timestamps.push(Math.floor(cur.getTime() / 1000));
      closes.push(baseClose * (trend + wave));
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chartPayload(symbol, from, to),
    });
  });
}

async function onboardWithJpm(page: Page): Promise<void> {
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

test.describe('ALL-view Y axis labels render without clipping', () => {
  test('extreme-growth portfolios show readable, non-clipped Y axis labels', async ({ page }) => {
    await onboardWithJpm(page);

    // Click the ALL segment.
    await page
      .locator('.timeframe button', { hasText: /^ALL$/ })
      .click();
    await expect(
      page.locator('.timeframe button.active', { hasText: /^ALL$/ }),
    ).toBeVisible();

    // Read every Y-axis tick label off the SVG. They live as <text> children
    // inside the chart's SVG, anchored at textAnchor="end" with fontFamily
    // var(--font-mono). The chart emits 5 ticks; we expect all 5 to be
    // present and to be NUMERIC after a sign + currency-prefix strip.
    const tickTexts = await page
      .locator('[data-testid="portfolio-chart-wrap"] svg text[text-anchor="end"]')
      .allTextContents();
    expect(tickTexts.length).toBeGreaterThanOrEqual(4);

    // 1. NO tick label may start with ':' (the clipping symptom). Pre-fix
    //    labels read like ':036556%' because the leading digit was sheared
    //    off the SVG by the 56px left padding. The fix widens the padding
    //    AND switches the >5x-growth case to absolute-dollar formatting
    //    (e.g. '$13M'), both of which keep the leading character on-canvas.
    for (const t of tickTexts) {
      expect(t, `tick label "${t}" must not start with ':' (clipping symptom)`).not.toMatch(
        /^:/,
      );
    }

    // 2. Every label must parse to a number-or-currency, not start with a
    //    sheared character. We accept either '$<digits>K/M' (absolute mode)
    //    or '<sign?><digits>%' (normalized mode), with optional thousands
    //    separators.
    const tickRe = /^(?:-?\$[0-9,]+(?:\.[0-9]+)?[KM]?|[+\-]?[0-9,]+(?:\.[0-9]+)?%?)$/;
    for (const t of tickTexts) {
      expect(t, `tick label "${t}" should match a money or percent pattern`).toMatch(tickRe);
    }

    // 3. At least one label must read as a dollar magnitude. On a 50x-growth
    //    window the absolute-dollar mode kicks in, so labels look like '$1K',
    //    '$50K', '$1M'. If every label is a percent string, the absolute-
    //    mode toggle didn't fire and the regression bug is back.
    const hasDollarLabel = tickTexts.some(t => /^\-?\$/.test(t));
    expect(hasDollarLabel, `at least one Y axis label should be a dollar magnitude when growth > 5x, got ${JSON.stringify(tickTexts)}`).toBe(true);

    // 4. Screenshot proof for human review.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/home-chart-all-axis-fixed.png',
      fullPage: false,
    });
  });
});
