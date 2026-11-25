/**
 * Runs Monte Carlo trials in several workers at once.
 *
 * The page splits a run's trials into small chunks and hands them to whichever
 * worker is free. Each worker plans the run itself (planMonteCarlo: every
 * trial's random draws, from the seed, so every worker gets the same ones),
 * runs its chunk (runMonteCarloTrial) and sends back the trial summaries. Once
 * every chunk is back, one worker summarises them all (summariseMonteCarlo)
 * and sends the result. The page does none of the work, and the result is the
 * same as runMonteCarlo's.
 *
 * A new run replaces the one in progress: its waiting chunks are dropped, and
 * any chunk a worker is still running is ignored when it comes back.
 */

import {
  monteCarloTrialCount,
  planMonteCarlo,
  runMonteCarloTrial,
  summariseMonteCarlo,
  TRIAL_ARRAYS,
} from './ukMonteCarlo.js';

/** The error a replaced run's promise rejects with. */
export class MonteCarloSuperseded extends Error {
  constructor() {
    super('Monte Carlo run replaced by a newer one');
    this.name = 'MonteCarloSuperseded';
  }
}

// A chunk's trial summaries travel as one bundle: each per-year array of every
// trial joined into one long array (with where each trial's part starts), plus
// the other fields. Cheap to send, and the page never has to open it.
function packTrials(trials) {
  const offsets = new Int32Array(trials.length + 1);
  for (let j = 0; j < trials.length; j++)
    offsets[j + 1] = offsets[j] + (trials[j] ? trials[j].ages.length : 0);
  const arrays = {};
  const budgetOffsets = new Int32Array(trials.length + 1);
  for (let j = 0; j < trials.length; j++)
    budgetOffsets[j + 1] = budgetOffsets[j] + (trials[j] ? trials[j].budgets.length : 0);
  for (const key of TRIAL_ARRAYS) {
    const at = key === 'budgets' || key === 'budgetAges' ? budgetOffsets : offsets;
    const joined = new Float64Array(at[trials.length]);
    trials.forEach((tr, j) => tr && joined.set(tr[key], at[j]));
    arrays[key] = joined;
  }
  const others = trials.map((tr) => {
    if (!tr) return null;
    const rest = { ...tr };
    for (const key of TRIAL_ARRAYS) delete rest[key];
    return rest;
  });
  return { offsets, budgetOffsets, arrays, others };
}

function packTransferables(pack) {
  return [
    pack.offsets.buffer,
    pack.budgetOffsets.buffer,
    ...Object.values(pack.arrays).map((a) => a.buffer),
  ];
}

// The trial summaries back from bundles, in trial order (null for a failed trial).
function unpackTrials(packs, n) {
  const trials = new Array(n).fill(null);
  for (const { from, pack } of packs) {
    pack.others.forEach((rest, j) => {
      if (!rest) return;
      const tr = { ...rest };
      for (const key of TRIAL_ARRAYS) {
        const at = key === 'budgets' || key === 'budgetAges' ? pack.budgetOffsets : pack.offsets;
        tr[key] = pack.arrays[key].subarray(at[j], at[j + 1]);
      }
      trials[from + j] = tr;
    });
  }
  return trials;
}

/**
 * In a worker: handle one message from the pool — run a chunk of trials
 * ({ type: 'chunk', id, args, from, to }) or summarise a run's trials
 * ({ type: 'summarise', id, args, packs }). `cache` keeps the plan between
 * messages for the same run. Returns the reply and the buffers to transfer
 * with it.
 */
export function handleMonteCarloMessage(cache, { type, id, args, from, to, packs }) {
  try {
    if (cache.id !== id) {
      cache.id = id;
      cache.plan = planMonteCarlo(...args);
    }
    if (type === 'summarise') {
      const trials = unpackTrials(packs, cache.plan.trials);
      return { reply: { type, id, result: summariseMonteCarlo(cache.plan, trials) }, transfer: [] };
    }
    const done = [];
    for (let t = from; t < to; t++) done.push(runMonteCarloTrial(cache.plan, t));
    const pack = packTrials(done);
    return { reply: { type, id, from, to, pack }, transfer: packTransferables(pack) };
  } catch (err) {
    return { reply: { type, id, error: String(err?.message ?? err) }, transfer: [] };
  }
}

/**
 * A pool of `size` workers made by `createWorker()` (each running
 * handleMonteCarloMessage on its messages). `run(args)` takes runMonteCarlo's
 * arguments and resolves to its result.
 */
const MAX_IN_FLIGHT = 2;

export function createMonteCarloPool({ size, createWorker, chunksPerWorker = 4 }) {
  const slots = [];
  let current = null;
  let nextId = 0;

  function spawn(slot) {
    slot.worker = createWorker();
    slot.inFlight = 0;
    slot.worker.onmessage = (event) => receive(slot, event.data);
    slot.worker.onerror = (event) => {
      event?.preventDefault?.();
      slot.worker.terminate();
      spawn(slot);
      if (current) fail(current, new Error(event?.message || 'Monte Carlo worker failed'));
      dispatch();
    };
  }
  for (let k = 0; k < Math.max(1, size); k++) {
    const slot = {};
    spawn(slot);
    slots.push(slot);
  }

  function fail(run, err) {
    if (current === run) current = null;
    run.reject(err);
  }

  // Hand the current run's waiting jobs to the workers, least busy first. Each
  // can hold two, so it starts the next as soon as it finishes one.
  function dispatch() {
    while (current && current.queue.length > 0) {
      const slot = slots.reduce((a, b) => (b.inFlight < a.inFlight ? b : a));
      if (slot.inFlight >= MAX_IN_FLIGHT) return;
      const job = current.queue.shift();
      slot.inFlight += 1;
      if (job === 'summarise') {
        const packs = current.packs;
        slot.worker.postMessage(
          { type: 'summarise', id: current.id, args: current.args, packs },
          packs.flatMap((p) => packTransferables(p.pack))
        );
      } else {
        const [from, to] = job;
        slot.worker.postMessage({ type: 'chunk', id: current.id, args: current.args, from, to });
      }
    }
  }

  function receive(slot, data) {
    slot.inFlight -= 1;
    const run = current;
    if (run && data.id === run.id) {
      if (data.error) {
        fail(run, new Error(data.error));
      } else if (data.type === 'summarise') {
        current = null;
        run.resolve(data.result);
      } else {
        run.packs.push({ from: data.from, pack: data.pack });
        run.waiting -= 1;
        if (run.waiting === 0) run.queue.push('summarise');
      }
    }
    dispatch();
  }

  return {
    run(args) {
      if (current) fail(current, new MonteCarloSuperseded());
      return new Promise((resolve, reject) => {
        const n = monteCarloTrialCount(args[4]);
        const chunk = Math.max(1, Math.ceil(n / (slots.length * chunksPerWorker)));
        const queue = [];
        for (let from = 0; from < n; from += chunk) queue.push([from, Math.min(n, from + chunk)]);
        // No trials: summarise straight away (runMonteCarlo's result is null).
        if (queue.length === 0) queue.push('summarise');
        current = {
          id: ++nextId,
          args,
          queue,
          waiting: queue.length,
          packs: [],
          resolve,
          reject,
        };
        dispatch();
      });
    },
    dispose() {
      if (current) fail(current, new MonteCarloSuperseded());
      for (const slot of slots) slot.worker.terminate();
    },
  };
}
