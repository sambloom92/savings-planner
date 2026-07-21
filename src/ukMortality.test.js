import assert from 'node:assert/strict';
import { MORTALITY_SEXES, annualMortality, survivalToAge, survivalCurve } from './ukMortality.js';

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
// annualMortality
// ---------------------------------------------------------------------------

describe('annualMortality', () => {
  it('rejects bad inputs', () => {
    assert.throws(() => annualMortality(-1), TypeError);
    assert.throws(() => annualMortality(65.5), TypeError);
    assert.throws(() => annualMortality(65, 'other'), TypeError);
  });

  it('is a probability in [0, 1] and rises with age', () => {
    let prev = -1;
    for (let age = 20; age <= 110; age += 5) {
      const q = annualMortality(age, 'male');
      assert.ok(q >= 0 && q <= 1, `qx out of range at ${age}: ${q}`);
      assert.ok(q >= prev, `qx not monotonic at ${age}`);
      prev = q;
    }
  });

  it('reaches certainty at the table cap', () => {
    assert.equal(annualMortality(120, 'male'), 1);
    assert.equal(annualMortality(130, 'female'), 1);
  });

  it('female mortality is below male at every adult age', () => {
    for (let age = 30; age <= 95; age += 5) {
      assert.ok(
        annualMortality(age, 'female') < annualMortality(age, 'male'),
        `female >= male at ${age}`
      );
    }
  });

  it('neutral is the mean of male and female', () => {
    const age = 70;
    const expected = (annualMortality(age, 'male') + annualMortality(age, 'female')) / 2;
    assert.ok(Math.abs(annualMortality(age, 'neutral') - expected) < 1e-12);
  });

  it('matches UK period anchors within tolerance', () => {
    // Rough ONS-calibrated targets
    assert.ok(Math.abs(annualMortality(65, 'male') - 0.014) < 0.004, 'male 65');
    assert.ok(Math.abs(annualMortality(90, 'male') - 0.16) < 0.03, 'male 90');
    assert.ok(Math.abs(annualMortality(65, 'female') - 0.009) < 0.004, 'female 65');
  });

  it("defaults to 'neutral' when sex omitted", () => {
    assert.equal(annualMortality(70), annualMortality(70, 'neutral'));
  });
});

// ---------------------------------------------------------------------------
// survivalToAge
// ---------------------------------------------------------------------------

describe('survivalToAge', () => {
  it('is 1 at or before the current age', () => {
    assert.equal(survivalToAge(65, 65, 'male'), 1);
    assert.equal(survivalToAge(65, 60, 'male'), 1);
  });

  it('equals the running product of (1 - qx)', () => {
    const s = survivalToAge(65, 68, 'male');
    const manual =
      (1 - annualMortality(65, 'male')) *
      (1 - annualMortality(66, 'male')) *
      (1 - annualMortality(67, 'male'));
    assert.ok(Math.abs(s - manual) < 1e-12);
  });

  it('decreases as the target age rises', () => {
    assert.ok(survivalToAge(65, 80, 'male') > survivalToAge(65, 90, 'male'));
    assert.ok(survivalToAge(65, 90, 'male') > survivalToAge(65, 100, 'male'));
  });

  it('gives plausible UK survival probabilities', () => {
    // ~a fifth to a third of 65-year-olds reach 90
    const m = survivalToAge(65, 90, 'male');
    const f = survivalToAge(65, 90, 'female');
    assert.ok(m > 0.15 && m < 0.35, `male 65->90 = ${m}`);
    assert.ok(f > 0.25 && f < 0.45, `female 65->90 = ${f}`);
    assert.ok(f > m, 'female survival exceeds male');
  });

  it('reaches (near) zero by the table cap', () => {
    assert.ok(survivalToAge(65, 121, 'male') < 1e-6);
  });
});

// ---------------------------------------------------------------------------
// survivalCurve
// ---------------------------------------------------------------------------

describe('survivalCurve', () => {
  it('spans currentAge..maxAge inclusive, starting at 1', () => {
    const curve = survivalCurve(65, 90, 'neutral');
    assert.equal(curve.length, 26);
    assert.equal(curve[0].age, 65);
    assert.equal(curve[0].survival, 1);
    assert.equal(curve.at(-1).age, 90);
  });

  it('is monotonically non-increasing', () => {
    const curve = survivalCurve(40, 100, 'female');
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i].survival <= curve[i - 1].survival, `rose at index ${i}`);
    }
  });

  it('agrees with survivalToAge at each age', () => {
    const curve = survivalCurve(50, 70, 'male');
    for (const { age, survival } of curve) {
      const direct = Math.round(survivalToAge(50, age, 'male') * 10_000) / 10_000;
      assert.ok(Math.abs(survival - direct) < 1e-9, `mismatch at ${age}`);
    }
  });

  it('exposes the supported sexes', () => {
    assert.deepEqual(MORTALITY_SEXES, ['male', 'female', 'neutral']);
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
