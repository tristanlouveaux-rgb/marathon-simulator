# Comprehensive Security Sweep — Report

**Date:** 2026-06-03 · **Scope:** the broad pre-launch sweep commissioned by `docs/SECURITY_SWEEP_BRIEF.md` (everything the focused 2026-06-03 edge-function pass did NOT cover).

**Status legend:** `[STATIC]` = found by code inspection only, not live-tested. `[LIVE]` = confirmed against the running Supabase project. `[FIXED]` = remediated + smoke-tested this pass.

> **LIVE Security Advisor RESULT (2026-06-03, run by owner in the dashboard):** Advisor found **exactly 1 security issue** — `public.vo2_trend` is a `SECURITY DEFINER` view (finding C1 below). Critically, the Advisor did **NOT** flag `rls_disabled_in_public` on any table, which means **RLS is enabled across all public tables in prod** — the §1 broad concern is resolved (LIVE-confirmed, consistent with the migrations). The remaining live RLS *detail* queries (policy bodies for `USING(true)`, applied-migration list) still need a token, but the headline isolation question is answered: RLS is on.
>
> ## C1 (CRITICAL) — ✅ RESOLVED — `public.vo2_trend` SECURITY DEFINER view  `[LIVE — confirmed exploitable, then dropped]`
> **2026-06-03: owner ran `drop view if exists public.vo2_trend;` in prod. Hole closed. App never referenced the view (grep-confirmed), so the drop is a no-op for Mosaic. Drop also committed as migration `20260603000001_drop_vo2_trend_view.sql` so prod ⇄ repo stay reconciled.**
> **CONFIRMED via live dashboard queries (owner, 2026-06-03):**
> - **Definition:** `select vo2max, avg(vo2max) OVER (PARTITION BY garmin_user_id ORDER BY day_date ...) ...` — a smoothed VO2max-over-time trend **partitioned by `garmin_user_id`**, i.e. the view rolls up **EVERY user's** VO2max time series + their Garmin identifier into one result set.
> - **Grants:** both `anon` AND `authenticated` hold `SELECT`. `anon` is the *unauthenticated* role, so `GET /rest/v1/vo2_trend` was reachable with the public anon key (ships in the bundle) **without logging in**.
> - **Mechanism:** `SECURITY DEFINER` runs the view as its creator (postgres), bypassing RLS on the underlying physiology table. Net effect: an unauthenticated caller could read all users' VO2max health trends and identifiers — a real cross-user leak past all the table-level RLS confirmed elsewhere.
> - **Provenance:** untracked (in no migration), unreferenced in `src/` or any edge function — a throwaway diagnostic created in the dashboard SQL editor (likely during the Stats-VO2 / Forecast work) and never cleaned up.
> **Remediation:** the app does not use it → **DROP** is the clean fix. Migration `supabase/migrations/20260603000001_drop_vo2_trend_view.sql` created (`DROP VIEW IF EXISTS public.vo2_trend;`, idempotent). Owner to run `drop view if exists public.vo2_trend;` in the dashboard now (token revoked so I can't), and/or the immediate non-destructive stopgap `alter view public.vo2_trend set (security_invoker = on);`.
> **Broader implication:** this orphan proves untracked dashboard objects exist. Recommend a one-time `pg_dump --schema-only` of prod reconciled against `supabase/migrations/**` to catch any other drift (untracked views/policies/grants the per-migration audit can't see).

> **Remaining live checks BLOCKED pending a fresh token.** The `SUPABASE_ACCESS_TOKEN` in the environment is **revoked** (verified: HTTP 401 from both the Management API `/v1/projects` and the MCP `get_advisors`). The Security Advisor run (#1, the highest-value item) and live RLS verification cannot run until the owner generates a fresh `sbp_` personal access token. All findings below the "Live checks" divider are STATIC until then.

---

## Severity summary

| Sev | Count | Item |
|-----|-------|------|
| CRITICAL | 1 | **C1 ✅ RESOLVED `[LIVE]` — `public.vo2_trend` SECURITY DEFINER view DROPPED in prod by owner 2026-06-03 + drop migration committed. Was a cross-user VO2 leak; app never referenced it, drop is a no-op for Mosaic.** |
| HIGH | 1 | H1 ✅ RESOLVED — `strava-auth-callback` token-body leak fixed + deployed (v28) |
| MEDIUM | 5 | M1 reconcile cron timing compare · M2 OAuth/refresh provider-error leaks · M3 wildcard CORS on garmin-reconcile + garmin-refresh-token · M4 unescaped external activity names → self-XSS · **M5 `[LIVE]` prod schema drift (manual untracked changes; 3 migrated tables missing in prod)** |
| LOW | 5 | L1 purge cron timing · L2 own-schema DB error messages · L3 garmin-webhook query-param secret fallback · L4 `.gitignore` only covers `.env.local` · L5 anonymous sign-in fallback |
| INFO | 2 | npm audit (build-deps only) · secret rotation hygiene |

---

## 1. Database / RLS — every table  `[STATIC — live Advisor PENDING]`

**Migration-level coverage (read from `supabase/migrations/**`):** every user-data table declares `ENABLE ROW LEVEL SECURITY` with `user_id = auth.uid()` (or equivalent) policies:

| Table | RLS in migration | Policy | Source migration |
|-------|------------------|--------|------------------|
| garmin_activities | ✅ | SELECT own | 20260602000000 |
| daily_metrics | ✅ | SELECT own | 20260303000001 |
| sleep_summaries | ✅ | SELECT own | 20260226180000 / 20260310060000 |
| activity_details | ✅ | SELECT own | 20260226180000 |
| physiology_snapshots | ✅ | SELECT own | 20260224000001 |
| garmin_tokens | ✅ | SELECT+UPDATE own | 20260219 |
| strava_tokens | ✅ | SELECT+UPDATE own | 20260224120000 |
| user_plan_settings | ✅ | SELECT+INSERT+UPDATE own | 20260311000001 |
| subscription_active | ✅ | SELECT own | 20260519000001 |
| route_safety_ratings | ✅ | INSERT+SELECT+UPDATE own | 20260507000001 |
| coach_narrative_usage | ✅ | SELECT own | 20260408 |
| coach_narrative_cache | ✅ | SELECT own | 20260417 |
| coach_chat_usage | ✅ | SELECT own | 20260503000001 |
| coach_workout_usage | ✅ | SELECT own | 20260528000001 |
| screenshot_vision_usage | ✅ | SELECT own | 20260528000001 |
| llm_spend_tracker | ✅ | **none (intentional)** — service-role-only, invisible to clients | 20260408 |
| garmin_auth_requests | ✅ | **none (intentional)** — service-role-only | 20260219 |
| strava_auth_requests | ✅ | **none (intentional)** — service-role-only | 20260224120000 |

The three "no policy" tables are secure-by-design: RLS enabled + no policy = deny-all to anon/authenticated; only the service-role edge functions touch them.

**✅ LIVE-VERIFIED 2026-06-03 (token restored):** queried prod directly via the Management API.
- **All 23 public tables have `relrowsecurity = true`** — RLS enabled everywhere, no table exposed by missing RLS.
- **Every policy scopes to `auth.uid()`** (`user_id = auth.uid()` qual/with_check). The ONLY non-scoped check is `waitlist.allow_anon_insert` (anon INSERT, `with_check true`) — correct for a public signup form (anon can add a row, cannot read the list; no SELECT policy exists). Minor: it's spam-insertable (no rate-limit) — not a leak.
- **No `USING (true)` read policy anywhere.**
- **`vo2_trend` dropped** — zero views remain in `public`.
- **`garmin_activities`** now fully locked: SELECT (public) + ALL (authenticated), both `user_id = auth.uid()`.
- **`deleted_at` columns EXIST** on garmin_tokens / strava_tokens / user_plan_settings, and `delete-account` is deployed (v5) — so the prior "account deletion broken: columns missing" note (`project_account_deletion_broken.md`) is **STALE**; that dependency is satisfied in prod. (Deletion still warrants a live functional test — not done here.)
- **Tables with RLS-on + 0 policies** (`Users General`, `activities`, `activity_files`, `garmin_auth_requests`, `garmin_events`, `llm_spend_tracker`, `lt_thresholds`, `metric_overrides`, `physiology_snapshot_daily`, `strava_auth_requests`) = deny-all to clients, service-role-only. Locked, not leaking.

**⚠️ NEW finding (MEDIUM, drift) — prod schema diverges from migrations:** `supabase_migrations.schema_migrations` stops at `20260505`, yet post-`20260505` changes (`deleted_at` cols, `garmin_activities` RLS `20260602000000`, `route_safety_ratings` `20260507000001`) are present — applied **manually in the dashboard**, untracked. Conversely, three tables with committed migrations were **never created in prod**: `subscription_active` (`20260519000001`), `coach_workout_usage` + `screenshot_vision_usage` (`20260528000001`). `entitlement.ts:52` reads `subscription_active` client-side → the coach entitlement path errors (coach is allowlist-gated/off, so no tester impact today).

**✅ PARTIALLY RESOLVED 2026-06-03 (token restored):** the three missing tables were applied live + verified — `subscription_active`, `coach_workout_usage`, `screenshot_vision_usage` now exist with RLS on + own-row SELECT policy (`auth.uid()`), writes service-role-only. RLS coverage is now complete; the `entitlement.ts` error is gone. Also fixed a repo bug found en route: the two `20260528000001_*` migration files shared an identical version prefix (a `db push`/`migration repair` blocker — version is the PK); renamed the screenshot one to `20260528000002_*`.

**STILL OPEN (owner, interactive):** the migration *tracker* is broadly out of sync — `supabase_migrations.schema_migrations` stops at `20260505`, but many later migrations were applied manually and aren't recorded. I deliberately did NOT rewrite `schema_migrations` (a half-reconcile is risky and a blind `db push` would re-apply already-present objects). Proper fix: run `supabase migration list` to see the true local-vs-remote diff, `supabase migration repair --status applied <version>` for each manually-applied migration, then keep all future changes going through `supabase db push` (not the dashboard SQL editor). Finish with a `pg_dump --schema-only` diff against `supabase/migrations/**`. This is the same untracked-object discipline whose absence produced the `vo2_trend` CRITICAL.

**Historical note (superseded by the live verification above):** migrations in the repo ≠ what is applied in prod. The launch-blocker memory note `project_account_deletion_broken.md` documents that migration `20260517000001_account_deletion.sql` **was never applied to prod**. That same migration *recreates* the RLS policies for `strava_tokens` / `garmin_tokens` / `user_plan_settings` (adding `deleted_at IS NULL`). If unapplied, those tables fall back to their earlier user-scoped policies (still safe for isolation), but it proves repo-vs-prod drift is real. **Only the live Security Advisor + a live `pg_class.relrowsecurity` query can confirm RLS is actually enabled on every table in prod.** This is item #1 and is PENDING the token.

**Live queries to run once the token is fresh** (see "Live checks" section at bottom).

---

## 2. Client-side data access  `[STATIC]`

Every client read of a per-user table was audited. Two access styles: the `supabase-js` `.from()` builder (RLS-backstopped by the JWT) and raw `fetch` to `/rest/v1/` (also JWT-scoped, RLS-backstopped).

| Site | Table | `user_id` filter? | Backstop | Verdict |
|------|-------|-------------------|----------|---------|
| `src/data/tri-activity-loader.ts:90` | garmin_activities | ✅ `&user_id=eq.${userId}` | RLS | safe (was the original leak; now fixed) |
| `src/ui/wizard/steps/review.ts:163` | garmin_activities | ✅ `&user_id=eq.${userId}` | RLS | safe |
| `src/ui/wizard/steps/tri-past-race.ts:301` | garmin_activities | ✅ `.eq('user_id', session.user.id)` | RLS | safe |
| `src/data/stravaSync.ts:850,902,1094,1184` | garmin_activities | ✅ `.eq('user_id', userId)` | RLS | safe |
| `src/data/planSettingsSync.ts:87` | user_plan_settings | ✅ `.eq('user_id', user.id)` | RLS | safe |
| `src/data/safetyRatingSync.ts:69` | route_safety_ratings | ✅ `.eq('user_id', user.id)` | RLS | safe |
| `src/coach/entitlement.ts:54` | subscription_active | ✅ `.eq('user_id', userId)` | RLS | safe |
| `src/data/supabaseClient.ts:78` | garmin_tokens | ❌ `limit=1`, no filter | **RLS only** | safe *iff* RLS on |
| `src/data/supabaseClient.ts:313` | strava_tokens | ❌ `limit=1`, no filter | **RLS only** | safe *iff* RLS on |
| `src/ui/account-view.ts:93` | garmin_tokens | ❌ `limit=1`, no filter | **RLS only** | safe *iff* RLS on |
| `src/ui/account-view.ts:108` | daily_metrics | ❌ `limit=1`, no filter | **RLS only** | safe *iff* RLS on |

**Finding:** the four no-filter reads rely entirely on RLS as the isolation backstop. They are connection-status / existence checks (`isGarminConnected`, `isStravaConnected`, last-sync date), so a worst-case RLS-off leak is small (another user's token *expiry* timestamp, a `day_date`) — not token bodies. Still, they make item #1 load-bearing: if RLS were ever off on `garmin_tokens` / `strava_tokens` / `daily_metrics`, these would silently cross-leak. **Recommendation (LOW, defense-in-depth):** add explicit `&user_id=eq.<id>` to all four so isolation does not depend solely on RLS. Not exploitable today assuming the migrations are applied.

No client read trusts a client-supplied id over the session; all derive the id from `getSession()/getUserId()` (the verified JWT). ✅

---

## 3. Edge functions  `[STATIC]`

Full per-function audit performed (all 21 functions read). Confirmed the 2026-06-03 fixes are in place. New findings:

### H1 (HIGH) — `strava-auth-callback` can return a live OAuth token to the client
`supabase/functions/strava-auth-callback/index.ts:119` returns `{ error: "no_access_token_in_response", raw: tokenJson }`. `tokenJson` is Strava's token-endpoint body; on a partial/edge response it can carry a `refresh_token` while `access_token` is empty — returning a live credential in the HTTP body. **Fix:** drop `raw: tokenJson`; return the error code only (matches `garmin-auth-callback:128`).

### M1 (MEDIUM) — `garmin-reconcile` cron secret uses timing-unsafe `===`
`supabase/functions/garmin-reconcile/index.ts:154` — `cronSecretHeader === expectedCronSecret`. NEW (this fn was in neither the fixed nor the ISSUE-255 list). **Fix:** reuse the `constantTimeEqual` helper already in `revenuecat-webhook` / `garmin-webhook`.

### M2 (MEDIUM) — provider error bodies leaked to client in OAuth/refresh paths
`garmin-refresh-token:90` (`details: text`), `garmin-backfill:139` (`details: txt`), plus `details:`/`String(e)` fields in `garmin-auth-start:61,93`, `strava-auth-start:54,86`, and both callbacks' `String(e)`. The 2026-06-03 pass fixed the *callback token-exchange* path but not the *refresh* functions or the `db_insert_failed`/`invalid_auth` detail fields. These return raw Garmin/Strava/Postgres strings (internal hostnames, column names, sometimes partial tokens in refresh-failure bodies). **Fix:** log server-side, return a generic code. (Item #4 of ISSUE-255 covers `garmin-backfill`; extend to the refresh + start fns.)

### M3 (MEDIUM) — wildcard CORS on `garmin-reconcile` + `garmin-refresh-token`
`garmin-reconcile/index.ts:44`, `garmin-refresh-token/index.ts:13` still `Access-Control-Allow-Origin: *`. NEW — both were omitted from the fixed list AND from ISSUE-255 (which names only sync-activities / sync-strava-activities / sync-physiology-snapshot). They authenticate via JWT/cron-secret so risk is lower than an unauth'd reader, but they are the two remaining auth'd functions outside the restricted-CORS pattern. **Fix:** apply `corsHeadersFor(req)`. Add them to ISSUE-255.

### L1 (LOW) — `purge-deleted-accounts:55` cron secret `!==` (timing). Cron-only, low exposure; constant-time for consistency.
### L2 (LOW) — own-data DB `error.message` returned to client: `sync-activities:111`, `sync-physiology-snapshot:177`, `sync-activity-details:75`, `export-user-data:127/149`. All post-auth, scoped to caller's own data → own-schema disclosure only. Prefer a generic `db_error` code.
### L3 (LOW) — `garmin-webhook:64` still accepts the secret via `?key=` query fallback (log-leak vector) alongside the preferred path segment. Optional: drop the query fallback now the path mechanism is confirmed.

**Known-pending (ISSUE-255), state confirmed unchanged:** wildcard CORS on sync-activities/sync-strava-activities/sync-physiology-snapshot (auth + user_id scoping present → not a leak, origin gap only); garmin-backfill auth-on-service-role-client; coach-chat tool *definitions* still client-supplied (only name-allowlist done).

**No CRITICAL:** no function derives identity from an unverified body field; the one body-id (`revenuecat-webhook` `app_user_id`) is validated via `auth.admin.getUserById` first. No hardcoded secrets (all `Deno.env`).

---

## 4. Auth flows  `[STATIC — see live OAuth replay check pending]`

- **JWT identity:** every data function uses an anon-key client `auth.getUser(jwt)` to derive identity, never a client body field. ✅
- **OAuth state / replay:** the OAuth callbacks look up a `*_auth_requests` row by `state`. PENDING live confirmation: (a) is the `state` row single-use (deleted/marked after callback so it can't be replayed)? (b) is PKCE used (Garmin OAuth2)? (c) is the redirect_uri allowlisted? The static read suggests state-lookup exists; replay/PKCE need a live or deeper read — flagged for the token-enabled pass.
- **Anonymous sign-in fallback (L5):** `supabaseClient.ts:36` falls back to `signInAnonymously()` on refresh failure. Anonymous users still get a scoped `auth.uid()` (isolation holds), but if anonymous auth is enabled it lets anyone mint a session and call edge functions (cost/abuse surface). Confirm whether anonymous provider is intentionally enabled; if not needed for the auth UX, disable it.

---

## 5. Frontend / bundle  `[STATIC]`

- **No service-role / `sbp_` / provider secrets in `src/`** (grep clean). ✅
- **Built bundle `dist/assets/`**: contains only the anon JWT (`eyJ…`, expected/public); NO `service_role` / `sbp_` / `whsec_` / `sk-ant` strings. ✅
- **XSS (M4, MEDIUM→self-XSS LOW):** an `escapeHtml`/`esc` helper exists (~20 copies) and IS used in newer code (strength views, plan-view, guided-strength, coach `formatAsHTML`→`escHtml`). The coach LLM output is escaped. **But** externally-sourced activity names (`displayName`/`name`, originating from Strava/Garmin `activity_name`, `stravaSync.ts:978`) are interpolated **raw** into `innerHTML` at: `stats-view.ts:2043`, `home-view.ts:1840`, `renderer.ts:749,943,1414`, `plan-view.ts:1383,4111`, `account-view.ts:211`, `mtl-load-view.ts:251`, `main-view.ts:236`. Because RLS scopes all data to the owner, this is **self-XSS** (a user injecting into their own session via their own Strava/Garmin activity title) — LOW today, but (a) inconsistent with the escaping done elsewhere, (b) elevated in a Capacitor/WKWebView context (native bridge access), (c) becomes stored-XSS the moment any activity name is shown cross-user (leaderboards/shared routes). **Fix:** route these through the existing `esc()` helper. Cross-cutting; fix all sites in one pass.

---

## 6. Dependencies & misc  `[STATIC]`

- **npm audit:** 13 vulns (2 critical, 8 high, 3 moderate) — **all in build/test dependencies** (vitest, esbuild, vite, rollup, postcss, tar, minimatch, picomatch, @isaacs/brace-expansion, @xmldom/xmldom, ws). **None ship in the browser bundle** → production runtime risk ≈ nil; these are dev-machine / CI supply-chain concerns. Most resolve via `npm audit fix` (non-breaking); the esbuild/vite one needs `--force` (breaking → vite@8). Recommend `npm audit fix` (safe subset) before opening to contributors; defer the vite major.
- **`.gitignore` (L4):** only `.env.local` is listed; no `.env*` files are tracked by git (verified clean). Broaden to `.env*` so a future `.env` / `.env.production` can't be committed by accident.
- **Secret rotation (INFO):** per the brief, three function secrets (Garmin / cron / RevenueCat) were exposed in a prior chat transcript — recommend rotation. Duplicate case-variant project secrets (`Anthropic_API_Key`, `Supabase_Service_Role_Key`) are unused — safe to delete. (Owner action in the dashboard; not codebase.)

---

## Live checks — PENDING fresh `SUPABASE_ACCESS_TOKEN`

Run these the moment a valid token is in the environment:

1. **Security Advisor** (`get_advisors type=security`, or dashboard → Advisors → Security). Triage every finding. This is the single broadest check — turns "migrations declare RLS" into "RLS is actually on in prod".
2. **Live RLS state** of every public table:
   ```sql
   select c.relname as table, c.relrowsecurity as rls_enabled,
     (select count(*) from pg_policies p where p.tablename=c.relname) as policies
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind='r' and n.nspname='public' order by c.relname;
   ```
   Flag any table with `rls_enabled=false`, or RLS on + 0 policies that ISN'T one of the three intentional service-role-only tables.
3. **Policy bodies** — confirm none use `USING (true)`:
   ```sql
   select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by tablename;
   ```
4. **SECURITY DEFINER views/functions** exposing data without RLS (Advisor flags these).
5. **OAuth `*_auth_requests` replay** — confirm rows are single-use (live read of the callback delete/mark logic against a real row).
6. Cross-check whether `20260517000001_account_deletion.sql` is in the applied migration list (`list_migrations`); if absent, the `deleted_at` launch blocker + the `deleted_at IS NULL` policy variants are both unconfirmed in prod.

---

## Resume kit — parked items, paste-and-go

All security-critical work is done (see status below). These four remain; none block onboarding a 2nd user. Each is self-contained.

**1. Migration tracker repair (interactive — do with CLI open).** Prod schema is current but `schema_migrations` is out of sync (stops at `20260505`; later migrations applied by hand). Reconcile:
```bash
export SUPABASE_ACCESS_TOKEN=<fresh sbp_ token>   # in ~/.zshrc
supabase migration list --project-ref elnuiudfndsvtbfisaje --use-api   # see local-vs-remote diff
# for each migration that's APPLIED-but-not-listed (e.g. 20260507000001, 20260512, 20260517000001/2, 20260519000001, 20260528000001, 20260528000002, 20260602000000, 20260603000001):
supabase migration repair --status applied <version> --project-ref elnuiudfndsvtbfisaje --use-api
# then keep ALL future schema changes going through `supabase db push` — NOT the dashboard SQL editor.
```

**2. Account-deletion end-to-end test (needs a throwaway account; before App Store submit).** Sign up a test user → Account → Delete account → confirm `deleted_at` is set on user_plan_settings/strava_tokens/garmin_tokens → confirm the `purge-deleted-accounts` cron removes it after the window. (Columns + fn already confirmed present, so this is a confirmation, not a fix.)

**3. M3 — CORS on `garmin-reconcile` + `garmin-refresh-token` (do POST-invite, with a sync smoke-test).** Convert their static `corsHeaders` to the per-request `corsHeaders(req)` pattern used in `sync-activity-details` (ALLOWED_ORIGINS = `['capacitor://localhost','https://mosaicrunning.run']` + localhost regex), thread `req` through `jsonResponse`, then:
```bash
supabase functions deploy garmin-reconcile --project-ref elnuiudfndsvtbfisaje --use-api
supabase functions deploy garmin-refresh-token --project-ref elnuiudfndsvtbfisaje --use-api
# smoke: trigger a Garmin reconcile/refresh from the app and confirm sync still works.
```
Also extend the M2 error-leak cleanup (return generic codes, log bodies server-side) in `garmin-refresh-token:90`, `garmin-auth-start:61,93`, `strava-auth-start:54,86`.

**4. `npm audit fix` (anytime; build-deps only).** `npm audit fix` for the safe subset; defer the esbuild/vite major (`--force`, breaking → vite@8).

---

## Fixes applied this pass

### Frontend — applied + verified (no deploy needed)  `[FIXED]`
- **M4 (XSS escaping of external activity names):** escaped the externally-sourced activity-title sinks that rendered raw into `innerHTML`:
  - `renderer.ts:749` (`calGarmin.displayName`), `:943` (`activityName` from `modReason`), `:1416` (`row.name`) → `escapeAttr`
  - `home-view.ts:1840` (`act.name`), `:2170` (`r.name`), `:2331` (`r.name`) → `escapeAttr`
  - `stats-view.ts:2043` (`a.displayName`) → `escapeHtml`
  - `plan-view.ts:4111` (`r.name`) → `escapeHtml`; `:1383` (injury `displayName`) → `escapeHtml`
  - `account-view.ts:211` (account email) → new local `escHtml`
  - `main-view.ts:236` (own onboarding name) → inline escape
  - `mtl-load-view.ts:251` (tri workout name, internal) → inline escape
  - **Verified:** `npx tsc --noEmit` clean · `npm run lint:ui` clean · `npx vitest run` 2949 passed / 28 skipped.
- **L4 (.gitignore):** broadened `.env.local` → `.env` + `.env.*` (with `!.env.example` exception) so a future `.env`/`.env.production` can't be committed.

**Deliberately deferred (own-name, self-only, no attacker path — documented per the cross-cutting rule):** `s.onboarding.name` in `race-forecast-view.ts:284`, `triathlon/stats-view.ts:47`, `triathlon/forecast-view.ts:91`, `triathlon/plan-view.ts:133` (the user's own self-entered name, shown only to themselves). Internal catalog/station/template names (`hyrox/*` `display.name`, race-catalog `race.name`, workout-preview `w.name`) and the `home-view.ts:252/258/264` `displayName` interpolations (which are inside `console.log`, not HTML sinks) were checked and are not external-data sinks.

### Edge functions — DEPLOYED + smoke-tested 2026-06-03  `[FIXED]`
Deployed via `supabase functions deploy <fn> --project-ref elnuiudfndsvtbfisaje --use-api` with the restored token:
- **H1:** `strava-auth-callback` (→ **v28**) — dropped `raw: tokenJson` from the no-access-token error response (was a potential live-token leak). Now returns the error code only + logs server-side. Smoke: bare GET → `{"error":"missing_code_or_state"}` HTTP 400 (handled, no crash, no token echo).
- **M1:** `garmin-reconcile` (→ **v13**) — cron-secret compare switched from `===` to a `constantTimeEqual` helper (timing-safe). Smoke: unauthenticated POST → `{"ok":false,"error":"unauthorized"}` HTTP 401 (new auth path runs cleanly).

### Logged, not fixed (need a tested deploy — added to ISSUE-255 items 5–6)
- **M3:** wildcard CORS on `garmin-reconcile:44` + `garmin-refresh-token:13` (structural preflight change → must be tested, not edited blind).
- **M2:** provider/DB error-body leaks in `garmin-refresh-token:90`, `garmin-auth-start:61,93`, `strava-auth-start:54,86`, and both callbacks' `String(e)`.
- **L1/L2/L3:** purge-cron timing compare; own-schema DB `error.message` in sync/export; garmin-webhook `?key=` query fallback.
- **L5:** anonymous sign-in fallback (`supabaseClient.ts:36`) — confirm whether the anonymous auth provider is intentionally enabled.
- **Client reads relying solely on RLS** (`supabaseClient.ts:78,313`, `account-view.ts:93,108`): add explicit `&user_id=eq.<id>` for defense-in-depth.

### npm audit
- All 13 vulns are build/test deps (none shipped). Recommend `npm audit fix` (non-breaking subset) before opening to contributors; defer the esbuild/vite major (`--force`, breaking). NOT applied this pass (would touch the lockfile mid-sweep).
