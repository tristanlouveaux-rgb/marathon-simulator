# Webhooks — Garmin Health API

Single source of truth for the `garmin-webhook` edge function. Covers every payload type Garmin can push, where the data ends up, and what's required to keep Garmin's production verification happy.

Related docs:
- `docs/GARMIN.md` — Garmin architecture overview, OAuth flow, backfill, history of incidents
- `docs/ARCHITECTURE.md` — app-level data flows; search "Garmin" / "physiology"

---

## The one sentence version

Garmin POSTs JSON to `https://elnuiudfndsvtbfisaje.supabase.co/functions/v1/garmin-webhook` whenever a user's watch syncs new data. Our handler (`supabase/functions/garmin-webhook/index.ts`) routes each top-level key to a dedicated handler, resolves the Garmin user to our Supabase user_id, and upserts into the appropriate DB table.

---

## Request shape

```
POST /garmin-webhook
Content-Type: application/json

{
  "dailies": [ { userId, calendarDate, ... } ],
  "sleeps":  [ { userId, calendarDate, ... } ],
  ...any number of top-level arrays, each keyed by type...
}
```

- **Auth**: none. Garmin does not send a JWT. The function is deployed with `--no-verify-jwt` and `config.toml` sets `verify_jwt = false` for this function. See `docs/GARMIN.md → 2026-03-12` for the incident where this was misconfigured and all pushes got 401'd silently.
- **User resolution**: every payload item carries either `userId` (stable Garmin user ID, preferred) or `userAccessToken` (OAuth token, fallback). `resolveUserId()` looks up `garmin_tokens` by both.
- **Response contract**: always return **HTTP 200**, even on internal errors. Non-200 responses cause Garmin to retry, which amplifies any downstream problem. We log and swallow.

---

## Payload types

Ordered by how commonly they fire.

| Top-level key | Handler | DB target | Purpose |
|---|---|---|---|
| `dailies` | `handleDailies` | `daily_metrics` | Resting HR, stress avg, steps, active minutes, sometimes VO2 |
| `sleeps` | `handleSleeps` | `sleep_summaries` | Sleep score + stage durations (deep/REM/light/awake) |
| `hrv` / `hrvSummaries` | `handleHrv` | `daily_metrics.hrv_rmssd` | Overnight HRV RMSSD, merges into the day's row |
| `activities` | `handleActivities` | `garmin_activities` | Activity summary: type, duration, distance, HR, calories |
| `activityDetails` | `handleActivityDetails` | `activity_details` | Full JSON activity payload (laps, samples) — stored as blob |
| `userMetrics` | `handleUserMetrics` | `physiology_snapshots` | VO2 Max running, Lactate Threshold pace/HR, fitnessAge |
| `stressDetails` | `handleStressDetails` | *(logged only)* | Per-minute stress samples. No storage — app uses `dailies.stress_avg` |
| `deregistrations` | `handleDeregistrations` | `garmin_tokens` (DELETE) | User revoked consent. Clear tokens. **Required for prod verification.** |
| `userPermissions` | `handleUserPermissions` | *(logged only)* | User changed data-sharing settings. Log for audit. **Required for prod verification.** |
| `activityFiles` | — (not implemented) | — | `.fit` file download URLs. Skipped; we get lap data via `activityDetails`. |

Key design rules all handlers follow:

1. **Idempotent upserts** keyed on `(user_id, calendar_date)` or `garmin_id`. Garmin re-pushes the same rows as data refines (e.g. sleep score computed 1–4 hours after stages), and we want the second push to fill in nulls rather than create a duplicate.
2. **Never overwrite good data with null.** `handleUserMetrics` skips upsert entirely if `vo2Max`, `lactateThresholdSpeed`, and `lactateThresholdHeartRate` are all null. `handleHrv` only writes `hrv_rmssd` if present. `handleDailies` only writes `hrv_rmssd` when the daily payload actually carries it.
3. **Field-name drift tolerance.** Garmin's field names vary between webhook and backfill APIs, and across firmware versions. Example: webhook sometimes sends `vo2MaxRunning`, REST sends `vo2Max`; webhook sends `remSleepInSeconds`, backfill sends `remSleepDurationInSeconds`. Handlers accept both.
4. **Log the raw payload** on anything unusual (currently `userMetrics`, `sleeps`). This is how we caught the "Garmin Portal only sends `fitnessAge`" issue during production verification.

---

## What data ends up where (for the app)

When the app renders sleep, HRV, VO2 etc. on Home / Readiness views, it does not hit these tables directly. It goes through:

```
DB (dailies/sleeps/physiology_snapshots)
    │  ↓ syncPhysiologySnapshot (src/data/physiologySync.ts) pulls 28 days on launch
    ↓
s.physiologyHistory in state
    │  ↓ Home/Readiness/Stats views read from state
    ↓
UI
```

So the path "Garmin → webhook → DB → sync → state → UI" can fail at any of 4 stages. When a number is wrong or missing, check in this order:
1. **DB query** — is the row in `daily_metrics` / `sleep_summaries` / `physiology_snapshots`?
2. **Webhook logs** — did the push arrive? Any `Error` lines?
3. **syncPhysiologySnapshot** logs — does it see the row and write it to state?
4. **UI** — is state right but the render broken?

---

## Production verification (Partner Verification tab)

The Garmin Developer Portal runs a suite of tests against our webhook before granting production credentials. Current state (2026-04-24):

| Test | Status | What's needed to pass |
|---|---|---|
| **Endpoint Setup Test** | ✅ | Passes after enabling `COMMON - Deregistrations` + `COMMON - User Permissions Change` in Endpoint Configuration (2026-04-24). |
| **Endpoint Coverage Test** | ❌ | 5 domains need last-24h traffic: `ACTIVITY_DETAIL`, `ACTIVITY_FILE_DATA`, `CONNECT_ACTIVITY` (record a HR-tracked Garmin run), `CONSUMER_PERMISSIONS` (toggle a data-sharing permission in Garmin Connect app), `USER_DEREG` (ping — may resolve automatically; otherwise disconnect/reconnect from Mosaic account screen). |
| **Active User Test** | ❌ | Needs 2+ users with data uploaded in last 24h. Currently 1 (Tristan). Add a beta tester who has connected Garmin. |
| **HTTP / Ping / Pull Tests** | ✅ | All three pass. |

**Why production matters:** Development credentials receive a subset of userMetrics fields. VO2 Max, Enhanced VO2 Max, Lactate Threshold Speed, and Lactate Threshold HR are held back on dev. Only `fitnessAge` and `enhanced: true` come through. Production approval unlocks full payloads.

---

## Current consumer key

```
1057f911-e0b2-45fa-9001-82ae1eac2c41  (development)
```

Production key will be a new UUID issued after approval. Migration will require:
1. Update `GARMIN_CLIENT_ID` + `GARMIN_CLIENT_SECRET` secrets in Supabase env
2. All users re-authenticate Garmin (old tokens are tied to the dev client_id)

---

## Handler code — authoritative list

Lives in `supabase/functions/garmin-webhook/index.ts`. Routing happens at the top of the `Deno.serve` handler based on top-level JSON keys.

```ts
if (body.dailies)          await handleDailies(...)
if (body.sleeps)           await handleSleeps(...)
if (body.hrv || body.hrvSummaries)  await handleHrv(...)
if (body.activities)       await handleActivities(...)
if (body.activityDetails)  await handleActivityDetails(...)
if (body.userMetrics)      await handleUserMetrics(...)
if (body.stressDetails)    await handleStressDetails(...)
if (body.deregistrations)  await handleDeregistrations(...)
if (body.userPermissions)  await handleUserPermissions(...)
```

Any unrecognised key is logged but ignored.

### Deregistration

Triggered when a user revokes consent from Garmin Connect → Privacy → Connected Apps. Payload:

```json
{ "deregistrations": [{ "userId": "79980b55-...", "userAccessToken": "..." }] }
```

Action: DELETE the matching row from `garmin_tokens`. The user's cached physiology data stays in DB (so if they reconnect later, it's still there), but we stop accepting future pushes for them and the app will see them as disconnected.

### User Permissions Change

Triggered when a user changes their data-sharing settings (e.g. revokes Activities but keeps Dailies). Payload:

```json
{ "userPermissions": [{ "userId": "...", "userAccessToken": "...", "permissions": ["HEALTH_EXPORT", "ACTIVITY_EXPORT"] }] }
```

Action: log for audit. We don't take any automatic action — the user's tokens remain valid, only their consent to specific data types has changed. Garmin will simply stop sending webhooks for revoked categories.

---

## Deployment

```bash
supabase functions deploy garmin-webhook --no-verify-jwt --project-ref elnuiudfndsvtbfisaje
```

Verify after deploy:
- [ ] `config.toml` still has `[functions.garmin-webhook]` with `verify_jwt = false`
- [ ] Invocations tab shows 200 after next sync (not 401)
- [ ] Log line `Daily metric stored` or `Sleep summary stored` appears on next Garmin push

---

## Debugging checklist

**No data arriving at all:**
1. Check Invocations tab for 4xx/5xx responses. 401 = `verify_jwt` misconfigured. 500 = handler crashed (check Logs).
2. Check `garmin_tokens` row exists for the expected user_id.
3. Check `resolveUserId` logs — both `userId` and fallback lookup.

**Data arriving but values are wrong or null:**
1. Check the raw payload log (`userMetrics raw:` or `Sleep keys for DATE:`). Field names may have drifted.
2. Check the DB row directly. If null there, it's a handler issue. If populated, it's a sync or UI issue downstream.

**Production verification tests failing:**
1. Endpoint Setup → missing deregistration / permissions change endpoints. Enable in Garmin Portal → Endpoint Configuration.
2. Endpoint Coverage → ACTIVITY_* endpoints haven't received data. Record a HR activity on a Garmin watch.
3. Active User → need 2+ users. Add a beta tester.
