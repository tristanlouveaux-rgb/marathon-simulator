/**
 * Transition-time distribution analysis.
 *
 * For each race location × level bin, compute the average transition time
 * actually recorded by finishers in that bin. The runtime predictor uses
 * these averages to replace the hand-tuned skill-slider defaults
 * (`T1_SEC_BY_SLIDER` / `T2_SEC_BY_SLIDER`) when empirical data exists for
 * the user's predicted level at the race they're targeting.
 *
 * **Why bin on swim+bike+run, not finish time.** We want a level-bin
 * lookup that's independent of transition skill itself: a fast 4:30 70.3
 * finisher should land in the same bin whether their transitions were 3 min
 * or 12 min. Using `swim + bike + run` (the "moving time" total) achieves
 * this, and it's the same quantity the runtime predictor naturally has
 * before it adds transitions.
 *
 * **Why average and not full distribution.** The race-prediction surface
 * needs a single point estimate to add into the predicted finish time.
 * Storing the full distribution per bin would be useful for percentile
 * coaching ("you're slower than 60% of 4:30 finishers at this race") but
 * that's a separate feature; out of scope for the predictor integration.
 *
 * **Distance handling.**
 *   - 70.3 records carry separate t1Sec/t2Sec (from the source CSV).
 *   - IM records carry only transitionSec (derived as overall − legs).
 * The output reflects what's available per distance.
 *
 * Output: `src/constants/empirical-transition-distributions.json` —
 * checked in, consumed at runtime.
 */

import type { FinishRecord, Distance } from './dataset-loader';

// ───────────────────────────────────────────────────────────────────────────
// Bin definitions — match the split-distribution table so a "level" means
// the same thing across both calibrations.
// ───────────────────────────────────────────────────────────────────────────

/** 15-min bins for 70.3 spanning 4:00 → 8:00 (on swim+bike+run, not total). */
const BIN_703_WIDTH_SEC = 15 * 60;
const BIN_703_MIN_SEC = 4 * 3600;
const BIN_703_MAX_SEC = 8 * 3600;

/** 30-min bins for IM spanning 9:00 → 17:00. */
const BIN_IM_WIDTH_SEC = 30 * 60;
const BIN_IM_MIN_SEC = 9 * 3600;
const BIN_IM_MAX_SEC = 17 * 3600;

/** Min finishers per (event, bin) cell for the race-specific average. */
const MIN_RACE_BIN_N = 50;

/** Min finishers per (bin) for the global cross-race fallback. */
const MIN_GLOBAL_BIN_N = 200;

function levelBinCenter(distance: Distance, movingSec: number): number | null {
  const w = distance === 'ironman' ? BIN_IM_WIDTH_SEC : BIN_703_WIDTH_SEC;
  const min = distance === 'ironman' ? BIN_IM_MIN_SEC : BIN_703_MIN_SEC;
  const max = distance === 'ironman' ? BIN_IM_MAX_SEC : BIN_703_MAX_SEC;
  if (movingSec < min || movingSec > max) return null;
  const idx = Math.floor((movingSec - min) / w);
  return min + idx * w + w / 2;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-(event, bin) cell + global-bin fallback
// ───────────────────────────────────────────────────────────────────────────

/** Cell averages. For 70.3, t1Mean/t2Mean populated; for IM, only transitionMean. */
export interface TransitionBinStats {
  /** Centre of the swim+bike+run bin in seconds. */
  centerSec: number;
  /** Number of finishers contributing to this cell. */
  n: number;
  /** Mean T1 in seconds (70.3 only). */
  t1Mean?: number;
  /** Mean T2 in seconds (70.3 only). */
  t2Mean?: number;
  /** Mean T1 + T2 in seconds. Always populated when n ≥ minN. */
  transitionMean: number;
}

export interface TransitionTable {
  distance: Distance;
  totalRecords: number;
  /** Per-event-location bins, keyed by location string. */
  byLocation: Record<string, TransitionBinStats[]>;
  /** Cross-race fallback bins, used when a race has too few finishers in the
   *  user's bin. */
  global: TransitionBinStats[];
  /** Sample-size thresholds applied. */
  minRaceBinN: number;
  minGlobalBinN: number;
}

interface Acc {
  n: number;
  t1Sum: number; t1Count: number;
  t2Sum: number; t2Count: number;
  trSum: number; trCount: number;
}

function newAcc(): Acc {
  return { n: 0, t1Sum: 0, t1Count: 0, t2Sum: 0, t2Count: 0, trSum: 0, trCount: 0 };
}

function add(acc: Acc, r: FinishRecord): void {
  acc.n++;
  if (r.t1Sec !== undefined) { acc.t1Sum += r.t1Sec; acc.t1Count++; }
  if (r.t2Sec !== undefined) { acc.t2Sum += r.t2Sec; acc.t2Count++; }
  if (r.transitionSec !== undefined) { acc.trSum += r.transitionSec; acc.trCount++; }
}

function finalize(centerSec: number, acc: Acc, minN: number): TransitionBinStats | null {
  if (acc.trCount < minN) return null;
  const stats: TransitionBinStats = {
    centerSec,
    n: acc.trCount,
    transitionMean: acc.trSum / acc.trCount,
  };
  if (acc.t1Count >= minN) stats.t1Mean = acc.t1Sum / acc.t1Count;
  if (acc.t2Count >= minN) stats.t2Mean = acc.t2Sum / acc.t2Count;
  return stats;
}

export function buildTransitionTable(
  distance: Distance,
  records: FinishRecord[],
): TransitionTable {
  // Per-(location, bin) accumulators
  const perLoc = new Map<string, Map<number, Acc>>();
  // Global per-bin accumulator
  const perGlobal = new Map<number, Acc>();

  for (const r of records) {
    if (r.transitionSec === undefined) continue;
    const movingSec = r.swimSec + r.bikeSec + r.runSec;
    const c = levelBinCenter(distance, movingSec);
    if (c == null) continue;

    let locMap = perLoc.get(r.eventLocation);
    if (!locMap) { locMap = new Map(); perLoc.set(r.eventLocation, locMap); }
    let acc = locMap.get(c);
    if (!acc) { acc = newAcc(); locMap.set(c, acc); }
    add(acc, r);

    let gAcc = perGlobal.get(c);
    if (!gAcc) { gAcc = newAcc(); perGlobal.set(c, gAcc); }
    add(gAcc, r);
  }

  const byLocation: Record<string, TransitionBinStats[]> = {};
  for (const [loc, binMap] of perLoc) {
    const bins: TransitionBinStats[] = [];
    const sortedCenters = [...binMap.keys()].sort((a, b) => a - b);
    for (const c of sortedCenters) {
      const stats = finalize(c, binMap.get(c)!, MIN_RACE_BIN_N);
      if (stats) bins.push(stats);
    }
    if (bins.length > 0) byLocation[loc] = bins;
  }

  const global: TransitionBinStats[] = [];
  const sortedGlobalCenters = [...perGlobal.keys()].sort((a, b) => a - b);
  for (const c of sortedGlobalCenters) {
    const stats = finalize(c, perGlobal.get(c)!, MIN_GLOBAL_BIN_N);
    if (stats) global.push(stats);
  }

  return {
    distance,
    totalRecords: records.length,
    byLocation,
    global,
    minRaceBinN: MIN_RACE_BIN_N,
    minGlobalBinN: MIN_GLOBAL_BIN_N,
  };
}
