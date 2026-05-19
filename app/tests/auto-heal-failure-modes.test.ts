// Failure-mode coverage for the global auto-heal backfill recovery in
// usePortfolio.maybeRunRecovery. The happy-path is exercised by
// auto-heal-recovery.test.ts; this suite focuses on what happens when
// Yahoo is unhappy:
//
//   1. ALL symbols fail to backfill: the recovery flag must NOT be set
//      (so the next launch retries), the failed-symbol list is persisted,
//      and the user-facing recoveryError surfaces a clear message.
//   2. SOME symbols succeed, others fail: the flag IS set (we have
//      partial data, no need to re-fetch everything next time), but the
//      failed symbols are persisted so a subsequent load retries them
//      with a shortened work list.
//   3. A 429 rate-limit response triggers the transport-layer retry path
//      (we observe a second fetch attempt) before the symbol is bucketed
//      as failed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import * as repos from '../src/lib/db/repos';
import * as backfillModule from '../src/lib/quotes/backfill';
import * as portfolioModule from '../src/lib/portfolio';
import {
  BACKFILL_FAILED_SYMBOLS_KEY,
  BACKFILL_LAST_FAILURE_KEY,
  BACKFILL_RECOVERY_V1_KEY,
  usePortfolio,
} from '../src/lib/usePortfolio';
import type { MatmonData } from '../src/data';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EARLIEST = new Date('2023-01-02T00:00:00Z');

function buildEmptyBacked(holdings: Array<{ sym: string; name: string }>): MatmonData {
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
    accountTypes: [{ id: 'taxable', label: 'Taxable', short: 'TAX', color: '#888' }],
    holdings: holdings.map(h => ({
      sym: h.sym,
      name: h.name,
      qty: 10,
      price: 100,
      basis: 80,
      sector: 'Tech',
      account: 'demo-acct',
      value: 1_000,
      cost: 800,
      gain: 200,
      gainPct: 0.25,
      share: 1 / holdings.length,
      spark: [],
      dayChange: null,
      dayChangePct: null,
    })),
    activity: [],
    achievements: [],
    series: [],
    spy: [],
    totalValue: holdings.length * 1_000,
    totalDayChange: 0,
  };
}

/**
 * Returns a mutable settings store that mimics the persistence layer well
 * enough for the recovery probe + completion handler. We spy on the real
 * getSetting/setSetting so the hook reads back its own writes within a
 * single test (otherwise the "retries failed symbols on next load" path
 * has nothing to observe).
 */
function makeSettingsStore(initial: Record<string, string | null> = {}) {
  const store = new Map<string, string | null>(Object.entries(initial));
  vi.spyOn(repos, 'getSetting').mockImplementation(async (key: string) => {
    return store.get(key) ?? null;
  });
  vi.spyOn(repos, 'setSetting').mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
  });
  return store;
}

function seedListsForTwoSymbols() {
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
      quantity: 10,
      price: 200,
      fees: 0,
      amount: -2_000,
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
      quantity: 5,
      price: 150,
      fees: 0,
      amount: -750,
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
  vi.spyOn(portfolioModule, 'buildPortfolio').mockImplementation(async () =>
    buildEmptyBacked([
      { sym: 'VTI', name: 'Vanguard Total Stock' },
      { sym: 'AAPL', name: 'Apple Inc.' },
    ]),
  );
}

describe('auto-heal recovery: all-fail mode', () => {
  beforeEach(() => {
    makeSettingsStore({});
    seedListsForTwoSymbols();
  });

  it('does NOT set the recovery flag when every symbol fails to fetch', async () => {
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: [],
      failed: ['VTI', 'AAPL'],
    });

    const { result } = renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(result.current.recoveryInFlight).toBe(false);
      },
      { timeout: 3_000 },
    );

    const flagAfter = await repos.getSetting(BACKFILL_RECOVERY_V1_KEY);
    expect(flagAfter).not.toBe('yes');
    const failedAfter = await repos.getSetting(BACKFILL_FAILED_SYMBOLS_KEY);
    expect(failedAfter).toBe('VTI,AAPL');
    const failureTs = await repos.getSetting(BACKFILL_LAST_FAILURE_KEY);
    expect(failureTs).toBeTruthy();
    expect(typeof failureTs).toBe('string');
  });

  it('surfaces a clear recoveryError to the view layer when all symbols fail', async () => {
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: [],
      failed: ['VTI', 'AAPL'],
    });

    const { result } = renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(result.current.recoveryError).not.toBeNull();
      },
      { timeout: 3_000 },
    );
    expect(result.current.recoveryError).toMatch(/Yahoo Finance/i);
    expect(result.current.recoveryError).toMatch(/Refresh history/i);
  });

  it('clearRecoveryError dismisses the banner without re-running the recovery', async () => {
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: [],
      failed: ['VTI', 'AAPL'],
    });

    const { result } = renderHook(() => usePortfolio());
    await waitFor(
      () => {
        expect(result.current.recoveryError).not.toBeNull();
      },
      { timeout: 3_000 },
    );
    result.current.clearRecoveryError();
    await waitFor(
      () => {
        expect(result.current.recoveryError).toBeNull();
      },
      { timeout: 2_000 },
    );
  });
});

describe('auto-heal recovery: partial-fail mode', () => {
  beforeEach(() => {
    makeSettingsStore({});
    seedListsForTwoSymbols();
  });

  it('DOES set the recovery flag when at least one symbol succeeds', async () => {
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: ['VTI'],
      failed: ['AAPL'],
    });

    const { result } = renderHook(() => usePortfolio());
    await waitFor(
      () => {
        expect(result.current.recoveryInFlight).toBe(false);
      },
      { timeout: 3_000 },
    );

    const flagAfter = await repos.getSetting(BACKFILL_RECOVERY_V1_KEY);
    expect(flagAfter).toBe('yes');
    const failedAfter = await repos.getSetting(BACKFILL_FAILED_SYMBOLS_KEY);
    expect(failedAfter).toBe('AAPL');
    // Partial success means no all-failed banner.
    expect(result.current.recoveryError).toBeNull();
  });

  it('clears recoveryError if a prior failure was recorded and this attempt landed bars', async () => {
    // Seed a prior all-failed state.
    makeSettingsStore({
      [BACKFILL_LAST_FAILURE_KEY]: new Date(Date.now() - 60_000).toISOString(),
      [BACKFILL_FAILED_SYMBOLS_KEY]: 'VTI,AAPL',
    });
    seedListsForTwoSymbols();
    vi.spyOn(backfillModule, 'backfillHistoricalPrices').mockResolvedValue({
      ok: ['VTI', 'AAPL'],
      failed: [],
    });

    const { result } = renderHook(() => usePortfolio());
    await waitFor(
      () => {
        expect(result.current.recoveryInFlight).toBe(false);
      },
      { timeout: 3_000 },
    );
    const failureTs = await repos.getSetting(BACKFILL_LAST_FAILURE_KEY);
    expect(failureTs).toBe('');
    const failedAfter = await repos.getSetting(BACKFILL_FAILED_SYMBOLS_KEY);
    expect(failedAfter).toBe('');
  });
});

describe('auto-heal recovery: retry-failed-on-next-load', () => {
  it('a subsequent load only retries the persisted-failed symbols, not the whole list', async () => {
    // Initial state: recovery flag already set, but AAPL is on the failed
    // list and has no coverage. VTI has coverage. The next load should
    // retry AAPL alone, not the full [VTI, AAPL] pair.
    makeSettingsStore({
      [BACKFILL_RECOVERY_V1_KEY]: 'yes',
      [BACKFILL_FAILED_SYMBOLS_KEY]: 'AAPL',
    });
    // Coverage is present for VTI, missing for AAPL.
    vi.spyOn(repos, 'getPriceCoverage').mockImplementation(async (sym: string) => {
      if (sym === 'VTI') {
        return { earliest: EARLIEST, latest: new Date(), count: 250 };
      }
      return null;
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
    vi.spyOn(repos, 'listTransactions').mockResolvedValue([
      {
        id: 1,
        account_id: 'demo-acct',
        date: EARLIEST.toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        quantity: 5,
        price: 150,
        fees: 0,
        amount: -750,
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
    vi.spyOn(portfolioModule, 'buildPortfolio').mockImplementation(async () =>
      buildEmptyBacked([
        { sym: 'VTI', name: 'Vanguard Total Stock' },
        { sym: 'AAPL', name: 'Apple Inc.' },
      ]),
    );
    const backfillSpy = vi
      .spyOn(backfillModule, 'backfillHistoricalPrices')
      .mockResolvedValue({ ok: ['AAPL'], failed: [] });

    renderHook(() => usePortfolio());

    await waitFor(
      () => {
        expect(backfillSpy).toHaveBeenCalled();
      },
      { timeout: 3_000 },
    );

    const args = backfillSpy.mock.calls[0];
    const requestedSymbols = args[0] as string[];
    expect(requestedSymbols).toEqual(['AAPL']);
    // The failed-list should clear after the retry succeeds.
    await waitFor(
      async () => {
        const failedAfter = await repos.getSetting(BACKFILL_FAILED_SYMBOLS_KEY);
        expect(failedAfter).toBe('');
      },
      { timeout: 3_000 },
    );
  });
});

describe('Yahoo 429 rate-limit retry path (transport layer)', () => {
  it('a 429 followed by a 200 lands bars via the transport-layer retry', async () => {
    // Drive the LOW-level fetchHistoricalDaily directly so we exercise the
    // getWithTimeoutAndRetry path without spinning up the full hook. The
    // first call returns 429; the second (after the 1s transport-layer
    // backoff) returns a valid chart payload.
    const { fetchHistoricalDaily } = await import('../src/lib/quotes/history');
    const { networkLog } = await import('../src/lib/quotes/log');
    networkLog.clear();

    const okPayload = {
      chart: {
        result: [
          {
            meta: { symbol: 'AAPL' },
            timestamp: [
              Math.floor(new Date('2024-01-02T00:00:00Z').getTime() / 1000),
              Math.floor(new Date('2024-01-03T00:00:00Z').getTime() / 1000),
            ],
            indicators: { quote: [{ close: [100, 101] }] },
          },
        ],
        error: null,
      },
    };

    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve(new Response('rate limit', { status: 429 }) as any);
      }
      return Promise.resolve(new Response(JSON.stringify(okPayload), { status: 200 }) as any);
    });

    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars.length).toBe(2);
    expect(call).toBeGreaterThanOrEqual(2);
    // The single network log entry reports the FINAL outcome (success).
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(true);
    expect(log[0].note).toMatch(/^OK 2 bars$/);
  }, 10_000);
});
