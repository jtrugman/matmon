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
// ── Real Yahoo response shapes this module handles ─────────────────────────
//
// Captured live in `tests/__fixtures__/yahoo/` against real symbols on
// 2026-05-18. Document the wire-level quirks so future contributors can see
// the contract this parser actually enforces rather than the contract a
// reasonable person might assume.
//
//   1. Success (AMD, SPY, VITAX, RKLB):
//      {
//        chart: {
//          result: [{
//            meta: { symbol, currency, chartPreviousClose?, regularMarketPrice, ... },
//            timestamp: [unix_seconds, ...],
//            indicators: { quote: [{ close: [...], open?, high?, low?, volume? }] }
//          }],
//          error: null
//        }
//      }
//
//   2. Mutual fund (VITAX): same shape, but meta may omit
//      regularMarketDayHigh/Low and regularMarketVolume. The parser doesn't
//      touch those fields, so this is transparent.
//
//   3. Recently-listed (RKLB, IPO 2020): the `timestamp[]` array starts at
//      the listing date even when period1 predates it. The parser treats
//      every timestamp Yahoo returns as authoritative; we never invent
//      bars for the pre-listing window.
//
//   4. Halted / penny-stock null closes (HCMC sample had 2 null closes
//      across ~1850 timestamps): the parser SKIPS those bars rather than
//      coercing them to zero. Downstream forward-fill in portfolio.ts
//      handles non-trading-day gaps.
//
//   5. Not Found / Delisted / Bad Request:
//      {
//        chart: {
//          result: null,
//          error: { code: "Not Found", description: "No data found, symbol may be delisted" }
//        }
//      }
//      The parser returns an empty bars array and stamps the network log
//      entry with the error description so Settings > Privacy shows
//      "FAIL Not Found" rather than a silent miss.
//
//   6. HTTP 429 (rate limited) and 5xx (Yahoo down): handled in the
//      transport layer (yahoo.ts) with 1 retry plus a 1s backoff. If the
//      retry also returns 429/5xx, the parser logs the final status and
//      returns []. This means a single rate-limit blip retries once;
//      sustained 429s give up rather than burning the entire fetch budget
//      against a wall.
//
//   7. Non-JSON 2xx (Yahoo block page, HTML): defensive try/catch around
//      JSON.parse returns [] rather than throwing. The network log entry
//      records ok: false with the byte count so the user sees something
//      came back, just not parseable.
//
// Network policy:
//   - Per-request concurrency is gated by the SAME semaphore as live quotes
//     in yahoo.ts (the cap = 4 lives there). We import that semaphore via the
//     yahoo module so the caps are unified across the app and we never drown
//     Yahoo with 17 parallel history requests.
//   - Each call is logged to the same networkLog ring buffer Settings >
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
 * Returns an empty array on failure (network error, 429/5xx, non-JSON, Yahoo
 * `chart.error` object). One missing symbol's history shouldn't block the
 * rest of the backfill, so we never throw out of this function on a transport
 * error. Errors that ARE surfaced as throws are programmer bugs (bad input).
 *
 * Every call appends ONE entry to the networkLog ring buffer with a structured
 * note ("OK N bars", "EMPTY", "FAIL <reason>") so Settings > Privacy renders
 * the outcome of each symbol fetch without needing devtools.
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
  // Captures the structured note shown to the user. Mutated in place so the
  // single `networkLog.push(entry)` at the end of the function always emits
  // one log row per fetch attempt.
  const setNote = (note: string) => {
    entry.note = note;
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
      const reason = describeTransportError(e);
      setNote(`FAIL ${reason}`);
      networkLog.push(entry);
      console.info(`[matmon] history fetch failed for ${symbol}`, e);
      return [];
    }
    entry.status = result.status;
    entry.bytes = result.text.length;
    const dur = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    entry.durationMs = Math.round(dur);
    if (result.status === 429) {
      // Rate limited. The transport layer already retried once with a 1s
      // backoff; getting 429 here means Yahoo is genuinely throttling us.
      // We surface this distinctly so the diagnostic panel can hint at it.
      entry.ok = false;
      setNote('FAIL HTTP 429 rate limited');
      networkLog.push(entry);
      return [];
    }
    if (result.status >= 500 && result.status <= 599) {
      entry.ok = false;
      setNote(`FAIL HTTP ${result.status}`);
      networkLog.push(entry);
      return [];
    }
    if (result.status !== 200) {
      // 4xx other than 429: Yahoo's "Bad Request" wrapper for delisted
      // symbols actually returns HTTP 200 with a chart.error body, so a
      // non-200 here is something unusual (404 for a malformed URL, 403
      // for a geo block). Log it; bail.
      entry.ok = false;
      setNote(`FAIL HTTP ${result.status}`);
      networkLog.push(entry);
      return [];
    }
    let payload: any;
    try {
      payload = JSON.parse(result.text);
    } catch {
      // Non-JSON from a 2xx response is a real upstream surprise (block
      // page, HTML interstitial). Don't throw out of the function: a single
      // weird response shouldn't cancel the rest of the batch.
      entry.ok = false;
      setNote('FAIL non-JSON response');
      networkLog.push(entry);
      return [];
    }
    // Yahoo's documented error envelope: `chart.error` carries a code and
    // human-readable description. Captured live for NONEXISTENTXYZ123 and
    // a bad period window (see tests/__fixtures__/yahoo/not-found.json).
    // The HTTP status for these is 200 (not 4xx), so we MUST check the
    // body rather than the status code.
    const chartError = payload?.chart?.error;
    if (chartError && typeof chartError === 'object') {
      entry.ok = false;
      const code = chartError.code || 'Error';
      setNote(`FAIL ${code}`);
      networkLog.push(entry);
      return [];
    }
    const r = payload?.chart?.result?.[0];
    if (!r) {
      // Empty `result` array (or array of nulls) with no error: treat as a
      // genuine empty response. Some Yahoo paths emit this for stale
      // exchanges and weekend windows. Logged as success with 0 bars so
      // the diagnostic panel says "EMPTY" rather than "FAIL".
      entry.ok = true;
      setNote('EMPTY');
      networkLog.push(entry);
      return [];
    }
    const timestamps: number[] = Array.isArray(r.timestamp) ? r.timestamp : [];
    const quote = r.indicators?.quote?.[0] || {};
    const closes: Array<number | null> = Array.isArray(quote.close) ? quote.close : [];
    const opens: Array<number | null> = Array.isArray(quote.open) ? quote.open : [];
    const highs: Array<number | null> = Array.isArray(quote.high) ? quote.high : [];
    const lows: Array<number | null> = Array.isArray(quote.low) ? quote.low : [];
    const volumes: Array<number | null> = Array.isArray(quote.volume) ? quote.volume : [];

    const bars: HistoricalBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      // Yahoo emits nulls for holidays and halted symbols. Skip them; the
      // portfolio layer forward-fills non-trading days from the prior close.
      if (close == null || !Number.isFinite(close)) continue;
      const ts = timestamps[i];
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
      const bar: HistoricalBar = {
        symbol,
        date: toUtcDateString(new Date(ts * 1000)),
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
    setNote(bars.length === 0 ? 'EMPTY' : `OK ${bars.length} bars`);
    networkLog.push(entry);
    return bars;
  } finally {
    yahooInternals.requestSemaphore.release();
  }
}

/**
 * Map a transport-layer exception to a short, human-readable reason string
 * for the network log. We don't try to render the whole stack: the message
 * already wraps "AbortError", "TypeError: Failed to fetch", or "net::ERR_*"
 * with enough specificity that one of those tokens is what the user wants
 * to see.
 */
function describeTransportError(err: unknown): string {
  if (!err) return 'network';
  const name = (err as any)?.name;
  if (name === 'AbortError') return 'timeout';
  const msg = (err as any)?.message;
  if (typeof msg === 'string' && msg.length > 0) {
    // Cap the length so the diagnostic table doesn't blow out the column.
    return msg.slice(0, 80);
  }
  return 'network';
}
