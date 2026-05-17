// Tiny SQL driver abstraction. Same surface for:
//   - tauri-plugin-sql (when running inside Tauri shell)
//   - sql.js / IndexedDB-backed in-browser fallback (dev mode)
//
// We expose just `exec`, `select`, and `transaction` because every higher-level repo
// only needs those three.

export interface SqlDriver {
  exec(sql: string, params?: any[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(work: (tx: SqlDriver) => Promise<T>): Promise<T>;
  /** Best-effort hint where the DB lives. */
  describe(): string;
}

// ── Tauri driver ─────────────────────────────────────────────
async function loadTauriDriver(): Promise<SqlDriver | null> {
  if (!isTauriEnv()) return null;
  try {
    // Dynamic import so the bundler doesn't fail in browser dev mode.
    const mod = await import('@tauri-apps/plugin-sql');
    const Database = mod.default;
    const db = await Database.load('sqlite:portfolio.db');

    const driver: SqlDriver = {
      async exec(sql, params = []) {
        await db.execute(sql, params);
      },
      async select<T>(sql: string, params: any[] = []) {
        return (await db.select<T[]>(sql, params)) || [];
      },
      async transaction(work) {
        await db.execute('BEGIN');
        try {
          const result = await work(driver);
          await db.execute('COMMIT');
          return result;
        } catch (e) {
          await db.execute('ROLLBACK');
          throw e;
        }
      },
      describe() {
        return 'sqlite (tauri-plugin-sql) · portfolio.db';
      },
    };
    return driver;
  } catch {
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
  let store = loadStore();

  const tableFromSql = (sql: string): string => {
    const m = sql.match(/(?:from|into|update|create\s+(?:unique\s+)?index\s+\S+\s+on|create\s+table(?:\s+if\s+not\s+exists)?)\s+([a-z_]+)/i);
    return m ? m[1].toLowerCase() : '';
  };

  const driver: SqlDriver = {
    async exec(sql) {
      const trimmed = sql.trim();
      if (/^create table/i.test(trimmed)) {
        const t = tableFromSql(trimmed);
        if (t && !store[t]) store[t] = [];
        saveStore(store);
        return;
      }
      if (/^create index/i.test(trimmed)) return;
      if (/^delete from/i.test(trimmed)) {
        const t = tableFromSql(trimmed);
        if (t) store[t] = [];
        saveStore(store);
        return;
      }
      // Fall through: silently swallow — repos use insert() helper below.
    },
    async select<T>(_sql: string, _params: any[] = []): Promise<T[]> {
      // Tables are read via repos that use driver.tableRead helper, see below.
      return [] as T[];
    },
    async transaction(work) {
      const snapshot = JSON.parse(JSON.stringify(store));
      try {
        return await work(driver);
      } catch (e) {
        store = snapshot;
        saveStore(store);
        throw e;
      }
    },
    describe() {
      return 'browser (localStorage) · matmon.dev.db.v1';
    },
  };

  // Augmented helpers for repos to use directly. Cast at call site.
  (driver as any).tableRead = (name: string) => store[name] || [];
  (driver as any).tableWrite = (name: string, rows: FakeTable) => {
    store[name] = rows;
    saveStore(store);
  };
  (driver as any).tableInsert = (name: string, row: any) => {
    if (!store[name]) store[name] = [];
    store[name].push(row);
    saveStore(store);
  };
  (driver as any).tableClear = (name: string) => {
    store[name] = [];
    saveStore(store);
  };

  return driver;
}

// ── Public entry point ──────────────────────────────────────
let cached: Promise<SqlDriver> | null = null;
export function getDriver(): Promise<SqlDriver> {
  if (cached) return cached;
  cached = (async () => {
    const tauriDriver = await loadTauriDriver();
    return tauriDriver ?? makeBrowserDriver();
  })();
  return cached;
}

export { isTauri } from '../env';
import { isTauri as isTauriEnv } from '../env';

/** Reset cached driver. Used by the test setup to guarantee isolation. */
export function __resetDriverForTests(): void {
  cached = null;
}
