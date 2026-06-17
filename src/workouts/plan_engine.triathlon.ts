/**
 * Triathlon plan engine. Top-level entry for generating a triathlon plan.
 *
 * Generation flow:
 *   1. Phase each week (base → build → peak → taper, plus checkpoint flag for
 *      double-periodization plans ≥28w) via computeTriPlanPhases()
 *   2. Compute weekly total hours from time-available × phase multiplier
 *   3. Split total hours into per-discipline hours via triConfig.volumeSplit
 *   4. Emit sessions per discipline via swim/bike/run generators
 *   5. Hand to scheduler.triathlon.ts for day assignment
 *   6. Wrap into a Week[] compatible with the rest of the app
 *
 * Reuses the running workout library for run sessions to keep the running
 * code path canonical (no fork for the run leg. It's the same muscle as
 * marathon training).
 */

import type { SimulatorState, Week, Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { TriSkillSlider, TriathlonDistance } from '@/types/triathlon';
import type { InjuryState } from '@/types/injury';
import { computeTriPlanPhases } from '@/constants/triathlon-constants';
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
} from './tri-intensity-profile';
import { scheduleTriathlonWeek } from './scheduler.triathlon';
import { applyTriEffortMultipliers } from '@/calculations/effort-multiplier.triathlon';
import { crossTrainingSwapFraction } from '@/calculations/body-mass-adaptations';
import { gp } from '@/calculations/paces';
import { getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';
import { injuryStrengthDecision } from './injury-strength';

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
export const TRI_GENERATOR_VERSION = 18;

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
  const planPhases = computeTriPlanPhases(tri.distance, totalWeeks);
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const p = planPhases[w - 1];
    const phase = p.ph;
    const weekWorkouts = generateWeekForTriathlon(state, w, totalWeeks, phase);

    weeks.push({
      w,
      ph: phase,
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
  applyTriEffortMultipliersToFutureWeeks(state, weeks);

  return weeks;
}

/**
 * Apply per-discipline effort multipliers to ALL future weeks of the plan.
 * Pure mutation. Caller passes the freshly-generated `weeks` array.
 *
 * Skips weeks before `state.w` (those are completed/in-progress and
 * shouldn't have their planned durations re-scaled retroactively).
 */
function applyTriEffortMultipliersToFutureWeeks(state: SimulatorState, weeks: Week[]): void {
  const currentWeek = state.w ?? 1;
  for (const wk of weeks) {
    if ((wk.w ?? 0) < currentWeek) continue;
    if (wk.triWorkouts && wk.triWorkouts.length > 0) {
      // The CTL-gap stamp lives on the STORED week (state.wks), not on this freshly-generated `wk`,
      // so look it up by week number. (Effort reads from `state` directly, so it never had this issue.)
      const stamp = (state.wks?.[(wk.w ?? 1) - 1] as any)?.ctlRatioByDiscipline;
      applyTriEffortMultipliers(state, wk.triWorkouts, stamp);
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
  const planPhases = computeTriPlanPhases(tri.distance, totalWeeks);
  const p = planPhases[weekIndex - 1];
  const phase = p.ph;
  const weekWorkouts = generateWeekForTriathlon(state, weekIndex, totalWeeks, phase);

  // Apply per-discipline effort multiplier + CTL-gap re-anchor when regenerating a future week.
  // For a same-week or past-week regen, skip. Preserves historical duration.
  if (weekIndex >= (state.w ?? 1)) {
    applyTriEffortMultipliers(state, weekWorkouts, (state.wks[weekIndex - 1] as any)?.ctlRatioByDiscipline);
  }

  const existing = state.wks[weekIndex - 1];
  return {
    ...existing,
    ph: phase,
    ...(p.checkpoint ? { checkpoint: true } : { checkpoint: existing.checkpoint }),
    triWorkouts: weekWorkouts,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-week workout generation
// ───────────────────────────────────────────────────────────────────────────

function generateWeekForTriathlon(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: TrainingPhase
): Workout[] {
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
  const timeAvailable = tri.timeAvailableHoursPerWeek ?? 10;
  const split = tri.volumeSplit ?? { swim: 0.175, bike: 0.475, run: 0.35 };
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const gymSessions = state.gs ?? 0;

  // Active disciplines. Defaults to full triathlon when undefined so existing
  // tri behaviour is preserved. Single-discipline modes (V1 cycling) set
  // disciplines=['bike']; swim/run loops below skip when the discipline is
  // absent.
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
  const isDeload = forceDeload || isDeloadWeek(weekIndex, phase);
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
  let runHours    = weekHours * split.run;

  // Session counts by phase. Disciplines that aren't active produce zero
  // sessions so subsequent loops short-circuit to empty arrays. In single-
  // discipline cycling mode the bike cap lifts to 5 because the discipline
  // owns 100% of the week's hours rather than ~50%.
  const isCyclingOnly = disciplines.length === 1 && hasBike;
  const swimSessions = hasSwim ? countSessions(swimHours, TRI_AVG_SESSION_HOURS.swim, TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;
  const bikeSessions = hasBike ? countSessions(bikeHours, TRI_AVG_SESSION_HOURS.bike, isCyclingOnly ? TRI_MAX_BIKE_SESSIONS_CYCLING_ONLY : TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;
  let   runSessions  = hasRun  ? countSessions(runHours,  TRI_AVG_SESSION_HOURS.run,  TRI_MAX_SESSIONS_PER_DISCIPLINE) : 0;

  // Generate swim sessions. Intensity distribution is race-distance-aware:
  // quality slots take the distance's flavour (short = speed/threshold, long =
  // threshold), aerobic slots stay endurance/technique. See tri-intensity-profile.
  const swim: Workout[] = [];
  const swimQuality = triQualitySlotIndices(tri.distance, phase, 'swim', swimSessions, false);
  for (let i = 0; i < swimSessions; i++) {
    const kind: SwimSessionKind = swimQuality.has(i)
      ? selectSwimQualityKind(tri.distance, phase, i, weekIndex)
      // Aerobic slot: endurance, with a technique touch on the final slot (skill maintenance every phase).
      : (i === swimSessions - 1) ? 'technique' : 'endurance';
    const minutes = Math.max(30, Math.round((swimHours * 60) / swimSessions));
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
  const bikeQuality = triQualitySlotIndices(tri.distance, phase, 'bike', bikeSessions, true);
  for (let i = 0; i < bikeSessions; i++) {
    const excluded = new Set<string>(state.onboarding?.cyclingExcludedWorkouts ?? []);
    const kind: BikeSessionKind = bikeQuality.has(i)
      ? substituteExcluded(selectBikeQualityKind(tri.distance, phase, i, weekIndex), excluded)
      : 'endurance';
    // Long ride gets bigger slice
    const isLongRide = i === bikeSessions - 1;
    const share = isLongRide ? 0.45 : (0.55 / Math.max(1, bikeSessions - 1));
    let minutes = Math.max(30, Math.round(bikeHours * 60 * share));
    if (isLongRide && triEmphasis === 'run') {
      const reduced = Math.max(30, Math.round(minutes * TRI_KEY_SESSION_MAINTENANCE));
      bikeMinutesFreedForRun += minutes - reduced;
      minutes = reduced;
    }
    bike.push(generateBikeSession({
      phase,
      skill: rating.bike as TriSkillSlider,
      weekIndex,
      totalWeeks,
      targetMinutes: minutes,
      kind,
      ftp: tri.bike?.ftp,
      hasPowerMeter: tri.bike?.hasPowerMeter,
      slotIndex: i,
    }));
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
    const maxLong = runBudget - otherCount * 30;
    imLongRunMin = Math.max(30, Math.min(target, Math.round(maxLong)));
    const remaining = Math.max(0, runBudget - imLongRunMin);
    imOtherRunMin = otherCount > 0 ? Math.max(30, Math.round(remaining / otherCount)) : 0;
  }
  for (let i = 0; i < runSessions; i++) {
    const isLong = i === runSessions - 1;
    let minutes: number;
    if (imLongRunMin != null) {
      minutes = isLong ? imLongRunMin : imOtherRunMin;
    } else {
      const share = isLong ? 0.45 : (0.55 / Math.max(1, runSessions - 1));
      minutes = Math.max(30, Math.round(runHours * 60 * share));
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
  if (commuteDays > 0 && hasRun && state.commuteConfig) {
    const oneWayKm = state.commuteConfig.distanceKm;
    const bi = state.commuteConfig.isBidirectional;
    for (let i = 0; i < commuteDays; i++) {
      if (bi) {
        run.push({
          t: 'easy',
          n: `Commute ${i + 1} (morning)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteSlotMin,
        });
        run.push({
          t: 'easy',
          n: `Commute ${i + 1} (evening)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteSlotMin,
        });
      } else {
        run.push({
          t: 'easy',
          n: `Commute ${i + 1}`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteSlotMin,
        });
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

  // Build per-day minute caps from the user's weekday/weekend split. The
  // scheduler will spill overflow toward the weekend when weekday capacity
  // runs out. Matches how a 9-to-5 athlete actually trains.
  const totalHours = weekHours;
  const weekdayHours = Math.min(
    totalHours,
    tri.weekdayHoursPerWeek ?? Math.round(totalHours * 0.4 * 2) / 2
  );
  const weekendHours = Math.max(0, totalHours - weekdayHours);
  // Distribute weekday minutes across 5 days, weekend across 2 days. Slight
  // bias: day caps carry 20% headroom so a single long-ish session still
  // fits on its preferred day.
  const weekdayCap = Math.round((weekdayHours * 60) / 5 * 1.5);  // mid-bound per-day
  const weekendCap = Math.round((weekendHours * 60) / 2 * 1.2);
  const minutesCapByDay: Record<number, number> = {
    0: weekdayCap, 1: weekdayCap, 2: weekdayCap, 3: weekdayCap, 4: weekdayCap,
    5: weekendCap, 6: weekendCap,
  };

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
  const injuryState = (state as any).injuryState as InjuryState | undefined;
  const isPastWeek = weekIndex < (state.w ?? 1);
  const weeksFromCurrent = Math.max(0, weekIndex - (state.w ?? 1));
  const adapted = isPastWeek
    ? { swim, bike, run, brick, gym }
    : applyTriInjuryGates(swim, bike, run, brick, gym, injuryState, weeksFromCurrent);

  const scheduled = scheduleTriathlonWeek(
    adapted.swim,
    adapted.bike,
    adapted.run,
    adapted.brick,
    phase,
    adapted.gym,
    minutesCapByDay
  );
  stampTriWorkoutIds(scheduled, weekIndex);
  return scheduled;
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
  //   Taper: 0.75 → 0.55 → 0.30
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

function isDeloadWeek(weekIndex: number, phase: TrainingPhase): boolean {
  if (phase === 'taper') return false;   // Taper is already its own reduction
  // Every 4th week in base + build
  return weekIndex % 4 === 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Run session generator (tri-aware, not a fork of the running engine)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rough Z2 easy pace in sec/km by skill slider. Lets us estimate distance
 * alongside duration for long runs so the user sees "~16 km (1h 45min)"
 * instead of bare minutes.
 */
function easyPaceSecPerKmFromSkill(skill: TriSkillSlider): number {
  // Skill 1 → 7:00/km, 5 → 4:30/km (linear interpolation)
  return 420 - (skill - 1) * 37.5;
}

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

  // Derive pace labels. Mirrors intent_to_workout.ts logic exactly.
  const fmtPace = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
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
    desc = THRESHOLD_RUN_VARIANTS[idx](thresholdLabel, vo2Label, easyLabel);
    t = 'threshold';
    rpe = 8;
    const total = minutes * plannedTssPerMin('threshold');
    aerobic = Math.round(total * 0.77);
    anaerobic = Math.round(total * 0.23);
  } else {
    durMin = minutes * easyVolumeKeep;  // body-mass swap trims easy aerobic volume only
    const r = roundMin(durMin);
    const idx = rotKey % EASY_RUN_VARIANTS.length;
    name = 'Easy run';
    desc = EASY_RUN_VARIANTS[idx](fmtMin(r), easyLabel);
    t = 'easy';
    rpe = 4;
    const total = r * plannedTssPerMin('easy');
    aerobic = Math.round(total * 0.95);
    anaerobic = Math.round(total * 0.05);
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
