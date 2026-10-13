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
--   hyrox_partner_invites    short single-use code, owner only, at most one
--                            per user
--   hyrox_partner_links      one row per direction (A->B and B->A)
--   hyrox_partner_snapshots  one typed row per user: the whitelisted race
--                            numbers, readable by the owner and the linked
--                            partner only
-- Functions:
--   redeem_hyrox_partner_invite(code)  SECURITY DEFINER, the only path that
--                                      creates a link
--   unlink_hyrox_partner()             SECURITY DEFINER, the only client path
--                                      that ends a link
--   hyrox_partner_link_after_delete()  SECURITY DEFINER trigger: ending a
--                                      link deletes both users' snapshots and
--                                      any code either still holds
--
-- Product defaults (kept in review, 2026-10-13): a code is 8 characters and
-- lives 24 hours; one live code per user.
--
-- Retention: nothing records who linked with whom once the link ends. The
-- redeemed code is deleted inside the redeem transaction. The redeemer's own
-- code, if they had one out, stays while linked so the partner can still
-- enter it (a crossing redeem answers 'linked'); its row names only its
-- owner. Ending a link (either side, or an account deletion) deletes both
-- snapshots and both users' codes. A user's earlier codes, live or expired,
-- are deleted when they create a new one; expired codes of anyone are purged
-- on every successful redeem. A snapshot can only be written while its owner
-- has a link (INSERT/UPDATE policies), so a stale client cannot re-create one
-- after the partner unlinks.
--
-- Locking: every path that links users, unlinks them or replaces a user's
-- code takes a transaction advisory lock per user first (key:
-- hashtextextended of 'hyrox_partner_user:' || user id, seed 0), two keys
-- always in ascending order, so concurrent redeems (A enters B's code while B
-- enters A's) and concurrent unlinks (both partners at once) queue instead of
-- deadlocking.
--
-- Security notes (docs/DATA_ISOLATION_AUDIT.md, SECURITY_SWEEP_REPORT.md C1):
--   * RLS is enabled on every table before any policy, so a half-applied
--     migration fails closed.
--   * Table privileges are revoked from PUBLIC, anon and authenticated, then
--     granted back to authenticated per command. Supabase's default
--     privileges grant ALL to anon on new public tables; RLS would still deny
--     anon (every policy is TO authenticated) but the revoke removes the
--     surface entirely.
--   * No view. Three SECURITY DEFINER functions, all with a pinned
--     search_path: the redeem and unlink functions (EXECUTE for authenticated
--     only, auth.uid() checked first) and the link after-delete trigger
--     (EXECUTE for nobody; it only deletes the snapshot and codes of the user
--     whose link row is being deleted).
--   * Unlink = unlink_hyrox_partner(): under both users' locks it deletes the
--     caller's link row; the mirror-row foreign key cascades the partner's
--     row away in the same statement. Clients hold no DELETE on the link
--     table, so no unlink skips the locks. The partner snapshot policy reads
--     the link table, so read access ends with the row, and the after-delete
--     trigger then deletes both snapshots.
-- =============================================================


-- ── 1. Invites ───────────────────────────────────────────────────────────────
-- Code: 8 characters from a 31-letter alphabet without look-alikes (no I, L,
-- O, 0, 1), generated server-side by the insert trigger below so a client
-- never picks a code. 31^8 is about 8.5e11 codes.
-- No used_at / used_by: a redeemed code is deleted, not marked, so no row
-- says who linked with whom. UNIQUE (owner_id): one code per user (the insert
-- trigger deletes the owner's earlier code first).

CREATE TABLE IF NOT EXISTS public.hyrox_partner_invites (
  code        text        PRIMARY KEY,
  owner_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT hyrox_partner_invites_code_format
    CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  CONSTRAINT hyrox_partner_invites_one_per_owner UNIQUE (owner_id)
);

CREATE INDEX IF NOT EXISTS idx_hyrox_partner_invites_expires
  ON public.hyrox_partner_invites (expires_at);

ALTER TABLE public.hyrox_partner_invites ENABLE ROW LEVEL SECURITY;

-- Server-owned fields: the client inserts only owner_id (checked by RLS).
-- Expiry: 24 hours from creation (product default; change here only).
-- One code per user: the owner's earlier code (live or expired) is deleted
-- before the new one is written, under the owner's advisory lock so this
-- queues behind a redeem that involves the same user. Runs as the invoker:
-- RLS limits the delete to the caller's own rows, and an insert for another
-- owner fails the INSERT policy afterwards, which rolls the delete back too.
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
  PERFORM pg_advisory_xact_lock(hashtextextended('hyrox_partner_user:' || NEW.owner_id::text, 0));
  DELETE FROM public.hyrox_partner_invites i WHERE i.owner_id = NEW.owner_id;

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
-- Clients only read here: redeem_hyrox_partner_invite inserts and
-- unlink_hyrox_partner deletes (section 5).

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

-- No DELETE policy: a direct delete would skip the per-user locks that keep
-- two simultaneous unlinks from deadlocking. (Dropped here in case an earlier
-- draft of this migration created it.)
DROP POLICY IF EXISTS hyrox_partner_links_delete_member ON public.hyrox_partner_links;

-- SELECT only for clients: the two functions in section 5 write.
REVOKE ALL ON TABLE public.hyrox_partner_links FROM PUBLIC;
REVOKE ALL ON TABLE public.hyrox_partner_links FROM anon;
REVOKE ALL ON TABLE public.hyrox_partner_links FROM authenticated;
GRANT SELECT ON TABLE public.hyrox_partner_links TO authenticated;


-- ── 3. Snapshots ─────────────────────────────────────────────────────────────
-- Typed columns, no free jsonb: nothing outside the whitelist can be stored.
-- Station arrays are in race order (HYROX_STATION_ORDER):
--   ski_erg, sled_push, sled_pull, burpee_broad_jumps, row_erg,
--   farmer_carry, sandbag_lunges, wall_balls
-- station_sec: the athlete's benchmark (seconds, one athlete over the full
--   station at their solo loads in the race, the Stats ledger value);
--   NULL = no benchmark (population seed).
-- station_tier: the load tier the athlete's numbers at that station
--   (station_sec and forecast_station_sec) are expressed at: their solo loads
--   in the race. The app converts every stored benchmark to those loads with
--   the per-sex Open/Pro conversions from the HYROX results data, so a Mixed
--   woman's Women Open tests are stored as Men Open times. Set on every
--   station, seeded ones too. NULL when it cannot be stated (no biological sex
--   on file in a Mixed or unknown division: the numbers then come from pooled
--   tables that mix both sexes' loads).
-- station_team: true when that benchmark is a doubles race split (a pair time).
-- forecast_station_sec: the athlete's own forecast per station before venue
--   factors, in the race format's terms (doubles: the pair's time at the
--   athlete's percentile). roxzone_sec: the same for Roxzone.
-- run_pace_sec_km: the athlete's singles run pace.
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

-- Writes: the caller's own row, and only while the caller has a link. A
-- snapshot exists to be read by a partner, so an unlinked user has nothing to
-- write: a client whose cached link is stale (the partner unlinked, or an
-- account deletion ended the link) is refused with 42501 instead of
-- re-creating a row nobody can read. The client reads that refusal as
-- 'unlinked'. Known limit: an upsert whose statement started before a
-- concurrent unlink committed still lands (milliseconds; the next push is
-- refused, and the row is deleted when the athlete leaves doubles, resets or
-- deletes the account).
DROP POLICY IF EXISTS hyrox_partner_snapshots_insert_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_insert_own ON public.hyrox_partner_snapshots
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS hyrox_partner_snapshots_update_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_update_own ON public.hyrox_partner_snapshots
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = (SELECT auth.uid()))
  );

-- Delete: the caller's own row, linked or not (leaving doubles, a reset).
DROP POLICY IF EXISTS hyrox_partner_snapshots_delete_own ON public.hyrox_partner_snapshots;
CREATE POLICY hyrox_partner_snapshots_delete_own ON public.hyrox_partner_snapshots
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM anon;
REVOKE ALL ON TABLE public.hyrox_partner_snapshots FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hyrox_partner_snapshots TO authenticated;


-- ── 4. Ending a link deletes both snapshots and both users' codes ──────────
-- A snapshot exists only to be read by a linked partner. When a link row is
-- deleted (either partner unlinks: the mirror row cascades; or an account is
-- deleted: auth.users cascades, or delete-account removes the row), the
-- snapshot of that row's user is deleted too, and so is any code that user
-- still holds (the redeemer's own code kept for a crossing redeem, or a code
-- made while linked), so an unlinked page never shows a code from before.
-- Fires once per link row, so both users' rows go. SECURITY DEFINER because
-- the partner's row cascades inside the caller's statement and the snapshot
-- and invite DELETE policies only cover the caller's own rows. It deletes
-- exactly one user's rows, the user of the link row being deleted, and nobody
-- can call it directly (EXECUTE revoked below; a trigger fires without it).

CREATE OR REPLACE FUNCTION public.hyrox_partner_link_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.hyrox_partner_snapshots s WHERE s.user_id = OLD.user_id;
  DELETE FROM public.hyrox_partner_invites i WHERE i.owner_id = OLD.user_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS hyrox_partner_link_after_delete ON public.hyrox_partner_links;
CREATE TRIGGER hyrox_partner_link_after_delete
  AFTER DELETE ON public.hyrox_partner_links
  FOR EACH ROW EXECUTE FUNCTION public.hyrox_partner_link_after_delete();


-- ── 5. Redeem and unlink ─────────────────────────────────────────────────────
-- redeem_hyrox_partner_invite: the only path that creates a link. Runs as the
-- function owner so the caller never reads another user's invite. Returns a
-- status word (never raises for an expected outcome, never returns another
-- user's data):
--   'linked'            both link rows written and the code deleted, or the
--                       pair already exists: a crossing redeem (the caller
--                       enters the code of the partner who just redeemed the
--                       caller's own code, during or after that redeem)
--   'not_authenticated' no user in the token
--   'already_linked'    the caller already has a partner (and the code is not
--                       that partner's)
--   'invalid_code'      not the code shape (the client checks this first)
--   'own_code'          the caller's own code
--   'unavailable'       no live code: never existed, already redeemed (a
--                       redeemed code is deleted) or expired. One word for
--                       all three, so the answer does not say whether a code
--                       ever existed
--   'partner_linked'    the code's owner already has a partner
--   'retry'             a concurrent call won a lock race; nothing was
--                       written, the client calls once more
--
-- A linked caller learns nothing about codes except whether the one entered
-- is their own partner's.
--
-- Locking: the first read (no lock) only learns the code's owner. Then both
-- users' advisory locks are taken in ascending key order (the same key the
-- invite insert trigger and unlink_hyrox_partner use), and the code and both
-- users' link state are re-read under them. Two redeems that share a user
-- therefore run one after the other, never a deadlock: A entering B's code
-- while B enters A's gives 'linked' to both (one pair); two people entering
-- one code give 'linked' and 'unavailable'; one person entering two codes
-- gives 'linked' and 'already_linked'. Anything that still fails on locking
-- (deadlock, serialization, lock timeout) or a unique violation on the link
-- rows rolls the inner block back and returns 'retry'.
--
-- Codes after a link: the redeemed code is deleted. The caller's own code,
-- if they had one out, stays: their new partner may be typing it right now
-- (A redeems B's code a few seconds before B taps Link on A's), and that
-- crossing redeem then answers 'linked' and deletes it. Ending the link
-- deletes it in any case (section 4).

CREATE OR REPLACE FUNCTION public.redeem_hyrox_partner_invite(code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_code    text := upper(regexp_replace(coalesce(redeem_hyrox_partner_invite.code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_partner uuid;
  v_owner   uuid;
  v_inv     public.hyrox_partner_invites%ROWTYPE;
  k_me      bigint;
  k_owner   bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  SELECT l.partner_id INTO v_partner
    FROM public.hyrox_partner_links l
   WHERE l.user_id = v_uid;

  IF v_partner IS NOT NULL THEN
    -- One partner at a time: a linked caller cannot redeem. The exception is
    -- the partner's own code (a crossing redeem), which settles below under
    -- the locks as 'linked'. Any other code: 'already_linked', whether or not
    -- it exists, so a linked caller cannot probe codes.
    IF v_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'
       AND EXISTS (SELECT 1 FROM public.hyrox_partner_invites i
                    WHERE i.code = v_code AND i.owner_id = v_partner) THEN
      v_owner := v_partner;
    ELSE
      RETURN 'already_linked';
    END IF;
  ELSE
    IF v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' THEN
      RETURN 'invalid_code';
    END IF;
    SELECT i.owner_id INTO v_owner
      FROM public.hyrox_partner_invites i
     WHERE i.code = v_code;
    IF NOT FOUND THEN
      RETURN 'unavailable';
    END IF;
    IF v_owner = v_uid THEN
      RETURN 'own_code';
    END IF;
  END IF;

  BEGIN
    k_me    := hashtextextended('hyrox_partner_user:' || v_uid::text, 0);
    k_owner := hashtextextended('hyrox_partner_user:' || v_owner::text, 0);
    PERFORM pg_advisory_xact_lock(least(k_me, k_owner));
    IF k_me <> k_owner THEN
      PERFORM pg_advisory_xact_lock(greatest(k_me, k_owner));
    END IF;

    -- Under the locks, the caller's link first. A crossing redeem (made
    -- before this call, or by a concurrent call that won the locks) finds the
    -- pair already made, which is the outcome the caller asked for: 'linked'.
    -- The code entered has no further use.
    IF EXISTS (SELECT 1 FROM public.hyrox_partner_links l
                WHERE l.user_id = v_uid AND l.partner_id = v_owner) THEN
      DELETE FROM public.hyrox_partner_invites i
       WHERE i.code = v_code AND i.owner_id = v_owner;
      RETURN 'linked';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = v_uid) THEN
      RETURN 'already_linked';
    END IF;

    SELECT i.* INTO v_inv
      FROM public.hyrox_partner_invites i
     WHERE i.code = v_code
     FOR UPDATE;
    IF NOT FOUND OR v_inv.owner_id <> v_owner OR v_inv.expires_at <= now() THEN
      RETURN 'unavailable';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hyrox_partner_links l WHERE l.user_id = v_owner) THEN
      RETURN 'partner_linked';
    END IF;

    INSERT INTO public.hyrox_partner_links (user_id, partner_id)
    VALUES (v_uid, v_owner), (v_owner, v_uid);

    -- The redeemed code goes; its row was the only one naming the owner in
    -- this exchange, so no row keeps the pair. The caller's own code stays
    -- for a crossing redeem (see the section header).
    DELETE FROM public.hyrox_partner_invites i
     WHERE i.owner_id = v_owner;

    -- Expired codes of anyone. SKIP LOCKED: rows another transaction holds
    -- are left for a later purge, so this never waits on (or deadlocks with)
    -- an unrelated user's code change.
    DELETE FROM public.hyrox_partner_invites i
     WHERE i.code IN (
       SELECT e.code FROM public.hyrox_partner_invites e
        WHERE e.expires_at <= now()
          FOR UPDATE SKIP LOCKED);
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure OR lock_not_available OR unique_violation THEN
      RETURN 'retry';
  END;

  RETURN 'linked';
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM anon;
REVOKE ALL ON FUNCTION public.redeem_hyrox_partner_invite(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_hyrox_partner_invite(text) TO authenticated;

-- unlink_hyrox_partner: the only client path that ends a link. Status words:
--   'unlinked'          the caller's link is gone: both rows (the mirror
--                       cascades), both snapshots and both users' codes
--                       (section 4)
--   'not_linked'        there was nothing to end, including when the partner
--                       unlinked first
--   'not_authenticated' no user in the token
--   'retry'             a lock failure; nothing was written, the client calls
--                       once more
--
-- Locking: the partner is read without a lock, then both users' advisory
-- locks are taken in ascending key order, the same order redeem uses. Before
-- (review 2026-10-13) the client deleted its own row directly: each DELETE
-- locked its own row and then waited on the mirror row the other held, so two
-- partners unlinking at the same moment deadlocked and one saw an error. Now
-- the second unlink waits for the first, then finds no row: 'not_linked'.

CREATE OR REPLACE FUNCTION public.unlink_hyrox_partner()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_partner   uuid;
  k_me        bigint;
  k_partner   bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  SELECT l.partner_id INTO v_partner
    FROM public.hyrox_partner_links l
   WHERE l.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN 'not_linked';
  END IF;

  BEGIN
    k_me      := hashtextextended('hyrox_partner_user:' || v_uid::text, 0);
    k_partner := hashtextextended('hyrox_partner_user:' || v_partner::text, 0);
    PERFORM pg_advisory_xact_lock(least(k_me, k_partner));
    IF k_me <> k_partner THEN
      PERFORM pg_advisory_xact_lock(greatest(k_me, k_partner));
    END IF;

    -- Only the link the caller had when the call began. If the partner
    -- unlinked first there is nothing left to end.
    DELETE FROM public.hyrox_partner_links l
     WHERE l.user_id = v_uid AND l.partner_id = v_partner;
    IF NOT FOUND THEN
      RETURN 'not_linked';
    END IF;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
      RETURN 'retry';
  END;

  RETURN 'unlinked';
END;
$$;

REVOKE ALL ON FUNCTION public.unlink_hyrox_partner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlink_hyrox_partner() FROM anon;
REVOKE ALL ON FUNCTION public.unlink_hyrox_partner() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_hyrox_partner() TO authenticated;

-- Trigger functions: never callable over the API (a trigger fires without the
-- caller holding EXECUTE).
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM anon;
REVOKE ALL ON FUNCTION public.hyrox_partner_invite_before_insert() FROM authenticated;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM anon;
REVOKE ALL ON FUNCTION public.hyrox_partner_snapshot_touch() FROM authenticated;
REVOKE ALL ON FUNCTION public.hyrox_partner_link_after_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hyrox_partner_link_after_delete() FROM anon;
REVOKE ALL ON FUNCTION public.hyrox_partner_link_after_delete() FROM authenticated;
