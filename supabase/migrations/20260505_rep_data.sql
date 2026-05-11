-- Per-rep interval analysis: store the detected rep array (and source)
-- for run + bike interval sessions. Detection runs in the standalone /
-- backfill edge function paths from Strava laps[] and power/pace streams.
--
-- Shape (jsonb):
--   {
--     "reps": [
--       { "index": 1, "distanceM": 401, "durationSec": 74, "paceSecKm": 184,
--         "avgHR": 178, "avgWatts": null }
--     ],
--     "source": "strava-laps" | "auto-detected"
--   }
--
-- Null when the activity isn't an interval session OR detection found no
-- reps OR detection was bypassed (auto-1km laps with no fallback signal).

ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS rep_data jsonb;
