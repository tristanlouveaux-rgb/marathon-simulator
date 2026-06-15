/**
 * Conservative starting fitness for runners who finish onboarding with NO
 * personal best (true beginners, and cross-sport "hybrid" athletes with no
 * running times).
 *
 * Without this, `initializeSimulator` fails with "No personal bests provided"
 * and the review screen blocks "Build my plan" — a hard wall for exactly the
 * users least likely to know a 5K time. Instead we seed a deliberately
 * conservative, DERIVED 5K estimate so the plan can build and starts gentle,
 * then the weekly blend (`refreshBlendedFitness`) corrects it upward from the
 * athlete's real runs.
 *
 * The anchor VDOTs are NOT invented — they are the documented ability-band
 * floors from `experience-level-validation.ts` (Daniels 2014 + Pfitzinger 2009
 * cohort bands), also used as the band-implied VDOTs in `hyrox-staleness.ts`:
 *
 *   total_beginner / beginner → VDOT 28  (floor of the 28–35 beginner band)
 *   hybrid                    → VDOT 35  (novice floor — aerobically fit from
 *                                         other sports, not running-specific)
 *
 * We anchor at each band's FLOOR on purpose: a no-data start should
 * under-prescribe (safe, low injury risk) rather than over-prescribe, and the
 * estimate is marked `startingFitnessEstimated` so it yields to real data per
 * the "benchmarks yield to improvements" rule. See SCIENCE_LOG.
 */

import { tv } from './vdot';
import type { PBs } from '@/types/training';

/** Sourced conservative anchor VDOT per experience level (band floors). */
const ESTIMATED_START_VDOT: Record<string, number> = {
  total_beginner: 28,
  beginner: 28,
  hybrid: 35,
};

/**
 * True when this experience level may legitimately have no PB and should be
 * allowed through onboarding on a conservative estimate instead of a hard wall.
 * Every other level ("novice — occasional 5/10K", "intermediate — raced
 * before", etc.) implies a known time, so those still require a real PB.
 */
export function levelAllowsEstimatedStart(level: string | null | undefined): boolean {
  return level != null && level in ESTIMATED_START_VDOT;
}

/**
 * A conservative, derived 5K PB for a no-PB runner so the plan can build and
 * start gentle. Returns null for levels that imply a known time (caller keeps
 * the PB requirement for those). The single `k5` flows through the existing
 * PB → fatigue-exponent → blended-VDOT pipeline unchanged.
 */
export function seedStartingPbs(level: string | null | undefined): PBs | null {
  const vdot = level ? ESTIMATED_START_VDOT[level] : undefined;
  if (vdot == null) return null;
  return { k5: Math.round(tv(vdot, 5)) };
}

/**
 * Beginner/hybrid runs are capped to this many minutes at easy pace at PLAN
 * START, so a no-/low-history runner doesn't open the plan on ~10 km repeats.
 * 30 minutes continuous is the NHS Couch-to-5K graduation standard (and within
 * ACSM beginner guidance of 20–30 min). The plan ramps up from here. See
 * SCIENCE_LOG §BT.
 */
export const BEGINNER_START_RUN_CAP_MIN = 30;

/**
 * Conservative STARTING weekly km for beginner/hybrid runners with no detected
 * history: cap each run to BEGINNER_START_RUN_CAP_MIN at the athlete's easy
 * pace (so distance auto-scales — a faster hybrid covers more in 30 min than a
 * true beginner). Returns the capped value ONLY when it's lower than the
 * caller's default (never raises volume); otherwise null (keep the default).
 *
 * @param easySecPerKm easy pace in sec/km (state.pac.e)
 * @param defaultWeeklyKm the runs-per-week fallback the caller would otherwise use
 */
export function cappedBeginnerStartWeeklyKm(
  level: string | null | undefined,
  runsPerWeek: number,
  easySecPerKm: number,
  defaultWeeklyKm: number,
): number | null {
  if (!levelAllowsEstimatedStart(level)) return null;
  if (!(easySecPerKm > 0) || !(runsPerWeek > 0)) return null;
  const kmPerRun = (BEGINNER_START_RUN_CAP_MIN * 60) / easySecPerKm;
  const capped = Math.round(runsPerWeek * kmPerRun);
  return capped < defaultWeeklyKm ? capped : null;
}
