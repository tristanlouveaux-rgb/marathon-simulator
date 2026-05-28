-- =============================================================
-- coach-generate-workout — per-user daily call counter
-- =============================================================
-- Mirrors `coach_narrative_usage` but tracks the premium
-- workout-generation endpoint. Shares `llm_spend_tracker` for
-- the global daily spend cap.

CREATE TABLE IF NOT EXISTS coach_workout_usage (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       date NOT NULL DEFAULT CURRENT_DATE,
  call_count int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

ALTER TABLE coach_workout_usage ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'coach_workout_usage' AND policyname = 'users can read own workout usage') THEN
    CREATE POLICY "users can read own workout usage"
      ON coach_workout_usage FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Atomic increment, service-role only.
CREATE OR REPLACE FUNCTION increment_workout_usage(p_user_id uuid, p_date text)
RETURNS void AS $$
BEGIN
  INSERT INTO coach_workout_usage (user_id, date, call_count)
  VALUES (p_user_id, p_date::date, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET call_count = coach_workout_usage.call_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Extend the 90-day cleanup to include the new table.
CREATE OR REPLACE FUNCTION cleanup_old_narrative_usage()
RETURNS void AS $$
BEGIN
  DELETE FROM coach_narrative_usage WHERE date < CURRENT_DATE - INTERVAL '90 days';
  DELETE FROM coach_workout_usage   WHERE date < CURRENT_DATE - INTERVAL '90 days';
  DELETE FROM llm_spend_tracker     WHERE date < CURRENT_DATE - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
