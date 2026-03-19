-- Add sleep stage duration columns to sleep_summaries.
-- Garmin already sends these in webhook; we were discarding them.
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS duration_sec int;
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS deep_sec int;
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS rem_sec int;
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS awake_sec int;
