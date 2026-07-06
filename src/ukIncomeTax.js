/**
 * UK Income Tax calculator (2025/26 tax year)
 *
 * Bands:
 *   Personal Allowance : £0       – £12,570   @ 0%
 *   Basic rate         : £12,571  – £50,270   @ 20%
 *   Higher rate        : £50,271  – £125,140  @ 40%
 *   Additional rate    : £125,141+            @ 45%
 *
 * The personal allowance tapers by £1 for every £2 of income above £100,000
 * and reaches zero at £125,140.
 *
 * scaleFactor (optional, default 1): scales all monetary thresholds uniformly.
 * Pass (1 + inflationRate - fiscalDragRate)^i from the lifecycle module to model
 * fiscal drag — the degree to which bands fail to keep pace with inflation.
 * scaleFactor = 1 reproduces exact 2025/26 thresholds.
 */

const TAX_YEAR = '2025/26';

const PERSONAL_ALLOWANCE = 12_570;
const BASIC_RATE_LIMIT = 50_270;
const ADDITIONAL_RATE_THRESHOLD = 125_140;
const TAPER_THRESHOLD = 100_000;

const BASIC_RATE = 0.2;
const HIGHER_RATE = 0.4;
const ADDITIONAL_RATE = 0.45;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

// Returns the effective personal allowance given gross income and scaled thresholds.
function effectivePersonalAllowance(grossIncome, pa, taperThreshold) {
  if (grossIncome <= taperThreshold) return pa;
  const reduction = Math.floor((grossIncome - taperThreshold) / 2);
  return Math.max(0, pa - reduction);
}

/**
 * Returns the taxable income (gross minus the effective personal allowance,
 * including the £100k taper) for a given gross income. Exposed so other
 * modules — e.g. the CGT calculation, whose basic-rate room depends on
 * taxable income rather than gross — can share the exact same PA logic.
 *
 * @param {number} grossIncome - Gross annual income in GBP (>= 0)
 * @param {number} [scaleFactor=1] - Threshold scale factor (fiscal drag)
 * @returns {number} Taxable income in GBP
 */
export function calculateTaxableIncome(grossIncome, scaleFactor = 1) {
  if (typeof grossIncome !== 'number' || !isFinite(grossIncome) || grossIncome < 0)
    throw new TypeError('grossIncome must be a non-negative finite number');
  const pa = round2(PERSONAL_ALLOWANCE * scaleFactor);
  const tt = round2(TAPER_THRESHOLD * scaleFactor);
  return Math.max(0, grossIncome - effectivePersonalAllowance(grossIncome, pa, tt));
}

/**
 * Calculates UK income tax for a given gross annual income.
 *
 * @param {number} grossIncome  - Gross annual income in GBP (must be >= 0)
 * @param {number} [scaleFactor=1] - Threshold scale factor (must be > 0).
 *   Values > 1 expand all bands (less drag / real-terms tax cut);
 *   values < 1 compress all bands (more drag / real-terms tax rise).
 * @returns {{
 *   grossIncome: number,
 *   personalAllowance: number,
 *   taxableIncome: number,
 *   basicRateTax: number,
 *   higherRateTax: number,
 *   additionalRateTax: number,
 *   totalTax: number,
 *   effectiveRate: number,
 *   netIncome: number,
 *   taxYear: string
 * }}
 */
export function calculateIncomeTax(grossIncome, scaleFactor = 1) {
  if (typeof grossIncome !== 'number' || !isFinite(grossIncome))
    throw new TypeError('grossIncome must be a finite number');
  if (grossIncome < 0) throw new RangeError('grossIncome must be >= 0');
  if (typeof scaleFactor !== 'number' || !isFinite(scaleFactor) || scaleFactor <= 0)
    throw new RangeError('scaleFactor must be a positive finite number');

  // Scale all monetary thresholds
  const pa = round2(PERSONAL_ALLOWANCE * scaleFactor);
  const brl = round2(BASIC_RATE_LIMIT * scaleFactor);
  const art = round2(ADDITIONAL_RATE_THRESHOLD * scaleFactor);
  const tt = round2(TAPER_THRESHOLD * scaleFactor);

  const personalAllowance = effectivePersonalAllowance(grossIncome, pa, tt);
  const taxableIncome = Math.max(0, grossIncome - personalAllowance);

  // Bands are fixed widths of *taxable* income (independent of any PA taper):
  //   basic:      first £37,700 of taxable income
  //   higher:     £37,700 – £125,140 of taxable income
  //   additional: above £125,140 of taxable income
  // This is what produces the 60% effective marginal rate between £100,000
  // and £125,140 — the tapered allowance pushes income into the higher band.
  const basicRateBand = Math.max(0, brl - pa);
  const basicRateTax = Math.min(taxableIncome, basicRateBand) * BASIC_RATE;

  const higherRateTax = Math.max(0, Math.min(taxableIncome, art) - basicRateBand) * HIGHER_RATE;

  const additionalRateTax = Math.max(0, taxableIncome - art) * ADDITIONAL_RATE;

  const totalTax = basicRateTax + higherRateTax + additionalRateTax;
  const effectiveRate = grossIncome > 0 ? totalTax / grossIncome : 0;

  return {
    grossIncome,
    personalAllowance,
    taxableIncome,
    basicRateTax: round2(basicRateTax),
    higherRateTax: round2(higherRateTax),
    additionalRateTax: round2(additionalRateTax),
    totalTax: round2(totalTax),
    effectiveRate: round4(effectiveRate),
    netIncome: round2(grossIncome - totalTax),
    taxYear: TAX_YEAR,
  };
}
