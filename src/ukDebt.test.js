import assert from 'node:assert/strict';
import {
  calculateMonthlyMortgagePayment,
  projectMortgage,
  projectUnsecuredDebt,
  projectUnsecuredDebts,
} from './ukDebt.js';

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
// calculateMonthlyMortgagePayment
// ---------------------------------------------------------------------------

describe('calculateMonthlyMortgagePayment — validation', () => {
  it('throws TypeError for non-positive or non-finite principal', () => {
    assert.throws(() => calculateMonthlyMortgagePayment(0, 0.05, 25), TypeError);
    assert.throws(() => calculateMonthlyMortgagePayment(-1, 0.05, 25), TypeError);
    assert.throws(() => calculateMonthlyMortgagePayment(NaN, 0.05, 25), TypeError);
  });

  it('throws TypeError for negative or non-finite annualRate', () => {
    assert.throws(() => calculateMonthlyMortgagePayment(100_000, -0.01, 25), TypeError);
    assert.throws(() => calculateMonthlyMortgagePayment(100_000, Infinity, 25), TypeError);
  });

  it('throws TypeError for non-positive-integer termYears', () => {
    assert.throws(() => calculateMonthlyMortgagePayment(100_000, 0.05, 0), TypeError);
    assert.throws(() => calculateMonthlyMortgagePayment(100_000, 0.05, 25.5), TypeError);
    assert.throws(() => calculateMonthlyMortgagePayment(100_000, 0.05, -1), TypeError);
  });
});

describe('calculateMonthlyMortgagePayment — results', () => {
  it('returns correct payment for £200,000 at 5% over 25 years', () => {
    assertApprox(calculateMonthlyMortgagePayment(200_000, 0.05, 25), 1_169.18);
  });

  it('returns correct payment for £10,000 at 6% over 3 years', () => {
    assertApprox(calculateMonthlyMortgagePayment(10_000, 0.06, 3), 304.22);
  });

  it('higher rate produces higher monthly payment for same principal and term', () => {
    const low = calculateMonthlyMortgagePayment(100_000, 0.03, 20);
    const high = calculateMonthlyMortgagePayment(100_000, 0.06, 20);
    assert.ok(high > low, `expected high(${high}) > low(${low})`);
  });

  it('shorter term produces higher monthly payment', () => {
    const long = calculateMonthlyMortgagePayment(100_000, 0.05, 25);
    const short = calculateMonthlyMortgagePayment(100_000, 0.05, 15);
    assert.ok(short > long);
  });

  it('zero-rate mortgage: payment equals principal divided by number of months', () => {
    assertApprox(calculateMonthlyMortgagePayment(12_000, 0, 1), 1_000);
  });
});

// ---------------------------------------------------------------------------
// projectMortgage — validation
// ---------------------------------------------------------------------------

describe('projectMortgage — validation', () => {
  it('throws for invalid principal, rate, or term', () => {
    assert.throws(() => projectMortgage(-1, 0.05, 25), TypeError);
    assert.throws(() => projectMortgage(100_000, -0.01, 25), TypeError);
    assert.throws(() => projectMortgage(100_000, 0.05, 0), TypeError);
  });

  it('throws TypeError for unrecognised type', () => {
    assert.throws(() => projectMortgage(100_000, 0.05, 25, { type: 'offset' }), TypeError);
  });

  it('throws TypeError for negative monthlyOverpayment', () => {
    assert.throws(() => projectMortgage(100_000, 0.05, 25, { monthlyOverpayment: -50 }), TypeError);
  });

  it('throws RangeError for implausible startYear', () => {
    assert.throws(() => projectMortgage(100_000, 0.05, 25, { startYear: 1980 }), RangeError);
  });
});

// ---------------------------------------------------------------------------
// projectMortgage — repayment, no overpayment
// (£10,000, 6%, 3 years, startYear 2025)
// ---------------------------------------------------------------------------

describe('projectMortgage — repayment mortgage, no overpayment', () => {
  let result;
  it('sets up result', () => {
    result = projectMortgage(10_000, 0.06, 3, { startYear: 2025 });
  });

  it('monthlyPayment is £304.22', () => {
    assertApprox(result.monthlyPayment, 304.22);
  });

  it('produces exactly 3 yearly entries (2025–2027)', () => {
    assert.equal(result.yearlyBreakdown.length, 3);
    assert.equal(result.yearlyBreakdown[0].year, 2025);
    assert.equal(result.yearlyBreakdown[2].year, 2027);
  });

  it('year 1 (2025) breakdown is correct', () => {
    const y = result.yearlyBreakdown[0];
    assertApprox(y.openingBalance, 10_000);
    assertApprox(y.annualInterestCharged, 514.7);
    assertApprox(y.annualCapitalRepaid, 3_135.94);
    assertApprox(y.annualPayment, 3_650.64);
    assertApprox(y.closingBalance, 6_864.06);
  });

  it('year 2 (2026) breakdown is correct', () => {
    const y = result.yearlyBreakdown[1];
    assertApprox(y.openingBalance, 6_864.06);
    assertApprox(y.annualInterestCharged, 321.26);
    assertApprox(y.annualCapitalRepaid, 3_329.38);
    assertApprox(y.annualPayment, 3_650.64);
    assertApprox(y.closingBalance, 3_534.68);
  });

  it('year 3 (2027) final payment clears the balance', () => {
    const y = result.yearlyBreakdown[2];
    assertApprox(y.openingBalance, 3_534.68);
    assertApprox(y.closingBalance, 0);
    assert.ok(y.annualPayment < 3_650.64, 'final year payment should be less than full year');
  });

  it('totalInterestPaid and totalPaid are correct', () => {
    assertApprox(result.totalInterestPaid, 951.88);
    assertApprox(result.totalPaid, 10_951.88);
  });

  it('totalPaid equals principal plus totalInterestPaid', () => {
    assertApprox(result.totalPaid, result.principal + result.totalInterestPaid);
  });

  it('fullyRepaid is true, finalBalance is 0, balloonPayment is null', () => {
    assert.equal(result.fullyRepaid, true);
    assert.equal(result.finalBalance, 0);
    assert.equal(result.balloonPayment, null);
  });

  it('interest charged decreases year on year (balance reduces)', () => {
    const interests = result.yearlyBreakdown.map((y) => y.annualInterestCharged);
    for (let i = 1; i < interests.length; i++) {
      assert.ok(interests[i] < interests[i - 1], `interest should decrease in year ${i + 1}`);
    }
  });

  it('capital repaid increases year on year', () => {
    const capitals = result.yearlyBreakdown.map((y) => y.annualCapitalRepaid);
    assert.ok(capitals[1] > capitals[0]);
  });
});

// ---------------------------------------------------------------------------
// projectMortgage — repayment with monthly overpayment
// (£10,000, 6%, 3y, +£100/mo)
// ---------------------------------------------------------------------------

describe('projectMortgage — repayment with £100/mo overpayment', () => {
  let result;
  it('sets up result', () => {
    result = projectMortgage(10_000, 0.06, 3, { startYear: 2025, monthlyOverpayment: 100 });
  });

  it('loan is paid off in under 3 years (year 2027 is partial)', () => {
    assert.equal(result.yearlyBreakdown.length, 3);
    assertApprox(result.yearlyBreakdown[2].openingBalance, 991.48);
    assertApprox(result.yearlyBreakdown[2].closingBalance, 0);
    // year 3 annual payment < 12 months of full payments
    assert.ok(result.yearlyBreakdown[2].annualPayment < 12 * (304.22 + 100));
  });

  it('total interest paid is less than without overpayment', () => {
    const without = projectMortgage(10_000, 0.06, 3, { startYear: 2025 });
    assert.ok(
      result.totalInterestPaid < without.totalInterestPaid,
      `with overpayment interest ${result.totalInterestPaid} should be < ${without.totalInterestPaid}`
    );
    assertApprox(result.totalInterestPaid, 701.63);
  });

  it('totalPaid equals principal plus totalInterestPaid', () => {
    assertApprox(result.totalPaid, result.principal + result.totalInterestPaid);
  });

  it('fullyRepaid is true', () => {
    assert.equal(result.fullyRepaid, true);
  });
});

// ---------------------------------------------------------------------------
// projectMortgage — interest-only
// (£10,000, 6%, 3y)
// ---------------------------------------------------------------------------

describe('projectMortgage — interest-only', () => {
  let result;
  it('sets up result', () => {
    result = projectMortgage(10_000, 0.06, 3, { type: 'interest-only', startYear: 2025 });
  });

  it('monthly payment equals annual rate / 12 applied to principal', () => {
    assertApprox(result.monthlyPayment, 50); // 10000 × 6% / 12
  });

  it('no capital is repaid in any year', () => {
    for (const y of result.yearlyBreakdown) {
      assert.equal(y.annualCapitalRepaid, 0);
    }
  });

  it('balance is unchanged throughout the term', () => {
    for (const y of result.yearlyBreakdown) {
      assertApprox(y.openingBalance, 10_000);
      assertApprox(y.closingBalance, 10_000);
    }
  });

  it('annual interest charged equals principal × annual rate (within rounding)', () => {
    // monthly payment = round2(10000 × 0.06/12) = 50.00 exactly; 50×12 = 600
    for (const y of result.yearlyBreakdown) {
      assertApprox(y.annualInterestCharged, 600);
    }
  });

  it('balloonPayment equals principal, fullyRepaid is false', () => {
    assertApprox(result.balloonPayment, 10_000);
    assert.equal(result.fullyRepaid, false);
    assertApprox(result.finalBalance, 10_000);
  });

  it('produces exactly termYears entries', () => {
    assert.equal(result.yearlyBreakdown.length, 3);
  });
});

// ---------------------------------------------------------------------------
// projectMortgage — return shape
// ---------------------------------------------------------------------------

describe('projectMortgage — return shape', () => {
  it('includes all expected top-level fields', () => {
    const result = projectMortgage(100_000, 0.05, 10);
    for (const key of [
      'type',
      'principal',
      'annualRate',
      'termYears',
      'monthlyPayment',
      'monthlyOverpayment',
      'startYear',
      'yearlyBreakdown',
      'totalInterestPaid',
      'totalPaid',
      'finalBalance',
      'balloonPayment',
      'fullyRepaid',
    ]) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });

  it('each yearlyBreakdown row has all expected fields', () => {
    const result = projectMortgage(100_000, 0.05, 5);
    const row = result.yearlyBreakdown[0];
    for (const key of [
      'year',
      'openingBalance',
      'annualInterestCharged',
      'annualCapitalRepaid',
      'annualPayment',
      'closingBalance',
    ]) {
      assert.ok(key in row, `missing breakdown field: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebt — validation
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebt — validation', () => {
  it('throws TypeError for non-positive or non-finite balance', () => {
    assert.throws(() => projectUnsecuredDebt(0, 0.2, 200), TypeError);
    assert.throws(() => projectUnsecuredDebt(-100, 0.2, 200), TypeError);
    assert.throws(() => projectUnsecuredDebt(NaN, 0.2, 200), TypeError);
  });

  it('throws TypeError for negative or non-finite annualRate', () => {
    assert.throws(() => projectUnsecuredDebt(5_000, -0.1, 200), TypeError);
    assert.throws(() => projectUnsecuredDebt(5_000, Infinity, 200), TypeError);
  });

  it('throws TypeError for non-positive monthlyPayment', () => {
    assert.throws(() => projectUnsecuredDebt(5_000, 0.2, 0), TypeError);
    assert.throws(() => projectUnsecuredDebt(5_000, 0.2, -50), TypeError);
  });

  it('throws RangeError when monthlyPayment does not exceed initial monthly interest', () => {
    // balance=1000, rate=24% → monthly interest = 1000×0.02 = 20; payment=20 (not enough)
    assert.throws(() => projectUnsecuredDebt(1_000, 0.24, 20), RangeError);
    assert.throws(() => projectUnsecuredDebt(1_000, 0.24, 19), RangeError);
  });

  it('does NOT throw when payment just exceeds initial monthly interest', () => {
    // monthly interest = 20; payment = 21 → valid (very slow repayment)
    assert.doesNotThrow(() => projectUnsecuredDebt(1_000, 0.24, 21));
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebt — repayment
// (£5,000, 24%, £200/mo, startYear 2025)
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebt — standard repayment', () => {
  let result;
  it('sets up result', () => {
    result = projectUnsecuredDebt(5_000, 0.24, 200, { startYear: 2025, label: 'Credit card' });
  });

  it('label is preserved', () => {
    assert.equal(result.label, 'Credit card');
  });

  it('year 1 (2025) breakdown is correct', () => {
    const y = result.yearlyBreakdown[0];
    assert.equal(y.year, 2025);
    assertApprox(y.openingBalance, 5_000);
    assertApprox(y.annualInterestCharged, 1_058.78);
    assertApprox(y.annualCapitalRepaid, 1_341.22);
    assertApprox(y.annualPayment, 2_400);
    assertApprox(y.closingBalance, 3_658.78);
  });

  it('year 2 (2026) breakdown is correct', () => {
    const y = result.yearlyBreakdown[1];
    assertApprox(y.openingBalance, 3_658.78);
    assertApprox(y.annualInterestCharged, 699.03);
    assertApprox(y.annualCapitalRepaid, 1_700.97);
    assertApprox(y.annualPayment, 2_400);
    assertApprox(y.closingBalance, 1_957.81);
  });

  it('year 3 (2027) clears the balance with a reduced final payment', () => {
    const y = result.yearlyBreakdown[2];
    assertApprox(y.openingBalance, 1_957.81);
    assertApprox(y.closingBalance, 0);
    assert.ok(y.annualPayment < 2_400, 'final year payment should be less than full annual');
    assertApprox(y.annualPayment, 2_200.57);
  });

  it('fully repaid in exactly 36 months', () => {
    assert.equal(result.monthsToRepay, 36);
    assert.equal(result.fullyRepaid, true);
    assert.equal(result.projectionComplete, true);
  });

  it('totalInterestPaid and totalPaid are correct', () => {
    assertApprox(result.totalInterestPaid, 2_000.57);
    assertApprox(result.totalPaid, 7_000.57);
  });

  it('totalPaid equals initialBalance plus totalInterestPaid', () => {
    assertApprox(result.totalPaid, result.initialBalance + result.totalInterestPaid);
  });

  it('interest charged decreases year on year', () => {
    const interests = result.yearlyBreakdown.map((y) => y.annualInterestCharged);
    for (let i = 1; i < interests.length; i++) {
      assert.ok(interests[i] < interests[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebt — zero-rate loan
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebt — zero-rate (0% interest)', () => {
  it('charges no interest and repays principal only', () => {
    // balance=1200, rate=0%, payment=100 → repaid in exactly 12 months
    const result = projectUnsecuredDebt(1_200, 0, 100, { startYear: 2025 });
    assert.equal(result.totalInterestPaid, 0);
    assertApprox(result.totalPaid, 1_200);
    assert.equal(result.monthsToRepay, 12);
    assert.equal(result.yearlyBreakdown.length, 1);
    assertApprox(result.yearlyBreakdown[0].closingBalance, 0);
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebt — return shape
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebt — return shape', () => {
  it('includes all expected top-level fields', () => {
    const result = projectUnsecuredDebt(2_000, 0.15, 100);
    for (const key of [
      'label',
      'initialBalance',
      'annualRate',
      'monthlyPayment',
      'startYear',
      'yearlyBreakdown',
      'totalInterestPaid',
      'totalPaid',
      'finalBalance',
      'fullyRepaid',
      'projectionComplete',
      'monthsToRepay',
    ]) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });

  it('monthsToRepay is null when not fully repaid', () => {
    // very slow repayment — use barely-above-interest payment
    const result = projectUnsecuredDebt(1_000, 0.12, 11);
    if (!result.fullyRepaid) {
      assert.equal(result.monthsToRepay, null);
    }
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebts — validation
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebts — validation', () => {
  it('throws TypeError for empty or non-array debts', () => {
    assert.throws(() => projectUnsecuredDebts([]), TypeError);
    assert.throws(() => projectUnsecuredDebts(null), TypeError);
    assert.throws(() => projectUnsecuredDebts('plan2'), TypeError);
  });

  it('propagates validation errors from individual debts', () => {
    assert.throws(
      () =>
        projectUnsecuredDebts([
          { balance: 5_000, annualRate: 0.2, monthlyPayment: 200 },
          { balance: -100, annualRate: 0.1, monthlyPayment: 50 },
        ]),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebts — combined projection
// Debt A: £3,000 @ 18%, £150/mo  → repaid in year 2 (month 23)
// Debt B: £7,000 @ 8%,  £200/mo  → repaid in year 4 (month 46)
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebts — two debts with different payoff dates', () => {
  const debts = [
    { label: 'Debt A', balance: 3_000, annualRate: 0.18, monthlyPayment: 150 },
    { label: 'Debt B', balance: 7_000, annualRate: 0.08, monthlyPayment: 200 },
  ];
  let result;
  it('sets up result', () => {
    result = projectUnsecuredDebts(debts, { startYear: 2025 });
  });

  it('combined breakdown spans 4 years (2025–2028)', () => {
    assert.equal(result.yearlyBreakdown.length, 4);
    assert.equal(result.yearlyBreakdown[0].year, 2025);
    assert.equal(result.yearlyBreakdown[3].year, 2028);
  });

  it('year 1 combined totals are correct', () => {
    const y = result.yearlyBreakdown[0];
    assertApprox(y.openingBalance, 10_000); // 3000 + 7000
    assertApprox(y.annualInterestCharged, 921.72);
    assertApprox(y.annualCapitalRepaid, 3_278.28);
    assertApprox(y.annualPayment, 4_200); // 150×12 + 200×12
    assertApprox(y.closingBalance, 6_721.72);
  });

  it('year 2 combined payment is less than 4200 (Debt A pays off mid-year)', () => {
    const y = result.yearlyBreakdown[1];
    assertApprox(y.openingBalance, 6_721.72);
    assert.ok(y.annualPayment < 4_200, `year 2 payment ${y.annualPayment} should be < 4200`);
    assertApprox(y.annualPayment, 4_193.52);
    assertApprox(y.closingBalance, 3_023.6); // only Debt B remaining
  });

  it('years 3 and 4 contain only Debt B payments', () => {
    // Debt B: £200/mo continues; Debt A is gone
    assertApprox(result.yearlyBreakdown[2].annualPayment, 2_400); // 200 × 12
    assertApprox(result.yearlyBreakdown[2].closingBalance, 784.56);
    assertApprox(result.yearlyBreakdown[3].closingBalance, 0);
  });

  it('combined totals are correct', () => {
    assertApprox(result.totalInterestPaid, 1_591.17);
    assertApprox(result.totalPaid, 11_591.17);
    assert.equal(result.totalFinalBalance, 0);
  });

  it('totalPaid equals sum of all initial balances plus total interest', () => {
    assertApprox(result.totalPaid, 10_000 + result.totalInterestPaid);
  });

  it('individual debt results are accessible and correct', () => {
    assert.equal(result.debts.length, 2);
    const debtA = result.debts.find((d) => d.label === 'Debt A');
    const debtB = result.debts.find((d) => d.label === 'Debt B');
    assert.ok(debtA && debtB, 'both debts should be present');
    assert.equal(debtA.fullyRepaid, true);
    assert.equal(debtB.fullyRepaid, true);
    assert.ok(debtA.monthsToRepay < debtB.monthsToRepay, 'Debt A should repay before Debt B');
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebts — single debt
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebts — single debt passthrough', () => {
  it('combined result matches individual debt projection', () => {
    const combined = projectUnsecuredDebts([
      { label: 'Loan', balance: 5_000, annualRate: 0.24, monthlyPayment: 200 },
    ]);
    const single = projectUnsecuredDebt(5_000, 0.24, 200);
    assertApprox(combined.totalInterestPaid, single.totalInterestPaid);
    assertApprox(combined.totalPaid, single.totalPaid);
    assert.equal(combined.yearlyBreakdown.length, single.yearlyBreakdown.length);
  });
});

// ---------------------------------------------------------------------------
// projectUnsecuredDebts — return shape
// ---------------------------------------------------------------------------

describe('projectUnsecuredDebts — return shape', () => {
  it('includes all expected top-level fields', () => {
    const result = projectUnsecuredDebts([
      { balance: 2_000, annualRate: 0.15, monthlyPayment: 100 },
    ]);
    for (const key of [
      'debts',
      'startYear',
      'yearlyBreakdown',
      'totalInterestPaid',
      'totalPaid',
      'totalFinalBalance',
    ]) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: interest + capital = payment for every row
// ---------------------------------------------------------------------------

describe('internal consistency: interest + capital = payment in every row', () => {
  it('holds for repayment mortgage rows', () => {
    const result = projectMortgage(200_000, 0.05, 25, { startYear: 2025 });
    for (const y of result.yearlyBreakdown) {
      assertApprox(
        y.annualInterestCharged + y.annualCapitalRepaid,
        y.annualPayment,
        `year ${y.year}`
      );
    }
  });

  it('holds for unsecured debt rows', () => {
    const result = projectUnsecuredDebt(5_000, 0.24, 200);
    for (const y of result.yearlyBreakdown) {
      assertApprox(
        y.annualInterestCharged + y.annualCapitalRepaid,
        y.annualPayment,
        `year ${y.year}`
      );
    }
  });

  it('closingBalance equals openingBalance minus annualCapitalRepaid for every row', () => {
    const result = projectUnsecuredDebt(5_000, 0.24, 200);
    for (const y of result.yearlyBreakdown) {
      assertApprox(y.closingBalance, y.openingBalance - y.annualCapitalRepaid, `year ${y.year}`);
    }
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
