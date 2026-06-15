-- =============================================================
-- Idempotent OAuth callbacks (fixes the "invalid_state" error page)
-- =============================================================
--
-- Symptom: after a successful Strava/Garmin connect on native iOS, the in-app
-- Safari sheet showed `{"error":"invalid_state","details":null}`. Root cause:
-- the callback DELETEd the ephemeral auth-request row on success, so any second
-- hit of the same callback URL (the SFSafariViewController re-requesting after a
-- `mosaic://` redirect it can't navigate, or a manual reload) found no row and
-- returned invalid_state — even though the connection had already succeeded.
--
-- Fix: stop deleting. Mark the row consumed instead, so a re-hit can be
-- recognised as a duplicate and replayed into the success redirect. A separate
-- opportunistic purge in the callback removes consumed rows older than an hour,
-- so the table does not grow unbounded.

ALTER TABLE strava_auth_requests ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE garmin_auth_requests ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
