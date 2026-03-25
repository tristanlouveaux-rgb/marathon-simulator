/**
 * sleep-insights.ts
 * =================
 * Training-linked sleep insights. Pure functions, no side effects.
 * Returns one actionable sentence (or null if not enough data).
 */

import type { PhysiologyDayEntry } from '@/types/state';

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
  if (score >= 75) return 'var(--c-ok)';
  if (score >= 55) return 'var(--c-caution)';
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
  if (score >= 75) return 'rgba(52,199,89,0.55)';
  if (score >= 55) return 'rgba(255,159,10,0.60)';
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
  /** Number of nights with duration data in the 7-day window. */
  nightsWithData: number;
}

const DEFAULT_SLEEP_NEED_SEC = 8 * 3600; // 8h

/**
 * 7-day rolling sleep bank: sum of (actual_sleep − sleep_need) for recent nights.
 * Negative = deficit (cumulative under-sleeping), positive = surplus.
 */
export function getSleepBank(
  history: PhysiologyDayEntry[],
  sleepNeedSec = DEFAULT_SLEEP_NEED_SEC,
): SleepBankResult {
  const recent = history.slice(-7).filter(d => d.sleepDurationSec != null);
  if (recent.length === 0) return { bankSec: 0, nightsWithData: 0 };
  const bankSec = recent.reduce((sum, d) => sum + (d.sleepDurationSec! - sleepNeedSec), 0);
  return { bankSec: Math.round(bankSec), nightsWithData: recent.length };
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
