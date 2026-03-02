/**
 * Apple Health / Apple Watch sync.
 *
 * Uses @capgo/capacitor-health when running as a native iOS app, and falls
 * back to a no-op when running in browser/web mode.
 *
 * npx cap sync ios  — run after `npm install @capgo/capacitor-health`
 *
 * Required Info.plist keys:
 *   NSHealthShareUsageDescription  — "Used to sync workouts from Apple Watch"
 *   NSHealthUpdateUsageDescription — "Not required (read-only)"
 *
 * Data flow:
 *   1. requestAuthorization()     — ask user once on first sync
 *   2. fetchRecentWorkouts()      — read workout records for last 14 days
 *   3. convertToActivityRow()     — shape into the shared GarminActivityRow format
 *                                   so matchAndAutoComplete() can process them
 *   4. matchAndAutoComplete()     — shared engine handles plan updates
 */

import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { type WorkoutType, type Workout } from '@capgo/capacitor-health';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Returns true when running as a native iOS Capacitor app */
function isNativeiOS(): boolean {
  return (window as any)?.Capacitor?.platform === 'ios';
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
  const { Health } = await import('@capgo/capacitor-health');

  await Health.requestAuthorization({ read: ['calories', 'distance', 'heartRate'] });

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

/**
 * Convert a @capgo/capacitor-health Workout to the shared GarminActivityRow format.
 * We prefix the ID with "apple-" so the dedup logic in garminMatched works without
 * colliding with Garmin IDs.
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
