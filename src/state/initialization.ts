import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType, RaceDistance } from '@/types/training';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState, getMondayOf } from '@/state/persistence';
import {
  cv, rd, rdKm, calculateFatigueExponent, getRunnerType,
  gp, blendPredictions
} from '@/calculations';
import { calculateForecast } from '@/calculations/predictions';
import { initializeWeeks } from '@/workouts';
import { initializeTriathlonSimulator } from './initialization.triathlon';

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

    // Triathlon fork (§18.1): route to the dedicated triathlon initializer so
    // running-mode setup is untouched.
    if (state.trainingMode === 'triathlon') {
      return initializeTriathlonSimulator(state);
    }

    // Just-Track mode: no plan is generated, but the state scaffolding is the
    // same as any non-event continuous user — a rolling week bucket so that
    // activity sync, GPS recordings, readiness, CTL, and ACWR all work
    // unchanged. The only visible differences are: (1) no prescribed workouts
    // inside each week, (2) views hide prescription UI (today-workout,
    // race-forecast, plan-adherence), (3) `advanceWeekToToday` extends weeks
    // one at a time with no phase cycling.
    if (state.trackOnly) {
      s.trackOnly = true;
      s.continuousMode = true;         // reuse non-event calendar extension path
      s.w = 1;
      s.tw = 1;                        // rolling — advanceWeekToToday extends as calendar moves
      s.wks = [{
        w: 1,
        ph: 'base',                    // harmless label; views hide phase for trackOnly
        rated: {},
        skip: [],
        cross: [],
        wkGain: 0,
        workoutMods: [],
        adjustments: [],
        unspentLoad: 0,
        extraRunLoad: 0,
      }];
      s.skip = [];
      s.timp = 0;
      s.rpeAdj = 0;
      s.schemaVersion = STATE_SCHEMA_VERSION;
      s.planStartDate = getMondayOf(new Date()).toISOString().slice(0, 10);
      s.onboarding = state;

      // Persist whatever the user provided. PBs aren't required for trackOnly —
      // VDOT stays null / unchanged if the user skipped PB entry. Readiness and
      // CTL are driven by synced data, not the wizard, so they bootstrap
      // independently on first sync.
      if (state.pbs && Object.keys(state.pbs).length) {
        s.pbs = state.pbs;
        try {
          const b = calculateFatigueExponent(state.pbs);
          const { calculatedRunnerType, effectiveRunnerType } = computeEffectiveRunnerType(
            b, state.confirmedRunnerType
          );
          s.b = b;
          s.calculatedRunnerType = calculatedRunnerType;
          s.typ = effectiveRunnerType;
        } catch { /* PBs invalid — leave defaults */ }
      }
      if (state.recentRace) s.rec = state.recentRace;
      if (state.ltPace != null) { s.lt = state.ltPace; s.ltPace = state.ltPace; }
      if (state.vo2max != null) s.vo2 = state.vo2max;
      if (state.restingHR) s.restingHR = state.restingHR;
      if (state.maxHR) s.maxHR = state.maxHR;
      if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
      if (state.recurringActivities?.length) s.recurringActivities = [...state.recurringActivities];

      // Seed volume from detected Strava history if available (same rule as
      // the full plan path). Used by stats / weekly summary, not by
      // plan-generation (there is none).
      if (s.stravaHistoryAccepted && s.detectedWeeklyKm != null) {
        s.wkm = Math.round(s.detectedWeeklyKm);
      }

      saveState();
      return { success: true };
    }

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

    // Target distance for workout pacing. For event plans this is the user's
    // picked race. For no-event (continuous) plans the user never picked a
    // distance, so we derive a pacing reference from focus: endurance → half,
    // speed → 5K, balanced → 10K. This value drives MP / HMP zones internally;
    // UI hides it for continuous-mode users (home + plan-preview read
    // s.continuousMode to swap in a focus label instead of a race title).
    const targetDistStr: RaceDistance = state.trainingForEvent === false
      ? (state.trainingFocus === 'speed' ? '5k'
        : state.trainingFocus === 'both' ? '10k'
        : 'half')
      : (state.raceDistance || 'half');
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
    s.trackOnly = false;
    // Clear any stale triathlon fields from a prior triathlon init. Otherwise
    // home/plan-preview pull 'Ironman' titles via s.eventType === 'triathlon'
    // even though the wizard just generated a running plan.
    s.eventType = 'running';
    s.triConfig = undefined;
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
    // Seed blended-fitness cache with wizard-only blend. Backfill will refresh
    // this with Tanda inputs once per-run history lands.
    s.blendedRaceTimeSec = blendedTime;
    s.blendedEffectiveVdot = curr;
    s.blendedLastRefreshedISO = new Date().toISOString();
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

    // Phase C3: if user accepted Strava history and we have a detected weekly km,
    // use it as the plan starting volume (overrides the runs-per-week lookup above).
    // Commute km has already been added — we override the base but keep commute on top.
    if (s.stravaHistoryAccepted && s.detectedWeeklyKm != null) {
      const commuteExtra = s.wkm - (runsPerWeek <= 3 ? runsPerWeek * 10 : runsPerWeek === 4 ? 40 : runsPerWeek === 5 ? 50 : runsPerWeek === 6 ? 60 : 70);
      s.wkm = Math.round(s.detectedWeeklyKm) + Math.max(0, commuteExtra);
    }

    // Store initial physiology
    s.initialLT = ltPace;
    s.initialVO2 = vo2max;
    s.initialBaseline = blendedTime;
    s.currentFitness = blendedTime;

    // Store heart rate data for HR zone calculations
    if (state.restingHR) s.restingHR = state.restingHR;
    if (state.maxHR) s.maxHR = state.maxHR;

    // Store biological sex for iTRIMP β coefficient
    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;

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

    // Anchor all week date ranges to the Monday of the week the plan was created
    s.planStartDate = getMondayOf(new Date()).toISOString().slice(0, 10);

    // Store onboarding reference
    s.onboarding = state;
    // Clear any stale Just-Track flag — this branch builds a real plan.
    s.trackOnly = false;

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
