/**
 * Triathlon plan engine entry point.
 *
 * Phase 1: skeleton only. Phase 3 implements generation. Kept as a separate
 * module from `plan_engine.ts` so the running engine is untouched (§18.1).
 *
 * The scheduler, workout libraries, and session selection live in adjacent
 * files (`scheduler.triathlon.ts`, `swim.ts`, `bike.ts`, `brick.ts`). This
 * file is the single top-level entry the rest of the app calls when
 * `SimulatorState.eventType === 'triathlon'`.
 */

import type { SimulatorState, Week } from '../types/state';

/**
 * Generate a full triathlon plan for the current state.
 *
 * Phase 1 STATUS: skeleton. Returns an empty plan so the running flow is
 * unaffected while the rest of the infrastructure is built. Phase 3 fills
 * this in.
 */
export function generateTriathlonPlan(_state: SimulatorState): Week[] {
  // TODO(Phase 3): implement per-discipline session selection, multi-sport
  // scheduler, brick placement, phase-aware volume ramping.
  return [];
}

/**
 * Regenerate a single triathlon week (for re-plan after a skip or ACWR spike).
 * Phase 1 skeleton.
 */
export function regenerateTriathlonWeek(_state: SimulatorState, _weekIndex: number): Week | null {
  // TODO(Phase 3)
  return null;
}
