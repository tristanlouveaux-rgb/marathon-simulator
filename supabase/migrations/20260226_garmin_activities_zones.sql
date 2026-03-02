-- =============================================================
-- Cache HR zones + km splits in garmin_activities
-- =============================================================
-- Strava streams are fetched once and cached here so subsequent
-- syncs return stored data without burning Strava API rate limit.

ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_zones  jsonb;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS km_splits  integer[];
