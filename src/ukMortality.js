/**
 * UK mortality / survival model — used to weight Monte Carlo insolvency by the
 * probability of actually being alive to experience it.
 *
 * This is a Gompertz–Makeham approximation to UK period mortality, NOT the exact
 * ONS table. The force of mortality is modelled as:
 *
 *   μ(x) = A + B · e^(g·x)
 *
 * with A a small age-independent background rate (Makeham term) and B·e^(g·x)
 * the exponentially rising Gompertz term. The annual probability of death is
 * qx = 1 − e^(−μ(x)). Parameters are calibrated to well-known UK anchor points
 * (period life tables, England & Wales): roughly qx ≈ 1.4% at 65 and ≈ 16% at 90
 * for males, ≈ 0.9% and ≈ 12% for females.
 *
 * It is deliberately a *rough* population estimate:
 *   • period (not cohort) basis — ignores future mortality improvements, so it
 *     modestly overstates death rates for the young → conservative for solvency
 *   • population average, not individual health, lifestyle or postcode
 *   • single life — no joint/last-survivor modelling
 *
 * To upgrade, replace annualMortality() with a lookup into a full ONS National
 * Life Tables qx array. The rest of the module (survival products) is unchanged.
 *
 * Source anchors: ons.gov.uk — National Life Tables, UK.
 */

// Gompertz–Makeham parameters per sex.
export const MORTALITY_LAW = {
  male: { A: 0.0004, B: 2.1e-5, g: 0.1 },
  female: { A: 0.0003, B: 9.83e-6, g: 0.105 },
};

// Age at (and beyond) which survival is treated as impossible — caps the tables.
const MAX_TABLE_AGE = 120;

export const MORTALITY_SEXES = ['male', 'female', 'neutral'];

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

function assertValidAge(age, name) {
  if (!Number.isInteger(age) || age < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
}

function assertValidSex(sex) {
  if (!MORTALITY_SEXES.includes(sex))
    throw new TypeError(`sex must be one of ${MORTALITY_SEXES.join(', ')}, got "${sex}"`);
}

function qxFor(age, sexKey) {
  if (age >= MAX_TABLE_AGE) return 1;
  const law = MORTALITY_LAW[sexKey];
  return Math.min(1, 1 - Math.exp(-(law.A + law.B * Math.exp(law.g * age))));
}

/**
 * Probability of dying within the year of age `age`, for the given sex.
 * 'neutral' is the unweighted mean of the male and female rates.
 *
 * @param {number} age  - Age in whole years (>= 0)
 * @param {'male'|'female'|'neutral'} [sex='neutral']
 * @returns {number} qx in [0, 1]
 */
export function annualMortality(age, sex = 'neutral') {
  assertValidAge(age, 'age');
  assertValidSex(sex);
  if (sex === 'neutral') return (qxFor(age, 'male') + qxFor(age, 'female')) / 2;
  return qxFor(age, sex);
}

/**
 * Probability of surviving from `currentAge` to `targetAge` — the running
 * product of (1 − qx) over the intervening years. Returns 1 when targetAge
 * is at or below currentAge (you are already there).
 *
 * @param {number} currentAge
 * @param {number} targetAge
 * @param {'male'|'female'|'neutral'} [sex='neutral']
 * @returns {number} survival probability in [0, 1]
 */
export function survivalToAge(currentAge, targetAge, sex = 'neutral') {
  assertValidAge(currentAge, 'currentAge');
  assertValidAge(targetAge, 'targetAge');
  assertValidSex(sex);
  if (targetAge <= currentAge) return 1;
  let s = 1;
  for (let age = currentAge; age < targetAge; age++) {
    if (sex === 'neutral') {
      s *= 1 - (qxFor(age, 'male') + qxFor(age, 'female')) / 2;
    } else {
      s *= 1 - qxFor(age, sex);
    }
  }
  return s;
}

/**
 * Survival curve from currentAge to maxAge inclusive: for each age, the
 * probability of still being alive at that age given alive at currentAge.
 * survival at currentAge is 1. Rounded to 4dp for display/serialisation.
 *
 * @param {number} currentAge
 * @param {number} maxAge
 * @param {'male'|'female'|'neutral'} [sex='neutral']
 * @returns {Array<{ age: number, survival: number }>}
 */
export function survivalCurve(currentAge, maxAge, sex = 'neutral') {
  assertValidAge(currentAge, 'currentAge');
  assertValidAge(maxAge, 'maxAge');
  assertValidSex(sex);
  const out = [];
  let s = 1;
  for (let age = currentAge; age <= maxAge; age++) {
    out.push({ age, survival: round4(s) });
    if (sex === 'neutral') {
      s *= 1 - (qxFor(age, 'male') + qxFor(age, 'female')) / 2;
    } else {
      s *= 1 - qxFor(age, sex);
    }
  }
  return out;
}
