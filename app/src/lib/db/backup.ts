// Backup, restore, and erase helpers for the local DB.
//
// Export format choice:
//   We considered a true .zip with per-account CSVs, but JSZip is not installed
//   and adding a dependency for the "Export as Zip (with CSVs)" button felt heavy.
//   Instead, both export buttons produce JSON. The "with CSVs" variant embeds
//   per-account CSV strings under a top-level `csvs` field so spreadsheet users
//   can still copy the CSV text out. This keeps the writer dependency-free and
//   the round-trip lossless (CSVs are derived, JSON is the source of truth).

import { getDriver, isTauri } from './driver';
import {
  init,
  insertAccount,
  insertTransactions,
  listAccounts,
  listTransactions,
  type AccountRow,
  type TxRow,
} from './repos';
import type { ParsedTransaction } from '../importers/types';

export const BACKUP_VERSION = 1;

// Tables we round-trip. Order matters for restore so foreign keys resolve
// (accounts before transactions).
export const BACKUP_TABLES = [
  'accounts',
  'transactions',
  'prices',
  'symbol_metadata',
  'achievements',
  'scenarios',
  'user_profile',
  'tax_constants',
  'settings',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupPayload = {
  version: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
};

export type BackupPayloadWithCsvs = BackupPayload & {
  csvs: Record<string, string>;
};

// ── Internal table helpers ───────────────────────────────────

async function readTable(name: BackupTable): Promise<unknown[]> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    return ((drv as any).tableRead(name) as unknown[]).slice();
  }
  return drv.select<Record<string, unknown>>(`SELECT * FROM ${name}`);
}

async function writeTable(name: BackupTable, rows: unknown[]): Promise<void> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    (drv as any).tableWrite(name, rows);
    return;
  }
  // Tauri path: clear, then bulk-insert. We use a parameterised generic insert
  // because each table has a different column set; column names come from row keys.
  await drv.exec(`DELETE FROM ${name}`);
  await drv.transaction(async tx => {
    for (const row of rows as Record<string, unknown>[]) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map(c => row[c]);
      await tx.exec(
        `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`,
        values,
      );
    }
  });
}

async function clearTable(name: BackupTable): Promise<void> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    (drv as any).tableClear(name);
    return;
  }
  await drv.exec(`DELETE FROM ${name}`);
}

// ── Public API ───────────────────────────────────────────────

export async function exportAll(): Promise<BackupPayload> {
  const tables: Record<string, unknown[]> = {};
  for (const name of BACKUP_TABLES) {
    tables[name] = await readTable(name);
  }
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

function isoDate(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function countRows(payload: BackupPayload): number {
  return Object.values(payload.tables).reduce((sum, rows) => sum + rows.length, 0);
}

export async function downloadExport(): Promise<{ filename: string; rowCount: number }> {
  const payload = await exportAll();
  const filename = `matmon-backup-${isoDate()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  triggerDownload(filename, blob);
  return { filename, rowCount: countRows(payload) };
}

// ── CSV helpers ──────────────────────────────────────────────

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => escapeCsvCell(r[c])).join(',')).join('\n');
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

const TX_COLUMNS: (keyof TxRow)[] = [
  'id',
  'account_id',
  'date',
  'symbol',
  'action',
  'quantity',
  'price',
  'fees',
  'amount',
  'currency',
  'notes',
  'imported_from',
];

export async function buildCsvs(): Promise<Record<string, string>> {
  const accounts = await listAccounts();
  const csvs: Record<string, string> = {};
  for (const acct of accounts) {
    const txs = await listTransactions(acct.id);
    csvs[`${acct.id}.csv`] = rowsToCsv(
      txs as unknown as Record<string, unknown>[],
      TX_COLUMNS as string[],
    );
  }
  return csvs;
}

export async function downloadZipExport(): Promise<{ filename: string; rowCount: number }> {
  // See the file-header comment: this is JSON with embedded CSV strings, not a
  // real zip. Trade-off was to avoid adding JSZip just for one button.
  const payload = await exportAll();
  const csvs = await buildCsvs();
  const bundle: BackupPayloadWithCsvs = { ...payload, csvs };
  const filename = `matmon-backup-${isoDate()}.with-csvs.json`;
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  });
  triggerDownload(filename, blob);
  return { filename, rowCount: countRows(payload) };
}

// ── Import / restore ─────────────────────────────────────────

function isBackupPayload(x: unknown): x is BackupPayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Partial<BackupPayload>;
  return (
    typeof p.version === 'number' &&
    typeof p.exportedAt === 'string' &&
    !!p.tables &&
    typeof p.tables === 'object'
  );
}

export async function importBackupFromPayload(
  payload: unknown,
): Promise<{ tablesRestored: string[]; rowCount: number }> {
  if (!isBackupPayload(payload)) {
    throw new Error('Backup file is missing required fields (version, exportedAt, tables).');
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new Error(
      `Backup version mismatch: file is v${payload.version}, this build expects v${BACKUP_VERSION}.`,
    );
  }

  await init();

  // Wipe everything first so import is a true restore, not a merge.
  for (const name of BACKUP_TABLES) {
    await clearTable(name);
  }

  // For the Tauri path, transactions has an autoincrement PK; we can use writeTable
  // for it directly. For the browser path, we route accounts + transactions through
  // their repo helpers so we exercise the same code paths the app uses elsewhere.
  const tablesRestored: string[] = [];
  let rowCount = 0;

  for (const name of BACKUP_TABLES) {
    const rows = (payload.tables[name] || []) as unknown[];
    if (name === 'accounts' && !isTauri()) {
      for (const r of rows as AccountRow[]) {
        await insertAccount(r);
      }
    } else if (name === 'transactions' && !isTauri()) {
      // Group by account_id and reuse insertTransactions so rawHash dedupe works
      // identically across import paths.
      const byAccount = new Map<string, ParsedTransaction[]>();
      for (const r of rows as TxRow[]) {
        const list = byAccount.get(r.account_id) || [];
        list.push({
          date: new Date(r.date),
          symbol: r.symbol,
          action: r.action as ParsedTransaction['action'],
          quantity: r.quantity,
          price: r.price,
          fees: r.fees,
          amount: r.amount,
          currency: r.currency,
          notes: r.notes ?? '',
          rawHash: r.imported_from ?? `restored-${r.id}`,
        });
        byAccount.set(r.account_id, list);
      }
      for (const [accountId, txs] of byAccount) {
        await insertTransactions(accountId, txs);
      }
    } else {
      await writeTable(name, rows);
    }
    tablesRestored.push(name);
    rowCount += rows.length;
  }

  return { tablesRestored, rowCount };
}

export async function importBackup(
  file: File,
): Promise<{ tablesRestored: string[]; rowCount: number }> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }
  return importBackupFromPayload(parsed);
}

export async function eraseEverything(): Promise<void> {
  for (const name of BACKUP_TABLES) {
    await clearTable(name);
  }
}
