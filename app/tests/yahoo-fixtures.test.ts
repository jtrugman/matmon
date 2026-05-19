// Real Yahoo response fixtures captured 2026-05-18 via:
//   curl 'https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?period1=...&period2=...&interval=1d'
//
// These tests pin the parser against the actual wire format, not the
// simplified mock shapes the older tests used. If Yahoo changes a response
// field (e.g. drops `chartPreviousClose` for mutual funds) this is the
// first place a regression should fire.
//
// Each fixture lives under tests/__fixtures__/yahoo/ and is committed (public
// market data, no PII). The fixtures cover:
//   - AMD: typical mid-cap equity, 7+ years of bars
//   - SPY: index ETF (S&P 500 benchmark)
//   - VITAX: mutual fund (omits some meta fields)
//   - RKLB: recently-listed (IPO 2020), so timestamps start later than the
//     requested period1
//   - HCMC: penny-stock-like with NULL closes inside the timestamp array
//     (halted trading days)
//   - not-found.json: Yahoo's `chart.error` envelope for a non-existent
//     ticker (200 status code, error in body)
//   - empty-window.json: bad period1/period2 returns the same error
//     envelope shape

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkLog } from '../src/lib/quotes/log';
import { fetchHistoricalDaily } from '../src/lib/quotes/history';

const FIX_DIR = join(__dirname, '__fixtures__', 'yahoo');

function loadFixture(name: string): string {
  return readFileSync(join(FIX_DIR, name), 'utf-8');
}

function makeFetchStub(body: string, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status }) as any,
  );
}

describe('fetchHistoricalDaily against captured Yahoo fixtures', () => {
  it('AMD: parses ~1800 bars across 2018 to 2026 with OHLCV all populated', async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('amd-2018-2026.json'));
    const bars = await fetchHistoricalDaily(
      'AMD',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(bars.length).toBeGreaterThan(1500);
    expect(bars.length).toBeLessThan(2200);
    expect(bars[0].symbol).toBe('AMD');
    expect(bars[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(bars[0].close)).toBe(true);
    // OHLCV populated on a real equity response.
    expect(typeof bars[0].open).toBe('number');
    expect(typeof bars[0].high).toBe('number');
    expect(typeof bars[0].low).toBe('number');
    expect(typeof bars[0].volume).toBe('number');
    // Dates are monotonically increasing.
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].date >= bars[i - 1].date).toBe(true);
    }
    // Network log captured the success annotation.
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(true);
    expect(log[0].note).toMatch(/^OK \d+ bars$/);
  });

  it('SPY: parses an index ETF response (used as the benchmark overlay)', async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('spy-2018-2026.json'));
    const bars = await fetchHistoricalDaily(
      'SPY',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(bars.length).toBeGreaterThan(1500);
    expect(bars[0].symbol).toBe('SPY');
    // SPY had no null closes in the captured window.
    for (const bar of bars) {
      expect(Number.isFinite(bar.close)).toBe(true);
    }
  });

  it('VITAX: mutual fund response (some meta fields absent) still parses cleanly', async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('vitax-2018-2026.json'));
    const bars = await fetchHistoricalDaily(
      'VITAX',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(bars.length).toBeGreaterThan(1500);
    expect(bars[0].symbol).toBe('VITAX');
    // Mutual funds DO include OHLCV in the live response when fetched
    // through the chart endpoint (we verified this on 2026-05-18). The
    // parser tolerates either shape; just assert the closes parsed.
    for (const bar of bars) {
      expect(Number.isFinite(bar.close)).toBe(true);
      expect(bar.close).toBeGreaterThan(0);
    }
  });

  it('RKLB: recently-listed ticker has a narrower timestamp window than the request', async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('rklb-2018-2026.json'));
    const bars = await fetchHistoricalDaily(
      'RKLB',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    // RKLB IPO'd late 2020, so we expect ~1100 bars (not 1800 like AMD).
    expect(bars.length).toBeGreaterThan(900);
    expect(bars.length).toBeLessThan(1300);
    // First bar must be >= 2020 (post-IPO), proving the parser respected
    // Yahoo's authoritative timestamp list and did NOT invent pre-IPO bars.
    expect(bars[0].date >= '2020-01-01').toBe(true);
  });

  it('HCMC: skips null-close bars rather than fabricating zeros', async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('hcmc-edge.json'));
    const bars = await fetchHistoricalDaily(
      'HCMC',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    // The fixture has 1854 timestamps with 2 null closes; the parser
    // must drop the null ones.
    expect(bars.length).toBe(1852);
    for (const bar of bars) {
      expect(bar.close).not.toBeNull();
      expect(Number.isFinite(bar.close)).toBe(true);
    }
  });

  it("Yahoo's chart.error 'Not Found' envelope returns 0 bars with FAIL note", async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('not-found.json'));
    const bars = await fetchHistoricalDaily(
      'NONEXISTENTXYZ123',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].note).toContain('Not Found');
  });

  it("Yahoo's 'Bad Request' (bad period window) returns 0 bars with FAIL note", async () => {
    networkLog.clear();
    makeFetchStub(loadFixture('empty-window.json'));
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2018-01-01T00:00:00Z'),
      new Date('2026-05-18T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].note).toContain('Bad Request');
  });
});

describe('fetchHistoricalDaily error path coverage', () => {
  it('HTTP 429 (after transport-layer retry) returns [] with rate-limit note', async () => {
    networkLog.clear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 429 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    // The transport layer retries once on 429, so we expect a single
    // network log entry (the second attempt also got 429 and we logged
    // the final result).
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].status).toBe(429);
    expect(log[0].note).toMatch(/rate limited/i);
  });

  it('HTTP 503 (after transport-layer retry) returns [] with HTTP code note', async () => {
    networkLog.clear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].note).toContain('503');
  });

  it('non-JSON 200 response returns [] with non-JSON note', async () => {
    networkLog.clear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Yahoo block page</html>', { status: 200 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].note).toMatch(/non-JSON/i);
  });

  it('network rejection returns [] with FAIL <reason> note', async () => {
    networkLog.clear();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    // Suppress the console breadcrumb so test output stays clean.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bars = await fetchHistoricalDaily(
      'AAPL',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].ok).toBe(false);
    expect(log[0].note).toMatch(/FAIL/);
    infoSpy.mockRestore();
  });

  it('empty timestamp array returns [] with EMPTY note (no FAIL)', async () => {
    networkLog.clear();
    const emptyPayload = JSON.stringify({
      chart: {
        result: [
          {
            meta: { symbol: 'EMPTY' },
            timestamp: [],
            indicators: { quote: [{ close: [] }] },
          },
        ],
        error: null,
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(emptyPayload, { status: 200 }) as any,
    );
    const bars = await fetchHistoricalDaily(
      'EMPTY',
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-08T00:00:00Z'),
    );
    expect(bars).toEqual([]);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(true);
    expect(log[0].note).toBe('EMPTY');
  });
});
