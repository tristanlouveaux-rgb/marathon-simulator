/**
 * Build-time feature flags. Flip a constant here to enable or disable a
 * behaviour without editing call sites. Keep flags small and short-lived;
 * remove a flag once the feature is settled.
 */

/**
 * Auto-fill the bike & aero setup overlay:
 *  - Course profile pre-fills from the user's selected IRONMAN race.
 *  - Adds an "Auto-calibrate from a recent flat ride" button that picks a
 *    qualifying Strava ride and computes CdA without manual entry.
 * Both behaviours are off when this is false; the manual flow still works.
 */
export const BIKE_SETUP_AUTO_FILL = true;
