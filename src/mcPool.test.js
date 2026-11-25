import assert from 'node:assert/strict';
import {
  runMonteCarlo,
  planMonteCarlo,
  runMonteCarloTrial,
  summariseMonteCarlo,
} from './ukMonteCarlo.js';
import { createMonteCarloPool, handleMonteCarloMessage, MonteCarloSuperseded } from './mcPool.js';

let passed = 0;
let failed = 0;
async function it(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// A stand-in for a Web Worker: runs chunks in this process, later (like a
// real worker), with messages copied the way postMessage copies them.
function fakeWorker(log) {
  const cache = { id: null, plan: null };
  const worker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(data) {
      log?.push(data);
      const copy = structuredClone(data);
      setTimeout(() => {
        if (worker.terminated) return;
        const { reply } = handleMonteCarloMessage(cache, copy);
        worker.onmessage?.({ data: structuredClone(reply) });
      }, 0);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

const profile = {
  currentAge: 40,
  retirementAge: 60,
  currentYear: 2026,
  grossIncome: 60_000,
  employeePensionRate: 0.05,
  employerPensionRate: 0.05,
  niContributionYears: 20,
  annualLivingExpenses: 30_000,
};
const couple = {
  ...profile,
  partner: {
    currentAge: 37,
    retirementAge: 58,
    grossIncome: 35_000,
    employeePensionRate: 0.05,
    employerPensionRate: 0.03,
    niContributionYears: 15,
    pots: { pensionBalance: 40_000, isaBalance: 10_000 },
  },
  spendingShiftAtFirstRetirement: 0.5,
};
const rates = {
  savingsRate: 0.06,
  retirementRate: 0.045,
  wageGrowthRate: 0.03,
  inflationRate: 0.025,
  boeRate: 0.04,
};
const pots = { pensionBalance: 100_000, isaBalance: 50_000, giaBalance: 20_000 };
const retirementOpts = {
  targetNetAnnualExpenses: 32_000,
  maxAge: 95,
  takePCLS: true,
  flexibleRetirement: true,
  maxRetirementDelayYears: 3,
  spendingGuardrails: { floor: 22_000, ceilingPct: 120, band: 0.2, step: 0.1 },
};
const opts = {
  trials: 37,
  seed: 99,
  sex: 'male',
  partnerSex: 'female',
  essentialFloorReal: 22_000,
};
const argsFor = (p, o = opts) => [p, rates, pots, retirementOpts, o];

console.log('\nMonte Carlo in steps');

await it('planning, running each trial and summarising gives runMonteCarlo’s result', () => {
  for (const p of [profile, couple]) {
    const plan = planMonteCarlo(...argsFor(p));
    // Trials run in any order, as workers would.
    const trials = new Array(plan.trials);
    for (let t = plan.trials - 1; t >= 0; t--) trials[t] = runMonteCarloTrial(plan, t);
    assert.deepEqual(summariseMonteCarlo(plan, trials), runMonteCarlo(...argsFor(p)));
  }
});

console.log('\nMonte Carlo worker pool');

await it('gives the same result as running in one go, single and couple', async () => {
  for (const p of [profile, couple]) {
    const pool = createMonteCarloPool({ size: 3, createWorker: () => fakeWorker() });
    const result = await pool.run(argsFor(p));
    assert.deepEqual(result, runMonteCarlo(...argsFor(p)));
    pool.dispose();
  }
});

await it('splits the trials into chunks across the workers, then summarises in one', async () => {
  const log = [];
  const pool = createMonteCarloPool({ size: 3, createWorker: () => fakeWorker(log) });
  await pool.run(argsFor(couple));
  // 37 trials over 3 workers × 4 chunks each → chunks of 4, the last of 1.
  const chunks = log.filter((m) => m.type === 'chunk');
  assert.deepEqual(
    chunks.map((m) => [m.from, m.to]),
    [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].map((f) => [f, Math.min(37, f + 4)])
  );
  assert.deepEqual(
    log.map((m) => m.type),
    [...chunks.map(() => 'chunk'), 'summarise']
  );
  pool.dispose();
});

await it('a new run replaces the one in progress', async () => {
  const pool = createMonteCarloPool({ size: 2, createWorker: () => fakeWorker() });
  const first = pool.run(argsFor(couple));
  const other = { ...opts, seed: 7 };
  const second = pool.run(argsFor(couple, other));
  await assert.rejects(first, MonteCarloSuperseded);
  assert.deepEqual(await second, runMonteCarlo(...argsFor(couple, other)));
  pool.dispose();
});

await it('resolves to null with no trials, or when every trial fails, as runMonteCarlo does', async () => {
  const pool = createMonteCarloPool({ size: 2, createWorker: () => fakeWorker() });
  // A horizon before retirement: every projection throws.
  const bad = [profile, rates, pots, { ...retirementOpts, maxAge: 55 }, { ...opts, trials: 5 }];
  assert.equal(runMonteCarlo(...bad), null);
  assert.equal(await pool.run(bad), null);
  const none = argsFor(profile, { ...opts, trials: 0 });
  assert.equal(runMonteCarlo(...none), null);
  assert.equal(await pool.run(none), null);
  pool.dispose();
});

await it('rejects when the run can’t be planned', async () => {
  const pool = createMonteCarloPool({ size: 2, createWorker: () => fakeWorker() });
  const bad = [profile, rates, pots, { ...retirementOpts, maxAge: 10 }, opts];
  await assert.rejects(pool.run(bad));
  pool.dispose();
});

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exitCode = 1;
}
