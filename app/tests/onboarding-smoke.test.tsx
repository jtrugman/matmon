// React-level smoke test: drive the real App component through the onboarding
// steps, drop in a CSV via the file input, click "Take me to Matmon", and
// assert HomeView greets the user by name AND surfaces a non-zero totalValue.
//
// The node-level e2e in onboarding-e2e.test.ts proves the data layer is
// internally consistent. This spec proves the React wiring (usePortfolio's
// reload, App's finishOnboarding ordering, HomeView's userName / data props)
// actually delivers that data to the rendered UI on the same tick the user
// finishes onboarding.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { App } from '../src/App';

function loadFixtureCsv(): string | null {
  try {
    return readFileSync(
      '/Users/justintrugman/Development/matmon/app/example_csv/jpm_multiple_accounts.csv',
      'utf8',
    );
  } catch {
    return null;
  }
}

describe('Onboarding smoke: real user types name, uploads CSV, lands on populated Home', () => {
  it('greets the user by name and shows a non-zero portfolio value after finishing', async () => {
    const csv = loadFixtureCsv();
    if (!csv) return; // local-only fixture; skip silently.

    // Capture console.error so we can verify finishOnboarding doesn't swallow
    // a real persistence failure silently. The catch blocks now console.error
    // their cause; nothing in the happy path should trigger one.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const user = userEvent.setup();
    render(<App />);

    // Step 0: welcome screen. Click "Let's set you up".
    const startBtn = await screen.findByRole('button', { name: /let's set you up/i });
    await user.click(startBtn);

    // Step 1: profile. Type a name into the autofocused input.
    const nameInput = await screen.findByPlaceholderText('Justin');
    await user.clear(nameInput);
    await user.type(nameInput, 'Justin');

    // Click continue to advance to step 2 (goal).
    let continueBtn = screen.getByRole('button', { name: /^continue$/i });
    await user.click(continueBtn);

    // Step 2: goal. Default $3M is fine, advance.
    continueBtn = await screen.findByRole('button', { name: /^continue$/i });
    await user.click(continueBtn);

    // Step 3: account upload. Find the hidden file input and feed it our CSV.
    const fileInput = document.querySelector(
      'input[type="file"][accept*=".csv"]',
    ) as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const file = new File([csv], 'jpm.csv', { type: 'text/csv' });
    // happy-dom doesn't yet implement the full DataTransfer constructor, so we
    // assign files directly and dispatch a change event the React handler will
    // pick up.
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { value: [file], configurable: true });
      fireEvent.change(fileInput!);
    });

    // Wait for the upload row to appear (means the importer ran).
    await waitFor(
      () => expect(screen.getByText(/Ready to import/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );

    // Advance to the done step.
    const finishBtn = screen.getByRole('button', { name: /finish setup/i });
    await user.click(finishBtn);

    // Step 4: done. Click "Take me to Matmon" to fire finishOnboarding.
    const takeMeBtn = await screen.findByRole('button', { name: /take me to matmon/i });
    await user.click(takeMeBtn);

    // HomeView should now render with Justin's name AND a non-zero portfolio.
    // The fix in App.tsx reorders finishOnboarding so reload() completes
    // BEFORE setOnboarding(false), which means HomeView mounts with the
    // freshly-imported data already in state. Hence we don't need waitFor for
    // the populated state to land; it's there on the first render after the
    // takeMe click resolves.
    await waitFor(
      () => {
        // The greeting renders the first word of the saved profile name.
        const justinHits = screen.queryAllByText(/Justin/);
        expect(justinHits.length).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );

    // Pull the rendered Total portfolio total-figure out of the DOM and assert
    // it's non-zero. fmtMoney renders the headline figure inside the
    // <div class="total-figure"> wrapper as "<span class="dollar">$</span>NNN".
    // We isolate that wrapper so we don't false-positive on the daychange
    // delta which legitimately renders "+$0" while the portfolio is non-zero.
    const figureEl = document.querySelector('.total-figure');
    expect(figureEl).toBeTruthy();
    const figureText = (figureEl!.textContent || '').replace(/[^0-9.]/g, '');
    const figureValue = parseFloat(figureText);
    expect(figureValue).toBeGreaterThan(0);

    // And finally: the "there" greeting fallback must NOT show.
    const html = document.body.innerHTML;
    // The greeting line is "<phrase>, Justin." not "<phrase>, there."
    expect(html).not.toMatch(/,\s*there\.\s*</);

    // Happy path: no onboarding-persistence errors should have been logged.
    // (If saveUserProfile, insertAccount, insertTransactions, or upsertPrice
    // had silently failed, the new catch-blocks would have surfaced an error
    // prefixed with "[matmon]".)
    const matmonErrors = errSpy.mock.calls
      .map(c => (typeof c[0] === 'string' ? c[0] : ''))
      .filter(s => s.startsWith('[matmon]'));
    expect(matmonErrors).toEqual([]);
    errSpy.mockRestore();
  });
});
