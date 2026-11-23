/**
 * One person in the lifecycle projection.
 *
 * Holds a person's validated inputs and running state — salary, pension, ISA
 * and GIA pots, NI record, Lump Sum Allowance, defined benefit schemes, student
 * loan, and their retirement choices (lump sum, annuity, Class 3 top-up) — and
 * the yearly calculations that belong to one person: pay and tax, state and DB
 * pensions, lump sums, an annuity purchase, bed and ISA, pot growth and each
 * step of the retirement drawdown.
 *
 * The household (ukLifecycle.js) owns what is shared — spending, the mortgage
 * and other debts, life events, the economy for the year — and runs the year
 * loop, calling these functions for each person. Each drawdown step is its own
 * function so a household can run a step across everyone before moving to the
 * next (e.g. fill every personal allowance before touching any ISA).
 *
 * Every function that takes `econ` reads the year's running economy factors:
 *   { cumulInflation, thresholdScale, cumulTriplelock }
 * (price index, tax-threshold index and triple-lock index since the start).
 */

import { calculateIncomeTax, calculateTaxableIncome } from './ukIncomeTax.js';
import { calculateNationalInsurance } from './ukNationalInsurance.js';
import {
  calculateStudentLoan,
  calculateAnnualInterestRate,
  STUDENT_LOAN_PLANS,
} from './ukStudentLoan.js';
import { ISA_CONSTANTS } from './ukISA.js';
import { PENSION_CONSTANTS, calculatePCLS, taperedAnnualAllowance } from './ukPension.js';
import { GIA_CGT_CONSTANTS } from './ukGIA.js';
import { illustrativeAnnuityRate } from './ukAnnuity.js';
import {
  normaliseDbScheme,
  dbPaymentFactor,
  maxCommutationLumpSum,
  dbPensionInputAmount,
  cappedIncrease,
  inServiceRevaluationRate,
} from './ukDefinedBenefit.js';

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

export const LIFECYCLE_CONSTANTS = {
  statePension: {
    fullAnnualAmount: 12_547.6, // 2026/27: £241.30/week × 52 (gov.uk/new-state-pension)
    qualifyingYearsForFull: 35,
    minimumQualifyingYears: 10,
    defaultStatePensionAge: 67,
    // New state pension deferral: +1% per 9 weeks deferred ≈ 5.78%/year (linear,
    // non-compounding), as a share of the pension at claim. Once paid, that extra
    // rises each year with CPI (not the triple lock). Up to 52 weeks can instead
    // be taken as a one-off arrears payment with no interest — not modelled.
    // Source: gov.uk/deferring-state-pension
    deferralUpliftPerYear: 0.0578,
    // Voluntary Class 3 NI: cost of buying one qualifying year (2026/27:
    // £18.40/week × 52). Today's money — inflated when paid. Each year bought
    // adds 1/35 of the full state pension. Source: gov.uk/voluntary-national-insurance-contributions
    class3AnnualCost: 956.8,
  },
  pension: {
    // Normal Minimum Pension Age (NMPA): earliest age a DC pension is accessible.
    // Currently 55; legislated to rise to 57 from 6 April 2028. Default to 57 as
    // the forward-looking figure for anyone retiring in the years ahead.
    defaultAccessAge: 57,
  },
};

// UK income tax personal allowance (2026/27, frozen at £12,570)
export const PERSONAL_ALLOWANCE = 12_570;

const { annualSubscriptionLimit: ISA_LIMIT } = ISA_CONSTANTS;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function assertNonNegativeFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
}

export function assertFinite(value, name) {
  if (typeof value !== 'number' || !isFinite(value))
    throw new TypeError(`${name} must be a finite number`);
}

export function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
}

export function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
}

/** Pro-rate the state pension on qualifying NI years. */
export function computeStatePension(niYears) {
  const { fullAnnualAmount, qualifyingYearsForFull, minimumQualifyingYears } =
    LIFECYCLE_CONSTANTS.statePension;
  if (niYears < minimumQualifyingYears) return 0;
  const capped = Math.min(niYears, qualifyingYearsForFull);
  return round2((capped / qualifyingYearsForFull) * fullAnnualAmount);
}

/**
 * Returns the interpolated investment return rate for a given age.
 * Linearly tapers from accRate to retRate over the window
 * [retirementAge - taperBeforeYrs, retirementAge + taperAfterYrs].
 * Outside that window the rate is clamped to accRate or retRate respectively.
 *
 * Edge cases:
 *   • taperBeforeYrs = taperAfterYrs = 0 → instant step at retirementAge
 *   • taperBeforeYrs so large that taperStart < currentAge → taper already
 *     in progress; the formula still works (t > 0 at currentAge)
 *   • taperBeforeYrs = 0, taperAfterYrs > 0 → taper starts at retirement
 */
export function getRateForAge(
  age,
  retirementAge,
  accRate,
  retRate,
  taperBeforeYrs = 10,
  taperAfterYrs = 5
) {
  if (accRate === retRate) return accRate;
  const taperStart = retirementAge - taperBeforeYrs;
  const taperEnd = retirementAge + taperAfterYrs;
  // Guard against zero-width window (both params = 0): step at retirementAge
  if (taperEnd === taperStart) return age >= taperStart ? retRate : accRate;
  const t = Math.max(0, Math.min(1, (age - taperStart) / (taperEnd - taperStart)));
  return accRate + t * (retRate - accRate);
}

/**
 * Binary-search for the gross pension withdrawal that, after marginal income
 * tax on top of otherIncome, yields exactly netTarget net.
 */
export function pensionGrossForNet(netTarget, maxBalance, otherIncome, scaleFactor = 1) {
  if (netTarget <= 0 || maxBalance <= 0) return 0;
  // Upper bound: the average income tax rate never reaches 50%, so the gross
  // needed is always under 2× the net target (plus slack for banding).
  let lo = 0,
    hi = Math.min(maxBalance, netTarget * 2 + 100_000);
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
  // Same headroom logic as pensionGrossForNet: gross < 2 × net + slack.
  let lo = 0,
    hi = Math.min(maxBalance, netTarget * 2 + 100_000);
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
 * Gains stack on top of taxable income (gross income minus the personal
 * allowance, including the £100k taper): the unused part of the £37,700
 * basic-rate band is taxed at 18%, the remainder at 24%.
 */
export function computeGIACGT(
  gross,
  bal,
  costBasis,
  otherIncome,
  annualExempt = GIA_CGT_CONSTANTS.annualExemptAmount,
  scaleFactor = 1
) {
  if (gross <= 0 || bal <= 0) return 0;
  const gainFrac = Math.max(0, (bal - costBasis) / bal);
  const totalGain = gross * gainFrac; // keep unrounded — intermediate value used in subtraction
  const taxable = Math.max(0, totalGain - annualExempt);
  const taxableIncome = calculateTaxableIncome(Math.max(0, otherIncome), scaleFactor);
  const basicRoom = Math.max(0, GIA_CGT_CONSTANTS.basicRateBandWidth * scaleFactor - taxableIncome);
  const atBasic = Math.min(taxable, basicRoom);
  const atHigher = taxable - atBasic;
  return round2(atBasic * GIA_CGT_CONSTANTS.basicRate + atHigher * GIA_CGT_CONSTANTS.higherRate);
}

/**
 * Binary-search for the gross GIA withdrawal that, after CGT, yields
 * exactly netTarget net.
 */
export function giaGrossForNet(
  netTarget,
  bal,
  costBasis,
  otherIncome,
  annualExempt = 0,
  scaleFactor = 1
) {
  if (netTarget <= 0 || bal <= 0) return 0;
  // When there are no gains, net equals gross
  if (costBasis >= bal) return Math.min(netTarget, bal);
  let lo = 0,
    hi = bal;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const cgt = computeGIACGT(mid, bal, costBasis, otherIncome, annualExempt, scaleFactor);
    if (mid - cgt < netTarget) lo = mid;
    else hi = mid;
  }
  return Math.min(round2((lo + hi) / 2), bal);
}

/** Reduce GIA balance and cost basis proportionally after a gross withdrawal. */
export function applyGIAWithdrawal(bal, costBasis, gross) {
  if (gross <= 0 || bal <= 0) return { bal, costBasis };
  const frac = gross / bal;
  return { bal: round2(bal - gross), costBasis: round2(costBasis * (1 - frac)) };
}

/** Sell `gross` of a person's GIA (proportionally reducing the cost basis). */
function sellGIA(P, gross) {
  const after = applyGIAWithdrawal(P.gia, P.costBasis, gross);
  P.gia = after.bal;
  P.costBasis = after.costBasis;
}

// ---------------------------------------------------------------------------
// Creating a person
// ---------------------------------------------------------------------------

// Employment-hours changes: discrete points where employment income steps to a
// fraction of the full-time-equivalent salary (part-time work, phased
// retirement, a career break). The fraction is applied to the wage-grown
// full-time track, so a later return to 100% restores the full salary. The
// reduced income flows through to pension contributions, tax, NI, student loan
// and savings automatically. fraction is bounded to (0, 1]: 0 is disallowed
// because stopping work entirely is modelled via retirementAge, not here.
function buildHoursFraction(list) {
  if (!Array.isArray(list)) throw new TypeError('employmentChanges must be an array');
  const points = [];
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (ev == null || typeof ev !== 'object')
      throw new TypeError(`employmentChanges[${i}] must be an object`);
    if (!Number.isInteger(ev.age))
      throw new TypeError(`employmentChanges[${i}].age must be an integer`);
    assertNonNegativeFinite(ev.fraction, `employmentChanges[${i}].fraction`);
    if (ev.fraction <= 0 || ev.fraction > 1)
      throw new RangeError(`employmentChanges[${i}].fraction must be in (0, 1]`);
    if (ev.enabled === false) continue;
    points.push({ age: ev.age, fraction: ev.fraction });
  }
  // Most recent change at or before an age wins; equal ages keep input order.
  points.sort((a, b) => a.age - b.age);
  return function hoursFractionAtAge(age) {
    let fraction = 1;
    for (const pt of points) {
      if (pt.age <= age) fraction = pt.fraction;
      else break;
    }
    return fraction;
  };
}

/**
 * Validate one person's inputs and set up their running state.
 *
 * @param {object} profile  - The person's fields of the projectLifecycle profile
 *                            (ages, pay, pension rates, NI record, state pension
 *                            choices, DB schemes, student loan plan, hours changes)
 * @param {object} pots     - Their pots: pensionBalance, isaBalance, giaBalance,
 *                            giaCostBasis, studentLoan
 * @param {object|null} retirementOptions - read for the lump sum choice and any
 *                            annuity (the household reads the rest)
 * @param {number} currentYear - the projection's first calendar year
 */
export function createPerson(profile, pots, retirementOptions, currentYear) {
  const {
    currentAge,
    retirementAge,
    grossIncome,
    employeePensionRate,
    employerPensionRate,
    // When true, the employer contribution is a MATCH: the employer pays its full
    // employerPensionRate only if the employee contributes at least
    // employerMatchThreshold, and nothing otherwise. This models real schemes —
    // including non-1:1 and tiered offers — collapsed to their top rung: the
    // minimum employee contribution that unlocks the maximum employer one (e.g.
    // "put in 6% to get 12%" → threshold 0.06, employerPensionRate 0.12). When
    // false (default) the employer contribution is unconditional.
    employerMatch = false,
    employerMatchThreshold = 0,
    niContributionYears,
    statePensionAge = LIFECYCLE_CONSTANTS.statePension.defaultStatePensionAge,
    statePensionDeferralYears = 0,
    // When true, buy voluntary Class 3 NI years during the bridge between
    // retirement and state pension age to top the state pension up toward the
    // full 35 qualifying years. Cost is funded from the pots; see the retirement
    // phase. Default false. Only meaningful with a retirement phase.
    topUpStatePension = false,
    // Normal Minimum Pension Age — the earliest age a DC pension can be accessed
    // (55 today, rising to 57 in April 2028). Before it, no PCLS or drawdown.
    pensionAccessAge = LIFECYCLE_CONSTANTS.pension.defaultAccessAge,
    dbPensions = [],
    studentLoanPlan = null,
    employmentChanges = [],
    // Lump sum paid if the person dies while still working, as a multiple of
    // salary (death-in-service; couple mode).
    deathInServiceMultiple = 0,
  } = profile;

  assertPositiveInteger(currentAge, 'currentAge');
  assertPositiveInteger(retirementAge, 'retirementAge');
  if (retirementAge <= currentAge)
    throw new RangeError('retirementAge must be greater than currentAge');

  assertNonNegativeFinite(grossIncome, 'grossIncome');
  assertNonNegativeFinite(employeePensionRate, 'employeePensionRate');
  assertNonNegativeFinite(employerPensionRate, 'employerPensionRate');
  if (employeePensionRate > 1) throw new RangeError('employeePensionRate must be <= 1');
  if (employerPensionRate > 1) throw new RangeError('employerPensionRate must be <= 1');
  if (typeof employerMatch !== 'boolean') throw new TypeError('employerMatch must be a boolean');
  assertNonNegativeFinite(employerMatchThreshold, 'employerMatchThreshold');
  if (employerMatchThreshold > 1) throw new RangeError('employerMatchThreshold must be <= 1');

  // Effective employer rate. With matching, the employer pays its full rate only
  // when the employee meets the required threshold, and nothing below it (partial
  // tiers are not modelled — see the profile note). The 1e-4 tolerance absorbs
  // rounding of a solver-derived employee rate to 4 decimal places.
  const effectiveEmployerRate =
    employerMatch && employeePensionRate + 1e-4 < employerMatchThreshold ? 0 : employerPensionRate;

  if (typeof topUpStatePension !== 'boolean')
    throw new TypeError('topUpStatePension must be a boolean');

  assertNonNegativeInteger(niContributionYears, 'niContributionYears');
  assertPositiveInteger(statePensionAge, 'statePensionAge');
  assertNonNegativeInteger(statePensionDeferralYears, 'statePensionDeferralYears');
  assertPositiveInteger(pensionAccessAge, 'pensionAccessAge');
  if (!Array.isArray(dbPensions)) throw new TypeError('dbPensions must be an array');
  const dbSchemes = dbPensions.map((scheme) => normaliseDbScheme(scheme, currentAge));

  if (studentLoanPlan !== null && !STUDENT_LOAN_PLANS[studentLoanPlan])
    throw new TypeError(`studentLoanPlan '${studentLoanPlan}' is not a recognised plan`);

  const hoursFractionAtAge = buildHoursFraction(employmentChanges);
  if (
    typeof deathInServiceMultiple !== 'number' ||
    !Number.isFinite(deathInServiceMultiple) ||
    deathInServiceMultiple < 0 ||
    deathInServiceMultiple > 20
  )
    throw new RangeError('deathInServiceMultiple must be between 0 and 20');

  // ── Pots ──────────────────────────────────────────────────────────────────
  const {
    pensionBalance: initialPension = 0,
    isaBalance: initialISA = 0,
    giaBalance: initialGIA = 0,
    giaCostBasis: initialGIACostBasis = undefined,
    studentLoan: studentLoanConfig = null,
  } = pots;

  assertNonNegativeFinite(initialPension, 'pensionBalance');
  assertNonNegativeFinite(initialISA, 'isaBalance');
  assertNonNegativeFinite(initialGIA, 'giaBalance');

  const initialCostBasis = initialGIACostBasis ?? initialGIA;
  assertNonNegativeFinite(initialCostBasis, 'giaCostBasis');

  // Student loan
  let studentLoan = null;
  if (studentLoanPlan !== null && studentLoanConfig != null && studentLoanConfig.balance > 0) {
    assertNonNegativeFinite(studentLoanConfig.balance, 'studentLoan.balance');
    const repaymentStartYear = studentLoanConfig.repaymentStartYear ?? currentYear;
    if (!Number.isInteger(repaymentStartYear) || repaymentStartYear < 1990)
      throw new RangeError('studentLoan.repaymentStartYear must be an integer >= 1990');
    studentLoan = {
      plan: studentLoanPlan,
      balance: round2(studentLoanConfig.balance),
      writeOffYear: repaymentStartYear + STUDENT_LOAN_PLANS[studentLoanPlan].writeOffYears,
    };
  }

  // ── Lifetime annuity (a planned purchase) ──────────────────────────────────
  // Converts part of the pension into guaranteed, taxable income for life, sized
  // by an income target in today's money: either enough to cover `amountReal` of
  // essential net spending on top of the state pension ('essential'), or a fixed
  // gross income ('fixed'). Bought once, at the first retirement year at or after
  // `purchaseAge` (and the pension access age). If the pension can't afford the
  // target, it buys what it can. `rate` is the first year's income per £ of
  // price; null means "use the illustrative table at the actual purchase age".
  let annuityCfg = null;
  {
    const an = retirementOptions?.annuity ?? null;
    if (an != null) {
      const { purchaseAge, inflationLinked = true, rate = null, sizing, amountReal } = an;
      if (!Number.isInteger(purchaseAge) || purchaseAge < 0)
        throw new RangeError(
          'retirementOptions.annuity.purchaseAge must be a non-negative integer'
        );
      if (typeof inflationLinked !== 'boolean')
        throw new TypeError('retirementOptions.annuity.inflationLinked must be a boolean');
      if (rate != null && (!Number.isFinite(rate) || rate <= 0 || rate > 0.5))
        throw new RangeError('retirementOptions.annuity.rate must be in (0, 0.5] or null');
      if (sizing !== 'essential' && sizing !== 'fixed')
        throw new RangeError("retirementOptions.annuity.sizing must be 'essential' or 'fixed'");
      assertNonNegativeFinite(amountReal, 'retirementOptions.annuity.amountReal');
      annuityCfg = { purchaseAge, inflationLinked, rate, sizing, amountReal };
    }
  }

  // Share of the pension still payable tax-free while it is uncrystallised: the
  // planned lump-sum percentage when a PCLS will be taken, otherwise 25% of each
  // UFPLS withdrawal. Feeds the display-only after-tax estimate on each row.
  const uncrystallisedTaxFreeShare = retirementOptions?.takePCLS
    ? Math.max(
        0,
        Math.min(
          PENSION_CONSTANTS.maxPCLSPercentage,
          retirementOptions.pclsPercentage ?? PENSION_CONSTANTS.maxPCLSPercentage
        )
      )
    : PENSION_CONSTANTS.maxPCLSPercentage;

  // State pension claim point (state pension age + any deferral). The extra
  // from deferring is fixed at claim as a share of the pension then payable and
  // afterwards rises with CPI only; the base pension keeps the triple lock
  // (GOV.UK, "Defer your State Pension": annual increases). The running factors
  // are recorded as the projection passes the claim age; a claim before the
  // projection starts is treated as claimed at the start.
  const spClaimAge = statePensionAge + statePensionDeferralYears;
  const spDeferralExtraShare =
    LIFECYCLE_CONSTANTS.statePension.deferralUpliftPerYear * statePensionDeferralYears;

  return {
    // ── Inputs ──
    currentAge,
    // The TARGET retirement age; the household decides when work actually stops
    // (later, with flexible retirement) and records it in `retiredAt`.
    retirementAge,
    employeePensionRate,
    employerRate: effectiveEmployerRate,
    statePensionAge,
    statePensionDeferralYears,
    topUpStatePension,
    pensionAccessAge,
    hoursFractionAtAge,
    deathInServiceMultiple,
    annuityCfg,
    uncrystallisedTaxFreeShare,
    spClaimAge,
    spDeferralExtraShare,
    // Deferring the state pension raises it for life (~5.8% per year deferred).
    statePensionDeferralUplift:
      1 + LIFECYCLE_CONSTANTS.statePension.deferralUpliftPerYear * statePensionDeferralYears,

    // ── Running state ──
    income: round2(grossIncome), // full-time-equivalent salary track
    niYears: niContributionYears,
    pension: round2(initialPension),
    isa: round2(initialISA),
    gia: round2(initialGIA),
    costBasis: round2(initialCostBasis),
    studentLoan,
    // Lump Sum Allowance left: the lifetime cap on tax-free cash, shared by DB
    // lump sums, the DC tax-free lump sum (PCLS) and tax-free UFPLS withdrawals.
    lsaRemaining: PENSION_CONSTANTS.lumpSumAllowance,
    // Running state of each DB scheme, in cash terms: the pension built up (or
    // being paid) and any automatic lump sum. Statements are in today's money,
    // which is cash at the projection start.
    dbStates: dbSchemes.map((scheme) => ({
      scheme,
      pension: scheme.pension,
      automaticLumpSum: scheme.automaticLumpSum,
      active: scheme.status === 'active',
      inPayment: scheme.status === 'inPayment',
      startAge: scheme.status === 'inPayment' ? currentAge : null,
      pensionAtStart: scheme.status === 'inPayment' ? scheme.pension : null,
      cumulInflationAtStart: 1,
      lumpSum: 0,
    })),
    spClaimCumInfl: spClaimAge <= currentAge ? 1 : null,
    spClaimCumTriplelock: spClaimAge <= currentAge ? 1 : null,

    // ── Retirement (set by enterRetirement) ──
    retiredAt: null,
    takePCLS: false,
    pclsPct: 0,
    pcls: { lumpSum: 0, capped: false, pending: false, atEntry: false, toISAAtEntry: 0 },
    // Voluntary Class 3 NI years bought during the bridge, their total (nominal)
    // cost, and how many are still to buy.
    class3: { yearsBought: 0, totalCost: 0, yearsRemaining: 0 },
    annuity: null,

    // ── Couple mode (set by the household) ──
    // Age at death in a "what if one of us dies" plan; null while alive.
    diedAt: null,
    // A pension inherited from a partner, kept apart from the person's own pot:
    // withdrawals are tax-free if the partner died before 75, otherwise taxed
    // as income — and neither uses the person's Lump Sum Allowance. Null until
    // something is inherited.
    inherited: null,
  };
}

// ---------------------------------------------------------------------------
// State pension
// ---------------------------------------------------------------------------

/** Record the running factors as the projection passes the claim age. */
export function recordStatePensionClaim(P, age, econ) {
  if (age === P.spClaimAge) {
    P.spClaimCumInfl = econ.cumulInflation;
    P.spClaimCumTriplelock = econ.cumulTriplelock;
  }
}

/**
 * Nominal state pension payable in the year the projection is at `age`, from
 * the running inflation / triple-lock factors: nothing before the claim age
 * or below the minimum qualifying years; otherwise the triple-locked base plus
 * any deferral extra (CPI-uprated since the claim). Used by both the working
 * and retirement phases — the pension is paid from the claim age whether or
 * not the person is still working.
 */
export function statePensionGrossAt(P, age, qualifyingYears, econ) {
  if (age < P.spClaimAge) return 0;
  const fullRate = computeStatePension(qualifyingYears); // 0 below the minimum
  if (fullRate <= 0) return 0;
  const claimInfl = P.spClaimCumInfl ?? econ.cumulInflation; // always recorded; defensive
  const claimTriplelock = P.spClaimCumTriplelock ?? econ.cumulTriplelock;
  const deferralExtra =
    fullRate * claimTriplelock * P.spDeferralExtraShare * (econ.cumulInflation / claimInfl);
  return round2(fullRate * econ.cumulTriplelock + deferralExtra);
}

// ---------------------------------------------------------------------------
// Defined benefit pensions
// ---------------------------------------------------------------------------

/**
 * Advance every DB scheme through the year at `age`. `yr` holds this year's
 * rates; `revalue` is false in the first projection year (values are already
 * as at today). An active scheme builds up while `working`, on `pay`, until
 * it is paid; after leaving it grows by its deferred increases. At its
 * payment age it is adjusted for early or late payment, part may be swapped
 * for tax-free cash, and it is paid from that year, rising each year after.
 *
 * Returns this year's totals: gross income, member contributions, annual
 * allowance pension input, and lump sums (tax-free within the remaining Lump
 * Sum Allowance, any excess taxable).
 */
export function advanceDbSchemes(P, age, yr, revalue, working, pay, econ) {
  const out = {
    gross: 0,
    memberContribution: 0,
    pensionInput: 0,
    lumpTaxFree: 0,
    lumpTaxable: 0,
  };
  for (const st of P.dbStates) {
    const s = st.scheme;
    if (st.inPayment) {
      if (revalue && age > st.startAge)
        st.pension = round2(
          st.pension * (1 + cappedIncrease(yr.inflationRate, s.paymentIncreaseCap))
        );
      out.gross = round2(out.gross + st.pension);
      continue;
    }
    // Building up only while working for the scheme and before taking it.
    if (st.active && !(working && age < s.paymentAge)) st.active = false;
    const opening = st.pension;
    if (revalue) {
      const rate = st.active
        ? inServiceRevaluationRate(s.inServiceRevaluation, yr.inflationRate, yr.wageGrowthRate)
        : cappedIncrease(yr.inflationRate, s.deferredIncreaseCap);
      st.pension = round2(st.pension * (1 + rate));
      st.automaticLumpSum = round2(st.automaticLumpSum * (1 + rate));
    }
    if (st.active) {
      st.pension = round2(st.pension + s.accrualRate * pay);
      out.memberContribution = round2(out.memberContribution + s.memberContributionRate * pay);
      out.pensionInput = round2(
        out.pensionInput +
          dbPensionInputAmount(opening, st.pension, revalue ? Math.max(0, yr.inflationRate) : 0)
      );
    }
    if (age === s.paymentAge) {
      const factor = dbPaymentFactor(
        s.normalPensionAge,
        s.paymentAge,
        s.earlyReductionPerYear,
        s.lateIncreasePerYear
      );
      let pension = round2(st.pension * factor);
      const automatic = round2(st.automaticLumpSum * factor);
      let commuted = 0;
      if (s.lumpSum === 'max') {
        // Up to the HMRC maximum, and only as far as it stays tax-free.
        const room = Math.max(0, P.lsaRemaining - automatic);
        commuted = round2(
          Math.min(maxCommutationLumpSum(pension, s.commutationFactor, automatic), room)
        );
        pension = round2(pension - commuted / s.commutationFactor);
      }
      const lump = round2(automatic + commuted);
      const taxFree = round2(Math.min(lump, P.lsaRemaining));
      P.lsaRemaining = round2(P.lsaRemaining - taxFree);
      out.lumpTaxFree = round2(out.lumpTaxFree + taxFree);
      out.lumpTaxable = round2(out.lumpTaxable + lump - taxFree);
      Object.assign(st, {
        pension,
        inPayment: true,
        startAge: age,
        pensionAtStart: pension,
        cumulInflationAtStart: econ.cumulInflation,
        lumpSum: lump,
      });
      out.gross = round2(out.gross + pension);
    }
  }
  return out;
}

/**
 * DB income this year in cash terms if every scheme not yet paid were taken
 * now at its planned terms — what is in payment, plus each future pension
 * after any early/late adjustment and lump sum swap. Used to size an annuity
 * around the guaranteed income the plan will have.
 */
export function dbPlannedGross(P) {
  let total = 0;
  for (const st of P.dbStates) {
    if (st.inPayment) {
      total += st.pension;
      continue;
    }
    const s = st.scheme;
    let pension =
      st.pension *
      dbPaymentFactor(
        s.normalPensionAge,
        s.paymentAge,
        s.earlyReductionPerYear,
        s.lateIncreasePerYear
      );
    if (s.lumpSum === 'max') {
      const automatic = st.automaticLumpSum;
      pension -=
        maxCommutationLumpSum(pension, s.commutationFactor, automatic) / s.commutationFactor;
    }
    total += pension;
  }
  return round2(total);
}

/**
 * DB income at age `a` in today's money, projected from the schemes' state at
 * `atAge` under central inflation — for the rundown checks. A scheme not yet
 * paid stops building up (the check asks "if I stopped now") and grows by its
 * deferred increases until paid, after its early/late adjustment and any lump
 * sum swap; once paid it rises by its increases. Increases that are capped (or
 * none) lose value against central inflation. Lump sums are left out, which is
 * slightly conservative.
 */
export function dbRealIncomeAt(P, a, atAge, deflate, inflationRate) {
  let total = 0;
  const realGrowth = (cap, years) =>
    Math.pow(
      (1 + (cap === null ? inflationRate : Math.min(cap, inflationRate))) / (1 + inflationRate),
      Math.max(0, years)
    );
  for (const st of P.dbStates) {
    const s = st.scheme;
    if (st.inPayment) {
      total += st.pension * deflate * realGrowth(s.paymentIncreaseCap, a - atAge);
      continue;
    }
    if (a < s.paymentAge) continue;
    let pension =
      st.pension *
      deflate *
      realGrowth(s.deferredIncreaseCap, s.paymentAge - atAge) *
      dbPaymentFactor(
        s.normalPensionAge,
        s.paymentAge,
        s.earlyReductionPerYear,
        s.lateIncreasePerYear
      );
    if (s.lumpSum === 'max')
      pension -=
        maxCommutationLumpSum(pension, s.commutationFactor, st.automaticLumpSum * deflate) /
        s.commutationFactor;
    total += pension * realGrowth(s.paymentIncreaseCap, a - s.paymentAge);
  }
  return total;
}

/** Per-year DB figures for a projection row (null when there are no schemes). */
export function dbRowSummary(P, db) {
  if (P.dbStates.length === 0) return null;
  return {
    gross: db.gross,
    memberContribution: db.memberContribution,
    pensionInput: db.pensionInput,
    lumpSum: round2(db.lumpTaxFree + db.lumpTaxable),
    lumpSumTaxFree: db.lumpTaxFree,
    schemes: P.dbStates.map((st) => ({
      label: st.scheme.label,
      pension: st.pension,
      active: st.active,
      inPayment: st.inPayment,
    })),
  };
}

/**
 * Each DB scheme for the summary: when it was (or will be) paid, the yearly
 * pension then and any lump sum, in cash and today's money. startAge is null
 * if the scheme is not paid within the projection.
 */
export function dbSchemeSummaries(P) {
  return P.dbStates.map((st) => ({
    label: st.scheme.label,
    status: st.scheme.status,
    startAge: st.startAge,
    pensionAtStart: st.pensionAtStart,
    pensionAtStartReal:
      st.pensionAtStart === null ? null : round2(st.pensionAtStart / st.cumulInflationAtStart),
    lumpSum: st.lumpSum,
    lumpSumReal: round2(st.lumpSum / st.cumulInflationAtStart),
  }));
}

// ---------------------------------------------------------------------------
// A working year: pay, pension contributions, tax, NI and student loan
// ---------------------------------------------------------------------------

/** One year of student loan interest and repayment on `adjustedGross`. */
function studentLoanYear(P, year, adjustedGross, yr) {
  const sl = P.studentLoan;
  if (sl === null) return { repayment: 0, row: null };
  if (sl.balance <= 0) {
    return {
      repayment: 0,
      row: {
        openingBalance: 0,
        interestRate: 0,
        interestCharged: 0,
        repayment: 0,
        closingBalance: 0,
        writtenOff: false,
      },
    };
  }
  if (year >= sl.writeOffYear) {
    const row = {
      openingBalance: sl.balance,
      interestRate: 0,
      interestCharged: 0,
      repayment: 0,
      closingBalance: 0,
      writtenOff: true,
    };
    sl.balance = 0;
    return { repayment: 0, row };
  }
  const slInterestRate = calculateAnnualInterestRate(
    sl.plan,
    adjustedGross,
    yr.inflationRate,
    yr.boeRate
  );
  const interestCharged = round2(sl.balance * slInterestRate);
  const balanceAfterInt = round2(sl.balance + interestCharged);
  const planRepayment = calculateStudentLoan(adjustedGross, sl.plan).repayment;
  const repayment = Math.min(planRepayment, balanceAfterInt);
  const closingSL = round2(Math.max(0, balanceAfterInt - repayment));
  const row = {
    openingBalance: sl.balance,
    interestRate: slInterestRate,
    interestCharged,
    repayment,
    closingBalance: closingSL,
    writtenOff: false,
  };
  sl.balance = closingSL;
  return { repayment, row };
}

/**
 * Pay and deductions for a year the person works: salary (after wage growth
 * and any hours change), salary-sacrifice pension contributions, DB build-up,
 * any state or DB pension already paid, the annual allowance, income tax, NI,
 * student loan, and take-home pay. `i` is the projection year index (wage
 * growth and DB revaluation apply from year 1).
 */
export function workingYearPay(P, age, year, i, yr, econ) {
  // Wage growth applies from year 1 onwards; floor at 0 (salary cannot go negative)
  if (i > 0) P.income = Math.max(0, round2(P.income * (1 + yr.wageGrowthRate)));

  // Employment-hours fraction for this age (part-time / phased retirement).
  // Applied to the full-time-grown salary; `income` (the full-time track) keeps
  // growing on its own, so a later return to 100% restores the full amount.
  const hoursFraction = P.hoursFractionAtAge(age);
  const effectiveIncome = round2(P.income * hoursFraction);

  // ── Pension (salary sacrifice) ──────────────────────────────────────
  // Employer contribution uses the effective rate: with matching enabled it
  // is capped at the employee rate (both scale with the same income, so the
  // per-year min of the amounts equals the min of the rates).
  const employeeContrib = round2(effectiveIncome * P.employeePensionRate);
  const employerContrib = round2(effectiveIncome * P.employerRate);
  const totalPensionContrib = round2(employeeContrib + employerContrib);

  // Adjusted gross income after salary sacrifice
  const adjustedGross = round2(effectiveIncome - employeeContrib);

  // ── Working past state pension age ───────────────────────────────────
  // The state pension is paid from the claim age (state pension age + any
  // deferral) even while still working, and is taxed on top of salary. From
  // state pension age itself, employees stop paying Class 1 NI and further
  // years no longer add qualifying years (the pension rests on the record up
  // to state pension age).
  const pastStatePensionAge = age >= P.statePensionAge;
  const workingStatePension = statePensionGrossAt(P, age, P.niYears, econ);

  // ── Defined benefit pensions ─────────────────────────────────────────
  // Active schemes build up on this year's pay. Member contributions are paid
  // under a net pay arrangement: they come off pay for income tax only, not
  // for NI or student loan repayments. A scheme already being paid (or taken
  // this year) adds taxable income on top of salary.
  const db = advanceDbSchemes(P, age, yr, i > 0, true, effectiveIncome, econ);
  const taxablePay = round2(adjustedGross - db.memberContribution);
  const otherTaxableIncome = round2(workingStatePension + db.gross + db.lumpTaxable);

  // High earners: annual allowance tapers when threshold income > £200k and
  // adjusted income (threshold income + all pension input) > £260k. Threshold
  // income counts all taxable income, including any state or DB pension.
  // Pension input is the DC contributions plus the DB pension input amount.
  const thresholdIncome = round2(taxablePay + otherTaxableIncome);
  const pensionInput = round2(totalPensionContrib + db.pensionInput);
  const annualAllowance = taperedAnnualAllowance(
    thresholdIncome,
    round2(thresholdIncome + pensionInput)
  );
  const annualAllowanceBreached = pensionInput > annualAllowance;

  // ── Tax and NI (with fiscal-drag-adjusted thresholds) ─────────────────
  // thresholdScale > 1 means bands have grown (less drag); < 1 means compressed (more drag).
  // Income tax covers taxable pay plus any state or DB pension; NI is on
  // earnings only, and the employee pays none from state pension age.
  const taxResult = calculateIncomeTax(thresholdIncome, econ.thresholdScale);
  const niResult = calculateNationalInsurance(adjustedGross, econ.thresholdScale);
  const incomeTax = taxResult.totalTax;
  const employeeNI = pastStatePensionAge ? 0 : niResult.employeeNI.total;
  const employerNI = niResult.employerNI.contribution; // informational

  // ── Student loan ────────────────────────────────────────────────────
  const { repayment: slRepayment, row: slRow } = studentLoanYear(P, year, adjustedGross, yr);

  // ── Net take-home ───────────────────────────────────────────────────
  const netTakeHome = round2(
    effectiveIncome +
      otherTaxableIncome -
      employeeContrib -
      db.memberContribution -
      incomeTax -
      employeeNI -
      slRepayment
  );

  return {
    hoursFraction,
    effectiveIncome,
    employeeContrib,
    employerContrib,
    adjustedGross,
    pastStatePensionAge,
    workingStatePension,
    db,
    pensionInput,
    annualAllowance,
    annualAllowanceBreached,
    incomeTax,
    employeeNI,
    employerNI,
    niLowerEarningsLimit: niResult.employeeNI.lowerEarningsLimit,
    slRepayment,
    slRow,
    netTakeHome,
    thresholdIncome,
  };
}

/**
 * Count the year towards the state pension if earnings reached the (scaled)
 * NI Lower Earnings Limit before state pension age. Returns whether it did.
 */
export function recordNiQualifyingYear(P, pay) {
  const qualifying = !pay.pastStatePensionAge && pay.adjustedGross >= pay.niLowerEarningsLimit;
  if (qualifying) P.niYears++;
  return qualifying;
}

// ---------------------------------------------------------------------------
// Moving money in and out of the pots
// ---------------------------------------------------------------------------

/** Add cash to the GIA at cost (net-of-tax money carries no embedded gain). */
export function investInGIA(P, amount) {
  P.gia = round2(P.gia + amount);
  P.costBasis = round2(P.costBasis + amount);
}

/**
 * Invest tax-free cash (a DB lump sum, or the tax-free part of an annuity
 * purchase): into the ISA up to this year's remaining subscription headroom,
 * the rest into the GIA at cost. `isaUsed` is the subscription already used by
 * lump sums this year; returns the new total.
 */
export function investTaxFreeCash(P, amount, isaUsed) {
  const toISA = round2(Math.min(amount, Math.max(0, ISA_LIMIT - isaUsed)));
  P.isa = round2(P.isa + toISA);
  P.gia = round2(P.gia + amount - toISA);
  P.costBasis = round2(P.costBasis + amount - toISA);
  return round2(isaUsed + toISA);
}

/**
 * Fund a one-off expense in a working year, in tax-efficiency order:
 *   1. `cash` — this year's unallocated savings (not yet invested — no tax)
 *   2. GIA (CGT-aware, consumes the annual exempt amount first)
 *   3. ISA (liquid and tax-free)
 * The pension is never raided — it is inaccessible before retirement. Gains
 * stack on `incomeForCGT`. Returns the funding split, the cash left and the
 * annual exempt amount left for later sales this year. A couple funds from
 * both GIAs before either ISA by turning off `useGia` / `useIsa` per call.
 */
export function fundExpenseWhileWorking(
  P,
  amount,
  cash,
  incomeForCGT,
  scale,
  { useGia = true, useIsa = true } = {}
) {
  let exemptRemaining = GIA_CGT_CONSTANTS.annualExemptAmount;
  let fromSavings = 0,
    fromGIAGross = 0,
    giaCGT = 0,
    fromISA = 0,
    shortfall = 0;
  let cashLeft = cash;
  if (amount > 0) {
    let expRemaining = amount;
    fromSavings = round2(Math.min(cashLeft, expRemaining));
    cashLeft = round2(cashLeft - fromSavings);
    expRemaining = round2(expRemaining - fromSavings);

    if (useGia && expRemaining > 0 && P.gia > 0) {
      const gainFracPre = Math.max(0, (P.gia - P.costBasis) / P.gia);
      const gross = round2(
        Math.min(
          P.gia,
          giaGrossForNet(expRemaining, P.gia, P.costBasis, incomeForCGT, exemptRemaining, scale)
        )
      );
      giaCGT = computeGIACGT(gross, P.gia, P.costBasis, incomeForCGT, exemptRemaining, scale);
      const net = round2(gross - giaCGT);
      sellGIA(P, gross);
      fromGIAGross = gross;
      expRemaining = round2(Math.max(0, expRemaining - net));
      exemptRemaining = round2(Math.max(0, exemptRemaining - gross * gainFracPre));
    }

    if (useIsa && expRemaining > 0 && P.isa > 0) {
      fromISA = round2(Math.min(P.isa, expRemaining));
      P.isa = round2(P.isa - fromISA);
      expRemaining = round2(expRemaining - fromISA);
    }

    shortfall = round2(Math.max(0, expRemaining));
  }
  return { fromSavings, fromGIAGross, giaCGT, fromISA, shortfall, cashLeft, exemptRemaining };
}

/**
 * Bed and ISA: use `headroom` of this year's ISA subscription to sell GIA and
 * rebuy inside the ISA (sheltering future growth from CGT). CGT is realised
 * now on any embedded gains, against the exempt amount still unused this year.
 * Grossed up so the net amount landing in the ISA equals the full headroom.
 */
export function bedAndIsa(P, headroom, incomeForCGT, exemptRemaining, scale) {
  let gross = 0,
    cgt = 0,
    net = 0;
  if (headroom > 0 && P.gia > 0) {
    const grossNeeded = giaGrossForNet(
      headroom,
      P.gia,
      P.costBasis,
      incomeForCGT,
      exemptRemaining,
      scale
    );
    gross = round2(Math.min(P.gia, grossNeeded));
    cgt = computeGIACGT(gross, P.gia, P.costBasis, incomeForCGT, exemptRemaining, scale);
    net = round2(gross - cgt);
    sellGIA(P, gross);
    P.isa = round2(P.isa + net);
  }
  return { gross, cgt, net };
}

/**
 * Grow the pots for a working year after this year's contributions. Balances
 * are floored at 0; negative growth (falling markets) cannot produce a
 * negative pot.
 */
export function growPotsWhileWorking(P, rate, { employee, employer, isa, gia }) {
  const penAfterC = round2(P.pension + employee + employer);
  const pensionGrowth = round2(penAfterC * rate);
  P.pension = Math.max(0, round2(penAfterC + pensionGrowth));

  const isaAfterC = round2(P.isa + isa);
  const isaGrowth = round2(isaAfterC * rate);
  P.isa = Math.max(0, round2(isaAfterC + isaGrowth));

  const giaAfterC = round2(P.gia + gia);
  const giaGrowth = round2(giaAfterC * rate);
  P.gia = Math.max(0, round2(giaAfterC + giaGrowth));
  P.costBasis = round2(P.costBasis + gia);
  return { pensionGrowth, isaGrowth, giaGrowth };
}

/** Grow the pots for a retirement year (cost basis is unchanged by growth). */
export function growPotsInRetirement(P, rate) {
  const pensionGrowth = round2(P.pension * rate);
  P.pension = Math.max(0, round2(P.pension + pensionGrowth));
  const isaGrowth = round2(P.isa * rate);
  P.isa = Math.max(0, round2(P.isa + isaGrowth));
  const giaGrowth = round2(P.gia * rate);
  P.gia = Math.max(0, round2(P.gia + giaGrowth));
  return { pensionGrowth, isaGrowth, giaGrowth };
}

/**
 * Rough tax due when the pension is drawn (basic rate on the taxable part),
 * display only. Once the lump sum has been taken the whole pot is taxable;
 * before that (or on the UFPLS path) its tax-free share still applies, within
 * the allowance left.
 */
export function estimatedPensionTaxShare(P) {
  return P.retiredAt !== null && P.takePCLS && !P.pcls.pending
    ? { taxFreeShare: 0 }
    : { taxFreeShare: P.uncrystallisedTaxFreeShare, remainingLSA: P.lsaRemaining };
}

// ---------------------------------------------------------------------------
// Retirement: lump sum, Class 3 top-up and annuity
// ---------------------------------------------------------------------------

/**
 * Crystallise the pot and distribute the tax-free lump sum (PCLS): ISA up to
 * the annual subscription limit, remainder into the GIA at cost. Capped by the
 * Lump Sum Allowance still unused, which is less than the full allowance if a
 * DB scheme has already paid tax-free cash. Returns the ISA headroom consumed,
 * so the same-year bed-and-ISA step doesn't reuse it.
 */
export function takePensionLumpSum(P) {
  const wanted = round2(P.pension * P.pclsPct);
  const pclsResult = calculatePCLS(P.pension, { pclsAmount: Math.min(wanted, P.lsaRemaining) });
  P.pcls.lumpSum = pclsResult.lumpSum;
  P.pcls.capped = wanted > P.pcls.lumpSum + 0.005;
  P.lsaRemaining = round2(P.lsaRemaining - P.pcls.lumpSum);
  P.pension = pclsResult.crystallisedFund;
  const toISA = Math.min(P.pcls.lumpSum, ISA_LIMIT);
  const toGIA = round2(P.pcls.lumpSum - toISA);
  P.isa = round2(P.isa + toISA);
  P.gia = round2(P.gia + toGIA);
  P.costBasis = round2(P.costBasis + toGIA);
  return toISA;
}

/**
 * Stop work at `age` and set up the retirement choices: the lump sum (taken
 * now if the pension is accessible, otherwise when it becomes so), the Class 3
 * top-up target, and the annuity purchase age.
 */
export function enterRetirement(P, age, maxAge, { takePCLS, pclsPercentage }) {
  P.retiredAt = age;
  P.takePCLS = takePCLS;
  P.pclsPct = Math.max(0, Math.min(PENSION_CONSTANTS.maxPCLSPercentage, pclsPercentage));

  // ── PCLS (pension commencement lump sum) ─────────────────────────────────
  // The pension can only be touched from the Normal Minimum Pension Age. PCLS
  // is therefore taken at the first accessible age: retirement when that is
  // already ≥ NMPA, otherwise deferred to the year NMPA is reached (an early
  // retiree bridges the gap from ISA/GIA until then).
  P.pcls.atEntry = takePCLS && P.pension > 0 && age >= P.pensionAccessAge;
  if (P.pcls.atEntry) P.pcls.toISAAtEntry = takePensionLumpSum(P);
  P.pcls.pending = takePCLS && age < P.pensionAccessAge;

  // ── Voluntary Class 3 NI top-up target ───────────────────────────────────
  // Fill the gap toward the 35 qualifying years for the full state pension by
  // buying years during the bridge between retirement and state pension age —
  // the years no longer worked, which is when these gaps arise. The number
  // buyable is capped by that bridge window, and we only start buying if the
  // topped-up total can clear the 10-year minimum (below which the pension is
  // £0, so buying would be wasted). Contributions before state pension age
  // never overlap the pension income, so affordability doesn't depend on the
  // benefit — no circularity. Past gap years before retirement aren't modelled
  // here; represent those via the NI Qualifying Years input instead.
  const { qualifyingYearsForFull, minimumQualifyingYears } = LIFECYCLE_CONSTANTS.statePension;
  const bridgeYears = Math.max(0, P.statePensionAge - age);
  const maxBuyableYears = Math.min(Math.max(0, qualifyingYearsForFull - P.niYears), bridgeYears);
  P.class3.yearsRemaining =
    P.topUpStatePension && P.niYears + maxBuyableYears >= minimumQualifyingYears
      ? maxBuyableYears
      : 0;

  // ── Annuity state ────────────────────────────────────────────────────────
  // Bought at the first retirement year at or after the chosen age and the
  // pension access age. `income0` is the first-year gross income; an
  // inflation-linked annuity then grows with each year's inflation.
  if (P.annuityCfg) {
    const buyAge = Math.max(P.annuityCfg.purchaseAge, age, P.pensionAccessAge);
    P.annuity = {
      buyAge,
      income0: 0,
      cumInflAtPurchase: 1,
      result: {
        purchased: false,
        notNeeded: false,
        purchaseAge: buyAge <= maxAge ? buyAge : null,
        inflationLinked: P.annuityCfg.inflationLinked,
        sizing: P.annuityCfg.sizing,
        rate: null,
        targetIncome: 0,
        income: 0,
        incomeReal: 0,
        price: 0,
        pensionUsed: 0,
        taxFreeCash: 0,
        coverage: 0,
      },
    };
  }
}

/**
 * Annuity income already in payment this year (the purchase year sets its
 * own first payment). Inflation-linked follows this year's (realised, under
 * Monte Carlo) inflation; level stays fixed in cash terms.
 */
export function annuityGrossThisYear(P, econ) {
  const an = P.annuity;
  if (!an || an.income0 <= 0) return 0;
  return round2(
    P.annuityCfg.inflationLinked
      ? (an.income0 * econ.cumulInflation) / an.cumInflAtPurchase
      : an.income0
  );
}

/**
 * Buy the planned annuity if this is its year. `spGross` is this year's state
 * pension, `scale` the tax-threshold index, `isaUsed` the ISA subscription
 * already used by lump sums this year. Returns the purchase (or null), the
 * updated ISA use, and the first year's income (0 if nothing was bought).
 */
/**
 * Guaranteed gross income this person will have once everything already
 * planned is being paid, in this year's money: their state pension (what it
 * pays now if started, otherwise what it will pay at this year's rates,
 * counting any Class 3 years still planned) plus their DB pensions (paid, or
 * as they will be paid). Used to size an annuity around guaranteed income.
 */
export function plannedGuaranteedGross(P, age, econ, spGross) {
  const finalNiYears = P.niYears + P.class3.yearsBought + P.class3.yearsRemaining;
  const spPlanned =
    age >= P.spClaimAge
      ? spGross
      : finalNiYears >= LIFECYCLE_CONSTANTS.statePension.minimumQualifyingYears
        ? round2(
            computeStatePension(finalNiYears) * econ.cumulTriplelock * P.statePensionDeferralUplift
          )
        : 0;
  // Any DB pensions are guaranteed income too: count what they pay, or
  // will pay once taken, alongside the state pension.
  return round2(spPlanned + dbPlannedGross(P));
}

export function maybeBuyAnnuity(P, age, econ, spGross, scale, isaUsed, otherGuaranteedNet = 0) {
  const cfg = P.annuityCfg;
  if (!cfg || age !== P.annuity.buyAge) return { purchase: null, isaUsed, income: null };
  const result = P.annuity.result;
  // First-year gross income target, in this year's money.
  let targetIncome;
  if (cfg.sizing === 'fixed') {
    targetIncome = round2(cfg.amountReal * econ.cumulInflation);
  } else {
    // Cover essential net spending on top of guaranteed income, sized to the
    // permanent gap once the state pension is paid; the years before it
    // starts come from the pots. In a couple the partner's guaranteed income
    // (after their own tax) counts too.
    const guaranteedPlanned = plannedGuaranteedGross(P, age, econ, spGross);
    const guaranteedPlannedNet = round2(
      guaranteedPlanned - calculateIncomeTax(guaranteedPlanned, scale).totalTax
    );
    const needNet = round2(
      Math.max(0, cfg.amountReal * econ.cumulInflation - guaranteedPlannedNet - otherGuaranteedNet)
    );
    // Gross up for income tax, stacked on top of the guaranteed income.
    targetIncome =
      needNet > 0 ? pensionGrossForNet(needNet, Infinity, guaranteedPlanned, scale) : 0;
  }
  const rate = cfg.rate ?? illustrativeAnnuityRate(age, cfg.inflationLinked);
  result.rate = rate;
  result.targetIncome = targetIncome;
  if (targetIncome <= 0) {
    result.notNeeded = true; // the state pension already covers it
    result.coverage = 1;
    return { purchase: null, isaUsed, income: null };
  }
  if (P.pension <= 0) return { purchase: null, isaUsed, income: null }; // nothing left to buy with
  const wantedPrice = targetIncome / rate;
  // On the UFPLS path the pot is uncrystallised: crystallising a slice pays
  // 25% of it tax-free first (within the remaining LSA), so a bigger slice
  // is needed to leave the wanted price. The PCLS path is already
  // crystallised, so the slice is the price. Capped at what the pension holds.
  let slice = wantedPrice;
  if (!P.takePCLS) {
    const grossedUp = wantedPrice / 0.75;
    slice = 0.25 * grossedUp <= P.lsaRemaining ? grossedUp : wantedPrice + P.lsaRemaining;
  }
  slice = round2(Math.min(slice, P.pension));
  const taxFreeCash = P.takePCLS ? 0 : round2(Math.min(0.25 * slice, P.lsaRemaining));
  const price = round2(slice - taxFreeCash);
  P.pension = round2(P.pension - slice);
  if (taxFreeCash > 0) {
    // Same destination as a PCLS: ISA up to this year's remaining headroom,
    // the rest into the GIA at cost.
    P.lsaRemaining = round2(P.lsaRemaining - taxFreeCash);
    isaUsed = investTaxFreeCash(P, taxFreeCash, isaUsed);
  }
  const income = round2(price * rate);
  P.annuity.income0 = income;
  P.annuity.cumInflAtPurchase = econ.cumulInflation;
  Object.assign(result, {
    purchased: true,
    income,
    incomeReal: round2(income / econ.cumulInflation),
    price,
    pensionUsed: slice,
    taxFreeCash,
    coverage: Math.min(1, income / targetIncome),
  });
  return { purchase: { price, pensionUsed: slice, taxFreeCash, rate }, isaUsed, income };
}

/**
 * This year's voluntary Class 3 cost (0 if none is due): a bridge year before
 * state pension age buys one qualifying year while any remain to buy. Today's
 * money inflated to this year, like expenses.
 */
export function class3CostThisYear(P, age, econ) {
  const buyYear = P.class3.yearsRemaining > 0 && age < P.statePensionAge;
  return buyYear
    ? round2(LIFECYCLE_CONSTANTS.statePension.class3AnnualCost * econ.cumulInflation)
    : 0;
}

/**
 * Settle this year's Class 3 purchase. The cost sat at the bottom of the
 * year's need, so any `unmet` amount eats it first: the year is bought only if
 * the whole need (including the cost) was funded. If pots run dry partway
 * through the cost, the year isn't bought — any partial draw (< one year's
 * cost, only in a near-exhausted year) is absorbed. Returns the unfunded part,
 * whether a year was bought, and the contribution paid.
 */
export function settleClass3(P, cost, unmet) {
  const unfunded = round2(Math.min(cost, unmet));
  const bought = cost > 0 && unfunded <= 0.005; // whole cost funded
  const contribution = bought ? cost : 0;
  if (bought) {
    P.class3.yearsBought += 1;
    P.class3.yearsRemaining -= 1;
    P.class3.totalCost = round2(P.class3.totalCost + contribution);
  }
  return { unfunded, bought, contribution };
}

// ---------------------------------------------------------------------------
// Retirement drawdown steps
// ---------------------------------------------------------------------------
// Each step draws what it can towards `remaining` (a net amount), mutates the
// person's pots and returns what it drew and what is still needed. The
// household runs them in order: tax-free pension → CGT-exempt GIA → ISA →
// taxable GIA → taxable pension.

/**
 * Step 1. Pension that fits in the personal allowance left after guaranteed
 * income (no tax). PCLS taken: the fund is crystallised — every £1 is taxable
 * income. UFPLS: each £1 is min(25%, LSA left / gross) tax-free + the rest
 * taxable. The limit is the gross whose taxable part exactly fills the PA:
 *   • LSA exhausted: 100% taxable → gross = taxFreeRoom
 *   • LSA ≥ taxFreeRoom/3: normal 25%/75% split → gross = taxFreeRoom / 0.75
 *   • LSA < taxFreeRoom/3: use all remaining LSA, rest taxable
 *       taxable = gross − lsaRemaining = taxFreeRoom → gross = taxFreeRoom + lsaRemaining
 * Skipped before the pension is accessible (NMPA) — the pot is left to grow.
 */
export function drawPensionWithinAllowance(P, remaining, accessible, guaranteedGross, scale) {
  let draw = 0;
  let taxFree = 0;
  if (accessible && remaining > 0 && P.pension > 0) {
    const scaledPA = round2(PERSONAL_ALLOWANCE * scale);
    const taxFreeRoom = round2(Math.max(0, scaledPA - guaranteedGross));
    let limit;
    if (P.takePCLS || taxFreeRoom <= 0) {
      limit = taxFreeRoom;
    } else if (P.lsaRemaining <= 0) {
      limit = taxFreeRoom; // fully taxable
    } else if (P.lsaRemaining >= taxFreeRoom / 3) {
      limit = round2(taxFreeRoom / 0.75); // normal UFPLS split
    } else {
      limit = round2(taxFreeRoom + P.lsaRemaining); // exhaust remaining LSA
    }
    draw = round2(Math.min(remaining, Math.min(limit, P.pension)));
    P.pension = round2(P.pension - draw);
    remaining = round2(remaining - draw);

    // Compute the tax-free component and consume from the LSA.
    taxFree = P.takePCLS ? 0 : round2(Math.min(0.25 * draw, P.lsaRemaining));
    if (!P.takePCLS) P.lsaRemaining = round2(Math.max(0, P.lsaRemaining - taxFree));
  }
  return { draw, taxFree, remaining };
}

/**
 * Step 2. GIA up to the annual CGT exempt amount (gains realised tax-free).
 * Also returns the gain fraction before the sale, so the household can work
 * out how much of the exemption is left for bed and ISA.
 */
export function drawGiaWithinExemption(P, remaining, incomeForCGT, scale) {
  const gainFracPre = P.gia > 0 ? Math.max(0, (P.gia - P.costBasis) / P.gia) : 0;
  let draw = 0;
  let cgt = 0;
  if (remaining > 0 && P.gia > 0) {
    const grossForExempt =
      gainFracPre > 0 ? GIA_CGT_CONSTANTS.annualExemptAmount / gainFracPre : P.gia; // unrounded — used only in Math.min
    draw = round2(Math.min(remaining, Math.min(grossForExempt, P.gia)));
    cgt = computeGIACGT(
      draw,
      P.gia,
      P.costBasis,
      incomeForCGT,
      GIA_CGT_CONSTANTS.annualExemptAmount,
      scale
    );
    const net = round2(draw - cgt);
    sellGIA(P, draw);
    remaining = round2(remaining - net);
  }
  return { draw, cgt, gainFracPre, remaining };
}

/** Step 3. ISA: completely tax-free. */
export function drawIsa(P, remaining) {
  const draw = round2(Math.min(remaining, P.isa));
  P.isa = round2(P.isa - draw);
  return { draw, remaining: round2(remaining - draw) };
}

/**
 * Step 4. GIA beyond the exemption: CGT on the gains (the exempt amount was
 * already used in step 2, so gains are fully taxed).
 */
export function drawGiaTaxable(P, remaining, incomeForCGT, scale) {
  let draw = 0;
  let cgt = 0;
  if (remaining > 0 && P.gia > 0) {
    const gross = giaGrossForNet(remaining, P.gia, P.costBasis, incomeForCGT, 0, scale);
    cgt = computeGIACGT(gross, P.gia, P.costBasis, incomeForCGT, 0, scale);
    const net = round2(gross - cgt);
    sellGIA(P, gross);
    draw = gross;
    remaining = round2(remaining - net);
  }
  return { draw, cgt, remaining };
}

/**
 * Step 5. Taxable pension: income tax on the part above the personal
 * allowance. UFPLS: only the non-tax-free part is taxable income; the tax-free
 * part is limited by the Lump Sum Allowance left (less than 25% once it runs
 * low).
 */
export function drawPensionTaxable(P, remaining, accessible, incomeForCGT, scale) {
  let draw = 0;
  let taxFree = 0;
  if (accessible && remaining > 0 && P.pension > 0) {
    const gross = P.takePCLS
      ? pensionGrossForNet(remaining, P.pension, incomeForCGT, scale)
      : ufplsGrossForNet(remaining, P.pension, incomeForCGT, scale, P.lsaRemaining);
    taxFree = P.takePCLS ? 0 : round2(Math.min(0.25 * gross, P.lsaRemaining));
    if (!P.takePCLS) P.lsaRemaining = round2(Math.max(0, P.lsaRemaining - taxFree));
    const taxableIncome = round2(gross - taxFree);
    const tax = round2(
      calculateIncomeTax(incomeForCGT + taxableIncome, scale).totalTax -
        calculateIncomeTax(incomeForCGT, scale).totalTax
    );
    const net = round2(gross - tax);
    P.pension = round2(P.pension - gross);
    draw = gross;
    remaining = round2(remaining - net);
  }
  return { draw, taxFree, remaining };
}

/**
 * Gross pension withdrawal whose taxable part is `taxable`: under UFPLS a
 * quarter of each £1 is tax-free while the Lump Sum Allowance lasts, so the
 * gross is taxable / 0.75 — or, once the allowance runs out partway, the
 * taxable amount plus what's left of it. With the lump sum already taken
 * every £1 is taxable. Capped at the pot.
 */
export function pensionGrossForTaxable(P, taxable) {
  if (taxable <= 0 || P.pension <= 0) return 0;
  let gross = taxable;
  if (!P.takePCLS && P.lsaRemaining > 0)
    gross = 0.25 * (taxable / 0.75) <= P.lsaRemaining ? taxable / 0.75 : taxable + P.lsaRemaining;
  return Math.min(round2(gross), P.pension);
}

/**
 * Withdraw `gross` from the pension (step 5 across a couple), taxed on top of
 * `incomeForCGT`. Returns the draw, its tax-free part and the net received.
 */
export function drawPensionGross(P, gross, incomeForCGT, scale) {
  const draw = round2(Math.min(gross, P.pension));
  if (draw <= 0) return { draw: 0, taxFree: 0, net: 0 };
  const taxFree = P.takePCLS ? 0 : round2(Math.min(0.25 * draw, P.lsaRemaining));
  if (!P.takePCLS) P.lsaRemaining = round2(Math.max(0, P.lsaRemaining - taxFree));
  const taxableIncome = round2(draw - taxFree);
  const tax = round2(
    calculateIncomeTax(incomeForCGT + taxableIncome, scale).totalTax -
      calculateIncomeTax(incomeForCGT, scale).totalTax
  );
  P.pension = round2(P.pension - draw);
  return { draw, taxFree, net: round2(draw - tax) };
}

/**
 * Step 1b. A taxable inherited pension (partner died at 75 or over) within
 * whatever personal allowance is left after `taxableSoFar` of income — so a
 * survivor with no pension of their own doesn't waste their allowance.
 */
export function drawInheritedWithinAllowance(P, remaining, taxableSoFar, scale) {
  if (!P.inherited?.taxable || remaining <= 0) return { draw: 0, remaining };
  const room = Math.max(0, round2(PERSONAL_ALLOWANCE * scale) - taxableSoFar);
  const draw = round2(Math.min(remaining, room, P.inherited.taxable));
  P.inherited.taxable = round2(P.inherited.taxable - draw);
  return { draw, remaining: round2(remaining - draw) };
}

/** Step 3a. An inherited pension paid out tax-free (partner died before 75). */
export function drawInheritedTaxFree(P, remaining) {
  if (!P.inherited?.taxFree) return { draw: 0, remaining };
  const draw = round2(Math.min(remaining, P.inherited.taxFree));
  P.inherited.taxFree = round2(P.inherited.taxFree - draw);
  return { draw, remaining: round2(remaining - draw) };
}

/**
 * Step 4b. An inherited pension taxed as income (partner died at 75 or over):
 * every £1 is taxable, stacked on `incomeForCGT`, with no tax-free part.
 */
export function drawInheritedTaxable(P, remaining, incomeForCGT, scale) {
  if (!P.inherited?.taxable || remaining <= 0) return { draw: 0, remaining };
  const draw = pensionGrossForNet(remaining, P.inherited.taxable, incomeForCGT, scale);
  const tax = round2(
    calculateIncomeTax(incomeForCGT + draw, scale).totalTax -
      calculateIncomeTax(incomeForCGT, scale).totalTax
  );
  P.inherited.taxable = round2(P.inherited.taxable - draw);
  return { draw, remaining: round2(remaining - round2(draw - tax)) };
}

/** Grow any inherited pension pots, returning the growth. */
export function growInheritedPension(P, rate) {
  if (!P.inherited) return 0;
  const tfGrowth = round2(P.inherited.taxFree * rate);
  const txGrowth = round2(P.inherited.taxable * rate);
  P.inherited.taxFree = Math.max(0, round2(P.inherited.taxFree + tfGrowth));
  P.inherited.taxable = Math.max(0, round2(P.inherited.taxable + txGrowth));
  return round2(tfGrowth + txGrowth);
}

/** Total inherited pension still held (0 if none). */
export function inheritedPensionBalance(P) {
  return P.inherited ? round2(P.inherited.taxFree + P.inherited.taxable) : 0;
}
