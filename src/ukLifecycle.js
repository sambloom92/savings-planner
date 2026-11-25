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
 *
 * Structure: this module is the household — shared spending, the mortgage
 * and other debts, life events, the economy and the year loop. Everything
 * that belongs to one person (pay and tax, pots, state and DB pensions,
 * lump sums, annuity, drawdown steps) lives in ukLifecyclePerson.js.
 */

import { calculateIncomeTax } from './ukIncomeTax.js';
import { calculateMonthlyMortgagePayment } from './ukDebt.js';
import { ISA_CONSTANTS } from './ukISA.js';
import { PENSION_CONSTANTS, estimatePensionWithdrawalTax } from './ukPension.js';
import { GIA_CGT_CONSTANTS } from './ukGIA.js';
import {
  LIFECYCLE_CONSTANTS,
  round2,
  assertNonNegativeFinite,
  assertFinite,
  assertPositiveInteger,
  computeStatePension,
  getRateForAge,
  createPerson,
  recordStatePensionClaim,
  statePensionGrossAt,
  advanceDbSchemes,
  dbRealIncomeAt,
  dbRowSummary,
  dbSchemeSummaries,
  workingYearPay,
  recordNiQualifyingYear,
  investInGIA,
  investTaxFreeCash,
  fundExpenseWhileWorking,
  bedAndIsa,
  harvestGainsWithinExemption,
  transferGIA,
  reliefAtSourceRoom,
  payWithReliefAtSource,
  growPotsWhileWorking,
  growPotsInRetirement,
  estimatedPensionTaxShare,
  enterRetirement,
  takePensionLumpSum,
  annuityGrossThisYear,
  maybeBuyAnnuity,
  class3CostThisYear,
  settleClass3,
  drawPensionWithinAllowance,
  drawGiaWithinExemption,
  drawIsa,
  drawGiaTaxable,
  drawPensionTaxable,
  PERSONAL_ALLOWANCE,
  plannedGuaranteedGross,
  pensionGrossForTaxable,
  drawPensionGross,
  drawInheritedWithinAllowance,
  drawInheritedTaxFree,
  drawInheritedTaxable,
  growInheritedPension,
  inheritedPensionBalance,
} from './ukLifecyclePerson.js';
import { PARTNERSHIPS, settleDeath } from './ukEstate.js';

export { LIFECYCLE_CONSTANTS };

export const COUPLE_DEFAULTS = {
  // Household spending after one partner dies, as a share of the couple's.
  // Retirement Living Standards 2026 (Pensions UK, formerly the PLSA): a
  // one-person household's budget is 72% of a two-person one at the Moderate
  // (£32,700 vs £45,400) and Comfortable (£45,400 vs £62,700) standards, and
  // 62% at Minimum (£13,900 vs £22,500).
  survivorSpendingShare: 0.72,
  // Marriage Allowance: personal allowance a spouse or civil partner can
  // transfer to a basic-rate partner (2026/27; gov.uk/marriage-allowance).
  marriageAllowance: 1_260,
};
// Width of the basic-rate band (2026/27), for the Marriage Allowance test.
const BASIC_RATE_BAND = 37_700;

const TAX_YEAR = '2026/27';
const { annualSubscriptionLimit: ISA_LIMIT } = ISA_CONSTANTS;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Projects an individual's whole-of-life financial position year by year
 * from the current year to their nominated retirement age.
 *
 * @param {{
 *   currentAge:             number,         - Current age in whole years
 *   retirementAge:          number,         - Target retirement age (> currentAge)
 *   currentYear?:           number,         - Starting calendar year (default 2025)
 *   grossIncome:            number,         - Current annual gross employment income (£)
 *   annualLivingExpenses?:  number,         - Non-debt living costs at today's prices (£, default 0)
 *                                             Inflated each year; savings = disposable − living expenses.
 *   employeePensionRate:    number,         - Employee pension as fraction of gross (0–1)
 *   employerPensionRate:    number,         - Employer pension as fraction of gross (0–1).
 *                                             With employerMatch, this is the maximum matched rate.
 *   employerMatch?:         boolean,        - When true, the employer pays employerPensionRate only if
 *                                             the employee contributes at least employerMatchThreshold,
 *                                             and 0 otherwise (partial tiers are not modelled). Default
 *                                             false (unconditional employer contribution).
 *   employerMatchThreshold?: number,        - Minimum employee fraction of gross (0–1) that unlocks the
 *                                             full employer contribution when employerMatch is true.
 *                                             Default 0. Models any scheme by its top rung, e.g. "put in
 *                                             6% to get 12%" → threshold 0.06, employerPensionRate 0.12.
 *   niContributionYears:    number,         - Existing NI qualifying years already accrued
 *   statePensionAge?:       number,         - State pension age (default 67)
 *   statePensionDeferralYears?: number,     - Years to defer the state pension past
 *                                             statePensionAge (default 0). Each deferred
 *                                             year raises the weekly amount by 1% per
 *                                             9 weeks ≈ 5.8% (new state pension rules).
 *   topUpStatePension?:     boolean,        - Buy voluntary Class 3 NI years during the
 *                                             retirement→state-pension-age bridge to reach the
 *                                             35 qualifying years for the full state pension.
 *                                             Cost funded from the pots; buys fewer years if
 *                                             unaffordable, never below the 10-year minimum
 *                                             benefit. Default false.
 *   dbPensions?:            object[],       - Defined benefit schemes (see ukDefinedBenefit.js),
 *                                             in today's money. Active schemes build up while
 *                                             working, with member contributions taxed under a
 *                                             net pay arrangement (income tax relief, no NI
 *                                             relief) and accrual counted towards the annual
 *                                             allowance. From its payment age each pays a
 *                                             guaranteed, taxable income; any lump sum uses the
 *                                             same Lump Sum Allowance as the DC pension.
 *   pensionAccessAge?:      number,         - Earliest age the DC pension can be accessed
 *                                             (NMPA; default 57). Before it, no PCLS or
 *                                             pension drawdown — spending is bridged from
 *                                             ISA/GIA, and any gap shows as a shortfall.
 *   studentLoanPlan?:       string | null   - 'plan1'|'plan2'|'plan4'|'plan5'|'postgrad'|null
 *   windfalls?: Array<{                     - Discrete events adding money to the GIA
 *     age:      number,                       at a given age (inheritance, asset sale, gift).
 *     amount:   number,                       Today's money, net of fees/taxes; inflated to
 *     label?:   string,                       the event year. Full amount added to cost basis.
 *     enabled?: boolean                       enabled: false skips the event (default true).
 *   }>
 *   oneOffExpenses?: Array<{                - Discrete outflows at a given age (house
 *     age:      number,                       deposit, wedding, helping children). Today's
 *     amount:   number,                       money, inflated to the event year. Funded from
 *     label?:   string,                       savings → GIA → ISA (accumulation) or via the
 *     enabled?: boolean                       drawdown order (retirement); never the pension.
 *   }>                                        enabled: false skips the event (default true).
 *   employmentChanges?: Array<{             - Discrete changes to employment hours (part-time,
 *     age:      number,                       phased retirement, career break). From the given
 *     fraction: number,                       age, employment income steps to `fraction` of the
 *     label?:   string,                       full-time-equivalent salary (0 < fraction ≤ 1).
 *     enabled?: boolean                       Pension contributions (employee & employer), tax,
 *   }>                                        NI, student loan and savings all scale pro-rata;
 *                                             a year below the NI Lower Earnings Limit stops
 *                                             counting toward the state pension. The most recent
 *                                             change at or before an age applies (100% before
 *                                             the first). enabled: false skips it (default true).
 *
 *   Couple mode — set `partner` to model a household of two. Each person has
 *   their own pay, tax, NI, student loan, pots, state and DB pensions and
 *   retirement age; spending, the mortgage, debts and life events are shared,
 *   and event/mortgage ages are on the main person's age. The plan runs until
 *   the younger partner reaches maxAge.
 *   partner?: object | null              - The partner's own fields, as above (currentAge,
 *                                             retirementAge, grossIncome, pension rates, NI
 *                                             record, state pension choices, dbPensions,
 *                                             studentLoanPlan, employmentChanges), plus `pots`:
 *                                             { pensionBalance, isaBalance, giaBalance,
 *                                             giaCostBasis, studentLoan }.
 *   partnership?:           string,         - 'married' (also civil partners; default) or
 *                                             'cohabiting'. Sets the inheritance tax and ISA
 *                                             rules on a death, and Marriage Allowance.
 *   willsToEachOther?:      boolean,        - Cohabiting only: whether wills leave savings to
 *                                             each other (default true). Without, the survivor
 *                                             inherits only pensions.
 *   takePCLS?:              boolean,        - This person's own choice of a tax-free lump sum
 *                                             at retirement (the partner's goes on `partner`);
 *                                             without it, retirementOptions.takePCLS applies.
 *   survivorSpendingShare?: number,         - Household spending after a death, as a share of
 *                                             the couple's (default 0.72, Retirement Living
 *                                             Standards 2026).
 *   spendingShiftAtFirstRetirement?: number, - While one partner has retired and the other
 *                                             works: how far household spending moves from
 *                                             annualLivingExpenses toward the retirement
 *                                             target, 0–1. 0 (the default) keeps living costs
 *                                             until both have retired; 0.5 is halfway; 1
 *                                             switches to the target at the first retirement.
 *   death?: {                               - "What if one of us dies?": the person ('self' or
 *     person: string,                         'partner') dies at the start of the year they
 *     age:    number                          would reach `age`; see ukEstate.js.
 *   } | null
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
 *     balance:              number,  - Outstanding mortgage balance (today's money —
 *                                      inflated to the start year for future purchases)
 *     termYears:            number,  - Remaining mortgage term in whole years
 *     type?:                string,  - 'repayment' (default) or 'interest-only'
 *     monthlyOverpayment?:  number,
 *     startAge?:            number   - Age the mortgage begins (default currentAge; a
 *                                      future age models a planned property purchase —
 *                                      no payments and no balance before it starts)
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
 *   glideStartYears?:        number,  - Years before retirement to begin de-risking (default 10)
 *   glideEndYears?:          number,  - Years after retirement to finish de-risking (default 5)
 *   flexibleRetirement?:     boolean, - If true, keep working past retirementAge while the plan
 *                                       is not on track, up to maxRetirementDelayYears (default
 *                                       false). The on-track test uses central assumptions only
 *                                       and never peeks at future realised returns, so under
 *                                       Monte Carlo a trial delays only in response to what has
 *                                       already happened. Meaningful mainly for stochastic runs.
 *   maxRetirementDelayYears?: number, - Max whole years retirement can be postponed when
 *                                       flexibleRetirement is on (default 0).
 *   spendingGuardrails?: {            - If present, flex retirement spending each year toward the
 *     floor:        number,             central-assumptions sustainable level (no peeking), bounded
 *     ceilingPct?:  number,            below by floor (£/yr, today's money — essential spend) and
 *     band?:        number,            above by ceilingPct (% of target, ≥100; 100 = recovery-only).
 *     step?:        number,            band = fractional drift from sustainable before acting
 *   } | null,                          (default 0.2); step = fractional cut/raise per year (default
 *                                      0.1). Like flexibleRetirement, only meaningful under Monte
 *                                      Carlo — it is a behavioural decision rule, simulated in full.
 *   annuity?: {                       - Buy a single-life lifetime annuity once, at the first
 *     owner?:           string,         ('self' default, or 'partner' in couple mode: whose pension
 *                                       buys it)
 *     purchaseAge:      number,         retirement year ≥ purchaseAge (and the pension access age).
 *     sizing:           string,         'essential': enough gross income that state pension +
 *     amountReal:       number,         annuity, net of tax, cover amountReal of essential net
 *     inflationLinked?: boolean,        spending (today's £); 'fixed': amountReal of gross annuity
 *     rate?:            number | null   income (today's £). Capped at the pension available (a
 *   } | null,                           partial purchase). inflationLinked (default true) indexes
 *                                       income to inflation; otherwise level. rate = first-year
 *                                       income per £ of price; null → illustrative table
 *                                       (ukAnnuity.js) at the actual purchase age. On the UFPLS
 *                                       path 25% of the slice is taken tax-free (within the LSA).
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
  // ── Household inputs ────────────────────────────────────────────────────
  const {
    currentYear = 2025,
    annualLivingExpenses = 0, // non-debt living costs in today's £; inflated each year
    windfalls = [],
    oneOffExpenses = [],
    // Couple mode: the partner's own inputs and pots, and the household rules.
    partner: partnerProfile = null,
    partnership = 'married',
    willsToEachOther = true,
    survivorSpendingShare = COUPLE_DEFAULTS.survivorSpendingShare,
    spendingShiftAtFirstRetirement = 0,
    death = null,
    // Couple mode: life insurance policies (see policyInForce).
    lifePolicies = [],
  } = profile;

  if (!Number.isInteger(currentYear) || currentYear < 1990)
    throw new RangeError('currentYear must be an integer >= 1990');

  // ── The people ──────────────────────────────────────────────────────────
  // Their pay, pots, pension rights and retirement choices (ukLifecyclePerson.js).
  // An annuity is bought from one person's pension (`annuity.owner`, default
  // the main person), so only the owner sees it.
  const annuityOwner = retirementOptions?.annuity?.owner ?? 'self';
  if (annuityOwner !== 'self' && annuityOwner !== 'partner')
    throw new RangeError("retirementOptions.annuity.owner must be 'self' or 'partner'");
  if (annuityOwner === 'partner' && partnerProfile == null)
    throw new RangeError('retirementOptions.annuity.owner is the partner, but there is no partner');
  const optionsWithoutAnnuity =
    retirementOptions == null ? null : { ...retirementOptions, annuity: null };
  // Each person can choose their own tax-free lump sum (`takePCLS` on their
  // profile); otherwise they follow retirementOptions.takePCLS.
  const ownLumpSum = (person, options) => {
    if (person.takePCLS === undefined) return options;
    if (typeof person.takePCLS !== 'boolean') throw new TypeError('takePCLS must be a boolean');
    return options == null ? options : { ...options, takePCLS: person.takePCLS };
  };

  const self = createPerson(
    profile,
    pots,
    ownLumpSum(profile, annuityOwner === 'self' ? retirementOptions : optionsWithoutAnnuity),
    currentYear
  );
  self.id = 'self';
  self.plannedTakePCLS = profile.takePCLS ?? retirementOptions?.takePCLS ?? false;
  const { currentAge, retirementAge } = self;

  let partner = null;
  if (partnerProfile != null) {
    if (typeof partnerProfile !== 'object' || Array.isArray(partnerProfile))
      throw new TypeError('partner must be an object');
    partner = createPerson(
      partnerProfile,
      partnerProfile.pots ?? {},
      ownLumpSum(
        partnerProfile,
        annuityOwner === 'partner' ? retirementOptions : optionsWithoutAnnuity
      ),
      currentYear
    );
    partner.id = 'partner';
    partner.plannedTakePCLS = partnerProfile.takePCLS ?? retirementOptions?.takePCLS ?? false;
    if (!PARTNERSHIPS.includes(partnership))
      throw new RangeError(`partnership must be one of ${PARTNERSHIPS.join(', ')}`);
    if (typeof willsToEachOther !== 'boolean')
      throw new TypeError('willsToEachOther must be a boolean');
    if (
      typeof survivorSpendingShare !== 'number' ||
      !(survivorSpendingShare > 0 && survivorSpendingShare <= 1)
    )
      throw new RangeError('survivorSpendingShare must be in (0, 1]');
    if (
      typeof spendingShiftAtFirstRetirement !== 'number' ||
      !(spendingShiftAtFirstRetirement >= 0 && spendingShiftAtFirstRetirement <= 1)
    )
      throw new RangeError('spendingShiftAtFirstRetirement must be in [0, 1]');
  }
  const couple = partner !== null;
  const people = couple ? [self, partner] : [self];
  const alivePeople = () => people.filter((P) => P.diedAt === null);
  // The timeline is the main person's age. A couple's plan runs until the
  // younger partner reaches "model to age", which is this many years later
  // on the timeline when the partner is the younger one.
  const ageGap = couple ? Math.max(0, currentAge - partner.currentAge) : 0;

  // "What if one of us dies?": one death, at the start of the year the person
  // would reach `death.age`. From then the survivor carries on alone.
  let deathPlan = null;
  if (death != null) {
    if (!couple)
      throw new RangeError('death needs a partner: in a single-person plan there is no survivor');
    const D = death.person === 'self' ? self : death.person === 'partner' ? partner : null;
    if (D === null) throw new RangeError("death.person must be 'self' or 'partner'");
    if (!Number.isInteger(death.age) || death.age < D.currentAge)
      throw new RangeError('death.age must be an integer no younger than that person is now');
    const { extraCover = 0 } = death;
    assertNonNegativeFinite(extraCover, 'death.extraCover');
    deathPlan = {
      D,
      S: D === self ? partner : self,
      yearIndex: death.age - D.currentAge,
      extraCover,
    };
  }
  const estates = [];

  // ── Life insurance (couple mode) ──────────────────────────────────────────
  // Each policy pays its sum assured if the person it covers dies while it is
  // in force: 'level' term pays the same throughout, 'decreasing' term falls
  // in a straight line to nothing at the end of the term (a conservative
  // stand-in for the repayment-mortgage curve real policies follow), and
  // 'wholeOfLife' has no end. A 'joint' policy pays on the first death. The
  // sum assured and premium are fixed in cash, as on a quote. Premiums are a
  // household cost while the policy runs. On a payout the money goes to the
  // mortgage or the survivor's savings (`payTo`), straight to the survivor if
  // written in trust, otherwise through the estate (ukEstate.js).
  const LIFE_POLICY_TYPES = ['level', 'decreasing', 'wholeOfLife'];
  if (!Array.isArray(lifePolicies)) throw new TypeError('lifePolicies must be an array');
  if (lifePolicies.length > 0 && !couple)
    throw new RangeError('lifePolicies need a partner: only couple mode models a payout');
  const policies = lifePolicies
    .map((pol, idx) => {
      const name = `lifePolicies[${idx}]`;
      if (pol == null || typeof pol !== 'object') throw new TypeError(`${name} must be an object`);
      const {
        label = '',
        enabled = true,
        type,
        lifeOf,
        sumAssured,
        termYears = null,
        monthlyPremium = 0,
        inTrust = true,
        payTo = 'savings',
      } = pol;
      if (!LIFE_POLICY_TYPES.includes(type))
        throw new RangeError(`${name}.type must be one of ${LIFE_POLICY_TYPES.join(', ')}`);
      if (!['self', 'partner', 'joint'].includes(lifeOf))
        throw new RangeError(`${name}.lifeOf must be 'self', 'partner' or 'joint'`);
      assertNonNegativeFinite(sumAssured, `${name}.sumAssured`);
      assertNonNegativeFinite(monthlyPremium, `${name}.monthlyPremium`);
      if (type !== 'wholeOfLife') assertPositiveInteger(termYears, `${name}.termYears`);
      if (typeof inTrust !== 'boolean') throw new TypeError(`${name}.inTrust must be a boolean`);
      if (payTo !== 'savings' && payTo !== 'mortgage')
        throw new RangeError(`${name}.payTo must be 'savings' or 'mortgage'`);
      return {
        label,
        enabled,
        type,
        lifeOf,
        sumAssured,
        termYears,
        monthlyPremium,
        inTrust,
        payTo,
      };
    })
    .filter((pol) => pol.enabled !== false);

  /** Whether a policy is still running in projection year i. */
  function policyInForce(pol, i) {
    if (pol.paidOut) return false;
    if (pol.type !== 'wholeOfLife' && i >= pol.termYears) return false;
    if (pol.lifeOf === 'joint') return estates.length === 0; // ends at the first death
    return (pol.lifeOf === 'self' ? self : partner).diedAt === null;
  }

  /** This year's life cover premiums (a household cost). */
  function lifeCoverPremiums(i) {
    let total = 0;
    for (const pol of policies) if (policyInForce(pol, i)) total += pol.monthlyPremium * 12;
    return round2(total);
  }

  /** Lump sums paid on D's death in year i: life cover, death-in-service, and
   *  any extra cover being tested (cover-gap search, today's money). */
  function coverOnDeath(D, i) {
    const cover = [];
    for (const pol of policies) {
      if (pol.lifeOf !== D.id && pol.lifeOf !== 'joint') continue;
      if (!policyInForce(pol, i)) continue;
      const amount =
        pol.type === 'decreasing'
          ? round2(pol.sumAssured * Math.max(0, 1 - i / pol.termYears))
          : pol.sumAssured;
      pol.paidOut = true;
      if (amount > 0)
        cover.push({
          kind: 'lifeCover',
          label: pol.label,
          amount,
          inTrust: pol.inTrust,
          payTo: pol.payTo,
        });
    }
    // Death-in-service: paid by the pension scheme, outside the estate, if the
    // person dies while still working.
    if (D.retiredAt === null && D.deathInServiceMultiple > 0) {
      const salary = D.income * D.hoursFractionAtAge(D.currentAge + i);
      cover.push({
        kind: 'deathInService',
        label: 'Death-in-service',
        amount: round2(D.deathInServiceMultiple * salary),
        inTrust: true,
        payTo: 'savings',
      });
    }
    if (deathPlan?.extraCover > 0)
      cover.push({
        kind: 'extra',
        label: 'Extra cover',
        amount: round2(deathPlan.extraCover * econ.cumulInflation),
        inTrust: true,
        payTo: 'savings',
      });
    return cover;
  }
  // Household spending falls to the survivor's share after a death.
  const spendingShare = () => (estates.length > 0 ? survivorSpendingShare : 1);

  // Windfalls and one-off expenses: discrete life events at a given age.
  // Windfalls (inheritance, asset sale, gift) add money to the GIA; one-off
  // expenses (house deposit, wedding, helping children) are funded from the
  // pots. Amounts are net of fees/taxes, expressed in today's money, and
  // inflated to the event year. Events at ages outside the projected range
  // are simply never reached (harmless). An event with enabled === false is
  // skipped entirely — it can be toggled off for what-if comparisons without
  // being deleted. Ages are on the timeline (the main person's age).
  function validateEvents(list, name, defaultLabel) {
    if (!Array.isArray(list)) throw new TypeError(`${name} must be an array`);
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      if (ev == null || typeof ev !== 'object')
        throw new TypeError(`${name}[${i}] must be an object`);
      if (!Number.isInteger(ev.age)) throw new TypeError(`${name}[${i}].age must be an integer`);
      assertNonNegativeFinite(ev.amount, `${name}[${i}].amount`);
    }
    /** Events landing at a given age: nominal total (today's £ × cumulative
     *  inflation) plus labels for reporting. Returns null when none. */
    return function eventsAtAge(age, inflationFactor) {
      let total = 0;
      const labels = [];
      for (const ev of list) {
        if (ev.enabled === false) continue;
        if (ev.age === age && ev.amount > 0) {
          total += ev.amount;
          labels.push(ev.label || defaultLabel);
        }
      }
      if (total === 0) return null;
      return { nominal: round2(total * inflationFactor), labels };
    };
  }
  const windfallsAtAge = validateEvents(windfalls, 'windfalls', 'Windfall');
  const expensesAtAge = validateEvents(oneOffExpenses, 'oneOffExpenses', 'One-off expense');

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

  // ── Household debts: mortgage and unsecured ──────────────────────────────
  const { mortgage: mortgageConfig = null, unsecuredDebts: unsecuredConfig = [] } = pots;

  let mortgageBalance = 0;
  let mortgageMonthlyPayment = 0;
  let mortgageMonthlyOverpayment = 0;
  let mortgageMonthlyRate = 0;
  let mortgageType = 'repayment';
  let hasMortgage = false;

  let mortgageStartAge = currentAge;
  let mortgageStarted = false;

  if (mortgageConfig != null) {
    assertNonNegativeFinite(mortgageConfig.balance, 'mortgage.balance');
    assertPositiveInteger(mortgageConfig.termYears, 'mortgage.termYears');
    if (mortgageConfig.monthlyOverpayment != null)
      assertNonNegativeFinite(mortgageConfig.monthlyOverpayment, 'mortgage.monthlyOverpayment');
    if (mortgageConfig.startAge != null && !Number.isInteger(mortgageConfig.startAge))
      throw new TypeError('mortgage.startAge must be an integer');

    mortgageType = mortgageConfig.type ?? 'repayment';
    if (mortgageType !== 'repayment' && mortgageType !== 'interest-only')
      throw new TypeError("mortgage.type must be 'repayment' or 'interest-only'");

    mortgageMonthlyRate = mortgageRate / 12;
    mortgageMonthlyOverpayment = mortgageConfig.monthlyOverpayment ?? 0;
    // A start age in the past means the mortgage already exists — start now.
    mortgageStartAge = Math.max(currentAge, mortgageConfig.startAge ?? currentAge);
    hasMortgage = mortgageConfig.balance > 0;
  }

  /** Lazily start the mortgage in the year the start age is reached. For a
   *  future purchase the balance is stated in today's money and inflated to
   *  the start year (house prices and loan sizes move with the economy); the
   *  monthly payment is then fixed from that starting balance. For a mortgage
   *  starting now (the default) the inflation factor is 1 — unchanged. */
  function maybeStartMortgage(age, inflationFactor) {
    if (!hasMortgage || mortgageStarted || age < mortgageStartAge) return;
    mortgageStarted = true;
    mortgageBalance = round2(mortgageConfig.balance * inflationFactor);
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
  }

  /**
   * One year of mortgage payments, returning the payment and a row. A working
   * year reports a zero row for a mortgage that hasn't started or is repaid
   * (`reportRepaid`); a retirement year reports none.
   */
  function mortgageYear(reportRepaid) {
    if (!hasMortgage) return { payment: 0, row: null };
    const openingMortgage = mortgageBalance;
    if (mortgageBalance <= 0) {
      return {
        payment: 0,
        row: reportRepaid
          ? {
              openingBalance: 0,
              interestCharged: 0,
              capitalRepaid: 0,
              payment: 0,
              closingBalance: 0,
              type: mortgageType,
            }
          : null,
      };
    }
    if (mortgageType === 'interest-only') {
      let yearInt = 0;
      for (let m = 0; m < 12; m++) yearInt += round2(mortgageBalance * mortgageMonthlyRate);
      yearInt = round2(yearInt);
      return {
        payment: yearInt,
        row: {
          openingBalance: openingMortgage,
          interestCharged: yearInt,
          capitalRepaid: 0,
          payment: yearInt,
          closingBalance: mortgageBalance,
          type: 'interest-only',
        },
      };
    }
    const amort = amortiseYear(
      mortgageBalance,
      mortgageMonthlyRate,
      mortgageMonthlyPayment,
      mortgageMonthlyOverpayment
    );
    mortgageBalance = amort.closingBalance;
    return {
      payment: amort.payment,
      row: {
        openingBalance: openingMortgage,
        interestCharged: amort.interestCharged,
        capitalRepaid: amort.capitalRepaid,
        payment: amort.payment,
        closingBalance: mortgageBalance,
        type: 'repayment',
      },
    };
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

  const unsecuredOutstanding = () => debts.reduce((s, d) => s + d.balance, 0);

  /** One year of payments on every unsecured debt, returning the total and rows. */
  function unsecuredDebtsYear() {
    let payments = 0;
    const rows = debts.map((debt) => {
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
      payments = round2(payments + amort.payment);
      return {
        label: debt.label,
        openingBalance: openingDebt,
        interestCharged: amort.interestCharged,
        capitalRepaid: amort.capitalRepaid,
        payment: amort.payment,
        closingBalance: amort.closingBalance,
      };
    });
    return { payments, rows };
  }

  // ── Glide path configuration ──────────────────────────────────────────────
  // Shared by the working and retirement years.
  const { glideStartYears: _glideStart = 10, glideEndYears: _glideEnd = 5 } =
    retirementOptions ?? {};
  const glideBeforeYrs = Math.max(0, _glideStart);
  const glideAfterYrs = Math.max(0, _glideEnd);

  // ── Flexible (dynamic) retirement date ────────────────────────────────────
  // Optionally keep working past the target retirement age when the plan is not
  // yet on track, up to `maxRetirementDelayYears`. The on-track test is a
  // lightweight central-assumptions solvency check run from the candidate age:
  // it never looks at future realised returns, so under Monte Carlo a trial only
  // reacts to what has actually happened by that age (no peeking). It is purely a
  // decision rule — the resulting plan is still simulated in full afterwards.
  // In a couple each partner reaches their own target age and asks whether the
  // household is on track (conservatively, as if no one earns any more).
  const { flexibleRetirement = false, maxRetirementDelayYears = 0 } = retirementOptions ?? {};
  if (typeof flexibleRetirement !== 'boolean')
    throw new TypeError('retirementOptions.flexibleRetirement must be a boolean');
  if (!Number.isInteger(maxRetirementDelayYears) || maxRetirementDelayYears < 0)
    throw new RangeError(
      'retirementOptions.maxRetirementDelayYears must be a non-negative integer'
    );

  // Central real (post-inflation) return used by the on-track drawdown check.
  const centralRealReturn = (1 + retirementRate) / (1 + inflationRate) - 1;
  // Approximate tax drag on pension withdrawals inside the check: ~25% is
  // tax-free (PCLS/UFPLS), the taxable remainder roughly at the basic rate, so
  // net draws from the pension bucket are grossed up by this factor (~1.18).
  const TEST_PENSION_GROSSUP = 1 / (1 - 0.75 * 0.2);
  // Annuity income sits on top of the state pension, which largely fills the
  // personal allowance, so the check counts it net of basic-rate tax.
  const ANNUITY_NET_FACTOR = 0.8;

  /**
   * Real-terms rundown from projection year `i`: can the household's pots fund
   * `spendReal` (today's money) of net spending every year to the horizon
   * under central assumptions? Accessible pots (ISA + GIA, and any inherited
   * pension) are drawn first, then each person's locked pension once past
   * their access age (grossed up for tax), with each state pension switched
   * on at its (deferred) start age and debt cleared from spendable pots up
   * front. Never peeks at realised future returns — it is a decision rule,
   * not the model. Deliberately simple and slightly conservative.
   */
  function rundownSurvives(i, spendReal, annuityGrossNominal = 0, annuityInflationLinked = true) {
    return rundownTest(i, annuityGrossNominal, annuityInflationLinked)(spendReal);
  }

  // The rundown check for year `i`, as a function of the spend: everything that
  // doesn't depend on the spend (the pots, debts and each year's guaranteed
  // income) is worked out once, so trying many spends (the guardrails'
  // bisection) is cheap. The arithmetic is the same, in the same order.
  function rundownTest(i, annuityGrossNominal = 0, annuityInflationLinked = true) {
    const alive = alivePeople();
    const horizonIndex = (retirementOptions.maxAge ?? 90) + ageGap - currentAge;
    const deflate = econ.cumulInflation > 0 ? 1 / econ.cumulInflation : 1;

    // Today's-money buckets: accessible (ISA + GIA) and each locked pension (NMPA).
    let accessible0 = Math.max(0, alive.reduce((s, P) => s + P.isa + P.gia, 0) * deflate);
    const locked = alive.map((P) => ({ P, amount: Math.max(0, P.pension * deflate) }));
    for (const P of alive) {
      if (!P.inherited) continue;
      // An inherited pension can be drawn at any age: tax-free, or taxed like a pension.
      accessible0 += Math.max(0, P.inherited.taxFree * deflate);
      locked.push({ P, amount: Math.max(0, P.inherited.taxable * deflate), anyAge: true });
    }
    // Clear outstanding debt from spendable pots first (conservative).
    let debt = Math.max(0, (mortgageBalance + unsecuredOutstanding()) * deflate);
    const payFromAccessible = Math.min(accessible0, debt);
    accessible0 -= payFromAccessible;
    debt -= payFromAccessible;
    for (const b of locked) {
      const before = b.amount;
      b.amount = Math.max(0, b.amount - debt);
      debt = Math.max(0, debt - before);
    }

    // Today's money (triple lock ≈ real-constant), including any deferral increase.
    const stateReal = alive.map(
      (P) => computeStatePension(P.niYears) * P.statePensionDeferralUplift
    );
    // An annuity already in payment is guaranteed income, like the state pension.
    // Inflation-linked holds its real value; level erodes at the central inflation
    // rate. Counted net of basic-rate tax (it stacks on the state pension, which
    // largely fills the personal allowance). A planned-but-unbought annuity is
    // ignored: converting pot to income at a fair rate is roughly neutral here.
    const annuityReal0 = Math.max(0, annuityGrossNominal * deflate);

    // Each year's guaranteed income: the state pension, and the annuity and
    // any DB pensions (taxed like the annuity); and the first year each locked
    // pot can be drawn.
    const years = Math.max(0, horizonIndex - i + 1);
    const spByYear = new Float64Array(years);
    const otherByYear = new Float64Array(years);
    const anyDb = alive.some((P) => P.dbStates.length > 0);
    for (let j = 0; j < years; j++) {
      const k = i + j;
      const annuityReal = annuityInflationLinked
        ? annuityReal0
        : annuityReal0 / Math.pow(1 + inflationRate, k - i);
      let spReal = 0;
      let dbReal = 0;
      for (let n = 0; n < alive.length; n++) {
        const P = alive[n];
        spReal = spReal + (P.currentAge + k >= P.spClaimAge ? stateReal[n] : 0);
        if (anyDb)
          dbReal =
            dbReal + dbRealIncomeAt(P, P.currentAge + k, P.currentAge + i, deflate, inflationRate);
      }
      spByYear[j] = spReal;
      otherByYear[j] = ANNUITY_NET_FACTOR * (annuityReal + dbReal);
    }
    const drawableFrom = locked.map((b) =>
      b.anyAge ? 0 : b.P.pensionAccessAge - b.P.currentAge - i
    );
    const lockedStart = locked.map((b) => b.amount);
    const amounts = new Float64Array(locked.length);

    return (spendReal) => {
      let accessible = accessible0;
      amounts.set(lockedStart);
      for (let j = 0; j < years; j++) {
        let need = Math.max(0, spendReal - spByYear[j] - otherByYear[j]);
        if (need > 0) {
          const fromAccessible = Math.min(accessible, need);
          accessible -= fromAccessible;
          need -= fromAccessible;
        }
        for (let n = 0; n < amounts.length; n++) {
          if (need > 0 && j >= drawableFrom[n] && amounts[n] > 0) {
            const grossDrawn = Math.min(amounts[n], need * TEST_PENSION_GROSSUP);
            amounts[n] -= grossDrawn;
            need -= grossDrawn / TEST_PENSION_GROSSUP;
          }
        }
        if (need > 0.5) return false; // can't meet this year's spending under central assumptions
        accessible *= 1 + centralRealReturn;
        for (let n = 0; n < amounts.length; n++) amounts[n] *= 1 + centralRealReturn;
      }
      return true;
    };
  }

  // Flexible-retirement on-track test: can the target spend be funded for life?
  function onTrackToRetire(i) {
    if (retirementOptions == null) return true;
    const targetReal = retirementOptions.targetNetAnnualExpenses ?? 0;
    if (targetReal <= 0) return true;
    return rundownSurvives(i, targetReal * spendingShare());
  }

  // The largest real (today's-money) net spend the pots can sustain from year
  // `i` to the horizon under central assumptions is what the spending
  // guardrails steer toward. It's found by bisection on the rundown check,
  // which is monotonic in spend (more spending is never easier to sustain).
  //
  // A spend that always fails the rundown: drawing the whole (real) pot plus
  // all guaranteed income in a single year cannot be sustained beyond it.
  function sustainableUpperBound(i, annuityGrossNominal = 0) {
    const alive = alivePeople();
    const deflate = econ.cumulInflation > 0 ? 1 / econ.cumulInflation : 1;
    const totalReal = Math.max(
      0,
      alive.reduce((s, P) => s + P.pension + P.isa + P.gia + inheritedPensionBalance(P), 0) *
        deflate
    );
    return (
      totalReal +
      alive.reduce((s, P) => s + computeStatePension(P.niYears) * P.statePensionDeferralUplift, 0) +
      Math.max(0, annuityGrossNominal * deflate) +
      alive.reduce((s, P) => s + P.dbStates.reduce((t, st) => t + st.pension * deflate * 2, 0), 0) +
      1
    );
  }

  // 30 halvings of [0, hi]: the largest spend found to survive, within
  // hi / 2^30 of the true limit (and never above it).
  function bisectSustainable(survives, hi) {
    let lo = 0;
    for (let iter = 0; iter < 30; iter++) {
      const mid = (lo + hi) / 2;
      if (survives(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // ── Spending guardrails (Monte Carlo behavioural model) ────────────────────
  // Optionally flex retirement spending each year toward what the current pot can
  // sustainably support (central assumptions, no peeking): trim when the plan has
  // fallen behind, restore — and, if the ceiling allows, raise — when ahead,
  // bounded by a hard £ floor (essential spend) and a ceiling (% of target). Like
  // flexible retirement this only bites under Monte Carlo, and it is a decision
  // rule; the resulting spend path is simulated in full. A 100% ceiling is
  // "recovery only" (raises can restore prior cuts but never exceed the target).
  let guardrails = null;
  {
    const gr = retirementOptions?.spendingGuardrails ?? null;
    if (gr != null) {
      const { floor, ceilingPct = 100, band = 0.2, step = 0.1 } = gr;
      assertNonNegativeFinite(floor, 'retirementOptions.spendingGuardrails.floor');
      if (!Number.isFinite(band) || band <= 0)
        throw new RangeError('retirementOptions.spendingGuardrails.band must be a positive number');
      if (!Number.isFinite(step) || step <= 0 || step >= 1)
        throw new RangeError('retirementOptions.spendingGuardrails.step must be in (0, 1)');
      if (!Number.isFinite(ceilingPct) || ceilingPct < 100)
        throw new RangeError('retirementOptions.spendingGuardrails.ceilingPct must be >= 100');
      guardrails = { floor, ceilingPct, band, step };
    }
  }

  // ── Retirement settings ───────────────────────────────────────────────────
  // The spending target, horizon, lump sum choice and guardrail state (real,
  // today's money). The guardrail floor is clamped to the target (a floor
  // above target would be nonsensical); the current allowed spend starts at the
  // target and flexes within [floor, ceiling] as the guardrails react.
  let retirement = null;
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
    retirement = {
      targetNetAnnualExpenses,
      maxAge,
      takePCLS,
      pclsPercentage,
      grFloor: guardrails ? Math.min(guardrails.floor, targetNetAnnualExpenses) : 0,
      grCeiling: guardrails ? (guardrails.ceilingPct / 100) * targetNetAnnualExpenses : Infinity,
      grSpendReal: targetNetAnnualExpenses,
    };
  }

  /**
   * Flex the guardrail budget toward what the pots can sustain this year
   * (scaled to the household's spending share), returning the action taken.
   */
  function applyGuardrails(i, annuityGross, annuityInflationLinked) {
    const share = spendingShare();
    const { band, step } = guardrails;
    const spend = retirement.grSpendReal * share;
    // The rule compares this spend with the sustainable spend found by
    // bisection (bisectSustainable): cut if it's more than `band` above,
    // raise if more than `band` below. The bisection settles within
    // hi / 2^30 of the true limit and never above it, so wherever the
    // threshold is clearly on one side of the limit, one or two rundown checks
    // give the same answer as the 30 the bisection takes; only right at the
    // edge does it run the bisection itself.
    const survives = rundownTest(i, annuityGross, annuityInflationLinked);
    const hi = sustainableUpperBound(i, annuityGross);
    const margin = (2 * hi) / 2 ** 30 + 1e-9 * (spend + 1);
    let sustainable = null;
    const exact = () => (sustainable ??= bisectSustainable(survives, hi));
    // Is the limit above `threshold`? true / false, or null if too close to call.
    const above = (threshold) => {
      if (survives(threshold + margin)) return true;
      if (!survives(threshold - margin)) return false;
      return null;
    };

    let cut = band > 0 ? above(spend / (1 + band)) === false : null;
    if (band <= 0 || cut === null) cut = spend > exact() * (1 + band);
    let raise = false;
    if (!cut) {
      raise = band > 0 && band < 1 ? above(spend / (1 - band)) : null;
      if (raise === null) raise = spend < exact() * (1 - band);
    }

    let action = 'none';
    if (cut) {
      retirement.grSpendReal = retirement.grSpendReal * (1 - step);
      action = 'cut';
    } else if (raise) {
      retirement.grSpendReal = retirement.grSpendReal * (1 + step);
      action = 'raise';
    }
    retirement.grSpendReal = Math.min(
      retirement.grCeiling,
      Math.max(retirement.grFloor, retirement.grSpendReal)
    );
    return action;
  }

  // ── The economy ───────────────────────────────────────────────────────────
  // Running factors since the start year, shared by everyone in the household.
  // Year-by-year rate variation (Monte Carlo) compounds here; without it they
  // reproduce Math.pow() of the base rates.
  const econ = {
    cumulInflation: 1, // product of (1 + inflRate) from year 1..i
    thresholdScale: 1, // product of (1 + inflRate - fiscalDragRate) from year 1..i
    cumulTriplelock: 1, // product of (1 + max(wages,CPI,2.5%)) from year 1..i
  };

  /** This year's rates: the base rates, merged with any override for year i. */
  function ratesForYear(i) {
    return yearlyRatesOverride?.[i] != null
      ? {
          savingsRate,
          retirementRate,
          wageGrowthRate,
          inflationRate,
          boeRate,
          ...yearlyRatesOverride[i],
        }
      : { savingsRate, retirementRate, wageGrowthRate, inflationRate, boeRate };
  }

  const yearlyBreakdown = [];

  /** In couple mode, add the partner's age and a per-person breakdown to a
   *  row produced for a one-person year (after a death). */
  function decorateSurvivorRow(row, i, P, status) {
    if (!couple) return row;
    row.partnerAge = partner.currentAge + i;
    row.people = people.map((Q) =>
      Q === P
        ? personRowFromSingle(Q, row, status, Q.currentAge + i)
        : { id: Q.id, age: Q.currentAge + i, status: 'died' }
    );
    return row;
  }

  // ── A working year (one person) ───────────────────────────────────────────
  // Pay and deductions, debt payments and living costs; what is left is saved
  // (ISA first, then GIA) after funding any one-off expense, then bed and ISA
  // and growth. `age` is the timeline age; the person's own age may differ
  // (a surviving partner).
  function workingYear(P, i, year, age, yr) {
    const personAge = P.currentAge + i;
    const pay = workingYearPay(P, personAge, year, i, yr, econ);
    const { db } = pay;
    const share = spendingShare();

    // ── Debt payments ───────────────────────────────────────────────────
    // Mortgage — may begin part-way through the projection (future purchase)
    maybeStartMortgage(age, econ.cumulInflation);
    const { payment: mortgagePaymentThisYear, row: mortgageRow } = mortgageYear(true);
    const { payments: unsecuredPaymentsThisYear, rows: debtRows } = unsecuredDebtsYear();

    // ── Savings allocation (ISA first, then GIA) ────────────────────────
    const totalDebtPayments = round2(mortgagePaymentThisYear + unsecuredPaymentsThisYear);
    // Living expenses scale with inflation from their today's-money baseline.
    const livingExpenses = round2(annualLivingExpenses * share * econ.cumulInflation);
    // Savings = what's left of take-home after debts and living costs.
    // Floored at 0 — overspend is not modelled; the user should adjust inputs.
    // Life cover premiums (couple mode) are a household cost too.
    const premiums = lifeCoverPremiums(i);
    const availableForSavings = round2(
      Math.max(0, pay.netTakeHome - totalDebtPayments - livingExpenses - premiums)
    );

    // Start-of-year pot snapshots, before any event or transfer this year.
    const openingISA = P.isa;
    const openingGIA = P.gia;

    // ── Windfalls ───────────────────────────────────────────────────────
    // Land in the GIA before anything else this year — so a same-year
    // one-off expense (e.g. sell business → buy house) can spend them.
    // The full amount is added to the cost basis: net-of-tax money carries
    // no embedded gain. The bed-and-ISA sweep migrates it into ISA headroom.
    const accWindfall = windfallsAtAge(age, econ.cumulInflation);
    const accWindfallAmt = accWindfall?.nominal ?? 0;
    if (accWindfallAmt > 0) investInGIA(P, accWindfallAmt);
    // Tax-free cash from a DB scheme taken while still working is invested the
    // same way: into the GIA at cost, moved into the ISA over time by bed and ISA.
    if (db.lumpTaxFree > 0) investInGIA(P, db.lumpTaxFree);

    // ── One-off expenses ────────────────────────────────────────────────
    // Funded from this year's savings, then GIA, then ISA — never the pension.
    // Anything unfunded is reported as expenseShortfall, not borrowed.
    const accExpense = expensesAtAge(age, econ.cumulInflation);
    const accExpenseAmt = accExpense?.nominal ?? 0;
    const funding = fundExpenseWhileWorking(
      P,
      accExpenseAmt,
      availableForSavings,
      pay.adjustedGross,
      econ.thresholdScale
    );

    const isaContrib = round2(Math.min(Math.max(0, funding.cashLeft), ISA_LIMIT));
    const giaContrib = round2(Math.max(0, funding.cashLeft - isaContrib));

    // ── Bed and ISA (accumulation) ──────────────────────────────────────
    // Any remaining annual ISA headroom after new contributions moves GIA into
    // the ISA, using only the exempt amount not already consumed by expenses.
    const bed = bedAndIsa(
      P,
      round2(ISA_LIMIT - isaContrib),
      pay.adjustedGross,
      funding.exemptRemaining,
      econ.thresholdScale
    );

    // ── Pot growth ──────────────────────────────────────────────────────
    const yearRate = getRateForAge(
      personAge,
      P.retirementAge,
      yr.savingsRate,
      yr.retirementRate,
      glideBeforeYrs,
      glideAfterYrs
    );
    const openingPension = P.pension;
    const openingInherited = inheritedPensionBalance(P);
    const growth = growPotsWhileWorking(P, yearRate, {
      employee: pay.employeeContrib,
      employer: pay.employerContrib,
      isa: isaContrib,
      gia: giaContrib,
    });
    const inheritedGrowth = growInheritedPension(P, yearRate);

    // ── The rest of the CGT allowance ───────────────────────────────────
    // Gains up to the exempt amount not used by this year's sales are
    // realised and reinvested at the year end, so they're never taxed.
    const gainsHarvested = harvestGainsWithinExemption(
      P,
      round2(Math.max(0, funding.exemptRemaining - bed.gain))
    );

    // ── NI qualifying year ──────────────────────────────────────────────
    // Uses the scaled LEL from the NI result so fiscal drag affects the
    // qualifying threshold too.
    const niQualifyingYear = recordNiQualifyingYear(P, pay);

    // ── Build row ───────────────────────────────────────────────────────
    const row = {
      year,
      age,

      grossIncome: pay.effectiveIncome,
      fullTimeGrossIncome: P.income,
      hoursFraction: pay.hoursFraction,
      employeeContribution: pay.employeeContrib,
      employerContribution: pay.employerContrib,
      adjustedGrossIncome: pay.adjustedGross,
      pensionInput: pay.pensionInput,
      annualAllowance: pay.annualAllowance,
      annualAllowanceBreached: pay.annualAllowanceBreached,
      incomeTax: pay.incomeTax,
      employeeNI: pay.employeeNI,
      employerNI: pay.employerNI,
      // From April 2029: salary sacrifice above £2,000 charged NI, and the
      // employee NI that adds.
      salarySacrificeNiable: pay.sacrificeNiable,
      salarySacrificeExtraNI: pay.sacrificeExtraNI,
      studentLoanRepayment: pay.slRepayment,
      statePensionGross: pay.workingStatePension,
      dbPension: dbRowSummary(P, db),
      netTakeHome: pay.netTakeHome,

      mortgagePayment: mortgagePaymentThisYear,
      unsecuredDebtPayments: unsecuredPaymentsThisYear,
      livingExpenses,
      availableForSavings,

      isaContribution: isaContrib,
      giaContribution: giaContrib,

      windfall: accWindfallAmt,
      windfallLabels: accWindfall?.labels ?? [],

      oneOffExpense: accExpenseAmt,
      oneOffExpenseLabels: accExpense?.labels ?? [],
      oneOffExpenseFunding:
        accExpenseAmt > 0
          ? {
              fromSavings: funding.fromSavings,
              fromGIAGross: funding.fromGIAGross,
              giaCGT: funding.giaCGT,
              fromISA: funding.fromISA,
              shortfall: funding.shortfall,
            }
          : null,
      expenseShortfall: funding.shortfall,

      investmentRate: round2(yearRate * 10000) / 10000,

      pension: {
        openingBalance: openingPension,
        employeeContribution: pay.employeeContrib,
        employerContribution: pay.employerContrib,
        growthAmount: growth.pensionGrowth,
        closingBalance: P.pension,
        // Rough tax due when drawn (basic rate on the taxable part), display only.
        estimatedTaxOnWithdrawal: estimatePensionWithdrawalTax(
          P.pension,
          estimatedPensionTaxShare(P)
        ),
      },
      isa: {
        openingBalance: openingISA,
        contribution: isaContrib,
        bedIsaContrib: bed.net,
        growthAmount: growth.isaGrowth,
        closingBalance: P.isa,
      },
      gia: {
        openingBalance: openingGIA,
        contribution: giaContrib,
        windfall: accWindfallAmt,
        bedIsaGross: bed.gross,
        bedIsaCGT: bed.cgt,
        growthAmount: growth.giaGrowth,
        // Gains realised within the CGT allowance and reinvested (base cost up).
        gainsRealisedTaxFree: gainsHarvested,
        closingBalance: P.gia,
        closingCostBasis: P.costBasis,
        unrealisedGain: round2(P.gia - P.costBasis),
      },
      bedIsa: { grossSold: bed.gross, cgt: bed.cgt, netContrib: bed.net },
      mortgage: mortgageRow,
      unsecuredDebts: debtRows,
      studentLoan: pay.slRow,

      niQualifyingYear,
      cumulativeNIYears: P.niYears,
    };
    if (P.inherited)
      row.inheritedPension = inheritedPensionRow(P, openingInherited, 0, 0, inheritedGrowth);
    if (premiums > 0) row.lifeCoverPremiums = premiums;
    yearlyBreakdown.push(decorateSurvivorRow(row, i, P, 'working'));
  }

  // ── A retirement year (one person) ────────────────────────────────────────
  // Guaranteed income (state pension, DB pensions, any annuity) is netted
  // against the year's whole need — living costs, debts, one-offs and any
  // Class 3 top-up — and the rest is drawn from the pots in tax-efficiency
  // order; surplus income is saved. Then bed and ISA, and growth.
  function retiredYear(P, i, year, age, yrRet) {
    const rAge = P.currentAge + i; // the person's own age
    const isFirstYear = rAge === P.retiredAt;
    const share = spendingShare();

    const openPension = P.pension;
    const openISA = P.isa;
    const openGIA = P.gia;
    const openInherited = inheritedPensionBalance(P);

    // Defined benefit pensions: no longer building up; deferred schemes grow by
    // their increases until paid, then pay a guaranteed income.
    const db = advanceDbSchemes(P, rAge, yrRet, true, false, 0, econ);

    // Annuity income already in payment this year (set at purchase below for
    // the purchase year itself).
    let annuityGross = annuityGrossThisYear(P, econ);

    // ── Spending guardrails ──────────────────────────────────────────────
    // Flex the real spend toward what the opening pot can sustainably support
    // (central assumptions, no peeking). Trim if we've drifted above the
    // sustainable rate by more than the band; restore/raise if below it. The
    // adjustment is a bounded step so spending moves smoothly, then is clamped
    // to [floor, ceiling]. Reacts only to what has already happened.
    const guardrailAction = guardrails
      ? applyGuardrails(i, annuityGross, P.annuityCfg?.inflationLinked ?? true)
      : 'none';
    const effectiveTargetReal = guardrails
      ? retirement.grSpendReal
      : retirement.targetNetAnnualExpenses;

    // Inflation-adjusted target net expenses — inflated from today (currentAge),
    // not from retirement date, so the input figure represents today's purchasing power.
    const targetExpenses = round2(effectiveTargetReal * share * econ.cumulInflation);

    // Fiscal-drag-adjusted threshold scale for this retirement year.
    const retThresholdScale = econ.thresholdScale;

    // State pension — nominal amount at this retirement year. The base grows
    // from the 2026/27 rate by the triple lock, max(wageGrowth, CPI, 2.5%).
    // Deferral delays the start and adds ~5.78% of the pension at claim per
    // deferred year; that extra then rises with CPI only. Qualifying years
    // include any Class 3 years bought so far — all buying finishes before
    // state pension age (≤ the claim age), so by the time the pension turns on
    // this count is final.
    const effectiveNiYears = P.niYears + P.class3.yearsBought;
    const spGross = statePensionGrossAt(P, rAge, effectiveNiYears, econ);
    const spTax = round2(calculateIncomeTax(spGross, retThresholdScale).totalTax);
    const spNet = round2(spGross - spTax);

    // ── Debts (if still outstanding at retirement, or a mortgage starting now) ──
    maybeStartMortgage(age, econ.cumulInflation);
    const { payment: mortgagePaymentThisRetYear, row: retMortgageRow } = mortgageYear(false);
    const { payments: retUnsecuredPayments, rows: retDebtRows } = unsecuredDebtsYear();

    // ── Windfalls arriving this retirement year ───────────────────────────
    // Added to the GIA (full amount to cost basis — net-of-tax money has no
    // embedded gain) BEFORE the drawdown steps, so an inheritance can fund
    // the same year's spending and rescue an otherwise-exhausted plan.
    const retWindfall = windfallsAtAge(age, econ.cumulInflation);
    const retWindfallAmt = retWindfall?.nominal ?? 0;
    if (retWindfallAmt > 0) investInGIA(P, retWindfallAmt);

    // One-off expenses this retirement year simply raise the year's funding
    // need — the normal five-step drawdown below then finds the cash in the
    // most tax-efficient order, so the expense gets full tax treatment.
    const retExpense = expensesAtAge(age, econ.cumulInflation);
    const retExpenseAmt = retExpense?.nominal ?? 0;

    // ── Pension access (Normal Minimum Pension Age) ───────────────────────
    // The DC pension is untouchable before pensionAccessAge. When the person
    // retired early, PCLS was deferred — take it in the first accessible year.
    // `isaUsed` tracks the ISA subscription used by lump sums this year.
    const pensionAccessible = rAge >= P.pensionAccessAge;
    let pclsThisYear = isFirstYear && P.pcls.atEntry;
    let isaUsed = isFirstYear ? P.pcls.toISAAtEntry : 0;
    if (P.pcls.pending && pensionAccessible && P.pension > 0) {
      isaUsed = takePensionLumpSum(P);
      P.pcls.pending = false;
      pclsThisYear = true;
    }

    // ── Annuity purchase (once) ───────────────────────────────────────────
    // Placed after PCLS so the PCLS path buys from an already-crystallised pot.
    const annuityBuy = maybeBuyAnnuity(P, rAge, econ, spGross, retThresholdScale, isaUsed);
    isaUsed = annuityBuy.isaUsed;
    if (annuityBuy.income !== null) annuityGross = annuityBuy.income; // first payment this year
    const annuityPurchaseThisYear = annuityBuy.purchase;

    // ── DB tax-free cash ──────────────────────────────────────────────────
    // Like a PCLS: into the ISA up to this year's remaining headroom, the rest
    // into the GIA at cost — before the drawdown, so it can fund this year.
    if (db.lumpTaxFree > 0) isaUsed = investTaxFreeCash(P, db.lumpTaxFree, isaUsed);

    // ── Voluntary Class 3 NI purchase (this year) ─────────────────────────
    // The cost joins the funding need below at LOWEST priority, so essential
    // spending is always funded first; the year is only "bought" if the whole
    // need — including this cost — is met (see after the drawdown).
    const class3Cost = class3CostThisYear(P, rAge, econ);
    const premiums = lifeCoverPremiums(i);

    // ── Drawdown strategy ─────────────────────────────────────────────────
    // Priority: tax-free pension → CGT-exempt GIA harvest → ISA → taxable GIA → taxable pension
    // Mortgage, unsecured debt payments, and one-off expenses are added on top of
    // living expenses so the full drawdown need is accounted for. Any voluntary
    // Class 3 cost is added last (lowest priority).
    // Guaranteed income is the state pension, any DB pensions and any annuity,
    // taxed together (all pension income; DB stacks on the state pension and
    // the annuity on top of both). It is netted against the whole year's need
    // — living costs, mortgage, debts, one-offs and Class 3 — and anything left
    // over is saved (below), not lost.
    const netOf = (gross) => round2(gross - calculateIncomeTax(gross, retThresholdScale).totalTax);
    const spDbGross = round2(spGross + db.gross + db.lumpTaxable);
    const spDbNet = spDbGross > spGross ? netOf(spDbGross) : spNet;
    const guaranteedGross = round2(spDbGross + annuityGross);
    const guaranteedNet = annuityGross > 0 ? netOf(guaranteedGross) : spDbNet;
    const dbNet = round2(spDbNet - spNet);
    const annuityNet = round2(guaranteedNet - spDbNet);
    const totalNeed = round2(
      targetExpenses +
        mortgagePaymentThisRetYear +
        retUnsecuredPayments +
        retExpenseAmt +
        class3Cost +
        premiums
    );
    let remaining = round2(Math.max(0, totalNeed - guaranteedNet));
    const incomeSurplus = round2(Math.max(0, guaranteedNet - totalNeed));

    // 1. Pension within the personal allowance left after guaranteed income.
    const step1 = drawPensionWithinAllowance(
      P,
      remaining,
      pensionAccessible,
      guaranteedGross,
      retThresholdScale
    );
    remaining = step1.remaining;
    // Only the taxable portion counts as income for CGT band determination.
    let incomeForCGT = round2(guaranteedGross + round2(step1.draw - step1.taxFree));
    // 1b. A taxable inherited pension within any allowance still unused.
    const step1b = drawInheritedWithinAllowance(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step1b.remaining;
    if (step1b.draw > 0) incomeForCGT = round2(incomeForCGT + step1b.draw);

    // 2. GIA up to the annual CGT exempt amount.
    const step2 = drawGiaWithinExemption(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step2.remaining;

    // 3. A tax-free inherited pension, then the ISA.
    const step3a = drawInheritedTaxFree(P, remaining);
    remaining = step3a.remaining;
    const step3 = drawIsa(P, remaining);
    remaining = step3.remaining;

    // 4. GIA beyond the exemption, then a taxable inherited pension.
    const step4 = drawGiaTaxable(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step4.remaining;
    const step4b = drawInheritedTaxable(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step4b.remaining;
    if (step4b.draw > 0) incomeForCGT = round2(incomeForCGT + step4b.draw);

    // 5. Taxable pension.
    const step5 = drawPensionTaxable(
      P,
      remaining,
      pensionAccessible,
      incomeForCGT,
      retThresholdScale
    );
    remaining = step5.remaining;

    // ── Totals ─────────────────────────────────────────────────────────────
    const totalPensionDraw = round2(step1.draw + step5.draw);
    const totalGIADraw = round2(step2.draw + step4.draw);
    const totalGIACGT = round2(step2.cgt + step4.cgt);
    // Taxable pension income = total withdrawn minus the LSA-capped tax-free components.
    // For PCLS: both tax-free parts are 0, so the full draw is taxable income.
    // For UFPLS: may be less than 75% of draw once the LSA approaches exhaustion.
    // Any taxable inherited pension is taxable income too.
    let pensionTaxableIncome = round2(totalPensionDraw - step1.taxFree - step5.taxFree);
    const inheritedTaxableDraw = round2(step1b.draw + step4b.draw);
    if (inheritedTaxableDraw > 0)
      pensionTaxableIncome = round2(pensionTaxableIncome + inheritedTaxableDraw);
    const totalIncomeTax = round2(
      calculateIncomeTax(guaranteedGross + pensionTaxableIncome, retThresholdScale).totalTax
    );
    const unmet = round2(Math.max(0, remaining));
    const class3 = settleClass3(P, class3Cost, unmet);
    // Essential shortfall excludes the discretionary (and possibly skipped) Class 3.
    const shortfall = round2(Math.max(0, unmet - class3.unfunded));
    // A large one-off expense can push the shortfall past the year's target
    // expenses; net income achieved is floored at 0 rather than reported negative.
    const netAchieved = round2(Math.max(0, targetExpenses - shortfall));

    // Surplus guaranteed income (beyond this year's whole need) is saved into
    // the GIA at cost; the bed-and-ISA step then moves it into the ISA as
    // headroom allows.
    if (incomeSurplus > 0) investInGIA(P, incomeSurplus);

    // ── Bed and ISA (retirement) ────────────────────────────────────────────
    // After funding expenses, any remaining GIA is moved into the ISA up to the
    // annual subscription limit (£20,000). Withdrawals from the ISA do not count
    // toward the subscription limit, so the full headroom is available each year
    // minus however much lump sums used it this year. The CGT annual exempt is
    // partially consumed by drawdown step 2; only what remains is applied.
    const gainsUsedInStep2 = round2(step2.draw * step2.gainFracPre);
    const retExemptRemaining = round2(
      Math.max(0, GIA_CGT_CONSTANTS.annualExemptAmount - gainsUsedInStep2)
    );
    const bed = bedAndIsa(
      P,
      round2(ISA_LIMIT - isaUsed),
      round2(guaranteedGross + pensionTaxableIncome),
      retExemptRemaining,
      retThresholdScale
    );

    // ── Growth on remaining balances ───────────────────────────────────────
    const retYearRate = getRateForAge(
      rAge,
      P.retirementAge,
      yrRet.savingsRate,
      yrRet.retirementRate,
      glideBeforeYrs,
      glideAfterYrs
    );
    const growth = growPotsInRetirement(P, retYearRate);
    const inheritedGrowth = growInheritedPension(P, retYearRate);

    // ── The rest of the CGT allowance ──────────────────────────────────────
    const gainsHarvested = harvestGainsWithinExemption(
      P,
      round2(Math.max(0, retExemptRemaining - bed.gain))
    );

    // ── Row ────────────────────────────────────────────────────────────────
    const retRow = {
      year,
      age,
      phase: 'retirement',

      targetNetExpenses: targetExpenses,
      // Cumulative price index since the start year (1 = today's money), so
      // consumers can express this row's nominal figures in real terms.
      inflationIndex: Math.round(econ.cumulInflation * 1e6) / 1e6,
      // Spending-guardrails telemetry (real, today's money). Null-safe: when
      // guardrails are off, the budget just equals the target and no action fires.
      spendingBudgetReal: guardrails ? round2(retirement.grSpendReal) : null,
      guardrailAction,
      mortgagePayment: mortgagePaymentThisRetYear,
      unsecuredDebtPayments: retUnsecuredPayments,
      statePensionGross: spGross,
      statePensionNet: spNet,
      dbPension: dbRowSummary(P, db),
      dbPensionNet: dbNet,
      annuityGross,
      annuityNet,
      annuityPurchase: annuityPurchaseThisYear,
      incomeSurplusSaved: incomeSurplus,
      taxFreePensionDrawdown: step1.draw,
      taxablePensionDrawdown: step5.draw,
      pensionDrawdown: totalPensionDraw,
      isaWithdrawal: step3.draw,
      giaWithdrawal: totalGIADraw,
      giaCGT: totalGIACGT,
      incomeTax: totalIncomeTax,
      netIncomeAchieved: netAchieved,
      shortfall,
      class3Contribution: class3.contribution,
      class3YearBought: class3.bought,

      windfall: retWindfallAmt,
      windfallLabels: retWindfall?.labels ?? [],

      oneOffExpense: retExpenseAmt,
      oneOffExpenseLabels: retExpense?.labels ?? [],

      investmentRate: round2(retYearRate * 10000) / 10000,

      pension: {
        openingBalance: openPension,
        drawdown: totalPensionDraw,
        annuityPurchase: annuityPurchaseThisYear?.pensionUsed ?? 0,
        growthAmount: growth.pensionGrowth,
        closingBalance: P.pension,
        // Rough tax due when drawn, display only (see estimatedPensionTaxShare).
        estimatedTaxOnWithdrawal: estimatePensionWithdrawalTax(
          P.pension,
          estimatedPensionTaxShare(P)
        ),
      },
      isa: {
        openingBalance: openISA,
        withdrawal: step3.draw,
        bedIsaContrib: bed.net,
        growthAmount: growth.isaGrowth,
        closingBalance: P.isa,
      },
      gia: {
        openingBalance: openGIA,
        withdrawal: totalGIADraw,
        cgt: totalGIACGT,
        windfall: retWindfallAmt,
        bedIsaGross: bed.gross,
        bedIsaCGT: bed.cgt,
        growthAmount: growth.giaGrowth,
        // Gains realised within the CGT allowance and reinvested (base cost up).
        gainsRealisedTaxFree: gainsHarvested,
        closingBalance: P.gia,
        closingCostBasis: P.costBasis,
        unrealisedGain: round2(P.gia - P.costBasis),
      },
      bedIsa: { grossSold: bed.gross, cgt: bed.cgt, netContrib: bed.net },
      mortgage: retMortgageRow,
      unsecuredDebts: retDebtRows,
      studentLoan: null,
    };
    if (pclsThisYear) {
      retRow.pclsLumpSum = P.pcls.lumpSum;
      retRow.pclsCapped = P.pcls.capped;
    }
    retRow.pensionAccessible = pensionAccessible;
    if (premiums > 0) retRow.lifeCoverPremiums = premiums;
    if (P.inherited)
      retRow.inheritedPension = inheritedPensionRow(
        P,
        openInherited,
        step3a.draw,
        inheritedTaxableDraw,
        inheritedGrowth
      );
    yearlyBreakdown.push(decorateSurvivorRow(retRow, i, P, 'retired'));
  }

  // ── A couple's year (both partners alive) ─────────────────────────────────
  // Each partner's pay (while working) or guaranteed income (once retired) is
  // pooled. While both work, savings are what's left after household costs
  // (never negative, as for one person). Once either has retired, any gap is
  // drawn from the pots in tax order across both partners — each fills their
  // own personal allowance, each uses their own CGT exemption, then ISAs, then
  // taxable GIA, then taxable pension drawn so both incomes rise together
  // (both basic-rate bands fill before either pays higher rate) — and any
  // surplus is saved. Savings fill both £20k ISAs before the GIA, and the GIA
  // goes to whichever partner has the lower income (more basic-rate band left
  // for capital gains).
  function coupleYear(i, year, age, yr) {
    const scale = econ.thresholdScale;
    const infl = econ.cumulInflation;
    const allRetired = people.every((P) => P.retiredAt !== null);
    const allWorking = people.every((P) => P.retiredAt === null);
    const exempt = GIA_CGT_CONSTANTS.annualExemptAmount;
    // Married couples and civil partners can move investments between them
    // with no CGT (the receiver takes on the original cost), so each can use
    // their ISA and CGT allowances on the other's GIA — in drawdown, bed and
    // ISA and the year-end gains below. Only where it costs no tax now. A
    // couple living together can't: a transfer counts as a sale.
    const spouses = partnership === 'married';

    // ── Each partner's income ───────────────────────────────────────────
    const st = people.map((P) => {
      const pAge = P.currentAge + i;
      const s = {
        P,
        age: pAge,
        working: P.retiredAt === null,
        open: { pension: P.pension, isa: P.isa, gia: P.gia },
        pay: null,
        db: null,
        net: 0,
        incomeForCGT: 0,
        guaranteedGross: 0,
        spGross: 0,
        annuityGross: 0,
        annuityPurchase: null,
        pclsThisYear: false,
        accessible: false,
        isaUsed: 0,
        class3Cost: 0,
        class3: null,
        pensionDraw: 0,
        pensionTaxFree: 0,
        allowanceTopUp: 0,
        rasNet: 0,
        rasGross: 0,
        giaDraw: 0,
        giaCGT: 0,
        isaDraw: 0,
        exemptUsed: 0,
        isaContrib: 0,
        giaContrib: 0,
      };
      if (s.working) {
        s.pay = workingYearPay(P, pAge, year, i, yr, econ);
        s.db = s.pay.db;
        s.net = s.pay.netTakeHome;
        s.incomeForCGT = s.pay.thresholdIncome;
        // Tax-free cash from a DB scheme taken while working goes to their GIA.
        if (s.db.lumpTaxFree > 0) investInGIA(P, s.db.lumpTaxFree);
      } else {
        s.db = advanceDbSchemes(P, pAge, yr, true, false, 0, econ);
        s.annuityGross = annuityGrossThisYear(P, econ);
        s.spGross = statePensionGrossAt(P, pAge, P.niYears + P.class3.yearsBought, econ);
        s.accessible = pAge >= P.pensionAccessAge;
        const firstYear = pAge === P.retiredAt;
        s.pclsThisYear = firstYear && P.pcls.atEntry;
        s.isaUsed = firstYear ? P.pcls.toISAAtEntry : 0;
        if (P.pcls.pending && s.accessible && P.pension > 0) {
          s.isaUsed = takePensionLumpSum(P);
          P.pcls.pending = false;
          s.pclsThisYear = true;
        }
        s.class3Cost = class3CostThisYear(P, pAge, econ);
      }
      return s;
    });

    // Retirees: annuity purchase (sized around both partners' guaranteed
    // income), DB tax-free cash, and their guaranteed income after tax.
    for (const s of st) {
      if (s.working) continue;
      const P = s.P;
      let otherNet = 0;
      if (P.annuityCfg && s.age === P.annuity.buyAge && P.annuityCfg.sizing === 'essential') {
        const o = st.find((x) => x !== s);
        const oGross = plannedGuaranteedGross(
          o.P,
          o.age,
          econ,
          o.working ? o.pay.workingStatePension : o.spGross
        );
        otherNet = round2(oGross - calculateIncomeTax(oGross, scale).totalTax);
      }
      const buy = maybeBuyAnnuity(P, s.age, econ, s.spGross, scale, s.isaUsed, otherNet);
      s.isaUsed = buy.isaUsed;
      if (buy.income !== null) s.annuityGross = buy.income;
      s.annuityPurchase = buy.purchase;
      if (s.db.lumpTaxFree > 0) s.isaUsed = investTaxFreeCash(P, s.db.lumpTaxFree, s.isaUsed);
      s.guaranteedGross = round2(s.spGross + s.db.gross + s.db.lumpTaxable + s.annuityGross);
      s.net = round2(s.guaranteedGross - calculateIncomeTax(s.guaranteedGross, scale).totalTax);
      s.incomeForCGT = s.guaranteedGross;
    }
    // The partner with the lower income has more basic-rate band for gains.
    const byIncome = [...st].sort((a, b) => a.incomeForCGT - b.incomeForCGT);
    const lower = byIncome[0];

    // ── Household costs ─────────────────────────────────────────────────
    maybeStartMortgage(age, infl);
    const mort = mortgageYear(!allRetired);
    const unsec = unsecuredDebtsYear();
    const debtPayments = round2(mort.payment + unsec.payments);
    // Living costs while both work; the retirement target once both have
    // stopped (flexed by any guardrails). In between, while one has retired,
    // spending has moved `spendingShiftAtFirstRetirement` of the way from one
    // to the other.
    let guardrailAction = 'none';
    let spending;
    if (allRetired) {
      if (guardrails)
        guardrailAction = applyGuardrails(
          i,
          round2(st[0].annuityGross + st[1].annuityGross),
          (self.annuityCfg ?? partner.annuityCfg)?.inflationLinked ?? true
        );
      const targetReal = guardrails ? retirement.grSpendReal : retirement.targetNetAnnualExpenses;
      spending = round2(targetReal * infl);
    } else if (!allWorking && retirement != null) {
      const target = retirement.targetNetAnnualExpenses;
      const real =
        annualLivingExpenses + spendingShiftAtFirstRetirement * (target - annualLivingExpenses);
      spending = round2(real * infl);
    } else {
      spending = round2(annualLivingExpenses * infl);
    }

    // Windfalls land in the GIA of the partner with the lower income.
    const windfall = windfallsAtAge(age, infl);
    const windfallAmt = windfall?.nominal ?? 0;
    if (windfallAmt > 0) investInGIA(lower.P, windfallAmt);
    const expense = expensesAtAge(age, infl);
    const expenseAmt = expense?.nominal ?? 0;
    const income = round2(st[0].net + st[1].net);
    const class3Total = round2(st[0].class3Cost + st[1].class3Cost);
    const premiums = lifeCoverPremiums(i);

    let savings = 0;
    let availableForSavings = null;
    let expenseFunding = null;
    let expenseShortfall = 0;
    let remaining = 0;

    if (allWorking) {
      // Savings are what's left; a one-off expense is funded from them, then
      // from both GIAs (lower income first), then both ISAs.
      availableForSavings = round2(Math.max(0, income - debtPayments - spending - premiums));
      let cash = availableForSavings;
      let owed = expenseAmt;
      expenseFunding = { fromSavings: 0, fromGIAGross: 0, giaCGT: 0, fromISA: 0, shortfall: 0 };
      if (owed > 0) {
        for (const [k, s] of byIncome.entries()) {
          const f = fundExpenseWhileWorking(s.P, owed, k === 0 ? cash : 0, s.incomeForCGT, scale, {
            useIsa: false,
          });
          if (k === 0) {
            expenseFunding.fromSavings = f.fromSavings;
            cash = f.cashLeft;
          }
          expenseFunding.fromGIAGross = round2(expenseFunding.fromGIAGross + f.fromGIAGross);
          expenseFunding.giaCGT = round2(expenseFunding.giaCGT + f.giaCGT);
          s.giaDraw = f.fromGIAGross;
          s.giaCGT = f.giaCGT;
          s.exemptUsed = round2(exempt - f.exemptRemaining);
          owed = f.shortfall;
        }
        for (const s of st) {
          const f = fundExpenseWhileWorking(s.P, owed, 0, s.incomeForCGT, scale, { useGia: false });
          expenseFunding.fromISA = round2(expenseFunding.fromISA + f.fromISA);
          s.isaDraw = f.fromISA;
          owed = f.shortfall;
        }
        expenseShortfall = owed;
        expenseFunding.shortfall = owed;
      }
      savings = cash;
    } else {
      // Pooled income against the whole year's need, including any Class 3 top-up.
      const cashFlow = round2(
        income - debtPayments - spending - premiums - expenseAmt - class3Total
      );
      if (cashFlow >= 0) savings = cashFlow;
      else remaining = round2(-cashFlow);
    }

    // ── Drawdown across both partners ───────────────────────────────────
    if (remaining > 0) {
      const retirees = st.filter((s) => !s.working);
      // 1. Each retiree's pension within their own personal allowance.
      for (const s of retirees) {
        const r = drawPensionWithinAllowance(
          s.P,
          remaining,
          s.accessible,
          s.guaranteedGross,
          scale
        );
        remaining = r.remaining;
        s.pensionDraw = r.draw;
        s.pensionTaxFree = r.taxFree;
        s.incomeForCGT = round2(s.guaranteedGross + round2(r.draw - r.taxFree));
      }
      // 2. Each partner's GIA up to their own CGT exemption.
      for (const s of st) {
        const r = drawGiaWithinExemption(s.P, remaining, s.incomeForCGT, scale);
        remaining = r.remaining;
        s.giaDraw = round2(s.giaDraw + r.draw);
        s.giaCGT = round2(s.giaCGT + r.cgt);
        s.exemptUsed = round2(s.exemptUsed + r.draw * r.gainFracPre);
      }
      // Married: what's left of one partner's allowance is used on the other's
      // investments (moved to them free of CGT, then sold).
      if (spouses)
        for (const s of st) {
          const o = st.find((x) => x !== s);
          const left = round2(Math.max(0, exempt - s.exemptUsed));
          if (remaining <= 0 || left <= 0 || o.P.gia <= 0) continue;
          const r = drawGiaWithinExemption(o.P, remaining, s.incomeForCGT, scale, left);
          remaining = r.remaining;
          o.giaDraw = round2(o.giaDraw + r.draw);
          o.giaCGT = round2(o.giaCGT + r.cgt);
          s.exemptUsed = round2(s.exemptUsed + r.draw * r.gainFracPre);
        }
      // 3. ISAs, in proportion to their balances.
      const isaTotal = st[0].P.isa + st[1].P.isa;
      if (remaining > 0 && isaTotal > 0) {
        const first = drawIsa(st[0].P, round2((remaining * st[0].P.isa) / isaTotal));
        remaining = round2(remaining - first.draw);
        const second = drawIsa(st[1].P, remaining);
        remaining = second.remaining;
        const topUp = drawIsa(st[0].P, remaining);
        remaining = topUp.remaining;
        st[0].isaDraw = round2(st[0].isaDraw + first.draw + topUp.draw);
        st[1].isaDraw = round2(st[1].isaDraw + second.draw);
      }
      // 4. Taxable GIA, lower income first.
      for (const s of byIncome) {
        const r = drawGiaTaxable(s.P, remaining, s.incomeForCGT, scale);
        remaining = r.remaining;
        s.giaDraw = round2(s.giaDraw + r.draw);
        s.giaCGT = round2(s.giaCGT + r.cgt);
      }
      // 5. Taxable pension, keeping the retirees' taxable incomes level.
      remaining = drawPensionAcross(
        retirees.filter((s) => s.accessible && s.P.pension > 0),
        remaining,
        scale
      );
    }

    // ── Class 3 and shortfall ───────────────────────────────────────────
    // Any unmet need eats the (lowest-priority) Class 3 costs first.
    const unmet = round2(Math.max(0, remaining));
    let unmetLeft = unmet;
    let class3Unfunded = 0;
    for (const s of st) {
      if (s.working) continue;
      s.class3 = settleClass3(s.P, s.class3Cost, unmetLeft);
      unmetLeft = round2(Math.max(0, unmetLeft - s.class3.unfunded));
      class3Unfunded = round2(class3Unfunded + s.class3.unfunded);
    }
    const shortfall = round2(Math.max(0, unmet - class3Unfunded));

    // ── Use each retiree's personal allowance in full ───────────────────
    // Pension drawn within the personal allowance is tax-free, and moved into
    // an ISA it grows tax-free just as it would in the pension — but later
    // withdrawals from the pension would be taxed. So a retiree whose
    // allowance isn't used up by the year's spending (their partner still
    // works, or the household's other income covers it) draws pension up to
    // the allowance anyway and the money joins the year's savings. If their
    // partner can use the Marriage Allowance, £1,260 of it is left free for
    // that instead.
    const pa = round2(PERSONAL_ALLOWANCE * scale);
    const transferable = round2(COUPLE_DEFAULTS.marriageAllowance * scale);
    const basicRateTop = round2((PERSONAL_ALLOWANCE + BASIC_RATE_BAND) * scale);
    const taxableSoFar = (s) =>
      s.working
        ? s.pay.thresholdIncome
        : round2(s.guaranteedGross + round2(s.pensionDraw - s.pensionTaxFree));
    const taxableBefore = st.map(taxableSoFar);
    for (const [k, s] of st.entries()) {
      if (s.working) continue;
      const own = taxableBefore[k];
      const other = taxableBefore[1 - k];
      const leaveForMarriageAllowance =
        partnership === 'married' &&
        own <= pa - transferable &&
        other > pa &&
        other <= basicRateTop;
      const r = drawPensionWithinAllowance(
        s.P,
        s.P.pension,
        s.accessible,
        own,
        scale,
        leaveForMarriageAllowance ? round2(pa - transferable) : pa
      );
      if (r.draw <= 0) continue;
      s.allowanceTopUp = r.draw;
      s.pensionDraw = round2(s.pensionDraw + r.draw);
      s.pensionTaxFree = round2(s.pensionTaxFree + r.taxFree);
      savings = round2(savings + r.draw);
    }

    // Each retiree's income tax on guaranteed income plus taxable pension drawn.
    for (const s of st) {
      if (s.working) {
        s.incomeTax = s.pay.incomeTax;
        s.taxableIncome = s.pay.thresholdIncome;
      } else {
        s.taxableIncome = round2(s.guaranteedGross + round2(s.pensionDraw - s.pensionTaxFree));
        s.incomeTax = round2(calculateIncomeTax(s.taxableIncome, scale).totalTax);
      }
    }

    // ── Marriage Allowance ──────────────────────────────────────────────
    // A spouse or civil partner who doesn't use £1,260 of their personal
    // allowance can transfer it to a basic-rate partner, cutting their tax by
    // up to £252 a year (more as thresholds rise). Claimed when it costs the
    // transferor nothing; the saving is added to savings.
    let marriageAllowance = 0;
    if (partnership === 'married') {
      const [a, b] = byIncome;
      if (
        // (a penny's grace for rounding in the allowance top-up)
        a.taxableIncome <= pa - transferable + 0.01 &&
        b.taxableIncome > pa &&
        b.taxableIncome <= basicRateTop
      ) {
        marriageAllowance = round2(Math.min(b.incomeTax, 0.2 * transferable));
        b.incomeTax = round2(b.incomeTax - marriageAllowance);
        savings = round2(savings + marriageAllowance);
      }
    }

    // ── A non-earner's pension, with tax relief ─────────────────────────
    // A partner with pay under £3,600 can still pay £2,880 a year into a
    // pension and get £720 of basic-rate relief added: an instant 25% that
    // beats any other home for the household's savings, so it comes first.
    for (const s of st) {
      if (savings <= 0) break;
      const room = reliefAtSourceRoom(
        s.P,
        s.age,
        s.working ? s.pay.effectiveIncome : 0,
        s.working ? s.pay.employeeContrib : 0,
        !s.working && s.accessible
      );
      if (room <= 0) continue;
      const r = payWithReliefAtSource(s.P, savings, room);
      s.rasNet = r.net;
      s.rasGross = r.gross;
      savings = round2(savings - r.net);
    }

    // ── Savings: both ISAs first, then the lower earner's GIA ───────────
    if (savings > 0) {
      const room = st.map((s) => Math.max(0, ISA_LIMIT - s.isaUsed));
      let a0 = round2(Math.min(savings / 2, room[0]));
      const a1 = round2(Math.min(savings - a0, room[1]));
      a0 = round2(a0 + Math.min(savings - a0 - a1, room[0] - a0));
      st[0].isaContrib = a0;
      st[1].isaContrib = a1;
      for (const s of st) s.P.isa = round2(s.P.isa + s.isaContrib);
      const toGia = round2(Math.max(0, savings - a0 - a1));
      if (toGia > 0) {
        lower.giaContrib = toGia;
        investInGIA(lower.P, toGia);
      }
    }

    // ── Bed and ISA, growth and NI, per partner ─────────────────────────
    for (const s of st) {
      // Married: a partner with no investments of their own fills their ISA
      // from the other's, moved to them free of CGT (the rest goes back) —
      // only as far as their own CGT allowance covers the gain. Selling more
      // would mean paying CGT now on gains that might never be taxed.
      const o = st.find((x) => x !== s);
      const borrowed = spouses && s.P.gia <= 0 ? transferGIA(o.P, s.P, o.P.gia) : 0;
      const exemptLeft = round2(Math.max(0, exempt - s.exemptUsed));
      let headroom = round2(ISA_LIMIT - s.isaUsed - s.isaContrib);
      if (borrowed > 0) {
        const gainFrac = Math.max(0, (s.P.gia - s.P.costBasis) / s.P.gia);
        if (gainFrac > 0) headroom = round2(Math.min(headroom, exemptLeft / gainFrac));
      }
      s.bed = bedAndIsa(s.P, headroom, s.taxableIncome, exemptLeft, scale);
      if (borrowed > 0) transferGIA(s.P, o.P, s.P.gia);
    }
    for (const s of st) {
      s.rate = getRateForAge(
        s.age,
        s.P.retirementAge,
        yr.savingsRate,
        yr.retirementRate,
        glideBeforeYrs,
        glideAfterYrs
      );
      s.growth = s.working
        ? growPotsWhileWorking(s.P, s.rate, {
            employee: s.pay.employeeContrib,
            employer: s.pay.employerContrib,
            isa: 0,
            gia: 0,
          })
        : growPotsInRetirement(s.P, s.rate);
      // The rest of each partner's own CGT allowance, used at the year end.
      s.gainsHarvested = harvestGainsWithinExemption(
        s.P,
        round2(Math.max(0, exempt - s.exemptUsed - s.bed.gain))
      );
      s.niQualifyingYear = s.working ? recordNiQualifyingYear(s.P, s.pay) : false;
    }
    // Married: what's left of each partner's allowance realises gains on the
    // other's investments too (moved to them free of CGT, sold and bought back).
    if (spouses)
      for (const s of st) {
        const o = st.find((x) => x !== s);
        const left = round2(Math.max(0, exempt - s.exemptUsed - s.bed.gain - s.gainsHarvested));
        if (left > 0)
          s.gainsHarvested = round2(s.gainsHarvested + harvestGainsWithinExemption(o.P, left));
      }

    // ── Row ─────────────────────────────────────────────────────────────
    const sum = (f) => round2(st.reduce((t, s) => t + f(s), 0));
    const studentLoans = st.map((s) => s.pay?.slRow).filter(Boolean);
    const netIncomeAchieved = round2(Math.max(0, spending - shortfall));
    const row = {
      year,
      age,
      partnerAge: partner.currentAge + i,
      phase: allRetired ? 'retirement' : allWorking ? 'accumulation' : 'transition',
      inflationIndex: Math.round(infl * 1e6) / 1e6,

      // Household spending and cash flow
      livingExpenses: allRetired ? null : spending,
      targetNetExpenses: allRetired ? spending : null,
      spendingBudgetReal: allRetired && guardrails ? round2(retirement.grSpendReal) : null,
      guardrailAction,
      mortgagePayment: mort.payment,
      unsecuredDebtPayments: unsec.payments,
      lifeCoverPremiums: premiums,
      netIncome: income,
      availableForSavings,
      saved: savings,
      shortfall,
      netIncomeAchieved,
      marriageAllowance,
      pensionSavedWithinAllowance: sum((s) => s.allowanceTopUp),
      // Paid into a non-earner's pension from savings, with relief (gross).
      reliefAtSourceContributions: sum((s) => s.rasGross),
      windfall: windfallAmt,
      windfallLabels: windfall?.labels ?? [],
      oneOffExpense: expenseAmt,
      oneOffExpenseLabels: expense?.labels ?? [],
      oneOffExpenseFunding: allWorking && expenseAmt > 0 ? expenseFunding : null,
      expenseShortfall,

      // Totals across both partners
      grossIncome: sum((s) => s.pay?.effectiveIncome ?? 0),
      incomeTax: sum((s) => s.incomeTax),
      employeeNI: sum((s) => s.pay?.employeeNI ?? 0),
      studentLoanRepayment: sum((s) => s.pay?.slRepayment ?? 0),
      statePensionGross: sum((s) => (s.working ? s.pay.workingStatePension : s.spGross)),
      annuityGross: sum((s) => s.annuityGross),
      pensionDrawdown: sum((s) => s.pensionDraw),
      isaWithdrawal: sum((s) => s.isaDraw),
      giaWithdrawal: sum((s) => s.giaDraw),
      giaCGT: sum((s) => s.giaCGT),
      isaContribution: sum((s) => s.isaContrib),
      giaContribution: sum((s) => s.giaContrib),
      class3Contribution: sum((s) => s.class3?.contribution ?? 0),
      investmentRate: round2(st[0].rate * 10000) / 10000,

      pension: {
        openingBalance: sum((s) => s.open.pension),
        growthAmount: sum((s) => s.growth.pensionGrowth),
        closingBalance: sum((s) => s.P.pension),
        estimatedTaxOnWithdrawal: sum((s) =>
          estimatePensionWithdrawalTax(s.P.pension, estimatedPensionTaxShare(s.P))
        ),
      },
      isa: {
        openingBalance: sum((s) => s.open.isa),
        growthAmount: sum((s) => s.growth.isaGrowth),
        closingBalance: sum((s) => s.P.isa),
      },
      gia: {
        openingBalance: sum((s) => s.open.gia),
        growthAmount: sum((s) => s.growth.giaGrowth),
        gainsRealisedTaxFree: sum((s) => s.gainsHarvested),
        closingBalance: sum((s) => s.P.gia),
        closingCostBasis: sum((s) => s.P.costBasis),
        unrealisedGain: sum((s) => s.P.gia - s.P.costBasis),
      },
      mortgage: mort.row,
      unsecuredDebts: unsec.rows,
      studentLoan:
        studentLoans.length > 0
          ? {
              openingBalance: round2(studentLoans.reduce((t, r) => t + r.openingBalance, 0)),
              repayment: round2(studentLoans.reduce((t, r) => t + r.repayment, 0)),
              closingBalance: round2(studentLoans.reduce((t, r) => t + r.closingBalance, 0)),
            }
          : null,

      people: st.map((s) => personRowFromCouple(s)),
    };
    yearlyBreakdown.push(row);
  }

  /**
   * Step 5 across a couple: draw `remaining` (net) from the eligible
   * retirees' pensions so their taxable incomes end level — both basic-rate
   * bands fill before either pays higher rate. Finds the common taxable
   * income level by bisection. Returns what is still needed.
   */
  function drawPensionAcross(list, remaining, scale) {
    if (remaining <= 0 || list.length === 0) return remaining;
    if (list.length === 1) {
      const s = list[0];
      const r = drawPensionTaxable(s.P, remaining, true, s.incomeForCGT, scale);
      s.pensionDraw = round2(s.pensionDraw + r.draw);
      s.pensionTaxFree = round2(s.pensionTaxFree + r.taxFree);
      return r.remaining;
    }
    const grossAt = (s, level) => pensionGrossForTaxable(s.P, Math.max(0, level - s.incomeForCGT));
    const netAt = (level) =>
      list.reduce((t, s) => {
        const g = grossAt(s, level);
        const taxFree = s.P.takePCLS ? 0 : Math.min(0.25 * g, s.P.lsaRemaining);
        const tax =
          calculateIncomeTax(s.incomeForCGT + g - taxFree, scale).totalTax -
          calculateIncomeTax(s.incomeForCGT, scale).totalTax;
        return t + g - tax;
      }, 0);
    let lo = Math.min(...list.map((s) => s.incomeForCGT));
    let hi = Math.max(...list.map((s) => s.incomeForCGT)) + remaining * 3 + 200_000;
    if (netAt(hi) > remaining) {
      for (let iter = 0; iter < 60; iter++) {
        const mid = (lo + hi) / 2;
        if (netAt(mid) < remaining) lo = mid;
        else hi = mid;
      }
    }
    for (const s of list) {
      const r = drawPensionGross(s.P, grossAt(s, hi), s.incomeForCGT, scale);
      s.pensionDraw = round2(s.pensionDraw + r.draw);
      s.pensionTaxFree = round2(s.pensionTaxFree + r.taxFree);
      remaining = round2(remaining - r.net);
    }
    return round2(Math.max(0, remaining));
  }

  /** One partner's part of a couple row. */
  function personRowFromCouple(s) {
    const P = s.P;
    return {
      id: P.id,
      age: s.age,
      status: s.working ? 'working' : 'retired',
      grossIncome: s.pay?.effectiveIncome ?? 0,
      hoursFraction: s.pay?.hoursFraction ?? null,
      employeeContribution: s.pay?.employeeContrib ?? 0,
      employerContribution: s.pay?.employerContrib ?? 0,
      // Paid in from the household's savings with no or low earnings: what was
      // paid, and the total with basic-rate relief added.
      reliefAtSourceNet: s.rasNet,
      reliefAtSourceGross: s.rasGross,
      pensionInput: s.pay?.pensionInput ?? 0,
      annualAllowance: s.pay?.annualAllowance ?? null,
      annualAllowanceBreached: s.pay?.annualAllowanceBreached ?? false,
      incomeTax: s.incomeTax,
      employeeNI: s.pay?.employeeNI ?? 0,
      salarySacrificeNiable: s.pay?.sacrificeNiable ?? 0,
      salarySacrificeExtraNI: s.pay?.sacrificeExtraNI ?? 0,
      studentLoanRepayment: s.pay?.slRepayment ?? 0,
      statePensionGross: s.working ? s.pay.workingStatePension : s.spGross,
      dbPension: dbRowSummary(P, s.db),
      annuityGross: s.annuityGross,
      annuityPurchase: s.annuityPurchase,
      pclsLumpSum: s.pclsThisYear ? P.pcls.lumpSum : 0,
      pclsCapped: s.pclsThisYear ? P.pcls.capped : false,
      netIncome: s.net,
      taxableIncome: s.taxableIncome,
      pensionDrawdown: s.pensionDraw,
      pensionTaxFreeDrawn: s.pensionTaxFree,
      // Of the pension drawn, how much was moved to savings to use the
      // personal allowance (not needed for spending).
      pensionSavedWithinAllowance: s.allowanceTopUp,
      isaWithdrawal: s.isaDraw,
      giaWithdrawal: s.giaDraw,
      giaCGT: s.giaCGT,
      isaContribution: s.isaContrib,
      giaContribution: s.giaContrib,
      bedIsa: { grossSold: s.bed.gross, cgt: s.bed.cgt, netContrib: s.bed.net },
      class3Contribution: s.class3?.contribution ?? 0,
      class3YearBought: s.class3?.bought ?? false,
      pensionAccessible: s.age >= P.pensionAccessAge,
      investmentRate: round2(s.rate * 10000) / 10000,
      pension: {
        openingBalance: s.open.pension,
        growthAmount: s.growth.pensionGrowth,
        closingBalance: P.pension,
        estimatedTaxOnWithdrawal: estimatePensionWithdrawalTax(
          P.pension,
          estimatedPensionTaxShare(P)
        ),
      },
      isa: {
        openingBalance: s.open.isa,
        growthAmount: s.growth.isaGrowth,
        closingBalance: P.isa,
      },
      gia: {
        openingBalance: s.open.gia,
        growthAmount: s.growth.giaGrowth,
        // Gains realised within this partner's CGT allowance (for a married
        // couple, possibly on investments held by the other).
        gainsRealisedTaxFree: s.gainsHarvested,
        closingBalance: P.gia,
        closingCostBasis: P.costBasis,
      },
      studentLoan: s.pay?.slRow ?? null,
      niQualifyingYear: s.niQualifyingYear,
      cumulativeNIYears: P.niYears,
    };
  }

  /** The survivor's part of a row produced for a one-person year. */
  function personRowFromSingle(P, row, status, personAge) {
    return {
      id: P.id,
      age: personAge,
      status,
      grossIncome: row.grossIncome ?? 0,
      hoursFraction: row.hoursFraction ?? null,
      employeeContribution: row.employeeContribution ?? 0,
      employerContribution: row.employerContribution ?? 0,
      reliefAtSourceNet: 0,
      reliefAtSourceGross: 0,
      pensionInput: row.pensionInput ?? 0,
      annualAllowance: row.annualAllowance ?? null,
      annualAllowanceBreached: row.annualAllowanceBreached ?? false,
      incomeTax: row.incomeTax,
      employeeNI: row.employeeNI ?? 0,
      studentLoanRepayment: row.studentLoanRepayment ?? 0,
      statePensionGross: row.statePensionGross,
      dbPension: row.dbPension,
      annuityGross: row.annuityGross ?? 0,
      annuityPurchase: row.annuityPurchase ?? null,
      pclsLumpSum: row.pclsLumpSum ?? 0,
      pclsCapped: row.pclsCapped ?? false,
      netIncome: status === 'working' ? row.netTakeHome : null,
      pensionDrawdown: row.pensionDrawdown ?? 0,
      pensionSavedWithinAllowance: 0,
      isaWithdrawal: row.isaWithdrawal ?? 0,
      giaWithdrawal: row.giaWithdrawal ?? 0,
      giaCGT: row.giaCGT ?? 0,
      isaContribution: row.isaContribution ?? 0,
      giaContribution: row.giaContribution ?? 0,
      bedIsa: row.bedIsa,
      class3Contribution: row.class3Contribution ?? 0,
      class3YearBought: row.class3YearBought ?? false,
      pensionAccessible: row.pensionAccessible ?? personAge >= P.pensionAccessAge,
      investmentRate: row.investmentRate,
      pension: row.pension,
      isa: row.isa,
      gia: row.gia,
      inheritedPension: row.inheritedPension ?? null,
      studentLoan: row.studentLoan,
      niQualifyingYear: row.niQualifyingYear ?? false,
      cumulativeNIYears: P.niYears,
    };
  }

  /** Inherited pension figures for a row. */
  function inheritedPensionRow(P, opening, taxFreeDrawn, taxableDrawn, growth) {
    return {
      openingBalance: opening,
      taxFreeDrawdown: taxFreeDrawn,
      taxableDrawdown: taxableDrawn,
      growthAmount: growth,
      closingBalance: inheritedPensionBalance(P),
      taxFree: P.inherited.taxable === 0 && P.inherited.taxFree > 0,
      // Display-only tax estimate: tax-free, or basic rate on the taxable pot.
      estimatedTaxOnWithdrawal: estimatePensionWithdrawalTax(P.inherited.taxable, {
        taxFreeShare: 0,
      }),
    };
  }

  // ── Year loop ─────────────────────────────────────────────────────────────
  // Work until the target retirement age, then (if flexible) keep going while
  // off track, up to the delay cap or the plan horizon. Without a retirement
  // phase the projection ends when everyone has stopped work; with one, it
  // runs to the horizon.
  let accumulationYears; // the main person's working years (set when they stop)
  let retEntry = null; // pots and debts on the day everyone has retired
  for (let i = 0; ; i++) {
    const year = currentYear + i;
    const age = currentAge + i;

    // ── A death ("what if one of us dies?") ─────────────────────────────
    if (deathPlan && i === deathPlan.yearIndex && deathPlan.D.diedAt === null) {
      const { D, S } = deathPlan;
      const estate = settleDeath(D, S, {
        age: D.currentAge + i,
        survivorAge: S.currentAge + i,
        year,
        partnership,
        willsToEachOther,
        econ,
        cover: coverOnDeath(D, i),
      });
      // Cover reaching the survivor: towards the mortgage where the policy
      // says so (if it has started), the rest into their savings.
      for (const c of estate.coverPaid) {
        let amount = c.amount;
        if (c.payTo === 'mortgage' && mortgageStarted && mortgageBalance > 0) {
          const repaid = round2(Math.min(amount, mortgageBalance));
          mortgageBalance = round2(mortgageBalance - repaid);
          estate.lifeCover.toMortgage = round2(estate.lifeCover.toMortgage + repaid);
          amount = round2(amount - repaid);
        }
        if (amount > 0) {
          investInGIA(S, amount);
          estate.lifeCover.toSavings = round2(estate.lifeCover.toSavings + amount);
        }
      }
      estates.push(estate);
    }
    const alive = alivePeople();

    // Stop working once at/after the target age and either not flexible, on
    // track, at the delay cap, or at the horizon. The on-track test is only
    // evaluated when flexible (the cap check short-circuits otherwise).
    const stopping = [];
    for (const P of alive) {
      if (P.retiredAt !== null) continue;
      const personAge = P.currentAge + i;
      if (personAge < P.retirementAge) continue;
      const cap = flexibleRetirement ? maxRetirementDelayYears : 0;
      const hitCap = personAge - P.retirementAge >= cap;
      const atHorizon =
        retirementOptions != null && age >= (retirementOptions.maxAge ?? Infinity) + ageGap;
      if (hitCap || atHorizon || onTrackToRetire(i)) stopping.push(P);
    }
    if (stopping.includes(self)) accumulationYears = i;
    if (
      retirementOptions == null &&
      stopping.length > 0 &&
      alive.every((P) => P.retiredAt !== null || stopping.includes(P))
    )
      break;
    for (const P of stopping)
      enterRetirement(P, P.currentAge + i, retirement?.maxAge ?? Infinity, {
        takePCLS: retirement != null && P.plannedTakePCLS,
        pclsPercentage: retirement?.pclsPercentage ?? PENSION_CONSTANTS.maxPCLSPercentage,
      });

    const allRetired = alive.every((P) => P.retiredAt !== null);
    if (allRetired && retEntry === null && retirementOptions != null) {
      // Pots and debts at retirement entry (after any lump sum, before drawdown).
      retEntry = {
        age,
        year,
        pension: alive.reduce((s, P) => s + P.pension, 0),
        isa: alive.reduce((s, P) => s + P.isa, 0),
        gia: alive.reduce((s, P) => s + P.gia, 0),
        costBasis: alive.reduce((s, P) => s + P.costBasis, 0),
        mortgage: mortgageBalance,
        unsecured: round2(unsecuredOutstanding()),
        people: people.map((P) => ({ pension: P.pension, isa: P.isa, gia: P.gia })),
      };
    }
    if (allRetired && retirement !== null && age > retirement.maxAge + ageGap) break;

    // This year's rates and running products (i=0 leaves them at 1, matching
    // Math.pow(..., 0)=1).
    const yr = ratesForYear(i);
    const yrTriplelock = Math.max(yr.wageGrowthRate, yr.inflationRate, 0.025);
    if (i > 0) {
      econ.cumulInflation *= 1 + yr.inflationRate;
      // Tax and NI thresholds are frozen to 2030/31; after that they follow
      // inflation, less any fiscal drag.
      if (year > LIFECYCLE_CONSTANTS.tax.thresholdsFrozenThrough)
        econ.thresholdScale *= 1 + yr.inflationRate - fiscalDragRate;
      econ.cumulTriplelock *= 1 + yrTriplelock;
    }
    for (const P of alive) recordStatePensionClaim(P, P.currentAge + i, econ);

    if (alive.length === 1) {
      const P = alive[0];
      if (P.retiredAt === null) workingYear(P, i, year, age, yr);
      else retiredYear(P, i, year, age, yr);
    } else {
      coupleYear(i, year, age, yr);
    }
  }

  // Actual (possibly delayed) retirement age/year resolved by the loop above.
  // Without flexible retirement these equal the target retirementAge. (In a
  // couple, null if the main person died before retiring.)
  const actualRetirementAge =
    accumulationYears === undefined ? null : currentAge + accumulationYears;
  const actualRetirementYear =
    accumulationYears === undefined ? null : currentYear + accumulationYears;
  const retirementDelayYears =
    actualRetirementAge === null ? 0 : actualRetirementAge - retirementAge;

  // ── Summary ──────────────────────────────────────────────────────────────
  // With a retirement phase, report balances at retirement entry (after PCLS,
  // before drawdown) so headline figures reflect "what you have on day one of
  // retirement" — the end of the projection would give zero whenever pots are
  // depleted by maxAge. Without one, report the end of the working years.
  const sumNow = (f) => people.reduce((s, P) => s + f(P), 0);
  const sumPension = retEntry !== null ? retEntry.pension : sumNow((P) => P.pension);
  const sumISA = retEntry !== null ? retEntry.isa : sumNow((P) => P.isa);
  const sumGIA = retEntry !== null ? retEntry.gia : sumNow((P) => P.gia);
  const sumCostBasis = retEntry !== null ? retEntry.costBasis : sumNow((P) => P.costBasis);
  const sumMortgage = retEntry !== null ? retEntry.mortgage : mortgageBalance;
  const sumUnsecured = retEntry !== null ? retEntry.unsecured : round2(unsecuredOutstanding());
  const studentLoanOutstanding = sumNow((P) => P.studentLoan?.balance ?? 0);
  // Nominal state pension at the age it first becomes payable, triple-lock grown from today.
  // Uses the base-rate triplelock for the summary figure (independent of yearlyRatesOverride).
  const baseTriplelockForSummary = Math.max(wageGrowthRate, inflationRate, 0.025);
  const projectedStatePensionOf = (P) =>
    round2(
      computeStatePension(P.niYears + P.class3.yearsBought) *
        Math.pow(1 + baseTriplelockForSummary, Math.max(0, P.spClaimAge - P.currentAge)) *
        P.statePensionDeferralUplift
    );
  // Qualifying years including any Class 3 years bought in the retirement phase.
  const niYearsWithTopUp = self.niYears + self.class3.yearsBought;
  const projectedStatePension = projectedStatePensionOf(self);
  const totalSavings = round2(sumPension + sumISA + sumGIA);
  const totalDebt = round2(sumMortgage + sumUnsecured + studentLoanOutstanding);

  const summary = {
    retirementYear: actualRetirementYear,
    retirementAge: actualRetirementAge,
    nominalRetirementAge: retirementAge,
    retirementDelayYears,
    flexibleRetirement,
    pensionPot: sumPension,
    isaBalance: sumISA,
    giaBalance: sumGIA,
    giaCostBasis: sumCostBasis,
    giaUnrealisedGain: round2(sumGIA - sumCostBasis),
    mortgageOutstanding: sumMortgage,
    unsecuredDebtOutstanding: sumUnsecured,
    studentLoanOutstanding,
    totalSavings,
    totalDebt,
    netWorth: round2(totalSavings - totalDebt),
    niYearsAccrued: self.niYears,
    class3YearsBought: self.class3.yearsBought,
    class3TotalCost: self.class3.totalCost,
    niYearsWithTopUp,
    projectedStatePension,
    statePensionAge: self.statePensionAge,
    statePensionStartAge: self.spClaimAge,
    statePensionEligibleAtRetirement:
      actualRetirementAge !== null && actualRetirementAge >= self.statePensionAge,
    annuity: (annuityOwner === 'partner' ? partner : self).annuity?.result ?? null,
    // Each DB scheme: when it was (or will be) paid, the yearly pension then
    // and any lump sum, in cash and today's money. startAge is null if the
    // scheme is not paid within the projection.
    dbPensions: dbSchemeSummaries(self),
  };
  if (couple) {
    Object.assign(summary, {
      couple: true,
      partnership,
      willsToEachOther,
      survivorSpendingShare,
      // The timeline age at which both had retired (the summary's balances date).
      householdRetirementAge: retEntry?.age ?? null,
      householdRetirementYear: retEntry?.year ?? null,
      // What each person held and was due, for the per-person results.
      people: people.map((P, j) => ({
        id: P.id,
        currentAge: P.currentAge,
        retirementAge: P.retiredAt,
        nominalRetirementAge: P.retirementAge,
        diedAt: P.diedAt,
        pensionPotAtRetirement: retEntry?.people[j].pension ?? P.pension,
        isaAtRetirement: retEntry?.people[j].isa ?? P.isa,
        giaAtRetirement: retEntry?.people[j].gia ?? P.gia,
        niYearsAccrued: P.niYears,
        class3YearsBought: P.class3.yearsBought,
        class3TotalCost: P.class3.totalCost,
        niYearsWithTopUp: P.niYears + P.class3.yearsBought,
        projectedStatePension: projectedStatePensionOf(P),
        statePensionAge: P.statePensionAge,
        statePensionStartAge: P.spClaimAge,
        annuity: P.annuity?.result ?? null,
        dbPensions: dbSchemeSummaries(P),
      })),
      // At each death: what the person held, the inheritance tax, and where
      // it went (ukEstate.js). Empty unless a death is modelled.
      estates,
    });
  }

  return {
    startYear: currentYear,
    retirementYear: actualRetirementYear,
    hasRetirementPhase: retirementOptions != null,
    yearlyBreakdown,
    summary,
    taxYear: TAX_YEAR,
  };
}
