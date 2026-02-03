import type { SimulatorState, CrossActivity } from '@/types';
import { setState, setCrossActivities, getState, getCrossActivities } from './store';
import { ft } from '@/utils/format';
import { clearAllGpsData } from '@/gps/persistence';

const STATE_KEY = 'marathonSimulatorState';
const CROSS_KEY = 'marathonSimulatorCross';

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

    setState(loaded);
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
