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
} from './ukLifecyclePerson.js';

export { LIFECYCLE_CONSTANTS };

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
  } = profile;

  if (!Number.isInteger(currentYear) || currentYear < 1990)
    throw new RangeError('currentYear must be an integer >= 1990');

  // ── The person ──────────────────────────────────────────────────────────
  // Their pay, pots, pension rights and retirement choices (ukLifecyclePerson.js).
  const P = createPerson(profile, pots, retirementOptions, currentYear);
  const { currentAge, retirementAge } = P;

  // Windfalls and one-off expenses: discrete life events at a given age.
  // Windfalls (inheritance, asset sale, gift) add money to the GIA; one-off
  // expenses (house deposit, wedding, helping children) are funded from the
  // pots. Amounts are net of fees/taxes, expressed in today's money, and
  // inflated to the event year. Events at ages outside the projected range
  // are simply never reached (harmless). An event with enabled === false is
  // skipped entirely — it can be toggled off for what-if comparisons without
  // being deleted.
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
   * Real-terms two-bucket rundown from `atAge`: can the pots fund `spendReal`
   * (today's money) of net spending every year to the horizon under central
   * assumptions? Accessible pots (ISA + GIA) are drawn first, then the locked
   * pension once past its access age (grossed up for tax), with the state
   * pension switched on at its (deferred) start age and debt cleared from
   * spendable pots up front. Never peeks at realised future returns — it is a
   * decision rule, not the model. Deliberately simple and slightly conservative.
   */
  function rundownSurvives(
    atAge,
    pension,
    isa,
    gia,
    mortgage,
    unsecured,
    niYearsNow,
    cumulInflNow,
    spendReal,
    annuityGrossNominal = 0,
    annuityInflationLinked = true
  ) {
    const horizon = retirementOptions.maxAge ?? 90;
    const deflate = cumulInflNow > 0 ? 1 / cumulInflNow : 1;

    // Today's-money buckets: accessible (ISA + GIA) and locked pension (NMPA).
    let accessible = Math.max(0, (isa + gia) * deflate);
    let locked = Math.max(0, pension * deflate);
    // Clear outstanding debt from spendable pots first (conservative).
    let debt = Math.max(0, (mortgage + unsecured) * deflate);
    const payFromAccessible = Math.min(accessible, debt);
    accessible -= payFromAccessible;
    debt -= payFromAccessible;
    locked = Math.max(0, locked - debt);

    // Today's money (triple lock ≈ real-constant), including any deferral increase.
    const stateReal = computeStatePension(niYearsNow) * P.statePensionDeferralUplift;
    const spStart = P.spClaimAge;
    // An annuity already in payment is guaranteed income, like the state pension.
    // Inflation-linked holds its real value; level erodes at the central inflation
    // rate. Counted net of basic-rate tax (it stacks on the state pension, which
    // largely fills the personal allowance). A planned-but-unbought annuity is
    // ignored: converting pot to income at a fair rate is roughly neutral here.
    const annuityReal0 = Math.max(0, annuityGrossNominal * deflate);

    for (let a = atAge; a <= horizon; a++) {
      const annuityReal = annuityInflationLinked
        ? annuityReal0
        : annuityReal0 / Math.pow(1 + inflationRate, a - atAge);
      // DB pensions are guaranteed income too, taxed like the annuity.
      let need = Math.max(
        0,
        spendReal -
          (a >= spStart ? stateReal : 0) -
          ANNUITY_NET_FACTOR * (annuityReal + dbRealIncomeAt(P, a, atAge, deflate, inflationRate))
      );
      if (need > 0) {
        const fromAccessible = Math.min(accessible, need);
        accessible -= fromAccessible;
        need -= fromAccessible;
      }
      if (need > 0 && a >= P.pensionAccessAge && locked > 0) {
        const grossDrawn = Math.min(locked, need * TEST_PENSION_GROSSUP);
        locked -= grossDrawn;
        need -= grossDrawn / TEST_PENSION_GROSSUP;
      }
      if (need > 0.5) return false; // can't meet this year's spending under central assumptions
      accessible *= 1 + centralRealReturn;
      locked *= 1 + centralRealReturn;
    }
    return true;
  }

  // Flexible-retirement on-track test: can the target spend be funded for life?
  function onTrackToRetire(
    atAge,
    pension,
    isa,
    gia,
    mortgage,
    unsecured,
    niYearsNow,
    cumulInflNow
  ) {
    if (retirementOptions == null) return true;
    const targetReal = retirementOptions.targetNetAnnualExpenses ?? 0;
    if (targetReal <= 0) return true;
    return rundownSurvives(
      atAge,
      pension,
      isa,
      gia,
      mortgage,
      unsecured,
      niYearsNow,
      cumulInflNow,
      targetReal
    );
  }

  // Largest real (today's-money) net spend the pots can sustain from `atAge` to
  // the horizon under central assumptions — the spending guardrails steer toward
  // this. Found by bisection on rundownSurvives, which is monotonic in spend
  // (more spending is never easier to sustain). ~30 iterations gives sub-pound
  // resolution on any realistic pot.
  function sustainableSpendReal(
    atAge,
    pension,
    isa,
    gia,
    mortgage,
    unsecured,
    niYearsNow,
    cumulInflNow,
    annuityGrossNominal = 0,
    annuityInflationLinked = true
  ) {
    const deflate = cumulInflNow > 0 ? 1 / cumulInflNow : 1;
    const totalReal = Math.max(0, (pension + isa + gia) * deflate);
    // Upper bound: drawing the whole (real) pot plus all guaranteed income in a
    // single year cannot be sustained beyond it, so this always fails the rundown.
    let hi =
      totalReal +
      computeStatePension(niYearsNow) * P.statePensionDeferralUplift +
      Math.max(0, annuityGrossNominal * deflate) +
      P.dbStates.reduce((sum, st) => sum + st.pension * deflate * 2, 0) +
      1;
    let lo = 0;
    for (let iter = 0; iter < 30; iter++) {
      const mid = (lo + hi) / 2;
      if (
        rundownSurvives(
          atAge,
          pension,
          isa,
          gia,
          mortgage,
          unsecured,
          niYearsNow,
          cumulInflNow,
          mid,
          annuityGrossNominal,
          annuityInflationLinked
        )
      ) {
        lo = mid;
      } else {
        hi = mid;
      }
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

  // ── A working year ────────────────────────────────────────────────────────
  // Pay and deductions, debt payments and living costs; what is left is saved
  // (ISA first, then GIA) after funding any one-off expense, then bed and ISA
  // and growth.
  function workingYear(i, year, age, yr) {
    const pay = workingYearPay(P, age, year, i, yr, econ);
    const { db } = pay;

    // ── Debt payments ───────────────────────────────────────────────────
    // Mortgage — may begin part-way through the projection (future purchase)
    maybeStartMortgage(age, econ.cumulInflation);
    const { payment: mortgagePaymentThisYear, row: mortgageRow } = mortgageYear(true);
    const { payments: unsecuredPaymentsThisYear, rows: debtRows } = unsecuredDebtsYear();

    // ── Savings allocation (ISA first, then GIA) ────────────────────────
    const totalDebtPayments = round2(mortgagePaymentThisYear + unsecuredPaymentsThisYear);
    // Living expenses scale with inflation from their today's-money baseline.
    const livingExpenses = round2(annualLivingExpenses * econ.cumulInflation);
    // Savings = what's left of take-home after debts and living costs.
    // Floored at 0 — overspend is not modelled; the user should adjust inputs.
    const availableForSavings = round2(
      Math.max(0, pay.netTakeHome - totalDebtPayments - livingExpenses)
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
      age,
      retirementAge,
      yr.savingsRate,
      yr.retirementRate,
      glideBeforeYrs,
      glideAfterYrs
    );
    const openingPension = P.pension;
    const growth = growPotsWhileWorking(P, yearRate, {
      employee: pay.employeeContrib,
      employer: pay.employerContrib,
      isa: isaContrib,
      gia: giaContrib,
    });

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
    yearlyBreakdown.push({
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
    });
  }

  // ── Retirement ────────────────────────────────────────────────────────────
  // Set when work stops (only with a retirement phase): the spending target,
  // horizon and guardrail state, and the pots and debts on day one — the
  // summary reports "what you have at retirement", not "what's left at maxAge".
  let retirement = null;
  let retEntry = null;

  function startRetirement(age) {
    const {
      targetNetAnnualExpenses,
      maxAge = 90,
      takePCLS = false,
      pclsPercentage = PENSION_CONSTANTS.maxPCLSPercentage,
    } = retirementOptions;

    assertNonNegativeFinite(targetNetAnnualExpenses, 'retirementOptions.targetNetAnnualExpenses');
    if (!Number.isInteger(maxAge) || maxAge <= retirementAge)
      throw new RangeError('retirementOptions.maxAge must be an integer > retirementAge');

    // Lump sum (now, or deferred to the pension access age), Class 3 target and
    // annuity purchase age.
    enterRetirement(P, age, maxAge, { takePCLS, pclsPercentage });

    // Pots and debts at retirement entry (after any lump sum, before drawdown).
    retEntry = {
      pension: P.pension,
      isa: P.isa,
      gia: P.gia,
      costBasis: P.costBasis,
      mortgage: mortgageBalance,
      unsecured: round2(unsecuredOutstanding()),
    };

    // ── Spending guardrails state (real, today's money) ──────────────────────
    // Floor is clamped to the target (a floor above target would be nonsensical);
    // the current allowed spend starts at the target and flexes within [floor,
    // ceiling] as the guardrails react to the pot each year.
    retirement = {
      targetNetAnnualExpenses,
      maxAge,
      grFloor: guardrails ? Math.min(guardrails.floor, targetNetAnnualExpenses) : 0,
      grCeiling: guardrails ? (guardrails.ceilingPct / 100) * targetNetAnnualExpenses : Infinity,
      grSpendReal: targetNetAnnualExpenses,
    };
  }

  // ── A retirement year ─────────────────────────────────────────────────────
  // Guaranteed income (state pension, DB pensions, any annuity) is netted
  // against the year's whole need — living costs, debts, one-offs and any
  // Class 3 top-up — and the rest is drawn from the pots in tax-efficiency
  // order; surplus income is saved. Then bed and ISA, and growth.
  function retiredYear(year, rAge, yrRet) {
    const isFirstYear = rAge === P.retiredAt;
    const { targetNetAnnualExpenses } = retirement;

    const openPension = P.pension;
    const openISA = P.isa;
    const openGIA = P.gia;

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
    let guardrailAction = 'none';
    if (guardrails) {
      const sustainable = sustainableSpendReal(
        rAge,
        P.pension,
        P.isa,
        P.gia,
        mortgageBalance,
        unsecuredOutstanding(),
        P.niYears,
        econ.cumulInflation,
        annuityGross,
        P.annuityCfg?.inflationLinked ?? true
      );
      if (retirement.grSpendReal > sustainable * (1 + guardrails.band)) {
        retirement.grSpendReal = retirement.grSpendReal * (1 - guardrails.step);
        guardrailAction = 'cut';
      } else if (retirement.grSpendReal < sustainable * (1 - guardrails.band)) {
        retirement.grSpendReal = retirement.grSpendReal * (1 + guardrails.step);
        guardrailAction = 'raise';
      }
      retirement.grSpendReal = Math.min(
        retirement.grCeiling,
        Math.max(retirement.grFloor, retirement.grSpendReal)
      );
    }
    const effectiveTargetReal = guardrails ? retirement.grSpendReal : targetNetAnnualExpenses;

    // Inflation-adjusted target net expenses — inflated from today (currentAge),
    // not from retirement date, so the input figure represents today's purchasing power.
    const targetExpenses = round2(effectiveTargetReal * econ.cumulInflation);

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
    maybeStartMortgage(rAge, econ.cumulInflation);
    const { payment: mortgagePaymentThisRetYear, row: retMortgageRow } = mortgageYear(false);
    const { payments: retUnsecuredPayments, rows: retDebtRows } = unsecuredDebtsYear();

    // ── Windfalls arriving this retirement year ───────────────────────────
    // Added to the GIA (full amount to cost basis — net-of-tax money has no
    // embedded gain) BEFORE the drawdown steps, so an inheritance can fund
    // the same year's spending and rescue an otherwise-exhausted plan.
    const retWindfall = windfallsAtAge(rAge, econ.cumulInflation);
    const retWindfallAmt = retWindfall?.nominal ?? 0;
    if (retWindfallAmt > 0) investInGIA(P, retWindfallAmt);

    // One-off expenses this retirement year simply raise the year's funding
    // need — the normal five-step drawdown below then finds the cash in the
    // most tax-efficient order, so the expense gets full tax treatment.
    const retExpense = expensesAtAge(rAge, econ.cumulInflation);
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
        class3Cost
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
    const incomeForCGT = round2(guaranteedGross + round2(step1.draw - step1.taxFree));

    // 2. GIA up to the annual CGT exempt amount.
    const step2 = drawGiaWithinExemption(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step2.remaining;

    // 3. ISA.
    const step3 = drawIsa(P, remaining);
    remaining = step3.remaining;

    // 4. GIA beyond the exemption.
    const step4 = drawGiaTaxable(P, remaining, incomeForCGT, retThresholdScale);
    remaining = step4.remaining;

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
    const pensionTaxableIncome = round2(totalPensionDraw - step1.taxFree - step5.taxFree);
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
      retirementAge,
      yrRet.savingsRate,
      yrRet.retirementRate,
      glideBeforeYrs,
      glideAfterYrs
    );
    const growth = growPotsInRetirement(P, retYearRate);

    // ── The rest of the CGT allowance ──────────────────────────────────────
    const gainsHarvested = harvestGainsWithinExemption(
      P,
      round2(Math.max(0, retExemptRemaining - bed.gain))
    );

    // ── Row ────────────────────────────────────────────────────────────────
    const retRow = {
      year,
      age: rAge,
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
    yearlyBreakdown.push(retRow);
  }

  // ── Year loop ─────────────────────────────────────────────────────────────
  // Work until the target retirement age, then (if flexible) keep going while
  // off track, up to the delay cap or the plan horizon. Without a retirement
  // phase the projection ends when work stops; with one, it runs to maxAge.
  let accumulationYears; // working years actually run (set when work stops)
  for (let i = 0; ; i++) {
    const year = currentYear + i;
    const age = currentAge + i;

    // Stop working once at/after the target age and either not flexible, on
    // track, at the delay cap, or at the horizon. The on-track test is only
    // evaluated when flexible (the cap check short-circuits otherwise).
    if (P.retiredAt === null && age >= retirementAge) {
      const cap = flexibleRetirement ? maxRetirementDelayYears : 0;
      const hitCap = age - retirementAge >= cap;
      const atHorizon = retirementOptions != null && age >= (retirementOptions.maxAge ?? Infinity);
      if (
        hitCap ||
        atHorizon ||
        onTrackToRetire(
          age,
          P.pension,
          P.isa,
          P.gia,
          mortgageBalance,
          unsecuredOutstanding(),
          P.niYears,
          econ.cumulInflation
        )
      ) {
        accumulationYears = i;
        if (retirementOptions == null) break;
        startRetirement(age);
      }
    }
    if (P.retiredAt !== null && age > retirement.maxAge) break;

    // This year's rates and running products (i=0 leaves them at 1, matching
    // Math.pow(..., 0)=1).
    const yr = ratesForYear(i);
    const yrTriplelock = Math.max(yr.wageGrowthRate, yr.inflationRate, 0.025);
    if (i > 0) {
      econ.cumulInflation *= 1 + yr.inflationRate;
      econ.thresholdScale *= 1 + yr.inflationRate - fiscalDragRate;
      econ.cumulTriplelock *= 1 + yrTriplelock;
    }
    recordStatePensionClaim(P, age, econ);

    if (P.retiredAt === null) workingYear(i, year, age, yr);
    else retiredYear(year, age, yr);
  }

  // Actual (possibly delayed) retirement age/year resolved by the loop above.
  // Without flexible retirement these equal the target retirementAge.
  const actualRetirementAge = currentAge + accumulationYears;
  const actualRetirementYear = currentYear + accumulationYears;
  const retirementDelayYears = actualRetirementAge - retirementAge;

  // ── Summary ──────────────────────────────────────────────────────────────
  // With a retirement phase, report balances at retirement entry (after PCLS,
  // before drawdown) so headline figures reflect "what you have on day one of
  // retirement" — the end of the projection would give zero whenever pots are
  // depleted by maxAge. Without one, report the end of the working years.
  const sumPension = retEntry !== null ? retEntry.pension : P.pension;
  const sumISA = retEntry !== null ? retEntry.isa : P.isa;
  const sumGIA = retEntry !== null ? retEntry.gia : P.gia;
  const sumCostBasis = retEntry !== null ? retEntry.costBasis : P.costBasis;
  const sumMortgage = retEntry !== null ? retEntry.mortgage : mortgageBalance;
  const sumUnsecured = retEntry !== null ? retEntry.unsecured : round2(unsecuredOutstanding());
  const studentLoanOutstanding = P.studentLoan?.balance ?? 0;
  // Nominal state pension at the age it first becomes payable, triple-lock grown from today.
  // Uses the base-rate triplelock for the summary figure (independent of yearlyRatesOverride).
  const baseTriplelockForSummary = Math.max(wageGrowthRate, inflationRate, 0.025);
  // Qualifying years including any Class 3 years bought in the retirement phase.
  const niYearsWithTopUp = P.niYears + P.class3.yearsBought;
  const projectedStatePension = round2(
    computeStatePension(niYearsWithTopUp) *
      Math.pow(1 + baseTriplelockForSummary, Math.max(0, P.spClaimAge - currentAge)) *
      P.statePensionDeferralUplift
  );
  const totalSavings = round2(sumPension + sumISA + sumGIA);
  const totalDebt = round2(sumMortgage + sumUnsecured + studentLoanOutstanding);

  return {
    startYear: currentYear,
    retirementYear: actualRetirementYear,
    hasRetirementPhase: retirementOptions != null,
    yearlyBreakdown,
    summary: {
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
      niYearsAccrued: P.niYears,
      class3YearsBought: P.class3.yearsBought,
      class3TotalCost: P.class3.totalCost,
      niYearsWithTopUp,
      projectedStatePension,
      statePensionAge: P.statePensionAge,
      statePensionStartAge: P.spClaimAge,
      statePensionEligibleAtRetirement: actualRetirementAge >= P.statePensionAge,
      annuity: P.annuity?.result ?? null,
      // Each DB scheme: when it was (or will be) paid, the yearly pension then
      // and any lump sum, in cash and today's money. startAge is null if the
      // scheme is not paid within the projection.
      dbPensions: dbSchemeSummaries(P),
    },
    taxYear: TAX_YEAR,
  };
}
