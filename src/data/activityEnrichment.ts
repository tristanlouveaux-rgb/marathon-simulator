/**
 * Shared activity enrichment helpers.
 *
 * Extracted from appleHealthSync.ts so the same computation logic can be
 * consumed by:
 *   - appleHealthSync.ts (Apple HealthKit workouts)
 *   - fitImport.ts (single-file FIT / GPX / TCX import)
 *   - (future) Garmin activityDetails parser (item A of STRAVALESS_PLAN.md)
 *
 * All functions are pure. They take plain data arrays and return plain
 * objects. No HealthKit, no Capacitor, no state reads.
 */

import { calculateITrimp } from '@/calculations/trimp';
import { calculateZones, type HRZones } from '@/calculations/heart-rate';
import type { ActivityRepData } from '@/types/state';

// ---------------------------------------------------------------------------
// Re-exports so callers only need one import path
// ---------------------------------------------------------------------------

export { calculateZones };
export type { HRZones };

// ---------------------------------------------------------------------------
// Shared enrichment result shape
// ---------------------------------------------------------------------------

/**
 * Enriched fields derived from per-second HR / power / GPS streams.
 * Mirrors the HRWorkoutEnrichment interface used internally by
 * appleHealthSync.ts. Kept here as the canonical definition; both
 * appleHealthSync and fitImport reference it.
 */
export interface ActivityStreamEnrichment {
  avgHR: number;
  maxHR: number;
  iTrimp: number | null;
  hrZones: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  polyline?: string | null;
  kmSplits?: number[] | null;
  /** best_efforts array (synthetic) for PB extraction */
  bestEfforts?: Array<{
    name: string;
    distance: number;
    elapsed_time: number;
    pr_rank?: number | null;
    achievements?: any[];
  }> | null;
  averageWatts?: number | null;
  maxWatts?: number | null;
  normalizedPowerW?: number | null;
  powerCurve?: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
  repData?: ActivityRepData | null;
}

// ---------------------------------------------------------------------------
// Core enrichment helpers
// ---------------------------------------------------------------------------

/**
 * Reduce raw HR value + time-offset arrays into avg/max/iTRIMP/zones.
 * Returns null when the sample set has fewer than 2 valid points.
 *
 * - HR values outside [30, 240] bpm are dropped (sensor artefact gate).
 * - Sample-to-sample gaps over 5 min are excluded from zone accounting and
 *   iTRIMP integration so paused-workout gaps don't inflate load.
 */
export function computeHREnrichment(
  hrValues: number[],
  timeOffsets: number[],
  restingHR: number | null,
  userMaxHR: number | null,
  zones: HRZones | undefined,
  sex: 'male' | 'female' | undefined,
): Pick<ActivityStreamEnrichment, 'avgHR' | 'maxHR' | 'iTrimp' | 'hrZones'> | null {
  const filteredHR: number[] = [];
  const filteredTime: number[] = [];
  let sum = 0;
  let observedMax = 0;

  for (let i = 0; i < hrValues.length; i++) {
    const bpm = hrValues[i];
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) continue;
    const t = timeOffsets[i];
    if (!Number.isFinite(t) || t < 0) continue;
    filteredHR.push(bpm);
    filteredTime.push(t);
    sum += bpm;
    if (bpm > observedMax) observedMax = bpm;
  }
  if (filteredHR.length < 2) return null;

  const avgHR = Math.round(sum / filteredHR.length);
  const maxHR = Math.round(observedMax);

  let iTrimp: number | null = null;
  if (restingHR && userMaxHR && userMaxHR > restingHR) {
    const computed = calculateITrimp(filteredHR, filteredTime, restingHR, userMaxHR, sex);
    if (computed > 0) iTrimp = Math.round(computed);
  }

  let hrZones: ActivityStreamEnrichment['hrZones'] = null;
  if (zones) {
    const z = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    for (let i = 1; i < filteredHR.length; i++) {
      const dt = filteredTime[i] - filteredTime[i - 1];
      if (dt <= 0 || dt > 300) continue; // skip pause-gaps
      const bpm = filteredHR[i];
      if (bpm < zones.z2.min) z.z1 += dt;
      else if (bpm < zones.z3.min) z.z2 += dt;
      else if (bpm < zones.z4.min) z.z3 += dt;
      else if (bpm < zones.z5.min) z.z4 += dt;
      else z.z5 += dt;
    }
    hrZones = {
      z1: Math.round(z.z1),
      z2: Math.round(z.z2),
      z3: Math.round(z.z3),
      z4: Math.round(z.z4),
      z5: Math.round(z.z5),
    };
  }

  return { avgHR, maxHR, iTrimp, hrZones };
}

// ---------------------------------------------------------------------------
// Power helpers
// ---------------------------------------------------------------------------

/** Generic power sample shape (timestamp + watts). */
export interface PowerSample {
  value: number;
  /** ISO-8601 timestamp or numeric epoch ms */
  startDate: string;
}

/**
 * Aggregate average + peak from a power-sample array.
 * Both null when the array is empty or all values fail the sanity gate.
 */
export function computePowerStats(
  samples: PowerSample[],
): { avg: number | null; max: number | null } {
  if (!samples || samples.length === 0) return { avg: null, max: null };
  let sum = 0;
  let count = 0;
  let max = 0;
  for (const s of samples) {
    const w = s.value;
    if (!Number.isFinite(w) || w < 0 || w > 2000) continue;
    sum += w;
    count++;
    if (w > max) max = w;
  }
  if (count === 0) return { avg: null, max: null };
  return { avg: Math.round(sum / count), max: Math.round(max) };
}

/**
 * Derive normalized power (NP) and a mean-max power curve from a
 * variable-rate watts stream. Matches the Strava edge-function shape so the
 * FTP estimator's primary `powerCurve top-1 within 12 weeks` path works for
 * any imported bike file.
 *
 * Algorithm:
 *   1. Resample stream to uniform 1 Hz via linear interpolation.
 *   2. NP = (mean(rolling30s^4))^(1/4). Coggan's normalised power formula.
 *   3. powerCurve.pW = max W mean over all sliding windows of that size.
 */
export function computeNPAndPowerCurve(
  samples: PowerSample[],
): {
  normalizedPowerW: number | null;
  powerCurve: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
} {
  if (samples.length < 30) return { normalizedPowerW: null, powerCurve: null };

  const t0 = new Date(samples[0].startDate).getTime();
  const times = samples.map(s => (new Date(s.startDate).getTime() - t0) / 1000);
  const watts = samples.map(s => Math.max(0, Math.min(2000, s.value)));
  const totalSec = Math.floor(times[times.length - 1]);
  if (totalSec < 60) return { normalizedPowerW: null, powerCurve: null };

  // Resample to uniform 1 Hz via linear interpolation between adjacent samples.
  const hz = new Array<number>(totalSec + 1).fill(0);
  let j = 0;
  for (let s = 0; s <= totalSec; s++) {
    while (j + 1 < times.length && times[j + 1] <= s) j++;
    const tA = times[j];
    const tB = j + 1 < times.length ? times[j + 1] : tA;
    if (tA === tB) {
      hz[s] = watts[j];
    } else {
      const frac = (s - tA) / (tB - tA);
      hz[s] = watts[j] + Math.max(0, Math.min(1, frac)) * (watts[j + 1] - watts[j]);
    }
  }

  // 30-sec rolling mean (boxcar). Coggan's NP uses a 30s smoothing window.
  const NP_WINDOW = 30;
  const rolling = new Array<number>(hz.length).fill(0);
  let sumWin = 0;
  for (let i = 0; i < hz.length; i++) {
    sumWin += hz[i];
    if (i >= NP_WINDOW) sumWin -= hz[i - NP_WINDOW];
    rolling[i] = i >= NP_WINDOW - 1 ? sumWin / NP_WINDOW : sumWin / (i + 1);
  }

  // NP = (mean(rolling^4))^(1/4) over samples where the 30s window is full.
  let sum4 = 0;
  let n4 = 0;
  for (let i = NP_WINDOW - 1; i < rolling.length; i++) {
    const r = rolling[i];
    if (r > 0) { sum4 += r * r * r * r; n4++; }
  }
  const np = n4 > 0 ? Math.round(Math.pow(sum4 / n4, 0.25)) : null;

  // Mean-max for each window size. Sliding-sum O(n) per window.
  const meanMax = (windowSec: number): number | null => {
    if (hz.length < windowSec) return null;
    let sum = 0;
    for (let i = 0; i < windowSec; i++) sum += hz[i];
    let max = sum;
    for (let i = windowSec; i < hz.length; i++) {
      sum += hz[i] - hz[i - windowSec];
      if (sum > max) max = sum;
    }
    return Math.round(max / windowSec);
  };

  const powerCurve = {
    p600: meanMax(600),
    p1200: meanMax(1200),
    p1800: meanMax(1800),
    p3600: meanMax(3600),
  };
  const hasAnyWindow = Object.values(powerCurve).some(v => v != null);

  return { normalizedPowerW: np, powerCurve: hasAnyWindow ? powerCurve : null };
}

// ---------------------------------------------------------------------------
// Tanaka maxHR resolver (mirrors the logic in appleHealthSync.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve a working maxHR for iTRIMP integration. Priority:
 *   1. Explicit user-set maxHR from state.
 *   2. Tanaka formula: 208 - 0.7 × age (Tanaka et al. 2001, valid 18-80y).
 *   3. null → iTRIMP stays null, healMissingITrimp recovers later.
 */
export function resolveMaxHR(
  userMaxHR: number | null | undefined,
  age: number | null | undefined,
): number | null {
  if (userMaxHR && userMaxHR > 0) return userMaxHR;
  if (age && age >= 14 && age <= 90) return Math.round(208 - 0.7 * age);
  return null;
}

// ---------------------------------------------------------------------------
// Splits from a speed stream (no GPS route required)
// ---------------------------------------------------------------------------

/** A speed sample: instantaneous speed (m/s) at a timestamp. */
export interface SpeedSample {
  /** metres per second */
  value: number;
  /** ISO-8601 timestamp or epoch-ms string */
  startDate: string;
}

/**
 * Compute per-kilometre split times (seconds per km) from a speed sample
 * stream, without any GPS route. This is the fallback for sources that write a
 * speed series to HealthKit but NOT a `HKWorkoutRoute`. Notably Garmin Connect
 * via the Apple Health bridge, which drops the GPS route but may still write
 * `runningSpeed` / `cyclingSpeed` samples.
 *
 * Method: trapezoidal integration of speed over time gives cumulative distance;
 * we then find the elapsed time at each 1 km boundary and difference them, the
 * identical km-boundary extraction `extractKmSplits` (appleHealthRoute.ts) uses
 * on GPS-derived distance, so the output format matches exactly (number[] of
 * per-km durations in seconds).
 *
 * `knownTotalM` (the workout's reported total distance, when available) scales
 * the integrated distance to match, correcting systematic speed-integration
 * drift so the km markers land in the right place.
 *
 * Gaps over 5 min between samples are treated as pauses and accrue no distance.
 * Returns [] when there are fewer than 2 samples or under 1 km of distance.
 */
export function computeSplitsFromSpeed(samples: SpeedSample[], knownTotalM?: number): number[] {
  if (!samples || samples.length < 2) return [];

  const t0 = new Date(samples[0].startDate).getTime();
  const elapsed: number[] = [0];
  const cum: number[] = [0];
  let dist = 0;

  for (let i = 1; i < samples.length; i++) {
    const tCur = (new Date(samples[i].startDate).getTime() - t0) / 1000;
    const tPrev = (new Date(samples[i - 1].startDate).getTime() - t0) / 1000;
    let dt = tCur - tPrev;
    if (Number.isFinite(dt) && dt > 0 && dt <= 300) {
      const vPrev = Math.max(0, samples[i - 1].value);
      const vCur = Math.max(0, samples[i].value);
      dist += ((vPrev + vCur) / 2) * dt; // trapezoidal: avg speed × elapsed
    }
    elapsed.push(Number.isFinite(tCur) ? tCur : elapsed[elapsed.length - 1]);
    cum.push(dist);
  }

  // Anchor the integrated distance to the workout's true total when known.
  if (knownTotalM && knownTotalM > 0 && dist > 0) {
    const scale = knownTotalM / dist;
    for (let i = 0; i < cum.length; i++) cum[i] *= scale;
    dist *= scale;
  }

  const totalKm = Math.floor(dist / 1000);
  if (totalKm < 1) return [];

  const splits: number[] = [];
  let lastKmTime = 0;
  for (let kmTarget = 1; kmTarget <= totalKm; kmTarget++) {
    const targetM = kmTarget * 1000;
    let idx = 1;
    while (idx < cum.length && cum[idx] < targetM) idx++;
    if (idx >= cum.length) break;
    const prevCum = cum[idx - 1];
    const segDist = cum[idx] - prevCum;
    const segTime = elapsed[idx] - elapsed[idx - 1];
    const frac = segDist > 0 ? (targetM - prevCum) / segDist : 0;
    const tAtKm = elapsed[idx - 1] + frac * segTime;
    splits.push(Math.round(tAtKm - lastKmTime));
    lastKmTime = tAtKm;
  }
  return splits;
}
