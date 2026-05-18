import { describe, expect, it } from 'vitest';
import { isDemoMode, leaveDemoMode, requestDemoSeed, seedDemoIfEmpty } from '../src/lib/db/seed';
import { listAccounts, listTransactions } from '../src/lib/db/repos';

describe('Demo seed (opt-in)', () => {
  it('seeds nothing without an explicit opt-in (default for real users)', async () => {
    expect(await listAccounts()).toHaveLength(0);
    await seedDemoIfEmpty();
    expect(await listAccounts()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);
  });

  it('seeds accounts + transactions once the user opts in', async () => {
    await requestDemoSeed();
    await seedDemoIfEmpty();
    const accounts = await listAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    const txs = await listTransactions();
    expect(txs.length).toBeGreaterThan(0);
  });

  it('second seed call is a no-op (idempotent flag)', async () => {
    await requestDemoSeed();
    await seedDemoIfEmpty();
    const firstCount = (await listTransactions()).length;
    await seedDemoIfEmpty();
    const secondCount = (await listTransactions()).length;
    expect(secondCount).toBe(firstCount);
  });

  it('demoMode flag flips from yes to no on leaveDemoMode', async () => {
    await requestDemoSeed();
    await seedDemoIfEmpty();
    expect(await isDemoMode()).toBe(true);
    await leaveDemoMode();
    expect(await isDemoMode()).toBe(false);
  });
});
