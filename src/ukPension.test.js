import assert from 'node:assert/strict';
import {
  PENSION_CONSTANTS,
  projectPensionAccumulation,
  calculatePCLS,
  projectPensionDrawdown,
  projectPension,
} from './ukPension.js';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PENSION_CONSTANTS', () => {
  it('annual allowance is £60,000 for 2025/26', () => {
    assert.equal(PENSION_CONSTANTS.annualAllowance, 60_000);
  });

  it('lump sum allowance is £268,275', () => {
    assert.equal(PENSION_CONSTANTS.lumpSumAllowance, 268_275);
  });

  it('max PCLS percentage is 25%', () => {
    assert.equal(PENSION_CONSTANTS.maxPCLSPercentage, 0.25);
  });
});

// ---------------------------------------------------------------------------
// projectPensionAccumulation
// ---------------------------------------------------------------------------

describe('projectPensionAccumulation — input validation', () => {
  const proj = [{ growthRate: 0.05 }];

  it('throws TypeError for non-numeric initialBalance', () => {
    assert.throws(() => projectPensionAccumulation('50000', proj), TypeError);
    assert.throws(() => projectPensionAccumulation(NaN, proj), TypeError);
    assert.throws(() => projectPensionAccumulation(null, proj), TypeError);
  });

  it('throws TypeError for negative initialBalance', () => {
    assert.throws(() => projectPensionAccumulation(-1, proj), TypeError);
  });

  it('throws TypeError for empty or non-array annualProjections', () => {
    assert.throws(() => projectPensionAccumulation(10_000, []), TypeError);
    assert.throws(() => projectPensionAccumulation(10_000, null), TypeError);
  });

  it('throws RangeError for invalid startYear', () => {
    assert.throws(() => projectPensionAccumulation(0, proj, { startYear: 1989 }), RangeError);
    assert.throws(() => projectPensionAccumulation(0, proj, { startYear: 2025.5 }), RangeError);
  });

  it('throws TypeError for negative contributions or growthRate', () => {
    assert.throws(() => projectPensionAccumulation(0, [{ growthRate: -0.01 }]), TypeError);
    assert.throws(
      () => projectPensionAccumulation(0, [{ growthRate: 0, employeeContributions: -1 }]),
      TypeError
    );
    assert.throws(
      () => projectPensionAccumulation(0, [{ growthRate: 0, employerContributions: -1 }]),
      TypeError
    );
  });

  it('throws RangeError when total contributions exceed annual allowance', () => {
    // 50,000 + 11,000 = 61,000 > 60,000
    assert.throws(
      () =>
        projectPensionAccumulation(0, [
          {
            growthRate: 0,
            employeeContributions: 50_000,
            employerContributions: 11_000,
          },
        ]),
      RangeError
    );
  });

  it('accepts total contributions exactly at the annual allowance', () => {
    assert.doesNotThrow(() =>
      projectPensionAccumulation(0, [
        {
          growthRate: 0,
          employeeContributions: 30_000,
          employerContributions: 30_000,
        },
      ])
    );
  });
});

describe('projectPensionAccumulation — growth and contributions', () => {
  it('pure growth with no contributions', () => {
    // 50,000 grows at 7% → growthAmount = 3,500, closingBalance = 53,500
    const r = projectPensionAccumulation(50_000, [{ growthRate: 0.07 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.growthAmount, 3_500, 'growthAmount');
    assertApprox(y.closingBalance, 53_500, 'closingBalance');
    assert.equal(y.employeeContributions, 0);
    assert.equal(y.employerContributions, 0);
    assert.equal(y.totalContributions, 0);
  });

  it('employee and employer contributions added before growth', () => {
    // balance 50,000; employee 5,000 + employer 3,000 = 8,000 → 58,000
    // growth 7%: 58,000 * 0.07 = 4,060; closing = 62,060
    const r = projectPensionAccumulation(50_000, [
      {
        growthRate: 0.07,
        employeeContributions: 5_000,
        employerContributions: 3_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.growthAmount, 4_060, 'growthAmount');
    assertApprox(y.closingBalance, 62_060, 'closingBalance');
    assert.equal(y.totalContributions, 8_000);
  });

  it('employer-only contributions', () => {
    // balance 0; employer 12,000 → 12,000; growth 5%: 600; closing 12,600
    const r = projectPensionAccumulation(0, [
      {
        growthRate: 0.05,
        employerContributions: 12_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.closingBalance, 12_600, 'closingBalance');
    assert.equal(y.employeeContributions, 0);
    assert.equal(y.employerContributions, 12_000);
  });

  it('zero growth: balance grows by contributions only', () => {
    const r = projectPensionAccumulation(10_000, [
      {
        growthRate: 0,
        employeeContributions: 3_000,
        employerContributions: 2_000,
      },
    ]);
    assertApprox(r.finalBalance, 15_000, 'finalBalance');
    assert.equal(r.totalGrowth, 0);
  });

  it("multi-year: closing balance feeds next year's opening balance", () => {
    const r = projectPensionAccumulation(20_000, [
      { growthRate: 0.06, employeeContributions: 4_000, employerContributions: 2_000 },
      { growthRate: 0.06, employeeContributions: 4_000, employerContributions: 2_000 },
    ]);
    const [y1, y2] = r.yearlyBreakdown;
    assertApprox(y2.openingBalance, y1.closingBalance, 'Y2 opening = Y1 closing');
  });

  it('totals accumulate correctly', () => {
    const r = projectPensionAccumulation(0, [
      { growthRate: 0, employeeContributions: 5_000, employerContributions: 3_000 },
      { growthRate: 0, employeeContributions: 6_000, employerContributions: 4_000 },
    ]);
    assert.equal(r.totalEmployeeContributions, 11_000);
    assert.equal(r.totalEmployerContributions, 7_000);
    assert.equal(r.totalContributions, 18_000);
    assert.equal(r.totalGrowth, 0);
  });

  it('annual allowance is enforced per year, not cumulatively', () => {
    // £60,000 each year for 3 years is valid
    assert.doesNotThrow(() =>
      projectPensionAccumulation(0, [
        { growthRate: 0, employeeContributions: 30_000, employerContributions: 30_000 },
        { growthRate: 0, employeeContributions: 30_000, employerContributions: 30_000 },
        { growthRate: 0, employeeContributions: 30_000, employerContributions: 30_000 },
      ])
    );
  });

  it('year labels increment from startYear', () => {
    const r = projectPensionAccumulation(0, [{ growthRate: 0 }, { growthRate: 0 }], {
      startYear: 2030,
    });
    assert.equal(r.yearlyBreakdown[0].year, 2030);
    assert.equal(r.yearlyBreakdown[1].year, 2031);
    assert.equal(r.startYear, 2030);
  });
});

describe('projectPensionAccumulation — return shape', () => {
  it('contains all expected top-level fields', () => {
    const r = projectPensionAccumulation(10_000, [{ growthRate: 0.05 }]);
    for (const key of [
      'initialBalance',
      'startYear',
      'annualAllowance',
      'yearlyBreakdown',
      'totalEmployeeContributions',
      'totalEmployerContributions',
      'totalContributions',
      'totalGrowth',
      'finalBalance',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
    assert.equal(r.annualAllowance, 60_000);
  });

  it('each yearlyBreakdown row contains all expected fields', () => {
    const r = projectPensionAccumulation(0, [{ growthRate: 0.05, employeeContributions: 1_000 }]);
    const row = r.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'employeeContributions',
      'employerContributions',
      'totalContributions',
      'growthRate',
      'growthAmount',
      'closingBalance',
    ]) {
      assert.ok(key in row, `missing row field: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// calculatePCLS
// ---------------------------------------------------------------------------

describe('calculatePCLS — input validation', () => {
  it('throws TypeError for non-numeric pensionPot', () => {
    assert.throws(() => calculatePCLS('100000'), TypeError);
    assert.throws(() => calculatePCLS(NaN), TypeError);
  });

  it('throws TypeError for negative pensionPot', () => {
    assert.throws(() => calculatePCLS(-1), TypeError);
  });

  it('throws RangeError for pclsPercentage > 0.25', () => {
    assert.throws(() => calculatePCLS(100_000, { pclsPercentage: 0.26 }), RangeError);
  });

  it('throws RangeError for negative pclsPercentage', () => {
    assert.throws(() => calculatePCLS(100_000, { pclsPercentage: -0.01 }), RangeError);
  });

  it('throws TypeError for negative pclsAmount', () => {
    assert.throws(() => calculatePCLS(100_000, { pclsAmount: -1 }), TypeError);
  });
});

describe('calculatePCLS — lump sum calculation', () => {
  it('default: 25% of pot when below the lump sum allowance', () => {
    // 100,000 * 0.25 = 25,000 < 268,275 → not capped
    const r = calculatePCLS(100_000);
    assertApprox(r.lumpSum, 25_000, 'lumpSum');
    assertApprox(r.crystallisedFund, 75_000, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, false);
    assert.equal(r.requestedLumpSum, 25_000);
  });

  it('25% of a large pot is capped at the lump sum allowance (£268,275)', () => {
    // 1,500,000 * 0.25 = 375,000 > 268,275 → capped
    const r = calculatePCLS(1_500_000);
    assertApprox(r.requestedLumpSum, 375_000, 'requestedLumpSum');
    assertApprox(r.lumpSum, 268_275, 'lumpSum (capped)');
    assertApprox(r.crystallisedFund, 1_231_725, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, true);
  });

  it('custom pclsPercentage below 25%', () => {
    // 200,000 * 0.10 = 20,000
    const r = calculatePCLS(200_000, { pclsPercentage: 0.1 });
    assertApprox(r.lumpSum, 20_000, 'lumpSum');
    assertApprox(r.crystallisedFund, 180_000, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, false);
  });

  it('pclsPercentage of 0 takes no lump sum', () => {
    const r = calculatePCLS(100_000, { pclsPercentage: 0 });
    assert.equal(r.lumpSum, 0);
    assertApprox(r.crystallisedFund, 100_000, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, false);
  });

  it('fixed pclsAmount below 25% of pot', () => {
    // request £15,000 from a £100,000 pot
    const r = calculatePCLS(100_000, { pclsAmount: 15_000 });
    assertApprox(r.requestedLumpSum, 15_000, 'requestedLumpSum');
    assertApprox(r.lumpSum, 15_000, 'lumpSum');
    assertApprox(r.crystallisedFund, 85_000, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, false);
  });

  it('fixed pclsAmount above the lump sum allowance is capped', () => {
    // request £300,000, cap at £268,275
    const r = calculatePCLS(2_000_000, { pclsAmount: 300_000 });
    assertApprox(r.lumpSum, 268_275, 'lumpSum');
    assertApprox(r.crystallisedFund, 1_731_725, 'crystallisedFund');
    assert.equal(r.lumpSumCapped, true);
  });

  it('pot smaller than lump sum allowance: lumpSum capped at pot size', () => {
    const r = calculatePCLS(10_000);
    // 25% = 2,500; under allowance; not capped
    assertApprox(r.lumpSum, 2_500, 'lumpSum');
    assert.equal(r.lumpSumCapped, false);
  });

  it('lumpSum + crystallisedFund always equals pensionPot', () => {
    for (const pot of [50_000, 200_000, 500_000, 1_200_000]) {
      const r = calculatePCLS(pot);
      assertApprox(r.lumpSum + r.crystallisedFund, pot, `pot=${pot}`);
    }
  });

  it('result includes lumpSumAllowance and taxYear', () => {
    const r = calculatePCLS(100_000);
    assert.equal(r.lumpSumAllowance, 268_275);
    assert.equal(r.taxYear, '2025/26');
  });
});

// ---------------------------------------------------------------------------
// projectPensionDrawdown
// ---------------------------------------------------------------------------

describe('projectPensionDrawdown — input validation', () => {
  const proj = [{ growthRate: 0.04, annualDrawdown: 10_000 }];

  it('throws TypeError for non-numeric initialFund', () => {
    assert.throws(() => projectPensionDrawdown('75000', proj), TypeError);
    assert.throws(() => projectPensionDrawdown(null, proj), TypeError);
  });

  it('throws TypeError for negative initialFund', () => {
    assert.throws(() => projectPensionDrawdown(-1, proj), TypeError);
  });

  it('throws TypeError for empty or non-array annualProjections', () => {
    assert.throws(() => projectPensionDrawdown(75_000, []), TypeError);
    assert.throws(() => projectPensionDrawdown(75_000, null), TypeError);
  });

  it('throws RangeError when drawdown exceeds balance', () => {
    assert.throws(
      () => projectPensionDrawdown(10_000, [{ growthRate: 0, annualDrawdown: 11_000 }]),
      RangeError
    );
  });

  it('throws TypeError for negative annualDrawdown, otherIncome, or growthRate', () => {
    assert.throws(
      () => projectPensionDrawdown(50_000, [{ growthRate: -0.01, annualDrawdown: 0 }]),
      TypeError
    );
    assert.throws(
      () => projectPensionDrawdown(50_000, [{ growthRate: 0, annualDrawdown: -1 }]),
      TypeError
    );
    assert.throws(
      () => projectPensionDrawdown(50_000, [{ growthRate: 0, annualDrawdown: 0, otherIncome: -1 }]),
      TypeError
    );
  });
});

describe('projectPensionDrawdown — tax-free drawdown (within personal allowance)', () => {
  it('drawdown below PA with no other income: no tax', () => {
    // PA = £12,570; draw £10,000 — fully within PA, taxOnDrawdown = 0
    const r = projectPensionDrawdown(100_000, [{ growthRate: 0.05, annualDrawdown: 10_000 }]);
    const y = r.yearlyBreakdown[0];
    // growth: 100,000 * 0.05 = 5,000 → balanceBefore = 105,000
    assertApprox(y.growthAmount, 5_000, 'growthAmount');
    assertApprox(y.balanceBeforeDrawdown, 105_000, 'balanceBefore');
    assert.equal(y.taxOnDrawdown, 0);
    assertApprox(y.netDrawdown, 10_000, 'netDrawdown');
    assertApprox(y.closingBalance, 95_000, 'closingBalance');
  });

  it('drawdown exactly at PA boundary (£12,570) with no other income: no tax', () => {
    const r = projectPensionDrawdown(200_000, [{ growthRate: 0, annualDrawdown: 12_570 }]);
    assert.equal(r.yearlyBreakdown[0].taxOnDrawdown, 0);
    assertApprox(r.yearlyBreakdown[0].netDrawdown, 12_570, 'netDrawdown');
  });
});

describe('projectPensionDrawdown — taxable drawdown, no other income', () => {
  it('drawdown above PA: basic rate tax applies to the excess', () => {
    // draw £20,000, no other income
    // taxable = 20,000 - 12,570 = 7,430; tax = 7,430 * 0.20 = 1,486
    const r = projectPensionDrawdown(300_000, [{ growthRate: 0, annualDrawdown: 20_000 }]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.taxOnDrawdown, 1_486, 'taxOnDrawdown');
    assertApprox(y.netDrawdown, 18_514, 'netDrawdown');
  });
});

describe('projectPensionDrawdown — taxable drawdown, with other income', () => {
  it('other income uses part of PA; drawdown taxed at marginal rate on remainder', () => {
    // otherIncome = 10,000 (within PA, no tax on its own)
    // drawdown = 15,000 → combined = 25,000
    // taxOnTotal = (25,000 - 12,570) * 0.20 = 12,430 * 0.20 = 2,486
    // taxOnOther = 0
    // taxOnDrawdown = 2,486
    const r = projectPensionDrawdown(300_000, [
      {
        growthRate: 0,
        annualDrawdown: 15_000,
        otherIncome: 10_000,
      },
    ]);
    const y = r.yearlyBreakdown[0];
    assertApprox(y.taxOnDrawdown, 2_486, 'taxOnDrawdown');
    assertApprox(y.netDrawdown, 12_514, 'netDrawdown');
  });

  it('other income above PA: drawdown taxed at basic rate from first pound', () => {
    // otherIncome = 20,000 → taxOnOther = (20,000 - 12,570) * 0.20 = 1,486
    // drawdown = 5,000 → combined = 25,000
    // taxOnTotal = (25,000 - 12,570) * 0.20 = 2,486
    // taxOnDrawdown = 2,486 - 1,486 = 1,000 (= 5,000 * 0.20)
    const r = projectPensionDrawdown(200_000, [
      {
        growthRate: 0,
        annualDrawdown: 5_000,
        otherIncome: 20_000,
      },
    ]);
    assertApprox(r.yearlyBreakdown[0].taxOnDrawdown, 1_000, 'taxOnDrawdown');
    assertApprox(r.yearlyBreakdown[0].netDrawdown, 4_000, 'netDrawdown');
  });

  it('drawdown pushing into higher rate band is taxed at 40% on the excess', () => {
    // otherIncome = 20,000, drawdown = 50,000 → combined = 70,000
    // taxOnTotal(70,000):
    //   basic: 37,700 * 0.20 = 7,540; higher: (70,000-12,570-37,700)*0.40 = 19,730*0.40 = 7,892
    //   total = 15,432
    // taxOnOther(20,000) = (20,000-12,570)*0.20 = 1,486
    // taxOnDrawdown = 15,432 - 1,486 = 13,946
    const r = projectPensionDrawdown(500_000, [
      {
        growthRate: 0,
        annualDrawdown: 50_000,
        otherIncome: 20_000,
      },
    ]);
    assertApprox(r.yearlyBreakdown[0].taxOnDrawdown, 13_946, 'taxOnDrawdown');
  });
});

describe('projectPensionDrawdown — multi-year and totals', () => {
  it("closing balance feeds next year's opening balance", () => {
    const r = projectPensionDrawdown(200_000, [
      { growthRate: 0.05, annualDrawdown: 15_000 },
      { growthRate: 0.05, annualDrawdown: 15_000 },
    ]);
    const [y1, y2] = r.yearlyBreakdown;
    assertApprox(y2.openingBalance, y1.closingBalance, 'Y2 opening = Y1 closing');
  });

  it('zero drawdown year: balance grows, no tax', () => {
    const r = projectPensionDrawdown(100_000, [{ growthRate: 0.06, annualDrawdown: 0 }]);
    const y = r.yearlyBreakdown[0];
    assert.equal(y.annualDrawdown, 0);
    assert.equal(y.taxOnDrawdown, 0);
    assert.equal(y.netDrawdown, 0);
    assertApprox(y.closingBalance, 106_000, 'closingBalance');
  });

  it('totals are summed correctly across years', () => {
    const r = projectPensionDrawdown(300_000, [
      { growthRate: 0, annualDrawdown: 20_000, otherIncome: 0 },
      { growthRate: 0, annualDrawdown: 20_000, otherIncome: 0 },
    ]);
    assert.equal(r.totalGrossDrawdown, 40_000);
    // each year: (20,000-12,570)*0.20 = 1,486 tax
    assertApprox(r.totalTaxPaid, 2_972, 'totalTaxPaid');
    assertApprox(r.totalNetDrawdown, 37_028, 'totalNetDrawdown');
    assertApprox(r.totalNetDrawdown, r.totalGrossDrawdown - r.totalTaxPaid, 'net = gross - tax');
  });

  it('year labels increment from startYear', () => {
    const r = projectPensionDrawdown(
      100_000,
      [
        { growthRate: 0, annualDrawdown: 5_000 },
        { growthRate: 0, annualDrawdown: 5_000 },
      ],
      { startYear: 2055 }
    );
    assert.equal(r.yearlyBreakdown[0].year, 2055);
    assert.equal(r.yearlyBreakdown[1].year, 2056);
  });

  it('finalBalance matches last closingBalance in yearlyBreakdown', () => {
    const r = projectPensionDrawdown(150_000, [
      { growthRate: 0.04, annualDrawdown: 10_000 },
      { growthRate: 0.04, annualDrawdown: 10_000 },
      { growthRate: 0.04, annualDrawdown: 10_000 },
    ]);
    const last = r.yearlyBreakdown[r.yearlyBreakdown.length - 1];
    assertApprox(r.finalBalance, last.closingBalance, 'finalBalance');
  });
});

describe('projectPensionDrawdown — return shape', () => {
  it('contains all expected top-level fields', () => {
    const r = projectPensionDrawdown(100_000, [{ growthRate: 0.04, annualDrawdown: 10_000 }]);
    for (const key of [
      'initialFund',
      'startYear',
      'yearlyBreakdown',
      'totalGrowth',
      'totalGrossDrawdown',
      'totalTaxPaid',
      'totalNetDrawdown',
      'finalBalance',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
  });

  it('each yearlyBreakdown row contains all expected fields', () => {
    const r = projectPensionDrawdown(100_000, [{ growthRate: 0.04, annualDrawdown: 10_000 }]);
    const row = r.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'growthRate',
      'growthAmount',
      'balanceBeforeDrawdown',
      'annualDrawdown',
      'otherIncome',
      'taxOnDrawdown',
      'netDrawdown',
      'closingBalance',
    ]) {
      assert.ok(key in row, `missing row field: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// projectPension — combined lifecycle
// ---------------------------------------------------------------------------

describe('projectPension — accumulation + PCLS + drawdown', () => {
  it('threads correctly: accumulation → PCLS → drawdown', () => {
    // Accumulate for 2 years starting from 100,000
    // Y1: +8,000 contributions, 7% growth: (108,000)*1.07 = 115,560
    // Y2: +8,000 contributions, 7% growth: (123,560)*1.07 = 132,209.20
    // PCLS: 25% of 132,209.20 = 33,052.30 → crystallised = 99,156.90
    // Drawdown Y1: 5% growth (99,156.90*1.05 = 104,114.75), draw 15,000
    const r = projectPension(
      100_000,
      [
        { growthRate: 0.07, employeeContributions: 5_000, employerContributions: 3_000 },
        { growthRate: 0.07, employeeContributions: 5_000, employerContributions: 3_000 },
      ],
      { takePCLS: true, pclsPercentage: 0.25 },
      [{ growthRate: 0.05, annualDrawdown: 15_000, otherIncome: 0 }],
      { startYear: 2025 }
    );

    assertApprox(r.accumulation.finalBalance, 132_209.2, 'accumulation finalBalance');
    assertApprox(r.retirement.lumpSum, 33_052.3, 'lumpSum');
    assertApprox(r.retirement.crystallisedFund, 99_156.9, 'crystallisedFund');
    assert.equal(r.retirement.lumpSumCapped, false);
    assert.equal(r.retirement.year, 2027);
    // drawdown starts from crystallisedFund = 99,156.90
    assertApprox(r.drawdown.initialFund, 99_156.9, 'drawdown initialFund');
    assertApprox(r.drawdown.yearlyBreakdown[0].year, 2027, 'drawdown startYear');
  });

  it('takePCLS: false — full pot enters drawdown untouched', () => {
    const r = projectPension(200_000, [], { takePCLS: false }, [
      { growthRate: 0, annualDrawdown: 10_000 },
    ]);
    assert.equal(r.retirement.lumpSum, 0);
    assertApprox(r.retirement.crystallisedFund, 200_000, 'crystallisedFund = full pot');
    assertApprox(r.drawdown.initialFund, 200_000, 'drawdown starts with full pot');
  });

  it('no accumulation (empty array): initialBalance is the pot at retirement', () => {
    const r = projectPension(150_000, [], { takePCLS: true }, [
      { growthRate: 0, annualDrawdown: 5_000 },
    ]);
    assertApprox(r.retirement.pensionPot, 150_000, 'pot at retirement');
    assertApprox(r.retirement.lumpSum, 37_500, 'lumpSum');
    assertApprox(r.retirement.crystallisedFund, 112_500, 'crystallisedFund');
    assert.equal(r.accumulation, null);
  });

  it('no drawdown (empty array): drawdown is null', () => {
    const r = projectPension(100_000, [{ growthRate: 0.05 }], { takePCLS: true }, []);
    assert.equal(r.drawdown, null);
    assert.ok(r.retirement.crystallisedFund > 0);
  });

  it('lumpSum from large pot is capped at £268,275 in the combined lifecycle', () => {
    const r = projectPension(2_000_000, [], { takePCLS: true }, []);
    assertApprox(r.retirement.lumpSum, 268_275, 'lumpSum capped');
    assert.equal(r.retirement.lumpSumCapped, true);
  });

  it('retirement year = startYear + length of accumulation projections', () => {
    const r = projectPension(
      10_000,
      [{ growthRate: 0 }, { growthRate: 0 }, { growthRate: 0 }],
      {},
      [],
      { startYear: 2030 }
    );
    assert.equal(r.retirement.year, 2033);
  });
});

describe('projectPension — return shape', () => {
  it('result contains all expected top-level fields', () => {
    const r = projectPension(50_000, [{ growthRate: 0.05 }], {}, []);
    for (const key of [
      'initialBalance',
      'startYear',
      'accumulation',
      'retirement',
      'drawdown',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
