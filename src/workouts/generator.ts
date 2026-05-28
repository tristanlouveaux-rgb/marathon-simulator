import type { Workout, Week, TrainingPhase, RaceDistance, RunnerType, CommuteConfig, InjuryState, SportKey } from '@/types';
import type { RecurringActivity } from '@/types/onboarding';
import { WO, LONG_RUN_DISTANCES } from '@/constants';
import { SPORT_LABELS } from '@/constants/sports';
import { calculateWorkoutLoad } from './load';
import { assignDefaultDays } from './scheduler';
import { capitalize } from '@/utils';
import { applyInjuryAdaptations } from '@/injury/engine';
import { generateOrderedRunSlots, type SlotType } from './rules_engine';
import { planWeekSessions } from './plan_engine';
import { intentToWorkout } from './intent_to_workout';
import { getState } from '@/state';
import { swapFractionForState } from '@/calculations/body-mass-adaptations';
import { calculateZones, getWorkoutHRTarget, type HRProfile } from '@/calculations/heart-rate';
import { generateGymWorkouts } from './gym';
import { computePlanPhases } from './phases';

/**
 * Generate workouts for a week based on phase and runner profile
 * @param phase - Training phase
 * @param runsPerWeek - Number of runs per week
 * @param raceDistance - Target race distance
 * @param runnerType - Runner type
 * @param previousSkips - Skipped workouts from previous week
 * @param commuteConfig - Commute configuration
 * @param injuryState - Current injury state (optional)
 * @returns Array of workouts
 */
export function generateWeekWorkouts(
  phase: TrainingPhase,
  runsPerWeek: number,
  raceDistance: RaceDistance,
  runnerType: RunnerType,
  previousSkips: { workout: Workout; skipCount: number }[] = [],
  commuteConfig?: CommuteConfig,
  injuryState?: InjuryState | null,
  recurringActivities?: RecurringActivity[],
  fitnessLevel?: string,
  hrProfile?: HRProfile,
  easyPaceSecPerKm?: number,
  weekIndex?: number,
  totalWeeks?: number,
  vdot?: number,
  gymSessionsPerWeek?: number,
  effortScore?: number,
  acwrStatus?: 'safe' | 'caution' | 'high' | 'unknown',
  forceDeload?: boolean,
  weeklyHoursTarget?: number,
  excludedSlots?: string[],
  weekdayHoursTarget?: number,
): Workout[] {
  // Injury handling is fully delegated to applyInjuryAdaptations (phase-aware engine)
  // at the end of this function. No early return here.

  // Commute-aware planning. `runsPerWeek` is the user's count of DEDICATED
  // (non-commute) runs. Commute runs are appended on top as extra easy
  // aerobic volume. Body doesn't distinguish "training run" from "transport
  // run". Both contribute to aerobic stimulus and impact load. But
  // commutes are user-driven habit, not part of the prescribed plan shape.
  // Previously (Phase 4, 2026-05-14) commutes substituted for prescribed
  // easy runs; user-facing model proved confusing (2 dedicated + 3 commutes
  // looked like only 1 long + 3 commutes because the substitution silently
  // ate both easy slots). 2026-05-20 reverted to "extra on top".

  const workouts: Workout[] = [];

  if (weekIndex != null && totalWeeks != null) {
    // Read archetype + baseline from state. Drives the ramp budget inside
    // planWeekSessions so week 1 starts near the user's current km rather than
    // jumping straight to the ability-driven peak. Falls back to legacy
    // behaviour when state is empty (no Strava history yet).
    const sNow = getState();
    const baselineKm = sNow.detectedWeeklyKm;
    const archetype = sNow.athleteArchetype?.archetype;

    // New plan engine path: time-based sessions with progression & deload
    const intents = planWeekSessions({
      runsPerWeek,
      raceDistance,
      runnerType,
      phase,
      fitnessLevel: fitnessLevel || 'intermediate',
      weekIndex,
      totalWeeks,
      vdot: vdot || 45,
      effortScore,
      acwrStatus,
      forceDeload,
      weeklyHoursTarget,
      excludedSlots,
      baselineKm,
      archetype,
      easyPaceSecPerKm,
    });
    for (const intent of intents) {
      workouts.push(intentToWorkout(intent, raceDistance, runnerType, easyPaceSecPerKm));
    }
  } else {
    // Fallback: existing rules engine (no week context)
    const { slots, warnings } = generateOrderedRunSlots({
      runsPerWeek,
      raceDistance,
      runnerType,
      phase,
      fitnessLevel: fitnessLevel || 'intermediate',
    });

    if (warnings.length > 0) {
      console.warn('Slot allocation warnings:', warnings);
    }

    const typeCapitalized = capitalize(runnerType);
    const lib = WO[raceDistance]?.[typeCapitalized] || {};
    let easyIdx = 0;

    for (const slot of slots) {
      if (slot === 'long') {
        const longDist = LONG_RUN_DISTANCES[raceDistance];
        const adj = phase === 'taper' ? 0.7 : phase === 'peak' ? 1.1 : 1;
        workouts.push({
          t: 'long',
          n: 'Long Run',
          d: `${Math.round(longDist * adj)}km`,
          rpe: 3,
          r: 3,
        });
      } else if (slot === 'easy') {
        const distance = 6 + easyIdx * 2;
        easyIdx++;
        workouts.push({
          t: 'easy',
          n: `Easy ${easyIdx}`,
          d: `${distance}km`,
          rpe: 3,
          r: 3,
        });
      } else {
        const category = slot as keyof typeof lib;
        const libEntries = lib[category];
        if (libEntries && libEntries.length > 0) {
          let woIdx = 0;
          if (libEntries.length > 1) {
            if (slot === 'marathon_pace' && (phase === 'peak' || phase === 'taper')) {
              woIdx = 1;
            } else if (slot === 'race_pace' && phase === 'peak') {
              woIdx = 1;
            }
          }
          workouts.push({ ...libEntries[woIdx], t: slot });
        } else {
          const distance = 6 + easyIdx * 2;
          easyIdx++;
          workouts.push({
            t: 'easy',
            n: `Easy ${easyIdx}`,
            d: `${distance}km`,
            rpe: 3,
            r: 3,
          });
        }
      }
    }
  }

  // ── Body-mass cross-training swap (opt-in) ─────────────────────────────
  // Heavier runners (above the GENERAL-POPULATION reference): gently shorten
  // freshly-prescribed EASY running by swapFraction (≤15%); the freed volume is
  // prescribed as low-impact cross-training. Manages cumulative joint load
  // without cutting the aerobic target.
  //
  // Opt-in: applies unless the user explicitly turned it off
  // (`bodyMassSwapEnabled === false`). Default-on for heavy users until they
  // decide via the onboarding popup. swapFraction is 0 for anyone at/below the
  // population reference. See body-mass-adaptations.test.ts.
  //
  // Scope is deliberately narrow: runs BEFORE makeup/commute/gym/recurring are
  // appended, and only touches `t:'easy'` with a clean "<n>km" description, so
  // commute runs, makeup runs, and cross-training are never altered. Each
  // generation rebuilds easy runs at full length, so the swap never compounds.
  let bodyMassSwapFraction = 0;
  try {
    const sNow2 = getState();
    if (sNow2.bodyMassSwapEnabled !== false) bodyMassSwapFraction = swapFractionForState(sNow2);
  } catch { bodyMassSwapFraction = 0; }
  if (bodyMassSwapFraction > 0) {
    const keep = 1 - bodyMassSwapFraction;
    for (const w of workouts) {
      if (w.t !== 'easy') continue;
      const m = /^(\d+(?:\.\d+)?)km$/.exec(w.d ?? '');
      if (!m) continue;
      const km = parseFloat(m[1]);
      const reduced = Math.max(3, Math.round(km * keep));
      if (reduced < km) {
        w.d = `${reduced}km`;
        if (typeof w.estimatedDurationMin === 'number') {
          w.estimatedDurationMin = Math.round(w.estimatedDurationMin * (reduced / km));
        }
      }
    }
  }

  // Add skipped workouts from previous week (prefix name to avoid collisions)
  for (const skip of previousSkips) {
    workouts.push({
      ...skip.workout,
      n: `[Makeup] ${skip.workout.n}`,
      skipped: true,
      skipCount: skip.skipCount || 1,
      originalName: skip.workout.n
    });
  }

  // Add commute runs if configured. Bidirectional commutes emit two slots
  // per day (morning + evening) at the one-way distance. Matches how the
  // user actually runs them and gives the scheduler a chance to surface
  // both trips. Unidirectional commutes emit one slot per day.
  if (commuteConfig?.enabled && commuteConfig.commuteDaysPerWeek > 0) {
    const oneWayKm = commuteConfig.distanceKm;
    for (let i = 0; i < commuteConfig.commuteDaysPerWeek; i++) {
      if (commuteConfig.isBidirectional) {
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1} (morning)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          commute: true,
        });
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1} (evening)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          commute: true,
        });
      } else {
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1}`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          commute: true,
        });
      }
    }
  }

  // Add gym sessions if configured
  if (gymSessionsPerWeek && gymSessionsPerWeek > 0) {
    const gymWorkouts = generateGymWorkouts(
      phase, gymSessionsPerWeek, fitnessLevel || 'intermediate',
      weekIndex, totalWeeks, vdot, injuryState
    );
    workouts.push(...gymWorkouts);
  }

  // Add recurring cross-training activities
  if (recurringActivities && recurringActivities.length > 0) {
    // Preferred cross-training days (avoid Sun=6 for Long Run)
    const crossDaySlots = [2, 4, 1, 3, 5, 0]; // Wed, Fri, Tue, Thu, Sat, Mon
    let slotIdx = 0;

    for (const act of recurringActivities) {
      const INTENSITY_RPE: Record<string, number> = { easy: 3, moderate: 5, hard: 7 };
      const rpe = INTENSITY_RPE[act.intensity] || 5;

      const sportLabel = act.sport === 'generic_sport'
        ? 'Activity'
        : (SPORT_LABELS[act.sport as SportKey] || capitalize(act.sport));

      for (let f = 0; f < act.frequency; f++) {
        const day = crossDaySlots[slotIdx % crossDaySlots.length];
        slotIdx++;

        workouts.push({
          t: 'cross',
          n: `${sportLabel}${act.frequency > 1 ? ` ${f + 1}` : ''}`,
          d: `${act.durationMin}min ${sportLabel.toLowerCase()}`,
          r: rpe,
          rpe,
          dayOfWeek: day,
          status: 'planned' as const,
        });
      }
    }
  }

  // Calculate loads for each workout
  for (const w of workouts) {
    const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10, easyPaceSecPerKm);
    w.aerobic = loads.aerobic;
    w.anaerobic = loads.anaerobic;
  }

  // Attach HR targets if profile data available
  if (hrProfile) {
    const zones = calculateZones(hrProfile);
    if (zones) {
      for (const w of workouts) {
        const target = getWorkoutHRTarget(w.t, zones);
        if (target) {
          w.hrTarget = target;
        }
      }
    }
  }

  // Assign days of week. Pass weekday/weekend minute budgets when both
  // weeklyHoursTarget and weekdayHoursTarget are set, so the scheduler can
  // honour the user's Mon–Fri / Sat–Sun split (hard constraint).
  let weekdayBudgetMin: number | undefined;
  let weekendBudgetMin: number | undefined;
  if (
    weeklyHoursTarget != null && weeklyHoursTarget > 0 &&
    weekdayHoursTarget != null && weekdayHoursTarget >= 0 &&
    weekdayHoursTarget <= weeklyHoursTarget
  ) {
    weekdayBudgetMin = weekdayHoursTarget * 60;
    weekendBudgetMin = (weeklyHoursTarget - weekdayHoursTarget) * 60;
  }
  let scheduledWorkouts = assignDefaultDays(workouts, weekdayBudgetMin, weekendBudgetMin);

  // Apply injury adaptations if injury is active
  if (injuryState && injuryState.active) {
    scheduledWorkouts = applyInjuryAdaptations(scheduledWorkouts, injuryState, easyPaceSecPerKm);
    // Recalculate loads for adapted workouts (descriptions/RPE changed by injury engine)
    for (const w of scheduledWorkouts) {
      const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10, easyPaceSecPerKm);
      w.aerobic = loads.aerobic;
      w.anaerobic = loads.anaerobic;
    }
  }

  // Generate stable IDs for each workout (W{week}-{type}-{index})
  // Use weekIndex if available, otherwise default to 1
  const wk = weekIndex ?? 1;
  const typeCount: Record<string, number> = {};
  for (const w of scheduledWorkouts) {
    const typeKey = w.t || 'unknown';
    const idx = typeCount[typeKey] || 0;
    typeCount[typeKey] = idx + 1;
    w.id = `W${wk}-${typeKey}-${idx}`;
  }

  return scheduledWorkouts;
}

/**
 * Initialize weeks array for a training plan
 * @param totalWeeks - Total number of weeks
 * @returns Array of week objects
 */
export function initializeWeeks(totalWeeks: number): Week[] {
  const planPhases = computePlanPhases(totalWeeks);
  return planPhases.map((p, i) => ({
    w: i + 1,
    ph: p.ph,
    ...(p.checkpoint ? { checkpoint: true } : {}),
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  }));
}

/**
 * Get phase name for display
 * @param phase - Training phase
 * @returns Display name
 */
export function getPhaseDisplayName(phase: TrainingPhase): string {
  return phase.toUpperCase();
}

/**
 * Generate a complete rehab week - REPLACES normal training
 * Called when injury is active with pain >= 4
 *
 * @param injuryState - Current injury state
 * @returns Array of rehab/cross-training workouts
 */
export function generateRehabWeek(injuryState: InjuryState): Workout[] {
  const pain = injuryState.currentPain;
  const location = injuryState.location || 'other';

  console.log('GENERATING REHAB WEEK for', location, 'pain level', pain);

  // Pain 7-10: Complete rest only
  if (pain >= 7) {
    return assignDefaultDays([
      {
        t: 'rest',
        n: 'Complete Rest',
        d: 'No physical activity - focus on recovery',
        r: 1,
        rpe: 1,
        status: 'planned',
        modReason: `Pain ${pain}/10 - complete rest required`,
      },
      {
        t: 'rest',
        n: 'Rest & Ice',
        d: 'RICE protocol: Rest, Ice, Compress, Elevate',
        r: 1,
        rpe: 1,
        status: 'planned',
        modReason: `Pain ${pain}/10 - complete rest required`,
      },
    ]);
  }

  // Pain 5-6: Cross-training + gentle rehab
  if (pain >= 5) {
    return assignDefaultDays([
      {
        t: 'cross',
        n: 'Pool Session',
        d: '20-30min aqua jogging or swimming',
        r: 3,
        rpe: 3,
        status: 'planned',
        modReason: `Pain ${pain}/10 - low-impact cross-training`,
      },
      {
        t: 'cross',
        n: 'Cycling (Easy)',
        d: '20-30min stationary bike, easy resistance',
        r: 3,
        rpe: 3,
        status: 'planned',
        modReason: `Pain ${pain}/10 - low-impact cross-training`,
      },
      {
        t: 'strength',
        n: 'Rehab Strength',
        d: 'Physio exercises for ' + location,
        r: 2,
        rpe: 2,
        status: 'planned',
        modReason: `Pain ${pain}/10 - rehabilitation exercises`,
      },
    ]);
  }

  // Pain 4: Light cross-training + rehab + easy walk/jog test
  return assignDefaultDays([
    {
      t: 'cross',
      n: 'Cross-Train Session',
      d: '30min pool, bike, or elliptical',
      r: 4,
      rpe: 4,
      status: 'planned',
      modReason: `Pain ${pain}/10 - maintaining fitness`,
    },
    {
      t: 'strength',
      n: 'Rehab Strength',
      d: 'Physio exercises for ' + location,
      r: 3,
      rpe: 3,
      status: 'planned',
      modReason: `Pain ${pain}/10 - rehabilitation exercises`,
    },
    {
      t: 'test_run',
      n: 'Walk/Jog Test',
      d: '5min walk, 2min jog, 5min walk - monitor pain',
      r: 3,
      rpe: 3,
      status: 'planned',
      modReason: `Pain ${pain}/10 - testing readiness`,
    },
  ]);
}
