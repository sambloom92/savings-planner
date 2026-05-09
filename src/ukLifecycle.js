/**
 * Whole-of-life financial lifecycle projection module
 *
 * Projects an individual's financial position across all major pots
 * (pension, ISA, GIA, mortgage, unsecured debts, student loan) from
 * the current year to their nominated retirement age.
 *
 * Income allocation priority each year (most tax-efficient first):
 *   1. Employee pension contributions via salary sacrifice
 *      — reduces both income tax and employee NI
 *   2. ISA contributions up to the £20,000 annual limit (tax-free growth)
 *   3. GIA contributions with remaining surplus
 *
 * Fixed debt payments (mortgage and unsecured) are deducted before
 * any ISA/GIA allocation.  Payments cease automatically once a debt
 * is fully repaid, freeing up cash for savings.
 *
 * State pension: pro-rated on total NI qualifying years (initial years
 * supplied plus one per working year above the LEL).  Eligible from
 * statePensionAge (default 67); requires ≥10 qualifying years for any
 * entitlement, 35 years for the full amount.
 *
 * Student loan interest is applied annually (annual rate × balance);
 * write-off occurs in the year the loan age reaches the plan limit.
 *
 * Sources:
 *   gov.uk/income-tax-rates
 *   gov.uk/national-insurance
 *   gov.uk/new-state-pension
 */

import { calculateIncomeTax } from './ukIncomeTax.js';
import { calculateNationalInsurance } from './ukNationalInsurance.js';
import {
  calculateStudentLoan,
  calculateAnnualInterestRate,
  STUDENT_LOAN_PLANS,
} from './ukStudentLoan.js';
import { calculateMonthlyMortgagePayment } from './ukDebt.js';
import { ISA_CONSTANTS } from './ukISA.js';
import { PENSION_CONSTANTS, calculatePCLS } from './ukPension.js';
import { GIA_CGT_CONSTANTS } from './ukGIA.js';

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

export const LIFECYCLE_CONSTANTS = {
  statePension: {
    fullAnnualAmount: 11_502.4, // 2025/26: £221.20/week × 52
    qualifyingYearsForFull: 35,
    minimumQualifyingYears: 10,
    defaultStatePensionAge: 67,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertNonNegativeFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
}

function assertFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value))
    throw new TypeError(`${name} must be a finite number`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
}

/** Pro-rate the state pension on qualifying NI years. */
function computeStatePension(niYears) {
  const { fullAnnualAmount, qualifyingYearsForFull, minimumQualifyingYears } =
    LIFECYCLE_CONSTANTS.statePension;
  if (niYears < minimumQualifyingYears) return 0;
  const capped = Math.min(niYears, qualifyingYearsForFull);
  return round2((capped / qualifyingYearsForFull) * fullAnnualAmount);
}

/**
 * Run 12 monthly interest + payment cycles for a repayment debt.
 * Stops early if the balance reaches zero.
 */
function amortiseYear(balance, monthlyRate, monthlyPayment, monthlyOverpayment = 0) {
  let b = balance;
  let yearInterest = 0;
  let yearCapital = 0;
  let yearPayment = 0;

  for (let m = 0; m < 12; m++) {
    if (b <= 0) break;
    const interest = round2(b * monthlyRate);
    const totalPmt = monthlyPayment + monthlyOverpayment;
    const capitalRepaid = round2(Math.min(totalPmt - interest, b));
    const actualPayment = interest + capitalRepaid;
    b = round2(b - capitalRepaid);
    yearInterest += interest;
    yearCapital += capitalRepaid;
    yearPayment += actualPayment;
  }

  return {
    interestCharged: round2(yearInterest),
    capitalRepaid: round2(yearCapital),
    payment: round2(yearPayment),
    closingBalance: b,
  };
}

// ── Return-tapering ─────────────────────────────────────────────────────────

const TAPER_BEFORE_YEARS = 10; // start de-risking this many years before retirement
const TAPER_AFTER_YEARS = 5; // fully de-risked this many years after retirement

/**
 * Returns the interpolated investment return rate for a given age.
 * Linearly tapers from accRate to retRate over the window
 * [retirementAge - TAPER_BEFORE_YEARS, retirementAge + TAPER_AFTER_YEARS].
 * Outside that window the rate is clamped to accRate or retRate respectively.
 */
function getRateForAge(age, retirementAge, accRate, retRate) {
  if (accRate === retRate) return accRate;
  const taperStart = retirementAge - TAPER_BEFORE_YEARS;
  const taperEnd = retirementAge + TAPER_AFTER_YEARS;
  const t = Math.max(0, Math.min(1, (age - taperStart) / (taperEnd - taperStart)));
  return accRate + t * (retRate - accRate);
}

// ── Retirement-phase helpers ─────────────────────────────────────────────────

// UK income tax personal allowance (2025/26)
const PERSONAL_ALLOWANCE = 12_570;

/**
 * Binary-search for the gross pension withdrawal that, after marginal income
 * tax on top of otherIncome, yields exactly netTarget net.
 */
function pensionGrossForNet(netTarget, maxBalance, otherIncome, scaleFactor = 1) {
  if (netTarget <= 0 || maxBalance <= 0) return 0;
  let lo = 0,
    hi = Math.min(maxBalance, netTarget + 300_000);
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const margTax =
      calculateIncomeTax(otherIncome + mid, scaleFactor).totalTax -
      calculateIncomeTax(otherIncome, scaleFactor).totalTax;
    if (mid - margTax < netTarget) lo = mid;
    else hi = mid;
  }
  return Math.min(round2((lo + hi) / 2), maxBalance);
}

/**
 * Binary-search gross UFPLS withdrawal needed to achieve a target net amount.
 * Under UFPLS each £1 withdrawn is min(25%, lsaRemaining/gross) tax-free + the
 * remainder taxable income.  Pass lsaRemaining = Infinity (default) to ignore the
 * Lump Sum Allowance cap (all withdrawals treated as 25% tax-free).
 */
function ufplsGrossForNet(
  netTarget,
  maxBalance,
  otherIncome,
  scaleFactor = 1,
  lsaRemaining = Infinity
) {
  if (netTarget <= 0 || maxBalance <= 0) return 0;
  let lo = 0,
    hi = Math.min(maxBalance, netTarget + 300_000);
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const taxFree = Math.min(0.25 * mid, lsaRemaining);
    const taxableIncome = mid - taxFree;
    const margTax =
      calculateIncomeTax(otherIncome + taxableIncome, scaleFactor).totalTax -
      calculateIncomeTax(otherIncome, scaleFactor).totalTax;
    if (mid - margTax < netTarget) lo = mid;
    else hi = mid;
  }
  return Math.min(round2((lo + hi) / 2), maxBalance);
}

/**
 * CGT due on a gross GIA withdrawal.
 * annualExempt defaults to the published annual exempt amount; pass a lower
 * value (including 0) when part of the exemption has already been used
 * elsewhere in the same tax year.
 */
function computeGIACGT(
  gross,
  bal,
  costBasis,
  otherIncome,
  annualExempt = GIA_CGT_CONSTANTS.annualExemptAmount
) {
  if (gross <= 0 || bal <= 0) return 0;
  const gainFrac = Math.max(0, (bal - costBasis) / bal);
  const totalGain = gross * gainFrac; // keep unrounded — intermediate value used in subtraction
  const taxable = Math.max(0, totalGain - annualExempt);
  const basicRoom = Math.max(0, GIA_CGT_CONSTANTS.basicRateLimit - otherIncome);
  const atBasic = Math.min(taxable, basicRoom);
  const atHigher = taxable - atBasic;
  return round2(atBasic * GIA_CGT_CONSTANTS.basicRate + atHigher * GIA_CGT_CONSTANTS.higherRate);
}

/**
 * Binary-search for the gross GIA withdrawal that, after CGT, yields
 * exactly netTarget net.
 */
function giaGrossForNet(netTarget, bal, costBasis, otherIncome, annualExempt = 0) {
  if (netTarget <= 0 || bal <= 0) return 0;
  // When there are no gains, net equals gross
  if (costBasis >= bal) return Math.min(netTarget, bal);
  let lo = 0,
    hi = bal;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const cgt = computeGIACGT(mid, bal, costBasis, otherIncome, annualExempt);
    if (mid - cgt < netTarget) lo = mid;
    else hi = mid;
  }
  return Math.min(round2((lo + hi) / 2), bal);
}

/** Reduce GIA balance and cost basis proportionally after a gross withdrawal. */
function applyGIAWithdrawal(bal, costBasis, gross) {
  if (gross <= 0 || bal <= 0) return { bal, costBasis };
  const frac = gross / bal;
  return { bal: round2(bal - gross), costBasis: round2(costBasis * (1 - frac)) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Projects an individual's whole-of-life financial position year by year
 * from the current year to their nominated retirement age.
 *
 * @param {{
 *   currentAge:           number,         - Current age in whole years
 *   retirementAge:        number,         - Target retirement age (> currentAge)
 *   currentYear?:         number,         - Starting calendar year (default 2025)
 *   grossIncome:          number,         - Current annual gross employment income (£)
 *   employeePensionRate:  number,         - Employee pension as fraction of gross (0–1)
 *   employerPensionRate:  number,         - Employer pension as fraction of gross (0–1)
 *   niContributionYears:  number,         - Existing NI qualifying years already accrued
 *   statePensionAge?:     number,         - State pension age (default 67)
 *   studentLoanPlan?:     string | null   - 'plan1'|'plan2'|'plan4'|'plan5'|'postgrad'|null
 * }} profile
 *
 * @param {{
 *   savingsRate:      number,   - Annual growth for pension, ISA and GIA (e.g. 0.07)
 *   wageGrowthRate:   number,   - Annual gross salary growth (e.g. 0.03; may be negative)
 *   mortgageRate?:    number,   - Annual interest rate on mortgage (defaults to debtRate)
 *   unsecuredRate?:   number,   - Annual interest rate on unsecured debts (defaults to debtRate)
 *   debtRate?:        number,   - Legacy fallback rate for both mortgage and unsecured (default 0)
 *   inflationRate:    number,   - RPI proxy used for student loan interest
 *   boeRate?:         number,   - BoE base rate for Plan 1 student loan cap (default 0.0475)
 * }} rates
 *
 * @param {{
 *   pensionBalance?:  number,   - Existing pension pot value (default 0)
 *   isaBalance?:      number,   - Existing ISA balance (default 0)
 *   giaBalance?:      number,   - Existing GIA market value (default 0)
 *   giaCostBasis?:    number,   - GIA cost basis for CGT purposes (default = giaBalance)
 *   mortgage?: {
 *     balance:              number,  - Outstanding mortgage balance
 *     termYears:            number,  - Remaining mortgage term in whole years
 *     type?:                string,  - 'repayment' (default) or 'interest-only'
 *     monthlyOverpayment?:  number
 *   } | null,
 *   unsecuredDebts?: Array<{
 *     balance:        number,
 *     monthlyPayment: number,
 *     label?:         string
 *   }>,
 *   studentLoan?: {
 *     balance:              number,
 *     repaymentStartYear?:  number   - Year repayments began (default = currentYear)
 *   } | null
 * }} [pots]
 *
 * @param {{
 *   targetNetAnnualExpenses: number,  - Desired net annual spending at today's prices (£)
 *   maxAge?:                 number,  - Project retirement to this age (default 90)
 *   takePCLS?:               boolean, - Take pension commencement lump sum (default false)
 *   pclsPercentage?:         number,  - Fraction of pension to take as PCLS (0–0.25, default 0.25)
 * } | null} [retirementOptions]
 *
 * @returns {{
 *   startYear:          number,
 *   retirementYear:     number,
 *   yearlyBreakdown:    Array<object>,
 *   summary:            object,
 *   hasRetirementPhase: boolean,
 *   taxYear:            string
 * }}
 */
export function projectLifecycle(
  profile,
  rates,
  pots = {},
  retirementOptions = null,
  yearlyRatesOverride = null
) {
  // ── Validate profile ────────────────────────────────────────────────────
  const {
    currentAge,
    retirementAge,
    currentYear = 2025,
    grossIncome,
    annualSavings = null, // fixed annual ISA+GIA savings in £ (real terms); if null, derived from salary
    employeePensionRate,
    employerPensionRate,
    niContributionYears,
    statePensionAge = LIFECYCLE_CONSTANTS.statePension.defaultStatePensionAge,
    studentLoanPlan = null,
  } = profile;

  assertPositiveInteger(currentAge, 'currentAge');
  assertPositiveInteger(retirementAge, 'retirementAge');
  if (retirementAge <= currentAge)
    throw new RangeError('retirementAge must be greater than currentAge');
  if (!Number.isInteger(currentYear) || currentYear < 1990)
    throw new RangeError('currentYear must be an integer >= 1990');

  assertNonNegativeFinite(grossIncome, 'grossIncome');
  assertNonNegativeFinite(employeePensionRate, 'employeePensionRate');
  assertNonNegativeFinite(employerPensionRate, 'employerPensionRate');
  if (employeePensionRate > 1) throw new RangeError('employeePensionRate must be <= 1');
  if (employerPensionRate > 1) throw new RangeError('employerPensionRate must be <= 1');

  assertNonNegativeInteger(niContributionYears, 'niContributionYears');
  assertPositiveInteger(statePensionAge, 'statePensionAge');

  if (studentLoanPlan !== null && !STUDENT_LOAN_PLANS[studentLoanPlan])
    throw new TypeError(`studentLoanPlan '${studentLoanPlan}' is not a recognised plan`);

  // ── Validate rates ───────────────────────────────────────────────────────
  const {
    savingsRate,
    wageGrowthRate,
    debtRate = 0, // legacy fallback; prefer mortgageRate / unsecuredRate
    mortgageRate: _mortgageRate,
    unsecuredRate: _unsecuredRate,
    inflationRate,
    boeRate = 0.0475,
    retirementRate = savingsRate, // defaults to savingsRate → no taper
    fiscalDragRate = 0, // 0 = bands keep pace with inflation; positive = bracket creep
  } = rates;

  const mortgageRate = _mortgageRate ?? debtRate;
  const unsecuredRate = _unsecuredRate ?? debtRate;

  assertFinite(savingsRate, 'savingsRate');
  assertFinite(retirementRate, 'retirementRate');
  assertFinite(wageGrowthRate, 'wageGrowthRate');
  assertNonNegativeFinite(mortgageRate, 'mortgageRate');
  assertNonNegativeFinite(unsecuredRate, 'unsecuredRate');
  assertFinite(inflationRate, 'inflationRate');
  assertFinite(boeRate, 'boeRate');
  assertFinite(fiscalDragRate, 'fiscalDragRate');

  // ── Validate and initialise pots ─────────────────────────────────────────
  const {
    pensionBalance: initialPension = 0,
    isaBalance: initialISA = 0,
    giaBalance: initialGIA = 0,
    giaCostBasis: initialGIACostBasis = undefined,
    mortgage: mortgageConfig = null,
    unsecuredDebts: unsecuredConfig = [],
    studentLoan: studentLoanConfig = null,
  } = pots;

  assertNonNegativeFinite(initialPension, 'pensionBalance');
  assertNonNegativeFinite(initialISA, 'isaBalance');
  assertNonNegativeFinite(initialGIA, 'giaBalance');

  const initialCostBasis = initialGIACostBasis ?? initialGIA;
  assertNonNegativeFinite(initialCostBasis, 'giaCostBasis');

  // Mortgage
  let mortgageBalance = 0;
  let mortgageMonthlyPayment = 0;
  let mortgageMonthlyOverpayment = 0;
  let mortgageMonthlyRate = 0;
  let mortgageType = 'repayment';
  let hasMortgage = false;

  if (mortgageConfig != null) {
    assertNonNegativeFinite(mortgageConfig.balance, 'mortgage.balance');
    assertPositiveInteger(mortgageConfig.termYears, 'mortgage.termYears');
    if (mortgageConfig.monthlyOverpayment != null)
      assertNonNegativeFinite(mortgageConfig.monthlyOverpayment, 'mortgage.monthlyOverpayment');

    mortgageType = mortgageConfig.type ?? 'repayment';
    if (mortgageType !== 'repayment' && mortgageType !== 'interest-only')
      throw new TypeError("mortgage.type must be 'repayment' or 'interest-only'");

    mortgageBalance = round2(mortgageConfig.balance);
    mortgageMonthlyRate = mortgageRate / 12;
    mortgageMonthlyOverpayment = mortgageConfig.monthlyOverpayment ?? 0;

    if (mortgageType === 'interest-only') {
      mortgageMonthlyPayment = round2(mortgageBalance * mortgageMonthlyRate);
    } else {
      mortgageMonthlyPayment =
        mortgageRate === 0
          ? round2(mortgageBalance / (mortgageConfig.termYears * 12))
          : calculateMonthlyMortgagePayment(
              mortgageBalance,
              mortgageRate,
              mortgageConfig.termYears
            );
    }
    hasMortgage = mortgageBalance > 0;
  }

  // Unsecured debts
  if (!Array.isArray(unsecuredConfig)) throw new TypeError('unsecuredDebts must be an array');

  const debtMonthlyRate = unsecuredRate / 12;
  const debts = unsecuredConfig.map((d, idx) => {
    assertNonNegativeFinite(d.balance, `unsecuredDebts[${idx}].balance`);
    assertNonNegativeFinite(d.monthlyPayment, `unsecuredDebts[${idx}].monthlyPayment`);
    const initialMonthlyInterest = round2(d.balance * debtMonthlyRate);
    if (d.balance > 0 && d.monthlyPayment <= initialMonthlyInterest)
      throw new RangeError(
        `unsecuredDebts[${idx}]: monthlyPayment (£${d.monthlyPayment}) must exceed ` +
          `initial monthly interest (£${initialMonthlyInterest})`
      );
    return {
      label: d.label ?? `Unsecured debt ${idx + 1}`,
      balance: round2(d.balance),
      monthlyPayment: d.monthlyPayment,
    };
  });

  // Student loan
  let slBalance = 0;
  let slWriteOffYear = Infinity;
  let hasStudentLoan = false;

  if (studentLoanPlan !== null && studentLoanConfig != null && studentLoanConfig.balance > 0) {
    assertNonNegativeFinite(studentLoanConfig.balance, 'studentLoan.balance');
    slBalance = round2(studentLoanConfig.balance);
    const repaymentStartYear = studentLoanConfig.repaymentStartYear ?? currentYear;
    if (!Number.isInteger(repaymentStartYear) || repaymentStartYear < 1990)
      throw new RangeError('studentLoan.repaymentStartYear must be an integer >= 1990');
    slWriteOffYear = repaymentStartYear + STUDENT_LOAN_PLANS[studentLoanPlan].writeOffYears;
    hasStudentLoan = true;
  }

  // ── Projection state ─────────────────────────────────────────────────────
  const { annualSubscriptionLimit: ISA_LIMIT } = ISA_CONSTANTS;

  const yearsToRetirement = retirementAge - currentAge;
  const retirementYear = currentYear + yearsToRetirement;

  let pensionBal = round2(initialPension);
  let isaBal = round2(initialISA);
  let giaBal = round2(initialGIA);
  let costBasis = round2(initialCostBasis);
  let income = round2(grossIncome);
  let niYears = niContributionYears;

  const yearlyBreakdown = [];

  // Running cumulative factors for year-by-year rate variation.
  // When yearlyRatesOverride is null these reproduce the same values as Math.pow().
  let cumulInflation = 1; // product of (1 + inflRate) from year 1..i
  let thresholdScale = 1; // product of (1 + inflRate - fiscalDragRate) from year 1..i
  let cumulTriplelock = 1; // product of (1 + max(wages,CPI,2.5%)) from year 1..i

  // ── Annual loop ──────────────────────────────────────────────────────────
  for (let i = 0; i < yearsToRetirement; i++) {
    const year = currentYear + i;
    const age = currentAge + i;

    // Per-year rates (merge base + optional override for year i)
    const yr =
      yearlyRatesOverride?.[i] != null
        ? {
            savingsRate,
            retirementRate,
            wageGrowthRate,
            inflationRate,
            boeRate,
            ...yearlyRatesOverride[i],
          }
        : { savingsRate, retirementRate, wageGrowthRate, inflationRate, boeRate };
    const yrTriplelock = Math.max(yr.wageGrowthRate, yr.inflationRate, 0.025);

    // Update running products (i=0 leaves them at 1, matching Math.pow(..., 0)=1)
    if (i > 0) {
      cumulInflation *= 1 + yr.inflationRate;
      thresholdScale *= 1 + yr.inflationRate - fiscalDragRate;
      cumulTriplelock *= 1 + yrTriplelock;
    }

    // Wage growth applies from year 1 onwards; floor at 0 (salary cannot go negative)
    if (i > 0) income = Math.max(0, round2(income * (1 + yr.wageGrowthRate)));

    // ── Pension (salary sacrifice) ──────────────────────────────────────
    const employeeContrib = round2(income * employeePensionRate);
    const employerContrib = round2(income * employerPensionRate);
    const totalPensionContrib = round2(employeeContrib + employerContrib);
    const annualAllowanceBreached = totalPensionContrib > PENSION_CONSTANTS.annualAllowance;

    // Adjusted gross income after salary sacrifice
    const adjustedGross = round2(income - employeeContrib);

    // ── Tax and NI (on adjustedGross, with fiscal-drag-adjusted thresholds) ──
    // thresholdScale > 1 means bands have grown (less drag); < 1 means compressed (more drag).
    const taxResult = calculateIncomeTax(adjustedGross, thresholdScale);
    const niResult = calculateNationalInsurance(adjustedGross, thresholdScale);
    const incomeTax = taxResult.totalTax;
    const employeeNI = niResult.employeeNI.total;
    const employerNI = niResult.employerNI.contribution; // informational

    // ── Student loan ────────────────────────────────────────────────────
    let slRepayment = 0;
    let slRow = null;

    if (hasStudentLoan) {
      if (slBalance <= 0) {
        slRow = {
          openingBalance: 0,
          interestRate: 0,
          interestCharged: 0,
          repayment: 0,
          closingBalance: 0,
          writtenOff: false,
        };
      } else if (year >= slWriteOffYear) {
        slRow = {
          openingBalance: slBalance,
          interestRate: 0,
          interestCharged: 0,
          repayment: 0,
          closingBalance: 0,
          writtenOff: true,
        };
        slBalance = 0;
      } else {
        const slInterestRate = calculateAnnualInterestRate(
          studentLoanPlan,
          adjustedGross,
          yr.inflationRate,
          yr.boeRate
        );
        const interestCharged = round2(slBalance * slInterestRate);
        const balanceAfterInt = round2(slBalance + interestCharged);
        const planRepayment = calculateStudentLoan(adjustedGross, studentLoanPlan).repayment;
        slRepayment = Math.min(planRepayment, balanceAfterInt);
        const closingSL = round2(Math.max(0, balanceAfterInt - slRepayment));
        slRow = {
          openingBalance: slBalance,
          interestRate: slInterestRate,
          interestCharged,
          repayment: slRepayment,
          closingBalance: closingSL,
          writtenOff: false,
        };
        slBalance = closingSL;
      }
    }

    // ── Net take-home ───────────────────────────────────────────────────
    const netTakeHome = round2(income - employeeContrib - incomeTax - employeeNI - slRepayment);

    // ── Debt payments ───────────────────────────────────────────────────
    // Mortgage
    let mortgageRow = null;
    let mortgagePaymentThisYear = 0;

    if (hasMortgage) {
      const openingMortgage = mortgageBalance;
      if (mortgageBalance <= 0) {
        mortgageRow = {
          openingBalance: 0,
          interestCharged: 0,
          capitalRepaid: 0,
          payment: 0,
          closingBalance: 0,
          type: mortgageType,
        };
      } else if (mortgageType === 'interest-only') {
        let yearInt = 0;
        for (let m = 0; m < 12; m++) {
          yearInt += round2(mortgageBalance * mortgageMonthlyRate);
        }
        yearInt = round2(yearInt);
        mortgagePaymentThisYear = yearInt;
        mortgageRow = {
          openingBalance: openingMortgage,
          interestCharged: yearInt,
          capitalRepaid: 0,
          payment: yearInt,
          closingBalance: mortgageBalance,
          type: 'interest-only',
        };
      } else {
        const amort = amortiseYear(
          mortgageBalance,
          mortgageMonthlyRate,
          mortgageMonthlyPayment,
          mortgageMonthlyOverpayment
        );
        mortgagePaymentThisYear = amort.payment;
        mortgageBalance = amort.closingBalance;
        mortgageRow = {
          openingBalance: openingMortgage,
          interestCharged: amort.interestCharged,
          capitalRepaid: amort.capitalRepaid,
          payment: amort.payment,
          closingBalance: mortgageBalance,
          type: 'repayment',
        };
      }
    }

    // Unsecured debts
    let unsecuredPaymentsThisYear = 0;
    const debtRows = debts.map((debt) => {
      const openingDebt = debt.balance;
      if (openingDebt <= 0) {
        return {
          label: debt.label,
          openingBalance: 0,
          interestCharged: 0,
          capitalRepaid: 0,
          payment: 0,
          closingBalance: 0,
        };
      }
      const amort = amortiseYear(debt.balance, debtMonthlyRate, debt.monthlyPayment);
      debt.balance = amort.closingBalance;
      unsecuredPaymentsThisYear = round2(unsecuredPaymentsThisYear + amort.payment);
      return {
        label: debt.label,
        openingBalance: openingDebt,
        interestCharged: amort.interestCharged,
        capitalRepaid: amort.capitalRepaid,
        payment: amort.payment,
        closingBalance: amort.closingBalance,
      };
    });

    // ── Savings allocation (ISA first, then GIA) ────────────────────────
    const totalDebtPayments = round2(mortgagePaymentThisYear + unsecuredPaymentsThisYear);
    // If a fixed annualSavings amount is supplied, use it (inflation-adjusted); otherwise
    // derive available savings from net take-home minus debt payments (legacy behaviour).
    let availableForSavings;
    if (annualSavings !== null) {
      availableForSavings = round2(annualSavings * cumulInflation);
    } else {
      availableForSavings = round2(netTakeHome - totalDebtPayments);
    }
    const isaContrib = round2(Math.min(Math.max(0, availableForSavings), ISA_LIMIT));
    const giaContrib = round2(Math.max(0, availableForSavings - isaContrib));

    // ── Bed and ISA (accumulation) ──────────────────────────────────────
    // Any remaining annual ISA headroom after new contributions is used to sell
    // existing GIA and rebuy inside the ISA (sheltering future growth from CGT).
    // CGT is realised now on any embedded gains; the annual exempt amount is
    // available because no other GIA disposals occur during accumulation.
    const accIsaHeadroom = round2(ISA_LIMIT - isaContrib);
    let accBedIsaGross = 0,
      accBedIsaCGT = 0,
      accBedIsaNet = 0;
    if (accIsaHeadroom > 0 && giaBal > 0) {
      // Gross up so the net amount landing in the ISA equals the full headroom.
      const accGrossNeeded = giaGrossForNet(
        accIsaHeadroom,
        giaBal,
        costBasis,
        adjustedGross,
        GIA_CGT_CONSTANTS.annualExemptAmount
      );
      accBedIsaGross = round2(Math.min(giaBal, accGrossNeeded));
      accBedIsaCGT = computeGIACGT(
        accBedIsaGross,
        giaBal,
        costBasis,
        adjustedGross,
        GIA_CGT_CONSTANTS.annualExemptAmount
      );
      accBedIsaNet = round2(accBedIsaGross - accBedIsaCGT);
      const after = applyGIAWithdrawal(giaBal, costBasis, accBedIsaGross);
      giaBal = after.bal;
      costBasis = after.costBasis;
      isaBal = round2(isaBal + accBedIsaNet);
    }

    // ── Pot growth ──────────────────────────────────────────────────────
    // Balances are floored at 0; negative growth (falling markets) cannot produce a negative pot.
    const yearRate = getRateForAge(age, retirementAge, yr.savingsRate, yr.retirementRate);

    const openingPension = pensionBal;
    const penAfterC = round2(pensionBal + employeeContrib + employerContrib);
    const pensionGrowth = round2(penAfterC * yearRate);
    pensionBal = Math.max(0, round2(penAfterC + pensionGrowth));

    // openingISA / openingGIA reflect the start of year (before bed-and-ISA);
    // growth is calculated on the post-bed-and-ISA, post-contribution balance.
    const openingISA = round2(isaBal - accBedIsaNet);
    const isaAfterC = round2(isaBal + isaContrib);
    const isaGrowth = round2(isaAfterC * yearRate);
    isaBal = Math.max(0, round2(isaAfterC + isaGrowth));

    const openingGIA = round2(giaBal + accBedIsaGross);
    const giaAfterC = round2(giaBal + giaContrib);
    const giaGrowth = round2(giaAfterC * yearRate);
    giaBal = Math.max(0, round2(giaAfterC + giaGrowth));
    costBasis = round2(costBasis + giaContrib);

    // ── NI qualifying year ──────────────────────────────────────────────
    // Use the scaled LEL from the NI result so fiscal drag affects the qualifying threshold too.
    const niQualifyingYear = adjustedGross >= niResult.employeeNI.lowerEarningsLimit;
    if (niQualifyingYear) niYears++;

    // ── Build row ───────────────────────────────────────────────────────
    yearlyBreakdown.push({
      year,
      age,

      grossIncome: income,
      employeeContribution: employeeContrib,
      employerContribution: employerContrib,
      adjustedGrossIncome: adjustedGross,
      annualAllowanceBreached,
      incomeTax,
      employeeNI,
      employerNI,
      studentLoanRepayment: slRepayment,
      netTakeHome,

      mortgagePayment: mortgagePaymentThisYear,
      unsecuredDebtPayments: unsecuredPaymentsThisYear,
      availableForSavings,

      isaContribution: isaContrib,
      giaContribution: giaContrib,

      investmentRate: round2(yearRate * 10000) / 10000,

      pension: {
        openingBalance: openingPension,
        employeeContribution: employeeContrib,
        employerContribution: employerContrib,
        growthAmount: pensionGrowth,
        closingBalance: pensionBal,
      },
      isa: {
        openingBalance: openingISA,
        contribution: isaContrib,
        bedIsaContrib: accBedIsaNet,
        growthAmount: isaGrowth,
        closingBalance: isaBal,
      },
      gia: {
        openingBalance: openingGIA,
        contribution: giaContrib,
        bedIsaGross: accBedIsaGross,
        bedIsaCGT: accBedIsaCGT,
        growthAmount: giaGrowth,
        closingBalance: giaBal,
        closingCostBasis: costBasis,
        unrealisedGain: round2(giaBal - costBasis),
      },
      bedIsa: { grossSold: accBedIsaGross, cgt: accBedIsaCGT, netContrib: accBedIsaNet },
      mortgage: mortgageRow,
      unsecuredDebts: debtRows,
      studentLoan: slRow,

      niQualifyingYear,
      cumulativeNIYears: niYears,
    });
  }

  // Retirement-entry snapshots — populated inside the retirement block, used in summary below.
  // Declared here so they are in scope at summary-build time regardless of whether a
  // retirement phase exists (null signals "no retirement phase").
  let retEntryPension = null;
  let retEntryISA = null;
  let retEntryGIA = null;
  let retEntryCostBasis = null;
  let retEntryMortgage = null;
  let retEntryUnsecured = null;

  // ── Retirement phase ─────────────────────────────────────────────────────
  if (retirementOptions != null) {
    const {
      targetNetAnnualExpenses,
      maxAge = 90,
      takePCLS = false,
      pclsPercentage = PENSION_CONSTANTS.maxPCLSPercentage,
    } = retirementOptions;

    assertNonNegativeFinite(targetNetAnnualExpenses, 'retirementOptions.targetNetAnnualExpenses');
    if (!Number.isInteger(maxAge) || maxAge <= retirementAge)
      throw new RangeError('retirementOptions.maxAge must be an integer > retirementAge');
    const pclsPct = Math.max(0, Math.min(PENSION_CONSTANTS.maxPCLSPercentage, pclsPercentage));

    // ── PCLS at retirement ──────────────────────────────────────────────────
    let pclsLumpSum = 0;
    let pclsCapped = false;
    let pclsToISA = 0; // ISA subscription headroom consumed by PCLS in retirement year 1
    if (takePCLS && pensionBal > 0) {
      const pclsResult = calculatePCLS(pensionBal, { pclsPercentage: pclsPct });
      pclsLumpSum = pclsResult.lumpSum;
      pclsCapped = pclsResult.lumpSumCapped;
      pensionBal = pclsResult.crystallisedFund;
      // Distribute: ISA up to annual subscription limit, remainder into GIA at cost
      const toISA = Math.min(pclsLumpSum, ISA_LIMIT);
      pclsToISA = toISA;
      const toGIA = round2(pclsLumpSum - toISA);
      isaBal = round2(isaBal + toISA);
      giaBal = round2(giaBal + toGIA);
      costBasis = round2(costBasis + toGIA);
    }

    // Snapshot balances at the point of retirement entry (after PCLS, before any drawdown).
    // The year-by-year loop mutates the running state variables, so by maxAge they may be
    // zero. The summary must reflect "what you have at retirement", not "what's left at maxAge".
    retEntryPension = pensionBal;
    retEntryISA = isaBal;
    retEntryGIA = giaBal;
    retEntryCostBasis = costBasis;
    retEntryMortgage = mortgageBalance;
    retEntryUnsecured = round2(debts.reduce((s, d) => s + d.balance, 0));

    // Track remaining Lump Sum Allowance across retirement years (UFPLS path only).
    // Under UFPLS the tax-free component of each withdrawal counts against this £268,275
    // lifetime cap; once exhausted, every £1 withdrawn becomes fully taxable income.
    // The PCLS path consumes the LSA upfront via calculatePCLS, so no tracking needed there.
    let remainingLSA = takePCLS ? 0 : PENSION_CONSTANTS.lumpSumAllowance;

    // ── Year-by-year loop ───────────────────────────────────────────────────
    for (let rAge = retirementAge; rAge <= maxAge; rAge++) {
      const rYear = retirementYear + (rAge - retirementAge);
      const yearsRetired = rAge - retirementAge;
      const isFirstYear = yearsRetired === 0;

      const openPension = pensionBal;
      const openISA = isaBal;
      const openGIA = giaBal;

      // Per-year rates for this retirement year
      const retYearIdx = yearsToRetirement + yearsRetired;
      const yrRet =
        yearlyRatesOverride?.[retYearIdx] != null
          ? {
              savingsRate,
              retirementRate,
              wageGrowthRate,
              inflationRate,
              boeRate,
              ...yearlyRatesOverride[retYearIdx],
            }
          : { savingsRate, retirementRate, wageGrowthRate, inflationRate, boeRate };
      const yrRetTriplelock = Math.max(yrRet.wageGrowthRate, yrRet.inflationRate, 0.025);

      // Update running products for this retirement year
      cumulInflation *= 1 + yrRet.inflationRate;
      thresholdScale *= 1 + yrRet.inflationRate - fiscalDragRate;
      cumulTriplelock *= 1 + yrRetTriplelock;

      // Inflation-adjusted target net expenses — inflated from today (currentAge),
      // not from retirement date, so the input figure represents today's purchasing power.
      const targetExpenses = round2(targetNetAnnualExpenses * cumulInflation);

      // Fiscal-drag-adjusted threshold scale for this retirement year.
      const retThresholdScale = thresholdScale;

      // State pension — triple-lock-adjusted nominal amount at this retirement year.
      // Grows from the 2025/26 base by max(wageGrowth, CPI, 2.5%) for each year elapsed.
      const spGross =
        rAge >= statePensionAge &&
        niYears >= LIFECYCLE_CONSTANTS.statePension.minimumQualifyingYears
          ? round2(computeStatePension(niYears) * cumulTriplelock)
          : 0;
      const spTax = round2(calculateIncomeTax(spGross, retThresholdScale).totalTax);
      const spNet = round2(spGross - spTax);

      // ── Mortgage (if still outstanding at retirement) ──────────────────────
      let retMortgageRow = null;
      let mortgagePaymentThisRetYear = 0;
      if (hasMortgage && mortgageBalance > 0) {
        const openingMortgage = mortgageBalance;
        if (mortgageType === 'interest-only') {
          let yearInt = 0;
          for (let m = 0; m < 12; m++) yearInt += round2(mortgageBalance * mortgageMonthlyRate);
          yearInt = round2(yearInt);
          mortgagePaymentThisRetYear = yearInt;
          retMortgageRow = {
            openingBalance: openingMortgage,
            interestCharged: yearInt,
            capitalRepaid: 0,
            payment: yearInt,
            closingBalance: mortgageBalance,
            type: 'interest-only',
          };
        } else {
          const amort = amortiseYear(
            mortgageBalance,
            mortgageMonthlyRate,
            mortgageMonthlyPayment,
            mortgageMonthlyOverpayment
          );
          mortgagePaymentThisRetYear = amort.payment;
          mortgageBalance = amort.closingBalance;
          retMortgageRow = {
            openingBalance: openingMortgage,
            interestCharged: amort.interestCharged,
            capitalRepaid: amort.capitalRepaid,
            payment: amort.payment,
            closingBalance: mortgageBalance,
            type: 'repayment',
          };
        }
      }

      // ── Unsecured debts (if still outstanding at retirement) ──────────────
      let retUnsecuredPayments = 0;
      const retDebtRows = debts.map((debt) => {
        if (debt.balance <= 0) {
          return {
            label: debt.label,
            openingBalance: 0,
            interestCharged: 0,
            capitalRepaid: 0,
            payment: 0,
            closingBalance: 0,
          };
        }
        const openingDebt = debt.balance;
        const amort = amortiseYear(debt.balance, debtMonthlyRate, debt.monthlyPayment);
        debt.balance = amort.closingBalance;
        retUnsecuredPayments = round2(retUnsecuredPayments + amort.payment);
        return {
          label: debt.label,
          openingBalance: openingDebt,
          interestCharged: amort.interestCharged,
          capitalRepaid: amort.capitalRepaid,
          payment: amort.payment,
          closingBalance: amort.closingBalance,
        };
      });

      // ── Drawdown strategy ─────────────────────────────────────────────────
      // Priority: tax-free pension → CGT-exempt GIA harvest → ISA → taxable GIA → taxable pension
      // Mortgage and unsecured debt payments are added on top of living expenses so the
      // full drawdown need is accounted for — state pension covers living costs only.
      let remaining = round2(
        Math.max(0, targetExpenses - spNet) + mortgagePaymentThisRetYear + retUnsecuredPayments
      );

      // 1. Pension: fill remaining personal allowance after state pension (no tax)
      // PCLS mode: the fund is fully crystallised — every £1 withdrawn is taxable income.
      // UFPLS mode: each £1 is [min(25%, LSA remaining / gross)] tax-free + rest taxable.
      // The step-1 limit is the gross needed so the taxable portion exactly fills the PA.
      //   • LSA exhausted (remainingLSA = 0): 100% taxable → gross = taxFreeRoom
      //   • LSA ≥ taxFreeRoom/3: normal 25%/75% split → gross = taxFreeRoom / 0.75
      //   • LSA < taxFreeRoom/3: use all remaining LSA, rest taxable
      //       taxable = gross − remainingLSA = taxFreeRoom → gross = taxFreeRoom + remainingLSA
      const scaledPA = round2(PERSONAL_ALLOWANCE * retThresholdScale);
      const taxFreeRoom = round2(Math.max(0, scaledPA - spGross));
      let step1Limit;
      if (takePCLS || taxFreeRoom <= 0) {
        step1Limit = taxFreeRoom;
      } else if (remainingLSA <= 0) {
        step1Limit = taxFreeRoom; // fully taxable
      } else if (remainingLSA >= taxFreeRoom / 3) {
        step1Limit = round2(taxFreeRoom / 0.75); // normal UFPLS split
      } else {
        step1Limit = round2(taxFreeRoom + remainingLSA); // exhaust remaining LSA
      }
      const tfPension = round2(Math.min(remaining, Math.min(step1Limit, pensionBal)));
      pensionBal = round2(pensionBal - tfPension);
      remaining = round2(remaining - tfPension);

      // Compute the tax-free component and consume from the LSA.
      const step1TaxFree = takePCLS ? 0 : round2(Math.min(0.25 * tfPension, remainingLSA));
      if (!takePCLS) remainingLSA = round2(Math.max(0, remainingLSA - step1TaxFree));
      // Only the taxable portion counts as income for CGT band determination.
      const tfPensionIncome = round2(tfPension - step1TaxFree);
      const incomeForCGT = round2(spGross + tfPensionIncome);

      // 2. GIA: harvest up to the annual CGT exempt amount (gains realised tax-free)
      // Track the pre-step-2 gain fraction so we can compute how much of the annual
      // exempt was consumed — the remainder is available for the bed-and-ISA step later.
      const gainFracPreStep2 = giaBal > 0 ? Math.max(0, (giaBal - costBasis) / giaBal) : 0;
      let giaExemptDraw = 0;
      let giaExemptCGT = 0;
      if (remaining > 0 && giaBal > 0) {
        const gainFrac = gainFracPreStep2;
        const grossForExempt =
          gainFrac > 0 ? GIA_CGT_CONSTANTS.annualExemptAmount / gainFrac : giaBal; // unrounded — used only in Math.min
        const draw = round2(Math.min(remaining, Math.min(grossForExempt, giaBal)));
        giaExemptCGT = computeGIACGT(draw, giaBal, costBasis, incomeForCGT);
        const net = round2(draw - giaExemptCGT);
        const after = applyGIAWithdrawal(giaBal, costBasis, draw);
        giaBal = after.bal;
        costBasis = after.costBasis;
        giaExemptDraw = draw;
        remaining = round2(remaining - net);
      }

      // 3. ISA: completely tax-free
      const isaDraw = round2(Math.min(remaining, isaBal));
      isaBal = round2(isaBal - isaDraw);
      remaining = round2(remaining - isaDraw);

      // 4. GIA: taxable drawdown (CGT beyond exempt amount; exempt already used in step 2)
      let giaTaxableDraw = 0;
      let giaTaxableCGT = 0;
      if (remaining > 0 && giaBal > 0) {
        // annualExemptAmount already consumed in step 2; pass 0 so gains are fully taxed
        const gross = giaGrossForNet(remaining, giaBal, costBasis, incomeForCGT, 0);
        giaTaxableCGT = computeGIACGT(gross, giaBal, costBasis, incomeForCGT, 0);
        const net = round2(gross - giaTaxableCGT);
        const after = applyGIAWithdrawal(giaBal, costBasis, gross);
        giaBal = after.bal;
        costBasis = after.costBasis;
        giaTaxableDraw = gross;
        remaining = round2(remaining - net);
      }

      // 5. Pension: taxable drawdown (income tax on the portion above the personal allowance)
      // UFPLS: only the non-tax-free portion counts as taxable income; the tax-free component
      // is limited by the remaining Lump Sum Allowance (may be less than 25% if near exhaustion).
      let taxablePension = 0;
      let step5TaxFree = 0;
      if (remaining > 0 && pensionBal > 0) {
        const gross = takePCLS
          ? pensionGrossForNet(remaining, pensionBal, incomeForCGT, retThresholdScale)
          : ufplsGrossForNet(remaining, pensionBal, incomeForCGT, retThresholdScale, remainingLSA);
        step5TaxFree = takePCLS ? 0 : round2(Math.min(0.25 * gross, remainingLSA));
        if (!takePCLS) remainingLSA = round2(Math.max(0, remainingLSA - step5TaxFree));
        const taxableIncome = round2(gross - step5TaxFree);
        const taxablePensionTax = round2(
          calculateIncomeTax(incomeForCGT + taxableIncome, retThresholdScale).totalTax -
            calculateIncomeTax(incomeForCGT, retThresholdScale).totalTax
        );
        const net = round2(gross - taxablePensionTax);
        pensionBal = round2(pensionBal - gross);
        taxablePension = gross;
        remaining = round2(remaining - net);
      }

      // ── Totals ─────────────────────────────────────────────────────────────
      const totalPensionDraw = round2(tfPension + taxablePension);
      const totalGIADraw = round2(giaExemptDraw + giaTaxableDraw);
      const totalGIACGT = round2(giaExemptCGT + giaTaxableCGT);
      // Taxable pension income = total withdrawn minus the LSA-capped tax-free components.
      // For PCLS: step1TaxFree = 0 and step5TaxFree = 0, so the full draw is taxable income.
      // For UFPLS: may be less than 75% of draw once the LSA approaches exhaustion.
      const pensionTaxableIncome = round2(totalPensionDraw - step1TaxFree - step5TaxFree);
      const totalIncomeTax = round2(
        calculateIncomeTax(spGross + pensionTaxableIncome, retThresholdScale).totalTax
      );
      const shortfall = round2(Math.max(0, remaining));
      const netAchieved = round2(targetExpenses - shortfall);

      // ── Bed and ISA (retirement) ────────────────────────────────────────────
      // After funding expenses, any remaining GIA is moved into the ISA up to the
      // annual subscription limit (£20,000). Withdrawals from the ISA do not count
      // toward the subscription limit, so the full headroom is available each year
      // minus however much PCLS used it in retirement year 1.
      // The CGT annual exempt is partially consumed by drawdown step 2; we apply only
      // what remains so we don't double-count it.
      const gainsUsedInStep2 = round2(giaExemptDraw * gainFracPreStep2);
      const retExemptRemaining = round2(
        Math.max(0, GIA_CGT_CONSTANTS.annualExemptAmount - gainsUsedInStep2)
      );
      const retBedIsaHeadroom = round2(ISA_LIMIT - (isFirstYear ? pclsToISA : 0));
      let retBedIsaGross = 0,
        retBedIsaCGT = 0,
        retBedIsaNet = 0;
      if (retBedIsaHeadroom > 0 && giaBal > 0) {
        const retIncomeForCGT = round2(spGross + pensionTaxableIncome);
        // Gross up so the net amount landing in the ISA equals the full headroom.
        const retGrossNeeded = giaGrossForNet(
          retBedIsaHeadroom,
          giaBal,
          costBasis,
          retIncomeForCGT,
          retExemptRemaining
        );
        retBedIsaGross = round2(Math.min(giaBal, retGrossNeeded));
        retBedIsaCGT = computeGIACGT(
          retBedIsaGross,
          giaBal,
          costBasis,
          retIncomeForCGT,
          retExemptRemaining
        );
        retBedIsaNet = round2(retBedIsaGross - retBedIsaCGT);
        const after = applyGIAWithdrawal(giaBal, costBasis, retBedIsaGross);
        giaBal = after.bal;
        costBasis = after.costBasis;
        isaBal = round2(isaBal + retBedIsaNet);
      }

      // ── Growth on remaining balances ───────────────────────────────────────
      const retYearRate = getRateForAge(
        rAge,
        retirementAge,
        yrRet.savingsRate,
        yrRet.retirementRate
      );
      const pensionGrow = round2(pensionBal * retYearRate);
      pensionBal = Math.max(0, round2(pensionBal + pensionGrow));
      const isaGrow = round2(isaBal * retYearRate);
      isaBal = Math.max(0, round2(isaBal + isaGrow));
      const giaGrow = round2(giaBal * retYearRate);
      giaBal = Math.max(0, round2(giaBal + giaGrow));
      // cost basis unchanged by growth (unrealised gains accumulate)

      // ── Row ────────────────────────────────────────────────────────────────
      const retRow = {
        year: rYear,
        age: rAge,
        phase: 'retirement',

        targetNetExpenses: targetExpenses,
        mortgagePayment: mortgagePaymentThisRetYear,
        unsecuredDebtPayments: retUnsecuredPayments,
        statePensionGross: spGross,
        statePensionNet: spNet,
        taxFreePensionDrawdown: tfPension,
        taxablePensionDrawdown: taxablePension,
        pensionDrawdown: totalPensionDraw,
        isaWithdrawal: isaDraw,
        giaWithdrawal: totalGIADraw,
        giaCGT: totalGIACGT,
        incomeTax: totalIncomeTax,
        netIncomeAchieved: netAchieved,
        shortfall,

        investmentRate: round2(retYearRate * 10000) / 10000,

        pension: {
          openingBalance: openPension,
          drawdown: totalPensionDraw,
          growthAmount: pensionGrow,
          closingBalance: pensionBal,
        },
        isa: {
          openingBalance: openISA,
          withdrawal: isaDraw,
          bedIsaContrib: retBedIsaNet,
          growthAmount: isaGrow,
          closingBalance: isaBal,
        },
        gia: {
          openingBalance: openGIA,
          withdrawal: totalGIADraw,
          cgt: totalGIACGT,
          bedIsaGross: retBedIsaGross,
          bedIsaCGT: retBedIsaCGT,
          growthAmount: giaGrow,
          closingBalance: giaBal,
          closingCostBasis: costBasis,
          unrealisedGain: round2(giaBal - costBasis),
        },
        bedIsa: { grossSold: retBedIsaGross, cgt: retBedIsaCGT, netContrib: retBedIsaNet },
        mortgage: retMortgageRow,
        unsecuredDebts: retDebtRows,
        studentLoan: null,
      };
      if (isFirstYear && takePCLS) {
        retRow.pclsLumpSum = pclsLumpSum;
        retRow.pclsCapped = pclsCapped;
      }
      yearlyBreakdown.push(retRow);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  // When there is a retirement phase, report balances at retirement entry (after PCLS, before
  // drawdown) so headline figures reflect "what you have on day one of retirement". Using the
  // post-loop state would give zero whenever pots are fully depleted by maxAge.
  // Use retirement-entry snapshots when available; fall back to end-of-accumulation values
  // when there is no retirement phase.
  const sumPension = retEntryPension !== null ? retEntryPension : pensionBal;
  const sumISA = retEntryISA !== null ? retEntryISA : isaBal;
  const sumGIA = retEntryGIA !== null ? retEntryGIA : giaBal;
  const sumCostBasis = retEntryCostBasis !== null ? retEntryCostBasis : costBasis;
  const sumMortgage = retEntryMortgage !== null ? retEntryMortgage : mortgageBalance;
  const sumUnsecured =
    retEntryUnsecured !== null
      ? retEntryUnsecured
      : round2(debts.reduce((s, d) => s + d.balance, 0));
  // Nominal state pension at the age it first becomes payable, triple-lock grown from today.
  // Uses the base-rate triplelock for the summary figure (independent of yearlyRatesOverride).
  const baseTriplelockForSummary = Math.max(wageGrowthRate, inflationRate, 0.025);
  const projectedStatePension = round2(
    computeStatePension(niYears) *
      Math.pow(1 + baseTriplelockForSummary, Math.max(0, statePensionAge - currentAge))
  );
  const totalSavings = round2(sumPension + sumISA + sumGIA);
  const totalDebt = round2(sumMortgage + sumUnsecured + slBalance);

  return {
    startYear: currentYear,
    retirementYear,
    hasRetirementPhase: retirementOptions != null,
    yearlyBreakdown,
    summary: {
      retirementYear,
      retirementAge,
      pensionPot: sumPension,
      isaBalance: sumISA,
      giaBalance: sumGIA,
      giaCostBasis: sumCostBasis,
      giaUnrealisedGain: round2(sumGIA - sumCostBasis),
      mortgageOutstanding: sumMortgage,
      unsecuredDebtOutstanding: sumUnsecured,
      studentLoanOutstanding: slBalance,
      totalSavings,
      totalDebt,
      netWorth: round2(totalSavings - totalDebt),
      niYearsAccrued: niYears,
      projectedStatePension,
      statePensionAge,
      statePensionEligibleAtRetirement: retirementAge >= statePensionAge,
    },
    taxYear: TAX_YEAR,
  };
}
