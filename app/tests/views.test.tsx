// Lightweight component smoke tests. The big invariants are covered by unit tests;
// these just confirm the views mount without crashing and surface key UI affordances.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MATMON_DATA } from '../src/data';
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

  it('Holdings row click fires onSelect with the symbol', async () => {
    const seen: string[] = [];
    render(<HoldingsView data={MATMON_DATA} onSelect={s => seen.push(s)} />);
    await userEvent.click(screen.getByText('VTI'));
    expect(seen).toContain('VTI');
  });

  it('Planner shows the inputs card + goal slider', () => {
    render(<PlannerView data={MATMON_DATA} />);
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText(/Goal · target balance/i)).toBeInTheDocument();
  });

  it('Achievements shows the just-unlocked hero', () => {
    render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} />);
    expect(screen.getByText(/Just unlocked/i)).toBeInTheDocument();
    // "A millionaire" appears in the hero card and in the collection grid — both are valid.
    expect(screen.getAllByText('A millionaire').length).toBeGreaterThanOrEqual(1);
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

  it('AddAccount sample CSV walks to review step', async () => {
    render(<AddAccountView />);
    const sample = screen.getByRole('button', { name: /Use a sample CSV/i });
    await userEvent.click(sample);
    expect(screen.getByText(/Name this account/i)).toBeInTheDocument();
  });

  it('Settings renders all five sections', () => {
    render(
      <SettingsView
        tweaks={{ theme: 'light' }}
        setTweak={() => {}}
        onRestartOnboarding={() => {}}
      />,
    );
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
});
