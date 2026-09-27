// End-to-end verification of the Human Interest 401(k) onboarding path.
//
// Justin's reality matrix called for confirming Human Interest works end-to-end
// if a sample CSV exists. There is no real export in example_csv/ (those are
// gitignored real brokerage files), but there IS a synthetic fixture at
// src/lib/importers/__fixtures__/humanInterest/basic.csv that mirrors the
// real export shape: holdings-only with Shares, Unit Price, Market Value,
// Employee Contributions, Employer Contributions, and an As Of date.
//
// This spec drives the same fixture through the live Onboarding UI to prove
// the holdings-only path (which synthesizes transfer_in transactions) lands
// on a populated Home with the right brokerage tile. If Justin later drops
// a real Human Interest export into example_csv/, we can swap the path; the
// shape of the test stays the same.

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HI_CSV =
  '/Users/justintrugman/Development/matmon/app/src/lib/importers/__fixtures__/humanInterest/basic.csv';

const SHOT_DIR = resolve(
  '/Users/justintrugman/Development/matmon/app/screenshots',
);
mkdirSync(SHOT_DIR, { recursive: true });

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

test.describe('Human Interest end-to-end', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[matmon-diag]') || t.includes('[matmon]')) {
        // eslint-disable-next-line no-console
        console.log(`  [browser] ${t}`);
      }
    });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByText(/Welcome to Matmon/i)).toBeVisible({ timeout: 10_000 });
  });

  test('synthetic Human Interest fixture onboards into a populated Home', async ({ page }) => {
    const harness = attachConsole(page);

    await page.getByRole('button', { name: /Let's set you up/i }).click();
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /^Continue$/i }).click();

    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(HI_CSV);

    await expect(page.getByText(/Ready to import/i)).toBeVisible({ timeout: 10_000 });

    // The Human Interest brokerage label must appear on the upload row.
    await expect(page.getByText(/Human Interest/i).first()).toBeVisible();

    await page.getByRole('button', { name: /Finish setup/i }).click();
    await expect(page.getByRole('button', { name: /Take me to Matmon/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /Take me to Matmon/i }).click();

    // Landed on Home with Justin's name.
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 10_000 });

    // Home total must render non-zero / non-NaN. The fixture totals ~$71K of
    // synthetic holdings.
    const totalText = (await page.locator('.total-figure').first().textContent()) ?? '';
    expect(totalText).not.toContain('NaN');
    expect(totalText.trim()).not.toBe('--');
    expect(totalText).not.toMatch(/^\s*\$\s*0(\.00)?\s*$/);
    const intPart = totalText
      .replace(/^\s*\$\s*/, '')
      .replace(/\.\d+\s*$/, '')
      .replace(/,/g, '')
      .trim();
    expect(parseInt(intPart, 10), `Home total int "${intPart}" must be > 0`).toBeGreaterThan(0);

    // Brokerages tile shows Human Interest.
    await expect(page.getByText(/Human Interest/i).first()).toBeVisible();

    // Holdings page renders at least one row for the fixture's 12 funds.
    await page.locator('.nav-item').filter({ hasText: /^Holdings$/i }).click();
    const rows = page.locator('.tbl tbody tr');
    const count = await rows.count();
    expect(count, 'Human Interest fixture must produce at least one holding row').toBeGreaterThan(0);

    await page.screenshot({
      path: resolve(SHOT_DIR, 'brokerage-matrix-human-interest.png'),
      fullPage: true,
    });

    expect(
      harness.errors,
      `console errors during Human Interest E2E:\n${harness.errors.join('\n')}`,
    ).toEqual([]);
    expect(
      harness.threw,
      `caught exceptions during Human Interest E2E:\n${harness.threw.join('\n')}`,
    ).toEqual([]);
  });
});
