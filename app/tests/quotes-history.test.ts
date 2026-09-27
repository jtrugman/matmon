// Unit tests for fetchHistoricalDaily and backfillHistoricalPrices.
// These cover the wire-level shape (Yahoo chart v8 endpoint), the retry/
// resilience behavior, and the coverage-skip optimization in the backfill
// orchestrator. The Playwright suite covers the integration end-to-end with
// a real Chromium; this suite catches regressions at the unit level so any
// future refactor of history.ts surfaces here first.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { networkLog } from '../src/lib/quotes/log';
import { clearQuoteCache, setOffline } from '../src/lib/quotes';
import { fetchHistoricalDaily } from '../src/lib/quotes/history';
import {
  backfillHistoricalPrices,
  filterBackfillSymbols,
} from '../src/lib/quotes/backfill';
import {
  bulkUpsertPrices,
  getPriceCoverage,
  insertAccount,
  insertTransactions,
  listPriceHistory,
} from '../src/lib/db/repos';

/** Build a Yahoo chart v8 payload with daily closes from `start` for `n` days. */
function chartHistoryPayload(symbol: string, start: Date, n: number, startClose = 100): any {
  const timestamps: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    // Skip weekends so the test mirrors real Yahoo behavior (trading days only).
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    timestamps.push(Math.floor(d.getTime() / 1000));
    // Trivially-monotonic close so test assertions can pin values.
    closes.push(startClose + i);
  }
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: 'USD',
            regularMarketPrice: closes[closes.length - 1],
          },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                close: closes,
                open: closes.map(c => c - 0.5),
                high: closes.map(c => c + 1),
                low: closes.map(c => c - 1),
                volume: closes.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

describe('fetchHistoricalDaily', () => {
  beforeEach(() => {
    networkLog.clear();
    clearQuoteCache();
    setOffline(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hits the v8 chart endpoint with the right period1/period2 + interval=1d', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify(chartHistoryPayload('AAPL', new Date('2024-01-01'), 5)),
          { status: 200 },
        ) as any,
      );
    const from = new Date('2024-01-01T00:00:00Z');
    const to = new Date('2024-01-08T00:00:00Z');
    await fetchHistoricalDaily('AAPL', from, to);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('query1.finance.yahoo.com/v8/finance/chart/AAPL');
    expect(url).toMatch(/period1=\d+/);
    expect(url).toMatch(/period2=\d+/);
    expect(url).toContain('interval=1d');
  });

  it('returns bars with YYYY-MM-DD date strings and parsed closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(chartHistoryPayload('AAPL', new Date('2024-01-01'), 5)),
        { status: 200 },
      ) as any,
    );
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01'),
      new Date('2024-01-08'),
    );
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0].symbol).toBe('AAPL');
    expect(bars[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof bars[0].close).toBe('number');
  });

  it('skips null closes (Yahoo holiday/halt convention)', async () => {
    const payload = chartHistoryPayload('AAPL', new Date('2024-01-01'), 5);
    // Inject a null close in the middle of the series.
    payload.chart.result[0].indicators.quote[0].close[1] = null;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01'),
      new Date('2024-01-08'),
    );
    // Original payload (after weekend filter) was 5 days; we drop 1, so 4.
    expect(bars.length).toBe(
      payload.chart.result[0].indicators.quote[0].close.filter(
        (c: number | null) => c != null,
      ).length,
    );
    for (const b of bars) {
      expect(b.close).not.toBeNull();
    }
  });

  it('pushes one networkLog entry per request with host + bytes + duration', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(chartHistoryPayload('AAPL', new Date('2024-01-01'), 3)),
        { status: 200 },
      ) as any,
    );
    await fetchHistoricalDaily('AAPL', new Date('2024-01-01'), new Date('2024-01-04'));
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].host).toBe('query1.finance.yahoo.com');
    expect(log[0].symbols).toEqual(['AAPL']);
    expect(log[0].ok).toBe(true);
    expect(log[0].bytes).toBeGreaterThan(0);
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns [] on persistent failure rather than throwing (does not block batch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    // Suppress the console.info breadcrumb so the test output stays clean.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bars = await fetchHistoricalDaily(
      'BADSYM',
      new Date('2024-01-01'),
      new Date('2024-01-04'),
    );
    expect(bars).toEqual([]);
    // At least one log entry (network log catches every attempt).
    const log = networkLog.list();
    expect(log.length).toBeGreaterThan(0);
    expect(log.every(e => e.ok === false)).toBe(true);
    infoSpy.mockRestore();
  });

  it('returns [] for an empty (from > to) window without hitting the network', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-02-01'),
      new Date('2024-01-01'),
    );
    expect(bars).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles mutual-fund-shape responses: only meta.regularMarketPrice + daily timestamps + closes', async () => {
    // Real-world VITAX-like response: no chartPreviousClose, no open/high/low/
    // volume arrays, just the closes. The parser should still produce one bar
    // per timestamp without throwing or coercing undefined into NaN.
    const start = new Date('2017-11-01T00:00:00Z');
    const timestamps: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      timestamps.push(Math.floor(d.getTime() / 1000));
      closes.push(80 + i * 0.05); // gentle ramp like a real index fund
    }
    const mutualFundPayload = {
      chart: {
        result: [
          {
            meta: {
              // Mutual funds expose currency and regularMarketPrice, but
              // they SKIP chartPreviousClose entirely (no intraday concept).
              currency: 'USD',
              symbol: 'VITAX',
              regularMarketPrice: closes[closes.length - 1],
              // Intentionally absent: chartPreviousClose, previousClose,
              // exchangeName variants used for ETFs.
            },
            timestamp: timestamps,
            indicators: {
              // Only `close` is present. open/high/low/volume are NOT
              // arrays of the same length; they're missing entirely.
              quote: [{ close: closes }],
            },
          },
        ],
        error: null,
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mutualFundPayload), { status: 200 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'VITAX',
      new Date('2017-11-01'),
      new Date('2026-05-18'),
    );
    // Parser should produce a bar per close. The exact number depends on
    // weekend skipping, but it must be > 1000 (8+ years of trading days)
    // and every bar must have a finite close + symbol + YYYY-MM-DD date.
    expect(bars.length).toBeGreaterThan(1000);
    for (const b of bars) {
      expect(b.symbol).toBe('VITAX');
      expect(typeof b.close).toBe('number');
      expect(Number.isFinite(b.close)).toBe(true);
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // open/high/low/volume are correctly absent (not set to undefined),
      // because the mutual fund payload didn't carry them.
      expect(b.open).toBeUndefined();
      expect(b.high).toBeUndefined();
      expect(b.low).toBeUndefined();
      expect(b.volume).toBeUndefined();
    }
  });

  it('handles a response where indicators.quote is missing entirely (extreme edge case)', async () => {
    // Some Yahoo error paths return result[0] without an indicators block at
    // all. The parser must treat that as "zero bars" rather than throwing.
    const malformed = {
      chart: {
        result: [
          {
            meta: { symbol: 'WEIRD', currency: 'USD' },
            timestamp: [Math.floor(Date.now() / 1000)],
            // indicators is missing
          },
        ],
        error: null,
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(malformed), { status: 200 }) as any,
    );
    const bars = await fetchHistoricalDaily('WEIRD', new Date('2024-01-01'));
    expect(bars).toEqual([]);
  });
});

describe('filterBackfillSymbols', () => {
  it('drops cash sweep tickers (SPAXX, FCASH, QACDS, ...)', () => {
    const out = filterBackfillSymbols(['AAPL', 'SPAXX', 'fcash', 'AMD', 'QACDS', 'cash']);
    expect(out.sort()).toEqual(['AAPL', 'AMD'].sort());
  });

  it('uppercases, trims, and dedupes', () => {
    const out = filterBackfillSymbols(['aapl ', ' AAPL', 'AAPL', 'amd']);
    expect(out.sort()).toEqual(['AAPL', 'AMD'].sort());
  });

  it('drops empty/null entries', () => {
    const out = filterBackfillSymbols(['', null, undefined, 'VTI', '   ']);
    expect(out).toEqual(['VTI']);
  });
});

describe('backfillHistoricalPrices', () => {
  beforeEach(() => {
    networkLog.clear();
    clearQuoteCache();
    setOffline(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes daily closes for every symbol into the prices table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      const symbol = u.match(/chart\/([^?]+)/)![1];
      return Promise.resolve(
        new Response(
          JSON.stringify(chartHistoryPayload(symbol, new Date('2024-01-01'), 10)),
          { status: 200 },
        ) as any,
      );
    });
    const earliest = new Date('2024-01-01');
    const result = await backfillHistoricalPrices(['AAPL', 'VTI'], earliest);
    expect(result.ok.sort()).toEqual(['AAPL', 'VTI'].sort());
    expect(result.failed).toEqual([]);

    const aapl = await listPriceHistory('AAPL');
    const vti = await listPriceHistory('VTI');
    expect(aapl.length).toBeGreaterThan(0);
    expect(vti.length).toBeGreaterThan(0);
  });

  it('fires onProgress once per symbol (done/total/sym)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const symbol = String(url).match(/chart\/([^?]+)/)![1];
      return Promise.resolve(
        new Response(
          JSON.stringify(chartHistoryPayload(symbol, new Date('2024-01-01'), 3)),
          { status: 200 },
        ) as any,
      );
    });
    const calls: Array<{ done: number; total: number; sym: string }> = [];
    await backfillHistoricalPrices(
      ['AAPL', 'VTI', 'AMD'],
      new Date('2024-01-01'),
      (done, total, sym) => {
        calls.push({ done, total, sym });
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0].done).toBe(1);
    expect(calls[0].total).toBe(3);
    expect(calls[2].done).toBe(3);
  });

  it('skips symbols whose stored coverage already spans the requested window', async () => {
    // Seed prices that fully cover [2024-01-01, today]. Two anchor bars are
    // enough for the coverage check, which only looks at MIN/MAX dates.
    const today = new Date();
    await bulkUpsertPrices('AAPL', [
      { date: new Date('2024-01-01'), close: 100 },
      { date: today, close: 200 },
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await backfillHistoricalPrices(['AAPL'], new Date('2024-01-01'));
    expect(result.ok).toEqual(['AAPL']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('force: true re-fetches even when coverage already exists', async () => {
    await bulkUpsertPrices('AAPL', [
      { date: new Date('2024-01-01'), close: 100 },
      { date: new Date(), close: 200 },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(chartHistoryPayload('AAPL', new Date('2024-01-01'), 5)),
        { status: 200 },
      ) as any,
    );
    const result = await backfillHistoricalPrices(['AAPL'], new Date('2024-01-01'), undefined, {
      force: true,
    });
    expect(result.ok).toEqual(['AAPL']);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('drops cash sweep symbols from the work list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(chartHistoryPayload('AAPL', new Date('2024-01-01'), 3)),
        { status: 200 },
      ) as any,
    );
    await backfillHistoricalPrices(['AAPL', 'SPAXX', 'QACDS'], new Date('2024-01-01'));
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('SPAXX'))).toBe(false);
    expect(urls.some(u => u.includes('QACDS'))).toBe(false);
    expect(urls.some(u => u.includes('AAPL'))).toBe(true);
  });

  it('returns all symbols as failed when offline (no network)', async () => {
    setOffline(true);
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const result = await backfillHistoricalPrices(['AAPL', 'VTI'], new Date('2024-01-01'));
      expect(result.ok).toEqual([]);
      expect(result.failed.sort()).toEqual(['AAPL', 'VTI'].sort());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setOffline(false);
    }
  });
});

describe('bulkUpsertPrices', () => {
  it('writes many rows in one transaction', async () => {
    const bars = [
      { date: new Date('2024-01-02'), close: 100 },
      { date: new Date('2024-01-03'), close: 101 },
      { date: new Date('2024-01-04'), close: 102 },
    ];
    await bulkUpsertPrices('MSFT', bars);
    const rows = await listPriceHistory('MSFT');
    expect(rows.length).toBe(3);
    expect(rows[0].close).toBe(100);
    expect(rows[2].close).toBe(102);
  });

  it('replaces existing rows for the same (symbol, date)', async () => {
    await bulkUpsertPrices('GOOG', [{ date: new Date('2024-01-02'), close: 100 }]);
    await bulkUpsertPrices('GOOG', [{ date: new Date('2024-01-02'), close: 999 }]);
    const rows = await listPriceHistory('GOOG');
    expect(rows.length).toBe(1);
    expect(rows[0].close).toBe(999);
  });

  it('is a no-op for an empty batch', async () => {
    await bulkUpsertPrices('NOOP', []);
    const rows = await listPriceHistory('NOOP');
    expect(rows).toEqual([]);
  });
});

describe('getPriceCoverage', () => {
  it('returns null when no rows exist', async () => {
    expect(await getPriceCoverage('NONE')).toBeNull();
  });

  it('returns earliest + latest + count for stored rows', async () => {
    await bulkUpsertPrices('NVDA', [
      { date: new Date('2024-01-02'), close: 100 },
      { date: new Date('2024-06-15'), close: 200 },
      { date: new Date('2024-12-30'), close: 300 },
    ]);
    const cov = await getPriceCoverage('NVDA');
    expect(cov).toBeTruthy();
    expect(cov!.count).toBe(3);
    expect(cov!.earliest.toISOString().slice(0, 10)).toBe('2024-01-02');
    expect(cov!.latest.toISOString().slice(0, 10)).toBe('2024-12-30');
  });
});

describe('portfolio NAV series with historical prices', () => {
  // End-to-end smoke: import transactions, populate the prices table with
  // backfill bars, then build the portfolio and verify the series spans
  // multiple days with values that aren't all identical (the "qty * current
  // price" failure mode would produce a flat curve).
  it('builds a multi-day NAV series with varying values when prices are populated', async () => {
    const { buildPortfolio } = await import('../src/lib/portfolio');
    await insertAccount({
      id: 'a1',
      name: 'a1',
      brokerage: 'Test',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('a1', [
      {
        date: new Date('2024-01-02T00:00:00Z'),
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 100,
        fees: 0,
        amount: -1000,
        currency: 'USD',
        notes: '',
        rawHash: 'h1',
      },
    ]);
    // Populate a 30-day price history with varying closes.
    const bars: Array<{ date: Date; close: number }> = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date('2024-01-02T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      bars.push({ date: d, close: 100 + i }); // 100, 101, ..., 129
    }
    await bulkUpsertPrices('AAPL', bars);

    const p = await buildPortfolio();
    expect(p.series.length).toBeGreaterThan(10);

    // Values should NOT all be identical (the old qty * current price would
    // give a flat curve at 10 * (current price)).
    const uniqueValues = new Set(p.series.map(s => s.value));
    expect(uniqueValues.size).toBeGreaterThan(5);

    // The series spans dates from earliest tx to (near) today.
    const firstDate = p.series[0].date;
    const lastDate = p.series[p.series.length - 1].date;
    expect(+firstDate).toBeLessThanOrEqual(+new Date('2024-01-05T00:00:00Z'));
    expect(+lastDate).toBeGreaterThanOrEqual(+new Date('2024-01-25T00:00:00Z'));
  });
});
