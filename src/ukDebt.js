/**
 * Mortgage and unsecured debt projection module
 *
 * Conventions:
 *   - All monetary values in GBP, rounded to 2 decimal places
 *   - Interest calculated monthly on the outstanding balance
 *   - Monthly interest and capital figures rounded to 2dp before application
 *   - No early repayment charges or arrangement fees are modelled
 *   - Variable-rate mortgages: run projectMortgage multiple times, using
 *     the previous projection's finalBalance as the new principal
 */

const MAX_MONTHS = 600; // 50-year hard limit for unsecured debt projections

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertPositiveFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

// ---------------------------------------------------------------------------
// Mortgage
// ---------------------------------------------------------------------------

/**
 * Calculates the fixed monthly payment for a repayment mortgage using the
 * standard annuity formula. Returns 0 for a zero-rate mortgage.
 *
 * @param {number} principal   - Loan amount in GBP
 * @param {number} annualRate  - Annual interest rate as a decimal (e.g. 0.05)
 * @param {number} termYears   - Mortgage term in whole years
 * @returns {number} Monthly payment in GBP (rounded to 2dp)
 */
export function calculateMonthlyMortgagePayment(principal, annualRate, termYears) {
  assertPositiveFinite(principal, 'principal');
  assertNonNegativeFinite(annualRate, 'annualRate');
  assertPositiveInteger(termYears, 'termYears');

  const n = termYears * 12;
  if (annualRate === 0) return round2(principal / n);

  const r = annualRate / 12;
  return round2((principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

/**
 * Projects a mortgage balance year by year.
 *
 * For repayment mortgages the monthly payment is calculated automatically.
 * Any monthlyOverpayment is applied on top of the regular payment each month,
 * reducing the balance faster and shortening the effective term.
 *
 * For interest-only mortgages the monthly payment covers interest only;
 * the full principal remains as a balloon payment at the end of the term.
 *
 * @param {number} principal  - Loan amount in GBP
 * @param {number} annualRate - Annual interest rate as a decimal
 * @param {number} termYears  - Original mortgage term in whole years
 * @param {{
 *   type?: 'repayment' | 'interest-only',
 *   startYear?: number,
 *   monthlyOverpayment?: number
 * }} [options]
 * @returns {{
 *   type: string,
 *   principal: number,
 *   annualRate: number,
 *   termYears: number,
 *   monthlyPayment: number,
 *   monthlyOverpayment: number,
 *   startYear: number,
 *   yearlyBreakdown: Array<{
 *     year: number,
 *     openingBalance: number,
 *     annualInterestCharged: number,
 *     annualCapitalRepaid: number,
 *     annualPayment: number,
 *     closingBalance: number
 *   }>,
 *   totalInterestPaid: number,
 *   totalPaid: number,
 *   finalBalance: number,
 *   balloonPayment: number | null,
 *   fullyRepaid: boolean
 * }}
 */
export function projectMortgage(principal, annualRate, termYears, options = {}) {
  assertPositiveFinite(principal, 'principal');
  assertNonNegativeFinite(annualRate, 'annualRate');
  assertPositiveInteger(termYears, 'termYears');

  const { type = 'repayment', startYear = 2025, monthlyOverpayment = 0 } = options;

  if (type !== 'repayment' && type !== 'interest-only') {
    throw new TypeError(`type must be 'repayment' or 'interest-only', got "${type}"`);
  }
  assertNonNegativeFinite(monthlyOverpayment, 'monthlyOverpayment');
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  const monthlyRate = annualRate / 12;
  const monthlyPayment =
    type === 'interest-only'
      ? round2(principal * monthlyRate)
      : calculateMonthlyMortgagePayment(principal, annualRate, termYears);

  let balance = round2(principal);
  let totalInterestPaid = 0;
  let totalPaid = 0;
  const yearlyBreakdown = [];

  for (let y = 0; y < termYears; y++) {
    if (balance <= 0) break;

    const openingBalance = balance;
    let yearInterest = 0;
    let yearCapital = 0;
    let yearPayment = 0;

    for (let m = 0; m < 12; m++) {
      if (balance <= 0) break;

      const interest = round2(balance * monthlyRate);

      if (type === 'interest-only') {
        yearInterest += interest;
        yearPayment += interest;
        // balance unchanged — balloon payment due at end of term
      } else {
        const totalMonthly = monthlyPayment + monthlyOverpayment;
        const capitalRepaid = round2(Math.min(totalMonthly - interest, balance));
        const actualPayment = interest + capitalRepaid;

        balance = round2(balance - capitalRepaid);
        yearInterest += interest;
        yearCapital += capitalRepaid;
        yearPayment += actualPayment;
      }
    }

    totalInterestPaid = round2(totalInterestPaid + yearInterest);
    totalPaid = round2(totalPaid + yearPayment);

    yearlyBreakdown.push({
      year: startYear + y,
      openingBalance,
      annualInterestCharged: round2(yearInterest),
      annualCapitalRepaid: round2(yearCapital),
      annualPayment: round2(yearPayment),
      closingBalance: balance,
    });
  }

  return {
    type,
    principal,
    annualRate,
    termYears,
    monthlyPayment,
    monthlyOverpayment,
    startYear,
    yearlyBreakdown,
    totalInterestPaid,
    totalPaid,
    finalBalance: balance,
    balloonPayment: type === 'interest-only' ? balance : null,
    fullyRepaid: balance <= 0,
  };
}

// ---------------------------------------------------------------------------
// Unsecured debt
// ---------------------------------------------------------------------------

/**
 * Projects a single unsecured debt (personal loan, credit card, overdraft)
 * year by year until fully repaid or the 50-year limit is reached.
 *
 * @param {number} balance        - Outstanding balance in GBP
 * @param {number} annualRate     - Annual interest rate as a decimal (e.g. 0.20)
 * @param {number} monthlyPayment - Fixed monthly payment in GBP
 * @param {{ startYear?: number, label?: string }} [options]
 * @returns {{
 *   label: string,
 *   initialBalance: number,
 *   annualRate: number,
 *   monthlyPayment: number,
 *   startYear: number,
 *   yearlyBreakdown: Array<object>,
 *   totalInterestPaid: number,
 *   totalPaid: number,
 *   finalBalance: number,
 *   fullyRepaid: boolean,
 *   projectionComplete: boolean,
 *   monthsToRepay: number | null
 * }}
 */
export function projectUnsecuredDebt(balance, annualRate, monthlyPayment, options = {}) {
  assertPositiveFinite(balance, 'balance');
  assertNonNegativeFinite(annualRate, 'annualRate');
  assertPositiveFinite(monthlyPayment, 'monthlyPayment');

  const { startYear = 2025, label = 'Unsecured debt' } = options;
  if (!Number.isInteger(startYear) || startYear < 1990) {
    throw new RangeError('startYear must be an integer >= 1990');
  }

  const monthlyRate = annualRate / 12;
  const initialMonthlyInterest = round2(balance * monthlyRate);
  if (monthlyPayment <= initialMonthlyInterest) {
    throw new RangeError(
      `monthlyPayment (£${monthlyPayment}) must exceed initial monthly interest ` +
        `(£${initialMonthlyInterest}) otherwise the balance will never decrease`
    );
  }

  let currentBalance = round2(balance);
  let totalInterestPaid = 0;
  let totalPaid = 0;
  let monthsTotal = 0;
  let fullyRepaid;
  const yearlyBreakdown = [];

  outer: for (let y = 0; ; y++) {
    if (currentBalance <= 0) break;
    if (monthsTotal >= MAX_MONTHS) break;

    const openingBalance = currentBalance;
    let yearInterest = 0;
    let yearCapital = 0;
    let yearPayment = 0;

    for (let m = 0; m < 12; m++) {
      if (currentBalance <= 0) break;
      if (monthsTotal >= MAX_MONTHS) break outer;

      const interest = round2(currentBalance * monthlyRate);
      const capitalRepaid = round2(Math.min(monthlyPayment - interest, currentBalance));
      const actualPayment = interest + capitalRepaid;

      currentBalance = round2(currentBalance - capitalRepaid);
      monthsTotal++;
      yearInterest += interest;
      yearCapital += capitalRepaid;
      yearPayment += actualPayment;
    }

    totalInterestPaid = round2(totalInterestPaid + yearInterest);
    totalPaid = round2(totalPaid + yearPayment);

    yearlyBreakdown.push({
      year: startYear + y,
      openingBalance,
      annualInterestCharged: round2(yearInterest),
      annualCapitalRepaid: round2(yearCapital),
      annualPayment: round2(yearPayment),
      closingBalance: currentBalance,
    });
  }

  fullyRepaid = currentBalance <= 0;

  return {
    label,
    initialBalance: balance,
    annualRate,
    monthlyPayment,
    startYear,
    yearlyBreakdown,
    totalInterestPaid,
    totalPaid,
    finalBalance: currentBalance,
    fullyRepaid,
    projectionComplete: fullyRepaid,
    monthsToRepay: fullyRepaid ? monthsTotal : null,
  };
}

/**
 * Projects multiple unsecured debts simultaneously and combines their
 * year-by-year totals. Each debt is projected independently; debts that
 * are paid off earlier simply contribute zero to subsequent years.
 *
 * @param {Array<{
 *   label?: string,
 *   balance: number,
 *   annualRate: number,
 *   monthlyPayment: number
 * }>} debts
 * @param {{ startYear?: number }} [options]
 * @returns {{
 *   debts: Array<object>,
 *   startYear: number,
 *   yearlyBreakdown: Array<object>,
 *   totalInterestPaid: number,
 *   totalPaid: number,
 *   totalFinalBalance: number
 * }}
 */
export function projectUnsecuredDebts(debts, options = {}) {
  if (!Array.isArray(debts) || debts.length === 0) {
    throw new TypeError('debts must be a non-empty array');
  }

  const { startYear = 2025 } = options;

  const debtResults = debts.map(({ label, balance, annualRate, monthlyPayment }) =>
    projectUnsecuredDebt(balance, annualRate, monthlyPayment, { startYear, label })
  );

  // Union of all years across all debts
  const lastYear = Math.max(
    ...debtResults.map((r) =>
      r.yearlyBreakdown.length > 0
        ? r.yearlyBreakdown[r.yearlyBreakdown.length - 1].year
        : startYear - 1
    )
  );

  const yearlyBreakdown = [];
  for (let year = startYear; year <= lastYear; year++) {
    let openingBalance = 0;
    let annualInterestCharged = 0;
    let annualCapitalRepaid = 0;
    let annualPayment = 0;
    let closingBalance = 0;

    for (const result of debtResults) {
      const row = result.yearlyBreakdown.find((r) => r.year === year);
      if (row) {
        openingBalance += row.openingBalance;
        annualInterestCharged += row.annualInterestCharged;
        annualCapitalRepaid += row.annualCapitalRepaid;
        annualPayment += row.annualPayment;
        closingBalance += row.closingBalance;
      }
    }

    yearlyBreakdown.push({
      year,
      openingBalance: round2(openingBalance),
      annualInterestCharged: round2(annualInterestCharged),
      annualCapitalRepaid: round2(annualCapitalRepaid),
      annualPayment: round2(annualPayment),
      closingBalance: round2(closingBalance),
    });
  }

  return {
    debts: debtResults,
    startYear,
    yearlyBreakdown,
    totalInterestPaid: round2(debtResults.reduce((s, r) => s + r.totalInterestPaid, 0)),
    totalPaid: round2(debtResults.reduce((s, r) => s + r.totalPaid, 0)),
    totalFinalBalance: round2(debtResults.reduce((s, r) => s + r.finalBalance, 0)),
  };
}
