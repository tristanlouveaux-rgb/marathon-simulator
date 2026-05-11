/**
 * Strain detail page — new iPhone-native design language.
 * Opens when tapping the Strain ring on the Home view.
 * Shows strain %, 7-day rolling stats, coaching insight, and activity timeline.
 */

import { getState } from '@/state';
import type { SimulatorState, GarminActual, Week } from '@/types/state';
import {
  computeTodaySignalBTSS,
  computeTodayStrainTSS,
  computePlannedDaySignalBTSS,
  getTrailingEffortScore,
  estimateWorkoutDurMin,
  computeDayTargetTSS,
  computePassiveTSS,
  PASSIVE_TSS_PER_ACTIVE_MIN,
  REST_DAY_OVERREACH_RATIO,
  getNormalizerFromState,
  type TargetTSSRange,
} from '@/calculations/fitness-model';
import type { ReadinessLabel } from '@/calculations/readiness';
import { TL_PER_MIN } from '@/constants';
import { generateWeekWorkouts } from '@/workouts';
import { isTimingMod } from '@/cross-training/timing-check';
import { formatActivityType } from '@/calculations/activity-matcher';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';
import { buildFloweyBackground, floweyAnimationCSS, buildSunGlint, atmosphereGradient } from './page-flair';
void buildSkyBackground; void skyAnimationCSS;

// ── Design tokens ─────────────────────────────────────────────────────────────

const GRAD_BG   = 'linear-gradient(180deg, #2d1810 0%, #4a2518 40%, #5d3020 100%)';
const ORANGE_A  = '#FF9A44';
const ORANGE_B  = '#FF512F';
const TEXT_M    = '#0F172A';
const TEXT_S    = '#64748B';
const TEXT_L    = '#94A3B8';
const RING_R    = 46;
const RING_CIRC = +(2 * Math.PI * RING_R).toFixed(2);

// ── Date helpers ──────────────────────────────────────────────────────────────

function weekIdxForDate(date: string, planStartDate: string): number {
  const ms = new Date(date + 'T12:00:00').getTime() - new Date(planStartDate + 'T12:00:00').getTime();
  return Math.max(0, Math.floor(ms / (7 * 24 * 3600 * 1000)));
}

/** Resolve the correct week index, trusting s.w for dates in the current plan week.
 *  weekIdxForDate can disagree with s.w when planStartDate doesn't align with Monday. */
function resolveWkIdx(date: string, s: SimulatorState): number {
  if (!s.planStartDate) return s.w - 1;
  // Current plan week date range (authoritative, from s.w)
  const startD = new Date(s.planStartDate + 'T12:00:00');
  startD.setDate(startD.getDate() + (s.w - 1) * 7);
  const endD = new Date(startD);
  endD.setDate(endD.getDate() + 6);
  const dateMs = new Date(date + 'T12:00:00').getTime();
  if (dateMs >= startD.getTime() && dateMs <= endD.getTime()) return s.w - 1;
  return weekIdxForDate(date, s.planStartDate);
}

function fmtDateLong(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtDateShort(date: string, today: string): string {
  if (date === today) return 'Today';
  const yest = new Date(today + 'T12:00:00');
  yest.setDate(yest.getDate() - 1);
  if (date === yest.toISOString().split('T')[0]) return 'Yesterday';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function fmtTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDurMin(durationSec: number): string {
  const m = Math.round(durationSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function activitiesForDate(date: string, wks: Week[]): GarminActual[] {
  const out: GarminActual[] = [];
  const seenGarminIds = new Set<string>();

  for (const wk of wks) {
    // Plan-matched actuals
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (!a.startTime?.startsWith(date)) continue;
      if (a.garminId) {
        if (seenGarminIds.has(a.garminId)) continue;
        seenGarminIds.add(a.garminId);
      }
      out.push(a);
    }
    // Garmin-prefixed adhoc workouts (unmatched / log-only activities)
    for (const w of wk.adhocWorkouts ?? []) {
      const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
      if (!rawId) continue;
      const ts = (w as any).garminTimestamp as string | undefined;
      if (!ts?.startsWith(date)) continue;
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
      out.push({
        garminId: rawId,
        startTime: ts ?? null,
        distanceKm: (w as any).garminDistKm ?? 0,
        durationSec: Math.round(((w as any).garminDurationMin ?? 0) * 60),
        avgPaceSecKm: null,
        avgHR: (w as any).garminAvgHR ?? null,
        maxHR: (w as any).garminMaxHR ?? null,
        calories: (w as any).garminCalories ?? null,
        iTrimp: (w as any).iTrimp ?? null,
        displayName: w.n,
        activityType: (w as any).activityType ?? null,
      } as GarminActual);
    }
  }
  return out;
}

interface DayData {
  date: string;
  durationMin: number;
  calories: number | null;
  signalBTSS: number;
  activities: GarminActual[];
}

function getDayData(date: string, s: SimulatorState): DayData {
  const wks = s.wks ?? [];
  const acts = activitiesForDate(date, wks);
  const durationMin = acts.reduce((sum, a) => sum + a.durationSec / 60, 0);
  const hasCalories = acts.some(a => a.calories != null);
  const calories = hasCalories ? acts.reduce((sum, a) => sum + (a.calories ?? 0), 0) : null;

  let signalBTSS = 0;
  if (s.planStartDate) {
    const wk = wks[weekIdxForDate(date, s.planStartDate)];
    if (wk) signalBTSS = computeTodaySignalBTSS(wk, date);
  } else {
    signalBTSS = acts.reduce((sum, a) => a.iTrimp != null ? sum + (a.iTrimp * 100) / getNormalizerFromState(s) : sum, 0);
  }

  return { date, durationMin, calories, signalBTSS, activities: acts };
}

function getLast7Days(today: string, s: SimulatorState): DayData[] {
  const days: DayData[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() - i);
    days.push(getDayData(d.toISOString().split('T')[0], s));
  }
  return days;
}


interface StrainForDate {
  actualTSS: number;
  target: TargetTSSRange;
  plannedDayTSS: number;
  passiveTSS: number;
  isRestDay: boolean;
  isOverreaching: boolean;
  matchedActivityDay: boolean;
  readinessLabel: string | null;
  /** Marker colour: white (normal), amber (Manage Load), red (Ease Back/Overreaching) */
  markerColor: string;
}

function getStrainForDate(date: string, s: SimulatorState, todayReadinessLabel?: ReadinessLabel | null): StrainForDate {
  const today = new Date().toISOString().split('T')[0];
  const wks = s.wks ?? [];
  const wkIdx = resolveWkIdx(date, s);
  const wkForPlan = wks[wkIdx];

  // ── Actual Signal B TSS (logged activities + passive excess) ──────────
  // Uses computeTodayStrainTSS — single source of truth shared with Home + Readiness.
  const physioEntry = (s.physiologyHistory ?? []).find(e => e.date === date);
  let actualTSS = 0;
  if (s.planStartDate) {
    const wk = wks[wkIdx];
    if (wk) actualTSS = computeTodayStrainTSS(wk, date, physioEntry, s.tssPerActiveMinute ?? PASSIVE_TSS_PER_ACTIVE_MIN);
  } else {
    const acts = activitiesForDate(date, wks);
    actualTSS = acts.reduce((sum, a) => a.iTrimp != null ? sum + (a.iTrimp * 100) / getNormalizerFromState(s) : sum, 0);
  }

  // Passive excess for the "X passive TSS from background activity" caption.
  const loggedActivities = activitiesForDate(date, wks).map(a => ({
    durationSec: a.durationSec,
    activityType: a.activityType,
  }));
  const passiveTSS = computePassiveTSS(
    physioEntry?.steps,
    physioEntry?.activeMinutes,
    loggedActivities,
    s.tssPerActiveMinute ?? PASSIVE_TSS_PER_ACTIVE_MIN,
  );
  const minuteComponent = physioEntry?.activeMinutes != null
    ? Math.max(0, physioEntry.activeMinutes - loggedActivities.reduce((s2, a) => s2 + a.durationSec / 60, 0)) * (s.tssPerActiveMinute ?? PASSIVE_TSS_PER_ACTIVE_MIN)
    : 0;
  const passiveExcess = Math.max(0, passiveTSS - minuteComponent);

  // ── Planned day TSS ────────────────────────────────────────────────────
  const dayOfWeek = (new Date(date + 'T12:00:00').getDay() + 6) % 7;
  let plannedDayTSS = 0;
  let plannedWorkouts: any[] = [];
  if (wkForPlan && !s.trackOnly) {
    const viewWeek = wkIdx + 1;
    plannedWorkouts = generateWeekWorkouts(
      wkForPlan.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
      viewWeek, s.tw, s.v, s.gs, getTrailingEffortScore(wks, viewWeek), wkForPlan.scheduledAcwrStatus, undefined,
      s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
    );
    if (wkForPlan.workoutMoves) {
      for (const [workoutId, newDay] of Object.entries(wkForPlan.workoutMoves)) {
        const w = plannedWorkouts.find((wo: any) => (wo.id || wo.n) === workoutId);
        if (w) (w as any).dayOfWeek = newDay;
      }
    }
    if (wkForPlan.workoutMods) {
      for (const mod of wkForPlan.workoutMods) {
        const w = isTimingMod(mod.modReason)
          ? plannedWorkouts.find((wo: any) => wo.n === mod.name)
          : plannedWorkouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
        if (w && !isTimingMod(mod.modReason)) {
          (w as any).d = mod.newDistance;
          if (mod.newType) (w as any).t = mod.newType;
          if (mod.newRpe != null) (w as any).rpe = mod.newRpe;
        }
      }
    }
    const baseMinPerKm = s.pac?.e ? s.pac.e / 60 : 5.5;
    const runWorkouts = plannedWorkouts.filter((w: any) => w.t !== 'cross');
    plannedDayTSS = computePlannedDaySignalBTSS(runWorkouts, dayOfWeek, baseMinPerKm);
  }

  // ── Per-session average + day type ─────────────────────────────────────
  // Based on planned week TSS (tracks plan intent, not CTL history)
  const baseMinPerKmSess = s.pac?.e ? s.pac.e / 60 : 5.5;
  const runWorkoutsForAvg = plannedWorkouts.filter((w: any) => w.t !== 'cross');
  const trainingDayCount = wkForPlan ? [0,1,2,3,4,5,6]
    .filter(d => computePlannedDaySignalBTSS(runWorkoutsForAvg, d, baseMinPerKmSess) > 0).length || 4 : 4;
  const plannedWeekTSS = [0,1,2,3,4,5,6]
    .reduce((sum, d) => sum + computePlannedDaySignalBTSS(runWorkoutsForAvg, d, baseMinPerKmSess), 0);
  const perSessionAvg = trainingDayCount > 0 ? plannedWeekTSS / trainingDayCount : 0;

  let matchedActivityDay = false;
  if (plannedDayTSS === 0 && wkForPlan) {
    for (const [, act] of Object.entries(wkForPlan.garminActuals ?? {})) {
      if (!act.startTime?.startsWith(date)) continue;
      matchedActivityDay = true;
      break;
    }
  }
  const hasPlannedWorkout = plannedDayTSS > 0;
  const isRestDay = !hasPlannedWorkout && !matchedActivityDay;

  // ── Readiness label (for target modulation + marker colour) ────────────
  // Only applies for today — past days display unmodulated targets.
  // Passed through from the caller (home-view precomputes readiness).
  const readinessLabel: ReadinessLabel | null = (date === today && todayReadinessLabel) ? todayReadinessLabel : null;

  // ── Readiness-modulated target TSS range ─────────────────────────────────
  const target = computeDayTargetTSS(
    plannedDayTSS,
    readinessLabel as any,
    perSessionAvg,
    isRestDay,
    matchedActivityDay,
  );

  // ── Overreaching check ─────────────────────────────────────────────────
  const restDayThreshold = perSessionAvg * REST_DAY_OVERREACH_RATIO;
  const isOverreaching = isRestDay && actualTSS > 0 && perSessionAvg > 0 && actualTSS > restDayThreshold;

  // ── Marker colour ──────────────────────────────────────────────────────
  let markerColor = 'white';
  if (readinessLabel === 'Manage Load') markerColor = '#F59E0B'; // amber
  else if (readinessLabel === 'Ease Back' || readinessLabel === 'Overreaching') markerColor = '#EF4444'; // red

  return {
    actualTSS,
    target,
    plannedDayTSS,
    passiveTSS: Math.round(passiveExcess),
    isRestDay,
    isOverreaching,
    matchedActivityDay,
    readinessLabel,
    markerColor,
  };
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function sparklinePath(values: number[]): string {
  const max = Math.max(...values, 0.001);
  if (max === 0.001) return '';
  const w = 100;
  const h = 30;
  const pts = values.map((v, i) => [
    (i / Math.max(values.length - 1, 1)) * w,
    h - (v / max) * h * 0.85 + h * 0.075,
  ] as [number, number]);
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const mx = ((x1 + x2) / 2).toFixed(1);
    const my = ((y1 + y2) / 2).toFixed(1);
    d += ` Q${x1.toFixed(1)},${y1.toFixed(1)} ${mx},${my}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` T${lx.toFixed(1)},${ly.toFixed(1)}`;
  return d;
}

// ── Coaching copy (factual, consultant tone, no emoji) ────────────────────────

function coachingText(
  strainPct: number,
  actualTSS: number,
  targetTSS: number,
  isToday: boolean,
  weekKm: number,
  isRestDay: boolean,
  isOverreaching: boolean,
  trackOnly = false,
): string {
  const actual = Math.round(actualTSS);
  const target = Math.round(targetTSS);
  const kmNote = weekKm > 0.5 ? ` ${weekKm.toFixed(1)} km logged this week.` : '';

  // Track-only mode: no plan-target language. Describe actuals only.
  if (trackOnly) {
    if (actual === 0) {
      return isToday ? 'No activity logged yet today.' : 'No activity logged on this day.';
    }
    if (isOverreaching) return `${actual} TSS logged. A high load. Consider keeping tomorrow easier.${kmNote}`;
    return `${actual} TSS logged.${kmNote}`;
  }

  // Rest day — two states only: good or overreaching
  if (isRestDay) {
    if (isOverreaching) return `${actual} TSS on a rest day. This level of activity impairs recovery. Keep it light or take it fully off.`;
    if (actual > 0) return `${actual} TSS logged. Light activity on rest days is fine for recovery.${kmNote}`;
    return 'Rest day. No sessions scheduled.';
  }

  // Training day (past)
  if (!isToday) {
    if (actual === 0) return target > 0 ? `No activities recorded. ${target} TSS planned.` : 'Rest day.';
    if (strainPct >= 130) return `${actual} TSS, ${Math.round(strainPct - 100)}% above the ${target} TSS plan.${kmNote}`;
    return `${actual} TSS logged against ${target} TSS planned.${kmNote}`;
  }

  // Training day (today)
  if (strainPct >= 130) return `Daily load exceeded target. ${actual} TSS logged against ${target} TSS planned. Avoid additional training today.`;
  if (strainPct >= 100) return `Daily target reached. ${actual} TSS logged against ${target} TSS planned. Training complete for today.${kmNote}`;
  if (strainPct > 0)    return `${actual} TSS logged. ${Math.round(strainPct)}% of the ${target} TSS target reached.${kmNote}`;
  if (target > 0)       return `No load logged yet. ${target} TSS planned for today.${kmNote}`;
  return 'Rest day. No sessions scheduled.';
}

// ── Activity icon (sport-specific SVG) ───────────────────────────────────────

function activityIcon(type: string): string {
  const t = (type ?? '').toUpperCase();
  const stroke = ORANGE_B;
  if (t.includes('RUN')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M15 8H9l-2 8"/><path d="M9 8l-2 8h10l-1-4"/></svg>`;
  }
  if (t.includes('CYCL') || t.includes('BIKE') || t.includes('MOUNTAIN')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><path d="M15 6h-1l-3 7H5.5"/><path d="M12 6l1 7h4.5"/></svg>`;
  }
  if (t.includes('SWIM')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1 2 2h2"/><path d="M2 17h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2h2"/></svg>`;
  }
  if (t.includes('WALK') || t.includes('HIKE')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M9 8l-2 8m7-8l2 4-4 2-1 6"/></svg>`;
  }
  // Default — dumbbell / strength
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5h11M6.5 17.5h11M2 9.5h20M2 14.5h20"/></svg>`;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

// ── Week bar days ─────────────────────────────────────────────────────────────

interface WeekBarDay {
  date: string;
  label: string;
  plannedTSS: number;
  actualTSS: number;
  isToday: boolean;
  isFuture: boolean;
}

function getWeekBarDays(displayDate: string, s: SimulatorState, today: string): WeekBarDay[] {
  const wks = s.wks ?? [];
  const wkIdx = resolveWkIdx(displayDate, s);
  const wk = wks[wkIdx];
  if (!wk) return [];

  // Mon-Sun dates of the plan week containing displayDate
  const weekStartDate = s.planStartDate
    ? (() => {
        const d = new Date(s.planStartDate + 'T12:00:00');
        d.setDate(d.getDate() + wkIdx * 7);
        return d;
      })()
    : (() => {
        const d = new Date(displayDate + 'T12:00:00');
        const dow = (d.getDay() + 6) % 7;
        d.setDate(d.getDate() - dow);
        return d;
      })();

  const viewWeek = wkIdx + 1;
  // Skip planned-workout generation for Just-Track users — no plan exists.
  const plannedWorkouts = s.trackOnly ? [] : generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    viewWeek, s.tw, s.v, s.gs, getTrailingEffortScore(wks, viewWeek), wk.scheduledAcwrStatus, undefined,
    s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
  );
  // Apply day moves so bar TSS matches what the plan view shows
  if (wk.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(wk.workoutMoves)) {
      const w = plannedWorkouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }
  // Apply distance/type/RPE mods so bar TSS matches plan card
  if (wk.workoutMods) {
    for (const mod of wk.workoutMods) {
      const w = isTimingMod(mod.modReason)
        ? plannedWorkouts.find((wo: any) => wo.n === mod.name)
        : plannedWorkouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w && !isTimingMod(mod.modReason)) {
        (w as any).d = mod.newDistance;
        if (mod.newType) (w as any).t = mod.newType;
        if (mod.newRpe != null) (w as any).rpe = mod.newRpe;
      }
    }
  }

  // Exclude cross-training from planned bars (consistent with strain target logic)
  const runWorkouts = plannedWorkouts.filter((w: any) => w.t !== 'cross');
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const tssPerActiveMin = s.tssPerActiveMinute ?? PASSIVE_TSS_PER_ACTIVE_MIN;
  return dayLabels.map((label, i) => {
    const d = new Date(weekStartDate);
    d.setDate(weekStartDate.getDate() + i);
    const date = d.toISOString().split('T')[0];
    const isFuture = date > today;
    const plannedTSS = computePlannedDaySignalBTSS(runWorkouts, i, s.pac?.e ? s.pac.e / 60 : 5.5);
    const physioEntry = (s.physiologyHistory ?? []).find(e => e.date === date);
    const actualTSS = !isFuture ? computeTodayStrainTSS(wk, date, physioEntry, tssPerActiveMin) : 0;
    return { date, label, plannedTSS, actualTSS, isToday: date === today, isFuture };
  });
}

function buildWeekBarsHTML(weekBarDays: WeekBarDay[]): string {
  if (weekBarDays.length === 0) return '';
  const maxRef = Math.max(...weekBarDays.map(d => d.plannedTSS), 1);

  const rows = weekBarDays.map((day, i) => {
    const isLast = i === weekBarDays.length - 1;
    let fillPct = 0;
    if (!day.isFuture && day.actualTSS > 0 && day.plannedTSS > 0) {
      fillPct = Math.min((day.actualTSS / day.plannedTSS) * 100, 100);
    }
    const trackWidth = day.isFuture ? 20 : (day.plannedTSS > 0 ? (day.plannedTSS / maxRef) * 100 : 20);

    let tssLabel: string;
    if (day.isFuture) {
      tssLabel = '';
    } else if (day.plannedTSS === 0) {
      tssLabel = day.actualTSS > 0 ? `${Math.round(day.actualTSS)}` : 'Rest';
    } else {
      tssLabel = day.actualTSS > 0 ? `${Math.round(day.actualTSS)}` : '—';
    }

    const labelColor = day.isToday ? ORANGE_B : TEXT_L;
    const labelWeight = day.isToday ? '600' : '400';
    const fillColor = day.isToday ? ORANGE_B : 'rgba(0,0,0,0.22)';
    const trackOpacity = day.isFuture ? 0.3 : (day.plannedTSS > 0 ? 1 : 0.4);

    return `
      <div style="display:flex;align-items:center;gap:10px;${isLast ? '' : 'margin-bottom:8px;'}">
        <div style="width:28px;font-size:11px;color:${labelColor};font-weight:${labelWeight}">${day.label}</div>
        <div style="flex:1;height:5px;border-radius:3px;background:rgba(0,0,0,0.06);position:relative;overflow:visible">
          <div style="position:absolute;inset-y:0;left:0;width:${trackWidth.toFixed(1)}%;height:5px;border-radius:3px;background:rgba(0,0,0,0.06);opacity:${trackOpacity}"></div>
          ${fillPct > 0 ? `<div style="position:absolute;inset-y:0;left:0;width:${(fillPct / 100 * trackWidth).toFixed(1)}%;height:5px;border-radius:3px;background:${fillColor}"></div>` : ''}
        </div>
        <div style="width:30px;font-size:11px;color:${TEXT_L};text-align:right">${tssLabel}</div>
      </div>`;
  }).join('');

  return `
    <div class="s-fade" style="animation-delay:0.18s;padding:0 16px;margin-bottom:14px">
      <div style="background:white;border-radius:16px;padding:16px 20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
        <div style="font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:14px">This week</div>
        ${rows}
      </div>
    </div>`;
}

function getStrainHTML(s: SimulatorState, displayDate: string, todayReadinessLabel?: ReadinessLabel | null): string {
  const today = new Date().toISOString().split('T')[0];
  const isToday = displayDate === today;

  const strain = getStrainForDate(displayDate, s, todayReadinessLabel);
  const { actualTSS, target, isRestDay, isOverreaching, matchedActivityDay, passiveTSS } = strain;
  const displayData = getDayData(displayDate, s);
  const sevenDays = getLast7Days(today, s);
  const weekBarDays = getWeekBarDays(displayDate, s, today);

  // ── Ring: full circle, matches readiness/freshness/rolling-load pattern exactly ──
  // SVG is rotated -90deg so dashoffset sweeps from 12 o'clock CW.
  // Scale: target.hi maps to ~67% of the circle so the arc is visually informative
  // even at low TSS values. Color communicates status: blue=below, green=in, red=over.
  const hasTarget = target.mid > 0;
  const ringMax = Math.max(target.hi * 1.5, actualTSS * 1.1, 1);

  // Status label
  let statusLabel = '';
  let statusColor = 'rgba(255,255,255,0.6)';
  if (isRestDay && isOverreaching) {
    statusLabel = s.trackOnly ? 'High load today' : 'High for a rest day';
    statusColor = '#FF6B6B';
  } else if (target.mid > 0 && actualTSS > target.hi) {
    statusLabel = 'Load exceeded';
    statusColor = '#FF6B6B';
  } else if (target.mid > 0 && actualTSS >= target.lo) {
    statusLabel = 'Target reached';
    statusColor = '#34C759';
  }

  // Progress color: one of three states.
  const progressColor = !hasTarget ? '#007AFF'
    : actualTSS > target.hi ? '#FF3B30'
    : actualTSS >= target.lo ? '#34C759'
    : '#007AFF';

  // Stroke-dashoffset target: RING_CIRC × (1 − fill fraction). Starts at RING_CIRC (hidden).
  const strainTargetOffset = +(RING_CIRC * (1 - Math.min(actualTSS / ringMax, 1))).toFixed(2);


  // Target label: show range
  const targetLabel = target.mid > 0
    ? (target.lo === target.hi ? `${target.mid}` : `${target.lo}\u2013${target.hi}`)
    : '';

  // Ring inner content
  let ringInnerHTML: string;
  if (isRestDay && actualTSS === 0) {
    ringInnerHTML = `
      <div style="font-size:22px;font-weight:300;color:${TEXT_S};line-height:1">Rest day</div>
      ${targetLabel ? `<div style="font-size:11px;color:${TEXT_L};margin-top:5px">Target ${targetLabel} TSS</div>` : ''}`;
  } else {
    ringInnerHTML = `
      <div style="display:flex;align-items:baseline;color:${TEXT_M};font-weight:700">
        <span style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">${Math.round(actualTSS)}</span>
        <span style="font-size:16px;margin-left:3px;font-weight:400;color:${TEXT_S}">TSS</span>
      </div>
      ${targetLabel
        ? `<div style="font-size:11px;color:${TEXT_S};margin-top:3px">Target ${targetLabel} TSS</div>`
        : `<div style="font-size:11px;color:${TEXT_L};margin-top:3px">${isRestDay ? 'Rest day' : 'No target'}</div>`
      }
      ${statusLabel ? `<div style="font-size:10px;font-weight:600;color:${statusColor};margin-top:2px">${statusLabel}</div>` : ''}`;
  }

  // Date picker pills (last 7 days, oldest → today)
  const datePills = sevenDays.map(d => {
    const active = d.date === displayDate;
    return `<button class="strain-date-pill" data-date="${d.date}" style="
      padding:6px 16px;border-radius:100px;border:none;cursor:pointer;
      font-size:13px;font-weight:${active ? '600' : '400'};font-family:var(--f);
      background:${active ? 'rgba(0,0,0,0.06)' : 'transparent'};
      color:${active ? TEXT_M : TEXT_S};
      backdrop-filter:${active ? 'blur(8px)' : 'none'};
      white-space:nowrap;transition:background 0.15s,color 0.15s;
    ">${fmtDateShort(d.date, today)}</button>`;
  }).join('');

  // Timeline rows
  const acts = displayData.activities;
  const timelineHTML = acts.length === 0
    ? `<div style="padding:24px;text-align:center;font-size:13px;color:rgba(0,0,0,0.3)">No activities recorded</div>`
    : acts.map(a => {
        const name = a.displayName || a.workoutName || formatActivityType(a.activityType ?? '');
        const timeStr = a.startTime ? fmtTime(a.startTime) : '';
        const durStr  = fmtDurMin(a.durationSec);
        const calStr  = a.calories != null && a.calories > 0 ? `${a.calories} kcal` : '';
        const tss     = a.iTrimp != null ? Math.round((a.iTrimp * 100) / getNormalizerFromState(s)) : null;
        return `
          <div class="strain-act-row" data-garmin-id="${a.garminId}" style="
            display:flex;align-items:center;gap:12px;
            background:white;border-radius:16px;padding:12px 16px;
            box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);
            cursor:pointer;margin-bottom:10px;
            transition:transform 0.1s;
          ">
            <div style="
              position:relative;width:48px;height:48px;flex-shrink:0;
              background:#FFF3ED;border-radius:16px;
              display:flex;align-items:center;justify-content:center;
            ">
              ${activityIcon(a.activityType ?? '')}
              ${tss != null ? `<div style="
                position:absolute;bottom:-5px;right:-5px;
                background:white;border:1px solid rgba(255,80,47,0.35);
                border-radius:6px;padding:1px 5px;
                font-size:10px;font-weight:700;color:${ORANGE_B};line-height:1.4;
              ">${tss}</div>` : ''}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:600;color:${TEXT_M}">${name}</div>
              <div style="font-size:13px;color:${TEXT_L};margin-top:1px">${[timeStr, durStr, calStr].filter(Boolean).join(' · ')}</div>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>`;
      }).join('');

  return `
    <style>
      #strain-view { box-sizing: border-box; }
      #strain-view *, #strain-view *::before, #strain-view *::after { box-sizing: inherit; }
      @keyframes strainFloatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .s-fade { opacity:0; animation:strainFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .strain-act-row:active { transform:scale(0.98); }
      .strain-date-pill:hover { background:rgba(0,0,0,0.04)!important; color:${TEXT_M}!important; }
    </style>

    <div id="strain-view" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('coral')};
      font-family:var(--f);overflow-x:hidden;
    ">

      ${buildFloweyBackground('str', 'coral')}${buildSunGlint('low')}

      <!-- ── Scrollable content ──────────────────────────────────────── -->
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="strain-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Today's Strain</div>
            <button id="strain-date-btn" style="
              display:flex;align-items:center;gap:4px;margin:3px auto 0;
              font-size:12px;color:${TEXT_S};font-weight:500;
              background:none;border:none;cursor:pointer;font-family:var(--f);
            ">
              ${fmtDateLong(displayDate)}
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>

          <button id="strain-info-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </button>
        </div>

        <!-- Date picker (collapsed by default, scrollable row) -->
        <div id="strain-date-picker" style="
          display:none;overflow-x:auto;padding:0 16px 12px;
          scrollbar-width:none;-ms-overflow-style:none;
        ">
          <div style="display:flex;gap:6px;width:max-content;padding-bottom:2px">${datePills}</div>
        </div>

        <!-- Ring — identical pattern to readiness/freshness: rotate(-90deg), circle elements, dashoffset JS -->
        <div class="s-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:12px 0 28px">
          <div class="strain-ring-wrap" style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.55);backdrop-filter:blur(16px);border-radius:50%;border:1px solid rgba(255,255,255,0.6);box-shadow:0 6px 40px -8px rgba(0,0,0,0.15)">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <!-- SVG is rotated -90deg; gradient coords are in rotated space -->
                <linearGradient id="strain-ring-grad" x1="20%" y1="90%" x2="80%" y2="10%">
                  <stop offset="0%"   stop-color="${progressColor === '#FF3B30' ? '#FCA5A5' : progressColor === '#34C759' ? '#86EFAC' : '#93C5FD'}"/>
                  <stop offset="50%"  stop-color="${progressColor === '#FF3B30' ? '#EF4444' : progressColor === '#34C759' ? '#22C55E' : '#3B82F6'}"/>
                  <stop offset="100%" stop-color="${progressColor === '#FF3B30' ? '#991B1B' : progressColor === '#34C759' ? '#166534' : '#1D4ED8'}"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
              <circle id="strain-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#strain-ring-grad)" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_CIRC}"
                stroke-dashoffset="${RING_CIRC}"
                data-target-offset="${strainTargetOffset}"
                style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"/>
            </svg>
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
              ${ringInnerHTML}
            </div>
          </div>
        </div>

        <!-- Week day bars -->
        ${buildWeekBarsHTML(weekBarDays)}

        <!-- Timeline -->
        <div class="s-fade" style="animation-delay:0.28s;padding:0 16px;margin-bottom:14px">
          <h2 style="font-size:17px;font-weight:700;color:${TEXT_M};margin:0 0 16px 2px;letter-spacing:-0.01em">Timeline</h2>
          ${timelineHTML}
        </div>

        <!-- Steps + passive strain -->
        <div class="s-fade" style="animation-delay:0.38s;padding:0 16px">
          <div style="background:white;border-radius:16px;padding:16px 20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:12px;color:${TEXT_L};margin-bottom:8px">Daily steps</div>
            ${(() => {
              const physio = (s.physiologyHistory ?? []).find(e => e.date === displayDate);
              const steps = physio?.steps;
              if (steps != null && steps > 0) {
                return `
                  <div style="font-size:28px;font-weight:300;color:${TEXT_M};line-height:1">${steps.toLocaleString()}</div>
                  ${passiveTSS > 0 ? `<div style="font-size:11px;color:${TEXT_L};margin-top:6px">${passiveTSS} passive TSS from background activity</div>` : ''}`;
              }
              const emptyNote = isToday
                ? "Garmin hasn't pushed today's data yet. Refresh the Garmin Connect app to sync."
                : 'No step data for this day';
              return `
                <div style="font-size:28px;font-weight:300;color:${TEXT_L};line-height:1">\u2014</div>
                <div style="font-size:11px;color:${TEXT_L};margin-top:6px">${emptyNote}</div>`;
            })()}
          </div>
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

// ── Info overlay ──────────────────────────────────────────────────────────────

function showStrainInfoOverlay(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:300;
    display:flex;align-items:center;justify-content:center;padding:20px;
    background:rgba(0,0,0,0.5);
  `;
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px;padding:24px;max-width:380px;width:100%">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="font-size:17px;font-weight:700;margin:0;color:${TEXT_M}">What is Today's Strain?</h2>
        <button id="strain-info-close" style="
          border:none;background:rgba(0,0,0,0.07);border-radius:50%;
          width:32px;height:32px;cursor:pointer;color:${TEXT_S};
          display:flex;align-items:center;justify-content:center;font-size:16px;
        ">✕</button>
      </div>
      <p style="font-size:14px;line-height:1.6;color:${TEXT_S};margin:0 0 12px">
        The ring shows total physiological load (TSS) for the day. Colour changes as load increases relative to the target range.
      </p>
      <p style="font-size:14px;line-height:1.6;color:${TEXT_S};margin:0 0 12px">
        Load includes logged activities plus passive strain from steps and unlogged movement. Uses <strong>Signal B</strong> (raw physiological load, no sport discount).
      </p>
      <p style="font-size:14px;line-height:1.6;color:${TEXT_S};margin:0 0 16px">
        The target adjusts based on readiness. When recovery is suppressed, the target drops automatically.
      </p>
      <div style="background:#F0F6FF;border-radius:14px;padding:14px">
        <div style="font-size:11px;font-weight:600;color:#007AFF;margin-bottom:10px;letter-spacing:0.05em">RING COLOURS</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:2">
          <div><strong style="color:#007AFF">Blue</strong>: building toward the target range</div>
          <div><strong style="color:#34C759">Green</strong>: inside target range</div>
          <div><strong style="color:#FF3B30">Red</strong>: above target range, load exceeded</div>
          <div style="margin-top:4px;font-size:12px"><span style="letter-spacing:0.1em;opacity:0.5">· · ·</span> Dotted arc marks the target zone</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('strain-info-close')?.addEventListener('click', () => overlay.remove());
}

// ── Handlers ──────────────────────────────────────────────────────────────────

let strainOnBack: (() => void) | null = null;

function wireStrainHandlers(s: SimulatorState, _displayDate: string, _todayReadinessLabel?: ReadinessLabel | null): void {
  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Ring sweep animation — same pattern as readiness-view.ts
  setTimeout(() => {
    const circle = document.getElementById('strain-ring-circle');
    const target = (circle as HTMLElement | null)?.dataset.targetOffset;
    if (circle && target) (circle as unknown as SVGCircleElement).style.strokeDashoffset = target;
  }, 50);

  // Back → caller (defaults to home)
  document.getElementById('strain-back-btn')?.addEventListener('click', () => {
    if (strainOnBack) { strainOnBack(); return; }
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  // Date picker toggle
  const picker = document.getElementById('strain-date-picker');
  document.getElementById('strain-date-btn')?.addEventListener('click', () => {
    if (!picker) return;
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });

  // Date pill selection
  document.querySelectorAll<HTMLElement>('.strain-date-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      if (date) renderStrainView(date);
    });
  });

  // Info overlay
  document.getElementById('strain-info-btn')?.addEventListener('click', () => showStrainInfoOverlay());

  // Timeline activity detail — navigate to full activity detail page
  document.querySelectorAll<HTMLElement>('.strain-act-row').forEach(row => {
    row.addEventListener('click', () => {
      const gid = row.dataset.garminId;
      if (!gid) return;
      const act = (s.wks ?? [])
        .flatMap(wk => Object.values(wk.garminActuals ?? {}))
        .find(a => a.garminId === gid);
      if (!act) return;
      const name = act.displayName || act.workoutName || formatActivityType(act.activityType ?? '') || 'Activity';
      import('./activity-detail').then(({ renderActivityDetail }) => {
        renderActivityDetail(act, name, 'strain');
      });
    });
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderStrainView(date?: string, readinessLabel?: ReadinessLabel | null, onBack?: () => void): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const today = new Date().toISOString().split('T')[0];
  const displayDate = date ?? today;
  strainOnBack = onBack ?? strainOnBack;
  container.innerHTML = getStrainHTML(s, displayDate, readinessLabel);
  wireStrainHandlers(s, displayDate, readinessLabel);
}
