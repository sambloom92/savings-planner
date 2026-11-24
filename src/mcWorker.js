/**
 * Runs the Monte Carlo simulation off the main thread, so the page stays
 * responsive while it works. The app sends { id, args } (runMonteCarlo's
 * arguments) and gets back { id, result } or { id, error }. To abandon a run,
 * the app stops this worker and starts a new one.
 */

import { runMonteCarlo } from './ukMonteCarlo.js';

self.onmessage = (event) => {
  const { id, args } = event.data;
  try {
    self.postMessage({ id, result: runMonteCarlo(...args) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
