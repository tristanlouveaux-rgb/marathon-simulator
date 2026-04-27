-- Add ambient temperature column to garmin_activities.
-- Populated from Open-Meteo historical weather (free, no API key) during drift
-- calculation. Enables heat-correction of HR drift: drift_adjusted = drift - 0.15 × max(0, temp_c - 15).
-- Fetched only for DRIFT_TYPES running activities where hr_drift is computed.
-- NULL when the activity has no start_latlng or the fetch fails.
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS ambient_temp_c real;
