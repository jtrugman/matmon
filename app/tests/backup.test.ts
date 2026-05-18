import { describe, expect, it } from 'vitest';
import {
  BACKUP_TABLES,
  BACKUP_VERSION,
  countRows,
  eraseEverything,
  exportAll,
  importBackupFromPayload,
} from '../src/lib/db/backup';
import {
  insertAccount,
  insertTransactions,
  listAccounts,
  listTransactions,
  setSetting,
  getSetting,
} from '../src/lib/db/repos';
import type { AccountRow } from '../src/lib/db/repos';
import type { ParsedTransaction } from '../src/lib/importers/types';

function tx(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    date: new Date('2024-08-15T00:00:00Z'),
    symbol: 'AAPL',
    action: 'buy',
    quantity: 10,
    price: 180.5,
    fees: 0,
    amount: -1805,
    currency: 'USD',
    notes: '',
    rawHash: 'h1',
    ...overrides,
  };
}

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'fid-tax',
    name: 'Fidelity Taxable',
    brokerage: 'Fidelity',
    account_type: 'taxable',
    currency: 'USD',
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seed(): Promise<void> {
  await insertAccount(account());
  await insertAccount(account({ id: 'sch-roth', name: 'Schwab Roth', brokerage: 'Schwab', account_type: 'roth_ira' }));
  await insertTransactions('fid-tax', [
    tx({ rawHash: 'fid-1' }),
    tx({ rawHash: 'fid-2', symbol: 'VTI', quantity: 5, price: 220 }),
  ]);
  await insertTransactions('sch-roth', [
    tx({ rawHash: 'sch-1', symbol: 'MSFT', action: 'sell', quantity: 3, price: 410, notes: 'rebalance' }),
  ]);
  await setSetting('theme', 'dark');
}

describe('backup · exportAll', () => {
  it('returns a versioned payload with every known table', async () => {
    const payload = await exportAll();
    expect(payload.version).toBe(BACKUP_VERSION);
    expect(typeof payload.exportedAt).toBe('string');
    for (const t of BACKUP_TABLES) {
      expect(payload.tables[t]).toBeDefined();
      expect(Array.isArray(payload.tables[t])).toBe(true);
    }
  });

  it('includes seeded accounts, transactions, and settings', async () => {
    await seed();
    const payload = await exportAll();
    expect(payload.tables.accounts).toHaveLength(2);
    expect(payload.tables.transactions).toHaveLength(3);
    expect(payload.tables.settings).toEqual(
      expect.arrayContaining([{ key: 'theme', value: 'dark' }]),
    );
  });

  it('countRows sums across tables', async () => {
    await seed();
    const payload = await exportAll();
    expect(countRows(payload)).toBe(6); // 2 accounts + 3 transactions + 1 setting
  });
});

describe('backup · round-trip', () => {
  it('export → erase → import restores accounts and transactions', async () => {
    await seed();
    const originalAccounts = await listAccounts();
    const originalTx = await listTransactions();
    const payload = await exportAll();

    await eraseEverything();
    expect(await listAccounts()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);

    const result = await importBackupFromPayload(payload);
    expect(result.tablesRestored).toEqual([...BACKUP_TABLES]);
    expect(result.rowCount).toBe(countRows(payload));

    const restoredAccounts = await listAccounts();
    const restoredTx = await listTransactions();
    expect(restoredAccounts).toHaveLength(originalAccounts.length);
    expect(restoredTx).toHaveLength(originalTx.length);

    // Compare on key fields rather than deep-equal because the browser shim and
    // the SQLite path may differ on PK assignment for transactions.
    const originalAcctIds = originalAccounts.map(a => a.id).sort();
    const restoredAcctIds = restoredAccounts.map(a => a.id).sort();
    expect(restoredAcctIds).toEqual(originalAcctIds);

    const fingerprint = (rows: typeof originalTx) =>
      rows
        .map(r => `${r.account_id}|${r.symbol}|${r.action}|${r.quantity}|${r.price}|${r.imported_from}`)
        .sort();
    expect(fingerprint(restoredTx)).toEqual(fingerprint(originalTx));

    // Settings survived too.
    expect(await getSetting('theme')).toBe('dark');
  });
});

describe('backup · eraseEverything', () => {
  it('empties every table', async () => {
    await seed();
    await eraseEverything();
    expect(await listAccounts()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);
    expect(await getSetting('theme')).toBeNull();

    const payload = await exportAll();
    for (const t of BACKUP_TABLES) {
      expect(payload.tables[t]).toEqual([]);
    }
  });
});

describe('backup · importBackupFromPayload validation', () => {
  it('rejects payloads with the wrong version', async () => {
    const bad = {
      version: BACKUP_VERSION + 99,
      exportedAt: new Date().toISOString(),
      tables: {},
    };
    await expect(importBackupFromPayload(bad)).rejects.toThrow(/version mismatch/i);
  });

  it('rejects payloads missing required fields', async () => {
    await expect(importBackupFromPayload(null)).rejects.toThrow(/missing required fields/i);
    await expect(importBackupFromPayload({ version: 1 })).rejects.toThrow(/missing required fields/i);
    await expect(importBackupFromPayload({ version: 1, exportedAt: 'x' })).rejects.toThrow(
      /missing required fields/i,
    );
  });
});
