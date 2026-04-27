-- =============================================================
-- Physiology snapshots + max HR
-- =============================================================

-- ── physiology_snapshots ─────────────────────────────────────
-- Populated by Garmin userMetrics webhook push.
-- Stores VO2max running and lactate threshold data per day.

CREATE TABLE IF NOT EXISTS physiology_snapshots (
  user_id                uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_date          date  NOT NULL,
  vo2_max_running        float,
  lactate_threshold_pace float,  -- sec/km (converted from Garmin's m/s)
  lt_heart_rate          int,    -- BPM at lactate threshold
  PRIMARY KEY (user_id, calendar_date)
);

ALTER TABLE physiology_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'physiology_snapshots' AND policyname = 'physiology_snapshots_user_select') THEN
    CREATE POLICY "physiology_snapshots_user_select" ON physiology_snapshots FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

-- ── daily_metrics: add max_hr ─────────────────────────────────
-- Garmin dailies push includes maxHeartRateInBeatsPerMinute.
-- Adding the column so we can surface true max HR from the device.

ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS max_hr int;

-- ── garmin_tokens: backfill garmin_user_id column ─────────────
-- If the previous migration was already applied without garmin_user_id,
-- this adds the column safely. The fresh-install migration above also
-- creates it, so ALTER TABLE IF NOT EXISTS handles both paths.

ALTER TABLE garmin_tokens ADD COLUMN IF NOT EXISTS garmin_user_id text UNIQUE;
CREATE INDEX IF NOT EXISTS idx_garmin_tokens_garmin_user_id ON garmin_tokens(garmin_user_id);
