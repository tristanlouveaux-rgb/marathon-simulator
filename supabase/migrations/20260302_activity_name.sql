-- Add activity_name to garmin_activities so we can store the Strava workout title
-- (e.g. "Tempo Run", "Easy Run", "Interval") for iTRIMP calibration.
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS activity_name text;
