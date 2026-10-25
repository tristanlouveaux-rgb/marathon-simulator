/**
 * Home tab. The app landing screen.
 * Shows this-week progress, injury risk, today's workout, race countdown, recent activity.
 */

import { getState, getMutableState, saveState } from '@/state';
import { resolveTriWeekWorkouts } from './triathlon/week-resolve.triathlon';
import { getTriDistanceLabel } from '@/constants/triathlon-constants';
import { AI_COACH_ENABLED, STRAVA_ENRICH_UPLOAD_ENABLED } from '@/constants/feature-flags';
import type { SimulatorState } from '@/types';
import type { Week } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, navigateToForecastTab, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/app/runtime';
import { getPhysiologySource } from '@/data/sources';
import { computeWeekTSS, computeWeekRawTSS, computeACWR, computeReadinessACWR, computeFitnessModel, computeLiveSameSignalTSB, getWeeklyExcess, getTrailingEffortScore, computeDayStrainTSS, computePlannedDaySignalBTSS, estimateWorkoutDurMin, computeDayTargetTSS, isRestDayOverreached, normalizeiTrimp, signalBActualTSS, signalBAdhocTSS, ratedRpeOf } from '@/calculations/fitness-model';
import { computeWeekDoubleDayBonus } from '@/calculations/double-day';
import { computePlannedWeekTarget, computeCurrentWeekCarry } from '@/calculations/planned-week-target';
import { computeAcwrReductionProjection } from '@/calculations/acwr-reduction-projection';
import { workoutsToPlannedRuns } from '@/cross-training/suggester';
import { computeReadiness, readinessColor, readinessColorStops, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { computeTriReadiness } from '@/calculations/tri-readiness';
import { hyroxMtlAcwr } from '@/calculations/mtl';
import { computeDecayedTriCarry } from '@/calculations/tri-cross-training-carry';
import { computeDailyCoach, deriveStrainContext } from '@/calculations/daily-coach';
import { computeCapacityStrain, capacityStrainNote, REST_DAY_OVERREACH_SENTENCE } from '@/calculations/capacity-strain';
import { getSleepInsight, fmtSleepDuration, sleepScoreColor, buildBarChart, getSleepBank, fmtSleepBank, deriveSleepTarget, buildDailySignalBTSS, computeSleepDebtOutlook, mergeManualSleepHistory } from '@/calculations/sleep-insights';
import type { PhysiologyDayEntry } from '@/types/state';
import { generateWeekWorkouts, parseWorkoutDescription } from '@/workouts';
import { displayDescWithPace } from '@/workouts/workout-scaling';
import { isHyroxEasyErg } from '@/workouts/hyrox-generators';
import { resolveWeekWorkouts } from './week-resolve';
import { isStoodDownByLayer } from '@/workouts/render-layer';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { isHardWorkout } from '@/workouts/scheduler';
import { strengthCardSummary } from '@/guided/strength-model';
import { isInjuryActive, buildInjuryCaption } from './injury/modal';
import { isImpactBlockedByInjury } from '@/injury/engine';
import { isThinActivity } from '@/data/activity-enrich-merge';
import { openCheckinOverlay } from './checkin-overlay';
import { maybeShowCheckinHint } from './checkin-hint';
import { clearIllness } from './illness-modal';
import { buildHolidayBannerHome, clearHoliday, cancelScheduledHoliday } from './holiday-modal';
import { formatKm, fmtDateUK, fmtDesc, formatPace, ft } from '@/utils/format';
import { localDateKey, isOnLocalDay } from '@/utils/local-date';
import { setOnWeekAdvance, applyRecoveryAdjustment } from './events';
import { normalizeSport } from '@/cross-training/activities';
import { formatActivityType } from '@/calculations/activity-matcher';
import { resolveActivityDisplayName } from './sport-picker-modal';
import { isSleepDataPending } from '@/data/sleepPoller';
import { computePlanAdherence } from '@/calculations/plan-adherence';
import { collectTriSuggestions, type TriSuggestionBundle } from '@/calculations/tri-suggestion-aggregator';
import { getCyclingEventLabel } from '@/calculations/cycling-mode';
import { getTriathlonById } from '@/data/triathlons';
import { buildScrollAtmosphereBackground, floweyHaloAnimationCSS, buildSunGlint, shouldPlayEntrance } from './page-flair';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';
import { raceDayToday } from './race-day-card';

// ─── Navigation ────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'plan') {
    import('./main-view').then(({ renderMainView }) => renderMainView());
  } else if (tab === 'forecast') {
    navigateToForecastTab();
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

export interface LoadSegment {
  label: string;
  tss: number;
  durationMin: number;
  color: string;
  /** The week's double-day compounding bonus (computeWeekDoubleDayBonus), not
   *  a sport: no duration, not counted as a sport. */
  doubleDay?: true;
}

/** Label of the double-day bonus row in a load breakdown. */
export const DOUBLE_DAY_SEGMENT_LABEL = 'Double-day load';

export function sportColor(sport: string): string {
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

const BREAKDOWN_SHADES = [
  '#1e3a8a',
  '#1d4ed8',
  '#2563eb',
  '#3b82f6',
  '#60a5fa',
  '#93c5fd',
  '#bfdbfe',
];

export function breakdownShade(index: number): string {
  const i = Math.max(0, Math.min(index, BREAKDOWN_SHADES.length - 1));
  return BREAKDOWN_SHADES[i];
}

function parseDurMinLocal(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1]) : 30;
}

/**
 * Per-sport breakdown of a week's Signal B TSS: the same activities, dedup and
 * per-activity rule as computeWeekRawTSS (signalBActualTSS with the rating,
 * so a rated strength session counts its strength override; signalBAdhocTSS
 * for an adhoc entry with no activity record), grouped by label. The week's
 * double-day compounding bonus, which the total also counts, is its own
 * segment (`doubleDay`, last), so the segments sum to computeWeekRawTSS. Until
 * 2026-10-22 (E4) the breakdown had no strength override and no bonus: a rated
 * strength session with heart rate showed its roughly 20 TSS iTRIMP against
 * 107 in the total.
 *
 * @param planStartDate - dates the double-day bonus, as computeWeekRawTSS does.
 */
export function computeLoadBreakdown(
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

  // Normalize running-type display names to a single "Running" label
  const RUN_LABELS = new Set(['run', 'trail run', 'treadmill run', 'virtual run', 'track run']);
  function normalizeRunLabel(label: string): string {
    return RUN_LABELS.has(label.toLowerCase()) ? 'Running' : label;
  }

  // Matched activities (garminActuals). Primarily runs
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
    const tss = signalBActualTSS(actual, ratedRpeOf(ratedMap[workoutId])); // computeWeekRawTSS's rule
    // Label: use displayName for cross-training slots, else "Running"
    const rawLabel = (actual.displayName && !actual.workoutName) ? actual.displayName : 'Running';
    const label = normalizeRunLabel(rawLabel);
    const color = label === 'Running' ? '#3b82f6' : sportColor(label.toLowerCase());
    console.log(`[LoadBreakdown] garminActual wid="${workoutId}" gid=${actual.garminId} label="${label}" tss=${tss.toFixed(0)} dur=${durationMin.toFixed(0)}m wn=${actual.workoutName ?? '-'} dn=${actual.displayName ?? '-'} iTrimp=${actual.iTrimp ?? '-'}`);
    add(label, tss, durationMin, color);
  }

  // Adhoc workouts. All types, no runSpec discount for Signal B
  // Skip planned sessions (adhoc-/holiday-/benchmark-): not real activity, just prescriptions
  for (const w of wk.adhocWorkouts ?? []) {
    if (isPlannedAdhocId(w.id)) continue;
    // Skip if garminActuals already covers this entry (garminActuals wins. May have been Strava-upgraded)
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    // Dedup by the 'garmin-<id>' prefix, computeWeekRawTSS's rule.
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) {
        console.log(`[LoadBreakdown] DEDUP adhoc id="${w.id}" n="${w.n}" garminId=${rawId}`);
        continue;
      }
      seenGarminIds.add(rawId);
    }
    const durationMin = parseDurMinLocal(w.d);
    const tss = signalBAdhocTSS(w); // computeWeekRawTSS's adhoc rule
    const sport = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
    const rawLabel = w.n.replace(' (Garmin)', '').replace(' (Strava)', '');
    const label = normalizeRunLabel(rawLabel);
    console.log(`[LoadBreakdown] adhoc id="${w.id}" n="${w.n}" label="${label}" tss=${tss.toFixed(0)} dur=${durationMin.toFixed(0)}m garminId=${rawId ?? 'none'}`);
    add(label, tss, durationMin, sportColor(sport));
  }

  // unspentLoadItems are decision records, never load (computeWeekRawTSS). A
  // surplus_run item is a slice of a run already counted in full above, and an
  // overflow item's activity is already counted as its twin or adhoc entry.
  // Adding them put the surplus on top of the matched run (audit B20).

  const out = Array.from(segments.values())
    .filter(s => s.tss > 0.5)
    .sort((a, b) => b.tss - a.tss);
  const bonus = computeWeekDoubleDayBonus(wk, planStartDate);
  if (bonus > 0.5) {
    out.push({ label: DOUBLE_DAY_SEGMENT_LABEL, tss: bonus, durationMin: 0, color: '#94A3B8', doubleDay: true });
  }
  return out;
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

  // The double-day bonus row stays last (computeLoadBreakdown's order).
  const segments = Array.from(totalSegments.values())
    .filter(seg => seg.tss > 0.5)
    .sort((a, b) => Number(!!a.doubleDay) - Number(!!b.doubleDay) || b.tss - a.tss)
    .map((seg, i) => ({ ...seg, color: breakdownShade(i) }));
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
            ${seg.doubleDay ? '' : `<span style="font-size:12px;color:var(--c-faint)">${fmtDur(seg.durationMin)}</span>`}
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
        getTrailingEffortScore(s.wks, wkIndex + 1), wk.scheduledAcwrStatus, undefined,
        s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
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

/**
 * Guest-account banner. Fires once for users still on the auto-created
 * anonymous Supabase session who have already accumulated training data.
 * Anonymous sessions live in localStorage only. Uninstalling, switching
 * phone, or clearing app data wipes everything. The banner is the
 * one-time wake-up; the Account view keeps a persistent affordance.
 *
 * Guards:
 *   - s.isGuestAccount === true (refreshed at launch from session.user.is_anonymous)
 *   - Has real data: any completed workout in the live plan
 *   - User hasn't dismissed (s.guestBannerDismissed = true after × tap)
 */
function buildGuestAccountBanner(s: SimulatorState): string {
  if (!s.isGuestAccount) return '';
  if (s.guestBannerDismissed) return '';

  // Only fire if the user has real data worth losing. A single completed workout
  // is enough signal that they've engaged with the app.
  const hasData = (s.wks ?? []).some(w =>
    Object.values(w.garminActuals ?? {}).some(a => a && (a.distanceKm ?? 0) > 0)
  );
  if (!hasData) return '';

  return `
    <div id="home-guest-banner" style="padding:12px 16px;margin:4px 16px 10px;background:#fff;border-radius:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)" class="hf" data-delay="0.05">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:2px">Sign in to back up your training history</div>
          <div style="font-size:12px;color:#475569;line-height:1.45">Guest data only lives on this device. Sign in to keep it safe if you change phones or reinstall the app.</div>
        </div>
        <button id="home-guest-dismiss" aria-label="Dismiss" style="flex-shrink:0;width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:#94A3B8;cursor:pointer;font-size:16px;line-height:1">×</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="home-guest-signin" class="m-btn-glass" style="flex:1">Sign in</button>
      </div>
    </div>`;
}

/**
 * Strava enrich-prompt banner. Garmin watches that sync through Apple Health
 * deliver average HR + duration only: HR zones, per-km splits and the route
 * drop at the HealthKit boundary. A direct Strava connection fills all of this
 * automatically, but that pipe is beta-gated (Standard Tier caps at 10
 * athletes) so most users can't connect it yet. For them, a one-shot Strava
 * archive import backfills every run, ride and swim at once. This banner is the
 * ongoing nudge toward that path.
 *
 * Guards:
 *   - feature flag on (off once live Strava auto-enrich ships)
 *   - user is NOT Strava-connected (a connected user already has rich data)
 *   - enough thin activities to justify a bulk export
 *   - user hasn't dismissed (s.enrichPromptDismissed). Account > Strava History
 *     keeps a persistent affordance regardless.
 */
// Below this many thin activities, the per-activity "Add detail from Strava"
// affordance on each activity is the lighter path; the bulk-import nudge would
// be noise. UX threshold, not a model constant.
const ENRICH_PROMPT_MIN_THIN = 3;
function buildEnrichPromptBanner(s: SimulatorState): string {
  if (!STRAVA_ENRICH_UPLOAD_ENABLED) return '';
  if (s.stravaConnected) return '';
  if (s.enrichPromptDismissed) return '';

  const thinCount = (s.wks ?? []).reduce((n, w) =>
    n + Object.values(w.garminActuals ?? {}).filter(a =>
      a && (a.distanceKm ?? 0) > 0 && isThinActivity(a)).length, 0);
  if (thinCount < ENRICH_PROMPT_MIN_THIN) return '';

  return `
    <div id="home-enrich-banner" style="padding:12px 16px;margin:4px 16px 10px;background:#fff;border-radius:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)" class="hf" data-delay="0.05">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:2px">Add heart rate and splits to your runs</div>
          <div style="font-size:12px;color:#475569;line-height:1.45">${thinCount} activities came through Apple Health with heart rate and time only. Import your Strava archive once to add HR zones, per-km splits and routes to all of them.</div>
        </div>
        <button id="home-enrich-dismiss" aria-label="Dismiss" style="flex-shrink:0;width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:#94A3B8;cursor:pointer;font-size:16px;line-height:1">×</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="home-enrich-import" class="m-btn-glass" style="flex:1">Import from Strava</button>
      </div>
    </div>`;
}

/**
 * Post-race banner. Fires when a planned race has passed (1+ days ago) and
 * the user hasn't dismissed the prompt. Offers the "Switch to tracking"
 * downgrade as a soft suggestion. The plan keeps running regardless.
 *
 * State guards:
 *   - selectedMarathon.date OR onboarding.customRaceDate is in the past
 *   - NOT already in trackOnly mode (nothing to offer)
 *   - user hasn't dismissed (s.racePastPromptDismissed = true stored after X tap)
 *   - NOT in continuousMode. No meaningful race date
 */
function buildRaceCompleteBanner(s: SimulatorState): string {
  if (s.trackOnly || s.continuousMode) return '';
  if ((s as any).racePastPromptDismissed) return '';
  const raceDate = s.selectedMarathon?.date || s.onboarding?.customRaceDate
    || (s as any).triConfig?.raceDate
    || (s as any).hyroxConfig?.raceDate;
  if (!raceDate) return '';
  const race = new Date(raceDate);
  const now = new Date();
  race.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  const daysPast = Math.round((now.getTime() - race.getTime()) / 86400000);
  if (daysPast < 1) return '';
  const raceName = s.selectedMarathon?.name
    || (s.eventType === 'hyrox' ? 'Your HYROX' : null)
    || 'Your race';
  return `
    <div id="home-race-done-banner" style="padding:12px 16px;margin:4px 16px 10px;background:#fff;border-radius:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)" class="hf" data-delay="0.05">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:2px">${raceName} is done</div>
          <div style="font-size:12px;color:#475569;line-height:1.45">Keep your training data flowing without a new plan. Activity history and Strava connection stay intact.</div>
        </div>
        <button id="home-race-done-dismiss" aria-label="Dismiss" style="flex-shrink:0;width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:#94A3B8;cursor:pointer;font-size:16px;line-height:1">×</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="home-switch-to-track" class="m-btn-glass" style="flex:1">Switch to tracking</button>
      </div>
    </div>`;
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
    <div id="home-illness-banner" style="margin:0 16px 8px;border-radius:16px;overflow:hidden;
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

export function buildProgressBars(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];

  // Sessions done this week. Dedupe by unique garmin/strava activity id.
  // addAdhocWorkoutFromPending writes the SAME id into both garminActuals AND adhocWorkouts,
  // so adding their counts double-counts synced adhoc activities.
  // garminActuals keys (e.g. "garmin-strava-XXX") match adhocWorkouts ids, so we track
  // actuals keys separately and skip adhoc entries that already exist as an actual.
  const doneIds = new Set<string>();
  const actualsKeys = new Set<string>();
  if (wk) {
    for (const [key, act] of Object.entries(wk.garminActuals || {})) {
      const id = (act as any)?.garminId || key;
      if (id) doneIds.add(id);
      actualsKeys.add(key);
    }
    for (const w of (wk.adhocWorkouts || []) as any[]) {
      // Skip adhoc entries whose id matches a garminActuals key (already counted above)
      if (w.id && actualsKeys.has(w.id)) continue;
      // Manual adhoc workouts (no garmin/strava prefix) only count once they're rated.
      const isSynced = w.id?.startsWith('garmin-') || w.id?.startsWith('strava-');
      if (isSynced) doneIds.add(w.id);
      else if (wk.rated?.[w.id] && wk.rated[w.id] !== 'skip') doneIds.add(w.id);
    }
  }
  const sessionsDone = doneIds.size;
  // Count all planned non-rest sessions (runs + gym + cross-training + adhoc)
  const plannedWorkouts = wk
    ? generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus, undefined,
      s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
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

  // TSS this week vs plan. Signal B (full physiological load, all sports), matching the plan header.
  const _tssRaw = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const tssPlan = computePlannedWeekTarget(s, s.w);
  // Include decayed carry from previous weeks in the effective total
  const _tssCarry = computeCurrentWeekCarry(s, s.w);
  const tssActual = _tssRaw + _tssCarry;

  function fillBar(actual: number, plan: number): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const width = Math.min(ratio, 1) * 100;
    // Two bands only: grey if under 70%, green otherwise.
    // Doing more than planned is not a warning. ACWR/injury risk surface that separately.
    const color = ratio < 0.7 ? 'var(--c-muted)' : 'var(--c-ok)';
    return `<div class="m-prog-fill" style="width:${width}%;background:${color}"></div>`;
  }

  return `
    <div style="padding:0 16px;margin-bottom:14px" class="hf" data-delay="0.08">
      <div id="this-week-card" style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);position:relative;overflow:hidden;cursor:pointer">
        <div style="position:relative;z-index:1;padding:16px 20px 18px;display:flex;flex-direction:column;gap:13px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:10px;font-weight:600;color:var(--c-faint);letter-spacing:0.1em;text-transform:uppercase">This Week</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.25;color:var(--c-muted)"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <span style="font-size:11px;font-weight:600;color:var(--c-muted);letter-spacing:0.02em">Sessions</span>
              <span style="font-size:13px;font-weight:400;letter-spacing:-0.02em;color:var(--c-black)">${sessionsDone}<span style="color:var(--c-faint)"> / ${sessionsPlan}</span></span>
            </div>
            <div class="m-prog-track" style="background:rgba(0,0,0,0.08)">${fillBar(sessionsDone, sessionsPlan)}</div>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <span style="font-size:11px;font-weight:600;color:var(--c-muted);letter-spacing:0.02em">Distance</span>
              <span style="font-size:13px;font-weight:400;letter-spacing:-0.02em;color:var(--c-black)">${formatKm(kmDone, s.unitPref ?? 'km')}<span style="color:var(--c-faint)"> / ${formatKm(kmPlan, s.unitPref ?? 'km')}</span></span>
            </div>
            <div class="m-prog-track" style="background:rgba(0,0,0,0.08)">${fillBar(kmDone, kmPlan)}</div>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <span style="font-size:11px;font-weight:600;color:var(--c-muted);letter-spacing:0.02em">Training Load</span>
              <span style="font-size:13px;font-weight:400;letter-spacing:-0.02em;color:var(--c-black)">${tssActual}<span style="color:var(--c-faint)"> / ${Math.round(tssPlan)} TSS</span></span>
            </div>
            <div class="m-prog-track" style="background:rgba(0,0,0,0.08)">${fillBar(tssActual, tssPlan)}</div>
          </div>

          ${buildAdherenceRow(s)}
        </div>
      </div>
    </div>
  `;
}

// ─── Plan Adherence Row ─────────────────────────────────────────────────────

function buildAdherenceRow(s: SimulatorState): string {
  const { pct, totalPlanned, totalCompleted } = computePlanAdherence(s);
  if (pct == null) return '';

  const width = Math.min(pct, 100);
  const color = pct < 70 ? 'var(--c-muted)' : 'var(--c-ok)';

  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:11px;font-weight:600;color:var(--c-muted);letter-spacing:0.02em">Plan Adherence</span>
        <span style="font-size:13px;font-weight:400;letter-spacing:-0.02em;color:var(--c-black)">${totalCompleted}<span style="color:var(--c-faint)"> / ${totalPlanned} runs</span></span>
      </div>
      <div class="m-prog-track" style="background:rgba(0,0,0,0.08)">
        <div class="m-prog-fill" style="width:${width}%;background:${color}"></div>
      </div>
    </div>`;
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

// ─── Race Forecast Card (race mode only) ────────────────────────────────────

const RACE_DIST_LABEL: Record<string, string> = {
  '5k': '5K',
  '10k': '10K',
  'half': 'Half marathon',
  'marathon': 'Marathon',
};

function buildRaceForecastCard(s: SimulatorState): string {
  if (s.continuousMode || !s.rd || !s.initialBaseline) return '';

  // Prefer course-adjusted forecast (climate/altitude/elevation) when available
  //. That is the realistic finish time. Falls back to raw VDOT prediction.
  const forecastSec = s.forecastTimeAdjusted ?? s.forecastTime ?? s.blendedRaceTimeSec ?? s.currentFitness ?? 0;
  if (!forecastSec || forecastSec <= 0) return '';

  const goalSec = s.initialBaseline;
  const deltaSec = Math.round(forecastSec - goalSec);
  const deltaMin = Math.round(Math.abs(deltaSec) / 60);
  let deltaStr: string;
  if (Math.abs(deltaSec) < 60) deltaStr = 'On pace';
  else if (deltaSec > 0) deltaStr = `+${deltaMin} min`;
  else deltaStr = `−${deltaMin} min`;

  const distLabel = RACE_DIST_LABEL[s.rd] ?? 'Race';

  // Course-adjustment caption. Phrased as a percentage because that's the
  // constant (a 4% heat penalty is 4% whether you run 2:00 or 4:00). Suppress
  // tiny adjustments under 0.5% so micro-bumps from a 30m hill don't crowd
  // the card. Pulled from the compounded factor multipliers, not derived from
  // seconds, so the percentage doesn't drift with the user's fitness changes.
  const factors = s.forecastCourseFactors ?? [];
  const compoundedMult = factors.reduce((acc, f) => acc * f.multiplier, 1);
  const adjustmentPct = (compoundedMult - 1) * 100;
  const showAdjustmentCaption = Math.abs(adjustmentPct) >= 0.5 && factors.length > 0;
  const factorWords = factors
    .map(f => f.kind === 'run-elevation' ? 'elevation' : f.kind === 'climate' ? 'climate' : 'altitude')
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(', ');
  const pctStr = `${adjustmentPct >= 0 ? '+' : '−'}${Math.abs(adjustmentPct).toFixed(1)}%`;
  const slowerOrFaster = adjustmentPct >= 0 ? 'slower' : 'faster';
  const adjustmentCaption = showAdjustmentCaption
    ? `<div style="font-size:11px;color:#94A3B8;margin-top:8px;line-height:1.4">Athletes tend to run ${pctStr} ${slowerOrFaster} here (${factorWords}). Tap for breakdown.</div>`
    : '';

  return `
    <div style="padding:0 16px;margin-bottom:10px" class="hf" data-delay="0.16">
      <div id="home-race-forecast-card" style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:16px 18px;cursor:pointer;-webkit-tap-highlight-color:transparent">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:12px;color:#64748B;font-weight:500">${distLabel} forecast</div>
          <div style="font-size:14px;color:#94A3B8;line-height:1">›</div>
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
          <div style="font-size:28px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">${ft(forecastSec)}</div>
          <div style="font-size:12px;color:#64748B;text-align:right;line-height:1.5">
            <div>Target ${ft(goalSec)}</div>
            <div style="color:#0F172A;font-weight:600">${deltaStr}</div>
          </div>
        </div>
        ${adjustmentCaption}
      </div>
    </div>
  `;
}

// ─── Training Readiness Ring ────────────────────────────────────────────────

/** Exported for tests (plan-changes-running-only.test.ts). */
export function buildReadinessRing(s: SimulatorState): string {
  const isTri = s.eventType === 'triathlon';
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeReadinessACWR(s);

  // For readiness: same-signal TSB (Signal B for both CTL and ATL) with intra-week
  // decay applied through today, so the score matches the Readiness detail page.
  const completedWeek = Math.max(0, s.w - 1);
  const archivedPlans = (s as any).previousPlanWks ?? undefined;
  const liveTSB = computeLiveSameSignalTSB(s.wks ?? [], s.w, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined, s.planStartDate, archivedPlans);
  const tsb = liveTSB.tsb;
  const ctlNow = liveTSB.ctl;

  // Weighted directional momentum: recent week-over-week CTL deltas weighted 4/3/2/1 (newest first)
  const metrics = computeFitnessModel(s.wks ?? [], completedWeek, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined, archivedPlans);
  const ctlFourWeeksAgo = metrics[metrics.length - 5]?.ctl ?? ctlNow;
  const ctlHistory = [ctlNow, ...([4,3,2,1].map(i => metrics[metrics.length - 1 - i]?.ctl ?? ctlNow))];
  // ctlHistory[0]=now, [1]=1wk ago, [2]=2wk, [3]=3wk, [4]=4wk
  const momentumScore = (ctlHistory[0] - ctlHistory[1]) * 4
                      + (ctlHistory[1] - ctlHistory[2]) * 3
                      + (ctlHistory[2] - ctlHistory[3]) * 2
                      + (ctlHistory[3] - ctlHistory[4]) * 1;
  const ctlRef = ctlNow || 1;
  const momentumThreshold = ctlRef * 0.015; // 1.5% of CTL = noise floor

  // Recovery data: prefer watch sleep when available; manual entry is a fallback only
  const today = new Date().toISOString().split('T')[0];
  const noWatch = !getPhysiologySource(s);
  const manualToday = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const latestPhysio = s.physiologyHistory?.slice(-1)[0];
  const garminTodaySleep = (s.physiologyHistory ?? []).find(p => p.date === today && p.sleepScore != null);
  // Today-only: older sleep entries stay attached to their own day. If today's score is
  // missing we surface a refresh prompt rather than displaying stale data as today's.
  const sleepScore: number | null = garminTodaySleep?.sleepScore ?? manualToday?.sleepScore ?? null;
  const latestWithHrv = (s.physiologyHistory ?? []).slice().reverse().find(p => p.hrvRmssd != null);
  const hrvRmssd: number | null = latestWithHrv?.hrvRmssd ?? null;
  const hrvAll = (s.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length)
    : null;

  const effectiveSleepTarget0 = s.sleepTargetSec ?? deriveSleepTarget(s.physiologyHistory ?? []);
  const sleepBank = getSleepBank(s.physiologyHistory ?? [], effectiveSleepTarget0);
  const _rdnDailyTSS = buildDailySignalBTSS(s.wks ?? [], (s as any).previousPlanWks, s.planStartDate);
  const _rdnDebtOutlook = computeSleepDebtOutlook(s.physiologyHistory ?? [], _rdnDailyTSS, s.athleteTier ?? 'recreational', effectiveSleepTarget0);
  const sleepDebtExcessSec = _rdnDebtOutlook.typicalDebtSec != null
    ? _rdnDebtOutlook.debtSec - _rdnDebtOutlook.typicalDebtSec
    : null;

  // ── Strain Score ───────────────────────────────────────────────────────────
  // Today's completed Signal B TSS vs the day's target.
  // Target: use today's planned workout TSS when the plan has sessions scheduled,
  // otherwise fall back to signalBBaseline ÷ 7 (typical daily average).
  // This means 100% = "you completed what was planned for today".
  const strainWk = (s.wks ?? [])[s.w - 1];
  // The strain day is the athlete's local calendar day: synced activities are
  // filed by their local start day (isOnLocalDay), physiology entries (steps,
  // active minutes, updated on launch + foreground resume) are keyed by local
  // day, and plan weekdays are local. computeDayStrainTSS reads the activities
  // and that day's physiology entry together, the call the strain page this
  // ring opens makes. Sleep and HRV lookups keep `today`.
  const strainDay = localDateKey(new Date());
  const todaySignalBTSS = strainWk ? computeDayStrainTSS(strainWk, strainDay, s.physiologyHistory, s.tssPerActiveMinute) : 0;
  const todayDayOfWeek = (new Date(strainDay + 'T12:00:00').getDay() + 6) % 7;
  // Canonical mode-aware planned TSS (planned-day-tss.ts): reads the real plan
  // per mode (running resolver / tri-cycling-HYROX stored weeks) so the ring's
  // target matches what the plan view shows in every mode.
  const plannedCtx = getPlannedDayTSSContext(s, s.w);
  const plannedDayTSS = strainWk ? plannedCtx.plannedTSSForDay(todayDayOfWeek) : 0;
  // Per-session average: planned week TSS / training day count (tracks plan intent, not CTL history)
  let perSessionAvg = strainWk ? plannedCtx.perSessionAvg : 0;
  // On-demand (no plan) has no per-session target, which left the Strain ring with no
  // anchor — it auto-scaled to the actual and read ~80% for any load. Anchor it on the
  // sustainable daily load (CTL/7, Banister) instead — the same baseline the removed
  // "Today's load" card used — so the ring ranks today's load vs sustainable and the
  // target/colour bands ("Building" → "Above target" → "Load exceeded") work.
  if (perSessionAvg === 0 && s.trackOnly && (s.ctlBaseline ?? 0) > 0) {
    perSessionAvg = (s.ctlBaseline as number) / 7;
  }
  // Detect matched activity on a day with no generated workout
  let matchedActivityToday = false;
  if (plannedDayTSS === 0 && strainWk) {
    for (const [, actual] of Object.entries(strainWk.garminActuals ?? {})) {
      if (!isOnLocalDay(actual.startTime, strainDay)) continue;
      matchedActivityToday = true;
      break;
    }
  }
  // Day type
  const hasPlannedWorkout = plannedDayTSS > 0;
  const isRestDay = !hasPlannedWorkout && !matchedActivityToday;
  // Rest-day overreach on logged sessions only, against the plan's per-session
  // average (isRestDayOverreached; not the Just-Track ring anchor above): the
  // rule the Readiness page, the strain page and the coach read. Passive step
  // load lifted the ring to "High for rest day" on a walking day while the
  // Readiness page read the day as fine.
  const isRestDayOverreaching = strainWk ? isRestDayOverreached(strainWk, strainDay, isRestDay, plannedCtx.perSessionAvg) : false;
  // Logarithmic strain (log(1+actual)/log(1+target) × 100), for ring fill.
  //   Early effort registers visually (20/100 TSS → ~38% not 20%);
  //   exceeding target grows slowly (130% linear → ~107% log).
  //   Matches WHOOP/Bevel logarithmic strain display. The coach's plan-relative
  //   percent comes from deriveStrainContext (sessions only), below.
  const strainPctLog = hasPlannedWorkout && todaySignalBTSS > 0 && plannedDayTSS > 0
    ? (Math.log(1 + todaySignalBTSS) / Math.log(1 + plannedDayTSS)) * 100
    : 0;
  // Canonical capacity-anchored strain (capacity-strain.ts): anchor =
  // max(plannedDayTSS, weeklyCTL/7) — overreached only when today exceeds
  // BOTH the planned dose and sustainable daily load. Science + guards in
  // SCIENCE_LOG §BJ. Every surface that feeds computeReadiness.strainPct
  // (this card, readiness-view, daily-coach) reads the SAME helper — the
  // 2026-06-04 incident (Home 61 vs detail page 10) was two surfaces
  // hand-rolling different percents.
  const capStrain = computeCapacityStrain(s);

  // Compute recovery score first so the same value feeds both the readiness composite and the display.
  const todayStr0 = new Date().toISOString().split('T')[0];
  const manualSleepToday0 = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === todayStr0 && e.source === 'manual',
  );
  const noGarminSleep0 = !(s.physiologyHistory ?? []).find(p => p.date === todayStr0 && p.sleepScore != null);
  // Canonical sleep history: fold manual recoveryHistory nights into physiology
  // so manual sleep accumulates toward the recovery composite, the sleep-cap
  // decay, and the 14d chronic average (device sleep wins per date). Must match
  // readiness-view so both surfaces show the same readiness number.
  const sleepHistoryMerged0 = mergeManualSleepHistory(s.physiologyHistory ?? [], s.recoveryHistory ?? []);
  const sleepDebtForRecovery = sleepBank.bankSec < 0 ? Math.abs(sleepBank.bankSec) : 0;
  const recoveryResult = computeRecoveryScore(sleepHistoryMerged0, { manualSleepScore: noGarminSleep0 ? (manualSleepToday0?.sleepScore ?? undefined) : undefined, sleepDebtSec: sleepDebtForRecovery });

  const triReadinessResult = isTri ? computeTriReadiness(s) : null;

  // Big ring = global recovery readiness (sleep + HRV + physiology + combined load).
  // Per-discipline load status surfaces in the discipline ring row in tri mode.
  // MTL ACWR for HYROX. Station eccentric ramp rate. Canonical computation
  // (mtl.ts hyroxMtlAcwr), shared with Readiness, Stats and the MTL page.
  const mtlAcwr = hyroxMtlAcwr(s)?.ratio ?? null;

  const readiness: ReadinessResult = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    sleepScore,
    hrvRmssd,
    sleepHistory: sleepHistoryMerged0,
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    sleepDebtExcessSec,
    weeksOfHistory: metrics.length,
    strainPct: capStrain.todayTSS > 0 ? capStrain.pctCapacity : null,
    recentLegLoads: s.recentLegLoads ?? [],
    impactBlocked: isImpactBlockedByInjury(s.injuryState),
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    acwrSafeUpper: acwr.safeUpper,
    mtlAcwr,
  });

  // ── Primary message (single authoritative sentence) ─────────────────────
  // Replaces the old readinessSentence + HRV banner with one coherent message
  // computed by daily-coach using all available signals. The coach's context
  // comes from deriveStrainContext, the source the coach page and the Readiness
  // page use (D8): it carries today's planned workout, so the line names the
  // session, and its session fields count logged sessions only (passive step
  // load is strain, not a session: ISSUE-406 (c)). Home built its own context
  // before, without the planned workout.
  const coach = computeDailyCoach(s, deriveStrainContext(s));
  // Tri-mode post-session override: capacityStrainNote, which calls
  // postSessionNote: gated on a logged session, injury-cap overshoot first
  // ("X TSS logged against an injury-capped day of Y…"), then the Big / Solid /
  // Good training tier from sessionPctCapacity, quoting the ring's number. Running,
  // HYROX and Just-Track get the same sentence from the same helper through
  // coach.primaryMessage, and the Readiness page calls it too, so one session
  // reads one tier word on every surface. (Override restored from the
  // 2026-05-19 snapshot — lost in the May crash.)
  // Fallback = the chronic sentence this card would otherwise show, so a
  // trained day below the strain tiers still leads with "X TSS logged today."
  // Rest-day overreach leads, as on the coach line (running, HYROX) and the
  // Readiness page: Home read "153 TSS logged today. Keep training
  // consistently..." beside a warn-coloured ring while Readiness said
  // "Overreaching. High load on a rest day." (2026-10-22, E2).
  const triPostSessionNote = isTri
    ? (isRestDayOverreaching
      ? REST_DAY_OVERREACH_SENTENCE
      : capacityStrainNote(capStrain, triReadinessResult?.sentence ?? readiness.sentence))
    : null;
  // TEMP DEBUG (2026-06-03, remove after dogfood verification)
  console.log('[readiness-debug]', JSON.stringify({
    todayTSS: capStrain.todayTSS, plannedDayTSS: Math.round(capStrain.plannedDayTSS),
    anchor: Math.round(capStrain.anchorTSS), pctPlan: Math.round(capStrain.pctPlan),
    pctCapacity: Math.round(capStrain.pctCapacity),
    weeklyCtl: Math.round(capStrain.weeklyCtl), injuryCapOvershoot: capStrain.injuryCapOvershoot,
    weeksOfHistory: metrics.length, w: s.w,
    score: readiness.score, label: readiness.label, floor: readiness.hardFloor,
    note: triPostSessionNote,
    // Extended legs (2026-06-04): the 66→61 launch flicker had identical strain
    // inputs, so the moving leg is one of these. Remove with the whole block
    // after device verification.
    tsb: Math.round(tsb * 10) / 10, acwr: Math.round(acwr.ratio * 100) / 100,
    ctlNow: Math.round(ctlNow * 10) / 10,
    sleepScore, hrvRmssd, hrvPersonalAvg,
    sleepBank: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    sleepDebtExcess: sleepDebtExcessSec,
    recovery: recoveryResult.hasData ? recoveryResult.score : null,
    legLoad: Math.round(readiness.legLoadTotal * 10) / 10,
    physioLen: (s.physiologyHistory ?? []).length,
    actualsLen: Object.keys(strainWk?.garminActuals ?? {}).length,
  }));
  const baseReadinessSentence = isTri
    ? (triPostSessionNote ?? triReadinessResult?.sentence ?? readiness.sentence)
    : coach.primaryMessage;
  // Injury state is the dominant constraint when active. Lead with it so the
  // user reads "blocked / capped" before the systemic readiness commentary.
  const injuryCaption = buildInjuryCaption(s);

  const color = readinessColor(readiness.label);
  const rdnStops = readinessColorStops(readiness.label);
  // In tri mode skip the post-session label override. Tri readiness label is already definitive.
  const ringLabel = isTri ? readiness.label : coach.ringLabel;

  // SVG rings: 270° arc, starts bottom-left (135°), fills clockwise. 120×120 for side-by-side layout.
  const CX = 60, CY = 60, R = 44, SW = 8;
  const START = 135;
  const SWEEP = 270;
  const fillEnd = START + (readiness.score / 100) * SWEEP;
  const trackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const fillPathStr = readiness.score > 0 ? arcPath(CX, CY, R, START, Math.min(fillEnd, START + SWEEP - 0.01)) : '';

  // ── Strain ring: absolute TSS with target marker ────────────────────────
  // Readiness-modulated target range (matches strain-view logic)
  const strainTarget = computeDayTargetTSS(
    plannedDayTSS,
    readiness.label as any,
    perSessionAvg,
    isRestDay,
    matchedActivityToday,
  );
  // target.hi maps to a FULL arc ("target reached" = ring closes); overshoot clamps,
  // colour carries it. Matches strain-view's detail ring. No-target fallback keeps a partial arc.
  const strainRingMax = strainTarget.hi > 0 ? strainTarget.hi : Math.max(todaySignalBTSS * 1.25, 1);

  // Colour: orange (working) → green (in range) → red (exceeded)
  let strainColor: string;
  let strainLabel: string;
  if (isRestDay && isRestDayOverreaching) {
    strainColor = 'var(--c-warn)';
    strainLabel = 'High for rest day';
  } else if (strainTarget.mid > 0 && todaySignalBTSS > strainTarget.hi * 1.3) {
    strainColor = 'var(--c-warn)';
    strainLabel = 'Load exceeded';
  } else if (strainTarget.mid > 0 && todaySignalBTSS >= strainTarget.lo) {
    strainColor = 'var(--c-ok)';
    strainLabel = todaySignalBTSS > strainTarget.hi ? 'Above target' : 'Target reached';
  } else if (todaySignalBTSS > 0) {
    strainColor = 'var(--c-ok)';
    strainLabel = todaySignalBTSS < strainTarget.lo * 0.5 ? 'Light' : 'Building';
  } else {
    strainColor = 'var(--c-faint)';
    strainLabel = isRestDay ? 'Rest day' : (hasPlannedWorkout ? 'Not started' : 'Rest day');
  }

  const strainGradH = strainColor === 'var(--c-warn)' ? '#FCD27A' : strainColor === 'var(--c-ok)' ? '#86EFAC' : '#CBD5E1';
  const strainGradM = strainColor === 'var(--c-warn)' ? '#F59E0B' : strainColor === 'var(--c-ok)' ? '#22C55E' : '#94A3B8';
  const strainGradS = strainColor === 'var(--c-warn)' ? '#A16207' : strainColor === 'var(--c-ok)' ? '#166534' : '#475569';

  // Ring fill: TSS as fraction of ringMax
  const strainFillPct = todaySignalBTSS > 0 ? Math.min(todaySignalBTSS / strainRingMax, 1) : 0;
  const strainFillEnd = START + strainFillPct * SWEEP;
  const sTrackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const sArcFill = strainFillPct > 0
    ? arcPath(CX, CY, R, START, Math.min(strainFillEnd, START + SWEEP - 0.01))
    : '';

  // Target dashes removed. Too noisy at 66px ring size

  // Sleep ring
  const sleepDurationSec = garminTodaySleep?.sleepDurationSec ?? null;
  const sleepRingColor = sleepScore != null ? sleepScoreColor(sleepScore) : 'var(--c-faint)';
  const sleepGradH = sleepScore != null && sleepScore >= 65 ? '#DDD6FE' : '#FED7AA';
  const sleepGradM = sleepScore != null && sleepScore >= 65 ? '#8B5CF6' : '#F59E0B';
  const sleepGradS = sleepScore != null && sleepScore >= 65 ? '#4C1D95' : '#A16207';
  const sleepFillEnd = START + ((sleepScore ?? 0) / 100) * SWEEP;
  const slTrackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const slArcFill = sleepScore != null && sleepScore > 0
    ? arcPath(CX, CY, R, START, Math.min(sleepFillEnd, START + SWEEP - 0.01))
    : '';

  // Sub-signal display values
  // ÷7: display in daily-equivalent units (TrainingPeaks-compatible)
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;
  // Zone thresholds on daily-equivalent TSB (Coggan/TrainingPeaks standard)
  const tsbZone = tsbDisp > 0 ? 'Fresh' : tsbDisp >= -3 ? 'Recovering' : tsbDisp >= -8 ? 'Fatigued' : tsbDisp >= -15 ? 'Heavy' : tsbDisp >= -25 ? 'Overloaded' : 'Overreaching';
  const safetyLabel = acwr.ratio <= 0 ? '—' : acwr.status === 'safe' ? 'Optimal' : acwr.status === 'caution' ? 'High' : acwr.status === 'high' ? 'Very High' : 'Low';
  const safetyColor = acwr.status === 'high' ? 'var(--c-warn)' : acwr.status === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)';
  const momentumArrow = momentumScore > momentumThreshold ? '↗' : momentumScore >= -momentumThreshold ? '→' : '↘';
  const momentumColor = momentumScore > momentumThreshold ? 'var(--c-ok)' : momentumScore >= -momentumThreshold * 2 ? 'var(--c-caution)' : 'var(--c-warn)';

  const recoveryScoreColor = recoveryResult.hasData
    ? (recoveryResult.score! >= 80 ? 'var(--c-ok)' : recoveryResult.score! >= 65 ? 'var(--c-ok-muted)' : recoveryResult.score! >= 50 ? 'var(--c-caution)' : 'var(--c-warn)')
    : 'var(--c-faint)';
  const recScore = recoveryResult.hasData && recoveryResult.score != null ? recoveryResult.score : -1;
  const recGradH = recScore >= 65 ? '#86EFAC' : recScore >= 50 ? '#FCD27A' : recScore >= 0 ? '#FCA5A5' : '#CBD5E1';
  const recGradM = recScore >= 65 ? '#22C55E' : recScore >= 50 ? '#F59E0B' : recScore >= 0 ? '#EF4444' : '#94A3B8';
  const recGradS = recScore >= 65 ? '#166534' : recScore >= 50 ? '#A16207' : recScore >= 0 ? '#991B1B' : '#475569';

  // Recovery ring arc paths
  const recFillPct = recoveryResult.hasData && recoveryResult.score != null ? recoveryResult.score : 0;
  const recFillEnd = START + (recFillPct / 100) * SWEEP;
  const recTrackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const recArcFill = recFillPct > 0
    ? arcPath(CX, CY, R, START, Math.min(recFillEnd, START + SWEEP - 0.01))
    : '';

  // ISSUE 1: Driving signal highlight. Coloured left border + "⬇ Main factor" label
  const isDriving = (sig: string) => readiness.drivingSignal === sig;
  const drivingBorderStyle = (sig: string) => isDriving(sig)
    ? 'border-left:3px solid var(--c-warn);padding-left:9px;margin-left:-3px;'
    : '';
  const drivingTag = (sig: string) => isDriving(sig)
    ? `<div style="font-size:9px;color:var(--c-warn);margin-top:3px;font-weight:600">⬇ Main factor</div>`
    : '';

  // Tri mode: source the Adjust-plan affordance from the tri suggestion
  // pipeline (collectTriSuggestions → showTriSuggestionModal). The running-side
  // composite's drivingSignal does not map onto tri's per-discipline ramps,
  // and `triggerACWRReduction` is a no-op in tri mode (main-view.ts:2217).
  const isTriMode = s.eventType === 'triathlon';
  const triBundle: TriSuggestionBundle | null = isTriMode ? collectTriSuggestions(s) : null;
  const triHasMods = (triBundle?.mods.length ?? 0) > 0;
  const triDominantSource = triBundle?.mods[0]?.source;

  // Hide the adjust button when its handler has nothing to do. Otherwise the
  // user taps and lands silently on the plan view. Mirror the click-handler's
  // branches: ACWR elevated → reduction modal, unspent cross-training →
  // reduction modal, unrated run remaining this week → recovery advice sheet
  // (covers today AND future days, since plan-engine moves can slide a hard
  // session into today).
  //
  // Leg-load is special: "Protect the legs" only makes sense when there's a
  // hard impact session ahead that could be deferred or downgraded. A week of
  // RPE-5 generic activities (e.g. triathlon "Activity 2" placeholders) gives
  // the button nothing to act on, so we require an unrated *hard* workout in
  // the remaining week for the legLoad branch only.
  const acwrElevatedForBtn = acwr.status === 'caution' || acwr.status === 'high';
  const hasUnspentForBtn = (strainWk?.unspentLoadItems?.length ?? 0) > 0;
  // "Reduce session load" must only be offered when the reduction handler
  // would actually cut something. Mirror triggerACWRReduction's own skip via
  // the shared canonical projection (2026-06-04 dogfood: the button appeared,
  // the handler concluded "week already on target", nothing happened). The
  // projection check applies in the same case the handler applies it: unspent
  // cross-training items present. Null projection = cannot judge → allow.
  // An ACWR reduction applied today replaces the adjust button with a
  // "Session load reduced." caption + Undo, valid for the rest of that day.
  // Running mode only (tri routes through its own suggestion pipeline).
  const acwrUndoAvailable = !isTriMode
    && s.wks?.[s.w - 1]?.acwrReductionUndo?.date === new Date().toISOString().split('T')[0];
  const ratedForBtn = strainWk?.rated ?? {};
  // Running-only logic (tri routes through triHasMods below). Reads the
  // canonical running resolver; tri/HYROX/just-track get an empty list rather
  // than a phantom regenerated running week.
  const runPlanForBtn = (!s.trackOnly && s.eventType !== 'triathlon' && s.eventType !== 'hyrox' && strainWk)
    ? resolveWeekWorkouts(s, s.w) : [];
  const remainingUnratedWorkouts = runPlanForBtn.filter((w: any) => {
    const day = w.dayOfWeek ?? -1;
    if (day < todayDayOfWeek) return false;
    if (w.t === 'cross' || w.t === 'strength' || w.t === 'rest' || w.t === 'gym') return false;
    if (w.status === 'skip' || w.status === 'replaced') return false;
    return !ratedForBtn[w.id || w.n];
  });
  const hasRemainingRun = remainingUnratedWorkouts.length > 0;
  const hasRemainingHardRun = remainingUnratedWorkouts.some((w: any) => isHardWorkout(w.t));
  const reductionProjection = (!isTriMode && hasUnspentForBtn && strainWk)
    ? computeAcwrReductionProjection(s, workoutsToPlannedRuns(
        runPlanForBtn.filter((w: any) => !(strainWk.rated ?? {})[w.id || w.n]) as any, s.pac))
    : null;
  const reductionWouldAct = !hasUnspentForBtn || (reductionProjection?.over ?? true);

  // ISSUE 3: Adjust button text varies by driving signal. When the canonical
  // projection says a reduction would be a no-op, the safety label falls back
  // to rest advice — visibility, label, and click routing must all share the
  // projection's conclusion (2026-06-04 dogfood round 2: the button survived
  // on the remaining-run justification but still promised "Reduce session
  // load" and still routed to the reduction branch).
  const adjustText = isTriMode
    ? (triDominantSource === 'cross_training_overload' || triDominantSource === 'readiness'
        ? 'Reduce session load'
        : 'Adjust plan')
    : readiness.drivingSignal === 'fitness' ? 'Adjust plan'
      : readiness.drivingSignal === 'safety' ? (reductionWouldAct ? 'Reduce session load' : 'Take it lighter today')
        : readiness.drivingSignal === 'recovery' ? 'Take it lighter today'
          : readiness.drivingSignal === 'legLoad' ? 'Protect the legs'
            : "Keep consistency, don't skip";
  const showAdjustButton = isTriMode
    // Tri: only show the button when the suggestion pipeline has something to
    // act on. A poor readiness score with no actionable mod is a dead button.
    ? triHasMods
    // Just-track and HYROX: nothing to act on. Every branch of the click handler
    // changes the running engine's week (ACWR reduction, recovery advice), which
    // neither mode shows, so the button would only reach a no-op. Same principle
    // as tri's triHasMods gate.
    : (s.trackOnly || s.eventType === 'hyrox') ? false
    : readiness.score <= 59 && (
        readiness.drivingSignal === 'legLoad'
          ? ((acwrElevatedForBtn || hasUnspentForBtn) && reductionWouldAct) || hasRemainingHardRun
          : ((acwrElevatedForBtn || hasUnspentForBtn) && reductionWouldAct) || hasRemainingRun
      );

  const recoveryPillHtml = recoveryResult.hasData
    ? `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('recovery')}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Physiology</div>
        <div style="font-size:14px;font-weight:500;color:${recoveryScoreColor}">${recoveryResult.score}/100</div>
        ${drivingTag('recovery')}
      </div>`
    : `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;opacity:0.45;cursor:pointer">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Physiology</div>
        <div style="font-size:11px;color:var(--c-faint)">${recoveryResult.dataStale ? 'Sync watch' : 'Connect watch'}</div>
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

  const injuryActive = isInjuryActive();

  return `
    <div style="padding:0 16px;margin-bottom:10px" class="hf" data-delay="0.18">
      <div id="home-readiness-card" style="position:relative;background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);overflow:hidden">

        ${injuryActive ? `
        <!-- Injury corner badge. Top-left so it clears the drill affordance -->
        <div style="position:absolute;top:10px;left:10px;display:flex;align-items:center;gap:5px;padding:4px 8px;border-radius:999px;background:#fef2f2;border:1px solid #fecaca;font-size:10px;font-weight:600;letter-spacing:0.04em;color:#b91c1c;z-index:1">
          <span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#dc2626"></span>
          Injured
        </div>
        ` : ''}

        <!-- Corner drill affordance. Signals the card opens the full Readiness breakdown -->
        <div id="home-readiness-drill" role="button" aria-label="Open readiness breakdown" style="position:absolute;top:6px;right:6px;padding:8px;cursor:pointer;z-index:2;line-height:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>

        <!-- Readiness hero ring. Top centre -->
        <div style="display:flex;justify-content:center;padding:20px 8px 10px">
          <div id="home-readiness-ring" style="display:flex;flex-direction:column;align-items:center;cursor:pointer">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.02em;color:var(--c-faint);margin-bottom:8px">Readiness</div>
            <div style="position:relative;width:120px;height:120px">
              <svg viewBox="0 0 120 120" width="120" height="120" style="display:block;overflow:visible">
                <defs>
                  <linearGradient id="homeRdnGrad" x1="15" y1="15" x2="105" y2="105" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stop-color="${rdnStops.highlight}"/>
                    <stop offset="50%"  stop-color="${rdnStops.mid}"/>
                    <stop offset="100%" stop-color="${rdnStops.shadow}"/>
                  </linearGradient>
                </defs>
                <path d="${trackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${fillPathStr ? (() => { const arcLen = Math.ceil(2 * Math.PI * R * (readiness.score / 100) * (SWEEP / 360)); return `<path d="${fillPathStr}" fill="none" stroke="url(#homeRdnGrad)" stroke-width="${SW}" stroke-linecap="round" stroke-dasharray="${arcLen}" stroke-dashoffset="${arcLen}" class="arc-anim"/>`; })() : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-2px">
                <div style="font-size:32px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${color}">${readiness.score}</div>
                <div style="font-size:10px;font-weight:600;letter-spacing:0.01em;margin-top:4px;color:var(--c-black)">${ringLabel}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Sub-signals row: Sleep · Strain · Physiology -->
        <div style="display:flex;flex-direction:row;align-items:flex-start;justify-content:space-around;padding:6px 8px 12px;gap:0">

          <!-- Sleep ring -->
          <div id="home-sleep-ring" style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer${noWatch && sleepScore == null ? ';opacity:0.35' : ''}">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.02em;color:var(--c-faint);margin-bottom:6px">Sleep</div>
            <div style="position:relative;width:66px;height:66px">
              <svg viewBox="0 0 120 120" width="66" height="66" style="display:block;overflow:visible">
                <defs>
                  <linearGradient id="homeSlGrad" x1="15" y1="15" x2="105" y2="105" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stop-color="${sleepGradH}"/>
                    <stop offset="50%"  stop-color="${sleepGradM}"/>
                    <stop offset="100%" stop-color="${sleepGradS}"/>
                  </linearGradient>
                </defs>
                <path d="${slTrackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${slArcFill ? (() => { const al = Math.ceil(2 * Math.PI * R * ((sleepScore ?? 0) / 100) * (SWEEP / 360)); return `<path d="${slArcFill}" fill="none" stroke="url(#homeSlGrad)" stroke-width="${SW}" stroke-linecap="round" stroke-dasharray="${al}" stroke-dashoffset="${al}" class="arc-anim"/>`; })() : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-2px">
                ${sleepScore != null
                  ? `<div style="font-size:17px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${sleepRingColor}">${Math.round(sleepScore)}</div>
                     ${sleepDurationSec != null ? `<div style="font-size:8px;color:var(--c-faint);margin-top:1px">${fmtSleepDuration(sleepDurationSec)}</div>` : ''}`
                  : noWatch
                    ? `<div style="font-size:16px;font-weight:300;line-height:1;color:var(--c-faint)">—</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:3px">Log below</div>`
                    : `<div style="font-size:16px;font-weight:300;line-height:1;color:var(--c-faint)">—</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:3px">No data</div>`
                }
              </div>
            </div>
          </div>

          <!-- Strain ring -->
          <div id="home-strain-ring" data-readiness-label="${readiness.label}" style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.02em;color:var(--c-faint);margin-bottom:6px">Strain</div>
            <div style="position:relative;width:66px;height:66px">
              <svg viewBox="0 0 120 120" width="66" height="66" style="display:block;overflow:visible">
                <defs>
                  <linearGradient id="homeStGrad" x1="15" y1="15" x2="105" y2="105" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stop-color="${strainGradH}"/>
                    <stop offset="50%"  stop-color="${strainGradM}"/>
                    <stop offset="100%" stop-color="${strainGradS}"/>
                  </linearGradient>
                </defs>
                <path d="${sTrackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${sArcFill ? (() => { const al = Math.ceil(2 * Math.PI * R * strainFillPct * (SWEEP / 360)); return `<path d="${sArcFill}" fill="none" stroke="url(#homeStGrad)" stroke-width="${SW}" stroke-linecap="round" stroke-dasharray="${al}" stroke-dashoffset="${al}" class="arc-anim"/>`; })() : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-2px">
                ${todaySignalBTSS > 0
                  ? `<div style="font-size:19px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${strainColor}">${Math.round(todaySignalBTSS)}</div>
                     <div style="font-size:8px;color:var(--c-faint);margin-top:2px">TSS</div>`
                  : hasPlannedWorkout
                    ? `<div style="font-size:17px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-faint)">\u2014</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:1px">TSS</div>`
                    : `<div style="font-size:16px;font-weight:300;letter-spacing:-0.02em;line-height:1;color:var(--c-faint)">Rest</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:3px">No sessions</div>`
                }
              </div>
            </div>
          </div>

          <!-- Physiology ring (was Recovery) -->
          <div id="home-recovery-ring" style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer${noWatch && !recoveryResult.hasData ? ';opacity:0.35' : ''}">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.02em;color:var(--c-faint);margin-bottom:6px">Physiology</div>
            <div style="position:relative;width:66px;height:66px">
              <svg viewBox="0 0 120 120" width="66" height="66" style="display:block;overflow:visible">
                <defs>
                  <linearGradient id="homeRecGrad" x1="15" y1="15" x2="105" y2="105" gradientUnits="userSpaceOnUse">
                    <stop offset="0%"   stop-color="${recGradH}"/>
                    <stop offset="50%"  stop-color="${recGradM}"/>
                    <stop offset="100%" stop-color="${recGradS}"/>
                  </linearGradient>
                </defs>
                <path d="${recTrackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
                ${recArcFill ? (() => { const al = Math.ceil(2 * Math.PI * R * ((recoveryResult.score ?? 0) / 100) * (SWEEP / 360)); return `<path d="${recArcFill}" fill="none" stroke="url(#homeRecGrad)" stroke-width="${SW}" stroke-linecap="round" stroke-dasharray="${al}" stroke-dashoffset="${al}" class="arc-anim"/>`; })() : ''}
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-2px">
                ${recoveryResult.hasData && recoveryResult.score != null
                  ? `<div style="font-size:17px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${recoveryScoreColor}">${recoveryResult.score}</div>
                     <div style="font-size:8px;color:var(--c-faint);margin-top:1px">/100</div>`
                  : noWatch
                    ? `<div style="font-size:16px;font-weight:300;line-height:1;color:var(--c-faint)">—</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:3px">Connect watch</div>`
                    : `<div style="font-size:16px;font-weight:300;line-height:1;color:var(--c-faint)">—</div>
                       <div style="font-size:8px;color:var(--c-faint);margin-top:3px">${recoveryResult.dataStale ? 'Sync watch' : 'No data'}</div>`
                }
              </div>
            </div>
          </div>
        </div>

        ${sleepScore == null && !manualToday && noWatch ? `
        <!-- Manual sleep card (no watch connected. Manual entry is the only option) -->
        <div id="manual-sleep-card" style="margin:4px 14px 10px;padding:12px 14px;border-radius:12px;border:1px solid var(--c-border);background:var(--c-surface)">
          <div style="font-size:13px;font-weight:500;color:var(--c-black);margin-bottom:8px">How did you sleep last night?</div>
          <div style="display:flex;gap:6px">
            <button class="manual-sleep-btn" data-quality="great" style="flex:1;padding:7px 0;border-radius:999px;border:1px solid var(--c-border);background:transparent;font-size:12px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f)">Great</button>
            <button class="manual-sleep-btn" data-quality="good" style="flex:1;padding:7px 0;border-radius:999px;border:1px solid var(--c-border);background:transparent;font-size:12px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f)">Good</button>
            <button class="manual-sleep-btn" data-quality="poor" style="flex:1;padding:7px 0;border-radius:999px;border:1px solid var(--c-border);background:transparent;font-size:12px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f)">Poor</button>
            <button class="manual-sleep-btn" data-quality="terrible" style="flex:1;padding:7px 0;border-radius:999px;border:1px solid var(--c-border);background:transparent;font-size:12px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f)">Terrible</button>
          </div>
        </div>
        ` : sleepScore == null && !manualToday && !noWatch ? `
        <!-- Watch connected but not yet synced. Prompt sync instead of manual entry -->
        <div style="margin:4px 14px 10px;padding:10px 14px;border-radius:12px;border:1px solid var(--c-border);background:var(--c-surface);display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:12px;color:var(--c-muted)">Today's sleep hasn't arrived yet. Open your watch app and resync.</span>
        </div>
        ` : sleepScore == null && manualToday ? `
        <div style="margin:4px 14px 10px;padding:10px 14px;border-radius:12px;border:1px solid var(--c-border);background:var(--c-surface);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:12px;color:var(--c-muted)">Sleep logged: <span style="font-weight:500;color:var(--c-black)">${manualToday.sleepScore >= 80 ? 'Great' : manualToday.sleepScore >= 60 ? 'Good' : manualToday.sleepScore >= 40 ? 'Poor' : 'Terrible'}</span></div>
          <div style="font-size:11px;color:var(--c-faint)">${manualToday.sleepScore}/100</div>
        </div>
        ` : ''}

        <!-- Sentence -->
        ${injuryCaption
          ? `<p style="font-size:14px;font-weight:600;color:var(--c-black);text-align:center;line-height:1.55;margin:0 16px 8px;max-width:none">${injuryCaption}</p>
             ${baseReadinessSentence ? `<p style="font-size:14px;color:var(--c-muted);text-align:center;line-height:1.55;margin:0 16px 14px;max-width:none">${baseReadinessSentence}</p>` : ''}`
          : `<p style="font-size:14px;color:var(--c-muted);text-align:center;line-height:1.55;margin:0 16px 14px;max-width:none">${baseReadinessSentence}</p>`}
        ${readiness.suppressStreak != null ? `<p style="font-size:12px;color:var(--c-muted);text-align:center;line-height:1.4;margin:-6px 16px 14px;opacity:0.75">Sleep has limited your score for ${readiness.suppressStreak} consecutive days.</p>` : ''}
        ${!isTri && coach.sessionNote ? `<p style="font-size:13px;color:var(--c-muted);text-align:center;line-height:1.45;margin:0 16px 14px;padding:10px 16px 0;border-top:1px solid var(--c-border)">${coach.sessionNote}</p>` : ''}

        ${acwrUndoAvailable ? `
        <div style="padding:0 14px 16px">
          <div style="font-size:12px;color:var(--c-muted);text-align:center;margin-bottom:8px">Session load reduced.</div>
          <button id="readiness-undo-btn" class="m-btn-glass m-btn-glass--inset" style="width:100%">
            Undo reduction
          </button>
        </div>` : showAdjustButton ? `
        <div style="padding:0 14px 16px">
          <button id="readiness-adjust-btn" class="m-btn-glass m-btn-glass--inset" style="width:100%">
            ${adjustText}
          </button>
        </div>` : ''}

      </div>
    </div>
  `;
}

// ─── Readiness pill info sheets ──────────────────────────────────────────────

type PillSignal = 'fitness' | 'safety' | 'momentum' | 'recovery';

interface PillSheetData {
  tsb: number; tsbZone: string; tsbLabel: string; fitnessScore: number;
  acwrRatio: number; acwrSafeUpper: number; safetyLabel: string;
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
  /** Leg load note for the Injury Risk pill — null when leg fatigue is negligible. */
  legLoadNote?: string | null;
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
      : tsbDailyVal > 0 ? "Your body is fresh. Your short-term load is lower than your fitness baseline."
        : tsbDailyVal > -2 ? "You've trained recently but your body is handling it well."
          : tsbDailyVal > -4 ? "You've built up meaningful fatigue. Your body is under training stress."
            : "Your body is carrying significant accumulated fatigue. Short-term load has well exceeded what your fitness can absorb.";
    const action = d.tsbZone === 'Overreaching' ? 'Full rest days needed before resuming structured training.'
      : d.tsbZone === 'Overloaded' ? 'Rest or very easy movement only. Hard sessions will not produce useful adaptation.'
        : d.tsbZone === 'Heavy' ? 'Expect sore legs. Easy sessions or rest until this clears.'
          : d.tsbZone === 'Fatigued' ? 'Legs may feel heavy. Easy effort recommended today.'
            : d.tsbZone === 'Recovering' ? 'Good balance. Session as planned.'
              : d.tsbZone === 'Peaked' ? 'Perfect timing for a race or a hard key session.'
                : "Fresh. Full session, or a little extra if you feel good.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.02em">${d.tsbLabel} <span style="font-size:13px;color:var(--c-muted)">${d.tsbZone}</span></div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      ${scaleBar([
      { label: 'Overreaching', flex: 10, color: 'rgba(255,69,58,0.6)' },
      { label: 'Overloaded', flex: 10, color: 'rgba(255,69,58,0.4)' },
      { label: 'Heavy', flex: 7, color: 'rgba(255,159,10,0.55)' },
      { label: 'Fatigued', flex: 5, color: 'rgba(255,159,10,0.35)' },
      { label: 'Recovering', flex: 3, color: 'rgba(78,159,229,0.4)' },
      { label: 'Fresh', flex: 10, color: 'rgba(52,199,89,0.55)' },
      { label: 'Peaked', flex: 10, color: 'rgba(52,199,89,0.85)' },
    ], markerPct)}
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px"><strong>What to do:</strong> ${action}</p>
      <p style="font-size:11px;color:var(--c-faint);margin-top:10px;line-height:1.5">Freshness measures whether your body has had enough time to absorb recent training. It's the gap between your long-term fitness (built over 6 weeks) and your short-term fatigue (last 7 days). Positive = more rested than usual. Negative = carrying fatigue.</p>`;

  } else if (signal === 'safety') {
    title = 'Load Ratio'; subtitle = 'How fast your training load is increasing';
    const markerPct = d.acwrRatio > 0
      ? Math.min(98, Math.max(2, ((d.acwrRatio - 0.5) / 1.5) * 100))
      : null;
    const what = d.acwrRatio <= 0 ? 'Not enough training history to calculate.'
      : d.acwrRatio <= d.acwrSafeUpper ? "Your recent load is similar to your long-term baseline, safe territory."
        : d.acwrRatio <= d.acwrSafeUpper + 0.2 ? "Your load is ramping faster than usual. Consider whether it's sustainable."
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
    ], markerPct)}
    ${d.legLoadNote ? `<p style="font-size:12px;color:var(--c-muted);margin-top:10px">${d.legLoadNote}</p>` : ''}`;

  } else if (signal === 'momentum') {
    title = 'Running Load Momentum'; subtitle = 'Whether your running load is trending up or down';
    const direction = d.momentumScore > d.momentumThreshold ? 'Building'
      : d.momentumScore >= -d.momentumThreshold ? 'Stable' : 'Declining';
    const what = direction === 'Building'
      ? 'Your training load over the last 4 weeks has been increasing. Your body is adapting and getting fitter.'
      : direction === 'Stable'
        ? 'Your training load over the last 4 weeks has been consistent. Your body has a solid baseline to work from.'
        : 'Your training load has dropped compared to 4 weeks ago. Try to stay consistent, skipping sessions compounds quickly.';
    const whyItMatters = "Momentum isn't about today's recovery. It's about your body's capacity to handle training. A stable or rising baseline means your tendons, muscles, and aerobic system are conditioned for the work ahead.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300">${d.momentumArrow} ${direction}</div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px">${whyItMatters}</p>`;

  } else {
    title = 'Physiology'; subtitle = 'Sleep, HRV and resting heart rate';
    const recHasData = d.recoveryHasData ?? d.hasRecovery;
    if (!recHasData) {
      const isStale = d.recoveryDataStale;
      const lastSync = d.recoveryLastSyncDate;
      const daysAgo = lastSync
        ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 86400000)
        : null;
      const physSrc = getPhysiologySource(getState());
      const syncApp = physSrc === 'apple' ? 'the Health app' : 'Garmin Connect';
      const staleMsg = daysAgo != null
        ? `Recovery data hasn't updated in ${daysAgo} day${daysAgo === 1 ? '' : 's'} (last synced ${lastSync}).`
        : `Recovery data hasn't updated recently.`;
      body = `
        <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
          ${isStale ? `
            <p style="font-size:13px;color:var(--c-muted);margin-bottom:10px">${staleMsg}</p>
            <p style="font-size:13px;font-weight:500;color:var(--c-black)">Open ${syncApp} and sync your watch to update your recovery data.</p>
          ` : physSrc ? `
            <p style="font-size:13px;color:var(--c-muted)">No recovery data yet. Sleep and HRV data will appear after your next night of tracked sleep.</p>
          ` : `
            <p style="font-size:13px;color:var(--c-muted)">Connect a watch or recovery device to see your recovery data.</p>
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
        const metricZone = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
        const metricColor = score >= 80 ? 'var(--c-ok)' : score >= 65 ? 'var(--c-ok-muted)' : score >= 50 ? 'var(--c-caution)' : 'var(--c-warn)';
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
             <div style="display:flex;gap:10px">
               <button id="sleep-sync-btn" style="font-size:11px;color:var(--c-muted);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Sync</button>
               <button id="sleep-log-manual-btn" style="font-size:11px;color:var(--c-muted);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Log manually</button>
             </div>
           </div>`
        : hasManual
          ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
               <span style="font-size:11px;color:var(--c-muted)">Sleep logged manually</span>
               <button id="sleep-log-manual-btn" style="font-size:11px;color:var(--c-muted);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Edit</button>
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
              ? 'HRV trend and resting HR vs your 28-day baseline. Sleep not included. No data yet.'
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
  // "Sync" button. Pull fresh physiology from Garmin, then re-render home.
  overlay.querySelector('#sleep-sync-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    btn.textContent = 'Syncing…';
    btn.disabled = true;
    try {
      const { syncPhysiologySnapshot } = await import('@/data/physiologySync');
      await syncPhysiologySnapshot(7);
    } finally {
      close();
      renderHomeView();
    }
  });
  // "Log manually" button lives inside the sleep row. Wire it first so it can
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
type CompletedActivity = { name: string; distanceKm: number | null; durationMin: number | null; workoutKey?: string; adhocIdx?: number; weekNum: number };

/** Find a completed activity for today across garminActuals and adhocWorkouts.
 *  `todayISO` is the local calendar day; an activity is on it when its start's
 *  local day is (isOnLocalDay, the readiness ring's rule). */
function findTodayCompletedActivity(wk: Week, todayISO: string, s: SimulatorState): CompletedActivity | null {
  // 1. garminActuals. Matched to a plan slot (e.g. skiing → General Sport)
  for (const [key, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (!isOnLocalDay(actual.startTime, todayISO)) continue;
    const name = (actual.activityType ? formatActivityType(actual.activityType) : null)
      || actual.displayName || actual.workoutName || key;
    return {
      name,
      distanceKm: actual.distanceKm || null,
      durationMin: actual.durationSec ? Math.round(actual.durationSec / 60) : null,
      workoutKey: key,
      weekNum: s.w,
    };
  }

  // 2. adhocWorkouts. Unmatched activities logged as ad-hoc
  const adhocs = wk.adhocWorkouts || [];
  for (let i = 0; i < adhocs.length; i++) {
    const w = adhocs[i] as any;
    const ts: string | undefined = w.garminTimestamp;
    if (!isOnLocalDay(ts, todayISO)) continue;
    return {
      name: (w.activityType ? formatActivityType(w.activityType) : null) || w.workoutName || w.displayName || w.name || w.n || 'Workout',
      distanceKm: w.garminDistKm || w.distanceKm || null,
      durationMin: w.garminDurationMin || w.durationMin || null,
      adhocIdx: i,
      weekNum: s.w,
    };
  }

  return null;
}

/** Hero card for an ad-hoc / matched activity completed on a rest day */
function buildCompletedActivityHero(act: CompletedActivity, ourDay: number, s: SimulatorState): string {
  const metaItems = [
    act.durationMin ? { val: `${act.durationMin} min`, lbl: 'Duration' } : null,
    act.distanceKm ? { val: formatKm(act.distanceKm, s.unitPref ?? 'km'), lbl: 'Distance' } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.map((item, i) => `
    <div style="display:flex;flex-direction:column;gap:2px;flex:1;${i > 0 ? 'border-left:1px solid rgba(0,0,0,0.09);padding-left:14px' : ''}">
      <span style="font-size:16px;font-weight:400;letter-spacing:-0.02em">${item!.val}</span>
      <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">${item!.lbl}</span>
    </div>
  `).join('');

  const viewBtn = act.workoutKey
    ? `<button id="home-today-view-activity-btn" data-workout-key="${act.workoutKey}" data-week-num="${act.weekNum}" class="m-btn-glass m-btn-glass--inset" style="padding:6px 14px;font-size:12px">Done · View</button>`
    : `<span style="padding:6px 14px;border-radius:100px;border:1px solid var(--c-border);background:rgba(255,255,255,0.7);font-size:12px;font-weight:600;color:#64748B;font-family:var(--f)">Done</span>`;

  return `
    <div style="margin:0 16px 14px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.05),0 12px 32px rgba(0,0,0,0.06);position:relative;overflow:hidden" class="hf" data-delay="0.26">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.12)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(0,0,0,0.09)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(0,0,0,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(0,0,0,0.035)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
      </svg>
      <div style="position:relative;z-index:1;padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
          ${viewBtn}
        </div>
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em;margin-bottom:5px">${escapeAttr(act.name)}</div>
        <div style="display:flex;align-items:center;padding-top:14px;border-top:1px solid rgba(0,0,0,0.09)">
          ${metaHtml}
        </div>
      </div>
    </div>
  `;
}

export function buildTodayWorkout(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) {
    return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your training plan.', false);
  }

  // Canonical week resolution — the SAME list the Plan tab renders (mods via
  // findWorkoutForMod, moves, adhoc/holiday sessions, illness + holiday + bridge
  // scaling). Home must not re-derive a partial version of this or the Today
  // card and "Next:" line drift from the plan. See CLAUDE.md "same source" rule.
  const workouts = resolveWeekWorkouts(s, s.w);

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Find today's workout. Run or cross-training
  // Exclude slots already completed (have a garminActuals entry). They're done
  // and shouldn't reappear as today's workout if the slot was moved to a different day.
  const gActuals = wk.garminActuals ?? {};
  const active = workouts.filter((w: any) => {
    if (w.status === 'skip' || w.status === 'replaced') return false;
    const wid = w.id || w.n;
    if ((gActuals as any)[wid]) return false;
    return true;
  });
  let todayW = active.find((w: any) => w.dayOfWeek === ourDay) ?? null;

  if (!todayW || (todayW as any).t === 'rest' || (todayW as any).n?.toLowerCase().includes('rest')) {
    // No planned workout today. Check for completed ad-hoc/matched activities done today
    const todayISO = localDateKey(new Date());
    const todayActivity = findTodayCompletedActivity(wk, todayISO, s);
    if (todayActivity) {
      return buildCompletedActivityHero(todayActivity, ourDay, s);
    }
    return buildRestOrRaceDayHero(s);
  }

  // Strength = any gym / strength-typed session (running S&C, tri/cycling/HYROX
  // gym, injury-adapted, rehab), so the hero treats them the same and the Start
  // button routes to the guided strength experience rather than GPS tracking.
  // Type-based on purpose: a GPS run that merely has "strength" in its name must
  // NOT be pulled out of GPS tracking, so we don't use the name-matching helper.
  const isStrength = (todayW as any).t === 'gym' || (todayW as any).t === 'strength';
  const rawName = (todayW as any).n || 'Workout';
  const workoutId = (todayW as any).id || (todayW as any).n;
  const alreadyRated = wk.rated[workoutId] && wk.rated[workoutId] !== 'skip';

  // If matched to a real Strava/Garmin activity, use the actual activity name
  const matchedActual = (wk.garminActuals as any)?.[workoutId];
  const actualDisplayName = matchedActual?.activityType ? formatActivityType(matchedActual.activityType) : (matchedActual?.displayName || null);
  // For gym sessions, append "Gym Session" if not already in the name
  const planName = isStrength && !/(gym|strength)/i.test(rawName) ? `${rawName} Gym Session` : rawName;
  const name = actualDisplayName || planName;

  // Persisted simple-distance descs (adhoc objects, coach/auto reductions) gain
  // their type's pace at display time, mirroring the plan card. Skipped when an
  // effort-picker target pace exists on the session (that number is shown elsewhere).
  const rawDesc = (todayW as any).targetPaceSecKm
    ? ((todayW as any).d || '')
    : displayDescWithPace((todayW as any).d, (todayW as any).t, s.pac?.e);
  // When matched to a real activity, derive meta from the actual rather than the plan template
  const actualDistKm = matchedActual?.distanceKm ?? null;
  const actualDurationMin = matchedActual?.durationSec ? Math.round(matchedActual.durationSec / 60) : null;
  const distKm = actualDistKm ?? ((todayW as any).km || (todayW as any).distanceKm || null);
  const durationMin = actualDurationMin ?? ((todayW as any).dur || null);
  const rpe = (todayW as any).rpe || null;

  // For gym sessions: render exercises as an expandable list. Strip the internal
  // "@X% 1RM" load marker and the cue/rest parentheticals so the peek reads as a
  // clean session ("3x5 Back Squat"), not the raw template line — the only place
  // the marker used to leak to the user. Full detail is one tap away (Start →
  // the clean strength modal).
  const exercises = isStrength && rawDesc
    ? rawDesc.split('\n').filter(Boolean).map((ex: string) =>
        ex.replace(/\s*@\s*\d+%\s*1RM/gi, '').replace(/\s*\([^)]*\)/g, '').trim()
      ).filter(Boolean)
    : [];
  // Suppress planned description when real activity data is available. It would be wrong (e.g. "90min general sport" for Alpine Skiing)
  const desc = matchedActual ? '' : (isStrength ? '' : fmtDesc(rawDesc, s.unitPref ?? 'km'));

  const metaItems = [
    durationMin ? { val: `${actualDurationMin ? '' : '~'}${Math.round(durationMin)} min`, lbl: 'Duration' } : null,
    distKm ? { val: formatKm(typeof distKm === 'number' ? distKm : parseFloat(distKm), s.unitPref ?? 'km'), lbl: 'Distance' } : null,
    rpe && !matchedActual ? { val: `RPE ${rpe}`, lbl: 'Effort' } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.map((item, i) => `
    <div style="display:flex;flex-direction:column;gap:2px;flex:1;${i > 0 ? 'border-left:1px solid rgba(0,0,0,0.09);padding-left:14px' : ''}">
      <span style="font-size:16px;font-weight:400;letter-spacing:-0.02em">${item!.val}</span>
      <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">${item!.lbl}</span>
    </div>
  `).join('');

  const startBtn = !alreadyRated
    ? `<button id="home-start-btn" data-workout-id="${workoutId}" data-name="${name.replace(/"/g, '&quot;')}" data-raw-name="${rawName.replace(/"/g, '&quot;')}" data-desc="${rawDesc.replace(/"/g, '&quot;')}" data-type="${(todayW as any).t ?? ''}" data-rpe="${rpe ?? ''}" data-dur="${(todayW as any).estimatedDurationMin ?? ''}" data-strength="${isStrength ? '1' : ''}" style="background:var(--c-black);color:#fff;border:none;border-radius:100px;padding:9px 18px;font-size:13px;font-weight:600;font-family:var(--f);cursor:pointer;display:inline-flex;align-items:center;gap:6px;letter-spacing:0.01em">
        <span style="width:12px;height:12px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
        Start
      </button>`
    : matchedActual
      ? `<button id="home-today-view-activity-btn" data-workout-key="${workoutId}" data-week-num="${s.w}" class="m-btn-glass m-btn-glass--inset" style="padding:6px 14px;font-size:12px">Done · View</button>`
      : `<span style="padding:6px 14px;border-radius:100px;border:1px solid var(--c-border);background:rgba(255,255,255,0.7);font-size:12px;font-weight:600;color:#64748B;font-family:var(--f)">Done</span>`;

  // Coach workout modifier is intentionally NOT surfaced as a standalone note
  // here. The readiness-ring card directly below already carries the
  // take-it-lighter / consider-rest message via its driving-signal CTA, so a
  // floating pill in the gap between the cards was redundant double-messaging.
  // Plan view keeps its full-sentence note because it has no readiness sentence
  // on the same view.

  return `
    <div style="margin:0 16px 14px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.05),0 12px 32px rgba(0,0,0,0.06);position:relative;overflow:hidden" class="hf" data-delay="0.26">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.12)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(0,0,0,0.09)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(0,0,0,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(0,0,0,0.035)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
      </svg>
      <div style="position:relative;z-index:1;padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
          ${startBtn}
        </div>
        <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1.05;margin-bottom:5px">${name}</div>
        ${desc ? `<div style="font-size:11px;color:var(--c-muted);line-height:1.4;margin-bottom:16px">${desc}</div>` : ''}
        ${exercises.length > 0 ? `
        <details style="cursor:pointer;margin-bottom:16px">
          <summary style="list-style:none;font-size:12px;font-weight:600;letter-spacing:0.04em;color:var(--c-faint);text-transform:uppercase;display:flex;align-items:center;gap:6px">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="transition:transform 0.15s;flex-shrink:0"><path d="M2 3l3 4 3-4"/></svg>
            Exercises (${exercises.length})
          </summary>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
            ${exercises.map((ex: string) => `<div style="font-size:13px;color:var(--c-muted);line-height:1.4;padding-left:4px">• ${ex}</div>`).join('')}
          </div>
        </details>` : ''}
        <div style="display:flex;align-items:center;padding-top:14px;border-top:1px solid rgba(0,0,0,0.09)">
          ${metaHtml}
          <button id="home-view-plan-btn" style="margin-left:auto;padding-left:14px;border-left:1px solid rgba(0,0,0,0.09);white-space:nowrap;background:none;border-top:none;border-right:none;border-bottom:none;padding-top:0;padding-bottom:0;padding-right:0;font-size:12px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f);display:inline-flex;align-items:center;gap:3px">
            View
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Today's card when nothing is scheduled: on race day the race (race-day-card.ts:
 * display only, not a workout), else Rest Day. Every mode's Today builder
 * (buildTodayWorkout, buildTodayWorkoutTriathlon, buildTodayWorkoutHyrox).
 */
function buildRestOrRaceDayHero(s: SimulatorState): string {
  const race = raceDayToday(s);
  if (race) return buildNoWorkoutHero(escapeAttr(race.title), `Race day · ${escapeAttr(race.detail)}`, false, s, { faded: false });
  return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
}

function buildNoWorkoutHero(title: string, subtitle: string, isRest: boolean, s?: SimulatorState, opts: { faded?: boolean } = {}): string {
  const ourDay = jsToOurDay(new Date().getDay());
  // Find next upcoming workout
  let nextLabel = '';
  if (isRest && s) {
    const wk = s.wks?.[s.w - 1];
    if (wk) {
      // Mode-aware source. Triathlon and HYROX schedule into wk.triWorkouts (+
      // adhoc substitutes); only running uses the run generator. Reading the run
      // generator in tri/HYROX mode bled a "Sun: Long Run" into rest days.
      const isTriOrHyrox = s.eventType === 'triathlon' || s.eventType === 'hyrox';
      const workouts = isTriOrHyrox
        ? [...(wk.triWorkouts ?? []), ...(wk.adhocWorkouts ?? [])]
        // Running: canonical resolution shared with the Plan tab + Today card.
        : resolveWeekWorkouts(s, s.w);
      const gActuals = (wk.garminActuals ?? {}) as Record<string, unknown>;
      const upcoming = workouts
        .filter((w: any) => {
          if (w.dayOfWeek == null || w.dayOfWeek <= ourDay) return false;
          if (w.t === 'rest' || w.status === 'skip' || w.status === 'replaced') return false;
          // Already completed (matched to a real activity) — not "next".
          if (gActuals[w.id || w.n]) return false;
          return true;
        })
        .sort((a: any, b: any) => a.dayOfWeek - b.dayOfWeek);
      if (upcoming.length > 0) {
        const next = upcoming[0] as any;
        nextLabel = `Next: ${DAY_LABELS[next.dayOfWeek]}: ${next.n}${next.km ? ` ${formatKm(next.km, s.unitPref ?? 'km')}` : ''}`;
      }
    }
  }

  return `
    <div style="margin:0 16px 14px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.05),0 12px 32px rgba(0,0,0,0.06);position:relative;overflow:hidden" class="hf" data-delay="0.26">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>
        <circle cx="100" cy="100" r="60" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>
        <circle cx="100" cy="100" r="95" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="135" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
      </svg>
      <div style="position:relative;z-index:1;padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
        </div>
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em;opacity:${opts.faded === false ? '1' : '0.45'};margin-bottom:5px">${title}</div>
        <div style="font-size:11px;color:var(--c-muted);line-height:1.4;margin-bottom:16px">${subtitle}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:14px;border-top:1px solid rgba(0,0,0,0.09)">
          <span style="font-size:12px;color:var(--c-muted)">${nextLabel}</span>
          <button id="home-view-plan-btn" style="background:none;border:none;padding:0;font-size:12px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f);display:inline-flex;align-items:center;gap:3px">
            View plan
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}


function buildRecentActivity(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const prevWk = s.wks?.[s.w - 2];

  // Collect recent completed activities (garminActuals + adhoc from current + prev week)
  type ActivityRow = { name: string; sub: string; value: string; icon: 'run' | 'gym' | 'swim' | 'bike'; id: string; workoutKey?: string; weekNum?: number; unmatched?: boolean; adhocIdx?: number; sortKey: string };
  const rows: ActivityRow[] = [];

  function addFromWk(week: typeof wk, weekNum: number) {
    if (!week) return;
    const isCurrentWeek = weekNum === s.w;
    // garminActuals wins over adhocWorkouts when both have the same key.
    // garminActuals entries may have been Strava-upgraded and carry richer data (HR zones, polyline, correct sport name).
    const actualKeys = new Set(Object.keys(week.garminActuals || {}));
    Object.entries(week.garminActuals || {}).forEach(([key, act]: [string, any]) => {
      const isRun = isRunKey(key, act.activityType);
      const dateStr = act.startTime ? fmtDate(act.startTime) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = act.distanceKm ? formatKm(act.distanceKm, s.unitPref ?? 'km') : act.durationSec ? `${Math.round(act.durationSec / 60)} min` : '';
      // Canonical sport-aware name (respects manualSport override, drops a stale
      // "General Sport", falls back to the raw activity-type label). Shared with
      // the activity-detail page via resolveActivityDisplayName so the Recent row
      // and the detail it opens always read the same label.
      const keyFallback = key.replace(/^[Ww]\d+[-_]?/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const actName = resolveActivityDisplayName(act, keyFallback);
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: `garmin-${key}-${act.date || ''}`, workoutKey: key, weekNum, sortKey: act.startTime || act.date || '' });
    });
    // Adhoc workouts. Skip if garminActuals already covers this id (garminActuals has richer/Strava data)
    (week.adhocWorkouts || []).forEach((w: any, idx: number) => {
      if (w.id && actualKeys.has(w.id)) return;
      // Planned-but-not-done injected sessions (on-demand generated, holiday
      // replacements, benchmark check-ins) live on the Plan tab — as "Planned"
      // cards in track-only mode (buildTrackOnlyUpcoming) or as "Added" workout
      // cards in plan modes (resolveWeekWorkouts). Recent is a record of what
      // actually happened, so they only fall through once synced or marked done.
      // (Was track-only-gated; running plan mode leaked them as undated
      // "This week" rows — 2026-06-04 dogfood.)
      const wid = w.id || '';
      const isPlannedInjected = isPlannedAdhocId(wid);
      if (isPlannedInjected && !w.garminTimestamp && (week.rated?.[w.id]) == null) return;
      const dateStr = w.garminTimestamp ? fmtDate(w.garminTimestamp) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = (w.garminDistKm || w.distanceKm) ? formatKm(w.garminDistKm || w.distanceKm, s.unitPref ?? 'km') : w.garminDurationMin ? `${Math.round(w.garminDurationMin)} min` : w.durationMin ? `${Math.round(w.durationMin)} min` : '';
      const actName = (w.activityType ? formatActivityType(w.activityType) : null) || w.workoutName || w.displayName || w.name || w.n || 'Workout';
      rows.push({ name: actName, sub: dateStr, value: val, icon: 'gym', id: w.id || w.name, weekNum, adhocIdx: idx, sortKey: w.garminTimestamp || w.date || '' });
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
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: item.garminId, unmatched: true, weekNum, sortKey: item.startTime || '' });
    });
  }
  addPendingFromWk(wk, s.w);
  addPendingFromWk(prevWk, s.w - 1);

  // Final dedup: if two entries share the same underlying garminId (e.g., a plan-slot
  // and an adhoc both upgraded to the same 'strava-XXX'), keep only the better one.
  // "Better" = plan-slot (workoutKey not starting with 'garmin-') over adhoc/pending.
  // This fires at render time so it works even when state wasn't cleaned up yet.
  const seenGarminIds = new Map<string, number>(); // garminId → index in rows
  const dedupedRows: ActivityRow[] = [];
  for (const row of rows) {
    const weekData = row.weekNum != null ? s.wks?.[row.weekNum - 1] : undefined;
    const act: any = row.workoutKey ? weekData?.garminActuals?.[row.workoutKey] : undefined;
    const gid: string | undefined = act?.garminId ?? (row.unmatched ? row.id : undefined);
    if (gid) {
      const existingIdx = seenGarminIds.get(gid);
      if (existingIdx !== undefined) {
        // Replace existing with current if current is a better source (plan-slot beats adhoc)
        const existingIsAdhoc = dedupedRows[existingIdx].workoutKey?.startsWith('garmin-') || dedupedRows[existingIdx].adhocIdx !== undefined || dedupedRows[existingIdx].unmatched;
        const currentIsAdhoc = row.workoutKey?.startsWith('garmin-') || row.adhocIdx !== undefined || row.unmatched;
        if (!currentIsAdhoc && existingIsAdhoc) dedupedRows[existingIdx] = row;
        continue; // skip. Already represented
      }
      seenGarminIds.set(gid, dedupedRows.length);
    }
    dedupedRows.push(row);
  }

  // Sort all activities by date descending so the most recent always appears first
  dedupedRows.sort((a, b) => (b.sortKey > a.sortKey ? 1 : b.sortKey < a.sortKey ? -1 : 0));
  dedupedRows.splice(8); // cap at 8 rows

  if (dedupedRows.length === 0) return '';

  function iconSvg(type: ActivityRow['icon']): string {
    if (type === 'run') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4a1 1 0 100-2 1 1 0 000 2z" fill="var(--c-accent)" stroke="none"/><path d="M6.5 20l3-5.5 2.5 2 3.5-7 2.5 4.5"/></svg>`;
    if (type === 'gym') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`;
    if (type === 'swim') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1M3 12c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1"/></svg>`;
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`;
  }

  const rowsHtml = dedupedRows.map(r => {
    const isClickable = !!(r.workoutKey || r.unmatched || r.adhocIdx !== undefined);
    return `
    <div class="m-list-item${r.workoutKey ? ' home-act-row' : ''}${r.unmatched ? ' home-unmatched-row' : ''}${r.adhocIdx !== undefined ? ' home-adhoc-row' : ''}"
      data-activity-id="${r.id}"
      ${r.workoutKey ? `data-workout-key="${r.workoutKey}" data-week-num="${r.weekNum}"` : ''}
      ${r.unmatched ? `data-week-num="${r.weekNum}"` : ''}
      ${r.adhocIdx !== undefined ? `data-adhoc-idx="${r.adhocIdx}" data-week-num="${r.weekNum}"` : ''}
      style="cursor:${isClickable ? 'pointer' : 'default'}">
      <div style="width:34px;height:34px;border-radius:50%;background:${r.icon === 'run' ? 'rgba(78,159,229,0.08)' : 'rgba(0,0,0,0.05)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${iconSvg(r.icon)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:400;letter-spacing:-0.01em;margin-bottom:1px;display:flex;align-items:center;gap:6px">
          ${escapeAttr(r.name)}
          ${r.unmatched ? `<span style="font-size:9px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,0.12);color:#b45309">Unmatched</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--c-muted)">${r.sub}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${r.value}</span>
        ${isClickable ? `<span style="opacity:0.25"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>` : ''}
      </div>
    </div>
  `;
  }).join('');

  // Recent shows current + previous week activities, so the Review button must
  // surface whenever EITHER week has synced items. Otherwise on a Monday with
  // no fresh activity yet, the button hides even though last week's runs are
  // visible and re-matchable.
  const wkForReview = s.wks?.[s.w - 1];
  const prevWkForReview = s.wks?.[s.w - 2];
  const currentPending = wkForReview?.garminPending?.length ?? 0;
  const prevPending = prevWkForReview?.garminPending?.length ?? 0;
  // Synced actuals are re-reviewable even after a sync consumed the pending
  // records (openActivityReReview reconstitutes them) — keep the Review entry
  // point available so a placement can always be changed.
  const hasSyncedActuals = (week: typeof wkForReview): boolean =>
    Object.values(week?.garminActuals ?? {}).some((a: any) => a?.garminId && !String(a.garminId).startsWith('guided-'));
  const hasReviewable = currentPending > 0 || prevPending > 0 || hasSyncedActuals(wkForReview) || hasSyncedActuals(prevWkForReview);

  return `
    <div style="padding:0 16px;margin-bottom:14px" class="hf" data-delay="0.32">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:12px;font-weight:600;color:#64748B">Recent</div>
        ${hasReviewable ? `<button id="home-tri-review-btn" style="font-size:11px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0;font-family:var(--f);font-weight:500">Review →</button>` : ''}
      </div>
      <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);overflow:hidden">${rowsHtml}</div>
    </div>
  `;
}

function buildSyncActions(s: SimulatorState): string {
  const hasPending = (s as any).pendingActivities?.length > 0;
  if (!hasPending) return '';

  return `
    <div style="padding:0 16px;margin-bottom:14px;display:flex;gap:10px">
      <button id="home-sync-btn" class="m-btn-glass flex-1">↻ Sync Activities</button>
    </div>
  `;
}

// ─── Main render ────────────────────────────────────────────────────────────

function getHomePlanName(s: SimulatorState): string {
  if (s.eventType === 'hyrox') {
    const fmt = s.hyroxConfig?.format ?? 'open_singles';
    const fmtLabel = fmt.includes('doubles') ? 'Doubles' : fmt.includes('pro') ? 'Pro' : 'Open';
    const raceDate = s.hyroxConfig?.raceDate ?? s.onboarding?.customRaceDate;
    if (raceDate) {
      const d = new Date(raceDate);
      const month = d.toLocaleString('en-US', { month: 'short' });
      return `HYROX ${fmtLabel} · ${month} ${d.getFullYear()}`;
    }
    return `HYROX ${fmtLabel}`;
  }
  if (s.eventType === 'triathlon') {
    const cycling = getCyclingEventLabel(s);
    if (cycling) return cycling;
    const distLabel = getTriDistanceLabel(s.triConfig?.distance ?? '70.3');
    const city = getTriathlonById(s.onboarding?.selectedTriathlonId ?? '')?.city;
    return city ? `${city} ${distLabel}` : distLabel;
  }
  if (s.continuousMode) {
    const focus = s.onboarding?.trainingFocus;
    if (focus === 'speed') return 'Speed Plan';
    if (focus === 'endurance') return 'Endurance Plan';
    if (focus === 'both') return 'Training Plan';
    return 'Fitness Plan';
  }
  const labels: Record<string, string> = {
    '5k': '5K Plan', '10k': '10K Plan',
    half: 'Half Marathon Plan', marathon: 'Marathon Plan',
  };
  return labels[s.rd] || 'Training Plan';
}

/**
 * Just-Track mode home layout. Activity tracking only, no plan.
 * Hides: today-workout, readiness/strain rings, race-forecast, week progress ring.
 * Shows: header + account button, weekly volume from `historicWeeklyKm`,
 * recent synced activities (from historicWeeklyKm derived rows only. S.wks is empty).
 *
 * Data sources used (all independent of s.wks):
 *  - `s.historicWeeklyKm` : last 8 weeks running km (populated by stravaSync.ts)
 *  - `s.physiologyHistory`: last-night sleep / HRV / RHR (populated by physiologySync.ts)
 *  - Account button, tab bar and sync actions reuse the same builders as the full home.
 */
/**
 * Just-Track week detail page. Opened from the home "This Week" card.
 *
 * Same visual shape as Load & Taper (hero ring + sport breakdown + activity
 * list + TSS band reference card), but without plan-target language:
 *   - Ring shows actual TSS only (no "/ target")
 *   - No phase badge
 *   - No "Running planned / Cross-training expected" rows
 *   - Sport breakdown is actual-only
 *
 * Sport breakdown reuses `computeLoadBreakdown` which walks the current
 * week's `garminActuals` + `adhocWorkouts` and groups by sport label.
 */
export function renderTrackOnlyWeekDetail(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const wk = s.wks?.[(s.w ?? 1) - 1];
  const tss = wk ? Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate)) : 0;
  const segments = wk ? computeLoadBreakdown(wk, wk.rated ?? {}, s.planStartDate) : [];
  const sportCount = segments.filter(seg => !seg.doubleDay).length;
  const unit: 'km' | 'mi' = s.unitPref ?? 'km';

  // Activity rows from current week (same dedup as buildRecentActivity).
  type Row = { day: string; name: string; value: string; color: string; tss: number };
  const rows: Row[] = [];
  const actualKeys = new Set<string>();
  for (const [key, actual] of Object.entries(wk?.garminActuals ?? {})) {
    actualKeys.add(key);
    const d = actual.startTime ? new Date(actual.startTime) : null;
    const dayLabel = d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : '—';
    const isRun = !(actual as any).displayName || !!(actual as any).workoutName;
    const name = (actual as any).displayName || (actual as any).workoutName
      || (actual.activityType ? formatActivityType(actual.activityType) : 'Activity');
    const val = actual.distanceKm ? formatKm(actual.distanceKm, unit)
              : actual.durationSec ? `${Math.round(actual.durationSec / 60)} min` : '';
    const color = isRun ? '#3b82f6' : sportColor(name.toLowerCase());
    const rowTSS = actual.iTrimp != null && actual.iTrimp > 0
      ? Math.round(normalizeiTrimp(actual.iTrimp))
      : Math.round((actual.durationSec / 60) * 0.92);
    rows.push({ day: dayLabel, name, value: val, color, tss: rowTSS });
  }
  for (const w of (wk?.adhocWorkouts ?? []) as any[]) {
    if (w.id && actualKeys.has(w.id)) continue;
    const ts = w.garminTimestamp;
    const d = ts ? new Date(ts) : null;
    const dayLabel = d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : '—';
    const name = w.activityType ? formatActivityType(w.activityType) : (w.n || 'Workout');
    const dist = w.garminDistKm ?? w.distanceKm;
    const val = typeof dist === 'number' ? formatKm(dist, unit)
              : w.durationMin ? `${Math.round(w.durationMin)} min` : '';
    rows.push({ day: dayLabel, name, value: val, color: sportColor(name.toLowerCase()), tss: 0 });
  }
  rows.reverse();

  const segBlock = segments.length === 0
    ? `<div style="padding:16px;text-align:center;font-size:13px;color:var(--c-muted)">No activities logged yet this week</div>`
    : segments.map(seg => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid rgba(0,0,0,0.05)">
          <div style="width:10px;height:10px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>
          <span style="flex:1;font-size:14px;color:#0F172A">${seg.label}</span>
          ${seg.doubleDay ? '' : `<span style="font-size:11px;color:#94A3B8">${Math.round(seg.durationMin)} min</span>`}
          <span style="font-size:13px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums;min-width:54px;text-align:right">${Math.round(seg.tss)} TSS</span>
        </div>`).join('');

  const rowsBlock = rows.length === 0 ? '' : `
    <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);overflow:hidden;margin-top:14px">
      <div style="padding:12px 16px;font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94A3B8">Activities</div>
      ${rows.map(r => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid rgba(0,0,0,0.05)">
          <div style="min-width:54px;font-size:11px;color:#64748B">${r.day}</div>
          <div style="flex:1;font-size:14px;color:#0F172A">${escapeAttr(r.name)}</div>
          <div style="font-size:13px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${r.value}</div>
        </div>`).join('')}
    </div>`;

  container.innerHTML = `
    <div style="min-height:100vh;background:#FAF9F6;position:relative;overflow-x:hidden">
      <div style="position:absolute;inset:0;background:linear-gradient(180deg, #C5DFF8 0%, #E3F0FA 15%, #F0F7FC 35%, #F5F8FB 55%, #FAF9F6 80%);pointer-events:none"></div>
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding:56px 16px 120px">

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
          <button id="tow-back" style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:#334155">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="text-align:center">
            <div style="font-size:15px;font-weight:600;color:#0F172A">This week</div>
            <div style="font-size:11px;color:#64748B;margin-top:2px">${wk ? weekRangeFmtLocal(s.planStartDate, s.w ?? 1) : '—'}</div>
          </div>
          <div style="width:36px"></div>
        </div>

        <div style="text-align:center;margin:20px 0 28px">
          <div style="width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,0.08);margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center">
            <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums">${tss}</div>
            <div style="font-size:12px;color:#64748B;margin-top:4px;letter-spacing:0.06em">TSS THIS WEEK</div>
          </div>
        </div>

        <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);overflow:hidden">
          <div style="padding:14px 16px;display:flex;align-items:baseline;justify-content:space-between">
            <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94A3B8">By sport</div>
            <div style="font-size:11px;color:#64748B">${sportCount} ${sportCount === 1 ? 'sport' : 'sports'}</div>
          </div>
          ${segBlock}
        </div>

        ${rowsBlock}

        <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:16px;margin-top:14px">
          <div style="font-size:14px;font-weight:600;color:#0F172A;margin-bottom:4px">Training Stress Score</div>
          <div style="font-size:12px;color:#475569;line-height:1.5;margin-bottom:12px">TSS combines duration and intensity into a single weekly number. A 45-min easy run scores around 40. A 90-min long run at marathon pace is closer to 120.</div>
          <div style="font-size:11px;font-weight:600;color:#94A3B8;margin-bottom:4px">Weekly total</div>
          <div style="font-size:12px;color:#475569;line-height:1.9">
            <div style="display:flex;justify-content:space-between"><span>Under 150</span><span style="color:#94A3B8">Recovery or base maintenance</span></div>
            <div style="display:flex;justify-content:space-between"><span>150–350</span><span style="color:#94A3B8">Productive training for most runners</span></div>
            <div style="display:flex;justify-content:space-between"><span>350–500</span><span style="color:#94A3B8">High load. Recovery needs careful management</span></div>
            <div style="display:flex;justify-content:space-between"><span>500+</span><span style="color:#94A3B8">Elite volume. Injury risk rises if sustained</span></div>
          </div>
        </div>

      </div>
    </div>`;

  document.getElementById('tow-back')?.addEventListener('click', () => renderHomeView());
}

function weekRangeFmtLocal(planStartIso: string | undefined, weekNum: number): string {
  if (!planStartIso) return '';
  const start = new Date(planStartIso);
  start.setDate(start.getDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * "This Week" summary card for Just-Track home. Actuals only. No targets,
 * no progress bars. Sessions / Distance / Training Load. Tap → Stats tab
 * where the Progress detail page can be opened for deeper drill-down.
 */
function buildTrackOnlyThisWeek(s: SimulatorState): string {
  const unit: 'km' | 'mi' = s.unitPref ?? 'km';
  const wk = s.wks?.[(s.w ?? 1) - 1];

  let sessions = 0, km = 0, tss = 0;
  if (wk) {
    const seen = new Set<string>();
    const actualKeys = new Set<string>();
    for (const [key, act] of Object.entries(wk.garminActuals ?? {})) {
      const id = (act as any)?.garminId || key;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      actualKeys.add(key);
      sessions++;
      if (typeof act.distanceKm === 'number' && act.distanceKm > 0) km += act.distanceKm;
    }
    for (const w of (wk.adhocWorkouts ?? []) as any[]) {
      if (w.id && actualKeys.has(w.id)) continue;
      if (w.id?.startsWith('garmin-') || w.id?.startsWith('strava-')) {
        if (!seen.has(w.id)) { sessions++; seen.add(w.id); }
      } else if (wk.rated?.[w.id] && wk.rated[w.id] !== 'skip') {
        sessions++;
      }
      const d = w.garminDistKm ?? w.distanceKm;
      if (typeof d === 'number' && d > 0) km += d;
    }
    tss = Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate));
  }

  const row = (label: string, value: string) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:13px;color:#64748B">${label}</span>
      <span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${value}</span>
    </div>`;
  const rowLast = (label: string, value: string) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0">
      <span style="font-size:13px;color:#64748B">${label}</span>
      <span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${value}</span>
    </div>`;

  return `
    <div id="home-this-week-card" style="padding:0 16px;margin-top:14px;margin-bottom:14px;cursor:pointer" class="hf" data-delay="0.14">
      <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:16px 18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94A3B8">This week</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
        ${row('Sessions', String(sessions))}
        ${row('Distance', formatKm(km, unit))}
        ${rowLast('Training Load', `${tss} TSS`)}
      </div>
    </div>`;
}

/**
 * Compact weekly-TSS sparkline for the Just-Track home.
 *
 * Series is sourced from `s.wks` only (weeks since trackOnly was set up),
 * NOT `historicWeeklyTSS` (which carries Strava backfill from prior plan
 * usage and looks like "fake" data on a fresh tracking programme). As the
 * calendar advances and activities sync into new weeks, the chart fills in
 * organically. Returns '' when fewer than 2 weeks with non-zero TSS. One
 * data point can't draw a line.
 */
function buildTrackOnlyLoadSpark(s: SimulatorState): string {
  const wks = s.wks ?? [];
  const series = wks.map(w => Math.round(computeWeekRawTSS(w, w.rated ?? {}, s.planStartDate)));
  const currentTSS = series[series.length - 1] ?? 0;
  if (series.length < 2 || series.every(t => !t || t === 0)) return '';

  // Build smoothed area path. Same recipe as stats-view.buildVO2LineChart.
  const W = 320, H = 60;
  const maxVal = Math.max(...series, 1) * 1.1;
  const xOf = (i: number) => (i / (series.length - 1)) * W;
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));
  const pts: [number, number][] = series.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
  const areaPath = `${topPath} L ${W} ${H} L 0 ${H} Z`;

  // Colour based on week-over-week trend: rising = blue (more training),
  // flat/falling = muted grey. Neutral since load ↑ isn't inherently good.
  const prev = series[series.length - 2];
  const rising = currentTSS > prev + 5;
  const strokeColor = rising ? 'rgba(58,96,144,0.85)' : 'rgba(71,85,105,0.70)';
  const gradId = `loadFill_${rising ? 'up' : 'flat'}`;

  return `
    <div id="home-load-spark" style="padding:0 16px;margin-top:14px;margin-bottom:14px;cursor:pointer" class="hf" data-delay="0.16">
      <div style="background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:14px 16px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.04em;text-transform:uppercase">Load over time</div>
          <div style="font-size:13px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${currentTSS} <span style="color:#94A3B8;font-weight:500">TSS this week</span></div>
        </div>
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="72" preserveAspectRatio="none" style="display:block">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.22"/>
              <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.04"/>
            </linearGradient>
          </defs>
          <path d="${areaPath}" fill="url(#${gradId})"/>
          <path d="${topPath}" fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:#94A3B8">
          <span>${series.length} wk ago</span>
          <span style="color:#0F172A;font-weight:600">This week</span>
        </div>
      </div>
    </div>`;
}

function getTrackOnlyHomeHTML(s: SimulatorState, animate: boolean): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');
  const userName = s.onboarding?.name || null;
  const heroTitle = userName ? `${userName}'s activity` : 'Your activity';

  // First-launch orientation: true when the user has no sync history, no watch
  // data, and no locally-recorded activities. We show a single explanatory
  // line beneath the hero instead of five empty cards with different wording.
  const hasCtl = (s.ctlBaseline ?? 0) > 0;
  const hasWatch = !!getPhysiologySource(s);
  const hasRecentActivity = (s.wks ?? []).some(w =>
    Object.keys(w.garminActuals ?? {}).length > 0 || (w.adhocWorkouts ?? []).length > 0,
  );
  const isFirstLaunch = !hasCtl && !hasWatch && !hasRecentActivity;
  const heroSubcopy = isFirstLaunch
    ? 'Connect Strava or record your first run to start seeing data.'
    : 'Sessions on demand.';

  return `
    <style>
      @keyframes floatUp {
        from { opacity:0; }
        to   { opacity:1; }
      }
      .hf { ${animate ? 'opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative">
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:0">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, #C5DFF8 0%, #E3F0FA 15%, #F0F7FC 35%, #F5F8FB 55%, #FAF9F6 80%)"></div>
        <svg style="position:absolute;top:0;left:0;width:100%;height:600px" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="tmBlur"><feGaussianBlur stdDeviation="20"/></filter>
            <filter id="tmSoft"><feGaussianBlur stdDeviation="6"/></filter>
          </defs>
          <ellipse cx="200" cy="100" rx="100" ry="70" fill="rgba(255,255,255,0.5)" filter="url(#tmSoft)" opacity="0.6"/>
          <ellipse cx="80" cy="180" rx="60" ry="25" fill="white" filter="url(#tmBlur)" opacity="0.35"/>
          <ellipse cx="340" cy="160" rx="50" ry="20" fill="white" filter="url(#tmBlur)" opacity="0.25"/>
          <path d="M-40,280 Q60,240 150,265 T320,245 T440,270 L440,600 L-40,600 Z" fill="rgba(255,255,255,0.25)" filter="url(#tmSoft)"/>
        </svg>
      </div>
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto">

      <!-- Header: Tracking pill + account button (no race countdown in track-only) -->
      <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between;gap:8px" class="hf" data-delay="0.02">
        <span style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748B;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);border:1px solid rgba(0,0,0,0.06);padding:4px 10px;border-radius:100px">On demand</span>
        <button id="home-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
      </div>

      <!-- Hero -->
      <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 10px">
        <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1">${heroTitle}</div>
        <div style="font-size:14px;font-weight:500;color:#64748B;margin-top:8px">${heroSubcopy}</div>
      </div>

      <!-- Primary action: generate a session. On-demand mode has no plan, so this is
           the main thing the user does here. Whole-card tap target. No accent fill
           (in-page action, not a form submit), per the colour rules. -->
      <div style="padding:0 16px;margin-top:18px;margin-bottom:14px" class="hf" data-delay="0.08">
        <button id="home-generate-session" style="display:block;width:100%;text-align:left;background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px;cursor:pointer;font-family:inherit">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div>
              <div style="font-size:16px;font-weight:700;color:#0F172A;letter-spacing:-0.01em;margin-bottom:4px">Generate a session</div>
              <div style="font-size:13px;color:#64748B;line-height:1.45">Run, bike, swim or gym. We read your recovery and size it to today.</div>
            </div>
            <span style="font-size:20px;color:#94A3B8;flex:0 0 auto">&rarr;</span>
          </div>
        </button>
      </div>

      <!-- Sessions (To-do) live on the Plan tab now, not duplicated here. TSS lives
           inside the Readiness ring (Strain), so the standalone "Today's load" card
           was removed as redundant. Home is recovery-led: Generate + Readiness. -->
      ${buildReadinessRing(s)}

      <!-- Sleep logging affordance: readiness ring only reflects watch/manual sleep,
           so expose the manual picker here for users who want to log subjectively. -->
      <div style="padding:0 16px;margin:-6px 0 4px;text-align:center" class="hf" data-delay="0.13">
        <button id="home-log-sleep-link" style="font-size:12px;color:#64748B;background:none;border:none;cursor:pointer;padding:4px 8px;text-decoration:underline">Log sleep</button>
      </div>

      <!-- "This week" lives on the Plan/Sessions tab now (was duplicated here). The
           load sparkline stays as a quick trend glance (taps through to Stats). -->
      ${buildTrackOnlyLoadSpark(s)}

      ${buildSyncActions(s)}
      ${buildRecentActivity(s)}

      <!-- Plan-creation is not surfaced here. On-demand is a first-class mode, not a
           funnel step, and switching to a plan resets the app, so it lives in
           Account → Settings behind a reset warning rather than as a home CTA. -->

      </div>
    </div>
    ${renderTabBar('home', isSimulatorMode())}
  `;
}

function getHomeHTML(s: SimulatorState, animate: boolean): string {
  // Just-Track mode: activity tracking only, no plan. Short-circuit to a minimal
  // layout that hides today-workout, readiness/strain rings, race-forecast, and
  // week progress. All of which assume a generated plan.
  if (s.trackOnly) return getTrackOnlyHomeHTML(s, animate);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const userName = s.onboarding?.name || null;
  const planTitle = userName ? `${userName}'s ${getHomePlanName(s)}` : `Your ${getHomePlanName(s)}`;

  // Race countdown for hero header. Tri users never read selectedMarathon —
  // that's a marathon-mode artifact. Use the user's entered race date only.
  const isTri = s.eventType === 'triathlon';
  const isHyrox = s.eventType === 'hyrox';
  const raceDate = isHyrox ? (s.hyroxConfig?.raceDate ?? s.onboarding?.customRaceDate)
    : isTri ? (s.triConfig?.raceDate || s.onboarding?.customRaceDate)
    : (s.selectedMarathon?.date || s.onboarding?.customRaceDate);
  const raceName = (isTri || isHyrox) ? null : (s.selectedMarathon?.name || null);
  const raceDays = raceDate && !s.continuousMode ? daysUntil(raceDate) : 0;
  const hasRaceCountdown = raceDays > 0;
  const raceCountdownDisplay = raceDays <= 14 ? `${raceDays}` : `${Math.floor(raceDays / 7)}`;
  const raceCountdownUnit = raceDays <= 14 ? 'days' : 'weeks';

  // Phase label
  const phase = s.wks?.[s.w - 1]?.ph;
  const phaseLabel = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : '';


  return `
    <style>
      @keyframes floatUp {
        from { opacity:0; }
        to   { opacity:1; }
      }
      .hf { ${animate ? 'opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
      @keyframes barGrow { from { width:0% } }
      .m-prog-fill { ${animate ? 'animation:barGrow 0.8s cubic-bezier(0.2,0.8,0.2,1) forwards;' : ''} }
      /* 0s + forwards jumps the arc straight to its drawn end state on revisits */
      .arc-anim { animation:arcSweep ${animate ? '1s cubic-bezier(0.2,0.8,0.2,1)' : '0s linear'} forwards; }
      @keyframes arcSweep { to { stroke-dashoffset:0 } }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative">
      <!-- Continuous scroll-page atmosphere. Softer "sky" palette + halo shifted
           upper-right so it balances the upper-left sun glint. Differentiates
           home from readiness (which uses the tighter centred halo). -->
      ${buildScrollAtmosphereBackground('hm', 'sky', { haloCenter: { cx: 320, cy: 200 } })}
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto">

      <!-- Header bar: profile + race countdown -->
      <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
        ${hasRaceCountdown ? `
          <div style="display:flex;align-items:baseline;gap:3px;padding:4px 12px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)">
            <span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0F172A;line-height:1">${raceCountdownDisplay}</span>
            <span style="font-size:11px;font-weight:500;color:#64748B">${raceCountdownUnit}</span>
          </div>
        ` : ''}
        <button id="home-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
      </div>

      <!-- Hero: title + phase + date: centered, matching Plan page -->
      <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 10px">
        <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1">${planTitle}</div>
        ${phaseLabel ? `<div style="font-size:17px;font-weight:700;color:#0F172A;margin-top:10px;letter-spacing:-0.01em">${phaseLabel}</div>` : ''}
        ${s.w && s.tw ? `<div style="font-size:14px;font-weight:500;color:#64748B;margin-top:4px">${s.w > s.tw ? 'Plan complete' : `Week ${s.w} of ${s.tw}`}</div>` : ''}
        ${hasRaceCountdown && raceName ? `<div style="font-size:13px;font-weight:500;color:#94A3B8;margin-top:4px">${raceName}</div>` : ''}

        <!-- Action buttons -->
        <div style="display:flex;justify-content:center;gap:8px;margin-top:18px">
          ${AI_COACH_ENABLED ? `<button id="home-coach-btn" class="m-btn-glass">Coach</button>` : ''}
          <button id="home-checkin-btn" class="m-btn-glass">Check-in</button>
          <button id="home-record-btn" class="m-btn-glass">Record</button>
        </div>
      </div>

      ${buildIllnessBanner(s)}
      ${buildHolidayBannerHome(s)}
      ${buildRaceCompleteBanner(s)}
      ${buildGuestAccountBanner(s)}
      ${buildEnrichPromptBanner(s)}
      ${s.eventType === 'triathlon' ? buildTriCarryBanner(s) : ''}
      ${s.eventType === 'hyrox' ? buildTodayWorkoutHyrox(s) : s.eventType === 'triathlon' ? buildTodayWorkoutTriathlon(s) : buildTodayWorkout(s)}
      ${buildReadinessRing(s)}
      ${buildSyncActions(s)}
      ${buildRecentActivity(s)}

      </div>
    </div>
    ${renderTabBar('home', isSimulatorMode())}
  `;
}

/**
 * Carry-over banner: shows when the user clicked "Push to next week" on a
 * exponentially (7-day τ). Banner displays the current decayed value so
 * exponentially (7-day τ): banner displays the current decayed value so
 * it shrinks visibly over the days following the push and disappears after
 * ~3 weeks.
 */
function buildTriCarryBanner(s: SimulatorState): string {
  const decayed = computeDecayedTriCarry(s);
  if (decayed < 5) return ''; // hide trivial residuals
  return `
    <div style="margin:10px 16px 0;padding:11px 14px;border-radius:10px;
      background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25);
      display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-size:12px;line-height:1.4;color:#0F172A">
        <strong>${Math.round(decayed)} TSS</strong> carried over from cross-training pushed to this week.
        <span style="color:var(--c-muted)">Decays over ~5 days.</span>
      </div>
    </div>
  `;
}

/**
 * One session rendered as a self-contained glass card in the running
 * today-workout language (glass + faint ring + thin title + muted footer link).
 * Each session is its own card with clear air between them, so a two-a-day
 * reads as separate, distinct cards rather than a merged block. Keeps the
 * `tri-hero-card` / `hx-hero-card` class + `data-*-workout-id` so the existing
 * tap handlers (open the detail modal) fire unchanged. `isFirst` carries the
 * one "DAY · Today" eyebrow so it appears once, on the top card.
 */
function buildHeroSessionCard(opts: {
  cls: 'tri-hero-card' | 'hx-hero-card';
  idAttr: string;
  id: string;
  label: string;
  badgeBg: string;
  badgeText: string;
  duration: string;
  title: string;
  body: string;
  metaRight: string; // e.g. "RPE 4 · TSS 20"
  extra?: string;    // optional brick line etc.
  isFirst: boolean;
  ourDay: number;
}): string {
  const eyebrow = opts.isFirst
    ? `<div style="margin-bottom:12px"><span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint)">${DAY_LABELS[opts.ourDay]} · Today</span></div>`
    : '';
  return `
    <div ${opts.idAttr}="${escapeAttr(opts.id)}" class="${opts.cls} hf" style="margin:0 16px 14px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.05),0 12px 32px rgba(0,0,0,0.06);position:relative;overflow:hidden;cursor:pointer">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.12)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(0,0,0,0.09)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(0,0,0,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(0,0,0,0.035)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(0,0,0,0.06)" stroke-width="0.8"/>
      </svg>
      <div style="position:relative;z-index:1;padding:20px 22px">
        ${eyebrow}
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="display:inline-flex;align-items:center;background:${opts.badgeBg};color:${opts.badgeText};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:100px">${opts.label}</span>
          <span style="flex:1"></span>
          ${opts.duration ? `<span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${opts.duration}</span>` : ''}
        </div>
        <div style="font-size:24px;font-weight:300;color:var(--c-black);letter-spacing:-0.035em;line-height:1.05;margin-bottom:5px">${opts.title}</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">${opts.body}</div>
        ${opts.extra ?? ''}
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.09);display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">${opts.metaRight}</span>
          <span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:var(--c-muted)">
            Breakdown
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Triathlon: today's planned workouts rendered in the running today-workout
 * hero language. Two-a-days (e.g. AM swim + PM bike) render as separate glass
 * cards with clear air between them. Tap a session to drill in.
 */
export function buildTodayWorkoutTriathlon(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your triathlon plan.', false);

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Canonical resolver — the SAME list the tri Plan tab renders, so illness,
  // holiday and bridge mods reach the Home card too (persona-QA P09: reading
  // wk.triWorkouts raw showed the full plan during an active illness while the
  // Plan tab correctly showed rested sessions). Same-source rule, CLAUDE.md.
  //
  // Exclusions mirror the running card (buildTodayWorkout) and planned-day-tss:
  //  - synced actuals (garmin-/strava- adhocs, garminTimestamp) are HISTORY —
  //    without this filter an injured user's logged walk/ride/gym activities
  //    rendered as planned sessions (and, lacking `discipline`, badged "Run":
  //    the 2026-07-26 "3 runs today while injured" report)
  //  - completed slots: the tri matcher day-shifts a completed slot onto the
  //    day its activity actually happened (reconcile step 4), so without this
  //    filter completed sessions pile onto today next to their adhoc twins
  //  - illness/holiday-rested sessions: markRest/restAway set rpe 0 + a marker
  //    (same rested guard planned-day-tss applies)
  const gActuals = wk.garminActuals ?? {};
  const todayList = resolveTriWeekWorkouts(s, s.w).filter((w: any) => {
    if (w.dayOfWeek !== ourDay) return false;
    const id: string = w.id ?? w.n ?? '';
    if (w.garminTimestamp || id.startsWith('garmin-') || id.startsWith('strava-')) return false;
    if (w.status === 'completed' || w.status === 'skipped' || w.status === 'replaced') return false;
    if ((gActuals as any)[id]) return false;
    const rested = w.illnessSeverity === 'resting'
      || ((w.illnessMod || w.holidayMod) && (w.rpe ?? w.r) === 0);
    if (rested) return false;
    return true;
  });
  if (todayList.length === 0) {
    return buildRestOrRaceDayHero(s);
  }

  return todayList.map((w, i) => buildTriathlonSessionBlock(w, i === 0, ourDay)).join('');
}

/**
 * Session kind for the Today-card badge. `discipline` wins when present;
 * otherwise the type string is sniffed (swim_/bike_/run tokens, gym/strength,
 * cross). Unknown types fall back to 'cross', NOT 'run' — synced actuals and
 * injury substitutes carry no discipline, and defaulting them to "Run" showed
 * an injured athlete three "Run" badges for non-run activities.
 */
export function triSessionKind(w: any): 'swim' | 'bike' | 'run' | 'strength' | 'cross' {
  if (w.discipline === 'swim' || w.discipline === 'bike' || w.discipline === 'run') return w.discipline;
  if (w.discipline === 'strength') return 'strength';
  const t: string = (w.t ?? '').toLowerCase();
  if (t === 'gym' || t === 'strength' || /strength|gym/i.test(w.n || '')) return 'strength';
  if (t.startsWith('swim')) return 'swim';
  if (t.startsWith('bike') || t === 'brick') return 'bike';
  if (t.startsWith('run') || t === 'easy' || t === 'long' || t === 'threshold' || t === 'vo2' || t === 'return_run') return 'run';
  return 'cross';
}

function buildTriathlonSessionBlock(w: any, isFirst: boolean, ourDay: number): string {
  const kind = triSessionKind(w);
  const badgeBg = kind === 'swim' ? 'rgba(91,138,138,0.14)' : kind === 'bike' ? 'rgba(192,132,96,0.14)' : kind === 'run' ? 'rgba(122,132,92,0.14)' : 'rgba(100,100,110,0.14)';
  const badgeText = kind === 'swim' ? '#3d6666' : kind === 'bike' ? '#9c6245' : kind === 'run' ? '#4f5a3b' : '#4a4a55';
  const label = kind === 'swim' ? 'Swim' : kind === 'bike' ? 'Bike' : kind === 'run' ? 'Run' : kind === 'cross' ? 'Cross' : 'Strength';
  const rpe = w.rpe ?? w.r ?? 5;
  const tss = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  // Strength sessions show a "N exercises · tap to view" summary, not the raw
  // exercise list (which reads as a run-on paragraph). Shared helper keeps the
  // count + wording identical to the plan cards.
  const strengthSummary = strengthCardSummary(w);
  const desc = humaniseTriDesc(w.d || '');
  const duration = extractTriWorkoutDuration(w);
  const isBrick = w.t === 'brick' && w.brickSegments;
  const metaRight = `RPE ${rpe}${tss > 0 ? ` · TSS ${Math.round(tss)}` : ''}`;
  const extra = isBrick
    ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(0,0,0,0.06);font-size:11px;color:var(--c-faint)">Brick, bike ${w.brickSegments[0].durationMin ?? 0}m + run ${w.brickSegments[1].durationMin ?? 0}m</div>`
    : '';

  return buildHeroSessionCard({
    cls: 'tri-hero-card',
    idAttr: 'data-tri-workout-id',
    id: w.id || w.n,
    label, badgeBg, badgeText, duration,
    title: escapeAttr(w.n),
    body: strengthSummary ?? escapeAttr(desc),
    metaRight, extra, isFirst, ourDay,
  });
}

// ─── HYROX today's workout ────────────────────────────────────────────────────

export function buildTodayWorkoutHyrox(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your HYROX plan.', false);

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Include adhoc sessions (injury-safe substitutes: bike / safe strength) so
  // today's suggestions show on the home card, not just `triWorkouts`.
  const todayList = [...(wk.triWorkouts ?? []), ...(wk.adhocWorkouts ?? [])].filter((w: any) => w.dayOfWeek === ourDay);
  if (todayList.length === 0) {
    return buildRestOrRaceDayHero(s);
  }

  return todayList.map((w: any, i: number) => buildHyroxSessionBlock(w, i === 0, ourDay)).join('');
}

function buildHyroxSessionBlock(w: any, isFirst: boolean, ourDay: number): string {
  const wt = String(w.t || '');
  // Easy erg work (discipline 'erg') shows as cross-training, as the HYROX
  // plan card does (workout-card workoutDisc).
  const disc = isHyroxEasyErg(w) ? 'cross'
    : (w.discipline === 'station' || w.discipline === 'brick') ? String(w.discipline)
    : (wt === 'gym' || wt === 'strength') ? 'strength'
    : wt === 'cross_training' ? 'cross'
    : 'run';
  const badgeBg = disc === 'station' ? 'rgba(184,116,44,0.14)' : disc === 'brick' ? 'rgba(91,110,160,0.14)' : disc === 'strength' ? 'rgba(107,114,128,0.14)' : disc === 'cross' ? 'rgba(13,148,136,0.14)' : 'rgba(122,132,92,0.14)';
  const badgeText = disc === 'station' ? '#8a5820' : disc === 'brick' ? '#3d4f80' : disc === 'strength' ? '#4b5563' : disc === 'cross' ? '#0f766e' : '#4f5a3b';
  const label = disc === 'station' ? 'Station' : disc === 'brick' ? 'Brick' : disc === 'strength' ? 'Strength' : disc === 'cross' ? 'Cross-train' : 'Run';
  const rpe = w.rpe ?? w.r ?? 5;
  const mtl = w.musculoTendonLoad;
  const dur = w.estimatedDurationMin;
  const durStr = dur ? (dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 > 0 ? `${dur % 60}m` : ''}`.trim() : `${dur}m`) : '';
  const metaRight = `RPE ${rpe}${mtl != null && mtl > 0 ? ` · MTL ${Math.round(mtl)}` : ''}`;

  return buildHeroSessionCard({
    cls: 'hx-hero-card',
    idAttr: 'data-hx-hero-workout-id',
    id: w.id || w.n,
    label, badgeBg, badgeText, duration: durStr,
    title: escapeAttr(w.n),
    body: strengthCardSummary(w) ?? escapeAttr(w.d || ''),
    metaRight, isFirst, ourDay,
  });
}

function humaniseTriDesc(d: string): string {
  return String(d || '')
    .replace(/\bWU\b/g, 'Warm up')
    .replace(/\bCD\b/g, 'Cool down')
    .replace(/\brec\b/g, 'recovery');
}

function extractTriWorkoutDuration(w: any): string {
  if (w.brickSegments) {
    const total = (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
    return fmtMinsPretty(total);
  }
  if (w.discipline === 'swim') {
    const m = String(w.d || '').match(/(\d[\d,]*)m total/);
    if (m) return `${m[1]}m`;
  }
  // Prefer the canonical duration set by the plan engine.
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) {
    return fmtMinsPretty(w.estimatedDurationMin);
  }
  // Fallback: parse "Nh Nmin" → total, else Nmin.
  const hm = String(w.d || '').match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hm) return fmtMinsPretty(parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10));
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g));
  if (!matches.length) return '';
  const maxMins = matches.reduce((acc: number, m: any) => Math.max(acc, parseInt(m[1], 10)), 0);
  return fmtMinsPretty(maxMins);
}

function fmtMinsPretty(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '';
  const rounded = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function escapeAttr(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wireHomeHandlers(): void {
  // Stagger floatUp animations
  document.querySelectorAll<HTMLElement>('.hf[data-delay]').forEach(el => {
    el.style.animationDelay = el.dataset.delay + 's';
  });

  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Account button
  document.getElementById('home-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Coach button → Coach sub-page
  document.getElementById('home-coach-btn')?.addEventListener('click', () => {
    import('./coach-view').then(({ renderCoachView }) => renderCoachView(() => renderHomeView()));
  });

  // Check-in button
  document.getElementById('home-checkin-btn')?.addEventListener('click', () => openCheckinOverlay());

  // Record button
  document.getElementById('home-record-btn')?.addEventListener('click', () => {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  });

  // Pending-review button → activity-review flow for whichever week has pending
  // items (prefer current; fall back to last week so Mondays / fresh weeks still
  // open the right matching surface).
  document.getElementById('home-tri-review-btn')?.addEventListener('click', () => {
    const st = getState();
    const wk = st.wks?.[st.w - 1];
    // Prefer the current week when it has anything reviewable — pending records
    // OR synced actuals (re-review reconstitutes the latter). Only fall back to
    // last week when the current one is genuinely empty.
    const curPending = wk?.garminPending?.length ?? 0;
    const curActuals = Object.values(wk?.garminActuals ?? {}).some((a: any) => a?.garminId && !String(a.garminId).startsWith('guided-'));
    const weekNum = (curPending > 0 || curActuals) ? st.w : st.w - 1;
    (window as any).openActivityReReview?.(() => renderHomeView(), weekNum);
  });

  // On-demand: primary "Generate a session" CTA → session generator (multi-discipline
  // picker for track-only users: run / bike / swim / gym).
  document.getElementById('home-generate-session')?.addEventListener('click', () => {
    import('./session-generator').then(({ openSessionGenerator }) => openSessionGenerator());
  });

  // Post-race banner: "Switch to tracking" button → downgradeToTrackOnly
  document.getElementById('home-switch-to-track')?.addEventListener('click', () => {
    import('./wizard/controller').then(({ downgradeToTrackOnly }) => downgradeToTrackOnly());
  });
  // Post-race banner: × dismiss button → flag so banner stops firing
  document.getElementById('home-race-done-dismiss')?.addEventListener('click', async () => {
    const { getMutableState, saveState } = await import('@/state');
    (getMutableState() as any).racePastPromptDismissed = true;
    saveState();
    document.getElementById('home-race-done-banner')?.remove();
  });

  // Guest banner: dismiss → flag persists, Account section still surfaces it
  document.getElementById('home-guest-dismiss')?.addEventListener('click', async () => {
    const { getMutableState, saveState } = await import('@/state');
    getMutableState().guestBannerDismissed = true;
    saveState();
    document.getElementById('home-guest-banner')?.remove();
  });

  // Guest banner: Sign in → opens the auth view in upgrade mode
  document.getElementById('home-guest-signin')?.addEventListener('click', () => {
    import('@/ui/auth-view').then(({ renderAuthView }) => renderAuthView({ upgradeGuest: true }));
  });

  // Enrich-prompt banner: dismiss → flag persists, Account > Strava History stays
  document.getElementById('home-enrich-dismiss')?.addEventListener('click', async () => {
    const { getMutableState, saveState } = await import('@/state');
    getMutableState().enrichPromptDismissed = true;
    saveState();
    document.getElementById('home-enrich-banner')?.remove();
  });

  // Enrich-prompt banner: Import from Strava → guided bulk-archive import,
  // re-render Home on completion so the freshly enriched runs reflect.
  document.getElementById('home-enrich-import')?.addEventListener('click', () => {
    import('@/ui/strava-history-guide').then(({ openStravaHistoryGuide }) =>
      openStravaHistoryGuide({ onComplete: () => renderHomeView() }));
  });

  // Just-Track load sparkline → Stats tab for the full card
  document.getElementById('home-load-spark')?.addEventListener('click', () => navigateTab('stats'));

  // Just-Track "This week" card → detail page (per-sport + per-activity breakdown)
  document.getElementById('home-this-week-card')?.addEventListener('click', () => renderTrackOnlyWeekDetail());

  // Just-Track "Log sleep" link → manual sleep picker overlay
  document.getElementById('home-log-sleep-link')?.addEventListener('click', () => showManualSleepPicker());
  // Illness banner. Mark recovered
  // Illness banner. Mark recovered
  document.getElementById('home-illness-recover')?.addEventListener('click', () => clearIllness());
  // Holiday banner. End or cancel holiday
  // Holiday banner. End or cancel holiday
  document.getElementById('home-holiday-end')?.addEventListener('click', () => {
    const hs = getState().holidayState;
    const today = new Date().toISOString().split('T')[0];
    if (hs && today < hs.startDate) cancelScheduledHoliday(() => renderHomeView());
    else clearHoliday(() => renderHomeView());
  });
  // Start workout button. Launches structured GPS tracking for the selected workout
  // Start workout button. Launches structured GPS tracking for the selected workout
  document.getElementById('home-start-btn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const name = btn.getAttribute('data-name') || 'Workout';
    const desc = btn.getAttribute('data-desc') || '';
    // Strength / gym sessions launch the guided strength experience (exercise
    // list, weight stepper, RIR, per-lift tracking) instead of GPS tracking.
    if (btn.getAttribute('data-strength') === '1') {
      const workout = {
        id: btn.getAttribute('data-workout-id') || undefined,
        t: btn.getAttribute('data-type') || 'gym',
        n: btn.getAttribute('data-raw-name') || name,
        d: desc,
        rpe: Number(btn.getAttribute('data-rpe')) || undefined,
        estimatedDurationMin: Number(btn.getAttribute('data-dur')) || undefined,
      };
      import('./strength-workout-detail-modal').then(({ openStrengthWorkoutDetail }) =>
        openStrengthWorkoutDetail(workout as any));
      return;
    }
    if (window.trackWorkout) {
      window.trackWorkout(name, desc);
    } else {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    }
  });

  // View plan button (from workout hero)
  document.getElementById('home-view-plan-btn')?.addEventListener('click', () => {
    import('./main-view').then(({ renderMainView }) => renderMainView());
  });
  // "Done · View" pill on today's hero. Open activity detail
  // "Done · View" pill on today's hero. Open activity detail
  document.getElementById('home-today-view-activity-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('home-today-view-activity-btn');
    const workoutKey = btn?.dataset.workoutKey;
    const weekNum = Number(btn?.dataset.weekNum || 0);
    const st = getState();
    const wk = (st.wks ?? [])[weekNum - 1];
    const actual = wk?.garminActuals?.[workoutKey ?? ''];
    if (actual) {
      import('./activity-detail').then(({ renderActivityDetail }) => {
        renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey || 'Activity', 'home', undefined, workoutKey);
      });
    } else {
      import('./main-view').then(({ renderMainView }) => renderMainView());
    }
  });

  // Sync button → go to plan (which has sync)
  document.getElementById('home-sync-btn')?.addEventListener('click', () => {
    import('./main-view').then(({ renderMainView }) => renderMainView());
  });
  // Race forecast card. Opens full-page chart
  // Race forecast card. Opens full-page chart
  document.getElementById('home-race-forecast-card')?.addEventListener('click', () => {
    import('./race-forecast-view').then(({ renderRaceForecastView }) => renderRaceForecastView());
  });
  // Strain ring. Tap opens strain detail page
  // Strain ring. Tap opens strain detail page
  document.getElementById('home-strain-ring')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const label = document.getElementById('home-strain-ring')?.dataset.readinessLabel ?? null;
    import('./strain-view').then(({ renderStrainView }) => renderStrainView(undefined, label as any, () => renderHomeView()));
  });
  // Sleep ring. Tap opens sleep detail page.
  // Sleep ring. Tap opens sleep detail page.
  document.getElementById('home-sleep-ring')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s3 = getState();
    import('./sleep-view').then(({ renderSleepView }) => {
      renderSleepView(undefined, s3.physiologyHistory ?? [], s3.wks ?? [], () => renderHomeView());
    });
  });
  // Readiness ring. Tap opens readiness detail page
  // Readiness ring. Tap opens readiness detail page
  document.getElementById('home-readiness-ring')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
  // Corner drill arrow. Same destination as the readiness ring. Discoverable tap cue.
  document.getElementById('home-readiness-drill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
  // Recovery ring. Tap opens recovery detail page
  // Recovery ring. Tap opens recovery detail page
  document.getElementById('home-recovery-ring')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView(undefined, () => renderHomeView()));
  });
  // Manual sleep buttons. No-watch users log sleep quality
  // Manual sleep buttons. No-watch users log sleep quality
  document.querySelectorAll('.manual-sleep-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const quality = (btn as HTMLElement).dataset.quality as 'great' | 'good' | 'poor' | 'terrible';
      if (!quality) return;
      const { sleepQualityToScore } = await import('@/recovery/engine');
      const score = sleepQualityToScore(quality);
      const todayDate = new Date().toISOString().split('T')[0];
      const entry = { date: todayDate, sleepScore: score, source: 'manual' as const };
      const ms = getMutableState();
      if (!ms.recoveryHistory) ms.recoveryHistory = [];
      const idx = ms.recoveryHistory.findIndex((e: any) => e.date === todayDate);
      if (idx >= 0) ms.recoveryHistory[idx] = entry;
      else ms.recoveryHistory.push(entry);
      if (ms.recoveryHistory.length > 30) ms.recoveryHistory = ms.recoveryHistory.slice(-30);
      saveState();
      renderHomeView();
    });
  });
  // Adjust session button. Shown when readiness ≤ 59
  // Adjust session button. Shown when readiness ≤ 59
  document.getElementById('readiness-adjust-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getState();

    // Tri mode: route into the tri suggestion pipeline. The button gate (see
    // buildReadinessRing) only renders the button when bundle.mods is
    // non-empty, but recompute here so we get fresh state at click time.
    if (s2.eventType === 'triathlon') {
      const bundle = collectTriSuggestions(s2);
      if (bundle.mods.length > 0) {
        import('./triathlon/tri-suggestion-modal').then(({ showTriSuggestionModal }) =>
          showTriSuggestionModal(bundle).then(() => renderHomeView()),
        );
      }
      return;
    }

    const wk2 = s2.wks?.[s2.w - 1];
    const tier2 = s2.athleteTierOverride ?? s2.athleteTier;
    const atlSeed2 = (s2.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s2.gs ?? 0), 0.3));
    const acwr2 = computeACWR(s2.wks ?? [], s2.w, tier2, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2, s2.signalBBaseline ?? undefined, undefined, (s2 as any).previousPlanWks, s2.adaptiveRecovery);
    const acwrElevated = acwr2.status === 'caution' || acwr2.status === 'high';
    const hasUnspent = (wk2?.unspentLoadItems?.length ?? 0) > 0;
    // Same canonical projection gate as render-time visibility: if the
    // reduction handler would conclude "week already on target", skip straight
    // to the rest-advice branch instead of a no-op modal path.
    const clickPlan = (!s2.trackOnly && s2.eventType !== 'hyrox' && wk2) // tri already returned above
      ? resolveWeekWorkouts(s2, s2.w).filter((w: any) => !(wk2.rated ?? {})[w.id || w.n]) : [];
    const clickProjection = hasUnspent
      ? computeAcwrReductionProjection(s2, workoutsToPlannedRuns(clickPlan as any, s2.pac))
      : null;
    const reductionWouldAct2 = !hasUnspent || (clickProjection?.over ?? true);
    if ((acwrElevated || hasUnspent) && reductionWouldAct2) {
      // ACWR is elevated or there's unspent cross-training load → plan adjustment modal
      import('./main-view').then(({ triggerACWRReduction }) => triggerACWRReduction());
    } else {
      // Low readiness driven by sleep/recovery: show rest advice if there's a run
      // to act on, otherwise navigate to plan so the user can see their week.
      // (A lost `else` here used to open the advice sheet / navigate to Plan on
      // top of the reduction modal — both branches ran on the same tap.)
      const opened = showRecoveryAdviceSheet();
      if (!opened) {
        import('./main-view').then(({ renderMainView }) => renderMainView());
      }
    }
  });

  // Undo today's ACWR reduction (shown in place of the adjust button)
  document.getElementById('readiness-undo-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./main-view').then(({ undoACWRReduction }) => {
      const undone = undoACWRReduction();
      if (undone) {
        import('./toast').then(({ showSimpleToast }) => showSimpleToast('Reduction undone. Original sessions restored.'));
      }
      renderHomeView();
    });
  });

  // TSS row → Load & Taper page
  document.getElementById('home-tss-row')?.addEventListener('click', () => {
    const s2 = getState();
    import('./load-taper-view').then(({ renderLoadTaperView }) => renderLoadTaperView(s2.w, 'home'));
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

  // Recent activity click-through → open activity detail
  document.querySelectorAll<HTMLElement>('.home-act-row').forEach(el => {
    el.addEventListener('click', () => {
      const workoutKey = el.dataset.workoutKey;
      const weekNum = Number(el.dataset.weekNum || 0);
      const st = getState();
      const wk = (st.wks ?? [])[weekNum - 1];
      const actual = wk?.garminActuals?.[workoutKey ?? ''];
      if (actual) {
        import('./activity-detail').then(({ renderActivityDetail }) => {
          renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey || 'Activity', 'home', undefined, workoutKey);
        });
      }
    });
  });

  // Unmatched activity click → open activity review flow (week-aware)
  // Pass renderHomeView as onDone so the user returns to home (not plan view) after matching.
  document.querySelectorAll<HTMLElement>('.home-unmatched-row').forEach(el => {
    el.addEventListener('click', () => {
      const weekNum = parseInt(el.dataset.weekNum ?? '0', 10);
      (window as any).openActivityReReview?.(() => renderHomeView(), weekNum || undefined);
    });
  });

  // Triathlon today hero card → open full detail modal
  document.querySelectorAll<HTMLElement>('.tri-hero-card').forEach((el) => {
    el.addEventListener('click', () => {
      const st = getState();
      const wk = st.wks?.[st.w - 1];
      if (!wk) return;
      const id = el.getAttribute('data-tri-workout-id');
      const w = [...(wk.triWorkouts ?? []), ...(wk.adhocWorkouts ?? [])].find((x: any) => (x.id || x.n) === id);
      if (!w) return;
      import('./triathlon/workout-detail-modal').then(({ openTriWorkoutDetail }) => openTriWorkoutDetail(w));
    });
  });

  // HYROX today hero card → workout detail modal
  document.querySelectorAll<HTMLElement>('.hx-hero-card').forEach((el) => {
    el.addEventListener('click', () => {
      const st = getState();
      const wk = st.wks?.[st.w - 1];
      if (!wk) return;
      const id = el.getAttribute('data-hx-hero-workout-id');
      const w = [...(wk.triWorkouts ?? []), ...(wk.adhocWorkouts ?? [])].find((x: any) => (x.id || x.n) === id);
      if (w) import('./hyrox/workout-detail-modal').then(({ openHyroxWorkoutDetail }) => openHyroxWorkoutDetail(w));
    });
  });

  // Adhoc session click → open the read-only session detail (NOT the completed-
  // activity view). An adhoc workout is something the user generated/added, not a
  // synced activity — opening renderActivityDetail wrongly framed it as a completed
  // Garmin activity with a run-to-work commute toggle. openTriWorkoutDetail is the
  // general session viewer: it auto-routes gym/strength to the per-exercise modal
  // and parses run/bike/swim descriptions into warm-up / main / cool-down blocks.
  document.querySelectorAll<HTMLElement>('.home-adhoc-row').forEach(el => {
    el.addEventListener('click', () => {
      const weekNum = Number(el.dataset.weekNum || 0);
      const adhocIdx = Number(el.dataset.adhocIdx || 0);
      const st = getState();
      const wk = (st.wks ?? [])[weekNum - 1];
      const adhoc = (wk?.adhocWorkouts ?? [])[adhocIdx];
      if (adhoc) {
        import('./triathlon/workout-detail-modal').then(({ openTriWorkoutDetail }) => openTriWorkoutDetail(adhoc, weekNum - 1));
      }
    });
  });
}

export function renderHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  // Entrance plays on the first Home visit per session only. Revisits render
  // settled (no card fade, no bar/arc sweep) so tab switches feel instant.
  const animate = shouldPlayEntrance('home');
  container.innerHTML = getHomeHTML(s, animate);
  wireHomeHandlers();
  setOnWeekAdvance(() => {
    window.location.reload();
  });

  // Post-first-run coachmark: pulse Check-in and reframe it around logging
  // soreness/niggles. No-op after the first time (persisted + session guards).
  maybeShowCheckinHint(s);
}
// ─── Manual sleep picker. Centred overlay, 0–100 slider ─────────────────────
// ─── Manual sleep picker: centred overlay, 0–100 slider ─────────────────────
function showManualSleepPicker(): void {
  const today = new Date().toISOString().split('T')[0];
  const existing = getState().recoveryHistory?.slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const initialValue = existing?.sleepScore ?? 75;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  // Slider uses the canonical glass thumb (.m-slider-glass, styles.css).
  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:20px;text-transform:uppercase;letter-spacing:0.06em">Last night's sleep</div>
      <div style="text-align:center;margin-bottom:20px">
        <span id="sleep-score-display" style="font-size:56px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums;line-height:1">${initialValue}</span><span style="font-size:20px;font-weight:300;color:var(--c-faint)">/100</span>
      </div>
      <div style="padding:4px 0 24px">
        <input id="sleep-score-slider" class="m-slider-glass" type="range" min="1" max="100" value="${initialValue}">
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
  // Running mode only. The sheet offers changes to the running engine's week
  // (applyRecoveryAdjustment writes a running mod), which just-track and HYROX
  // never show. Tri never reaches here (the adjust handler returns first).
  if (s.trackOnly || s.eventType === 'hyrox') return false;
  const wk = s.wks?.[s.w - 1];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ── Detect today's unrated intensity workout ──────────────────────────────
  const jsDow = new Date().getDay(); // JS: 0=Sun
  const internalDow = jsDow === 0 ? 6 : jsDow - 1; // internal: 0=Mon, 6=Sun

  // Types that warrant "convert to easy" rather than "run by feel"
  const intensityTypes = new Set(['threshold', 'vo2', 'intervals', 'marathon_pace', 'vo2max', 'float']);

  let todayWorkout: any = null;
  let todayAnyWorkout: any = null;
  let isIntensitySession = false;
  let bestMoveDay: { day: number; label: string } | null = null;
  let backToBack = false;

  if (wk) {
    // The week as the Plan tab shows it (canonical resolver: accepted changes,
    // moves, illness/holiday adjustments), so the distance shown is the card's. The
    // session offered here is then the one applyRecoveryAdjustment changes (sized
    // from its plan values). A replaced run, a holiday day and an illness rest day
    // are never offered.
    const workouts = resolveWeekWorkouts(s, s.w) as any[];

    const rated = wk.rated ?? {};

    // Today's unrated quality workout
    todayWorkout = workouts.find((w: any) =>
      w.dayOfWeek === internalDow && !rated[w.id || w.n] && w.status !== 'replaced' && !isStoodDownByLayer(w)
      && isHardWorkout(w.t)
    ) ?? null;

    // Any unrated running workout today (for reduce-intensity when no hard session)
    todayAnyWorkout = todayWorkout ?? workouts.find((w: any) =>
      w.dayOfWeek === internalDow && !rated[w.id || w.n] && w.status !== 'replaced' && !isStoodDownByLayer(w) &&
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
  // Nothing actionable today (rest day, cross-training only). Skip the modal
  // Nothing actionable today (rest day, cross-training only): skip the modal
  if (!todayAnyWorkout) return false;

  // ── Build HTML ─────────────────────────────────────────────────────────────
  const escName = todayWorkout ? todayWorkout.n.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '';
  // Full session distance (warm up + work + cool down), so the "convert to easy"
  // subtitle matches what the conversion actually produces. The first-"Nkm"-token
  // shortcut read only a structured session's warm-up (e.g. "2km" of a 7km tempo).
  const parsedConvKm = (todayWorkout?.d && s.pac)
    ? Math.round(parseWorkoutDescription(todayWorkout.d, s.pac).totalDistance / 1000 * 10) / 10
    : 0;
  const distStr = parsedConvKm > 0 ? `${parsedConvKm}km` : '';

  const todaySection = todayWorkout ? `
    <div style="background:rgba(0,0,0,0.04);border-radius:12px;overflow:hidden">
      <div style="padding:10px 16px 8px;border-bottom:1px solid var(--c-border)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">
          Today. ${escName}${backToBack ? ' · back-to-back' : ''}
        </div>
        ${backToBack ? `<p style="font-size:12px;color:var(--c-muted);line-height:1.5;margin:0 0 10px">Yesterday was a hard session. Two consecutive quality days significantly raise injury risk and reduce adaptation quality.</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:8px;padding-bottom:4px">
          <button id="rec-advice-convert" style="padding:12px 14px;border-radius:10px;border:1.5px solid var(--c-border);background:var(--c-bg);font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer;text-align:left;font-family:var(--f)">
            ${isIntensitySession ? 'Convert to easy run' : 'Run by feel. Drop pace targets'}
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

  // "Reduce intensity" only renders when the hard-session card is absent —
  // when today IS a hard session, the card's "Convert to easy run" performs
  // the identical downgrade, and two buttons for one action is noise
  // (2026-06-04 dogfood). For a non-hard run it applies the easy-flag.
  const reduceBtn = (todayAnyWorkout && !todayWorkout)
    ? `<button id="rec-advice-reduce" style="${btnStyle}">
        <div style="${btnTitle}">Reduce intensity</div>
        <p style="${btnBody}">Convert today's session to an easy effort: same distance, Zone 2 only. Aerobic stimulus without the additional stress on an under-recovered system.</p>
      </button>`
    : '';

  // "Reorder the week" only makes sense when there's a hard session to move
  const reorderBtn = todayWorkout
    ? `<button id="rec-advice-reorder" style="${btnStyle}">
        <div style="${btnTitle}">Reorder the week</div>
        <p style="${btnBody}">Move today's quality session to a later day. Swap it with an easy run or rest day. Total load stays the same, the sequencing improves.</p>
      </button>`
    : '';

  // "Rest today" was removed (Tristan, 2026-06-04): its handler only closed
  // the modal while the copy claimed to skip-and-carry; with "Move to <day>"
  // doing the real reschedule and ✕ covering "I'm just not training", a
  // do-nothing button is noise. Simply dismissing IS resting.
  const genericRows = `${reorderBtn}
    ${reduceBtn}`;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div>
          <div style="font-size:16px;font-weight:600">Low readiness: options</div>
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
  // Convert button. Downgrade today's session to easy
  // Convert button. Downgrade today's session to easy
  overlay.querySelector('#rec-advice-convert')?.addEventListener('click', () => {
    close();
    applyRecoveryAdjustment('downgrade', internalDow, todayWorkout?.n);
  });
  // Move button. Shift today's session to the best available day
  // Move button. Shift today's session to the best available day
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
  // Reorder the week. Navigate to plan view so user can rearrange
  // Reorder the week. Navigate to plan view so user can rearrange
  overlay.querySelector('#rec-advice-reorder')?.addEventListener('click', () => {
    close();
    import('./main-view').then(({ renderMainView }) => renderMainView());
  });
  // Reduce intensity. Downgrade today's workout to easy effort
  // Reduce intensity. Downgrade today's workout to easy effort
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
          <div style="font-size:10px;color:var(--c-faint);margin-bottom:12px;line-height:1.5">Colour reflects your personal baseline. A drop of 20%+ signals to go easy today.</div>
        ` : `
          <div style="padding:12px 0;color:var(--c-faint);font-size:13px">HRV data not yet available. Garmin usually syncs within a few hours of waking.</div>
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
          <div style="padding:12px 0;color:var(--c-faint);font-size:13px">Resting HR data not yet available. Garmin usually syncs within a few hours of waking.</div>
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
