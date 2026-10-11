/**
 * Triathlon plan regeneration on a generator-version bump (main.ts launch
 * path). Moved out of main.ts (2026-10-11) so the launch can run it AFTER
 * refreshBlendedFitness: the generator bakes run paces from gp(s.v, s.lt)
 * into the stored run descriptions (plan_engine.triathlon), so a regen that
 * ran before the refresh wrote the previous launch's s.lt, and plans built
 * before the run-pace cap (2026-10-09) kept uncapped paces.
 *
 * When the stored `triConfig.generatorVersion` is older than
 * TRI_GENERATOR_VERSION, every week's generator-owned sessions are replaced
 * with fresh output. User-added sessions (`adhoc-` / `holiday-` ids: the
 * session generator, accepted suggestions, holiday bridges) are carried over
 * (real incident 2026-06-03: the v18 regen wiped an added Tuesday gym
 * session). Each week's actuals / rated / skip arrays stay on the week.
 *
 * PLANNING side: it rewrites the prescription, never what the athlete did.
 */

import type { SimulatorState } from '@/types/state';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';

/**
 * Regenerate the stored triathlon plan when its generator version is stale.
 * Returns true when the plan was regenerated (the caller saves state). Reads
 * the current s.v / s.lt, so run it after refreshBlendedFitness.
 */
export function applyTriGeneratorRegen(s: SimulatorState): boolean {
  if (s.eventType !== 'triathlon' || !s.triConfig) return false;
  const savedVersion = s.triConfig.generatorVersion ?? 0;
  if (savedVersion >= TRI_GENERATOR_VERSION) return false;
  const freshWeeks = generateTriathlonPlan(s);
  if (freshWeeks.length === 0) return false;
  for (let i = 0; i < Math.min(s.wks.length, freshWeeks.length); i++) {
    const userAdded = (s.wks[i].triWorkouts ?? []).filter(
      (w) => typeof w.id === 'string' && (w.id.startsWith('adhoc-') || w.id.startsWith('holiday-')),
    );
    s.wks[i].triWorkouts = [...freshWeeks[i].triWorkouts!, ...userAdded];
    s.wks[i].ph = freshWeeks[i].ph;
    // The closing week (a Monday to Wednesday race's own week) is part of the layout.
    if (freshWeeks[i].raceClosing) s.wks[i].raceClosing = true;
    else delete s.wks[i].raceClosing;
    // The race window's cut sessions (forecast dose only) follow the week.
    if (freshWeeks[i].raceWindowCut) s.wks[i].raceWindowCut = freshWeeks[i].raceWindowCut;
    else delete s.wks[i].raceWindowCut;
  }
  s.triConfig.generatorVersion = TRI_GENERATOR_VERSION;
  console.log(`[tri] plan regenerated (generator v${savedVersion} → v${TRI_GENERATOR_VERSION})`);
  return true;
}
