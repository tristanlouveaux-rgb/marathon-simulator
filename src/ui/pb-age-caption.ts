/**
 * PB age caption (feature-reveal order: inline caption next to the number).
 *
 * PBs display exactly as entered or synced, while the fitness model gives a PB
 * older than PB_FULL_WEIGHT_YEARS less weight (SCIENCE_LOG §DC). Every surface
 * whose numbers that ageing changes carries the same one-line caption, shown
 * only when ageing changes them: `pbAgeingActive` on the shared
 * measured-volume gate, over the same runs (`collectRunsFromState`) and race
 * HR floor as `refreshBlendedFitness`. Single source for the copy, so the
 * surfaces cannot drift apart.
 */
import type { SimulatorState } from '@/types';
import { pbAgeingActive, PB_FULL_WEIGHT_YEARS } from '@/calculations/physiological-vdot';
import { computePredictionInputs, collectRunsFromState } from '@/calculations/prediction-inputs';
import { raceEffortHrFloorForState } from '@/calculations/heart-rate';

/**
 * The caption when PB age changes the model for this state, else null.
 * `subject` names what the numbers are on that surface ("these estimates",
 * "this forecast", "the run forecast").
 */
export function pbAgeCaptionText(s: SimulatorState, subject: string, now: Date = new Date()): string | null {
  const pbs = s.pbs ?? {};
  if (!(pbs.k5 || pbs.k10 || pbs.h || pbs.m)) return null;
  const inputs = computePredictionInputs(collectRunsFromState(s), now, raceEffortHrFloorForState(s));
  return pbAgeingActive(pbs, s, inputs, now)
    ? `PBs older than ${PB_FULL_WEIGHT_YEARS} years carry less weight in ${subject}.`
    : null;
}
