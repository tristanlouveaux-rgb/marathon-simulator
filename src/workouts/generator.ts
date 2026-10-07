import type { Workout, Week, TrainingPhase, RaceDistance, RunnerType, CommuteConfig, InjuryState, SportKey } from '@/types';
import type { RecurringActivity } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';
import type { Archetype } from '@/calculations/athlete-archetype';
import { WO, LONG_RUN_DISTANCES } from '@/constants';
import { SPORT_LABELS } from '@/constants/sports';
import { calculateWorkoutLoad } from './load';
import { assignDefaultDays } from './scheduler';
import { capitalize } from '@/utils';
import { applyInjuryAdaptations, injuryAppliesToWeek } from '@/injury/engine';
import { injuryStrengthDecision } from './injury-strength';
import { generateOrderedRunSlots, type SlotType } from './rules_engine';
import { planWeekSessions, isRaceWeek, planEngineStateInputs, sharpeningInputsFromState, EASY_FLOOR_MIN, LONG_SOFT_FLOOR_MIN, taperMakeupRoom, type PlanContext, type TaperMakeupRoom } from './plan_engine';
import { liveSharpeningLongRunCapMin } from './sharpening-block';
import { isClosingWeek, planTrainingWeeks, planRaceLayout } from './race-week-layout';
import { applyRaceDayRules, raceDayRulesApply, filterTaperMakeups, fitTaperEasyMakeups } from './race-day-rules';
import { firstTrackedDow } from '@/ui/workout-status';
import { intentToWorkout } from './intent_to_workout';
import { computeAcwrEaseBack } from '@/calculations/acwr-ease-back';
import { getState } from '@/state';
import { swapFractionForState } from '@/calculations/body-mass-adaptations';
import { calculateZones, getWorkoutHRTarget, type HRProfile } from '@/calculations/heart-rate';
import { generateGymWorkouts } from './gym';
import { computePlanPhases, computeRunningPlanPhases } from './phases';

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
  // at the end of this function. No early return here, except the closing week.

  // Closing week: the own week of a Monday to Wednesday race (race-week-layout.ts).
  // It holds only the race, so nothing of any kind is generated. Planned adhoc
  // sessions the user adds are kept by the resolver (week-resolve.ts).
  const sPlan = getState();
  if (weekIndex != null && !sPlan.continuousMode && isClosingWeek(sPlan, weekIndex)) return [];
  // The plan engine's horizon: training weeks, without a closing week.
  const engineTotalWeeks = totalWeeks != null ? planTrainingWeeks({ tw: totalWeeks, wks: sPlan.wks }) : undefined;

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

  // Easy-pace target appended to plain distance runs (legacy path + commutes),
  // mirroring the plan-engine path (intentToWorkout's easyLabel format).
  const easySuffix = easyPaceSecPerKm
    ? ` @ ${Math.floor(easyPaceSecPerKm / 60)}:${String(Math.floor(easyPaceSecPerKm % 60)).padStart(2, '0')}/km`
    : '';

  // Taper weeks of a running race plan: the room carried easy makeups may fill
  // (plan_engine taperMakeupRoom) and the week's prescribed running minutes.
  let taperRoom: TaperMakeupRoom | null = null;
  let prescribedRunMin = 0;

  if (weekIndex != null && totalWeeks != null) {
    // Read archetype + baseline from state. Drives the ramp budget inside
    // planWeekSessions so week 1 starts near the user's current km rather than
    // jumping straight to the ability-driven peak. Falls back to legacy
    // behaviour when state is empty (no Strava history yet).
    const sNow = getState();
    const { baselineKm, archetype } = planEngineStateInputs(sNow);
    // Continuous (endless) mode has no race date, so the legacy `weekIndex`
    // long-run/threshold ramps — which key off `totalWeeks` — give only a shallow
    // climb that the 4-week phase cycle swamps. The result is "ramps in circles":
    // each Base→Build→Peak→Taper block peaks at the same low level (ISSUE: parked
    // continuous-mode bug). To get genuine progressive overload across cycles we
    // engage the geometric volume-budget ramp (`weekVolumeBudgetKm`, slope from the
    // archetype `weeklyRampPct` — Reilly's 10% guideline / Gabbett ACWR safe zone),
    // which climbs toward the readiness-capped peak and then plateaus there. That
    // ramp needs a baseline + archetype; a continuous user who hasn't synced has
    // neither, so fall back to the plan's own starting volume (`s.wkm`, the same
    // freq-derived estimate the prediction uses — not an invented number) and the
    // neutral `'unknown'` archetype (7% ramp). Event plans are unaffected: they
    // keep reading detected values only. (planEngineStateInputs)
    // CTL-gap re-anchor for this week. Stamped on the week at rollover (events.next()); read live
    // here — exactly like baselineKm/archetype — so every resolver call applies the same reduction
    // the debrief previewed. A stored scalar, so reading it here never re-enters the adherence
    // computation (which itself resolves this week's planned TSS).
    const ctlRatio = (sNow.wks?.[weekIndex - 1] as any)?.ctlRatio;

    // New plan engine path: time-based sessions with progression & deload
    const engineCtx: PlanContext = {
      runsPerWeek,
      raceDistance,
      runnerType,
      phase,
      fitnessLevel: fitnessLevel || 'intermediate',
      weekIndex,
      totalWeeks: engineTotalWeeks ?? totalWeeks,
      vdot: vdot || 45,
      effortScore,
      acwrStatus,
      forceDeload,
      weeklyHoursTarget,
      excludedSlots,
      baselineKm,
      archetype,
      easyPaceSecPerKm,
      ctlRatio,
      // Every week's phase, so the engine replays the long runs and week totals it
      // prescribed before this week (10% long-run rule, deload guards). Ignored by
      // the engine unless it covers the whole plan (length === totalWeeks).
      planPhases: sNow.wks?.slice(0, engineTotalWeeks ?? totalWeeks).map(w => w.ph),
      continuousMode: !!sNow.continuousMode,
      // Sharpening block (phases.ts isSharpeningBlock): the start inputs frozen at
      // build, and the live reduce-only long-run cap for weeks already reached.
      sharpening: sharpeningInputsFromState(sNow),
      liveLongRunCapMin: liveSharpeningLongRunCapMin(sNow, weekIndex),
    };
    const intents = planWeekSessions(engineCtx);
    taperRoom = taperMakeupRoom(engineCtx);
    // ACWR ease-back (ISSUE-295). On a high-ACWR week, unless the athlete chose to keep ramping,
    // shed exactly the overshoot via the intensity-first ladder (quality→easy, then easy volume,
    // long-run distance last). Default-until-chosen is eased — 'keep' is the only opt-out. Caution
    // is handled inside planWeekSessions; safe/unknown weeks skip this entirely. The race week
    // (isRaceWeek: the final week of a race plan) is exempt: its single quality session is already
    // a minimal primer (ISSUE-298) and its volume is already cut, so easing it would neuter the
    // primer for no load benefit.
    const wkNow = sNow.wks?.[weekIndex - 1] as Week | undefined;
    const raceWeek = isRaceWeek(weekIndex, engineTotalWeeks ?? totalWeeks, !!sNow.continuousMode);
    const easedIntents = (
      acwrStatus === 'high' &&
      !raceWeek &&
      (wkNow as any)?.acwrChoice !== 'keep' &&
      ((wkNow as any)?.scheduledChronicTSS ?? 0) >= 1 &&
      ((wkNow as any)?.scheduledSafeUpper ?? 0) > 0
    )
      ? computeAcwrEaseBack(intents, {
          chronicWeeklyTSS: (wkNow as any).scheduledChronicTSS,
          safeUpper: (wkNow as any).scheduledSafeUpper,
          easyFloorMin: EASY_FLOOR_MIN,
          longFloorMin: LONG_SOFT_FLOOR_MIN,
        }).intents
      : intents;
    for (const intent of easedIntents) {
      workouts.push(intentToWorkout(intent, raceDistance, runnerType, easyPaceSecPerKm));
    }
    prescribedRunMin = easedIntents.reduce((a, i) => a + i.totalMinutes, 0);
    // A makeup is never longer than the week's own easy runs as committed (the live
    // long-run cap and the ACWR ease-back can shorten them below the taper length).
    const ownEasy = easedIntents.filter(i => i.slot === 'easy').map(i => i.totalMinutes);
    if (taperRoom && ownEasy.length) taperRoom = { ...taperRoom, easyMin: Math.min(taperRoom.easyMin, Math.max(...ownEasy)) };
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
          d: `${Math.round(longDist * adj)}km${easySuffix}`,
          rpe: 3,
          r: 3,
          longRun: true,
        });
      } else if (slot === 'easy') {
        const distance = 6 + easyIdx * 2;
        easyIdx++;
        workouts.push({
          t: 'easy',
          n: `Easy ${easyIdx}`,
          d: `${distance}km${easySuffix}`,
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
            d: `${distance}km${easySuffix}`,
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
      // Tolerate the appended pace target ("7km @ 6:10/km") — the pace suffix
      // is preserved, only the distance shrinks.
      const m = /^(\d+(?:\.\d+)?)km(\s*@.*)?$/.exec(w.d ?? '');
      if (!m) continue;
      const km = parseFloat(m[1]);
      const reduced = Math.max(3, Math.round(km * keep));
      if (reduced < km) {
        w.d = `${reduced}km${m[2] ?? ''}`;
        if (typeof w.estimatedDurationMin === 'number') {
          w.estimatedDurationMin = Math.round(w.estimatedDurationMin * (reduced / km));
        }
      }
    }
  }

  // Add skipped workouts from previous week (prefix name to avoid collisions).
  // A taper week of a running race plan carries no makeup long run or quality
  // session, and race week no makeup at all (race-day-rules.ts rule 5). An easy
  // makeup is carried at the taper week's easy length, only while the week stays
  // at or under its taper ceiling (fitTaperEasyMakeups, taperMakeupRoom).
  const taperWeekOfRace = !sPlan.continuousMode && !sPlan.trackOnly && phase === 'taper'
    && sPlan.eventType !== 'triathlon' && sPlan.eventType !== 'hyrox';
  let carriedSkips = taperWeekOfRace
    ? filterTaperMakeups(previousSkips, {
        raceWeek: weekIndex != null && engineTotalWeeks != null && isRaceWeek(weekIndex, engineTotalWeeks, false),
      })
    : previousSkips;
  if (taperWeekOfRace && taperRoom) {
    const resizeEasy = (w: Workout, minutes: number): Workout => {
      const easy = intentToWorkout(
        { dayIndex: 0, slot: 'easy', totalMinutes: minutes, workMinutes: minutes, variantId: 'easy_steady', notes: '' },
        raceDistance, runnerType, easyPaceSecPerKm,
      );
      return { ...w, t: 'easy', d: easy.d, estimatedDurationMin: minutes };
    };
    carriedSkips = fitTaperEasyMakeups(carriedSkips, prescribedRunMin, taperRoom, resizeEasy);
  }
  for (const skip of carriedSkips) {
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
          d: `${oneWayKm}km${easySuffix}`,
          rpe: 3,
          r: 3,
          commute: true,
        });
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1} (evening)`,
          d: `${oneWayKm}km${easySuffix}`,
          rpe: 3,
          r: 3,
          commute: true,
        });
      } else {
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1}`,
          d: `${oneWayKm}km${easySuffix}`,
          rpe: 3,
          r: 3,
          commute: true,
        });
      }
    }
  }

  // Add gym sessions if configured
  if (gymSessionsPerWeek && gymSessionsPerWeek > 0) {
    // Contrast power-block in build phase is default-on for intermediate+; the
    // user can turn it off in Settings (plyoInGymEnabled === false).
    const gymWorkouts = generateGymWorkouts(
      phase, gymSessionsPerWeek, fitnessLevel || 'intermediate',
      weekIndex, totalWeeks, vdot, injuryState,
      undefined, undefined, undefined, getState().plyoInGymEnabled !== false,
      getState().bodyweightProgress,
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

  // Race-day placement (race-day-rules.ts): nothing on or after race day, the
  // primer 3 to 5 days out, no long run or quality session (except the primer)
  // in the last 6 days, no back-to-back hard days in the last 13. Running race
  // plans with a race date only.
  const raceLayout = weekIndex != null ? planRaceLayout(sPlan) : null;
  if (raceLayout && weekIndex != null) {
    const toEasy = (w: Workout): Workout => {
      const mins = w.estimatedDurationMin ?? 30;
      const easy = intentToWorkout(
        { dayIndex: 0, slot: 'easy', totalMinutes: mins, workMinutes: mins, variantId: 'easy_steady', notes: '' },
        raceDistance, runnerType, easyPaceSecPerKm,
      );
      const loads = calculateWorkoutLoad(easy.t, easy.d, (easy.rpe || easy.r || 3) * 10, easyPaceSecPerKm);
      return { ...easy, n: `Easy Run (was ${w.n})`, aerobic: loads.aerobic, anaerobic: loads.anaerobic, hrTarget: w.hrTarget };
    };
    scheduledWorkouts = applyRaceDayRules(scheduledWorkouts, {
      weekIndex,
      layout: raceLayout,
      firstScheduleDow: firstTrackedDow(sPlan.planStartDate, weekIndex, sPlan.planCreatedAt),
      toEasy,
    });
  }

  // Apply injury adaptations if injury is active — but only to the current and
  // future weeks. A current injury must NEVER rewrite past weeks: doing so turns
  // already-trained sessions into rehab/rest, which orphans their matched actuals
  // and reads as "lost workout logs". The forward-only rule is the shared
  // injuryAppliesToWeek() so this and the tri display can't drift apart.
  const currentWeek = getState().w ?? 1;
  if (injuryState && injuryState.active && injuryAppliesToWeek(weekIndex, currentWeek)) {
    scheduledWorkouts = applyInjuryAdaptations(scheduledWorkouts, injuryState, easyPaceSecPerKm);
    // Acute / no-load phases collapse the week to "Complete Rest", but the
    // relative-rest model keeps the UNAFFECTED region training (Tristan
    // 2026-06-02). When a region-safe strength session is available and the
    // adapted week doesn't already carry one (rehab already does), surface it so
    // the plan AGREES with the injury nudge + on-demand generator, which already
    // offer it. Removes the "Complete Rest" vs "do this strength session"
    // contradiction. The session is region-filtered + submaximal (RPE ≤ 3).
    const decision = injuryStrengthDecision(injuryState);
    const hasStrength = scheduledWorkouts.some(w => w.t === 'gym' || w.t === 'strength');
    if (decision.kind === 'adapted' && !hasStrength) {
      const restCard = scheduledWorkouts.find(w => w.t === 'rest');
      if (restCard) {
        restCard.n = 'Rest the injured area';
        restCard.d = 'Acute phase: rest and protect the injured area (RICE). The unaffected region can still train safely below.';
      }
      scheduledWorkouts.push(decision.workout);
    }
    // Recalculate loads for adapted workouts (descriptions/RPE changed by injury engine)
    for (const w of scheduledWorkouts) {
      const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10, easyPaceSecPerKm);
      w.aerobic = loads.aerobic;
      w.anaerobic = loads.anaerobic;
    }

    // The phase generators (acute/rehab/test/return) REPLACE the scheduled week
    // with workouts that carry no dayOfWeek. Every day-keyed surface then drops
    // them: the Plan tab showed all-Rest, the strain target read 0, and Home
    // showed "Rest Day" while rehab sessions existed but rendered nowhere.
    // Assign the scheduler's spaced training days (Tue/Thu/Sat first — the
    // existing hard-day convention — then Mon/Wed/Fri/Sun) to any workout the
    // injury engine emitted without a day. Adapted-in-place workouts
    // (graduated_return) keep their original days and are untouched.
    const INJURY_DAY_ORDER = [1, 3, 5, 0, 2, 4, 6];
    const usedDays = new Set(scheduledWorkouts.map(w => w.dayOfWeek).filter((d): d is number => d != null));
    let dayCursor = 0;
    for (const w of scheduledWorkouts) {
      if (w.dayOfWeek != null) continue;
      while (dayCursor < INJURY_DAY_ORDER.length && usedDays.has(INJURY_DAY_ORDER[dayCursor])) dayCursor++;
      const day = INJURY_DAY_ORDER[Math.min(dayCursor, INJURY_DAY_ORDER.length - 1)];
      w.dayOfWeek = day;
      usedDays.add(day);
    }
  }

  // Rule 1 again after injury adaptation, which can emit sessions on any day.
  if (raceLayout && weekIndex != null && raceDayRulesApply(weekIndex, raceLayout)) {
    const weekStart = (weekIndex - 1) * 7;
    scheduledWorkouts = scheduledWorkouts.filter(
      w => w.dayOfWeek == null || weekStart + w.dayOfWeek < raceLayout.raceDayIndex,
    );
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

/** Re-exported from plan_engine.ts, where the race-day forecast reads it too. */
export { planEngineStateInputs };

/**
 * Initialize weeks array for a training plan.
 * @param totalWeeks - Total number of weeks
 * @param opts.raceDistance - Running RACE plan: phases from computeRunningPlanPhases
 *   (marathon 2-week taper floor, sharpening-block layout). Omit for continuous
 *   mode and the legacy path, which keep the generic single arc.
 * @param opts.noSignal - No real running fitness signal at build: a sharpening
 *   block gets no peak week (computeRunningPlanPhases).
 * @returns Array of week objects
 */
export function initializeWeeks(
  totalWeeks: number,
  opts: { raceDistance?: RaceDistance; noSignal?: boolean } = {},
): Week[] {
  const planPhases = opts.raceDistance
    ? computeRunningPlanPhases(totalWeeks, opts.raceDistance, { noSignal: opts.noSignal })
    : computePlanPhases(totalWeeks);
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
