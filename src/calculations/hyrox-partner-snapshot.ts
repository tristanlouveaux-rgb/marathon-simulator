/**
 * HYROX Doubles partner snapshot: the race numbers a linked partner may read.
 *
 * Side: tracking. It describes the athlete's current race numbers for the
 * partner comparison (hyrox-partner-compare.ts); it prescribes nothing.
 *
 * Whitelist (Tristan, 2026-10-12: share ONLY race-relevant numbers). The
 * snapshot holds exactly these fields and the database row
 * (hyrox_partner_snapshots, typed columns, no free jsonb) holds exactly the
 * same set, so nothing else can leave the device through this path:
 *   - format, division, raceTier: what the athlete races and at which loads;
 *   - initials: the letters the app header already shows (or null);
 *   - stationSec / stationTier / teamStations: per-station benchmarks, the
 *     canonical per-station number (resolveHyroxStationBenchmarks, the Stats
 *     ledger value: one athlete at their solo loads in the race), the load
 *     tier the athlete's numbers are expressed at, and which benchmarks are a
 *     doubles race split (a pair time);
 *   - forecastStationSec, roxzoneSec: the athlete's own forecast lines
 *     (predictHyroxRace, before venue factors) in the race format's terms,
 *     the pair's time for doubles; runPaceSecKm: their singles run pace.
 *     The pair forecast reads these.
 * Health and training data (VDOT, LT, HRV, sleep, heart rate, activities,
 * biological sex, name, plan) are read only where a whitelisted number is
 * derived from them, and never copied.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxDivision, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { predictHyroxRace, resolveHyroxStationBenchmarks } from './race-prediction.hyrox';
import { deriveHyroxRunPace } from './hyrox-run-pace';
import { hyroxSinglesFormatOf, hyroxSoloLoadsArePro } from './hyrox-results';
import { hyroxLoadTier, resolveHyroxAthleteSex, resolveHyroxDivision } from './hyrox-division';

export type HyroxPartnerFormat = HyroxConfig['format'];

export interface HyroxPartnerSnapshot {
  format: HyroxPartnerFormat;
  /** Resolved division (resolveHyroxDivision); null when unknown. */
  division: HyroxDivision | null;
  /** The tier the athlete races (hyroxLoadTier); null when the division is
   *  unknown (the app's Men Open fallback is not shared as a fact). */
  raceTier: HyroxLoadTier | null;
  /** Header initials (first letter of up to two name words), or null. */
  initials: string | null;
  /** Per station, whole seconds: one athlete over the full station at their
   *  solo loads in the race (resolveHyroxStationBenchmarks `sec`, the Stats
   *  ledger value, after H3b's per-entry Open/Pro conversion). Absent = no
   *  benchmark (the forecast uses the population seed). */
  stationSec: Partial<Record<HyroxStation, number>>;
  /** Per station: the load tier the athlete's numbers at that station
   *  (stationSec and forecastStationSec) are expressed at, their solo loads
   *  in the race (hyroxSoloStationTier). Every station carries it, a seeded
   *  one too. Absent when it cannot be stated (no sex on file in Mixed). */
  stationTier: Partial<Record<HyroxStation, HyroxLoadTier>>;
  /** Stations whose benchmark comes from a doubles race split: the pair's
   *  time converted to one athlete's terms, not an individual capacity. */
  teamStations: HyroxStation[];
  /** Per station, whole seconds: the athlete's own forecast station line in
   *  the race format's terms, before venue factors (HyroxStationLine
   *  baseSec). Doubles: the pair's time at this athlete's percentile in their
   *  own singles field, read from the pair's division table (H3b's
   *  per-station doubles mapping; a pair at percentile p is taken to be two
   *  athletes near p in their own fields). */
  forecastStationSec: Record<HyroxStation, number>;
  /** The athlete's own HYROX run pace, singles terms, whole s/km. */
  runPaceSecKm: number;
  /** The athlete's forecast Roxzone in the race format's terms (doubles: the
   *  pair's Roxzone at this athlete's percentile, the same mapping), whole
   *  seconds. */
  roxzoneSec: number;
}

/** The whitelist, in one place. A test pins the snapshot to these keys. */
export const HYROX_PARTNER_SNAPSHOT_KEYS: ReadonlyArray<keyof HyroxPartnerSnapshot> = [
  'format', 'division', 'raceTier', 'initials',
  'stationSec', 'stationTier', 'teamStations', 'forecastStationSec', 'runPaceSecKm', 'roxzoneSec',
];

/** Characters an initial may not contain: it is rendered to another user.
 *  Mirrors the hyrox_partner_snapshots initials CHECK. */
const INITIAL_REJECT = /[\s\p{P}\p{S}\p{N}\p{C}]/u;

/** True when `t` is acceptable as initials: one or two upper-case letters. */
export function isValidHyroxPartnerInitials(t: string | null | undefined): t is string {
  if (typeof t !== 'string') return false;
  const chars = Array.from(t);
  return chars.length >= 1 && chars.length <= 2 && t === t.toUpperCase() && !INITIAL_REJECT.test(t);
}

/** Up to two initials, as every HYROX header derives them from the
 *  onboarding name (first letter of the first two words). Whole code points,
 *  so an accented or non-Latin first letter survives; anything that is not a
 *  letter is dropped. Null when nothing usable is left. */
export function hyroxPartnerInitials(name: string | undefined | null): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const out = words
    .map(w => (Array.from(w)[0] ?? '').toUpperCase())
    .filter(c => c.length > 0 && isValidHyroxPartnerInitials(c))
    .join('');
  return isValidHyroxPartnerInitials(out) ? out : null;
}

/**
 * The load tier one athlete's station numbers are expressed at: their solo
 * loads in the race (hyroxSoloLoadsArePro, lane H3b), named as the singles
 * tier of their sex in that load family. Women Open = W-Open, Women Pro =
 * M-Open, Men Open = M-Open, Men Pro = M-Pro; a woman in Mixed Doubles races
 * M-Open, the Women Pro tier.
 *
 * Every number the snapshot carries is at these loads: H3b converts each
 * stored benchmark there per entry (convertToTarget: hyroxOpenToProSec /
 * hyroxProToOpenSec, per station and sex, a difference in differences on the
 * Pro and Open results), so a Mixed woman's Women Open tests reach the Stats
 * ledger, her forecast and this snapshot as Men Open times, and a Pro
 * athlete's Open-weight tests as Pro times. Seeds are read at the same loads
 * (hyroxStationSeedsAtTarget).
 *
 * Null when the athlete's sex cannot be resolved (resolveHyroxAthleteSex: no
 * biological sex on file in a Mixed or unknown division). The app then reads
 * the pooled tables, whose times mix the women's and men's loads, so the
 * numbers sit at no single tier.
 */
export function hyroxSoloStationTier(
  format: HyroxPartnerFormat,
  biologicalSex: SimulatorState['biologicalSex'],
  division: HyroxDivision | undefined,
): HyroxLoadTier | null {
  const sex = resolveHyroxAthleteSex(biologicalSex, division);
  if (!sex) return null;
  return hyroxLoadTier(hyroxSoloLoadsArePro(format, biologicalSex, division) ? 'pro_singles' : 'open_singles', sex);
}

/**
 * The athlete's own run pace in singles terms: deriveHyroxRunPace for the
 * singles counterpart of the format, so a doubles athlete's pace carries no
 * doubles run ratio (the pair rule takes the slower partner instead). A pace
 * the athlete entered by hand is used as entered; an auto-derived stored pace
 * (written in doubles terms by applyHyroxRunPaceDerivation) is re-derived.
 */
export function hyroxSinglesRunPaceSecKm(state: SimulatorState): number | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;
  const keepStored = hx.hyroxRunPaceSource === 'user';
  const singlesHx: HyroxConfig = {
    ...hx,
    format: hyroxSinglesFormatOf(hx.format),
    ...(keepStored ? {} : { hyroxRunPaceSecKm: undefined }),
  };
  const pace = deriveHyroxRunPace({ ...state, hyroxConfig: singlesHx }).paceSecKm;
  return Number.isFinite(pace) && pace > 0 ? Math.round(pace) : null;
}

const positiveInt = (n: number): number | null => {
  const r = Math.round(n);
  return Number.isFinite(r) && r > 0 ? r : null;
};

/**
 * Build the athlete's snapshot from state. Null when the athlete has no HYROX
 * config or any forecast number is unusable (nothing half-built is synced).
 * Every field is built explicitly from a whitelisted source, never by
 * spreading state.
 */
export function buildHyroxPartnerSnapshot(state: SimulatorState): HyroxPartnerSnapshot | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;
  const prediction = predictHyroxRace(state);
  const resolved = resolveHyroxStationBenchmarks(state);
  const runPaceSecKm = hyroxSinglesRunPaceSecKm(state);
  if (!prediction || !resolved || runPaceSecKm == null) return null;

  const division = resolveHyroxDivision(hx.format, state.biologicalSex, hx.division);
  const raceTier = division ? hyroxLoadTier(hx.format, state.biologicalSex, hx.division) : null;

  const stationSec: Partial<Record<HyroxStation, number>> = {};
  const teamStations: HyroxStation[] = [];
  for (const b of resolved.stations) {
    if (b.sec == null) continue;
    const sec = positiveInt(b.sec);
    if (sec == null) continue;
    stationSec[b.station] = sec;
    if (b.teamTimeSplit) teamStations.push(b.station);
  }

  const soloTier = hyroxSoloStationTier(hx.format, state.biologicalSex, hx.division);
  const stationTier: Partial<Record<HyroxStation, HyroxLoadTier>> = {};
  const forecastStationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) {
    const line = prediction.stations.find(l => l.station === st);
    const sec = line ? positiveInt(line.baseSec) : null;
    if (sec == null) return null;
    forecastStationSec[st] = sec;
    if (soloTier) stationTier[st] = soloTier;
  }

  const roxzoneSec = positiveInt(prediction.roxzoneSec);
  if (roxzoneSec == null) return null;

  return {
    format: hx.format,
    division,
    raceTier,
    initials: hyroxPartnerInitials(state.onboarding?.name),
    stationSec,
    stationTier,
    teamStations,
    forecastStationSec,
    runPaceSecKm,
    roxzoneSec,
  };
}
