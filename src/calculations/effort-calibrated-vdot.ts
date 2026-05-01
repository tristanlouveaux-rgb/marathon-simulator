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
 * Anchors: Swain & Leutholtz 1997 (%HRR ≈ %VO2R), Daniels' VDOT tables,
 * Friel/Maffetone (drift <5% aerobic, >8% fatigued), Monod–Scherrer
 * (multi-point regression to asymptote).
 */

import { cv } from './vdot';

/** Input for a single run with HR data. */
export interface HRRunInput {
  /** ISO string or Date — used for window/recency. */
  startTime: string | Date;
  /** Distance in km. */
  distKm: number;
  /** Duration in seconds. */
  durSec: number;
  /** Average heart rate (bpm). Required for inclusion. */
  avgHR?: number | null;
  /** HR drift %: (avgHR_2nd_half − avgHR_1st_half) / avgHR_1st_half × 100.
   *  Optional — runs without drift data are still included (we can't apply
   *  the aerobic-decoupling filter, but pace+HR+duration is still usable). */
  hrDrift?: number | null;
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
const WINDOW_WEEKS = 8;
const MIN_DURATION_SEC = 20 * 60;          // <20 min: HR–pace linearity breaks (Swain domain is steady submax)
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

  type Pt = { pace: number; vo2r: number; duration: number; ageDays: number };
  const points: Pt[] = [];

  for (const r of runs) {
    if (!r.distKm || r.distKm <= 0 || !r.durSec || r.durSec < MIN_DURATION_SEC) continue;
    if (!r.avgHR || r.avgHR <= 0) continue;

    const startMs = new Date(r.startTime).getTime();
    if (!isFinite(startMs) || startMs < windowStartMs) continue;

    const pace = r.durSec / r.distKm;
    if (pace < MIN_PACE_SEC_PER_KM || pace > MAX_PACE_SEC_PER_KM) continue;

    const hrr = (r.avgHR - rhr) / (maxHR - rhr);
    if (hrr < MIN_HRR_FRACTION || hrr > MAX_HRR_FRACTION) continue;

    if (r.hrDrift != null && Math.abs(r.hrDrift) > MAX_HR_DRIFT_PCT) continue;

    points.push({
      pace,
      vo2r: hrr,
      duration: r.durSec,
      ageDays: Math.max(0, (now.getTime() - startMs) / DAY_MS),
    });
  }

  const exposedPoints = points.map(p => ({ vo2r: p.vo2r, paceSecKm: p.pace, durationSec: p.duration }));

  if (points.length < 3) {
    return { ...empty, n: points.length, reason: points.length === 0 ? 'no-points' : 'too-few-points', points: exposedPoints };
  }

  // Weighted linear regression: y (pace) on x (%VO2R), weights = duration.
  // β = Σw(x − x̄)(y − ȳ) / Σw(x − x̄)²
  // α = ȳ − β·x̄
  let sumW = 0, sumWX = 0, sumWY = 0;
  for (const p of points) {
    sumW += p.duration;
    sumWX += p.duration * p.vo2r;
    sumWY += p.duration * p.pace;
  }
  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;

  let numerator = 0, denomX = 0;
  for (const p of points) {
    const dx = p.vo2r - meanX;
    numerator += p.duration * dx * (p.pace - meanY);
    denomX   += p.duration * dx * dx;
  }

  if (denomX <= 0) return { ...empty, n: points.length, reason: 'bad-fit', points: exposedPoints };

  const beta = numerator / denomX;
  const alpha = meanY - beta * meanX;

  // Physiological sanity: effort rises → pace gets faster → pace decreases → β must be negative.
  // A non-negative β means the HR-pace relationship is inverted (noisy data, poor HR monitor,
  // or too-narrow effort range). Reject rather than emit a nonsense VDOT.
  if (beta >= 0) return { alpha, beta, vdot: null, confidence: 'none', n: points.length, r2: null, paceAtVO2max: null, reason: 'bad-fit', points: exposedPoints };

  // R² (weighted): 1 - SS_res / SS_tot
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const predicted = alpha + beta * p.vo2r;
    ssRes += p.duration * (p.pace - predicted) ** 2;
    ssTot += p.duration * (p.pace - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

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
