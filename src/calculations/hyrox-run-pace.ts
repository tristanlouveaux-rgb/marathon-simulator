/**
 * HYROX run-pace derivation.
 *
 * **Side**: tracking + planning. The model needs an honest per-km pace for
 * the 8 × 1km HYROX run legs. Pre-fix, it fell back to band-keyed seed paces
 * (`SEED_RUN_PACE_SEC_KM[band]`) when no manual entry was provided — fine
 * for population-mean estimates but ignores the athlete's actual aerobic
 * capacity (VDOT, LT pace).
 *
 * Approach: derive HYROX-fatigued pace from Daniels threshold pace
 * (`gp(vdot, ltPace).t`) × a band-specific fatigue ratio. Ratios are
 * back-calibrated to the existing `SEED_RUN_PACE_SEC_KM` values so the new
 * derivation matches the population-mean prediction at the band's implied
 * VDOT. See SCIENCE_LOG §U.
 *
 * Mirrors the CLAUDE.md "Manually-set Benchmarks Yield to Improvements"
 * rule: a user-entered HYROX run pace is preserved unless the derived value
 * is faster by ≥ 5 s/km, in which case derived overrides and provenance
 * flips to 'derived'.
 */

import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import { gp } from './paces';
import { SEED_RUN_PACE_SEC_KM, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';

/**
 * Threshold-to-HYROX-fatigued-pace expansion ratio per ability band.
 *
 * Source: reverse-engineered from the existing band seed paces in
 * `SEED_RUN_PACE_SEC_KM` divided by `gp(impliedVdot).t` for each band's
 * implied VDOT range. Empirically anchored to the same population data
 * the seeds came from — so a VDOT-derived pace lands at the seed when the
 * athlete's VDOT matches the band's implied VDOT.
 *
 * Band → implied VDOT → seed pace (s/km) → threshold (s/km) → ratio:
 *   competitive    VDOT 60+   232  ~221  → 1.05
 *   advanced       VDOT 50–55 270  ~245  → 1.10
 *   intermediate   VDOT 45    305  ~265  → 1.15
 *   novice         VDOT 38    355  ~296  → 1.20
 *   beginner       VDOT 32    400  ~320  → 1.25
 *   total_beginner VDOT 28    435  ~335  → 1.30
 */
export const HYROX_FATIGUE_TO_THRESHOLD_RATIO: Record<AbilityBand, number> = {
  competitive:    1.05,
  advanced:       1.10,
  intermediate:   1.15,
  novice:         1.20,
  beginner:       1.25,
  total_beginner: 1.30,
};

export type HyroxRunPaceSource = 'user' | 'derived' | 'seed';

export interface HyroxRunPaceResult {
  paceSecKm: number;
  source: HyroxRunPaceSource;
  /** The VDOT-derived value if available, regardless of which won. Useful
   *  for "your runs suggest X" UI captions. */
  derivedSecKm: number | null;
}

/** Derive a HYROX run pace from VDOT (preferred) or seed pace (fallback),
 *  honouring a user-entered value unless the derived is meaningfully faster. */
export function deriveHyroxRunPace(state: SimulatorState): HyroxRunPaceResult {
  const hx = state.hyroxConfig;
  if (!hx) return { paceSecKm: SEED_RUN_PACE_SEC_KM.intermediate, source: 'seed', derivedSecKm: null };

  const band = hx.athleteBand;
  const seed = SEED_RUN_PACE_SEC_KM[band];

  const vdot = state.v;
  const ltPace = state.lt ?? state.ltPace ?? null;

  let derived: number | null = null;
  if (typeof vdot === 'number' && vdot >= 25 && vdot <= 85) {
    const threshold = gp(vdot, ltPace).t;
    derived = Math.max(
      HYROX_RUN_PACE_MIN_SEC_KM,
      Math.round(threshold * HYROX_FATIGUE_TO_THRESHOLD_RATIO[band]),
    );
  }

  const userVal = hx.hyroxRunPaceSecKm;
  if (typeof userVal === 'number' && userVal > 0) {
    // Manually-set Benchmarks Yield to Improvements: derived overrides user
    // when faster by ≥ 5 s/km. Below that margin, user wins.
    if (derived != null && derived <= userVal - 5) {
      return { paceSecKm: derived, source: 'derived', derivedSecKm: derived };
    }
    return { paceSecKm: userVal, source: 'user', derivedSecKm: derived };
  }
  if (derived != null) return { paceSecKm: derived, source: 'derived', derivedSecKm: derived };
  return { paceSecKm: seed, source: 'seed', derivedSecKm: null };
}
