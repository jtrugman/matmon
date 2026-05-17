// In-memory ring buffer of outbound network calls. Surfaced in Settings → Privacy.

import type { NetworkLogEntry } from './types';

const LIMIT = 200;
const entries: NetworkLogEntry[] = [];
const listeners = new Set<() => void>();

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
