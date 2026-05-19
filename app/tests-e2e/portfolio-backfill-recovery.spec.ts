// Global backfill recovery: users who onboarded BEFORE the historical-
// backfill code shipped have an empty prices table. On their next app
// launch, usePortfolio should detect "have holdings, zero history" and
// kick off a one-shot backfill in the background.
//
// This spec seeds the post-recovery scenario, reloads the page, and
// asserts:
//   1. The [matmon-diag] portfolio: backfill-recovery starting log fires.
//   2. The prices table populates (we read window.matmon.shim through
//      page.evaluate after the recovery completes).
//   3. The recovery flag flips to "yes" so subsequent launches don't
//      retrigger.
//
// We seed via localStorage directly (the dev shim's storage backend) so
// we can place the user in the exact "needs recovery" state without
// re-onboarding through the UI.

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
 * Seed the "pre-historical-backfill" state: completed onboarding + accounts
 * + transactions but EMPTY prices table. The recovery flag is NOT set, so
 * usePortfolio.maybeRunRecovery will fire on the next reload.
 */
async function seedPreBackfillState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const today = new Date();
    const earliest = new Date(today);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 3);
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
      prices: [], // critical: empty history is the trigger
      settings: [
        { key: 'onboarding.completed.v1', value: 'yes' },
        { key: 'dedupe.v1.complete', value: 'yes' },
        // NOT setting backfill.recovery.v1.complete here is the whole point:
        // we want maybeRunRecovery to fire.
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

async function readPricesCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('matmon.dev.db.v1');
    if (!raw) return 0;
    try {
      const store = JSON.parse(raw);
      return Array.isArray(store.prices) ? store.prices.length : 0;
    } catch {
      return 0;
    }
  });
}

async function readRecoveryFlag(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('matmon.dev.db.v1');
    if (!raw) return null;
    try {
      const store = JSON.parse(raw);
      const settings = (store.settings || []) as Array<{ key: string; value: string }>;
      return settings.find(s => s.key === 'backfill.recovery.v1.complete')?.value ?? null;
    } catch {
      return null;
    }
  });
}

test.describe('Portfolio backfill recovery', () => {
  test('empty prices table triggers a one-shot recovery backfill', async ({ page }) => {
    const recoveryStartLogs: string[] = [];
    const recoveryCompleteLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('backfill-recovery starting')) recoveryStartLogs.push(text);
      if (text.includes('backfill-recovery complete')) recoveryCompleteLogs.push(text);
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
    await seedPreBackfillState(page);
    await page.reload();

    // Land on Home. Title contains the seeded name.
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });

    // The recovery toast should appear briefly (it's bottom-right).
    // We give it a generous window: 5s. It may have already disappeared
    // by the time we check on a fast machine, so we don't require it.
    await page.getByTestId('recovery-toast').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    // The matmon-diag log MUST fire: this is the canonical signal that
    // recovery kicked off.
    await expect.poll(() => recoveryStartLogs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // And the complete log should fire shortly after.
    await expect.poll(() => recoveryCompleteLogs.length, { timeout: 30_000 }).toBeGreaterThan(0);

    // The prices table should populate.
    await expect
      .poll(() => readPricesCount(page), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // The recovery-complete flag should flip to "yes" so the next launch
    // skips the recovery path.
    await expect.poll(() => readRecoveryFlag(page), { timeout: 15_000 }).toBe('yes');
  });

  test('subsequent reload after recovery does NOT re-trigger the recovery path', async ({ page }) => {
    await installYahooRouter(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await seedPreBackfillState(page);
    // First reload runs the recovery.
    await page.reload();
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });
    // Wait for recovery to actually finish (prices land, flag set).
    await expect.poll(() => readRecoveryFlag(page), { timeout: 30_000 }).toBe('yes');

    // Now capture logs from a SECOND reload. The recovery flag is set, so
    // backfill-recovery starting must NOT log again.
    const startsAfterReload: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('backfill-recovery starting')) startsAfterReload.push(text);
    });
    await page.reload();
    await expect(page.locator('.page-title')).toContainText(/Justin/i, { timeout: 15_000 });
    // Give it a beat to make sure no late-fire happens.
    await page.waitForTimeout(2_000);
    expect(startsAfterReload).toHaveLength(0);
  });
});
