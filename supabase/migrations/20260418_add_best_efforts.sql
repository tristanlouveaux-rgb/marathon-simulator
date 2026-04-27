-- Add best_efforts column to garmin_activities.
-- Populated from Strava's activity detail endpoint (GET /activities/{id}) during
-- backfill for RUNNING activities only. Stores the `best_efforts` array as-is:
--   [{ name: '5k' | '10k' | 'Half Marathon' | 'Marathon' | ..., elapsed_time: int,
--      moving_time: int, start_date: ISO string, distance: metres, ... }, ...]
-- Read client-side by `readPBsFromHistory` to auto-fill PBs in onboarding.
-- NULL when the activity is not a run, has no best_efforts, or the detail fetch failed.
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS best_efforts jsonb;
