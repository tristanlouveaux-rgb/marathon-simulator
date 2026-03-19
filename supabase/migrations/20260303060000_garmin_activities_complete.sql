-- =============================================================
-- Ensure garmin_activities has all required columns
-- (Catches up from migrations that were marked applied without
-- actually running the ALTER TABLE statements.)
-- =============================================================

ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS source          text;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS avg_pace_sec_km integer;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS itrimp          float;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_zones        jsonb;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS km_splits       integer[];
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS polyline        text;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS activity_name   text;

CREATE INDEX IF NOT EXISTS idx_garmin_activities_source ON garmin_activities(source);

-- Strava OAuth policies (idempotent guard in case strava_tokens exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'strava_tokens' AND policyname = 'strava_tokens_user_select') THEN
    CREATE POLICY "strava_tokens_user_select" ON strava_tokens FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'strava_tokens' AND policyname = 'strava_tokens_user_update') THEN
    CREATE POLICY "strava_tokens_user_update" ON strava_tokens FOR UPDATE USING (user_id = auth.uid());
  END IF;
END $$;
