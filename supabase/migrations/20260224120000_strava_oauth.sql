-- =============================================================
-- Strava OAuth integration + iTRIMP column
-- =============================================================

-- ── strava_auth_requests ─────────────────────────────────────
-- Ephemeral PKCE state between auth-start and callback.
-- Service role only — no user-facing policies needed.

CREATE TABLE IF NOT EXISTS strava_auth_requests (
  state         text        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_verifier text        NOT NULL,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE strava_auth_requests ENABLE ROW LEVEL SECURITY;
-- No user-facing policies: service role bypasses RLS.


-- ── strava_tokens ────────────────────────────────────────────
-- Long-lived Strava OAuth tokens, one row per user.

CREATE TABLE IF NOT EXISTS strava_tokens (
  user_id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  strava_athlete_id  bigint,                   -- Strava's numeric athlete ID
  access_token       text        NOT NULL,
  refresh_token      text,
  expires_at         timestamptz,
  updated_at         timestamptz DEFAULT now()
);

ALTER TABLE strava_tokens ENABLE ROW LEVEL SECURITY;

-- Users can read their own row (needed for isStravaConnected client check)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'strava_tokens' AND policyname = 'strava_tokens_user_select') THEN
    CREATE POLICY "strava_tokens_user_select" ON strava_tokens FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

-- Users can update their own row
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'strava_tokens' AND policyname = 'strava_tokens_user_update') THEN
    CREATE POLICY "strava_tokens_user_update" ON strava_tokens FOR UPDATE USING (user_id = auth.uid());
  END IF;
END $$;

-- Service role (used by edge functions) bypasses RLS automatically.


-- ── garmin_activities: add iTRIMP column ─────────────────────
-- Store computed iTRIMP alongside existing activity data.
-- NULL = insufficient HR data to compute.

ALTER TABLE garmin_activities
  ADD COLUMN IF NOT EXISTS itrimp float;
