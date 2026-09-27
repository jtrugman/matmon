// Auto-backfill on HoldingDetailView mount.
//
// When a user opens a per-holding chart and the prices table has no history
// for that symbol, the view should:
//   1. Show a transient inline loading state matching the chart's visual
//      footprint (not block the rest of the page).
//   2. Call backfillHistoricalPrices for THIS one symbol with an earliest
//      date pulled from the user's transactions for that symbol.
//   3. Re-read the prices table when the fetch lands and render the chart.
//   4. Drop to a friendly error empty state if the backfill returns nothing.
//
// These specs mock the backfill module rather than the network so we test
// the view's state machine directly. The integration covers the rest.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as repos from '../src/lib/db/repos';
import * as backfillModule from '../src/lib/quotes/backfill';

import { HoldingDetailView } from '../src/views/HoldingDetailView';
import type { Holding, MatmonData } from '../src/data';
import { MATMON_DATA } from './__fixtures__/sampleData';

// React Testing Library doesn't auto-clean in this project's setup; manual
// cleanup keeps a stale render from bleeding into the next spec.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Build a holding shape for VITAX-like positions. */
function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    sym: 'VITAX',
    name: 'Vanguard Information Technology Index Fund',
    qty: 539.8,
    price: 464.18,
    basis: 250.0,
    sector: 'Technology',
    account: MATMON_DATA.accounts[0].id,
    value: 250_570,
    cost: 135_000,
    gain: 115_570,
    gainPct: 0.856,
    share: 0.15,
    spark: [],
    dayChange: null,
    dayChangePct: null,
    ...overrides,
  };
}

/** Build a populated MatmonData seed for the parent prop. */
function buildData(): MatmonData {
  return { ...MATMON_DATA };
}

describe('HoldingDetailView auto-backfill', () => {
  it('renders the loading state when price history is empty AND fires backfill for the symbol', async () => {
    // The shared mock bar list, mutated when backfill resolves so the
    // post-backfill listPriceHistory read finds something to return.
    const mockBars: Array<{ date: Date; close: number }> = [];

    // listPriceHistory returns the current mockBars contents. Empty before
    // the backfill resolves, populated after.
    vi.spyOn(repos, 'listPriceHistory').mockImplementation(async (sym: string) => {
      if (sym === 'VITAX') return mockBars.slice();
      return [];
    });

    // Seed a transaction for VITAX so the view has an earliest date.
    vi.spyOn(repos, 'loadAllTransactions').mockResolvedValue([
      {
        id: 1,
        account_id: MATMON_DATA.accounts[0].id,
        date: new Date('2017-11-01T00:00:00Z').toISOString(),
        symbol: 'VITAX',
        action: 'buy',
        quantity: 100,
        price: 80,
        fees: 0,
        amount: -8000,
        currency: 'USD',
        notes: '',
        imported_from: null,
      },
    ]);

    // Backfill resolves with synthetic bars. We hold the resolve handle so
    // the test can observe the loading state BEFORE the bars land.
    let resolveBackfill: ((v: { ok: string[]; failed: string[] }) => void) | null = null;
    const backfillSpy = vi
      .spyOn(backfillModule, 'backfillHistoricalPrices')
      .mockImplementation(
        (symbols: string[]) =>
          new Promise<{ ok: string[]; failed: string[] }>(resolve => {
            resolveBackfill = () => {
              // Populate the shared mockBars list so the post-backfill
              // listPriceHistory call sees them.
              const cur = new Date('2017-11-01T00:00:00Z');
              for (let i = 0; i < 100; i++) {
                const d = new Date(cur);
                d.setUTCDate(d.getUTCDate() + i);
                mockBars.push({ date: d, close: 80 + i });
              }
              resolve({ ok: symbols.slice(), failed: [] });
            };
          }),
      );

    render(<HoldingDetailView data={buildData()} holding={makeHolding()} onBack={() => {}} />);

    // Loading state should appear, with the corrected copy mentioning the
    // symbol and the number of years.
    await waitFor(() => {
      expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chart-loading')).toHaveTextContent(/VITAX/);
    expect(screen.getByTestId('chart-loading')).toHaveTextContent(/Fetching/);

    // backfillHistoricalPrices should fire with the right symbol + earliest.
    await waitFor(() => {
      expect(backfillSpy).toHaveBeenCalled();
    });
    const args = backfillSpy.mock.calls[0];
    expect(args[0]).toEqual(['VITAX']);
    const earliest = args[1] as Date;
    expect(earliest.toISOString().slice(0, 10)).toBe('2017-11-01');

    // Now resolve the backfill: the chart should populate and the loading
    // state should drop.
    resolveBackfill!();
    await waitFor(() => {
      expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    });
  });

  it('renders the error empty state when backfill fails for this symbol', async () => {
    vi.spyOn(repos, 'listPriceHistory').mockResolvedValue([]);
    vi.spyOn(repos, 'loadAllTransactions').mockResolvedValue([
      {
        id: 2,
        account_id: MATMON_DATA.accounts[0].id,
        date: new Date('2017-11-01T00:00:00Z').toISOString(),
        symbol: 'VITAX',
        action: 'buy',
        quantity: 100,
        price: 80,
        fees: 0,
        amount: -8000,
        currency: 'USD',
        notes: '',
        imported_from: null,
      },
    ]);
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: [],
      failed: ['VITAX'],
    });

    render(<HoldingDetailView data={buildData()} holding={makeHolding()} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('chart-error')).toBeInTheDocument();
    });
    // The error copy points to Settings → Market data → Refresh history.
    expect(screen.getByTestId('chart-error')).toHaveTextContent(/Settings/);
    expect(screen.getByTestId('chart-error')).toHaveTextContent(/Refresh history/);
  });

  it('skips the backfill and renders the corrected empty-state copy when the holding has zero shares', async () => {
    vi.spyOn(repos, 'listPriceHistory').mockResolvedValue([]);
    vi.spyOn(repos, 'loadAllTransactions').mockResolvedValue([]);
    const backfillSpy = vi.spyOn(backfillModule, 'backfillHistoricalPrices');

    render(
      <HoldingDetailView data={buildData()} holding={makeHolding({ qty: 0 })} onBack={() => {}} />,
    );

    // The view should render the empty-state copy (no chart loading, no
    // backfill fired) for a zero-share position.
    await waitFor(() => {
      expect(
        screen.getByText(/Open Settings, then Market data, then Refresh history/i),
      ).toBeInTheDocument();
    });
    expect(backfillSpy).not.toHaveBeenCalled();
    // CRITICAL: the OLD bad copy must NOT be present. The hint that told
    // users to "Refresh quotes from the Home page" was wrong (quotes !=
    // history) and is the bug we're fixing.
    expect(screen.queryByText(/Refresh quotes from the Home page/i)).not.toBeInTheDocument();
  });

  it('renders the chart directly without firing backfill when history is already populated', async () => {
    // Seed 30 days of stored history so the mount-time read sees rows.
    const rows: Array<{ date: Date; close: number }> = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date('2024-01-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      rows.push({ date: d, close: 100 + i });
    }
    vi.spyOn(repos, 'listPriceHistory').mockResolvedValue(rows);
    vi.spyOn(repos, 'loadAllTransactions').mockResolvedValue([]);
    const backfillSpy = vi.spyOn(backfillModule, 'backfillHistoricalPrices');

    render(<HoldingDetailView data={buildData()} holding={makeHolding()} onBack={() => {}} />);

    // No loading state, no backfill, just the chart.
    await waitFor(() => {
      expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    });
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  it('cleans up cleanly when unmounted mid-backfill (no unmounted setState warning)', async () => {
    vi.spyOn(repos, 'listPriceHistory').mockResolvedValue([]);
    vi.spyOn(repos, 'loadAllTransactions').mockResolvedValue([
      {
        id: 3,
        account_id: MATMON_DATA.accounts[0].id,
        date: new Date('2017-11-01T00:00:00Z').toISOString(),
        symbol: 'VITAX',
        action: 'buy',
        quantity: 1,
        price: 1,
        fees: 0,
        amount: -1,
        currency: 'USD',
        notes: '',
        imported_from: null,
      },
    ]);
    let resolveBackfill: ((v: { ok: string[]; failed: string[] }) => void) | null = null;
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockImplementation(
      () =>
        new Promise(resolve => {
          resolveBackfill = resolve;
        }),
    );
    // Capture console.error so a stray unmounted-setState warning becomes
    // a test failure rather than slipping through silently.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <HoldingDetailView data={buildData()} holding={makeHolding()} onBack={() => {}} />,
    );

    // Wait for the loading state to appear so we know the effect ran.
    await waitFor(() => {
      expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
    });

    // Unmount BEFORE resolving the backfill. The view's cancelled flag
    // should swallow the late resolution without triggering React's
    // unmounted-setState warning.
    unmount();
    resolveBackfill?.({ ok: ['VITAX'], failed: [] });

    // Give microtasks a chance to land.
    await Promise.resolve();
    await Promise.resolve();

    // No React warning about updating state on an unmounted component.
    const calls = errSpy.mock.calls.flat().join(' ');
    expect(calls).not.toContain('unmounted');
    errSpy.mockRestore();
  });
});
