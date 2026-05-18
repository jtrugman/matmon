// Milestone watcher. Runs after every portfolio refresh, compares the current
// portfolio against each milestone trigger, and unlocks any newly-met ones.
//
// The catalog mirrors PRD §10. Pure value-threshold milestones are computed
// from `state.totalValue`. Counting-style milestones (`100_transactions`,
// `first_import`, `first_dividend`, etc.) look at the raw transactions /
// accounts the caller passes in. Diversification looks at the aggregated
// holdings with their `sector` field.
//
// Deferred for a later pass (need extra signals we don't have yet):
//   - beat_spy_1y      (needs calendar-year TWR vs SPY)
//   - survived_drawdown (needs drawdown tracking + "held through" detection)
//   - maxed_ira         (needs per-tax-year contribution rollup against IRS limits)
//   - maxed_401k        (same)
//   - hsa_covered       (needs Planner projection output)
//
// These are intentionally left out of MILESTONE_DEFS so the watcher stays
// honest about what it actually knows how to detect.

import { listAccounts, listAchievements, listTransactions, unlockAchievement } from './db/repos';
import type { Holding } from '../data';
import { WATCHED_MILESTONE_KEYS } from './milestoneCatalog';

/** Shape the milestone checks read from. Built by `collectPortfolioState`. */
export interface PortfolioState {
  totalValue: number;
  holdings: Holding[];
  /** Total transaction row count across all accounts. */
  transactionCount: number;
  /** Number of stored accounts (used by first_import). */
  accountCount: number;
  /** Count of transactions whose action is `dividend`. */
  dividendCount: number;
  /** Sum of dividend amounts (uses `amount` field, falls back to qty * price). */
  dividendTotal: number;
  /** Oldest transaction date across all accounts, or null if none. */
  oldestTransactionDate: Date | null;
  /** "Today" for date math. Injectable so tests can pin the clock. */
  now: Date;
}

export interface MilestoneDef {
  key: string;
  check: (state: PortfolioState) => boolean;
}

const valueAtLeast = (threshold: number) => (s: PortfolioState) => s.totalValue >= threshold;

const yearsBetween = (older: Date, newer: Date): number => {
  const ms = newer.getTime() - older.getTime();
  return ms / (1000 * 60 * 60 * 24 * 365.25);
};

// All detectable milestones. Keys MUST appear in `WATCHED_MILESTONE_KEYS` from
// `milestoneCatalog.ts` — the catalog is the source of truth; the entries here
// just bind each watched key to its trigger function. A constructor-time guard
// at the bottom of this file blows up loudly if the two ever drift.
const ALL_DEFS: MilestoneDef[] = [
  // Portfolio value thresholds (PRD §10)
  { key: 'first_1k',            check: valueAtLeast(1_000) },
  { key: 'first_10k',           check: valueAtLeast(10_000) },
  { key: 'first_100k',          check: valueAtLeast(100_000) },
  { key: 'first_500k',          check: valueAtLeast(500_000) },
  { key: 'first_million',       check: valueAtLeast(1_000_000) },
  { key: 'two_million',         check: valueAtLeast(2_000_000) },
  { key: 'five_million',        check: valueAtLeast(5_000_000) },
  { key: 'ten_million',         check: valueAtLeast(10_000_000) },
  { key: 'twenty_five_million', check: valueAtLeast(25_000_000) },
  { key: 'fifty_million',       check: valueAtLeast(50_000_000) },
  { key: 'hundred_million',     check: valueAtLeast(100_000_000) },
  { key: 'quarter_billion',     check: valueAtLeast(250_000_000) },
  { key: 'half_billion',        check: valueAtLeast(500_000_000) },
  { key: 'first_billion',       check: valueAtLeast(1_000_000_000) },

  // Activity milestones
  { key: 'first_import',        check: s => s.accountCount >= 1 },
  { key: '100_transactions',    check: s => s.transactionCount >= 100 },

  // Dividend milestones
  { key: 'first_dividend',      check: s => s.dividendCount >= 1 },
  { key: '100_in_dividends',    check: s => s.dividendTotal >= 100 },
  { key: '1k_in_dividends',     check: s => s.dividendTotal >= 1_000 },

  // Diversification: 10+ holdings across 3+ distinct sectors
  {
    key: 'diversified',
    check: s => {
      if (s.holdings.length < 10) return false;
      const sectors = new Set(s.holdings.map(h => h.sector).filter(Boolean));
      return sectors.size >= 3;
    },
  },

  // Tenure milestones, gated on the oldest transaction we've seen.
  {
    key: 'one_year_in',
    check: s => (s.oldestTransactionDate ? yearsBetween(s.oldestTransactionDate, s.now) >= 1 : false),
  },
  {
    key: 'five_years_in',
    check: s => (s.oldestTransactionDate ? yearsBetween(s.oldestTransactionDate, s.now) >= 5 : false),
  },
];

// Only include defs whose key is in the catalog's watched set. This guarantees
// the watcher never fires for a milestone the UI doesn't know how to render.
export const MILESTONE_DEFS: MilestoneDef[] = ALL_DEFS.filter(d => WATCHED_MILESTONE_KEYS.has(d.key));

// Dev-time sanity check: every watched key in the catalog should have a def here.
// If someone adds a new key to `WATCHED_MILESTONE_KEYS` without wiring a trigger,
// fail fast at module load so we don't ship a silently-broken milestone.
{
  const defined = new Set(MILESTONE_DEFS.map(d => d.key));
  const missing = Array.from(WATCHED_MILESTONE_KEYS).filter(k => !defined.has(k));
  if (missing.length) {
    throw new Error(
      `[milestones] WATCHED_MILESTONE_KEYS includes keys with no trigger: ${missing.join(', ')}`,
    );
  }
}

/** Pure function the tests pin against. Returns keys whose `check` is now true and aren't already unlocked. */
export function detectNewUnlocks(state: PortfolioState, alreadyUnlocked: Set<string>): string[] {
  const fired: string[] = [];
  for (const def of MILESTONE_DEFS) {
    if (alreadyUnlocked.has(def.key)) continue;
    if (def.check(state)) fired.push(def.key);
  }
  return fired;
}

/**
 * Collects the inputs the milestone checks need from the DB + the already-built
 * portfolio. Centralized here so the React hook just calls one function.
 */
export async function collectPortfolioState(holdings: Holding[], totalValue: number, now: Date = new Date()): Promise<PortfolioState> {
  const [accounts, txs] = await Promise.all([listAccounts(), listTransactions()]);

  let dividendCount = 0;
  let dividendTotal = 0;
  let oldest: Date | null = null;

  for (const t of txs) {
    if (t.action === 'dividend' || t.action === 'div_reinvest') {
      dividendCount += 1;
      // Dividends record either an `amount` (cash payout) or qty*price (reinvest).
      const amt = t.amount != null ? Math.abs(t.amount) : t.quantity * t.price;
      dividendTotal += amt;
    }
    const d = new Date(t.date);
    if (!Number.isNaN(d.getTime())) {
      if (oldest === null || d < oldest) oldest = d;
    }
  }

  return {
    totalValue,
    holdings,
    transactionCount: txs.length,
    accountCount: accounts.length,
    dividendCount,
    dividendTotal,
    oldestTransactionDate: oldest,
    now,
  };
}

/**
 * High-level entry point: gathers state, finds new unlocks, persists them, returns the keys that fired.
 * The hook calls this; the App uses the returned key to fire the milestone toast.
 */
export async function unlockNew(holdings: Holding[], totalValue: number, now: Date = new Date()): Promise<string[]> {
  const [state, existing] = await Promise.all([
    collectPortfolioState(holdings, totalValue, now),
    listAchievements(),
  ]);
  const already = new Set(existing.map(e => e.milestone_key));
  const newly = detectNewUnlocks(state, already);

  for (const key of newly) {
    await unlockAchievement(
      key,
      JSON.stringify({ totalValue: state.totalValue, at: state.now.toISOString() }),
    );
  }

  return newly;
}
