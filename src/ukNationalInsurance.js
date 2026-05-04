/**
 * UK National Insurance calculator — Class 1 (employment income), 2025/26
 *
 * Employee (Class 1 Primary):
 *   Below LEL  (£6,725)           : 0% — no NI paid, no NI credit towards State Pension
 *   LEL to PT  (£6,725–£12,570)   : 0% — no NI paid, but NI credit IS earned
 *   PT to UEL  (£12,570–£50,270)  : 8%
 *   Above UEL  (£50,270+)         : 2%
 *
 * Employer (Class 1 Secondary):
 *   Below ST   (£5,000)           : 0%
 *   Above ST   (£5,000+)          : 15% — no upper earnings limit
 *   Employment Allowance (eligible employers only): up to £10,500 reduction.
 *   This allowance is not modelled here as it applies at payroll level, not per employee.
 *
 * scaleFactor (optional, default 1): scales all monetary thresholds uniformly.
 * Pass (1 + inflationRate - fiscalDragRate)^i from the lifecycle module to model
 * fiscal drag. scaleFactor = 1 reproduces exact 2025/26 thresholds.
 *
 * Source: gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026
 */

const TAX_YEAR = '2025/26';

// ---------------------------------------------------------------------------
// Published thresholds and rates
// ---------------------------------------------------------------------------

export const NI_THRESHOLDS = {
  employee: {
    lowerEarningsLimit: 6_725, // LEL: below this, no NI and no NI credit
    primaryThreshold: 12_570, // PT:  NI contributions begin
    upperEarningsLimit: 50_270, // UEL: additional rate applies above this
    mainRate: 0.08, // 8%  on earnings between PT and UEL
    additionalRate: 0.02, // 2%  on earnings above UEL
  },
  employer: {
    secondaryThreshold: 5_000, // ST:  employer NI begins
    rate: 0.15, // 15% on all earnings above ST (no upper limit)
    employmentAllowance: 10_500, // max annual reduction for eligible employers (not modelled)
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertValidGrossIncome(grossIncome) {
  if (typeof grossIncome !== 'number' || !isFinite(grossIncome))
    throw new TypeError('grossIncome must be a finite number');
  if (grossIncome < 0) throw new RangeError('grossIncome must be >= 0');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculates Class 1 National Insurance contributions for a given gross annual
 * employment income — both employee (what is deducted from pay) and employer
 * (additional cost on top of gross salary).
 *
 * Note: the employer figure does not account for the Employment Allowance,
 * which reduces an eligible employer's liability by up to £10,500 per year
 * and is applied at payroll level across all employees.
 *
 * @param {number} grossIncome  - Annual gross employment income in GBP (>= 0)
 * @param {number} [scaleFactor=1] - Threshold scale factor (must be > 0).
 *   Values > 1 expand all bands (less drag); values < 1 compress them (more drag).
 *   The returned threshold fields reflect the scaled values.
 * @returns {{
 *   grossIncome: number,
 *   employeeNI: {
 *     lowerEarningsLimit: number,
 *     primaryThreshold: number,
 *     upperEarningsLimit: number,
 *     mainRateContribution: number,
 *     additionalRateContribution: number,
 *     total: number,
 *     effectiveRate: number
 *   },
 *   employerNI: {
 *     secondaryThreshold: number,
 *     contribution: number,
 *     effectiveRate: number
 *   },
 *   totalNI: number,
 *   taxYear: string
 * }}
 */
export function calculateNationalInsurance(grossIncome, scaleFactor = 1) {
  assertValidGrossIncome(grossIncome);
  if (typeof scaleFactor !== 'number' || !isFinite(scaleFactor) || scaleFactor <= 0)
    throw new RangeError('scaleFactor must be a positive finite number');

  const { employee: emp, employer: er } = NI_THRESHOLDS;

  // Scale all monetary thresholds
  const lel = round2(emp.lowerEarningsLimit * scaleFactor);
  const pt = round2(emp.primaryThreshold * scaleFactor);
  const uel = round2(emp.upperEarningsLimit * scaleFactor);
  const st = round2(er.secondaryThreshold * scaleFactor);

  // Employee — main rate: 8% on earnings between PT and UEL
  const mainRateIncome = Math.max(0, Math.min(grossIncome, uel) - pt);
  const mainRateContribution = round2(mainRateIncome * emp.mainRate);

  // Employee — additional rate: 2% on earnings above UEL
  const additionalRateIncome = Math.max(0, grossIncome - uel);
  const additionalRateContribution = round2(additionalRateIncome * emp.additionalRate);

  const totalEmployeeNI = round2(mainRateContribution + additionalRateContribution);
  const employeeEffectiveRate = grossIncome > 0 ? round2(totalEmployeeNI / grossIncome) : 0;

  // Employer — 15% on all earnings above the Secondary Threshold, no upper limit
  const employerNIableIncome = Math.max(0, grossIncome - st);
  const employerContribution = round2(employerNIableIncome * er.rate);
  const employerEffectiveRate = grossIncome > 0 ? round2(employerContribution / grossIncome) : 0;

  return {
    grossIncome,
    employeeNI: {
      lowerEarningsLimit: lel,
      primaryThreshold: pt,
      upperEarningsLimit: uel,
      mainRateContribution,
      additionalRateContribution,
      total: totalEmployeeNI,
      effectiveRate: employeeEffectiveRate,
    },
    employerNI: {
      secondaryThreshold: st,
      contribution: employerContribution,
      effectiveRate: employerEffectiveRate,
    },
    totalNI: round2(totalEmployeeNI + employerContribution),
    taxYear: TAX_YEAR,
  };
}
