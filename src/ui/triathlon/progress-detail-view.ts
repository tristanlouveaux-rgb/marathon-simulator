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
 *  6. FTP trend (line chart, fills from `tri.bike.ftpHistory`)
 *  7. CSS trend (line chart, fills from `tri.swim.cssHistory`)
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
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { sportToTransferSource } from '@/constants/transfer-matrix';
import { formatKm, type UnitPref } from '@/utils/format';

type Discipline = 'swim' | 'bike' | 'run';
type ProgressRange = '4w' | '12w' | 'all' | 'forecast';

// ────────────────────────────────────────────────────────────────────────────
// Navigation
// ────────────────────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('../record-view').then(({ renderRecordView }) => renderRecordView());
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

  // History up to and including the current week.
  const histAll = all.slice(0, Math.min(all.length, currentIdx + 1));

  if (range === 'forecast') {
    // Show last 8 history weeks + next 8 planned weeks.
    const past = histAll.slice(-8);
    const future: WeekDisciplineSlice[] = [];
    for (let i = currentIdx + 1; i < Math.min(wks.length, currentIdx + 1 + 8); i++) {
      future.push(plannedSliceForWeek(wks[i]));
    }
    return { history: past, forecast: future, histLen: past.length };
  }

  const sliceCount = range === '4w' ? 4 : range === '12w' ? 12 : undefined;
  const trimmed = sliceCount === undefined ? histAll : histAll.slice(-sliceCount);
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

function smoothAreaPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  return `M ${pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;
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

function chartEmptyState(height = 65, msg = 'Not enough data yet', sub = 'Needs at least 2 weeks'): string {
  return `<div style="height:${height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(0,0,0,0.02);border-radius:10px">
    <div style="font-size:13px;color:var(--c-muted);text-align:center">${msg}</div>
    <div style="font-size:11px;color:var(--c-faint);text-align:center">${sub}</div>
  </div>`;
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
      ${btn('forecast', 'Forecast')}
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

  const accent = DISCIPLINE_COLOURS[discipline].accent;
  const fill = DISCIPLINE_COLOURS[discipline].badge;

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
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${histAreaPath ? `<path d="${histAreaPath}" fill="${fill}" stroke="none"/>` : ''}
        ${histTopPath ? `<path d="${histTopPath}" class="chart-draw" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>` : ''}
        ${futTopPath ? `<path d="${futTopPath}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.7"/>` : ''}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-discipline TSS chart — three lines on one chart
// ────────────────────────────────────────────────────────────────────────────

function buildPerDisciplineTSSChart(series: RangedSeries): string {
  const all = [...series.history, ...series.forecast];
  const n = all.length;
  const swim = all.map(s => s.tss.swim);
  const bike = all.map(s => s.tss.bike);
  const run = all.map(s => s.tss.run);
  const allFlat = [...swim, ...bike, ...run];

  if (n < 2 || allFlat.every(v => v === 0)) return chartEmptyState(75);

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...allFlat, 1) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const lineFor = (vals: number[], color: string, dashed: boolean): string => {
    const histPts: [number, number][] = vals.slice(0, series.histLen).map((v, i) => [xOf(i), yOf(v)]);
    const futPts: [number, number][] = series.forecast.length > 0
      ? vals.slice(Math.max(0, series.histLen - 1)).map((v, i) => [xOf(i + series.histLen - 1), yOf(v)])
      : [];
    const histPath = histPts.length >= 2
      ? `<path d="${smoothAreaPath(histPts)}" class="chart-draw" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
      : '';
    const futPath = futPts.length >= 2
      ? `<path d="${smoothAreaPath(futPts)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.7"/>`
      : '';
    return histPath + futPath;
    void dashed; // currently unused, kept for API symmetry
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
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${lineFor(swim, DISCIPLINE_COLOURS.swim.accent, false)}
        ${lineFor(bike, DISCIPLINE_COLOURS.bike.accent, false)}
        ${lineFor(run,  DISCIPLINE_COLOURS.run.accent,  false)}
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
  const swim = sliced.map(h => h.swimCtl / 7);
  const bike = sliced.map(h => h.bikeCtl / 7);
  const run = sliced.map(h => h.runCtl / 7);
  const allFlat = [...swim, ...bike, ...run];

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...allFlat, 1) * 1.2;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const linePath = (vals: number[]): string => {
    const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
    return smoothAreaPath(pts);
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
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${linePath(swim)}" class="chart-draw" fill="none" stroke="${DISCIPLINE_COLOURS.swim.accent}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${linePath(bike)}" class="chart-draw" fill="none" stroke="${DISCIPLINE_COLOURS.bike.accent}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${linePath(run)}"  class="chart-draw" fill="none" stroke="${DISCIPLINE_COLOURS.run.accent}"  stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Benchmark trend charts — FTP / CSS over time
// ────────────────────────────────────────────────────────────────────────────

interface BenchmarkSample { date: string; value: number }

function buildBenchmarkTrendChart(
  samples: BenchmarkSample[],
  accent: string,
  fill: string,
  unitSuffix: string,
  inverted = false,
): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far — needs 2+');
  }

  // Sort chronologically.
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const n = sorted.length;
  const vals = sorted.map(s => s.value);
  const W = 320, H = 50, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(1, maxV - minV);
  const padding = span * 0.15;
  const lo = minV - padding;
  const hi = maxV + padding;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => {
    const norm = (v - lo) / (hi - lo);
    const flipped = inverted ? norm : 1 - norm;
    return Math.max(2, flipped * (H - 4) + 2);
  };

  const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const labelStep = n > 6 ? Math.ceil(n / 6) : 1;
  const labels = sorted.map((s, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const d = new Date(s.date);
    const lbl = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n - 1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n - 1 ? '600' : '400'}">${lbl}</span>`;
  }).join('');

  const latest = sorted[n - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const deltaSign = delta >= 0 ? '+' : '';
  const better = inverted ? delta < 0 : delta > 0;
  const deltaCol = Math.abs(delta) < 0.01 ? 'var(--c-muted)' : (better ? '#5a8050' : '#c06a50');

  return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${latest.toFixed(unitSuffix === 'W' ? 0 : 1)}${unitSuffix ? `<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">${unitSuffix}</span>` : ''}</span>
        <span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${deltaSign}${delta.toFixed(unitSuffix === 'W' ? 0 : 1)} since first sample</span>
      </div>
      <div style="position:relative">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
          <path d="${areaPath}" fill="${fill}" stroke="none"/>
          <path d="${topPath}" class="chart-draw" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
      </div>
    </div>`;
}

function fmtCssPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildCssTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far — needs 2+');
  }
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const better = delta < 0; // CSS lower = faster = better
  const deltaCol = Math.abs(delta) < 0.5 ? 'var(--c-muted)' : (better ? '#5a8050' : '#c06a50');
  const sign = delta >= 0 ? '+' : '';
  const inner = buildBenchmarkTrendChart(samples, DISCIPLINE_COLOURS.swim.accent, DISCIPLINE_COLOURS.swim.badge, '/100m', /*inverted*/ true)
    // Replace the headline number/delta with pace-formatted versions.
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtCssPace(latest)}<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">/100m</span></span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${sign}${delta.toFixed(1)}s since first sample</span>`);
  return inner;
}

// ────────────────────────────────────────────────────────────────────────────
// All-time tile
// ────────────────────────────────────────────────────────────────────────────

function buildAllTimeTile(s: SimulatorState, unitPref: UnitPref): string {
  const wks = s.wks ?? [];
  const totals = { swim: 0, bike: 0, run: 0 };
  const counts = { swim: 0, bike: 0, run: 0 };
  for (const wk of wks) {
    forEachActual(wk, a => {
      const d = disciplineOf(a);
      if (!d) return;
      totals[d] += a.distanceKm || 0;
      counts[d] += 1;
    });
  }
  const total = totals.swim + totals.bike + totals.run;
  if (total === 0) return '';

  const cell = (d: Discipline) => `
    <div style="flex:1;padding:10px 12px;background:rgba(0,0,0,0.02);border-radius:8px;border:1px solid var(--c-border)">
      <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${DISCIPLINE_LABEL[d]}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:4px">
        <span style="font-size:15px;font-weight:600;color:${DISCIPLINE_COLOURS[d].accent};font-variant-numeric:tabular-nums">${formatKm(totals[d], unitPref)}</span>
        <span style="font-size:10px;color:var(--c-muted)">${counts[d]} session${counts[d] === 1 ? '' : 's'}</span>
      </div>
    </div>`;

  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#0F172A;margin-bottom:10px">Lifetime totals</div>
      <div style="display:flex;gap:8px">
        ${cell('swim')}
        ${cell('bike')}
        ${cell('run')}
      </div>
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
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--c-muted)">
    <span style="width:8px;height:2px;background:${DISCIPLINE_COLOURS[d].accent};display:inline-block;border-radius:1px"></span>${DISCIPLINE_LABEL[d]}
  </span>`;
}

function legendRow(): string {
  return `<div style="display:flex;gap:12px;margin-bottom:10px">${legendChip('swim')}${legendChip('bike')}${legendChip('run')}</div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Build full detail page
// ────────────────────────────────────────────────────────────────────────────

function buildPage(s: SimulatorState, range: ProgressRange): string {
  const unitPref = s.unitPref ?? 'km';
  const series = rangeSlice(s, range);
  const tri = s.triConfig;
  const ftpHistory = tri?.bike?.ftpHistory ?? [];
  const cssHistory = tri?.swim?.cssHistory ?? [];

  const rangeNote = range === 'forecast'
    ? 'Solid line is what you have done. Dashed line is what your plan calls for over the next 8 weeks.'
    : range === '4w' ? 'Last 4 weeks.'
    : range === '12w' ? 'Last 12 weeks.'
    : 'All available history.';

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Progress')}

      <div style="padding:12px 18px 80px;overflow-y:auto">

        <!-- Range toggle + caption -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          ${buildRangeToggle(range)}
          <div style="font-size:10px;color:var(--c-faint);max-width:60%;text-align:right;line-height:1.4">${rangeNote}</div>
        </div>

        <!-- Lifetime totals tile -->
        ${buildAllTimeTile(s, unitPref)}

        <!-- Per-discipline fitness (CTL) -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Fitness by discipline (CTL)</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">42-day rolling load · daily-equivalent units</div>
          ${legendRow()}
          ${buildPerDisciplineCTLChart(s, range)}
        </div>

        <!-- Weekly km — Swim -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISCIPLINE_COLOURS.swim.accent}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Swim</span>
          </div>
          ${buildDisciplineKmChart(series, 'swim', unitPref)}
        </div>

        <!-- Weekly km — Bike -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISCIPLINE_COLOURS.bike.accent}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Bike</span>
          </div>
          ${buildDisciplineKmChart(series, 'bike', unitPref)}
        </div>

        <!-- Weekly km — Run -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="width:8px;height:8px;border-radius:2px;background:${DISCIPLINE_COLOURS.run.accent}"></span>
            <span style="font-size:12px;font-weight:600;color:var(--c-black)">Weekly volume — Run</span>
          </div>
          ${buildDisciplineKmChart(series, 'run', unitPref)}
        </div>

        <!-- Weekly TSS by discipline -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Weekly load (TSS) by discipline</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Real physiological load per session · iTRIMP-derived</div>
          ${legendRow()}
          ${buildPerDisciplineTSSChart(series)}
        </div>

        <!-- FTP trend -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">FTP trend</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Functional threshold power · auto-derived from rides + your tests</div>
          ${buildBenchmarkTrendChart(ftpHistory, DISCIPLINE_COLOURS.bike.accent, DISCIPLINE_COLOURS.bike.badge, 'W', /*inverted*/ false)}
        </div>

        <!-- CSS trend -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">CSS trend</div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Critical swim speed · faster pace = lower number</div>
          ${buildCssTrendChart(cssHistory)}
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

  document.querySelectorAll<HTMLButtonElement>('.tri-progress-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range as ProgressRange;
      if (!r) return;
      _activeRange = r;
      renderTriProgressDetailView();
    });
  });
}

// Local copy of the chart-draw animation helper used by running stats. Kept
// inline so this file has no cross-mode dependency back into stats-view.ts.
function animateChartDrawOn(): void {
  requestAnimationFrame(() => {
    document.querySelectorAll<SVGPathElement>('path.chart-draw').forEach(path => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s ease-out';
      path.style.strokeDashoffset = '0';
      const clear = () => {
        path.style.strokeDasharray = '';
        path.style.strokeDashoffset = '';
        path.removeEventListener('transitionend', clear);
      };
      path.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 1400);
    });
  });
}
