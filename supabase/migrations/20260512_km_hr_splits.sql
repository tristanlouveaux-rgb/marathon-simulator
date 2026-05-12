-- Per-km average HR alongside per-km pace.
--
-- Strava's splits_metric[] response includes `average_heartrate` per split.
-- We already extract per-km pace into km_splits int[]; this column stores the
-- parallel-indexed average HR per split so the VO2 HR-calibrated regression
-- can fit on within-run variation (e.g. a tempo finish on a long run) instead
-- of being averaged into one diluted (avgPace, avgHR) point per run.
--
-- Same shape and indexing as km_splits. Nullable. Existing rows backfilled
-- by re-running sync-strava-activities (the edge fn reads splits_metric from
-- DB cache when available).

ALTER TABLE garmin_activities
ADD COLUMN IF NOT EXISTS km_hr_splits int[];

COMMENT ON COLUMN garmin_activities.km_hr_splits IS
  'Average HR per km split (bpm), parallel-indexed to km_splits. Sourced from Strava splits_metric[].average_heartrate. Null when no HR stream was recorded for that activity.';
