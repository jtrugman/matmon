// Unit tests for src/lib/quotes/sector.ts: the Yahoo summaryProfile fetcher
// and the backfillInstruments orchestrator. Covers the wire-level parser
// (full response, missing fields, error shapes), the 90-day skip on
// successful fetches, and the 30-day cooldown on not_found rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOffline } from '../src/lib/quotes';
import { backfillInstruments, fetchInstrumentSector, _ttls } from '../src/lib/quotes/sector';
import {
  getInstrument,
  upsertInstrument,
  insertAccount,
} from '../src/lib/db/repos';
import { networkLog } from '../src/lib/quotes/log';

function quoteSummaryPayload(symbol: string, sector: string, industry: string): any {
  return {
    quoteSummary: {
      result: [
        {
          summaryProfile: {
            sector,
            industry,
            longBusinessSummary: `${symbol} business summary text…`,
            country: 'United States',
            website: `https://example.com/${symbol}`,
          },
        },
      ],
      error: null,
    },
  };
}

describe('fetchInstrumentSector', () => {
  beforeEach(() => {
    networkLog.clear();
    setOffline(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a full Yahoo summaryProfile response into { sector, industry }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(quoteSummaryPayload('VITAX', 'Technology', 'Information Technology')), {
        status: 200,
      }) as any,
    );
    const out = await fetchInstrumentSector('VITAX');
    expect(out).toEqual({ sector: 'Technology', industry: 'Information Technology' });
  });

  it('handles a response with an empty summaryProfile (no sector / no industry) as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          quoteSummary: { result: [{ summaryProfile: {} }], error: null },
        }),
        { status: 200 },
      ) as any,
    );
    const out = await fetchInstrumentSector('XYZ');
    expect(out).toBeNull();
  });

  it('handles a response missing the summaryProfile module as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          quoteSummary: { result: [{}], error: null },
        }),
        { status: 200 },
      ) as any,
    );
    const out = await fetchInstrumentSector('XYZ');
    expect(out).toBeNull();
  });

  it('handles a not-found response (no result array) as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          quoteSummary: { result: [], error: { code: 'Not Found' } },
        }),
        { status: 200 },
      ) as any,
    );
    const out = await fetchInstrumentSector('OBSCURE');
    expect(out).toBeNull();
  });

  it('returns null on cash-sweep symbols without making a network call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const out = await fetchInstrumentSector('SPAXX');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on empty / whitespace symbol without a network call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const out = await fetchInstrumentSector('   ');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on 5xx response without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }) as any,
    );
    const out = await fetchInstrumentSector('AAPL');
    expect(out).toBeNull();
  });

  it('returns null on non-JSON response without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>blocked</html>', { status: 200 }) as any,
    );
    const out = await fetchInstrumentSector('AAPL');
    expect(out).toBeNull();
  });

  it('hits the v10 quoteSummary endpoint with summaryProfile module', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(quoteSummaryPayload('AAPL', 'Technology', 'Consumer Electronics')), {
          status: 200,
        }) as any,
      );
    await fetchInstrumentSector('AAPL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL');
    expect(url).toContain('modules=summaryProfile');
  });
});

describe('backfillInstruments cooldown logic', () => {
  beforeEach(async () => {
    networkLog.clear();
    setOffline(false);
    // Seed an account so the DB driver is initialized; backfillInstruments
    // doesn't actually need accounts but init() must have run.
    await insertAccount({
      id: 'cooldown-test',
      name: 'Cooldown Test',
      brokerage: 'Test',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips a symbol fetched successfully within the 90-day TTL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // Seed an "ok" row from 30 days ago, well inside the 90-day TTL.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await upsertInstrument({
      symbol: 'CACHED1',
      sector: 'Technology',
      industry: 'Software',
      long_name: 'Cached Inc',
      fetched_at_ts: thirtyDaysAgo,
      last_attempt_ts: thirtyDaysAgo,
      last_result: 'ok',
    });
    const result = await backfillInstruments(['CACHED1']);
    expect(result.ok).toEqual(['CACHED1']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a not_found symbol within the 30-day TTL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await upsertInstrument({
      symbol: 'OBSCURE2',
      sector: null,
      industry: null,
      long_name: null,
      fetched_at_ts: 0,
      last_attempt_ts: tenDaysAgo,
      last_result: 'not_found',
    });
    const result = await backfillInstruments(['OBSCURE2']);
    expect(result.notFound).toEqual(['OBSCURE2']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches an ok row that is older than the 90-day TTL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(quoteSummaryPayload('OLD3', 'Energy', 'Oil & Gas')), {
          status: 200,
        }) as any,
      );
    const oldStamp = Date.now() - _ttls.SUCCESS_TTL_MS - 1_000;
    await upsertInstrument({
      symbol: 'OLD3',
      sector: 'Stale',
      industry: 'StaleIndustry',
      long_name: null,
      fetched_at_ts: oldStamp,
      last_attempt_ts: oldStamp,
      last_result: 'ok',
    });
    const result = await backfillInstruments(['OLD3']);
    expect(result.ok).toEqual(['OLD3']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await getInstrument('OLD3');
    expect(row?.sector).toBe('Energy');
    expect(row?.industry).toBe('Oil & Gas');
  });

  it('re-fetches a not_found row that is older than the 30-day TTL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(quoteSummaryPayload('RELISTED4', 'Health', 'Biotech')), {
          status: 200,
        }) as any,
      );
    const oldStamp = Date.now() - _ttls.NOT_FOUND_TTL_MS - 1_000;
    await upsertInstrument({
      symbol: 'RELISTED4',
      sector: null,
      industry: null,
      long_name: null,
      fetched_at_ts: 0,
      last_attempt_ts: oldStamp,
      last_result: 'not_found',
    });
    const result = await backfillInstruments(['RELISTED4']);
    expect(result.ok).toEqual(['RELISTED4']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes a not_found row when Yahoo returns no profile', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          quoteSummary: { result: [], error: { code: 'Not Found' } },
        }),
        { status: 200 },
      ) as any,
    );
    const result = await backfillInstruments(['MISSING5']);
    expect(result.notFound).toContain('MISSING5');
    const row = await getInstrument('MISSING5');
    expect(row?.last_result).toBe('not_found');
    expect(row?.sector).toBeNull();
  });

  it('drops cash-sweep symbols without firing requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await backfillInstruments(['SPAXX', 'FCASH', 'CASH']);
    expect(result.ok).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a successful row to the instruments table on a fresh fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(quoteSummaryPayload('FRESH6', 'Consumer Cyclical', 'Auto Manufacturers')), {
        status: 200,
      }) as any,
    );
    const result = await backfillInstruments(['FRESH6']);
    expect(result.ok).toEqual(['FRESH6']);
    const row = await getInstrument('FRESH6');
    expect(row).toBeTruthy();
    expect(row?.sector).toBe('Consumer Cyclical');
    expect(row?.industry).toBe('Auto Manufacturers');
    expect(row?.last_result).toBe('ok');
  });

  it('returns failed for every symbol when offline (no network calls)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    setOffline(true);
    const result = await backfillInstruments(['ONE7', 'TWO7']);
    expect(result.failed).toEqual(['ONE7', 'TWO7']);
    expect(fetchMock).not.toHaveBeenCalled();
    setOffline(false);
  });
});
