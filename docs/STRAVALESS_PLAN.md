# Stravaless Plan

Mosaic's data pipeline must not depend on the Strava API. Strava approval is slow and may never arrive. Garmin auth-tier upgrade is in flight. This doc is the plan for getting full data coverage without either approval, and the additional unlocks once Garmin auth lands.

Last updated: 2026-05-20.

## Status

- ✅ Item 1: HealthKit observer + background delivery (2026-05-20, pending on-device acceptance)
- ✅ Item 3: History depth expansion to 5 years via `syncAppleHealthDeepHistory()` (2026-05-20, pending on-device acceptance)
- ✅ Item 2: Foreground-resume sync hook (2026-05-26, pending on-device acceptance)
- ✅ Item 4: Single-file FIT/GPX/TCX upload (2026-05-26, shipped)
- ⏳ Item 5: Disconnect detection (not started)
- ◐ Item 6: Multi-source dedup priority — Strava-wins is built and active; Apple-vs-Garmin rank deferred (cannot arise under single-source routing, see below)
- ⏳ Item 7: No-device user QA pass (not started)
- ⏸ Item A: Garmin `activityDetails` parser (gated on Garmin higher auth approval)

## Why this exists

Strava is one of three possible activity sources, not a required one. Garmin webhook and Apple HealthKit both carry the same underlying FIT/HKWorkout data that Strava re-serves. Going direct to those sources is usually richer than going via Strava, and removes a third-party approval gate from the critical path.

## Coverage matrix (what the user records on, how the data reaches Mosaic)

| User records on | Primary path | Fallback path | Requires Strava? |
|---|---|---|---|
| Garmin watch | Garmin webhook (post-auth: with `activityDetails`) | HealthKit observer (if Garmin Connect → Apple Health is on) | No |
| Apple Watch | HealthKit observer + background delivery | Manual sync on app open | No |
| iPhone GPS via Strava app | HealthKit observer (if Strava → Apple Health is on) | Archive ZIP upload (desktop) | No |
| Wahoo / Polar / Coros / Suunto | HealthKit observer | Archive ZIP upload | No |
| No device | Manual race PB entry, single-file FIT/GPX upload | RPE-only check-ins | No |

## What is already built

Verified against the codebase 2026-05-20.

**Apple HealthKit (`src/data/appleHealthSync.ts`)**:
- `syncAppleHealth()` runs on launch via `main.ts`. First backfill pulls 364 days of workouts; subsequent launches pull 14 days.
- `enrichWorkoutsWithHR()` queries the HR sample stream inside each workout window and computes avg HR, max HR, iTRIMP, and zone breakdown.
- Workouts feed `matchAndAutoComplete()` (same pipeline as Garmin and Strava).
- `syncAppleVO2()` and `syncAppleCyclingFTP()` pull benchmark samples.
- `syncAppleHealthPhysiology()` pulls sleep, HRV, resting HR, steps (28-day window).
- Workout route polyline reader is built via `HKWorkoutRoute` in the HealthExtras plugin.

**Garmin (`supabase/functions/garmin-webhook/`)**:
- `handleActivities()` writes summary fields only (avg HR, max HR, distance, duration, RPE). No per-second stream.
- `handleActivityDetails()` exists and dumps any received `activityDetails` payload to `activity_details.json_data`. Currently dormant because the current auth tier does not push `activityDetails`.
- `handleDailies()`, `handleHrv()`, `handleUserMetrics()` cover resting HR, HRV, VO2max, lactate threshold.

**Strava (`supabase/functions/sync-strava-activities/`)**:
- Full pipeline exists for when API approval lands. Not currently in critical path.

## Gaps

1. **HealthKit observer / background delivery is not wired.** Apple Watch users only get sync on app launch. A workout finished while the app is closed sits in HealthKit until the next cold start.
2. **Foreground-resume sync is not wired.** Switching apps and coming back does not re-trigger a sync.
3. **Garmin `activityDetails` parser is not written.** Even once auth is upgraded and payloads start arriving, the JSON sample arrays need a parser to populate `garmin_activities.i_trimp` and the zone breakdown from the per-second stream.
4. **No on-demand Garmin FIT fetch.** When `activityDetails` is missing for a row, there is no path to pull the FIT file from the Garmin Activity Files API and parse it.
5. **No single-file FIT/GPX/TCX upload.** A user with a race file from a borrowed device has no path to import it.
6. **No disconnect detection.** A previously active source going silent for a week is not surfaced to the user.
7. **No formal multi-source dedup priority.** Strava-wins is in place (±10 min window). HealthKit needs to be added to the priority chain explicitly.

## What we can ship while waiting for Garmin auth

Ordered by leverage. All independent of Strava and Garmin auth approval.

### 1. HealthKit observer + background delivery (highest leverage) — SHIPPED 2026-05-20

Effort: ~4 hours Swift + ~1 hour JS.

- ✅ `startWorkoutObserver()` / `stopWorkoutObserver()` plugin methods in `HealthExtrasPlugin.swift`.
- ✅ `HKObserverQuery` + `HKAnchoredObjectQuery` with persisted anchor in `UserDefaults`. First-ever start primes the anchor so existing history is not treated as new.
- ✅ `enableBackgroundDelivery(.workoutType, frequency: .immediate)`.
- ✅ `com.apple.developer.healthkit.background-delivery` entitlement added to `App.entitlements`.
- ✅ TS bridge: `startWorkoutObserver()`, `addWorkoutObserverListener()`, `WorkoutDidArriveEvent` type in `src/data/healthExtras.ts`.
- ✅ JS subscription: `subscribeToWorkoutObserver()` in `appleHealthSync.ts` with 5s debounce.
- ✅ Triggered from `main.ts` after first successful `syncAppleHealth()`.
- ⏳ Acceptance test pending on-device build.

Unlocks: full Apple Watch + Strava-to-Health + Garmin-to-Health live sync without any approval.

### 2. Foreground-resume sync hook — SHIPPED 2026-05-26

Effort: ~30 mins.

- ✅ `subscribeToForegroundResume()` in `appleHealthSync.ts` re-triggers `syncAppleHealth()` on foreground if `appleHistoryLastRefreshedAt` is more than 5 minutes ago.
- ✅ Uses the WebView `visibilitychange` event rather than `@capacitor/app` (which is not installed) — avoids a new native plugin + `cap sync`. Adequate because the observer is the primary path and this is insurance.
- ✅ Fixed a latent bug: `appleHistoryLastRefreshedAt` was only stamped on the first backfill, so the throttle had no accurate reference. It is now stamped on every successful incremental sync.
- ✅ Wired in `main.ts` in the apple-source launch branch, alongside `subscribeToWorkoutObserver()`.
- ⏳ Acceptance test pending on-device build: finish a workout while the app is backgrounded with the observer suppressed, reopen after 5+ min, confirm the activity appears.
- Cheap insurance against the case where the observer drops a push.

### 3. Verify and expose history depth in onboarding — SHIPPED 2026-05-20

Effort: ~45 mins.

- ✅ `FIRST_BACKFILL_DAYS = 364` confirmed as the previous ceiling.
- ✅ New `syncAppleHealthDeepHistory()` runs once per install after the standard sync. Walks HealthKit back in 1-year chunks to a 5-year cap, stops on empty chunk. No HR enrichment (52-week window already covers HR metrics). Guarded by new `appleDeepHistoryFetched` state flag.
- ✅ Workouts feed `matchAndAutoComplete()` for PB surfacing.
- ⏳ Acceptance test pending: returning Apple Watch user with 2+ years of HealthKit data sees historic races at onboarding.

### 4. Single-file FIT/GPX/TCX upload (race import path) — SHIPPED 2026-05-26

- ✅ Account > Advanced > "Import activity file" button. Hidden `<input type="file" accept=".fit,.gpx,.tcx">` triggered by bordered pill button.
- ✅ FIT parsed via `fit-file-parser` (npm). GPX and TCX via lightweight pure-regex extractor (no DOMParser — works in Node + browser).
- ✅ `streamsToActivityRow()` in `src/data/fitImport.ts` is the canonical mapping layer. Produces a fully enriched `GarminActivityRow` with iTRIMP, HR zones, polyline, km splits, watts, NP, power curve.
- ✅ Rows use `import-` id prefix. Final step is `matchAndAutoComplete()` — identical to Apple Health / Strava paths.
- ✅ Shared enrichment helpers extracted to `src/data/activityEnrichment.ts`: `computeHREnrichment`, `computePowerStats`, `computeNPAndPowerCurve`, `resolveMaxHR`. Both `appleHealthSync.ts` and `fitImport.ts` use the same algorithms from this module.
- ✅ 28 tests in `src/data/fitImport.test.ts`.
- **Reuse target for item A (Garmin activityDetails)**: parse `activity_details.json_data.samples` into `StreamRecord[]`, build an `ActivitySummary`, call `streamsToActivityRow()`. No new enrichment math needed.
- **Reuse target for item D (Strava archive ZIP)**: FIT files inside the ZIP go through `parseFit()` + `streamsToActivityRow()` directly.
- **Onboarding integration**: `importActivityFile()` is exported and ready. A `// TODO(onboarding)` comment marks the call site in `fitImport.ts`.

### 5. Disconnect detection

Effort: ~2 hours.

- On launch, check the most recent activity timestamp per source. If a previously active source has gone silent for 7+ days, surface a one-line nudge in Account: "Has your watch stopped syncing?"
- Catches the silent churn case where a user changes watches and never reconnects.

### 6. Formalise multi-source dedup priority — PARTIALLY MOOT (reassessed 2026-05-26)

Intended priority: Strava row > Garmin webhook + details > Garmin webhook summary > HealthKit.

- **Strava-wins is already built and active.** `matchAndAutoComplete()` (activity-matcher.ts:489) removes any non-Strava row (including `apple-` prefixed) within a ±10 min / duration-ratio window when a Strava row exists. Apple is correctly suppressed by Strava today.
- **Apple-vs-Garmin rank is deferred and currently cannot arise.** `main.ts` routes each user to a single activity source: the apple-source launch branch runs `syncAppleHealth()` (workouts); the strava/garmin branch runs the Strava + Garmin webhook pipeline. A Garmin user who also connects Apple Health gets only `syncAppleHealthPhysiology()` (sleep/HRV/RHR), not Apple workout rows. So a user never generates both Apple and Garmin activity rows for the same session, and there is nothing to dedup between them.
- **Do not bake a fixed Garmin > Apple rank now.** Until `activityDetails` lands, a Garmin webhook row is summary-only and *thinner* than an Apple Watch native row (which carries the full HR stream, zones, iTRIMP, splits, power). A blanket "Garmin summary beats HealthKit" rule would discard the richer source. If dual-source activity ingestion is ever enabled, resolve by payload richness (prefer the row with iTRIMP / HR zones / power), not by a static source rank.

### 7. No-device-user path verification

Effort: ~2 hours QA pass.

- Walk a user through onboarding with no Garmin, no Apple Watch, no Strava. Confirm manual PB entry + RPE check-ins keep the plan adapting.
- Today this is the only path for a user who finds Mosaic via marketing and has nothing connected. The plan engine must not degrade silently when no `garminActuals` arrive.

## What unlocks when Garmin auth lands

### A. Wire the `activityDetails` parser

Effort: ~2 to 3 hours (was 4-6h; now shorter because item 4 built all the enrichment math).

- Parse `activity_details.json_data.samples` into `StreamRecord[]` (HR, GPS, power, cadence — same shape `fitImport.ts` already uses).
- Build an `ActivitySummary` from the existing `garmin_activities` row (start time, distance, duration, sport type).
- Call `streamsToActivityRow()` from `src/data/fitImport.ts` — all enrichment is already there.
- Backfill `garmin_activities.avg_hr`, `max_hr`, `i_trimp`, `hr_zones`, `polyline`, `kmSplits` from the result.
- Acceptance: pick a Garmin run that exists in both Garmin and Strava. iTRIMP computed from Garmin `activityDetails` matches the Strava-derived value within ~5%.
- Note: the shared enrichment helpers live in `src/data/activityEnrichment.ts` — import from there, not from `fitImport.ts` directly (the latter has file-upload state dependencies).

### B. On-demand Garmin FIT fetch

Effort: ~3 to 4 hours.

- New edge function path: given a `garmin_activities` row missing details, call the Garmin Activity Files API, fetch the FIT, parse it with the same FIT parser as the file-upload path, populate the row.
- Use to reconcile any rows where the webhook never pushed `activityDetails`.

### C. Historic Garmin enrichment

Effort: ~2 hours (once A and B exist).

- Walk historic `garmin_activities` rows that lack per-second HR. Trigger the on-demand FIT fetch for each.
- Bounded by Garmin rate limits. Run as a low-priority backfill job.

## Backstop paths (lower priority)

### D. Strava archive ZIP import (desktop fallback)

Effort: ~2 to 3 days.

- Last-resort path for Strava-only users with no Apple Health and no Garmin. User requests their archive from Strava website, downloads the ZIP, uploads to Mosaic on desktop.
- De-prioritise unless waitlist users tell us they need it. The mobile-first audience for Mosaic mostly has Apple Health.

### E. Strava webhook (if approval ever lands)

Effort: ~1 day.

- Belt-and-braces. Garmin webhook usually beats Strava by a few minutes anyway.
- Becomes useful only for the iPhone-Strava-app user who is not yet writing to Apple Health.

## This week's priorities

Two items have the highest ratio of unlock to effort:

1. **HealthKit observer + background delivery** (~5 hours total). Brings Apple Watch users to Garmin-webhook parity for live sync.
2. **History depth check and expansion** (~1 hour investigation). May reveal that returning Apple Watch users are silently losing years of history at onboarding.

Both ship independent of Garmin auth and Strava approval. The Garmin `activityDetails` parser sits in the queue, ready to wire when auth lands.

## Open questions

- Is there a one-off race-import flow already in onboarding? Worth a grep before building (4).
- What does Garmin's higher auth tier actually unlock beyond `activityDetails`? Sleep stages, body battery, hydration? Worth confirming before scoping post-approval work.
- For the no-device user (path 7 above), how long do they last before the plan engine starts producing low-confidence outputs? May want to surface a "manual log mode" caption rather than silently degrading.
