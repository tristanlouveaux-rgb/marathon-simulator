/**
 * Run skill slider → run pace and VDOT, for triathletes.
 *
 * Kept in its own light module (types plus `RACE_LEG_DISTANCES`) so the
 * physiology chain (`physiological-vdot.ts`, read by the LT derivation in
 * `ltSync.ts`) can use the triathlon cold-start run cap without importing the
 * whole triathlon race predictor, which itself imports `physiological-vdot.ts`.
 * `race-prediction.triathlon.ts` re-exports `estimateRunPaceFromSkill`.
 */

import type { TriSkillSlider, TriathlonDistance } from '@/types/triathlon';
import { RACE_LEG_DISTANCES } from '@/constants/triathlon-constants';
import { cv } from './vdot';

export function estimateRunPaceFromSkill(skill: TriSkillSlider, distance: TriathlonDistance): number {
  // byLevel is the reference run-leg pace at Ironman (marathon) distance. Scale to
  // the actual run-leg distance via Riegel's power law (T ∝ d^1.06, so pace ∝ d^0.06;
  // Riegel 1981) — shorter legs are run faster. Replaces the old flat 70.3 −15s
  // offset with a principled, distance-general law. Deepest fallback (skill only).
  const byLevel: Record<TriSkillSlider, number> = { 1: 420, 2: 360, 3: 300, 4: 260, 5: 225 };
  const runKm = RACE_LEG_DISTANCES[distance].runKm;
  const IM_RUN_KM = RACE_LEG_DISTANCES.ironman.runKm;
  return byLevel[skill] * Math.pow(runKm / IM_RUN_KM, 0.06);
}

/**
 * The run skill slider as a VDOT: the slider's Ironman (marathon) run pace,
 * converted with Daniels' `cv()`. Run skill 3 (5:00/km for 42.195 km) is 44.3.
 * This is the figure the triathlon cold-start cap holds the engine VDOT and the
 * LT input at (`triColdStartRunCapVdot`, physiological-vdot.ts). Null for a
 * non-positive result.
 */
export function runSkillVdot(skill: TriSkillSlider): number | null {
  const v = cv(42195, estimateRunPaceFromSkill(skill, 'ironman') * 42.195);
  return v > 0 ? v : null;
}
