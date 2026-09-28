/**
 * UK Student Loan calculator and balance projector (2026/27 tax year)
 *
 * Repayment thresholds and rates — source: gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027
 *   Plan 1 (pre-Sep 2012, England/Wales/NI)  : £26,900 @ 9%  — write-off: 25 years
 *   Plan 2 (Sep 2012–Jul 2023, Eng/Wales)    : £29,385 @ 9%  — write-off: 30 years
 *   Plan 4 (Scotland)                         : £33,795 @ 9%  — write-off: 30 years
 *   Plan 5 (Aug 2023+, England/Wales)         : £25,000 @ 9%  — write-off: 40 years
 *   Postgraduate Loan                         : £21,000 @ 6%  — write-off: 30 years
 *
 * Interest rates (2026/27) — source: gov.uk/repaying-your-student-loan (interest):
 *   Plan 1    : min(RPI, Bank of England base rate + 1%)
 *   Plan 2    : RPI + sliding 0–3% on income between £29,385 and £52,885, capped at 6%
 *   Plan 4    : min(RPI, Bank of England base rate + 1%) — same rule as Plan 1
 *   Plan 5    : RPI
 *   Postgrad  : RPI + 3%, capped at 6%
 */

import { calculateIncomeTax } from './ukIncomeTax.js';

const TAX_YEAR = '2026/27';

// Default Bank of England base rate used for Plan 1 interest cap.
// Update this each tax year alongside the RPI figure. 3.75% as of September
// 2026 (bankofengland.co.uk, Bank Rate).
const DEFAULT_BOE_RATE = 0.0375;

// Plan 2 and Postgraduate interest (RPI + up to 3%) is currently capped at 6%
// (gov.uk/repaying-your-student-loan, 2026/27).
const INTEREST_CAP = 0.06;

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

export const STUDENT_LOAN_PLANS = {
  plan1: {
    label: 'Plan 1',
    description: 'Pre-September 2012 starters (England, Wales, Northern Ireland)',
    threshold: 26_900,
    rate: 0.09,
    writeOffYears: 25,
  },
  plan2: {
    label: 'Plan 2',
    description: 'September 2012 – July 2023 starters (England and Wales)',
    threshold: 29_385,
    rate: 0.09,
    writeOffYears: 30,
    // Income band within which interest scales from RPI to RPI+3%
    interestLowerThreshold: 29_385,
    interestUpperThreshold: 52_885,
  },
  plan4: {
    label: 'Plan 4',
    description: 'Scottish student loans (all years)',
    threshold: 33_795,
    rate: 0.09,
    writeOffYears: 30,
  },
  plan5: {
    label: 'Plan 5',
    description: 'August 2023+ starters (England and Wales)',
    threshold: 25_000,
    rate: 0.09,
    writeOffYears: 40,
  },
  postgrad: {
    label: 'Postgraduate Loan',
    description: "Master's (from August 2016) and Doctoral (from August 2018)",
    threshold: 21_000,
    rate: 0.06,
    writeOffYears: 30,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertValidPlanKey(plan) {
  if (!Object.prototype.hasOwnProperty.call(STUDENT_LOAN_PLANS, plan)) {
    throw new TypeError(
      `Unknown student loan plan "${plan}". Valid plans: ${Object.keys(STUDENT_LOAN_PLANS).join(', ')}`
    );
  }
}

function assertValidGrossIncome(grossIncome) {
  if (typeof grossIncome !== 'number' || !isFinite(grossIncome)) {
    throw new TypeError('grossIncome must be a finite number');
  }
  if (grossIncome < 0) {
    throw new RangeError('grossIncome must be >= 0');
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the annual interest rate applied to a student loan for a given plan,
 * gross income, and economic conditions.
 *
 *   Plan 1   : min(RPI, BoE base rate + 1%)
 *   Plan 2   : RPI + 0–3% sliding with income between £29,385 and £52,885, capped at 6%
 *   Plan 4   : min(RPI, BoE base rate + 1%) — same rule as Plan 1
 *   Plan 5   : RPI
 *   Postgrad : RPI + 3%, capped at 6%
 *
 * @param {string} planKey
 * @param {number} grossIncome - Annual gross income in GBP
 * @param {number} rpi         - Retail Price Index as a decimal (e.g. 0.031)
 * @param {number} [boeRate]   - Bank of England base rate as a decimal (Plan 1 only)
 * @returns {number} Annual interest rate as a decimal
 */
export function calculateAnnualInterestRate(planKey, grossIncome, rpi, boeRate = DEFAULT_BOE_RATE) {
  assertValidPlanKey(planKey);

  switch (planKey) {
    // UK rules: student loan interest cannot be negative, floored at 0%
    case 'plan1':
    case 'plan4':
      return round4(Math.max(0, Math.min(rpi, boeRate + 0.01)));

    case 'plan2': {
      const { interestLowerThreshold, interestUpperThreshold } = STUDENT_LOAN_PLANS.plan2;
      let rate;
      if (grossIncome <= interestLowerThreshold) rate = rpi;
      else if (grossIncome >= interestUpperThreshold) rate = rpi + 0.03;
      else {
        const fraction =
          (grossIncome - interestLowerThreshold) /
          (interestUpperThreshold - interestLowerThreshold);
        rate = rpi + fraction * 0.03;
      }
      return round4(Math.max(0, Math.min(INTEREST_CAP, rate)));
    }

    case 'plan5':
      return round4(Math.max(0, rpi));

    case 'postgrad':
      return round4(Math.max(0, Math.min(INTEREST_CAP, rpi + 0.03)));
  }
}

/**
 * Calculates the annual student loan repayment for a single plan.
 *
 * @param {number} grossIncome - Annual gross income in GBP (must be >= 0)
 * @param {string} planKey     - 'plan1' | 'plan2' | 'plan4' | 'plan5' | 'postgrad'
 * @returns {{
 *   plan: string, label: string, description: string,
 *   threshold: number, rate: number,
 *   repayableIncome: number, repayment: number,
 *   grossIncome: number, taxYear: string
 * }}
 */
export function calculateStudentLoan(grossIncome, planKey) {
  assertValidGrossIncome(grossIncome);
  assertValidPlanKey(planKey);

  const { label, description, threshold, rate } = STUDENT_LOAN_PLANS[planKey];
  const repayableIncome = Math.max(0, grossIncome - threshold);
  const repayment = round2(repayableIncome * rate);

  return {
    plan: planKey,
    label,
    description,
    threshold,
    rate,
    repayableIncome,
    repayment,
    grossIncome,
    taxYear: TAX_YEAR,
  };
}

/**
 * Projects a student loan balance year by year, tracking repayments, interest
 * accrual, and the eventual full repayment or write-off.
 *
 * The model uses annual compounding: interest is calculated on the opening
 * balance, added to the balance, then repayments are deducted. The balance
 * cannot go below zero. The projection stops when either:
 *   (a) the balance reaches zero (loan fully repaid), or
 *   (b) the write-off year is reached (remaining balance cancelled), or
 *   (c) the annualProjections array is exhausted (projection incomplete).
 *
 * Write-off occurs in the year equal to repaymentStartYear + writeOffYears;
 * repayments are still made in all prior years.
 *
 * Note on granularity: the statutory rule cancels the loan in the April
 * following the Nth anniversary of the first repayment. This annual model
 * approximates that as a whole calendar year, so the write-off can differ
 * from the statutory date by up to one year.
 *
 * @param {string} planKey
 * @param {number} initialBalance       - Opening loan balance in GBP
 * @param {number} repaymentStartYear   - First calendar year of repayment (e.g. 2025)
 * @param {Array<{grossIncome: number, rpi: number, boeRate?: number}>} annualProjections
 *   One entry per year starting from repaymentStartYear.
 *
 * @returns {{
 *   plan: string,
 *   repaymentStartYear: number,
 *   writeOffYear: number,
 *   writeOffPeriodYears: number,
 *   yearlyBreakdown: Array<{
 *     year: number,
 *     openingBalance: number,
 *     annualInterestRate: number,
 *     interestCharged: number,
 *     grossIncome: number,
 *     annualRepayment: number,
 *     closingBalance: number,
 *     writtenOff: boolean
 *   }>,
 *   totalRepaid: number,
 *   totalInterestCharged: number,
 *   balanceWrittenOff: number | null,
 *   finalBalance: number,
 *   fullyRepaid: boolean,
 *   projectionComplete: boolean
 * }}
 */
export function projectLoanBalance(planKey, initialBalance, repaymentStartYear, annualProjections) {
  assertValidPlanKey(planKey);

  if (typeof initialBalance !== 'number' || !isFinite(initialBalance) || initialBalance < 0) {
    throw new RangeError('initialBalance must be a finite number >= 0');
  }
  if (!Number.isInteger(repaymentStartYear) || repaymentStartYear < 1990) {
    throw new RangeError('repaymentStartYear must be an integer >= 1990');
  }
  if (!Array.isArray(annualProjections) || annualProjections.length === 0) {
    throw new TypeError('annualProjections must be a non-empty array');
  }

  const plan = STUDENT_LOAN_PLANS[planKey];
  const writeOffYear = repaymentStartYear + plan.writeOffYears;

  let balance = round2(initialBalance);
  let totalRepaid = 0;
  let totalInterestCharged = 0;
  let balanceWrittenOff = null;
  const yearlyBreakdown = [];

  for (let i = 0; i < annualProjections.length; i++) {
    if (balance <= 0) break;

    const year = repaymentStartYear + i;
    const { grossIncome, rpi, boeRate = DEFAULT_BOE_RATE } = annualProjections[i];

    if (year >= writeOffYear) {
      balanceWrittenOff = balance;
      yearlyBreakdown.push({
        year,
        openingBalance: balance,
        annualInterestRate: 0,
        interestCharged: 0,
        grossIncome,
        annualRepayment: 0,
        closingBalance: 0,
        writtenOff: true,
      });
      balance = 0;
      break;
    }

    const openingBalance = balance;
    const annualInterestRate = calculateAnnualInterestRate(planKey, grossIncome, rpi, boeRate);

    const interestCharged = round2(openingBalance * annualInterestRate);
    balance = round2(balance + interestCharged);
    totalInterestCharged = round2(totalInterestCharged + interestCharged);

    const maxRepayment = round2(Math.max(0, grossIncome - plan.threshold) * plan.rate);
    const actualRepayment = round2(Math.min(maxRepayment, balance));
    balance = round2(Math.max(0, balance - actualRepayment));
    totalRepaid = round2(totalRepaid + actualRepayment);

    yearlyBreakdown.push({
      year,
      openingBalance,
      annualInterestRate,
      interestCharged,
      grossIncome,
      annualRepayment: actualRepayment,
      closingBalance: balance,
      writtenOff: false,
    });
  }

  const fullyRepaid = balance <= 0 && balanceWrittenOff === null;
  const projectionComplete = balance <= 0;

  return {
    plan: planKey,
    repaymentStartYear,
    writeOffYear,
    writeOffPeriodYears: plan.writeOffYears,
    yearlyBreakdown,
    totalRepaid,
    totalInterestCharged,
    balanceWrittenOff,
    finalBalance: balance,
    fullyRepaid,
    projectionComplete,
  };
}

/**
 * Calculates income tax and student loan repayments together.
 *
 * Multiple plans can be active simultaneously — for example, an undergraduate
 * Plan 2 loan running alongside a Postgraduate Loan. Plans 1, 2, 4, and 5 are
 * mutually exclusive in practice but the function does not enforce this.
 *
 * @param {number}   grossIncome       - Annual gross income in GBP
 * @param {string[]} studentLoanPlans  - Array of plan keys (may be empty)
 * @returns {{
 *   ...calculateIncomeTax return fields,
 *   studentLoans: Array<object>,
 *   totalStudentLoanRepayment: number,
 *   totalDeductions: number,
 *   netIncomeAfterLoans: number
 * }}
 */
export function calculateTaxAndLoans(grossIncome, studentLoanPlans = []) {
  assertValidGrossIncome(grossIncome);

  if (!Array.isArray(studentLoanPlans)) {
    throw new TypeError('studentLoanPlans must be an array');
  }

  const taxResult = calculateIncomeTax(grossIncome);
  const studentLoans = studentLoanPlans.map((plan) => calculateStudentLoan(grossIncome, plan));
  const totalStudentLoanRepayment = round2(studentLoans.reduce((sum, l) => sum + l.repayment, 0));
  const totalDeductions = round2(taxResult.totalTax + totalStudentLoanRepayment);

  return {
    ...taxResult,
    studentLoans,
    totalStudentLoanRepayment,
    totalDeductions,
    netIncomeAfterLoans: round2(grossIncome - totalDeductions),
  };
}
