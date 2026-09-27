// Matmon demo portfolio data
// Late-career persona, ~$1.21M across 6 accounts. Just crossed $1M.

export interface Account {
  id: string;
  name: string;
  brokerage: string;
  type: string;
  value: number;
  dayChange: number;
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
  account: string;
  value: number;
  cost: number;
  gain: number;
  gainPct: number;
  share: number;
  spark: number[];
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

const ACCOUNTS: Account[] = [
  { id: 'fid-tax',  name: 'Fidelity Taxable',          brokerage: 'Fidelity',  type: 'taxable',  value: 385420.18, dayChange: 2421.55 },
  { id: 'jpm-401k', name: 'JP Morgan 401(k)',          brokerage: 'JP Morgan', type: '401k',     value: 312940.62, dayChange: -1218.04 },
  { id: 'fid-ira',  name: 'Fidelity Traditional IRA',  brokerage: 'Fidelity',  type: 'trad_ira', value: 245830.91, dayChange: -512.18 },
  { id: 'van-roth', name: 'Vanguard Roth IRA',         brokerage: 'Vanguard',  type: 'roth_ira', value: 178650.44, dayChange:  842.71 },
  { id: 'sch-hsa',  name: 'Schwab HSA',                brokerage: 'Schwab',    type: 'hsa',      value:  48720.55, dayChange: -287.30 },
  { id: 'sch-tax',  name: 'Schwab Joint Taxable',      brokerage: 'Schwab',    type: 'taxable',  value:  34890.12, dayChange:   98.42 },
];

const TOTAL_VALUE = ACCOUNTS.reduce((s, a) => s + a.value, 0);
const TOTAL_DAY_CHG = ACCOUNTS.reduce((s, a) => s + a.dayChange, 0);

const ACCOUNT_TYPES: AccountType[] = [
  { id: 'taxable',  label: 'Taxable',          short: 'Taxable',    color: 'oklch(0.560 0.075 110)' },
  { id: 'trad_ira', label: 'Traditional IRA',  short: 'Trad IRA',   color: 'oklch(0.450 0.040 60)' },
  { id: '401k',     label: '401(k)',           short: '401(k)',     color: 'oklch(0.520 0.045 55)' },
  { id: 'roth_ira', label: 'Roth IRA',         short: 'Roth IRA',   color: 'oklch(0.720 0.090 75)' },
  { id: 'hsa',      label: 'HSA',              short: 'HSA',        color: 'oklch(0.560 0.095 25)' },
];

const RAW_HOLDINGS = [
  { sym: 'VTI',   name: 'Vanguard Total Stock Market ETF',  qty: 1840.42, price: 318.45, basis: 168.20, sector: 'US Total Mkt',  account: 'fid-tax'  },
  { sym: 'VXUS',  name: 'Vanguard Total Intl Stock ETF',    qty: 1620.10, price:  72.18, basis:  78.40, sector: 'Intl Equity',   account: 'fid-tax'  },
  { sym: 'VOO',   name: 'Vanguard S&P 500 ETF',             qty:  612.55, price: 558.20, basis: 340.18, sector: 'US Large Cap',  account: 'jpm-401k' },
  { sym: 'BND',   name: 'Vanguard Total Bond Market ETF',   qty: 1820.00, price:  73.15, basis:  78.40, sector: 'US Bonds',      account: 'jpm-401k' },
  { sym: 'AAPL',  name: 'Apple Inc.',                       qty:  420.00, price: 248.30, basis:  88.50, sector: 'Technology',    account: 'fid-tax'  },
  { sym: 'MSFT',  name: 'Microsoft Corp.',                  qty:  245.00, price: 502.60, basis: 192.40, sector: 'Technology',    account: 'fid-ira'  },
  { sym: 'GOOGL', name: 'Alphabet Inc. Class A',            qty:  312.00, price: 218.40, basis:  95.60, sector: 'Technology',    account: 'fid-ira'  },
  { sym: 'BRK.B', name: 'Berkshire Hathaway Class B',       qty:  180.00, price: 542.10, basis: 298.20, sector: 'Financials',    account: 'van-roth' },
  { sym: 'VYM',   name: 'Vanguard High Dividend Yield ETF', qty:  612.00, price: 142.50, basis:  98.40, sector: 'Dividend',      account: 'van-roth' },
  { sym: 'COST',  name: 'Costco Wholesale Corp.',           qty:   52.00, price: 962.40, basis: 410.20, sector: 'Consumer Stpl', account: 'fid-ira'  },
  { sym: 'JEPI',  name: 'JPMorgan Equity Premium Income',   qty:  420.00, price:  62.40, basis:  68.20, sector: 'Dividend',      account: 'sch-hsa'  },
  { sym: 'SPAXX', name: 'Fidelity Govt Money Market',       qty:14820.55, price:   1.00, basis:   1.00, sector: 'Cash',          account: 'fid-tax'  },
];

function spark(seed: number, vol = 1): number[] {
  const pts: number[] = [];
  let v = 50;
  for (let i = 0; i < 24; i++) {
    const n = Math.sin(i * 0.7 + seed) * 6 * vol + Math.cos(i * 0.3 + seed * 2) * 4 * vol;
    v = Math.max(20, Math.min(80, v + n * 0.4));
    pts.push(v);
  }
  return pts;
}

const HOLDINGS: Holding[] = RAW_HOLDINGS.map((h, i) => {
  const value = h.qty * h.price;
  const cost = h.qty * h.basis;
  const gain = value - cost;
  const gainPct = gain / cost;
  return {
    ...h,
    value,
    cost,
    gain,
    gainPct,
    share: value / TOTAL_VALUE,
    spark: spark(i + 1, gainPct > 0 ? 1 : 0.7),
  };
});

const ACTIVITY: ActivityItem[] = [
  { date: 'May 14', action: 'div',  desc: 'VTI · Dividend received',     account: 'Fidelity Taxable',  amount:  1620.42 },
  { date: 'May 12', action: 'buy',  desc: 'VOO · 4 shares @ $556.18',    account: 'JP Morgan 401(k)',  amount: -2224.72 },
  { date: 'May 09', action: 'div',  desc: 'VYM · Dividend received',     account: 'Vanguard Roth IRA', amount:   428.40 },
  { date: 'May 06', action: 'buy',  desc: 'BND · 12 shares @ $72.94',    account: 'JP Morgan 401(k)',  amount:  -875.28 },
  { date: 'May 02', action: 'div',  desc: 'AAPL · Dividend received',    account: 'Fidelity Taxable',  amount:   104.30 },
  { date: 'Apr 29', action: 'sell', desc: 'JEPI · 30 shares @ $61.84',   account: 'Schwab HSA',        amount:  1855.20 },
];

const ACHIEVEMENTS: Achievement[] = [
  { key: 'first_import',     glyph: '✦', title: 'Welcome aboard',         copy: 'First CSV imported. Your numbers are your own again.', date: 'Jun 12, 2018', unlocked: true },
  { key: 'first_10k',        glyph: '◆', title: 'Five digits',             copy: 'Crossed $10,000. Reasonable people would call this serious money.', date: 'Aug 03, 2018', unlocked: true },
  { key: 'first_100k',       glyph: '◈', title: 'Six digits',              copy: 'Crossed $100,000. Go tell someone you trust.', date: 'Mar 21, 2021', unlocked: true },
  { key: 'one_year_in',      glyph: '⊙', title: 'One year on the books',  copy: 'Now we can actually talk about returns.', date: 'Jun 12, 2019', unlocked: true },
  { key: 'first_dividend',   glyph: '✿', title: 'First dividend',          copy: 'Your money just made money. The whole game.', date: 'Sep 28, 2018', unlocked: true },
  { key: 'first_1k_div',     glyph: '✿', title: '$1,000 in dividends',     copy: 'A small but steady stream forms.', date: 'Feb 14, 2020', unlocked: true },
  { key: 'survived_drawdown',glyph: '⌇', title: 'Survived a drawdown',     copy: 'Down 10% and you held. The part nobody tells you about.', date: 'Apr 04, 2020', unlocked: true },
  { key: 'beat_spy_1y',      glyph: '↗', title: 'Beat the S&P',            copy: '2023: beat the S&P 500. The bogleheads are seething (lovingly).', date: 'Dec 31, 2023', unlocked: true },
  { key: 'first_500k',       glyph: '◉', title: 'Half a million',          copy: 'Behold, the power of compounding.', date: 'Nov 09, 2023', unlocked: true },
  { key: 'diversified',      glyph: '✤', title: 'Spread the eggs',         copy: '10 holdings across 3+ sectors.', date: 'Jul 22, 2022', unlocked: true },
  { key: 'maxed_ira',        glyph: '♆', title: 'IRA maxed',               copy: 'Future you sends thanks.', date: 'Apr 12, 2024', unlocked: true },
  { key: 'five_years_in',    glyph: '⌾', title: 'Five years on the books', copy: 'You’ve earned the right to make "when I was your age" jokes.', date: 'Jun 12, 2023', unlocked: true },
  { key: 'first_million',    glyph: '☉', title: 'A millionaire',           copy: 'Go buy your mom some flowers.', date: 'May 17, 2026', unlocked: true, fresh: true },
  { key: 'maxed_401k',       glyph: '♅', title: '401(k) maxed',            copy: 'That’s the big one.', unlocked: false },
  { key: 'two_million',      glyph: '☉', title: 'Two commas, going on three', copy: '...', unlocked: false },
  { key: 'hsa_covered',      glyph: '⚕', title: 'HSA covers retirement healthcare', copy: '...', unlocked: false },
];

function buildPortfolioSeries(): SeriesPoint[] {
  const months = 72;
  const data: SeriesPoint[] = [];
  const path = [
    0.260, 0.245, 0.225, 0.255, 0.280, 0.295, 0.310, 0.325, 0.330, 0.345, 0.360, 0.380,
    0.395, 0.405, 0.420, 0.435, 0.450, 0.470, 0.485, 0.495, 0.515, 0.530, 0.548, 0.560,
    0.555, 0.540, 0.510, 0.475, 0.490, 0.475, 0.460, 0.490, 0.470, 0.495, 0.520, 0.540,
    0.560, 0.585, 0.610, 0.640, 0.665, 0.690, 0.720, 0.740, 0.760, 0.790, 0.820, 0.860,
    0.890, 0.910, 0.928, 0.945, 0.952, 0.970, 0.985, 0.998, 1.010, 1.020, 1.045, 1.062,
    1.075, 1.092, 1.085, 1.108, 1.130, 1.145, 1.160, 1.170, 1.182, 1.188, 1.196, 1.205,
  ];
  const startDate = new Date(2020, 5, 1);
  for (let i = 0; i < months; i++) {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + i);
    data.push({ date: d, value: path[i] * 1_000_000 });
  }
  data.push({ date: new Date(2026, 4, 17), value: TOTAL_VALUE });
  return data;
}

function buildBenchmarkSeries(portfolio: SeriesPoint[]): SeriesPoint[] {
  const path = [
    1.00, 0.97, 0.89, 1.02, 1.10, 1.15, 1.20, 1.24, 1.25, 1.30, 1.32, 1.36,
    1.38, 1.39, 1.42, 1.44, 1.46, 1.49, 1.52, 1.50, 1.55, 1.58, 1.62, 1.66,
    1.64, 1.58, 1.50, 1.42, 1.46, 1.40, 1.35, 1.42, 1.36, 1.40, 1.46, 1.52,
    1.56, 1.60, 1.64, 1.68, 1.72, 1.78, 1.82, 1.84, 1.86, 1.90, 1.96, 2.02,
    2.06, 2.10, 2.12, 2.14, 2.18, 2.22, 2.24, 2.26, 2.28, 2.30, 2.34, 2.36,
    2.38, 2.40, 2.42, 2.44, 2.46, 2.48, 2.50, 2.52, 2.54, 2.55, 2.57, 2.58,
  ];
  const start = portfolio[0].value;
  return portfolio.map((p, i) => ({
    date: p.date,
    value: start * (path[i] ?? path[path.length - 1]),
  }));
}

const PORTFOLIO_SERIES = buildPortfolioSeries();
const SPY_SERIES = buildBenchmarkSeries(PORTFOLIO_SERIES);

export const MATMON_DATA: MatmonData = {
  accounts: ACCOUNTS,
  accountTypes: ACCOUNT_TYPES,
  holdings: HOLDINGS,
  activity: ACTIVITY,
  achievements: ACHIEVEMENTS,
  series: PORTFOLIO_SERIES,
  spy: SPY_SERIES,
  totalValue: TOTAL_VALUE,
  totalDayChange: TOTAL_DAY_CHG,
};
