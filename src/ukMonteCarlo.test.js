import assert from 'node:assert/strict';
import { runMonteCarlo } from './ukMonteCarlo.js';
import { projectLifecycle } from './ukLifecycle.js';

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

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

function describe(group, fn) {
  console.log(`\n${group}`);
  fn();
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const profile = {
  currentAge: 40,
  retirementAge: 55,
  currentYear: 2025,
  grossIncome: 60_000,
  annualLivingExpenses: 20_000,
  employeePensionRate: 0.08,
  employerPensionRate: 0.05,
  niContributionYears: 20,
};

const rates = {
  savingsRate: 0.06,
  retirementRate: 0.04,
  wageGrowthRate: 0.03,
  inflationRate: 0.025,
  boeRate: 0.04,
  fiscalDragRate: 0,
};

const pots = { pensionBalance: 100_000, isaBalance: 40_000, giaBalance: 10_000 };

const retirementOpts = {
  targetNetAnnualExpenses: 30_000,
  maxAge: 85,
  glideStartYears: 5,
  glideEndYears: 5,
};

const totalYears = retirementOpts.maxAge - profile.currentAge + 1;

function detTotals() {
  const det = projectLifecycle(profile, rates, pots, retirementOpts);
  return det.yearlyBreakdown.map((row) =>
    Math.max(
      0,
      (row.pension?.closingBalance ?? 0) +
        (row.isa?.closingBalance ?? 0) +
        (row.gia?.closingBalance ?? 0)
    )
  );
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('result shape', () => {
  const res = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 50, seed: 1 });

  it('returns percentileData spanning currentAge to maxAge', () => {
    assert.equal(res.percentileData.length, totalYears);
    assert.equal(res.percentileData[0].age, profile.currentAge);
    assert.equal(res.percentileData.at(-1).age, retirementOpts.maxAge);
  });

  it('runs all requested trials (none should fail)', () => {
    assert.equal(res.trialCount, 50);
  });

  it('repPaths has one representative path per percentile, full length', () => {
    for (const p of [10, 25, 50, 75, 90]) {
      assert.ok(Array.isArray(res.repPaths[p]), `repPaths[${p}] missing`);
      assert.equal(res.repPaths[p].length, totalYears);
      assert.equal(res.repPaths[p][0].age, profile.currentAge);
    }
  });

  it('portfolioMatrix and allPotData have one row per trial', () => {
    assert.equal(res.portfolioMatrix.length, res.trialCount);
    assert.equal(res.allPotData.length, res.trialCount);
    for (const trial of res.allPotData) {
      assert.equal(trial.length, totalYears);
    }
  });

  it('allPotData asset balances are non-negative', () => {
    for (const trial of res.allPotData) {
      for (const row of trial) {
        assert.ok(row.pension >= 0 && row.isa >= 0 && row.gia >= 0);
      }
    }
  });

  it('availablePercentileData never exceeds the all-balances bands', () => {
    // Available funds = a subset of the total pot (pension excluded before the
    // access age), so every available percentile is ≤ the matching all band.
    assert.equal(res.availablePercentileData.length, res.percentileData.length);
    for (let i = 0; i < res.percentileData.length; i++) {
      for (const k of ['p10', 'p25', 'p50', 'p75', 'p90']) {
        assert.ok(
          res.availablePercentileData[i][k] <= res.percentileData[i][k] + 1e-6,
          `available ${k} > all at age ${res.percentileData[i].age}`
        );
      }
    }
  });

  it('available and all bands coincide once the pension is accessible', () => {
    // From the access age onward the pension counts in both, so the bands match.
    const accessAge = 57;
    for (const row of res.availablePercentileData.filter((r) => r.age >= accessAge)) {
      const all = res.percentileData.find((r) => r.age === row.age);
      for (const k of ['p10', 'p50', 'p90']) {
        assert.ok(Math.abs(row[k] - all[k]) < 1e-6, `mismatch at ${row.age} ${k}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same seed produces identical results', () => {
    const a = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 40, seed: 42 });
    const b = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 40, seed: 42 });
    assert.deepEqual(a.percentileData, b.percentileData);
  });

  it('different seeds produce different results', () => {
    const a = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 40, seed: 1 });
    const b = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 40, seed: 2 });
    assert.notDeepEqual(a.percentileData, b.percentileData);
  });
});

// ---------------------------------------------------------------------------
// Statistical invariants
// ---------------------------------------------------------------------------

describe('percentile ordering', () => {
  it('p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90 at every age', () => {
    const res = runMonteCarlo(profile, rates, pots, retirementOpts, { trials: 100, seed: 7 });
    for (const row of res.percentileData) {
      assert.ok(
        row.p10 <= row.p25 && row.p25 <= row.p50 && row.p50 <= row.p75 && row.p75 <= row.p90,
        `percentiles out of order at age ${row.age}`
      );
    }
  });
});

describe('degenerate case: no volatility, no bear markets', () => {
  it('every percentile equals the deterministic projection', () => {
    // With volatility=0 and bearSeverity=0 every trial draws exactly the base
    // rates, so the whole fan collapses onto the deterministic line.
    const res = runMonteCarlo(profile, rates, pots, retirementOpts, {
      trials: 10,
      seed: 3,
      volatility: 0,
      bearSeverity: 0,
    });
    const det = detTotals();
    res.percentileData.forEach((row, i) => {
      for (const key of ['p10', 'p25', 'p50', 'p75', 'p90']) {
        assert.ok(
          Math.abs(row[key] - det[i]) <= 0.02,
          `age ${row.age} ${key}: expected ${det[i]}, got ${row[key]}`
        );
      }
    });
  });
});

describe('bear-drag compensation keeps the median calibrated', () => {
  it('p50 portfolio area stays close to the deterministic area (vol=0)', () => {
    // With volatility 0 but bear markets active, trials differ only in bear
    // timing. The compensation shifts base rates so the expected yearly rate
    // equals the slider value; the median outcome should therefore track the
    // deterministic projection (small residual variance drag is expected).
    const res = runMonteCarlo(profile, rates, pots, retirementOpts, {
      trials: 300,
      seed: 11,
      volatility: 0,
    });
    const det = detTotals();
    const detArea = det.reduce((s, v) => s + v, 0);
    const p50Area = res.percentileData.reduce((s, r) => s + r.p50, 0);
    const ratio = p50Area / detArea;
    assert.ok(ratio > 0.75 && ratio < 1.25, `p50/deterministic area ratio ${ratio.toFixed(3)}`);
  });
});

describe('solvency metrics', () => {
  // A deliberately under-funded plan so some trials run dry: retire early on
  // modest pots with high spending.
  const thinProfile = { ...profile, retirementAge: 50 };
  const thinPots = { pensionBalance: 60_000, isaBalance: 20_000, giaBalance: 0 };
  const thinRet = { ...retirementOpts, targetNetAnnualExpenses: 40_000, maxAge: 100 };

  it('exposes both horizon and lifetime solvency figures', () => {
    const res = runMonteCarlo(thinProfile, rates, thinPots, thinRet, { trials: 200, seed: 5 });
    const s = res.solvency;
    for (const k of ['solventToHorizon', 'solventForLife', 'lifetimeRuinProb']) {
      assert.ok(s[k] >= 0 && s[k] <= 1, `${k} out of range: ${s[k]}`);
    }
    assert.ok(Math.abs(s.solventForLife + s.lifetimeRuinProb - 1) < 1e-9, 'complement holds');
  });

  it('lifetime solvency is at least horizon solvency (late ruin is discounted)', () => {
    // Mortality forgives late shortfalls, so P(solvent for life) >= P(solvent to horizon).
    const res = runMonteCarlo(thinProfile, rates, thinPots, thinRet, { trials: 300, seed: 9 });
    const s = res.solvency;
    assert.ok(
      s.solventForLife >= s.solventToHorizon - 1e-9,
      `lifetime ${s.solventForLife} < horizon ${s.solventToHorizon}`
    );
  });

  it('a fully-funded plan is solvent on both measures', () => {
    const res = runMonteCarlo(profile, rates, { ...pots, isaBalance: 2_000_000 }, retirementOpts, {
      trials: 100,
      seed: 3,
      volatility: 0,
    });
    assert.equal(res.solvency.exhaustedTrials, 0);
    assert.equal(res.solvency.solventToHorizon, 1);
    assert.equal(res.solvency.solventForLife, 1);
  });

  it('survival series spans the horizon, starts at 1, and is non-increasing', () => {
    const res = runMonteCarlo(thinProfile, rates, thinPots, thinRet, { trials: 20, seed: 1 });
    const surv = res.solvency.survival;
    assert.equal(surv[0].age, thinProfile.currentAge);
    assert.equal(surv[0].survival, 1);
    assert.equal(surv.at(-1).age, thinRet.maxAge);
    for (let i = 1; i < surv.length; i++) {
      assert.ok(surv[i].survival <= surv[i - 1].survival);
    }
  });

  it('sex changes the lifetime figure but not the horizon figure', () => {
    const base = { trials: 300, seed: 7 };
    const male = runMonteCarlo(thinProfile, rates, thinPots, thinRet, { ...base, sex: 'male' });
    const female = runMonteCarlo(thinProfile, rates, thinPots, thinRet, { ...base, sex: 'female' });
    // Horizon solvency is mortality-independent → identical for the same seed.
    assert.equal(male.solvency.solventToHorizon, female.solvency.solventToHorizon);
    // Females live longer → more exposed to late ruin → lower lifetime solvency.
    assert.ok(
      female.solvency.solventForLife <= male.solvency.solventForLife + 1e-9,
      'female lifetime solvency should not exceed male'
    );
  });

  it('counts a bridge shortfall as ruin even while a locked pension survives', () => {
    // Retire at 50 with a large pension but only a tiny ISA bridge. Everything is
    // identical except the pension access age: 57 (locked, must bridge) vs 50
    // (immediately accessible). The locked case can't fund spending from the 15k
    // ISA until the pension unlocks, so nearly every trial is insolvent before 57
    // — despite the untouchable 800k pot never hitting zero.
    const base = { ...profile, currentAge: 45, retirementAge: 50 };
    const pots = { pensionBalance: 800_000, isaBalance: 15_000, giaBalance: 0 };
    const ret = { targetNetAnnualExpenses: 45_000, maxAge: 95 };
    const opts = { trials: 200, seed: 4 };
    const locked = runMonteCarlo({ ...base, pensionAccessAge: 57 }, rates, pots, ret, opts);
    const accessible = runMonteCarlo({ ...base, pensionAccessAge: 50 }, rates, pots, ret, opts);

    // The locked bridge is unfundable, so almost all trials are ruined.
    assert.ok(
      locked.solvency.exhaustedTrials > opts.trials * 0.9,
      `expected most trials ruined, got ${locked.solvency.exhaustedTrials}/${opts.trials}`
    );
    // Same money, same seed — only access age differs — yet the locked pension is
    // materially worse, proving the metric responds to bridge insolvency rather
    // than the summed pot hitting zero.
    assert.ok(
      locked.solvency.solventForLife < accessible.solvency.solventForLife - 0.2,
      `locked ${locked.solvency.solventForLife} vs accessible ${accessible.solvency.solventForLife}`
    );
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exitCode = 1;
}
