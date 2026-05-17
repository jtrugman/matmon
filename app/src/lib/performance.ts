// Performance math. Two industry-standard return calculations:
//
//   TWR  (time-weighted return)     — Removes the effect of deposits/withdrawals.
//                                     Standard for benchmarking against indices.
//   XIRR (money-weighted IRR)       — Internal rate of return given actual cash
//                                     flows. Answers "what did I actually earn?"
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

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

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
//   values  — chronological [{date, value}] of portfolio MV (e.g. month-end snapshots)
//   flows   — [{date, amount}] external contributions/withdrawals (NOT dividends
//             reinvested inside the account; those are internal)
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
  const years = days / 365;
  if (years < 1 / 12) return cumulativeTwr; // <1 month — don't annualize, too noisy
  return Math.pow(1 + cumulativeTwr, 1 / years) - 1;
}

// Convenience: returns the cash flows derived from a list of transactions
// for use with xirr (pairing them with a final +marketValue flow).
export function flowsFromTransactions(
  txs: Array<{ date: Date; action: string; quantity: number; price: number; fees: number; amount: number | null }>,
): CashFlow[] {
  const out: CashFlow[] = [];
  for (const t of txs) {
    let amt = t.amount ?? 0;
    if (amt === 0) {
      // Derive from qty * price for actions where amount column was blank.
      if (t.action === 'buy' || t.action === 'div_reinvest' || t.action === 'transfer_in') amt = -(t.quantity * t.price + t.fees);
      else if (t.action === 'sell' || t.action === 'transfer_out') amt = t.quantity * t.price - t.fees;
      else if (t.action === 'dividend' || t.action === 'interest') amt = 0; // internal, dropped below
    }
    // For XIRR we want EXTERNAL flows only: buys/sells/transfers/contributions/withdrawals.
    // Dividends and interest are internal income (they don't represent your money
    // going in or coming out of the account boundary).
    if (t.action === 'dividend' || t.action === 'div_reinvest' || t.action === 'interest') continue;
    if (amt === 0) continue;
    out.push({ date: t.date, amount: amt });
  }
  return out;
}
