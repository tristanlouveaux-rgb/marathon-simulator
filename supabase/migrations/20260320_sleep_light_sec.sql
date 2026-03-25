-- Add light_sec column to sleep_summaries.
-- Light sleep is sent by Garmin as lightSleepDurationInSeconds; previously we
-- derived it as total - deep - rem - awake, which fails when rem is null.
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS light_sec int;
