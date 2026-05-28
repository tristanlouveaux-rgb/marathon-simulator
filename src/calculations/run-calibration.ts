/**
 * Per-user prediction calibration for running mode (Tier 1).
 *
 * **Side of the line**: tracking. Learns the systematic gap between what the
 * blend predicts and what the user actually races, then applies that gap as
 * a per-distance additive bias to future predictions. Activates once at
 * least 2 races at the same distance are on file.
 *
 * Mirrors `triConfig.calibration` in shape and method: median(actual −
 * predicted) per distance, capped at ±8% of median predicted, ignored
 * below a 30-second minimum to filter noise.
 *
 * Science basis: Bland-Altman analysis of repeated-measurement bias —
 * Bland & Altman (1986) "Statistical methods for assessing agreement
 * between two methods of clinical measurement" Lancet 327:307–310. The
 * median is a robust central-tendency estimator for small samples (n=2–4)
 * relative to the mean; the 8% cap prevents a single outlier race from
 * dragging future predictions far from the model's prior. The 30s floor
 * matches the ±60 s tolerance used elsewhere in the app for "on prediction".
 */

import type { RunRaceLogEntry } from '@/types/state';
import type { RaceDistance } from '@/types/training';

export interface RunCalibration {
  /** 0 = no calibration applied (fewer than 2 races at any single distance). */
  tier: 0 | 1;
  /** Per-distance additive bias in seconds; only distances with ≥2 races and a
   *  capped bias whose absolute value exceeds the minimum-meaningful floor get
   *  an entry. Distances without an entry default to identity (no adjustment). */
  perDistanceBiasSec?: Partial<Record<RaceDistance, number>>;
  /** Number of races contributing to the calibration (sum across distances
   *  that produced a bias). Surfaced on the Calibration drill-down. */
  basedOnRaceCount: number;
  /** ISO timestamp of computation. UI surfaces "Updated 3d ago" style copy. */
  computedAtISO: string;
}

/** Cap a bias at ±8% of the median predicted leg time. */
const BIAS_CAP_PCT = 0.08;
/** Biases under this absolute threshold are treated as noise. */
const BIAS_MIN_ABS_SEC = 30;
/** Minimum logged races at a single distance for tier 1 to fire there. */
const TIER1_MIN_RACES_PER_DISTANCE = 2;

/**
 * Compute calibration from the running race log.
 *
 * Returns `{ tier: 0 }` when no distance has enough samples or all biases
 * fall under the noise floor. UI surfaces nothing when tier is 0.
 */
export function computeRunCalibration(log: ReadonlyArray<RunRaceLogEntry> | undefined): RunCalibration {
  const now = new Date().toISOString();
  if (!log || log.length === 0) {
    return { tier: 0, basedOnRaceCount: 0, computedAtISO: now };
  }

  // Group by distance and collect deltas + predicted times.
  const byDistance = new Map<RaceDistance, { delta: number; predicted: number }[]>();
  for (const entry of log) {
    if (!entry.distance || entry.predictedTotalSec <= 0 || entry.actualTotalSec <= 0) continue;
    const arr = byDistance.get(entry.distance) ?? [];
    arr.push({
      delta: entry.actualTotalSec - entry.predictedTotalSec,
      predicted: entry.predictedTotalSec,
    });
    byDistance.set(entry.distance, arr);
  }

  const perDistanceBiasSec: Partial<Record<RaceDistance, number>> = {};
  let totalRacesUsed = 0;

  for (const [distance, entries] of byDistance) {
    if (entries.length < TIER1_MIN_RACES_PER_DISTANCE) continue;
    const deltas = entries.map(e => e.delta).sort((a, b) => a - b);
    const predicteds = entries.map(e => e.predicted).sort((a, b) => a - b);
    const medianDelta = median(deltas);
    const medianPredicted = median(predicteds);
    const cap = medianPredicted * BIAS_CAP_PCT;
    const cappedBias = Math.max(-cap, Math.min(cap, medianDelta));
    if (Math.abs(cappedBias) >= BIAS_MIN_ABS_SEC) {
      perDistanceBiasSec[distance] = Math.round(cappedBias);
      totalRacesUsed += entries.length;
    }
  }

  const tier: 0 | 1 = Object.keys(perDistanceBiasSec).length > 0 ? 1 : 0;
  return {
    tier,
    perDistanceBiasSec: tier === 1 ? perDistanceBiasSec : undefined,
    basedOnRaceCount: totalRacesUsed,
    computedAtISO: now,
  };
}

/**
 * Apply the per-distance calibration bias to a predicted time in seconds.
 * Returns the original time unchanged when calibration is tier 0 or has no
 * entry for this distance. Floored at 60s so a runaway negative bias can
 * never produce a non-physical prediction.
 */
export function applyRunCalibrationBias(
  predictedSec: number,
  distance: RaceDistance | undefined,
  calibration: RunCalibration | undefined,
): number {
  if (!calibration || calibration.tier < 1 || !distance) return predictedSec;
  const bias = calibration.perDistanceBiasSec?.[distance];
  if (bias == null || bias === 0) return predictedSec;
  return Math.max(60, predictedSec + bias);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
