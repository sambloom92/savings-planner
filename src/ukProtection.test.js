import assert from 'node:assert/strict';
import { solveCoverGap } from './ukProtection.js';
import { projectLifecycle } from './ukLifecycle.js';

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

// A couple in their 40s: you earn, your partner doesn't; flat economy.
const flat = { savingsRate: 0, wageGrowthRate: 0, inflationRate: 0, mortgageRate: 0.05 };
const you = {
  currentAge: 40,
  retirementAge: 65,
  currentYear: 2026,
  grossIncome: 60_000,
  employeePensionRate: 0.05,
  employerPensionRate: 0.05,
  niContributionYears: 18,
  annualLivingExpenses: 25_000,
};
const partner = {
  currentAge: 40,
  retirementAge: 65,
  grossIncome: 0,
  employeePensionRate: 0,
  employerPensionRate: 0,
  niContributionYears: 18,
};
const pots = { mortgage: { balance: 200_000, termYears: 20 } };
const ret = { targetNetAnnualExpenses: 25_000, maxAge: 85 };
const youDie = (extra = {}) => ({
  ...you,
  partner,
  death: { person: 'self', age: 45 },
  ...extra,
});
const policy = (extra) => ({
  type: 'level',
  lifeOf: 'self',
  sumAssured: 300_000,
  termYears: 25,
  monthlyPremium: 30,
  inTrust: true,
  payTo: 'savings',
  ...extra,
});
const firstDeathRow = (r) => r.yearlyBreakdown.find((row) => row.age === 45);

// ---------------------------------------------------------------------------

describe('premiums', () => {
  it('are a household cost while the policy runs, and stop at its end', () => {
    const r = projectLifecycle(
      { ...you, partner, lifePolicies: [policy({ termYears: 2 })] },
      flat,
      pots,
      ret
    );
    assert.equal(r.yearlyBreakdown[0].lifeCoverPremiums, 360);
    assert.equal(r.yearlyBreakdown[2].lifeCoverPremiums, 0);
    const without = projectLifecycle({ ...you, partner }, flat, pots, ret);
    assert.equal(without.yearlyBreakdown[0].saved - r.yearlyBreakdown[0].saved, 360);
  });

  it('need a partner', () => {
    assert.throws(
      () => projectLifecycle({ ...you, lifePolicies: [policy()] }, flat, pots, ret),
      RangeError
    );
  });

  it('rejects a bad policy', () => {
    assert.throws(
      () =>
        projectLifecycle(
          { ...you, partner, lifePolicies: [policy({ type: 'x' })] },
          flat,
          pots,
          ret
        ),
      RangeError
    );
    assert.throws(
      () =>
        projectLifecycle(
          { ...you, partner, lifePolicies: [policy({ termYears: 0 })] },
          flat,
          pots,
          ret
        ),
      TypeError
    );
  });
});

describe('payouts on a death', () => {
  it('a level policy in trust pays the survivor in full', () => {
    const r = projectLifecycle(youDie({ lifePolicies: [policy()] }), flat, pots, ret);
    const { lifeCover } = r.summary.estates[0];
    assert.equal(lifeCover.paid, 300_000);
    assert.equal(lifeCover.toSavings, 300_000);
    assert.equal(lifeCover.inEstate, 0);
  });

  it('a decreasing policy pays less as its term runs down', () => {
    // Death in year 5 of a 20-year term: 75% of the sum assured.
    const r = projectLifecycle(
      youDie({ lifePolicies: [policy({ type: 'decreasing', termYears: 20 })] }),
      flat,
      pots,
      ret
    );
    assert.equal(r.summary.estates[0].lifeCover.paid, 225_000);
  });

  it('cover paid to the mortgage clears it', () => {
    const r = projectLifecycle(
      youDie({ lifePolicies: [policy({ payTo: 'mortgage' })] }),
      flat,
      pots,
      ret
    );
    const { lifeCover } = r.summary.estates[0];
    assert.ok(lifeCover.toMortgage > 100_000 && lifeCover.toMortgage < 200_000);
    assert.equal(lifeCover.toSavings, 300_000 - lifeCover.toMortgage);
    const row = firstDeathRow(r);
    assert.equal(row.mortgagePayment, 0);
  });

  it('a policy only pays on the death of the life it covers', () => {
    const r = projectLifecycle(
      youDie({ lifePolicies: [policy({ lifeOf: 'partner' })] }),
      flat,
      pots,
      ret
    );
    assert.equal(r.summary.estates[0].lifeCover.paid, 0);
    // ...and its premiums carry on for the surviving partner's own cover.
    assert.equal(firstDeathRow(r).lifeCoverPremiums, 360);
  });

  it('a joint policy pays on the first death and then ends', () => {
    const r = projectLifecycle(
      youDie({ lifePolicies: [policy({ lifeOf: 'joint' })] }),
      flat,
      pots,
      ret
    );
    assert.equal(r.summary.estates[0].lifeCover.paid, 300_000);
    assert.equal(firstDeathRow(r).lifeCoverPremiums, undefined);
  });

  it('not in trust: cover joins the estate — taxed for a cohabiting couple', () => {
    const r = projectLifecycle(
      youDie({
        partnership: 'cohabiting',
        lifePolicies: [policy({ inTrust: false, sumAssured: 500_000 })],
      }),
      flat,
      pots,
      ret
    );
    const e = r.summary.estates[0];
    assert.equal(e.lifeCover.inEstate, 500_000);
    assert.ok(e.inheritanceTax > 0);
    assert.ok(e.lifeCover.toSurvivor < 500_000);
  });

  it('death-in-service pays a multiple of salary if the person dies while working', () => {
    const r = projectLifecycle(youDie({ deathInServiceMultiple: 4 }), flat, pots, ret);
    const e = r.summary.estates[0];
    assert.equal(e.lifeCover.paid, 240_000);
    assert.equal(e.lifeCover.inEstate, 0);
  });

  it('no death-in-service once retired', () => {
    const r = projectLifecycle(
      { ...youDie({ deathInServiceMultiple: 4 }), death: { person: 'self', age: 70 } },
      flat,
      pots,
      ret
    );
    assert.equal(r.summary.estates[0].lifeCover.paid, 0);
  });
});

describe('cover gap', () => {
  it('finds the extra cover that keeps the survivor solvent', () => {
    const profile = youDie();
    const { gap, fundedWithoutExtra } = solveCoverGap(profile, flat, pots, ret);
    assert.equal(fundedWithoutExtra, false);
    assert.ok(gap > 0 && gap % 1000 === 0, `gap ${gap}`);
    const short = (extraCover) =>
      projectLifecycle(
        { ...profile, death: { ...profile.death, extraCover } },
        flat,
        pots,
        ret
      ).yearlyBreakdown.some(
        (row) => row.shortfall > 0 && row.people?.some((q) => q.status === 'died')
      );
    assert.equal(short(gap), false);
    assert.equal(short(gap - 2_000), true);
  });

  it('is zero when existing cover already funds the survivor', () => {
    const profile = youDie({ lifePolicies: [policy({ sumAssured: 5_000_000 })] });
    assert.deepEqual(solveCoverGap(profile, flat, pots, ret), {
      gap: 0,
      fundedWithoutExtra: true,
      exceedsMax: false,
    });
  });

  it('existing cover shrinks the gap', () => {
    const without = solveCoverGap(youDie(), flat, pots, ret).gap;
    const withSome = solveCoverGap(
      youDie({ lifePolicies: [policy({ sumAssured: 100_000 })] }),
      flat,
      pots,
      ret
    ).gap;
    assert.ok(withSome < without, `${withSome} vs ${without}`);
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
