// Auto-refresh timer tests. The runtime is plain TS (no React) so we can
// drive it with vitest's fake timers and a stub visibility adapter; no
// happy-dom event plumbing needed.
//
// Coverage map (mirrors Justin's spec):
//   - Timer fires on interval when enabled
//   - Timer pauses when document.visibilityState becomes hidden
//   - Timer resumes when visibility returns to visible
//   - Interval change clears + reschedules the timer
//   - If a refresh is in-flight, the next tick skips (don't double-fetch)
//
// We deliberately do NOT use `vi.useFakeTimers()` in the visibility-pause
// case because re-installing fake intervals after a visibility flip would
// also reset the interval clock; the runtime under test must independently
// notice the flip and clearInterval. The fake env's setInterval returns
// monotonic numbers we step manually instead.

import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_REFRESH_INTERVALS,
  startAutoRefresh,
  type AutoRefreshEnv,
} from '../src/lib/autoRefresh';

/**
 * Build a stub env whose setInterval / clearInterval are deterministic
 * tape recorders. The test drives "time" by calling .fireTick(handle).
 * Visibility is mutable; visibilitychange callbacks fire on flip.
 */
function makeStubEnv() {
  let visible = true;
  const visListeners = new Set<() => void>();
  const intervals = new Map<number, { cb: () => void; intervalMs: number }>();
  let nextId = 1;
  const env: AutoRefreshEnv = {
    isVisible: () => visible,
    onVisibilityChange(cb) {
      visListeners.add(cb);
      return () => visListeners.delete(cb);
    },
    setInterval(cb, intervalMs) {
      const id = nextId++;
      intervals.set(id, { cb, intervalMs });
      return id;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  return {
    env,
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      for (const l of visListeners) l();
    },
    /** Number of currently-armed intervals (should be 0 or 1 in our runtime). */
    activeIntervals: () => intervals.size,
    /** Inspect the scheduled interval period (the runtime should reflect intervalMin × 60000). */
    intervalPeriod: () => {
      const first = intervals.values().next().value;
      return first ? first.intervalMs : null;
    },
    /** Manually fire one tick of the (single) scheduled interval. */
    fireTick: () => {
      const first = intervals.values().next().value;
      if (!first) throw new Error('no interval scheduled');
      first.cb();
    },
  };
}

describe('startAutoRefresh', () => {
  it('exports the canonical interval list (1 / 5 / 15 / 30)', () => {
    expect(AUTO_REFRESH_INTERVALS).toEqual([1, 5, 15, 30]);
  });

  it('does NOT schedule any timer when disabled', () => {
    const stub = makeStubEnv();
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: false,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(0);
    expect(ctrl.isArmed()).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it('schedules an interval matching intervalMin × 60s when enabled and visible', () => {
    const stub = makeStubEnv();
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(1);
    expect(stub.intervalPeriod()).toBe(5 * 60_000);
    ctrl.stop();
  });

  it('fires refresh() on each tick when enabled', async () => {
    const stub = makeStubEnv();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(refresh).toHaveBeenCalledTimes(0);
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Let the in-flight promise resolve before the next tick so we observe
    // a real call rather than a skipped one.
    await Promise.resolve();
    await Promise.resolve();
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(2);
    ctrl.stop();
  });

  it('skips the tick when a previous refresh is still in-flight (no double-fetch)', async () => {
    const stub = makeStubEnv();
    let resolveFirst: () => void = () => {};
    const firstPending = new Promise<void>(resolve => {
      resolveFirst = resolve;
    });
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstPending)
      .mockResolvedValue(undefined);

    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    // Tick 1 starts the long-running refresh.
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Tick 2 fires while #1 is in-flight: must skip.
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ctrl._skippedDueToInFlight()).toBe(1);
    // Once the first resolves, the next tick fires for real.
    resolveFirst();
    await firstPending;
    await Promise.resolve();
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(2);
    ctrl.stop();
  });

  it('pauses (clears the interval) when visibility flips to hidden', () => {
    const stub = makeStubEnv();
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(1);
    stub.setVisible(false);
    expect(stub.activeIntervals()).toBe(0);
    expect(ctrl.isArmed()).toBe(false);
    ctrl.stop();
  });

  it('resumes (reschedules the interval) when visibility returns to visible', () => {
    const stub = makeStubEnv();
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    stub.setVisible(false);
    expect(stub.activeIntervals()).toBe(0);
    stub.setVisible(true);
    expect(stub.activeIntervals()).toBe(1);
    expect(stub.intervalPeriod()).toBe(5 * 60_000);
    expect(ctrl.isArmed()).toBe(true);
    ctrl.stop();
  });

  it('does not start a timer if hidden at construction time, but starts it on first visibility', () => {
    const stub = makeStubEnv();
    stub.setVisible(false);
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(0);
    stub.setVisible(true);
    expect(stub.activeIntervals()).toBe(1);
    ctrl.stop();
  });

  it('stop() clears the interval and unsubscribes from visibility flips', () => {
    const stub = makeStubEnv();
    const refresh = vi.fn();
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(1);
    ctrl.stop();
    expect(stub.activeIntervals()).toBe(0);
    // After stop(), visibility flips must NOT resurrect the interval.
    stub.setVisible(false);
    stub.setVisible(true);
    expect(stub.activeIntervals()).toBe(0);
  });

  it('lets a caller cleanly rebuild on interval change (stop old, start new)', () => {
    // Justin's spec: "if the user changes from 5m to 15m, the existing timer
    // is cleared and a new one is scheduled". The runtime exposes stop(),
    // so the caller (App.tsx) tears down the controller and re-runs
    // startAutoRefresh with the new interval. This test verifies that the
    // typical caller pattern works without leaking timers.
    const stub = makeStubEnv();
    const refresh = vi.fn();
    let ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    expect(stub.intervalPeriod()).toBe(5 * 60_000);
    ctrl.stop();
    expect(stub.activeIntervals()).toBe(0);
    ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 15,
      refresh,
      env: stub.env,
    });
    expect(stub.activeIntervals()).toBe(1);
    expect(stub.intervalPeriod()).toBe(15 * 60_000);
    ctrl.stop();
  });

  it('keeps ticking after a refresh failure (no circuit breaker)', async () => {
    // Justin's spec: "If a fetch fails (Yahoo unreachable), the next tick
    // still tries. Don't open a circuit breaker for the auto-refresh path."
    const stub = makeStubEnv();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined);
    const ctrl = startAutoRefresh({
      enabled: true,
      intervalMin: 5,
      refresh,
      env: stub.env,
    });
    stub.fireTick();
    // Let the rejected promise settle through the .catch() in the runtime.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    stub.fireTick();
    expect(refresh).toHaveBeenCalledTimes(2);
    ctrl.stop();
  });
});
