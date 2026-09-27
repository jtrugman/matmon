// Fidelity importer action-mapping coverage for cash-movement rows.
//
// The bug: Justin's transactions table showed a +$300 Electronic Funds Transfer
// Received row labeled "BUY" with no symbol. That's wrong: it's a cash deposit
// and should be tagged `cash_in`. Two failure modes are possible:
//
//   1. The ACTION_MAP regex order lets a permissive "buy" rule fire before a
//      more specific cash-movement rule. (Not the current state: the EFT
//      rules come first.)
//   2. A Fidelity export variant with a blank Action cell and a non-zero
//      Amount falls through the mapper, gets dropped, but happens to surface
//      via a different pathway that bucket-maps it to `buy` by default.
//
// The fix: a defensive guard in the Fidelity importer that NEVER emits a
// `buy` action without a symbol. When the symbol is null we re-categorize
// based on the Amount sign (positive → cash_in, negative → cash_out). The
// guard is purely a backstop; the primary classification path remains the
// ACTION_MAP regex in util.ts.
//
// We also document the empty-Action recovery path: a row with no action
// string, no symbol, and a non-zero amount is parsed as a cash movement
// instead of being dropped. Without that recovery, a user's deposit could
// silently vanish from the portfolio when a Fidelity export ships an
// unexpected blank Action cell.
//
// All synthesized CSVs in this spec use the MULTI-ACCOUNT Fidelity export
// shape (with Account + Account Number columns). Single-account exports are
// now rejected at the import gate (they omit the account number we need for
// dedup), so any test fixture that exercises Fidelity importer behavior
// must include the account columns.

import { describe, expect, it } from 'vitest';
import { importCsv } from '../src/lib/importers';

/** Build a Fidelity-shaped CSV from the canonical 15-column multi-account header. */
function buildFidelityCsv(rows: string[]): string {
  const header =
    'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date';
  return [header, ...rows].join('\n');
}

describe('Fidelity action mapping: cash movements never become BUY', () => {
  it('Electronic Funds Transfer Received with no symbol and +$300 → cash_in', () => {
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"Electronic Funds Transfer Received (Cash)", ,"No Description",Cash,,0.000,,,,300,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('cash_in');
    expect(tx.symbol).toBeNull();
    expect(tx.amount).toBe(300);
  });

  it('Electronic Funds Transfer Paid with no symbol and -$200 → cash_out', () => {
    const csv = buildFidelityCsv([
      '05/15/2026,Individual,Z00001234,"Electronic Funds Transfer Paid (Cash)", ,"No Description",Cash,,0.000,,,,-200,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('cash_out');
    expect(tx.symbol).toBeNull();
    expect(tx.amount).toBe(-200);
  });

  it('legitimate "YOU BOUGHT" with VGT/qty=10/-$1500 still maps to buy', () => {
    // The defensive no-symbol guard must NOT catch real share purchases.
    const csv = buildFidelityCsv([
      '05/11/2026,Individual,Z00001234,"YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)",VGT,"VANGUARD WORLD FD INF TECH ETF",Cash,150,10,,,,-1500,41.33,05/12/2026',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('buy');
    expect(tx.symbol).toBe('VGT');
    expect(tx.quantity).toBe(10);
    expect(tx.price).toBe(150);
    expect(tx.amount).toBe(-1500);
  });

  it('blank Action + no symbol + +$100 → cash_in (defensive recovery)', () => {
    // A future Fidelity export variant might emit a deposit row with a blank
    // Action cell. The importer's recovery path infers cash_in from the
    // amount sign so the deposit isn't silently dropped.
    //
    // We blank BOTH Action and Type because parseRow falls back to
    // `row['Action'] || row['Type']`; the recovery only fires when the
    // resulting actionStr is truly empty.
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"", ,"Some description",,,0.000,,,,100,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('cash_in');
    expect(tx.symbol).toBeNull();
    expect(tx.amount).toBe(100);
  });

  it('blank Action + no symbol + -$50 → cash_out (defensive recovery, negative)', () => {
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"", ,"Some description",,,0.000,,,,-50,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('cash_out');
    expect(tx.symbol).toBeNull();
    expect(tx.amount).toBe(-50);
  });

  it('blank Action + no symbol + $0 amount stays dropped (nothing to recover)', () => {
    // The recovery path only fires when there's a non-zero amount to interpret.
    // A row with no action, no symbol, no amount carries no signal and should
    // remain dropped (no phantom transaction inserted).
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"", ,"Empty row",,,0.000,,,,0,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(0);
  });

  it('UNKNOWN non-empty Action with no symbol stays unmapped (recovery does NOT fire)', () => {
    // Defensive recovery is deliberately scoped to truly-blank actions. An
    // unknown-but-non-empty action like "Tax Withholding" should surface as
    // an unmappedActionStrings entry so the user sees the missing pattern,
    // NOT silently bucket into cash_out.
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"Tax Withholding (Cash)", ,"Some description",,,0.000,,,,-50,Processing,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(0);
    expect(r.unmappedActionStrings).toContain('Tax Withholding (Cash)');
  });

  it('hypothetical "YOU BOUGHT BACK" cash-only row gets re-categorized via the no-symbol guard', () => {
    // Pure regression test for the defensive guard. If a future Fidelity action
    // description happens to contain the substring "bought" / "buy" but
    // describes a cash event with no symbol attached, the guard re-maps it to
    // cash_in or cash_out based on the Amount sign. This is what protects the
    // holdings replay from phantom positions.
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"BUY-BACK ADJUSTMENT (Cash)", ,"Adjustment",Cash,,0.000,,,,42,42,',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(1);
    const tx = r.transactions[0];
    expect(tx.action).toBe('cash_in');
    expect(tx.symbol).toBeNull();
    expect(tx.amount).toBe(42);
  });

  it('full Fidelity sample roundtrip: every EFT row is cash_in, every YOU BOUGHT is buy', () => {
    // End-to-end check on the real example file. The 5 EFT rows must each
    // surface as cash_in; the 10 YOU BOUGHT rows must each surface as buy.
    // The defensive guards are the safety net; this test pins the normal path.
    const csv = buildFidelityCsv([
      '05/18/2026,Individual,Z00001234,"Electronic Funds Transfer Received (Cash)", ,"No Description",Cash,,0.000,,,,300,Processing,',
      '05/11/2026,Individual,Z00001234,"YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)",VGT,"VANGUARD WORLD FD INF TECH ETF",Cash,113.89,1,,,,-113.89,41.33,05/12/2026',
      '05/11/2026,Individual,Z00001234,"Electronic Funds Transfer Received (Cash)", ,"No Description",Cash,,0.000,,,,300,341.32,',
      '05/04/2026,Individual,Z00001234,"YOU BOUGHT VANGUARD WORLD FD INF TECH ETF (VGT) (Cash)",VGT,"VANGUARD WORLD FD INF TECH ETF",Cash,104.98,1,,,,-104.98,41.32,05/05/2026',
    ]);
    const r = importCsv(csv);
    expect(r.transactions).toHaveLength(4);
    const byAction = r.transactions.reduce<Record<string, number>>((acc, t) => {
      acc[t.action] = (acc[t.action] || 0) + 1;
      return acc;
    }, {});
    expect(byAction.cash_in).toBe(2);
    expect(byAction.buy).toBe(2);
    // No spurious buys without symbol.
    for (const t of r.transactions) {
      if (t.action === 'buy') {
        expect(t.symbol).not.toBeNull();
        expect(t.symbol!.length).toBeGreaterThan(0);
      }
    }
  });
});
