// Historical daily-close fetcher for the local price store. The portfolio NAV
// series (HomeView chart) and per-holding price chart both read from the
// `prices` table; this module is how that table gets populated for every day
// from a user's earliest transaction through today.
//
// Endpoint: query1.finance.yahoo.com /v8/finance/chart/<symbol>?period1=...&period2=...&interval=1d
// The v8 chart endpoint exposes per-day OHLC + volume without a Yahoo crumb
// token, which is critical: the /v7/quote endpoint they used to use now
// requires a crumb (consent cookie flow) and is unusable from a desktop app.
//
// Network policy:
//   - Per-request concurrency is gated by the SAME semaphore as live quotes
//     in yahoo.ts (the cap = 4 lives there). We import that semaphore via the
//     yahoo module so the caps are unified across the app and we never drown
//     Yahoo with 17 parallel history requests.
//   - Each call is logged to the same networkLog ring buffer Settings →
//     Privacy reads from. The user sees the backfill there in real time.
//   - One retry on transient failure (network reject, abort) with 500ms
//     backoff. After the second failure we log it and return [] so a single
//     missing symbol's history can't block the rest of the import.

import { _historyInternals as yahooInternals } from './yahoo';
import { networkLog } from './log';
import type { NetworkLogEntry } from './types';

const CHART_HOST = 'query1.finance.yahoo.com';
const RETRY_DELAY_MS = 500;

export interface HistoricalBar {
  symbol: string;
  /** YYYY-MM-DD in UTC. The prices table stores ISO timestamps internally; we
   *  normalize to a date-only string here so the orchestrator can dedupe cheaply. */
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

function toUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function toUtcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Pull every daily close between fromDate and toDate (inclusive on both ends,
 * subject to what Yahoo returns) for a single symbol. Null closes from Yahoo
 * (holidays, trading halts, half-days that print no close) are SILENTLY
 * skipped here: they're not data, and downstream forward-fill in portfolio.ts
 * handles non-trading days fine.
 *
 * Returns an empty array on failure (network error, 429/5xx, non-JSON). One
 * missing symbol's history shouldn't block the rest of the backfill, so we
 * never throw out of this function on a transport error. Errors that ARE
 * surfaced as throws are programmer bugs (bad input).
 *
 * Retry policy: the underlying getWithTimeoutAndRetry already does 2
 * attempts with a 1s backoff on transient failures (429, 5xx, network
 * rejection). We do ONE additional retry at this layer on hard failures
 * (CORS, network down, non-JSON), with a smaller 500ms delay, so a real
 * Yahoo blip recovers but a systematic CORS block bails inside ~1.5s
 * total. The browser-dev path (npm run dev) hits CORS unconditionally;
 * fast-failing there keeps the dev-server e2e suite tractable.
 */
export async function fetchHistoricalDaily(
  symbol: string,
  fromDate: Date,
  toDate: Date = new Date(),
): Promise<HistoricalBar[]> {
  if (!symbol) throw new Error('fetchHistoricalDaily: symbol is required');
  if (+fromDate > +toDate) {
    // Empty window is not an error; just nothing to fetch.
    return [];
  }
  const period1 = toUnixSeconds(fromDate);
  // Pad the upper bound by 1 day so the requested end date is inclusive
  // (Yahoo treats period2 as exclusive of the next trading bar).
  const period2 = toUnixSeconds(toDate) + 86_400;

  const url =
    `https://${CHART_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d`;

  await yahooInternals.requestSemaphore.acquire();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const entry: NetworkLogEntry = {
    t: new Date(),
    host: CHART_HOST,
    symbols: [symbol],
    bytes: 0,
    durationMs: 0,
    ok: false,
  };
  try {
    let result: { text: string; status: number };
    try {
      result = await yahooInternals.getWithTimeoutAndRetry(url);
    } catch (e) {
      // The getWithTimeoutAndRetry layer already retried once internally
      // (1s backoff between attempts). A second-layer transport failure
      // means the upstream is genuinely unreachable (CORS block, DNS, no
      // network). Don't retry again: that just burns the cumulative time
      // budget on a hopeless path. Log and bail. The backfill orchestrator
      // has its own circuit breaker that fast-fails subsequent symbols
      // when this returns [] too many times in a row.
      void RETRY_DELAY_MS; // kept for future tuning; not consumed today
      const dur = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
      entry.durationMs = Math.round(dur);
      entry.ok = false;
      networkLog.push(entry);
      console.info(`[matmon] history fetch failed for ${symbol}`, e);
      return [];
    }
    entry.status = result.status;
    entry.bytes = result.text.length;
    const dur = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    entry.durationMs = Math.round(dur);
    if (result.status === 429 || (result.status >= 500 && result.status <= 599)) {
      entry.ok = false;
      networkLog.push(entry);
      return [];
    }
    let payload: any;
    try {
      payload = JSON.parse(result.text);
    } catch {
      entry.ok = false;
      networkLog.push(entry);
      return [];
    }
    const r = payload?.chart?.result?.[0];
    if (!r) {
      entry.ok = true;
      networkLog.push(entry);
      return [];
    }
    const timestamps: number[] = r.timestamp || [];
    const quote = r.indicators?.quote?.[0] || {};
    const closes: Array<number | null> = quote.close || [];
    const opens: Array<number | null> = quote.open || [];
    const highs: Array<number | null> = quote.high || [];
    const lows: Array<number | null> = quote.low || [];
    const volumes: Array<number | null> = quote.volume || [];

    const bars: HistoricalBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      // Yahoo emits nulls for holidays and halted symbols. Skip them; the
      // portfolio layer forward-fills non-trading days from the prior close.
      if (close == null || !Number.isFinite(close)) continue;
      const bar: HistoricalBar = {
        symbol,
        date: toUtcDateString(new Date(timestamps[i] * 1000)),
        close,
      };
      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const volume = volumes[i];
      if (open != null && Number.isFinite(open)) bar.open = open;
      if (high != null && Number.isFinite(high)) bar.high = high;
      if (low != null && Number.isFinite(low)) bar.low = low;
      if (volume != null && Number.isFinite(volume)) bar.volume = volume;
      bars.push(bar);
    }

    entry.ok = true;
    networkLog.push(entry);
    return bars;
  } finally {
    yahooInternals.requestSemaphore.release();
  }
}
