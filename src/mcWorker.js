/**
 * One of the Monte Carlo pool's workers (mcPool.js): runs chunks of a run's
 * trials, or summarises them, off the main thread.
 */

import { handleMonteCarloMessage } from './mcPool.js';

const cache = { id: null, plan: null };

self.onmessage = (event) => {
  const { reply, transfer } = handleMonteCarloMessage(cache, event.data);
  self.postMessage(reply, transfer);
};
