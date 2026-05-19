// Foreground-only auto-refresh timer for the live quote cache.
//
// Justin wants the Home page to optionally re-pull Yahoo quotes on a fixed
// cadence (1 / 5 / 15 / 30 minutes) WHILE the app is in the foreground. When
// the user switches tabs, locks their screen, or otherwise hides the page,
// the timer pauses; when they return, it resumes from the next tick.
//
// Design notes:
//   - The feature is OFF by default. We will never schedule a network
//     request without the user opting in via Settings → Auto-refresh.
//   - A refresh that's already in flight when the next tick fires SKIPS
//     the tick rather than queueing or double-fetching. Justin's spec is
//     explicit: "Don't queue or double-fetch."
//   - We do NOT open a circuit breaker. If Yahoo is unreachable for one
//     tick, the next tick still tries. The user can flip the toggle off
//     manually if they don't want the retries.
//   - The interval is honored on every restart: when the user changes
//     "5m" → "15m" in Settings, we clear the running interval and
//     reschedule with the new period rather than waiting for the next
//     5m tick to elapse first.
//
// The hook is plain TS (not React) so it's trivially testable with
// vitest's fake timers; App.tsx wires it up with a tiny React effect.

export type AutoRefreshIntervalMin = 1 | 5 | 15 | 30;

export const AUTO_REFRESH_INTERVALS: readonly AutoRefreshIntervalMin[] = [1, 5, 15, 30] as const;

export const AUTO_REFRESH_ENABLED_KEY = 'quotes.autoRefresh.enabled';
export const AUTO_REFRESH_INTERVAL_KEY = 'quotes.autoRefresh.intervalMin';

/**
 * Tiny env adapter so tests can swap out window-bound globals. The default
 * implementation reads from `window.document.visibilityState`,
 * `window.setInterval`, etc; tests pass a stub object with their own fakes.
 */
export interface AutoRefreshEnv {
  /** Current visibility state. Production maps to `document.visibilityState`. */
  isVisible(): boolean;
  /** Subscribe to visibility flips. Return value unsubscribes. */
  onVisibilityChange(cb: () => void): () => void;
  /** Schedule a repeating tick at `intervalMs`. Returns an opaque handle. */
  setInterval(cb: () => void, intervalMs: number): unknown;
  /** Cancel a handle returned by setInterval. */
  clearInterval(handle: unknown): void;
}

export function defaultEnv(): AutoRefreshEnv {
  return {
    isVisible() {
      if (typeof document === 'undefined') return true;
      return document.visibilityState === 'visible';
    },
    onVisibilityChange(cb) {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    setInterval(cb, intervalMs) {
      return setInterval(cb, intervalMs);
    },
    clearInterval(handle) {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

export interface AutoRefreshOptions {
  /** Whether the timer is currently armed. When false, no ticks fire. */
  enabled: boolean;
  /** Interval in minutes. Must be one of AUTO_REFRESH_INTERVALS. */
  intervalMin: AutoRefreshIntervalMin;
  /**
   * Refresh function. We call this with no arguments; the auto-refresh path
   * always uses `{ force: true }` upstream so we never silently no-op
   * inside the 5-minute quote cache.
   */
  refresh(): Promise<void> | void;
  /** Test seam. Defaults to {@link defaultEnv}. */
  env?: AutoRefreshEnv;
}

export interface AutoRefreshController {
  /** Disarm and tear down all subscriptions. Safe to call multiple times. */
  stop(): void;
  /** Whether the next tick would currently fire (visible + enabled + not in-flight). */
  isArmed(): boolean;
  /** Read-only for tests: count of ticks the runtime has skipped due to in-flight refreshes. */
  _skippedDueToInFlight(): number;
  /** Read-only for tests: count of ticks the runtime has actually invoked refresh() on. */
  _firedCount(): number;
}

/**
 * Start the auto-refresh runtime. Returns a controller whose `stop()` tears
 * the runtime down.
 *
 * Lifecycle:
 *   - enabled === false: stop() the moment it's called (no timer is ever
 *     scheduled). The controller still exists so the caller can release
 *     the visibility listener cleanly on unmount.
 *   - enabled === true && visible: schedule an interval at intervalMin × 60s.
 *   - enabled === true && hidden: skip starting the interval; subscribe to
 *     visibility flips. When visibility returns, START the interval.
 *   - visibility flips to hidden while running: clearInterval. When it
 *     returns to visible, reschedule.
 *
 * On each tick: if a refresh promise is still pending from the prior tick,
 * skip this one (increment the skipped counter, no fetch). Otherwise call
 * `refresh()` and track its promise so the next tick can detect in-flight.
 */
export function startAutoRefresh(opts: AutoRefreshOptions): AutoRefreshController {
  const env = opts.env ?? defaultEnv();
  let handle: unknown = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let skipped = 0;
  let fired = 0;

  const intervalMs = opts.intervalMin * 60_000;

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      // Last tick is still resolving. Skip without queueing.
      skipped++;
      return;
    }
    fired++;
    let result: Promise<void> | void;
    try {
      result = opts.refresh();
    } catch {
      // Synchronous throw: treat as resolved-with-error. The next tick
      // still tries (no circuit breaker by design).
      result = undefined;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      inFlight = (result as Promise<void>)
        .catch(() => {
          // Swallow: errors are surfaced via the networkLog. The runtime
          // should keep ticking.
        })
        .finally(() => {
          inFlight = null;
        });
    } else {
      // Synchronous refresh: no in-flight tracking required.
      inFlight = null;
    }
  };

  const ensureTimerRunning = () => {
    if (stopped || handle != null || !opts.enabled) return;
    if (!env.isVisible()) return;
    handle = env.setInterval(tick, intervalMs);
  };

  const stopTimer = () => {
    if (handle != null) {
      env.clearInterval(handle);
      handle = null;
    }
  };

  const unsubscribeVis = env.onVisibilityChange(() => {
    if (stopped) return;
    if (env.isVisible()) {
      ensureTimerRunning();
    } else {
      stopTimer();
    }
  });

  // Initial schedule. If disabled or hidden, the visibilitychange subscription
  // above will pick up the slack when conditions change.
  ensureTimerRunning();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stopTimer();
      unsubscribeVis();
    },
    isArmed() {
      return !stopped && opts.enabled && env.isVisible() && !inFlight;
    },
    _skippedDueToInFlight() {
      return skipped;
    },
    _firedCount() {
      return fired;
    },
  };
}
