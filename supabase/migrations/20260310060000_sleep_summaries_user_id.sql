-- Fix sleep_summaries: user_id column was never added because the table
-- existed before the CREATE TABLE IF NOT EXISTS migration ran.
-- This also explains why sleep data stopped flowing — every upsert failed silently.

-- 1. Add user_id column
ALTER TABLE sleep_summaries ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Add unique constraint so upsert ON CONFLICT (user_id, calendar_date) works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'sleep_summaries'
      AND constraint_name = 'sleep_summaries_user_calendar_key'
  ) THEN
    ALTER TABLE sleep_summaries ADD CONSTRAINT sleep_summaries_user_calendar_key UNIQUE (user_id, calendar_date);
  END IF;
END $$;

-- 3. Ensure RLS is on and user can read their own rows
ALTER TABLE sleep_summaries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sleep_summaries' AND policyname = 'sleep_summaries_user_select'
  ) THEN
    CREATE POLICY "sleep_summaries_user_select"
      ON sleep_summaries FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;
