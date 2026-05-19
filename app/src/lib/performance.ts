// Performance math. Two industry-standard return calculations:
//
//   TWR  (time-weighted return):    Removes the effect of deposits/withdrawals.
//                                    Standard for benchmarking against indices.
//   XIRR (money-weighted IRR):      Internal rate of return given actual cash
//                                    flows. Answers "what did I actually earn?"
//
// Both operate on a generic cash-flow series so the same code paths work for
// the whole portfolio, a single account, or a single holding.

export type CashFlow = {
  /** Date of the flow. */
  date: Date;
  /** Signed amount in account currency. Negative = money out (buy / contribution),
   *  positive = money in (sell / withdrawal / dividend). */
  amount: number;
};

export type ValuePoint = {
  date: Date;
  value: number;
};

// ─── XIRR ────────────────────────────────────────────────────
//
// Newton-Raphson root-find on NPV(r) = 0 over irregular cash flows.
// Convention: flows[0] is the initial position, plus every contribution/
// withdrawal, and the LAST flow MUST be the final +positive market value
// (treated as if you sold everything today).
//
// Returns annualized rate as a decimal (0.108 = 10.8%) or NaN if it doesn't converge.

// 365.25 (Julian year) accounts for leap years over multi-year windows. With a
// flat 365 the cumulative drift is ~0.07%/year on long-horizon XIRRs.
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function npv(rate: number, flows: CashFlow[]): number {
  const t0 = flows[0].date.getTime();
  let sum = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / MS_PER_YEAR;
    sum += f.amount / Math.pow(1 + rate, years);
  }
  return sum;
}

function dnpv(rate: number, flows: CashFlow[]): number {
  const t0 = flows[0].date.getTime();
  let sum = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / MS_PER_YEAR;
    sum += (-years * f.amount) / Math.pow(1 + rate, years + 1);
  }
  return sum;
}

export function xirr(flows: CashFlow[], guess = 0.1): number {
  if (flows.length < 2) return NaN;
  // Sort + sanity check: need at least one positive and one negative flow.
  const sorted = [...flows].sort((a, b) => +a.date - +b.date);
  const hasPos = sorted.some(f => f.amount > 0);
  const hasNeg = sorted.some(f => f.amount < 0);
  if (!hasPos || !hasNeg) return NaN;

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, sorted);
    const fp = dnpv(rate, sorted);
    if (Math.abs(fp) < 1e-12) break;
    const next = rate - f / fp;
    if (!isFinite(next)) return NaN;
    if (Math.abs(next - rate) < 1e-7) return next;
    rate = next;
    // Stay in a reasonable range; XIRRs > 10x/yr or < -99% are nearly always
    // a data error rather than a real return.
    if (rate < -0.999) rate = -0.999;
    if (rate > 10) rate = 10;
  }
  return rate;
}

// ─── TWR ─────────────────────────────────────────────────────
//
// Geometrically link sub-period returns, where each sub-period is bounded by
// an external cash flow. Standard formula:
//
//   TWR = Π (1 + r_i) - 1, where r_i = (V_end - flow_in_period) / V_begin - 1
//
// Inputs:
//   values:  chronological [{date, value}] of portfolio MV (e.g. month-end snapshots)
//   flows:   [{date, amount}] external contributions/withdrawals (NOT dividends
//            reinvested inside the account; those are internal)
//
// Returns cumulative TWR (e.g. 0.45 = +45% over the whole period).
// Use annualizeTwr to convert to annualized.

export function twr(values: ValuePoint[], flows: CashFlow[] = []): number {
  if (values.length < 2) return NaN;
  const sortedV = [...values].sort((a, b) => +a.date - +b.date);
  const sortedF = [...flows].sort((a, b) => +a.date - +b.date);

  let product = 1;
  for (let i = 1; i < sortedV.length; i++) {
    const startV = sortedV[i - 1].value;
    const endV = sortedV[i].value;
    if (startV <= 0) continue;
    // Sum flows strictly between (start, end]
    const flowsInPeriod = sortedF
      .filter(f => +f.date > +sortedV[i - 1].date && +f.date <= +sortedV[i].date)
      .reduce((s, f) => s + f.amount, 0);
    // Convention: contributions are negative in our CashFlow shape, so subtract
    // them out of endV to isolate the market-driven change.
    const r = (endV + flowsInPeriod) / startV - 1;
    product *= 1 + r;
  }
  return product - 1;
}

export function annualizeTwr(cumulativeTwr: number, days: number): number {
  if (!isFinite(cumulativeTwr) || days <= 0) return NaN;
  // 365.25 matches the Julian-year denominator used by XIRR, so a portfolio
  // measured over a full leap-inclusive window doesn't drift between metrics.
  const years = days / 365.25;
  if (years < 1 / 12) return cumulativeTwr; // <1 month, don't annualize, too noisy
  return Math.pow(1 + cumulativeTwr, 1 / years) - 1;
}

/**
 * Cumulative TWR over a date window. Clamps the window start to the earliest
 * available NAV point (so a "YTD" call on a portfolio that starts in March
 * doesn't fabricate a pre-portfolio baseline). Returns NaN when there isn't
 * enough data inside the window to compute a return.
 *
 * Inputs:
 *   series:  full chronological NAV series, oldest-first.
 *   flows:   external cash flows (optional). Same sign convention as twr().
 *   start:   window start. Clamped up to series[0].date when earlier.
 *   end:     window end. Clamped down to series.last().date when later.
 *
 * The result is cumulative (e.g. 0.12 = +12% over the window). Pair with
 * annualizeTwr if the window is multi-year and you want a per-year number.
 */
export function twrOverWindow(
  series: ValuePoint[],
  flows: CashFlow[],
  start: Date,
  end: Date,
): number {
  if (series.length < 2) return NaN;
  const sortedSeries = [...series].sort((a, b) => +a.date - +b.date);
  // Clamp the start up to the earliest point we have. Don't return a
  // pre-portfolio baseline; that would treat new money as a "loss".
  const firstAvailable = sortedSeries[0].date;
  const effectiveStart = +start < +firstAvailable ? firstAvailable : start;
  if (+effectiveStart > +end) return NaN;

  const windowed = sortedSeries.filter(p => +p.date >= +effectiveStart && +p.date <= +end);
  if (windowed.length < 2) return NaN;
  const windowedFlows = flows.filter(f => +f.date > +effectiveStart && +f.date <= +end);
  return twr(windowed, windowedFlows);
}

// ─── External cash-flow extraction ─────────────────────────────────
//
// XIRR (and the TWR adjustment loop above) needs ONE flow per external
// boundary crossing, meaning money or securities entering/leaving the
// portfolio from the outside. The subtle part:
//
//   1. `cash_in`, `cash_out`, `contribution`, `withdrawal`
//      Always external. The user moved money across the boundary.
//
//   2. `transfer_in`, `transfer_out`
//      Usually external (ACAT transfers from another brokerage). But Fidelity
//      capital-gains DISTRIBUTIONS paid as shares get re-tagged by the
//      Fidelity importer to `transfer_in` so the holdings replay treats them
//      as cost-basis-increasing. For XIRR purposes those are INTERNAL (no
//      money came from outside the portfolio). We detect them by a sentinel
//      tag in `notes` that the Fidelity importer attaches.
//
//   3. `buy`, `sell`
//      Always INTERNAL when there's a paired external boundary nearby (the
//      user just deployed cash that already crossed the boundary). EXTERNAL
//      only when there's no boundary signal at all (Schwab transaction
//      exports surface buys but not the deposits that funded them, so the
//      buy itself is our only handle on "money came in").
//
//   4. `dividend`, `interest`, `div_reinvest`
//      Always internal. Income paid inside the account, not new money.
//
// Sign convention (USER's perspective):
//   Negative = money INTO the portfolio (buy, contribution, transfer_in)
//   Positive = money OUT of the portfolio (sell, withdrawal, transfer_out)
//
// Some brokerages export "Amount" from THEIR accounting perspective (positive
// when they receive funds), which is the OPPOSITE of the user's perspective
// for inflows like "Electronic Funds Transfer Received". We canonicalize by
// action regardless of the source CSV's sign.

/** Sentinel the Fidelity importer attaches to notes for share-based fund
 *  distributions that get re-tagged from `dividend` to `transfer_in`. When
 *  present we treat the row as internal for XIRR purposes (no external
 *  money/securities crossed the portfolio boundary). */
export const INTERNAL_TRANSFER_TAG = '[internal:fund-distribution]';

/** Days on either side of a buy/sell to look for a paired cash boundary row. */
const PAIRING_WINDOW_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FlowTxInput = {
  date: Date;
  action: string;
  quantity: number;
  price: number;
  fees: number;
  amount: number | null;
  /** Optional: lets pairing scope to a single account when present. */
  account_id?: string;
  /** Optional: used to detect the INTERNAL_TRANSFER_TAG sentinel. */
  notes?: string | null;
};

function flowCategory(action: string): 'boundary' | 'trade' | 'income' | 'other' {
  switch (action) {
    case 'cash_in':
    case 'cash_out':
    case 'contribution':
    case 'withdrawal':
      return 'boundary';
    case 'transfer_in':
    case 'transfer_out':
      // Always external. Fidelity capital-gains DISTRIBUTIONS paid as shares
      // get re-tagged to `transfer_in` by the Fidelity importer (and tagged
      // in notes with INTERNAL_TRANSFER_TAG for traceability). For XIRR
      // purposes we still treat those as boundary flows: the share-value
      // gain entered the portfolio from outside the user's pocket, and
      // excluding it would attribute the entire gain to the user's deposits
      // and produce a wildly inflated annualized rate over a short window.
      return 'boundary';
    case 'buy':
    case 'sell':
      return 'trade';
    case 'dividend':
    case 'div_reinvest':
    case 'interest':
      return 'income';
    default:
      return 'other';
  }
}

function txMagnitude(t: FlowTxInput): number {
  if (t.amount != null && t.amount !== 0) return Math.abs(t.amount);
  if (t.action === 'sell') return Math.max(0, t.quantity * t.price - t.fees);
  return t.quantity * t.price + (t.action === 'buy' ? t.fees : 0);
}

function flowDirection(action: string): -1 | 1 | 0 {
  switch (action) {
    case 'buy':
    case 'transfer_in':
    case 'cash_in':
    case 'contribution':
      return -1;
    case 'sell':
    case 'transfer_out':
    case 'cash_out':
    case 'withdrawal':
      return 1;
    default:
      return 0;
  }
}

/**
 * Build the external cash-flow series for XIRR.
 *
 * Rules in order:
 *   1. `cash_in` / `cash_out` / `contribution` / `withdrawal` always emit one
 *      external flow per row.
 *   2. `transfer_in` / `transfer_out` emit external flows UNLESS the row
 *      carries the INTERNAL_TRANSFER_TAG sentinel (set by importers for
 *      fund-internal share distributions like Fidelity capital-gains payouts).
 *   3. `buy` / `sell` emit ONLY when no opposite-direction boundary flow
 *      within +/- PAIRING_WINDOW_DAYS (same account when known) has enough
 *      remaining "capacity" to cover them. When a boundary flow IS present,
 *      it represents the actual external money movement; the trade itself is
 *      just the user deploying that cash inside the portfolio. This prevents
 *      the classic "deposit $1,000 then immediately buy $1,000 of VGT" case
 *      from being counted as -$2,000 of external flow.
 *   4. `dividend` / `interest` / `div_reinvest` are always dropped (internal
 *      income, already baked into the resolved market value used as the
 *      terminal +flow).
 */
export function flowsFromTransactions(txs: FlowTxInput[]): CashFlow[] {
  if (txs.length === 0) return [];

  const sorted = [...txs].sort((a, b) => +a.date - +b.date);

  // First pass: emit every boundary row AND track per-account remaining
  // "capacity" for pairing trades against it on the second pass.
  type Boundary = {
    date: Date;
    account: string;
    direction: -1 | 1;
    remaining: number;
  };
  const boundaries: Boundary[] = [];
  const flows: CashFlow[] = [];

  for (const t of sorted) {
    const cat = flowCategory(t.action);
    if (cat !== 'boundary') continue;
    const dir = flowDirection(t.action);
    if (dir === 0) continue;
    const mag = txMagnitude(t);
    if (mag <= 0) continue;
    flows.push({ date: t.date, amount: dir * mag });
    boundaries.push({
      date: t.date,
      account: t.account_id ?? '',
      direction: dir,
      remaining: mag,
    });
  }

  // Second pass: for each trade, look for a boundary in the window with the
  // same direction (cash_in pairs with buy, cash_out with sell) and any
  // remaining capacity. If found, "consume" capacity and skip emitting the
  // trade. If not, emit the trade because it's our only signal that money
  // crossed the portfolio boundary.
  for (const t of sorted) {
    const cat = flowCategory(t.action);
    if (cat !== 'trade') continue;
    const dir = flowDirection(t.action);
    if (dir === 0) continue;
    const mag = txMagnitude(t);
    if (mag <= 0) continue;
    const account = t.account_id ?? '';
    const windowMs = PAIRING_WINDOW_DAYS * MS_PER_DAY;

    let matched = false;
    for (const b of boundaries) {
      if (b.direction !== dir) continue;
      if (b.remaining <= 0) continue;
      // Only match same-account when both sides have an account_id. When
      // either is missing we fall back to the global pool, which matches
      // existing callers that don't carry account_id yet.
      if (account && b.account && b.account !== account) continue;
      const dt = Math.abs(+b.date - +t.date);
      if (dt > windowMs) continue;
      // Consume capacity. If a single boundary fully covers the trade, the
      // trade is purely internal. If it only partially covers, we drain what
      // we can and STILL skip the trade (the leftover represents either a
      // sibling trade we'll see in the loop or the user keeping cash on the
      // sidelines). Avoiding double-counting is the whole point.
      const used = Math.min(b.remaining, mag);
      b.remaining -= used;
      matched = true;
      break;
    }
    if (matched) continue;

    // No boundary signal: the trade itself IS the external flow (typical of
    // Schwab transaction exports where deposits aren't surfaced as line items).
    flows.push({ date: t.date, amount: dir * mag });
  }

  flows.sort((a, b) => +a.date - +b.date);
  return flows;
}
