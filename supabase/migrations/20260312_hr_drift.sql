-- Add HR drift column to garmin_activities
-- HR drift = (avgHR_2nd_half - avgHR_1st_half) / avgHR_1st_half × 100
-- Only populated for steady-state runs ≥ 20 min with HR stream data
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_drift real;
