/**
 * Empirical course factors (Tier B calibration).
 *
 * For each race location, compute a swim/bike/run factor where:
 *   factor = (location's mean leg time) / (reference mean leg time)
 *
 * Factor > 1.0 → slower than typical (hard course: hills, current, heat).
 * Factor < 1.0 → faster than typical (flat, fast water, cool weather).
 *
 * **The athlete-quality problem.** Different races attract different athlete
 * pools — Worlds is faster than a regional race not because the course is
 * easier but because the field is talented. We need to net out talent:
 *
 *   - IM data has `athleteID` → athlete fixed effects: each athlete's relative
 *     pace at race L vs their own multi-race average. Most credible signal.
 *
 *   - 70.3 data has no athlete ID → age-group × gender stratification:
 *     compare the race's mean 40-44M time to the global mean 40-44M time,
 *     then average across all age/gender buckets present at the race.
 *     Less precise but still meaningful.
 *
 * **Output shape**: a JSON map keyed by location string, consumed at runtime
 * by the predictor in `race-prediction.triathlon.ts`. Each entry has a
 * confidence flag so the predictor can fall back to hand-tuned course factors
 * when the empirical signal is thin.
 */

import type { FinishRecord, Distance } from './dataset-loader';

// ───────────────────────────────────────────────────────────────────────────
// Output shape
// ───────────────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low' | 'insufficient';

export interface CourseFactors {
  swimFactor: number;
  bikeFactor: number;
  runFactor: number;
  /** Number of finishes underlying this estimate. */
  n: number;
  confidence: Confidence;
  /** True if any of swim/bike/run hit the sanity clamp [0.75, 1.40]. Indicates
   *  data error (course shortened, weather cancellation, swim non-wetsuit) —
   *  runtime treats clamped entries as unreliable and drops them from the
   *  empirical lookup. Predictor falls back to physical model. */
  clamped?: boolean;
  /** Which time-window the factor was computed from:
   *   - 'recent':  last RECENCY_WINDOW_YEARS years (catches course revisions)
   *   - 'allTime': full dataset (fallback when recent data is thin)
   *  Era is decided at calibration time by `RECENT_PREFERRED_MIN_N`. */
  era?: 'recent' | 'allTime';
}

/** Recency window for the "recent" factor variant — last 5 years. Captures
 *  course revisions (e.g., Frankfurt's bike course redesign) without being
 *  so short that COVID-disrupted years dominate. */
export const RECENCY_WINDOW_YEARS = 5;

/**
 * Years excluded from per-location aggregation (both all-time and recent
 * windows). 2020 and 2021 are excluded because COVID-era cancellations,
 * postponements, and capacity limits produced atypical fields that bias
 * course factors — e.g., Kona 2021 (cancelled), Frankfurt 2020 (cancelled),
 * races with 30–50% typical field size inflating per-athlete ratios.
 *
 * Per-athlete and global-bucket baselines (fixed effects) are NOT filtered —
 * an athlete who raced in those years is still a valid baseline source.
 * Only the per-location accumulation (the thing we're trying to estimate)
 * is filtered, since that's where the unusual field composition bites.
 */
export const EXCLUDED_YEARS: ReadonlySet<number> = new Set([2020, 2021]);

/** Minimum recent-window sample to prefer recent over all-time. Below this,
 *  fall back to all-time so we don't ship a noisy three-finisher factor. */
export const RECENT_PREFERRED_MIN_N = 200;

export interface CourseFactorTable {
  distance: Distance;
  /** Reference mean times (denominator of the factor). Stored for transparency. */
  referenceSwimSec: number;
  referenceBikeSec: number;
  referenceRunSec: number;
  factors: Record<string, CourseFactors>;
}

// ───────────────────────────────────────────────────────────────────────────
// Confidence tiers
// ───────────────────────────────────────────────────────────────────────────

function classifyConfidence(n: number): Confidence {
  if (n >= 1000) return 'high';
  if (n >= 200)  return 'medium';
  if (n >= 50)   return 'low';
  return 'insufficient';
}

// ───────────────────────────────────────────────────────────────────────────
// Sanity caps — we'd rather flag than ship factors that are obviously wrong
// (data error, course-shortened, weather cancellation).
// ───────────────────────────────────────────────────────────────────────────

const MIN_PLAUSIBLE_FACTOR = 0.75;
const MAX_PLAUSIBLE_FACTOR = 1.40;

function clampOrFlag(f: number, label: string): { value: number; flagged: boolean } {
  if (f < MIN_PLAUSIBLE_FACTOR || f > MAX_PLAUSIBLE_FACTOR) {
    return { value: Math.max(MIN_PLAUSIBLE_FACTOR, Math.min(MAX_PLAUSIBLE_FACTOR, f)), flagged: true };
  }
  return { value: f, flagged: false };
}

// ───────────────────────────────────────────────────────────────────────────
// IM: athlete fixed-effects estimator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build per-location course factors from IM data using athlete fixed effects.
 *
 * For each athlete who has raced at multiple locations, compute their pace at
 * each location relative to their own all-races mean. Then average those
 * relative paces across all athletes who raced at a given location. This
 * removes the field-talent bias.
 *
 * Athletes with only one race contribute nothing to the calibration (no
 * within-athlete contrast available); they're dropped silently.
 */
function buildIMCourseFactors(records: FinishRecord[]): CourseFactorTable {
  // Pass 1: per-athlete sums (only athletes that appear in IM records).
  // ALL records contribute to the athlete's personal baseline — recency
  // filtering applies only to the location aggregation, so athletes' multi-
  // race average stays stable.
  interface AthleteAcc {
    swimSum: number; bikeSum: number; runSum: number; n: number;
  }
  const perAthlete = new Map<string, AthleteAcc>();
  for (const r of records) {
    if (r.distance !== 'ironman' || !r.athleteId) continue;
    let a = perAthlete.get(r.athleteId);
    if (!a) {
      a = { swimSum: 0, bikeSum: 0, runSum: 0, n: 0 };
      perAthlete.set(r.athleteId, a);
    }
    a.swimSum += r.swimSec;
    a.bikeSum += r.bikeSec;
    a.runSum  += r.runSec;
    a.n++;
  }

  // Pass 2: per-location accumulation. Build TWO maps simultaneously — one
  // for all-time records, one for the last RECENCY_WINDOW_YEARS only.
  interface LocAcc {
    swimRatioSum: number; bikeRatioSum: number; runRatioSum: number; n: number;
  }
  const perLocAllTime = new Map<string, LocAcc>();
  const perLocRecent  = new Map<string, LocAcc>();

  // Cutoff year = latest year in dataset minus the window. Computed from
  // records so the boundary moves automatically when new data lands.
  let latestYear = 0;
  for (const r of records) {
    if (r.distance === 'ironman' && r.eventYear > latestYear) latestYear = r.eventYear;
  }
  const recentCutoff = latestYear - RECENCY_WINDOW_YEARS;

  for (const r of records) {
    if (r.distance !== 'ironman' || !r.athleteId) continue;
    if (EXCLUDED_YEARS.has(r.eventYear)) continue;
    const a = perAthlete.get(r.athleteId);
    if (!a || a.n < 2) continue; // need ≥ 2 races for fixed effects
    const aSwim = a.swimSum / a.n;
    const aBike = a.bikeSum / a.n;
    const aRun  = a.runSum  / a.n;
    if (aSwim <= 0 || aBike <= 0 || aRun <= 0) continue;

    const dSwim = r.swimSec / aSwim;
    const dBike = r.bikeSec / aBike;
    const dRun  = r.runSec  / aRun;

    let lA = perLocAllTime.get(r.eventLocation);
    if (!lA) {
      lA = { swimRatioSum: 0, bikeRatioSum: 0, runRatioSum: 0, n: 0 };
      perLocAllTime.set(r.eventLocation, lA);
    }
    lA.swimRatioSum += dSwim; lA.bikeRatioSum += dBike; lA.runRatioSum += dRun; lA.n++;

    if (r.eventYear >= recentCutoff) {
      let lR = perLocRecent.get(r.eventLocation);
      if (!lR) {
        lR = { swimRatioSum: 0, bikeRatioSum: 0, runRatioSum: 0, n: 0 };
        perLocRecent.set(r.eventLocation, lR);
      }
      lR.swimRatioSum += dSwim; lR.bikeRatioSum += dBike; lR.runRatioSum += dRun; lR.n++;
    }
  }

  // Reference pace for transparency only (factors are self-normalised).
  let globalSwimSum = 0, globalBikeSum = 0, globalRunSum = 0, globalN = 0;
  for (const r of records) {
    if (r.distance !== 'ironman') continue;
    globalSwimSum += r.swimSec;
    globalBikeSum += r.bikeSec;
    globalRunSum  += r.runSec;
    globalN++;
  }

  const factors: Record<string, CourseFactors> = {};
  for (const [loc, lAll] of perLocAllTime.entries()) {
    if (lAll.n === 0) continue;
    // Prefer recent if it has enough sample (≥ RECENT_PREFERRED_MIN_N).
    // Otherwise fall back to all-time.
    const lRec = perLocRecent.get(loc);
    const useRecent = (lRec?.n ?? 0) >= RECENT_PREFERRED_MIN_N;
    const chosen = useRecent ? lRec! : lAll;
    const conf = classifyConfidence(chosen.n);
    if (conf === 'insufficient') continue;
    const swR = clampOrFlag(chosen.swimRatioSum / chosen.n, `${loc} swim`);
    const bkR = clampOrFlag(chosen.bikeRatioSum / chosen.n, `${loc} bike`);
    const rnR = clampOrFlag(chosen.runRatioSum  / chosen.n, `${loc} run`);
    const clamped = swR.flagged || bkR.flagged || rnR.flagged;
    factors[loc] = {
      swimFactor: swR.value, bikeFactor: bkR.value, runFactor: rnR.value,
      n: chosen.n,
      confidence: conf,
      era: useRecent ? 'recent' : 'allTime',
      ...(clamped ? { clamped: true } : {}),
    };
  }

  return {
    distance: 'ironman',
    referenceSwimSec: globalSwimSum / Math.max(1, globalN),
    referenceBikeSec: globalBikeSum / Math.max(1, globalN),
    referenceRunSec:  globalRunSum  / Math.max(1, globalN),
    factors,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 70.3: age-group × gender stratified estimator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build per-location course factors from 70.3 data using age-group × gender
 * stratification. The 70.3 dataset has no athlete ID, so we can't do true
 * fixed effects — instead we compute a per-bucket reference and average.
 *
 *   For bucket b (e.g., 40-44M):
 *     globalMean_b   = mean leg time across all 70.3 finishers in b
 *     locationMean_b = mean leg time at location L for finishers in b
 *     ratio_b        = locationMean_b / globalMean_b
 *
 *   factor(L) = mean of ratio_b across all buckets b with ≥ MIN_BUCKET_N
 *               finishers at L
 *
 * Buckets with too few finishers (< MIN_BUCKET_N) are dropped to avoid
 * single-finisher buckets dragging the ratio.
 */
const MIN_BUCKET_N = 10;

function buildHalfCourseFactors(records: FinishRecord[]): CourseFactorTable {
  interface BucketAcc { swim: number; bike: number; run: number; n: number; }
  const bucketKey = (r: FinishRecord): string => `${r.gender}:${r.ageGroup}`;

  // Cutoff year for recent variant — moves with the dataset.
  let latestYear = 0;
  for (const r of records) {
    if (r.distance === '70.3' && r.eventYear > latestYear) latestYear = r.eventYear;
  }
  const recentCutoff = latestYear - RECENCY_WINDOW_YEARS;

  // Step 1: global per-bucket means. Computed across ALL years — the bucket
  // reference (e.g., "global mean bike time for M40-44") is a stable
  // baseline. Recency filtering applies only to per-location aggregation.
  const globalBuckets = new Map<string, BucketAcc>();
  for (const r of records) {
    if (r.distance !== '70.3') continue;
    const k = bucketKey(r);
    let b = globalBuckets.get(k);
    if (!b) { b = { swim: 0, bike: 0, run: 0, n: 0 }; globalBuckets.set(k, b); }
    b.swim += r.swimSec; b.bike += r.bikeSec; b.run += r.runSec; b.n++;
  }
  const globalBucketMean = new Map<string, { swim: number; bike: number; run: number }>();
  for (const [k, b] of globalBuckets.entries()) {
    if (b.n < MIN_BUCKET_N) continue;
    globalBucketMean.set(k, { swim: b.swim / b.n, bike: b.bike / b.n, run: b.run / b.n });
  }

  // Step 2: per-location per-bucket means. Build TWO maps in parallel —
  // all-time and recent-only.
  const locBucketsAllTime = new Map<string, Map<string, BucketAcc>>();
  const locBucketsRecent  = new Map<string, Map<string, BucketAcc>>();
  const addTo = (
    map: Map<string, Map<string, BucketAcc>>,
    loc: string, k: string, r: FinishRecord,
  ): void => {
    let perLoc = map.get(loc);
    if (!perLoc) { perLoc = new Map(); map.set(loc, perLoc); }
    let b = perLoc.get(k);
    if (!b) { b = { swim: 0, bike: 0, run: 0, n: 0 }; perLoc.set(k, b); }
    b.swim += r.swimSec; b.bike += r.bikeSec; b.run += r.runSec; b.n++;
  };
  for (const r of records) {
    if (r.distance !== '70.3') continue;
    if (EXCLUDED_YEARS.has(r.eventYear)) continue;
    const k = bucketKey(r);
    addTo(locBucketsAllTime, r.eventLocation, k, r);
    if (r.eventYear >= recentCutoff) addTo(locBucketsRecent, r.eventLocation, k, r);
  }

  // Step 3: build factors from a per-location bucket map.
  const aggregateLoc = (buckets: Map<string, BucketAcc>): { swim: number; bike: number; run: number; n: number; contrib: number } | null => {
    let swimSum = 0, bikeSum = 0, runSum = 0, contributingBuckets = 0, totalN = 0;
    for (const [k, b] of buckets.entries()) {
      if (b.n < MIN_BUCKET_N) continue;
      const g = globalBucketMean.get(k);
      if (!g) continue;
      swimSum += (b.swim / b.n) / g.swim;
      bikeSum += (b.bike / b.n) / g.bike;
      runSum  += (b.run  / b.n) / g.run;
      contributingBuckets++;
      totalN += b.n;
    }
    if (contributingBuckets === 0) return null;
    return { swim: swimSum, bike: bikeSum, run: runSum, n: totalN, contrib: contributingBuckets };
  };

  const factors: Record<string, CourseFactors> = {};
  for (const [loc, bucketsAll] of locBucketsAllTime.entries()) {
    const aAll = aggregateLoc(bucketsAll);
    if (!aAll) continue;
    const aRec = locBucketsRecent.has(loc) ? aggregateLoc(locBucketsRecent.get(loc)!) : null;
    const useRecent = aRec != null && aRec.n >= RECENT_PREFERRED_MIN_N;
    const chosen = useRecent ? aRec! : aAll;
    const conf = classifyConfidence(chosen.n);
    if (conf === 'insufficient') continue;
    const swR = clampOrFlag(chosen.swim / chosen.contrib, `${loc} swim`);
    const bkR = clampOrFlag(chosen.bike / chosen.contrib, `${loc} bike`);
    const rnR = clampOrFlag(chosen.run  / chosen.contrib, `${loc} run`);
    const clamped = swR.flagged || bkR.flagged || rnR.flagged;
    factors[loc] = {
      swimFactor: swR.value, bikeFactor: bkR.value, runFactor: rnR.value,
      n: chosen.n,
      confidence: conf,
      era: useRecent ? 'recent' : 'allTime',
      ...(clamped ? { clamped: true } : {}),
    };
  }

  // Reference (overall) means for transparency.
  let globalSwim = 0, globalBike = 0, globalRun = 0, globalN = 0;
  for (const r of records) {
    if (r.distance !== '70.3') continue;
    globalSwim += r.swimSec; globalBike += r.bikeSec; globalRun += r.runSec; globalN++;
  }

  return {
    distance: '70.3',
    referenceSwimSec: globalSwim / Math.max(1, globalN),
    referenceBikeSec: globalBike / Math.max(1, globalN),
    referenceRunSec:  globalRun  / Math.max(1, globalN),
    factors,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry
// ───────────────────────────────────────────────────────────────────────────

export function buildCourseFactors(
  distance: Distance,
  records: FinishRecord[],
): CourseFactorTable {
  return distance === 'ironman'
    ? buildIMCourseFactors(records)
    : buildHalfCourseFactors(records);
}
