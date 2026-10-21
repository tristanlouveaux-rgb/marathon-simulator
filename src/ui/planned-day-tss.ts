import type { SimulatorState } from '@/types/state';
import { resolveWeekWorkouts } from './week-resolve';
import { resolveTriWeekWorkouts, estimateTriWorkoutMin } from './triathlon/week-resolve.triathlon';
import { computePlannedDaySignalBTSS, estimateWorkoutDurMin, computeFitnessModel, ctlAdherenceRatio, isUnscheduledPlannedWorkout } from '@/calculations/fitness-model';
import { TL_PER_MIN, plannedTssPerMin } from '@/constants';
import { isHardWorkout } from '@/workouts/scheduler';
import { isLongRun } from '@/workouts/long-run';
import { signalARunSpec } from '@/cross-training/activities';
import { isHighIntensity as isHyroxHardSession } from '@/workouts/scheduler.hyrox';
import { isTriQualitySession } from '@/calculations/tri-suggestion-apply';

/** Running-plan workout types that are strength sessions (generator.ts gym templates, injury rehab). */
const GYM_PLANNED_TYPES = new Set(['gym', 'strength']);

/**
 * Canonical planned-day TSS context — the single source for "what does the
 * plan prescribe on day X of week N, in TSS terms?" across every strain /
 * readiness / coach surface (Home strain ring, Strain view ring + week bars,
 * Readiness card, daily-coach StrainContext).
 *
 * MODE-AWARE. Before this existed, every consumer regenerated a phantom
 * RUNNING week via generateWeekWorkouts regardless of mode, so triathlon /
 * cycling / HYROX users saw running-plan targets (e.g. "Target 60–82 TSS" on a
 * tri rest day — the 2026-06-03 bug). Each mode now reads its real plan:
 *
 *   - running:        resolveWeekWorkouts (the canonical Plan-tab resolver,
 *                     week-resolve.ts) → computePlannedDaySignalBTSS
 *   - tri / cycling:  resolveTriWeekWorkouts → (w.aerobic + w.anaerobic),
 *                     the same per-workout TSS the plan card badge shows
 *   - HYROX:          resolveTriWeekWorkouts → duration × plannedTssPerMin(type, rpe)
 *                     (HYROX workouts carry musculoTendonLoad, not TSS; the
 *                     fallback is the exact formula computePlannedDaySignalBTSS
 *                     already uses for duration-based sessions)
 *   - just-track:     empty (no plan; callers keep their CTL-anchor fallbacks)
 *
 * Per CLAUDE.md "two numbers that mean the same thing must come from the same
 * source": the strain target and the Plan tab must read the same resolved week.
 */

export interface PlannedDayWorkout {
  name: string;
  type: string;
  description: string | null;
  plannedTSS: number;
  plannedDurationMin: number;
  isHard: boolean;
  status?: string;
  /** Running only: the workout fills the week's long-run slot (isLongRun), so a
   *  fast-finish long run (type 'progressive') still reads as the long run. */
  longRun?: boolean;
}

export interface PlannedDayTSSContext {
  /** Sum of planned TSS for a day (0=Mon..6=Sun). 0 = rest day. */
  plannedTSSForDay(dayOfWeek: number): number;
  /** Resolved planned workouts for a day (status NOT filtered — callers decide). */
  workoutsForDay(dayOfWeek: number): PlannedDayWorkout[];
  plannedWeekTSS: number;
  /** Planned week TSS / training-day count. Tracks plan intent, not CTL history. */
  perSessionAvg: number;
  /** Days with planned TSS > 0, floored to 4 (historical default). */
  trainingDayCount: number;
}

/**
 * Hardness check that spans modes. Running types match isHardWorkout directly;
 * tri/cycling types are discipline-prefixed forms of the same kind vocabulary
 * (bike_threshold, swim_threshold, bike_vo2 …) so each underscore token is
 * tested against the same list. No new hardness vocabulary is introduced.
 */
function isHardPlannedType(t: string): boolean {
  if (isHardWorkout(t)) return true;
  return t.split('_').some(tok => isHardWorkout(tok));
}

/**
 * Hardness of a session in the stored-plan modes (triathlon, cycling, HYROX),
 * from each mode's own classifier, so the Home coach line and the readiness
 * look-ahead call the same sessions hard as the plan does. The running token
 * check (isHardPlannedType) missed most of them: a HYROX Tempo Run, a station
 * density session or a brick read as easy ("Easy effort today allows
 * recovery", ISSUE-406 (b)); so did a triathlon brick, sweet spot, over-under,
 * tempo run or hills session.
 *  - HYROX: isHighIntensity (scheduler.hyrox.ts), the scheduler's hard-day
 *    set: quality runs, bricks except the light secondary brick, race-pace
 *    station sessions (and race simulations once lane h2b adds them there).
 *  - Triathlon and cycling: isTriQualitySession (tri-suggestion-apply.ts),
 *    the quality classifier the readiness row and the overload builders share.
 * The running token check still applies on top, so no session it called hard
 * becomes easy (a user-added threshold run in either mode).
 */
function isHardStoredPlanSession(s: SimulatorState, w: any): boolean {
  if (isHardPlannedType(w.t ?? '')) return true;
  return s.eventType === 'hyrox' ? isHyroxHardSession(w) : isTriQualitySession(w);
}

/** Synced actuals (Garmin/Strava-ingested adhocs) are history, not plan intent. */
function isSyncedActual(w: any): boolean {
  const id: string = w.id ?? '';
  return !!w.garminTimestamp || id.startsWith('garmin-') || id.startsWith('strava-');
}

export function getPlannedDayTSSContext(s: SimulatorState, viewWeek: number): PlannedDayTSSContext {
  const byDay: PlannedDayWorkout[][] = [[], [], [], [], [], [], []];
  const wk = s.wks?.[viewWeek - 1];

  if (!s.trackOnly && wk) {
    // Cycling reuses eventType 'triathlon' (initialization.cycling.ts:111), so
    // this branch covers triathlon, cycling, and HYROX.
    if (s.eventType === 'triathlon' || s.eventType === 'hyrox') {
      // Tri / cycling / HYROX: the real plan is stored in wk.triWorkouts
      // (cycling reuses the tri engine). Injury is already baked into the
      // stored weeks (injury save regenerates current + future weeks).
      const workouts = resolveTriWeekWorkouts(s, viewWeek);
      for (const w of workouts as any[]) {
        if (isSyncedActual(w)) continue;
        if (w.t === 'rest' || w.discipline === 'rest') continue;
        // Illness/holiday-rested sessions: markRest / restAway set r=0 (and a
        // marker) but do NOT zero aerobic/anaerobic, so without this guard a
        // rested session would still count toward the day's target.
        const rested = w.illnessSeverity === 'resting'
          || ((w.illnessMod || w.holidayMod) && (w.rpe ?? w.r) === 0);
        if (rested) continue;
        // Pushed or dropped sessions (tri-skip-handler sets 'skipped'; a pushed
        // session's clone lives in next week) are off this week's plan. Mirror
        // of the running replaced/skipped guard (computePlannedWorkoutSignalBTSS).
        // 'replaced' is NOT excluded here: in these modes the AI coach swap
        // (coach-tools.ts swap_workout) marks a session swapped to another
        // type that is still to be done. Accepted tri suggestions, the swap to
        // easy included, set 'reduced' (tri-suggestion-apply.ts).
        if (w.status === 'skipped') continue;
        // The user's Skip on a tri/cycling/HYROX card writes wk.rated[key] =
        // 'skip' and never sets status (workout-detail-modal setRated /
        // setHxRated), so the status guard above never saw it. Running prices a
        // rated skip on purpose (its CTL-gap re-anchor reads this context);
        // tri and HYROX re-anchor from per-discipline adherence and MTL
        // (resolveCtlAdherence is neutral for both), so a skip is off the plan.
        if (wk.rated?.[w.id ?? w.n] === 'skip') continue;
        const day = w.dayOfWeek;
        if (day == null || day < 0 || day > 6) continue;
        const durMin = estimateTriWorkoutMin(w);
        let tss = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
        if (tss <= 0) {
          // HYROX sessions (MTL-only) + adhoc/strength sessions without
          // aerobic/anaerobic loads: duration × RPE-banded TSS/min, the same
          // fallback computePlannedDaySignalBTSS applies in running mode.
          const rpe = Math.round(w.rpe ?? w.r ?? 5);
          if (rpe <= 0) continue; // defensive: zero-RPE = no prescribed load
          // Type-keyed canonical valuation (ISSUE-263) — same rule as
          // calculateWorkoutLoad / computePlannedDaySignalBTSS.
          tss = durMin * plannedTssPerMin(w.t ?? '', rpe);
        }
        byDay[day].push({
          name: w.n ?? '',
          type: w.t ?? '',
          description: w.d ?? null,
          plannedTSS: Math.round(tss),
          plannedDurationMin: Math.round(durMin),
          isHard: isHardStoredPlanSession(s, w),
          status: w.status,
        });
      }
    } else {
      // Running: the canonical Plan-tab resolver (generation + adhoc + mods +
      // moves + illness + holiday + bridge). Cross-training sessions are
      // excluded from planned TSS, matching the historical strain computation.
      // Replaced and skipped runs price at 0 (computePlannedWorkoutSignalBTSS),
      // so a day whose only run was replaced is a rest day, not a 1-TSS
      // training day (audit B11). They stay listed with their status.
      const baseMinPerKm = s.pac?.e ? s.pac.e / 60 : 5.5;
      const workouts = resolveWeekWorkouts(s, viewWeek).filter((w: any) => w.t !== 'cross');
      for (const w of workouts as any[]) {
        const day = w.dayOfWeek;
        if (day == null || day < 0 || day > 6) continue;
        const tss = computePlannedDaySignalBTSS([w], day, baseMinPerKm);
        byDay[day].push({
          name: w.n ?? '',
          type: w.t ?? '',
          description: w.d ?? null,
          plannedTSS: tss,
          plannedDurationMin: isUnscheduledPlannedWorkout(w) ? 0 : Math.round(estimateWorkoutDurMin(w, baseMinPerKm)),
          isHard: isHardPlannedType(w.t ?? ''),
          status: w.status,
          ...(isLongRun(w) ? { longRun: true } : {}),
        });
      }
    }
  }

  const perDayTSS = byDay.map(list => list.reduce((sum, w) => sum + w.plannedTSS, 0));
  const plannedWeekTSS = perDayTSS.reduce((a, b) => a + b, 0);
  const trainingDayCount = perDayTSS.filter(t => t > 0).length || 4;
  const perSessionAvg = trainingDayCount > 0 ? plannedWeekTSS / trainingDayCount : 0;

  return {
    plannedTSSForDay: (dayOfWeek: number) => perDayTSS[dayOfWeek] ?? 0,
    workoutsForDay: (dayOfWeek: number) => byDay[dayOfWeek] ?? [],
    plannedWeekTSS,
    perSessionAvg,
    trainingDayCount,
  };
}

export interface CtlAdherence {
  /** actualCTL ÷ expectedCTL for the completed week. < 1 = behind plan, ≥ 1 = on/above. */
  ratio: number;
  plannedTSS: number;
  actualTSS: number;
  /** Percent of last week's planned load actually logged (0–100+). For the debrief headline. */
  pctOfPlanned: number;
  /** False when there is no trustworthy signal: track-only, no plan load, no history, or an
   *  excused (injury) week. Callers must not re-anchor or show "behind" copy when invalid. */
  valid: boolean;
}

/**
 * CTL adherence for a just-completed week — the SINGLE source for both the engine re-anchor
 * (stored on the upcoming week as `wk.ctlRatio`, consumed by plan_engine.ctlGapMultiplier) and the
 * debrief headline copy. Mirrors the `scheduledAcwrStatus` lifecycle: compute once at rollover,
 * store on the upcoming week, read on render.
 *
 * Recursion-safe: getPlannedDayTSSContext(completedWeek) resolves a PAST week, whose own `ctlRatio`
 * is already a stored scalar (read, never recomputed inside the resolver), so the planned side
 * reflects the prescription actually issued — not an aspirational one.
 */
export function resolveCtlAdherence(s: SimulatorState, completedWeek: number): CtlAdherence {
  const neutral: CtlAdherence = { ratio: 1, plannedTSS: 0, actualTSS: 0, pctOfPlanned: 100, valid: false };
  if (s.trackOnly) return neutral;
  // RUNNING-ONLY. next() is shared across modes, so without this guard a tri/HYROX athlete would
  // get a ratio mixing the running combined-CTL model (computeFitnessModel below) with tri/HYROX
  // planned load — a meaningless number stamped on their week. Tri/HYROX have their own per-
  // discipline / MTL re-anchor. (cycling reuses eventType 'triathlon'.)
  if (s.eventType === 'triathlon' || s.eventType === 'hyrox') return neutral;
  if (!s.wks || completedWeek < 1 || completedWeek > s.wks.length) return neutral;

  const wk = s.wks[completedWeek - 1] as any;
  // Injury weeks detrain on their own curve and are excused from adherence (mirrors the
  // effortScore exclusion in events.ts). Illness / holiday rest is already zeroed out of
  // plannedTSS by getPlannedDayTSSContext, so it needs no special case here.
  if (wk?.injuryState?.active) return neutral;
  if (wk?.detrainApplied) return neutral; // multi-week gap already re-anchored via detraining
  // Taper weeks are deliberately low volume before a race; re-anchoring them (or the race week
  // that follows) down further would sabotage race prep. Skip — same spirit as deload suppression.
  if (wk?.ph === 'taper') return neutral;

  // EXPECTED side uses the UN-reduced baseline plan. getPlannedDayTSSContext → resolveWeekWorkouts
  // → generateWeekWorkouts reads this week's stored ctlRatio and would otherwise hand back the
  // ALREADY re-anchored plan, making "expected" a moving target (a 64%-of-original week would read
  // as 80%-of-reduced). Temporarily clear the stamp so the ratio and the headline % always measure
  // against the real prescription. Synchronous clear+restore, no save in between.
  const savedRatio = wk?.ctlRatio;
  if (wk) wk.ctlRatio = undefined;
  const plannedCtx = getPlannedDayTSSContext(s, completedWeek);
  if (wk) wk.ctlRatio = savedRatio;
  // Value the prescription in the same currency as actualTSS (Signal A). A planned gym session
  // counts at the strength runSpec, because computeWeekTSS counts the session that fills it at
  // that runSpec (strength RPE override, or the activity's own sport for HIIT and plan-named gym
  // fills). Valued at full TSS, a fully completed gym session read as a running-load deficit and
  // cut next week's volume. Cross sessions stay out of the planned side (getPlannedDayTSSContext).
  let plannedTSS = 0;
  for (let day = 0; day < 7; day++) {
    for (const w of plannedCtx.workoutsForDay(day)) {
      plannedTSS += GYM_PLANNED_TYPES.has(w.type) ? w.plannedTSS * signalARunSpec('strength') : w.plannedTSS;
    }
  }
  if (plannedTSS <= 0) return neutral;

  // actualTSS is Signal A (run-equivalent: every activity at its own sport's runSpec — see
  // computeWeekTSS), while plannedTSS excludes cross sessions. The remaining seam is unplanned or
  // cross-slot cross-training, which can only lift actualTSS (never a false cut) and sits inside
  // the ~15% (1−CTL_DECAY) term; documented in SCIENCE_LOG §BR. priorCtl is the chronic load at the
  // end of the week before last (metrics[length-2]); ctlBaseline seeds week 1 when there is no prior.
  const metrics = computeFitnessModel(
    s.wks, completedWeek, s.ctlBaseline ?? undefined, s.planStartDate,
    undefined, undefined, (s as any).previousPlanWks,
  );
  if (metrics.length === 0) return neutral;

  const last = metrics[metrics.length - 1];
  const priorCtl = metrics.length >= 2 ? metrics[metrics.length - 2].ctl : (s.ctlBaseline ?? 0);
  const actualTSS = last.actualTSS;

  const ratio = ctlAdherenceRatio(priorCtl, plannedTSS, actualTSS);
  // pct and ratio now share the same baseline plannedTSS, so they cannot disagree on direction:
  // the headline only fires when ratio < 0.97, which (un-contaminated) implies actual < planned,
  // i.e. pct < 100. max(0) guards a degenerate negative only.
  const pctOfPlanned = Math.max(0, Math.round((actualTSS / plannedTSS) * 100));
  return { ratio, plannedTSS, actualTSS, pctOfPlanned, valid: true };
}
