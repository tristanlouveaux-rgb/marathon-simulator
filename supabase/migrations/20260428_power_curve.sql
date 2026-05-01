-- Add power_curve mean-max column to garmin_activities for FTP derivation.
--
-- Whole-ride NP (normalized_power) buries hard intervals inside long-ride
-- averages — a 110-min ride with two 20-min all-out efforts at 310 W shows
-- whole-ride NP ≈ 251 W. The FTP estimator can't recover the test from
-- whole-ride summary stats alone.
--
-- power_curve stores best-mean-max watts for fixed time windows, computed
-- from the watts stream during sync. The FTP estimator reads p1200 (best
-- 20-min) directly and applies the Coggan classic ×0.95 multiplier.
--
-- Shape:  { p600, p1200, p1800, p3600 }  — seconds → watts (real)
--         Any field may be null if the ride was shorter than that window.

ALTER TABLE garmin_activities
  ADD COLUMN IF NOT EXISTS power_curve jsonb;
