/**
 * Cycling-only mode helpers.
 *
 * Cycling V1 reuses the triathlon plan engine + UI shells with
 * `triConfig.disciplines = ['bike']`. These helpers let UI surfaces
 * distinguish cycling mode from true triathlon without scattering
 * `disciplines === ['bike']` checks across the codebase.
 */

import type { SimulatorState } from '@/types/state';

/** True when the user is in single-discipline cycling mode (V1). */
export function isCyclingOnlyMode(state: Pick<SimulatorState, 'triConfig' | 'onboarding'>): boolean {
  if (state.onboarding?.trainingMode === 'cycling') return true;
  const d = state.triConfig?.disciplines;
  return Array.isArray(d) && d.length === 1 && d[0] === 'bike';
}

/**
 * Display label for the cycling event distance (e.g. "160 km"). Returns
 * undefined when not in cycling mode or distance is missing — callers fall
 * back to the existing tri distance label.
 */
export function getCyclingEventLabel(state: Pick<SimulatorState, 'onboarding' | 'triConfig'>): string | undefined {
  if (!isCyclingOnlyMode(state)) return undefined;
  const d = state.onboarding?.cyclingDistance;
  if (!d) return 'Cycling';
  // Distance values are stored as '100km' / '160km' / '200km' — render with a
  // space for typographic consistency with the rest of the app.
  if (d === '50km')  return '50 km';
  if (d === '100km') return '100 km';
  if (d === '160km') return '160 km';
  if (d === '200km') return '200 km';
  if (d === '300km') return '300 km';
  return d;
}
