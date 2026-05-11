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

import { matchAndAutoComplete, healMissingITrimp, type GarminActivityRow } from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { calculateITrimp } from '@/calculations/trimp';
import { calculateZones, type HRZones } from '@/calculations/heart-rate';
import { deriveAthleteTier } from '@/data/stravaSync';
import { SPORTS_DB } from '@/constants/sports';
import type { PhysiologyDayEntry } from '@/types';
import { type WorkoutType, type Workout, type HealthSample, type SleepState } from '@capgo/capacitor-health';
import {
  isHealthExtrasAvailable,
  requestHealthExtrasPermissions,
  readQuantitySamples,
  readLatestQuantity,
  readWorkoutRouteLocations,
  type RouteLocation,
  type HealthExtrasPermission,
} from '@/data/healthExtras';
import {
  buildPolylineFromLocations,
  extractKmSplits,
  extractBestEfforts,
  findRouteForWorkout,
  type SyntheticBestEffort,
} from '@/data/appleHealthRoute';
import {
  detectRunRepsFromStream,
  detectBikeRepsFromPower,
  detectRepsFromHRStream,
  type DetectionResult,
} from '@/calculations/rep-detection';
import type { ActivityRepData } from '@/types/state';

// ---------------------------------------------------------------------------
// Platform detection & auth
// ---------------------------------------------------------------------------

/** Returns true when running as a native iOS Capacitor app */
export function isNativeiOS(): boolean {
  return (window as any)?.Capacitor?.platform === 'ios';
}

/**
 * Onboarding-time "Connect Apple Health" action. Prompts HealthKit permissions
 * (iOS only), runs an initial physiology sync to verify the user actually
 * granted access, and marks Apple as the physiology source on success.
 *
 * Returns `{ ok: true }` when permissions were granted and at least one
 * physiology sample landed; `{ ok: false, reason }` otherwise. Reasons:
 *   - 'not-ios'           — running on web / Android (caller should hide the button)
 *   - 'permission-denied' — user dismissed the permission dialog or denied all reads
 *   - 'sync-error'        — HealthKit threw or returned no usable data
 */
export async function connectAppleHealth(): Promise<{ ok: boolean; reason?: 'not-ios' | 'permission-denied' | 'sync-error' }> {
  if (!isNativeiOS()) return { ok: false, reason: 'not-ios' };
  try {
    // 1) Capgo physiology — populates restingHR, sleep, HRV, steps. Always run
    //    first (acts as our smoke-test that HealthKit is actually available
    //    and the user granted *some* read access).
    const ok = await syncAppleHealthPhysiology(28);
    if (!ok) return { ok: false, reason: 'permission-denied' };

    // 2) HealthExtras permissions — VO2max, running power, GPS routes, etc.
    //    iOS prompts a single combined dialog. iOS-version-gated types
    //    (running power = iOS 16+, cycling power = iOS 17+) are silently
    //    dropped on older OS by the Swift plugin's quantityType(for:) switch.
    await requestHealthExtrasPermissions(EXTRAS_READ_TYPES).catch(() => null);

    // 3) Read the device VO2max immediately so the wizard's review step shows
    //    the real number instead of "(est.)" right out of the box. Falls back
    //    silently if unavailable / denied.
    await syncAppleVO2().catch(() => null);
    await syncAppleCyclingFTP().catch(() => null);

    const s = getMutableState();
    s.connectedSources = { ...(s.connectedSources ?? {}), physiology: 'apple' };
    if (!s.wearable) s.wearable = 'apple';
    saveState();

    // The 16-week activity backfill is still deferred to the review step —
    // it needs `onboarding.age` to resolve a maxHR fallback for iTRIMP, and
    // age is collected in the about-you step *after* connect-strava.
    return { ok: true };
  } catch (err) {
    console.warn('[AppleHealthSync] connect failed', err);
    return { ok: false, reason: 'sync-error' };
  }
}

/** Permissions to request from the HealthExtras plugin on Apple Health connect.
 *  Includes iOS-17+ types — Swift filters unavailable ones automatically so
 *  the prompt only ever lists what the user's OS actually supports. */
const EXTRAS_READ_TYPES: HealthExtrasPermission[] = [
  'vo2Max',
  'walkingHeartRateAverage',
  'appleSleepingWristTemperature',
  'runningPower',
  'runningSpeed',
  'runningStrideLength',
  'runningGroundContactTime',
  'runningVerticalOscillation',
  'cyclingPower',
  'cyclingCadence',
  'cyclingSpeed',
  'cyclingFunctionalThresholdPower',
  'workoutRoute',
];

/**
 * Read the most recent VO2max sample from HealthKit and write it to `s.vo2`
 * with provenance `'device'`. Apple Watch's VO2max updates a few times a
 * week from outdoor GPS runs (HealthKit's `HKQuantityTypeIdentifierVO2Max`).
 *
 * This is the headline benefit of the plugin: an Apple-only user no longer
 * sees "(est.)" next to their fitness number — it matches what they see in
 * the iOS Health app, with the same provenance label as a Garmin reading.
 */
export async function syncAppleVO2(): Promise<boolean> {
  if (!isHealthExtrasAvailable()) return false;
  // Pull the last 28 days of VO2 readings rather than just the most recent —
  // Apple's VO2max updates a few times a week from outdoor GPS runs, so a
  // history populates the stats-view trend chart (`getVO2History` reads
  // `physiologyHistory[].vo2max`) without waiting for a steady stream of
  // future updates. 28 days covers ~8 typical updates for an active runner.
  const samples = await readQuantitySamples({
    dataType: 'vo2Max',
    startDate: new Date(Date.now() - 28 * 86400 * 1000).toISOString(),
    endDate: new Date().toISOString(),
    limit: 100,
    ascending: true,
  });
  if (samples.length === 0) return false;

  const s = getMutableState();
  const valid = samples.filter(s2 => s2.value >= 20 && s2.value <= 90);
  if (valid.length === 0) return false;

  // Headline = latest valid reading (samples are ascending, so last is newest).
  const latest = valid[valid.length - 1];
  s.vo2 = Math.round(latest.value * 10) / 10;
  s.vo2Source = 'device';
  s.vo2UpdatedAt = new Date().toISOString().slice(0, 10);

  // Splice into physiologyHistory so the stats-view trend chart renders. We
  // group readings by calendar date (Apple sometimes records multiple
  // readings on the same day; we keep the latest), then merge each day into
  // the existing history entry (preserving sleep/HRV/RHR fields written by
  // the capgo physiology sync).
  const byDate = new Map<string, number>();
  for (const sample of valid) {
    const date = sample.startDate.slice(0, 10);
    byDate.set(date, sample.value); // ascending sort → last write wins (latest of the day)
  }
  const existing = new Map((s.physiologyHistory ?? []).map(e => [e.date, e]));
  for (const [date, value] of byDate) {
    const prev = existing.get(date) ?? { date };
    existing.set(date, { ...prev, vo2max: Math.round(value * 10) / 10 });
  }
  s.physiologyHistory = [...existing.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-28);

  saveState();
  console.log(`[AppleHealthSync] VO2max ${s.vo2} mL/kg/min from HealthKit (${valid.length} readings over 28d, asOf ${latest.startDate})`);
  return true;
}

/**
 * Read the latest cycling FTP from HealthKit (iOS 17+ only). Apple computes
 * this from outdoor cycling activities with paired power meters. Most users
 * don't have it, so we silently no-op when the read returns null.
 */
export async function syncAppleCyclingFTP(): Promise<boolean> {
  if (!isHealthExtrasAvailable()) return false;
  const latest = await readLatestQuantity({ dataType: 'cyclingFunctionalThresholdPower' });
  if (latest.value == null || latest.value < 80 || latest.value > 500) return false;
  const s = getMutableState();
  if (!s.onboarding) return false;
  if (!s.onboarding.triBike) s.onboarding.triBike = {} as any;
  // Mirror the "manually-set benchmarks yield to improvements" pattern: only
  // override when the device value clearly improves on what's stored. For
  // FTP, "improves" = higher (fitter rider). Lower readings don't override.
  const current = (s.onboarding.triBike as any).ftp as number | undefined;
  if (current && current >= latest.value) return false;
  (s.onboarding.triBike as any).ftp = Math.round(latest.value);
  (s.onboarding.triBike as any).ftpSource = 'device';
  saveState();
  console.log(`[AppleHealthSync] Cycling FTP ${Math.round(latest.value)}W from HealthKit (was ${current ?? 'unset'})`);
  return true;
}

/** All HealthKit data types we read. Single combined authorization request. */
const ALL_READ_TYPES: string[] = [
  'calories', 'distance', 'heartRate',               // workouts
  'sleep', 'restingHeartRate', 'heartRateVariability', 'steps',  // physiology
  'appleExerciseTime',                                // exercise ring (active minutes)
];

/** Cached auth flag — avoid re-prompting on every call within the same session. */
let _authRequested = false;

/**
 * Request HealthKit authorization for all data types we need.
 * Only prompts once per app session (iOS remembers the grant across launches).
 */
async function ensureAuthorization(): Promise<typeof import('@capgo/capacitor-health')['Health']> {
  const { Health } = await import('@capgo/capacitor-health');
  if (!_authRequested) {
    await Health.requestAuthorization({ read: ALL_READ_TYPES as any });
    _authRequested = true;
  }
  return Health;
}

// ---------------------------------------------------------------------------
// Workout type mapping
// ---------------------------------------------------------------------------

/**
 * Map @capgo/capacitor-health WorkoutType strings to our internal activity types.
 *
 * Coverage matches the matcher's `mapGarminType` switch so a tennis match on
 * Apple Watch lands in the same `'other'` bucket as a Garmin tennis activity,
 * not as a misclassified walk. Default fallback was previously WALKING; that
 * misclassified every team sport, racket sport, water sport, and yoga
 * session — now `CARDIO`, which the matcher routes to cross-training rather
 * than counting as locomotion.
 */
function mapWorkoutType(type: WorkoutType): GarminActivityRow['activity_type'] {
  switch (type) {
    // Endurance — own categories
    case 'running':                    return 'RUNNING';
    case 'cycling':                    return 'CYCLING';
    case 'swimming':                   return 'SWIMMING';
    case 'walking':                    return 'WALKING';
    case 'hiking':                     return 'HIKING';
    case 'rowing':                     return 'ROWING';
    case 'elliptical':                 return 'ELLIPTICAL';
    case 'stairClimbing':              return 'STAIR_CLIMBING';

    // Strength / studio
    case 'strengthTraining':
    case 'traditionalStrengthTraining':
    case 'crossTraining':              return 'STRENGTH_TRAINING';
    case 'yoga':                       return 'YOGA';

    // Racket + ball sports — match `mapGarminType`'s 'other' bucket
    case 'tennis':                     return 'TENNIS';
    case 'basketball':                 return 'BASKETBALL';
    case 'soccer':                     return 'SOCCER';
    case 'americanFootball':           return 'FOOTBALL';
    case 'baseball':                   return 'SOFTBALL';
    case 'wrestling':                  return 'MARTIAL_ARTS';

    // Water sports — closest internal mapping
    case 'waterFitness':               return 'AEROBIC_TRAINING';
    case 'waterPolo':                  return 'CARDIO';
    case 'waterSports':                return 'PADDLEBOARDING';

    // Catch-all — `CARDIO` routes to cross-training in the matcher rather
    // than the locomotion-style WALKING (which would skew weekly km).
    case 'other':
    default:                           return 'CARDIO';
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/** First-time backfill window — mirrors Strava's 16w `backfill` mode so the
 *  Apple-only path produces equivalent `historicWeeklyTSS` / `ctlBaseline`
 *  / `detectedWeeklyKm` data on initial connection. */
const FIRST_BACKFILL_DAYS = 112;
/** Incremental window for every subsequent launch — last 14 days, dedup keeps
 *  the older workouts intact. */
const INCREMENTAL_DAYS = 14;
/** Concurrency cap for per-workout HR-stream queries. HealthKit reads are
 *  local and fast, but stacking 100+ promises at once burns memory on older
 *  devices. 4 keeps total wall-time under ~2s for 16w of typical data. */
const HR_FETCH_CONCURRENCY = 4;
/** Max samples per heart-rate query. Apple Watch typically samples HR every
 *  2–5s during workouts, so a 3h ride with continuous HR maxes around ~5400
 *  samples. The plugin default is 100 — we explicitly raise it. */
const HR_SAMPLE_LIMIT = 6000;

/**
 * Sync recent Apple Watch workouts to the plan.
 * Called from main.ts after app launch on iOS.
 * Safe to call on every launch — already-processed workouts are skipped
 * by the garminMatched dedup key (keyed as "apple-<stableId>").
 *
 * On first invocation (no `appleHistoryFetched` flag), runs a 16-week backfill
 * with per-workout HR-stream enrichment and aggregates weekly history into
 * `historicWeeklyTSS`, `ctlBaseline`, `detectedWeeklyKm`, `athleteTier` —
 * mirroring `fetchStravaHistory` for the Apple-only path. Subsequent launches
 * use a 14-day incremental window to pick up new workouts cheaply.
 */
export async function syncAppleHealth(): Promise<void> {
  if (!isNativeiOS()) return;

  try {
    const s = getMutableState();
    const isFirstBackfill = !s.appleHistoryFetched;
    const daysBack = isFirstBackfill ? FIRST_BACKFILL_DAYS : INCREMENTAL_DAYS;

    const workouts = await fetchRecentWorkouts(daysBack);
    if (workouts.length === 0) {
      if (isFirstBackfill) {
        // Mark backfill complete even when empty so we don't re-run a 16w
        // query on every launch. User who installs without any historic
        // workouts is just a fresh starter; subsequent syncs will pick up
        // new workouts via the 14d incremental path.
        s.appleHistoryFetched = true;
        s.appleHistoryLastRefreshedAt = new Date().toISOString();
        saveState();
      }
      return;
    }

    // Per-workout HR enrichment: query the HR stream within each workout's
    // [startDate, endDate] window to compute avg_hr, max_hr, iTRIMP, and
    // zone breakdown. Skipped silently when restingHR/maxHR are unset (the
    // matcher then falls back to duration-based TSS, same as before this
    // change). `healMissingITrimp` recovers iTRIMP later once those values
    // arrive (e.g. when user enters maxHR or Garmin sync populates it).
    const enrichment = await enrichWorkoutsWithHR(workouts);

    const rows = workouts.map(w => convertToActivityRow(w, enrichment.get(workoutKey(w))));
    const changed = matchAndAutoComplete(rows);

    // First-time backfill: aggregate weekly history so the plan engine has
    // CTL / weekly km / athlete tier seeds, matching the Strava backfill flow.
    if (isFirstBackfill) {
      aggregateAppleHistory(rows);
      saveState();
    }

    if (changed || isFirstBackfill) render();
    console.log(`[AppleHealthSync] Processed ${rows.length} workouts (window=${daysBack}d, firstBackfill=${isFirstBackfill}, hrEnriched=${enrichment.size})`);

    // Refresh VO2max + cycling FTP every sync. Both are no-ops on web/Android,
    // when the user denied the HealthExtras permission, or when they don't
    // exist in HealthKit (cycling FTP is rare without an external power
    // meter; VO2 needs outdoor GPS runs to update).
    syncAppleVO2().catch(() => null);
    syncAppleCyclingFTP().catch(() => null);
  } catch (err) {
    // Non-fatal — app continues without Apple Health sync
    console.warn('[AppleHealthSync] Sync failed:', err);
  }
}

/**
 * Fetch workouts from HealthKit within the last `daysBack` days.
 */
async function fetchRecentWorkouts(daysBack: number): Promise<Workout[]> {
  const Health = await ensureAuthorization();

  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { workouts } = await Health.queryWorkouts({
    startDate: since.toISOString(),
    endDate: new Date().toISOString(),
    // Hard upper bound — 16 weeks of typical hobbyist activity stays well
    // under 500. Power users training daily across multiple sports may push
    // ~250. We set 1000 as a safety ceiling rather than a realistic target.
    limit: 1000,
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
    const [sleepResult, rhrResult, hrvResult, stepsResult, exerciseResult] = await Promise.all([
      Health.readSamples({ dataType: 'sleep', startDate: sinceISO, endDate: nowISO, limit: 2000, ascending: true }),
      Health.readSamples({ dataType: 'restingHeartRate', startDate: sinceISO, endDate: nowISO, limit: 100, ascending: true }),
      Health.readSamples({ dataType: 'heartRateVariability', startDate: sinceISO, endDate: nowISO, limit: 100, ascending: true }),
      Health.queryAggregated({ dataType: 'steps', startDate: sinceISO, endDate: nowISO, bucket: 'day', aggregation: 'sum' }),
      Health.queryAggregated({ dataType: 'appleExerciseTime' as any, startDate: sinceISO, endDate: nowISO, bucket: 'day', aggregation: 'sum' }),
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

    // ── Index exercise minutes by date ────────────────────────────────────
    // Apple Watch Exercise ring = periods where HR was in exercise zone.
    // Maps directly to our activeMinutes field (same as Garmin epoch active minutes).
    const exerciseByDate = new Map<string, number>();
    for (const sample of exerciseResult.samples) {
      const date = sample.startDate.split('T')[0];
      exerciseByDate.set(date, Math.round(sample.value));
    }

    // ── Build PhysiologyDayEntry per date ──────────────────────────────────
    // Collect all dates that have any data
    const allDates = new Set<string>();
    for (const d of nightMap.keys()) allDates.add(d);
    for (const d of rhrByDate.keys()) allDates.add(d);
    for (const d of hrvByDate.keys()) allDates.add(d);
    for (const d of stepsByDate.keys()) allDates.add(d);
    for (const d of exerciseByDate.keys()) allDates.add(d);

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

      // Exercise minutes (Apple Watch exercise ring → activeMinutes)
      const exerciseMin = exerciseByDate.get(date);
      if (exerciseMin != null && exerciseMin > 0) entry.activeMinutes = exerciseMin;

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
    'sleepLightSec', 'sleepAwakeSec', 'restingHR', 'hrvRmssd', 'steps', 'activeMinutes',
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
 * Per-workout heart-rate enrichment derived from a separate HealthKit
 * `readSamples({ dataType: 'heartRate' })` query inside the workout window.
 * Any field may be null when the underlying user state isn't sufficient
 * (e.g. iTRIMP needs both restingHR and maxHR; zones need calculateZones to
 * resolve). The matcher gracefully falls back to duration-based TSS in that
 * case, and `healMissingITrimp` retries once the missing inputs arrive.
 */
interface HRWorkoutEnrichment {
  avgHR: number;
  maxHR: number;
  iTrimp: number | null;
  hrZones: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  // Optional fields populated by the HealthExtras plugin path (iOS 16+/17+).
  // Absent on web/Android, on permission denial, or when the workout has no
  // matching data (e.g. indoor run with no GPS → no polyline).
  polyline?: string | null;
  kmSplits?: number[] | null;
  bestEfforts?: SyntheticBestEffort[] | null;
  averageWatts?: number | null;
  maxWatts?: number | null;
  /** Coggan-formula normalised power (W). Computed from the 1Hz-resampled
   *  cycling power stream — feeds the FTP estimator's primary path so Apple
   *  cycling FTP matches Strava's precision. Null on runs / when the ride
   *  has fewer than 60s of usable power data. */
  normalizedPowerW?: number | null;
  /** Mean-max power curve (W) for 10/20/30/60-min sliding windows. Same
   *  field name + shape Strava's edge function produces, so the FTP
   *  estimator's `powerCurve top-1 within 12 weeks` path treats Apple data
   *  identically to Strava data. */
  powerCurve?: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
  /** Stream-detected interval reps. For runs: from the GPS distance + time
   *  trace (with HR overlaid when available). For rides: from the cycling
   *  power stream. Null when the activity doesn't look like an interval
   *  session (no clean fast/slow segmentation) or when the stream had too
   *  few points for the detector to run. */
  repData?: import('@/types/state').ActivityRepData | null;
}

/** Stable dedup key for a workout. Same key the row's `garmin_id` is built from. */
function workoutKey(w: Workout): string {
  return `${w.sourceId ?? w.sourceName ?? 'aw'}-${w.startDate}`;
}

/**
 * Convert a @capgo/capacitor-health Workout to the shared GarminActivityRow format.
 * ID prefixed with "apple-" so dedup logic in garminMatched doesn't collide with Garmin/Strava IDs.
 *
 * The HR enrichment param carries avg/max/iTRIMP/zones from a separate HR-stream
 * query. When missing (no Apple Watch data, sparse HR, or restingHR/maxHR not
 * yet known) the matcher uses its duration-based fallback; `healMissingITrimp`
 * fills in iTRIMP later if avgHR is present.
 */
function convertToActivityRow(w: Workout, hr?: HRWorkoutEnrichment): GarminActivityRow {
  const distanceM = w.totalDistance ?? 0;
  const durationSec = Math.round(w.duration);
  const avgPaceSecKm =
    distanceM > 0 ? Math.round((durationSec / distanceM) * 1000) : null;

  const row: GarminActivityRow = {
    garmin_id: `apple-${workoutKey(w)}`,
    activity_type: mapWorkoutType(w.workoutType),
    start_time: w.startDate,
    duration_sec: durationSec,
    distance_m: distanceM > 0 ? Math.round(distanceM) : null,
    avg_pace_sec_km: avgPaceSecKm,
    avg_hr: hr?.avgHR ?? null,
    max_hr: hr?.maxHR ?? null,
    calories: w.totalEnergyBurned ? Math.round(w.totalEnergyBurned) : null,
    aerobic_effect: null,  // HealthKit does not expose Training Effect
    anaerobic_effect: null,
    garmin_rpe: null,
    iTrimp: hr?.iTrimp ?? null,
    hrZones: hr?.hrZones ?? null,
    polyline: hr?.polyline ?? null,
    kmSplits: hr?.kmSplits ?? null,
    averageWatts: hr?.averageWatts ?? null,
    maxWatts: hr?.maxWatts ?? null,
    normalizedPowerW: hr?.normalizedPowerW ?? null,
    powerCurve: hr?.powerCurve ?? null,
    // HealthKit cycling power comes from a paired meter or Apple's calculation;
    // either way it's a real device reading (not Strava's estimated-from-speed
    // fallback). Setting deviceWatts=true gates the FTP estimator's "real
    // meter only" rule correctly for Apple users.
    deviceWatts: (hr?.averageWatts != null && hr.averageWatts > 0) ? true : null,
    repData: hr?.repData ?? null,
  };
  // best_efforts isn't part of GarminActivityRow's typed surface — it lives on
  // the wider `cachedActivities` shape that pbs-from-history reads. We attach
  // it via index assignment so the same row carries the data through to the
  // review-step PB extractor without forcing a type widening on every call site.
  if (hr?.bestEfforts && hr.bestEfforts.length > 0) {
    (row as any).best_efforts = hr.bestEfforts;
  }
  return row;
}

// ---------------------------------------------------------------------------
// HR-stream enrichment
// ---------------------------------------------------------------------------

/**
 * For each workout, query its HR samples within [startDate, endDate] and
 * compute avgHR / maxHR / iTRIMP / zones. Returns a map keyed by workoutKey
 * so the caller can splice the data into the converted rows.
 *
 * Edge cases handled:
 *   - HR permission denied  → `samples` is empty; nothing added to map.
 *   - Sparse HR (< 2 samples) → skipped; matcher falls back to duration TSS.
 *   - restingHR or maxHR unset → iTRIMP left null (heal pass recovers later).
 *   - Plugin/network/SDK errors → caught per-workout, sync continues.
 */
async function enrichWorkoutsWithHR(workouts: Workout[]): Promise<Map<string, HRWorkoutEnrichment>> {
  const result = new Map<string, HRWorkoutEnrichment>();
  if (workouts.length === 0) return result;

  // Bulk-fetch GPS routes covering the whole window once. HKWorkoutRoute is a
  // separate series type — querying per-workout would mean N HealthKit reads;
  // a single date-range read returns all routes in milliseconds. We then
  // match by workout startDate inside the per-workout loop. Returns [] on
  // older OS, missing permission, or web/Android.
  const oldestStart = workouts.reduce(
    (acc, w) => (acc < w.startDate ? acc : w.startDate),
    workouts[0].startDate,
  );
  const newestEnd = workouts.reduce(
    (acc, w) => (acc > w.endDate ? acc : w.endDate),
    workouts[0].endDate,
  );
  const routes = await readWorkoutRouteLocations({ startDate: oldestStart, endDate: newestEnd });

  const Health = await ensureAuthorization();
  const s = getMutableState();
  const sex = s.biologicalSex === 'male' || s.biologicalSex === 'female' ? s.biologicalSex : undefined;
  const restingHR = (s.restingHR && s.restingHR > 0) ? s.restingHR : null;
  const userMaxHR = (s.maxHR && s.maxHR > 0) ? s.maxHR : null;
  // Resolve a maxHR for the iTRIMP integration: explicit s.maxHR wins, else
  // Tanaka 208 - 0.7 × age (Tanaka et al. 2001 — better than 220−age, valid
  // 18–80y). Apple Watch doesn't expose true maxHR directly, so for an
  // Apple-only user this is the best fallback we have without lab testing.
  // null when neither is available → iTRIMP stays null, healMissingITrimp
  // recovers later.
  const age = s.onboarding?.age;
  const tanakaMaxHR = (age && age >= 14 && age <= 90) ? Math.round(208 - 0.7 * age) : null;
  const resolvedMaxHR = userMaxHR ?? tanakaMaxHR;
  // `s.lt` is a pace in sec/km, NOT lactate-threshold HR — calculateZones
  // wants LTHR (bpm), so we don't pass it here. Maxhr/restinghr-Karvonen is
  // the realistic best path; age fallback inside calculateZones covers the
  // remaining cold-start case.
  const zones = calculateZones({
    maxHR: resolvedMaxHR ?? undefined,
    restingHR: restingHR ?? undefined,
    age: age ?? undefined,
  });

  for (let i = 0; i < workouts.length; i += HR_FETCH_CONCURRENCY) {
    const chunk = workouts.slice(i, i + HR_FETCH_CONCURRENCY);
    await Promise.all(chunk.map(async (w) => {
      const key = workoutKey(w);
      try {
        // HR stream + power samples in parallel. Power is only meaningful for
        // run/ride; we still always query so the chunk's await time is bounded
        // by HR (the slow query). HealthKit returns empty arrays for
        // unavailable types — same as a permission denial — and we treat both
        // identically.
        const sport = mapWorkoutType(w.workoutType);
        const isRun = sport === 'RUNNING';
        const isRide = sport === 'CYCLING';

        const [hrRes, powerSamples] = await Promise.all([
          Health.readSamples({
            dataType: 'heartRate',
            startDate: w.startDate,
            endDate: w.endDate,
            limit: HR_SAMPLE_LIMIT,
            ascending: true,
          }),
          isRun
            ? readQuantitySamples({
                dataType: 'runningPower',
                startDate: w.startDate,
                endDate: w.endDate,
                limit: HR_SAMPLE_LIMIT,
                ascending: true,
              })
            : isRide
            ? readQuantitySamples({
                dataType: 'cyclingPower',
                startDate: w.startDate,
                endDate: w.endDate,
                limit: HR_SAMPLE_LIMIT,
                ascending: true,
              })
            : Promise.resolve([]),
        ]);

        const samples = hrRes.samples ?? [];
        if (samples.length < 2) {
          // No HR — still attach route + power if we have either, so the
          // activity surfaces an enriched view despite missing iTRIMP.
          const enrichment = buildEnrichmentWithoutHR(w, routes, powerSamples, isRun, isRide);
          if (enrichment) result.set(key, enrichment);
          return;
        }
        const base = computeHREnrichment(samples, w.startDate, restingHR, resolvedMaxHR, zones, sex);
        if (!base) return;

        // Splice route + power + rep detection onto the HR-derived enrichment.
        const enriched = decorateWithRouteAndPower(base, w, routes, samples, powerSamples, isRun, isRide);
        result.set(key, enriched);
      } catch (err) {
        // Per-workout failure is non-fatal — leave row un-enriched and continue.
        console.warn(`[AppleHealthSync] HR enrichment failed for workout ${key}:`, err);
      }
    }));
  }

  // Observed-maxHR refinement. Apple Watch doesn't expose a true maxHR field,
  // but a user's HR during their hardest interval session lands within 1–2 bpm
  // of their lab-measured max — far closer than Tanaka's population formula
  // (208 − 0.7×age can be off by 10–15 bpm individually). After 16 weeks of
  // workouts we have enough hard sessions for an observed peak to be a better
  // estimate than the Tanaka fallback.
  //
  // Gating:
  //   1. ≥ 3 workouts with peak ≥ 150 bpm — single-workout glitch (cold-start
  //      sensor jumps) won't move the value; need a pattern of hard efforts.
  //   2. Observed > current s.maxHR (or s.maxHR null) — never write a lower
  //      value, since maxHR can only be observed-or-greater than what's stored.
  // Mirrors the CLAUDE.md "Manually-set Benchmarks Yield to Improvements" rule.
  const workoutPeaks = [...result.values()].map(e => e.maxHR).filter(p => p >= 150);
  if (workoutPeaks.length >= 3) {
    const observedPeak = Math.max(...workoutPeaks);
    const current = s.maxHR;
    if (!current || observedPeak > current) {
      console.log(`[AppleHealthSync] Observed maxHR ${observedPeak} bpm from ${workoutPeaks.length} hard workouts (was ${current ?? 'unset'})`);
      s.maxHR = observedPeak;
      saveState();
    }
  }

  return result;
}

/**
 * Reduce raw HR samples + a workout start timestamp into avg/max/iTRIMP/zones.
 * Returns null when the sample set has too few valid points to be meaningful.
 *
 * - HR values outside [30, 240] bpm are dropped (Apple Watch occasionally
 *   reports erratic readings during cold-start and motion-artefact windows).
 * - Sample-to-sample gaps over 5 min are excluded from zone time and from
 *   iTRIMP integration so a paused-workout gap doesn't inflate the load.
 */
function computeHREnrichment(
  samples: HealthSample[],
  workoutStartISO: string,
  restingHR: number | null,
  userMaxHR: number | null,
  zones: HRZones | undefined,
  sex: 'male' | 'female' | undefined,
): HRWorkoutEnrichment | null {
  const startMs = new Date(workoutStartISO).getTime();
  const hrValues: number[] = [];
  const timeOffsets: number[] = [];
  let sum = 0, count = 0, observedMax = 0;
  for (const sample of samples) {
    const bpm = sample.value;
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) continue;
    const t = (new Date(sample.startDate).getTime() - startMs) / 1000;
    if (!Number.isFinite(t) || t < 0) continue;
    hrValues.push(bpm);
    timeOffsets.push(t);
    sum += bpm;
    count++;
    if (bpm > observedMax) observedMax = bpm;
  }
  if (count < 2) return null;

  const avgHR = Math.round(sum / count);
  const maxHR = Math.round(observedMax);

  let iTrimp: number | null = null;
  if (restingHR && userMaxHR && userMaxHR > restingHR) {
    const computed = calculateITrimp(hrValues, timeOffsets, restingHR, userMaxHR, sex);
    if (computed > 0) iTrimp = Math.round(computed);
  }

  let hrZones: HRWorkoutEnrichment['hrZones'] = null;
  if (zones) {
    const z = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    for (let i = 1; i < hrValues.length; i++) {
      const dt = timeOffsets[i] - timeOffsets[i - 1];
      if (dt <= 0 || dt > 300) continue; // skip pause-gaps
      const bpm = hrValues[i];
      if (bpm < zones.z2.min) z.z1 += dt;
      else if (bpm < zones.z3.min) z.z2 += dt;
      else if (bpm < zones.z4.min) z.z3 += dt;
      else if (bpm < zones.z5.min) z.z4 += dt;
      else z.z5 += dt;
    }
    hrZones = {
      z1: Math.round(z.z1),
      z2: Math.round(z.z2),
      z3: Math.round(z.z3),
      z4: Math.round(z.z4),
      z5: Math.round(z.z5),
    };
  }

  return { avgHR, maxHR, iTrimp, hrZones };
}

/**
 * Splice route (polyline + km splits + best-efforts) and power samples onto
 * an HR-derived enrichment. Pure data-shape function — no HealthKit calls.
 */
function decorateWithRouteAndPower(
  base: HRWorkoutEnrichment,
  w: Workout,
  routes: Array<{ startDate: string; endDate: string; locations: RouteLocation[] }>,
  hrSamples: HealthSample[],
  powerSamples: Array<{ value: number; startDate: string; endDate: string }>,
  isRun: boolean,
  isRide: boolean,
): HRWorkoutEnrichment {
  const route = findRouteForWorkout(routes, w.startDate);
  let polyline: string | null = null;
  let kmSplits: number[] | null = null;
  let bestEfforts: SyntheticBestEffort[] | null = null;
  if (route && route.length >= 2) {
    polyline = buildPolylineFromLocations(route);
    kmSplits = extractKmSplits(route);
    if (isRun) {
      const efforts = extractBestEfforts(route, w.startDate);
      if (efforts.length > 0) bestEfforts = efforts;
    }
  }

  const powerStats = computePowerStats(powerSamples);
  // Compute NP + powerCurve only for rides (running power doesn't follow
  // the same energy-systems model — Coggan's NP formula is calibrated for
  // cycling). The FTP estimator only consumes powerCurve from cycling rides.
  const powerCurveData = isRide
    ? computeNPAndPowerCurve(powerSamples)
    : { normalizedPowerW: null, powerCurve: null };

  // Stream-based rep detection. Closes the rep-detection gap that previously
  // applied only to Strava users — Apple's GPS trace (for runs) or per-second
  // power stream (for rides) feeds the same detector that the Strava /laps
  // path falls through to. Returns null when the activity doesn't look like
  // an interval session, when the stream is too short, or when nothing
  // qualified as a rep.
  let repData: ActivityRepData | null = null;
  if (isRun && route && route.length >= 60) {
    const det = detectRunRepsFromRoute(route, hrSamples);
    if (det) repData = detectionToRepData(det);
  } else if (isRide && powerSamples.length >= 60) {
    const det = detectBikeRepsFromPowerSamples(powerSamples, hrSamples);
    if (det) repData = detectionToRepData(det);
  }
  // HR-only fallback — fires when GPS (run) / power (ride) detection didn't
  // produce a usable rep cluster. Catches treadmill long-interval sessions
  // and trainer rides without a power meter. Short-rep sessions (< 90s reps)
  // still fall through to no-rep-data; that's a hardware limitation of the
  // HR signal and acceptable.
  if (!repData && (isRun || isRide) && hrSamples.length >= 60) {
    const det = detectRepsFromHRSamples(hrSamples);
    if (det) repData = detectionToRepData(det);
  }

  return {
    ...base,
    polyline,
    kmSplits,
    bestEfforts,
    averageWatts: powerStats.avg,
    maxWatts: powerStats.max,
    normalizedPowerW: powerCurveData.normalizedPowerW,
    powerCurve: powerCurveData.powerCurve,
    repData,
  };
}

/**
 * Build an enrichment record when no HR stream exists but we still have
 * route or power data worth attaching. Indoor runs without GPS produce
 * neither, so the function returns null and the row stays un-enriched.
 */
function buildEnrichmentWithoutHR(
  w: Workout,
  routes: Array<{ startDate: string; endDate: string; locations: RouteLocation[] }>,
  powerSamples: Array<{ value: number; startDate: string; endDate: string }>,
  isRun: boolean,
  isRide: boolean,
): HRWorkoutEnrichment | null {
  const route = findRouteForWorkout(routes, w.startDate);
  const powerStats = computePowerStats(powerSamples);
  const hasRoute = route && route.length >= 2;
  const hasPower = powerStats.avg != null;
  if (!hasRoute && !hasPower) return null;

  let polyline: string | null = null;
  let kmSplits: number[] | null = null;
  let bestEfforts: SyntheticBestEffort[] | null = null;
  if (hasRoute) {
    polyline = buildPolylineFromLocations(route);
    kmSplits = extractKmSplits(route);
    if (isRun) {
      const efforts = extractBestEfforts(route, w.startDate);
      if (efforts.length > 0) bestEfforts = efforts;
    }
  }

  // Rep detection is still possible without HR — pace-stream for runs and
  // power-stream for rides are the primary signals. HR overlay just decorates
  // the per-rep avgHR field.
  let repData: ActivityRepData | null = null;
  if (isRun && route && route.length >= 60) {
    const det = detectRunRepsFromRoute(route, []);
    if (det) repData = detectionToRepData(det);
  } else if (isRide && powerSamples.length >= 60) {
    const det = detectBikeRepsFromPowerSamples(powerSamples, []);
    if (det) repData = detectionToRepData(det);
  }

  const powerCurveData = isRide
    ? computeNPAndPowerCurve(powerSamples)
    : { normalizedPowerW: null, powerCurve: null };

  // We need to satisfy HRWorkoutEnrichment's required avg/max — emit zeros
  // so the matcher still reads the row, and downstream HR-required logic
  // (zone scoring, iTRIMP) skips it because hr is 0.
  return {
    avgHR: 0,
    maxHR: 0,
    iTrimp: null,
    hrZones: null,
    polyline,
    kmSplits,
    bestEfforts,
    averageWatts: powerStats.avg,
    maxWatts: powerStats.max,
    normalizedPowerW: powerCurveData.normalizedPowerW,
    powerCurve: powerCurveData.powerCurve,
    repData,
  };
}

/**
 * Adapter: convert a route's `RouteLocation[]` into the `(distData, timeData,
 * hrData)` shape `detectRunRepsFromStream` expects, then call the detector.
 *
 * - distData[i] = cumulative metres travelled at location i (haversine sum)
 * - timeData[i] = elapsed seconds since the first location's timestamp
 * - hrData[i]   = HR at location i (nearest-neighbour from `hrSamples` by
 *                 timestamp). Caller may pass [] when no HR is available;
 *                 the detector handles a null hrData branch.
 */
function detectRunRepsFromRoute(
  route: RouteLocation[],
  hrSamples: HealthSample[],
): DetectionResult | null {
  const n = route.length;
  if (n < 60) return null;
  const t0 = new Date(route[0].timestamp).getTime();
  const distData = new Array<number>(n);
  const timeData = new Array<number>(n);
  let cum = 0;
  distData[0] = 0;
  timeData[0] = 0;
  for (let i = 1; i < n; i++) {
    const prev = route[i - 1];
    const cur = route[i];
    cum += haversineMetres(prev.lat, prev.lng, cur.lat, cur.lng);
    distData[i] = cum;
    timeData[i] = (new Date(cur.timestamp).getTime() - t0) / 1000;
  }

  // Build HR per location-index via nearest-neighbour. HR samples come at a
  // different cadence (~5s on Apple Watch in workout mode) than GPS (~1s),
  // so for each location we find the HR sample with the closest timestamp.
  let hrAligned: number[] | null = null;
  if (hrSamples.length >= 2) {
    // Sort once; binary-search per location.
    const hrTimes = hrSamples.map(s => new Date(s.startDate).getTime());
    const hrValues = hrSamples.map(s => s.value);
    hrAligned = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const target = t0 + timeData[i] * 1000;
      // Binary search for insertion point.
      let lo = 0;
      let hi = hrTimes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (hrTimes[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      // Compare neighbours, take closest.
      const idx = lo;
      const prevIdx = idx > 0 ? idx - 1 : 0;
      const distNext = Math.abs(hrTimes[idx] - target);
      const distPrev = Math.abs(hrTimes[prevIdx] - target);
      hrAligned[i] = distPrev < distNext ? hrValues[prevIdx] : hrValues[idx];
    }
  }

  return detectRunRepsFromStream(distData, timeData, hrAligned);
}

/**
 * Adapter: convert HK power samples into the `(wattsData, timeData, distData,
 * hrData)` shape `detectBikeRepsFromPower` expects.
 */
function detectBikeRepsFromPowerSamples(
  powerSamples: Array<{ value: number; startDate: string; endDate: string }>,
  hrSamples: HealthSample[],
): DetectionResult | null {
  const n = powerSamples.length;
  if (n < 60) return null;
  const t0 = new Date(powerSamples[0].startDate).getTime();
  const wattsData = new Array<number>(n);
  const timeData = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    wattsData[i] = powerSamples[i].value;
    timeData[i] = (new Date(powerSamples[i].startDate).getTime() - t0) / 1000;
  }

  let hrAligned: number[] | null = null;
  if (hrSamples.length >= 2) {
    const hrTimes = hrSamples.map(s => new Date(s.startDate).getTime());
    const hrValues = hrSamples.map(s => s.value);
    hrAligned = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const target = t0 + timeData[i] * 1000;
      let lo = 0;
      let hi = hrTimes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (hrTimes[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const idx = lo;
      const prevIdx = idx > 0 ? idx - 1 : 0;
      const distNext = Math.abs(hrTimes[idx] - target);
      const distPrev = Math.abs(hrTimes[prevIdx] - target);
      hrAligned[i] = distPrev < distNext ? hrValues[prevIdx] : hrValues[idx];
    }
  }

  return detectBikeRepsFromPower(wattsData, timeData, null, hrAligned);
}

/**
 * Adapter: convert HealthKit `HealthSample[]` HR readings into the
 * `(hrData, timeData)` shape `detectRepsFromHRStream` expects, then call it.
 *
 * Filters out invalid samples (HR <= 30 or > 240 bpm) and re-bases time to
 * seconds since the first valid sample.
 */
function detectRepsFromHRSamples(samples: HealthSample[]): DetectionResult | null {
  if (!samples || samples.length < 60) return null;
  const valid: Array<{ value: number; ts: number }> = [];
  for (const s of samples) {
    const bpm = s.value;
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) continue;
    const ts = new Date(s.startDate).getTime();
    if (!Number.isFinite(ts)) continue;
    valid.push({ value: bpm, ts });
  }
  if (valid.length < 60) return null;

  const t0 = valid[0].ts;
  const hrData = valid.map(v => v.value);
  const timeData = valid.map(v => (v.ts - t0) / 1000);
  return detectRepsFromHRStream(hrData, timeData);
}

/** Convert a DetectionResult into the ActivityRepData shape consumed downstream. */
function detectionToRepData(det: DetectionResult): ActivityRepData {
  return {
    reps: det.reps.map(r => ({
      index: r.index,
      distanceM: r.distanceM,
      durationSec: r.durationSec,
      paceSecKm: r.paceSecKm ?? null,
      avgHR: r.avgHR ?? null,
      avgWatts: r.avgWatts ?? null,
    })),
    source: det.source,
  };
}

/** Haversine distance between two points (m). Mirrors the helper in
 *  `appleHealthRoute.ts` — duplicated here to keep `decorateWithRouteAndPower`
 *  self-contained without forcing an export. */
function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Aggregate average + peak from a power-sample array. Both null when empty. */
function computePowerStats(
  samples: Array<{ value: number; startDate: string; endDate: string }>,
): { avg: number | null; max: number | null } {
  if (!samples || samples.length === 0) return { avg: null, max: null };
  let sum = 0;
  let count = 0;
  let max = 0;
  for (const s of samples) {
    const w = s.value;
    if (!Number.isFinite(w) || w < 0 || w > 2000) continue; // sanity gate
    sum += w;
    count++;
    if (w > max) max = w;
  }
  if (count === 0) return { avg: null, max: null };
  return { avg: Math.round(sum / count), max: Math.round(max) };
}

/**
 * Derive normalized power (NP) and a mean-max power curve from a
 * variable-rate watts stream, matching the shape Strava's edge function
 * computes for the FTP estimator. Without these fields, Apple cycling rides
 * fall through to the avgWatts fallback (~80% of true FTP); with them, the
 * estimator hits its primary `powerCurve top-1 within 12 weeks` path and
 * Apple FTP precision matches Strava's.
 *
 * Algorithm:
 *   1. Resample the stream to a uniform 1Hz watts series via linear
 *      interpolation between adjacent samples.
 *   2. NP = (mean(rolling30s^4))^(1/4) — Coggan's normalised power formula.
 *   3. powerCurve.pW = max W-second mean over all sliding windows.
 *
 * Returns nulls when the ride is too short for the window in question
 * (e.g. a 30-min ride has no p3600 entry).
 */
function computeNPAndPowerCurve(
  samples: Array<{ value: number; startDate: string; endDate: string }>,
): {
  normalizedPowerW: number | null;
  powerCurve: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
} {
  if (samples.length < 30) return { normalizedPowerW: null, powerCurve: null };

  const t0 = new Date(samples[0].startDate).getTime();
  const times = samples.map(s => (new Date(s.startDate).getTime() - t0) / 1000);
  const watts = samples.map(s => Math.max(0, Math.min(2000, s.value)));
  const totalSec = Math.floor(times[times.length - 1]);
  if (totalSec < 60) return { normalizedPowerW: null, powerCurve: null };

  // Resample to uniform 1Hz via linear interpolation between adjacent samples.
  const hz = new Array<number>(totalSec + 1).fill(0);
  let j = 0;
  for (let s = 0; s <= totalSec; s++) {
    while (j + 1 < times.length && times[j + 1] <= s) j++;
    const tA = times[j];
    const tB = j + 1 < times.length ? times[j + 1] : tA;
    if (tA === tB) {
      hz[s] = watts[j];
    } else {
      const frac = (s - tA) / (tB - tA);
      hz[s] = watts[j] + Math.max(0, Math.min(1, frac)) * (watts[j + 1] - watts[j]);
    }
  }

  // 30-sec rolling mean (boxcar). Coggan's NP uses a 30s smoothing window
  // before raising to the 4th power.
  const NP_WINDOW = 30;
  const rolling = new Array<number>(hz.length).fill(0);
  let sumWin = 0;
  for (let i = 0; i < hz.length; i++) {
    sumWin += hz[i];
    if (i >= NP_WINDOW) sumWin -= hz[i - NP_WINDOW];
    rolling[i] = i >= NP_WINDOW - 1 ? sumWin / NP_WINDOW : sumWin / (i + 1);
  }

  // NP = (mean(rolling^4))^(1/4) over samples where the 30s window is full.
  let sum4 = 0;
  let n4 = 0;
  for (let i = NP_WINDOW - 1; i < rolling.length; i++) {
    const r = rolling[i];
    if (r > 0) {
      sum4 += r * r * r * r;
      n4++;
    }
  }
  const np = n4 > 0 ? Math.round(Math.pow(sum4 / n4, 0.25)) : null;

  // Mean-max for each window size. Sliding-sum O(n) per window.
  const meanMax = (windowSec: number): number | null => {
    if (hz.length < windowSec) return null;
    let sum = 0;
    for (let i = 0; i < windowSec; i++) sum += hz[i];
    let max = sum;
    for (let i = windowSec; i < hz.length; i++) {
      sum += hz[i] - hz[i - windowSec];
      if (sum > max) max = sum;
    }
    return Math.round(max / windowSec);
  };
  const powerCurve = {
    p600: meanMax(600),
    p1200: meanMax(1200),
    p1800: meanMax(1800),
    p3600: meanMax(3600),
  };
  const hasAnyWindow = Object.values(powerCurve).some(v => v != null);

  return {
    normalizedPowerW: np,
    powerCurve: hasAnyWindow ? powerCurve : null,
  };
}

// ---------------------------------------------------------------------------
// Weekly history aggregation (Strava-history parity)
// ---------------------------------------------------------------------------

/**
 * Aggregate the 16-week backfill into per-week totals and write the same
 * state fields that `fetchStravaHistory` (in stravaSync.ts) sets — so the
 * plan engine, athlete tier, ACWR baseline, and weekly km detection all
 * work for an Apple-only user without any Strava data.
 *
 * Mirrors the math in stravaSync.ts:fetchStravaHistory, the only differences
 * being the input source (local rows vs. DB-aggregated edge fn) and that
 * sport-level breakdown is left empty (used only for cross-training session
 * baselines, which the plan engine treats as optional Phase 2 calibration).
 *
 * Run only on first connection; subsequent launches use the 14-day incremental
 * sync path which doesn't re-aggregate. A future weekly-refresh pass can call
 * this again from main.ts when `appleHistoryLastRefreshedAt` is older than 7
 * days, mirroring the Strava refresh logic.
 */
function aggregateAppleHistory(rows: GarminActivityRow[]): void {
  const s = getMutableState();

  const thisMondayISO = mondayOfISO(new Date());

  // Bucket rows by Monday-of-week
  const byWeek = new Map<string, GarminActivityRow[]>();
  for (const row of rows) {
    const monday = mondayOfISO(new Date(row.start_time));
    if (monday >= thisMondayISO) continue; // exclude in-progress current week
    if (!byWeek.has(monday)) byWeek.set(monday, []);
    byWeek.get(monday)!.push(row);
  }

  // Calendar-fill 16 completed weeks back from this Monday so the array
  // index → calendar offset mapping is stable (same reasoning as Strava
  // history's zero-fill loop).
  const completedWeeks: { tss: number; rawTSS: number; runningKm: number; zoneBase: number; zoneThreshold: number; zoneIntensity: number }[] = [];
  const thisMondayDate = new Date(thisMondayISO + 'T00:00:00Z');
  for (let i = 16; i >= 1; i--) {
    const d = new Date(thisMondayDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const ws = d.toISOString().slice(0, 10);
    completedWeeks.push(buildAppleWeekTotals(byWeek.get(ws) ?? []));
  }

  s.historicWeeklyTSS = completedWeeks.map(w => w.tss);
  s.historicWeeklyRawTSS = completedWeeks.map(w => w.rawTSS);
  s.historicWeeklyKm = completedWeeks.map(w => w.runningKm);
  s.historicWeeklyZones = completedWeeks.map(w => ({
    base: w.zoneBase, threshold: w.zoneThreshold, intensity: w.zoneIntensity,
  }));

  // Signal A CTL baseline (42-day EMA over completed weeks)
  const CTL_DECAY = Math.exp(-7 / 42);
  let ctl = 0;
  for (const tss of s.historicWeeklyTSS) {
    ctl = ctl * CTL_DECAY + tss * (1 - CTL_DECAY);
  }
  s.ctlBaseline = Math.round(ctl);

  // Signal B baseline = median of nonzero weekly raw TSS (resistant to
  // injury/holiday weeks dragging the average down).
  const nonzero = (s.historicWeeklyRawTSS ?? []).filter(v => v > 0).sort((a, b) => a - b);
  if (nonzero.length > 0) {
    const mid = Math.floor(nonzero.length / 2);
    s.signalBBaseline = nonzero.length % 2 === 0
      ? Math.round((nonzero[mid - 1] + nonzero[mid]) / 2)
      : nonzero[mid];
  }

  // Average weekly running km (last 4 weeks) — used to seed plan starting volume.
  const recentKm = s.historicWeeklyKm.slice(-4);
  s.detectedWeeklyKm = recentKm.length > 0
    ? Math.round(recentKm.reduce((a, b) => a + b, 0) / recentKm.length * 10) / 10
    : undefined;

  s.athleteTier = deriveAthleteTier(s.ctlBaseline ?? 0, {
    vdot: s.v,
    ftpWatts: s.onboarding?.triBike?.ftp,
  });

  s.appleHistoryFetched = true;
  s.appleHistoryLastRefreshedAt = new Date().toISOString();

  // PB auto-fill from synthesized best_efforts. Each running row may carry a
  // `best_efforts` array (computed in `decorateWithRouteAndPower`) listing the
  // fastest 5K / 10K / Half / Marathon segments inside that workout's GPS
  // trace. We aggregate across all rows and pick the fastest per distance,
  // then merge into `s.pbs` and `s.onboarding.pbs` with the fastest-wins rule
  // — same shape Strava's `best_efforts` flow produces. This is the
  // mechanism that lets an Apple-only user reach the review step with their
  // PBs auto-populated, mirroring the Strava onboarding experience.
  applyApplePBsFromRows(rows);

  console.log(`[AppleHealthHistory] 16w aggregated — CTL=${s.ctlBaseline}, signalB=${s.signalBBaseline}, weeklyKm=${s.detectedWeeklyKm}, tier=${s.athleteTier}`);

  // Heal pass — if any rows synced before restingHR/maxHR were known, this
  // populates iTrimp from avgHR + duration after aggregation completes (so
  // the next weekly refresh picks up the full signal).
  healMissingITrimp();
}

/**
 * Aggregate `best_efforts` from all running rows in the backfill into
 * canonical PBs and merge into `s.pbs` / `s.onboarding.pbs` (fastest-wins).
 * Mirrors the Strava-history PB extraction in `pbs-from-history.ts` but
 * computes the source data locally from polylines instead of consuming
 * Strava's pre-computed `best_efforts` field.
 */
function applyApplePBsFromRows(rows: GarminActivityRow[]): void {
  const fastest: { k5?: number; k10?: number; h?: number; m?: number } = {};
  for (const row of rows) {
    const efforts = (row as any).best_efforts as SyntheticBestEffort[] | undefined;
    if (!efforts || efforts.length === 0) continue;
    for (const e of efforts) {
      const t = e.elapsed_time;
      if (!Number.isFinite(t) || t <= 0) continue;
      switch (e.name) {
        case '5K':
          if (fastest.k5 == null || t < fastest.k5) fastest.k5 = t;
          break;
        case '10K':
          if (fastest.k10 == null || t < fastest.k10) fastest.k10 = t;
          break;
        case 'Half Marathon':
          if (fastest.h == null || t < fastest.h) fastest.h = t;
          break;
        case 'Marathon':
          if (fastest.m == null || t < fastest.m) fastest.m = t;
          break;
      }
    }
  }
  if (fastest.k5 == null && fastest.k10 == null && fastest.h == null && fastest.m == null) return;

  const s = getMutableState();
  // Top-level PBs — fastest-wins merge.
  const next = { ...(s.pbs ?? {}) } as Record<string, number>;
  if (fastest.k5 != null && (next.k5 == null || fastest.k5 < next.k5)) next.k5 = fastest.k5;
  if (fastest.k10 != null && (next.k10 == null || fastest.k10 < next.k10)) next.k10 = fastest.k10;
  if (fastest.h != null && (next.h == null || fastest.h < next.h)) next.h = fastest.h;
  if (fastest.m != null && (next.m == null || fastest.m < next.m)) next.m = fastest.m;
  s.pbs = next as any;

  // Mirror into onboarding.pbs so the review-step Continue gate sees them.
  if (s.onboarding) {
    const nextOnb = { ...(s.onboarding.pbs ?? {}) } as Record<string, number>;
    if (fastest.k5 != null && (nextOnb.k5 == null || fastest.k5 < nextOnb.k5)) nextOnb.k5 = fastest.k5;
    if (fastest.k10 != null && (nextOnb.k10 == null || fastest.k10 < nextOnb.k10)) nextOnb.k10 = fastest.k10;
    if (fastest.h != null && (nextOnb.h == null || fastest.h < nextOnb.h)) nextOnb.h = fastest.h;
    if (fastest.m != null && (nextOnb.m == null || fastest.m < nextOnb.m)) nextOnb.m = fastest.m;
    s.onboarding.pbs = nextOnb as any;
  }

  console.log(`[AppleHealthSync] PB auto-fill — k5=${fastest.k5 ?? '-'}, k10=${fastest.k10 ?? '-'}, h=${fastest.h ?? '-'}, m=${fastest.m ?? '-'}`);
}

/** Compute per-week totals — mirrors the per-row math in stravaSync's edge fn. */
function buildAppleWeekTotals(rows: GarminActivityRow[]): {
  tss: number; rawTSS: number; runningKm: number;
  zoneBase: number; zoneThreshold: number; zoneIntensity: number;
} {
  let tss = 0, rawTSS = 0, runningKm = 0;
  let zBase = 0, zThr = 0, zInt = 0;
  for (const row of rows) {
    const sportKey = mapActivityTypeToSportKey(row.activity_type);
    const cfg = (SPORTS_DB as Record<string, { runSpec?: number }>)[sportKey];
    const runSpec = cfg?.runSpec ?? 0.40; // fallback for unknown sports — same default the rest of the app uses
    const isRun = sportKey === 'running';

    const durationMin = row.duration_sec / 60;
    const iTrimp = row.iTrimp ?? null;
    // Signal B (raw physiological): iTRIMP-based when available, else
    // RPE-4 fallback (~0.92 TL/min) which matches the matcher's heuristic
    // at activity-matcher.ts:611.
    const raw = (iTrimp != null && iTrimp > 0)
      ? (iTrimp * 100) / 15000
      : durationMin * 0.92;
    rawTSS += raw;
    // Signal A (run-equiv): runs count fully, cross-training gets discounted by runSpec.
    tss += isRun ? raw : raw * runSpec;

    if (isRun && row.distance_m) runningKm += row.distance_m / 1000;

    if (row.hrZones) {
      const z = row.hrZones;
      const totalSec = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
      if (totalSec > 0) {
        const tssShare = isRun ? raw : raw * runSpec;
        zBase += tssShare * (z.z1 + z.z2) / totalSec;
        zThr  += tssShare * (z.z3) / totalSec;
        zInt  += tssShare * (z.z4 + z.z5) / totalSec;
      }
    }
  }
  return {
    tss: Math.round(tss),
    rawTSS: Math.round(rawTSS),
    runningKm: Math.round(runningKm * 10) / 10,
    zoneBase: Math.round(zBase),
    zoneThreshold: Math.round(zThr),
    zoneIntensity: Math.round(zInt),
  };
}

/** Map our `activity_type` strings (set by `mapWorkoutType`) to SPORTS_DB keys
 *  so we can apply the right `runSpec` for Signal A. */
function mapActivityTypeToSportKey(activityType: string): string {
  switch (activityType) {
    case 'RUNNING':            return 'running';
    case 'CYCLING':            return 'cycling';
    case 'SWIMMING':           return 'swimming';
    case 'WALKING':            return 'walking';
    case 'HIKING':             return 'hiking';
    case 'STRENGTH_TRAINING':  return 'strength';
    case 'ELLIPTICAL':         return 'elliptical';
    case 'ROWING':             return 'rowing';
    case 'STAIR_CLIMBING':     return 'stair_climbing';
    default:                   return 'generic_sport';
  }
}

/** ISO date (YYYY-MM-DD) of the Monday in the same UTC week as `d`. */
function mondayOfISO(d: Date): string {
  const utcDay = d.getUTCDay();
  const daysToMonday = utcDay === 0 ? -6 : 1 - utcDay;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() + daysToMonday);
  return m.toISOString().slice(0, 10);
}
