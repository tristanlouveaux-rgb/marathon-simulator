/**
 * Empirical course-factor lookup — runtime side.
 *
 * Reads the precomputed JSON of course factors (emitted by
 * `src/validation/run-calibration.ts`) and returns multipliers for a given
 * race location. Production code uses this in addition to (or in place of)
 * the physical course-factor model when high-confidence empirical data
 * exists for the race.
 *
 * Lookup is name-normalised: the dataset uses "Ironman Lanzarote" while our
 * race library uses "IRONMAN Lanzarote"; we strip the leading prefix and
 * lowercase before comparing.
 */

import factorsJson from '@/constants/empirical-course-factors.json';
import type { CourseFactor, CourseFactorOutput } from './course-factors';

type RawConfidence = 'high' | 'medium' | 'low' | 'insufficient';
type Distance = '70.3' | 'ironman';

interface RawCourseFactors {
  swimFactor: number;
  bikeFactor: number;
  runFactor: number;
  n: number;
  confidence: RawConfidence;
  /** Set true at calibration time if any factor hit the sanity clamp. We drop
   *  clamped entries from runtime lookup — they usually indicate a course
   *  shortened or weather-cancelled race (e.g., IM North Carolina 2016 bike
   *  was 0.75x normal) and serve a wrong 25% faster prediction. */
  clamped?: boolean;
  /** 'recent' = last 5 years; 'allTime' = full dataset. The calibration
   *  prefers recent when sample is sufficient (catches course revisions);
   *  falls back to all-time when recent data is thin. */
  era?: 'recent' | 'allTime';
}

interface RawTable {
  distance: Distance;
  referenceSwimSec: number;
  referenceBikeSec: number;
  referenceRunSec: number;
  factors: Record<string, RawCourseFactors>;
}

interface RawJson {
  '70.3': RawTable;
  ironman: RawTable;
}

const TABLES: RawJson = factorsJson as RawJson;

/**
 * Normalise a race name for cross-dataset matching. The IM Kaggle dataset
 * spells the prefix "Ironman", our race library spells it "IRONMAN", and the
 * 70.3 dataset uses "IRONMAN 70.3 Foo". Strip the prefix, lowercase, collapse
 * whitespace.
 */
function normaliseLocationKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^ironman\s+70\.3\s+/i, '')
    .replace(/^ironman\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Maps race-library names to their canonical dataset key equivalents.
 * Applied BEFORE normalisation so that name variants (added city suffixes,
 * localised renames, dataset typos) can still resolve to the correct entry.
 *
 * Rules:
 *  - Key   = exact race library name (e.g. from src/data/triathlons.ts)
 *  - Value = exact dataset key (Kaggle CSV eventLocation field)
 *  - Only add aliases where the dataset genuinely has the race under a
 *    different name — do not alias different courses to each other.
 */
const RACE_NAME_ALIASES: Record<string, string> = {
  // IM full-distance ─────────────────────────────────────────────────────────
  // City / edition suffix added to library name; dataset uses city-only form.
  'IRONMAN France Nice':              'Ironman France',
  'IRONMAN Switzerland Thun':         'Ironman Switzerland',
  'IRONMAN Italy Emilia-Romagna':     'Ironman Italy',
  'IRONMAN Japan South Hokkaido':     'Ironman Japan',
  'IRONMAN Gurye Korea':              'Ironman Gurye',
  // Hyphen vs "space-dash-space" in dataset key.
  'IRONMAN Portugal-Cascais':         'Ironman Portugal - Cascais',
  // Ottawa edition; dataset stores older Canada entry without city qualifier.
  'IRONMAN Canada-Ottawa':            'Ironman Canada',

  // 70.3 ─────────────────────────────────────────────────────────────────────
  // Dataset has a one-letter typo ("Edinburg" not "Edinburgh").
  'IRONMAN 70.3 Edinburgh':           'IRONMAN 70.3 Edinburg',
  // Library uses official race city; dataset uses the historic regional name.
  'IRONMAN 70.3 Aix-en-Provence':     "IRONMAN 70.3 Pays D'Aix",
  // Library uses a hyphen; dataset uses a space.
  'IRONMAN 70.3 Emilia-Romagna':      'IRONMAN 70.3 Emilia Romagna',
};

// Build name-normalised lookup tables once at module load.
const NORMALISED_LOOKUP: Record<Distance, Map<string, RawCourseFactors>> = {
  '70.3': new Map(),
  ironman: new Map(),
};
for (const distance of ['70.3', 'ironman'] as const) {
  const raw = TABLES[distance]?.factors ?? {};
  for (const [rawName, factors] of Object.entries(raw)) {
    NORMALISED_LOOKUP[distance].set(normaliseLocationKey(rawName), factors);
  }
}

export interface EmpiricalCourseFactorsResult {
  swimMultiplier: number;
  bikeMultiplier: number;
  runMultiplier: number;
  factors: CourseFactor[];
  /** Sample size underlying the estimate. */
  n: number;
  /** Reliability of the estimate. Caller may fall back to physical factors
   *  when 'low' or 'insufficient'. */
  confidence: RawConfidence;
  /** Time-window the factor was computed from. */
  era: 'recent' | 'allTime';
}

/**
 * Look up empirical course factors for a race by name. Returns null when no
 * matching entry exists OR when the entry's confidence is 'insufficient'.
 *
 * @param raceName  Race name (e.g., "IRONMAN Lanzarote", "IRONMAN 70.3 Dublin").
 *                  Normalised internally — case and prefix don't matter.
 * @param distance  '70.3' | 'ironman' — selects the correct dataset.
 * @param baseSec   Pre-adjustment leg times in seconds. Used to compute the
 *                  delta seconds shown in the UI breakdown.
 */
export function lookupEmpiricalCourseFactors(
  raceName: string | undefined,
  distance: Distance,
  baseSec: { swimSec: number; bikeSec: number; runSec: number },
): EmpiricalCourseFactorsResult | null {
  if (!raceName) return null;
  const resolved = RACE_NAME_ALIASES[raceName] ?? raceName;
  const key = normaliseLocationKey(resolved);
  const raw = NORMALISED_LOOKUP[distance].get(key);
  if (!raw) return null;
  if (raw.confidence === 'insufficient') return null;
  // Drop clamped entries — usually course-shortened or weather-cancelled
  // races (e.g., IM North Carolina 2016, IM Alaska's non-wetsuit swim).
  // Caller falls back to physical model.
  if (raw.clamped === true) return null;

  const factors: CourseFactor[] = [];
  if (Math.abs(raw.swimFactor - 1) > 0.005) {
    factors.push({
      kind: 'swim-type', // closest existing kind — empirical can't isolate cause
      leg: 'swim',
      label: 'Calibrated swim factor',
      value: `${raw.confidence}, n=${raw.n}`,
      deltaSec: baseSec.swimSec * (raw.swimFactor - 1),
      multiplier: raw.swimFactor,
    });
  }
  if (Math.abs(raw.bikeFactor - 1) > 0.005) {
    factors.push({
      kind: 'bike-elevation', // empirical bike captures gradient + wind + heat
      leg: 'bike',
      label: 'Calibrated bike factor',
      value: `${raw.confidence}, n=${raw.n}`,
      deltaSec: baseSec.bikeSec * (raw.bikeFactor - 1),
      multiplier: raw.bikeFactor,
    });
  }
  if (Math.abs(raw.runFactor - 1) > 0.005) {
    factors.push({
      kind: 'run-elevation', // empirical run captures elevation + heat
      leg: 'run',
      label: 'Calibrated run factor',
      value: `${raw.confidence}, n=${raw.n}`,
      deltaSec: baseSec.runSec * (raw.runFactor - 1),
      multiplier: raw.runFactor,
    });
  }

  return {
    swimMultiplier: raw.swimFactor,
    bikeMultiplier: raw.bikeFactor,
    runMultiplier: raw.runFactor,
    factors,
    n: raw.n,
    confidence: raw.confidence,
    era: raw.era ?? 'allTime',
  };
}

/**
 * Pick between empirical and physical course factors based on confidence.
 * Used by the predictor as the single integration point. When empirical
 * confidence is 'high' or 'medium', use it (it's more comprehensive than
 * physical alone). Otherwise return null and let the caller use the existing
 * physical-factors path.
 */
export function pickCourseFactors(
  empirical: EmpiricalCourseFactorsResult | null,
  physical: CourseFactorOutput,
): { source: 'empirical' | 'physical'; output: CourseFactorOutput; n?: number; confidence?: RawConfidence } {
  if (empirical && (empirical.confidence === 'high' || empirical.confidence === 'medium')) {
    return {
      source: 'empirical',
      output: {
        swimMultiplier: empirical.swimMultiplier,
        bikeMultiplier: empirical.bikeMultiplier,
        runMultiplier: empirical.runMultiplier,
        factors: empirical.factors,
      },
      n: empirical.n,
      confidence: empirical.confidence,
    };
  }
  return { source: 'physical', output: physical };
}

/**
 * Total finishers across both datasets — used in the user-facing caption
 * "Calibrated against ~N million race finishes."
 */
export function totalCalibrationSampleSize(): number {
  let sum = 0;
  for (const distance of ['70.3', 'ironman'] as const) {
    for (const f of Object.values(TABLES[distance]?.factors ?? {})) {
      sum += f.n;
    }
  }
  return sum;
}
