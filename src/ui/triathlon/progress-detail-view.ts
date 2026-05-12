/**
 * Triathlon Progress detail page — mirrors the running stats Progress
 * detail (`stats-view.ts → buildProgressDetailPage`) using tri data.
 *
 * Charts:
 *  1. Per-discipline fitness (CTL, swim/bike/run lines, daily-equivalent ÷7)
 *  2. Weekly km — Swim (own chart, shown as metres-aware)
 *  3. Weekly km — Bike (own chart)
 *  4. Weekly km — Run  (own chart)
 *  5. Weekly TSS per discipline (3 lines on one chart)
 *  6. Total weekly TSS (single line, sum across disciplines)
 *  7. FTP trend (line chart, fills from `tri.bike.ftpHistory`)
 *  8. CSS trend (line chart, fills from `tri.swim.cssHistory`)
 *
 * Range toggle: 4w / 12w / All / Forecast — Forecast extends km + TSS with
 * the planned `triWorkouts` from the current and future weeks (dashed
 * continuation, mirroring `buildForecastLoadChart`).
 *
 * TODO(triathlon-mvp): the forecast wiring depends on the still-evolving
 * triathlon plan generator. Once `plan_engine.triathlon.ts` stabilises and
 * the per-week swim/bike/run km estimates are consistent, re-verify the
 * forecast extension here (parseDistanceTokenKm + planned TSS sum).
 */

import { getState } from '@/state/store';
import type { SimulatorState, Week, Workout, GarminActual } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { DISCIPLINE_LABEL } from './colours';

// Blue/indigo spectrum — from the UX_PATTERNS zone colour scale.
// Swim = sky, Bike = blue, Run = indigo. All from the same tonal family.
const DISC_CHART = {
  swim: { stroke: '#38BDF8', fill: 'rgba(56,189,248,0.08)' },
  bike: { stroke: '#8B5CF6', fill: 'rgba(139,92,246,0.08)' },
  run:  { stroke: '#14B8A6', fill: 'rgba(20,184,166,0.08)' },
} as const;
import { sportToTransferSource } from '@/constants/transfer-matrix';
import { formatKm, type UnitPref } from '@/utils/format';
import {
  smoothAreaPath,
  chartEmptyState,
  animateChartDrawOn,
} from './benchmark-charts';
import { computeTriPlanAdherence } from '@/calculations/plan-adherence.triathlon';
import { isCyclingOnlyMode } from '@/calculations/cycling-mode';

type Discipline = 'swim' | 'bike' | 'run';
export type ProgressRange = '4w' | '12w' | 'all' | 'forecast';

// ────────────────────────────────────────────────────────────────────────────
// Navigation
// ────────────────────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../main-view').then(({ renderMainView }) => renderMainView());
  } else if (tab === 'forecast') {
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Activity classification
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify a synced activity into swim/bike/run/null. Honours `manualSport`
 * if the user has overridden it; otherwise falls back to the activity type
 * and finally the matched workout's discipline. Anything that doesn't map to
 * one of the three tri disciplines returns null and is excluded from the
 * progress chart per the user's "swim/bike/run only" requirement.
 */
function disciplineOf(actual: GarminActual): Discipline | null {
  // Manual override wins. SportKey uses 'swimming' / 'cycling' / 'running' so
  // map back to the tri-discipline shorthand used in this file.
  const manual = actual.manualSport;
  if (manual === 'swimming') return 'swim';
  if (manual === 'cycling') return 'bike';
  if (manual === 'running' || manual === 'extra_run') return 'run';
  const aType = actual.activityType ?? '';
  const mapped = sportToTransferSource(aType);
  if (mapped === 'swim' || mapped === 'bike' || mapped === 'run') return mapped;
  return null;
}

/** Walk every (deduped) actual on a week and call `fn` once per. */
function forEachActual(wk: Week, fn: (a: GarminActual) => void): void {
  const seen = new Set<string>();
  for (const a of Object.values(wk.garminActuals ?? {})) {
    if (a.garminId && seen.has(a.garminId)) continue;
    if (a.garminId) seen.add(a.garminId);
    fn(a);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-discipline weekly aggregates from history
// ────────────────────────────────────────────────────────────────────────────

interface WeekDisciplineSlice {
  km: { swim: number; bike: number; run: number };
  tss: { swim: number; bike: number; run: number };
}

function emptySlice(): WeekDisciplineSlice {
  return { km: { swim: 0, bike: 0, run: 0 }, tss: { swim: 0, bike: 0, run: 0 } };
}

/** iTRIMP → TSS-equivalent. Same conversion used everywhere else in the
 * codebase (1 hour at threshold ≈ 15000 iTRIMP ≈ 100 TSS). */
function iTrimpToTSS(iTrimp: number | null | undefined): number {
  if (iTrimp == null || iTrimp <= 0) return 0;
  return (iTrimp * 100) / 15000;
}

/** Build per-week per-discipline km + TSS slices across all `s.wks`. */
function buildHistorySlices(s: SimulatorState): WeekDisciplineSlice[] {
  const wks = s.wks ?? [];
  return wks.map(wk => {
    const slice = emptySlice();
    forEachActual(wk, a => {
      const d = disciplineOf(a);
      if (!d) return;
      slice.km[d] += a.distanceKm || 0;
      slice.tss[d] += iTrimpToTSS(a.iTrimp);
    });
    return slice;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Forecast — planned km + TSS from `triWorkouts`
// ────────────────────────────────────────────────────────────────────────────

/** Parse a distance token (e.g. "5km", "1500m", "2x500m") to km. Returns 0
 * when no recognisable distance is present. Used only for the forecast
 * extension when triWorkouts don't carry an `estimatedDistanceKm` field. */
function parseDistanceTokenKm(desc: string): number {
  if (!desc) return 0;
  // Multipliers like "5x400m" or "3x1km"
  const intervalKm = desc.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*km/i);
  if (intervalKm) return parseInt(intervalKm[1], 10) * parseFloat(intervalKm[2]);
  const intervalM = desc.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*m\b/i);
  if (intervalM) return (parseInt(intervalM[1], 10) * parseFloat(intervalM[2])) / 1000;
  // Plain "12km"
  const km = desc.match(/(\d+(?:\.\d+)?)\s*km/i);
  if (km) return parseFloat(km[1]);
  // Plain "1500m"
  const m = desc.match(/(\d+(?:\.\d+)?)\s*m\b/i);
  if (m) return parseFloat(m[1]) / 1000;
  return 0;
}

/** Map a Workout to per-discipline km + TSS contribution. Brick segments split. */
function plannedSliceForWorkout(w: Workout): WeekDisciplineSlice {
  const slice = emptySlice();

  // Brick — sum each segment as its own discipline
  if (w.brickSegments && Array.isArray(w.brickSegments)) {
    for (const seg of w.brickSegments) {
      const d = (seg.discipline as Discipline | undefined);
      if (d !== 'swim' && d !== 'bike' && d !== 'run') continue;
      const distKm = seg.distanceM != null
        ? seg.distanceM / 1000
        : 0;
      slice.km[d] += distKm;
      // TSS estimate: very rough — 1 TSS per minute at moderate intensity.
      // Forecast charts only need a comparable shape, not absolute calibration.
      const mins = seg.durationMin ?? 0;
      slice.tss[d] += mins; // 1 TSS/min ≈ Z2 endurance
    }
    return slice;
  }

  const d = (w.discipline as Discipline | undefined);
  if (d !== 'swim' && d !== 'bike' && d !== 'run') return slice;

  const distKm = parseDistanceTokenKm(w.d);
  slice.km[d] += distKm;

  // TSS estimate: prefer estimatedDurationMin × 1 TSS/min (Z2 baseline).
  const mins = w.estimatedDurationMin ?? 0;
  slice.tss[d] += mins;

  return slice;
}

function plannedSliceForWeek(wk: Week): WeekDisciplineSlice {
  const slice = emptySlice();
  for (const w of wk.triWorkouts ?? []) {
    const part = plannedSliceForWorkout(w);
    slice.km.swim += part.km.swim; slice.km.bike += part.km.bike; slice.km.run += part.km.run;
    slice.tss.swim += part.tss.swim; slice.tss.bike += part.tss.bike; slice.tss.run += part.tss.run;
  }
  return slice;
}

// ────────────────────────────────────────────────────────────────────────────
// Range slicing
// ────────────────────────────────────────────────────────────────────────────

interface RangedSeries {
  history: WeekDisciplineSlice[]; // chronological, oldest → newest
  forecast: WeekDisciplineSlice[]; // empty unless range==='forecast'
  /** Number of history weeks (for split-line drawing). */
  histLen: number;
}

function rangeSlice(s: SimulatorState, range: ProgressRange): RangedSeries {
  const all = buildHistorySlices(s);
  const wks = s.wks ?? [];
  const currentIdx = (s.w ?? 1) - 1;

  // Exclude the current in-progress week — showing a partially-complete week
  // (e.g. Monday morning with near-zero volume) makes the trend look like
  // training collapsed. Volume charts show completed weeks only.
  const completedCount = Math.max(0, Math.min(all.length, currentIdx));
  const histAll = all.slice(0, completedCount);

  if (range === 'forecast') {
    // Show last 8 completed history weeks + next 8 planned weeks.
    const past = histAll.slice(-8);
    const future: WeekDisciplineSlice[] = [];
    for (let i = currentIdx + 1; i < Math.min(wks.length, currentIdx + 1 + 8); i++) {
      future.push(plannedSliceForWeek(wks[i]));
    }
    return { history: past, forecast: future, histLen: past.length };
  }

  const sliceCount = range === '4w' ? 4 : range === '12w' ? 12 : undefined;
  const trimmed = sliceCount === undefined ? histAll : histAll.slice(-sliceCount);

  // Fall back to fitnessHistory km when plan-week actuals are missing or too
  // sparse to draw a chart (< 2 completed weeks, or no km in any discipline).
  const hasEnoughActualData = trimmed.length >= 2
    && trimmed.some(sl => sl.km.swim > 0 || sl.km.bike > 0 || sl.km.run > 0);
  if (!hasEnoughActualData) {
    const fh = s.triConfig?.fitnessHistory ?? [];
    const fhSliced = sliceCount ? fh.slice(-sliceCount) : fh;
    const hasHistoryKm = fhSliced.some(h => (h.swimKm ?? 0) > 0 || (h.bikeKm ?? 0) > 0 || (h.runKm ?? 0) > 0);
    console.log(`[tri:rangeSlice] plan actuals insufficient (${trimmed.length}w) — fh entries: ${fhSliced.length}, hasHistoryKm: ${hasHistoryKm}`);
    if (fhSliced.length >= 2 && hasHistoryKm) {
      const fhSlices: WeekDisciplineSlice[] = fhSliced.map(h => ({
        km:  { swim: h.swimKm ?? 0, bike: h.bikeKm ?? 0, run: h.runKm ?? 0 },
        tss: { swim: 0, bike: 0, run: 0 },
      }));
      return { history: fhSlices, forecast: [], histLen: fhSlices.length };
    }
  }

  return { history: trimmed, forecast: [], histLen: trimmed.length };
}

// ────────────────────────────────────────────────────────────────────────────
// SVG primitives — copied from running stats so the look is identical
// ────────────────────────────────────────────────────────────────────────────

function chartGridLines(maxVal: number, yOf: (v: number) => number, W: number, padL = 0, padR = 0): string {
  const step = maxVal <= 50 ? 10 : maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const lines: string[] = [];
  for (let v = step; v <= maxVal * 0.95; v += step) {
    const gy = yOf(v).toFixed(1);
    lines.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5"/>`);
  }
  return lines.join('');
}

function buildWeekLabels(n: number, labelStep = 1, futureCount = 0): string {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(monday.getDate() - dow);
  const histN = n - futureCount;
  return Array.from({ length: n }, (_, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    let d: Date;
    if (i < histN) {
      const weeksAgo = histN - 1 - i;
      d = new Date(monday); d.setDate(monday.getDate() - weeksAgo * 7);
    } else {
      const weeksAhead = i - histN + 1;
      d = new Date(monday); d.setDate(monday.getDate() + weeksAhead * 7);
    }
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const isNow = i === histN - 1;
    const isFuture = i >= histN;
    return `<span style="font-size:9px;color:${isNow ? 'var(--c-black)' : isFuture ? 'var(--c-faint)' : 'var(--c-faint)'};font-weight:${isNow ? '600' : '400'};font-style:${isFuture ? 'italic' : 'normal'}">${label}</span>`;
  }).join('');
}

// ────────────────────────────────────────────────────────────────────────────
// Range toggle pill
// ────────────────────────────────────────────────────────────────────────────

function buildRangeToggle(active: ProgressRange): string {
  const btn = (range: ProgressRange, label: string) => {
    const on = range === active;
    return `<button class="tri-progress-range-btn" data-range="${range}"
      style="padding:3px 8px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:${on ? 'var(--c-surface)' : 'transparent'};color:${on ? 'var(--c-black)' : 'var(--c-muted)'};box-shadow:${on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'}">${label}</button>`;
  };
  return `
    <div style="display:flex;background:rgba(0,0,0,0.05);border-radius:6px;padding:2px;gap:1px">
      ${btn('4w', '4w')}
      ${btn('12w', '12w')}
      ${btn('all', 'All')}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-discipline km chart — one chart for one discipline
// ────────────────────────────────────────────────────────────────────────────

function buildDisciplineKmChart(
  series: RangedSeries,
  discipline: Discipline,
  unitPref: UnitPref,
): string {
  const all = [...series.history, ...series.forecast].map(s => s.km[discipline]);
  const n = all.length;
  if (n < 2 || all.every(v => v === 0)) return chartEmptyState(55);

  const display = unitPref === 'mi' ? all.map(v => v * 0.621371) : all;
  const W = 320, H = 50, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...display, 1) * 1.15;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = display.map((v, i) => [xOf(i), yOf(v)]);

  // Split solid (history) from dashed (forecast) at series.histLen
  const histPts = pts.slice(0, series.histLen);
  const futPts = series.forecast.length > 0
    ? pts.slice(Math.max(0, series.histLen - 1)) // bridge with last hist point
    : [];

  const accent = DISC_CHART[discipline].stroke;
  const fill = DISC_CHART[discipline].fill;

  const histTopPath = smoothAreaPath(histPts);
  const histAreaPath = histPts.length >= 2
    ? `${histTopPath} L ${xOf(series.histLen - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`
    : '';

  const futTopPath = futPts.length >= 2 ? smoothAreaPath(futPts) : '';

  const tickStep = maxVal <= 20 ? 5 : maxVal <= 50 ? 10 : maxVal <= 100 ? 20 : 25;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep, series.forecast.length);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${histAreaPath ? `<path d="${histAreaPath}" fill="${fill}" stroke="none"/>` : ''}
        ${histTopPath ? `<path d="${histTopPath}" class="chart-draw" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
        ${futTopPath ? `<path d="${futTopPath}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.7" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-discipline TSS chart — three lines on one chart
// ────────────────────────────────────────────────────────────────────────────

function buildPerDisciplineTSSChart(series: RangedSeries, cycling = false): string {
  const all = [...series.history, ...series.forecast];
  const n = all.length;
  const swim = all.map(s => s.tss.swim);
  const bike = all.map(s => s.tss.bike);
  const run = all.map(s => s.tss.run);
  const allFlat = [...(cycling ? [] : swim), ...bike, ...(cycling ? [] : run)];

  if (n < 2 || allFlat.every(v => v === 0)) return chartEmptyState(75);

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...allFlat, 1) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const lineFor = (vals: number[], color: string, fill: string): string => {
    const histPts: [number, number][] = vals.slice(0, series.histLen).map((v, i) => [xOf(i), yOf(v)]);
    const futPts: [number, number][] = series.forecast.length > 0
      ? vals.slice(Math.max(0, series.histLen - 1)).map((v, i) => [xOf(i + series.histLen - 1), yOf(v)])
      : [];
    const lastHistX = histPts.length > 0 ? xOf(series.histLen - 1).toFixed(1) : '0';
    const firstHistX = histPts.length > 0 ? xOf(0).toFixed(1) : '0';
    const histTopPath = histPts.length >= 2 ? smoothAreaPath(histPts) : '';
    const histAreaPath = histTopPath
      ? `${histTopPath} L ${lastHistX} ${H} L ${firstHistX} ${H} Z`
      : '';
    const histAreaEl = histAreaPath
      ? `<path d="${histAreaPath}" fill="${fill}" stroke="none"/>`
      : '';
    const histLineEl = histTopPath
      ? `<path d="${histTopPath}" class="chart-draw" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
      : '';
    const futPath = futPts.length >= 2
      ? `<path d="${smoothAreaPath(futPts)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.7"/>`
      : '';
    return histAreaEl + histLineEl + futPath;
  };

  const tickStep = maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep, series.forecast.length);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${cycling ? '' : lineFor(swim, DISC_CHART.swim.stroke, DISC_CHART.swim.fill)}
        ${lineFor(bike, DISC_CHART.bike.stroke, DISC_CHART.bike.fill)}
        ${cycling ? '' : lineFor(run,  DISC_CHART.run.stroke,  DISC_CHART.run.fill)}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Total weekly TSS chart — single line, sum across disciplines
// ────────────────────────────────────────────────────────────────────────────

function buildTotalTSSChart(series: RangedSeries): string {
  const all = [...series.history, ...series.forecast];
  const n = all.length;
  const totals = all.map(s => s.tss.swim + s.tss.bike + s.tss.run);

  if (n < 2 || totals.every(v => v === 0)) return chartEmptyState(75);

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...totals, 1) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const stroke = '#0F172A';
  const fill = 'rgba(15,23,42,0.08)';

  const histPts: [number, number][] = totals.slice(0, series.histLen).map((v, i) => [xOf(i), yOf(v)]);
  const futPts: [number, number][] = series.forecast.length > 0
    ? totals.slice(Math.max(0, series.histLen - 1)).map((v, i) => [xOf(i + series.histLen - 1), yOf(v)])
    : [];
  const lastHistX = histPts.length > 0 ? xOf(series.histLen - 1).toFixed(1) : '0';
  const firstHistX = histPts.length > 0 ? xOf(0).toFixed(1) : '0';
  const histTopPath = histPts.length >= 2 ? smoothAreaPath(histPts) : '';
  const histAreaPath = histTopPath
    ? `${histTopPath} L ${lastHistX} ${H} L ${firstHistX} ${H} Z`
    : '';

  const tickStep = maxVal <= 200 ? 50 : maxVal <= 500 ? 100 : maxVal <= 1000 ? 200 : 500;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep, series.forecast.length);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${histAreaPath ? `<path d="${histAreaPath}" fill="${fill}" stroke="none"/>` : ''}
        ${histTopPath ? `<path d="${histTopPath}" class="chart-draw" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
        ${futPts.length >= 2 ? `<path d="${smoothAreaPath(futPts)}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.7" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-discipline CTL chart — pulled from `tri.fitnessHistory`
// ────────────────────────────────────────────────────────────────────────────

function buildPerDisciplineCTLChart(s: SimulatorState, range: ProgressRange): string {
  const tri = s.triConfig;
  const fh = tri?.fitnessHistory ?? [];
  if (fh.length < 2) return chartEmptyState(75, 'Fills in once you have 2+ weeks of activity');

  // Range trimming. Forecast falls back to "all" since CTL is backward-looking.
  const sliceCount = range === '4w' ? 4 : range === '12w' ? 12 : undefined;
  const sliced = sliceCount === undefined ? fh : fh.slice(-sliceCount);
  const n = sliced.length;
  if (n < 2) return chartEmptyState(75, 'Fills in once you have 2+ weeks of activity');

  // Display as TrainingPeaks daily-equivalent (÷7) — same convention as the
  // running stats CTL chart and the tri Load page.
  const cycling = isCyclingOnlyMode(s);
  const swim = sliced.map(h => h.swimCtl / 7);
  const bike = sliced.map(h => h.bikeCtl / 7);
  const run = sliced.map(h => h.runCtl / 7);
  const allFlat = [...(cycling ? [] : swim), ...bike, ...(cycling ? [] : run)];

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...allFlat, 1) * 1.2;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const linePath = (vals: number[]): string => {
    const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
    return smoothAreaPath(pts);
  };
  const areaPath = (vals: number[]): string => {
    const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
    const top = smoothAreaPath(pts);
    return `${top} L ${xOf(n - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;
  };

  const tickStep = maxVal <= 30 ? 10 : maxVal <= 60 ? 15 : maxVal <= 120 ? 30 : 50;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  // Build labels from the actual weekISO values stored in fitnessHistory.
  const labelStep = n > 12 ? 2 : 1;
  const labels = sliced.map((h, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const d = new Date(h.weekISO);
    const lbl = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const isNow = i === n - 1;
    return `<span style="font-size:9px;color:${isNow ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${isNow ? '600' : '400'}">${lbl}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${cycling ? '' : `<path d="${areaPath(swim)}" fill="${DISC_CHART.swim.fill}" stroke="none"/>`}
        <path d="${areaPath(bike)}" fill="${DISC_CHART.bike.fill}" stroke="none"/>
        ${cycling ? '' : `<path d="${areaPath(run)}"  fill="${DISC_CHART.run.fill}"  stroke="none"/>`}
        ${cycling ? '' : `<path d="${linePath(swim)}" class="chart-draw" fill="none" stroke="${DISC_CHART.swim.stroke}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`}
        <path d="${linePath(bike)}" class="chart-draw" fill="none" stroke="${DISC_CHART.bike.stroke}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${cycling ? '' : `<path d="${linePath(run)}"  class="chart-draw" fill="none" stroke="${DISC_CHART.run.stroke}"  stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}


// ────────────────────────────────────────────────────────────────────────────
// Stat list — per-discipline aggregates + adherence + time + total TSS
// ────────────────────────────────────────────────────────────────────────────

interface DisciplineAggregates {
  distanceKm: number;
  count: number;
  longestKm: number;
  durationSec: number;
  tss: number;
}

function emptyAggs(): DisciplineAggregates {
  return { distanceKm: 0, count: 0, longestKm: 0, durationSec: 0, tss: 0 };
}

/** Walk completed weeks (current plan + archived previous plans) accumulating
 * per-discipline distance / count / longest / time / TSS, sliced to the
 * requested range (4w / 12w / all). */
function aggregatePerDiscipline(s: SimulatorState, range: ProgressRange): { swim: DisciplineAggregates; bike: DisciplineAggregates; run: DisciplineAggregates } {
  const out = { swim: emptyAggs(), bike: emptyAggs(), run: emptyAggs() };
  const archivedWeeks = (s.previousPlanWks ?? []).flatMap(plan => plan.weeks as Week[]);
  const currentPlanCompleted = (s.wks ?? []).filter(wk => wk.w < (s.w ?? 1));
  const allCompleted = [...archivedWeeks, ...currentPlanCompleted];
  const sliceCount = range === '4w' ? 4 : range === '12w' ? 12 : undefined;
  const weeks = sliceCount === undefined ? allCompleted : allCompleted.slice(-sliceCount);
  for (const wk of weeks) {
    forEachActual(wk, a => {
      const d = disciplineOf(a);
      if (!d) return;
      const slot = out[d];
      const km = a.distanceKm || 0;
      slot.distanceKm += km;
      slot.count += 1;
      slot.longestKm = Math.max(slot.longestKm, km);
      slot.durationSec += a.durationSec || 0;
      slot.tss += iTrimpToTSS(a.iTrimp);
    });
  }
  return out;
}

function fmtHM(sec: number): string {
  if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function buildStatListCard(s: SimulatorState, unitPref: UnitPref, range: ProgressRange): string {
  const aggs = aggregatePerDiscipline(s, range);
  const totalSec = aggs.swim.durationSec + aggs.bike.durationSec + aggs.run.durationSec;
  const totalTSS = aggs.swim.tss + aggs.bike.tss + aggs.run.tss;
  const nWeeks = range === '4w' ? 4 : range === '12w' ? 12 : undefined;
  const adh = computeTriPlanAdherence(s, nWeeks);

  const row = (label: string, value: string) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--c-border)">
      <span style="font-size:13px;color:var(--c-muted)">${label}</span>
      <span style="font-size:13px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${value}</span>
    </div>`;
  const rowFinal = (label: string, value: string) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0">
      <span style="font-size:13px;color:var(--c-muted)">${label}</span>
      <span style="font-size:13px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${value}</span>
    </div>`;

  const fmtKm = (km: number) => km > 0 ? formatKm(km, unitPref) : '—';

  // Longest rows only render when there's something to show.
  const longestRows: string[] = [];
  if (aggs.swim.longestKm > 0) longestRows.push(row('Longest swim', fmtKm(aggs.swim.longestKm)));
  if (aggs.bike.longestKm > 0) longestRows.push(row('Longest ride', fmtKm(aggs.bike.longestKm)));
  if (aggs.run.longestKm > 0)  longestRows.push(row('Longest run',  fmtKm(aggs.run.longestKm)));

  const finalRows = [
    `${row('Plan adherence', adh.pct != null ? `${adh.pct}%` : '—')}`,
    `${row('Time active',    fmtHM(totalSec))}`,
    `${rowFinal('Total load', totalTSS > 0 ? `${Math.round(totalTSS).toLocaleString()} TSS` : '—')}`,
  ].join('');

  const cycling = isCyclingOnlyMode(s);
  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      ${cycling ? '' : row(`Swim · ${aggs.swim.count} session${aggs.swim.count === 1 ? '' : 's'}`, fmtKm(aggs.swim.distanceKm))}
      ${row(`Bike · ${aggs.bike.count} session${aggs.bike.count === 1 ? '' : 's'}`, fmtKm(aggs.bike.distanceKm))}
      ${cycling ? '' : row(`Run · ${aggs.run.count} session${aggs.run.count === 1 ? '' : 's'}`, fmtKm(aggs.run.distanceKm))}
      ${longestRows.join('')}
      ${finalRows}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase Timeline (mirrors running stats `buildPhaseTimeline`)
// ────────────────────────────────────────────────────────────────────────────

function buildPhaseTimeline(s: SimulatorState): string {
  const weeks = s.wks ?? [];
  if (weeks.length === 0) return '';

  const phaseText: Record<string, string> = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper', checkpoint: 'Checkpoint' };

  // Checkpoint weeks (double-periodization TT week) are visualised as their
  // own segment so the cycle-1 → cycle-2 boundary reads clearly. Underlying ph
  // stays 'peak' for engine purposes; only the grouping key changes here.
  const segKey = (i: number): string => (weeks[i].checkpoint ? 'checkpoint' : (weeks[i].ph || 'base'));

  type Seg = { phase: string; start: number; end: number };
  const segs: Seg[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const ph = segKey(i);
    if (!segs.length || segs[segs.length - 1].phase !== ph) segs.push({ phase: ph, start: i + 1, end: i + 1 });
    else segs[segs.length - 1].end = i + 1;
  }

  const total = weeks.length;
  const bars = segs.map((seg, si) => {
    const w = ((seg.end - seg.start + 1) / total * 100).toFixed(1);
    const label = phaseText[seg.phase] ?? seg.phase;
    const isCurr = s.w >= seg.start && s.w <= seg.end;
    const isPast = seg.end < s.w;
    const isFirst = si === 0;
    const isLast = si === segs.length - 1;
    // Active phase: accent blue (or teal for checkpoint). Past: faint slate. Future: light slate.
    const isCheckpointSeg = seg.phase === 'checkpoint';
    const activeColor = isCheckpointSeg ? 'rgba(20,184,166,0.85)' : 'var(--c-accent)';
    const color = isCurr ? activeColor : (isCheckpointSeg ? 'rgba(20,184,166,0.55)' : '#94A3B8');
    const opacity = isCurr ? 1 : isPast ? 0.3 : 0.5;
    const dotPct = seg.end > seg.start ? ((s.w - seg.start) / (seg.end - seg.start) * 100) : 50;
    return `
      <div style="display:flex;flex-direction:column;width:${w}%">
        <div style="height:8px;border-radius:${isFirst ? '4px 0 0 4px' : ''}${isLast ? '0 4px 4px 0' : ''};background:${color};opacity:${opacity};position:relative">
          ${isCurr ? `<div style="position:absolute;top:50%;left:${Math.max(8, Math.min(92, dotPct))}%;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:white;border:2px solid ${activeColor};box-shadow:0 1px 3px rgba(0,0,0,0.2)"></div>` : ''}
        </div>
        <span style="font-size:9px;color:${isCurr ? 'var(--c-black)' : 'var(--c-faint)'};margin-top:5px;font-weight:${isCurr ? '600' : '400'}">${label}</span>
      </div>`;
  }).join('');

  const currSeg = segs.find(seg => s.w >= seg.start && s.w <= seg.end);
  const currPhaseLabel = currSeg ? (phaseText[currSeg.phase] ?? currSeg.phase) + (currSeg.phase === 'checkpoint' ? ' week' : ' phase') : '';

  // Checkpoint caption: shown only when the current week is the cycle-1 TT week.
  // The TT result (a parkrun or solo 10K) flows through the standard activity
  // matcher → VDOT/CSS/FTP auto-refresh path.
  const isCheckpointWeek = weeks[s.w - 1]?.checkpoint === true;
  const checkpointCaption = isCheckpointWeek ? `
      <div style="margin-top:12px;padding:10px 12px;background:rgba(20,184,166,0.08);border-left:2px solid rgba(20,184,166,0.85);border-radius:4px;font-size:12px;line-height:1.4;color:var(--c-black)">
        Race a parkrun on Saturday or do a 10K time trial. The result recalibrates your run benchmark before cycle 2 begins.
      </div>` : '';

  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:12px">Phase Timeline</div>
      <div style="display:flex;width:100%;gap:2px;margin-bottom:6px">${bars}</div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--c-faint)">
        <span>Start</span>
        <span style="color:var(--c-black);font-weight:600">Week ${s.w} of ${s.tw ?? total} · ${currPhaseLabel}</span>
        <span>Race day</span>
      </div>${checkpointCaption}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Detail header (mirrors `buildDetailHeader` from running stats)
// ────────────────────────────────────────────────────────────────────────────

function buildDetailHeader(title: string): string {
  return `
    <div style="padding:max(16px, env(safe-area-inset-top)) 18px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--c-border)">
      <button id="tri-progress-back" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:20px;color:var(--c-black);font-family:var(--f);flex-shrink:0;margin-left:-8px">←</button>
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">${title}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Legend chip
// ────────────────────────────────────────────────────────────────────────────

function legendChip(d: Discipline): string {
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--c-muted)">
    <span style="width:14px;height:3px;background:${DISC_CHART[d].stroke};display:inline-block;border-radius:2px"></span>${DISCIPLINE_LABEL[d]}
  </span>`;
}

function legendRow(cycling = false): string {
  return `<div style="display:flex;gap:12px;margin-bottom:10px">${cycling ? '' : legendChip('swim')}${legendChip('bike')}${cycling ? '' : legendChip('run')}</div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Exported content block — used by the unified stats page
// ────────────────────────────────────────────────────────────────────────────

/** Returns the full progress section HTML (range toggle + all cards) without
 * any page wrapper, header, or tab bar. Suitable for embedding in the unified
 * triathlon stats page. */
export function buildProgressContent(s: SimulatorState, range: ProgressRange): string {
  const unitPref = s.unitPref ?? 'km';
  const series = rangeSlice(s, range);
  const cycling = isCyclingOnlyMode(s);

  const rangeNote = range === 'forecast'
    ? 'Solid line is what you have done. Dashed line is what your plan calls for over the next 8 weeks.'
    : range === '4w' ? 'Last 4 weeks.'
    : range === '12w' ? 'Last 12 weeks.'
    : 'All available history.';

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      ${buildRangeToggle(range)}
      <div style="font-size:10px;color:var(--c-faint);max-width:60%;text-align:right;line-height:1.4">${rangeNote}</div>
    </div>

    ${buildStatListCard(s, unitPref, range)}
    ${buildPhaseTimeline(s)}

    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Fitness by discipline (CTL)</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">42-day rolling load · daily-equivalent units</div>
      ${legendRow(cycling)}
      ${buildPerDisciplineCTLChart(s, range)}
    </div>

    ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.swim.stroke}"></span>
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Swim</span>
      </div>
      ${buildDisciplineKmChart(series, 'swim', unitPref)}
    </div>`}

    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.bike.stroke}"></span>
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Bike</span>
      </div>
      ${buildDisciplineKmChart(series, 'bike', unitPref)}
    </div>

    ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.run.stroke}"></span>
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Run</span>
      </div>
      ${buildDisciplineKmChart(series, 'run', unitPref)}
    </div>`}

    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Weekly load (TSS) by discipline</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Real physiological load per session · iTRIMP-derived</div>
      ${legendRow(cycling)}
      ${buildPerDisciplineTSSChart(series, cycling)}
    </div>

    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Total weekly load (TSS)</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Sum across${cycling ? ' bike' : ' swim, bike, and run'} · iTRIMP-derived</div>
      ${buildTotalTSSChart(series)}
    </div>
  `;
}

// ────────────────────────────────────────────────────────────────────────────
// Build full detail page
// ────────────────────────────────────────────────────────────────────────────

function buildPage(s: SimulatorState, range: ProgressRange): string {
  const unitPref = s.unitPref ?? 'km';
  const series = rangeSlice(s, range);
  const cycling = isCyclingOnlyMode(s);

  const rangeNote = range === 'forecast'
    ? 'Solid line is what you have done. Dashed line is what your plan calls for over the next 8 weeks.'
    : range === '4w' ? 'Last 4 weeks.'
    : range === '12w' ? 'Last 12 weeks.'
    : 'All available history.';

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Progress')}

      <div id="tri-progress-content" style="max-width:600px;margin:0 auto;padding:12px 18px 80px;overflow-y:auto">

        <!-- Range toggle + caption -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          ${buildRangeToggle(range)}
          <div style="font-size:10px;color:var(--c-faint);max-width:60%;text-align:right;line-height:1.4">${rangeNote}</div>
        </div>

        <!-- Stat list — per-discipline aggregates + adherence + time + total TSS -->
        ${buildStatListCard(s, unitPref, range)}

        <!-- Phase Timeline -->
        ${buildPhaseTimeline(s)}

        <!-- Per-discipline fitness (CTL) -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Fitness by discipline (CTL)</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">42-day rolling load · daily-equivalent units</div>
          ${legendRow(cycling)}
          ${buildPerDisciplineCTLChart(s, range)}
        </div>

        <!-- Weekly km — Swim -->
        ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.swim.stroke}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Swim</span>
          </div>
          ${buildDisciplineKmChart(series, 'swim', unitPref)}
        </div>`}

        <!-- Weekly km — Bike -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.bike.stroke}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Bike</span>
          </div>
          ${buildDisciplineKmChart(series, 'bike', unitPref)}
        </div>

        <!-- Weekly km — Run -->
        ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISC_CHART.run.stroke}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Run</span>
          </div>
          ${buildDisciplineKmChart(series, 'run', unitPref)}
        </div>`}

        <!-- Weekly TSS by discipline -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Weekly load (TSS) by discipline</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Real physiological load per session · iTRIMP-derived</div>
          ${legendRow(cycling)}
          ${buildPerDisciplineTSSChart(series, cycling)}
        </div>

        <!-- Total weekly TSS -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Total weekly load (TSS)</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Sum across${cycling ? ' bike' : ' swim, bike, and run'} · iTRIMP-derived</div>
          ${buildTotalTSSChart(series)}
        </div>

      </div>
    </div>
    ${renderTabBar('stats')}
  `;
}

// ────────────────────────────────────────────────────────────────────────────
// Public render + wiring
// ────────────────────────────────────────────────────────────────────────────

let _activeRange: ProgressRange = '12w';

export function renderTriProgressDetailView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  if (!s.triConfig) return;
  container.innerHTML = buildPage(s, _activeRange);
  animateChartDrawOn();
  wireTabBarHandlers(navigateTab);

  document.getElementById('tri-progress-back')?.addEventListener('click', () => {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  });

  wireProgressRangeButtons(s);
}

function wireProgressRangeButtons(s: SimulatorState): void {
  document.querySelectorAll<HTMLButtonElement>('.tri-progress-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range as ProgressRange;
      if (!r || r === _activeRange) return;
      _activeRange = r;
      const content = document.getElementById('tri-progress-content');
      if (content) {
        content.innerHTML = buildProgressContent(s, _activeRange);
        animateChartDrawOn();
        wireProgressRangeButtons(s);
      } else {
        renderTriProgressDetailView();
      }
    });
  });
}

