/**
 * Triathlon plan engine. Top-level entry for generating a triathlon plan.
 *
 * Generation flow:
 *   1. Phase each week (base → build → peak → taper, plus checkpoint flag for
 *      double-periodization plans ≥28w) via computeTriPlanPhases()
 *   2. Compute weekly total hours from time-available × phase multiplier
 *      (race-taper weeks instead take fractions of the reference week per
 *      discipline, tri-taper.ts)
 *   3. Split total hours into per-discipline hours via triConfig.volumeSplit
 *   4. Emit sessions per discipline via swim/bike/run generators
 *   5. Hand to scheduler.triathlon.ts for day assignment
 *   6. Wrap into a Week[] compatible with the rest of the app
 *
 * Reuses the running workout library for run sessions to keep the running
 * code path canonical (no fork for the run leg. It's the same muscle as
 * marathon training).
 */

import { dropSessionsOnOrAfterRaceDay, clearStoredPlanRaceWindow, spaceStoredPlanQualityRuns, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
import { storedPlanRaceLayout, type RaceWeekLayout } from './race-week-layout';
import { firstTrackedDow } from '@/ui/workout-status';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { TriSkillSlider, TriathlonDistance } from '@/types/triathlon';
import type { InjuryState } from '@/types/injury';
import {
  computeTriPlanPhases,
  TRI_LOW_HOURS_THRESHOLD_H,
  TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION,
  TRI_RACE_WEEK_FRACTION,
  TRI_TAPER_FIRST_WEEK_FRACTION,
} from '@/constants/triathlon-constants';
import { plannedTssPerMin } from '@/constants';
import { generateSwimSession, type SwimSessionKind } from './swim';
import { generateBikeSession, substituteExcluded, type BikeSessionKind } from './bike';
import { generateBrick } from './brick';
import {
  triQualitySlotIndices,
  selectSwimQualityKind,
  selectBikeQualityKind,
  selectRunQualityKind,
  TRI_BRICK_POLICY,
  triTaperCapsAtRacePace,
} from './tri-intensity-profile';
import { scheduleTriathlonWeek, DAY_NAMES as TRI_DAY_NAMES } from './scheduler.triathlon';
import {
  composeTriRaceWeek,
  triDayBeforeRide,
  triQualityWorkMinutes,
  triRaceBikeIntensity,
  triRacePaceNeedMin,
  triRacePaceSession,
  triRacePaceTargetReps,
  triTaperMicrosNeedMin,
  triTaperQualitySwim,
  triTaperSwimMinMin,
  triTaperSwimPlan,
  triTaperThresholdRunDesc,
  triTaperThresholdRunNeedMin,
  triTaperVo2MicrosRide,
  TRI_RACE_PACE_MIN_REPS,
  TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY,
  TRI_TAPER_MICROS_MIN_REPS,
  TRI_TAPER_SESSION_FLOOR_MIN,
  type TriTaperRef,
  type TriTaperSessionCtx,
} from './tri-taper';
import { applyTriEffortMultipliers } from '@/calculations/effort-multiplier.triathlon';
import { crossTrainingSwapFraction } from '@/calculations/body-mass-adaptations';
import { gp } from '@/calculations/paces';
import { fmtModelPaceKm } from '@/utils/format';
// Moved verbatim to tri-run-pace.ts so accepted suggestions retarget run paces
// from the same easy pace the generator writes (triRunEasyPaceSec).
import { easyPaceSecPerKmFromSkill } from './tri-run-pace';
import { getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';
import { injuryStrengthDecision } from './injury-strength';
import { isFourWeekCycleDeloadWeek, isRaceWeek } from './plan_engine';
import { isLongRun } from './long-run';

/**
 * Bump this when the generator output changes in a way that should invalidate
 * previously generated plans (new scheduler, duration formatting, phase ramp,
 * new variants, etc). `main.ts` checks this on load and regenerates tri
 * workouts if the stored version is lower.
 */
// v18: stampTriWorkoutIds — generated workouts now carry stable W{wk}-{type}-{idx}
// ids. The bump forces a regen so PERSISTED weeks pick the ids up; without it,
// pre-existing weeks keep id-less workouts and every `w.id ?? w.n` consumer
// stays name-keyed (the duplicate-name collision the ids exist to fix).
// v19: race week has no long run (the race is that week's long effort, mirrors
// running's isRaceWeek), and the scheduler finds the long run by type instead of
// array position, so a commute run no longer lands on Sunday with the long run
// pushed to a weekday. Race week is the plan's final week whatever its phase
// label (1- and 2-week plans have no taper week). Both ship together in v19
// (unreleased when the race-week definition was widened, so no second bump).
// v20: 1- and 2-week plans allocate the taper first (phases.ts computeSingleArc):
// a 1-week plan is [taper] (was [build]) and a 2-week plan [peak, taper] (was
// [build, peak]), so week 1 of a 2-week plan now runs peak sessions. Also in
// v20 (unreleased when added): nothing is generated on or after race day
// (race-day-rules dropSessionsOnOrAfterRaceDay), e.g. a Saturday race's
// Saturday session.
// v21: race week sits where running puts it (storedPlanRaceLayout): the week
// holding the day 3 days before race day. A Monday to Wednesday race's own week
// is a closing week with no sessions (raceClosing), and the plan is phased and
// sized over the weeks before it, so the last days before a Monday race are
// race week, not peak week. For a Thursday to Saturday race the week before race
// week keeps nothing in the last 6 days before race day; its long sessions move
// to 7 or more days out (clearStoredPlanRaceWindow). The solo long ride carries
// longRide: true. Also in v21 (unreleased when added): the sessions the race
// window removes are kept on the week as Week.raceWindowCut (forecast dose
// only), so the forecast does not read the taper cut as lost training.
// v22: the scheduler never puts a second run on the long-run day or the brick
// day (scheduler.triathlon.ts). When weekday capacity ran out its fallbacks
// stacked an easy run or a commute beside the Sunday long run (a 70.3 build
// week: an 80-min long run and a 50-min easy run on Sunday). Also in v22
// (unreleased when added): race week placed relative to race day (SCIENCE_LOG
// §CE, §CW). It keeps the week before's session count per discipline
// (triRaceWeekCounts), holds one quality session, the primer (the first ride,
// placed 3 to 5 days out by placeStoredPlanRaceWeekPrimer), rides the steady
// endurance variant (never "fasted (optional)"), and a Monday to Wednesday
// race's Sunday is a race-week day. Before, a Wednesday 70.3 race week held a
// swim and a fasted optional ride, with the 4 days before the race empty.
// Still v22 (unreleased): the primer is a 30-min ride on its duration-scaled
// variant (a few minutes of quality, not a 2x20 min build set), the week's
// only ride is the primer, and the primer takes running's primer day
// (raceWeekPrimerDow). Race week never holds a discipline twice on one day,
// and in the last 13 days no quality run sits next to the brick or the long
// run (spaceStoredPlanQualityRuns). A run that fits no day within its cap
// takes the day without a run it overshoots least (scheduler step 3b), so
// closing the long-run and brick days no longer moves the double to a weekday.
// v23: run paces follow the capped run figure. The generator writes run paces
// from gp(s.v, s.lt); s.lt now reads the triathlete run caps (the run skill
// rating in cold start, 2026-10-09; a synced race effort in the evidence
// ceiling, 2026-10-11, ISSUE-376), and main.ts regenerates after the launch
// refresh (applyTriGeneratorRegen). The bump makes stored plans built from an
// uncapped watch s.lt (easy 4:24/km at watch 62, run skill 3) regenerate at
// the capped paces (5:45/km).
// v24: the race taper rebuild (tri-taper.ts, SCIENCE_LOG "Triathlon and
// cycling taper rebuild", Tristan 2026-10-13). Taper length by race distance
// (sprint 1 week, others 2, cycling 2; race week only under 8 h), taper weeks
// sized per discipline from the reference week (0.55 then 0.30, or 0.55 for a
// one-week taper), quality kept with fewer reps (long course capped at race
// intensity), race week composed from openers, Byrn's brick, a rest day 2 days
// out and a capped activation the day before. Stored plans regenerate so
// existing users get the new taper.
export const TRI_GENERATOR_VERSION = 24;

/**
 * Representative average session length (hours) per discipline. The generator
 * divides each discipline's weekly hour budget by this to decide how many
 * sessions to emit (`countSessions`). Single source so the onboarding
 * session-lever (`tri-session-lever.ts`) translates "+1 session" into the
 * same hour increment the generator actually uses.
 *
 * Defensible: swim sets run ~40-50 min, club bike sessions ~75-90 min, and
 * structured runs ~50-60 min — these match the per-session durations the
 * swim/bike/run generators emit at the standard skill default.
 */
export const TRI_AVG_SESSION_HOURS = { swim: 0.75, bike: 1.3, run: 0.9 } as const;

/**
 * Maximum sessions per discipline for a full (multi-discipline) triathlon
 * plan. Cycling-only mode lifts the bike cap to 5 (the discipline owns 100%
 * of the week). Past this cap, extra hours lengthen sessions rather than
 * adding one — the onboarding lever stops the stepper here.
 */
export const TRI_MAX_SESSIONS_PER_DISCIPLINE = 3;
export const TRI_MAX_BIKE_SESSIONS_CYCLING_ONLY = 5;

/** The shortest solo swim, ride or run the generator prescribes in a training
 *  week, in minutes (every session's minutes are floored here). Race-taper
 *  weeks use the generators' own 20-min floor instead
 *  (TRI_TAPER_SESSION_FLOOR_MIN, tri-taper.ts). */
const TRI_SESSION_FLOOR_MIN = 30;

/**
 * Ironman long-run build (SCIENCE_LOG §CD). The IM marathon is run on
 * pre-fatigued, glycogen-depleted legs after ~180 km of cycling; the limiter is
 * durability, not fresh marathon pace (Maunder 2021). Cycling builds the aerobic
 * engine but only running loads the legs eccentrically, so run durability must
 * come from running. The standalone long run therefore BUILDS to a 2:30 (150 min)
 * time-on-feet ceiling — the durability sweet spot for mainstream IM coaching
 * (Friel, Fitzgerald), below the ~30 km standalone-marathon peak because total
 * three-sport load caps run volume. It ramps from the same 90-min week-1 anchor
 * running mode uses (plan_engine.ts longRunMinutes), so an IM long run is no
 * longer a leftover fraction of a bike-dominated hours budget.
 *
 * Kept as a local planning table (mirrors plan_engine.ts longRunCapMin) to
 * preserve the tracking/planning separation; the matching durability *threshold*
 * lives in durability-cap.ts and is bumped to 2.5h so the two agree.
 *
 * 70.3 keeps the share model for now — its half-marathon run leg needs a
 * smaller, separate target. Flagged for Tristan before mirroring (no invented
 * number).
 */
const IRONMAN_LONG_RUN_BASE_MIN = 90;
const IRONMAN_LONG_RUN_PEAK_MIN = 150;

/**
 * On a week that emphasises one key session, the OTHER key session (the long
 * ride on a run-emphasis week, the long run on a bike-emphasis week) holds at a
 * maintenance floor so it doesn't detrain while its counterpart peaks. 0.75
 * confirmed by Tristan (2026-06-17): high enough to retain the distance, low
 * enough to free recovery for the week's priority. The peak long run and peak
 * long ride never land in the same week (Banister supercompensation: stacking
 * two maximal durability sessions blunts the adaptation from both); the brick
 * still covers run-on-fatigue specificity every relevant week.
 */
export const TRI_KEY_SESSION_MAINTENANCE = 0.75;

/**
 * Which key session this week emphasises. Ironman build/peak only: alternate by
 * week parity so the peak long run and peak long ride never collide. Returns
 * null where the alternation does not apply (non-IM distance, or base/taper) —
 * callers then fall back to the share model and full sessions.
 */
export function triWeekEmphasis(
  distance: TriathlonDistance, phase: TrainingPhase, weekIndex: number
): 'run' | 'bike' | null {
  if (distance !== 'ironman') return null;
  if (phase !== 'build' && phase !== 'peak') return null;
  return weekIndex % 2 === 1 ? 'run' : 'bike';
}

/**
 * Ramped Ironman long-run target in minutes (90 -> 150 across the build,
 * peaking by totalWeeks * 0.75, taper cut to 0.65 to mirror running mode).
 * Returns null for non-IM distances (share model applies). This is the FULL
 * target; the alternation maintenance floor is applied by the caller.
 */
export function triLongRunTargetMin(
  distance: TriathlonDistance, weekIndex: number, totalWeeks: number, phase: TrainingPhase
): number | null {
  if (distance !== 'ironman') return null;
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.75));
  let base = IRONMAN_LONG_RUN_BASE_MIN
    + Math.max(0, IRONMAN_LONG_RUN_PEAK_MIN - IRONMAN_LONG_RUN_BASE_MIN) * progress;
  if (phase === 'taper') base *= 0.65;
  return Math.round(Math.min(base, IRONMAN_LONG_RUN_PEAK_MIN));
}

/**
 * Generate a full triathlon plan for the current state.
 */
export function generateTriathlonPlan(state: SimulatorState): Week[] {
  const tri = state.triConfig;
  if (!tri) return [];

  const totalWeeks = state.tw || 20;
  // Race week and the closing week follow the running layout. The plan is
  // phased and sized over its training weeks (the closing week excluded), so
  // race week is the week holding race day minus 3, as in running.
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, tri.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const planPhases = triPlanPhases(state, trainingWeeks);
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const closing = w > trainingWeeks;
    const p = closing ? { ph: 'taper' as TrainingPhase } : planPhases[w - 1];
    const phase = p.ph;
    const built = closing ? null : triWeekForRace(state, w, trainingWeeks, phase, layout);
    const weekWorkouts = built?.workouts ?? [];
    const raceWindowCut = built?.raceWindowCut ?? [];

    weeks.push({
      w,
      ph: phase,
      ...(closing ? { raceClosing: true } : {}),
      ...(raceWindowCut.length > 0 ? { raceWindowCut } : {}),
      ...(p.checkpoint ? { checkpoint: true } : {}),
      triWorkouts: weekWorkouts,
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
    } as Week);
  }

  // Apply per-discipline effort multiplier to upcoming weeks (week ≥ current).
  // Mirrors running's plan_engine `effortMultiplier` step. Past weeks are
  // intentionally left alone. We don't rewrite history.
  applyTriEffortMultipliersToFutureWeeks(state, weeks, trainingWeeks);

  return weeks;
}

/** Sessions the effort multiplier may scale. Race week is left alone: its
 *  sessions sit at sourced race-week lengths (openers, the brick, the
 *  race-week caps) and the day before must stay its lightest day, which a
 *  scale of 0.85 to 1.15 on the other days would break. Elsewhere the
 *  day-before activation keeps its sourced minutes too. */
function triEffortScalable(state: SimulatorState, weekIndex: number, trainingWeeks: number, workouts: Workout[]): Workout[] {
  if (isRaceWeek(weekIndex, trainingWeeks, state.continuousMode)) return [];
  return workouts.filter(w => w.taperRole !== 'day_before');
}

/**
 * Apply per-discipline effort multipliers to ALL future weeks of the plan.
 * Pure mutation. Caller passes the freshly-generated `weeks` array.
 *
 * Skips weeks before `state.w` (those are completed/in-progress and
 * shouldn't have their planned durations re-scaled retroactively).
 */
function applyTriEffortMultipliersToFutureWeeks(state: SimulatorState, weeks: Week[], trainingWeeks: number): void {
  const currentWeek = state.w ?? 1;
  for (const wk of weeks) {
    if ((wk.w ?? 0) < currentWeek) continue;
    if (wk.triWorkouts && wk.triWorkouts.length > 0) {
      // The CTL-gap stamp lives on the STORED week (state.wks), not on this freshly-generated `wk`,
      // so look it up by week number. (Effort reads from `state` directly, so it never had this issue.)
      const stamp = (state.wks?.[(wk.w ?? 1) - 1] as any)?.ctlRatioByDiscipline;
      applyTriEffortMultipliers(state, triEffortScalable(state, wk.w ?? 1, trainingWeeks, wk.triWorkouts), stamp);
      // The race window's removed sessions scale with the week they came from.
      if (wk.raceWindowCut) applyTriEffortMultipliers(state, wk.raceWindowCut, stamp);
    }
  }
}

/**
 * Regenerate a single triathlon week (e.g., after a skip or ACWR spike).
 */
export function regenerateTriathlonWeek(state: SimulatorState, weekIndex: number): Week | null {
  const tri = state.triConfig;
  if (!tri || !state.wks || weekIndex < 1 || weekIndex > state.wks.length) return null;

  const totalWeeks = state.tw;
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, tri.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const existing = state.wks[weekIndex - 1];
  if (weekIndex > trainingWeeks) {
    // Closing week: it holds only the race.
    return { ...existing, ph: 'taper', raceClosing: true, triWorkouts: [] };
  }
  const planPhases = triPlanPhases(state, trainingWeeks);
  const p = planPhases[weekIndex - 1];
  const phase = p.ph;
  const { workouts: weekWorkouts, raceWindowCut } = triWeekForRace(state, weekIndex, trainingWeeks, phase, layout);

  // Apply per-discipline effort multiplier + CTL-gap re-anchor when regenerating a future week.
  // For a same-week or past-week regen, skip. Preserves historical duration.
  if (weekIndex >= (state.w ?? 1)) {
    const stamp = (state.wks[weekIndex - 1] as any)?.ctlRatioByDiscipline;
    applyTriEffortMultipliers(state, triEffortScalable(state, weekIndex, trainingWeeks, weekWorkouts), stamp);
    applyTriEffortMultipliers(state, raceWindowCut, stamp);
  }

  const week: Week = {
    ...existing,
    ph: phase,
    ...(p.checkpoint ? { checkpoint: true } : { checkpoint: existing.checkpoint }),
    triWorkouts: weekWorkouts,
    raceWindowCut,
  };
  if (raceWindowCut.length === 0) delete week.raceWindowCut;
  return week;
}

/**
 * One training week of a triathlon plan with the race-day rules applied.
 * `trainingWeeks` is the plan's training horizon (the closing week excluded),
 * so race week is week `trainingWeeks`.
 *   - Rule 1: nothing on or after race day (shared with running).
 *   - Rules 3 and 4: in the week before race week, nothing in the last 6 days
 *     before race day; its long sessions move to 7 or more days out
 *     (clearStoredPlanRaceWindow). The sessions it removes come back as
 *     `raceWindowCut` (discipline and minutes), stored on the week for the
 *     forecast's planned dose only.
 */
function triWeekForRace(
  state: SimulatorState, weekIndex: number, trainingWeeks: number, phase: TrainingPhase,
  layout: RaceWeekLayout | null,
): { workouts: Workout[]; raceWindowCut: TriRaceWindowCut } {
  const tri = state.triConfig!;
  const firstDow = firstTrackedDow(state.planStartDate, weekIndex, state.planCreatedAt);
  // Race week places its sessions relative to race day itself (tri-taper.ts
  // composeTriRaceWeek: openers 3 to 5 days out, running's primer window).
  const week = generateWeekForTriathlon(state, weekIndex, trainingWeeks, phase, { layout, firstDow });
  const generated = dropSessionsOnOrAfterRaceDay(week, weekIndex, state.planStartDate, tri.raceDate);
  const raceWindowCut: TriRaceWindowCut = [];
  if (!layout) return { workouts: generated, raceWindowCut };
  const dropped: Workout[] = [];
  let cleared = clearStoredPlanRaceWindow(generated, {
    weekIndex,
    layout,
    isLongSession: isTriLongSession,
    firstScheduleDow: firstDow,
    dayNames: TRI_DAY_NAMES,
    onDrop: w => dropped.push(w),
  });
  // A race-taper week keeps every discipline (Tristan 2026-10-13): when the
  // race window took all of a discipline's sessions, one goes back on a day
  // the window leaves open (taperWeekKeepsDisciplines).
  const taper = triRaceTaper(state, trainingWeeks);
  let reseated = new Set<Workout>();
  if (taper && weekIndex >= taper.start && weekIndex < trainingWeeks) {
    ({ workouts: cleared, reseated } = taperWeekKeepsDisciplines(generated, cleared, dropped, {
      firstDow, lastDow: lastDowBefore(layout, weekIndex, RACE_DAY_CLEAR_DAYS),
    }));
  }
  // Tracking keeps the build prescription: the forecast's planned dose reads
  // the removed sessions back (Week.raceWindowCut, tri-volume-by-discipline).
  for (const w of dropped) {
    if (!reseated.has(w)) raceWindowCut.push({ discipline: w.discipline, estimatedDurationMin: w.estimatedDurationMin });
  }
  // Rule 4's spacing: no quality run next to the long run, the brick or
  // another quality run in the last 13 days (running's rule; the brick and the
  // long run keep their back-to-back days).
  const spaced = (isRun: (w: Workout) => boolean) => spaceStoredPlanQualityRuns(cleared, {
    weekIndex,
    layout,
    isQualityRun: isTriQualityRun,
    isHardRun: w => isTriQualityRun(w) || isLongRun(w) || w.t === 'brick',
    isRun,
    firstScheduleDow: firstDow,
    dayNames: TRI_DAY_NAMES,
    toEasy: w => triEasedRun(state, weekIndex, trainingWeeks, phase, w),
  });
  // A moved quality run takes a day without a run, and without gym when it
  // can: the scheduler puts gym on off-run days (gym has no discipline, so it
  // reads as a run in both places). Only when that would ease a quality run
  // may it take a gym day, as the scheduler's own fallback seats a run beside
  // gym when no other day has room (placeByPreference step 4): taper week 1
  // keeps the reference week's quality count (Tristan, decision 4). Commutes
  // are runs.
  let workouts = spaced(w => (w.discipline ?? 'run') === 'run');
  const qualityRuns = (ws: Workout[]) => ws.filter(isTriQualityRun).length;
  if (qualityRuns(workouts) < qualityRuns(cleared)) {
    const onGymDays = spaced(w => w.t !== 'gym' && (w.discipline ?? 'run') === 'run');
    if (qualityRuns(onGymDays) > qualityRuns(workouts)) workouts = onGymDays;
  }
  return { workouts, raceWindowCut };
}

/** The latest weekday of plan week `weekIndex` more than `clearDays` days
 *  before race day (-1 when the whole week is inside). */
function lastDowBefore(layout: RaceWeekLayout, weekIndex: number, clearDays: number): number {
  const weekStart = (weekIndex - 1) * 7;
  let dow = 6;
  while (dow >= 0 && layout.raceDayIndex - (weekStart + dow) <= clearDays) dow--;
  return dow;
}

/**
 * A race-taper week the race window cut keeps every discipline (planning side;
 * Tristan 2026-10-13, decision 5: no discipline at zero in any taper week).
 * For each discipline the generated week held and the cleared week holds none
 * of (swim, bike and run sessions and the brick; gym and commutes aside), one
 * removed session goes back at its own length: a quality session first (taper
 * week 1 keeps the reference week's quality count), else the shortest. It
 * takes a day the window leaves open (`firstDow` to `lastDow`, at least 7 days
 * before race day) without that discipline, the one holding the fewest
 * sessions, the latest among equals (nearest the day it was cut from). With no
 * such day it stays out. Returns the week and the removed sessions put back.
 */
function taperWeekKeepsDisciplines(
  generated: Workout[], cleared: Workout[], dropped: Workout[], opts: { firstDow: number; lastDow: number },
): { workouts: Workout[]; reseated: Set<Workout> } {
  const reseated = new Set<Workout>();
  const counts = (w: Workout) => w.t !== 'gym' && !w.commute;
  const has = (w: Workout, d: string) => counts(w) && ((w.discipline ?? 'run') === d || (w.t === 'brick' && (d === 'bike' || d === 'run')));
  const quality = (w: Workout) => w.taperRole === 'race_pace' || isTriQualityRun(w)
    || (w.discipline === 'swim' && (w.t === 'swim_threshold' || w.t === 'swim_speed'))
    || (w.discipline === 'bike' && w.t !== 'bike_endurance' && w.t !== 'brick');
  let out = [...cleared];
  for (const d of ['swim', 'bike', 'run']) {
    if (!generated.some(w => has(w, d)) || out.some(w => has(w, d))) continue;
    const cand = dropped
      .filter(w => counts(w) && w.t !== 'brick' && (w.discipline ?? 'run') === d)
      .sort((a, b) => (Number(quality(b)) - Number(quality(a))) || ((a.estimatedDurationMin ?? 0) - (b.estimatedDurationMin ?? 0)))[0];
    if (!cand) continue;
    const days: number[] = [];
    for (let dow = opts.lastDow; dow >= opts.firstDow; dow--) if (!out.some(w => w.dayOfWeek === dow && has(w, d))) days.push(dow);
    if (days.length === 0) continue;
    const perDay = (dow: number) => out.filter(w => w.dayOfWeek === dow).length;
    const dow = days.reduce((b, x) => (perDay(x) < perDay(b) ? x : b), days[0]);
    out.push({ ...cand, dayOfWeek: dow, dayName: TRI_DAY_NAMES[dow] });
    reseated.add(cand);
  }
  if (reseated.size === 0) return { workouts: cleared, reseated };
  out = out.map((w, i) => ({ w, i })).sort((a, b) => ((a.w.dayOfWeek ?? 0) - (b.w.dayOfWeek ?? 0)) || (a.i - b.i)).map(x => x.w);
  return { workouts: out, reseated };
}

/** A threshold or VO2 run (the triathlon run quality kinds). */
function isTriQualityRun(w: Workout): boolean {
  return (w.discipline ?? 'run') === 'run' && !isLongRun(w) && (w.t === 'threshold' || w.t === 'vo2');
}

/** A quality run as an easy run of the same duration, at the week's easy pace. */
function triEasedRun(state: SimulatorState, weekIndex: number, totalWeeks: number, phase: TrainingPhase, w: Workout): Workout {
  const skill = (state.triConfig?.skillRating?.run ?? 3) as TriSkillSlider;
  const pace = triWeekSizing(state, weekIndex, totalWeeks, phase).easyPaceSecPerKm ?? easyPaceSecPerKmFromSkill(skill);
  const label = `${fmtModelPaceKm(pace)}/km`; // model pace: the whole second
  return { ...w, ...triEasyRunFields(w.estimatedDurationMin ?? TRI_SESSION_FLOOR_MIN, label, Math.abs(weekIndex - 1)), r: 4 };
}

type TriRaceWindowCut = NonNullable<Week['raceWindowCut']>;

/** The long sessions of a triathlon or cycling week: long run, brick (the long
 *  ride with its transition run) and the solo long ride. */
export function isTriLongSession(w: Pick<Workout, 't' | 'longRun' | 'longRide'>): boolean {
  return isLongRun(w) || w.t === 'brick' || w.longRide === true;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-week workout generation
// ───────────────────────────────────────────────────────────────────────────

/**
 * A triathlon week's time budget and session counts (planning side): the
 * user's hours x the phase ramp (deload x 0.7), less gym and commute time,
 * shared between solo sessions and the brick's transition run, then split by
 * discipline; each discipline's session count is its hours over
 * TRI_AVG_SESSION_HOURS, capped. Shared by the week generator and the race
 * taper (its low-hours test sizes the reference week, triTaperOpts).
 */
function triWeekSizing(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: TrainingPhase,
  /** ignoreDeload: size a full week (the taper's reference week). */
  opts: { ignoreDeload?: boolean } = {},
) {
  const tri = state.triConfig!;
  const timeAvailable = tri.timeAvailableHoursPerWeek ?? 10;
  const split = tri.volumeSplit ?? { swim: 0.175, bike: 0.475, run: 0.35 };
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const gymSessions = state.gs ?? 0;
  const disciplines = tri.disciplines ?? ['swim', 'bike', 'run'];
  const hasSwim = disciplines.includes('swim');
  const hasBike = disciplines.includes('bike');
  const hasRun = disciplines.includes('run');

  // Phase multiplier (fraction of peak hours this week represents)
  const phaseMult = phaseMultiplier(phase, weekIndex, totalWeeks);
  // Honour a holiday-forced deload the same way running's plan_engine.ts does
  // (deload = ctx.forceDeload || isDeloadWeek(...)). The holiday modal sets
  // wk.forceDeload on weeks overlapping the holiday; without this the tri engine
  // ignored it and regenerated those weeks at full load.
  const forceDeload = !!(state.wks?.[weekIndex - 1] as any)?.forceDeload;
  const isDeload = !opts.ignoreDeload && (forceDeload || isFourWeekCycleDeloadWeek(weekIndex, phase));
  const effectiveMult = isDeload ? phaseMult * 0.7 : phaseMult;

  // This week's TOTAL time budget: the user's peak hours scaled by the phase ramp.
  // Everything prescribed — solo swim/bike/run, the brick, gym, and commute runs —
  // must sum to at most this. We reserve the fixed commitments (gym, commute) and the
  // brick's share of the budget first, then size the solo sessions from what remains,
  // so the plan never exceeds the hours the user said they have. Decided 2026-06-16
  // (supersedes the §AM additive-commute model — commutes now count against the cap;
  // see SCIENCE_LOG §CD).
  const totalCapMin = timeAvailable * effectiveMult * 60;

  // Commute runs cost their REAL duration (one-way distance × easy run pace), not a
  // flat 60min. easyPaceSecPerKm is the LT-anchored easy pace when VDOT is known;
  // otherwise fall back to the run-skill estimate. Reused below for the run sessions.
  const easyPaceSecPerKm = state.v ? gp(state.v, state.lt ?? null).e : undefined;
  const commuteEasyPaceSec = easyPaceSecPerKm ?? easyPaceSecPerKmFromSkill(rating.run as TriSkillSlider);
  const commuteDays = state.commuteConfig?.enabled && state.commuteConfig.commuteDaysPerWeek > 0
    ? state.commuteConfig.commuteDaysPerWeek
    : 0;
  const commuteSlotsPerDay = state.commuteConfig?.isBidirectional ? 2 : 1;
  const commuteSlotMin = commuteDays > 0 && state.commuteConfig
    ? Math.max(1, Math.round((state.commuteConfig.distanceKm * commuteEasyPaceSec) / 60))
    : 0;
  const reservedCommuteMin = hasRun ? commuteDays * commuteSlotsPerDay * commuteSlotMin : 0;

  // Gym: 45 min each, capped at 2 (matches the gym loop below).
  const reservedGymMin = Math.min(gymSessions, 2) * 45;

  // Brick: present only in its policy phases and only with both bike+run. Coaching
  // model (SCIENCE_LOG §CD): the brick IS the long ride with a transition run off
  // it (the canonical IM weekend), NOT a separate medium ride alongside a standalone
  // long ride. So the brick's BIKE is the long-ride slot already inside `bikeHours`;
  // the only time the brick adds on top is the transition RUN. brickFrac is therefore
  // just the run share — dropping the old bike term folds the redundant second ride's
  // hours into a longer single long ride.
  const brickPolicy = TRI_BRICK_POLICY[tri.distance];
  const brickActive = brickPolicy.phases.includes(phase) && hasBike && hasRun;
  const brickFrac = brickActive ? split.run * brickPolicy.runShare : 0;

  // Solve solo-SBR hours so that solo + brick + gym + commute == cap:
  //   capMin = sbrMin·(1 + brickFrac) + gym + commute
  //   ⇒ sbrMin = (capMin − gym − commute) / (1 + brickFrac)
  // When fixed commitments alone exceed the cap (e.g. heavy commute on a deep taper
  // week) sbrMin floors at 0 and the solo sessions drop out — the cap can't fit them.
  const fixedMin = reservedGymMin + reservedCommuteMin;
  const weekHours = Math.max(0, (totalCapMin - fixedMin) / (1 + brickFrac)) / 60;

  // Per-discipline hours
  const swimHours = weekHours * split.swim;
  const bikeHours = weekHours * split.bike;
  const runHours    = weekHours * split.run;

  // Session counts by phase. Disciplines that aren't active produce zero
  // sessions so subsequent loops short-circuit to empty arrays. In single-
  // discipline cycling mode the bike cap lifts to 5 because the discipline
  // owns 100% of the week's hours rather than ~50%.
  const isCyclingOnly = disciplines.length === 1 && hasBike;
  const swimSessions = hasSwim ? countSessions(swimHours, TRI_AVG_SESSION_HOURS.swim, TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;
  const bikeSessions = hasBike ? countSessions(bikeHours, TRI_AVG_SESSION_HOURS.bike, isCyclingOnly ? TRI_MAX_BIKE_SESSIONS_CYCLING_ONLY : TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;
  const runSessions  = hasRun  ? countSessions(runHours,  TRI_AVG_SESSION_HOURS.run,  TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;

  return {
    easyPaceSecPerKm, commuteDays, commuteSlotMin, reservedCommuteMin, brickPolicy, brickActive,
    weekHours, swimHours, bikeHours, runHours, isCyclingOnly,
    swimSessions, bikeSessions, runSessions,
  };
}

/** Swim, bike, run and brick sessions of one week before injury gates and
 *  scheduling, with the fixed commitments kept apart (commute runs, gym). */
interface TriWeekParts {
  swim: Workout[];
  bike: Workout[];
  /** Training runs (commutes excluded). */
  run: Workout[];
  commutes: Workout[];
  brick: Workout | null;
  gym: Workout[];
  /** Solo swim/bike/run hours (triWeekSizing weekHours), for the day caps. */
  weekHours: number;
}

/** Race-week context for the week generator (triWeekForRace). */
interface TriWeekGenCtx {
  layout: RaceWeekLayout | null;
  firstDow: number;
}

/** Cycling mode: the tri engine with the bike alone. */
function triIsCyclingOnly(state: SimulatorState): boolean {
  const disciplines = state.triConfig!.disciplines ?? ['swim', 'bike', 'run'];
  return disciplines.length === 1 && disciplines.includes('bike');
}

/** Taper switches for a plan of `trainingWeeks` (planning side): cycling mode,
 *  and a triathlete whose reference week holds under TRI_LOW_HOURS_THRESHOLD_H
 *  of training (Goeringer's "under 8 h a week", read as total weekly
 *  training), who tapers in race week only. The reference week is the one the
 *  distance's taper measures against (the last base, build or peak week
 *  before it that is not a deload), sized by its hour budget: swim, bike and
 *  run, the brick run, and commute runs (running load). Gym is left out: a
 *  taper cuts endurance volume, and race-week gym is handled on its own. */
export function triTaperOpts(state: SimulatorState, trainingWeeks: number): { cyclingOnly: boolean; lowHours: boolean } {
  const cyclingOnly = triIsCyclingOnly(state);
  if (cyclingOnly) return { cyclingOnly, lowHours: false };
  const phases = computeTriPlanPhases(state.triConfig!.distance, trainingWeeks);
  let start = trainingWeeks;
  while (start > 1 && phases[start - 2]?.ph === 'taper') start--;
  let refWeek = 1;
  let refPhase: TrainingPhase = 'peak';
  for (let w = start - 1; w >= 1; w--) {
    const ph = phases[w - 1].ph;
    if (ph !== 'taper' && !isFourWeekCycleDeloadWeek(w, ph)) { refWeek = w; refPhase = ph; break; }
  }
  const ref = triWeekSizing(state, refWeek, trainingWeeks, refPhase, { ignoreDeload: true });
  const brickRunMin = ref.brickActive ? ref.runHours * 60 * ref.brickPolicy.runShare : 0;
  const trainingMin = ref.weekHours * 60 + brickRunMin + ref.reservedCommuteMin;
  return { cyclingOnly, lowHours: trainingMin < TRI_LOW_HOURS_THRESHOLD_H * 60 };
}

/** The plan's phases (race taper per triRaceTaperWeeks). */
function triPlanPhases(state: SimulatorState, trainingWeeks: number) {
  return computeTriPlanPhases(state.triConfig!.distance, trainingWeeks, triTaperOpts(state, trainingWeeks));
}

/** The race taper of a plan: its first week, its length, and the reference
 *  week it is measured against (the last base, build or peak week before it
 *  that is not a deload). A plan with no such week (race week alone, or only
 *  deload weeks before the taper) measures against a full peak week sized at
 *  the week before the taper. */
interface TriRaceTaper {
  start: number;
  weeks: number;
  refWeek: number;
  refPhase: TrainingPhase;
}

function triRaceTaper(state: SimulatorState, trainingWeeks: number): TriRaceTaper | null {
  if (state.continuousMode || trainingWeeks < 1) return null;
  const phases = triPlanPhases(state, trainingWeeks);
  let start = trainingWeeks;
  while (start > 1 && phases[start - 2]?.ph === 'taper') start--;
  for (let w = start - 1; w >= 1; w--) {
    const ph = phases[w - 1].ph;
    if (ph !== 'taper' && !isFourWeekCycleDeloadWeek(w, ph)) {
      return { start, weeks: trainingWeeks - start + 1, refWeek: w, refPhase: ph };
    }
  }
  return { start, weeks: trainingWeeks - start + 1, refWeek: Math.max(1, start - 1), refPhase: 'peak' };
}

/** The reference week's sessions and its per-discipline minutes and counts
 *  (brick legs in their discipline, the brick one bike session; commutes and
 *  gym excluded). Built by the same generator, deload and holiday ignored. */
function triReference(state: SimulatorState, trainingWeeks: number, taper: TriRaceTaper): { parts: TriWeekParts; ref: TriTaperRef } {
  const parts = triWeekParts(state, taper.refWeek, trainingWeeks, taper.refPhase, { ignoreDeload: true });
  const mins = (l: Workout[]) => l.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
  const brickBike = parts.brick?.brickSegments?.[0]?.durationMin ?? 0;
  const brickRun = parts.brick?.brickSegments?.[1]?.durationMin ?? 0;
  const ref: TriTaperRef = {
    minutes: { swim: mins(parts.swim), bike: mins(parts.bike) + brickBike, run: mins(parts.run) + brickRun },
    counts: { swim: parts.swim.length, bike: parts.bike.length + (parts.brick ? 1 : 0), run: parts.run.length },
    total: parts.swim.length + parts.bike.length + (parts.brick ? 1 : 0) + parts.run.length,
  };
  return { parts, ref };
}

/** The reference week a plan's race taper is sized from (its week number and
 *  per-discipline minutes and counts), as the generator builds it: before
 *  any race-window cut, deload and holiday ignored. Null without a race
 *  taper (continuous mode). For tests and the forecast's checks. */
export function triTaperReference(state: SimulatorState, trainingWeeks: number): { refWeek: number; ref: TriTaperRef } | null {
  const taper = triRaceTaper(state, trainingWeeks);
  if (!taper) return null;
  return { refWeek: taper.refWeek, ref: triReference(state, trainingWeeks, taper).ref };
}

/** Per-day minute caps from the user's weekday/weekend split (the scheduler
 *  spills overflow toward the weekend when weekday capacity runs out). */
function triDayCaps(state: SimulatorState, weekHours: number): Record<number, number> {
  const tri = state.triConfig!;
  const weekdayHours = Math.min(
    weekHours,
    tri.weekdayHoursPerWeek ?? Math.round(weekHours * 0.4 * 2) / 2
  );
  const weekendHours = Math.max(0, weekHours - weekdayHours);
  // Distribute weekday minutes across 5 days, weekend across 2 days. Slight
  // bias: day caps carry 20% headroom so a single long-ish session still
  // fits on its preferred day.
  const weekdayCap = Math.round((weekdayHours * 60) / 5 * 1.5);  // mid-bound per-day
  const weekendCap = Math.round((weekendHours * 60) / 2 * 1.2);
  return {
    0: weekdayCap, 1: weekdayCap, 2: weekdayCap, 3: weekdayCap, 4: weekdayCap,
    5: weekendCap, 6: weekendCap,
  };
}

function generateWeekForTriathlon(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: TrainingPhase,
  /** Race-day layout of a plan with a race date (triWeekForRace). */
  ctx?: TriWeekGenCtx,
): Workout[] {
  // Race taper (tri-taper.ts; SCIENCE_LOG "Triathlon and cycling taper
  // rebuild"): its weeks are sized from the reference week, not from the
  // hours multiplier. Race week is the final training week whatever its label.
  const taper = triRaceTaper(state, totalWeeks);
  if (taper && weekIndex >= taper.start) {
    const reference = triReference(state, totalWeeks, taper);
    return isRaceWeek(weekIndex, totalWeeks, state.continuousMode)
      ? triRaceWeek(state, weekIndex, totalWeeks, taper, reference, ctx)
      : finishTriWeek(state, weekIndex, phase, triTaperWeekOne(state, weekIndex, totalWeeks, reference.parts), spreadTaperDoubles);
  }
  return finishTriWeek(state, weekIndex, phase, triWeekParts(state, weekIndex, totalWeeks, phase));
}

/** Injury gates, scheduling and slot ids for a week's parts. */
function finishTriWeek(
  state: SimulatorState, weekIndex: number, phase: TrainingPhase, parts: TriWeekParts,
  /** A step between scheduling and the slot ids (taper week 1: spreadTaperDoubles). */
  afterSchedule?: (scheduled: Workout[]) => Workout[],
): Workout[] {
  // Apply discipline-gate filtering when an injury is active. 'no' drops the
  // discipline entirely; 'limited' collapses it to a single easy recovery
  // session that maintains the modality without aggravating the injury. The
  // brick is dropped whenever either leg is gated, since it is a stacked
  // intensity session that compounds risk on whichever side is compromised.
  //
  // weeksFromCurrent is passed so per-week ramp logic can decide if the ramp
  // window covers THIS specific future week. Without it, a 2-week ramp set
  // at week 5 would incorrectly downmix every week 5–16 in a 16-week plan.
  //
  // Past weeks are skipped entirely: a current injury cannot retroactively
  // rewrite what was prescribed in the past. This matters because main.ts's
  // version-bump regen calls this for every week 1..tw.
  const run = [...parts.run, ...parts.commutes];
  const adapted = triGates(state, weekIndex, parts.swim, parts.bike, run, parts.brick, parts.gym);
  const scheduled = scheduleTriathlonWeek(
    adapted.swim,
    adapted.bike,
    adapted.run,
    adapted.brick,
    phase,
    adapted.gym,
    triDayCaps(state, parts.weekHours),
  );
  const out = afterSchedule ? afterSchedule(scheduled) : scheduled;
  stampTriWorkoutIds(out, weekIndex);
  return out;
}

/**
 * Taper week 1 (planning side): no discipline twice on one day. The week keeps
 * every reference session at TRI_TAPER_FIRST_WEEK_FRACTION of its length
 * (Tristan, decision 5), so for an athlete with few weekday hours the smaller
 * sessions fit the weekend caps the scheduler fills first (its weekend
 * two-a-day, step 3; SCIENCE_LOG §CZ limitation 9, ISSUE-379), and the brick
 * that kept runs off Saturday has become the solo long ride: at 0 weekday
 * hours Saturday held up to six sessions, two of each discipline. Two sessions
 * of a discipline on one day give the stimulus of one with more fatigue (the
 * scheduler's race-week rule), so frequency means separate days. Each extra
 * session of a discipline on a day (the longest stays) moves to the day
 * without that discipline holding the fewest sessions, nearest its own day
 * among equals; a run never goes beside the long run or the brick (the
 * scheduler's rule). With no such day it stays. Gym and commutes are left
 * where the scheduler put them.
 */
function spreadTaperDoubles(ws: Workout[]): Workout[] {
  const out = ws.map(w => ({ ...w }));
  const counts = (w: Workout) => w.t !== 'gym' && !w.commute;
  const discOf = (w: Workout) => w.discipline ?? 'run';
  const holds = (dow: number, d: string) => out.some(w => w.dayOfWeek === dow && counts(w)
    && (w.t === 'brick' ? d === 'bike' || d === 'run' : discOf(w) === d));
  const runAnchored = (dow: number) => out.some(w => w.dayOfWeek === dow && (w.t === 'brick' || isLongRun(w)));
  const perDay = (dow: number) => out.filter(w => w.dayOfWeek === dow).length;
  for (let dow = 0; dow < 7; dow++) {
    for (const d of ['swim', 'bike', 'run']) {
      const same = out.filter(w => w.dayOfWeek === dow && counts(w) && w.t !== 'brick' && discOf(w) === d);
      if (same.length < 2) continue;
      const keep = same.reduce((b, w) => ((w.estimatedDurationMin ?? 0) > (b.estimatedDurationMin ?? 0) ? w : b), same[0]);
      for (const w of same) {
        if (w === keep || isLongRun(w)) continue;
        const days = [0, 1, 2, 3, 4, 5, 6].filter(x => x !== dow && !holds(x, d) && !(d === 'run' && runAnchored(x)));
        if (days.length === 0) continue;
        const target = days.reduce((b, x) => ((perDay(x) - perDay(b)) || (Math.abs(x - dow) - Math.abs(b - dow))) < 0 ? x : b, days[0]);
        w.dayOfWeek = target;
        w.dayName = TRI_DAY_NAMES[target];
      }
    }
  }
  return out.map((w, i) => ({ w, i })).sort((a, b) => ((a.w.dayOfWeek ?? 0) - (b.w.dayOfWeek ?? 0)) || (a.i - b.i)).map(x => x.w);
}

function triGates(
  state: SimulatorState, weekIndex: number,
  swim: Workout[], bike: Workout[], run: Workout[], brick: Workout | null, gym: Workout[],
) {
  const injuryState = (state as any).injuryState as InjuryState | undefined;
  const isPastWeek = weekIndex < (state.w ?? 1);
  const weeksFromCurrent = Math.max(0, weekIndex - (state.w ?? 1));
  return isPastWeek
    ? { swim, bike, run, brick, gym }
    : applyTriInjuryGates(swim, bike, run, brick, gym, injuryState, weeksFromCurrent);
}

/** Session context shared by the taper builders. */
function triTaperCtx(state: SimulatorState, weekIndex: number, totalWeeks: number, phase: TrainingPhase): TriTaperSessionCtx {
  const tri = state.triConfig!;
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const cyclingOnly = triIsCyclingOnly(state);
  const pace = triWeekSizing(state, weekIndex, totalWeeks, phase).easyPaceSecPerKm
    ?? easyPaceSecPerKmFromSkill(rating.run as TriSkillSlider);
  return {
    shortCourse: !triTaperCapsAtRacePace(tri.distance, cyclingOnly),
    bikeIF: triRaceBikeIntensity(tri.distance, cyclingOnly, state.onboarding?.cyclingDistance),
    ftp: tri.bike?.ftp,
    hasPowerMeter: tri.bike?.hasPowerMeter,
    cssSecPer100m: tri.swim?.cssSecPer100m,
    swimSkill: rating.swim as TriSkillSlider,
    easyLabel: `${fmtModelPaceKm(pace)}/km`,
  };
}

/** One session of a taper week before sizing (triTaperWeekOne). */
interface TaperSlot {
  /** The session's share: the fraction x its reference minutes. */
  share: number;
  /** Its reference session's minutes (a taper session never runs longer). */
  ref: number;
  /** Quality sessions: minutes that hold the sourced main set inside the
   *  shortest warm-up and cool-down, and minutes that hold Dave Scott's
   *  4-min floor. */
  need: number;
  minimal: number;
  quality: boolean;
  build: (minutes: number) => Workout;
}

/**
 * Minutes per session that add up to `budget` (planning side). Each session
 * starts at its share; a quality session rises to the minutes its sourced
 * main set needs (no longer than its reference session), and every session
 * to TRI_TAPER_SESSION_FLOOR_MIN. The excess comes off the longest sessions:
 * first the aerobic sessions down to the floor and quality sessions down to
 * their need (steady minutes go first), then quality sessions down to the
 * minutes that hold Dave Scott's 4-min floor. When nothing more can come off,
 * the week stays above its budget (frequency and the floor win).
 */
function fitTaperSlots(slots: TaperSlot[], budget: number): number[] {
  const F = TRI_TAPER_SESSION_FLOOR_MIN;
  const cap = (s: TaperSlot, m: number) => Math.max(F, Math.min(m, Math.max(s.ref, F)));
  const first = slots.map(s => (s.quality ? cap(s, s.need) : F));
  const final = slots.map(s => (s.quality ? cap(s, s.minimal) : F));
  const out = slots.map((s, i) => Math.max(s.share, first[i]));
  let excess = out.reduce((a, m) => a + m, 0) - budget;
  const take = (mins: number[]) => {
    while (excess > 0.5) {
      let idx = -1;
      for (let i = 0; i < out.length; i++) {
        if (out[i] > mins[i] + 1e-9 && (idx < 0 || out[i] > out[idx])) idx = i;
      }
      if (idx < 0) break;
      const t = Math.min(excess, out[idx] - mins[idx]);
      out[idx] -= t;
      excess -= t;
    }
  };
  take(first);
  take(final);
  return out.map(m => Math.round(m));
}

/**
 * The first week of a two-week race taper (planning side, Tristan
 * 2026-10-13): the reference week's sessions at TRI_TAPER_FIRST_WEEK_FRACTION
 * of each discipline's minutes. Every session stays (frequency 100% of the
 * reference), and each quality session stays quality, its kind through the
 * taper gate (tri-intensity-profile TRI_TAPER_INTENSITY_CEILING):
 *   - Sprint and Olympic keep 75% of the reference structure's reps
 *     (Goeringer 8 x 800 m to 6 x 800 m): 11 of the library's 15 x 30:30, 3 x
 *     6 min of its 4 x 6 min threshold run, 75% of the CSS or speed reps the
 *     reference swim holds. The cut falls on warm-up, cool-down and the
 *     discipline's steady minutes first; only a discipline with no steady
 *     minutes left shortens the main set, never below Dave Scott's 4 min.
 *   - Long course and cycling hold race-pace work inside Dave Scott's 4 to 12
 *     min sets (at most 75% of the reference session's work), as many 90 s
 *     repeats as the session's share holds.
 * The brick (build and peak only, TRI_BRICK_POLICY) becomes the solo long
 * ride; its transition-run minutes join the runs. Endurance rides take the
 * steady variant (never "fasted (optional)", as in race week). Commutes and
 * gym stay as the week's own commitments.
 */
function triTaperWeekOne(state: SimulatorState, weekIndex: number, totalWeeks: number, refParts: TriWeekParts): TriWeekParts {
  const tri = state.triConfig!;
  const f = TRI_TAPER_FIRST_WEEK_FRACTION;
  const phase: TrainingPhase = 'taper';
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const own = triWeekParts(state, weekIndex, totalWeeks, phase);
  const ctx = triTaperCtx(state, weekIndex, totalWeeks, phase);
  const cyclingOnly = triIsCyclingOnly(state);
  const dur = (w: Workout) => w.estimatedDurationMin ?? 0;
  const css = tri.swim?.cssSecPer100m;
  const swimSkill = rating.swim as TriSkillSlider;
  const sum = (l: number[]) => l.reduce((a, m) => a + m, 0);
  const racePaceSlot = (discipline: 'swim' | 'bike' | 'run', refW: Workout, share: number, ref: number): TaperSlot => {
    const targetReps = triRacePaceTargetReps(triQualityWorkMinutes(refW, css, swimSkill));
    const minimal = triRacePaceNeedMin(discipline, TRI_RACE_PACE_MIN_REPS, ctx);
    return {
      share, ref, need: minimal, minimal, quality: true,
      build: m => triRacePaceSession({ discipline, minutes: m, targetReps, role: 'race_pace', ctx }),
    };
  };
  const sized = (slots: TaperSlot[]) => {
    const mins = fitTaperSlots(slots, sum(slots.map(s => s.share)));
    return slots.map((s, i) => s.build(mins[i]));
  };

  // Swim.
  const swim = sized(refParts.swim.map((w, i): TaperSlot => {
    const share = f * dur(w);
    const quality = w.t === 'swim_threshold' || w.t === 'swim_speed';
    const kind = quality ? selectSwimQualityKind(tri.distance, phase, i, weekIndex) : (w.t.replace('swim_', '') as SwimSessionKind);
    if (kind === 'race_pace') return racePaceSlot('swim', w, share, dur(w));
    if (kind === 'threshold' || kind === 'speed') {
      const plan = triTaperSwimPlan(kind, dur(w), swimSkill, css);
      return {
        share, ref: dur(w), need: plan.needMin, minimal: triTaperSwimMinMin(plan, swimSkill, css), quality: true,
        build: m => triTaperQualitySwim({ kind, minutes: m, plan, skill: swimSkill, css, weekIndex, totalWeeks, slotIndex: i }),
      };
    }
    return {
      share, ref: dur(w), need: 0, minimal: 0, quality: false,
      build: m => generateSwimSession({
        phase, skill: swimSkill, weekIndex, totalWeeks, targetMinutes: m, kind, cssSecPer100m: css, slotIndex: i,
      }),
    };
  }));

  // Bike: the solo sessions, then the brick's ride as the solo long ride.
  const brickBike = refParts.brick?.brickSegments?.[0]?.durationMin ?? 0;
  const refBikes: Array<{ w: Workout | null; t: string; min: number; long: boolean }> = refParts.bike.map((w, i) => ({
    w, t: w.t, min: dur(w), long: !refParts.brick && i === refParts.bike.length - 1,
  }));
  if (refParts.brick) refBikes.push({ w: null, t: 'bike_endurance', min: brickBike, long: true });
  const excluded = new Set<string>(state.onboarding?.cyclingExcludedWorkouts ?? []);
  const bikeSlot = (b: typeof refBikes[number], i: number): TaperSlot => {
    const share = f * b.min;
    const endurance = (m: number) => {
      // The steady variant, never "fasted endurance (optional)".
      const ride = generateBikeSession({
        phase, skill: rating.bike as TriSkillSlider, weekIndex, totalWeeks, targetMinutes: m, kind: 'endurance',
        ftp: tri.bike?.ftp, hasPowerMeter: tri.bike?.hasPowerMeter, slotIndex: i, variantIndex: 0,
      });
      return b.long ? { ...ride, longRide: true } : ride;
    };
    if (b.t === 'bike_endurance' || !b.w) return { share, ref: b.min, need: 0, minimal: 0, quality: false, build: endurance };
    const q = selectBikeQualityKind(tri.distance, phase, i, weekIndex, cyclingOnly);
    if (q === 'race_pace') return racePaceSlot('bike', b.w, share, b.min);
    const kind = substituteExcluded(q, excluded);
    if (kind === 'vo2_micros') {
      return {
        share, ref: b.min, need: triTaperMicrosNeedMin(), minimal: triTaperMicrosNeedMin(TRI_TAPER_MICROS_MIN_REPS), quality: true,
        build: m => triTaperVo2MicrosRide({
          minutes: m, ftp: tri.bike?.ftp, hasPowerMeter: tri.bike?.hasPowerMeter,
          weekIndex, totalWeeks, skill: rating.bike as TriSkillSlider, slotIndex: i,
        }),
      };
    }
    return {
      share, ref: b.min, need: 0, minimal: 0, quality: true,
      build: m => generateBikeSession({
        phase, skill: rating.bike as TriSkillSlider, weekIndex, totalWeeks, targetMinutes: m, kind,
        ftp: tri.bike?.ftp, hasPowerMeter: tri.bike?.hasPowerMeter, slotIndex: i, variantIndex: 0,
      }),
    };
  };
  const bike = sized(refBikes.map(bikeSlot));

  // Run: each run's share plus its share of the brick's transition run.
  const brickRun = refParts.brick?.brickSegments?.[1]?.durationMin ?? 0;
  const runRef = refParts.run.reduce((a, w) => a + dur(w), 0);
  const easyPace = triWeekSizing(state, weekIndex, totalWeeks, phase).easyPaceSecPerKm;
  const run = sized(refParts.run.map((w, i): TaperSlot => {
    const refMin = dur(w) + (runRef > 0 ? brickRun * dur(w) / runRef : 0);
    const share = f * refMin;
    let kind: TriRunKind = isLongRun(w) ? 'long' : (w.t === 'threshold' || w.t === 'vo2') ? 'threshold' : 'easy';
    if (kind === 'threshold') {
      const q = selectRunQualityKind(tri.distance, phase, i, weekIndex);
      if (q === 'race_pace') return racePaceSlot('run', w, share, refMin);
      kind = q;
    }
    const quality = kind === 'threshold';
    const k = kind;
    return {
      share, ref: refMin,
      need: quality ? triTaperThresholdRunNeedMin() : 0,
      minimal: quality ? triTaperThresholdRunNeedMin(1) : 0,
      quality,
      build: m => buildTriRun(k, phase, m, rating.run as TriSkillSlider, weekIndex, i, easyPace, 1, true),
    };
  }));

  return { swim, bike, run, commutes: own.commutes, brick: null, gym: own.gym, weekHours: own.weekHours };
}

/**
 * Race week (planning side, Tristan 2026-10-13): composed from the reference
 * week by composeTriRaceWeek (tri-taper.ts) at TRI_RACE_WEEK_FRACTION after a
 * taper week, TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION when race week is the whole
 * taper. Sessions sit relative to race day: the race-day layout when the plan
 * has one, else a Sunday race. Day caps are the athlete's normal ones (the
 * reference week's hours, triDayCaps); they choose days, never drop a
 * session. Commute runs keep to weekdays at least 3 days out without another
 * run, so the last two days stay light. Gym keeps to days at least 4 days out
 * (Dave Scott: last strength session 5 or 4 days out) holding fewer than
 * TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY sessions (commutes counted). Both take
 * the days holding the fewest sessions first; a commute or gym session with
 * no day is left out, as the race-week scheduler did.
 */
function triRaceWeek(
  state: SimulatorState, weekIndex: number, totalWeeks: number, taper: TriRaceTaper,
  reference: { parts: TriWeekParts; ref: TriTaperRef },
  genCtx?: TriWeekGenCtx,
): Workout[] {
  const { ref } = reference;
  const tri = state.triConfig!;
  const phase: TrainingPhase = 'taper';
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const disciplines = tri.disciplines ?? ['swim', 'bike', 'run'];
  const cyclingOnly = triIsCyclingOnly(state);
  const fraction = taper.weeks <= 1 ? TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION : TRI_RACE_WEEK_FRACTION;
  const ctx = triTaperCtx(state, weekIndex, totalWeeks, phase);
  const own = triWeekParts(state, weekIndex, totalWeeks, phase);

  // Days before race day for each weekday of race week.
  const layout = genCtx?.layout ?? null;
  const firstDow = genCtx?.firstDow ?? 0;
  const weekStart = (weekIndex - 1) * 7;
  const daysOut: Array<number | null> = [0, 1, 2, 3, 4, 5, 6].map(dow => {
    if (dow < firstDow) return null;
    const d = layout ? layout.raceDayIndex - (weekStart + dow) : 6 - dow; // no layout: a Sunday race
    return d >= 1 ? d : null;
  });

  const easyPace = triWeekSizing(state, weekIndex, totalWeeks, phase).easyPaceSecPerKm;
  // A one-week taper's race week never holds more than the week before (a
  // deload week there can sit near race week's fraction), read from that week
  // as generated (injury gates and the scheduler applied), before the race
  // window. The window's cut of a Thursday or Friday race's week before is
  // taper already; capping race week by it would deepen race week below the
  // band, and the forecast, which adds the cut back (Week.raceWindowCut),
  // would move with the window (race-window-forecast.test.ts). Swim, bike,
  // run and brick minutes; gym and commutes excluded, as race week counts
  // them. The effort multiplier, applied after generation, is not included.
  let maxTotalMin: number | undefined;
  if (taper.weeks <= 1 && weekIndex > 1) {
    const prevPhase = triPlanPhases(state, totalWeeks)[weekIndex - 2]?.ph ?? 'peak';
    const prevFirstDow = firstTrackedDow(state.planStartDate, weekIndex - 1, state.planCreatedAt);
    const prev = generateWeekForTriathlon(state, weekIndex - 1, totalWeeks, prevPhase, { layout: genCtx?.layout ?? null, firstDow: prevFirstDow });
    maxTotalMin = dropSessionsOnOrAfterRaceDay(prev, weekIndex - 1, state.planStartDate, tri.raceDate)
      .filter(w => w.t !== 'gym' && !w.commute)
      .reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
  }
  const composed = composeTriRaceWeek({
    maxTotalMin,
    present: { swim: disciplines.includes('swim'), bike: disciplines.includes('bike'), run: disciplines.includes('run') },
    longCourse: !cyclingOnly && triTaperCapsAtRacePace(tri.distance),
    singleSport: cyclingOnly,
    fraction,
    ref,
    daysOut,
    // The athlete's normal day caps: the reference week's hours.
    dayCapMin: triDayCaps(state, reference.parts.weekHours),
    ctx,
    aerobic: (d, minutes, slot) => {
      if (d === 'swim') {
        return generateSwimSession({
          phase, skill: rating.swim as TriSkillSlider, weekIndex, totalWeeks, targetMinutes: minutes,
          kind: 'endurance', cssSecPer100m: tri.swim?.cssSecPer100m, slotIndex: slot, variantIndex: 0,
        });
      }
      if (d === 'bike') {
        // The steady endurance ride, never the "fasted (optional)" variant.
        return generateBikeSession({
          phase, skill: rating.bike as TriSkillSlider, weekIndex, totalWeeks, targetMinutes: minutes,
          kind: 'endurance', ftp: tri.bike?.ftp, hasPowerMeter: tri.bike?.hasPowerMeter, slotIndex: slot, variantIndex: 0,
        });
      }
      return buildTriRun('easy', phase, minutes, rating.run as TriSkillSlider, weekIndex, slot, easyPace, 1, true);
    },
    dayBeforeRide: minutes => triDayBeforeRide({
      minutes, ftp: tri.bike?.ftp, hasPowerMeter: tri.bike?.hasPowerMeter,
      skill: rating.bike as TriSkillSlider, weekIndex, totalWeeks,
    }),
  });

  // Fixed commitments: gym 4+ days out, commutes 3+ days out on weekdays,
  // each on the days holding the fewest sessions first.
  const perDay = (dow: number) => composed.filter(w => w.dayOfWeek === dow).length;
  const fewestFirst = (days: number[]) => days
    .map((dow, i) => ({ dow, i }))
    .sort((a, b) => (perDay(a.dow) - perDay(b.dow)) || (a.i - b.i))
    .map(x => x.dow);
  const runDays = new Set(composed.filter(w => (w.discipline ?? 'run') === 'run' || w.t === 'brick').map(w => w.dayOfWeek));
  const commuteDays = fewestFirst([2, 3, 1, 4, 0].filter(dow => daysOut[dow] != null && daysOut[dow]! >= 3 && !runDays.has(dow)));
  const commutes = own.commutes.slice(0, commuteDays.length)
    .map((w, i) => ({ ...w, dayOfWeek: commuteDays[i], dayName: TRI_DAY_NAMES[commuteDays[i]] }));

  const brick = composed.find(w => w.t === 'brick') ?? null;
  const byDisc = (d: string) => composed.filter(w => w.t !== 'brick' && (w.discipline ?? 'run') === d);
  const adapted = triGates(state, weekIndex, byDisc('swim'), byDisc('bike'), [...byDisc('run'), ...commutes], brick, own.gym);
  // Gym counts toward the two-a-day limit (TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY,
  // commutes included in the day's count): it takes a day 4 or more days out
  // with a slot left, and is left out when every such day is full.
  const withCommutes = (dow: number) => perDay(dow) + commutes.filter(w => w.dayOfWeek === dow).length;
  const gymDays = fewestFirst([0, 1, 2, 3, 4, 5, 6].filter(dow => daysOut[dow] != null && daysOut[dow]! >= 4
    && withCommutes(dow) < TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY));
  const gym = adapted.gym.slice(0, gymDays.length)
    .map((w, i) => ({ ...w, dayOfWeek: gymDays[i], dayName: TRI_DAY_NAMES[gymDays[i]] }));
  const all = [...adapted.swim, ...adapted.bike, ...adapted.run, ...(adapted.brick ? [adapted.brick] : []), ...gym];
  const out = all
    .map((w, i) => ({ w, i }))
    .sort((a, b) => ((a.w.dayOfWeek ?? 0) - (b.w.dayOfWeek ?? 0)) || (a.i - b.i))
    .map(({ w }) => w);
  stampTriWorkoutIds(out, weekIndex);
  return out;
}

/**
 * A training week's swim, bike, run, brick and gym sessions before injury
 * gates and scheduling (planning side): the week's hour budget (triWeekSizing)
 * split by discipline, the quality slots from the distance and phase profile
 * (tri-intensity-profile), the brick from TRI_BRICK_POLICY. Race-taper weeks
 * are built from the reference week instead (triTaperWeekOne, triRaceWeek).
 */
function triWeekParts(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: TrainingPhase,
  opts: { ignoreDeload?: boolean } = {},
): TriWeekParts {
  // Note (2026-05-26): the running-engine's clinical phase replacement
  // (acute → "Complete Rest", rehab → cross-train) is NOT applied here.
  // For tri/HYROX, the discipline gates are the correct mechanism: a
  // shoulder injury at acute pain doesn't blanket-stop all training, it
  // drops swim while keeping bike + run. The Session 1 "B1" wiring that
  // routed phase workouts through tri was a misread of the running
  // engine. Phase replacement is run-only because running is single-
  // discipline. If the user has every gate set to 'no', the gate
  // downmix below correctly produces an empty week and the empty-state
  // card surfaces "Plan paused this week". The clinical "acute = 72h
  // complete rest" prescription belongs in the user's hands via the
  // discipline gates, not in the plan engine globally.

  const tri = state.triConfig!;
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const gymSessions = state.gs ?? 0;
  const disciplines = tri.disciplines ?? ['swim', 'bike', 'run'];
  const hasRun = disciplines.includes('run');
  const cyclingOnly = triIsCyclingOnly(state);

  const sizing = triWeekSizing(state, weekIndex, totalWeeks, phase, opts);
  const {
    easyPaceSecPerKm, commuteDays, commuteSlotMin, brickPolicy, brickActive,
    weekHours, swimHours, bikeHours, runHours, swimSessions, bikeSessions, runSessions,
  } = sizing;

  // Generate swim sessions. Intensity distribution is race-distance-aware:
  // quality slots take the distance's flavour (short = speed/threshold, long =
  // threshold), aerobic slots stay endurance/technique. See tri-intensity-profile.
  // Long-course taper quality (inter-cycle taper weeks) is a race-pace session.
  const ctx = phase === 'taper' ? triTaperCtx(state, weekIndex, totalWeeks, phase) : null;
  const swim: Workout[] = [];
  const bikeQuality = triQualitySlotIndices(tri.distance, phase, 'bike', bikeSessions, true);
  const swimQuality = triQualitySlotIndices(tri.distance, phase, 'swim', swimSessions, false);
  for (let i = 0; i < swimSessions; i++) {
    const minutes = Math.max(TRI_SESSION_FLOOR_MIN, Math.round((swimHours * 60) / swimSessions));
    const q = swimQuality.has(i) ? selectSwimQualityKind(tri.distance, phase, i, weekIndex) : null;
    if (q === 'race_pace' && ctx) {
      swim.push(triRacePaceSession({ discipline: 'swim', minutes, role: 'race_pace', ctx }));
      continue;
    }
    const kind: SwimSessionKind = q && q !== 'race_pace'
      ? q
      // Aerobic slot: endurance, with a technique touch on the final slot (skill maintenance every phase).
      : (i === swimSessions - 1) ? 'technique' : 'endurance';
    swim.push(generateSwimSession({
      phase,
      skill: rating.swim as TriSkillSlider,
      weekIndex,
      totalWeeks,
      targetMinutes: minutes,
      kind,
      cssSecPer100m: tri.swim?.cssSecPer100m,
      slotIndex: i,
    }));
  }

  // Generate bike sessions. Last one is the aerobic "long ride" (reserved as
  // endurance for every distance). Quality slots take the distance's flavour
  // (short = vo2/vlamax, long = sub-threshold). We might swap the long for a brick.
  // Ironman alternates which key session peaks each build/peak week so the long
  // run and long ride never collide (SCIENCE_LOG §CD). On a run-emphasis week
  // the long ride drops to its maintenance floor; the minutes it frees fund the
  // longer long run below. null for every other distance/phase (share model).
  const triEmphasis = triWeekEmphasis(tri.distance, phase, weekIndex);
  let bikeMinutesFreedForRun = 0;
  const bike: Workout[] = [];
  for (let i = 0; i < bikeSessions; i++) {
    const excluded = new Set<string>(state.onboarding?.cyclingExcludedWorkouts ?? []);
    // Long ride gets bigger slice
    const isLongRide = i === bikeSessions - 1;
    const share = isLongRide ? 0.45 : (0.55 / Math.max(1, bikeSessions - 1));
    let minutes = Math.max(TRI_SESSION_FLOOR_MIN, Math.round(bikeHours * 60 * share));
    if (isLongRide && triEmphasis === 'run') {
      const reduced = Math.max(TRI_SESSION_FLOOR_MIN, Math.round(minutes * TRI_KEY_SESSION_MAINTENANCE));
      bikeMinutesFreedForRun += minutes - reduced;
      minutes = reduced;
    }
    const q = bikeQuality.has(i) ? selectBikeQualityKind(tri.distance, phase, i, weekIndex, cyclingOnly) : null;
    if (q === 'race_pace' && ctx) {
      bike.push(triRacePaceSession({ discipline: 'bike', minutes, role: 'race_pace', ctx }));
      continue;
    }
    const kind: BikeSessionKind = q && q !== 'race_pace' ? substituteExcluded(q, excluded) : 'endurance';
    const session = generateBikeSession({
      phase,
      skill: rating.bike as TriSkillSlider,
      weekIndex,
      totalWeeks,
      targetMinutes: minutes,
      kind,
      ftp: tri.bike?.ftp,
      hasPowerMeter: tri.bike?.hasPowerMeter,
      slotIndex: i,
    });
    // The long ride is a long session (race-window rule).
    bike.push(isLongRide ? { ...session, longRide: true } : session);
  }

  // Run sessions (simple: 1 quality, 1 easy, 1 long). easyPaceSecPerKm resolved
  // above (LT-anchored when VDOT is known) and reused here for the run pace.
  // Body-mass cross-training swap (opt-in, mirrors running): heavier triathletes
  // get gentler EASY aerobic runs. Same shared fraction as running mode; applied
  // to minutes here because tri runs are time-based (running's are km-based).
  // 0 when at/below the population reference or the user turned it off.
  const easyVolumeKeep = state.bodyMassSwapEnabled === false
    ? 1
    : 1 - crossTrainingSwapFraction(state.bodyWeightKg, state.biologicalSex);
  const run: Workout[] = [];
  // Ironman: the long run BUILDS to a ramped time-on-feet target (2:30 peak)
  // rather than taking a fixed 0.45 share of a bike-dominated run budget, which
  // could never reach marathon-relevant durability (SCIENCE_LOG §CD). On a
  // bike-emphasis week it holds at the maintenance floor; on a run-emphasis week
  // it takes its full target, drawing on the minutes the long ride freed above.
  // The other runs split whatever run time remains, floored at 30 min each.
  const imLongTarget = triLongRunTargetMin(tri.distance, weekIndex, totalWeeks, phase);
  let imLongRunMin: number | null = null;
  let imOtherRunMin = 0;
  if (imLongTarget != null && runSessions > 0) {
    const target = triEmphasis === 'bike'
      ? Math.round(imLongTarget * TRI_KEY_SESSION_MAINTENANCE)
      : imLongTarget;
    const otherCount = Math.max(0, runSessions - 1);
    const runBudget = runHours * 60 + bikeMinutesFreedForRun;
    // Never starve the other runs below their 30-min floor to feed the long run.
    const maxLong = runBudget - otherCount * TRI_SESSION_FLOOR_MIN;
    imLongRunMin = Math.max(TRI_SESSION_FLOOR_MIN, Math.min(target, Math.round(maxLong)));
    const remaining = Math.max(0, runBudget - imLongRunMin);
    imOtherRunMin = otherCount > 0 ? Math.max(TRI_SESSION_FLOOR_MIN, Math.round(remaining / otherCount)) : 0;
  }
  for (let i = 0; i < runSessions; i++) {
    const isLong = i === runSessions - 1;
    let minutes: number;
    if (imLongRunMin != null) {
      minutes = isLong ? imLongRunMin : imOtherRunMin;
    } else {
      const share = isLong ? 0.45 : (0.55 / Math.max(1, runSessions - 1));
      minutes = Math.max(TRI_SESSION_FLOOR_MIN, Math.round(runHours * 60 * share));
    }
    const q = !isLong && triQualitySlotIndices(tri.distance, phase, 'run', runSessions, true).has(i)
      ? selectRunQualityKind(tri.distance, phase, i, weekIndex)
      : null;
    if (q === 'race_pace' && ctx) {
      run.push(triRacePaceSession({ discipline: 'run', minutes, role: 'race_pace', ctx }));
      continue;
    }
    run.push(generateRunSessionForTri(phase, i, runSessions, minutes, rating.run as TriSkillSlider, weekIndex, tri.distance, easyPaceSecPerKm, easyVolumeKeep));
  }

  // Brick = the long ride + a transition run off it (SCIENCE_LOG §CD). Pop the
  // long ride (last bike slot, with any emphasis maintenance already applied) out
  // of the solo bike set and wrap it as a brick, so the week carries ONE long-bike
  // day (with the race-specific transition run) instead of a separate medium brick
  // plus a standalone long ride. The transition run is separate from the solo long
  // run. Frequency + run share scale with race distance (TRI_BRICK_POLICY).
  let brick: Workout | null = null;
  if (brickActive && bike.length > 0 && run.length > 0) {
    const longRide = bike.pop()!;
    const bikeMinutes = longRide.estimatedDurationMin ?? Math.round(bikeHours * 60 * 0.45);
    const runMinutes = Math.round(runHours * 60 * brickPolicy.runShare);
    if (bikeMinutes >= 45 && runMinutes >= 15) {
      brick = generateBrick({
        phase,
        skill: rating.bike as TriSkillSlider,
        bikeMinutes,
        runMinutes,
        ftp: tri.bike?.ftp,
        hasPowerMeter: tri.bike?.hasPowerMeter,
      });
    } else {
      bike.push(longRide);  // too short to brick (deep taper / tiny budget): keep it solo
    }
  }

  // Commute runs. Bidirectional commutes emit two slots per day (morning + evening)
  // at the one-way distance. Tagged `commute: true` so the matcher prefers commute
  // actuals against these slots. Each slot carries its real estimatedDurationMin
  // (one-way distance × easy pace, computed above as commuteSlotMin) so the scheduler
  // counts it correctly instead of defaulting to 60min, and so commute time is
  // accounted for in the weekly hours cap (SCIENCE_LOG §CB).
  const commutes: Workout[] = [];
  if (commuteDays > 0 && hasRun && state.commuteConfig) {
    const oneWayKm = state.commuteConfig.distanceKm;
    const bi = state.commuteConfig.isBidirectional;
    const commute = (n: string): Workout => ({
      t: 'easy',
      n,
      d: `${oneWayKm}km`,
      rpe: 3,
      r: 3,
      discipline: 'run',
      commute: true,
      estimatedDurationMin: commuteSlotMin,
    });
    for (let i = 0; i < commuteDays; i++) {
      if (bi) {
        commutes.push(commute(`Commute ${i + 1} (morning)`));
        commutes.push(commute(`Commute ${i + 1} (evening)`));
      } else {
        commutes.push(commute(`Commute ${i + 1}`));
      }
    }
  }

  // Gym sessions
  const gym: Workout[] = [];
  for (let i = 0; i < gymSessions && i < 2; i++) {
    gym.push({
      n: 'Strength',
      d: '45min full-body strength. Core, hip stability, upper-body pull for swim.',
      r: 6,
      t: 'gym',
      rpe: 6,
      aerobic: 20,
      anaerobic: 10,
      estimatedDurationMin: 45,
    });
  }

  return { swim, bike, run, commutes, brick, gym, weekHours };
}

/**
 * Stable per-slot IDs (W{week}-{type}-{idx}) — mirrors the running generator's
 * id loop (generator.ts). Every consumer of a tri workout keys on `w.id ?? w.n`
 * (drag-and-drop, `rated`, `garminActuals`, `garminMatched`, the matching
 * screen). Without ids, a week with duplicate names — two "Endurance ride"
 * bike sessions, two same-region injury-adapted gym sessions — collides on the
 * name: one day's done-state/HR bleeds onto the other, dragging one card moves
 * its same-named sibling, and a synced recording can't bind to its own slot.
 * User-added sessions (`adhoc-` / `holiday-` prefixed) keep their ids.
 * Deterministic given the same generation inputs, so a version-bump regen
 * reproduces the same ids (same fragility class as the running engine).
 */
export function stampTriWorkoutIds(workouts: Workout[], weekNum: number): void {
  const typeCount: Record<string, number> = {};
  for (const w of workouts) {
    if (w.id) continue; // user-added (adhoc-/holiday-) keep their ids and consume no index
    const typeKey = w.t || 'unknown';
    const idx = typeCount[typeKey] || 0;
    typeCount[typeKey] = idx + 1;
    w.id = `W${weekNum}-${typeKey}-${idx}`;
  }
}

/**
 * Apply per-discipline capacity scaling to the generated workouts. The slider
 * model (0–100 per discipline) replaces the prior 3-tier enum: 0 drops the
 * discipline, 100 leaves it untouched, in-between scales each session's
 * duration linearly. Intensity is intentionally NOT capped. The user chose
 * volume-only scaling and self-regulates RPE in the moment. Reads via
 * `getDisciplineCapacity` so legacy enum state still works during migration.
 *
 * The brick is dropped whenever EITHER leg's capacity is less than 100. A
 * brick is a stacked-intensity session; any restriction on either leg risks
 * aggravation when the legs are chained.
 *
 * `weeksFromCurrent` resolves each discipline's per-week recovery horizon.
 * The slider sets the *magnitude* of the restriction; `resumeWeeksByDiscipline`
 * sets *when it ends*. Once the week being generated is at or beyond a
 * discipline's resume week, that discipline is restored to full capacity. So
 * a 2-week swim restriction does not zero swim for the entire macrocycle.
 * Without a captured resume week (legacy state), the discipline keeps the
 * conservative freeze-current-capacity behaviour for all future weeks.
 */
function applyTriInjuryGates(
  swim: Workout[],
  bike: Workout[],
  run: Workout[],
  brick: Workout | null,
  gym: Workout[],
  injuryState: InjuryState | undefined,
  weeksFromCurrent: number = 0
): { swim: Workout[]; bike: Workout[]; run: Workout[]; brick: Workout | null; gym: Workout[] } {
  if (!injuryState?.active) {
    return { swim, bike, run, brick, gym };
  }

  // A discipline is fully recovered for THIS week once we are at or past its
  // captured resume week. Returns the un-restricted capacity (100) in that
  // case, otherwise the user's reported capacity for the discipline.
  const effectiveCap = (disc: DisciplineKey, baseCap: number): number => {
    const resume = injuryState.resumeWeeksByDiscipline?.[disc];
    if (typeof resume === 'number' && weeksFromCurrent >= resume) return 100;
    return baseCap;
  };

  const scaleByCapacity = (arr: Workout[], cap: number, label: string): Workout[] => {
    if (!arr.length) return arr;
    if (cap >= 100) return arr;
    if (cap <= 0) return [];
    const factor = cap / 100;
    return arr.map(w => {
      const a = w as any;
      const scaled: Workout = {
        ...w,
        modReason: `Capacity ${cap}% — ${label} duration scaled to match your reported ability`,
      } as Workout;
      const scaledAny = scaled as any;
      if (typeof a.estimatedDurationMin === 'number') {
        scaledAny.estimatedDurationMin = Math.max(1, Math.round(a.estimatedDurationMin * factor));
      }
      // TSS = intensity × duration; intensity unchanged, so TSS scales with
      // duration. Without this scaling, ACWR / weekly TSS / ATL would over-
      // count the load and produce a false "overload" reading.
      if (typeof a.aerobic === 'number')   scaledAny.aerobic   = Math.round(a.aerobic   * factor);
      if (typeof a.anaerobic === 'number') scaledAny.anaerobic = Math.round(a.anaerobic * factor);
      return scaled;
    });
  };

  const runCap   = effectiveCap('run',  getDisciplineCapacity(injuryState, 'run'));
  const bikeCap  = effectiveCap('bike', getDisciplineCapacity(injuryState, 'bike'));
  const swimCap  = effectiveCap('swim', getDisciplineCapacity(injuryState, 'swim'));

  const newSwim = scaleByCapacity(swim, swimCap, 'swim');
  const newBike = scaleByCapacity(bike, bikeCap, 'bike');
  const newRun  = scaleByCapacity(run,  runCap,  'run');

  // Brick = stacked intensity. Drop whenever either leg is restricted at all.
  const brickSafe = brick && bikeCap >= 100 && runCap >= 100;
  const newBrick = brickSafe ? brick : null;

  // Strength: region-aware. The full-body session loads the lower body (run/
  // bike durability + hip stability) and an upper-body pull for swim, so it is
  // gated on the *injured region* (derived from injury location), not just the
  // upper-load slider the tri modal never shows. A leg injury keeps upper-body
  // + core; a shoulder injury keeps lower-body + core; a trunk injury or the
  // acute phase pauses loaded strength. Each retained session keeps its load
  // ratio scaled to the adapted (shorter) duration.
  const strength = injuryStrengthDecision(injuryState);
  let newGym: Workout[];
  if (strength.kind === 'none') {
    newGym = [];
  } else if (strength.kind === 'adapted') {
    const adaptedDur = (strength.workout as any).estimatedDurationMin ?? 45;
    newGym = gym.map(orig => {
      const o = orig as any;
      const origDur = typeof o.estimatedDurationMin === 'number' && o.estimatedDurationMin > 0
        ? o.estimatedDurationMin : 45;
      const factor = adaptedDur / origDur;
      const w: any = { ...strength.workout };
      if (typeof o.aerobic === 'number')   w.aerobic   = Math.round(o.aerobic   * factor);
      if (typeof o.anaerobic === 'number') w.anaerobic = Math.round(o.anaerobic * factor);
      return w as Workout;
    });
  } else {
    newGym = gym;
  }

  return { swim: newSwim, bike: newBike, run: newRun, brick: newBrick, gym: newGym };
}

// ───────────────────────────────────────────────────────────────────────────
// Session count helpers
// ───────────────────────────────────────────────────────────────────────────

export function countSessions(hours: number, avgSessionHours: number, maxSessions: number): number {
  if (hours <= 0) return 0;
  return Math.min(maxSessions, Math.max(1, Math.round(hours / avgSessionHours)));
}

function phaseMultiplier(phase: TrainingPhase, weekIndex: number, totalWeeks: number): number {
  // Volume ramp within each phase. Linear-ish so early base weeks don't
  // blast a beginner with full peak volume on day one (§4 feedback).
  //   Base: 0.55 at week 1 → 0.85 near end of base
  //   Build: 0.85 → 1.00
  //   Peak: 1.00 → 1.05 → 1.00
  //   Taper: 0.75 → 0.55 → 0.30. Race-taper weeks are sized from the
  //   reference week (triTaperWeekOne, triRaceWeek); here the taper branch
  //   sizes the inter-cycle taper weeks of 28+ week plans (0.75) and the race
  //   taper's own commitments (commutes, gym, day caps).
  switch (phase) {
    case 'base': {
      // How deep into the base phase are we? Week 1 ≈ 0, last base week ≈ 1.
      // Use a simple heuristic: base phase runs from weekIndex 1 up to the
      // last base week. We don't know the exact length here without the
      // distance config, but base weeks are typically 8 (70.3) or 10 (IM).
      // Rough ramp: 0.55 + 0.3 × (weekIndex - 1) / 8, capped at 0.85.
      return Math.min(0.85, 0.55 + 0.3 * ((weekIndex - 1) / 8));
    }
    case 'build': return 0.92;
    case 'peak':  return 1.00;
    case 'taper': {
      const weeksFromEnd = totalWeeks - weekIndex;
      if (weeksFromEnd >= 2) return 0.75;
      if (weeksFromEnd === 1) return 0.55;
      return 0.30;  // race week
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Run session generator (tri-aware, not a fork of the running engine)
// ───────────────────────────────────────────────────────────────────────────

function roundMin(mins: number): number {
  return mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
}

function fmtMin(mins: number): string {
  const r = roundMin(mins);
  const h = Math.floor(r / 60);
  const m = r % 60;
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

const LONG_RUN_VARIANTS = [
  (km: number, dur: string, easy: string) => `~${km}km (${dur}) @ ${easy}. Conversational throughout.`,
  (km: number, dur: string, easy: string) => `~${km}km (${dur}) @ ${easy}, last 20min slightly quicker. Aerobic endurance with mild fatigue resistance.`,
  (km: number, dur: string, easy: string) => `~${km}km (${dur}) — first 30min very relaxed, settle into ${easy} and hold.`,
];

const THRESHOLD_RUN_VARIANTS = [
  (thr: string, _vo2: string, easy: string) => `15min warm up @ ${easy}. 3×8min @ ${thr}, 2min jog recovery. 10min cool down.`,
  (thr: string, _vo2: string, easy: string) => `15min warm up @ ${easy}. 4×6min @ ${thr}, 90s jog recovery. 10min cool down.`,
  (thr: string, _vo2: string, easy: string) => `15min warm up @ ${easy}. 2×12min @ ${thr}, 3min jog recovery. 10min cool down.`,
  (_thr: string, vo2: string, easy: string) => `15min warm up @ ${easy}. 6×4min @ ${vo2}, 90s jog recovery. 10min cool down.`,
];

const EASY_RUN_VARIANTS = [
  (dur: string, easy: string) => `${dur} @ ${easy}. Conversational throughout.`,
  (dur: string, easy: string) => `${dur} @ ${easy}, finish with 6×20s strides. Strides are smooth, not sprints.`,
  (dur: string, easy: string) => `${dur} @ ${easy}. Soft surface if available.`,
];

// VO2 run intervals — short-course quality (sprint/olympic run leg raced near/above
// threshold). vo2 pace already computed as vo2Sec (pace × 0.809).
const VO2_RUN_VARIANTS = [
  (vo2: string, easy: string) => `15min warm up @ ${easy}. 5×3min @ ${vo2}, 3min jog recovery. 10min cool down.`,
  (vo2: string, easy: string) => `15min warm up @ ${easy}. 6×3min @ ${vo2}, 2min jog recovery. 10min cool down.`,
  (vo2: string, easy: string) => `15min warm up @ ${easy}. 8×400m @ ${vo2}, 200m jog. 10min cool down.`,
  (vo2: string, easy: string) => `15min warm up @ ${easy}. 4×4min @ ${vo2}, 3min jog recovery. 10min cool down.`,
];

/** A tri easy run of `minutes`: generateRunSessionForTri's easy branch, also
 *  the eased form of a quality run (spaceStoredPlanQualityRuns). */
function triEasyRunFields(minutes: number, easyLabel: string, rotKey: number) {
  const r = roundMin(minutes);
  const total = r * plannedTssPerMin('easy');
  return {
    n: 'Easy run',
    d: EASY_RUN_VARIANTS[rotKey % EASY_RUN_VARIANTS.length](fmtMin(r), easyLabel),
    t: 'easy',
    rpe: 4,
    aerobic: Math.round(total * 0.95),
    anaerobic: Math.round(total * 0.05),
    estimatedDurationMin: Math.max(20, r),
  };
}

function generateRunSessionForTri(
  phase: TrainingPhase,
  slotIndex: number,
  totalSlots: number,
  minutes: number,
  skill: TriSkillSlider,
  weekIndex: number,
  distance: TriathlonDistance,
  easyPaceSec?: number,
  easyVolumeKeep: number = 1,  // body-mass swap: <1 shortens EASY runs only (1 = no change)
): Workout {
  // Quality vs aerobic is race-distance-aware (TRI_QUALITY_SLOTS) and the last slot
  // is always the aerobic long run. Quality flavour: short course = vo2, long = threshold.
  const isLong = slotIndex === totalSlots - 1;
  const runQuality = triQualitySlotIndices(distance, phase, 'run', totalSlots, true);
  const qualityKind = !isLong && runQuality.has(slotIndex)
    ? selectRunQualityKind(distance, phase, slotIndex, weekIndex)
    : null;
  const kind: TriRunKind = isLong ? 'long'
    : qualityKind === 'vo2' ? 'vo2'
    : qualityKind === 'threshold' ? 'threshold'
    : 'easy';
  return buildTriRun(kind, phase, minutes, skill, weekIndex, slotIndex, easyPaceSec, easyVolumeKeep);
}

/** The tri run kinds the library writes. */
type TriRunKind = 'long' | 'easy' | 'threshold' | 'vo2';

/**
 * One tri run of a given kind. `taperSized`: a threshold run's reps are sized
 * to its minutes (triTaperThresholdRunDesc), so a shorter taper session holds
 * fewer reps.
 */
function buildTriRun(
  kind: TriRunKind,
  phase: TrainingPhase,
  minutes: number,
  skill: TriSkillSlider,
  weekIndex: number,
  slotIndex: number,
  easyPaceSec?: number,
  easyVolumeKeep: number = 1,
  taperSized = false,
): Workout {
  const isLong = kind === 'long';
  const qualityKind = kind === 'vo2' || kind === 'threshold' ? kind : null;

  // Derive pace labels. Mirrors intent_to_workout.ts logic exactly: model
  // paces (gp(s.v, s.lt), unrounded) are written as the whole second.
  const fmtPace = (sec: number) => fmtModelPaceKm(sec);
  const pace = easyPaceSec ?? easyPaceSecPerKmFromSkill(skill);
  const thresholdSec = pace / 1.15;
  const vo2Sec = pace * 0.809;
  const easyLabel = `${fmtPace(pace)}/km`;
  const thresholdLabel = `${fmtPace(thresholdSec)}/km`;
  const vo2Label = `${fmtPace(vo2Sec)}/km`;

  let name: string;
  let desc: string;
  let t: string;
  let rpe: number;
  let aerobic: number;
  let anaerobic: number;
  let durMin = minutes;  // effective duration; reduced only for easy runs (body-mass swap)

  // Variant rotation keys off (weekIndex + slotIndex × 2) so two easy runs
  // in the same week land on different variants rather than cloning.
  const rotKey = Math.abs((weekIndex - 1) + slotIndex * 2);

  // ISSUE-263: run-leg loads are anchored to the canonical type-keyed TSS
  // valuation (plannedTssPerMin — same rule as running mode's
  // calculateWorkoutLoad), so a 60-min tri easy run values identically to a
  // 60-min running-mode easy run (mirror rule). The old per-min pairs were a
  // private ~60/h-easy scale (easy 1.0/min, long 1.25/min = IF 0.87 for an
  // easy-pace run). Aerobic/anaerobic SHARES are preserved from those pairs
  // (long 0.88/0.12, threshold 0.77/0.23, easy 0.95/0.05).
  if (isLong) {
    const r = roundMin(minutes);
    const km = Math.round(((r * 60) / pace) * 2) / 2;  // nearest 0.5 km
    const idx = rotKey % LONG_RUN_VARIANTS.length;
    name = 'Long run';
    desc = LONG_RUN_VARIANTS[idx](km, fmtMin(r), easyLabel);
    t = 'long';
    rpe = phase === 'peak' ? 6 : 5;
    const total = r * plannedTssPerMin('long');
    aerobic = Math.round(total * 0.88);
    anaerobic = Math.round(total * 0.12);
  } else if (qualityKind === 'vo2') {
    // Short-course quality. Anaerobic share from canonical LOAD_PROFILES.vo2 (0.50/0.50).
    const idx = rotKey % VO2_RUN_VARIANTS.length;
    name = 'VO2 run';
    desc = VO2_RUN_VARIANTS[idx](vo2Label, easyLabel);
    t = 'vo2';
    rpe = 9;
    const total = minutes * plannedTssPerMin('vo2');
    aerobic = Math.round(total * 0.50);
    anaerobic = Math.round(total * 0.50);
  } else if (qualityKind === 'threshold') {
    const idx = rotKey % THRESHOLD_RUN_VARIANTS.length;
    name = 'Threshold run';
    desc = taperSized
      ? triTaperThresholdRunDesc(roundMin(minutes), thresholdLabel, easyLabel)
      : THRESHOLD_RUN_VARIANTS[idx](thresholdLabel, vo2Label, easyLabel);
    t = 'threshold';
    rpe = 8;
    const total = minutes * plannedTssPerMin('threshold');
    aerobic = Math.round(total * 0.77);
    anaerobic = Math.round(total * 0.23);
  } else {
    durMin = minutes * easyVolumeKeep;  // body-mass swap trims easy aerobic volume only
    ({ n: name, d: desc, t, rpe, aerobic, anaerobic } = triEasyRunFields(durMin, easyLabel, rotKey));
  }

  return {
    n: name,
    d: desc,
    r: rpe,
    t,
    discipline: 'run',
    rpe,
    aerobic,
    anaerobic,
    estimatedDurationMin: Math.max(20, roundMin(durMin)),
  };
}
