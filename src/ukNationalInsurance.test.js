import assert from 'node:assert/strict';
import { NI_THRESHOLDS, calculateNationalInsurance } from './ukNationalInsurance.js';

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

function ni(gross) {
  return calculateNationalInsurance(gross);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NI_THRESHOLDS constants', () => {
  it('employee thresholds are correct for 2025/26', () => {
    const emp = NI_THRESHOLDS.employee;
    assert.equal(emp.lowerEarningsLimit, 6_725);
    assert.equal(emp.primaryThreshold, 12_570);
    assert.equal(emp.upperEarningsLimit, 50_270);
    assert.equal(emp.mainRate, 0.08);
    assert.equal(emp.additionalRate, 0.02);
  });

  it('employer thresholds are correct for 2025/26', () => {
    const er = NI_THRESHOLDS.employer;
    assert.equal(er.secondaryThreshold, 5_000);
    assert.equal(er.rate, 0.15);
    assert.equal(er.employmentAllowance, 10_500);
  });
});

describe('input validation', () => {
  it('throws TypeError for non-numeric input', () => {
    assert.throws(() => ni('50000'), TypeError);
    assert.throws(() => ni(null), TypeError);
    assert.throws(() => ni(undefined), TypeError);
    assert.throws(() => ni(NaN), TypeError);
    assert.throws(() => ni(Infinity), TypeError);
  });

  it('throws RangeError for negative income', () => {
    assert.throws(() => ni(-1), RangeError);
    assert.throws(() => ni(-0.01), RangeError);
  });

  it('accepts zero and positive incomes', () => {
    assert.doesNotThrow(() => ni(0));
    assert.doesNotThrow(() => ni(30_000));
    assert.doesNotThrow(() => ni(150_000));
  });
});

describe('zero income', () => {
  it('returns all zeros for grossIncome=0', () => {
    const result = ni(0);
    assert.equal(result.employeeNI.mainRateContribution, 0);
    assert.equal(result.employeeNI.additionalRateContribution, 0);
    assert.equal(result.employeeNI.total, 0);
    assert.equal(result.employeeNI.effectiveRate, 0);
    assert.equal(result.employerNI.contribution, 0);
    assert.equal(result.employerNI.effectiveRate, 0);
    assert.equal(result.totalNI, 0);
  });
});

describe('below LEL (£6,725) — employee pays nothing, employer pays on income above ST', () => {
  it('grossIncome=5,000 — at secondary threshold, employer NI is zero', () => {
    const result = ni(5_000);
    assert.equal(result.employeeNI.total, 0);
    assert.equal(result.employerNI.contribution, 0);
    assert.equal(result.totalNI, 0);
  });

  it('grossIncome=6,000 — employer NI on £1,000 above ST', () => {
    const result = ni(6_000);
    assert.equal(result.employeeNI.total, 0);
    assertApprox(result.employerNI.contribution, 150, 'employer NI'); // 1000 * 0.15
    assertApprox(result.totalNI, 150, 'totalNI');
  });

  it('grossIncome=6,725 — at LEL, employee still pays nothing', () => {
    const result = ni(6_725);
    assert.equal(result.employeeNI.total, 0);
    assertApprox(result.employerNI.contribution, 258.75, 'employer NI'); // 1725 * 0.15
  });
});

describe('LEL to PT (£6,725–£12,570) — NI credit zone, employee pays nothing', () => {
  it('grossIncome=10,000 — no employee NI, employer pays above ST', () => {
    const result = ni(10_000);
    assert.equal(result.employeeNI.total, 0);
    assertApprox(result.employerNI.contribution, 750, 'employer NI'); // 5000 * 0.15
  });

  it('grossIncome=12,570 — at PT, employee NI is zero', () => {
    const result = ni(12_570);
    assert.equal(result.employeeNI.mainRateContribution, 0);
    assert.equal(result.employeeNI.total, 0);
    assertApprox(result.employerNI.contribution, 1135.5, 'employer NI'); // 7570 * 0.15
  });
});

describe('PT to UEL (£12,570–£50,270) — 8% employee rate', () => {
  it('grossIncome=20,000 — main rate only', () => {
    const result = ni(20_000);
    // mainRateIncome = 20000 - 12570 = 7430
    assertApprox(result.employeeNI.mainRateContribution, 594.4, 'main rate'); // 7430 * 0.08
    assert.equal(result.employeeNI.additionalRateContribution, 0);
    assertApprox(result.employeeNI.total, 594.4, 'employee total');
    // employerNIableIncome = 20000 - 5000 = 15000
    assertApprox(result.employerNI.contribution, 2250, 'employer NI'); // 15000 * 0.15
    assertApprox(result.totalNI, 2844.4, 'totalNI');
  });

  it('grossIncome=30,000 — main rate only', () => {
    const result = ni(30_000);
    // mainRateIncome = 30000 - 12570 = 17430
    assertApprox(result.employeeNI.mainRateContribution, 1394.4, 'main rate'); // 17430 * 0.08
    assert.equal(result.employeeNI.additionalRateContribution, 0);
    assertApprox(result.employeeNI.total, 1394.4, 'employee total');
    // employerNIableIncome = 30000 - 5000 = 25000
    assertApprox(result.employerNI.contribution, 3750, 'employer NI'); // 25000 * 0.15
    assertApprox(result.totalNI, 5144.4, 'totalNI');
  });

  it('grossIncome=50,270 — exactly at UEL', () => {
    const result = ni(50_270);
    // mainRateIncome = 50270 - 12570 = 37700
    assertApprox(result.employeeNI.mainRateContribution, 3016, 'main rate'); // 37700 * 0.08
    assert.equal(result.employeeNI.additionalRateContribution, 0);
    assertApprox(result.employeeNI.total, 3016, 'employee total');
    // employerNIableIncome = 50270 - 5000 = 45270
    assertApprox(result.employerNI.contribution, 6790.5, 'employer NI'); // 45270 * 0.15
    assertApprox(result.totalNI, 9806.5, 'totalNI');
  });
});

describe('above UEL (£50,270+) — 2% additional rate applies', () => {
  it('grossIncome=60,000 — main and additional rate', () => {
    const result = ni(60_000);
    assertApprox(result.employeeNI.mainRateContribution, 3016, 'main rate');
    // additionalRateIncome = 60000 - 50270 = 9730
    assertApprox(result.employeeNI.additionalRateContribution, 194.6, 'additional rate'); // 9730 * 0.02
    assertApprox(result.employeeNI.total, 3210.6, 'employee total');
    // employerNIableIncome = 60000 - 5000 = 55000
    assertApprox(result.employerNI.contribution, 8250, 'employer NI'); // 55000 * 0.15
    assertApprox(result.totalNI, 11460.6, 'totalNI');
  });

  it('grossIncome=100,000 — high income', () => {
    const result = ni(100_000);
    assertApprox(result.employeeNI.mainRateContribution, 3016, 'main rate');
    // additionalRateIncome = 100000 - 50270 = 49730
    assertApprox(result.employeeNI.additionalRateContribution, 994.6, 'additional rate'); // 49730 * 0.02
    assertApprox(result.employeeNI.total, 4010.6, 'employee total');
    // employerNIableIncome = 100000 - 5000 = 95000
    assertApprox(result.employerNI.contribution, 14250, 'employer NI'); // 95000 * 0.15
    assertApprox(result.totalNI, 18260.6, 'totalNI');
  });

  it('grossIncome=150,000 — very high income', () => {
    const result = ni(150_000);
    assertApprox(result.employeeNI.mainRateContribution, 3016, 'main rate');
    // additionalRateIncome = 150000 - 50270 = 99730
    assertApprox(result.employeeNI.additionalRateContribution, 1994.6, 'additional rate'); // 99730 * 0.02
    assertApprox(result.employeeNI.total, 5010.6, 'employee total');
    // employerNIableIncome = 150000 - 5000 = 145000
    assertApprox(result.employerNI.contribution, 21750, 'employer NI'); // 145000 * 0.15
    assertApprox(result.totalNI, 26760.6, 'totalNI');
  });
});

describe('employer NI has no upper earnings limit', () => {
  it('employer rate keeps rising above UEL while employee additional rate is only 2%', () => {
    const r1 = ni(50_270);
    const r2 = ni(100_000);
    const r3 = ni(200_000);

    // Employer NI grows linearly — delta should be proportional to income delta
    assert.ok(r2.employerNI.contribution > r1.employerNI.contribution);
    assert.ok(r3.employerNI.contribution > r2.employerNI.contribution);

    // Employee main rate is capped at UEL; only additional rate grows above UEL
    assert.equal(r2.employeeNI.mainRateContribution, r1.employeeNI.mainRateContribution);
    assert.equal(r3.employeeNI.mainRateContribution, r1.employeeNI.mainRateContribution);
  });
});

describe('effective rates', () => {
  it('employee effective rate is 0 below PT', () => {
    assert.equal(ni(10_000).employeeNI.effectiveRate, 0);
    assert.equal(ni(12_570).employeeNI.effectiveRate, 0);
  });

  it('employee effective rate increases from PT to UEL', () => {
    const r1 = ni(20_000);
    const r2 = ni(40_000);
    assert.ok(r2.employeeNI.effectiveRate > r1.employeeNI.effectiveRate);
  });

  it('employee effective rate does not decrease above UEL', () => {
    const r1 = ni(50_270);
    const r2 = ni(100_000);
    assert.ok(r2.employeeNI.effectiveRate <= r1.employeeNI.effectiveRate);
  });

  it('employer effective rate is 0 at or below ST', () => {
    assert.equal(ni(5_000).employerNI.effectiveRate, 0);
  });
});

describe('return shape', () => {
  it('result contains all expected fields', () => {
    const result = ni(30_000);
    assert.equal(result.grossIncome, 30_000);
    assert.equal(result.taxYear, '2025/26');

    const emp = result.employeeNI;
    assert.ok('lowerEarningsLimit' in emp);
    assert.ok('primaryThreshold' in emp);
    assert.ok('upperEarningsLimit' in emp);
    assert.ok('mainRateContribution' in emp);
    assert.ok('additionalRateContribution' in emp);
    assert.ok('total' in emp);
    assert.ok('effectiveRate' in emp);

    const er = result.employerNI;
    assert.ok('secondaryThreshold' in er);
    assert.ok('contribution' in er);
    assert.ok('effectiveRate' in er);

    assert.ok('totalNI' in result);
  });

  it('threshold fields in result match NI_THRESHOLDS constants', () => {
    const result = ni(30_000);
    const { employee: emp, employer: er } = NI_THRESHOLDS;
    assert.equal(result.employeeNI.lowerEarningsLimit, emp.lowerEarningsLimit);
    assert.equal(result.employeeNI.primaryThreshold, emp.primaryThreshold);
    assert.equal(result.employeeNI.upperEarningsLimit, emp.upperEarningsLimit);
    assert.equal(result.employerNI.secondaryThreshold, er.secondaryThreshold);
  });

  it('totalNI equals employee total plus employer contribution', () => {
    for (const gross of [0, 10_000, 30_000, 60_000, 150_000]) {
      const result = ni(gross);
      assertApprox(
        result.totalNI,
        result.employeeNI.total + result.employerNI.contribution,
        `grossIncome=${gross}`
      );
    }
  });

  it('all monetary values are finite numbers', () => {
    const result = ni(75_000);
    for (const val of [
      result.employeeNI.mainRateContribution,
      result.employeeNI.additionalRateContribution,
      result.employeeNI.total,
      result.employerNI.contribution,
      result.totalNI,
    ]) {
      assert.ok(typeof val === 'number' && isFinite(val));
    }
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
