-- Allow OAuth callbacks to redirect back to the origin that started the flow.
--
-- Previously both `garmin-auth-callback` and `strava-auth-callback` redirected
-- every user to a single hard-coded URL (APP_REDIRECT_URL env, defaulting to
-- localhost:5173). That breaks any dev workflow with multiple local ports —
-- e.g. running 5173 (real plan) and 5175 (onboarding sandbox) simultaneously.
--
-- We add an `app_origin` column on each ephemeral auth-request table. The
-- start function persists `window.location.origin` from the client; the
-- callback reads it back (after validating against an allowlist) and uses it
-- for the redirect. Falls back to APP_REDIRECT_URL if absent.

ALTER TABLE garmin_auth_requests ADD COLUMN IF NOT EXISTS app_origin text;
ALTER TABLE strava_auth_requests ADD COLUMN IF NOT EXISTS app_origin text;
