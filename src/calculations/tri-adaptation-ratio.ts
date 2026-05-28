/**
 * Per-discipline adaptation ratio. How fast the athlete is actually responding
 * to training, vs the population-average gain the horizon adjuster predicts.
 *
 * Five signals:
 *   1. HRV trend (global, all three disciplines)
 *   2. RPE-vs-expected (per discipline)
 *   3. HR-at-power (bike only)
 *   4. Pa:Hr decoupling (bike + run)
 *   5. CSS pace SD (swim only)
 *
 * Each signal yields a `[-cap, +cap]` ratio adjustment. Per-discipline
 * weighted blend → final ratio in `[ADAPT_RATIO_MIN, ADAPT_RATIO_MAX]`.
 *
 * **Side of the line**: tracking. Pure functions over state; no mutation.
 *
 * Full rationale + citations in `docs/SCIENCE_LOG.md` §K.
 */

import type { SimulatorState } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { classifyActivity } from './tri-benchmarks-from-history';
import {
  ADAPT_CAP_HRV, ADAPT_CAP_RPE, ADAPT_CAP_HR_AT_POWER, ADAPT_CAP_PAHR, ADAPT_CAP_CSS_SD,
  ADAPT_HRV_SENSITIVITY, ADAPT_RPE_SENSITIVITY, ADAPT_HR_POWER_SENSITIVITY,
  ADAPT_PAHR_SENSITIVITY, ADAPT_CSS_SD_SENSITIVITY,
  ADAPT_WEIGHTS_SWIM, ADAPT_WEIGHTS_BIKE, ADAPT_WEIGHTS_RUN,
  ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  HRV_SHORT_DAYS, HRV_LONG_DAYS,
  RPE_LOOKBACK_SESSIONS, HR_AT_POWER_WEEKS, PAHR_WEEKS, CSS_SD_WEEKS,
} from '@/constants/triathlon-adaptation-params';

export interface TriAdaptationRatios {
  swim: number;
  bike: number;
  run: number;
  signals: {
    hrv: number | null;
    rpeSwim: number | null;
    rpeBike: number | null;
    rpeRun: number | null;
    hrAtPower: number | null;
    pahrBike: number | null;
    pahrRun: number | null;
    cssSd: number | null;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Signal 1. HRV trend
// ───────────────────────────────────────────────────────────────────────────

function hrvAdjustment(state: SimulatorState): number | null {
  const hist = state.physiologyHistory ?? [];
  const withHrv = hist.filter(d => d.hrvRmssd != null && d.hrvRmssd > 0);
  if (withHrv.length < HRV_SHORT_DAYS) return null;
  const recent = withHrv.slice(-HRV_SHORT_DAYS);
  const longWindow = withHrv.slice(-HRV_LONG_DAYS);
  if (longWindow.length < HRV_SHORT_DAYS) return null;
  const hrv7d  = mean(recent.map(d => d.hrvRmssd!));
  const hrv28d = mean(longWindow.map(d => d.hrvRmssd!));
  if (hrv28d <= 0) return null;
  const hrvDelta = (hrv7d - hrv28d) / hrv28d;
  return clamp(hrvDelta * ADAPT_HRV_SENSITIVITY, -ADAPT_CAP_HRV, ADAPT_CAP_HRV);
}

// ───────────────────────────────────────────────────────────────────────────
// Signal 2. RPE vs expected (per discipline)
// ───────────────────────────────────────────────────────────────────────────

function rpeAdjustment(state: SimulatorState, discipline: Discipline): number | null {
  const samples: number[] = [];
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  // Walk backwards collecting completed-of-discipline sessions until we have enough.
  outer: for (let w = currentWeek; w >= 0 && samples.length < RPE_LOOKBACK_SESSIONS; w--) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    for (const workout of wk.triWorkouts) {
      if ((workout.discipline ?? 'run') !== discipline) continue;
      const expected = (workout as { rpe?: number }).rpe ?? workout.r;
      if (expected == null) continue;

      // Look up actual RPE from wk.rated[id]. Skip-rated entries are not
      // useful for the adaptation signal (no perceived-effort data).
      let actual: number | undefined;
      if (workout.id && wk.rated) {
        const r = wk.rated[workout.id];
        if (typeof r === 'number') actual = r;
      }
      if (actual == null) continue;

      samples.push(expected - actual);
      if (samples.length >= RPE_LOOKBACK_SESSIONS) break outer;
    }
  }
  if (samples.length < 2) return null;
  const meanDelta = mean(samples);
  return clamp(meanDelta * ADAPT_RPE_SENSITIVITY, -ADAPT_CAP_RPE, ADAPT_CAP_RPE);
}

// ───────────────────────────────────────────────────────────────────────────
// Signal 3. HR-at-power (bike only)
// ───────────────────────────────────────────────────────────────────────────

function hrAtPowerAdjustment(state: SimulatorState): number | null {
  const ftp = state.triConfig?.bike?.ftp;
  if (ftp == null || ftp <= 0) return null;

  // Per-week HR at tempo intensity (avgWatts in [0.80, 0.95] × FTP).
  const perWeek: { week: number; meanHr: number }[] = [];
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - HR_AT_POWER_WEEKS);

  for (let w = currentWeek; w >= startWeek; w--) {
    const wk = wks[w];
    if (!wk?.garminActuals) continue;
    const hrs: number[] = [];
    for (const actual of Object.values(wk.garminActuals)) {
      if (classifyActivity(actual.activityType) !== 'bike') continue;
      if (actual.avgHR == null || actual.avgHR <= 0) continue;
      if (actual.averageWatts == null || actual.averageWatts <= 0) continue;
      const if_ = actual.averageWatts / ftp;
      if (if_ < 0.80 || if_ > 0.95) continue;
      if (actual.durationSec < 30 * 60) continue;
      hrs.push(actual.avgHR);
    }
    if (hrs.length > 0) perWeek.push({ week: w, meanHr: mean(hrs) });
  }
  if (perWeek.length < 3) return null;

  // Linear regression: HR ~ weekIndex (older = lower index).
  // Convert week to index from oldest (so positive slope = HR rising = bad).
  const slope = linearSlope(
    perWeek.map((p, i) => ({ x: perWeek.length - 1 - i, y: p.meanHr })),
  );
  if (slope == null) return null;
  // Slope is bpm/week; negative = improving. Adjustment = -slope × sensitivity.
  return clamp(-slope * ADAPT_HR_POWER_SENSITIVITY, -ADAPT_CAP_HR_AT_POWER, ADAPT_CAP_HR_AT_POWER);
}

// ───────────────────────────────────────────────────────────────────────────
// Signal 4. Pa:Hr decoupling (bike + run)
// ───────────────────────────────────────────────────────────────────────────

/** Friel EF (efficiency-factor) decoupling for a single run, from parallel
 *  per-km pace + HR splits.
 *
 *  Per km: EF_i = (1 / paceSecKm_i) / hr_i  (proportional to speed / HR).
 *  Decoupling% = (firstHalfMeanEF − secondHalfMeanEF) / firstHalfMeanEF × 100.
 *  Positive = decoupling (efficiency fell over the run, bad).
 *  Negative = coupling (efficiency improved, good).
 *
 *  Returns null when fewer than 4 valid (paceSecKm > 0, hr > 0) kms exist.
 *  Friel/Uphill Athlete benchmark: <5% = aerobic steady state. */
export function efDecouplingPct(
  kmSplits: number[] | null | undefined,
  kmHRSplits: number[] | null | undefined,
): number | null {
  if (!kmSplits || !kmHRSplits) return null;
  const n = Math.min(kmSplits.length, kmHRSplits.length);
  const efs: number[] = [];
  for (let i = 0; i < n; i++) {
    const pace = kmSplits[i];
    const hr = kmHRSplits[i];
    if (!pace || pace <= 0) continue;
    if (!hr || hr <= 0) continue;
    efs.push((1 / pace) / hr);
  }
  if (efs.length < 4) return null;
  const half = Math.floor(efs.length / 2);
  const firstEF = mean(efs.slice(0, half));
  const secondEF = mean(efs.slice(half));
  if (firstEF <= 0) return null;
  return ((firstEF - secondEF) / firstEF) * 100;
}

function pahrAdjustment(state: SimulatorState, discipline: 'bike' | 'run'): number | null {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - PAHR_WEEKS);

  const perWeek: { week: number; meanDecoup: number }[] = [];
  for (let w = currentWeek; w >= startWeek; w--) {
    const wk = wks[w];
    if (!wk?.garminActuals) continue;
    const decoups: number[] = [];
    for (const actual of Object.values(wk.garminActuals)) {
      if (classifyActivity(actual.activityType) !== discipline) continue;
      if (actual.durationSec < 45 * 60) continue;

      // Prefer true Pa:Hr from per-km pace + HR splits (runs only. Strava
      // splits_metric / HR stream populate kmHRSplits in the ingest path).
      // Fall back to hrDrift (HR-only first/second half) when per-km HR is
      // not available. Bike actuals and pre-ingest-upgrade runs.
      const efDecoup = discipline === 'run'
        ? efDecouplingPct(actual.kmSplits, actual.kmHRSplits)
        : null;
      const decoup = efDecoup ?? actual.hrDrift;
      if (decoup == null) continue;
      decoups.push(decoup);
    }
    if (decoups.length > 0) perWeek.push({ week: w, meanDecoup: mean(decoups) });
  }
  if (perWeek.length < 3) return null;

  const slope = linearSlope(
    perWeek.map((p, i) => ({ x: perWeek.length - 1 - i, y: p.meanDecoup })),
  );
  if (slope == null) return null;
  // Negative slope = decoupling shrinking = improving. Adjustment = -slope × sensitivity.
  return clamp(-slope * ADAPT_PAHR_SENSITIVITY, -ADAPT_CAP_PAHR, ADAPT_CAP_PAHR);
}

// ───────────────────────────────────────────────────────────────────────────
// Signal 5. CSS pace SD (swim only)
// ───────────────────────────────────────────────────────────────────────────

function cssSdAdjustment(state: SimulatorState): number | null {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - CSS_SD_WEEKS);

  const perWeek: { week: number; meanSd: number }[] = [];
  for (let w = currentWeek; w >= startWeek; w--) {
    const wk = wks[w];
    if (!wk?.triWorkouts || !wk.garminActuals) continue;

    // Only threshold swims contribute.
    const thresholdWorkoutIds = new Set(
      wk.triWorkouts
        .filter(workout => (workout.discipline ?? 'run') === 'swim' && /threshold/.test(workout.t))
        .map(workout => workout.id)
        .filter((x): x is string => !!x),
    );

    const sds: number[] = [];
    for (const [id, actual] of Object.entries(wk.garminActuals)) {
      if (!thresholdWorkoutIds.has(id)) continue;
      if (!actual.kmSplits || actual.kmSplits.length < 3) continue;
      sds.push(stdDev(actual.kmSplits));
    }
    if (sds.length > 0) perWeek.push({ week: w, meanSd: mean(sds) });
  }
  if (perWeek.length < 3) return null;

  const slope = linearSlope(
    perWeek.map((p, i) => ({ x: perWeek.length - 1 - i, y: p.meanSd })),
  );
  if (slope == null) return null;
  // Negative slope = SD shrinking = improving.
  return clamp(-slope * ADAPT_CSS_SD_SENSITIVITY, -ADAPT_CAP_CSS_SD, ADAPT_CAP_CSS_SD);
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level
// ───────────────────────────────────────────────────────────────────────────

export function computeTriAdaptationRatios(state: SimulatorState): TriAdaptationRatios {
  const hrv = hrvAdjustment(state);
  const rpeSwim = rpeAdjustment(state, 'swim');
  const rpeBike = rpeAdjustment(state, 'bike');
  const rpeRun  = rpeAdjustment(state, 'run');
  const hrAtPower = hrAtPowerAdjustment(state);
  const pahrBike = pahrAdjustment(state, 'bike');
  const pahrRun  = pahrAdjustment(state, 'run');
  const cssSd = cssSdAdjustment(state);

  // Per-discipline blend. `n` (signal value) defaults to 0 when null (neutral).
  const swim = clamp(
    1 +
      ADAPT_WEIGHTS_SWIM.hrv   * (hrv ?? 0) +
      ADAPT_WEIGHTS_SWIM.rpe   * (rpeSwim ?? 0) +
      ADAPT_WEIGHTS_SWIM.cssSd * (cssSd ?? 0),
    ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  );
  const bike = clamp(
    1 +
      ADAPT_WEIGHTS_BIKE.hrv       * (hrv ?? 0) +
      ADAPT_WEIGHTS_BIKE.rpe       * (rpeBike ?? 0) +
      ADAPT_WEIGHTS_BIKE.hrAtPower * (hrAtPower ?? 0) +
      ADAPT_WEIGHTS_BIKE.pahr      * (pahrBike ?? 0),
    ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  );
  const run = clamp(
    1 +
      ADAPT_WEIGHTS_RUN.hrv  * (hrv ?? 0) +
      ADAPT_WEIGHTS_RUN.rpe  * (rpeRun ?? 0) +
      ADAPT_WEIGHTS_RUN.pahr * (pahrRun ?? 0),
    ADAPT_RATIO_MIN, ADAPT_RATIO_MAX,
  );

  return {
    swim, bike, run,
    signals: { hrv, rpeSwim, rpeBike, rpeRun, hrAtPower, pahrBike, pahrRun, cssSd },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Math helpers
// ───────────────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / (xs.length - 1));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Simple OLS slope over `{x,y}` points. Null if degenerate. */
function linearSlope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const meanX = mean(points.map(p => p.x));
  const meanY = mean(points.map(p => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) * (p.x - meanX);
  }
  if (den === 0) return null;
  return num / den;
}
