-- =============================================================
-- Schedule garmin-reconcile edge function via pg_cron
-- =============================================================
-- Runs nightly at 04:00 UTC to catch up any user whose daily_metrics row for
-- the previous day is missing (i.e. Garmin's webhook dropped a delivery).
-- Replaces the client-side 2-hour launch-time backfill poll, which tripped
-- Garmin's 100-req/min app-wide rate limit once the user base grew.
--
-- Manual setup required (one-time, per-environment):
--
--   1. Create the Vault secrets used by this cron entry:
--
--      SELECT vault.create_secret(
--        'https://<project-ref>.supabase.co',
--        'supabase_url',
--        'Base URL for this project — used by cron to call edge functions'
--      );
--
--      SELECT vault.create_secret(
--        '<generate a random 32+ char string>',
--        'reconcile_cron_secret',
--        'Shared secret authenticating pg_cron to garmin-reconcile'
--      );
--
--   2. Set the same RECONCILE_CRON_SECRET value in the garmin-reconcile
--      edge function environment (Supabase dashboard → Edge Functions →
--      garmin-reconcile → Secrets).
--
-- After step 2, redeploy garmin-reconcile so it picks up the secret.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule any prior version so re-running this migration is idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'garmin-reconcile-nightly') THEN
    PERFORM cron.unschedule('garmin-reconcile-nightly');
  END IF;
END $$;

-- 04:00 UTC daily. Vault reads gracefully return NULL until the secrets exist,
-- in which case the HTTP call simply fails — no bad data written.
SELECT cron.schedule(
  'garmin-reconcile-nightly',
  '0 4 * * *',
  $cron$
  SELECT net.http_post(
    url := concat(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url'),
      '/functions/v1/garmin-reconcile'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'reconcile_cron_secret')
    ),
    body := '{"limit":25,"lookbackDays":3}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cron$
);
