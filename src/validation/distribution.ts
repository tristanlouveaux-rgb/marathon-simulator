/**
 * Split-distribution analysis (Tier A calibration).
 *
 * For each total-time bin (15-min bins for 70.3, 30-min for IM), compute the
 * mean and SD of each leg's *fraction* of total finish time. This gives us
 * an empirical bound on what realistic splits look like at any given total
 * finish — useful for sanity-checking a model prediction without needing to
 * know the athlete's training history.
 *
 * **Why fractions, not absolute times.** A 5:00 70.3 always has roughly the
 * same swim/bike/run *proportion* (because pace + distance is fixed); the
 * absolute splits scale with total time. Storing fractions rather than
 * absolute times means one table covers the full range of finishers without
 * needing per-pace-tier sub-tables.
 *
 * Output: `validation/output/split-distributions.json` — checked in,
 * consumed at runtime by the prediction-validator.
 */

import type { FinishRecord, Distance } from './dataset-loader';

// ───────────────────────────────────────────────────────────────────────────
// Bin definitions
// ───────────────────────────────────────────────────────────────────────────

/** 15-min bins for 70.3 spanning 4:00 → 8:00. */
const BIN_703_WIDTH_SEC = 15 * 60;
const BIN_703_MIN_SEC = 4 * 3600;
const BIN_703_MAX_SEC = 8 * 3600;

/** 30-min bins for IM spanning 9:00 → 17:00. */
const BIN_IM_WIDTH_SEC = 30 * 60;
const BIN_IM_MIN_SEC = 9 * 3600;
const BIN_IM_MAX_SEC = 17 * 3600;

/** Minimum bin size for reliable mean/SD estimates. */
const MIN_BIN_N = 30;

function binCenter(distance: Distance, totalSec: number): number | null {
  const w = distance === 'ironman' ? BIN_IM_WIDTH_SEC : BIN_703_WIDTH_SEC;
  const min = distance === 'ironman' ? BIN_IM_MIN_SEC : BIN_703_MIN_SEC;
  const max = distance === 'ironman' ? BIN_IM_MAX_SEC : BIN_703_MAX_SEC;
  if (totalSec < min || totalSec > max) return null;
  const idx = Math.floor((totalSec - min) / w);
  return min + idx * w + w / 2;
}

// ───────────────────────────────────────────────────────────────────────────
// Bin statistics
// ───────────────────────────────────────────────────────────────────────────

interface BinAccumulator {
  n: number;
  swimSum: number; swimSumSq: number;
  bikeSum: number; bikeSumSq: number;
  runSum:  number; runSumSq: number;
}

export interface BinStats {
  /** Centre of the total-time bin in seconds. */
  centerSec: number;
  /** Number of finishers in this bin. */
  n: number;
  /** Mean fraction of total time spent on swim leg (e.g., 0.105 = 10.5%). */
  swimFracMean: number; swimFracSD: number;
  bikeFracMean: number; bikeFracSD: number;
  runFracMean:  number; runFracSD:  number;
}

export interface DistributionTable {
  distance: Distance;
  /** Sample size used to build the table. */
  totalRecords: number;
  /** Min finishers required per bin. */
  minBinN: number;
  bins: BinStats[];
}

/**
 * Compute the per-bin distribution table for a set of records. Records
 * outside the binning range are silently dropped; bins below `minBinN` are
 * also dropped (low sample size → unstable mean/SD).
 */
export function buildDistribution(
  distance: Distance,
  records: FinishRecord[],
): DistributionTable {
  const accs = new Map<number, BinAccumulator>();
  for (const r of records) {
    const c = binCenter(distance, r.finishSec);
    if (c == null) continue;
    let acc = accs.get(c);
    if (!acc) {
      acc = { n: 0, swimSum: 0, swimSumSq: 0, bikeSum: 0, bikeSumSq: 0, runSum: 0, runSumSq: 0 };
      accs.set(c, acc);
    }
    const fSwim = r.swimSec / r.finishSec;
    const fBike = r.bikeSec / r.finishSec;
    const fRun  = r.runSec  / r.finishSec;
    acc.n++;
    acc.swimSum += fSwim; acc.swimSumSq += fSwim * fSwim;
    acc.bikeSum += fBike; acc.bikeSumSq += fBike * fBike;
    acc.runSum  += fRun;  acc.runSumSq  += fRun  * fRun;
  }

  const bins: BinStats[] = [];
  const sortedCenters = [...accs.keys()].sort((a, b) => a - b);
  for (const c of sortedCenters) {
    const a = accs.get(c)!;
    if (a.n < MIN_BIN_N) continue;
    const swimMean = a.swimSum / a.n;
    const bikeMean = a.bikeSum / a.n;
    const runMean  = a.runSum  / a.n;
    // Bessel-corrected sample variance — n-1 denominator.
    const swimVar = (a.swimSumSq - a.n * swimMean * swimMean) / Math.max(1, a.n - 1);
    const bikeVar = (a.bikeSumSq - a.n * bikeMean * bikeMean) / Math.max(1, a.n - 1);
    const runVar  = (a.runSumSq  - a.n * runMean  * runMean ) / Math.max(1, a.n - 1);
    bins.push({
      centerSec: c,
      n: a.n,
      swimFracMean: swimMean, swimFracSD: Math.sqrt(Math.max(0, swimVar)),
      bikeFracMean: bikeMean, bikeFracSD: Math.sqrt(Math.max(0, bikeVar)),
      runFracMean:  runMean,  runFracSD:  Math.sqrt(Math.max(0, runVar)),
    });
  }

  return {
    distance,
    totalRecords: records.length,
    minBinN: MIN_BIN_N,
    bins,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Prediction validator
// ───────────────────────────────────────────────────────────────────────────

export interface PredictionToValidate {
  swimSec: number;
  bikeSec: number;
  runSec: number;
  finishSec: number;
}

export interface LegValidation {
  /** Predicted leg fraction. */
  fraction: number;
  /** Empirical mean for the bin. */
  expectedMean: number;
  /** Empirical SD. */
  expectedSD: number;
  /** Z-score: (predicted − expectedMean) / SD. Positive → leg slower than typical. */
  zScore: number;
  /** True if |z| > 2 (outside ±2 SD of empirical distribution). */
  outOfBand: boolean;
}

export interface ValidationResult {
  /** Bin the prediction was matched to (centre time in seconds). */
  binCenterSec: number | null;
  /** Bin sample size — confidence proxy. */
  binN: number | null;
  swim: LegValidation | null;
  bike: LegValidation | null;
  run:  LegValidation | null;
  /** Any leg was out-of-band. */
  anyOutOfBand: boolean;
  /** Free-text explanation suitable for logging. */
  notes: string[];
}

/**
 * Validate a prediction against the empirical distribution. Returns null
 * legs if the prediction's total time falls outside any bin (e.g., a 3:30
 * 70.3 prediction is faster than the elite age-group floor of 4:00).
 */
export function validateAgainstDistribution(
  prediction: PredictionToValidate,
  table: DistributionTable,
): ValidationResult {
  const c = binCenter(table.distance, prediction.finishSec);
  if (c == null) {
    return {
      binCenterSec: null, binN: null,
      swim: null, bike: null, run: null,
      anyOutOfBand: false,
      notes: [`prediction total ${prediction.finishSec}s outside binning range`],
    };
  }
  const bin = table.bins.find((b) => b.centerSec === c);
  if (!bin) {
    return {
      binCenterSec: c, binN: null,
      swim: null, bike: null, run: null,
      anyOutOfBand: false,
      notes: [`no calibration bin at ${c}s (insufficient data — ${table.minBinN}+ finishers required)`],
    };
  }

  const fSwim = prediction.swimSec / prediction.finishSec;
  const fBike = prediction.bikeSec / prediction.finishSec;
  const fRun  = prediction.runSec  / prediction.finishSec;

  const swim: LegValidation = {
    fraction: fSwim,
    expectedMean: bin.swimFracMean,
    expectedSD: bin.swimFracSD,
    zScore: (fSwim - bin.swimFracMean) / Math.max(1e-9, bin.swimFracSD),
    outOfBand: false,
  };
  swim.outOfBand = Math.abs(swim.zScore) > 2;

  const bike: LegValidation = {
    fraction: fBike,
    expectedMean: bin.bikeFracMean,
    expectedSD: bin.bikeFracSD,
    zScore: (fBike - bin.bikeFracMean) / Math.max(1e-9, bin.bikeFracSD),
    outOfBand: false,
  };
  bike.outOfBand = Math.abs(bike.zScore) > 2;

  const run: LegValidation = {
    fraction: fRun,
    expectedMean: bin.runFracMean,
    expectedSD: bin.runFracSD,
    zScore: (fRun - bin.runFracMean) / Math.max(1e-9, bin.runFracSD),
    outOfBand: false,
  };
  run.outOfBand = Math.abs(run.zScore) > 2;

  return {
    binCenterSec: c,
    binN: bin.n,
    swim, bike, run,
    anyOutOfBand: swim.outOfBand || bike.outOfBand || run.outOfBand,
    notes: [],
  };
}
