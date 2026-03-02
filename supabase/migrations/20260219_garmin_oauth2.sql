-- =============================================================
-- Garmin OAuth 2.0 migration
-- Replaces OAuth 1.0a tables with OAuth 2.0 / PKCE schema
-- =============================================================

-- ── garmin_auth_requests ─────────────────────────────────────
-- Stores ephemeral PKCE state between auth-start and callback.
-- Only the service role should ever read/write this table.

CREATE TABLE IF NOT EXISTS garmin_auth_requests (
  state        text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_verifier text       NOT NULL,
  created_at   timestamptz DEFAULT now()
);

-- Remove OAuth 1.0a columns if they exist on an older version of this table
ALTER TABLE garmin_auth_requests DROP COLUMN IF EXISTS oauth_token;
ALTER TABLE garmin_auth_requests DROP COLUMN IF EXISTS oauth_token_secret;

ALTER TABLE garmin_auth_requests ENABLE ROW LEVEL SECURITY;
-- No user-facing policies: service role bypasses RLS.
-- All access goes through edge functions using SUPABASE_SERVICE_ROLE_KEY.


-- ── garmin_tokens ────────────────────────────────────────────
-- Stores long-lived OAuth 2.0 tokens, keyed by user.
-- Recreate from scratch: existing OAuth 1.0a tokens are invalid.

DROP TABLE IF EXISTS garmin_tokens CASCADE;

CREATE TABLE garmin_tokens (
  user_id        uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  garmin_user_id text        UNIQUE,  -- Garmin's stable userId, used to resolve webhook events
  access_token   text        NOT NULL,
  refresh_token  text,
  expires_at     timestamptz,
  token_type     text,
  raw            jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_garmin_tokens_garmin_user_id ON garmin_tokens(garmin_user_id);

ALTER TABLE garmin_tokens ENABLE ROW LEVEL SECURITY;

-- Users can read their own token row (needed for isGarminConnected check)
CREATE POLICY "garmin_tokens_user_select"
  ON garmin_tokens FOR SELECT
  USING (user_id = auth.uid());

-- Users can update their own token row (optional, service role handles writes)
CREATE POLICY "garmin_tokens_user_update"
  ON garmin_tokens FOR UPDATE
  USING (user_id = auth.uid());

-- Service role (used by edge functions) bypasses RLS automatically.
-- No INSERT/DELETE policy needed for users.
