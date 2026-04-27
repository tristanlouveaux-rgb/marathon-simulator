-- =============================================================
-- Add source column to garmin_activities
-- =============================================================
-- Strava standalone mode upserts activities with source='strava'.
-- Garmin webhook upserts arrive without a source (null = garmin).

ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS source text;

-- Index for filtering by source when needed
CREATE INDEX IF NOT EXISTS idx_garmin_activities_source ON garmin_activities(source);
