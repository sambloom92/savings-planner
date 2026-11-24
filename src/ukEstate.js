/**
 * What happens to a person's money when they die, in couple mode ("what if
 * one of us dies?"): the inheritance tax on their estate and what passes to
 * the surviving partner, by partnership type.
 *
 *                              Married / civil partners   Living together
 *   Inheritance tax            none (spouse exemption)    40% above the £325k
 *                                                         nil-rate band
 *   ISA                        stays an ISA (the          arrives as cash
 *                              survivor's extra ISA        (invested in the GIA)
 *                              allowance, the "APS")
 *   GIA                        passes at market value — death resets the
 *                              base cost, so there is no CGT on past gains
 *   DC pension                 passes to the nominated beneficiary (assumed
 *                              to be the partner): tax-free withdrawals if the
 *                              holder died before 75, taxed as the survivor's
 *                              income at 75 or over
 *   DB pension                 the scheme's survivor's pension, if it pays one
 *                              to this kind of partner
 *   No wills (living together) the partner gets only the pension(s); savings
 *                              go to the deceased's relatives
 *
 * The estate here is savings and pensions only — the home is left out. From
 * 6 April 2027 unused pension funds count towards the estate (Finance Act
 * 2026); DB survivor's pensions don't. The nil-rate band is held at its
 * frozen £325,000 (frozen since 2009, legislated to April 2031).
 *
 * Life cover and death-in-service lump sums (`cover`): a policy written in
 * trust, or a pension scheme's death-in-service benefit, is paid straight to
 * the survivor, outside the estate. A policy not in trust is paid into the
 * estate as cash — so for a cohabiting couple it counts towards inheritance
 * tax and, without wills, goes to relatives.
 *
 * Each death produces an estate snapshot recording what the person held and
 * where it went. Inheritance for heirs after the second death is not modelled
 * yet; the snapshot records the unused nil-rate band so it can be added.
 *
 * Sources: gov.uk/inheritance-tax; gov.uk/tax-on-pension-death-benefits;
 * gov.uk/individual-savings-accounts/inheriting-an-isa-from-your-spouse-or-civil-partner;
 * HMRC, "Inheritance Tax on unused pension funds and death benefits" (2025).
 */

import { round2, inheritedPensionBalance } from './ukLifecyclePerson.js';

export const IHT_CONSTANTS = {
  nilRateBand: 325_000,
  rate: 0.4,
  // First tax year (2027/28) in which unused pension funds join the estate.
  pensionsInEstateFromYear: 2027,
  // Pension death benefits are tax-free if the holder dies before this age.
  pensionTaxFreeBeforeAge: 75,
};

export const PARTNERSHIPS = ['married', 'cohabiting'];

/** Inheritance tax on an estate of `estate` (£), above the nil-rate band. */
export function inheritanceTax(estate, nilRateBand = IHT_CONSTANTS.nilRateBand) {
  return round2(IHT_CONSTANTS.rate * Math.max(0, estate - nilRateBand));
}

/**
 * Settle a death. `D` dies at `age` in projection `year`; `S` is the surviving
 * partner, aged `survivorAge`. Passes assets to the survivor by the
 * partnership rules, sets up any DB survivor's pensions, closes the deceased's
 * pots, and returns the estate snapshot.
 *
 * @param {object} D, S - people (ukLifecyclePerson.js)
 * @param {{ age: number, survivorAge: number, year: number,
 *           partnership: 'married'|'cohabiting', willsToEachOther: boolean,
 *           econ: { cumulInflation: number },
 *           cover?: Array<{ amount: number, inTrust: boolean, payTo: string,
 *                           kind: string, label?: string }> }} ctx
 *   cover: lump sums paid on this death (life cover, death-in-service). What
 *   reaches the survivor is returned in `coverPaid` for the household to apply
 *   (to the mortgage or savings).
 */
export function settleDeath(
  D,
  S,
  { age, survivorAge, year, partnership, willsToEachOther, econ, cover = [] }
) {
  const married = partnership === 'married';
  const assets = {
    isa: D.isa,
    gia: D.gia,
    pension: round2(D.pension + inheritedPensionBalance(D)),
  };
  const pensionsInEstate = year >= IHT_CONSTANTS.pensionsInEstateFromYear;
  // Cover not written in trust is paid into the estate as cash.
  const coverInEstate = round2(cover.reduce((t, c) => t + (c.inTrust ? 0 : c.amount), 0));
  const estateForIHT = round2(
    assets.isa + assets.gia + (pensionsInEstate ? assets.pension : 0) + coverInEstate
  );

  // Married couples and civil partners pay nothing on what passes between them.
  const iht = married ? 0 : inheritanceTax(estateForIHT);
  // The tax is shared across the estate's assets in proportion to their value.
  const keep = estateForIHT > 0 ? 1 - iht / estateForIHT : 1;
  const afterTax = {
    isa: round2(assets.isa * keep),
    gia: round2(assets.gia * keep),
    pension: round2(assets.pension * (pensionsInEstate ? keep : 1)),
  };

  // ── To the survivor ──────────────────────────────────────────────────────
  const toSurvivor = { isa: 0, gia: 0, pension: afterTax.pension };
  const toOthers = { isa: 0, gia: 0 };
  // The pension goes to the nominated beneficiary — the partner — under
  // either partnership type. Tax-free to draw if the holder died before 75.
  const pensionTaxFree = age < IHT_CONSTANTS.pensionTaxFreeBeforeAge;
  if (afterTax.pension > 0) {
    S.inherited ??= { taxFree: 0, taxable: 0 };
    if (pensionTaxFree) S.inherited.taxFree = round2(S.inherited.taxFree + afterTax.pension);
    else S.inherited.taxable = round2(S.inherited.taxable + afterTax.pension);
  }
  if (married) {
    // The survivor's extra ISA allowance keeps the inherited ISA tax-free.
    toSurvivor.isa = afterTax.isa;
    S.isa = round2(S.isa + afterTax.isa);
  } else if (willsToEachOther) {
    // Leaves the ISA wrapper: invested in the survivor's GIA at its value.
    toSurvivor.gia = afterTax.isa;
  } else {
    toOthers.isa = afterTax.isa;
  }
  if (married || willsToEachOther) {
    // Inherited at market value: the base cost resets, so past gains are untaxed.
    toSurvivor.gia = round2(toSurvivor.gia + afterTax.gia);
  } else {
    toOthers.gia = afterTax.gia;
  }
  if (toSurvivor.gia > 0) {
    S.gia = round2(S.gia + toSurvivor.gia);
    S.costBasis = round2(S.costBasis + toSurvivor.gia);
  }

  // ── Life cover and death-in-service ──────────────────────────────────────
  // In trust: straight to the survivor, in full. In the estate: after its
  // share of the tax, to the survivor by the same rules as savings.
  const coverPaid = [];
  let coverToOthers = 0;
  for (const c of cover) {
    if (c.inTrust) {
      coverPaid.push({ kind: c.kind, label: c.label ?? '', amount: c.amount, payTo: c.payTo });
      continue;
    }
    const net = round2(c.amount * keep);
    if (married || willsToEachOther)
      coverPaid.push({ kind: c.kind, label: c.label ?? '', amount: net, payTo: c.payTo });
    else coverToOthers = round2(coverToOthers + net);
  }

  // ── DB survivor's pensions ───────────────────────────────────────────────
  // A share of the member's pension — in payment, or built up so far — paid
  // for life from now, rising like the member's pension would have.
  let survivorDbPension = 0;
  for (const st of D.dbStates) {
    const s = st.scheme;
    if (s.survivorPensionShare <= 0) continue;
    if (!married && !s.survivorPensionForUnmarriedPartner) continue;
    const pension = round2(st.pension * s.survivorPensionShare);
    if (pension <= 0) continue;
    survivorDbPension = round2(survivorDbPension + pension);
    S.dbStates.push({
      scheme: {
        ...s,
        label: `${s.label || 'DB pension'} (survivor's pension)`,
        status: 'inPayment',
        lumpSum: 'none',
        automaticLumpSum: 0,
        survivorPensionShare: 0,
      },
      pension,
      automaticLumpSum: 0,
      active: false,
      inPayment: true,
      startAge: survivorAge,
      pensionAtStart: pension,
      cumulInflationAtStart: econ.cumulInflation,
      lumpSum: 0,
      survivorOf: s.label,
    });
  }

  // ── Close the deceased's affairs ─────────────────────────────────────────
  // Single-life annuities and the state pension stop; a student loan is
  // written off; nothing more is built up.
  D.diedAt = age;
  D.pension = 0;
  D.isa = 0;
  D.gia = 0;
  D.costBasis = 0;
  D.inherited = null;
  if (D.studentLoan) D.studentLoan.balance = 0;
  for (const st of D.dbStates) st.active = false;

  return {
    person: D.id,
    age,
    year,
    partnership,
    willsToEachOther: married ? null : willsToEachOther,
    assets,
    pensionsInEstate,
    estateForIHT,
    nilRateBand: IHT_CONSTANTS.nilRateBand,
    inheritanceTax: iht,
    toSurvivor,
    toOthers,
    inheritedPensionTaxFree: pensionTaxFree,
    survivorDbPension,
    // For a later heirs feature: a spouse's unused nil-rate band passes to the
    // survivor's estate (a cohabitant's does not).
    unusedNilRateBandTransferable: married,
    // Lump sums paid on the death and where they went (the household fills in
    // how much went to the mortgage and to savings).
    lifeCover: {
      paid: round2(cover.reduce((t, c) => t + c.amount, 0)),
      inEstate: coverInEstate,
      toSurvivor: round2(coverPaid.reduce((t, c) => t + c.amount, 0)),
      toOthers: coverToOthers,
      toMortgage: 0,
      toSavings: 0,
    },
    coverPaid,
  };
}
