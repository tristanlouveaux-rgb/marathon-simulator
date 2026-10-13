-- =============================================================
-- RLS and redeem test for 20261013000001_hyrox_partner.sql
-- =============================================================
--
-- Run AFTER the migration is applied, as the `postgres` role (Supabase SQL
-- editor, or psql with the project connection string):
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rls-tests/20261013000001_hyrox_partner_rls_test.sql
--
-- Non-destructive: everything runs in one transaction that ends in ROLLBACK,
-- including the three throwaway auth.users rows. Each check impersonates a
-- user the way PostgREST does (SET LOCAL ROLE authenticated + request.jwt.claims)
-- and RAISEs on the first failure, which aborts the whole script. Success
-- ends with the NOTICE "hyrox partner RLS: all checks passed".
--
-- Every row count is limited to the three throwaway users (or their codes),
-- so the script stays valid once real users have invites, links and
-- snapshots.
--
-- Users: A and B become partners, C is a bystander.
--   A = 00000000-0000-4000-8000-00000000000a
--   B = 00000000-0000-4000-8000-00000000000b
--   C = 00000000-0000-4000-8000-00000000000c
-- Values pass between blocks through transaction-local custom settings
-- (hyrox_test.*), which any role may set.
--
-- Not covered here (needs two sessions at once): the advisory-lock ordering
-- in redeem_hyrox_partner_invite and its 'retry' word. Verify those with two
-- psql sessions against a throwaway database (lane HP notes).
-- =============================================================

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'hyrox-rls-a@example.invalid'),
  ('00000000-0000-4000-8000-00000000000b', 'hyrox-rls-b@example.invalid'),
  ('00000000-0000-4000-8000-00000000000c', 'hyrox-rls-c@example.invalid');

-- ── 0. Catalogue: RLS on, definer functions locked down, no extra privilege ─
DO $$
DECLARE r record; t text; p text;
BEGIN
  FOR r IN
    SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('hyrox_partner_invites', 'hyrox_partner_links', 'hyrox_partner_snapshots')
  LOOP
    IF NOT r.relrowsecurity THEN RAISE EXCEPTION 'FAIL 0.1: RLS disabled on %', r.relname; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity
         AND c.relname IN ('hyrox_partner_invites', 'hyrox_partner_links', 'hyrox_partner_snapshots')) <> 3 THEN
    RAISE EXCEPTION 'FAIL 0.2: expected 3 partner tables with RLS on';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.redeem_hyrox_partner_invite(text)'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 0.3: redeem function is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.redeem_hyrox_partner_invite(text)'::regprocedure
                    AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'FAIL 0.4: redeem function search_path is not pinned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.hyrox_partner_link_after_delete()'::regprocedure
                    AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'FAIL 0.4b: link after-delete trigger search_path is not pinned';
  END IF;
  IF has_function_privilege('anon', 'public.redeem_hyrox_partner_invite(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 0.5: anon can execute the redeem function';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.redeem_hyrox_partner_invite(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 0.6: authenticated cannot execute the redeem function';
  END IF;
  -- Trigger functions are never callable over the API.
  FOREACH p IN ARRAY ARRAY['public.hyrox_partner_invite_before_insert()',
                           'public.hyrox_partner_snapshot_touch()',
                           'public.hyrox_partner_link_after_delete()'] LOOP
    IF has_function_privilege('anon', p, 'EXECUTE') OR has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 0.6b: an API role can execute %', p;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.hyrox_partner_links', 'INSERT')
     OR has_table_privilege('authenticated', 'public.hyrox_partner_links', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.hyrox_partner_invites', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 0.7: clients hold INSERT/UPDATE on links or UPDATE on invites';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'hyrox_partner%') THEN
    RAISE EXCEPTION 'FAIL 0.8: unexpected hyrox_partner view';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.hyrox_partner_invites', 'public.hyrox_partner_links', 'public.hyrox_partner_snapshots'] LOOP
    -- anon holds nothing at all.
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', t, p) THEN
        RAISE EXCEPTION 'FAIL 0.9: anon holds % on %', p, t;
      END IF;
    END LOOP;
    -- authenticated holds no table-level power beyond its per-command grants.
    FOREACH p IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION 'FAIL 0.10: authenticated holds % on %', p, t;
      END IF;
    END LOOP;
  END LOOP;
  -- No lasting record of who linked with whom: the invite row has no column
  -- naming a second user.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.hyrox_partner_invites'::regclass
                AND attnum > 0 AND NOT attisdropped
                AND attname NOT IN ('code', 'owner_id', 'created_at', 'expires_at')) THEN
    RAISE EXCEPTION 'FAIL 0.11: hyrox_partner_invites has a column beyond code, owner, created, expires';
  END IF;
END $$;

-- ── 1. A creates an invite; nobody else can see it; one code per user ──────
DO $$
DECLARE v_code text; v_code2 text; v_code3 text; v_exp timestamptz; n int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  -- The client sends only owner_id; code and expiry come from the trigger.
  INSERT INTO public.hyrox_partner_invites (owner_id, code, expires_at)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'AAAAAAAA', now() + interval '10 years')
  RETURNING code, expires_at INTO v_code, v_exp;
  IF v_code = 'AAAAAAAA' OR v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' THEN
    RAISE EXCEPTION 'FAIL 1.1: client-chosen or malformed code %', v_code;
  END IF;
  IF v_exp > now() + interval '25 hours' THEN
    RAISE EXCEPTION 'FAIL 1.2: client-chosen expiry kept (%)', v_exp;
  END IF;

  -- A cannot create an invite owned by C.
  BEGIN
    INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000c');
    RAISE EXCEPTION 'FAIL 1.3: A inserted an invite owned by C';
  EXCEPTION WHEN insufficient_privilege THEN NULL; -- RLS WITH CHECK
  END;

  -- A cannot update its invite (no UPDATE grant).
  BEGIN
    UPDATE public.hyrox_partner_invites SET expires_at = now() + interval '1 year'
     WHERE owner_id = '00000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'FAIL 1.4: A updated an invite';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- One code per user: a second code replaces the first.
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000a')
  RETURNING code INTO v_code2;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.hyrox_partner_invites
   WHERE owner_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 1.5: A holds % codes, expected 1', n; END IF;
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_invites WHERE code = v_code) THEN
    RAISE EXCEPTION 'FAIL 1.6: A''s first code survived a second one';
  END IF;

  -- The caller's expired code is purged when they create a new one.
  UPDATE public.hyrox_partner_invites SET expires_at = now() - interval '1 minute' WHERE code = v_code2;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000a')
  RETURNING code INTO v_code3;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_invites WHERE code = v_code2) THEN
    RAISE EXCEPTION 'FAIL 1.7: A''s expired code survived a new one';
  END IF;
  PERFORM set_config('hyrox_test.code_a1', v_code3, true);

  -- C sees no invites at all, not even by guessing the exact code.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.hyrox_partner_invites
   WHERE owner_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[]);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1.8: C can list % of A''s or B''s invites', n; END IF;
  SELECT count(*) INTO n FROM public.hyrox_partner_invites WHERE code = current_setting('hyrox_test.code_a1');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1.9: C can read A''s invite by code'; END IF;
  -- C cannot delete A's invite. No WHERE clause on purpose: a WHERE makes
  -- PostgreSQL apply the SELECT policy too, which would hide a weakened
  -- DELETE policy. C owns no invite yet, so this may delete nothing at all.
  DELETE FROM public.hyrox_partner_invites;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.hyrox_partner_invites WHERE code = current_setting('hyrox_test.code_a1')) THEN
    RAISE EXCEPTION 'FAIL 1.10: C deleted A''s invite';
  END IF;
END $$;

-- ── 2. anon reads nothing and cannot redeem; no user id means no redeem ─────
DO $$
DECLARE s text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM public.hyrox_partner_invites;
    RAISE EXCEPTION 'FAIL 2.1: anon can select invites';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.hyrox_partner_links;
    RAISE EXCEPTION 'FAIL 2.2: anon can select links';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.hyrox_partner_snapshots;
    RAISE EXCEPTION 'FAIL 2.3: anon can select snapshots';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.redeem_hyrox_partner_invite(current_setting('hyrox_test.code_a1'));
    RAISE EXCEPTION 'FAIL 2.4: anon can execute redeem';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- An authenticated token with no user id: the definer function refuses
  -- before touching any table, even with a live code.
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(current_setting('hyrox_test.code_a1'));
  IF s IS DISTINCT FROM 'not_authenticated' THEN RAISE EXCEPTION 'FAIL 2.5: redeem with no user id returned %', s; END IF;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_links
              WHERE partner_id = '00000000-0000-4000-8000-00000000000a') THEN
    RAISE EXCEPTION 'FAIL 2.6: a redeem with no user id linked A';
  END IF;
END $$;

-- ── 3. Redeem rejections: own, malformed, unknown, expired ─────────────────
DO $$
DECLARE s text;
BEGIN
  -- A redeems its own code.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(current_setting('hyrox_test.code_a1'));
  IF s <> 'own_code' THEN RAISE EXCEPTION 'FAIL 3.1: own code returned %', s; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite('not a code');
  IF s <> 'invalid_code' THEN RAISE EXCEPTION 'FAIL 3.2: malformed code returned %', s; END IF;
  s := public.redeem_hyrox_partner_invite('ZZZZZZZZ');
  IF s <> 'unavailable' THEN RAISE EXCEPTION 'FAIL 3.3: unknown code returned %', s; END IF;
  RESET ROLE;

  -- Expire A's code (as postgres: clients have no UPDATE), then B redeems it.
  UPDATE public.hyrox_partner_invites SET expires_at = now() - interval '1 minute'
   WHERE code = current_setting('hyrox_test.code_a1');
  SET LOCAL ROLE authenticated;
  -- Lower case with a dash, as a user might type it: normalised server-side.
  -- An expired code answers exactly as an unknown one.
  s := public.redeem_hyrox_partner_invite(
         lower(substr(current_setting('hyrox_test.code_a1'), 1, 4)) || '-' ||
         lower(substr(current_setting('hyrox_test.code_a1'), 5, 4)));
  IF s <> 'unavailable' THEN RAISE EXCEPTION 'FAIL 3.4: expired code returned %', s; END IF;
  RESET ROLE;
  -- Nobody among the test users got linked.
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_links
              WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
                                         '00000000-0000-4000-8000-00000000000c']::uuid[])) THEN
    RAISE EXCEPTION 'FAIL 3.5: a rejected redeem created a link';
  END IF;
END $$;

-- ── 4. Snapshots before any link: nobody reads anyone else's ───────────────
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_snapshots
    (user_id, format, division, race_tier, initials, station_sec, station_tier, station_team,
     forecast_station_sec, run_pace_sec_km, roxzone_sec)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'open_doubles', 'men', 'M-Open', 'AA',
          ARRAY[240, 180, NULL, 200, 250, 120, 260, 330], ARRAY['M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open'], ARRAY[false, false, false, false, false, false, false, false],
          ARRAY[240, 180, 210, 200, 250, 120, 260, 330], 300, 420);
  -- A cannot re-key its own row to another user. C has no snapshot yet and
  -- there is no WHERE clause (a WHERE would add the SELECT policy's check of
  -- the new row), so only the UPDATE policy's WITH CHECK stands in the way.
  -- The UPDATE policy limits it to A's own row.
  BEGIN
    UPDATE public.hyrox_partner_snapshots SET user_id = '00000000-0000-4000-8000-00000000000c';
    RAISE EXCEPTION 'FAIL 4.1: A re-keyed its snapshot to C';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_snapshots
    (user_id, format, division, race_tier, initials, station_sec, station_tier, station_team,
     forecast_station_sec, run_pace_sec_km, roxzone_sec)
  VALUES ('00000000-0000-4000-8000-00000000000b', 'open_doubles', 'men', 'M-Open', 'BB',
          ARRAY[250, 170, 200, NULL, 245, 125, 255, 340], ARRAY['M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open'], ARRAY[false, false, false, false, false, false, false, true],
          ARRAY[250, 170, 200, 210, 245, 125, 255, 340], 310, 420);
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4.2: unlinked B reads A''s snapshot'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000b';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4.3: unlinked A reads B''s snapshot'; END IF;
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a')
     OR EXISTS (SELECT 1 FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000c') THEN
    RAISE EXCEPTION 'FAIL 4.4: A''s snapshot is no longer keyed to A';
  END IF;
END $$;

-- ── 5. A fresh code links A and B; the code is then gone ───────────────────
DO $$
DECLARE s text; v_code text; n int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000a')
  RETURNING code INTO v_code;
  PERFORM set_config('hyrox_test.code_a2', v_code, true);
  RESET ROLE;

  -- B also holds a code: linking makes it pointless, so it goes too.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000b');
  s := public.redeem_hyrox_partner_invite(current_setting('hyrox_test.code_a2'));
  IF s <> 'linked' THEN RAISE EXCEPTION 'FAIL 5.1: valid code returned %', s; END IF;
  SELECT count(*) INTO n FROM public.hyrox_partner_links
   WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[]);
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 5.2: B sees % link rows, expected its row and the mirror', n; END IF;
  RESET ROLE;

  -- No row keeps the pair: the redeemed code and both users' codes are gone.
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_invites
              WHERE code = current_setting('hyrox_test.code_a2')
                 OR owner_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])) THEN
    RAISE EXCEPTION 'FAIL 5.3: an invite of A or B survived the link';
  END IF;

  -- C redeems the same (now gone) code.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(current_setting('hyrox_test.code_a2'));
  IF s <> 'unavailable' THEN RAISE EXCEPTION 'FAIL 5.4: redeemed code returned %', s; END IF;
  -- C cannot read A's or B's link.
  SELECT count(*) INTO n FROM public.hyrox_partner_links
   WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])
      OR partner_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[]);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5.5: C can read % link row(s)', n; END IF;
  -- C cannot forge a link to A.
  BEGIN
    INSERT INTO public.hyrox_partner_links (user_id, partner_id)
    VALUES ('00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a'),
           ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c');
    RAISE EXCEPTION 'FAIL 5.6: C inserted a link';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- C cannot delete A and B's link. No WHERE clause, for the reason in 1.10;
  -- C is in no link, so this may delete nothing at all.
  DELETE FROM public.hyrox_partner_links;
  RESET ROLE;
  IF (SELECT count(*) FROM public.hyrox_partner_links
       WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])) <> 2 THEN
    RAISE EXCEPTION 'FAIL 5.7: C removed A and B''s link';
  END IF;
END $$;

-- ── 6. Already-linked rejections ───────────────────────────────────────────
DO $$
DECLARE s text; v_code_c text; v_code_a text;
BEGIN
  -- C creates a code; B (linked) tries it.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000c')
  RETURNING code INTO v_code_c;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(v_code_c);
  IF s <> 'already_linked' THEN RAISE EXCEPTION 'FAIL 6.1: linked caller returned %', s; END IF;
  RESET ROLE;

  -- A (linked) creates a code; C (unlinked) tries it.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000a')
  RETURNING code INTO v_code_a;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(v_code_a);
  IF s <> 'partner_linked' THEN RAISE EXCEPTION 'FAIL 6.2: linked owner returned %', s; END IF;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_links
              WHERE user_id = '00000000-0000-4000-8000-00000000000c'
                 OR partner_id = '00000000-0000-4000-8000-00000000000c') THEN
    RAISE EXCEPTION 'FAIL 6.3: C ended up linked';
  END IF;
END $$;

-- ── 7. Snapshots: own write, partner read only while linked ────────────────
DO $$
DECLARE n int;
BEGIN
  -- Upsert path (INSERT ... ON CONFLICT DO UPDATE), as the client sends it.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_snapshots
    (user_id, format, division, race_tier, initials, station_sec, station_tier, station_team,
     forecast_station_sec, run_pace_sec_km, roxzone_sec)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'open_doubles', 'men', 'M-Open', 'AA',
          ARRAY[239, 180, NULL, 200, 250, 120, 260, 330], ARRAY['M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open'], ARRAY[false, false, false, false, false, false, false, false],
          ARRAY[239, 180, 210, 200, 250, 120, 260, 330], 300, 420)
  ON CONFLICT (user_id) DO UPDATE SET station_sec = EXCLUDED.station_sec,
                                      forecast_station_sec = EXCLUDED.forecast_station_sec;
  -- A cannot write B's snapshot.
  BEGIN
    INSERT INTO public.hyrox_partner_snapshots
      (user_id, format, station_sec, station_tier, station_team, forecast_station_sec, run_pace_sec_km, roxzone_sec)
    VALUES ('00000000-0000-4000-8000-00000000000b', 'open_doubles',
            ARRAY[1,1,1,1,1,1,1,1], ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::text[], ARRAY[false,false,false,false,false,false,false,false],
            ARRAY[1,1,1,1,1,1,1,1], 1, 1);
    RAISE EXCEPTION 'FAIL 7.1: A inserted B''s snapshot';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Nothing outside the whitelist shape is storable.
  BEGIN
    INSERT INTO public.hyrox_partner_snapshots
      (user_id, format, station_sec, station_tier, station_team, forecast_station_sec, run_pace_sec_km, roxzone_sec)
    VALUES ('00000000-0000-4000-8000-00000000000a', 'open_doubles',
            ARRAY[1,1,1], ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::text[], ARRAY[false,false,false,false,false,false,false,false],
            ARRAY[1,1,1,1,1,1,1,1], 1, 1)
    ON CONFLICT (user_id) DO UPDATE SET station_sec = EXCLUDED.station_sec;
    RAISE EXCEPTION 'FAIL 7.2: a 3-station array was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Initials are rendered to the partner: markup characters are refused.
  BEGIN
    UPDATE public.hyrox_partner_snapshots SET initials = '<B'
     WHERE user_id = '00000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'FAIL 7.2b: initials with markup were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.hyrox_partner_snapshots SET initials = 'ABC'
     WHERE user_id = '00000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'FAIL 7.2c: three-letter initials were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- A station tier outside the three rulebook tiers is refused.
  BEGIN
    UPDATE public.hyrox_partner_snapshots
       SET station_tier = ARRAY['M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','M-Open','heart_rate']
     WHERE user_id = '00000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'FAIL 7.2d: an unknown station tier was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- No column outside the whitelist exists to write to.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.hyrox_partner_snapshots'::regclass
                AND attnum > 0 AND NOT attisdropped
                AND attname NOT IN ('user_id', 'updated_at', 'format', 'division', 'race_tier',
                                        'initials', 'station_sec', 'station_tier', 'station_team',
                                        'forecast_station_sec', 'run_pace_sec_km', 'roxzone_sec')) THEN
    RAISE EXCEPTION 'FAIL 7.2e: hyrox_partner_snapshots has a column outside the whitelist';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  -- B reads A's snapshot while linked.
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 7.3: linked B cannot read A''s snapshot'; END IF;
  -- B cannot modify A's snapshot.
  UPDATE public.hyrox_partner_snapshots SET run_pace_sec_km = 1 WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7.4: B updated A''s snapshot'; END IF;
  DELETE FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7.5: B deleted A''s snapshot'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_snapshots
    (user_id, format, station_sec, station_tier, station_team, forecast_station_sec, run_pace_sec_km, roxzone_sec)
  VALUES ('00000000-0000-4000-8000-00000000000c', 'open_singles',
          ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::integer[], ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::text[], ARRAY[false,false,false,false,false,false,false,false],
          ARRAY[260,200,230,220,270,140,280,360], 330, 450);
  -- C (unlinked) reads only its own snapshot among the test users.
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots
   WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
                              '00000000-0000-4000-8000-00000000000c']::uuid[]);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 7.6: C sees % test snapshots, expected only its own', n; END IF;
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7.7: C can read A''s snapshot'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000b';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 7.8: linked A cannot read B''s snapshot'; END IF;
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000c';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7.9: A can read bystander C''s snapshot'; END IF;
  RESET ROLE;
END $$;

-- ── 8. Unlink by either partner: reads end and both snapshots are deleted ──
DO $$
DECLARE n int;
BEGIN
  -- B unlinks by deleting its own row; the mirror row cascades away.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM public.hyrox_partner_links WHERE user_id = '00000000-0000-4000-8000-00000000000b';
  SELECT count(*) INTO n FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 8.1: B still reads A''s snapshot after unlink'; END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.hyrox_partner_links
       WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])) <> 0 THEN
    RAISE EXCEPTION 'FAIL 8.2: a link row survived unlink';
  END IF;
  -- Retention: both partners' snapshots are gone (checked as postgres, so this
  -- is the stored data, not an RLS view); the bystander's is untouched.
  IF (SELECT count(*) FROM public.hyrox_partner_snapshots
       WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])) <> 0 THEN
    RAISE EXCEPTION 'FAIL 8.3: a snapshot survived the unlink';
  END IF;
  IF (SELECT count(*) FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000c') <> 1 THEN
    RAISE EXCEPTION 'FAIL 8.4: unlinking A and B touched C''s snapshot';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.hyrox_partner_links
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' OR partner_id = '00000000-0000-4000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 8.5: A still sees a link after B unlinked'; END IF;
  RESET ROLE;
END $$;

-- ── 9. After unlink A can link again (one partner at a time, not one ever) ─
DO $$
DECLARE s text; v_code text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.hyrox_partner_invites (owner_id) VALUES ('00000000-0000-4000-8000-00000000000a')
  RETURNING code INTO v_code;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  s := public.redeem_hyrox_partner_invite(v_code);
  IF s <> 'linked' THEN RAISE EXCEPTION 'FAIL 9.1: relink after unlink returned %', s; END IF;
  RESET ROLE;
  -- A unlinks from the other side this time (A deletes the row where it is the partner).
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM public.hyrox_partner_links WHERE partner_id = '00000000-0000-4000-8000-00000000000a';
  RESET ROLE;
  IF (SELECT count(*) FROM public.hyrox_partner_links
       WHERE user_id = ANY (ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c']::uuid[])) <> 0 THEN
    RAISE EXCEPTION 'FAIL 9.2: deleting the mirror row did not remove the pair';
  END IF;
  -- C's snapshot (written while unlinked, then shared) goes with the link,
  -- even though A deleted C's link row rather than its own.
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_snapshots WHERE user_id = '00000000-0000-4000-8000-00000000000c') THEN
    RAISE EXCEPTION 'FAIL 9.3: C''s snapshot survived the unlink';
  END IF;
  RAISE NOTICE 'hyrox partner RLS: all checks passed';
END $$;

ROLLBACK;
