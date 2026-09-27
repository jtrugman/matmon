// Backfill diagnostics panel (Settings > Privacy > Backfill diagnostics).
//
// This spec verifies the per-symbol coverage table renders, that the
// "Force re-run all" button clears the recovery flag, and that the auto-
// heal recovery fires again after the click. It seeds a "needs recovery"
// state via localStorage (same trick as portfolio-backfill-recovery.spec)
// then navigates to Settings and asserts the diagnostics table reflects
// the seeded prices table.

import { test, expect, type Page } from '@playwright/test';

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
 * Seed a portfolio with TWO held symbols and SOME prices coverage so the
 * recovery probe doesn't auto-fire (we want the diagnostics panel to
 * reflect a stable "after-recovery" state). The Force re-run button is
 * what re-triggers the recovery for the spec.
 */
async function seedPostRecoveryState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const today = new Date();
    const earliest = new Date(today);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 1);
    const bars: Array<{ symbol: string; date: string; close: number; currency: string; fetched_at: string; prev_close: number | null }> = [];
    // Seed 30 bars for each held symbol so the coverage table is non-empty.
    const fetchedAt = today.toISOString();
    for (const sym of ['VITAX', 'VTI']) {
      for (let i = 0; i < 30; i++) {
        const d = new Date(earliest);
        d.setUTCDate(d.getUTCDate() + i);
        bars.push({
          symbol: sym,
          date: d.toISOString(),
          close: 100 + i,
          currency: 'USD',
          fetched_at: fetchedAt,
          prev_close: null,
        });
      }
    }
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
          quantity: 100,
          price: 250.0,
          fees: 0,
          amount: -25_000,
          currency: 'USD',
          notes: 'Seeded',
          imported_from: 'seed',
          raw_hash: 'seed-vitax',
        },
        {
          id: 2,
          account_id: 'demo-vanguard',
          date: earliest.toISOString(),
          symbol: 'VTI',
          action: 'buy',
          quantity: 100,
          price: 200,
          fees: 0,
          amount: -20_000,
          currency: 'USD',
          notes: 'Seeded',
          imported_from: 'seed',
          raw_hash: 'seed-vti',
        },
      ],
      prices: bars,
      settings: [
        { key: 'onboarding.completed.v1', value: 'yes' },
        { key: 'dedupe.v1.complete', value: 'yes' },
        { key: 'backfill.recovery.v1.complete', value: 'yes' },
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

test.describe('Settings > Backfill diagnostics', () => {
  test('renders the per-symbol coverage table for held symbols', async ({ page }) => {
    await installYahooRouter(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await seedPostRecoveryState(page);
    await page.reload();

    // Land on Home.
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });

    // Navigate to Settings. The nav item is a div, not a real link, so
    // we target the .nav-item class to match the existing spec patterns.
    await page.locator('.nav-item').filter({ hasText: /^Settings$/i }).click();
    await expect(page.getByText(/Privacy & network/i).first()).toBeVisible({ timeout: 5_000 });

    // The diagnostics panel must render.
    const diagPanel = page.getByTestId('backfill-diagnostics');
    await expect(diagPanel).toBeVisible();

    // Summary chips: recovery flag complete, 2 held symbols.
    const summary = page.getByTestId('backfill-diagnostics-summary');
    await expect(summary).toContainText(/complete/i);
    await expect(summary).toContainText(/Held symbols:\s*2/);

    // Per-symbol rows exist for the two seeded tickers.
    await expect(page.getByTestId('backfill-coverage-row-VITAX')).toBeVisible();
    await expect(page.getByTestId('backfill-coverage-row-VTI')).toBeVisible();

    // Each row shows a non-zero bar count. We don't assert an exact
    // number because the auto-live-quote refresh that fires after the
    // recovery can add another bar to today's row, bumping the seeded
    // 30 to 31 or 32. The contract that matters is: SOMETHING > 0 bars
    // for each held symbol so the user can tell it's working.
    await expect(page.getByTestId('backfill-coverage-row-VITAX')).toContainText(/\d+ bars/);
    await expect(page.getByTestId('backfill-coverage-row-VITAX')).not.toContainText(/0 bars/);
    await expect(page.getByTestId('backfill-coverage-row-VTI')).toContainText(/\d+ bars/);
    await expect(page.getByTestId('backfill-coverage-row-VTI')).not.toContainText(/0 bars/);

    // Capture a screenshot for the PR description so reviewers can see
    // the new panel without running the spec locally.
    const panel = page.getByTestId('backfill-diagnostics');
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({
      path: '/Users/justintrugman/Development/matmon/app/screenshots/settings-backfill-diagnostics.png',
    });
  });

  test('Force re-run all clears the flag and triggers a fresh Yahoo fetch', async ({ page }) => {
    // Count Yahoo chart requests so we can assert the click actually
    // fires a network round-trip. Initial recovery will have produced
    // some; the click should produce more.
    const yahooHitsBySymbol = new Map<string, number>();
    await page.route(/finance\.yahoo\.com\/v8\/finance\/chart\//, async route => {
      const url = route.request().url();
      const m = url.match(/chart\/([^?]+)\?/);
      const symbol = m ? decodeURIComponent(m[1]) : 'UNKNOWN';
      yahooHitsBySymbol.set(symbol, (yahooHitsBySymbol.get(symbol) ?? 0) + 1);
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

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    // Seed a "needs recovery" state (empty prices, no flag) so a recovery
    // is naturally available. Use the same seed shape as the post-
    // recovery test but wipe the prices and the flag.
    await seedPostRecoveryState(page);
    await page.evaluate(() => {
      const raw = localStorage.getItem('matmon.dev.db.v1');
      if (!raw) return;
      const store = JSON.parse(raw);
      store.prices = [];
      store.settings = store.settings.filter(
        (s: { key: string }) => s.key !== 'backfill.recovery.v1.complete',
      );
      localStorage.setItem('matmon.dev.db.v1', JSON.stringify(store));
    });
    await page.reload();

    // Wait for the initial recovery to complete (the seeded empty-prices
    // state triggers it automatically). After this, recovery flag = "yes".
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('matmon.dev.db.v1');
            if (!raw) return null;
            try {
              const store = JSON.parse(raw);
              return (
                store.settings.find(
                  (s: { key: string }) => s.key === 'backfill.recovery.v1.complete',
                )?.value ?? null
              );
            } catch {
              return null;
            }
          }),
        { timeout: 30_000 },
      )
      .toBe('yes');

    // Navigate to Settings.
    await page.locator('.nav-item').filter({ hasText: /^Settings$/i }).click();
    await expect(page.getByTestId('backfill-diagnostics')).toBeVisible({ timeout: 5_000 });

    // Snapshot Yahoo hit counts BEFORE the click. We measure delta to
    // tell whether the click forced a fresh fetch.
    const beforeHits = new Map(yahooHitsBySymbol);
    const beforeVITAX = beforeHits.get('VITAX') ?? 0;
    const beforeVTI = beforeHits.get('VTI') ?? 0;
    expect(beforeVITAX + beforeVTI).toBeGreaterThan(0);

    // Click "Force re-run all" which clears the flag + failed list +
    // failure timestamp, then triggers a forced backfill on every held
    // symbol (force: true bypasses the "already covered" optimization).
    await page.getByTestId('backfill-force-rerun').click();

    // The forced backfill should hit Yahoo at least once per held symbol
    // (we have 2: VITAX and VTI). Allow up to 30s for the network
    // round-trip and the React state churn around the click.
    await expect
      .poll(
        () => (yahooHitsBySymbol.get('VITAX') ?? 0) + (yahooHitsBySymbol.get('VTI') ?? 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(beforeVITAX + beforeVTI);

    // The flag should also flip back to 'yes' after the forced backfill
    // lands bars (mirroring the auto-recovery's persistence path).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('matmon.dev.db.v1');
            if (!raw) return null;
            try {
              const store = JSON.parse(raw);
              return (
                store.settings.find(
                  (s: { key: string }) => s.key === 'backfill.recovery.v1.complete',
                )?.value ?? null
              );
            } catch {
              return null;
            }
          }),
        { timeout: 30_000 },
      )
      .toBe('yes');
  });
});
