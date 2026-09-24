import assert from 'node:assert/strict';
import { LIFECYCLE_CONSTANTS, projectLifecycle } from './ukLifecycle.js';

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
// Shared fixtures
// ---------------------------------------------------------------------------

// One-year baseline: age 30→31, £40k salary, 5% employee / 3% employer pension,
// no debts, no student loan. Verifiable by hand.
const baseProfile = {
  currentAge: 30,
  retirementAge: 31,
  currentYear: 2025,
  grossIncome: 40_000,
  employeePensionRate: 0.05,
  employerPensionRate: 0.03,
  niContributionYears: 10,
};

const baseRates = {
  savingsRate: 0.07,
  wageGrowthRate: 0.03,
  debtRate: 0.05,
  inflationRate: 0.03,
};

function run(profile = baseProfile, rates = baseRates, pots = {}) {
  return projectLifecycle(profile, rates, pots);
}

// ---------------------------------------------------------------------------
// Pre-computed expected values for the baseline one-year case
//
//   employeeContrib   = 40,000 × 0.05         = 2,000
//   employerContrib   = 40,000 × 0.03         = 1,200
//   adjustedGross     = 40,000 − 2,000        = 38,000
//   incomeTax         = (38,000−12,570)×0.20  = 5,086
//   employeeNI        = (38,000−12,570)×0.08  = 2,034.40
//   netTakeHome       = 40,000−2,000−5,086−2,034.40 = 30,879.60
//   isaContrib        = min(30,879.60, 20,000) = 20,000
//   giaContrib        = 30,879.60 − 20,000    = 10,879.60
//   pension: (0+2000+1200)×1.07               = 3,424
//   isa:     (0+20,000)×1.07                  = 21,400
//   gia:     (0+10,879.60)×1.07               = 11,641.17  (growth=761.57)
//   niYears: 10+1                             = 11
//   statePension: (11/35)×11,973              = 3,762.94
// ---------------------------------------------------------------------------

describe('LIFECYCLE_CONSTANTS', () => {
  it('state pension full annual amount is £11,973 (2025/26: £230.25/week)', () => {
    assert.equal(LIFECYCLE_CONSTANTS.statePension.fullAnnualAmount, 11_973);
  });

  it('requires 35 qualifying years for full state pension, minimum 10', () => {
    assert.equal(LIFECYCLE_CONSTANTS.statePension.qualifyingYearsForFull, 35);
    assert.equal(LIFECYCLE_CONSTANTS.statePension.minimumQualifyingYears, 10);
  });

  it('default state pension age is 67', () => {
    assert.equal(LIFECYCLE_CONSTANTS.statePension.defaultStatePensionAge, 67);
  });
});

describe('input validation', () => {
  it('throws TypeError for non-integer currentAge / retirementAge', () => {
    assert.throws(() => run({ ...baseProfile, currentAge: 30.5 }), TypeError);
    assert.throws(() => run({ ...baseProfile, retirementAge: 65.5 }), TypeError);
  });

  it('throws RangeError when retirementAge <= currentAge', () => {
    assert.throws(() => run({ ...baseProfile, retirementAge: 30 }), RangeError);
    assert.throws(() => run({ ...baseProfile, retirementAge: 29 }), RangeError);
  });

  it('throws TypeError for non-numeric grossIncome', () => {
    assert.throws(() => run({ ...baseProfile, grossIncome: '40000' }), TypeError);
    assert.throws(() => run({ ...baseProfile, grossIncome: NaN }), TypeError);
  });

  it('throws TypeError for negative pension rates', () => {
    assert.throws(() => run({ ...baseProfile, employeePensionRate: -0.01 }), TypeError);
    assert.throws(() => run({ ...baseProfile, employerPensionRate: -0.01 }), TypeError);
  });

  it('throws RangeError for pension rates > 1', () => {
    assert.throws(() => run({ ...baseProfile, employeePensionRate: 1.01 }), RangeError);
  });

  it('throws TypeError for non-integer niContributionYears', () => {
    assert.throws(() => run({ ...baseProfile, niContributionYears: 5.5 }), TypeError);
    assert.throws(() => run({ ...baseProfile, niContributionYears: -1 }), TypeError);
  });

  it('throws TypeError for unrecognised studentLoanPlan', () => {
    assert.throws(() => run({ ...baseProfile, studentLoanPlan: 'plan9' }), TypeError);
  });

  it('throws TypeError for negative debtRate (savings/inflation rates may be negative)', () => {
    assert.throws(() => run(baseProfile, { ...baseRates, debtRate: -0.01 }), TypeError);
    // negative savingsRate is allowed (falling markets floor balances at 0)
    assert.doesNotThrow(() => run(baseProfile, { ...baseRates, savingsRate: -0.05 }));
  });

  it('throws TypeError for negative initial balances in pots', () => {
    assert.throws(() => run(baseProfile, baseRates, { pensionBalance: -1 }), TypeError);
    assert.throws(() => run(baseProfile, baseRates, { isaBalance: -1 }), TypeError);
    assert.throws(() => run(baseProfile, baseRates, { giaBalance: -1 }), TypeError);
  });

  it('throws TypeError for mortgage with non-integer termYears', () => {
    assert.throws(
      () => run(baseProfile, baseRates, { mortgage: { balance: 100_000, termYears: 25.5 } }),
      TypeError
    );
  });

  it('throws TypeError for unrecognised mortgage type', () => {
    assert.throws(
      () =>
        run(baseProfile, baseRates, {
          mortgage: { balance: 100_000, termYears: 25, type: 'variable' },
        }),
      TypeError
    );
  });

  it('throws RangeError for unsecured debt where monthlyPayment <= monthly interest', () => {
    // balance 10,000 at 24%: monthly interest = round2(10,000 × 0.24/12) = 200
    assert.throws(
      () =>
        run(
          baseProfile,
          { ...baseRates, debtRate: 0.24 },
          {
            unsecuredDebts: [{ balance: 10_000, monthlyPayment: 200 }],
          }
        ),
      RangeError
    );
  });

  it('accepts zero for all optional monetary pots', () => {
    assert.doesNotThrow(() => run(baseProfile, baseRates, {}));
  });
});

describe('baseline one-year income and tax calculation', () => {
  it('salary sacrifice: adjustedGrossIncome = grossIncome − employeeContribution', () => {
    const r = run();
    const y = r.yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 2_000, 'employeeContrib');
    assertApprox(y.employerContribution, 1_200, 'employerContrib');
    assertApprox(y.adjustedGrossIncome, 38_000, 'adjustedGross');
  });

  it('income tax computed on adjustedGrossIncome (38,000 → £5,086)', () => {
    const y = run().yearlyBreakdown[0];
    assertApprox(y.incomeTax, 5_086, 'incomeTax');
  });

  it('employee NI computed on adjustedGrossIncome (38,000 → £2,034.40)', () => {
    const y = run().yearlyBreakdown[0];
    assertApprox(y.employeeNI, 2_034.4, 'employeeNI');
  });

  it('netTakeHome = gross − employeePension − tax − NI (30,879.60)', () => {
    const y = run().yearlyBreakdown[0];
    assertApprox(y.netTakeHome, 30_879.6, 'netTakeHome');
  });

  it('salary sacrifice saves income tax vs no-pension equivalent', () => {
    // Without salary sacrifice: tax on 40,000 = (40,000−12,570)×0.20 = 5,486
    // With 5% sacrifice: tax on 38,000 = 5,086 → saving = 400 (= 2,000×0.20)
    const y = run().yearlyBreakdown[0];
    assert.ok(y.incomeTax < 5_486, 'tax reduced by salary sacrifice');
  });
});

describe('high earner above the additional-rate threshold', () => {
  it('income tax on £142,500 adjusted gross reflects PA taper and fixed bands', () => {
    // £150k gross, 5% sacrifice → adjustedGross = 142,500; PA fully tapered.
    // taxable = 142,500: basic 37,700×20% = 7,540; higher 87,440×40% = 34,976;
    // additional (142,500−125,140)×45% = 7,812 → 50,328
    const r = run({ ...baseProfile, grossIncome: 150_000 });
    const y = r.yearlyBreakdown[0];
    assertApprox(y.adjustedGrossIncome, 142_500, 'adjustedGross');
    assertApprox(y.incomeTax, 50_328, 'incomeTax');
  });

  it('netTakeHome for £150k gross is gross − sacrifice − tax − NI', () => {
    // NI on 142,500: (50,270−12,570)×8% + (142,500−50,270)×2% = 3,016 + 1,844.60
    const y = run({ ...baseProfile, grossIncome: 150_000 }).yearlyBreakdown[0];
    assertApprox(y.employeeNI, 4_860.6, 'employeeNI');
    assertApprox(y.netTakeHome, 150_000 - 7_500 - 50_328 - 4_860.6, 'netTakeHome');
  });
});

describe('living expenses', () => {
  const expProfile = { ...baseProfile, retirementAge: 33, annualLivingExpenses: 20_000 };

  it('year 1 living expenses equal the today-money input', () => {
    const y = run(expProfile).yearlyBreakdown[0];
    assertApprox(y.livingExpenses, 20_000, 'livingExpenses year 1');
  });

  it('living expenses scale with inflation in later years', () => {
    const rows = run(expProfile).yearlyBreakdown;
    assertApprox(rows[1].livingExpenses, 20_600, 'year 2 = 20,000 × 1.03');
    assertApprox(rows[2].livingExpenses, 21_218, 'year 3 = 20,000 × 1.03²');
  });

  it('availableForSavings = netTakeHome − debt payments − living expenses', () => {
    const y = run(expProfile).yearlyBreakdown[0];
    assertApprox(
      y.availableForSavings,
      y.netTakeHome - y.mortgagePayment - y.unsecuredDebtPayments - y.livingExpenses,
      'availableForSavings'
    );
  });

  it('availableForSavings floors at zero when expenses exceed take-home', () => {
    const y = run({ ...expProfile, annualLivingExpenses: 100_000 }).yearlyBreakdown[0];
    assert.equal(y.availableForSavings, 0);
    assert.equal(y.isaContribution, 0);
    assert.equal(y.giaContribution, 0);
  });
});

describe('ISA-first savings allocation', () => {
  it('ISA filled to £20,000 before any goes to GIA when surplus > £20k', () => {
    // baseline: availableForSavings = 30,879.60 > 20,000
    const y = run().yearlyBreakdown[0];
    assertApprox(y.isaContribution, 20_000, 'isaContrib');
    assertApprox(y.giaContribution, 10_879.6, 'giaContrib');
  });

  it('when surplus < £20k, all goes to ISA and GIA receives nothing', () => {
    // Use higher debt payments to constrain savings
    const r = run(baseProfile, baseRates, {
      unsecuredDebts: [{ balance: 50_000, monthlyPayment: 2_400, label: 'Loan' }],
    });
    // With £2,400/month = £28,800/year debt, savings will be very limited
    const y = r.yearlyBreakdown[0];
    assert.ok(y.isaContribution <= 20_000, 'ISA capped at 20k');
    assert.ok(y.giaContribution === 0 || y.isaContribution < 20_000, 'GIA=0 or ISA below cap');
    if (y.isaContribution < 20_000) {
      assert.equal(y.giaContribution, 0);
    }
  });

  it('when availableForSavings is negative or zero, both ISA and GIA receive nothing', () => {
    // Huge mortgage payment swamps take-home
    const r = run(
      baseProfile,
      { ...baseRates, debtRate: 0 },
      {
        unsecuredDebts: [{ balance: 1_000_000, monthlyPayment: 5_000 }],
      }
    );
    const y = r.yearlyBreakdown[0];
    assert.equal(y.isaContribution, 0);
    assert.equal(y.giaContribution, 0);
  });
});

describe('pot growth', () => {
  it('pension: (opening + employee + employer) × (1 + savingsRate)', () => {
    // (0 + 2,000 + 1,200) × 1.07 = 3,424
    const y = run().yearlyBreakdown[0];
    assertApprox(y.pension.closingBalance, 3_424, 'pension closing');
    assertApprox(y.pension.growthAmount, 224, 'pension growth');
  });

  it('ISA: (opening + contribution) × (1 + savingsRate)', () => {
    // (0 + 20,000) × 1.07 = 21,400
    const y = run().yearlyBreakdown[0];
    assertApprox(y.isa.closingBalance, 21_400, 'ISA closing');
    assertApprox(y.isa.growthAmount, 1_400, 'ISA growth');
  });

  it('GIA: (opening + contribution) × (1 + savingsRate); costBasis tracks contributions only', () => {
    const y = run().yearlyBreakdown[0];
    assertApprox(y.gia.closingBalance, 11_641.17, 'GIA closing');
    assertApprox(y.gia.growthAmount, 761.57, 'GIA growth');
    assertApprox(y.gia.closingCostBasis, 10_879.6, 'GIA costBasis');
    assertApprox(y.gia.unrealisedGain, 761.57, 'unrealisedGain');
  });

  it('existing balances in pots compound from year one', () => {
    const r = run(baseProfile, baseRates, { pensionBalance: 50_000, isaBalance: 20_000 });
    const y = r.yearlyBreakdown[0];
    // pension: (50,000 + 2,000 + 1,200) × 1.07 = 53,200 × 1.07 = 56,924
    assertApprox(y.pension.closingBalance, 56_924, 'pension with existing balance');
    // isa: (20,000 + 20,000) × 1.07 = 42,800
    assertApprox(y.isa.closingBalance, 42_800, 'ISA with existing balance');
  });

  it('giaCostBasis from pots is preserved and contributions accumulate', () => {
    const r = run(baseProfile, baseRates, { giaBalance: 10_000, giaCostBasis: 7_000 });
    const y = r.yearlyBreakdown[0];
    // costBasis = 7,000 + 10,879.60 = 17,879.60
    assertApprox(y.gia.closingCostBasis, 17_879.6, 'costBasis with existing');
  });
});

describe('wage growth', () => {
  it('year 0 uses the initial grossIncome unchanged', () => {
    const r = run({ ...baseProfile, retirementAge: 33 });
    assert.equal(r.yearlyBreakdown[0].grossIncome, 40_000);
  });

  it('year 1 income = year 0 income × (1 + wageGrowthRate)', () => {
    const r = run({ ...baseProfile, retirementAge: 33 });
    const [y0, y1] = r.yearlyBreakdown;
    assertApprox(y1.grossIncome, y0.grossIncome * 1.03, 'Y1 income');
  });

  it('income compounds correctly over multiple years', () => {
    const r = run({ ...baseProfile, retirementAge: 35 });
    const last = r.yearlyBreakdown[r.yearlyBreakdown.length - 1];
    // 5 years of 3% growth: 40,000 × 1.03^4 (growth from year 1, so 4 applications)
    assertApprox(last.grossIncome, 40_000 * Math.pow(1.03, 4), 'Y4 income');
  });

  it('year labels and age labels increment correctly', () => {
    const r = run({ ...baseProfile, retirementAge: 33, currentYear: 2030 });
    assert.equal(r.yearlyBreakdown[0].year, 2030);
    assert.equal(r.yearlyBreakdown[0].age, 30);
    assert.equal(r.yearlyBreakdown[2].year, 2032);
    assert.equal(r.yearlyBreakdown[2].age, 32);
    assert.equal(r.startYear, 2030);
    assert.equal(r.retirementYear, 2033);
  });
});

describe('mortgage amortisation', () => {
  it('repayment mortgage balance reduces each year', () => {
    const r = run({ ...baseProfile, retirementAge: 35 }, baseRates, {
      mortgage: { balance: 200_000, termYears: 25 },
    });
    const [y0, y1] = r.yearlyBreakdown;
    assert.ok(y0.mortgage.closingBalance < 200_000, 'balance reduces Y0');
    assert.ok(y1.mortgage.closingBalance < y0.mortgage.closingBalance, 'balance reduces Y1');
  });

  it('zero-rate mortgage fully pays off in exactly termYears', () => {
    // balance=5,000, term=1 year, debtRate=0 → monthly=416.67, paid off in 12 months
    const r = run(
      { ...baseProfile, retirementAge: 32 },
      { ...baseRates, debtRate: 0 },
      {
        mortgage: { balance: 5_000, termYears: 1 },
      }
    );
    assertApprox(r.yearlyBreakdown[0].mortgage.closingBalance, 0, 'paid off after Y0');
  });

  it('after mortgage pays off, subsequent years show zero payment', () => {
    const r = run(
      { ...baseProfile, retirementAge: 32 },
      { ...baseRates, debtRate: 0 },
      {
        mortgage: { balance: 5_000, termYears: 1 },
      }
    );
    const y1 = r.yearlyBreakdown[1];
    assert.equal(y1.mortgage.payment, 0);
    assert.equal(y1.mortgagePayment, 0);
  });

  it('after mortgage pays off, freed-up cash goes to savings', () => {
    const r = run(
      { ...baseProfile, retirementAge: 32 },
      { ...baseRates, debtRate: 0 },
      {
        mortgage: { balance: 5_000, termYears: 1 },
      }
    );
    // Y0: paying mortgage; Y1: mortgage gone, more available for savings
    assert.ok(
      r.yearlyBreakdown[1].availableForSavings > r.yearlyBreakdown[0].availableForSavings,
      'more available after mortgage clears'
    );
  });

  it('interest-only mortgage: balance unchanged, only interest paid', () => {
    const r = run({ ...baseProfile, retirementAge: 33 }, baseRates, {
      mortgage: { balance: 100_000, termYears: 25, type: 'interest-only' },
    });
    for (const y of r.yearlyBreakdown) {
      assertApprox(y.mortgage.closingBalance, 100_000, `balance unchanged year ${y.year}`);
      assert.equal(y.mortgage.capitalRepaid, 0);
      assert.ok(y.mortgage.interestCharged > 0, 'interest charged each year');
    }
  });

  it('overpayment reduces balance faster than standard repayment', () => {
    const standard = run({ ...baseProfile, retirementAge: 35 }, baseRates, {
      mortgage: { balance: 200_000, termYears: 25 },
    });
    const withOverpay = run({ ...baseProfile, retirementAge: 35 }, baseRates, {
      mortgage: { balance: 200_000, termYears: 25, monthlyOverpayment: 200 },
    });
    const lastStd = standard.yearlyBreakdown[standard.yearlyBreakdown.length - 1];
    const lastOver = withOverpay.yearlyBreakdown[withOverpay.yearlyBreakdown.length - 1];
    assert.ok(
      lastOver.mortgage.closingBalance < lastStd.mortgage.closingBalance,
      'overpayment results in lower balance'
    );
  });
});

describe('unsecured debt amortisation', () => {
  it('unsecured debt reduces each year and pays off', () => {
    // Small debt: 2,000 at 0% interest, monthly payment 200 → paid off in 10 months (< 1 year)
    const r = run(
      { ...baseProfile, retirementAge: 33 },
      { ...baseRates, debtRate: 0 },
      {
        unsecuredDebts: [{ balance: 2_000, monthlyPayment: 200, label: 'Small loan' }],
      }
    );
    assertApprox(r.yearlyBreakdown[0].unsecuredDebts[0].closingBalance, 0, 'paid off Y0');
    assert.equal(r.yearlyBreakdown[1].unsecuredDebts[0].payment, 0);
  });

  it('multiple unsecured debts tracked independently', () => {
    // Card A (£1k, £500/month) clears in 2 months; Loan B (£10k, £500/month) runs for 20 months
    const r = run(
      { ...baseProfile, retirementAge: 32 },
      { ...baseRates, debtRate: 0 },
      {
        unsecuredDebts: [
          { balance: 1_000, monthlyPayment: 500, label: 'Card A' },
          { balance: 10_000, monthlyPayment: 500, label: 'Loan B' },
        ],
      }
    );
    const y0 = r.yearlyBreakdown[0];
    assert.equal(y0.unsecuredDebts.length, 2);
    assert.equal(y0.unsecuredDebts[0].label, 'Card A');
    assertApprox(y0.unsecuredDebts[0].closingBalance, 0, 'Card A paid off');
    assert.ok(y0.unsecuredDebts[1].closingBalance > 0, 'Loan B still running');
  });
});

describe('student loan', () => {
  it('repayment deducted from netTakeHome each year when income above threshold', () => {
    // Plan 1 threshold £26,065; gross 40,000 → adjustedGross 38,000 → repayment = (38,000−26,065)×0.09
    const r = run({ ...baseProfile, studentLoanPlan: 'plan1' }, baseRates, {
      studentLoan: { balance: 20_000 },
    });
    const y = r.yearlyBreakdown[0];
    // repayment = round2((38,000 − 26,065) × 0.09) = round2(11,935 × 0.09) = round2(1,074.15) = 1,074.15
    assertApprox(y.studentLoanRepayment, 1_074.15, 'SL repayment');
    assert.ok(y.studentLoan.closingBalance < 20_000, 'balance reduces');
  });

  it('student loan written off when write-off year reached', () => {
    // plan1 writeOffYears=25; repaymentStartYear=2000 → writeOffYear=2025 = currentYear
    const r = run({ ...baseProfile, studentLoanPlan: 'plan1' }, baseRates, {
      studentLoan: { balance: 30_000, repaymentStartYear: 2000 },
    });
    const y = r.yearlyBreakdown[0];
    assert.equal(y.studentLoan.writtenOff, true);
    assert.equal(y.studentLoan.closingBalance, 0);
    assert.equal(y.studentLoanRepayment, 0);
    assert.equal(r.summary.studentLoanOutstanding, 0);
  });

  it('no repayment when income is below the plan threshold', () => {
    const r = run({ ...baseProfile, grossIncome: 20_000, studentLoanPlan: 'plan1' }, baseRates, {
      studentLoan: { balance: 10_000 },
    });
    // adjustedGross = 19,000 < plan1 threshold 26,065
    assert.equal(r.yearlyBreakdown[0].studentLoanRepayment, 0);
  });

  it('no student loan row when studentLoanPlan is null', () => {
    const r = run(baseProfile, baseRates, { studentLoan: { balance: 10_000 } });
    assert.equal(r.yearlyBreakdown[0].studentLoan, null);
  });
});

describe('NI qualifying years and state pension', () => {
  it('each working year above the LEL adds one NI qualifying year', () => {
    const r = run({ ...baseProfile, retirementAge: 33, niContributionYears: 5 });
    assert.equal(r.yearlyBreakdown[0].cumulativeNIYears, 6);
    assert.equal(r.yearlyBreakdown[1].cumulativeNIYears, 7);
    assert.equal(r.yearlyBreakdown[2].cumulativeNIYears, 8);
    assert.equal(r.summary.niYearsAccrued, 8);
  });

  it('state pension pro-rated: 11 qualifying years, triple-lock grown to statePensionAge', () => {
    // baseProfile: niContributionYears=10, 1 year → 11 NI years
    // triplelock = max(wageGrowth=0.03, inflation=0.03, 0.025) = 0.03
    // base = (11/35)*11973 = 3762.94; grown by 1.03^(67-30) = 2.9852 → 11233.23
    assertApprox(
      run().summary.projectedStatePension,
      11_233.23,
      'state pension 11 years triple-locked'
    );
  });

  it('state pension capped at full amount when ≥35 qualifying years, triple-lock grown', () => {
    const r = run({ ...baseProfile, niContributionYears: 34, retirementAge: 32 });
    // 34 + 2 years = 36 qualifying, capped at 35; 11973 * 1.03^37 → 35742.12
    assertApprox(r.summary.projectedStatePension, 35_742.12, 'full state pension triple-locked');
  });

  it('no state pension entitlement when fewer than 10 qualifying years', () => {
    const r = run({ ...baseProfile, niContributionYears: 8, retirementAge: 31 });
    // 8 + 1 = 9 qualifying years < 10 minimum
    assert.equal(r.summary.projectedStatePension, 0);
  });

  it('statePensionEligibleAtRetirement true only when retirementAge >= statePensionAge', () => {
    const early = run({ ...baseProfile, retirementAge: 60 });
    const late = run({ ...baseProfile, retirementAge: 68 });
    assert.equal(early.summary.statePensionEligibleAtRetirement, false);
    assert.equal(late.summary.statePensionEligibleAtRetirement, true);
  });

  it('custom statePensionAge is respected', () => {
    const r = run({ ...baseProfile, retirementAge: 65, statePensionAge: 65 });
    assert.equal(r.summary.statePensionEligibleAtRetirement, true);
    assert.equal(r.summary.statePensionAge, 65);
  });
});

describe('state pension deferral', () => {
  const retOpts = { targetNetAnnualExpenses: 10_000, maxAge: 72 };
  const spProfile = {
    ...baseProfile,
    currentAge: 60,
    retirementAge: 61,
    niContributionYears: 35,
    statePensionAge: 63,
  };

  it('no deferral: payments start at statePensionAge', () => {
    const r = projectLifecycle(spProfile, baseRates, {}, retOpts);
    const rows = r.yearlyBreakdown.filter((row) => row.phase === 'retirement');
    const at62 = rows.find((row) => row.age === 62);
    const at63 = rows.find((row) => row.age === 63);
    assert.equal(at62.statePensionGross, 0);
    assert.ok(at63.statePensionGross > 0);
  });

  it('deferral delays the start age', () => {
    const r = projectLifecycle(
      { ...spProfile, statePensionDeferralYears: 2 },
      baseRates,
      {},
      retOpts
    );
    const rows = r.yearlyBreakdown.filter((row) => row.phase === 'retirement');
    assert.equal(rows.find((row) => row.age === 64).statePensionGross, 0);
    assert.ok(rows.find((row) => row.age === 65).statePensionGross > 0);
  });

  it('each deferred year uplifts the amount by ~5.78% (linear)', () => {
    const base = projectLifecycle(spProfile, baseRates, {}, retOpts);
    const deferred = projectLifecycle(
      { ...spProfile, statePensionDeferralYears: 2 },
      baseRates,
      {},
      retOpts
    );
    const baseAt66 = base.yearlyBreakdown.find((row) => row.age === 66).statePensionGross;
    const defAt66 = deferred.yearlyBreakdown.find((row) => row.age === 66).statePensionGross;
    // Same year, same triple-lock growth — only the uplift differs
    const upliftObserved = defAt66 / baseAt66;
    assert.ok(
      Math.abs(upliftObserved - 1.1156) < 0.001,
      `expected ×1.1156 uplift, got ×${upliftObserved.toFixed(4)}`
    );
  });

  it('summary projectedStatePension reflects deferral start age and uplift', () => {
    const base = projectLifecycle(spProfile, baseRates, {}, retOpts);
    const deferred = projectLifecycle(
      { ...spProfile, statePensionDeferralYears: 2 },
      baseRates,
      {},
      retOpts
    );
    assert.equal(base.summary.statePensionStartAge, 63);
    assert.equal(deferred.summary.statePensionStartAge, 65);
    assert.ok(deferred.summary.projectedStatePension > base.summary.projectedStatePension);
  });
});

describe('tapered annual allowance for high earners', () => {
  it('annualAllowance is £60,000 for ordinary incomes', () => {
    const y = run().yearlyBreakdown[0];
    assert.equal(y.annualAllowance, 60_000);
    assert.equal(y.annualAllowanceBreached, false);
  });

  it('annualAllowance tapers for very high earners', () => {
    // £400k gross, 5% sacrifice → threshold income 380k, adjusted 412k
    // reduction = (412,000 − 260,000)/2 = 76,000 → floored at £10,000
    const r = run({ ...baseProfile, grossIncome: 400_000 });
    const y = r.yearlyBreakdown[0];
    assert.equal(y.annualAllowance, 10_000);
    // contributions = 8% of 400k = 32,000 > 10,000 → breach flagged
    assert.equal(y.annualAllowanceBreached, true);
  });
});

describe('windfalls', () => {
  const wfProfile = { ...baseProfile, retirementAge: 33 };

  it('throws for malformed windfall entries', () => {
    assert.throws(() => run({ ...wfProfile, windfalls: 'bad' }), TypeError);
    assert.throws(() => run({ ...wfProfile, windfalls: [{ age: 31.5, amount: 100 }] }), TypeError);
    assert.throws(() => run({ ...wfProfile, windfalls: [{ age: 31, amount: -5 }] }), TypeError);
    assert.throws(() => run({ ...wfProfile, windfalls: [null] }), TypeError);
  });

  it('windfall in year 1 is added at face value (no inflation yet)', () => {
    const r = run({ ...wfProfile, windfalls: [{ age: 30, amount: 10_000, label: 'Gift' }] });
    const y = r.yearlyBreakdown[0];
    assert.equal(y.windfall, 10_000);
    assert.deepEqual(y.windfallLabels, ['Gift']);
  });

  it("windfall in a later year is inflated from today's money", () => {
    const r = run({ ...wfProfile, windfalls: [{ age: 32, amount: 10_000 }] });
    const y = r.yearlyBreakdown.find((row) => row.age === 32);
    // cumulInflation at year index 2 = 1.03² = 1.0609 → 10,609
    assertApprox(y.windfall, 10_609, 'inflated windfall');
    assert.deepEqual(y.windfallLabels, ['Windfall']); // default label
  });

  it('windfall lands in the GIA and grows in the arrival year', () => {
    const base = run(wfProfile);
    const wf = run({ ...wfProfile, windfalls: [{ age: 30, amount: 10_000 }] });
    const giaBase = base.yearlyBreakdown[0].gia.closingBalance;
    const giaWf = wf.yearlyBreakdown[0].gia.closingBalance;
    // Extra £10,000 grown at 7% → +£10,700
    assertApprox(giaWf - giaBase, 10_700, 'GIA increase');
  });

  it('full windfall amount is added to the cost basis (no phantom gains)', () => {
    const base = run(wfProfile);
    const wf = run({ ...wfProfile, windfalls: [{ age: 30, amount: 10_000 }] });
    const cbBase = base.yearlyBreakdown[0].gia.closingCostBasis;
    const cbWf = wf.yearlyBreakdown[0].gia.closingCostBasis;
    assertApprox(cbWf - cbBase, 10_000, 'cost basis increase');
  });

  it('multiple windfalls in the same year sum, labels both reported', () => {
    const r = run({
      ...wfProfile,
      windfalls: [
        { age: 31, amount: 5_000, label: 'Car sale' },
        { age: 31, amount: 2_000, label: 'Gift' },
      ],
    });
    const y = r.yearlyBreakdown.find((row) => row.age === 31);
    assertApprox(y.windfall, 7_000 * 1.03, 'summed and inflated');
    assert.deepEqual(y.windfallLabels, ['Car sale', 'Gift']);
  });

  it('windfalls at ages outside the projection are ignored', () => {
    const r = run({ ...wfProfile, windfalls: [{ age: 99, amount: 50_000 }] });
    assert.ok(r.yearlyBreakdown.every((row) => (row.windfall ?? 0) === 0));
  });

  it('enabled: false skips an event; enabled: true and omitted both include it', () => {
    const off = run({
      ...wfProfile,
      windfalls: [{ age: 30, amount: 10_000, enabled: false }],
      oneOffExpenses: [{ age: 30, amount: 5_000, enabled: false }],
    });
    const y = off.yearlyBreakdown[0];
    assert.equal(y.windfall, 0);
    assert.equal(y.oneOffExpense, 0);
    assert.deepEqual(y.gia.closingBalance, run(wfProfile).yearlyBreakdown[0].gia.closingBalance);

    const onExplicit = run({
      ...wfProfile,
      windfalls: [{ age: 30, amount: 10_000, enabled: true }],
    });
    const onOmitted = run({ ...wfProfile, windfalls: [{ age: 30, amount: 10_000 }] });
    assert.equal(onExplicit.yearlyBreakdown[0].windfall, 10_000);
    assert.equal(onOmitted.yearlyBreakdown[0].windfall, 10_000);
  });

  it('retirement-phase windfall is applied and reported on the row', () => {
    const retOpts = { targetNetAnnualExpenses: 15_000, maxAge: 45 };
    const r = projectLifecycle(
      { ...wfProfile, windfalls: [{ age: 40, amount: 100_000, label: 'Inheritance' }] },
      baseRates,
      { isaBalance: 50_000 },
      retOpts
    );
    const y = r.yearlyBreakdown.find((row) => row.age === 40);
    assert.equal(y.phase, 'retirement');
    assert.ok(y.windfall > 100_000, 'inflated above face value');
    assert.deepEqual(y.windfallLabels, ['Inheritance']);
    assert.ok(y.gia.windfall === y.windfall);
  });

  it('a retirement windfall can rescue an otherwise-exhausted plan', () => {
    const retOpts = { targetNetAnnualExpenses: 20_000, maxAge: 50 };
    const pots = { isaBalance: 60_000 };
    const without = projectLifecycle(wfProfile, baseRates, pots, retOpts);
    const withWf = projectLifecycle(
      { ...wfProfile, windfalls: [{ age: 38, amount: 400_000 }] },
      baseRates,
      pots,
      retOpts
    );
    const shortfallYearsWithout = without.yearlyBreakdown.filter((r) => r.shortfall > 0).length;
    const shortfallYearsWith = withWf.yearlyBreakdown.filter((r) => r.shortfall > 0).length;
    assert.ok(shortfallYearsWithout > 0, 'baseline plan should fail');
    assert.ok(shortfallYearsWith < shortfallYearsWithout, 'windfall reduces shortfall years');
  });
});

describe('one-off expenses', () => {
  const expProfile = { ...baseProfile, retirementAge: 33 };

  it('throws for malformed expense entries', () => {
    assert.throws(() => run({ ...expProfile, oneOffExpenses: 'bad' }), TypeError);
    assert.throws(
      () => run({ ...expProfile, oneOffExpenses: [{ age: 31, amount: -5 }] }),
      TypeError
    );
  });

  it('funds from unallocated savings first — contributions shrink, pots untouched', () => {
    // Baseline year 1: availableForSavings = 30,879.60. Expense of £10,000
    // comes straight out of that cash before it reaches ISA/GIA.
    const r = run({
      ...expProfile,
      oneOffExpenses: [{ age: 30, amount: 10_000, label: 'Wedding' }],
    });
    const y = r.yearlyBreakdown[0];
    assert.equal(y.oneOffExpense, 10_000);
    assertApprox(y.oneOffExpenseFunding.fromSavings, 10_000, 'fromSavings');
    assert.equal(y.oneOffExpenseFunding.fromGIAGross, 0);
    assert.equal(y.oneOffExpenseFunding.fromISA, 0);
    assert.equal(y.expenseShortfall, 0);
    // Savings that reach the pots: 30,879.60 − 10,000 = 20,879.60
    assertApprox(y.isaContribution, 20_000, 'ISA still fills first');
    assertApprox(y.giaContribution, 879.6, 'GIA gets the remainder');
  });

  it('overflows to GIA then ISA when savings are insufficient', () => {
    // Expense of £80,000 in year 1: savings 30,879.60, GIA 20,000 (no gains),
    // ISA 40,000. Funding: 30,879.60 + 20,000 + 29,120.40 from ISA.
    const r = projectLifecycle(
      { ...expProfile, oneOffExpenses: [{ age: 30, amount: 80_000 }] },
      baseRates,
      { giaBalance: 20_000, giaCostBasis: 20_000, isaBalance: 40_000 }
    );
    const y = r.yearlyBreakdown[0];
    const f = y.oneOffExpenseFunding;
    assertApprox(f.fromSavings, 30_879.6, 'savings leg');
    assertApprox(f.fromGIAGross, 20_000, 'GIA leg (no gains → gross = net)');
    assert.equal(f.giaCGT, 0);
    assertApprox(f.fromISA, 29_120.4, 'ISA leg');
    assert.equal(f.shortfall, 0);
    assert.equal(y.isaContribution, 0);
    assert.equal(y.giaContribution, 0);
  });

  it('GIA leg realises gains and can incur CGT', () => {
    // GIA worth 100,000 with cost basis 20,000 → gain fraction 80%.
    // Expense 50,000, no savings available (huge living expenses).
    const r = projectLifecycle(
      {
        ...expProfile,
        annualLivingExpenses: 100_000,
        oneOffExpenses: [{ age: 30, amount: 50_000 }],
      },
      baseRates,
      { giaBalance: 100_000, giaCostBasis: 20_000 }
    );
    const y = r.yearlyBreakdown[0];
    const f = y.oneOffExpenseFunding;
    assert.equal(f.fromSavings, 0);
    assert.ok(f.giaCGT > 0, 'CGT charged on the gains');
    assertApprox(f.fromGIAGross - f.giaCGT, 50_000, 'net raised equals the expense');
    assert.equal(f.shortfall, 0);
  });

  it('reports a shortfall when pots cannot cover the expense — no debt is created', () => {
    const r = projectLifecycle(
      {
        ...expProfile,
        annualLivingExpenses: 100_000, // no savings capacity
        oneOffExpenses: [{ age: 30, amount: 500_000 }],
      },
      baseRates,
      { isaBalance: 10_000 }
    );
    const y = r.yearlyBreakdown[0];
    assert.ok(y.expenseShortfall > 0, 'shortfall reported');
    assertApprox(
      y.oneOffExpenseFunding.fromISA + y.expenseShortfall,
      500_000,
      'ISA drained, rest unfunded'
    );
    assert.equal(y.isa.closingBalance, 0);
  });

  it('a same-year windfall can fund a same-year expense', () => {
    // Windfall 200,000 and expense 150,000 at the same age: the windfall lands
    // in the GIA first, and the expense draws on it (no shortfall).
    const r = projectLifecycle(
      {
        ...expProfile,
        annualLivingExpenses: 100_000, // no savings capacity
        windfalls: [{ age: 31, amount: 200_000, label: 'Sale' }],
        oneOffExpenses: [{ age: 31, amount: 150_000, label: 'Deposit' }],
      },
      baseRates,
      {}
    );
    const y = r.yearlyBreakdown.find((row) => row.age === 31);
    assert.equal(y.expenseShortfall, 0);
    assert.ok(y.oneOffExpenseFunding.fromGIAGross > 0);
  });

  it("retirement-phase expense raises that year's drawdown", () => {
    const retOpts = { targetNetAnnualExpenses: 15_000, maxAge: 45 };
    const pots = { isaBalance: 400_000 };
    const base = projectLifecycle(expProfile, baseRates, pots, retOpts);
    const withExp = projectLifecycle(
      { ...expProfile, oneOffExpenses: [{ age: 40, amount: 50_000, label: 'Kids' }] },
      baseRates,
      pots,
      retOpts
    );
    const baseRow = base.yearlyBreakdown.find((row) => row.age === 40);
    const expRow = withExp.yearlyBreakdown.find((row) => row.age === 40);
    assert.equal(expRow.phase, 'retirement');
    assert.ok(expRow.oneOffExpense > 50_000, 'inflated above face value');
    assert.deepEqual(expRow.oneOffExpenseLabels, ['Kids']);
    // The extra need is met from pots: withdrawals rise by ~the expense
    assert.ok(
      expRow.isaWithdrawal + expRow.giaWithdrawal + expRow.pensionDrawdown >
        baseRow.isaWithdrawal + baseRow.giaWithdrawal + baseRow.pensionDrawdown + 40_000
    );
  });
});

describe('mortgage start age', () => {
  const mortgage = { balance: 200_000, termYears: 25 };
  const mProfile = { ...baseProfile, retirementAge: 40 };

  it('defaults to starting immediately (unchanged behaviour)', () => {
    const a = projectLifecycle(mProfile, baseRates, { mortgage });
    const b = projectLifecycle(mProfile, baseRates, {
      mortgage: { ...mortgage, startAge: 30 },
    });
    assert.deepEqual(a.yearlyBreakdown[0].mortgage, b.yearlyBreakdown[0].mortgage);
  });

  it('no payments and zero balance before the start age', () => {
    const r = projectLifecycle(mProfile, baseRates, {
      mortgage: { ...mortgage, startAge: 35 },
    });
    for (const row of r.yearlyBreakdown.filter((row) => row.age < 35)) {
      assert.equal(row.mortgagePayment, 0, `payment at ${row.age}`);
      assert.equal(row.mortgage.closingBalance, 0, `balance at ${row.age}`);
    }
  });

  it('starts at the given age with the balance inflated to that year', () => {
    const r = projectLifecycle(mProfile, baseRates, {
      mortgage: { ...mortgage, startAge: 35 },
    });
    const startRow = r.yearlyBreakdown.find((row) => row.age === 35);
    // cumulInflation at year index 5 = 1.03^5 = 1.159274…
    const expectedOpening = Math.round(200_000 * Math.pow(1.03, 5) * 100) / 100;
    assertApprox(startRow.mortgage.openingBalance, expectedOpening, 'inflated opening balance');
    assert.ok(startRow.mortgagePayment > 0, 'payments begin');
  });

  it('a start age in the past behaves as starting now', () => {
    const a = projectLifecycle(mProfile, baseRates, { mortgage });
    const b = projectLifecycle(mProfile, baseRates, {
      mortgage: { ...mortgage, startAge: 25 },
    });
    assert.deepEqual(a.yearlyBreakdown[0].mortgage, b.yearlyBreakdown[0].mortgage);
  });

  it('can start during retirement', () => {
    const retOpts = { targetNetAnnualExpenses: 10_000, maxAge: 50 };
    const r = projectLifecycle(
      mProfile,
      baseRates,
      {
        mortgage: { ...mortgage, startAge: 45 },
        isaBalance: 500_000,
      },
      retOpts
    );
    const preStart = r.yearlyBreakdown.find((row) => row.age === 44);
    const startRow = r.yearlyBreakdown.find((row) => row.age === 45);
    assert.equal(preStart.mortgagePayment, 0);
    assert.ok(startRow.mortgagePayment > 0);
  });

  it('throws for a non-integer startAge', () => {
    assert.throws(
      () => projectLifecycle(mProfile, baseRates, { mortgage: { ...mortgage, startAge: 35.5 } }),
      TypeError
    );
  });
});

describe('pension access age (NMPA)', () => {
  // Retire at 52 with a large pension but only a modest ISA bridge; NMPA default 57.
  const earlyProfile = { ...baseProfile, currentAge: 50, retirementAge: 52 };
  const bigPension = { pensionBalance: 500_000, isaBalance: 120_000, giaBalance: 0 };
  const retOpts = { targetNetAnnualExpenses: 25_000, maxAge: 70 };

  const rows = (r) => r.yearlyBreakdown.filter((x) => x.phase === 'retirement');

  it('throws for a non-integer pensionAccessAge', () => {
    assert.throws(() => run({ ...earlyProfile, pensionAccessAge: 57.5 }), TypeError);
  });

  it('does not touch the pension before the access age', () => {
    const r = projectLifecycle(earlyProfile, baseRates, bigPension, retOpts);
    for (const row of rows(r).filter((x) => x.age < 57)) {
      assert.equal(row.pensionAccessible, false, `age ${row.age} accessible`);
      assert.equal(row.pension.drawdown, 0, `age ${row.age} drew pension`);
    }
  });

  it('lets the locked pension keep growing during the bridge years', () => {
    const r = projectLifecycle(earlyProfile, baseRates, bigPension, retOpts);
    const at52 = rows(r).find((x) => x.age === 52).pension.closingBalance;
    const at56 = rows(r).find((x) => x.age === 56).pension.closingBalance;
    assert.ok(at56 > at52, `pension shrank during bridge: ${at52} → ${at56}`);
  });

  it('bridges spending from ISA/GIA before access, then draws pension from 57', () => {
    const r = projectLifecycle(earlyProfile, baseRates, bigPension, retOpts);
    // Bridge years are funded from the ISA (no pension), so the ISA falls.
    const isa52 = rows(r).find((x) => x.age === 52).isa.openingBalance;
    const isa56 = rows(r).find((x) => x.age === 56).isa.closingBalance;
    assert.ok(isa56 < isa52, 'ISA not drawn during bridge');
    // First accessible year draws the pension.
    const at57 = rows(r).find((x) => x.age === 57);
    assert.equal(at57.pensionAccessible, true);
    assert.ok(at57.pension.drawdown > 0, 'pension not drawn at access age');
  });

  it('defers PCLS to the access age when retiring early', () => {
    const r = projectLifecycle(earlyProfile, baseRates, bigPension, { ...retOpts, takePCLS: true });
    const before = rows(r).filter((x) => x.age < 57);
    assert.ok(
      before.every((x) => x.pclsLumpSum == null),
      'PCLS taken before access age'
    );
    const at57 = rows(r).find((x) => x.age === 57);
    assert.ok(at57.pclsLumpSum > 0, 'PCLS not taken at access age');
  });

  it('reports a shortfall when the bridge cannot cover pre-access spending', () => {
    // Tiny ISA, no GIA, pension locked → the early years cannot be funded.
    const r = projectLifecycle(
      earlyProfile,
      baseRates,
      { pensionBalance: 500_000, isaBalance: 5_000, giaBalance: 0 },
      { ...retOpts, targetNetAnnualExpenses: 30_000 }
    );
    const preAccess = rows(r).filter((x) => x.age < 57);
    assert.ok(
      preAccess.some((x) => x.shortfall > 0),
      'no shortfall despite locked pension'
    );
  });

  it('a custom access age is respected', () => {
    const r = projectLifecycle(
      { ...earlyProfile, pensionAccessAge: 55 },
      baseRates,
      bigPension,
      retOpts
    );
    assert.equal(rows(r).find((x) => x.age === 54).pensionAccessible, false);
    assert.equal(rows(r).find((x) => x.age === 55).pensionAccessible, true);
  });

  it('no effect when retirement age is already at/after the access age', () => {
    // Retire at 60 (≥ 57): pension accessible from year 1, PCLS taken immediately.
    const lateProfile = { ...baseProfile, currentAge: 58, retirementAge: 60 };
    const r = projectLifecycle(lateProfile, baseRates, bigPension, {
      targetNetAnnualExpenses: 25_000,
      maxAge: 75,
      takePCLS: true,
    });
    const first = rows(r)[0];
    assert.equal(first.age, 60);
    assert.equal(first.pensionAccessible, true);
    assert.ok(first.pclsLumpSum > 0, 'PCLS not taken in first retirement year');
  });
});

describe('employment-hours changes (part-time / phased retirement)', () => {
  // Multi-year fixture so a change mid-run is observable.
  const htProfile = { ...baseProfile, retirementAge: 35, niContributionYears: 5 };

  it('scales gross income to the fraction of the full-time-equivalent salary', () => {
    // No wage growth so the full-time track is a flat £40k → 60% = £24k.
    const flat = { ...baseRates, wageGrowthRate: 0 };
    const r = run({ ...htProfile, employmentChanges: [{ age: 32, fraction: 0.6 }] }, flat);
    const rows = r.yearlyBreakdown;
    assert.equal(rows[0].hoursFraction, 1);
    assert.equal(rows[0].grossIncome, 40_000);
    assert.equal(rows[0].fullTimeGrossIncome, 40_000);
    // Age 32 is the third row (30, 31, 32) — the change takes effect here.
    assert.equal(rows[2].age, 32);
    assert.equal(rows[2].hoursFraction, 0.6);
    assert.equal(rows[2].grossIncome, 24_000);
    assert.equal(rows[2].fullTimeGrossIncome, 40_000);
  });

  it('scales both employee and employer pension contributions pro-rata', () => {
    const flat = { ...baseRates, wageGrowthRate: 0 };
    const r = run({ ...htProfile, employmentChanges: [{ age: 31, fraction: 0.5 }] }, flat);
    const full = r.yearlyBreakdown[0];
    const half = r.yearlyBreakdown[1];
    // 5% employee / 3% employer of £40k, halved from age 31.
    assert.equal(full.employeeContribution, 2_000);
    assert.equal(full.employerContribution, 1_200);
    assert.equal(half.employeeContribution, 1_000);
    assert.equal(half.employerContribution, 600);
  });

  it('the full-time track keeps growing, so returning to 100% restores full pay', () => {
    const r = run({
      ...htProfile,
      employmentChanges: [
        { age: 31, fraction: 0.5 },
        { age: 33, fraction: 1 },
      ],
    });
    const rows = r.yearlyBreakdown;
    // Age 33 back at 100%: gross equals the full-time track for that year.
    const at33 = rows.find((row) => row.age === 33);
    assert.equal(at33.hoursFraction, 1);
    assert.equal(at33.grossIncome, at33.fullTimeGrossIncome);
    // And it exceeds the age-30 salary because wage growth kept compounding.
    assert.ok(at33.grossIncome > rows[0].grossIncome);
  });

  it('a year with pay below the NI Lower Earnings Limit does not count toward the state pension', () => {
    // 10% of £40k = £4,000, below the ~£6,396 LEL → no qualifying year.
    const flat = { ...baseRates, wageGrowthRate: 0 };
    const r = run({ ...htProfile, employmentChanges: [{ age: 31, fraction: 0.1 }] }, flat);
    const rows = r.yearlyBreakdown;
    assert.equal(rows[0].cumulativeNIYears, 6); // full-time year counts
    // Every subsequent year is below the LEL → the count never advances.
    assert.equal(rows[1].cumulativeNIYears, 6);
    assert.equal(rows[rows.length - 1].cumulativeNIYears, 6);
  });

  it('the most recent change at or before an age applies; 100% before the first', () => {
    const flat = { ...baseRates, wageGrowthRate: 0 };
    const r = run(
      {
        ...htProfile,
        employmentChanges: [
          { age: 33, fraction: 0.4 },
          { age: 31, fraction: 0.8 },
        ],
      },
      flat
    );
    const at = (age) => r.yearlyBreakdown.find((row) => row.age === age);
    assert.equal(at(30).hoursFraction, 1); // before the first change
    assert.equal(at(31).hoursFraction, 0.8);
    assert.equal(at(32).hoursFraction, 0.8); // holds until the next change
    assert.equal(at(33).hoursFraction, 0.4);
    assert.equal(at(34).hoursFraction, 0.4);
  });

  it('a disabled change is skipped', () => {
    const flat = { ...baseRates, wageGrowthRate: 0 };
    const r = run(
      { ...htProfile, employmentChanges: [{ age: 31, fraction: 0.5, enabled: false }] },
      flat
    );
    assert.equal(r.yearlyBreakdown[1].hoursFraction, 1);
    assert.equal(r.yearlyBreakdown[1].grossIncome, 40_000);
  });

  it('validates the employmentChanges array and its entries', () => {
    assert.throws(() => run({ ...htProfile, employmentChanges: 'nope' }), TypeError);
    assert.throws(() => run({ ...htProfile, employmentChanges: [{ fraction: 0.5 }] }), TypeError);
    assert.throws(
      () => run({ ...htProfile, employmentChanges: [{ age: 32.5, fraction: 0.5 }] }),
      TypeError
    );
    assert.throws(
      () => run({ ...htProfile, employmentChanges: [{ age: 32, fraction: 0 }] }),
      RangeError
    );
    assert.throws(
      () => run({ ...htProfile, employmentChanges: [{ age: 32, fraction: 1.5 }] }),
      RangeError
    );
    assert.doesNotThrow(() => run({ ...htProfile, employmentChanges: [{ age: 32, fraction: 1 }] }));
  });
});

describe('summary totals', () => {
  it('summary balances match final yearlyBreakdown row', () => {
    const r = run({ ...baseProfile, retirementAge: 35 });
    const last = r.yearlyBreakdown[r.yearlyBreakdown.length - 1];
    assertApprox(r.summary.pensionPot, last.pension.closingBalance, 'pension');
    assertApprox(r.summary.isaBalance, last.isa.closingBalance, 'ISA');
    assertApprox(r.summary.giaBalance, last.gia.closingBalance, 'GIA');
  });

  it('totalSavings = pension + ISA + GIA', () => {
    const s = run({ ...baseProfile, retirementAge: 35 }).summary;
    assertApprox(s.totalSavings, s.pensionPot + s.isaBalance + s.giaBalance, 'totalSavings');
  });

  it('netWorth = totalSavings − totalDebt', () => {
    const r = run(
      { ...baseProfile, retirementAge: 33 },
      { ...baseRates, debtRate: 0 },
      {
        mortgage: { balance: 50_000, termYears: 10 },
      }
    );
    assertApprox(r.summary.netWorth, r.summary.totalSavings - r.summary.totalDebt, 'netWorth');
  });

  it('retirementYear = currentYear + (retirementAge − currentAge)', () => {
    const r = run({ ...baseProfile, retirementAge: 65, currentYear: 2025 });
    assert.equal(r.retirementYear, 2060);
    assert.equal(r.summary.retirementYear, 2060);
  });
});

describe('return shape', () => {
  it('top-level fields are all present', () => {
    const r = run();
    for (const key of ['startYear', 'retirementYear', 'yearlyBreakdown', 'summary', 'taxYear']) {
      assert.ok(key in r, `missing: ${key}`);
    }
    assert.equal(r.taxYear, '2025/26');
  });

  it('each yearlyBreakdown row has all expected fields', () => {
    const row = run().yearlyBreakdown[0];
    for (const key of [
      'year',
      'age',
      'grossIncome',
      'employeeContribution',
      'employerContribution',
      'adjustedGrossIncome',
      'annualAllowanceBreached',
      'incomeTax',
      'employeeNI',
      'employerNI',
      'studentLoanRepayment',
      'netTakeHome',
      'mortgagePayment',
      'unsecuredDebtPayments',
      'availableForSavings',
      'isaContribution',
      'giaContribution',
      'pension',
      'isa',
      'gia',
      'mortgage',
      'unsecuredDebts',
      'studentLoan',
      'niQualifyingYear',
      'cumulativeNIYears',
    ]) {
      assert.ok(key in row, `missing row field: ${key}`);
    }
  });

  it('summary has all expected fields', () => {
    const s = run().summary;
    for (const key of [
      'retirementYear',
      'retirementAge',
      'pensionPot',
      'isaBalance',
      'giaBalance',
      'giaCostBasis',
      'giaUnrealisedGain',
      'mortgageOutstanding',
      'unsecuredDebtOutstanding',
      'studentLoanOutstanding',
      'totalSavings',
      'totalDebt',
      'netWorth',
      'niYearsAccrued',
      'projectedStatePension',
      'statePensionAge',
      'statePensionEligibleAtRetirement',
    ]) {
      assert.ok(key in s, `missing summary field: ${key}`);
    }
  });

  it('closing balance of year N feeds opening balance of year N+1', () => {
    const r = run({ ...baseProfile, retirementAge: 33 });
    const [y0, y1] = r.yearlyBreakdown;
    assertApprox(y1.pension.openingBalance, y0.pension.closingBalance, 'pension continuity');
    assertApprox(y1.isa.openingBalance, y0.isa.closingBalance, 'ISA continuity');
    assertApprox(y1.gia.openingBalance, y0.gia.closingBalance, 'GIA continuity');
  });

  it('all monetary summary fields are finite numbers', () => {
    const s = run({ ...baseProfile, retirementAge: 35 }).summary;
    for (const key of ['pensionPot', 'isaBalance', 'giaBalance', 'totalSavings', 'netWorth']) {
      assert.ok(typeof s[key] === 'number' && isFinite(s[key]), `non-finite: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Glide path (getRateForAge via retirementOptions)
// ---------------------------------------------------------------------------

describe('glide path', () => {
  // Helper: project 1 accumulation year then immediately retire (retirementAge = currentAge + 1)
  // with a very short post-retirement window so we can inspect investmentRate in each phase.
  const glideProfile = { ...baseProfile, currentAge: 50, retirementAge: 60 };
  const glideRates = {
    savingsRate: 0.08,
    retirementRate: 0.02,
    wageGrowthRate: 0,
    inflationRate: 0,
  };
  const glideOpts = { targetNetAnnualExpenses: 0, maxAge: 70 };

  it('uses savingsRate before taper window starts (age < retirementAge − glideStartYears)', () => {
    // glideStartYears=5 → taper starts at age 55; at age 50 we should have full savingsRate (0.08)
    const r = projectLifecycle(
      glideProfile,
      glideRates,
      {},
      {
        ...glideOpts,
        glideStartYears: 5,
        glideEndYears: 5,
      }
    );
    const y50 = r.yearlyBreakdown.find((y) => y.age === 50);
    assertApprox(y50.investmentRate, 0.08, 'rate at age 50 (before taper)');
  });

  it('uses retirementRate after taper window ends (age > retirementAge + glideEndYears)', () => {
    // glideEndYears=5 → taper ends at age 65; at age 65+ we should have full retirementRate (0.02)
    const r = projectLifecycle(
      glideProfile,
      glideRates,
      {},
      {
        ...glideOpts,
        glideStartYears: 5,
        glideEndYears: 5,
      }
    );
    const y65 = r.yearlyBreakdown.find((y) => y.age === 65);
    assertApprox(y65.investmentRate, 0.02, 'rate at age 65 (after taper)');
  });

  it('interpolates linearly at the midpoint of the taper window', () => {
    // taper: age 50→70 (glideStartYears=10, glideEndYears=10); midpoint = age 60 → t=0.5
    // expected rate = 0.08 + 0.5*(0.02-0.08) = 0.05
    const r = projectLifecycle(
      glideProfile,
      glideRates,
      {},
      {
        ...glideOpts,
        glideStartYears: 10,
        glideEndYears: 10,
      }
    );
    const y60 = r.yearlyBreakdown.find((y) => y.age === 60);
    assertApprox(y60.investmentRate, 0.05, 'rate at taper midpoint (age 60)');
  });

  it('glideStartYears=0 and glideEndYears=0 gives instant step at retirement', () => {
    // No taper: savingsRate before retirement, retirementRate at and after
    const r = projectLifecycle(
      glideProfile,
      glideRates,
      {},
      {
        ...glideOpts,
        glideStartYears: 0,
        glideEndYears: 0,
      }
    );
    const y59 = r.yearlyBreakdown.find((y) => y.age === 59);
    const y60 = r.yearlyBreakdown.find((y) => y.age === 60);
    assertApprox(y59.investmentRate, 0.08, 'full savingsRate one year before retirement');
    assertApprox(
      y60.investmentRate,
      0.02,
      'full retirementRate at retirement with zero-width taper'
    );
  });

  it('large glideStartYears (taper starts before currentAge) still works', () => {
    // glideStartYears=20 → taper starts at age 40, before currentAge=50
    // At age 50: t = (50-40)/(60+5-40) = 10/25 = 0.4 → rate = 0.08 + 0.4*(0.02-0.08) = 0.056
    const r = projectLifecycle(
      glideProfile,
      glideRates,
      {},
      {
        ...glideOpts,
        glideStartYears: 20,
        glideEndYears: 5,
      }
    );
    const y50 = r.yearlyBreakdown.find((y) => y.age === 50);
    assertApprox(y50.investmentRate, 0.056, 'rate at age 50 when taper already in progress');
  });
});

// ---------------------------------------------------------------------------
// Employer matching
// ---------------------------------------------------------------------------

describe('employer matching', () => {
  it('throws TypeError for a non-boolean employerMatch', () => {
    assert.throws(() => run({ ...baseProfile, employerMatch: 'yes' }), TypeError);
  });

  it('throws RangeError for an employerMatchThreshold above 1', () => {
    assert.throws(
      () => run({ ...baseProfile, employerMatch: true, employerMatchThreshold: 1.5 }),
      RangeError
    );
  });

  it('unconditional (default): employer pays its full rate regardless of the employee', () => {
    // employee 1%, employer 3% unconditional → employer still pays 3% of 40k = 1,200
    const y = run({ ...baseProfile, employeePensionRate: 0.01 }).yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 400, 'employeeContrib');
    assertApprox(y.employerContribution, 1_200, 'employerContrib (unconditional 3%)');
  });

  it('matched: employer pays its full rate when the employee meets the threshold', () => {
    // employee 5% ≥ 5% threshold → employer pays its full 3% = 1,200
    const y = run({
      ...baseProfile,
      employerMatch: true,
      employerMatchThreshold: 0.05,
    }).yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 2_000, 'employeeContrib (5%)');
    assertApprox(y.employerContribution, 1_200, 'employerContrib (full 3%)');
  });

  it('matched: employer pays nothing when the employee is below the threshold', () => {
    // employee 4% < 5% threshold → employer pays 0 (partial tiers not modelled)
    const y = run({
      ...baseProfile,
      employeePensionRate: 0.04,
      employerMatch: true,
      employerMatchThreshold: 0.05,
    }).yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 1_600, 'employeeContrib');
    assertApprox(y.employerContribution, 0, 'employerContrib (threshold not met)');
  });

  it('matched: models a tiered top rung (6% earns 12%)', () => {
    // employee 6% ≥ 6% threshold → employer pays 12% of 40,000 = 4,800
    const y = run({
      ...baseProfile,
      employeePensionRate: 0.06,
      employerPensionRate: 0.12,
      employerMatch: true,
      employerMatchThreshold: 0.06,
    }).yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 2_400, 'employeeContrib (6%)');
    assertApprox(y.employerContribution, 4_800, 'employerContrib (12%)');
  });

  it('matched: a zero employee contribution earns no employer contribution', () => {
    const y = run({
      ...baseProfile,
      employeePensionRate: 0,
      employerMatch: true,
      employerMatchThreshold: 0.05,
    }).yearlyBreakdown[0];
    assertApprox(y.employeeContribution, 0, 'employeeContrib');
    assertApprox(y.employerContribution, 0, 'employerContrib (no match without employee)');
  });
});

// ---------------------------------------------------------------------------
// Voluntary Class 3 state pension top-up
// ---------------------------------------------------------------------------

describe('voluntary Class 3 state pension top-up', () => {
  // Retire at 55 short of 35 years, with pots big enough to fund the bridge.
  // 15 initial NI years + 10 working years (45→55) = 25 accrued; 12 bridge years
  // (55→67), so up to 10 buyable → reaches the full 35.
  const topUpRetOpts = { targetNetAnnualExpenses: 20_000, maxAge: 90, takePCLS: true };
  const topUpProfile = {
    ...baseProfile,
    currentAge: 45,
    retirementAge: 55,
    niContributionYears: 15,
    statePensionAge: 67,
  };
  const topUpPots = { pensionBalance: 300_000, isaBalance: 150_000, giaBalance: 20_000 };
  const runTopUp = (over = {}, pots = topUpPots) =>
    projectLifecycle({ ...topUpProfile, ...over }, baseRates, pots, topUpRetOpts);

  it('throws TypeError for a non-boolean topUpStatePension', () => {
    assert.throws(() => runTopUp({ topUpStatePension: 'yes' }), TypeError);
  });

  it('off by default: no years bought, pension based on accrued years only', () => {
    const r = runTopUp();
    assert.equal(r.summary.class3YearsBought, 0);
    assert.equal(r.summary.class3TotalCost, 0);
    assert.equal(r.summary.niYearsAccrued, 25);
    assert.equal(r.summary.niYearsWithTopUp, 25);
  });

  it('on: buys the shortfall years up to 35 and raises the state pension', () => {
    const off = runTopUp({ topUpStatePension: false });
    const on = runTopUp({ topUpStatePension: true });
    assert.equal(on.summary.class3YearsBought, 10, 'buys 10 to reach 35');
    assert.equal(on.summary.niYearsWithTopUp, 35);
    assert.ok(on.summary.class3TotalCost > 0, 'cost is charged');
    assert.ok(
      on.summary.projectedStatePension > off.summary.projectedStatePension,
      'topped-up pension is higher'
    );
    // Full 35/35 vs accrued 25/35 → 40% higher (before rounding).
    assertApprox(
      on.summary.projectedStatePension / off.summary.projectedStatePension,
      35 / 25,
      'pension ratio'
    );
  });

  it('on: the cost is funded from the pots (bought years carry a contribution)', () => {
    const on = runTopUp({ topUpStatePension: true });
    const bought = on.yearlyBreakdown.filter((row) => row.class3YearBought);
    assert.equal(bought.length, 10);
    for (const row of bought) assert.ok(row.class3Contribution > 0);
    // Summary total equals the sum of yearly contributions.
    const summed = round2Test(
      on.yearlyBreakdown.reduce((s, row) => s + (row.class3Contribution || 0), 0)
    );
    assertApprox(summed, on.summary.class3TotalCost, 'summed contributions');
  });

  it('on: buys nothing when already at or above 35 years', () => {
    // 30 initial + 10 working = 40 accrued → no shortfall.
    const on = runTopUp({ topUpStatePension: true, niContributionYears: 30 });
    assert.equal(on.summary.class3YearsBought, 0);
    assert.equal(on.summary.class3TotalCost, 0);
  });

  it('on: buys nothing when the top-up cannot reach the 10-year minimum', () => {
    // Retire at 66 (SPA 67) with 6 accrued years and a 1-year bridge → can reach
    // at most 7 years, below the 10 needed for any pension, so buying is pointless.
    const on = projectLifecycle(
      {
        ...baseProfile,
        currentAge: 60,
        retirementAge: 66,
        niContributionYears: 0,
        statePensionAge: 67,
        topUpStatePension: true,
      },
      baseRates,
      { pensionBalance: 300_000, isaBalance: 100_000 },
      { targetNetAnnualExpenses: 10_000, maxAge: 90, takePCLS: true }
    );
    assert.equal(on.summary.class3YearsBought, 0);
  });

  it('handles a cash-starved bridge: buys only what it can afford, no negative pots', () => {
    // Short accumulation, small pots, high spend → the bridge runs dry.
    const on = projectLifecycle(
      {
        ...baseProfile,
        currentAge: 54,
        retirementAge: 55,
        grossIncome: 30_000,
        niContributionYears: 20,
        statePensionAge: 67,
        topUpStatePension: true,
      },
      baseRates,
      { pensionBalance: 30_000, isaBalance: 10_000 },
      { targetNetAnnualExpenses: 30_000, maxAge: 90, takePCLS: true }
    );
    // 15 short of 35 with a 12-year bridge → up to 12 buyable, but the pots can't
    // fund them all, so fewer are bought — never fabricated.
    assert.ok(on.summary.class3YearsBought < 12, 'buys fewer than the full shortfall');
    assert.ok(on.summary.class3YearsBought >= 0);
    const anyNegative = on.yearlyBreakdown.some(
      (row) =>
        row.pension.closingBalance < 0 || row.isa.closingBalance < 0 || row.gia.closingBalance < 0
    );
    assert.equal(anyNegative, false, 'no pot is driven negative');
    // The essential shortfall is real (the plan is under-funded).
    assert.ok(
      on.yearlyBreakdown.some((row) => row.phase === 'retirement' && row.shortfall > 0),
      'essential shortfall surfaces'
    );
  });
});

// Small local rounding helper mirroring the module's round2, for test sums.
function round2Test(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
