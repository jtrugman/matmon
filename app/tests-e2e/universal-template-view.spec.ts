// End-to-end verification of the dedicated Universal Template view.
//
// This replaces the older `universal-template.spec.ts` which drove the
// previous inline UniversalTemplatePanel collapsible. The dedicated view
// surface is the "beta unlock" path for brokerages that Matmon doesn't have
// a native importer for (Human Interest 401(k) is the motivating case).
//
// The spec drives the full path:
//   1. Onboarding's AddAccount step shows a small "Don't see your brokerage?"
//      link below the primary dropzone (no more inline collapsible).
//   2. Clicking the link navigates to the dedicated Universal Template view
//      with hero, download, schema, and upload sections all visible.
//   3. The "Download universal template" button downloads
//      `matmon-template.csv` byte-for-byte from the public asset.
//   4. Uploading a filled template through the dedicated dropzone routes the
//      user to a confirm step on that page.
//   5. Confirming the import lands the user on Home with the imported
//      brokerage tile visible.
//
// If any step fails, the universal-template flow is broken end-to-end and
// the Human Interest path (the original reason the template exists) is dead.

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILLED_TEMPLATE =
  '/Users/justintrugman/Development/matmon/app/tests-e2e/fixtures/matmon-template-filled.csv';

const PUBLIC_TEMPLATE = '/Users/justintrugman/Development/matmon/app/public/matmon-template.csv';

const SHOT_DIR = resolve('/Users/justintrugman/Development/matmon/app/screenshots');
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

test.describe('Universal template view end-to-end', () => {
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

  test('navigates to the dedicated view, downloads template, uploads filled file, and lands on Home', async ({
    page,
  }) => {
    const harness = attachConsole(page);

    // Drive onboarding to the AddAccount step.
    await page.getByRole('button', { name: /Let's set you up/i }).click();
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /^Continue$/i }).click();

    // The AddAccount step shows the small "Don't see your brokerage?" link.
    const link = page.getByRole('button', { name: /Don't see your brokerage/i });
    await expect(link).toBeVisible();

    // Screenshot of the AddAccount step with the link visible (and no "Use a
    // sample CSV" button anywhere, since the broken button is gone).
    await expect(page.getByRole('button', { name: /Use a sample CSV/i })).toHaveCount(0);
    await page.screenshot({
      path: resolve(SHOT_DIR, 'universal-template-link-on-add-account.png'),
      fullPage: true,
    });

    // Click the link, navigate to the dedicated view.
    await link.click();
    const view = page.getByTestId('universal-template-view');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // All three sections + upload card are visible on the dedicated page.
    await expect(page.getByTestId('universal-template-hero')).toBeVisible();
    await expect(page.getByTestId('universal-template-download-card')).toBeVisible();
    await expect(page.getByTestId('universal-template-schema')).toBeVisible();
    await expect(page.getByTestId('universal-template-upload-card')).toBeVisible();

    // The hero copy is the "Don't see your brokerage? No problem." friendly
    // framing required by the spec.
    await expect(page.getByTestId('universal-template-hero')).toContainText(
      /Don't see your brokerage/i,
    );

    // Schema reference shows the canonical 13 columns.
    const schema = page.getByTestId('universal-template-schema');
    await expect(schema).toContainText('Date');
    await expect(schema).toContainText('Action');
    await expect(schema).toContainText('Account');
    await expect(schema).toContainText('Brokerage');
    await expect(schema).toContainText('Notes');

    // Action allow-list values + Account Type values are surfaced inline.
    await expect(schema).toContainText('buy');
    await expect(schema).toContainText('contribution');
    await expect(schema).toContainText('transfer_in');
    await expect(schema).toContainText('trad_401k');
    await expect(schema).toContainText('hsa');

    // Whole-page screenshot of the dedicated view with all sections visible.
    await page.screenshot({
      path: resolve(SHOT_DIR, 'universal-template-view-full.png'),
      fullPage: true,
    });

    // Download fires with the right filename and matches the public asset.
    const downloadBtn = page.getByTestId('universal-template-download');
    await expect(downloadBtn).toBeVisible();
    await expect(downloadBtn).toContainText(/Download universal template/i);
    const downloadPromise = page.waitForEvent('download');
    await downloadBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('matmon-template.csv');
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    const downloadedBytes = readFileSync(downloadedPath!, 'utf8');
    const sourceBytes = readFileSync(PUBLIC_TEMPLATE, 'utf8');
    expect(downloadedBytes).toBe(sourceBytes);
    // Header sanity check: canonical 13-column header.
    expect(downloadedBytes.split('\n')[0]).toBe(
      'Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Brokerage,Account Type,Currency,Notes',
    );

    // Upload the filled template through the dedicated dropzone.
    const fileInput = page.getByTestId('universal-template-file-input');
    await fileInput.setInputFiles(FILLED_TEMPLATE);

    // The page routes to the confirm step (the same "What we figured out"
    // summary that the regular CSV flow uses on AddAccount).
    await expect(page.getByText(/What we figured out/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Custom Brokerage/i).first()).toBeVisible();

    // Confirm the import. The button reads "Add <accountName>"; we match on
    // the leading verb so the assertion doesn't break when the auto-name
    // changes.
    await page.getByRole('button', { name: /^Add /i }).click();
    await expect(page.getByRole('button', { name: /Reload to see it/i })).toBeVisible({
      timeout: 15_000,
    });

    // The "Reload to see it" finish button persists the profile + reloads
    // the portfolio + lands on Home.
    await page.getByRole('button', { name: /Reload to see it/i }).click();

    // Home shows Justin's name and the imported brokerage tile.
    await expect(page.locator('.page-title')).toContainText('Justin', { timeout: 15_000 });
    await expect(page.getByText(/Custom Brokerage/i).first()).toBeVisible();

    // No unfiltered console errors.
    expect(
      harness.errors,
      `console errors during universal-template-view E2E:\n${harness.errors.join('\n')}`,
    ).toEqual([]);
    expect(
      harness.threw,
      `caught exceptions during universal-template-view E2E:\n${harness.threw.join('\n')}`,
    ).toEqual([]);
  });

  test('the static asset is served at /matmon-template.csv with the expected bytes', async ({
    page,
  }) => {
    const response = await page.request.get('/matmon-template.csv');
    expect(response.status()).toBe(200);
    const served = await response.text();
    const sourceBytes = readFileSync(PUBLIC_TEMPLATE, 'utf8');
    expect(served).toBe(sourceBytes);
    const firstLine = served.split('\n')[0];
    expect(firstLine).toBe(
      'Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Brokerage,Account Type,Currency,Notes',
    );
  });

  test('back link returns to the AddAccount step', async ({ page }) => {
    // Drive onboarding to the AddAccount step.
    await page.getByRole('button', { name: /Let's set you up/i }).click();
    await page.getByPlaceholder('Justin').fill('Justin');
    await page.getByRole('button', { name: /^Continue$/i }).click();
    await page.getByRole('button', { name: /^Continue$/i }).click();

    // Open the dedicated view.
    await page.getByRole('button', { name: /Don't see your brokerage/i }).click();
    await expect(page.getByTestId('universal-template-view')).toBeVisible();

    // Click the back link.
    await page.getByTestId('universal-template-back').click();

    // We're back on the AddAccount step with the primary dropzone visible.
    await expect(page.getByText(/Drop CSV files here/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Don't see your brokerage/i })).toBeVisible();
  });
});
