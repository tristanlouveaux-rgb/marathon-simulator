-- =============================================================
-- One-time setup for the purge-deleted-accounts nightly cron.
-- Paste this whole block into the Supabase dashboard SQL editor
-- (Project → SQL Editor → New query → Run).
--
-- It is idempotent: safe to run more than once.
--
-- The secret below matches PURGE_CRON_SECRET already set on the
-- purge-deleted-accounts edge function. If you ever rotate one,
-- rotate both to the same value.
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Shared secret authenticating pg_cron → purge-deleted-accounts.
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'purge_cron_secret';
  if v_id is null then
    perform vault.create_secret(
      '91c96fc1755915008593900323fb9a5705c6a6a8ded640ba26c24cfd0f183e99',
      'purge_cron_secret',
      'Shared secret authenticating pg_cron to purge-deleted-accounts'
    );
  else
    perform vault.update_secret(v_id, '91c96fc1755915008593900323fb9a5705c6a6a8ded640ba26c24cfd0f183e99');
  end if;
end $$;

-- 2. Project URL secret (should already exist from the garmin-reconcile cron;
--    created here only if missing).
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'supabase_url';
  if v_id is null then
    perform vault.create_secret(
      'https://elnuiudfndsvtbfisaje.supabase.co',
      'supabase_url',
      'Base URL for cron → edge function HTTP calls'
    );
  end if;
end $$;

-- 3. Schedule the nightly purge at 03:30 UTC (idempotent).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-deleted-accounts-nightly') then
    perform cron.unschedule('purge-deleted-accounts-nightly');
  end if;
end $$;

select cron.schedule(
  'purge-deleted-accounts-nightly',
  '30 3 * * *',
  $cron$
  select net.http_post(
    url := concat(
      (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'),
      '/functions/v1/purge-deleted-accounts'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'purge_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cron$
);

-- 4. Verify (should show the scheduled job + both secrets present).
select jobname, schedule, active from cron.job where jobname = 'purge-deleted-accounts-nightly';
select name from vault.secrets where name in ('purge_cron_secret', 'supabase_url') order by name;
