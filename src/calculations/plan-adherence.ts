import type { SimulatorState, Week, GarminActual } from '@/types';
import { wasIllnessRestDay } from './illness-rules';
import { firstTrackedDow } from '@/ui/workout-status';

/** ISO 'YYYY-MM-DD' date `days` after `iso` (noon-UTC to dodge DST/timezone). */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** How many days in plan week `weekIdx` were full-REST under an active/recent
 *  illness. Subtracted from that week's run denominator so a medically-rested
 *  week isn't scored as missed runs. Capped by the caller. */
function illnessRestDaysInWeek(s: SimulatorState, weekIdx: number): number {
  const illness = (s as any).illnessState;
  if (!illness?.schedule?.length || !s.planStartDate) return 0;
  const weekStart = addDaysISO(s.planStartDate, weekIdx * 7);
  let count = 0;
  for (let d = 0; d < 7; d++) {
    if (wasIllnessRestDay(illness, addDaysISO(weekStart, d))) count++;
  }
  return count;
}

/** Runs that were never scheduled because the user onboarded mid-week.
 *
 *  Week 1 is anchored to this Monday but the days before onboarding are dropped
 *  (reduced partial first week — see dropPreOnboardSessions). Those days' runs
 *  never existed, so they must not count as "missed" once week 1 is scored.
 *  Pro-rata the weekly run target by the fraction of the week that fell before
 *  onboarding: `s.rw × firstTrackedDow / 7`. Arithmetic on real quantities (the
 *  user's own runs-per-week and the actual onboarding weekday), not an invented
 *  constant. Returns 0 for every week except the onboarding week (firstTrackedDow
 *  is 0 once creation predates the week's start). */
function preOnboardDroppedRunsInWeek(s: SimulatorState, weekIdx: number): number {
  const ftd = firstTrackedDow(s.planStartDate, weekIdx + 1, s.planCreatedAt);
  if (ftd <= 0 || !s.rw) return 0;
  return Math.round(s.rw * ftd / 7);
}

/** Distance-completion threshold: a planned run counts as completed
 *  when the actual distance is at least 95% of the target distance. */
export const ADHERENCE_THRESHOLD = 0.95;

/** Keywords that indicate a non-run activity when scanning garminActuals keys. */
const NON_RUN_KEYWORDS = [
  'cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl',
  'tennis', 'hiit', 'pilates', 'row', 'hik', 'elliptic', 'walk',
];

function isRunningActual(key: string, activityType?: string | null): boolean {
  if (activityType) {
    const at = activityType.toUpperCase();
    return at === 'RUNNING' || at.includes('RUN');
  }
  const k = key.toLowerCase();
  return !NON_RUN_KEYWORDS.some(kw => k.includes(kw));
}

export interface PlanAdherenceResult {
  /** Adherence percentage (0-100), or null if there is not enough data yet */
  pct: number | null;
  /** Planned runs counted in the denominator */
  totalPlanned: number;
  /** Planned runs completed to ≥95% of target distance */
  totalCompleted: number;
  /** Number of past weeks that contributed at least one planned run */
  weeksIncluded: number;
}

/**
 * Compute running plan adherence across completed training weeks.
 *
 * Uses garminActuals as ground truth for completions: each entry with a
 * non-null `plannedDistanceKm` represents a Strava activity that was matched
 * to a planned run slot. The `plannedDistanceKm` is set at match time from
 * the (post-reduction) workout description, so it already reflects any
 * cross-training reductions.
 *
 * Denominator uses s.rw (runs per week) minus any pushed-forward workouts,
 * which is stable regardless of VDOT changes between sessions.
 *
 * Scope rules:
 *  - Cross-training and non-run workouts are excluded entirely.
 *  - Ad-hoc runs (not in the plan) have no `plannedDistanceKm` and are skipped.
 *  - The current in-progress week is excluded so the number doesn't drop
 *    every Monday.
 *  - Runs pushed to the following week (via week-debrief) are subtracted
 *    from the source week's denominator.
 */
export function computePlanAdherence(s: SimulatorState, nWeeks?: number): PlanAdherenceResult {
  const empty: PlanAdherenceResult = {
    pct: null,
    totalPlanned: 0,
    totalCompleted: 0,
    weeksIncluded: 0,
  };

  const currentWeek = s.w ?? 0;
  if (currentWeek < 2 || !s.wks || !s.rw) return empty;

  let totalPlanned = 0;
  let totalCompleted = 0;
  let weeksIncluded = 0;

  // Trailing-window scope: when `nWeeks` is given, only the last `nWeeks`
  // completed weeks contribute (mirrors computeTriPlanAdherence). Without it,
  // every completed week since onboarding contributes (the cumulative number).
  const lastCompletedIdx = currentWeek - 2; // inclusive, 0-based
  const firstIdx = nWeeks !== undefined ? Math.max(0, lastCompletedIdx - nWeeks + 1) : 0;

  for (let idx = firstIdx; idx < currentWeek - 1; idx++) {
    const wk = s.wks[idx];
    if (!wk) continue;

    // ── Numerator: count completed runs from garminActuals ──────────────
    // A garminActuals entry is a planned-run completion if:
    //  - activityType is RUNNING (or key doesn't match non-run keywords)
    //  - it was matched to a planned slot: has workoutName, plannedType,
    //    or plannedDistanceKm (ad-hoc entries have none of these)
    // If plannedDistanceKm is available, apply the 95% distance check.
    // If not (older entries, or description had no km token), count the
    // match itself as completion. It was matched to the plan.
    let weekCompleted = 0;
    for (const [key, actual] of Object.entries(wk.garminActuals || {}) as [string, GarminActual][]) {
      if (!isRunningActual(key, actual.activityType)) continue;

      const isPlannedMatch = actual.plannedDistanceKm != null
        || actual.workoutName != null
        || actual.plannedType != null;
      if (!isPlannedMatch) continue;

      if (actual.plannedDistanceKm != null && actual.plannedDistanceKm > 0) {
        // Distance check available. Apply 95% threshold
        if (actual.distanceKm >= ADHERENCE_THRESHOLD * actual.plannedDistanceKm) {
          weekCompleted++;
        }
      } else {
        // Matched to a planned slot but no target distance. Count as completed
        weekCompleted++;
      }
    }

    // ── Denominator: planned runs this week ─────────────────────────────
    // Start from s.rw (stable runs-per-week setting), then subtract any
    // runs that were pushed to the following week via week-debrief.
    const nextWk: Week | undefined = s.wks[idx + 1];
    const pushedCount = (nextWk?.skip ?? []).length;
    // Mid-week onboarding: runs on the dropped pre-onboard days never existed.
    const preOnboardDropped = preOnboardDroppedRunsInWeek(s, idx);
    // Illness-rested days don't count as missed runs (the illness banner
    // promises adherence is unaffected). Subtract them like pushed sessions.
    const illnessRest = Math.min(illnessRestDaysInWeek(s, idx), Math.max(0, s.rw - pushedCount - preOnboardDropped));
    const weekPlanned = Math.max(0, s.rw - pushedCount - illnessRest - preOnboardDropped);

    if (weekPlanned <= 0) continue;

    totalPlanned += weekPlanned;
    totalCompleted += Math.min(weekCompleted, weekPlanned);
    weeksIncluded++;
  }

  if (totalPlanned === 0) return { ...empty, weeksIncluded };

  return {
    pct: Math.round((totalCompleted / totalPlanned) * 100),
    totalPlanned,
    totalCompleted,
    weeksIncluded,
  };
}

// ─── Chronic low-adherence detector (ISSUE-296) ──────────────────────────────
// The plan already self-regulates per-week via wkGain scaling, but it never
// flags a *sustained* under-delivery pattern back to the user. These thresholds
// (Tristan, 2026-06-17): fire only when the trailing window of completed weeks
// shows < 70% adherence across at least 3 weeks of real planned training. The
// 70% floor is deliberately conservative so a single rough week, or a runner
// deliberately running a little less, doesn't trip it.
export const CHRONIC_ADHERENCE_WINDOW_WEEKS = 3;
export const CHRONIC_ADHERENCE_THRESHOLD_PCT = 70;

export interface ChronicAdherenceSignal {
  /** Trailing-window adherence percentage that tripped the threshold. */
  pct: number;
  /** Weeks of real planned training in the window (≥ CHRONIC_ADHERENCE_WINDOW_WEEKS). */
  weeks: number;
}

/**
 * Given a trailing-window adherence result (running `PlanAdherenceResult` or
 * triathlon `TriPlanAdherenceResult` — both share `{ pct, weeksIncluded }`),
 * return the chronic-low-adherence signal when the pattern is sustained, else
 * null. Mode-agnostic so running and triathlon debriefs read from one source.
 *
 * Caller must pass a result computed over a trailing window of
 * `CHRONIC_ADHERENCE_WINDOW_WEEKS` (i.e. `computePlanAdherence(s, 3)` /
 * `computeTriPlanAdherence(s, 3)`), so `weeksIncluded` reflects the window.
 */
export function detectChronicLowAdherence(
  windowResult: { pct: number | null; weeksIncluded: number },
): ChronicAdherenceSignal | null {
  if (windowResult.pct == null) return null;
  if (windowResult.weeksIncluded < CHRONIC_ADHERENCE_WINDOW_WEEKS) return null;
  if (windowResult.pct >= CHRONIC_ADHERENCE_THRESHOLD_PCT) return null;
  return { pct: windowResult.pct, weeks: windowResult.weeksIncluded };
}
