# Multi-Tenant Data-Isolation Audit (2026-06-02)

> **STATUS (2026-06-02):** Stage 1 client filters SHIPPED (loader, onboarding, sync-activities edge fn — see below). Stage 2 RLS **APPLIED on `garmin_activities`** (RLS enabled + `garmin_activities_own` policy `FOR ALL using (user_id = auth.uid())`, verified live) — the P0 live leak is CLOSED server-side. **Remaining:** redeploy edited `sync-activities` edge fn (optional, RLS already covers it); enable RLS on the latent tables `metric_overrides` + `physiology_snapshot_daily` (P0-5, no live readers); Stage 3 composite-key hardening (P1-1). NOT yet device-verified on a real multi-user test.

Supabase project `elnuiudfndsvtbfisaje`. Read-only audit — no code/DB/RLS object was changed. Triggered by a confirmed cross-user leak found while debugging an FTP issue: a freshly-signed-in empty account (`c6c1b678`, 0 rows) was displaying a forecast computed from other accounts' activities.

**LAUNCH BLOCKER.** Must be fixed before handing the build to external test users.

## Bottom line
`garmin_activities` ships with RLS **disabled** and is read by three client paths + one edge function that do **no** `user_id` filtering, so every authenticated user loads all users' rows. The correct user-id source for a client filter is `supabase.auth.getSession().session.user.id` (== `auth.getUser().user.id`) — already used successfully against the same table in `stravaSync.ts` and `tri-past-race.ts`, which refutes the loader's "returns 0 rows" comment (that was a stale/unhydrated session at an early call site). All service-role edge functions are already correctly user-scoped, so enabling RLS will not break them.

## Findings (severity-ranked)

### P0 — live cross-user leak
- **P0-1 `garmin_activities` RLS off** (`relrowsecurity=false`, 0 policies). 582 rows across 5 user_ids + 10 null-user_id rows, all readable by any authenticated user. Root of every leak below.
- **P0-2 `loadActivitiesFromDB`** (`src/data/tri-activity-loader.ts:74-84`) — REST select with `order`+`limit` only, no `user_id`. Returns up to 500 of everyone's activities. Header comment (lines 16-20) claiming RLS scopes it is false.
- **P0-3 `sync-activities` edge fn** (`supabase/functions/sync-activities/index.ts:24-48`) — user-JWT passthrough, selects `garmin_activities` by `start_time` only, no `user_id`. Feeds `src/data/activitySync.ts:30 syncActivities()` (the main launch sync) → leak reaches home/plan/matching, not just tri forecasts.
- **P0-4 onboarding wizard** (`src/ui/wizard/steps/review.ts:157-167 fetchRecentActivities`) — REST select (limit 1000), `start_time` only, no `user_id`. New user's run-count gate + PB auto-extraction computed from other users' runs/`best_efforts`.
- **P0-5 `metric_overrides` & `physiology_snapshot_daily` RLS off** — per-athlete physiology (vo2max/LT/HR/HRV/readiness), keyed by `garmin_user_id`. No current readers in `src/` or `functions/`, so **latent** (no live leak today), but same defect class.

### P1 — exploitable / correctness
- **P1-1 global `garmin_id` unique key** (`garmin_activities_garmin_id_key` on `garmin_id` alone; upserts `onConflict:"garmin_id"` at `garmin-webhook/index.ts:174`, `sync-strava-activities/index.ts:1688`). Not composite with `user_id` → if two users share a `garmin_id`, one upsert overwrites the other's row and rewrites its `user_id` (silent data loss/reassignment). Same for `activity_details` (`activity_details_garmin_id_key`). Correctly composite: `daily_metrics(user_id,day_date)`, `sleep_summaries(user_id,calendar_date)`, `physiology_snapshots(user_id,calendar_date)`.
- **P1-2 RLS-on-but-no-policy tables** (`activities`, `activity_files`, `garmin_events`, `garmin_auth_requests`, `strava_auth_requests`, `llm_spend_tracker`, `lt_thresholds`, `Users General`). Default-deny for clients today (safe), service-role bypasses. `activities`/`activity_files`/`lt_thresholds` hold per-user data keyed by `garmin_user_id` with no policy — must get correct policies during RLS rollout, not a hasty permissive one.

### P2 — defense-in-depth / latent
- **P2-1** `tri-past-race.ts:299-302` and `stravaSync.ts:848-903` already filter `.eq('user_id', session.user.id)` correctly (proof the filter works); they rely only on the client filter, become double-defended once RLS is on.
- **P2-2** `sync-activity-details/index.ts:32-36` selects `activity_details` by `garmin_id` only; safe ONLY because that table has RLS+policy. Add explicit `.eq('user_id', user.id)` for defense-in-depth.
- **P2-3** 10 orphaned null-`user_id` rows in `garmin_activities` (from `garmin-webhook resolveUserId` failures; non-core sports). Leak to everyone today; vanish from all users once a `user_id` filter is in place (acceptable — unattributable).

## RLS coverage table
| Table | RLS | SELECT policy? | Per-user key | Verdict |
|---|---|---|---|---|
| garmin_activities | OFF | no | user_id | **P0 leak** |
| metric_overrides | OFF | no | garmin_user_id | P0 latent |
| physiology_snapshot_daily | OFF | no | garmin_user_id | P0 latent |
| activities | ON | none (deny) | garmin_user_id | P1 needs policy |
| activity_files | ON | none (deny) | garmin_user_id | P1 needs policy |
| garmin_events | ON | none (deny) | user_id | service-role only OK |
| garmin_auth_requests | ON | none (deny) | user_id | OK (oauth scratch) |
| strava_auth_requests | ON | none (deny) | user_id | OK (oauth scratch) |
| llm_spend_tracker | ON | none (deny) | global | OK (service-role) |
| lt_thresholds | ON | none (deny) | garmin_user_id | P1 needs policy if read client-side |
| Users General | ON | none (deny) | id | OK (unused) |
| activity_details | ON | yes `user_id=auth.uid()` | user_id | OK |
| daily_metrics | ON | yes | user_id | OK |
| sleep_summaries | ON | yes | user_id | OK |
| physiology_snapshots | ON | yes | user_id | OK |
| coach_chat_usage / coach_narrative_cache / coach_narrative_usage | ON | yes | user_id | OK |
| garmin_tokens / strava_tokens | ON | yes (select+update) | user_id | OK |
| user_plan_settings | ON | yes (select+insert+update) | user_id | OK |
| route_safety_ratings | ON | yes | user_id | OK |
| waitlist | ON | anon insert only | — | OK |

> 2026-10-13 (lane HP): three new tables, RLS on. `hyrox_partner_invites`: own rows. `hyrox_partner_links`: rows naming the caller. `hyrox_partner_snapshots`: own row, plus the linked partner's row through the caller's link row, the first policy that lets one user read another's data (both users opted in through the invite code). Every client read also filters by the session user (`src/data/hyroxPartner.ts`). SCIENCE_LOG §DM, RUNBOOK "HYROX Doubles partner tables".

## Correct user_id source for client filters
`await supabase.auth.getSession()` → `session.user.id` (await hydration; do not read before auth is ready). Stored `user_id` == this value by construction: `garmin-webhook/index.ts:106-121` and `sync-strava-activities/index.ts:869,1666` stamp it from the Supabase auth UUID. The loader's "0 rows" history was a stale JS-client session at that early call site, not an id mismatch.

## Fix sequence
**Stage 1 — client filters (ship today, low risk; no DB change). Edits:**
1. `src/data/tri-activity-loader.ts:74` — add `&user_id=eq.<id>` to the REST URL; delete the false RLS comment (16-20).
2. `src/ui/wizard/steps/review.ts:157` — add `&user_id=eq.<id>`.
3. `supabase/functions/sync-activities/index.ts:24-48` — derive `userId` via user-JWT `auth.getUser()` (mirror `sync-physiology-snapshot/index.ts:23-24`), add `.eq('user_id', userId)` to both selects. **Requires redeploy of `sync-activities`.**

**Stage 2 — enable RLS (the real fix).** RLS on + `user_id = auth.uid()` SELECT policy on `garmin_activities`. For `metric_overrides`, `physiology_snapshot_daily`, `activities`, `activity_files`, `lt_thresholds` (keyed by `garmin_user_id`, not `auth.uid()`) the policy must join through `garmin_tokens`: `garmin_user_id in (select garmin_user_id from garmin_tokens where user_id = auth.uid())`. **Confirm policy shape with Tristan before writing.** Do Stage 1 first so there's no leak window. Will NOT break service-role edge functions (they bypass RLS and already filter by user).

**Stage 3 — write-key hardening (P1-1).** Migrate `garmin_activities` + `activity_details` unique key from `garmin_id` → composite `(user_id, garmin_id)`; update `onConflict` at `garmin-webhook/index.ts:174`, `sync-strava-activities/index.ts:1688`, `garmin-webhook/index.ts:429`. Migration + redeploy; lower probability, schedule after 1/2.

**Already correct (no action):** user_plan_settings, daily_metrics, sleep_summaries, physiology_snapshots, garmin_tokens, strava_tokens, route_safety_ratings, all coach tables.
