import type { SimulatorState, Week, GarminActual } from '@/types';

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
export function computePlanAdherence(s: SimulatorState): PlanAdherenceResult {
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

  for (let idx = 0; idx < currentWeek - 1; idx++) {
    const wk = s.wks[idx];
    if (!wk) continue;

    // ── Numerator: count completed runs from garminActuals ──────────────
    // A garminActuals entry is a planned-run completion if:
    //  - activityType is RUNNING (or key doesn't match non-run keywords)
    //  - it was matched to a planned slot: has workoutName, plannedType,
    //    or plannedDistanceKm (ad-hoc entries have none of these)
    // If plannedDistanceKm is available, apply the 95% distance check.
    // If not (older entries, or description had no km token), count the
    // match itself as completion — it was matched to the plan.
    let weekCompleted = 0;
    for (const [key, actual] of Object.entries(wk.garminActuals || {}) as [string, GarminActual][]) {
      if (!isRunningActual(key, actual.activityType)) continue;

      const isPlannedMatch = actual.plannedDistanceKm != null
        || actual.workoutName != null
        || actual.plannedType != null;
      if (!isPlannedMatch) continue;

      if (actual.plannedDistanceKm != null && actual.plannedDistanceKm > 0) {
        // Distance check available — apply 95% threshold
        if (actual.distanceKm >= ADHERENCE_THRESHOLD * actual.plannedDistanceKm) {
          weekCompleted++;
        }
      } else {
        // Matched to a planned slot but no target distance — count as completed
        weekCompleted++;
      }
    }

    // ── Denominator: planned runs this week ─────────────────────────────
    // Start from s.rw (stable runs-per-week setting), then subtract any
    // runs that were pushed to the following week via week-debrief.
    const nextWk: Week | undefined = s.wks[idx + 1];
    const pushedCount = (nextWk?.skip ?? []).length;
    const weekPlanned = Math.max(0, s.rw - pushedCount);

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
