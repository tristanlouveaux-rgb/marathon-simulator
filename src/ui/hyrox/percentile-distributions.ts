/**
 * HYROX Percentile distribution charts.
 *
 * For each headline metric (total time, run total, work total across the 8
 * stations, RoxZone), renders an asymmetric population PDF derived from the
 * real cumulative-percentile breakpoints of the athlete's cohort
 * (hyroxResultsTable: HYROX results, seasons 8 and 9, format x sex, or the
 * pair's division for doubles; src/data/hyrox-results-s79.ts).
 *
 * Method: differentiate the cumulative-percentile table between adjacent
 * breakpoints to produce per-segment density (% per second), oversample with
 * linear interpolation, lightly smooth, then plot. This is the actual shape of
 * the population. No synthesised Gaussians, no fake noise. Every format has
 * real tables now (Pro Doubles included), so the synthetic fallback is gone; a
 * metric with no published table is left out.
 *
 * UX: glass card per UX_PATTERNS, HTML-positioned p25/p50/p75 reference lines,
 * user time inlined in the row header. No SVG text.
 *
 * Side: tracking. Used on forecast view as a transparency aid.
 */

import type { HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { getState } from '@/state/store';
import {
  hyroxCohortForState,
  hyroxResultsTable,
  hyroxFasterThanPct,
  hyroxResultsCaption,
  type HyroxResultsCohort,
} from '@/calculations/hyrox-results';
import { hyroxTierLabel, hyroxTierLabelIn } from '@/calculations/hyrox-population';
import type { HyroxPercentileTable, HyroxResultsMetric } from '@/data/hyrox-results-s79';

type Breakpoints = HyroxPercentileTable;

interface MetricChart {
  label: string;
  userValueSec: number;
  /** Real cumulative-percentile breakpoints of the cohort. */
  realTable: Breakpoints;
  /** "Faster than X%" position (hyroxFasterThanPct on the same table). */
  fasterThanPct: number;
  /** The cohort to name on the tier ("top 14% of women"): the total row only. */
  nameCohort?: HyroxResultsCohort;
  /** Vibrant per-metric accent — stroke + dot colour. */
  accent: string;
  /** Translucent area fill paired with `accent`. */
  fill: string;
}

const W = 320;
const H = 64;
const PAD_X = 14;
const usableW = W - PAD_X * 2;
const SAMPLE_COUNT = 80;

// Each row gets its own vibrant accent so the four metrics read like the
// canonical trend cards (Swim CSS / Bike FTP / Run LT / VO2max). One chart,
// one colour, all distinct. See `feedback_chart_palette` memory.
// Per-metric accents are assigned in `renderPercentileDistributions` below.
const USER_LINE = '#0F172A';         // slate-900. Primary text token

function fmtMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "faster than X%" as the friendly tier label (hyroxTierLabel, the label
 *  every HYROX percentile chip reads). */
const fmtTier = hyroxTierLabel;

/** Inverse lookup: time at a target cumulative percentile. */
function timeAtCumPct(table: Breakpoints, targetCumPct: number): number | null {
  if (!table || table.length === 0) return null;
  if (targetCumPct <= table[0][1]) return table[0][0];
  if (targetCumPct >= table[table.length - 1][1]) return table[table.length - 1][0];
  for (let i = 1; i < table.length; i++) {
    const [t0, p0] = table[i - 1];
    const [t1, p1] = table[i];
    if (targetCumPct <= p1) {
      const frac = (targetCumPct - p0) / (p1 - p0);
      return t0 + frac * (t1 - t0);
    }
  }
  return null;
}

/** Build a smoothed PDF from the cumulative-percentile breakpoints.
 *  Returns SAMPLE_COUNT density samples spanning slightly beyond [t_min, t_max]. */
function densityFromCumTable(table: Breakpoints, xMin: number, xMax: number): number[] {
  // Per-segment density (delta_pct / delta_t), placed at the segment midpoint.
  const midSamples: Array<{ x: number; d: number }> = [];
  for (let i = 0; i < table.length - 1; i++) {
    const [t0, p0] = table[i];
    const [t1, p1] = table[i + 1];
    const dt = Math.max(0.001, t1 - t0);
    midSamples.push({ x: (t0 + t1) / 2, d: (p1 - p0) / dt });
  }
  // Add zero-density anchors slightly outside the table extent so the curve fades to zero at the tails.
  midSamples.unshift({ x: xMin, d: 0 });
  midSamples.push({ x: xMax, d: 0 });

  // Linear-interpolate to SAMPLE_COUNT samples, then box-smooth (k=3) for visual cleanliness.
  const raw: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const x = xMin + (i / (SAMPLE_COUNT - 1)) * (xMax - xMin);
    let lo = 0;
    while (lo < midSamples.length - 1 && midSamples[lo + 1].x < x) lo++;
    const hi = Math.min(lo + 1, midSamples.length - 1);
    const x0 = midSamples[lo].x; const x1 = midSamples[hi].x;
    const d0 = midSamples[lo].d; const d1 = midSamples[hi].d;
    const frac = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    raw.push(d0 + frac * (d1 - d0));
  }
  // 3-point box smoothing.
  const smoothed: number[] = raw.map((_, i) => {
    let sum = 0; let count = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j >= 0 && j < raw.length) { sum += raw[j]; count++; }
    }
    return sum / count;
  });
  return smoothed;
}

/** Build the SVG + HTML overlay for a single distribution row. */
function renderDistributionRow(metric: MetricChart, rowIndex: number): string {
  const { realTable, userValueSec } = metric;

  // Visible x-range: slightly outside the data range to give the tails room.
  const dataMin = realTable[0][0];
  const dataMax = realTable[realTable.length - 1][0];
  const pad = (dataMax - dataMin) * 0.04;
  const xMin = dataMin - pad;
  const xMax = dataMax + pad;
  const xRange = xMax - xMin;

  const samples = densityFromCumTable(realTable, xMin, xMax);
  const maxDensity = Math.max(...samples, 1e-6);

  // Build curve path.
  const pts = samples.map((d, i) => {
    const x = PAD_X + (i / (SAMPLE_COUNT - 1)) * usableW;
    const y = H - 6 - (d / maxDensity) * (H - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M${pts.join(' L')}`;
  const fillPath = `${linePath} L${PAD_X + usableW},${H - 6} L${PAD_X},${H - 6} Z`;

  // p25 / p50 / p75 guide x positions.
  const pctXs: Array<{ pct: number; x: number; label: string }> = [];
  for (const [pct, label] of [[25, 'p25'], [50, 'p50'], [75, 'p75']] as const) {
    const t = timeAtCumPct(realTable, pct);
    if (t == null) continue;
    const x = PAD_X + ((t - xMin) / xRange) * usableW;
    pctXs.push({ pct, x, label });
  }

  // User position.
  const userClamped = Math.min(xMax, Math.max(xMin, userValueSec));
  const userX = PAD_X + ((userClamped - xMin) / xRange) * usableW;
  const offChart = userValueSec < xMin || userValueSec > xMax;

  // Convert userX (px in viewBox) to % of chart width for HTML overlay.
  const userPct = (userX / W) * 100;

  // SVG guide lines (faint dashed).
  const guideSvg = pctXs.map(g =>
    `<line x1="${g.x.toFixed(1)}" y1="6" x2="${g.x.toFixed(1)}" y2="${H - 6}" stroke="rgba(0,0,0,0.10)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`
  ).join('');

  // HTML overlay: user "you" pill above the line, and p25/p50/p75 captions below the chart.
  const userPillSide = userPct > 70 ? 'right' : userPct < 30 ? 'left' : 'center';
  const pillTransform = userPillSide === 'right' ? 'translateX(-100%)'
    : userPillSide === 'left'  ? 'translateX(0)'
    : 'translateX(-50%)';
  const pillLeft = userPillSide === 'right' ? `${(userX - 4).toFixed(1)}px`
    : userPillSide === 'left'  ? `${(userX + 4).toFixed(1)}px`
    : `${userX.toFixed(1)}px`;

  const pctLabelsHtml = pctXs.map(g =>
    `<span style="position:absolute;left:${((g.x / W) * 100).toFixed(2)}%;top:0;transform:translateX(-50%);font-size:9px;color:var(--c-faint);font-variant-numeric:tabular-nums">${g.label}</span>`
  ).join('');

  // Animation timing. Staggered per row so curves draw L→R in sequence and
  // the user marker lands last with a small scale-up. Total wall time per row
  // is ~750ms; rows offset by 140ms.
  const rowDelay = rowIndex * 140;
  const fillDelay = rowDelay + 50;
  const lineDelay = rowDelay + 80;
  const lineDur = 600;
  const userDelay = rowDelay + lineDur + 60;

  return `
    <div style="padding:14px 0 12px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px">
        <span style="font-size:13px;color:var(--c-black);font-weight:500;flex-shrink:0">${metric.label}</span>
        <span style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums;font-weight:600;text-align:right">${fmtMmSs(metric.userValueSec)}<span style="font-size:11px;color:var(--c-muted);font-weight:500;margin-left:6px">${metric.nameCohort ? hyroxTierLabelIn(metric.fasterThanPct, metric.nameCohort) : fmtTier(metric.fasterThanPct)}</span></span>
      </div>
      <div style="position:relative;width:100%">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%;height:${H}px">
          <path d="${fillPath}" fill="${metric.fill}" stroke="none" class="hx-pd-fill" style="animation-delay:${fillDelay}ms"/>
          <path d="${linePath}" fill="none" stroke="${metric.accent}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"
                pathLength="1" class="hx-pd-line" style="animation-delay:${lineDelay}ms;animation-duration:${lineDur}ms"/>
          ${guideSvg}
          <line x1="${userX.toFixed(1)}" y1="6" x2="${userX.toFixed(1)}" y2="${H - 6}" stroke="${USER_LINE}" stroke-width="1.75" stroke-linecap="round" vector-effect="non-scaling-stroke"
                class="hx-pd-userline" style="animation-delay:${userDelay}ms"/>
        </svg>
        <!-- HTML overlay: user dot + (off-chart caret if needed). Avoids circles inside stretched SVGs. -->
        <div aria-hidden="true" class="hx-pd-userdot" style="position:absolute;left:${userPct.toFixed(2)}%;top:3px;width:6px;height:6px;border-radius:50%;background:${USER_LINE};transform:translate(-50%,0) scale(0);animation-delay:${userDelay}ms;pointer-events:none"></div>
        ${offChart
          ? `<div aria-hidden="true" style="position:absolute;left:${userValueSec < xMin ? '4px' : 'auto'};${userValueSec > xMax ? 'right:4px;' : ''}top:1px;font-size:10px;color:${USER_LINE};line-height:1;pointer-events:none">${userValueSec < xMin ? '◂' : '▸'}</div>`
          : ''
        }
        <div style="position:relative;width:100%;height:26px;margin-top:2px">
          ${pctLabelsHtml}
          <span class="hx-pd-pill" style="position:absolute;left:${pillLeft};top:13px;transform:${pillTransform};font-size:9px;font-weight:600;color:${USER_LINE};font-variant-numeric:tabular-nums;opacity:0;animation-delay:${userDelay + 80}ms">you</span>
        </div>
      </div>
    </div>
  `;
}

export function renderPercentileDistributions(prediction: HyroxPrediction): string {
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return '';

  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  // The target format's cohort: the prediction is in its terms (the pair's
  // time for doubles), so it is placed on the same table the curve is drawn
  // from, and the tier label and the curve agree.
  const cohort: HyroxResultsCohort = hyroxCohortForState(s);

  // Per-metric accents. Each row gets its own colour, mirroring the trend-card
  // pattern (Swim CSS / Bike FTP / Run LT / VO2max each have a distinct hue).
  // Run = teal mirrors the canonical Run LT colour.
  const rows: Array<{ label: string; metric: HyroxResultsMetric; sec: number; accent: string; fill: string }> = [
    { label: 'Total finish time', metric: 'total', sec: prediction.totalSec, accent: '#F472B6', fill: 'rgba(244,114,182,0.10)' },
    { label: 'Run total (8 × 1km)', metric: 'run_total', sec: prediction.runSec, accent: '#14B8A6', fill: 'rgba(20,184,166,0.10)' },
    { label: `Stations total (8 stations${isDoubles ? ', pair' : ''})`, metric: 'work_total', sec: prediction.stationsSec, accent: '#FB923C', fill: 'rgba(251,146,60,0.10)' },
    { label: 'RoxZone transitions', metric: 'roxzone', sec: prediction.roxzoneSec, accent: '#8B5CF6', fill: 'rgba(139,92,246,0.10)' },
  ];
  const metrics: MetricChart[] = [];
  for (const r of rows) {
    const table = hyroxResultsTable(r.metric, cohort);
    const fasterThanPct = hyroxFasterThanPct(r.metric, r.sec, cohort);
    if (!table || table.length < 3 || fasterThanPct == null) continue;
    // The total row names its cohort: the Stats rank line places the same
    // finish in an age group, so an unnamed "top 14%" read as a disagreement.
    metrics.push({ label: r.label, userValueSec: r.sec, realTable: table, fasterThanPct, accent: r.accent, fill: r.fill, ...(r.metric === 'total' ? { nameCohort: cohort } : {}) });
  }
  if (metrics.length === 0) return '';

  const subtitle = hyroxResultsCaption(cohort);

  return `
    <style>
      @keyframes hxPdLine {
        from { stroke-dashoffset: 1; }
        to   { stroke-dashoffset: 0; }
      }
      @keyframes hxPdFade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes hxPdPop  {
        0%   { transform: translate(-50%, 0) scale(0); opacity: 0; }
        70%  { transform: translate(-50%, 0) scale(1.25); opacity: 1; }
        100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
      }
      .hx-pd-line {
        stroke-dasharray: 1 0.0001;
        stroke-dashoffset: 1;
        animation: hxPdLine cubic-bezier(0.4,0,0.2,1) forwards;
      }
      .hx-pd-fill     { opacity: 0; animation: hxPdFade 600ms ease forwards; }
      .hx-pd-userline { opacity: 0; animation: hxPdFade 250ms ease forwards; }
      .hx-pd-userdot  { opacity: 0; animation: hxPdPop 350ms cubic-bezier(0.2,1.6,0.4,1) forwards; }
      .hx-pd-pill     { animation: hxPdFade 250ms ease forwards; }
    </style>
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;padding:18px 20px 14px;margin-bottom:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
      <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">Where you sit</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px;line-height:1.4">${subtitle}</div>
      ${metrics.map((m, i) => renderDistributionRow(m, i)).join('')}
    </div>
  `;
}
