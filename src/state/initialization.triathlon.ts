/**
 * Triathlon initialization path.
 *
 * Called from `initializeSimulator` when `state.trainingMode === 'triathlon'`.
 * Keeps triathlon setup off the running-init critical path so that running
 * users are untouched.
 *
 * Phase 1 STATUS: sets up minimal triConfig skeleton + empty plan.
 * Phase 2 will fill in benchmarks from the wizard. Phase 3 populates the
 * week array by calling `generateTriathlonPlan`.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { CalculationResult } from './initialization';
import type { TriConfig } from '@/types/triathlon';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { generateTriathlonPlan, TRI_GENERATOR_VERSION } from '@/workouts/plan_engine.triathlon';
import {
  DEFAULT_VOLUME_SPLIT,
  PLAN_WEEKS_DEFAULT,
  DEFAULT_WEEKLY_PEAK_HOURS,
} from '@/constants/triathlon-constants';

/**
 * Initialize the store for triathlon mode.
 * Mirrors the running initialisation as closely as possible so shared UI
 * (home load bar, readiness, stats) continues to work.
 */
export function initializeTriathlonSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();

    const distance = state.triDistance ?? '70.3';
    const weeks = state.planDurationWeeks || PLAN_WEEKS_DEFAULT[distance];
    const skillRating = state.triSkillRating ?? { swim: 3, bike: 3, run: 3 };

    // Seed time-available from wizard, falling back to skill-based default.
    const avgSkill = Math.round((skillRating.swim + skillRating.bike + skillRating.run) / 3) as 1 | 2 | 3 | 4 | 5;
    const timeAvailable = state.triTimeAvailableHoursPerWeek
      ?? DEFAULT_WEEKLY_PEAK_HOURS[distance][avgSkill];

    const volumeSplit = state.triVolumeSplit ?? { ...DEFAULT_VOLUME_SPLIT };

    const weekdayHours = state.triWeekdayHoursPerWeek ?? Math.round(timeAvailable * 0.4 * 2) / 2;

    const triConfig: TriConfig = {
      distance,
      timeAvailableHoursPerWeek: timeAvailable,
      weekdayHoursPerWeek: weekdayHours,
      volumeSplit,
      skillRating,
      bike: state.triBike ? { ...state.triBike } : {},
      swim: state.triSwim ? { ...state.triSwim } : {},
      raceDate: state.customRaceDate ?? undefined,
      weeksToRace: weeks,
      fitness: {
        swim: { ctl: 0, atl: 0, tsb: 0 },
        bike: { ctl: 0, atl: 0, tsb: 0 },
        run:  { ctl: 0, atl: 0, tsb: 0 },
        combinedCtl: 0,
      },
      generatorVersion: TRI_GENERATOR_VERSION,
    };

    // Plan-level state — keep shape compatible with running state so shared UI
    // consumers don't crash. Race distance is set to 'marathon' as a harmless
    // placeholder; triathlon views ignore it and read triConfig.distance
    // instead. (Using 'marathon' avoids widening the RaceDistance type.)
    s.eventType = 'triathlon';
    s.triConfig = triConfig;
    s.trackOnly = false;
    s.continuousMode = false;
    s.w = 1;
    s.tw = weeks;
    s.rd = 'marathon';  // Placeholder — triathlon views read triConfig.distance
    s.rw = 3;            // Runs per week — refined by plan engine in Phase 3
    s.epw = 9;           // Placeholder total sessions (3 swim + 3 bike + 3 run)
    s.gs = state.gymSessionsPerWeek || 0;
    s.wkm = 0;           // Triathlon uses hours, not km. Shared stats views must be guarded.
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    s.schemaVersion = STATE_SCHEMA_VERSION;

    // Empty plan for Phase 1. Phase 3 replaces this with generateTriathlonPlan.
    s.wks = generateTriathlonPlan(s);

    // Seed prediction caches. Phase 4 computes real values.
    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    saveState();
    return { success: true };
  } catch (err) {
    console.error('[triathlon init] failed', err);
    return { success: false, error: 'Triathlon initialization failed' };
  }
}
