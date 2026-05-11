-- Route Safety Ratings
-- Collects anonymous safety scores per route to power a future women's night-running safety map.
-- Route endpoints are trimmed ~300m before storage to protect home/work locations.

CREATE TABLE IF NOT EXISTS route_safety_ratings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_id    text        NOT NULL,  -- recording.id for GPS runs, garminId for imports
  source         text        NOT NULL,  -- 'gps_recording' | 'strava' | 'garmin'
  polyline_trimmed text      NOT NULL,  -- Google-encoded polyline, post-300m trim
  point_count    int         NOT NULL,
  distance_km    numeric     NOT NULL,
  safety_score   smallint,              -- 1–10 or NULL for N/A (user skipped)
  rater_gender   text,                  -- 'male' | 'female' | 'prefer_not_to_say' | NULL
  center_lat     numeric     NOT NULL,
  center_lng     numeric     NOT NULL,
  bounds_north   numeric     NOT NULL,
  bounds_south   numeric     NOT NULL,
  bounds_east    numeric     NOT NULL,
  bounds_west    numeric     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT route_safety_ratings_score_range CHECK (safety_score IS NULL OR (safety_score >= 1 AND safety_score <= 10)),
  UNIQUE (user_id, activity_id)
);

ALTER TABLE route_safety_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY insert_own ON route_safety_ratings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY select_own ON route_safety_ratings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY update_own ON route_safety_ratings
  FOR UPDATE USING (auth.uid() = user_id);

-- Index for user-specific lookups (hasRatedActivity check)
CREATE INDEX idx_route_safety_ratings_user_activity
  ON route_safety_ratings (user_id, activity_id);

-- Index for future geospatial aggregation queries
CREATE INDEX idx_route_safety_ratings_bounds
  ON route_safety_ratings (bounds_south, bounds_north, bounds_west, bounds_east);
