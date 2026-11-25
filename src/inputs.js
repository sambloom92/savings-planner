/**
 * The app's inputs: their defaults, and how they are saved and loaded.
 *
 * In the app the inputs are one flat object (`p`): the shared ones, your own
 * and, under `partner`, your partner's (PERSON_KEYS). Saved and copied JSON
 * uses the layout of the settings instead — `you`, `partner`, `household` and
 * `assumptions`, then each tab — with names that follow the labels (schema
 * version 2; SCHEMA below). JSON saved by earlier versions is the flat object
 * itself, and still loads.
 */

// ── Couple mode ───────────────────────────────────────────────────────────────
// The inputs that belong to one person. In couple mode the partner has their
// own copy (p.partner); everything else is shared by the household.
export const PERSON_KEYS = new Set([
  'currentAge',
  'retirementAge',
  'grossIncome',
  'niContributionYears',
  'statePensionAge',
  'statePensionAgeOverride',
  'statePensionDeferralYears',
  'topUpStatePension',
  'pensionAccessAge',
  'sex',
  'employmentChanges',
  'employeePensionPct',
  'employeePensionAuto',
  'employerPensionPct',
  'employerMatch',
  'employerMatchThreshold',
  'pensionBalance',
  'dbPensions',
  'isaBalance',
  'giaBalance',
  'giaCostBasis',
  'studentLoanPlan',
  'studentLoanBalance',
  'studentLoanYears',
  'deathInServiceMultiple',
  'takePCLS',
]);

export const PARTNER_DEFAULTS = {
  currentAge: 28,
  retirementAge: 65,
  grossIncome: 35_000,
  niContributionYears: 3,
  statePensionAge: 67, // set from the legal age unless overridden (see below)
  statePensionAgeOverride: null,
  statePensionDeferralYears: 0,
  topUpStatePension: false,
  pensionAccessAge: 57,
  sex: 'neutral',
  employmentChanges: [],
  employeePensionPct: 5,
  employeePensionAuto: false,
  employerPensionPct: 3,
  employerMatch: false,
  employerMatchThreshold: 5,
  pensionBalance: 10_000,
  dbPensions: [],
  isaBalance: 5_000,
  giaBalance: 0,
  giaCostBasis: 0,
  studentLoanPlan: '',
  studentLoanBalance: 0,
  studentLoanYears: 0,
  deathInServiceMultiple: 0,
  takePCLS: true,
};

export const DEFAULTS = {
  currentAge: 28,
  retirementAge: 65,
  grossIncome: 45_000,
  annualLivingExpenses: 20_000,
  niContributionYears: 3,
  // State pension age: the legal age for your year of birth (from your current
  // age), unless you choose one (statePensionAgeOverride). statePensionAge
  // always holds the age in use.
  statePensionAge: 67,
  statePensionAgeOverride: null,
  statePensionDeferralYears: 0,
  topUpStatePension: false, // auto-buy voluntary Class 3 NI years to reach the full 35
  pensionAccessAge: 57, // NMPA — earliest age the DC pension can be accessed
  sex: 'neutral', // mortality basis for the lifetime-solvency metric
  windfalls: [],
  oneOffExpenses: [],
  employmentChanges: [],
  employeePensionPct: 5,
  employeePensionAuto: false, // when true, employee % is solved for tax-optimality
  employerPensionPct: 3,
  employerMatch: false, // when true, employer pays its rate only if employee ≥ threshold
  employerMatchThreshold: 5, // employee % required to earn the full employer contribution
  pensionBalance: 10_000,
  // Defined benefit schemes (see DB_NEW_SCHEME for the fields of each).
  dbPensions: [],
  equityReturnPct: 7,
  bondReturnPct: 3,
  preRetirementEquityPct: 80,
  postRetirementEquityPct: 40,
  glideStartYears: 10,
  glideEndYears: 5,
  isaBalance: 5_000,
  giaBalance: 0,
  giaCostBasis: 0,
  mortgageBalance: 200_000,
  mortgageTermYears: 25,
  mortgageType: 'repayment',
  mortgageOverpayment: 0,
  mortgageStartAge: 28, // clamped to ≥ currentAge by the engine; = "already started"
  unsecuredBalance: 5_000,
  unsecuredMonthly: 200,
  studentLoanPlan: '',
  studentLoanBalance: 0,
  studentLoanYears: 0,
  wageGrowthPct: 3,
  mortgageRateType: 'fixed', // 'fixed' or 'boe'
  mortgageRatePct: 4.5,
  mortgageSpreadPct: 1.5,
  unsecuredRateType: 'fixed', // 'fixed' or 'boe'
  unsecuredRatePct: 10.0,
  unsecuredSpreadPct: 15.0,
  boePct: 3.75, // Bank Rate, September 2026 (bankofengland.co.uk)
  inflationPct: 2.5,
  fiscalDragPct: 0,
  // Retirement
  maxAge: 90,
  targetNetExpenses: 30_000,
  // Essential (non-negotiable) net spending, today's money — shared by the
  // guardrails floor and the annuity's "cover essential spending" sizing.
  essentialExpenses: 20_000,
  takePCLS: true,
  // Lifetime annuity: one purchase, sized by an income target in today's money.
  // Applies to both the deterministic projection and Monte Carlo.
  annuityEnabled: false,
  annuityPurchaseAge: 75,
  annuitySizing: 'essential', // 'essential' (cover essentials) | 'fixed' (set income)
  annuityIncome: 10_000, // 'fixed' sizing: gross annual income, today's money
  annuityInflationLinked: true,
  annuityRatePct: null, // your quote (%); null → illustrative rate for the age and type
  // Monte Carlo settings
  mcTrials: 200,
  mcVolatility: 1.0,
  mcBearFreq: 12,
  mcBearSeverity: 0.15,
  mcCrisisPersistence: 0.6,
  // Flexible retirement (Monte Carlo only): postpone retirement in trials that
  // are clearly off track at the target age, up to the cap, before retiring.
  flexibleRetirement: false,
  maxRetirementDelayYears: 3,
  // Spending guardrails (Monte Carlo only): flex retirement spending toward the
  // sustainable level within a floor (essential expenses, above) and ceiling (%
  // of target; 100 = recovery-only). Sensitivity picks the drift band + step size.
  spendingGuardrails: false,
  spendingCeilingPct: 100,
  guardrailSensitivity: 'standard', // 'gentle' | 'standard' | 'responsive'
  // Couple mode: plan for two. The partner's own inputs live in `partner`.
  householdMode: 'single', // 'single' | 'couple'
  partner: PARTNER_DEFAULTS,
  partnership: 'married', // 'married' (also civil partners) | 'cohabiting'
  willsToEachOther: true, // cohabiting only
  // Household spending after a death, % of the couple's (Retirement Living
  // Standards 2026: a one-person budget is 72% of a two-person one).
  survivorSpendingPct: 72,
  // Couple mode, "Just me" view: your share of the mortgage, other debts and
  // one-off events if you were on your own.
  yourSharePct: 50,
  // Household spending while one of you has retired and the other works:
  // 'working' (living costs), 'halfway' or 'retirement' (the retirement target).
  spendingWhileOneWorks: 'halfway',
  annuityOwner: 'self', // whose pension buys the annuity
  // "What if one of us dies?" on the deterministic chart.
  deathScenario: { enabled: false, person: 'partner', age: 80 },
  // Protection (couple mode): death-in-service (× salary, per person) and
  // life cover policies (see LIFE_POLICY_NEW).
  deathInServiceMultiple: 0,
  lifePolicies: [],
};

// A new life cover policy in the Protection tab.
export const LIFE_POLICY_NEW = {
  label: '',
  enabled: true,
  type: 'level', // 'level' | 'decreasing' | 'wholeOfLife'
  lifeOf: 'self', // 'self' | 'partner' | 'joint' (pays on the first death)
  sumAssured: 250_000,
  termYears: 25,
  monthlyPremium: 25,
  inTrust: true,
  payTo: 'savings', // 'savings' | 'mortgage'
};

// ── Defined benefit schemes ──────────────────────────────────────────────────
// A new scheme card's starting values (UI form; buildDbPensions converts).
export const DB_NEW_SCHEME = {
  label: '',
  enabled: true,
  status: 'active',
  pension: 5_000,
  accrualDenominator: 54,
  memberContributionPct: 8,
  inServiceRevaluation: 'cpi+1.5',
  normalPensionAge: 67,
  paymentAge: 67,
  earlyReductionPct: 5,
  lateIncreasePct: 5,
  deferredIncreases: 'cpi',
  paymentIncreases: 'cpi',
  lumpSum: 'none',
  commutationFactor: 12,
  automaticLumpSum: 0,
  // Couple mode: survivor's pension on the member's death.
  survivorPensionPct: 50,
  survivorUnmarried: 'yes',
};

// Bring saved or pasted inputs up to date. The guardrails floor used to be its
// own input (spendingFloor); it is now the shared essential-expenses figure.
// Inputs saved before the state pension age followed the law: a saved 67 (the
// old default) becomes "use the legal age"; anything else was chosen.
const spaOverrideFrom = (v) =>
  v.statePensionAgeOverride !== undefined
    ? v.statePensionAgeOverride
    : v.statePensionAge == null || v.statePensionAge === 67
      ? null
      : v.statePensionAge;

export function migrateInputs(saved) {
  const next = { ...saved };
  next.statePensionAgeOverride = spaOverrideFrom(saved);
  if (next.essentialExpenses == null && next.spendingFloor != null) {
    next.essentialExpenses = next.spendingFloor;
  }
  delete next.spendingFloor;
  // Couple mode: fill in any partner fields added since the inputs were saved.
  // The tax-free lump sum used to be one choice for both of you.
  const partnerLumpSum = saved.partner?.takePCLS ?? saved.takePCLS ?? PARTNER_DEFAULTS.takePCLS;
  next.partner = { ...PARTNER_DEFAULTS, ...(next.partner ?? {}), takePCLS: partnerLumpSum };
  next.partner.statePensionAgeOverride = spaOverrideFrom(saved.partner ?? {});
  next.deathScenario = { ...DEFAULTS.deathScenario, ...(next.deathScenario ?? {}) };
  return next;
}

// ── Saved JSON (schema version 2) ─────────────────────────────────────────────
// Each entry: the JSON path, the input it holds, and how its values are
// written (`out`) and read (`in`) where they differ. Person fields appear under
// both `you` and `partner`. Lists name their items' fields the same way.

export const SCHEMA_VERSION = 2;

const same = { out: (v) => v, in: (v) => v };
// Values renamed one to one; unknown values pass through unchanged.
const renamed = (map) => {
  const back = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  return { out: (v) => map[v] ?? v, in: (v) => back[v] ?? v };
};
// A true/false input written as one of two words.
const choice = (ifTrue, ifFalse) => ({
  out: (v) => (v ? ifTrue : ifFalse),
  in: (v) => (typeof v === 'boolean' ? v : v === ifTrue),
});
// A list whose items' fields are named by `fields` ([json, input, codec?]).
const list = (fields) => ({
  out: (items) => (items ?? []).map((item) => writeFields(item, fields)),
  in: (items) =>
    Array.isArray(items) ? items.map((item) => readFields(item ?? {}, fields)) : items,
});

const ON = ['on', 'enabled'];
const EVENT_FIELDS = [['label', 'label'], ['age', 'age'], ['amount', 'amount'], ON];
const HOURS_FIELDS = [
  ['label', 'label'],
  ['age', 'age'],
  // Stored as a fraction of full hours; written as a percentage.
  ['hoursPct', 'fraction', { out: (f) => Math.round(f * 10_000) / 100, in: (pct) => pct / 100 }],
  ON,
];
const DB_FIELDS = [
  ['label', 'label'],
  ON,
  ['status', 'status'],
  ['pension', 'pension'],
  ['buildUpRateOneIn', 'accrualDenominator'],
  ['yourContributionPct', 'memberContributionPct'],
  ['growthWhileBuildingUp', 'inServiceRevaluation'],
  ['normalPensionAge', 'normalPensionAge'],
  ['takeItFromAge', 'paymentAge'],
  ['reductionPerYearEarlyPct', 'earlyReductionPct'],
  ['increasePerYearLatePct', 'lateIncreasePct'],
  ['increasesBeforePaid', 'deferredIncreases'],
  ['increasesOncePaid', 'paymentIncreases'],
  ['taxFreeCash', 'lumpSum'],
  ['commutationFactor', 'commutationFactor'],
  ['automaticLumpSum', 'automaticLumpSum'],
  ['survivorsPensionPct', 'survivorPensionPct'],
  // Stored as 'yes' / 'no'; written as true / false.
  [
    'paidToUnmarriedPartner',
    'survivorUnmarried',
    { out: (v) => v !== 'no', in: (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : v) },
  ],
];
const LIFE_FIELDS = [
  ['label', 'label'],
  ON,
  ['type', 'type'],
  ['covers', 'lifeOf', renamed({ self: 'you' })],
  ['sumAssured', 'sumAssured'],
  ['termRemainingYears', 'termYears'],
  ['monthlyPremium', 'monthlyPremium'],
  ['writtenInTrust', 'inTrust'],
  ['paysTowards', 'payTo'],
];

const PERSON_FIELDS = [
  ['personal.currentAge', 'currentAge'],
  ['personal.sex', 'sex'],
  ['personal.retirementAge', 'retirementAge'],
  ['personal.salary', 'grossIncome'],
  ['personal.hoursChanges', 'employmentChanges', list(HOURS_FIELDS)],
  ['personal.deathInServiceTimesSalary', 'deathInServiceMultiple'],
  ['pension.employerContribution', 'employerMatch', choice('matched', 'fixed')],
  ['pension.employerContributionPct', 'employerPensionPct'],
  ['pension.yourContributionToGetMatchPct', 'employerMatchThreshold'],
  ['pension.yourContribution', 'employeePensionAuto', choice('auto', 'manual')],
  ['pension.yourContributionPct', 'employeePensionPct'],
  ['pension.pot', 'pensionBalance'],
  ['pension.accessAge', 'pensionAccessAge'],
  ['pension.taxFreeLumpSum', 'takePCLS'],
  ['pension.definedBenefitSchemes', 'dbPensions', list(DB_FIELDS)],
  ['statePension.niYearsSoFar', 'niContributionYears'],
  // null: the age set by law for your year of birth.
  ['statePension.age', 'statePensionAgeOverride'],
  ['statePension.deferYears', 'statePensionDeferralYears'],
  ['statePension.topUpWithClass3', 'topUpStatePension'],
  ['savings.isa', 'isaBalance'],
  ['savings.gia', 'giaBalance'],
  ['savings.giaAmountInvested', 'giaCostBasis'],
  ['savings.studentLoan.plan', 'studentLoanPlan'],
  ['savings.studentLoan.balance', 'studentLoanBalance'],
  ['savings.studentLoan.yearsRepaying', 'studentLoanYears'],
];

const RATE_TYPE = renamed({ boe: 'tracksBaseRate' });
const SHARED_FIELDS = [
  ['planFor', 'householdMode', renamed({ single: 'onMyOwn', couple: 'withPartner' })],
  ['household.spending.livingCostsWhileWorking', 'annualLivingExpenses'],
  ['household.spending.retirementSpending', 'targetNetExpenses'],
  ['household.spending.essentialSpending', 'essentialExpenses'],
  [
    'household.spending.whileOneOfYouWorks',
    'spendingWhileOneWorks',
    renamed({ working: 'livingCosts', retirement: 'retirementSpending' }),
  ],
  ['household.spending.guardrails.on', 'spendingGuardrails'],
  ['household.spending.guardrails.ceilingPct', 'spendingCeilingPct'],
  ['household.spending.guardrails.sensitivity', 'guardrailSensitivity'],
  ['household.homeAndDebts.mortgage.balance', 'mortgageBalance'],
  ['household.homeAndDebts.mortgage.remainingTermYears', 'mortgageTermYears'],
  ['household.homeAndDebts.mortgage.startAge', 'mortgageStartAge'],
  ['household.homeAndDebts.mortgage.type', 'mortgageType'],
  ['household.homeAndDebts.mortgage.monthlyOverpayment', 'mortgageOverpayment'],
  ['household.homeAndDebts.mortgage.rate', 'mortgageRateType', RATE_TYPE],
  ['household.homeAndDebts.mortgage.ratePct', 'mortgageRatePct'],
  ['household.homeAndDebts.mortgage.spreadAboveBaseRatePct', 'mortgageSpreadPct'],
  ['household.homeAndDebts.otherDebts.balance', 'unsecuredBalance'],
  ['household.homeAndDebts.otherDebts.monthlyPayment', 'unsecuredMonthly'],
  ['household.homeAndDebts.otherDebts.rate', 'unsecuredRateType', RATE_TYPE],
  ['household.homeAndDebts.otherDebts.ratePct', 'unsecuredRatePct'],
  ['household.homeAndDebts.otherDebts.spreadAboveBaseRatePct', 'unsecuredSpreadPct'],
  ['household.events.windfalls', 'windfalls', list(EVENT_FIELDS)],
  ['household.events.oneOffExpenses', 'oneOffExpenses', list(EVENT_FIELDS)],
  ['household.retirement.planUntilAge', 'maxAge'],
  ['household.retirement.annuity.on', 'annuityEnabled'],
  ['household.retirement.annuity.boughtFrom', 'annuityOwner', renamed({ self: 'you' })],
  ['household.retirement.annuity.buyAtAge', 'annuityPurchaseAge'],
  [
    'household.retirement.annuity.sizeTo',
    'annuitySizing',
    renamed({ essential: 'essentialSpending', fixed: 'fixedIncome' }),
  ],
  ['household.retirement.annuity.income', 'annuityIncome'],
  ['household.retirement.annuity.inflationLinked', 'annuityInflationLinked'],
  ['household.retirement.annuity.ratePct', 'annuityRatePct'],
  ['household.retirement.workLongerIfOffTrack.on', 'flexibleRetirement'],
  ['household.retirement.workLongerIfOffTrack.maxYears', 'maxRetirementDelayYears'],
  ['household.couple.partnership', 'partnership', renamed({ cohabiting: 'livingTogether' })],
  ['household.couple.willsLeaveSavingsToEachOther', 'willsToEachOther'],
  ['household.couple.spendingOnYourOwnPct', 'survivorSpendingPct'],
  ['household.couple.yourShareOfJointDebtsAndEventsPct', 'yourSharePct'],
  ['household.protection.lifeCover', 'lifePolicies', list(LIFE_FIELDS)],
  ['assumptions.economy.inflationPct', 'inflationPct'],
  ['assumptions.economy.wageGrowthPct', 'wageGrowthPct'],
  ['assumptions.economy.baseRatePct', 'boePct'],
  ['assumptions.economy.taxThresholdsLagInflationPct', 'fiscalDragPct'],
  ['assumptions.investments.equityReturnPct', 'equityReturnPct'],
  ['assumptions.investments.bondReturnPct', 'bondReturnPct'],
  ['assumptions.investments.equityBeforeRetirementPct', 'preRetirementEquityPct'],
  ['assumptions.investments.equityAfterRetirementPct', 'postRetirementEquityPct'],
  ['assumptions.investments.glidePath.startYearsBefore', 'glideStartYears'],
  ['assumptions.investments.glidePath.endYearsAfter', 'glideEndYears'],
  ['assumptions.monteCarlo.trials', 'mcTrials'],
  ['assumptions.monteCarlo.volatility', 'mcVolatility'],
  ['assumptions.monteCarlo.bearMarketEveryYears', 'mcBearFreq'],
  ['assumptions.monteCarlo.bearMarketSeverity', 'mcBearSeverity'],
  ['assumptions.monteCarlo.crisisPersistence', 'mcCrisisPersistence'],
  [
    'whatIfOneOfUsDies',
    'deathScenario',
    {
      out: (d) => ({
        on: d.enabled,
        whoDies: d.person === 'self' ? 'you' : d.person,
        atAge: d.age,
      }),
      in: (d) =>
        d && typeof d === 'object'
          ? { enabled: d.on, person: d.whoDies === 'you' ? 'self' : d.whoDies, age: d.atAge }
          : d,
    },
  ],
];

/** The JSON paths and the inputs they hold: [path, key, codec] (for tests and docs). */
export const SCHEMA = {
  person: PERSON_FIELDS.map(([path, key, codec = same]) => [path, key, codec]),
  shared: SHARED_FIELDS.map(([path, key, codec = same]) => [path, key, codec]),
  items: { event: EVENT_FIELDS, hours: HOURS_FIELDS, db: DB_FIELDS, life: LIFE_FIELDS },
};

function setPath(obj, path, value) {
  const keys = path.split('.');
  let at = obj;
  for (const k of keys.slice(0, -1)) at = at[k] ??= {};
  at[keys.at(-1)] = value;
}
function getPath(obj, path) {
  let at = obj;
  for (const k of path.split('.')) {
    if (at == null || typeof at !== 'object' || !(k in at)) return undefined;
    at = at[k];
  }
  return at;
}

function writeFields(source, fields) {
  const out = {};
  for (const [path, key, codec = same] of fields) {
    if (source[key] !== undefined) setPath(out, path, codec.out(source[key]));
  }
  return out;
}
function readFields(json, fields) {
  const out = {};
  for (const [path, key, codec = same] of fields) {
    const v = getPath(json, path);
    if (v !== undefined) out[key] = codec.in(v);
  }
  return out;
}

/** The inputs as saved JSON (schema version 2). */
export function inputsToJson(p) {
  const shared = writeFields(p, SHARED_FIELDS);
  return {
    schemaVersion: SCHEMA_VERSION,
    planFor: shared.planFor,
    you: writeFields(p, PERSON_FIELDS),
    partner: writeFields(p.partner ?? {}, PERSON_FIELDS),
    household: shared.household,
    assumptions: shared.assumptions,
    whatIfOneOfUsDies: shared.whatIfOneOfUsDies,
  };
}

/**
 * The inputs from saved or pasted JSON: schema version 2, or the flat object
 * earlier versions saved. Missing inputs take their defaults.
 */
export function inputsFromJson(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json))
    throw new TypeError('Not a saved plan');
  let flat = json;
  if (json.schemaVersion != null) {
    if (json.schemaVersion > SCHEMA_VERSION)
      throw new RangeError('This plan was saved by a newer version of the planner');
    flat = {
      ...readFields(json, SHARED_FIELDS),
      ...readFields(json.you ?? {}, PERSON_FIELDS),
      partner: readFields(json.partner ?? {}, PERSON_FIELDS),
    };
  }
  return { ...DEFAULTS, ...migrateInputs(flat) };
}
