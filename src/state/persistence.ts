import type { SimulatorState, CrossActivity, RunnerType } from '@/types';
import { STATE_SCHEMA_VERSION, RUNNER_TYPE_SEMANTICS_FIX_VERSION } from '@/types/state';
import { setState, setCrossActivities, getState, getCrossActivities } from './store';
import { ft } from '@/utils/format';
import { clearAllGpsData } from '@/gps/persistence';

const STATE_KEY = 'marathonSimulatorState';
const CROSS_KEY = 'marathonSimulatorCross';

/**
 * Swap Speed↔Endurance for runner type migration.
 * Balanced stays unchanged.
 */
function swapRunnerTypeLabel(type: RunnerType | null | undefined): RunnerType | null {
  if (type === 'Speed') return 'Endurance';
  if (type === 'Endurance') return 'Speed';
  if (type === 'Balanced') return 'Balanced';
  return null;
}

/**
 * Migrate state from older schema versions to current.
 *
 * Version 2: Runner type semantics fix (Speed↔Endurance swap)
 * - Before: b < 1.06 → "Speed", b > 1.12 → "Endurance" (INVERTED)
 * - After: b < 1.06 → "Endurance", b > 1.12 → "Speed" (CORRECT)
 *
 * Persisted runner types need to be swapped to preserve user intent.
 */
function migrateState(loaded: SimulatorState): SimulatorState {
  const currentVersion = loaded.schemaVersion || 1;

  if (currentVersion >= STATE_SCHEMA_VERSION) {
    return loaded; // Already up to date
  }

  console.log(`Migrating state from version ${currentVersion} to ${STATE_SCHEMA_VERSION}`);

  // Migration to version 2: Fix runner type semantics inversion
  if (currentVersion < RUNNER_TYPE_SEMANTICS_FIX_VERSION) {
    console.log('Applying runner type semantics migration (Speed↔Endurance swap)');

    // Swap the main runner type
    if (loaded.typ === 'Speed' || loaded.typ === 'Endurance') {
      const oldType = loaded.typ;
      loaded.typ = swapRunnerTypeLabel(loaded.typ) as RunnerType;
      console.log(`  typ: ${oldType} → ${loaded.typ}`);
    }

    // Swap calculatedRunnerType if present
    if (loaded.calculatedRunnerType) {
      const oldCalc = loaded.calculatedRunnerType;
      loaded.calculatedRunnerType = swapRunnerTypeLabel(loaded.calculatedRunnerType) as RunnerType;
      console.log(`  calculatedRunnerType: ${oldCalc} → ${loaded.calculatedRunnerType}`);
    }

    // Migrate onboarding state if present
    if (loaded.onboarding) {
      if (loaded.onboarding.confirmedRunnerType) {
        const oldConfirmed = loaded.onboarding.confirmedRunnerType;
        loaded.onboarding.confirmedRunnerType = swapRunnerTypeLabel(loaded.onboarding.confirmedRunnerType);
        console.log(`  onboarding.confirmedRunnerType: ${oldConfirmed} → ${loaded.onboarding.confirmedRunnerType}`);
      }
      if (loaded.onboarding.calculatedRunnerType) {
        const oldOnboardCalc = loaded.onboarding.calculatedRunnerType;
        loaded.onboarding.calculatedRunnerType = swapRunnerTypeLabel(loaded.onboarding.calculatedRunnerType);
        console.log(`  onboarding.calculatedRunnerType: ${oldOnboardCalc} → ${loaded.onboarding.calculatedRunnerType}`);
      }
    }
  }

  // Update schema version
  loaded.schemaVersion = STATE_SCHEMA_VERSION;

  return loaded;
}

/**
 * Validate state data for corruption
 * @param loaded - Loaded state object
 * @returns True if data is valid
 */
function validateState(loaded: SimulatorState): boolean {
  // Version check - if data is broken, force reset
  const isBroken =
    (loaded.initialBaseline && loaded.initialBaseline < 300) || // Less than 5 minutes is broken
    (loaded.currentFitness && loaded.currentFitness < 300) ||
    (loaded.initialBaseline && loaded.initialBaseline > 30000) || // More than 8+ hours is broken
    (loaded.forecastTime && loaded.forecastTime < 0) || // Negative is broken
    (loaded.v && (loaded.v < 10 || loaded.v > 90)) || // VDOT out of human range
    (loaded.b && (isNaN(loaded.b) || loaded.b < 0.8 || loaded.b > 1.5)) || // Fatigue exponent out of range
    (loaded.w && loaded.tw && loaded.w > loaded.tw + 1) || // Week beyond plan length
    (loaded.wks && loaded.tw && loaded.wks.length !== loaded.tw); // Week array length mismatch

  if (isBroken) {
    console.log('BROKEN DATA DETECTED - Auto-clearing localStorage');
    console.log(`  initialBaseline: ${loaded.initialBaseline}`);
    console.log(`  currentFitness: ${loaded.currentFitness}`);
    console.log(`  forecastTime: ${loaded.forecastTime}`);
    return false;
  }

  return true;
}

/**
 * Load state from localStorage
 * @returns True if state was loaded successfully
 */
export function loadState(): boolean {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (!saved) return false;

    const loaded = JSON.parse(saved) as SimulatorState;

    if (!validateState(loaded)) {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(CROSS_KEY);
      alert('Detected corrupted data. Please re-initialize your plan.');
      return false;
    }

    // Apply migrations if needed
    const migrated = migrateState(loaded);

    // Save migrated state back to localStorage if version changed
    if (migrated.schemaVersion !== loaded.schemaVersion) {
      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
      console.log('Saved migrated state to localStorage');
    }

    setState(migrated);
    console.log('Loaded saved state from localStorage');
    console.log(`  Initial: ${ft(loaded.initialBaseline || 0)}, Current: ${ft(loaded.currentFitness || 0)}, Forecast: ${ft(loaded.forecastTime || 0)}`);

    // Load cross-training activities
    const savedCross = localStorage.getItem(CROSS_KEY);
    if (savedCross) {
      const activities = JSON.parse(savedCross) as CrossActivity[];
      // Convert date strings back to Date objects
      activities.forEach(a => {
        if (typeof a.date === 'string') {
          a.date = new Date(a.date);
        }
      });
      setCrossActivities(activities);
      console.log(`Loaded ${activities.length} cross-training activities`);
    }

    return true;
  } catch (e) {
    console.error('Error loading state:', e);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(CROSS_KEY);
    alert('Error loading saved data. Please re-initialize your plan.');
    return false;
  }
}

/**
 * Save state to localStorage
 */
export function saveState(): void {
  try {
    const state = getState();
    const crossActivities = getCrossActivities();

    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    localStorage.setItem(CROSS_KEY, JSON.stringify(crossActivities));
  } catch (e) {
    console.error('Error saving state:', e);
  }
}

/**
 * Clear all saved state
 */
export function clearState(): void {
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(CROSS_KEY);
  clearAllGpsData();
}

/**
 * Check if there is saved state
 */
export function hasSavedState(): boolean {
  return localStorage.getItem(STATE_KEY) !== null;
}
