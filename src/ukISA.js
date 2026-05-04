/**
 * Stocks & Shares ISA projection module — 2025/26
 *
 * All growth and withdrawals within a Stocks & Shares ISA are completely
 * free of UK Income Tax and Capital Gains Tax. There is no cost-basis
 * tracking and no CGT calculation.
 *
 * Key rules modelled:
 *   Annual subscription limit : £20,000 per tax year
 *   Withdrawals               : always tax-free, no limit
 *   Flexible ISA              : NOT modelled — withdrawn amounts do not
 *                               replenish the annual allowance within the
 *                               same tax year
 *
 * Ordering within each year:
 *   1. Add contributions (validated against the annual limit)
 *   2. Apply growth to (opening balance + contributions)
 *   3. Process withdrawal
 *
 * Source: gov.uk/individual-savings-accounts
 */

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published limits
// ---------------------------------------------------------------------------

export const ISA_CONSTANTS = {
  annualSubscriptionLimit: 20_000, // maximum new money per tax year
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Projects a Stocks & Shares ISA balance year by year.
 *
 * @param {number} initialBalance - Opening market value in GBP (>= 0).
 *                                  May represent an existing ISA portfolio.
 * @param {Array<{
 *   growthRate:     number,   - Annual growth as a decimal (e.g. 0.07 = 7%). May be 0.
 *   contributions?: number,   - New money paid in this year (default 0, max £20,000)
 *   withdrawals?:   number    - Amount withdrawn this year (default 0, tax-free)
 * }>} annualProjections
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   initialBalance:     number,
 *   startYear:          number,
 *   annualLimit:        number,
 *   yearlyBreakdown: Array<{
 *     year:                    number,
 *     openingBalance:          number,
 *     contributions:           number,
 *     growthRate:              number,
 *     growthAmount:            number,
 *     balanceBeforeWithdrawal: number,
 *     withdrawals:             number,
 *     closingBalance:          number
 *   }>,
 *   totalContributions: number,
 *   totalWithdrawals:   number,
 *   totalGrowth:        number,
 *   finalBalance:       number,
 *   taxYear:            string
 * }}
 */
export function projectISA(initialBalance, annualProjections, options = {}) {
  assertNonNegativeFinite(initialBalance, 'initialBalance');

  if (!Array.isArray(annualProjections) || annualProjections.length === 0) {
    throw new TypeError('annualProjections must be a non-empty array');
  }

  const { startYear = 2025 } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  const { annualSubscriptionLimit } = ISA_CONSTANTS;

  let balance = round2(initialBalance);
  let totalContributions = 0;
  let totalWithdrawals = 0;
  let totalGrowth = 0;

  const yearlyBreakdown = [];

  for (let i = 0; i < annualProjections.length; i++) {
    const proj = annualProjections[i];
    const year = startYear + i;

    const { growthRate, contributions = 0, withdrawals = 0 } = proj;

    assertNonNegativeFinite(growthRate, `year ${year} growthRate`);
    assertNonNegativeFinite(contributions, `year ${year} contributions`);
    assertNonNegativeFinite(withdrawals, `year ${year} withdrawals`);

    if (contributions > annualSubscriptionLimit) {
      throw new RangeError(
        `Year ${year}: contributions (£${contributions}) exceed the annual ISA ` +
          `subscription limit of £${annualSubscriptionLimit}`
      );
    }

    const openingBalance = balance;

    // 1. Contributions
    balance = round2(balance + contributions);

    // 2. Growth on (opening + contributions)
    const growthAmount = round2(balance * growthRate);
    balance = round2(balance + growthAmount);

    const balanceBeforeWithdrawal = balance;

    if (withdrawals > balanceBeforeWithdrawal + 0.005) {
      throw new RangeError(
        `Year ${year}: withdrawals (£${withdrawals}) exceed available balance (£${balanceBeforeWithdrawal})`
      );
    }
    const actualWithdrawal = Math.min(withdrawals, balanceBeforeWithdrawal);

    // 3. Withdrawal — always tax-free inside an ISA
    balance = round2(balanceBeforeWithdrawal - actualWithdrawal);

    totalContributions = round2(totalContributions + contributions);
    totalWithdrawals = round2(totalWithdrawals + actualWithdrawal);
    totalGrowth = round2(totalGrowth + growthAmount);

    yearlyBreakdown.push({
      year,
      openingBalance,
      contributions,
      growthRate,
      growthAmount,
      balanceBeforeWithdrawal,
      withdrawals: actualWithdrawal,
      closingBalance: balance,
    });
  }

  return {
    initialBalance,
    startYear,
    annualLimit: annualSubscriptionLimit,
    yearlyBreakdown,
    totalContributions,
    totalWithdrawals,
    totalGrowth,
    finalBalance: balance,
    taxYear: TAX_YEAR,
  };
}
