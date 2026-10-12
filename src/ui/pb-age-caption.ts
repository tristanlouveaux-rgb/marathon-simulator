/**
 * PB age caption (feature-reveal order: inline caption next to the number).
 *
 * PBs display exactly as entered or synced, while the fitness model weighs a
 * dated PB by its age on a smooth 3-year half-life (pbAgeWeight, SCIENCE_LOG
 * §DC). Every surface whose numbers that ageing changes carries the same
 * one-line caption, shown only when ageing changes a number the surface
 * displays by at least a whole second (adaptation-transparency rule: no note
 * that changes nothing; orchestrator default 2026-10-12). The weight is
 * continuous, so the copy names no age cut-off. Single source for the copy and
 * the rule, so the surfaces cannot drift apart.
 */
import type { SimulatorState } from '@/types';
import { pbAgeingActive, withPbAgeingSuspended } from '@/calculations/physiological-vdot';
import { computePredictionInputs, collectRunsFromState } from '@/calculations/prediction-inputs';
import { raceEffortHrFloorForState } from '@/calculations/heart-rate';
import { refreshBlendedFitness, predictStandardDistances } from '@/calculations/blended-fitness';

/**
 * The numbers a surface displays, from a state: race times in seconds, or a
 * pace in s/km. Computed twice, on the refreshed state with and without PB
 * ageing; null entries are skipped.
 */
export type PbAgeDisplayed = (st: SimulatorState) => ReadonlyArray<number | null | undefined>;

/** The four standard-distance predictions (Stats race estimates, the
 *  no-target-race Forecast). */
export const standardDistancesDisplayed: PbAgeDisplayed = (st) => Object.values(predictStandardDistances(st));

/** A displayed number counts as changed from a whole second (or s/km) on. */
const MIN_DISPLAYED_CHANGE = 1;

/**
 * `displayed` on a copy of `s` after the launch refresh, with or without PB
 * ageing. The copy is shallow: refreshBlendedFitness reassigns top-level
 * fields, and the one nested value it mutates in place (vdotHistory, in
 * recordVdotHistoryPoint) is copied, so the live state is never touched.
 * Both sides refresh, so only ageing separates them.
 */
function displayedAfterRefresh(s: SimulatorState, displayed: PbAgeDisplayed, unaged: boolean): ReadonlyArray<number | null | undefined> {
  const compute = () => {
    const copy = { ...s, vdotHistory: s.vdotHistory ? [...s.vdotHistory] : s.vdotHistory } as SimulatorState;
    refreshBlendedFitness(copy);
    return displayed(copy);
  };
  return unaged ? withPbAgeingSuspended(compute) : compute();
}

/** Whether PB ageing moves any displayed number by at least a whole second. */
export function pbAgeChangesDisplayed(s: SimulatorState, displayed: PbAgeDisplayed): boolean {
  const aged = displayedAfterRefresh(s, displayed, false);
  const unaged = displayedAfterRefresh(s, displayed, true);
  return aged.some((a, i) => {
    const u = unaged[i];
    return a != null && u != null && Number.isFinite(a) && Number.isFinite(u) && Math.abs(a - u) >= MIN_DISPLAYED_CHANGE;
  });
}

/**
 * The caption when PB age changes a number this surface displays, else null.
 * `subject` names what the numbers are on that surface ("these estimates",
 * "this forecast", "the run forecast"); `displayed` computes them.
 * `pbAgeingActive` (a volume-gated weight below 1) is the cheap first gate.
 */
export function pbAgeCaptionText(
  s: SimulatorState,
  subject: string,
  displayed: PbAgeDisplayed,
  now: Date = new Date(),
): string | null {
  const pbs = s.pbs ?? {};
  if (!(pbs.k5 || pbs.k10 || pbs.h || pbs.m)) return null;
  const inputs = computePredictionInputs(collectRunsFromState(s), now, raceEffortHrFloorForState(s));
  if (!pbAgeingActive(pbs, s, inputs, now)) return null;
  return pbAgeChangesDisplayed(s, displayed) ? `Older PBs carry less weight in ${subject}.` : null;
}
