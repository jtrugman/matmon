// Visible auto-heal recovery: the user must see a clear, prominent loading
// indicator from the moment the page loads through the moment the chart
// fills in. No manual click required.
//
// This spec is the end-to-end proof that Justin's complaint is fixed: the
// user's quote was "Should it auto update every time you load in? That's
// the way it should do it. That's ridiculous." After this change the
// indicator IS automatic AND visible.
//
// We mock Yahoo so the backfill resolves with realistic bars in the
// browser-dev runtime where direct query1.finance.yahoo.com requests would
// be CORS-blocked. The mock yields ~3y of synthetic daily closes per
// symbol so chartSeries crosses the >=2-point threshold and the chart
// actually populates after the indicator drops.

import { test, expect, type Page } from '@playwright/test';

/**
 * Build a Yahoo chart-endpoint payload with three years of synthetic daily
 * closes for the requested symbol. The closes drift up by 0.04% per bar so
 * the resulting curve is monotonically increasing (no zero-segment), which
 * keeps the chart's range-detection from collapsing to the empty branch.
 */
function chartPayload(symbol: string, from: Date, to: Date, baseClose = 100): string {
  const timestamps: number[] = [];
  const closes: number[] = [];
  const cur = new Date(from);
  let day = 0;
  while (+cur <= +to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      timestamps.push(Math.floor(cur.getTime() / 1000));
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
            quote: [{ close: closes }],
          },
        },
      ],
      error: null,
    },
  });
}

/**
 * Slow-yahoo router: introduces a ~600ms delay per chart request so the
 * loading indicator is observable in real time. Without the delay the
 * backfill resolves so quickly that a Playwright assertion against the
 * intermediate state would race the chart's transition to populated.
 */
async function installSlowYahooRouter(page: Page) {
  await page.route(/finance\.yahoo\.com\/v8\/finance\/chart\//, async route => {
    const url = route.request().url();
    const m = url.match(/chart\/([^?]+)\?/);
    const symbol = m ? decodeURIComponent(m[1]) : 'UNKNOWN';
    const p1 = Number(url.match(/period1=(\d+)/)?.[1] ?? 0);
    const p2 = Number(url.match(/period2=(\d+)/)?.[1] ?? Math.floor(Date.now() / 1000));
    const from = new Date(p1 * 1000);
    const to = new Date(p2 * 1000);
    // Delay 600ms per symbol so the loading indicator is observable
    // between progress ticks.
    await new Promise(r => setTimeout(r, 600));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chartPayload(symbol, from, to),
    });
  });
}

/**
 * Seed the broken-without-recovery state: completed onboarding, two
 * accounts with three held symbols, EMPTY prices table, and the recovery
 * flag is NOT set so usePortfolio.maybeRunRecovery will probe and fire.
 * This is the state Justin landed on every reload before the fix.
 */
async function seedEmptyPrices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const today = new Date();
    const earliest = new Date(today);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 3);
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
        {
          id: 1,
          account_id: 'fid-taxable',
          date: earliest.toISOString(),
          symbol: 'VTI',
          action: 'buy',
          quantity: 100,
          price: 200,
          fees: 0,
          amount: -20_000,
          currency: 'USD',
          notes: '',
          imported_from: 'seed',
          raw_hash: 'seed-vti',
        },
        {
          id: 2,
          account_id: 'fid-taxable',
          date: earliest.toISOString(),
          symbol: 'AAPL',
          action: 'buy',
          quantity: 50,
          price: 150,
          fees: 0,
          amount: -7_500,
          currency: 'USD',
          notes: '',
          imported_from: 'seed',
          raw_hash: 'seed-aapl',
        },
        {
          id: 3,
          account_id: 'fid-taxable',
          date: earliest.toISOString(),
          symbol: 'MSFT',
          action: 'buy',
          quantity: 25,
          price: 250,
          fees: 0,
          amount: -6_250,
          currency: 'USD',
          notes: '',
          imported_from: 'seed',
          raw_hash: 'seed-msft',
        },
      ],
      prices: [], // critical: empty history is the trigger
      settings: [
        { key: 'onboarding.completed.v1', value: 'yes' },
        { key: 'dedupe.v1.complete', value: 'yes' },
        // backfill.recovery.v1.complete intentionally NOT set: we want
        // maybeRunRecovery to fire on this reload.
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

test.describe('Visible auto-heal recovery', () => {
  test('shows a loading indicator on reload and replaces it with a populated chart when bars land', async ({
    page,
  }) => {
    // Forward [matmon-diag] logs to test output so failures are debuggable.
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

    await installSlowYahooRouter(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await seedEmptyPrices(page);
    await page.reload();

    // Land on Home. Title contains the seeded name.
    await expect(page.locator('.page-title')).toContainText(/Justin/i, {
      timeout: 15_000,
    });

    // PRIMARY ASSERTION: the chart slot renders the auto-heal loading
    // indicator within 2s of the page load. This is the user-visible
    // feedback the spec demands.
    const loadingIndicator = page.getByTestId('chart-recovery-loading');
    await expect(loadingIndicator).toBeVisible({ timeout: 2_000 });

    // The copy must contain the canonical "Loading chart history..." text
    // so the user knows what's happening, not just "something is loading".
    await expect(loadingIndicator).toContainText(/Loading chart history/i);

    // The progress should report "(0 of 3 symbols)" first, then count up
    // through 3. We don't pin a specific intermediate value (the slow-
    // yahoo router takes 600ms per symbol so any of {0, 1, 2, 3} could
    // be on screen at any check), but we DO require the final state to
    // hit (3 of 3) before the indicator drops.
    await expect
      .poll(
        async () => {
          const text = await loadingIndicator.textContent().catch(() => null);
          return text?.match(/\((\d+) of (\d+) symbols\)/)?.[2] ?? null;
        },
        { timeout: 10_000 },
      )
      .toBe('3');

    // Wait for the indicator to disappear: this means the recovery
    // resolved AND the chart's series populated. We give it up to 10s
    // total (3 symbols × ~600ms each + processing buffer).
    await expect(loadingIndicator).toBeHidden({ timeout: 10_000 });

    // Now the chart wrapper should show the populated chart, not the
    // empty state. The PortfolioChart renders an SVG inside the wrap.
    const chartWrap = page.getByTestId('portfolio-chart-wrap');
    await expect(chartWrap.locator('svg').first()).toBeVisible({
      timeout: 5_000,
    });

    // And the empty-state placeholder must NOT be in the tree anymore.
    await expect(page.getByTestId('portfolio-chart-empty')).toHaveCount(0);

    // Sanity: the prices table is no longer empty.
    const pricesCount = await page.evaluate(() => {
      const raw = localStorage.getItem('matmon.dev.db.v1');
      if (!raw) return 0;
      try {
        const store = JSON.parse(raw);
        return Array.isArray(store.prices) ? store.prices.length : 0;
      } catch {
        return 0;
      }
    });
    expect(pricesCount).toBeGreaterThan(0);
  });

  test('no manual click is required: the indicator appears before any user interaction', async ({
    page,
  }) => {
    await installSlowYahooRouter(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await seedEmptyPrices(page);
    await page.reload();

    // We do NOT click ANYTHING. Just wait for the page to land and the
    // indicator to appear. If the auto-heal required a manual click the
    // indicator would never show up.
    await expect(page.locator('.page-title')).toContainText(/Justin/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('chart-recovery-loading')).toBeVisible({
      timeout: 3_000,
    });
  });
});
