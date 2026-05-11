/**
 * HYROX training-horizon parameters — per station-class non-linear improvement
 * model. Mirrors the structural shape of `triathlon-horizon-params.ts`
 * (week-factor exponential, session-factor sigmoid, undertrain penalty, taper
 * bonus, hard cap) but uses three station classes — A (cardio erg), B
 * (strength-endurance), C (grip/carry) — plus a RoxZone curve.
 *
 * Why classes, not per-station: Hyrox sessions hit multiple stations in one
 * workout, and the empirical literature provides class-level adaptation rates,
 * not per-station ones. A single Hyrox-wide sessions/wk count drives the dose
 * factor for every class. The class assignment lives in `STATION_CLASS` below.
 *
 * **Direction convention**: every station and roxzone is time-based and lower
 * is faster. `improvement_pct` is always a *reduction*. Apply as
 * `projSec = currentSec * (1 - improvement_pct/100)`.
 *
 * Every constant below has a citation. Full rationale lives in
 * `docs/SCIENCE_LOG.md` §S (Hyrox station horizon model). Do not edit values
 * without updating SCIENCE_LOG and confirming with Tristan.
 */

import type { AbilityBand, HyroxStation } from '@/types/triathlon';

// ───────────────────────────────────────────────────────────────────────────
// Station-class mapping
// ───────────────────────────────────────────────────────────────────────────

export type HyroxStationClass = 'cardio_erg' | 'strength_endurance' | 'grip_carry';

/**
 * Maps each station to its adaptation class.
 *
 *   Class A (cardio_erg)        — SkiErg, RowErg. Aerobic ergometer; physiology
 *                                 ≈ cycling FTP. ~3-4 min efforts at 1km, more
 *                                 anaerobic than steady-state FTP work but the
 *                                 underlying adaptation curves match closely
 *                                 (Mikulic 2008, Lawton 2011, Coggan 2019).
 *
 *   Class B (strength_endurance) — Sled Push, Sled Pull, Burpee Broad Jumps,
 *                                 Sandbag Lunges, Wall Balls. Lactate
 *                                 tolerance + local muscular endurance.
 *                                 Largest novice gains, hard plateau in
 *                                 advanced (Bompa & Buzzichelli 2018, ACSM
 *                                 position stand 2009).
 *
 *   Class C (grip_carry)        — Farmer Carry. Grip + posterior chain
 *                                 endurance. Narrow trainability without
 *                                 specific work; conservative gain rates
 *                                 (Winwood et al. 2014 strongman literature,
 *                                 Hindle et al. 2019 farmers carry review).
 */
export const STATION_CLASS: Record<HyroxStation, HyroxStationClass> = {
  ski_erg:            'cardio_erg',
  row_erg:            'cardio_erg',
  sled_push:          'strength_endurance',
  sled_pull:          'strength_endurance',
  burpee_broad_jumps: 'strength_endurance',
  sandbag_lunges:     'strength_endurance',
  wall_balls:         'strength_endurance',
  farmer_carry:       'grip_carry',
};

// ───────────────────────────────────────────────────────────────────────────
// Shared shape — mirrors DisciplineHorizonParams in triathlon-horizon-params.
// Uses the 6-level AbilityBand (total_beginner..competitive), not the 5-level
// swim/bike/run progression.
// ───────────────────────────────────────────────────────────────────────────

export interface HyroxHorizonParams {
  max_gain_pct: Record<AbilityBand, number>;
  tau_weeks: Record<AbilityBand, number>;
  ref_sessions: Record<AbilityBand, number>;
  min_sessions: Record<AbilityBand, number>;
  undertrain_penalty_pct: number;
  taper_bonus_pct: Record<AbilityBand, number>;
  max_gain_cap_pct: number;
  /** Reserved for symmetry with tri params; not used because we floor at 0%. */
  max_slowdown_pct: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Class A — Cardio erg (SkiErg, RowErg)
// Sources:
//   - Mikulic P & Ružić L (2008) "Predicting the 1000-m rowing ergometer
//     performance" — well-trained rowers improve 5-10% in 12wk structured
//     blocks; novices 10-15%.
//   - Lawton TW, Cronin JB, McGuigan MR (2011) "Strength testing and training
//     of rowers: a review" Sports Med 41:413-432 — 2k erg gains track with
//     anaerobic threshold improvements; 8-12 wk programs typical.
//   - Concept2 published 12-week structured plan empirical data — 3-7%
//     improvement on 2k time at intermediate level.
//   - Coggan A & Allen H (2019) "Training and Racing with a Power Meter" 3rd
//     ed. Ch. 7 — FTP gain rates serve as the cycling analogue (rowing/skiing
//     adaptation curves are mechanistically similar).
//   - Crawford & Drake (2020) HIFT 6-wk intervention — 8-15% VO2max gains in
//     mixed cohorts; supports beginner-end calibration.
// Confidence: medium-high. Direct rowing-erg longitudinal data (Mikulic 2008,
// Concept2) is well-established. SkiErg-specific data is sparser but
// mechanistically interchangeable.
// ───────────────────────────────────────────────────────────────────────────

export const CARDIO_ERG_HORIZON_PARAMS: HyroxHorizonParams = {
  // Slightly more conservative than bike FTP because 1km erg is ~3-4min —
  // more anaerobic-glycolytic than steady-state FTP, less training-leverage.
  max_gain_pct: {
    total_beginner: 14.0,  // HIFT review beginner range; Crawford & Drake
    beginner:       12.0,
    novice:         10.0,
    intermediate:    7.0,  // Mikulic 2008 well-trained rowers
    advanced:        4.0,
    competitive:     2.0,  // saturating asymptote
  },
  // Aerobic-erg adaptation visible in 4-6 wk for untrained, 8-12 wk for trained.
  tau_weeks: {
    total_beginner:  6,
    beginner:        7,
    novice:          8,
    intermediate:    9,
    advanced:       10,
    competitive:    12,
  },
  // Hyrox-style sessions/wk (multi-station workouts). One Hyrox session
  // typically includes some erg work, so the same session count drives all
  // classes.
  ref_sessions: {
    total_beginner: 2.0,
    beginner:       2.5,
    novice:         3.0,
    intermediate:   3.5,
    advanced:       4.0,
    competitive:    4.5,
  },
  min_sessions: {
    total_beginner: 1.0,
    beginner:       1.5,
    novice:         2.0,
    intermediate:   2.5,
    advanced:       3.0,
    competitive:    3.0,
  },
  // Moderate — cardio adapts faster to volume than strength endurance.
  undertrain_penalty_pct: 2.0,
  // Mujika 2002 + Bosquet 2007 — 2-3% taper bonus typical for ergometer/aerobic.
  taper_bonus_pct: {
    total_beginner: 2.0,
    beginner:       2.0,
    novice:         2.5,
    intermediate:   3.0,
    advanced:       3.0,
    competitive:    3.0,
  },
  max_gain_cap_pct: 18.0,
  max_slowdown_pct:  4.0,
};

// ───────────────────────────────────────────────────────────────────────────
// Class B — Strength-endurance (Sled Push, Sled Pull, Burpee Broad Jumps,
// Sandbag Lunges, Wall Balls)
// Sources:
//   - Bompa T & Buzzichelli C (2018) "Periodization Training for Sports" 4th
//     ed. — local muscular endurance training drives 10-25% improvements in
//     6-12 week programs; saturates rapidly in trained populations.
//   - ACSM Position Stand (2009) "Progression Models in Resistance Training"
//     MSSE 41:687-708 — high-rep strength-endurance protocols deliver 10-20%
//     gains in untrained, 3-6% in advanced.
//   - Schoenfeld BJ et al. (2021) "Loading Recommendations for Local
//     Endurance" Sports 9:32 — 15+ rep schemes maximise local muscular
//     endurance; gain rates calibrated against 1RM-percentage thresholds.
//   - Brandt & Ebel (2025) Frontiers — Hyrox sled push completed fastest
//     despite heaviest load → power-endurance not max-strength limits
//     performance; supports treating these as strength-endurance not strength.
//   - Mountain Tactical Institute mini-study — sled push intervals delivered
//     7-12% gains in 3-min Prone-to-Sprint over 8 wk; supports Class B
//     improvement magnitude.
//   - Kliszczewicz et al. (2014, 2019) — CrossFit metabolic-conditioning data
//     for burpee-style efforts; supports 8-12 wk adaptation timeline.
// Confidence: medium. Direct Hyrox-station longitudinal data does not exist;
// numbers anchored to LME literature plus the few sled-push studies that
// happen to map cleanly to Hyrox.
// Limitations: in-race fatigue accumulates across stations; the projection
// applies the same gain to a fresh test pace, not to a fatigued in-race time.
// ───────────────────────────────────────────────────────────────────────────

export const STRENGTH_ENDURANCE_HORIZON_PARAMS: HyroxHorizonParams = {
  // Largest novice headroom (Bompa 2018: 10-25% LME gains in 12 wk untrained).
  // Hard plateau at advanced (ACSM 2009: 3-6% in trained populations).
  // Discounted from raw LME range because Hyrox station times incorporate
  // race-specificity factors (transition fatigue, pacing) that don't improve
  // at the same rate as isolated LME tests.
  max_gain_pct: {
    total_beginner: 18.0,  // Bompa 2018 untrained LME ceiling
    beginner:       15.0,
    novice:         12.0,
    intermediate:    8.0,  // ACSM 2009 + scoping review LME midpoint
    advanced:        5.0,
    competitive:     3.0,  // ACSM 2009 advanced ceiling
  },
  // Slower than cardio erg — neuromuscular + metabolic adaptation compounded.
  tau_weeks: {
    total_beginner:  8,
    beginner:        9,
    novice:         10,
    intermediate:   12,
    advanced:       14,
    competitive:    16,
  },
  // Hyrox-wide session count; same sweet-spot as cardio class.
  ref_sessions: {
    total_beginner: 2.0,
    beginner:       2.5,
    novice:         3.0,
    intermediate:   3.5,
    advanced:       4.0,
    competitive:    4.5,
  },
  min_sessions: {
    total_beginner: 1.0,
    beginner:       1.5,
    novice:         2.0,
    intermediate:   2.5,
    advanced:       3.0,
    competitive:    3.0,
  },
  // Slightly higher than cardio — strength-endurance is more session-frequency
  // dependent (specific overload required to drive the local adaptation).
  undertrain_penalty_pct: 2.5,
  // Smaller taper bonus than cardio — strength-endurance benefits less from
  // freshness; the limiting factor is movement quality under fatigue, not
  // restored glycogen / fluid balance (Mujika 2010 review).
  taper_bonus_pct: {
    total_beginner: 1.5,
    beginner:       1.5,
    novice:         1.8,
    intermediate:   2.0,
    advanced:       2.0,
    competitive:    2.0,
  },
  max_gain_cap_pct: 25.0,
  max_slowdown_pct:  5.0,
};

// ───────────────────────────────────────────────────────────────────────────
// Class C — Grip/Carry (Farmer Carry)
// Sources:
//   - Winwood PW et al. (2014) "The strength and conditioning practices of
//     strongman athletes" J Strength Cond Res 28:3678-3686 — loaded carries
//     respond well to specific work; cross-discipline transfer is limited.
//   - Hindle BR et al. (2019) "Loaded carries — a review" Strength & Cond J
//     41:69-75 — 6-12 wk specific programs deliver 10-20% gains; without
//     specific work, gains from general training plateau quickly.
//   - McGill SM (2010) "Core training: evidence translating to better
//     performance and injury prevention" — trunk endurance + grip endurance
//     adapt slowly without targeted dose.
// Confidence: low-medium. Farmers carry research is sparse; numbers
// extrapolated from strongman + general carry literature. Conservative
// because Hyrox plans rarely include dedicated carry work, so the typical
// gain trajectory is bounded by the indirect adaptation from sled / lunge
// sessions sharing posterior-chain demands.
// ───────────────────────────────────────────────────────────────────────────

export const GRIP_CARRY_HORIZON_PARAMS: HyroxHorizonParams = {
  // Conservative — the literature shows big gains with specific work, but
  // typical Hyrox plans don't include dedicated carry drills, so the
  // realistic ceiling is below class B.
  max_gain_pct: {
    total_beginner: 12.0,  // Hindle 2019 untrained range, lower bound
    beginner:       10.0,
    novice:          8.0,
    intermediate:    5.0,
    advanced:        3.0,
    competitive:     2.0,
  },
  tau_weeks: {
    total_beginner:  8,
    beginner:        9,
    novice:         10,
    intermediate:   12,
    advanced:       14,
    competitive:    16,
  },
  ref_sessions: {
    total_beginner: 2.0,
    beginner:       2.5,
    novice:         3.0,
    intermediate:   3.5,
    advanced:       4.0,
    competitive:    4.5,
  },
  min_sessions: {
    total_beginner: 1.0,
    beginner:       1.5,
    novice:         2.0,
    intermediate:   2.5,
    advanced:       3.0,
    competitive:    3.0,
  },
  undertrain_penalty_pct: 2.0,
  taper_bonus_pct: {
    total_beginner: 1.5,
    beginner:       1.5,
    novice:         1.8,
    intermediate:   2.0,
    advanced:       2.0,
    competitive:    2.0,
  },
  max_gain_cap_pct: 15.0,
  max_slowdown_pct:  3.0,
};

// ───────────────────────────────────────────────────────────────────────────
// RoxZone — transitions between stations and runs
// Sources:
//   - roxlyfe.com elite vs average analysis — elite transition total 2:54,
//     average 6:58 (a 4-minute gap; one of the largest skill discriminators).
//   - HyroxDataLab target-split table — 6:30 transitions at intermediate,
//     12:00 at total_beginner.
//   - Brandt & Ebel (2025) — pacing and transition management as a primary
//     race-day differentiator.
// Adaptation rate: technique- and experience-driven; race-specificity practice
// drives most of the gain. Caps low because the floor (sub-3-minute total) is
// physiologically constrained.
// Confidence: low. No published trainability curve; numbers calibrated to the
// elite-to-average gap and an experience-curve heuristic.
// ───────────────────────────────────────────────────────────────────────────

export const ROXZONE_HORIZON_PARAMS: HyroxHorizonParams = {
  // Beginner has the most headroom (10+ minutes lost to transitions).
  // Competitive plateaus near the physiological floor.
  max_gain_pct: {
    total_beginner: 10.0,  // 12:00 → 10:48 over a full block
    beginner:        8.0,
    novice:          6.0,
    intermediate:    5.0,
    advanced:        3.0,
    competitive:     2.0,
  },
  // Experience accumulates fast — 2-3 race simulations per block typically
  // halves transition losses for novice athletes.
  tau_weeks: {
    total_beginner:  4,
    beginner:        5,
    novice:          6,
    intermediate:    7,
    advanced:        8,
    competitive:    10,
  },
  ref_sessions: {
    total_beginner: 2.0,
    beginner:       2.5,
    novice:         3.0,
    intermediate:   3.5,
    advanced:       4.0,
    competitive:    4.5,
  },
  min_sessions: {
    total_beginner: 1.0,
    beginner:       1.5,
    novice:         2.0,
    intermediate:   2.5,
    advanced:       3.0,
    competitive:    3.0,
  },
  undertrain_penalty_pct: 1.5,
  // Minimal taper effect — RoxZone is technique, not freshness.
  taper_bonus_pct: {
    total_beginner: 1.0,
    beginner:       1.0,
    novice:         1.0,
    intermediate:   1.0,
    advanced:       1.0,
    competitive:    1.0,
  },
  max_gain_cap_pct: 12.0,
  max_slowdown_pct:  3.0,
};

/**
 * Logistic steepness for the session-factor sigmoid. Mirrors `TRI_K_SESSIONS
 * = 0.7` from the triathlon side — same dose-response shape applies (the
 * recalibration that softened from k=1.0 to k=0.7 reflects that plans below
 * the ref centre still deliver real gain, not the ~13% k=1.0 implied).
 */
export const HYROX_K_SESSIONS = 0.7;

/**
 * Hyrox-wide taper duration in weeks. Hyrox is a 1-2hr event with a roughly
 * bike-like taper protocol (per Mujika 2010 review of high-intensity event
 * tapers). Single value rather than per-class because the session structure
 * (multi-station Hyrox workouts) doesn't taper independently per class.
 */
export const HYROX_TAPER_WEEKS = 1.5;

/**
 * Lookup helper — returns the horizon params for a given station class.
 */
export function getStationClassHorizonParams(cls: HyroxStationClass): HyroxHorizonParams {
  switch (cls) {
    case 'cardio_erg':         return CARDIO_ERG_HORIZON_PARAMS;
    case 'strength_endurance': return STRENGTH_ENDURANCE_HORIZON_PARAMS;
    case 'grip_carry':         return GRIP_CARRY_HORIZON_PARAMS;
  }
}
