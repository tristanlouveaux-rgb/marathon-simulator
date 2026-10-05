/**
 * ACWR-reduction projection — the canonical "would reducing even do anything?"
 * check (2026-06-04 dogfood: the Home 'Reduce session load' button appeared,
 * was tapped, and the handler silently concluded the week was already on
 * target. A nudge button and its handler must share one source of truth).
 *
 * Projects the week's final Signal-B TSS: actuals so far + decayed carry from
 * previous weeks + the remaining planned runs valued at the canonical
 * type-keyed rate (plannedTssPerMin — ISSUE-263). If that lands at or under
 * the planned target, there is nothing to cut and no reduction should be
 * offered.
 *
 * Used by BOTH `triggerACWRReduction` (main-view) and the Home readiness
 * nudge's button-visibility logic (home-view). Quality rule: two surfaces,
 * one computation.
 */
import type { SimulatorState } from '@/types/state';
import { computeWeekRawTSS } from './fitness-model';
import { computePlannedWeekTarget, computeCurrentWeekCarry } from './planned-week-target';
import { plannedTssPerMin } from '@/constants';

export interface AcwrReductionProjection {
  /** Projected end-of-week Signal-B TSS (actuals + carry + remaining planned runs). */
  projected: number;
  /** Planned Signal-B target for the week. */
  target: number;
  /** Whether the projection exceeds the target — i.e. a reduction would act. */
  over: boolean;
}

/** Minimal structural view of a planned run (both PlannedRun shapes satisfy it). */
export interface ProjectionRun {
  workoutType: string;
  plannedDistanceKm: number;
  status: string;
}

/**
 * Returns null when no planned Signal-B target exists (e.g. no baseline yet) —
 * callers should treat null as "cannot judge, allow the reduction path".
 */
export function computeAcwrReductionProjection(
  s: SimulatorState,
  plannedRuns: ProjectionRun[],
): AcwrReductionProjection | null {
  const wk = s.wks?.[s.w - 1];
  if (!wk) return null;

  const plannedB = computePlannedWeekTarget(s, s.w);
  if (!plannedB) return null;

  const currentTSS = computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate);
  const carried = computeCurrentWeekCarry(s, s.w);
  const paceMinPerKm = (s.pac?.e ?? 360) / 60;
  // Quality sessions run faster than easy pace; same 0.85 duration factor the
  // original inline computation used for RPE≥7 types.
  const FAST_TYPES = new Set(['threshold', 'race_pace', 'float', 'vo2', 'intervals', 'hill_repeats']);
  const remainingRunTSS = plannedRuns
    .filter(r => r.status === 'planned')
    .reduce((sum, r) => {
      const durMin = r.plannedDistanceKm * paceMinPerKm * (FAST_TYPES.has(r.workoutType) ? 0.85 : 1.0);
      return sum + durMin * plannedTssPerMin(r.workoutType);
    }, 0);

  const projected = currentTSS + (carried ?? 0) + remainingRunTSS;
  return { projected, target: plannedB, over: projected > plannedB };
}
