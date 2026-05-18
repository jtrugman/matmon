// Domain repositories. Each repo speaks SqlDriver, but also knows how to use the
// browser-driver "tableRead/tableWrite" shortcut when we're not in Tauri (since the
// browser driver doesn't actually execute SQL).

import type { SqlDriver } from './driver';
import { getDriver } from './driver';
import { SCHEMA_SQL, splitSqlStatements } from './schema';
import { diag } from './diag';
import type { ParsedTransaction } from '../importers/types';

/**
 * Decide whether a given driver instance is the browser shim. PREVIOUSLY the
 * repos branched on a synchronous `isTauri()` check, which read window globals
 * at the moment of the call. On cold boot, `getDriver()` would correctly wait
 * for `__TAURI_INTERNALS__` to land and pick the Tauri SQL driver, but a
 * concurrent `insertAccount` could fire before those globals were visible to
 * `isTauri()`. The result: writes took the browser-shim branch and tried to
 * call `tableRead` on a Tauri driver instance, which would throw. Branching on
 * the actual driver instance (via its describe() hint, which we set ourselves)
 * removes that race entirely.
 */
function isBrowserShim(drv: SqlDriver): boolean {
  return drv.describe().startsWith('browser');
}

export type AccountRow = {
  id: string;
  name: string;
  brokerage: string;
  account_type: string;
  currency: string;
  created_at: string;
};

/**
 * Canonical account fingerprint used by upsertAccountByFingerprint to decide
 * whether an incoming account is a re-import of an existing one. Two accounts
 * collide iff:
 *   - brokerage matches (case-insensitive), AND
 *   - last4 matches AND last4 is non-empty, OR
 *   - last4 is empty for BOTH sides AND name matches (case-insensitive)
 *
 * The fallback to name-equality is deliberately strict: we never collapse two
 * accounts that the user genuinely named differently, because that would be
 * destructive. If you re-import a Schwab activity export (no account number)
 * under a new account name, you'll get a new row and that's the right call.
 */
function fingerprintKey(brokerage: string, last4: string, name: string): string {
  const b = (brokerage || '').trim().toLowerCase();
  const l = (last4 || '').trim();
  if (l) return `b:${b}::l:${l}`;
  const n = (name || '').trim().toLowerCase();
  return `b:${b}::n:${n}`;
}

export type TxRow = {
  id: number;
  account_id: string;
  date: string;
  symbol: string | null;
  action: string;
  quantity: number;
  price: number;
  fees: number;
  amount: number | null;
  currency: string;
  notes: string | null;
  imported_from: string | null;
};

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  diag('repos', 'init: applying schema');
  const drv = await getDriver();
  // Apply schema. SQLite executes one statement per call. We use
  // splitSqlStatements (string-literal aware) instead of naive `.split(';')`
  // so any future statement containing a `;` inside a quoted string isn't
  // silently truncated.
  let stmtCount = 0;
  for (const stmt of splitSqlStatements(SCHEMA_SQL)) {
    await drv.exec(stmt);
    stmtCount++;
  }
  diag('repos', `init: schema applied (${stmtCount} statements) via ${drv.describe()}`);
}

/** Reset init flag for tests so the cached driver+schema get rebuilt. */
export function __resetReposForTests(): void {
  initialized = false;
}

export async function listAccounts(): Promise<AccountRow[]> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    return ((drv as any).tableRead('accounts') as AccountRow[]).slice();
  }
  return drv.select<AccountRow>('SELECT * FROM accounts ORDER BY created_at ASC');
}

export async function insertAccount(a: AccountRow): Promise<void> {
  await init();
  const drv = await getDriver();
  diag('repos', 'insertAccount', { id: a.id, name: a.name, brokerage: a.brokerage });
  if (isBrowserShim(drv)) {
    const existing = ((drv as any).tableRead('accounts') as AccountRow[]).filter(x => x.id !== a.id);
    existing.push(a);
    (drv as any).tableWrite('accounts', existing);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO accounts (id, name, brokerage, account_type, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [a.id, a.name, a.brokerage, a.account_type, a.currency, a.created_at],
  );
}

/**
 * Insert an account, OR return the ID of an existing row that fingerprints the
 * same brokerage account. This is the root-cause fix for the "import the same
 * CSV twice and get 16 phantom accounts" bug: rather than always inserting a
 * fresh row keyed by a fresh slug, we first check whether the incoming
 * (brokerage, last4) -- or (brokerage, name) when no account number was
 * detected -- already exists in the accounts table. If it does, we return the
 * existing ID and the caller's insertTransactions() call lands on that account,
 * so the rowHash dedupe inside insertTransactions correctly skips the
 * already-imported rows.
 *
 * `desired` is the account the caller WOULD have inserted (id, name,
 * brokerage, account_type, currency, created_at). `last4` is the trailing
 * 4-digit window of the brokerage-assigned account number, when known; pass
 * the empty string when no account number was surfaced by the importer.
 *
 * Returns { id, created } where `id` is the canonical account ID to use for
 * subsequent insertTransactions / upsertPrice calls, and `created` is true
 * when a new row was inserted (false when an existing match was reused).
 *
 * NOTE: `desired.id` is treated as a HINT. When we insert a new row we'll use
 * it as-is (since slugifyAccountId already deduped against in-memory IDs);
 * when we find an existing match we IGNORE the hint and return the existing
 * row's id so the caller's transactions land on the canonical account.
 */
export async function upsertAccountByFingerprint(
  desired: AccountRow,
  last4: string,
): Promise<{ id: string; created: boolean }> {
  await init();
  const drv = await getDriver();
  const all = await listAccounts();
  const incomingKey = fingerprintKey(desired.brokerage, last4, desired.name);
  diag('repos', 'upsertAccountByFingerprint: looking for match', {
    brokerage: desired.brokerage,
    last4,
    name: desired.name,
    incomingKey,
    existingCount: all.length,
  });
  // Build a lookup: fingerprintKey -> existing AccountRow. We have to derive
  // the existing rows' last4 from their name (we never persisted last4 as a
  // column; the slug + the human name embed it for multi-account imports as
  // "1234 Brokerage AccountName"). lastFourFromName() pulls a leading 4-digit
  // run when present.
  for (const row of all) {
    const rowLast4 = lastFourFromName(row.name);
    const rowKey = fingerprintKey(row.brokerage, rowLast4, row.name);
    if (rowKey === incomingKey) {
      diag('repos', 'upsertAccountByFingerprint: matched existing', { id: row.id });
      return { id: row.id, created: false };
    }
  }
  // No match: insert as new.
  if (isBrowserShim(drv)) {
    const existing = ((drv as any).tableRead('accounts') as AccountRow[]).filter(
      x => x.id !== desired.id,
    );
    existing.push(desired);
    (drv as any).tableWrite('accounts', existing);
  } else {
    await drv.exec(
      `INSERT OR REPLACE INTO accounts (id, name, brokerage, account_type, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        desired.id,
        desired.name,
        desired.brokerage,
        desired.account_type,
        desired.currency,
        desired.created_at,
      ],
    );
  }
  diag('repos', 'upsertAccountByFingerprint: inserted new', { id: desired.id });
  return { id: desired.id, created: true };
}

/**
 * Best-effort extraction of a 4-digit account suffix from a display name.
 * Multi-account imports default to "<last4> <brokerage> <name>" (e.g.
 * "1234 JP Morgan Self-Directed-Ret"), so the leading 4-digit token is the
 * canonical fingerprint we want to match on. For single-account uploads the
 * name typically lacks a digit token; we then fall through to name matching
 * inside fingerprintKey().
 */
function lastFourFromName(name: string): string {
  if (!name) return '';
  const m = name.trim().match(/(?:^|\s)(\d{4})(?:\s|$)/);
  return m ? m[1] : '';
}

/**
 * One-shot migration that collapses duplicate account rows for users who got
 * stung by the pre-fingerprint insertAccount path (Justin's case: 4 JPM CSV
 * imports created 16 accounts, one of which carries every transaction and 15
 * are empty skeletons). Groups by (brokerage, last4) when last4 is non-empty,
 * else (brokerage, name); picks the canonical row in each group (the one with
 * the most transactions, tie-broken by oldest created_at); reassigns every
 * other row's transactions to the canonical; then deletes the dupes.
 *
 * Idempotent: running twice on the same DB is a no-op the second time (every
 * group is size 1 after the first pass).
 */
export async function dedupeDuplicateAccounts(): Promise<{
  merged: number;
  deleted: string[];
}> {
  await init();
  const all = await listAccounts();
  const allTxs = await listTransactions();
  // Index transactions per account so we can count without re-querying.
  const txCountByAccount = new Map<string, number>();
  for (const t of allTxs) {
    txCountByAccount.set(t.account_id, (txCountByAccount.get(t.account_id) || 0) + 1);
  }

  // Bucket accounts by canonical fingerprint.
  const groups = new Map<string, AccountRow[]>();
  for (const row of all) {
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
    // Pick canonical: most transactions wins; ties broken by oldest created_at.
    bucket.sort((a, b) => {
      const ta = txCountByAccount.get(a.id) || 0;
      const tb = txCountByAccount.get(b.id) || 0;
      if (ta !== tb) return tb - ta;
      // Both empty (or tied): oldest created_at first.
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
    const canonical = bucket[0];
    diag('repos', 'dedupeDuplicateAccounts: collapsing group', {
      canonicalId: canonical.id,
      duplicateIds: bucket.slice(1).map(r => r.id),
      groupSize: bucket.length,
    });
    for (const dup of bucket.slice(1)) {
      await reassignTransactions(dup.id, canonical.id);
      await deleteAccountRowOnly(dup.id);
      deletedIds.push(dup.id);
    }
  }

  diag('repos', 'dedupeDuplicateAccounts: complete', {
    merged: mergedGroups,
    deleted: deletedIds.length,
  });
  return { merged: mergedGroups, deleted: deletedIds };
}

/**
 * Move every transaction from one account to another, defending against the
 * schema's UNIQUE(account_id, date, symbol, action, quantity, price,
 * imported_from) index. When the canonical account already holds a row that
 * matches the dupe's (date, symbol, action, quantity, price, imported_from)
 * tuple, the source row is dropped instead of reassigned (it's the same
 * imported transaction; we don't want to double-count).
 *
 * No-op when source has no transactions, which is the common case in the
 * post-bug cleanup (the duplicate skeleton accounts had ZERO transactions,
 * so this function silently returns).
 */
async function reassignTransactions(from: string, to: string): Promise<void> {
  if (from === to) return;
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const txs = (drv as any).tableRead('transactions') as TxRow[];
    // Build a set of canonical-account "fingerprints" so dupe rows that
    // collide on the schema UNIQUE index get dropped rather than reassigned.
    const canonicalKeys = new Set<string>();
    const fp = (t: TxRow) =>
      `${t.account_id}|${t.date}|${t.symbol ?? ''}|${t.action}|${t.quantity}|${t.price}|${t.imported_from ?? ''}`;
    for (const t of txs) {
      if (t.account_id === to) canonicalKeys.add(fp({ ...t }));
    }
    const next: TxRow[] = [];
    let changed = false;
    for (const t of txs) {
      if (t.account_id !== from) {
        next.push(t);
        continue;
      }
      // Would-collide check using the "to" account id.
      const reassignedFp = fp({ ...t, account_id: to });
      if (canonicalKeys.has(reassignedFp)) {
        // Drop: the canonical already has this exact transaction.
        changed = true;
        continue;
      }
      canonicalKeys.add(reassignedFp);
      next.push({ ...t, account_id: to });
      changed = true;
    }
    if (changed) (drv as any).tableWrite('transactions', next);
    return;
  }
  // SQLite path: pre-delete dupe rows whose (date, symbol, action, quantity,
  // price, imported_from) already exists on the canonical account, then
  // UPDATE the remainder.
  await drv.exec(
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
    [from, to],
  );
  await drv.exec('UPDATE transactions SET account_id = ? WHERE account_id = ?', [to, from]);
}

/**
 * Delete an account row WITHOUT cascading transactions. The dedupe migration
 * uses this AFTER reassignTransactions has already moved the dupe's transactions
 * onto the canonical row; calling deleteAccount() instead would wipe them.
 */
async function deleteAccountRowOnly(id: string): Promise<void> {
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const accts = ((drv as any).tableRead('accounts') as AccountRow[]).filter(a => a.id !== id);
    (drv as any).tableWrite('accounts', accts);
    return;
  }
  await drv.exec('DELETE FROM accounts WHERE id = ?', [id]);
}

/** Delete an account and all of its transactions. No-op if id doesn't exist. */
export async function deleteAccount(id: string): Promise<void> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const accts = ((drv as any).tableRead('accounts') as AccountRow[]).filter(a => a.id !== id);
    (drv as any).tableWrite('accounts', accts);
    const txs = ((drv as any).tableRead('transactions') as TxRow[]).filter(t => t.account_id !== id);
    (drv as any).tableWrite('transactions', txs);
    return;
  }
  await drv.exec('DELETE FROM transactions WHERE account_id = ?', [id]);
  await drv.exec('DELETE FROM accounts WHERE id = ?', [id]);
}

export async function listTransactions(accountId?: string): Promise<TxRow[]> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const all = (drv as any).tableRead('transactions') as TxRow[];
    return accountId ? all.filter(t => t.account_id === accountId) : all.slice();
  }
  if (accountId) {
    return drv.select<TxRow>('SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC', [
      accountId,
    ]);
  }
  return drv.select<TxRow>('SELECT * FROM transactions ORDER BY date DESC');
}

/**
 * Convenience: return every transaction in the DB regardless of account, sorted
 * chronologically (oldest-first). HomeView uses this to compute XIRR and
 * dividend aggregates from real flows instead of from the synthetic demo
 * generator. Callers that need a different sort order can re-sort the result.
 */
export async function loadAllTransactions(): Promise<TxRow[]> {
  const rows = await listTransactions();
  return [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Bulk insert with raw-hash dedupe. Returns counts so the UI can show "Imported X, skipped Y".
 */
export async function insertTransactions(
  accountId: string,
  txs: ParsedTransaction[],
): Promise<{ inserted: number; skipped: number }> {
  await init();
  const drv = await getDriver();
  diag('repos', 'insertTransactions: start', { accountId, incoming: txs.length });
  let inserted = 0;
  let skipped = 0;

  if (isBrowserShim(drv)) {
    const existing = (drv as any).tableRead('transactions') as TxRow[];
    const known = new Set(existing.map(t => t.imported_from).filter(Boolean) as string[]);
    let nextId = existing.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const next = existing.slice();
    for (const t of txs) {
      if (known.has(t.rawHash)) {
        skipped++;
        continue;
      }
      next.push({
        id: nextId++,
        account_id: accountId,
        date: t.date.toISOString(),
        symbol: t.symbol,
        action: t.action,
        quantity: t.quantity,
        price: t.price,
        fees: t.fees,
        amount: t.amount,
        currency: t.currency,
        notes: t.notes,
        imported_from: t.rawHash,
      });
      known.add(t.rawHash);
      inserted++;
    }
    (drv as any).tableWrite('transactions', next);
    diag('repos', 'insertTransactions: done (browser-shim)', { inserted, skipped });
    return { inserted, skipped };
  }

  await drv.transaction(async tx => {
    for (const t of txs) {
      const existing = await tx.select<{ id: number }>(
        'SELECT id FROM transactions WHERE imported_from = ? LIMIT 1',
        [t.rawHash],
      );
      if (existing.length) {
        skipped++;
        continue;
      }
      await tx.exec(
        `INSERT INTO transactions (account_id, date, symbol, action, quantity, price, fees, amount, currency, notes, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          accountId,
          t.date.toISOString(),
          t.symbol,
          t.action,
          t.quantity,
          t.price,
          t.fees,
          t.amount,
          t.currency,
          t.notes,
          t.rawHash,
        ],
      );
      inserted++;
    }
  });

  diag('repos', 'insertTransactions: done (tauri-sql)', { inserted, skipped });
  return { inserted, skipped };
}

// ── Prices ────────────────────────────────────────────────────
// One row per (symbol, date). Holdings-only importers (notably JPM positions)
// push the current market mark in here at import time, so the portfolio layer
// can value positions at market even when no live quote provider is reachable.

export type PriceRow = {
  symbol: string;
  date: string;
  close: number;
  currency: string;
  fetched_at: string;
  /**
   * Yesterday's close, as reported by the Yahoo chart endpoint's
   * meta.chartPreviousClose at fetch time. Null on rows backfilled from the
   * historical chart endpoint (where the previous bar's close lives in the
   * adjacent row). The portfolio aggregator reads this for "today" deltas.
   */
  prev_close?: number | null;
};

/** Insert or replace a single price row, keyed by (symbol, date). */
export async function upsertPrice(
  symbol: string,
  date: Date,
  close: number,
  currency = 'USD',
  prevClose: number | null = null,
): Promise<void> {
  await init();
  const drv = await getDriver();
  const dateStr = date.toISOString();
  const fetchedAt = new Date().toISOString();
  if (isBrowserShim(drv)) {
    const existing = ((drv as any).tableRead('prices') as PriceRow[]).filter(
      r => !(r.symbol === symbol && r.date === dateStr),
    );
    existing.push({
      symbol,
      date: dateStr,
      close,
      currency,
      fetched_at: fetchedAt,
      prev_close: prevClose,
    });
    (drv as any).tableWrite('prices', existing);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO prices (symbol, date, close, currency, fetched_at, prev_close)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [symbol, dateStr, close, currency, fetchedAt, prevClose],
  );
}

/**
 * Full stored price history for a symbol, oldest-first. Returns an empty list
 * when no price rows exist. Used by HoldingDetailView to render a real price
 * chart from the prices table (when present) rather than the old synthetic
 * sine-wave fabrication.
 */
export async function listPriceHistory(symbol: string): Promise<{ date: Date; close: number }[]> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('prices') as PriceRow[]).filter(r => r.symbol === symbol);
    return rows
      .map(r => ({ date: new Date(r.date), close: r.close }))
      .sort((a, b) => +a.date - +b.date);
  }
  const rows = await drv.select<{ close: number; date: string }>(
    'SELECT close, date FROM prices WHERE symbol = ? ORDER BY date ASC',
    [symbol],
  );
  return rows.map(r => ({ date: new Date(r.date), close: r.close }));
}

/**
 * Bulk insert/replace price rows for a single symbol in one DB round trip
 * (Tauri-SQL: a single transaction; browser shim: a single tableWrite).
 *
 * The historical backfill can land 7000+ rows per symbol; without batching
 * we'd issue 7000 individual upsertPrice() calls which is slow and burns a
 * staggering number of SQLite transaction commits. This helper deduplicates
 * by (symbol, date) (last value wins for a given date) and writes once.
 */
export async function bulkUpsertPrices(
  symbol: string,
  bars: Array<{ date: Date; close: number; currency?: string; prevClose?: number | null }>,
): Promise<void> {
  if (bars.length === 0) return;
  await init();
  const drv = await getDriver();
  const fetchedAt = new Date().toISOString();
  if (isBrowserShim(drv)) {
    const existing = (drv as any).tableRead('prices') as PriceRow[];
    // Drop any existing rows for THIS symbol with a date that's in the new
    // batch. The dedupe key here is (symbol, dateString); we let the new
    // batch's value win for any collision.
    const toReplace = new Set<string>();
    for (const b of bars) toReplace.add(b.date.toISOString());
    const filtered = existing.filter(
      r => !(r.symbol === symbol && toReplace.has(r.date)),
    );
    for (const b of bars) {
      filtered.push({
        symbol,
        date: b.date.toISOString(),
        close: b.close,
        currency: b.currency || 'USD',
        fetched_at: fetchedAt,
        prev_close: b.prevClose ?? null,
      });
    }
    (drv as any).tableWrite('prices', filtered);
    return;
  }
  await drv.transaction(async tx => {
    for (const b of bars) {
      await tx.exec(
        `INSERT OR REPLACE INTO prices (symbol, date, close, currency, fetched_at, prev_close)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          symbol,
          b.date.toISOString(),
          b.close,
          b.currency || 'USD',
          fetchedAt,
          b.prevClose ?? null,
        ],
      );
    }
  });
}

/**
 * Earliest and latest stored price date for a symbol. The backfill
 * orchestrator uses this to decide whether to skip a symbol (already covered)
 * or fetch only the missing tail.
 */
export async function getPriceCoverage(
  symbol: string,
): Promise<{ earliest: Date; latest: Date; count: number } | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('prices') as PriceRow[]).filter(
      r => r.symbol === symbol,
    );
    if (rows.length === 0) return null;
    let earliest = rows[0].date;
    let latest = rows[0].date;
    for (const r of rows) {
      if (r.date < earliest) earliest = r.date;
      if (r.date > latest) latest = r.date;
    }
    return { earliest: new Date(earliest), latest: new Date(latest), count: rows.length };
  }
  const rows = await drv.select<{ earliest: string; latest: string; n: number }>(
    `SELECT MIN(date) AS earliest, MAX(date) AS latest, COUNT(*) AS n
       FROM prices WHERE symbol = ?`,
    [symbol],
  );
  if (!rows.length || !rows[0].earliest) return null;
  return {
    earliest: new Date(rows[0].earliest),
    latest: new Date(rows[0].latest),
    count: rows[0].n,
  };
}

/**
 * Latest stored price for a symbol (highest date wins). Returns null when no
 * price row exists yet. Used by the portfolio aggregator as a fallback between
 * the live-quote cache and the last-tx-price fallback.
 *
 * `prevClose` mirrors meta.chartPreviousClose from the Yahoo quote that
 * landed this row. Null when the row came from the historical backfill (no
 * per-row prev_close there: the previous bar IS the previous row in the
 * table). The portfolio aggregator falls back to the prior price row when
 * this is null but a real prior close exists.
 */
export async function getLatestPrice(
  symbol: string,
): Promise<{ price: number; date: Date; prevClose: number | null } | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('prices') as PriceRow[]).filter(r => r.symbol === symbol);
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      price: rows[0].close,
      date: new Date(rows[0].date),
      prevClose: rows[0].prev_close ?? null,
    };
  }
  const rows = await drv.select<{ close: number; date: string; prev_close: number | null }>(
    'SELECT close, date, prev_close FROM prices WHERE symbol = ? ORDER BY date DESC LIMIT 1',
    [symbol],
  );
  if (rows.length === 0) return null;
  return {
    price: rows[0].close,
    date: new Date(rows[0].date),
    prevClose: rows[0].prev_close ?? null,
  };
}

/**
 * Most recent successful price fetch timestamp for any symbol. Returns the
 * highest `fetched_at` across the prices table; used by HomeView as a
 * fallback when the in-memory networkLog has no successful entries (e.g.
 * cold-boot before the user clicked Refresh quotes). Returns null when the
 * prices table is empty.
 */
export async function getLatestPriceFetchTime(): Promise<Date | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('prices') as PriceRow[];
    if (rows.length === 0) return null;
    let max = '';
    for (const r of rows) {
      if (r.fetched_at && r.fetched_at > max) max = r.fetched_at;
    }
    return max ? new Date(max) : null;
  }
  const rows = await drv.select<{ fetched_at: string }>(
    'SELECT fetched_at FROM prices ORDER BY fetched_at DESC LIMIT 1',
  );
  if (rows.length === 0 || !rows[0].fetched_at) return null;
  return new Date(rows[0].fetched_at);
}

// ── Instruments ──────────────────────────────────────────────
// Per-symbol metadata (sector, industry, long name) fetched lazily from
// Yahoo's /v10/finance/quoteSummary?modules=summaryProfile endpoint. The
// chart endpoint we use for prices doesn't expose sector, so we fan out one
// extra request per symbol the first time we see it. Results are cached for
// 90 days (success) / 30 days (not_found) so re-fetches don't pound the
// upstream.

export type InstrumentRow = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  long_name: string | null;
  fetched_at_ts: number;
  last_attempt_ts: number;
  /** 'ok' | 'not_found' | 'error'. Used for the cooldown decision in sector.ts. */
  last_result: string;
};

/** Single-symbol lookup. Returns null when no row exists. */
export async function getInstrument(symbol: string): Promise<InstrumentRow | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('instruments') as InstrumentRow[];
    return rows.find(r => r.symbol === symbol) ?? null;
  }
  const rows = await drv.select<InstrumentRow>(
    'SELECT * FROM instruments WHERE symbol = ? LIMIT 1',
    [symbol],
  );
  return rows[0] ?? null;
}

/**
 * Insert or replace an instruments row. Always overwrites: a re-fetch carries
 * the freshest (sector, industry) pair so the latest call wins.
 */
export async function upsertInstrument(row: InstrumentRow): Promise<void> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const existing = ((drv as any).tableRead('instruments') as InstrumentRow[]).filter(
      r => r.symbol !== row.symbol,
    );
    existing.push(row);
    (drv as any).tableWrite('instruments', existing);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO instruments
       (symbol, sector, industry, long_name, fetched_at_ts, last_attempt_ts, last_result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.symbol,
      row.sector,
      row.industry,
      row.long_name,
      row.fetched_at_ts,
      row.last_attempt_ts,
      row.last_result,
    ],
  );
}

/**
 * Bulk lookup for the portfolio builder. Returns a Map keyed by symbol so the
 * caller can populate holding.sector / holding.industry without one DB round
 * trip per row. Missing rows are simply absent from the returned Map.
 */
export async function getInstrumentsForSymbols(symbols: string[]): Promise<Map<string, InstrumentRow>> {
  const out = new Map<string, InstrumentRow>();
  if (symbols.length === 0) return out;
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const all = (drv as any).tableRead('instruments') as InstrumentRow[];
    const wanted = new Set(symbols);
    for (const r of all) if (wanted.has(r.symbol)) out.set(r.symbol, r);
    return out;
  }
  // Single-statement IN(...) lookup. SQLite parameter limit is 999 by default;
  // every realistic portfolio is under that, so we don't chunk here.
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await drv.select<InstrumentRow>(
    `SELECT * FROM instruments WHERE symbol IN (${placeholders})`,
    symbols,
  );
  for (const r of rows) out.set(r.symbol, r);
  return out;
}

// ── Settings (single-row key/value) ───────────────────────────
export async function getSetting(key: string): Promise<string | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('settings') as { key: string; value: string }[];
    return rows.find(r => r.key === key)?.value ?? null;
  }
  const rows = await drv.select<{ value: string }>('SELECT value FROM settings WHERE key = ? LIMIT 1', [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('settings') as { key: string; value: string }[]).filter(
      r => r.key !== key,
    );
    rows.push({ key, value });
    (drv as any).tableWrite('settings', rows);
    return;
  }
  await drv.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ── Achievements ──────────────────────────────────────────────
export async function listAchievements(): Promise<{ milestone_key: string; unlocked_at: string }[]> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    return (drv as any).tableRead('achievements').slice();
  }
  return drv.select('SELECT milestone_key, unlocked_at FROM achievements');
}

export async function unlockAchievement(key: string, contextJson = '{}'): Promise<void> {
  await init();
  const drv = await getDriver();
  const now = new Date().toISOString();
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('achievements') as { milestone_key: string; unlocked_at: string }[];
    if (rows.find(r => r.milestone_key === key)) return;
    rows.push({ milestone_key: key, unlocked_at: now });
    (drv as any).tableWrite('achievements', rows);
    return;
  }
  await drv.exec(
    'INSERT OR IGNORE INTO achievements (milestone_key, unlocked_at, context_json) VALUES (?, ?, ?)',
    [key, now, contextJson],
  );
}

// ── User profile (single-row, id = 1) ─────────────────────────
// Captures what the onboarding flow collects so the Planner can pick up the
// defaults the user picked the first time they opened Matmon.

export type UserProfile = {
  name: string | null;
  birth_year: number | null;
  target_retirement_age: number | null;
  expected_retirement_income: number | null;
  household_size: number | null;
};

export type OnboardingProfile = {
  name: string;
  birthYear: number;
  retireAge: number;
  household: 'single' | 'partnered' | 'family';
  theme?: 'light' | 'dark';
};

const HOUSEHOLD_TO_SIZE: Record<string, number> = {
  single: 1,
  partnered: 2,
  family: 3,
};

export async function saveUserProfile(profile: OnboardingProfile): Promise<void> {
  await init();
  const drv = await getDriver();
  diag('repos', 'saveUserProfile', {
    name: profile.name,
    birthYear: profile.birthYear,
    retireAge: profile.retireAge,
    household: profile.household,
  });
  const row: UserProfile = {
    name: profile.name ?? null,
    birth_year: profile.birthYear ?? null,
    target_retirement_age: profile.retireAge ?? null,
    expected_retirement_income: null,
    household_size: HOUSEHOLD_TO_SIZE[profile.household] ?? null,
  };
  if (isBrowserShim(drv)) {
    (drv as any).tableWrite('user_profile', [{ id: 1, ...row }]);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO user_profile
       (id, name, birth_year, target_retirement_age, expected_retirement_income, household_size)
     VALUES (1, ?, ?, ?, ?, ?)`,
    [row.name, row.birth_year, row.target_retirement_age, row.expected_retirement_income, row.household_size],
  );
}

export async function loadUserProfile(): Promise<UserProfile | null> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('user_profile') as Array<{ id: number } & UserProfile>;
    if (!rows.length) {
      diag('repos', 'loadUserProfile: browser-shim returned null (empty table)');
      return null;
    }
    const { id: _id, ...rest } = rows[0];
    diag('repos', 'loadUserProfile: browser-shim returned', { name: rest.name });
    return rest;
  }
  const rows = await drv.select<UserProfile>(
    `SELECT name, birth_year, target_retirement_age, expected_retirement_income, household_size
       FROM user_profile WHERE id = 1 LIMIT 1`,
  );
  diag('repos', 'loadUserProfile: tauri-sql returned', {
    count: rows.length,
    name: rows[0]?.name ?? null,
  });
  return rows[0] ?? null;
}

// ── Scenarios ────────────────────────────────────────────────
// Onboarding saves the user's headline goal as the first scenario. The Planner
// can read and rewrite these later.

export type ScenarioRow = {
  id: number;
  name: string;
  inputs_json: string;
  created_at: string;
  updated_at: string;
};

export async function listScenarios(): Promise<ScenarioRow[]> {
  await init();
  const drv = await getDriver();
  if (isBrowserShim(drv)) {
    return ((drv as any).tableRead('scenarios') as ScenarioRow[]).slice();
  }
  return drv.select<ScenarioRow>('SELECT * FROM scenarios ORDER BY created_at ASC');
}

// ── Ticker logos ─────────────────────────────────────────────
// We cache PNG bytes per ticker so the Holdings table and detail view can
// render the company / fund mark without re-hitting the upstream every render.
// Browser shim stores base64 in the localStorage-backed table; Tauri stores
// the raw bytes as a SQLite BLOB.

export type LogoStatus = 'ok' | 'missing' | 'error';

export type LogoRow = {
  ticker: string;
  /** Base64-encoded PNG bytes (browser shim); raw bytes (Tauri). null when status != 'ok'. */
  logo_data: string | Uint8Array | null;
  logo_format: string;
  fetched_at: string;
  status: LogoStatus;
};

export type LogoLookup = {
  bytes: Uint8Array | null;
  format: string;
  fetchedAt: Date;
  status: LogoStatus;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to dodge "max call stack" on very large payloads. Logos are tiny
  // (~5 KB) but the helper is cheap so we keep it general.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

/** Fetch the cached logo entry for a ticker. Returns null if the row doesn't exist. */
export async function getLogo(ticker: string): Promise<LogoLookup | null> {
  await init();
  const drv = await getDriver();
  const key = normalizeTicker(ticker);
  if (!key) return null;
  if (isBrowserShim(drv)) {
    const rows = (drv as any).tableRead('ticker_logos') as LogoRow[];
    const row = rows.find(r => r.ticker === key);
    if (!row) return null;
    const bytes =
      row.status === 'ok' && typeof row.logo_data === 'string' && row.logo_data.length > 0
        ? base64ToBytes(row.logo_data)
        : null;
    return {
      bytes,
      format: row.logo_format || 'png',
      fetchedAt: new Date(row.fetched_at),
      status: row.status,
    };
  }
  const rows = await drv.select<LogoRow>(
    'SELECT ticker, logo_data, logo_format, fetched_at, status FROM ticker_logos WHERE ticker = ? LIMIT 1',
    [key],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  let bytes: Uint8Array | null = null;
  if (r.status === 'ok' && r.logo_data) {
    if (r.logo_data instanceof Uint8Array) bytes = r.logo_data;
    else if (Array.isArray(r.logo_data)) bytes = new Uint8Array(r.logo_data as unknown as number[]);
    else if (typeof r.logo_data === 'string') bytes = base64ToBytes(r.logo_data);
  }
  return {
    bytes,
    format: r.logo_format || 'png',
    fetchedAt: new Date(r.fetched_at),
    status: r.status,
  };
}

/** Persist a successful logo fetch. Replaces any prior row for the ticker. */
export async function saveLogo(ticker: string, bytes: Uint8Array, format = 'png'): Promise<void> {
  await init();
  const drv = await getDriver();
  const key = normalizeTicker(ticker);
  if (!key) return;
  const fetchedAt = new Date().toISOString();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('ticker_logos') as LogoRow[]).filter(r => r.ticker !== key);
    rows.push({
      ticker: key,
      logo_data: bytesToBase64(bytes),
      logo_format: format,
      fetched_at: fetchedAt,
      status: 'ok',
    });
    (drv as any).tableWrite('ticker_logos', rows);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO ticker_logos (ticker, logo_data, logo_format, fetched_at, status)
     VALUES (?, ?, ?, ?, 'ok')`,
    [key, bytes, format, fetchedAt],
  );
}

/** Record that a logo lookup returned nothing so we don't retry every render. */
export async function markLogoMissing(ticker: string, status: LogoStatus = 'missing'): Promise<void> {
  await init();
  const drv = await getDriver();
  const key = normalizeTicker(ticker);
  if (!key) return;
  const fetchedAt = new Date().toISOString();
  if (isBrowserShim(drv)) {
    const rows = ((drv as any).tableRead('ticker_logos') as LogoRow[]).filter(r => r.ticker !== key);
    rows.push({
      ticker: key,
      logo_data: null,
      logo_format: 'png',
      fetched_at: fetchedAt,
      status,
    });
    (drv as any).tableWrite('ticker_logos', rows);
    return;
  }
  await drv.exec(
    `INSERT OR REPLACE INTO ticker_logos (ticker, logo_data, logo_format, fetched_at, status)
     VALUES (?, NULL, 'png', ?, ?)`,
    [key, fetchedAt, status],
  );
}

export async function saveGoalScenario(goal: number, profile: OnboardingProfile): Promise<void> {
  await init();
  const drv = await getDriver();
  const yearsOut = Math.max(1, profile.retireAge - (new Date().getFullYear() - profile.birthYear));
  const inputs = {
    goal,
    starting_balance: 0,
    monthly_contribution: 0,
    contribution_growth_pct: 0,
    return_mode: 'manual' as const,
    return_pct: 0.07,
    years: yearsOut,
    inflation_adjust: true,
    scope_bucket: 'all' as const,
    source: 'onboarding',
  };
  const name = `Goal · $${(goal / 1_000_000).toFixed(1)}M`;
  const now = new Date().toISOString();

  if (isBrowserShim(drv)) {
    const existing = ((drv as any).tableRead('scenarios') as ScenarioRow[]).slice();
    const nextId = existing.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    existing.push({
      id: nextId,
      name,
      inputs_json: JSON.stringify(inputs),
      created_at: now,
      updated_at: now,
    });
    (drv as any).tableWrite('scenarios', existing);
    return;
  }
  await drv.exec(`INSERT INTO scenarios (name, inputs_json, created_at, updated_at) VALUES (?, ?, ?, ?)`, [
    name,
    JSON.stringify(inputs),
    now,
    now,
  ]);
}
