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
