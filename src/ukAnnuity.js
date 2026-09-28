/**
 * Illustrative UK lifetime annuity rates.
 *
 * A rate is the first year's annual income as a fraction of the purchase price
 * (e.g. 0.071 → £7,100/yr for £100,000). Figures are ILLUSTRATIVE — roughly the
 * UK open market in 2025 for a single-life annuity with no guarantee period and
 * standard health — and exist only as sensible defaults. Real rates move with
 * gilt yields and depend on health, postcode, joint-life and guarantee options,
 * so users are expected to override them with an actual quote.
 *
 * Shape sanity check: a "fair" rate from UK population mortality (ukMortality.js)
 * at a ~4.7% gilt yield (level) or ~1.2% real yield (inflation-linked) runs about
 * 15–25% above these figures. That gap is expected: annuitants outlive the
 * general population and providers take an expense/capital margin. Rates rise
 * with age because the mortality credit (the pooling "bonus" from those who die
 * early) grows as the chance of dying each year rises.
 */

export const ANNUITY_RATE_TABLE = {
  ages: [55, 60, 65, 70, 75, 80, 85],
  // Level: a fixed cash income for life.
  level: [0.056, 0.063, 0.071, 0.08, 0.092, 0.11, 0.13],
  // Inflation-linked (RPI): starts lower, then rises with inflation each year.
  inflationLinked: [0.035, 0.041, 0.049, 0.059, 0.072, 0.089, 0.112],
};

/**
 * Illustrative annuity rate for a purchase at `age`. Linearly interpolated
 * between table ages and clamped to the table's range (55–85).
 *
 * @param {number} age
 * @param {boolean} [inflationLinked=true]
 * @returns {number} annual income as a fraction of the purchase price
 */
export function illustrativeAnnuityRate(age, inflationLinked = true) {
  if (!Number.isFinite(age)) throw new TypeError('age must be a finite number');
  const { ages } = ANNUITY_RATE_TABLE;
  const rates = inflationLinked ? ANNUITY_RATE_TABLE.inflationLinked : ANNUITY_RATE_TABLE.level;
  if (age <= ages[0]) return rates[0];
  if (age >= ages[ages.length - 1]) return rates[rates.length - 1];
  let i = 0;
  while (ages[i + 1] < age) i++;
  const f = (age - ages[i]) / (ages[i + 1] - ages[i]);
  return rates[i] + f * (rates[i + 1] - rates[i]);
}
