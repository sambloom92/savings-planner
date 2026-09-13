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
 *      For high earners the allowance tapers — see taperedAnnualAllowance().
 *
 *      Money Purchase Annual Allowance (MPAA, £10,000): NOT modelled. The MPAA
 *      applies once a pension is flexibly accessed while still contributing;
 *      in this module the accumulation and drawdown phases never overlap, so
 *      the restriction can never bind.
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

import { calculateIncomeTax, INCOME_TAX_BANDS } from './ukIncomeTax.js';

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published limits and rates
// ---------------------------------------------------------------------------

export const PENSION_CONSTANTS = {
  annualAllowance: 60_000, // max total (employee + employer) per tax year
  lumpSumAllowance: 268_275, // max tax-free PCLS (pension commencement lump sum)
  maxPCLSPercentage: 0.25, // maximum percentage of pot taken as PCLS
  // Tapered annual allowance (2025/26): for adjusted income above £260,000
  // (and threshold income above £200,000) the allowance reduces by £1 for
  // every £2 of excess, down to a floor of £10,000 at £360,000+.
  taperAdjustedIncomeLimit: 260_000,
  taperThresholdIncomeLimit: 200_000,
  minAnnualAllowance: 10_000,
};

/**
 * Returns the annual allowance after the high-income taper.
 *
 * HMRC definitions (simplified — salary sacrifice already reduces threshold
 * income, and sacrificed amounts count back into adjusted income):
 *   threshold income = taxable earnings after salary-sacrifice contributions
 *   adjusted income  = threshold income + ALL pension contributions
 *
 * The taper applies only when BOTH limits are exceeded; the allowance then
 * falls by £1 per £2 of adjusted income above £260,000, floored at £10,000.
 *
 * @param {number} thresholdIncome - Income after salary sacrifice (>= 0)
 * @param {number} adjustedIncome  - thresholdIncome + total pension contributions (>= 0)
 * @returns {number} Annual allowance in GBP for the year
 */
export function taperedAnnualAllowance(thresholdIncome, adjustedIncome) {
  assertNonNegativeFinite(thresholdIncome, 'thresholdIncome');
  assertNonNegativeFinite(adjustedIncome, 'adjustedIncome');
  const {
    annualAllowance,
    taperAdjustedIncomeLimit,
    taperThresholdIncomeLimit,
    minAnnualAllowance,
  } = PENSION_CONSTANTS;
  if (thresholdIncome <= taperThresholdIncomeLimit || adjustedIncome <= taperAdjustedIncomeLimit)
    return annualAllowance;
  const reduction = Math.floor((adjustedIncome - taperAdjustedIncomeLimit) / 2);
  return Math.max(minAnnualAllowance, annualAllowance - reduction);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
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
 * Tax-optimal EMPLOYEE pension contribution (salary sacrifice) for one year.
 *
 * "Tax-optimal" here means: sacrifice enough salary to strip out every pound
 * that would otherwise be taxed above the basic rate — i.e. bring taxable pay
 * down to the higher-rate threshold (£50,270 in 2025/26). This single move
 * captures relief on, in order of value:
 *   • the 60% effective band where the personal allowance tapers (£100,000–£125,140),
 *   • the 45% additional-rate band (above £125,140),
 *   • the 40% higher-rate band (£50,270–£100,000),
 * plus the 8% → 2% step in employee National Insurance, which falls away at the
 * Upper Earnings Limit (coinciding with the higher-rate threshold). Below
 * £50,270 a further pound of sacrifice earns only 20% income-tax relief, so the
 * threshold is the natural stopping point.
 *
 * Two hard limits apply:
 *   • The annual allowance caps TOTAL (employee + employer) contributions at
 *     £60,000, tapered down to £10,000 for high earners. The employee figure is
 *     reduced so employee + employer never exceeds the (tapered) allowance.
 *   • The sacrifice never takes taxable pay below the personal allowance
 *     (£12,570): pounds inside the personal allowance bear no income tax, so
 *     sacrificing them earns no income-tax relief. (For the default higher-rate
 *     target this floor never binds; it guards a custom targetIncome.)
 *
 * Employer contributions are "free money" added on top of salary. How they
 * enter the calculation depends on employerMatch:
 *   • Unconditional (default): the employer always pays employerRate of gross,
 *     independent of the employee's choice — relevant here only because it
 *     consumes part of the shared annual allowance.
 *   • Matched: the employer pays min(employerRate, employeeRate) of gross, so a
 *     larger employee contribution unlocks more employer money (up to the cap).
 *     The solver then contributes AT LEAST the match cap even when the pure
 *     tax-relief argument would suggest less (e.g. a basic-rate taxpayer whose
 *     tax-optimal sacrifice is zero should still contribute up to the cap,
 *     because the employer money it unlocks dwarfs the relief forgone).
 *
 * The annual allowance is the one place where maximising the match can bite: a
 * matched contribution counts twice toward the cap (employee + equal employer),
 * so £1 of employee sacrifice consumes £2 of allowance below the cap. When the
 * cap alone would breach the allowance (2 × cap > allowance) the solver settles
 * at allowance ÷ 2 each side — the most match the allowance permits — rather
 * than exceeding the cap (which would incur an annual-allowance charge on money
 * that never received relief). It never recommends breaching the allowance.
 *
 * The solver works from a single year's gross salary at today's thresholds
 * (pass scaleFactor to model fiscal drag). It does not optimise across future
 * years of wage growth, and deliberately ignores affordability: it reports the
 * tax-optimal contribution, which a saver may choose to cap at what their
 * take-home can support.
 *
 * @param {number} grossIncome - Gross annual employment income in GBP (>= 0)
 * @param {number} employerRate - Employer contribution as a fraction of gross
 *                                (0–1). With employerMatch, the maximum matched rate.
 * @param {{
 *   scaleFactor?:   number,   - Threshold scale factor for fiscal drag (> 0, default 1)
 *   targetIncome?:  number,   - Override the taxable-pay target the solver aims
 *                              for (GBP). Defaults to the scaled higher-rate
 *                              threshold; floored at the personal allowance.
 *   employerMatch?: boolean   - Treat employerRate as a match cap: employer pays
 *                              min(employerRate, employeeRate). Default false.
 * }} [options]
 * @returns {{
 *   grossIncome:           number,
 *   employerRate:          number,
 *   employerMatched:       boolean,   - Whether the employer contribution was matched
 *   targetIncome:          number,    - Taxable pay the solver aimed to reach
 *   employeeRate:          number,    - Optimal employee fraction of gross (0–1)
 *   employeeContribution:  number,    - Optimal employee contribution (£)
 *   employerContribution:  number,    - Resulting employer contribution (£)
 *   effectiveEmployerRate: number,    - employerContribution / gross (0–1)
 *   totalContribution:     number,    - employee + employer (£)
 *   adjustedGrossIncome:   number,    - grossIncome − employeeContribution (£)
 *   annualAllowance:       number,    - (Tapered) allowance applied (£)
 *   cappedByAllowance:     boolean,   - True if the annual allowance limited the sacrifice
 *   bandsCleared:          string[],  - High-tax bands the sacrifice escapes (top-down):
 *                                       'additionalRate' | 'paTaper' | 'higherRate'
 *   scaleFactor:           number,
 *   taxYear:               string
 * }}
 */
export function optimalEmployeePensionContribution(grossIncome, employerRate, options = {}) {
  assertNonNegativeFinite(grossIncome, 'grossIncome');
  if (
    typeof employerRate !== 'number' ||
    !isFinite(employerRate) ||
    employerRate < 0 ||
    employerRate > 1
  )
    throw new RangeError('employerRate must be a number between 0 and 1');

  const { scaleFactor = 1, targetIncome: targetOverride, employerMatch = false } = options;
  if (typeof scaleFactor !== 'number' || !isFinite(scaleFactor) || scaleFactor <= 0)
    throw new RangeError('scaleFactor must be a positive finite number');
  if (typeof employerMatch !== 'boolean')
    throw new TypeError('options.employerMatch must be a boolean');

  const personalAllowance = round2(INCOME_TAX_BANDS.personalAllowance * scaleFactor);
  const higherRateThreshold = round2(INCOME_TAX_BANDS.basicRateLimit * scaleFactor);
  const additionalRateThreshold = round2(INCOME_TAX_BANDS.additionalRateThreshold * scaleFactor);
  const taperThreshold = round2(INCOME_TAX_BANDS.taperThreshold * scaleFactor);

  // Default target: strip out all income taxed above the basic rate.
  let targetIncome = targetOverride ?? higherRateThreshold;
  if (typeof targetIncome !== 'number' || !isFinite(targetIncome) || targetIncome < 0)
    throw new RangeError('options.targetIncome must be a non-negative finite number');
  // Never sacrifice below the personal allowance — no income-tax relief there.
  targetIncome = Math.max(targetIncome, personalAllowance);

  // The match cap in £ — the most the employer will contribute. With matching
  // the actual employer contribution is min(capAmt, employee); without it the
  // employer always pays capAmt regardless of the employee's choice.
  const capAmt = round2(grossIncome * employerRate);
  const employerAmountFor = (employee) => (employerMatch ? Math.min(capAmt, employee) : capAmt);

  // Sacrifice needed to reach the tax target (0 if pay is already at/below it).
  const taxDrivenEmployee = Math.max(0, round2(grossIncome - targetIncome));

  // With matching, always contribute at least the match cap: the free employer
  // money it unlocks dwarfs the basic-rate relief forgone on the extra
  // sacrifice. Without matching there is no such incentive, so aim only at the
  // tax target.
  const desiredEmployee = employerMatch ? Math.max(taxDrivenEmployee, capAmt) : taxDrivenEmployee;

  // Largest employee contribution whose total (employee + employer) stays within
  // the allowance. With matching, total is 2·employee below the cap and
  // employee + capAmt above it, so the ceiling is allowance ÷ 2 when the cap
  // alone would already breach (2·capAmt > allowance) and allowance − capAmt
  // otherwise. Without matching the employer is fixed, so it is allowance − capAmt.
  const maxEmployeeFor = (allowance) =>
    employerMatch && 2 * capAmt > allowance
      ? Math.max(0, round2(allowance / 2))
      : Math.max(0, round2(allowance - capAmt));

  // Threshold income (gross − employee) and, when matching, the employer amount
  // both move with the sacrifice, and the allowance taper depends on both: a
  // larger sacrifice can lift the allowance (lower threshold income) while a
  // larger match can lower it (higher adjusted income). Resolve the mutual
  // dependence with a fixed-point iteration.
  let employeeContribution = desiredEmployee;
  for (let i = 0; i < 16; i++) {
    const thresholdIncome = Math.max(0, round2(grossIncome - employeeContribution));
    // Adjusted income = threshold income + all contributions = gross + employer.
    const adjustedIncome = round2(grossIncome + employerAmountFor(employeeContribution));
    const allowance = taperedAnnualAllowance(thresholdIncome, adjustedIncome);
    const next = Math.min(desiredEmployee, maxEmployeeFor(allowance));
    if (Math.abs(next - employeeContribution) < 0.005) {
      employeeContribution = next;
      break;
    }
    employeeContribution = next;
  }

  const employerContribution = round2(employerAmountFor(employeeContribution));
  // Allowance consistent with the settled contribution.
  const finalThresholdIncome = Math.max(0, round2(grossIncome - employeeContribution));
  const annualAllowance = taperedAnnualAllowance(
    finalThresholdIncome,
    round2(grossIncome + employerContribution)
  );

  const cappedByAllowance = employeeContribution + 0.005 < desiredEmployee;
  const adjustedGrossIncome = round2(grossIncome - employeeContribution);
  const employeeRate = grossIncome > 0 ? round4(employeeContribution / grossIncome) : 0;
  const effectiveEmployerRate = grossIncome > 0 ? round4(employerContribution / grossIncome) : 0;

  // Which high-tax bands the sacrifice actually escapes: a band [lo, hi) is
  // (partly) cleared when some removed income lay inside it.
  const removedIn = (lo, hi) =>
    round2(Math.min(grossIncome, hi) - Math.max(adjustedGrossIncome, lo)) > 0.005;
  const bandsCleared = [];
  if (removedIn(additionalRateThreshold, Infinity)) bandsCleared.push('additionalRate');
  if (removedIn(taperThreshold, additionalRateThreshold)) bandsCleared.push('paTaper');
  if (removedIn(higherRateThreshold, taperThreshold)) bandsCleared.push('higherRate');

  return {
    grossIncome: round2(grossIncome),
    employerRate,
    employerMatched: employerMatch,
    targetIncome,
    employeeRate,
    employeeContribution,
    employerContribution,
    effectiveEmployerRate,
    totalContribution: round2(employeeContribution + employerContribution),
    adjustedGrossIncome,
    annualAllowance,
    cappedByAllowance,
    bandsCleared,
    scaleFactor,
    taxYear: TAX_YEAR,
  };
}

/**
 * Projects a DC pension during the accumulation (pre-retirement) phase.
 *
 * @param {number} initialBalance - Opening pot value in GBP (>= 0)
 * @param {Array<{
 *   growthRate:              number,   - Annual growth as a decimal (e.g. 0.06 = 6%).
 *                                        May be negative (falling markets), min −1.
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

    if (typeof growthRate !== 'number' || !isFinite(growthRate) || growthRate < -1)
      throw new TypeError(`year ${year} growthRate must be a finite number >= -1`);
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
 *   growthRate:     number,          - Annual growth as a decimal (>= −1; may be negative)
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

    if (typeof growthRate !== 'number' || !isFinite(growthRate) || growthRate < -1)
      throw new TypeError(`year ${year} growthRate must be a finite number >= -1`);
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
