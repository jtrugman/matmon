import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { yahooProvider, createSemaphore } from '../src/lib/quotes/yahoo';
import { networkLog } from '../src/lib/quotes/log';
import { getProvider, setOffline, isOffline, clearQuoteCache } from '../src/lib/quotes';

// fetchQuotes now hits the chart endpoint per symbol (the /v7 quote endpoint
// requires a Yahoo crumb token). One chart payload per symbol.
function chartPayloadFor(symbol: string, price: number, prevClose: number) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            regularMarketPrice: price,
            chartPreviousClose: prevClose,
            currency: 'USD',
            shortName: `${symbol} Inc.`,
            marketState: 'REGULAR',
          },
          timestamp: [1_700_000_000, 1_700_086_400],
          indicators: { quote: [{ close: [prevClose, price] }] },
        },
      ],
    },
  };
}

const CHART_RESPONSE = {
  chart: {
    result: [
      {
        timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
        indicators: { quote: [{ close: [180.5, 182.1, null] }] },
      },
    ],
    error: null,
  },
};

describe('Yahoo provider', () => {
  beforeEach(() => {
    networkLog.clear();
    clearQuoteCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetchQuotes hits one chart endpoint per symbol and normalizes the payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((u: any) => {
      const url = String(u);
      if (url.includes('/AAPL')) {
        return Promise.resolve(
          new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(chartPayloadFor('VTI', 318.45, 319.5)), { status: 200 }) as any,
      );
    });
    const quotes = await yahooProvider.fetchQuotes(['AAPL', 'VTI']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toContain('query1.finance.yahoo.com');
    expect(urls.some(u => u.includes('/AAPL'))).toBe(true);
    expect(urls.some(u => u.includes('/VTI'))).toBe(true);

    expect(quotes).toHaveLength(2);
    const aapl = quotes.find(q => q.symbol === 'AAPL')!;
    expect(aapl.price).toBe(248.3);
    expect(aapl.currency).toBe('USD');
    expect(aapl.dayChange).toBeCloseTo(2.1, 2);
    expect(aapl.dayChangePct).toBeCloseTo(2.1 / 246.2, 4);
    expect(aapl.fetchedAt).toBeInstanceOf(Date);
  });

  it('fetchQuotes returns [] for empty input without hitting the network', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const out = await yahooProvider.fetchQuotes([]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchHistory parses chart payload and drops null closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(CHART_RESPONSE), { status: 200 }) as any,
    );
    const series = await yahooProvider.fetchHistory('AAPL', 1);
    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(180.5);
    expect(series[1].close).toBe(182.1);
  });

  it('fetchHistory range map: years to Yahoo range string', async () => {
    // Each call needs a fresh Response: happy-dom errors if a body is consumed twice.
    const makeResponse = () => new Response(JSON.stringify(CHART_RESPONSE), { status: 200 }) as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(makeResponse()));
    await yahooProvider.fetchHistory('AAPL', 1);
    expect(fetchMock.mock.calls[0][0]).toContain('range=1y');
    await yahooProvider.fetchHistory('AAPL', 3);
    expect(fetchMock.mock.calls[1][0]).toContain('range=2y');
    await yahooProvider.fetchHistory('AAPL', 5);
    expect(fetchMock.mock.calls[2][0]).toContain('range=5y');
    await yahooProvider.fetchHistory('AAPL', 12);
    expect(fetchMock.mock.calls[3][0]).toContain('range=10y');
  });

  it('logs each call to the network log with symbols + duration', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
    );
    await yahooProvider.fetchQuotes(['AAPL']);
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].symbols).toEqual(['AAPL']);
    expect(log[0].host).toBe('query1.finance.yahoo.com');
    expect(log[0].ok).toBe(true);
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs failures too', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(yahooProvider.fetchQuotes(['AAPL'])).rejects.toThrow('boom');
    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
  });

  it('throws helpful error when Yahoo returns non-JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>blocked</html>', { status: 200 }) as any,
    );
    await expect(yahooProvider.fetchQuotes(['AAPL'])).rejects.toThrow(/non-JSON/i);
  });

  it('parses mutual-fund-shape chart response (no chartPreviousClose, only NAV closes)', async () => {
    // VITAX is a mutual fund: the Yahoo chart endpoint returns the same v8
    // wrapper but `meta.chartPreviousClose` is absent (mutual funds only
    // settle once daily, so there's no intraday "previous close" the way
    // there is for equities). The parser must:
    //   - read meta.regularMarketPrice for the current price
    //   - fall back to meta.previousClose (or finally to price itself) when
    //     chartPreviousClose is missing
    //   - never throw on the missing field
    const mutualFundPayload = {
      chart: {
        result: [
          {
            meta: {
              symbol: 'VITAX',
              currency: 'USD',
              regularMarketPrice: 464.5,
              previousClose: 462.1,
              // chartPreviousClose intentionally absent
              shortName: 'Vanguard Information Technology Index Fund',
            },
            timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
            indicators: { quote: [{ close: [460.0, 462.1, 464.5] }] },
          },
        ],
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mutualFundPayload), { status: 200 }) as any,
    );
    const out = await yahooProvider.fetchQuotes(['VITAX']);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('VITAX');
    expect(out[0].price).toBe(464.5);
    // chartPreviousClose missing → falls back to previousClose
    expect(out[0].prevClose).toBe(462.1);
    expect(out[0].dayChange).toBeCloseTo(2.4, 2);
  });

  it('parses mutual-fund-shape response with NO previousClose either (uses price as a safe fallback)', async () => {
    // The absolute worst-case mutual-fund response: meta has only the
    // regularMarketPrice. Parser must not throw; prevClose = price means
    // dayChange = 0, which is the right semantics (no data → no movement).
    const minimalPayload = {
      chart: {
        result: [
          {
            meta: {
              symbol: 'VITAX',
              currency: 'USD',
              regularMarketPrice: 464.5,
            },
            timestamp: [1_700_000_000],
            indicators: { quote: [{ close: [464.5] }] },
          },
        ],
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(minimalPayload), { status: 200 }) as any,
    );
    const out = await yahooProvider.fetchQuotes(['VITAX']);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(464.5);
    // No prevClose data → equals price (the parser's fallback path), so
    // dayChange resolves to 0 rather than NaN.
    expect(out[0].prevClose).toBe(464.5);
    expect(out[0].dayChange).toBe(0);
  });

  // ----- Resilience: concurrency / timeout / retry / cache / partial failure -----

  it('caps concurrent in-flight requests at 4 even with 10 symbols', async () => {
    // Track when each fetch starts and resolves. The mock holds each request open
    // until we explicitly let it through, so we can observe how many are pending at once.
    const pending: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((u: any) => {
      const url = String(u);
      const symbol = url.match(/chart\/([^?]+)/)![1];
      active++;
      peakActive = Math.max(peakActive, active);
      return new Promise<Response>(resolve => {
        pending.push(() => {
          active--;
          resolve(new Response(JSON.stringify(chartPayloadFor(symbol, 100, 99)), { status: 200 }) as any);
        });
      });
    });

    const symbols = Array.from({ length: 10 }, (_, i) => `S${i}`);
    const promise = yahooProvider.fetchQuotes(symbols);

    // Give the event loop a couple of ticks so all initial acquires settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(active).toBeLessThanOrEqual(4);
    expect(peakActive).toBeLessThanOrEqual(4);

    // Drain all pending requests. Each completion frees a slot; new ones spin up.
    while (pending.length > 0) {
      const next = pending.shift()!;
      next();
      // Yield so the next batch of acquires can fire and bump `active` again.
      await Promise.resolve();
      await Promise.resolve();
      expect(active).toBeLessThanOrEqual(4);
    }

    const quotes = await promise;
    expect(quotes).toHaveLength(10);
    expect(peakActive).toBe(4);
  });

  it('times out a hung request at ~8s and treats it as a missing quote', async () => {
    vi.useFakeTimers();
    // First mock: fetch that never resolves (hangs forever) but rejects on abort.
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u: any, init: any = {}) => {
      return new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err: any = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const promise = yahooProvider.fetchQuotes(['HANG']);

    // Two attempts: 8s timeout, 1s backoff, 8s timeout. Advance past the full budget.
    await vi.advanceTimersByTimeAsync(8_500);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(8_500);

    const out = await promise;
    // Timeout is a soft miss: the batch resolves with an empty array, not a throw.
    expect(out).toEqual([]);

    const log = networkLog.list();
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].symbols).toEqual(['HANG']);
  });

  it('retries once on HTTP 429 and returns the success payload', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }) as any);
      }
      return Promise.resolve(
        new Response(JSON.stringify(chartPayloadFor('AAPL', 250, 248)), { status: 200 }) as any,
      );
    });

    const promise = yahooProvider.fetchQuotes(['AAPL']);
    // First call resolves immediately. Drain microtasks, then advance past the 1s backoff.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_100);
    const quotes = await promise;

    expect(calls).toBe(2);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe('AAPL');
    expect(quotes[0].price).toBe(250);
  });

  it('cache hit: second fetchQuotes inside the TTL skips the network', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
      );
    const first = await yahooProvider.fetchQuotes(['AAPL']);
    const second = await yahooProvider.fetchQuotes(['AAPL']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first[0].price).toBe(248.3);
    expect(second[0].price).toBe(248.3);
    // The cached quote is the same object reference, since we stash the resolved Quote.
    expect(second[0]).toBe(first[0]);
  });

  it('clearQuoteCache forces the next fetchQuotes back to the network', async () => {
    // Mint a fresh Response per call: happy-dom errors if a body is consumed twice.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
        ),
      );
    await yahooProvider.fetchQuotes(['AAPL']);
    clearQuoteCache();
    await yahooProvider.fetchQuotes(['AAPL']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('force: true bypasses the cache so explicit user refreshes always hit the network', async () => {
    // Regression: without the force flag, the second click inside the 5-minute
    // TTL is a silent no-op (Justin's "Refresh quotes doesn't seem to do
    // anything" symptom). With force the cache is skipped on demand.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
        ),
      );
    // First call populates the cache (one network hit).
    await yahooProvider.fetchQuotes(['AAPL']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Second call without force: cache hit, no network.
    await yahooProvider.fetchQuotes(['AAPL']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Third call WITH force: cache bypassed, network hit again.
    await yahooProvider.fetchQuotes(['AAPL'], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces per-symbol failures: success + 429 yields partial array AND mixed log entries', async () => {
    vi.useFakeTimers();
    const callsBySymbol = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((u: any) => {
      const url = String(u);
      const symbol = url.includes('/AAPL') ? 'AAPL' : 'VTI';
      const n = (callsBySymbol.get(symbol) ?? 0) + 1;
      callsBySymbol.set(symbol, n);
      if (symbol === 'AAPL') {
        return Promise.resolve(
          new Response(JSON.stringify(chartPayloadFor('AAPL', 248.3, 246.2)), { status: 200 }) as any,
        );
      }
      // VTI is permanently rate-limited; both attempts return 429.
      return Promise.resolve(new Response('slow down', { status: 429 }) as any);
    });

    const promise = yahooProvider.fetchQuotes(['AAPL', 'VTI']);
    // Let AAPL resolve and VTI's first 429 land; then advance past the 1s backoff.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_100);
    const quotes = await promise;

    // AAPL came back; VTI was dropped after the retry still 429'd.
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe('AAPL');

    const log = networkLog.list();
    const aaplEntry = log.find(e => e.symbols[0] === 'AAPL')!;
    const vtiEntry = log.find(e => e.symbols[0] === 'VTI')!;
    expect(aaplEntry).toBeDefined();
    expect(vtiEntry).toBeDefined();
    expect(aaplEntry.ok).toBe(true);
    expect(vtiEntry.ok).toBe(false);
    expect(vtiEntry.status).toBe(429);
  });
});

describe('Network log ring buffer', () => {
  beforeEach(() => networkLog.clear());

  it('stores most recent first', () => {
    networkLog.push({ t: new Date(), host: 'a.com', symbols: ['A'], bytes: 1, durationMs: 1, ok: true });
    networkLog.push({ t: new Date(), host: 'b.com', symbols: ['B'], bytes: 1, durationMs: 1, ok: true });
    expect(networkLog.list().map(e => e.host)).toEqual(['b.com', 'a.com']);
  });

  it('caps entries at 200', () => {
    for (let i = 0; i < 250; i++) {
      networkLog.push({ t: new Date(), host: `h${i}.com`, symbols: [], bytes: 0, durationMs: 0, ok: true });
    }
    expect(networkLog.list()).toHaveLength(200);
  });

  it('notifies subscribers on push', () => {
    let calls = 0;
    const unsub = networkLog.subscribe(() => calls++);
    networkLog.push({ t: new Date(), host: 'x.com', symbols: [], bytes: 0, durationMs: 0, ok: true });
    expect(calls).toBe(1);
    unsub();
    networkLog.push({ t: new Date(), host: 'y.com', symbols: [], bytes: 0, durationMs: 0, ok: true });
    expect(calls).toBe(1); // unsubscribed
  });

  it('clear() empties and notifies', () => {
    networkLog.push({ t: new Date(), host: 'z.com', symbols: [], bytes: 0, durationMs: 0, ok: true });
    let calls = 0;
    networkLog.subscribe(() => calls++);
    networkLog.clear();
    expect(networkLog.list()).toHaveLength(0);
    expect(calls).toBe(1);
  });
});

describe('Semaphore slot ownership', () => {
  // The previous semaphore decremented `active` in release() unconditionally
  // before waking a waiter. A concurrent acquire() in between would see
  // `active < max`, grab the slot, and the woken waiter would then push
  // `active` past `max`, exceeding the concurrency cap. The fix transfers
  // the slot directly to the waker so `active` stays at `max` while there is
  // a queue.
  it('peak active never exceeds max under contended acquire/release', async () => {
    const max = 4;
    const sem = createSemaphore(max) as ReturnType<typeof createSemaphore> & {
      _active(): number;
      _waiterCount(): number;
    };
    const total = 20;

    // Acquire all `total` slots concurrently. The first `max` resolve
    // synchronously; the rest queue up as waiters.
    const acquires = Array.from({ length: total }, () => sem.acquire());
    // Yield so the synchronous acquires settle.
    await Promise.resolve();
    expect(sem._active()).toBe(max);
    expect(sem._waiterCount()).toBe(total - max);

    let peak = sem._active();
    // Drain the queue one slot at a time. Between each release and the
    // resumed waiter actually running, fire a fresh acquire that races for
    // the slot. The fix is what guarantees this newcomer queues rather than
    // overshooting: with the old code, release decremented `active` to 3,
    // the newcomer observed active < max and bumped to 4, then the queued
    // waiter resumed and bumped to 5, blowing the cap. With the fix, the
    // newcomer always queues (the waker owns the slot), so `active` never
    // climbs above `max`.
    for (let i = 0; i < total; i++) {
      sem.release();
      // The racer that should NOT slip past the queued waiter.
      const racer = sem.acquire();
      // Yield enough microtasks for any awaits to land.
      await Promise.resolve();
      await Promise.resolve();
      peak = Math.max(peak, sem._active());
      // Don't await the racer here; it will resolve later via subsequent
      // releases that drain the queue. Track it for cleanup at the end.
      void racer;
    }

    // Drain the remaining queue (one release per still-queued waiter +
    // racer). After all releases, active should be back at 0 and the queue
    // empty.
    while (sem._waiterCount() > 0) {
      sem.release();
      await Promise.resolve();
      await Promise.resolve();
      peak = Math.max(peak, sem._active());
    }

    expect(peak).toBe(max);
    await Promise.all(acquires);
  });

  it('release wakes a waiter without bumping active above max', async () => {
    const sem = createSemaphore(1) as ReturnType<typeof createSemaphore> & {
      _active(): number;
      _waiterCount(): number;
    };
    await sem.acquire();
    expect(sem._active()).toBe(1);

    let waiterRan = false;
    const waiter = sem.acquire().then(() => {
      waiterRan = true;
    });
    await Promise.resolve();
    expect(sem._waiterCount()).toBe(1);

    sem.release();
    await waiter;
    expect(waiterRan).toBe(true);
    // After the wake, the slot belongs to the waiter; active stays at 1.
    expect(sem._active()).toBe(1);

    sem.release();
    expect(sem._active()).toBe(0);
  });
});

describe('Provider registry', () => {
  it('defaults to Yahoo', () => {
    expect(getProvider().id).toBe('yahoo');
  });

  it('offline toggle round-trips', () => {
    expect(isOffline()).toBe(false);
    setOffline(true);
    expect(isOffline()).toBe(true);
    setOffline(false);
  });
});
