import type { SimulatorState } from '@/types/state';
import { resolveWeekWorkouts } from './week-resolve';
import { resolveTriWeekWorkouts, estimateTriWorkoutMin } from './triathlon/week-resolve.triathlon';
import { computePlannedDaySignalBTSS, estimateWorkoutDurMin } from '@/calculations/fitness-model';
import { TL_PER_MIN, plannedTssPerMin } from '@/constants';
import { isHardWorkout } from '@/workouts/scheduler';

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
 *   - HYROX:          resolveTriWeekWorkouts → duration × TL_PER_MIN[rpe]
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
          isHard: isHardPlannedType(w.t ?? ''),
          status: w.status,
        });
      }
    } else {
      // Running: the canonical Plan-tab resolver (generation + adhoc + mods +
      // moves + illness + holiday + bridge). Cross-training sessions are
      // excluded from planned TSS, matching the historical strain computation.
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
          plannedDurationMin: Math.round(estimateWorkoutDurMin(w, baseMinPerKm)),
          isHard: isHardPlannedType(w.t ?? ''),
          status: w.status,
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
