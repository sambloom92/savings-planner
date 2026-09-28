import assert from 'node:assert/strict';
import { ANNUITY_RATE_TABLE, illustrativeAnnuityRate } from './ukAnnuity.js';

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
// illustrativeAnnuityRate
// ---------------------------------------------------------------------------

describe('illustrativeAnnuityRate', () => {
  it('returns the table value at each tabulated age', () => {
    ANNUITY_RATE_TABLE.ages.forEach((age, i) => {
      assert.equal(illustrativeAnnuityRate(age, false), ANNUITY_RATE_TABLE.level[i]);
      assert.equal(illustrativeAnnuityRate(age, true), ANNUITY_RATE_TABLE.inflationLinked[i]);
    });
  });

  it('interpolates linearly between tabulated ages', () => {
    const mid = (ANNUITY_RATE_TABLE.level[2] + ANNUITY_RATE_TABLE.level[3]) / 2; // 65 ↔ 70
    assert.ok(Math.abs(illustrativeAnnuityRate(67.5, false) - mid) < 1e-12);
  });

  it('clamps outside the table range', () => {
    assert.equal(illustrativeAnnuityRate(50, true), ANNUITY_RATE_TABLE.inflationLinked[0]);
    assert.equal(illustrativeAnnuityRate(95, false), ANNUITY_RATE_TABLE.level.at(-1));
  });

  it('rises with age and inflation-linked always starts below level', () => {
    for (let age = 55; age < 85; age++) {
      assert.ok(illustrativeAnnuityRate(age + 1, false) > illustrativeAnnuityRate(age, false));
      assert.ok(illustrativeAnnuityRate(age + 1, true) > illustrativeAnnuityRate(age, true));
      assert.ok(illustrativeAnnuityRate(age, true) < illustrativeAnnuityRate(age, false));
    }
  });

  it('defaults to inflation-linked', () => {
    assert.equal(illustrativeAnnuityRate(75), illustrativeAnnuityRate(75, true));
  });

  it('rejects a non-finite age', () => {
    assert.throws(() => illustrativeAnnuityRate(NaN), TypeError);
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
