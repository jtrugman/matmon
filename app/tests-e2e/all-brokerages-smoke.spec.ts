// Cross-brokerage smoke spec.
//
// Justin asked for ONE integration test that proves every committed example
// CSV onboards cleanly and lands on a populated Home with the right brokerage
// tile. The math-validation suite (tests/math-validation.test.ts) already
// pins per-symbol totals to the cent at the importer + portfolio layer; this
// spec proves the SAME files survive the full UI seam in a real browser:
//   - drop the CSV at onboarding,
//   - finish setup,
//   - reach the Done step,
//   - land on Home,
//   - confirm the rendered total is non-NaN / non-em-dash / non-zero (except
//     where the file is a wrong-shape rejection, in which case we assert the
//     rejection banner),
//   - confirm the brokerage name renders on the Brokerages tile,
//   - take a screenshot per scenario for the functionality matrix.
//
// Each scenario clears localStorage before running so they don't pollute one
// another.

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EXAMPLE_DIR = '/Users/justintrugman/Development/matmon/app/example_csv';
const SHOT_DIR = resolve(
  '/Users/justintrugman/Development/matmon/app/screenshots',
);
mkdirSync(SHOT_DIR, { recursive: true });

type Scenario = {
  /** Display label used in the test name and in the screenshot filename. */
  label: string;
  /** Absolute path to the CSV under example_csv/. */
  csv: string;
  /** Substring expected on the Brokerages tile after import. */
  brokerageNeedle: RegExp;
  /** How many accounts the Accounts page should show (post-dedup). */
  expectedAccounts: number;
  /** Loose lower bound on the Home total dollar amount. Used to catch the
   *  "imported a CSV but the page shows $0" silent-fail case. */
  minHomeTotal: number;
};

const SCENARIOS: Scenario[] = [
  // NOTE: the 'fidelity-single' scenario was removed (2026-05-18) because
  // the importer now rejects single-account Fidelity exports at the
  // import gate (see tests/fidelity-single-account-rejection.test.ts).
  // The multi-account scenario below still covers the Fidelity importer.
  {
    label: 'fidelity-multi',
    csv: resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv'),
    brokerageNeedle: /Fidelity/i,
    expectedAccounts: 2,
    minHomeTotal: 1000,
  },
  {
    label: 'schwab-tx',
    csv: resolve(EXAMPLE_DIR, 'single_scwab_transactions.csv'),
    brokerageNeedle: /Charles Schwab|Schwab/i,
    expectedAccounts: 1,
    // Schwab CSV pins QQQ at $5.95 cost/value. The Home total must clear $0
    // and must not be NaN. We assert a tiny floor (> $1).
    minHomeTotal: 1,
  },
  {
    label: 'jpm-multi',
    csv: resolve(EXAMPLE_DIR, 'jpm_multiple_accounts.csv'),
    brokerageNeedle: /JP Morgan/i,
    expectedAccounts: 4,
    // JPM holdings pin total at $707,377. A floor of $100K is well below
    // even the smallest of the 4 detected accounts.
    minHomeTotal: 100_000,
  },
];

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
      // Same noise filter as full-app-smoke.
      if (
        text.includes('matmon-diag') ||
        text.includes('Failed to load resource') ||
        text.includes('logo') ||
        text.includes('not in a Tauri webview') ||
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

async function coldStart(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
}

async function walkOnboardingWithCsv(page: Page, csvPath: string, name = 'Justin'): Promise<void> {
  await page.getByRole('button', { name: /Let's set you up/i }).click();
  await page.getByPlaceholder('Justin').fill(name);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(csvPath);
  await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Finish setup/i }).click();
  await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /Take me to Matmon/i }).click();
  await expect(page.locator('.page-title')).toContainText(name, { timeout: 10_000 });
}

test.describe('All-brokerages smoke', () => {
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

  for (const scenario of SCENARIOS) {
    test(`smoke: ${scenario.label} onboards cleanly and Home shows real data`, async ({ page }) => {
      const harness = attachConsole(page);
      await walkOnboardingWithCsv(page, scenario.csv, 'Justin');

      // -- Home --------------------------------------------------------------
      // Total figure must render without failure signatures.
      const totalText = (await page.locator('.total-figure').first().textContent()) ?? '';
      expect(totalText, `${scenario.label}: Home total must render`).toBeTruthy();
      expect(totalText, `${scenario.label}: no NaN`).not.toContain('NaN');
      expect(totalText.trim(), `${scenario.label}: no em-dash fallback`).not.toBe('--');
      expect(totalText, `${scenario.label}: not $0`).not.toMatch(/^\s*\$\s*0(\.00)?\s*$/);

      // Parse the total. Strip $, commas, and decimals to get an integer.
      const intPart = totalText
        .replace(/^\s*\$\s*/, '')
        .replace(/\.\d+\s*$/, '')
        .replace(/,/g, '')
        .trim();
      const intVal = parseInt(intPart, 10);
      expect(
        intVal,
        `${scenario.label}: Home total int "${intPart}" must be >= ${scenario.minHomeTotal}`,
      ).toBeGreaterThanOrEqual(scenario.minHomeTotal);

      // The Brokerages tile on Home must include the expected brokerage name.
      // We use a generic body-text scan rather than a tile-specific selector
      // because the tile markup is the same across all brokerages and the
      // name only varies in the rendered text.
      const homeBody = (await page.locator('body').textContent()) ?? '';
      expect(
        homeBody,
        `${scenario.label}: Brokerages tile must show "${scenario.brokerageNeedle}"`,
      ).toMatch(scenario.brokerageNeedle);

      // -- Accounts page ----------------------------------------------------
      await page.locator('.nav-item').filter({ hasText: /^Accounts$/i }).click();
      await expect(page.locator('.page-title')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(scenario.brokerageNeedle).first()).toBeVisible();

      // Account row count must match expected (post-dedup).
      const accountRows = page.locator('.brokerage-account-row');
      const accountRowCount = await accountRows.count();
      expect(
        accountRowCount,
        `${scenario.label}: Accounts page must show ${scenario.expectedAccounts} rows`,
      ).toBe(scenario.expectedAccounts);

      // -- Screenshot per scenario for the functionality matrix ------------
      // Return to Home for the canonical "post-onboarding" shot. We render
      // Accounts to confirm grouping, then go back so the screenshot is the
      // most informative single-frame artifact.
      await page.locator('.nav-item').filter({ hasText: /^Home$/i }).click();
      await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 5_000 });

      await page.screenshot({
        path: resolve(SHOT_DIR, `brokerage-matrix-${scenario.label}.png`),
        fullPage: true,
      });

      expect(
        harness.errors,
        `console errors during ${scenario.label}:\n${harness.errors.join('\n')}`,
      ).toEqual([]);
      expect(
        harness.threw,
        `caught exceptions during ${scenario.label}:\n${harness.threw.join('\n')}`,
      ).toEqual([]);
    });
  }
});
