-- =============================================================
-- HYROX Doubles partner matching (2026-10-13)
-- =============================================================
--
-- Two Mosaic users link by an invite code and compare race numbers.
-- Decisions (Tristan, 2026-10-12): link by invite code; share ONLY
-- race-relevant numbers; either partner can unlink at any time; one partner
-- at a time.
--
-- Tables (all RLS ON, explicit policies, no anon access):
--   hyrox_partner_invites    short single-use code, owner only
--   hyrox_partner_links      one row per direction (A->B and B->A)
--   hyrox_partner_snapshots  one typed row per user: the whitelisted race
--                            numbers, readable by the owner and the linked
--                            partner only
-- Function:
--   redeem_hyrox_partner_invite(code)  SECURITY DEFINER, the only path that
--                                      creates a link
--
-- Security notes (docs/DATA_ISOLATION_AUDIT.md, SECURITY_SWEEP_REPORT.md C1):
--   * RLS is enabled on every table before any policy, so a half-applied
--     migration fails closed.
--   * Table privileges are revoked from PUBLIC, anon and authenticated, then
--     granted back to authenticated per command. Supabase's default
--     privileges grant ALL to anon on new public tables; RLS would still deny
--     anon (every policy is TO authenticated) but the revoke removes the
--     surface entirely.
--   * No view. The only SECURITY DEFINER object is the redeem function, with
--     a pinned search_path, EXECUTE for authenticated only, and auth.uid()
--     checked first.
--   * Unlink = delete the caller's link row; the mirror-row foreign key
--     cascades the partner's row away in the same statement. The partner
--     snapshot policy reads the link table, so read access ends with the row.
-- =============================================================


-- ── 1. Invites ───────────────────────────────────────────────────────────────
-- Code: 8 characters from a 31-letter alphabet without look-alikes (no I, L,
-- O, 0, 1), generated server-side by the insert trigger below so a client
-- never picks a code. 31^8 is about 8.5e11 codes.

CREATE TABLE IF NOT EXISTS public.hyrox_partner_invites (
  code        text        PRIMARY KEY,
  owner_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hyrox_partner_invites_code_format
    CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  CONSTRAINT hyrox_partner_invites_used_by_needs_used_at
    CHECK (used_by IS NULL OR used_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_hyrox_partner_invites_owner
  ON public.hyrox_partner_invites (owner_id);
CREATE INDEX IF NOT EXISTS idx_hyrox_partner_invites_expires
  ON public.hyrox_partner_invites (expires_at);

ALTER TABLE public.hyrox_partner_invites ENABLE ROW LEVEL SECURITY;

-- Server-owned fields: the client inserts only owner_id (checked by RLS).
-- Expiry: 24 hours from creation (product default, see the lane's open
-- questions; change here only).
CREATE OR REPLACE FUNCTION public.hyrox_partner_invite_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw   bytea;
  b     int;
  i     int := 0;
  out_code text := '';
BEGIN
  -- Two v4 UUIDs from the CSPRNG (pg_strong_random). Bytes 6 and 8 of each
  -- carry the version and variant bits, so they are skipped. Rejection
  -- sampling (bytes below 248 = 8 x 31) keeps every letter equally likely.
  raw := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  WHILE char_length(out_code) < 8 AND i < 32 LOOP
    IF (i % 16) NOT IN (6, 8) THEN
      b := get_byte(raw, i);
      IF b < 248 THEN
        out_code := out_code || substr(alphabet, (b % 31) + 1, 1);
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
  IF char_length(out_code) < 8 THEN
    RAISE EXCEPTION 'hyrox partner invite: code generation failed';
  END IF;
  NEW.code       := out_code;
  NEW.created_at := now();
  NEW.expires_at := now() + interval '24 hours';
  NEW.used_at    := NULL;
  NEW.used_by    := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hyrox_partner_invite_before_insert ON public.hyrox_partner_invites;
CREATE TRIGGER hyrox_partner_invite_before_insert
  BEFORE INSERT ON public.hyrox_partner_invites
  FOR EACH ROW EXECUTE FUNCTION public.hyrox_partner_invite_before_insert();

DROP POLICY IF EXISTS hyrox_partner_invites_select_own ON public.hyrox_partner_invites;
CREATE POLICY hyrox_partner_invites_select_own ON public.hyrox_partner_invites
  FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hyrox_partner_invites_insert_own ON public.hyrox_partner_invites;
CREATE POLICY hyrox_partner_invites_insert_own ON public.hyrox_partner_invites
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hyrox_partner_invites_delete_own ON public.hyrox_partner_invites;
CREATE POLICY hyrox_partner_invites_delete_own ON public.hyrox_partner_invites
  FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.hyrox_partner_invites FROM PUBLIC;
REVOKE ALL ON TABLE public.hyrox_partner_invites FROM anon;
REVOKE ALL ON TABLE public.hyrox_partner_invites FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.hyrox_partner_invites TO authenticated;


-- ── 2. Links ─────────────────────────────────────────────────────────────────
-- One row per direction. PRIMARY KEY (user_id) plus the mirror foreign key
-- make "a user is in at most one active link" a database guarantee: a row
-- (A, B) cannot exist without (B, A), and each user owns one row, so A and B
-- can appear in no other link. Deleting either row cascades to its mirror.

CREATE TABLE IF NOT EXISTS public.hyrox_partner_links (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyrox_partner_links_no_self CHECK (user_id <> partner_id),
  CONSTRAINT hyrox_partner_links_pair_key UNIQUE (user_id, partner_id),
  CONSTRAINT hyrox_partner_links_mirror FOREIGN KEY (partner_id, user_id)
    REFERENCES public.hyrox_partner_links (user_id, partner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hyrox_partner_links_partner
  ON public.hyrox_partner_links (partner_id);

ALTER TABLE public.hyrox_partner_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hyrox_partner_links_select_member ON public.hyrox_partner_links;
CREATE POLICY hyrox_partner_links_select_member ON public.hyrox_partner_links
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR partner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hyrox_partner_links_delete_member ON public.hyrox_partner_links;
CREATE POLICY hyrox_partner_links_delete_member ON public.hyrox_partner_links
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR partner_id = (SELECT auth.uid()));

-- No INSERT or UPDATE for clients: only redeem_hyrox_partner_invite inserts.
REVOKE ALL ON TABLE public.hyrox_partner_links FROM PUBLIC;
REVOKE ALL ON TABLE public.hyrox_partner_links FROM anon;
REVOKE ALL ON TABLE public.hyrox_partner_links FROM authenticated;
GRANT SELECT, DELETE ON TABLE public.hyrox_partner_links TO authenticated;


-- ── 3. Snapshots ─────────────────────────────────────────────────────────────
-- Typed columns, no free jsonb: nothing outside the whitelist can be stored.
-- Station arrays are in race order (HYROX_STATION_ORDER):
--   ski_erg, sled_push, sled_pull, burpee_broad_jumps, row_erg,
--   farmer_carry, sandbag_lunges, wall_balls
-- station_sec: the athlete's benchmark (seconds, one athlete over the full
--   station, the Stats ledger value); NULL = no benchmark (population seed).
-- station_tier: the load tier station_sec was measured at, NULL when unknown
--   or when the value went through a cross-tier conversion (no sourced ratio).
-- station_team: true when that benchmark is a doubles race split (a pair time).
-- forecast_station_sec: the athlete's own forecast per station, singles terms.
-- initials: at most two letters, rendered to the linked partner, so the CHECK
--   refuses digits, punctuation (including < > & " '), spaces and controls.

CREATE TABLE IF NOT EXISTS public.hyrox_partner_snapshots (
  user_id              uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  format               text        NOT NULL,
  division             text,
  race_tier            text,
  initials             text,
  station_sec          integer[]   NOT NULL,
  station_tier         text[]      NOT NULL,
  station_team         boolean[]   NOT NULL,
  forecast_station_sec integer[]   NOT NULL,
  run_pace_sec_km      integer     NOT NULL,
  roxzone_sec          integer     NOT NULL,
  CONSTRAINT hyrox_partner_snapshots_format
    CHECK (format IN ('open_singles', 'pro_singles', 'open_doubles', 'pro_doubles')),
  CONSTRAINT hyrox_partner_snapshots_division
    CHECK (division IS NULL OR division IN ('women', 'men', 'mixed')),
  CONSTRAINT hyrox_partner_snapshots_race_tier
    CHECK (race_tier IS NULL OR race_tier IN ('W-Open', 'M-Open', 'M-Pro')),
  CONSTRAINT hyrox_partner_snapshots_initials
    CHECK (initials IS NULL OR (
      char_length(initials) BETWEEN 1 AND 2
      AND initials = upper(initials)
      -- The HTML-special characters are listed explicitly as well: whether
      -- [:punct:] covers symbols such as < and > depends on the locale.
      AND initials !~ '[[:space:][:cntrl:][:punct:][:digit:]<>&"''`]'
    )),
  CONSTRAINT hyrox_partner_snapshots_station_sec
    CHECK (array_ndims(station_sec) = 1 AND cardinality(station_sec) = 8
           AND 0 < ALL (station_sec)),
  CONSTRAINT hyrox_partner_snapshots_station_tier
    CHECK (array_ndims(station_tier) = 1 AND cardinality(station_tier) = 8
           AND array_remove(station_tier, NULL) <@ ARRAY['W-Open', 'M-Open', 'M-Pro']::text[]),
  CONSTRAINT hyrox_partner_snapshots_station_team
    CHECK (array_ndims(station_team) = 1 AND cardinality(station_team) = 8
           AND array_position(station_team, NULL) IS NULL),
  CONSTRAINT hyrox_partner_snapshots_forecast_station_sec
    CHECK (array_ndims(forecast_station_sec) = 1 AND cardinality(forecast_station_sec) = 8
           AND array_position(forecast_station_sec, NULL) IS NULL
           AND 0 < ALL (forecast_station_sec)),
  CONSTRAINT hyrox_partner_snapshots_run_pace CHECK (run_pace_sec_km > 0),
  CONSTRAINT hyrox_partner_snapshots_roxzone CHECK (roxzone_sec > 0)
);

ALTER TABLE public.hyrox_partner_snapshots ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hyrox_partner_snapshot_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hyrox_partner_snapshot_touch ON public.hyrox_partner_snapshots;
CREATE TRIGGER hyrox_partner_snapshot_touch
  BEFORE INSERT OR UPDATE ON public.hyrox_partner_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.hyrox_partner_snapshot_touch();

DROP POLICY IF EXISTS hyrox_partner_snapshots_select_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_select_own ON public.hyrox_partner_snapshots
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The partner's row, only while a link joins the two users. Unlink deletes the
-- link rows, so this stops matching immediately.
DROP POLICY IF EXISTS hyrox_partner_snapshots_select_partner ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_select_partner ON public.hyrox_partner_snapshots
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.hyrox_partner_links l
    WHERE l.user_id = (SELECT auth.uid())
      AND l.partner_id = hyrox_partner_snapshots.user_id
  ));

DROP POLICY IF EXISTS hyrox_partner_snapshots_insert_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_insert_own ON public.hyrox_partner_snapshots
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hyrox_partner_snapshots_update_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_update_own ON public.hyrox_partner_snapshots
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS hyrox_partner_snapshots_delete_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_delete_own ON public.hyrox_partner_snapshots
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM anon;
REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hyrox_partner_snapshots TO authenticated;


-- ── 4. Redeem ────────────────────────────────────────────────────────────────
-- The only path that creates a link. Runs as the function owner so the caller
-- never reads another user's invite. Returns a status word (never raises for
-- an expected outcome, never returns another user's data):
--   'linked' | 'not_authenticated' | 'already_linked' | 'invalid_code' |
--   'own_code' | 'used' | 'expired' | 'partner_linked'
-- One transaction (the caller's statement): the invite row is locked FOR
-- UPDATE, so two redeems of one code serialise and the second reads 'used'.

CREATE OR REPLACE FUNCTION public.redeem_hyrox_partner_invite(code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(redeem_hyrox_partner_invite.code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_inv  public.hyrox_partner_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  -- One partner at a time: a linked caller cannot redeem (and cannot probe codes).
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = v_uid) THEN
    RETURN 'already_linked';
  END IF;

  IF v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' THEN
    RETURN 'invalid_code';
  END IF;

  SELECT i.* INTO v_inv
    FROM public.hyrox_partner_invites i
   WHERE i.code = v_code
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalid_code';
  END IF;
  IF v_inv.owner_id = v_uid THEN
    RETURN 'own_code';
  END IF;
  IF v_inv.used_at IS NOT NULL THEN
    RETURN 'used';
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN 'expired';
  END IF;
  IF EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = v_inv.owner_id) THEN
    RETURN 'partner_linked';
  END IF;

  BEGIN
    INSERT INTO public.hyrox_partner_links (user_id, partner_id)
    VALUES (v_uid, v_inv.owner_id), (v_inv.owner_id, v_uid);
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent redeem linked one of the two users first.
    RETURN 'already_linked';
  END;

  UPDATE public.hyrox_partner_invites i
     SET used_at = now(), used_by = v_uid
   WHERE i.code = v_code;

  -- Tidy: both users' other invites are now pointless, and expired codes of
  -- anyone are dead weight.
  DELETE FROM public.hyrox_partner_invites i
   WHERE i.code <> v_code
     AND (i.owner_id IN (v_uid, v_inv.owner_id) OR i.expires_at < now());

  RETURN 'linked';
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM anon;
REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_hyrox_partner_invite(text) TO authenticated;

-- Trigger functions: never callable over the API (a trigger fires without the
-- caller holding EXECUTE).
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM anon;
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM authenticated;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM anon;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM authenticated;
