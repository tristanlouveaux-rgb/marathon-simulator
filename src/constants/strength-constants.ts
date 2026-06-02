/**
 * Strength progression + benchmark constants.
 *
 * Kept separate from triathlon-constants to avoid mixing domains. Every value
 * here is justified in docs/SCIENCE_LOG.md (Strength Tracking section). Do not
 * add a constant without a SCIENCE_LOG entry.
 */

/**
 * Suggested working-weight increase, as a fraction of the current working
 * weight, when a building-phase session is rated "had reps left" (>=2 in
 * reserve). 2.5% is a conservative linear-progression step for endurance
 * athletes whose strength work serves the sport, not maximal hypertrophy.
 * Endorsed by Tristan, 2026-06-01. See SCIENCE_LOG.
 */
export const STRENGTH_PROGRESSION_PCT = 0.025;

/**
 * Smallest achievable weight jump (kg). 1.25 kg plates per side => 2.5 kg
 * total. All suggestions round to a multiple of this, and a bump is never
 * smaller than this (so a light lift still progresses).
 */
export const STRENGTH_MIN_INCREMENT_KG = 2.5;

/**
 * Rep ceiling for the Epley estimated-1RM formula. Epley (1RM = w*(1+r/30))
 * loses validity well above ~10-12 reps; we cap the rep term at 12 so a high-
 * rep accessory set doesn't inflate the estimate.
 */
export const EPLEY_REP_CAP = 12;

/**
 * Minimum estimated-1RM improvement (kg) that counts as a celebrated PR.
 * One plate jump. Mirrors MARKER_BUMP_THRESHOLD_* for FTP/CSS/VDOT.
 */
export const STRENGTH_PR_THRESHOLD_KG = 2.5;

export type GymGoal = 'strength' | 'muscle' | 'general';

export interface GymGoalScheme {
  /** Working sets per exercise. */
  sets: number;
  /** Rep target as a string (matches the gym.ts "{sets}x{reps}" line format). */
  reps: string;
  /** Baseline load as % of estimated 1RM, emitted as the "@X% 1RM" garnish. */
  loadPct: number;
  /** Prescribed rest after a set (seconds), straight-sets style. */
  restSec: number;
  /** Compressed rest when the user picks the circuit / active-rest style. */
  restCircuitSec: number;
}

/**
 * Goal-driven rep schemes for the on-demand gym generator's Upper / Full focuses
 * (the Running-strength + Lower focuses keep their existing running-specific
 * templates). Strength work here serves the endurance athlete, so the "strength"
 * load is the bottom of the classic strength band, not a powerlifting max.
 *
 * Sources (see SCIENCE_LOG §AX):
 *  - ACSM Position Stand 2009 (Med Sci Sports Exerc 41:687): strength 60-80%/
 *    novice-intermediate at 8-12 / 6 reps; hypertrophy 70-85% at 6-12; muscular
 *    endurance <70% at 10-15+.
 *  - Schoenfeld et al. 2016 (J Strength Cond Res, rest interval) + 2017 (volume
 *    meta-analysis): 60-90s rest supports hypertrophy; weekly volume drives it.
 *  - de Salles et al. 2009 (Sports Med 39:765): 3-5 min rest for maximal-strength
 *    loads; we use ~3 min as the supportive-athlete compromise.
 * PROPOSED, endorsed by Tristan 2026-06-02.
 */
export const GYM_GOAL_SCHEMES: Record<GymGoal, GymGoalScheme> = {
  strength: { sets: 4, reps: '5',  loadPct: 80, restSec: 180, restCircuitSec: 90 },
  muscle:   { sets: 3, reps: '10', loadPct: 70, restSec: 75,  restCircuitSec: 45 },
  general:  { sets: 3, reps: '12', loadPct: 60, restSec: 60,  restCircuitSec: 40 },
};

/** Default session length (min) for an on-demand HYROX brick. Tristan 2026-06-02. */
export const GYM_HYROX_DEFAULT_MINUTES = 40;

/**
 * Load shift (percentage points of 1RM) for one "easier"/"harder" notch on a
 * generated gym session. ±5% is a conventional intensity step (one small load
 * adjustment), kept inside the [40, 90] band. PROPOSED, 2026-06-02 — see
 * SCIENCE_LOG §AY.
 */
export const GYM_INTENSITY_PCT_STEP = 5;

/**
 * Strength → running-economy contribution to the FORECAST (not current fitness).
 *
 * Concurrent heavy-resistance + plyometric training improves running economy by
 * ~2-4% and time-trial performance by ~2-5% over 8-12 weeks (Beattie & Blagrove
 * et al. 2018, Sports Med 48:1117 systematic review; Denadai et al. 2017 meta-
 * analysis). We project up to 3% time improvement at full adoption — the
 * optimistic-but-defensible edge of that range, consistent with the project's
 * forecast-calibration stance (forecast leans optimistic, baseline stays honest).
 *
 * This is a FUTURE-PROJECTION term in the training-horizon model: "the strength
 * sessions in your plan will raise your economy across the block." It is NOT a
 * retroactive multiplier on current fitness — the blend's current predictors
 * (VDOT/LT/PB/Tanda/HR) already contain the athlete's present economy, so a
 * retroactive factor would double-count. The run-volume horizon term carries no
 * strength signal, so this addition is additive, and it sits under the same
 * `max_gain_cap_pct` ceiling as the running gain. See SCIENCE_LOG §BC.
 *
 * Magnitude signed off by Tristan, 2026-06-02.
 */
export const STRENGTH_MAX_ECONOMY_GAIN_PCT = 3;

/**
 * Time constant (weeks) for strength-economy adoption. The contribution
 * saturates as `1 − e^(−trainingWeeks / STRENGTH_TAU_WEEKS)`, reaching ~63% of
 * its ceiling at 10 weeks and ~86% at 20 — matching the 8-12 week onset window
 * in the literature above. A short plan therefore credits proportionally less
 * strength gain (less time to adapt). PROPOSED, 2026-06-02 — see SCIENCE_LOG §BC.
 */
export const STRENGTH_TAU_WEEKS = 10;
