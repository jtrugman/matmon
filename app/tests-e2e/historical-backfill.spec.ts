// End-to-end Playwright spec: prove the historical-price backfill landing
// during onboarding rewrites the chart from the +323% YTD garbage produced
// by the qty-accumulation proxy to a real mark-to-market NAV curve.
//
// `npm run dev` (browser shim) can't actually reach Yahoo because of CORS,
// so this suite intercepts /v8/finance/chart with `page.route` and serves
// synthetic daily-close payloads. That keeps the test deterministic and
// fast (no upstream rate-limit risk) while still exercising the full
// integration: importer + backfill + prices table + portfolio NAV builder
// + HomeView + HoldingDetailView. The same code path runs unchanged inside
// the Tauri app where the HTTP plugin sidesteps CORS.

import { test, expect, type Page } from '@playwright/test';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';

/**
 * Build a Yahoo v8 chart payload for a symbol over [from, to].
 * Closes are a deterministic ramp from `baseClose` so test assertions can
 * pin a target value. Weekends are skipped (mirrors Yahoo's trading-days-only
 * timestamps).
 */
function chartPayload(symbol: string, from: Date, to: Date, baseClose = 50): string {
  const timestamps: number[] = [];
  const closes: number[] = [];
  const cur = new Date(from);
  let day = 0;
  while (+cur <= +to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      timestamps.push(Math.floor(cur.getTime() / 1000));
      // Gentle ~+10% / year ramp so the resulting series is monotone-ish
      // and the YTD return falls in the +0% to +30% range for any given
      // year (no chance of accidentally tripping the |YTD| < 100% assertion).
      closes.push(baseClose * (1 + day * 0.0004));
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
  // Single route handler for every chart request. Parses period1/period2 +
  // symbol out of the URL, returns a synthetic payload.
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
  await installYahooRouter(page);
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

  // Click "Finish setup". This kicks off insertTransactions + the price
  // backfill. The backfill is AWAITED inside finishOnboarding so the
  // "Take me to Matmon" CTA can take a while when the intercepted chart
  // payloads are large (14 symbols × ~7-9 years of daily bars each).
  await page.getByRole('button', { name: /Finish setup/i }).click();

  // Allow up to 90s for the backfill loop to finish. With the synthetic
  // route handler each fetch is sub-100ms so this is overkill, but the
  // semaphore + sequential outer loop means at worst we serialize through
  // all 14 symbols.
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText(/Welcome, Justin/i)).toBeVisible();

  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 15_000 });
}

test.describe('Matmon historical-price backfill end-to-end', () => {
  test.beforeEach(async ({ page }) => {
    await startCold(page);
  });

  test('JPM holdings import: YTD/1Y are plausible numbers, not garbage', async ({ page }) => {
    await walkOnboardingWithJpm(page);

    // Capture an "after" screenshot for the report.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/historical-backfill-home.png',
      fullPage: true,
    });

    // Find the YTD return metric in the headline tile grid. The DOM
    // structure is: <div class="metric"> with <div class="metric-label">
    // text "YTD return", then <div class="metric-value">...% this year</div>.
    const ytdValueText = await page
      .locator('.metric', { hasText: 'YTD return' })
      .locator('.metric-value')
      .first()
      .textContent();
    expect(ytdValueText).toBeTruthy();
    // YTD might render as "--" if the user has no current-year data, which
    // is also acceptable (not the +323% garbage).
    if (ytdValueText && !ytdValueText.includes('--')) {
      const ytdMatch = ytdValueText.match(/([+-]?\d+\.?\d*)%/);
      expect(ytdMatch).toBeTruthy();
      const ytdPercent = parseFloat(ytdMatch![1]);
      // With a real mark-to-market series, YTD should be within +/-100%
      // in any normal market. The synthetic +0.04%/day ramp produces ~10%
      // annual returns, so YTD will be in the single digits to low teens.
      // The PRIOR bug was +323%, we just need it to be sane, not exact.
      expect(Math.abs(ytdPercent)).toBeLessThan(100);
    }

    // 1Y TWR (annualized) should also be < 100% absolute. PRIOR bug: +248%.
    const oneYearText = await page
      .locator('.metric', { hasText: '1Y return' })
      .locator('.metric-value')
      .first()
      .textContent();
    expect(oneYearText).toBeTruthy();
    if (oneYearText && !oneYearText.includes('--')) {
      const m = oneYearText.match(/([+-]?\d+\.?\d*)%/);
      expect(m).toBeTruthy();
      const onePct = parseFloat(m![1]);
      expect(Math.abs(onePct)).toBeLessThan(100);
    }
  });

  test('chart series for VGT has multi-year daily data going back to earliest tx', async ({
    page,
  }) => {
    await walkOnboardingWithJpm(page);

    // Navigate to Holdings, click into VGT.
    await page
      .locator('.nav-item')
      .filter({ hasText: /^Holdings$/i })
      .click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });

    // The Holdings table renders a row per (account, symbol). Click the
    // first VGT row to open the detail view.
    const vgtRow = page.locator('.tbl tbody tr').filter({ hasText: 'VGT' }).first();
    await expect(vgtRow).toBeVisible({ timeout: 5_000 });
    await vgtRow.click();

    // HoldingDetailView writes its chart series to window.__matmonDebug for
    // exactly this kind of introspection. Wait for the series to land.
    await page.waitForFunction(
      () => {
        const w = window as any;
        return (
          w.__matmonDebug &&
          Array.isArray(w.__matmonDebug.lastChartSeries) &&
          w.__matmonDebug.lastChartSymbol === 'VGT'
        );
      },
      { timeout: 10_000 },
    );

    const points = await page.evaluate(() => {
      return (window as any).__matmonDebug?.lastChartSeries?.length ?? 0;
    });
    // The JPM file's oldest VGT lot is from October 2021. Synthetic
    // backfill from 2021-10-04 to today is roughly 1100+ trading days.
    // We assert > 1000 as a generous floor that still catches a
    // completely-broken backfill (and the older test target of 1500 was
    // calibrated for VITAX, which the JPM CSV doesn't actually contain).
    expect(points).toBeGreaterThan(1000);
  });
});
