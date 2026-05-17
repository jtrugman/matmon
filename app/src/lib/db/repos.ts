// Domain repositories. Each repo speaks SqlDriver, but also knows how to use the
// browser-driver "tableRead/tableWrite" shortcut when we're not in Tauri (since the
// browser driver doesn't actually execute SQL).

import { getDriver, isTauri } from './driver';
import { SCHEMA_SQL } from './schema';
import type { ParsedTransaction } from '../importers/types';

export type AccountRow = {
  id: string;
  name: string;
  brokerage: string;
  account_type: string;
  currency: string;
  created_at: string;
};

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
  const drv = await getDriver();
  // Apply schema. SQLite executes one statement per call — split on semicolons.
  for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await drv.exec(stmt);
  }
}

/** Reset init flag for tests so the cached driver+schema get rebuilt. */
export function __resetReposForTests(): void {
  initialized = false;
}

export async function listAccounts(): Promise<AccountRow[]> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    return ((drv as any).tableRead('accounts') as AccountRow[]).slice();
  }
  return drv.select<AccountRow>('SELECT * FROM accounts ORDER BY created_at ASC');
}

export async function insertAccount(a: AccountRow): Promise<void> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
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

/** Delete an account and all of its transactions. No-op if id doesn't exist. */
export async function deleteAccount(id: string): Promise<void> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
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
  if (!isTauri()) {
    const all = (drv as any).tableRead('transactions') as TxRow[];
    return accountId ? all.filter(t => t.account_id === accountId) : all.slice();
  }
  if (accountId) {
    return drv.select<TxRow>('SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC', [accountId]);
  }
  return drv.select<TxRow>('SELECT * FROM transactions ORDER BY date DESC');
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
  let inserted = 0;
  let skipped = 0;

  if (!isTauri()) {
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

  return { inserted, skipped };
}

// ── Settings (single-row key/value) ───────────────────────────
export async function getSetting(key: string): Promise<string | null> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    const rows = (drv as any).tableRead('settings') as { key: string; value: string }[];
    return rows.find(r => r.key === key)?.value ?? null;
  }
  const rows = await drv.select<{ value: string }>('SELECT value FROM settings WHERE key = ? LIMIT 1', [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await init();
  const drv = await getDriver();
  if (!isTauri()) {
    const rows = ((drv as any).tableRead('settings') as { key: string; value: string }[]).filter(r => r.key !== key);
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
  if (!isTauri()) {
    return (drv as any).tableRead('achievements').slice();
  }
  return drv.select('SELECT milestone_key, unlocked_at FROM achievements');
}

export async function unlockAchievement(key: string, contextJson = '{}'): Promise<void> {
  await init();
  const drv = await getDriver();
  const now = new Date().toISOString();
  if (!isTauri()) {
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
  const row: UserProfile = {
    name: profile.name ?? null,
    birth_year: profile.birthYear ?? null,
    target_retirement_age: profile.retireAge ?? null,
    expected_retirement_income: null,
    household_size: HOUSEHOLD_TO_SIZE[profile.household] ?? null,
  };
  if (!isTauri()) {
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
  if (!isTauri()) {
    const rows = (drv as any).tableRead('user_profile') as Array<{ id: number } & UserProfile>;
    if (!rows.length) return null;
    const { id: _id, ...rest } = rows[0];
    return rest;
  }
  const rows = await drv.select<UserProfile>(
    `SELECT name, birth_year, target_retirement_age, expected_retirement_income, household_size
       FROM user_profile WHERE id = 1 LIMIT 1`,
  );
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
  if (!isTauri()) {
    return ((drv as any).tableRead('scenarios') as ScenarioRow[]).slice();
  }
  return drv.select<ScenarioRow>('SELECT * FROM scenarios ORDER BY created_at ASC');
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

  if (!isTauri()) {
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
  await drv.exec(
    `INSERT INTO scenarios (name, inputs_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [name, JSON.stringify(inputs), now, now],
  );
}
