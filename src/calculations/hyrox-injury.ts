/**
 * HYROX injury-aware projection mapping.
 *
 * Maps each HYROX station to the body-region load it stresses, then debits
 * that region's injury-recovery build weeks off the station's training
 * horizon. Mirrors the triathlon predictor, which debits per-discipline build
 * weeks (swim / bike / run) via `injuryAdjustedBuildWeeks`. HYROX has no
 * swim/bike; its disciplines are the 8 km run (`run`) and the 8 functional
 * stations (`upperLoad` / `lowerLoad`, already captured by the HYROX injury
 * modal at src/ui/injury/modal.ts:118).
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
import { getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';

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
 * Estimated weeks until a restricted discipline returns to full when the
 * athlete did not enter an explicit window. Uses the injury protocol's
 * typical-recovery midpoint — the SAME clinical-judgement band the injury
 * modal uses to pre-fill the resume field (`modal.ts:getModalHTML`,
 * `recoveryMid`). No new constant: it reads `INJURY_PROTOCOLS`.
 */
function fallbackResumeWeeks(inj: InjuryState): number {
  const rw = (INJURY_PROTOCOLS[inj.type] ?? INJURY_PROTOCOLS.general)?.typicalRecoveryWeeks;
  return rw ? Math.round((rw.min + rw.max) / 2) : 0;
}

/**
 * Return a copy of the injury with resume windows filled in for any restricted
 * discipline (`run` / `upperLoad` / `lowerLoad`) that lacks an explicit one.
 *
 * Why this matters: the build-week debit is `resumeWeeks × (1 − capacity/100)`,
 * so without a captured window a blocked discipline costs zero — the forecast
 * would show full projected gain for a sport the athlete cannot train. The
 * modal pre-fills the window, but legacy injuries (or any flow that set a
 * capacity slider without the resume field) can lack it. Falling back to the
 * protocol's typical-recovery window keeps the forecast honest. Returns the
 * input untouched when there is no active injury or nothing to fill.
 */
export function injuryWithResumeFallback(inj: InjuryState | undefined): InjuryState | undefined {
  if (!inj?.active) return inj;
  const fb = fallbackResumeWeeks(inj);
  if (fb <= 0) return inj;
  const discs: DisciplineKey[] = ['run', 'upperLoad', 'lowerLoad'];
  const filled = { ...(inj.resumeWeeksByDiscipline ?? {}) };
  let changed = false;
  for (const d of discs) {
    if (getDisciplineCapacity(inj, d) < 100 && filled[d] == null) {
      filled[d] = fb;
      changed = true;
    }
  }
  return changed ? { ...inj, resumeWeeksByDiscipline: filled } : inj;
}

/**
 * Effective run-portion training-horizon build weeks after debiting injury
 * recovery for the `run` discipline (with protocol-window fallback). Returns
 * the full `weeksRemaining` when there is no active injury.
 */
export function runInjuryBuildWeeks(
  inj: InjuryState | undefined,
  weeksRemaining: number,
): number {
  return injuryAdjustedBuildWeeks(injuryWithResumeFallback(inj), 'run', weeksRemaining);
}

/**
 * Effective station training-horizon build weeks after debiting injury
 * recovery for the region(s) the station loads. Returns the full
 * `weeksRemaining` when there is no active injury.
 */
export function stationInjuryBuildWeeks(
  inj: InjuryState | undefined,
  station: HyroxStation,
  weeksRemaining: number,
): number {
  const eff = injuryWithResumeFallback(inj);
  const region = HYROX_STATION_REGION[station];
  if (region === 'upper') return injuryAdjustedBuildWeeks(eff, 'upperLoad', weeksRemaining);
  if (region === 'lower') return injuryAdjustedBuildWeeks(eff, 'lowerLoad', weeksRemaining);
  // full: the station is only as trainable as its most-restricted contributor.
  return Math.min(
    injuryAdjustedBuildWeeks(eff, 'upperLoad', weeksRemaining),
    injuryAdjustedBuildWeeks(eff, 'lowerLoad', weeksRemaining),
  );
}
