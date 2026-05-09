/**
 * Monte Carlo simulation — year-by-year stochastic rates with economic cycles.
 *
 * For each trial:
 *   1. Draw a random initial cycle phase φ₀ ~ Uniform(0, 2π)
 *   2. For each year t, advance the phase:
 *        φ_t = φ_{t-1} + ω₀ + ε_t
 *        ω₀ = 2π / cyclePeriod   (nominal angular frequency)
 *        ε_t ~ N(0, σ_phase²)   (phase noise — controls regularity)
 *        σ_phase = (1 - cycleRegularity) * 2 * ω₀
 *   3. Cycle effect:  cycle_t = sin(φ_t) * cycleSeverity
 *   4. Annual i.i.d. noise:
 *        z1_t ~ N(0, σ_mkt²)   → market rates
 *        z2_t ~ N(0, σ_mac²)   → macro rates
 *   5. Year t rates:
 *        savingsRate_t    = max(0, base + cycle_t * 0.08 + z1 * σ_mkt)
 *        retirementRate_t = max(0, base + cycle_t * 0.06 + z1 * σ_mkt * 0.75)
 *        inflationRate_t  = max(0, base - cycle_t * 0.01 + z2 * σ_mac)
 *        boeRate_t        = max(0, base - cycle_t * 0.01 + z2 * σ_mac)
 *        wageGrowthRate_t = base + cycle_t * 0.02 + z2 * σ_mac * 0.5
 *   6. Pass the full per-year array as yearlyRatesOverride to projectLifecycle
 *
 * σ_mkt = volatility * 0.08  (annual market vol, ~8pp 1-sd per year)
 * σ_mac = volatility * 0.008 (annual macro vol, ~0.8pp 1-sd per year)
 */

import { projectLifecycle } from './ukLifecycle.js';

function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNorm(rand) {
  let u;
  do {
    u = rand();
  } while (u === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function pctile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function rowPortfolio(row) {
  return Math.max(
    0,
    (row.pension?.closingBalance ?? 0) +
      (row.isa?.closingBalance ?? 0) +
      (row.gia?.closingBalance ?? 0)
  );
}

export function runMonteCarlo(profile, baseRates, pots, retirementOpts, opts = {}) {
  const {
    trials = 200,
    volatility = 1.0,
    seed = 0xdeadbeef,
    cyclePeriod = 7,
    cycleSeverity = 1.0,
    cycleRegularity = 0.5,
  } = opts;

  const σ_mkt = volatility * 0.08;
  const σ_mac = volatility * 0.008;
  const ω0 = (2 * Math.PI) / Math.max(1, cyclePeriod);
  const σ_phase = (1 - Math.max(0, Math.min(1, cycleRegularity))) * 2 * ω0;

  const totalYears = retirementOpts.maxAge - profile.currentAge + 1;
  const rand = makePRNG(seed);
  const successful = [];

  for (let t = 0; t < trials; t++) {
    // Random initial phase so trials don't synchronise
    let phase = rand() * 2 * Math.PI;

    const yearlyRatesOverride = [];
    for (let y = 0; y < totalYears; y++) {
      // Advance stochastic phase
      phase += ω0 + (σ_phase > 0 ? sampleNorm(rand) * σ_phase : 0);
      const cycle = Math.sin(phase) * cycleSeverity;

      const z1 = sampleNorm(rand);
      const z2 = sampleNorm(rand);

      yearlyRatesOverride.push({
        // Investment rates: no floor — negative values represent down-market years.
        // A zero floor would truncate the left tail while leaving the right tail open,
        // inflating the effective mean and causing higher volatility to spuriously
        // increase long-run wealth rather than widen the spread around the median.
        savingsRate: baseRates.savingsRate + cycle * 0.08 + z1 * σ_mkt,
        retirementRate: baseRates.retirementRate + cycle * 0.06 + z1 * σ_mkt * 0.75,
        // Macro rates: allow mild deflation (floor at −5%) but prevent extreme values.
        inflationRate: Math.max(-0.05, baseRates.inflationRate - cycle * 0.01 + z2 * σ_mac),
        boeRate: Math.max(-0.05, baseRates.boeRate - cycle * 0.01 + z2 * σ_mac),
        wageGrowthRate: baseRates.wageGrowthRate + cycle * 0.02 + z2 * σ_mac * 0.5,
      });
    }

    try {
      successful.push(
        projectLifecycle(profile, baseRates, pots, retirementOpts, yearlyRatesOverride)
      );
    } catch {
      /* skip */
    }
  }

  if (successful.length === 0) return null;

  const ages = successful[0].yearlyBreakdown.map((r) => r.age);
  const portfolioMatrix = successful.map((r) => r.yearlyBreakdown.map(rowPortfolio));

  // ── Rank trials for representative-path selection ──────────────────────────
  // Sort order (ascending = worst → best):
  //   1. Trials that survive to maxAge rank above all exhausted trials.
  //      Among survivors: rank by balance at maxAge (higher = better).
  //   2. Exhausted trials: rank by shortfall age (later = better).
  //   3. Same shortfall age: rank by total portfolio area (sum of yearly
  //      balances — higher means more wealth throughout the projection).

  const maxAgeIdx = ages.length - 1;

  function trialScore(col) {
    const finalBal = col[maxAgeIdx] ?? 0;
    // Find first year where portfolio drops to zero after being positive.
    let shortfallAge = Infinity; // Infinity signals no exhaustion
    for (let i = 1; i < col.length; i++) {
      if (col[i] <= 0 && col[i - 1] > 0) {
        shortfallAge = ages[i];
        break;
      }
    }
    const totalBal = col.reduce((s, v) => s + v, 0);
    return { finalBal, shortfallAge, totalBal };
  }

  const ranked = portfolioMatrix
    .map((col, i) => ({ i, ...trialScore(col) }))
    .sort((a, b) => {
      const aExhausted = a.shortfallAge !== Infinity;
      const bExhausted = b.shortfallAge !== Infinity;
      // Non-exhausted always beats exhausted
      if (aExhausted !== bExhausted) return aExhausted ? -1 : 1;
      if (!aExhausted) {
        // Both survive: rank by final balance
        return a.finalBal - b.finalBal;
      }
      // Both exhausted: rank by shortfall age, then total area
      if (a.shortfallAge !== b.shortfallAge) return a.shortfallAge - b.shortfallAge;
      return a.totalBal - b.totalBal;
    });

  const PCTS = [10, 25, 50, 75, 90];
  const repTrialIdx = {};
  for (const p of PCTS) {
    const pos = Math.round((p / 100) * (ranked.length - 1));
    repTrialIdx[p] = ranked[pos].i;
  }

  const percentileData = ages.map((age, ai) => {
    const vals = portfolioMatrix.map((col) => col[ai]).sort((a, b) => a - b);
    return {
      age,
      p10: pctile(vals, 10),
      p25: pctile(vals, 25),
      p50: pctile(vals, 50),
      p75: pctile(vals, 75),
      p90: pctile(vals, 90),
    };
  });

  const repPaths = {};
  for (const p of PCTS) {
    repPaths[p] = successful[repTrialIdx[p]].yearlyBreakdown;
  }

  return { percentileData, repPaths, trialCount: successful.length, portfolioMatrix };
}
