/**
 * sleep-insights.ts
 * =================
 * Training-linked sleep insights. Pure functions, no side effects.
 * Returns one actionable sentence (or null if not enough data).
 */

import type { PhysiologyDayEntry } from '@/types/state';
import { TL_PER_MIN } from '@/constants';

export interface SleepInsightInput {
  /** Physiology history, chronological oldest-first. */
  history: PhysiologyDayEntry[];
  /** Actual TSS for recent weeks, oldest-first. Used to detect post-hard-week patterns. */
  recentWeeklyTSS?: number[];
}

/**
 * Returns one training-linked insight sentence, or null if insufficient data.
 * Priority order: post-hard-week > bad streak > good streak > bounce-back > debt > trend.
 */
export function getSleepInsight(input: SleepInsightInput): string | null {
  const { history, recentWeeklyTSS } = input;
  const withScores = history.filter(d => d.sleepScore != null);
  if (withScores.length < 2) return null;

  const recent = withScores.slice(-7);
  const scores = recent.map(d => d.sleepScore as number);
  const latest = scores[scores.length - 1];
  const prev = scores.length >= 2 ? scores[scores.length - 2] : null;
  const avg7 = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  // Post-hard-week: elevated TSS + poor sleep
  if (recentWeeklyTSS && recentWeeklyTSS.length >= 1) {
    const lastTSS = recentWeeklyTSS[recentWeeklyTSS.length - 1] ?? 0;
    if (lastTSS > 250 && latest < 65) {
      return 'Hard training week and sleep is suffering — consider backing off intensity today.';
    }
    if (lastTSS > 350 && latest < 75) {
      return 'Very heavy week of training. Sleep quality matters now — prioritise rest.';
    }
  }

  // Consecutive bad nights (2 of last 3 below 60)
  const last3 = scores.slice(-3);
  const badCount = last3.filter(s => s < 60).length;
  if (badCount >= 2) {
    return `${badCount} of the last ${last3.length} nights were poor — reduce training intensity today.`;
  }

  // Good streak (3 consecutive above 75)
  const last3Good = last3.filter(s => s >= 75).length;
  if (last3Good === 3) {
    return 'Three strong nights in a row — your body is primed for a hard effort.';
  }

  // Bounce back after a bad night
  if (prev != null && prev < 60 && latest >= 75) {
    return 'Good recovery night after a rough one — back on track.';
  }

  // Sleep debt: 7-day average below 65
  if (avg7 < 65 && scores.length >= 4) {
    return `Sleep averaging ${avg7}/100 this week — prioritise getting 8 hours tonight.`;
  }

  // Improving trend: latest well above 7d average
  if (latest >= 75 && latest > avg7 + 12) {
    return `Sleep ${latest}/100 — above your recent average of ${avg7}. Good sign.`;
  }

  return null;
}

/** Format seconds as "Xh Ym" or "Ym" if under an hour. */
export function fmtSleepDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Colour token for a sleep score. */
export function sleepScoreColor(score: number): string {
  if (score >= 80) return 'var(--c-ok)';
  if (score >= 65) return 'var(--c-ok-muted)';
  if (score >= 50) return 'var(--c-caution)';
  return 'var(--c-warn)';
}

/** Quality label for a sleep score. */
export function sleepScoreLabel(score: number): string {
  if (score >= 75) return 'Excellent';
  if (score >= 55) return 'Good';
  if (score >= 35) return 'Fair';
  return 'Poor';
}

// ─── Sleep context (for contextualised drill-down) ───────────────────────────

export interface SleepContext {
  /** 14-day avg of sleep score (excluding latest entry). */
  scoreAvg: number | null;
  /** 14-day best sleep score (excluding latest entry). */
  scoreBest: number | null;
  /** Whether latest score is above/below/on_par with 14-day avg. */
  scoreVsAvg: 'above' | 'below' | 'on_par' | null;
  /** 14-day avg sleep duration in seconds. */
  durationAvgSec: number | null;
  /** 14-day best sleep duration in seconds. */
  durationBestSec: number | null;
  /** Whether latest duration is above/below/on_par with 14-day avg. */
  durationVsAvg: 'above' | 'below' | 'on_par' | null;
  /** Whether latest duration hits 7–9h population target. */
  durationVsTarget: 'optimal' | 'short' | 'long' | null;
}

/**
 * Build contextual stats comparing the latest sleep entry against personal history
 * and population targets. Pass the full physiologyHistory; latest entry is identified
 * by its date and excluded from baseline calculations.
 */
export function getSleepContext(
  history: PhysiologyDayEntry[],
  latest: PhysiologyDayEntry,
): SleepContext {
  const prior = history.slice(-14).filter(d => d.date !== latest.date);
  const withDur = prior.filter(d => d.sleepDurationSec != null);
  const withSc  = prior.filter(d => d.sleepScore != null);

  const scoreAvg = withSc.length > 0
    ? Math.round(withSc.reduce((a, d) => a + (d.sleepScore ?? 0), 0) / withSc.length)
    : null;
  const scoreBest = withSc.length > 0
    ? Math.max(...withSc.map(d => d.sleepScore ?? 0))
    : null;
  const durationAvgSec = withDur.length > 0
    ? withDur.reduce((a, d) => a + (d.sleepDurationSec ?? 0), 0) / withDur.length
    : null;
  const durationBestSec = withDur.length > 0
    ? Math.max(...withDur.map(d => d.sleepDurationSec ?? 0))
    : null;

  const latScore = latest.sleepScore ?? null;
  const latDur   = latest.sleepDurationSec ?? null;

  const scoreVsAvg = (latScore != null && scoreAvg != null)
    ? latScore > scoreAvg + 5 ? 'above' : latScore < scoreAvg - 5 ? 'below' : 'on_par'
    : null;
  const durationVsAvg = (latDur != null && durationAvgSec != null)
    ? latDur > durationAvgSec * 1.05 ? 'above' : latDur < durationAvgSec * 0.95 ? 'below' : 'on_par'
    : null;
  // 7–9h = 25 200–32 400 sec
  const durationVsTarget = latDur != null
    ? latDur >= 25200 && latDur <= 32400 ? 'optimal' : latDur < 25200 ? 'short' : 'long'
    : null;

  return { scoreAvg, scoreBest, scoreVsAvg, durationAvgSec, durationBestSec, durationVsAvg, durationVsTarget };
}

// ─── Muted sleep score colors (for bar chart — not text) ─────────────────────

export function sleepScoreColorMuted(score: number): string {
  if (score >= 80) return 'rgba(52,199,89,0.55)';
  if (score >= 65) return 'rgba(110,200,103,0.55)';
  if (score >= 50) return 'rgba(255,159,10,0.60)';
  return 'rgba(220,80,70,0.55)';
}

// ─── Sleep bar chart with per-day tap targets ─────────────────────────────────

export interface SleepBarEntry {
  value: number | null;
  day: string;
  date?: string;
  isLatest?: boolean;
  subLabel?: string | null;
}

/**
 * Render a vertical bar chart for sleep scores.
 * Each column has a `data-sleep-date` attribute for per-day tap handling.
 * Bars are colored with muted red/amber/green; score shown above, duration below.
 */
export function buildSleepBarChart(entries: SleepBarEntry[]): string {
  const BAR_MAX = 44;
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return `<span style="font-size:11px;color:var(--c-faint)">Building history…</span>`;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const range = hi - lo || 1;
  const last = entries.length - 1;

  const labelColor = (v: number) =>
    v >= 75 ? 'rgba(30,160,65,0.90)' : v >= 55 ? 'rgba(185,115,20,0.90)' : 'rgba(190,55,45,0.90)';

  const cols = entries.map((e, i) => {
    const h = e.value != null ? Math.max(4, Math.round(((e.value - lo) / range) * BAR_MAX)) : 4;
    const barCol = e.value != null ? sleepScoreColorMuted(e.value) : 'rgba(0,0,0,0.07)';
    const isLatest = e.isLatest || i === last;
    const dateAttr = e.date ? ` data-sleep-date="${e.date}"` : '';
    const cursor = e.date ? 'pointer' : 'default';
    const shadow = isLatest ? ';box-shadow:0 2px 0 0 rgba(0,0,0,0.10)' : '';

    return (
      `<div${dateAttr} style="flex:1;display:flex;flex-direction:column;align-items:stretch;cursor:${cursor};-webkit-tap-highlight-color:transparent">` +
        // Score above bar
        `<div style="text-align:center;font-size:9px;font-weight:600;line-height:1;margin-bottom:3px;color:${e.value != null ? labelColor(e.value) : 'var(--c-faint)'}">` +
          (e.value != null ? String(e.value) : '—') +
        `</div>` +
        // Bar (bottom-aligned in fixed-height container)
        `<div style="height:${BAR_MAX}px;display:flex;align-items:flex-end">` +
          `<div style="width:100%;height:${h}px;background:${barCol};border-radius:4px 4px 2px 2px${shadow}"></div>` +
        `</div>` +
        // Day label
        `<div style="text-align:center;font-size:9px;color:var(--c-faint);margin-top:3px;font-weight:${isLatest ? '600' : '400'}">${e.day}</div>` +
        // Duration sub-label
        (e.subLabel != null ? `<div style="text-align:center;font-size:8px;color:var(--c-faint);line-height:1.2;margin-top:1px">${e.subLabel}</div>` : '') +
      `</div>`
    );
  }).join('');

  return `<div style="display:flex;gap:5px">${cols}</div>`;
}

// ─── Stage quality analysis ───────────────────────────────────────────────────

type SleepStage = 'deep' | 'rem' | 'light' | 'awake';

export interface StageQuality {
  label: string;
  color: string;
}

/**
 * Population-norm quality label for a sleep stage given its percentage of total sleep.
 * Deep and REM are clinically actionable; Light is residual (no label); Awake is informational.
 *
 * Thresholds from sleep literature:
 *   Deep (SWS): <13% Low, 13–20% Good, >20% Excellent
 *   REM:        <15% Low, 15–22% Good, >22% Excellent
 *   Awake:      ≤8% Normal, >8% Elevated
 *   Light:      no quality label (residual stage)
 */
export function stageQuality(stage: SleepStage, pct: number): StageQuality {
  switch (stage) {
    case 'deep':
      if (pct >= 20) return { label: 'Excellent', color: 'var(--c-ok)' };
      if (pct >= 13) return { label: 'Good', color: 'var(--c-muted)' };
      return { label: 'Low', color: 'var(--c-caution)' };
    case 'rem':
      if (pct >= 22) return { label: 'Excellent', color: 'var(--c-ok)' };
      if (pct >= 15) return { label: 'Good', color: 'var(--c-muted)' };
      return { label: 'Low', color: 'var(--c-caution)' };
    case 'awake':
      if (pct <= 8) return { label: 'Normal', color: 'var(--c-muted)' };
      return { label: 'Elevated', color: 'var(--c-caution)' };
    case 'light':
    default:
      return { label: '', color: '' };
  }
}

// ─── Sleep Bank ───────────────────────────────────────────────────────────────

export interface SleepBankResult {
  /** Sum of (actual_sleep − sleep_need) for last 7 nights. Negative = deficit. */
  bankSec: number;
  /** Average per-night shortfall: bankSec / nightsWithData. Negative = under target. */
  avgNightlyShortfallSec: number;
  /** Number of nights with duration data in the 7-night window. */
  nightsWithData: number;
}

/** Science-backed floor and ceiling for the base sleep target. */
const SLEEP_TARGET_FLOOR_SEC = 7 * 3600;   // 7h — below this, measurable cognitive impairment (Van Dongen)
const SLEEP_TARGET_CEIL_SEC  = 8 * 3600;   // 8h — above this, diminishing returns for most adults (Walker/NIH)

/** Fallback target when not enough history to derive a personal target. */
const DEFAULT_SLEEP_NEED_SEC = SLEEP_TARGET_FLOOR_SEC;

/**
 * Derive a personalised base sleep target from the 65th percentile of the last 30 nights,
 * clamped to [7h, 8h]. Requires at least 5 nights of data; falls back to 7h otherwise.
 * Filters out entries shorter than 1h (likely bad data or naps).
 */
export function deriveSleepTarget(history: PhysiologyDayEntry[]): number {
  const durs = history
    .filter(d => d.sleepDurationSec != null && d.sleepDurationSec > 3600)
    .slice(-30)
    .map(d => d.sleepDurationSec!);
  if (durs.length < 5) return DEFAULT_SLEEP_NEED_SEC;
  const sorted = [...durs].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.65);
  const pct65 = sorted[idx];
  return Math.max(SLEEP_TARGET_FLOOR_SEC, Math.min(SLEEP_TARGET_CEIL_SEC, pct65));
}

// ─── Load-adjusted nightly target ────────────────────────────────────────────

/** Minutes of additional sleep per TSS point (k = 0.25 min/TSS). */
const LOAD_BONUS_K_SEC = 0.25 * 60; // 15 seconds per TSS point

/** Maximum load bonus in seconds, by athlete tier. */
const TIER_LOAD_CAPS_SEC: Record<string, number> = {
  beginner:     20 * 60,
  recreational: 30 * 60,
  trained:      40 * 60,
  performance:  50 * 60,
  high_volume:  60 * 60,
};

/**
 * Compute the load-adjusted sleep target for a single night.
 * base + min(yesterdayTSS × 0.25min, tier cap).
 * Maximum possible target: 8h base + 60min cap = 9h (high_volume only).
 */
export function computeLoadAdjustedTarget(
  baseSec: number,
  yesterdayTSS: number,
  athleteTier: string,
): number {
  const cap = TIER_LOAD_CAPS_SEC[athleteTier] ?? TIER_LOAD_CAPS_SEC.recreational;
  const bonus = Math.min(yesterdayTSS * LOAD_BONUS_K_SEC, cap);
  return Math.round(baseSec + bonus);
}

// ─── Exponential sleep debt ───────────────────────────────────────────────────

/**
 * Exponential decay constant for sleep debt — 7-day half-life.
 * After 7 days of full sleep, residual debt ~50%. After 14 days, ~25%.
 *
 * Previously 4-day (borrowed from ATL Banister model). Changed to 7-day based on:
 * - Banks & Dinges (2007): recovery from chronic sleep loss is not achieved quickly
 * - Belenky et al. (2003): cognitive deficits persist beyond 3 nights of recovery sleep
 * - Industry: Oura uses 14-day lookback, WHOOP says debt "follows you for days"
 * - 7-day half-life means 2-week-old debt is at 25% — aligns with 14-day lookback convention
 */
const DEBT_DECAY = Math.exp(-Math.LN2 / 7);


/**
 * Build a Record<YYYY-MM-DD, Signal B TSS> from plan weeks.
 * Signal B = raw physiological load (no runSpec discount).
 * Two sources: garminActuals (matched runs) and adhocWorkouts (cross-training).
 */
export function buildDailySignalBTSS(wks: any[]): Record<string, number> {
  const byDate: Record<string, number> = {};
  for (const wk of wks) {
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      const a = actual as any;
      if (!a.startTime) continue;
      const date = (a.startTime as string).split('T')[0];
      const tss = (a.iTrimp != null && a.iTrimp > 0)
        ? (a.iTrimp * 100) / 15000
        : 0;
      if (tss > 0) byDate[date] = (byDate[date] ?? 0) + tss;
    }
    const seenGarminIds = new Set<string>();
    for (const w of (wk.adhocWorkouts ?? [])) {
      const wo = w as any;
      if (!wo.id?.startsWith('garmin-')) continue;
      const rawId = (wo.id as string).slice('garmin-'.length);
      if (rawId && seenGarminIds.has(rawId)) continue;
      if (rawId) seenGarminIds.add(rawId);
      const date: string | null = wo.garminTimestamp ? (wo.garminTimestamp as string).split('T')[0] : null;
      if (!date) continue;
      const tss = (wo.iTrimp != null && wo.iTrimp > 0)
        ? (wo.iTrimp * 100) / 15000
        : (wo.garminDurationMin != null && wo.rpe != null)
          ? (wo.garminDurationMin as number) * (TL_PER_MIN[Math.round(wo.rpe as number)] ?? 1.15)
          : 0;
      if (tss > 0) byDate[date] = (byDate[date] ?? 0) + tss;
    }
  }
  return byDate;
}

/**
 * Compute accumulated sleep debt via exponential decay (7-day half-life).
 * Debt builds when actual sleep < load-adjusted target; decays each day.
 * Forward-only: starts at 0 and builds from available physiologyHistory.
 * dailyTSSByDate: Record<YYYY-MM-DD, Signal B TSS> — computed from garminActuals.
 */
export function computeSleepDebt(
  history: PhysiologyDayEntry[],
  dailyTSSByDate: Record<string, number>,
  athleteTier: string,
  baseSleepNeedSec?: number,
): number {
  const base = baseSleepNeedSec ?? DEFAULT_SLEEP_NEED_SEC;
  // Ensure oldest-first — decay weights depend on correct chronological order.
  const sorted = [...history].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let debt = 0;
  for (const entry of sorted) {
    debt *= DEBT_DECAY;
    if (entry.sleepDurationSec == null) continue;
    const tss = dailyTSSByDate[entry.date] ?? 0;
    const target = computeLoadAdjustedTarget(base, tss, athleteTier);
    // Debt is duration-based only — quality is used separately to adjust tonight's target.
    // Applying quality as a multiplier here causes compounding that produces unrealistic totals.
    const shortfall = Math.max(0, target - entry.sleepDurationSec);
    debt += shortfall;
  }
  return Math.round(debt);
}

/**
 * 7-night rolling sleep bank: sum of (actual_sleep − sleep_need) for recent nights.
 * Negative = deficit (cumulative under-sleeping), positive = surplus.
 * Matches Oura/Eight Sleep standard of a 7-night window.
 */
export function getSleepBank(
  history: PhysiologyDayEntry[],
  sleepNeedSec = DEFAULT_SLEEP_NEED_SEC,
): SleepBankResult {
  const recent = history.slice(-7).filter(d => d.sleepDurationSec != null);
  if (recent.length === 0) return { bankSec: 0, avgNightlyShortfallSec: 0, nightsWithData: 0 };
  const bankSec = recent.reduce((sum, d) => sum + (d.sleepDurationSec! - sleepNeedSec), 0);
  const avgNightlyShortfallSec = Math.round(bankSec / recent.length);
  return { bankSec: Math.round(bankSec), avgNightlyShortfallSec, nightsWithData: recent.length };
}

/**
 * Format a sleep bank value as "3h 20m deficit", "1h 10m surplus", or "Balanced".
 * Within ±15 minutes is treated as balanced.
 */
export function fmtSleepBank(bankSec: number): string {
  if (Math.abs(bankSec) < 900) return 'Balanced';
  const abs = Math.abs(bankSec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const durStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return bankSec < 0 ? `${durStr} deficit` : `${durStr} surplus`;
}

/**
 * Format average nightly shortfall as "52 min short/night", "18 min extra/night", or "On target".
 * Within ±10 minutes is treated as on target.
 */
export function fmtNightlyShortfall(avgShortfallSec: number): string {
  if (Math.abs(avgShortfallSec) < 600) return 'On target';
  const abs = Math.abs(avgShortfallSec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const durStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return avgShortfallSec < 0 ? `${durStr} short/night` : `${durStr} extra/night`;
}

// ─── Sleep bank line chart ────────────────────────────────────────────────────

/**
 * Render a line chart for the 14-night sleep bank.
 * Each point is one night's delta (actual − target) in seconds.
 * A dashed zero baseline separates surplus nights from deficit nights.
 * A dot marks the most recent data point.
 *
 * @param nights     Array of { date: YYYY-MM-DD, delta: seconds } oldest-first.
 * @param lineColor  CSS color for the line and terminal dot (match current bank state).
 * @param dimColor   CSS color for axis labels (typically the dark-mode faint color).
 */
export function buildSleepBankLineChart(
  nights: Array<{ date: string; delta: number }>,
  lineColor: string,
  dimColor: string,
  hideDayLabels?: boolean,
): string {
  if (nights.length < 2) return '';

  const W = 300; const H = 100; const PV = 12;
  const deltas = nights.map(n => n.delta);
  const dataMin = Math.min(...deltas);
  const dataMax = Math.max(...deltas);
  const dataPad = Math.max((dataMax - dataMin) * 0.25, 900);
  const minD = dataMin - dataPad;
  const maxD = dataMax + dataPad;
  const range = maxD - minD || 1;

  const yOf = (v: number) => PV + ((maxD - v) / range) * (H - PV * 2);
  const xOf = (i: number) => nights.length > 1 ? (i / (nights.length - 1)) * W : W / 2;

  const zeroY = Math.max(PV / 2, Math.min(H - PV / 2, yOf(0)));
  const pts = nights.map((n, i) => ({ x: xOf(i), y: yOf(n.delta) }));
  const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  // Area fill from line to zero baseline — split into surplus (above) and deficit (below)
  const areaD = `${lineD} L${last.x.toFixed(1)},${zeroY.toFixed(1)} L${pts[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;
  // Unique clip IDs based on chart instance (use first date to avoid collisions)
  const clipId = `slb-${nights[0].date.replace(/-/g, '')}`;
  const strokeColor = lineColor;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const step = nights.length > 10 ? 2 : 1;
  const dayLabels = nights.map((n, i) => {
    if (i % step !== 0 && i !== nights.length - 1) return '';
    const pct = (xOf(i) / W * 100).toFixed(1);
    const day = DAYS[new Date(n.date + 'T12:00:00').getDay()];
    return `<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:9px;color:${dimColor};top:0">${day}</span>`;
  }).join('');

  // Y-axis label: just "target" on the dashed baseline
  const zeroLabelPct = Math.max(5, Math.min(95, zeroY / H * 100)).toFixed(1);
  const yAxisHTML = `<span style="position:absolute;right:0;top:${zeroLabelPct}%;transform:translateY(-50%);font-size:8px;color:#9CA3AF;font-weight:500;white-space:nowrap">target</span>`;

  return `
    <div style="position:relative;margin-top:12px">
      <div style="position:relative;padding-right:36px">
        <svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}"
            stroke="rgba(0,0,0,0.10)" stroke-width="1" stroke-dasharray="4 3"/>
          <path d="${lineD}" fill="none" stroke="${strokeColor}"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4"
            fill="${strokeColor}" stroke="white" stroke-width="2"/>
        </svg>
        <div style="position:absolute;top:0;right:0;width:36px;height:100%">${yAxisHTML}</div>
      </div>
      ${hideDayLabels ? '' : `<div style="position:relative;height:16px;margin-top:4px">${dayLabels}</div>`}
    </div>`;
}

// ─── Stage vs 7-day history insight ──────────────────────────────────────────

/**
 * Returns a consultant-tone insight sentence comparing today's REM or Deep stage
 * to the 7-day rolling average from history. Returns null if not enough stage history.
 */
export function getStageInsight(
  entry: PhysiologyDayEntry,
  history: PhysiologyDayEntry[],
): string | null {
  if (!entry.sleepDurationSec) return null;

  const todayRemPct = entry.sleepRemSec != null
    ? (entry.sleepRemSec / entry.sleepDurationSec) * 100 : null;
  const todayDeepPct = entry.sleepDeepSec != null
    ? (entry.sleepDeepSec / entry.sleepDurationSec) * 100 : null;

  // Try personal-average comparison first (requires 3+ prior nights)
  const prior = history
    .slice(-8)
    .filter(d => d.date !== entry.date && d.sleepDurationSec != null && d.sleepRemSec != null);

  if (prior.length >= 3) {
    const avgRemPct = prior.reduce((sum, d) => sum + (d.sleepRemSec! / d.sleepDurationSec!) * 100, 0) / prior.length;
    const deepPrior = prior.filter(d => d.sleepDeepSec != null);
    const avgDeepPct = deepPrior.length > 0
      ? deepPrior.reduce((sum, d) => sum + (d.sleepDeepSec! / d.sleepDurationSec!) * 100, 0) / deepPrior.length
      : 0;

    if (todayRemPct != null) {
      const delta = todayRemPct - avgRemPct;
      if (delta < -5) {
        return `REM ${Math.round(todayRemPct)}% — below your ${Math.round(avgRemPct)}% 7-day average. Central fatigue risk is elevated on quality sessions today.`;
      }
      if (delta > 5 && todayRemPct >= 20) {
        return `REM ${Math.round(todayRemPct)}% — above your 7-day average. Recovery quality was good.`;
      }
    }

    if (todayDeepPct != null && avgDeepPct > 0) {
      const delta = todayDeepPct - avgDeepPct;
      if (delta < -4) {
        return `Deep sleep ${Math.round(todayDeepPct)}% — below your ${Math.round(avgDeepPct)}% 7-day average. Physical repair was reduced.`;
      }
    }
  }

  // Fallback: flag against population norms even without personal history
  if (todayRemPct != null && todayRemPct < 15) {
    return `REM ${Math.round(todayRemPct)}% — below the typical 15 to 22% range. Central fatigue risk is elevated on quality sessions today.`;
  }
  if (todayDeepPct != null && todayDeepPct < 13) {
    return `Deep sleep ${Math.round(todayDeepPct)}% — below the typical 13 to 20% range. Physical repair was reduced.`;
  }
  if (todayRemPct != null && todayRemPct >= 22) {
    return `REM ${Math.round(todayRemPct)}% — above the typical range. Recovery quality was good.`;
  }

  return null;
}

// ─── Clean bar chart builder ─────────────────────────────────────────────────

export interface BarChartEntry {
  value: number | null;
  day: string;
  isLatest?: boolean;
  /** Optional small label shown below the day name (e.g. "7h 22m"). */
  subLabel?: string | null;
}

/**
 * Render a clean vertical bar chart as an HTML string.
 * Bars scale relative to the min/max of the dataset (maximises visual differentiation).
 * The actual value is shown above each bar, day label below.
 *
 * @param entries  Data points with display day label.
 * @param color    Fixed CSS color string, or a function (value) → CSS color.
 * @param labelFn  How to format the value above the bar. Defaults to Math.round.
 */
export function buildBarChart(
  entries: BarChartEntry[],
  color: string | ((v: number) => string),
  labelFn: (v: number) => string = v => String(Math.round(v)),
): string {
  const BAR_MAX = 44;
  const nums = entries.map(e => e.value).filter((v): v is number => v != null);
  if (nums.length < 2) return `<span style="font-size:11px;color:var(--c-faint)">Building history…</span>`;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const range = hi - lo || 1;

  const getColor = (v: number) => typeof color === 'function' ? color(v) : color;
  const last = entries.length - 1;

  const labelRow = entries.map(e =>
    `<div style="flex:1;text-align:center;font-size:9px;font-weight:600;line-height:1;` +
    `color:${e.value != null ? getColor(e.value) : 'var(--c-faint)'}">` +
    `${e.value != null ? labelFn(e.value) : '—'}</div>`,
  ).join('');

  const barRow = entries.map((e, i) => {
    const h = e.value != null ? Math.max(4, Math.round(((e.value - lo) / range) * BAR_MAX)) : 4;
    const col = e.value != null ? getColor(e.value) : 'rgba(0,0,0,0.07)';
    const isLatest = e.isLatest || i === last;
    // Latest bar gets a subtle bottom border to distinguish it without washing out historic bars
    const border = isLatest ? ';box-shadow:0 2px 0 0 rgba(0,0,0,0.18)' : '';
    return `<div style="flex:1;height:${BAR_MAX}px;display:flex;align-items:flex-end">` +
      `<div style="width:100%;height:${h}px;background:${col};border-radius:4px 4px 2px 2px${border}"></div>` +
      `</div>`;
  }).join('');

  const dayRow = entries.map((e, i) =>
    `<div style="flex:1;text-align:center;font-size:9px;color:var(--c-faint);` +
    `font-weight:${(e.isLatest || i === last) ? '600' : '400'}">${e.day}</div>`,
  ).join('');

  // Always render sub-label row if any entry has a subLabel field set (even null/empty = shown as –)
  const hasSubLabelField = entries.some(e => 'subLabel' in e);
  const subRow = hasSubLabelField
    ? `<div style="display:flex;gap:5px;margin-top:2px">` +
      entries.map(e =>
        `<div style="flex:1;text-align:center;font-size:8px;color:var(--c-faint);line-height:1.2">${e.subLabel ?? '–'}</div>`,
      ).join('') + `</div>`
    : '';

  return `<div style="display:flex;gap:5px;margin-bottom:3px">${labelRow}</div>` +
    `<div style="display:flex;gap:5px">${barRow}</div>` +
    `<div style="display:flex;gap:5px;margin-top:3px">${dayRow}</div>` +
    subRow;
}
