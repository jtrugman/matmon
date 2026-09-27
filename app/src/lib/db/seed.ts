// First-run seeding. On a clean DB we drop in the demo portfolio so the user has
// something to look at, with a flag that the rest of the app uses to switch from
// "real" labels to "demo" labels.

import { getSetting, insertAccount, insertTransactions, setSetting } from './repos';
import { MATMON_DATA } from '../../data';
import type { ParsedTransaction } from '../importers/types';
import { generateTransactions } from '../transactions';

const SEEDED_KEY = 'seeded.v1';
const DEMO_OPT_IN_KEY = 'demoOptIn.v1';

/**
 * Mark that the user explicitly asked for demo data (clicked "Try with a sample
 * portfolio" in onboarding). Without this flag, real users get a clean install.
 */
export async function requestDemoSeed(): Promise<void> {
  await setSetting(DEMO_OPT_IN_KEY, 'yes');
}

export async function seedDemoIfEmpty(): Promise<void> {
  const flagged = await getSetting(SEEDED_KEY);
  if (flagged === 'yes') return;
  // Real users only get the demo seed if they explicitly opted in via onboarding.
  // First run with no opt-in → empty DB, app shows onboarding then real-account flow.
  const optIn = await getSetting(DEMO_OPT_IN_KEY);
  if (optIn !== 'yes') return;

  for (const a of MATMON_DATA.accounts) {
    await insertAccount({
      id: a.id,
      name: a.name,
      brokerage: a.brokerage,
      account_type: a.type,
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
  }

  // Convert the generator's "DemoTx" shape into ParsedTransaction so the same
  // dedupe/storage path is exercised end to end.
  const txs = generateTransactions(MATMON_DATA);
  const byAccount = new Map<string, ParsedTransaction[]>();
  for (const t of txs) {
    if (!byAccount.has(t.accountId)) byAccount.set(t.accountId, []);
    byAccount.get(t.accountId)!.push({
      date: t.date,
      symbol: t.symbol,
      action: t.action === 'div' ? 'dividend' : (t.action as ParsedTransaction['action']),
      quantity: t.qty,
      price: t.price,
      fees: t.fees,
      amount: t.amount ?? null,
      currency: 'USD',
      notes: t.notes,
      rawHash: `demo-${t.id}`,
    });
  }
  for (const [accountId, list] of byAccount) {
    await insertTransactions(accountId, list);
  }

  await setSetting(SEEDED_KEY, 'yes');
  await setSetting('demoMode', 'yes');
}

export async function isDemoMode(): Promise<boolean> {
  return (await getSetting('demoMode')) === 'yes';
}

export async function leaveDemoMode(): Promise<void> {
  await setSetting('demoMode', 'no');
}

/** Account ids that the demo seed creates. Used by clearDemoData() to remove
 *  ONLY the seed without touching real accounts the user has imported. */
export const DEMO_ACCOUNT_IDS = ['fid-tax', 'jpm-401k', 'fid-ira', 'van-roth', 'sch-hsa', 'sch-tax'];

/**
 * Remove the seeded demo accounts + their transactions while leaving any
 * real accounts the user imported alone. Sets seeded.v1 so it won't re-seed
 * on the next launch.
 */
export async function clearDemoData(): Promise<void> {
  const { deleteAccount } = await import('./repos');
  for (const id of DEMO_ACCOUNT_IDS) {
    await deleteAccount(id);
  }
  await setSetting('demoMode', 'no');
  await setSetting('seeded.v1', 'yes'); // prevent re-seed on next launch
}
