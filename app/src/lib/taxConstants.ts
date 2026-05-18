// Tax-year constants for retirement contribution limits, healthcare cost
// benchmarks, and Medicare IRMAA brackets. Pulled here so the values can be
// refreshed each tax year without touching component code (PRD §7.8).
//
// Sources are cited inline above each value. When you update for a new tax
// year, add a fresh TaxConstants record below and extend the year map in
// `getTaxConstants`. Do not mutate the prior year's record; we want a clean
// audit trail of what the app showed historically.

export interface TaxConstants {
  year: number;
  contributionLimits: {
    // 401(k), 403(b), and most 457 plans elective deferral cap
    traditional_401k: number;
    // Traditional IRA annual contribution cap (under age 50)
    traditional_ira: number;
    // Roth IRA annual contribution cap (under age 50, before MAGI phase-out)
    roth_ira: number;
    // HSA self-only coverage annual contribution cap
    hsa_self_only: number;
    // HSA family coverage annual contribution cap
    hsa_family: number;
    // SEP-IRA: lesser of 25% of compensation or this dollar cap
    sep_ira_max: number;
  };
  healthcare: {
    // Fidelity Retiree Health Care Cost Estimate, single retiree at age 65
    fidelityRetireeEstimatePerPerson: number;
    // Fidelity Retiree Health Care Cost Estimate, couple at age 65
    fidelityRetireeEstimateCouple: number;
    // URL where the estimate is published, so we can re-verify yearly
    sourceUrl: string;
    // Year that estimate was published / refers to
    asOfYear: number;
  };
  irmaa: {
    // 2026 IRMAA brackets, married-filing-jointly column. `incomeMin` is the
    // MAGI floor of the bracket (the prior bracket ends one dollar below).
    // `partB_add` and `partD_add` are the monthly per-person surcharges that
    // stack on top of the base Part B / Part D premium.
    brackets: Array<{ incomeMin: number; partB_add: number; partD_add: number }>;
  };
  acaMarketplace: {
    // Rough national average monthly premium per adult for an unsubsidized
    // marketplace plan, used by the coverage-gap calculator (PRD §7.8.3).
    avgMonthlyPremiumPerAdult: number;
    asOfYear: number;
  };
}

export const TAX_CONSTANTS_2026: TaxConstants = {
  year: 2026,
  contributionLimits: {
    // PRD §7.8.1 baseline; IRS Notice 2025-67 (2026 cost-of-living adjustments)
    traditional_401k: 23500,
    // PRD §7.8.1 baseline; IRS Notice 2025-67
    traditional_ira: 7000,
    // PRD §7.8.1 baseline; IRS Notice 2025-67 (same cap as traditional IRA, MAGI phase-out applies)
    roth_ira: 7000,
    // PRD §7.8.1 baseline (matches 2025 IRS Rev. Proc. 2024-25). VERIFY 2026
    hsa_self_only: 4300,
    // PRD §7.8.1 baseline (matches 2025 IRS Rev. Proc. 2024-25). VERIFY 2026
    hsa_family: 8550,
    // IRS Notice 2025-67 (SEP-IRA dollar cap for 2026)
    sep_ira_max: 72000,
  },
  healthcare: {
    // Fidelity 2024 Retiree Health Care Cost Estimate, single 65-year-old retiree.
    // VERIFY 2026 (Fidelity refreshes annually in summer)
    fidelityRetireeEstimatePerPerson: 165000,
    // Fidelity 2024 Retiree Health Care Cost Estimate, opposite-sex couple, both 65.
    // Note: the prior PlannerView hardcoded $330,000, which is 2 x $165,000.
    fidelityRetireeEstimateCouple: 330000,
    sourceUrl: 'https://www.fidelity.com/viewpoints/personal-finance/plan-for-rising-health-care-costs',
    asOfYear: 2024,
  },
  irmaa: {
    // 2026 IRMAA, married-filing-jointly thresholds. Monthly per-person
    // surcharges that stack on the standard Part B / Part D premium.
    // Source: CMS Medicare 2026 Part B / Part D premium notice (verify on
    // release). VERIFY 2026
    brackets: [
      // Standard premium, no surcharge
      { incomeMin: 0, partB_add: 0, partD_add: 0 },
      { incomeMin: 212000, partB_add: 74.0, partD_add: 13.7 },
      { incomeMin: 266000, partB_add: 185.0, partD_add: 35.3 },
      { incomeMin: 334000, partB_add: 295.9, partD_add: 57.0 },
      { incomeMin: 400000, partB_add: 406.9, partD_add: 78.6 },
      { incomeMin: 750000, partB_add: 443.9, partD_add: 85.8 },
    ],
  },
  acaMarketplace: {
    // KFF 2024 benchmark: national average unsubsidized monthly premium for a
    // 40-year-old on a silver plan is ~$477/mo. We use a round midpoint as a
    // planning estimate. VERIFY 2026
    avgMonthlyPremiumPerAdult: 500,
    asOfYear: 2024,
  },
};

// Year-indexed map. Add new records here as each tax year is published.
const TAX_CONSTANTS_BY_YEAR: Record<number, TaxConstants> = {
  2026: TAX_CONSTANTS_2026,
};

/**
 * Returns the TaxConstants record for the requested year. Falls back to the
 * most recent available year when an exact match is not found, so the app
 * always renders something sensible.
 */
export function getTaxConstants(year?: number): TaxConstants {
  if (year !== undefined && TAX_CONSTANTS_BY_YEAR[year]) {
    return TAX_CONSTANTS_BY_YEAR[year];
  }
  // Default to the latest tax year present in the map.
  const years = Object.keys(TAX_CONSTANTS_BY_YEAR)
    .map(Number)
    .sort((a, b) => b - a);
  return TAX_CONSTANTS_BY_YEAR[years[0]];
}
