/**
 * UK mortality / survival model — used to weight Monte Carlo insolvency by the
 * probability of actually being alive to experience it.
 *
 * Death rates come from the ONS projected cohort life tables for the UK
 * (2024-based, principal projection): qx, the chance of dying between exact
 * ages x and x+1, by sex and year of birth. Cohort rates follow one generation
 * through life, so they include the improvements in mortality ONS projects for
 * the years ahead — unlike period tables, which freeze today's rates. They
 * reproduce ONS's published cohort life expectancies to within 0.02 years.
 *
 * The table (ukMortalityTable.js) covers years of birth 1920–2010 up to age 100;
 * a year of birth outside that range uses the nearest one. Beyond 100 each
 * cohort continues on a Kannisto curve fitted to its rates at 90–100, and
 * survival ends at 120. It is still a population average: it knows sex and year
 * of birth, not individual health, lifestyle or postcode.
 *
 * Regenerate the table with scripts/build_ons_mortality_table.py when ONS
 * publishes a new edition.
 */

import { COHORT_TABLE, ONS_MORTALITY_SOURCE } from './ukMortalityTable.js';

export { ONS_MORTALITY_SOURCE };

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

function assertValidBirthYear(birthYear) {
  if (!Number.isInteger(birthYear)) throw new TypeError('birthYear must be an integer');
}

// The table row for a sex and year of birth (nearest covered year if outside).
function cohortRow(sexKey, birthYear) {
  const { firstBirthYear, lastBirthYear } = COHORT_TABLE;
  const by = Math.min(lastBirthYear, Math.max(firstBirthYear, birthYear));
  return COHORT_TABLE[sexKey][by - firstBirthYear];
}

function qxFor(age, sexKey, birthYear) {
  if (age >= MAX_TABLE_AGE) return 1;
  // Row: [startAge, kannistoLnA, kannistoB, qx per million from startAge to 100].
  const row = cohortRow(sexKey, birthYear);
  const startAge = row[0];
  if (age <= COHORT_TABLE.maxDataAge) {
    // Ages before the table starts are in the past for anyone using the app;
    // fall back to the first tabled rate rather than failing.
    return row[3 + Math.max(0, age - startAge)] / 1_000_000;
  }
  // Kannisto tail: force of mortality μ = a·e^(bx) / (1 + a·e^(bx)).
  const z = Math.exp(row[1] + row[2] * age);
  return 1 - Math.exp(-z / (1 + z));
}

function qxForSex(age, sex, birthYear) {
  if (sex === 'neutral')
    return (qxFor(age, 'male', birthYear) + qxFor(age, 'female', birthYear)) / 2;
  return qxFor(age, sex, birthYear);
}

/**
 * Probability of dying within the year of age `age`, for the given sex and
 * year of birth. 'neutral' is the unweighted mean of the male and female rates.
 *
 * @param {number} age       - Age in whole years (>= 0)
 * @param {'male'|'female'|'neutral'} sex
 * @param {number} birthYear - Calendar year of birth
 * @returns {number} qx in [0, 1]
 */
export function annualMortality(age, sex, birthYear) {
  assertValidAge(age, 'age');
  assertValidSex(sex);
  assertValidBirthYear(birthYear);
  return qxForSex(age, sex, birthYear);
}

/**
 * Probability of surviving from `currentAge` to `targetAge` — the running
 * product of (1 − qx) over the intervening years. Returns 1 when targetAge
 * is at or below currentAge (you are already there).
 *
 * @param {number} currentAge
 * @param {number} targetAge
 * @param {'male'|'female'|'neutral'} sex
 * @param {number} birthYear - Calendar year of birth
 * @returns {number} survival probability in [0, 1]
 */
export function survivalToAge(currentAge, targetAge, sex, birthYear) {
  assertValidAge(currentAge, 'currentAge');
  assertValidAge(targetAge, 'targetAge');
  assertValidSex(sex);
  assertValidBirthYear(birthYear);
  let s = 1;
  for (let age = currentAge; age < targetAge; age++) s *= 1 - qxForSex(age, sex, birthYear);
  return s;
}

/**
 * Survival curve from currentAge to maxAge inclusive: for each age, the
 * probability of still being alive at that age given alive at currentAge.
 * survival at currentAge is 1. Rounded to 4dp for display/serialisation.
 *
 * @param {number} currentAge
 * @param {number} maxAge
 * @param {'male'|'female'|'neutral'} sex
 * @param {number} birthYear - Calendar year of birth
 * @returns {Array<{ age: number, survival: number }>}
 */
export function survivalCurve(currentAge, maxAge, sex, birthYear) {
  assertValidAge(currentAge, 'currentAge');
  assertValidAge(maxAge, 'maxAge');
  assertValidSex(sex);
  assertValidBirthYear(birthYear);
  const out = [];
  let s = 1;
  for (let age = currentAge; age <= maxAge; age++) {
    out.push({ age, survival: round4(s) });
    s *= 1 - qxForSex(age, sex, birthYear);
  }
  return out;
}

/**
 * Cohort life expectancy at `age`: the expected further years of life, with
 * deaths spread evenly through each year of age (the ONS convention).
 *
 * @param {number} age
 * @param {'male'|'female'|'neutral'} sex
 * @param {number} birthYear - Calendar year of birth
 * @returns {number} expected years remaining
 */
export function lifeExpectancy(age, sex, birthYear) {
  assertValidAge(age, 'age');
  assertValidSex(sex);
  assertValidBirthYear(birthYear);
  let alive = 1;
  let years = 0;
  for (let a = age; a < MAX_TABLE_AGE; a++) {
    const next = alive * (1 - qxForSex(a, sex, birthYear));
    years += (alive + next) / 2;
    alive = next;
  }
  return years;
}
