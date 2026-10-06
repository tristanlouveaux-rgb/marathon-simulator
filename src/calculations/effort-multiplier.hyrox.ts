/**
 * HYROX execution → next-week-load multiplier. The HYROX analogue of running's
 * `effortMultiplier` (`plan_engine.ts:134`) and tri's `triEffortMultiplier`.
 *
 * **Why HYROX needs this**: `plan_engine.hyrox.ts` was purely phase-driven — crush a
 * week or bomb it, the next week's prescription was identical. This closes the
 * execution-feedback gap (P2 of CROSS_MODE_PARITY_PLAN.md, SCIENCE_LOG §AU).
 *
 * **Signal — RPE across ALL HYROX sessions** (stations, bricks, run legs). Decisions
 * (Tristan, 2026-06-01):
 *   - D5b: yes, HYROX should adapt to execution.
 *   - Scope: all HYROX sessions (one integrated sport), not stations alone.
 *   - Signal: RPE-primary. The objective station-adherence signal (achieved vs target)
 *     does NOT exist for synced activities (Strava/Garmin give only "station session" +
 *     total time, no per-station reps/times) and would need a target-capture refactor for
 *     guided sessions. RPE is the only signal present on every session, so the loop is
 *     RPE-driven now; an objective 60/40 blend (mirroring bike/swim) is a later,
 *     guided-only enhancement. HR is rejected — intermittent station intervals make HR
 *     lag the work and there is no clean per-station target IF to score against.
 *
 * **Why volume is the right lever for HYROX**: race implements are fixed at division
 * weight, so the athlete progresses by work capacity at that weight (more rounds/reps,
 * less rest), not by adding load. Scaling the weekly hours budget scales rounds/volume —
 * exactly the HYROX progression lever.
 *
 * **Side of the line**: planning. Pure function over state.
 *
 * effortScore scale: positive = harder than planned → multiplier < 1 → lighter next week.
 *                    negative = easier than planned → multiplier > 1 → heavier next week.
 * Returns 0 (neutral, multiplier 1.0) when there's no rated data.
 */

import type { SimulatorState } from '@/types/state';
import {
  TRI_EFFORT_LOOKBACK_WEEKS,
  TRI_EFFORT_MULT_BOUNDS,
} from '@/constants/triathlon-constants';

/**
 * Trailing RPE-vs-expected effort score over the last `TRI_EFFORT_LOOKBACK_WEEKS`
 * completed weeks, across every HYROX session (no discipline filter). Skipped and
 * unrated workouts are excluded. Mirrors `triTrailingEffortScore` but RPE-only and
 * discipline-agnostic, since HYROX is a single integrated sport.
 */
export function hyroxTrailingEffortScore(state: SimulatorState): number {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const samples: number[] = [];
  // s.w is 1-based, so wks[currentWeek - 1] is the week in progress. Start at
  // the last COMPLETED week (wks[currentWeek - 2]), as running's
  // getTrailingEffortScore does: a mid-week regeneration or the live plan note
  // must not rescale the current week by its own partial ratings. At rollover
  // the new week is empty, so the result there is unchanged.
  for (let w = currentWeek - 2; w >= 0 && samples.length < TRI_EFFORT_LOOKBACK_WEEKS; w--) {
    const wk = wks[w];
    if (!wk?.triWorkouts || !wk.rated) continue;
    const weekDeviations: number[] = [];
    for (const workout of wk.triWorkouts) {
      if (!workout.id) continue;
      const expected = (workout as { rpe?: number }).rpe ?? workout.r;
      if (expected == null) continue;
      const rated = wk.rated[workout.id];
      if (typeof rated !== 'number') continue;
      const rpeDev = rated - expected;

      // Under-duration guard (mirrors tri): a session cut to < 80% of planned
      // duration was not genuinely easy, so don't let a low RPE inflate next week.
      // The session's record: its match link when set (tri-style), else the
      // record on its slot key. HYROX never sets matchedActivityId: the matcher,
      // GPS runs, Mark as Done and quick done all key the record by the slot id,
      // the same slot-record rule isMtlSessionCompleted (mtl.ts) reads. Reading
      // the link alone left the guard blind in HYROX.
      const actual = wk.garminActuals?.[workout.matchedActivityId ?? workout.id];
      const plannedMin = workout.estimatedDurationMin;
      const actualMin = actual ? (actual.durationSec ?? 0) / 60 : null;
      const underDuration = plannedMin != null && actualMin != null && actualMin < plannedMin * 0.8;

      weekDeviations.push(underDuration ? Math.max(0, rpeDev) : rpeDev);
    }
    if (weekDeviations.length > 0) {
      samples.push(weekDeviations.reduce((a, b) => a + b, 0) / weekDeviations.length);
    }
  }
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/**
 * HYROX effort multiplier. Identical formula to running/tri: `1 - score * 0.05`,
 * clamped to [0.85, 1.15]. Folds into the weekly hours budget in `plan_engine.hyrox.ts`
 * (multiplicatively, on top of phase + deload — mirrors running's `dMult` composition).
 */
export function hyroxEffortMultiplier(state: SimulatorState): number {
  const score = hyroxTrailingEffortScore(state);
  const raw = 1 - score * 0.05;
  return Math.max(TRI_EFFORT_MULT_BOUNDS[0], Math.min(TRI_EFFORT_MULT_BOUNDS[1], raw));
}
