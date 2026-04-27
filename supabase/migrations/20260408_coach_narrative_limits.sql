-- =============================================================
-- Coach Narrative — rate limiting + spend tracking tables
-- =============================================================

-- ─── Per-user daily call counter ─────────────────────────────
-- One row per user per day. The edge function increments
-- call_count on each successful LLM call and rejects when
-- the cap is reached.

CREATE TABLE IF NOT EXISTS coach_narrative_usage (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       date NOT NULL DEFAULT CURRENT_DATE,
  call_count int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

ALTER TABLE coach_narrative_usage ENABLE ROW LEVEL SECURITY;

-- Users can read their own usage (so the client can show "2 of 3 used")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'coach_narrative_usage' AND policyname = 'users can read own narrative usage') THEN
    CREATE POLICY "users can read own narrative usage"
      ON coach_narrative_usage FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;

-- NO insert/update/delete policies for users.
-- Only the edge function (service_role) can write to this table.
-- A malicious client cannot reset their own counter or inflate it.

-- ─── Global daily spend tracker ──────────────────────────────
-- One row per day across ALL users. The edge function increments
-- token counts after each Anthropic call. If estimated_cost_cents
-- exceeds the cap, the circuit breaker trips and all users get
-- the rules-based fallback until midnight.

CREATE TABLE IF NOT EXISTS llm_spend_tracker (
  date                date PRIMARY KEY DEFAULT CURRENT_DATE,
  total_input_tokens  int NOT NULL DEFAULT 0,
  total_output_tokens int NOT NULL DEFAULT 0,
  total_calls         int NOT NULL DEFAULT 0,
  estimated_cost_cents int NOT NULL DEFAULT 0
);

ALTER TABLE llm_spend_tracker ENABLE ROW LEVEL SECURITY;

-- No user-facing policies at all. This table is invisible to clients.
-- Only the service_role (edge function) can read or write it.
-- This means even if someone intercepts the anon key, they cannot
-- see how much you're spending or tamper with the counter.

-- ─── Auto-cleanup: drop rows older than 90 days ─────────────
-- Prevents unbounded table growth. Run manually or via pg_cron.
-- (Not a policy — just a utility you can call periodically.)

CREATE OR REPLACE FUNCTION cleanup_old_narrative_usage()
RETURNS void AS $$
BEGIN
  DELETE FROM coach_narrative_usage WHERE date < CURRENT_DATE - INTERVAL '90 days';
  DELETE FROM llm_spend_tracker WHERE date < CURRENT_DATE - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Increment functions (called by edge function via service_role) ──────

-- Atomically increment a user's daily call count.
-- Uses INSERT ... ON CONFLICT so the first call of the day creates the row.
CREATE OR REPLACE FUNCTION increment_narrative_usage(p_user_id uuid, p_date text)
RETURNS void AS $$
BEGIN
  INSERT INTO coach_narrative_usage (user_id, date, call_count)
  VALUES (p_user_id, p_date::date, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET call_count = coach_narrative_usage.call_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomically increment global daily spend counters.
CREATE OR REPLACE FUNCTION increment_spend_tracker(
  p_date text,
  p_input_tokens int,
  p_output_tokens int,
  p_cost_cents int
)
RETURNS void AS $$
BEGIN
  INSERT INTO llm_spend_tracker (date, total_input_tokens, total_output_tokens, total_calls, estimated_cost_cents)
  VALUES (p_date::date, p_input_tokens, p_output_tokens, 1, p_cost_cents)
  ON CONFLICT (date)
  DO UPDATE SET
    total_input_tokens  = llm_spend_tracker.total_input_tokens + p_input_tokens,
    total_output_tokens = llm_spend_tracker.total_output_tokens + p_output_tokens,
    total_calls         = llm_spend_tracker.total_calls + 1,
    estimated_cost_cents = llm_spend_tracker.estimated_cost_cents + p_cost_cents;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
