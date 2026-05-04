import assert from 'node:assert/strict';
import { GIA_CGT_CONSTANTS, projectGIA } from './ukGIA.js';

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

function assertApprox(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) <= 0.01, `${label}: expected ${expected}, got ${actual}`);
}

function gia(balance, costBasis, projections, opts) {
  return projectGIA(balance, costBasis, projections, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GIA_CGT_CONSTANTS', () => {
  it('annual exempt amount is £3,000 for 2025/26', () => {
    assert.equal(GIA_CGT_CONSTANTS.annualExemptAmount, 3_000);
  });

  it('basic rate is 18%, higher rate is 24%', () => {
    assert.equal(GIA_CGT_CONSTANTS.basicRate, 0.18);
    assert.equal(GIA_CGT_CONSTANTS.higherRate, 0.24);
  });

  it('basic rate limit is £50,270', () => {
    assert.equal(GIA_CGT_CONSTANTS.basicRateLimit, 50_270);
  });
});

describe('input validation — projectGIA', () => {
  const proj = [{ growthRate: 0.05 }];

  it('throws TypeError for non-numeric initialBalance', () => {
    assert.throws(() => gia('10000', 10000, proj), TypeError);
    assert.throws(() => gia(NaN, 10000, proj), TypeError);
    assert.throws(() => gia(null, 10000, proj), TypeError);
  });

  it('throws TypeError for non-numeric initialCostBasis', () => {
    assert.throws(() => gia(10000, '10000', proj), TypeError);
    assert.throws(() => gia(10000, NaN, proj), TypeError);
  });

  it('throws TypeError for negative initialBalance', () => {
    assert.throws(() => gia(-1, 0, proj), TypeError);
  });

  it('throws TypeError for negative initialCostBasis', () => {
    assert.throws(() => gia(10000, -1, proj), TypeError);
  });

  it('throws TypeError for empty or non-array annualProjections', () => {
    assert.throws(() => gia(10000, 10000, []), TypeError);
    assert.throws(() => gia(10000, 10000, null), TypeError);
    assert.throws(() => gia(10000, 10000, 'bad'), TypeError);
  });

  it('throws RangeError for invalid startYear', () => {
    assert.throws(() => gia(10000, 10000, proj, { startYear: 1980 }), RangeError);
    assert.throws(() => gia(10000, 10000, proj, { startYear: 2025.5 }), RangeError);
  });

  it('throws TypeError for negative growthRate in a projection year', () => {
    assert.throws(() => gia(10000, 10000, [{ growthRate: -0.01 }]), TypeError);
  });

  it('throws TypeError for negative contributions or withdrawals', () => {
    assert.throws(() => gia(10000, 10000, [{ growthRate: 0, contributions: -100 }]), TypeError);
    assert.throws(() => gia(10000, 10000, [{ growthRate: 0, withdrawals: -100 }]), TypeError);
  });

  it('throws RangeError when withdrawal exceeds balance', () => {
    assert.throws(() => gia(5000, 5000, [{ growthRate: 0, withdrawals: 6000 }]), RangeError);
  });

  it('accepts zero for balance, costBasis, contributions, withdrawals, growthRate', () => {
    assert.doesNotThrow(() => gia(0, 0, [{ growthRate: 0, contributions: 0, withdrawals: 0 }]));
  });
});

describe('pure growth — no contributions or withdrawals', () => {
  it('single year at 10% growth', () => {
    // balance 10,000 grows by 1,000
    const r = gia(10_000, 10_000, [{ growthRate: 0.1 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.growthAmount, 1_000, 'growthAmount');
    assertApprox(y.closingBalance, 11_000, 'closingBalance');
    assertApprox(y.closingCostBasis, 10_000, 'closingCostBasis');
    assertApprox(y.unrealisedGain, 1_000, 'unrealisedGain');
    assert.equal(y.cgtDue, 0);
  });

  it('compounds correctly across two years', () => {
    // Y1: 10,000 * 1.07 = 10,700; Y2: 10,700 * 1.07 = 11,449
    const r = gia(10_000, 10_000, [{ growthRate: 0.07 }, { growthRate: 0.07 }]);
    assertApprox(r.yearlyBreakdown[0].closingBalance, 10_700, 'Y1 closing');
    assertApprox(r.yearlyBreakdown[1].closingBalance, 11_449, 'Y2 closing');
    // cost basis unchanged
    assert.equal(r.yearlyBreakdown[1].closingCostBasis, 10_000);
    assertApprox(r.finalUnrealisedGain, 1_449, 'final unrealised gain');
  });

  it('zero growth leaves balance unchanged', () => {
    const r = gia(8_000, 6_000, [{ growthRate: 0 }]);
    assertApprox(r.finalBalance, 8_000, 'finalBalance');
    assert.equal(r.totalGrowth, 0);
  });
});

describe('contributions', () => {
  it('contribution added to balance and cost basis, then growth applied', () => {
    // opening 10,000; contribute 2,000 → 12,000; grow 10% → 13,200
    const r = gia(10_000, 10_000, [{ growthRate: 0.1, contributions: 2_000 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.growthAmount, 1_200, 'growthAmount'); // 12,000 * 0.10
    assertApprox(y.closingBalance, 13_200, 'closingBalance');
    assertApprox(y.closingCostBasis, 12_000, 'closingCostBasis');
    assertApprox(y.unrealisedGain, 1_200, 'unrealisedGain');
    assert.equal(r.totalContributions, 2_000);
  });

  it('starts from zero balance', () => {
    // contribute 5,000, grow 5% → 5,250
    const r = gia(0, 0, [{ growthRate: 0.05, contributions: 5_000 }]);
    assertApprox(r.finalBalance, 5_250, 'finalBalance');
    assertApprox(r.finalCostBasis, 5_000, 'finalCostBasis');
    assertApprox(r.finalUnrealisedGain, 250, 'unrealisedGain');
  });
});

describe('withdrawals — no CGT (no gain in portfolio)', () => {
  it('no gain: zero CGT even with large withdrawal', () => {
    // balance = cost basis, no growth
    const r = gia(10_000, 10_000, [{ growthRate: 0, withdrawals: 5_000 }]);
    const y = r.yearlyBreakdown[0];
    assert.equal(y.gainOnWithdrawal, 0);
    assert.equal(y.cgtDue, 0);
    assertApprox(y.closingBalance, 5_000, 'closingBalance');
    assertApprox(y.closingCostBasis, 5_000, 'closingCostBasis');
  });

  it('loss position (cost basis > balance): no CGT', () => {
    // invested 10,000 but now worth 8,000 — capital loss
    const r = gia(8_000, 10_000, [{ growthRate: 0, withdrawals: 4_000 }]);
    const y = r.yearlyBreakdown[0];
    assert.equal(y.gainOnWithdrawal, 0);
    assert.equal(y.cgtDue, 0);
    assertApprox(y.closingBalance, 4_000, 'closingBalance');
    // cost basis reduced proportionally: 10,000 * (1 - 4000/8000) = 5,000
    assertApprox(y.closingCostBasis, 5_000, 'closingCostBasis');
    assertApprox(y.unrealisedGain, -1_000, 'unrealisedGain (still a loss)');
  });
});

describe('withdrawals — gain within annual exempt amount (no CGT payable)', () => {
  it('gain on withdrawal <= £3,000 exempt amount: no tax', () => {
    // balance 20,000, cost basis 10,000 (50% gain fraction)
    // withdraw 5,000 → gain portion = 2,500 < 3,000 → no CGT
    const r = gia(20_000, 10_000, [
      {
        growthRate: 0,
        withdrawals: 5_000,
        grossIncome: 30_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.gainOnWithdrawal, 2_500, 'gainOnWithdrawal');
    assertApprox(y.cgtAllowanceUsed, 2_500, 'allowanceUsed');
    assert.equal(y.cgtDue, 0);
  });

  it('gain exactly at £3,000 exempt: no tax', () => {
    // balance 60,000, cost basis 30,000 (50% gain fraction)
    // withdraw 6,000 → gain = 3,000 exactly → cgtDue = 0
    const r = gia(60_000, 30_000, [
      {
        growthRate: 0,
        withdrawals: 6_000,
        grossIncome: 50_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.gainOnWithdrawal, 3_000, 'gainOnWithdrawal');
    assertApprox(y.cgtAllowanceUsed, 3_000, 'allowanceUsed');
    assert.equal(y.cgtDue, 0);
  });
});

describe('withdrawals — CGT at basic rate (18%)', () => {
  it('all taxable gain within basic rate band', () => {
    // balance 20,000, cost basis 10,000; withdraw 10,000
    // gainFraction = 0.5, gainOnWithdrawal = 5,000
    // taxableGain = 5,000 - 3,000 = 2,000
    // grossIncome 30,000 → basicBandRemaining = 20,270 → all at 18%
    // cgtDue = 2,000 * 0.18 = 360
    const r = gia(20_000, 10_000, [
      {
        growthRate: 0,
        withdrawals: 10_000,
        grossIncome: 30_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.gainOnWithdrawal, 5_000, 'gainOnWithdrawal');
    assertApprox(y.cgtAllowanceUsed, 3_000, 'allowanceUsed');
    assertApprox(y.cgtDue, 360, 'cgtDue');
    assertApprox(y.cgtRate, 0.18, 'cgtRate');
    assertApprox(y.closingBalance, 10_000, 'closingBalance');
    // cost basis: 10,000 * (1 - 10000/20000) = 5,000
    assertApprox(y.closingCostBasis, 5_000, 'closingCostBasis');
    assertApprox(y.unrealisedGain, 5_000, 'unrealisedGain');
    assert.equal(r.totalCgtPaid, 360);
  });
});

describe('withdrawals — CGT at higher rate (24%)', () => {
  it('all taxable gain at higher rate when grossIncome above basic rate limit', () => {
    // balance 20,000, cost basis 10,000; withdraw 10,000
    // gainOnWithdrawal = 5,000; taxableGain = 2,000; grossIncome = 80,000 → all 24%
    // cgtDue = 2,000 * 0.24 = 480
    const r = gia(20_000, 10_000, [
      {
        growthRate: 0,
        withdrawals: 10_000,
        grossIncome: 80_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.cgtDue, 480, 'cgtDue');
    assertApprox(y.cgtRate, 0.24, 'cgtRate');
  });

  it('higher rate assumed when grossIncome is null', () => {
    const rHigher = gia(20_000, 10_000, [
      { growthRate: 0, withdrawals: 10_000, grossIncome: 80_000 },
    ]);
    const rNull = gia(20_000, 10_000, [{ growthRate: 0, withdrawals: 10_000, grossIncome: null }]);
    assertApprox(rNull.yearlyBreakdown[0].cgtDue, rHigher.yearlyBreakdown[0].cgtDue, 'null=higher');
  });

  it('higher rate assumed when grossIncome is omitted', () => {
    const rHigher = gia(20_000, 10_000, [
      { growthRate: 0, withdrawals: 10_000, grossIncome: 80_000 },
    ]);
    const rOmit = gia(20_000, 10_000, [{ growthRate: 0, withdrawals: 10_000 }]);
    assertApprox(rOmit.yearlyBreakdown[0].cgtDue, rHigher.yearlyBreakdown[0].cgtDue, 'omit=higher');
  });
});

describe('withdrawals — CGT split across basic and higher rate (mixed band)', () => {
  it('gain split at the basic rate band boundary', () => {
    // balance 100,000, cost basis 40,000; withdraw 40,000; grossIncome 45,000
    // gainFraction = 60,000/100,000 = 0.6
    // gainOnWithdrawal = 40,000 * 0.6 = 24,000
    // taxableGain = 24,000 - 3,000 = 21,000
    // basicBandRemaining = 50,270 - 45,000 = 5,270
    // at 18%: 5,270 * 0.18 = 948.60
    // at 24%: (21,000 - 5,270) * 0.24 = 15,730 * 0.24 = 3,775.20
    // cgtDue = 948.60 + 3,775.20 = 4,723.80
    const r = gia(100_000, 40_000, [
      {
        growthRate: 0,
        withdrawals: 40_000,
        grossIncome: 45_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.gainOnWithdrawal, 24_000, 'gainOnWithdrawal');
    assertApprox(y.cgtAllowanceUsed, 3_000, 'allowanceUsed');
    assertApprox(y.cgtDue, 4_723.8, 'cgtDue');
    // blended rate: 4723.80 / 21000 ≈ 0.225
    assert.ok(y.cgtRate > 0.18 && y.cgtRate < 0.24, 'cgtRate between basic and higher');
  });
});

describe('withdrawals — balance and cost basis consistency', () => {
  it('closingBalance = balanceBeforeWithdrawal - withdrawals', () => {
    const r = gia(30_000, 15_000, [
      {
        growthRate: 0.06,
        withdrawals: 8_000,
        grossIncome: 40_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(
      y.closingBalance,
      y.balanceBeforeWithdrawal - y.withdrawals,
      'closing = before - withdrawn'
    );
  });

  it('cost basis reduces correctly and preserves gain fraction after withdrawal', () => {
    // Withdraw half the portfolio → cost basis halved, unrealised gain halved
    const r = gia(20_000, 10_000, [{ growthRate: 0, withdrawals: 10_000 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.closingCostBasis, 5_000, 'costBasis halved');
    assertApprox(y.unrealisedGain, 5_000, 'gain halved');
  });
});

describe('multi-year projection', () => {
  it('year-on-year: closingBalance feeds openingBalance of next year', () => {
    const r = gia(10_000, 8_000, [
      { growthRate: 0.1, contributions: 2_000, withdrawals: 0 },
      { growthRate: 0.1, contributions: 0, withdrawals: 5_000, grossIncome: 40_000 },
    ]);
    const [y1, y2] = r.yearlyBreakdown;
    assertApprox(y2.openingBalance, y1.closingBalance, 'Y2 opening = Y1 closing');
    assertApprox(y2.openingCostBasis, y1.closingCostBasis, 'Y2 costBasis = Y1 closingCostBasis');
  });

  it('totalContributions, totalWithdrawals, totalGrowth and totalCgtPaid sum correctly', () => {
    const r = gia(10_000, 10_000, [
      { growthRate: 0.05, contributions: 1_000, withdrawals: 0 },
      { growthRate: 0.05, contributions: 2_000, withdrawals: 0 },
      { growthRate: 0, contributions: 0, withdrawals: 500 },
    ]);
    assert.equal(r.totalContributions, 3_000);
    assert.equal(r.totalWithdrawals, 500);
    const expectedGrowth = r.yearlyBreakdown.reduce((s, y) => s + y.growthAmount, 0);
    assertApprox(r.totalGrowth, Math.round(expectedGrowth * 100) / 100, 'totalGrowth');
    assert.equal(r.totalCgtPaid, 0); // no CGT (no gain above exempt at tiny withdrawal)
  });

  it('finalBalance and finalCostBasis match last yearlyBreakdown row', () => {
    const r = gia(15_000, 12_000, [
      { growthRate: 0.07, contributions: 3_000 },
      { growthRate: 0.07, withdrawals: 4_000, grossIncome: 50_000 },
    ]);
    const last = r.yearlyBreakdown[r.yearlyBreakdown.length - 1];
    assertApprox(r.finalBalance, last.closingBalance, 'finalBalance');
    assertApprox(r.finalCostBasis, last.closingCostBasis, 'finalCostBasis');
    assertApprox(r.finalUnrealisedGain, last.unrealisedGain, 'finalUnrealisedGain');
  });

  it('year labels increment correctly from startYear', () => {
    const r = gia(
      10_000,
      10_000,
      [{ growthRate: 0.05 }, { growthRate: 0.05 }, { growthRate: 0.05 }],
      { startYear: 2030 }
    );
    assert.equal(r.yearlyBreakdown[0].year, 2030);
    assert.equal(r.yearlyBreakdown[1].year, 2031);
    assert.equal(r.yearlyBreakdown[2].year, 2032);
    assert.equal(r.startYear, 2030);
  });
});

describe('return shape', () => {
  it('result contains all expected top-level fields', () => {
    const r = gia(10_000, 10_000, [{ growthRate: 0.05 }]);
    for (const key of [
      'initialBalance',
      'initialCostBasis',
      'startYear',
      'yearlyBreakdown',
      'totalContributions',
      'totalWithdrawals',
      'totalGrowth',
      'totalCgtPaid',
      'finalBalance',
      'finalCostBasis',
      'finalUnrealisedGain',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
  });

  it('each yearlyBreakdown row contains all expected fields', () => {
    const r = gia(10_000, 10_000, [{ growthRate: 0.05, withdrawals: 1_000 }]);
    const row = r.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'openingCostBasis',
      'contributions',
      'growthRate',
      'growthAmount',
      'balanceBeforeWithdrawal',
      'withdrawals',
      'gainOnWithdrawal',
      'cgtAllowanceUsed',
      'cgtDue',
      'cgtRate',
      'closingBalance',
      'closingCostBasis',
      'unrealisedGain',
    ]) {
      assert.ok(key in row, `missing row field: ${key}`);
    }
  });

  it('all monetary fields are finite numbers', () => {
    const r = gia(50_000, 30_000, [
      { growthRate: 0.08, contributions: 2_000, withdrawals: 5_000, grossIncome: 45_000 },
    ]);
    const row = r.yearlyBreakdown[0];
    for (const val of [
      row.growthAmount,
      row.gainOnWithdrawal,
      row.cgtAllowanceUsed,
      row.cgtDue,
      row.closingBalance,
      row.closingCostBasis,
      row.unrealisedGain,
    ]) {
      assert.ok(typeof val === 'number' && isFinite(val), `non-finite value: ${val}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
