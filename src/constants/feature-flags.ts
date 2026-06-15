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
 * Per-activity "Add detail from Strava" enrichment on the activity detail page.
 *
 * A Garmin watch syncing into Apple Health only delivers average HR + duration:
 * HR zones, splits, route and iTRIMP are dropped at the Garmin→HealthKit
 * boundary. While Strava is capped at 10 athletes (no live pipe for most users),
 * this lets a user upload that activity's original .fit and enrich the existing
 * record in place (no duplicate, provenance preserved). Opt-in, per activity.
 *
 * Turn OFF once live full Strava access enriches automatically — the live
 * Strava-upgrade path then makes the manual button redundant.
 */
export const STRAVA_ENRICH_UPLOAD_ENABLED: boolean = true;

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

/**
 * AI Coach surface (LLM chat, training-snapshot export, "Generate with Coach"
 * brain workouts, the RevenueCat coach subscription + paywall).
 *
 * HIDDEN 2026-06-02 (Tristan) for App Store v1. Two independent reasons:
 *  1. Strava's June 2026 API Policy §5.3 bans feeding Strava Data (and anything
 *     derived from it) into an AI Application. Strava is the REQUIRED pipe for
 *     Garmin users, so the Coach cannot serve that cohort. See docs/AI_STRATEGY.md.
 *  2. A visible LLM coach (training advice, external-AI wiring, generative
 *     content) adds avoidable App Store review surface. v1 ships as a paid base
 *     app with no AI; the Coach stays in our back pocket.
 *
 * `false` buries every reachable entry point: the "Coach" buttons on the running,
 * triathlon, and home heroes, and the Account "AI Coach" section. `renderCoachView`
 * also hard-gates on this constant so there is NO ungated back door (the lesson
 * from GARMIN_CONNECT_ENABLED's "not yet gated" Account exception above).
 *
 * KEPT (deterministic, no LLM, no Strava-AI exposure): the daily-coach narration
 * (`computeDailyCoach`) rendered inline on home/plan, and the free rule-based
 * workout generator. Those are not gated by this flag.
 *
 * Unhiding depends on the Strava BYOK/personal-use answer (ISSUE-252) and an
 * App Store strategy for the AI surface. Do not flip without both.
 */
export const AI_COACH_ENABLED: boolean = false;

/**
 * Native OAuth (iOS). When ON, Strava/Garmin connect on native iOS opens the
 * authorize page in ASWebAuthenticationSession (the `@mosaic/web-auth` plugin),
 * which intercepts the `mosaic://oauth?...` callback and returns it to JS,
 * instead of throwing the whole WKWebView out to the provider with a full-page
 * `window.location.href` redirect (which can fail to bounce back on iOS).
 *
 * History (2026-06-15): an earlier attempt used `@capacitor/browser`
 * (SFSafariViewController) + a `mosaic://` deep link via `@capacitor/app`
 * `appUrlOpen`. That hit two walls — SFSafariViewController refuses to follow a
 * 302 to a custom scheme ("address is invalid"), and the Supabase edge gateway
 * force-rewrites responses to text/plain so the HTML JS-redirect workaround
 * rendered as raw source. ASWebAuthenticationSession is iOS's purpose-built
 * OAuth presentation and handles the custom-scheme callback natively.
 *
 * Prerequisite checklist:
 *   1. `@mosaic/web-auth` plugin synced into the iOS project — needs `cap sync
 *      ios` + an Xcode rebuild + a fresh TestFlight build (native code change).
 *   2. The `mosaic://` URL scheme registered in `ios/App/App/Info.plist` — DONE.
 *   3. `strava-auth-callback` + `garmin-auth-callback` deployed (302 → mosaic://
 *      for native; idempotent) — DONE 2026-06-15.
 *   4. A fresh native build installed + device-tested — pending (Tristan).
 *
 * On web this is always a no-op (gated by isNativeiOS()); web keeps the
 * full-page redirect. See docs/RUNBOOK.md → Native OAuth.
 */
export const NATIVE_OAUTH_ENABLED: boolean = true;
