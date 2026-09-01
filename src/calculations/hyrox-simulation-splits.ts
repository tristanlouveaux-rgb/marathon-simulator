/**
 * HYROX simulation split calibration.
 *
 * **Side: tracking.** Converts the splits an athlete records after a race
 * simulation into calibrated benchmarks, and writes them into the same fields
 * the race forecast already reads:
 *
 *   - station times → `stationBenchmarksSingles` / `stationBenchmarksDoubles`
 *     plus an append-only `stationBenchmarkHistory` entry
 *   - run pace     → `hyroxRunPaceSecKm` with `hyroxRunPaceSource = 'user'`
 *
 * A full simulation records station times at race distance, so they are stored
 * as entered. A half simulation records half the volume, so times are doubled
 * before storage — the same convention the station benchmark card uses for its
 * half-test protocol.
 *
 * Unlike `applyParsedBenchmarks`, which is PB-only because it fires
 * automatically off imported activities, a simulation is a deliberate test the
 * athlete chose to run and record. Its result therefore replaces the previous
 * benchmark even when slower: that is the current measurement, and silently
 * keeping a stale faster time would overstate the forecast.
 *
 * Free of store and DOM access so the calibration path stays directly testable.
 */

import type { HyroxConfig, HyroxStation } from '@/types/triathlon';
import {
  STATION_DISPLAY,
  HYROX_STATION_ORDER,
  STATION_MIN_SEC,
  HYROX_RUN_PACE_MIN_SEC_KM,
  HYROX_RUN_LEG_M,
} from '@/constants/hyrox-benchmarks';
import { appendStationTest, type HyroxFormat } from './hyrox-station-history';

/** Parse "m:ss", "mm:ss" or a bare second count. Returns null when unparseable. */
export function parseMmSs(input: string): number | null {
  const clean = input.trim().replace(/[^0-9:]/g, '');
  if (!clean) return null;
  const parts = clean.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (isNaN(m) || isNaN(s) || s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 1) {
    const s = parseInt(parts[0], 10);
    if (isNaN(s)) return null;
    return s;
  }
  return null;
}

/** Parse "h:mm:ss" as well as "mm:ss" — run totals commonly exceed an hour. */
export function parseHmsOrMmSs(input: string): number | null {
  const clean = input.trim().replace(/[^0-9:]/g, '');
  const parts = clean.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    if ([h, m, s].some(isNaN) || m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return parseMmSs(input);
}

/**
 * Convert one entered station split into a full-race-distance benchmark.
 *
 * Half simulations are doubled; full simulations are stored as entered.
 * Returns null when the result falls below the station's physical lower bound
 * (`STATION_MIN_SEC`), which is how a mis-typed entry is rejected.
 */
export function benchmarkFromSplit(
  station: HyroxStation,
  enteredSec: number,
  isHalf: boolean,
): number | null {
  if (!Number.isFinite(enteredSec) || enteredSec <= 0) return null;
  const fullSec = Math.round(isHalf ? enteredSec * 2 : enteredSec);
  if (fullSec < STATION_MIN_SEC[station]) return null;
  return fullSec;
}

/**
 * Convert a total run-leg time into a per-km pace.
 *
 * The athlete enters the summed time across all eight legs, which is what a
 * watch's lap totals give them. Returns null when the implied pace is below the
 * physical lower bound (`HYROX_RUN_PACE_MIN_SEC_KM`).
 */
export function runPaceFromTotal(totalRunSec: number, legDistanceM: number): number | null {
  if (!Number.isFinite(totalRunSec) || totalRunSec <= 0) return null;
  const totalKm = (legDistanceM * HYROX_STATION_ORDER.length) / 1000;
  if (totalKm <= 0) return null;
  const paceSecKm = Math.round(totalRunSec / totalKm);
  if (paceSecKm < HYROX_RUN_PACE_MIN_SEC_KM) return null;
  return paceSecKm;
}

/** Run-leg distance for a simulation of the given scale. */
export function simulationLegDistanceM(isHalf: boolean): number {
  return Math.round(HYROX_RUN_LEG_M * (isHalf ? 0.5 : 1));
}

/** Outcome of applying a split entry, for the caller's confirmation copy. */
export interface SplitEntryResult {
  stationsUpdated: number;
  runPaceUpdated: boolean;
  /** Display names of fields that could not be read or failed a plausibility floor. */
  rejected: string[];
}

/**
 * Write entered splits into a HYROX config, in place.
 *
 * Every field is optional: a partial entry writes only what was filled in.
 */
export function applySplitsToConfig(
  hx: HyroxConfig,
  stationInputs: Partial<Record<HyroxStation, string>>,
  runTotalInput: string,
  isHalf: boolean,
  dateISO: string,
): SplitEntryResult {
  const result: SplitEntryResult = { stationsUpdated: 0, runPaceUpdated: false, rejected: [] };
  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const source = isHalf ? 'half_simulation' : 'simulation';

  for (const station of HYROX_STATION_ORDER) {
    const raw = stationInputs[station];
    if (!raw || !raw.trim()) continue;
    const entered = parseMmSs(raw);
    const fullSec = entered == null ? null : benchmarkFromSplit(station, entered, isHalf);
    if (fullSec == null) {
      result.rejected.push(STATION_DISPLAY[station].name);
      continue;
    }

    if (isDoubles) {
      hx.stationBenchmarksDoubles = hx.stationBenchmarksDoubles ?? {};
      hx.stationBenchmarksDoubles[station] = fullSec;
    } else {
      hx.stationBenchmarksSingles = hx.stationBenchmarksSingles ?? {};
      hx.stationBenchmarksSingles[station] = fullSec;
    }

    hx.stationBenchmarkHistory = hx.stationBenchmarkHistory ?? {};
    hx.stationBenchmarkHistory[station] = appendStationTest(
      hx.stationBenchmarkHistory[station],
      {
        dateISO,
        sec: fullSec,
        source,
        format: hx.format as HyroxFormat,
        proWeights: !!hx.benchmarksAtProWeights,
      },
    );
    result.stationsUpdated++;
  }

  if (runTotalInput.trim()) {
    const totalSec = parseHmsOrMmSs(runTotalInput);
    const pace = totalSec == null ? null : runPaceFromTotal(totalSec, simulationLegDistanceM(isHalf));
    if (pace == null) {
      result.rejected.push('Run total');
    } else {
      hx.hyroxRunPaceSecKm = pace;
      hx.hyroxRunPaceSource = 'user';
      result.runPaceUpdated = true;
    }
  }

  return result;
}
