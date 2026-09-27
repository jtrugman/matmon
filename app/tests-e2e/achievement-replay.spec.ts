// Achievement Replay celebration: end-to-end verification of the bug Justin
// reported on the Achievements page.
//
// Reproduction Justin filed: click "Replay celebration" on the "$1,000 in
// dividends" tile, the toast pops up with the wrong title ("A millionaire").
// Root cause: `replayToast()` ignored the milestoneId arg and hardcoded
// `first_million`. This spec drives a real Chromium through the corrected
// flow:
//
//   1. Seed localStorage with completed onboarding plus two unlocked
//      milestones (`1k_in_dividends` and `first_million`), neither fresh.
//   2. Navigate to the Achievements page.
//   3. Click "Replay celebration" on the `1k_in_dividends` tile.
//   4. Assert the visible toast contains "$1,000 in dividends" (NOT the
//      "millionaire" string the bug surfaced).
//   5. Click "Replay celebration" on the `first_million` tile.
//   6. Assert the toast is replaced (single-slot, not queued) with the
//      "A millionaire" milestone metadata.
//
// A regression in the App.tsx replayToast wiring would fail step 4 or 5.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOT_DIR = resolve('/Users/justintrugman/Development/matmon/app/screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

/**
 * Seed the dev-mode localStorage shim with the minimum state the
 * AchievementsView needs:
 *   - onboarding complete (so the welcome flow doesn't intercept).
 *   - one fake account + one tiny tx so portfolio.ts builds a non-empty
 *     MatmonData (no `0 unlocked` empty state).
 *   - two unlocked milestones, both dated long enough ago that the hero
 *     `fresh` window (24h) is closed. That forces the test to interact with
 *     the collection-grid tile, which is the exact path Justin hit.
 *   - settings flags to skip migrations / recovery banners.
 */
async function seedAchievements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const longAgo = (year: number) => new Date(`${year}-06-15T00:00:00Z`).toISOString();
    const store = {
      accounts: [
        {
          id: 'demo-fid',
          name: 'Fidelity Brokerage',
          brokerage: 'Fidelity',
          account_type: 'taxable',
          currency: 'USD',
          created_at: new Date('2020-01-01T00:00:00Z').toISOString(),
        },
      ],
      transactions: [
        {
          id: 1,
          account_id: 'demo-fid',
          date: new Date('2020-01-15T00:00:00Z').toISOString(),
          symbol: 'VOO',
          action: 'buy',
          quantity: 1,
          price: 100,
          fees: 0,
          amount: -100,
          currency: 'USD',
          notes: 'Seed',
          imported_from: 'seed',
          raw_hash: 'seed-1',
        },
      ],
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
      achievements: [
        { milestone_key: '1k_in_dividends', unlocked_at: longAgo(2024) },
        { milestone_key: 'first_million', unlocked_at: longAgo(2024) },
      ],
    };
    localStorage.setItem('matmon.dev.db.v1', JSON.stringify(store));
  });
}

test.describe('Achievement replay celebration', () => {
  test.beforeEach(async ({ page }) => {
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
    await seedAchievements(page);
    await page.reload();
  });

  test('clicking Replay on a specific tile fires THAT tile\'s milestone (not a hardcoded one)', async ({
    page,
  }) => {
    // Wait for the populated app shell to render; the page title is the
    // first reliable signal that data has hydrated.
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });

    // Navigate to Achievements via the sidebar.
    // The sidebar nav items are <div>s with a click handler, not buttons,
    // so we target by visible text scoped to the sidebar aside.
    await page.locator('aside.sidebar').getByText('Achievements', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();

    // Both unlocked stamps should be present (with tile-level Replay buttons).
    await expect(page.getByTestId('ach-stamp-1k_in_dividends')).toBeVisible();
    await expect(page.getByTestId('ach-stamp-first_million')).toBeVisible();

    // Click Replay on the dividends tile.
    await page.getByTestId('replay-1k_in_dividends').click();

    // Toast must show THIS milestone's title and copy.
    const toast = page.getByTestId('milestone-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('$1,000 in dividends');
    await expect(toast).toContainText('A small but steady stream forms');
    // The bug used to put the millionaire title here. Pin it down.
    await expect(toast).not.toContainText('A millionaire');
    await expect(toast).not.toContainText('Go buy your mom some flowers');

    // The toast carries the exact milestone key for further scripting.
    await expect(toast).toHaveAttribute('data-milestone-key', '1k_in_dividends');

    // Take a screenshot of the corrected state so Justin (and future
    // regressors) can eyeball the fix at a glance. fullPage captures the
    // whole 820px app-shell so the toast (which floats below the default
    // 720px viewport) is included.
    await page.screenshot({
      path: `${SHOT_DIR}/achievement-replay-1k-dividends.png`,
      fullPage: true,
    });
    // Also capture a tight crop of just the toast for quick eyeballing.
    await toast.screenshot({
      path: `${SHOT_DIR}/achievement-replay-1k-dividends-toast.png`,
    });

    // Now click Replay on the millionaire tile. The single-slot semantics
    // should REPLACE (not queue) the previous toast.
    await page.getByTestId('replay-first_million').click();
    await expect(toast).toContainText('A millionaire');
    await expect(toast).toContainText('Go buy your mom some flowers');
    await expect(toast).not.toContainText('$1,000 in dividends');
    await expect(toast).toHaveAttribute('data-milestone-key', 'first_million');

    await page.screenshot({
      path: `${SHOT_DIR}/achievement-replay-millionaire.png`,
      fullPage: true,
    });
    await toast.screenshot({
      path: `${SHOT_DIR}/achievement-replay-millionaire-toast.png`,
    });
  });

  test('toast dismisses on click and auto-dismisses on a 5s timer', async ({ page }) => {
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
    // The sidebar nav items are <div>s with a click handler, not buttons,
    // so we target by visible text scoped to the sidebar aside.
    await page.locator('aside.sidebar').getByText('Achievements', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();

    // Fire the toast, then click it to dismiss immediately.
    await page.getByTestId('replay-1k_in_dividends').click();
    const toast = page.getByTestId('milestone-toast');
    await expect(toast).toBeVisible();
    await toast.click();
    await expect(toast).not.toBeVisible();

    // Fire again, wait the 5s window, expect it gone.
    await page.getByTestId('replay-1k_in_dividends').click();
    await expect(toast).toBeVisible();
    await page.waitForTimeout(5500);
    await expect(toast).not.toBeVisible();
  });

  test('Tell a friend on a tile copies a one-liner to the clipboard', async ({ page, browserName }) => {
    // Grant clipboard permissions explicitly in Chromium; other browsers
    // ignore the permission API and write succeeds anyway.
    if (browserName === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    }

    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
    // The sidebar nav items are <div>s with a click handler, not buttons,
    // so we target by visible text scoped to the sidebar aside.
    await page.locator('aside.sidebar').getByText('Achievements', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();

    await page.getByTestId('share-1k_in_dividends').click();

    // Either we read the clipboard and see the share line, OR the inline
    // notice surfaces the same text. Both are valid because the JSDOM/
    // headed-Chromium clipboard story varies; the contract that matters
    // is that the user gets feedback specific to THAT milestone.
    let copied = '';
    try {
      copied = await page.evaluate(() => navigator.clipboard.readText());
    } catch {
      // Permission denied or unsupported. Fall through to the inline notice.
    }
    if (copied) {
      expect(copied).toContain('$1,000 in dividends');
      expect(copied).toContain('A small but steady stream forms');
    } else {
      const notice = page.getByTestId('ach-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('$1,000 in dividends');
    }
  });
});
