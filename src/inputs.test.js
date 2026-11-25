import assert from 'node:assert/strict';
import {
  DB_NEW_SCHEME,
  DEFAULTS,
  LIFE_POLICY_NEW,
  PARTNER_DEFAULTS,
  PERSON_KEYS,
  SCHEMA,
  SCHEMA_VERSION,
  inputsFromJson,
  inputsToJson,
} from './inputs.js';

let passed = 0;
let failed = 0;
function it(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// A couple's plan with every kind of input set away from its default.
const plan = {
  ...DEFAULTS,
  householdMode: 'couple',
  currentAge: 41,
  grossIncome: 72_000,
  employerMatch: true,
  employeePensionAuto: true,
  takePCLS: false,
  statePensionAgeOverride: 66,
  employmentChanges: [{ age: 55, fraction: 0.6, label: 'Part-time', enabled: true }],
  dbPensions: [{ ...DB_NEW_SCHEME, label: 'NHS', survivorUnmarried: 'no', paymentAge: 65 }],
  windfalls: [{ age: 50, amount: 20_000, label: 'Inheritance', enabled: false }],
  oneOffExpenses: [{ age: 45, amount: 8_000, label: 'Car', enabled: true }],
  mortgageRateType: 'boe',
  unsecuredRateType: 'boe',
  annuityEnabled: true,
  annuityOwner: 'partner',
  annuitySizing: 'fixed',
  annuityRatePct: 6.2,
  partnership: 'cohabiting',
  willsToEachOther: false,
  spendingWhileOneWorks: 'working',
  spendingGuardrails: true,
  flexibleRetirement: true,
  lifePolicies: [{ ...LIFE_POLICY_NEW, label: 'Term', lifeOf: 'self', inTrust: false }],
  deathScenario: { enabled: true, person: 'self', age: 70 },
  partner: {
    ...PARTNER_DEFAULTS,
    currentAge: 39,
    grossIncome: 41_000,
    sex: 'female',
    takePCLS: true,
    deathInServiceMultiple: 4,
    studentLoanPlan: 'plan2',
    studentLoanBalance: 18_000,
    studentLoanYears: 6,
  },
};

console.log('\nSaved JSON (schema version 2)');

it('the defaults survive saving and loading unchanged', () => {
  assert.deepEqual(inputsFromJson(inputsToJson(DEFAULTS)), DEFAULTS);
});

it('a full couple plan survives saving and loading unchanged', () => {
  assert.deepEqual(inputsFromJson(inputsToJson(plan)), plan);
  // And through text, as localStorage and the clipboard hold it.
  assert.deepEqual(inputsFromJson(JSON.parse(JSON.stringify(inputsToJson(plan)))), plan);
});

it('every input is saved, and each has one place', () => {
  const personKeys = SCHEMA.person.map(([, key]) => key);
  const sharedKeys = SCHEMA.shared.map(([, key]) => key);
  const all = [...personKeys, ...sharedKeys];
  assert.equal(new Set(all).size, all.length, 'an input appears twice');
  const paths = [...SCHEMA.person.map(([p]) => `you.${p}`), ...SCHEMA.shared.map(([p]) => p)];
  assert.equal(new Set(paths).size, paths.length, 'a path appears twice');
  // statePensionAge is worked out from the override and the law, so isn't saved.
  const derived = new Set(['statePensionAge', 'partner']);
  for (const key of Object.keys(DEFAULTS)) {
    if (derived.has(key)) continue;
    assert.ok(all.includes(key), `${key} isn't in the schema`);
  }
  for (const key of PERSON_KEYS) {
    if (derived.has(key)) continue;
    assert.ok(personKeys.includes(key), `${key} isn't a person field`);
  }
  for (const key of Object.keys(PARTNER_DEFAULTS)) {
    if (derived.has(key)) continue;
    assert.ok(personKeys.includes(key), `partner ${key} isn't a person field`);
  }
  const itemKeys = (fields) => fields.map(([, key]) => key);
  for (const key of Object.keys(DB_NEW_SCHEME))
    assert.ok(itemKeys(SCHEMA.items.db).includes(key), `DB scheme ${key} isn't saved`);
  for (const key of Object.keys(LIFE_POLICY_NEW))
    assert.ok(itemKeys(SCHEMA.items.life).includes(key), `life cover ${key} isn't saved`);
});

it('follows the layout of the settings', () => {
  const json = inputsToJson(plan);
  assert.deepEqual(Object.keys(json), [
    'schemaVersion',
    'planFor',
    'you',
    'partner',
    'household',
    'assumptions',
    'whatIfOneOfUsDies',
  ]);
  assert.equal(json.schemaVersion, SCHEMA_VERSION);
  for (const who of ['you', 'partner'])
    assert.deepEqual(Object.keys(json[who]), ['personal', 'pension', 'statePension', 'savings']);
  assert.deepEqual(Object.keys(json.household), [
    'spending',
    'homeAndDebts',
    'events',
    'retirement',
    'couple',
    'protection',
  ]);
  assert.deepEqual(Object.keys(json.assumptions), ['economy', 'investments', 'monteCarlo']);
});

it('writes choices as the words the settings use', () => {
  const json = inputsToJson(plan);
  assert.equal(json.planFor, 'withPartner');
  assert.equal(json.you.personal.salary, 72_000);
  assert.equal(json.you.pension.employerContribution, 'matched');
  assert.equal(json.you.pension.yourContribution, 'auto');
  assert.equal(json.you.pension.taxFreeLumpSum, false);
  assert.equal(json.partner.pension.taxFreeLumpSum, true);
  assert.equal(json.you.statePension.age, 66);
  assert.deepEqual(json.you.personal.hoursChanges, [
    { label: 'Part-time', age: 55, hoursPct: 60, on: true },
  ]);
  assert.equal(json.you.pension.definedBenefitSchemes[0].paidToUnmarriedPartner, false);
  assert.equal(json.you.pension.definedBenefitSchemes[0].takeItFromAge, 65);
  assert.deepEqual(json.partner.savings.studentLoan, {
    plan: 'plan2',
    balance: 18_000,
    yearsRepaying: 6,
  });
  assert.equal(json.partner.personal.deathInServiceTimesSalary, 4);
  assert.equal(json.household.homeAndDebts.mortgage.rate, 'tracksBaseRate');
  assert.equal(json.household.spending.whileOneOfYouWorks, 'livingCosts');
  assert.equal(json.household.retirement.annuity.boughtFrom, 'partner');
  assert.equal(json.household.retirement.annuity.sizeTo, 'fixedIncome');
  assert.equal(json.household.couple.partnership, 'livingTogether');
  assert.equal(json.household.protection.lifeCover[0].covers, 'you');
  assert.equal(json.household.events.windfalls[0].on, false);
  assert.deepEqual(json.whatIfOneOfUsDies, { on: true, whoDies: 'you', atAge: 70 });
});

it('saves nothing but the schema’s own names', () => {
  // Inputs left over from old versions aren't carried into the new JSON.
  const json = inputsToJson({ ...plan, annualSavings: 36_000, pclsPct: 25 });
  const text = JSON.stringify(json);
  for (const old of ['annualSavings', 'pclsPct', 'grossIncome', 'takePCLS', 'mcTrials'])
    assert.ok(!text.includes(old), `${old} leaked into the JSON`);
});

it('fills anything missing with its default', () => {
  const p = inputsFromJson({ schemaVersion: 2, you: { personal: { salary: 50_000 } } });
  assert.equal(p.grossIncome, 50_000);
  assert.deepEqual({ ...p, grossIncome: DEFAULTS.grossIncome }, DEFAULTS);
});

it('loads JSON saved by earlier versions', () => {
  const legacy = {
    currentAge: 34,
    grossIncome: 90_000,
    statePensionAge: 67,
    takePCLS: false,
    spendingFloor: 22_000,
    householdMode: 'couple',
    annualSavings: 36_000,
    partner: { currentAge: 32, grossIncome: 50_000, statePensionAge: 66 },
  };
  const p = inputsFromJson(legacy);
  assert.equal(p.grossIncome, 90_000);
  assert.equal(p.householdMode, 'couple');
  // The old single lump sum choice now belongs to each of you.
  assert.equal(p.takePCLS, false);
  assert.equal(p.partner.takePCLS, false);
  // A saved 67 was the old default, so the legal age applies; 66 was chosen.
  assert.equal(p.statePensionAgeOverride, null);
  assert.equal(p.partner.statePensionAgeOverride, 66);
  assert.equal(p.essentialExpenses, 22_000);
  assert.equal(p.partner.isaBalance, PARTNER_DEFAULTS.isaBalance);
});

it('refuses JSON from a newer version, or that isn’t a plan', () => {
  assert.throws(() => inputsFromJson({ schemaVersion: SCHEMA_VERSION + 1 }), RangeError);
  assert.throws(() => inputsFromJson([1, 2]), TypeError);
  assert.throws(() => inputsFromJson(null), TypeError);
});

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exitCode = 1;
}
