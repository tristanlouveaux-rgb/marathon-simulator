/**
 * Planned load for a stored tri / cycling session after its prescription
 * changes (an intensity rung step or a type change). PLANNING side: these
 * stamp `aerobic` / `anaerobic` on the stored workout, which the plan header,
 * the Home day target (getPlannedDayTSSContext) and the cross-training
 * overload detector all read. Canonical TSS throughout (Load Currency Law):
 * every rate below is an existing per-kind or per-type planned-TSS helper.
 *
 * Shared by the per-session Adjust overlay (workout-adjust-overlay.ts) and the
 * accepted tri suggestions (calculations/tri-suggestion-apply.ts), so a
 * session priced by either path matches what the generator would stamp.
 */

import { LOAD_PROFILES, plannedTssPerMin } from '@/constants';
import { loadForBike, type BikeSessionKind } from './bike';
import { loadForSwim, type SwimSessionKind } from './swim';

export interface PlannedLoad { aerobic: number; anaerobic: number }

/** Planned aerobic/anaerobic load for an intensity-rung key at a given duration,
 *  using the existing per-kind TSS/min helpers (loadForBike / loadForSwim, the
 *  same source the plan engine uses). Returns null for an unknown key. */
export function loadForRung(key: string, minutes: number): PlannedLoad | null {
  if (key.startsWith('bike_')) return loadForBike(key.slice(5) as BikeSessionKind, minutes);
  if (key.startsWith('swim_')) return loadForSwim(key.slice(5) as SwimSessionKind, minutes);
  return null;
}

/**
 * Aerobic/anaerobic shares the triathlon generator stamps on run legs
 * (generateRunSessionForTri, plan_engine.triathlon.ts: long 0.88/0.12,
 * threshold 0.77/0.23, easy 0.95/0.05, vo2 0.50/0.50 from LOAD_PROFILES.vo2).
 * Copied, not re-derived; rung-load.test.ts pins them against generated
 * sessions so the two cannot drift.
 */
export const TRI_RUN_LOAD_SHARES: Readonly<Record<string, PlannedLoad>> = {
  easy:      { aerobic: 0.95, anaerobic: 0.05 },
  long:      { aerobic: 0.88, anaerobic: 0.12 },
  threshold: { aerobic: 0.77, anaerobic: 0.23 },
  vo2:       { aerobic: 0.50, anaerobic: 0.50 },
};

/**
 * Planned load for a tri run leg of `type` lasting `minutes`: the canonical
 * type-keyed rate (plannedTssPerMin, the same rule the tri generator and
 * running mode's calculateWorkoutLoad use) split with the tri generator's
 * shares for that type. Types the tri generator never writes (marathon_pace,
 * recovery: reachable only by a downgrade) use the running load profile
 * (LOAD_PROFILES), the split running mode stamps on those types. The split
 * keeps the total equal to round(rate x minutes). Null when the type has no
 * share on either table.
 */
export function loadForTriRun(type: string, minutes: number): PlannedLoad | null {
  const share = TRI_RUN_LOAD_SHARES[type] ?? LOAD_PROFILES[type];
  if (!share || !(minutes > 0)) return null;
  const total = Math.round(minutes * plannedTssPerMin(type));
  const aerobic = Math.round(total * share.aerobic);
  return { aerobic, anaerobic: total - aerobic };
}
