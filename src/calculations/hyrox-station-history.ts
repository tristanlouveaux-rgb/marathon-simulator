/**
 * HYROX station benchmark history helpers.
 *
 * **Side**: tracking. The append-only history (`stationBenchmarkHistory` on
 * `HyroxConfig`) is the source of truth for per-station progression. The
 * scalar `stationBenchmarksSingles` / `stationBenchmarksDoubles` fields hold
 * the latest value for fast prediction-time reads; this module computes
 * derived signals like "tested 4 months ago", "PR vs previous", and the
 * trend slope used for sparklines.
 *
 * Mirrors the `ftpHistory` / `cssHistory` pattern in triathlon mode.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export type StationTestSource = 'half_test' | 'full_test' | 'race' | 'manual';
export type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

export interface StationTestEntry {
  dateISO: string;
  sec: number;
  source: StationTestSource;
  format: HyroxFormat;
  proWeights?: boolean;
}

/** Read the history array for a single station, sorted oldest → newest.
 *  Returns empty array when missing. */
export function getStationHistory(
  state: SimulatorState,
  station: HyroxStation,
): StationTestEntry[] {
  const arr = state.hyroxConfig?.stationBenchmarkHistory?.[station];
  if (!arr || arr.length === 0) return [];
  // Defensive copy + chronological sort. Mutating consumers are responsible
  // for re-sorting; readers should not assume input order is correct.
  return [...arr].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

/** Append a new entry to the history for a station. Returns the new array.
 *  Caller is responsible for setting it back into state and persisting. */
export function appendStationTest(
  existing: StationTestEntry[] | undefined,
  entry: StationTestEntry,
): StationTestEntry[] {
  const next = existing ? [...existing] : [];
  next.push(entry);
  next.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  return next;
}

/** Latest test entry for a station; null if none. */
export function latestStationTest(
  state: SimulatorState,
  station: HyroxStation,
): StationTestEntry | null {
  const hist = getStationHistory(state, station);
  return hist.length > 0 ? hist[hist.length - 1] : null;
}

/** Age of the latest test in months. null if no history. */
export function latestTestAgeMonths(
  state: SimulatorState,
  station: HyroxStation,
): number | null {
  const latest = latestStationTest(state, station);
  if (!latest) return null;
  const ms = Date.now() - new Date(latest.dateISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / MS_PER_MONTH;
}

/** Best (lowest) station time across all history. null if no history.
 *  Filters by format to avoid mixing singles and doubles in the PR comparison. */
export function bestStationTime(
  state: SimulatorState,
  station: HyroxStation,
  format: HyroxFormat,
): { sec: number; dateISO: string } | null {
  const hist = getStationHistory(state, station).filter(e => e.format === format);
  if (hist.length === 0) return null;
  let best = hist[0];
  for (const e of hist) {
    if (e.sec < best.sec) best = e;
  }
  return { sec: best.sec, dateISO: best.dateISO };
}

/** True iff the latest entry is the best in history (a PR). False if history
 *  has only one entry (nothing to PR against) or the latest isn't best. */
export function latestIsPR(
  state: SimulatorState,
  station: HyroxStation,
  format: HyroxFormat,
): boolean {
  const hist = getStationHistory(state, station).filter(e => e.format === format);
  if (hist.length < 2) return false;
  const latest = hist[hist.length - 1];
  for (let i = 0; i < hist.length - 1; i += 1) {
    if (hist[i].sec <= latest.sec) return false; // earlier entry was equal or better
  }
  return true;
}

/** Improvement from the second-to-last test to the latest, in seconds.
 *  Negative = got faster (improvement). null if fewer than 2 same-format entries. */
export function latestImprovementSec(
  state: SimulatorState,
  station: HyroxStation,
  format: HyroxFormat,
): number | null {
  const hist = getStationHistory(state, station).filter(e => e.format === format);
  if (hist.length < 2) return null;
  const latest = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  return latest.sec - prev.sec;
}
