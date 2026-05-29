/**
 * HYROX injury-aware projection mapping.
 *
 * Maps each HYROX station to the body-region load it stresses, then debits
 * that region's injury-recovery build weeks off the station's training
 * horizon. Mirrors the triathlon predictor, which debits per-discipline build
 * weeks (swim / bike / run) via `injuryAdjustedBuildWeeks`. HYROX has no
 * swim/bike; its disciplines are the 8 km run (`run`) and the 8 functional
 * stations (`upperLoad` / `lowerLoad`, already captured by the HYROX injury
 * modal at src/ui/injury/modal.ts:106).
 *
 * **Side of the line**: tracking / prediction. This narrows the race-day
 * projection horizon for disciplines the athlete cannot fully train. It does
 * NOT change today's "race now" prediction (parity with triathlon, which
 * leaves the current-fitness number intact and only reduces projected gain).
 *
 * Station → region classification is anatomical, from HYROX movement patterns:
 *   - upper   pull / push / throw dominated by the upper body and grip
 *   - lower   squat / lunge / drive dominated by the legs
 *   - full    both regions contribute materially; debited by whichever is more
 *             restricted (the worse of the two), since a station is only as
 *             trainable as its most-limited contributor
 *
 * See SCIENCE_LOG "HYROX injury-aware projection".
 */

import type { InjuryState } from '@/types/injury';
import type { HyroxStation } from '@/types/triathlon';
import { injuryAdjustedBuildWeeks } from './injury-recovery';

export type StationLoadRegion = 'upper' | 'lower' | 'full';

/** Body-region load each station stresses. Anatomical, not a tunable. */
export const HYROX_STATION_REGION: Record<HyroxStation, StationLoadRegion> = {
  ski_erg:            'upper',  // double-poling: lats, triceps, core
  sled_push:          'lower',  // horizontal leg drive
  sled_pull:          'full',   // upper-back / arm pull braced on leg drive
  burpee_broad_jumps: 'full',   // whole-body: push-up plus explosive jump
  row_erg:            'full',   // legs drive, back and arms finish
  farmer_carry:       'full',   // grip / upper hold under loaded locomotion
  sandbag_lunges:     'lower',  // loaded lunge, leg-dominant
  wall_balls:         'full',   // squat plus overhead throw
};

/**
 * Effective station training-horizon build weeks after debiting injury
 * recovery for the region(s) the station loads. Returns the full
 * `weeksRemaining` when there is no active injury or no captured resume
 * window, so the no-injury path is unchanged.
 */
export function stationInjuryBuildWeeks(
  inj: InjuryState | undefined,
  station: HyroxStation,
  weeksRemaining: number,
): number {
  const region = HYROX_STATION_REGION[station];
  if (region === 'upper') return injuryAdjustedBuildWeeks(inj, 'upperLoad', weeksRemaining);
  if (region === 'lower') return injuryAdjustedBuildWeeks(inj, 'lowerLoad', weeksRemaining);
  // full: the station is only as trainable as its most-restricted contributor.
  return Math.min(
    injuryAdjustedBuildWeeks(inj, 'upperLoad', weeksRemaining),
    injuryAdjustedBuildWeeks(inj, 'lowerLoad', weeksRemaining),
  );
}
