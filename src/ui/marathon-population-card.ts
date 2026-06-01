/**
 * Marathon population distribution card. "Where you sit in the field".
 *
 * Renders a single PDF curve (derived from real cumulative-percentile
 * breakpoints) for the user's selected race × distance, with a vertical
 * marker at the user's predicted finish time and a "faster than X% of
 * finishers" headline.
 *
 * Mirrors the pattern in `src/ui/hyrox/percentile-distributions.ts` but
 * simplified to one metric. Slate-only colours per
 * `docs/UX_PATTERNS.md → Population Distribution Charts`.
 *
 * Returns '' when no population data is available for the venue or its
 * distance aggregate. Caller hides the card entirely.
 */

import type { SimulatorState } from '@/types/state';
import {
  getMarathonFinishPercentile,
  resolveMarathonDistribution,
  percentileHeadline,
  percentileLabel,
  venueCalibrationCaption,
  pooledMarathonFinisherSummary,
} from '@/calculations/marathon-population';
import { ft } from '@/utils/format';

// ── Design tokens ────────────────────────────────────────────────────────────
// Teal "race-prediction" palette. Mirrors buildLtTrendChart in
// triathlon/benchmark-charts.ts. Vertical gradient fill + layered stroke
// give the curve depth instead of reading as a flat wireframe.
const STROKE_LIGHT = '#5EEAD4';              // teal-300. Stroke highlight
const STROKE_MID   = '#14B8A6';              // teal-500. Stroke body
const STROKE_DARK  = '#0D9488';              // teal-600. Stroke shadow
const USER_LINE    = '#0F172A';              // slate-900. User vertical marker
const GUIDE_LINE   = 'rgba(15,23,42,0.08)';  // p25/p50/p75 dashed reference

const W = 320;
const H = 64;
const PAD_X = 14;
const USABLE_W = W - PAD_X * 2;
const SAMPLE_COUNT = 80;

// Distance → state.rd → 'marathon' | 'half' (single-metric card).
function distanceCategory(rd: SimulatorState['rd']): 'marathon' | 'half' | null {
  if (rd === 'marathon') return 'marathon';
  if (rd === 'half') return 'half';
  return null;
}

/** Convert a cumulative-percentile breakpoints table into a smooth PDF.
 *  Mirrors `densityFromCumTable` in hyrox/percentile-distributions.ts:
 *  differentiate per-segment density, pad tails to zero, oversample, box-smooth. */
function buildPdfSamples(table: Array<[number, number]>, xMin: number, xMax: number): number[] {
  const midSamples: Array<{ x: number; d: number }> = [];
  for (let i = 0; i < table.length - 1; i++) {
    const [t0, p0] = table[i];
    const [t1, p1] = table[i + 1];
    const dt = Math.max(0.001, t1 - t0);
    midSamples.push({ x: (t0 + t1) / 2, d: (p1 - p0) / dt });
  }
  midSamples.unshift({ x: xMin, d: 0 });
  midSamples.push({ x: xMax, d: 0 });

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
  return raw.map((_, i) => {
    let sum = 0; let count = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j >= 0 && j < raw.length) { sum += raw[j]; count++; }
    }
    return sum / count;
  });
}

/** Inverse lookup: find the finish time at a given cumulative percentile.
 *  Used for placing the p25/p50/p75 dashed guides. */
function timeAtPercentile(table: Array<[number, number]>, targetPct: number): number | null {
  if (!table || table.length === 0) return null;
  if (targetPct <= table[0][1]) return table[0][0];
  if (targetPct >= table[table.length - 1][1]) return table[table.length - 1][0];
  for (let i = 1; i < table.length; i++) {
    const [t0, p0] = table[i - 1];
    const [t1, p1] = table[i];
    if (targetPct <= p1) {
      const frac = (targetPct - p0) / (p1 - p0);
      return t0 + frac * (t1 - t0);
    }
  }
  return null;
}

/**
 * Render the population distribution card. Reads venue + distance + predicted
 * finish from state. Returns '' if no data is available. Caller hides the
 * card entirely.
 */
export function renderMarathonPopulationCard(s: SimulatorState): string {
  const distance = distanceCategory(s.rd);
  if (!distance) return '';

  const venueId = s.selectedMarathon?.id ?? null;
  const predictedSec = s.forecastTimeAdjusted ?? s.forecastTime ?? s.blendedRaceTimeSec ?? 0;
  if (!predictedSec || predictedSec <= 0) return '';

  const resolved = resolveMarathonDistribution(venueId, distance);
  if (!resolved) return '';

  const result = getMarathonFinishPercentile(venueId, distance, predictedSec);
  if (!result) return '';

  const { table, source } = resolved;
  const headline = percentileHeadline(result.fasterThanPct);
  const tier = percentileLabel(result.fasterThanPct);

  // Visible x-range: pad slightly outside the data so the curve fades at the edges.
  const dataMin = table[0][0];
  const dataMax = table[table.length - 1][0];
  const pad = (dataMax - dataMin) * 0.04;
  const xMin = dataMin - pad;
  const xMax = dataMax + pad;
  const xRange = xMax - xMin;

  const samples = buildPdfSamples(table, xMin, xMax);
  const maxDensity = Math.max(...samples, 1e-6);

  // Build the curve path.
  const pts = samples.map((d, i) => {
    const x = PAD_X + (i / (SAMPLE_COUNT - 1)) * USABLE_W;
    const y = H - 6 - (d / maxDensity) * (H - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M${pts.join(' L')}`;
  const fillPath = `${linePath} L${PAD_X + USABLE_W},${H - 6} L${PAD_X},${H - 6} Z`;

  // p25 / p50 / p75 reference markers.
  const guides: Array<{ x: number; label: string }> = [];
  for (const [pct, label] of [[25, 'p25'], [50, 'p50'], [75, 'p75']] as const) {
    const t = timeAtPercentile(table, pct);
    if (t == null) continue;
    const x = PAD_X + ((t - xMin) / xRange) * USABLE_W;
    guides.push({ x, label });
  }

  // User position with edge-aware clamping + off-chart indicator.
  const userClamped = Math.min(xMax, Math.max(xMin, predictedSec));
  const userX = PAD_X + ((userClamped - xMin) / xRange) * USABLE_W;
  const userPct = (userX / W) * 100;
  const offChart = predictedSec < xMin || predictedSec > xMax;

  // User y on the curve: interpolate the smoothed density at userX and convert
  // to the same y-mapping the curve uses (H - 6 - (d/maxDensity) * (H - 16)).
  const sampleFracIdx = Math.max(0, Math.min(SAMPLE_COUNT - 1,
    ((userX - PAD_X) / USABLE_W) * (SAMPLE_COUNT - 1)));
  const sLo = Math.floor(sampleFracIdx);
  const sHi = Math.min(SAMPLE_COUNT - 1, sLo + 1);
  const sFrac = sampleFracIdx - sLo;
  const dAtUser = samples[sLo] + sFrac * (samples[sHi] - samples[sLo]);
  const userY = H - 6 - (dAtUser / maxDensity) * (H - 16);

  // Edge-aware "you" pill positioning.
  const pillSide = userPct > 70 ? 'right' : userPct < 30 ? 'left' : 'center';
  const pillTransform = pillSide === 'right' ? 'translateX(-100%)'
    : pillSide === 'left'  ? 'translateX(0)'
    : 'translateX(-50%)';
  const pillLeft = pillSide === 'right' ? `${(userX - 4).toFixed(1)}px`
    : pillSide === 'left'  ? `${(userX + 4).toFixed(1)}px`
    : `${userX.toFixed(1)}px`;

  // Caption: venue-attributed when we have a real venue table, distance pool when aggregate.
  let caption: string;
  if (source === 'venue') {
    caption = venueCalibrationCaption(result) ?? '';
  } else if (distance === 'marathon') {
    const { count, venues } = pooledMarathonFinisherSummary();
    const venueList = venues.length > 1
      ? `${venues.slice(0, -1).join(', ')} and ${venues[venues.length - 1]}`
      : (venues[0] ?? '');
    caption = `Compared against ${count.toLocaleString()} real marathon finishers from ${venueList}.`;
  } else {
    caption = `Pooled from real finishes across all calibrated venues at this distance.`;
  }

  // Per-venue notes (e.g. Boston historical-only caveat) appended in a faint line.
  const notes = source === 'venue' && result.provenance?.notes
    ? `<div style="font-size:11px;color:var(--c-faint);margin-top:6px;line-height:1.5;font-style:italic">${result.provenance.notes}</div>`
    : '';

  const guideSvg = guides.map(g =>
    `<line x1="${g.x.toFixed(1)}" y1="6" x2="${g.x.toFixed(1)}" y2="${H - 6}" stroke="${GUIDE_LINE}" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`
  ).join('');

  const guideLabelsHtml = guides.map(g =>
    `<span style="position:absolute;left:${((g.x / W) * 100).toFixed(2)}%;top:0;transform:translateX(-50%);font-size:9px;color:var(--c-faint);font-variant-numeric:tabular-nums">${g.label}</span>`
  ).join('');

  // Unique gradient/filter ids so multiple cards on the page never collide.
  const uid = `mpc-${Math.random().toString(36).slice(2, 8)}`;

  return `
    <style>
      @keyframes ${uid}-line { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
      @keyframes ${uid}-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ${uid}-pop  {
        0%   { transform: translate(-50%, -50%) scale(0); opacity: 0; }
        70%  { transform: translate(-50%, -50%) scale(1.35); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      }
      @keyframes ${uid}-halo {
        0%   { transform: translate(-50%, -50%) scale(0); opacity: 0; }
        60%  { transform: translate(-50%, -50%) scale(1); opacity: 0.55; }
        100% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.35; }
      }
      .${uid}-line {
        stroke-dasharray: 1 0.0001;
        stroke-dashoffset: 1;
        animation: ${uid}-line 800ms cubic-bezier(0.4,0,0.2,1) forwards 100ms;
      }
      .${uid}-fill     { opacity: 0; animation: ${uid}-fade 700ms ease forwards 50ms; }
      .${uid}-glow     { opacity: 0; animation: ${uid}-fade 800ms ease forwards 150ms; }
      .${uid}-userline { opacity: 0; animation: ${uid}-fade 280ms ease forwards 820ms; }
      .${uid}-userdot  { opacity: 0; animation: ${uid}-pop 380ms cubic-bezier(0.2,1.6,0.4,1) forwards 820ms; }
      .${uid}-userhalo { opacity: 0; animation: ${uid}-halo 520ms cubic-bezier(0.2,1.4,0.4,1) forwards 780ms; }
      .${uid}-pill     { animation: ${uid}-fade 280ms ease forwards 920ms; }
    </style>
    <div class="rfc-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:14px">
      <div style="position:relative;background:rgba(255,255,255,0.72);backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%);border-radius:18px;padding:18px 20px 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.85),0 1px 2px rgba(15,23,42,0.04),0 8px 28px rgba(15,23,42,0.07);overflow:hidden">
        <div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 80% at 0% 0%, rgba(94,234,212,0.10) 0%, rgba(255,255,255,0) 55%);"></div>
        <div style="position:relative;display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:11px;color:var(--c-faint);font-weight:500">Where you sit</span>
          <span style="font-size:11px;color:var(--c-muted)">${tier}</span>
        </div>
        <div style="position:relative;font-size:15px;color:var(--c-black);font-weight:600;margin-bottom:4px">${headline}</div>
        <div style="position:relative;font-size:12px;color:var(--c-muted);margin-bottom:10px;line-height:1.5">${caption}</div>
        <div style="position:relative;width:100%">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%;height:${H}px;overflow:visible">
            <defs>
              <linearGradient id="${uid}-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="${STROKE_MID}" stop-opacity="0.32"/>
                <stop offset="55%"  stop-color="${STROKE_MID}" stop-opacity="0.12"/>
                <stop offset="100%" stop-color="${STROKE_MID}" stop-opacity="0.00"/>
              </linearGradient>
              <linearGradient id="${uid}-stroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stop-color="${STROKE_DARK}"/>
                <stop offset="50%"  stop-color="${STROKE_MID}"/>
                <stop offset="100%" stop-color="${STROKE_LIGHT}"/>
              </linearGradient>
              <linearGradient id="${uid}-userline" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="${USER_LINE}" stop-opacity="0.0"/>
                <stop offset="35%"  stop-color="${USER_LINE}" stop-opacity="0.7"/>
                <stop offset="100%" stop-color="${USER_LINE}" stop-opacity="1"/>
              </linearGradient>
            </defs>
            <path d="${fillPath}" fill="url(#${uid}-area)" stroke="none" class="${uid}-fill"/>
            <path d="${linePath}" fill="none" stroke="url(#${uid}-stroke)" stroke-width="3.4" stroke-opacity="0.22" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" class="${uid}-glow"/>
            <path d="${linePath}" fill="none" stroke="url(#${uid}-stroke)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" pathLength="1" class="${uid}-line"/>
            ${guideSvg}
            <line x1="${userX.toFixed(1)}" y1="${userY.toFixed(1)}" x2="${userX.toFixed(1)}" y2="${H - 6}" stroke="url(#${uid}-userline)" stroke-width="1.75" stroke-linecap="round" vector-effect="non-scaling-stroke" class="${uid}-userline"/>
          </svg>
          <div aria-hidden="true" class="${uid}-userhalo" style="position:absolute;left:${userPct.toFixed(2)}%;top:${userY.toFixed(1)}px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle, ${STROKE_LIGHT} 0%, rgba(20,184,166,0.35) 45%, rgba(20,184,166,0) 75%);transform:translate(-50%,-50%) scale(0);pointer-events:none"></div>
          <div aria-hidden="true" class="${uid}-userdot" style="position:absolute;left:${userPct.toFixed(2)}%;top:${userY.toFixed(1)}px;width:7px;height:7px;border-radius:50%;background:${USER_LINE};box-shadow:0 0 0 2px rgba(255,255,255,0.9),0 1px 4px rgba(15,23,42,0.4);transform:translate(-50%,-50%) scale(0);pointer-events:none"></div>
          ${offChart
            ? `<div aria-hidden="true" style="position:absolute;left:${predictedSec < xMin ? '4px' : 'auto'};${predictedSec > xMax ? 'right:4px;' : ''}top:1px;font-size:10px;color:${USER_LINE};line-height:1;pointer-events:none">${predictedSec < xMin ? '◂' : '▸'}</div>`
            : ''}
          <div style="position:relative;width:100%;height:26px;margin-top:2px">
            ${guideLabelsHtml}
            <span class="${uid}-pill" style="position:absolute;left:${pillLeft};top:13px;transform:${pillTransform};font-size:9px;font-weight:600;color:${USER_LINE};font-variant-numeric:tabular-nums;opacity:0">you · ${ft(predictedSec)}</span>
          </div>
        </div>
        ${notes}
      </div>
    </div>
  `;
}
