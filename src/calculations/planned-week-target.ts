/**
 * Canonical planned weekly load target.
 *
 * PLANNING side of the tracking/planning line: this is what a plan week is
 * prescribed to load, in canonical TSS. Every surface that compares a week's
 * actual load with its plan target reads from here: the Plan week-summary card
 * and Adjust-week strip, Load & Taper, the week debrief, the excess-load
 * adjustment, the ACWR reduction projection, the week-advance settle, the
 * launch carry-over, the Stats forecast and the daily coach.
 *
 * Which modes can see it. The displaying surfaces (Plan card and Adjust-week
 * strip, Load & Taper, the running week debrief, Stats forecast) are the
 * running-plan views. Triathlon (cycling included, it runs as
 * eventType 'triathlon') and HYROX route to their own Plan, Load, Stats and
 * debrief views (main-view.ts, stats-view.ts, week-debrief.ts), none of which
 * read this target. In those modes it reaches the user only as the daily
 * coach's Signal A figure in the AI Coach context (`planned_week_tss`,
 * coach-context-builder.ts), plus bookkeeping that shows no number: the
 * week-advance settle and launch carry-over of `unspentLoadItems`, and for
 * HYROX the Home adjust-button gate (computeAcwrReductionProjection).
 *
 * Why it exists (audit A10/A11, 2026-09). Each caller used to build its own
 * `computePlannedSignalB(..., wk.ph, ..., undefined, undefined, ...)`:
 *   - `Week.ph` never holds 'deload', so the deload row of PHASE_MULTIPLIERS was
 *     dead and plan-engine deload weeks kept their base/build/peak target.
 *   - No caller knew the taper position, so every taper week (race week
 *     included) targeted 0.85 x baseline. Stats alone passed a 1-indexed
 *     position and disagreed with every other surface.
 *   - Batch 1 then passed a 0-indexed position (0.85 / 0.75 / 0.65), so race
 *     week never reached the ramp's 0.55 endpoint (audit follow-up ISSUE-317a).
 *   - `computeDecayedCarry` judged earlier weeks against the viewed week's
 *     target, so weeks done exactly to plan left phantom carry in the taper.
 *
 * The resolution reads the same plan data the generator does:
 *   - Deload, running: `forceDeload || isRunningDeloadWeek(weekNum, ability,
 *     ph, continuousMode)` with ability = abilityBandFromVdot(s.v || 45,
 *     experienceLevel || 'intermediate'), the inputs resolveWeekWorkouts
 *     (week-resolve.ts) hands generateWeekWorkouts: the ability cycle in a race
 *     plan, the block recovery week ('taper') in a continuous plan.
 *   - Deload, triathlon (cycling runs on the tri engine) and HYROX:
 *     `forceDeload || isFourWeekCycleDeloadWeek(weekNum, ph)`, the rule those
 *     engines generate with.
 *   - Race taper: the last contiguous run of 'taper' weeks in the plan. Its
 *     1-indexed position (1 = first taper week, taperWeeks = race week) feeds
 *     the existing taperMultiplier ramp: 0.75 / 0.65 / 0.55 over 3 weeks and
 *     0.70 / 0.55 over 2 (Tristan, 2026-10-05). A 1-week taper is race week
 *     alone and targets 0.55 too (taperFraction, phases.ts).
 *   - Any other 'taper'-labelled week is a recovery week, not a race taper:
 *     continuous mode labels each block's 4th (deload) week 'taper'
 *     (initialization.ts, events.ts block append) and double-periodization plans
 *     label the inter-cycle recovery weeks 'taper' (phases.ts). These take the
 *     tier's deload multiplier.
 *   - A race-taper week that the engine also deloads is cut twice by the
 *     generator (taper session scaling and dMult). Its target is the LOWER of
 *     the two existing targets. A product would be a new number that neither
 *     multiplier table defines.
 *   - Just-Track generates no plan, so no week counts as a deload there.
 */

import type { SimulatorState, TrainingPhase, Week } from '@/types';
import { computePlannedSignalB, computePlannedWeekTSS, computeDecayedCarry } from './fitness-model';
import { abilityBandFromVdot, isRunningDeloadWeek, isFourWeekCycleDeloadWeek, isSharpeningDeloadWeek } from '@/workouts/plan_engine';
import { isSharpeningBlock } from '@/workouts/phases';
import { planTrainingWeeks } from '@/workouts/race-week-layout';

/** The state fields the target reads. Structural so persistence's raw `migrated` object fits. */
export type PlannedTargetState = Pick<
  SimulatorState,
  | 'wks' | 'w' | 'v' | 'rw' | 'onboarding' | 'eventType' | 'continuousMode' | 'trackOnly'
  | 'historicWeeklyTSS' | 'ctlBaseline' | 'athleteTier' | 'athleteTierOverride'
  | 'sportBaselineByType' | 'planStartDate'
> & Partial<Pick<SimulatorState, 'rd'>>;

/** True when the running plan is a sharpening block (phases.ts isSharpeningBlock). */
function isRunningBlock(s: PlannedTargetState): boolean {
  if (s.trackOnly || s.continuousMode || s.eventType === 'triathlon' || s.eventType === 'hyrox') return false;
  return isSharpeningBlock(s.rd, planTrainingWeeks({ wks: s.wks }));
}

export interface PlannedWeekPhase {
  /** Phase key for computePlannedWeekTSS's multiplier lookup. */
  phase: TrainingPhase | 'deload';
  /** Race-taper weeks only: 1-indexed position inside the race taper (taperWeeks = race week). */
  weekInTaper?: number;
  /** Race-taper weeks only: length of the race taper. */
  taperWeeks?: number;
  /** Race-taper week the engine also deloads: target = min(taper, deload). */
  alsoDeload?: boolean;
}

/** True when the engine that generates this week runs it as a deload week. */
function isEngineDeloadWeek(s: PlannedTargetState, weekNum: number, wk: Week): boolean {
  if (s.trackOnly) return false;
  if ((wk as Week & { forceDeload?: boolean }).forceDeload) return true;
  if (s.eventType === 'triathlon' || s.eventType === 'hyrox') {
    return isFourWeekCycleDeloadWeek(weekNum, wk.ph);
  }
  const ability = abilityBandFromVdot(s.v || 45, s.onboarding?.experienceLevel || 'intermediate');
  // A sharpening block deloads build weeks only, never the week before the
  // taper (plan_engine isSharpeningDeloadWeek, the rule the block generates with).
  if (isRunningBlock(s)) {
    const trainingWeeks = planTrainingWeeks({ wks: s.wks });
    return isSharpeningDeloadWeek(weekNum, ability, (s.wks ?? []).slice(0, trainingWeeks).map(w => w.ph ?? 'base'));
  }
  // A continuous plan deloads its block recovery week ('taper') and no other,
  // a race plan the ability cycle (isRunningDeloadWeek, the engine's rule).
  return isRunningDeloadWeek(weekNum, ability, wk.ph, !!s.continuousMode);
}

/**
 * Resolve the effective phase of plan week `weekNum` (1-indexed) for the
 * weekly load target: deload status and race-taper position included.
 */
export function resolvePlannedWeekPhase(s: PlannedTargetState, weekNum: number): PlannedWeekPhase {
  const wks = s.wks ?? [];
  const idx = weekNum - 1;
  const wk = wks[idx];
  if (!wk) return { phase: 'base' };
  // A closing week (a Monday to Wednesday race's own week) holds only the race:
  // it targets the race-week row, and the taper run ends before it so the
  // taper's length and positions match a Sunday race's.
  if (wk.raceClosing && idx > 0) {
    const raceWeek = resolvePlannedWeekPhase(s, weekNum - 1);
    return raceWeek.phase === 'taper' ? { ...raceWeek, alsoDeload: false } : { phase: 'taper', weekInTaper: 1, taperWeeks: 1 };
  }
  const ph: TrainingPhase = wk.ph ?? 'base';
  const deload = isEngineDeloadWeek(s, weekNum, wk);

  if (ph !== 'taper') return { phase: deload ? 'deload' : ph };

  // Contiguous 'taper' run containing this week.
  let start = idx;
  while (start > 0 && wks[start - 1]?.ph === 'taper') start--;
  let end = idx;
  while (end < wks.length - 1 && wks[end + 1]?.ph === 'taper' && !wks[end + 1]?.raceClosing) end++;

  // Continuous (non-event) plans have no race, so every 'taper' week is a block
  // deload. Just-Track after a finished race plan keeps continuousMode = true,
  // but that plan's final taper was still a race taper.
  let isRaceTaper = !(s.continuousMode && !s.trackOnly);
  for (let i = end + 1; isRaceTaper && i < wks.length; i++) {
    if (wks[i]?.ph === 'taper' && !wks[i]?.raceClosing) isRaceTaper = false; // a later taper run exists: this one is a mid-plan recovery block
  }
  if (!isRaceTaper) return { phase: 'deload' };

  return {
    phase: 'taper',
    weekInTaper: idx - start + 1,
    taperWeeks: end - start + 1,
    // A sharpening block's taper weeks are never also deloads (the taper is the
    // block's reduction; buildSharpeningWeek ignores the deload cycle there).
    alsoDeload: deload && !isRunningBlock(s),
  };
}

/**
 * Planned weekly load target for plan week `weekNum` (1-indexed), canonical TSS.
 *
 * signal 'B' (default): full physiological load, all sports. Compare with
 *   computeWeekRawTSS. This is the target every running load surface shows.
 * signal 'A': running-equivalent target. Compare with computeWeekTSS only
 *   (daily coach week signal, sent to the AI Coach as `planned_week_tss` in
 *   every mode).
 */
export function computePlannedWeekTarget(
  s: PlannedTargetState,
  weekNum: number,
  signal: 'A' | 'B' = 'B',
): number {
  const r = resolvePlannedWeekPhase(s, weekNum);
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const ctl = s.ctlBaseline ?? undefined;
  const at = (phase: string, weekInPhase?: number, totalPhaseWeeks?: number): number => (
    signal === 'A'
      ? computePlannedWeekTSS(s.historicWeeklyTSS, ctl, phase, tier, s.rw, weekInPhase, totalPhaseWeeks)
      : computePlannedSignalB(
        s.historicWeeklyTSS, ctl, phase, tier, s.rw, weekInPhase, totalPhaseWeeks, s.sportBaselineByType,
      )
  );
  if (r.phase !== 'taper') return at(r.phase);
  const taper = at('taper', r.weekInTaper, r.taperWeeks);
  return r.alsoDeload ? Math.min(taper, at('deload')) : taper;
}

/**
 * Decayed carry from earlier weeks' excess, for the week containing today.
 *
 * Each past week is judged against its OWN planned target. The decay runs from
 * each past week's midpoint to today, so the carry only describes the current
 * week: a past or future week returns 0 (the Load & Taper view used to show the
 * current week's residual as "actual" load on unstarted future weeks).
 */
export function computeCurrentWeekCarry(s: PlannedTargetState, weekNum: number): number {
  if (weekNum !== s.w) return 0;
  return computeDecayedCarry(
    s.wks ?? [], weekNum, (w) => computePlannedWeekTarget(s, w), s.planStartDate,
  );
}
