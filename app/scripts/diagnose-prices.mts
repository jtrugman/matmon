#!/usr/bin/env -S node --experimental-strip-types
// Diagnostic for the historical-prices backfill state. Opens the production
// SQLite DB at ~/Library/Application Support/app.matmon.desktop/portfolio.db
// and reports per-symbol coverage of the `prices` table.
//
// Usage:
//   node --experimental-strip-types scripts/diagnose-prices.mts
//
// Prints one row per held symbol with:
//   - earliest bar date
//   - latest bar date
//   - total bar count
//   - flag UNDERPOPULATED when count < 100 (indicates the backfill either
//     didn't run for this symbol or returned only a partial window)
//
// At the end, prints the backfill-recovery flag from the settings table and
// a short verdict so Justin can tell at a glance whether the backfill ever
// completed for his real portfolio. This script is read-only; it never
// writes back to the DB.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'app.matmon.desktop',
  'portfolio.db',
);

if (!existsSync(DB_PATH)) {
  console.error(`diagnose-prices: no DB at ${DB_PATH}`);
  console.error('Either Matmon has never been launched on this machine, or the');
  console.error('app uses a different storage path. Aborting.');
  process.exit(1);
}

console.log(`diagnose-prices: opening ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

// 1. Recovery flag.
const recoveryRow = db
  .prepare("SELECT value FROM settings WHERE key = 'backfill.recovery.v1.complete'")
  .get() as { value: string } | undefined;
const recoveryFlag = recoveryRow?.value ?? '(unset)';

// 2. Held symbols (every distinct non-null symbol that appears in transactions).
const heldRows = db
  .prepare(
    `SELECT DISTINCT symbol FROM transactions
     WHERE symbol IS NOT NULL AND symbol != ''
     ORDER BY symbol ASC`,
  )
  .all() as { symbol: string }[];
const held = heldRows.map(r => r.symbol);

// 3. Per-symbol coverage from the prices table.
type Cov = { symbol: string; earliest: string | null; latest: string | null; count: number };
const coverage = new Map<string, Cov>();
const covRows = db
  .prepare(
    `SELECT symbol,
            MIN(date)   AS earliest,
            MAX(date)   AS latest,
            COUNT(*)    AS count
       FROM prices
      GROUP BY symbol`,
  )
  .all() as Cov[];
for (const r of covRows) coverage.set(r.symbol, r);

// 4. Print the table.
const UNDERPOPULATED_THRESHOLD = 100;
const flagged: string[] = [];
const totalPriceRows = db
  .prepare('SELECT COUNT(*) AS n FROM prices')
  .get() as { n: number };

console.log('');
console.log(`Held symbols: ${held.length}`);
console.log(`Total price rows: ${totalPriceRows.n}`);
console.log(`Recovery flag (backfill.recovery.v1.complete): ${recoveryFlag}`);
console.log('');
console.log('Per-symbol coverage:');
console.log('  symbol      earliest      latest        bars   status');
console.log('  ----------  ------------  ------------  -----  ----------');
for (const sym of held) {
  const cov = coverage.get(sym);
  if (!cov || cov.count === 0) {
    console.log(`  ${sym.padEnd(10)}  ${'(none)'.padEnd(12)}  ${'(none)'.padEnd(12)}  ${'0'.padStart(5)}  EMPTY`);
    flagged.push(sym);
    continue;
  }
  // dates from the DB look like "2024-01-02T00:00:00.000Z"; trim the time.
  const earliest = (cov.earliest ?? '').slice(0, 10);
  const latest = (cov.latest ?? '').slice(0, 10);
  const status = cov.count < UNDERPOPULATED_THRESHOLD ? 'UNDERPOPULATED' : 'ok';
  if (status !== 'ok') flagged.push(sym);
  console.log(
    `  ${sym.padEnd(10)}  ${earliest.padEnd(12)}  ${latest.padEnd(12)}  ${String(cov.count).padStart(5)}  ${status}`,
  );
}
console.log('');

// 5. Verdict.
if (held.length === 0) {
  console.log('No held symbols, no transactions in this DB. Nothing to backfill.');
} else if (flagged.length === 0) {
  console.log(`Verdict: every held symbol has >= ${UNDERPOPULATED_THRESHOLD} bars. Backfill is healthy.`);
} else if (flagged.length === held.length) {
  console.log(
    `Verdict: BACKFILL FAILED. Every held symbol has < ${UNDERPOPULATED_THRESHOLD} bars (or none).`,
  );
  console.log('This is the qty-accumulation-curve scenario: the portfolio chart will show');
  console.log('a near-straight diagonal line and YTD will be wildly inflated.');
  if (recoveryFlag === 'yes') {
    console.log('');
    console.log('IMPORTANT: backfill.recovery.v1.complete = yes despite the empty prices table.');
    console.log('To force-retry: open Settings -> Market data -> Refresh history. The Refresh');
    console.log('quotes button on Home is not sufficient (it only fetches today\'s quotes, not');
    console.log('history).');
  }
} else {
  console.log(
    `Verdict: PARTIAL coverage. ${flagged.length} of ${held.length} symbols underpopulated:`,
  );
  for (const sym of flagged) console.log(`  - ${sym}`);
  console.log('The chart may render correctly for the covered window but will show gaps for');
  console.log('the underpopulated symbols. Open Settings -> Market data -> Refresh history to');
  console.log('force a re-fetch.');
}

db.close();
