import assert from 'node:assert/strict';
import {
  STUDENT_LOAN_PLANS,
  calculateStudentLoan,
  calculateAnnualInterestRate,
  projectLoanBalance,
  calculateTaxAndLoans,
} from './ukStudentLoan.js';
import { calculateIncomeTax } from './ukIncomeTax.js';

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
// STUDENT_LOAN_PLANS constants
// ---------------------------------------------------------------------------

describe('STUDENT_LOAN_PLANS constants', () => {
  it('exports all five plans', () => {
    for (const key of ['plan1', 'plan2', 'plan4', 'plan5', 'postgrad']) {
      assert.ok(key in STUDENT_LOAN_PLANS, `missing plan: ${key}`);
    }
  });

  it('undergraduate plans charge 9% and postgrad charges 6%', () => {
    for (const key of ['plan1', 'plan2', 'plan4', 'plan5']) {
      assert.equal(STUDENT_LOAN_PLANS[key].rate, 0.09, `${key} should be 9%`);
    }
    assert.equal(STUDENT_LOAN_PLANS.postgrad.rate, 0.06);
  });

  it('plan5 has the lowest undergraduate threshold', () => {
    const thresholds = ['plan1', 'plan2', 'plan4', 'plan5'].map(
      (k) => STUDENT_LOAN_PLANS[k].threshold
    );
    assert.equal(Math.min(...thresholds), STUDENT_LOAN_PLANS.plan5.threshold);
  });

  it('plan4 has the highest undergraduate threshold', () => {
    const thresholds = ['plan1', 'plan2', 'plan4', 'plan5'].map(
      (k) => STUDENT_LOAN_PLANS[k].threshold
    );
    assert.equal(Math.max(...thresholds), STUDENT_LOAN_PLANS.plan4.threshold);
  });

  it('plan5 has the longest write-off period (40 years)', () => {
    const years = Object.values(STUDENT_LOAN_PLANS).map((p) => p.writeOffYears);
    assert.equal(Math.max(...years), STUDENT_LOAN_PLANS.plan5.writeOffYears);
  });

  it('plan1 has the shortest write-off period (25 years)', () => {
    const years = Object.values(STUDENT_LOAN_PLANS).map((p) => p.writeOffYears);
    assert.equal(Math.min(...years), STUDENT_LOAN_PLANS.plan1.writeOffYears);
  });
});

// ---------------------------------------------------------------------------
// calculateStudentLoan — input validation
// ---------------------------------------------------------------------------

describe('calculateStudentLoan — input validation', () => {
  it('throws TypeError for non-numeric income', () => {
    assert.throws(() => calculateStudentLoan('30000', 'plan2'), TypeError);
    assert.throws(() => calculateStudentLoan(NaN, 'plan2'), TypeError);
  });

  it('throws RangeError for negative income', () => {
    assert.throws(() => calculateStudentLoan(-1, 'plan2'), RangeError);
  });

  it('throws TypeError for unknown plan', () => {
    assert.throws(() => calculateStudentLoan(30_000, 'plan9'), TypeError);
    assert.throws(() => calculateStudentLoan(30_000, ''), TypeError);
  });
});

// ---------------------------------------------------------------------------
// calculateStudentLoan — below threshold
// ---------------------------------------------------------------------------

describe('calculateStudentLoan — below threshold', () => {
  it('plan1: no repayment below £26,065', () => {
    assert.equal(calculateStudentLoan(26_064, 'plan1').repayment, 0);
    assert.equal(calculateStudentLoan(0, 'plan1').repayment, 0);
  });

  it('plan2: no repayment below £28,470', () => {
    assert.equal(calculateStudentLoan(28_469, 'plan2').repayment, 0);
  });

  it('plan4: no repayment below £32,745', () => {
    assert.equal(calculateStudentLoan(32_744, 'plan4').repayment, 0);
  });

  it('plan5: no repayment below £25,000', () => {
    assert.equal(calculateStudentLoan(24_999, 'plan5').repayment, 0);
  });

  it('postgrad: no repayment below £21,000', () => {
    assert.equal(calculateStudentLoan(20_999, 'postgrad').repayment, 0);
  });
});

// ---------------------------------------------------------------------------
// calculateStudentLoan — repayment amounts
// ---------------------------------------------------------------------------

describe('calculateStudentLoan — repayment amounts', () => {
  it('plan1: 9% on income above £26,065', () => {
    // £36,065 → £10,000 repayable → 9% = £900
    assertApprox(calculateStudentLoan(36_065, 'plan1').repayment, 900);
    assertApprox(calculateStudentLoan(26_065, 'plan1').repayment, 0);
  });

  it('plan2: 9% on income above £28,470', () => {
    assertApprox(calculateStudentLoan(38_470, 'plan2').repayment, 900);
  });

  it('plan4: 9% on income above £32,745', () => {
    assertApprox(calculateStudentLoan(42_745, 'plan4').repayment, 900);
  });

  it('plan5: 9% on income above £25,000', () => {
    assertApprox(calculateStudentLoan(35_000, 'plan5').repayment, 900);
  });

  it('postgrad: 6% on income above £21,000', () => {
    // £31,000 → £10,000 repayable → 6% = £600
    assertApprox(calculateStudentLoan(31_000, 'postgrad').repayment, 600);
  });

  it('repayment equals repayableIncome * rate for all plans', () => {
    for (const [key, plan] of Object.entries(STUDENT_LOAN_PLANS)) {
      const gross = plan.threshold + 12_000;
      const result = calculateStudentLoan(gross, key);
      assertApprox(result.repayment, 12_000 * plan.rate, key);
    }
  });
});

// ---------------------------------------------------------------------------
// calculateStudentLoan — return shape
// ---------------------------------------------------------------------------

describe('calculateStudentLoan — return shape', () => {
  it('includes all expected fields', () => {
    const result = calculateStudentLoan(35_000, 'plan2');
    for (const key of [
      'plan',
      'label',
      'description',
      'threshold',
      'rate',
      'repayableIncome',
      'repayment',
      'grossIncome',
      'taxYear',
    ]) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });

  it('plan field matches the key passed in', () => {
    assert.equal(calculateStudentLoan(30_000, 'plan4').plan, 'plan4');
  });

  it('taxYear is 2025/26', () => {
    assert.equal(calculateStudentLoan(30_000, 'plan1').taxYear, '2025/26');
  });
});

// ---------------------------------------------------------------------------
// calculateAnnualInterestRate — plan 1 (min of RPI and BoE+1%)
// ---------------------------------------------------------------------------

describe('calculateAnnualInterestRate — plan 1', () => {
  it('returns RPI when RPI < BoE+1%', () => {
    // RPI=3%, BoE=4.75% → BoE+1%=5.75% → min=3%
    assertApprox(calculateAnnualInterestRate('plan1', 30_000, 0.03, 0.0475), 0.03);
  });

  it('returns BoE+1% when BoE+1% < RPI', () => {
    // RPI=8%, BoE=4.75% → BoE+1%=5.75% → min=5.75%
    assertApprox(calculateAnnualInterestRate('plan1', 30_000, 0.08, 0.0475), 0.0575);
  });

  it('throws TypeError for unknown plan', () => {
    assert.throws(() => calculateAnnualInterestRate('plan99', 30_000, 0.03), TypeError);
  });
});

// ---------------------------------------------------------------------------
// calculateAnnualInterestRate — plan 2 (RPI + 0–3% income taper)
// ---------------------------------------------------------------------------

describe('calculateAnnualInterestRate — plan 2', () => {
  it('returns RPI at and below the lower income threshold (£28,470)', () => {
    assertApprox(calculateAnnualInterestRate('plan2', 28_470, 0.03), 0.03);
    assertApprox(calculateAnnualInterestRate('plan2', 20_000, 0.03), 0.03);
  });

  it('returns RPI+3% at and above the upper income threshold (£49,130)', () => {
    assertApprox(calculateAnnualInterestRate('plan2', 49_130, 0.03), 0.06);
    assertApprox(calculateAnnualInterestRate('plan2', 80_000, 0.03), 0.06);
  });

  it('returns RPI+1.5% exactly at the income midpoint (£38,800)', () => {
    // fraction = (38800 - 28470) / (49130 - 28470) = 10330 / 20660 = 0.5
    // rate = 3% + 0.5 × 3% = 4.5%
    assertApprox(calculateAnnualInterestRate('plan2', 38_800, 0.03), 0.045);
  });
});

// ---------------------------------------------------------------------------
// calculateAnnualInterestRate — plans 4, 5, postgrad
// ---------------------------------------------------------------------------

describe('calculateAnnualInterestRate — plans 4, 5, postgrad', () => {
  it('plan4: returns RPI', () => {
    assertApprox(calculateAnnualInterestRate('plan4', 50_000, 0.031), 0.031);
  });

  it('plan5: returns RPI (no income-based addition)', () => {
    assertApprox(calculateAnnualInterestRate('plan5', 80_000, 0.031), 0.031);
  });

  it('postgrad: returns RPI + 3%', () => {
    assertApprox(calculateAnnualInterestRate('postgrad', 30_000, 0.03), 0.06);
    assertApprox(calculateAnnualInterestRate('postgrad', 30_000, 0.015), 0.045);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — input validation
// ---------------------------------------------------------------------------

describe('projectLoanBalance — input validation', () => {
  const proj = [{ grossIncome: 30_000, rpi: 0.03 }];

  it('throws TypeError for unknown plan', () => {
    assert.throws(() => projectLoanBalance('plan99', 10_000, 2025, proj), TypeError);
  });

  it('throws RangeError for negative initialBalance', () => {
    assert.throws(() => projectLoanBalance('plan2', -1, 2025, proj), RangeError);
  });

  it('throws RangeError for non-integer or implausible repaymentStartYear', () => {
    assert.throws(() => projectLoanBalance('plan2', 10_000, 1980, proj), RangeError);
    assert.throws(() => projectLoanBalance('plan2', 10_000, 2025.5, proj), RangeError);
  });

  it('throws TypeError for empty or non-array projections', () => {
    assert.throws(() => projectLoanBalance('plan2', 10_000, 2025, []), TypeError);
    assert.throws(() => projectLoanBalance('plan2', 10_000, 2025, null), TypeError);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — loan fully repaid before write-off
// ---------------------------------------------------------------------------

describe('projectLoanBalance — fully repaid', () => {
  // plan4, £3,000 balance, £40,000 income, 5% RPI
  // Repayment: (40000 - 32745) × 9% = £652.95/yr
  // Loan paid off in year 6 (2030)
  const proj = Array(10).fill({ grossIncome: 40_000, rpi: 0.05 });
  let result;
  it('sets up result', () => {
    result = projectLoanBalance('plan4', 3_000, 2025, proj);
  });

  it('year 1 breakdown is correct', () => {
    const y1 = result.yearlyBreakdown[0];
    assert.equal(y1.year, 2025);
    assertApprox(y1.openingBalance, 3_000);
    assertApprox(y1.interestCharged, 150); // 3000 × 5%
    assertApprox(y1.annualRepayment, 652.95);
    assertApprox(y1.closingBalance, 2_497.05);
    assert.equal(y1.writtenOff, false);
  });

  it('loan is fully repaid in year 6 (2030)', () => {
    assert.equal(result.yearlyBreakdown.length, 6);
    const last = result.yearlyBreakdown[5];
    assert.equal(last.year, 2030);
    assert.equal(last.closingBalance, 0);
    assert.equal(last.writtenOff, false);
  });

  it('totalRepaid equals initialBalance plus totalInterestCharged', () => {
    assertApprox(result.totalRepaid, 3_496.67);
    assertApprox(result.totalInterestCharged, 496.67);
    assertApprox(result.totalRepaid, 3_000 + result.totalInterestCharged);
  });

  it('fullyRepaid is true, balanceWrittenOff is null, projectionComplete is true', () => {
    assert.equal(result.fullyRepaid, true);
    assert.equal(result.balanceWrittenOff, null);
    assert.equal(result.projectionComplete, true);
    assert.equal(result.finalBalance, 0);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — balance written off
// ---------------------------------------------------------------------------

describe('projectLoanBalance — written off', () => {
  // plan5, £20,000 balance, income £20,000 (below £25,000 threshold), 3% RPI
  // No repayments ever; balance grows at 3%/yr and is written off in year 40 (2065)
  const proj = Array(50).fill({ grossIncome: 20_000, rpi: 0.03 });
  let result;
  it('sets up result', () => {
    result = projectLoanBalance('plan5', 20_000, 2025, proj);
  });

  it('breakdown spans exactly 41 entries (years 2025–2065)', () => {
    assert.equal(result.yearlyBreakdown.length, 41);
  });

  it('write-off year is 2065 (repaymentStartYear + 40)', () => {
    assert.equal(result.writeOffYear, 2065);
    assert.equal(result.writeOffPeriodYears, 40);
  });

  it('final entry is in 2065 and marked writtenOff', () => {
    const last = result.yearlyBreakdown[40];
    assert.equal(last.year, 2065);
    assert.equal(last.writtenOff, true);
    assert.equal(last.annualRepayment, 0);
    assert.equal(last.closingBalance, 0);
  });

  it('balance written off is larger than initial balance (interest accrued)', () => {
    assert.ok(
      result.balanceWrittenOff > 20_000,
      `expected balanceWrittenOff > 20000, got ${result.balanceWrittenOff}`
    );
    assertApprox(result.balanceWrittenOff, 65_240.76);
  });

  it('no repayments were made', () => {
    assert.equal(result.totalRepaid, 0);
  });

  it('fullyRepaid is false, projectionComplete is true', () => {
    assert.equal(result.fullyRepaid, false);
    assert.equal(result.projectionComplete, true);
    assert.equal(result.finalBalance, 0);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — incomplete projection
// ---------------------------------------------------------------------------

describe('projectLoanBalance — incomplete projection', () => {
  // plan5, large balance, income below threshold, only 5 years supplied
  const proj = Array(5).fill({ grossIncome: 24_000, rpi: 0.03 });
  let result;
  it('sets up result', () => {
    result = projectLoanBalance('plan5', 50_000, 2025, proj);
  });

  it('projection is not complete', () => {
    assert.equal(result.projectionComplete, false);
    assert.equal(result.fullyRepaid, false);
    assert.equal(result.balanceWrittenOff, null);
  });

  it('finalBalance is greater than zero', () => {
    assert.ok(result.finalBalance > 0, `expected finalBalance > 0, got ${result.finalBalance}`);
    assertApprox(result.finalBalance, 57_963.7);
  });

  it('breakdown has exactly 5 entries', () => {
    assert.equal(result.yearlyBreakdown.length, 5);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — plan 2 income-based interest
// ---------------------------------------------------------------------------

describe('projectLoanBalance — plan 2 income-based interest', () => {
  // income = £38,800 sits exactly at the midpoint of plan2's interest band
  // → rate = RPI(3%) + 1.5% = 4.5%
  const proj = [{ grossIncome: 38_800, rpi: 0.03 }];

  it('year 1: applies 4.5% interest and correct repayment', () => {
    const result = projectLoanBalance('plan2', 10_000, 2025, proj);
    const y1 = result.yearlyBreakdown[0];
    assertApprox(y1.annualInterestRate, 0.045);
    assertApprox(y1.interestCharged, 450); // 10000 × 4.5%
    assertApprox(y1.annualRepayment, 929.7); // (38800 - 28470) × 9%
    assertApprox(y1.closingBalance, 9_520.3);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — plan 1 (25-year write-off)
// ---------------------------------------------------------------------------

describe('projectLoanBalance — plan 1 write-off period', () => {
  it('writeOffYear is repaymentStartYear + 25', () => {
    const proj = [{ grossIncome: 25_000, rpi: 0.03 }];
    const result = projectLoanBalance('plan1', 1_000, 2025, proj);
    assert.equal(result.writeOffYear, 2050);
    assert.equal(result.writeOffPeriodYears, 25);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — plan 5 interest (RPI only, no income addition)
// ---------------------------------------------------------------------------

describe('projectLoanBalance — plan 5 interest rate is always RPI', () => {
  it('high earner gets the same rate as low earner on plan5', () => {
    const rateHigh = calculateAnnualInterestRate('plan5', 100_000, 0.03);
    const rateLow = calculateAnnualInterestRate('plan5', 25_001, 0.03);
    assert.equal(rateHigh, rateLow);
    assertApprox(rateHigh, 0.03);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — balance cannot go negative
// ---------------------------------------------------------------------------

describe('projectLoanBalance — balance floor at zero', () => {
  it('does not produce a negative balance when repayment > balance+interest', () => {
    // Very small balance with large income: repayment >> remaining balance
    const proj = [{ grossIncome: 80_000, rpi: 0.03 }];
    const result = projectLoanBalance('plan2', 100, 2025, proj);
    assert.ok(result.finalBalance >= 0);
    assert.equal(result.yearlyBreakdown[0].closingBalance, 0);
    assert.equal(result.fullyRepaid, true);
  });
});

// ---------------------------------------------------------------------------
// projectLoanBalance — return shape
// ---------------------------------------------------------------------------

describe('projectLoanBalance — return shape', () => {
  it('includes all expected top-level fields', () => {
    const proj = [{ grossIncome: 35_000, rpi: 0.03 }];
    const result = projectLoanBalance('plan2', 10_000, 2025, proj);
    for (const key of [
      'plan',
      'repaymentStartYear',
      'writeOffYear',
      'writeOffPeriodYears',
      'yearlyBreakdown',
      'totalRepaid',
      'totalInterestCharged',
      'balanceWrittenOff',
      'finalBalance',
      'fullyRepaid',
      'projectionComplete',
    ]) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });

  it('each yearlyBreakdown entry has all expected fields', () => {
    const proj = [{ grossIncome: 35_000, rpi: 0.03 }];
    const result = projectLoanBalance('plan2', 10_000, 2025, proj);
    const row = result.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'annualInterestRate',
      'interestCharged',
      'grossIncome',
      'annualRepayment',
      'closingBalance',
      'writtenOff',
    ]) {
      assert.ok(key in row, `missing breakdown field: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// calculateTaxAndLoans — validation and integration
// ---------------------------------------------------------------------------

describe('calculateTaxAndLoans — input validation', () => {
  it('throws TypeError for non-numeric income', () => {
    assert.throws(() => calculateTaxAndLoans('50000', []), TypeError);
  });

  it('throws TypeError if studentLoanPlans is not an array', () => {
    assert.throws(() => calculateTaxAndLoans(50_000, 'plan2'), TypeError);
    assert.throws(() => calculateTaxAndLoans(50_000, null), TypeError);
  });

  it('propagates TypeError for an unknown plan key', () => {
    assert.throws(() => calculateTaxAndLoans(50_000, ['plan99']), TypeError);
  });
});

describe('calculateTaxAndLoans — no student loans', () => {
  it('totalDeductions equals totalTax and netIncomeAfterLoans equals netIncome', () => {
    const result = calculateTaxAndLoans(40_000, []);
    assert.equal(result.totalStudentLoanRepayment, 0);
    assert.equal(result.totalDeductions, result.totalTax);
    assert.equal(result.netIncomeAfterLoans, result.netIncome);
  });

  it('income tax fields match calculateIncomeTax directly', () => {
    const combined = calculateTaxAndLoans(60_000, []);
    const tax = calculateIncomeTax(60_000);
    assert.equal(combined.totalTax, tax.totalTax);
    assert.equal(combined.basicRateTax, tax.basicRateTax);
  });
});

describe('calculateTaxAndLoans — single plan', () => {
  it('adds correct plan2 repayment to deductions for £35,000', () => {
    // plan2: (35000 - 28470) × 9% = 6530 × 9% = £587.70
    // tax:   (35000 - 12570) × 20% = 22430 × 20% = £4,486
    const result = calculateTaxAndLoans(35_000, ['plan2']);
    assertApprox(result.studentLoans[0].repayment, 587.7);
    assertApprox(result.totalStudentLoanRepayment, 587.7);
    assertApprox(result.totalDeductions, 4_486 + 587.7);
    assertApprox(result.netIncomeAfterLoans, 35_000 - 4_486 - 587.7);
  });

  it('income below loan threshold: loan repayment is zero', () => {
    const result = calculateTaxAndLoans(20_000, ['plan2']);
    assert.equal(result.totalStudentLoanRepayment, 0);
    assert.equal(result.totalDeductions, result.totalTax);
  });
});

describe('calculateTaxAndLoans — multiple plans', () => {
  it('sums plan2 + postgrad repayments for £40,000', () => {
    // plan2:   (40000 - 28470) × 9%  = 11530 × 9%  = £1,037.70
    // postgrad: (40000 - 21000) × 6% = 19000 × 6%  = £1,140
    const result = calculateTaxAndLoans(40_000, ['plan2', 'postgrad']);
    assert.equal(result.studentLoans.length, 2);
    assertApprox(result.studentLoans.find((l) => l.plan === 'plan2').repayment, 1_037.7);
    assertApprox(result.studentLoans.find((l) => l.plan === 'postgrad').repayment, 1_140);
    assertApprox(result.totalStudentLoanRepayment, 2_177.7);
  });

  it('netIncomeAfterLoans equals gross minus tax minus all repayments', () => {
    const result = calculateTaxAndLoans(50_000, ['plan1', 'postgrad']);
    const expected = 50_000 - result.totalTax - result.totalStudentLoanRepayment;
    assertApprox(result.netIncomeAfterLoans, expected);
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
