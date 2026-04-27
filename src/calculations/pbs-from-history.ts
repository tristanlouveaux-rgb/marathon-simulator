import type { RaceDistance } from '@/types/training';

/**
 * Reads Strava `best_efforts` arrays stored on synced activities and extracts
 * the fastest time per canonical race distance (5k / 10k / half / marathon).
 *
 * Used by onboarding to auto-fill PBs when the user connects Strava before the
 * PB screen. Source activity id + date are returned alongside each PB so the
 * UI can render attribution captions ("3:12 · Berlin Marathon, Oct 2024").
 *
 * Strava `best_efforts` item shape (as returned by GET /activities/{id}):
 *   { name: '5k' | '10k' | 'Half Marathon' | 'Marathon' | ...,
 *     elapsed_time: int,   // seconds — does NOT include pauses inside the split
 *     moving_time: int,    // seconds
 *     start_date: string,
 *     distance: number,    // metres
 *     ... }
 *
 * We use `elapsed_time` — this is what Strava surfaces as the user's PB in the
 * activity UI, and matches how chip-timed race PBs are recorded. `moving_time`
 * would ignore brief pauses and inflate the result.
 *
 * Only RUNNING activities carry `best_efforts` (set by the Strava backfill in
 * `sync-strava-activities`), so we don't need to re-filter by activity_type.
 */

/**
 * Canonical Strava best_effort name → our RaceDistance key.
 * Strava has used both 'Half Marathon' and 'Half-Marathon' over time, and
 * '5k' vs '5K' casing varies. Match on normalised (lowercased,
 * whitespace/hyphen-stripped) names.
 */
const NAME_TO_DISTANCE: Record<string, RaceDistance> = {
  '5k': '5k',
  '10k': '10k',
  'halfmarathon': 'half',
  'marathon': 'marathon',
};

function normaliseEffortName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

/** Input shape — the minimum we need from a stored activity row. */
export interface ActivityWithBestEfforts {
  garminId?: string;
  garmin_id?: string;
  startTime?: string;
  start_time?: string;
  activityName?: string | null;
  activity_name?: string | null;
  bestEfforts?: unknown;
  best_efforts?: unknown;
}

/** Raw Strava best_effort entry (only the fields we read). */
interface RawBestEffort {
  name?: string;
  elapsed_time?: number;
  start_date?: string;
}

/** One PB with source attribution. */
export interface PBWithSource {
  /** Time in seconds. */
  timeSec: number;
  /** Source activity id (e.g. `strava-1234567`). */
  activityId: string;
  /** Activity start date (ISO string). */
  startDate: string;
  /** Activity name as shown on Strava (e.g. "Berlin Marathon"). */
  activityName?: string;
}

/** Return shape — PBs keyed by canonical distance, plus source metadata. */
export interface PBsWithSource {
  k5?: PBWithSource;   // 5K
  k10?: PBWithSource;  // 10K
  h?: PBWithSource;    // Half marathon
  m?: PBWithSource;    // Marathon
}

const DISTANCE_TO_FIELD: Record<RaceDistance, keyof PBsWithSource> = {
  '5k': 'k5',
  '10k': 'k10',
  'half': 'h',
  'marathon': 'm',
};

function readField<T>(act: ActivityWithBestEfforts, camel: keyof ActivityWithBestEfforts, snake: keyof ActivityWithBestEfforts): T | undefined {
  const v = act[camel] ?? act[snake];
  return v as T | undefined;
}

/**
 * Walk each activity's `best_efforts` array and return the fastest time per
 * canonical race distance. Activities without `best_efforts` are skipped.
 */
export function readPBsFromHistory(activities: ActivityWithBestEfforts[]): PBsWithSource {
  const result: PBsWithSource = {};

  for (const act of activities) {
    const beRaw = readField<unknown>(act, 'bestEfforts', 'best_efforts');
    if (!Array.isArray(beRaw) || beRaw.length === 0) continue;

    const activityId = readField<string>(act, 'garminId', 'garmin_id');
    if (!activityId) continue;
    const startDate = readField<string>(act, 'startTime', 'start_time') ?? '';
    const activityName = readField<string>(act, 'activityName', 'activity_name') ?? undefined;

    for (const rawEntry of beRaw as RawBestEffort[]) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const dist = rawEntry.name ? NAME_TO_DISTANCE[normaliseEffortName(rawEntry.name)] : undefined;
      if (!dist) continue;
      const t = rawEntry.elapsed_time;
      if (typeof t !== 'number' || t <= 0) continue;

      const field = DISTANCE_TO_FIELD[dist];
      const current = result[field];
      if (!current || t < current.timeSec) {
        result[field] = {
          timeSec: t,
          activityId,
          startDate: rawEntry.start_date ?? startDate,
          activityName,
        };
      }
    }
  }

  return result;
}
