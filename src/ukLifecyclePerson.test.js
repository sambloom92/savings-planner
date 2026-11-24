import assert from 'node:assert/strict';
import {
  LIFECYCLE_CONSTANTS,
  createPerson,
  recordStatePensionClaim,
  statePensionGrossAt,
  workingYearPay,
  recordNiQualifyingYear,
  investTaxFreeCash,
  fundExpenseWhileWorking,
  bedAndIsa,
  harvestGainsWithinExemption,
  takePensionLumpSum,
  enterRetirement,
  class3CostThisYear,
  settleClass3,
  drawPensionWithinAllowance,
  drawGiaWithinExemption,
  drawIsa,
  drawGiaTaxable,
  drawPensionTaxable,
} from './ukLifecyclePerson.js';

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

const profile = {
  currentAge: 30,
  retirementAge: 60,
  grossIncome: 40_000,
  employeePensionRate: 0.05,
  employerPensionRate: 0.03,
  niContributionYears: 10,
};
const person = (overrides = {}, pots = {}, retirementOptions = null) =>
  createPerson({ ...profile, ...overrides }, pots, retirementOptions, 2026);
const econ = (cumulInflation = 1, thresholdScale = 1, statePensionIndex = 1) => ({
  cumulInflation,
  thresholdScale,
  statePensionIndex,
});
const baseYear = { wageGrowthRate: 0.03, inflationRate: 0.02, boeRate: 0.04 };
const LSA = 268_275;

// ---------------------------------------------------------------------------

describe('createPerson', () => {
  it('sets up running state from the inputs', () => {
    const P = person({}, { pensionBalance: 10_000.004, isaBalance: 5_000, giaBalance: 2_000 });
    assert.equal(P.income, 40_000);
    assert.equal(P.niYears, 10);
    assert.equal(P.pension, 10_000);
    assert.equal(P.isa, 5_000);
    assert.equal(P.costBasis, 2_000); // defaults to the GIA balance
    assert.equal(P.lsaRemaining, LSA);
    assert.equal(P.studentLoan, null);
    assert.equal(P.retiredAt, null);
  });

  it('applies the default state pension and access ages', () => {
    const P = person();
    assert.equal(P.statePensionAge, LIFECYCLE_CONSTANTS.statePension.defaultStatePensionAge);
    assert.equal(P.pensionAccessAge, LIFECYCLE_CONSTANTS.pension.defaultAccessAge);
    assert.equal(P.spClaimAge, P.statePensionAge);
  });

  it('a matched employer contribution is 0 below the threshold', () => {
    const below = person({ employerMatch: true, employerMatchThreshold: 0.06 });
    const at = person({ employerMatch: true, employerMatchThreshold: 0.05 });
    assert.equal(below.employerRate, 0);
    assert.equal(at.employerRate, 0.03);
  });

  it('sets up a student loan only with a plan and a balance', () => {
    assert.equal(person({ studentLoanPlan: 'plan2' }).studentLoan, null);
    const P = person({ studentLoanPlan: 'plan2' }, { studentLoan: { balance: 30_000 } });
    assert.equal(P.studentLoan.balance, 30_000);
    assert.equal(P.studentLoan.writeOffYear, 2026 + 30);
  });

  it('rejects bad person inputs', () => {
    assert.throws(() => person({ currentAge: 0 }), TypeError);
    assert.throws(() => person({ retirementAge: 30 }), RangeError);
    assert.throws(() => person({ employeePensionRate: 1.2 }), RangeError);
    assert.throws(() => person({ studentLoanPlan: 'plan9' }), TypeError);
    assert.throws(() => person({}, { pensionBalance: -1 }), TypeError);
    assert.throws(
      () => person({}, {}, { annuity: { purchaseAge: 70, sizing: 'some', amountReal: 1 } }),
      RangeError
    );
  });
});

describe('state pension', () => {
  it('is nothing before the claim age', () => {
    const P = person({ niContributionYears: 35 });
    assert.equal(statePensionGrossAt(P, 66, 35, econ()), 0);
  });

  it('is the full rate grown by the triple lock at and after the claim age', () => {
    const P = person({ niContributionYears: 35 });
    const full = LIFECYCLE_CONSTANTS.statePension.fullAnnualAmount;
    near(statePensionGrossAt(P, 67, 35, econ(1, 1, 1.5)), full * 1.5);
  });

  it('a deferral extra is fixed at claim and then rises with CPI only', () => {
    const P = person({ niContributionYears: 35, statePensionDeferralYears: 1 });
    const full = LIFECYCLE_CONSTANTS.statePension.fullAnnualAmount;
    recordStatePensionClaim(P, 68, econ(1.1, 1, 1.2));
    const later = statePensionGrossAt(P, 70, 35, econ(1.21, 1, 1.5));
    near(later, full * 1.5 + full * 1.2 * 0.0578 * (1.21 / 1.1));
  });
});

describe('a working year', () => {
  it('works out pay, contributions, tax, NI and take-home', () => {
    // 40,000 salary, 5% salary sacrifice, 3% employer:
    //   adjusted gross 38,000; tax (38,000 − 12,570) × 20% = 5,086;
    //   NI (38,000 − 12,570) × 8% = 2,034.40; take-home 30,879.60.
    const P = person();
    const pay = workingYearPay(P, 30, 2026, 0, baseYear, econ());
    assert.equal(pay.employeeContrib, 2_000);
    assert.equal(pay.employerContrib, 1_200);
    assert.equal(pay.adjustedGross, 38_000);
    assert.equal(pay.incomeTax, 5_086);
    near(pay.employeeNI, 2_034.4);
    near(pay.netTakeHome, 30_879.6);
  });

  it('grows pay from the second year and applies an hours change', () => {
    const P = person({ employmentChanges: [{ age: 31, fraction: 0.5 }] });
    workingYearPay(P, 30, 2026, 0, baseYear, econ());
    assert.equal(P.income, 40_000);
    const pay = workingYearPay(P, 31, 2027, 1, baseYear, econ(1.02, 1.02, 1.03));
    assert.equal(P.income, 41_200); // the full-time track keeps growing
    assert.equal(pay.effectiveIncome, 20_600);
  });

  it('counts a qualifying NI year only before state pension age', () => {
    const P = person();
    const pay = workingYearPay(P, 30, 2026, 0, baseYear, econ());
    assert.equal(recordNiQualifyingYear(P, pay), true);
    assert.equal(P.niYears, 11);
    const old = person({ currentAge: 67, retirementAge: 70 });
    const oldPay = workingYearPay(old, 67, 2026, 0, baseYear, econ());
    assert.equal(recordNiQualifyingYear(old, oldPay), false);
    assert.equal(oldPay.employeeNI, 0);
  });
});

describe('moving money between pots', () => {
  it('tax-free cash fills the ISA headroom left, then the GIA at cost', () => {
    const P = person();
    const used = investTaxFreeCash(P, 30_000, 5_000);
    assert.equal(P.isa, 15_000);
    assert.equal(P.gia, 15_000);
    assert.equal(P.costBasis, 15_000);
    assert.equal(used, 20_000);
  });

  it('a one-off expense while working uses cash, then GIA, then ISA', () => {
    // GIA has no gains, so it sells at face value with no CGT.
    const P = person({}, { giaBalance: 3_000, isaBalance: 10_000 });
    const f = fundExpenseWhileWorking(P, 10_000, 2_000, 38_000, 1);
    assert.equal(f.fromSavings, 2_000);
    assert.equal(f.fromGIAGross, 3_000);
    assert.equal(f.giaCGT, 0);
    assert.equal(f.fromISA, 5_000);
    assert.equal(f.shortfall, 0);
    assert.equal(f.cashLeft, 0);
    assert.equal(P.isa, 5_000);
  });

  it('reports what a one-off expense could not fund', () => {
    const P = person({}, { isaBalance: 1_000 });
    assert.equal(fundExpenseWhileWorking(P, 5_000, 0, 38_000, 1).shortfall, 4_000);
  });

  it('bed and ISA moves GIA into the ISA headroom (no CGT within the exemption)', () => {
    // £10,000 of GIA with a £1,000 gain: well inside the £3,000 exemption.
    const P = person({}, { giaBalance: 10_000, giaCostBasis: 9_000 });
    const bed = bedAndIsa(P, 6_000, 38_000, 3_000, 1);
    assert.equal(bed.gross, 6_000);
    assert.equal(bed.cgt, 0);
    assert.equal(P.isa, 6_000);
    assert.equal(P.gia, 4_000);
    assert.equal(P.costBasis, 3_600); // reduced in proportion
    assert.equal(bed.gain, 600); // 10% of the £6,000 sold
  });

  it('the rest of the CGT allowance realises gains and resets the base cost', () => {
    // A £5,000 gain, £3,000 of allowance: £3,000 realised, £2,000 still unrealised.
    const P = person({}, { giaBalance: 20_000, giaCostBasis: 15_000 });
    assert.equal(harvestGainsWithinExemption(P, 3_000), 3_000);
    assert.equal(P.costBasis, 18_000);
    assert.equal(P.gia, 20_000);
    // A smaller gain than the allowance left is realised in full.
    const Q = person({}, { giaBalance: 20_000, giaCostBasis: 19_000 });
    assert.equal(harvestGainsWithinExemption(Q, 2_500), 1_000);
    assert.equal(Q.costBasis, 20_000);
  });

  it('nothing is realised at a loss, with no GIA, or with the allowance used up', () => {
    const loss = person({}, { giaBalance: 10_000, giaCostBasis: 12_000 });
    assert.equal(harvestGainsWithinExemption(loss, 3_000), 0);
    assert.equal(loss.costBasis, 12_000);
    assert.equal(harvestGainsWithinExemption(person(), 3_000), 0);
    const used = person({}, { giaBalance: 10_000, giaCostBasis: 5_000 });
    assert.equal(harvestGainsWithinExemption(used, 0), 0);
    assert.equal(used.costBasis, 5_000);
  });
});

describe('retirement choices', () => {
  it('a 25% lump sum: £20,000 to the ISA, the rest to the GIA, within the allowance', () => {
    const P = person({}, { pensionBalance: 400_000 });
    P.pclsPct = 0.25;
    assert.equal(takePensionLumpSum(P), 20_000);
    assert.equal(P.pcls.lumpSum, 100_000);
    assert.equal(P.pension, 300_000);
    assert.equal(P.isa, 20_000);
    assert.equal(P.gia, 80_000);
    assert.equal(P.lsaRemaining, LSA - 100_000);
    assert.equal(P.pcls.capped, false);
  });

  it('the lump sum is capped by the Lump Sum Allowance left', () => {
    const P = person({}, { pensionBalance: 400_000 });
    P.pclsPct = 0.25;
    P.lsaRemaining = 50_000;
    takePensionLumpSum(P);
    assert.equal(P.pcls.lumpSum, 50_000);
    assert.equal(P.pcls.capped, true);
    assert.equal(P.lsaRemaining, 0);
  });

  it('retiring before the access age defers the lump sum', () => {
    const P = person({ pensionAccessAge: 57 }, { pensionBalance: 400_000 });
    enterRetirement(P, 50, 90, { takePCLS: true, pclsPercentage: 0.25 });
    assert.equal(P.retiredAt, 50);
    assert.equal(P.pcls.atEntry, false);
    assert.equal(P.pcls.pending, true);
    assert.equal(P.pension, 400_000);
  });

  it('a Class 3 top-up targets the gap to 35 years, within the bridge to state pension age', () => {
    const P = person({ niContributionYears: 30, topUpStatePension: true });
    enterRetirement(P, 60, 90, { takePCLS: false, pclsPercentage: 0.25 });
    assert.equal(P.class3.yearsRemaining, 5);
    near(class3CostThisYear(P, 60, econ(1.1)), 956.8 * 1.1);
    assert.equal(class3CostThisYear(P, 67, econ()), 0); // no buying from state pension age
  });

  it('no Class 3 top-up if it could not reach the 10-year minimum', () => {
    const P = person({ niContributionYears: 2, topUpStatePension: true });
    enterRetirement(P, 63, 90, { takePCLS: false, pclsPercentage: 0.25 });
    assert.equal(P.class3.yearsRemaining, 0);
  });

  it('a Class 3 year is bought only if its whole cost was funded', () => {
    const P = person({ niContributionYears: 30, topUpStatePension: true });
    enterRetirement(P, 60, 90, { takePCLS: false, pclsPercentage: 0.25 });
    assert.deepEqual(settleClass3(P, 956.8, 0), {
      unfunded: 0,
      bought: true,
      contribution: 956.8,
    });
    assert.equal(P.class3.yearsBought, 1);
    assert.equal(settleClass3(P, 956.8, 100).bought, false);
    assert.equal(P.class3.yearsBought, 1);
  });
});

describe('drawdown steps', () => {
  const retiree = (pots) => {
    const P = person({ currentAge: 60, retirementAge: 61 }, pots);
    enterRetirement(P, 61, 90, { takePCLS: false, pclsPercentage: 0.25 });
    return P;
  };

  it('1. pension within the personal allowance: £16,760 gross, a quarter tax-free (UFPLS)', () => {
    // £12,570 of taxable room ÷ 75% taxable = £16,760; £4,190 of it tax-free.
    const P = retiree({ pensionBalance: 100_000 });
    const s = drawPensionWithinAllowance(P, 50_000, true, 0, 1);
    assert.deepEqual(s, { draw: 16_760, taxFree: 4_190, remaining: 33_240 });
    assert.equal(P.lsaRemaining, LSA - 4_190);
  });

  it('1. leaves the pension alone when guaranteed income fills the allowance, or before access', () => {
    const P = retiree({ pensionBalance: 100_000 });
    assert.equal(drawPensionWithinAllowance(P, 50_000, true, 12_570, 1).draw, 0);
    assert.equal(drawPensionWithinAllowance(P, 50_000, false, 0, 1).draw, 0);
  });

  it('2. GIA up to the exemption, reporting the gain fraction before the sale', () => {
    // Half of the GIA is gain, so £6,000 sold realises the £3,000 exempt amount.
    const P = retiree({ giaBalance: 20_000, giaCostBasis: 10_000 });
    const s = drawGiaWithinExemption(P, 10_000, 20_000, 1);
    assert.equal(s.gainFracPre, 0.5);
    assert.equal(s.draw, 6_000);
    assert.equal(s.cgt, 0);
    assert.equal(s.remaining, 4_000);
  });

  it('3. ISA, tax-free', () => {
    const P = retiree({ isaBalance: 3_000 });
    assert.deepEqual(drawIsa(P, 5_000), { draw: 3_000, remaining: 2_000 });
  });

  it('4. GIA beyond the exemption pays CGT on the gains', () => {
    // Basic-rate taxpayer: every £1 sold is half gain, taxed at 18% → net 91p.
    const P = retiree({ giaBalance: 50_000, giaCostBasis: 25_000 });
    const s = drawGiaTaxable(P, 9_100, 20_000, 1);
    near(s.draw, 10_000);
    near(s.cgt, 900);
    near(s.remaining, 0);
  });

  it('5. taxable pension grosses up for income tax above the allowance', () => {
    // With the allowance already used, UFPLS £1 = 25p tax-free + 75p at 20% → 85p net.
    const P = retiree({ pensionBalance: 100_000 });
    const s = drawPensionTaxable(P, 8_500, true, 12_570, 1);
    near(s.draw, 10_000);
    near(s.taxFree, 2_500);
    near(s.remaining, 0);
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
