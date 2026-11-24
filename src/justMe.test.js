import assert from 'node:assert/strict';
import { justMeInputs } from './justMe.js';

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

// A couple's inputs, as the app holds them (only the fields that matter here).
const couple = {
  householdMode: 'couple',
  currentAge: 40,
  grossIncome: 60_000,
  annualLivingExpenses: 40_000,
  targetNetExpenses: 50_000,
  essentialExpenses: 30_000,
  mortgageBalance: 200_000,
  mortgageOverpayment: 100,
  mortgageTermYears: 20,
  unsecuredBalance: 10_000,
  unsecuredMonthly: 300,
  windfalls: [{ age: 50, amount: 20_000, label: 'Inheritance', enabled: true }],
  oneOffExpenses: [{ age: 45, amount: 8_000, label: 'Car', enabled: true }],
  annuityEnabled: true,
  annuityOwner: 'self',
  yourSharePct: 50,
  survivorSpendingPct: 72,
  partner: { currentAge: 38, grossIncome: 30_000 },
};

console.log('\nJust me view');

it('is a one-person plan, with your own pay', () => {
  const v = justMeInputs(couple);
  assert.equal(v.householdMode, 'single');
  assert.equal(v.grossIncome, 60_000);
  assert.equal(v.currentAge, 40);
});

it('takes your share of the mortgage, debts and one-off events', () => {
  const v = justMeInputs({ ...couple, yourSharePct: 60 });
  assert.equal(v.mortgageBalance, 120_000);
  assert.equal(v.mortgageOverpayment, 60);
  assert.equal(v.mortgageTermYears, 20);
  assert.equal(v.unsecuredBalance, 6_000);
  assert.equal(v.unsecuredMonthly, 180);
  assert.equal(v.windfalls[0].amount, 12_000);
  assert.equal(v.windfalls[0].label, 'Inheritance');
  assert.equal(v.oneOffExpenses[0].amount, 4_800);
});

it('costs living alone at the one-person rate', () => {
  const v = justMeInputs(couple);
  assert.equal(v.annualLivingExpenses, 28_800);
  assert.equal(v.targetNetExpenses, 36_000);
  assert.equal(v.essentialExpenses, 21_600);
});

it("drops an annuity bought from your partner's pension", () => {
  assert.equal(justMeInputs(couple).annuityEnabled, true);
  assert.equal(justMeInputs({ ...couple, annuityOwner: 'partner' }).annuityEnabled, false);
});

it("leaves the couple's inputs unchanged", () => {
  const before = JSON.stringify(couple);
  justMeInputs(couple);
  assert.equal(JSON.stringify(couple), before);
});

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exitCode = 1;
}
