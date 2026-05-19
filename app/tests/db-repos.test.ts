import { describe, expect, it } from 'vitest';
import {
  getSetting,
  init,
  insertAccount,
  insertTransactions,
  listAccounts,
  listAchievements,
  listTransactions,
  setSetting,
  unlockAchievement,
} from '../src/lib/db/repos';
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

describe('repos · init + accounts', () => {
  it('init is idempotent', async () => {
    await init();
    await init();
    expect(await listAccounts()).toEqual([]);
  });

  it('insertAccount round-trips', async () => {
    const a = {
      id: 'fid-tax',
      name: 'Fidelity Taxable',
      brokerage: 'Fidelity',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    };
    await insertAccount(a);
    const all = await listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'fid-tax', name: 'Fidelity Taxable' });
  });

  it('insertAccount with same id replaces existing row', async () => {
    const a = {
      id: 'fid-tax',
      name: 'Original Name',
      brokerage: 'Fidelity',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    };
    await insertAccount(a);
    await insertAccount({ ...a, name: 'Renamed' });
    const all = await listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Renamed');
  });
});

describe('repos · transactions', () => {
  async function seedAccount() {
    await insertAccount({
      id: 'sch-tax',
      name: 'Schwab',
      brokerage: 'Charles Schwab',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
  }

  it('inserts transactions and reports counts', async () => {
    await seedAccount();
    const out = await insertTransactions('sch-tax', [tx({ rawHash: 'a' }), tx({ rawHash: 'b' })]);
    expect(out).toEqual({ inserted: 2, skipped: 0 });
    const list = await listTransactions('sch-tax');
    expect(list).toHaveLength(2);
  });

  it('re-import dedupes by rawHash', async () => {
    await seedAccount();
    const batch = [tx({ rawHash: 'a' }), tx({ rawHash: 'b' })];
    await insertTransactions('sch-tax', batch);
    const second = await insertTransactions('sch-tax', batch);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect(await listTransactions('sch-tax')).toHaveLength(2);
  });

  it('partial overlap: only new hashes are inserted', async () => {
    await seedAccount();
    await insertTransactions('sch-tax', [tx({ rawHash: 'a' })]);
    const second = await insertTransactions('sch-tax', [tx({ rawHash: 'a' }), tx({ rawHash: 'b' })]);
    expect(second).toEqual({ inserted: 1, skipped: 1 });
    expect(await listTransactions('sch-tax')).toHaveLength(2);
  });

  it('listTransactions filters by accountId', async () => {
    await seedAccount();
    await insertAccount({
      id: 'jpm-401k',
      name: 'JPM',
      brokerage: 'JP Morgan',
      account_type: '401k',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions('sch-tax', [tx({ rawHash: 'sch-1' })]);
    await insertTransactions('jpm-401k', [tx({ rawHash: 'jpm-1' }), tx({ rawHash: 'jpm-2' })]);
    expect(await listTransactions('sch-tax')).toHaveLength(1);
    expect(await listTransactions('jpm-401k')).toHaveLength(2);
    expect(await listTransactions()).toHaveLength(3);
  });

  it('preserves all fields through insert/list round-trip', async () => {
    await seedAccount();
    const sample = tx({
      symbol: 'VTI',
      action: 'sell',
      quantity: 12.5,
      price: 318.45,
      fees: 1.5,
      amount: 3980.625,
      notes: 'Tax-loss harvest',
      rawHash: 'roundtrip-1',
    });
    await insertTransactions('sch-tax', [sample]);
    const [row] = await listTransactions('sch-tax');
    expect(row.symbol).toBe('VTI');
    expect(row.action).toBe('sell');
    expect(row.quantity).toBe(12.5);
    expect(row.price).toBe(318.45);
    expect(row.fees).toBe(1.5);
    expect(row.notes).toBe('Tax-loss harvest');
  });
});

describe('repos · settings', () => {
  it('returns null for unknown key', async () => {
    expect(await getSetting('nope')).toBeNull();
  });

  it('round-trips a value', async () => {
    await setSetting('theme', 'dark');
    expect(await getSetting('theme')).toBe('dark');
  });

  it('upserts the same key', async () => {
    await setSetting('theme', 'light');
    await setSetting('theme', 'dark');
    expect(await getSetting('theme')).toBe('dark');
  });
});

describe('repos · achievements', () => {
  it('unlock + list', async () => {
    await unlockAchievement('first_million', JSON.stringify({ value: 1_000_001 }));
    const list = await listAchievements();
    expect(list).toHaveLength(1);
    expect(list[0].milestone_key).toBe('first_million');
  });

  it('second unlock of the same milestone is a no-op', async () => {
    await unlockAchievement('first_million');
    await unlockAchievement('first_million');
    expect(await listAchievements()).toHaveLength(1);
  });
});
