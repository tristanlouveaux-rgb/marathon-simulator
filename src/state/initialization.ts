import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType } from '@/types/training';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  cv, rd, rdKm, calculateFatigueExponent, gt,
  gp, blendPredictions
} from '@/calculations';
import { calculateForecast } from '@/calculations/predictions';
import { initializeWeeks } from '@/workouts';

export interface CalculationResult {
  success: boolean;
  error?: string;
  runnerType?: RunnerType;
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

    // Calculate fatigue exponent and runner type
    const b = calculateFatigueExponent(pbs);
    const typ = gt(b);
    const runnerType = (typ.charAt(0).toUpperCase() + typ.slice(1)) as RunnerType;

    // Get target race distance
    const targetDistStr = state.raceDistance || 'half';
    const targetDistMeters = rd(targetDistStr);

    // Recent race for blending
    const rec = state.recentRace;

    // LT and VO2 from fitness data step
    const ltPace = state.ltPace || null;
    const vo2max = state.vo2max || null;

    // Calculate blended prediction with all available data
    const blendedTime = blendPredictions(targetDistMeters, pbs, ltPace, vo2max, b, typ, rec);

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
    s.wkm = runsPerWeek <= 3 ? runsPerWeek * 10 : runsPerWeek === 4 ? 40 : runsPerWeek === 5 ? 50 : runsPerWeek === 6 ? 60 : 70;
    s.pbs = pbs;
    s.rec = rec;
    s.lt = ltPace;
    s.ltPace = ltPace;
    s.vo2 = vo2max;
    s.typ = runnerType;
    s.b = b;
    s.pac = pac;
    s.wks = initializeWeeks(s.tw);
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

    saveState();

    return { success: true, runnerType };
  } catch (error) {
    console.error('Initialization error:', error);
    return { success: false, error: 'An unexpected error occurred' };
  }
}
