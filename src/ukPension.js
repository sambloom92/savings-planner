/**
 * UK Defined Contribution Pension projection module — 2025/26
 *
 * Models three distinct phases of a DC pension:
 *
 * 1. ACCUMULATION — contributions and growth build the pot
 *      Employee and employer contributions are accepted as the gross amounts
 *      deposited into the pension (inclusive of any tax relief already applied).
 *      Total contributions per year must not exceed the annual allowance (£60,000).
 *      Carry-forward of unused allowance is not modelled.
 *
 * 2. RETIREMENT EVENT — optional tax-free lump sum (PCLS)
 *      Up to 25% of the pot may be taken as a Pension Commencement Lump Sum,
 *      capped at the lump sum allowance of £268,275 (2024/25 onwards).
 *      The remainder becomes the crystallised fund entering drawdown.
 *
 * 3. DRAWDOWN — the crystallised fund is spent down in retirement
 *      Each year's gross drawdown is taxed as income (UK Income Tax).
 *      Marginal tax is calculated as:
 *        tax on (otherIncome + drawdown) − tax on (otherIncome)
 *      where otherIncome covers state pension, part-time earnings, etc.
 *      Growth continues on the remaining fund between withdrawals.
 *
 * Ordering within each accumulation year:
 *   1. Add contributions → balance and annual allowance check
 *   2. Apply growth to (opening balance + contributions)
 *
 * Ordering within each drawdown year:
 *   1. Apply growth to opening balance
 *   2. Withdraw gross drawdown amount (pot reduces by gross, not net)
 *   3. Calculate income tax on the gross drawdown (marginal rate)
 *
 * Sources:
 *   gov.uk/tax-on-your-private-pension
 *   gov.uk/guidance/pension-schemes-work-out-your-tapered-annual-allowance
 */

import { calculateIncomeTax } from './ukIncomeTax.js';

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published limits and rates
// ---------------------------------------------------------------------------

export const PENSION_CONSTANTS = {
  annualAllowance: 60_000, // max total (employee + employer) per tax year
  lumpSumAllowance: 268_275, // max tax-free PCLS (pension commencement lump sum)
  maxPCLSPercentage: 0.25, // maximum percentage of pot taken as PCLS
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
 * Projects a DC pension during the accumulation (pre-retirement) phase.
 *
 * @param {number} initialBalance - Opening pot value in GBP (>= 0)
 * @param {Array<{
 *   growthRate:              number,   - Annual growth as a decimal (e.g. 0.06 = 6%)
 *   employeeContributions?:  number,   - Gross employee deposits this year (default 0)
 *   employerContributions?:  number,   - Employer deposits this year (default 0)
 * }>} annualProjections
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   initialBalance:             number,
 *   startYear:                  number,
 *   annualAllowance:            number,
 *   yearlyBreakdown: Array<{
 *     year:                     number,
 *     openingBalance:           number,
 *     employeeContributions:    number,
 *     employerContributions:    number,
 *     totalContributions:       number,
 *     growthRate:               number,
 *     growthAmount:             number,
 *     closingBalance:           number
 *   }>,
 *   totalEmployeeContributions: number,
 *   totalEmployerContributions: number,
 *   totalContributions:         number,
 *   totalGrowth:                number,
 *   finalBalance:               number,
 *   taxYear:                    string
 * }}
 */
export function projectPensionAccumulation(initialBalance, annualProjections, options = {}) {
  assertNonNegativeFinite(initialBalance, 'initialBalance');

  if (!Array.isArray(annualProjections) || annualProjections.length === 0) {
    throw new TypeError('annualProjections must be a non-empty array');
  }

  const { startYear = 2025 } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  const { annualAllowance } = PENSION_CONSTANTS;

  let balance = round2(initialBalance);
  let totalEmployeeContributions = 0;
  let totalEmployerContributions = 0;
  let totalGrowth = 0;
  const yearlyBreakdown = [];

  for (let i = 0; i < annualProjections.length; i++) {
    const proj = annualProjections[i];
    const year = startYear + i;

    const { growthRate, employeeContributions = 0, employerContributions = 0 } = proj;

    assertNonNegativeFinite(growthRate, `year ${year} growthRate`);
    assertNonNegativeFinite(employeeContributions, `year ${year} employeeContributions`);
    assertNonNegativeFinite(employerContributions, `year ${year} employerContributions`);

    const totalContributions = round2(employeeContributions + employerContributions);

    if (totalContributions > annualAllowance) {
      throw new RangeError(
        `Year ${year}: total contributions (£${totalContributions}) exceed the annual ` +
          `allowance of £${annualAllowance}. Carry-forward is not modelled.`
      );
    }

    const openingBalance = balance;

    // 1. Contributions
    balance = round2(balance + totalContributions);

    // 2. Growth on (opening + contributions)
    const growthAmount = round2(balance * growthRate);
    balance = round2(balance + growthAmount);

    totalEmployeeContributions = round2(totalEmployeeContributions + employeeContributions);
    totalEmployerContributions = round2(totalEmployerContributions + employerContributions);
    totalGrowth = round2(totalGrowth + growthAmount);

    yearlyBreakdown.push({
      year,
      openingBalance,
      employeeContributions,
      employerContributions,
      totalContributions,
      growthRate,
      growthAmount,
      closingBalance: balance,
    });
  }

  return {
    initialBalance,
    startYear,
    annualAllowance,
    yearlyBreakdown,
    totalEmployeeContributions,
    totalEmployerContributions,
    totalContributions: round2(totalEmployeeContributions + totalEmployerContributions),
    totalGrowth,
    finalBalance: balance,
    taxYear: TAX_YEAR,
  };
}

/**
 * Calculates the Pension Commencement Lump Sum (PCLS) at retirement.
 *
 * The tax-free lump sum is the lesser of:
 *   - The requested amount (percentage of pot, or a fixed amount)
 *   - The lump sum allowance (£268,275)
 *   - The full pension pot
 *
 * @param {number} pensionPot - Total uncrystallised pension value in GBP (>= 0)
 * @param {{
 *   pclsPercentage?: number,   - Fraction of pot to take (0–0.25, default 0.25)
 *   pclsAmount?:     number    - Fixed lump sum in GBP; overrides pclsPercentage if set
 * }} [options]
 * @returns {{
 *   pensionPot:        number,
 *   requestedLumpSum:  number,
 *   lumpSum:           number,
 *   lumpSumCapped:     boolean,
 *   crystallisedFund:  number,
 *   lumpSumAllowance:  number,
 *   taxYear:           string
 * }}
 */
export function calculatePCLS(pensionPot, options = {}) {
  assertNonNegativeFinite(pensionPot, 'pensionPot');

  const { lumpSumAllowance, maxPCLSPercentage } = PENSION_CONSTANTS;
  const { pclsPercentage = maxPCLSPercentage, pclsAmount = null } = options;

  if (
    typeof pclsPercentage !== 'number' ||
    !isFinite(pclsPercentage) ||
    pclsPercentage < 0 ||
    pclsPercentage > maxPCLSPercentage
  ) {
    throw new RangeError(`pclsPercentage must be a number between 0 and ${maxPCLSPercentage}`);
  }

  if (pclsAmount !== null) {
    assertNonNegativeFinite(pclsAmount, 'pclsAmount');
  }

  const requestedLumpSum =
    pclsAmount !== null ? round2(pclsAmount) : round2(pensionPot * pclsPercentage);

  const lumpSum = round2(Math.min(requestedLumpSum, lumpSumAllowance, pensionPot));
  const lumpSumCapped = requestedLumpSum > lumpSum + 0.005;

  return {
    pensionPot,
    requestedLumpSum,
    lumpSum,
    lumpSumCapped,
    crystallisedFund: round2(pensionPot - lumpSum),
    lumpSumAllowance,
    taxYear: TAX_YEAR,
  };
}

/**
 * Projects a crystallised pension fund in flexible drawdown.
 *
 * Each year's gross drawdown is taxed as income. The pot reduces by the
 * gross drawdown; tax is paid from the drawn amount (or separately via PAYE).
 * Growth is applied to the opening balance before the withdrawal is taken.
 *
 * @param {number} initialFund - Crystallised fund value in GBP (>= 0)
 * @param {Array<{
 *   growthRate:     number,          - Annual growth as a decimal (>= 0)
 *   annualDrawdown: number,          - Gross amount taken from the pot this year (>= 0)
 *   otherIncome?:   number           - Other taxable income this year (state pension,
 *                                      part-time work, etc.) — used to calculate the
 *                                      marginal income tax rate on the drawdown. (default 0)
 * }>} annualProjections
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   initialFund:         number,
 *   startYear:           number,
 *   yearlyBreakdown: Array<{
 *     year:                   number,
 *     openingBalance:         number,
 *     growthRate:             number,
 *     growthAmount:           number,
 *     balanceBeforeDrawdown:  number,
 *     annualDrawdown:         number,
 *     otherIncome:            number,
 *     taxOnDrawdown:          number,
 *     netDrawdown:            number,
 *     closingBalance:         number
 *   }>,
 *   totalGrowth:         number,
 *   totalGrossDrawdown:  number,
 *   totalTaxPaid:        number,
 *   totalNetDrawdown:    number,
 *   finalBalance:        number,
 *   taxYear:             string
 * }}
 */
export function projectPensionDrawdown(initialFund, annualProjections, options = {}) {
  assertNonNegativeFinite(initialFund, 'initialFund');

  if (!Array.isArray(annualProjections) || annualProjections.length === 0) {
    throw new TypeError('annualProjections must be a non-empty array');
  }

  const { startYear = 2025 } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  let balance = round2(initialFund);
  let totalGrowth = 0;
  let totalGrossDrawdown = 0;
  let totalTaxPaid = 0;
  const yearlyBreakdown = [];

  for (let i = 0; i < annualProjections.length; i++) {
    const proj = annualProjections[i];
    const year = startYear + i;

    const { growthRate, annualDrawdown, otherIncome = 0 } = proj;

    assertNonNegativeFinite(growthRate, `year ${year} growthRate`);
    assertNonNegativeFinite(annualDrawdown, `year ${year} annualDrawdown`);
    assertNonNegativeFinite(otherIncome, `year ${year} otherIncome`);

    const openingBalance = balance;

    // 1. Growth on opening balance
    const growthAmount = round2(balance * growthRate);
    balance = round2(balance + growthAmount);

    const balanceBeforeDrawdown = balance;

    if (annualDrawdown > balanceBeforeDrawdown + 0.005) {
      throw new RangeError(
        `Year ${year}: annualDrawdown (£${annualDrawdown}) exceeds available ` +
          `balance (£${balanceBeforeDrawdown})`
      );
    }
    const actualDrawdown = Math.min(annualDrawdown, balanceBeforeDrawdown);

    // 2. Marginal income tax on the drawdown
    //    = tax on (otherIncome + drawdown) − tax on (otherIncome alone)
    const taxOnTotal = calculateIncomeTax(otherIncome + actualDrawdown).totalTax;
    const taxOnOther = calculateIncomeTax(otherIncome).totalTax;
    const taxOnDrawdown = round2(taxOnTotal - taxOnOther);
    const netDrawdown = round2(actualDrawdown - taxOnDrawdown);

    // 3. Pot reduces by gross drawdown
    balance = round2(balanceBeforeDrawdown - actualDrawdown);

    totalGrowth = round2(totalGrowth + growthAmount);
    totalGrossDrawdown = round2(totalGrossDrawdown + actualDrawdown);
    totalTaxPaid = round2(totalTaxPaid + taxOnDrawdown);

    yearlyBreakdown.push({
      year,
      openingBalance,
      growthRate,
      growthAmount,
      balanceBeforeDrawdown,
      annualDrawdown: actualDrawdown,
      otherIncome,
      taxOnDrawdown,
      netDrawdown,
      closingBalance: balance,
    });
  }

  return {
    initialFund,
    startYear,
    yearlyBreakdown,
    totalGrowth,
    totalGrossDrawdown,
    totalTaxPaid,
    totalNetDrawdown: round2(totalGrossDrawdown - totalTaxPaid),
    finalBalance: balance,
    taxYear: TAX_YEAR,
  };
}

/**
 * Projects a full DC pension lifecycle: accumulation → retirement → drawdown.
 *
 * Accumulation and drawdown phases each run for as many years as the
 * corresponding projections array contains. The retirement event occurs
 * at the end of the accumulation phase (or immediately at startYear if
 * accumulationProjections is empty).
 *
 * @param {number} initialBalance - Opening pot value in GBP (>= 0)
 * @param {Array<object>} accumulationProjections - Same shape as projectPensionAccumulation.
 *                                                  May be empty if already at retirement.
 * @param {{
 *   takePCLS?:        boolean,  - Whether to take a tax-free lump sum (default true)
 *   pclsPercentage?:  number,   - Fraction of pot (0–0.25, default 0.25)
 *   pclsAmount?:      number    - Fixed lump sum; overrides pclsPercentage if set
 * }} [retirementOptions]
 * @param {Array<object>} [drawdownProjections] - Same shape as projectPensionDrawdown.
 *                                                May be empty or omitted.
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   initialBalance:  number,
 *   startYear:       number,
 *   accumulation:    object | null,
 *   retirement: {
 *     year:             number,
 *     pensionPot:       number,
 *     requestedLumpSum: number,
 *     lumpSum:          number,
 *     lumpSumCapped:    boolean,
 *     crystallisedFund: number,
 *     lumpSumAllowance: number
 *   },
 *   drawdown:        object | null,
 *   taxYear:         string
 * }}
 */
export function projectPension(
  initialBalance,
  accumulationProjections = [],
  retirementOptions = {},
  drawdownProjections = [],
  options = {}
) {
  assertNonNegativeFinite(initialBalance, 'initialBalance');

  const { startYear = 2025 } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  // --- Accumulation ---
  let accumulationResult = null;
  let pensionPotAtRetirement;
  let retirementYear;

  if (Array.isArray(accumulationProjections) && accumulationProjections.length > 0) {
    accumulationResult = projectPensionAccumulation(initialBalance, accumulationProjections, {
      startYear,
    });
    pensionPotAtRetirement = accumulationResult.finalBalance;
    retirementYear = startYear + accumulationProjections.length;
  } else {
    pensionPotAtRetirement = round2(initialBalance);
    retirementYear = startYear;
  }

  // --- Retirement: PCLS ---
  const { takePCLS = true, pclsPercentage, pclsAmount } = retirementOptions;

  let retirementResult;
  if (takePCLS) {
    const pclsResult = calculatePCLS(pensionPotAtRetirement, { pclsPercentage, pclsAmount });
    retirementResult = { year: retirementYear, ...pclsResult };
  } else {
    retirementResult = {
      year: retirementYear,
      pensionPot: pensionPotAtRetirement,
      requestedLumpSum: 0,
      lumpSum: 0,
      lumpSumCapped: false,
      crystallisedFund: pensionPotAtRetirement,
      lumpSumAllowance: PENSION_CONSTANTS.lumpSumAllowance,
    };
  }

  // --- Drawdown ---
  let drawdownResult = null;
  if (Array.isArray(drawdownProjections) && drawdownProjections.length > 0) {
    drawdownResult = projectPensionDrawdown(
      retirementResult.crystallisedFund,
      drawdownProjections,
      { startYear: retirementYear }
    );
  }

  return {
    initialBalance,
    startYear,
    accumulation: accumulationResult,
    retirement: retirementResult,
    drawdown: drawdownResult,
    taxYear: TAX_YEAR,
  };
}
