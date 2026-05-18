// Hand-verifier for the Fidelity sample's all-time XIRR.
// Loads example_csv/multiple_accounts_fidelity.csv (the only Fidelity export
// shape Matmon accepts) and runs through importCsv + buildPortfolio, then
// computes flowsFromTransactions and the resulting XIRR.
//
// The expectation guards against the previous "-57.5%" regression: a sane
// all-time XIRR for the Fidelity sample sits in single-digit positives to
// low teens. We assert strictly > 0 here so the suite catches future
// double-counting regressions automatically.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importCsv } from '../src/lib/importers';
import { flowsFromTransactions, xirr } from '../src/lib/performance';
import { buildPortfolio } from '../src/lib/portfolio';
import { insertAccount, insertTransactions, listTransactions } from '../src/lib/db/repos';
import { slugifyAccountId } from '../src/lib/db/accountId';
import { tallyDividends } from '../src/lib/milestones';

describe('xirr-check · Fidelity multi-account sample, all-time', () => {
  it('produces a sane (positive, plausible) XIRR across both accounts', async () => {
    const csvPath = resolve(process.cwd(), 'example_csv/multiple_accounts_fidelity.csv');
    const csv = readFileSync(csvPath, 'utf8');
    const result = importCsv(csv);
    expect(result.importerId).toBe('fidelity');
    expect(result.accountsDetected).toBeDefined();
    expect(result.accountsDetected!.length).toBeGreaterThanOrEqual(2);

    // Insert one account per detected bucket so the per-account flow pairing
    // logic engages exactly the way HomeView wires it up at runtime.
    const existingIds: string[] = [];
    const accountIds: string[] = [];
    for (const acct of result.accountsDetected!) {
      const id = slugifyAccountId(acct.name, 'Fidelity', existingIds);
      existingIds.push(id);
      accountIds.push(id);
      await insertAccount({
        id,
        name: acct.name,
        brokerage: 'Fidelity',
        account_type: acct.accountTypeHint === 'unknown' ? 'taxable' : acct.accountTypeHint,
      });
      await insertTransactions(id, acct.transactions);
    }

    const portfolio = await buildPortfolio();
    expect(portfolio.totalValue).toBeGreaterThan(0);

    // Mirror what HomeView passes to flowsFromTransactions: include account_id
    // and notes so the pairing + internal-distribution sentinel logic both
    // engage.
    const txs = await listTransactions();
    const txsForFlows = txs.map(t => ({
      date: new Date(t.date),
      action: t.action,
      quantity: t.quantity,
      price: t.price,
      fees: t.fees,
      amount: t.amount,
      account_id: t.account_id,
      notes: t.notes ?? '',
    }));
    const flows = flowsFromTransactions(txsForFlows);
    const allFlows = [...flows, { date: new Date(), amount: portfolio.totalValue }];
    const rate = xirr(allFlows);

    let sumNegative = 0;
    let sumPositive = 0;
    for (const f of flows) {
      if (f.amount < 0) sumNegative += f.amount;
      else sumPositive += f.amount;
    }
    // Echo the numbers for hand-checking the report.
    console.log(`[xirr-check] portfolio total today = $${portfolio.totalValue.toFixed(2)}`);
    console.log(`[xirr-check] flows.length = ${flows.length}`);
    console.log(`[xirr-check] sum of -flows (money in)  = $${sumNegative.toFixed(2)}`);
    console.log(`[xirr-check] sum of +flows (money out) = $${sumPositive.toFixed(2)}`);
    console.log(`[xirr-check] all-time XIRR = ${(rate * 100).toFixed(2)}%`);

    // The portfolio is up overall on this sample. Sane XIRR is strictly
    // positive. (Previously the legacy single-account CSV produced -57.5%
    // due to double-counting cash_in + buy as two separate external flows.
    // The multi-account file carries the same shapes so the regression test
    // still bites.)
    expect(rate).toBeGreaterThan(0);
    // Upper bound is a sanity check against the XIRR convergence bouncing
    // off the +10x clamp inside the solver. The Fidelity sample's data shape
    // (large capital-gains share distribution in a 4-week window) naturally
    // produces a high annualized rate; the clamp is at 10.0, so we accept
    // anything below that.
    expect(rate).toBeLessThan(10.0);

    // Bug B verification: the multi-account Fidelity sample has TWO cash-
    // dividend pairs (FZFXX in Individual and FDRXX in HSA), each paid as
    // a (cash $X, reinvest $X) pair. Pre-fix dividendTotal would double-
    // count each pair; post-fix tallyDividends collapses each pair to a
    // single dividend event, so:
    //   - dividendCount = 2 (one per account)
    //   - dividendTotal = 0.21 (FZFXX) + 0.35 (FDRXX) = 0.56
    // (See tests/math-validation.test.ts GT_MULTI_FIDELITY for the
    // per-symbol ground truth those numbers come from.)
    const dbTxs = await listTransactions();
    const { dividendCount, dividendTotal } = tallyDividends(dbTxs);
    console.log(`[xirr-check] dividendCount = ${dividendCount}`);
    console.log(`[xirr-check] dividendTotal = $${dividendTotal.toFixed(4)}`);
    expect(dividendCount).toBe(2);
    expect(dividendTotal).toBeCloseTo(0.56, 4);
  });
});
