-- =============================================================
-- Soft-delete + 30-day grace for account deletion.
--
-- App Store §5.1.1(v) + UK GDPR Art. 17 require an in-app account
-- deletion flow. The 30-day grace window matches the promise in
-- public/privacy.html and gives a one-tap undo path.
--
-- - delete-account edge fn writes `deleted_at = now()` to these three rows.
-- - purge-deleted-accounts cron hard-deletes rows where
--   deleted_at < now() - interval '30 days', then calls
--   auth.admin.deleteUser() (which cascades to every table with a
--   user_id FK referencing auth.users).
-- - RLS policies are updated to hide soft-deleted rows from the
--   client (so the user can't accidentally read stale state after
--   triggering deletion). Service-role bypasses RLS, so edge
--   functions keep working.
-- =============================================================

ALTER TABLE user_plan_settings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE strava_tokens      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE garmin_tokens      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_plan_settings_deleted_at
  ON user_plan_settings(deleted_at) WHERE deleted_at IS NOT NULL;

-- Hide soft-deleted user_plan_settings rows from the owner.
-- The user must sign back in before the purge to recover; the
-- cancel flow (delete-account?cancel=1) goes through the edge fn
-- which uses the service role, so deleted_at can still be cleared.
DO $$ BEGIN
  -- Replace the existing SELECT policy with a deleted_at filter.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_plan_settings' AND policyname = 'users can read own plan settings') THEN
    DROP POLICY "users can read own plan settings" ON user_plan_settings;
  END IF;
  CREATE POLICY "users can read own plan settings"
    ON user_plan_settings FOR SELECT
    USING (user_id = auth.uid() AND deleted_at IS NULL);

  -- Same for UPDATE — a user with a pending deletion shouldn't be able
  -- to mutate state through the rest of the app (only cancel via the fn).
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_plan_settings' AND policyname = 'users can update own plan settings') THEN
    DROP POLICY "users can update own plan settings" ON user_plan_settings;
  END IF;
  CREATE POLICY "users can update own plan settings"
    ON user_plan_settings FOR UPDATE
    USING (user_id = auth.uid() AND deleted_at IS NULL);
END $$;

-- strava_tokens — same pattern. Hide deleted rows from the owner so
-- the Strava-connected status flips to "not connected" immediately,
-- and the user can't accidentally re-sync activities after triggering
-- deletion.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'strava_tokens' AND policyname = 'strava_tokens_user_select') THEN
    DROP POLICY "strava_tokens_user_select" ON strava_tokens;
  END IF;
  CREATE POLICY "strava_tokens_user_select"
    ON strava_tokens FOR SELECT
    USING (user_id = auth.uid() AND deleted_at IS NULL);
END $$;

-- garmin_tokens — same pattern.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'garmin_tokens' AND policyname = 'garmin_tokens_user_select') THEN
    DROP POLICY "garmin_tokens_user_select" ON garmin_tokens;
  END IF;
  CREATE POLICY "garmin_tokens_user_select"
    ON garmin_tokens FOR SELECT
    USING (user_id = auth.uid() AND deleted_at IS NULL);
END $$;
