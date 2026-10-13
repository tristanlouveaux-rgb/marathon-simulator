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
 *     ledger value), the load tier each was measured at, and which of them
 *     are a doubles race split (a pair time);
 *   - forecastStationSec, runPaceSecKm, roxzoneSec: the athlete's own forecast
 *     inputs in singles terms (predictHyroxRace), for the pair forecast.
 * Health and training data (VDOT, LT, HRV, sleep, heart rate, activities,
 * biological sex, name, plan) are read only where a whitelisted number is
 * derived from them, and never copied.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxDivision, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import {
  predictHyroxRace,
  resolveHyroxStationBenchmarks,
  stationSinglesEquivalentSec,
  type HyroxStationBenchmark,
} from './race-prediction.hyrox';
import { deriveHyroxRunPace } from './hyrox-run-pace';
import {
  hyroxLoadTier,
  isHyroxDoublesFormat,
  isHyroxProFormat,
  resolveHyroxAthleteSex,
  resolveHyroxDivision,
} from './hyrox-division';

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
  /** Per station, whole seconds: one athlete over the full station
   *  (resolveHyroxStationBenchmarks `sec`, the Stats ledger value). Absent =
   *  no benchmark (the forecast uses the population seed). */
  stationSec: Partial<Record<HyroxStation, number>>;
  /** Per station with a benchmark: the load tier stationSec is expressed at
   *  (recordedStationTier): the tier it was measured at, or, for a value the
   *  app converted between Open and Pro weights, the tier that conversion
   *  lands on. Absent when unknown. */
  stationTier: Partial<Record<HyroxStation, HyroxLoadTier>>;
  /** Stations whose benchmark comes from a doubles race split: the pair's
   *  time converted to one athlete's terms, not an individual capacity. */
  teamStations: HyroxStation[];
  /** Per station, whole seconds: the athlete's own forecast station time in
   *  singles terms, before venue factors (stationSinglesEquivalentSec). */
  forecastStationSec: Record<HyroxStation, number>;
  /** The athlete's own HYROX run pace, singles terms, whole s/km. */
  runPaceSecKm: number;
  /** The athlete's forecast Roxzone, singles terms, whole seconds. */
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

function singlesFormatOf(format: HyroxPartnerFormat): HyroxPartnerFormat {
  if (format === 'open_doubles') return 'open_singles';
  if (format === 'pro_doubles') return 'pro_singles';
  return format;
}

/**
 * The load tier a resolved benchmark's `sec` is expressed at, or null when it
 * cannot be stated.
 *
 * `sec` is always at the target's weight regime (Open or Pro): a value
 * recorded at the other regime carries the app's Open/Pro conversion
 * (HYROX_PRO_STATION_MULTIPLIER, the convention the solo forecast and the
 * Stats ledger apply; the multiplier itself is marked UNSOURCED and was set
 * from the men's jump). The pair comparison follows the same convention as
 * the solo forecast, so the tier is read at the target's regime whether or
 * not the value was converted. Before (review 2026-10-13) a converted value
 * had no tier, so a Pro pair whose tests were at Open weights read as "times
 * at different loads" and lost its pair forecast, although both partners'
 * solo forecasts used those values.
 *
 * - Singles slot: the athlete's own singles tier at the target's regime
 *   (Women Open = W-Open, Women Pro = M-Open, Men Open = M-Open, Men Pro =
 *   M-Pro).
 * - Doubles slot, doubles target: the tier of the athlete's current division
 *   (hyroxLoadTier). Entries do not record the division they were set in;
 *   the app prescribes and states every doubles station at the division's
 *   tier (hyroxLoadTierForState), so a doubles-slot value is read at it.
 * - Anything else (a doubles-slot value read by a singles target, the legacy
 *   pooled field, unknown sex or division): null.
 *
 * A Mixed woman's singles-slot values stay at W-Open (her own singles tier):
 * no conversion from Women Open to Men Open loads exists yet (lane H3b).
 */
export function recordedStationTier(
  b: Pick<HyroxStationBenchmark, 'sec' | 'slot'>,
  format: HyroxPartnerFormat,
  biologicalSex: SimulatorState['biologicalSex'],
  division: HyroxDivision | undefined,
): HyroxLoadTier | null {
  if (b.sec == null) return null;
  const targetPro = isHyroxProFormat(format);
  if (b.slot === 'singles') {
    const sex = resolveHyroxAthleteSex(biologicalSex, division);
    return sex ? hyroxLoadTier(targetPro ? 'pro_singles' : 'open_singles', sex) : null;
  }
  if (b.slot === 'doubles' && isHyroxDoublesFormat(format)) {
    return resolveHyroxDivision(format, biologicalSex, division)
      ? hyroxLoadTier(format, biologicalSex, division)
      : null;
  }
  return null;
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
    format: singlesFormatOf(hx.format),
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
  const stationTier: Partial<Record<HyroxStation, HyroxLoadTier>> = {};
  const teamStations: HyroxStation[] = [];
  for (const b of resolved.stations) {
    if (b.sec == null) continue;
    const sec = positiveInt(b.sec);
    if (sec == null) continue;
    stationSec[b.station] = sec;
    const tier = recordedStationTier(b, hx.format, state.biologicalSex, hx.division);
    if (tier) stationTier[b.station] = tier;
    if (b.teamTimeSplit) teamStations.push(b.station);
  }

  const forecastStationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) {
    const line = prediction.stations.find(l => l.station === st);
    const sec = line ? positiveInt(stationSinglesEquivalentSec(line)) : null;
    if (sec == null) return null;
    forecastStationSec[st] = sec;
  }

  const roxzoneSec = positiveInt(prediction.roxzoneSec / (prediction.doubles?.roxzoneRatio ?? 1));
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
