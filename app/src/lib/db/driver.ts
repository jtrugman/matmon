// Tiny SQL driver abstraction. Same surface for:
//   - tauri-plugin-sql (when running inside Tauri shell)
//   - sql.js / IndexedDB-backed in-browser fallback (dev mode)
//
// We expose just `exec`, `select`, and `transaction` because every higher-level repo
// only needs those three.

import { diag } from './diag';

export interface SqlDriver {
  exec(sql: string, params?: any[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(work: (tx: SqlDriver) => Promise<T>): Promise<T>;
  /** Best-effort hint where the DB lives. */
  describe(): string;
}

/**
 * Look like we're running inside *some kind* of Tauri webview. We use this to
 * decide whether to wait for `__TAURI_INTERNALS__` to be injected. In plain
 * Chromium / happy-dom there's nothing to wait for, so we bail immediately and
 * avoid burning 800ms on every browser-shim cold start (which would have made
 * Playwright + vitest startup glacial).
 *
 * Tauri's webview ships a UA string containing "Tauri" on every platform.
 */
function looksLikeTauriWebview(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Tauri/i.test(navigator.userAgent || '');
}

/**
 * Wait briefly for the Tauri internals global to be injected. The webview
 * sometimes runs our module evaluation a tick or two before `__TAURI_INTERNALS__`
 * is wired up, which is exactly the race that made `isTauri()` return false on
 * cold boot and dropped users onto the browser-shim driver (whose localStorage
 * doesn't always survive a real Tauri relaunch on macOS webkit).
 *
 * 1200ms is generous; in practice the global is present within one task.
 */
async function waitForTauriGlobals(timeoutMs = 1200): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const w = window as any;
    if (w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri === true) return true;
    if (looksLikeTauriWebview()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

// ── Tauri driver ─────────────────────────────────────────────
async function loadTauriDriver(): Promise<SqlDriver | null> {
  // Bail fast on plain browser; we only want to poll inside a webview.
  if (typeof window === 'undefined') {
    diag('driver', 'loadTauriDriver: no window, returning null');
    return null;
  }
  const w = window as any;
  const alreadyHere = !!(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri === true);
  // If the globals are already injected we don't poll; if they're not and the
  // UA doesn't say "Tauri" we don't poll either (we're in plain Chromium and
  // would just burn 1.2s for nothing). Otherwise we poll up to 1.2s.
  if (!alreadyHere && !looksLikeTauriWebview()) {
    diag('driver', 'loadTauriDriver: not in a Tauri webview, returning null fast');
    return null;
  }
  const ready = alreadyHere ? true : await waitForTauriGlobals();
  if (!ready) {
    diag('driver', 'loadTauriDriver: Tauri globals never appeared, falling back to browser shim');
    return null;
  }
  diag('driver', 'loadTauriDriver: Tauri globals detected, attempting plugin-sql load');
  try {
    // Dynamic import so the bundler doesn't fail in browser dev mode.
    const mod = await import('@tauri-apps/plugin-sql');
    const Database = mod.default;
    diag('driver', 'loadTauriDriver: plugin-sql module loaded, calling Database.load');
    const db = await Database.load('sqlite:portfolio.db');
    diag('driver', 'loadTauriDriver: Database.load succeeded for sqlite:portfolio.db');

    const driver: SqlDriver = {
      async exec(sql, params = []) {
        diag('tauri-sql', 'exec', { sql: sql.slice(0, 160), params });
        try {
          await db.execute(sql, params);
        } catch (e) {
          diag('tauri-sql', 'exec FAILED', { sql: sql.slice(0, 160), error: String(e) });
          throw e;
        }
      },
      async select<T>(sql: string, params: any[] = []) {
        diag('tauri-sql', 'select', { sql: sql.slice(0, 160), params });
        try {
          const rows = (await db.select<T[]>(sql, params)) || [];
          diag('tauri-sql', 'select result', { sql: sql.slice(0, 80), count: rows.length });
          return rows;
        } catch (e) {
          diag('tauri-sql', 'select FAILED', { sql: sql.slice(0, 160), error: String(e) });
          throw e;
        }
      },
      async transaction(work) {
        diag('tauri-sql', 'transaction BEGIN');
        await db.execute('BEGIN');
        try {
          const result = await work(driver);
          await db.execute('COMMIT');
          diag('tauri-sql', 'transaction COMMIT');
          return result;
        } catch (e) {
          diag('tauri-sql', 'transaction ROLLBACK', { error: String(e) });
          await db.execute('ROLLBACK');
          throw e;
        }
      },
      describe() {
        return 'sqlite (tauri-plugin-sql) · portfolio.db';
      },
    };
    return driver;
  } catch (e) {
    // PRE-EXISTING BUG: this catch used to swallow the error silently with `catch
    // {}`, so a Tauri-side failure (missing plugin permission, migration crash,
    // unwritable Application Support path) silently dropped the user onto the
    // browser shim. The shim's localStorage doesn't always survive a Tauri
    // relaunch on macOS webkit, which is exactly the "all my data resets on
    // restart" symptom Justin reported. Log loudly so we never lose this again.
    diag('driver', 'loadTauriDriver: plugin import or Database.load THREW', { error: String(e) });
    console.error('[matmon-diag] Tauri SQL driver failed to load', e);
    return null;
  }
}

// ── Browser driver: localStorage-backed JSON tables ──────────
// Not a real SQL engine, but every repository in this app only uses parameterised
// SELECT / INSERT statements; we parse them with a tiny ad-hoc shim. This keeps the
// dev experience identical without bundling sql.js (1+ MB wasm).
type FakeTable = Record<string, any>[];
const STORE_KEY = 'matmon.dev.db.v1';

function loadStore(): Record<string, FakeTable> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}
function saveStore(store: Record<string, FakeTable>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota issues in dev */
  }
}

function makeBrowserDriver(): SqlDriver {
  // PRE-EXISTING BUG: we used to cache `store` once at driver-construction time
  // and mutate it in place. If localStorage changed underneath us (another tab,
  // a test cleanup, the user clearing storage), the cached object kept serving
  // stale data and writes overwrote the on-disk blob with the stale snapshot.
  // Now every read/write goes through readStore()/writeStore() which round-trip
  // through localStorage on every call. Slower, but correct.
  const readStore = (): Record<string, FakeTable> => loadStore();
  const writeStore = (s: Record<string, FakeTable>) => saveStore(s);

  const tableFromSql = (sql: string): string => {
    const m = sql.match(
      /(?:from|into|update|create\s+(?:unique\s+)?index\s+\S+\s+on|create\s+table(?:\s+if\s+not\s+exists)?)\s+([a-z_]+)/i,
    );
    return m ? m[1].toLowerCase() : '';
  };

  const driver: SqlDriver = {
    async exec(sql) {
      const trimmed = sql.trim();
      diag('browser-shim', 'exec', { sql: trimmed.slice(0, 140) });
      const store = readStore();
      if (/^create table/i.test(trimmed)) {
        const t = tableFromSql(trimmed);
        if (t && !store[t]) store[t] = [];
        writeStore(store);
        return;
      }
      if (/^create index/i.test(trimmed)) return;
      if (/^delete from/i.test(trimmed)) {
        const t = tableFromSql(trimmed);
        if (t) store[t] = [];
        writeStore(store);
        return;
      }
      // Fall through: silently swallow, repos use insert() helper below.
    },
    async select<T>(_sql: string, _params: any[] = []): Promise<T[]> {
      // Tables are read via repos that use driver.tableRead helper, see below.
      return [] as T[];
    },
    async transaction(work) {
      const snapshot = JSON.parse(JSON.stringify(readStore()));
      try {
        return await work(driver);
      } catch (e) {
        writeStore(snapshot);
        throw e;
      }
    },
    describe() {
      return 'browser (localStorage) · matmon.dev.db.v1';
    },
  };

  // Augmented helpers for repos to use directly. Cast at call site.
  (driver as any).tableRead = (name: string) => {
    const rows = readStore()[name] || [];
    diag('browser-shim', 'tableRead', { name, count: rows.length });
    return rows;
  };
  (driver as any).tableWrite = (name: string, rows: FakeTable) => {
    diag('browser-shim', 'tableWrite', { name, count: rows.length });
    const store = readStore();
    store[name] = rows;
    writeStore(store);
  };
  (driver as any).tableInsert = (name: string, row: any) => {
    diag('browser-shim', 'tableInsert', { name });
    const store = readStore();
    if (!store[name]) store[name] = [];
    store[name].push(row);
    writeStore(store);
  };
  (driver as any).tableClear = (name: string) => {
    diag('browser-shim', 'tableClear', { name });
    const store = readStore();
    store[name] = [];
    writeStore(store);
  };

  return driver;
}

// ── Public entry point ──────────────────────────────────────
let cached: Promise<SqlDriver> | null = null;
export function getDriver(): Promise<SqlDriver> {
  if (cached) return cached;
  cached = (async () => {
    const w = typeof window !== 'undefined' ? (window as any) : {};
    diag('driver', 'getDriver: cold path. window snapshot:', {
      hasWindow: typeof window !== 'undefined',
      hasTauriInternals: !!w.__TAURI_INTERNALS__,
      hasTauriV1: !!w.__TAURI__,
      isTauriFlag: w.isTauri === true,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a',
    });
    const tauriDriver = await loadTauriDriver();
    const chosen = tauriDriver ?? makeBrowserDriver();
    diag('driver', `getDriver: selected ${chosen.describe()}`);
    return chosen;
  })();
  return cached;
}

export { isTauri } from '../env';
import { isTauri as isTauriEnv } from '../env';
// Re-export so existing call sites that did `import { isTauri } from './driver'`
// still resolve. (The diag wrapper does not need this; it's a no-op.)
void isTauriEnv;

/** Reset cached driver. Used by the test setup to guarantee isolation. */
export function __resetDriverForTests(): void {
  cached = null;
}
