/**
 * Triathlon training-horizon parameters — per-discipline non-linear improvement
 * model. Mirrors `TRAINING_HORIZON_PARAMS` (run side, src/constants/training-params.ts)
 * with separate constants for swim CSS and bike FTP. Run uses the existing
 * marathon/half params unchanged.
 *
 * Every constant below has a citation. Full rationale lives in
 * `docs/SCIENCE_LOG.md` §F. Do not edit values without updating SCIENCE_LOG and
 * confirming with Tristan.
 *
 * **Direction conventions** (easy to get wrong):
 *   - CSS: lower sec/100m = faster. `improvement_pct` is a *reduction*. Apply
 *     as `projCss = currentCss * (1 - improvement_pct/100)`.
 *   - FTP: higher watts = faster. Apply as
 *     `projFtp = currentFtp * (1 + improvement_pct/100)`.
 *   - VDOT: higher = faster. Reuse marathon function; not in this file.
 */

import type { AbilityBand } from '@/types';

// ───────────────────────────────────────────────────────────────────────────
// Swim — CSS adaptation
// Sources:
//   - Pyne, Trewin & Hopkins (2004) "Progression and variability of competitive
//     performance of Olympic swimmers", J Sports Sci 22:613–620 — elite swimmers
//     improve ~0.4–1.0%/yr at peak performance.
//   - Costa M et al. (2010) longitudinal age-grouper data — ~3–6% over a season
//     for sub-elite swimmers.
//   - Stewart & Hopkins (2000) — swim adaptation rates across abilities.
//   - Mujika et al. (2002) "Influence of training and taper on swimming
//     performance" MSSE 34:1486–1493 — 2.2 ± 1.5% gain in 99 swimmers, 3wk taper.
//   - Toussaint & Hollander (1994) — propulsive efficiency explains ~80% of
//     inter-individual variance in swim economy. Swim is technique-limited.
//   - Maglischo "Swimming Fastest" (2003) — coaching reference for session/week
//     thresholds.
//   - Sweetenham & Atkinson "Championship Swim Training" (2003) — 8–12wk macro
//     blocks for adaptation.
// Confidence: high at elite end (Pyne 2004), medium below. Tau weakly supported
// (clinical experience). Taper bonus is high-confidence (Mujika 2002, n=99).
// ───────────────────────────────────────────────────────────────────────────

export interface DisciplineHorizonParams {
  max_gain_pct: Record<AbilityBand, number>;
  tau_weeks: Record<AbilityBand, number>;
  ref_sessions: Record<AbilityBand, number>;
  min_sessions: Record<AbilityBand, number>;
  undertrain_penalty_pct: number;  // % per session below min_sessions
  taper_bonus_pct: Record<AbilityBand, number>;
  max_gain_cap_pct: number;
  max_slowdown_pct: number;
}

export const SWIM_HORIZON_PARAMS: DisciplineHorizonParams = {
  // Max % CSS improvement over a full block (saturating asymptote).
  max_gain_pct: {
    beginner:     6.0,   // Costa 2010 (sub-elite age-grouper data)
    novice:       4.5,
    intermediate: 3.0,
    advanced:     1.8,   // Pyne 2004 (sub-elite peak progression)
    elite:        0.9,   // Pyne 2004 (Olympic-level peak progression)
  },
  // Time constant for `(1 - exp(-w/tau))`. Swim adapts more slowly than run/
  // bike because it is technique-bound (Sweetenham 2003 macro guidance).
  tau_weeks: {
    beginner:     10,
    novice:       10,
    intermediate: 10,
    advanced:     12,
    elite:        12,
  },
  // Sweet spot for sessions/week (logistic centre). Below ~3, technique decays
  // between sessions faster than fitness builds (Toussaint 1994; Costa 2010).
  ref_sessions: {
    beginner:     3,
    novice:       3,
    intermediate: 4,
    advanced:     5,
    elite:        6,
  },
  // Below this, motor pattern degrades (Maglischo 2003).
  min_sessions: {
    beginner:     2,
    novice:       2,
    intermediate: 2,
    advanced:     3,
    elite:        3,
  },
  // Per session/week below min. Larger than run because skill loss compounds
  // with fitness loss in swim (Toussaint & Hollander 1994).
  undertrain_penalty_pct: 3.0,
  // Mujika 2002 — 2.2 ± 1.5% in 99 swimmers, 3wk taper.
  taper_bonus_pct: {
    beginner:     2.0,
    novice:       2.0,
    intermediate: 2.2,
    advanced:     2.2,
    elite:        2.5,
  },
  max_gain_cap_pct: 8.0,
  max_slowdown_pct: 4.0,
};

// ───────────────────────────────────────────────────────────────────────────
// Bike — FTP adaptation
// Sources:
//   - Coggan & Allen (2019) "Training and Racing with a Power Meter" 3rd ed.
//     Ch. 7 (FTP gain rates), Ch. 9 (HR-at-power signals for adaptation).
//   - Pinot & Grappe (2011) "The record power profile to assess performance in
//     elite cyclists" — pro cyclists ~1–3%/yr at top end.
//   - Lucia A et al. (2000) — pro cyclist physiological adaptations.
//   - Coyle (1991) "Integration of the physiological factors determining
//     endurance performance ability" Exerc Sport Sci Rev 19:307–340.
//   - Bouchard HERITAGE family study — VO2max trainability variance for
//     beginner-end extrapolation.
//   - Mujika & Padilla (2003) "Scientific bases for precompetition tapering"
//     MSSE 35:1182–1187 — 2–6% bike performance gain from optimised taper.
//   - Bosquet L et al. (2007) meta-analysis — 1.96% mean perf gain (CI 0.8–3.1%).
// Confidence: high at trained end (Coggan 2019, Pinot 2011). Beginner figure
// extrapolated from VO2max trainability. Taper bonus is high-confidence.
// ───────────────────────────────────────────────────────────────────────────

export const BIKE_HORIZON_PARAMS: DisciplineHorizonParams = {
  // Max % FTP gain over a full block. Untrained have most headroom; pros
  // plateau hard.
  max_gain_pct: {
    beginner:     15.0,  // HERITAGE-extrapolated; large headroom
    novice:       10.0,
    intermediate: 6.0,   // Coggan 2019 typical season gain
    advanced:     3.5,
    elite:        1.5,   // Pinot 2011 pro longitudinal data
  },
  // FTP shifts visible in 4–6wk for untrained (Coggan CTL framework). Slower
  // for trained (Lucia 2000).
  tau_weeks: {
    beginner:     6,
    novice:       7,
    intermediate: 8,
    advanced:     10,
    elite:        12,
  },
  // 3–5 quality bike sessions/wk for sustained CTL build (Coggan 2019).
  ref_sessions: {
    beginner:     3,
    novice:       3,
    intermediate: 4,
    advanced:     5,
    elite:        5,
  },
  // Below this, CTL drift dominates over adaptation (TrainingPeaks WKO).
  min_sessions: {
    beginner:     2,
    novice:       2,
    intermediate: 3,
    advanced:     3,
    elite:        3,
  },
  // Per session/week below min. Smaller than swim because bike adapts faster
  // to volume than swim does to technique sessions.
  undertrain_penalty_pct: 2.0,
  // Mujika & Padilla 2003 + Bosquet 2007 meta. 2–6% range, mean ~3%.
  taper_bonus_pct: {
    beginner:     2.5,
    novice:       2.5,
    intermediate: 3.0,
    advanced:     3.0,
    elite:        3.0,
  },
  max_gain_cap_pct: 18.0,
  max_slowdown_pct: 6.0,
};

// ───────────────────────────────────────────────────────────────────────────
// Shared
// ───────────────────────────────────────────────────────────────────────────

/**
 * Logistic steepness for the session-factor curve. Reused from marathon
 * (`TRAINING_HORIZON_PARAMS.k_sessions = 1.0`) because the shape is
 * discipline-agnostic.
 */
export const TRI_K_SESSIONS = 1.0;

/**
 * Per-discipline taper duration in weeks (used as `taper_weeks` argument).
 * Bike taper is shortest, swim longest (technique consolidation needs more
 * time per Mujika 2002).
 */
export const TRI_TAPER_WEEKS: Record<'swim' | 'bike' | 'run', { '70.3': number; ironman: number }> = {
  swim: { '70.3': 1.5, ironman: 2.5 },
  bike: { '70.3': 1.0, ironman: 2.0 },
  run:  { '70.3': 1.5, ironman: 3.0 },
};

/**
 * Map years of endurance training to the existing `experience_level` bucket
 * used by `applyTrainingHorizonAdjustment`. Anchored to general training-age
 * literature (Joyner & Coyle 2008 — 5+ yrs for full aerobic adaptation).
 */
export function yearsOfTrainingToExperienceLevel(years: number | undefined): string {
  if (years == null) return 'intermediate';
  if (years < 0.5)  return 'total_beginner';
  if (years < 1)    return 'beginner';
  if (years < 2)    return 'novice';
  if (years < 4)    return 'intermediate';
  if (years < 7)    return 'advanced';
  return 'competitive';
}
