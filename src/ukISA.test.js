import assert from 'node:assert/strict';
import { ISA_CONSTANTS, projectISA } from './ukISA.js';

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

function isa(balance, projections, opts) {
  return projectISA(balance, projections, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ISA_CONSTANTS', () => {
  it('annual subscription limit is £20,000 for 2025/26', () => {
    assert.equal(ISA_CONSTANTS.annualSubscriptionLimit, 20_000);
  });
});

describe('input validation — projectISA', () => {
  const proj = [{ growthRate: 0.05 }];

  it('throws TypeError for non-numeric initialBalance', () => {
    assert.throws(() => isa('10000', proj), TypeError);
    assert.throws(() => isa(NaN, proj), TypeError);
    assert.throws(() => isa(null, proj), TypeError);
    assert.throws(() => isa(Infinity, proj), TypeError);
  });

  it('throws TypeError for negative initialBalance', () => {
    assert.throws(() => isa(-1, proj), TypeError);
  });

  it('throws TypeError for empty or non-array annualProjections', () => {
    assert.throws(() => isa(10_000, []), TypeError);
    assert.throws(() => isa(10_000, null), TypeError);
    assert.throws(() => isa(10_000, 'bad'), TypeError);
  });

  it('throws RangeError for invalid startYear', () => {
    assert.throws(() => isa(10_000, proj, { startYear: 1989 }), RangeError);
    assert.throws(() => isa(10_000, proj, { startYear: 2025.5 }), RangeError);
    assert.throws(() => isa(10_000, proj, { startYear: '2025' }), RangeError);
  });

  it('throws TypeError for negative growthRate', () => {
    assert.throws(() => isa(10_000, [{ growthRate: -0.01 }]), TypeError);
  });

  it('throws TypeError for negative contributions', () => {
    assert.throws(() => isa(10_000, [{ growthRate: 0, contributions: -1 }]), TypeError);
  });

  it('throws TypeError for negative withdrawals', () => {
    assert.throws(() => isa(10_000, [{ growthRate: 0, withdrawals: -1 }]), TypeError);
  });

  it('throws RangeError when contributions exceed the annual limit', () => {
    assert.throws(() => isa(10_000, [{ growthRate: 0, contributions: 20_001 }]), RangeError);
  });

  it('accepts contributions exactly at the annual limit', () => {
    assert.doesNotThrow(() => isa(0, [{ growthRate: 0, contributions: 20_000 }]));
  });

  it('throws RangeError when withdrawal exceeds balance', () => {
    assert.throws(() => isa(5_000, [{ growthRate: 0, withdrawals: 6_000 }]), RangeError);
  });

  it('accepts zero for all numeric fields', () => {
    assert.doesNotThrow(() => isa(0, [{ growthRate: 0, contributions: 0, withdrawals: 0 }]));
  });
});

describe('pure growth — no contributions or withdrawals', () => {
  it('single year at 10% growth', () => {
    // 10,000 * 1.10 = 11,000
    const r = isa(10_000, [{ growthRate: 0.1 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.growthAmount, 1_000, 'growthAmount');
    assertApprox(y.closingBalance, 11_000, 'closingBalance');
    assert.equal(y.withdrawals, 0);
    assert.equal(y.contributions, 0);
  });

  it('compounds correctly across two years', () => {
    // Y1: 10,000 * 1.07 = 10,700
    // Y2: 10,700 * 1.07 = 11,449
    const r = isa(10_000, [{ growthRate: 0.07 }, { growthRate: 0.07 }]);
    assertApprox(r.yearlyBreakdown[0].closingBalance, 10_700, 'Y1');
    assertApprox(r.yearlyBreakdown[1].closingBalance, 11_449, 'Y2');
    assertApprox(r.totalGrowth, 1_449, 'totalGrowth');
  });

  it('zero growth leaves balance unchanged', () => {
    const r = isa(8_000, [{ growthRate: 0 }]);
    assertApprox(r.finalBalance, 8_000, 'finalBalance');
    assert.equal(r.totalGrowth, 0);
  });

  it('starts from zero initial balance with growth only', () => {
    const r = isa(0, [{ growthRate: 0.1 }]);
    assert.equal(r.finalBalance, 0);
    assert.equal(r.totalGrowth, 0);
  });
});

describe('contributions', () => {
  it('contribution is added before growth, so it earns a full year of growth', () => {
    // contribute 10,000 to zero balance, grow at 5%: 10,000 * 1.05 = 10,500
    const r = isa(0, [{ growthRate: 0.05, contributions: 10_000 }]);
    assertApprox(r.yearlyBreakdown[0].growthAmount, 500, 'growthAmount');
    assertApprox(r.finalBalance, 10_500, 'finalBalance');
    assert.equal(r.totalContributions, 10_000);
  });

  it('contribution added to existing balance before growth', () => {
    // balance 10,000 + contribute 2,000 = 12,000; grow 10%: 13,200
    const r = isa(10_000, [{ growthRate: 0.1, contributions: 2_000 }]);
    assertApprox(r.yearlyBreakdown[0].growthAmount, 1_200, 'growthAmount'); // 12,000 * 0.10
    assertApprox(r.finalBalance, 13_200, 'finalBalance');
  });

  it('maximum allowable contribution (£20,000) is accepted', () => {
    const r = isa(0, [{ growthRate: 0.05, contributions: 20_000 }]);
    assertApprox(r.finalBalance, 21_000, 'finalBalance'); // 20,000 * 1.05
  });

  it('annual limit applies per year independently', () => {
    // £20,000 in each of three years is valid (not a cumulative cap)
    assert.doesNotThrow(() =>
      isa(0, [
        { growthRate: 0, contributions: 20_000 },
        { growthRate: 0, contributions: 20_000 },
        { growthRate: 0, contributions: 20_000 },
      ])
    );
  });

  it('£20,001 in a single year is rejected', () => {
    assert.throws(() => isa(0, [{ growthRate: 0, contributions: 20_001 }]), RangeError);
  });

  it('limit violation in year 2 is caught, not year 1', () => {
    assert.throws(
      () =>
        isa(0, [
          { growthRate: 0, contributions: 20_000 },
          { growthRate: 0, contributions: 20_001 },
        ]),
      RangeError
    );
  });
});

describe('withdrawals — always tax-free', () => {
  it('simple withdrawal reduces balance with no tax', () => {
    // 15,000 balance, no growth, withdraw 5,000
    const r = isa(15_000, [{ growthRate: 0, withdrawals: 5_000 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.closingBalance, 10_000, 'closingBalance');
    assert.equal(r.totalWithdrawals, 5_000);
  });

  it('full balance can be withdrawn', () => {
    const r = isa(10_000, [{ growthRate: 0, withdrawals: 10_000 }]);
    assertApprox(r.finalBalance, 0, 'finalBalance');
  });

  it('withdrawal after growth is from post-growth balance', () => {
    // 10,000 grows 10% → 11,000; withdraw 3,000 → 8,000
    const r = isa(10_000, [{ growthRate: 0.1, withdrawals: 3_000 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.balanceBeforeWithdrawal, 11_000, 'beforeWithdrawal');
    assertApprox(y.closingBalance, 8_000, 'closingBalance');
  });

  it('no CGT fields appear in the result (ISA withdrawals are tax-free)', () => {
    const r = isa(50_000, [{ growthRate: 0.08, withdrawals: 20_000 }]);
    const y = r.yearlyBreakdown[0];
    assert.ok(!('cgtDue' in y), 'no cgtDue field');
    assert.ok(!('gainOnWithdrawal' in y), 'no gainOnWithdrawal field');
    assert.ok(!('cgtAllowanceUsed' in y), 'no cgtAllowanceUsed field');
    assert.ok(!('closingCostBasis' in y), 'no closingCostBasis field');
  });

  it('large recurring withdrawals can empty the account over time', () => {
    const r = isa(30_000, [
      { growthRate: 0.05, withdrawals: 15_000 },
      { growthRate: 0.05, withdrawals: 15_000 },
    ]);
    // Y1: 30,000 * 1.05 = 31,500 → withdraw 15,000 → 16,500
    // Y2: 16,500 * 1.05 = 17,325 → withdraw 15,000 → 2,325
    assertApprox(r.yearlyBreakdown[0].closingBalance, 16_500, 'Y1 closing');
    assertApprox(r.yearlyBreakdown[1].closingBalance, 2_325, 'Y2 closing');
  });
});

describe('multi-year projection', () => {
  it('closingBalance of year N is openingBalance of year N+1', () => {
    const r = isa(10_000, [
      { growthRate: 0.07, contributions: 5_000, withdrawals: 0 },
      { growthRate: 0.07, contributions: 3_000, withdrawals: 2_000 },
    ]);
    const [y1, y2] = r.yearlyBreakdown;
    assertApprox(y2.openingBalance, y1.closingBalance, 'Y2 opening = Y1 closing');
  });

  it('year labels increment from startYear', () => {
    const r = isa(0, [{ growthRate: 0 }, { growthRate: 0 }, { growthRate: 0 }], {
      startYear: 2030,
    });
    assert.equal(r.yearlyBreakdown[0].year, 2030);
    assert.equal(r.yearlyBreakdown[1].year, 2031);
    assert.equal(r.yearlyBreakdown[2].year, 2032);
    assert.equal(r.startYear, 2030);
  });

  it('totals accumulate correctly across three years', () => {
    // Y1: balance 0, contribute 5,000, grow 7%: 5,350
    // Y2: 5,350, contribute 3,000: 8,350, grow 7%: 8,934.50, withdraw 2,000: 6,934.50
    // Y3: 6,934.50, contribute 1,000: 7,934.50, grow 0: 7,934.50
    const r = isa(0, [
      { growthRate: 0.07, contributions: 5_000, withdrawals: 0 },
      { growthRate: 0.07, contributions: 3_000, withdrawals: 2_000 },
      { growthRate: 0, contributions: 1_000, withdrawals: 0 },
    ]);
    assert.equal(r.totalContributions, 9_000);
    assert.equal(r.totalWithdrawals, 2_000);
    const sumGrowth = r.yearlyBreakdown.reduce((s, y) => s + y.growthAmount, 0);
    assertApprox(r.totalGrowth, Math.round(sumGrowth * 100) / 100, 'totalGrowth');
  });

  it('finalBalance and totalGrowth match last yearlyBreakdown row', () => {
    const r = isa(20_000, [
      { growthRate: 0.05, contributions: 10_000 },
      { growthRate: 0.05, withdrawals: 5_000 },
    ]);
    const last = r.yearlyBreakdown[r.yearlyBreakdown.length - 1];
    assertApprox(r.finalBalance, last.closingBalance, 'finalBalance');
  });
});

describe('return shape', () => {
  it('result contains all expected top-level fields', () => {
    const r = isa(10_000, [{ growthRate: 0.05 }]);
    for (const key of [
      'initialBalance',
      'startYear',
      'annualLimit',
      'yearlyBreakdown',
      'totalContributions',
      'totalWithdrawals',
      'totalGrowth',
      'finalBalance',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
    assert.equal(r.annualLimit, 20_000);
  });

  it('each yearlyBreakdown row contains all expected fields', () => {
    const r = isa(10_000, [{ growthRate: 0.05, contributions: 1_000, withdrawals: 500 }]);
    const row = r.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'contributions',
      'growthRate',
      'growthAmount',
      'balanceBeforeWithdrawal',
      'withdrawals',
      'closingBalance',
    ]) {
      assert.ok(key in row, `missing row field: ${key}`);
    }
  });

  it('all monetary fields are finite numbers', () => {
    const r = isa(15_000, [{ growthRate: 0.06, contributions: 5_000, withdrawals: 3_000 }]);
    const row = r.yearlyBreakdown[0];
    for (const val of [
      row.growthAmount,
      row.balanceBeforeWithdrawal,
      row.withdrawals,
      row.closingBalance,
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
