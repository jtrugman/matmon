// Always-on diagnostic logger for the DB layer.
//
// We deliberately do NOT gate this on NODE_ENV. The whole point of these logs is
// to catch persistence failures in dev runs of the real Tauri shell (where
// Justin first saw "all my data resets every relaunch"). A user who finds them
// noisy can flip `window.__matmonDiagSilent = true` from the devtools console
// and they'll go quiet, or set `localStorage.matmonDiagSilent = '1'` to make it
// stick across reloads.
//
// We DON'T use `console.log` because eslint forbids it (allow: warn/error/info).
// `console.info` is fine and shows up in the same dev console stream.

const TAG = '[matmon-diag]';

function silent(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  if (w.__matmonDiagSilent === true) return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('matmonDiagSilent') === '1') {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Emit a structured diagnostic line. `scope` is the subsystem (driver, repos,
 * tauri-sql, browser-shim, seed, onboarding). `msg` is a short verb-phrase. `ctx`
 * is an optional structured payload.
 */
export function diag(scope: string, msg: string, ctx?: unknown): void {
  if (silent()) return;
  if (ctx === undefined) {
    console.info(`${TAG} ${scope}:`, msg);
  } else {
    console.info(`${TAG} ${scope}:`, msg, ctx);
  }
}
