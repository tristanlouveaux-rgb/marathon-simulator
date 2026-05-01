/**
 * Triathlon adaptation parameters — five-signal adaptation ratio + reactivity
 * thresholds. Mirrors the marathon-side adaptation pattern (`predictions.ts →
 * blendPredictions`) but per-discipline.
 *
 * Every constant here is literature-anchored. Full rationale lives in
 * `docs/SCIENCE_LOG.md` §K (Live Adaptation Ratio) and §L (Plan-Side Reactivity).
 *
 * **Direction conventions**:
 *   - Each signal yields a "ratio adjustment" in [-cap, +cap].
 *   - Positive adjustment = athlete adapting faster than expected → ratio > 1.0.
 *   - Negative adjustment = under-adapting → ratio < 1.0.
 *   - Final ratio = 1.0 + Σ(weight_i × adjustment_i), clamped to [MIN, MAX].
 */

// ───────────────────────────────────────────────────────────────────────────
// Phase 2A — Adaptation ratio
// ───────────────────────────────────────────────────────────────────────────

/** Per-signal magnitude caps (ratio adjustment cannot exceed these in either direction). */
export const ADAPT_CAP_HRV          = 0.10;   // Plews et al. 2013, Sports Med 43:773
export const ADAPT_CAP_RPE          = 0.15;   // Foster 2001 — perceived effort range
export const ADAPT_CAP_HR_AT_POWER  = 0.10;   // Coggan & Allen 2019 Ch. 9
export const ADAPT_CAP_PAHR         = 0.10;   // Friel; Maunder et al. 2021 Sports Med 51:1387
export const ADAPT_CAP_CSS_SD       = 0.05;   // Pyne 2001 (low-confidence signal)

/** Sensitivity multipliers — convert raw signal delta to ratio adjustment. */
export const ADAPT_HRV_SENSITIVITY      = 1.5;    // 5% HRV trend → +7.5% ratio
export const ADAPT_RPE_SENSITIVITY      = 0.05;   // 1-pt RPE delta → +5% ratio
export const ADAPT_HR_POWER_SENSITIVITY = 0.05;   // 2 bpm/week drop → +10% ratio
export const ADAPT_PAHR_SENSITIVITY     = 0.5;    // 1 ppt/week reduction → +5% ratio
export const ADAPT_CSS_SD_SENSITIVITY   = 0.10;   // 1 sec/100m/week SD reduction → +10% ratio

/** Per-discipline blend weights. Each set must sum to 1.0. */
export const ADAPT_WEIGHTS_SWIM = { hrv: 0.30, rpe: 0.50, cssSd: 0.20 } as const;
export const ADAPT_WEIGHTS_BIKE = { hrv: 0.25, rpe: 0.30, hrAtPower: 0.25, pahr: 0.20 } as const;
export const ADAPT_WEIGHTS_RUN  = { hrv: 0.25, rpe: 0.30, pahr: 0.45 } as const;

/**
 * Final per-discipline ratio bounds. The HERITAGE family study (Bouchard 1999,
 * MSSE 31:252-258) shows ~5× spread in individual VO2max trainability; this
 * roughly maps to a ±30% multiplier on expected gain. Do not loosen without
 * new evidence.
 */
export const ADAPT_RATIO_MIN = 0.70;
export const ADAPT_RATIO_MAX = 1.30;

// Lookback windows
export const RPE_LOOKBACK_SESSIONS = 6;
export const HR_AT_POWER_WEEKS     = 8;
export const PAHR_WEEKS             = 8;
export const CSS_SD_WEEKS           = 8;
export const HRV_SHORT_DAYS         = 7;
export const HRV_LONG_DAYS          = 28;

// ───────────────────────────────────────────────────────────────────────────
// Phase 2B — Reactivity thresholds
// ───────────────────────────────────────────────────────────────────────────

/**
 * RPE points above expected that count as a "blown" session. Foster 2001
 * session-RPE methodology: 2 points = a meaningful effort overshoot worth
 * surfacing as a downgrade suggestion for the next quality day.
 */
export const RPE_BLOWN_DELTA = 2;

/**
 * Readiness gate — at or below this score, today's quality work is suggested
 * for downgrade. Mirrors the running side's "Manage Load" threshold.
 * Source: ACSM 2007 sleep-deprivation guidance + Plews 2013 HRV-based readiness.
 */
export const READINESS_GATE_THRESHOLD = 60;

/** Hard floor on sleep debt; above this we always gate quality work. */
export const SLEEP_DEBT_HARD_FLOOR_SEC = 5 * 3600;

/** Per-discipline TSB threshold below which today's quality work is gated. */
export const TSB_GATE_THRESHOLD = -20;

/**
 * Volume-ramp cap (Gabbett 2016). Re-exported from the existing constant for
 * convenience — keep the canonical definition in `triathlon-constants.ts`.
 */
export { WEEKLY_VOLUME_RAMP_CAP as VOLUME_RAMP_PCT } from './triathlon-constants';
