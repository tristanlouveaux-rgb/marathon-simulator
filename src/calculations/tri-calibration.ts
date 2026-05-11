/**
 * Triathlon prediction calibration — derives per-user correction factors
 * from the race log (predicted vs actual history).
 *
 * Tier ladder (data-gated so calibration grows with evidence):
 *   Tier 0 (< 2 races):  no calibration — current behaviour.
 *   Tier 1 (≥ 2 races):  per-leg additive bias. bias = median(actual − predicted),
 *                         capped at ±8% of median predicted leg time.
 *   Tier 2 (≥ 4 races with predictedRawPerLeg): learned maxPenalty scale per
 *                         leg, Bayesian-shrunk toward 1.0. Dormant until entries
 *                         carry the `predictedRawPerLeg` field added in WS-1.
 *   Tier 3 (≥ 6 races spanning ≥ 3 distances): full multiplier fit. Dormant
 *                         today — TriathlonDistance only has 70.3 / ironman,
 *                         so 3+ distinct distances cannot be reached yet.
 *
 * All tiers are additive: tier 2 includes tier 1's bias, tier 3 includes both.
 *
 * Pure — no state mutation, no I/O.
 */

import type { TriRaceLogEntry, TriCalibration } from '@/types/triathlon';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum bias per leg as a fraction of median predicted leg time. ±8% keeps
 *  calibration within the known 6–14% prediction error band (so it corrects
 *  systematic error without overfitting noise). */
const TIER1_BIAS_CAP_FRACTION = 0.08;

/** Bayesian shrinkage denominator for tier-2 scale: scale = 1 + (raw−1) * n/(n+4).
 *  At n=4, 50% shrunk; at n=8, 67% retained; asymptotes to raw. */
const TIER2_SHRINKAGE_N0 = 4;

/** Tier-2 maxPenalty scale clamp — prevents the learned scale from over-correcting
 *  on sparse data. */
const TIER2_SCALE_MIN = 0.6;
const TIER2_SCALE_MAX = 1.4;

// ─── Helpers ───────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Cap a bias value at ±fraction of the reference (median predicted leg time).
 * If reference is 0 or negative, return the uncapped bias (degenerate input).
 */
function capBias(bias: number, reference: number, fraction: number): number {
  if (reference <= 0) return bias;
  const cap = reference * fraction;
  return Math.max(-cap, Math.min(cap, bias));
}

/**
 * Bayesian shrinkage: pull `rawScale` toward 1.0 based on sample count.
 * scale = 1 + (rawScale - 1) * n / (n + n0)
 */
function shrink(rawScale: number, n: number, n0: number): number {
  const shrunk = 1 + (rawScale - 1) * (n / (n + n0));
  return Math.max(TIER2_SCALE_MIN, Math.min(TIER2_SCALE_MAX, shrunk));
}

// ─── Tier-1: per-leg additive bias ─────────────────────────────────────────

function computeTier1(entries: TriRaceLogEntry[]): { swim: number; bike: number; run: number } {
  const swimResiduals = entries.map(e => e.actualPerLeg.swim - e.predictedPerLeg.swim);
  const bikeResiduals = entries.map(e => e.actualPerLeg.bike - e.predictedPerLeg.bike);
  const runResiduals  = entries.map(e => e.actualPerLeg.run  - e.predictedPerLeg.run);

  const medSwimPred = median(entries.map(e => e.predictedPerLeg.swim));
  const medBikePred = median(entries.map(e => e.predictedPerLeg.bike));
  const medRunPred  = median(entries.map(e => e.predictedPerLeg.run));

  return {
    swim: capBias(median(swimResiduals), medSwimPred, TIER1_BIAS_CAP_FRACTION),
    bike: capBias(median(bikeResiduals), medBikePred, TIER1_BIAS_CAP_FRACTION),
    run:  capBias(median(runResiduals),  medRunPred,  TIER1_BIAS_CAP_FRACTION),
  };
}

// ─── Tier-2: learned maxPenalty scale ──────────────────────────────────────

/**
 * For each entry that has `predictedRawPerLeg`, compute the implied penalty
 * multiplier (post/pre ratio) and the residual fraction. Then regress.
 *
 * Residual after tier-1 bias: r_i = (actual_i - predicted_i_biased) / predicted_i
 * Penalty excess: p_i = predictedPerLeg_i / predictedRawPerLeg_i (≥ 1.0)
 * If r_i correlates positively with (p_i - 1), the penalty is understating
 * the true readiness shortfall → scale > 1. Negative correlation → overstatement.
 *
 * Uses simple least-squares slope. Returns raw (pre-shrinkage) scale per leg.
 * Returns 1.0 for legs with too few or degenerate data.
 */
function computeTier2RawScale(
  entries: TriRaceLogEntry[],
  tier1Bias: { swim: number; bike: number; run: number },
): { swim: number; bike: number; run: number } {
  const eligible = entries.filter(e => e.predictedRawPerLeg != null);
  if (eligible.length < 4) return { swim: 1.0, bike: 1.0, run: 1.0 };

  const rawScaleForLeg = (leg: 'swim' | 'bike' | 'run'): number => {
    const pairs: Array<{ penalty: number; residual: number }> = [];
    for (const e of eligible) {
      const raw = e.predictedRawPerLeg![leg];
      const post = e.predictedPerLeg[leg];
      const actual = e.actualPerLeg[leg];
      if (raw <= 0 || post <= 0) continue;
      const penaltyExcess = post / raw - 1;  // 0 when no penalty applied
      const biasedPredicted = post + tier1Bias[leg];
      const residualFraction = (actual - biasedPredicted) / post;
      pairs.push({ penalty: penaltyExcess, residual: residualFraction });
    }
    if (pairs.length < 4) return 1.0;

    // OLS slope: Σ(penalty_i * residual_i) / Σ(penalty_i²)
    // If slope > 0: under-penalised (higher penalty was associated with positive residual).
    // Raw scale = 1 + slope.
    const sumPP = pairs.reduce((s, p) => s + p.penalty * p.penalty, 0);
    if (sumPP < 1e-6) return 1.0;  // No variation in penalty → can't estimate slope
    const sumPR = pairs.reduce((s, p) => s + p.penalty * p.residual, 0);
    return 1.0 + sumPR / sumPP;
  };

  return {
    swim: rawScaleForLeg('swim'),
    bike: rawScaleForLeg('bike'),
    run:  rawScaleForLeg('run'),
  };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Compute the calibration struct for a given race log. Safe to call at any
 * time — returns tier=0 when not enough data, never throws.
 */
export function computeTriCalibration(raceLog: TriRaceLogEntry[] | undefined): TriCalibration {
  const entries = (raceLog ?? []).filter(
    e => e.predictedTotalSec > 0 && e.actualTotalSec > 0
      && e.predictedPerLeg.swim > 0
      && e.predictedPerLeg.bike > 0
      && e.predictedPerLeg.run > 0
      && e.actualPerLeg.swim > 0
      && e.actualPerLeg.bike > 0
      && e.actualPerLeg.run > 0,
  );

  const n = entries.length;
  const now = new Date().toISOString();

  if (n < 2) {
    return { tier: 0, basedOnRaceCount: n, computedAtISO: now };
  }

  // Tier 1: per-leg additive bias.
  const perLegBiasSec = computeTier1(entries);
  const tier1Cal: TriCalibration = {
    tier: 1,
    perLegBiasSec,
    basedOnRaceCount: n,
    computedAtISO: now,
  };
  if (n < 4) return tier1Cal;

  // Tier 2: learned maxPenalty scale (requires predictedRawPerLeg entries).
  const eligibleForTier2 = entries.filter(e => e.predictedRawPerLeg != null).length;
  if (eligibleForTier2 < 4) {
    // Have 4+ entries but none carry the raw field yet (all pre-WS-1).
    // Stay at tier 1 until enough new entries accumulate.
    return tier1Cal;
  }

  const rawScale = computeTier2RawScale(entries, perLegBiasSec);
  const perLegMaxPenaltyScale = {
    swim: shrink(rawScale.swim, eligibleForTier2, TIER2_SHRINKAGE_N0),
    bike: shrink(rawScale.bike, eligibleForTier2, TIER2_SHRINKAGE_N0),
    run:  shrink(rawScale.run,  eligibleForTier2, TIER2_SHRINKAGE_N0),
  };

  const tier2Cal: TriCalibration = {
    tier: 2,
    perLegBiasSec,
    perLegMaxPenaltyScale,
    basedOnRaceCount: n,
    computedAtISO: now,
  };

  // Tier 3 is dormant (TriathlonDistance = '70.3' | 'ironman'; 3+ distinct
  // distances unreachable today). Leave the machinery in place.
  const distinctDistances = new Set(entries.map(e => e.distance)).size;
  if (n >= 6 && distinctDistances >= 3) {
    // Placeholder — actual tier-3 fit goes here when sprint/olympic logging lands.
    return { ...tier2Cal, tier: 3 };
  }

  return tier2Cal;
}
