/**
 * Home tab — the app landing screen.
 * Shows this-week progress, injury risk, today's workout, race countdown, recent activity.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { SimulatorState } from '@/types';
import type { Week } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { computeWeekTSS, computeWeekRawTSS, computeACWR, computeFitnessModel, computeSameSignalTSB, getWeeklyExcess, computePlannedSignalB, getTrailingEffortScore, computeTodaySignalBTSS, computePlannedDaySignalBTSS } from '@/calculations/fitness-model';
import { computeReadiness, readinessColor, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { getSleepInsight, fmtSleepDuration, sleepScoreColor, sleepScoreLabel, getSleepContext, buildBarChart, stageQuality, getSleepBank, fmtSleepBank, getStageInsight, deriveSleepTarget, buildSleepBankLineChart } from '@/calculations/sleep-insights';
import type { PhysiologyDayEntry } from '@/types/state';
import { generateWeekWorkouts } from '@/workouts';
import { isHardWorkout } from '@/workouts/scheduler';
import { isInjuryActive } from './injury/modal';
import { openCheckinOverlay } from './checkin-overlay';
import { openCoachModal } from './coach-modal';
import { clearIllness } from './illness-modal';
import { formatKm, fmtDateUK, fmtDesc, formatPace } from '@/utils/format';
import { next, setOnWeekAdvance, applyRecoveryAdjustment } from './events';
import { TL_PER_MIN } from '@/constants';
import { normalizeSport } from '@/cross-training/activities';
import { formatActivityType } from '@/calculations/activity-matcher';
import { isSleepDataPending } from '@/data/sleepPoller';

// ─── Navigation ────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─── Data helpers ───────────────────────────────────────────────────────────

/** JS getDay() → Mon-0 … Sun-6 */
function jsToOurDay(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** Days remaining until an ISO date string */
function daysUntil(isoDate: string): number {
  const race = new Date(isoDate);
  const now = new Date();
  race.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((race.getTime() - now.getTime()) / 86400000));
}

/** Day-of-week short label: Mon, Tue … */
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayLabel(): string {
  const ourDay = jsToOurDay(new Date().getDay());
  return DAY_LABELS[ourDay];
}

/** Format ISO date as "Mon 17 Feb" */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const NON_RUN_KW = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl',
  'tennis', 'hiit', 'pilates', 'row', 'hik', 'elliptic', 'walk'];
/** Returns true if this garminActuals entry represents a run.
 *  Prefers activityType (authoritative) over keyword-scanning the slot key. */
const isRunKey = (k: string, activityType?: string | null) => {
  if (activityType) {
    const t = activityType.toUpperCase();
    return t === 'RUNNING' || t.includes('RUN');
  }
  return !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));
};

// ─── Section builders ───────────────────────────────────────────────────────

// ─── Load Breakdown Sheet ───────────────────────────────────────────────────

interface LoadSegment {
  label: string;
  tss: number;
  durationMin: number;
  color: string;
}

function sportColor(sport: string): string {
  const s = normalizeSport(sport);
  const map: Record<string, string> = {
    cycling: '#10b981',
    strength: '#f97316',
    padel: '#8b5cf6',
    tennis: '#7c3aed',
    swimming: '#06b6d4',
    hiking: '#84cc16',
    skiing: '#60a5fa',
    rowing: '#14b8a6',
    yoga: '#f472b6',
    boxing: '#ef4444',
    crossfit: '#ef4444',
    martial_arts: '#ef4444',
    walking: '#a3a3a3',
    extra_run: '#3b82f6',
  };
  return map[s] ?? '#6b7280';
}

function normalizeiTrimpLocal(itrimp: number): number {
  return (itrimp * 100) / 15000;
}

function parseDurMinLocal(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1]) : 30;
}

/**
 * Compute a per-sport breakdown of Signal B TSS for the current week.
 * Mirrors computeWeekRawTSS exactly (same dedup, same formulas) but groups by label.
 */
function computeLoadBreakdown(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
): LoadSegment[] {
  const segments = new Map<string, LoadSegment>();
  const seenGarminIds = new Set<string>();

  function add(label: string, tss: number, durationMin: number, color: string) {
    const existing = segments.get(label);
    if (existing) {
      existing.tss += tss;
      existing.durationMin += durationMin;
    } else {
      segments.set(label, { label, tss, durationMin, color });
    }
  }

  // Matched activities (garminActuals) — primarily runs
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const ratedVal = ratedMap[workoutId];
    const rpe = (typeof ratedVal === 'number') ? ratedVal : 5;
    let tss: number;
    let durationMin: number;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tss = normalizeiTrimpLocal(actual.iTrimp);
      durationMin = actual.durationSec / 60;
    } else {
      durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      tss = durationMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
    // Label: use displayName for cross-training slots, else "Running"
    const label = (actual.displayName && !actual.workoutName) ? actual.displayName : 'Running';
    const color = label === 'Running' ? '#3b82f6' : sportColor(label.toLowerCase());
    add(label, tss, durationMin, color);
  }

  // Adhoc workouts — all types, no runSpec discount for Signal B
  for (const w of wk.adhocWorkouts ?? []) {
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    let tss: number;
    let durationMin: number;
    if (w.iTrimp != null && w.iTrimp > 0) {
      tss = (w.iTrimp * 100) / 15000;
      durationMin = parseDurMinLocal(w.d);
    } else {
      const rpe = w.rpe ?? w.r ?? 5;
      durationMin = parseDurMinLocal(w.d);
      tss = durationMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
    }
    const sport = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
    const label = w.n.replace(' (Garmin)', '').replace(' (Strava)', '');
    add(label, tss, durationMin, sportColor(sport));
  }

  // Unspent load items — no runSpec discount
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (weekStartMs !== null && weekEndMs !== null && item.date) {
      const itemMs = new Date(item.date).getTime();
      if (itemMs < weekStartMs || itemMs >= weekEndMs) continue;
    }
    if (item.garminId) {
      if (seenGarminIds.has(item.garminId)) continue;
      seenGarminIds.add(item.garminId);
    }
    const tss = item.durationMin * (TL_PER_MIN[5] ?? 1.15);
    add(item.displayName, tss, item.durationMin, sportColor(item.sport));
  }

  return Array.from(segments.values())
    .filter(s => s.tss > 0.5)
    .sort((a, b) => b.tss - a.tss);
}

export function showLoadBreakdownSheet(s: SimulatorState, weekNum?: number, returnTo: 'plan' | 'home' = 'home'): void {
  const wkIndex = (weekNum ?? s.w) - 1;
  const wk = s.wks?.[wkIndex];
  const tssActual = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  // Use computePlannedSignalB so the target matches the plan bar exactly (same corrected formula).
  // Derive the cross-training component for display; running = remainder.
  let crossTrainingBudget = 0;
  if (s.sportBaselineByType) {
    for (const sport of Object.values(s.sportBaselineByType)) {
      crossTrainingBudget += sport.avgSessionRawTSS * sport.sessionsPerWeek;
    }
  }
  crossTrainingBudget = Math.round(crossTrainingBudget);
  const tssPlan = computePlannedSignalB(s.historicWeeklyTSS, s.ctlBaseline, wk?.ph ?? 'base', s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType);
  const runningTSSPlan = Math.max(0, tssPlan - crossTrainingBudget);

  const segments = wk ? computeLoadBreakdown(wk, wk.rated ?? {}, s.planStartDate) : [];
  // Use tssActual (from computeWeekRawTSS) as the authoritative total so bar widths
  // always match the number shown on the home page. Never use the sum of rounded segments.
  const totalTss = tssActual;

  // Stacked bar segments — proportions relative to tssActual so widths add up exactly
  // When over target, fill the full bar width (100%); when under, scale to target position
  const barDenom = Math.max(totalTss, tssPlan, 1);
  const barScale = totalTss >= tssPlan ? 100 / totalTss : 100 / tssPlan;
  const stackedBar = totalTss > 0
    ? segments.map(seg => {
      const pct = seg.tss * barScale;
      return `<div style="height:100%;width:${pct.toFixed(1)}%;background:${seg.color};flex-shrink:0"></div>`;
    }).join('')
    : `<div style="height:100%;width:4%;background:var(--c-border);flex-shrink:0;border-radius:3px"></div>`;

  // Remaining planned — only shown when under target
  const remaining = Math.max(0, Math.round(tssPlan) - tssActual);
  const remainingPct = remaining > 5 ? remaining * barScale : 0;
  const remainingBar = remaining > 5
    ? `<div style="height:100%;width:${remainingPct.toFixed(1)}%;background:var(--c-border);flex-shrink:0;border-radius:0 3px 3px 0"></div>`
    : '';

  // Legend rows
  const legendRows = segments.map(seg => {
    const barWidth = totalTss > 0 ? Math.min(100, Math.round((seg.tss / totalTss) * 100)) : 0;
    const dur = seg.durationMin >= 60
      ? `${Math.floor(seg.durationMin / 60)}h ${Math.round(seg.durationMin % 60)}m`
      : `${Math.round(seg.durationMin)}m`;
    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>
            <span style="font-size:14px;color:var(--c-black)">${seg.label}</span>
            <span style="font-size:12px;color:var(--c-faint)">${dur}</span>
          </div>
          <span style="font-size:14px;font-weight:600;color:var(--c-black)">${Math.round(seg.tss)}</span>
        </div>
        <div style="background:rgba(0,0,0,0.06);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:${seg.color};height:100%;width:${barWidth}%;border-radius:3px"></div>
        </div>
      </div>`;
  }).join('');

  const emptyState = segments.length === 0
    ? `<p style="color:var(--c-faint);font-size:14px;text-align:center;padding:20px 0">No activities logged yet this week</p>`
    : '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px;width:100%;max-width:480px;padding-bottom:0;max-height:85vh;overflow-y:auto">
      <div style="padding:16px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <h2 style="font-size:16px;font-weight:600;color:var(--c-black)">Weekly Load Breakdown</h2>
          <p style="font-size:12px;color:var(--c-faint);margin-top:2px">All sports · running + cross-training</p>
        </div>
        <button id="lbd-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0;line-height:1">✕</button>
      </div>

      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:16px">

        <!-- Big number + stacked bar -->
        <div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
            <span style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${tssActual}</span>
            <span style="font-size:14px;color:var(--c-muted)">/ ${Math.round(tssPlan)} TSS target</span>
          </div>
          <div style="background:rgba(0,0,0,0.06);border-radius:4px;height:10px;overflow:hidden;display:flex">
            ${stackedBar}
            ${remainingBar}
          </div>
          ${segments.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px">
            ${segments.map(seg => `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-muted)"><div style="width:7px;height:7px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>${seg.label}</div>`).join('')}
            ${remaining > 5 ? `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-faint)"><div style="width:7px;height:7px;border-radius:3px;background:var(--c-border);flex-shrink:0"></div>Remaining</div>` : ''}
          </div>` : ''}
        </div>

        <!-- Divider -->
        ${segments.length > 0 ? '<div style="height:1px;background:var(--c-border)"></div>' : ''}

        <!-- Sport rows -->
        <div style="display:flex;flex-direction:column;gap:12px">
          ${legendRows}
          ${emptyState}
        </div>

        <!-- Planned target footer -->
        <div style="background:var(--c-bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:var(--c-muted)">Running planned</span>
            <span style="font-size:13px;font-weight:500;color:var(--c-black)">${runningTSSPlan} TSS</span>
          </div>
          ${crossTrainingBudget > 0 ? `
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:var(--c-muted)">Cross-training expected</span>
            <span style="font-size:13px;font-weight:500;color:var(--c-black)">${crossTrainingBudget} TSS</span>
          </div>` : ''}
          <div style="height:1px;background:var(--c-border)"></div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">Total target</span>
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">${Math.round(tssPlan)} TSS</span>
          </div>
        </div>

        <!-- Learn more link -->
        <button id="lbd-learn-more" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;text-align:center;font-family:var(--f)">Understand your load &amp; taper →</button>

      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#lbd-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('#lbd-learn-more')?.addEventListener('click', () => {
    close();
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(weekNum ?? s.w, returnTo));
  });
}


export function showPlanLoadBreakdownSheet(s: SimulatorState): void {
  const completedWks = (s.wks ?? []).slice(0, Math.max(0, (s.w ?? 1) - 1));

  // Aggregate computeLoadBreakdown across all completed weeks
  const totalSegments = new Map<string, LoadSegment>();
  for (const wk of completedWks) {
    for (const seg of computeLoadBreakdown(wk, wk.rated ?? {}, s.planStartDate)) {
      const existing = totalSegments.get(seg.label);
      if (existing) {
        existing.tss += seg.tss;
        existing.durationMin += seg.durationMin;
      } else {
        totalSegments.set(seg.label, { ...seg });
      }
    }
  }

  const segments = Array.from(totalSegments.values())
    .filter(seg => seg.tss > 0.5)
    .sort((a, b) => b.tss - a.tss);
  const totalTss = Math.round(segments.reduce((sum, seg) => sum + seg.tss, 0));
  const weeksText = `${completedWks.length} week${completedWks.length !== 1 ? 's' : ''} completed`;

  const fmtDur = (min: number) => min >= 60
    ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`
    : `${Math.round(min)}m`;

  const stackedBar = segments.length > 0
    ? segments.map(seg => {
        const pct = totalTss > 0 ? (seg.tss / totalTss) * 100 : 0;
        return `<div style="height:100%;width:${pct.toFixed(1)}%;background:${seg.color};flex-shrink:0"></div>`;
      }).join('')
    : `<div style="height:100%;width:100%;background:var(--c-border)"></div>`;

  const legendRows = segments.map(seg => {
    const barWidth = totalTss > 0 ? Math.min(100, Math.round((seg.tss / totalTss) * 100)) : 0;
    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>
            <span style="font-size:14px;color:var(--c-black)">${seg.label}</span>
            <span style="font-size:12px;color:var(--c-faint)">${fmtDur(seg.durationMin)}</span>
          </div>
          <span style="font-size:14px;font-weight:600;color:var(--c-black)">${Math.round(seg.tss)}</span>
        </div>
        <div style="background:rgba(0,0,0,0.06);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:${seg.color};height:100%;width:${barWidth}%;border-radius:3px"></div>
        </div>
      </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px;width:100%;max-width:480px;max-height:85vh;overflow-y:auto">
      <div style="padding:16px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <h2 style="font-size:16px;font-weight:600;color:var(--c-black)">Plan Load Breakdown</h2>
          <p style="font-size:12px;color:var(--c-faint);margin-top:2px">All sports · ${weeksText}</p>
        </div>
        <button id="plbd-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0;line-height:1">✕</button>
      </div>

      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:16px">
        <div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
            <span style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${totalTss.toLocaleString()}</span>
            <span style="font-size:14px;color:var(--c-muted)">TSS total</span>
          </div>
          <div style="background:rgba(0,0,0,0.06);border-radius:4px;height:10px;overflow:hidden;display:flex">
            ${stackedBar}
          </div>
          ${segments.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px">
            ${segments.map(seg => `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-muted)"><div style="width:7px;height:7px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>${seg.label}</div>`).join('')}
          </div>` : ''}
        </div>

        ${segments.length > 0 ? '<div style="height:1px;background:var(--c-border)"></div>' : ''}

        <div style="display:flex;flex-direction:column;gap:12px">
          ${legendRows || '<p style="color:var(--c-faint);font-size:14px;text-align:center;padding:20px 0">No activities logged yet</p>'}
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#plbd-close')?.addEventListener('click', () => overlay.remove());
}

const RUN_TYPE_LABEL: Record<string, string> = {
  easy: 'Easy Run', long: 'Long Run', marathon_pace: 'Marathon Pace',
  threshold: 'Threshold', vo2: 'VO₂max', intervals: 'Intervals',
  hill_repeats: 'Hill Repeats', progressive: 'Progressive', mixed: 'Mixed',
  race_pace: 'Race Pace',
};
const IS_RUN_TYPE = (t: string) => t !== 'cross' && t !== 'gym' && t !== 'strength' && t !== 'rest';

export function showRunBreakdownSheet(s: SimulatorState, weekNum?: number): void {
  const wkIndex = (weekNum ?? s.w) - 1;
  const wk = s.wks?.[wkIndex];
  const unitPref = s.unitPref ?? 'km';
  const toDisplay = (km: number) => unitPref === 'mi' ? km * 0.621371 : km;
  const unit = unitPref === 'mi' ? 'mi' : 'km';
  const fmtKm = (km: number) => `${toDisplay(km).toFixed(1)} ${unit}`;

  const parseKmFromDesc = (desc: string): number => {
    const matches = [...(desc || '').matchAll(/(\d+\.?\d*)\s*km/g)];
    return matches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
  };

  const runWorkouts = wk
    ? generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
        null, s.recurringActivities,
        s.onboarding?.experienceLevel, undefined, s.pac?.e, wkIndex + 1, s.tw, s.v, s.gs,
        getTrailingEffortScore(s.wks, wkIndex + 1), wk.scheduledAcwrStatus,
      ).filter((w: any) => IS_RUN_TYPE(w.t || ''))
    : [];
  const garminActuals = wk?.garminActuals ?? {};
  const rated = wk?.rated ?? {};

  let totalPlannedKm = 0;
  let totalActualKm = 0;

  const rows = runWorkouts.map((wo: any) => {
    const woId = wo.id || wo.n;
    const plannedKm = parseKmFromDesc(wo.d || '');
    totalPlannedKm += plannedKm;
    const actual = garminActuals[woId];
    const isSkipped = rated[woId] === 'skip';
    const isDone = !!actual || (typeof rated[woId] === 'number' && rated[woId] !== 0);
    const actualKm = actual?.distanceKm ?? 0;
    if (isDone && actualKm > 0) totalActualKm += actualKm;

    const label = RUN_TYPE_LABEL[wo.t] ?? wo.n ?? 'Run';
    const dur = actual?.durationSec
      ? (actual.durationSec >= 3600
        ? `${Math.floor(actual.durationSec / 3600)}h ${Math.round((actual.durationSec % 3600) / 60)}m`
        : `${Math.round(actual.durationSec / 60)}m`)
      : '';
    const pace = actual?.avgPaceSecKm
      ? formatPace(actual.avgPaceSecKm, unitPref)
      : '';

    const barPct = plannedKm > 0 && actualKm > 0 ? Math.min(100, Math.round((actualKm / plannedKm) * 100)) : 0;
    const statusColor = isSkipped ? 'var(--c-faint)' : isDone ? 'var(--c-accent)' : 'var(--c-border)';

    const rightSide = isSkipped
      ? `<span style="font-size:11px;color:var(--c-faint)">Skipped</span>`
      : isDone && actualKm > 0
        ? `<span style="font-size:14px;font-weight:600;color:var(--c-black)">${fmtKm(actualKm)}</span>`
        : plannedKm > 0
          ? `<span style="font-size:13px;color:var(--c-muted)">${fmtKm(plannedKm)} planned</span>`
          : '';

    const meta = [dur, pace].filter(Boolean).join(' · ');

    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:${statusColor};flex-shrink:0"></div>
            <div>
              <span style="font-size:14px;color:var(--c-black)">${label}</span>
              ${meta ? `<span style="font-size:12px;color:var(--c-faint);margin-left:6px">${meta}</span>` : ''}
            </div>
          </div>
          ${rightSide}
        </div>
        ${plannedKm > 0 && !isSkipped ? `
        <div style="background:rgba(0,0,0,0.06);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:var(--c-accent);height:100%;width:${barPct}%;border-radius:3px"></div>
        </div>` : ''}
      </div>`;
  });

  const barScale = totalActualKm >= totalPlannedKm ? 100 / Math.max(totalActualKm, 1) : 100 / Math.max(totalPlannedKm, 1);
  const fillPct = Math.min(100, totalActualKm * barScale);
  const remainPct = totalActualKm < totalPlannedKm ? Math.max(0, totalPlannedKm * barScale - fillPct) : 0;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px;width:100%;max-width:480px;padding-bottom:0;max-height:85vh;overflow-y:auto">
      <div style="padding:16px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <h2 style="font-size:16px;font-weight:600;color:var(--c-black)">Weekly Run Breakdown</h2>
          <p style="font-size:12px;color:var(--c-faint);margin-top:2px">Running · planned distance</p>
        </div>
        <button id="rbd-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0;line-height:1">✕</button>
      </div>
      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:16px">
        <!-- Big number + bar -->
        <div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
            <span style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${fmtKm(totalActualKm)}</span>
            <span style="font-size:14px;color:var(--c-muted)">/ ${fmtKm(totalPlannedKm)} planned</span>
          </div>
          <div style="background:rgba(0,0,0,0.06);border-radius:4px;height:10px;overflow:hidden;display:flex">
            ${totalActualKm > 0 ? `<div style="height:100%;width:${fillPct.toFixed(1)}%;background:var(--c-accent);flex-shrink:0"></div>` : ''}
            ${remainPct > 0 ? `<div style="height:100%;width:${remainPct.toFixed(1)}%;background:var(--c-border);flex-shrink:0;border-radius:0 3px 3px 0"></div>` : ''}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px">
            <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-muted)"><div style="width:7px;height:7px;border-radius:50%;background:var(--c-accent);flex-shrink:0"></div>Running</div>
            ${remainPct > 0 ? `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-faint)"><div style="width:7px;height:7px;border-radius:3px;background:var(--c-border);flex-shrink:0"></div>Remaining</div>` : ''}
          </div>
        </div>
        ${rows.length > 0 ? '<div style="height:1px;background:var(--c-border)"></div>' : ''}
        <!-- Run rows -->
        <div style="display:flex;flex-direction:column;gap:12px">
          ${rows.length > 0 ? rows.join('') : '<p style="color:var(--c-faint);font-size:14px;text-align:center;padding:20px 0">No runs scheduled this week</p>'}
        </div>
        <!-- Footer totals -->
        ${totalPlannedKm > 0 ? `
        <div style="background:var(--c-bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:var(--c-muted)">Planned total</span>
            <span style="font-size:13px;font-weight:500;color:var(--c-black)">${fmtKm(totalPlannedKm)}</span>
          </div>
          ${totalActualKm > 0 ? `
          <div style="height:1px;background:var(--c-border)"></div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">Completed</span>
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">${fmtKm(totalActualKm)}</span>
          </div>` : ''}
        </div>` : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#rbd-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function buildIllnessBanner(s: SimulatorState): string {
  const illness = (s as any).illnessState;
  if (!illness?.active) return '';

  const today = new Date().toISOString().split('T')[0];
  const start = new Date(illness.startDate + 'T12:00:00');
  const todayDate = new Date(today + 'T12:00:00');
  const dayNum = Math.max(1, Math.round((todayDate.getTime() - start.getTime()) / 86400000) + 1);
  const severityLabel = illness.severity === 'resting' ? 'Full rest' : 'Still running';
  const severityDetail = illness.severity === 'resting'
    ? 'All running replaced with rest.'
    : 'Quality sessions → easy. Distances scaled.';

  return `
    <div id="home-illness-banner" style="margin:0 14px 8px;border-radius:16px;overflow:hidden;
                border:1px solid rgba(0,0,0,0.08);
                background:rgba(255,251,235,0.9);
                box-shadow:0 1px 8px rgba(0,0,0,0.06)">
      <div style="height:3px;background:linear-gradient(to right,#F59E0B,#F97316)"></div>
      <div style="padding:12px 14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
              <span style="font-size:13px;font-weight:600;letter-spacing:-0.01em;color:#92400E">Illness · Day ${dayNum}</span>
              <span style="font-size:10px;font-weight:600;color:#D97706;background:rgba(245,158,11,0.12);
                           border:1px solid rgba(245,158,11,0.2);border-radius:100px;padding:1px 7px;text-transform:uppercase;letter-spacing:0.04em">${severityLabel}</span>
            </div>
            <div style="font-size:11px;color:rgba(0,0,0,0.45)">${severityDetail}</div>
          </div>
          <button id="home-illness-recover"
            style="flex-shrink:0;display:flex;align-items:center;gap:4px;padding:6px 11px;border-radius:100px;
                   border:1px solid rgba(34,197,94,0.3);background:rgba(34,197,94,0.08);
                   font-size:11px;font-weight:600;color:#15803D;cursor:pointer;white-space:nowrap">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            Recovered
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildProgressBars(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];

  // Sessions done this week — prefer synced activity count (Strava or Garmin) over rated count
  const syncedSessions = wk
    ? Object.keys(wk.garminActuals || {}).length
    + (wk.adhocWorkouts || []).filter((w: any) =>
      w.id?.startsWith('garmin-') || w.id?.startsWith('strava-')
    ).length
    : 0;
  const ratedSessions = wk
    ? Object.values(wk.rated || {}).filter(v => typeof v === 'number' && v > 0).length
    : 0;
  const sessionsDone = Math.max(syncedSessions, ratedSessions);
  // Count all planned non-rest sessions (runs + gym + cross-training + adhoc)
  const plannedWorkouts = wk
    ? generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
    )
    : [];
  const adhocExtra = wk
    ? (wk.adhocWorkouts || []).filter((w: any) => !(w.id || '').startsWith('garmin-') && !(w.id || '').startsWith('strava-')).length
    : 0;
  const sessionsPlan = plannedWorkouts.filter((w: any) => w.t !== 'rest').length + adhocExtra || s.rw || 5;

  // Distance this week (running only from garmin, or completedKm)
  const kmDone = wk
    ? Object.entries(wk.garminActuals || {})
      .filter(([k, a]) => isRunKey(k, (a as any).activityType))
      .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;
  const _parseKmFromDesc = (desc: string): number => {
    const matches = [...(desc || '').matchAll(/(\d+\.?\d*)km/g)];
    return matches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
  };
  const _isRunType = (t: string) => t !== 'cross' && t !== 'gym' && t !== 'strength' && t !== 'rest';
  const kmPlan = plannedWorkouts
    .filter((w: any) => _isRunType(w.t || ''))
    .reduce((sum: number, w: any) => sum + _parseKmFromDesc((w as any).d || ''), 0)
    || (s.rw || 5) * ((s.wks?.[s.w - 1] as any)?.targetKmPerRun || 10);

  // TSS this week vs plan — Signal B (full physiological load, all sports), matching the plan header.
  const tssActual = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const tssPlan = computePlannedSignalB(
    s.historicWeeklyTSS, s.ctlBaseline, wk?.ph ?? 'base',
    s.athleteTierOverride ?? s.athleteTier, s.rw,
    undefined, undefined, s.sportBaselineByType,
  );

  function bar(actual: number, plan: number, fmt: (v: number) => string, planFmt: (v: number) => string): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const overRatio = Math.max(0, ratio - 1);

    // Bar fill: cap the visual at 88% of container width
    // Within 88%: green portion = min(ratio, 1) × 88, amber = overshoot portion
    const greenWidth = Math.min(ratio, 1) * 88;
    const amberWidth = Math.min(overRatio, 0.3) * 88; // cap amber at 30% over
    const totalWidth = greenWidth + amberWidth;

    // Overflow label (+X%)
    const overPct = Math.round(overRatio * 100);
    const overLabel = overPct >= 5
      ? `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:${overPct >= 30 ? 'var(--c-warn)' : 'var(--c-caution)'}">${overPct >= 30 ? '+' + overPct + '%' : '+' + overPct + '%'}</span>`
      : '';

    // Colour: grey until 70%, then green, cap segments for over-target
    let fillStyle: string;
    if (ratio < 0.7) {
      fillStyle = `background:var(--c-muted);width:${totalWidth}%`;
    } else if (ratio <= 1.05) {
      fillStyle = `background:var(--c-ok);width:${totalWidth}%`;
    } else {
      // green to target, amber cap
      const targetPx = Math.min(1, 1) * 88; // target position within 88%
      fillStyle = `background:linear-gradient(to right, var(--c-ok) ${(88 / totalWidth * 100).toFixed(1)}%, var(--c-warn) ${(88 / totalWidth * 100).toFixed(1)}%);width:${totalWidth}%`;
    }

    return `<div class="m-prog-fill" style="${fillStyle}"></div>`;
  }

  // Simplified colour logic
  function fillBar(actual: number, plan: number): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const capWidth = 88; // max bar % width
    const targetPct = Math.min(ratio, 1) * capWidth;
    const overPct = Math.min(Math.max(0, ratio - 1), 0.42) * capWidth;
    const totalWidth = targetPct + overPct;

    if (ratio < 0.7) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-muted)"></div>`;
    }
    if (ratio <= 1.05) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-ok)"></div>`;
    }
    // overshoot: green body + red cap via gradient
    const greenPct = (targetPct / totalWidth * 100).toFixed(1);
    return `<div class="m-prog-fill" style="width:${totalWidth}%;background:linear-gradient(to right,var(--c-ok) ${greenPct}%,var(--c-warn) ${greenPct}%)"></div>`;
  }

  function overLabel(actual: number, plan: number, label = ''): string {
    if (plan <= 0) return '';
    const overPct = Math.round(((actual / plan) - 1) * 100);
    if (overPct < 5) return '';
    const text = label ? `+${overPct}% ${label}` : `+${overPct}%`;
    return `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:var(--c-warn)">${text}</span>`;
  }

  // Status pill
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeedProgress = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeedProgress);
  let pillHtml: string;
  let pillCaption: string;
  if (acwr.ratio <= 0 || (s.w < 3)) {
    pillHtml = `<span class="m-pill m-pill-neutral"><span class="m-pill-dot"></span>Load Building</span>`;
    pillCaption = 'Keep logging sessions — your baseline builds over the first 4 weeks.';
  } else if (acwr.status === 'high') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Load Spike</span>`;
    pillCaption = 'Load is spiking. Protect recovery before next week.';
  } else if (acwr.status === 'caution') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Load Rising</span>`;
    pillCaption = 'Load is rising fast. Keep today\'s session easy if possible.';
  } else {
    pillHtml = `<span class="m-pill m-pill-ok"><span class="m-pill-dot"></span>Load Balanced</span>`;
    pillCaption = sessionsDone >= sessionsPlan
      ? 'Great week — you hit all your sessions.'
      : `${sessionsPlan - sessionsDone} session${sessionsPlan - sessionsDone > 1 ? 's' : ''} left this week.`;
  }

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-sec-label">This Week</div>
      <div class="m-card p-4 flex flex-col gap-[13px]">

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Sessions</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em;color:var(--c-black)">${sessionsDone} / ${sessionsPlan}</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(sessionsDone, sessionsPlan)}</div>
            ${overLabel(sessionsDone, sessionsPlan)}
          </div>
        </div>

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Distance</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em;color:var(--c-black)">${formatKm(kmDone, s.unitPref ?? 'km')} / ${formatKm(kmPlan, s.unitPref ?? 'km')}</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(kmDone, kmPlan)}</div>
            ${overLabel(kmDone, kmPlan)}
          </div>
        </div>

        <div id="home-tss-row" class="flex flex-col gap-[7px]" style="cursor:pointer">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Training Load (TSS)</span>
            <div class="flex items-center gap-[6px]">
              <span class="text-[12px] font-medium" style="letter-spacing:-0.01em;color:var(--c-black)">${tssActual} / ${Math.round(tssPlan)} TSS</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.25"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </div>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(tssActual, tssPlan)}</div>
            ${overLabel(tssActual, tssPlan, 'excess load')}
          </div>
        </div>

        <div class="flex items-center gap-2 pt-[2px]">
          ${pillHtml}
          <span class="text-[12px]" style="color:var(--c-muted)">${pillCaption}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── SVG arc helpers ────────────────────────────────────────────────────────

function polarToCart(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = polarToCart(cx, cy, r, startDeg);
  const e = polarToCart(cx, cy, r, endDeg);
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

// ─── Training Readiness Ring ────────────────────────────────────────────────

function buildReadinessRing(s: SimulatorState): string {
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);

  // For readiness: same-signal TSB (Signal B for both CTL and ATL)
  // so cross-trainers aren't penalised by the A/B discount gap
  const sameSignal = computeSameSignalTSB(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctlNow = sameSignal?.ctl ?? 0;

  // Weighted directional momentum: recent week-over-week CTL deltas weighted 4/3/2/1 (newest first)
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const ctlFourWeeksAgo = metrics[metrics.length - 5]?.ctl ?? ctlNow;
  const ctlHistory = [ctlNow, ...([4,3,2,1].map(i => metrics[metrics.length - 1 - i]?.ctl ?? ctlNow))];
  // ctlHistory[0]=now, [1]=1wk ago, [2]=2wk, [3]=3wk, [4]=4wk
  const momentumScore = (ctlHistory[0] - ctlHistory[1]) * 4
                      + (ctlHistory[1] - ctlHistory[2]) * 3
                      + (ctlHistory[2] - ctlHistory[3]) * 2
                      + (ctlHistory[3] - ctlHistory[4]) * 1;
  const ctlRef = ctlNow || 1;
  const momentumThreshold = ctlRef * 0.015; // 1.5% of CTL = noise floor

  // Recovery data: prefer Garmin sleep when available; manual entry is a fallback only
  const today = new Date().toISOString().split('T')[0];
  const manualToday = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const latestPhysio = s.physiologyHistory?.slice(-1)[0];
  const garminTodaySleep = (s.physiologyHistory ?? []).find(p => p.date === today && p.sleepScore != null);
  const sleepScore: number | null = garminTodaySleep?.sleepScore ?? manualToday?.sleepScore ?? latestPhysio?.sleepScore ?? null;
  const hrvRmssd: number | null = latestPhysio?.hrvRmssd ?? null;
  const hrvAll = (s.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length)
    : null;

  const effectiveSleepTarget0 = s.sleepTargetSec ?? deriveSleepTarget(s.physiologyHistory ?? []);
  const sleepBank = getSleepBank(s.physiologyHistory ?? [], effectiveSleepTarget0);

  // ── Strain Score ───────────────────────────────────────────────────────────
  // Today's completed Signal B TSS vs the day's target.
  // Target: use today's planned workout TSS when the plan has sessions scheduled,
  // otherwise fall back to signalBBaseline ÷ 7 (typical daily average).
  // This means 100% = "you completed what was planned for today".
  const strainWk = (s.wks ?? [])[s.w - 1];
  const todaySignalBTSS = strainWk ? computeTodaySignalBTSS(strainWk, today) : 0;
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  const plannedWorkouts = strainWk ? generateWeekWorkouts(
    strainWk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), strainWk.scheduledAcwrStatus,
  ) : [];
  const plannedDayTSS = computePlannedDaySignalBTSS(plannedWorkouts, todayDayOfWeek);
  const targetTSS = plannedDayTSS > 0 ? plannedDayTSS : Math.max((s.signalBBaseline ?? 0) / 7, 1);
  const strainPct = todaySignalBTSS > 0 ? (todaySignalBTSS / targetTSS) * 100 : 0;

  const readiness: ReadinessResult = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    sleepScore,
    hrvRmssd,
    sleepHistory: s.physiologyHistory ?? [],
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    weeksOfHistory: metrics.length,
    strainPct: todaySignalBTSS > 0 ? strainPct : null,
  });

  // Sentence: strain-aware override takes priority over the TSB/ACWR matrix sentence.
  // When load has hit or exceeded the day's target, the TSB/ACWR sentence ("Full session.",
  // "Session as planned." etc.) is misleading — the session is already done.
  const currentWk = (s.wks ?? [])[s.w - 1];
  const trainedToday = todaySignalBTSS > 0; // covers garminActuals + adhocWorkouts (both feed computeTodaySignalBTSS)
  let readinessSentence: string;
  if (strainPct >= 130) {
    readinessSentence = "Daily load exceeded target. Additional training today raises injury risk.";
  } else if (strainPct >= 100) {
    readinessSentence = "Daily target hit. Training is complete for today.";
  } else if (trainedToday) {
    readinessSentence = "Session logged. Rest for the remainder of the day.";
  } else {
    readinessSentence = readiness.sentence;
  }

  const color = readinessColor(readiness.label);

  // SVG rings: 270° arc, starts bottom-left (135°), fills clockwise. 120×120 for side-by-side layout.
  const CX = 60, CY = 60, R = 44, SW = 8;
  const START = 135;
  const SWEEP = 270;
  const fillEnd = START + (readiness.score / 100) * SWEEP;
  const trackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const fillPathStr = readiness.score > 0 ? arcPath(CX, CY, R, START, Math.min(fillEnd, START + SWEEP - 0.01)) : '';

  // Strain ring
  const strainColor = strainPct >= 130 ? 'var(--c-warn)' : strainPct >= 80 ? 'var(--c-ok)' : 'var(--c-caution)';
  const strainLabel = strainPct >= 130 ? 'Exceeded' : strainPct >= 100 ? 'Target hit' : strainPct >= 80 ? 'On target' : 'Below target';
  const strainFillPct = Math.min(strainPct / 100, 1);
  const strainFillEnd = START + strainFillPct * SWEEP;
  const sTrackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const sArcFill = todaySignalBTSS > 0 && strainFillPct > 0
    ? arcPath(CX, CY, R, START, Math.min(strainFillEnd, START + SWEEP - 0.01))
    : '';

  // Sub-signal display values
  // ÷7: display in daily-equivalent units (TrainingPeaks-compatible)
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;
  const tsbZone = tsb > 0 ? 'Fresh' : tsb >= -10 ? 'Recovering' : tsb >= -25 ? 'Fatigued' : 'Overtrained';
  const safetyLabel = acwr.ratio <= 0 ? '—' : acwr.status === 'safe' ? 'Safe' : acwr.status === 'caution' ? 'Elevated' : acwr.status === 'high' ? 'High Risk' : 'Low';
  const safetyColor = acwr.status === 'high' ? 'var(--c-warn)' : acwr.status === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)';
  const momentumArrow = momentumScore > momentumThreshold ? '↗' : momentumScore >= -momentumThreshold ? '→' : '↘';
  const momentumColor = momentumScore > momentumThreshold ? 'var(--c-ok)' : momentumScore >= -momentumThreshold * 2 ? 'var(--c-caution)' : 'var(--c-warn)';

  // Recovery score from physiologyHistory — inject today's manual sleep only if Garmin hasn't sent data
  const todayStr0 = new Date().toISOString().split('T')[0];
  const manualSleepToday0 = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === todayStr0 && e.source === 'manual',
  );
  const noGarminSleep0 = !(s.physiologyHistory ?? []).find(p => p.date === todayStr0 && p.sleepScore != null);
  const physioForRecovery0 = (() => {
    const h = s.physiologyHistory ?? [];
    // Only inject manual sleep when Garmin hasn't sent today's data — Garmin takes priority
    if (!manualSleepToday0?.sleepScore || !noGarminSleep0) return h;
    const idx = h.findIndex(p => p.date === todayStr0);
    if (idx >= 0) return h.map((p, i) => i === idx ? { ...p, sleepScore: manualSleepToday0.sleepScore } : p);
    return [...h, { date: todayStr0, sleepScore: manualSleepToday0.sleepScore }];
  })();
  const suppressSleep0 = noGarminSleep0 && !manualSleepToday0?.sleepScore;
  const recoveryResult = computeRecoveryScore(physioForRecovery0, { suppressSleepIfNotToday: suppressSleep0, manualSleepScore: noGarminSleep0 ? (manualSleepToday0?.sleepScore ?? undefined) : undefined });
  const recoveryScoreColor = recoveryResult.hasData
    ? (recoveryResult.score! < 40 ? 'var(--c-warn)' : recoveryResult.score! < 65 ? 'var(--c-caution)' : 'var(--c-ok)')
    : 'var(--c-faint)';

  // ISSUE 1: Driving signal highlight — coloured left border + "⬇ Main factor" label
  const isDriving = (sig: string) => readiness.drivingSignal === sig;
  const drivingBorderStyle = (sig: string) => isDriving(sig)
    ? 'border-left:3px solid var(--c-warn);padding-left:9px;margin-left:-3px;'
    : '';
  const drivingTag = (sig: string) => isDriving(sig)
    ? `<div style="font-size:9px;color:var(--c-warn);margin-top:3px;font-weight:600">⬇ Main factor</div>`
    : '';

  // ISSUE 3: Adjust button text varies by driving signal
  const adjustText = readiness.drivingSignal === 'fitness' ? 'Swap to easy run'
    : readiness.drivingSignal === 'safety' ? 'Reduce session load'
      : readiness.drivingSignal === 'recovery' ? 'Take it lighter today'
        : "Keep consistency — don't skip";

  const recoveryPillHtml = recoveryResult.hasData
    ? `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('recovery')}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Recovery</div>
        <div style="font-size:14px;font-weight:500;color:${recoveryScoreColor}">${recoveryResult.score}/100</div>
        ${drivingTag('recovery')}
      </div>`
    : `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;opacity:0.45;cursor:pointer">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Recovery</div>
        <div style="font-size:11px;color:var(--c-faint)">${recoveryResult.dataStale ? 'Sync Garmin' : 'Connect watch'}</div>
      </div>`;

  // Recovery row (RHR sub-caption)
  let rhrCaption = '';
  if (latestPhysio?.restingHR != null) {
    const rhrValues = (s.physiologyHistory ?? []).map((p: any) => p.restingHR).filter((v: any) => v != null) as number[];
    const rhrAvg = rhrValues.length > 1 ? Math.round(rhrValues.slice(0, -1).reduce((a, b) => a + b, 0) / (rhrValues.length - 1)) : null;
    const rhrDiff = rhrAvg != null ? latestPhysio.restingHR - rhrAvg : 0;
    const arrow = rhrDiff > 2 ? ' ↑' : rhrDiff < -2 ? ' ↓' : '';
    rhrCaption = `RHR: ${latestPhysio.restingHR}bpm${arrow} · `;
  }

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-sec-label">Training Readiness</div>
      <div id="home-readiness-card" class="m-card overflow-hidden" style="cursor:pointer">

        <!-- Two rings side by side: Readiness + Strain -->
        <div style="display:flex;flex-direction:row;align-items:flex-start;justify-content:space-around;padding:20px 16px 8px;gap:8px">

          <!-- Readiness ring -->
          <div style="flex:1;display:flex;flex-direction:column;align-items:center">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;color:var(--c-faint);text-transform:uppercase;margin-bottom:8px">Readiness</div>
            <div style="position:relative;width:120px;height:120px">
              <svg viewBox="0 0 120 120" width="120" height="120" style="display:block;overflow:visible">
                <path d="${trackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${fillPathStr ? `<path d="${fillPathStr}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round"/>` : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-4px">
                <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${color}">${readiness.score}</div>
                <div style="font-size:11px;font-weight:600;letter-spacing:0.01em;margin-top:2px;color:var(--c-black)">${readiness.label}</div>
              </div>
            </div>
          </div>

          <!-- Strain ring -->
          <div id="home-strain-ring" style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;color:var(--c-faint);text-transform:uppercase;margin-bottom:8px">Strain</div>
            <div style="position:relative;width:120px;height:120px">
              <svg viewBox="0 0 120 120" width="120" height="120" style="display:block;overflow:visible">
                <path d="${sTrackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${sArcFill ? `<path d="${sArcFill}" fill="none" stroke="${strainColor}" stroke-width="${SW}" stroke-linecap="round"/>` : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-4px">
                ${todaySignalBTSS > 0
                  ? `<div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${strainColor}">${todaySignalBTSS}</div>
                     <div style="font-size:9px;color:var(--c-faint);margin-top:1px">/ ${Math.round(targetTSS)} target</div>
                     <div style="font-size:11px;font-weight:600;letter-spacing:0.01em;margin-top:2px;color:var(--c-black)">${strainLabel}</div>`
                  : plannedDayTSS > 0
                    ? `<div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black)">${Math.round(plannedDayTSS)}</div>
                       <div style="font-size:9px;color:var(--c-faint);margin-top:1px">TSS target</div>
                       <div style="font-size:11px;font-weight:600;letter-spacing:0.01em;margin-top:2px;color:var(--c-faint)">Not started</div>`
                    : `<div style="font-size:20px;font-weight:300;letter-spacing:-0.02em;line-height:1;color:var(--c-faint)">Rest</div>
                       <div style="font-size:10px;color:var(--c-faint);margin-top:4px">No sessions today</div>`
                }
              </div>
            </div>
          </div>

        </div>

        <!-- Sentence -->
        <p style="font-size:13px;color:var(--c-muted);text-align:center;line-height:1.45;margin:0 16px 14px;max-width:none">${readinessSentence}</p>

        <!-- Signal pills (always visible; each pill tappable for detail) -->
        <div id="home-readiness-pills" style="border-top:1px solid var(--c-border);padding:12px 14px">
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">

            <div class="home-readiness-pill" data-pill="fitness" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('fitness')}">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Freshness</div>
              <div style="font-size:14px;font-weight:500;color:${readiness.fitnessScore < 40 ? 'var(--c-warn)' : readiness.fitnessScore < 65 ? 'var(--c-caution)' : 'var(--c-ok)'}">${tsbLabel}</div>
              <div style="font-size:10px;color:var(--c-faint)">${tsbZone}</div>
              ${drivingTag('fitness')}
            </div>

            <div class="home-readiness-pill" data-pill="safety" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('safety')}">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Injury Risk</div>
              <div style="font-size:14px;font-weight:500;color:${safetyColor}">${safetyLabel}</div>
              <div style="font-size:10px;color:var(--c-faint)">${acwr.ratio > 0 ? acwr.ratio.toFixed(2) + '×' : 'No data'}</div>
              ${drivingTag('safety')}
            </div>

            ${recoveryPillHtml}

          </div>
          <p style="font-size:11px;color:var(--c-faint);margin-top:4px">${recoveryResult.hasData ? rhrCaption.replace(/ · $/, '') + (sleepScore != null ? (rhrCaption ? ' · ' : '') + `Sleep ${Math.round(sleepScore)}/100` : '') : 'Connect a watch to unlock Recovery signal.'}</p>

          ${readiness.score <= 59 ? `
          <button id="readiness-adjust-btn" style="margin-top:10px;width:100%;padding:9px 14px;border-radius:999px;border:1px solid var(--c-border);cursor:pointer;font-size:13px;font-weight:500;background:transparent;color:var(--c-black);font-family:var(--f);text-align:center">
            ${adjustText}
          </button>` : ''}
        </div>

      </div>
    </div>
  `;
}

// ─── Readiness pill info sheets ──────────────────────────────────────────────

type PillSignal = 'fitness' | 'safety' | 'momentum' | 'recovery';

interface PillSheetData {
  tsb: number; tsbZone: string; tsbLabel: string; fitnessScore: number;
  acwrRatio: number; safetyLabel: string;
  ctlNow: number; ctlFourWeeksAgo: number; momentumArrow: string; momentumScore: number; momentumThreshold: number;
  recoveryScore: number | null; sleepScore: number | null; rhrCaption: string; hasRecovery: boolean;
  // Rich recovery breakdown (from computeRecoveryScore)
  recoveryHasData?: boolean;
  recoveryCompositeScore?: number | null;
  sleepSubScore?: number | null;
  hrvSubScore?: number | null;
  rhrSubScore?: number | null;
  rhrRawBpm?: number | null;
  rhrTrend?: string;
  /** Most recent single-night sleep score — shown as "Last night: X/100". */
  lastNightSleep?: number | null;
  /** ISO date of lastNightSleep — used to show the correct label when data is stale. */
  lastNightSleepDate?: string | null;
  /** Most recent single-night HRV value (ms) — shown as context, not used in score. */
  lastNightHrv?: number | null;
  /** ISO date of lastNightHrv — used to show "2 nights ago" when not synced last night. */
  lastNightHrvDate?: string | null;
  /** True when data exists but is >3 days old (stale sync) */
  recoveryDataStale?: boolean;
  /** ISO date of most recent physiology entry */
  recoveryLastSyncDate?: string | null;
  // Trend context for Option-B display (7-day avg · Baseline)
  sleepWeekAvg?: number | null;
  sleepBaseline?: number | null;
  hrvWeekAvg?: number | null;
  hrvBaseline?: number | null;
  rhrWeekAvg?: number | null;
  rhrBaseline?: number | null;
  /** True when no Garmin sleep score has arrived for today. */
  noGarminSleepToday?: boolean;
  /** Today's manually-entered sleep score (0–100), if logged by the user. */
  manualSleepScore?: number | null;
  /** True when physiologyHistory contains at least one past night with a sleep score. */
  hasHistoricSleep?: boolean;
}

function showReadinessPillSheet(signal: PillSignal, d: PillSheetData): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';

  const scaleBar = (zones: Array<{ label: string; flex: number; color: string }>, markerPct: number | null) => `
    <div style="position:relative;height:10px;border-radius:5px;overflow:hidden;display:flex;gap:1px;margin-top:12px">
      ${zones.map(z => `<div style="flex:${z.flex};height:100%;background:${z.color}"></div>`).join('')}
      ${markerPct != null ? `<div style="position:absolute;top:-3px;left:${markerPct}%;transform:translateX(-50%);width:4px;height:16px;background:var(--c-black);border-radius:2px;border:1.5px solid white;z-index:2"></div>` : ''}
    </div>
    <div style="display:flex;gap:1px;margin-top:3px">
      ${zones.map(z => `<div style="flex:${z.flex};font-size:8px;color:var(--c-faint);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${z.label}</div>`).join('')}
    </div>`;

  let title = '', subtitle = '', body = '';

  if (signal === 'fitness') {
    title = 'Freshness'; subtitle = 'The gap between your fitness and your recent fatigue';
    const tsbDailyVal = d.tsb / 7;
    const markerPct = Math.min(98, Math.max(2, ((tsbDailyVal + 6) / 10) * 100));
    const what = tsbDailyVal > 1
      ? "Your body is well-rested and primed to perform. This is ideal territory for a race or a key session."
      : tsbDailyVal > 0 ? "Your body is fresh — your short-term load is lower than your fitness baseline."
        : tsbDailyVal > -2 ? "You've trained recently but your body is handling it well."
          : tsbDailyVal > -4 ? "You've built up meaningful fatigue. Your body is under training stress."
            : "Your body is carrying significant accumulated fatigue — short-term load has well exceeded what your fitness can absorb.";
    const action = d.tsbZone === 'Overtrained' ? 'Take 1–2 rest days. When you do train, keep effort very easy.'
      : d.tsbZone === 'Fatigued' ? 'Consider an easy effort or a lighter day to let your body recover.'
        : d.tsbZone === 'Recovering' ? 'Good balance. Session as planned.'
          : d.tsbZone === 'Peaked' ? 'Perfect timing for a race or a hard key session — your body is ready to go.'
            : "Your body is fresh — full session, or a little extra if you feel good.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.02em">${d.tsbLabel} <span style="font-size:13px;color:var(--c-muted)">${d.tsbZone}</span></div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      ${scaleBar([
      { label: 'Overtrained', flex: 15, color: 'rgba(255,69,58,0.6)' },
      { label: 'Fatigued', flex: 15, color: 'rgba(255,159,10,0.55)' },
      { label: 'Recovering', flex: 10, color: 'rgba(78,159,229,0.4)' },
      { label: 'Fresh', flex: 10, color: 'rgba(52,199,89,0.55)' },
      { label: 'Peaked', flex: 10, color: 'rgba(52,199,89,0.85)' },
    ], markerPct)}
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px"><strong>What to do:</strong> ${action}</p>
      <p style="font-size:11px;color:var(--c-faint);margin-top:10px;line-height:1.5">Freshness measures whether your body has had enough time to absorb recent training. It's the gap between your long-term fitness (built over 6 weeks) and your short-term fatigue (last 7 days). Positive = more rested than usual. Negative = carrying fatigue.</p>`;

  } else if (signal === 'safety') {
    title = 'Load Safety (Injury Risk)'; subtitle = 'How fast your training load is increasing';
    const markerPct = d.acwrRatio > 0
      ? Math.min(98, Math.max(2, ((d.acwrRatio - 0.5) / 1.5) * 100))
      : null;
    const what = d.acwrRatio <= 0 ? 'Not enough training history to calculate.'
      : d.acwrRatio <= 1.3 ? "Your recent load is similar to your long-term baseline — safe territory."
        : d.acwrRatio <= 1.5 ? "Your load is ramping faster than usual. Consider whether it's sustainable."
          : "Significant load spike. Your body may not have had time to adapt.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.02em">${d.acwrRatio > 0 ? d.acwrRatio.toFixed(2) + '×' : '—'} <span style="font-size:13px;color:var(--c-muted)">${d.safetyLabel}</span></div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      ${scaleBar([
      { label: 'Safe', flex: 8, color: 'rgba(52,199,89,0.55)' },
      { label: 'Elevated',      flex: 2, color: 'rgba(255,159,10,0.55)' },
      { label: 'High Risk', flex: 5, color: 'rgba(255,69,58,0.55)' },
    ], markerPct)}`;

  } else if (signal === 'momentum') {
    title = 'Running Fitness Momentum'; subtitle = 'Whether your running fitness is trending up or down';
    const direction = d.momentumScore > d.momentumThreshold ? 'Building'
      : d.momentumScore >= -d.momentumThreshold ? 'Stable' : 'Declining';
    const what = direction === 'Building'
      ? 'Your training load over the last 4 weeks has been increasing — your body is adapting and getting fitter.'
      : direction === 'Stable'
        ? 'Your training load over the last 4 weeks has been consistent. Your body has a solid baseline to work from.'
        : 'Your training load has dropped compared to 4 weeks ago. Try to stay consistent — skipping sessions compounds quickly.';
    const whyItMatters = "Momentum isn't about today's recovery — it's about your body's capacity to handle training. A stable or rising baseline means your tendons, muscles, and aerobic system are conditioned for the work ahead.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300">${d.momentumArrow} ${direction}</div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px">${whyItMatters}</p>`;

  } else {
    title = 'Recovery'; subtitle = 'Sleep, HRV and resting heart rate';
    const recHasData = d.recoveryHasData ?? d.hasRecovery;
    if (!recHasData) {
      const isStale = d.recoveryDataStale;
      const lastSync = d.recoveryLastSyncDate;
      const daysAgo = lastSync
        ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 86400000)
        : null;
      const staleMsg = daysAgo != null
        ? `Your Garmin data hasn't updated in ${daysAgo} day${daysAgo === 1 ? '' : 's'} (last synced ${lastSync}).`
        : `Your Garmin data hasn't updated recently.`;
      body = `
        <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
          ${isStale ? `
            <p style="font-size:13px;color:var(--c-muted);margin-bottom:10px">${staleMsg}</p>
            <p style="font-size:13px;font-weight:500;color:var(--c-black)">Open Garmin Connect and sync your watch to update your recovery data.</p>
          ` : `
            <p style="font-size:13px;color:var(--c-muted)">Connect a Garmin watch to see your recovery data — sleep score, HRV, and resting heart rate.</p>
          `}
        </div>`;
    } else {
      const rs = d.recoveryCompositeScore ?? d.recoveryScore ?? 0;
      const zone = rs >= 75 ? 'Excellent' : rs >= 55 ? 'Good' : rs >= 35 ? 'Fair' : 'Poor';
      const advice = rs >= 75 ? "You're well rested. Full session as planned."
        : rs >= 55 ? 'Reasonable recovery. Listen to your body during the session.'
          : 'Prioritise sleep tonight. Consider a lighter effort today.';

      // Mini position bar for each recovery metric.
      // primaryRight: when set, replaces the score pill in the header (used for
      // HRV and RHR where the raw measurement is more meaningful than the score).
      // The score/zone is then shown as a secondary faint line below.
      const recBar = (score: number | null | undefined, label: string, rawLine?: string, primaryRight?: string) => {
        if (score == null) return '';
        const markerPct = Math.min(98, Math.max(2, score));
        const barZones = [
          { l: 'Poor', f: 35, c: 'rgba(255,69,58,0.55)' },
          { l: 'Fair', f: 20, c: 'rgba(255,159,10,0.50)' },
          { l: 'Good', f: 20, c: 'rgba(52,199,89,0.45)' },
          { l: 'Excellent', f: 25, c: 'rgba(52,199,89,0.75)' },
        ];
        const metricZone = score >= 75 ? 'Excellent' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Poor';
        const metricColor = score >= 55 ? 'var(--c-ok)' : score >= 35 ? 'var(--c-caution)' : 'var(--c-warn)';
        const headerRight = primaryRight
          ? `<span style="font-size:14px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${primaryRight}</span>`
          : `<span style="font-size:11px;color:${metricColor};font-variant-numeric:tabular-nums"><strong>${Math.round(score)}/100</strong> · ${metricZone}</span>`;
        const scoreLine = primaryRight
          ? `<div style="font-size:10px;color:${metricColor};margin-bottom:2px;font-variant-numeric:tabular-nums">${Math.round(score)}/100 · ${metricZone}</div>`
          : '';
        return `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
              <span style="font-size:11px;font-weight:600;color:var(--c-black)">${label}</span>
              ${headerRight}
            </div>
            ${scoreLine}
            ${rawLine ? `<div style="font-size:10px;color:var(--c-faint);margin-bottom:4px">${rawLine}</div>` : ''}
            <div style="position:relative;height:8px;margin:3px 0">
              <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;gap:1px">
                ${barZones.map(z => `<div style="flex:${z.f};height:100%;background:${z.c}"></div>`).join('')}
              </div>
              <div style="position:absolute;top:-3px;left:${markerPct}%;transform:translateX(-50%);width:3px;height:14px;background:var(--c-black);border-radius:2px;border:1.5px solid white;z-index:2"></div>
            </div>
            <div style="display:flex;gap:1px;margin-top:2px">
              ${barZones.map(z => `<div style="flex:${z.f};font-size:8px;color:var(--c-faint);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${z.l}</div>`).join('')}
            </div>
          </div>`;
      };

      const sleepRawLine = (() => {
        const parts: string[] = [];
        const today = new Date().toISOString().split('T')[0];
        if (d.manualSleepScore != null) {
          parts.push(`Manual: ${Math.round(d.manualSleepScore)}/100`);
        } else if (d.lastNightSleep != null) {
          const isLastNight = !d.lastNightSleepDate || d.lastNightSleepDate === today;
          const sleepLabel = isLastNight ? 'Last night' : fmtDateUK(d.lastNightSleepDate!);
          parts.push(`${sleepLabel}: ${Math.round(d.lastNightSleep)}/100`);
        }
        if (d.sleepWeekAvg != null)   parts.push(`7-day avg: ${d.sleepWeekAvg}/100`);
        if (d.sleepBaseline != null)  parts.push(`Baseline: ${d.sleepBaseline}/100`);
        return parts.length > 0 ? parts.join(' · ') : undefined;
      })();
      // HRV: show 7-day avg ms as primary, baseline as context
      const hrvPrimary = d.hrvWeekAvg != null ? `${d.hrvWeekAvg} ms` : undefined;
      const hrvRawLine = d.hrvBaseline != null ? `Baseline: ${d.hrvBaseline} ms` : undefined;
      // RHR: show 7-day avg bpm as primary, baseline as context
      const rhrPrimary = d.rhrWeekAvg != null ? `${d.rhrWeekAvg} bpm` : undefined;
      const rhrRawLine = d.rhrBaseline != null ? `Baseline: ${d.rhrBaseline} bpm` : undefined;

      const noGarminSleep = d.noGarminSleepToday ?? false;
      const hasManual = d.manualSleepScore != null;
      const sleepActionNote = noGarminSleep && !hasManual
        ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
             <span style="font-size:11px;color:var(--c-muted)">No sleep data from Garmin yet</span>
             <button id="sleep-log-manual-btn" style="font-size:11px;color:var(--c-accent);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Log manually</button>
           </div>`
        : hasManual
          ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
               <span style="font-size:11px;color:var(--c-muted)">Sleep logged manually</span>
               <button id="sleep-log-manual-btn" style="font-size:11px;color:var(--c-accent);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Edit</button>
             </div>`
          : `<div style="margin-top:6px;text-align:right">
               <button id="sleep-log-manual-btn" style="font-size:11px;color:var(--c-faint);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Log manually</button>
             </div>`;

      body = `
        <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
          <div style="font-size:22px;font-weight:300">${Math.round(rs)}/100 <span style="font-size:13px;color:var(--c-muted)">${zone}</span></div>
          <p style="font-size:12px;color:var(--c-muted);margin-top:2px">${advice}</p>
          <p style="font-size:10px;color:var(--c-faint);margin-top:4px">${
            d.noGarminSleepToday && !d.manualSleepScore
              ? 'HRV trend and resting HR vs your 28-day baseline. Sleep not included — no data yet.'
              : 'Composite of sleep score, HRV trend, and resting HR vs your 28-day baseline.'
          }</p>
          <div id="recovery-sleep-row" ${(d.sleepSubScore != null || d.hasHistoricSleep) ? 'style="cursor:pointer"' : ''}>
            ${d.sleepSubScore != null
              ? recBar(d.sleepSubScore, 'Sleep', sleepRawLine)
              : d.hasHistoricSleep
                ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:8px 0;border-top:1px solid var(--c-border)"><span style="font-size:11px;font-weight:600;color:var(--c-black)">Sleep</span><span style="font-size:11px;color:var(--c-muted)">View history ›</span></div>`
                : ''}
          </div>
          ${sleepActionNote}
          <div id="recovery-hrv-row" style="cursor:pointer">
            ${recBar(d.hrvSubScore, 'HRV', hrvRawLine, hrvPrimary)}
          </div>
          <div id="recovery-rhr-row" style="cursor:pointer">
            ${recBar(d.rhrSubScore, 'Resting Heart Rate', rhrRawLine, rhrPrimary)}
          </div>
        </div>`;
    }
  }

  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div>
          <h2 class="font-semibold" style="color:var(--c-black)">${title}</h2>
          <p style="font-size:12px;color:var(--c-muted);margin-top:1px">${subtitle}</p>
        </div>
        <button id="pill-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">✕</button>
      </div>
      <div class="px-4 py-4 space-y-3 text-sm">${body}</div>
      ${signal !== 'recovery' ? `
      <div class="px-4 pb-4">
        <button id="pill-sheet-to-stats" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--c-border);cursor:pointer;font-size:13px;font-weight:500;background:rgba(0,0,0,0.04);color:var(--c-black);font-family:var(--f)">
          View full breakdown in Stats
        </button>
      </div>` : ''}
    </div>`;

  overlay.dataset.pillSheet = 'recovery';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#pill-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#pill-sheet-to-stats')?.addEventListener('click', () => {
    close();
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  });
  // "Log manually" button lives inside the sleep row — wire it first so it can
  // stop propagation before the row-level handler opens the sleep history sheet.
  overlay.querySelector('#sleep-log-manual-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showManualSleepPicker();
  });
  overlay.querySelector('#recovery-sleep-row')?.addEventListener('click', () => {
    // Navigate when there is today's data OR historic nights to show.
    if (d.noGarminSleepToday && !d.manualSleepScore && !d.hasHistoricSleep) return;
    close();
    const s3 = getState();
    import('./sleep-view').then(({ renderSleepView }) => {
      renderSleepView(undefined, s3.physiologyHistory ?? [], s3.wks ?? [], () => showReadinessPillSheet(signal, d));
    });
  });
  overlay.querySelector('#recovery-hrv-row')?.addEventListener('click', () => {
    close();
    const s3 = getState();
    showHrvSheet(s3.physiologyHistory ?? [], () => showReadinessPillSheet(signal, d));
  });
  overlay.querySelector('#recovery-rhr-row')?.addEventListener('click', () => {
    close();
    const s3 = getState();
    showRhrSheet(s3.physiologyHistory ?? [], () => showReadinessPillSheet(signal, d));
  });
}


// ─── Daily Headline Narrative ───────────────────────────────────────────────

/**
 * Synthesises today's key signals into a 2-sentence plain-English card.
 * Returns '' when there's nothing notable to say (no noise card).
 *
 * Priority order:
 *   1. Recovery debt (red)
 *   2. Recovery debt (orange)
 *   3. HRV significantly suppressed (>12% below 7-day avg)
 *   4. HRV significantly elevated (>12% above 7-day avg)
 *   5. Sleep streak (2+ poor nights in last 3)
 *   6. Recent high-load cross-training in last 48h (padel, gym, etc.)
 *   7. ACWR high or caution (only flags caution when today is hard)
 *   Else: return '' — silence is better than a filler card.
 */
function buildDailyHeadline(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const prevWk = s.wks?.[s.w - 2];
  const physio = s.physiologyHistory ?? [];

  // ── HRV delta vs 7-day personal average ──────────────────────────────────
  const latestPhysio = physio.slice(-1)[0];
  const hrvToday: number | null = latestPhysio?.hrvRmssd ?? null;
  const hrvAll = physio.map(p => (p as any).hrvRmssd).filter(v => v != null) as number[];
  const hrvAvg: number | null = hrvAll.length >= 3
    ? hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length
    : null;
  const hrvDeltaPct: number | null = (hrvToday != null && hrvAvg != null)
    ? Math.round((hrvToday - hrvAvg) / hrvAvg * 100)
    : null;

  // ── Sleep streak (poor nights) ────────────────────────────────────────────
  const last3Sleep = physio
    .filter(d => (d as any).sleepScore != null)
    .slice(-3)
    .map(d => (d as any).sleepScore as number);
  const badNights = last3Sleep.filter(sc => sc < 60).length;

  // ── Recovery debt ─────────────────────────────────────────────────────────
  const recoveryDebt = (wk as any)?.recoveryDebt as 'orange' | 'red' | undefined;

  // ── Recent high-load cross-training (last 48h, current + prev week) ──────
  const now = Date.now();
  const ms48 = 48 * 60 * 60 * 1000;

  let recentCT: { label: string; tss: number } | null = null;

  function checkWkForCrossTraining(week: typeof wk) {
    if (!week) return;

    // garminActuals — skip runs
    for (const [key, act] of Object.entries(week.garminActuals ?? {})) {
      const a = act as any;
      if (isRunKey(key, a.activityType)) continue;
      if (!a.startTime) continue;
      const actMs = new Date(a.startTime).getTime();
      if (actMs < now - ms48 || actMs >= now) continue;
      let tss = 0;
      if (a.iTrimp != null && a.iTrimp > 0) {
        tss = (a.iTrimp * 100) / 15000;
      } else {
        const durMin = a.durationSec > 0 ? a.durationSec / 60 : 30;
        tss = durMin * 0.92;
      }
      if (tss > 25 && (!recentCT || tss > recentCT.tss)) {
        const label = a.displayName || (a.activityType ? formatActivityType(a.activityType) : 'Activity');
        recentCT = { label, tss: Math.round(tss) };
      }
    }

    // adhocWorkouts — use garminTimestamp for date
    for (const w of (week.adhocWorkouts ?? []) as any[]) {
      const ts: string | undefined = w.garminTimestamp;
      if (!ts) continue;
      const actMs = new Date(ts).getTime();
      if (actMs < now - ms48 || actMs >= now) continue;
      let tss = 0;
      if (w.iTrimp != null && w.iTrimp > 0) {
        tss = (w.iTrimp * 100) / 15000;
      } else {
        const rpe = w.rpe ?? w.r ?? 5;
        const durMin = parseDurMinLocal(w.d ?? '');
        tss = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
      }
      if (tss > 25 && (!recentCT || tss > recentCT.tss)) {
        const label = (w.n ?? w.name ?? 'Session')
          .replace(' (Garmin)', '').replace(' (Strava)', '');
        recentCT = { label, tss: Math.round(tss) };
      }
    }
  }

  checkWkForCrossTraining(wk);
  checkWkForCrossTraining(prevWk);
  const recentCTFinal = recentCT as { label: string; tss: number } | null;

  // ── ACWR ──────────────────────────────────────────────────────────────────
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);

  // ── Today's planned workout (lightweight — just type + name) ──────────────
  let todayIsHard = false;
  let todayWorkoutName = '';
  if (wk) {
    const workouts = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), (wk as any).scheduledAcwrStatus,
    );
    // Apply day moves
    if ((wk as any).workoutMoves) {
      for (const [id, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
        const w = workouts.find((wo: any) => (wo.id || wo.n) === id);
        if (w) (w as any).dayOfWeek = newDay;
      }
    }
    const jsDay = new Date().getDay();
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;
    const active = workouts.filter((wo: any) => wo.status !== 'skip' && wo.status !== 'replaced');
    const todayW: any = active.find((wo: any) => wo.dayOfWeek === ourDay)
      ?? active.filter((wo: any) => !wk.rated[wo.id || wo.n])[0]
      ?? null;
    if (todayW) {
      todayIsHard = isHardWorkout(todayW.t);
      todayWorkoutName = todayW.n || '';
    }
  }

  // ── Priority rules ────────────────────────────────────────────────────────
  let headline = '';
  let body = '';

  if (recoveryDebt === 'red') {
    headline = 'Recovery is significantly suppressed';
    body = todayIsHard
      ? `Hard sessions on poor sleep or suppressed HRV raise injury risk and blunt the training stimulus. Converting today's ${todayWorkoutName} to easy effort is the better option.`
      : 'Sleep or HRV is well below baseline. Easy movement or rest is appropriate today.';
  } else if (recoveryDebt === 'orange') {
    headline = 'Recovery below baseline';
    body = todayIsHard
      ? `Sleep or HRV is below your normal range. If ${todayWorkoutName} feels harder than usual, back off — forcing intensity on a poor recovery produces less adaptation, not more.`
      : 'Sleep or HRV is below baseline. Keep today easy and prioritise sleep tonight.';
  } else if (hrvDeltaPct !== null && hrvDeltaPct < -12) {
    headline = `HRV ${Math.abs(hrvDeltaPct)}% below 7-day average`;
    body = todayIsHard
      ? `Hard sessions on suppressed HRV produce lower adaptation and carry higher injury risk. Consider moving ${todayWorkoutName} by 24 hours.`
      : 'HRV suppression at this level typically resolves within 24–48 hours with easy training or rest.';
  } else if (hrvDeltaPct !== null && hrvDeltaPct > 12) {
    headline = `HRV ${hrvDeltaPct}% above 7-day average`;
    body = todayIsHard
      ? `Physiological recovery is strong. Conditions are good for ${todayWorkoutName}.`
      : 'Physiological recovery is strong. No adjustments needed.';
  } else if (badNights >= 2) {
    headline = `${badNights} poor nights in the last ${last3Sleep.length}`;
    body = todayIsHard
      ? `Cumulative sleep debt suppresses training adaptation. ${todayWorkoutName} will not produce full stimulus until sleep recovers.`
      : 'Cumulative sleep debt reduces adaptation. Prioritise an earlier bedtime tonight.';
  } else if (recentCTFinal && recentCTFinal.tss > 30) {
    const dayLabel = (() => {
      const actTime = new Date(Date.now() - ms48 / 2);
      return actTime.toISOString().split('T')[0] === new Date().toISOString().split('T')[0]
        ? 'earlier today' : 'yesterday';
    })();
    headline = `${recentCTFinal.label} ${dayLabel} added ${recentCTFinal.tss} TSS`;
    body = todayIsHard
      ? `Combined load is elevated. Check whether today's ${todayWorkoutName} should be shifted or softened.`
      : "Total load this week is tracking above baseline. Today's session keeps things manageable.";
  } else if (acwr.status === 'high') {
    headline = 'Load spike detected this week';
    body = todayIsHard
      ? `Acute load is significantly above chronic baseline. Reducing today's ${todayWorkoutName} intensity is the lower-risk option.`
      : 'Acute load is significantly above chronic baseline. Rest or easy movement keeps risk down.';
  } else if (acwr.status === 'caution' && todayIsHard) {
    headline = 'Load is increasing faster than baseline';
    body = `ACWR is in the caution range. ${todayWorkoutName} can proceed — monitor how you feel during the warm-up.`;
  } else {
    return ''; // Nothing notable — no card
  }

  return `
    <div style="margin:12px 16px 0;padding:14px 16px;border-radius:14px;border:1px solid var(--c-border);background:var(--c-surface)">
      <div style="font-size:13px;font-weight:600;color:var(--c-text);margin-bottom:5px">${headline}</div>
      <div style="font-size:13px;line-height:1.55;color:var(--c-muted)">${body}</div>
    </div>
  `;
}

function buildTodayWorkout(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) {
    return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your training plan.', false);
  }

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
  );

  // Apply mods
  if (wk.workoutMods) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) { (w as any).d = mod.newDistance; (w as any).status = mod.status; }
    }
  }

  // Apply day moves (drag-and-drop reorder from plan tab)
  if ((wk as any).workoutMoves) {
    for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
      const w = workouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Find today's workout — run or cross-training
  const active = workouts.filter((w: any) =>
    w.status !== 'skip' && w.status !== 'replaced',
  );
  let todayW = active.find((w: any) => w.dayOfWeek === ourDay);
  if (!todayW) {
    const unrated = active.filter((w: any) => !wk.rated[w.id || w.n]);
    todayW = unrated[0] || null;
  }

  if (!todayW) {
    // Check if it's a rest day
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const isRest = (todayW as any).t === 'rest' || (todayW as any).n?.toLowerCase().includes('rest');
  if (isRest) {
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const isGym = (todayW as any).t === 'gym';
  const rawName = (todayW as any).n || 'Workout';
  // For gym sessions, append "Gym Session" if not already in the name
  const name = isGym && !rawName.toLowerCase().includes('gym') ? `${rawName} Gym Session` : rawName;
  const rawDesc = (todayW as any).d || '';
  const distKm = (todayW as any).km || (todayW as any).distanceKm || null;
  const durationMin = (todayW as any).dur || null;
  const rpe = (todayW as any).rpe || null;
  const workoutId = (todayW as any).id || (todayW as any).n;
  const alreadyRated = wk.rated[workoutId] && wk.rated[workoutId] !== 'skip';

  // For gym sessions: render exercises as an expandable list
  const exercises = isGym && rawDesc ? rawDesc.split('\n').filter(Boolean) : [];
  const desc = isGym ? '' : fmtDesc(rawDesc, s.unitPref ?? 'km'); // convert km/pace for display

  const metaItems = [
    durationMin ? { val: `~${Math.round(durationMin)} min`, lbl: 'Duration' } : null,
    distKm ? { val: formatKm(typeof distKm === 'number' ? distKm : parseFloat(distKm), s.unitPref ?? 'km'), lbl: 'Distance' } : null,
    rpe ? { val: `RPE ${rpe}`, lbl: 'Effort' } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.map((item, i) => `
    <div class="flex flex-col gap-[2px] flex-1 ${i > 0 ? 'border-l pl-[14px]' : ''}" style="${i > 0 ? 'border-color:rgba(0,0,0,0.09)' : ''}">
      <span style="font-size:16px;font-weight:400;letter-spacing:-0.02em">${item!.val}</span>
      <span class="text-[10px] font-semibold uppercase tracking-[0.08em]" style="color:var(--c-faint)">${item!.lbl}</span>
    </div>
  `).join('');

  const startBtn = !alreadyRated
    ? `<button id="home-start-btn" data-workout-id="${workoutId}" data-name="${name.replace(/"/g, '&quot;')}" data-desc="${rawDesc.replace(/"/g, '&quot;')}" class="m-btn-primary">
        <span style="width:12px;height:12px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
        Start
      </button>`
    : `<span class="m-pill m-pill-ok" style="pointer-events:none"><span class="m-pill-dot"></span>Done</span>`;

  return `
    <div class="workout-hero-bg mb-[14px]">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.9" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(78,159,229,0.18)" stroke-width="1"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(78,159,229,0.14)" stroke-width="1"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(78,159,229,0.10)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(78,159,229,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(78,159,229,0.04)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
          ${startBtn}
        </div>
        <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1.05;margin-bottom:5px">${name}</div>
        ${desc ? `<div class="m-text-caption mb-[16px]">${desc}</div>` : ''}
        ${exercises.length > 0 ? `
        <details class="mb-[16px]" style="cursor:pointer">
          <summary style="list-style:none;font-size:12px;font-weight:600;letter-spacing:0.04em;color:var(--c-faint);text-transform:uppercase;display:flex;align-items:center;gap:6px">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="transition:transform 0.15s;flex-shrink:0"><path d="M2 3l3 4 3-4"/></svg>
            Exercises (${exercises.length})
          </summary>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
            ${exercises.map((ex: string) => `<div style="font-size:13px;color:var(--c-muted);line-height:1.4;padding-left:4px">• ${ex}</div>`).join('')}
          </div>
        </details>` : ''}
        <div class="flex gap-0 items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          ${metaHtml}
          <button id="home-view-plan-btn" class="m-btn-link ml-auto pl-[14px]" style="border-left:1px solid rgba(0,0,0,0.09);white-space:nowrap">
            View
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildNoWorkoutHero(title: string, subtitle: string, isRest: boolean, s?: SimulatorState): string {
  const ourDay = jsToOurDay(new Date().getDay());
  // Find next upcoming workout
  let nextLabel = '';
  if (isRest && s) {
    const wk = s.wks?.[s.w - 1];
    if (wk) {
      const workouts = generateWeekWorkouts(wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined, null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus);
      // Apply day moves so "Next workout" reflects any plan-tab reorders
      if ((wk as any).workoutMoves) {
        for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
          const wo = workouts.find((w: any) => (w.id || w.n) === workoutId);
          if (wo) (wo as any).dayOfWeek = newDay;
        }
      }
      const upcoming = workouts.filter((w: any) => w.dayOfWeek > ourDay && w.t !== 'rest');
      if (upcoming.length > 0) {
        const next = upcoming[0] as any;
        nextLabel = `Next: ${DAY_LABELS[next.dayOfWeek]} — ${next.n}${next.km ? ` ${formatKm(next.km, s.unitPref ?? 'km')}` : ''}`;
      }
    }
  }

  return `
    <div class="workout-hero-bg mb-[14px]" style="background:#F7F5F0">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>
        <circle cx="100" cy="100" r="60" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="95" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
        <circle cx="100" cy="100" r="135" stroke="rgba(0,0,0,0.03)" stroke-width="1"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
        </div>
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em;opacity:0.45;margin-bottom:5px">${title}</div>
        <div class="m-text-caption mb-[16px]">${subtitle}</div>
        <div class="flex justify-between items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          <span class="text-[12px]" style="color:var(--c-muted)">${nextLabel}</span>
          <button id="home-view-plan-btn" class="m-btn-link">
            View plan
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildRaceCountdown(s: SimulatorState): string {
  const raceDate = s.selectedMarathon?.date || s.onboarding?.customRaceDate;
  const raceName = s.selectedMarathon?.name || 'Your Race';
  if (!raceDate || s.continuousMode) return '';

  const days = daysUntil(raceDate);
  if (days <= 0) return '';

  const weeks = Math.floor(days / 7);
  const display = days <= 14 ? `${days}` : `${weeks}`;
  const unit = days <= 14 ? 'days' : 'weeks';

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-card px-[18px] py-[14px] flex items-center justify-between">
        <div class="flex flex-col gap-[3px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Race Day</span>
          <span style="font-size:15px;font-weight:400;letter-spacing:-0.02em">${raceName}</span>
        </div>
        <div class="flex items-baseline gap-[5px]">
          <span style="font-size:44px;font-weight:300;letter-spacing:-0.05em;line-height:1">${display}</span>
          <span style="font-size:13px;color:var(--c-muted)">${unit}</span>
        </div>
      </div>
    </div>
  `;
}

function buildRecentActivity(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const prevWk = s.wks?.[s.w - 2];

  // Collect recent completed activities (garminActuals + adhoc from current + prev week)
  type ActivityRow = { name: string; sub: string; value: string; icon: 'run' | 'gym' | 'swim' | 'bike'; id: string; workoutKey?: string; weekNum?: number; unmatched?: boolean; sortKey: string };
  const rows: ActivityRow[] = [];

  function addFromWk(week: typeof wk, weekNum: number) {
    if (!week) return;
    const isCurrentWeek = weekNum === s.w;
    // Garmin synced actuals
    Object.entries(week.garminActuals || {}).forEach(([key, act]: [string, any]) => {
      const isRun = isRunKey(key, act.activityType);
      const dateStr = act.startTime ? fmtDate(act.startTime) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = isRun && act.distanceKm ? formatKm(act.distanceKm, s.unitPref ?? 'km') : act.durationMin ? `${Math.round(act.durationMin)} min` : '';
      // Prefer the actual activity type as the label (e.g. "Run") over the plan slot name.
      // This ensures a run matched to a General Sport slot shows "Run", not "General Sport 1".
      const actName = (act.activityType ? formatActivityType(act.activityType) : null)
        || act.displayName || act.workoutName
        || key.replace(/^[Ww]\d+[-_]?/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: `garmin-${key}-${act.date || ''}`, workoutKey: key, weekNum, sortKey: act.startTime || act.date || '' });
    });
    // Adhoc workouts
    (week.adhocWorkouts || []).forEach((w: any) => {
      const dateStr = w.garminTimestamp ? fmtDate(w.garminTimestamp) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = w.distanceKm ? formatKm(w.distanceKm, s.unitPref ?? 'km') : w.durationMin ? `${Math.round(w.durationMin)} min` : '';
      rows.push({ name: w.workoutName || w.displayName || w.name || w.n || 'Workout', sub: dateStr, value: val, icon: 'run', id: w.id || w.name, sortKey: w.garminTimestamp || w.date || '' });
    });
  }

  addFromWk(wk, s.w);
  addFromWk(prevWk, s.w - 1);

  // Add unmatched pending items (garminPending where garminMatched === '__pending__')
  function addPendingFromWk(week: typeof wk, weekNum: number) {
    if (!week) return;
    const garminMatched = week.garminMatched ?? {};
    (week.garminPending ?? []).forEach(item => {
      if (garminMatched[item.garminId] !== '__pending__') return;
      const dateStr = item.startTime ? fmtDate(item.startTime) : (weekNum === s.w ? 'This week' : 'Last week');
      const durationMin = Math.round(item.durationSec / 60);
      const val = item.distanceM && item.distanceM > 100
        ? formatKm(item.distanceM / 1000, s.unitPref ?? 'km')
        : durationMin ? `${durationMin} min` : '';
      const actName = formatActivityType(item.activityType);
      const isRun = item.appType === 'run';
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: item.garminId, unmatched: true, sortKey: item.startTime || '' });
    });
  }
  addPendingFromWk(wk, s.w);
  addPendingFromWk(prevWk, s.w - 1);

  // Sort all activities by date descending so the most recent always appears first
  rows.sort((a, b) => (b.sortKey > a.sortKey ? 1 : b.sortKey < a.sortKey ? -1 : 0));
  rows.splice(8); // cap at 8 rows

  if (rows.length === 0) return '';

  function iconSvg(type: ActivityRow['icon']): string {
    if (type === 'run') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4a1 1 0 100-2 1 1 0 000 2z" fill="var(--c-accent)" stroke="none"/><path d="M6.5 20l3-5.5 2.5 2 3.5-7 2.5 4.5"/></svg>`;
    if (type === 'gym') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`;
    if (type === 'swim') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1M3 12c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1"/></svg>`;
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`;
  }

  const rowsHtml = rows.map(r => `
    <div class="m-list-item${r.workoutKey ? ' home-act-row' : ''}${r.unmatched ? ' home-unmatched-row' : ''}"
      data-activity-id="${r.id}"
      ${r.workoutKey ? `data-workout-key="${r.workoutKey}" data-week-num="${r.weekNum}"` : ''}
      style="cursor:${r.workoutKey || r.unmatched ? 'pointer' : 'default'}">
      <div style="width:34px;height:34px;border-radius:50%;background:${r.icon === 'run' ? 'rgba(78,159,229,0.08)' : 'rgba(0,0,0,0.05)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${iconSvg(r.icon)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:400;letter-spacing:-0.01em;margin-bottom:1px;display:flex;align-items:center;gap:6px">
          ${r.name}
          ${r.unmatched ? `<span style="font-size:9px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,0.12);color:#b45309">Unmatched</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--c-muted)">${r.sub}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${r.value}</span>
        ${r.workoutKey || r.unmatched ? `<span style="opacity:0.25"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-sec-label">Recent</div>
      <div class="m-card overflow-hidden">${rowsHtml}</div>
    </div>
  `;
}

function buildSyncActions(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const hasPending = (s as any).pendingActivities?.length > 0;
  const allRated = wk
    ? Object.values(wk.rated || {}).filter(v => (typeof v === 'number' && v > 0) || v === 'skip').length >= (s.rw || 5)
    : false;

  const buttons: string[] = [];
  if (hasPending) {
    buttons.push(`<button id="home-sync-btn" class="m-btn-secondary flex-1">↻ Sync Activities</button>`);
  }
  if (allRated && !(wk as any)?.weekCompleted) {
    buttons.push(`<button id="home-complete-week-btn" class="m-btn-secondary flex-1">✓ Complete Week</button>`);
  }
  if (buttons.length === 0) return '';

  return `
    <div class="px-[18px] mb-[14px] flex gap-[10px]">
      ${buttons.join('')}
    </div>
  `;
}

// ─── Main render ────────────────────────────────────────────────────────────

function getHomeHTML(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 10px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:24px;font-weight:600;letter-spacing:-0.03em;color:var(--c-black);line-height:1.1">Mosaic</div>
          ${s.w && s.tw ? `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-top:2px">Week ${s.w} of ${s.tw}${s.wks?.[s.w - 1]?.ph ? ` · ${s.wks[s.w - 1].ph.charAt(0).toUpperCase() + s.wks[s.w - 1].ph.slice(1)}` : ''}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button id="home-coach-btn" style="padding:5px 11px;border-radius:100px;border:1px solid var(--c-border-strong);background:transparent;cursor:pointer;font-size:11px;font-weight:600;color:var(--c-muted);white-space:nowrap;font-family:var(--f)">Coach</button>
          <button id="home-checkin-btn" style="padding:5px 11px;border-radius:100px;border:1px solid var(--c-border-strong);background:transparent;cursor:pointer;font-size:11px;font-weight:600;color:var(--c-muted);white-space:nowrap;font-family:var(--f)">Check-in</button>
          <button id="home-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f)">${initials || 'Me'}</button>
        </div>
      </div>

      ${buildIllnessBanner(s)}
      ${buildProgressBars(s)}
      ${buildDailyHeadline(s)}
      ${buildReadinessRing(s)}
      ${buildTodayWorkout(s)}
      ${buildRaceCountdown(s)}
      ${buildSyncActions(s)}
      ${buildRecentActivity(s)}

    </div>
    ${renderTabBar('home', isSimulatorMode())}
  `;
}

function wireHomeHandlers(): void {
  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Account button
  document.getElementById('home-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Coach button
  document.getElementById('home-coach-btn')?.addEventListener('click', () => openCoachModal());

  // Check-in button
  document.getElementById('home-checkin-btn')?.addEventListener('click', () => openCheckinOverlay());

  // Illness banner — mark recovered
  document.getElementById('home-illness-recover')?.addEventListener('click', () => clearIllness());

  // Start workout button — launches structured GPS tracking for the selected workout
  document.getElementById('home-start-btn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const name = btn.getAttribute('data-name') || 'Workout';
    const desc = btn.getAttribute('data-desc') || '';
    if (window.trackWorkout) {
      window.trackWorkout(name, desc);
    } else {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    }
  });

  // View plan button (from workout hero)
  document.getElementById('home-view-plan-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Sync button → go to plan (which has sync)
  document.getElementById('home-sync-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Complete week button
  document.getElementById('home-complete-week-btn')?.addEventListener('click', () => {
    next();
  });

  // Strain ring — tap opens strain detail page
  document.getElementById('home-strain-ring')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./strain-view').then(({ renderStrainView }) => renderStrainView());
  });

  // Readiness ring — tap opens recovery detail page
  document.getElementById('home-readiness-card')?.addEventListener('click', () => {
    import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView());
  });

  // Pill info sheets — each pill opens a detail sheet; stop propagation so card doesn't toggle
  document.querySelectorAll<HTMLElement>('.home-readiness-pill[data-pill]').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const signal = pill.dataset.pill as PillSignal;
      // Recovery pill navigates to the recovery detail page
      if (signal === 'recovery') {
        import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView());
        return;
      }
      const s2 = getState();
      const tier2 = s2.athleteTierOverride ?? s2.athleteTier;
      const atlSeed2 = (s2.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s2.gs ?? 0), 0.3));
      const acwr2 = computeACWR(s2.wks ?? [], s2.w, tier2, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2);
      const sameSignal2 = computeSameSignalTSB(s2.wks ?? [], s2.w, s2.ctlBaseline ?? undefined, s2.planStartDate);
      const tsb2 = sameSignal2?.tsb ?? 0;
      const ctlNow2 = sameSignal2?.ctl ?? 0;
      const metrics2 = computeFitnessModel(s2.wks ?? [], s2.w, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2);
      const fourBack2 = metrics2[metrics2.length - 5];
      const ctlFourWeeksAgo2 = fourBack2?.ctl ?? ctlNow2;
      const ctlHistory2 = [ctlNow2, ...([4,3,2,1].map(i => metrics2[metrics2.length - 1 - i]?.ctl ?? ctlNow2))];
      const momentumScore2 = (ctlHistory2[0] - ctlHistory2[1]) * 4
                           + (ctlHistory2[1] - ctlHistory2[2]) * 3
                           + (ctlHistory2[2] - ctlHistory2[3]) * 2
                           + (ctlHistory2[3] - ctlHistory2[4]) * 1;
      const momentumThreshold2 = (ctlNow2 || 1) * 0.015;
      const today2 = new Date().toISOString().split('T')[0];
      const manualToday2 = (s2.recoveryHistory ?? []).slice().reverse().find(
        (e: any) => e.date === today2 && e.source === 'manual',
      );
      const latestPhysio2 = s2.physiologyHistory?.slice(-1)[0];
      const garminTodaySleep2 = (s2.physiologyHistory ?? []).find(p => p.date === today2 && p.sleepScore != null);
      const sleepScore2: number | null = garminTodaySleep2?.sleepScore ?? manualToday2?.sleepScore ?? latestPhysio2?.sleepScore ?? null;
      const hrvRmssd2: number | null = latestPhysio2?.hrvRmssd ?? null;
      const hrvAll2 = (s2.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
      const hrvPersonalAvg2: number | null = hrvAll2.length >= 3
        ? Math.round(hrvAll2.reduce((a: number, b: number) => a + b, 0) / hrvAll2.length) : null;
      const effectiveSleepTarget2 = s2.sleepTargetSec ?? deriveSleepTarget(s2.physiologyHistory ?? []);
      const sleepBank2 = getSleepBank(s2.physiologyHistory ?? [], effectiveSleepTarget2);
      const readiness2 = computeReadiness({
        tsb: tsb2, acwr: acwr2.ratio, ctlNow: ctlNow2,
        sleepScore: sleepScore2, sleepHistory: s2.physiologyHistory ?? [],
        hrvRmssd: hrvRmssd2, hrvPersonalAvg: hrvPersonalAvg2,
        sleepBankSec: sleepBank2.nightsWithData >= 3 ? sleepBank2.bankSec : null,
        weeksOfHistory: metrics2.length,
      });
      let rhrCaption2 = '';
      let rhrRawBpm2: number | null = null;
      let rhrTrend2 = '';
      if (latestPhysio2?.restingHR != null) {
        const rhrVals = (s2.physiologyHistory ?? []).map((p: any) => p.restingHR).filter((v: any) => v != null) as number[];
        const rhrAvg2 = rhrVals.length > 1 ? Math.round(rhrVals.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (rhrVals.length - 1)) : null;
        const rhrDiff2 = rhrAvg2 != null ? latestPhysio2.restingHR - rhrAvg2 : 0;
        rhrTrend2 = rhrDiff2 > 2 ? '↑' : rhrDiff2 < -2 ? '↓' : '';
        rhrRawBpm2 = latestPhysio2.restingHR;
        rhrCaption2 = `RHR: ${latestPhysio2.restingHR}bpm${rhrTrend2 ? ' ' + rhrTrend2 : ''} · `;
      }
      const tsbDaily2 = Math.round(tsb2 / 7);
      const tsbZone2 = tsbDaily2 > 1 ? 'Peaked' : tsbDaily2 > -1 ? 'Fresh' : tsbDaily2 > -2 ? 'Recovering' : tsbDaily2 > -4 ? 'Fatigued' : 'Overtrained';
      const safetyLabel2 = acwr2.ratio <= 0 ? '—' : acwr2.status === 'safe' ? 'Safe' : acwr2.status === 'caution' ? 'Elevated' : acwr2.status === 'high' ? 'High Risk' : 'Low';
      const momentumArrow2 = momentumScore2 > momentumThreshold2 ? '↗' : momentumScore2 >= -momentumThreshold2 ? '→' : '↘';
      // Inject manual sleep into physiology history only when Garmin hasn't sent today's data
      const todayStr2 = new Date().toISOString().split('T')[0];
      const manualSleepToday2 = (s2.recoveryHistory ?? []).slice().reverse().find(
        (e: any) => e.date === todayStr2 && e.source === 'manual',
      );
      const noGarminSleep2 = !(s2.physiologyHistory ?? []).find(p => p.date === todayStr2 && p.sleepScore != null);
      const physioForRecovery2 = (() => {
        const h = s2.physiologyHistory ?? [];
        // Only inject manual sleep when Garmin hasn't sent today's data — Garmin takes priority
        if (!manualSleepToday2?.sleepScore || !noGarminSleep2) return h;
        const idx = h.findIndex(p => p.date === todayStr2);
        if (idx >= 0) return h.map((p, i) => i === idx ? { ...p, sleepScore: manualSleepToday2.sleepScore } : p);
        return [...h, { date: todayStr2, sleepScore: manualSleepToday2.sleepScore }];
      })();
      const suppressSleep2 = noGarminSleep2 && !manualSleepToday2?.sleepScore;
      const recoveryResult2 = computeRecoveryScore(physioForRecovery2, { suppressSleepIfNotToday: suppressSleep2, manualSleepScore: noGarminSleep2 ? (manualSleepToday2?.sleepScore ?? undefined) : undefined });
      // Trend context for Option-B display: 7-day avg and 28-day baseline per metric
      const ph2 = physioForRecovery2;
      const ph2h7 = ph2.slice(-7); const ph2h28 = ph2.slice(-28);
      const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      const sleepWeekAvg2 = avg(ph2h7.map(d => d.sleepScore).filter((v): v is number => v != null));
      const sleepBaseline2 = avg(ph2h28.map(d => d.sleepScore).filter((v): v is number => v != null));
      const hrvWeekAvg2 = avg(ph2h7.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0));
      const hrvBaseline2 = avg(ph2h28.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0));
      const rhrWeekAvg2 = avg(ph2h7.map(d => d.restingHR).filter((v): v is number => v != null && v > 0));
      const rhrBaseline2 = avg(ph2h28.map(d => d.restingHR).filter((v): v is number => v != null && v > 0));
      showReadinessPillSheet(signal, {
        tsb: tsb2, tsbZone: tsbZone2, tsbLabel: tsbDaily2 > 0 ? `+${tsbDaily2}` : `${tsbDaily2}`,
        fitnessScore: readiness2.fitnessScore,
        acwrRatio: acwr2.ratio, safetyLabel: safetyLabel2,
        ctlNow: ctlNow2, ctlFourWeeksAgo: ctlFourWeeksAgo2, momentumArrow: momentumArrow2, momentumScore: momentumScore2, momentumThreshold: momentumThreshold2,
        recoveryScore: readiness2.recoveryScore, sleepScore: sleepScore2,
        rhrCaption: rhrCaption2, hasRecovery: readiness2.hasRecovery,
        recoveryHasData: recoveryResult2.hasData,
        recoveryCompositeScore: recoveryResult2.score,
        sleepSubScore: recoveryResult2.sleepScore,
        hrvSubScore: recoveryResult2.hrvScore,
        rhrSubScore: recoveryResult2.rhrScore,
        rhrRawBpm: rhrRawBpm2,
        rhrTrend: rhrTrend2,
        lastNightSleep: recoveryResult2.lastNightSleep,
        lastNightSleepDate: recoveryResult2.lastNightSleepDate,
        lastNightHrv: recoveryResult2.lastNightHrv,
        lastNightHrvDate: recoveryResult2.lastNightHrvDate,
        recoveryDataStale: recoveryResult2.dataStale,
        recoveryLastSyncDate: recoveryResult2.lastSyncDate,
        sleepWeekAvg: sleepWeekAvg2, sleepBaseline: sleepBaseline2,
        hrvWeekAvg: hrvWeekAvg2, hrvBaseline: hrvBaseline2,
        rhrWeekAvg: rhrWeekAvg2, rhrBaseline: rhrBaseline2,
        noGarminSleepToday: noGarminSleep2,
        manualSleepScore: manualSleepToday2?.sleepScore ?? null,
        hasHistoricSleep: (s2.physiologyHistory ?? []).some(p => p.sleepScore != null),
      });
    });
  });

  // Adjust session button — shown when readiness ≤ 59
  document.getElementById('readiness-adjust-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getState();
    const wk2 = s2.wks?.[s2.w - 1];
    const tier2 = s2.athleteTierOverride ?? s2.athleteTier;
    const atlSeed2 = (s2.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s2.gs ?? 0), 0.3));
    const acwr2 = computeACWR(s2.wks ?? [], s2.w, tier2, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2);
    const acwrElevated = acwr2.status === 'caution' || acwr2.status === 'high';
    const hasUnspent = (wk2?.unspentLoadItems?.length ?? 0) > 0;
    if (acwrElevated || hasUnspent) {
      // ACWR is elevated or there's unspent cross-training load → plan adjustment modal
      import('./main-view').then(({ triggerACWRReduction }) => triggerACWRReduction());
    } else {
      // Low readiness driven by sleep/recovery — show rest advice if there's a run to act on,
      // otherwise navigate to plan so the user can see their week
      const opened = showRecoveryAdviceSheet();
      if (!opened) {
        import('./plan-view').then(({ renderPlanView }) => renderPlanView());
      }
    }
  });

  // TSS row → breakdown sheet
  document.getElementById('home-tss-row')?.addEventListener('click', () => {
    const s2 = getState();
    showLoadBreakdownSheet(s2, s2.w);
  });

  // Km row → run breakdown sheet
  document.getElementById('home-km-row')?.addEventListener('click', () => {
    const s2 = getState();
    showRunBreakdownSheet(s2, s2.w);
  });

  // Running Volume row (smartwatch) → run breakdown sheet
  document.getElementById('home-km-vol-row')?.addEventListener('click', () => {
    const s2 = getState();
    showRunBreakdownSheet(s2, s2.w);
  });

  // Recent activity click-through → activity detail page
  document.querySelectorAll<HTMLElement>('.home-act-row').forEach(el => {
    el.addEventListener('click', async () => {
      const workoutKey = el.dataset.workoutKey || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!workoutKey || !weekNum) return;
      const s2 = getState();
      const actual = s2.wks?.[weekNum - 1]?.garminActuals?.[workoutKey];
      if (!actual) return;
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'home');
    });
  });

  // Unmatched activity click → open activity review flow
  document.querySelectorAll<HTMLElement>('.home-unmatched-row').forEach(el => {
    el.addEventListener('click', () => {
      (window as any).openActivityReReview?.();
    });
  });
}

export function renderHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getHomeHTML(s);
  wireHomeHandlers();
  setOnWeekAdvance(() => {
    window.location.reload();
  });
}

// ─── Sleep detail — full-screen dark view ────────────────────────────────────

export function showSleepSheet(physiologyHistory: PhysiologyDayEntry[], wks: any[], onBack?: () => void, targetEntry?: PhysiologyDayEntry): void {
  // ── Data preparation ────────────────────────────────────────────────────────
  const withScores = physiologyHistory.filter(d => d.sleepScore != null).slice(-7);
  const latest = targetEntry ?? withScores[withScores.length - 1] ?? null;

  const today = new Date().toISOString().split('T')[0];
  const latestDate = latest?.date ?? null;
  const daysSinceSync = latestDate
    ? Math.floor((new Date(today).getTime() - new Date(latestDate + 'T12:00:00').getTime()) / 86400000)
    : null;
  const isStale = daysSinceSync != null && daysSinceSync >= 2;

  const bigScore = latest?.sleepScore != null ? Math.round(latest.sleepScore) : null;
  const scoreLabel = bigScore != null ? sleepScoreLabel(bigScore) : null;
  const durationStr = latest?.sleepDurationSec ? fmtSleepDuration(latest.sleepDurationSec) : null;

  const ctx = latest != null ? getSleepContext(physiologyHistory, latest) : null;
  const durationAvgStr = ctx?.durationAvgSec ? fmtSleepDuration(ctx.durationAvgSec) : null;
  const durationTargetLabel = ctx?.durationVsTarget === 'optimal' ? 'In target range (7–9h)'
    : ctx?.durationVsTarget === 'short' ? 'Below target'
    : ctx?.durationVsTarget === 'long'  ? 'Above target (> 9h)'
    : null;
  const scoreVsAvgLabel = ctx?.scoreVsAvg === 'above' ? 'Above weekly avg'
    : ctx?.scoreVsAvg === 'below' ? 'Below weekly avg'
    : null;

  const latestDateFmt = latestDate
    ? new Date(latestDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null;

  // ── Dark theme palette ────────────────────────────────────────────────────
  const DK_BG     = '#0D1117';
  const DK_CARD   = '#161B2E';
  const DK_BORDER = 'rgba(255,255,255,0.08)';
  const DK_TEXT   = '#FFFFFF';
  const DK_MUTED  = 'rgba(255,255,255,0.55)';
  const DK_FAINT  = 'rgba(255,255,255,0.28)';
  const COL_GREEN  = '#34C759';
  const COL_AMBER  = '#FF9500';
  const COL_RED    = '#FF453A';
  const COL_BLUE   = '#0A84FF';
  const COL_PURPLE = '#9B59B6';

  const scoreColorDk = (s: number) => s >= 75 ? COL_GREEN : s >= 55 ? COL_AMBER : COL_RED;
  const qualColorDk = (label: string) =>
    label === 'Excellent' ? COL_GREEN : label === 'Good' ? COL_BLUE : (label === 'Low' || label === 'Elevated') ? COL_AMBER : DK_FAINT;
  const targetColorDk = ctx?.durationVsTarget === 'optimal' ? COL_GREEN
    : ctx?.durationVsTarget === 'short' ? COL_AMBER : DK_FAINT;

  // ── Circular quality ring (SVG arc, 270 degrees, gap at bottom) ──────────
  const R = 65;
  const circumference = 2 * Math.PI * R;
  const arcLen = circumference * 0.75;
  const gapLen = circumference - arcLen;
  const scoreArc = bigScore != null ? (bigScore / 100) * arcLen : 0;
  const ringCol = bigScore != null ? scoreColorDk(bigScore) : DK_FAINT;

  const ringHTML = `
    <div style="position:relative;width:160px;height:160px">
      <svg width="160" height="160" viewBox="0 0 160 160" style="position:absolute;top:0;left:0">
        <circle cx="80" cy="80" r="${R}" fill="none"
          stroke="rgba(255,255,255,0.10)" stroke-width="8"
          stroke-dasharray="${arcLen.toFixed(1)} ${gapLen.toFixed(1)}"
          stroke-dashoffset="${(-gapLen / 2).toFixed(1)}"
          stroke-linecap="round"
          transform="rotate(-90 80 80)"/>
        ${bigScore != null ? `<circle cx="80" cy="80" r="${R}" fill="none"
          stroke="${ringCol}" stroke-width="8"
          stroke-dasharray="${scoreArc.toFixed(1)} 1000"
          stroke-dashoffset="${(-gapLen / 2).toFixed(1)}"
          stroke-linecap="round"
          transform="rotate(-90 80 80)"/>` : ''}
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${bigScore != null
          ? `<div style="font-size:34px;font-weight:300;color:${DK_TEXT};line-height:1">${bigScore}</div>
             <div style="font-size:11px;color:${DK_FAINT};margin-top:3px">quality score</div>`
          : `<div style="font-size:13px;color:${DK_FAINT}">No data</div>`}
      </div>
    </div>`;

  // ── Stage breakdown rows (dark) ──────────────────────────────────────────
  type StageKey = 'deep' | 'rem' | 'light' | 'awake';
  const stageRowDk = (name: string, stageKey: StageKey, barCol: string, sec: number | null | undefined, totalSec: number | null | undefined) => {
    if (!sec || !totalSec) return '';
    const pct = Math.round((sec / totalSec) * 100);
    const dur = fmtSleepDuration(sec);
    const qual = stageQuality(stageKey, pct);
    const qc = qual.label ? qualColorDk(qual.label) : '';
    const fillCol = stageKey === 'awake' && pct > 15 ? COL_AMBER : barCol;
    return `
      <div style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="display:flex;align-items:baseline;gap:8px">
            <span style="font-size:14px;font-weight:500;color:${DK_TEXT}">${name}</span>
            ${qual.label ? `<span style="font-size:11px;color:${qc}">${qual.label}</span>` : ''}
          </div>
          <span style="font-size:12px;color:${DK_MUTED}">${dur} · ${pct}%</span>
        </div>
        <div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.08)">
          <div style="height:4px;border-radius:2px;width:${Math.min(100, pct)}%;background:${fillCol}"></div>
        </div>
      </div>`;
  };

  const lightSec = latest?.sleepLightSec != null
    ? latest.sleepLightSec
    : (latest?.sleepDurationSec && latest?.sleepDeepSec != null && latest?.sleepRemSec != null && latest?.sleepAwakeSec != null)
      ? Math.max(0, latest.sleepDurationSec - (latest.sleepDeepSec ?? 0) - (latest.sleepRemSec ?? 0) - (latest.sleepAwakeSec ?? 0))
      : null;

  const stageRows = [
    stageRowDk('Deep',  'deep',  COL_BLUE,   latest?.sleepDeepSec,  latest?.sleepDurationSec),
    stageRowDk('REM',   'rem',   COL_PURPLE, latest?.sleepRemSec,   latest?.sleepDurationSec),
    stageRowDk('Light', 'light', 'rgba(78,159,229,0.55)', lightSec, latest?.sleepDurationSec),
    stageRowDk('Awake', 'awake', 'rgba(255,255,255,0.25)', latest?.sleepAwakeSec, latest?.sleepDurationSec),
  ].join('');
  const hasStages = stageRows.length > 0;

  // ── HRV + RHR tiles ──────────────────────────────────────────────────────
  const hrvToday = latest?.hrvRmssd ?? null;
  const rhrToday = latest?.restingHR ?? null;
  const recentPhysio = physiologyHistory.slice(-8);
  const hrvHistory = recentPhysio.slice(0, -1).map(p => p.hrvRmssd).filter((v): v is number => v != null);
  const rhrHistory = recentPhysio.slice(0, -1).map(p => p.restingHR).filter((v): v is number => v != null);
  const hrvAvg = hrvHistory.length >= 2 ? hrvHistory.reduce((a, b) => a + b, 0) / hrvHistory.length : null;
  const rhrAvg = rhrHistory.length >= 2 ? rhrHistory.reduce((a, b) => a + b, 0) / rhrHistory.length : null;

  const trendSpan = (current: number | null, avg: number | null, higherIsBetter: boolean, hasHistory: boolean) => {
    if (current == null || avg == null || !hasHistory) return '';
    const isUp   = higherIsBetter ? current > avg * 1.05 : current < avg * 0.95;
    const isDown = higherIsBetter ? current < avg * 0.95 : current > avg * 1.05;
    if (isUp)   return `<span style="font-size:11px;color:${COL_GREEN};margin-left:4px">▲</span>`;
    if (isDown) return `<span style="font-size:11px;color:${COL_RED};margin-left:4px">▼</span>`;
    return `<span style="font-size:11px;color:${DK_FAINT};margin-left:4px">→</span>`;
  };

  const metricTile = (label: string, value: number | null, unit: string, higherIsBetter: boolean, avg: number | null, hasHistory: boolean) =>
    value == null ? '' : `
      <div style="background:${DK_CARD};border-radius:12px;padding:14px 16px;flex:1;min-width:0">
        <div style="font-size:11px;color:${DK_MUTED};margin-bottom:6px">${label}</div>
        <div style="font-size:24px;font-weight:300;color:${DK_TEXT};line-height:1">
          ${Math.round(value)}<span style="font-size:13px;color:${DK_FAINT};margin-left:2px">${unit}</span>${trendSpan(value, avg, higherIsBetter, hasHistory)}
        </div>
        ${avg != null ? `<div style="font-size:10px;color:${DK_FAINT};margin-top:4px">avg ${Math.round(avg)}${unit}</div>` : ''}
      </div>`;

  const hrvTile = metricTile('Resting HRV', hrvToday, 'ms', true, hrvAvg, hrvHistory.length >= 2);
  const rhrTile = metricTile('Resting HR', rhrToday, 'bpm', false, rhrAvg, rhrHistory.length >= 2);
  const hasMetricTiles = !!(hrvToday != null || rhrToday != null);

  // ── Insight card ────────────────────────────────────────────────────────
  const stageInsight = latest != null ? getStageInsight(latest, physiologyHistory) : null;
  const generalInsight = getSleepInsight({ history: physiologyHistory, recentWeeklyTSS: wks.slice(-4).map((w: any) => w.actualTSS ?? 0) });
  const primaryInsight = stageInsight ?? generalInsight;
  const secondaryInsight = stageInsight && generalInsight && stageInsight !== generalInsight ? generalInsight : null;

  // ── Sleep bank ───────────────────────────────────────────────────────────
  const effectiveSleepTarget = getState().sleepTargetSec ?? deriveSleepTarget(physiologyHistory);
  const bank = getSleepBank(physiologyHistory, effectiveSleepTarget);
  const bankStr = bank.nightsWithData >= 3 ? fmtSleepBank(bank.bankSec) : null;
  const bankColorDk = bank.bankSec < -3600 ? COL_AMBER : bank.bankSec > 3600 ? COL_GREEN : DK_MUTED;
  const bankTargetLabel = fmtSleepDuration(effectiveSleepTarget);

  // ── Sleep bank line chart (14 nights) ────────────────────────────────────
  const bankNights = physiologyHistory
    .slice(-14)
    .filter(d => d.sleepDurationSec != null)
    .map(d => ({ date: d.date, delta: d.sleepDurationSec! - effectiveSleepTarget }));

  const bankChartHTML = bankNights.length >= 2
    ? buildSleepBankLineChart(bankNights, bankColorDk, DK_FAINT)
    : '';

  // ── 7-night score trend area chart ───────────────────────────────────────
  let scoreTrendHTML = '';
  if (withScores.length >= 2) {
    const TDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const TW = 320; const TH = 60; const TPV = 6;
    const scores = withScores.map(e => Math.round(e.sleepScore!));
    const minS = Math.max(0, Math.min(...scores) - 8);
    const maxS = Math.min(100, Math.max(...scores) + 8);
    const tRange = maxS - minS || 1;
    const tYOf = (v: number) => TPV + ((maxS - v) / tRange) * (TH - TPV * 2);
    const tXOf = (i: number) => withScores.length > 1 ? (i / (withScores.length - 1)) * TW : TW / 2;
    const tPts = withScores.map((e, i) => ({ x: tXOf(i), y: tYOf(e.sleepScore!) }));
    const tLineD = tPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const tAreaD = `${tLineD} L${tPts[tPts.length - 1].x.toFixed(1)},${TH} L${tPts[0].x.toFixed(1)},${TH} Z`;
    const trendCol = scores[scores.length - 1] >= scores[0] ? COL_GREEN : COL_RED;
    const tXLabels = withScores.map((e, i) => {
      const pct = (tPts[i].x / TW * 100).toFixed(1);
      const day = TDAYS[new Date(e.date + 'T12:00:00').getDay()];
      return `<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:9px;color:${DK_FAINT};bottom:0;text-align:center;line-height:1.3">${day}<br>${scores[i]}</span>`;
    }).join('');
    scoreTrendHTML = `
      <div style="position:relative;margin-top:10px">
        <svg width="100%" height="${TH}" viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="none">
          <path d="${tAreaD}" fill="${trendCol}" opacity="0.15"/>
          <path d="${tLineD}" fill="none" stroke="${trendCol}" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div style="position:relative;height:28px;margin-top:4px">${tXLabels}</div>
      </div>`;
  }

  // ── Build full-screen overlay ─────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50';
  overlay.style.cssText = `background:${DK_BG};overflow-y:auto;-webkit-overflow-scrolling:touch`;

  overlay.innerHTML = `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;padding:16px 20px 12px;border-bottom:1px solid ${DK_BORDER}">
      <button id="sleep-view-back" style="position:absolute;left:20px;color:${DK_MUTED};font-size:22px;line-height:1;background:none;border:none;cursor:pointer;padding:4px">&#8592;</button>
      <div style="text-align:center">
        <div style="font-size:17px;font-weight:600;color:${DK_TEXT}">Sleep</div>
        ${latestDateFmt ? `<div style="font-size:11px;color:${DK_FAINT};margin-top:1px">${latestDateFmt}</div>` : ''}
      </div>
    </div>

    ${isStale ? `
    <div style="margin:12px 16px 0;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,149,0,0.25);background:rgba(255,149,0,0.07)">
      <p style="font-size:12px;color:${COL_AMBER};margin:0;line-height:1.4">Last synced ${latestDateFmt ?? ''}. Open Garmin Connect to update.</p>
    </div>` : ''}

    <div style="display:flex;flex-direction:column;align-items:center;padding:28px 20px 8px">
      ${ringHTML}
      ${scoreLabel ? `<div style="font-size:15px;font-weight:600;color:${ringCol};margin-top:10px">${scoreLabel}</div>` : ''}
      ${scoreVsAvgLabel ? `<div style="font-size:11px;color:${DK_FAINT};margin-top:3px">${scoreVsAvgLabel}</div>` : ''}
    </div>

    <div style="display:flex;gap:8px;padding:0 16px">
      ${durationStr ? `
      <div style="background:${DK_CARD};border-radius:12px;padding:14px 16px;flex:1;min-width:0">
        <div style="font-size:11px;color:${DK_MUTED};margin-bottom:6px">Duration</div>
        <div style="font-size:26px;font-weight:300;color:${DK_TEXT};line-height:1">${durationStr}</div>
        ${durationTargetLabel ? `<div style="font-size:11px;color:${targetColorDk};margin-top:4px">${durationTargetLabel}</div>` : ''}
      </div>` : ''}
      ${durationAvgStr ? `
      <div style="background:${DK_CARD};border-radius:12px;padding:14px 16px;flex:1;min-width:0">
        <div style="font-size:11px;color:${DK_MUTED};margin-bottom:6px">7-night avg</div>
        <div style="font-size:26px;font-weight:300;color:${DK_TEXT};line-height:1">${durationAvgStr}</div>
        <div style="font-size:11px;color:${DK_FAINT};margin-top:4px">per night</div>
      </div>` : ''}
    </div>

    ${hasStages ? `
    <div style="margin:20px 16px 0">
      <div style="font-size:12px;color:${DK_FAINT};margin-bottom:14px">Last night</div>
      ${stageRows}
    </div>` : bigScore != null ? `
    <div style="margin:16px 16px 0;padding:10px 14px;border-radius:10px;border:1px solid ${DK_BORDER}">
      <p style="font-size:12px;color:${DK_FAINT};margin:0">Stage data not available. Garmin usually syncs stage breakdown within a few hours of waking.</p>
    </div>` : `
    <div style="padding:24px 20px;text-align:center">
      <div style="font-size:13px;color:${DK_FAINT}">No sleep data yet. Garmin syncs within a few hours of waking.</div>
    </div>`}

    ${hasMetricTiles ? `
    <div style="display:flex;gap:8px;padding:12px 16px 0">
      ${hrvTile}${rhrTile}
    </div>` : ''}

    ${primaryInsight ? `
    <div style="margin:16px 16px 0;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10)">
      <div style="font-size:13px;font-weight:600;color:${DK_TEXT};margin-bottom:5px">Analysis</div>
      <div style="font-size:13px;line-height:1.55;color:${DK_MUTED}">${primaryInsight}</div>
      ${secondaryInsight ? `<div style="font-size:12px;line-height:1.5;color:${DK_FAINT};margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">${secondaryInsight}</div>` : ''}
    </div>` : ''}

    ${withScores.length >= 2 ? `
    <div style="margin:16px 16px 0;padding:14px 16px;background:${DK_CARD};border-radius:14px">
      <div style="font-size:12px;color:${DK_FAINT}">Last ${withScores.length} nights</div>
      ${scoreTrendHTML}
    </div>` : ''}

    ${bankStr ? `
    <div style="margin:12px 16px 24px;padding:14px 16px;background:${DK_CARD};border-radius:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div style="font-size:12px;color:${DK_FAINT}">Sleep bank · last ${bank.nightsWithData} night${bank.nightsWithData === 1 ? '' : 's'}</div>
        <div style="font-size:11px;color:${DK_FAINT}">vs ${bankTargetLabel}/night</div>
      </div>
      <div style="font-size:28px;font-weight:300;color:${bankColorDk};margin-top:6px">${bankStr}</div>
      ${bankChartHTML}
    </div>` : ''}
  `;

  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); onBack?.(); };
  overlay.querySelector('#sleep-view-back')?.addEventListener('click', close);
}

// ─── Manual sleep picker — centred overlay, 0–100 slider ─────────────────────
function showManualSleepPicker(): void {
  const today = new Date().toISOString().split('T')[0];
  const existing = getState().recoveryHistory?.slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const initialValue = existing?.sleepScore ?? 75;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  // Inject scoped slider styles so the thumb matches the app accent colour
  overlay.innerHTML = `
    <style>
      #sleep-score-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px;
        border-radius:2px; background:var(--c-border); outline:none; cursor:pointer; }
      #sleep-score-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
        width:22px; height:22px; border-radius:50%; background:var(--c-accent);
        box-shadow:0 1px 4px rgba(0,0,0,0.25); }
      #sleep-score-slider::-moz-range-thumb { width:22px; height:22px; border:none;
        border-radius:50%; background:var(--c-accent); box-shadow:0 1px 4px rgba(0,0,0,0.25); }
    </style>
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:20px;text-transform:uppercase;letter-spacing:0.06em">Last night's sleep</div>
      <div style="text-align:center;margin-bottom:20px">
        <span id="sleep-score-display" style="font-size:56px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums;line-height:1">${initialValue}</span><span style="font-size:20px;font-weight:300;color:var(--c-faint)">/100</span>
      </div>
      <div style="padding:4px 0 24px">
        <input id="sleep-score-slider" type="range" min="1" max="100" value="${initialValue}">
      </div>
      <button id="sleep-picker-save" style="width:100%;padding:13px;border-radius:12px;border:none;background:var(--c-black);color:var(--c-surface);font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">Save</button>
      <button id="sleep-picker-cancel" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--c-border);background:transparent;color:var(--c-muted);font-size:14px;cursor:pointer;font-family:var(--f)">Cancel</button>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#sleep-picker-cancel')?.addEventListener('click', () => overlay.remove());

  const slider = overlay.querySelector('#sleep-score-slider') as HTMLInputElement;
  const display = overlay.querySelector('#sleep-score-display') as HTMLElement;
  slider.addEventListener('input', () => { display.textContent = slider.value; });

  overlay.querySelector('#sleep-picker-save')?.addEventListener('click', async () => {
    const score = Number(slider.value);
    const { getMutableState, saveState } = await import('@/state');
    const mutable = getMutableState() as any;
    if (!mutable.recoveryHistory) mutable.recoveryHistory = [];
    const idx = mutable.recoveryHistory.findIndex((e: any) => e.date === today && e.source === 'manual');
    const entry = { date: today, sleepScore: score, source: 'manual' as const };
    if (idx >= 0) mutable.recoveryHistory[idx] = entry;
    else mutable.recoveryHistory.push(entry);
    if (mutable.recoveryHistory.length > 90) mutable.recoveryHistory = mutable.recoveryHistory.slice(-90);
    saveState();
    overlay.remove();
    // Close any open recovery pill sheet (it's stale) and re-render home view.
    // The user can re-tap the Recovery pill to see the updated score with Edit button.
    document.querySelector('[data-pill-sheet="recovery"]')?.remove();
    renderHomeView();
  });
}

function showRecoveryAdviceSheet(): boolean {
  const s = getState();
  const wk = s.wks?.[s.w - 1];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ── Detect today's unrated intensity workout ──────────────────────────────
  const jsDow = new Date().getDay(); // JS: 0=Sun
  const internalDow = jsDow === 0 ? 6 : jsDow - 1; // internal: 0=Mon, 6=Sun

  // Types that warrant "convert to easy" rather than "run by feel"
  const intensityTypes = new Set(['threshold', 'vo2', 'intervals', 'marathon_pace', 'vo2max']);

  let todayWorkout: any = null;
  let todayAnyWorkout: any = null;
  let isIntensitySession = false;
  let bestMoveDay: { day: number; label: string } | null = null;
  let backToBack = false;

  if (wk) {
    const workouts = generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig, null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, undefined, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
    ) as any[];

    // Apply existing day moves so we see the current layout
    if (wk.workoutMoves) {
      for (const [wid, newDay] of Object.entries(wk.workoutMoves)) {
        const w = workouts.find((wo: any) => (wo.id || wo.n) === wid);
        if (w) w.dayOfWeek = newDay;
      }
    }

    const rated = wk.rated ?? {};

    // Today's unrated quality workout
    todayWorkout = workouts.find((w: any) =>
      w.dayOfWeek === internalDow && !rated[w.id || w.n] && isHardWorkout(w.t)
    ) ?? null;

    // Any unrated running workout today (for reduce-intensity when no hard session)
    todayAnyWorkout = todayWorkout ?? workouts.find((w: any) =>
      w.dayOfWeek === internalDow && !rated[w.id || w.n] &&
      w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'gym'
    ) ?? null;

    if (todayWorkout) {
      isIntensitySession = intensityTypes.has(todayWorkout.t);

      // Back-to-back: was yesterday a rated hard workout?
      const yesterdayDow = internalDow === 0 ? null : internalDow - 1; // don't wrap into prev week
      if (yesterdayDow !== null) {
        const yesterdayWos = workouts.filter((w: any) => w.dayOfWeek === yesterdayDow && rated[w.id || w.n]);
        backToBack = yesterdayWos.some((w: any) => isHardWorkout(w.t));
      }

      // Best move target: first later day with no hard session and not already completed
      for (let d = internalDow + 1; d <= 6; d++) {
        const dayWos = workouts.filter((w: any) => w.dayOfWeek === d);
        const hasHard = dayWos.some((w: any) => isHardWorkout(w.t));
        const allDone = dayWos.length > 0 && dayWos.every((w: any) => rated[w.id || w.n]);
        if (!hasHard && !allDone) {
          bestMoveDay = { day: d, label: DAY_NAMES[d] };
          break;
        }
      }
    }
  }

  // Nothing actionable today (rest day, cross-training only) — skip the modal
  if (!todayAnyWorkout) return false;

  // ── Build HTML ─────────────────────────────────────────────────────────────
  const escName = todayWorkout ? todayWorkout.n.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '';
  const kmMatch = todayWorkout?.d?.match(/(\d+\.?\d*)km/);
  const distStr = kmMatch ? `${kmMatch[1]}km` : '';

  const todaySection = todayWorkout ? `
    <div style="background:rgba(0,0,0,0.04);border-radius:12px;overflow:hidden">
      <div style="padding:10px 16px 8px;border-bottom:1px solid var(--c-border)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">
          Today — ${escName}${backToBack ? ' · back-to-back' : ''}
        </div>
        ${backToBack ? `<p style="font-size:12px;color:var(--c-muted);line-height:1.5;margin:0 0 10px">Yesterday was a hard session. Two consecutive quality days significantly raise injury risk and reduce adaptation quality.</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:8px;padding-bottom:4px">
          <button id="rec-advice-convert" style="padding:12px 14px;border-radius:10px;border:1.5px solid var(--c-border);background:var(--c-bg);font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer;text-align:left;font-family:var(--f)">
            ${isIntensitySession ? 'Convert to easy run' : 'Run by feel — drop pace targets'}
            <div style="font-size:12px;font-weight:400;color:var(--c-muted);margin-top:3px">${distStr ? `${distStr}, Zone 2 only.` : 'Same distance, Zone 2 only.'} No intensity targets.</div>
          </button>
          ${bestMoveDay ? `
          <button id="rec-advice-move" style="padding:12px 14px;border-radius:10px;border:1.5px solid var(--c-border);background:var(--c-bg);font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer;text-align:left;font-family:var(--f)">
            Move to ${bestMoveDay.label}
            <div style="font-size:12px;font-weight:400;color:var(--c-muted);margin-top:3px">Run ${escName} at full intensity on ${bestMoveDay.label} instead.</div>
          </button>` : ''}
        </div>
      </div>
    </div>` : '';

  const btnStyle = 'width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left;font-family:var(--f)';
  const btnTitle = 'font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px';
  const btnBody = 'font-size:12px;color:var(--c-muted);line-height:1.6;margin:0';

  // "Reduce intensity" only makes sense if there's a running workout today
  const reduceBtn = todayAnyWorkout
    ? `<button id="rec-advice-reduce" style="${btnStyle}">
        <div style="${btnTitle}">Reduce intensity</div>
        <p style="${btnBody}">Convert today's session to an easy effort — same distance, Zone 2 only. Aerobic stimulus without the additional stress on an under-recovered system.</p>
      </button>`
    : '';

  // "Reorder the week" only makes sense when there's a hard session to move
  const reorderBtn = todayWorkout
    ? `<button id="rec-advice-reorder" style="${btnStyle}">
        <div style="${btnTitle}">Reorder the week</div>
        <p style="${btnBody}">Move today's quality session to a later day. Swap it with an easy run or rest day. Total load stays the same, the sequencing improves.</p>
      </button>`
    : '';

  const genericRows = `<button id="rec-advice-rest" style="${btnStyle}">
      <div style="${btnTitle}">Rest today</div>
      <p style="${btnBody}">Skip the session and carry it to later in the week. A single missed day has no meaningful impact on fitness. Sustained fatigue does.</p>
    </button>
    ${reorderBtn}
    ${reduceBtn}`;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div>
          <div style="font-size:16px;font-weight:600">Low readiness — options</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:1px">Sleep or HRV indicates incomplete recovery</div>
        </div>
        <button id="rec-advice-close" class="text-xl leading-none" style="color:var(--c-muted)">✕</button>
      </div>
      <div class="px-4 py-4 space-y-3 text-sm">
        ${todaySection}
        ${genericRows}
        <p style="font-size:11px;color:var(--c-faint);line-height:1.5;padding:0 4px">Hard sessions only drive adaptation when recovery is adequate. Training on poor sleep raises injury risk and blunts the stimulus.</p>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#rec-advice-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Convert button — downgrade today's session to easy
  overlay.querySelector('#rec-advice-convert')?.addEventListener('click', () => {
    close();
    applyRecoveryAdjustment('downgrade', internalDow, todayWorkout?.n);
  });

  // Move button — shift today's session to the best available day
  overlay.querySelector('#rec-advice-move')?.addEventListener('click', () => {
    if (!todayWorkout || !bestMoveDay) return;
    const ms = getMutableState();
    const mwk = ms.wks?.[ms.w - 1];
    if (!mwk) return;
    if (!mwk.workoutMoves) mwk.workoutMoves = {};
    const wid = todayWorkout.id || todayWorkout.n;
    mwk.workoutMoves[wid] = bestMoveDay.day;
    saveState();
    close();
    renderHomeView();
  });

  // Rest today — close modal; user decides not to train
  overlay.querySelector('#rec-advice-rest')?.addEventListener('click', () => {
    close();
  });

  // Reorder the week — navigate to plan view so user can rearrange
  overlay.querySelector('#rec-advice-reorder')?.addEventListener('click', () => {
    close();
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Reduce intensity — downgrade today's workout to easy effort
  overlay.querySelector('#rec-advice-reduce')?.addEventListener('click', () => {
    close();
    applyRecoveryAdjustment(
      todayAnyWorkout && !isHardWorkout(todayAnyWorkout.t) ? 'easyflag' : 'downgrade',
      internalDow,
      todayAnyWorkout?.n,
    );
  });

  return true;
}

// ─── HRV detail sheet ─────────────────────────────────────────────────────────
function showHrvSheet(physiologyHistory: PhysiologyDayEntry[], onBack?: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const withData = physiologyHistory.filter(d => d.hrvRmssd != null).slice(-7);
  const latest = withData[withData.length - 1] ?? null;
  const latestVal = latest?.hrvRmssd != null ? Math.round(latest.hrvRmssd) : null;

  // Use prior 6 days (exclude today) as baseline avg for relative comparison
  const priorVals = withData.slice(0, -1).map(d => d.hrvRmssd!);
  const baselineAvg = priorVals.length >= 2
    ? priorVals.reduce((a, b) => a + b, 0) / priorVals.length
    : null;

  const allVals = withData.map(d => d.hrvRmssd!);
  const displayAvg = allVals.length ? Math.round(allVals.reduce((a, b) => a + b, 0) / allVals.length) : null;
  const best = allVals.length ? Math.round(Math.max(...allVals)) : null;

  // Drop ratio vs personal baseline
  const dropRatio = (latestVal != null && baselineAvg != null)
    ? (baselineAvg - latestVal) / baselineAvg
    : null;

  // Colour relative to personal baseline; fall back to absolute if no baseline yet
  const hrvColor = (v: number): string => {
    if (baselineAvg != null) {
      const ratio = (baselineAvg - v) / baselineAvg;
      if (ratio >= 0.20) return 'var(--c-warn)';
      if (ratio >= 0.10) return 'var(--c-caution)';
      return 'var(--c-ok)';
    }
    // Absolute fallback (no prior data)
    return v >= 60 ? 'var(--c-ok)' : v >= 40 ? 'var(--c-caution)' : 'var(--c-warn)';
  };
  const headlineColor = latestVal != null ? hrvColor(latestVal) : 'var(--c-faint)';

  // Flag banner when today is ≥20% below baseline
  const flagBanner = (dropRatio != null && dropRatio >= 0.20 && latestVal != null && baselineAvg != null)
    ? `<div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:rgba(255,69,58,0.08);border:1px solid rgba(255,69,58,0.22)">
        <div style="font-size:12px;font-weight:600;color:var(--c-warn);margin-bottom:2px">HRV below baseline</div>
        <div style="font-size:11px;color:var(--c-warn);line-height:1.5">${Math.round(dropRatio * 100)}% below your recent avg (${Math.round(baselineAvg)} ms). Consider a lighter session today.</div>
      </div>`
    : (dropRatio != null && dropRatio >= 0.10 && latestVal != null && baselineAvg != null)
    ? `<div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.22)">
        <div style="font-size:12px;font-weight:600;color:var(--c-caution);margin-bottom:2px">Slightly suppressed HRV</div>
        <div style="font-size:11px;color:var(--c-caution);line-height:1.5">${Math.round(dropRatio * 100)}% below your recent avg (${Math.round(baselineAvg)} ms). Listen to your body.</div>
      </div>`
    : '';

  const barEntries = withData.map((e, i) => ({
    value: e.hrvRmssd != null ? Math.round(e.hrvRmssd) : null,
    day: DAYS[new Date(e.date + 'T12:00:00').getDay()],
    isLatest: i === withData.length - 1,
  }));
  const barChart = withData.length >= 2 ? buildBarChart(barEntries, hrvColor, v => `${v}`) : '';

  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div class="flex items-center gap-3">
          <button id="hrv-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">&#8592;</button>
          <div>
            <h2 class="font-semibold" style="color:var(--c-black)">HRV</h2>
            <p style="font-size:12px;color:var(--c-muted);margin-top:1px">Heart rate variability · From Garmin Connect</p>
          </div>
        </div>
      </div>
      <div class="px-4 py-4">
        ${latestVal != null ? `
          ${flagBanner}
          <div style="display:flex;gap:16px;margin-bottom:14px">
            <div style="flex:1">
              <div style="font-size:38px;font-weight:300;line-height:1;color:${headlineColor}">${latestVal}<span style="font-size:16px;color:var(--c-faint);margin-left:4px">ms</span></div>
              <div style="font-size:11px;color:var(--c-muted);margin-top:5px">Last night</div>
            </div>
            ${displayAvg != null ? `
            <div style="flex:1;text-align:right">
              <div style="font-size:13px;color:var(--c-muted)">Avg: ${displayAvg} ms · Best: ${best} ms</div>
            </div>` : ''}
          </div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:12px;line-height:1.5">Colour reflects your personal baseline — a drop of 20%+ signals to go easy today.</div>
        ` : `
          <div style="padding:12px 0;color:var(--c-faint);font-size:13px">HRV data not yet available — Garmin usually syncs within a few hours of waking.</div>
        `}
        ${barChart ? `
          <div style="margin-top:4px">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--c-faint);margin-bottom:10px">Last ${withData.length} nights (ms)</div>
            ${barChart}
          </div>` : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const closeHrv = () => { overlay.remove(); onBack?.(); };
  overlay.querySelector('#hrv-sheet-close')?.addEventListener('click', closeHrv);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHrv(); });
}

// ─── Resting HR detail sheet ──────────────────────────────────────────────────
function showRhrSheet(physiologyHistory: PhysiologyDayEntry[], onBack?: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const withData = physiologyHistory.filter(d => d.restingHR != null).slice(-7);
  const latest = withData[withData.length - 1] ?? null;
  const latestVal = latest?.restingHR ?? null;

  const vals = withData.map(d => d.restingHR!);
  const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  const best = vals.length ? Math.round(Math.min(...vals)) : null;

  const rhrColor = (v: number) => v <= 50 ? 'var(--c-ok)' : v <= 60 ? 'rgba(52,199,89,0.75)' : v <= 70 ? 'var(--c-caution)' : 'var(--c-warn)';
  const headlineColor = latestVal != null ? rhrColor(latestVal) : 'var(--c-faint)';

  const barEntries = withData.map((e, i) => ({
    value: e.restingHR ?? null,
    day: DAYS[new Date(e.date + 'T12:00:00').getDay()],
    isLatest: i === withData.length - 1,
  }));
  const barChart = withData.length >= 2 ? buildBarChart(barEntries, rhrColor, v => `${v}`) : '';

  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div class="flex items-center gap-3">
          <button id="rhr-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">&#8592;</button>
          <div>
            <h2 class="font-semibold" style="color:var(--c-black)">Resting Heart Rate</h2>
            <p style="font-size:12px;color:var(--c-muted);margin-top:1px">From Garmin Connect</p>
          </div>
        </div>
      </div>
      <div class="px-4 py-4">
        ${latestVal != null ? `
          <div style="display:flex;gap:16px;margin-bottom:16px">
            <div style="flex:1">
              <div style="font-size:38px;font-weight:300;line-height:1;color:${headlineColor}">${latestVal}<span style="font-size:16px;color:var(--c-faint);margin-left:4px">bpm</span></div>
              <div style="font-size:11px;color:var(--c-muted);margin-top:5px">Today</div>
            </div>
            ${avg != null ? `
            <div style="flex:1;text-align:right">
              <div style="font-size:13px;color:var(--c-muted)">Avg: ${avg} bpm · Best: ${best} bpm</div>
            </div>` : ''}
          </div>
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:12px;line-height:1.5">Lower resting HR indicates better cardiovascular fitness. An elevated RHR (5+ bpm above your baseline) can signal fatigue, illness, or under-recovery.</div>
        ` : `
          <div style="padding:12px 0;color:var(--c-faint);font-size:13px">Resting HR data not yet available — Garmin usually syncs within a few hours of waking.</div>
        `}
        ${barChart ? `
          <div style="margin-top:4px">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--c-faint);margin-bottom:10px">Last ${withData.length} days (bpm)</div>
            ${barChart}
          </div>` : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const closeRhr = () => { overlay.remove(); onBack?.(); };
  overlay.querySelector('#rhr-sheet-close')?.addEventListener('click', closeRhr);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRhr(); });
}
