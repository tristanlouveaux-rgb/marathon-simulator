-- =============================================================
-- Add user_id to daily_metrics
-- =============================================================
-- The original table used garmin_user_id (Garmin's stable UUID) as
-- the only identifier. The webhook was refactored to write user_id
-- (Supabase auth UUID via resolveUserId) but the column never existed,
-- so every upsert failed silently. This migration:
--   1. Adds user_id column
--   2. Backfills from garmin_tokens for existing rows
--   3. Adds UNIQUE(user_id, day_date) so the webhook upsert works
--   4. Enables RLS so sync-physiology-snapshot returns only the current user's rows

ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Backfill user_id for rows that have garmin_user_id set
UPDATE daily_metrics dm
SET user_id = gt.user_id
FROM garmin_tokens gt
WHERE dm.garmin_user_id = gt.garmin_user_id
  AND dm.user_id IS NULL;

-- Unique constraint required for upsert onConflict("user_id","day_date")
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'daily_metrics_user_id_day_date_key'
  ) THEN
    ALTER TABLE daily_metrics
      ADD CONSTRAINT daily_metrics_user_id_day_date_key UNIQUE (user_id, day_date);
  END IF;
END $$;

-- RLS
ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'daily_metrics' AND policyname = 'daily_metrics_user_select'
  ) THEN
    CREATE POLICY "daily_metrics_user_select"
      ON daily_metrics FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;
