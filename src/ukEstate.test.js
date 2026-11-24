import assert from 'node:assert/strict';
import { IHT_CONSTANTS, PARTNERSHIPS, inheritanceTax, settleDeath } from './ukEstate.js';
import { createPerson } from './ukLifecyclePerson.js';

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

const person = (id, pots = {}, extra = {}) => {
  const P = createPerson(
    {
      currentAge: 70,
      retirementAge: 71,
      grossIncome: 0,
      employeePensionRate: 0,
      employerPensionRate: 0,
      niContributionYears: 35,
      ...extra,
    },
    pots,
    null,
    2026
  );
  P.id = id;
  return P;
};
const econ = { cumulInflation: 1 };
const settle = (D, S, ctx) =>
  settleDeath(D, S, {
    age: 72,
    survivorAge: 72,
    year: 2030,
    partnership: 'married',
    willsToEachOther: true,
    econ,
    ...ctx,
  });

// ---------------------------------------------------------------------------

describe('rules', () => {
  it('40% above the frozen £325,000 nil-rate band', () => {
    assert.equal(IHT_CONSTANTS.nilRateBand, 325_000);
    assert.equal(inheritanceTax(300_000), 0);
    assert.equal(inheritanceTax(425_000), 40_000);
  });

  it('knows the two partnership types', () => {
    assert.deepEqual(PARTNERSHIPS, ['married', 'cohabiting']);
  });
});

describe('settleDeath — married or civil partners', () => {
  it('passes everything free of inheritance tax, the ISA as an ISA', () => {
    const D = person('partner', {
      pensionBalance: 400_000,
      isaBalance: 200_000,
      giaBalance: 100_000,
      giaCostBasis: 40_000,
    });
    const S = person('self', { isaBalance: 10_000 });
    const e = settle(D, S);
    assert.equal(e.inheritanceTax, 0);
    assert.equal(S.isa, 210_000);
    assert.equal(S.gia, 100_000);
    assert.equal(S.costBasis, 100_000); // base cost resets at death
    assert.deepEqual(S.inherited, { taxFree: 400_000, taxable: 0 });
    assert.equal(e.unusedNilRateBandTransferable, true);
    // The deceased's pots are closed.
    assert.equal(D.pension + D.isa + D.gia, 0);
    assert.equal(D.diedAt, 72);
  });

  it('a pension from someone 75 or over is taxable to draw', () => {
    const D = person('partner', { pensionBalance: 100_000 });
    const S = person('self');
    const e = settle(D, S, { age: 78 });
    assert.equal(e.inheritedPensionTaxFree, false);
    assert.deepEqual(S.inherited, { taxFree: 0, taxable: 100_000 });
  });
});

describe('settleDeath — living together', () => {
  it('charges inheritance tax on savings and pensions, shared across them', () => {
    // £100k ISA + £200k GIA + £300k pension = £600k → tax 40% × £275k = £110k.
    const D = person('partner', {
      pensionBalance: 300_000,
      isaBalance: 100_000,
      giaBalance: 200_000,
    });
    const S = person('self');
    const e = settle(D, S, { partnership: 'cohabiting' });
    assert.equal(e.estateForIHT, 600_000);
    assert.equal(e.inheritanceTax, 110_000);
    const keep = 1 - 110_000 / 600_000;
    // The ISA leaves its wrapper: it arrives in the GIA.
    assert.equal(e.toSurvivor.isa, 0);
    assert.ok(Math.abs(S.gia - 300_000 * keep) < 0.02);
    assert.ok(Math.abs(S.inherited.taxFree - 300_000 * keep) < 0.02);
    assert.equal(e.unusedNilRateBandTransferable, false);
  });

  it('pensions stay outside the estate before April 2027', () => {
    const D = person('partner', { pensionBalance: 1_000_000, isaBalance: 100_000 });
    const S = person('self');
    const e = settle(D, S, { partnership: 'cohabiting', year: 2026 });
    assert.equal(e.pensionsInEstate, false);
    assert.equal(e.estateForIHT, 100_000);
    assert.equal(e.inheritanceTax, 0);
    assert.equal(S.inherited.taxFree, 1_000_000);
  });

  it('without wills, savings go to relatives and only the pension to the partner', () => {
    const D = person('partner', { pensionBalance: 50_000, isaBalance: 40_000, giaBalance: 20_000 });
    const S = person('self');
    const e = settle(D, S, { partnership: 'cohabiting', willsToEachOther: false });
    assert.deepEqual(e.toOthers, { isa: 40_000, gia: 20_000 });
    assert.equal(S.isa + S.gia, 0);
    assert.equal(S.inherited.taxFree, 50_000);
  });
});

describe('settleDeath — DB survivor pensions', () => {
  const db = (extra) => [{ label: 'Teachers', status: 'inPayment', pension: 24_000, ...extra }];

  it('pays the survivor their share for life, in payment from the death', () => {
    const D = person('partner', {}, { dbPensions: db({ survivorPensionShare: 0.375 }) });
    const S = person('self');
    const e = settle(D, S);
    assert.equal(e.survivorDbPension, 9_000);
    const added = S.dbStates.at(-1);
    assert.equal(added.inPayment, true);
    assert.equal(added.pension, 9_000);
    assert.equal(added.startAge, 72);
    assert.match(added.scheme.label, /survivor's pension/);
  });

  it("isn't paid to an unmarried partner where the scheme excludes them", () => {
    const D = person(
      'partner',
      {},
      { dbPensions: db({ survivorPensionForUnmarriedPartner: false }) }
    );
    const S = person('self');
    assert.equal(settle(D, S, { partnership: 'cohabiting' }).survivorDbPension, 0);
    assert.equal(S.dbStates.length, 0);
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
