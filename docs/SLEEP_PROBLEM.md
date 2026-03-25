# Garmin Sleep Data — Problem Log

> **This is a recurring, unresolved problem. Every fix attempt must be logged below. Do not assume anything is fixed until sleep data has been confirmed flowing for 3+ consecutive days.**

---

## Architecture (how sleep is supposed to work)

1. Watch syncs to Garmin Connect app via Bluetooth
2. Garmin Connect uploads to Garmin's servers
3. Garmin's servers push to our `garmin-webhook` edge function (POST to the function URL)
4. `garmin-webhook` upserts into `sleep_summaries` table
5. On app launch, `syncPhysiologySnapshot(28)` reads `sleep_summaries` → populates `physiologyHistory` in state
6. Stats → Readiness shows the data

**The pull path (`garmin-backfill`) does NOT work.** Garmin's wellness API (`/wellness-api/rest/sleeps`) returns 0 rows for this account. Sleep data only arrives via webhook push. Confirmed 2026-03-19 — `[garmin-sleep-refresh] Done — 0 sleep rows`.

---

## Webhook: what data Garmin pushes and when

Garmin sends POST requests with a JSON body. The top-level key identifies the type:

| Key in payload | Handler | DB table written |
|---------------|---------|-----------------|
| `sleeps` | `handleSleeps()` | `sleep_summaries` |
| `dailies` | `handleDailies()` | `daily_metrics` |
| `activities` | `handleActivities()` | `garmin_activities` |
| `hrv` / `hrvSummaries` | `handleHrv()` | `daily_metrics.hrv_rmssd` |
| `userMetrics` | `handleUserMetrics()` | `physiology_snapshots` |
| `stressDetails` | (logged, not stored) | — |
| `activityDetails` | `handleActivityDetails()` | `activity_details` |
| `epochs` / `bodyComps` | (ignored) | — |

**Critical: Garmin does NOT push `sleeps` in every invocation.** Sleep is pushed separately from dailies. A webhook call with only `dailies` or `stressDetails` is normal and does not mean sleep is working. You must see a push with `sleeps` key to confirm sleep data is flowing.

### resolveUserId — how we map Garmin push → Supabase user

Every payload item has a `userId` (stable Garmin user ID) and a `userAccessToken` (OAuth token).

1. First, look up `garmin_tokens.garmin_user_id` matching `userId`
2. Fallback: look up `garmin_tokens.access_token` matching `userAccessToken`
3. If neither matches → `resolveUserId: no match for identifier` → data is silently dropped

**If you see `resolveUserId lookup: <some-uuid>` with no "stored" log after it, the lookup failed.** This means `garmin_tokens` doesn't have that identifier stored. Fix: disconnect + reconnect Garmin in the app to re-run `garmin-auth-callback` which repopulates `garmin_tokens`.

### Sleep score timing quirk

Garmin often sends sleep stages (duration, deep, REM) in an early push right after morning sync, but the `sleepScores.overall.value` may arrive in a separate later push once Garmin's servers finish computing the score. The webhook handles both — it upserts on `(user_id, calendar_date)` so the second push updates the score without losing stage data.

---

## History of failures

### Failure 1 — Webhook returning 401 (~9 days before 2026-03-19)
**Root cause**: `garmin-webhook` was missing from `supabase/config.toml`. Supabase defaulted to `verify_jwt = true`, rejecting every Garmin push with 401.
**Fix**: Added `[functions.garmin-webhook] verify_jwt = false` to `config.toml`. Redeployed with `--no-verify-jwt`.
**Consequence**: 9 days of sleep data lost — Garmin retried pushes for a short window then gave up. Data unrecoverable via pull.

### Failure 2 — App-side permanent guard blocking backfill (2026-03-19)
**Root cause**: `triggerGarminBackfill()` used a permanent localStorage flag `mosaic_garmin_backfill_empty = '1'`. Once set (e.g. on a launch before the watch synced), the backfill was blocked forever on that device.
**Fix**: Changed to a 12-hour TTL guard (`mosaic_garmin_backfill_empty_until`). Old permanent key is cleared on first run of new code. Pull API still returns 0 rows — webhook remains the only data path.

---

## Fix attempt log

> **Rule**: Every time we attempt a fix, test, or change related to sleep data, log it here. Include what was tried, what the logs showed, and whether sleep actually appeared in the app.

| Date | What was tried | Logs / evidence | Outcome |
|------|---------------|-----------------|---------|
| ~2026-03-10 | First noticed sleep not pulling | — | No data for ~9 days |
| 2026-03-12 | Added `verify_jwt = false` to `config.toml`, redeployed `garmin-webhook` | No invocation logs checked | Deployed — unconfirmed on device |
| 2026-03-19 | Confirmed webhook 401 was root cause 1. Discovered permanent localStorage guard (root cause 2). Changed guard to 12h TTL. | `[garmin-sleep-refresh] Done — 0 sleep rows` | Guard cleared; pull confirmed non-functional |
| 2026-03-19 | Checked Supabase webhook invocations | Saw: `Received keys: dailies` + `Daily metric stored for user 44bd716f...`. Also saw `resolveUserId lookup: 79980b55...` with NO "stored" log (failed lookup). **No `sleeps` key in any invocation.** | Webhook IS alive. Dailies flowing. Sleep pushes not seen yet — either Garmin hasn't pushed sleep today, or they're going to the unresolved user ID. |
| 2026-03-19 | Checked `sleep_summaries` table | Last row is 2026-03-11. Nothing since. | **Confirmed: Garmin has completely stopped pushing `sleeps`.** Dailies still flow, sleep does not. Root cause: Garmin retried sleep pushes during the 401 period, hit the limit, and stopped retrying. Webhook fix did not recover this. |
| 2026-03-19 | Added error logging to `fetchPaginated` in garmin-backfill, triggered from browser console | `[garmin-backfill] Done — 0 daily rows, 0 sleep rows`. No per-day errors in browser (errors are in Supabase logs). Also revealed: `sync-physiology-snapshot` failing with `column sleep_summaries.duration_sec does not exist` | **Root cause found**: `sleep_summaries` table was missing columns `duration_sec`, `deep_sec`, `rem_sec`, `awake_sec`. Webhook was receiving sleep pushes, trying to upsert, failing silently, returning 200 to Garmin. Garmin never retried. Data lost since columns were added to code but never migrated to DB. |
| 2026-03-19 | Added missing columns via SQL: `duration_sec`, `deep_sec`, `rem_sec`, `awake_sec` to `sleep_summaries` | Columns added successfully | Webhook now able to write sleep data. Next Garmin push will land correctly. **To confirm: check sleep_summaries after tomorrow morning's watch sync.** |

### What the 2026-03-19 logs tell us
- **Good**: Webhook is receiving calls and storing dailies correctly — the 401 fix is working
- **Concern**: `resolveUserId lookup: 79980b55-a38a-4d45-987a-daf91b7498b2` failed (no "stored" log). This UUID doesn't match `44bd716f...` (the user getting data). Could be a second account or a stale token. **If Garmin's sleep push uses this same unresolved identifier, sleep data is being silently dropped.**
- **Unknown**: No `sleeps` key seen in invocations yet. Garmin typically pushes sleep in the morning after overnight sync — check the invocations tab again tomorrow morning after your watch syncs.

### Next diagnostic step (2026-03-20 morning)
After your watch syncs tomorrow morning, go to Supabase → Edge Functions → `garmin-webhook` → Invocations and look for:
- A push with `Received keys: sleeps` — this means Garmin pushed sleep data
- After that push: `Sleep summary stored for user ... on 2026-03-19` (or today's date)
- If you see `Received keys: sleeps` but NO "stored" log → `resolveUserId` failed → token mismatch problem

---

## How to diagnose if sleep stops showing up again

**Step 1 — Check webhook invocations**
Supabase Dashboard → Edge Functions → `garmin-webhook` → Invocations tab
- Is there a push with `Received keys: sleeps`? If no `sleeps` push, Garmin isn't sending it.
- Is each invocation returning 200? If 401/500, the webhook is broken (likely `verify_jwt` was reset).

**Step 2 — Check the DB directly**
Table Editor → `sleep_summaries` — any rows? What dates?
Table Editor → `daily_metrics` — are dailies flowing? (If dailies are there but no sleep, Garmin is pushing dailies but not sleep pushes, OR sleep is being dropped by resolveUserId)

**Step 3 — Check for resolveUserId failures**
In the invocation logs, look for `resolveUserId lookup: <uuid>` with no "stored" log following it.
If found: that identifier is not in `garmin_tokens`. Fix: disconnect + reconnect Garmin to re-run `garmin-auth-callback`.

**Step 4 — Check the app console on reload**
- `[PhysiologySync] State updated` → data was found in DB and loaded into state
- `[garmin-sleep-refresh] Done — 0 sleep rows` → pull always returns 0 (expected, not a problem)

---

## Key files

| File | Role |
|------|------|
| `supabase/functions/garmin-webhook/index.ts` | Receives Garmin push — handles sleeps, dailies, activities, HRV, userMetrics |
| `supabase/functions/garmin-backfill/index.ts` | Pulls historical data from Garmin API (returns 0 rows — push-only for this account) |
| `supabase/functions/sync-physiology-snapshot/index.ts` | Reads DB → returns merged daily_metrics + sleep_summaries |
| `src/data/physiologySync.ts` | Calls sync-physiology-snapshot, writes to `s.physiologyHistory` |
| `src/data/supabaseClient.ts` | `triggerGarminBackfill()` — 12h TTL guard |
| `supabase/config.toml` | Must have `[functions.garmin-webhook] verify_jwt = false` |

---

## Critical rules — never forget these

1. **Never redeploy `garmin-webhook` without `verify_jwt = false`**. Every Supabase deploy resets to config. If `config.toml` doesn't have it, the next deploy breaks the webhook. The entry is committed — as long as you use `supabase functions deploy` it stays correct.

2. **The pull API does not work for this account.** Do not spend time debugging `garmin-backfill` for sleep. It will always return 0 sleep rows. Webhook is the only path.

3. **A webhook invocation with only `dailies` does not mean sleep is working.** You must see a push with `sleeps` key AND a `Sleep summary stored` log line.

4. **`resolveUserId` silently drops data if it can't match the token.** Always check for lookup lines with no corresponding "stored" line. If found, the fix is re-doing the Garmin auth flow.
