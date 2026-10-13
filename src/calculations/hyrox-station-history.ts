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
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export type StationTestSource = 'half_test' | 'full_test' | 'race' | 'manual' | 'session';
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

/**
 * Record one logged race's split for a station, replacing any earlier 'race'
 * entry for the same race. Race identity is what the log carries: the entry's
 * date (race day, or the log date when the race is undated) and its format.
 * Re-logging a race, e.g. to correct a typo, then rewrites its entries instead
 * of adding a second set to the history list and sparkline (review
 * 2026-10-12). A different date or format is a different race and is kept.
 * Other sources (tests, session bests, the 'manual' boot backfill) are never
 * touched. Returns the new array.
 */
export function upsertRaceSplitEntry(
  existing: StationTestEntry[] | undefined,
  entry: StationTestEntry & { source: 'race' },
): StationTestEntry[] {
  const kept = (existing ?? []).filter(e =>
    !(e.source === 'race' && e.dateISO === entry.dateISO && e.format === entry.format),
  );
  return appendStationTest(kept, entry);
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

/** A benchmark slot: `stationBenchmarksSingles` or `stationBenchmarksDoubles`. */
export type BenchmarkSlot = 'singles' | 'doubles';

function slotOfFormat(format: HyroxFormat): BenchmarkSlot {
  return format === 'open_doubles' || format === 'pro_doubles' ? 'doubles' : 'singles';
}

/**
 * The benchmark set a forecast reads, and the slot it came from. One rule for
 * the predictor and the benchmark card, so the card's "still using population
 * estimates" count matches the stations the forecast calibrates.
 *  - The target format's slot when it has values.
 *  - Else the other format's slot. Its values reach the target through the
 *    doubles quantile mapping (hyrox-doubles.ts): singles times × the station
 *    ratio for a doubles target; for a singles target, a doubles race split
 *    (the pair's time) ÷ the station ratio, and a solo test from the doubles
 *    slot as is.
 *  - Else the legacy pooled field (slot null).
 * Resolution is per slot, not per station: once the target's slot has one
 * value the other slot is not read.
 */
export function resolveHyroxBenchmarks(
  hx: Pick<HyroxConfig, 'format' | 'stationBenchmarksSingles' | 'stationBenchmarksDoubles' | 'stationBenchmarks'>,
): { benchmarks: Partial<Record<HyroxStation, number>>; slot: BenchmarkSlot | null } {
  const nonEmpty = (b?: Partial<Record<HyroxStation, number>>): b is Partial<Record<HyroxStation, number>> =>
    b != null && Object.keys(b).length > 0;
  const own: BenchmarkSlot = slotOfFormat(hx.format);
  const other: BenchmarkSlot = own === 'doubles' ? 'singles' : 'doubles';
  const read = (slot: BenchmarkSlot) => (slot === 'doubles' ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles);
  const ownValues = read(own);
  if (nonEmpty(ownValues)) return { benchmarks: ownValues, slot: own };
  const otherValues = read(other);
  if (nonEmpty(otherValues)) return { benchmarks: otherValues, slot: other };
  return { benchmarks: hx.stationBenchmarks ?? {}, slot: null };
}

/** True for sources that record a race split: the logged race's own splits
 *  ('race'), and 'manual', the boot migration's label for the onboarding seed,
 *  which only ever held race splits. */
export function isRaceSplitSource(source: StationTestSource): boolean {
  return source === 'race' || source === 'manual';
}

/**
 * The history entry that describes a benchmark slot's current value: the
 * newest entry in the slot's format family (singles or doubles) whose time
 * equals the value. Null when none matches, which means the value was written
 * by a path that kept no history (race splits logged before 2026-10-12, or the
 * legacy pooled benchmarks).
 *
 * Matching on the value, not taking the newest entry, keeps provenance right
 * when an older race is logged after a newer test: the race split overwrites
 * the slot but its entry is dated on race day, before the test.
 */
export function benchmarkEntryForSlotValue(
  hx: Pick<HyroxConfig, 'stationBenchmarkHistory'>,
  station: HyroxStation,
  slot: BenchmarkSlot,
  sec: number,
): StationTestEntry | null {
  const entries = (hx.stationBenchmarkHistory?.[station] ?? [])
    .filter(e => slotOfFormat(e.format) === slot && Math.abs(e.sec - sec) < 0.5)
    .slice()
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  return entries[entries.length - 1] ?? null;
}
