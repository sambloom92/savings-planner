import assert from 'node:assert/strict';
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

function tax(gross) {
  return calculateIncomeTax(gross);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('throws TypeError for non-numeric input', () => {
    assert.throws(() => tax('50000'), TypeError);
    assert.throws(() => tax(null), TypeError);
    assert.throws(() => tax(undefined), TypeError);
    assert.throws(() => tax(NaN), TypeError);
    assert.throws(() => tax(Infinity), TypeError);
  });

  it('throws RangeError for negative income', () => {
    assert.throws(() => tax(-1), RangeError);
    assert.throws(() => tax(-100_000), RangeError);
  });
});

describe('zero income', () => {
  it('returns zero tax and zero effective rate', () => {
    const result = tax(0);
    assert.equal(result.totalTax, 0);
    assert.equal(result.effectiveRate, 0);
    assert.equal(result.netIncome, 0);
    assert.equal(result.personalAllowance, 12_570);
  });
});

describe('income below personal allowance', () => {
  it('charges no tax on £10,000', () => {
    const result = tax(10_000);
    assert.equal(result.totalTax, 0);
    assert.equal(result.basicRateTax, 0);
    assert.equal(result.netIncome, 10_000);
  });

  it('charges no tax on £12,570 (exactly the allowance)', () => {
    assert.equal(tax(12_570).totalTax, 0);
  });
});

describe('basic rate band (£12,571 – £50,270)', () => {
  it('taxes £1 above the allowance at 20%', () => {
    assertApprox(tax(12_571).totalTax, 0.2, '£12,571');
  });

  it('calculates tax correctly for £20,000', () => {
    // taxable = 20000 - 12570 = 7430 → 7430 × 20% = 1486
    assertApprox(tax(20_000).totalTax, 1_486, '£20,000');
  });

  it('calculates tax correctly for £30,000', () => {
    // taxable = 30000 - 12570 = 17430 → 17430 × 20% = 3486
    assertApprox(tax(30_000).totalTax, 3_486, '£30,000');
  });

  it('calculates tax correctly for £50,270 (top of basic band)', () => {
    // taxable = 50270 - 12570 = 37700 → 37700 × 20% = 7540
    assertApprox(tax(50_270).totalTax, 7_540, '£50,270');
  });

  it('applies no higher-rate tax within the basic-rate band', () => {
    assert.equal(tax(40_000).higherRateTax, 0);
  });
});

describe('higher rate band (£50,271 – £125,140)', () => {
  it('taxes the first pound above the basic-rate limit at 40%', () => {
    const result = tax(50_271);
    assertApprox(result.basicRateTax, 7_540, 'basic portion');
    assertApprox(result.higherRateTax, 0.4, 'higher portion');
  });

  it('calculates tax correctly for £60,000', () => {
    // basic: 37700 × 20% = 7540
    // higher: (60000 - 50270) × 40% = 9730 × 40% = 3892
    const result = tax(60_000);
    assertApprox(result.basicRateTax, 7_540, 'basic');
    assertApprox(result.higherRateTax, 3_892, 'higher');
    assertApprox(result.totalTax, 11_432, 'total');
  });

  it('calculates tax correctly for £100,000', () => {
    // basic: 37700 × 20% = 7540
    // higher: (100000 - 50270) × 40% = 49730 × 40% = 19892
    const result = tax(100_000);
    assertApprox(result.basicRateTax, 7_540, 'basic');
    assertApprox(result.higherRateTax, 19_892, 'higher');
    assertApprox(result.totalTax, 27_432, 'total');
  });
});

describe('personal allowance taper (£100,001 – £125,140)', () => {
  it('reduces the personal allowance by £1 for every £2 above £100,000', () => {
    // At £102,000: reduction = (102000 - 100000) / 2 = 1000 → PA = 11,570
    assertApprox(tax(102_000).personalAllowance, 11_570, 'PA at £102k');
  });

  it('reduces the personal allowance to zero at £125,140', () => {
    assert.equal(tax(125_140).personalAllowance, 0);
  });

  it('keeps the personal allowance at zero above £125,140', () => {
    assert.equal(tax(150_000).personalAllowance, 0);
    assert.equal(tax(200_000).personalAllowance, 0);
  });

  it('applies effective 60% marginal rate in the taper zone (£100k–£125,140)', () => {
    // Extra £10k gross: £10k taxed at 40% (£4k) + PA drops by £5k → £5k of
    // previously tax-free income now taxed at the HIGHER rate 40% (£2k),
    // because the taper shifts the whole income stack up. Total £6k (60%).
    const diff = tax(110_000).totalTax - tax(100_000).totalTax;
    assertApprox(diff, 6_000, '60% effective marginal rate');
  });

  it('calculates the well-known HMRC value for £110,000', () => {
    // PA = 12,570 − 5,000 = 7,570; taxable = 102,430
    // basic: 37,700 × 20% = 7,540; higher: 64,730 × 40% = 25,892 → 33,432
    assertApprox(tax(110_000).totalTax, 33_432, '£110,000');
  });
});

describe('additional rate (above £125,140)', () => {
  it('calculates tax correctly for £150,000', () => {
    // PA = 0 (above £125,140); taxable = 150,000. Bands are fixed widths of
    // taxable income — the basic band is always £37,700, even with PA tapered.
    // basic:      37700 × 20% = 7540
    // higher:     (125140 - 37700) × 40% = 87440 × 40% = 34976
    // additional: (150000 - 125140) × 45% = 11187
    const result = tax(150_000);
    assertApprox(result.basicRateTax, 7_540, 'basic');
    assertApprox(result.higherRateTax, 34_976, 'higher');
    assertApprox(result.additionalRateTax, 11_187, 'additional');
    assertApprox(result.totalTax, 53_703, 'total');
  });

  it('calculates tax correctly for £200,000', () => {
    // PA = 0; additional: (200000 - 125140) × 45% = 74860 × 45% = 33687
    // total: 7540 + 34976 + 33687 = 76203
    const result = tax(200_000);
    assertApprox(result.basicRateTax, 7_540, 'basic');
    assertApprox(result.higherRateTax, 34_976, 'higher');
    assertApprox(result.additionalRateTax, 33_687, 'additional');
    assertApprox(result.totalTax, 76_203, 'total');
  });
});

describe('taper boundary and scale factor', () => {
  it('calculates the exact PA-exhaustion boundary at £125,140', () => {
    // PA = 0; taxable = 125,140
    // basic: 37700 × 20% = 7540; higher: 87440 × 40% = 34976 → 42516
    assertApprox(tax(125_140).totalTax, 42_516, '£125,140');
  });

  it('taper reduces PA by £1 for every full £2 (floor behaviour)', () => {
    assert.equal(tax(100_001).personalAllowance, 12_570); // £1 over → floor(0.5) = 0
    assert.equal(tax(100_002).personalAllowance, 12_569); // £2 over → £1 reduction
  });

  it('scaleFactor scales all bands linearly: tax(k·g, k) = k·tax(g, 1)', () => {
    for (const gross of [30_000, 60_000, 110_000, 150_000]) {
      const k = 1.2;
      const scaled = calculateIncomeTax(gross * k, k).totalTax;
      const unscaled = tax(gross).totalTax * k;
      assert.ok(Math.abs(scaled - unscaled) <= 1, `£${gross}: ${scaled} vs ${unscaled}`);
    }
  });
});

describe('effective rate and net income', () => {
  it('effective rate is between 0 and 1 for all tested incomes', () => {
    for (const gross of [0, 5_000, 20_000, 60_000, 100_000, 150_000, 300_000]) {
      const { effectiveRate } = tax(gross);
      assert.ok(
        effectiveRate >= 0 && effectiveRate <= 1,
        `effectiveRate out of range for £${gross}: ${effectiveRate}`
      );
    }
  });

  it('net income equals gross minus total tax', () => {
    for (const gross of [15_000, 45_000, 80_000, 130_000, 250_000]) {
      const result = tax(gross);
      assertApprox(result.netIncome, result.grossIncome - result.totalTax, `£${gross}`);
    }
  });

  it('effective rate is strictly non-decreasing with income', () => {
    const incomes = [10_000, 25_000, 60_000, 100_000, 150_000];
    const rates = incomes.map((g) => tax(g).effectiveRate);
    for (let i = 1; i < rates.length; i++) {
      assert.ok(
        rates[i] >= rates[i - 1],
        `effective rate dropped from £${incomes[i - 1]} to £${incomes[i]}`
      );
    }
  });
});

describe('return shape', () => {
  it('includes all expected fields', () => {
    const result = tax(50_000);
    const keys = [
      'grossIncome',
      'personalAllowance',
      'taxableIncome',
      'basicRateTax',
      'higherRateTax',
      'additionalRateTax',
      'totalTax',
      'effectiveRate',
      'netIncome',
      'taxYear',
    ];
    for (const key of keys) {
      assert.ok(key in result, `missing field: ${key}`);
    }
  });

  it('taxYear is set to 2025/26', () => {
    assert.equal(tax(50_000).taxYear, '2025/26');
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
