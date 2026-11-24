/**
 * Defined benefit (DB) pension rules — pure helpers used by the lifecycle
 * engine. A DB scheme pays a guaranteed income for life from its payment age,
 * worked out from service and pay rather than from an invested pot.
 *
 * A scheme is described in today's money, as on a benefit statement:
 *
 *   status          'active' (still building up), 'deferred' (left the scheme)
 *                   or 'inPayment' (already being paid)
 *   pension         £/yr built up so far, or being paid for 'inPayment'
 *   accrualRate     active only: pension earned per year, as a share of
 *                   pensionable pay (e.g. 1/54 in a career-average scheme)
 *   memberContributionRate
 *                   active only: your contribution, as a share of pay. Paid by
 *                   net pay arrangement — income tax relief, no NI relief.
 *   inServiceRevaluation
 *                   active only: yearly growth of pension already built up while
 *                   still in the scheme — { basis: 'cpi', margin } for a career
 *                   average scheme (CPI + margin) or { basis: 'earnings' } for a
 *                   final salary scheme (it follows pay)
 *   normalPensionAge, paymentAge
 *                   the scheme's normal pension age and the age it is taken from
 *   earlyReductionPerYear, lateIncreasePerYear
 *                   adjustment per year taken before / after normal pension age
 *   deferredIncreaseCap, paymentIncreaseCap
 *                   yearly increase after leaving / once in payment: CPI, capped
 *                   at this rate (null = full CPI, 0 = no increases)
 *   lumpSum         'none' or 'max': give up pension for tax-free cash at
 *                   commutationFactor (£ of cash per £1/yr given up), up to the
 *                   HMRC maximum
 *   automaticLumpSum
 *                   £ of tax-free cash paid on top of the pension by some older
 *                   schemes (e.g. 3× pension in the NHS 1995 section)
 *   survivorPensionShare
 *                   on the member's death, the share of their pension paid for
 *                   life to a surviving partner (commonly 50%)
 *   survivorPensionForUnmarriedPartner
 *                   whether that survivor's pension is also paid to a partner
 *                   the member wasn't married to (most public-sector schemes do,
 *                   if nominated; many private schemes don't)
 *
 * Sources: HMRC Pensions Tax Manual — pension input amounts for defined benefit
 * arrangements (the "16 times" rule, PTM053100) and the pension commencement
 * lump sum permitted maximum (25% of 20 × pension + lump sum, PTM063200).
 */

export const DB_CONSTANTS = {
  // Annual allowance: a DB pension input amount is 16 × the growth in pension
  // over the year beyond CPI (plus any growth in a separate lump sum).
  pensionInputFactor: 16,
  // Tax-free lump sum maximum: 25% of the benefits' capital value, where the
  // pension is valued at 20 × its annual amount.
  capitalValueFactor: 20,
  maxLumpSumShare: 0.25,
};

export const DB_STATUSES = ['active', 'deferred', 'inPayment'];

// Defaults for anything a statement may not show. Normal pension age 67 is the
// state pension age most current public-sector career average schemes use;
// 12:1 commutation is the usual public-sector factor; ~5% a year is a typical
// actuarial reduction for early payment.
export const DB_DEFAULTS = {
  accrualRate: 1 / 54,
  memberContributionRate: 0.0,
  inServiceRevaluation: { basis: 'cpi', margin: 0.015 },
  normalPensionAge: 67,
  earlyReductionPerYear: 0.05,
  lateIncreasePerYear: 0.05,
  deferredIncreaseCap: null,
  paymentIncreaseCap: null,
  lumpSum: 'none',
  commutationFactor: 12,
  automaticLumpSum: 0,
  survivorPensionShare: 0.5,
  survivorPensionForUnmarriedPartner: true,
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertFiniteInRange(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be a number between ${min} and ${max}`);
}

function assertCap(value, name) {
  if (value !== null) assertFiniteInRange(value, name, 0, 1);
}

/**
 * Validate a scheme and fill in defaults. `currentAge` is needed to check the
 * payment age of a scheme not yet in payment.
 *
 * @param {object} scheme
 * @param {number} currentAge
 * @returns {object} a complete scheme
 */
export function normaliseDbScheme(scheme, currentAge) {
  if (scheme == null || typeof scheme !== 'object') throw new TypeError('scheme must be an object');
  const s = { ...DB_DEFAULTS, label: '', ...scheme };
  if (!DB_STATUSES.includes(s.status))
    throw new RangeError(`scheme status must be one of ${DB_STATUSES.join(', ')}`);
  assertFiniteInRange(s.pension, 'scheme pension', 0, 1e7);
  assertFiniteInRange(s.accrualRate, 'scheme accrualRate', 0, 0.1);
  assertFiniteInRange(s.memberContributionRate, 'scheme memberContributionRate', 0, 0.5);
  const isr = s.inServiceRevaluation;
  if (isr?.basis === 'cpi')
    assertFiniteInRange(isr.margin ?? 0, 'inServiceRevaluation margin', -0.05, 0.05);
  else if (isr?.basis !== 'earnings')
    throw new RangeError("inServiceRevaluation.basis must be 'cpi' or 'earnings'");
  if (!Number.isInteger(s.normalPensionAge) || s.normalPensionAge < 50 || s.normalPensionAge > 75)
    throw new RangeError('scheme normalPensionAge must be an integer between 50 and 75');
  if (s.status !== 'inPayment') {
    if (!Number.isInteger(s.paymentAge) || s.paymentAge < 50 || s.paymentAge > 80)
      throw new RangeError('scheme paymentAge must be an integer between 50 and 80');
    if (s.paymentAge < currentAge)
      throw new RangeError('scheme paymentAge is in the past: set the status to inPayment');
  }
  assertFiniteInRange(s.earlyReductionPerYear, 'scheme earlyReductionPerYear', 0, 0.2);
  assertFiniteInRange(s.lateIncreasePerYear, 'scheme lateIncreasePerYear', 0, 0.2);
  assertCap(s.deferredIncreaseCap, 'scheme deferredIncreaseCap');
  assertCap(s.paymentIncreaseCap, 'scheme paymentIncreaseCap');
  if (s.lumpSum !== 'none' && s.lumpSum !== 'max')
    throw new RangeError("scheme lumpSum must be 'none' or 'max'");
  assertFiniteInRange(s.commutationFactor, 'scheme commutationFactor', 1, 40);
  assertFiniteInRange(s.automaticLumpSum, 'scheme automaticLumpSum', 0, 1e8);
  assertFiniteInRange(s.survivorPensionShare, 'scheme survivorPensionShare', 0, 1);
  if (typeof s.survivorPensionForUnmarriedPartner !== 'boolean')
    throw new TypeError('scheme survivorPensionForUnmarriedPartner must be a boolean');
  return s;
}

/**
 * Multiplier on the pension (and any automatic lump sum) for taking it before
 * or after normal pension age: a straight-line reduction per year early,
 * floored at zero, or increase per year late.
 */
export function dbPaymentFactor(
  normalPensionAge,
  paymentAge,
  earlyReductionPerYear,
  lateIncreasePerYear
) {
  if (paymentAge < normalPensionAge)
    return Math.max(0, 1 - earlyReductionPerYear * (normalPensionAge - paymentAge));
  return 1 + lateIncreasePerYear * (paymentAge - normalPensionAge);
}

/**
 * Largest tax-free cash obtainable by giving up pension, within HMRC's limit:
 * all lump sums ≤ 25% of (20 × the pension left + all lump sums). With pension
 * P before commuting, automatic lump sum A and commutation factor F, the cash
 * L from commuting satisfies A + L ≤ ¼(20(P − L/F) + A + L), so
 *   L ≤ (5P − 0.75A) / (0.75 + 5/F).
 *
 * @param {number} pension          - Annual pension before commuting
 * @param {number} commutationFactor - £ of cash per £1/yr of pension given up
 * @param {number} [automaticLumpSum=0]
 * @returns {number} the extra cash available (≥ 0)
 */
export function maxCommutationLumpSum(pension, commutationFactor, automaticLumpSum = 0) {
  const { capitalValueFactor: k, maxLumpSumShare: q } = DB_CONSTANTS;
  const numerator = q * k * pension - (1 - q) * automaticLumpSum;
  const denominator = 1 - q + (q * k) / commutationFactor;
  return round2(Math.max(0, numerator / denominator));
}

/**
 * Annual allowance pension input amount for one year of a DB scheme: 16 × the
 * growth in the pension beyond `cpiAllowance` (the CPI uplift the opening
 * pension is allowed), floored at zero.
 */
export function dbPensionInputAmount(openingPension, closingPension, cpiAllowance) {
  const growth = closingPension - openingPension * (1 + cpiAllowance);
  return round2(Math.max(0, DB_CONSTANTS.pensionInputFactor * growth));
}

/**
 * Yearly increase for a deferred or in-payment pension: CPI, never negative,
 * capped at `cap` (null = no cap; 0 = no increases).
 */
export function cappedIncrease(cpi, cap) {
  const rise = Math.max(0, cpi);
  return cap === null ? rise : Math.min(rise, cap);
}

/**
 * Yearly growth of pension already built up while still in the scheme.
 */
export function inServiceRevaluationRate(revaluation, cpi, earningsGrowth) {
  if (revaluation.basis === 'earnings') return Math.max(0, earningsGrowth);
  return Math.max(0, cpi + (revaluation.margin ?? 0));
}
