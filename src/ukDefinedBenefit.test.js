import assert from 'node:assert/strict';
import {
  DB_CONSTANTS,
  DB_DEFAULTS,
  normaliseDbScheme,
  dbPaymentFactor,
  maxCommutationLumpSum,
  dbPensionInputAmount,
  cappedIncrease,
  inServiceRevaluationRate,
} from './ukDefinedBenefit.js';

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

const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

// ---------------------------------------------------------------------------

describe('constants', () => {
  it('uses HMRC factors: 16 for pension input, 20 and 25% for the lump sum limit', () => {
    assert.equal(DB_CONSTANTS.pensionInputFactor, 16);
    assert.equal(DB_CONSTANTS.capitalValueFactor, 20);
    assert.equal(DB_CONSTANTS.maxLumpSumShare, 0.25);
  });
});

describe('normaliseDbScheme', () => {
  const deferred = { status: 'deferred', pension: 8_000, paymentAge: 65 };

  it('fills in defaults', () => {
    const s = normaliseDbScheme(deferred, 40);
    assert.equal(s.normalPensionAge, DB_DEFAULTS.normalPensionAge);
    assert.equal(s.commutationFactor, 12);
    assert.equal(s.lumpSum, 'none');
    assert.equal(s.label, '');
  });

  it('rejects bad inputs', () => {
    assert.throws(() => normaliseDbScheme(null, 40), TypeError);
    assert.throws(() => normaliseDbScheme({ ...deferred, status: 'retired' }, 40), RangeError);
    assert.throws(() => normaliseDbScheme({ ...deferred, pension: -1 }, 40), RangeError);
    assert.throws(() => normaliseDbScheme({ ...deferred, paymentAge: 64.5 }, 40), RangeError);
    assert.throws(() => normaliseDbScheme({ ...deferred, lumpSum: 'some' }, 40), RangeError);
    assert.throws(() => normaliseDbScheme({ ...deferred, paymentIncreaseCap: 2 }, 40), RangeError);
    assert.throws(
      () => normaliseDbScheme({ ...deferred, inServiceRevaluation: { basis: 'rpi' } }, 40),
      RangeError
    );
  });

  it('a scheme not yet paid needs a payment age that is not in the past', () => {
    assert.throws(() => normaliseDbScheme({ ...deferred, paymentAge: 60 }, 62), RangeError);
    // An in-payment scheme has no payment age to check.
    assert.doesNotThrow(() => normaliseDbScheme({ status: 'inPayment', pension: 9_000 }, 70));
  });
});

describe('dbPaymentFactor', () => {
  it('is 1 at normal pension age', () => {
    assert.equal(dbPaymentFactor(67, 67, 0.05, 0.05), 1);
  });

  it('reduces by the yearly rate for each year early', () => {
    // 5 years early at 5% a year → 75%
    near(dbPaymentFactor(67, 62, 0.05, 0.05), 0.75, 1e-12);
  });

  it('increases by the yearly rate for each year late', () => {
    // 2 years late at 6% a year → 112%
    near(dbPaymentFactor(65, 67, 0.05, 0.06), 1.12, 1e-12);
  });

  it('never goes below zero', () => {
    assert.equal(dbPaymentFactor(67, 50, 0.1, 0), 0);
  });
});

describe('maxCommutationLumpSum', () => {
  it('£10,000 pension at 12:1 → £42,857 cash (the 4.29× rule of thumb)', () => {
    const L = maxCommutationLumpSum(10_000, 12);
    near(L, 42_857.14);
    // Check against the HMRC test: cash = 25% of (20 × pension left + cash).
    const left = 10_000 - L / 12;
    near(L, 0.25 * (20 * left + L));
  });

  it('an automatic lump sum leaves less room to commute', () => {
    // NHS 1995 style: 3× pension automatic lump sum.
    const P = 10_000;
    const A = 30_000;
    const L = maxCommutationLumpSum(P, 12, A);
    near(L, 23_571.43);
    near(A + L, 0.25 * (20 * (P - L / 12) + A + L));
  });

  it('a better commutation factor buys more cash for the same limit', () => {
    assert.ok(maxCommutationLumpSum(10_000, 20) > maxCommutationLumpSum(10_000, 12));
  });

  it('is zero when the automatic lump sum already uses the limit', () => {
    // A = 20P/3 hits the limit with no commutation: ¼(20P + A) = A.
    assert.equal(maxCommutationLumpSum(3_000, 12, 20_000), 0);
  });
});

describe('dbPensionInputAmount', () => {
  it('is 16 × the growth beyond CPI', () => {
    // £10,000 → £10,800 with 2% CPI allowed: growth 600 → 9,600
    assert.equal(dbPensionInputAmount(10_000, 10_800, 0.02), 9_600);
  });

  it('a pension growing only with CPI uses no allowance', () => {
    assert.equal(dbPensionInputAmount(10_000, 10_200, 0.02), 0);
    assert.equal(dbPensionInputAmount(10_000, 10_100, 0.02), 0);
  });
});

describe('increases', () => {
  it('capped CPI: never negative, capped, and 0 means level', () => {
    assert.equal(cappedIncrease(0.03, null), 0.03);
    assert.equal(cappedIncrease(0.07, 0.05), 0.05);
    assert.equal(cappedIncrease(-0.01, null), 0);
    assert.equal(cappedIncrease(0.04, 0), 0);
  });

  it('in-service revaluation: CPI plus a margin, or earnings', () => {
    near(inServiceRevaluationRate({ basis: 'cpi', margin: 0.015 }, 0.025, 0.03), 0.04, 1e-12);
    assert.equal(inServiceRevaluationRate({ basis: 'earnings' }, 0.025, 0.035), 0.035);
    assert.equal(inServiceRevaluationRate({ basis: 'cpi', margin: 0.015 }, -0.03, 0.03), 0);
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
