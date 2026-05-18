// SQL schema applied on first open. Idempotent (CREATE IF NOT EXISTS).
//
// SINGLE SOURCE OF TRUTH: src-tauri/migrations/*.sql. The Tauri SQLite plugin
// reads each file via the migration registry in src-tauri/src/lib.rs; the
// browser dev shim imports the same files at build time via Vite's ?raw
// loader and concatenates them so the in-browser schema never drifts.
//
// IMPORTANT: when you add a new V<n>__*.sql migration:
//   1. Register it in src-tauri/src/lib.rs alongside the others.
//   2. Import it below and append to SCHEMA_SQL.
//   3. Make the ALTER TABLE statements idempotent at the browser-shim layer:
//      the browser shim stores rows as JSON so column adds are free, but a
//      hard `CREATE TABLE` would clobber existing rows on every cold start.
import SCHEMA_V1 from '../../../src-tauri/migrations/V1__init.sql?raw';
import SCHEMA_V2 from '../../../src-tauri/migrations/V2__prices_prev_close.sql?raw';
import SCHEMA_V3 from '../../../src-tauri/migrations/V3__instruments.sql?raw';

// The V2 migration is `ALTER TABLE prices ADD COLUMN prev_close REAL`. The
// browser shim's driver.exec() doesn't understand ALTER TABLE (its tiny
// regex parser only recognizes CREATE TABLE / CREATE INDEX / DELETE FROM),
// so an ALTER hits the silent fall-through branch. That's the right behavior
// for the shim: row storage is JSON, so the column is implicitly available
// the moment any code writes a `prev_close` field. The statement is still
// applied via splitSqlStatements() to keep the Tauri path consistent.
//
// The V3 migration adds the `instruments` table for per-symbol metadata
// (sector, industry, long name) fetched from Yahoo's quoteSummary endpoint.
// The browser shim's tableFromSql regex picks up the CREATE TABLE so the
// table is implicitly registered on first read; row reads/writes go through
// tableRead/tableWrite the same way every other table does.
export const SCHEMA_SQL: string = `${SCHEMA_V1}\n\n${SCHEMA_V2}\n\n${SCHEMA_V3}`;

/**
 * Split a multi-statement SQL string into individual statements. Robust
 * against semicolons that live inside string literals (CREATE TABLE ... DEFAULT
 * '...;...' won't silently truncate the schema). Strips full-line `--` comments
 * before splitting so commentary doesn't confuse the parser.
 */
export function splitSqlStatements(sql: string): string[] {
  // Drop `--` line comments. We do NOT support /* ... */ block comments here
  // because the migration file doesn't use them; if that changes, extend.
  const noComments = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');

  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === "'" && !inDouble) {
      // Handle SQL-style doubled-quote escape ('') by appending both and
      // skipping the next index.
      if (inSingle && noComments[i + 1] === "'") {
        buf += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (inDouble && noComments[i + 1] === '"') {
        buf += '""';
        i++;
        continue;
      }
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
