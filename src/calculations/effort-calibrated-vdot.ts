/**
 * Effort-Calibrated VDOT — current-fitness estimate from the last 8 weeks of
 * running, anchored on HR response to pace. Complements Tanda (volume+pace)
 * and the PB ceiling in `blendPredictions`.
 *
 * Method (see docs/SCIENCE_LOG.md → "Effort-Calibrated VDOT from HR"):
 *   For each qualifying run i:
 *     %VO2R_i = (avgHR_i − RHR) / (maxHR − RHR)         // Swain & Leutholtz 1997
 *     point_i = (avgPace_i, %VO2R_i, duration_i)
 *   Weighted linear regression (weights = duration):
 *     pace = α + β · %VO2R
 *     paceAtVO2max = α + β · 1.0
 *     VDOT_HR      = cv(3200, paceAtVO2max × 3.2)       // Daniels vVO2max ≈ 2-mile race pace
 *
 * Qualifying filter: duration ≥ 20 min, HR drift < 8% (aerobic decoupling),
 * valid avgHR + RHR + maxHR, pace in [3:00–7:30/km]. If RHR is absent we do
 * NOT fabricate a default — we return null and the blend falls back to
 * Tanda/hard-effort/PB.
 *
 * Outlier removal: after the initial fit, any point whose residual exceeds
 * 2.5 standard deviations is removed and the regression is refit. This catches
 * efforts like bonked long runs (high avgHR from fade, slow avgPace) without
 * needing to know the activity type. One pass only; uses unweighted residual
 * std so that long-duration runs don't define their own outlier threshold.
 *
 * Anchors: Swain & Leutholtz 1997 (%HRR ≈ %VO2R), Daniels' VDOT tables,
 * Friel/Maffetone (drift <5% aerobic, >8% fatigued), Monod–Scherrer
 * (multi-point regression to asymptote).
 */

import { cv } from './vdot';

/** Input for a single (pace, HR) sample — either a whole run averaged into
 *  one point, or a within-run segment (per-km from Strava splits_metric, per
 *  lap, etc.). The function applies different qualifying filters per kind:
 *
 *  - **Run-level** (`isSegment` falsy): duration ≥ 20 min, hrDrift gate
 *    (steady-state proxy), pace/HRR gates. This is the legacy mode.
 *  - **Segment-level** (`isSegment = true`): duration ≥ 60 s (one km ≈ 3-6
 *    min), pace/HRR gates only — drift is a whole-run property and is
 *    measured by the caller before emitting segments. Segments from the
 *    same run are independent (pace, HR) points spanning the run's HRR
 *    range, dramatically expanding coverage compared to one averaged-out
 *    point per run. */
export interface HRRunInput {
  /** ISO string or Date — used for window/recency. For segments, this is
   *  the segment's own start time (or the parent run's start time when
   *  per-segment timestamps are unavailable; the window filter is
   *  conservative either way). */
  startTime: string | Date;
  /** Distance in km. */
  distKm: number;
  /** Duration in seconds. */
  durSec: number;
  /** Average heart rate (bpm). Required for inclusion. */
  avgHR?: number | null;
  /** HR drift %: (avgHR_2nd_half − avgHR_1st_half) / avgHR_1st_half × 100.
   *  Run-level only. Optional — runs without drift data are still included
   *  (we can't apply the aerobic-decoupling filter, but pace+HR+duration
   *  is still usable). Ignored when `isSegment` is true. */
  hrDrift?: number | null;
  /** Marks this entry as a within-run segment (e.g. one km of a long run)
   *  rather than a full run averaged into one point. Drives different
   *  qualifying filters — see the interface doc above. */
  isSegment?: boolean;
}

export interface HRVdotResult {
  /** Estimated VDOT at 100% VO2R, or null if insufficient data. */
  vdot: number | null;
  /** Confidence tier based on N + R². */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Number of qualifying points used in the regression. */
  n: number;
  /** Coefficient of determination (weighted). Null when <2 points. */
  r2: number | null;
  /** Regression coefficients — pace = α + β × %VO2R. Null when insufficient data. */
  alpha: number | null;
  beta: number | null;
  /** Predicted pace at %VO2R = 1.0, in sec/km. Null if regression failed. */
  paceAtVO2max: number | null;
  /** Reason for skipping, when vdot is null. */
  reason?: 'no-rhr' | 'no-maxhr' | 'no-points' | 'bad-fit' | 'too-few-points';
  /** Qualifying points used in the regression — exposed so the onboarding
   *  review screen can render an HR-vs-pace scatter without re-running the fit. */
  points?: Array<{ vo2r: number; paceSecKm: number; durationSec: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type Pt = { pace: number; vo2r: number; duration: number; ageDays: number };

/** Weighted linear regression of pace on %VO2R (weights = duration).
 *  Returns null when the fit is degenerate (collinear or too few points). */
function fitWeightedRegression(pts: Pt[]): { alpha: number; beta: number; r2: number } | null {
  if (pts.length < 3) return null;
  let sumW = 0, sumWX = 0, sumWY = 0;
  for (const p of pts) { sumW += p.duration; sumWX += p.duration * p.vo2r; sumWY += p.duration * p.pace; }
  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;
  let num = 0, den = 0;
  for (const p of pts) { const dx = p.vo2r - meanX; num += p.duration * dx * (p.pace - meanY); den += p.duration * dx * dx; }
  if (den <= 0) return null;
  const beta = num / den;
  const alpha = meanY - beta * meanX;
  let ssRes = 0, ssTot = 0;
  for (const p of pts) { const pred = alpha + beta * p.vo2r; ssRes += p.duration * (p.pace - pred) ** 2; ssTot += p.duration * (p.pace - meanY) ** 2; }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { alpha, beta, r2 };
}

const WINDOW_WEEKS = 8;
const MIN_DURATION_SEC = 20 * 60;          // <20 min: HR–pace linearity breaks (Swain domain is steady submax)
const MIN_SEGMENT_DURATION_SEC = 60;       // Per-segment floor (1km ≈ 3-6 min; warmup/transition < 60s gets noisy)
const MAX_HR_DRIFT_PCT = 8;                // Friel 5% aerobic, 8% = upper bound before supra-threshold
const MIN_PACE_SEC_PER_KM = 180;           // 3:00/km — faster = interval artefact
const MAX_PACE_SEC_PER_KM = 450;           // 7:30/km — slower = walk
const MIN_HRR_FRACTION = 0.40;             // Swain validated ≥40% HRR
const MAX_HRR_FRACTION = 0.95;             // Beyond this, HR plateaus (cardiac output ceiling)

/**
 * Compute effort-calibrated VDOT from recent runs + physiology.
 *
 * Pure function — no state dependency, fully testable.
 *
 * @param runs    Recent run activities (any window; function filters to 8w).
 * @param rhr     Resting heart rate (bpm). If null/undefined, returns null.
 * @param maxHR   Maximum heart rate (bpm). If null/undefined, returns null.
 * @param now     Anchor time for the 8-week window. Defaults to current time.
 */
export function computeHRCalibratedVdot(
  runs: HRRunInput[],
  rhr: number | null | undefined,
  maxHR: number | null | undefined,
  now: Date = new Date(),
): HRVdotResult {
  const empty: HRVdotResult = {
    vdot: null, confidence: 'none', n: 0, r2: null,
    alpha: null, beta: null, paceAtVO2max: null,
  };

  if (!rhr || rhr <= 0) return { ...empty, reason: 'no-rhr' };
  if (!maxHR || maxHR <= 0 || maxHR <= rhr) return { ...empty, reason: 'no-maxhr' };
  if (!runs || runs.length === 0) return { ...empty, reason: 'no-points' };

  const windowStartMs = now.getTime() - WINDOW_WEEKS * 7 * DAY_MS;

  const points: Pt[] = [];

  for (const r of runs) {
    if (!r.distKm || r.distKm <= 0 || !r.durSec) continue;
    if (!r.avgHR || r.avgHR <= 0) continue;

    // Duration gate depends on input kind. Run-level samples need ≥ 20 min
    // for HR-pace linearity; per-segment samples (e.g. one km of a long run)
    // only need ≥ 60 s so a fast tempo km isn't rejected as too short.
    const minDuration = r.isSegment ? MIN_SEGMENT_DURATION_SEC : MIN_DURATION_SEC;
    if (r.durSec < minDuration) continue;

    const startMs = new Date(r.startTime).getTime();
    if (!isFinite(startMs) || startMs < windowStartMs) continue;

    const pace = r.durSec / r.distKm;
    if (pace < MIN_PACE_SEC_PER_KM || pace > MAX_PACE_SEC_PER_KM) continue;

    const hrr = (r.avgHR - rhr) / (maxHR - rhr);
    if (hrr < MIN_HRR_FRACTION || hrr > MAX_HRR_FRACTION) continue;

    // HR drift is a whole-run aerobic-decoupling signal; not meaningful for
    // a sub-run segment, so we only gate run-level samples on it.
    if (!r.isSegment && r.hrDrift != null && Math.abs(r.hrDrift) > MAX_HR_DRIFT_PCT) continue;

    points.push({
      pace,
      vo2r: hrr,
      duration: r.durSec,
      ageDays: Math.max(0, (now.getTime() - startMs) / DAY_MS),
    });
  }

  if (points.length < 3) {
    const exp = points.map(p => ({ vo2r: p.vo2r, paceSecKm: p.pace, durationSec: p.duration }));
    return { ...empty, n: points.length, reason: points.length === 0 ? 'no-points' : 'too-few-points', points: exp };
  }

  // Initial weighted regression.
  let fit = fitWeightedRegression(points);
  if (!fit) return { ...empty, n: points.length, reason: 'bad-fit' };

  // Outlier removal via leave-one-out. σ-based detection masks itself when N
  // is small because the outlier inflates std. LOO directly finds the single
  // point whose removal most improves R²; if the gain is ≥ 0.25 we remove it
  // and refit. One point removed per call, one pass only.
  if (fit.r2 < 0.6 && points.length >= 4) {
    let bestGain = 0.25; // minimum gain to justify removing a point
    let bestIdx = -1;
    for (let i = 0; i < points.length; i++) {
      const subset = points.filter((_, j) => j !== i);
      const f = fitWeightedRegression(subset);
      if (f && f.r2 - fit.r2 > bestGain) { bestGain = f.r2 - fit.r2; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      points.splice(bestIdx, 1);
      fit = fitWeightedRegression(points) ?? fit;
    }
  }

  const { alpha, beta, r2 } = fit;
  const exposedPoints = points.map(p => ({ vo2r: p.vo2r, paceSecKm: p.pace, durationSec: p.duration }));

  // Physiological sanity: β must be negative (higher effort → faster pace → lower sec/km).
  if (beta >= 0) return { alpha, beta, vdot: null, confidence: 'none', n: points.length, r2: null, paceAtVO2max: null, reason: 'bad-fit', points: exposedPoints };

  // Reject weak fits — R² < 0.25 means the pace–HR relationship is too noisy
  // to trust the extrapolation to 100% HRR even after outlier removal.
  if (r2 < 0.25) {
    return { alpha, beta, vdot: null, confidence: 'none', n: points.length, r2, paceAtVO2max: null, reason: 'bad-fit', points: exposedPoints };
  }

  const paceAtVO2max = alpha + beta * 1.0;
  if (paceAtVO2max < MIN_PACE_SEC_PER_KM * 0.8 || paceAtVO2max > MAX_PACE_SEC_PER_KM) {
    // Extrapolation produced nonsense (e.g. 1:30/km or 10:00/km). Safer to return null.
    return { alpha, beta, vdot: null, confidence: 'none', n: points.length, r2, paceAtVO2max, reason: 'bad-fit', points: exposedPoints };
  }

  // Convert pace at vVO2max → VDOT via Daniels:
  // vVO2max ≈ pace sustainable for a 2-mile (3200 m) race (~6–11 min for most runners).
  // VDOT is then `cv(3200, paceAtVO2max × 3.2)`.
  const vdot = cv(3200, paceAtVO2max * 3.2);

  let confidence: HRVdotResult['confidence'] = 'low';
  if (points.length >= 8 && r2 >= 0.7) confidence = 'high';
  else if (points.length >= 4 && r2 >= 0.5) confidence = 'medium';

  return { vdot, confidence, n: points.length, r2, alpha, beta, paceAtVO2max, points: exposedPoints };
}
