// Single source of truth for "are we running inside the Tauri shell?"
//
// Tauri 2 renamed the global from `window.__TAURI__` (v1) to
// `window.__TAURI_INTERNALS__`, and also exposes `window.isTauri = true`.
// We check both plus a UA fallback so this stays robust across minor versions.

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  if (w.__TAURI_INTERNALS__) return true;
  if (w.__TAURI__) return true;
  if (w.isTauri === true) return true;
  if (typeof navigator !== 'undefined' && /Tauri/i.test(navigator.userAgent || '')) return true;
  return false;
}
