/**
 * FanChart — Canvas-based stochastic fan chart component.
 *
 * Renders percentile bands (10th–90th) for total investable portfolio value
 * over time, with:
 *   • Filled bands between p10–p90 and p25–p75
 *   • Cross-sectional percentile lines for p10, p25, p50, p75, p90
 *   • Shortfall markers on the x-axis where each line first hits zero
 *   • Hover detection: nearest age column + nearest percentile line
 *   • Mousedown: locks to the specific trial nearest the hovered percentile
 *     at that age, drawing only that trial's full path until release
 *   • Reference lines for retirement age and state pension age
 */

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { fmtGBPLarge, yTickFmt } from './formatters.js';

// ── Percentile line configuration ─────────────────────────────────────────────
// Ordered bottom-to-top (worst → best) so bands paint correctly.
export const PCT_KEYS = ['p10', 'p25', 'p50', 'p75', 'p90'];

export const PCT_CFG = {
  p10: { pct: 10, label: '10th %ile', color: '#f43f5e', width: 1.5 },
  p25: { pct: 25, label: '25th %ile', color: '#fb923c', width: 1.5 },
  p50: { pct: 50, label: 'Median', color: '#e8b84b', width: 2.5 },
  p75: { pct: 75, label: '75th %ile', color: '#34d399', width: 1.5 },
  p90: { pct: 90, label: '90th %ile', color: '#4f8ef7', width: 1.5 },
};

// ── Canvas layout ─────────────────────────────────────────────────────────────
const PAD = { top: 28, right: 24, bottom: 54, left: 76 };

// ── Rounded-rect helper (avoids ctx.roundRect browser compat issues) ──────────
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── CSS variable reader ───────────────────────────────────────────────────────
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── Pot drawing order: pension at bottom, ISA in middle, GIA on top ───────────
// Matches the stacking order used in the deterministic Recharts AreaChart.
const POT_STACK_ORDER = ['pension', 'isa', 'gia'];

// ── Debt drawing order: mortgage nearest zero, then unsecured, then student ───
// Drawn below the zero axis (negative side).
const DEBT_STACK_ORDER = ['mortgage', 'unsecuredDebt', 'studentLoan'];

// ── Core draw function ────────────────────────────────────────────────────────
// lockedPath:    number[] | null — real-terms total portfolio per year (fallback)
// lockedPctKey:  string | null
// lockedPotData: {pension,isa,gia}[] | null — real-terms per-pot values per year
// potSeries:     {key,name,color}[] | null  — pot colour config
// fourPctTarget: number | null              — 4% rule threshold (same real/nominal basis as adjData)
function drawFanChart(
  canvas,
  W,
  H,
  dpr,
  adjData,
  hoverState,
  retirementAge,
  statePensionAge,
  lockedPath,
  lockedPctKey,
  lockedPotData,
  potSeries,
  fourPctTarget
) {
  const ctx = canvas.getContext('2d');

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.scale(dpr, dpr);

  const bg = cssVar('--bg-card') || '#141c2e';
  const borderCol = cssVar('--border') || '#1f2d47';
  const mutedCol = cssVar('--text-muted') || '#4a5a78';
  const mono = cssVar('--font-mono') || 'monospace';

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  if (!adjData || adjData.length < 2) return {};
  if (W < PAD.left + PAD.right + 40) return {}; // too narrow to draw

  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const minAge = adjData[0].age;
  const maxAgeVal = adjData[adjData.length - 1].age;
  // Scale to the locked trial's own peak (pot total) — or p90 in fan mode.
  const rawMax = lockedPotData
    ? Math.max(...lockedPotData.map((d) => (d.pension ?? 0) + (d.isa ?? 0) + (d.gia ?? 0)), 1)
    : lockedPath
      ? Math.max(...lockedPath, 1)
      : Math.max(...adjData.map((d) => d.p90), 1);

  // Negative extent — only meaningful in locked mode when debts are present.
  const rawMin = lockedPotData
    ? -Math.max(
        ...lockedPotData.map(
          (d) => (d.mortgage ?? 0) + (d.unsecuredDebt ?? 0) + (d.studentLoan ?? 0)
        ),
        0
      )
    : 0;

  // Total range with 8% headroom above, 4% below the debt baseline.
  const totalRange = rawMax - rawMin;
  const maxVal = rawMax + totalRange * 0.08;
  const minVal = rawMin < 0 ? rawMin - totalRange * 0.04 : 0;
  const fullRange = maxVal - minVal;

  function xOf(age) {
    return PAD.left + ((age - minAge) / Math.max(1, maxAgeVal - minAge)) * cW;
  }
  function yOf(val) {
    return PAD.top + cH - ((val - minVal) / fullRange) * cH;
  }

  // ── Grid lines (horizontal) ───────────────────────────────────────────────
  const nGridY = 5;
  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  // Positive grid ticks
  for (let i = 0; i <= nGridY; i++) {
    const v = rawMin + (totalRange * i) / nGridY;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + cW, y);
    ctx.stroke();
  }
  // Zero reference line — draw prominently when there are debts
  if (rawMin < 0) {
    const zy = yOf(0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, zy);
    ctx.lineTo(PAD.left + cW, zy);
    ctx.stroke();
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1;
  }

  // ── Reference lines ───────────────────────────────────────────────────────
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1;

  // Retirement
  const retX = xOf(retirementAge);
  ctx.strokeStyle = 'rgba(232,184,75,0.55)';
  ctx.beginPath();
  ctx.moveTo(retX, PAD.top);
  ctx.lineTo(retX, PAD.top + cH);
  ctx.stroke();

  // State pension
  if (
    statePensionAge !== retirementAge &&
    statePensionAge >= minAge &&
    statePensionAge <= maxAgeVal
  ) {
    const spX = xOf(statePensionAge);
    ctx.strokeStyle = 'rgba(167,139,250,0.45)';
    ctx.beginPath();
    ctx.moveTo(spX, PAD.top);
    ctx.lineTo(spX, PAD.top + cH);
    ctx.stroke();
  }

  // 4% rule horizontal line (always shown, both fan and locked modes)
  if (fourPctTarget != null && fourPctTarget > 0 && fourPctTarget < maxVal) {
    const fy = yOf(fourPctTarget);
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = '#6ee7b7';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(PAD.left, fy);
    ctx.lineTo(PAD.left + cW, fy);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    // Label at the right edge
    ctx.font = `bold 8px ${mono}`;
    ctx.fillStyle = '#6ee7b7';
    ctx.globalAlpha = 0.75;
    ctx.textAlign = 'right';
    ctx.fillText('4% rule', PAD.left + cW - 2, fy - 4);
    ctx.globalAlpha = 1;
  }

  ctx.setLineDash([]);

  // ── Shared helpers ────────────────────────────────────────────────────────
  function fillBand(keyLo, keyHi, color, alpha) {
    ctx.beginPath();
    ctx.moveTo(xOf(adjData[0].age), yOf(adjData[0][keyHi]));
    for (const d of adjData) ctx.lineTo(xOf(d.age), yOf(d[keyHi]));
    for (let i = adjData.length - 1; i >= 0; i--) {
      ctx.lineTo(xOf(adjData[i].age), yOf(adjData[i][keyLo]));
    }
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawLine(key) {
    const cfg = PCT_CFG[key];
    ctx.beginPath();
    let started = false;
    for (const d of adjData) {
      const x = xOf(d.age);
      const y = yOf(d[key]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.width;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  // Downward triangle + age label on the x-axis for a shortfall event.
  function drawShortfallMarker(sfAge, cfg) {
    const sx = xOf(sfAge);
    const sy = PAD.top + cH;
    ctx.beginPath();
    ctx.moveTo(sx, sy + 3);
    ctx.lineTo(sx - 5, sy + 11);
    ctx.lineTo(sx + 5, sy + 11);
    ctx.closePath();
    ctx.fillStyle = cfg.color;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = cfg.color;
    ctx.font = `bold 9px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${sfAge}`, sx, sy + 24);
  }

  // ── Mode: locked single trial (stacked pots) vs. full fan ───────────────────
  if (lockedPotData && potSeries) {
    // Build a colour lookup from potSeries
    const potColor = Object.fromEntries(potSeries.map((s) => [s.key, s.color]));

    /**
     * Draws a set of stacked area bands along the time axis.
     *
     * @param {string[]} order    - Keys to stack, innermost first
     * @param {number}   sign     - +1 draws above zero, -1 draws below zero
     * @param {boolean}  skipEmpty - Skip slices where all values are zero
     */
    function drawStackedBands(order, sign, skipEmpty = false) {
      // Cumulative sums per year: [0, first, first+second, …]
      const cum = lockedPotData.map((d) => {
        const vals = [0];
        for (const k of order) vals.push(vals[vals.length - 1] + Math.max(0, d[k] ?? 0));
        return vals;
      });

      for (let pi = 0; pi < order.length; pi++) {
        const key = order[pi];
        const color = potColor[key];
        if (!color) continue;
        if (skipEmpty && !lockedPotData.some((d) => (d[key] ?? 0) > 0)) continue;

        const outerEdge = (ci) => sign * cum[ci][pi + 1]; // further from zero
        const innerEdge = (ci) => sign * cum[ci][pi]; // closer to zero

        // Filled band
        ctx.beginPath();
        for (let i = 0; i < adjData.length; i++) {
          const x = xOf(adjData[i].age);
          if (i === 0) ctx.moveTo(x, yOf(outerEdge(i)));
          else ctx.lineTo(x, yOf(outerEdge(i)));
        }
        for (let i = adjData.length - 1; i >= 0; i--) {
          ctx.lineTo(xOf(adjData[i].age), yOf(innerEdge(i)));
        }
        ctx.closePath();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Outer-edge stroke
        ctx.beginPath();
        for (let i = 0; i < adjData.length; i++) {
          const x = xOf(adjData[i].age);
          if (i === 0) ctx.moveTo(x, yOf(outerEdge(i)));
          else ctx.lineTo(x, yOf(outerEdge(i)));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      return cum;
    }

    const cumData = drawStackedBands(POT_STACK_ORDER, +1);
    drawStackedBands(DEBT_STACK_ORDER, -1, true);

    // Shortfall marker (when total portfolio hits zero)
    for (let i = 1; i < lockedPotData.length; i++) {
      const total = cumData[i][POT_STACK_ORDER.length];
      const prevTotal = cumData[i - 1][POT_STACK_ORDER.length];
      if (total <= 0 && prevTotal > 0) {
        drawShortfallMarker(adjData[i].age, PCT_CFG[lockedPctKey]);
        break;
      }
    }

    // In-chart label
    const cfg = PCT_CFG[lockedPctKey];
    ctx.font = `bold 10px ${mono}`;
    ctx.fillStyle = cfg.color;
    ctx.textAlign = 'left';
    ctx.fillText(`${cfg.label} · single trial`, PAD.left + 8, PAD.top + 14);
    ctx.font = `9px ${mono}`;
    ctx.fillStyle = mutedCol;
    ctx.fillText('Release to return to fan chart', PAD.left + 8, PAD.top + 27);
  } else {
    // Normal fan mode —————————————————————————————————————————————————————

    // Three semantically-coloured bands:
    //   p10–p25  red (adverse tail)
    //   p25–p75  blue (central range)
    //   p75–p90  green (favourable tail)
    fillBand('p10', 'p25', PCT_CFG.p10.color, 0.18); // red  — adverse tail
    fillBand('p25', 'p75', PCT_CFG.p50.color, 0.22); // gold — central range
    fillBand('p75', 'p90', PCT_CFG.p75.color, 0.18); // green — favourable tail

    // Draw non-median lines first, median on top
    for (const key of ['p10', 'p25', 'p75', 'p90']) drawLine(key);
    drawLine('p50');

    // Shortfall markers — first age where each cross-sectional percentile hits 0
    for (const key of PCT_KEYS) {
      for (let i = 1; i < adjData.length; i++) {
        if (adjData[i][key] <= 0 && adjData[i - 1][key] > 0) {
          drawShortfallMarker(adjData[i].age, PCT_CFG[key]);
          break;
        }
      }
    }
  }

  // ── X-axis tick labels (always) ───────────────────────────────────────────
  ctx.fillStyle = mutedCol;
  ctx.font = `11px ${mono}`;
  ctx.textAlign = 'center';
  for (let age = minAge; age <= maxAgeVal; age++) {
    if ((age - minAge) % 5 !== 0) continue;
    ctx.fillText(`${age}`, xOf(age), PAD.top + cH + 16);
  }

  // ── Y-axis tick labels (always) ───────────────────────────────────────────
  ctx.textAlign = 'right';
  for (let i = 0; i <= nGridY; i++) {
    const v = rawMin + (totalRange * i) / nGridY;
    ctx.fillText(yTickFmt(v), PAD.left - 8, yOf(v) + 4);
  }

  // ── Reference line labels (always) ───────────────────────────────────────
  ctx.font = `bold 9px ${mono}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(232,184,75,0.85)';
  ctx.fillText('Retire', xOf(retirementAge), PAD.top - 8);

  if (
    statePensionAge !== retirementAge &&
    statePensionAge >= minAge &&
    statePensionAge <= maxAgeVal
  ) {
    ctx.fillStyle = 'rgba(167,139,250,0.85)';
    ctx.fillText('State Pension', xOf(statePensionAge), PAD.top - 8);
  }

  // ── Hover overlay (fan mode only) ─────────────────────────────────────────
  if (!lockedPath && hoverState && hoverState.age != null) {
    const hx = xOf(hoverState.age);

    // Vertical cursor line
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = 'rgba(232,184,75,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, PAD.top);
    ctx.lineTo(hx, PAD.top + cH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dots on each line at cursor age
    const ageRow = hoverState.ageRow;
    if (ageRow) {
      for (const key of PCT_KEYS) {
        const val = ageRow[key];
        if (!val || val <= 0) continue;
        const hy = yOf(val);
        const cfg = PCT_CFG[key];
        const isActive = key === hoverState.pctKey;

        // Outer glow ring for active percentile
        if (isActive) {
          ctx.beginPath();
          ctx.arc(hx, hy, 8, 0, Math.PI * 2);
          ctx.strokeStyle = cfg.color;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Filled dot
        ctx.beginPath();
        ctx.arc(hx, hy, isActive ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = cfg.color;
        ctx.fill();
      }
    }

    // Tooltip box
    if (ageRow) {
      const lines = PCT_KEYS.slice()
        .reverse() // p90 → p10 (best to worst) for tooltip
        .map((key) => ({ key, cfg: PCT_CFG[key], val: ageRow[key] ?? 0 }));

      ctx.font = `10px ${mono}`;
      const valW = Math.max(
        ...lines.map((l) => ctx.measureText(fmtGBPLarge(l.val)).width),
        ctx.measureText('Exhausted').width
      );
      const boxW = 108 + valW;
      const lineH = 17;
      const boxH = 30 + lines.length * lineH + 6;

      let bx = hx + 14;
      if (bx + boxW > W - 8) bx = hx - boxW - 14;
      const by = PAD.top + 6;

      // Box background + border
      roundRectPath(ctx, bx, by, boxW, boxH, 6);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,184,75,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // "Age XX" header
      ctx.font = `bold 11px ${mono}`;
      ctx.fillStyle = 'rgba(232,184,75,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(`Age ${hoverState.age}`, bx + 10, by + 18);

      // Per-percentile rows
      for (let i = 0; i < lines.length; i++) {
        const { key, cfg, val } = lines[i];
        const ly = by + 32 + i * lineH;
        const isActive = key === hoverState.pctKey;
        ctx.font = `${isActive ? 'bold' : ''} 10px ${mono}`.trim();
        ctx.fillStyle = cfg.color;
        ctx.textAlign = 'left';
        ctx.fillText(cfg.label, bx + 10, ly);
        ctx.textAlign = 'right';
        ctx.fillText(val > 0 ? fmtGBPLarge(val) : 'Exhausted', bx + boxW - 10, ly);
      }
    }
  }

  // Return coordinate helpers for hit-testing in mousemove
  return { xOf, yOf, minAge, maxAgeVal, maxVal, cW, cH };
}

// ── Legend strip ──────────────────────────────────────────────────────────────
function FanLegend() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      {/* Band swatches — three coloured regions matching the canvas bands */}
      {[
        { label: '10–25%', bg: 'rgba(244,63,94,0.22)', border: 'rgba(244,63,94,0.45)' }, // red
        { label: '25–75%', bg: 'rgba(232,184,75,0.26)', border: 'rgba(232,184,75,0.5)' }, // gold
        { label: '75–90%', bg: 'rgba(52,211,153,0.22)', border: 'rgba(52,211,153,0.45)' }, // green
      ].map(({ label, bg, border }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div
            style={{
              width: 28,
              height: 10,
              background: bg,
              border: `1px solid ${border}`,
              borderRadius: 2,
            }}
          />
          <span
            style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
          >
            {label}
          </span>
        </div>
      ))}
      {/* Percentile line swatches */}
      {[...PCT_KEYS].reverse().map((key) => {
        const cfg = PCT_CFG[key];
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div
              style={{
                width: 20,
                height: 2,
                background: cfg.color,
                borderRadius: 1,
              }}
            />
            <span
              style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            >
              {cfg.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   percentileData: object[],
 *   portfolioMatrix: number[][],
 *   repPaths: object,
 *   realTerms: boolean,
 *   inflRate: number,
 *   currentAge: number,
 *   retirementAge: number,
 *   statePensionAge: number,
 *   onHoverRow: function,
 *   showDetails: boolean,
 *   colorMode?: string,
 *   height?: number,
 * }} props
 */
export function FanChart({
  percentileData,
  portfolioMatrix,
  allPotData,
  potSeries,
  repPaths,
  realTerms,
  inflRate,
  currentAge,
  retirementAge,
  statePensionAge,
  onHoverRow,
  fourPctTarget = null,
  showDetails,
  colorMode = 'dark',
  height = 390,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(null);
  const [hoverState, setHoverState] = useState(null);
  // { trialIdx: number, pctKey: string } while mouse is held; null otherwise
  const [lockedTrial, setLockedTrial] = useState(null);
  // Stores coordinate helpers computed during last draw; used for hit testing
  const coordRef = useRef(null);

  // Measure container; redraws when width changes (sidebar toggle, resize).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const initial = el.getBoundingClientRect().width;
    if (initial > 0) setContainerWidth(initial);
    let rafId = null;
    const obs = new ResizeObserver(([entry]) => {
      // Coalesce rapid resize events to one update per animation frame.
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const w = entry.contentRect.width || el.getBoundingClientRect().width;
        if (w > 0) setContainerWidth(w);
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      obs.disconnect();
    };
  }, []);

  // Real-terms adjusted percentile data — memoised so the canvas useEffect
  // only re-fires when the underlying data or real-terms settings actually change,
  // not on every parent render.
  const adjData = useMemo(() => {
    if (!percentileData) return null;
    if (!realTerms) return percentileData;
    return percentileData.map((row) => {
      const f = Math.pow(1 / (1 + inflRate), row.age - currentAge);
      return {
        age: row.age,
        p10: row.p10 * f,
        p25: row.p25 * f,
        p50: row.p50 * f,
        p75: row.p75 * f,
        p90: row.p90 * f,
      };
    });
  }, [percentileData, realTerms, inflRate, currentAge]);

  // Real-terms adjusted path for the locked trial, aligned with adjData by index.
  const adjLockedPath = useMemo(() => {
    if (!lockedTrial || !portfolioMatrix || !percentileData) return null;
    const col = portfolioMatrix[lockedTrial.trialIdx];
    if (!col) return null;
    return percentileData.map((row, i) => {
      const nominal = col[i] ?? 0;
      const f = realTerms ? Math.pow(1 / (1 + inflRate), row.age - currentAge) : 1;
      return Math.max(0, nominal * f);
    });
  }, [lockedTrial, portfolioMatrix, percentileData, realTerms, inflRate, currentAge]);

  // Real-terms adjusted per-pot breakdown for the locked trial.
  const adjLockedPotData = useMemo(() => {
    if (!lockedTrial || !allPotData || !percentileData) return null;
    const trialPots = allPotData[lockedTrial.trialIdx];
    if (!trialPots) return null;
    return trialPots.map((pots, i) => {
      const f = realTerms ? Math.pow(1 / (1 + inflRate), percentileData[i].age - currentAge) : 1;
      return {
        // Assets (clamped to ≥0; debt side handled separately)
        pension: Math.max(0, (pots.pension ?? 0) * f),
        isa: Math.max(0, (pots.isa ?? 0) * f),
        gia: Math.max(0, (pots.gia ?? 0) * f),
        // Debts (positive magnitudes; drawn below zero axis)
        mortgage: Math.max(0, (pots.mortgage ?? 0) * f),
        unsecuredDebt: Math.max(0, (pots.unsecuredDebt ?? 0) * f),
        studentLoan: Math.max(0, (pots.studentLoan ?? 0) * f),
      };
    });
  }, [lockedTrial, allPotData, percentileData, realTerms, inflRate, currentAge]);

  // Redraw whenever data, hover, lock state, or container size changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !containerWidth || !adjData) return;
    const dpr = window.devicePixelRatio || 1;
    const coords = drawFanChart(
      canvas,
      containerWidth,
      height,
      dpr,
      adjData,
      hoverState,
      retirementAge,
      statePensionAge,
      adjLockedPath,
      lockedTrial?.pctKey ?? null,
      adjLockedPotData,
      potSeries ?? null,
      fourPctTarget
    );
    coordRef.current = { ...coords, adjData };
    // colorMode in deps: theme change re-reads CSS vars via cssVar() at draw time
  }, [
    adjData,
    hoverState,
    containerWidth,
    height,
    retirementAge,
    statePensionAge,
    colorMode,
    adjLockedPath,
    adjLockedPotData,
    lockedTrial,
    potSeries,
    fourPctTarget,
  ]);

  // Mousemove: update hover; frozen while a trial is locked
  const handleMouseMove = useCallback(
    (e) => {
      if (lockedTrial) return; // keep the locked view stable
      const info = coordRef.current;
      if (!info || !info.xOf) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const { minAge, maxAgeVal, adjData: data, cW, cH, yOf } = info;

      const chartX = x - PAD.left;
      if (chartX < 0 || chartX > cW || y < PAD.top || y > PAD.top + cH) {
        if (hoverState !== null) {
          setHoverState(null);
          if (onHoverRow) onHoverRow(null);
        }
        return;
      }

      const ageFloat = minAge + (chartX / cW) * (maxAgeVal - minAge);
      const age = Math.round(Math.max(minAge, Math.min(maxAgeVal, ageFloat)));
      const ageRow = data.find((d) => d.age === age);
      if (!ageRow) return;

      let nearestKey = 'p50';
      let nearestDist = Infinity;
      for (const key of PCT_KEYS) {
        const val = ageRow[key];
        if (!val || val <= 0) continue;
        const lineY = yOf(val);
        const dist = Math.abs(y - lineY);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestKey = key;
        }
      }

      if (!hoverState || hoverState.age !== age || hoverState.pctKey !== nearestKey) {
        setHoverState({ age, pctKey: nearestKey, ageRow });
        if (onHoverRow && repPaths) {
          const pctNum = PCT_CFG[nearestKey].pct;
          const pathRow = (repPaths[pctNum] ?? []).find((r) => r.age === age) ?? null;
          onHoverRow(pathRow);
        }
      }
    },
    [lockedTrial, hoverState, repPaths, onHoverRow]
  );

  // Mousedown: find the trial closest to the hovered percentile at the hovered
  // age and lock to it.
  const handleMouseDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      if (!hoverState?.ageRow || !portfolioMatrix) return;
      const info = coordRef.current;
      if (!info?.adjData) return;

      const { age, pctKey, ageRow } = hoverState;
      const ageIdx = info.adjData.findIndex((d) => d.age === age);
      if (ageIdx < 0) return;

      // De-adjust the cross-sectional value back to nominal for comparison
      const adjustedVal = ageRow[pctKey] ?? 0;
      const inflFactor = realTerms ? Math.pow(1 + inflRate, age - currentAge) : 1;
      const nominalTarget = adjustedVal * inflFactor;

      // Find the trial whose nominal portfolio value at this age is closest
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < portfolioMatrix.length; i++) {
        const dist = Math.abs((portfolioMatrix[i][ageIdx] ?? 0) - nominalTarget);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      setLockedTrial({ trialIdx: bestIdx, pctKey });
      if (onHoverRow) onHoverRow(null); // clear detail panel while locked
    },
    [hoverState, portfolioMatrix, realTerms, inflRate, currentAge, onHoverRow]
  );

  const handleMouseUp = useCallback(() => {
    setLockedTrial(null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverState(null);
    setLockedTrial(null);
    if (onHoverRow) onHoverRow(null);
  }, [onHoverRow]);

  const isLocked = lockedTrial !== null;

  return (
    <div>
      {/* Legend */}
      <div
        style={{
          paddingLeft: PAD.left,
          marginBottom: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {/* In locked mode show pot legend; otherwise show percentile band legend */}
        {isLocked && potSeries ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {/* Assets: GIA → ISA → Pension (top-to-bottom stacking order) */}
            {[...potSeries]
              .filter((s) => POT_STACK_ORDER.includes(s.key))
              .sort((a, b) => POT_STACK_ORDER.indexOf(b.key) - POT_STACK_ORDER.indexOf(a.key))
              .map((s) => (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div
                    style={{
                      width: 20,
                      height: 10,
                      background: s.color,
                      opacity: 0.65,
                      borderRadius: 2,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {s.name}
                  </span>
                </div>
              ))}
            {/* Debts (only show if any debt series present in potSeries) */}
            {potSeries
              .filter((s) => DEBT_STACK_ORDER.includes(s.key))
              .map((s) => (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div
                    style={{
                      width: 20,
                      height: 10,
                      background: s.color,
                      opacity: 0.65,
                      borderRadius: 2,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {s.name}
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <FanLegend />
        )}
        {isLocked ? (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: PCT_CFG[lockedTrial.pctKey].color,
              letterSpacing: '0.04em',
            }}
          >
            {PCT_CFG[lockedTrial.pctKey].label} · single trial · hold to inspect
          </span>
        ) : (
          hoverState && (
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: PCT_CFG[hoverState.pctKey].color,
                letterSpacing: '0.04em',
              }}
            >
              {PCT_CFG[hoverState.pctKey].label} · Age {hoverState.age}
            </span>
          )
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', cursor: isLocked ? 'default' : 'crosshair' }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />
      </div>

      {/* Hint */}
      {showDetails && !isLocked && (
        <div
          style={{
            paddingLeft: PAD.left,
            marginTop: 6,
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            letterSpacing: '0.04em',
          }}
        >
          Hover to inspect · click and hold to view a single trial
        </div>
      )}
    </div>
  );
}
