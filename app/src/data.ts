// Matmon domain types.
//
// This module USED to also export a hardcoded MATMON_DATA sample portfolio that
// fed the views before real account import existed. That sample is gone: every
// view now reads the user's real DB rows through buildPortfolio(). The static
// ACCOUNT_TYPES color/label catalog stays here because it isn't user data, it's
// metadata the renderer needs to color the donut slices and label the tiles.

export interface Account {
  id: string;
  name: string;
  brokerage: string;
  type: string;
  value: number;
  dayChange: number;
  /** Number of holdings in this account that lack today's prev_close data. */
  dayChangePending: number;
}

export interface AccountType {
  id: string;
  label: string;
  short: string;
  color: string;
}

export interface Holding {
  sym: string;
  name: string;
  qty: number;
  price: number;
  basis: number;
  sector: string;
  /**
   * Industry classification fetched from Yahoo's summaryProfile alongside
   * `sector`. The HoldingDetail header renders "[sector, industry, USD]"
   * once both fields have landed; the Holdings table only surfaces sector.
   * Empty string when no industry data is available yet.
   */
  industry?: string;
  account: string;
  value: number;
  cost: number;
  gain: number;
  gainPct: number;
  share: number;
  spark: number[];
  /**
   * Today's dollar change for this lot: `qty * (price - prevClose)`. Null
   * when the symbol has no prev_close on its latest price row, e.g. a
   * holdings-only import that hasn't had Refresh quotes clicked yet. The
   * BrokerageTile aggregator drops null contributions from the sum and
   * counts them toward the "(N symbols pending today's data)" footer.
   */
  dayChange: number | null;
  /**
   * Today's percent change for this lot: `(price - prevClose) / prevClose`.
   * Mirrors dayChange's null semantics.
   */
  dayChangePct: number | null;
  /**
   * Number of distinct accounts this symbol is held in. Only populated by
   * `aggregateHoldingsBySymbol`; for per-(account, symbol) holdings this is
   * undefined (the row already represents a single account by construction).
   * The Holdings view renders a "Held in N accounts" subtitle under the
   * symbol name when this is >= 2.
   */
  heldInAccounts?: number;
}

export interface ActivityItem {
  date: string;
  action: 'buy' | 'sell' | 'div';
  desc: string;
  account: string;
  amount: number;
}

export interface Achievement {
  key: string;
  glyph: string;
  title: string;
  copy: string;
  date?: string;
  unlocked: boolean;
  fresh?: boolean;
}

export interface SeriesPoint {
  date: Date;
  value: number;
}

export interface MatmonData {
  accounts: Account[];
  accountTypes: AccountType[];
  holdings: Holding[];
  activity: ActivityItem[];
  achievements: Achievement[];
  series: SeriesPoint[];
  spy: SeriesPoint[];
  totalValue: number;
  totalDayChange: number;
}

/**
 * Static catalog of account-type metadata. Color tokens feed the donut chart
 * and the type pills on every view; labels feed every "Traditional IRA" /
 * "Roth IRA" / "HSA" string in the UI. This list is the renderer's source of
 * truth, not user data, so it stays in src/ even though MATMON_DATA does not.
 */
export const ACCOUNT_TYPES: AccountType[] = [
  { id: 'taxable', label: 'Taxable', short: 'Taxable', color: 'oklch(0.560 0.075 110)' },
  { id: 'trad_ira', label: 'Traditional IRA', short: 'Trad IRA', color: 'oklch(0.450 0.040 60)' },
  { id: '401k', label: '401(k)', short: '401(k)', color: 'oklch(0.520 0.045 55)' },
  { id: 'roth_ira', label: 'Roth IRA', short: 'Roth IRA', color: 'oklch(0.720 0.090 75)' },
  { id: 'hsa', label: 'HSA', short: 'HSA', color: 'oklch(0.560 0.095 25)' },
];

/**
 * Initial empty MatmonData shape. Used by hooks/views as a placeholder before
 * the first DB read resolves. Real data flows in from buildPortfolio().
 */
export const EMPTY_MATMON_DATA: MatmonData = {
  accounts: [],
  accountTypes: ACCOUNT_TYPES,
  holdings: [],
  activity: [],
  achievements: [],
  series: [],
  spy: [],
  totalValue: 0,
  totalDayChange: 0,
};
