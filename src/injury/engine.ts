/**
 * Advanced Intelligent Injury Management Engine
 *
 * This module implements predictive, protocol-specific injury management:
 * - Module 1: Trend analysis (acute spikes, chronic plateaus)
 * - Module 2: Injury-specific workout adaptations
 * - Module 3: Graded exposure test run protocol
 */

import type {
  InjuryState,
  InjuryAdaptedPlan,
  InjuryAdaptation,
  TrendAnalysis,
  TrendType,
  TrendRecommendation,
  PainHistoryEntry,
  RecoveryPhase,
  TestRunWorkout,
  TestRunResult,
  InjuryPhase,
  CapacityTestType,
  CapacityTestResult,
  PhaseTransition,
  SeverityClass,
  GateDecision,
  MorningPainResponse,
} from '@/types/injury';
import type { Workout } from '@/types';
import {
  INJURY_PROTOCOLS,
  INJURY_THRESHOLDS,
  TEST_RUN_PROTOCOL,
  isWorkoutTypeAllowed,
  getReplacementActivity,
  getPriorityActivities,
} from '@/constants/injury-protocols';

// ============================================================================
// MODULE 1: Smarter Data Model & Trends
// ============================================================================

/**
 * Record a new pain level in the injury history
 */
export function recordPainLevel(state: InjuryState, pain: number, date?: string): InjuryState {
  const entry: PainHistoryEntry = {
    date: date || new Date().toISOString(),
    pain: Math.max(0, Math.min(10, pain)),  // Clamp 0-10
  };

  return {
    ...state,
    currentPain: entry.pain,
    history: [...state.history, entry],
  };
}

/**
 * Analyze pain trends to detect acute spikes and chronic plateaus
 */
export function analyzeTrend(state: InjuryState): TrendAnalysis {
  const { history, currentPain } = state;

  // Default analysis for insufficient data
  if (history.length < 2) {
    return {
      trend: 'stable',
      daysSinceTrendStart: 0,
      averagePain: currentPain,
      painDelta24h: 0,
      recommendation: {
        action: 'monitor',
        restDays: 0,
        switchToRehab: false,
        message: 'Insufficient data for trend analysis. Continue monitoring.',
      },
    };
  }

  // Calculate pain delta in last 24 hours
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recentEntries = history.filter(e => new Date(e.date) >= twentyFourHoursAgo);
  const oldestRecentPain = recentEntries.length > 0 ? recentEntries[0].pain : history[history.length - 2]?.pain || 0;
  const painDelta24h = currentPain - oldestRecentPain;

  // Check for ACUTE SPIKE: Pain increased >2 points in 24h
  if (painDelta24h > INJURY_THRESHOLDS.ACUTE_SPIKE_DELTA) {
    return {
      trend: 'acute_spike',
      daysSinceTrendStart: 0,
      averagePain: currentPain,
      painDelta24h,
      recommendation: {
        action: 'emergency_shutdown',
        restDays: 2,  // 48 hours
        switchToRehab: false,
        message: `ALERT: Acute pain spike detected (+${painDelta24h.toFixed(1)} in 24h). Initiating 48-hour emergency rest.`,
      },
    };
  }

  // Check for CHRONIC PLATEAU: Stable pain for >5 days
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const entriesLast5Days = history.filter(e => new Date(e.date) >= fiveDaysAgo);

  if (entriesLast5Days.length >= 3) {
    const avgPain = entriesLast5Days.reduce((sum, e) => sum + e.pain, 0) / entriesLast5Days.length;
    const variance = entriesLast5Days.reduce((sum, e) => sum + Math.abs(e.pain - avgPain), 0) / entriesLast5Days.length;

    // Stable pain (variance < threshold) at moderate level (e.g., 3/10) for 5+ days
    if (variance <= INJURY_THRESHOLDS.CHRONIC_PLATEAU_VARIANCE && avgPain >= 2 && avgPain <= 5) {
      const daysSinceStart = Math.floor((now.getTime() - new Date(entriesLast5Days[0].date).getTime()) / (24 * 60 * 60 * 1000));

      if (daysSinceStart >= INJURY_THRESHOLDS.CHRONIC_PLATEAU_DAYS) {
        return {
          trend: 'chronic_plateau',
          daysSinceTrendStart: daysSinceStart,
          averagePain: avgPain,
          painDelta24h,
          recommendation: {
            action: 'rehab_block',
            restDays: 0,
            switchToRehab: true,
            message: `Pain plateaued at ${avgPain.toFixed(1)}/10 for ${daysSinceStart} days. Switching to rehabilitation block.`,
          },
        };
      }
    }
  }

  // Check for improvement or worsening trends
  const trend = determineTrendDirection(history, currentPain);
  const avgPain = history.slice(-7).reduce((sum, e) => sum + e.pain, 0) / Math.min(7, history.length);
  const daysSinceStart = history.length > 0
    ? Math.floor((now.getTime() - new Date(history[0].date).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    trend,
    daysSinceTrendStart: daysSinceStart,
    averagePain: avgPain,
    painDelta24h,
    recommendation: getRecommendationForTrend(trend, avgPain, currentPain),
  };
}

/**
 * Determine overall trend direction from history
 */
function determineTrendDirection(history: PainHistoryEntry[], currentPain: number): TrendType {
  if (history.length < 3) return 'stable';

  // Compare current to 3-day rolling average
  const recent = history.slice(-3);
  const oldAvg = recent.reduce((sum, e) => sum + e.pain, 0) / recent.length;
  const delta = currentPain - oldAvg;

  if (delta <= INJURY_THRESHOLDS.PAIN_IMPROVING_THRESHOLD) {
    return 'improving';
  } else if (delta >= INJURY_THRESHOLDS.PAIN_WORSENING_THRESHOLD) {
    return 'worsening';
  }
  return 'stable';
}

/**
 * Get recommendation based on trend
 */
function getRecommendationForTrend(trend: TrendType, avgPain: number, currentPain: number): TrendRecommendation {
  switch (trend) {
    case 'improving':
      return {
        action: avgPain <= 2 ? 'progress' : 'continue',
        restDays: 0,
        switchToRehab: false,
        message: currentPain <= 2
          ? 'Pain improving. Consider progression to next recovery phase.'
          : 'Pain improving. Continue current protocol.',
      };

    case 'worsening':
      return {
        action: 'monitor',
        restDays: 1,
        switchToRehab: false,
        message: 'Pain increasing. Reduce training load and monitor closely.',
      };

    case 'stable':
    default:
      return {
        action: 'continue',
        restDays: 0,
        switchToRehab: false,
        message: 'Pain stable. Continue current protocol.',
      };
  }
}

/**
 * Apply emergency shutdown to injury state
 */
export function applyEmergencyShutdown(state: InjuryState): InjuryState {
  const shutdownEnd = new Date();
  shutdownEnd.setHours(shutdownEnd.getHours() + INJURY_THRESHOLDS.EMERGENCY_SHUTDOWN_HOURS);

  return {
    ...state,
    recoveryPhase: 'no_load',
    emergencyShutdownUntil: shutdownEnd.toISOString(),
    context: 'recovery',
  };
}

/**
 * Apply rehab block to injury state
 */
export function applyRehabBlock(state: InjuryState): InjuryState {
  return {
    ...state,
    context: 'rehab',
    rehabBlockStartDate: new Date().toISOString(),
    recoveryPhase: state.recoveryPhase === 'full_training' ? 'phase_2' : state.recoveryPhase,
  };
}

// ============================================================================
// MODULE 2: Injury-Specific Prescriptions
// ============================================================================

/**
 * Estimate workout duration in minutes from a description string.
 * Handles: "10km", "8×800 @ 5K, 90s", "45min", "3×10min", etc.
 */
function estimateWorkoutDurationMin(desc: string | undefined): number {
  if (!desc) return 30;
  // Direct minutes
  const minMatch = desc.match(/(\d+)\s*min/);
  if (minMatch) return parseInt(minMatch[1]);
  // Reps × minutes
  const repMinMatch = desc.match(/(\d+)\s*[×x]\s*(\d+)\s*min/i);
  if (repMinMatch) return parseInt(repMinMatch[1]) * parseInt(repMinMatch[2]);
  // Distance in km — estimate at ~6 min/km
  const kmMatch = desc.match(/(\d+)\s*km/i);
  if (kmMatch) return Math.round(parseInt(kmMatch[1]) * 6);
  // Reps × meters — estimate total distance then apply pace
  const repMMatch = desc.match(/(\d+)\s*[×x]\s*(\d+)\s*m?\b/i);
  if (repMMatch) {
    const reps = parseInt(repMMatch[1]);
    const dist = parseInt(repMMatch[2]);
    if (dist >= 100) return Math.max(20, Math.round((reps * dist / 1000) * 5 * 1.5)); // include recovery
  }
  return 30;
}

/**
 * Adapt a single workout based on injury protocol
 */
export function adaptWorkoutForInjury(workout: Workout, state: InjuryState): InjuryAdaptation {
  const protocol = INJURY_PROTOCOLS[state.type] || INJURY_PROTOCOLS.general;

  // If in emergency shutdown, remove all workouts
  if (state.emergencyShutdownUntil && new Date(state.emergencyShutdownUntil) > new Date()) {
    return {
      originalWorkout: workout,
      adaptedWorkout: null,
      adaptationType: 'removed',
      reason: 'Emergency shutdown active - complete rest required',
    };
  }

  // If in no_load phase, remove all running workouts
  if (state.recoveryPhase === 'no_load') {
    return {
      originalWorkout: workout,
      adaptedWorkout: null,
      adaptationType: 'removed',
      reason: 'No-load recovery phase - running suspended',
    };
  }

  // Check if workout type is banned for this injury
  if (!isWorkoutTypeAllowed(state.type, workout.t)) {
    const replacement = getReplacementActivity(state.type);

    if (replacement) {
      // Replace with priority cross-training activity
      const adaptedWorkout: Workout = {
        ...workout,
        t: 'cross_training',
        n: `Cross-Train: ${replacement}`,
        d: `${estimateWorkoutDurationMin(workout.d)} min`,
        status: 'replaced',
        modReason: `${protocol.displayName}: ${workout.t} not allowed`,
        completedBySport: replacement,
      };

      return {
        originalWorkout: workout,
        adaptedWorkout,
        adaptationType: 'replaced',
        replacementActivity: replacement,
        reason: `${workout.t} banned for ${protocol.displayName}. Replaced with ${replacement}.`,
      };
    } else {
      return {
        originalWorkout: workout,
        adaptedWorkout: null,
        adaptationType: 'removed',
        reason: `${workout.t} banned for ${protocol.displayName}. No safe replacement available.`,
      };
    }
  }

  // If in test_phase, only test runs are allowed
  if (state.recoveryPhase === 'test_phase' && workout.t !== 'test_run') {
    return {
      originalWorkout: workout,
      adaptedWorkout: null,
      adaptationType: 'removed',
      reason: 'Test phase - only diagnostic runs allowed',
    };
  }

  // If in phase_1, reduce intensity
  if (state.recoveryPhase === 'phase_1') {
    const adaptedWorkout: Workout = {
      ...workout,
      rpe: Math.min(workout.rpe || 5, 4),
      r: Math.min(workout.r || 5, 4),
      status: 'reduced',
      modReason: 'Phase 1 recovery - reduced intensity',
    };

    // Reduce distance by 30%
    if (workout.d) {
      const distance = parseInt(workout.d);
      if (!isNaN(distance)) {
        adaptedWorkout.d = `${Math.round(distance * 0.7)}km`;
        adaptedWorkout.originalDistance = workout.d;
      }
    }

    return {
      originalWorkout: workout,
      adaptedWorkout,
      adaptationType: 'modified',
      reason: 'Phase 1 recovery - intensity and volume reduced',
    };
  }

  // Workout is allowed unchanged
  return {
    originalWorkout: workout,
    adaptedWorkout: workout,
    adaptationType: 'unchanged',
    reason: 'Workout compatible with current injury state',
  };
}

// ============================================================================
// MODULE 3: Graded Exposure "Test Run" Protocol
// ============================================================================

/**
 * Create a diagnostic test run workout
 */
export function createTestRunWorkout(): TestRunWorkout {
  return {
    t: 'test_run',
    n: 'Diagnostic Test Run',
    d: `${TEST_RUN_PROTOCOL.totalDurationMinutes}min`,
    r: 3,
    rpe: 3,
    intervals: TEST_RUN_PROTOCOL.intervals,
    completionCriteria: TEST_RUN_PROTOCOL.completionCriteria,
  };
}

/**
 * Evaluate test run result and determine next phase
 */
export function evaluateTestRunResult(
  painDuring: number,
  painAfter: number,
  completed: boolean,
  swellingObserved: boolean,
  gaitNormal: boolean
): TestRunResult {
  const passed =
    completed &&
    painAfter <= TEST_RUN_PROTOCOL.completionCriteria.maxPainAllowed &&
    (TEST_RUN_PROTOCOL.completionCriteria.requiresNoSwelling ? !swellingObserved : true) &&
    (TEST_RUN_PROTOCOL.completionCriteria.requiresNormalGait ? gaitNormal : true);

  const nextPhase: RecoveryPhase = passed ? 'phase_1' : 'no_load';

  return {
    date: new Date().toISOString(),
    painDuring,
    painAfter,
    completed,
    swellingObserved,
    gaitNormal,
    passed,
    nextPhase,
  };
}

/**
 * Update injury state based on test run result
 */
export function applyTestRunResult(state: InjuryState, result: TestRunResult): InjuryState {
  return {
    ...state,
    lastTestRunDate: result.date,
    testRunPainResult: result.painAfter,
    recoveryPhase: result.nextPhase,
    context: result.passed ? 'training' : 'recovery',
    history: [
      ...state.history,
      { date: result.date, pain: result.painAfter },
    ],
    currentPain: result.painAfter,
  };
}

/**
 * Check if a test run should be required
 */
export function requiresTestRun(state: InjuryState): boolean {
  // Required when coming off no_load phase
  if (state.recoveryPhase === 'no_load') {
    // Check if emergency shutdown has ended
    if (state.emergencyShutdownUntil) {
      const shutdownEnd = new Date(state.emergencyShutdownUntil);
      if (new Date() >= shutdownEnd) {
        return true;
      }
    }
  }

  // Required when transitioning from test_phase (to verify readiness)
  if (state.recoveryPhase === 'test_phase' && !state.lastTestRunDate) {
    return true;
  }

  return false;
}

// ============================================================================
// MODULE 4: Physio-Grade Phase Management
// ============================================================================

/** Phase order for progression and regression */
const PHASE_ORDER: InjuryPhase[] = ['acute', 'rehab', 'test_capacity', 'return_to_run', 'resolved'];

/** Minimum hours in acute phase */
const ACUTE_PHASE_MIN_HOURS = 72;

/** Required capacity tests to progress from test_capacity phase */
const REQUIRED_CAPACITY_TESTS: CapacityTestType[] = ['pain_free_walk', 'single_leg_hop'];

/**
 * Get the previous phase (for regression)
 */
export function getPreviousPhase(currentPhase: InjuryPhase): InjuryPhase {
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);
  if (currentIndex <= 0) return 'acute'; // Can't go before acute
  return PHASE_ORDER[currentIndex - 1];
}

/**
 * Get the next phase (for progression)
 */
export function getNextPhase(currentPhase: InjuryPhase): InjuryPhase {
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);
  if (currentIndex >= PHASE_ORDER.length - 1) return 'resolved';
  return PHASE_ORDER[currentIndex + 1];
}

/**
 * Check if pain latency indicates regression is needed
 * Pain latency = pain increased 24h after activity
 */
export function checkPainLatency(state: InjuryState): boolean {
  if (state.morningPainYesterday === null) return false;
  // If current pain is higher than yesterday morning, latency is present
  return state.currentPain > state.morningPainYesterday;
}

/**
 * Apply phase regression due to pain latency
 * Goes back one phase when painLatency is TRUE
 */
export function applyPhaseRegression(state: InjuryState, reason: string): InjuryState {
  const previousPhase = getPreviousPhase(state.injuryPhase);

  const transition: PhaseTransition = {
    fromPhase: state.injuryPhase,
    toPhase: previousPhase,
    date: new Date().toISOString(),
    reason,
    wasRegression: true,
  };

  console.log(`INJURY PHASE REGRESSION: ${state.injuryPhase} -> ${previousPhase} (${reason})`);

  return {
    ...state,
    injuryPhase: previousPhase,
    painLatency: false, // Reset after handling
    phaseTransitions: [...state.phaseTransitions, transition],
    // Reset capacity tests if regressing to before test_capacity
    capacityTestsPassed: previousPhase === 'acute' || previousPhase === 'rehab'
      ? []
      : state.capacityTestsPassed,
  };
}

/**
 * Apply phase progression
 */
export function applyPhaseProgression(state: InjuryState, reason: string): InjuryState {
  const nextPhase = getNextPhase(state.injuryPhase);

  const transition: PhaseTransition = {
    fromPhase: state.injuryPhase,
    toPhase: nextPhase,
    date: new Date().toISOString(),
    reason,
    wasRegression: false,
  };

  console.log(`INJURY PHASE PROGRESSION: ${state.injuryPhase} -> ${nextPhase} (${reason})`);

  return {
    ...state,
    injuryPhase: nextPhase,
    active: nextPhase !== 'resolved', // Deactivate if fully resolved
    phaseTransitions: [...state.phaseTransitions, transition],
    // Clear acute phase start when leaving acute
    acutePhaseStartDate: nextPhase !== 'acute' ? null : state.acutePhaseStartDate,
  };
}

/**
 * Check if acute phase minimum time (72h) has passed
 */
export function canProgressFromAcute(state: InjuryState): boolean {
  if (state.injuryPhase !== 'acute') return false;
  if (!state.acutePhaseStartDate) return false;

  const startDate = new Date(state.acutePhaseStartDate);
  const now = new Date();
  const hoursPassed = (now.getTime() - startDate.getTime()) / (1000 * 60 * 60);

  return hoursPassed >= ACUTE_PHASE_MIN_HOURS && state.currentPain <= 3;
}

/**
 * Check if all required capacity tests are passed
 */
export function hasPassedRequiredCapacityTests(state: InjuryState): boolean {
  return REQUIRED_CAPACITY_TESTS.every(test =>
    state.capacityTestsPassed.includes(test)
  );
}

/**
 * Record a capacity test result
 */
export function recordCapacityTest(
  state: InjuryState,
  testType: CapacityTestType,
  painDuring: number,
  painAfter: number,
  notes: string = ''
): InjuryState {
  const passed = painDuring <= 2 && painAfter <= 2;

  const result: CapacityTestResult = {
    testType,
    date: new Date().toISOString(),
    passed,
    painDuring,
    painAfter,
    notes,
  };

  let newState: InjuryState = {
    ...state,
    capacityTestHistory: [...state.capacityTestHistory, result],
  };

  if (passed && !state.capacityTestsPassed.includes(testType)) {
    newState.capacityTestsPassed = [...state.capacityTestsPassed, testType];
    console.log(`CAPACITY TEST PASSED: ${testType}`);
  } else if (!passed) {
    // Failed test may trigger regression
    console.log(`CAPACITY TEST FAILED: ${testType} (pain: ${painDuring}/${painAfter})`);
    if (painAfter >= 4) {
      newState = applyPhaseRegression(newState, `Failed capacity test (${testType}) with pain ${painAfter}/10`);
    }
  }

  return newState;
}

/**
 * Update morning pain for latency tracking
 */
export function recordMorningPain(state: InjuryState, pain: number): InjuryState {
  return {
    ...state,
    morningPainYesterday: state.currentPain, // Yesterday's becomes previous
    currentPain: pain,
    history: [...state.history, { date: new Date().toISOString(), pain }],
  };
}

/**
 * Evaluate and apply phase transitions based on current state
 */
export function evaluatePhaseTransition(state: InjuryState): InjuryState {
  let newState = { ...state };

  // Check for regression due to pain latency
  if (state.painLatency && state.injuryPhase !== 'acute') {
    return applyPhaseRegression(newState, 'Pain latency detected (pain worse 24h post-activity)');
  }

  // Check phase-specific progression criteria
  switch (state.injuryPhase) {
    case 'acute':
      if (canProgressFromAcute(state)) {
        return applyPhaseProgression(newState, '72h rest complete, pain ≤3/10');
      }
      break;

    case 'rehab':
      // Can progress if pain consistently ≤2 for 3+ days
      if (state.currentPain <= 2 && state.history.length >= 3) {
        const last3Days = state.history.slice(-3);
        const allLowPain = last3Days.every(h => h.pain <= 2);
        if (allLowPain) {
          return applyPhaseProgression(newState, 'Consistent low pain (≤2/10) for 3+ days');
        }
      }
      break;

    case 'test_capacity':
      if (hasPassedRequiredCapacityTests(state)) {
        return applyPhaseProgression(newState, 'All required capacity tests passed');
      }
      break;

    case 'return_to_run':
      // Response-gated: only resolve when returnToRunLevel > 8 (set by gate function)
      // No automatic time-based progression — weekly gate controls advancement
      if ((state.returnToRunLevel || 1) > 8) {
        return applyPhaseProgression(newState, 'Completed return-to-run protocol (Level 8)');
      }
      break;

    case 'resolved':
      // Check if injury has reactivated
      if (state.active && state.currentPain >= 4) {
        newState.injuryPhase = 'acute';
        newState.acutePhaseStartDate = new Date().toISOString();
        newState.capacityTestsPassed = [];
        console.log('INJURY REACTIVATED: Returning to acute phase');
      }
      break;
  }

  return newState;
}

/**
 * Generate workouts for acute phase (complete rest)
 */
export function generateAcutePhaseWorkouts(): Workout[] {
  return [{
    t: 'rest',
    n: 'Complete Rest - Acute Phase',
    d: 'No physical activity. Focus on RICE protocol.',
    r: 1,
    rpe: 1,
    status: 'planned',
    modReason: 'Acute injury phase - 72h minimum rest required',
  }];
}

/**
 * Generate workouts for rehab phase (cross-train + rehab strength)
 */
export function generateRehabPhaseWorkouts(): Workout[] {
  return [
    {
      t: 'cross',
      n: 'Rehab Cross-Training',
      d: '20-30 min low-impact (pool, cycling)',
      r: 3,
      rpe: 3,
      status: 'planned',
      modReason: 'Rehab phase - maintain fitness without impact',
    },
    {
      t: 'strength',
      n: 'Rehab Strength Session',
      d: 'Targeted strength exercises (physio-prescribed if available)',
      r: 2,
      rpe: 2,
      status: 'planned',
      modReason: 'Rehab phase - strengthen affected area',
    },
  ];
}

/**
 * Generate capacity test session for test_capacity phase
 */
export function generateCapacityTestSession(state: InjuryState): Workout[] {
  const remainingTests = REQUIRED_CAPACITY_TESTS.filter(
    test => !state.capacityTestsPassed.includes(test)
  );

  const testNames: Record<CapacityTestType, string> = {
    single_leg_hop: 'Single Leg Hop Test',
    pain_free_walk: '30-Minute Walk Test',
    isometric_hold: 'Isometric Hold Test',
    stair_test: 'Stair Test',
    squat_test: 'Squat Test',
  };

  const testDescriptions: Record<CapacityTestType, string> = {
    single_leg_hop: '10x single leg hops on affected side (pain-free)',
    pain_free_walk: '30 minutes continuous walking (pain-free)',
    isometric_hold: '30-second isometric contraction (pain-free)',
    stair_test: '2 flights up/down stairs (pain-free)',
    squat_test: '10x bodyweight squats (pain-free)',
  };

  return remainingTests.map(testType => ({
    t: 'capacity_test',
    n: testNames[testType],
    d: testDescriptions[testType],
    r: 3,
    rpe: 3,
    status: 'planned',
    testType,
    modReason: 'Physio-grade capacity test',
  }));
}

/**
 * 8-level return-to-run protocol definitions
 */
const RETURN_TO_RUN_LEVELS = [
  { level: 1, walk: 4, run: 1, sets: 5, label: 'Walk-dominant' },
  { level: 2, walk: 3, run: 2, sets: 5, label: 'Increasing run' },
  { level: 3, walk: 2, run: 3, sets: 5, label: 'Run-dominant' },
  { level: 4, walk: 1, run: 4, sets: 5, label: 'Minimal walks' },
  { level: 5, walk: 1, run: 5, sets: 4, label: 'Extended runs' },
  { level: 6, walk: 0, run: 10, sets: 2, label: 'Continuous short' },
  { level: 7, walk: 0, run: 15, sets: 2, label: 'Moderate continuous' },
  { level: 8, walk: 0, run: 0, sets: 0, label: 'Bridge to full training' }, // Easy runs
];

/**
 * Get the display label for a return-to-run level
 */
export function getReturnToRunLevelLabel(level: number): string {
  const proto = RETURN_TO_RUN_LEVELS[Math.min(level - 1, RETURN_TO_RUN_LEVELS.length - 1)];
  return `Level ${level} of 8 — ${proto.label}`;
}

/**
 * Classify injury severity from peak pain history
 */
export function classifySeverity(state: InjuryState): SeverityClass {
  const peakPain = state.history.length > 0
    ? Math.max(...state.history.map(h => h.pain))
    : state.currentPain;

  if (peakPain <= 3) return 'niggle';
  if (peakPain <= 5) return 'moderate';
  return 'severe';
}

/**
 * Evaluate the weekly return-to-run gate decision.
 * Uses trend analysis, morning pain responses, current pain, and pain latency.
 */
export function evaluateReturnToRunGate(state: InjuryState): GateDecision {
  const trend = analyzeTrend(state);
  const currentPain = state.currentPain;
  const mornings = state.morningPainResponses || [];
  const hasWorseMorning = mornings.some(m => m.response === 'worse');
  const isSpike = trend.trend === 'acute_spike';
  const isWorsening = trend.trend === 'worsening';
  const severity = classifySeverity(state);
  const currentLevel = state.returnToRunLevel || 1;

  // REGRESS: pain >= 5 OR acute spike
  if (currentPain >= 5 || isSpike) {
    const newLevel = Math.max(1, currentLevel - 1);
    return {
      decision: 'regress',
      reason: isSpike
        ? 'Acute pain spike detected — stepping back for safety'
        : `Pain level ${currentPain}/10 is too high to continue at this level`,
      newLevel,
    };
  }

  // HOLD: pain 3-4, OR worse morning, OR pain latency, OR worsening trend
  if (currentPain >= 3 || hasWorseMorning || state.painLatency || isWorsening) {
    const reasons: string[] = [];
    if (currentPain >= 3) reasons.push(`pain ${currentPain}/10`);
    if (hasWorseMorning) reasons.push('worse morning pain this week');
    if (state.painLatency) reasons.push('pain latency detected');
    if (isWorsening) reasons.push('worsening trend');

    return {
      decision: 'hold',
      reason: reasons.join(', '),
      newLevel: currentLevel,
    };
  }

  // PROGRESS: pain <= 2, no worse mornings, no spike, not worsening
  // But severity scaling applies:
  if (severity === 'severe' && (state.holdCount || 0) < 1) {
    return {
      decision: 'hold',
      reason: 'Severe injury requires two consecutive good weeks before advancing',
      newLevel: currentLevel,
    };
  }

  // Calculate new level based on severity
  let advance = 1;
  if (severity === 'niggle') advance = 2; // Skip a level

  const newLevel = Math.min(currentLevel + advance, 9); // 9 = past level 8 → resolved

  return {
    decision: 'progress',
    reason: severity === 'niggle'
      ? 'Low severity — skipping ahead'
      : 'Pain low, recovery on track',
    newLevel,
  };
}

/**
 * Apply a gate decision to the injury state.
 * Updates level, holdCount, clears morning pain responses.
 * If level > 8: triggers phase progression to resolved.
 * If regress at level 1: triggers phase regression to test_capacity.
 */
export function applyGateDecision(state: InjuryState, decision: GateDecision): InjuryState {
  let newState: InjuryState = {
    ...state,
    morningPainResponses: [], // Clear for next week
    severityClass: classifySeverity(state),
  };

  if (decision.decision === 'progress') {
    newState.holdCount = 0;
    if (decision.newLevel > 8) {
      // Graduated! Move to resolved
      return applyPhaseProgression(newState, 'Completed return-to-run protocol (Level 8)');
    }
    newState.returnToRunLevel = decision.newLevel;
  } else if (decision.decision === 'hold') {
    newState.holdCount = (newState.holdCount || 0) + 1;
    newState.returnToRunLevel = decision.newLevel;
  } else {
    // Regress
    newState.holdCount = 0;
    if (decision.newLevel < 1) {
      // Regress back to test_capacity
      return applyPhaseRegression(newState, 'Regressed from return-to-run level 1');
    }
    newState.returnToRunLevel = decision.newLevel;
  }

  return newState;
}

/**
 * Generate return-to-run workouts (walk/run intervals + cross-training)
 */
export function generateReturnToRunWorkouts(level: number = 1, injuryState?: InjuryState): Workout[] {
  const clampedLevel = Math.max(1, Math.min(level, 8));
  const proto = RETURN_TO_RUN_LEVELS[clampedLevel - 1];
  const workouts: Workout[] = [];

  if (clampedLevel === 8) {
    // Bridge to full training: 2 easy runs ~3-4km
    workouts.push({
      t: 'return_run',
      n: 'Easy Run (Return)',
      d: '3km easy pace',
      r: 4,
      rpe: 4,
      status: 'planned',
      modReason: `Return Level ${clampedLevel}/8 — ${proto.label}`,
    });
    workouts.push({
      t: 'return_run',
      n: 'Easy Run 2 (Return)',
      d: '4km easy pace',
      r: 4,
      rpe: 4,
      status: 'planned',
      modReason: `Return Level ${clampedLevel}/8 — ${proto.label}`,
    });
  } else if (clampedLevel >= 6) {
    // Levels 6-7: continuous runs
    workouts.push({
      t: 'return_run',
      n: 'Return-to-Run Intervals',
      d: `${proto.sets}x ${proto.run}min continuous run`,
      r: 4,
      rpe: 4,
      status: 'planned',
      modReason: `Return Level ${clampedLevel}/8 — ${proto.label}`,
    });
  } else {
    // Levels 1-5: walk/run intervals
    workouts.push({
      t: 'return_run',
      n: 'Return-to-Run Intervals',
      d: `${proto.sets}x (${proto.walk}min walk / ${proto.run}min run)`,
      r: 4,
      rpe: 4,
      status: 'planned',
      modReason: `Return Level ${clampedLevel}/8 — ${proto.label}`,
    });
  }

  // Add cross-training workouts using injury-specific priority activities
  if (injuryState) {
    const priorities = getPriorityActivities(injuryState.type);
    const activityName = priorities.length > 0
      ? priorities[0].charAt(0).toUpperCase() + priorities[0].slice(1).replace(/_/g, ' ')
      : 'Low-impact activity';
    const crossSessions = clampedLevel <= 4 ? 2 : 1;
    const crossDuration = clampedLevel <= 4 ? 30 : 25;

    for (let i = 0; i < crossSessions; i++) {
      workouts.push({
        t: 'cross',
        n: `Cross-Train: ${activityName}${crossSessions > 1 ? ` ${i + 1}` : ''}`,
        d: `${crossDuration}min ${activityName.toLowerCase()}`,
        r: 3,
        rpe: 3,
        status: 'planned',
        modReason: `Return Level ${clampedLevel}/8 — injury-specific cross-training`,
      });
    }
  }

  return workouts;
}

// ============================================================================
// MAIN ORCHESTRATOR: applyAdvancedInjuryLogic
// ============================================================================

/**
 * Apply advanced injury management logic to a weekly training plan
 *
 * This is the main entry point that orchestrates all three modules:
 * 1. Analyzes pain trends and applies emergency protocols
 * 2. Adapts each workout based on injury-specific protocols
 * 3. Injects test runs when required for graded return
 *
 * @param workouts - Array of planned workouts for the week
 * @param injuryState - Current injury state with history
 * @returns Adapted plan with modifications and recommendations
 */
export function applyAdvancedInjuryLogic(
  workouts: Workout[],
  injuryState: InjuryState
): InjuryAdaptedPlan {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  let currentState = { ...injuryState };

  // ---- MODULE 1: Trend Analysis ----
  const trendAnalysis = analyzeTrend(currentState);

  // Apply emergency protocols based on trend
  if (trendAnalysis.trend === 'acute_spike') {
    currentState = applyEmergencyShutdown(currentState);
    warnings.push(trendAnalysis.recommendation.message);
  } else if (trendAnalysis.trend === 'chronic_plateau' && trendAnalysis.recommendation.switchToRehab) {
    currentState = applyRehabBlock(currentState);
    warnings.push(trendAnalysis.recommendation.message);
    recommendations.push('Focus on rehabilitation exercises. Consider consulting a physiotherapist.');
  }

  // ---- MODULE 3: Test Run Check (before workout adaptation) ----
  const needsTestRun = requiresTestRun(currentState);

  if (needsTestRun) {
    // Transition to test phase
    currentState = {
      ...currentState,
      recoveryPhase: 'test_phase',
    };
    recommendations.push('Test run required before resuming training. Complete diagnostic run and report pain levels.');
  }

  // ---- MODULE 2: Adapt Each Workout ----
  const adaptations: InjuryAdaptation[] = [];
  const adaptedWorkouts: Workout[] = [];

  // If test run is required, inject it as the first workout
  if (needsTestRun && currentState.recoveryPhase === 'test_phase') {
    const testRun = createTestRunWorkout();
    adaptedWorkouts.push(testRun);
    adaptations.push({
      originalWorkout: testRun,
      adaptedWorkout: testRun,
      adaptationType: 'unchanged',
      reason: 'Diagnostic test run required before returning to training',
    });
  }

  // Process each planned workout
  for (const workout of workouts) {
    const adaptation = adaptWorkoutForInjury(workout, currentState);
    adaptations.push(adaptation);

    if (adaptation.adaptedWorkout) {
      adaptedWorkouts.push(adaptation.adaptedWorkout);
    }
  }

  // Generate additional recommendations
  if (currentState.active && currentState.type !== 'general') {
    const protocol = INJURY_PROTOCOLS[currentState.type];
    if (protocol) {
      recommendations.push(protocol.recoveryNotes);

      const priorities = getPriorityActivities(currentState.type);
      if (priorities.length > 0) {
        recommendations.push(`Recommended cross-training: ${priorities.join(', ')}`);
      }
    }
  }

  // Track workout removals
  const removedCount = adaptations.filter(a => a.adaptationType === 'removed').length;
  if (removedCount > 0) {
    warnings.push(`${removedCount} workout(s) removed due to injury protocol.`);
  }

  const replacedCount = adaptations.filter(a => a.adaptationType === 'replaced').length;
  if (replacedCount > 0) {
    warnings.push(`${replacedCount} workout(s) replaced with cross-training.`);
  }

  return {
    workouts: adaptedWorkouts,
    adaptations,
    injuryState: currentState,
    trendAnalysis,
    warnings,
    recommendations,
  };
}

/**
 * Simple wrapper that applies injury adaptations and returns just the workouts array.
 * Used by the workout generator for seamless integration.
 *
 * NOW USES PHYSIO-GRADE PHASE SYSTEM
 *
 * @param workouts - Array of planned workouts
 * @param injuryState - Current injury state
 * @returns Adapted workouts array
 */
export function applyInjuryAdaptations(workouts: Workout[], injuryState: InjuryState): Workout[] {
  // Sync recoveryPhase from injuryPhase to prevent dual-system contradictions
  const PHASE_TO_RECOVERY: Record<InjuryPhase, RecoveryPhase> = {
    acute: 'no_load',
    rehab: 'phase_1',
    test_capacity: 'test_phase',
    return_to_run: 'phase_2',
    resolved: 'full_training',
  };
  const synced: InjuryState = {
    ...injuryState,
    recoveryPhase: PHASE_TO_RECOVERY[injuryState.injuryPhase] || injuryState.recoveryPhase,
  };

  // First, evaluate if phase transition is needed
  const evaluatedState = evaluatePhaseTransition(synced);

  // Handle phase-specific workout generation
  switch (evaluatedState.injuryPhase) {
    case 'acute':
      // Phase 1: Complete rest - 72h minimum
      return generateAcutePhaseWorkouts();

    case 'rehab':
      // Phase 2: Cross-training + rehab strength
      return generateRehabPhaseWorkouts();

    case 'test_capacity':
      // Phase 3: Capacity test sessions
      return generateCapacityTestSession(evaluatedState);

    case 'return_to_run':
      // Phase 4: Response-gated walk/run intervals using level system
      return generateReturnToRunWorkouts(evaluatedState.returnToRunLevel || 1, evaluatedState);

    case 'resolved':
      // Fully recovered - use normal workouts but check for high pain
      if (evaluatedState.currentPain >= 7) {
        return workouts.map(workout => ({
          ...workout,
          t: 'rest',
          n: `Rest (was: ${workout.n})`,
          d: 'Complete rest due to high pain',
          rpe: 1,
          r: 1,
          status: 'replaced' as const,
          modReason: `Pain level ${evaluatedState.currentPain}/10 - rest recommended`,
        }));
      }

      if (evaluatedState.currentPain >= 5) {
        return workouts.map(workout => {
          if (['vo2', 'intervals', 'threshold', 'race_pace', 'hill_repeats'].includes(workout.t)) {
            return {
              ...workout,
              t: 'cross',
              n: `Cross-Train (was: ${workout.n})`,
              d: 'Low-impact activity recommended',
              rpe: 3,
              r: 3,
              status: 'replaced' as const,
              modReason: `Pain level ${evaluatedState.currentPain}/10 - cross-training recommended`,
            };
          }
          return {
            ...workout,
            rpe: Math.min(workout.rpe || 5, 3),
            r: Math.min(workout.r || 5, 3),
            status: 'reduced' as const,
            modReason: `Pain level ${evaluatedState.currentPain}/10 - reduced intensity`,
          };
        });
      }

      // Normal workouts with full advanced logic
      const result = applyAdvancedInjuryLogic(workouts, evaluatedState);
      return result.workouts;

    default:
      return applyAdvancedInjuryLogic(workouts, evaluatedState).workouts;
  }
}

/**
 * Check if injury state is in an active recovery mode
 */
export function isInRecoveryMode(state: InjuryState): boolean {
  return (
    state.active &&
    (state.recoveryPhase !== 'full_training' ||
      state.context !== 'training' ||
      (state.emergencyShutdownUntil !== null && new Date(state.emergencyShutdownUntil) > new Date()))
  );
}

/**
 * Get a human-readable status summary
 */
export function getInjuryStatusSummary(state: InjuryState): string {
  if (!state.active) {
    return 'No active injury';
  }

  const protocol = INJURY_PROTOCOLS[state.type];
  const injuryName = protocol?.displayName || state.type;

  if (state.emergencyShutdownUntil && new Date(state.emergencyShutdownUntil) > new Date()) {
    const hoursRemaining = Math.ceil(
      (new Date(state.emergencyShutdownUntil).getTime() - Date.now()) / (1000 * 60 * 60)
    );
    return `${injuryName}: Emergency rest (${hoursRemaining}h remaining)`;
  }

  switch (state.recoveryPhase) {
    case 'no_load':
      return `${injuryName}: Complete rest phase`;
    case 'test_phase':
      return `${injuryName}: Awaiting diagnostic test run`;
    case 'phase_1':
      return `${injuryName}: Phase 1 - Limited training`;
    case 'phase_2':
      return `${injuryName}: Phase 2 - Moderate training`;
    case 'full_training':
      return `${injuryName}: Monitoring (Pain: ${state.currentPain}/10)`;
    default:
      return `${injuryName}: ${state.context}`;
  }
}
