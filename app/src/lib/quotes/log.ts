// In-memory ring buffer of outbound network calls. Surfaced in Settings → Privacy.

import type { NetworkLogEntry } from './types';

const LIMIT = 200;
const entries: NetworkLogEntry[] = [];
const listeners = new Set<() => void>();

/**
 * Yahoo quote endpoint we look for when computing the "Prices as of"
 * timestamp on Home. Kept in sync with QUOTE_HOST in src/lib/quotes/yahoo.ts.
 */
const QUOTE_HOST = 'query1.finance.yahoo.com';

export const networkLog = {
  push(entry: NetworkLogEntry) {
    entries.unshift(entry);
    if (entries.length > LIMIT) entries.length = LIMIT;
    listeners.forEach(l => l());
  },
  list(): NetworkLogEntry[] {
    return entries.slice();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear() {
    entries.length = 0;
    listeners.forEach(l => l());
  },
};

export function getNetworkLog() {
  return networkLog;
}

/**
 * Most recent successful Yahoo quote fetch timestamp, or null when no such
 * entry exists in the ring buffer. Used by HomeView's "Prices as of …"
 * label. Walks the buffer once per call; the buffer caps at 200 entries
 * so this is O(200) on the worst case, which is fine for a label that
 * re-renders only when the log changes.
 */
export function latestSuccessfulQuoteFetch(): Date | null {
  for (const e of entries) {
    if (!e.ok) continue;
    if (e.host !== QUOTE_HOST) continue;
    return e.t;
  }
  return null;
}
