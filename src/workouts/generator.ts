import type { Workout, Week, TrainingPhase, RaceDistance, RunnerType, CommuteConfig, InjuryState } from '@/types';
import type { RecurringActivity } from '@/types/onboarding';
import { WO, LONG_RUN_DISTANCES } from '@/constants';
import { calculateWorkoutLoad } from './load';
import { assignDefaultDays } from './scheduler';
import { capitalize } from '@/utils';
import { applyInjuryAdaptations } from '@/injury/engine';
import { generateOrderedRunSlots, type SlotType } from './rules_engine';
import { planWeekSessions } from './plan_engine';
import { intentToWorkout } from './intent_to_workout';
import { calculateZones, getWorkoutHRTarget, type HRProfile } from '@/calculations/heart-rate';

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
  vdot?: number
): Workout[] {
  // Injury handling is fully delegated to applyInjuryAdaptations (phase-aware engine)
  // at the end of this function. No early return here.

  const workouts: Workout[] = [];

  if (weekIndex != null && totalWeeks != null) {
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

  // Add commute runs if configured
  if (commuteConfig?.enabled && commuteConfig.commuteDaysPerWeek > 0) {
    const commuteDistance = commuteConfig.isBidirectional
      ? commuteConfig.distanceKm * 2
      : commuteConfig.distanceKm;
    for (let i = 0; i < commuteConfig.commuteDaysPerWeek; i++) {
      workouts.push({
        t: 'easy',
        n: `Commute ${i + 1}`,
        d: `${commuteDistance}km`,
        rpe: 3,
        r: 3,
        commute: true,
      });
    }
  }

  // Add recurring cross-training activities
  if (recurringActivities && recurringActivities.length > 0) {
    // Preferred cross-training days (avoid Sun=6 for Long Run)
    const crossDaySlots = [2, 4, 1, 3, 5, 0]; // Wed, Fri, Tue, Thu, Sat, Mon
    let slotIdx = 0;

    for (const act of recurringActivities) {
      const INTENSITY_RPE: Record<string, number> = { easy: 3, moderate: 5, hard: 7 };
      const rpe = INTENSITY_RPE[act.intensity] || 5;

      for (let f = 0; f < act.frequency; f++) {
        const day = crossDaySlots[slotIdx % crossDaySlots.length];
        slotIdx++;

        workouts.push({
          t: 'cross',
          n: `${act.sport}${act.frequency > 1 ? ` ${f + 1}` : ''}`,
          d: `${act.durationMin}min ${act.sport.toLowerCase()}`,
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

  // Assign days of week
  let scheduledWorkouts = assignDefaultDays(workouts);

  // Apply injury adaptations if injury is active
  if (injuryState && injuryState.active) {
    scheduledWorkouts = applyInjuryAdaptations(scheduledWorkouts, injuryState);
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
  const weeks: Week[] = [];

  // Phase boundaries: taper = last ~12% (min 1 week), then 45% base, 40% build, rest peak
  const taperWeeks = Math.max(1, Math.ceil(totalWeeks * 0.12));
  const taperStart = totalWeeks - taperWeeks + 1;
  const pre = taperStart - 1;
  const baseWeeks = Math.max(1, Math.round(pre * 0.45));
  const buildWeeks = Math.max(1, Math.round(pre * 0.40));
  const baseEnd = baseWeeks;
  const buildEnd = baseWeeks + buildWeeks;

  for (let w = 1; w <= totalWeeks; w++) {
    let ph: TrainingPhase = 'base';
    if (w >= taperStart) ph = 'taper';
    else if (w > buildEnd) ph = 'peak';
    else if (w > baseEnd) ph = 'build';

    weeks.push({
      w,
      ph,
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0
    });
  }

  return weeks;
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
