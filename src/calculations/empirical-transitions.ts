/**
 * Empirical transition-time lookup — runtime side.
 *
 * Reads the precomputed JSON of per-(race, level-bin) average transition
 * times (emitted by `src/validation/run-calibration.ts`) and returns the
 * mean T1 / T2 / T1+T2 for the user's predicted level at a specific race.
 *
 * Resolution order at the call site:
 *   1. User override on `triConfig.transitionOverride` — always wins.
 *   2. Race-specific empirical bin — when ≥ minRaceBinN finishers landed
 *      in the user's swim+bike+run band at this race.
 *   3. Global level-bin fallback — average across all races at the user's
 *      level band, when the race-specific cell is too sparse.
 *   4. None (caller falls back to the slider default).
 *
 * Name normalisation is shared with the course-factor lookup helper.
 */

import transitionsJson from '@/constants/empirical-transition-distributions.json';
import {
  IM_T1_SHARE_OF_TOTAL,
  SOCK_ON_COST_SEC,
} from '@/constants/triathlon-constants';

type Distance = '70.3' | 'ironman';

interface RawBinStats {
  centerSec: number;
  n: number;
  t1Mean?: number;
  t2Mean?: number;
  transitionMean: number;
}

interface RawTable {
  distance: Distance;
  totalRecords: number;
  byLocation: Record<string, RawBinStats[]>;
  global: RawBinStats[];
  minRaceBinN: number;
  minGlobalBinN: number;
}

interface RawJson {
  '70.3': RawTable;
  ironman: RawTable;
}

const TABLES: RawJson = transitionsJson as RawJson;

function normaliseLocationKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^ironman\s+70\.3\s+/i, '')
    .replace(/^ironman\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build name-normalised lookups once at module load.
const NORMALISED_BY_LOCATION: Record<Distance, Map<string, RawBinStats[]>> = {
  '70.3': new Map(),
  ironman: new Map(),
};
for (const distance of ['70.3', 'ironman'] as const) {
  const raw = TABLES[distance]?.byLocation ?? {};
  for (const [rawName, bins] of Object.entries(raw)) {
    NORMALISED_BY_LOCATION[distance].set(normaliseLocationKey(rawName), bins);
  }
}

function pickBinClosest(bins: RawBinStats[], movingSec: number): RawBinStats | null {
  if (bins.length === 0) return null;
  let best: RawBinStats | null = null;
  let bestDelta = Infinity;
  for (const b of bins) {
    const d = Math.abs(b.centerSec - movingSec);
    if (d < bestDelta) { best = b; bestDelta = d; }
  }
  return best;
}

export type TransitionSource = 'race-empirical' | 'global-empirical' | 'none';

export interface EmpiricalTransitionsResult {
  /** T1 mean in seconds. Populated for 70.3 only. */
  t1Sec?: number;
  /** T2 mean in seconds. Populated for 70.3 only. */
  t2Sec?: number;
  /** T1+T2 combined in seconds. Populated whenever any empirical match is found. */
  transitionSec?: number;
  source: TransitionSource;
  /** Sample size of the bin we matched on. Useful for diagnostics. */
  n: number;
  /** Centre of the swim+bike+run bin we matched (seconds). */
  binCenterSec?: number;
}

/**
 * Look up empirical mean transitions for a user predicted to finish the
 * legs at a given level (swim + bike + run, no transitions) at a given
 * race. Returns the closest race-specific bin if available, else the
 * closest global bin, else `source: 'none'`.
 */
export function lookupEmpiricalTransitions(
  raceName: string,
  distance: Distance,
  predictedMovingSec: number,
): EmpiricalTransitionsResult {
  const key = normaliseLocationKey(raceName);
  const raceBins = NORMALISED_BY_LOCATION[distance].get(key);
  const raceBin = raceBins ? pickBinClosest(raceBins, predictedMovingSec) : null;
  if (raceBin) {
    return {
      t1Sec: raceBin.t1Mean,
      t2Sec: raceBin.t2Mean,
      transitionSec: raceBin.transitionMean,
      source: 'race-empirical',
      n: raceBin.n,
      binCenterSec: raceBin.centerSec,
    };
  }
  const globalBin = pickBinClosest(TABLES[distance].global, predictedMovingSec);
  if (globalBin) {
    return {
      t1Sec: globalBin.t1Mean,
      t2Sec: globalBin.t2Mean,
      transitionSec: globalBin.transitionMean,
      source: 'global-empirical',
      n: globalBin.n,
      binCenterSec: globalBin.centerSec,
    };
  }
  return { source: 'none', n: 0 };
}

/**
 * Split a combined T1+T2 mean into asymmetric per-side values using the
 * empirical T1 share (`IM_T1_SHARE_OF_TOTAL`). Used when the dataset only
 * exposes a combined transition (Ironman) — T1 is typically longer than T2
 * because of the wetsuit strip and longer transition-zone walks.
 */
export function splitCombinedTransition(combinedSec: number): { t1: number; t2: number } {
  const t1 = Math.round(combinedSec * IM_T1_SHARE_OF_TOTAL);
  const t2 = Math.round(combinedSec - t1);
  return { t1, t2 };
}

export type TransitionSocks = 't1' | 't2' | 'none';

/**
 * Apply the sock-on event to a resolved T1 / T2 pair. Socks are a single
 * one-time event; the choice decides where (or whether) that cost lands.
 * Baseline assumes 't1' (population default) — no adjustment for that.
 * Floored at 60s per side so we never go negative.
 */
export function applySockSavings(
  t1: number,
  t2: number,
  choice: TransitionSocks,
): { t1: number; t2: number } {
  switch (choice) {
    case 't1':
      return { t1, t2 };
    case 't2':
      return { t1: Math.max(60, t1 - SOCK_ON_COST_SEC), t2: t2 + SOCK_ON_COST_SEC };
    case 'none':
      return { t1: Math.max(60, t1 - SOCK_ON_COST_SEC), t2 };
  }
}
