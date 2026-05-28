-- =============================================================
-- Schedule purge-deleted-accounts edge function via pg_cron.
-- Runs nightly at 03:30 UTC (just before garmin-reconcile at 04:00).
--
-- Manual setup required (one-time, per-environment):
--
--   1. Create the Vault secret used for cron→edge-function authentication:
--
--      SELECT vault.create_secret(
--        '<generate a random 32+ char string>',
--        'purge_cron_secret',
--        'Shared secret authenticating pg_cron to purge-deleted-accounts'
--      );
--
--   2. Set PURGE_CRON_SECRET to the same value in the purge-deleted-accounts
--      edge function environment (Supabase dashboard → Edge Functions →
--      purge-deleted-accounts → Secrets).
--
--   3. The `supabase_url` Vault secret should already exist from the
--      garmin-reconcile cron migration. If not, create it per
--      20260423_garmin_reconcile_cron.sql.
--
-- After step 2, deploy the function so it picks up the secret.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule any prior version so re-running this migration is idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-deleted-accounts-nightly') THEN
    PERFORM cron.unschedule('purge-deleted-accounts-nightly');
  END IF;
END $$;

-- 03:30 UTC daily. Vault reads return NULL until the secrets exist, in which
-- case the HTTP call simply fails — no rows are purged accidentally.
SELECT cron.schedule(
  'purge-deleted-accounts-nightly',
  '30 3 * * *',
  $cron$
  SELECT net.http_post(
    url := concat(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url'),
      '/functions/v1/purge-deleted-accounts'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'purge_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cron$
);
