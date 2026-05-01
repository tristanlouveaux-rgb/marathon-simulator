# Architecture: Mosaic Training Simulator

> Adaptive marathon training plan simulator with injury management, cross-training integration, GPS tracking, and strength training support.
> Built with vanilla TypeScript + Vite, styled with Tailwind, deployed via Capacitor to iOS.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict), ES2020 target |
| Build | Vite 5 |
| Styling | Tailwind CSS 3.4 |
| Mobile | Capacitor 8 (iOS) |
| State | Custom in-memory store → localStorage |
| UI | Vanilla DOM manipulation (no framework) |
| Testing | Vitest 4 |
| GPS | `@transistorsoft/capacitor-background-geolocation` + web fallback |
| Path alias | `@/*` → `src/*` |

**Entry point**: `src/main.ts` → `bootstrap()` → loads state → onboarding wizard or dashboard.

---

## Module Map

| Module | Purpose | Key Files | Key Exports |
|--------|---------|-----------|-------------|
| `state/` | Central store + persistence + plan initialization | `store.ts`, `initialization.ts`, `initialization.triathlon.ts`, `persistence.ts` | `getState()`, `getMutableState()`, `updateState()`, `loadState()`, `saveState()`, `initializeSimulator()`, `initializeTriathlonSimulator()` |
| `workouts/` | Plan generation, scheduling, gym workouts. Triathlon mode adds `plan_engine.triathlon.ts`, `scheduler.triathlon.ts`, `swim.ts`, `bike.ts`, `brick.ts`. | `generator.ts`, `plan_engine.ts`, `scheduler.ts`, `gym.ts`, `load.ts`, `plan_engine.triathlon.ts`, `scheduler.triathlon.ts`, `swim.ts`, `bike.ts`, `brick.ts` | `generateWeekWorkouts()`, `planWeekSessions()`, `assignDefaultDays()`, `generateGymWorkouts()`, `calculateWorkoutLoad()`, `generateTriathlonPlan()`, `scheduleTriathlonWeek()`, `generateSwimSession()`, `generateBikeSession()`, `generateBrick()` |
| `calculations/` | VDOT, paces, predictions, fatigue, physiology, TSS/ACWR. Prediction blend composes `prediction-inputs.ts` (Tanda volume+pace) + `effort-calibrated-vdot.ts` (HR-calibrated VDOT via Swain regression) into `blendPredictions`. Triathlon adds `triathlon-tss.ts`, `fitness-model.triathlon.ts`, `race-prediction.triathlon.ts`, `activity-matcher.triathlon.ts`, `brick-detector.ts`, `tri-benchmark-history.ts` (FTP/CSS sample append helpers). | `vdot.ts`, `paces.ts`, `predictions.ts`, `prediction-inputs.ts`, `effort-calibrated-vdot.ts`, `blended-fitness.ts`, `fatigue.ts`, `training-horizon.ts`, `physiology-tracker.ts`, `heart-rate.ts`, `fitness-model.ts`, `triathlon-tss.ts`, `fitness-model.triathlon.ts`, `race-prediction.triathlon.ts`, `activity-matcher.triathlon.ts`, `brick-detector.ts`, `tri-benchmark-history.ts` | `cv()`, `vt()`, `gp()`, `blendPredictions()`, `computePredictionInputs()`, `computeHRCalibratedVdot()`, `refreshBlendedFitness()`, `calculateLiveForecast()`, `getRunnerType()`, `applyTrainingHorizonAdjustment()`, `computeWeekTSS()`, `computeFitnessModel()`, `computeACWR()`, `computeSwimTss()`, `computeBikeTssFromPower()`, `computeBikeTssFromHr()`, `computePerDisciplineFitness()`, `perDisciplineACWR()`, `rebuildTriFitnessFromActivities()`, `predictTriathlonRace()`, `matchTriathlonWeek()`, `detectBricks()`, `appendFtpSample()`, `appendCssSample()` |
| `injury/` | Phase-based injury management + workout adaptation | `engine.ts` | `applyInjuryAdaptations()`, `evaluatePhaseTransition()`, `recordPainLevel()`, `analyzeTrend()` |
| `cross-training/` | Universal load model, workout matching, suggestions | `universalLoad.ts`, `matcher.ts`, `load-matching.ts`, `suggester.ts` | `computeUniversalLoad()`, `applyCrossTrainingToWorkouts()`, `buildCrossTrainingPopup()`, `applyAdjustments()` |
| `gps/` | GPS tracking, split detection, recording persistence | `tracker.ts`, `geo-math.ts`, `split-scheme.ts`, `persistence.ts` | `GpsTracker` (class), `haversineDistance()`, `filterJitter()`, `buildSplitScheme()` |
| `recovery/` | Morning check-in, sleep/readiness scoring | `engine.ts` | `computeRecoveryStatus()`, `sleepQualityToScore()`, `RecoveryEntry`, `RecoveryLevel` |
| `ui/` | Dashboard, renderer, events, wizard, modals. Triathlon mode renders from `ui/triathlon/`. | `main-view.ts`, `renderer.ts`, `events.ts`, `wizard/controller.ts`, `wizard/steps/triathlon-setup.ts`, `activity-review.ts`, `welcome-back.ts`, `triathlon/{plan-view,home-view,stats-view,progress-detail-view,tab-bar,workout-card,race-forecast-card,colours}.ts` | `renderMainView()`, `render()`, `next()`, `rate()`, `skip()`, `initWizard()`, `showActivityReview()`, `detectMissedWeeks()`, `showWelcomeBackModal()`, `renderTriathlonPlanView()`, `renderTriathlonHomeView()`, `renderTriathlonStatsView()`, `renderTriProgressDetailView()` |
| `constants/` | Static config, protocols, sport DB, training params. Triathlon adds `triathlon-constants.ts` and `transfer-matrix.ts`. | `index.ts`, `injury-protocols.ts`, `sports.ts`, `training-params.ts`, `triathlon-constants.ts`, `transfer-matrix.ts` | `INJURY_PROTOCOLS`, `SPORTS_DB`, `TRAINING_HORIZON_PARAMS`, `TRANSFER_MATRIX`, `COMBINED_CTL_WEIGHTS`, `DEFAULT_VOLUME_SPLIT`, `RACE_LEG_DISTANCES`, `RUN_FATIGUE_DISCOUNT_70_3`, `RUN_FATIGUE_DISCOUNT_IRONMAN` |
| `types/` | All TypeScript interfaces and type unions. Triathlon adds `triathlon.ts`. | `state.ts`, `injury.ts`, `onboarding.ts`, `training.ts`, `activities.ts`, `gps.ts`, `triathlon.ts` | `SimulatorState`, `Workout`, `InjuryState`, `OnboardingState`, `TrainingPhase`, `EventType`, `Discipline`, `TriathlonDistance`, `TriConfig`, `TriSkillRating`, `TriVolumeSplit`, `TriRacePrediction` |
| `data/` | Static data, Supabase client, wearable sync, source routing | `marathons.ts`, `supabaseClient.ts`, `activitySync.ts`, `stravaSync.ts`, `appleHealthSync.ts`, `physiologySync.ts`, `sources.ts` | Marathon catalog, `syncActivities()`, `syncStravaActivities()`, `syncAppleHealth()`, `syncAppleHealthPhysiology()`, `syncPhysiologySnapshot()`, `getActivitySource()`, `getPhysiologySource()` |
| `utils/` | Formatting, helpers, platform detection | `format.ts`, `helpers.ts`, `platform.ts` | Time/pace formatting, platform checks |
| `scripts/` | Offline audit/analysis scripts | `sanity_audit.ts`, `comprehensive_audit.ts` | Not imported at runtime |
| `testing/` | Synthetic athlete generators, forecast matrix | `synthetic-athlete.ts`, `forecast-matrix.ts` | Test utilities only |

---

## Data Flow

### 1. Onboarding → State

```
User fills wizard steps (goals, background, volume, PBs, fitness data)
  → OnboardingState populated
  → initializeSimulator(onboarding)
    → if onboarding.trackOnly:
        → s.trackOnly=true, s.continuousMode=true, s.w=1, s.tw=1
        → seed s.wks=[{w:1, ph:'base', ...}] — rolling bucket, no planned workouts
        → persist PBs/physiology (VDOT if PBs exist, else defaults stay), return early
        → wizard controller calls completeOnboarding() + goes to main-view
    → else (full plan path):
        → computes VDOT from PBs (cv()), runner type (getRunnerType())
        → generates paces (gp()), predictions (blendPredictions())
        → builds initial s.wks[] array with phase assignments
  → SimulatorState ready → renderMainView()
```

**Just-Track mode** is the same infrastructure as any non-event `continuousMode` user, with one rolling week bucket that extends on calendar advance. Plan generation is suppressed and a handful of view surfaces hide prescription UI — that is the entire difference. The flag lives on both `OnboardingState.trackOnly` and `SimulatorState.trackOnly`.

**What track-only users see:**
- `getHomeHTML` → `getTrackOnlyHomeHTML`: no today-workout, no race-forecast, no Coach/Check-in. Shows `buildTrackOnlyDailyTarget` (CTL/7 × readiness, Gabbett-band coloured), `buildReadinessRing` (retained — informational), weekly volume card, sync, recent activity, "Create a plan" CTA.
- `renderPlanView` → `getTrackOnlyPlanHTML`: retrospective log of the current week + rolling history of prior weeks. No forward planning.
- `buildStatsSummary`: drops Progress (plan-adherence) card; keeps Fitness card (CTL/VDOT — both derived from actuals).
- `showWeekDebrief` → `showTrackOnlyRetrospective`: compact this-vs-last-week deltas (distance, sessions, TSS, CTL, recovery avg).

**What's unchanged:** Strava / Garmin / Apple sync, activity matching, GPS recording, physiology polling, readiness computation, CTL/ATL/TSB, ACWR. All of these write into the same `wk.garminActuals` / `adhocWorkouts` / `rated` buckets that planned users have — there is no parallel track-only data store.

**Calendar extension**: `advanceWeekToToday` branches on `s.trackOnly` and extends `s.wks` one week at a time with `ph:'base'` (phase is meaningless for trackOnly — views hide it). Planned `continuousMode` users continue to get 4-week base/build/peak/taper blocks.

**Mode switching**: `upgradeFromTrackOnly()` (track → plan) and `downgradeToTrackOnly()` (plan → track) live in `wizard/controller.ts`. Both flip `onboarding.trackOnly` then route through the `initializing` step. The mode-change guard there (`!!onboarding.trackOnly !== !!s.trackOnly`) forces `initializeSimulator` to re-run rather than short-circuit on the existing-plan path. Both directions preserve `s.ctlBaseline`, PBs, physiology, and Strava / Garmin / Apple connections; the inactive direction's wks are dropped from local state but remain in server-side `garmin_activities`. Triggers: Account → Advanced (both directions), home race-complete banner (downgrade only), home Create-a-plan link / plan-tab CTA (upgrade only).

**Science log**: the CTL/7 × readiness daily target and Gabbett colour bands are documented in `docs/SCIENCE_LOG.md → "Just-Track Daily Load Target"`.

### 2. Weekly Generation (every render)

```
render()
  → compute currentVDOT = s.v + cumulative wkGain + s.rpeAdj
  → gp(currentVDOT) → update paces
  → generateWeekWorkouts(phase, runsPerWeek, raceDistance, runnerType, ...)
    → planWeekSessions(ctx) → SessionIntent[]
    → intentToWorkout() for each intent → Workout[]
    → add commute runs, recurring activities, makeup skips
    → generateGymWorkouts() → append gym Workout[]
    → calculateWorkoutLoad() for each workout
    → applyInjuryAdaptations(workouts, injuryState)
    → recalculate loads after injury adaptations
    → assignDefaultDays(workouts)
  → apply stored mods (workoutMods, workoutMoves, adhocWorkouts)
  → render workout cards + calendar
```

### 3. Week Advance

```
user clicks "Complete Week"
  → next()
    → injury check-in (if active) → modal → evaluatePhaseTransition()
    → recovery check (computeRecoveryStatus) → adjustment modal if not green
    → benchmark prompt (if benchmark week in continuous mode)
    → compute wkGain from RPE ratings (or detraining if injured)
    → s.wks[s.w].wkGain = gain
    → s.w++ (advance week pointer)
    → saveState()
    → renderMainView() (triggers full re-render)
```

---

## Key Types

### SimulatorState (`src/types/state.ts`)

| Group | Fields |
|-------|--------|
| Week tracking | `w` (current week), `tw` (total weeks), `wks` (Week array) |
| VDOT/fitness | `v` (live blended VDOT — refreshed weekly via `refreshBlendedFitness`; held during taper), `iv` (initial at onboarding), `rpeAdj`, `physioAdj`, `expectedFinal`, `blendedRaceTimeSec`, `blendedEffectiveVdot`, `blendedLastRefreshedISO`. Read via `getEffectiveVdot(s)` which layers `rpeAdj + physioAdj` on top of `s.v`. |
| Race config | `rd` (race distance), `rw` (runs/week), `gs` (gym sessions), `epw` (exercises/week), `wkm` (weekly km) |
| PBs & recent | `pbs` (PBs object), `rec` (RecentRun) |
| Physiology | `lt` (LT pace sec/km), `vo2` (VO2max), `maxHR`, `restingHR` |
| Race times | `initialBaseline`, `currentFitness`, `forecastTime` |
| Runner profile | `typ` (RunnerType), `b` (fatigue exponent) |
| Training data | `pac` (Paces), `skip` (skip tracking), `timp` (time impact) |
| Injury | `injuryState` (InjuryState), `rehabWeeksDone`, `lastMorningPainDate` |
| Continuous mode | `continuousMode`, `blockNumber`, `benchmarkResults` |
| Recovery | `recoveryHistory` (RecoveryEntry[]), `lastRecoveryPromptDate` |
| Integrations | `wearable` (legacy), `connectedSources?: { activity?, physiology? }` — use accessors in `src/data/sources.ts`; `stravaConnected?: boolean` — when true, Strava is the activity source regardless of wearable; `biologicalSex` (`'male' \| 'female' \| 'prefer_not_to_say'`) — for iTRIMP β |
| Onboarding | `onboarding` (OnboardingState), `hasCompletedOnboarding` |
| ACWR / Tier | `athleteTier?` — computed from CTL (5 tiers); `athleteTierOverride?` — manual override takes precedence |

### Workout (`src/types/state.ts`)

```
t: string          — workout type (easy, long, threshold, vo2, gym, cross, rest, test_run...)
n: string          — display name
d: string          — description (e.g. "50min @ 5:00/km")
r: number          — target RPE
rpe?: number       — alias for r
dayOfWeek?: number — 0=Mon, 6=Sun
aerobic?: number   — aerobic load score
anaerobic?: number — anaerobic load score
status?: string    — planned | reduced | replaced | skipped
```

### InjuryState (`src/types/injury.ts`)

Phase-based recovery: `active`, `injuryPhase`, `currentPain` (0–10), `history` (pain entries), `capacityTestsPassed`, `returnToRunLevel` (1–8), `zeroPainWeeks`, `graduatedReturnWeeksLeft`.

### OnboardingState (`src/types/onboarding.ts`)

Wizard data: `name`, `raceDistance`, `trainingForEvent`, `runsPerWeek`, `gymSessionsPerWeek`, `experienceLevel`, `pbs`, `ltPace`, `vo2max`, `continuousMode`, `recurringActivities`, `hasSmartwatch`, `watchType` (`'garmin' | 'apple' | 'strava'`), `biologicalSex` (`'male' | 'female' | 'prefer_not_to_say'` — for iTRIMP β, collected on physiology step).

### TrainingPhase

`'base' | 'build' | 'peak' | 'taper'`

---

## State Abbreviations

Quick reference for reading code that uses `s = getState()`:

| Abbrev | Full Name | Type |
|--------|-----------|------|
| `s.w` | Current week | `number` |
| `s.tw` | Total weeks | `number` |
| `s.v` | Starting VDOT | `number` |
| `s.iv` | Initial VDOT | `number` |
| `s.rpeAdj` | RPE adjustment to VDOT | `number` |
| `s.rd` | Race distance | `RaceDistance` |
| `s.rw` | Runs per week | `number` |
| `s.gs` | Gym sessions per week | `number` |
| `s.epw` | Exercises per week | `number` |
| `s.wkm` | Weekly km | `number` |
| `s.typ` | Runner type (effective) | `RunnerType` |
| `s.b` | Fatigue exponent | `number` |
| `s.lt` | LT pace (sec/km) | `number \| null` |
| `s.vo2` | VO2max | `number \| null` |
| `s.pac` | Current paces | `Paces` {e, t, i, m, r} |
| `s.wks` | All weeks array | `Week[]` |
| `s.pbs` | Personal bests | `PBs` {k5, k10, h, m} |
| `s.rec` | Recent race | `RecentRun \| null` |
| `s.eventType` | `'running'` or `'triathlon'`. Default running for back-compat. | `EventType \| undefined` |
| `s.triConfig` | Triathlon config (distance, split, benchmarks, fitness). Present only when `eventType === 'triathlon'`. | `TriConfig \| undefined` |
| `wk.triWorkouts` | Week's generated triathlon workouts (swim/bike/run/brick/gym). Running weeks leave undefined. | `Workout[] \| undefined` |
| `w.discipline` | Triathlon discipline for a workout (`'swim' \| 'bike' \| 'run'`). Undefined = running. | `Discipline \| undefined` |
| `w.brickSegments` | Present on brick workouts: two ordered discipline segments. | `[DisciplineTarget, DisciplineTarget] \| undefined` |
| `s.timp` | Total time impact (skips) | `number` |
| `s.tssPerActiveMinute` | Personal TSS/min calibrated from activities | `number \| undefined` |
| `wk.ph` | Week's training phase | `TrainingPhase` |
| `wk.wkGain` | Week's VDOT gain | `number` |
| `wk.rated` | Workout ratings | `Record<string, number \| 'skip'>` |

---

## Common Patterns

### Adding a new workout type

1. Add the type string to workout generation in `plan_engine.ts` or create a dedicated generator (see `gym.ts`)
2. `Workout.t` is a free string — no enum to update
3. Add load calculation support in `workouts/load.ts` if the type has a distinct aerobic/anaerobic profile
4. The injury engine auto-handles unknown types via `adaptWorkoutForInjury()` fallback
5. The scheduler places non-run workouts on remaining free days after runs are assigned

### `generateWeekWorkouts()` call signature

17 positional params. Called from all UI entry points:

```ts
generateWeekWorkouts(
  phase, runsPerWeek, raceDistance, runnerType,
  previousSkips, commuteConfig, injuryState, recurringActivities,
  fitnessLevel, hrProfile, easyPaceSecPerKm,
  weekIndex, totalWeeks, vdot, gymSessionsPerWeek,
  effortScore, acwrStatus
)
```

17 positional params. When `weekIndex` and `totalWeeks` are provided, uses `planWeekSessions()`. Otherwise falls back to the legacy `rules_engine.ts`.

`effortScore` (trailing RPE from `getTrailingEffortScore()`) and `acwrStatus` (from `wk.scheduledAcwrStatus`) enable the plan engine to scale workout durations (5–15% reduction) and strip quality sessions when load is high.

### State access pattern

```ts
const s = getState();           // read-only reference
const s = getMutableState();    // when you need to mutate directly
updateState({ w: s.w + 1 });   // partial update (immutable merge)
saveState();                    // persist to localStorage
```

---

## Subsystem Notes

### Injury System (`src/injury/engine.ts`)

Six-phase clinical progression: **acute → rehab → test_capacity → return_to_run → graduated_return → resolved**.

- Each phase generates its own weekly workout plan or adapts the normal plan
- Phase transitions are driven by pain history trends and capacity test results
- Pain ≥ 7 in any phase → regression to acute; pain ≥ 4 in test_capacity/return_to_run/graduated_return → regress one phase
- `graduated_return` (2 weeks): easy runs pass through unchanged, hard sessions get RPE-capped and distance-reduced 20%
- Detraining model: negative `wkGain` per phase (–0.15 acute to –0.03 graduated_return)
- `canProgressFromAcute()` accepts either 72 real hours OR 2+ pain history entries (one simulated week)

### Cross-Training Engine (`src/cross-training/`)

Universal load currency converts any activity to aerobic/anaerobic load + fatigue cost + run replacement credit (RRC).

**Three data tiers**: iTRIMP / HR stream (Tier A+), Garmin (Tier A), HR-only (Tier B), RPE-only (Tier C, with uncertainty penalty).

**Load currency invariant**: Tier A+ takes raw iTRIMP from `src/calculations/trimp.ts`, which is seconds-weighted Banister TRIMP (~150 per TSS). It MUST be normalised to TSS-equivalent (`iTrimp × 100 / 15000`) before applying sport multiplier — same convention as every TSS-display call site in the app and as `tri-benchmarks-from-history.ts:638`. See SCIENCE_LOG.md → "Load currency invariant" for the full rationale and prior-incident history. Regression test: `Universal Load: iTRIMP scale invariant` in `universalLoad.test.ts`.

**Runner-type aware reduction** (`AthleteContext.runnerType`): Speed runners get volume-first candidate ordering in `buildReduceAdjustments` (easy runs cut before quality downgrades). Endurance/Balanced runners keep the default intensity-first ordering.

**Severity thresholds** (FCL relative to weekly run load):
- Light: FCL < 25% → max 1 adjustment
- Heavy: FCL 25–55% → max 2 adjustments
- Extreme: FCL ≥ 55% → max 3 adjustments

**Interleave algorithm** (`buildReplaceAdjustments`): replace pool sorted cheapest-first. Loop: replace 1 → reduce/downgrade 1 → repeat. Natural scaling: small RRC = just reduce, large = replace + reduce + replace.

**Downgrade ladder**:
```
vo2/intervals → threshold → marathon_pace → easy
hill_repeats  → threshold
race_pace     → marathon_pace
progressive   → easy (plain long run, removes fast finish)
mixed         → marathon_pace
threshold     → steady (halfway between easy and threshold, NOT true marathon pace)
```

**Key invariant**: Adjustment `workoutId` and `dayIndex` come from the generator's `w.n` and `w.dayOfWeek`. Mods must store/match original generator names (before renderer deduplication renames them).

**Mode-aware modal routing**: in triathlon mode (`s.eventType === 'triathlon'`), the running suggestion modal (`showSuggestionModal`) is suppressed and cross-training overload is surfaced via `tri-suggestion-modal.ts`. Routing happens at four sites:
- `activity-review.ts` — `redirectToTriSuggestionFlow` helper persists items as adhocs and shows the tri modal.
- `events.ts:logActivity` — tri-mode branch persists the manual log + shows the tri modal.
- `main-view.ts:triggerACWRReduction` — tri-mode early-return (tri uses per-discipline volume ramps, not run ACWR).
- `excess-load-card.ts:triggerExcessLoadAdjustment` — defensive early-return.
The tri detector is `src/calculations/tri-cross-training-overload.ts`; it sums non-tri-discipline TSS and fires when the cross-training contribution exceeds 15% of planned weekly tri TSS. See ISSUE-151 in OPEN_ISSUES.md (✅ FIXED 2026-04-30) for the full audit and SCIENCE_LOG.md for the threshold rationale.

### Cross-Training Log → Plan Apply Pipeline (`events.ts` ~L1080–1418)

```
1. User submits sport/duration/RPE form
2. events.ts builds a CrossActivity object
3. workouts = generateWeekWorkouts(...)
4. Slot matching: fill planned cross-training slots first; else full suggestion flow
5. Re-apply existing mods (prevents double-spending on already-replaced runs)
6. workoutsToPlannedRuns(workouts, paces) → PlannedRun[] for suggester
7. buildCrossTrainingPopup() → computeUniversalLoad, buildCandidates, buildReplaceAdjustments
8. showSuggestionModal() → user picks Replace & Reduce / Reduce / Keep
9. applyAdjustments() → creates modified copies of workouts
10. Store mods in wk.workoutMods[]
11. saveState() + render()
```

### GPS Tracking (`src/gps/`)

`GpsTracker` is a state machine: **idle → acquiring → tracking → paused → stopped**.

- Provider abstraction: `native-provider.ts` (Capacitor), `web-provider.ts` (browser), `mock-provider.ts` (dev)
- Points are jitter-filtered (`filterJitter()`), distances via Haversine
- Split detection: `buildSplitScheme()` is a derived view over `buildTimeline` — see "Guided Runs" below
- Recordings persisted to localStorage with an index

### Guided Runs (`src/guided/`, `src/gps/split-scheme.ts`)

Voice/haptic coaching and on-screen split cues share a single parser so the two views cannot diverge.

- `buildTimeline(workout, paces)` in `src/guided/timeline.ts` is the **single source of truth** for interpreting `workout.d`. It emits a `Timeline` of typed `Step`s (`warmup` | `work` | `recovery` | `cooldown` | `easy` | `long`) with pace targets and rep indices.
- `buildSplitScheme(workoutDesc, paces)` in `src/gps/split-scheme.ts` is a **thin adapter over `buildTimeline`**. It maps each step to one or more `SplitSegment`s: reps become a single paced segment, recoveries become untimed segments with `durationSeconds`, warm-up/cool-down become a single paced segment at easy pace, and single-block distances (e.g. `20km @ MP`, `8km`) are expanded into per-km splits.
- Adding a new workout format means extending `parseMainSet` in `timeline.ts`; `split-scheme.ts` picks it up automatically via the adapter. Never add a parallel regex path in split-scheme.

### iOS Native (`ios/`, `ios-plugins/guided-voice/`, adapter swap points in `src/guided/`)

Capacitor 8 + Swift Package Manager. App id `com.mosaic.training`, iOS 15 minimum, bundle name "Mosaic".

- **`ios-plugins/guided-voice/`** — local npm package (installed via `file:` protocol), Swift target `GuidedVoicePlugin`. Wraps `AVSpeechSynthesizer` and activates `AVAudioSession(.playback, .voicePrompt, [.duckOthers, .mixWithOthers])` around each utterance, then deactivates with `.notifyOthersOnDeactivation` on the delegate callback. Registered with Capacitor as `GuidedVoice` (jsName).
- **`src/guided/voice.ts`** — adapter swap point. `speak()`/`cancel()` detect `Capacitor.isNativePlatform()` and route through the native plugin; Web Speech is the browser fallback. `composePhrase` stays pure so the test suite is unaffected.
- **`src/guided/haptics.ts`** — adapter swap point. Default adapter picks native `@capacitor/haptics` on native (Taptic Engine via `Haptics.impact`) and `navigator.vibrate` in browsers. Patterns (e.g. `[80, 60, 80]`) are emulated with chained `impact` calls on setTimeout.
- **`src/guided/keep-awake.ts`** — screen-on adapter. `@capacitor-community/keep-awake` on native, `navigator.wakeLock` fallback on web. Not yet wired into Record-tab UI (ISSUE-135).
- **`src/guided/background-location.ts`** — `GUIDED_RUN_LOCATION_CONFIG` — recommended options for `@transistorsoft/capacitor-background-geolocation` (`preventSuspend: true`, `locationAuthorizationRequest: 'Always'`, foreground-service notification). Not yet wired.
- **`ios/App/App/Info.plist`** — location (when-in-use + always), motion, `UIBackgroundModes: [location, audio]`. Audio background mode is what lets voice cues continue while the screen is locked.
- **`npx cap sync ios`** regenerates `ios/App/App/capacitor.config.json` and `ios/App/CapApp-SPM/Package.swift` from the npm plugin list — manual edits to those files are clobbered. New native code goes via a plugin package. See `docs/IOS_SETUP.md`.

### Recovery & Deload (`src/recovery/engine.ts`)

Morning check-in: sleep score + Garmin readiness + HRV status → `computeRecoveryStatus()` → green/yellow/orange/red.

- Trend escalation: 2 of 3 days low → escalate level
- Non-green triggers adjustment modal: downgrade hard workout / reduce distance / flag as easy
- Plan engine has built-in deload weeks via `isDeloadWeek()` (every 3rd–4th week by ability band)

### Load Model & Plan Continuity (`src/calculations/fitness-model.ts`)

> See also: `docs/SCIENCE_LOG.md → "Plan-reset continuity (2026-04-29)"` for why the chronological walker exists, and `docs/CHANGELOG.md` 2026-04-29 entries for the `previousPlanWks` threading fix plus the baseline-refresh / DB-dedup follow-ups.

CTL/ATL/TSB and ACWR are computed from three signals (Signal A, B, C — see CLAUDE.md and `docs/PRINCIPLES.md`). Two parallel walkers exist:

- **Rolling 7d/28d** (`computeRollingLoadRatio`) — primary path for ACWR. Walks the last 28 days day-by-day, resolving each date to a Week via `_resolveWeekForDate`, which checks current `wks` *and* archived plans.
- **Weekly EMA** (`computeSameSignalTSB`, `computeFitnessModel`) — used by the freshness ring, weekly TSB chart, week debrief, and as the ACWR fallback when planStartDate is missing or rolling data is insufficient.

**Plan continuity via `previousPlanWks`**: when a user generates a new plan, the old `wks` is archived into `s.previousPlanWks` (`archiveCurrentWksIfPopulated()` in `state/initialization.ts`) and any activities falling in the new plan window are redistributed via `redistributeArchivedActivitiesToNewPlan()`. Archive weeks whose start date is on or after the new plan's start are truncated by `_truncateArchivesAtPlanBoundary` so chronological concatenation cannot double-count.

Every readiness/load consumer threads `s.previousPlanWks` through to the walker so CTL doesn't collapse to `signalBBaseline` the moment a new plan starts:

- Helper `_walkChronologicalWeeks` yields archives (sorted by `planStartDate`) + current `wks` chronologically, each tagged with the right `planStartDate` so `computeWeekRawTSS`'s `unspentLoadItems` filter keys off the archive's own start, not the current plan's.
- Used by `computeSameSignalTSB`, `computeFitnessModel`, `computeLiveSameSignalTSB`, and `computeACWR`'s weekly-EMA fallback. Sleep debt's `buildDailySignalBTSS` walks archives independently.

**Call-site rule**: any new code reading these functions must pass `s.previousPlanWks` as the trailing `archivedPlans` argument. Skipping it makes the freshness ring and ACWR re-collapse on the next plan reset. Live writers: `freshness-view`, `home-view`, `readiness-view`, `daily-coach`, `stats-view`, `week-debrief`, `excess-load-card`, `activity-review`, `events`, `main-view`, `renderer`, `rolling-load-view`, `gps/recording-handler`.

### Gym Integration (`src/workouts/gym.ts`)

Phase-aware strength templates:
- Base: heavy compound lifts
- Build: explosive power
- Peak: maintenance
- Taper: activation only

Three ability tiers: beginner (bodyweight), novice (light weights), full (barbell). Deload weeks reduce by 1 session + lower RPE. Gym workouts never replace running sessions.

**Injury handling**: no gym in acute/rehab/test_capacity; light return session in return_to_run (level 5+).

### Wearable Activity Sync (`src/data/activitySync.ts`, `src/data/stravaSync.ts`, `src/data/appleHealthSync.ts`, `src/calculations/activity-matcher.ts`)

Fire-and-forget on boot. Two separate concerns are handled independently:

**Activity source** (what workouts were done) — `s.stravaConnected` takes priority:
- **Strava connected** (`s.stravaConnected`): `syncStravaActivities()` → `sync-strava-activities` Edge Function. Fetches activity list + full HR streams; computes iTRIMP. IDs namespaced `"strava-{id}"`. This path is used even for Garmin/Apple Watch users who have Strava. Backfill mode additionally stores Strava `best_efforts` (jsonb on `garmin_activities`) for RUNNING activities; `src/calculations/pbs-from-history.ts → readPBsFromHistory()` reads these to auto-fill onboarding PBs (5k / 10k / half / marathon) with source activity id + date for UI attribution.
- **Garmin-only** (`!s.stravaConnected`, physiology source `'garmin'`): `syncActivities()` → `sync-activities` Edge Function (28-day lookback). Activities arrive via Garmin Health API webhook.
- **Apple Watch** (activity source `'apple'`): `syncAppleHealth()` → `@capgo/capacitor-health` → `Health.queryWorkouts()` (iOS native only; no-op on web).

**Biometric/physiology source** (sleep, HRV, resting HR, steps) — determined by `getPhysiologySource(s)` from `src/data/sources.ts`:
- **Garmin**: `syncPhysiologySnapshot(28)` → `sync-physiology-snapshot` Edge Function → merges `daily_metrics`, `sleep_summaries`, `physiology_snapshots` (all written by Garmin webhook).
- **Apple Watch**: `syncAppleHealthPhysiology(28)` → `@capgo/capacitor-health` → `Health.readSamples()` for sleep stages, HRV (SDNN), resting HR, steps. On-device, no server. Sleep score computed from stage durations.
- **Source routing**: `connectedSources.physiology` field on state, with legacy `wearable` fallback. Accessor functions in `src/data/sources.ts` centralise all branching.

**Garmin data pipeline** (webhook push model):
- **Live delivery**: Garmin pushes dailies / sleeps / HRV / userMetrics to `supabase/functions/garmin-webhook` as events happen. The handler writes to `daily_metrics`, `sleep_summaries`, `physiology_snapshots`.
- **First-connect history**: `triggerGarminBackfill(8)` fires **exactly once** per OAuth connect. `resetGarminBackfillGuard()` (called from the Connect Garmin buttons) clears the stamp so the next launch fires an 8-week `/backfill/{dailies,sleeps,hrv,userMetrics}` request; subsequent launches no-op. Guard key: `mosaic_garmin_backfill_migration = 'v7-one-shot-backfill'`.
- **Gap recovery**: `supabase/functions/garmin-reconcile` runs nightly at 04:00 UTC via pg_cron. Finds users with a `garmin_tokens` row but no `daily_metrics` row for yesterday and fires a small 3-day `/backfill/dailies`+`/backfill/sleeps`+`/backfill/userMetrics` window (userMetrics added 2026-04-23 so VO2/LT refreshes survive webhook gaps). Requests within a user are **serialized with 300ms spacing**; users are paced 3s apart. Also callable with a user JWT (single-user reconcile) from the manual Resync button in Account settings. Cron secret stored in Supabase Vault as `reconcile_cron_secret`; same value set on the function as `RECONCILE_CRON_SECRET` env var.
- **Rate-limit handling** (2026-04-24): Garmin's 100/min cap is app-wide (keyed on our client ID). Both functions detect 429/403/502/503 and bail the run. The client reads `rateLimited` from the response and sets `mosaic_garmin_cooldown_until` (120s, shared between backfill + reconcile) to stop further bursts until the rolling window clears. `triggerGarminBackfill` now only sets the one-shot migration guard on true success; a rate-limited run self-heals on the next launch after the cooldown.
- **Why no client-side polling**: the previous design polled `triggerGarminBackfill` every 2h on app launch. At scale that tripped Garmin's 100/min rate limit. Moving catch-up to a server-side cron removes the thundering-herd.

All activity paths produce `GarminActivityRow[]` and feed into `matchAndAutoComplete()` — identical pipeline from that point.

**Matching pipeline**:
1. Filter activities already in `wk.garminMatched` (idempotent)
2. Filter to current week's date range
3. Map Garmin activity type → app type
4. Regenerate current week workouts (same sequence as renderer) for stable IDs
5. `findMatchingWorkout()` — scores day, distance, type
6. High confidence → auto-complete with derived RPE. Medium/no match → ad-hoc workout

**RPE derivation priority**: Garmin RPE → HR zone (Karvonen) → Training Effect → activity type heuristic → planned RPE.

**Key state**: `wk.garminMatched: Record<string, string>` maps `garmin_id` → `workoutId` to prevent re-matching.

### Continuous Mode

Non-event users. 4-week block cycling: base → build → intensify → deload. Optional benchmark check-ins at block boundaries. `s.continuousMode = true`, `s.blockNumber` tracks current block.

### Scheduler (`src/workouts/scheduler.ts`)

`assignDefaultDays()` rules: long run → Sunday, quality sessions → Tue/Thu, easy runs fill remaining slots. `checkConsecutiveHardDays()` validates no back-to-back hard days. Users can override via drag-and-drop → stored in `wk.workoutMoves`.

### Renderer Workout Lifecycle (`src/ui/renderer.ts`)

**Order matters** — every `render()` call:

```
1. generateWeekWorkouts(...)           — fresh Workout[] with original names ("Easy Run")
2. Apply stored mods (wk.workoutMods)  — BEFORE rename; mods store original generator names
3. Deduplicate names                   — "Easy Run" → "Easy Run 1", "Easy Run 2"; assign w.id
4. Append adhoc workouts (wk.adhocWorkouts)
5. Append passed capacity tests
6. Apply workout moves (wk.workoutMoves) — drag-and-drop day reassignments
7. Render calendar + workout list
```

**Display states**: Planned (default) / Replaced (cyan, struck-through description) / Reduced (sky, shows before+after) / Completed (green, RPE badge) / Skipped (amber/red).

**Modification labels**: When `w.status === 'replaced'` or `'reduced'` and `w.modReason` is set, the detail card shows a human-readable banner: "Replaced by HIIT" or "Reduced — Tennis (45min)". The "Garmin: " prefix is stripped from `modReason` before display. An Undo button calls `window.openActivityReReview()`. The calendar compact card shows the activity name as "→ HIIT" appended to the workout name.

### Garmin Activity Review Pipeline (`src/ui/activity-review.ts`)

Two entry paths from `activitySync.ts`:

**Week filtering**: `processPendingCrossTraining` computes current week date range from `planStartDate + (w-1)*7` and only presents activities within that range. Prevents items from previous weeks re-appearing after re-syncs.

**Choice persistence**: integrate/log choices are saved to `wk.garminReviewChoices` on every toggle (not just on Apply). `showActivityReview` falls back to these saved choices when no explicit `savedChoices` param is provided, so choices survive page refresh.

**Auto-process** (≤2 activities, all same-day): silently slot-matches each; shows assignment toast. Overflow → `wk.unspentLoadItems` + suggestion modal.

**Manual review** (≥3 activities or any >24h old): `showActivityReview` renders a review screen grouped by date, with "Week N of T · Mon DD – Sun DD" header. On Apply:

```
integrateCount >= 2?
  → showMatchingScreen(overlay, ...)    — tap-to-assign UI
  → user confirms
  → applyReview(pending, updatedChoices, matchCache, onComplete, confirmedMatchings)
else
  → applyReview(pending, choices, matchCache, onComplete)
```

**Matching Screen** (`src/ui/matching-screen.ts`): full-screen tap-to-assign UI.
- Slot cards ordered Mon→Sun; show actual date ("Mon 23 Feb") from `planStartDate + dayOfWeek`.
- Activity tray sorted: runs → gym → cross/other, then chronologically. Only **unassigned** integrate items shown; log-only items hidden from tray.
- Assigned activities disappear from tray; tapping an occupied slot bumps its activity back to tray (swap).
- Bucket contents shown as chips. Tapping × on a chip returns it to the tray. Original review-screen "log" items shown as static chips (no ×); manually-sent items have ×.
- Header shows `weekLabel` ("Week 4 of 10 · Mon 17 – Sun 23 Feb") passed from `activity-review.ts`.

**`applyReview` matching order** (per activity type):
1. Runs: `confirmedMatchings` map → `matchCache` (from `findMatchingWorkout`)
2. Gym: `confirmedMatchings` → `findMatchingWorkout` on unrated gym slots
3. Sports/cross: `confirmedMatchings` → `matchCache` → closest cross slot by day-of-week proximity
4. Generic cross slots: skipped entirely when `confirmedMatchings` is provided (user made explicit choices)

**`proposeMatchings()`**: dry-run of the above without state mutation — used to pre-populate matching screen.

**Excess Load Card** (`src/ui/excess-load-card.ts`): always rendered on the Training tab. When `wk.unspentLoadItems` is empty, shows a subtle "No overflow" placeholder. When non-empty, shows amber card with aerobic/anaerobic bars, [Adjust Plan], and [Dismiss] (two-tap). **Previous-week carry-over**: at `loadState` time, any `unspentLoadItems` in `wks[w-2]` that are not already in `wks[w-1]` (by `garminId`) are moved into the current week, ensuring items not resolved before advancing a week are not silently lost.

**Key state written**: `wk.garminMatched[garminId] = workoutId`, `wk.garminActuals[workoutId] = ...`, `wk.garminReviewChoices[garminId] = 'integrate'|'log'`, workout `status`/`modReason`/`rpe` fields.

**`modReason` invariant**: all Garmin-sourced `WorkoutMod` entries always use `` `Garmin: ${activityLabel}` `` as `modReason` — this applies to all paths: `applyReview`, `autoProcessActivities`, and `triggerExcessLoadAdjustment` (excess load card "Adjust Plan"). This prefix is required by `openActivityReReview`'s cleanup filter. Old mods with `"Reduced due to strength"` / `"Downgraded from X due to gym"` formats are stripped on load by a cleanup pass in `loadState`.

**`_pendingModalActive` guard**: the module-level boolean in `activitySync.ts` prevents concurrent review screens. It is reset when `syncActivities()` fires if neither `activity-review-overlay` nor `suggestion-modal` is present in the DOM — covering the case where a prior cancelled review or orphaned suggestion modal left the flag stuck.

---

### Welcome Back / Missed Week Detection (`src/ui/welcome-back.ts`)

`detectMissedWeeks()`: compares today's date against `planStartDate + (w-1)*7 + 7` to find full weeks elapsed since the current plan week ended.

`showWelcomeBackModal(weeksGap, onComplete)`:
- Guards with `localStorage` key (one show per calendar day)
- Applies VDOT detraining: compound `~1.2%/week` for weeks 1–2, `~0.8%/week` thereafter
- 3+ week gaps → sets `wk.ph = 'base'`
- Fires before `renderMainView()` in `launchApp()`

---

### Workout Description Format (`workouts/intent_to_workout.ts`)

Multi-line for sessions with warm-up/cool-down:
```
1km warm up (5:30/km+)
5×3min @ 3:47/km (~790m), 2 min recovery between sets
1km cool down (5:30/km+)
```

Single-line for simple workouts:
```
10km (5:30/km+)
```

**Any change to description format must also update**:
- `workouts/load.ts` — duration parsing
- `workouts/parser.ts` — `parseWorkoutDescription()` for distance extraction
- `ui/renderer.ts` — calendar compact view extraction

### Workout Load Calculation (`workouts/load.ts`)

`calculateWorkoutLoad(type, description, intensityPct, easyPaceSecPerKm)`:
- Parses description: intervals with time, km distances, simple Xmin
- Multi-line: strips WU/CD lines, parses main set, adds WU/CD time at easy pace
- Total load = duration × rate-per-minute (from `LOAD_PER_MIN_BY_INTENSITY` table), split by aerobic/anaerobic profile

### HR & Efficiency Scoring (`src/calculations/heart-rate.ts`)

When a workout is rated with an average HR, `calculateEfficiencyShift()` cross-checks RPE vs HR to modulate the VDOT adjustment:

- Low RPE + Low HR → positive shift (amplifies the fitness gain signal)
- Low RPE + High HR → negative shift (dampens — cardio was working harder than it felt)
- High RPE + High HR → small negative shift (legitimate struggle, dampens slightly)
- High RPE + Low HR (intervals only) → negative shift (central fatigue signal)

The shift modulates the RPE-based `ch` value by ±10–15%. Weekly cap: ±0.3 VDOT units regardless.

---

## Page Map

Complete navigation graph. Every full-page view, its entry points, and where its back button goes.

### Tab Pages (bottom tab bar)

| Page | File | Render | Opens |
|------|------|--------|-------|
| Home | `ui/home-view.ts` | `renderHomeView()` | Strain, Sleep, Readiness, Recovery, Activity Detail, Load Taper, Coach Modal, Check-in Overlay, Week Debrief |
| Plan | `ui/plan-view.ts` | `renderPlanView()` | Activity Detail, Load Taper, Record, Coach Modal, Check-in, Illness Modal, Week Debrief, Activity Review, Suggestion Modal |
| Record | `ui/record-view.ts` | `renderRecordView()` | GPS Panel (inline), GPS Completion Modal |
| Stats | `ui/stats-view.ts` | `renderStatsView()` | Sleep View |
| Account | `ui/account-view.ts` | `renderAccountView()` | Auth View, Wizard (re-onboard) |

### Detail Pages (back button navigation)

| Page | File | Render | Opened by | Back to |
|------|------|--------|-----------|---------|
| Readiness | `ui/readiness-view.ts` | `renderReadinessView()` | Home (readiness pill) | Home |
| Strain | `ui/strain-view.ts` | `renderStrainView(date?)` | Home (strain card), Readiness | Home |
| Recovery | `ui/recovery-view.ts` | `renderRecoveryView(date?)` | Home (recovery card), Readiness | Home |
| Sleep | `ui/sleep-view.ts` | `renderSleepView(date?, ..., onBack?)` | Home, Recovery, Readiness, Stats | Caller-controlled via `onBack` param |
| Freshness | `ui/freshness-view.ts` | `renderFreshnessView()` | Readiness | Readiness |
| Load Ratio & Injury Risk | `ui/injury-risk-view.ts` | `renderInjuryRiskView()` | Readiness | Readiness |
| Rolling Load | `ui/rolling-load-view.ts` | `renderRollingLoadView()` | Readiness | Readiness |
| Load/Taper | `ui/load-taper-view.ts` | `renderLoadTaperView(week?, returnTo)` | Home, Plan | Caller-controlled via `returnTo` param |
| Activity Detail | `ui/activity-detail.ts` | `renderActivityDetail(actual, ..., returnView)` | Home, Plan | Caller-controlled via `returnView` param |
| Coach | `ui/coach-view.ts` | `renderCoachView(onBack?)` | Home (Coach pill), Plan (Coach pill) | Caller-controlled via `onBack` param |

### Modals and Overlays (no page swap)

| Modal | File | Render | Opened by |
|-------|------|--------|-----------|
| Check-in | `ui/checkin-overlay.ts` | `openCheckinOverlay()` | Home, Plan |
| Illness | `ui/illness-modal.ts` | `openIllnessModal()` | Check-in, Plan |
| Injury | `ui/injury/modal.ts` | `openInjuryModal()` | Check-in, Plan |
| Week Debrief | `ui/week-debrief.ts` | `showWeekDebrief(week?, mode)` | Home (auto), Plan |
| Activity Review | `ui/activity-review.ts` | `showActivityReview(pending, onDone?)` | Plan, Home, Events |
| Matching Screen | `ui/matching-screen.ts` | `showMatchingScreen(pairings, onConfirm)` | Activity Review |
| Suggestion | `ui/suggestion-modal.ts` | `showSuggestionModal(popup, ...)` | Events, Activity Review, Excess Load Card |
| GPS Completion | `ui/gps-completion-modal.ts` | `openGpsCompletionModal(data)` | Recording Handler |
| Sync | `ui/sync-modal.ts` | `showMatchProposal(...)` | Renderer, Excess Load Card |

### Wizard (onboarding flow)

Entry: `main.ts` (first boot) or Account (re-onboard). Exit: `renderMainView()` which delegates to `renderPlanView()`.

Step order: Welcome, Goals, Background, Volume, Performance, Fitness, Strava History (conditional), Physiology, Initializing (auto), Runner Type, Assessment.

### Navigation Graph

```
main.ts
  ├── (no auth)       → auth-view
  ├── (new user)      → wizard → plan-view
  └── (returning)     → home-view (primary landing)

Tab bar: Home ↔ Plan ↔ Record ↔ Stats ↔ Account

home-view
  ├── strain-view (back → home)
  ├── readiness-view (back → home)
  │     ├── freshness-view (back → readiness)
  │     ├── load-ratio-view (back → readiness)
  │     ├── rolling-load-view (back → readiness)
  │     ├── recovery-view (back → home)
  │     │     └── sleep-view (back → recovery)
  │     └── strain-view (back → home)
  ├── sleep-view (back → home)
  ├── recovery-view (back → home)
  ├── activity-detail (back → home)
  ├── coach-view (back → home or plan — caller-controlled)
  └── load-taper-view (back → home or plan)
```

### Design Themes by Page

Each detail page has its own background theme. See `docs/UX_PATTERNS.md` for the full per-page theme table.

| Page | Theme | Palette |
|------|-------|---------|
| Rolling Load | Warm mountains + clouds | Sand/cream/peach |
| Strain | Dark gradient hero | Deep brown/orange |
| Readiness | Mountain mist | Blue-grey/teal/white |
| Recovery | Sky gradient | Sky blue/white |
| Sleep | (TBD) | Cool blue/indigo |
| Freshness | (TBD) | Green/sage |
| Load/Taper | (TBD) | Warm earth |
| Stats | (TBD) | Neutral warm |

---

## Spec Docs

| Doc | Covers |
|-----|--------|
| `docs/PRINCIPLES.md` | Product philosophy, three-signal load model, protection hierarchy, stats display intent |
| `docs/FEATURES.md` | Full feature list with plain-English descriptions and test status |
| `docs/CHANGELOG.md` | Session-by-session change history |
| `docs/recovery-deloading-spec.md` | Recovery scoring, deload logic, adjustment rules |
| `docs/non-event-design-spec.md` | Continuous mode, block cycling, benchmarks |
| `docs/TECH_SPECS.md` | Technical specifications |
| `docs/ENGINE_AUDIT.md` | Engine audit findings |
| `docs/FORECAST_MATRIX_AUDIT.md` | Prediction model audit |
