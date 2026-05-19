// Per-symbol sector / industry / long-name fetcher. The chart endpoint we use
// for prices (quotes/yahoo.ts) does NOT return sector data, so we fan out one
// extra request per symbol to Yahoo's /v10/finance/quoteSummary endpoint,
// which exposes summaryProfile { sector, industry, longBusinessSummary, ... }
// without requiring a Yahoo crumb token.
//
// Endpoint:
//   GET /v10/finance/quoteSummary/<symbol>?modules=summaryProfile
//
// Response shape (the bits we care about):
//   {
//     quoteSummary: {
//       result: [ { summaryProfile: { sector, industry, longBusinessSummary } } ],
//       error: null
//     }
//   }
//
// Resilience policy:
//   - Reuses the same request semaphore + retry wrapper as the live-quote and
//     historical-backfill paths, so we never have three separate pools of
//     in-flight Yahoo requests fighting over the same rate-limit.
//   - 90-day cooldown on successful fetches (sector data is effectively
//     static; refreshing more often is wasteful).
//   - 30-day cooldown on `not_found` results so a delisted/obscure ticker
//     doesn't get re-fetched on every cold boot.
//   - 7-day cooldown on `error` (transient) results.
//   - In browser dev mode the Yahoo request hits CORS; the fetcher swallows
//     the failure and the symbol ends up with sector === null. Playwright
//     specs mock the response via page.route, same pattern the historical
//     backfill spec uses.
//
// CORS: tauri-plugin-http bypasses CORS in the packaged app, so this works
// end-to-end there. In `npm run dev` the browser-shim DB still records the
// `last_result: 'error'` row, which is the right call (we tried, it failed).

import { _sectorInternals as yahooInternals } from './yahoo';
import { networkLog } from './log';
import { getInstrument, getInstrumentsForSymbols, upsertInstrument } from '../db/repos';
import { isOffline } from './index';
import type { NetworkLogEntry } from './types';

const QUOTE_SUMMARY_HOST = 'query1.finance.yahoo.com';

/** Sector data is effectively static; 90 days is a comfortable refresh. */
const SUCCESS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Don't retry "not_found" rows forever; 30 days lets a ticker re-listing recover. */
const NOT_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Transient errors (network, 5xx) get a shorter cooldown so we recover sooner. */
const ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstrumentProfile {
  sector: string;
  industry: string;
  longName?: string;
}

/** Cash-sweep / money-market tickers have no sector. Filter at the source. */
const CASH_SWEEP_SYMBOLS = new Set<string>([
  'SPAXX',
  'FCASH',
  'FZFXX',
  'FDRXX',
  'VMRXX',
  'VMSXX',
  'VMFXX',
  'QACDS',
  'CASH',
]);

/**
 * Fetch a single symbol's sector / industry from Yahoo's quoteSummary
 * endpoint. Returns null when:
 *   - The symbol is a cash sweep (no sector).
 *   - The endpoint returns 404 / no result (delisted, obscure ticker).
 *   - The network is down or CORS-blocked (browser dev mode).
 *
 * Never throws: every error path is mapped to null so the caller can decide
 * whether to render "--" in the Sector column or hide the field.
 *
 * NOTE: this function does NOT consult the cache; it always hits the network.
 * The caller (backfillInstruments) is responsible for cache-aware dispatch.
 * Exported for direct use only in the per-holding "Open detail view" path
 * when we want a fresh sector lookup ahead of the bulk backfill.
 */
export async function fetchInstrumentSector(
  symbol: string,
): Promise<InstrumentProfile | null> {
  if (!symbol) return null;
  const upper = symbol.trim().toUpperCase();
  if (!upper) return null;
  if (CASH_SWEEP_SYMBOLS.has(upper)) return null;

  const url =
    `https://${QUOTE_SUMMARY_HOST}/v10/finance/quoteSummary/${encodeURIComponent(upper)}` +
    `?modules=summaryProfile`;

  await yahooInternals.requestSemaphore.acquire();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const entry: NetworkLogEntry = {
    t: new Date(),
    host: QUOTE_SUMMARY_HOST,
    symbols: [upper],
    bytes: 0,
    durationMs: 0,
    ok: false,
  };
  try {
    let result: { text: string; status: number };
    try {
      result = await yahooInternals.getWithTimeoutAndRetry(url);
    } catch {
      const dur = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
      entry.durationMs = Math.round(dur);
      entry.ok = false;
      networkLog.push(entry);
      return null;
    }
    entry.status = result.status;
    entry.bytes = result.text.length;
    const dur = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    entry.durationMs = Math.round(dur);
    if (result.status === 429 || (result.status >= 500 && result.status <= 599)) {
      entry.ok = false;
      networkLog.push(entry);
      return null;
    }
    let payload: any;
    try {
      payload = JSON.parse(result.text);
    } catch {
      entry.ok = false;
      networkLog.push(entry);
      return null;
    }
    const r = payload?.quoteSummary?.result?.[0];
    if (!r) {
      entry.ok = true;
      networkLog.push(entry);
      return null;
    }
    const profile = r.summaryProfile;
    if (!profile || typeof profile !== 'object') {
      entry.ok = true;
      networkLog.push(entry);
      return null;
    }
    const sector = typeof profile.sector === 'string' ? profile.sector.trim() : '';
    const industry = typeof profile.industry === 'string' ? profile.industry.trim() : '';
    const longName =
      typeof profile.longBusinessSummary === 'string'
        ? undefined // longBusinessSummary is a description, not a name
        : undefined;
    entry.ok = true;
    networkLog.push(entry);
    if (!sector && !industry) {
      // Empty profile is functionally equivalent to "not_found" for our needs.
      return null;
    }
    const out: InstrumentProfile = { sector, industry };
    if (longName) out.longName = longName;
    return out;
  } finally {
    yahooInternals.requestSemaphore.release();
  }
}

export interface BackfillInstrumentsResult {
  /** Symbols whose sector landed (either freshly fetched or skipped because cached). */
  ok: string[];
  /** Symbols Yahoo returned no profile for; will be retried after NOT_FOUND_TTL_MS. */
  notFound: string[];
  /** Symbols where the network call itself failed (CORS, timeout, 5xx). */
  failed: string[];
}

/**
 * Fan out per-symbol quoteSummary fetches for every unique symbol the user
 * holds. Decision logic per symbol:
 *
 *   1. Cash sweep → skip silently (no sector to fetch).
 *   2. instruments row exists AND fetched within 90 days (ok) / 30 days
 *      (not_found) / 7 days (error) → skip (cooldown).
 *   3. Otherwise → fetch, then upsert with last_result.
 *
 * This function is safe to call repeatedly: idempotent thanks to the
 * cooldown. We dispatch sequentially through the same request semaphore as
 * the historical backfill so we never have three parallel pools of in-flight
 * Yahoo requests.
 *
 * Returns counts so the UI can surface a "Sector data for 14 of 17 symbols
 * landed" status. Never throws.
 */
export async function backfillInstruments(
  symbols: string[],
): Promise<BackfillInstrumentsResult> {
  const result: BackfillInstrumentsResult = { ok: [], notFound: [], failed: [] };
  if (symbols.length === 0) return result;
  if (isOffline()) {
    // Don't burn requests we know will fail. Mark every wanted symbol as
    // "failed" so the caller can surface a "you're offline" hint.
    for (const s of symbols) result.failed.push(s.trim().toUpperCase());
    return result;
  }

  // Dedupe + drop cash sweeps + uppercase. Same normalization as the price
  // backfill so we don't double-count.
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (!s) continue;
    const upper = s.trim().toUpperCase();
    if (!upper) continue;
    if (CASH_SWEEP_SYMBOLS.has(upper)) continue;
    if (seen.has(upper)) continue;
    seen.add(upper);
    cleaned.push(upper);
  }

  // One bulk DB read for the cache decision; the per-symbol path then only
  // hits the network when needed.
  const existing = await getInstrumentsForSymbols(cleaned).catch(
    () => new Map<string, Awaited<ReturnType<typeof getInstrument>>>(),
  );
  const now = Date.now();

  for (const sym of cleaned) {
    const row = existing.get(sym);
    if (row) {
      const elapsed = now - row.last_attempt_ts;
      if (row.last_result === 'ok' && elapsed < SUCCESS_TTL_MS) {
        result.ok.push(sym);
        continue;
      }
      if (row.last_result === 'not_found' && elapsed < NOT_FOUND_TTL_MS) {
        result.notFound.push(sym);
        continue;
      }
      if (row.last_result === 'error' && elapsed < ERROR_TTL_MS) {
        result.failed.push(sym);
        continue;
      }
    }
    // Fall through: fetch the profile.
    let profile: InstrumentProfile | null = null;
    let lastResult: 'ok' | 'not_found' | 'error';
    try {
      profile = await fetchInstrumentSector(sym);
      lastResult = profile ? 'ok' : 'not_found';
    } catch {
      lastResult = 'error';
    }
    try {
      await upsertInstrument({
        symbol: sym,
        sector: profile?.sector ?? null,
        industry: profile?.industry ?? null,
        long_name: profile?.longName ?? null,
        fetched_at_ts: lastResult === 'ok' ? now : (row?.fetched_at_ts ?? 0),
        last_attempt_ts: now,
        last_result: lastResult,
      });
    } catch {
      // DB write failure: still track in the result, but treat as failed.
      result.failed.push(sym);
      continue;
    }
    if (lastResult === 'ok') result.ok.push(sym);
    else if (lastResult === 'not_found') result.notFound.push(sym);
    else result.failed.push(sym);
  }
  return result;
}

/** Test-only TTL accessors so the unit tests can pin the cooldown windows
 *  without exporting the consts at module level. */
export const _ttls = {
  SUCCESS_TTL_MS,
  NOT_FOUND_TTL_MS,
  ERROR_TTL_MS,
};
