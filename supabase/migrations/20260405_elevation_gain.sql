-- Add elevation gain column to garmin_activities (meters, from Strava total_elevation_gain)
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS elevation_gain_m float;
