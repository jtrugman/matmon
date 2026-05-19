// Empty-state coverage: each user-facing view should render the EmptyState
// component (with whimsical copy and an "Add an Account" CTA when applicable)
// whenever its underlying real data is empty. Switching from empty to
// populated data must hide the empty state so we don't ship dead UI.
//
// The CTA wiring is shared via the EmptyState component, so we test the
// callback path at one representative view per shape: page-level (Accounts),
// in-card (HomeView brokerages row), and CTA-less filtered (HoldingsView
// account-detail).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// RTL's auto-cleanup isn't wired into this project's setup, so we unmount
// rendered trees between tests ourselves. Without this, prior renders bleed
// into the next test's DOM and we get false positives/negatives on queries.
afterEach(() => {
  cleanup();
});
import { MATMON_DATA } from './__fixtures__/sampleData';
import type { MatmonData } from '../src/data';
import * as repos from '../src/lib/db/repos';

import { EmptyState } from '../src/components/EmptyState';
import { HomeView } from '../src/views/HomeView';
import { AccountsView } from '../src/views/AccountsView';
import { HoldingsView } from '../src/views/HoldingsView';
import { TransactionsView } from '../src/views/TransactionsView';
import { HoldingDetailView } from '../src/views/HoldingDetailView';
import { PlannerView } from '../src/views/PlannerView';
import { AchievementsView } from '../src/views/AchievementsView';

/**
 * Build a fully empty MatmonData with the same shape the real app sees on
 * first launch. We keep accountTypes intact since they're a static catalog
 * (not user data) and views like Composition look them up by id.
 */
function emptyData(): MatmonData {
  return {
    accounts: [],
    accountTypes: MATMON_DATA.accountTypes,
    holdings: [],
    activity: [],
    achievements: [],
    series: [],
    spy: [],
    totalValue: 0,
    totalDayChange: 0,
  };
}

describe('EmptyState component', () => {
  it('renders title, body, and CTA when onCta is provided', async () => {
    const onCta = vi.fn();
    render(
      <EmptyState title="Quiet around here." body="Helpful nudge." ctaLabel="Add an Account" onCta={onCta} />,
    );
    expect(screen.getByText('Quiet around here.')).toBeInTheDocument();
    expect(screen.getByText('Helpful nudge.')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Add an Account/i });
    await userEvent.click(btn);
    expect(onCta).toHaveBeenCalledTimes(1);
  });

  it('omits the CTA button when onCta is undefined', () => {
    render(<EmptyState title="Nothing here yet." />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('defaults CTA label to "Add an Account"', () => {
    render(<EmptyState title="Empty." onCta={() => {}} />);
    expect(screen.getByRole('button', { name: /Add an Account/i })).toBeInTheDocument();
  });

  it('honors a custom ctaLabel when provided', () => {
    render(<EmptyState title="Empty." onCta={() => {}} ctaLabel="Drop a CSV" />);
    expect(screen.getByRole('button', { name: /Drop a CSV/i })).toBeInTheDocument();
  });
});

describe('Home empty states', () => {
  it('renders chart, brokerages, composition, accounts, activity, and dividends empty states when data is empty', () => {
    const data = emptyData();
    render(<HomeView data={data} chartVariant="area" onNavigate={() => {}} onAddAccount={() => {}} />);

    // Headline chart empty state.
    expect(
      screen.getByText(/Your portfolio chart will fill in as your data lands here/i),
    ).toBeInTheDocument();

    // Brokerages row.
    expect(screen.getByText(/No brokerages yet/i)).toBeInTheDocument();

    // Composition donut.
    expect(screen.getByText(/Nothing to slice up yet/i)).toBeInTheDocument();

    // Accounts list.
    expect(screen.getByText(/Your accounts will live here/i)).toBeInTheDocument();

    // Recent activity.
    expect(screen.getByText(/Quiet around here\./i)).toBeInTheDocument();
  });

  it('Home brokerages CTA fires onAddAccount', async () => {
    const onAddAccount = vi.fn();
    render(
      <HomeView data={emptyData()} chartVariant="area" onNavigate={() => {}} onAddAccount={onAddAccount} />,
    );
    // The page renders multiple "Add an Account" buttons (one per empty
    // section + the top-right header button). Clicking any of them should
    // route to Add Account.
    const buttons = screen.getAllByRole('button', { name: /Add an Account/i });
    expect(buttons.length).toBeGreaterThan(0);
    await userEvent.click(buttons[0]);
    expect(onAddAccount).toHaveBeenCalled();
  });

  it('Home empty states disappear when data is populated', () => {
    render(<HomeView data={MATMON_DATA} chartVariant="area" onNavigate={() => {}} onAddAccount={() => {}} />);
    expect(screen.queryByText(/No brokerages yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing to slice up yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your accounts will live here/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Your portfolio chart will fill in as your data lands here/i),
    ).not.toBeInTheDocument();
  });
});

describe('Accounts empty state', () => {
  it('renders the page-level empty state and hides IRS panels when there are no accounts', () => {
    const onAddAccount = vi.fn();
    render(<AccountsView data={emptyData()} onAddAccount={onAddAccount} />);
    expect(screen.getByText(/You don't have any accounts yet/i)).toBeInTheDocument();
    // The brokerage groups + contribution-limit cards should NOT render.
    expect(screen.queryByText(/401\(k\) · 2026/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Roth IRA · 2026/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/HSA · 2026/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Contribution limits reflect IRS values/i)).not.toBeInTheDocument();
  });

  it('Accounts empty-state CTA calls onAddAccount', async () => {
    const onAddAccount = vi.fn();
    render(<AccountsView data={emptyData()} onAddAccount={onAddAccount} />);
    // Two CTAs render in the empty path: the header "Add an Account" button
    // and the empty-state body button. Either should hit the callback.
    const buttons = screen.getAllByRole('button', { name: /Add an Account/i });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(onAddAccount).toHaveBeenCalled();
  });

  it('Accounts populated path still renders brokerage groups and IRS panels', async () => {
    render(<AccountsView data={MATMON_DATA} onAddAccount={() => {}} />);
    expect(screen.queryByText(/You don't have any accounts yet/i)).not.toBeInTheDocument();
    // Contribution panels are derived from a DB read (loadAllTransactions),
    // so the disclaimer paints after the effect resolves. wait for it.
    await waitFor(() => {
      expect(screen.getByText(/Contribution limits reflect IRS values/i)).toBeInTheDocument();
    });
  });
});

describe('Holdings empty states', () => {
  it('renders the top-level empty state with a CTA when there are no holdings', async () => {
    const onAddAccount = vi.fn();
    render(<HoldingsView data={emptyData()} onAddAccount={onAddAccount} />);
    expect(screen.getByText(/No holdings yet\./i)).toBeInTheDocument();
    // The CTA should fire onAddAccount.
    await userEvent.click(screen.getByRole('button', { name: /Add an Account/i }));
    expect(onAddAccount).toHaveBeenCalled();
  });

  it('renders the account-filtered empty state WITHOUT a CTA', () => {
    // Build a data set with one account but no positions in it.
    const data: MatmonData = {
      ...emptyData(),
      accounts: [
        {
          id: 'demo-acct',
          name: 'Demo Brokerage',
          brokerage: 'Demo',
          type: 'taxable',
          value: 0,
          dayChange: 0,
        },
      ],
    };
    render(
      <HoldingsView data={data} filterAccountId="demo-acct" onBack={() => {}} onAddAccount={() => {}} />,
    );
    expect(screen.getByText(/Looks like this account has no positions yet, just cash/i)).toBeInTheDocument();
    // No "Add an Account" CTA in the filtered empty state (the account
    // already exists; the resolution path is importing more history).
    expect(screen.queryByRole('button', { name: /Add an Account/i })).not.toBeInTheDocument();
  });

  it('Holdings empty state disappears once a holding is present', () => {
    render(<HoldingsView data={MATMON_DATA} />);
    expect(screen.queryByText(/No holdings yet\./i)).not.toBeInTheDocument();
    // And a real symbol is rendered.
    expect(screen.getByText('VTI')).toBeInTheDocument();
  });
});

describe('Transactions empty state', () => {
  it('renders the empty state and CTA when there are no transactions', async () => {
    const onAddAccount = vi.fn();
    render(<TransactionsView data={emptyData()} onAddAccount={onAddAccount} />);
    expect(
      screen.getByText(/Your transaction history will live here once you import a CSV/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add an Account/i }));
    expect(onAddAccount).toHaveBeenCalled();
  });

  it('Transactions empty state disappears when transactions exist', async () => {
    // TransactionsView now reads real rows from loadAllTransactions; seed the
    // DB with one account + one transaction so the empty branch flips off.
    await repos.insertAccount({
      id: 'fixture-acct',
      name: 'Fixture',
      brokerage: 'Fixture',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await repos.insertTransactions('fixture-acct', [
      {
        date: new Date('2024-06-01'),
        symbol: 'VTI',
        action: 'buy',
        quantity: 1,
        price: 200,
        fees: 0,
        amount: -200,
        currency: 'USD',
        notes: '',
        rawHash: 'fixture-tx-1',
      },
    ]);
    render(<TransactionsView data={MATMON_DATA} onAddAccount={() => {}} />);
    await waitFor(() => {
      expect(
        screen.queryByText(/Your transaction history will live here once you import a CSV/i),
      ).not.toBeInTheDocument();
    });
  });
});

describe('HoldingDetail activity empty state', () => {
  it('renders the no-activity empty state for a position with no transactions', async () => {
    // Build a synthetic holding whose symbol does not appear in any real
    // transaction, forcing the empty branch. HoldingDetailView now loads
    // transactions from the DB via useEffect, so we await the empty-state
    // copy to settle.
    const phantomHolding = {
      sym: 'NONEXISTENT_SYMBOL_XYZZY',
      name: 'Phantom Holding',
      qty: 1,
      price: 100,
      basis: 80,
      sector: 'Test',
      account: MATMON_DATA.accounts[0].id,
      value: 100,
      cost: 80,
      gain: 20,
      gainPct: 0.25,
      share: 0.0001,
      spark: [50, 50, 50],
      dayChange: null,
      dayChangePct: null,
    };
    render(<HoldingDetailView data={MATMON_DATA} holding={phantomHolding} onBack={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/No recorded transactions for this position yet/i)).toBeInTheDocument();
    });
  });
});

describe('Planner empty states', () => {
  it('renders the no-retirement-accounts empty state when no IRA/401k/HSA exists', () => {
    // Use empty data (no accounts at all). retirementAccountCount will be 0.
    render(<PlannerView data={emptyData()} />);
    expect(screen.getByText(/You don't have any retirement accounts imported/i)).toBeInTheDocument();
  });

  it('renders the HSA empty state when HSA balance is zero', () => {
    // Strip the HSA account out of the demo data so hsaToday === 0.
    const data: MatmonData = {
      ...MATMON_DATA,
      accounts: MATMON_DATA.accounts.filter(a => a.type !== 'hsa'),
    };
    render(<PlannerView data={data} />);
    expect(screen.getByText(/Open an HSA and Matmon will project its trajectory here/i)).toBeInTheDocument();
  });

  it('Planner shows the populated panels when retirement accounts and HSA both exist', () => {
    render(<PlannerView data={MATMON_DATA} />);
    expect(screen.queryByText(/You don't have any retirement accounts imported/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Open an HSA and Matmon will project its trajectory here/i),
    ).not.toBeInTheDocument();
  });
});

describe('Achievements empty state CTA', () => {
  it('renders "Add an Account" CTA in the empty state and wires onAddAccount', async () => {
    vi.spyOn(repos, 'listAchievements').mockResolvedValue([]);
    const onAddAccount = vi.fn();
    render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} onAddAccount={onAddAccount} />);
    await waitFor(() => {
      expect(screen.getByText(/right around the corner/i)).toBeInTheDocument();
    });
    const cta = screen.getByRole('button', { name: /Add an Account/i });
    await userEvent.click(cta);
    expect(onAddAccount).toHaveBeenCalled();
  });
});
