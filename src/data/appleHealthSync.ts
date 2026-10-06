/**
 * Apple Health / Apple Watch sync.
 *
 * Uses @capgo/capacitor-health when running as a native iOS app, and falls
 * back to a no-op when running in browser/web mode.
 *
 * npx cap sync ios. Run after `npm install @capgo/capacitor-health`
 *
 * Required Info.plist keys:
 *   NSHealthShareUsageDescription. "Mosaic reads workouts, sleep, heart rate
 *     variability, and resting heart rate from Apple Health to track your
 *     training load and recovery."
 *   NSHealthUpdateUsageDescription. "Not required (read-only)"
 *
 * Two sync functions:
 *   syncAppleHealth(). Workouts (activities) → GarminActivityRow[]
 *   syncAppleHealthPhysiology(). Sleep, HRV, resting HR, steps → PhysiologyDayEntry[]
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
import { uploadAppleActivitiesToDB } from '@/data/appleActivityUpload';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { getPhysiologySource } from '@/data/sources';
import { calculateZones, type HRZones } from '@/calculations/heart-rate';
import { deriveAthleteTier } from '@/data/stravaSync';
import { detectArchetype } from '@/calculations/athlete-archetype';
import { isPbTombstoned } from '@/calculations/physiological-vdot';
import { SPORTS_DB } from '@/constants/sports';
import type { PhysiologyDayEntry, ApplePhysiologyField } from '@/types';
import { localDateKey } from '@/utils/local-date';
import { APPLE_PHYSIOLOGY_FIELDS } from '@/data/physiology-provenance';
import { type WorkoutType, type Workout, type HealthSample, type SleepState } from '@capgo/capacitor-health';
import {
  isHealthExtrasAvailable,
  requestHealthExtrasPermissions,
  readQuantitySamples,
  readLatestQuantity,
  readSleepSamples,
  readCharacteristics,
  queryWorkouts,
  readWorkoutRouteLocations,
  startWorkoutObserver,
  addWorkoutObserverListener,
  type RouteLocation,
  type HealthExtrasPermission,
  type QuantitySample,
  type SleepSample,
} from '@/data/healthExtras';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  buildPolylineFromLocations,
  extractKmSplits,
  extractBestEfforts,
  findRouteForWorkout,
  type SyntheticBestEffort,
} from '@/data/appleHealthRoute';
import { normalizeiTrimp } from '@/calculations/fitness-model';
import { resolveTrimpSex } from '@/calculations/trimp';
import { isTrimpSexPending, holdUntilTrimpSexKnown, releaseHeldTrimpSyncs } from '@/data/trimp-sex-gate';
import { applyCorroboratedMaxHR } from '@/calculations/max-hr-estimator';
import {
  detectRunRepsFromStream,
  detectBikeRepsFromPower,
  detectRepsFromHRStream,
  type DetectionResult,
} from '@/calculations/rep-detection';
import type { ActivityRepData } from '@/types/state';
import {
  computeHREnrichment as computeHREnrichmentFromStreams,
  computePowerStats,
  computeNPAndPowerCurve,
  computeSplitsFromSpeed,
  resolveMaxHR,
} from '@/data/activityEnrichment';

// ---------------------------------------------------------------------------
// Platform detection & auth
// ---------------------------------------------------------------------------

/** Returns true when running as a native iOS Capacitor app.
 *  Capacitor 8 removed the `.platform` property in favour of `.getPlatform()`;
 *  the old form returns undefined on device since Capacitor ≥ 5, silently
 *  disabling every native-only path that gates on this helper (HealthKit,
 *  workout observer, foreground-resume). Caught on device 2026-05-28 via
 *  the account-view DIAG chip showing `platform=undefined, Capacitor=present`. */
export function isNativeiOS(): boolean {
  return (window as any)?.Capacitor?.getPlatform?.() === 'ios';
}

/**
 * Onboarding-time "Connect Apple Health" action. Prompts HealthKit permissions
 * (iOS only), runs an initial physiology sync to verify the user actually
 * granted access, and marks Apple as the physiology source on success.
 *
 * Returns `{ ok: true }` when permissions were granted and at least one
 * physiology sample landed; `{ ok: false, reason }` otherwise. Reasons:
 *   - 'not-ios'. Running on web / Android (caller should hide the button)
 *   - 'no-data'. No physiology data came through. This is AMBIGUOUS by design:
 *     HealthKit deliberately never tells an app whether a read was denied vs
 *     simply empty (Apple's privacy model — `getRequestStatusForAuthorization`
 *     returns `.unnecessary` for BOTH granted and denied once answered). So we
 *     cannot claim "permission denied"; the caller surfaces a recovery path
 *     (open Settings to check the toggle, or use Strava / upload instead).
 *   - 'sync-error'. HealthKit threw.
 */
/**
 * In-flight guard. The connect flow can be triggered from two surfaces (the
 * Apple Watch picker tile and the Garmin "connect both" hub). If the first
 * attempt is still awaiting its HealthKit read when the user taps the second,
 * two concurrent reads can deadlock the capgo native bridge and neither
 * resolves, leaving the caller's "Connecting…" spinner stuck forever. Serialise
 * by returning the live promise so the second tap rides the first attempt.
 */
let _connectInFlight: Promise<{ ok: boolean; reason?: 'not-ios' | 'no-data' | 'sync-error' }> | null = null;

export function connectAppleHealth(): Promise<{ ok: boolean; reason?: 'not-ios' | 'no-data' | 'sync-error' }> {
  if (_connectInFlight) return _connectInFlight;
  _connectInFlight = connectAppleHealthInner().finally(() => { _connectInFlight = null; });
  return _connectInFlight;
}

async function connectAppleHealthInner(): Promise<{ ok: boolean; reason?: 'not-ios' | 'no-data' | 'sync-error' }> {
  if (!isNativeiOS()) return { ok: false, reason: 'not-ios' };
  try {
    // HARDENED CONNECT (build 18). The ONLY native work the connect does is the
    // physiology read via HealthExtras — restingHeartRate + heartRateVariabilitySDNN
    // + stepCount — which is the EXACT path that succeeded on device (build 16
    // connected and persisted through it). Every other native HealthKit call has
    // been moved OFF the onboarding moment because each one we added surfaced a
    // separate hard crash the first time the connect reached it (capgo's
    // requestAuthorization SIGABRT; our workoutRoute-without-parent SIGABRT). So
    // the connect now touches the minimum proven-safe surface and nothing else.
    //
    // Internally timeout-bounded so it always resolves (never pins the in-flight
    // guard) even if a native read hangs.
    const ok = await withTimeout(syncAppleHealthPhysiology(28), CONNECT_PHYSIOLOGY_TIMEOUT_MS, false);
    if (!ok) return { ok: false, reason: 'no-data' };

    // Success. Mark Apple Health authorized on THIS device. Supplementary source:
    // launch additively merges Apple physiology with the primary, preferring
    // existing (Garmin) values. Only claim the labelled primary physiology source
    // if nothing else already holds it, so connecting Apple never demotes Garmin.
    const s = getMutableState();
    s.appleHealthConnected = true;
    if (!getPhysiologySource(s)) {
      s.connectedSources = { ...(s.connectedSources ?? {}), physiology: 'apple' };
    }
    // Claim the ACTIVITY source too, so the launch-time workout sync (gated on
    // getActivitySource()==='apple' in main.ts) runs AUTOMATICALLY — not just
    // when the user taps Sync. Without this, a tri/Garmin setup whose activity
    // source resolves to something else never auto-pulls Apple Watch /
    // Garmin-via-Apple-Health workouts (the "had everything only after pressing
    // Sync" symptom). Skip when Strava owns activities or an explicit non-Apple
    // activity source is already set — never clobber a deliberate choice.
    if (!s.stravaConnected && !s.connectedSources?.activity) {
      s.connectedSources = { ...(s.connectedSources ?? {}), activity: 'apple' };
    }
    if (!s.wearable) s.wearable = 'apple';
    saveState();

    // Secondary enrichment — VO2max, running/cycling power, GPS routes. Restored
    // (build 17 proved it's crash-safe now that HealthExtras co-requests
    // workoutType alongside workoutRoute). Fire-and-forget so it never gates or
    // delays the success signal that advances onboarding; all reads are
    // unit-guarded in the plugin, so an incompatible type degrades to empty.
    void (async () => {
      await requestHealthExtrasPermissions(EXTRAS_READ_TYPES).catch(() => null);
      await syncAppleVO2().catch(() => null);
      await syncAppleCyclingFTP().catch(() => null);
      await syncAppleAthleteProfile().catch(() => null);
    })();

    return { ok: true };
  } catch (err) {
    console.warn('[AppleHealthSync] connect failed', err);
    return { ok: false, reason: 'sync-error' };
  }
}

/** Outer backstop on the gating physiology read. Each individual native query
 *  is bounded by `PHYS_READ_TIMEOUT_MS`, so the whole read normally resolves in
 *  well under this; the only time the user spends here beyond a few seconds is
 *  the iOS permission sheet itself. 25s gives a slow approver room while still
 *  surfacing the recovery card quickly when a read genuinely fails. (Was 90s —
 *  that produced the "approve, then nothing for ages" report when a native read
 *  hung; the per-read timeouts make a long outer wait unnecessary.) */
const CONNECT_PHYSIOLOGY_TIMEOUT_MS = 45_000;

/** Per-query timeout for an individual HealthKit native read. capgo's bridge can
 *  (rarely) accept a query and never call back; bounding each call means one
 *  stuck read degrades to empty instead of freezing the whole physiology sync. */
const PHYS_READ_TIMEOUT_MS = 8_000;

/** Resolve `promise`, or `fallback` if it hasn't settled within `ms`. The
 *  underlying promise keeps running (its state writes still land if it
 *  eventually resolves); we just stop awaiting it so the caller can recover. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Bumped every time we ship a new diagnostic-bearing build. Prefixed onto the
 *  on-device diagnostic so we can confirm WHICH build is actually running when
 *  a TestFlight install lags and two builds look identical on screen. */
const DIAG_BUILD_TAG = 'b25';

/** Last physiology-read outcome, captured for on-device debugging. TestFlight
 *  has no console, so the connect recovery card surfaces this to tell apart
 *  permission-off (all zero), a hung native read (timed out → still zero, but
 *  fast), and a genuinely empty device. Read via `getLastApplePhysiologyDiag`. */
let _lastPhysiologyDiag = '';
export function getLastApplePhysiologyDiag(): string {
  return _lastPhysiologyDiag;
}

/** Last WORKOUT-sync outcome, captured for on-device debugging. TestFlight has
 *  no console, so the Account → Apple Watch row surfaces this to tell apart the
 *  two failure modes that both render as "0 sessions" on the tri Stats screen:
 *  (1) HealthKit returned no workouts (permission off, or a genuinely empty
 *  store) vs (2) workouts pulled fine but failed to reach the DB the tri
 *  pipeline reads. Read via `getLastAppleWorkoutDiag`. */
let _lastWorkoutSyncDiag = '';
export function getLastAppleWorkoutDiag(): string {
  return _lastWorkoutSyncDiag;
}

/** Core read types, requested in the PRIMARY HealthKit sheet (connect flow and
 *  every physiology sync). `workouts` is core activity data. `heartRate` is the
 *  per-workout HR stream that `enrichWorkoutsWithHR` reads to compute iTRIMP
 *  and zones. It used to arrive through capgo's `requestAuthorization`
 *  (ALL_READ_TYPES); ae0545e removed that call and nothing asked for
 *  `heartRate` again, so every Apple workout on a fresh install had no HR and
 *  was costed as minutes × a flat rate (audit D4). The Swift plugin maps
 *  'heartRate' to HKQuantityTypeIdentifierHeartRate (HealthExtrasPlugin.swift
 *  `quantityType(for:)`). */
export const CORE_READ_TYPES: HealthExtrasPermission[] = [
  'restingHeartRate',
  'heartRateVariabilitySDNN',
  'stepCount',
  'sleepAnalysis',
  'respiratoryRate',
  'oxygenSaturation',
  'workouts',
  'heartRate',
];

/** One shared in-flight core-permission request. The launch workout sync and
 *  the physiology sync can both reach here at once; sharing the promise means
 *  HealthKit gets one `requestAuthorization` call instead of two racing ones. */
let _corePermsInFlight: Promise<void> | null = null;

/** Request CORE_READ_TYPES. Bounded by AUTH_REQUEST_TIMEOUT_MS: on a hang the
 *  grant is already app-level, so the caller proceeds to its reads. Once the
 *  request has settled, `heartRate` has been asked for on this install, so the
 *  one-time workout-sync guard is satisfied. */
function requestCorePermissions(): Promise<void> {
  if (_corePermsInFlight) return _corePermsInFlight;
  _corePermsInFlight = withTimeout(
    requestHealthExtrasPermissions(CORE_READ_TYPES).then(() => undefined, () => undefined),
    AUTH_REQUEST_TIMEOUT_MS,
    undefined,
  ).then(() => {
    const s = getMutableState();
    if (!s.appleHeartRatePermissionRequested) {
      s.appleHeartRatePermissionRequested = true;
      saveState();
    }
  }).finally(() => { _corePermsInFlight = null; });
  return _corePermsInFlight;
}

/** Re-prompt existing connected users once for `heartRate` before the workout
 *  sync's first HR-stream read. The workout sync never requested permissions,
 *  and users connected before this fix were never asked for `heartRate`, so
 *  their HR reads return [] and the workout is processed (and deduped forever)
 *  without HR. iOS presents the sheet only for types not yet requested; a user
 *  who already answered sees nothing. */
async function ensureHeartRatePermissionRequested(): Promise<void> {
  if (getMutableState().appleHeartRatePermissionRequested) return;
  await requestCorePermissions();
}

/** Permissions to request from the HealthExtras plugin on Apple Health connect.
 *  Includes iOS-17+ types. Swift filters unavailable ones automatically so
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
  // Athlete profile (build 21): seeded clobber-safe by syncAppleAthleteProfile.
  'bodyMass',
  'height',
  'bodyFatPercentage',
  'dateOfBirth',
  'biologicalSex',
];

/**
 * Read the most recent VO2max sample from HealthKit and write it to `s.vo2`
 * with provenance `'device'`. Apple Watch's VO2max updates a few times a
 * week from outdoor GPS runs (HealthKit's `HKQuantityTypeIdentifierVO2Max`).
 *
 * This is the headline benefit of the plugin: an Apple-only user no longer
 * sees "(est.)" next to their fitness number. It matches what they see in
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
    // Local calendar date: the plugin emits GMT ISO strings, so slice(0, 10)
    // would key by UTC day (a day off in UTC+ mornings / UTC- evenings).
    const date = localDateKey(sample.startDate);
    if (!date) continue;
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

/** Compute whole-years age from an ISO date-of-birth string. Null on parse fail. */
function ageFromISODob(iso: string): number | null {
  const dob = new Date(iso);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

/**
 * Seed athlete-profile fields from HealthKit — body mass, height, and the
 * immutable characteristics (date of birth → age, biological sex). CLOBBER-SAFE:
 * only fills a field that is currently unset; never overwrites a user-entered
 * value. These are profile facts (not benchmarks that improve), so "fill if
 * empty" is the correct rule. No-op on web/Android; failures degrade silently.
 */
export async function syncAppleAthleteProfile(): Promise<void> {
  if (!isHealthExtrasAvailable()) return;
  const s = getMutableState();
  let changed = false;

  // Body mass (kg) → s.bodyWeightKg + onboarding.bodyWeightKg if unset.
  const mass = await readLatestQuantity({ dataType: 'bodyMass' }).catch(() => ({ value: null, asOf: null }));
  if (mass.value != null && mass.value >= 30 && mass.value <= 300) {
    const kg = Math.round(mass.value * 10) / 10;
    if (s.bodyWeightKg == null) { s.bodyWeightKg = kg; changed = true; }
    if (s.onboarding && s.onboarding.bodyWeightKg == null) { s.onboarding.bodyWeightKg = kg; changed = true; }
  }

  // Height (m → cm) → s.heightCm if unset.
  const height = await readLatestQuantity({ dataType: 'height' }).catch(() => ({ value: null, asOf: null }));
  if (height.value != null && height.value >= 1.0 && height.value <= 2.5 && s.heightCm == null) {
    s.heightCm = Math.round(height.value * 100);
    changed = true;
  }

  // DOB → age, biological sex → state + onboarding, if unset.
  const chars = await readCharacteristics().catch(() => ({ dateOfBirth: null, biologicalSex: null as 'male' | 'female' | 'other' | null }));
  if (chars.dateOfBirth && s.onboarding && s.onboarding.age == null) {
    const age = ageFromISODob(chars.dateOfBirth);
    if (age != null && age >= 10 && age <= 100) { s.onboarding.age = age; changed = true; }
  }
  if (chars.biologicalSex) {
    const sex: 'male' | 'female' | 'prefer_not_to_say' = chars.biologicalSex === 'other' ? 'prefer_not_to_say' : chars.biologicalSex;
    if (s.biologicalSex == null) { s.biologicalSex = sex; changed = true; }
    if (s.onboarding && s.onboarding.biologicalSex == null) { s.onboarding.biologicalSex = sex; changed = true; }
  }

  if (changed) {
    saveState();
    console.log('[AppleHealthSync] Athlete profile seeded from HealthKit (clobber-safe)');
    // HealthKit can be the first source of the athlete's sex mid-wizard:
    // syncs held for it (trimp-sex-gate.ts) run now if that sex is final.
    void releaseHeldTrimpSyncs(s);
  }
}

/** The EXACT set of read identifiers the @capgo/capacitor-health plugin can
 * map natively: its `HealthDataType` union (see
 * node_modules/@capgo/capacitor-health/dist/esm/definitions.d.ts) plus the
 * special `'workouts'` identifier handled by `parseTypesWithWorkouts`.
 *
 * This is the single source of truth that makes the type system catch the
 * 2026-06-12 bug class. The native `parseTypesWithWorkouts` THROWS
 * `invalidDataType` on the FIRST unrecognised string, and the throw happens
 * BEFORE `healthStore.requestAuthorization` is called — so one bad string here
 * means iOS never presents the permission sheet and the whole connect flow
 * fails silently for EVERY user. (`'appleExerciseTime'` was exactly that.)
 *
 * `capgo-read-types.test.ts` asserts this list still matches the plugin's
 * shipped `HealthDataType` union, so a plugin upgrade that renames/drops a type
 * fails the build instead of silently breaking the popup at runtime. */
export const CAPGO_READ_TYPES = [
  'steps', 'distance', 'calories', 'heartRate', 'weight', 'sleep',
  'respiratoryRate', 'oxygenSaturation', 'restingHeartRate', 'heartRateVariability',
  'workouts',
] as const;
export type CapgoReadType = typeof CAPGO_READ_TYPES[number];

/** All HealthKit data types we request in the single combined authorization.
 * Typed as `CapgoReadType[]`, so adding a string the plugin can't map (the
 * popup-killing bug) is a COMPILE ERROR, not a silent runtime failure. */
export const ALL_READ_TYPES: CapgoReadType[] = [
  'workouts',                                         // HKWorkoutType (activity import)
  'calories', 'distance', 'heartRate',               // workout streams
  'sleep', 'restingHeartRate', 'heartRateVariability', 'steps',  // physiology
];

// capgo `@capgo/capacitor-health` is no longer used at runtime AT ALL — its
// requestAuthorization hard-crashes on iOS 26.x (EXC_CRASH/SIGABRT in HKHealthStore
// share-type validation; see crash logs). Every HealthKit read — physiology,
// sleep, workouts, routes, power — now goes through our own HealthExtras plugin
// (read-only, toShare:nil, which does not crash). The only remaining capgo
// references are TYPE imports (Workout/WorkoutType/HealthSample/SleepState),
// which carry no runtime code.

/** Upper bound on the HealthExtras permission request. Must exceed a real user's
 *  time reading the iOS permission sheet (so a working request resolves first
 *  and this never trips), yet bound a hung native call. On a hang the grant is
 *  already app-level, so proceeding to the reads still works. */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

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
 * session. Now `CARDIO`, which the matcher routes to cross-training rather
 * than counting as locomotion.
 */
function mapWorkoutType(type: WorkoutType): GarminActivityRow['activity_type'] {
  switch (type) {
    // Endurance. Own categories
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

    // Racket + ball sports. Match `mapGarminType`'s 'other' bucket
    case 'tennis':                     return 'TENNIS';
    case 'basketball':                 return 'BASKETBALL';
    case 'soccer':                     return 'SOCCER';
    case 'americanFootball':           return 'FOOTBALL';
    case 'baseball':                   return 'SOFTBALL';
    case 'wrestling':                  return 'MARTIAL_ARTS';

    // Water sports. Closest internal mapping
    case 'waterFitness':               return 'AEROBIC_TRAINING';
    case 'waterPolo':                  return 'CARDIO';
    case 'waterSports':                return 'PADDLEBOARDING';

    // Catch-all. `CARDIO` routes to cross-training in the matcher rather
    // than the locomotion-style WALKING (which would skew weekly km).
    case 'other':
    default:                           return 'CARDIO';
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/** First-time backfill window — mirrors Strava's 52w `backfill` mode so the
 *  Apple-only path produces equivalent `historicWeeklyTSS` / `ctlBaseline`
 *  / `detectedWeeklyKm` / `extendedHistoryKm` data on initial connection.
 *  52 weeks is required for the athlete-archetype classifier to reliably
 *  detect "detrained-with-history" (current 18 km/wk but ran 50 km/wk last
 *  summer). HealthKit reads are local and fast, so the extra range adds only
 *  ~1-2s on first launch. */
const FIRST_BACKFILL_DAYS = 364;
/** Incremental window for every subsequent launch — last 14 days, dedup keeps
 *  the older workouts intact. */
const INCREMENTAL_DAYS = 14;
/** Concurrency cap for per-workout HR-stream queries. HealthKit reads are
 *  local and fast, but stacking 100+ promises at once burns memory on older
 *  devices. 4 keeps total wall-time under ~2s for 16w of typical data. */
const HR_FETCH_CONCURRENCY = 4;
/** Max samples per heart-rate query. Apple Watch typically samples HR every
 *  2–5s during workouts, so a 3h ride with continuous HR maxes around ~5400
 *  samples. The plugin default is 100. We explicitly raise it. */
const HR_SAMPLE_LIMIT = 6000;

/**
 * Sync recent Apple Watch workouts to the plan.
 * Called from main.ts after app launch on iOS.
 * Safe to call on every launch. Already-processed workouts are skipped
 * by the garminMatched dedup key (keyed as "apple-<stableId>").
 *
 * On first invocation (no `appleHistoryFetched` flag), runs a 16-week backfill
 * with per-workout HR-stream enrichment and aggregates weekly history into
 * `historicWeeklyTSS`, `ctlBaseline`, `detectedWeeklyKm`, `athleteTier` —
 * mirroring `fetchStravaHistory` for the Apple-only path. Subsequent launches
 * use a 14-day incremental window to pick up new workouts cheaply.
 */
export async function syncAppleHealth(opts?: { forceFullHistory?: boolean }): Promise<void> {
  if (!isNativeiOS()) { _lastWorkoutSyncDiag = `${DIAG_BUILD_TAG} not-ios (web/Android — no HealthKit)`; return; }
  // Mid-wizard, before the sex is final (about-you or schedule still ahead):
  // the iTRIMP below carries the β of the sex resolved now, the male β when
  // none is, and is upserted into garmin_activities. After the first backfill
  // only the latest 14 days are re-read automatically. Hold the sync
  // (trimp-sex-gate.ts).
  if (isTrimpSexPending(getMutableState())) {
    holdUntilTrimpSexKnown('apple-workouts', () => syncAppleHealth(opts));
    _lastWorkoutSyncDiag = `${DIAG_BUILD_TAG} held: waiting for the athlete's sex (iTRIMP β)`;
    return;
  }
  // Workouts now read through our HealthExtras plugin (HKWorkoutType query),
  // NOT capgo — capgo's auth crashes on iOS 26.x. This is the Garmin-via-Apple-
  // Health activity pipe (Garmin Connect → Apple Health → here), so Apple-only /
  // Garmin users get their runs without Strava. Recovery physiology flows
  // separately via syncAppleHealthPhysiology.
  try {
    const s = getMutableState();
    // One-time re-backfill for users affected by the pre-build-23 activity-source
    // gating bug (workouts never auto-synced, or only a partial 14-day window
    // after a manual sync left `appleHistoryFetched` stuck true). Force ONE full
    // history re-pull for any Apple-connected user, then flag it so it never
    // re-runs. Dedup (garminMatched key) makes re-pulling existing workouts a
    // no-op, so this is safe even for users who already have their history.
    if (s.appleHealthConnected && !s.appleHistoryResyncDone) {
      s.appleHistoryFetched = false;
      s.appleHistoryResyncDone = true;
      saveState();
    }
    // Explicit full-history pull (user taps "Sync" in Account). The
    // non-destructive equivalent of a reset: re-run the full backfill window
    // plus the deep (>52w) pull so an existing user can recover months of
    // training — rides, swims, runs — without wiping their plan or onboarding
    // again. This is what makes the bike/swim/run benchmarks derive from real
    // activity instead of falling back to the manual past-race anchor and the
    // (cycling-inflated) watch VO2max. Dedup (the garminMatched "apple-<id>"
    // key) makes re-pulling existing workouts a no-op, and aggregateAppleHistory
    // recomputes weekly history from scratch, so forcing this is idempotent.
    // Only the manual button passes it; automatic launch / foreground / observer
    // syncs stay on the cheap 14-day incremental path.
    if (opts?.forceFullHistory && s.appleHealthConnected) {
      s.appleHistoryFetched = false;
      s.appleDeepHistoryFetched = false;
      saveState();
    }
    const isFirstBackfill = !s.appleHistoryFetched;
    const daysBack = isFirstBackfill ? FIRST_BACKFILL_DAYS : INCREMENTAL_DAYS;

    const workouts = await fetchRecentWorkouts(daysBack);
    if (workouts.length === 0) {
      _lastWorkoutSyncDiag = `${DIAG_BUILD_TAG} pulled=0 window=${daysBack}d first=${isFirstBackfill} — HealthKit returned no workouts (check Workouts permission, or no recorded activities)`;
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
    // The HR stream needs the `heartRate` read type. Ask once on installs that
    // were never asked (audit D4) BEFORE the first read. A workout matched
    // without HR regains iTRIMP and zones only when it is read again (inside
    // the incremental window, or via the Account full-history sync), through
    // the matcher's re-enrich loop. That loop never restores avg HR.
    await ensureHeartRatePermissionRequested();
    const enrichment = await enrichWorkoutsWithHR(workouts);

    const rows = workouts.map(w => convertToActivityRow(w, enrichment.get(workoutKey(w))));
    const changed = matchAndAutoComplete(rows);

    // Mirror Strava/Garmin: persist Apple workouts to the Supabase
    // `garmin_activities` table. This is the ONLY path that feeds the triathlon
    // fitness pipeline (`loadActivitiesFromDB` → per-discipline CTL /
    // fitnessHistory / CSS / FTP / PBs), which never reads local garminActuals.
    // Awaited so the tri-init DB-empty fallback (main.ts) sees the rows on the
    // SAME launch when it calls this synchronously. Idempotent + dedup-safe.
    const uploaded = await uploadAppleActivitiesToDB(rows);
    _lastWorkoutSyncDiag = `${DIAG_BUILD_TAG} pulled=${rows.length} hrEnriched=${enrichment.size} uploaded=${uploaded} window=${daysBack}d first=${isFirstBackfill}`;

    // First-time backfill: aggregate weekly history so the plan engine has
    // CTL / weekly km / athlete tier seeds, matching the Strava backfill flow.
    if (isFirstBackfill) {
      aggregateAppleHistory(rows); // also stamps appleHistoryLastRefreshedAt
      saveState();
    } else {
      // Stamp every successful incremental sync so the foreground-resume hook's
      // 5-minute throttle has an accurate "last synced" reference. Previously
      // this timestamp was only written on the first backfill, so the throttle
      // would compare against a stale value and re-query on every resume.
      s.appleHistoryLastRefreshedAt = new Date().toISOString();
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

    // After the standard backfill completes, kick off a one-shot deep history
    // pull for users whose HealthKit goes back further than 52 weeks. Surfaces
    // historic races and PBs without blocking the foreground sync.
    if (!s.appleDeepHistoryFetched) {
      syncAppleHealthDeepHistory().catch((err) => {
        console.warn('[AppleHealthSync] Deep history pull failed', err);
      });
    }
  } catch (err) {
    // Non-fatal. App continues without Apple Health sync
    _lastWorkoutSyncDiag = `${DIAG_BUILD_TAG} threw: ${String((err as { message?: string })?.message ?? err).slice(0, 90)}`;
    console.warn('[AppleHealthSync] Sync failed:', err);
  }
}

/**
 * Fetch workouts from HealthKit within the last `daysBack` days.
 */
async function fetchRecentWorkouts(daysBack: number): Promise<Workout[]> {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  // Read via HealthExtras (our plugin), NOT capgo — capgo's auth crashes on
  // iOS 26.x. ExtrasWorkout has the same runtime field shape as capgo's Workout
  // (workoutType string, dates, duration s, totalDistance m, totalEnergyBurned
  // kcal, sourceId/Name), so downstream convert/enrich/key code is reused via cast.
  const workouts = await queryWorkouts({
    startDate: since.toISOString(),
    endDate: new Date().toISOString(),
    // Hard upper bound. 16 weeks of typical hobbyist activity stays well
    // under 500. Power users training daily across multiple sports may push
    // ~250. We set 1000 as a safety ceiling rather than a realistic target.
    limit: 1000,
    ascending: false,
  });

  return workouts as unknown as Workout[];
}

/** Deep-history maximum reach (years). Anything older than this is unlikely
 *  to be a PB-relevant race. Hard bound prevents pathological pulls on users
 *  with a decade-old HealthKit store. */
const DEEP_HISTORY_MAX_YEARS = 5;
/** Year-by-year chunking keeps each query bounded so a slow device doesn't
 *  block on a single 5-year HealthKit read. Also lets us short-circuit when
 *  an empty chunk indicates no older data exists. */
const DEEP_HISTORY_CHUNK_DAYS = 365;

/**
 * One-shot deep history pull. Walks HealthKit back from `FIRST_BACKFILL_DAYS`
 * in 1-year chunks until either `DEEP_HISTORY_MAX_YEARS` is reached or an
 * empty chunk indicates no older data. Workouts go through
 * `matchAndAutoComplete()` so historic races become matchable to the user's
 * PB list, but HR enrichment is skipped. The athlete-archetype classifier
 * and CTL baseline already use the 52-week window from `syncAppleHealth()`,
 * and HR enrichment for thousands of old workouts would be expensive without
 * adding signal.
 *
 * Runs once per install. The `appleDeepHistoryFetched` flag prevents re-runs.
 * Fire-and-forget. Does not block any other sync path.
 *
 * No-op on web/Android.
 */
export async function syncAppleHealthDeepHistory(): Promise<void> {
  if (!isNativeiOS()) return;
  const s = getMutableState();
  if (s.appleDeepHistoryFetched) return;

  try {
    let totalProcessed = 0;
    let endDate = new Date();
    endDate.setDate(endDate.getDate() - FIRST_BACKFILL_DAYS);

    for (let chunk = 0; chunk < DEEP_HISTORY_MAX_YEARS; chunk++) {
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - DEEP_HISTORY_CHUNK_DAYS);

      // HealthExtras query (capgo dead on iOS 26.x). Cast: ExtrasWorkout shares
      // capgo Workout's runtime shape; convertToActivityRow consumes it unchanged.
      const workouts = (await queryWorkouts({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        limit: 2000,
        ascending: false,
      })) as unknown as Workout[];

      if (workouts.length === 0) {
        // No older data. Stop walking. User's HealthKit store ends here.
        break;
      }

      // Skip HR enrichment for deep history. The 52-week window already
      // covers HR-derived metrics; older workouts contribute only metadata
      // (distance, duration, type) for PB surfacing and history rendering.
      const rows = workouts.map((w) => convertToActivityRow(w, undefined));
      matchAndAutoComplete(rows);
      // Persist older history too, so the tri pipeline's "all" range and PB
      // surfacing see races from beyond the 52-week backfill window.
      await uploadAppleActivitiesToDB(rows);
      totalProcessed += rows.length;

      endDate = startDate;
    }

    s.appleDeepHistoryFetched = true;
    saveState();

    if (totalProcessed > 0) {
      render();
      console.log(`[AppleHealthSync] Deep history pulled: ${totalProcessed} workout(s) older than ${FIRST_BACKFILL_DAYS}d`);
    } else {
      console.log('[AppleHealthSync] Deep history: no workouts older than 52w');
    }
  } catch (err) {
    console.warn('[AppleHealthSync] Deep history pull failed', err);
    // Do not set the flag. Let the next launch retry.
  }
}

// ---------------------------------------------------------------------------
// Physiology sync. Sleep, HRV, resting HR from HealthKit
// ---------------------------------------------------------------------------

/** Default sleep target when we have no history yet (7 hours). */
const DEFAULT_SLEEP_TARGET_SEC = 7 * 3600;

/**
 * SDNN → RMSSD conversion factor for Apple Watch HRV.
 * Apple Watch reports SDNN; our readiness model and rmssdToHrvStatus() expect RMSSD.
 * Source: Shaffer & Ginsberg 2017. Nocturnal short-term recordings.
 * Range in literature: 1.2–1.4. We use 1.28 (study median).
 */
const SDNN_TO_RMSSD = 1.28;

/** HealthKit HKCategoryValueSleepAnalysis raw value → our SleepState. capgo
 *  exposed string states; HealthExtras returns the raw enum, so we map here.
 *  0 inBed, 1 asleepUnspecified, 2 awake, 3 asleepCore, 4 asleepDeep, 5 asleepREM.
 *  Core maps to light (same bucket capgo used). inBed is excluded from sleep
 *  duration by computeSleepStageDurations. */
const SLEEP_VALUE_TO_STATE: Record<number, SleepState> = {
  0: 'inBed' as SleepState,
  1: 'asleep' as SleepState,
  2: 'awake' as SleepState,
  3: 'light' as SleepState,
  4: 'deep' as SleepState,
  5: 'rem' as SleepState,
};

/** Hour (local) that splits one night from the next. A sleep segment ending
 *  before it belongs to that morning's night; a segment ending at or after it
 *  belongs to the NEXT morning's night. This is the same noon boundary the
 *  old `endHour >= 12` nap filter used; no new constant. */
const SLEEP_NIGHT_BOUNDARY_HOUR = 12;

/** Raw HealthExtras reads that feed one physiology sync. */
export interface ApplePhysiologyReads {
  rhr: QuantitySample[];
  hrv: QuantitySample[];
  steps: QuantitySample[];
  resp: QuantitySample[];
  spo2: QuantitySample[];
  sleep: SleepSample[];
}

/**
 * Read window for a physiology sync of `days` days (tracking side).
 *
 * `since` is local midnight `days` days ago, so every date from `since` to
 * today is read in full. The old window started at `now − days` and kept the
 * time of day, so its first date was partial. That was harmless under the old
 * fill-only merge, but a newest-wins merge would overwrite that day's full
 * values with partial ones. `sleepSince` starts at the night boundary on the
 * day before `since`, so the night that wakes on `since` is read whole.
 */
export function applePhysiologyWindow(days: number, now: Date = new Date()): { since: Date; sleepSince: Date } {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - days);
  const sleepSince = new Date(since);
  sleepSince.setDate(sleepSince.getDate() - 1);
  sleepSince.setHours(SLEEP_NIGHT_BOUNDARY_HOUR, 0, 0, 0);
  return { since, sleepSince };
}

/**
 * Local date of the morning a sleep segment's night wakes on. Segments ending
 * before the noon boundary belong to that date. Segments ending at or after it
 * (the pre-midnight part of a night, or a daytime nap) belong to the next date.
 * Returns '' for an unparseable timestamp.
 */
export function sleepWakeDateKey(endIso: string): string {
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return '';
  if (end.getHours() >= SLEEP_NIGHT_BOUNDARY_HOUR) end.setDate(end.getDate() + 1);
  return localDateKey(end);
}

/** Local midnight strictly after `t` (ms). */
function nextLocalMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Daily step totals (local dates) from raw HealthKit step samples, without
 * counting the same steps twice when several sources record them.
 *
 * An iPhone in a pocket and an Apple Watch on the wrist both write stepCount
 * samples for the same walk, so summing every sample doubles the overlap.
 * Each sample's steps are spread evenly over its own interval. Wherever two or
 * more sources overlap, only the source with the highest step rate in that
 * stretch is counted. Samples from one source are always summed. Intervals
 * covered by a single source count in full. Samples spanning local midnight
 * are split across both days. A zero-length sample (a manual entry) has no
 * interval to overlap and is added as-is.
 *
 * This approximates HealthKit's own statistics merge, which picks one source
 * per overlapping stretch by the user's source priority. The plugin returns
 * `sourceName` but not that priority, so "the source that saw more steps"
 * stands in for it. The result never exceeds the sum and is never below the
 * largest single source.
 */
export function dailyStepsAcrossSources(samples: QuantitySample[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, v: number) => {
    if (key && v > 0) out.set(key, (out.get(key) ?? 0) + v);
  };
  const events: { t: number; src: string; dRate: number }[] = [];
  const cuts: number[] = [];
  for (const smp of samples) {
    const v = smp.value;
    if (!(v > 0)) continue;
    const start = Date.parse(smp.startDate);
    const end = Date.parse(smp.endDate);
    if (Number.isNaN(start)) continue;
    if (Number.isNaN(end) || end <= start) { add(localDateKey(new Date(start)), v); continue; }
    const src = smp.sourceName ?? '';
    const rate = v / (end - start);
    events.push({ t: start, src, dRate: rate }, { t: end, src, dRate: -rate });
    for (let m = nextLocalMidnight(start); m < end; m = nextLocalMidnight(m)) cuts.push(m);
  }
  if (events.length === 0) return out;
  events.sort((a, b) => a.t - b.t);
  const times = [...new Set([...events.map(e => e.t), ...cuts])].sort((a, b) => a - b);
  const activeRate = new Map<string, number>();
  let ei = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const t = times[i];
    while (ei < events.length && events[ei].t === t) {
      const ev = events[ei++];
      activeRate.set(ev.src, (activeRate.get(ev.src) ?? 0) + ev.dRate);
    }
    let maxRate = 0;
    for (const r of activeRate.values()) if (r > maxRate) maxRate = r;
    if (maxRate > 0) add(localDateKey(new Date(t)), maxRate * (times[i + 1] - t));
  }
  return out;
}

/** Last (most recent) value per local date. Sorted here so the result does not
 *  depend on the order the plugin returned. */
function lastValueByLocalDate(samples: QuantitySample[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = samples
    .map(s => ({ s, t: Date.parse(s.startDate) }))
    .filter(x => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  for (const { s } of sorted) {
    const key = localDateKey(s.startDate);
    if (key) out.set(key, s.value);
  }
  return out;
}

/**
 * Group sleep segments into nights keyed by local wake date, keeping one
 * source per night. Summing iPhone, Watch and third-party apps counts the
 * same night twice. Per night, a source that reports stages (core, deep or
 * REM) beats one that writes only generic "asleep", so a third-party app's
 * unstaged night never displaces the Watch's staged night. Ties go to the
 * source with more asleep seconds.
 */
function groupSleepNights(samples: SleepSample[]): Map<string, HealthSample[]> {
  const byNight = new Map<string, Map<string, HealthSample[]>>();
  for (const seg of samples) {
    const state = SLEEP_VALUE_TO_STATE[seg.value];
    if (!state) continue;                       // unknown value → skip
    const wake = sleepWakeDateKey(seg.endDate);
    if (!wake) continue;
    const src = seg.sourceName ?? '';
    let sources = byNight.get(wake);
    if (!sources) { sources = new Map(); byNight.set(wake, sources); }
    let segs = sources.get(src);
    if (!segs) { segs = []; sources.set(src, segs); }
    // computeSleepStageDurations only reads .sleepState/.startDate/.endDate.
    segs.push({ sleepState: state, startDate: seg.startDate, endDate: seg.endDate } as HealthSample);
  }
  const nights = new Map<string, HealthSample[]>();
  for (const [wake, sources] of byNight) {
    let best: HealthSample[] | null = null;
    let bestStaged = false;
    let bestAsleep = -1;
    for (const segs of sources.values()) {
      // 'light' only comes from asleepCore (3); generic asleep (1) maps to 'asleep'.
      const staged = segs.some(x => x.sleepState === 'light' || x.sleepState === 'deep' || x.sleepState === 'rem');
      const d = computeSleepStageDurations(segs);
      const asleep = d.deep + d.rem + d.light;
      if (best === null || (staged && !bestStaged) || (staged === bestStaged && asleep > bestAsleep)) {
        best = segs;
        bestStaged = staged;
        bestAsleep = asleep;
      }
    }
    if (best) nights.set(wake, best);
  }
  return nights;
}

/**
 * Turn one sync's raw reads into PhysiologyDayEntry rows keyed by LOCAL date
 * (tracking side: it describes what the devices recorded).
 *
 * Dates after `now`'s local date are dropped. Under the noon rule, a segment
 * ending this afternoon or evening belongs to tomorrow's night, and that night
 * is not over yet. A later sync picks it up once the wake morning arrives.
 */
export function buildApplePhysiologyEntries(reads: ApplePhysiologyReads, now: Date = new Date()): PhysiologyDayEntry[] {
  const today = localDateKey(now);
  const nightMap = groupSleepNights(reads.sleep);
  const rhrByDate = lastValueByLocalDate(reads.rhr);
  const hrvByDate = lastValueByLocalDate(reads.hrv);
  const stepsByDate = dailyStepsAcrossSources(reads.steps);
  const respByDate = lastValueByLocalDate(reads.resp);
  const spo2ByDate = lastValueByLocalDate(reads.spo2);

  const allDates = new Set<string>();
  for (const m of [nightMap, rhrByDate, hrvByDate, stepsByDate, respByDate, spo2ByDate]) {
    for (const d of m.keys()) if (d <= today) allDates.add(d);
  }

  const entries: PhysiologyDayEntry[] = [];
  for (const date of allDates) {
    const entry: PhysiologyDayEntry = { date };

    // Sleep stages
    const night = nightMap.get(date);
    if (night && night.length > 0) {
      const stageSecs = computeSleepStageDurations(night);
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

    // HRV. HealthExtras returns SDNN in ms (its defaultUnit). Our model uses
    // RMSSD (ms): RMSSD ≈ SDNN × 1.28 (Shaffer & Ginsberg 2017, nocturnal
    // short-term recordings) so Apple values land in the same range as Garmin.
    const hrv = hrvByDate.get(date);
    if (hrv != null && hrv > 0) entry.hrvRmssd = Math.round(hrv * SDNN_TO_RMSSD * 10) / 10;

    // Steps
    const steps = stepsByDate.get(date);
    if (steps != null && steps > 0) entry.steps = Math.round(steps);

    // Respiratory rate (breaths/min) + blood oxygen (recovery / illness /
    // altitude signals). HealthExtras returns SpO2 as a fraction; store percent.
    const resp = respByDate.get(date);
    if (resp != null && resp > 0) entry.respiratoryRate = Math.round(resp * 10) / 10;
    const spo2 = spo2ByDate.get(date);
    if (spo2 != null && spo2 > 0) entry.spo2 = Math.round(spo2 * 100 * 10) / 10;

    entries.push(entry);
  }

  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Merge one sync's entries into the stored history. Every date in `incoming`
 * was read in full by this sync (see applePhysiologyWindow), so a newer Apple
 * value replaces the value an earlier sync stored for that date. The old merge
 * let the first value seen each day win, which froze steps, sleep and HRV at
 * whatever the first launch of the day saw.
 *
 * - `appleOwns` (Apple is the primary physiology source): Apple's newest value
 *   wins for every field it reports.
 * - Otherwise (Garmin primary, Apple supplementary): Apple fills empty fields
 *   and refreshes fields it filled itself (tracked in `appleValues`), but never
 *   overwrites a value the primary source wrote.
 *
 * Fields Apple does not report this time (vo2max, stress, LT, a type whose
 * read timed out) keep their stored value. Manual sleep ratings live in
 * `recoveryHistory` and are folded in at read time by mergeManualSleepHistory,
 * so nothing here touches them.
 */
export function mergeApplePhysiologyEntries(
  existing: PhysiologyDayEntry[],
  incoming: PhysiologyDayEntry[],
  appleOwns: boolean,
): PhysiologyDayEntry[] {
  const byDate = new Map(existing.map(e => [e.date, e]));
  for (const entry of incoming) {
    const prev = byDate.get(entry.date);
    const next: PhysiologyDayEntry = prev ? { ...prev } : { date: entry.date };
    const written: Partial<Record<ApplePhysiologyField, number>> = { ...(prev?.appleValues ?? {}) };
    for (const f of APPLE_PHYSIOLOGY_FIELDS) {
      const v = entry[f];
      if (v == null) continue;
      const cur = prev?.[f];
      const appleWroteCur = cur != null && prev?.appleValues?.[f] === cur;
      if (appleOwns || cur == null || appleWroteCur) {
        next[f] = v;
        written[f] = v;
      } else {
        delete written[f];                      // the primary source owns this field
      }
    }
    if (Object.keys(written).length > 0) next.appleValues = written;
    else delete next.appleValues;
    byDate.set(entry.date, next);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Sync physiology data (sleep, HRV, resting HR) from HealthKit.
 * Populates `s.physiologyHistory` with up to 28 days of PhysiologyDayEntry[],
 * matching the same shape that syncPhysiologySnapshot() produces from Garmin.
 *
 * Safe to call on every launch. Reads the local HealthKit store, no network.
 * Returns true if state was updated.
 */
export async function syncAppleHealthPhysiology(days = 28): Promise<boolean> {
  if (!isNativeiOS()) return false;

  // Stage + per-read error capture. Declared OUTSIDE the try so the catch can
  // surface exactly where capgo failed on this OS (TestFlight has no console).
  // `_lastPhysiologyDiag` is updated as a BREADCRUMB before each await that can
  // hang, so if the outer connect timeout fires while we're still stuck, the
  // recovery card shows the last stage reached (e.g. "hung@authorizing"). The
  // `DIAG_BUILD_TAG` prefix lets us confirm on-device which build is actually
  // running — invaluable when TestFlight installs lag and two builds look identical.
  const TAG = DIAG_BUILD_TAG;
  let stage = 'init';
  const readErrs: string[] = [];
  _lastPhysiologyDiag = `${TAG} hung@start`;
  try {
    // capgo hangs at authorization/import on iOS 26.5 (build 13 confirmed
    // "hung@authorizing" — it never returns, never throws, even with an internal
    // timeout). So physiology is read through our OWN HealthExtras plugin
    // instead. HealthKit authorization is app-level, not per-plugin: the user
    // has already granted (all Health toggles ON), so HealthExtras reads the
    // exact same store capgo can't reach. This pulls resting HR, HRV, steps, AND
    // sleep (sleepAnalysis category) — the full recovery picture.
    // Bounded: if our own plugin's auth also hangs on this OS, proceed anyway —
    // the grant is already in HealthKit (app-level), so the reads still work.
    // Request the core read types in the PRIMARY sheet, including `workouts`
    // and `heartRate` (the per-workout HR stream). iOS presents the sheet only
    // for types it has not asked about, so on every later call this resolves
    // without UI. Shared with the workout sync's one-time heart-rate request.
    _lastPhysiologyDiag = `${TAG} hung@requestPerms`;
    await requestCorePermissions();
    stage = 'perms-done';

    // Window: local midnight `days` ago to now, sleep from the noon before, so
    // every date the sync writes was read in full (newest-wins merge below).
    const now = new Date();
    const { since, sleepSince } = applePhysiologyWindow(days, now);
    const sinceISO = since.toISOString();
    const sleepSinceISO = sleepSince.toISOString();
    const nowISO = now.toISOString();

    // Each read via HealthExtras (already internally try/caught → [] on error),
    // wrapped in our own timeout so a stuck native read can't freeze the flow.
    // limit 0 = HKObjectQueryNoLimit (every sample in the window). The old
    // limits (1000 quantity, 4000 sleep) were applied oldest-first, so a long
    // read lost the NEWEST days: raw step samples run to hundreds a day, and a
    // staged Watch night is dozens of segments.
    _lastPhysiologyDiag = `${TAG} hung@reads`;
    const readQ = (dataType: 'restingHeartRate' | 'heartRateVariabilitySDNN' | 'stepCount' | 'respiratoryRate' | 'oxygenSaturation', label: string) =>
      withTimeout(
        readQuantitySamples({ dataType, startDate: sinceISO, endDate: nowISO, limit: 0, ascending: true })
          .catch((e: any) => { readErrs.push(`${label}:${String(e?.message ?? e).slice(0, 40)}`); return []; }),
        PHYS_READ_TIMEOUT_MS,
        [],
      );
    const [rhrSamples, hrvSamples, stepSamples, respSamples, spo2Samples, sleepSamples] = await Promise.all([
      readQ('restingHeartRate', 'rhr'),
      readQ('heartRateVariabilitySDNN', 'hrv'),
      readQ('stepCount', 'steps'),
      readQ('respiratoryRate', 'resp'),
      readQ('oxygenSaturation', 'spo2'),
      withTimeout(
        readSleepSamples({ startDate: sleepSinceISO, endDate: nowISO, limit: 0 })
          .catch((e: any) => { readErrs.push(`sleep:${String(e?.message ?? e).slice(0, 40)}`); return []; }),
        PHYS_READ_TIMEOUT_MS,
        [],
      ),
    ]);
    stage = 'read';

    // On-device diagnostic. `via=extras` marks the HealthExtras path so a
    // screenshot confirms we're off capgo. Counts tell us if data flowed.
    _lastPhysiologyDiag =
      `${TAG} via=extras rhr=${rhrSamples.length} hrv=${hrvSamples.length} steps=${stepSamples.length} sleep=${sleepSamples.length}` +
      (readErrs.length ? ` errs=[${readErrs.join(' | ')}]` : '');
    console.log('[AppleHealthSync] physiology diag:', _lastPhysiologyDiag);

    // Local-date day keys, nights keyed by wake date with the pre-midnight part
    // kept, one sleep source per night, steps de-duplicated across sources.
    const entries = buildApplePhysiologyEntries({
      rhr: rhrSamples, hrv: hrvSamples, steps: stepSamples,
      resp: respSamples, spo2: spo2Samples, sleep: sleepSamples,
    }, now);
    if (entries.length === 0) return false;

    // ── Store in state ─────────────────────────────────────────────────────
    const s = getMutableState();
    s.physiologyHistory = mergeApplePhysiologyEntries(
      s.physiologyHistory ?? [],
      entries,
      getPhysiologySource(s) === 'apple',
    ).slice(-28);

    // Update top-level state fields from latest entry
    const latest = entries[entries.length - 1];
    if (latest.restingHR != null) s.restingHR = latest.restingHR;

    saveState();
    console.log(`[AppleHealthSync] Physiology: ${entries.length} days synced (sleep/HRV/RHR/steps)`);
    return true;
  } catch (err) {
    console.warn('[AppleHealthSync] Physiology sync failed:', err);
    // Surface where it died so the on-device card shows the real cause, not a
    // silent "no data". Always overwrite (the breadcrumb only holds "hung@X").
    _lastPhysiologyDiag = `${DIAG_BUILD_TAG} threw@${stage}: ${String((err as any)?.message ?? err).slice(0, 90)}` +
      (readErrs.length ? ` errs=[${readErrs.join(' | ')}]` : '');
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
export function computeSleepScore(entry: PhysiologyDayEntry): number {
  const totalSleep = entry.sleepDurationSec ?? 0;
  if (totalSleep < 1800) return 0;  // < 30 min = not a real sleep session

  // Duration component: 100 at target, linear ramp up, gentle penalty below
  const target = DEFAULT_SLEEP_TARGET_SEC;
  const durationRatio = totalSleep / target;
  const durationScore = Math.min(100, durationRatio * 100);

  // Stage-less sources: many non-Apple watches (Garmin, Coros, Polar, basic
  // trackers) write only a generic 'asleep' state to HealthKit with no
  // deep/REM breakdown, so both architecture components read zero. Scoring the
  // 25%-deep + 20%-REM weights as 0 would hard-cap an 8h healthy night at
  // 55/100 and drag Readiness down for every non-Apple-Watch user. When no
  // architecture was reported, score on the only signal we have (duration) —
  // i.e. renormalise the 55% duration weight to 100%. Introduces no new
  // constants. Staged nights (any deep OR REM present) keep the full formula,
  // so a genuinely low-deep night is still penalised correctly.
  const hasArchitecture = (entry.sleepDeepSec ?? 0) > 0 || (entry.sleepRemSec ?? 0) > 0;
  if (!hasArchitecture) {
    return Math.round(Math.max(0, Math.min(100, durationScore)));
  }

  // Deep sleep: ideal is 15-20% of total. Score peaks at 17.5%.
  const deepPct = totalSleep > 0 ? (entry.sleepDeepSec ?? 0) / totalSleep : 0;
  const deepScore = Math.min(100, (deepPct / 0.175) * 100);

  // REM: ideal is 20-25% of total. Score peaks at 22.5%.
  const remPct = totalSleep > 0 ? (entry.sleepRemSec ?? 0) / totalSleep : 0;
  const remScore = Math.min(100, (remPct / 0.225) * 100);

  const score = durationScore * 0.55 + deepScore * 0.25 + remScore * 0.20;
  return Math.round(Math.max(0, Math.min(100, score)));
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
   *  cycling power stream. Feeds the FTP estimator's primary path so Apple
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
  // best_efforts isn't part of GarminActivityRow's typed surface. It lives on
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
  // separate series type. Querying per-workout would mean N HealthKit reads;
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

  const s = getMutableState();
  const sex = resolveTrimpSex(s); // same sex resolution as the normaliser (trimp.ts)
  const restingHR = (s.restingHR && s.restingHR > 0) ? s.restingHR : null;
  const userMaxHR = (s.maxHR && s.maxHR > 0) ? s.maxHR : null;
  // Resolve a maxHR for the iTRIMP integration: explicit s.maxHR wins, else
  // Tanaka 208 - 0.7 × age (Tanaka et al. 2001. Better than 220−age, valid
  // 18–80y). Apple Watch doesn't expose true maxHR directly, so for an
  // Apple-only user this is the best fallback we have without lab testing.
  // null when neither is available → iTRIMP stays null, healMissingITrimp
  // recovers later.
  const age = s.onboarding?.age;
  const resolvedMaxHR = resolveMaxHR(userMaxHR, age);
  // `s.lt` is a pace in sec/km, NOT lactate-threshold HR. CalculateZones
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
        // unavailable types. Same as a permission denial. And we treat both
        // identically.
        const sport = mapWorkoutType(w.workoutType);
        const isRun = sport === 'RUNNING';
        const isRide = sport === 'CYCLING';

        const [hrRes, powerSamples, speedSamples] = await Promise.all([
          // HR stream via HealthExtras (capgo's readSamples path is dead on
          // iOS 26.x). readQuantitySamples returns QuantitySample[] (value +
          // startDate/endDate) — structurally what computeHREnrichment reads, so
          // wrap as { samples } and cast to keep the downstream code unchanged.
          readQuantitySamples({
            dataType: 'heartRate',
            startDate: w.startDate,
            endDate: w.endDate,
            limit: HR_SAMPLE_LIMIT,
            ascending: true,
          }).then((samples) => ({ samples: samples as unknown as HealthSample[] })),
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
          // Speed stream. The fallback source for per-km splits when no GPS
          // route bridged. Garmin Connect → Apple Health drops the route but may
          // still write runningSpeed / cyclingSpeed samples; integrating those
          // gives splits without GPS. Empty array on non-run/ride or when the
          // type isn't written.
          isRun
            ? readQuantitySamples({
                dataType: 'runningSpeed',
                startDate: w.startDate,
                endDate: w.endDate,
                limit: HR_SAMPLE_LIMIT,
                ascending: true,
              })
            : isRide
            ? readQuantitySamples({
                dataType: 'cyclingSpeed',
                startDate: w.startDate,
                endDate: w.endDate,
                limit: HR_SAMPLE_LIMIT,
                ascending: true,
              })
            : Promise.resolve([]),
        ]);

        const samples = hrRes.samples ?? [];
        if (samples.length < 2) {
          // No HR. Still attach route + power if we have either, so the
          // activity surfaces an enriched view despite missing iTRIMP.
          const enrichment = buildEnrichmentWithoutHR(w, routes, powerSamples, speedSamples, isRun, isRide);
          if (enrichment) result.set(key, enrichment);
          return;
        }
        const base = computeHREnrichment(samples, w.startDate, restingHR, resolvedMaxHR, zones, sex);
        if (!base) return;

        // Splice route + power + rep detection onto the HR-derived enrichment.
        const enriched = decorateWithRouteAndPower(base, w, routes, samples, powerSamples, speedSamples, isRun, isRide);
        result.set(key, enriched);
      } catch (err) {
        // Per-workout failure is non-fatal. Leave row un-enriched and continue.
        console.warn(`[AppleHealthSync] HR enrichment failed for workout ${key}:`, err);
      }
    }));
  }

  // Observed-maxHR refinement. Apple Watch doesn't expose a true maxHR field,
  // but a user's HR during their hardest interval session lands within 1–2 bpm
  // of their lab-measured max. Far closer than Tanaka's population formula
  // (208 − 0.7×age can be off by 10–15 bpm individually).
  //
  // Uses the canonical corroborated-max estimator (max-hr-estimator.ts —
  // shared with the Garmin and Strava pipes): the peak must be witnessed by a
  // second workout within 5 bpm on a different day, so a single wrist
  // cadence-lock spike can no longer ratchet in permanently (the old raw
  // Math.max path had exactly that failure mode). Up-only ratchet preserved.
  // Mirrors the CLAUDE.md "Manually-set Benchmarks Yield to Improvements" rule.
  {
    const readings = workouts.flatMap(w => {
      const e = result.get(workoutKey(w));
      return e ? [{ maxHR: e.maxHR, date: w.startDate }] : [];
    });
    const { changed } = applyCorroboratedMaxHR(s, readings, 'AppleHealthSync');
    if (changed) saveState();
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
  // Map HealthKit samples to the (hrValues, timeOffsets) arrays the shared
  // helper expects, then delegate. Same [30,240] bpm artefact gate, same
  // >300s pause-gap exclusion, same avg/max/iTRIMP/zone math. Keeping the
  // Apple, FIT-import, and future Garmin parser paths on one canonical
  // computation (CLAUDE.md: two numbers that mean the same thing share a source).
  const startMs = new Date(workoutStartISO).getTime();
  const hrValues = samples.map(s => s.value);
  const timeOffsets = samples.map(s => (new Date(s.startDate).getTime() - startMs) / 1000);
  return computeHREnrichmentFromStreams(hrValues, timeOffsets, restingHR, userMaxHR, zones, sex);
}

/**
 * Splice route (polyline + km splits + best-efforts) and power samples onto
 * an HR-derived enrichment. Pure data-shape function. No HealthKit calls.
 */
function decorateWithRouteAndPower(
  base: HRWorkoutEnrichment,
  w: Workout,
  routes: Array<{ startDate: string; endDate: string; locations: RouteLocation[] }>,
  hrSamples: HealthSample[],
  powerSamples: Array<{ value: number; startDate: string; endDate: string }>,
  speedSamples: Array<{ value: number; startDate: string }>,
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
  // No GPS route (the Garmin → Apple Health bridge drops it): derive per-km
  // splits from the speed stream instead, anchored to the reported total
  // distance. This is the only free path to splits for a Garmin user.
  if ((!kmSplits || kmSplits.length === 0) && (isRun || isRide) && speedSamples.length >= 2) {
    const fromSpeed = computeSplitsFromSpeed(speedSamples, w.totalDistance ?? undefined);
    if (fromSpeed.length > 0) kmSplits = fromSpeed;
  }

  const powerStats = computePowerStats(powerSamples);
  // Compute NP + powerCurve only for rides (running power doesn't follow
  // the same energy-systems model. Coggan's NP formula is calibrated for
  // cycling). The FTP estimator only consumes powerCurve from cycling rides.
  const powerCurveData = isRide
    ? computeNPAndPowerCurve(powerSamples)
    : { normalizedPowerW: null, powerCurve: null };

  // Stream-based rep detection. Closes the rep-detection gap that previously
  // applied only to Strava users. Apple's GPS trace (for runs) or per-second
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
  // HR-only fallback. Fires when GPS (run) / power (ride) detection didn't
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
  speedSamples: Array<{ value: number; startDate: string }>,
  isRun: boolean,
  isRide: boolean,
): HRWorkoutEnrichment | null {
  const route = findRouteForWorkout(routes, w.startDate);
  const powerStats = computePowerStats(powerSamples);
  const hasRoute = route && route.length >= 2;
  const hasPower = powerStats.avg != null;
  // Speed-stream splits when no GPS route bridged (Garmin → Apple Health).
  const speedSplits = (!hasRoute && (isRun || isRide) && speedSamples.length >= 2)
    ? computeSplitsFromSpeed(speedSamples, w.totalDistance ?? undefined)
    : [];
  if (!hasRoute && !hasPower && speedSplits.length === 0) return null;

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
  if ((!kmSplits || kmSplits.length === 0) && speedSplits.length > 0) kmSplits = speedSplits;

  // Rep detection is still possible without HR. Pace-stream for runs and
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

  // We need to satisfy HRWorkoutEnrichment's required avg/max. Emit zeros
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
 *  `appleHealthRoute.ts`. Duplicated here to keep `decorateWithRouteAndPower`
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

// computePowerStats + computeNPAndPowerCurve now live in activityEnrichment.ts
// so Apple HealthKit, FIT/GPX/TCX import, and the future Garmin activityDetails
// parser all share one canonical power computation (CLAUDE.md: two numbers that
// mean the same thing must come from the same source). Imported at the top.

// ---------------------------------------------------------------------------
// Weekly history aggregation (Strava-history parity)
// ---------------------------------------------------------------------------

/**
 * Aggregate the 16-week backfill into per-week totals and write the same
 * state fields that `fetchStravaHistory` (in stravaSync.ts) sets. So the
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
/** Apple Health wrapper. Delegates to the shared, source-agnostic aggregator. */
function aggregateAppleHistory(rows: GarminActivityRow[]): void {
  aggregateHistoryFromRows(rows, { source: 'apple' });
}

/**
 * Aggregate a set of activity rows into weekly baselines (extended 52w +
 * canonical last-8), CTL / Signal-B baselines, detectedWeeklyKm, athlete tier,
 * archetype, and PB auto-fill. Source-agnostic. Used by BOTH the Apple Health
 * sync and the file-import pipeline (fitImport.ts) so the two stay in parity
 * instead of duplicating the math. Pure data processing, no native calls, so it
 * is safe to run on web. The `source` only gates which post-aggregation flags
 * get set (Apple's history-fetched markers vs. import's volume-confirmed flag).
 */
export function aggregateHistoryFromRows(
  rows: GarminActivityRow[],
  opts: { source: 'apple' | 'import' },
): void {
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

  // Calendar-fill 52 completed weeks back from this Monday so the array
  // index → calendar offset mapping is stable (same reasoning as Strava
  // history's zero-fill loop). 52 weeks feeds extendedHistoryKm for the
  // athlete-archetype classifier; historicWeekly* is then sliced to the
  // canonical last-8 window used by CTL/baseline math.
  const EXT_WEEKS = 52;
  const completedWeeks: { tss: number; rawTSS: number; runningKm: number; zoneBase: number; zoneThreshold: number; zoneIntensity: number }[] = [];
  const thisMondayDate = new Date(thisMondayISO + 'T00:00:00Z');
  for (let i = EXT_WEEKS; i >= 1; i--) {
    const d = new Date(thisMondayDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const ws = d.toISOString().slice(0, 10);
    completedWeeks.push(buildAppleWeekTotals(byWeek.get(ws) ?? []));
  }

  // Extended history (full 52w) for archetype detection + stats range toggles.
  s.extendedHistoryWeeks = EXT_WEEKS;
  s.extendedHistoryTSS = completedWeeks.map(w => w.tss);
  s.extendedHistoryKm = completedWeeks.map(w => w.runningKm);
  s.extendedHistoryZones = completedWeeks.map(w => ({
    base: w.zoneBase, threshold: w.zoneThreshold, intensity: w.zoneIntensity,
  }));

  // Canonical last-8-weeks slice for CTL EMA + baseline math (matches Strava).
  const last8 = completedWeeks.slice(-8);
  s.historicWeeklyTSS = last8.map(w => w.tss);
  s.historicWeeklyRawTSS = last8.map(w => w.rawTSS);
  s.historicWeeklyKm = last8.map(w => w.runningKm);
  s.historicWeeklyZones = last8.map(w => ({
    base: w.zoneBase, threshold: w.zoneThreshold, intensity: w.zoneIntensity,
  }));

  // Signal A CTL baseline (42-day EMA). Walk the FULL 52-week extended history
  // so the EMA converges properly (8-week slice would under-weight older
  // training and produce CTL ~25% low for athletes with long, steady history).
  const CTL_DECAY = Math.exp(-7 / 42);
  let ctl = 0;
  for (const w of completedWeeks) {
    ctl = ctl * CTL_DECAY + w.tss * (1 - CTL_DECAY);
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

  // Average weekly running km (last 4 weeks). Used to seed plan starting volume.
  const recentKm = s.historicWeeklyKm.slice(-4);
  s.detectedWeeklyKm = recentKm.length > 0
    ? Math.round(recentKm.reduce((a, b) => a + b, 0) / recentKm.length * 10) / 10
    : undefined;

  s.athleteTier = deriveAthleteTier(s.ctlBaseline ?? 0, {
    vdot: s.v,
    ftpWatts: s.onboarding?.triBike?.ftp,
  });

  // Athlete archetype. Re-classify whenever history is freshly aggregated.
  s.athleteArchetype = detectArchetype(s);
  console.log(`[AppleHealthHistory] archetype=${s.athleteArchetype.archetype} (${s.athleteArchetype.confidence}) — currentWk=${s.athleteArchetype.evidence.currentWeeklyKm}km peak52=${s.athleteArchetype.evidence.peakWeeklyKmPast52}km longest=${s.athleteArchetype.evidence.longestRunPast12moKm}km`);

  if (opts.source === 'apple') {
    s.appleHistoryFetched = true;
    s.appleHistoryLastRefreshedAt = new Date().toISOString();
  } else if (opts.source === 'import' && s.detectedWeeklyKm != null) {
    // Explicitly importing your own history is acceptance. Let the derived
    // weekly volume seed the plan's starting volume (D3 gate in initialization.ts).
    s.weeklyVolumeConfirmed = true;
  }

  // PB auto-fill from synthesized best_efforts. Each running row may carry a
  // `best_efforts` array (computed in `decorateWithRouteAndPower`) listing the
  // fastest 5K / 10K / Half / Marathon segments inside that workout's GPS
  // trace. We aggregate across all rows and pick the fastest per distance,
  // then merge into `s.pbs` and `s.onboarding.pbs` with the fastest-wins rule
  //. Same shape Strava's `best_efforts` flow produces. This is the
  // mechanism that lets an Apple-only user reach the review step with their
  // PBs auto-populated, mirroring the Strava onboarding experience.
  applyPBsFromRows(rows);

  console.log(`[AppleHealthHistory] 16w aggregated — CTL=${s.ctlBaseline}, signalB=${s.signalBBaseline}, weeklyKm=${s.detectedWeeklyKm}, tier=${s.athleteTier}`);

  // Heal pass. If any rows synced before restingHR/maxHR were known, this
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
/** Merge fastest-per-distance best_efforts from a set of rows into s.pbs and
 *  s.onboarding.pbs (fastest-wins / improvement-only). Source-agnostic: used by
 *  the Apple aggregator and the file-import pipeline. */
export function applyPBsFromRows(rows: GarminActivityRow[]): void {
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
  // Honour user PB-deletion tombstones (ISSUE-297 RC3): a detected effort that
  // is not genuinely faster than a deleted time must not silently re-add it.
  const tomb = s.deletedPbs;
  const allow = (k: keyof typeof fastest, cur?: number) =>
    fastest[k] != null && !isPbTombstoned(tomb, k, fastest[k]!) && (cur == null || fastest[k]! < cur);
  // Top-level PBs. Fastest-wins merge.
  const next = { ...(s.pbs ?? {}) } as Record<string, number>;
  if (allow('k5', next.k5)) next.k5 = fastest.k5!;
  if (allow('k10', next.k10)) next.k10 = fastest.k10!;
  if (allow('h', next.h)) next.h = fastest.h!;
  if (allow('m', next.m)) next.m = fastest.m!;
  s.pbs = next as any;

  // Mirror into onboarding.pbs so the review-step Continue gate sees them.
  if (s.onboarding) {
    const nextOnb = { ...(s.onboarding.pbs ?? {}) } as Record<string, number>;
    if (allow('k5', nextOnb.k5)) nextOnb.k5 = fastest.k5!;
    if (allow('k10', nextOnb.k10)) nextOnb.k10 = fastest.k10!;
    if (allow('h', nextOnb.h)) nextOnb.h = fastest.h!;
    if (allow('m', nextOnb.m)) nextOnb.m = fastest.m!;
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
    const runSpec = cfg?.runSpec ?? 0.40; // fallback for unknown sports. Same default the rest of the app uses
    const isRun = sportKey === 'running';

    const durationMin = row.duration_sec / 60;
    const iTrimp = row.iTrimp ?? null;
    // Signal B (raw physiological): iTRIMP-based when available, else
    // RPE-4 fallback (~0.92 TL/min) which matches the matcher's heuristic
    // at activity-matcher.ts:611.
    const raw = (iTrimp != null && iTrimp > 0)
      ? normalizeiTrimp(iTrimp)
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

// ---------------------------------------------------------------------------
// Background workout delivery. HealthKit observer
// ---------------------------------------------------------------------------

/** Debounce window. Apple Watch sometimes fires the observer 2 to 3 times in
 *  rapid succession as workout samples land in batches. Coalescing avoids
 *  redundant 14-day re-queries. */
const OBSERVER_DEBOUNCE_MS = 5_000;

let observerListenerHandle: PluginListenerHandle | null = null;
let observerDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Register the HealthKit workout observer and wire it to `syncAppleHealth()`.
 *
 * When iOS wakes the app (foreground or background) because a new HKWorkout
 * landed in HealthKit, the plugin emits `workoutDidArrive`. This handler
 * debounces 5s and runs the incremental sync, which matches the workout
 * against the plan via `matchAndAutoComplete()`.
 *
 * Idempotent. Subsequent calls return the existing handle without
 * re-subscribing. No-op on web/Android.
 *
 * Must be called *after* `syncAppleHealth()` has run at least once (so the
 * user has already been prompted for workout read permission via the existing
 * onboarding flow). Calling earlier registers an observer that never fires.
 */
export async function subscribeToWorkoutObserver(): Promise<void> {
  if (!isNativeiOS()) return;
  if (observerListenerHandle) return; // already subscribed

  try {
    const startResult = await startWorkoutObserver();
    if (!startResult.started) {
      console.warn('[AppleHealthSync] startWorkoutObserver did not start');
      return;
    }

    observerListenerHandle = await addWorkoutObserverListener((event) => {
      console.log(`[AppleHealthSync] workoutDidArrive: ${event.count} new sample(s)`);
      if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
      observerDebounceTimer = setTimeout(() => {
        observerDebounceTimer = null;
        syncAppleHealth().catch((err) => {
          console.warn('[AppleHealthSync] Observer-triggered sync failed', err);
        });
      }, OBSERVER_DEBOUNCE_MS);
    });

    console.log(`[AppleHealthSync] Workout observer subscribed (primed=${startResult.primed ?? false})`);
  } catch (err) {
    console.warn('[AppleHealthSync] subscribeToWorkoutObserver failed', err);
  }
}

// ---------------------------------------------------------------------------
// Foreground-resume re-sync
// ---------------------------------------------------------------------------

/** Minimum gap between a foreground-triggered re-sync and the last successful
 *  sync. A quick app-switch (notification glance, lock/unlock) inside this
 *  window does not re-query; only a genuine return after a real gap does. */
const FOREGROUND_RESYNC_MIN_GAP_MS = 5 * 60 * 1000;

let foregroundListenerRegistered = false;

/**
 * Re-run the incremental Apple Health sync when the app returns to the
 * foreground, provided the last successful sync was more than 5 minutes ago.
 *
 * Belt-and-braces companion to the HealthKit observer (`subscribeToWorkoutObserver`).
 * If iOS dropped the background `workoutDidArrive` push while the app was
 * suspended, this catches the missed workout the instant the user reopens the
 * app, without waiting for a cold launch. The 5-minute throttle (read against
 * `appleHistoryLastRefreshedAt`, now stamped on every sync) keeps a brief
 * app-switch from triggering a redundant 14-day re-query.
 *
 * Uses the WebView `visibilitychange` event rather than @capacitor/app, so no
 * new native plugin is required. Idempotent; no-op on web/Android.
 */
export function subscribeToForegroundResume(): void {
  if (!isNativeiOS()) return;
  if (foregroundListenerRegistered) return;
  foregroundListenerRegistered = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const s = getMutableState();
    const lastMs = s.appleHistoryLastRefreshedAt
      ? new Date(s.appleHistoryLastRefreshedAt).getTime()
      : 0;
    if (Date.now() - lastMs < FOREGROUND_RESYNC_MIN_GAP_MS) return;
    console.log('[AppleHealthSync] Foreground resume — last sync >5min ago, re-syncing');
    syncAppleHealth().catch((err) => {
      console.warn('[AppleHealthSync] Foreground-resume sync failed', err);
    });
  });

  console.log('[AppleHealthSync] Foreground-resume listener registered');
}
