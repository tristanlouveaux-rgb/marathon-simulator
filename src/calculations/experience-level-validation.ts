/**
 * Experience-level / PB consistency check (audit #11 follow-up, ISSUE-145 sibling).
 *
 * The onboarding wizard asks the user to self-select an experience level
 * ("Running under 6 months" → beginner, "Consistent, raced before" →
 * intermediate, etc). Nothing stops a user with a sub-4 marathon PB from
 * selecting "beginner", and that mis-label silently distorts the horizon
 * model: a beginner runner has `max_gain_pct=9` (marathon, vs 7 for
 * intermediate) and `ref_sessions=4` (vs 5.5), so at 4 sessions/week the
 * `session_factor` is nearly 2× higher than for intermediate. Net result:
 * a mis-labelled "beginner" with VDOT 42 forecasts more improvement than
 * the correctly-labelled intermediate version of the same runner.
 *
 * This module provides a pure consistency check used by the onboarding
 * wizard to flag and auto-suggest a corrected level when the entered PBs
 * are physiologically inconsistent with the selected level.
 *
 * VDOT → expected-level mapping (Daniels 2014 + Pfitzinger 2009 cohort bands):
 *
 *   total_beginner: VDOT < 28  (no race history, just starting)
 *   beginner:       VDOT 28-35 (under 6 months structured running)
 *   novice:         VDOT 35-42 (occasional 5/10K racer)
 *   intermediate:   VDOT 42-52 (consistent, multi-year)
 *   advanced:       VDOT 52-58 (dedicated, periodised training)
 *   competitive:    VDOT >= 58 (club / high performance)
 *
 *   returning:  any VDOT (rebuilding from prior fitness) — orthogonal to band
 *   hybrid:     any VDOT (cross-sport athlete, low running km) — orthogonal
 *
 * The check fails when the user's selected band is **below** the band their
 * PBs demonstrate (e.g. VDOT 42 PB + "beginner" label). It does NOT fail
 * when the user selects a *higher* band than their PBs suggest — they may
 * have improved since their last race, or be entering aspirational status.
 * Asymmetric on purpose: under-claiming experience produces the model
 * inversion described above; over-claiming just makes forecasts more
 * conservative via lower max_gain and higher ref_sessions.
 */

import type { PBs } from '@/types/training';
import type { RunnerExperience } from '@/types/onboarding';
import { cv } from './vdot';

/** VDOT band cut-points. Boundaries are inclusive on the upper side
 *  (vdot < cut → that band) — matches Daniels' table semantics. */
const BAND_UPPER: Array<{ level: RunnerExperience; vdotUpper: number }> = [
  { level: 'total_beginner', vdotUpper: 28 },
  { level: 'beginner',       vdotUpper: 35 },
  { level: 'novice',         vdotUpper: 42 },
  { level: 'intermediate',   vdotUpper: 52 },
  { level: 'advanced',       vdotUpper: 58 },
  { level: 'competitive',    vdotUpper: Infinity },
];

/** Rank (low = less experienced). Mirrors `EXP_RANK` in training-horizon.ts.
 *  Used only to compare two band-based levels; `returning` and `hybrid` are
 *  excluded because they're orthogonal to the VDOT ladder. */
const BAND_RANK: Record<string, number> = {
  total_beginner: 0,
  beginner:       1,
  novice:         2,
  intermediate:   3,
  advanced:       4,
  competitive:    5,
};

/** Returns the band that the supplied VDOT falls into. */
function vdotToBand(vdot: number): RunnerExperience {
  for (const b of BAND_UPPER) {
    if (vdot < b.vdotUpper) return b.level;
  }
  return 'competitive';
}

/** Find the longest-distance PB available. Marathon > Half > 10K > 5K
 *  preference reflects that longer PBs are more diagnostic of training-
 *  history depth — anyone with a sub-4 marathon PB has demonstrably been
 *  training for a long time, while a fast 5K could come from speed
 *  athleticism without marathon-equivalent endurance. */
function bestPbForVdot(pbs: PBs): { dist: number; time: number } | null {
  if (pbs.m && pbs.m > 0)   return { dist: 42195, time: pbs.m };
  if (pbs.h && pbs.h > 0)   return { dist: 21097, time: pbs.h };
  if (pbs.k10 && pbs.k10 > 0) return { dist: 10000, time: pbs.k10 };
  if (pbs.k5 && pbs.k5 > 0)   return { dist: 5000, time: pbs.k5 };
  return null;
}

export interface ExperienceLevelCheckResult {
  /** True when the selected level is consistent with the entered PBs
   *  (or when there are no PBs / level is orthogonal to VDOT ladder). */
  isConsistent: boolean;
  /** The band that best matches the entered PBs (always a VDOT-band level,
   *  never `returning` or `hybrid`). Use this when suggesting an upgrade. */
  suggested?: RunnerExperience;
  /** Why the current selection doesn't match. Empty when consistent. */
  reason?: string;
  /** Approximate VDOT computed from the best (longest) PB. Useful for UI
   *  diagnostic copy ("Your 3:37 marathon suggests VDOT 42 — consistent
   *  with Intermediate or above"). */
  pbDerivedVdot?: number;
  /** The PB used to derive VDOT (distance in m + time in s). Surfaces in
   *  the UI so the user knows *which* PB triggered the suggestion. */
  pbUsed?: { distM: number; timeSec: number };
}

/**
 * Check whether `selectedLevel` is physiologically consistent with `pbs`.
 *
 * - No PBs supplied → consistent (no signal to check against)
 * - `returning` or `hybrid` selected → consistent (orthogonal to the
 *   VDOT-band ladder by design)
 * - Selected level corresponds to a lower band than PB-derived VDOT →
 *   inconsistent, suggest the PB-derived band
 * - Selected level corresponds to a higher band than PB-derived VDOT →
 *   consistent (over-claiming experience is safe; produces lower max_gain
 *   and is the user's prerogative)
 */
export function checkExperienceLevelVsPBs(
  selectedLevel: RunnerExperience | undefined,
  pbs: PBs,
): ExperienceLevelCheckResult {
  const best = bestPbForVdot(pbs);
  if (!best) return { isConsistent: true };
  if (!selectedLevel) return { isConsistent: true };

  // `returning` / `hybrid` bypass the VDOT-band check by design.
  if (selectedLevel === 'returning' || selectedLevel === 'hybrid') {
    return { isConsistent: true };
  }

  const pbVdot = cv(best.dist, best.time);
  const suggestedBand = vdotToBand(pbVdot);

  const selectedRank = BAND_RANK[selectedLevel] ?? 3;
  const suggestedRank = BAND_RANK[suggestedBand] ?? 3;

  // Only flag when selected band is BELOW (less experienced than) what PBs
  // demonstrate. Over-claiming (selecting advanced when PBs suggest novice)
  // produces more-conservative forecasts and is not flagged.
  if (selectedRank < suggestedRank) {
    const distLabel = best.dist === 42195 ? 'marathon'
      : best.dist === 21097 ? 'half-marathon'
      : best.dist === 10000 ? '10K'
      : '5K';
    const timeMin = Math.floor(best.time / 60);
    const timeSec = Math.round(best.time % 60);
    const timeStr = best.dist >= 21097
      ? `${Math.floor(best.time / 3600)}:${String(Math.floor((best.time % 3600) / 60)).padStart(2, '0')}`
      : `${timeMin}:${String(timeSec).padStart(2, '0')}`;
    return {
      isConsistent: false,
      suggested: suggestedBand,
      reason: `A ${timeStr} ${distLabel} (VDOT ~${pbVdot.toFixed(0)}) is faster than typical for "${selectedLevel}". Consider "${suggestedBand}" or "returning" if you've had a recent training gap.`,
      pbDerivedVdot: pbVdot,
      pbUsed: { distM: best.dist, timeSec: best.time },
    };
  }

  return {
    isConsistent: true,
    suggested: suggestedBand,
    pbDerivedVdot: pbVdot,
    pbUsed: { distM: best.dist, timeSec: best.time },
  };
}
