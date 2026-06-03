-- =============================================================
-- Enable Row Level Security on garmin_activities.
--
-- Until now this table had RLS DISABLED, so cross-user isolation depended
-- entirely on every query remembering to add `.eq('user_id', ...)`. A single
-- missing filter would leak every user's activities. This adds database-level
-- enforcement so a code mistake can't cause a cross-user leak.
--
-- Writes are unaffected: the webhook and sync functions use the service-role
-- key, which bypasses RLS. Only a SELECT policy is needed (clients read their
-- own rows; they never write this table directly).
-- =============================================================

ALTER TABLE garmin_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own garmin_activities" ON garmin_activities;
CREATE POLICY "Users read own garmin_activities"
  ON garmin_activities
  FOR SELECT
  USING (user_id = auth.uid());
