/**
 * Shared Monte Carlo forecast-cone renderer.
 *
 * Plots a `ForecastSimResult` as an SVG fan with two nested confidence bands
 * (outer p10–p90 light, inner p25–p75 darker), a dashed median (p50) line,
 * an optional history overlay (actuals as a solid stroke), an optional goal
 * reference line, and a current-week marker.
 *
 * Used by both running (`race-forecast-view.ts`) and triathlon
 * (`triathlon/forecast-view.ts`) forecast surfaces. The simulation differs
 * per mode but the chart shape is identical.
 *
 * Pure function, no DOM side effects.
 */

import type { ForecastSimResult } from '@/calculations/race-forecast-simulation';
import { ft } from '@/utils/format';

export interface ConeHistoryPoint {
  week: number;
  timeSec: number;
}

const TEXT_M = '#0F172A';
const TEXT_L = '#94A3B8';
const CHART_STROKE = '#64748B';
const GOAL_STROKE  = '#C48A3A';

export function buildForecastCone(
  sim: ForecastSimResult,
  goalSec: number,
  history: ConeHistoryPoint[],
  totalWeeks: number,
  currentWeek: number,
): string {
  if (sim.weeks.length === 0) return '';

  // ── Geometry ──────────────────────────────────────────────────────────────
  const W = 320, H = 160, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const xOf = (week: number) => padL + ((week - 1) / Math.max(1, totalWeeks - 1)) * usableW;

  // Y-axis: derive from band extremes + goal + history.
  const allSecs: number[] = [];
  for (const w of sim.weeks) { allSecs.push(w.p10, w.p90); }
  for (const h of history) { allSecs.push(h.timeSec); }
  if (goalSec > 0) allSecs.push(goalSec);
  const minY = Math.min(...allSecs);
  const maxY = Math.max(...allSecs);
  const padY = Math.max(60, (maxY - minY) * 0.15);
  const yLo = minY - padY;
  const yHi = maxY + padY;
  const yRange = Math.max(1, yHi - yLo);
  const yOf = (sec: number) => H - ((sec - yLo) / yRange) * (H - 12) - 6;

  // ── Cone band paths ──────────────────────────────────────────────────────
  const buildBandPath = (loKey: 'p10' | 'p25', hiKey: 'p90' | 'p75'): string => {
    const top: [number, number][] = sim.weeks.map(w => [xOf(w.week), yOf(w[loKey])]);
    const bot: [number, number][] = sim.weeks.map(w => [xOf(w.week), yOf(w[hiKey])]);
    const fwd = top.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
    const rev = bot.slice().reverse().map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
    return `M ${fwd} L ${rev} Z`;
  };
  const outerBand = buildBandPath('p10', 'p90');
  const innerBand = buildBandPath('p25', 'p75');

  const medianPts: [number, number][] = sim.weeks.map(w => [xOf(w.week), yOf(w.p50)]);
  const medianPath = `M ${medianPts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;

  const actualPts: [number, number][] = history.map(p => [xOf(p.week), yOf(p.timeSec)]);
  const actualPath = actualPts.length >= 2
    ? `M ${actualPts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`
    : '';

  let goalLine = '';
  let goalLabelHtml = '';
  if (goalSec > 0) {
    const goalY = yOf(goalSec);
    goalLine = `<line x1="${padL}" y1="${goalY.toFixed(1)}" x2="${W - padR}" y2="${goalY.toFixed(1)}" stroke="${GOAL_STROKE}" stroke-width="1.25" opacity="0.7"/>`;
    goalLabelHtml = `<span style="position:absolute;top:${((goalY / H) * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:${GOAL_STROKE};line-height:1;font-variant-numeric:tabular-nums;font-weight:600">Goal ${ft(goalSec)}</span>`;
  }

  const startPt = medianPts[0];
  const currentMarker = `<circle cx="${startPt[0].toFixed(1)}" cy="${startPt[1].toFixed(1)}" r="3.5" fill="${CHART_STROKE}"/>`;

  // X-axis labels: Wk 1, intermediates every ~quarter, current bold, Wk total.
  const xLabels: Array<{ left: number; label: string; bold: boolean }> = [
    { left: xOf(1), label: 'Wk 1', bold: false },
  ];
  const tickStep = totalWeeks <= 12 ? 4 : totalWeeks <= 24 ? 8 : Math.ceil(totalWeeks / 4);
  for (let w = tickStep; w < totalWeeks; w += tickStep) {
    if (w !== currentWeek && w !== 1 && w !== totalWeeks) {
      xLabels.push({ left: xOf(w), label: `Wk ${w}`, bold: false });
    }
  }
  if (currentWeek > 1 && currentWeek < totalWeeks) {
    xLabels.push({ left: xOf(currentWeek), label: `Wk ${currentWeek}`, bold: true });
  }
  xLabels.push({ left: xOf(totalWeeks), label: `Wk ${totalWeeks}`, bold: false });
  const xLabelHtml = xLabels.map(l => {
    const leftPct = ((l.left / W) * 100).toFixed(1);
    return `<span style="position:absolute;left:${leftPct}%;transform:translateX(-50%);font-size:9px;color:${l.bold ? TEXT_M : TEXT_L};font-weight:${l.bold ? '600' : '400'};white-space:nowrap">${l.label}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:64px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        <path d="${outerBand}" fill="rgba(70,130,200,0.12)" stroke="none"/>
        <path d="${innerBand}" fill="rgba(70,130,200,0.22)" stroke="none"/>
        ${goalLine}
        <path d="${medianPath}" class="rfc-draw-proj" fill="none" stroke="${CHART_STROKE}" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="4 3" opacity="0.85"/>
        ${actualPath ? `<path d="${actualPath}" class="rfc-draw-actual" fill="none" stroke="${CHART_STROKE}" stroke-width="1.8" stroke-linejoin="round"/>` : ''}
        ${currentMarker}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${goalLabelHtml}</div>
    </div>
    <div style="position:relative;height:18px;margin-top:6px;padding-right:64px">${xLabelHtml}</div>`;
}
