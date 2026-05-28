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

/**
 * Live Strava integration (OAuth connect UI + launch-time sync/backfill/restore).
 *
 * Strava's API is capped at 1 authorised user on the current app registration,
 * so for shipped users the live integration cannot function. The launch plan is
 * to PARK it: hide the connect UI and skip the launch-time network triggers,
 * keeping manual FIT/GPX/TCX file import (which works for everyone) as the path.
 *
 * WIRED & PARKED (Tristan, 2026-05-27). `false` buries Strava: hides all connect
 * UI (the plan-header button, the Account source rows, the auto-log banner) and
 * skips the launch-time sync / backfill / restore / self-heal network calls.
 * Flip to `true` to fully restore Strava in one change — e.g. if Strava ever
 * approves our API access. Every gated site keys off this constant; see
 * docs/STRAVA_PARKED.md for the full list. Existing synced Strava data is NOT
 * deleted by burying — only new syncs and the UI are suppressed.
 */
export const STRAVA_ENABLED: boolean = false;

/**
 * Live Garmin Connect integration (OAuth connect UI + launch-time physiology /
 * activity sync + backfill).
 *
 * The Garmin webhook is approved for a single developer account, so live Garmin
 * sync cannot function for shipped users. Launch plan: PARK the live OAuth/webhook
 * path. NOTE the deliberate asymmetry with the broader strategy — we still want to
 * SERVE Garmin users, but via manual file upload (export from Garmin Connect on a
 * laptop, upload on web, sync to iOS), not via live Connect OAuth. Whether the
 * Garmin button is hidden outright or repurposed into an "upload your Garmin runs"
 * affordance is decision D5.
 *
 * Wired into `src/ui/wizard/steps/connect-data.ts` (onboarding data-source step).
 * Flipped to `false` on 2026-05-28 to pause the OAuth surface in onboarding until
 * Garmin approves the webhook for production — the button was promising
 * sleep/HRV/RHR data that does not arrive for non-dev accounts. The Account-view
 * Garmin connect button is NOT yet gated by this flag (dev still needs it).
 */
export const GARMIN_CONNECT_ENABLED: boolean = false;
