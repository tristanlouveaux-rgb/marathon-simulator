-- Add power columns to garmin_activities for triathlon FTP derivation.
--
-- Strava ride activities carry power data when the athlete rides with a
-- power meter (or a smart trainer). Until now we dropped this on the
-- floor; triathlon mode needs it to derive FTP = 0.95 × best 20-min
-- normalized power (Allen & Coggan 2010).
--
-- All columns nullable — rides without power stay unaffected, walks /
-- runs / swims never populate these.

ALTER TABLE garmin_activities
  ADD COLUMN IF NOT EXISTS average_watts     real,
  ADD COLUMN IF NOT EXISTS normalized_power  real,
  ADD COLUMN IF NOT EXISTS max_watts         integer,
  ADD COLUMN IF NOT EXISTS device_watts      boolean,
  ADD COLUMN IF NOT EXISTS kilojoules        real;
