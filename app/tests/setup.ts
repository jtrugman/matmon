import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';
import { __resetDriverForTests } from '../src/lib/db/driver';
import { __resetReposForTests } from '../src/lib/db/repos';
import { __resetLogoQueueForTests } from '../src/lib/logos';
import { setOffline, clearQuoteCache } from '../src/lib/quotes';
import { networkLog } from '../src/lib/quotes/log';

// Default fetch stub factory: TickerLogo (and any other view component) may
// dispatch background fetches during a render-only test. We want a response
// that:
//   1. Doesn't trigger retries (so backfill returns fast).
//   2. Is parseable as both arrayBuffer (logo path) and JSON (history path).
//   3. Yields an EMPTY history array (so the backfill is a no-op).
//
// Returning a 200 with an empty `chart.result[0].timestamp` array satisfies
// all three: 200 is the success branch (no retry), JSON parses, the
// fetcher records 0 bars and moves on. Specs that care about real network
// shape override this with their own vi.fn() / vi.spyOn().
function makeDefaultFetch() {
  const emptyChartBody = JSON.stringify({
    chart: {
      result: [
        {
          meta: {},
          timestamp: [],
          indicators: { quote: [{ close: [], open: [], high: [], low: [], volume: [] }] },
        },
      ],
      error: null,
    },
  });
  return vi.fn().mockResolvedValue({
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    text: () => Promise.resolve(emptyChartBody),
  } as unknown as Response);
}

// Wipe the localStorage-backed dev DB and reset the default fetch stub so
// each spec starts from a known baseline.
//
// Per-spec hygiene: each test starts in ONLINE mode with the empty-chart
// fetch stub above so the historical-price backfill that App.tsx now runs
// during finishOnboarding completes near-instantly (status 200 → no retry,
// empty bars[] → nothing to persist). The networkLog and the in-memory
// quote cache are also cleared so tests don't leak state across the suite.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  __resetDriverForTests();
  __resetReposForTests();
  __resetLogoQueueForTests();
  clearQuoteCache();
  networkLog.clear();
  setOffline(false);
  (globalThis as any).fetch = makeDefaultFetch();
});

// Stub Tauri detection so the SQL driver picks the browser shim.
if (typeof window !== 'undefined') {
  (window as any).__TAURI__ = undefined;
}
