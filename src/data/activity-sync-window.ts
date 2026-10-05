/**
 * Lookback window for every automatic incremental activity sync: Strava
 * (syncStravaActivities), the Garmin/DB sync (syncActivities) and the Apple
 * Health workout sync after its first backfill (syncAppleHealth).
 *
 * 28 days is the window the Strava and Garmin syncs have always used. Apple
 * used 14 (audit D5), so after a 15 to 28 day gap with no sync the older
 * sessions never reached the matcher or garmin_activities. One shared constant
 * keeps the three windows from drifting apart again.
 *
 * Leaf module (no imports) so it can be read at module load from files that sit
 * in an import cycle (appleHealthSync.ts and stravaSync.ts import each other).
 */
export const ACTIVITY_SYNC_LOOKBACK_DAYS = 28;
