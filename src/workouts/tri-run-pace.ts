/**
 * The easy pace the triathlon generator writes run legs from, and the one every
 * later rewrite of a tri run's pace tokens must anchor to.
 *
 * generateTriathlonPlan (plan_engine.triathlon.ts) writes each run leg's easy,
 * threshold and VO2 paces, and the easy warm-up / cool-down, from
 * gp(s.v, s.lt).e when a VDOT is set, else from the run skill slider
 * (easyPaceSecPerKmFromSkill). An accepted tri suggestion that changes a run's
 * type retargets those tokens (tri-suggestion-apply.ts), so it reads the same
 * source; reading the live pace table (s.pac, built from getEffectiveVdot in
 * events.ts) instead would show different rep paces for the same session
 * whenever effective VDOT differs from s.v. The Adjust overlay keeps tri runs
 * duration-only (workout-adjust-overlay.ts intensity mode 'none' for stored
 * run sessions), so it rewrites no tri run pace; its run-pace retarget is the
 * running-mode path, anchored to s.pac.
 *
 * PLANNING side. No new constants: the skill interpolation moved here verbatim
 * from plan_engine.triathlon.ts so both callers share it; tri-run-pace.test.ts
 * pins triRunEasyPaceSec against generated easy runs with and without a VDOT.
 */

import type { SimulatorState } from '@/types/state';
import type { TriSkillSlider } from '@/types/triathlon';
import { gp } from '@/calculations/paces';

/**
 * Rough Z2 easy pace in sec/km by skill slider. Lets us estimate distance
 * alongside duration for long runs so the user sees "~16 km (1h 45min)"
 * instead of bare minutes.
 */
export function easyPaceSecPerKmFromSkill(skill: TriSkillSlider): number {
  // Skill 1 → 7:00/km, 5 → 4:30/km (linear interpolation)
  return 420 - (skill - 1) * 37.5;
}

/** Easy pace (sec/km) the tri generator writes run legs from: gp(s.v, s.lt).e,
 *  else the run skill estimate (skill 3 when no rating is stored, the
 *  generator's default). */
export function triRunEasyPaceSec(state: SimulatorState): number {
  if (state.v) return gp(state.v, state.lt ?? null).e;
  const skill = (state.triConfig?.skillRating?.run ?? 3) as TriSkillSlider;
  return easyPaceSecPerKmFromSkill(skill);
}
