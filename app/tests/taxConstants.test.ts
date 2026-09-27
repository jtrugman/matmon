import { describe, expect, it } from 'vitest';
import {
  TAX_CONSTANTS_2026,
  getTaxConstants,
  type TaxConstants,
} from '../src/lib/taxConstants';

function assertAllPositiveNumbers(obj: Record<string, number>, label: string) {
  for (const [key, value] of Object.entries(obj)) {
    expect(value, `${label}.${key} should be a finite number`).toBeTypeOf('number');
    expect(Number.isFinite(value), `${label}.${key} should be finite`).toBe(true);
    expect(value, `${label}.${key} should be positive`).toBeGreaterThan(0);
  }
}

describe('TaxConstants shape', () => {
  it('returns a fully populated TaxConstants object', () => {
    const tc: TaxConstants = getTaxConstants();

    expect(tc.year).toBeTypeOf('number');
    expect(tc.year).toBeGreaterThanOrEqual(2026);

    // Contribution limits: every field must be a positive number
    assertAllPositiveNumbers(
      tc.contributionLimits as unknown as Record<string, number>,
      'contributionLimits',
    );

    // Healthcare benchmarks
    expect(tc.healthcare.fidelityRetireeEstimatePerPerson).toBeGreaterThan(0);
    expect(tc.healthcare.fidelityRetireeEstimateCouple).toBeGreaterThan(0);
    expect(tc.healthcare.sourceUrl).toMatch(/^https?:\/\//);
    expect(tc.healthcare.asOfYear).toBeGreaterThanOrEqual(2020);

    // IRMAA brackets present, ordered, with non-negative add-ons
    expect(Array.isArray(tc.irmaa.brackets)).toBe(true);
    expect(tc.irmaa.brackets.length).toBeGreaterThan(0);
    for (let i = 1; i < tc.irmaa.brackets.length; i++) {
      expect(tc.irmaa.brackets[i].incomeMin).toBeGreaterThan(
        tc.irmaa.brackets[i - 1].incomeMin,
      );
      expect(tc.irmaa.brackets[i].partB_add).toBeGreaterThanOrEqual(0);
      expect(tc.irmaa.brackets[i].partD_add).toBeGreaterThanOrEqual(0);
    }

    // ACA marketplace estimate
    expect(tc.acaMarketplace.avgMonthlyPremiumPerAdult).toBeGreaterThan(0);
    expect(tc.acaMarketplace.asOfYear).toBeGreaterThanOrEqual(2020);
  });
});

describe('Sanity checks on contribution limits', () => {
  it('401(k) deferral cap exceeds the IRA cap', () => {
    const tc = getTaxConstants();
    expect(tc.contributionLimits.traditional_401k).toBeGreaterThan(
      tc.contributionLimits.traditional_ira,
    );
  });

  it('HSA family cap exceeds the HSA self-only cap', () => {
    const tc = getTaxConstants();
    expect(tc.contributionLimits.hsa_family).toBeGreaterThan(
      tc.contributionLimits.hsa_self_only,
    );
  });

  it('Traditional and Roth IRA caps are aligned (combined-limit rule)', () => {
    const tc = getTaxConstants();
    expect(tc.contributionLimits.roth_ira).toBe(tc.contributionLimits.traditional_ira);
  });

  it('Fidelity couple estimate is roughly double the single estimate', () => {
    const tc = getTaxConstants();
    const ratio =
      tc.healthcare.fidelityRetireeEstimateCouple /
      tc.healthcare.fidelityRetireeEstimatePerPerson;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(2.5);
  });
});

describe('getTaxConstants', () => {
  it('returns the 2026 record by default', () => {
    expect(getTaxConstants()).toBe(TAX_CONSTANTS_2026);
  });

  it('returns the 2026 record when asked explicitly', () => {
    expect(getTaxConstants(2026)).toBe(TAX_CONSTANTS_2026);
  });

  it('falls back to the most recent record for unknown years', () => {
    const result = getTaxConstants(1999);
    expect(result).toBe(TAX_CONSTANTS_2026);
  });

  it('returns exactly the documented 2026 IRS baselines from the PRD', () => {
    const tc = getTaxConstants(2026);
    expect(tc.contributionLimits.traditional_401k).toBe(23500);
    expect(tc.contributionLimits.traditional_ira).toBe(7000);
    expect(tc.contributionLimits.roth_ira).toBe(7000);
    expect(tc.contributionLimits.hsa_self_only).toBe(4300);
    expect(tc.contributionLimits.hsa_family).toBe(8550);
  });
});
