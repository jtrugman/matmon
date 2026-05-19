// Screenshot capture for the auto-heal visible-loading work. Drives the
// same flow as auto-heal-visible.spec.ts but with a slower Yahoo router
// (1.5s per symbol) so the loading indicator stays on-screen long enough
// for an artifact-quality screenshot. Saves two PNGs:
//
//   1. screenshots/auto-heal-loading.png: mid-flight indicator
//   2. screenshots/auto-heal-populated.png: chart after backfill resolves
//
// This file is NOT a regression check (the assertions live in
// auto-heal-visible.spec.ts). It exists so Justin's review has a concrete
// visual record alongside the test count.

import { test, type Page } from '@playwright/test';

function chartPayload(symbol: string, from: Date, to: Date, baseClose = 100): string {
  const timestamps: number[] = [];
  const closes: number[] = [];
  const cur = new Date(from);
  let day = 0;
  while (+cur <= +to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      timestamps.push(Math.floor(cur.getTime() / 1000));
      // Sin-wave overlay so the populated chart has visual interest.
      closes.push(baseClose * (1 + day * 0.0006 + 0.08 * Math.sin(day / 30)));
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
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error: null,
    },
  });
}

async function installVerySlowYahooRouter(page: Page) {
  await page.route(/finance\.yahoo\.com\/v8\/finance\/chart\//, async route => {
    const url = route.request().url();
    const m = url.match(/chart\/([^?]+)\?/);
    const symbol = m ? decodeURIComponent(m[1]) : 'UNKNOWN';
    const p1 = Number(url.match(/period1=(\d+)/)?.[1] ?? 0);
    const p2 = Number(url.match(/period2=(\d+)/)?.[1] ?? Math.floor(Date.now() / 1000));
    const from = new Date(p1 * 1000);
    const to = new Date(p2 * 1000);
    // 1.2s/symbol so the loading indicator is on-screen long enough to
    // screenshot. With 5 held symbols the user sees the progress count up.
    await new Promise(r => setTimeout(r, 1200));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chartPayload(symbol, from, to),
    });
  });
}

async function seedFiveHoldings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const today = new Date();
    const earliest = new Date(today);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 3);
    const baseTx = (id: number, symbol: string, qty: number, price: number) => ({
      id,
      account_id: 'fid-taxable',
      date: earliest.toISOString(),
      symbol,
      action: 'buy',
      quantity: qty,
      price,
      fees: 0,
      amount: -(qty * price),
      currency: 'USD',
      notes: '',
      imported_from: 'seed',
      raw_hash: `seed-${symbol}`,
    });
    const store = {
      accounts: [
        {
          id: 'fid-taxable',
          name: 'Fidelity Brokerage',
          brokerage: 'Fidelity',
          account_type: 'taxable',
          currency: 'USD',
          created_at: new Date().toISOString(),
        },
      ],
      transactions: [
        baseTx(1, 'VTI', 100, 200),
        baseTx(2, 'AAPL', 50, 150),
        baseTx(3, 'MSFT', 25, 250),
        baseTx(4, 'GOOG', 10, 130),
        baseTx(5, 'AMZN', 20, 180),
      ],
      prices: [],
      settings: [
        { key: 'onboarding.completed.v1', value: 'yes' },
        { key: 'dedupe.v1.complete', value: 'yes' },
      ],
      user_profile: [
        {
          id: 1,
          name: 'Justin',
          birth_year: 1990,
          retire_age: 65,
          household: 'single',
          theme: 'light',
        },
      ],
      goal_scenarios: [],
      milestones: [],
    };
    localStorage.setItem('matmon.dev.db.v1', JSON.stringify(store));
  });
}

test.describe('auto-heal screenshot capture', () => {
  test('captures loading-indicator + populated-chart screenshots', async ({ page }) => {
    await installVerySlowYahooRouter(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await seedFiveHoldings(page);
    await page.reload();

    // Wait for the auto-heal loading indicator to appear.
    await page.getByTestId('chart-recovery-loading').waitFor({
      state: 'visible',
      timeout: 5_000,
    });
    // Let it tick to a non-zero count so the screenshot shows "X of 5".
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chart-recovery-loading"]');
        const m = el?.textContent?.match(/\((\d+) of/);
        return m ? Number(m[1]) >= 1 : false;
      },
      { timeout: 6_000 },
    );
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/auto-heal-loading.png',
      fullPage: false,
    });

    // Wait for the chart to fully populate, then take the after shot.
    await page.getByTestId('chart-recovery-loading').waitFor({
      state: 'hidden',
      timeout: 15_000,
    });
    // Give the chart a beat to render its SVG.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/auto-heal-populated.png',
      fullPage: false,
    });
  });
});
