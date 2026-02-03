// Re-export all cross-training functions
export * from './activities';
export * from './load-matching';
export * from './matcher';
export * from './suggester';

// Universal Load Currency system (new)
// Export types with 'UL' prefix to avoid conflicts with legacy suggester
export type {
  ActivityInput,
  UniversalLoadResult,
  HRZoneData,
  ZonesConfig,
  DataTier,
  PlanEdit,
  AdjustmentAction,
} from './universal-load-types';

// Re-export functions from universal load system
export { computeUniversalLoad, isExtremeSession } from './universalLoad';
export { suggestAdjustments as suggestPlanAdjustments, applyPlanEdits } from './planSuggester';

// Export constants
export {
  ANAEROBIC_WEIGHT as UL_ANAEROBIC_WEIGHT,
  REPLACE_THRESHOLD,
  CONF_REPLACE_MIN,
  EASY_MIN_KM,
  LONG_MIN_KM,
  LONG_MIN_FRAC,
  MIN_PRESERVED_RUNS,
  MAX_MODS_NORMAL,
  MAX_MODS_EXTREME,
  EXTREME_WEEK_PCT,
  TAU,
  CREDIT_MAX,
  RPE_UNCERTAINTY_PENALTY,
  ACTIVE_FRACTION_BY_SPORT,
  getActiveFraction,
  LOAD_PER_MIN_BY_RPE,
  RPE_AEROBIC_SPLIT,
  computeGoalFactor,
} from './universal-load-constants';

// Helper to convert legacy CrossActivity to new ActivityInput format
export { crossActivityToInput } from './universal-load-types';
