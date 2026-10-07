/**
 * Triathlon plan adherence. % of planned tri sessions completed across
 * past training weeks. Mirrors the running adherence helper but is much
 * simpler because tri workouts aren't matched 1:1 to a single activity
 * (no `workoutName`/`plannedDistanceKm` shape). We compare planned
 * session counts vs synced session counts per week instead.
 *
 * **Tracking, not planning** (per CLAUDE.md): describes adherence to date.
 * Future iterations could match per-discipline (planned swim count vs
 * actual swim count) for finer detail; the count-based approach is
 * deliberately coarse so a swim+bike+run week with one missed swim still
 * reads as ~67% rather than 100%.
 */

import type { SimulatorState, GarminActual, Workout } from '@/types';
import { sportToTransferSource } from '@/constants/transfer-matrix';
import { inAppRecordDiscipline } from '@/calculations/in-app-activity';

/**
 * Whether a planned tri session counts toward adherence. Only swim/bike/run
 * (and bricks, which produce bike+run actuals) have a creditable actual in the
 * swim/bike/run numerator. Gym/strength and any cross-training (rugby, etc.)
 * are excluded from BOTH sides — counting them as "planned" would drag the
 * number down for sessions the numerator can never credit. (Tristan, 2026-06-17)
 */
function isScorableTriSession(w: Workout): boolean {
  const d = w.discipline;
  if (d === 'swim' || d === 'bike' || d === 'run' || d === 'brick') return true;
  if (d != null) return false; // 'station' or other non-SBR discipline
  // No discipline tag (older stored sessions): fall back to the type field.
  return w.t !== 'gym' && w.t !== 'strength';
}

export interface TriPlanAdherenceResult {
  /** Adherence percentage (0-100), or null when there isn't enough data yet. */
  pct: number | null;
  totalPlanned: number;
  totalCompleted: number;
  weeksIncluded: number;
}

/**
 * Per-week: count `triWorkouts.length` as planned, count swim/bike/run
 * actuals as completed, synced or in-app (a GPS run, a session marked done),
 * clamped at planned to avoid 'extra session' weeks reading as >100%.
 *
 * The current in-progress week is excluded so the number doesn't drop
 * every Monday. Rest weeks (zero planned) are skipped entirely.
 */
export function computeTriPlanAdherence(s: SimulatorState, nWeeks?: number): TriPlanAdherenceResult {
  const empty: TriPlanAdherenceResult = {
    pct: null,
    totalPlanned: 0,
    totalCompleted: 0,
    weeksIncluded: 0,
  };

  const currentWeek = s.w ?? 0;
  if (currentWeek < 2 || !s.wks) return empty;

  let totalPlanned = 0;
  let totalCompleted = 0;
  let weeksIncluded = 0;

  const lastCompletedIdx = currentWeek - 2; // inclusive
  const firstIdx = nWeeks !== undefined ? Math.max(0, lastCompletedIdx - nWeeks + 1) : 0;

  for (let idx = firstIdx; idx < currentWeek - 1; idx++) {
    const wk = s.wks[idx];
    if (!wk) continue;

    // Only swim/bike/run/brick count; gym + cross-training are excluded so a
    // strength or rugby session never reads as a missed tri session.
    const weekPlanned = (wk.triWorkouts ?? []).filter(isScorableTriSession).length;
    if (weekPlanned <= 0) continue;

    let weekCompleted = 0;
    const seen = new Set<string>();
    for (const actual of Object.values(wk.garminActuals ?? {}) as GarminActual[]) {
      if (actual.garminId && seen.has(actual.garminId)) continue;
      if (actual.garminId) seen.add(actual.garminId);
      const d = disciplineOf(actual);
      if (d === 'swim' || d === 'bike' || d === 'run') weekCompleted++;
    }

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

function disciplineOf(a: GarminActual): 'swim' | 'bike' | 'run' | null {
  const manual = a.manualSport;
  if (manual === 'swimming') return 'swim';
  if (manual === 'cycling') return 'bike';
  if (manual === 'running' || manual === 'extra_run') return 'run';
  const mapped = sportToTransferSource(a.activityType ?? '');
  if (mapped === 'swim' || mapped === 'bike' || mapped === 'run') return mapped;
  // An in-app record carries no activityType: a run marked done or recorded
  // with the app GPS counts as a run, as a bike or swim marked done counts by
  // its sport tag above.
  return inAppRecordDiscipline(a);
}
