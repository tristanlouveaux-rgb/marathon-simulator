/**
 * HYROX mode detection helper.
 *
 * Side: shared (used by tracking, planning, UI guards). Centralises the
 * `eventType === 'hyrox'` check so callers don't hardcode string comparisons.
 */

import type { SimulatorState } from '@/types/state';

export function isHyroxMode(
  state: Pick<SimulatorState, 'eventType' | 'onboarding'>,
): boolean {
  return state.eventType === 'hyrox' || state.onboarding?.trainingMode === 'hyrox';
}
