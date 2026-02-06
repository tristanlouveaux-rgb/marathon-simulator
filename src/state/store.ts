import type { SimulatorState, CrossActivity } from '@/types';
import { STATE_SCHEMA_VERSION } from '@/types/state';

/** Default initial state */
const defaultState: SimulatorState = {
  schemaVersion: STATE_SCHEMA_VERSION,
  w: 1,
  tw: 16,
  v: 50,
  iv: 50,
  rpeAdj: 0,
  rd: 'half',
  epw: 5,
  rw: 5,
  wkm: 50,
  pbs: {},
  rec: null,
  lt: null,
  vo2: null,
  initialLT: null,
  initialVO2: null,
  initialBaseline: null,
  currentFitness: null,
  forecastTime: null,
  typ: 'Balanced',
  calculatedRunnerType: 'Balanced',
  b: 1.06,
  wks: [],
  pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
  skip: [],
  timp: 0,
  expectedFinal: 50
};

/** Main simulator state */
let state: SimulatorState = { ...defaultState };

/** Cross-training activities (persisted separately) */
let crossActivities: CrossActivity[] = [];

/** Track render cycles to prevent duplicate application */
let currentRenderCycle = 0;

/**
 * Get current state (read-only reference)
 */
export function getState(): SimulatorState {
  return state;
}

/**
 * Get mutable state reference
 * Use sparingly - prefer updateState for controlled updates
 */
export function getMutableState(): SimulatorState {
  return state;
}

/**
 * Update state with partial values
 * @param updates - Partial state object
 */
export function updateState(updates: Partial<SimulatorState>): void {
  state = { ...state, ...updates };
}

/**
 * Replace entire state (e.g., from localStorage)
 * @param newState - New state object
 */
export function setState(newState: SimulatorState): void {
  state = newState;
}

/**
 * Reset state to defaults
 */
export function resetState(): void {
  state = JSON.parse(JSON.stringify(defaultState));
  crossActivities = [];
  currentRenderCycle = 0;
}

/**
 * Get cross-training activities
 */
export function getCrossActivities(): CrossActivity[] {
  return crossActivities;
}

/**
 * Set cross-training activities
 */
export function setCrossActivities(activities: CrossActivity[]): void {
  crossActivities = activities;
}

/**
 * Add a cross-training activity
 */
export function addCrossActivity(activity: CrossActivity): void {
  crossActivities.push(activity);
}

/**
 * Get current render cycle
 */
export function getRenderCycle(): number {
  return currentRenderCycle;
}

/**
 * Increment render cycle
 */
export function incrementRenderCycle(): number {
  currentRenderCycle++;
  return currentRenderCycle;
}

/**
 * Reset render cycle
 */
export function resetRenderCycle(): void {
  currentRenderCycle = 0;
}

