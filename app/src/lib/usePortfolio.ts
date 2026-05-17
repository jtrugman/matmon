import { useCallback, useEffect, useState } from 'react';
import { MATMON_DATA, type MatmonData } from '../data';
import { buildPortfolio, refreshQuotes } from './portfolio';
import { seedDemoIfEmpty } from './db/seed';
import { unlockNew } from './milestones';
import { loadUserProfile } from './db/repos';

export function usePortfolio(): {
  data: MatmonData;
  loading: boolean;
  reload: () => Promise<void>;
  refreshLivePrices: () => Promise<void>;
  /** Most recently fired milestone keys (FIFO). App.tsx reads and clears. */
  newUnlocks: string[];
  clearNewUnlocks: () => void;
  /** First name from user_profile, or null pre-onboarding. Views can fall back. */
  userName: string | null;
} {
  const [data, setData] = useState<MatmonData>(MATMON_DATA);
  const [loading, setLoading] = useState(true);
  const [newUnlocks, setNewUnlocks] = useState<string[]>([]);
  const [userName, setUserName] = useState<string | null>(null);

  const runMilestoneWatcher = useCallback(async (built: MatmonData) => {
    try {
      const fired = await unlockNew(built.holdings, built.totalValue);
      if (fired.length) setNewUnlocks(prev => [...prev, ...fired]);
    } catch {
      // Milestone detection is best-effort. Never block the UI on a watcher failure.
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      await seedDemoIfEmpty();
      const built = await buildPortfolio();
      setData(built);
      const profile = await loadUserProfile().catch(() => null);
      // First word of the saved name; falls back to 'Justin' for the demo data.
      const first = profile?.name?.trim().split(/\s+/)[0] || null;
      setUserName(first);
      await runMilestoneWatcher(built);
    } finally {
      setLoading(false);
    }
  }, [runMilestoneWatcher]);

  const refreshLivePrices = useCallback(async () => {
    const syms = Array.from(new Set(data.holdings.map(h => h.sym))).filter(s => s && s !== 'SPAXX');
    if (syms.length === 0) return;
    try {
      await refreshQuotes(syms);
      const rebuilt = await buildPortfolio();
      setData(rebuilt);
      await runMilestoneWatcher(rebuilt);
    } catch {
      // Surface failures via the network log; never block the UI on a Yahoo blip.
    }
  }, [data.holdings, runMilestoneWatcher]);

  const clearNewUnlocks = useCallback(() => setNewUnlocks([]), []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, reload, refreshLivePrices, newUnlocks, clearNewUnlocks, userName };
}
