// Auto-heal recovery: when the user lands on Home with an empty prices
// table (typical of users who onboarded BEFORE the historical-backfill
// orchestrator shipped, OR who somehow have the recovery flag set but no
// stored bars), usePortfolio.maybeRunRecovery must:
//
//   1. Fire automatically on mount with NO user click required.
//   2. Pipe per-symbol progress through to the recoveryProgress state so
//      HomeView can render a visible loading indicator.
//   3. Set recoveryInFlight = true synchronously after the probe gates so
//      the view layer can flip from empty-state to loading-state.
//   4. Rebuild the portfolio progressively as bars land (so the chart
//      visibly fills in instead of staying static).
//   5. Clear recoveryInFlight + recoveryProgress + recoveryNotice when
//      the backfill resolves.
//
// These specs drive the hook directly via renderHook so we can assert on
// the state transitions without the noise of a full App render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import * as repos from '../src/lib/db/repos';
import * as backfillModule from '../src/lib/quotes/backfill';
import * as portfolioModule from '../src/lib/portfolio';
import { usePortfolio, BACKFILL_RECOVERY_V1_KEY } from '../src/lib/usePortfolio';
import type { MatmonData } from '../src/data';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EARLIEST = new Date('2023-01-02T00:00:00Z');

/**
 * Build a MatmonData shell with two real-looking holdings and one demo
 * account so maybeRunRecovery's gate ("user has accounts AND holdings")
 * passes. The series is intentionally empty: that's the signal that the
 * prices table has zero coverage and the recovery should fire.
 */
function buildEmptyBacked(): MatmonData {
  return {
    accounts: [
      {
        id: 'demo-acct',
        name: 'Test Brokerage',
        type: 'taxable',
        brokerage: 'Fidelity',
        value: 100_000,
        dayChange: 0,
        dayChangePending: 0,
      },
    ],
    accountTypes: [
      { id: 'taxable', label: 'Taxable', short: 'TAX', color: '#888' },
    ],
    holdings: [
      {
        sym: 'VTI',
        name: 'Vanguard Total Stock',
        qty: 100,
        price: 220,
        basis: 200,
        sector: '--',
        account: 'demo-acct',
        value: 22_000,
        cost: 20_000,
        gain: 2_000,
        gainPct: 0.1,
        share: 0.5,
        spark: [],
        dayChange: null,
        dayChangePct: null,
      },
      {
        sym: 'AAPL',
        name: 'Apple Inc.',
        qty: 50,
        price: 180,
        basis: 150,
        sector: 'Technology',
        account: 'demo-acct',
        value: 9_000,
        cost: 7_500,
        gain: 1_500,
        gainPct: 0.2,
        share: 0.2,
        spark: [],
        dayChange: null,
        dayChangePct: null,
      },
    ],
    activity: [],
    achievements: [],
    series: [],
    spy: [],
    totalValue: 22_000 + 9_000,
    totalDayChange: 0,
  };
}

describe('usePortfolio auto-heal recovery', () => {
  beforeEach(() => {
    // Default settings: flag is set to "yes" but coverage is empty for every
    // symbol. This is the exact state Justin's portfolio.db hits: the older
    // code path stamped the flag unconditionally, then a clear-cache wiped
    // the prices table. The auto-heal must treat this as "needs recovery"
    // rather than "already done" and re-fire the backfill.
    vi.spyOn(repos, 'getSetting').mockImplementation(async (key: string) => {
      if (key === BACKFILL_RECOVERY_V1_KEY) return 'yes';
      return null;
    });
    vi.spyOn(repos, 'setSetting').mockResolvedValue();
    vi.spyOn(repos, 'getPriceCoverage').mockResolvedValue(null);
    vi.spyOn(repos, 'listAccounts').mockResolvedValue([
      {
        id: 'demo-acct',
        name: 'Test Brokerage',
        brokerage: 'Fidelity',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
    ]);
    vi.spyOn(repos, 'listTransactions').mockResolvedValue([
      {
        id: 1,
        account_id: 'demo-acct',
        date: EARLIEST.toISOString(),
        symbol: 'VTI',
        action: 'buy',
        quantity: 100,
        price: 200,
        fees: 0,
        amount: -20_000,
        currency: 'USD',
        notes: '',
        imported_from: 'seed',
      },
      {
        id: 2,
        account_id: 'demo-acct',
        date: EARLIEST.toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        quantity: 50,
        price: 150,
        fees: 0,
        amount: -7_500,
        currency: 'USD',
        notes: '',
        imported_from: 'seed',
      },
    ]);
    vi.spyOn(repos, 'loadUserProfile').mockResolvedValue({
      name: 'Justin',
      birth_year: 1990,
      retire_age: 65,
      household: 'single',
      theme: 'light',
    });
    // buildPortfolio returns the empty-series shape on first call so we can
    // assert the recovery probe fires. The mid-recovery rebuilds also call
    // buildPortfolio; we keep them returning the same shape so the spec
    // doesn't care about the in-between values, just that the rebuild
    // happens.
    vi.spyOn(portfolioModule, 'buildPortfolio').mockImplementation(async () =>
      buildEmptyBacked(),
    );
  });

  it('fires the recovery probe automatically with no user action', async () => {
    const backfillSpy = vi
      .spyOn(backfillModule, 'backfillHistoricalPrices')
      .mockResolvedValue({ ok: ['VTI', 'AAPL'], failed: [] });

    renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(backfillSpy).toHaveBeenCalled();
      },
      { timeout: 2_000 },
    );
    // The backfill orchestrator was called with the held symbols and the
    // earliest tx date (within day-granularity tolerance).
    const args = backfillSpy.mock.calls[0];
    expect(args[0]).toEqual(['VTI', 'AAPL']);
    const earliest = args[1] as Date;
    expect(earliest.toISOString().slice(0, 10)).toBe(
      EARLIEST.toISOString().slice(0, 10),
    );
  });

  it('passes through an onProgress callback that drives recoveryProgress and recoveryNotice', async () => {
    // Hold the backfill resolution so we can drive per-symbol progress
    // events one at a time and observe the state transitions.
    let onProgressHandle: ((d: number, t: number, sym: string) => void) | null = null;
    let resolveBackfill:
      | ((v: { ok: string[]; failed: string[] }) => void)
      | null = null;
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockImplementation(
      (syms, _earliest, onProgress) => {
        onProgressHandle = onProgress as
          | ((d: number, t: number, sym: string) => void)
          | null;
        return new Promise(resolve => {
          resolveBackfill = () => resolve({ ok: syms.slice(), failed: [] });
        });
      },
    );

    const { result } = renderHook(() => usePortfolio());

    // After the probe gates pass, recoveryInFlight must flip to true with a
    // seeded progress snapshot. The "(0 of N symbols)" copy is the initial
    // pre-fire state.
    await waitFor(
      () => {
        expect(result.current.recoveryInFlight).toBe(true);
      },
      { timeout: 2_000 },
    );
    expect(result.current.recoveryProgress).toEqual({ done: 0, total: 2 });
    expect(result.current.recoveryNotice).toBe(
      'Loading chart history... (0 of 2 symbols)',
    );

    // Drive one symbol's completion. The onProgress callback must flow into
    // the hook's state.
    await act(async () => {
      onProgressHandle!(1, 2, 'VTI');
    });
    expect(result.current.recoveryProgress).toEqual({ done: 1, total: 2 });
    expect(result.current.recoveryNotice).toBe(
      'Loading chart history... (1 of 2 symbols)',
    );

    // Drive the second symbol and resolve.
    await act(async () => {
      onProgressHandle!(2, 2, 'AAPL');
      resolveBackfill!();
      // Yield a microtask so the .finally runs.
      await Promise.resolve();
    });

    // recoveryInFlight clears, recoveryNotice clears, progress clears.
    await waitFor(
      () => {
        expect(result.current.recoveryInFlight).toBe(false);
      },
      { timeout: 2_000 },
    );
    expect(result.current.recoveryProgress).toBeNull();
    expect(result.current.recoveryNotice).toBeNull();
  });

  it('rebuilds the portfolio mid-recovery so the chart fills in progressively', async () => {
    // Capture buildPortfolio so we can count rebuild calls. The implementation
    // throttles rebuilds to every 2 symbols + a final settle, so on 4
    // symbols we expect rebuilds at 2 and 4 (plus the initial load + the
    // sector-backfill rebuild path which we don't trigger here because
    // backfillInstruments is mocked).
    const portfolio4 = buildEmptyBacked();
    portfolio4.holdings.push(
      {
        sym: 'MSFT',
        name: 'Microsoft',
        qty: 10,
        price: 400,
        basis: 200,
        sector: 'Technology',
        account: 'demo-acct',
        value: 4_000,
        cost: 2_000,
        gain: 2_000,
        gainPct: 1,
        share: 0.1,
        spark: [],
        dayChange: null,
        dayChangePct: null,
      },
      {
        sym: 'GOOG',
        name: 'Alphabet',
        qty: 5,
        price: 150,
        basis: 100,
        sector: 'Technology',
        account: 'demo-acct',
        value: 750,
        cost: 500,
        gain: 250,
        gainPct: 0.5,
        share: 0.05,
        spark: [],
        dayChange: null,
        dayChangePct: null,
      },
    );
    const buildSpy = vi
      .spyOn(portfolioModule, 'buildPortfolio')
      .mockImplementation(async () => portfolio4);

    let onProgressHandle: ((d: number, t: number, sym: string) => void) | null = null;
    let resolveBackfill:
      | ((v: { ok: string[]; failed: string[] }) => void)
      | null = null;
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockImplementation(
      (syms, _earliest, onProgress) => {
        onProgressHandle = onProgress as
          | ((d: number, t: number, sym: string) => void)
          | null;
        return new Promise(resolve => {
          resolveBackfill = () => resolve({ ok: syms.slice(), failed: [] });
        });
      },
    );

    renderHook(() => usePortfolio());
    await waitFor(
      () => {
        expect(onProgressHandle).not.toBeNull();
      },
      { timeout: 2_000 },
    );
    const buildCountAtStart = buildSpy.mock.calls.length;

    // Drive 2 progress events; the throttled rebuild should fire after 2.
    await act(async () => {
      onProgressHandle!(1, 4, 'VTI');
      onProgressHandle!(2, 4, 'AAPL');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Wait until the rebuild settles. We count at least one extra
    // buildPortfolio call vs. the baseline (initial load).
    await waitFor(
      () => {
        expect(buildSpy.mock.calls.length).toBeGreaterThan(buildCountAtStart);
      },
      { timeout: 2_000 },
    );

    // Finish up. The final rebuild fires at done === total even if not at
    // the modulo boundary.
    await act(async () => {
      onProgressHandle!(3, 4, 'MSFT');
      onProgressHandle!(4, 4, 'GOOG');
      resolveBackfill!();
      await Promise.resolve();
    });

    await waitFor(
      () => {
        // Two mid-flight rebuilds (at 2 and 4) PLUS the final rebuild in the
        // recovery completion handler. Total extra rebuilds vs. baseline
        // should be >= 2.
        expect(buildSpy.mock.calls.length - buildCountAtStart).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2_000 },
    );
  });

  it('does not fire recovery when held-symbol coverage already exists', async () => {
    // Flip the coverage spy so getPriceCoverage returns a non-empty result
    // for the first probed symbol. The recovery should NOT fire.
    vi.spyOn(repos, 'getPriceCoverage').mockResolvedValue({
      earliest: EARLIEST,
      latest: new Date(),
      count: 250,
    });
    const backfillSpy = vi
      .spyOn(backfillModule, 'backfillHistoricalPrices')
      .mockResolvedValue({ ok: [], failed: [] });

    const { result } = renderHook(() => usePortfolio());

    // Give the probe a beat to settle. recoveryInFlight must stay false.
    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 2_000 },
    );
    expect(result.current.recoveryInFlight).toBe(false);
    expect(result.current.recoveryProgress).toBeNull();
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  it('does not fire recovery when the user has no holdings', async () => {
    vi.spyOn(portfolioModule, 'buildPortfolio').mockImplementation(async () => ({
      accounts: [],
      accountTypes: [],
      holdings: [],
      activity: [],
      achievements: [],
      series: [],
      spy: [],
      totalValue: 0,
      totalDayChange: 0,
    }));
    const backfillSpy = vi
      .spyOn(backfillModule, 'backfillHistoricalPrices')
      .mockResolvedValue({ ok: [], failed: [] });

    const { result } = renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 2_000 },
    );
    expect(result.current.recoveryInFlight).toBe(false);
    expect(backfillSpy).not.toHaveBeenCalled();
  });
});

describe('usePortfolio auto live-refresh on load', () => {
  beforeEach(() => {
    // Default setting state: recovery flag set, no recovery needed (coverage
    // is present for every symbol). The live-refresh path is the only thing
    // we want to exercise here.
    vi.spyOn(repos, 'getSetting').mockImplementation(async (key: string) => {
      if (key === BACKFILL_RECOVERY_V1_KEY) return 'yes';
      return null;
    });
    vi.spyOn(repos, 'setSetting').mockResolvedValue();
    vi.spyOn(repos, 'getPriceCoverage').mockResolvedValue({
      earliest: EARLIEST,
      latest: new Date(),
      count: 500,
    });
    vi.spyOn(repos, 'listAccounts').mockResolvedValue([
      {
        id: 'demo-acct',
        name: 'Test Brokerage',
        brokerage: 'Fidelity',
        account_type: 'taxable',
        currency: 'USD',
        created_at: new Date().toISOString(),
      },
    ]);
    vi.spyOn(repos, 'listTransactions').mockResolvedValue([]);
    vi.spyOn(repos, 'loadUserProfile').mockResolvedValue({
      name: 'Justin',
      birth_year: 1990,
      retire_age: 65,
      household: 'single',
      theme: 'light',
    });
    vi.spyOn(portfolioModule, 'buildPortfolio').mockImplementation(async () =>
      buildEmptyBacked(),
    );
  });

  it('fires refreshQuotes automatically on first load when coverage exists and last live > 1h', async () => {
    // No prior live-fetch timestamp in localStorage so the > 1h gate passes.
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('matmon.quotes.lastLiveFetch.ts');
    }

    const refreshSpy = vi
      .spyOn(portfolioModule, 'refreshQuotes')
      .mockResolvedValue([]);

    renderHook(() => usePortfolio());

    // The refresh is fire-and-forget after reload resolves, so we poll for
    // the spy to register a call. Use a generous window to absorb the
    // coverage-probe loop.
    await waitFor(
      () => {
        expect(refreshSpy).toHaveBeenCalled();
      },
      { timeout: 3_000 },
    );
    // Called with the held symbols and force: true so the 5-minute quote
    // cache doesn't silently no-op the auto-refresh.
    const args = refreshSpy.mock.calls[0];
    expect(args[0]).toEqual(expect.arrayContaining(['VTI', 'AAPL']));
    expect(args[1]).toEqual({ force: true });
  });

  it('skips refresh when the last live fetch is within the 1h window', async () => {
    if (typeof localStorage !== 'undefined') {
      const fresh = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      localStorage.setItem('matmon.quotes.lastLiveFetch.ts', String(fresh));
    }

    const refreshSpy = vi
      .spyOn(portfolioModule, 'refreshQuotes')
      .mockResolvedValue([]);

    const { result } = renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 2_000 },
    );
    // Give the post-reload fire-and-forget a beat. It should NOT call
    // refreshQuotes because the timestamp is fresh.
    await new Promise(r => setTimeout(r, 200));
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('skips refresh when no coverage exists (recovery path handles it instead)', async () => {
    // Override the coverage spy so the live-refresh's first gate trips.
    vi.spyOn(repos, 'getPriceCoverage').mockResolvedValue(null);

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('matmon.quotes.lastLiveFetch.ts');
    }

    const refreshSpy = vi
      .spyOn(portfolioModule, 'refreshQuotes')
      .mockResolvedValue([]);

    const { result } = renderHook(() => usePortfolio());
    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 2_000 },
    );
    await new Promise(r => setTimeout(r, 200));
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
