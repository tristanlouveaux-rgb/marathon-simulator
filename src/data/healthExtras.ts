/**
 * HealthExtras. Typed bridge to MosaicHealthExtras Capacitor plugin.
 *
 * Exposes HealthKit fields that @capgo/capacitor-health doesn't surface:
 * VO2max, running power, cycling power & FTP, GPS workout routes, running
 * form metrics (stride length, ground contact time, vertical oscillation,
 * running speed), wrist temperature, walking HR average.
 *
 * iOS-only. Methods return null/empty arrays on web/Android. Native iOS
 * version gating happens inside the Swift plugin, so requesting an iOS-17+
 * type on iOS 16 silently drops it from the request rather than throwing.
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type HealthExtrasDataType =
  // iOS 11+
  | 'vo2Max'
  | 'walkingHeartRateAverage'
  // Physiology — read via HealthExtras (not capgo, which crashes on iOS 26.x).
  | 'restingHeartRate'
  | 'heartRateVariabilitySDNN'
  | 'stepCount'
  | 'heartRate'
  // Anthropometrics + extra recovery signals
  | 'bodyMass'
  | 'height'
  | 'bodyFatPercentage'
  | 'respiratoryRate'
  | 'oxygenSaturation'
  // iOS 16+
  | 'appleSleepingWristTemperature'
  | 'runningPower'
  | 'runningSpeed'
  | 'runningStrideLength'
  | 'runningGroundContactTime'
  | 'runningVerticalOscillation'
  // iOS 17+
  | 'cyclingPower'
  | 'cyclingCadence'
  | 'cyclingSpeed'
  | 'cyclingFunctionalThresholdPower';

/** Permission identifiers — superset of HealthExtrasDataType plus the route
 *  series type, sleep category, and workout type. */
export type HealthExtrasPermission =
  | HealthExtrasDataType
  | 'workoutRoute'
  | 'sleepAnalysis'
  | 'workouts'
  | 'dateOfBirth'
  | 'biologicalSex';

/** One sleep stage segment from HealthKit. `value` is the raw
 *  HKCategoryValueSleepAnalysis (0 inBed, 1 asleepUnspecified, 2 awake,
 *  3 asleepCore/light, 4 asleepDeep, 5 asleepREM). */
export interface SleepSample {
  value: number;
  startDate: string;
  endDate: string;
  sourceName?: string;
}

/** Immutable HealthKit characteristics. Either field is null when not set in
 *  Health or read access wasn't granted. */
export interface HealthCharacteristics {
  dateOfBirth: string | null;   // ISO 8601
  biologicalSex: 'male' | 'female' | 'other' | null;
}

/** One HKWorkout. Field shape matches capgo's old `Workout` so the TS
 *  converter in appleHealthSync is reused unchanged. */
export interface ExtrasWorkout {
  workoutType: string;          // capgo-style key (running/cycling/…)
  startDate: string;            // ISO 8601
  endDate: string;
  duration: number;             // seconds
  totalDistance: number | null; // metres
  totalEnergyBurned: number | null; // kcal
  sourceName?: string;
  sourceId?: string;
}

export interface QuantitySample {
  value: number;
  unit: string;
  startDate: string; // ISO 8601
  endDate: string;
  sourceName?: string;
}

export interface LatestQuantity {
  value: number | null;
  unit?: string;
  asOf: string | null;
  sourceName?: string;
}

export interface RouteLocation {
  lat: number;
  lng: number;
  altitude: number;
  speed: number;       // m/s
  course: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
  timestamp: string;   // ISO 8601
}

export interface WorkoutRoute {
  startDate: string;
  endDate: string;
  locations: RouteLocation[];
}

interface HealthExtrasPlugin {
  checkAvailability(opts: { dataTypes: HealthExtrasPermission[] }): Promise<{
    available: HealthExtrasPermission[];
    unavailable: HealthExtrasPermission[];
  }>;

  requestPermissions(opts: { read: HealthExtrasPermission[] }): Promise<{
    granted: HealthExtrasPermission[];
    denied: HealthExtrasPermission[];
    success: boolean;
  }>;

  openAppSettings(): Promise<{ opened: boolean }>;

  readQuantitySamples(opts: {
    dataType: HealthExtrasDataType;
    startDate?: string;
    endDate?: string;
    limit?: number;
    ascending?: boolean;
  }): Promise<{ samples: QuantitySample[] }>;

  readLatestQuantity(opts: {
    dataType: HealthExtrasDataType;
    startDate?: string;
    endDate?: string;
  }): Promise<LatestQuantity>;

  readSleepSamples(opts: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<{ samples: SleepSample[] }>;

  readCharacteristics(): Promise<HealthCharacteristics>;

  queryWorkouts(opts: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    ascending?: boolean;
  }): Promise<{ workouts: ExtrasWorkout[] }>;

  readWorkoutRouteLocations(opts: {
    startDate?: string;
    endDate?: string;
  }): Promise<{ routes: WorkoutRoute[] }>;

  startWorkoutObserver(): Promise<{
    started: boolean;
    alreadyRunning: boolean;
    primed?: boolean;
  }>;

  stopWorkoutObserver(): Promise<{ stopped: boolean }>;

  addListener(
    eventName: 'workoutDidArrive',
    callback: (event: WorkoutDidArriveEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

export interface WorkoutDidArriveEvent {
  /** Number of new HKWorkout samples written to HealthKit since the last
   *  observer fire. Always ≥ 1. The plugin suppresses zero-sample fires. */
  count: number;
}

/** Underlying plugin handle. On non-iOS, Capacitor's web shim throws when
 *  methods are called. Wrappers below catch and return empty results. */
const HealthExtras = registerPlugin<HealthExtrasPlugin>('HealthExtras');

/** Returns true on native iOS, false on web/Android. Mirrors `isNativeiOS()`
 *  in appleHealthSync.ts so consumers can guard before calling. Uses
 *  `Capacitor.getPlatform()` because the legacy `.platform` property was
 *  removed in Capacitor ≥ 5 and returns undefined on device. */
export function isHealthExtrasAvailable(): boolean {
  return (window as any)?.Capacitor?.getPlatform?.() === 'ios';
}

/**
 * Request HealthKit read permission for the given data types. Idempotent —
 * iOS only prompts the user the first time per type. Returns the granted
 * subset; callers can persist this list to skip already-denied types in
 * future sync passes.
 *
 * Note on HealthKit's privacy model: read-only requests don't tell us
 * which permissions were truly granted (Apple deliberately hides this so
 * apps can't infer what the user has tracked). We approximate via
 * `authorizationStatus`, which returns sharingDenied or notDetermined —
 * we report notDetermined as "granted" since a subsequent query will
 * succeed if access was given and silently return empty otherwise.
 */
export async function requestHealthExtrasPermissions(
  read: HealthExtrasPermission[],
): Promise<{ granted: HealthExtrasPermission[]; denied: HealthExtrasPermission[] }> {
  if (!isHealthExtrasAvailable()) return { granted: [], denied: read };
  try {
    const res = await HealthExtras.requestPermissions({ read });
    return { granted: res.granted, denied: res.denied };
  } catch (err) {
    console.warn('[HealthExtras] permission request failed', err);
    return { granted: [], denied: read };
  }
}

/**
 * Open iOS Settings to Mosaic's app page so the user can turn Apple Health
 * access back on. Once the HealthKit permission sheet has been answered, iOS
 * never re-presents it via requestAuthorization, so Settings is the only
 * recovery. Returns false on web/Android or if the URL can't be opened.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!isHealthExtrasAvailable()) return false;
  try {
    const res = await HealthExtras.openAppSettings();
    return !!res.opened;
  } catch (err) {
    console.warn('[HealthExtras] openAppSettings failed', err);
    return false;
  }
}

/**
 * Filter a list of data types down to those usable on this iOS version.
 * Useful before requestPermissions so we don't waste a prompt on iOS-17+
 * types when the user is on iOS 16.
 */
export async function checkAvailability(
  dataTypes: HealthExtrasPermission[],
): Promise<{ available: HealthExtrasPermission[]; unavailable: HealthExtrasPermission[] }> {
  if (!isHealthExtrasAvailable()) return { available: [], unavailable: dataTypes };
  try {
    return await HealthExtras.checkAvailability({ dataTypes });
  } catch (err) {
    console.warn('[HealthExtras] availability check failed', err);
    return { available: [], unavailable: dataTypes };
  }
}

/** Read all quantity samples for a type within a date window. Empty array
 *  on web/Android, on permission denial, or on plugin error. */
export async function readQuantitySamples(opts: {
  dataType: HealthExtrasDataType;
  startDate?: string;
  endDate?: string;
  limit?: number;
  ascending?: boolean;
}): Promise<QuantitySample[]> {
  if (!isHealthExtrasAvailable()) return [];
  try {
    const res = await HealthExtras.readQuantitySamples(opts);
    return res.samples ?? [];
  } catch (err) {
    console.warn(`[HealthExtras] readQuantitySamples ${opts.dataType} failed`, err);
    return [];
  }
}

/** Most recent value of a quantity type. Returns { value: null, asOf: null }
 *  when nothing exists or on permission denial. Caller can detect via the
 *  null sentinel and fall back to a derived value. */
export async function readLatestQuantity(opts: {
  dataType: HealthExtrasDataType;
  startDate?: string;
  endDate?: string;
}): Promise<LatestQuantity> {
  if (!isHealthExtrasAvailable()) return { value: null, asOf: null };
  try {
    return await HealthExtras.readLatestQuantity(opts);
  } catch (err) {
    console.warn(`[HealthExtras] readLatestQuantity ${opts.dataType} failed`, err);
    return { value: null, asOf: null };
  }
}

/** Sleep stage segments in the window. Empty array on web/Android, denial, or
 *  error. Caller maps `value` to stages and computes durations. */
export async function readSleepSamples(opts: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<SleepSample[]> {
  if (!isHealthExtrasAvailable()) return [];
  try {
    const res = await HealthExtras.readSleepSamples(opts);
    return res.samples ?? [];
  } catch (err) {
    console.warn('[HealthExtras] readSleepSamples failed', err);
    return [];
  }
}

/** Immutable HealthKit characteristics (DOB + biological sex). Returns nulls on
 *  web/Android, when unset in Health, or on denial. */
export async function readCharacteristics(): Promise<HealthCharacteristics> {
  if (!isHealthExtrasAvailable()) return { dateOfBirth: null, biologicalSex: null };
  try {
    return await HealthExtras.readCharacteristics();
  } catch (err) {
    console.warn('[HealthExtras] readCharacteristics failed', err);
    return { dateOfBirth: null, biologicalSex: null };
  }
}

/** Query HKWorkout samples in the window. Empty array on web/Android, denial,
 *  or error. Replaces capgo's queryWorkouts (which crashes auth on iOS 26.x). */
export async function queryWorkouts(opts: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  ascending?: boolean;
}): Promise<ExtrasWorkout[]> {
  if (!isHealthExtrasAvailable()) return [];
  try {
    const res = await HealthExtras.queryWorkouts(opts);
    return res.workouts ?? [];
  } catch (err) {
    console.warn('[HealthExtras] queryWorkouts failed', err);
    return [];
  }
}

/**
 * Read GPS workout routes within the date window. Returns an array of
 * routes (one per HKWorkoutRoute series), each with a `locations` array of
 * CLLocation-equivalent points. Caller is responsible for matching routes
 * back to their parent workouts via the route's startDate (which
 * approximately matches the workout's startDate within a few seconds).
 *
 * For a 16-week backfill across ~150 workouts this can return tens of
 * thousands of location points. The caller should encode (e.g. via
 * polyline) before persisting to localStorage to keep the payload small.
 */
export async function readWorkoutRouteLocations(opts: {
  startDate?: string;
  endDate?: string;
}): Promise<WorkoutRoute[]> {
  if (!isHealthExtrasAvailable()) return [];
  try {
    const res = await HealthExtras.readWorkoutRouteLocations(opts);
    return res.routes ?? [];
  } catch (err) {
    console.warn('[HealthExtras] readWorkoutRouteLocations failed', err);
    return [];
  }
}

/**
 * Register an HKObserverQuery for HKWorkoutType and enable background
 * delivery. Once registered, iOS wakes the app whenever a new workout is
 * written to HealthKit (Apple Watch, Strava-to-Health, Garmin Connect-to-
 * Health, etc.) and emits a `workoutDidArrive` event.
 *
 * Idempotent. Safe to call on every launch; the Swift plugin no-ops if
 * already registered. The first ever call primes an HKQueryAnchor so the
 * existing workout history is not treated as "new".
 *
 * No-op on web/Android.
 */
export async function startWorkoutObserver(): Promise<{
  started: boolean;
  alreadyRunning: boolean;
  primed?: boolean;
}> {
  if (!isHealthExtrasAvailable()) {
    return { started: false, alreadyRunning: false };
  }
  try {
    return await HealthExtras.startWorkoutObserver();
  } catch (err) {
    console.warn('[HealthExtras] startWorkoutObserver failed', err);
    return { started: false, alreadyRunning: false };
  }
}

export async function stopWorkoutObserver(): Promise<void> {
  if (!isHealthExtrasAvailable()) return;
  try {
    await HealthExtras.stopWorkoutObserver();
  } catch (err) {
    console.warn('[HealthExtras] stopWorkoutObserver failed', err);
  }
}

/**
 * Subscribe to the `workoutDidArrive` event. Returns a PluginListenerHandle
 * the caller can use to detach. Detaching is rarely needed. The plugin's
 * listener registry is cleared on app cold start anyway.
 *
 * No-op on web/Android (returns a no-op handle).
 */
export async function addWorkoutObserverListener(
  callback: (event: WorkoutDidArriveEvent) => void,
): Promise<PluginListenerHandle> {
  if (!isHealthExtrasAvailable()) {
    return { remove: async () => undefined };
  }
  return HealthExtras.addListener('workoutDidArrive', callback);
}
