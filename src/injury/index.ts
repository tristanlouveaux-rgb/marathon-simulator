/**
 * Advanced Intelligent Injury Management System
 *
 * Exports for the injury management module.
 */

export {
  // Module 1: Trend Analysis
  recordPainLevel,
  analyzeTrend,
  applyEmergencyShutdown,
  applyRehabBlock,

  // Module 2: Workout Adaptation
  adaptWorkoutForInjury,

  // Module 3: Test Run Protocol
  createTestRunWorkout,
  evaluateTestRunResult,
  applyTestRunResult,
  requiresTestRun,

  // Module 4: Physio-Grade Phase Management
  getPreviousPhase,
  getNextPhase,
  checkPainLatency,
  applyPhaseRegression,
  applyPhaseProgression,
  canProgressFromAcute,
  hasPassedRequiredCapacityTests,
  recordCapacityTest,
  recordMorningPain,
  evaluatePhaseTransition,
  generateAcutePhaseWorkouts,
  generateRehabPhaseWorkouts,
  generateCapacityTestSession,
  generateReturnToRunWorkouts,

  // Main Orchestrator
  applyAdvancedInjuryLogic,
  applyInjuryAdaptations,

  // Utilities
  isInRecoveryMode,
  getInjuryStatusSummary,
} from './engine';
