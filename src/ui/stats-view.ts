/**
 * Stats tab — redesigned 2026-03-19.
 * Three-pillar architecture: Progress · Fitness · Readiness
 * Opening screen: one card per pillar + flat Summary section.
 * Each card taps into a single-scroll detail page (no tabs inside).
 */

import { getState } from '@/state';
import type { SimulatorState, PhysiologyDayEntry } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { getPhysiologySource } from '@/data/sources';
import { fp, ft, formatKm, fmtDateUK, type UnitPref } from '@/utils/format';
import { computeWeekTSS, computeWeekRawTSS, computeFitnessModel, computeACWR, TIER_ACWR_CONFIG, computePlannedWeekTSS, computeSameSignalTSB, type FitnessMetrics } from '@/calculations/fitness-model';
import { generateWeekWorkouts, calculateWorkoutLoad } from '@/workouts';
import { fetchExtendedHistory } from '@/data/stravaSync';
import { vt } from '@/calculations/vdot';
import { blendPredictions } from '@/calculations/predictions';
import { computePredictionInputs } from '@/calculations/prediction-inputs';
import { getEffectiveVdot } from '@/calculations/effective-vdot';
import { computeRecoveryScore, computeReadiness, readinessColor, drivingSignalLabel } from '@/calculations/readiness';
import { getSleepInsight, sleepScoreColor, buildBarChart, buildSleepBarChart, fmtSleepDuration, getSleepBank, deriveSleepTarget } from '@/calculations/sleep-insights';
import { renderSleepView } from '@/ui/sleep-view';
import { computePlanAdherence } from '@/calculations/plan-adherence';
import { isSleepDataPending } from '@/data/sleepPoller';
import { heatAdjust } from '@/calculations/daily-coach';

// ---------------------------------------------------------------------------
// Navigation

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ---------------------------------------------------------------------------
// Chart design tokens (UX_PATTERNS § Charts)

const CHART_STROKE = '#64748B';         // muted slate — line charts
const CHART_FILL   = 'rgba(100,116,139,0.12)'; // area fill under line
const CHART_FILL_LIGHT = 'rgba(100,116,139,0.06)'; // forecast/projected area fill
const CHART_STROKE_DIM = 'rgba(100,116,139,0.5)'; // forecast/dashed lines

/** Trigger draw-on animation for all .chart-draw paths in the DOM. */
function animateChartDrawOn(): void {
  requestAnimationFrame(() => {
    document.querySelectorAll<SVGPathElement>('path.chart-draw').forEach(path => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      // Force reflow so the initial state is applied before transition
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s ease-out';
      path.style.strokeDashoffset = '0';
      // Clear dasharray once the draw-on finishes. `vector-effect="non-scaling-stroke"`
      // makes dash-array render in screen pixels (not user units), so on wide viewports
      // a stale dasharray creates visible gaps. Use `transitionend` with a timeout
      // fallback in case the listener misses.
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

/** Subtle horizontal grid lines for charts (UX_PATTERNS § Charts). */
function chartGridLines(
  maxVal: number,
  yOf: (v: number) => number,
  W: number,
  padL = 0,
  padR = 0,
): string {
  const step = maxVal <= 50 ? 10 : maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const lines: string[] = [];
  for (let v = step; v <= maxVal * 0.95; v += step) {
    const gy = yOf(v).toFixed(1);
    lines.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5"/>`);
  }
  return lines.join('');
}

// ---------------------------------------------------------------------------
// Data helpers

function computeCurrentVDOT(s: SimulatorState): number {
  return getEffectiveVdot(s);
}

/**
 * Find the most recent running garminActual and return it as a RecentRun.
 * Keeps s.rec fresh from actual Strava/Garmin data rather than stale onboarding
 * input. No HR scaling — the blend engine already handles sub-race efforts via
 * its PB/LT/VO2 weighting and recency decay.
 */
/**
 * Extract all running activities from garminActuals across the available plan
 * weeks, normalised to the shape `computePredictionInputs` expects. Filters
 * non-running types here so the pure module doesn't need to know about our
 * internal activityType strings.
 */
function collectRunActivities(s: SimulatorState): Array<{ startTime: string | Date; distKm: number; durSec: number; activityName?: string; activityType?: string }> {
  const runs: Array<{ startTime: string | Date; distKm: number; durSec: number; activityName?: string; activityType?: string }> = [];
  const weeks = s.wks ?? [];
  for (const wk of weeks) {
    const actuals = (wk as any).garminActuals as Record<string, any> | undefined;
    if (!actuals) continue;
    for (const val of Object.values(actuals)) {
      const a = val as any;
      const aType = (a.activityType || '').toUpperCase();
      if (aType !== 'RUNNING' && !aType.includes('RUN')) continue;
      if (!a.startTime || !a.distanceKm || !a.durationSec) continue;
      runs.push({
        startTime: a.startTime,
        distKm: a.distanceKm,
        durSec: a.durationSec,
        activityName: a.activityName,
        activityType: a.activityType,
      });
    }
  }
  return runs;
}

function last7(
  history: PhysiologyDayEntry[] | undefined,
  field: keyof PhysiologyDayEntry,
): number[] {
  if (!history || history.length === 0) return [];
  return history.slice(-7)
    .map(d => d[field] as number | undefined)
    .filter((v): v is number => typeof v === 'number');
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// Plan workout helpers

function parseDistanceKm(d: string): number {
  if (!d) return 0;
  if (/^\d+min\s/i.test(d) && !d.includes('km')) return 0;
  const simple = d.match(/^(\d+(?:\.\d+)?)\s*km/i);
  if (simple) return parseFloat(simple[1]);
  const intKm = d.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*km/i);
  if (intKm) return parseInt(intKm[1]) * parseFloat(intKm[2]);
  const intM = d.match(/(\d+)\s*x\s*(\d+)\s*m\b/i);
  if (intM) return parseInt(intM[1]) * parseInt(intM[2]) / 1000;
  return 0;
}

/** Sum planned running km for a future week using actual generated workouts. */
function plannedWeekKm(s: SimulatorState, wkIdx: number): number {
  const wk = s.wks?.[wkIdx];
  if (!wk) return 0;
  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel,
    undefined, s.pac?.e, wkIdx + 1, s.tw, s.v, s.gs,
  );
  let km = 0;
  for (const w of workouts) {
    if (w.t === 'cross' || w.t === 'strength' || w.t === 'rest' || w.t === 'gym') continue;
    km += parseDistanceKm(w.d);
  }
  return km;
}

/** Sum planned Signal B TSS for a future week using actual generated workouts. */
function plannedWeekTSS(s: SimulatorState, wkIdx: number): number {
  const wk = s.wks?.[wkIdx];
  if (!wk) return 0;
  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel,
    undefined, s.pac?.e, wkIdx + 1, s.tw, s.v, s.gs,
  );
  let tss = 0;
  for (const w of workouts) {
    const load = calculateWorkoutLoad(w.t, w.d, (w.r ?? 5) * 10, s.pac?.e);
    tss += load.total;
  }
  return Math.round(tss);
}

// ---------------------------------------------------------------------------
// Chart data

type ChartRange = '8w' | '16w' | 'all' | 'forecast';

const NON_RUN_KW_CHART = ['cross','gym','strength','rest','yoga','swim','bike','cycl','tennis','hiit','pilates','row','hik','elliptic','walk'];

function runKmFromWeek(wk: import('@/types').Week): number {
  return Object.entries(wk.garminActuals ?? {})
    .filter(([k, a]) => {
      const aType = (a as any).activityType?.toUpperCase();
      if (aType) return aType === 'RUNNING' || aType.includes('RUN');
      return !NON_RUN_KW_CHART.some(kw => k.toLowerCase().includes(kw));
    })
    .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0);
}

function getChartData(s: SimulatorState, range: ChartRange): {
  tss: number[];
  zones: ({ base: number; threshold: number; intensity: number } | null)[];
  km: number[];
  histWeekCount: number;
} {
  const wk = s.wks?.[s.w - 1];
  const currentTSS = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const currentKm = wk ? runKmFromWeek(wk) : 0;

  // Track-only: derive history from s.wks only. Strava backfill (historicWeeklyTSS
  // etc.) reflects pre-trackOnly usage and looks like "fake" data on a fresh
  // programme. Walking s.wks gives true zero-from-start.
  if (s.trackOnly) {
    const wks = s.wks ?? [];
    const priorWks = wks.slice(0, Math.max(0, wks.length - 1));
    const histTSS = priorWks.map(pw => Math.round(computeWeekRawTSS(pw, pw.rated ?? {}, s.planStartDate)));
    const histKm = priorWks.map(pw => runKmFromWeek(pw));
    const histZones = priorWks.map(() => null as ({ base: number; threshold: number; intensity: number } | null));
    const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
    const tss = [...(sliceCount !== undefined ? histTSS.slice(-sliceCount) : histTSS), Math.round(currentTSS)];
    const km  = [...(sliceCount !== undefined ? histKm.slice(-sliceCount)  : histKm),  currentKm];
    const zones = [...(sliceCount !== undefined ? histZones.slice(-sliceCount) : histZones), { base: 0, threshold: 0, intensity: 0 }];
    return { tss, zones, km, histWeekCount: tss.length - 1 };
  }

  const useExtended = (range === '16w' || range === 'all') && (s.extendedHistoryTSS?.length ?? 0) > 0;
  const histTSSraw = useExtended ? (s.extendedHistoryTSS ?? []) : (s.historicWeeklyTSS ?? []);
  const histRaw    = s.historicWeeklyRawTSS;
  let histTSS    = (histRaw && histRaw.length > 0 && !useExtended)
    ? [...histRaw]
    : histTSSraw.map(v => Math.round(v * 1.4));
  let histKm       = [...(useExtended ? (s.extendedHistoryKm ?? []) : (s.historicWeeklyKm ?? []))];
  let histZonesRaw = [...(useExtended ? (s.extendedHistoryZones ?? []) : (s.historicWeeklyZones ?? []))];

  const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
  if (sliceCount !== undefined) {
    histTSS      = histTSS.slice(-sliceCount);
    histKm       = histKm.slice(-sliceCount);
    histZonesRaw = histZonesRaw.slice(-sliceCount);
  }

  const wks = s.wks ?? [];
  for (let k = 1; k <= Math.min(4, histTSS.length); k++) {
    const idx = histTSS.length - k;
    if (histTSS[idx] < 5) {
      const planWeekIdx = s.w - 1 - k;
      if (planWeekIdx >= 0 && wks[planWeekIdx]) {
        const pw = wks[planWeekIdx];
        const live = computeWeekRawTSS(pw, pw.rated ?? {}, s.planStartDate);
        if (live > 0) histTSS[idx] = live;
      }
    }
  }

  const paddedHistZones: ({ base: number; threshold: number; intensity: number } | null)[] =
    histTSS.map((_, i) => histZonesRaw[i] ?? null);

  const hasCurrentZones = wk && ((wk as any).zoneBase > 0 || (wk as any).zoneThreshold > 0 || (wk as any).zoneIntensity > 0);
  const currentZone = hasCurrentZones
    ? { base: (wk as any).zoneBase ?? 0, threshold: (wk as any).zoneThreshold ?? 0, intensity: (wk as any).zoneIntensity ?? 0 }
    : { base: 0, threshold: 0, intensity: 0 };

  return {
    tss:   [...histTSS, currentTSS],
    zones: [...paddedHistZones, currentZone],
    km:    [...histKm, currentKm],
    histWeekCount: histTSS.length,
  };
}

// ---------------------------------------------------------------------------
// SVG helpers

/** Build a smooth SVG path through points as cubic bezier segments. */
/** Sharp angular polyline path (no bezier smoothing). */
function smoothAreaPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  return `M ${pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;
}

/** Build week date labels for an N-point chart. */
function buildWeekLabels(n: number, labelStep = 1): string {
  const todayMs = new Date();
  const dow = (todayMs.getDay() + 6) % 7;
  const monday = new Date(todayMs);
  monday.setDate(monday.getDate() - dow);
  return Array.from({ length: n }, (_, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const weeksAgo = n - 1 - i;
    const d = i === n - 1
      ? new Date(todayMs)
      : (() => { const x = new Date(monday); x.setDate(monday.getDate() - weeksAgo * 7); return x; })();
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n-1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n-1 ? '600' : '400'}">${label}</span>`;
  }).join('');
}

/** Empty-state placeholder for charts with insufficient data. */
function chartEmptyState(height = 65): string {
  return `<div style="height:${height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(0,0,0,0.02);border-radius:10px">
    <div style="font-size:13px;color:var(--c-muted);text-align:center">Not enough data yet</div>
    <div style="font-size:11px;color:var(--c-faint);text-align:center">Needs at least 3 sessions</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Range toggle pill buttons

function buildRangeToggle(activeRange: ChartRange, cssClass: string): string {
  const btn = (range: ChartRange, label: string) => {
    const active = range === activeRange;
    return `<button class="${cssClass}" data-range="${range}"
      style="padding:3px 9px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:${active ? 'var(--c-surface)' : 'transparent'};color:${active ? 'var(--c-black)' : 'var(--c-muted)'};box-shadow:${active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'}">${label}</button>`;
  };
  return `
    <div style="display:flex;background:rgba(0,0,0,0.05);border-radius:6px;padding:2px;gap:1px">
      ${btn('8w', '8w')}
      ${btn('16w', '16w')}
      ${btn('all', 'All')}
    </div>`;
}

/** Range toggle for the Progress detail page — includes Forecast tab. */
function buildProgressRangeToggle(activeRange: ChartRange): string {
  const btn = (range: ChartRange, label: string) => {
    const active = range === activeRange;
    return `<button class="progress-range-btn" data-range="${range}"
      style="padding:3px 8px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:${active ? 'var(--c-surface)' : 'transparent'};color:${active ? 'var(--c-black)' : 'var(--c-muted)'};box-shadow:${active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'}">${label}</button>`;
  };
  return `
    <div style="display:flex;background:rgba(0,0,0,0.05);border-radius:6px;padding:2px;gap:1px">
      ${btn('8w', '8w')}
      ${btn('16w', '16w')}
      ${btn('all', 'All')}
      ${btn('forecast', 'Forecast')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Scale bar with FIXED floating marker
//
// The marker is a vertical bar positioned at `left: pct%` inside a
// position:relative container. The ⓘ info icon is placed next to the title,
// NOT on the bar. This fixes the bug where the info icon was used as a position
// marker but was always anchored to the left side.

interface PositionZone {
  label: string;
  fraction: number;
  color: string;
}

function buildOnePositionBar(opts: {
  title: string;
  infoId?: string;
  detailId?: string;
  value: number | null;
  valueLabel: string;
  zoneName: string;
  zones: PositionZone[];
  scaleMin: number;
  scaleMax: number;
  subtitle?: string;
}): string {
  const { title, infoId, detailId, value, valueLabel, zoneName, zones, scaleMin, scaleMax, subtitle } = opts;
  const markerPct = value != null
    ? Math.min(98, Math.max(2, ((value - scaleMin) / (scaleMax - scaleMin)) * 100))
    : null;

  const zoneSegments = zones.map(z =>
    `<div style="flex:${z.fraction};height:100%;background:${z.color};min-width:0"></div>`
  ).join('');

  const zoneLabels = zones.map(z =>
    `<span style="flex:${z.fraction};font-size:8px;color:var(--c-faint);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${z.label}</span>`
  ).join('');

  const infoBtn = infoId
    ? `<button class="stats-info-btn" data-info-id="${infoId}"
        style="display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;width:16px;height:16px;border-radius:50%;border:1px solid var(--c-border-strong);background:none;cursor:pointer;font-size:9px;color:var(--c-muted);font-family:var(--f);flex-shrink:0;vertical-align:middle;margin-left:3px;touch-action:manipulation">ⓘ</button>`
    : '';

  const infoBox = infoId && INFO_TEXTS[infoId]
    ? `<div id="stats-info-${infoId}" style="display:none;margin-top:6px;font-size:11px;color:var(--c-muted);line-height:1.5;background:rgba(0,0,0,0.04);border-radius:8px;padding:10px 12px">${INFO_TEXTS[infoId]}</div>`
    : '';

  // Zone fill colour — sky→blue→indigo→violet→purple→deep-violet (fitness scale, non-judgmental)
  const ZONE_FILL: Record<string, string> = {
    'Building':     '#38BDF8',
    'Foundation':   '#3B82F6',
    'Trained':      '#4F46E5',
    'Well-Trained': '#7C3AED',
    'Performance':  '#9333EA',
    'Elite':        '#6D28D9',
  };
  const fillColor = ZONE_FILL[zoneName] ?? '#3B82F6';

  // Full zone names — no abbreviations
  const ZONE_SHORT: Record<string, string> = {
    'Building':     'Building',
    'Foundation':   'Foundation',
    'Trained':      'Trained',
    'Well-Trained': 'Well-Trained',
    'Performance':  'Performance',
    'Elite':        'Elite',
  };

  // Cumulative boundary positions (fraction values sum to 1.0)
  let cum = 0;
  const boundaries: number[] = [];
  zones.slice(0, -1).forEach(z => { cum += z.fraction; boundaries.push(cum * 100); });

  // Zone segment backgrounds (tinted track)
  const bgSegments = zones.map(z =>
    `<div style="flex:${z.fraction};height:100%;background:${z.color}"></div>`
  ).join('');

  // Divider ticks at boundaries — sit under the fill (z-index 1)
  const dividerTicks = boundaries.map(pct =>
    `<div style="position:absolute;top:0;left:${pct.toFixed(2)}%;width:1.5px;height:100%;background:rgba(255,255,255,0.55);z-index:1"></div>`
  ).join('');

  // Zone labels centered under each segment; active zone uses fill colour + bold
  let cumLabel = 0;
  const segmentLabels = zones.map(z => {
    const midPct = (cumLabel + z.fraction / 2) * 100;
    cumLabel += z.fraction;
    const isActive = z.label === zoneName;
    const short = ZONE_SHORT[z.label] ?? z.label;
    return `<span style="position:absolute;left:${midPct.toFixed(1)}%;transform:translateX(-50%);font-size:8px;white-space:nowrap;${isActive ? `color:${fillColor};font-weight:700` : 'color:var(--c-faint);font-weight:400'}">${short}</span>`;
  }).join('');

  const chevron = detailId
    ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-left:5px;flex-shrink:0"><path d="M5 3l4 4-4 4" stroke="var(--c-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : '';

  return `
    <div ${detailId ? `data-metric-detail="${detailId}" style="margin-bottom:22px;cursor:pointer"` : 'style="margin-bottom:22px"'}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">${title}${infoBtn}</span>
        <span style="display:flex;align-items:center;font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">
          ${value != null
            ? `<strong style="color:var(--c-black);margin-right:3px">${valueLabel}</strong>· ${zoneName}`
            : '—'}${chevron}
        </span>
      </div>
      <!-- Bar: tinted zone track + solid fill overlay + dividers + white gap marker -->
      <div style="position:relative;height:14px;border-radius:7px;overflow:hidden;display:flex">
        ${bgSegments}
        ${markerPct != null ? `
          <div style="position:absolute;left:0;top:0;height:100%;width:${markerPct}%;background:${fillColor};z-index:2;transition:width 0.4s ease"></div>
        ` : ''}
        ${dividerTicks}
        ${markerPct != null ? `
          <div style="position:absolute;top:0;left:${markerPct}%;transform:translateX(-50%);width:3px;height:100%;background:white;z-index:4"></div>
        ` : ''}
      </div>
      <!-- Per-zone labels: active highlighted, rest faint -->
      <div style="position:relative;height:18px;margin-top:5px">
        ${segmentLabels}
      </div>
      ${subtitle ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px;text-align:right">${subtitle}</div>` : ''}
      ${infoBox}
    </div>
  `;
}

const INFO_TEXTS: Record<string, string> = {
  ctl: 'Running Load (CTL) — a 42-day rolling average of your run-equivalent training load, shown in daily-equivalent units (TrainingPeaks-compatible). Running counts fully; cross-training at a discount (e.g. cycling 55%, padel 45%, gym 35%) — because it doesn\'t fully replace running-specific adaptation.',
  atl: 'Fatigue (ATL) — a 7-day rolling average of your total physiological load: runs, gym, cross-training, everything, shown in daily-equivalent units. Your body doesn\'t care what sport caused the fatigue — hard is hard. When this rises well above your Running Load, injury risk increases even if you haven\'t been running much.',
  tsb: 'Form (TSB = Running Load − Fatigue) — positive means you\'re fresh and ready to perform. Negative means you\'re carrying fatigue. Aim to race when form is between +5 and +15.',
  acwr: 'Load Ratio (Fatigue ÷ Running Load) — compares total body fatigue against what you\'re adapted to run. A cross-training-heavy week correctly raises this even without much running. Values above your safe ceiling significantly increase injury risk.',
  momentum: 'Running Load Momentum — your 4-week trend in running load (CTL). Building means your training load has been increasing and your body is adapting. Stable means consistent training. Declining means your load has dropped — try to stay consistent, since skipping sessions compounds quickly.',
  vdot: 'VO2 Max reflects your aerobic ceiling, the primary predictor of endurance potential. When a device value is available (Garmin, Strava), that is shown directly. Otherwise it is estimated from training data using the Daniels VDOT model. Zones are sex-calibrated using ACSM standards.',
  aerobic: 'VO2 Max — your ceiling for oxygen uptake, the primary predictor of long-term endurance potential. When connected to a device (Garmin, Strava), the reported value is shown. Otherwise it is estimated from training data. Zones are sex-calibrated using ACSM standards.',
  lt: 'Lactate Threshold (LT) pace — the fastest pace you can sustain without accumulating lactic acid. The most trainable of the three metrics. A higher LT pace (further right on the bar) means you can race faster at aerobic effort.',
  freshness: 'Freshness (TSB) — your training stress balance. Positive = rested and ready to perform. Negative = carrying fatigue. Target race day TSB between +5 and +15 for peak performance.',
};

// ---------------------------------------------------------------------------
// Calibration status

function buildCalibrationStatus(s: SimulatorState): string {
  if (!s.stravaHistoryFetched) return '';
  const completedRuns = (s.wks ?? []).reduce((acc, wk) => {
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      if ((actual.iTrimp ?? 0) > 0 && (actual.durationSec ?? 0) > 600) acc++;
    }
    return acc;
  }, 0);
  if (completedRuns < 5) return '';
  const thresh = s.intensityThresholds;
  if (!thresh || !thresh.calibratedFrom || thresh.calibratedFrom === 0) return '';
  const n = thresh.calibratedFrom;
  if (n < 6) return '';
  return `
    <div class="m-card" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <div style="width:7px;height:7px;border-radius:50%;background:var(--c-ok);flex-shrink:0"></div>
      <span style="font-size:12px;color:var(--c-muted)">Intensity zones calibrated from ${n} matched sessions</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Physiology bar chart helper

function physioBarEntries(
  history: PhysiologyDayEntry[],
  field: keyof PhysiologyDayEntry,
): Array<{ value: number | null; day: string }> {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return history.map(d => ({
    value: d[field] != null ? Number(d[field]) : null,
    day: DAYS[new Date(d.date + 'T12:00:00').getDay()],
  }));
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// OPENING SCREEN
// ══════════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// 1. Progress Card

function buildProgressCard_Opening(s: SimulatorState): string {
  const isRaceMode = !s.continuousMode && !!s.initialBaseline;

  if (isRaceMode) {
    // Race mode: arc/timeline from plan start → race day
    const forecastSec  = s.forecastTime ?? s.currentFitness ?? 0;
    const initialSec   = s.initialBaseline ?? forecastSec;
    // On track = forecast is faster than or equal to initial fitness (plan is helping)
    // Slightly behind = up to 15 min slower than initial; off track = >15 min slower
    const diffSec = forecastSec - initialSec; // positive = slower than starting fitness

    let pillText: string;
    let pillColor: string;
    if (diffSec <= 300) {
      pillText = 'On track ↗';
      pillColor = 'var(--c-ok)';
    } else if (diffSec <= 900) {
      pillText = 'Slightly behind';
      pillColor = 'var(--c-caution)';
    } else {
      pillText = 'Off track ↓';
      pillColor = 'var(--c-warn)';
    }

    // Timeline progress bar
    const totalWks = s.tw ?? (s.wks?.length ?? 16);
    const currentWk = s.w ?? 1;
    const pct = Math.min(100, Math.max(0, ((currentWk - 1) / Math.max(totalWks - 1, 1)) * 100));

    const fmtT = (secs: number) => {
      if (!secs) return '—';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const sc = Math.round(secs % 60);
      return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${m}:${String(sc).padStart(2,'0')}`;
    };

    return `
      <div id="stats-card-progress" style="padding:0 18px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
        <div class="m-card" style="padding:18px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Progress</div>

          <!-- Timeline bar: "Week X of Y" rides above a monochrome progress line.
               Label position tracks the progress percent and is clamped 6–94%
               so it never collides with the Start / Race day captions. -->
          <div style="position:relative;margin-bottom:14px;padding-top:22px">
            <div style="position:absolute;top:0;left:${Math.max(6, Math.min(94, pct))}%;transform:translateX(-50%);font-size:10px;font-weight:600;color:var(--c-black);white-space:nowrap">
              Week ${currentWk} of ${totalWks}
            </div>
            <div style="height:4px;background:rgba(15,23,42,0.08);border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:var(--c-black);border-radius:2px;transition:width 0.3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:6px">
              <span style="font-size:10px;color:var(--c-faint)">Start</span>
              <span style="font-size:10px;color:var(--c-faint)">Race day</span>
            </div>
          </div>

          <!-- Forecast + pill -->
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:11px;color:var(--c-muted);margin-bottom:2px">Forecast finish</div>
              <div style="font-size:28px;font-weight:300;letter-spacing:-0.03em;color:var(--c-black)">${fmtT(forecastSec)}</div>
            </div>
            <span style="font-size:12px;font-weight:600;color:${pillColor};background:${pillColor}18;padding:5px 12px;border-radius:20px">${pillText}</span>
          </div>
        </div>
      </div>`;
  }

  // General fitness mode: compact card matching Fitness style
  const unitPref = s.unitPref ?? 'km';
  const completedWksForCard = (s.wks ?? []).slice(0, Math.max(0, (s.w ?? 1) - 1));
  let totalRunKmCard = 0;
  for (const wk of completedWksForCard) {
    const seenIds = new Set<string>();
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      if (actual.garminId && seenIds.has(actual.garminId)) continue;
      if (actual.garminId) seenIds.add(actual.garminId);
      if ((!actual.displayName || !!actual.workoutName) && actual.distanceKm > 0) {
        totalRunKmCard += actual.distanceKm;
      }
    }
  }
  const displayKm = unitPref === 'mi' ? totalRunKmCard * 0.621371 : totalRunKmCard;
  const unitLabel = unitPref === 'mi' ? 'mi' : 'km';
  return `
    <div id="stats-card-progress" style="padding:0 18px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div class="m-card" style="padding:18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:8px">Progress</div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <div style="display:flex;align-items:baseline;gap:6px">
              <div style="font-size:40px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:var(--c-black)">${displayKm > 0 ? displayKm.toFixed(1) : '—'}</div>
              <span style="font-size:22px;font-weight:300;color:var(--c-faint);line-height:1">→</span>
            </div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:3px">${unitLabel} run · this plan</div>
          </div>
          <div style="font-size:11px;color:var(--c-faint);padding-top:4px">Tap for detail ›</div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 2. Fitness Card

function buildFitnessCard_Opening(s: SimulatorState): string {
  // Honest zero-state: if the user has no real fitness signal (no device VO2,
  // no PBs, no VDOT history), don't surface the `s.v=50` store default. Show
  // "—" instead. Otherwise fall through to normal VO2 / VDOT display.
  const hasRealFitness =
    (s.vo2 ?? 0) > 0 ||
    (s.vdotHistory?.length ?? 0) > 0 ||
    Object.keys(s.pbs ?? {}).length > 0;
  const vo2display = !hasRealFitness ? 0 : (s.vo2 ?? computeCurrentVDOT(s));
  const isEstimated = s.vo2 == null;
  const vo2hist = getVO2History(s);
  const hasDeviceVO2 = vo2hist.length >= 2;
  const vdotHist = s.vdotHistory ?? [];

  // VO2 Max tier label
  const isFemale = s.biologicalSex === 'female';
  const aerBreaks = isFemale ? [28, 35, 45, 55, 65] : [35, 42, 52, 60, 70];
  const zoneLabels = ['Building', 'Foundation', 'Trained', 'Well-Trained', 'Performance', 'Elite'] as const;
  const aerZoneIdx = aerBreaks.findIndex(b => vo2display < b);
  const aerZone = zoneLabels[aerZoneIdx === -1 ? 5 : aerZoneIdx];

  // Trend: prefer device VO2 history, fall back to VDOT
  let trendArrow = '→';
  let trendColor = 'var(--c-faint)';
  if (hasDeviceVO2) {
    const d = vo2hist[vo2hist.length - 1].value - vo2hist[vo2hist.length - 2].value;
    trendArrow = d > 0.5 ? '↑' : d < -0.5 ? '↓' : '→';
    trendColor = d > 0.5 ? 'var(--c-ok)' : d < -0.5 ? 'var(--c-warn)' : 'var(--c-faint)';
  } else if (vdotHist.length >= 2) {
    const d = vdotHist[vdotHist.length - 1].vdot - vdotHist[vdotHist.length - 2].vdot;
    trendArrow = d > 0.1 ? '↑' : d < -0.1 ? '↓' : '→';
    trendColor = d > 0.1 ? 'var(--c-ok)' : d < -0.1 ? 'var(--c-warn)' : 'var(--c-faint)';
  }

  // Full line chart (same as detail page): device VO2 history, or VDOT fallback
  const chart = hasDeviceVO2
    ? buildVO2LineChart(vo2hist)
    : (vdotHist.length >= 2 ? buildVdotLineChart(vdotHist, '8w') : '');
  const changeNote = hasDeviceVO2
    ? buildVO2ChangeNote(vo2hist)
    : (vdotHist.length >= 2 ? buildVdotChangeNote(vdotHist) : '');

  const vo2Label = isEstimated ? 'VO2 Max (est.)' : 'VO2 Max';

  return `
    <div id="stats-card-fitness" style="padding:0 18px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div class="m-card" style="padding:18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:8px">Fitness</div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <div style="display:flex;align-items:baseline;gap:6px">
              <div style="font-size:40px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:var(--c-black)">${vo2display > 0 ? Math.round(vo2display) : '—'}</div>
              <span style="font-size:22px;font-weight:300;color:${trendColor};line-height:1">${trendArrow}</span>
            </div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:3px">${vo2Label} · ${aerZone}</div>
          </div>
          <div style="font-size:11px;color:var(--c-faint);padding-top:4px">Tap for detail ›</div>
        </div>
        ${chart ? `<div style="margin-top:12px">${chart}</div>` : ''}
        ${changeNote}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 3. Readiness Card

function buildReadinessCard_Opening(s: SimulatorState): string {
  // Mirror exactly what the home page computes so both show the same score
  const sameSignal = computeSameSignalTSB(s.wks ?? [], s.w, s.signalBBaseline ?? s.ctlBaseline ?? 0, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctlNow = sameSignal?.ctl ?? 0;

  const tier = s.athleteTier ?? 'recreational';
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, s.signalBBaseline ?? undefined);
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const ctlFourWeeksAgo = metrics[metrics.length - 5]?.ctl ?? ctlNow;

  const latestPhysio = s.physiologyHistory?.slice(-1)[0];
  const today = new Date().toISOString().split('T')[0];
  const manualToday = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const garminTodaySleep = (s.physiologyHistory ?? []).find(p => p.date === today && p.sleepScore != null);
  const latestWithSleep = (s.physiologyHistory ?? []).slice().reverse().find(p => p.sleepScore != null);
  const sleepScore: number | null = garminTodaySleep?.sleepScore ?? manualToday?.sleepScore ?? latestWithSleep?.sleepScore ?? null;
  const latestWithHrv = (s.physiologyHistory ?? []).slice().reverse().find(p => p.hrvRmssd != null);
  const hrvRmssd: number | null = latestWithHrv?.hrvRmssd ?? null;
  const hrvAll = (s.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a: number, b: number) => a + b, 0) / hrvAll.length)
    : null;

  const effectiveSleepTarget = s.sleepTargetSec ?? deriveSleepTarget(s.physiologyHistory ?? []);
  const sleepBank = getSleepBank(s.physiologyHistory ?? [], effectiveSleepTarget);
  const sleepDebtForRecovery2 = sleepBank.bankSec < 0 ? Math.abs(sleepBank.bankSec) : 0;
  const recoveryResult = computeRecoveryScore(s.physiologyHistory ?? [], { sleepDebtSec: sleepDebtForRecovery2 });
  const readiness = computeReadiness({
    tsb, acwr: acwr.ratio, ctlNow,
    sleepScore, hrvRmssd,
    sleepHistory: s.physiologyHistory ?? [],
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    weeksOfHistory: metrics.length,
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    acwrSafeUpper: acwr.safeUpper,
  });

  const hasData = ctlNow > 0;
  const color = readinessColor(readiness.label);
  const markerPct = Math.min(98, Math.max(2, readiness.score));

  return `
    <div id="stats-card-readiness" style="padding:0 18px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div class="m-card" style="padding:18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:8px">Readiness</div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <div style="display:flex;align-items:baseline;gap:6px">
              <div style="font-size:40px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:var(--c-black)">${hasData ? readiness.score : '—'}</div>
              <span style="font-size:22px;font-weight:300;color:var(--c-faint);line-height:1">→</span>
            </div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:3px">${hasData ? readiness.label : '—'}</div>
          </div>
          <div style="font-size:11px;color:var(--c-faint);padding-top:4px">Tap for detail ›</div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 4. Summary section (flat, no tap-through)

function buildSummarySection(s: SimulatorState): string {
  const vdot = computeCurrentVDOT(s);
  const isRaceMode = !s.continuousMode && !!s.initialBaseline;
  const unitPref = s.unitPref ?? 'km';

  const fmtTime = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sc = Math.round(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    return `${m}:${String(sc).padStart(2,'0')}`;
  };

  // Forecast times (race mode only)
  let forecastRows = '';
  if (isRaceMode && vdot >= 20) {
    const hasBlendInputs = !!(s.lt || s.vo2 || s.pbs?.k5 || s.pbs?.k10 || s.pbs?.h || s.pbs?.m);
    const inputs2 = computePredictionInputs(collectRunActivities(s));
    const liveRec2 = inputs2.recentRun ?? s.rec ?? null;
    const liveKmPerWeek2 = inputs2.weeklyKm;
    const liveAvgPace2 = inputs2.avgPaceSecPerKm ?? null;
    const distances: Array<{ label: string; dist: number; km: number; code: 'marathon'|'half'|'10k'|'5k' }> = [
      { label: 'Marathon', dist: 42195, km: 42.195,  code: 'marathon' },
      { label: 'Half',     dist: 21097, km: 21.0975, code: 'half' },
      { label: '10K',      dist: 10000, km: 10,      code: '10k' },
      { label: '5K',       dist: 5000,  km: 5,       code: '5k' },
    ];
    forecastRows = distances.map(d => {
      let timeSec: number;
      if (hasBlendInputs) {
        const blended = blendPredictions(
          d.dist, s.pbs ?? {}, s.lt ?? null, s.vo2 ?? vdot,
          s.b ?? 1.06, s.typ ?? 'Balanced', liveRec2,
          s.athleteTier ?? undefined, liveKmPerWeek2, liveAvgPace2 ?? undefined,
          { weeksCovered: inputs2.weeksCovered, paceConfidence: inputs2.paceConfidence, isStale: inputs2.isStale },
        );
        timeSec = (blended && blended > 0) ? blended : vt(d.km, vdot);
      } else {
        timeSec = vt(d.km, vdot);
      }
      // Signed delta vs target — only on the row matching s.rd, and only when a goal is set.
      let deltaHtml = '';
      if (d.code === s.rd && !s.continuousMode && s.initialBaseline && s.initialBaseline > 0) {
        const dSec = Math.round(timeSec - s.initialBaseline);
        const dMin = Math.round(Math.abs(dSec) / 60);
        const text = Math.abs(dSec) < 60
          ? 'On pace'
          : dSec > 0 ? `+${dMin} min` : `\u2212${dMin} min`;
        deltaHtml = `<span style="font-size:11px;color:var(--c-muted);margin-right:4px">${text}</span>`;
      }
      return `
        <div class="race-est-row" data-dist="${d.code}" data-time="${Math.round(timeSec)}" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--c-border);cursor:pointer;-webkit-tap-highlight-color:transparent">
          <span style="font-size:13px;color:var(--c-muted)">${d.label}</span>
          <div style="display:flex;align-items:center;gap:6px">
            ${deltaHtml}
            <span style="font-size:14px;font-weight:600;color:var(--c-black)">${fmtTime(timeSec)}</span>
            <span style="font-size:13px;color:var(--c-faint);line-height:1">›</span>
          </div>
        </div>`;
    }).join('');
  }

  if (!forecastRows) return '';

  return `
    <div style="padding:0 18px 18px">
      <div class="m-card" style="padding:16px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Current Race Estimates</div>
        <div style="font-size:10px;color:var(--c-faint);margin-bottom:6px">Estimated finish times if racing today</div>
        ${forecastRows}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Opening screen assembly

/**
 * Shared area-line renderer used by track-only volume + load cards.
 * Mirrors the VO2 / rolling-TSS chart style: polyline top + gradient fill.
 */
function buildTrackOnlyAreaChart(
  series: number[],
  options: { risingColor: string; flatColor: string; gradId: string; heightPx: number },
): string {
  const { risingColor, flatColor, gradId, heightPx } = options;
  if (series.length < 2) return '';
  const W = 320, H = 60;
  const maxVal = Math.max(...series, 1) * 1.1;
  const xOf = (i: number) => (i / (series.length - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));
  const pts: [number, number][] = series.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
  const areaPath = `${topPath} L ${W} ${H} L 0 ${H} Z`;
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  const rising = last > prev + (last * 0.05);
  const stroke = rising ? risingColor : flatColor;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${heightPx}" preserveAspectRatio="none" style="display:block">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${stroke}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${stroke}" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#${gradId})"/>
      <path d="${topPath}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

/**
 * Just-Track weekly volume retrospective. Line/area chart (same style as VO2).
 * Series sourced from `s.wks` only — each week's km summed from garminActuals
 * + adhocWorkouts. Excludes `historicWeeklyKm` (Strava backfill from prior
 * plan usage) so a fresh tracking programme starts with a clean chart and
 * fills in as activities sync into the new weeks.
 */
function buildTrackOnlyVolumeCard(s: SimulatorState): string {
  const unit: 'km' | 'mi' = s.unitPref ?? 'km';
  const wks = s.wks ?? [];

  function weekKm(w: typeof wks[number]): number {
    let km = 0;
    const seen = new Set<string>();
    for (const actual of Object.values(w.garminActuals ?? {})) {
      if (actual.garminId && seen.has(actual.garminId)) continue;
      if (actual.garminId) seen.add(actual.garminId);
      if (typeof actual.distanceKm === 'number' && actual.distanceKm > 0) km += actual.distanceKm;
    }
    for (const adhoc of (w.adhocWorkouts ?? [])) {
      const d = (adhoc as any).garminDistKm ?? (adhoc as any).distanceKm;
      if (typeof d === 'number' && d > 0) km += d;
    }
    return km;
  }

  const series = wks.map(weekKm);
  const currentKm = series[series.length - 1] ?? 0;
  const prevKm = series.length >= 2 ? series[series.length - 2] : 0;
  const avg4wSource = series.slice(-4);
  const avg4wKm = avg4wSource.length ? avg4wSource.reduce((a, b) => a + b, 0) / avg4wSource.length : 0;

  if (series.every(k => !k || k === 0)) {
    return `
      <div style="padding:0 18px 12px">
        <div class="m-card" style="padding:18px;text-align:center">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Weekly volume</div>
          <div style="font-size:13px;color:var(--c-muted);line-height:1.45">Connect Strava or record a run. Weekly volume builds up from this week forward.</div>
        </div>
      </div>`;
  }

  const chart = buildTrackOnlyAreaChart(series, {
    risingColor: 'rgba(58,96,144,0.85)',
    flatColor: 'rgba(71,85,105,0.70)',
    gradId: 'volFill',
    heightPx: 90,
  });

  return `
    <div style="padding:0 18px 12px">
      <div class="m-card" style="padding:18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Weekly volume</div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:2px">This week</div>
            <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black);line-height:1">${formatKm(currentKm, unit)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:2px">Last week</div>
            <div style="font-size:14px;font-weight:500;color:var(--c-black)">${formatKm(prevKm, unit)}</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:6px">4w avg</div>
            <div style="font-size:14px;font-weight:500;color:var(--c-black)">${formatKm(avg4wKm, unit)}</div>
          </div>
        </div>
        ${chart}
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--c-faint)">
          <span>${series.length} wk ago</span>
          <span style="color:var(--c-black);font-weight:600">This week</span>
        </div>
      </div>
    </div>`;
}

/**
 * Just-Track weekly Signal-B TSS retrospective (load over time).
 *
 * Current week TSS comes from `computeWeekRawTSS` on the live bucket.
 * Prior weeks from `historicWeeklyTSS` (Strava backfill). Rendered the
 * same way as the volume card but with TSS instead of km. Empty state
 * when no data yet.
 */
function buildTrackOnlyLoadCard(s: SimulatorState): string {
  // Series sourced from s.wks only — each week's Signal-B TSS. Excludes
  // historicWeeklyTSS (Strava backfill from prior plan usage).
  const wks = s.wks ?? [];
  const series = wks.map(w => Math.round(computeWeekRawTSS(w, w.rated ?? {}, s.planStartDate)));
  const currentTSS = series[series.length - 1] ?? 0;
  const prevTSS = series.length >= 2 ? series[series.length - 2] : 0;
  const avg4wSource = series.slice(-4);
  const avg4wTSS = avg4wSource.length ? Math.round(avg4wSource.reduce((a, b) => a + b, 0) / avg4wSource.length) : 0;

  if (series.every(t => !t || t === 0)) {
    return `
      <div style="padding:0 18px 12px">
        <div class="m-card" style="padding:18px;text-align:center">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Load over time</div>
          <div style="font-size:13px;color:var(--c-muted);line-height:1.45">Connect Strava or record a run. Weekly TSS builds up from this week forward.</div>
        </div>
      </div>`;
  }

  const chart = buildTrackOnlyAreaChart(series, {
    risingColor: 'rgba(58,96,144,0.85)',
    flatColor: 'rgba(71,85,105,0.70)',
    gradId: 'loadFill',
    heightPx: 90,
  });

  return `
    <div style="padding:0 18px 12px">
      <div class="m-card" style="padding:18px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Load over time</div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:2px">This week</div>
            <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black);line-height:1;font-variant-numeric:tabular-nums">${currentTSS}<span style="font-size:14px;font-weight:500;color:var(--c-muted);margin-left:4px">TSS</span></div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:2px">Last week</div>
            <div style="font-size:14px;font-weight:500;color:var(--c-black)">${prevTSS} TSS</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:6px">4w avg</div>
            <div style="font-size:14px;font-weight:500;color:var(--c-black)">${avg4wTSS} TSS</div>
          </div>
        </div>
        ${chart}
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--c-faint)">
          <span>${series.length} wk ago</span>
          <span style="color:var(--c-black);font-weight:600">This week</span>
        </div>
      </div>
    </div>`;
}

function buildStatsSummary(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  // Just-Track mode: same card layout as planned — Progress (continuous-fitness
  // branch of `buildProgressCard_Opening`), Fitness, Volume, Load over time.
  // Progress card taps through to the Progress detail page which hides Plan
  // Adherence + Phase Timeline for trackOnly.
  if (s.trackOnly) {
    return `
      <div class="mosaic-page" style="background:var(--c-bg)">
        <div style="padding:16px 18px 8px;display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:var(--c-black)">Stats</div>
          <button id="stats-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f);flex-shrink:0">${initials || 'Me'}</button>
        </div>
        ${buildProgressCard_Opening(s)}
        <div style="padding:0 18px;margin-top:4px;margin-bottom:4px">
          <div style="height:1px;background:var(--c-border)"></div>
        </div>
        ${buildFitnessCard_Opening(s)}
        ${buildTrackOnlyVolumeCard(s)}
        ${buildTrackOnlyLoadCard(s)}
      </div>
      ${renderTabBar('stats', isSimulatorMode())}`;
  }

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      <div style="padding:16px 18px 8px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:var(--c-black)">Stats</div>
        <button id="stats-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f);flex-shrink:0">${initials || 'Me'}</button>
      </div>
      ${buildProgressCard_Opening(s)}
      <div style="padding:0 18px;margin-top:4px;margin-bottom:4px">
        <div style="height:1px;background:var(--c-border)"></div>
      </div>
      ${buildFitnessCard_Opening(s)}
      ${buildSummarySection(s)}
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// DETAIL PAGE SHARED
// ══════════════════════════════════════════════════════════════════════════════

function buildDetailHeader(title: string): string {
  return `
    <div style="padding:max(16px, env(safe-area-inset-top)) 18px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--c-border)">
      <button id="stats-detail-back" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:20px;color:var(--c-black);font-family:var(--f);flex-shrink:0;margin-left:-8px">←</button>
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">${title}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// PROGRESS DETAIL PAGE
// ══════════════════════════════════════════════════════════════════════════════

/** Phase timeline bar. */
function buildPhaseTimeline(s: SimulatorState): string {
  const weeks = s.wks ?? [];
  if (weeks.length === 0) return '';

  const phaseColors: Record<string, string> = {
    base: 'rgba(37,99,235,0.75)', build: 'rgba(249,115,22,0.75)', peak: 'rgba(168,85,247,0.75)', taper: 'rgba(234,179,8,0.75)',
  };
  const phaseText: Record<string, string> = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper' };

  type Seg = { phase: string; start: number; end: number };
  const segs: Seg[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const ph = weeks[i].ph || 'base';
    if (!segs.length || segs[segs.length - 1].phase !== ph) segs.push({ phase: ph, start: i + 1, end: i + 1 });
    else segs[segs.length - 1].end = i + 1;
  }

  const total = weeks.length;
  const bars = segs.map((seg, si) => {
    const w = ((seg.end - seg.start + 1) / total * 100).toFixed(1);
    const color = phaseColors[seg.phase] ?? 'var(--c-muted)';
    const label = phaseText[seg.phase] ?? seg.phase;
    const isCurr = s.w >= seg.start && s.w <= seg.end;
    const isFirst = si === 0;
    const isLast  = si === segs.length - 1;
    const dotPct  = seg.end > seg.start ? ((s.w - seg.start) / (seg.end - seg.start) * 100) : 50;
    return `
      <div style="display:flex;flex-direction:column;width:${w}%">
        <div style="height:8px;border-radius:${isFirst ? '4px 0 0 4px' : ''}${isLast ? '0 4px 4px 0' : ''};background:${color};opacity:${isCurr ? '1' : '0.35'};position:relative">
          ${isCurr ? `<div style="position:absolute;top:50%;left:${Math.max(8, Math.min(92, dotPct))}%;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:white;border:2px solid ${color};box-shadow:0 1px 3px rgba(0,0,0,0.2)"></div>` : ''}
        </div>
        <span style="font-size:9px;color:var(--c-faint);margin-top:5px;font-weight:${isCurr ? '600' : '400'}">${label}</span>
      </div>`;
  }).join('');

  // Current phase label
  const currSeg = segs.find(seg => s.w >= seg.start && s.w <= seg.end);
  const currPhaseLabel = currSeg ? (phaseText[currSeg.phase] ?? currSeg.phase) + ' phase' : '';

  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:12px">Phase Timeline</div>
      <div style="display:flex;width:100%;gap:2px;margin-bottom:6px">${bars}</div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--c-faint)">
        <span>Start</span>
        <span style="color:var(--c-accent);font-weight:600">Week ${s.w} of ${s.tw ?? total} · ${currPhaseLabel}</span>
        <span>Race day</span>
      </div>
    </div>`;
}

/** Signal B load line chart. */
function buildLoadLineChart(s: SimulatorState, range: ChartRange, cssClass: string): string {
  const data = getChartData(s, range);
  const { tss, histWeekCount } = data;
  const n = tss.length;

  if (n < 3 || tss.every(v => v === 0)) return chartEmptyState(75);

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;

  const maxVal = Math.max(...tss, 1) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = tss.map((t, i) => [xOf(i), yOf(t)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const tickStep = maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 20 ? 4 : n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${areaPath}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

/** Forecast load chart: historical TSS (solid) + planned TSS (dashed continuation). */
function buildForecastLoadChart(s: SimulatorState): string {
  const wks = s.wks ?? [];
  const currentWeekIdx = (s.w ?? 1) - 1;
  const futureWks = wks.slice(currentWeekIdx, currentWeekIdx + 8);

  if (futureWks.length === 0) return chartEmptyState(75);

  // Build phase groups for weekInPhase context
  const phaseGroups: { phase: string; start: number; end: number }[] = [];
  for (let i = 0; i < wks.length; i++) {
    const ph = wks[i].ph || 'base';
    if (!phaseGroups.length || phaseGroups[phaseGroups.length - 1].phase !== ph) {
      phaseGroups.push({ phase: ph, start: i, end: i });
    } else {
      phaseGroups[phaseGroups.length - 1].end = i;
    }
  }
  function getPhaseContext(idx: number) {
    for (const g of phaseGroups) {
      if (idx >= g.start && idx <= g.end)
        return { weekInPhase: idx - g.start + 1, totalPhaseWeeks: g.end - g.start + 1 };
    }
    return { weekInPhase: 1, totalPhaseWeeks: 1 };
  }

  // Historical portion (last 8 actual weeks including current)
  const histData = getChartData(s, '8w');
  const histTSS = histData.tss;
  const histN = histTSS.length;

  // Future TSS: use computePlannedWeekTSS (Signal B scale, history-based)
  const futureTSS = futureWks.map((wk, fi) => {
    const { weekInPhase, totalPhaseWeeks } = getPhaseContext(currentWeekIdx + fi);
    return computePlannedWeekTSS(
      s.historicWeeklyTSS,
      s.ctlBaseline ?? undefined,
      wk.ph || 'base',
      s.athleteTier ?? undefined,
      s.rw ?? undefined,
      weekInPhase,
      totalPhaseWeeks,
    );
  });
  const futurePhases = futureWks.map(wk => wk.ph || 'base');

  // Combined
  const allTSS = [...histTSS, ...futureTSS];
  const N = allTSS.length;
  const splitIdx = histN - 1; // last historical point = first forecast point

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...allTSS, 1) * 1.1;

  const xOf = (i: number) => padL + (N <= 1 ? usableW / 2 : i * usableW / (N - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = allTSS.map((v, i) => [xOf(i), yOf(v)]);

  // Historical: solid area + line (indices 0..splitIdx)
  const histPts = pts.slice(0, histN);
  const histTop = smoothAreaPath(histPts);
  const histArea = `${histTop} L ${xOf(histN - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Forecast: smooth dashed line connecting from splitIdx
  const forecastPts = pts.slice(splitIdx);
  const fSmooth = smoothAreaPath(forecastPts);
  const fAreaPath = `${fSmooth} L ${forecastPts[forecastPts.length - 1][0].toFixed(1)} ${H} L ${forecastPts[0][0].toFixed(1)} ${H} Z`;

  // Y-axis labels
  const tickStep = maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  // Phase labels: show at each phase change (first week of a new phase)
  // Never use SVG <text> in preserveAspectRatio:none — use absolutely-positioned HTML
  const phaseLabelsHtml = futurePhases.map((ph, fi) => {
    const prevPh = fi === 0 ? null : futurePhases[fi - 1];
    if (ph === prevPh) return ''; // not a phase change
    const label = ph.charAt(0).toUpperCase() + ph.slice(1);
    const allIdx = splitIdx + 1 + fi; // index in allTSS
    const leftPct = (xOf(allIdx) / W * 100).toFixed(1);
    return `<span style="position:absolute;top:4px;left:${leftPct}%;transform:translateX(-50%);font-size:8px;color:rgba(0,0,0,0.28);font-weight:500;line-height:1;white-space:nowrap;pointer-events:none">${label}</span>`;
  }).join('');

  // X-axis labels: today + sampled future dates
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(monday.getDate() - dow);

  const xLabels = allTSS.map((_, i) => {
    const show = i === 0 || i === splitIdx || i === N - 1;
    if (!show) return `<span></span>`;
    const d = new Date(monday);
    d.setDate(monday.getDate() + (i - splitIdx) * 7);
    const dateLabel = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const isToday = i === splitIdx;
    return `<span style="font-size:9px;color:${isToday ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${isToday ? '600' : '400'}">${dateLabel}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${fAreaPath}" fill="${CHART_FILL_LIGHT}" stroke="none"/>
        <path d="${histArea}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${histTop}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${fSmooth}" fill="none" stroke="${CHART_STROKE_DIM}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}${phaseLabelsHtml}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${xLabels}</div>
    </div>`;
}

/** Forecast km chart: historical km (solid fill) + planned km (lighter continuation). */
function buildForecastKmChart(s: SimulatorState): string {
  const wks = s.wks ?? [];
  const currentWeekIdx = (s.w ?? 1) - 1;
  const futureWks = wks.slice(currentWeekIdx, currentWeekIdx + 8);

  if (futureWks.length === 0) return chartEmptyState(55);

  // Phase context helper (same as in buildForecastLoadChart)
  const phaseGroups: { phase: string; start: number; end: number }[] = [];
  for (let i = 0; i < wks.length; i++) {
    const ph = wks[i].ph || 'base';
    if (!phaseGroups.length || phaseGroups[phaseGroups.length - 1].phase !== ph) {
      phaseGroups.push({ phase: ph, start: i, end: i });
    } else {
      phaseGroups[phaseGroups.length - 1].end = i;
    }
  }
  function getPhaseContext(idx: number) {
    for (const g of phaseGroups) {
      if (idx >= g.start && idx <= g.end)
        return { weekInPhase: idx - g.start + 1, totalPhaseWeeks: g.end - g.start + 1 };
    }
    return { weekInPhase: 1, totalPhaseWeeks: 1 };
  }

  const histData = getChartData(s, '8w');
  const histKm = histData.km;
  const histN = histKm.length;

  const futureKm = futureWks.map((_, fi) => plannedWeekKm(s, currentWeekIdx + fi));
  const futurePhases = futureWks.map(wk => wk.ph || 'base');

  const allKm = [...histKm, ...futureKm];
  const N = allKm.length;
  const splitIdx = histN - 1;

  const unitPref = s.unitPref ?? 'km';
  const display = unitPref === 'mi' ? allKm.map(v => v * 0.621371) : allKm;

  const W = 320, H = 55, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...display, 1) * 1.1;

  const xOf = (i: number) => padL + (N <= 1 ? usableW / 2 : i * usableW / (N - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = display.map((v, i) => [xOf(i), yOf(v)]);

  const histPts = pts.slice(0, histN);
  const histTop = smoothAreaPath(histPts);
  const histArea = `${histTop} L ${xOf(histN - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const forecastPts = pts.slice(splitIdx);
  const fSmooth = smoothAreaPath(forecastPts);
  const fAreaPath = `${fSmooth} L ${forecastPts[forecastPts.length - 1][0].toFixed(1)} ${H} L ${forecastPts[0][0].toFixed(1)} ${H} Z`;

  // Y-axis labels
  const tickStep = maxVal <= 40 ? 10 : maxVal <= 80 ? 20 : maxVal <= 160 ? 40 : 50;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    const label = unitPref === 'mi' ? `${Math.round(v)}mi` : `${Math.round(v)}`;
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${label}</span>`);
  }

  // Phase labels
  const phaseLabelsHtml = futurePhases.map((ph, fi) => {
    const prevPh = fi === 0 ? null : futurePhases[fi - 1];
    if (ph === prevPh) return '';
    const label = ph.charAt(0).toUpperCase() + ph.slice(1);
    const allIdx = splitIdx + 1 + fi;
    const leftPct = (xOf(allIdx) / W * 100).toFixed(1);
    return `<span style="position:absolute;top:4px;left:${leftPct}%;transform:translateX(-50%);font-size:8px;color:rgba(0,0,0,0.28);font-weight:500;line-height:1;white-space:nowrap;pointer-events:none">${label}</span>`;
  }).join('');

  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(monday.getDate() - dow);
  const N_km = allKm.length;

  const xLabels = allKm.map((_, i) => {
    const show = i === 0 || i === splitIdx || i === N_km - 1;
    if (!show) return `<span></span>`;
    const d = new Date(monday);
    d.setDate(monday.getDate() + (i - splitIdx) * 7);
    const dateLabel = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const isToday = i === splitIdx;
    return `<span style="font-size:9px;color:${isToday ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${isToday ? '600' : '400'}">${dateLabel}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${fAreaPath}" fill="${CHART_FILL_LIGHT}" stroke="none"/>
        <path d="${histArea}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${histTop}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${fSmooth}" fill="none" stroke="${CHART_STROKE_DIM}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}${phaseLabelsHtml}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${xLabels}</div>
    </div>`;
}

/** Weekly running km line chart. */
function buildRunDistanceLineChart(s: SimulatorState, range: ChartRange): string {
  const data = getChartData(s, range);
  const { km } = data;
  const n = km.length;

  if (n < 3 || km.every(v => v === 0)) return chartEmptyState(55);

  const unitPref = s.unitPref ?? 'km';
  const displayKm = unitPref === 'mi' ? km.map(v => v * 0.621371) : km;
  const W = 320, H = 50, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...displayKm, 1) * 1.15;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = displayKm.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Y-axis labels
  const tickStep = maxVal <= 20 ? 5 : maxVal <= 50 ? 10 : maxVal <= 100 ? 20 : 25;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 20 ? 4 : n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${areaPath}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

/** CTL line chart (Signal A, daily-equivalent). */
function buildCTLLineChart(s: SimulatorState, range: ChartRange): string {
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  if (metrics.length < 3) return chartEmptyState(55);

  const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
  const sliced = sliceCount !== undefined ? metrics.slice(-sliceCount) : metrics;
  const n = sliced.length;
  if (n < 3) return chartEmptyState(55);

  const ctlVals = sliced.map(m => m.ctl / 7); // daily-equivalent
  const W = 320, H = 50, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...ctlVals, 1) * 1.2;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = ctlVals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const dots = '';

  const nowX = xOf(n - 1);
  const nowLine = `<line x1="${nowX.toFixed(1)}" y1="0" x2="${nowX.toFixed(1)}" y2="${H}" stroke="rgba(52,199,89,0.15)" stroke-width="2"/>`;

  // Y-axis labels
  const tickStep = maxVal <= 30 ? 10 : maxVal <= 60 ? 15 : maxVal <= 120 ? 30 : 50;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  const labelStep = n > 20 ? 4 : n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        <path d="${areaPath}" fill="rgba(52,199,89,0.15)" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="rgba(52,199,89,0.80)" stroke-width="1.5" stroke-linejoin="round"/>
        ${nowLine}
        ${dots}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

/**
 * Aerobic Durability chart — HR drift on easy + long runs over recent training.
 *
 * Chart shows individual drift samples (dots) plus a 4-session rolling mean (line)
 * so the user can see both the noise and the trend. Reference bands at 5% and 8%
 * mark the efficient / moderate / stressed zones.
 *
 * Filters to easy + long runs only — quality sessions deliberately push above
 * aerobic threshold so drift on them carries no durability signal.
 */
function buildDurabilityChart(s: SimulatorState): string {
  interface DriftSample { drift: number; date: number }
  const samples: DriftSample[] = [];
  const weeksToScan = 12;
  const currentIdx = Math.max(0, (s.w ?? 1) - 1);
  const startIdx = Math.max(0, currentIdx - weeksToScan + 1);
  for (let i = startIdx; i <= currentIdx; i++) {
    const wk = (s.wks ?? [])[i];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      const t = actual.plannedType;
      if ((t === 'easy' || t === 'long') && typeof actual.hrDrift === 'number' && !isNaN(actual.hrDrift)) {
        const dateMs = actual.startTime ? new Date(actual.startTime).getTime() : 0;
        samples.push({ drift: heatAdjust(actual.hrDrift, actual.ambientTempC), date: dateMs });
      }
    }
  }
  samples.sort((a, b) => a.date - b.date);

  if (samples.length < 4) {
    const have = samples.length;
    const headline = have === 0
      ? 'No easy or long runs with heart-rate data yet.'
      : `${have} of 4 easy or long runs logged.`;
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:90px;font-size:12px;color:var(--c-muted);text-align:center;padding:12px 20px;line-height:1.5">
      <div style="color:var(--c-black);font-weight:500">${headline}</div>
      <div style="font-size:11px;color:var(--c-faint);max-width:280px">Durability is measured on steady-state running only. Intervals, tempo, and cross-training are excluded because HR drift on those efforts is expected. History is backfilling in the background.</div>
    </div>`;
  }

  const drifts = samples.map(s => s.drift);
  const n = drifts.length;

  // 4-sample rolling mean
  const means: number[] = [];
  const window = 4;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window + 1);
    const slice = drifts.slice(lo, i + 1);
    means.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }

  const W = 320, H = 90, padL = 6, padR = 6, padT = 6, padB = 8;
  const usableW = W - padL - padR;
  const usableH = H - padT - padB;

  // Y scale: clamp floor at 0, ceiling at max drift observed (min 12% for context)
  const rawMax = Math.max(...drifts, 12);
  const maxY = Math.ceil(rawMax / 2) * 2; // round up to even
  const minY = Math.min(0, Math.min(...drifts));
  const yRange = maxY - minY;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => padT + usableH - ((v - minY) / yRange) * usableH;

  // Threshold bands: 0-5 efficient, 5-8 moderate, 8+ stressed
  const y5 = yOf(5);
  const y8 = yOf(8);
  const y0 = yOf(Math.max(0, minY));

  // Points — coloured by zone
  const pointColour = (v: number) => v <= 5 ? 'rgba(52,199,89,0.85)' : v <= 8 ? 'rgba(245,158,11,0.85)' : 'rgba(239,68,68,0.85)';
  const dots = drifts.map((v, i) => {
    const cx = xOf(i).toFixed(1);
    const cy = yOf(v).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="2.2" fill="${pointColour(v)}"/>`;
  }).join('');

  // Rolling mean line
  const meanPts: [number, number][] = means.map((v, i) => [xOf(i), yOf(v)]);
  const meanPath = meanPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

  // Y-axis labels
  const tickStep = maxY <= 10 ? 2 : maxY <= 20 ? 5 : 10;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxY * 0.98; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${v}%</span>`);
  }

  const currentMean = Math.round(means[means.length - 1] * 10) / 10;
  const trend = means.length >= 5 ? means[means.length - 1] - means[means.length - 5] : 0;
  const trendLabel = trend < -1 ? 'improving' : trend > 1 ? 'rising' : 'stable';
  const trendColor = trend < -1 ? 'var(--c-ok)' : trend > 1 ? 'var(--c-warn)' : 'var(--c-muted)';

  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${currentMean}%</div>
      <div style="font-size:11px;font-weight:600;color:${trendColor};letter-spacing:0.02em">${trendLabel.toUpperCase()}</div>
    </div>
    <div style="position:relative;padding-right:32px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        <!-- threshold bands -->
        <rect x="${padL}" y="${padT}" width="${usableW}" height="${(y5 - padT).toFixed(1)}" fill="rgba(239,68,68,0.04)"/>
        <rect x="${padL}" y="${y5.toFixed(1)}" width="${usableW}" height="${(y8 - y5).toFixed(1)}" fill="rgba(245,158,11,0.04)"/>
        <rect x="${padL}" y="${y8.toFixed(1)}" width="${usableW}" height="${(y0 - y8).toFixed(1)}" fill="rgba(52,199,89,0.04)"/>
        <!-- grid -->
        ${chartGridLines(maxY, yOf, W, padL, padR)}
        <!-- threshold lines -->
        <line x1="${padL}" y1="${y5.toFixed(1)}" x2="${W - padR}" y2="${y5.toFixed(1)}" stroke="rgba(245,158,11,0.35)" stroke-width="0.5" stroke-dasharray="2,2"/>
        <line x1="${padL}" y1="${y8.toFixed(1)}" x2="${W - padR}" y2="${y8.toFixed(1)}" stroke="rgba(239,68,68,0.35)" stroke-width="0.5" stroke-dasharray="2,2"/>
        <!-- 4-session rolling mean -->
        <path d="${meanPath}" class="chart-draw" fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="1.5" stroke-linejoin="round"/>
        <!-- points -->
        ${dots}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
    </div>
    <div style="display:flex;gap:10px;margin-top:8px;font-size:10px;color:var(--c-faint);line-height:1.3">
      <span><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:rgba(52,199,89,0.85);vertical-align:middle;margin-right:3px"></span>≤5% efficient</span>
      <span><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:rgba(245,158,11,0.85);vertical-align:middle;margin-right:3px"></span>5–8% moderate</span>
      <span><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:rgba(239,68,68,0.85);vertical-align:middle;margin-right:3px"></span>&gt;8% stressed</span>
    </div>`;
}

function buildProgressDetailPage(s: SimulatorState): string {
  const unitPref = s.unitPref ?? 'km';

  // Compute plan stats for the table
  const completedWks = (s.wks ?? []).slice(0, Math.max(0, (s.w ?? 1) - 1));
  let totalRunKm = 0;
  let totalRuns = 0;
  let longestRunKm = 0;
  let totalTimeSec = 0;
  let totalCalories = 0;
  let caloriesTracked = false;
  let totalLoad = 0;
  // PB tracking: fastest elapsed time for runs covering at least 5k, 10k, 21.1k
  let fastest5kSec = Infinity;
  let fastest10kSec = Infinity;
  let fastestHalfSec = Infinity;
  const allWks = s.wks ?? [];
  for (const wk of completedWks) {
    const seenIds = new Set<string>();
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      if (actual.garminId && seenIds.has(actual.garminId)) continue;
      if (actual.garminId) seenIds.add(actual.garminId);
      const isRun = !actual.displayName || !!actual.workoutName;
      if (isRun && actual.distanceKm > 0) {
        totalRunKm += actual.distanceKm;
        totalRuns++;
        longestRunKm = Math.max(longestRunKm, actual.distanceKm);
        // PB: use avg pace to estimate time for standard distances
        if (actual.avgPaceSecKm != null && actual.avgPaceSecKm > 0) {
          if (actual.distanceKm >= 5) fastest5kSec = Math.min(fastest5kSec, 5 * actual.avgPaceSecKm);
          if (actual.distanceKm >= 10) fastest10kSec = Math.min(fastest10kSec, 10 * actual.avgPaceSecKm);
          if (actual.distanceKm >= 21.0975) fastestHalfSec = Math.min(fastestHalfSec, 21.0975 * actual.avgPaceSecKm);
        }
      }
      totalTimeSec += actual.durationSec;
      if (actual.calories != null && actual.calories > 0) {
        totalCalories += actual.calories;
        caloriesTracked = true;
      }
    }
    totalLoad += computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate);
  }
  // Also scan current week for PBs and totals
  const currentWk = allWks[(s.w ?? 1) - 1];
  if (currentWk) {
    const seenIds = new Set<string>();
    for (const actual of Object.values(currentWk.garminActuals ?? {})) {
      if (actual.garminId && seenIds.has(actual.garminId)) continue;
      if (actual.garminId) seenIds.add(actual.garminId);
      const isRun = !actual.displayName || !!actual.workoutName;
      if (isRun && actual.distanceKm > 0 && actual.avgPaceSecKm != null && actual.avgPaceSecKm > 0) {
        if (actual.distanceKm >= 5) fastest5kSec = Math.min(fastest5kSec, 5 * actual.avgPaceSecKm);
        if (actual.distanceKm >= 10) fastest10kSec = Math.min(fastest10kSec, 10 * actual.avgPaceSecKm);
        if (actual.distanceKm >= 21.0975) fastestHalfSec = Math.min(fastestHalfSec, 21.0975 * actual.avgPaceSecKm);
      }
    }
  }
  const weeksCompleted = completedWks.length;
  const avgKmWeek = weeksCompleted > 0 ? totalRunKm / weeksCompleted : 0;
  const adherence = computePlanAdherence(s);
  const adhesionPct = adherence.pct ?? 0;
  const totalHours = Math.floor(totalTimeSec / 3600);
  const totalMins  = Math.round((totalTimeSec % 3600) / 60);
  const timeStr = totalHours > 0 ? `${totalHours}h ${totalMins}m` : `${totalMins}m`;
  // Format elapsed time as H:MM:SS or MM:SS
  const fmtElapsed = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s2 = Math.round(sec % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s2).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const statRow = (label: string, value: string) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--c-border)">
      <span style="font-size:13px;color:var(--c-muted)">${label}</span>
      <span style="font-size:13px;font-weight:600;color:var(--c-black)">${value}</span>
    </div>`;

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Progress')}

      <div style="padding:12px 18px 14px;overflow-y:auto">

        <!-- Stats table -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          ${statRow('Total Distance', totalRunKm > 0 ? formatKm(totalRunKm, unitPref) : '—')}
          ${statRow('Total Runs', String(totalRuns))}
          ${statRow('Avg / week', formatKm(avgKmWeek, unitPref))}
          ${statRow('Longest Run', longestRunKm > 0 ? formatKm(longestRunKm, unitPref) : '—')}
          ${fastest5kSec < Infinity ? statRow('Fastest 5k', fmtElapsed(fastest5kSec)) : ''}
          ${fastest10kSec < Infinity ? statRow('Fastest 10k', fmtElapsed(fastest10kSec)) : ''}
          ${fastestHalfSec < Infinity ? statRow('Fastest Half Marathon', fmtElapsed(fastestHalfSec)) : ''}
          ${s.trackOnly ? '' : statRow('Plan Adherence', adherence.pct != null ? `${adhesionPct}%` : '—')}
          ${statRow('Time Active', totalTimeSec > 0 ? timeStr : '—')}
          ${caloriesTracked ? statRow('Calories Burnt', `${Math.round(totalCalories).toLocaleString()} kcal`) : ''}
          <div id="stats-progress-load-row" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0">
            <span style="font-size:13px;color:var(--c-muted)">Total Load</span>
            <span style="font-size:13px;font-weight:600;color:var(--c-black);display:flex;align-items:center;gap:4px">
              ${Math.round(totalLoad).toLocaleString()} TSS <span style="font-size:11px;color:var(--c-faint);font-weight:400">›</span>
            </span>
          </div>
        </div>

        <!-- Phase Timeline — plan-only, hidden in trackOnly -->
        ${s.trackOnly ? '' : buildPhaseTimeline(s)}

        <!-- Load Chart (Signal B) -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--c-black)">Total Load (TSS)</div>
              <div style="font-size:10px;color:var(--c-faint);margin-top:1px">Total physiological load across all activities</div>
            </div>
            ${buildProgressRangeToggle('8w')}
          </div>
          <div id="progress-load-chart">${buildLoadLineChart(s, '8w', 'progress-range-btn')}</div>
        </div>

        <!-- Running Distance Chart -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="font-size:12px;font-weight:600;color:var(--c-black)">Running Distance</div>
          </div>
          <div id="progress-km-chart">${buildRunDistanceLineChart(s, '8w')}</div>
          <div style="font-size:10px;color:var(--c-faint);margin-top:6px">Running ${unitPref === 'mi' ? 'miles' : 'km'} per week</div>
        </div>

        <!-- Running Load (CTL) Over Time -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:12px;font-weight:600;color:var(--c-black)">Running Load Trend (CTL)</div>
            <button id="ctl-learn-more-btn" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">Learn more →</button>
          </div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:12px">42-day rolling average of run-equivalent load · daily units</div>
          <div id="progress-ctl-chart">${buildCTLLineChart(s, '8w')}</div>
          <div style="font-size:10px;color:var(--c-muted);margin-top:10px;line-height:1.5">
            A rising line means your aerobic base is expanding. A plateau means load is consistent. A planned drop during taper or a recovery week is normal — fatigue clears while fitness remains. A sustained drop over 3+ weeks without a taper signals undertrained weeks.
          </div>
        </div>

        <!-- Aerobic Durability -->
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:12px;font-weight:600;color:var(--c-black)">Aerobic Durability</div>
          </div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:12px">HR drift on easy and long runs · last 12 weeks · lower is better</div>
          <div id="progress-durability-chart">${buildDurabilityChart(s)}</div>
          <div style="font-size:10px;color:var(--c-muted);margin-top:10px;line-height:1.5">
            HR drift is how much heart rate rises in the second half of a run compared with the first, at the same pace. A falling trend means the aerobic system is holding pace with less strain. A rising trend on steady-effort sessions points to fatigue, heat, dehydration, or pace sitting too close to aerobic threshold.
          </div>
        </div>

      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// CTL LEARN MORE PAGE
// ══════════════════════════════════════════════════════════════════════════════

function buildCTLLearnMorePage(s: SimulatorState): string {
  const ctl = s.ctlBaseline ?? 0;
  const ctlD = Math.round(ctl / 7);

  const zones: Array<{ label: string; range: string; desc: string; color: string }> = [
    { label: 'Building',     range: '< 20',    desc: 'Returning or new runner, building aerobic base.',                              color: '#38BDF8' },
    { label: 'Foundation',   range: '20 to 40', desc: 'Consistent recreational runner, 3 to 4 sessions per week.',                   color: '#3B82F6' },
    { label: 'Trained',      range: '40 to 58', desc: 'Structured training, 4 to 5 runs per week.',                                  color: '#4F46E5' },
    { label: 'Well-Trained', range: '58 to 75', desc: 'High-volume amateur or committed club runner.',                               color: '#7C3AED' },
    { label: 'Performance',  range: '75 to 95', desc: 'Competitive amateur, structured year-round, high weekly volume.',             color: '#9333EA' },
    { label: 'Elite',        range: '95+',      desc: 'Near-professional or elite-level weekly training volume.',                    color: '#6D28D9' },
  ];

  const rows = zones.map((z, i) => {
    const isCurrent = (
      (z.label === 'Building'     && ctlD < 20) ||
      (z.label === 'Foundation'   && ctlD >= 20 && ctlD < 40) ||
      (z.label === 'Trained'      && ctlD >= 40 && ctlD < 58) ||
      (z.label === 'Well-Trained' && ctlD >= 58 && ctlD < 75) ||
      (z.label === 'Performance'  && ctlD >= 75 && ctlD < 95) ||
      (z.label === 'Elite'        && ctlD >= 95)
    );
    const border = i < zones.length - 1 ? 'border-bottom:1px solid var(--c-border);' : '';
    const youBadge = isCurrent
      ? `<span style="font-size:10px;background:rgba(0,0,0,0.06);color:var(--c-muted);padding:2px 6px;border-radius:4px;margin-left:6px;font-weight:500">you</span>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;${border}">
        <div style="width:8px;height:8px;border-radius:50%;background:${z.color};flex-shrink:0"></div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;font-weight:${isCurrent ? '700' : '500'};color:${isCurrent ? 'var(--c-black)' : 'var(--c-muted)'}">${z.label}${youBadge}</span>
            <span style="font-size:12px;font-weight:600;color:${isCurrent ? z.color : 'var(--c-faint)'}${isCurrent ? '' : ';opacity:0.7'}">${z.range}</span>
          </div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px;line-height:1.5">${z.desc}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px">
        <button id="ctl-lm-back" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div style="font-size:16px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">Running Load</div>
      </div>

      <!-- Content -->
      <div style="overflow-y:auto;padding:16px 16px 32px;display:flex;flex-direction:column;gap:12px">

        <!-- What it measures -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:8px">What it measures</div>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 10px">
            Running load tracks how much training your body has adapted to over the past 6 weeks.
            Every session gets a Load score (TSS) based on duration and intensity.
            Running load takes a rolling average of those daily scores, so recent weeks count more than older ones.
          </p>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
            Rising means your aerobic base is growing. Stable means consistent training. Falling means volume has dropped.
          </p>
        </div>

        <!-- Why activities count differently -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:8px">Why activities count differently</div>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 12px">
            Not all exercise translates equally to running load. Cycling is great for cardio but doesn't build the leg strength and impact tolerance that running requires.
            The percentages below reflect how transferable each activity is to running specifically. Running counts in full; everything else at a reduced rate.
          </p>
          <div style="display:flex;flex-direction:column;gap:4px">
            ${[
              ['Running',                  '100%'],
              ['Backcountry skiing',        '75%'],
              ['Cycling / mountain biking', '55%'],
              ['Walking / hiking',          '40%'],
              ['Gym / HIIT',               '35%'],
              ['Swimming',                 '20%'],
            ].map(([act, pct], i, arr) => `
              <div style="display:flex;justify-content:space-between;padding:7px 0;${i < arr.length - 1 ? 'border-bottom:1px solid var(--c-border)' : ''}">
                <span style="font-size:13px;color:var(--c-muted)">${act}</span>
                <span style="font-size:13px;font-weight:600;color:var(--c-black)">${pct}</span>
              </div>`).join('')}
          </div>
        </div>

        <!-- Where you sit -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:10px">Where you sit</div>
          ${rows}
        </div>

        <!-- How your fitness grows -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:8px">How your fitness grows</div>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 10px">
            Running load rises slowly, typically 2 to 5 points per week.
            Pushing it up faster raises injury risk before your body has time to adapt.
          </p>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
            Recovery weeks every 3 to 4 weeks are part of the process. Fitness grows more reliably when hard training blocks are followed by a deliberate step-back week.
          </p>
        </div>

        <!-- Running load during taper -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:8px">Running load during taper</div>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 10px">
            Running load drops during taper. This is expected. Fitness does not disappear over 2 to 3 weeks. Fatigue clears while adaptation consolidates.
          </p>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
            Expect a 5 to 15 point drop during a marathon taper.
            Aim to race when fitness is stable or just starting to fall, not while it is still climbing.
          </p>
        </div>

      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

function renderCTLLearnMore(s: SimulatorState): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = buildCTLLearnMorePage(s);
  wireTabBarHandlers(navigateTab);
  const btn = document.getElementById('ctl-lm-back');
  if (!btn) return;
  const go = () => renderProgressDetail(s);
  btn.addEventListener('click', go);
  btn.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// FITNESS DETAIL PAGE
// ══════════════════════════════════════════════════════════════════════════════

function buildProgressScaleBars(s: SimulatorState, ctl: number, fitnessMetrics?: FitnessMetrics[]): string {
  const isFemale = s.biologicalSex === 'female';
  const zoneLabels = ['Building', 'Foundation', 'Trained', 'Well-Trained', 'Performance', 'Elite'] as const;

  // Bar 1: Running Load (CTL daily-equivalent)
  const ctlD = Math.round(ctl / 7);
  const ctlBreaks = [20, 40, 58, 75, 95];
  const ctlZoneIdx = ctlBreaks.findIndex(b => ctlD < b);
  const ctlZone = zoneLabels[ctlZoneIdx === -1 ? 5 : ctlZoneIdx];
  const ctlHasHistory = (fitnessMetrics?.length ?? 0) > 3;
  const ctlBar = buildOnePositionBar({
    title: 'Running Load',
    infoId: 'ctl',
    detailId: ctlHasHistory ? 'ctl' : undefined,
    value: ctl > 0 ? ctlD : null,
    valueLabel: String(ctlD),
    zoneName: ctlZone,
    scaleMin: 0,
    scaleMax: 150,
    zones: [
      { label: 'Building',     fraction:  20/150, color: 'rgba(56,189,248,0.18)'  },
      { label: 'Foundation',   fraction:  20/150, color: 'rgba(59,130,246,0.20)'  },
      { label: 'Trained',      fraction:  18/150, color: 'rgba(79,70,229,0.22)'   },
      { label: 'Well-Trained', fraction:  17/150, color: 'rgba(124,58,237,0.25)'  },
      { label: 'Performance',  fraction:  20/150, color: 'rgba(147,51,234,0.28)'  },
      { label: 'Elite',        fraction:  55/150, color: 'rgba(109,40,217,0.35)'  },
    ],
  });

  // Bar 2: VO2 Max (device value preferred, computed VDOT fallback)
  const vo2bar = s.vo2 ?? computeCurrentVDOT(s);
  const aerBreaks = isFemale ? [28, 35, 45, 55, 65] : [35, 42, 52, 60, 70];
  const aerZoneIdx = aerBreaks.findIndex(b => vo2bar < b);
  const aerZone = zoneLabels[aerZoneIdx === -1 ? 5 : aerZoneIdx];
  const aerZones = isFemale
    ? [
        { label: 'Building',     fraction:  8/60, color: 'rgba(56,189,248,0.18)'  },
        { label: 'Foundation',   fraction:  7/60, color: 'rgba(59,130,246,0.20)'  },
        { label: 'Trained',      fraction: 10/60, color: 'rgba(79,70,229,0.22)'   },
        { label: 'Well-Trained', fraction: 10/60, color: 'rgba(124,58,237,0.25)'  },
        { label: 'Performance',  fraction: 10/60, color: 'rgba(147,51,234,0.28)'  },
        { label: 'Elite',        fraction: 15/60, color: 'rgba(109,40,217,0.35)'  },
      ]
    : [
        { label: 'Building',     fraction: 15/60, color: 'rgba(56,189,248,0.18)'  },
        { label: 'Foundation',   fraction:  7/60, color: 'rgba(59,130,246,0.20)'  },
        { label: 'Trained',      fraction: 10/60, color: 'rgba(79,70,229,0.22)'   },
        { label: 'Well-Trained', fraction:  8/60, color: 'rgba(124,58,237,0.25)'  },
        { label: 'Performance',  fraction: 10/60, color: 'rgba(147,51,234,0.28)'  },
        { label: 'Elite',        fraction: 10/60, color: 'rgba(109,40,217,0.35)'  },
      ];
  const aerSubtitle = s.vo2 == null ? 'Estimated from training data' : undefined;
  const vdotHasHistory = (s.vdotHistory?.length ?? 0) > 3;
  const aerBar = buildOnePositionBar({
    title: 'VO2 Max',
    infoId: 'aerobic',
    detailId: vdotHasHistory ? 'vdot' : undefined,
    value: vo2bar > 0 ? vo2bar : null,
    valueLabel: Math.round(vo2bar).toString(),
    zoneName: aerZone,
    scaleMin: 20,
    scaleMax: 80,
    zones: aerZones,
    subtitle: aerSubtitle,
  });

  // Bar 3: Lactate Threshold
  const ltPace = s.lt ?? 0;
  const ltSlower = isFemale ? 380 : 360;
  const ltFaster = isFemale ? 180 : 160;
  const ltScore = ltPace > 0
    ? Math.min(100, Math.max(0, ((ltSlower - ltPace) / (ltSlower - ltFaster)) * 100))
    : null;
  const ltBreaks = [20, 40, 55, 70, 85];
  const ltZoneIdx = ltScore != null ? ltBreaks.findIndex(b => ltScore < b) : -1;
  const ltZoneName = ltScore != null ? zoneLabels[ltZoneIdx === -1 ? 5 : ltZoneIdx] : '—';
  const ltUnitPref = s.unitPref ?? 'km';
  const ltPaceSec = ltUnitPref === 'mi' ? ltPace * 1.60934 : ltPace;
  const ltPaceUnit = ltUnitPref === 'mi' ? '/mi' : '/km';
  const ltLabel = ltPace > 0
    ? `${Math.floor(ltPaceSec / 60)}:${String(Math.round(ltPaceSec % 60)).padStart(2, '0')}${ltPaceUnit}`
    : '—';
  let ltSubtitle: string | undefined;
  if (s.ltHR && s.ltHR > 0) {
    const pct = s.maxHR ? Math.round((s.ltHR / s.maxHR) * 100) : null;
    ltSubtitle = pct ? `${s.ltHR} bpm · ${pct}% max HR` : `${s.ltHR} bpm`;
  }
  const ltHistory = (s.physiologyHistory ?? []).filter(e => (e.ltPace ?? 0) > 0);
  const ltBar = buildOnePositionBar({
    title: 'Lactate Threshold',
    infoId: 'lt',
    detailId: ltHistory.length > 3 ? 'lt' : undefined,
    value: ltScore,
    valueLabel: ltLabel,
    zoneName: ltZoneName,
    scaleMin: 0,
    scaleMax: 100,
    zones: [
      { label: 'Building',     fraction: 20/100, color: 'rgba(56,189,248,0.18)'  },
      { label: 'Foundation',   fraction: 20/100, color: 'rgba(59,130,246,0.20)'  },
      { label: 'Trained',      fraction: 15/100, color: 'rgba(79,70,229,0.22)'   },
      { label: 'Well-Trained', fraction: 15/100, color: 'rgba(124,58,237,0.25)'  },
      { label: 'Performance',  fraction: 15/100, color: 'rgba(147,51,234,0.28)'  },
      { label: 'Elite',        fraction: 15/100, color: 'rgba(109,40,217,0.35)'  },
    ],
    subtitle: ltSubtitle,
  });

  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:14px">Your Numbers</div>
      ${ctlBar}
      ${aerBar}
      ${ltBar}
    </div>`;
}

/** Extract VO2 Max history from physiologyHistory (device data). */
function getVO2History(s: SimulatorState): Array<{ date: string; value: number }> {
  return (s.physiologyHistory ?? [])
    .filter(d => d.vo2max != null && d.vo2max > 0)
    .map(d => ({ date: d.date, value: d.vo2max! }));
}

/** Generic line chart for a dated value series (VO2 Max or VDOT). */
function buildVO2LineChart(data: Array<{ date: string; value: number }>): string {
  const n = data.length;
  if (n < 2) return chartEmptyState(55);

  const vals = data.map(d => d.value);
  const lo = Math.min(...vals) - 1;
  const hi = Math.max(...vals) + 1;
  const range2 = hi - lo || 1;
  const W = 320, H = 50;
  const xOf = (i: number) => (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((v - lo) / range2) * (H - 8));
  const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${W} ${H} L 0 ${H} Z`;
  const lastVal = vals[n - 1];
  const prevVal = vals[n - 2];
  const rising = lastVal >= prevVal - 0.05;
  const strokeColor = rising ? 'rgba(52,199,89,0.85)' : 'rgba(255,69,58,0.80)';
  const fillColor   = rising ? 'rgba(52,199,89,0.12)' : 'rgba(255,69,58,0.10)';

  const firstDate = data[0].date.slice(5);
  const lastDate  = data[n - 1].date.slice(5);
  const gradId = `vo2Fill_${rising ? 'up' : 'dn'}`;

  return `
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="90" preserveAspectRatio="none" style="display:block">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.05"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${gradId})"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--c-faint)">
        <span>${firstDate}</span>
        <span>${lastDate}</span>
      </div>
    </div>`;
}

/** Fallback: VDOT line chart when no device VO2 data exists. */
function buildVdotLineChart(history: Array<{ week: number; vdot: number; date?: string }>, range: ChartRange): string {
  const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
  const sliced = sliceCount !== undefined ? history.slice(-sliceCount) : history;
  return buildVO2LineChart(sliced.map(h => ({ date: h.date ?? `Wk ${h.week}`, value: h.vdot })));
}

/** VO2 Max change note from device history. */
function buildVO2ChangeNote(data: Array<{ date: string; value: number }>): string {
  if (data.length < 2) return '';
  const latest = data[data.length - 1];
  const prev   = data[data.length - 2];
  const delta  = latest.value - prev.value;
  const absDelta = Math.abs(delta).toFixed(0);
  if (Math.abs(delta) < 0.5) {
    return `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">Stable over the last ${data.length} days.</div>`;
  } else if (delta < 0) {
    return `<div style="font-size:11px;color:var(--c-warn);margin-top:4px">↓ ${absDelta} since ${prev.date}.</div>`;
  } else {
    return `<div style="font-size:11px;color:var(--c-ok);margin-top:4px">↑ ${absDelta} since ${prev.date}.</div>`;
  }
}

/** Fallback: VDOT change note when no device VO2 data exists. */
function buildVdotChangeNote(history: Array<{ week: number; vdot: number; date?: string }>): string {
  if (history.length < 2) return '';
  const latest = history[history.length - 1];
  const prev   = history[history.length - 2];
  const delta  = latest.vdot - prev.vdot;
  const absDelta = Math.abs(delta).toFixed(1);
  const sinceDate = prev.date ?? `week ${prev.week}`;
  if (Math.abs(delta) < 0.1) {
    return `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">Steady, consistent with recent training.</div>`;
  } else if (delta < 0) {
    return `<div style="font-size:11px;color:var(--c-warn);margin-top:4px">↓ ${absDelta} pts since ${sinceDate}. Recent runs have felt harder than planned, or threshold pace was recalibrated.</div>`;
  } else {
    return `<div style="font-size:11px;color:var(--c-ok);margin-top:4px">↑ ${absDelta} pts since ${sinceDate}. Fitness is building.</div>`;
  }
}

function buildFitnessDetailPage(s: SimulatorState): string {
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const latest  = metrics[metrics.length - 1];
  const ctl = latest?.ctl ?? 0;
  const vo2hist = getVO2History(s);
  const vdotHist = s.vdotHistory ?? [];
  const hasDeviceVO2 = vo2hist.length >= 2;
  const vo2detail = s.vo2 ?? computeCurrentVDOT(s);
  const isEstimated = s.vo2 == null;

  // Trend arrow: use device VO2 history if available, else VDOT history
  let trendArrow = '→';
  let trendColor = 'var(--c-faint)';
  if (hasDeviceVO2) {
    const d = vo2hist[vo2hist.length - 1].value - vo2hist[vo2hist.length - 2].value;
    trendArrow = d > 0.5 ? '↑' : d < -0.5 ? '↓' : '→';
    trendColor = d > 0.5 ? 'var(--c-ok)' : d < -0.5 ? 'var(--c-warn)' : 'var(--c-faint)';
  } else if (vdotHist.length >= 2) {
    const d = vdotHist[vdotHist.length - 1].vdot - vdotHist[vdotHist.length - 2].vdot;
    trendArrow = d > 0.1 ? '↑' : d < -0.1 ? '↓' : '→';
    trendColor = d > 0.1 ? 'var(--c-ok)' : d < -0.1 ? 'var(--c-warn)' : 'var(--c-faint)';
  }

  const hasChart = hasDeviceVO2 || vdotHist.length >= 2;
  const unitPref: UnitPref = s.unitPref ?? 'km';

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Fitness')}

      <div style="padding:12px 18px 14px;overflow-y:auto">

        <!-- Scale bars -->
        ${buildProgressScaleBars(s, ctl, metrics)}

        <!-- VO2 Max Trend Chart -->
        ${hasChart ? `
        <div class="m-card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--c-black)">VO2 Max${isEstimated ? ' (est.)' : ''}</div>
              <div style="display:flex;align-items:baseline;gap:6px;margin-top:2px">
                <span style="font-size:22px;font-weight:300;color:var(--c-black)">${vo2detail > 0 ? Math.round(vo2detail) : '—'}</span>
                <span style="font-size:16px;color:${trendColor}">${trendArrow}</span>
              </div>
            </div>
            ${!hasDeviceVO2 ? buildRangeToggle('8w', 'fitness-range-btn') : ''}
          </div>
          <div id="fitness-vdot-chart">${hasDeviceVO2 ? buildVO2LineChart(vo2hist) : buildVdotLineChart(vdotHist, '8w')}</div>
          ${hasDeviceVO2 ? buildVO2ChangeNote(vo2hist) : buildVdotChangeNote(vdotHist)}
        </div>` : ''}

        <!-- Race forecast -->
        ${buildForecastTimesCard(s)}

        ${buildCalibrationStatus(s)}
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// METRIC HISTORY SUB-PAGES
// ══════════════════════════════════════════════════════════════════════════════

function buildMetricSubHeader(title: string): string {
  return `
    <div style="padding:max(16px, env(safe-area-inset-top)) 18px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--c-border)">
      <button id="stats-metric-back" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:20px;color:var(--c-black);font-family:var(--f);flex-shrink:0;margin-left:-8px">←</button>
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">${title}</div>
    </div>`;
}

function buildCTLMetricPage(s: SimulatorState): string {
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const vals = metrics.map(m => Math.round(m.ctl / 7));
  const n = vals.length;
  const currentCtl = vals[n - 1] ?? 0;

  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...vals, 1) * 1.15;
  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));
  const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const tickStep = maxVal <= 50 ? 10 : maxVal <= 100 ? 25 : 50;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.95; v += tickStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1">${v}</span>`);
  }

  const labelStep = n > 20 ? 4 : n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep);

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildMetricSubHeader('Running Load')}
      <div style="padding:18px;overflow-y:auto">
        <div style="margin-bottom:4px;font-size:28px;font-weight:300;color:var(--c-black)">${currentCtl}</div>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:20px">Daily-equivalent CTL · 42-day running average</div>
        <div class="m-card" style="padding:16px">
          <div style="position:relative;padding-right:36px">
            <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
              ${chartGridLines(maxVal, yOf, W, padL, padR)}
              <path d="${areaPath}" fill="${CHART_FILL}" stroke="none"/>
              <path d="${topPath}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
            <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
            <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
          </div>
        </div>
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

function buildVDOTMetricPage(s: SimulatorState): string {
  const vo2hist = getVO2History(s);
  const hasDeviceVO2 = vo2hist.length >= 2;
  const vo2metric = s.vo2 ?? computeCurrentVDOT(s);
  const isEstimated = s.vo2 == null;

  // Trend from device VO2 history or VDOT history
  let trendArrow = '→';
  let trendColor = 'var(--c-faint)';
  if (hasDeviceVO2) {
    const d = vo2hist[vo2hist.length - 1].value - vo2hist[vo2hist.length - 2].value;
    trendArrow = d > 0.5 ? '↑' : d < -0.5 ? '↓' : '→';
    trendColor = d > 0.5 ? 'var(--c-ok)' : d < -0.5 ? 'var(--c-warn)' : 'var(--c-faint)';
  } else {
    const hist = s.vdotHistory ?? [];
    if (hist.length >= 2) {
      const d = hist[hist.length - 1].vdot - hist[hist.length - 2].vdot;
      trendArrow = d > 0.1 ? '↑' : d < -0.1 ? '↓' : '→';
      trendColor = d > 0.1 ? 'var(--c-ok)' : d < -0.1 ? 'var(--c-warn)' : 'var(--c-faint)';
    }
  }

  // Build chart from device data or VDOT fallback
  const chartHtml = hasDeviceVO2
    ? buildVO2LineChart(vo2hist)
    : (() => {
        const hist = s.vdotHistory ?? [];
        return buildVO2LineChart(hist.map(h => ({ date: h.date ?? `Wk ${h.week}`, value: h.vdot })));
      })();

  const changeNote = hasDeviceVO2
    ? buildVO2ChangeNote(vo2hist)
    : buildVdotChangeNote(s.vdotHistory ?? []);

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildMetricSubHeader('VO2 Max')}
      <div style="padding:18px;overflow-y:auto">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="font-size:28px;font-weight:300;color:var(--c-black)">${vo2metric > 0 ? Math.round(vo2metric) : '—'}</span>
          <span style="font-size:18px;color:${trendColor}">${trendArrow}</span>
        </div>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:20px">${isEstimated ? 'Estimated from training data (VDOT)' : 'From device'}</div>
        <div class="m-card" style="padding:16px">
          ${chartHtml}
        </div>
        ${changeNote}
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

function buildLTMetricPage(s: SimulatorState): string {
  const unitPref = s.unitPref ?? 'km';
  const hist = (s.physiologyHistory ?? []).filter(e => (e.ltPace ?? 0) > 0);
  const currentLT = s.lt ?? 0;
  const ltLabel = currentLT > 0 ? fp(currentLT, unitPref) : '—';

  const vals = hist.map(e => e.ltPace!);
  const n = vals.length;
  // LT pace: lower = faster = better, so invert for display
  const lo = Math.min(...vals) - 5;
  const hi = Math.max(...vals) + 5;
  const range2 = hi - lo || 1;
  const W = 320, H = 60;
  const xOf = (i: number) => (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((hi - v) / range2) * (H - 8)); // inverted: lower pace = higher on chart
  const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${W} ${H} L 0 ${H} Z`;
  const trend = n >= 2 ? vals[n-1] - vals[n-2] : 0;
  // improving = pace decreasing (faster)
  const improving = trend < 0;
  const strokeColor = improving ? 'rgba(52,199,89,0.85)' : 'rgba(255,69,58,0.80)';
  const fillColor   = improving ? 'rgba(52,199,89,0.12)' : 'rgba(255,69,58,0.10)';
  const trendArrow = trend < -1 ? '↑' : trend > 1 ? '↓' : '→';
  const trendColor = trend < -1 ? 'var(--c-ok)' : trend > 1 ? 'var(--c-warn)' : 'var(--c-faint)';

  const firstDate = hist[0].date.slice(5);
  const lastDate  = hist[n-1].date.slice(5);

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildMetricSubHeader('Lactate Threshold')}
      <div style="padding:18px;overflow-y:auto">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <span style="font-size:28px;font-weight:300;color:var(--c-black)">${ltLabel}</span>
          <span style="font-size:18px;color:${trendColor}">${trendArrow}</span>
        </div>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:20px">Lactate threshold pace · from Garmin</div>
        <div class="m-card" style="padding:16px">
          <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
            <path d="${areaPath}" fill="${fillColor}" stroke="none"/>
            <path d="${topPath}" class="chart-draw" fill="none" stroke="${strokeColor}" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <div style="display:flex;justify-content:space-between;padding:3px 0 0">
            <span style="font-size:9px;color:var(--c-faint)">${firstDate}</span>
            <span style="font-size:9px;color:var(--c-faint)">${lastDate}</span>
          </div>
        </div>
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

/** Race progress detail card. */
function buildRaceProgressDetail(s: SimulatorState): string {
  if (s.continuousMode || !s.initialBaseline || !s.currentFitness) return '';
  const initial  = s.initialBaseline;
  const current  = s.currentFitness;
  const forecast = s.forecastTime ?? current;
  const onTrack  = forecast <= initial * 1.005;
  const totalImp = initial - forecast;
  const curImp   = initial - current;
  const pct = totalImp > 0 ? Math.min(100, Math.max(0, Math.round((curImp / totalImp) * 100))) : 0;

  const fmtT = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sc = Math.round(secs % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${m}:${String(sc).padStart(2,'0')}`;
  };

  const statusColor = onTrack ? 'var(--c-ok)' : 'var(--c-warn)';
  const statusIcon  = onTrack ? '↗' : '↘';
  const statusLabel = onTrack ? 'On track' : 'Off track';

  return `
    <div class="m-card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint)">Race Forecast</div>
        <span style="font-size:11px;font-weight:600;color:${statusColor}">${statusIcon} ${statusLabel}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:12px">
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">Start</div>
          <div style="font-size:18px;font-weight:300;color:var(--c-muted)">${fmtT(initial)}</div>
        </div>
        <div style="text-align:center;border-left:1px solid var(--c-border);border-right:1px solid var(--c-border)">
          <div style="font-size:9px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">Today</div>
          <div style="font-size:18px;font-weight:600;color:var(--c-black)">${fmtT(current)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">Forecast</div>
          <div style="font-size:18px;font-weight:600;color:${statusColor}">${fmtT(forecast)}</div>
        </div>
      </div>
      ${totalImp > 0 ? `
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-muted);margin-bottom:5px">
        <span>Progress to forecast</span><span style="color:${statusColor};font-weight:600">${pct}%</span>
      </div>
      <div style="height:5px;background:rgba(0,0,0,0.07);border-radius:3px;overflow:hidden">
        <div style="height:100%;background:${statusColor};border-radius:3px;width:${pct}%"></div>
      </div>` : ''}
    </div>`;
}

/**
 * Marathon fade-risk signal from long-run HR drift.
 *
 * Drift on long runs at goal marathon pace is a reliable predictor of last-10k
 * fade. Persistent >8% drift on these sessions means the aerobic system is
 * already losing pace control at the duration required by the race.
 *
 * Filters to long runs (≥90 min) in the last 4 weeks whose average pace falls
 * within ±15 sec/km of the goal MP. Returns null if fewer than 2 such sessions
 * exist — not enough signal to make a claim.
 */
function computeMarathonFadeRisk(
  s: SimulatorState,
  goalMpSecKm: number,
): { level: 'low' | 'mod' | 'high'; avgDrift: number } | null {
  const weeksToScan = 4;
  const currentIdx = Math.max(0, (s.w ?? 1) - 1);
  const startIdx = Math.max(0, currentIdx - weeksToScan + 1);
  const paceBand = 15;
  const drifts: number[] = [];

  for (let i = startIdx; i <= currentIdx; i++) {
    const wk = (s.wks ?? [])[i];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (actual.plannedType !== 'long') continue;
      if (typeof actual.hrDrift !== 'number' || isNaN(actual.hrDrift)) continue;
      if (typeof actual.durationSec !== 'number' || actual.durationSec < 5400) continue;
      const pace = actual.avgPaceSecKm;
      if (typeof pace !== 'number' || pace <= 0) continue;
      if (Math.abs(pace - goalMpSecKm) > paceBand) continue;
      drifts.push(heatAdjust(actual.hrDrift, actual.ambientTempC));
    }
  }

  if (drifts.length < 2) return null;
  const avg = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const level: 'low' | 'mod' | 'high' = avg > 8 ? 'high' : avg > 5 ? 'mod' : 'low';
  return { level, avgDrift: avg };
}

/** Forecast times card (standalone). Uses blendPredictions (LT, VO2, PB, recent
 *  run) when available; falls back to pure VDOT-to-time when no watch data. */
function buildForecastTimesCard(s: SimulatorState): string {
  const vdot = computeCurrentVDOT(s);
  if (!vdot || vdot < 20) return '';

  const fmtTime = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sc = Math.round(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    return `${m}:${String(sc).padStart(2,'0')}`;
  };

  const hasBlendInputs = !!(s.lt || s.vo2 || s.pbs?.k5 || s.pbs?.k10 || s.pbs?.h || s.pbs?.m);
  // Use HR-scaled recent run from garminActuals instead of stale onboarding rec
  const inputs = computePredictionInputs(collectRunActivities(s));
  const liveRec = inputs.recentRun ?? s.rec ?? null;
  const liveKmPerWeek = inputs.weeklyKm;
  const liveAvgPace = inputs.avgPaceSecPerKm ?? null;

  const distances = [
    { label: 'Marathon', dist: 42195, km: 42.195 },
    { label: 'Half',     dist: 21097, km: 21.0975 },
    { label: '10K',      dist: 10000, km: 10 },
    { label: '5K',       dist: 5000,  km: 5 },
  ];

  const rows = distances.map((d, i) => {
    let timeSec: number;
    if (hasBlendInputs) {
      const blended = blendPredictions(
        d.dist, s.pbs ?? {}, s.lt ?? null, s.vo2 ?? vdot,
        s.b ?? 1.06, s.typ ?? 'Balanced', liveRec,
        s.athleteTier ?? undefined, liveKmPerWeek, liveAvgPace ?? undefined,
        { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
      );
      timeSec = (blended && blended > 0) ? blended : vt(d.km, vdot);
    } else {
      timeSec = vt(d.km, vdot);
    }
    const isLast = i === distances.length - 1;

    // Fade-risk badge — marathon only, based on long-run drift at goal MP
    let fadeBadge = '';
    if (d.label === 'Marathon' && timeSec > 0) {
      const goalMpSecKm = timeSec / d.km;
      const risk = computeMarathonFadeRisk(s, goalMpSecKm);
      if (risk) {
        const colorMap = {
          low: { bg: 'rgba(52,199,89,0.12)', fg: '#15803D', label: 'Low' },
          mod: { bg: 'rgba(245,158,11,0.12)', fg: '#B45309', label: 'Moderate' },
          high: { bg: 'rgba(239,68,68,0.12)', fg: '#DC2626', label: 'High' },
        } as const;
        const c = colorMap[risk.level];
        fadeBadge = `<span style="font-size:10px;font-weight:600;color:${c.fg};background:${c.bg};padding:2px 7px;border-radius:10px;margin-right:8px;letter-spacing:0.02em">Fade risk: ${c.label}</span>`;
      }
    }

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--c-border)'}">
        <span style="font-size:13px;color:var(--c-muted)">${d.label}</span>
        <span style="display:flex;align-items:center">${fadeBadge}<span style="font-size:16px;font-weight:600;color:var(--c-black)">${fmtTime(timeSec)}</span></span>
      </div>`;
  }).join('');

  return `
    <div class="m-card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:2px">Current Race Estimates</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:8px">Estimated finish times if racing today</div>
      ${rows}
    </div>`;
}

/** Training paces card (standalone). */
function buildPacesCard(s: SimulatorState, unitPref: UnitPref): string {
  if (!s.pac) return '';
  const paces = [
    { label: 'Easy',      value: s.pac.e, color: 'var(--c-ok)' },
    { label: 'Marathon',  value: s.pac.m, color: 'var(--c-accent)' },
    { label: 'Threshold', value: s.pac.t, color: 'var(--c-caution)' },
    { label: 'VO2max',    value: s.pac.i, color: 'var(--c-warn)' },
  ].filter(p => p.value);

  if (!paces.length) return '';

  return `
    <div class="m-card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:10px">Training Paces</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${paces.map(p => `
          <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:9px 11px;display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;color:var(--c-muted)">${p.label}</span>
            <span style="font-size:14px;font-weight:600;color:${p.color}">${fp(p.value!, unitPref)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// READINESS DETAIL PAGE
// ══════════════════════════════════════════════════════════════════════════════

/** TSB trend line chart. */
function buildTSBLineChart(s: SimulatorState, range: ChartRange): string {
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  if (metrics.length < 3) return chartEmptyState(65);

  const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
  const sliced = sliceCount !== undefined ? metrics.slice(-sliceCount) : metrics;
  const n = sliced.length;
  if (n < 3) return chartEmptyState(65);

  const tsbVals = sliced.map(m => m.tsb);
  const W = 320, H = 60, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const rawMin = Math.min(...tsbVals);
  const rawMax = Math.max(...tsbVals);
  const pad = Math.max((rawMax - rawMin) * 0.30, 8);
  const minV = rawMin - pad;
  const maxV = rawMax + pad;
  const spanV = maxV - minV || 1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => padL + ((maxV - v) / spanV) * (H - 2 * padL);

  const pts: [number, number][] = tsbVals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Reference y positions
  const zeroY = yOf(0).toFixed(1);
  const y15   = yOf(15).toFixed(1);
  const yn10  = yOf(-10).toFixed(1);

  const labelStep = n > 12 ? 2 : 1;
  const labels = buildWeekLabels(n, labelStep);

  // Y-axis labels at key reference values
  const tsbRefVals = [-10, 0, 15].filter(v => v >= minV && v <= maxV);
  const tsbYAxisHtml = tsbRefVals.map(v => {
    const label = v > 0 ? `+${v}` : String(v);
    return `<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:#94A3B8;line-height:1;font-variant-numeric:tabular-nums">${label}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        <!-- Zone background bands -->
        <rect x="${padL}" y="${y15}" width="${usableW}" height="${(Number(zeroY) - Number(y15)).toFixed(1)}" fill="rgba(52,199,89,0.07)"/>
        <rect x="${padL}" y="${zeroY}" width="${usableW}" height="${(Number(yn10) - Number(zeroY)).toFixed(1)}" fill="rgba(78,159,229,0.06)"/>
        <!-- Zero reference line only -->
        <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="rgba(0,0,0,0.12)" stroke-width="0.8" stroke-dasharray="3 3"/>
        <!-- Area fill + line -->
        <path d="${areaPath}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${tsbYAxisHtml}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

/** Area chart for a 7-day physiology metric (HRV, RHR). Returns '' when < 2 data points. */
function buildPhysioAreaChart(
  entries: Array<{ value: number | null; day: string }>,
  color: string,
): string {
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';
  const W = 320, H = 28;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const pad = Math.max((hi - lo) * 0.20, 2);
  const minV = lo - pad, maxV = hi + pad, spanV = maxV - minV;
  const n = entries.length;
  const xOf = (i: number) => n <= 1 ? W / 2 : (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((v - minV) / spanV) * (H - 4));
  const pts: [number, number][] = entries
    .map((e, i) => e.value != null ? [xOf(i), yOf(e.value)] as [number, number] : null)
    .filter((p): p is [number, number] => p != null);
  if (pts.length < 2) return '';
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${pts[pts.length-1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;
  const dayLabels = entries.map(e =>
    `<span style="font-size:8px;color:var(--c-faint)">${e.day}</span>`
  ).join('');
  return `
    <div style="margin-top:6px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        <path d="${areaPath}" fill="${color}" fill-opacity="0.12" stroke="none"/>
        <path d="${topPath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="display:flex;justify-content:space-between;padding:2px 0 0">${dayLabels}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Readiness accordion helpers

/** Physio area chart with a baseline reference line and current-value label. */
function buildPhysioChartWithBaseline(
  entries: Array<{ value: number | null; day: string }>,
  color: string,
  baselineValue: number | null,
  unit: string,
): string {
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';
  const W = 320, H = 36;
  const allVals = baselineValue != null ? [...nums, baselineValue] : nums;
  const lo = Math.min(...allVals);
  const hi = Math.max(...allVals);
  const pad = Math.max((hi - lo) * 0.30, 3);
  const minV = lo - pad, maxV = hi + pad, spanV = maxV - minV;
  const n = entries.length;
  const xOf = (i: number) => n <= 1 ? W / 2 : (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((v - minV) / spanV) * (H - 6));
  const pts: [number, number][] = entries
    .map((e, i) => e.value != null ? [xOf(i), yOf(e.value)] as [number, number] : null)
    .filter((p): p is [number, number] => p != null);
  if (pts.length < 2) return '';
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${pts[pts.length-1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;

  const baselineLine = baselineValue != null ? (() => {
    const by = yOf(baselineValue).toFixed(1);
    return `
      <line x1="0" y1="${by}" x2="${W}" y2="${by}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3" opacity="0.40"/>`;
  })() : '';

  const dayLabels = entries.map(e =>
    `<span style="font-size:8px;color:var(--c-faint)">${e.day}</span>`
  ).join('');

  return `
    <div style="margin-top:8px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${baselineLine}
        <path d="${areaPath}" fill="${color}" fill-opacity="0.10" stroke="none"/>
        <path d="${topPath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="display:flex;justify-content:space-between;padding:2px 0 0">${dayLabels}</div>
    </div>`;
}

/** ACWR trend line chart: 8 weeks, reference lines at 1.0 / 1.3 / 1.5. */
function buildACWRTrendChart(s: SimulatorState): string {
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  if (metrics.length < 3) return chartEmptyState(55);
  const sliced = metrics.slice(-8);
  const n = sliced.length;
  if (n < 3) return chartEmptyState(55);

  const acwrVals = sliced.map(m => m.ctl > 0 ? Math.min(2.5, m.atl / m.ctl) : 0);
  const W = 320, H = 55, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const maxVal = Math.max(...acwrVals, 1.6) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = acwrVals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const lastV = acwrVals[n - 1];
  const lineColor = lastV > 1.5 ? 'rgba(255,69,58,0.80)' : lastV > 1.3 ? 'rgba(255,159,10,0.80)' : CHART_STROKE;
  const areaColor = lastV > 1.5 ? 'rgba(255,69,58,0.10)' : lastV > 1.3 ? 'rgba(255,159,10,0.10)' : CHART_FILL;

  const refs: Array<{ v: number; color: string }> = [
    { v: 1.3, color: 'rgba(255,159,10,0.40)' },
    { v: 1.5, color: 'rgba(255,69,58,0.40)'  },
  ];

  const refLinesSvg = refs.filter(r => yOf(r.v) > 4 && yOf(r.v) < H - 4).map(r => {
    const ry = yOf(r.v).toFixed(1);
    return `<line x1="${padL}" y1="${ry}" x2="${W-padR}" y2="${ry}" stroke="${r.color}" stroke-width="0.8" stroke-dasharray="3 3"/>`;
  }).join('');
  // Y-axis labels at reference thresholds
  const acwrYAxisHtml = refs.filter(r => yOf(r.v) > 4 && yOf(r.v) < H - 4).map(r =>
    `<span style="position:absolute;top:${(yOf(r.v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:${r.color.replace(',0.40)', ',0.8)')};line-height:1;font-variant-numeric:tabular-nums">${r.v}</span>`
  ).join('');

  const labels = buildWeekLabels(n, n > 12 ? 2 : 1);

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${chartGridLines(maxVal, yOf, W, padL, padR)}
        ${refLinesSvg}
        <path d="${areaPath}" fill="${areaColor}" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${acwrYAxisHtml}</div>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
    </div>`;
}

/** One accordion row: zone bar + collapsible trend body. */
function buildReadinessAccRow(opts: {
  id: string;
  title: string;
  value: string;
  valueColor: string;
  detail: string;
  zones: PositionZone[];
  markerPct: number | null;
  bodyHtml: string;
  separator?: boolean;
}): string {
  const { id, title, value, valueColor, detail, zones, markerPct, bodyHtml, separator } = opts;

  // Zone segment backgrounds
  const bgSegs = zones.map(z =>
    `<div style="flex:${z.fraction};height:100%;background:${z.color}"></div>`
  ).join('');

  // White divider ticks at zone boundaries
  let cum = 0;
  const boundaries: number[] = [];
  zones.slice(0, -1).forEach(z => { cum += z.fraction; boundaries.push(cum * 100); });
  const dividers = boundaries.map(pct =>
    `<div style="position:absolute;top:0;left:${pct.toFixed(2)}%;width:1.5px;height:100%;background:rgba(255,255,255,0.55);z-index:1"></div>`
  ).join('');

  // White gap marker
  const marker = markerPct != null
    ? `<div style="position:absolute;top:0;left:${markerPct.toFixed(1)}%;transform:translateX(-50%);width:3px;height:100%;background:white;z-index:4;border-radius:1px"></div>`
    : '';

  // Zone labels: active one highlighted in valueColor
  let cumLabel = 0;
  let activeZone = zones[0]?.label ?? '';
  if (markerPct != null) {
    let cumPct = 0;
    for (const z of zones) {
      cumPct += z.fraction * 100;
      if (markerPct <= cumPct) { activeZone = z.label; break; }
    }
  }
  const zoneLabels = zones.map(z => {
    const mid = (cumLabel + z.fraction / 2) * 100;
    cumLabel += z.fraction;
    const isActive = z.label === activeZone;
    return `<span style="position:absolute;left:${mid.toFixed(1)}%;transform:translateX(-50%);font-size:8px;white-space:nowrap;${isActive ? `color:${valueColor};font-weight:700` : 'color:var(--c-faint);font-weight:400'}">${z.label}</span>`;
  }).join('');

  const sep = separator
    ? '<div style="height:1px;background:var(--c-border);margin:8px -16px 14px -16px"></div>'
    : '';

  return `
    ${sep}
    <div class="readiness-acc-hdr" data-acc="${id}" style="cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
        <span style="font-size:13px;font-weight:600;color:var(--c-black)">${title}</span>
        <span style="display:flex;align-items:center;gap:6px">
          <span style="font-size:15px;font-weight:600;color:${valueColor}">${value}</span>
          <span style="font-size:11px;color:var(--c-muted)">${detail}</span>
          <span id="readiness-chevron-${id}" style="font-size:11px;color:var(--c-faint);min-width:10px">▸</span>
        </span>
      </div>
      <div style="position:relative;height:12px;border-radius:6px;overflow:hidden;display:flex;margin-bottom:4px">
        ${bgSegs}
        ${marker}
        ${dividers}
      </div>
      <div style="position:relative;height:16px;margin-bottom:4px">${zoneLabels}</div>
    </div>
    <div id="readiness-acc-${id}" style="display:none;padding-top:6px">
      ${bodyHtml}
    </div>`;
}

/** Expanded body for the Recovery accordion row. */
function buildRecoveryAccordionBody(
  s: SimulatorState,
  physioHistory: PhysiologyDayEntry[],
  recovery: import('@/calculations/readiness').RecoveryScoreResult,
): string {
  if (!recovery.hasData) {
    const physSrc = getPhysiologySource(s);
    const manualEntries = (s.recoveryHistory ?? []).filter((e: any) => e.source === 'manual');
    if (!physSrc && manualEntries.length > 0) {
      // No watch but user has been logging manually — show their trend
      const recent = manualEntries.slice(-7);
      const avg = Math.round(recent.reduce((sum: number, e: any) => sum + (e.sleepScore ?? 0), 0) / recent.length);
      return `<div style="padding:8px 0 14px">
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">${recent.length} manual sleep log${recent.length === 1 ? '' : 's'} in the last 7 days. Average: <span style="font-weight:600;color:var(--c-black)">${avg}/100</span></div>
        <div style="font-size:11px;color:var(--c-faint)">Connect a watch for automatic HRV, resting heart rate, and sleep stage tracking.</div>
      </div>`;
    }
    const staleMsg = recovery.dataStale
      ? `Data last synced ${recovery.lastSyncDate ?? ''}. Open ${physSrc === 'apple' ? 'the Health app' : 'Garmin Connect'} and sync your watch.`
      : physSrc
        ? 'No recovery data yet. Sleep and HRV data will appear after your next night of tracked sleep.'
        : 'Connect a watch or recovery device to see your recovery breakdown.';
    return `<div style="padding:8px 0 14px;font-size:12px;color:${recovery.dataStale ? 'var(--c-caution)' : 'var(--c-faint)'}">${staleMsg}</div>`;
  }

  // Sleep
  const sleepEntries = physioBarEntries(physioHistory.slice(-7), 'sleepScore');
  const sleepHasChart = sleepEntries.filter(e => e.value != null).length >= 2;
  const sleepSection = recovery.sleepScore != null ? `
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:var(--c-black)">Sleep</span>
        <span style="font-size:15px;font-weight:600;color:${sleepScoreColor(recovery.sleepScore)}">${recovery.sleepScore}<span style="font-size:10px;font-weight:400;color:var(--c-faint)">/100</span></span>
      </div>
      ${sleepHasChart ? buildBarChart(sleepEntries, sleepScoreColor) : '<div style="font-size:11px;color:var(--c-faint)">Not enough data yet</div>'}
      <button id="stats-sleep-detail-btn" style="margin-top:10px;width:100%;padding:7px;border-radius:8px;border:1px solid var(--c-border);cursor:pointer;font-size:12px;font-weight:500;background:rgba(0,0,0,0.03);color:var(--c-black);font-family:var(--f)">Sleep detail →</button>
    </div>` : '';

  // HRV
  const hrvEntries = physioBarEntries(physioHistory.slice(-7), 'hrvRmssd');
  const baselineHrvs = physioHistory.slice(-28).map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const hrvBaseline = baselineHrvs.length >= 5 ? Math.round(baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length) : null;
  const lastHrv = recovery.lastNightHrv;
  const hrvSection = recovery.hrvScore != null ? `
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
        <span style="font-size:13px;font-weight:600;color:var(--c-black)">HRV (RMSSD)</span>
        <span style="font-size:15px;font-weight:600;color:#A855F7">${lastHrv != null ? Math.round(lastHrv) + ' ms' : '—'}</span>
      </div>
      ${hrvBaseline != null ? `<div style="font-size:10px;color:var(--c-faint);margin-bottom:2px">Your 28-day average: ${hrvBaseline} ms</div>` : ''}
      ${buildPhysioChartWithBaseline(hrvEntries, '#A855F7', hrvBaseline, ' ms')}
    </div>` : '';

  // Resting HR
  const rhrEntries = physioBarEntries(physioHistory.slice(-7), 'restingHR');
  const baselineRhrs = physioHistory.slice(-28).map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const rhrBaseline = baselineRhrs.length >= 5 ? Math.round(baselineRhrs.reduce((a, b) => a + b, 0) / baselineRhrs.length) : null;
  const lastRhr = physioHistory.filter(d => d.restingHR != null).slice(-1)[0]?.restingHR;
  const rhrSection = recovery.rhrScore != null ? `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
        <span style="font-size:13px;font-weight:600;color:var(--c-black)">Resting HR</span>
        <span style="font-size:15px;font-weight:600;color:#EF4444">${lastRhr != null ? Math.round(lastRhr) + ' bpm' : '—'}</span>
      </div>
      ${rhrBaseline != null ? `<div style="font-size:10px;color:var(--c-faint);margin-bottom:2px">Your 28-day average: ${rhrBaseline} bpm</div>` : ''}
      ${buildPhysioChartWithBaseline(rhrEntries, '#EF4444', rhrBaseline, ' bpm')}
    </div>` : '';

  return `<div style="padding-bottom:14px">${sleepSection}${hrvSection}${rhrSection}</div>`;
}


function buildReadinessDetailPage(s: SimulatorState): string {
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Readiness')}
      <div style="padding:8px 18px 80px;overflow-y:auto">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);padding:8px 0 4px;border-bottom:1px solid var(--c-border);margin-bottom:12px">Load</div>
        ${buildFreshnessCard(s)}
        ${buildInjuryRiskCard(s)}
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);padding:16px 0 4px;border-bottom:1px solid var(--c-border);margin-bottom:12px">Recovery</div>
        ${buildHRVCard(s)}
        ${buildRHRCard(s)}
        ${buildSleepCard(s)}
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// STATS SCROLL — flat metric dashboard (redesigned 2026-03-22)
// One card per metric: spectrum bar above chart, fully labelled, consultant tone.
// ══════════════════════════════════════════════════════════════════════════════

const SCROLL_CHEVRON = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-left:4px;flex-shrink:0"><path d="M5 3l4 4-4 4" stroke="var(--c-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Compact 6px spectrum bar with zone labels below. Placed above charts. */
function buildInlineSpectrumBar(
  zones: PositionZone[],
  markerPct: number | null,
  activeLabel: string,
): string {
  const bgSegs = zones.map(z =>
    `<div style="flex:${z.fraction};height:100%;background:${z.color}"></div>`
  ).join('');

  let cum = 0;
  const boundaries: number[] = [];
  zones.slice(0, -1).forEach(z => { cum += z.fraction; boundaries.push(cum * 100); });
  const dividers = boundaries.map(pct =>
    `<div style="position:absolute;top:0;left:${pct.toFixed(2)}%;width:1.5px;height:100%;background:rgba(255,255,255,0.55);z-index:1"></div>`
  ).join('');

  const marker = markerPct != null
    ? `<div style="position:absolute;top:0;left:${markerPct.toFixed(1)}%;transform:translateX(-50%);width:3px;height:100%;background:white;z-index:4;border-radius:1px"></div>`
    : '';

  return `
    <div style="margin-bottom:14px">
      <div style="position:relative;height:8px;border-radius:4px;overflow:hidden;display:flex">
        ${bgSegs}${dividers}${marker}
      </div>
      <div style="margin-top:5px;font-size:10px;font-weight:600;color:var(--c-black)">${activeLabel}</div>
    </div>`;
}

/**
 * Gap-aware 7-day line chart. Null entries show as a visual break in the line
 * with a faint dash mark. Dashed baseline reference + dot on most recent value.
 */
function buildDailyLineChartGap(
  entries: Array<{ value: number | null; day: string }>,
  color: string,
  baseline: number | null,
  H: number,
  unit: string,
): string {
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';

  const W = 320;
  const allVals = baseline != null ? [...nums, baseline] : nums;
  const lo = Math.min(...allVals);
  const hi = Math.max(...allVals);
  const pad = Math.max((hi - lo) * 0.30, 4);
  const minV = lo - pad, maxV = hi + pad, spanV = maxV - minV || 1;
  const n = entries.length;

  const xOf = (i: number) => n <= 1 ? W / 2 : (i / (n - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, ((v - minV) / spanV) * (H - 8));

  let linePath = '';
  let prevHad = false;
  for (let i = 0; i < n; i++) {
    const v = entries[i].value;
    if (v == null) {
      prevHad = false;
    } else {
      linePath += prevHad
        ? ` L ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`
        : ` M ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`;
      prevHad = true;
    }
  }
  linePath = linePath.trim();
  if (!linePath) return '';

  const baselineSvg = baseline != null ? (() => {
    const by = yOf(baseline).toFixed(1);
    return `<line x1="0" y1="${by}" x2="${W}" y2="${by}" stroke="${color}" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.35"/>
      <text x="${W - 4}" y="${(Number(by) - 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${color}" opacity="0.50" font-family="system-ui,sans-serif">avg ${Math.round(baseline)}${unit}</text>`;
  })() : '';

  let lastValidIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (entries[i].value != null) { lastValidIdx = i; break; }
  }
  const lastVal = lastValidIdx >= 0 ? entries[lastValidIdx].value! : null;
  const lastDot = lastVal != null
    ? `<circle cx="${xOf(lastValidIdx).toFixed(1)}" cy="${yOf(lastVal).toFixed(1)}" r="3.5" fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>`
    : '';

  const gapMarks = entries.map((e, i) => {
    if (e.value != null) return '';
    const x = xOf(i).toFixed(1);
    return `<line x1="${x}" y1="${(H * 0.30).toFixed(1)}" x2="${x}" y2="${(H * 0.70).toFixed(1)}" stroke="rgba(0,0,0,0.12)" stroke-width="1" stroke-dasharray="2 2"/>`;
  }).join('');

  const yAxisHtml = `
    <span style="position:absolute;top:${(yOf(hi) / H * 100).toFixed(1)}%;right:2px;transform:translateY(-50%);font-size:7px;color:rgba(0,0,0,0.22);line-height:1;font-variant-numeric:tabular-nums">${Math.round(hi)}</span>
    <span style="position:absolute;top:${(yOf(lo) / H * 100).toFixed(1)}%;right:2px;transform:translateY(-50%);font-size:7px;color:rgba(0,0,0,0.22);line-height:1;font-variant-numeric:tabular-nums">${Math.round(lo)}</span>`;

  const dayLabels = entries.map(e =>
    `<span style="font-size:8px;color:${e.value != null ? 'var(--c-faint)' : 'rgba(0,0,0,0.15)'}">${e.day}</span>`
  ).join('');

  return `
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${baselineSvg}
        ${gapMarks}
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
        ${lastDot}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml}</div>
      <div style="display:flex;justify-content:space-between;padding:3px 0 0">${dayLabels}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Individual metric cards

function buildFreshnessCard(s: SimulatorState): string {
  const sameSignal = computeSameSignalTSB(s.wks ?? [], s.w, s.signalBBaseline ?? s.ctlBaseline ?? 0, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctl = sameSignal?.ctl ?? 0;
  const tsbD = Math.round(tsb / 7);
  const tsbZone =
    tsbD < -10 ? 'Overtrained'
    : tsbD < -5 ? 'Fatigued'
    : tsbD < 0  ? 'Recovering'
    : tsbD < 5  ? 'Fresh'
    : tsbD < 12 ? 'Peaked'
    : 'Well Rested';
  const tsbColor =
    tsbZone === 'Fresh' || tsbZone === 'Peaked' || tsbZone === 'Well Rested' ? 'var(--c-ok)'
    : tsbZone === 'Recovering' ? 'var(--c-accent)'
    : tsbZone === 'Fatigued' ? 'var(--c-caution)'
    : 'var(--c-warn)';
  const tsbMarker = ctl > 0 ? Math.min(98, Math.max(2, ((tsbD + 20) / 40) * 100)) : null;

  const specBar = buildInlineSpectrumBar([
    { label: 'Overtrained', fraction: 10/40, color: 'rgba(255,69,58,0.60)'  },
    { label: 'Fatigued',    fraction:  5/40, color: 'rgba(255,159,10,0.55)' },
    { label: 'Recovering',  fraction:  5/40, color: 'rgba(78,159,229,0.40)' },
    { label: 'Fresh',       fraction:  5/40, color: 'rgba(52,199,89,0.55)'  },
    { label: 'Peaked',      fraction:  7/40, color: 'rgba(52,199,89,0.80)'  },
    { label: 'Well Rested', fraction:  8/40, color: 'rgba(52,199,89,0.45)' },
  ], tsbMarker, tsbZone);

  const chart = buildTSBLineChart(s, '8w');
  const valueStr = ctl > 0 ? (tsbD > 0 ? '+' : '') + tsbD : '—';

  return `
    <div id="stats-card-freshness" class="m-card" style="padding:20px;margin-bottom:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Freshness</span>
        <span style="display:flex;align-items:center;font-size:11px;color:var(--c-faint)">8-week${SCROLL_CHEVRON}</span>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:${ctl > 0 ? 'var(--c-black)' : 'var(--c-faint)'};font-variant-numeric:tabular-nums">${valueStr}</div>
        ${ctl > 0 ? `<div style="font-size:13px;font-weight:500;color:${tsbColor};margin-top:6px">${tsbZone}</div>` : ''}
      </div>
      ${specBar}
      ${chart}
      <div style="font-size:11px;color:var(--c-faint);margin-top:8px">Positive = rested · Negative = carrying fatigue</div>
    </div>`;
}

function buildInjuryRiskCard(s: SimulatorState): string {
  const tier = (s as any).athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, s.signalBBaseline ?? undefined);
  const ratio = acwr.ratio;
  const safeUpper = acwr.safeUpper;
  const cautionUpper = safeUpper + 0.2;
  const acwrZone = ratio <= 0 ? '—' : ratio <= safeUpper ? 'Safe' : ratio <= cautionUpper ? 'Elevated' : 'High Risk';
  const acwrColor = ratio > cautionUpper ? 'var(--c-warn)' : ratio > safeUpper ? 'var(--c-caution)' : 'var(--c-ok)';
  const acwrMarker = ratio > 0 ? Math.min(98, Math.max(2, (ratio / 2.0) * 100)) : null;

  const specBar = buildInlineSpectrumBar([
    { label: 'Safe',      fraction: safeUpper/2.0, color: 'rgba(52,199,89,0.55)'  },
    { label: 'Elevated',  fraction: 0.2/2.0, color: 'rgba(255,159,10,0.55)' },
    { label: 'High Risk', fraction: (2.0 - cautionUpper)/2.0, color: 'rgba(255,69,58,0.55)'  },
  ], acwrMarker, acwrZone);

  const chart = buildACWRTrendChart(s);
  const valueStr = ratio > 0 ? ratio.toFixed(2) + '×' : '—';

  return `
    <div id="stats-card-acwr" class="m-card" style="padding:20px;margin-bottom:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Load Ratio</span>
        <span style="display:flex;align-items:center;font-size:11px;color:var(--c-faint)">8-week${SCROLL_CHEVRON}</span>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:${ratio > 0 ? 'var(--c-black)' : 'var(--c-faint)'};font-variant-numeric:tabular-nums">${valueStr}</div>
        ${ratio > 0 ? `<div style="font-size:13px;font-weight:500;color:${acwrColor};margin-top:6px">${acwrZone}</div>` : ''}
      </div>
      ${specBar}
      ${chart}
      <div style="font-size:11px;color:var(--c-faint);margin-top:8px">Load ratio over 8 weeks. Above ${safeUpper.toFixed(1)} = elevated injury risk.</div>
    </div>`;
}

function buildHRVCard(s: SimulatorState): string {
  const physioHistory = s.physiologyHistory ?? [];
  const entries = physioBarEntries(physioHistory.slice(-7), 'hrvRmssd');
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';

  const baselineHrvs = physioHistory.slice(-28).map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const hasBaseline = baselineHrvs.length >= 5;
  const baselineMean = hasBaseline
    ? baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length
    : null;
  const baselineStddev = hasBaseline && baselineMean != null
    ? Math.sqrt(baselineHrvs.reduce((s, v) => s + (v - baselineMean) ** 2, 0) / baselineHrvs.length)
    : null;
  const rangeLo = baselineMean != null && baselineStddev != null ? Math.round(baselineMean - baselineStddev) : null;
  const rangeHi = baselineMean != null && baselineStddev != null ? Math.round(baselineMean + baselineStddev) : null;

  const lastHrv = physioHistory.filter(d => d.hrvRmssd != null).slice(-1)[0]?.hrvRmssd;
  const avg7 = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);

  // Status vs baseline
  let status = '—';
  let statusColor = 'var(--c-faint)';
  if (rangeLo != null && rangeHi != null && avg7 > 0) {
    if (avg7 < rangeLo - 3) { status = 'Low'; statusColor = 'var(--c-caution)'; }
    else if (avg7 > rangeHi + 3) { status = 'High'; statusColor = 'var(--c-ok)'; }
    else { status = 'Balanced'; statusColor = 'var(--c-ok)'; }
  }

  // Baseline spectrum bar (Low | Normal range | High)
  let baselineBar = '';
  if (rangeLo != null && rangeHi != null && avg7 > 0) {
    const scaleMin = Math.round(rangeLo * 0.5);
    const scaleMax = Math.round(rangeHi * 1.7);
    const scaleSpan = scaleMax - scaleMin;
    const lowFrac  = (rangeLo - scaleMin) / scaleSpan;
    const normFrac = (rangeHi - rangeLo) / scaleSpan;
    const highFrac = 1 - lowFrac - normFrac;
    const markerPct = Math.min(98, Math.max(2, ((avg7 - scaleMin) / scaleSpan) * 100));
    const marker = `<div style="position:absolute;top:0;left:${markerPct.toFixed(1)}%;transform:translateX(-50%);width:3px;height:100%;background:rgba(0,0,0,0.55);z-index:4;border-radius:1px"></div>`;
    baselineBar = `
      <div style="margin:12px 0 8px">
        <div style="position:relative;height:8px;border-radius:4px;overflow:hidden;display:flex">
          <div style="flex:${lowFrac.toFixed(3)};background:rgba(255,159,10,0.25)"></div>
          <div style="flex:${normFrac.toFixed(3)};background:rgba(52,199,89,0.35)"></div>
          <div style="flex:${highFrac.toFixed(3)};background:rgba(78,159,229,0.20)"></div>
          ${marker}
        </div>
        <div style="font-size:10px;color:var(--c-faint);margin-top:5px">Baseline ${rangeLo}–${rangeHi} ms · 7-day avg ${avg7} ms</div>
      </div>`;
  } else if (avg7 > 0) {
    baselineBar = `<div style="font-size:10px;color:var(--c-faint);margin-top:8px">7-day avg ${avg7} ms · building baseline…</div>`;
  }

  const chart = buildPhysioAreaChart(entries, 'rgba(120,120,130,0.70)');

  return `
    <div id="stats-card-hrv" class="m-card" style="padding:20px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">HRV (RMSSD)</span>
      </div>
      <div style="margin-bottom:4px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:var(--c-black);font-variant-numeric:tabular-nums">${lastHrv != null ? Math.round(lastHrv) + ' ms' : '—'}</div>
        ${status !== '—' ? `<div style="font-size:13px;font-weight:500;color:${statusColor};margin-top:6px">${status}</div>` : ''}
      </div>
      ${baselineBar}
      ${chart}
    </div>`;
}

function buildRHRCard(s: SimulatorState): string {
  const physioHistory = s.physiologyHistory ?? [];
  const entries = physioBarEntries(physioHistory.slice(-7), 'restingHR');
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';

  const baselineRhrs = physioHistory.slice(-28).map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const baseline = baselineRhrs.length >= 5
    ? Math.round(baselineRhrs.reduce((a: number, b: number) => a + b, 0) / baselineRhrs.length)
    : null;

  const lastRhr = physioHistory.filter(d => d.restingHR != null).slice(-1)[0]?.restingHR;
  const avg7 = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  // For RHR: ↓ = good (lower resting HR = better fitness/recovery)
  const trend = nums.length >= 2
    ? (nums[nums.length - 1] < nums[0] - 1 ? '↓' : nums[nums.length - 1] > nums[0] + 1 ? '↑' : '→')
    : '→';
  const trendColor = trend === '↓' ? 'var(--c-ok)' : trend === '↑' ? 'var(--c-warn)' : 'var(--c-faint)';

  const chart = buildPhysioAreaChart(entries, '#EF4444');
  if (!chart) return '';

  const contextParts: string[] = [];
  if (avg7 > 0) contextParts.push(`7-day avg ${avg7} bpm`);
  if (baseline) contextParts.push(`28-day avg ${baseline} bpm`);

  return `
    <div id="stats-card-rhr" class="m-card" style="padding:20px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Resting HR</span>
        <span style="font-size:11px;color:${trendColor}">${trend} 7 days</span>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:var(--c-black);font-variant-numeric:tabular-nums">${lastRhr != null ? Math.round(lastRhr) + ' bpm' : '—'}</div>
        ${contextParts.length ? `<div style="font-size:12px;color:var(--c-faint);margin-top:6px">${contextParts.join(' · ')}</div>` : ''}
      </div>
      ${chart}
    </div>`;
}

function buildSleepCard(s: SimulatorState): string {
  const physioHistory = s.physiologyHistory ?? [];
  // Merge manual sleep entries from recoveryHistory for dates Garmin hasn't filled
  const manualEntries = (s.recoveryHistory ?? []).filter((e: any) => e.source === 'manual' && e.sleepScore != null);
  const mergedHistory = [...physioHistory];
  for (const manual of manualEntries) {
    const existing = mergedHistory.find(p => p.date === (manual as any).date);
    if (!existing) {
      mergedHistory.push({ date: (manual as any).date, sleepScore: (manual as any).sleepScore } as any);
    } else if (existing.sleepScore == null) {
      const idx = mergedHistory.indexOf(existing);
      mergedHistory[idx] = { ...existing, sleepScore: (manual as any).sleepScore };
    }
  }
  mergedHistory.sort((a, b) => (a.date < b.date ? -1 : 1));

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const recent7 = mergedHistory.slice(-7);
  const sleepEntries = recent7.map((d, i) => ({
    value: d.sleepScore != null ? Math.round(d.sleepScore) : null,
    day: DAYS[new Date(d.date + 'T12:00:00').getDay()],
    date: d.date,
    isLatest: i === recent7.length - 1,
    subLabel: (d as any).sleepDurationSec ? fmtSleepDuration((d as any).sleepDurationSec) : null,
  }));
  const nums = sleepEntries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return '';

  const lastScore = mergedHistory.filter(d => d.sleepScore != null).slice(-1)[0]?.sleepScore;
  const avg7 = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  const scoreZone = lastScore == null ? '—'
    : lastScore >= 80 ? 'Excellent'
    : lastScore >= 60 ? 'Good'
    : lastScore >= 40 ? 'Fair'
    : 'Poor';
  const scoreColor = lastScore == null ? 'var(--c-faint)'
    : lastScore >= 80 ? 'var(--c-ok)'
    : lastScore >= 60 ? 'rgba(52,199,89,0.80)'
    : lastScore >= 40 ? 'var(--c-caution)'
    : 'var(--c-warn)';

  const chart = buildSleepBarChart(sleepEntries);

  return `
    <div id="stats-card-sleep" class="m-card" style="padding:20px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;cursor:pointer;-webkit-tap-highlight-color:transparent" id="stats-sleep-card-header">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Sleep</span>
        <span style="display:flex;align-items:center;font-size:11px;color:var(--c-faint)">7 nights${SCROLL_CHEVRON}</span>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:${lastScore != null ? 'var(--c-black)' : 'var(--c-faint)'};font-variant-numeric:tabular-nums">${lastScore != null ? lastScore + '/100' : '—'}</div>
        ${lastScore != null ? `<div style="font-size:13px;font-weight:500;color:${scoreColor};margin-top:6px">${scoreZone}</div>` : ''}
      </div>
      ${chart}
      <div style="font-size:11px;color:var(--c-faint);margin-top:8px">7-day avg ${avg7}/100 · Tap a night for detail</div>
    </div>`;
}

function buildCTLCard(s: SimulatorState): string {
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const latestCTL = metrics[metrics.length - 1]?.ctl ?? 0;
  const ctlD = Math.round(latestCTL / 7);
  const ctlBreaks = [20, 40, 58, 75, 95];
  const zoneLabels = ['Building', 'Foundation', 'Trained', 'Well-Trained', 'Performance', 'Elite'] as const;
  const ctlZoneIdx = ctlBreaks.findIndex(b => ctlD < b);
  const ctlZone = zoneLabels[ctlZoneIdx === -1 ? 5 : ctlZoneIdx];

  const TIER_COLOR: Record<string, string> = {
    'Building':     '#38BDF8',
    'Foundation':   '#3B82F6',
    'Trained':      '#4F46E5',
    'Well-Trained': '#7C3AED',
    'Performance':  '#9333EA',
    'Elite':        '#6D28D9',
  };
  const tierColor = TIER_COLOR[ctlZone] ?? '#3B82F6';
  const ctlMarker = latestCTL > 0 ? Math.min(98, Math.max(2, (ctlD / 150) * 100)) : null;

  const specBar = buildInlineSpectrumBar([
    { label: 'Building',     fraction:  20/150, color: 'rgba(56,189,248,0.18)'  },
    { label: 'Foundation',   fraction:  20/150, color: 'rgba(59,130,246,0.20)'  },
    { label: 'Trained',      fraction:  18/150, color: 'rgba(79,70,229,0.22)'   },
    { label: 'Well-Trained', fraction:  17/150, color: 'rgba(124,58,237,0.25)'  },
    { label: 'Performance',  fraction:  20/150, color: 'rgba(147,51,234,0.28)'  },
    { label: 'Elite',        fraction:  55/150, color: 'rgba(109,40,217,0.35)'  },
  ], ctlMarker, ctlZone);

  const chart = buildCTLLineChart(s, '8w');

  return `
    <div id="stats-card-ctl" class="m-card" style="padding:20px;margin-bottom:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Running Load</span>
        <span style="display:flex;align-items:center;font-size:11px;color:var(--c-faint)">8-week${SCROLL_CHEVRON}</span>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.03em;line-height:1;color:${latestCTL > 0 ? 'var(--c-black)' : 'var(--c-faint)'};font-variant-numeric:tabular-nums">${latestCTL > 0 ? ctlD : '—'}</div>
        ${latestCTL > 0 ? `<div style="font-size:13px;font-weight:500;color:${tierColor};margin-top:6px">${ctlZone}</div>` : ''}
      </div>
      ${specBar}
      ${chart}
      <div style="font-size:11px;color:var(--c-faint);margin-top:8px">42-day rolling average. Running counts fully; cross-training discounted.</div>
    </div>`;
}

function buildProgressCardCompact(s: SimulatorState): string {
  const isRaceMode = !s.continuousMode && !!s.initialBaseline;
  const unitPref = s.unitPref ?? 'km';

  const fmtT = (secs: number): string => {
    if (!secs) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sc = Math.round(secs % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${m}:${String(sc).padStart(2,'0')}`;
  };

  if (isRaceMode) {
    const forecastSec = s.forecastTime ?? s.currentFitness ?? 0;
    const initialSec  = s.initialBaseline ?? forecastSec;
    const diffSec = forecastSec - initialSec;
    const totalWks  = s.tw ?? (s.wks?.length ?? 16);
    const currentWk = s.w ?? 1;
    const pct = Math.min(100, Math.max(0, ((currentWk - 1) / Math.max(totalWks - 1, 1)) * 100));
    const statusColor = diffSec <= 300 ? 'var(--c-ok)' : diffSec <= 900 ? 'var(--c-caution)' : 'var(--c-warn)';
    const statusText  = diffSec <= 300 ? 'On track' : diffSec <= 900 ? 'Slightly behind' : 'Off track';
    return `
      <div id="stats-card-progress" class="m-card" style="padding:16px;margin-bottom:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="font-size:12px;font-weight:600;color:var(--c-black)">Plan Progress</span>
          <span style="display:flex;align-items:center;font-size:12px;color:var(--c-muted)">
            <strong style="font-size:14px;font-weight:600;color:${statusColor};margin-right:4px">${statusText}</strong>
            ${SCROLL_CHEVRON}
          </span>
        </div>
        <div style="height:4px;background:rgba(0,0,0,0.07);border-radius:2px;overflow:hidden;margin-bottom:10px">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:var(--c-accent);border-radius:2px"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:10px;color:var(--c-faint)">Week ${currentWk} of ${totalWks}</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-black)">${fmtT(forecastSec)}</span>
        </div>
      </div>`;
  }

  // General fitness: compact km card
  const completedWks = (s.wks ?? []).slice(0, Math.max(0, (s.w ?? 1) - 1));
  let totalRunKm = 0;
  for (const wk of completedWks) totalRunKm += runKmFromWeek(wk);
  const displayVal = unitPref === 'mi' ? (totalRunKm * 0.621371) : totalRunKm;
  const unitLabel = unitPref === 'mi' ? 'mi' : 'km';

  return `
    <div id="stats-card-progress" class="m-card" style="padding:16px;margin-bottom:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">Plan Progress</span>
        <span style="display:flex;align-items:center;font-size:12px;color:var(--c-muted)">
          <strong style="font-size:16px;font-weight:600;color:var(--c-black);margin-right:4px;font-variant-numeric:tabular-nums">${displayVal > 0 ? displayVal.toFixed(1) : '—'}</strong>
          ${totalRunKm > 0 ? `${unitLabel} total` : ''}${SCROLL_CHEVRON}
        </span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main Stats scroll container

function buildStatsScroll(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      <div style="padding:16px 18px 8px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:var(--c-black)">Stats</div>
        <button id="stats-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f);flex-shrink:0">${initials || 'Me'}</button>
      </div>
      <div style="padding:4px 18px 80px">
        ${buildProgressCardCompact(s)}
        ${buildFreshnessCard(s)}
        ${buildInjuryRiskCard(s)}
        ${buildHRVCard(s)}
        ${buildRHRCard(s)}
        ${buildSleepCard(s)}
        ${buildCTLCard(s)}
      </div>
    </div>
    ${renderTabBar('stats', isSimulatorMode())}`;
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ══════════════════════════════════════════════════════════════════════════════

function wireInfoButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.stats-info-btn').forEach(btn => {
    const handler = (e: Event) => {
      e.stopPropagation();
      const box = document.getElementById(`stats-info-${btn.dataset.infoId!}`);
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    };
    btn.addEventListener('click', handler);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); handler(e); }, { passive: false });
  });
}

function wireProgressRangeButtons(s: SimulatorState): void {
  const loadChart = document.getElementById('progress-load-chart');
  const kmChart   = document.getElementById('progress-km-chart');
  const ctlChart  = document.getElementById('progress-ctl-chart');
  if (!loadChart && !kmChart && !ctlChart) return;

  document.querySelectorAll<HTMLButtonElement>('.progress-range-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const range = btn.dataset.range as ChartRange;
      document.querySelectorAll<HTMLElement>('.progress-range-btn').forEach(b => {
        const active = b === btn;
        b.style.background = active ? 'var(--c-surface)' : 'transparent';
        b.style.color = active ? 'var(--c-black)' : 'var(--c-muted)';
        b.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
      });
      if (range === 'forecast') {
        if (loadChart) loadChart.innerHTML = buildForecastLoadChart(s);
        if (kmChart)   kmChart.innerHTML   = buildForecastKmChart(s);
        animateChartDrawOn();
        return;
      }
      if (range === '16w' && !s.extendedHistoryTSS?.length) {
        if (loadChart) loadChart.innerHTML = `<div style="height:130px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--c-muted)">Loading…</div>`;
        await fetchExtendedHistory(16);
      }
      if (loadChart) loadChart.innerHTML = buildLoadLineChart(s, range, 'progress-range-btn');
      if (kmChart)   kmChart.innerHTML   = buildRunDistanceLineChart(s, range);
      if (ctlChart)  ctlChart.innerHTML  = buildCTLLineChart(s, range);
      animateChartDrawOn();
    });
  });
}

function wireFitnessRangeButtons(s: SimulatorState): void {
  const vdotChart = document.getElementById('fitness-vdot-chart');
  if (!vdotChart) return;

  // Range toggle only shown for VDOT fallback (device VO2 chart has no range toggle)
  const vdotHist = s.vdotHistory ?? [];

  document.querySelectorAll<HTMLButtonElement>('.fitness-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range as ChartRange;
      document.querySelectorAll<HTMLElement>('.fitness-range-btn').forEach(b => {
        const active = b === btn;
        b.style.background = active ? 'var(--c-surface)' : 'transparent';
        b.style.color = active ? 'var(--c-black)' : 'var(--c-muted)';
        b.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
      });
      vdotChart.innerHTML = buildVdotLineChart(vdotHist, range);
      animateChartDrawOn();
    });
  });
}

function wireReadinessAccordion(s: SimulatorState): void {
  document.querySelectorAll<HTMLElement>('.readiness-acc-hdr').forEach(hdr => {
    const id = hdr.dataset.acc;
    if (!id) return;
    const body = document.getElementById(`readiness-acc-${id}`);
    const chevron = document.getElementById(`readiness-chevron-${id}`);
    if (!body) return;

    const toggle = (e: Event) => {
      e.stopPropagation();
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      if (chevron) chevron.textContent = open ? '▸' : '▾';
    };
    hdr.addEventListener('click', toggle);
    hdr.addEventListener('touchend', (e) => { e.preventDefault(); toggle(e); }, { passive: false });
  });

  // Sleep card — header taps open latest night; per-day bar taps open that specific night
  const sleepCard = document.getElementById('stats-card-sleep');
  if (sleepCard) {
    const physioHistory = s.physiologyHistory ?? [];
    const wks = s.wks ?? [];

    // Header chevron → latest night
    const hdr = document.getElementById('stats-sleep-card-header');
    if (hdr) {
      const openLatest = () => renderSleepView(undefined, physioHistory, wks, () => renderStatsView());
      hdr.addEventListener('click', openLatest);
      hdr.addEventListener('touchend', (e) => { e.preventDefault(); openLatest(); }, { passive: false });
    }

    // Per-day bars
    sleepCard.querySelectorAll<HTMLElement>('[data-sleep-date]').forEach(bar => {
      const date = bar.getAttribute('data-sleep-date');
      if (!date) return;
      const entry = physioHistory.find(d => d.date === date);
      if (!entry) return;
      const open = () => renderSleepView(entry.date, physioHistory, wks, () => renderStatsView());
      bar.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      bar.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); open(); }, { passive: false });
    });
  }
}

function wireDetailBack(s: SimulatorState): void {
  const btn = document.getElementById('stats-detail-back');
  if (!btn) return;
  const go = () => renderStatsView();
  btn.addEventListener('click', go);
  btn.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// DETAIL PAGE RENDERERS
// ══════════════════════════════════════════════════════════════════════════════

function renderProgressDetail(s: SimulatorState): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = buildProgressDetailPage(s);
  animateChartDrawOn();
  wireTabBarHandlers(navigateTab);
  wireDetailBack(s);
  wireProgressRangeButtons(s);

  // Total Load row → plan load breakdown sheet
  const loadRow = document.getElementById('stats-progress-load-row');
  if (loadRow) {
    const showSheet = () => import('./home-view').then(({ showPlanLoadBreakdownSheet }) => showPlanLoadBreakdownSheet(s));
    loadRow.addEventListener('click', showSheet);
    loadRow.addEventListener('touchend', (e) => { e.preventDefault(); showSheet(); }, { passive: false });
  }

  // CTL "Learn more" button
  const ctlLmBtn = document.getElementById('ctl-learn-more-btn');
  if (ctlLmBtn) {
    const go = () => renderCTLLearnMore(s);
    ctlLmBtn.addEventListener('click', go);
    ctlLmBtn.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
  }
}

function renderFitnessDetail(s: SimulatorState): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = buildFitnessDetailPage(s);
  animateChartDrawOn();
  wireTabBarHandlers(navigateTab);
  wireDetailBack(s);
  wireInfoButtons();
  wireFitnessRangeButtons(s);
  wireMetricDetailButtons(s);
}

function wireMetricDetailButtons(s: SimulatorState): void {
  document.querySelectorAll<HTMLElement>('[data-metric-detail]').forEach(el => {
    const handler = () => {
      const id = el.dataset.metricDetail;
      const container = document.getElementById('app-root');
      if (!container) return;
      if (id === 'ctl') {
        container.innerHTML = buildCTLMetricPage(s);
        animateChartDrawOn();
        wireTabBarHandlers(navigateTab);
        wireMetricBack(s);
      } else if (id === 'vdot') {
        container.innerHTML = buildVDOTMetricPage(s);
        animateChartDrawOn();
        wireTabBarHandlers(navigateTab);
        wireMetricBack(s);
      } else if (id === 'lt') {
        container.innerHTML = buildLTMetricPage(s);
        animateChartDrawOn();
        wireTabBarHandlers(navigateTab);
        wireMetricBack(s);
      }
    };
    el.addEventListener('click', handler);
    el.addEventListener('touchend', (e) => { e.preventDefault(); handler(); }, { passive: false });
  });
}

function wireMetricBack(s: SimulatorState): void {
  const btn = document.getElementById('stats-metric-back');
  if (!btn) return;
  const go = () => renderFitnessDetail(s);
  btn.addEventListener('click', go);
  btn.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
}

// ---------------------------------------------------------------------------
// ══════════════════════════════════════════════════════════════════════════════
// MAIN RENDER ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

export function renderStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  // Triathlon fork — full per-discipline stats view handles its own render.
  if (s.eventType === 'triathlon') {
    import('./triathlon/stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
    return;
  }
  container.innerHTML = buildStatsSummary(s);
  wireTabBarHandlers(navigateTab);

  document.getElementById('stats-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Card taps → detail pages
  const tapHandler = (id: string, renderer: () => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    const go = () => renderer();
    el.addEventListener('click', go);
    el.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
  };

  tapHandler('stats-card-progress',  () => renderProgressDetail(s));
  tapHandler('stats-card-fitness',   () => renderFitnessDetail(s));
}
