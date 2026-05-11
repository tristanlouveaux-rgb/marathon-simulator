/**
 * HealthExtras — typed bridge to MosaicHealthExtras Capacitor plugin.
 *
 * Exposes HealthKit fields that @capgo/capacitor-health doesn't surface:
 * VO2max, running power, cycling power & FTP, GPS workout routes, running
 * form metrics (stride length, ground contact time, vertical oscillation,
 * running speed), wrist temperature, walking HR average.
 *
 * iOS-only — methods return null/empty arrays on web/Android. Native iOS
 * version gating happens inside the Swift plugin, so requesting an iOS-17+
 * type on iOS 16 silently drops it from the request rather than throwing.
 */

import { registerPlugin } from '@capacitor/core';

export type HealthExtrasDataType =
  // iOS 11+
  | 'vo2Max'
  | 'walkingHeartRateAverage'
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

/** Permission identifiers — superset of HealthExtrasDataType plus the route series type. */
export type HealthExtrasPermission = HealthExtrasDataType | 'workoutRoute';

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

  readWorkoutRouteLocations(opts: {
    startDate?: string;
    endDate?: string;
  }): Promise<{ routes: WorkoutRoute[] }>;
}

/** Underlying plugin handle. On non-iOS, Capacitor's web shim throws when
 *  methods are called — wrappers below catch and return empty results. */
const HealthExtras = registerPlugin<HealthExtrasPlugin>('HealthExtras');

/** Returns true on native iOS, false on web/Android. Mirrors `isNativeiOS()`
 *  in appleHealthSync.ts so consumers can guard before calling. */
export function isHealthExtrasAvailable(): boolean {
  return (window as any)?.Capacitor?.platform === 'ios';
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
 *  when nothing exists or on permission denial — caller can detect via the
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
