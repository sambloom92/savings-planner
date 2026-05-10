/**
 * Monte Carlo simulation — two-regime Markov model with t(ν=5) shocks
 * and GARCH-like volatility persistence.
 *
 * For each trial:
 *   1. Regime state: normal or bear, starts normal.
 *      Each year:
 *        If normal: enter bear with p_enter = 1 / bearFreq
 *        If bear:   exit  bear with p_exit  = 0.5  (avg bear ≈ 2 years)
 *
 *   2. Volatility state (asymmetric: instant spike, slow decay):
 *        During bear:  volState = VOL_BEAR  (immediate snap — φ doesn't affect crisis intensity)
 *        After bear:   volState = φ × volState + (1−φ) × VOL_NORMAL
 *        φ = crisisPersistence (0.3 short · 0.6 medium · 0.8 long)
 *        → φ purely controls post-crisis decay speed, giving a clean monotonic
 *          ordering: Short has least lingering excess vol → best long-run outcomes
 *
 *   3. Shocks:
 *        z1 ~ t(ν=5)  — market returns (fat tails; more realistic than normal)
 *        z2 ~ N(0,1)  — macro rates (inflation/BoE/wages; lighter tails acceptable)
 *
 *   4. Bear shift: Δ = bearSeverity when inBear, else 0
 *      (bearSeverity stored as a positive fraction, e.g. 0.15 = −15 pp to returns)
 *
 *   5. Year t rates:
 *        savingsRate    = base − Δ          + z1 × σ_eff
 *        retirementRate = base − Δ × 0.75   + z1 × σ_eff × 0.75
 *        inflationRate  = max(−0.05, base + Δ × 0.15 + z2 × σ_mac)
 *        boeRate        = max(−0.05, base + Δ × 0.10 + z2 × σ_mac)
 *        wageGrowthRate = base − Δ × 0.25   + z2 × σ_mac × 0.5
 *
 *      σ_eff      = σ_mkt × volState        (vol clustering)
 *      σ_mkt      = volatility × 0.08
 *      σ_mac      = volatility × 0.008
 *
 * Investment rates have no floor — see note in previous version.
 * Macro rates floored at −5% to prevent extreme deflation artefacts.
 */

import { projectLifecycle } from './ukLifecycle.js';

const VOL_BEAR = 2.5; // vol multiplier target during bear regimes
const VOL_NORMAL = 1.0; // vol multiplier target during normal regimes

// ── PRNG (xorshift-based, seedable) ──────────────────────────────────────────
function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Standard normal via Box-Muller ────────────────────────────────────────────
function sampleNorm(rand) {
  let u;
  do {
    u = rand();
  } while (u === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ── Student t(ν=5) via normal/chi-squared ratio ───────────────────────────────
// t(ν) = Z / √(χ²(ν)/ν)  where χ²(ν) = Σᵢ Zᵢ²  (ν independent normals)
// At ν=5 the distribution looks near-normal in the centre but has meaningfully
// fatter tails — empirically a good fit for annual equity return distributions.
function sampleT5(rand) {
  const z = sampleNorm(rand);
  let chi2 = 0;
  for (let i = 0; i < 5; i++) {
    const w = sampleNorm(rand);
    chi2 += w * w;
  }
  return z / Math.sqrt(chi2 / 5);
}

// ── Percentile helper ─────────────────────────────────────────────────────────
function pctile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// ── Total portfolio value for one row ────────────────────────────────────────
function rowPortfolio(row) {
  return Math.max(
    0,
    (row.pension?.closingBalance ?? 0) +
      (row.isa?.closingBalance ?? 0) +
      (row.gia?.closingBalance ?? 0)
  );
}

// ── Main simulation ───────────────────────────────────────────────────────────
export function runMonteCarlo(profile, baseRates, pots, retirementOpts, opts = {}) {
  const {
    trials = 200,
    volatility = 1.0,
    seed = 0xdeadbeef,
    bearFreq = 12,       // years between bear markets (on average)
    bearSeverity = 0.15, // return penalty during bear (positive fraction)
    crisisPersistence = 0.6, // φ for vol AR(1): 0.3 short · 0.6 medium · 0.8 long
    // Asset allocation: fraction in equities pre/post retirement (0–1).
    // These drive two things:
    //   1. The volatility ratio applied to retirementRate vs savingsRate shocks.
    //   2. The bear-severity ratio for retirementRate.
    // Default 0.5/0.8 → ratio ≈ 0.625 (close to the old hardcoded 0.75 at 0.6/0.8).
    preRetirementEquity = 0.8,
    postRetirementEquity = 0.4,
  } = opts;

  // Volatility reduction factor for the retirement-phase rate relative to the
  // accumulation-phase rate.  Reflects the lower equity weight in a de-risked
  // portfolio; derived directly from the allocation split rather than hardcoded.
  // Clamped so it never exceeds 1 (no leverage) and never goes below 0.
  const volRatio = preRetirementEquity > 0
    ? Math.min(1, Math.max(0, postRetirementEquity / preRetirementEquity))
    : 0;

  const σ_mkt = volatility * 0.08;
  const σ_mac = volatility * 0.008;
  const φ = Math.max(0, Math.min(0.99, crisisPersistence));
  const pEnter = 1 / Math.max(1, bearFreq); // P(normal → bear) per year
  const pExit = 0.5; // P(bear → normal) per year ≈ 2-yr avg bear

  const totalYears = retirementOpts.maxAge - profile.currentAge + 1;
  const rand = makePRNG(seed);
  const successful = [];

  for (let t = 0; t < trials; t++) {
    let inBear = false;
    let volState = VOL_NORMAL;

    const yearlyRatesOverride = [];
    for (let y = 0; y < totalYears; y++) {
      // ── Regime transition ──────────────────────────────────────────────────
      if (inBear) {
        if (rand() < pExit) inBear = false;
      } else {
        if (rand() < pEnter) inBear = true;
      }

      // ── Volatility state ───────────────────────────────────────────────────
      // During a bear: vol snaps immediately to VOL_BEAR so φ has no effect
      // on crisis intensity — it only controls how slowly vol decays afterward.
      // After a bear: AR(1) decay toward VOL_NORMAL at rate (1−φ).
      // This gives a clean monotonic ordering: Short decays fastest → lowest
      // integrated excess vol → best outcomes; Long decays slowest → worst.
      if (inBear) {
        volState = VOL_BEAR;
      } else {
        volState = φ * volState + (1 - φ) * VOL_NORMAL;
      }
      const σ_eff = σ_mkt * volState;

      // ── Shocks ────────────────────────────────────────────────────────────
      const z1 = sampleT5(rand); // fat-tailed market shock
      const z2 = sampleNorm(rand); // macro shock (normal is fine here)

      // ── Bear shift (positive = downward pressure on returns) ───────────────
      const Δ = inBear ? bearSeverity : 0;

      yearlyRatesOverride.push({
        // Investment rates: no floor (see module docstring).
        // retirementRate shock is scaled by volRatio — a de-risked (lower-equity)
        // portfolio suffers less volatility and a smaller bear-market drag.
        savingsRate: baseRates.savingsRate - Δ + z1 * σ_eff,
        retirementRate: baseRates.retirementRate - Δ * volRatio + z1 * σ_eff * volRatio,
        // Macro rates: mild reflation during crises; floor at −5%
        inflationRate: Math.max(-0.05, baseRates.inflationRate + Δ * 0.15 + z2 * σ_mac),
        boeRate: Math.max(-0.05, baseRates.boeRate + Δ * 0.1 + z2 * σ_mac),
        wageGrowthRate: baseRates.wageGrowthRate - Δ * 0.25 + z2 * σ_mac * 0.5,
      });
    }

    try {
      successful.push(
        projectLifecycle(profile, baseRates, pots, retirementOpts, yearlyRatesOverride)
      );
    } catch {
      /* skip failed trials */
    }
  }

  if (successful.length === 0) return null;

  const ages = successful[0].yearlyBreakdown.map((r) => r.age);
  const portfolioMatrix = successful.map((r) => r.yearlyBreakdown.map(rowPortfolio));

  // ── Rank trials for representative-path selection ─────────────────────────
  // Sort order (ascending = worst → best):
  //   Survivors (never exhaust funds) always beat exhausted trials.
  //   Among survivors:  rank by final balance at maxAge.
  //   Among exhausted:  rank by shortfall age, then total portfolio area.
  const maxAgeIdx = ages.length - 1;

  function trialScore(col) {
    const finalBal = col[maxAgeIdx] ?? 0;
    let shortfallAge = Infinity;
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
      const aEx = a.shortfallAge !== Infinity;
      const bEx = b.shortfallAge !== Infinity;
      if (aEx !== bEx) return aEx ? -1 : 1;
      if (!aEx) return a.finalBal - b.finalBal;
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

  // Per-trial pot balances — lightweight snapshot used by the locked-trial
  // stacked view in FanChart.  Assets stored as positive values; debts stored
  // as positive balances (the canvas draws them below zero).
  const allPotData = successful.map((r) =>
    r.yearlyBreakdown.map((row) => ({
      pension: Math.max(0, row.pension?.closingBalance ?? 0),
      isa: Math.max(0, row.isa?.closingBalance ?? 0),
      gia: Math.max(0, row.gia?.closingBalance ?? 0),
      mortgage: row.mortgage?.closingBalance ?? 0,
      unsecuredDebt:
        row.unsecuredDebts?.reduce((s, d) => s + (d.closingBalance ?? 0), 0) ?? 0,
      studentLoan: row.studentLoan?.closingBalance ?? 0,
    }))
  );

  return { percentileData, repPaths, trialCount: successful.length, portfolioMatrix, allPotData };
}
