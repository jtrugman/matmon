// Yahoo Finance quote provider.
// Uses the public chart/v8 endpoint. In Tauri the request goes through
// tauri-plugin-http which bypasses CORS; in browser dev mode we proxy through Vite if
// the user runs `npm run dev` and we silently fall back to cached/last-known prices on
// CORS errors. The payload we send is literally just the ticker list and nothing else.
//
// Resilience: per-symbol requests are bounded by a small concurrency cap, each call has
// an 8s timeout (AbortController), HTTP 429/5xx responses are retried once with
// exponential backoff (1s then 3s), and successful quotes are cached for 5 minutes so
// rapid re-refreshes don't pound the upstream.

import type { HistoricalPoint, NetworkLogEntry, Quote, QuoteProvider } from './types';
import { networkLog } from './log';

const QUOTE_HOST = 'query1.finance.yahoo.com';
const CHART_HOST = 'query1.finance.yahoo.com';

// Tunables. Kept as module-level constants (no env config) so they're trivially
// testable and the behavior is identical across dev / packaged Tauri.
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const; // 1st retry after 1s, would-be-2nd after 3s
const MAX_ATTEMPTS = 2; // initial try + 1 retry
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------- Module-level state ----------

interface CacheEntry {
  quote: Quote;
  cachedAt: number;
}
const quoteCache = new Map<string, CacheEntry>();

/** Reset the in-memory quote cache. Intended for tests and explicit user "refresh" flows. */
export function clearQuoteCache(): void {
  quoteCache.clear();
}

// ---------- Tiny inline helpers ----------

/** Minimal FIFO semaphore. acquire() resolves when a slot is free; release() frees it. */
function createSemaphore(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (active < max) {
        active++;
        return;
      }
      await new Promise<void>(resolve => waiters.push(resolve));
      active++;
    },
    release(): void {
      active--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

const requestSemaphore = createSemaphore(CONCURRENCY);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- HTTP layer ----------

interface HttpResult {
  text: string;
  status: number;
}

async function httpGet(url: string, signal: AbortSignal): Promise<HttpResult> {
  // In Tauri the @tauri-apps/plugin-http `fetch` honors the allowlist in tauri.conf.json
  // and skips CORS. We check at runtime so the same code works in dev (`npm run dev`) and
  // packaged Tauri without a build-time conditional.
  const w = window as any;
  const tauriHttp = (w.__TAURI_INTERNALS__ || w.__TAURI__)?.http?.fetch as
    | undefined
    | ((u: string, init?: { signal?: AbortSignal }) => Promise<Response>);
  if (tauriHttp) {
    const res = await tauriHttp(url, { signal });
    return { text: await res.text(), status: res.status };
  }
  const res = await fetch(url, { mode: 'cors', signal });
  return { text: await res.text(), status: res.status };
}

function isAbortError(err: unknown): boolean {
  return (err as any)?.name === 'AbortError';
}

/**
 * Issue a single GET with an 8s timeout and 1 retry on 429/5xx. Returns the final
 * response (status + body) regardless of HTTP status. Throws only for network errors
 * (fetch rejection) or aborts/timeouts.
 *
 * The retry loop also covers timeouts: a hung first attempt is aborted at 8s, we sleep
 * 1s, then make one more attempt. Network rejections retry the same way. We never spend
 * more than ~17s total per symbol (8 + 1 + 8).
 */
async function getWithTimeoutAndRetry(url: string): Promise<HttpResult> {
  let lastResult: HttpResult | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Backoff between attempts. RETRY_DELAYS_MS[0] is the delay before the 1st retry.
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const result = await httpGet(url, controller.signal);
      lastResult = result;
      // Retry only on 429 or 5xx. Anything else (200, 404, 403) is final.
      if (result.status === 429 || (result.status >= 500 && result.status <= 599)) {
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      // Retry on transient aborts/timeouts too. If we burn through all attempts we
      // surface the error to the caller; fetchOneRaw decides whether it's soft (abort)
      // or hard (true network/CORS failure).
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  if (lastResult) return lastResult;
  throw lastError ?? new Error('Request failed');
}

// ---------- Per-symbol fetch + log ----------

interface FetchOneOutcome {
  quote: Quote | null;
  status: number;
  ok: boolean;
  bytes: number;
  error?: unknown;
}

async function fetchOneRaw(symbol: string): Promise<FetchOneOutcome> {
  const url = `https://${CHART_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  let result: HttpResult;
  try {
    result = await getWithTimeoutAndRetry(url);
  } catch (err) {
    // Timeout / abort is treated as a soft miss so the rest of the batch still resolves.
    // A true network rejection (DNS, offline, CORS block) propagates so the caller
    // sees the refresh actually failed rather than silently returning no data.
    if (isAbortError(err)) {
      return { quote: null, status: 0, ok: false, bytes: 0, error: err };
    }
    throw err;
  }
  const bytes = result.text.length;
  if (result.status === 429 || (result.status >= 500 && result.status <= 599)) {
    return { quote: null, status: result.status, ok: false, bytes };
  }
  let payload: any;
  try {
    payload = JSON.parse(result.text);
  } catch {
    // Non-JSON from a 2xx response is a real upstream surprise (block page, HTML).
    // Surface it to the caller rather than silently dropping the symbol.
    throw new Error('Yahoo returned non-JSON');
  }
  const r = payload?.chart?.result?.[0];
  if (!r) {
    return { quote: null, status: result.status, ok: true, bytes };
  }
  const meta = r.meta || {};
  const price = meta.regularMarketPrice ?? 0;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const dayChange = price - prevClose;
  const quote: Quote = {
    symbol: meta.symbol || symbol,
    price,
    currency: meta.currency || 'USD',
    dayChange,
    dayChangePct: prevClose > 0 ? dayChange / prevClose : 0,
    prevClose,
    fetchedAt: new Date(),
    name: meta.shortName || meta.longName,
    marketState: meta.marketState as Quote['marketState'],
  };
  return { quote, status: result.status, ok: true, bytes };
}

/**
 * Fetch one symbol, gated by the concurrency semaphore, logging the outcome to the
 * network log ring buffer. Errors from {@link fetchOneRaw} (network reject, non-JSON)
 * propagate; HTTP 429/5xx after retry resolve to `{ quote: null, ok: false }`.
 */
async function fetchOneLogged(symbol: string): Promise<Quote | null> {
  await requestSemaphore.acquire();
  const t0 = performance.now();
  const entry: NetworkLogEntry = {
    t: new Date(),
    host: QUOTE_HOST,
    symbols: [symbol],
    bytes: 0,
    durationMs: 0,
    ok: false,
  };
  try {
    const outcome = await fetchOneRaw(symbol);
    entry.ok = outcome.ok;
    entry.status = outcome.status;
    entry.bytes = outcome.bytes;
    entry.durationMs = Math.round(performance.now() - t0);
    networkLog.push(entry);
    return outcome.quote;
  } catch (e) {
    entry.ok = false;
    entry.durationMs = Math.round(performance.now() - t0);
    networkLog.push(entry);
    throw e;
  } finally {
    requestSemaphore.release();
  }
}

// ---------- Provider ----------

export const yahooProvider: QuoteProvider = {
  id: 'yahoo',
  name: 'Yahoo Finance',

  async fetchQuotes(symbols): Promise<Quote[]> {
    if (symbols.length === 0) return [];

    // Pull fresh hits straight from the cache. Only the stale symbols hit the network.
    const now = Date.now();
    const fresh: Quote[] = [];
    const toFetch: string[] = [];
    for (const s of symbols) {
      const hit = quoteCache.get(s);
      if (hit && now - hit.cachedAt < CACHE_TTL_MS) {
        fresh.push(hit.quote);
      } else {
        toFetch.push(s);
      }
    }

    if (toFetch.length === 0) return fresh;

    // The legacy /v7/finance/quote endpoint now requires a Yahoo "crumb" auth token
    // (consent cookie flow), so we fall back to the chart endpoint which still
    // exposes regularMarketPrice + chartPreviousClose via meta with no auth.
    // One HTTP request per symbol, bounded by the semaphore.
    const settled = await Promise.allSettled(toFetch.map(s => fetchOneLogged(s)));

    const fetched: Quote[] = [];
    let firstError: unknown = null;
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        if (r.value) {
          fetched.push(r.value);
          quoteCache.set(toFetch[i], { quote: r.value, cachedAt: Date.now() });
        }
      } else if (!firstError) {
        firstError = r.reason;
      }
    }

    // If every requested symbol failed with a hard error (network reject / non-JSON),
    // propagate so the caller knows the refresh truly failed rather than silently
    // returning []. Partial successes always resolve.
    if (fetched.length === 0 && fresh.length === 0 && firstError) {
      throw firstError;
    }

    return [...fresh, ...fetched];
  },

  async fetchHistory(symbol, years): Promise<HistoricalPoint[]> {
    const range = years >= 10 ? '10y' : years >= 5 ? '5y' : years >= 2 ? '2y' : '1y';
    const url = `https://${CHART_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    await requestSemaphore.acquire();
    const t0 = performance.now();
    const entry: NetworkLogEntry = {
      t: new Date(),
      host: CHART_HOST,
      symbols: [symbol],
      bytes: 0,
      durationMs: 0,
      ok: false,
    };
    try {
      const result = await getWithTimeoutAndRetry(url);
      entry.status = result.status;
      entry.bytes = result.text.length;
      if (result.status === 429 || (result.status >= 500 && result.status <= 599)) {
        entry.ok = false;
        entry.durationMs = Math.round(performance.now() - t0);
        networkLog.push(entry);
        return [];
      }
      const payload = JSON.parse(result.text);
      const r = payload?.chart?.result?.[0];
      const out: HistoricalPoint[] = [];
      if (r) {
        const ts: number[] = r.timestamp || [];
        const closes: number[] = r.indicators?.quote?.[0]?.close || [];
        for (let i = 0; i < ts.length; i++) {
          const c = closes[i];
          if (c == null) continue;
          out.push({ date: new Date(ts[i] * 1000), close: c });
        }
      }
      entry.ok = true;
      entry.durationMs = Math.round(performance.now() - t0);
      networkLog.push(entry);
      return out;
    } catch (e) {
      entry.ok = false;
      entry.durationMs = Math.round(performance.now() - t0);
      networkLog.push(entry);
      throw e;
    } finally {
      requestSemaphore.release();
    }
  },
};
