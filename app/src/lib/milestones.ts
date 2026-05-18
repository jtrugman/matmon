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
// `milestoneCatalog.ts` (the catalog is the source of truth); the entries here
// just bind each watched key to its trigger function. A constructor-time guard
// at the bottom of this file blows up loudly if the two ever drift.
const ALL_DEFS: MilestoneDef[] = [
  // Portfolio value thresholds (PRD §10)
  { key: 'first_1k', check: valueAtLeast(1_000) },
  { key: 'first_10k', check: valueAtLeast(10_000) },
  { key: 'first_100k', check: valueAtLeast(100_000) },
  { key: 'first_500k', check: valueAtLeast(500_000) },
  { key: 'first_million', check: valueAtLeast(1_000_000) },
  { key: 'two_million', check: valueAtLeast(2_000_000) },
  { key: 'five_million', check: valueAtLeast(5_000_000) },
  { key: 'ten_million', check: valueAtLeast(10_000_000) },
  { key: 'twenty_five_million', check: valueAtLeast(25_000_000) },
  { key: 'fifty_million', check: valueAtLeast(50_000_000) },
  { key: 'hundred_million', check: valueAtLeast(100_000_000) },
  { key: 'quarter_billion', check: valueAtLeast(250_000_000) },
  { key: 'half_billion', check: valueAtLeast(500_000_000) },
  { key: 'first_billion', check: valueAtLeast(1_000_000_000) },

  // Activity milestones
  { key: 'first_import', check: s => s.accountCount >= 1 },
  { key: '100_transactions', check: s => s.transactionCount >= 100 },

  // Dividend milestones
  { key: 'first_dividend', check: s => s.dividendCount >= 1 },
  { key: '100_in_dividends', check: s => s.dividendTotal >= 100 },
  { key: '1k_in_dividends', check: s => s.dividendTotal >= 1_000 },

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
// Dedupe window for pairing a `dividend` (cash payout) with its same-symbol
// `div_reinvest` (the reinvestment of that exact cash). Fidelity and a few
// others emit BOTH rows for a single income event: the cash dividend on one
// line, the share purchase on the next. Counting both would double the
// dividendTotal. Three days is generous enough to cover settlement timing
// while staying tight enough to avoid colliding with the next month's payout.
const DIVIDEND_PAIR_WINDOW_DAYS = 3;
const DIVIDEND_PAIR_TOLERANCE = 0.5;
const MS_PER_DAY_MILESTONES = 24 * 60 * 60 * 1000;

/**
 * Sum dividend income while AVOIDING the double-count when a brokerage emits
 * a paired (cash dividend, reinvestment) for the same income event.
 *
 * Rule (the "why" comment that's load-bearing, do not delete):
 *   - Every `dividend` row contributes its magnitude to the total.
 *   - A `div_reinvest` row contributes ONLY IF there's no matching
 *     `dividend` row within +/- DIVIDEND_PAIR_WINDOW_DAYS for the same
 *     symbol whose magnitude matches within DIVIDEND_PAIR_TOLERANCE.
 *   - When a `div_reinvest` appears alone (e.g. some brokerages collapse the
 *     two-row pattern into the share-purchase row only), the reinvestment IS
 *     the only signal of income and DOES count.
 *
 * Returns the dedupe-applied total along with the (also dedupe-applied) count
 * so the "first dividend" milestone fires on real income events, not on the
 * brokerage's accounting artifacts.
 */
export function tallyDividends(
  txs: { date: string; action: string; symbol: string | null; quantity: number; price: number; amount: number | null }[],
): { dividendCount: number; dividendTotal: number } {
  const dividendRows: { date: number; symbol: string; magnitude: number; consumed: boolean }[] = [];
  for (const t of txs) {
    if (t.action !== 'dividend') continue;
    const d = new Date(t.date).getTime();
    if (Number.isNaN(d)) continue;
    const sym = t.symbol ?? '';
    const magnitude = t.amount != null ? Math.abs(t.amount) : t.quantity * t.price;
    dividendRows.push({ date: d, symbol: sym, magnitude, consumed: false });
  }

  let dividendCount = 0;
  let dividendTotal = 0;
  const windowMs = DIVIDEND_PAIR_WINDOW_DAYS * MS_PER_DAY_MILESTONES;

  // First pass: every dividend row counts.
  for (const row of dividendRows) {
    dividendCount += 1;
    dividendTotal += row.magnitude;
  }

  // Second pass: each div_reinvest counts ONLY if no matching dividend is
  // nearby (same symbol, similar magnitude). Otherwise the dividend already
  // captured the same income event.
  for (const t of txs) {
    if (t.action !== 'div_reinvest') continue;
    const d = new Date(t.date).getTime();
    if (Number.isNaN(d)) continue;
    const sym = t.symbol ?? '';
    const magnitude = t.amount != null ? Math.abs(t.amount) : t.quantity * t.price;
    if (magnitude <= 0) continue;

    const matched = dividendRows.find(
      r =>
        !r.consumed &&
        r.symbol === sym &&
        Math.abs(r.date - d) <= windowMs &&
        Math.abs(r.magnitude - magnitude) <= DIVIDEND_PAIR_TOLERANCE,
    );
    if (matched) {
      matched.consumed = true;
      continue;
    }
    // Orphan reinvestment: no paired dividend row, so this IS the only
    // signal of dividend income for this event.
    dividendCount += 1;
    dividendTotal += magnitude;
  }

  return { dividendCount, dividendTotal };
}

export async function collectPortfolioState(
  holdings: Holding[],
  totalValue: number,
  now: Date = new Date(),
): Promise<PortfolioState> {
  const [accounts, txs] = await Promise.all([listAccounts(), listTransactions()]);

  const { dividendCount, dividendTotal } = tallyDividends(txs);

  let oldest: Date | null = null;
  for (const t of txs) {
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
export async function unlockNew(
  holdings: Holding[],
  totalValue: number,
  now: Date = new Date(),
): Promise<string[]> {
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
