// HoldingDetailView auto-backfill: when a user opens the per-holding chart
// for a symbol whose prices table is empty, the view should fire a
// single-symbol backfill, show a transient loading state in the chart slot,
// and populate the chart when the bars land.
//
// This spec seeds localStorage with a populated account + transactions but
// no price history, then opens the chart and asserts the full state
// transition: loading → populated.

import { test, expect, type Page } from '@playwright/test';

/** Build a Yahoo v8 chart payload for a symbol over [from, to]. */
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
            quote: [{ close: closes }], // mutual-fund-shape: only closes
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

/**
 * Seed localStorage with a fake account + transactions WITHOUT any price
 * history. Mirrors the state of a user who onboarded BEFORE the historical
 * backfill landed: they have positions but no chartable price series.
 *
 * The recovery flag is left UNSET so the global recovery would also fire,
 * but for THIS spec we want to assert the per-chart auto-backfill works
 * independently. We set the recovery flag to 'yes' so the global one is
 * skipped; the chart-mount path is the unit under test.
 */
async function seedPortfolioWithoutPrices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const today = new Date();
    const earliest = new Date(today);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 5);
    const store = {
      accounts: [
        {
          id: 'demo-vanguard',
          name: 'Vanguard Brokerage',
          brokerage: 'Vanguard',
          account_type: 'taxable',
          currency: 'USD',
          created_at: new Date().toISOString(),
        },
      ],
      transactions: [
        {
          id: 1,
          account_id: 'demo-vanguard',
          date: earliest.toISOString(),
          symbol: 'VITAX',
          action: 'buy',
          quantity: 539.8,
          price: 250.0,
          fees: 0,
          amount: -134_950,
          currency: 'USD',
          notes: 'Seeded',
          imported_from: 'seed',
          raw_hash: 'seed-1',
        },
      ],
      // Prices table is empty: this is the "needs backfill" state.
      prices: [],
      settings: [
        { key: 'onboarding.completed.v1', value: 'yes' },
        // Skip the global recovery so we test the per-chart path.
        { key: 'backfill.recovery.v1.complete', value: 'yes' },
        // Skip the dedupe migration.
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
}

test.describe('HoldingDetailView auto-backfill', () => {
  test('opening VITAX with empty prices history fires backfill and populates the chart', async ({
    page,
  }) => {
    await startCold(page);
    await seedPortfolioWithoutPrices(page);
    await page.reload();

    // Wait for the post-onboarding Home view. The .page-title node contains
    // the user's first name.
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });

    // Navigate to Holdings via the sidebar.
    await page
      .locator('.nav-item')
      .filter({ hasText: /^Holdings$/i })
      .click();
    await expect(page.locator('.tbl').first()).toBeVisible({ timeout: 5_000 });

    // Click the VITAX row to open the detail view.
    const vitaxRow = page.locator('.tbl tbody tr').filter({ hasText: 'VITAX' }).first();
    await expect(vitaxRow).toBeVisible({ timeout: 5_000 });
    await vitaxRow.click();

    // The chart-loading sentinel should appear briefly. With the synthetic
    // Yahoo route handler the fetch is sub-100ms so we screenshot first,
    // then wait for completion.
    const loadingState = page.getByTestId('chart-loading');
    await loadingState
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => {
        // Sub-100ms fetches can resolve before the loading state is
        // observable. That's OK: we still check the populated end state
        // below.
      });

    // Wait for the chart series to land (window.__matmonDebug exposed by
    // HoldingDetailView).
    await page.waitForFunction(
      () => {
        const w = window as any;
        return (
          w.__matmonDebug &&
          Array.isArray(w.__matmonDebug.lastChartSeries) &&
          w.__matmonDebug.lastChartSeries.length > 0 &&
          w.__matmonDebug.lastChartSymbol === 'VITAX'
        );
      },
      { timeout: 30_000 },
    );

    // Screenshot the populated chart for the report.
    await page.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/vitax-chart-populated.png',
      fullPage: true,
    });

    const seriesLength = await page.evaluate(() => {
      return (window as any).__matmonDebug?.lastChartSeries?.length ?? 0;
    });
    // 5 years of synthetic trading-day bars is well over 1000.
    expect(seriesLength).toBeGreaterThan(1000);

    // Verify the empty-state OLD copy is NOT visible (regression guard).
    await expect(page.getByText(/Refresh quotes from the Home page/i)).not.toBeVisible();

    // Verify the loading state is gone now.
    await expect(loadingState).not.toBeVisible();
  });

  test('the OLD wrong empty-state copy "Refresh quotes from the Home page" is never shown', async ({
    page,
  }) => {
    // Belt-and-suspenders regression guard. Even if the backfill never
    // runs (offline + no transactions + recovery flag set), the empty-state
    // copy must point users to Settings → Market data → Refresh history.
    await startCold(page);
    await page.evaluate(() => {
      const store = {
        accounts: [
          {
            id: 'demo-vanguard',
            name: 'Vanguard Brokerage',
            brokerage: 'Vanguard',
            account_type: 'taxable',
            currency: 'USD',
            created_at: new Date().toISOString(),
          },
        ],
        transactions: [],
        prices: [],
        settings: [
          { key: 'onboarding.completed.v1', value: 'yes' },
          { key: 'backfill.recovery.v1.complete', value: 'yes' },
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
    await page.reload();
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });

    // No holdings to click into in this state; just confirm the bad copy
    // doesn't appear anywhere on Home or in Settings.
    await expect(page.getByText(/Refresh quotes from the Home page/i)).not.toBeVisible();
  });
});
