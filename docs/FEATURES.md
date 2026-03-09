# Mosaic Features

Plain-English description of every feature, where to find the code, and test status.
Update the status column after running `npx vitest run`.

---

## Fitness Calculations

---

### 1. VDOT Engine
**What it does**: Converts a race time (e.g. 5K in 22:00) into a single fitness number called VDOT. All training paces are derived from this number. Higher VDOT = fitter runner.

`currentVDOT = s.v + sum(wk.wkGain) + s.rpeAdj + (s.physioAdj || 0)`

`physioAdj` is clamped to `Math.max(-5.0, rawAdj)` at all write sites to prevent stale LT data from making VDOT implausibly low. A `vdotHistory` array (last 20 entries, `{week, vdot, date}`) is appended on every VDOT-changing event (RPE rating, LT auto-update, week advance, manual fitness update, benchmark).

**Key files**: `src/calculations/vdot.ts`, `src/ui/events.ts` (physioAdj + vdotHistory), `src/data/physiologySync.ts` (LT sanity check)
**Tests**: `src/calculations/vdot.test.ts` — ✅ Passing

---

### 2. Pace Generator
**What it does**: Turns a VDOT score into five training pace zones: easy, threshold, interval, marathon, and recovery. Every workout description references these paces.

**Key file**: `src/calculations/paces.ts`
**Tests**: `src/calculations/paces.test.ts` — ✅ Passing

---

### 3. Race Time Predictor
**What it does**: Forecasts your finish time for race day based on current fitness, weeks of training remaining, runner type, and historical data. Shows an "initial baseline" and a "live forecast" that updates as you complete workouts.

**Key files**: `src/calculations/predictions.ts`, `src/testing/forecast-matrix.ts`
**Tests**: `src/calculations/predictions.test.ts`, `src/calculations/debug-prediction.test.ts`, `src/calculations/forecast-profiles.test.ts` — ✅ Passing

---

### 4. Training Horizon Model
**What it does**: Limits how fast your VDOT can realistically grow over time — so the app doesn't predict unrealistic improvements. Takes into account your starting fitness, weeks available, and runner type.

**Key file**: `src/calculations/training-horizon.ts`
**Tests**: `src/calculations/training-horizon.test.ts` — ✅ Passing

---

### 5. Fatigue Model
**What it does**: Models accumulated fatigue from training volume. Affects how much fitness gain you get each week — heavy weeks build fitness but also accumulate fatigue that reduces the gain from subsequent weeks.

**Key file**: `src/calculations/fatigue.ts`
**Tests**: `src/calculations/fatigue.test.ts` — ✅ Passing

---

### 6. Physiology Tracker
**What it does**: Tracks your lactate threshold (LT) pace and VO2max over the course of the plan, updating them based on workout feedback. These values feed into more precise pace targets and HR zones.

**Key file**: `src/calculations/physiology-tracker.ts`
**Tests**: `src/calculations/physiology-tracker.test.ts` — ✅ Passing

---

### 7. HR & Efficiency Scoring
**What it does**: When you log a workout with heart rate data, the app cross-checks your RPE (how hard it felt) against your HR to detect whether you're getting fitter, fatigued, or under cardiovascular stress. This nudges your future paces slightly up or down.

**Logic**: Low RPE + Low HR = efficiency signal (paces get a tiny bit faster). Low RPE + High HR = cardiovascular strain (dampens the easy-day signal). High RPE + High HR = struggle (slows future paces). High RPE + Low HR during intervals = central fatigue.

**Key file**: `src/calculations/heart-rate.ts`
**Tests**: `src/calculations/efficiency.test.ts` — ✅ Passing

---

## Training Plan

---

### 8. Plan Generator
**What it does**: Builds the full weekly workout schedule — which runs, at what pace, for how long — based on your training phase (base/build/peak/taper), runs per week, race distance, and runner type.

**Key files**: `src/workouts/generator.ts`, `src/workouts/plan_engine.ts`
**Tests**: `src/workouts/generator.test.ts` — ✅ Passing

---

### 9. Workout Descriptions
**What it does**: Formats each workout into a human-readable description. Interval sessions get multi-line format with warm-up, main set, and cool-down. Easy/long runs get a single-line distance + pace. Descriptions drive load calculation and pace display.

**Key file**: `src/workouts/intent_to_workout.ts`
**Tests**: `src/workouts/parser.test.ts` — ✅ Passing

---

### 10. Workout Scheduler
**What it does**: Assigns each workout to a specific day of the week. Long runs go to Sunday, quality sessions (threshold, VO2) go to Tuesday/Thursday, easy runs fill the gaps. Prevents back-to-back hard days. Users can drag and drop to override.

**Key file**: `src/workouts/scheduler.ts`
**Tests**: `src/workouts/scheduler.test.ts` — ✅ Passing

---

### 11. Workout Load Calculator
**What it does**: Scores each workout with an aerobic and anaerobic load number. These numbers are the "currency" used by the cross-training system to decide how much running a cross-training session can replace.

**Key file**: `src/workouts/load.ts`
**Tests**: `src/workouts/load.test.ts` — ✅ Passing

---

### 12. Workout Parser
**What it does**: Reads a workout description string (e.g. "5×3min @ 3:47/km") and extracts structured data: distance, pace, duration. Used by the load calculator, the cross-training suggester, and the injury system.

**Key file**: `src/workouts/parser.ts`
**Tests**: `src/workouts/parser.test.ts` — ✅ Passing

---

### 13. Commute Runs
**What it does**: Lets you log daily commute runs or cycles. These count toward your weekly load so the plan doesn't overload you on days when you're already moving.

**Key file**: `src/workouts/generator.ts` (commute section)
**Tests**: `src/workouts/commute.test.ts` — ✅ Passing

---

### 14. Gym Integration
**What it does**: Generates running-specific strength sessions alongside your running plan. Templates are phase-aware (heavy lifting in base, explosive in build, maintenance in peak, activation in taper) and adapt to your ability level (beginner/novice/full gym).

**Key file**: `src/workouts/gym.ts`
**Tests**: `src/workouts/gym.test.ts` — ✅ Passing

---

## Injury & Recovery

---

### 15. Injury System
**What it does**: A six-phase clinical recovery system. When you report an injury, the plan shifts to: Acute (complete rest) → Rehab (cross-training only) → Capacity Test (assess readiness) → Return to Run (graduated running) → Graduated Return (2-week bridge) → Resolved (back to full plan). Pain levels you report drive phase transitions — high pain regresses you back.

**Key file**: `src/injury/engine.ts`
**Tests**: `src/injury/engine.test.ts` — ✅ Passing

**Plan tab UI** (in `src/ui/plan-view.ts`):
- Injury header button: circular icon (healthy) or amber "In Recovery" pill (injured) top-right of header
- Full injury banner: gradient accent bar, phase label, pain level (colour-coded), can-run badge, medical disclaimer for return phases, Update / I'm Recovered buttons
- Morning pain check-in: shown once per day; Worse/Same/Better grid with animated in-place feedback
- Capacity test cards: "Had Pain" (red) / "Pain-Free!" (green) grid replaces normal rate/skip buttons on injury test workouts

---

### 16. Recovery Engine
**What it does**: Morning check-in system. Automatically reads Garmin sleep score, HRV (RMSSD → categorical status), and readiness (100 − stress). Falls back to 1–10 manual tap UI if no Garmin data. Scores → traffic light (green/yellow/orange/red). Orange or red triggers workout adjustment modal and inflates ATL for ACWR. One prompt per day (`lastRecoveryPromptDate` guard).

**Key files**: `src/recovery/engine.ts`, `src/data/physiologySync.ts`, `src/main.ts` (orchestration)
**Tests**: `src/recovery/engine.test.ts` — ✅ 17 passing (incl. 2 new `rmssdToHrvStatus` tests)

**Orchestration** (`main.ts → checkRecoveryAndPrompt`):
- After `syncPhysiologySnapshot(7)`: finds today's entry → `buildRecoveryEntryFromPhysio()` → `computeRecoveryStatus()`
- No Garmin data today: shows manual 1–10 check-in
- Orange/red status: sets `wk.recoveryDebt`, pushes to history, shows adjustment modal

**Plan tab UI** (in `src/ui/plan-view.ts`):
- Recovery log modal: 1–10 colour-graded tap buttons (red→green); maps score×10 to sleepScore
- Recovery adjust modal: bottom-sheet offering "Run by feel", "Downgrade to Easy", or "Reduce Distance" with recommended option highlighted

**Home tab UI** (`buildReadinessRing` in `home-view.ts`):
- Training Readiness ring (see §29) replaced `buildSignalBars` — HRV, sleep, and RHR data surface inside the Recovery pill there

**ATL inflation** (`fitness-model.ts`): `recoveryDebt='orange'` → 1.10× ATL; `recoveryDebt='red'` → 1.20× ATL (stacks with `acwrOverridden` 1.15×, takes max)

---

## Cross-Training

---

### 17. Universal Load Model
**What it does**: Converts any cross-training activity (swimming, cycling, rugby, padel, etc.) into a "load" number comparable to running load. Four tiers of accuracy:
- **Tier A+** (iTRIMP, 0.95 confidence): Second-by-second HR stream via Strava API. Uses Individual TRIMP — Banister/Morton model with Heart Rate Reserve fraction and sex-specific β coefficient.
- **Tier A** (Garmin Training Effect, 0.90): Garmin/Firstbeat aerobic + anaerobic effect.
- **Tier B** (HR zones, 0.75–0.80): Time-in-zone TRIMP-like calculation. HR zones now flow from `GarminActivityRow` → `GarminPendingItem` → `CrossActivity` → `ActivityInput` so Tier B is reached when zone data is available.
- **Tier C** (RPE only, 0.45–0.55): Duration × RPE × sport multiplier with uncertainty penalty.

**Impact load**: `computeUniversalLoad()` now returns `impactLoad = durationMin × sport.impactPerMin` (musculoskeletal/leg stress). Separate from cardiovascular FCL. Per-sport values live in `SPORTS_DB.impactPerMin`.

**Workout type classifier (Phase B v3)**: Three exported functions classify a cross-training activity's intensity profile:
- `classifyByITrimp(iTrimp, durationMin, thresholds?)` — normalises iTRIMP → TSS/hr and classifies as easy / threshold / vo2 using configurable thresholds (default: easy < 70, threshold 70–95, vo2 > 95 TSS/hr)
- `classifyByZones(hrZones)` — uses HR zone ratios for steady-state sports (base > 80% → easy; Z3 > 40% → threshold; Z4+Z5 > 30% → vo2)
- `classifyWorkoutType({ sport, durationMin, iTrimp?, hrZones?, thresholds? })` — decision tree: uses iTRIMP for intermittent sports (football, rugby, basketball), high-HR spike activities (>15% Z4+Z5), or short sessions (<20min zone data); uses zone distribution otherwise; falls back to profile. Returns `{ type, tss, runningEquivTSS, method }`.
- Personal intensity thresholds stored at `SimulatorState.intensityThresholds` — automatically calibrated from labelled Strava runs via `calibrateIntensityThresholds()` in `data/stravaSync.ts`. Strava workout names classified by keyword (e.g. "Tempo Run" → tempo zone; "Interval" → interval zone). 90th-percentile TSS/hr per zone, clamped to sane bounds. Requires ≥3 labelled sessions per zone to update from defaults (easy≤70, tempo≤95 TSS/hr). Calibration status shown in Stats → Advanced.

**How to test manually**: Trigger any cross-training popup (e.g. log a 60min football session). The console will show `[CrossTraining] Zone classification: threshold (itrimp) — TSS 84.3, runEquiv 37.9` confirming method and type.

**Key file**: `src/cross-training/universalLoad.ts`, `src/cross-training/universal-load-types.ts`
**Tests**: `src/cross-training/universalLoad.test.ts` (48 tests including 15 classifier-specific), `src/cross-training/activities.test.ts` — ✅ Passing

---

### 18. Cross-Training Suggester
**What it does**: After you log a cross-training activity, the app calculates how much running it can replace and shows you three options: Keep (log it, keep full run plan), Reduce (soften some runs), Replace & Reduce (remove one run entirely, soften others). The suggestions are ordered by how similar the cross-training is to each planned run.

**Runner-type aware reduction**: Speed runners have volume cut first (easy runs before quality downgrades). Endurance/Balanced runners have intensity cut first (quality downgrades before volume). Controlled by `AthleteContext.runnerType`.

**Zone-profile matching (Phase B v3)**: `buildCandidates()` now uses `classifyWorkoutType()` to improve candidate ranking by intensity zone profile. A football session classified as "threshold" will rank your threshold run as a better candidate than your easy run, even if raw load similarity is similar. Scoring: +0.20 for zone profile match, −0.10 for opposite ends (e.g. vo2 activity vs easy run). Falls back to load-only ranking when no iTRIMP or HR data is available.

**Load modal**: Shows runner-type context, equivalent easy km badge, data tier badge ("HR Stream" / "Garmin" / "HR Zones" / "Estimated"), aerobic/anaerobic percentage split, and leg impact label (No / Low / Moderate / High).

**How to test manually**: Log a high-intensity cross-training activity (e.g. 60min interval cycling with HR data). In the suggestion popup, check that the quality run (threshold/VO2) is ranked above easy runs in the candidate list. Console shows `[CrossTraining] Zone classification: ...` and the candidate similarity scores.

**Key files**: `src/cross-training/suggester.ts`, `src/ui/suggestion-modal.ts`
**Tests**: `src/cross-training/suggester.test.ts`, `src/cross-training/universalLoad.test.ts` (classifier tests), `src/cross-training/matcher.test.ts`, `src/cross-training/boxing-bug.test.ts`, `src/cross-training/km-budget.test.ts` — ✅ Passing

---

### 18b. Cross-Training Load Management v2 *(designed 2026-03-04 — not yet built)*

> Replaces the current "overflow → blocking modal" pattern with a tiered,
> baseline-relative, timing-aware system. See PRINCIPLES.md for the "why."

#### Signal B weekly baseline

- New state field: `historicWeeklyRawTSS` — array of weekly raw iTRIMP totals (no runSpec)
  from Strava history. Parallel to existing `historicWeeklyTSS` (Signal A).
- New state field: `signalBBaseline` — 8-week EMA of `historicWeeklyRawTSS`.
- Requires a new edge function query: `sport-history` mode on `sync-strava-activities`.
  Groups `garmin_activities` by week, sums iTRIMP per week without runSpec discount.
- **Fallback until edge function built**: use Signal A weekly total × 1.4 as a proxy
  (rough conversion — understates baseline, so excess warnings will be slightly over-sensitive).
- Excess this week = `currentWeekSignalB − signalBBaseline`.

#### Initialisation load graph

On plan start (or first load with Strava history available), the onboarding or welcome screen
shows an 8-week chart of the athlete's historic Signal B load with:
- A labelled baseline line ("Your usual weekly load: ~85 TSS")
- Sport breakdown annotations (hover/tap for per-sport contribution where data allows)
- Narrative: *"You've been consistently active. Your plan starts here and adds running load
  gradually on top of what you're already doing."*
- If `Signal B CTL / Signal A CTL > 1.5`: *"You have aerobic fitness from cross-training.
  We'll build running specificity carefully to protect your joints."*

**Key file to build**: onboarding or `welcome-back.ts` chart section.

#### Tier 1 — Auto-adjust (≤ 15 TSS excess)

- When a cross-training activity creates ≤ 15 TSS above `signalBBaseline` for the week:
  - Find the nearest **unrated easy run** in the current week
  - Reduce its distance proportionally (Signal A translation: excess TSS → easy km equivalent)
  - Apply as a `workoutMod` silently (no popup)
  - Show an inline note on the activity card: *"Easy run reduced by 1.2km · 18 TSS accounted for"*
  - Tap the note to see details or undo (restores original distance, re-queues as Tier 2)
- If no unrated easy run exists, excess moves to Tier 2 instead.

**Key files to modify**: `src/ui/activity-review.ts` (`autoProcessActivities`),
`src/data/activitySync.ts`, `src/calculations/fitness-model.ts` (TSS delta).

#### Tier 2 — Nudge card (15–40 TSS excess)

- Amber card at top of Training tab: *"32 TSS of cross-training load waiting · Adjust week"*
- Does NOT block or interrupt. Dismissable.
- Tapping opens the existing reduce/replace modal flow (`triggerExcessLoadAdjustment`).
- Card clears once the user adjusts or explicitly dismisses.
- Existing `excess-load-card.ts` is the base for this — needs threshold-relative copy
  and "32 TSS above your baseline" framing instead of raw TSS total.

**Key file**: `src/ui/excess-load-card.ts`.

#### Tier 3 — Blocking modal (ACWR caution/high only)

- Existing behaviour preserved. Fires only when ACWR enters caution or high zone.
- Not triggered by TSS overage alone.
- Existing `suggestion-modal.ts` + ACWR context header untouched.

#### Timing sensitivity: day-proximity → quality session downgrade

- After any activity syncs, run a **proximity check**:
  - For each remaining unrated quality session this week (threshold, VO2, long run):
    - Is there a completed cross-training or run activity with Signal B ≥ 30 TSS
      whose `startTime` is within 1 calendar day of this session's planned day?
    - If yes: apply a `workoutMod` with `status: 'downgraded'`
      - Threshold → Marathon Pace intensity
      - VO2/Interval → Threshold pace intensity
      - Long run → distance reduced by 15% if Signal B ≥ 50 TSS
    - Show explanation on the plan card: *"You trained hard yesterday — adjusted to
      marathon pace. Move this session if you want full intensity."*
  - If the user reschedules the session (moves to a different day): re-run proximity
    check; clear the downgrade if the new day is safe.
- Timing check is **independent** of Tier 1/2/3. Can fire inside baseline.

**Key files to build/modify**: `src/calculations/activity-matcher.ts` or new
`src/cross-training/timing-check.ts`; wired in `activitySync.ts` after match completes.

#### "Adjust Week" card + week-start carry-over

- **During the week**: If unresolved Tier 2 excess or timing downgrades exist, a persistent
  "Adjust Week" button appears on the Training tab (not a card — a button row beneath the
  session list). Taps into the existing reduce/replace flow with combined context.
- **At week start** (week advance): If `prevWk.unspentLoadItems` is non-empty OR
  excess carried from prev week, show a top-of-Training-tab card:
  *"Last week had 28 TSS of unresolved training load. Here's how it affects this week."*
  Card links to Adjust Week flow. Dismissable with one tap.

**Key files**: `src/ui/main-view.ts` (week-start card), `src/state/persistence.ts`
(carry-over already exists — needs copy update).

#### Quality session independence

- If a quality session was missed this week AND Signal B is not elevated:
  show a **separate** quiet flag on the plan view: *"Threshold run not yet done this week."*
- Do NOT credit cross-training surplus toward a missed quality session.
- Do NOT remove a quality session because of cross-training surplus.
- These are two independent signals surfaced separately.

#### Strava sport-history edge function (new)

New mode `sport-history` on `sync-strava-activities`:
- Query `garmin_activities` for all activities since 16w ago
- For each week: sum raw iTRIMP (no runSpec) → `weeklyRawTSS`
- Return: `HistoryRawRow[] = { weekStart: string, rawTSS: number, breakdown: Record<sport, rawTSS> }`
- Client stores `historicWeeklyRawTSS` in state from this response
- Per-sport breakdown stored in `sportBaselineByType` for Phase 2 per-session calibration

**Tests to write**: timing check unit tests; baseline delta computation; Tier 1 auto-apply
distance reduction formula.

**Status**: ❌ Not yet built

---

### 19. Activity Matcher
**What it does**: Matches an incoming activity (from Garmin or manual entry) to the most similar planned run in the current week. Scores matches by day, distance, and type. High-confidence matches auto-complete the planned run; low-confidence matches become ad-hoc entries.

**Key files**: `src/calculations/activity-matcher.ts`, `src/calculations/matching.ts`
**Tests**: `src/calculations/activity-matcher.test.ts` — ✅ Passing

---

## GPS Tracking

---

### 20. GPS Tracker
**What it does**: Live workout recording. State machine: idle → acquiring signal → tracking → paused → stopped. Computes distance in real time using Haversine math, filters GPS jitter, and stores the full route.

**Key files**: `src/gps/tracker.ts`, `src/gps/geo-math.ts`
**Tests**: `src/gps/tracker.test.ts`, `src/gps/geo-math.test.ts` — ✅ Passing

---

### 21. Split Detection
**What it does**: Reads the workout description to build a split scheme — e.g. "8×400m @ 5K pace" becomes 8 target splits of 400m each. The GPS tracker uses this to tell you when you've completed each rep and whether you're on pace.

**Key file**: `src/gps/split-scheme.ts`
**Tests**: `src/gps/split-scheme.test.ts` — ✅ Passing

---

### 22. Recording Persistence
**What it does**: Saves completed GPS recordings to local storage so you can review past runs. Includes the route, split times, pace, and HR data. Manages an index of recordings so old ones can be retrieved.

**Key file**: `src/gps/persistence.ts`
**Tests**: `src/gps/persistence.test.ts` — ✅ Passing

---

### 23. Record Tab — Live Run UI
**What it does**: The Record tab is the purpose-built live running screen. Any "Track Run" button (plan workout cards, Just Run, Record tab Start Run) navigates to this tab and shows a real-time UI that updates every second without full re-renders.

Two layouts based on workout type:
- **Simple** (easy / long / unstructured): large elapsed time, 2×2 grid with distance, current pace, avg pace. Pause + Stop buttons.
- **Structured** (intervals / threshold / progressive): segment flow strip showing ✓ completed, ● current segment with km remaining + target pace, · upcoming. Elapsed, distance, and pace row below. Pause + Stop.

Navigation away from the Record tab (via tab bar) deregisters the tick handler so there are no stale DOM updates.

**Key files**: `src/ui/record-view.ts`, `src/ui/gps-events.ts`
**Tests**: ❌ None (UI-only)

---

## Data & Sync

---

### 23. Wearable Activity Sync & Review (Garmin + Apple Watch + Strava)
**What it does**: On startup, syncs recent workouts and matches them to the current week's planned workouts. Matched activities are auto-completed with a derived RPE. Overflow activities surface for manual plan adjustment.

**Data source strategy** — two separate concerns:
- **Activity source** (what happened): Strava if connected, otherwise Garmin webhook or Apple Watch
- **Biometric source** (physiology — VO2max, LT, HRV, sleep, resting HR): always the wearable (Garmin or Apple Watch), independent of Strava

**Strava path** (`s.stravaConnected`): `syncStravaActivities()` → `sync-strava-activities` Edge Function. Fetches activity list + full HR streams; computes iTRIMP. Activity IDs namespaced as `"strava-{id}"`. Garmin users who also have Strava use this path for activities AND get a Garmin physiology sync in parallel.

**Garmin-only path** (`!s.stravaConnected`, `s.wearable === 'garmin'`): `syncActivities()` → `sync-activities` Edge Function (28-day lookback). Activities arrive via Garmin Health API webhook → Supabase `garmin_activities` table.

**Apple Watch path**: `syncAppleHealth()` → `@capgo/capacitor-health` → `Health.queryWorkouts()` on-device (iOS native only; no-op on web). Workout IDs namespaced as `"apple-…"` to prevent dedup collisions.

**Week filtering**: Only activities within the current plan week (`planStartDate + (w-1)*7` to `+7`) are presented. Cross-week bleed from re-syncs is suppressed.

**Choice persistence**: Integrate/Log choices are saved to `wk.garminReviewChoices` on every toggle. Re-opening the review (after refresh or re-review) restores previous choices automatically.

**Auto-process (≤2 activities, all same-day)**: Silently slot-matches each activity; shows an assignment toast at the bottom summarising what went where. Overflow items are added to `wk.unspentLoadItems` and the suggestion modal fires. On modal dismiss, the Excess Load Card lets the user adjust the plan later.

**Review flow (≥3 activities or any >24h old)**: Activities listed by date in the Review Screen with "Week N of T · Mon DD – Sun DD" header. Each item has Integrate / Log Only toggle. On Apply with ≥2 integrate choices, the **Matching Screen** appears.

**Matching Screen** (`src/ui/matching-screen.ts`): tap-to-assign full-screen UI.
- Slot cards ordered Mon→Sun; show actual date ("Mon 23 Feb"). Week header shows "Week 4 of 10 · Mon 17 – Sun 23 Feb".
- Activity tray sorted runs → gym → cross/other. Only unassigned integrate items shown; log-only hidden.
- Assigned activities vanish from tray; tapping an occupied slot swaps the old activity back.
- Bucket contents (Excess Load, Log Only) shown as chips. Tap × to return an activity to the tray.
- Confirm returns confirmed matchings + bucket items to `applyReview`.

**Excess Load Card** (`src/ui/excess-load-card.ts`): always visible on the Training tab. Empty state shows "No overflow" placeholder. When `wk.unspentLoadItems` is non-empty, shows amber card with aerobic/anaerobic bars, [Adjust Plan] (fires reduce/replace modal), and [Dismiss] (two-tap). Tap body for item-by-item popup.

**UnspentLoadItem** (`src/types/state.ts`): `garminId`, `displayName`, `sport`, `durationMin`, `aerobic`, `anaerobic`, `date`, `reason`.

**Garmin token refresh**: `isGarminConnected()` checks `expires_at` from `garmin_tokens`. If expired, calls `refreshGarminToken()` → `garmin-refresh-token` edge function → Garmin OAuth2 refresh_token flow. Account page shows "Connected · Last sync: [date]" when healthy, "Token expired" when refresh fails. Webhook handlers (`handleDailies`, `handleSleeps`) log successful upserts.

**Key files**: `src/data/activitySync.ts`, `src/data/stravaSync.ts`, `src/data/supabaseClient.ts`, `src/calculations/activity-matcher.ts`, `src/ui/activity-review.ts`, `src/ui/matching-screen.ts`, `src/ui/excess-load-card.ts`, `src/ui/toast.ts`, `supabase/functions/garmin-refresh-token/index.ts`
**Tests**: `src/calculations/activity-matcher.test.ts` — ✅ Passing

---

### 24. Strava Integration + iTRIMP Training Load
**What it does**: Connects Strava to fetch second-by-second HR data for all activities. Computes iTRIMP (Individual TRIMP) using the Banister/Morton Heart Rate Reserve model, which is far more accurate than a single average HR for variable-intensity activities (padel, cycling, rugby, etc.). When Strava is connected it becomes the **primary activity source** for all users — including those who also have a Garmin wearable.

**Single mode** (`s.stravaConnected`): activities + full HR streams sync directly into the standard matching pipeline. Garmin/Apple wearable continues providing biometrics (VO2max, LT, HRV, sleep) in parallel via `syncPhysiologySnapshot()`.

**iTRIMP formula** (`src/calculations/trimp.ts`):
- Three fallback tiers: HR stream (1-sec) → lap avgHR → summary avgHR
- β = 1.92 (male/unknown) | 1.67 (female) — set in onboarding physiology step and Account tab

**iTRIMP plumbing** (end-to-end):
- `GarminActivityRow.iTrimp` → `GarminPendingItem.iTrimp` → `CrossActivity.iTrimp` → `computeUniversalLoad({ iTrimp })` → Tier A+
- `buildCombinedActivity()` in activity-review.ts sums iTRIMP across all pending items before passing to load calculator
- `crossActivityToInput()` in universal-load-types.ts maps `activity.iTrimp` through to the `ActivityInput`
- `biological_sex` passed to `sync-strava-activities` edge function so iTRIMP uses the correct β

**Onboarding (physiology step)**: Gender selector (Male / Female / Prefer not to say) at the top — labelled "Gender", stored as `onboarding.biologicalSex` / `s.biologicalSex`. All users (regardless of device) see a "Connect Strava (optional)" section after the HR fields — shows connected badge or Connect button. Strava is presented here rather than on the device step because it is an app, not a device.

**Account tab**: Strava card with Connect / Disconnect / Sync HR buttons. "Biological sex" selector (male / female / prefer not to say) for β coefficient selection. "Change" button next to Runner Type label → `showRunnerTypeModal()` bottom-sheet picker (Speed/Balanced/Endurance with descriptions; confirms before rebuilding plan when training is already underway; shows spinner overlay during rebuild via `initializeSimulator()`).

**Key files**: `src/calculations/trimp.ts`, `src/data/stravaSync.ts`, `supabase/functions/strava-auth-start/`, `supabase/functions/strava-auth-callback/`, `supabase/functions/sync-strava-activities/`
**Tests**: `src/calculations/trimp.test.ts` — ✅ Passing (20 tests)

---

### 24. Continuous Mode
**What it does**: For runners who aren't training toward a specific race. Instead of a fixed plan ending on race day, the app cycles through repeating 4-week blocks (base → build → intensify → deload). Optional benchmark check-ins at the end of each block measure progress.

**Key files**: `src/workouts/plan_engine.ts` (block cycling), `src/state/initialization.ts`
**Tests**: `src/ui/continuous-mode.test.ts` — ✅ Passing

**Benchmark check-in UI** (in `src/ui/plan-view.ts`): Shown on benchmark weeks for continuous mode users. Three states: pending (option picker + Garmin auto-detect), recorded (result + source badge), skipped. Manual entry modal (bottom-sheet) handles pace input (easy/threshold), distance (speed check), or distance+time (race simulation).

---

### 25. State Persistence
**What it does**: Saves and restores the entire app state (your plan, ratings, injury history, settings) to the device's local storage. Includes schema migrations so old saved states upgrade cleanly when the app updates.

**Key file**: `src/state/persistence.ts`
**Tests**: `src/state/persistence.test.ts` — ✅ Passing

---

### 26. Missed Week Detection + Week-End Debrief
**What it does**: On app open after a missed week, `detectMissedWeeks()` silently applies VDOT detraining and advances the plan pointer (no modal). At week end, a focused debrief sheet fires (once per week, guarded by `lastDebriefWeek`):
- Phase badge + "Week N complete"
- Training load % vs planned, distance km, Running Fitness delta (CTL ↑/→/↓)
- If effort score significantly high/low: offers one pacing adjustment toggle (applies ±rpeAdj, capped at ±0.5 VDOT)
- Next week preview (phase + planned TSS)

Two trigger paths: user taps "Finish week" in the plan page current week header, or auto-trigger on app open after week advance.

**Key files**: `src/ui/week-debrief.ts`, `src/ui/welcome-back.ts` (state logic only), `src/main.ts`
**Tests**: ⚠️ No automated tests

---

### 27. Training Load (TL) + Performance Management Chart (PMC)
**What it does**: Computes Signal A (run-equivalent) and Signal B (raw physiological) TSS per week. Displays CTL/ATL/TSB (fitness/fatigue/form) in the Stats tab. CTL = Signal A (42-day EMA of run-equiv load); ATL = Signal B (7-day EMA of total load including cross-training at full weight). ACWR = Signal B ATL / Signal A CTL — correctly flags cross-training-heavy weeks.

**Three-signal model**:
- **Signal A** (`computeWeekTSS`): run-equivalent TSS with runSpec discount. Used for CTL, replace/reduce decisions, race prediction.
- **Signal B** (`computeWeekRawTSS`): raw physiological TSS, no runSpec discount. Used for ATL, ACWR injury risk, "This Week" load card.
- **Signal C** (`wk.actualImpactLoad`): musculoskeletal impact. Computed, not yet surfaced in UI.

**Stats Tab** (restructured 2026-03-09):
- Above fold: "Your last 8 weeks" heading + narrative sentence; main chart card with **Load/Distance/Zones tabs** + 8w/16w/Full range tabs; "This Week" card (Signal B % of weekly target) + "Distance" card
- **Running Fitness chart**: green CTL sparkline showing 42-day fitness trend, CTL value + trend arrow (↑/→/↓)
- **Progress card**: Running Fitness (CTL) + VDOT position bars with ⓘ info buttons
- **Recovery card**: Recovery Score position bar (from `computeRecoveryScore()`: HRV 45% / Sleep 35% / RHR 20%, gated on ≥3 days physiology data); clickable sub-bars for Sleep, HRV, Resting HR with 14-day sparklines; then Freshness (TSB) + Short-Term Load (ATL) + Load Safety (ACWR) position bars with ⓘ info buttons
- **"More detail" toggle**: Training bars (Distance vs Plan, Total Load vs Plan), ATL/TSB/ACWR metrics row, ACWR gradient bar, calibration status, plus folded sections: Forecast times, Race Prediction, VDOT & Paces, Recovery & Physiology, Phase Timeline
- **VDOT sparkline**: shows `s.vdotHistory` trend in VDOT & Paces section. Colour-coded change note. Info button explains all VDOT adjustment sources.
- Home sparkline: mini chart below injury risk bar; tap navigates to Stats

**Plan view**: Completed week headers show a muted `XX TSS` badge (Signal A).

**TL per session**:
- Runs (garminActuals): raw iTRIMP → TL (no runSpec) — same for both signals
- Cross-training (adhocWorkouts / unspentLoadItems): Signal A applies `runSpec`; Signal B uses full iTRIMP weight

**Impact Load**: km-based for running (intensity factor: easy=1.0, threshold=1.3, VO2=1.5); duration × `impactPerMin` for cross-training. Stored on `wk.actualImpactLoad` (not yet surfaced).

**Key files**:
- `src/calculations/fitness-model.ts` — `computeWeekTSS()` (Signal A), `computeWeekRawTSS()` (Signal B), `computeFitnessModel()`, `FitnessMetrics`
- `src/constants/sports.ts` — `TL_PER_MIN`, `IMPACT_PER_KM`, `SPORTS_DB` (strength runSpec=0.35)
- `src/ui/stats-view.ts` — `buildLoadHistoryChart()`, `buildRunningFitnessChart()`, `buildProgressCard()`, `buildRecoveryCard()`, `buildMoreDetailSection()`
- `src/calculations/activity-matcher.ts` — accumulates `wk.actualTL` and `wk.actualImpactLoad`
- `src/ui/activity-review.ts` — stores cross-training TL after user approves adjustments

**Tests**: ⚠️ No automated tests yet

---

### 28. ACWR Load Safety (Phase B)
**What it does**: Computes the Acute:Chronic Workload Ratio (ATL ÷ CTL) from weekly TSS history. Shows a colour-coded bar in the Training tab ("Load Safety" row inside "This Week" panel) and a "Reduce this week" button when risk is elevated. Automatically lightens the next week's plan when ACWR is caution or high.

**ACWR bar (Training tab)**:
- Green when ratio ≤ safe upper bound (varies by athlete tier)
- Amber when caution (0–0.2 above safe upper)
- Red when high (>0.2 above safe upper)
- Dashed marker at the tier's safe threshold
- Status text: "Load well-managed (1.1× baseline)" / "Load increasing quickly" / "Load spike detected"
- `[?]` button opens an ACWR info sheet

**Reduce this week button** (caution/high only):
- Opens the suggestion modal with an ACWR context header explaining the spike
- If `unspentLoadItems` exist, builds popup from those; otherwise synthesises from excess TSS
- Context header is collapsible ("See details ▾") and shows zone breakdown

**Plan lightening** (plan_engine.ts):
- `caution`: `maxQuality -= 1` — one quality session becomes easy
- `high`: `maxQuality -= 2` AND long run capped at previous week's distance
- A `weekAdjustmentReason` string is set on intents → surfaced as a banner above workouts

**Athlete tier** (for ACWR safe threshold):
- 5 tiers: beginner (1.2×), recreational (1.3×), trained (1.4×), performance (1.5×), high_volume (1.6×)
- `s.athleteTier` set automatically (currently defaulting to 'recreational'; Phase C will detect from Strava history)
- `s.athleteTierOverride` takes precedence and shows "Manually set" badge on stats page

**Stats page PMC section**: expanded with ACWR ratio (prominent number), colour-coded status, ratio bar, 3-metric grid (CTL/ATL/TSB), athlete tier badge.

**Key files**:
- `src/calculations/fitness-model.ts` — `computeACWR()`, `TIER_ACWR_CONFIG`, `AthleteACWR`, synthetic ATL debt for `acwrOverridden`
- `src/ui/main-view.ts` — `updateACWRBar()`, `updateLightenedWeekBanner()`, `triggerACWRReduction()`, `updateCarryBanner()`, `computeConsecutiveOverrides()`
- `src/ui/suggestion-modal.ts` — `ACWRModalContext`, `CrossTrainingModalContext`, `showSuggestionModal()` (4th+5th param)
- `src/workouts/plan_engine.ts` — `PlanContext.acwrStatus`, quality cap reduction
- `src/workouts/generator.ts` — `generateWeekWorkouts()` acwrStatus param (now wired from renderer)
- `src/ui/renderer.ts` — passes `acwrStatus` to `generateWeekWorkouts` on each render
- `src/ui/events.ts` — zone carry tracking + `weekAdjustmentReason` on week-advance
- `src/types/state.ts` — `Week.carriedTSS`, `Week.acwrOverridden`, `SimulatorState.athleteTier/athleteTierOverride`
- `src/types/activities.ts` — `SportConfig.volumeTransfer`, `SportConfig.intermittent`
- `src/constants/sports.ts` — `volumeTransfer` values for all sports

**Phase B v2 additions (2026-02-26)**:
- `acwrStatus` now wired into renderer — quality sessions reduced when ACWR is elevated
- "Reduce this week" triggers at actual TSS > plan × 1.20 even when ACWR is safe
- "Dismiss" button records `acwrOverridden`; "Keep" in modal also records it
- Escalating risk label (Safe/Moderate/High/VeryHigh/Extreme) based on ACWR + override streak
- Synthetic ATL debt (15%) for overridden weeks — ACWR stays elevated even after load drops
- Zone carry banner (collapsible, CTL-decay weighted) above workouts when prior-week excess > 8 TSS
- TSS bar splits running (blue) + cross-training (purple) with CTL baseline marker
- Running Volume bar shows running km + GPS cross-training km (weighted by `volumeTransfer`)
- `volumeTransfer` and `intermittent` fields added to all sports in `SPORTS_DB`

**Phase B v3 — HR Zone Matching for Replacement Decisions (backend complete 2026-02-27)**:
- `classifyWorkoutType()` wired into `buildCrossTrainingPopup()` — every activity is now classified before candidate scoring
- Zone-profile match now adjusts candidate similarity scores (see Feature #18 above)
- `AthleteContext.intensityThresholds?` added — populated from `s.intensityThresholds` (calibrated via `calibrateIntensityThresholds()` in `stravaSync.ts`)
- UI portion (modal header showing sport info, speed, match quality, km impact) is pending the UX redesign agent — see `docs/specs/LOAD_SYSTEM_SPEC.md §6.5` for the spec and `§12.7` for wiring instructions

**How to test Phase B v3**: Run `npx vitest run src/cross-training/universalLoad.test.ts` — 15 classifier tests at the bottom of the file cover all three classifier functions and the decision tree. For the end-to-end matching, trigger a cross-training popup and read the `[CrossTraining]` console lines.

**Tests**: ⚠️ Phase B/B v2 UI — no automated tests. Phase B v3 classifier — ✅ 15 tests passing (`src/cross-training/universalLoad.test.ts`)

---

### 29. Training Readiness Ring
**What it does**: Composite 0–100 score on the Home page answering "Should I do today's planned workout as-is?" One ring gauge, one label, one sentence. Replaces the old `buildSignalBars()` + `buildSparkline()` on the Home tab.

**Four sub-signals**:
- **Freshness** (35% / 40% without recovery) — TSB. Ranges from Overtrained → Peaked.
- **Load Safety** (30% / 35%) — ACWR. Safe / Moderate Risk / High Risk.
- **Momentum** (15% / 25%) — CTL now vs 4 weeks ago. Rising / Stable / Dropping.
- **Recovery** (20%, greyed out if no watch) — sleep score + HRV RMSSD delta vs personal avg. "Connect watch to unlock."

**Safety floor**: ACWR > 1.5 → score ≤ 39 (Ease Back); ACWR 1.3–1.5 → score ≤ 59 (Manage Load). A good sleep can't override a load spike.

**Score → label**: 80–100 Ready to Push (green) · 60–79 On Track (blue) · 40–59 Manage Load (amber) · 0–39 Ease Back (red)

**Tap behaviour**: First tap expands sub-metric pills. Second tap triggers action — injury modal if injured, ACWR reduction if elevated, or Stats tab if all clear.

**No Jargon Policy**: ATL/CTL/TSB/ACWR never shown in user-facing copy. Info sheets use both: "Running Fitness (CTL)", "Freshness (TSB)", etc.

**Key files**:
- `src/calculations/readiness.ts` — `computeReadiness()`, `readinessColor()`, `drivingSignalLabel()`
- `src/ui/home-view.ts` — `buildReadinessRing()`, ring tap handler

**Tests**: ✅ 26 tests (`src/calculations/readiness.test.ts`) — all edge cases, safety floor, driving signal, recovery integration, deload/taper scenarios.

---

---

## Activity Detail Page

**What it does**: Full-page view for a single synced activity (Garmin or Strava). Shows a stats grid (distance, time, pace, avg HR, max HR, calories), HR zone bars with time breakdown, km splits with pace-coloured bar chart, and an OSM route map (if polyline is available). Accessible from:
- Plan tab → Activity Log rows (plan-matched activities)
- Plan tab → inline actMatchRow on workout cards
- Plan tab → "View full activity →" link in expanded card detail
- Home tab → Recent activity rows (garmin-backed only)

**Key file**: `src/ui/activity-detail.ts`
**Related**: `src/ui/strava-detail.ts` (`drawPolylineOnCanvas` now exported)
**Tests**: ⚠️ No automated tests

---

## Workout Drag-and-Drop (within week)

**What it does**: Workout cards in the Plan tab are draggable. Drag card A onto card B to swap their assigned days for the current week. Day overrides are stored in `wk.workoutMoves` (already typed as `Record<string, number>` on `Week`) and applied when generating the week's workout list. Persists across re-renders; cleared when advancing to a new week.

**Key file**: `src/ui/plan-view.ts` — `wirePlanHandlers` drag-and-drop section; `getPlanHTML` workoutMoves application
**Tests**: ⚠️ No automated tests

---

## Historic Week Editing

**What it does**: Past weeks (before current week) now show an edit button in the header. Tapping a past-week workout card shows Mark Done / Skip buttons so you can retroactively log RPE or mark skips. Watch-synced sessions (Garmin/Strava matched via `garminActuals`) are read-only and display a "Synced from watch/Strava" label instead of action buttons. Activities with a `startTime` are placed in the day column matching when they were actually performed, not the originally planned day.

**Key file**: `src/ui/plan-view.ts` — `buildWorkoutExpandedDetail` (synced guard + past-week actions), `buildWorkoutCards` (effective day placement), `getPlanHTML` (edit button condition)
**Tests**: ⚠️ No automated tests

---

## Maintenance Notes

**How to update this file**:
1. Run `npx vitest run` to see current test status
2. Update any ✅/⚠️/❌ entries that changed
3. Add new features at the bottom of their section when they're built
4. Mark test status as ❌ if tests exist but are failing

**Status key**:
- ✅ Passing — tests exist and pass
- ⚠️ No tests — feature works but is untested automatically
- ❌ Failing — tests exist but are broken (needs fixing)
