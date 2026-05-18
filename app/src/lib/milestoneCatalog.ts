// Single source of truth for the Matmon milestone catalog.
//
// PRD §10 lists 28 starter milestones. This file mirrors that list one-to-one,
// adds presentation metadata (glyph, title, copy, category) the Achievements
// view renders, and exposes a `thresholdValue` for portfolio-value milestones
// so "Coming up next" can compute a real "% to go".
//
// The runtime watcher in `milestones.ts` imports `WATCHED_MILESTONE_KEYS` from
// here so the two stay in sync. Milestones we don't yet know how to detect
// (beat_spy_1y, survived_drawdown, maxed_ira, maxed_401k, hsa_covered,
// first_scenario) are still listed in the catalog so the UI can present them
// as "ahead" silhouettes, but they are not part of the watcher's key set.
//
// `hidden_1` is a placeholder for a future surprise milestone. It is rendered
// as a "?" silhouette and never auto-unlocks.

export type MilestoneCategory =
  | 'value'
  | 'activity'
  | 'dividends'
  | 'tenure'
  | 'discipline'
  | 'planning'
  | 'secret';

export interface MilestoneCatalogEntry {
  key: string;
  glyph: string;
  title: string;
  copy: string;
  category: MilestoneCategory;
  /** Human-readable trigger description, shown on "Coming up next" silhouettes. */
  description: string;
  /** Portfolio-value milestones only. Used to compute "% to go". */
  thresholdValue?: number;
  /** True for hidden / surprise milestones. The view masks the glyph and title. */
  secret?: boolean;
}

// Order here is the stable display order for non-value silhouettes.
export const MILESTONE_CATALOG: MilestoneCatalogEntry[] = [
  // ── Portfolio value thresholds ─────────────────────────────────────────
  {
    key: 'first_1k',
    glyph: '◦',
    title: 'Four digits',
    copy: 'The journey of a thousand miles, etc.',
    category: 'value',
    description: 'Portfolio crosses $1,000',
    thresholdValue: 1_000,
  },
  {
    key: 'first_10k',
    glyph: '◆',
    title: 'Five digits',
    copy: 'Reasonable people would call this serious money.',
    category: 'value',
    description: 'Portfolio crosses $10,000',
    thresholdValue: 10_000,
  },
  {
    key: 'first_100k',
    glyph: '◈',
    title: 'Six digits',
    copy: 'Go tell someone you trust. They will be happy for you.',
    category: 'value',
    description: 'Portfolio crosses $100,000',
    thresholdValue: 100_000,
  },
  {
    key: 'first_500k',
    glyph: '◉',
    title: 'Half a million',
    copy: 'Behold, the power of compounding.',
    category: 'value',
    description: 'Portfolio crosses $500,000',
    thresholdValue: 500_000,
  },
  {
    key: 'first_million',
    glyph: '☉',
    title: 'A millionaire',
    copy: 'Go buy your mom some flowers.',
    category: 'value',
    description: 'Portfolio crosses $1,000,000',
    thresholdValue: 1_000_000,
  },
  {
    key: 'two_million',
    glyph: '☉',
    title: 'Two commas',
    copy: "Two commas, going on three. Don't get weird about it.",
    category: 'value',
    description: 'Portfolio crosses $2,000,000',
    thresholdValue: 2_000_000,
  },
  {
    key: 'five_million',
    glyph: '✦',
    title: 'Five million',
    copy: "Quietly, you've crossed a line most people never see.",
    category: 'value',
    description: 'Portfolio crosses $5,000,000',
    thresholdValue: 5_000_000,
  },
  {
    key: 'ten_million',
    glyph: '✧',
    title: 'Eight digits',
    copy: 'We assume you have a guy for this now. Just along for the ride.',
    category: 'value',
    description: 'Portfolio crosses $10,000,000',
    thresholdValue: 10_000_000,
  },
  {
    key: 'twenty_five_million',
    glyph: '✺',
    title: 'Twenty-five million',
    copy: "The 'family office' phrase starts getting whispered.",
    category: 'value',
    description: 'Portfolio crosses $25,000,000',
    thresholdValue: 25_000_000,
  },
  {
    key: 'fifty_million',
    glyph: '❖',
    title: 'Fifty million',
    copy: "Statistically, you're the wealthiest person in most rooms.",
    category: 'value',
    description: 'Portfolio crosses $50,000,000',
    thresholdValue: 50_000_000,
  },
  {
    key: 'hundred_million',
    glyph: '❈',
    title: 'Nine digits',
    copy: 'Hi. Please be kind to people.',
    category: 'value',
    description: 'Portfolio crosses $100,000,000',
    thresholdValue: 100_000_000,
  },
  {
    key: 'quarter_billion',
    glyph: '✪',
    title: 'A quarter of a billion',
    copy: 'The IRS has a dedicated form just for you now.',
    category: 'value',
    description: 'Portfolio crosses $250,000,000',
    thresholdValue: 250_000_000,
  },
  {
    key: 'half_billion',
    glyph: '✸',
    title: 'Half a billion',
    copy: "We're not sure what to say. Proud of you, in a confused way.",
    category: 'value',
    description: 'Portfolio crosses $500,000,000',
    thresholdValue: 500_000_000,
  },
  {
    key: 'first_billion',
    glyph: '✹',
    title: 'A billion dollars',
    copy: 'Maybe found a hospital wing. Maybe stay anonymous. Your call.',
    category: 'value',
    description: 'Portfolio crosses $1,000,000,000',
    thresholdValue: 1_000_000_000,
  },

  // ── Activity ──────────────────────────────────────────────────────────
  {
    key: 'first_import',
    glyph: '✦',
    title: 'Welcome aboard',
    copy: 'First CSV imported. Your numbers are your own again.',
    category: 'activity',
    description: 'Import your first CSV',
  },
  {
    key: '100_transactions',
    glyph: '◇',
    title: 'A regular',
    copy: "100 transactions. You're officially a regular.",
    category: 'activity',
    description: 'Log 100 transactions',
  },

  // ── Dividends ─────────────────────────────────────────────────────────
  {
    key: 'first_dividend',
    glyph: '✿',
    title: 'First dividend',
    copy: "Your money just made money. That's the whole game.",
    category: 'dividends',
    description: 'Receive your first dividend',
  },
  {
    key: '100_in_dividends',
    glyph: '❀',
    title: '$100 in dividends',
    copy: 'Coffee for a month, on the house.',
    category: 'dividends',
    description: 'Earn $100 in lifetime dividends',
  },
  {
    key: '1k_in_dividends',
    glyph: '❁',
    title: '$1,000 in dividends',
    copy: 'A small but steady stream forms.',
    category: 'dividends',
    description: 'Earn $1,000 in lifetime dividends',
  },

  // ── Tenure ────────────────────────────────────────────────────────────
  {
    key: 'one_year_in',
    glyph: '⊙',
    title: 'One year on the books',
    copy: "Now we can actually talk about 'returns.'",
    category: 'tenure',
    description: 'One full year of tracking',
  },
  {
    key: 'five_years_in',
    glyph: '⌾',
    title: 'Five years',
    copy: "You've earned the right to make 'when I was your age' jokes.",
    category: 'tenure',
    description: 'Five full years of tracking',
  },

  // ── Discipline ────────────────────────────────────────────────────────
  {
    key: 'diversified',
    glyph: '✤',
    title: 'Spread the eggs',
    copy: '10 holdings, 3 sectors. Not putting all of them in one basket.',
    category: 'discipline',
    description: '10+ holdings across 3+ sectors',
  },
  {
    key: 'beat_spy_1y',
    glyph: '↗',
    title: 'Beat the S&P',
    copy: 'You beat the S&P 500 this year. The bogleheads are seething (lovingly).',
    category: 'discipline',
    description: 'TWR beats SPY over a calendar year',
  },
  {
    key: 'survived_drawdown',
    glyph: '⌇',
    title: 'Held through a dip',
    copy: "Down 10% and you held. That's the part nobody tells you about.",
    category: 'discipline',
    description: 'Hold through a 10%+ drawdown',
  },

  // ── Planning ──────────────────────────────────────────────────────────
  {
    key: 'maxed_ira',
    glyph: '♆',
    title: 'IRA maxed',
    copy: 'Future you sends thanks.',
    category: 'planning',
    description: 'Max an IRA in a given tax year',
  },
  {
    key: 'maxed_401k',
    glyph: '♅',
    title: '401(k) maxed',
    copy: "That's the big one.",
    category: 'planning',
    description: 'Max a 401(k) in a given tax year',
  },
  {
    key: 'hsa_covered',
    glyph: '⚕',
    title: 'HSA covers healthcare',
    copy: 'Triple-tax-advantaged at work.',
    category: 'planning',
    description: 'Projected HSA covers retirement healthcare',
  },
  {
    key: 'first_scenario',
    glyph: '◐',
    title: 'First scenario',
    copy: "You're thinking ahead. Suits you.",
    category: 'planning',
    description: 'Save your first retirement scenario',
  },

  // ── Secret / hidden ───────────────────────────────────────────────────
  {
    key: 'hidden_1',
    glyph: '★',
    title: 'Hidden ahead',
    copy: 'A surprise is part of the fun.',
    category: 'secret',
    description: 'A surprise is part of the fun.',
    secret: true,
  },
];

/** Quick lookup by key. */
export const MILESTONE_BY_KEY: Record<string, MilestoneCatalogEntry> = Object.fromEntries(
  MILESTONE_CATALOG.map(m => [m.key, m]),
);

/**
 * Keys the runtime watcher knows how to detect today. This is the subset of the
 * catalog that has a concrete trigger implemented in `milestones.ts`. The watcher
 * imports this list so adding a new detectable milestone is one place to edit.
 *
 * Catalog entries that are NOT in this list show up as silhouettes only — they
 * become detectable once we wire up the underlying signal.
 */
export const WATCHED_MILESTONE_KEYS: ReadonlySet<string> = new Set([
  // Value
  'first_1k',
  'first_10k',
  'first_100k',
  'first_500k',
  'first_million',
  'two_million',
  'five_million',
  'ten_million',
  'twenty_five_million',
  'fifty_million',
  'hundred_million',
  'quarter_billion',
  'half_billion',
  'first_billion',
  // Activity
  'first_import',
  '100_transactions',
  // Dividends
  'first_dividend',
  '100_in_dividends',
  '1k_in_dividends',
  // Discipline
  'diversified',
  // Tenure
  'one_year_in',
  'five_years_in',
]);
