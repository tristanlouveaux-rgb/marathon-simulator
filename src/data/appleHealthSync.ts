/**
 * Apple Health / Apple Watch sync.
 *
 * Uses @capgo/capacitor-health when running as a native iOS app, and falls
 * back to a no-op when running in browser/web mode.
 *
 * npx cap sync ios  — run after `npm install @capgo/capacitor-health`
 *
 * Required Info.plist keys:
 *   NSHealthShareUsageDescription  — "Mosaic reads workouts, sleep, heart rate
 *     variability, and resting heart rate from Apple Health to track your
 *     training load and recovery."
 *   NSHealthUpdateUsageDescription — "Not required (read-only)"
 *
 * Two sync functions:
 *   syncAppleHealth()              — workouts (activities) → GarminActivityRow[]
 *   syncAppleHealthPhysiology()    — sleep, HRV, resting HR, steps → PhysiologyDayEntry[]
 *
 * Both are on-device only (HealthKit is a local store, no server/OAuth needed).
 * This is the key difference from Garmin, which pushes data via webhooks to
 * our Supabase DB and requires OAuth 1.0a for the server-side pipeline.
 *
 * Known plugin limitation: @capgo/capacitor-health does not expose VO2max.
 * Apple Watch users must enter VO2max manually during onboarding, or it
 * stays unset (same as users without a VO2max-capable device).
 */

import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { setAthleteNormalizer } from '@/calculations/fitness-model';
import type { PhysiologyDayEntry } from '@/types';
import { type WorkoutType, type Workout, type HealthSample, type SleepState } from '@capgo/capacitor-health';

// ---------------------------------------------------------------------------
// Platform detection & auth
// ---------------------------------------------------------------------------

/** Returns true when running as a native iOS Capacitor app */
function isNativeiOS(): boolean {
  return (window as any)?.Capacitor?.platform === 'ios';
}

/** All HealthKit data types we read. Single combined authorization request. */
const ALL_READ_TYPES = [
  'calories', 'distance', 'heartRate',               // workouts
  'sleep', 'restingHeartRate', 'heartRateVariability', 'steps',  // physiology
] as const;

/** Cached auth flag — avoid re-prompting on every call within the same session. */
let _authRequested = false;

/**
 * Request HealthKit authorization for all data types we need.
 * Only prompts once per app session (iOS remembers the grant across launches).
 */
async function ensureAuthorization(): Promise<typeof import('@capgo/capacitor-health')['Health']> {
  const { Health } = await import('@capgo/capacitor-health');
  if (!_authRequested) {
    await Health.requestAuthorization({ read: [...ALL_READ_TYPES] });
    _authRequested = true;
  }
  return Health;
}

// ---------------------------------------------------------------------------
// Workout type mapping
// ---------------------------------------------------------------------------

/** Map @capgo/capacitor-health WorkoutType strings to our internal activity types */
function mapWorkoutType(type: WorkoutType): GarminActivityRow['activity_type'] {
  switch (type) {
    case 'running':                    return 'RUNNING';
    case 'cycling':                    return 'CYCLING';
    case 'walking':                    return 'WALKING';
    case 'swimming':                   return 'SWIMMING';
    case 'hiking':                     return 'HIKING';
    case 'elliptical':                 return 'ELLIPTICAL';
    case 'rowing':                     return 'ROWING';
    case 'stairClimbing':              return 'STAIR_CLIMBING';
    case 'traditionalStrengthTraining':
    case 'crossTraining':              return 'STRENGTH_TRAINING';
    default:                           return 'WALKING';  // conservative fallback
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/**
 * Sync recent Apple Watch workouts to the plan.
 * Called from main.ts after app launch on iOS.
 * Safe to call on every launch — already-processed workouts are skipped
 * by the garminMatched dedup key (keyed as "apple-<stableId>").
 */
export async function syncAppleHealth(): Promise<void> {
  if (!isNativeiOS()) return;

  try {
    const workouts = await fetchRecentWorkouts();
    if (workouts.length === 0) return;

    const rows = workouts.map(convertToActivityRow);
    const changed = matchAndAutoComplete(rows);
    if (changed) render();
    console.log(`[AppleHealthSync] Processed ${rows.length} workouts`);
  } catch (err) {
    // Non-fatal — app continues without Apple Health sync
    console.warn('[AppleHealthSync] Sync failed:', err);
  }
}

/**
 * Request HealthKit permissions then fetch workouts from the last 14 days.
 */
async function fetchRecentWorkouts(): Promise<Workout[]> {
  const Health = await ensureAuthorization();

  const since = new Date();
  since.setDate(since.getDate() - 14);

  const { workouts } = await Health.queryWorkouts({
    startDate: since.toISOString(),
    endDate: new Date().toISOString(),
    limit: 100,
    ascending: false,
  });

  return workouts;
}

// ---------------------------------------------------------------------------
// Physiology sync — sleep, HRV, resting HR from HealthKit
// ---------------------------------------------------------------------------

/** Default sleep target when we have no history yet (7 hours). */
const DEFAULT_SLEEP_TARGET_SEC = 7 * 3600;

/**
 * SDNN → RMSSD conversion factor for Apple Watch HRV.
 * Apple Watch reports SDNN; our readiness model and rmssdToHrvStatus() expect RMSSD.
 * Source: Shaffer & Ginsberg 2017 — nocturnal short-term recordings.
 * Range in literature: 1.2–1.4. We use 1.28 (study median).
 */
const SDNN_TO_RMSSD = 1.28;

/**
 * Sync physiology data (sleep, HRV, resting HR) from HealthKit.
 * Populates `s.physiologyHistory` with up to 28 days of PhysiologyDayEntry[],
 * matching the same shape that syncPhysiologySnapshot() produces from Garmin.
 *
 * Safe to call on every launch — reads the local HealthKit store, no network.
 * Returns true if state was updated.
 */
export async function syncAppleHealthPhysiology(days = 28): Promise<boolean> {
  if (!isNativeiOS()) return false;

  try {
    const Health = await ensureAuthorization();

    // Check if sleep permission was actually granted (HealthKit silently
    // returns empty results when denied — this is the only way to detect it).
    const authStatus = await Health.checkAuthorization({ read: ['sleep', 'restingHeartRate', 'heartRateVariability'] });
    if (authStatus.readDenied.length > 0) {
      console.warn('[AppleHealthSync] HealthKit permissions denied for:', authStatus.readDenied);
      // Continue anyway — we'll get data for whatever types ARE authorized.
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();
    const nowISO = new Date().toISOString();

    // Fetch all data types in parallel (all local HealthKit queries, no network)
    const [sleepResult, rhrResult, hrvResult, stepsResult] = await Promise.all([
      Health.readSamples({ dataType: 'sleep', startDate: sinceISO, endDate: nowISO, limit: 2000, ascending: true }),
      Health.readSamples({ dataType: 'restingHeartRate', startDate: sinceISO, endDate: nowISO, limit: 100, ascending: true }),
      Health.readSamples({ dataType: 'heartRateVariability', startDate: sinceISO, endDate: nowISO, limit: 100, ascending: true }),
      Health.queryAggregated({ dataType: 'steps', startDate: sinceISO, endDate: nowISO, bucket: 'day', aggregation: 'sum' }),
    ]);

    // ── Group sleep samples into nights ────────────────────────────────────
    // A sleep "night" is keyed by the calendar date the user woke up on.
    // HealthKit sleep samples have startDate/endDate per stage segment.
    // Filter: only count samples ending before noon (excludes daytime naps
    // that would inflate sleep totals for that day's entry).
    const nightMap = new Map<string, HealthSample[]>();
    for (const sample of sleepResult.samples) {
      const endDate = new Date(sample.endDate);
      const endHour = endDate.getHours();
      // Main sleep ends between midnight and noon. Naps (ending after noon)
      // are excluded to avoid inflating the night's sleep total.
      if (endHour >= 12) continue;

      const wakeDate = sample.endDate.split('T')[0];
      if (!nightMap.has(wakeDate)) nightMap.set(wakeDate, []);
      nightMap.get(wakeDate)!.push(sample);
    }

    // ── Index resting HR and HRV by date ───────────────────────────────────
    const rhrByDate = new Map<string, number>();
    for (const sample of rhrResult.samples) {
      const date = sample.startDate.split('T')[0];
      rhrByDate.set(date, sample.value); // last value wins (most recent reading)
    }

    const hrvByDate = new Map<string, number>();
    for (const sample of hrvResult.samples) {
      const date = sample.startDate.split('T')[0];
      // HealthKit reports HRV as SDNN (ms). Our model uses RMSSD (ms).
      // Convert using published ratio: RMSSD ≈ SDNN * 1.28 during sleep.
      // Source: Shaffer & Ginsberg 2017, validated across multiple
      // populations for nocturnal short-term recordings (5-min epochs).
      // This ensures Apple Watch values land in the same absolute range
      // as Garmin RMSSD, so rmssdToHrvStatus() thresholds work correctly.
      hrvByDate.set(date, sample.value * SDNN_TO_RMSSD);
    }

    // ── Index steps by date ────────────────────────────────────────────────
    const stepsByDate = new Map<string, number>();
    for (const sample of stepsResult.samples) {
      const date = sample.startDate.split('T')[0];
      stepsByDate.set(date, sample.value);
    }

    // ── Build PhysiologyDayEntry per date ──────────────────────────────────
    // Collect all dates that have any data
    const allDates = new Set<string>();
    for (const d of nightMap.keys()) allDates.add(d);
    for (const d of rhrByDate.keys()) allDates.add(d);
    for (const d of hrvByDate.keys()) allDates.add(d);
    for (const d of stepsByDate.keys()) allDates.add(d);

    if (allDates.size === 0) return false;

    const entries: PhysiologyDayEntry[] = [];
    for (const date of allDates) {
      const entry: PhysiologyDayEntry = { date };

      // Sleep stages
      const sleepSamples = nightMap.get(date);
      if (sleepSamples && sleepSamples.length > 0) {
        const stageSecs = computeSleepStageDurations(sleepSamples);
        entry.sleepDeepSec = stageSecs.deep;
        entry.sleepRemSec = stageSecs.rem;
        entry.sleepLightSec = stageSecs.light;
        entry.sleepAwakeSec = stageSecs.awake;
        entry.sleepDurationSec = stageSecs.deep + stageSecs.rem + stageSecs.light;
        entry.sleepScore = computeSleepScore(entry);
      }

      // Resting HR
      const rhr = rhrByDate.get(date);
      if (rhr != null && rhr > 0) entry.restingHR = Math.round(rhr);

      // HRV
      const hrv = hrvByDate.get(date);
      if (hrv != null && hrv > 0) entry.hrvRmssd = Math.round(hrv * 10) / 10;

      // Steps
      const steps = stepsByDate.get(date);
      if (steps != null && steps > 0) entry.steps = Math.round(steps);

      entries.push(entry);
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));

    // ── Store in state ─────────────────────────────────────────────────────
    const s = getMutableState();
    // Merge with existing history (Garmin data may have fields Apple doesn't)
    const existing = new Map((s.physiologyHistory ?? []).map(e => [e.date, e]));
    for (const entry of entries) {
      const prev = existing.get(entry.date);
      if (prev) {
        // Apple data fills in missing fields; doesn't overwrite Garmin data
        existing.set(entry.date, { ...entry, ...prev, ...pickDefined(entry, prev) });
      } else {
        existing.set(entry.date, entry);
      }
    }
    s.physiologyHistory = [...existing.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-28);

    // Update top-level state fields from latest entry
    const latest = entries[entries.length - 1];
    if (latest.restingHR != null) s.restingHR = latest.restingHR;

    saveState();
    console.log(`[AppleHealthSync] Physiology: ${entries.length} days synced (sleep/HRV/RHR/steps)`);
    return true;
  } catch (err) {
    console.warn('[AppleHealthSync] Physiology sync failed:', err);
    return false;
  }
}

/**
 * Compute durations per sleep stage from HealthKit samples.
 * Each sample covers a time window [startDate, endDate] with a sleepState.
 */
function computeSleepStageDurations(samples: HealthSample[]): {
  deep: number; rem: number; light: number; awake: number;
} {
  let deep = 0, rem = 0, light = 0, awake = 0;
  for (const s of samples) {
    const durSec = (new Date(s.endDate).getTime() - new Date(s.startDate).getTime()) / 1000;
    if (durSec <= 0) continue;
    switch (s.sleepState as SleepState) {
      case 'deep':    deep += durSec; break;
      case 'rem':     rem += durSec; break;
      case 'light':   light += durSec; break;
      case 'asleep':  light += durSec; break;  // generic "asleep" → count as light
      case 'awake':   awake += durSec; break;
      case 'inBed':   break;  // exclude from sleep duration
    }
  }
  return { deep: Math.round(deep), rem: Math.round(rem), light: Math.round(light), awake: Math.round(awake) };
}

/**
 * Compute a 0-100 sleep score from HealthKit stage data.
 * Modelled after Garmin's sleep score weighting:
 * - Duration vs target (7h default): 55% weight
 * - Deep sleep proportion (ideal ~15-20%): 25% weight
 * - REM proportion (ideal ~20-25%): 20% weight
 */
function computeSleepScore(entry: PhysiologyDayEntry): number {
  const totalSleep = entry.sleepDurationSec ?? 0;
  if (totalSleep < 1800) return 0;  // < 30 min = not a real sleep session

  // Duration component: 100 at target, linear ramp up, gentle penalty below
  const target = DEFAULT_SLEEP_TARGET_SEC;
  const durationRatio = totalSleep / target;
  const durationScore = Math.min(100, durationRatio * 100);

  // Deep sleep: ideal is 15-20% of total. Score peaks at 17.5%.
  const deepPct = totalSleep > 0 ? (entry.sleepDeepSec ?? 0) / totalSleep : 0;
  const deepScore = Math.min(100, (deepPct / 0.175) * 100);

  // REM: ideal is 20-25% of total. Score peaks at 22.5%.
  const remPct = totalSleep > 0 ? (entry.sleepRemSec ?? 0) / totalSleep : 0;
  const remScore = Math.min(100, (remPct / 0.225) * 100);

  const score = durationScore * 0.55 + deepScore * 0.25 + remScore * 0.20;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Merge helper: for each field, pick the Apple value only if the existing
 * Garmin/other value is undefined or null.
 */
function pickDefined(apple: PhysiologyDayEntry, existing: PhysiologyDayEntry): Partial<PhysiologyDayEntry> {
  const result: Partial<PhysiologyDayEntry> = {};
  const keys: (keyof PhysiologyDayEntry)[] = [
    'sleepScore', 'sleepDurationSec', 'sleepDeepSec', 'sleepRemSec',
    'sleepLightSec', 'sleepAwakeSec', 'restingHR', 'hrvRmssd', 'steps',
  ];
  for (const k of keys) {
    if (existing[k] == null && apple[k] != null) {
      (result as any)[k] = apple[k];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Activity sync helpers
// ---------------------------------------------------------------------------

/**
 * Convert a @capgo/capacitor-health Workout to the shared GarminActivityRow format.
 * ID prefixed with "apple-" so dedup logic in garminMatched doesn't collide with Garmin/Strava IDs.
 */
function convertToActivityRow(w: Workout): GarminActivityRow {
  const distanceM = w.totalDistance ?? 0;
  const durationSec = Math.round(w.duration);
  const avgPaceSecKm =
    distanceM > 0 ? Math.round((durationSec / distanceM) * 1000) : null;

  // Stable dedup key: source bundle + start timestamp (no UUID in plugin API)
  const stableId = `${w.sourceId ?? w.sourceName ?? 'aw'}-${w.startDate}`;

  return {
    garmin_id: `apple-${stableId}`,
    activity_type: mapWorkoutType(w.workoutType),
    start_time: w.startDate,
    duration_sec: durationSec,
    distance_m: distanceM > 0 ? Math.round(distanceM) : null,
    avg_pace_sec_km: avgPaceSecKm,
    avg_hr: null,          // @capgo/capacitor-health does not expose HR on the Workout object
    max_hr: null,          // (would require a separate readSamples query per workout)
    calories: w.totalEnergyBurned ? Math.round(w.totalEnergyBurned) : null,
    aerobic_effect: null,  // HealthKit does not expose Training Effect
    anaerobic_effect: null,
    garmin_rpe: null,
  };
}
