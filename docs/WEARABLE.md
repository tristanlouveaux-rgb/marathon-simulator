# Wearable Integration Strategy

Full plan for rolling out Mosaic to Apple Watch, Whoop, Oura, and all major wearables, including phone-only users with no wearable at all.

---

## Current State

| Source | Status | What we get |
|--------|--------|------------|
| **Strava** | Live | Activities, HR stream (1s), GPS, splits, iTRIMP, HR zones, pace. OAuth 2.0. Edge function pipeline. |
| **Garmin** | Live | Webhook push: activities, daily metrics (resting HR, HRV, stress, steps), sleep (stages + score), VO2max, LT pace/HR. OAuth 1.0a (never expires). |
| **Apple Health** | Partial | Workouts only (distance, duration, calories, type). No HR, no sleep, no HRV. Uses `@capgo/capacitor-health`. iOS native only. |

### What's missing

1. **Apple Health HR stream** from completed workouts (available in HealthKit, not wired)
2. **Apple Health sleep/HRV/VO2max** (available in HealthKit, not wired)
3. **Whoop** (recovery, HRV, sleep, strain, no HR stream)
4. **Oura** (sleep stages, HRV, readiness, temperature, no workout HR)
5. **Polar** (activities with 1s HR, sleep, recovery, running power)
6. **Fitbit** (HR, sleep stages, HRV, SpO2, Active Zone Minutes)
7. **Health Connect** (Android unified API: Samsung, Fitbit, Garmin, all write here)
8. **Phone-only** (GPS + steps only, no HR, no sleep)

---

## Architecture Principle: Two Data Channels

Every integration feeds into exactly two channels:

| Channel | What | Format | Destination |
|---------|------|--------|-------------|
| **Activity** | Workouts with HR, GPS, pace | `GarminActivityRow` | `matchAndAutoComplete()` |
| **Physiology** | Sleep, HRV, resting HR, VO2max, temperature | `PhysiologyDayEntry` | `s.physiologyHistory` |

No integration needs to know about plans, weeks, TSS, or readiness. Each integration is a thin adapter that converts platform-specific data into one of these two shapes. The existing engines (activity matcher, fitness model, readiness calculator, sleep insights) consume them unchanged.

```
                                      ┌─────────────────────┐
  Strava ──→ edge fn ──→ GarminActivityRow[]  ──→ matchAndAutoComplete()
  Garmin ──→ webhook  ──→ GarminActivityRow[]  ──→        │
  HealthKit ──→ native ──→ GarminActivityRow[] ──→        │
  Polar ──→ edge fn ──→ GarminActivityRow[]    ──→        │
  Phone GPS ──→ native ──→ GarminActivityRow[] ──→        │
                                                          ↓
                                                   Plan engine
                                                          ↑
  Garmin ──→ webhook ──→ PhysiologyDayEntry[]  ──→        │
  HealthKit ──→ native ──→ PhysiologyDayEntry[]──→        │
  Whoop ──→ edge fn ──→ PhysiologyDayEntry[]   ──→        │
  Oura ──→ edge fn ──→ PhysiologyDayEntry[]    ──→        │
  Fitbit ──→ edge fn ──→ PhysiologyDayEntry[]  ──→        │
  Health Connect ──→ native ──→ PhysiologyDayEntry[] ──→  │
```

---

## Integration Tiers

### Tier 1: Expand What We Have (highest impact, lowest effort)

#### 1A. Full Apple HealthKit (iOS)

**Why first**: Every Apple Watch user is already an iOS user. HealthKit is on-device (no server, no OAuth, no edge function). Covers Apple Watch, plus any device that writes to HealthKit (Garmin, Polar, Whoop, Oura all do).

**What to add**:

| Data | HealthKit type | Current | Gap |
|------|---------------|---------|-----|
| Workout HR samples | `HKQuantityType.heartRate` query per workout | Not queried | Need `readSamples` per workout window |
| Resting HR | `HKQuantityType.restingHeartRate` | Not queried | Daily value |
| HRV | `HKQuantityType.heartRateVariabilitySDNN` | Not queried | Nightly SDNN |
| VO2max | `HKQuantityType.vo2Max` | Not queried | Apple's native estimate |
| Sleep stages | `HKCategoryType.sleepAnalysis` | Not queried | Core/Deep/REM/Awake since watchOS 9 |
| Running power | `HKQuantityType.runningPower` | Not queried | Series 6+ / Ultra |
| Workout route | `HKWorkoutRoute` | Not queried | GPS polyline |

**Implementation**:

1. **Replace or extend `@capgo/capacitor-health`**. The current plugin does not expose HR samples per workout. Options:
   - **Option A**: Write a thin custom Capacitor plugin (~200 lines Swift) that wraps `HKSampleQuery` for HR, sleep, HRV, VO2max. This is the most reliable path. Full control over query predicates and sample density.
   - **Option B**: Fork `@capgo/capacitor-health` and add `readSamples` for HR type. Upside: less code. Downside: maintaining a fork.
   - **Option C**: Use `capacitor-community/health-connect` on Android side, custom plugin on iOS side. Split implementations behind a single TypeScript interface.
   - **Recommended**: Option A. A custom Capacitor plugin for HealthKit. The Swift HealthKit API is straightforward. The community plugins lag behind Apple's additions (running power, ground contact time were added in watchOS 9).

2. **Activity sync with HR**: After fetching workouts via `Health.queryWorkouts()`, for each workout:
   - Query `HKQuantitySample` of type `heartRate` within `[workout.startDate, workout.endDate]`
   - Sort by timestamp. Compute iTRIMP using existing formula.
   - Compute HR zones (time in Z1-Z5) from the sample series.
   - Compute km splits from workout route samples (if available).
   - Populate `avg_hr`, `max_hr`, `iTrimp`, `hrZones`, `kmSplits` on the `GarminActivityRow`.

3. **Physiology sync**: New function `syncAppleHealthPhysiology()`:
   - Query last 28 days of resting HR, HRV, VO2max, sleep analysis.
   - Convert to `PhysiologyDayEntry[]` (same shape as Garmin physiology sync).
   - Store in `s.physiologyHistory`.
   - Apply same LT sanity checks.

4. **Background observer**: Register `HKObserverQuery` for workout and sleep types. When new data arrives (post-run, post-sleep), trigger sync. This gives near-real-time updates without user manually opening the app.

**Risks**:
- HealthKit `HKObserverQuery` in background requires Background App Refresh entitlement. Apple can throttle this.
- If user wears a Garmin watch but syncs to HealthKit, you may get duplicate data (Garmin webhook + HealthKit). Dedup by 2-minute time window on start time (existing pattern).
- Apple's VO2max only updates on outdoor GPS runs/walks. Indoor treadmill users won't get updates.
- User can revoke HealthKit permissions silently. App sees empty results, not an error. Need graceful degradation.

**Effort estimate**: Custom Capacitor plugin (Swift side ~300 lines, TypeScript bridge ~150 lines). Client-side sync functions ~200 lines TypeScript. Total: ~1 week of focused work.

#### 1B. Strava as Universal Activity Layer

**Why**: Strava already works. COROS, Suunto, Polar, Wahoo, Amazfit, and others all auto-sync to Strava. By keeping Strava as the primary activity pipeline, we get broad device coverage for free.

**What to verify**: Users who connect Strava don't also need a direct Garmin/Polar/COROS integration for activities. They only need a direct wearable integration for physiology data (sleep, HRV, resting HR) which Strava does not provide.

**Gap**: Strava does not expose sleep, HRV, resting HR, or VO2max. Those come from the wearable's own API or from HealthKit/Health Connect.

**Action**: No new code needed. Document the recommended setup: "Connect Strava for workouts. Connect your wearable (or HealthKit/Health Connect) for recovery data."

---

### Tier 2: Recovery-Only Integrations (high value for readiness model)

#### 2A. Whoop

**Value**: Best-in-class recovery score, HRV, sleep quality. Many serious runners wear Whoop alongside a GPS watch. Whoop fills the physiology channel, not the activity channel.

**API**: REST API v2, OAuth 2.0. Webhook support for recovery, sleep, workout events.

**What we'd get**:

| Data | Whoop endpoint | Maps to |
|------|---------------|---------|
| Recovery score | `GET /v1/recovery` | Could inform readiness (0-100 scale) |
| HRV (rMSSD) | In recovery payload | `PhysiologyDayEntry.hrvRmssd` |
| Resting HR | In recovery payload | `PhysiologyDayEntry.restingHR` |
| Sleep stages | `GET /v1/sleep` | `sleepDeepSec`, `sleepRemSec`, `sleepLightSec`, `sleepAwakeSec` |
| Sleep performance % | In sleep payload | `PhysiologyDayEntry.sleepScore` (map 0-100) |
| Skin temperature | In recovery payload | Could feed illness/overtraining detection |
| Workout strain | `GET /v1/workout` | Advisory only (no HR stream, can't compute iTRIMP) |

**What we don't get**: No HR stream during workouts. No GPS. No per-second data. Whoop users need Strava (or phone GPS) for workout data.

**Implementation**:

1. **New edge function**: `sync-whoop-physiology/index.ts`
   - OAuth 2.0 token management (store in `wearable_tokens` table)
   - Fetch recovery + sleep for last N days
   - Convert to `PhysiologyDayEntry[]`
   - Return to client

2. **Webhook handler**: `whoop-webhook/index.ts`
   - Receive recovery/sleep/workout events
   - Upsert into `daily_metrics` and `sleep_summaries` (same tables as Garmin)
   - The existing `sync-physiology-snapshot` edge function reads these tables agnostically, so no changes needed downstream.

3. **Token table**: Extend existing token storage or create `wearable_tokens` table:
   ```sql
   create table wearable_tokens (
     user_id uuid references auth.users(id),
     provider text not null,  -- 'whoop', 'oura', 'polar', 'fitbit'
     access_token text not null,
     refresh_token text,
     expires_at timestamptz,
     scopes text[],
     created_at timestamptz default now(),
     primary key (user_id, provider)
   );
   ```

4. **Wizard update**: Add "Whoop" to wearable selection step. Set `s.wearable = 'whoop'`.

**Risks**:
- Whoop requires active subscription. If subscription lapses, API returns no data. App must handle gracefully.
- Whoop's recovery score is proprietary. We can use their HRV/resting HR directly but should not display "Whoop Recovery: 87%" (trademark). Use the raw inputs for our own readiness calculation.
- No workout HR means Whoop-only users have no TSS. They need a second device for workouts (Strava, phone GPS, or Apple Watch).
- Rate limits not well-documented. Implement exponential backoff.

**Effort**: Edge function ~200 lines. Webhook handler ~150 lines. Token management ~100 lines (shared with Oura/Polar/Fitbit). Client sync function ~100 lines. Total: ~4-5 days.

#### 2B. Oura Ring

**Value**: Gold-standard sleep data. Many runners wear an Oura ring overnight and a watch during workouts. Fills the same niche as Whoop (physiology channel only) but with better sleep epoch granularity.

**API**: REST API v2, OAuth 2.0. Webhooks available.

**What we'd get**:

| Data | Oura endpoint | Maps to |
|------|--------------|---------|
| Sleep stages | `GET /v2/usercollection/sleep` | 5-minute epoch granularity: `sleepDeepSec`, `sleepRemSec`, `sleepLightSec`, `sleepAwakeSec` |
| Sleep score | In sleep payload | `PhysiologyDayEntry.sleepScore` |
| HRV (rMSSD) | `GET /v2/usercollection/heartrate` (nighttime) | `PhysiologyDayEntry.hrvRmssd` |
| Readiness score | `GET /v2/usercollection/daily_readiness` | Could inform readiness model (0-100) |
| Resting HR | In readiness payload | `PhysiologyDayEntry.restingHR` |
| Temperature deviation | In readiness payload | New field: `temperatureDelta` for illness detection |
| SpO2 | `GET /v2/usercollection/daily_spo2` | New field: `spo2` (Gen 3 only) |

**Implementation**: Near-identical to Whoop. Same edge function pattern, same webhook handler pattern, same `wearable_tokens` table.

**Unique considerations**:
- Temperature deviation is relative to personal baseline (takes ~2 weeks to establish). Store raw delta, not absolute.
- Oura readiness score incorporates sleep balance (multi-day trend), which our readiness model also does. Could use as a cross-validation signal or as a direct input.
- Sleep data latency is 1-2 hours after waking. The sleep poller pattern (existing for Garmin) applies here.

**Risks**:
- Gen 2 vs Gen 3 have different capabilities. SpO2 is Gen 3 only. API handles this (returns null for unsupported fields).
- Oura's workout detection is rudimentary. Not useful for our activity channel.
- Like Whoop, Oura-only users need a second source for workout data.

**Effort**: ~3-4 days (faster than Whoop due to shared token/webhook infrastructure).

---

### Tier 3: Full Activity + Physiology Integrations

#### 3A. Health Connect (Android)

**Value**: Single integration covers Samsung Galaxy Watch, Fitbit (on Android), Garmin (on Android), Google Pixel Watch, Xiaomi, Amazfit, and any other Android wearable that writes to Health Connect.

**API**: On-device Android API (like HealthKit for iOS). Part of Android 14+, backported to Android 9+ via Google Play services.

**What we'd get**:

| Data | Health Connect type | Maps to |
|------|-------------------|---------|
| Workout sessions | `ExerciseSessionRecord` | `GarminActivityRow` |
| HR samples | `HeartRateRecord` | `avg_hr`, `max_hr`, `iTrimp`, `hrZones` |
| Sleep stages | `SleepSessionRecord` | `PhysiologyDayEntry.sleepDeepSec` etc. |
| HRV | `HeartRateVariabilityRmssdRecord` | `PhysiologyDayEntry.hrvRmssd` |
| Resting HR | `RestingHeartRateRecord` | `PhysiologyDayEntry.restingHR` |
| VO2max | `Vo2MaxRecord` | `s.vo2` |
| Steps | `StepsRecord` | `PhysiologyDayEntry.steps` |
| SpO2 | `OxygenSaturationRecord` | Optional |
| Distance | `DistanceRecord` | Per-workout distance |

**Implementation**:

1. **Capacitor plugin for Health Connect**: Use `capacitor-health-connect` community plugin or write a thin wrapper. The plugin needs to:
   - Request permissions (similar to HealthKit)
   - Query exercise sessions with associated HR samples
   - Query sleep sessions with stage breakdowns
   - Query daily aggregates (resting HR, HRV, steps)

2. **Sync functions**: Mirror the Apple Health pattern:
   - `syncHealthConnectActivities()` (workouts + HR)
   - `syncHealthConnectPhysiology()` (sleep, HRV, resting HR)

3. **Platform branching in main.ts**:
   ```typescript
   if (isNativeiOS()) {
     syncAppleHealth();
     syncAppleHealthPhysiology();
   } else if (isNativeAndroid()) {
     syncHealthConnect();
     syncHealthConnectPhysiology();
   }
   ```

**Risks**:
- Health Connect is relatively new. Some older Android devices may not support it.
- Data quality varies by source device. A cheap fitness band may report HR at 1-minute intervals vs. 1-second from a Galaxy Watch.
- The Capacitor plugin ecosystem for Health Connect is less mature than HealthKit. May need contributions.
- No background observer equivalent. Polling on app launch is the primary sync pattern.
- Health Connect does not expose proprietary metrics (Garmin Training Effect, Samsung VO2max confidence, etc.).

**Effort**: ~1-2 weeks including plugin work.

#### 3B. Polar AccessLink

**Value**: Polar watches have excellent optical HR and their own running power algorithm. Users who don't sync Polar to Strava would need this.

**API**: REST, OAuth 2.0. Transaction-based pull model.

**What we'd get**: Full workout data with 1-second HR, sleep stages, Nightly Recharge (HRV-based recovery), running index (VO2max proxy), training load.

**Implementation**:

1. **Edge function**: `sync-polar/index.ts`
   - OAuth 2.0 token management (shared `wearable_tokens` table)
   - Transaction-based fetch: create transaction, list available data, pull each item, commit
   - Convert workouts to `GarminActivityRow[]` (HR stream, GPS route, splits)
   - Convert sleep/recovery to `PhysiologyDayEntry[]`

2. **Webhook-like notifications**: Register for data-available notifications. When notified, trigger a pull.

**Unique considerations**:
- Transaction model means data can only be fetched once per transaction. Must handle failures gracefully (don't commit until data is stored).
- Polar's "Running Index" is their VO2max proxy but uses a different scale. Need a mapping function or use it as a relative trend only.
- Polar Training Load is conceptually similar to TSS but uses a different formula. Don't mix with our iTRIMP-based TSS.

**Risks**:
- Transaction model is unusual and error-prone. A failed commit leaves data stuck.
- If user also syncs Polar to Strava, activities will be duplicated. Dedup by 2-minute window on start time.
- Polar's API has not evolved quickly. Some endpoints feel dated.

**Effort**: ~1 week.

#### 3C. Fitbit Web API

**Value**: Large installed base. Good sleep data, decent HR.

**API**: REST, OAuth 2.0. Webhooks via subscription API.

**What we'd get**: Workouts with HR zones, sleep stages (30-second epochs), HRV (nightly rMSSD), SpO2, steps, Active Zone Minutes.

**Implementation**: Same edge function + webhook pattern as Whoop/Oura.

**Risks**:
- **Deprecation risk is real.** Google is consolidating health APIs. The Fitbit Web API may be sunset in favor of Health Connect (Android) and a future Google Health API. Do not invest heavily here.
- Intraday HR (1-second) requires special API access approval for multi-user apps. Standard access gives 1-minute resolution, which is too coarse for accurate iTRIMP.
- 150 API calls/hour/user rate limit is the tightest of all platforms.
- For Android Fitbit users, Health Connect is likely the better path (avoids API deprecation and rate limit issues).

**Recommendation**: Deprioritize. Fitbit users on iOS can sync Fitbit to Apple HealthKit (Fitbit app writes sleep + HR to HealthKit). Fitbit users on Android are covered by Health Connect. A direct Fitbit API integration is only needed if neither path gives sufficient HR granularity.

**Effort**: ~1 week, but with ongoing maintenance risk.

---

### Tier 4: Phone-Only Users (No Wearable)

#### The Problem

Phone-only users have:
- GPS (pace, distance, route)
- Accelerometer (step count, cadence estimate)
- No HR during workouts
- No sleep data
- No HRV
- No resting HR
- No VO2max estimate

Without HR, we cannot compute iTRIMP, HR zones, or TSS using our current model. Without sleep/HRV, the readiness model has no inputs.

#### The Solution: RPE-Based Load Model

For users without HR data, use a parallel load model based on:

1. **Pace-based intensity estimation**:
   - If user has entered a recent race time or target marathon time, derive VDOT and pace zones.
   - Classify workout intensity by actual pace vs. pace zones (easy pace = Z1-Z2, tempo pace = Z3, interval pace = Z4-Z5).
   - Estimate TSS from pace zone + duration using lookup tables (similar to how TrainingPeaks estimates TSS from pace).

2. **RPE (Rate of Perceived Effort)**:
   - After each run, prompt for RPE on a 1-10 scale.
   - Map RPE to an intensity multiplier: RPE 3-4 = easy (TSS ~50/hr), RPE 5-6 = moderate (~70/hr), RPE 7-8 = hard (~90/hr), RPE 9-10 = max (~110/hr).
   - Combined with duration, this gives a reasonable TSS estimate.

3. **Session RPE (sRPE) formula**:
   - `sRPE_load = RPE * duration_minutes`
   - This is a validated training load metric used in sports science (Foster et al., 2001).
   - Convert to TSS-equivalent: `estimated_TSS = sRPE_load * conversion_factor` (factor TBD from literature, need to calibrate).

4. **Readiness without biometrics**:
   - No sleep or HRV data means readiness model runs on load data only.
   - Use ACWR (acute:chronic workload ratio) as the primary readiness signal.
   - Add subjective inputs: pre-run "How do you feel?" (1-5 scale), sleep hours (manual entry), perceived sleep quality.
   - These are less precise but better than nothing.

5. **GPS-derived metrics**:
   - Pace variability (CV of km splits) as a fatigue indicator.
   - Pace drift (second-half pace vs. first-half) as an aerobic fitness proxy.
   - Cadence from accelerometer (if phone is on body).

#### Phone GPS Recording

The app already has GPS recording (`src/gps/recording-handler.ts`). For phone-only users:
- GPS recording is the primary workout capture method.
- Post-run: show pace chart, splits, route map, and RPE prompt.
- No HR overlay (obviously).
- Estimated TSS shown with a "estimated" badge to distinguish from HR-derived TSS.

#### UX Flow for Phone-Only

```
Wizard step: "Do you use a smartwatch?"
  → "No, I'll track with my phone"
    → Skip wearable connection
    → Show: "We'll use GPS pace and your feedback to estimate training load.
             For best results, enter a recent race time so we can set your pace zones."
    → Optional: manual entry of resting HR (morning pulse check)
    → Enable RPE prompt after each recorded run
```

**Risks**:
- TSS estimates from pace/RPE are less accurate than HR-based. Users may see inconsistent load tracking if they run the same route at different efforts.
- No passive load detection (steps, daily activity) without wearable.
- Manual sleep entry has low compliance. Most users will skip it after a few days.
- Phone battery drain during GPS recording is significant. Need to warn users.

**Effort**: RPE prompt + pace-based TSS estimation ~3-4 days. Manual sleep/readiness inputs ~2 days. Total: ~1 week.

---

## Data Deduplication Strategy

With multiple sources feeding the same pipeline, dedup is critical.

### Activity Dedup

**Current approach**: 2-minute window on `start_time`, prefer the source with iTRIMP.

**With multiple sources active**, a user could have the same run from:
- Strava (via Garmin auto-sync)
- Garmin webhook (direct push)
- HealthKit (Garmin app writes to HealthKit)
- Health Connect (Garmin app writes to Health Connect)

**Extended dedup rules**:

1. **Primary key**: `start_time` rounded to nearest minute + `activity_type` + `duration` within 20% tolerance.
2. **Source priority** (highest to lowest):
   - Strava (best HR stream quality, user-edited metadata)
   - Garmin direct (webhook, next-best HR)
   - Polar direct (API, 1s HR)
   - HealthKit / Health Connect (variable HR quality)
   - Phone GPS (no HR)
3. **Merge, don't replace**: If HealthKit has GPS route but Strava has HR stream, merge them.
4. **Dedup window**: 5-minute window on start time (some platforms round timestamps differently).
5. **User override**: If user manually matches an activity to a workout, that match is final regardless of later sync from another source.

### Physiology Dedup

**Physiology is per-day, per-field.** Different sources may provide different fields for the same day:

| Field | Best source | Fallback |
|-------|------------|----------|
| `restingHR` | Garmin (sleep-measured) | Oura, Whoop, HealthKit, manual |
| `hrvRmssd` | Oura (5-min sleep epochs) | Whoop (sleep-measured), Garmin, HealthKit |
| `sleepScore` | Garmin/Oura/Whoop (native score) | Computed from stages |
| `sleepStages` | Oura (5-min epochs) | Garmin, Whoop, HealthKit, Fitbit |
| `vo2max` | Garmin (direct measurement) | Apple (GPS-run estimate), Polar (Running Index) |
| `skinTemp` | Oura (delta from baseline) | Whoop |
| `spo2` | Oura Gen 3, Fitbit | HealthKit |

**Merge strategy**: For each day, take the best available value for each field. Store `source` alongside each field so the user knows where data came from. Prefer the source that's been most consistent (has the longest streak of daily data).

---

## Unified Token Management

### Database Schema

```sql
-- Replaces per-provider token columns with a generic table
create table wearable_tokens (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) not null,
  provider text not null,  -- 'strava', 'garmin', 'whoop', 'oura', 'polar', 'fitbit'
  access_token text not null,
  refresh_token text,
  token_type text default 'Bearer',
  expires_at timestamptz,
  scopes text[],
  provider_user_id text,  -- their user ID on the platform
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);

-- Index for webhook resolution (look up user by provider + provider_user_id)
create index idx_wearable_tokens_provider_user
  on wearable_tokens(provider, provider_user_id);
```

### Token Refresh

All OAuth 2.0 providers (Strava, Whoop, Oura, Polar, Fitbit) follow the same refresh pattern:

```
edge function receives request
  → read token from wearable_tokens
  → if expired or expires within 60s:
      → POST to provider's /oauth/token with refresh_token
      → update wearable_tokens with new access_token + expires_at
  → proceed with API call
```

Garmin uses OAuth 1.0a (no expiry, no refresh needed). HealthKit and Health Connect are on-device (no tokens stored server-side).

---

## Wizard Flow Update

Current wizard step offers: Garmin | Apple Watch | Strava | No smartwatch

**Updated wizard**:

```
Step: "How do you track your training?"

Option 1: "I use Strava"
  → Connect Strava (OAuth)
  → Then: "Do you wear a device that tracks sleep and recovery?"
    → Garmin → Connect Garmin (existing flow)
    → Whoop → Connect Whoop (OAuth)
    → Oura → Connect Oura (OAuth)
    → Apple Watch → Enable HealthKit (physiology only, activities via Strava)
    → Other / None → Skip (load-only readiness)

Option 2: "Apple Watch" (no Strava)
  → Enable HealthKit (full: activities + physiology)
  → Note: "For best results, use an app that records HR during workouts
           (Apple's built-in Workout app, Nike Run Club, etc.)"

Option 3: "Garmin" (no Strava)
  → Connect Garmin (webhook — existing flow)
  → Activities come via webhook, physiology via webhook

Option 4: "Polar"
  → Connect Polar (OAuth)
  → Activities + physiology via AccessLink

Option 5: "Other watch" (Samsung, COROS, Suunto, Amazfit, etc.)
  → "Connect via Strava" (most other watches auto-sync to Strava)
  → Then ask about recovery device (same as Option 1)
  → Fallback: "Connect via HealthKit" (iOS) or "Connect via Health Connect" (Android)

Option 6: "I'll track with my phone"
  → Enable phone GPS recording
  → Enable RPE prompts
  → Optional: manual resting HR, sleep hours
  → "For recovery insights, consider connecting a sleep tracker later"
```

**State field update**: Extend `wearable` type:
```typescript
wearable?: 'garmin' | 'apple' | 'strava' | 'whoop' | 'oura' | 'polar' | 'fitbit' | 'health_connect' | 'phone';
```

Actually, the architecture supports multiple simultaneous sources. Better to track:
```typescript
connectedSources?: {
  activity: 'strava' | 'garmin' | 'apple' | 'polar' | 'health_connect' | 'phone';
  physiology?: 'garmin' | 'apple' | 'whoop' | 'oura' | 'polar' | 'fitbit' | 'health_connect';
};
```

This makes the data flow explicit: one activity source, one physiology source. The sync logic reads `connectedSources` to determine which sync functions to call.

---

## Platform Coverage Matrix

After all tiers are implemented, this is what users get:

| User setup | Activity source | Physiology source | HR during workouts | Sleep stages | HRV | TSS method |
|-----------|----------------|-------------------|-------------------|-------------|-----|-----------|
| Garmin + Strava | Strava | Garmin webhook | Yes (1s stream) | Yes | Yes | iTRIMP |
| Apple Watch only | HealthKit | HealthKit | Yes (1-5s samples) | Yes (watchOS 9+) | Yes (SDNN) | iTRIMP |
| Apple Watch + Strava | Strava | HealthKit | Yes (Strava stream) | Yes | Yes | iTRIMP |
| Garmin + Whoop | Strava/Garmin | Whoop webhook | Yes | Yes | Yes (rMSSD) | iTRIMP |
| Garmin + Oura | Strava/Garmin | Oura webhook | Yes | Yes (5-min epochs) | Yes (rMSSD) | iTRIMP |
| Polar only | Polar API | Polar API | Yes (1s) | Yes | Yes | iTRIMP |
| Samsung Watch | Health Connect | Health Connect | Yes (variable) | Yes | Varies | iTRIMP |
| COROS/Suunto + Strava | Strava | HealthKit/HC | Yes | Depends on setup | Depends | iTRIMP |
| Fitbit | Health Connect / Fitbit API | Fitbit API / HC | Conditional (1min default) | Yes (30s epochs) | Yes | iTRIMP (degraded) |
| Phone only | Phone GPS | Manual / none | No | Manual hours only | No | Pace + RPE |
| No device at all | Manual entry | Manual | No | No | No | RPE only |

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|-----------|
| **Fitbit API deprecation** | High (lose integration) | Medium (Google transition) | Build Health Connect as primary Android path; Fitbit API as fallback only |
| **HealthKit plugin limitations** | Medium (can't get HR samples) | High (community plugin gaps) | Build custom Capacitor plugin for HealthKit |
| **Whoop subscription lapse** | Low (affects individual users) | Medium | Graceful degradation: fall back to load-only readiness |
| **Duplicate activities from multiple sources** | Medium (inflated TSS) | High (users connect Strava + HealthKit) | 5-minute dedup window + source priority hierarchy |
| **HR quality varies by device** | Medium (inaccurate TSS) | Medium | Quality flag on HR data; warn if wrist HR shows implausible patterns |
| **Phone GPS battery drain** | Low (user inconvenience) | High (physics of GPS) | Warn in wizard; suggest arm band; offer lower-frequency GPS mode |
| **OAuth token expiry during webhook gap** | Medium (missed data) | Low | Automatic refresh on next request; catch-up sync on app open |
| **Oura/Whoop data latency (1-2 hours)** | Low (readiness shown late in morning) | High (by design) | Sleep poller pattern (already built for Garmin); show "updating..." state |
| **User connects wrong source for activity vs physiology** | Medium (missing data) | Medium | Wizard guides explicitly; settings page shows what's connected for each channel |
| **Rate limits (Fitbit 150/hr, others)** | Medium (sync failures) | Medium | Cache aggressively; use webhooks over polling; exponential backoff |
| **Privacy/compliance** | High (legal) | Low if handled | Only request minimum scopes; clear privacy policy per provider; GDPR deletion endpoint |
| **Health Connect Android fragmentation** | Medium | Medium | Minimum Android version gate; clear error message if HC not available |

---

## Implementation Roadmap

### Phase 1: Full Apple HealthKit (2-3 weeks)

**Goal**: Apple Watch users get the same data quality as Garmin users.

1. Build custom Capacitor plugin for HealthKit (Swift)
   - Workout query with HR samples
   - Sleep analysis query (stages)
   - Daily summaries (resting HR, HRV, VO2max)
   - Background observer registration
2. Wire `syncAppleHealthActivities()` with HR stream processing
3. Wire `syncAppleHealthPhysiology()` into physiology pipeline
4. Update wizard to explain what Apple Watch provides
5. Dedup: if user also has Strava, prefer Strava for activities, HealthKit for physiology
6. Test on-device: Apple Watch Series 6+ with watchOS 9+

**Deliverable**: Apple Watch users see HR zones, TSS, sleep insights, readiness, same as Garmin.

### Phase 2: Whoop + Oura (2-3 weeks)

**Goal**: Recovery-focused wearable users get sleep and readiness data.

1. Build shared `wearable_tokens` table and token refresh utility
2. Whoop edge function + webhook handler
3. Oura edge function + webhook handler
4. Wizard update: recovery device selection after activity source
5. Physiology dedup: merge best-available fields per day
6. Test with real accounts (Whoop dev account, Oura personal access token)

**Deliverable**: Whoop and Oura users see sleep insights, HRV trends, readiness scores.

### Phase 3: Health Connect + Phone-Only (2-3 weeks)

**Goal**: Android users and phone-only users can use the app.

1. Capacitor plugin for Health Connect (or extend community plugin)
2. Sync functions for activities + physiology from Health Connect
3. Phone-only: RPE prompt after GPS recordings
4. Phone-only: pace-based TSS estimation
5. Phone-only: manual sleep/readiness inputs
6. Wizard: full device selection flow
7. Test on Android (Samsung Galaxy Watch, Pixel Watch, phone-only)

**Deliverable**: Full Android support. Phone-only users can track with degraded but functional experience.

### Phase 4: Polar + Edge Cases (1-2 weeks)

**Goal**: Cover remaining direct integrations.

1. Polar AccessLink edge function (transaction model)
2. Test dedup when user has Polar + Strava
3. Fitbit: evaluate if Health Connect covers it; build direct API only if needed
4. Settings page: show connected sources, allow switching

**Deliverable**: All major wearable platforms supported.

---

## Database Migration Plan

### New Tables

```sql
-- 1. Generic wearable token storage (replaces Garmin-specific token handling)
create table wearable_tokens (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) not null,
  provider text not null,
  access_token text not null,
  refresh_token text,
  token_type text default 'Bearer',
  expires_at timestamptz,
  scopes text[],
  provider_user_id text,
  metadata jsonb default '{}',  -- provider-specific extras
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);

-- 2. Webhook subscriptions (track what webhooks are active per user)
create table webhook_subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) not null,
  provider text not null,
  webhook_id text,  -- provider's subscription ID
  event_types text[],
  status text default 'active',
  created_at timestamptz default now(),
  unique(user_id, provider)
);
```

### Existing Table Changes

```sql
-- Add source column to daily_metrics (currently implicitly Garmin)
alter table daily_metrics add column source text default 'garmin';

-- Add source column to sleep_summaries
alter table sleep_summaries add column source text default 'garmin';

-- Add source column to garmin_activities (rename table later)
alter table garmin_activities add column source text default 'garmin';
```

### Table Rename (Future)

`garmin_activities` should eventually become `activities`. This is a breaking change that affects edge functions + client code. Do it in a dedicated migration with a view alias for backwards compatibility:

```sql
alter table garmin_activities rename to activities;
create view garmin_activities as select * from activities;  -- backwards compat
```

---

## Testing Strategy

### Unit Tests

- Activity dedup: test 2-source, 3-source, same-activity scenarios
- Physiology merge: test field-level best-source selection
- RPE-to-TSS conversion: test against known sRPE literature values
- Token refresh: test expiry detection + refresh flow

### Integration Tests

- Each provider's edge function with mock API responses
- Webhook handlers with sample payloads (Whoop, Oura, Garmin)
- End-to-end: activity sync from each source through matchAndAutoComplete

### On-Device Tests

- Apple Watch: verify HR sample density, sleep stage availability
- Health Connect: verify Samsung Watch data flows through
- Phone GPS: verify recording + RPE prompt + pace-based TSS

### Manual QA Matrix

| Scenario | Test |
|----------|------|
| Garmin + Strava (existing) | Regression: nothing breaks |
| Apple Watch only | Full journey: workout with HR, sleep, readiness |
| Apple Watch + Strava | Dedup: Strava activity not doubled from HealthKit |
| Whoop + Strava | Recovery data appears, no workout duplication |
| Oura + Strava | Sleep insights populated from Oura, not placeholder |
| Polar only | Activities + physiology from single source |
| Samsung + Health Connect | Workout HR, sleep, daily metrics |
| Phone only | GPS recording, RPE prompt, pace-based load, no HR screens |
| Multi-device switch | User changes from Garmin to Apple Watch mid-plan |
| Source disconnect | User revokes Strava OAuth, app degrades gracefully |

---

## Open Questions (Need Tristan's Input)

1. **Priority**: Is Apple Watch Tier 1 the right first move, or is there a specific platform users are asking for?

2. **Whoop/Oura as physiology-only**: Should the wizard explicitly separate "workout tracking" from "recovery tracking"? Or is that too confusing for casual users?

3. **Phone-only RPE**: Should RPE be a simple 1-10 slider, or map to descriptive labels ("easy conversation pace", "comfortably hard", "race effort")?

4. **Table rename**: `garmin_activities` to `activities` is the right long-term move. Do it now (breaking) or later (with a view alias)?

5. **Fitbit**: Build a direct integration, or rely on HealthKit (iOS) and Health Connect (Android) as proxy paths?

6. **Recovery device stacking**: If someone has both a Garmin watch and an Oura ring, which provides sleep/HRV? Always prefer one, or let user choose?

7. **Free vs. paid**: Are any integrations gated behind a subscription tier, or is everything available to all users?

8. **Android timeline**: Is Android support a near-term goal or a future consideration? This affects whether Health Connect is Tier 3 or gets pushed later.

---

## Review: Gaps Found and Fixes Required

Self-audit of this plan. Issues ranked by severity. Each must be resolved before or during the relevant phase.

### Critical

**C1. `connectedSources` breaks 9+ call sites that branch on `s.wearable`.**
`main.ts`, `account-view.ts`, `main-view.ts`, and the wizard all branch on `s.wearable === 'garmin'` / `'apple'` / `'strava'`. Switching to `connectedSources` without a migration path breaks them all.
**Fix**: Introduce a backwards-compatible accessor function:
```typescript
function getActivitySource(s: SimulatorState): string {
  return s.connectedSources?.activity ?? s.wearable ?? 'strava';
}
function getPhysiologySource(s: SimulatorState): string | undefined {
  return s.connectedSources?.physiology ?? (s.wearable === 'garmin' ? 'garmin' : s.wearable === 'apple' ? 'apple' : undefined);
}
```
Migrate call sites to use these accessors. Keep `wearable` field readable for old state migration. Remove `wearable` in a later release once all users have upgraded.

**C2. `connectedSources` is single-source but the doc describes multi-source merges.**
A user with Garmin webhook + Strava + HealthKit all active is realistic. The model should support multiple simultaneous sources.
**Fix**: Change to:
```typescript
connectedSources?: {
  activity: string[];    // e.g. ['strava', 'apple'] — first is primary
  physiology: string[];  // e.g. ['garmin', 'oura'] — first is primary
};
```
Sync logic iterates all connected sources. Dedup handles overlaps. Primary source gets priority in merge conflicts.

**C3. OAuth tokens stored in plaintext in Supabase.**
If the DB is compromised, all health data tokens are exposed.
**Fix**: Use Supabase Vault (pgcrypto `encrypt`/`decrypt` with a key stored in Supabase secrets, not in the DB). The `wearable_tokens` schema becomes:
```sql
access_token_encrypted bytea not null,  -- encrypted with vault key
refresh_token_encrypted bytea,
```
Edge functions decrypt at runtime using the vault key from environment variables. Never log or return decrypted tokens in API responses.

**C4. No GDPR/health data compliance plan.**
Health data (HR, HRV, sleep) is "special category" data under GDPR Article 9. Storing it without a compliance framework is a legal risk.
**Fix**: Before launching any new integration:
1. **Data Processing Agreements**: required with Whoop, Oura, Polar, Fitbit before production API access.
2. **Right to erasure**: API endpoint that deletes all user data from `daily_metrics`, `sleep_summaries`, `garmin_activities`, `wearable_tokens`, and calls provider APIs to revoke tokens.
3. **Consent records**: store which scopes were granted, when, and from which device. Log in a `consent_log` table.
4. **Data residency**: Supabase project region must be documented. EU users may require EU-hosted instance.
5. **Retention**: define maximum retention period (e.g. 2 years of physiology data, configurable).
6. **Privacy policy**: update to list each provider, what data is collected, and how it's used.

### Important

**I1. HealthKit HR query returns samples from ALL sources.**
If user wears Garmin + Apple Watch, HealthKit returns interleaved HR from both.
**Fix**: Filter by `HKSource` in the query predicate. Only include samples from the Apple Watch source bundle. The custom Capacitor plugin must expose source filtering.

**I2. `HKObserverQuery` background delivery is unreliable.**
Apple aggressively throttles background app refresh. Deliveries may be delayed by hours with no payload.
**Fix**: Primary sync trigger is always app-foreground launch. `HKObserverQuery` is a supplement, not a guarantee. Document this clearly. Don't design flows that depend on background delivery.

**I3. HealthKit silent permission revocation is indistinguishable from "no data".**
App can't tell if user revoked permissions or just hasn't worked out.
**Fix**: Check `HKHealthStore.authorizationStatus(for:)` on each sync. If status changed from `.sharingAuthorized` to `.notDetermined` or `.sharingDenied`, show a UI banner: "HealthKit access was revoked. Tap to reconnect."

**I4. Whoop API requires business partnership for production.**
Dev mode limited to 100 users. Production requires Whoop approval.
**Fix**: Apply for Whoop developer partnership early in Phase 2. Timeline: 2-6 weeks for approval. Plan Phase 2 work assuming approval may delay launch.

**I5. Oura API has 5,000 requests/day app-level rate limit.**
At scale, 28-day history fetch (~3 requests/user/sync) hits this at ~1,600 daily active users.
**Fix**: Use webhooks as primary data path (not polling). Cache aggressively. Only fetch history on first sync or explicit user refresh. Track request count and throttle gracefully.

**I6. Polar transaction lock timeout.**
A crashed edge function leaves the transaction locked for 10 minutes.
**Fix**: Implement transaction timeout handling. If fetch fails, do NOT commit. Wait for auto-expiry (10 min) and retry. Add dead-letter logging for failed transactions.

**I7. Device switch mid-plan is unspecified.**
When a user switches from Garmin to Apple Watch: different HR sensor accuracy changes iTRIMP baseline, CTL history becomes inconsistent, `intensityThresholds` need recalibration.
**Fix**: On device switch:
1. Archive current physiology baseline (snapshot `ctlBaseline`, `signalBBaseline`, `intensityThresholds`).
2. Start a 2-week calibration period where thresholds are rebuilt from new device data.
3. Keep CTL history but flag the transition point so trend charts show the discontinuity.
4. Notify user: "Switching devices. Load metrics will recalibrate over the next 2 weeks."

**I8. RPE-to-TSS conversion factor is "TBD".**
Per CLAUDE.md: "Never invent constants." This blocks phone-only implementation.
**Fix**: This must come from Tristan or literature review before Phase 3 starts. Candidate from Foster et al.: `TSS_equiv = sRPE_load / 10 * (100/60)` where sRPE_load = RPE * duration_min. But this is a literature value, not validated for this app. Flag as a blocker.

**I9. `PhysiologyDayEntry` missing fields for new integrations.**
Need to add: `temperatureDelta?: number`, `spo2?: number`, `source?: string` to the type definition.
**Fix**: Add fields in Phase 2 when Whoop/Oura are implemented. They're optional so no migration needed for existing data.

**I10. Existing Garmin token storage not migrated.**
Garmin uses OAuth 1.0a (`oauth_token` + `oauth_token_secret`), not the `access_token` + `refresh_token` schema.
**Fix**: Add `oauth_token` and `oauth_token_secret` columns to `wearable_tokens`, or use the `metadata jsonb` column for OAuth 1.0a-specific fields. Write a migration that copies existing Garmin tokens to the new table.

### Minor

**M1. Timezone/DST handling.** Sleep data spans midnight differently across providers. Oura/Whoop report in user's local timezone, HealthKit uses UTC.
**Fix**: Normalize all `PhysiologyDayEntry.date` to the calendar date the user woke up on, in their local timezone. Store timezone offset alongside.

**M2. Strava app-level rate limit (100/15min, 1000/day).** At ~100 DAU with 28-day sync, this becomes tight.
**Fix**: Implement request pooling. Batch user syncs. Use webhooks (Strava subscription API) instead of polling for ongoing sync.

**M3. Apple Watch HR sample density varies.** Background HR (no active workout) is every 5-10 minutes, too sparse for iTRIMP.
**Fix**: Define minimum sample density threshold (e.g. 1 sample per 30 seconds). Below this, fall back to avg-HR-based iTRIMP (existing fallback path) or pace-based estimation.

**M4. Health Connect has no background observer.** Android users only get updates on app open.
**Fix**: Document as known limitation. Consider Android WorkManager for periodic sync (every 15 min), but this adds complexity and battery drain. Likely acceptable to sync on app open only.

**M5. Activity merge "merge, don't replace" is underspecified.**
**Fix**: Define field-level merge rules:
- `iTrimp`, `hrZones`, `avg_hr`, `max_hr`: prefer source with highest sample density
- `distance_m`, `avg_pace_sec_km`, `kmSplits`: prefer GPS source (Strava > phone > HealthKit estimated distance)
- `polyline`, `elevationGainM`: prefer Strava (best map data)
- `calories`: prefer HR-based source over estimate-based
- `activity_type`, `start_time`, `duration_sec`: prefer primary source

**M6. Webhook cold start timeouts.** Supabase edge functions have 150ms+ cold start. Some providers timeout webhooks at 5 seconds.
**Fix**: Acknowledge-and-queue pattern. Webhook handler responds 200 immediately after basic validation, stores raw payload in a `webhook_queue` table, and a separate scheduled function processes the queue. This decouples delivery from processing.

**M7. `garmin_activities` rename to `activities`.** View alias only works for SELECT; INSERT/UPDATE via view may fail.
**Fix**: Use an updatable view (`CREATE VIEW ... WITH (security_invoker)` on Postgres 15+) or defer the rename until all edge functions are updated in a single coordinated deploy.

**M8. Missing platforms: Amazfit, Xiaomi, Withings, Huawei.**
- Amazfit/Xiaomi: write to Health Connect (Android) and Strava. Covered by existing paths.
- Withings: has a REST API (OAuth 2.0, webhooks). Good sleep data. Low priority unless user demand.
- Huawei: Health Kit API exists but is China-focused. Most international users sync to Strava. Covered.

---

## Clear Next Steps

1. **Tristan decides priority**: Is Apple Watch Tier 1 the right first move? Answer the 8 open questions above.
2. **GDPR framework**: Before any new integration goes live, the compliance items (C4) must be addressed. This can happen in parallel with Phase 1 development.
3. **Whoop developer application**: Submit early. 2-6 week approval timeline.
4. **RPE-to-TSS conversion factor**: Tristan provides or approves a value from literature before Phase 3.
5. **State migration design**: Finalize `connectedSources` schema and write the accessor functions (C1/C2) before any new provider code ships.
6. **Token encryption**: Implement Supabase Vault encryption before storing any new OAuth tokens (C3).
