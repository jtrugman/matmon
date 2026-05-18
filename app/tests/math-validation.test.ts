// Math validation against raw-CSV ground truth.
//
// For every example CSV in example_csv/, we:
//   1. Run importCsv() exactly the way App.tsx's finishOnboarding does
//      (insertAccount + insertTransactions + upsertPrice for marketPrices).
//   2. Call buildPortfolio() to get the user-facing numbers.
//   3. Assert per-symbol qty/cost/value match the ground-truth values that
//      were computed independently from the raw CSV by scripts/ground-truth.py.
//
// The ground-truth numbers below were calculated by hand-walking each CSV row
// using these rules (see scripts/ground-truth.py for the executable form):
//
//   - Buy: qty += quantity; cost += quantity * price + fees.
//   - Sell: avg = cost/qty; qty -= quantity; cost -= avg * quantity.
//   - Reinvest Shares / DRIP: treated as a buy.
//   - Plain dividend / interest: qty unchanged, cost unchanged.
//   - Fidelity DISTRIBUTION with Type=Shares: SHARE-based capital gains
//     distribution (the fund pays you in shares, not cash). qty up, cost up
//     by the Amount column. Per-share implicit price = Amount/Quantity.
//   - JPM holdings: each tax-lot is a transfer_in priced at Unit Cost.
//     Current market value uses the file's Price column.
//   - Empty/whitespace symbol becomes null (does not appear in distinct list).
//
// If any number drifts off the cent, the corresponding test fails and you
// know exactly which CSV / symbol / field broke. The numbers are pinned here
// rather than re-derived at test time so a bug in the importer can't sneak
// past by also being a bug in a shared ground-truth helper.

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importCsv } from '../src/lib/importers';
import {
  insertAccount,
  insertTransactions,
  upsertPrice,
  listAccounts,
  listTransactions,
  __resetReposForTests,
} from '../src/lib/db/repos';
import { __resetDriverForTests } from '../src/lib/db/driver';
import { buildPortfolio } from '../src/lib/portfolio';
import { slugifyAccountId } from '../src/lib/db/accountId';

const EXAMPLE_DIR = resolve(process.cwd(), 'example_csv');
const haveSingleFidelity = existsSync(resolve(EXAMPLE_DIR, 'single_account_fidelity.csv'));
const haveMultiFidelity = existsSync(resolve(EXAMPLE_DIR, 'multiple_accounts_fidelity.csv'));
const haveSchwabTx = existsSync(resolve(EXAMPLE_DIR, 'single_scwab_transactions.csv'));
const haveSchwabBalance = existsSync(resolve(EXAMPLE_DIR, 'schwab_single_account.CSV'));
const haveJpm = existsSync(resolve(EXAMPLE_DIR, 'jpm_multiple_accounts.csv'));

/** Per-symbol ground truth: [qty, cost, value]. Match within 0.01 USD. */
type GtSymbol = { qty: number; cost: number; value: number };

/** Per-file ground truth pinned from scripts/ground-truth.py. */
type Gt = {
  importerId: string;
  totalValue: number;
  totalCost: number;
  totalGain: number;
  /** Per-symbol expected numbers (aggregated across all accounts within the file). */
  perSymbol: Record<string, GtSymbol>;
  /** Distinct symbols (sorted ascending). */
  distinctSymbols: string[];
  /** Account count (the importer's `accountsDetected.length` or 1 for single). */
  nAccounts: number;
};

// NOTE: the "single-account Fidelity" ground truth was retired when Matmon
// switched to rejecting single-account exports at the import gate. The
// multi-account file covers both the Individual and HSA accounts in one
// fixture, so per-symbol math is fully exercised below; we no longer need
// a separate ground-truth snapshot for the single-account math path.

const GT_MULTI_FIDELITY: Gt = {
  importerId: 'fidelity',
  totalValue: 22673.0409,
  totalCost: 20324.2328,
  totalGain: 2348.808,
  perSymbol: {
    FDRXX: { qty: 0.35, cost: 0.35, value: 0.35 },
    FXAIX: { qty: 2.39, cost: 599.9847, value: 615.9747 },
    FZFXX: { qty: 0.21, cost: 0.21, value: 0.21 },
    // VGT: Individual side identical to single-account file (81.668 sh, $8408.04 cost).
    // HSA side: the 04/21 DISTRIBUTION row adds 112.014 shares at $11315.65.
    // Aggregate qty = 81.668 + 112.014 = 193.682. Cost = 8408.04 + 11315.65 = 19723.69.
    // Value at last price 113.88 (most recent across both accounts) = 193.682 * 113.88 = 22056.51.
    VGT: { qty: 193.682, cost: 19723.6882, value: 22056.5062 },
  },
  distinctSymbols: ['FDRXX', 'FXAIX', 'FZFXX', 'VGT'],
  nAccounts: 2,
};

const GT_SCHWAB_TX: Gt = {
  importerId: 'schwab',
  totalValue: 5.9514,
  totalCost: 6.2155,
  totalGain: -0.2641,
  perSymbol: {
    // Two reinvest-shares rows: 0.0053 @ 566.7997 + 0.0052 @ 617.5968.
    // cost = 0.0053 * 566.7997 + 0.0052 * 617.5968 = 3.0040 + 3.2115 = 6.2155
    // qty  = 0.0105; latest price by date is the 2026-03-27 reinvest @ 566.7997
    // value = 0.0105 * 566.7997 = 5.9514
    QQQ: { qty: 0.0105, cost: 6.2155, value: 5.9514 },
  },
  distinctSymbols: ['QQQ'],
  nAccounts: 1,
};

/** JPM holdings ground truth pinned from scripts/ground-truth.py. */
const GT_JPM: Gt = {
  importerId: 'jpmHoldings',
  totalValue: 707377.9263,
  totalCost: 354910.7619,
  totalGain: 352467.1644,
  perSymbol: {
    AMAXX: { qty: 6843.14, cost: 6843.14, value: 6843.14 },
    AMD: { qty: 91, cost: 8294.3, value: 38593.1 },
    FXAIX: { qty: 893.175, cost: 137804.4223, value: 230126.5387 },
    HCMC: { qty: 166766, cost: 0, value: 0 },
    HCWC: { qty: 2, cost: 0, value: 0.54 },
    PLTR: { qty: 414.5963, cost: 22738.5075, value: 55551.7569 },
    QACDS: { qty: 10348.23, cost: 10348.23, value: 10348.23 },
    QCOM: { qty: 24.0851, cost: 3814.6281, value: 4852.9008 },
    QDERQ: { qty: 59.27, cost: 59.27, value: 59.27 },
    QQQ: { qty: 22.6745, cost: 6922.6291, value: 16074.612 },
    RKLB: { qty: 206.8244, cost: 5090.2807, value: 25805.4779 },
    TSLA: { qty: 15, cost: 303.6, value: 6333.6 },
    VGT: { qty: 174.4458, cost: 6141.797, value: 19766.4491 },
    VITAX: { qty: 604.376, cost: 134073.707, value: 280545.2954 },
    VMRXX: { qty: 6433.13, cost: 6433.13, value: 6433.13 },
    VMSXX: { qty: 6039.82, cost: 6039.82, value: 6039.82 },
    VUG: { qty: 0.0465, cost: 3.3001, value: 4.0655 },
  },
  distinctSymbols: [
    'AMAXX',
    'AMD',
    'FXAIX',
    'HCMC',
    'HCWC',
    'PLTR',
    'QACDS',
    'QCOM',
    'QDERQ',
    'QQQ',
    'RKLB',
    'TSLA',
    'VGT',
    'VITAX',
    'VMRXX',
    'VMSXX',
    'VUG',
  ],
  nAccounts: 4,
};

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

type PortfolioSummary = {
  perSymbol: Record<string, { qty: number; cost: number; value: number; gain: number }>;
  distinctSymbols: string[];
  totalValue: number;
  totalCost: number;
  totalGain: number;
  nAccounts: number;
};

/** Run the full pipeline (importer → DB → buildPortfolio) and roll up the
 *  numbers in the same shape the GT_* constants pin. */
async function runPipeline(file: string): Promise<{
  importerId: string | null;
  rejectionReason?: string;
  marketPricesCount: number;
  unmappedActionStrings: string[];
  inferenceTransactionCount: number;
  summary?: PortfolioSummary;
}> {
  const csvText = readFileSync(resolve(EXAMPLE_DIR, file), 'utf8');
  const result = importCsv(csvText);
  if (result.rejectionReason) {
    return {
      importerId: result.importerId,
      rejectionReason: result.rejectionReason,
      marketPricesCount: 0,
      unmappedActionStrings: result.unmappedActionStrings,
      inferenceTransactionCount: result.inferences.transactionCount,
    };
  }

  const existingIds: string[] = [];
  const detected =
    result.accountsDetected && result.accountsDetected.length > 0
      ? result.accountsDetected
      : [
          {
            key: 'single',
            // For single-account files we just use the filename as the name; the
            // user picks a real name in the onboarding UI. The math doesn't
            // depend on the name string.
            name: file.replace(/\.csv$/i, ''),
            accountNumber: '',
            accountTypeHint: 'taxable' as const,
            transactions: result.transactions,
          },
        ];

  for (const acct of detected) {
    const id = slugifyAccountId(acct.name, result.inferences.brokerage, existingIds);
    existingIds.push(id);
    await insertAccount({
      id,
      name: acct.name,
      brokerage: result.inferences.brokerage,
      account_type: acct.accountTypeHint === 'unknown' ? 'taxable' : acct.accountTypeHint,
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await insertTransactions(id, acct.transactions);
  }
  if (result.marketPrices) {
    for (const mp of result.marketPrices) {
      await upsertPrice(mp.symbol, mp.asOf, mp.price);
    }
  }

  const p = await buildPortfolio();

  const perSymbol: PortfolioSummary['perSymbol'] = {};
  const distinct = new Set<string>();
  for (const h of p.holdings) {
    if (h.qty <= 0) continue;
    distinct.add(h.sym);
    if (!perSymbol[h.sym]) perSymbol[h.sym] = { qty: 0, cost: 0, value: 0, gain: 0 };
    perSymbol[h.sym].qty += h.qty;
    perSymbol[h.sym].cost += h.cost;
    perSymbol[h.sym].value += h.value;
  }
  for (const sym of Object.keys(perSymbol)) {
    perSymbol[sym].qty = round4(perSymbol[sym].qty);
    perSymbol[sym].cost = round4(perSymbol[sym].cost);
    perSymbol[sym].value = round4(perSymbol[sym].value);
    perSymbol[sym].gain = round4(perSymbol[sym].value - perSymbol[sym].cost);
  }

  const dbAccounts = await listAccounts();
  const dbTxs = await listTransactions();
  // Sanity: DB row counts line up with what the importer detected.
  if (dbAccounts.length !== detected.length) {
    throw new Error(`DB account count ${dbAccounts.length} != detected ${detected.length}`);
  }
  if (dbTxs.length === 0) throw new Error('DB has zero transactions after import');

  return {
    importerId: result.importerId,
    marketPricesCount: result.marketPrices?.length ?? 0,
    unmappedActionStrings: result.unmappedActionStrings,
    inferenceTransactionCount: result.inferences.transactionCount,
    summary: {
      perSymbol,
      distinctSymbols: [...distinct].sort(),
      totalValue: round4(p.totalValue),
      totalCost: round4(Object.values(perSymbol).reduce((s, v) => s + v.cost, 0)),
      totalGain: round4(p.totalValue - Object.values(perSymbol).reduce((s, v) => s + v.cost, 0)),
      nAccounts: dbAccounts.length,
    },
  };
}

/** Assert every line item in the ground truth matches the actual output to
 *  the cent. Reports the FIRST mismatch with full context so you can see what
 *  drifted without grep-ing through a JSON diff. */
function expectMatchesGroundTruth(gt: Gt, file: string, importerId: string | null, summary: PortfolioSummary) {
  expect(importerId, `${file}: wrong importer`).toBe(gt.importerId);
  expect(summary.nAccounts, `${file}: account count`).toBe(gt.nAccounts);
  expect(summary.distinctSymbols, `${file}: distinct symbols`).toEqual(gt.distinctSymbols);

  for (const sym of gt.distinctSymbols) {
    const exp = gt.perSymbol[sym];
    const act = summary.perSymbol[sym];
    expect(act, `${file}: missing holding for ${sym}`).toBeTruthy();
    // qty exact-ish: 4dp is plenty for share counts (largest fractional
    // qty in our CSVs is 0.317 of a share).
    expect(act.qty, `${file}: ${sym} qty`).toBeCloseTo(exp.qty, 3);
    // cost / value: within $0.01 of ground truth.
    expect(act.cost, `${file}: ${sym} cost basis`).toBeCloseTo(exp.cost, 2);
    expect(act.value, `${file}: ${sym} value`).toBeCloseTo(exp.value, 2);
    expect(act.gain, `${file}: ${sym} gain`).toBeCloseTo(exp.value - exp.cost, 2);
  }

  expect(summary.totalValue, `${file}: total value`).toBeCloseTo(gt.totalValue, 2);
  expect(summary.totalCost, `${file}: total cost`).toBeCloseTo(gt.totalCost, 2);
  expect(summary.totalGain, `${file}: total gain`).toBeCloseTo(gt.totalGain, 2);
}

beforeEach(() => {
  __resetDriverForTests();
  __resetReposForTests();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

/** Side-channel for audit work: every run writes a JSON dump of the actual
 *  app numbers to /tmp/app-output.json so scripts/diff-audit.py can compare
 *  against ground-truth.py output. The tests themselves do the cent-by-cent
 *  comparison; this file is just a convenience artifact. */
const auditDump: Record<string, unknown> = {};

describe('Brokerage math validation against raw-CSV ground truth', () => {
  // The "single-account Fidelity math" case is now obsolete: Matmon ONLY
  // accepts the Fidelity multi-account transaction-history export. Single-
  // account exports omit the Account Number column entirely (the field we
  // use as a dedup fingerprint), so they're rejected at the import gate
  // with a user-facing message pointing the user at the "All Accounts"
  // download option in Fidelity's UI. The multi-account file covers both
  // account flows in one fixture, so per-symbol math is fully covered by
  // the multi-account case below; we keep a thin assertion here just to
  // pin the rejection behavior for the real example file.
  (haveSingleFidelity ? it : it.skip)(
    'single_account_fidelity.csv: rejected at import gate with wrong-fidelity-export kind',
    async () => {
      const r = await runPipeline('single_account_fidelity.csv');
      expect(r.summary, 'rejected files do not produce a summary').toBeUndefined();
      expect(r.importerId).toBeNull();
      expect(r.rejectionReason).toBeDefined();
      expect(r.rejectionReason!).toMatch(/multi-account export/i);
      expect(r.rejectionReason!).toMatch(/All Accounts/);
      auditDump.singleFidelity = { rejected: true, reason: r.rejectionReason };
    },
  );

  (haveMultiFidelity ? it : it.skip)(
    'multiple_accounts_fidelity.csv: Individual + HSA roll up to the right per-symbol totals',
    async () => {
      const r = await runPipeline('multiple_accounts_fidelity.csv');
      expect(r.summary).toBeDefined();
      expectMatchesGroundTruth(GT_MULTI_FIDELITY, 'multiple_accounts_fidelity.csv', r.importerId, r.summary!);
      expect(r.unmappedActionStrings).toEqual([]);
      expect(r.inferenceTransactionCount).toBe(22);
      auditDump.multiFidelity = { importerId: r.importerId, ...r.summary };
    },
  );

  (haveSchwabTx ? it : it.skip)(
    'single_scwab_transactions.csv: DRIP shares accumulate, dividends do not pollute',
    async () => {
      const r = await runPipeline('single_scwab_transactions.csv');
      expect(r.summary).toBeDefined();
      expectMatchesGroundTruth(GT_SCHWAB_TX, 'single_scwab_transactions.csv', r.importerId, r.summary!);
      expect(r.unmappedActionStrings).toEqual([]);
      expect(r.inferenceTransactionCount).toBe(6);
      auditDump.schwabTx = { importerId: r.importerId, ...r.summary };
    },
  );

  (haveSchwabBalance ? it : it.skip)(
    'schwab_single_account.CSV: balance/positions export is rejected with a helpful message',
    async () => {
      const r = await runPipeline('schwab_single_account.CSV');
      expect(r.importerId).toBeNull();
      expect(r.rejectionReason).toBeDefined();
      expect(r.rejectionReason!.toLowerCase()).toMatch(/balance|position/);
      auditDump.schwabBalance = { rejected: true, reason: r.rejectionReason };
    },
  );

  (haveJpm ? it : it.skip)(
    'jpm_multiple_accounts.csv: market value uses Price column not Unit Cost; all 17 tickers match',
    async () => {
      const r = await runPipeline('jpm_multiple_accounts.csv');
      expect(r.summary).toBeDefined();
      // Sanity: marketPrices array must be populated for portfolio.ts to value
      // positions at market rather than at cost. If this number drops to zero
      // the JPM gain regression is back.
      expect(r.marketPricesCount).toBeGreaterThan(0);
      expectMatchesGroundTruth(GT_JPM, 'jpm_multiple_accounts.csv', r.importerId, r.summary!);
      expect(r.unmappedActionStrings).toEqual([]);
      auditDump.jpm = { importerId: r.importerId, ...r.summary };
    },
  );

  it('writes audit dump to /tmp/app-output.json (side artifact for scripts/diff-audit.py)', () => {
    writeFileSync('/tmp/app-output.json', JSON.stringify(auditDump, null, 2));
    expect(Object.keys(auditDump).length).toBeGreaterThan(0);
  });
});
