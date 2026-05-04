/**
 * General Investment Account (GIA) projection module — 2025/26
 *
 * Models an individual's GIA balance year by year, tracking:
 *   - Contributions (increase balance and cost basis equally)
 *   - Annual growth applied to (opening balance + contributions)
 *   - Withdrawals and the Capital Gains Tax arising on the gain portion
 *   - Unrealised gain at year end (market value minus average cost basis)
 *
 * CGT calculation (2025/26):
 *   Annual exempt amount : £3,000
 *   Basic rate           : 18%  (income + net gains within basic rate band)
 *   Higher/addl rate     : 24%
 *   Basic rate band limit: £50,270 (income above this → all gains at 24%)
 *
 *   Gain on a withdrawal is determined proportionally:
 *     gainFraction = max(0, portfolioGain) / balanceBeforeWithdrawal
 *     gainOnWithdrawal = withdrawal × gainFraction
 *   If grossIncome is not supplied the higher rate (24%) is assumed throughout.
 *
 *   CGT is treated as a tax liability separate from the portfolio balance —
 *   the GIA closing balance reflects market value after withdrawals only.
 *   CGT is tracked per year so the caller can deduct it from net proceeds
 *   or model it as an external cash outflow.
 *
 *   Cost basis is reduced proportionally on each withdrawal:
 *     closingCostBasis = openingCostBasis × (1 − withdrawal / balanceBeforeWithdrawal)
 *
 * Ordering within each year:
 *   1. Add contributions  → balance and cost basis both rise by contribution amount
 *   2. Apply growth       → balance rises; cost basis unchanged
 *   3. Process withdrawal → CGT calculated; balance falls; cost basis reduced
 *
 * Source: gov.uk/capital-gains-tax/rates
 */

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published rates and thresholds
// ---------------------------------------------------------------------------

export const GIA_CGT_CONSTANTS = {
  annualExemptAmount: 3_000, // annual CGT allowance (£)
  basicRate: 0.18, // 18% on gains within remaining basic rate band
  higherRate: 0.24, // 24% on gains above basic rate band
  basicRateLimit: 50_270, // income threshold; gains above this are at higher rate
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertNonNegativeFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function assertNonNegativeFiniteOrNull(value, name) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number or null`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Projects a GIA balance year by year.
 *
 * @param {number} initialBalance   - Opening market value in GBP (>= 0)
 * @param {number} initialCostBasis - Total amount invested at the start in GBP (>= 0).
 *                                    For a new account this equals initialBalance.
 *                                    May be less than initialBalance (unrealised gain)
 *                                    or more (unrealised loss).
 * @param {Array<{
 *   growthRate:     number,          - Annual growth as a decimal (e.g. 0.07 = 7%). May be 0.
 *   contributions?: number,          - Deposits made this year (default 0)
 *   withdrawals?:   number,          - Amount withdrawn this year (default 0)
 *   grossIncome?:   number | null    - Gross annual income used to determine CGT rate.
 *                                      null / omitted → higher rate (24%) assumed.
 * }>} annualProjections
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   initialBalance:       number,
 *   initialCostBasis:     number,
 *   startYear:            number,
 *   yearlyBreakdown: Array<{
 *     year:                    number,
 *     openingBalance:          number,
 *     openingCostBasis:        number,
 *     contributions:           number,
 *     growthRate:              number,
 *     growthAmount:            number,
 *     balanceBeforeWithdrawal: number,
 *     withdrawals:             number,
 *     gainOnWithdrawal:        number,
 *     cgtAllowanceUsed:        number,
 *     cgtDue:                  number,
 *     cgtRate:                 number,
 *     closingBalance:          number,
 *     closingCostBasis:        number,
 *     unrealisedGain:          number
 *   }>,
 *   totalContributions:   number,
 *   totalWithdrawals:     number,
 *   totalGrowth:          number,
 *   totalCgtPaid:         number,
 *   finalBalance:         number,
 *   finalCostBasis:       number,
 *   finalUnrealisedGain:  number,
 *   taxYear:              string
 * }}
 */
export function projectGIA(initialBalance, initialCostBasis, annualProjections, options = {}) {
  assertNonNegativeFinite(initialBalance, 'initialBalance');
  assertNonNegativeFinite(initialCostBasis, 'initialCostBasis');

  if (!Array.isArray(annualProjections) || annualProjections.length === 0) {
    throw new TypeError('annualProjections must be a non-empty array');
  }

  const { startYear = 2025 } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  const { annualExemptAmount, basicRate, higherRate, basicRateLimit } = GIA_CGT_CONSTANTS;

  let balance = round2(initialBalance);
  let costBasis = round2(initialCostBasis);

  let totalContributions = 0;
  let totalWithdrawals = 0;
  let totalGrowth = 0;
  let totalCgtPaid = 0;

  const yearlyBreakdown = [];

  for (let i = 0; i < annualProjections.length; i++) {
    const proj = annualProjections[i];
    const year = startYear + i;

    const { growthRate, contributions = 0, withdrawals = 0, grossIncome = null } = proj;

    assertNonNegativeFinite(growthRate, `year ${year} growthRate`);
    assertNonNegativeFinite(contributions, `year ${year} contributions`);
    assertNonNegativeFinite(withdrawals, `year ${year} withdrawals`);
    assertNonNegativeFiniteOrNull(grossIncome, `year ${year} grossIncome`);

    const openingBalance = balance;
    const openingCostBasis = costBasis;

    // 1. Contributions
    balance = round2(balance + contributions);
    costBasis = round2(costBasis + contributions);

    // 2. Growth
    const growthAmount = round2(balance * growthRate);
    balance = round2(balance + growthAmount);

    const balanceBeforeWithdrawal = balance;
    const costBasisBeforeWithdrawal = costBasis;

    if (withdrawals > balanceBeforeWithdrawal + 0.005) {
      throw new RangeError(
        `Year ${year}: withdrawals (£${withdrawals}) exceed available balance (£${balanceBeforeWithdrawal})`
      );
    }
    const actualWithdrawal = Math.min(withdrawals, balanceBeforeWithdrawal);

    // 3. Withdrawal and CGT
    let gainOnWithdrawal = 0;
    let cgtAllowanceUsed = 0;
    let cgtDue = 0;
    let cgtRate = 0;

    if (actualWithdrawal > 0) {
      // Proportional gain on this withdrawal
      const portfolioGain = Math.max(0, balanceBeforeWithdrawal - costBasisBeforeWithdrawal);
      const gainFraction =
        balanceBeforeWithdrawal > 0 ? portfolioGain / balanceBeforeWithdrawal : 0;
      gainOnWithdrawal = round2(actualWithdrawal * gainFraction);

      if (gainOnWithdrawal > 0) {
        cgtAllowanceUsed = Math.min(gainOnWithdrawal, annualExemptAmount);
        const taxableGain = round2(gainOnWithdrawal - cgtAllowanceUsed);

        if (taxableGain > 0) {
          const effectiveIncome = grossIncome ?? Infinity;
          const basicBandRemaining = Math.max(0, basicRateLimit - effectiveIncome);
          const gainAtBasicRate = Math.min(taxableGain, basicBandRemaining);
          const gainAtHigherRate = taxableGain - gainAtBasicRate;

          cgtDue = round2(gainAtBasicRate * basicRate + gainAtHigherRate * higherRate);
          cgtRate = round2(cgtDue / taxableGain);
        }
      }

      // Reduce cost basis proportionally to the withdrawal
      const withdrawalFraction = actualWithdrawal / balanceBeforeWithdrawal;
      costBasis = round2(costBasisBeforeWithdrawal * (1 - withdrawalFraction));
      balance = round2(balanceBeforeWithdrawal - actualWithdrawal);
    }

    totalContributions = round2(totalContributions + contributions);
    totalWithdrawals = round2(totalWithdrawals + actualWithdrawal);
    totalGrowth = round2(totalGrowth + growthAmount);
    totalCgtPaid = round2(totalCgtPaid + cgtDue);

    yearlyBreakdown.push({
      year,
      openingBalance,
      openingCostBasis,
      contributions,
      growthRate,
      growthAmount,
      balanceBeforeWithdrawal,
      withdrawals: actualWithdrawal,
      gainOnWithdrawal,
      cgtAllowanceUsed,
      cgtDue,
      cgtRate,
      closingBalance: balance,
      closingCostBasis: costBasis,
      unrealisedGain: round2(balance - costBasis),
    });
  }

  return {
    initialBalance,
    initialCostBasis,
    startYear,
    yearlyBreakdown,
    totalContributions,
    totalWithdrawals,
    totalGrowth,
    totalCgtPaid,
    finalBalance: balance,
    finalCostBasis: costBasis,
    finalUnrealisedGain: round2(balance - costBasis),
    taxYear: TAX_YEAR,
  };
}
