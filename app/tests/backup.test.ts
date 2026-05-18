import { describe, expect, it } from 'vitest';
import {
  BACKUP_TABLES,
  BACKUP_VERSION,
  TABLE_COLUMNS,
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
  await insertAccount(
    account({ id: 'sch-roth', name: 'Schwab Roth', brokerage: 'Schwab', account_type: 'roth_ira' }),
  );
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
    expect(payload.tables.settings).toEqual(expect.arrayContaining([{ key: 'theme', value: 'dark' }]));
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

describe('backup · column allowlist (SQL injection guard)', () => {
  it('drops unknown column keys from imported account rows', async () => {
    // Simulate a malicious / corrupt backup that smuggles an extra "column"
    // whose NAME contains a SQL fragment. The fix is to intersect each row's
    // keys with the per-table schema allowlist before interpolating any
    // identifier into SQL. Unknown keys must be silently dropped so neither
    // the Tauri path nor the browser shim retains the bogus value.
    const payload = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables: {
        accounts: [
          {
            id: 'acct-allowed',
            name: 'Fidelity Taxable',
            brokerage: 'Fidelity',
            account_type: 'taxable',
            currency: 'USD',
            created_at: '2024-01-01T00:00:00.000Z',
            // Injection attempts. None of these are real columns on the
            // accounts table and they must be stripped before any INSERT.
            'name); DROP TABLE accounts; --': 'pwn',
            secret_admin_flag: 1,
            password: 'hunter2',
          },
        ],
        transactions: [],
        prices: [],
        symbol_metadata: [],
        achievements: [],
        scenarios: [],
        user_profile: [],
        tax_constants: [],
        settings: [],
      },
    };
    await importBackupFromPayload(payload);

    // The accounts table still exists (the injection didn't drop it) and
    // round-trips back with ONLY the schema-allowlisted columns.
    const round = await exportAll();
    const accounts = round.tables.accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    const row = accounts[0];
    expect(row.id).toBe('acct-allowed');
    expect(row.name).toBe('Fidelity Taxable');
    expect(row.brokerage).toBe('Fidelity');
    // Every retained key must be a known schema column.
    const allowed = new Set(TABLE_COLUMNS.accounts);
    for (const k of Object.keys(row)) expect(allowed.has(k)).toBe(true);
    // None of the injection keys survived.
    expect(row['name); DROP TABLE accounts; --']).toBeUndefined();
    expect(row.secret_admin_flag).toBeUndefined();
    expect(row.password).toBeUndefined();
  });

  it('drops unknown column keys from imported settings rows too', async () => {
    const payload = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables: {
        accounts: [],
        transactions: [],
        prices: [],
        symbol_metadata: [],
        achievements: [],
        scenarios: [],
        user_profile: [],
        tax_constants: [],
        settings: [
          {
            key: 'theme',
            value: 'dark',
            // Bogus identifier-position payload.
            'value FROM settings UNION SELECT name': 'attack',
          },
        ],
      },
    };
    await importBackupFromPayload(payload);
    const round = await exportAll();
    const settings = round.tables.settings as Record<string, unknown>[];
    expect(settings).toHaveLength(1);
    const allowed = new Set(TABLE_COLUMNS.settings);
    for (const k of Object.keys(settings[0])) expect(allowed.has(k)).toBe(true);
    expect(settings[0].key).toBe('theme');
    expect(settings[0].value).toBe('dark');
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
