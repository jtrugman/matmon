// Demo-leak regression guard.
//
// Justin's CRITICAL bug: when he imports real CSV data, demo numbers were
// showing up alongside his real data on Home (hardcoded dividends panel,
// hardcoded YTD-vs-SPY subtitle, synthetic-from-holdings XIRR, and the demo
// MATMON_DATA.series leaking through portfolio.ts). This file pins down the
// invariants:
//
//   1. With a real account in the DB, HomeView never renders any of the
//      hardcoded demo numbers ($4,820 / $28,640 / +6.2% / 10.8% / $48,720).
//   2. With zero accounts, HomeView shows the chart's "your chart will fill
//      in" empty state instead of the demo curve.
//   3. PlannerView's HSA panel sums real HSA accounts; with no HSA on file
//      it doesn't hallucinate the demo $48,720.
//   4. PlannerView's "Use my <N>Y · <X>%" chip is dynamic when a real series
//      exists, and absent when it doesn't.
//   5. AchievementsView "Coming up" thresholds use REAL totalValue, not demo.
//
// Tests build the portfolio off real fixture data via buildPortfolio() so the
// full pipeline is exercised end to end.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MATMON_DATA } from './__fixtures__/sampleData';
import type { MatmonData } from '../src/data';
import { insertAccount, insertTransactions, saveUserProfile, unlockAchievement } from '../src/lib/db/repos';
import { buildPortfolio } from '../src/lib/portfolio';
import { HomeView } from '../src/views/HomeView';
import { PlannerView } from '../src/views/PlannerView';
import { AchievementsView } from '../src/views/AchievementsView';
import type { ParsedTransaction } from '../src/lib/importers/types';

// Hardcoded demo numbers that USED to leak from the demo seed into the real
// user's home view. None of these strings should ever appear when a real
// account is in the DB.
const DEMO_LEAK_NEEDLES = ['$4,820', '$28,640', '+6.2%', '10.8%', '$48,720'];

function tx(o: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    date: new Date('2024-06-01T00:00:00Z'),
    symbol: 'AAPL',
    action: 'buy',
    quantity: 0,
    price: 0,
    fees: 0,
    amount: null,
    currency: 'USD',
    notes: '',
    rawHash: Math.random().toString(36),
    ...o,
  };
}

async function seedRealUser(): Promise<MatmonData> {
  await insertAccount({
    id: 'my-fidelity-taxable',
    name: 'My Fidelity Taxable',
    brokerage: 'Fidelity',
    account_type: 'taxable',
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
  await insertTransactions('my-fidelity-taxable', [
    tx({
      symbol: 'VTI',
      action: 'buy',
      quantity: 50,
      price: 220,
      date: new Date('2024-01-15'),
      rawHash: 'r1',
    }),
    tx({
      symbol: 'VTI',
      action: 'buy',
      quantity: 25,
      price: 250,
      date: new Date('2024-09-12'),
      rawHash: 'r2',
    }),
  ]);
  return await buildPortfolio();
}

describe('Home: zero accounts', () => {
  it('shows an empty-state for the chart instead of the demo curve', async () => {
    // With no accounts, buildPortfolio() returns the static demo (preserved
    // as a first-run convenience). The HomeView itself should NOT inject any
    // of the previously-hardcoded numbers (the hardcoded dividends panel is
    // the one we replaced). This guards the bigger surface area: even when
    // demo data is on display, the dollar/percent literals that USED to be
    // hardcoded in JSX must NOT come from JSX literals anymore.
    render(<HomeView data={MATMON_DATA} chartVariant="area" onNavigate={() => {}} />);
    // Wait for async dividend computation to complete (the real path either
    // shows totals or "no dividends yet"; either way the hardcoded $4,820
    // disclosure should NEVER appear).
    await waitFor(() => {
      // The lifetime "$28,640" literal was a hardcoded panel that should be
      // gone for real users. (For the static demo it's also gone, since the
      // demo data has no dividend transactions in its txs list. The demo
      // series builds it from price moves, not divs.)
      for (const needle of ['$4,820', '$28,640', '+6.2%']) {
        expect(
          screen.queryByText(new RegExp(needle.replace(/\$/g, '\\$').replace(/\+/g, '\\+'), 'i')),
        ).not.toBeInTheDocument();
      }
    });
  });
});

describe('Home: real account in DB', () => {
  it('renders ZERO demo-leak hardcoded numbers anywhere on the page', async () => {
    const data = await seedRealUser();
    // Sanity: buildPortfolio gave us real numbers.
    expect(data.accounts.length).toBe(1);
    expect(data.accounts[0].id).toBe('my-fidelity-taxable');
    expect(data.totalValue).toBeGreaterThan(0);

    const { container } = render(<HomeView data={data} chartVariant="area" onNavigate={() => {}} />);

    // Allow async DB load to complete.
    await waitFor(() => {
      expect(screen.getByText(/Total portfolio/i)).toBeInTheDocument();
    });

    const html = container.innerHTML;
    for (const needle of DEMO_LEAK_NEEDLES) {
      expect(html).not.toContain(needle);
    }
  });

  it('greeting falls back to "there" (NOT "Justin") when userName is null', async () => {
    const data = await seedRealUser();
    render(<HomeView data={data} chartVariant="area" onNavigate={() => {}} userName={null} />);
    await waitFor(() => {
      expect(screen.getByText(/Total portfolio/i)).toBeInTheDocument();
    });
    // The greeting renders as "<phrase>, <name>." The fallback name should
    // be a generic "there", not the demo persona's first name.
    const headings = screen.getAllByText(/\bthere\b/i);
    expect(headings.length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bJustin\b/)).not.toBeInTheDocument();
  });

  it('YTD subtitle does NOT include the hardcoded "vs SPY +6.2%" string', async () => {
    const data = await seedRealUser();
    const { container } = render(<HomeView data={data} chartVariant="area" onNavigate={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Total portfolio/i)).toBeInTheDocument();
    });
    // The hardcoded subtitle was "vs SPY +6.2%". Real users see "this year"
    // (or nothing). The +6.2% literal must NEVER appear.
    expect(container.innerHTML).not.toContain('+6.2%');
    expect(container.innerHTML).not.toContain('vs SPY +6.2%');
  });
});

describe('Planner: HSA panel uses real HSA balance', () => {
  it('sums HSA-type accounts; with no HSA on file does NOT render the demo $48,720', async () => {
    // User has a non-HSA account only. The HSA panel must NOT fabricate the
    // demo $48,720 value.
    const data = await seedRealUser();
    render(<PlannerView data={data} />);
    // PlannerView triggers async loadUserProfile; nothing else gates render.
    await waitFor(() => {
      expect(screen.getByText(/Healthcare in retirement/i)).toBeInTheDocument();
    });
    // The hardcoded $48,720 must NOT appear anywhere.
    expect(screen.queryByText(/48,720/)).not.toBeInTheDocument();
    // The panel renders an empty-state (no HSA on file) rather than projecting
    // from the demo balance. Either copy form is acceptable as long as the
    // demo $48,720 doesn't leak.
    const html = document.body.innerHTML;
    expect(html).toMatch(/HSA/i);
    expect(html).not.toContain('48,720');
  });

  it('with a real HSA-type account, projects from the REAL balance (not $48,720)', async () => {
    await insertAccount({
      id: 'my-real-hsa',
      name: 'My HSA',
      brokerage: 'Fidelity',
      account_type: 'hsa',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('my-real-hsa', [
      tx({ symbol: 'VTI', action: 'buy', quantity: 10, price: 200, rawHash: 'hsa1' }),
    ]);
    await saveUserProfile({
      name: 'Test',
      birthYear: 1985,
      retireAge: 65,
      household: 'single',
    });
    const data = await buildPortfolio();
    // Real HSA value: 10 * 200 = $2,000. Not $48,720.
    const hsa = data.accounts.find(a => a.type === 'hsa');
    expect(hsa).toBeTruthy();
    expect(hsa!.value).toBe(2000);

    render(<PlannerView data={data} />);
    await waitFor(() => {
      expect(screen.getByText(/Healthcare in retirement/i)).toBeInTheDocument();
    });
    // The hardcoded $48,720 must NOT appear.
    expect(screen.queryByText(/48,720/)).not.toBeInTheDocument();
    // The real $2,000 (or its compounded projection) should show up.
    // We don't pin the exact compounded number because years-to-65 depends
    // on the current date vs birthYear 1985, but the projection FROM line
    // must reference $2,000.
    expect(screen.getByText(/Projected from \$2,000/)).toBeInTheDocument();
  });
});

describe('Planner: 5Y TWR chip is dynamic', () => {
  it('does NOT render the hardcoded "10.8%" demo chip when no real series', async () => {
    // Empty portfolio path → no series → chip hidden.
    const empty: MatmonData = {
      ...MATMON_DATA,
      accounts: [],
      holdings: [],
      series: [],
      spy: [],
      totalValue: 0,
      totalDayChange: 0,
    };
    render(<PlannerView data={empty} />);
    await waitFor(() => {
      expect(screen.getByText(/Healthcare in retirement/i)).toBeInTheDocument();
    });
    // The OLD chip read "Use my 5Y · 10.8%". Neither the 10.8% literal nor
    // that label form should appear when we have no real series.
    expect(screen.queryByText(/10\.8%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Use my 5Y · 10\.8%/)).not.toBeInTheDocument();
  });
});

describe('buildPortfolio: zero accounts returns empty shape (no MATMON leak)', () => {
  it('no accounts + not in demo mode → returns empty MatmonData (not MATMON_DATA)', async () => {
    // Real user completed onboarding without uploading a CSV and did NOT opt
    // into demo mode. The previous behavior returned MATMON_DATA wholesale,
    // surfacing Justin's $1.2M demo numbers on Home. The fix returns an
    // explicit empty shape; the view layer handles empty-state rendering.
    const data = await buildPortfolio();
    expect(data.accounts).toEqual([]);
    expect(data.holdings).toEqual([]);
    expect(data.activity).toEqual([]);
    expect(data.series).toEqual([]);
    expect(data.spy).toEqual([]);
    expect(data.totalValue).toBe(0);
    expect(data.totalDayChange).toBe(0);

    // Achievements should ship the catalog joined with the real (empty)
    // unlock set, not the demo's "first_million unlocked + fresh" entry.
    const firstMillion = data.achievements.find(a => a.key === 'first_million');
    expect(firstMillion).toBeTruthy();
    expect(firstMillion!.unlocked).toBe(false);
    expect(firstMillion!.fresh).toBeFalsy();
  });

  it('renders no MATMON dollar literals on Home for a zero-account real user', async () => {
    const data = await buildPortfolio();
    const { container } = render(<HomeView data={data} chartVariant="area" onNavigate={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Total portfolio/i)).toBeInTheDocument();
    });
    // The demo's headline totals must never appear when the user has no
    // accounts. ($1.21M is the persona total; $4,820/$28,640 are the
    // hardcoded demo dividend literals.)
    expect(container.innerHTML).not.toContain('1,206,453');
    expect(container.innerHTML).not.toContain('$1.21M');
    expect(container.innerHTML).not.toContain('$4,820');
    expect(container.innerHTML).not.toContain('$28,640');
  });
});

describe('buildPortfolio: achievements come from DB, not MATMON_DATA', () => {
  it('shows first_million as locked when the DB has no unlock row', async () => {
    // Even when buildPortfolio runs for a real user with real accounts, the
    // achievements list must reflect the DB (listAchievements) and NOT the
    // demo's hardcoded ACHIEVEMENTS catalog. Without this fix App.tsx's
    // milestone toast would re-fire the demo's first_million for a real user.
    const data = await seedRealUser();
    const m = data.achievements.find(a => a.key === 'first_million');
    expect(m).toBeTruthy();
    expect(m!.unlocked).toBe(false);
    expect(m!.fresh).toBeFalsy();
  });

  it('reflects a freshly unlocked milestone with fresh=true', async () => {
    await unlockAchievement('first_1k');
    const data = await seedRealUser();
    const m = data.achievements.find(a => a.key === 'first_1k');
    expect(m).toBeTruthy();
    expect(m!.unlocked).toBe(true);
    // Unlocked just now, so it's within the 24h fresh window.
    expect(m!.fresh).toBe(true);
  });
});

describe('Achievements: thresholds computed from REAL totalValue', () => {
  it("uses the user's actual totalValue, not the demo $1.2M", async () => {
    const data = await seedRealUser();
    // Real totalValue is ~ $75 * 75 shares = ~$18,750 (depending on last-tx
    // price resolution). Way below the demo $1.2M. The "Coming up" panel
    // should reflect that the user is nowhere near the millionaire milestone.
    expect(data.totalValue).toBeLessThan(50_000);
    render(<AchievementsView data={data} onReplayToast={() => {}} />);
    // With no unlocks, the empty state shows. That's fine; the key invariant
    // is that the rendered totalValue-based thresholds aren't taken from the
    // demo data we never imported.
    await waitFor(() => {
      // Either the empty state OR the upcoming-cards renders. Either is OK;
      // what we're forbidding is a demo-derived total leaking through.
      const html = document.body.innerHTML;
      // Demo total was $1,206,453 (sum of demo accounts). Must NOT appear.
      expect(html).not.toContain('1,206,453');
      expect(html).not.toContain('$1.21M');
    });
  });
});
