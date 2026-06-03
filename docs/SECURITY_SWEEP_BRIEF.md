# Comprehensive Security Sweep — Handoff Brief

**Created:** 2026-06-03 · **For:** a fresh agent doing a full pre-launch security audit.
**Why this exists:** a focused security pass on 2026-06-03 fixed the issues it found in the edge-function + token surface (see "Already done" below). This brief commissions the *broader* sweep that pass explicitly did NOT cover — every table's RLS, all client-side data access, auth flows, the frontend bundle, and dependencies.

---

## App context
- **Mosaic** — adaptive training-plan app. TypeScript + Vite + Tailwind + Capacitor (ships iOS *and* web).
- Backend: **Supabase** (Postgres + Auth + Edge Functions). Project ref `elnuiudfndsvtbfisaje`.
- Three credential layers (do not conflate): **anon/publishable key** (client/app), **service-role key** (edge functions, bypasses RLS), **`sbp_` personal tokens** (CLI/admin).
- Currently single-user (the owner). Goal: harden before letting real testers/users in.

## Operating constraints
- The Supabase **MCP token is stale/revoked** as of this brief. To use the Supabase MCP (`get_advisors`, `execute_sql`, `list_tables`) or the CLI (`supabase ... --use-api`), the owner must generate a fresh `sbp_` personal access token and set `SUPABASE_ACCESS_TOKEN`. Ask for it; do not assume it exists.
- Much of this audit is **static analysis** and needs no live access. Do that first; request a token only for the live checks (Security Advisor, RLS verification queries, redeploys).
- **Never write secrets into repo files** (a prior pass leaked a cron secret into a committed-able `.sql` — don't repeat). Generated secrets go to env/Vault only.
- Deploys: `supabase functions deploy <fn> --project-ref elnuiudfndsvtbfisaje --use-api`. Note zsh does NOT word-split unquoted vars — use arrays in loops.

## Already done — DO NOT redo (see docs/CHANGELOG.md 2026-06-03 "Edge-function security hardening")
- `garmin-webhook` shared-secret auth (secret in URL **path**, not query — Garmin strips query strings). Enforced + verified.
- CORS over-match (`startsWith` → exact + localhost regex) fixed on: delete-account, export-user-data, coach-chat, coach-generate-workout, coach-narrative, screenshot-vision, sync-activity-details, sync-today-steps, garmin-backfill.
- revenuecat-webhook: constant-time compare + `app_user_id` existence check.
- sync-activity-details: added auth check.
- OAuth callbacks: stopped leaking provider/DB error bodies; `garmin_tokens.raw` trimmed.
- coach-chat: `sanitiseTools` name-allowlist.
- `garmin_activities`: **RLS enabled** + `user_id = auth.uid()` SELECT policy (migration `20260602000000`), applied + app-verified.
- Leaked `sbp_` token revoked.
- `config.toml`: `verify_jwt = false` blocks added for all self-authing functions.

## Scope of THIS sweep (the uncovered ground)

### 1. Database / RLS — every table (highest priority)
- Run Supabase **Security Advisor** (dashboard → Advisors → Security, or MCP `get_advisors` with `type: security`). Triage every finding.
- For EVERY table holding user data: confirm RLS is **enabled** and policies scope rows to `auth.uid()`. We only verified `garmin_activities`. Audit the rest: `daily_metrics`, `sleep_summaries`, `activity_details`, `physiology_snapshots`, `garmin_tokens`, `strava_tokens`, `user_plan_settings`, `subscription_active`, `coach_*_usage`, `coach_narrative_cache`, `route_safety_ratings`, `llm_spend_tracker`, `garmin_auth_requests`, `strava_auth_requests`, plus anything in `supabase/migrations/**` not listed.
- Flag any table with RLS disabled, no policy, or an overly-permissive `USING (true)` policy.
- Cross-reference `docs/DATA_ISOLATION_AUDIT.md` and the memory note `project_data_isolation_rls_leak.md` (a flagged launch blocker: RLS-off + unfiltered client reads).

### 2. Client-side data access (the rest of the data-isolation blocker)
- Grep all client reads: `grep -rn "from('garmin_activities')\|from(\"...\")" src/`. For every table read from `src/**`, confirm either an explicit `.eq('user_id', <authed id>)` filter OR that RLS backstops it. RLS now covers `garmin_activities`; verify the others.
- Known live read sites to check: `src/data/stravaSync.ts` (multiple), `src/ui/wizard/steps/tri-past-race.ts`. Confirm the correct authed id source (`(await getSession()).user.id`).

### 3. Edge functions — finish ISSUE-255 (docs/OPEN_ISSUES.md)
- Wildcard `Access-Control-Allow-Origin: *` still on the load-bearing sync pipe: `sync-activities`, `sync-strava-activities`, `sync-physiology-snapshot`. Apply the restricted `corsHeadersFor` pattern (already used in `sync-activity-details`). **Test sync end-to-end before/after — this is the canonical data pipe.**
- `garmin-backfill` + `sync-today-steps` verify auth on a service-role client; refactor to anon-client-for-auth + service-client-for-writes. Not a bypass (token is verified), so low urgency.
- Move `coach-chat` tool *definitions* server-side (name allowlist is only the interim fix).
- Check any edge function not in the "already done" list for the same auth/CORS/error-leak patterns.

### 4. Auth flows
- garmin/strava OAuth callbacks: verify `state` parameter (CSRF), PKCE where applicable, and that the redirect URI is validated/allowlisted. Check the `*_auth_requests` tables aren't replayable.
- Confirm JWT verification everywhere user identity is derived (`auth.getUser()` on a JWT-scoped client, never trusting client-supplied ids).

### 5. Frontend / bundle
- Confirm **only** the anon key ships in the client bundle — never the service-role key or any `sbp_` token. Grep the built output and `src/` for `service_role`, `sbp_`, `SERVICE_ROLE`.
- XSS: audit `innerHTML`/`insertAdjacentHTML` usage in `src/ui/**` for unescaped user/remote data.

### 6. Dependencies & misc
- `npm audit` — triage high/critical.
- Check `.gitignore` covers all `.env*` (currently only `.env.local`).
- Secrets hygiene: duplicate/case-variant project secrets exist (`Anthropic_API_Key`, `Supabase_Service_Role_Key`, etc. — unused, safe to delete). Three function secrets (Garmin/cron/RevenueCat) were exposed in a prior chat transcript; recommend rotation.

## Deliverable
A prioritized report — **CRITICAL / HIGH / MEDIUM / LOW** — each finding with `file:line`, concrete exploit/impact, and a one-line fix. Fix the clearly-exploitable + low-risk items directly (deploy + smoke-test); log the rest in `docs/OPEN_ISSUES.md`. State what was checked and found safe, so coverage is auditable. Nothing is "verified" until tested — distinguish static findings from live-tested ones. Update CHANGELOG + the security memory note when done.
