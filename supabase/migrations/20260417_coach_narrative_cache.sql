-- 2026-04-17  coach_narrative_cache
-- =====================================================================
-- Stores the last narrative returned by coach-narrative edge function
-- along with a canonical SHA-256 hash of the signals payload. The edge
-- function uses this to serve cache (zero Anthropic tokens) when the
-- payload is unchanged within 24h. One row per user (PK on user_id).

CREATE TABLE IF NOT EXISTS coach_narrative_cache (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  signals_hash  text NOT NULL,
  narrative     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE coach_narrative_cache ENABLE ROW LEVEL SECURITY;

-- Users may read only their own cached row (client hydration on app open).
-- Writes are service-role only (performed inside the edge function).
DROP POLICY IF EXISTS "users read own cache" ON coach_narrative_cache;
CREATE POLICY "users read own cache"
  ON coach_narrative_cache
  FOR SELECT
  USING (user_id = auth.uid());
