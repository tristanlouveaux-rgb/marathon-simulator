# Workout → Watch: Structured Workout Push

Push planned workouts from Mosaic to Garmin watches (and later Apple Watch) so users can execute them with live pace/HR targets on the wrist.

---

## Current State

The app generates structured workouts (warm-up, intervals, cool-down) and has a GPS tracker for phone-based recording. Watch integration is **read-only**: activities sync in from Garmin (webhook), Strava (polling), and Apple Health (HealthKit). No workouts are pushed out.

### Existing Infrastructure

| Component | Status | Details |
|---|---|---|
| Garmin OAuth 2.0 PKCE | Built | `garmin-auth-start`, `garmin-auth-callback`, `garmin-refresh-token` edge functions |
| Garmin token storage | Built | `garmin_tokens` table with access/refresh tokens, RLS policies |
| Garmin webhook (inbound) | Built | `garmin-webhook` receives activities, dailies, sleep, HRV |
| SplitScheme parser | Built | `src/gps/split-scheme.ts` parses workout descriptions into structured segments |
| Strava OAuth | Built | Read-only (activities + profile) |
| Apple HealthKit sync | Built | Read workouts + physiology via `@capgo/capacitor-health` |
| Phone GPS tracker | Built | `src/gps/tracker.ts` with native background tracking via Capacitor |

---

## Phase 1: Garmin Workout Push

### Why Garmin First

- OAuth already built, same Bearer token works for Training API
- Garmin has a public Training API for structured workouts
- Core user base skews toward serious runners with Garmin watches
- No native app required, workouts sync via Garmin Connect

### Garmin Training API

**Base URL:** `https://apis.garmin.com/training-api/`

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workout` | Create workout, returns `workoutId` |
| `PUT` | `/workout/{workoutId}` | Update existing workout |
| `DELETE` | `/workout/{workoutId}` | Delete workout |
| `POST` | `/schedule/{workoutId}` | Schedule workout on a date (`{"date":"YYYY-MM-DD"}`) |

**Auth:** Same OAuth2 Bearer token from `garmin_tokens`. No additional token exchange needed.

**Prerequisite:** Enable **"Workout Import"** permission on the consumer key in the Garmin Developer Portal. Existing users may need to re-authorize if new permissions are required.

**Rate limits:**
- Evaluation: 100 calls/min per partner, 200 calls/day per user
- Production: 6,000 calls/min per partner, 6,000 calls/day per user
- Exceeding returns HTTP 429

### Garmin Workout JSON Schema

Full example for a "Threshold 5x5" workout:

```json
{
  "workoutId": null,
  "ownerId": null,
  "workoutName": "Threshold 5×5",
  "description": "1km warm up, 5×5min @ 4:11/km, 1km cool down",
  "sportType": {
    "sportTypeId": 1,
    "sportTypeKey": "running",
    "displayOrder": 1
  },
  "estimatedDurationInSecs": 2700,
  "workoutSegments": [
    {
      "segmentOrder": 1,
      "sportType": {
        "sportTypeId": 1,
        "sportTypeKey": "running",
        "displayOrder": 1
      },
      "workoutSteps": [
        {
          "type": "ExecutableStepDTO",
          "stepOrder": 1,
          "stepType": {
            "stepTypeId": 1,
            "stepTypeKey": "warmup"
          },
          "endCondition": {
            "conditionTypeId": 3,
            "conditionTypeKey": "distance"
          },
          "endConditionValue": 1000,
          "targetType": {
            "workoutTargetTypeId": 6,
            "workoutTargetTypeKey": "speed.zone"
          },
          "targetValueOne": 3.03,
          "targetValueTwo": 3.70
        },
        {
          "type": "RepeatGroupDTO",
          "stepOrder": 2,
          "stepType": {
            "stepTypeId": 6,
            "stepTypeKey": "repeat"
          },
          "numberOfIterations": 5,
          "workoutSteps": [
            {
              "type": "ExecutableStepDTO",
              "stepOrder": 3,
              "stepType": {
                "stepTypeId": 3,
                "stepTypeKey": "interval"
              },
              "endCondition": {
                "conditionTypeId": 2,
                "conditionTypeKey": "time"
              },
              "endConditionValue": 300,
              "targetType": {
                "workoutTargetTypeId": 6,
                "workoutTargetTypeKey": "speed.zone"
              },
              "targetValueOne": 3.77,
              "targetValueTwo": 4.17
            },
            {
              "type": "ExecutableStepDTO",
              "stepOrder": 4,
              "stepType": {
                "stepTypeId": 4,
                "stepTypeKey": "recovery"
              },
              "endCondition": {
                "conditionTypeId": 2,
                "conditionTypeKey": "time"
              },
              "endConditionValue": 60,
              "targetType": {
                "workoutTargetTypeId": 1,
                "workoutTargetTypeKey": "no.target"
              }
            }
          ]
        },
        {
          "type": "ExecutableStepDTO",
          "stepOrder": 5,
          "stepType": {
            "stepTypeId": 2,
            "stepTypeKey": "cooldown"
          },
          "endCondition": {
            "conditionTypeId": 3,
            "conditionTypeKey": "distance"
          },
          "endConditionValue": 1000,
          "targetType": {
            "workoutTargetTypeId": 6,
            "workoutTargetTypeKey": "speed.zone"
          },
          "targetValueOne": 3.03,
          "targetValueTwo": 3.70
        }
      ]
    }
  ]
}
```

### Garmin Constants Reference

**Sport types:**

| ID | Key |
|---|---|
| 1 | `running` |

**Step types:**

| ID | Key | Usage |
|---|---|---|
| 1 | `warmup` | Warm-up segments |
| 2 | `cooldown` | Cool-down segments |
| 3 | `interval` | Work / main effort segments |
| 4 | `recovery` | Recovery jog between intervals |
| 5 | `rest` | Standing rest (stationary) |
| 6 | `repeat` | RepeatGroupDTO container |

**End conditions:**

| ID | Key | Value unit |
|---|---|---|
| 1 | `lap.button` | None (press lap to advance) |
| 2 | `time` | Seconds |
| 3 | `distance` | Meters |
| 8 | `fixed.rest` | Seconds |

**Target types:**

| ID | Key | Values |
|---|---|---|
| 1 | `no.target` | None |
| 4 | `heart.rate.zone` | Zone number in `zoneNumber` field |
| 6 | `speed.zone` | `targetValueOne` (slower, m/s), `targetValueTwo` (faster, m/s) |

### Pace Conversion

Garmin uses speed in **meters per second**. The app stores pace as **seconds per km**.

```
speedMps = 1000 / paceSecPerKm
```

For pace targets, apply a +/- 5% tolerance band:
- `targetValueOne` = `1000 / (paceSecPerKm * 1.05)` (slower boundary)
- `targetValueTwo` = `1000 / (paceSecPerKm * 0.95)` (faster boundary)

Important: `targetValueOne` < `targetValueTwo` (lower speed first).

Recovery segments use `no.target` (free jog).

### Workout Type Mapping

How each app workout type maps to Garmin step structure:

| App type (`w.t`) | Garmin structure |
|---|---|
| `easy` | Single `interval` step, distance end condition, easy pace target |
| `long` | Single `interval` step, distance end condition, easy pace target. No per-km splits (50-step limit) |
| `recovery` | Single `interval` step, distance end condition, easy pace target |
| `threshold` (intervals) | `warmup` + `RepeatGroupDTO`(interval + recovery) + `cooldown` |
| `vo2` (intervals) | `warmup` + `RepeatGroupDTO`(interval + recovery) + `cooldown` |
| `tempo` (continuous) | `warmup` + single `interval` step + `cooldown` |
| `marathon_pace` | Single `interval` step, distance or time based, MP pace target |
| `progressive` | Multiple `interval` steps with escalating pace targets |
| `float` (fartlek) | `warmup` + `RepeatGroupDTO`(hard interval + MP recovery) + `cooldown` |

### Repeat Group Detection

When `SplitScheme` segments follow a Rep/Recovery/Rep/Recovery pattern, collapse them into a single `RepeatGroupDTO`:
- `numberOfIterations` = rep count
- Contains one `interval` step + one `recovery` step
- Critical for: (a) staying under the 50-step limit, (b) clean display on the watch

---

## Implementation Plan

### New Files

| File | Purpose |
|---|---|
| `src/garmin/workout-mapper.ts` | Convert SplitScheme + workout metadata to Garmin workout JSON |
| `src/garmin/push-workout.ts` | Client module: call edge function, manage push state |
| `supabase/functions/garmin-push-workout/index.ts` | Edge function: auth, API call, store mapping |
| `supabase/migrations/YYYYMMDD_garmin_pushed_workouts.sql` | DB table for tracking pushed workouts |

### Modified Files

| File | Change |
|---|---|
| `src/ui/plan-view.ts` | Add "Send to Garmin" button per workout + "Send Week" button in header |
| `src/types/state.ts` | Add `garminPushedWorkouts` to `Week` interface |

### Step 1: Mapper (`src/garmin/workout-mapper.ts`)

Converts a `SplitScheme` (from `buildSplitScheme()`) into Garmin workout JSON.

```typescript
interface GarminWorkoutPayload {
  workoutId: null;
  ownerId: null;
  workoutName: string;
  description: string;
  sportType: { sportTypeId: 1; sportTypeKey: 'running'; displayOrder: 1 };
  estimatedDurationInSecs: number;
  workoutSegments: GarminWorkoutSegment[];
}

function buildGarminWorkout(
  workout: { n: string; t: string; d: string },
  paces: Paces,
  splitScheme: SplitScheme
): GarminWorkoutPayload
```

**Segment-to-step classification** uses SplitSegment labels:
- Label contains "Warm" -> `warmup`
- Label contains "Cool" -> `cooldown`
- Label contains "Recovery" -> `recovery`
- Label contains "Rep" (inside a repeat group) -> `interval`
- Everything else -> `interval`

### Step 2: Edge Function (`supabase/functions/garmin-push-workout/`)

**Request body:**

```typescript
interface PushWorkoutRequest {
  garminWorkout: GarminWorkoutPayload;  // pre-built by client mapper
  scheduleDate?: string;                // YYYY-MM-DD
  existingGarminWorkoutId?: string;     // for updates
  appWorkoutId: string;                 // internal workout ID
  workoutHash: string;                  // change detection
}
```

**Flow:**
1. Authenticate user via JWT
2. Read `garmin_tokens` for user, refresh if expired (reuse pattern from `garmin-refresh-token`)
3. POST workout JSON to Garmin Training API
4. If `scheduleDate` provided, POST to `/schedule/{workoutId}`
5. Upsert mapping in `garmin_pushed_workouts` table
6. Return `{ ok: true, garminWorkoutId, scheduled: boolean }`

**Error handling:**
- 401 from Garmin -> refresh token, retry once
- 429 -> return `{ ok: false, error: 'rate_limited', retryAfter }` 
- 400 -> return `{ ok: false, error: 'garmin_rejected', details }`
- Refresh fails -> return `{ ok: false, error: 'auth_expired' }`, client shows "Reconnect Garmin"

### Step 3: Database Migration

```sql
CREATE TABLE garmin_pushed_workouts (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_workout_id    text NOT NULL,
  garmin_workout_id text NOT NULL,
  schedule_date     date,
  workout_hash      text,
  pushed_at         timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX idx_garmin_pushed_user ON garmin_pushed_workouts(user_id);
CREATE INDEX idx_garmin_pushed_app_id ON garmin_pushed_workouts(user_id, app_workout_id);

ALTER TABLE garmin_pushed_workouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_select" ON garmin_pushed_workouts
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "user_insert" ON garmin_pushed_workouts
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_update" ON garmin_pushed_workouts
  FOR UPDATE USING (user_id = auth.uid());
```

### Step 4: Client Module (`src/garmin/push-workout.ts`)

```typescript
// Push a single workout
export async function pushWorkoutToGarmin(
  workout: Workout,
  paces: Paces,
  scheduleDate?: string
): Promise<{ ok: boolean; garminWorkoutId?: string; error?: string }>

// Push all un-pushed run workouts for a week
export async function pushWeekToGarmin(
  workouts: Workout[],
  paces: Paces,
  weekStartDate: string
): Promise<{ ok: boolean; pushed: number; errors: string[] }>

// Hash workout description for change detection
export function getWorkoutHash(workout: Workout): string
```

- Calls `buildSplitScheme()` locally (already exists), then `buildGarminWorkout()`, then `callEdgeFunction('garmin-push-workout', ...)`
- Filters to run types only (no gym, cross, rest)
- Skips workouts already pushed with same hash

### Step 5: UI Integration (`plan-view.ts`)

**Per-workout button** (in expanded detail panel, near the action buttons):
- Watch icon + "Send to Garmin" text
- Only visible when: Garmin connected, workout is a run type, workout not yet completed
- States: idle -> sending (spinner) -> sent ("On your watch", checkmark) -> needs update (hash changed)

**Per-week button** (in week header):
- "Send Week to Garmin" button
- Pushes all pending run workouts with correct schedule dates (`weekStartDate + dayOfWeek`)
- Progress feedback: "Sending 3 of 5..."
- Only visible when Garmin connected and week has un-pushed run workouts

### Step 6: State Tracking

Add to `Week` interface in `src/types/state.ts`:

```typescript
garminPushedWorkouts?: Record<string, {
  garminWorkoutId: string;
  workoutHash: string;
  pushedAt: string;
}>;
```

Allows the UI to know immediately which workouts are pushed without querying the database on every render.

---

## Edge Cases

| Case | Handling |
|---|---|
| Not Garmin-connected | Hide all push UI (`isGarminConnected()` check) |
| Token expired | Edge function refreshes inline, retries once. If refresh fails, return `auth_expired`, client shows "Reconnect Garmin" |
| Workout modified after push | Compare `workoutHash`. Show "Update on Garmin" badge. User triggers resend manually (DELETE old + POST new + schedule) |
| Unparseable workout description | Push as simple single-step run with `lap.button` end condition and full description in `description` field |
| 50-step limit exceeded | Mapper collapses into repeat groups. Long runs use single distance step, not per-km splits |
| Rate limit (429) | Show "Try again in X minutes" with retry-after value |
| Gym / cross-training | Never push. Filter to run types only |
| Duplicate push attempt | Check `garminPushedWorkouts[id]`. Same hash = skip silently. Different hash = treat as update |
| New week generated | Clear previous week's `garminPushedWorkouts`. Optionally prompt "Send workouts to Garmin?" |
| User re-authorizes Garmin | Existing pushed workout IDs may be invalid. Treat as fresh push |

---

## Update and Resend Flow

When a workout changes (ACWR reduction, day move, injury adaptation):

1. Compute new hash from `workout.d + workout.t`
2. Compare against `garminPushedWorkouts[id].workoutHash`
3. If different, show "Update on Garmin" badge on the workout card
4. On user tap: DELETE old Garmin workout -> POST new -> schedule -> update tracking record
5. Never auto-update silently. Users may have manually modified the workout on their Garmin.

---

## Phase 2: Apple Watch (Future)

### Approach: WorkoutKit (iOS 17+ / watchOS 10+)

Apple's WorkoutKit allows creating `CustomWorkout` compositions with interval steps, HR targets, and pace goals. These sync to the Apple Watch Workout app natively.

### What It Requires

| Component | Effort | Details |
|---|---|---|
| Custom Capacitor plugin (Swift) | 1-2 weeks | ~300-500 lines bridging WorkoutKit to TypeScript |
| HealthKit entitlements | 0.5 day | Add `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription` to Info.plist. Add `.entitlements` file with `com.apple.developer.healthkit` |
| Workout mapper | 2-3 days | Convert SplitScheme to WorkoutKit `IntervalBlock` / `WorkoutStep` objects |
| UI integration | 1-2 days | "Send to Apple Watch" button, same pattern as Garmin |

### WorkoutKit Mapping

```swift
// WorkoutKit structure
CustomWorkout(
  activity: .running,
  displayName: "Threshold 5×5",
  warmup: WorkoutStep(.open, goal: .distance(1000, .meters)),
  blocks: [
    IntervalBlock(
      iterations: 5,
      steps: [
        IntervalStep(.work, goal: .time(300, .seconds),
                     alert: .speed(3.77...4.17, unit: .metersPerSecond)),
        IntervalStep(.recovery, goal: .time(60, .seconds))
      ]
    )
  ],
  cooldown: WorkoutStep(.open, goal: .distance(1000, .meters))
)
```

### Differences from Garmin Path

- Requires native Swift code (Capacitor plugin), not just a server-side API call
- WorkoutKit is iOS 17+ only (covers ~85% of active iPhones as of 2026)
- No server-side component needed. Push happens on-device.
- No scheduling API. Workout appears in the Watch Workout app's custom workouts list.
- HealthKit entitlements currently missing from the Xcode project. Need to add before any WorkoutKit work.

### Missing HealthKit Entitlements (Must Fix First)

The current iOS build is missing critical HealthKit configuration:
- `NSHealthShareUsageDescription` not in Info.plist
- `NSHealthUpdateUsageDescription` not in Info.plist
- No `.entitlements` file with `com.apple.developer.healthkit`
- App ID may need HealthKit capability enabled in Apple Developer account

These are needed even for the existing Apple Health sync to work correctly on all devices. Should be fixed regardless of WorkoutKit.

---

## Estimated Timeline

| Phase | Days | Dependencies |
|---|---|---|
| **Garmin Phase 1: Mapper + tests** | 2-3 | None |
| **Garmin Phase 2: Edge function** | 1-2 | Mapper |
| **Garmin Phase 3: DB migration** | 0.5 | None (parallel with Phase 2) |
| **Garmin Phase 4: Client module** | 1-2 | Edge function |
| **Garmin Phase 5: UI integration** | 1-2 | Client module |
| **Garmin Phase 6: E2E test with real watch** | 1 | All above + Workout Import permission enabled |
| **Garmin total** | **~7-10 days** | |
| | | |
| **Apple Watch Phase 1: HealthKit entitlements** | 0.5 | Xcode project access |
| **Apple Watch Phase 2: Capacitor plugin (Swift)** | 5-7 | Entitlements |
| **Apple Watch Phase 3: Mapper + UI** | 3-4 | Plugin |
| **Apple Watch total** | **~9-12 days** | |

---

## References

- [Garmin Connect Developer Program: Training API](https://developer.garmin.com/gc-developer-program/training-api/)
- [Garmin OAuth2 PKCE flow](https://developer.garmin.com/gc-developer-program/oauth2/)
- [python-garminconnect (workout models)](https://github.com/cyberjunky/python-garminconnect)
- [mkuthan/garmin-workouts (reverse-engineered workout format)](https://github.com/mkuthan/garmin-workouts)
- [Apple WorkoutKit documentation](https://developer.apple.com/documentation/workoutkit)
- [Tredict: Garmin Training API integration blog](https://www.tredict.com/blog/garmin_training_api_integration/)
