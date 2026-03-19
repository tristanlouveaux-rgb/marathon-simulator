-- =============================================================
-- user_plan_settings: durable backup of each user's plan state.
-- Written on every saveState() call; read only when localStorage
-- is empty (e.g. after a wipe or device change).
-- =============================================================

CREATE TABLE IF NOT EXISTS user_plan_settings (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  state_snapshot jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_plan_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own plan settings"
  ON user_plan_settings FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "users can insert own plan settings"
  ON user_plan_settings FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can update own plan settings"
  ON user_plan_settings FOR UPDATE
  USING (user_id = auth.uid());
