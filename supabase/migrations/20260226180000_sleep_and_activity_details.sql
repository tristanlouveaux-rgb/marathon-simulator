-- =============================================================
-- Sleep summaries + activity details tables
-- =============================================================

-- ── sleep_summaries ──────────────────────────────────────────
-- Populated by Garmin sleeps webhook push.

CREATE TABLE IF NOT EXISTS sleep_summaries (
  user_id             uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_date       date  NOT NULL,
  overall_sleep_score int,
  PRIMARY KEY (user_id, calendar_date)
);

-- If the table existed before without calendar_date, add it now
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS calendar_date date;
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS overall_sleep_score int;

ALTER TABLE sleep_summaries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sleep_summaries' AND policyname = 'sleep_summaries_user_select'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'sleep_summaries' AND column_name = 'user_id'
  ) THEN
    CREATE POLICY "sleep_summaries_user_select"
      ON sleep_summaries FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;


-- ── activity_details ─────────────────────────────────────────
-- Populated by Garmin activityDetails webhook push.
-- Stores raw activity JSON (laps) keyed by Garmin activity ID.

CREATE TABLE IF NOT EXISTS activity_details (
  garmin_id  text  PRIMARY KEY,
  user_id    uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  json_data  jsonb,
  created_at timestamptz DEFAULT now()
);

-- If the table existed before without garmin_id, add it now
ALTER TABLE activity_details ADD COLUMN IF NOT EXISTS garmin_id text;
ALTER TABLE activity_details ADD COLUMN IF NOT EXISTS json_data jsonb;

ALTER TABLE activity_details ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'activity_details' AND policyname = 'activity_details_user_select'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_details' AND column_name = 'user_id'
  ) THEN
    CREATE POLICY "activity_details_user_select"
      ON activity_details FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;
