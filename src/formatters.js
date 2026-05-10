/**
 * Shared number-formatting utilities.
 *
 * Pure functions with no DOM or React dependencies — safe to import from both
 * App.jsx and FanChart.jsx (and any future canvas / worker context).
 */

/**
 * Formats a GBP amount for display in tight spaces (chart labels, stat cards).
 *   ≥ £1m  → £1.23m
 *   < £1m  → £123,456
 * Negative values are prefixed with −.
 */
export function fmtGBPLarge(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}m`;
  return `${sign}£${Math.round(abs).toLocaleString('en-GB')}`;
}

/**
 * Formats a GBP value for Y-axis tick labels (compact, no pence).
 *   ≥ £1m  → £1.2m
 *   ≥ £1k  → £123k
 *   < £1k  → £42
 * Negative values are prefixed with −.
 */
export function yTickFmt(v) {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1_000_000) return `${s}£${(a / 1_000_000).toFixed(1)}m`;
  if (a >= 1_000) return `${s}£${(a / 1_000).toFixed(0)}k`;
  return `${s}£${Math.round(a)}`;
}
