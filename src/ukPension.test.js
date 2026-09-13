import assert from 'node:assert/strict';
import {
  PENSION_CONSTANTS,
  taperedAnnualAllowance,
  optimalEmployeePensionContribution,
  projectPensionAccumulation,
  calculatePCLS,
  projectPensionDrawdown,
  projectPension,
} from './ukPension.js';
import { INCOME_TAX_BANDS } from './ukIncomeTax.js';

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

  it('taper limits are £200k threshold / £260k adjusted, £10k floor', () => {
    assert.equal(PENSION_CONSTANTS.taperThresholdIncomeLimit, 200_000);
    assert.equal(PENSION_CONSTANTS.taperAdjustedIncomeLimit, 260_000);
    assert.equal(PENSION_CONSTANTS.minAnnualAllowance, 10_000);
  });
});

describe('taperedAnnualAllowance', () => {
  it('full £60,000 allowance below both limits', () => {
    assert.equal(taperedAnnualAllowance(150_000, 180_000), 60_000);
  });

  it('no taper when threshold income is at or below £200,000', () => {
    // adjusted income high, but threshold income protected
    assert.equal(taperedAnnualAllowance(200_000, 300_000), 60_000);
  });

  it('no taper when adjusted income is at or below £260,000', () => {
    assert.equal(taperedAnnualAllowance(250_000, 260_000), 60_000);
  });

  it('reduces £1 per £2 of adjusted income above £260,000', () => {
    // £300,000 adjusted → excess 40,000 → reduction 20,000 → AA 40,000
    assert.equal(taperedAnnualAllowance(250_000, 300_000), 40_000);
  });

  it('floors at £10,000 for adjusted income of £360,000 or more', () => {
    assert.equal(taperedAnnualAllowance(300_000, 360_000), 10_000);
    assert.equal(taperedAnnualAllowance(400_000, 500_000), 10_000);
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

  it('throws TypeError for negative contributions', () => {
    assert.throws(
      () => projectPensionAccumulation(0, [{ growthRate: 0, employeeContributions: -1 }]),
      TypeError
    );
    assert.throws(
      () => projectPensionAccumulation(0, [{ growthRate: 0, employerContributions: -1 }]),
      TypeError
    );
  });

  it('accepts negative growthRate (falling markets), rejects below −100%', () => {
    assert.doesNotThrow(() => projectPensionAccumulation(10_000, [{ growthRate: -0.2 }]));
    assert.throws(() => projectPensionAccumulation(10_000, [{ growthRate: -1.5 }]), TypeError);
  });

  it('negative growth reduces the pot', () => {
    const r = projectPensionAccumulation(10_000, [{ growthRate: -0.1 }]);
    assertApprox(r.finalBalance, 9_000, 'pot after −10%');
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

  it('accepts negative growthRate in drawdown, rejects below −100%', () => {
    assert.doesNotThrow(() =>
      projectPensionDrawdown(50_000, [{ growthRate: -0.2, annualDrawdown: 0 }])
    );
    assert.throws(
      () => projectPensionDrawdown(50_000, [{ growthRate: -1.5, annualDrawdown: 0 }]),
      TypeError
    );
  });

  it('throws TypeError for negative annualDrawdown or otherIncome', () => {
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
// optimalEmployeePensionContribution
// ---------------------------------------------------------------------------

const HRT = INCOME_TAX_BANDS.basicRateLimit; // £50,270 higher-rate threshold
const TAPER = INCOME_TAX_BANDS.taperThreshold; // £100,000 personal-allowance taper start
const PA = INCOME_TAX_BANDS.personalAllowance; // £12,570

describe('optimalEmployeePensionContribution — input validation', () => {
  it('throws TypeError for a non-numeric or negative grossIncome', () => {
    assert.throws(() => optimalEmployeePensionContribution('50000', 0.03), TypeError);
    assert.throws(() => optimalEmployeePensionContribution(NaN, 0.03), TypeError);
    assert.throws(() => optimalEmployeePensionContribution(-1, 0.03), TypeError);
  });

  it('throws RangeError for an employerRate outside [0, 1]', () => {
    assert.throws(() => optimalEmployeePensionContribution(50_000, -0.01), RangeError);
    assert.throws(() => optimalEmployeePensionContribution(50_000, 1.01), RangeError);
    assert.throws(() => optimalEmployeePensionContribution(50_000, NaN), RangeError);
  });

  it('throws RangeError for a non-positive scaleFactor', () => {
    assert.throws(
      () => optimalEmployeePensionContribution(50_000, 0.03, { scaleFactor: 0 }),
      RangeError
    );
    assert.throws(
      () => optimalEmployeePensionContribution(50_000, 0.03, { scaleFactor: -1 }),
      RangeError
    );
  });

  it('throws RangeError for a negative targetIncome override', () => {
    assert.throws(
      () => optimalEmployeePensionContribution(50_000, 0.03, { targetIncome: -1 }),
      RangeError
    );
  });
});

describe('optimalEmployeePensionContribution — income below £100,000 (allowance safe)', () => {
  it('recommends nothing when income is well below £100,000', () => {
    // £45,000 keeps the full personal allowance already — nothing to protect.
    const r = optimalEmployeePensionContribution(45_000, 0.03);
    assert.equal(r.employeeContribution, 0);
    assert.equal(r.employeeRate, 0);
    assert.equal(r.adjustedGrossIncome, 45_000);
    assert.deepEqual(r.bandsCleared, []);
    assert.equal(r.cappedByAllowance, false);
  });

  it('recommends nothing at a higher-rate salary that is still under £100,000', () => {
    // £70,000 is a higher-rate taxpayer, but the personal allowance is intact,
    // so there is nothing for this optimiser to do.
    const r = optimalEmployeePensionContribution(70_000, 0.03);
    assert.equal(r.employeeContribution, 0);
    assert.deepEqual(r.bandsCleared, []);
  });

  it('recommends nothing when income sits exactly at £100,000', () => {
    const r = optimalEmployeePensionContribution(TAPER, 0.03);
    assert.equal(r.employeeContribution, 0);
    assertApprox(r.adjustedGrossIncome, TAPER, 'adjustedGrossIncome');
    assert.deepEqual(r.bandsCleared, []);
  });
});

describe('optimalEmployeePensionContribution — protecting the personal allowance', () => {
  it('sacrifices down to £100,000 when income runs into the taper zone', () => {
    // £110,000 → sacrifice £10,000 to reach £100,000, reclaiming the full PA.
    const r = optimalEmployeePensionContribution(110_000, 0.03);
    assertApprox(r.employeeContribution, 10_000, 'employeeContribution');
    assertApprox(r.adjustedGrossIncome, TAPER, 'adjustedGrossIncome');
    assert.deepEqual(r.bandsCleared, ['paTaper']);
    assert.equal(r.cappedByAllowance, false);
  });

  it('sacrifices the whole taper band from the top (income at £125,140)', () => {
    // At £125,140 the allowance is fully gone; bringing income to £100,000
    // (a £25,140 sacrifice) restores all of it.
    const r = optimalEmployeePensionContribution(125_140, 0.03);
    assertApprox(r.employeeContribution, 125_140 - TAPER, 'employeeContribution');
    assertApprox(r.adjustedGrossIncome, TAPER, 'adjustedGrossIncome');
    assert.ok(r.bandsCleared.includes('paTaper'));
    assert.equal(r.cappedByAllowance, false);
  });

  it('reaches £100,000 from an additional-rate salary when the allowance allows', () => {
    // £150k → £50,000 sacrifice to £100,000; + 3% employer £4,500 = £54,500 < £60k.
    const r = optimalEmployeePensionContribution(150_000, 0.03);
    assertApprox(r.adjustedGrossIncome, TAPER, 'adjustedGrossIncome');
    assertApprox(r.employeeContribution, 50_000, 'employeeContribution');
    assert.ok(r.bandsCleared.includes('paTaper'));
    assert.ok(r.bandsCleared.includes('additionalRate'));
    assert.equal(r.cappedByAllowance, false);
  });

  it('does not sacrifice into the higher-rate band below £100,000', () => {
    // The target is £100,000, never £50,270 — a £110k earner keeps their
    // higher-rate-band income as take-home.
    const r = optimalEmployeePensionContribution(110_000, 0.03);
    assert.ok(!r.bandsCleared.includes('higherRate'));
    assert.ok(r.adjustedGrossIncome >= TAPER - 0.01, 'never sacrifices below £100k for tax');
  });
});

describe('optimalEmployeePensionContribution — annual-allowance cap', () => {
  it('never lets employee + employer exceed the £60,000 allowance', () => {
    for (const [g, er] of [
      [150_000, 0.05],
      [250_000, 0.05],
      [300_000, 0.03],
    ]) {
      const r = optimalEmployeePensionContribution(g, er);
      assert.ok(
        r.totalContribution <= r.annualAllowance + 0.01,
        `gross ${g}: total ${r.totalContribution} exceeds allowance ${r.annualAllowance}`
      );
    }
  });

  it('leaves part of the personal allowance unrecovered when the allowance binds', () => {
    // £300k, employer 3% = £9,000 → adjusted income for taper = £309,000.
    // Excess over £260k = £49,000 → reduction £24,500 → allowance £35,500.
    // Employee capped at £35,500 − £9,000 = £26,500, so adjusted pay is far
    // above £100,000 and the allowance cannot be fully reclaimed.
    const r = optimalEmployeePensionContribution(300_000, 0.03);
    assertApprox(r.annualAllowance, 35_500, 'annualAllowance');
    assertApprox(r.employeeContribution, 35_500 - 9_000, 'employeeContribution');
    assert.ok(r.adjustedGrossIncome > TAPER, 'cannot reach the £100k target');
    assert.equal(r.cappedByAllowance, true);
  });

  it('recommends zero when the employer contribution alone fills the allowance', () => {
    // employer 60% of £150k = £90,000 > allowance, so no room for the employee.
    const r = optimalEmployeePensionContribution(150_000, 0.6);
    assert.equal(r.employeeContribution, 0);
    assert.equal(r.employeeRate, 0);
    assert.equal(r.cappedByAllowance, true);
  });
});

describe('optimalEmployeePensionContribution — fiscal drag (scaleFactor)', () => {
  it('scales the £100,000 target with the scale factor', () => {
    const sf = 0.9; // compressed bands (more drag) → lower thresholds
    const scaledTaper = Math.round(TAPER * sf * 100) / 100;
    // Gross chosen to sit above the scaled taper so a sacrifice is needed.
    const r = optimalEmployeePensionContribution(100_000, 0.03, { scaleFactor: sf });
    assertApprox(r.targetIncome, scaledTaper, 'targetIncome');
    assertApprox(r.adjustedGrossIncome, scaledTaper, 'adjustedGrossIncome');
  });
});

describe('optimalEmployeePensionContribution — targetIncome override', () => {
  it('honours a custom target below the default (e.g. the higher-rate threshold)', () => {
    // Override to strip out higher-rate tax too: target £50,270.
    const r = optimalEmployeePensionContribution(90_000, 0.03, { targetIncome: HRT });
    assertApprox(r.adjustedGrossIncome, HRT, 'adjustedGrossIncome');
    assertApprox(r.employeeContribution, 90_000 - HRT, 'employee');
  });

  it('floors a below-personal-allowance target at the personal allowance', () => {
    const r = optimalEmployeePensionContribution(40_000, 0.03, { targetIncome: 0 });
    assert.equal(r.targetIncome, PA);
    assertApprox(r.adjustedGrossIncome, PA, 'adjustedGrossIncome');
  });
});

describe('optimalEmployeePensionContribution — employer matching', () => {
  it('validates employerMatch is a boolean', () => {
    assert.throws(
      () => optimalEmployeePensionContribution(50_000, 0.03, { employerMatch: 'yes' }),
      TypeError
    );
  });

  it('reports whether matching was applied', () => {
    assert.equal(optimalEmployeePensionContribution(70_000, 0.03).employerMatched, false);
    assert.equal(
      optimalEmployeePensionContribution(70_000, 0.03, { employerMatch: true }).employerMatched,
      true
    );
  });

  it('a basic-rate taxpayer contributes up to the match cap to capture free money', () => {
    // Unconditional: 0% is tax-optimal. Matched: contribute the 3% cap so the
    // employer matches it — the free money dwarfs the relief forgone.
    const unconditional = optimalEmployeePensionContribution(45_000, 0.03);
    assert.equal(unconditional.employeeContribution, 0);

    const matched = optimalEmployeePensionContribution(45_000, 0.03, { employerMatch: true });
    assertApprox(matched.employeeRate, 0.03, 'employeeRate matches the cap');
    assertApprox(matched.employeeContribution, 45_000 * 0.03, 'employeeContribution');
    assertApprox(matched.employerContribution, 45_000 * 0.03, 'employerContribution (full match)');
    assertApprox(matched.totalContribution, 45_000 * 0.06, 'total is employee + equal match');
    assert.equal(matched.cappedByAllowance, false);
  });

  it('an earner whose PA-protecting sacrifice exceeds the cap captures the full match', () => {
    // £150k → £50,000 sacrifice to reach £100,000, far above the 3% cap, so the
    // employer pays its full 3%.
    const r = optimalEmployeePensionContribution(150_000, 0.03, { employerMatch: true });
    assertApprox(r.adjustedGrossIncome, TAPER, 'still targets £100,000');
    assertApprox(r.effectiveEmployerRate, 0.03, 'employer pays the full 3% cap');
    assertApprox(r.employerContribution, 150_000 * 0.03, 'employerContribution');
  });

  it('matching with a zero employer cap behaves like no employer contribution', () => {
    const matched = optimalEmployeePensionContribution(120_000, 0, { employerMatch: true });
    assert.equal(matched.employerContribution, 0);
    assertApprox(matched.adjustedGrossIncome, TAPER, 'targets £100,000');
  });

  it('caps the match at half the allowance when matching the full cap would breach it', () => {
    // 40% match cap on £100k = £40,000. Matching it needs £40k employee + £40k
    // employer = £80k > £60k allowance. The solver settles at £30k each side
    // (allowance ÷ 2), the most the allowance permits, and flags the cap.
    const r = optimalEmployeePensionContribution(100_000, 0.4, { employerMatch: true });
    assertApprox(r.employeeContribution, 30_000, 'employee = allowance / 2');
    assertApprox(r.employerContribution, 30_000, 'employer = allowance / 2');
    assertApprox(r.totalContribution, PENSION_CONSTANTS.annualAllowance, 'total = allowance');
    assert.ok(r.effectiveEmployerRate < r.employerRate, 'match is partial (below the 40% cap)');
    assert.equal(r.cappedByAllowance, true);
  });

  it('never lets a matched total exceed the annual allowance', () => {
    for (const [g, er] of [
      [80_000, 0.1],
      [150_000, 0.06],
      [250_000, 0.2],
      [300_000, 0.05],
    ]) {
      const r = optimalEmployeePensionContribution(g, er, { employerMatch: true });
      assert.ok(
        r.totalContribution <= r.annualAllowance + 0.01,
        `gross ${g}, cap ${er}: total ${r.totalContribution} exceeds allowance ${r.annualAllowance}`
      );
    }
  });
});

describe('optimalEmployeePensionContribution — result shape', () => {
  it('returns all documented fields and the tax year', () => {
    const r = optimalEmployeePensionContribution(70_000, 0.03);
    for (const key of [
      'grossIncome',
      'employerRate',
      'employerMatched',
      'targetIncome',
      'employeeRate',
      'employeeContribution',
      'employerContribution',
      'effectiveEmployerRate',
      'totalContribution',
      'adjustedGrossIncome',
      'annualAllowance',
      'cappedByAllowance',
      'bandsCleared',
      'scaleFactor',
      'taxYear',
    ]) {
      assert.ok(key in r, `missing field: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
    assert.ok(Array.isArray(r.bandsCleared));
  });

  it('handles a zero gross income without dividing by zero', () => {
    const r = optimalEmployeePensionContribution(0, 0.03);
    assert.equal(r.employeeContribution, 0);
    assert.equal(r.employeeRate, 0);
    assert.equal(r.employerContribution, 0);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
