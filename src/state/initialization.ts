import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType } from '@/types/training';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  cv, rd, rdKm, calculateFatigueExponent, getRunnerType,
  gp, blendPredictions
} from '@/calculations';
import { calculateForecast } from '@/calculations/predictions';
import { initializeWeeks } from '@/workouts';

export interface CalculationResult {
  success: boolean;
  error?: string;
  runnerType?: RunnerType;
  calculatedRunnerType?: RunnerType;
}

/**
 * Compute effective runner type from physics (PBs → b → calculated) and user override.
 *
 * RULES:
 * - Always compute b from PBs (physics, never fake)
 * - Always compute calculatedRunnerType from b
 * - If confirmedRunnerType exists, use it as effectiveRunnerType (style override)
 * - Otherwise, use calculatedRunnerType
 *
 * @param b - Fatigue exponent from PBs
 * @param confirmedRunnerType - User's confirmed/overridden runner type (or null)
 * @returns { calculatedRunnerType, effectiveRunnerType }
 */
export function computeEffectiveRunnerType(
  b: number,
  confirmedRunnerType: RunnerType | null | undefined
): { calculatedRunnerType: RunnerType; effectiveRunnerType: RunnerType } {
  // Calculate from physics
  const calculatedRunnerType = getRunnerType(b);

  // Use confirmed override if present, otherwise use calculated
  const effectiveRunnerType = confirmedRunnerType ?? calculatedRunnerType;

  return { calculatedRunnerType, effectiveRunnerType };
}

/**
 * Shared initialization logic — populates SimulatorState from OnboardingState.
 * Used by: wizard initializing step, demo button, dashboard re-calc.
 */
export function initializeSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();
    const pbs = state.pbs;

    // Validate PBs
    if (!Object.keys(pbs).length) {
      return { success: false, error: 'No personal bests provided' };
    }

    // Calculate fatigue exponent (physics - always from PBs)
    const b = calculateFatigueExponent(pbs);

    // Compute effective runner type (respects user override if present)
    const { calculatedRunnerType, effectiveRunnerType } = computeEffectiveRunnerType(
      b,
      state.confirmedRunnerType
    );

    // For blendPredictions, we use the effective type (user preference or calculated)
    const runnerType = effectiveRunnerType;

    // Get target race distance
    const targetDistStr = state.raceDistance || 'half';
    const targetDistMeters = rd(targetDistStr);

    // Recent race for blending
    const rec = state.recentRace;

    // LT and VO2 from fitness data step
    const ltPace = state.ltPace || null;
    const vo2max = state.vo2max || null;

    // Calculate blended prediction with all available data
    // Note: blendPredictions uses runnerType.toLowerCase() internally
    const blendedTime = blendPredictions(
      targetDistMeters, pbs, ltPace, vo2max, b,
      runnerType.toLowerCase(), rec
    );

    if (!blendedTime || isNaN(blendedTime) || blendedTime <= 0) {
      return { success: false, error: 'Could not calculate race prediction' };
    }

    // Convert to VDOT
    const curr = cv(targetDistMeters, blendedTime);
    const pac = gp(curr, ltPace);

    // Calculate effective cross-training sessions from recurring activities
    const runsPerWeek = state.runsPerWeek;
    const INTENSITY_FACTOR: Record<string, number> = { easy: 0.5, moderate: 0.7, hard: 0.9 };
    let effectiveCrossSessions = 0;
    if (state.recurringActivities && state.recurringActivities.length > 0) {
      for (const act of state.recurringActivities) {
        const iFactor = INTENSITY_FACTOR[act.intensity] || 0.7;
        effectiveCrossSessions += (act.durationMin / 60) * iFactor * act.frequency;
      }
    } else {
      effectiveCrossSessions = 0.5 * (state.sportsPerWeek || 0);
    }
    if (state.activeLifestyle) effectiveCrossSessions += 0.5;
    const effectiveSessions = runsPerWeek + effectiveCrossSessions;

    // Update state
    s.w = 1;
    s.tw = state.planDurationWeeks;
    s.v = curr;
    s.iv = curr;
    s.rpeAdj = 0;
    s.rd = targetDistStr;
    s.epw = Math.round(effectiveSessions);
    s.rw = runsPerWeek;
    s.gs = state.gymSessionsPerWeek || 0;
    s.wkm = runsPerWeek <= 3 ? runsPerWeek * 10 : runsPerWeek === 4 ? 40 : runsPerWeek === 5 ? 50 : runsPerWeek === 6 ? 60 : 70;
    s.pbs = pbs;
    s.rec = rec;
    s.lt = ltPace;
    s.ltPace = ltPace;
    s.vo2 = vo2max;
    s.typ = effectiveRunnerType;           // Effective type used by engine
    s.calculatedRunnerType = calculatedRunnerType; // Physics-derived type
    s.b = b;
    s.schemaVersion = STATE_SCHEMA_VERSION;
    s.pac = pac;
    s.wks = initializeWeeks(s.tw);
    // Continuous mode: override phases to repeating 4-week blocks
    // Base → Build → Intensify → Deload (evidence-backed mesocycle)
    if (state.trainingForEvent === false) {
      // Map to existing phase types:
      // base = Base week (aerobic foundation)
      // build = Build week (progressive load)
      // peak = Intensify week (peak load/quality)
      // taper = Deload week (recovery + optional test)
      const blockPhases: Array<'base' | 'build' | 'peak' | 'taper'> = ['base', 'build', 'peak', 'taper'];
      for (let i = 0; i < s.wks.length; i++) {
        s.wks[i].ph = blockPhases[i % 4];
      }
    }

    // Long race plans (>16 weeks): block cycling for early weeks,
    // then standard 16-week race-specific phasing for the final stretch
    const RACE_PREP_WEEKS = 16;
    if (state.trainingForEvent !== false && s.tw > RACE_PREP_WEEKS) {
      const racePhaseStart = s.tw - RACE_PREP_WEEKS; // 0-indexed boundary
      s.racePhaseStart = racePhaseStart + 1; // 1-indexed for UI

      // Pre-race weeks: repeating 4-week block cycling
      const blockPhases: Array<'base' | 'build' | 'peak' | 'taper'> = ['base', 'build', 'peak', 'taper'];
      for (let i = 0; i < racePhaseStart; i++) {
        s.wks[i].ph = blockPhases[i % 4];
      }

      // Race-specific weeks: standard 16-week phasing
      // (same algorithm as initializeWeeks but scoped to 16 weeks)
      const taperWeeks = Math.max(1, Math.ceil(RACE_PREP_WEEKS * 0.12)); // ~2 weeks
      const taperStart = RACE_PREP_WEEKS - taperWeeks + 1;
      const pre = taperStart - 1;
      const baseWeeks = Math.max(1, Math.round(pre * 0.45));
      const buildWeeks = Math.max(1, Math.round(pre * 0.40));
      const baseEnd = baseWeeks;
      const buildEnd = baseWeeks + buildWeeks;

      for (let w = 1; w <= RACE_PREP_WEEKS; w++) {
        let ph: 'base' | 'build' | 'peak' | 'taper' = 'base';
        if (w >= taperStart) ph = 'taper';
        else if (w > buildEnd) ph = 'peak';
        else if (w > baseEnd) ph = 'build';
        s.wks[racePhaseStart + w - 1].ph = ph;
      }
    } else if (state.trainingForEvent !== false) {
      s.racePhaseStart = undefined; // ≤16 weeks: no block cycling phase
    }
    s.skip = [];
    s.timp = 0;

    // Store recurring activities
    if (state.recurringActivities && state.recurringActivities.length > 0) {
      s.recurringActivities = [...state.recurringActivities];
    }

    // Commute config
    if (state.runsToWork && state.commuteConfig) {
      s.commuteConfig = state.commuteConfig;
      const commuteKmPerDay = state.commuteConfig.isBidirectional
        ? state.commuteConfig.distanceKm * 2
        : state.commuteConfig.distanceKm;
      s.wkm += commuteKmPerDay * state.commuteConfig.commuteDaysPerWeek;
    } else {
      s.commuteConfig = undefined;
    }

    // Store initial physiology
    s.initialLT = ltPace;
    s.initialVO2 = vo2max;
    s.initialBaseline = blendedTime;
    s.currentFitness = blendedTime;

    // Store heart rate data for HR zone calculations
    if (state.restingHR) s.restingHR = state.restingHR;
    if (state.maxHR) s.maxHR = state.maxHR;

    // Calculate expected final via shared forecast function
    const forecast = calculateForecast(
      curr, runsPerWeek + effectiveCrossSessions, state, runnerType
    );
    s.expectedFinal = forecast.forecastVdot;
    s.forecastTime = forecast.forecastTime;

    // Store selected marathon
    if (state.selectedRace) {
      s.selectedMarathon = state.selectedRace;
    }

    // Store onboarding reference
    s.onboarding = state;

    // Continuous mode for non-event users (trainingForEvent is the authoritative flag)
    if (state.trainingForEvent === false) {
      s.continuousMode = true;
      s.blockNumber = 1;
      s.benchmarkResults = [];
    } else {
      s.continuousMode = false;
    }

    saveState();

    return { success: true, runnerType: effectiveRunnerType, calculatedRunnerType };
  } catch (error) {
    console.error('Initialization error:', error);
    return { success: false, error: 'An unexpected error occurred' };
  }
}
