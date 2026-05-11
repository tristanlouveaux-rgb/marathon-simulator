/**
 * Decayed carry of cross-training TSS pushed forward via the tri suggestion
 * modal's "Push to next week" button.
 *
 * Mirrors `computeDecayedCarry` in `src/calculations/fitness-model.ts:726` —
 * 7-day ATL time constant (half-life ~5 days), 3-week lookback. The simpler
 * tri version reads from `wk.carriedCrossTrainingTSS` (a single number) since
 * cross-training stimulus isn't decomposed by zone the way running's
 * `wk.carriedTSS` is (which has base/threshold/intensity columns).
 *
 * Read at detection time by `detectCrossTrainingOverload` so a push from
 * week N still shows up in week N+1's overshoot calculation. Otherwise
 * pushing forward would just hide load from the user.
 *
 * Surfaced visually by the carry banner on the tri home/plan view.
 */

import type { SimulatorState } from '@/types/state';

/** Same time constant as running's `computeDecayedCarry` (ATL_TAU). */
const ATL_TAU = 7;

/** Cap how far back we look. Three weeks is enough for the decay to be
 *  meaningful (week-1: ~37%, week-2: ~14%, week-3: ~5% of original push). */
const MAX_LOOKBACK_WEEKS = 3;

/**
 * Returns the sum of decayed `carriedCrossTrainingTSS` from prior weeks,
 * evaluated at "now". Zero if no plan start date or current week is week 1.
 */
export function computeDecayedTriCarry(
  state: SimulatorState,
  currentWeekIdx: number = state.w ?? 0,
): number {
  const wks = state.wks ?? [];
  if (wks.length === 0 || currentWeekIdx <= 0) return 0;
  const planStartDate = state.planStartDate;
  if (!planStartDate) return 0;

  const nowMs = new Date().setHours(12, 0, 0, 0);
  const planStartMs = new Date(planStartDate).getTime();
  if (!Number.isFinite(planStartMs)) return 0;

  let total = 0;
  const maxLookback = Math.min(MAX_LOOKBACK_WEEKS, currentWeekIdx);
  for (let age = 1; age <= maxLookback; age++) {
    const idx = currentWeekIdx - age;
    const wk = wks[idx];
    if (!wk) continue;
    const carried = wk.carriedCrossTrainingTSS ?? 0;
    if (carried <= 0) continue;
    // Days from midpoint of that week (Wed-ish) to now.
    const weekMidMs = planStartMs + idx * 7 * 86400000 + 3.5 * 86400000;
    const daysElapsed = Math.max(0, (nowMs - weekMidMs) / 86400000);
    const decay = Math.exp(-daysElapsed / ATL_TAU);
    total += carried * decay;
  }
  return total;
}
