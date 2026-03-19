-- Fix activity_details: garmin_id column was added via ALTER TABLE (no PK/unique constraint),
-- so upsert ON CONFLICT ("garmin_id") fails with 42P10.
-- Add the missing unique constraint if it doesn't exist yet.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'activity_details'
      AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      AND constraint_name IN ('activity_details_pkey', 'activity_details_garmin_id_key')
  ) THEN
    ALTER TABLE activity_details ADD CONSTRAINT activity_details_garmin_id_key UNIQUE (garmin_id);
  END IF;
END $$;
