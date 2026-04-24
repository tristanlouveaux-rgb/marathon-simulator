/**
 * Triathlon-specific Training Stress Score (TSS) calculators.
 *
 * Swim uses cubed IF (water drag ∝ v³ per Toussaint & Beek 1992 — §18.2).
 * Bike uses squared IF (Coggan's NP/IF/TSS formulation).
 * Run keeps the existing running-TSS pipeline (not touched here).
 *
 * **Side of the line**: these calculators sit on the tracking side. They
 * describe what happened given the activity data. They are consumed by the
 * fitness model (per-discipline CTL/ATL) and by readiness/freshness views.
 */

import {
  SWIM_TSS_INTENSITY_EXPONENT,
  BIKE_TSS_INTENSITY_EXPONENT,
} from '@/constants/triathlon-constants';

// ───────────────────────────────────────────────────────────────────────────
// Swim TSS — cubed IF
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute swim TSS.
 *
 * Formula: sTSS = durationHours × IF^3 × 100
 * where IF = cssSecPer100m / avgPaceSecPer100m (faster → higher IF).
 *
 * Example: 60 min @ CSS pace → IF = 1.0 → sTSS = 1.0 × 1.0 × 100 = 100.
 */
export function computeSwimTss(params: {
  durationSec: number;
  avgPaceSecPer100m: number;
  cssSecPer100m: number;
}): number {
  const { durationSec, avgPaceSecPer100m, cssSecPer100m } = params;
  if (durationSec <= 0 || avgPaceSecPer100m <= 0 || cssSecPer100m <= 0) return 0;
  const intensity = cssSecPer100m / avgPaceSecPer100m;  // >1 = faster than threshold
  const hours = durationSec / 3600;
  return Math.round(hours * Math.pow(intensity, SWIM_TSS_INTENSITY_EXPONENT) * 100);
}

// ───────────────────────────────────────────────────────────────────────────
// Bike TSS — squared IF (power-based) with HR fallback
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute bike TSS from power.
 *
 * Formula: bTSS = durationHours × IF^2 × 100
 * IF = NP / FTP. 60 min at FTP = 100 TSS.
 */
export function computeBikeTssFromPower(params: {
  durationSec: number;
  normalisedPowerW: number;
  ftpW: number;
}): number {
  const { durationSec, normalisedPowerW, ftpW } = params;
  if (durationSec <= 0 || normalisedPowerW <= 0 || ftpW <= 0) return 0;
  const intensity = normalisedPowerW / ftpW;
  const hours = durationSec / 3600;
  return Math.round(hours * Math.pow(intensity, BIKE_TSS_INTENSITY_EXPONENT) * 100);
}

/**
 * Compute bike TSS from heart rate (fallback when no power meter).
 *
 * Uses HR reserve and LTHR as the threshold anchor. Less accurate than
 * power-based bTSS because HR lags effort in intervals, but acceptable for
 * steady-state rides.
 */
export function computeBikeTssFromHr(params: {
  durationSec: number;
  avgHrBpm: number;
  restingHrBpm: number;
  maxHrBpm: number;
  bikeLthrBpm: number;
}): number {
  const { durationSec, avgHrBpm, restingHrBpm, maxHrBpm, bikeLthrBpm } = params;
  if (durationSec <= 0 || avgHrBpm <= 0) return 0;
  const reserve = Math.max(1, maxHrBpm - restingHrBpm);
  const lthrReserve = (bikeLthrBpm - restingHrBpm) / reserve;
  const hrReserve = (avgHrBpm - restingHrBpm) / reserve;
  const intensity = hrReserve / Math.max(0.01, lthrReserve);
  const hours = durationSec / 3600;
  return Math.round(hours * Math.pow(Math.max(0, intensity), 2) * 100);
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers — rough IF estimation from pace when NP not supplied
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rough swim IF from a known CSS and average pace. Used when computing retrospective
 * TSS for a Strava swim with only pace info.
 */
export function estimateSwimIF(avgPaceSecPer100m: number, cssSecPer100m: number): number {
  if (!cssSecPer100m || !avgPaceSecPer100m) return 0;
  return cssSecPer100m / avgPaceSecPer100m;
}
