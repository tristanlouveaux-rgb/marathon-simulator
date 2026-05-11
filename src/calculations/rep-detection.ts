/**
 * Rep detection
 * =============
 *
 * Detects per-rep structure of an interval session from Strava laps[]
 * (preferred) or pace/power streams (fallback).
 *
 * **Side of the line**: tracking. Pure functions over raw activity data —
 * no state mutation, no plan parsing. Output (`ActivityRep[]`) feeds the
 * adherence scorer (`rep-adherence.ts`) which is the planning side.
 *
 * Two entry points:
 *   - `detectRepsFromLaps(laps, sport)` — primary path, runs on the
 *     server-side laps array Strava returns from /activities/{id}/laps.
 *   - `detectRunRepsFromStream(distData, timeData)` — fallback for runs
 *     when the user didn't press lap on their watch.
 *   - `detectBikeRepsFromPower(wattsData, timeData, distData?)` — fallback
 *     for bikes when the bike computer auto-lapped every km (uniform laps,
 *     useless for rep detection).
 *
 * **Heuristic rationale** — see SCIENCE_LOG.md "Per-rep interval analysis"
 * for the full derivation.
 *
 * The detection logic intentionally errs on the side of "no reps" rather
 * than "false-positive reps". Showing a rep table for an easy run that
 * happened to have a single fast km is a worse user experience than not
 * showing one for a real interval session.
 */

export type Sport = 'run' | 'bike' | 'swim';

export interface RawLap {
  /** Strava lap_index, 1-based. */
  lapIndex: number;
  /** Total elapsed seconds for the lap. */
  durationSec: number;
  /** Distance covered, metres. */
  distanceM: number;
  /** Average HR if Strava provided one. */
  avgHR?: number | null;
  /** Average watts (cycling). */
  avgWatts?: number | null;
}

export interface DetectedRep {
  index: number;
  distanceM: number;
  durationSec: number;
  paceSecKm: number | null;
  avgHR: number | null;
  avgWatts: number | null;
}

export interface DetectionResult {
  reps: DetectedRep[];
  source: 'strava-laps' | 'auto-detected';
}

// ─── Constants ──────────────────────────────────────────────────────────────
//
// All thresholds are documented and motivated. If you tune any of these,
// add a one-line entry to docs/SCIENCE_LOG.md "Per-rep interval analysis"
// describing why.

/** Minimum lap count to consider an activity for rep detection. <3 reps
 *  is not a meaningful "set". */
const MIN_REPS = 3;

/** Maximum rep count we'll surface. Sets >40 reps are extremely rare in
 *  endurance training (e.g. 30/30s × 40 = 40min — possible but unusual);
 *  beyond that, we're probably looking at noise from a bike computer
 *  auto-lapping every 10s during a track session. */
const MAX_REPS = 40;

/** Coefficient of variation threshold for "uniform" laps. CoV (σ/μ) below
 *  this on lap distance means every lap is essentially the same length —
 *  the hallmark of a bike computer auto-lapping every km/mile. We treat
 *  this as "no rep structure visible from laps" and fall through to
 *  stream detection. Empirical: real interval sets show CoV > 0.15 on
 *  distance because warmup/cooldown/rest laps are different lengths. */
const UNIFORM_DIST_COV = 0.08;

/** Minimum lap duration (seconds) to even consider a lap as a candidate
 *  rep. <15s laps are usually accidental lap-button presses or transition
 *  beeps from a multisport device. */
const MIN_LAP_DURATION = 15;

/** Pace gap (in standard deviations) required to separate "fast reps"
 *  from "easy/recovery laps". The detector sorts laps by pace, then
 *  finds the largest gap; reps are everything before the gap if the gap
 *  exceeds this many σ of the lap-pace distribution. 1.0σ means roughly
 *  a 16-percentile separation — generous enough to catch genuine rep
 *  structure, strict enough to reject noise. */
const REP_PACE_GAP_SIGMA = 1.0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function paceSecKm(distanceM: number, durationSec: number): number | null {
  if (distanceM <= 0 || durationSec <= 0) return null;
  return Math.round((durationSec / distanceM) * 1000);
}

/** Coefficient of variation for an array of positive numbers. */
function cov(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  if (m === 0) return 0;
  return stddev(xs) / m;
}

// ─── Lap-based detection ────────────────────────────────────────────────────

/**
 * Try to detect a clean rep cluster from Strava laps.
 *
 * Returns null when:
 *   - Fewer than MIN_REPS laps after filtering
 *   - Laps look auto-generated (uniform distance ≈ 1km/1mile)
 *   - No clear pace gap separates reps from recovery laps
 *
 * Algorithm:
 *   1. Filter out very short laps (transition beeps).
 *   2. If lap distances are uniform → auto-lap, abort.
 *   3. Sort by pace. Find the largest σ-normalised gap.
 *   4. If the gap exceeds REP_PACE_GAP_SIGMA, the laps before the gap
 *      are reps; the rest are warmup/cooldown/recovery.
 *   5. Re-sort reps back into chronological (lapIndex) order.
 */
export function detectRepsFromLaps(
  laps: RawLap[],
  sport: Sport,
): DetectionResult | null {
  const candidates = laps.filter(l =>
    l.durationSec >= MIN_LAP_DURATION &&
    l.distanceM > 0,
  );
  if (candidates.length < MIN_REPS) return null;

  // Reject uniform auto-lap (CoV on distance below threshold AND no
  // clear separation in pace either). Bike computers commonly emit
  // 1km / 5km / 1mile auto-laps; we want stream-based detection here.
  const distCov = cov(candidates.map(l => l.distanceM));
  if (distCov < UNIFORM_DIST_COV) return null;

  // Compute pace per lap. Without pace there's nothing to cluster on.
  const withPace = candidates
    .map(l => ({ lap: l, pace: paceSecKm(l.distanceM, l.durationSec) }))
    .filter(x => x.pace != null) as { lap: RawLap; pace: number }[];
  if (withPace.length < MIN_REPS) return null;

  // Sort by pace ascending (fastest first).
  const byPace = [...withPace].sort((a, b) => a.pace - b.pace);
  const paces = byPace.map(x => x.pace);
  const sd = stddev(paces);
  if (sd === 0) return null; // All laps identical — no rep cluster.

  // Find the largest gap between consecutive sorted paces. That gap, if
  // it's bigger than REP_PACE_GAP_SIGMA × σ, separates reps (left side)
  // from non-reps (right side).
  let gapIdx = -1;
  let gapSize = 0;
  for (let i = 0; i < paces.length - 1; i++) {
    const g = paces[i + 1] - paces[i];
    if (g > gapSize) { gapSize = g; gapIdx = i; }
  }
  if (gapIdx < 0) return null;
  if (gapSize < REP_PACE_GAP_SIGMA * sd) return null;

  // The reps are paces[0..gapIdx] (inclusive). Need at least MIN_REPS.
  const repCount = gapIdx + 1;
  if (repCount < MIN_REPS) return null;
  if (repCount > MAX_REPS) return null;

  const repLaps = byPace.slice(0, repCount).map(x => x.lap);
  // Re-sort into chronological order using lapIndex.
  repLaps.sort((a, b) => a.lapIndex - b.lapIndex);

  const reps: DetectedRep[] = repLaps.map((l, i) => ({
    index: i + 1,
    distanceM: Math.round(l.distanceM),
    durationSec: Math.round(l.durationSec),
    paceSecKm: paceSecKm(l.distanceM, l.durationSec),
    avgHR: l.avgHR ?? null,
    avgWatts: sport === 'bike' ? (l.avgWatts ?? null) : null,
  }));

  return { reps, source: 'strava-laps' };
}

// ─── Stream-based detection (fallback) ───────────────────────────────────────

/**
 * Detect run reps from a distance + time stream when laps weren't usable.
 *
 * Algorithm: rolling 30-second pace; baseline = median pace of moving
 * samples; reps = contiguous segments where smoothed pace is faster than
 * `baseline - REP_FAST_OFFSET_SEC_KM` for at least `MIN_REP_DURATION_SEC`.
 *
 * Pure heuristic — works for "fast intervals separated by jog recoveries"
 * which is the dominant track session shape. Misses fartlek and
 * progression sessions; that's acceptable.
 */
const REP_FAST_OFFSET_SEC_KM = 30;
const MIN_REP_DURATION_SEC = 30;
const PACE_SMOOTH_WINDOW_SEC = 30;

export function detectRunRepsFromStream(
  distData: number[],
  timeData: number[],
  hrData?: number[] | null,
): DetectionResult | null {
  if (!distData || !timeData || distData.length !== timeData.length) return null;
  if (distData.length < 60) return null;

  // Build per-sample instantaneous pace (sec/km) using PACE_SMOOTH_WINDOW
  // backwards. Samples with distance delta < 1m treated as paused and
  // assigned NaN so they don't drag the rolling avg up.
  const n = distData.length;
  const inst: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const dd = distData[i] - distData[i - 1];
    const dt = timeData[i] - timeData[i - 1];
    if (dd > 0.5 && dt > 0) inst[i] = (dt / dd) * 1000;
  }

  // Rolling-window smoothed pace (sec/km).
  const smooth: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let dSum = 0, tSum = 0;
    for (let j = i; j >= 0; j--) {
      const back = timeData[i] - timeData[j];
      if (back > PACE_SMOOTH_WINDOW_SEC) break;
      const dd = j > 0 ? distData[j] - distData[j - 1] : 0;
      const dt = j > 0 ? timeData[j] - timeData[j - 1] : 0;
      if (dd > 0 && dt > 0) { dSum += dd; tSum += dt; }
    }
    if (dSum >= 5 && tSum > 0) smooth[i] = (tSum / dSum) * 1000;
  }

  // Median of moving samples → baseline.
  const sorted = smooth.filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  if (sorted.length < 30) return null;
  const baseline = sorted[Math.floor(sorted.length / 2)];
  const threshold = baseline - REP_FAST_OFFSET_SEC_KM;

  // Walk the smoothed series, accumulate contiguous segments below
  // threshold. Each segment that exceeds MIN_REP_DURATION_SEC is a rep.
  type Seg = { startIdx: number; endIdx: number };
  const segs: Seg[] = [];
  let inSeg = false;
  let segStart = -1;
  for (let i = 0; i < n; i++) {
    const p = smooth[i];
    const fast = p != null && p < threshold;
    if (fast && !inSeg) { inSeg = true; segStart = i; }
    if (!fast && inSeg) {
      inSeg = false;
      if (segStart >= 0) segs.push({ startIdx: segStart, endIdx: i - 1 });
    }
  }
  if (inSeg && segStart >= 0) segs.push({ startIdx: segStart, endIdx: n - 1 });

  // Filter segments by duration.
  const validSegs = segs.filter(s => timeData[s.endIdx] - timeData[s.startIdx] >= MIN_REP_DURATION_SEC);
  if (validSegs.length < MIN_REPS) return null;
  if (validSegs.length > MAX_REPS) return null;

  const reps: DetectedRep[] = validSegs.map((s, i) => {
    const distanceM = Math.max(0, distData[s.endIdx] - distData[s.startIdx]);
    const durationSec = Math.max(0, timeData[s.endIdx] - timeData[s.startIdx]);
    let avgHR: number | null = null;
    if (hrData && hrData.length === n) {
      let sum = 0, ct = 0;
      for (let k = s.startIdx; k <= s.endIdx; k++) {
        if (hrData[k] > 0) { sum += hrData[k]; ct++; }
      }
      if (ct > 0) avgHR = Math.round(sum / ct);
    }
    return {
      index: i + 1,
      distanceM: Math.round(distanceM),
      durationSec: Math.round(durationSec),
      paceSecKm: paceSecKm(distanceM, durationSec),
      avgHR,
      avgWatts: null,
    };
  });

  return { reps, source: 'auto-detected' };
}

/**
 * Detect bike reps from a watts stream.
 *
 * Algorithm: rolling 10s power; baseline = median of moving samples;
 * threshold = max(baseline + 50W, baseline × 1.4); reps = contiguous
 * segments above threshold for at least MIN_REP_DURATION_SEC.
 *
 * Power is a much cleaner rep signal than pace because it has near-zero
 * lag and step changes are sharp at transitions. Works well for "5×5min
 * @ FTP" structure; less reliable for short 30/30s where smoothing window
 * smears boundaries.
 */
const POWER_SMOOTH_WINDOW_SEC = 10;
const POWER_REP_OFFSET_W = 50;
const POWER_REP_RATIO = 1.4;

export function detectBikeRepsFromPower(
  wattsData: number[],
  timeData: number[],
  distData?: number[] | null,
  hrData?: number[] | null,
): DetectionResult | null {
  if (!wattsData || !timeData || wattsData.length !== timeData.length) return null;
  if (wattsData.length < 60) return null;

  const n = wattsData.length;

  // Rolling smoothed watts.
  const smooth: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0, ct = 0;
    for (let j = i; j >= 0; j--) {
      const back = timeData[i] - timeData[j];
      if (back > POWER_SMOOTH_WINDOW_SEC) break;
      sum += wattsData[j];
      ct++;
    }
    smooth[i] = ct > 0 ? sum / ct : 0;
  }

  // Median over moving samples.
  const sorted = smooth.filter(v => v > 0).sort((a, b) => a - b);
  if (sorted.length < 30) return null;
  const baseline = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(baseline + POWER_REP_OFFSET_W, baseline * POWER_REP_RATIO);

  type Seg = { startIdx: number; endIdx: number };
  const segs: Seg[] = [];
  let inSeg = false, segStart = -1;
  for (let i = 0; i < n; i++) {
    const above = smooth[i] >= threshold;
    if (above && !inSeg) { inSeg = true; segStart = i; }
    if (!above && inSeg) {
      inSeg = false;
      if (segStart >= 0) segs.push({ startIdx: segStart, endIdx: i - 1 });
    }
  }
  if (inSeg && segStart >= 0) segs.push({ startIdx: segStart, endIdx: n - 1 });

  const validSegs = segs.filter(s => timeData[s.endIdx] - timeData[s.startIdx] >= MIN_REP_DURATION_SEC);
  if (validSegs.length < MIN_REPS) return null;
  if (validSegs.length > MAX_REPS) return null;

  const reps: DetectedRep[] = validSegs.map((s, i) => {
    const durationSec = Math.max(0, timeData[s.endIdx] - timeData[s.startIdx]);
    const distanceM = distData && distData.length === n
      ? Math.max(0, distData[s.endIdx] - distData[s.startIdx])
      : 0;
    let sumW = 0, ctW = 0;
    for (let k = s.startIdx; k <= s.endIdx; k++) {
      if (wattsData[k] > 0) { sumW += wattsData[k]; ctW++; }
    }
    const avgWatts = ctW > 0 ? Math.round(sumW / ctW) : null;
    let avgHR: number | null = null;
    if (hrData && hrData.length === n) {
      let sumH = 0, ctH = 0;
      for (let k = s.startIdx; k <= s.endIdx; k++) {
        if (hrData[k] > 0) { sumH += hrData[k]; ctH++; }
      }
      if (ctH > 0) avgHR = Math.round(sumH / ctH);
    }
    return {
      index: i + 1,
      distanceM: Math.round(distanceM),
      durationSec: Math.round(durationSec),
      paceSecKm: paceSecKm(distanceM, durationSec),
      avgHR,
      avgWatts,
    };
  });

  return { reps, source: 'auto-detected' };
}

// ─── HR-only stream detection (treadmill / no-power fallback) ───────────────

/**
 * Detect interval reps from a heart-rate stream alone — used when neither
 * a pace stream (treadmill run, indoor cycling without GPS) nor a power
 * stream (no paired meter) is available.
 *
 * Why HR alone is harder than pace/power:
 *   - HR lags pace/power by 30–60s on transitions (cardiac response time).
 *   - Drift over long runs can creep HR upward without any interval cue.
 *   - Recovery between short reps (< 60s) doesn't drop HR enough to detect a
 *     boundary — short-rep sessions register as one continuous plateau.
 *
 * Algorithm:
 *   1. Smooth HR with a 60s rolling mean (longer than pace's 30s — HR is
 *      slower-moving so over-smoothing isn't a concern, and we want to
 *      reject 5–10s sensor noise).
 *   2. Baseline = median of the FIRST 10 minutes (post warm-up onset).
 *      Using the first 10min instead of the whole-session median avoids
 *      letting a long high-HR interval cluster shift the baseline upward
 *      and make the threshold unreachable.
 *   3. Peak = 95th percentile of smoothed HR (drops single-sample outliers).
 *   4. Threshold = baseline + (peak − baseline) × 0.55. Halfway-plus —
 *      captures full work intervals while excluding warm-up climbs and
 *      moderate steady efforts.
 *   5. Hard floor: peak − baseline must exceed `MIN_HR_SPREAD_BPM` (15 bpm),
 *      otherwise the run is too uniform to contain reps (likely an easy or
 *      tempo session) and we return null.
 *   6. Reps = contiguous segments where smoothed HR is above threshold for
 *      at least `MIN_HR_REP_DURATION_SEC` (90s). Longer than the pace
 *      detector's 30s minimum because HR's lag-in / lag-out tails extend the
 *      apparent rep boundaries.
 *
 * Suitable for: long-interval sessions (4×4min, 5×5min @ threshold,
 * 3×8min, hill repeats). Misses: short bursts (< 60s reps), fartlek with
 * irregular boundaries, progressive runs.
 */
const HR_SMOOTH_WINDOW_SEC = 60;
const HR_BASELINE_WINDOW_SEC = 10 * 60;
const HR_THRESHOLD_FRAC = 0.55;
const MIN_HR_SPREAD_BPM = 15;
const MIN_HR_REP_DURATION_SEC = 90;

export function detectRepsFromHRStream(
  hrData: number[],
  timeData: number[],
): DetectionResult | null {
  if (!hrData || !timeData || hrData.length !== timeData.length) return null;
  if (hrData.length < 60) return null;

  const n = hrData.length;
  const totalSec = timeData[n - 1] - timeData[0];
  if (totalSec < 5 * 60) return null; // < 5 min is too short to contain ≥3 reps

  // Smooth HR with a 60s backwards-looking rolling mean. Skips invalid samples
  // (HR <= 0 or > 240) so a sensor dropout doesn't drag the smoothed line down.
  const smooth: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i; j >= 0; j--) {
      const back = timeData[i] - timeData[j];
      if (back > HR_SMOOTH_WINDOW_SEC) break;
      const hr = hrData[j];
      if (hr > 30 && hr <= 240) {
        sum += hr;
        count++;
      }
    }
    if (count >= 5) smooth[i] = sum / count;
  }

  // Baseline = median of smoothed values in the first 10 min only — keeps
  // long mid-session intervals from inflating the baseline above their own
  // working HR.
  const t0 = timeData[0];
  const earlyValues: number[] = [];
  for (let i = 0; i < n; i++) {
    if (timeData[i] - t0 > HR_BASELINE_WINDOW_SEC) break;
    if (smooth[i] != null) earlyValues.push(smooth[i] as number);
  }
  if (earlyValues.length < 30) return null;
  earlyValues.sort((a, b) => a - b);
  const baseline = earlyValues[Math.floor(earlyValues.length / 2)];

  // Peak = 95th percentile across the whole session (rejects single-sample spikes).
  const allValid = smooth.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (allValid.length < 30) return null;
  const peak = allValid[Math.floor(allValid.length * 0.95)];

  // Spread gate: too-uniform sessions can't contain reps.
  if (peak - baseline < MIN_HR_SPREAD_BPM) return null;

  const threshold = baseline + (peak - baseline) * HR_THRESHOLD_FRAC;

  // Walk the smoothed series, accumulate contiguous above-threshold segments.
  type Seg = { startIdx: number; endIdx: number };
  const segs: Seg[] = [];
  let inSeg = false;
  let segStart = -1;
  for (let i = 0; i < n; i++) {
    const v = smooth[i];
    const high = v != null && v >= threshold;
    if (high && !inSeg) { inSeg = true; segStart = i; }
    if (!high && inSeg) {
      inSeg = false;
      if (segStart >= 0) segs.push({ startIdx: segStart, endIdx: i - 1 });
    }
  }
  if (inSeg && segStart >= 0) segs.push({ startIdx: segStart, endIdx: n - 1 });

  const validSegs = segs.filter(s =>
    timeData[s.endIdx] - timeData[s.startIdx] >= MIN_HR_REP_DURATION_SEC,
  );
  if (validSegs.length < MIN_REPS || validSegs.length > MAX_REPS) return null;

  const reps: DetectedRep[] = validSegs.map((s, i) => {
    let sum = 0;
    let count = 0;
    for (let k = s.startIdx; k <= s.endIdx; k++) {
      if (hrData[k] > 30 && hrData[k] <= 240) {
        sum += hrData[k];
        count++;
      }
    }
    const avgHR = count > 0 ? Math.round(sum / count) : null;
    return {
      index: i + 1,
      distanceM: 0,    // unknown without a distance stream
      durationSec: Math.round(timeData[s.endIdx] - timeData[s.startIdx]),
      paceSecKm: null, // unknown without a distance stream
      avgHR,
      avgWatts: null,
    };
  });

  return { reps, source: 'auto-detected' };
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────

export interface DetectionInputs {
  laps?: RawLap[] | null;
  /** For run streams. */
  distData?: number[] | null;
  timeData?: number[] | null;
  hrData?: number[] | null;
  /** For bike stream fallback. */
  wattsData?: number[] | null;
}

/**
 * Top-level entry point. Tries the right detector for the sport, falling
 * back through laps → stream as appropriate.
 *
 * Sport-specific routing (Tristan 2026-05-05):
 *   - run: laps first; stream fallback (most users have lap-aware watches)
 *   - bike: bike laps are noisy (auto-1km is the common default), so we
 *     prefer the power stream when watts data is present, falling back
 *     to laps only when no watts stream available.
 */
export function detectReps(
  sport: Sport,
  inputs: DetectionInputs,
): DetectionResult | null {
  if (sport === 'bike') {
    // Power stream is the most reliable bike rep signal — promote it
    // above laps[].
    if (inputs.wattsData && inputs.timeData) {
      const r = detectBikeRepsFromPower(
        inputs.wattsData, inputs.timeData,
        inputs.distData ?? null, inputs.hrData ?? null,
      );
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    if (inputs.laps && inputs.laps.length >= MIN_REPS) {
      const r = detectRepsFromLaps(inputs.laps, 'bike');
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    // HR-only fallback for trainer rides without power. Only catches long
    // reps (≥ 90s) — short on/off intervals can't be detected from HR alone.
    if (inputs.hrData && inputs.timeData) {
      const r = detectRepsFromHRStream(inputs.hrData, inputs.timeData);
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    return null;
  }

  if (sport === 'run') {
    if (inputs.laps && inputs.laps.length >= MIN_REPS) {
      const r = detectRepsFromLaps(inputs.laps, 'run');
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    if (inputs.distData && inputs.timeData) {
      const r = detectRunRepsFromStream(
        inputs.distData, inputs.timeData, inputs.hrData ?? null,
      );
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    // HR-only fallback for treadmill / no-GPS runs. Same long-rep limitation
    // as the bike branch — works for 5×5min and 4×4min, not for short reps.
    if (inputs.hrData && inputs.timeData) {
      const r = detectRepsFromHRStream(inputs.hrData, inputs.timeData);
      if (r && r.reps.length >= MIN_REPS) return r;
    }
    return null;
  }

  // Swim is out of scope for v1.
  return null;
}
