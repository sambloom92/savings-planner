import assert from 'node:assert/strict';
import {
  MORTALITY_SEXES,
  ONS_MORTALITY_SOURCE,
  annualMortality,
  survivalToAge,
  survivalCurve,
  lifeExpectancy,
} from './ukMortality.js';

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

// Someone aged 65 in 2026.
const BORN_1961 = 1961;

// ---------------------------------------------------------------------------
// annualMortality
// ---------------------------------------------------------------------------

describe('annualMortality', () => {
  it('rejects bad inputs', () => {
    assert.throws(() => annualMortality(-1, 'male', BORN_1961), TypeError);
    assert.throws(() => annualMortality(65.5, 'male', BORN_1961), TypeError);
    assert.throws(() => annualMortality(65, 'other', BORN_1961), TypeError);
    assert.throws(() => annualMortality(65, 'male'), TypeError);
    assert.throws(() => annualMortality(65, 'male', 1961.5), TypeError);
  });

  it('is a probability in [0, 1] that rises over the decades', () => {
    // Real data has small year-to-year dips (an accident hump in young men, the
    // 2020–21 pandemic years), so check the trend rather than every year.
    for (let age = 30; age <= 119; age++) {
      const q = annualMortality(age, 'male', BORN_1961);
      assert.ok(q >= 0 && q <= 1, `qx out of range at ${age}: ${q}`);
    }
    for (let age = 30; age <= 110; age += 10)
      assert.ok(
        annualMortality(age + 10, 'male', BORN_1961) > annualMortality(age, 'male', BORN_1961),
        `no rise from ${age} to ${age + 10}`
      );
  });

  it('rises every year from 65 (projected years)', () => {
    for (const sex of ['male', 'female'])
      for (let age = 65; age < 119; age++)
        assert.ok(
          annualMortality(age + 1, sex, BORN_1961) > annualMortality(age, sex, BORN_1961),
          `${sex}: fell at ${age + 1}`
        );
  });

  it('reads the ONS cohort table (2024-based, per 100,000)', () => {
    // ONS cohort qx for males born 1981 at age 93: 14,727.29 per 100,000.
    assert.ok(Math.abs(annualMortality(93, 'male', 1981) - 0.1472729) < 1e-6);
  });

  it('continues smoothly past age 100 and reaches certainty at 120', () => {
    for (const sex of ['male', 'female']) {
      const at100 = annualMortality(100, sex, BORN_1961);
      const at101 = annualMortality(101, sex, BORN_1961);
      assert.ok(at101 > at100 && at101 < at100 * 1.15, `${sex}: jump at 100→101`);
      assert.ok(annualMortality(119, sex, BORN_1961) < 1, `${sex}: 119`);
      assert.equal(annualMortality(120, sex, BORN_1961), 1);
      assert.equal(annualMortality(130, sex, BORN_1961), 1);
    }
  });

  it('female mortality is below male at every adult age', () => {
    for (let age = 30; age <= 110; age += 5) {
      assert.ok(
        annualMortality(age, 'female', BORN_1961) < annualMortality(age, 'male', BORN_1961),
        `female >= male at ${age}`
      );
    }
  });

  it('later generations have lower death rates at the same age', () => {
    assert.ok(annualMortality(70, 'male', 1990) < annualMortality(70, 'male', 1961));
  });

  it('neutral is the mean of male and female', () => {
    const expected =
      (annualMortality(70, 'male', BORN_1961) + annualMortality(70, 'female', BORN_1961)) / 2;
    assert.ok(Math.abs(annualMortality(70, 'neutral', BORN_1961) - expected) < 1e-12);
  });

  it('a year of birth outside the table uses the nearest one', () => {
    assert.equal(annualMortality(70, 'male', 1900), annualMortality(70, 'male', 1920));
    assert.equal(annualMortality(70, 'male', 2050), annualMortality(70, 'male', 2010));
  });
});

// ---------------------------------------------------------------------------
// lifeExpectancy — reproduces ONS's published cohort life expectancy
// ---------------------------------------------------------------------------

describe('lifeExpectancy', () => {
  // ONS "Expectation of life, principal projection, UK" (2024-based), cohort
  // ex in 2026: [sex, age, published years remaining].
  const published = [
    ['male', 30, 54.94],
    ['male', 45, 39.09],
    ['male', 65, 20.17],
    ['male', 80, 9.07],
    ['male', 90, 4.16],
    ['female', 30, 58.33],
    ['female', 45, 42.43],
    ['female', 65, 22.86],
    ['female', 80, 10.52],
    ['female', 90, 4.79],
  ];
  for (const [sex, age, ons] of published) {
    it(`${sex} aged ${age} in 2026: ${ons} years (ONS)`, () => {
      const e = lifeExpectancy(age, sex, 2026 - age);
      assert.ok(Math.abs(e - ons) < 0.05, `got ${e.toFixed(2)}`);
    });
  }

  it('is longer for women and for later generations', () => {
    assert.ok(lifeExpectancy(65, 'female', BORN_1961) > lifeExpectancy(65, 'male', BORN_1961));
    assert.ok(lifeExpectancy(65, 'male', 1990) > lifeExpectancy(65, 'male', BORN_1961));
  });
});

// ---------------------------------------------------------------------------
// survivalToAge
// ---------------------------------------------------------------------------

describe('survivalToAge', () => {
  it('is 1 at or before the current age', () => {
    assert.equal(survivalToAge(65, 65, 'male', BORN_1961), 1);
    assert.equal(survivalToAge(65, 60, 'male', BORN_1961), 1);
  });

  it('equals the running product of (1 - qx)', () => {
    const s = survivalToAge(65, 68, 'male', BORN_1961);
    const manual =
      (1 - annualMortality(65, 'male', BORN_1961)) *
      (1 - annualMortality(66, 'male', BORN_1961)) *
      (1 - annualMortality(67, 'male', BORN_1961));
    assert.ok(Math.abs(s - manual) < 1e-12);
  });

  it('decreases as the target age rises', () => {
    assert.ok(survivalToAge(65, 80, 'male', BORN_1961) > survivalToAge(65, 90, 'male', BORN_1961));
    assert.ok(survivalToAge(65, 90, 'male', BORN_1961) > survivalToAge(65, 100, 'male', BORN_1961));
  });

  it('gives plausible UK survival probabilities from 65 to 90', () => {
    const m = survivalToAge(65, 90, 'male', BORN_1961);
    const f = survivalToAge(65, 90, 'female', BORN_1961);
    assert.ok(m > 0.25 && m < 0.4, `male 65->90 = ${m}`);
    assert.ok(f > 0.35 && f < 0.5, `female 65->90 = ${f}`);
    assert.ok(f > m, 'female survival exceeds male');
  });

  it('reaches zero by the table cap', () => {
    assert.equal(survivalToAge(65, 121, 'male', BORN_1961), 0);
  });
});

// ---------------------------------------------------------------------------
// survivalCurve
// ---------------------------------------------------------------------------

describe('survivalCurve', () => {
  it('spans currentAge..maxAge inclusive, starting at 1', () => {
    const curve = survivalCurve(65, 90, 'neutral', BORN_1961);
    assert.equal(curve.length, 26);
    assert.equal(curve[0].age, 65);
    assert.equal(curve[0].survival, 1);
    assert.equal(curve.at(-1).age, 90);
  });

  it('is monotonically non-increasing', () => {
    const curve = survivalCurve(40, 100, 'female', 1986);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i].survival <= curve[i - 1].survival, `rose at index ${i}`);
    }
  });

  it('agrees with survivalToAge at each age', () => {
    const curve = survivalCurve(50, 70, 'male', 1976);
    for (const { age, survival } of curve) {
      const direct = Math.round(survivalToAge(50, age, 'male', 1976) * 10_000) / 10_000;
      assert.ok(Math.abs(survival - direct) < 1e-9, `mismatch at ${age}`);
    }
  });

  it('exposes the supported sexes and the data source', () => {
    assert.deepEqual(MORTALITY_SEXES, ['male', 'female', 'neutral']);
    assert.match(ONS_MORTALITY_SOURCE.title, /2024-based/);
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
