# Garmin Integration — How It Works & Known Issues

> **Webhook details** live in [`docs/WEBHOOKS.md`](./WEBHOOKS.md) — payload-by-payload reference, handler table, production verification requirements, debugging checklist. This doc covers the rest of the Garmin integration (OAuth, backfill, incident history).

## Architecture Overview

```
Garmin Watch → Garmin Connect (mobile app) → Garmin Health API servers
                                                        │
                                              POST to garmin-webhook
                                                        │
                                              Supabase Edge Function
                                                        │
                                         ┌──────────────┴──────────────┐
                                   daily_metrics              sleep_summaries
                                   physiology_snapshots        garmin_activities
                                         │
                                  sync-physiology-snapshot
                                         │
                                      App state
```

**Flow summary:**
1. User syncs Garmin watch to Garmin Connect (phone app, auto or manual)
2. Garmin Connect uploads data to Garmin's Health API servers
3. Garmin servers push a POST to our webhook (`garmin-webhook` edge function)
4. Webhook resolves the user, upserts into DB tables
5. On app launch, `syncPhysiologySnapshot` reads the DB and hydrates `s.physiologyHistory`

---

## OAuth & Tokens

- Auth flow: `garmin-auth-start` → Garmin OAuth → `garmin-auth-callback`
- Tokens stored in `garmin_tokens` table: `access_token`, `access_secret`, `garmin_user_id`
- Garmin uses OAuth 1.0a — tokens **do not expire** (unlike OAuth 2.0)
- Webhook payloads identify the user via `userId` (stable Garmin user ID) or `userAccessToken` (OAuth token) — we resolve both via `resolveUserId()` with fallback
- `garmin-refresh-token` edge function exists for future use but OAuth1 tokens don't need refreshing

---

## Data Types Received via Webhook

| Payload key | Handler | DB table | Timing after sync |
|---|---|---|---|
| `sleeps` | `handleSleeps` | `sleep_summaries` | 30min–4h (stages first, score later) |
| `dailies` | `handleDailies` | `daily_metrics` | ~30min |
| `hrv` / `hrvSummaries` | `handleHrv` | `daily_metrics.hrv_rmssd` | ~30min |
| `activities` | `handleActivities` | `garmin_activities` | ~5min after activity end |
| `activityDetails` | `handleActivityDetails` | `activity_details` | ~10min after activity end |
| `userMetrics` | `handleUserMetrics` | `physiology_snapshots` | After VO2max/LT computation |

### Sleep payload detail
Garmin sends sleep in two waves:
1. **First push** (shortly after wake + sync): stage durations present, `overall_sleep_score` often null
2. **Second push** (1–4h later): sleep score populated after Garmin's server-side scoring

Both upsert to `sleep_summaries (user_id, calendar_date)` — the second push fills in the score.

**Fields stored:**
- `overall_sleep_score` — 0–100 Garmin score
- `duration_sec` — total sleep duration
- `deep_sec` — deep sleep seconds
- `rem_sec` — REM sleep seconds
- `awake_sec` — awake time seconds

---

## Garmin Health API: Push-Only Behaviour

**Garmin's API is push-first.** The pull endpoint (`/wellness-api/rest/sleeps?uploadStartTimeInSeconds=X`) uses an upload timestamp window and is unreliable for recent data (< 24–48h). Do not rely on it for real-time sleep.

The `garmin-backfill` function uses pull as a best-effort fallback for historic data. It works for older dates but consistently returns 0 rows for the last 1–2 days. This is expected and documented in the code.

**What this means:** If the webhook breaks, there is no reliable pull fallback for recent data. The webhook must be kept healthy.

---

## Known Issues & History

### ✅ FIXED 2026-04-24 — `activity_details` upsert failing (42P10)

**Root cause:** `activity_details.garmin_id` column was added via `ALTER TABLE` with no unique constraint. Every webhook push with `activityDetails` failed with `code: "42P10"` — "no unique or exclusion constraint matching the ON CONFLICT specification". Migration `20260310000001_activity_details_constraint.sql` existed but was never applied to prod.

**Fix:** Ran `ALTER TABLE activity_details ADD CONSTRAINT activity_details_garmin_id_key UNIQUE (garmin_id);` in Supabase SQL Editor.

**Lesson:** Apply pending migrations before assuming the webhook handler is broken. Check `information_schema.table_constraints` if `42P10` ever reappears.

---

### ⚠️ OPEN 2026-04-24 — LT pace / HR not arriving on dev credentials (cause unconfirmed)

**Observation:** On 2026-04-24 a `userMetrics` push landed with `vo2Max: 55, fitnessAge: 24, enhanced: true`. VO2 Max is now reaching the app on the **development** consumer key (`1057f911-...`), which overturns the prior assumption that dev tier suppressed all VO2/LT fields. `lactateThresholdSpeed` and `lactateThresholdHeartRate` were **not** in that payload even though the user's watch has current LT values in Garmin Connect.

**Root cause is unconfirmed.** Garmin's public docs do not specify field-by-field gating between dev and production credentials. Two plausible explanations remain in play:

1. **Dev tier still gates LT fields** — our previous theory, still possible but unproven in public docs.
2. **LT simply hadn't refreshed.** Garmin only recomputes LT after specific efforts (guided LT tests, structured threshold sessions). `userMetrics` pushes are one-off per metric change, so the absence of LT in one payload doesn't mean LT will never arrive.

**How to resolve:**
- Monitor for `lactateThresholdSpeed` / `lactateThresholdHeartRate` in future `userMetrics` pushes over the next 1–2 weeks. If nothing arrives after a threshold-style run, gating is the likely cause.
- Email `connect-support@garmin.com` asking for a definitive list of fields released to dev vs production. Template in `docs/GARMIN.md → Support contact draft` below.
- Do NOT block the production-key application on this question; apply anyway once Partner Verification passes.

**Do not claim in UI copy that LT is "awaiting production access"** — we do not know that to be true. If LT is missing, show the field as "unavailable" without attributing cause.

---

### Support contact draft (Garmin Developer)

Email template to send to `connect-support@garmin.com` when we need a field-level answer on gating:

> Subject: Health API userMetrics — which fields are released to development credentials?
>
> Hello,
>
> Consumer Key: `1057f911-e0b2-45fa-9001-82ae1eac2c41` (development)
>
> We are receiving `userMetrics` webhook pushes that include `vo2Max` and `fitnessAge` but never `lactateThresholdSpeed`, `lactateThresholdHeartRate`, or `enhancedVo2MaxRunning`, even though the user's Garmin Connect account shows current LT values. Could you confirm:
>
> 1. Which `userMetrics` fields are released to development consumer keys?
> 2. Which fields require production credentials?
> 3. Is there a trigger or cadence for LT that differs from VO2 Max (e.g. threshold-detected efforts only)?
>
> Thank you.

---

### ✅ FIXED 2026-03-12 — Webhook returning 401 (all pushes dropped)

**Root cause:** `garmin-webhook` was missing from `supabase/config.toml`. Supabase defaults to `verify_jwt = true`. Garmin's pushes carry no JWT, so every POST was rejected with 401 before reaching function code.

**Symptoms:**
- No sleep data in DB for ~3 weeks
- Invocations tab showed all 401s
- Backfill still ran (different code path) but returned null sleep data
- Daily metrics also stopped updating

**Fix:** Added `[functions.garmin-webhook] verify_jwt = false` to `config.toml` and redeployed with `--no-verify-jwt`.

**Prevention:** Any new edge function that receives external (non-user) pushes (Garmin, Strava webhooks, etc.) must have `verify_jwt = false` in `config.toml` AND be deployed with `--no-verify-jwt`. Always verify this when deploying a new public-facing function.

---

### Sleep Stages Migration History

- `20260226_sleep_and_activity_details.sql` — Created `sleep_summaries` with only `overall_sleep_score`
- `20260311120000_sleep_stages.sql` — Added `duration_sec`, `deep_sec`, `rem_sec`, `awake_sec` — Garmin was already sending these in the webhook but they were being discarded

---

## Backfill / Refresh Functions

| Function | Purpose | Guard |
|---|---|---|
| `triggerGarminBackfill(weeks)` | Pull historic dailies + sleep for N weeks | `localStorage` guard: skips if previous run returned 0 rows (push-only API) |
| `refreshRecentSleepScores()` | Re-fetch last 7 days, bypass guard | Called on every app launch — handles the case where last night's sleep score wasn't computed yet when the first push landed |
| `resetGarminBackfillGuard()` | Clear the localStorage guard | Call after re-auth or to force a retry |

**Run order in `main.ts`:** `garmin-backfill` → `syncPhysiologySnapshot` (so DB data is in state on same launch)

---

## Roadmap: Other Wearables

The DB schema is wearable-agnostic — `sleep_summaries` and `daily_metrics` have no Garmin-specific columns (the `garmin_user_id` on raw tables is an implementation detail, not schema-enforced for sleep/dailies).

Adding Whoop, Oura, Polar etc. means:
1. New OAuth flow + token table (or reuse a generic `wearable_tokens` table)
2. New webhook handler or pull fetcher → upserts into same `sleep_summaries` / `daily_metrics`
3. `sync-physiology-snapshot` already reads from those tables agnostically — no changes needed there

The `resolveUserId` pattern can be extended per-wearable.

---

## Deployment Checklist

When deploying or redeploying `garmin-webhook`:

```bash
supabase functions deploy garmin-webhook --no-verify-jwt --project-ref elnuiudfndsvtbfisaje
```

Always verify:
- [ ] `config.toml` has `[functions.garmin-webhook]` with `verify_jwt = false`
- [ ] Invocations tab shows 200 (not 401) after next Garmin sync
- [ ] Logs show `[garmin-webhook] Sleep summary stored` or `Daily metric stored`
