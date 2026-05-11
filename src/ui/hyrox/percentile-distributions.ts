/**
 * HYROX Percentile distribution charts.
 *
 * For each headline metric (total time, run total, station total, RoxZone),
 * renders an asymmetric population PDF derived from the real cumulative-percentile
 * breakpoints in `src/data/hyrox-population-distributions.ts` (Kaggle dataset
 * `jgug05/hyrox-results`, S4–S6, ~92k finishers).
 *
 * Method: differentiate the cumulative-percentile table between adjacent
 * breakpoints to produce per-segment density (% per second), oversample with
 * linear interpolation, lightly smooth, then plot. This is the actual shape of
 * the population — no synthesised Gaussians, no fake noise. When the format
 * has no real table (e.g. pro_doubles), the fallback band-anchored synthetic is
 * used and labelled honestly.
 *
 * UX: glass card per UX_PATTERNS, HTML-positioned p25/p50/p75 reference lines,
 * single data colour (slate), user time inlined in the row header. No SVG text.
 *
 * Side: tracking. Used on forecast view as a transparency aid.
 */

import type { HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { STATION_SEED_TIMES_SEC, SEED_RUN_PACE_SEC_KM, SEED_ROXZONE_SEC } from '@/constants/hyrox-benchmarks';
import { getFinishTimePercentile } from '@/calculations/hyrox-population';
import { getState } from '@/state/store';
import {
  POPULATION_DATA_AVAILABLE,
  HYROX_TOTAL_PERCENTILE_TABLES,
  HYROX_RUN_PERCENTILE_TABLES,
  HYROX_STATIONS_PERCENTILE_TABLES,
  HYROX_ROXZONE_PERCENTILE_TABLES,
  LAST_VERIFIED_SEASON,
  lookupRealPercentile,
} from '@/data/hyrox-population-distributions';

type Format = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
type CumTable = Record<Format, Array<[number, number]>>;
type Breakpoints = Array<[number, number]>;

interface MetricChart {
  label: string;
  userValueSec: number;
  /** Real cumulative-percentile breakpoints (or null when format has no real data). */
  realTable: Breakpoints | null;
  /** Synthetic band anchors used when realTable is unavailable. */
  syntheticBands: number[];
  /** Pre-computed "faster than X%" position. */
  fasterThanPct: number;
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
// canonical trend cards (Swim CSS / Bike FTP / Run LT / VO2max) — one chart,
// one colour, all distinct. See `feedback_chart_palette` memory.
// Per-metric accents are assigned in `renderPercentileDistributions` below.
const USER_LINE = '#0F172A';         // slate-900 — primary text token

function fmtMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Convert "faster than X%" → human-readable tier label.
 *  fasterThan=99 → "top 1%" (you beat 99% of finishers).
 *  fasterThan=50 → "median".
 *  fasterThan=10 → "bottom 10%" (you beat only 10% of finishers).
 */
function fmtTier(fasterThanPct: number): string {
  const f = Math.max(0, Math.min(100, Math.round(fasterThanPct)));
  if (f >= 99) return 'top 1%';
  if (f >= 95) return 'top 5%';
  if (f >= 90) return 'top 10%';
  if (f >= 75) return `top ${100 - f}%`;
  if (f >= 55) return `top ${100 - f}%`;
  if (f >= 45) return 'median';
  if (f >= 25) return `bottom ${f}%`;
  if (f >= 10) return `bottom ${f}%`;
  if (f >= 5)  return 'bottom 10%';
  return 'bottom 5%';
}

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

/** Synthetic fallback density (when no real table for this format). */
function syntheticDensity(bandValues: number[], xMin: number, xMax: number): number[] {
  const sigma = Math.max(20, (bandValues[bandValues.length - 1] - bandValues[0]) * 0.07);
  const out: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const x = xMin + (i / (SAMPLE_COUNT - 1)) * (xMax - xMin);
    let sum = 0;
    for (const mu of bandValues) {
      const z = (x - mu) / sigma;
      sum += Math.exp(-0.5 * z * z);
    }
    out.push(sum / bandValues.length);
  }
  return out;
}

/** Build the SVG + HTML overlay for a single distribution row. */
function renderDistributionRow(metric: MetricChart, rowIndex: number): string {
  const { realTable, syntheticBands, userValueSec } = metric;
  const isReal = realTable !== null && realTable.length >= 3;

  // Visible x-range: slightly outside the data range to give the tails room.
  const dataMin = isReal ? realTable![0][0] : Math.min(...syntheticBands);
  const dataMax = isReal ? realTable![realTable!.length - 1][0] : Math.max(...syntheticBands);
  const pad = (dataMax - dataMin) * 0.04;
  const xMin = dataMin - pad;
  const xMax = dataMax + pad;
  const xRange = xMax - xMin;

  const samples = isReal
    ? densityFromCumTable(realTable!, xMin, xMax)
    : syntheticDensity(syntheticBands, xMin, xMax);
  const maxDensity = Math.max(...samples, 1e-6);

  // Build curve path.
  const pts = samples.map((d, i) => {
    const x = PAD_X + (i / (SAMPLE_COUNT - 1)) * usableW;
    const y = H - 6 - (d / maxDensity) * (H - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M${pts.join(' L')}`;
  const fillPath = `${linePath} L${PAD_X + usableW},${H - 6} L${PAD_X},${H - 6} Z`;

  // p25 / p50 / p75 guide x positions (only when real data available).
  const pctXs: Array<{ pct: number; x: number; label: string }> = [];
  if (isReal) {
    for (const [pct, label] of [[25, 'p25'], [50, 'p50'], [75, 'p75']] as const) {
      const t = timeAtCumPct(realTable!, pct);
      if (t == null) continue;
      const x = PAD_X + ((t - xMin) / xRange) * usableW;
      pctXs.push({ pct, x, label });
    }
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

  // Animation timing — staggered per row so curves draw L→R in sequence and
  // the user marker lands last with a small scale-up. Total wall time per row
  // is ~750ms; rows offset by 140ms.
  const rowDelay = rowIndex * 140;
  const fillDelay = rowDelay + 50;
  const lineDelay = rowDelay + 80;
  const lineDur = 600;
  const userDelay = rowDelay + lineDur + 60;

  return `
    <div style="padding:14px 0 12px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="font-size:13px;color:var(--c-black);font-weight:500">${metric.label}</span>
        <span style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums;font-weight:600">${fmtMmSs(metric.userValueSec)}<span style="font-size:11px;color:var(--c-muted);font-weight:500;margin-left:6px">${fmtTier(metric.fasterThanPct)}</span></span>
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
          ${isReal ? pctLabelsHtml : ''}
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

  const bands = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner', 'total_beginner'] as const;

  // Synthetic anchors by band (used as fallback when no real table for this format).
  const totalByBand = bands.map(b => {
    const stations = STATION_SEED_TIMES_SEC[b];
    const stationSum = Object.values(stations).reduce((s, v) => s + v, 0);
    return 8 * SEED_RUN_PACE_SEC_KM[b] + stationSum + SEED_ROXZONE_SEC[b];
  });
  const runByBand = bands.map(b => 8 * SEED_RUN_PACE_SEC_KM[b]);
  const stationsByBand = bands.map(b => Object.values(STATION_SEED_TIMES_SEC[b]).reduce((s, v) => s + v, 0));
  const roxzoneByBand = bands.map(b => SEED_ROXZONE_SEC[b]);

  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const doublesScale = isDoubles ? 0.5 : 1;
  const fmt: Format = (hx.format ?? 'open_singles') as Format;

  function realTableFor(t: CumTable): Breakpoints | null {
    if (!POPULATION_DATA_AVAILABLE) return null;
    const arr = t[fmt];
    return arr && arr.length >= 3 ? arr : null;
  }

  function fasterThanFromTable(t: CumTable, timeSec: number, syntheticAnchors: number[], fallbackPct?: number): number {
    if (POPULATION_DATA_AVAILABLE) {
      const cumPct = lookupRealPercentile(t, fmt, timeSec);
      if (cumPct != null) return Math.max(0, Math.min(100, 100 - cumPct));
    }
    if (fallbackPct != null) return fallbackPct;
    // Linear interpolation through synthetic band anchors at canonical percentile pegs.
    const anchors = [95, 85, 65, 40, 20, 5];
    if (timeSec <= syntheticAnchors[0]) return 100;
    if (timeSec >= syntheticAnchors[syntheticAnchors.length - 1]) return 0;
    for (let i = 1; i < syntheticAnchors.length; i++) {
      if (timeSec <= syntheticAnchors[i]) {
        const frac = (timeSec - syntheticAnchors[i - 1]) / (syntheticAnchors[i] - syntheticAnchors[i - 1]);
        return Math.round(anchors[i - 1] + frac * (anchors[i] - anchors[i - 1]));
      }
    }
    return 0;
  }

  // Per-metric accents — each row gets its own colour, mirroring the trend-card
  // pattern (Swim CSS / Bike FTP / Run LT / VO2max each have a distinct hue).
  // Run = teal mirrors the canonical Run LT colour.
  const metrics: MetricChart[] = [
    {
      label: 'Total finish time',
      userValueSec: prediction.totalSec,
      realTable: realTableFor(HYROX_TOTAL_PERCENTILE_TABLES),
      syntheticBands: totalByBand,
      fasterThanPct: fasterThanFromTable(
        HYROX_TOTAL_PERCENTILE_TABLES, prediction.totalSec, totalByBand,
        getFinishTimePercentile(prediction.totalSec, fmt),
      ),
      accent: '#F472B6',                           // pink-400 — the headline summary
      fill:   'rgba(244,114,182,0.10)',
    },
    {
      label: 'Run total (8 × 1km)',
      userValueSec: prediction.runSec,
      realTable: realTableFor(HYROX_RUN_PERCENTILE_TABLES),
      syntheticBands: runByBand,
      fasterThanPct: fasterThanFromTable(HYROX_RUN_PERCENTILE_TABLES, prediction.runSec, runByBand),
      accent: '#14B8A6',                           // teal-500 — mirrors canonical Run LT
      fill:   'rgba(20,184,166,0.10)',
    },
    {
      label: `Stations total${isDoubles ? ' (4 stations)' : ' (8 stations)'}`,
      userValueSec: prediction.stationsSec,
      realTable: realTableFor(HYROX_STATIONS_PERCENTILE_TABLES),
      syntheticBands: stationsByBand.map(v => v * doublesScale),
      fasterThanPct: fasterThanFromTable(
        HYROX_STATIONS_PERCENTILE_TABLES, prediction.stationsSec,
        stationsByBand.map(v => v * doublesScale),
      ),
      accent: '#FB923C',                           // orange-400 — HYROX's signature workout
      fill:   'rgba(251,146,60,0.10)',
    },
    {
      label: 'RoxZone transitions',
      userValueSec: prediction.roxzoneSec,
      realTable: realTableFor(HYROX_ROXZONE_PERCENTILE_TABLES),
      syntheticBands: roxzoneByBand.map(v => v * doublesScale),
      fasterThanPct: fasterThanFromTable(
        HYROX_ROXZONE_PERCENTILE_TABLES, prediction.roxzoneSec,
        roxzoneByBand.map(v => v * doublesScale),
      ),
      accent: '#8B5CF6',                             // violet-500 — distinct from the orange above; transitions read as the "connective tissue" of the race
      fill:   'rgba(139,92,246,0.10)',
    },
  ];

  const anyReal = metrics.some(m => m.realTable !== null);
  const finisherCountLabel = anyReal ? '89,868 finishers' : 'synthesised';
  const subtitle = anyReal
    ? `Live HYROX field. ${finisherCountLabel} across ${LAST_VERIFIED_SEASON.replace(/\s*\(.*\)\s*/, '').trim()}.`
    : 'Distributions synthesised from band seed times. Approximate.';

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
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Where you sit</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px;line-height:1.4">${subtitle}</div>
      ${metrics.map((m, i) => renderDistributionRow(m, i)).join('')}
    </div>
  `;
}
