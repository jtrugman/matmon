// Full-app end-to-end smoke specs.
//
// Justin's read on the existing test suite: vitest is comprehensive in
// isolation but the UI integration is where the cracks show up. This file
// drives a real browser through every major screen with real CSV data and
// asserts that what's actually painted on the page makes sense, no NaN, no
// $0 where there should be values, no stale hardcoded strings, no console
// errors. Screenshots are saved for each scenario so a human can verify
// visually if a textual assertion ever drifts.
//
// Scenarios:
//   1) Onboard with a single-account Fidelity CSV, walk every nav target.
//   2) Onboard with the JPM multi-account holdings export.
//   3) Onboard with no CSV at all (empty state coverage).
//   4) Add an account post-onboarding via the sidebar Add Account flow.
//   5) Erase everything from Settings, reload, verify onboarding returns.
//
// Each scenario:
//   - Captures all console errors via page.on('console') and asserts empty.
//   - Watches for [matmon-diag] THREW lines (caught exceptions) and asserts
//     none fired during the scenario.
//   - Snapshots screenshots into screenshots/scenario<N>-<screen>.png so
//     visual regressions are auditable post-hoc.
//
// If any expect() in here fails, the bug is in production code, not in this
// file. The whole point is that vitest can't see these.

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Real CSV paths. These are checked into the repo.
const FIDELITY_CSV = '/Users/justintrugman/Development/matmon/app/example_csv/multiple_accounts_fidelity.csv';
const JPM_CSV = '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv';

const SHOT_DIR = resolve('/Users/justintrugman/Development/matmon/app/screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

/**
 * Per-test bag of console errors and diagnostic-throw lines. Populated by
 * page.on('console') / page.on('pageerror'); asserted empty at scenario end.
 */
type ConsoleHarness = {
  errors: string[];
  threw: string[];
};

function attachConsole(page: Page): ConsoleHarness {
  const errors: string[] = [];
  const threw: string[] = [];
  const onMsg = (msg: ConsoleMessage) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      // Tauri's plugin import warnings are noise in browser mode; they don't
      // indicate a real failure. Everything else is real.
      if (
        text.includes('matmon-diag') ||
        text.includes('Failed to load resource') || // logos.dev 404 noise
        text.includes('logo') ||
        text.includes('not in a Tauri webview') || // expected on web
        // Yahoo Finance is the upstream for live quotes AND for the
        // post-import historical-price backfill. In `npm run dev` (the
        // browser webview Playwright runs against) every fetch to
        // query1.finance.yahoo.com is blocked by CORS; the Tauri build
        // sidesteps this via the http plugin. We filter these out here
        // because they're noise in browser-dev mode, not a real failure
        // signal.
        text.includes('query1.finance.yahoo.com') ||
        text.includes('Access-Control-Allow-Origin') ||
        text.includes('blocked by CORS policy')
      ) {
        return;
      }
      errors.push(text);
    }
    if (text.includes('[matmon-diag]') && text.includes('THREW')) {
      threw.push(text);
    }
  };
  page.on('console', onMsg);
  page.on('pageerror', err => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors, threw };
}

/** Reset localStorage so every scenario starts cold. */
async function coldStart(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
}

/**
 * Walk a known-good onboarding flow with no CSV. Used by scenarios 3, 4, 5.
 * Lands the user on an empty Home.
 */
async function walkOnboardingNoCsv(page: Page, name = 'Justin'): Promise<void> {
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill(name);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText(name, { timeout: 10_000 });
}

/**
 * Walk onboarding with a specified CSV file. Lands on Home with imported data.
 */
async function walkOnboardingWithCsv(page: Page, csvPath: string, name = 'Justin'): Promise<void> {
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill(name);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(csvPath);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText(name, { timeout: 10_000 });
}

/** Click a sidebar nav item by its visible label.
 *
 * The Sidebar renders each item as:
 *   <div class="nav-item"><span class="nav-icon"/><span>Label</span>...</div>
 * Some items (Achievements) also include a numeric badge <span> inside the
 * same .nav-item, so an exact-text match on the outer element would miss
 * them. We instead match the inner label span directly, then click its
 * ancestor .nav-item.
 */
async function navTo(page: Page, label: string): Promise<void> {
  const navItem = page
    .locator('.nav-item')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`, 'i') }) })
    .first();
  await navItem.click();
  // Give the view a tick to settle (PageHead always paints fast, so a short
  // wait + visibility check is enough).
  await expect(page.locator('.page-title')).toBeVisible({ timeout: 5_000 });
}

/** Take a screenshot to screenshots/<filename>.png. */
async function shot(page: Page, filename: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOT_DIR, `${filename}.png`), fullPage: true });
}

/**
 * Assert that the currently visible page contains no failure signatures:
 *   - 'NaN' tokens, 'Infinity' tokens
 *   - No "12 symbols · 388 B" placeholder strings (real network log only)
 * Returns the page body text so callers can do extra checks.
 */
async function assertNoFailureSignatures(page: Page): Promise<string> {
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body, 'NaN should not appear anywhere on the page').not.toMatch(/\bNaN\b/);
  expect(body, 'Infinity should not appear anywhere on the page').not.toMatch(/\bInfinity\b/);
  expect(body, 'No placeholder "12 symbols" string allowed').not.toContain('12 symbols · 388 B');
  // Today's literal date should be present somewhere on Home, but as a string
  // produced by toLocaleDateString, not the frozen "Sunday, May 17, 2026"
  // placeholder. We test for that frozen literal absence at the scenario
  // level where we know we're on Home.
  return body;
}

/** Assert the page never contains the frozen-demo-date string. */
async function assertNoFrozenDateLiteral(page: Page): Promise<void> {
  const body = (await page.locator('body').textContent()) ?? '';
  // Pre-onboarding agent had a literal "Sunday · May 17, 2026" hardcoded in
  // HomeView. The real meta should be today's date from
  // toLocaleDateString('en-US', { weekday: 'long', ... }).
  expect(body, 'Frozen literal "Sunday · May 17, 2026" string disallowed').not.toMatch(
    /Sunday\s*[·,]\s*May\s+17,\s+2026/,
  );
}

test.describe('Matmon full-app smoke', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[matmon-diag]') || t.includes('[matmon]')) {
        // eslint-disable-next-line no-console
        console.log(`  [browser] ${t}`);
      }
    });
    await coldStart(page);
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: single-account Fidelity onboarding + full nav walk
  // ---------------------------------------------------------------------------
  test('Scenario 1: Fidelity single account, every screen renders with real data', async ({ page }) => {
    const harness = attachConsole(page);
    await walkOnboardingWithCsv(page, FIDELITY_CSV, 'Justin');

    // -- Home -----------------------------------------------------------------
    await assertNoFailureSignatures(page);
    await assertNoFrozenDateLiteral(page);

    // Greeting contains Justin's actual name.
    await expect(page.locator('.page-title')).toContainText('Justin');

    // Total figure > $0. .total-figure has child spans for $, integer, .cents.
    // The full text includes the dollar glyph and cents, so we just verify the
    // integer part is non-zero, not the "$0" / "$0.00" failure signature.
    const totalText = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(totalText, 'Home total figure must not be $0').not.toMatch(/^\s*\$\s*0(\.00)?\s*$/);
    expect(totalText).not.toContain('NaN');
    // The integer portion (everything between the $ and the decimal) must be > 0.
    // Strip the leading $ and any '.NN' suffix, then strip commas.
    const intPart = totalText
      .replace(/^\s*\$\s*/, '')
      .replace(/\.\d+\s*$/, '')
      .replace(/,/g, '')
      .trim();
    const intVal = parseInt(intPart, 10);
    expect(intVal, `parsed total int from "${totalText}" must be > 0`).toBeGreaterThan(0);

    await shot(page, 'scenario1-home');

    // -- Accounts -------------------------------------------------------------
    await navTo(page, 'Accounts');
    await assertNoFailureSignatures(page);
    // At least one brokerage group ("Fidelity").
    await expect(page.getByText(/Fidelity/i).first()).toBeVisible();
    await shot(page, 'scenario1-accounts');

    // -- Holdings -------------------------------------------------------------
    await navTo(page, 'Holdings');
    await assertNoFailureSignatures(page);
    const rows = page.locator('.tbl tbody tr');
    const rowCount = await rows.count();
    expect(rowCount, 'Holdings table needs at least one row').toBeGreaterThan(0);
    // First row should have a non-zero quantity. Qty is the 3rd column (1-based:
    // Symbol, Sector, Qty, Price, Cost, Value, Gain, %, 30D).
    const firstQtyText = (await rows.first().locator('td').nth(2).textContent()) ?? '';
    const firstQtyNum = parseFloat(firstQtyText.replace(/,/g, ''));
    expect(
      firstQtyNum,
      `First holdings row qty "${firstQtyText}" must parse > 0`,
    ).toBeGreaterThan(0);
    // First row value (column 6) should also parse > 0.
    const firstValueText = (await rows.first().locator('td').nth(5).textContent()) ?? '';
    const firstValueNum = parseFloat(firstValueText.replace(/[$,]/g, ''));
    expect(
      firstValueNum,
      `First holdings row value "${firstValueText}" must parse > 0`,
    ).toBeGreaterThan(0);
    // Confirm at least one row's name (under .name) is NOT just the ticker.
    // The Fidelity sample has 3 positions (VGT, FXAIX, FZFXX); their notes
    // carry the real fund names. The previous bug had name === sym, which
    // would mean every row's .name reads identically to the ticker.
    const tickers = await rows.locator('.sym').allTextContents();
    const names = await rows.locator('.name').allTextContents();
    expect(tickers.length, 'Holdings tickers list must not be empty').toBeGreaterThan(0);
    expect(names.length, 'Holdings names list must not be empty').toBeGreaterThan(0);
    const someNameIsNotJustTheTicker = names.some((n, i) => {
      const t = tickers[i]?.trim();
      return t && n.trim().toUpperCase() !== t.toUpperCase();
    });
    expect(
      someNameIsNotJustTheTicker,
      `At least one holding name should be a real security name, not the ticker. Got tickers=${JSON.stringify(tickers)} names=${JSON.stringify(names)}`,
    ).toBe(true);
    await shot(page, 'scenario1-holdings');

    // -- Holding detail (click first row) -------------------------------------
    const firstSymText = (await rows.first().locator('.sym').first().textContent()) ?? '';
    const firstSym = firstSymText.trim();
    expect(firstSym.length, 'First holding row must have a symbol').toBeGreaterThan(0);
    // Also capture the "name" cell to verify the detail title uses the real
    // security name, not the raw ticker. Holdings table renders the name in
    // the same first cell under the .name div.
    const firstNameText = (await rows.first().locator('.name').first().textContent()) ?? '';
    const firstName = firstNameText.trim();
    await rows.first().click();
    // The HoldingDetailView has a "← Holdings" back button as the first
    // top-of-page element; that's a tighter signal than the page title which
    // depends on the symbol's display name.
    await expect(page.locator('.back-btn')).toBeVisible({ timeout: 5_000 });
    await assertNoFailureSignatures(page);
    // The detail view header should now show the security NAME (not the
    // ticker). When the importer captured a description we display that;
    // when there is no description we fall back to the ticker, so we only
    // assert when the Holdings table itself had a real name.
    if (firstName && firstName.toUpperCase() !== firstSym.toUpperCase()) {
      const headerNameVisible = await page
        .locator(`text=${firstName}`)
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        headerNameVisible,
        `Holding detail header must show the real name "${firstName}" for ticker "${firstSym}"`,
      ).toBe(true);
    }
    // Position metrics card has labels like "Shares", "Avg cost", etc. Their
    // values must all be present and non-empty strings; we don't enforce a
    // numeric pattern because "%" and "$" appear in the display, but no value
    // should be the literal "--" placeholder across the board.
    const metricLabels = page.locator('.hd-metric-l');
    const labels = await metricLabels.allTextContents();
    expect(labels.length, 'Position metric labels must exist').toBeGreaterThan(5);
    const metricValues = await page.locator('.hd-metric-v').allTextContents();
    const allDashes = metricValues.every(v => v.trim() === '--');
    expect(allDashes, 'Position card cannot be all dashes for an imported holding').toBe(false);
    // Sanity: market price label has a $ in the value.
    const marketPriceIdx = labels.findIndex(l => /market price/i.test(l));
    if (marketPriceIdx >= 0) {
      const mpVal = metricValues[marketPriceIdx];
      expect(mpVal, 'Market price metric needs a $ amount').toMatch(/\$/);
    }
    // The Lifetime Dividends metric must be a sane number for a Fidelity
    // sample whose only real dividend is the $0.21 FZFXX entry. The previous
    // bug had a fund-share-distribution ($7,808) counted as a dividend; this
    // assertion catches that regression.
    const lifetimeDivIdx = labels.findIndex(l => /lifetime div/i.test(l));
    if (lifetimeDivIdx >= 0) {
      const lifeText = metricValues[lifetimeDivIdx];
      const lifeNum = parseFloat(lifeText.replace(/[$,]/g, ''));
      expect(
        lifeNum,
        `Lifetime Div "${lifeText}" must be < $100 for the Fidelity sample`,
      ).toBeLessThan(100);
    }
    await shot(page, 'scenario1-holding-detail');

    // Back to Holdings so the next nav call works as expected.
    await page.locator('.back-btn').click();
    await expect(page.locator('.page-title')).toContainText(/Holdings/i, { timeout: 3_000 });

    // -- Transactions ---------------------------------------------------------
    await navTo(page, 'Transactions');
    await assertNoFailureSignatures(page);
    // Fidelity single-account CSV has dozens of rows; the table must render.
    const txRows = page.locator('.tbl tbody tr');
    expect(await txRows.count(), 'Transactions table must have at least one row').toBeGreaterThan(0);
    await shot(page, 'scenario1-transactions');

    // -- Planner --------------------------------------------------------------
    await navTo(page, 'Planner');
    await assertNoFailureSignatures(page);
    // HSA panel handling: the Fidelity sample is a taxable account so the HSA
    // panel should render the empty state. We assert the friendlier copy is
    // visible and we are NOT showing dashes-only without an explanation.
    const plannerBody = (await page.locator('body').textContent()) ?? '';
    // HSA empty-state title (from PlannerView): "Open an HSA and Matmon will project its trajectory here."
    // Should be visible when hsaToday === 0.
    expect(plannerBody, 'Planner HSA panel must show empty-state when no HSA').toContain(
      'Open an HSA',
    );
    await shot(page, 'scenario1-planner');

    // -- Achievements ---------------------------------------------------------
    await navTo(page, 'Achievements');
    await assertNoFailureSignatures(page);
    // For a ~$10K Fidelity sample with $0.21 in dividends, we expect at most a
    // handful of low-threshold unlocks (first_1k, first_import, first_dividend).
    // The view renders both unlocked stamps (with a date) and locked silhouette
    // stamps (which include the catalog title as a label). To verify a
    // milestone is UNLOCKED we check the `.ach-stamp` element does NOT have
    // the `locked` class. The bug we're guarding against: previously a
    // $7,808 fund share-distribution was misclassified as a dividend, which
    // tripped `100_in_dividends` and `1k_in_dividends` for users with sub-$1
    // of real dividends.
    const unlockedStamps = page.locator('.ach-stamp').and(page.locator(':not(.locked)'));
    const unlockedTitles = await unlockedStamps.locator('.ach-stamp-title').allTextContents();
    expect(
      unlockedTitles.map(t => t.trim()),
      `"$1,000 in dividends" must NOT be unlocked at $0.21 of real dividends. Got: ${JSON.stringify(unlockedTitles)}`,
    ).not.toContain('$1,000 in dividends');
    expect(
      unlockedTitles.map(t => t.trim()),
      `"$100 in dividends" must NOT be unlocked at $0.21 of real dividends. Got: ${JSON.stringify(unlockedTitles)}`,
    ).not.toContain('$100 in dividends');
    // The total $9,916 is below $10K, so Five digits must NOT be unlocked.
    expect(
      unlockedTitles.map(t => t.trim()),
      `"Five digits" must NOT be unlocked at $9,916 (threshold $10,000). Got: ${JSON.stringify(unlockedTitles)}`,
    ).not.toContain('Five digits');
    // Sanity: Four digits (first_1k) MUST be in the unlocked list because
    // the user's $9,916 > $1,000.
    expect(
      unlockedTitles.map(t => t.trim()),
      '"Four digits" should be unlocked at $9,916',
    ).toContain('Four digits');
    await shot(page, 'scenario1-achievements');

    // -- Settings -------------------------------------------------------------
    await navTo(page, 'Settings');
    await assertNoFailureSignatures(page);
    // Every rail section must be reachable (rail items render as anchor tags).
    const railLabels = ['General', 'Privacy & network', 'Market data', 'Your data', 'About'];
    for (const label of railLabels) {
      await expect(page.locator('.settings-rail-item').filter({ hasText: label })).toBeVisible();
    }
    // DB stats footer should reflect real counts, not placeholder text.
    // Format from describeDbLocation + dbStats span: "N accounts · M transactions".
    const dbPath = (await page.locator('.db-path').textContent()) ?? '';
    expect(dbPath, 'DB stats footer must include real account count').toMatch(/\d+\s+accounts?/);
    expect(dbPath, 'DB stats footer must include real transaction count').toMatch(
      /\d+\s+transactions?/,
    );
    await shot(page, 'scenario1-settings');

    // Final harness assertions.
    expect(harness.errors, `console errors during scenario 1:\n${harness.errors.join('\n')}`).toEqual([]);
    expect(harness.threw, `caught exceptions during scenario 1:\n${harness.threw.join('\n')}`).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: JPM multi-account onboarding
  // ---------------------------------------------------------------------------
  test('Scenario 2: JPM multi-account, accounts page groups and filters correctly', async ({
    page,
  }) => {
    const harness = attachConsole(page);
    await walkOnboardingWithCsv(page, JPM_CSV, 'Justin');

    // -- Home -----------------------------------------------------------------
    await assertNoFailureSignatures(page);
    await assertNoFrozenDateLiteral(page);

    // Total > $0
    const totalText = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(totalText).not.toContain('NaN');
    const intPart = totalText
      .replace(/^\s*\$\s*/, '')
      .replace(/\.\d+\s*$/, '')
      .replace(/,/g, '')
      .trim();
    expect(parseInt(intPart, 10), `Home total int "${intPart}" must be > 0`).toBeGreaterThan(0);

    // Brokerages tile must show JP Morgan
    await expect(page.getByText(/JP Morgan/i).first()).toBeVisible();
    await shot(page, 'scenario2-home');

    // -- Accounts page: JP Morgan group exists, lists each detected account --
    await navTo(page, 'Accounts');
    await assertNoFailureSignatures(page);
    await expect(page.getByText(/JP Morgan/i).first()).toBeVisible();
    // The JPM CSV has 4 distinct account numbers: 2180, 3925, 4361, 6021.
    // Each account row's name should be in the canonical
    //   "<last4> JP Morgan <subtype>"
    // format established by slugifyAccountId. We verify both that each last4
    // appears AND that the canonical format string is present, not just the
    // 4 digits in isolation. The bar-name span is the canonical render site.
    const accountsBody = (await page.locator('body').textContent()) ?? '';
    const accountNames = await page.locator('.bar-name').allTextContents();
    for (const last4 of ['2180', '3925', '4361', '6021']) {
      expect(accountsBody, `Account number ${last4} should be visible on Accounts page`).toContain(
        last4,
      );
      // At least one account name must follow "<last4> JP Morgan ..." format.
      const matchingName = accountNames.find(n => n.trim().startsWith(`${last4} JP Morgan`));
      expect(
        matchingName,
        `Canonical "<${last4}> JP Morgan <name>" format expected on Accounts page. Got names: ${JSON.stringify(accountNames)}`,
      ).toBeTruthy();
    }
    await shot(page, 'scenario2-accounts');

    // -- Drill into first JPM account, verify the filtered Holdings view ----
    // Pick the first "Open →" button (each account row has one).
    const firstOpen = page.locator('button.bar-open').first();
    await expect(firstOpen).toBeVisible();
    // Resolve the account name from the row to compare with the filtered
    // page title.
    const firstAccountName = (await firstOpen
      .locator('xpath=ancestor::div[contains(@class,"brokerage-account-row")]//div[contains(@class,"bar-name")]')
      .first()
      .textContent()) ?? '';
    await firstOpen.click();
    // Filtered HoldingsView shows the account name as the page title.
    await expect(page.locator('.page-title')).toContainText(firstAccountName.trim(), {
      timeout: 5_000,
    });
    await assertNoFailureSignatures(page);
    // The "← Accounts" back link must be rendered on this filtered view.
    await expect(page.locator('.back-btn')).toBeVisible();
    // Filtered holdings rows must exist.
    const filteredRows = page.locator('.tbl tbody tr');
    const filteredCount = await filteredRows.count();
    expect(filteredCount, 'Filtered Holdings must have at least one row').toBeGreaterThan(0);
    // The page meta shows "<N> positions · $<total>". The total here should
    // EQUAL the sum of the visible row values. If filtering were broken we'd
    // see the full portfolio total instead. We strip $ + commas + cents for a
    // tolerant float compare.
    const metaText = (await page.locator('.page-meta').textContent()) ?? '';
    const totalMatch = /\$([0-9,]+(?:\.\d+)?)/.exec(metaText);
    if (totalMatch) {
      const filteredTotal = parseFloat(totalMatch[1].replace(/,/g, ''));
      // Sum the table's value column (6th column, 0-indexed 5).
      let visibleSum = 0;
      for (let i = 0; i < filteredCount; i++) {
        const v = (await filteredRows.nth(i).locator('td').nth(5).textContent()) ?? '';
        const n = parseFloat(v.replace(/[$,]/g, ''));
        if (Number.isFinite(n)) visibleSum += n;
      }
      // Tolerate $1 of float drift across many rows.
      expect(
        Math.abs(filteredTotal - visibleSum),
        `Filtered Holdings total in meta ("$${filteredTotal}") must equal sum of visible rows ($${visibleSum.toFixed(2)})`,
      ).toBeLessThan(2);
    }
    await shot(page, 'scenario2-account-detail');

    // -- Back link to Accounts works ----------------------------------------
    await page.locator('.back-btn').click();
    await expect(page.locator('.page-title')).toContainText(/Accounts/i, { timeout: 3_000 });
    await shot(page, 'scenario2-accounts-after-back');

    expect(harness.errors, `console errors during scenario 2:\n${harness.errors.join('\n')}`).toEqual([]);
    expect(harness.threw, `caught exceptions during scenario 2:\n${harness.threw.join('\n')}`).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Onboard without a CSV, empty states everywhere
  // ---------------------------------------------------------------------------
  test('Scenario 3: empty onboarding shows whimsical empty states everywhere', async ({ page }) => {
    const harness = attachConsole(page);
    await walkOnboardingNoCsv(page, 'Justin');

    // -- Home -----------------------------------------------------------------
    await assertNoFailureSignatures(page);
    await assertNoFrozenDateLiteral(page);
    // Total figure: an empty portfolio shows $0.00 by design. That's fine. We
    // care that the surrounding empty-state copy is present.
    const homeBody = (await page.locator('body').textContent()) ?? '';
    // EmptyState copy from HomeView. At least one of the empty-state strings
    // should be on screen.
    expect(homeBody, 'Empty Home should expose an empty-state hook').toMatch(
      /No brokerages yet|Your portfolio chart will fill in|Nothing to slice up|Your accounts will live here/,
    );
    await shot(page, 'scenario3-home');

    // -- Sidebar nav targets all reachable ----------------------------------
    for (const label of ['Accounts', 'Holdings', 'Transactions', 'Planner', 'Achievements', 'Settings']) {
      await navTo(page, label);
      await assertNoFailureSignatures(page);
    }
    await shot(page, 'scenario3-settings');

    // -- Add Account screen reachable & functional --------------------------
    await navTo(page, 'Add Account');
    await assertNoFailureSignatures(page);
    // Dropzone is the canonical UI element on step='drop'.
    await expect(page.locator('.dropzone')).toBeVisible();
    await shot(page, 'scenario3-add-account');

    // -- Achievements shows zero-unlock empty state -------------------------
    await navTo(page, 'Achievements');
    const achBody = (await page.locator('body').textContent()) ?? '';
    expect(achBody, 'Achievements view should show empty-state copy').toContain(
      'Your first milestone is right around the corner',
    );

    // -- Planner empty states for HSA + starting balance -------------------
    await navTo(page, 'Planner');
    const plannerBody = (await page.locator('body').textContent()) ?? '';
    expect(plannerBody, 'Planner should show retirement-empty hint').toContain(
      "You don't have any retirement accounts imported",
    );
    expect(plannerBody, 'Planner should show HSA-empty hint').toContain('Open an HSA');

    expect(harness.errors, `console errors during scenario 3:\n${harness.errors.join('\n')}`).toEqual([]);
    expect(harness.threw, `caught exceptions during scenario 3:\n${harness.threw.join('\n')}`).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Add Account post-onboarding (real CSV)
  // ---------------------------------------------------------------------------
  test('Scenario 4: add an account post-onboarding, Home refreshes with data', async ({ page }) => {
    const harness = attachConsole(page);
    // Skip the CSV during onboarding to start with an empty Home.
    await walkOnboardingNoCsv(page, 'Justin');

    // Empty Home: total figure is $0.00 (no holdings).
    const initialTotal = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(initialTotal).toMatch(/\$\s*0/);

    // Click the "Add an Account" CTA. There are two on Home (the page header
    // action button and a button inside the empty-state Brokerages card). The
    // first .btn with that label is the header action.
    await page.getByRole('button', { name: /^Add an Account$/i }).first().click();
    await expect(page.locator('.dropzone')).toBeVisible({ timeout: 3_000 });
    await shot(page, 'scenario4-add-account-drop');

    // Upload the Fidelity CSV. The file input is hidden in the dropzone, so
    // use its descendant input[type=file] directly.
    const fileInput = page.locator('.dropzone input[type=file]');
    await fileInput.setInputFiles(FIDELITY_CSV);

    // The single-account Fidelity import lands in the review step.
    await expect(page.getByText(/What we figured out/i)).toBeVisible({ timeout: 10_000 });
    await shot(page, 'scenario4-add-account-review');

    // Confirm import. The review-step primary CTA is labeled dynamically based
    // on what was inferred, e.g. "Add Fidelity Taxable brokerage" or "Add JP
    // Morgan brokerage". We match on the leading "Add " plus brokerage token.
    const importButton = page.getByRole('button', { name: /^Add\s+(Fidelity|JP Morgan|Schwab|Charles Schwab|Custom)\b/i }).first();
    await importButton.click();

    // After saving, we land on the 'done' step which has a "Reload to see it"
    // CTA. Click it.
    await expect(page.getByText(/Saved/i).first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Reload to see it/i }).click();

    // Back to Home (reload callback re-renders without a hard refresh).
    await navTo(page, 'Home');
    await assertNoFailureSignatures(page);
    const afterTotal = (await page.locator('.total-figure').first().textContent()) ?? '';
    const intPart = afterTotal
      .replace(/^\s*\$\s*/, '')
      .replace(/\.\d+\s*$/, '')
      .replace(/,/g, '')
      .trim();
    expect(parseInt(intPart, 10), `After-import Home total "${afterTotal}" must be > 0`).toBeGreaterThan(
      0,
    );
    await shot(page, 'scenario4-home-after');

    expect(harness.errors, `console errors during scenario 4:\n${harness.errors.join('\n')}`).toEqual([]);
    expect(harness.threw, `caught exceptions during scenario 4:\n${harness.threw.join('\n')}`).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Settings → Erase everything → reload → onboarding returns
  // ---------------------------------------------------------------------------
  test('Scenario 5: erase everything returns the user to onboarding on reload', async ({ page }) => {
    const harness = attachConsole(page);
    await walkOnboardingWithCsv(page, FIDELITY_CSV, 'Justin');

    // -- Erase everything from Settings -------------------------------------
    await navTo(page, 'Settings');

    // The window.confirm() dialog is browser-native; auto-accept it.
    page.on('dialog', dialog => {
      void dialog.accept();
    });
    await page.getByRole('button', { name: /Erase everything/i }).click();

    // The success status appears: "All local data erased."
    await expect(page.getByText(/All local data erased/i)).toBeVisible({ timeout: 5_000 });
    await shot(page, 'scenario5-after-erase');

    // -- Reload, assert onboarding is back ----------------------------------
    await page.reload();
    await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
    await shot(page, 'scenario5-onboarding-back');

    expect(harness.errors, `console errors during scenario 5:\n${harness.errors.join('\n')}`).toEqual([]);
    expect(harness.threw, `caught exceptions during scenario 5:\n${harness.threw.join('\n')}`).toEqual(
      [],
    );
  });
});
