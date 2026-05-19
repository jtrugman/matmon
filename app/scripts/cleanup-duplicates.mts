#!/usr/bin/env -S node --experimental-strip-types
// One-shot duplicate-account cleanup utility. Mirrors the production
// dedupeDuplicateAccounts() migration in src/lib/db/repos.ts but talks
// directly to the SQLite file at ~/Library/Application Support/app.matmon.desktop/portfolio.db
// so Justin can run the cleanup without launching the Tauri app.
//
// Usage:
//   node --experimental-strip-types scripts/cleanup-duplicates.mts          # mutate
//   node --experimental-strip-types scripts/cleanup-duplicates.mts --dry-run  # report only
//
// The script never runs automatically; this is a human-driven recovery step.
// Pass --dry-run first to inspect what would change, then re-run without the
// flag to apply.
//
// Idempotent: a second run on the same DB finds every group at size 1 and
// performs no writes (same behavior as the production migration).

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type AccountRow = {
  id: string;
  name: string;
  brokerage: string;
  account_type: string;
  currency: string;
  created_at: string;
};

const DB_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'app.matmon.desktop',
  'portfolio.db',
);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function lastFourFromName(name: string): string {
  if (!name) return '';
  const m = name.trim().match(/(?:^|\s)(\d{4})(?:\s|$)/);
  return m ? m[1] : '';
}

function fingerprintKey(brokerage: string, last4: string, name: string): string {
  const b = (brokerage || '').trim().toLowerCase();
  const l = (last4 || '').trim();
  if (l) return `b:${b}::l:${l}`;
  const n = (name || '').trim().toLowerCase();
  return `b:${b}::n:${n}`;
}

if (!existsSync(DB_PATH)) {
  console.error(`cleanup-duplicates: no DB at ${DB_PATH}`);
  console.error('Either Matmon has never been launched on this machine, or the');
  console.error('app uses a different storage path. Aborting.');
  process.exit(1);
}

console.log(`cleanup-duplicates: opening ${DB_PATH}${dryRun ? ' (dry-run)' : ''}`);
const db = new DatabaseSync(DB_PATH);

// Snapshot the accounts table.
const accounts = db
  .prepare('SELECT id, name, brokerage, account_type, currency, created_at FROM accounts')
  .all() as unknown as AccountRow[];

// Per-account transaction count.
const txCountByAccount = new Map<string, number>();
for (const row of db
  .prepare('SELECT account_id, COUNT(*) AS n FROM transactions GROUP BY account_id')
  .all() as { account_id: string; n: number }[]) {
  txCountByAccount.set(row.account_id, row.n);
}

// Bucket by canonical fingerprint.
const groups = new Map<string, AccountRow[]>();
for (const row of accounts) {
  const last4 = lastFourFromName(row.name);
  const key = fingerprintKey(row.brokerage, last4, row.name);
  const bucket = groups.get(key) || [];
  bucket.push(row);
  groups.set(key, bucket);
}

let mergedGroups = 0;
const deletedIds: string[] = [];

for (const bucket of groups.values()) {
  if (bucket.length <= 1) continue;
  mergedGroups += 1;
  bucket.sort((a, b) => {
    const ta = txCountByAccount.get(a.id) || 0;
    const tb = txCountByAccount.get(b.id) || 0;
    if (ta !== tb) return tb - ta;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
  const canonical = bucket[0];
  const dupes = bucket.slice(1);
  console.log(
    `  group [${canonical.brokerage} / ${lastFourFromName(canonical.name) || canonical.name}]:`,
  );
  console.log(
    `    canonical = ${canonical.id} (${txCountByAccount.get(canonical.id) || 0} tx)`,
  );
  for (const dup of dupes) {
    console.log(
      `    dupe      = ${dup.id} (${txCountByAccount.get(dup.id) || 0} tx)`,
    );
  }
  if (!dryRun) {
    // Move every dupe's transactions onto the canonical, defending against
    // the UNIQUE(account_id, date, symbol, action, quantity, price,
    // imported_from) constraint on the transactions table.
    for (const dup of dupes) {
      const fromTx = txCountByAccount.get(dup.id) || 0;
      if (fromTx > 0) {
        db.prepare(
          `DELETE FROM transactions
           WHERE account_id = ?
             AND EXISTS (
               SELECT 1 FROM transactions c
               WHERE c.account_id = ?
                 AND c.date          = transactions.date
                 AND COALESCE(c.symbol, '')        = COALESCE(transactions.symbol, '')
                 AND c.action        = transactions.action
                 AND c.quantity      = transactions.quantity
                 AND c.price         = transactions.price
                 AND COALESCE(c.imported_from, '') = COALESCE(transactions.imported_from, '')
             )`,
        ).run(dup.id, canonical.id);
        db.prepare('UPDATE transactions SET account_id = ? WHERE account_id = ?').run(
          canonical.id,
          dup.id,
        );
      }
      db.prepare('DELETE FROM accounts WHERE id = ?').run(dup.id);
      deletedIds.push(dup.id);
    }
  } else {
    for (const dup of dupes) deletedIds.push(dup.id);
  }
}

console.log('');
console.log(
  `cleanup-duplicates: ${dryRun ? 'would merge' : 'merged'} ${mergedGroups} groups, ${dryRun ? 'would delete' : 'deleted'} ${deletedIds.length} accounts.`,
);
if (deletedIds.length > 0) {
  console.log('  deleted IDs:');
  for (const id of deletedIds) console.log(`    - ${id}`);
}
if (!dryRun && mergedGroups > 0) {
  // Persist the production guard flag so the in-app migration doesn't run
  // again (it would be a no-op, but skipping the listAccounts() round-trip is
  // free correctness).
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('dedupe.v1.complete', 'yes')`,
  ).run();
  console.log('cleanup-duplicates: set settings.dedupe.v1.complete = yes');
}
db.close();
