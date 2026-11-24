#!/usr/bin/env node
/**
 * Compare the projection engine in the working tree against a git ref.
 *
 * Runs a few hundred seeded random scenarios — covering every engine feature —
 * through both versions of projectLifecycle (and a handful through
 * runMonteCarlo) and requires the outputs to be identical. Use it to prove a
 * refactor changes no numbers:
 *
 *   node scripts/compare-engine.mjs                 # against origin/main
 *   node scripts/compare-engine.mjs HEAD~1 --count 1000
 *
 * Exits 1 and prints the first difference (scenario, path, both values) if any
 * output differs, including thrown validation errors.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const countFlag = args.indexOf('--count');
const COUNT = countFlag >= 0 ? Number(args[countFlag + 1]) : 400;
const ref = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--count') ?? 'origin/main';

const root = resolve(new URL('..', import.meta.url).pathname);
const baseDir = mkdtempSync(join(tmpdir(), 'engine-base-'));
execSync(`git archive ${ref} src | tar -x -C ${baseDir}`, { cwd: root, stdio: 'inherit' });

const load = (dir) =>
  Promise.all([
    import(pathToFileURL(join(dir, 'src/ukLifecycle.js'))),
    import(pathToFileURL(join(dir, 'src/ukMonteCarlo.js'))),
  ]);
const [[baseLife, baseMc], [headLife, headMc]] = await Promise.all([load(baseDir), load(root)]);

// ── Seeded random scenarios ─────────────────────────────────────────────────
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function scenario(seed) {
  const r = prng(seed * 2654435761);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const num = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 10_000) / 10_000;
  const chance = (p) => r() < p;

  const currentAge = int(22, 62);
  const retirementAge = Math.min(currentAge + int(1, 30), 75);
  const maxAge = Math.max(retirementAge + 1, int(85, 100));
  const events = (n, amount) =>
    Array.from({ length: n }, (_, k) => ({
      age: int(currentAge, maxAge),
      amount: num(0, amount),
      label: `event ${k}`,
      enabled: chance(0.85),
    }));

  const dbPensions = Array.from({ length: chance(0.35) ? int(1, 2) : 0 }, (_, k) => {
    const status = pick(['active', 'active', 'deferred', 'inPayment']);
    const scheme = {
      label: `scheme ${k}`,
      status,
      pension: num(0, 30_000),
      accrualRate: 1 / pick([49, 54, 57, 60, 80]),
      memberContributionRate: num(0, 0.12),
      inServiceRevaluation: chance(0.8)
        ? { basis: 'cpi', margin: pick([0, 0.015, 0.016]) }
        : { basis: 'earnings' },
      normalPensionAge: pick([60, 65, 67, 68]),
      earlyReductionPerYear: num(0, 0.08),
      lateIncreasePerYear: num(0, 0.08),
      deferredIncreaseCap: pick([null, 0.05, 0.025, 0]),
      paymentIncreaseCap: pick([null, 0.05, 0.025, 0]),
      lumpSum: pick(['none', 'max']),
      commutationFactor: pick([12, 12, 20]),
      automaticLumpSum: chance(0.3) ? num(0, 60_000) : 0,
    };
    if (status !== 'inPayment') scheme.paymentAge = Math.min(80, int(Math.max(55, currentAge), 72));
    return scheme;
  });

  const profile = {
    currentAge,
    retirementAge,
    currentYear: 2026,
    grossIncome: pick([0, num(15_000, 60_000), num(60_000, 130_000), num(130_000, 320_000)]),
    annualLivingExpenses: num(0, 45_000),
    employeePensionRate: chance(0.1) ? 0 : num(0, 0.4),
    employerPensionRate: num(0, 0.15),
    employerMatch: chance(0.3),
    employerMatchThreshold: num(0, 0.1),
    niContributionYears: int(0, 40),
    statePensionAge: pick([66, 67, 68]),
    statePensionDeferralYears: chance(0.25) ? int(1, 4) : 0,
    topUpStatePension: chance(0.4),
    pensionAccessAge: pick([55, 57, 58]),
    dbPensions,
    studentLoanPlan: pick([null, null, 'plan1', 'plan2', 'plan4', 'plan5', 'postgrad']),
    windfalls: events(int(0, 2), 300_000),
    oneOffExpenses: events(int(0, 2), 120_000),
    employmentChanges: Array.from({ length: int(0, 2) }, () => ({
      age: int(currentAge, retirementAge + 3),
      fraction: num(0.1, 1),
      enabled: chance(0.85),
    })),
  };

  const savingsRate = num(0.01, 0.09);
  const rates = {
    savingsRate,
    retirementRate: chance(0.7) ? num(0.01, savingsRate) : savingsRate,
    wageGrowthRate: num(-0.01, 0.05),
    inflationRate: num(0, 0.05),
    boeRate: num(0.005, 0.06),
    mortgageRate: num(0.01, 0.07),
    unsecuredRate: num(0.03, 0.25),
    fiscalDragRate: chance(0.4) ? num(0, 0.015) : 0,
  };

  const gia = num(0, 200_000);
  const debtRate = rates.unsecuredRate / 12;
  const pots = {
    pensionBalance: num(0, 600_000),
    isaBalance: num(0, 250_000),
    giaBalance: gia,
    giaCostBasis: chance(0.7) ? num(0, gia) : undefined,
    mortgage: chance(0.5)
      ? {
          balance: num(20_000, 500_000),
          termYears: int(5, 35),
          type: pick(['repayment', 'repayment', 'interest-only']),
          monthlyOverpayment: chance(0.3) ? num(0, 600) : 0,
          startAge: chance(0.3) ? int(currentAge, currentAge + 10) : undefined,
        }
      : null,
    unsecuredDebts: Array.from({ length: int(0, 2) }, (_, k) => {
      const balance = num(0, 25_000);
      return {
        label: `debt ${k}`,
        balance,
        monthlyPayment: Math.ceil(balance * debtRate + 20 + r() * 500),
      };
    }),
    studentLoan: chance(0.6)
      ? { balance: num(0, 90_000), repaymentStartYear: int(2000, 2026) }
      : null,
  };

  const retirementOptions = chance(0.12)
    ? null
    : {
        targetNetAnnualExpenses: num(8_000, 90_000),
        maxAge,
        takePCLS: chance(0.5),
        pclsPercentage: pick([0.25, 0.25, num(0, 0.25)]),
        glideStartYears: int(0, 15),
        glideEndYears: int(0, 10),
        flexibleRetirement: chance(0.3),
        maxRetirementDelayYears: int(0, 6),
        spendingGuardrails: chance(0.3)
          ? {
              floor: num(5_000, 40_000),
              ceilingPct: pick([100, 120, 150]),
              band: pick([0.1, 0.2, 0.3]),
              step: pick([0.05, 0.1]),
            }
          : null,
        annuity: chance(0.3)
          ? {
              purchaseAge: int(retirementAge - 2, retirementAge + 15),
              sizing: pick(['essential', 'fixed']),
              amountReal: num(0, 40_000),
              inflationLinked: chance(0.6),
              rate: chance(0.5) ? null : num(0.03, 0.09),
            }
          : null,
      };

  const years = maxAge - currentAge + 1;
  const override = chance(0.4)
    ? Array.from({ length: years }, () =>
        chance(0.15)
          ? null
          : {
              savingsRate: num(-0.35, 0.3),
              retirementRate: num(-0.2, 0.2),
              wageGrowthRate: num(-0.03, 0.08),
              inflationRate: num(-0.01, 0.1),
              boeRate: num(0, 0.08),
            }
      )
    : null;

  // About one scenario in ten gets one invalid input, so validation errors are
  // compared too (both versions must reject it with the same message).
  if (chance(0.1)) {
    const breakers = [
      () => (profile.currentAge = 0),
      () => (profile.retirementAge = currentAge),
      () => (profile.currentYear = 1980),
      () => (profile.grossIncome = -1),
      () => (profile.employeePensionRate = 1.5),
      () => (profile.employerMatch = 'yes'),
      () => (profile.niContributionYears = 2.5),
      () => (profile.statePensionDeferralYears = -1),
      () => (profile.topUpStatePension = 1),
      () => (profile.pensionAccessAge = 0),
      () => (profile.studentLoanPlan = 'plan9'),
      () => (profile.windfalls = [{ age: 'x', amount: 1 }]),
      () => (profile.oneOffExpenses = [{ age: 40, amount: -5 }]),
      () => (profile.employmentChanges = [{ age: 40, fraction: 0 }]),
      () => (profile.dbPensions = [{ status: 'retired', pension: 1 }]),
      () => (rates.savingsRate = NaN),
      () => (rates.mortgageRate = -0.01),
      () => (pots.pensionBalance = -1),
      () => (pots.giaCostBasis = -1),
      () => (pots.mortgage = { balance: 100_000, termYears: 0 }),
      () => (pots.unsecuredDebts = [{ balance: 10_000, monthlyPayment: 1 }]),
      () => (pots.studentLoan = { balance: 10_000, repaymentStartYear: 1980 }),
      () => retirementOptions && (retirementOptions.maxAge = retirementAge),
      () => retirementOptions && (retirementOptions.targetNetAnnualExpenses = -1),
      () => retirementOptions && (retirementOptions.flexibleRetirement = 'no'),
      () => retirementOptions && (retirementOptions.maxRetirementDelayYears = 1.5),
      () =>
        retirementOptions &&
        (retirementOptions.spendingGuardrails = { floor: 10_000, ceilingPct: 90 }),
      () =>
        retirementOptions &&
        (retirementOptions.annuity = { purchaseAge: 70, sizing: 'some', amountReal: 1 }),
    ];
    pick(breakers)();
  }

  return { profile, rates, pots, retirementOptions, override };
}

// ── Comparison ──────────────────────────────────────────────────────────────
function firstDiff(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
    return { path, a, b };
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return a === b ? null : { path, a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a: 'array?', b: 'array?' };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a) || !(k in b)) return { path: `${path}.${k}`, a: a[k], b: b[k] };
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const attempt = (fn) => {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: `${e.constructor.name}: ${e.message}` };
  }
};

let failures = 0;
let errors = 0;
let retirementRuns = 0;
const report = (label, d) => {
  failures++;
  if (failures <= 5)
    console.log(
      `✗ ${label} differs at ${d.path || '(root)'}\n    ${ref}: ${JSON.stringify(d.a)?.slice(0, 200)}\n    working tree: ${JSON.stringify(d.b)?.slice(0, 200)}`
    );
};

for (let seed = 1; seed <= COUNT; seed++) {
  const s = scenario(seed);
  const run = (lib) =>
    attempt(() =>
      lib.projectLifecycle(s.profile, s.rates, s.pots, s.retirementOptions, s.override)
    );
  const a = run(baseLife);
  const b = run(headLife);
  if (a.error) errors++;
  else if (a.value.hasRetirementPhase) retirementRuns++;
  const d = firstDiff(a, b);
  if (d) report(`scenario ${seed}`, d);
}

// Monte Carlo: fewer, smaller runs (each is many projections).
const MC_COUNT = Math.max(5, Math.round(COUNT / 20));
for (let seed = 1; seed <= MC_COUNT; seed++) {
  const s = scenario(10_000 + seed);
  if (!s.retirementOptions) continue;
  const opts = { trials: 40, seed, sex: ['male', 'female', 'neutral'][seed % 3] };
  const run = (lib) =>
    attempt(() => lib.runMonteCarlo(s.profile, s.rates, s.pots, s.retirementOptions, opts));
  const d = firstDiff(run(baseMc), run(headMc));
  if (d) report(`Monte Carlo ${seed}`, d);
}

rmSync(baseDir, { recursive: true, force: true });
console.log(
  `${COUNT} scenarios (${retirementRuns} with retirement, ${errors} rejected by validation) and ${MC_COUNT} Monte Carlo runs vs ${ref}: ` +
    (failures === 0 ? 'identical.' : `${failures} differ.`)
);
process.exitCode = failures === 0 ? 0 : 1;
