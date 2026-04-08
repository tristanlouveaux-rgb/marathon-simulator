-- Add passive activity columns to daily_metrics.
-- Populated by sync-today-steps (epoch summaries) for today,
-- and by garmin-backfill (dailies totalSteps) for historic days.

ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS steps int;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS active_calories int;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS active_minutes int;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS highly_active_minutes int;
