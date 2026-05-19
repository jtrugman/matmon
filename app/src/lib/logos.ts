// Ticker logo fetcher + prefetch coordinator.
//
// Provider: logo.dev. The public demo token below (pk_X-1ZO13ESPS6N0iWNAjqfQ)
// is documented as fine for low-volume / open-source use; it caps at 50 req/sec
// and 10k req/month, which is well above what an individual user's portfolio
// import will ever consume. If we ever bump into that ceiling we can swap in a
// per-user token via a Settings field without touching call sites.
//
// Network etiquette:
//  - We respect the existing Tauri-vs-browser fetch dichotomy from
//    src/lib/quotes/yahoo.ts so logo requests bypass CORS inside Tauri and
//    fall back to a plain browser fetch in dev / web mode.
//  - prefetchLogos() staggers a batch at ~200ms intervals so a CSV with 50
//    tickers takes ~10s but never gets throttled. Already-cached or
//    already-marked-missing tickers are skipped instantly.
//  - All errors are swallowed; this feature is a visual nicety and must never
//    block or break a portfolio import.
//
// Cache TTL: a 'missing' row is honored for 30 days before we retry. This
// matches the user's intuition that a stale-or-broken logo shouldn't get
// re-fetched every render.

import { getLogo, markLogoMissing, saveLogo } from './db/repos';
import { networkLog } from './quotes/log';
import type { NetworkLogEntry } from './quotes/types';

const LOGO_HOST = 'img.logo.dev';
const LOGO_TOKEN = 'pk_X-1ZO13ESPS6N0iWNAjqfQ';
const REQUEST_TIMEOUT_MS = 8_000;
const STAGGER_MS = 200;
const MISSING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Build the logo.dev URL for a ticker. Size 128 keeps the payload <10 KB. */
function logoUrl(ticker: string): string {
  return `https://${LOGO_HOST}/ticker/${encodeURIComponent(ticker)}?token=${LOGO_TOKEN}&format=png&size=128`;
}

/**
 * Issue a single GET, going through the Tauri HTTP plugin when available so
 * we sidestep CORS. Returns the raw bytes on 200, null on 404 / other
 * non-success. Throws only on network rejection / timeout so the caller can
 * decide whether to mark the ticker as 'error' vs. 'missing'.
 */
async function httpGetBytes(
  url: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array | null; status: number }> {
  const w = typeof window !== 'undefined' ? (window as any) : {};
  const tauriHttp = (w.__TAURI_INTERNALS__ || w.__TAURI__)?.http?.fetch as
    | undefined
    | ((u: string, init?: { signal?: AbortSignal }) => Promise<Response>);
  const res: Response = tauriHttp
    ? await tauriHttp(url, { signal })
    : await fetch(url, { mode: 'cors', signal });
  if (res.status === 200) {
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), status: 200 };
  }
  return { bytes: null, status: res.status };
}

/**
 * Wrap httpGetBytes with the privacy network log so logo fetches show up in
 * Settings > Privacy alongside Yahoo quote calls. The Settings panel's promise
 * is "everything we sent is in this log"; logos used to bypass it.
 */
async function loggedHttpGetBytes(
  ticker: string,
  url: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array | null; status: number }> {
  const t0 = performance.now();
  const entry: NetworkLogEntry = {
    t: new Date(),
    host: LOGO_HOST,
    symbols: [ticker],
    bytes: 0,
    durationMs: 0,
    ok: false,
  };
  try {
    const result = await httpGetBytes(url, signal);
    entry.status = result.status;
    entry.bytes = result.bytes ? result.bytes.length : 0;
    entry.ok = result.status === 200 && !!result.bytes && result.bytes.length > 0;
    entry.durationMs = Math.round(performance.now() - t0);
    networkLog.push(entry);
    return result;
  } catch (err) {
    entry.ok = false;
    entry.durationMs = Math.round(performance.now() - t0);
    networkLog.push(entry);
    throw err;
  }
}

/**
 * Public fetch entry point. Returns the PNG bytes for a ticker, or null when
 * the provider has no logo for it (404). Throws on hard network failure so
 * the caller can distinguish "not available" from "couldn't even ask".
 */
export async function fetchTickerLogo(ticker: string): Promise<Uint8Array | null> {
  const key = ticker.trim().toUpperCase();
  if (!key) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { bytes, status } = await loggedHttpGetBytes(key, logoUrl(key), controller.signal);
    if (status === 200 && bytes && bytes.length > 0) return bytes;
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Prefetch coordinator ─────────────────────────────────────
// Multiple imports happening back-to-back must not all queue duplicate
// requests for the same ticker. We dedupe via an in-flight Set so the second
// caller for "AAPL" within the same session quietly waits for the first.

const inFlight = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Best-effort background fetch for a list of tickers. Skips any that are
 * already cached (ok or recently-marked missing) and staggers the rest at
 * STAGGER_MS apart. Returns once every ticker has been resolved or marked.
 *
 * Designed to be invoked with `void prefetchLogos(...)` so callers don't
 * block on the network. Resolves on completion so tests can await it.
 */
export async function prefetchLogos(tickers: Array<string | null | undefined>): Promise<void> {
  const unique = Array.from(
    new Set(tickers.map(t => (t || '').trim().toUpperCase()).filter(t => t.length > 0)),
  );
  if (unique.length === 0) return;

  const now = Date.now();
  const toFetch: string[] = [];
  for (const t of unique) {
    if (inFlight.has(t)) continue;
    try {
      const existing = await getLogo(t);
      if (existing) {
        if (existing.status === 'ok' && existing.bytes && existing.bytes.length > 0) continue;
        // A 'missing' / 'error' record is honored for 30 days before we retry.
        if (now - existing.fetchedAt.getTime() < MISSING_TTL_MS) continue;
      }
    } catch {
      // If the cache lookup itself throws, fall through to a fresh fetch.
    }
    toFetch.push(t);
  }
  if (toFetch.length === 0) return;

  for (let i = 0; i < toFetch.length; i++) {
    const t = toFetch[i];
    if (inFlight.has(t)) continue;
    inFlight.add(t);
    try {
      const bytes = await fetchTickerLogo(t);
      if (bytes && bytes.length > 0) {
        await saveLogo(t, bytes, 'png').catch(() => {});
      } else {
        await markLogoMissing(t, 'missing').catch(() => {});
      }
    } catch {
      // Network reject / timeout. Record as 'error' so we still honor the
      // 30-day cooldown rather than thrashing the upstream on every reload.
      await markLogoMissing(t, 'error').catch(() => {});
    } finally {
      inFlight.delete(t);
    }
    if (i < toFetch.length - 1) await sleep(STAGGER_MS);
  }
}

/** Test hook: reset the in-flight dedupe set so each test starts clean. */
export function __resetLogoQueueForTests(): void {
  inFlight.clear();
}
