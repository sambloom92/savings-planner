/**
 * Life cover sizing for couple mode: the cover gap.
 *
 * The cover gap is the extra lump sum — on top of any life cover and
 * death-in-service already in the plan — that the survivor would need, paid
 * at the death, so that their plan never runs short. Like the annuity sizing,
 * it is found by search: the projection is re-run with a test lump sum at the
 * death (in today's money, paid straight to the survivor's savings) until the
 * smallest amount that removes every shortfall after the death is found.
 *
 * It tells you how much cover you need, not what it would cost: a premium
 * depends on your health, smoking and the insurer, so get a quote.
 */

import { projectLifecycle } from './ukLifecycle.js';

/** Whether a projection runs short in any year after a death. */
function shortAfterDeath(result) {
  return result.yearlyBreakdown.some(
    (row) => (row.shortfall ?? 0) > 0 && row.people?.some((q) => q.status === 'died')
  );
}

/**
 * Cover gap for the death in `profile.death` (couple mode).
 *
 * @param {object} profile - projectLifecycle profile with `partner` and `death`
 * @param {object} rates
 * @param {object} pots
 * @param {object} retirementOptions
 * @param {{ maxCover?: number, precision?: number }} [opts]
 * @returns {{ gap: number|null, fundedWithoutExtra: boolean, exceedsMax: boolean }}
 *   gap: extra cover needed in today's money, rounded up to the nearest £1,000
 *   (0 when the survivor's plan is already fully funded; null when even
 *   `maxCover` isn't enough).
 */
export function solveCoverGap(
  profile,
  rates,
  pots,
  retirementOptions,
  { maxCover = 20_000_000, precision = 500 } = {}
) {
  if (profile?.death == null) throw new RangeError('solveCoverGap needs profile.death');
  const run = (extraCover) =>
    projectLifecycle(
      { ...profile, death: { ...profile.death, extraCover } },
      rates,
      pots,
      retirementOptions
    );
  if (!shortAfterDeath(run(0))) return { gap: 0, fundedWithoutExtra: true, exceedsMax: false };
  let lo = 0;
  let hi = 50_000;
  while (shortAfterDeath(run(hi))) {
    lo = hi;
    hi *= 2;
    if (hi > maxCover) {
      if (shortAfterDeath(run(maxCover)))
        return { gap: null, fundedWithoutExtra: false, exceedsMax: true };
      hi = maxCover;
      break;
    }
  }
  while (hi - lo > precision) {
    const mid = (lo + hi) / 2;
    if (shortAfterDeath(run(mid))) lo = mid;
    else hi = mid;
  }
  return { gap: Math.ceil(hi / 1000) * 1000, fundedWithoutExtra: false, exceedsMax: false };
}
