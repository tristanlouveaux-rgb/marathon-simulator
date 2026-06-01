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
 * RE-ENABLED 2026-06-01 (Tristan). Strava's June 2026 Developer Program overhaul
 * lets Standard Tier self-serve up to 10 athletes with no review. Tristan upgraded
 * (now at 10 athletes; his Strava Premium satisfies the developer-subscription
 * requirement). Strava is the REQUIRED activity pipe for Garmin users (Garmin's own
 * API is closed to us, the aggregator fallback was killed by the same overhaul, and
 * the Garmin->Apple Health bridge drops per-km splits). See docs/STRAVALESS_PLAN.md.
 *
 * CEILING: 10 athletes on Standard Tier. This is the BETA path, NOT public scale.
 * Public launch with Strava needs Extended Access Tier approval (see docs/STRAVA_PARKED.md
 * -> Extended Access). Do not advertise Strava connect to >10 users until that lands.
 *
 * Apple Health remains the separate, uncapped pipe for Apple Watch users (routed in
 * main.ts: activitySrc === 'apple'). The two pipelines coexist by design.
 *
 * `false` buries Strava: hides all connect UI (plan-header button, Account source
 * rows, auto-log banner) and skips launch-time sync/backfill/restore/self-heal.
 * Every gated site keys off this constant; see docs/STRAVA_PARKED.md for the full list.
 */
export const STRAVA_ENABLED: boolean = true;

/**
 * Live Garmin Connect integration (OAuth connect UI + launch-time physiology /
 * activity sync + backfill).
 *
 * The Garmin webhook is approved for a single developer account, so live Garmin
 * sync cannot function for shipped users. Launch plan: PARK the live OAuth/webhook
 * path. NOTE the deliberate asymmetry with the broader strategy. We still want to
 * SERVE Garmin users, but via manual file upload (export from Garmin Connect on a
 * laptop, upload on web, sync to iOS), not via live Connect OAuth. Whether the
 * Garmin button is hidden outright or repurposed into an "upload your Garmin runs"
 * affordance is decision D5.
 *
 * Wired into `src/ui/wizard/steps/connect-data.ts` (onboarding data-source step).
 * Flipped to `false` on 2026-05-28 to pause the OAuth surface in onboarding until
 * Garmin approves the webhook for production. The button was promising
 * sleep/HRV/RHR data that does not arrive for non-dev accounts. The Account-view
 * Garmin connect button is NOT yet gated by this flag (dev still needs it).
 */
export const GARMIN_CONNECT_ENABLED: boolean = false;
