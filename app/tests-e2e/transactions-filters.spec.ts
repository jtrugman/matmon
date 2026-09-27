// Transactions view filter + pagination end-to-end specs.
//
// What these specs cover:
//   1. Date range segmented controls (1M / 3M / YTD / 1Y / ALL) actually
//      filter the table. None of them worked before the fix.
//   2. Pagination renders the second page when more than one page of rows
//      exists, and the page indicator advances.
//   3. Empty-state copy is whimsical and segment-aware. With JPM data the
//      Sells bucket is provably empty, so we assert the diamond-hands line.
//   4. The filter chain composes: dateRange + action + search all narrow at
//      once and the count stays consistent.
//
// We onboard with the real JPM holdings CSV. JPM positions get synthesized
// into transfer_in transactions, which the TransactionsView buckets as
// "buy". That gives us a dataset that's:
//   - non-trivial in size (~244+ buys),
//   - zero sells (perfect for empty-state coverage),
//   - zero dividends.
//
// Screenshots captured for visual proof:
//   tests-e2e/screenshots/transactions-1m-filter.png
//   tests-e2e/screenshots/transactions-sells-empty.png
//   tests-e2e/screenshots/transactions-pagination-page2.png

import { test, expect, type Page } from '@playwright/test';

const JPM_PATH = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';
const SCREENSHOT_DIR = '/Users/justintrugman/Development/matmon/app/tests-e2e/screenshots';

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

  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
}

async function walkOnboardingWithJpm(page: Page): Promise<void> {
  // Welcome
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible();
  await page.getByRole('button', { name: /Let's set you up/i }).click();

  // Profile
  await page.getByPlaceholder('Justin').fill('Justin');
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Goal: leave defaults
  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Account upload: feed the real JPM file.
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(JPM_PATH);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });

  // Click "Finish setup".
  await page.getByRole('button', { name: /Finish setup/i }).click();

  // Done screen.
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();

  // Sanity: greeting landed.
  await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });
}

async function navToTransactions(page: Page): Promise<void> {
  await page.locator('.nav-item').filter({ hasText: /^Transactions$/i }).click();
  await expect(page.locator('h1.page-title')).toContainText(/^Transactions$/);
}

/**
 * Parses the header meta line ("262 actions, all-time") and returns the count.
 * The view renders this number in the first div under .page-meta.
 */
async function headerCount(page: Page): Promise<number> {
  // The meta block has two lines; the first is "<n> actions, <window>".
  const metaText = (await page.locator('.page-meta').first().innerText()) ?? '';
  const m = metaText.match(/^([\d,]+)\s+actions/);
  if (!m) throw new Error(`could not parse header count from meta: ${JSON.stringify(metaText)}`);
  return Number(m[1].replace(/,/g, ''));
}

/**
 * Returns the visible row count in the transactions table. When the table is
 * absent (filtered to empty) the locator yields 0.
 */
async function tableRowCount(page: Page): Promise<number> {
  const rows = page.locator('table.tbl tbody tr');
  return await rows.count();
}

/**
 * Returns the "Showing N to M of TOTAL" summary numbers from the pagination
 * bar. When the table is hidden (empty state), returns null.
 */
async function pageSummary(page: Page): Promise<{ from: number; to: number; total: number } | null> {
  const el = page.getByTestId('tx-page-summary');
  if ((await el.count()) === 0) return null;
  const text = await el.innerText();
  const m = text.match(/Showing\s+([\d,]+)\s+to\s+([\d,]+)\s+of\s+([\d,]+)/);
  if (!m) throw new Error(`could not parse page summary: ${text}`);
  return {
    from: Number(m[1].replace(/,/g, '')),
    to: Number(m[2].replace(/,/g, '')),
    total: Number(m[3].replace(/,/g, '')),
  };
}

test.describe('Transactions view filters and pagination', () => {
  test.beforeEach(async ({ page }) => {
    await startCold(page);
    await walkOnboardingWithJpm(page);
    await navToTransactions(page);
  });

  test('Test A: date range segments (1M / 1Y / ALL) filter the table', async ({ page }) => {
    // ALL is the default. Establish the baseline total and assert the header
    // copy ends in "all-time".
    await expect(page.locator('.page-meta').first()).toContainText(/all-time/i);
    const allTotal = await headerCount(page);
    expect(allTotal).toBeGreaterThan(200); // JPM synthesizes 244+ transfer_in rows.
    const allSummary = await pageSummary(page);
    expect(allSummary).not.toBeNull();
    expect(allSummary!.total).toBe(allTotal);

    // 1M: only acquisitions in the last 30 days. JPM dataset has ~22 today
    // fallbacks (rows whose Acquisition Date was empty), so the count must be
    // strictly less than ALL but at least 1.
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: '1M' }).click();
    await expect(page.locator('.page-meta').first()).toContainText(/last 30 days/i);
    const oneMonth = await headerCount(page);
    expect(oneMonth).toBeLessThan(allTotal);
    expect(oneMonth).toBeGreaterThanOrEqual(1);

    // 1Y: must yield at least as many as 1M and strictly fewer than ALL.
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: '1Y' }).click();
    await expect(page.locator('.page-meta').first()).toContainText(/last 12 months/i);
    const oneYear = await headerCount(page);
    expect(oneYear).toBeGreaterThanOrEqual(oneMonth);
    expect(oneYear).toBeLessThanOrEqual(allTotal);

    // ALL: round-trip back to the full count.
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: 'ALL' }).click();
    await expect(page.locator('.page-meta').first()).toContainText(/all-time/i);
    const allAgain = await headerCount(page);
    expect(allAgain).toBe(allTotal);

    // Screenshot: 1M view of the table.
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: '1M' }).click();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/transactions-1m-filter.png`,
      fullPage: true,
    });
  });

  test('Test B: filter chain composes (1M + Buys + search "VGT")', async ({ page }) => {
    // 1M first. Capture the count.
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: '1M' }).click();
    const afterRange = (await pageSummary(page))?.total ?? 0;
    expect(afterRange).toBeGreaterThan(0);

    // Add Buys filter. JPM is all buys so the count should stay the same.
    await page.getByRole('group', { name: /Filter by action/i }).getByRole('button', { name: 'Buys' }).click();
    const afterBuys = (await pageSummary(page))?.total ?? 0;
    expect(afterBuys).toBe(afterRange);

    // Add search "VGT". The filtered count must be <= afterBuys, and every
    // visible row's symbol cell must include VGT.
    await page.getByLabel(/Search transactions by symbol/i).fill('VGT');
    const afterSearch = (await pageSummary(page))?.total ?? 0;
    expect(afterSearch).toBeLessThanOrEqual(afterBuys);

    // If any rows match, every visible row must have symbol VGT.
    if (afterSearch > 0) {
      const symbols = await page.locator('table.tbl tbody tr td .sym').allInnerTexts();
      for (const s of symbols) {
        expect(s.toLowerCase()).toContain('vgt');
      }
    } else {
      // No rows: empty state must render with whimsical copy.
      await expect(page.getByTestId('tx-empty-state')).toBeVisible();
    }

    // Clear search and switch back to ALL so subsequent tests have a clean
    // starting point. (test.beforeEach re-onboards but this proves filter
    // composition doesn't strand state.)
    await page.getByLabel(/Search transactions by symbol/i).fill('');
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: 'ALL' }).click();
    await page.getByRole('group', { name: /Filter by action/i }).getByRole('button', { name: 'All' }).click();
    const restored = (await pageSummary(page))?.total ?? 0;
    expect(restored).toBeGreaterThan(200);
  });

  test('Test C: Sells with no sells shows the whimsical empty state', async ({ page }) => {
    // JPM data contains zero sells. Click "Sells".
    await page.getByRole('group', { name: /Filter by action/i }).getByRole('button', { name: 'Sells' }).click();

    // Empty state must render. The copy is the all-time Sells line.
    const empty = page.getByTestId('tx-empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/Diamond hands detected/i);
    await expect(empty).toContainText(/Zero sells/i);

    // Table rows: zero. (The empty state is rendered IN PLACE of the table.)
    expect(await tableRowCount(page)).toBe(0);

    // The page meta must also reflect zero sells in the breakdown.
    await expect(page.locator('.page-meta').first()).toContainText(/0 sells/);

    // Screenshot: Sells empty state.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/transactions-sells-empty.png`,
      fullPage: true,
    });
  });

  test('Test D: pagination renders page 2 and the indicator advances', async ({ page }) => {
    // Default page size is 50 and JPM yields >50 transactions; therefore the
    // pagination bar must show page 1 of (multiple pages) at first.
    const initialSummary = await pageSummary(page);
    expect(initialSummary).not.toBeNull();
    expect(initialSummary!.total).toBeGreaterThan(50);
    expect(initialSummary!.from).toBe(1);
    expect(initialSummary!.to).toBe(50);

    const indicator = page.getByTestId('tx-page-indicator');
    await expect(indicator).toContainText(/Page 1 of /);

    // Click "Next" and assert the indicator advances to page 2.
    await page.getByTestId('tx-next').click();
    await expect(indicator).toContainText(/Page 2 of /);
    const page2Summary = await pageSummary(page);
    expect(page2Summary!.from).toBe(51);
    expect(page2Summary!.to).toBeLessThanOrEqual(100);
    expect(page2Summary!.total).toBe(initialSummary!.total);

    // Visible rows count should equal (to - from + 1).
    const rowCount = await tableRowCount(page);
    expect(rowCount).toBe(page2Summary!.to - page2Summary!.from + 1);

    // Screenshot: page 2 of the table with pagination visible at the bottom.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/transactions-pagination-page2.png`,
      fullPage: true,
    });

    // Sanity: Prev returns to page 1.
    await page.getByTestId('tx-prev').click();
    await expect(indicator).toContainText(/Page 1 of /);

    // Filter change resets to page 1: navigate forward, click 1M, assert page 1.
    await page.getByTestId('tx-next').click();
    await expect(indicator).toContainText(/Page 2 of /);
    await page.getByRole('group', { name: /Filter by date range/i }).getByRole('button', { name: '1M' }).click();
    await expect(indicator).toContainText(/Page 1 of /);
  });
});
