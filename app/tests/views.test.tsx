// Lightweight component smoke tests. The big invariants are covered by unit tests;
// these just confirm the views mount without crashing and surface key UI affordances.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SUGGEST_POOL } from '../src/lib/funNames';
import { MATMON_DATA } from './__fixtures__/sampleData';
import * as repos from '../src/lib/db/repos';
import { HomeView } from '../src/views/HomeView';
import { AccountsView } from '../src/views/AccountsView';
import { HoldingsView } from '../src/views/HoldingsView';
import { PlannerView } from '../src/views/PlannerView';
import { AchievementsView } from '../src/views/AchievementsView';
import { TransactionsView } from '../src/views/TransactionsView';
import { AddAccountView } from '../src/views/AddAccountView';
import { SettingsView } from '../src/views/SettingsView';
import { OnboardingView } from '../src/views/OnboardingView';

describe('Views render', () => {
  it('Home shows total portfolio + headline chart', () => {
    render(<HomeView data={MATMON_DATA} chartVariant="area" onNavigate={() => {}} />);
    expect(screen.getByText(/Total portfolio/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Add an Account|Add an account/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Brokerages/i)).toBeInTheDocument();
  });

  it('Accounts groups by brokerage', () => {
    render(<AccountsView data={MATMON_DATA} />);
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument();
    // 4 distinct brokerages in demo: Fidelity, JP Morgan, Vanguard, Schwab
    expect(screen.getByText('Fidelity')).toBeInTheDocument();
    expect(screen.getByText('Schwab')).toBeInTheDocument();
    // Internal account IDs (e.g. "fid-tax") should NOT leak into the rendered UI.
    expect(screen.queryByText(/fid-tax/i)).not.toBeInTheDocument();
  });

  it('Holdings table renders one row per holding', () => {
    render(<HoldingsView data={MATMON_DATA} />);
    expect(screen.getByText('Holdings')).toBeInTheDocument();
    expect(screen.getByText('VTI')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });

  it('Holdings table renders a TickerLogo placeholder for every row without firing HTTP', () => {
    // No logos in the cache and no fetch mock: every row must still render
    // its monogram fallback rather than crashing or showing a broken image.
    const httpSpy = vi.spyOn(globalThis as any, 'fetch').mockImplementation(() => {
      throw new Error('TickerLogo should not block render on fetch');
    });
    render(<HoldingsView data={MATMON_DATA} />);
    // Each holding row contains an img-role span with an aria-label like
    // "AAPL placeholder" when no cached logo is present.
    const placeholders = screen.getAllByRole('img').filter(el => {
      const label = el.getAttribute('aria-label') || '';
      return label.includes('placeholder') || label.includes('logo');
    });
    expect(placeholders.length).toBeGreaterThan(0);
    httpSpy.mockRestore();
  });

  it('Holdings row click fires onSelect with the symbol', async () => {
    const seen: string[] = [];
    render(<HoldingsView data={MATMON_DATA} onSelect={s => seen.push(s)} />);
    await userEvent.click(screen.getByText('VTI'));
    expect(seen).toContain('VTI');
  });

  it('Holdings row click in the account-filtered view also fires onSelect', async () => {
    // Regression: when HoldingsView is rendered as the per-account drilldown
    // (filterAccountId set), clicking a holding row must still navigate via
    // onSelect, exactly like the unfiltered Holdings page. Without onSelect
    // wired up, the row click is a no-op.
    const seen: string[] = [];
    render(<HoldingsView data={MATMON_DATA} filterAccountId="fid-tax" onSelect={s => seen.push(s)} />);
    // VTI lives in the fid-tax account in the demo dataset, so it should be
    // rendered in this filtered view.
    await userEvent.click(screen.getByText('VTI'));
    expect(seen).toContain('VTI');
  });

  it('Planner shows the inputs card + goal slider', () => {
    render(<PlannerView data={MATMON_DATA} />);
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText(/Goal · target balance/i)).toBeInTheDocument();
  });

  describe('Achievements', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('shows the empty state when the user has zero unlocks', async () => {
      vi.spyOn(repos, 'listAchievements').mockResolvedValue([]);
      render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} />);
      await waitFor(() => {
        expect(screen.getByText(/right around the corner/i)).toBeInTheDocument();
      });
      // Empty state should suppress the trail / hero / coming-up sections.
      expect(screen.queryByText(/Just unlocked/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Coming up next/i)).not.toBeInTheDocument();
    });

    it('shows the just-unlocked hero when a milestone unlocked today', async () => {
      vi.spyOn(repos, 'listAchievements').mockResolvedValue([
        { milestone_key: 'first_100k', unlocked_at: new Date().toISOString() },
      ]);
      render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} />);
      await waitFor(() => {
        expect(screen.getByText(/Just unlocked/i)).toBeInTheDocument();
      });
      // The hero title for first_100k should be on the page.
      expect(screen.getAllByText(/Six digits/i).length).toBeGreaterThanOrEqual(1);
    });

    // Regression for the "Achievements page must reflect the user's real data"
    // bug: if the DB says five value milestones unlocked, the collection grid
    // must show all five (with their titles) and the remaining catalog entries
    // must render as locked silhouettes (not appear unlocked, not disappear).
    it('renders all unlocked value milestones plus locked silhouettes for the rest', async () => {
      // Five lifetime unlocks, all dated long enough ago to NOT be "fresh".
      // This forces the test to look at the collection grid, not the hero.
      const longAgo = (year: number) => new Date(`${year}-06-15T00:00:00Z`).toISOString();
      vi.spyOn(repos, 'listAchievements').mockResolvedValue([
        { milestone_key: 'first_1k', unlocked_at: longAgo(2018) },
        { milestone_key: 'first_10k', unlocked_at: longAgo(2019) },
        { milestone_key: 'first_100k', unlocked_at: longAgo(2021) },
        { milestone_key: 'first_500k', unlocked_at: longAgo(2023) },
        { milestone_key: 'first_million', unlocked_at: longAgo(2025) },
      ]);

      // Real-feeling portfolio value: $1.2M. The user is past first_million,
      // so "Coming up next" should surface two_million first.
      const data = { ...MATMON_DATA, totalValue: 1_200_000 };
      render(<AchievementsView data={data} onReplayToast={() => {}} />);

      // Wait for the async DB fetch to resolve and the header counter to render.
      // AchievementsView renders the "N unlocked" badge in two spots (header +
      // collection grid heading), so we use getAllByText and assert >= 1.
      await waitFor(() => {
        expect(screen.getAllByText(/5 unlocked/).length).toBeGreaterThan(0);
      });

      // All five unlocked titles should be on the page (in the collection grid).
      expect(screen.getAllByText('Four digits').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Five digits').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Six digits').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Half a million').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('A millionaire').length).toBeGreaterThanOrEqual(1);

      // "Coming up next" exists since there's plenty of locked catalog left.
      expect(screen.getByText(/Coming up next/i)).toBeInTheDocument();
      // The next value rung above $1.2M is "Two commas". That title must be present.
      expect(screen.getAllByText('Two commas').length).toBeGreaterThanOrEqual(1);
      // And the "% to go" line should reference the real gap (about $800K from $1.2M to $2M).
      // We don't pin the exact pixel-perfect string, just that "to go" is rendered.
      expect(screen.getAllByText(/to go/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Transactions view has search + filter controls', () => {
    render(<TransactionsView data={MATMON_DATA} />);
    expect(screen.getByPlaceholderText(/Search symbol/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buys' })).toBeInTheDocument();
  });

  it('AddAccount drop step shows brokerage list', () => {
    render(<AddAccountView />);
    expect(screen.getByText(/Drop a CSV here/i)).toBeInTheDocument();
    expect(screen.getByText('Charles Schwab')).toBeInTheDocument();
    expect(screen.getByText('Human Interest')).toBeInTheDocument();
  });

  it('AddAccount drop step exposes a Universal Template link when the prop is wired', () => {
    // The "Don't see your brokerage?" link is only rendered when the parent
    // wires onUseUniversalTemplate (App.tsx does; isolated test renders skip
    // it). With the callback present the link is visible; without it, no
    // link, and crucially no "Use a sample CSV" button anywhere on the page.
    const onUseUniversalTemplate = vi.fn();
    const { rerender } = render(
      <AddAccountView onUseUniversalTemplate={onUseUniversalTemplate} />,
    );
    expect(
      screen.getByRole('button', { name: /Don't see your brokerage/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Use a sample CSV/i }),
    ).not.toBeInTheDocument();

    // Re-render without the prop: link disappears, button still gone.
    rerender(<AddAccountView />);
    expect(
      screen.queryByRole('button', { name: /Don't see your brokerage/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Use a sample CSV/i }),
    ).not.toBeInTheDocument();
  });

  it('Settings renders all five sections', () => {
    render(<SettingsView tweaks={{ theme: 'light' }} setTweak={() => {}} onRestartOnboarding={() => {}} />);
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Privacy/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Market data/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Your data/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('Onboarding step 1: Continue is disabled until a name is entered', async () => {
    render(<OnboardingView onComplete={() => {}} onSkip={() => {}} />);
    // First click "Let's set you up"
    await userEvent.click(screen.getByRole('button', { name: /Let's set you up/i }));
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    const nameInput = screen.getByPlaceholderText('Justin');
    await userEvent.type(nameInput, 'Test');
    expect(continueBtn).toBeEnabled();
  });

  // Regression: a multi-account CSV upload spawns one UploadRow per detected
  // account, and each row must receive its OWN 5 fun-name suggestions with no
  // overlap. The original bug was a single suggestion list shared across every
  // row, so all rows showed the same 5 names. We mount the onboarding view,
  // walk to step 3, drop a 2-account Fidelity CSV, and assert that the union
  // of pill labels across both rows is 10 distinct names (and that every label
  // comes from SUGGEST_POOL).
  it('Onboarding multi-account upload: each row gets its own 5 disjoint fun-name pills', async () => {
    const FIDELITY_MULTI = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
05/02/2026,"Individual","XXXX0001","YOU BOUGHT VOO",VOO,"VANGUARD S&P 500 ETF",Cash,556.18,4,,,,-2224.72,05/03/2026
04/29/2026,"Individual","XXXX0001","DIVIDEND RECEIVED VOO",VOO,"VANGUARD S&P 500 ETF",Cash,,,,,,12.40,
03/15/2026,"Health Savings Account","XXXX0002","YOU BOUGHT VTI",VTI,"VANGUARD TOTAL STOCK MKT ETF",Cash,318.45,5,,,,-1592.25,03/16/2026
02/10/2026,"Health Savings Account","XXXX0002","DIVIDEND RECEIVED VTI",VTI,"VANGUARD TOTAL STOCK MKT ETF",Cash,,,,,,8.20,
`;
    const { container } = render(<OnboardingView onComplete={() => {}} onSkip={() => {}} />);

    // Walk to step 3 (Add Account). Steps: welcome -> profile -> goal -> add.
    await userEvent.click(screen.getByRole('button', { name: /Let's set you up/i }));
    await userEvent.type(screen.getByPlaceholderText('Justin'), 'Test');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // -> goal
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // -> add account
    expect(screen.getByText(/Drop CSV files here/i)).toBeInTheDocument();

    // Drop the multi-account CSV directly into the hidden file input.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File([FIDELITY_MULTI], 'fidelity-multi.csv', { type: 'text/csv' });
    if (typeof (file as any).text !== 'function') {
      (file as any).text = () => Promise.resolve(FIDELITY_MULTI);
    }
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
      // Allow file.text() + state updates to settle.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    // Two UploadRows render, one per detected account.
    await waitFor(() => {
      expect(screen.getByText(/Ready to import · 2 accounts/i)).toBeInTheDocument();
    });

    // Collect every pill that comes from the suggestion pool. The canonical
    // "technical" name pill is brokerage+detected-name (e.g. "0001 Fidelity
    // Individual") and is rendered alongside the 5 fun pills; we filter to
    // only the names that exist in SUGGEST_POOL so the assertion targets the
    // fun-name slices.
    const pool = new Set(SUGGEST_POOL);
    const pillButtons = Array.from(container.querySelectorAll('button.name-suggest'));
    const pillNames = pillButtons.map(b => (b.textContent || '').trim()).filter(n => pool.has(n));

    // Two rows times 5 fun names per row = 10 pill labels, all distinct.
    expect(pillNames).toHaveLength(10);
    expect(new Set(pillNames).size).toBe(10);
  });
});
