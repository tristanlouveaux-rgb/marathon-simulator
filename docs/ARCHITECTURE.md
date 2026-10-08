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

**Entry-module isolation (invariant)**: `main.ts` runs `bootstrap()` at module load, so **nothing may import `@/main`**. Shared runtime helpers that views/steps need (`isSimulatorMode`, `awaitStartupSyncs`, `trackStartupTask`, `signalLaunchAppComplete`) live in the leaf module `src/app/runtime.ts`, which imports nothing from the UI/data graph. Importing a helper from `@/main` re-creates a circular import (controller → renderer → review → main.ts → bootstrap → initWizard) that crashed the wizard with a `STEP_ORDER` temporal-dead-zone error (2026-06-15). Guarded by `src/app/entry-isolation.test.ts`.

**iOS 15 regex rule (invariant, 2026-10-06)**: the iOS deployment target is 15.0 (`IPHONEOS_DEPLOYMENT_TARGET`), and WKWebView parses regex lookbehind (`(?<=`, `(?<!`) only from iOS 16.4. A lookbehind literal is a SyntaxError for the whole module that holds it, so one in a statically imported file stops the app loading on iOS 15 to 16.3. App code uses none; check the preceding text in a replace callback instead. Guarded by `src/no-regex-lookbehind.test.ts`, which fails on any lookbehind in a non-test source file.

---

## Module Map

| Module | Purpose | Key Files | Key Exports |
|--------|---------|-----------|-------------|
| `app/` | App-lifecycle leaf module — simulator-mode flag + startup-sync coordination. Imports nothing from the UI/data graph so it never drags in the auto-bootstrapping `main.ts`. | `runtime.ts` | `isSimulatorMode()`, `trackStartupTask()`, `signalLaunchAppComplete()`, `awaitStartupSyncs()` |
| `state/` | Central store + persistence + plan initialization | `store.ts`, `initialization.ts`, `initialization.triathlon.ts`, `persistence.ts`, `hyrox-plan-regen.ts` (HYROX generator-version regen and slot re-keying, 2026-10-06) | `getState()`, `getMutableState()`, `updateState()`, `loadState()`, `saveState()`, `initializeSimulator()`, `initializeTriathlonSimulator()` |
| `workouts/` | Plan generation, scheduling, gym workouts. Triathlon mode adds `plan_engine.triathlon.ts`, `scheduler.triathlon.ts`, `swim.ts`, `bike.ts`, `brick.ts`, `tri-intensity-profile.ts` (race-distance-aware intensity distribution: `TRI_QUALITY_SLOTS`, `TRI_QUALITY_FLAVOUR`, `TRI_BRICK_POLICY`). | `generator.ts`, `plan_engine.ts`, `scheduler.ts`, `gym.ts`, `load.ts`, `plan_engine.triathlon.ts`, `scheduler.triathlon.ts`, `swim.ts`, `bike.ts`, `brick.ts`, `tri-intensity-profile.ts`, `long-run.ts` (long-run slot identity), `planned-adhoc.ts` (planned sessions stored in `adhocWorkouts`), `workout-mods.ts` (one plan change per workout, 2026-10-06), `render-layer.ts` (illness/holiday/bridge layer tags), `rung-load.ts` (`loadForRung`, `loadForTriRun`), `tri-run-pace.ts` (`triRunEasyPaceSec`), `phases.ts` (phase split, `computeRunningPlanPhases`, `taperFraction`), `race-week-layout.ts` (race calendar: race week, closing week, training weeks, forecast horizon, 2026-10-07/08), `race-day-rules.ts` (running race-day placement, taper makeups, stored-plan race window, stored-plan race-week primer day and quality-run spacing), `sharpening-block.ts` (sharpening-block start and live long-run cap) | `generateWeekWorkouts()`, `planWeekSessions()`, `plannedRunMinutesByWeek()`, `isRaceWeek()`, `isRunningDeloadWeek()`, `raceWeekLayout()`, `planTrainingWeeks()`, `storedPlanRaceLayout()`, `applyRaceDayRules()`, `clearStoredPlanRaceWindow()`, `raceWeekPrimerDow()`, `placeStoredPlanRaceWeekPrimer()`, `spaceStoredPlanQualityRuns()`, `buildSharpenBlockState()`, `assignDefaultDays()`, `isLongRun()`, `isPlannedAdhocId()`, `isFourWeekCycleDeloadWeek()`, `generateGymWorkouts()`, `calculateWorkoutLoad()`, `generateTriathlonPlan()`, `scheduleTriathlonWeek()`, `generateSwimSession()`, `generateBikeSession()`, `generateBrick()`, `triQualitySlotIndices()` |
| `calculations/` | VDOT, paces, predictions, fatigue, physiology, TSS/ACWR. Prediction blend composes `prediction-inputs.ts` (Tanda volume+pace; its `recentRun` is the newest race effort, a run more than 15% faster than the window median, since 2026-10-08) + `effort-calibrated-vdot.ts` (HR-calibrated VDOT via Swain regression) into `blendPredictions`. Triathlon adds `triathlon-tss.ts`, `fitness-model.triathlon.ts`, `race-prediction.triathlon.ts`, `activity-matcher.triathlon.ts`, `brick-detector.ts`, `tri-benchmark-history.ts` (FTP/CSS sample append helpers). Injury-aware forecasting shares `injury-recovery.ts` (per-discipline recovery-debit math) across the running and triathlon predictors. | `vdot.ts`, `paces.ts`, `predictions.ts`, `prediction-inputs.ts`, `effort-calibrated-vdot.ts`, `blended-fitness.ts`, `fatigue.ts`, `training-horizon.ts`, `physiology-tracker.ts`, `heart-rate.ts`, `fitness-model.ts`, `injury-recovery.ts`, `triathlon-tss.ts`, `fitness-model.triathlon.ts`, `race-prediction.triathlon.ts`, `activity-matcher.triathlon.ts`, `brick-detector.ts`, `tri-benchmark-history.ts`, `week-activity-log.ts` (shared "what the user did this week" gatherer + dedup; single source for the running/tri/HYROX past-week activity logs), `planned-week-target.ts` (canonical planned weekly load target, 2026-10-05), `race-day-durability.ts` (race-day durability on the plan's prescribed long runs and the marathon endurance-gap check, 2026-10-07), `cross-source-twins.ts` (Apple/Strava same-session rule and collapse, 2026-10-06), `in-app-activity.ts` (in-app GPS and Mark as Done records and their supersede rules), `excess-records.ts` (excess-load record aliases and scrub), `mtl.ts` (HYROX MTL completion, load ratio, chronic vs plan), `tri-suggestion-aggregator.ts` / `tri-suggestion-apply.ts` / `tri-suggestion-handled.ts` (tri plan-change suggestions) | `cv()`, `vt()`, `gp()`, `collectWeekActivities()`, `blendPredictions()`, `computePredictionInputs()`, `computeHRCalibratedVdot()`, `refreshBlendedFitness()`, `calculateLiveForecast()`, `injuryAdjustedBuildWeeks()`, `getRunnerType()`, `applyTrainingHorizonAdjustment()`, `computeWeekTSS()`, `listWeekSignalAEntries()`, `computeFitnessModel()`, `computeACWR()`, `computePlannedWeekTarget()`, `computeCurrentWeekCarry()`, `computeSwimTss()`, `computeBikeTssFromPower()`, `computeBikeTssFromHr()`, `computePerDisciplineFitness()`, `perDisciplineACWR()`, `rebuildTriFitnessFromActivities()`, `predictTriathlonRace()`, `matchTriathlonWeek()`, `detectBricks()`, `appendFtpSample()`, `appendCssSample()` |
| `injury/` | Phase-based injury management + workout adaptation | `engine.ts` | `applyInjuryAdaptations()`, `evaluatePhaseTransition()`, `recordPainLevel()`, `analyzeTrend()` |
| `cross-training/` | Universal load model, workout matching, suggestions, recorded-sport resolution | `universalLoad.ts`, `matcher.ts`, `load-matching.ts`, `suggester.ts`, `activities.ts` | `computeUniversalLoad()`, `applyCrossTrainingToWorkouts()`, `buildCrossTrainingPopup()`, `applyAdjustments()`, `resolveActualSport()`, `resolveAdhocSport()`, `signalARunSpec()` |
| `gps/` | GPS tracking, split detection, recording persistence | `tracker.ts`, `geo-math.ts`, `split-scheme.ts`, `persistence.ts` | `GpsTracker` (class), `haversineDistance()`, `filterJitter()`, `buildSplitScheme()` |
| `recovery/` | Morning check-in, sleep/readiness scoring | `engine.ts` | `computeRecoveryStatus()`, `sleepQualityToScore()`, `RecoveryEntry`, `RecoveryLevel` |
| `ui/` | Dashboard, renderer, events, wizard, modals. Triathlon mode renders from `ui/triathlon/`. | `main-view.ts`, `renderer.ts`, `events.ts`, `wizard/controller.ts`, `wizard/steps/triathlon-setup.ts`, `activity-review.ts`, `welcome-back.ts`, `triathlon/{plan-view,home-view,stats-view,progress-detail-view,tab-bar,workout-card,race-forecast-card,colours}.ts`, `workout-status.ts` (shared plan-card status chip — Done/Logged/Missed/Today, used by all three modes), `race-day-card.ts` (display-only race-day card for every mode's Plan tab and Home Today, 2026-10-08) | `renderMainView()`, `render()`, `next()`, `rate()`, `skip()`, `initWizard()`, `showActivityReview()`, `detectMissedWeeks()`, `showWelcomeBackModal()`, `renderTriathlonPlanView()`, `renderTriathlonHomeView()`, `renderTriathlonStatsView()`, `renderTriProgressDetailView()` |
| `constants/` | Static config, protocols, sport DB, training params. Triathlon adds `triathlon-constants.ts` and `transfer-matrix.ts`. | `index.ts`, `injury-protocols.ts`, `sports.ts`, `training-params.ts`, `triathlon-constants.ts`, `transfer-matrix.ts`, `intensity-ladder.ts` (canonical running pace ladder `RUN_PACE_LADDER`, `stepDownRunType`, `RUN_GENERATOR_RPE`, 2026-10-06; the bike and swim ladders stay in `triathlon-constants.ts`) | `INJURY_PROTOCOLS`, `SPORTS_DB`, `TRAINING_HORIZON_PARAMS`, `TRANSFER_MATRIX`, `COMBINED_CTL_WEIGHTS`, `DEFAULT_VOLUME_SPLIT_BY_DISTANCE`, `RACE_LEG_DISTANCES`, `RUN_FATIGUE_DISCOUNT` (Record), `getTriDistanceLabel`. `TriathlonDistance` has five members — sprint / olympic / t100 / 70.3 / ironman (`ALL_TRI_DISTANCES`) |
| `types/` | All TypeScript interfaces and type unions. Triathlon adds `triathlon.ts`. | `state.ts`, `injury.ts`, `onboarding.ts`, `training.ts`, `activities.ts`, `gps.ts`, `triathlon.ts` | `SimulatorState`, `Workout`, `InjuryState`, `OnboardingState`, `TrainingPhase`, `EventType`, `Discipline`, `TriathlonDistance`, `TriConfig`, `TriSkillRating`, `TriVolumeSplit`, `TriRacePrediction` |
| `coach/` | BYOK AI coaching layer — key storage, context serialization, tool definitions, streaming client | `api-key-store.ts`, `prompt-sanitizer.ts`, `coach-context-builder.ts`, `coach-tools.ts`, `coach-chat-client.ts` | `storeApiKey()`, `getApiKey()`, `clearApiKey()`, `hasApiKey()`, `sanitizeField()`, `buildCoachContext()`, `buildRunningCoachContext()`, `buildTriathlonCoachContext()`, `COACH_TOOLS`, `validateAndBuildPendingChange()`, `applyPendingChange()`, `streamCoachChat()`, `buildSystemPrompt()`, `testApiKey()` |
| `data/` | Static data, Supabase client, wearable sync, source routing | `marathons.ts`, `triathlons.ts`, `race-calendar.ts` (annual roll-forward of passed race dates; HYROX excluded), `supabaseClient.ts`, `activitySync.ts`, `stravaSync.ts`, `appleHealthSync.ts`, `physiologySync.ts`, `physiology-provenance.ts` (Apple gap-fill field ownership), `sources.ts` (`appleWorkoutsEnabled`), `apple-strava-twin-cleanup.ts`, `activity-sync-window.ts` (`ACTIVITY_SYNC_LOOKBACK_DAYS` = 28), `trimp-sex-gate.ts` (onboarding sync hold until the sex is final) | Marathon catalog, `releaseAppleOwnership()`, `syncActivities()`, `syncStravaActivities()`, `syncAppleHealth()`, `syncAppleHealthPhysiology()`, `syncPhysiologySnapshot()`, `getActivitySource()`, `getPhysiologySource()` |
| `utils/` | Formatting, helpers, platform detection, device-local day keys | `format.ts`, `helpers.ts`, `platform.ts`, `local-date.ts` | Time/pace formatting (`fmtDurationMin()`: prose durations, minutes under an hour, h:mm from an hour), platform checks, `localDateKey()`, `isOnLocalDay()`, `localMondayKey()`, `calendarDaysBetween()` (the activity-day rule since 2026-10-07) |
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
        → planStartDate = localMondayKey(now); planCreatedAt = localDateKey(now)
        → race plan: raceWeekLayout(planStart, raceDate) → s.tw = calendarWeeks;
          a Monday-Wednesday race appends a closing week (raceClosing, ph 'taper')
        → builds initial s.wks[] array with phase assignments
          (race plans: computeRunningPlanPhases over the training weeks)
        → sharpening block (marathon < 8 / half < 4 training weeks):
          s.sharpenBlock = buildSharpenBlockState(...)  (frozen start long run)
          and the forecast anchor moves to the block's own peak week (plannedPeakWeeklyKm)
        → s.raceDayDurability = raceDayPlanDurability(s)  (durability on the plan's long runs)
  → SimulatorState ready → renderMainView()
```

Triathlon, cycling and HYROX initializers write the same local anchors and set `s.tw = racePlanCalendarWeeks(raceDate)` when a race date exists; their generators read race week and the closing week from `storedPlanRaceLayout(tw, planStartDate, raceDate)` (null when the stored length does not match, which keeps the final week as race week).

**Just-Track mode** is the same infrastructure as any non-event `continuousMode` user, with one rolling week bucket that extends on calendar advance. Plan generation is suppressed and a handful of view surfaces hide prescription UI — that is the entire difference. The flag lives on both `OnboardingState.trackOnly` and `SimulatorState.trackOnly`.

**What track-only users see:**
- `getHomeHTML` → `getTrackOnlyHomeHTML`: no today-workout, no race-forecast, no Coach/Check-in. Shows `buildTrackOnlyDailyTarget` (CTL/7 × readiness, Gabbett-band coloured), `buildReadinessRing` (retained — informational), weekly volume card, sync, recent activity, "Create a plan" CTA.
- `renderPlanView` → `getTrackOnlyPlanHTML`: retrospective log of the current week + rolling history of prior weeks. No forward planning.
- `buildStatsSummary` (2026-05-29 rebuild, mirrors triathlon stats): hero + `buildRunningNumbersCard` (LT + VO2 Max teal zone bars, each drilling to its metric page) + `buildProgressSection` (Recent-weeks summary → Progress detail, plus a CTL trend). Same layout for track-only and planned. Bars route via `[data-metric-detail]` in `renderStatsView`, with Back rebound to the Stats opening.
- `showWeekDebrief` → `showTrackOnlyRetrospective`: compact this-vs-last-week deltas (distance, sessions, TSS, CTL, recovery avg).

**What's unchanged:** Strava / Garmin / Apple sync, activity matching, GPS recording, physiology polling, readiness computation, CTL/ATL/TSB, ACWR. All of these write into the same `wk.garminActuals` / `adhocWorkouts` / `rated` buckets that planned users have — there is no parallel track-only data store.

**Calendar extension**: `advanceWeekToToday` branches on `s.trackOnly` and extends `s.wks` one week at a time with `ph:'base'` (phase is meaningless for trackOnly — views hide it). Planned `continuousMode` users continue to get 4-week base/build/peak/taper blocks.

**Mode switching**: `upgradeFromTrackOnly()` (track → plan) and `downgradeToTrackOnly()` (plan → track) live in `wizard/controller.ts`. Both flip `onboarding.trackOnly` then route through the `initializing` step. The mode-change guard there (`!!onboarding.trackOnly !== !!s.trackOnly`) forces `initializeSimulator` to re-run rather than short-circuit on the existing-plan path. Both directions preserve `s.ctlBaseline`, PBs, physiology, and Strava / Garmin / Apple connections; the inactive direction's wks are dropped from local state but remain in server-side `garmin_activities`. Triggers: Account → Advanced (both directions), home race-complete banner (downgrade only), home Create-a-plan link / plan-tab CTA (upgrade only).

**Science log**: the CTL/7 × readiness daily target and Gabbett colour bands are documented in `docs/SCIENCE_LOG.md → "Just-Track Daily Load Target"`.

### 2. Weekly Generation (every render)

```
render()
  → compute currentVDOT = s.v + cumulative wkGain + s.rpeAdj
  → gp(currentVDOT, s.lt) → update paces (with s.lt set every zone is a ratio of LT
    and VDOT is not read; recomputeLT derives s.lt from getPhysiologicalVdot, not s.v)
  → generateWeekWorkouts(phase, runsPerWeek, raceDistance, runnerType, ...)
    → closing week (isClosingWeek, race plans only) → return []
    → engine horizon = planTrainingWeeks (s.tw without a closing week)
    → planWeekSessions(ctx) → SessionIntent[]
        (buildWeekSessions(ctx, nominalHistory(ctx)): earlier weeks replayed from the
         static inputs; a sharpening block routes to buildSharpeningWeek)
    → intentToWorkout() for each intent → Workout[]
    → add commute runs, recurring activities, makeup skips
        (taper weeks: filterTaperMakeups drops long/quality makeups,
         fitTaperEasyMakeups sizes easy ones under taperMakeupRoom)
    → generateGymWorkouts(..., continuousMode) → append gym Workout[]
    → calculateWorkoutLoad() for each workout
    → assignDefaultDays(workouts)
    → applyRaceDayRules (race plans with a matching planRaceLayout; it changes only
      weeks within 13 days of race day)
    → applyInjuryAdaptations(workouts, injuryState) → recalculate loads
    → race plans: drop anything dated on or after race day again (rule 1, after
      the injury engine's day assignment)
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
| VDOT/fitness | `v` (live blended VDOT — refreshed weekly via `refreshBlendedFitness`; held during taper). Logic writers (list re-checked at 2026-10-07; whole-state replacement, i.e. store `setState`/`resetState` to the default 50 and the Supabase backup restore, also sets `s.v`): (1) `refreshBlendedFitness` (`blended-fitness.ts`): the blended write-back on every launch (`:718`), skipped in weeks labelled `taper` (race taper, continuous-mode block deload, double-periodisation recovery) and in run-blocking injury weeks, plus the HR-calibrated pre-blend (`:486`, medium/high confidence, only while no race distance is set). (2) Detraining: `advanceWeekToToday` (`welcome-back.ts:146`), `showWelcomeBackModal` (`welcome-back.ts:461`, exported but with no caller today) and the holiday return `showHolidayWelcomeBack` (`holiday-modal.ts:1351`). (3) The one-time short-holiday repair at launch (`main.ts:1152`, adds back 0.6, guarded by `_holidayRepairDone`). (4) Plan init: `initialization.ts:635`, `ui/events.ts:326` and `initialization.triathlon.ts:217` (past-race run-leg VDOT, only when `s.v` is unset). `loadState` performs no s.v repair (removed 2026-10-05, audit X11). `iv` (initial at onboarding; written only by the running init, so outside running mode it is the store default 50 and means nothing), `rpeAdj`, `physioAdj`, `expectedFinal`, `blendedRaceTimeSec`, `blendedEffectiveVdot`, `blendedLastRefreshedISO`. Read via `getEffectiveVdot(s)` which layers `rpeAdj + physioAdj` on top of `s.v`. |
| Race config | `rd` (race distance), `rw` (runs/week), `gs` (gym sessions), `epw` (exercises/week), `wkm` (weekly km) |
| PBs & recent | `pbs` (PBs object), `rec` (RecentRun) |
| Physiology | `lt` (LT pace sec/km), `vo2` (VO2max), `maxHR`, `restingHR` |
| Race times | `initialBaseline`, `currentFitness`, `forecastTime` |
| Runner profile | `typ` (RunnerType), `b` (fatigue exponent) |
| Training data | `pac` (Paces), `skip` (skip tracking), `timp` (time impact) |
| Injury | `injuryState` (InjuryState), `rehabWeeksDone`, `lastMorningPainDate` |
| Continuous mode | `continuousMode`, `blockNumber`, `benchmarkResults` |
| Race plan (2026-10-07) | `sharpenBlock?: { v, startLongMin, startSource: 'history-30d' \| 'history-no-recent-run' \| 'no-data', recentLongestMin, noSignal, trainingWeeks, builtISO }`: the sharpening block's inputs frozen at build (`buildSharpenBlockState`); written only by `initializeSimulator` (cleared for any other running plan; the triathlon, cycling, HYROX and Just-Track paths leave it in place, ISSUE-370). `raceDayDurability?: RunDurabilityResult`: the race-day durability result the forecast applied (`raceDayPlanDurability`), read by the Durability drill-down; written by `initializeSimulator` and rewritten by `refreshBlendedFitness` (`blended-fitness.ts:824`), which clears it outside running race plans. For a race plan `tw` counts calendar weeks through race day, closing week included; read training weeks through `planTrainingWeeks(s)`. |
| Recovery | `recoveryHistory` (RecoveryEntry[]), `lastRecoveryPromptDate` |
| Adaptive recovery | `adaptiveRecovery?: AdaptiveRecovery` — learned `kUserHours` + confidence band (none/low/medium/high), updated weekly; `sessionImpactLog?: SessionImpactEntry[]` — rolling 90-day evidence per completed session (predicted vs observed hours-to-baseline). Fitter at `src/calculations/adaptive-recovery.ts`. Population default of 8 falls back when confidence < medium. |
| Integrations | `wearable` (legacy), `connectedSources?: { activity?, physiology? }` — use accessors in `src/data/sources.ts`; `stravaConnected?: boolean` — when true, Strava is the activity source regardless of wearable; `biologicalSex` (`'male' \| 'female' \| 'prefer_not_to_say'`) — for iTRIMP β; never read directly for β, always through `trimp.ts:resolveBiologicalSex(s)` (wizard answer while onboarding, then `s.biologicalSex`); `appleHeartRatePermissionRequested?` — device-local one-time flag for the Heart Rate re-prompt (2026-10-05); `supersededGarminIds?: string[]` — Apple ids whose Strava twin won, kept apart from the user's `ignoredGarminIds` and filtered at ingest (2026-10-06); `appleStravaTwinCleanupDone?` — gates the one forced `garmin_activities` twin cleanup (2026-10-06) |
| Week (`Week`, per plan week) | `actualTSS` is **retired** (2026-10-06, audit B18): a week's actual load is always derived by `computeWeekActualTSS(wk, planStartDate)` (`fitness-model.ts:662`) = `computeWeekRawTSS(wk, wk.rated)`, canonical Signal B without carry; `recentWeeksActualTSS(wks, currentWeek, count)` gives a trailing window ending at the current week. `persistence.stripRetiredWeekTotals` deletes legacy keys from `wks` and `previousPlanWks[].weeks` on load, and a source-scan test (`week-actual-load.test.ts`) rejects writes. Still stored: `actualImpactLoad` (add-only), `carriedTSS` (no live reader). New optional: `triSuggestionsHandled?: { modIds, crossTrainingTSS }` (tri notify-once record, 2026-10-06); `raceClosing?: boolean` (the closing week of a Monday to Wednesday race: holds only the race, ph 'taper', nothing generated; read by `planTrainingWeeks` / `isClosingWeek`, 2026-10-07); `raceWindowCut?: Array<{ discipline, estimatedDurationMin }>` (triathlon: sessions the race window removed from the week before race week, effort-scaled, forecast dose only, never scheduled or shown, 2026-10-08). |
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
longRun?: boolean  — stamped by the generator on the long-run slot in every variant; read only via isLongRun() (src/workouts/long-run.ts)
longRide?: boolean — triathlon/cycling solo long ride (not in race week); a long session for the race window (isTriLongSession)
```

Related 2026-10-06 fields: `WorkoutMod.previousMod?` (the mod an `upsertWorkoutMod` write replaced; `removeWorkoutMods` restores it), a `renderLayer` tag on sessions in the plan-layer week (`src/workouts/render-layer.ts`; plan values kept), and `GarminActual.manualSport?` (sport of an in-app record or a reclassified activity; `resolveActualSport` reads it first). Every `wk.triWorkouts` session in triathlon, cycling and HYROX now has an id (`W{week}-{type}-{idx}`; user-added HYROX sessions `adhoc-`).

### InjuryState (`src/types/injury.ts`)

Phase-based recovery: `active`, `injuryPhase`, `currentPain` (0–10), `history` (pain entries), `capacityTestsPassed`, `returnToRunLevel` (1–8), `zeroPainWeeks`, `graduatedReturnWeeksLeft`.

### OnboardingState (`src/types/onboarding.ts`)

Wizard data: `name`, `raceDistance`, `trainingForEvent`, `runsPerWeek`, `gymSessionsPerWeek`, `experienceLevel`, `pbs`, `ltPace`, `vo2max`, `continuousMode`, `recurringActivities`, `hasSmartwatch`, `watchType` (`'garmin' | 'apple' | 'strava'`), `biologicalSex` (`'male' | 'female' | 'prefer_not_to_say'` — for iTRIMP β, collected on physiology step).

### TrainingPhase

`'base' | 'build' | 'peak' | 'taper'`

Phase assignment is centralised in `src/workouts/phases.ts` (`computePlanPhases(totalWeeks, config?)`). The strategy is `PhaseConfig`-driven so running, triathlon, and HYROX share the same algorithm with format-specific caps and ratios. Two strategies:
- **Single arc**: capped allocation — base absorbs the remainder after taper/peak/build caps. Format-specific caps: running taper ≤ 3 / peak ≤ 4; tri taper ≤ 2 / peak ≤ 5; HYROX taper ≤ 2 / peak ≤ 3; build ≤ 8 for all. Very short plans (4–7w) naturally collapse base to a sharpening block.
- **Double periodization** (threshold: 33w running, 28w tri/hyrox): cycle 1 (~45%) ends in a **Checkpoint** week (`wk.checkpoint = true`, `wk.ph = 'peak'`), 2-week inter-cycle taper (labelled `'taper'` so the workout generator's existing taper volume drop fires automatically), cycle 2 (~55%) carries the race.

Too short for one week of each phase (1 or 2 weeks), `computeSingleArc` allocates the taper first: 1 week = [taper], 2 weeks = [peak, taper] (2026-10-07, every format).

Entry points per format:
- Running race plans: `computeRunningPlanPhases(trainingWeeks, rd, { noSignal })` (`phases.ts:132`): a marathon or half under `FULL_BUILD_WEEKS` (8 / 4) is a sharpening block (taper first, one peak week, build, no base); otherwise `computePlanPhases` with `RUNNING_MARATHON_PHASE_CONFIG` (2-week taper floor, `MARATHON_MIN_TAPER_WEEKS`) for the marathon or `RUNNING_PHASE_CONFIG`. Read over the training weeks; a closing week is labelled 'taper'.
- Running continuous plans: `computePlanPhases(totalWeeks)` (uses `RUNNING_PHASE_CONFIG`), then the 4-week block labels.
- Triathlon: `computeTriPlanPhases(distance, totalWeeks)` in `triathlon-constants.ts`
- HYROX: `computeHyroxPlanPhases(totalWeeks)` in `hyrox-constants.ts`

The legacy `s.racePhaseStart` field (running-only — used to split plans into a 4-week block-cycle prefix + 16-week race-specific arc) is deprecated; persistence migrates affected plans on next launch.

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
| `s.strengthLog` | Per-lift working-weight memory + est-1RM benchmark | `StrengthLog \| undefined` |
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

### `resolveWeekWorkouts()` — canonical week resolution (`src/ui/week-resolve.ts`)

`generateWeekWorkouts()` produces the *base* week (including injury adaptations — `resolveWeekWorkouts` passes `s.injuryState`, gated forward-only inside the generator via `injuryAppliesToWeek`, ISSUE-261). The fully-resolved week a user sees layers render-time modifiers on top, in this order: adhoc/holiday-injected sessions → `workoutMods` (stable-id match via `findWorkoutForMod`, timing mods by name) → `workoutMoves` (drag reorders) → illness suppression (current week) → holiday suppression → comeback-bridge scaling → **`dropPreOnboardSessions`** (mid-week onboarding: drop the current week's sessions on days before the user joined, so week 1 starts today — keyed off `firstTrackedDow` in `workout-status.ts`; no-op for established plans and non-current weeks). `resolveWeekWorkouts(s, viewWeek)` is the single, side-effect-free source for that resolved list.

**Any running-mode surface that asks "what is this week's plan?" must call `resolveWeekWorkouts`, not re-derive it.** The Plan tab's `computeRenderedWorkouts` (plan-view.ts) delegates to it then populates its drag-and-drop `_workoutLookup`; the Home Today card (`buildTodayWorkout` / `buildNoWorkoutHero` in home-view.ts, including the "Next:" line) reads from it directly. Home can't statically import plan-view (plan-view imports home-view), which is why the resolver lives in its own module rather than being exported from plan-view. Re-implementing a partial version of this was the cause of the Home "Next:" line skipping intermediate sessions (CHANGELOG 2026-06-03).

**Plan-layer week for mod writers (2026-10-06, audit A2/X12)**: `resolveWeekWorkouts(s, week, { renderLayers?: boolean })`. The illness, holiday and bridge steps are display only. `resolveWeekForPlanChanges(s, week)` (`week-resolve.ts:182`) is `{ renderLayers: false }`: generation, planned adhoc, mods, moves and the pre-onboarding drop, with each session a layer would adjust tagged `renderLayer` and its plan values kept (the layers run on a shallow copy and tags map back by index, which relies on no layer adding, removing or reordering sessions). **Every mod writer reads it**: activity-review `getWeekWorkoutsForPlanChange` and the Tier-1 trim, main-view `getWeekWorkoutsForACWR`, the excess-load adjustment, the GPS extra-run suggester, log-activity-overlay, `mergeTimingMods` and `applyRecoveryAdjustment`. **Matching and display read the full resolver**: the matcher, review slots, Plan, Home, the recovery sheets, and the ACWR projection. `hasRunningPlanWeek(s)` (`:194`) is false for Just-Track, triathlon (cycling) and HYROX; `resolveWeekForPlanChanges`, `getWeekWorkoutsForPlanChange` and `triggerACWRReduction` return empty or early then, because `resolveTriWeekWorkouts` never applies `wk.workoutMods` and Just-Track has no plan. Mods go through `upsertWorkoutMod` (`src/workouts/workout-mods.ts:78`): one non-timing, non-user mod per workout keyed on `workoutId`, replaced or stacked mods chained on `previousMod`; user Adjust mods (`userScaledAt`) are never overwritten by automatic changes.

### `resolveTriWeekWorkouts()` — tri/cycling/HYROX week resolution (`src/ui/triathlon/week-resolve.triathlon.ts`)

The scheduled-mode mirror of `resolveWeekWorkouts`. All three modes store their plan in `wk.triWorkouts`; the resolver assembles `triWorkouts + adhocWorkouts` and applies the render-time mods in the order both plan views previously inlined: illness (current week, `applyIllnessMods`) → holiday (`applyHolidayModsAllDisciplines`) → comeback-bridge (`applyBridgeModsAllDisciplines`) → `dropPreOnboardSessions` (same mid-week-onboarding filter as running). Injury needs no handling here — logging a tri/cycling/HYROX injury regenerates the stored current+future weeks (injury/modal.ts).

**Clone contract**: deep-clones by default (idempotent, safe for read-only consumers); the tri + HYROX plan-views pass `{ clone: false }` because their click/drag handlers re-read `wk.triWorkouts` directly and rely on render mods being visible on those shared objects. `estimateTriWorkoutMin` (same module) is the shared duration estimator both plan views import.

### `getPlannedDayTSSContext()` — canonical planned-day TSS (`src/ui/planned-day-tss.ts`)

The single, **mode-aware** source for "what does the plan prescribe on day X, in TSS terms?". Running delegates to `resolveWeekWorkouts` + `computePlannedDaySignalBTSS`; tri/cycling sums `aerobic + anaerobic` per workout (same number as the plan card badge); HYROX falls back to duration × `TL_PER_MIN[rpe]` (MTL-only workouts); just-track returns zeros. Excludes synced actuals (`garmin-`/`strava-` ids, `garminTimestamp`) and illness/holiday-rested sessions. Consumers: Home strain ring (home-view.ts), Strain view ring + week bars (strain-view.ts), Readiness card (readiness-view.ts), `deriveStrainContext` (daily-coach.ts — the one calc→ui import; nothing in the resolver chain imports daily-coach, so no cycle). **Any new surface that shows a daily/weekly planned-TSS target must read this context** — regenerating a week via `generateWeekWorkouts` at a display site is the bug this replaced (phantom running targets in tri mode, CHANGELOG 2026-06-03).

Running sessions are priced per workout by `computePlannedWorkoutSignalBTSS(w, baseMinPerKm)` (`fitness-model.ts`); `computePlannedDaySignalBTSS` sums it, and the Plan tab card reads it through `planCardPlannedTSS` (`plan-view.ts`). `isUnscheduledPlannedWorkout(w)` (status 'replaced' or 'skipped') prices at 0. `resolveCtlAdherence` revalues planned gym/strength sessions at `signalARunSpec('strength')` so the planned side is in Signal A currency (2026-10-05).

### `computePlannedWeekTarget()` — canonical weekly load target (`src/calculations/planned-week-target.ts`)

Planning side. The single source for "what is plan week N prescribed to load", in canonical TSS (2026-10-05, audit A10/A11). `computePlannedWeekTarget(s, weekNum, signal = 'B' | 'A')` resolves the effective phase with `resolvePlannedWeekPhase`: deload from `forceDeload || isDeloadWeek(weekNum, abilityBandFromVdot(s.v || 45, experienceLevel || 'intermediate'))` for running (the inputs `resolveWeekWorkouts` hands the generator), or `forceDeload || isFourWeekCycleDeloadWeek(weekNum, ph)` for triathlon (cycling) and HYROX; the race taper is the last contiguous 'taper' run of a non-continuous plan, at its 1-indexed position since 2026-10-06 (1 = first taper week, taper length = race week; `taperMultiplier` gives 0.75 / 0.65 / 0.55 over 3 weeks, 0.70 / 0.55 over 2, and 0.70 for 1); any other 'taper' week is a deload; Just-Track never deloads. It then calls `computePlannedSignalB` (signal B, compare with `computeWeekRawTSS`) or `computePlannedWeekTSS` (signal A, compare with `computeWeekTSS`; daily coach only). The phase multiplier scales only the history-median term; in signal B that is the running-only median, and the cross-training budget (`sportBaselineByType`) is added unscaled in every phase. The surfaces that display the target are running-plan views (Plan card and Adjust-week strip, Load & Taper, `week-debrief.ts`, Stats forecast). Triathlon (cycling) and HYROX route to their own Plan, Load, Stats and debrief views, none of which reads it; there it reaches the user only through the daily coach's signal A figure (`planned_week_tss` in `coach-context-builder.ts`). `computeCurrentWeekCarry(s, weekNum)` returns 0 unless `weekNum === s.w` and passes a per-week target resolver to `computeDecayedCarry`, whose `plannedBaseline` is now `number | (weekNum) => number`; the number form survives only for activity-review's phase-independent `signalBBaseline`.

**Rule**: no UI or state file calls `computePlannedSignalB`, `computePlannedWeekTSS` or `computeDecayedCarry` directly. The anchor test in `planned-week-target.test.ts` greps for violations. Consumers: Plan week-summary card and Adjust strip, Load & Taper, week debrief, excess-load adjustment (`excess-load-card.ts`; its Tier 2 card is not rendered), ACWR reduction projection (`acwr-reduction-projection.ts`, which gates the Home adjust button in running mode), week-advance settle (`events.ts`), launch carry-over (`persistence.ts`), daily coach, Stats forecast. Home's weekly-target row (`buildProgressBars`) and the excess-load card have no caller (ISSUE-325). Imports: fitness-model and plan_engine only (light, no cycle with `persistence.ts`); `plan_engine.ts` exports `isFourWeekCycleDeloadWeek`, which the tri and HYROX engines import instead of private copies.

### `isLongRun()` — long-run slot identity (`src/workouts/long-run.ts`)

True for `t: 'long'`, or for `longRun === true` while `t` is still one of the slot's generated formats ('long', 'progressive'). The generator (`intentToWorkout`, both long variants, and the legacy generator long slot) sets the stamp. **Never test `t === 'long'` for long-run identity on running workouts**; call `isLongRun`. Consumers: `scheduler.assignDefaultDays`, timing-check, suggester (`PlannedRun.longRun` via `workoutsToPlannedRuns`), planSuggester, legacy matcher, injury engine, `events.ts` skip/next (the stamp is carried into `wk.skip`), plan-view and renderer skip buttons, matching screen, renderer matched banner, recording handler, `PlannedDayWorkout.longRun` (planned-day-tss) and `StrainContext.todayPlannedWorkout.longRun` (daily coach). Tracking-side samples (HR drift, durability flag, LT efficiency, MP pace drift) deliberately stay `plannedType === 'long'` only.

### `isPlannedAdhocId()` — planned sessions in `adhocWorkouts` (`src/workouts/planned-adhoc.ts`)

`wk.adhocWorkouts` holds done activities (`garmin-<id>`, GPS UUIDs, manual logs) and planned injected sessions (`adhoc-`, `holiday-`, `benchmark-`). `PLANNED_ADHOC_ID_PREFIXES` lists the planned prefixes once. Every load reader (`computeWeekRawTSS`, `computeTodaySignalBTSS`, `getDailyLoadHistory`, double-day, Home `computeLoadBreakdown`) skips them; the plan resolver (`week-resolve.ts`) and status chips (`workout-status.ts` `isAdded`, plan-view "Added" + Remove) render them as plan cards; the holiday bridge scaler and the Home Recent filter use the same helper. A new planned-session prefix goes in this list, nowhere else.

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

**Load currency invariant (ISSUE-263, SCIENCE_LOG §BP)**: the canonical unit app-wide is TSS (1h@LT=100, `TL_PER_MIN`). Every load producer emits TSS or converts at its own ingest boundary — `normalizeiTrimp` (personal, plausibility-gated) for iTRIMP, `garminToTssRatio(rpe)` for raw Firstbeat loads, `plannedTssPerMin(type)` for planned sessions. No consumer rescales. universalLoad's four tiers all emit TSS (measured tiers take no sport multiplier — the measurement already reflects the sport; only the Tier C RPE estimate is sport-corrected). Saturation is the slope-1 form `TAU(1−e^(−x/TAU))` so credit ≤ load. Regression guard: `src/calculations/load-currency-anchors.test.ts` (17 anchors incl. a filesystem grep for hardcoded normalizers).

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

**Mode-aware modal routing** (v2, 2026-05-01): in triathlon mode (`s.eventType === 'triathlon'`), the running suggestion modal (`showSuggestionModal`) is suppressed and cross-training overload is surfaced via `tri-suggestion-modal.ts`. The tri modal renders a per-discipline chip switcher, defaults to **run** (most cross-training is leg-impact-loaded; affinity overrides only for cycling → bike, swimming → swim), and offers Reduce / Replace & Reduce / Keep / Push-to-next-week buttons mirroring running. Push-to-next-week stores the cross-training TSS on `wk.carriedCrossTrainingTSS`; `computeDecayedTriCarry` exponentially decays it (7-day τ) and the next week's detector adds the decayed residual to its overshoot calc. Banner on tri home view shows the live decayed value. Routing happens at four sites:
- `activity-review.ts` — `redirectToTriSuggestionFlow` helper persists items as adhocs and shows the tri modal.
- `events.ts:logActivity` — tri-mode branch persists the manual log + shows the tri modal.
- `main-view.ts:triggerACWRReduction` — tri-mode early-return (tri uses per-discipline volume ramps, not run ACWR).
- `excess-load-card.ts:triggerExcessLoadAdjustment` — defensive early-return.
The tri detector is `src/calculations/tri-cross-training-overload.ts`; it sums non-tri-discipline TSS and fires when the cross-training contribution exceeds 15% of planned weekly tri TSS. See ISSUE-151 in OPEN_ISSUES.md (✅ FIXED 2026-04-30) for the full audit and SCIENCE_LOG.md for the threshold rationale.

**Downgrade ladder (2026-10-06, P2)**: `src/constants/intensity-ladder.ts` is the canonical running pace ladder: `RUN_PACE_LADDER` (recovery < easy < marathon_pace < threshold < vo2), `runPaceRung`, `stepDownRunType(type, steps, { longRun })` (a long-run-slot result on the easy rung is written 'long') and `RUN_GENERATOR_RPE` / `generatorRpeForRunType`. Rungs mirror the `TSS_RPE_BY_TYPE` valuation rows, and a test pins the two. Readers: `timing-check.ts` (day-after suggestion; `applyTimingDowngradesFromWorkouts` takes an optional easy pace, which `mergeTimingMods` passes as `s.pac?.e`), `suggester.ts` (`downgradeType`, the generator-RPE stamp in `applyAdjustments`), `planSuggester.ts` (legacy, test-only) and `tri-suggestion-apply.ts` (tri run legs). The user Adjust control keeps its own `INTENSITY_LADDER` in `workouts/workout-scaling.ts` (ISSUE-350). `RUN_PACE_FACTOR_VS_EASY` gained a 'recovery' key (1.12). Excess-load records: `src/calculations/excess-records.ts` (`collectActivityAliases`, `scrubExcessRecords`, `addUnspentItemOnce`) serves remove, Unmark (`unratePlanSlot`, `events.ts`) and re-review, so an activity's records go under every id it carried and surplus slices are appended once.

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

### Route Safety Ratings (`src/gps/anonymize-route.ts`, `src/data/safetyRatingSync.ts`)

Post-run data collection to power a future women's night-running safety map.

- **Trigger (live GPS)**: GPS completion modal (`src/ui/gps-completion-modal.ts`) — after RPE selection, optional safety slider (1–10 or N/A) shown for routes >= 1km.
- **Trigger (imported)**: activity detail (`src/ui/activity-detail.ts`) — "Rate this route's safety" pill on any activity with a polyline.
- **Privacy**: `trimRouteEnds()` strips ~300m from start and end of the raw GPS trace before storage, protecting home/work locations.
- **Encoding**: trimmed `LatLng[]` → Google Polyline string via `encodePolyline()`. Decoder `decodePolylineToLatLng()` mirrors the inline decoder in `strava-detail.ts`.
- **Storage**: Supabase table `route_safety_ratings` — score (nullable), trimmed polyline, bounds, centre, source, `rater_gender`. RLS: user sees only own rows. Future map reads aggregated data via service-role edge function.
- **Supabase migration**: `supabase/migrations/20260507000001_route_safety_ratings.sql`

### GPS Tracking (`src/gps/`)

`GpsTracker` is a state machine: **idle → acquiring → tracking → paused → stopped**.

- Provider abstraction: `native-provider.ts` (Capacitor), `web-provider.ts` (browser), `mock-provider.ts` (dev)
- Points are jitter-filtered (`filterJitter()`), distances via Haversine
- Split detection: `buildSplitScheme()` is a derived view over `buildTimeline` — see "Guided Runs" below
- Recordings persisted to localStorage with an index
- Completion (2026-10-06): `handleCompletedRecording` (`recording-handler.ts`) writes an in-app record (`guided-gps_<ts>`) through `writeInAppActual`, so the run counts as load. In triathlon, cycling and HYROX it matches the started card among the run sessions of `resolveTriWeekWorkouts`, writes the record under the slot key with a completion rating in `wk.rated` (not `rate()`, so no running VDOT change), and runs `reconcileTriCompletions` in triathlon; impromptu runs are offered unrated tri or HYROX run sessions and never reach the running suggester.

### Guided Runs (`src/guided/`, `src/gps/split-scheme.ts`)

Voice/haptic coaching and on-screen split cues share a single parser so the two views cannot diverge.

- `buildTimeline(workout, paces)` in `src/guided/timeline.ts` is the **single source of truth** for interpreting `workout.d`. It emits a `Timeline` of typed `Step`s (`warmup` | `work` | `recovery` | `cooldown` | `easy` | `long`) with pace targets and rep indices.
- `buildSplitScheme(workoutDesc, paces)` in `src/gps/split-scheme.ts` is a **thin adapter over `buildTimeline`**. It maps each step to one or more `SplitSegment`s: reps become a single paced segment, recoveries become untimed segments with `durationSeconds`, warm-up/cool-down become a single paced segment at easy pace, and single-block distances (e.g. `20km @ MP`, `8km`) are expanded into per-km splits.
- Adding a new workout format means extending `parseMainSet` in `timeline.ts`; `split-scheme.ts` picks it up automatically via the adapter. Never add a parallel regex path in split-scheme.

### Guided Strength Session (`src/guided/strength-*.ts`, `src/ui/guided-strength-overlay.ts`)

Strength is a separate flow from guided runs — wall-clock + tap driven, no GPS / paces. Reuses `VoiceCoach`, `keep-awake`, and the completion path (`rate()` with `expected === rpe` to avoid VDOT shift), but its own model + controller + overlay.

- `parseStrengthSession(workout)` in `strength-model.ts` is the **single source of truth** for interpreting a strength `workout.d` (newline-separated `"{sets}x{reps} {Name} ({cue}) ({rest})"` lines). Expands each line into a flat `GuidedSet[]`; the closing stretch line is captured separately.
- `StrengthGuideController` in `strength-controller.ts` is the wall-clock state machine (`idle → active → resting → … → done`). Distinct from `GuideController` (GPS-tick). Timer is injectable so the logic is unit-tested.
- `completeStrengthSession(workout, opts)` in `strength-complete.ts` is the **single completion write** — wraps `rate()` to set `wk.rated[id] = rpe` mode-agnostically.
- `openGuidedStrength(workout)` in `guided-strength-overlay.ts` mounts the overlay and owns the lifecycle (controller, voice, keep-awake). Entry points live on each mode's strength surface (`workout-detail-modal.ts`, `plan-view.ts`).

**Strength weight tracking** (2026-06-01). Per-lift working-weight memory + estimated-1RM benchmark, stored on the optional `s.strengthLog` field (`{ lifts: Record<key, StrengthLiftEntry>, notifiedPr }`, `src/types/strength-log.ts`). Pipeline:
- `strength-exercise-key.ts` — `isWeightTrackable(name)` + `normalizeExerciseKey(name)` (canonical slug, e.g. `back-squat`) + `cleanExerciseName(name)` (strips "@X% 1RM" for display). The parser (`parseStrengthSession`) computes `liftKey` from the raw line and stores the cleaned name on each `GuidedSet`; non-trackable movements get `liftKey: undefined`.
- `strength-progression.ts` — `estimate1RM` (Epley, rep-capped), `plateRound`, and the phase-gated `suggestNextWeight` (bumps only base/build + reps-left; peak/taper/deload hold; injury suppress).
- `strength-log-persist.ts` — `persistStrengthLifts(records, state)` upserts the memory + est-1RM history; called inside `completeStrengthSession` (standard-gym branch only, never HYROX). Weight/RIR reach it via optional `SetRecord.weightKg`/`rirBucket`, merged onto records by the overlay (controller stays weight-agnostic).
- `strength-marker-bumps.ts` — `detectStrengthPrs` / `snapshotNotifiedStrengthPrs`, surfaced at launch by `maybeShowStrengthPrToast()` in `main.ts` (all modes; mirrors `maybeShowMarkerBumpToast`).
- UI: capture in `guided-strength-overlay.ts` (per-exercise stepper + RIR), last/suggested sub-line + skippable confirm-weights in `strength-workout-detail-modal.ts`, trend drill-down in `strength-lift-detail.ts` (reuses `buildBenchmarkTrendChart`), recap in `strength-summary-card.ts`. Constants in `src/constants/strength-constants.ts`. Science: `SCIENCE_LOG.md → §AW`. The muscle-group body image (`src/ui/body-map.ts`) was removed.

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

### Adaptive Recovery (`src/calculations/adaptive-recovery.ts`)

Learns the user's per-athlete recovery rate `k_user` and feeds it into `computeToBaseline` (recovery countdown) and `computeACWR` (per-tier ceiling shift). Replaces the population constant of 8 once enough evidence accumulates; population default falls back at low confidence.

**Lifecycle**:
- `ingestNewActualsAsImpacts(s)` — walks current `wks` + archived plans for `garminActuals` not yet in `sessionImpactLog`, computes predicted hours, logs entries. Live (≤7d old) get fitWeight 1.0; older entries tagged `historical-backfill` at 0.7.
- `closeOutObservedRecovery(s)` — for entries whose 96h observation window has elapsed, walks `physiologyHistory` to compute observed hours-to-baseline (composite HRV + sign-flipped RHR z-score against the 28-day pre-session baseline; recovered when z ≥ −0.25; capped at 96h right-censored).
- `fitKUser(s)` — weighted-mean ratio of observed/predicted across closed entries, with 4-week recency half-life, fitWeight scaling, and a Bayesian prior of 4 ghost samples anchored at `k=8`. Result clamped to `[5, 13]`.

All three run on every launch via `refreshAdaptiveRecovery()` in `main.ts` after physiology sync — cheap because the impact log is bounded at 90 days.

**Day convention (2026-10-07)**: `SessionImpactEntry.date` and `PhysiologyDayEntry.date` are both local calendar keys. `isoDate` (`:196`) returns `localDateKey`, so `todayIso` (ingest age, the 96 h closeout gate, the 90-day prune), `addDays` (the T+1 to T+4 physiology probes) and `fitKUser`'s recency "now" use the same local day. Observation hours keep a 24 h granularity keyed to calendar days.

**Composition with existing recovery model**:
- `recoveryAdj` (transient, today's HRV/sleep/RHR) stays in `computeRecoveryScore` — it's the "right now" multiplier.
- `k_user` (persistent trait) is the "this athlete in general" multiplier.
- Both are applied to the countdown formula: `k_user × TSS / ctlDaily × recoveryMult × recoveryAdj`. No double-counting.

**Confidence gating**: 0–7 → none (default 8); 8–15 → low (display only); 16+ → medium (countdown uses `k_user`); 30+ → high (countdown + ACWR ceiling shift). The ACWR ceiling shift is bounded to ±0.10 (half a tier's worth).

**Call-site rule**: any consumer of `computeACWR` should thread `s.adaptiveRecovery` as the trailing 10th param so the safeUpper returned reflects the personalised ceiling. `computeReadinessACWR` (the canonical wrapper) auto-picks it up from the state object.

### Load Model & Plan Continuity (`src/calculations/fitness-model.ts`)

> See also: `docs/SCIENCE_LOG.md → "Plan-reset continuity (2026-04-29)"` for why the chronological walker exists, and `docs/CHANGELOG.md` 2026-04-29 entries for the `previousPlanWks` threading fix plus the baseline-refresh / DB-dedup follow-ups.

CTL/ATL/TSB and ACWR are computed from three signals (Signal A, B, C — see CLAUDE.md and `docs/PRINCIPLES.md`). Two parallel walkers exist:

- **Rolling 7d/28d** (`computeRollingLoadRatio`) — primary path for ACWR. Walks the last 28 days day-by-day, resolving each date to a Week via `_resolveWeekForDate`, which checks current `wks` *and* archived plans. A day no week covers is "unobserved". With a Signal B seed it is filled with seed ÷ 7. Without one it is missing (2026-10-05, audit B1): the function returns `null` until `ROLLING_ACWR_MIN_OBSERVED_DAYS` (14) observed completed days, then values missing days at the athlete's own observed daily baseline. `getDailyLoadHistory` omits unobserved days when no seed is passed, so its list can be shorter than 28.
- **Weekly EMA** (`computeSameSignalTSB`, `computeFitnessModel`) — used by the freshness ring, weekly TSB chart, week debrief, and as the ACWR fallback only when `planStartDate` is missing or there are no weeks. When the rolling ratio is `null`, `computeACWR` returns status 'unknown' and never falls through to the weekly EMA (it starts from zero for an unseeded athlete). `computeWeeklyAcwrHistory` (the Load Ratio weekly trend, moved here from `injury-risk-view.ts`) bias-corrects the unseeded EMAs. The Rolling Load drill-down (`rolling-load-view.ts`) reads `computeReadinessACWR`, like every other readiness surface.

**Plan continuity via `previousPlanWks`**: when a user generates a new plan, the old `wks` is archived into `s.previousPlanWks` (`archiveCurrentWksIfPopulated()` in `state/initialization.ts`) and any activities falling in the new plan window are redistributed via `redistributeArchivedActivitiesToNewPlan()`. Archive weeks whose start date is on or after the new plan's start are truncated by `_truncateArchivesAtPlanBoundary` so chronological concatenation cannot double-count.

Every readiness/load consumer threads `s.previousPlanWks` through to the walker so CTL doesn't collapse to `signalBBaseline` the moment a new plan starts:

- Helper `_walkChronologicalWeeks` yields archives (sorted by `planStartDate`) + current `wks` chronologically, each tagged with its own `planStartDate` (originally for `computeWeekRawTSS`'s `unspentLoadItems` date filter, which went away on 2026-10-05 when unspent items stopped counting as load).
- Used by `computeSameSignalTSB`, `computeFitnessModel`, `computeLiveSameSignalTSB`, and `computeACWR`'s weekly-EMA fallback. Sleep debt's `buildDailySignalBTSS` walks archives independently.

**Signal A / Signal B data-flow rules (2026-10-05, audit B3/X7/X9/B20; SCIENCE_LOG "Signal A vs Signal B")**:
1. Each activity counts at most once per signal. `listWeekSignalAEntries(wk, rated, norm)` returns one `SignalAEntry {key, garminId, source, sport, isRun, tss}` per activity; `computeWeekTSS` sums it (its `planStartDate` parameter is now unused, kept for call sites), and `main-view.updateLoadChart` reads it for its run/cross split. Signal A = TSS × `signalARunSpec(sport)`, with the sport from `resolveActualSport` / `resolveAdhocSport` (`cross-training/activities.ts`), the single resolver for "what sport was this activity" in load weighting.
2. `unspentLoadItems` feed decision surfaces only (excess-load flow: Adjust week and the carry-over card; the Home ACWR "Reduce session load" path: the button gate in `home-view.ts` and `triggerACWRReduction`, `main-view.ts:2127`, running mode only; week-activity-log labels), never load totals. `removeGarminActivity` (`events.ts`) drops an activity's items (`id` and `id_surplus`) in every week, under every id the activity has carried (the pre-upgrade id is read from `garminMatched` before it is deleted; `'__pending__'` is never treated as an id).
3. Any loop that walks `garminActuals` and then `adhocWorkouts` must skip an adhoc whose id is a `garminActuals` key, not only one whose `garmin-` suffix matches a seen `garminId`: the Strava upgrade rewrites the twin's `garminId` to `strava-<id>` but keeps the key and the adhoc id. Weekly A and B, `computeTodaySignalBTSS`, `computeTodayStrainTSS`, `getDailyLoadHistory`, the Load & Taper breakdown, double-day, `buildDailySignalBTSS` (sleep-insights) and `strain-view.activitiesForDate` follow this.
4. Comparisons stay on one signal. `computeSameSignalCtlHistory` gives per-week Signal B CTL with the same seed and walk as `computeSameSignalTSB`; the daily coach's `ctlTrend` reads it at both ends.
5. A week's actual load is derived, never stored (2026-10-06): every "week actual" reader calls `computeWeekActualTSS` (Key Types, Week). No code writes a weekly TSS total.
6. In-app completions are `garminActuals` records (2026-10-06/07): a GPS run, a Mark as Done tick and a HYROX quick done are `GarminActual`s with a `guided-` id (`guided-gps_<ts>` GPS run, `guided-manual-<ts>` manual completion, `guided-<ts>` guided strength or running-mode gym quick done), so every load reader above counts them. Signal A resolves their sport through `resolveActualSport`: `manualSport` first, a null `activityType` reads as running, the in-app `'hyrox'` type resolves to strength.

**Strain day (2026-10-07)**: `computeDayStrainTSS(wk, day, physiologyHistory, tssPerActiveMinute)` (`fitness-model.ts:855`) is the strain-surface entry point over `computeTodayStrainTSS`: it pairs a local calendar day's activities with the physiology entry (steps, active minutes) for the same day. Home, Readiness, capacity strain and the strain page and its week bars call it. `planCardBaseMinPerKm(s)` (`:871`) is the plan-card easy pace (5.5 min/km default) that the running and Just-Track Mark as Done doses share.

**iTRIMP normaliser binding (2026-10-05, audit B12)**: `launchApp` calls `bindAthleteNormalizerToState(() => getState())` once (`src/main.ts`). `normalizeiTrimp()` and `getAthleteNormalizer()` then re-derive the module normaliser whenever `ltHR`, `restingHR`, `maxHR` or the resolved sex change, so no HR writer has to remember a refresh. `getNormalizerFromState(s)` reads the same inputs (`AthleteHRProfile = { ltHR?, restingHR?, maxHR? } & BiologicalSexSource`). `setAthleteNormalizer(ltHR, restingHR, maxHR, sex?)` remains for tests and clears the binding; a guard test fails if production code calls it. `trimp.ts` is the single source for β (`getBeta`) and for the sex that picks it (`resolveBiologicalSex`, narrowed for producers by `resolveTrimpSex`); every iTRIMP producer (Strava edge payload `biological_sex`, Apple Health, FIT and screenshot import, `activity-matcher` `resolveITrimp` / `healMissingITrimp`) and the normaliser call it, and a guard test fails on a direct `s.biologicalSex` read for β.

**Call-site rule**: any new code reading these functions must pass `s.previousPlanWks` as the trailing `archivedPlans` argument. Skipping it makes the freshness ring and ACWR re-collapse on the next plan reset. Live writers: `freshness-view`, `home-view`, `readiness-view`, `daily-coach`, `stats-view`, `week-debrief`, `excess-load-card`, `activity-review`, `events`, `main-view`, `renderer`, `rolling-load-view`, `gps/recording-handler`.

### Gym Integration (`src/workouts/gym.ts`)

Phase-aware strength templates:
- Base: heavy compound lifts
- Build: explosive power
- Peak: maintenance
- Taper: activation only

Three ability tiers: beginner (bodyweight), novice (light weights), full (barbell). Deload weeks reduce by 1 session + lower RPE. The deload week is the running engine's (`isRunningDeloadWeek(weekIndex, ability, phase, continuousMode)`, passed `continuousMode` by `generateWeekWorkouts` and the session generator; 2026-10-08): the ability cycle in a race plan, the block's Deload ('taper') week in a continuous plan. Gym workouts never replace running sessions.

**Injury handling**: no gym in acute/rehab/test_capacity; light return session in return_to_run (level 5+).

### Wearable Activity Sync (`src/data/activitySync.ts`, `src/data/stravaSync.ts`, `src/data/appleHealthSync.ts`, `src/calculations/activity-matcher.ts`)

Fire-and-forget on boot. Two separate concerns are handled independently:

**Activity source** (what workouts were done) — `s.stravaConnected` takes priority:
- **Strava connected** (`s.stravaConnected`): `syncStravaActivities()` → `sync-strava-activities` Edge Function. Fetches activity list + full HR streams; computes iTRIMP. IDs namespaced `"strava-{id}"`. This path is used even for Garmin/Apple Watch users who have Strava. Backfill mode additionally stores Strava `best_efforts` (jsonb on `garmin_activities`) for RUNNING activities; `src/calculations/pbs-from-history.ts → readPBsFromHistory()` reads these to auto-fill onboarding PBs (5k / 10k / half / marathon) with source activity id + date for UI attribution.
- **Garmin-only** (`!s.stravaConnected`, physiology source `'garmin'`): `syncActivities()` → `sync-activities` Edge Function (28-day lookback). Activities arrive via Garmin Health API webhook.
- **Apple Watch** (activity source `'apple'`): `syncAppleHealth()` → `HealthExtras.queryWorkouts()` (iOS native only; no-op on web). Workouts match into local `s.wks[].garminActuals` AND are upserted into Supabase `garmin_activities` via `uploadAppleActivitiesToDB` (`src/data/appleActivityUpload.ts`, source `'apple'`, 2026-06-18). **The DB upload is load-bearing for triathlon**: the tri fitness pipeline (`loadActivitiesFromDB` → `deriveTriBenchmarksFromHistory`, per-discipline CTL / `fitnessHistory` / CSS / FTP / PBs) reads **only** the DB, never local `garminActuals`, so without the upload an Apple-Watch-only triathlete derives zero per-discipline history (Strava/Garmin already write to this table; Apple was the only source that didn't). Upsert is idempotent on the unique `apple-` `garmin_id`, suppresses any Apple row within ±10 min of a non-Apple row (Strava is canonical, never double-count), and is user-scoped by the `garmin_activities_own` RLS policy. The tri-init DB-empty fallback in `main.ts` runs this backfill synchronously (mirroring the Strava branch) so the pipeline populates on the first tri launch.

**Biometric/physiology source** (sleep, HRV, resting HR, steps) — determined by `getPhysiologySource(s)` from `src/data/sources.ts`:
- **Garmin**: `syncPhysiologySnapshot(28)` → `sync-physiology-snapshot` Edge Function → merges `daily_metrics`, `sleep_summaries`, `physiology_snapshots` (all written by Garmin webhook).
- **Apple Watch**: `syncAppleHealthPhysiology(28)` → `@capgo/capacitor-health` → `Health.readSamples()` for sleep stages, HRV (SDNN), resting HR, steps. On-device, no server. Sleep score computed from stage durations.
- **Apple physiology pipeline (2026-10-05, audit D4/X4)**, `appleHealthSync.ts`: `requestCorePermissions` (`CORE_READ_TYPES`, now including `heartRate`; one shared in-flight promise) → `applePhysiologyWindow(days)` (starts at local midnight; sleep from the noon before) → HealthExtras reads with `limit: 0` → `buildApplePhysiologyEntries` (`groupSleepNights`, `dailyStepsAcrossSources`, `lastValueByLocalDate`; dates after today dropped) → `mergeApplePhysiologyEntries(existing, incoming, appleOwns)` → `slice(-28)`. `syncAppleHealth` calls `ensureHeartRatePermissionRequested()` (guarded by `s.appleHeartRatePermissionRequested`) before `enrichWorkoutsWithHR`. **Day keys**: any day key derived from a HealthKit timestamp must use `localDateKey()` (`src/utils/local-date.ts`); the plugin emits GMT ISO strings, so `split('T')[0]` gives the UTC day. **Field ownership**: `PhysiologyDayEntry.appleValues` (optional, typed by `ApplePhysiologyField`) holds Apple's last-written value per field, so Apple can refresh its own gap-fills without touching a Garmin value. Every non-Apple writer of `physiologyHistory` must call `releaseAppleOwnership(entry, writtenFields)` (`src/data/physiology-provenance.ts`, field list `APPLE_PHYSIOLOGY_FIELDS`) for the fields it writes; `syncPhysiologySnapshot` and `syncTodaySteps` do.
- **Source routing**: `connectedSources.physiology` field on state, with legacy `wearable` fallback. Accessor functions in `src/data/sources.ts` centralise all branching.
- **Additive Apple Health gap-fill** (2026-05-27): `getPhysiologySource(s)` names ONE labelled primary, but Apple Health can run as a *supplementary* physiology source alongside a Garmin/Strava primary, gated on the device-local `s.appleHealthConnected` flag (set by `connectAppleHealth()`, which no longer demotes an existing Garmin primary). On launch `syncAllPhysiology()` in `main.ts` runs both providers in a load-bearing order: Garmin first (`syncPhysiologySnapshot` **overwrites** `physiologyHistory` wholesale), then `syncAppleHealthPhysiology` last (it **merges** and prefers existing Garmin values, so it only fills nights Garmin missed). Reversing the order would let a late Garmin write clobber the Apple fill. Apple sync is a no-op on web, so localhost stays on the Garmin/Supabase path. Entry point for Garmin/Strava users to authorise Apple Health post-onboarding: the Apple Health row in Account → Connected Apps (`renderAppleEnrichRow`, iOS-only).

**HealthKit is source-agnostic**: `appleHealthSync.ts` `fetchRecentWorkouts` → `Health.queryWorkouts` (and the native `HKSampleQuery` in `@capgo/capacitor-health` + `health-extras`) carry only date/workout-type predicates — **no `HKSource`/bundle filter** — so workouts from any app that writes to Apple Health (Apple Watch directly; Garmin/COROS/Polar once the user enables Apple Health in that app) are ingested. Garmin via Apple Health is thin (avg HR + duration; route/zones/splits dropped) — that's the gap the per-activity enrichment fills.

**Per-activity file enrichment** (2026-06-09, `src/data/activity-enrich-merge.ts`): from the activity detail page the user uploads a thin activity's original file ("Add detail from Strava") and the rich fields merge into the **existing** `GarminActual` in place. `enrichActualFromParsedRow` (pure) requires start within ±10 min AND duration within ±15% (stricter than the matcher's cross-source ±4h window — a timezone-less GPX timestamp rejects → confirm), fills only missing fields, and preserves `garminId` so a later live Strava row still wins. UI parses once via `parseActivityFileToRow` then `applyEnrichment` (parse → `streamsToActivityRow` → merge → `applyPBsFromRows` + `refreshBlendedFitness`), so a forced retry doesn't re-parse. Load self-corrects because TSS derives from `iTrimp` on read (`computeWeekRawTSS`); there is no stored week total to adjust (`wk.actualTSS` retired 2026-10-06). **Critical guard**: the matcher's re-enrich loop (`activity-matcher.ts:1195`) skips the `iTrimp` overwrite when `actual.enrichedFromFile`, so the next Apple Health sync re-delivering the same thin `apple-` row can't degrade the stream-computed iTRIMP. Gated by `STRAVA_ENRICH_UPLOAD_ENABLED`. Bulk Strava history uses the guided `src/ui/strava-history-guide.ts` → `importActivityArchive`.

**Garmin data pipeline** (webhook push model):
- **Live delivery**: Garmin pushes dailies / sleeps / HRV / userMetrics to `supabase/functions/garmin-webhook` as events happen. The handler writes to `daily_metrics`, `sleep_summaries`, `physiology_snapshots`.
- **First-connect history**: `triggerGarminBackfill(8)` fires **exactly once** per OAuth connect. `resetGarminBackfillGuard()` (called from the Connect Garmin buttons) clears the stamp so the next launch fires an 8-week `/backfill/{dailies,sleeps,hrv,userMetrics}` request; subsequent launches no-op. Guard key: `mosaic_garmin_backfill_migration = 'v7-one-shot-backfill'`.
- **Gap recovery**: `supabase/functions/garmin-reconcile` runs nightly at 04:00 UTC via pg_cron. Finds users with a `garmin_tokens` row but no `daily_metrics` row for yesterday and fires a small 3-day `/backfill/dailies`+`/backfill/sleeps`+`/backfill/userMetrics` window (userMetrics added 2026-04-23 so VO2/LT refreshes survive webhook gaps). Requests within a user are **serialized with 300ms spacing**; users are paced 3s apart. Also callable with a user JWT (single-user reconcile) from the manual Resync button in Account settings. Cron secret stored in Supabase Vault as `reconcile_cron_secret`; same value set on the function as `RECONCILE_CRON_SECRET` env var.
- **Rate-limit handling** (2026-04-24): Garmin's 100/min cap is app-wide (keyed on our client ID). Both functions detect 429/403/502/503 and bail the run. The client reads `rateLimited` from the response and sets `mosaic_garmin_cooldown_until` (120s, shared between backfill + reconcile) to stop further bursts until the rolling window clears. `triggerGarminBackfill` now only sets the one-shot migration guard on true success; a rate-limited run self-heals on the next launch after the cooldown.
- **Why no client-side polling**: the previous design polled `triggerGarminBackfill` every 2h on app launch. At scale that tripped Garmin's 100/min rate limit. Moving catch-up to a server-side cron removes the thundering-herd.

All activity paths produce `GarminActivityRow[]` and feed into `matchAndAutoComplete()` — identical pipeline from that point.

**Source gates and duplicate control (2026-10-06, audit S1)**: `appleWorkoutsEnabled(s)` (`sources.ts:57`) is false while `getActivitySource(s) === 'strava'` and `s.stravaConnected`; it is the single gate for every Apple **workout** path. `syncAppleHealth` and `syncAppleHealthDeepHistory` check it first and only refresh device metrics (VO2max, cycling FTP) when it is off; `syncAppleHealthPhysiology` is never gated, and `main.ts` registers the workout observer and foreground resume only when Apple workouts are enabled. `src/calculations/cross-source-twins.ts` (pure, no runtime import of the matcher): `isSameSession` (`:41`) is the canonical same-session predicate (start within `TWIN_START_WINDOW_MS` = 10 min, and same activity type or durations within `TWIN_DURATION_TOLERANCE` = 15%), shared by `cleanupDbDuplicates` (`stravaSync.ts`), the tri loader's residual pass, the ingest filter and the in-state collapse. `dropAppleRowsWithStravaTwin` runs at the top of `matchAndAutoComplete` after the `ignoredGarminIds` and `supersededGarminIds` filters. `collapseAppleStravaTwins(s)` removes Apple records already in state; `matchAndAutoComplete` calls it on every exit path when the batch carries a Strava row. Every slot rebind goes through `bindStravaToSlot` (`:514`), which writes the Strava data under the slot's own key, removes the Strava adhoc card and excess record, and moves the pointer and the Strava pending record into the slot's week (the review queue reads a pending record and its pointer from the same week). For `wk.triWorkouts`, a slot whose completion rested on a removed Apple key is bound directly to the Strava copy when that copy completes no other slot, because a direct bind is what `reconcileTriCompletions` reads as completion. `src/data/apple-strava-twin-cleanup.ts`: `collapseAppleStravaTwinsOnLaunch` (before `reconcileCrossSourceDuplicates`) and `finishAppleStravaTwinCleanup` (after the launch Strava sync, which also forces `cleanupDbDuplicates(90)` once, gated by `s.appleStravaTwinCleanupDone`).

**Apple data flow (2026-10-06, audit S2)**: `syncAppleHealth` → `fetchRecentWorkouts` (364 d first backfill, `ACTIVITY_SYNC_LOOKBACK_DAYS` = 28 d incremental, `activity-sync-window.ts`, also read by Strava and Garmin) → `enrichWorkoutsWithHR` → `matchAndAutoComplete` → `uploadAppleActivitiesToDB` → render if `result.changed` or first backfill → `processPendingAfterAppleSync` (`activitySync.ts:129`; resets the review guard unless the review or suggestion modal is open, then `processPendingCrossTraining`; skipped while onboarding is incomplete or `#wizard-return-btn` is on screen). The zero-workout path also ends with it. `mergeTimingMods` is not run after Apple syncs. `matchAndAutoComplete` contract: `changed` is true whenever state changed, enrichment of already-matched activities (re-enrich loop, Strava upgrade, stale past-week pending resolution) and the twin collapse included, on every return path.

**Onboarding sex gate (2026-10-06, F8)**: `src/data/trimp-sex-gate.ts`. `isTrimpSexPending(s)` (`:110`) is true while onboarding is incomplete, not Just-Track, and either the mode is triathlon, cycling or HYROX and about-you has not been left, or no sex resolves (`resolveBiologicalSex`) with the question still ahead. Producers that hold: `syncStravaActivities` (key `strava-sync`), `backfillStravaHistory` (`strava-backfill`, keeps the widest weeks requested) and `syncAppleHealth` (`apple-workouts`). In `syncAppleHealth` the Strava gate runs before the sex gate, and a held call re-enters `syncAppleHealth`. `releaseHeldTrimpSyncs(s)` (`:147`) runs held syncs as `trackStartupTask` entries; it is called from the wizard controller on every step change, `completeOnboarding`, the mid-plan Return to plan button (`wizard/renderer.ts`), `applyStravaAthletePrefill` (`stravaSync.ts:117`, the OAuth-return Strava profile prefill, moved out of `main.ts`) and `syncAppleAthleteProfile` (`appleHealthSync.ts:435`). The hold registry is in memory only. `awaitStartupSyncs` consumers: the review step and the tri past-race Strava scan.

**In-app records and supersede (2026-10-06/07, M3)**: `src/calculations/in-app-activity.ts` holds the same-session windows (recorded: start within 4 h and duration within 15%, 10 min when a duration is missing; completion: start within 36 h, duration 0.5 to 2.0×), the sport rule `isSameSportAsInApp` (`:302`), the plan-slot rule `isExtraActivityKey` (`:318`), the writers (`writeInAppActual` `:463`, `recordPlannedRunDone` `:503`, `recordPlannedSessionDone` `:620`, guarded by `isSessionCompletedByActivity` `:580`) and the bounded every-week searches (`findInAppRunToSupersedeAcrossWeeks` `:736`, `findInAppGymSessionAcrossWeeks` `:769`). In `matchAndAutoComplete` a synced run row is checked against every plan week, its own first, in 'recorded' and then 'same-day-completion' mode before the HYROX run branch and slot matching; a synced ride, swim or row goes through `supersedeInAppCrossSession` (`activity-matcher.ts:770`); `supersedeInAppRun` (`:590`) overwrites the record in place in the week that holds it, keeping slot metadata and the user's rating. A cross-day completion is superseded automatically only in the row's own week once that week is past; a current-week row queues for Activity Review. `reconcileCrossSourceDuplicates` (`:438`) drops an in-app record only for a same-family synced entry in the same week, and a manual completion only when that entry sits under an extra key.

**Local-day filing (2026-10-07)**: `weekIndexForDate` (`activity-matcher.ts:371`) files a row by the local calendar day of its start (`calendarDaysBetween(localDateKey(planStartDate), localDateKey(date))`); day readers use `isOnLocalDay` (`utils/local-date.ts:45`) instead of `startsWith(day)` / `split('T')`. Intentionally still UTC: internal logs, Strava weekly history (the `sync-strava-activities` edge function buckets by UTC Monday), physiology and manual-entry "today" keys, and plan-start snapping (`getMondayOf`, `persistence.ts:200`).

**Matching pipeline**:
1. Filter activities already in `wk.garminMatched` (idempotent), `ignoredGarminIds` and `supersededGarminIds`; drop Apple rows with a Strava twin
2. File each row into its plan week by local calendar day (`weekIndexForDate`); rows outside the plan are skipped
3. Map Garmin activity type → app type
4. Resolve the week the Plan shows (`resolveWeekWorkouts`, for stable ids). Just-Track and HYROX build no running week; HYROX station and run branches match `wk.triWorkouts`
5. In-app record supersede (above), then `findMatchingWorkout()` — scores day, distance, type, limited to slots `isActivityCompatibleWithSlot` (`matching.ts:81`) accepts (the walk class never fills a run slot)
6. High confidence → auto-complete with derived RPE. Medium/no match → ad-hoc workout or Activity Review

**RPE derivation priority**: Garmin RPE → HR zone (Karvonen) → Training Effect → activity type heuristic → planned RPE.

**Key state**: `wk.garminMatched: Record<string, string>` maps `garmin_id` → `workoutId` to prevent re-matching.

**Sign-in resilience for per-discipline volume/longest** (2026-06-02): `wk.garminActuals` is only populated as activities re-match *forward*, so immediately after a fresh sign-in (or a plan regen) it is empty until the next sync cycle. Run signals survive because `collectRunsFromState` (blended-fitness) falls back to the persisted `onboardingRunHistory`, and run longest uses `getLongestRunSec` (which also reads `onboardingRunHistory`). Swim/bike had no equivalent, so the triathlon **Endurance readiness** card (`computeDisciplineReadiness` in `specific-endurance-penalty.ts`, score = `volumeRatio × longestRatio`) collapsed to 0 across all disciplines. Fix: `main.ts` distills a slim per-discipline summary `s.recentDisciplineActivity` (last 12w, no polylines/splits) from `loadActivitiesFromDB()` at launch; `iterateRecentActuals` (tri-volume-by-discipline) tops up from it when `garminActuals` is sparse, deduped by sport + ±10 min so synced users are unaffected. Any new per-discipline volume/longest signal that reads `garminActuals` should route through `iterateRecentActuals` rather than scanning `garminActuals` directly, so it inherits this fallback.

**Triathlon onboarding session lever** (2026-06-02): `src/calculations/tri-session-lever.ts` is the triathlon analog of running's `forecastForSessions` / `bumpSessionsAndRegen` (which live inline in `plan-preview-v2.ts`). It is **pure** (no store/controller imports) so it is unit-testable; the side-effecting commit lives in the wizard step `ui/wizard/steps/tri-plan-forecast.ts`. Data flow for the preview: `applyTriSessionDelta(state, delta)` clones state, applies `computeBumpedVolume` (per-discipline session delta → new `volumeSplit` + `timeAvailableHoursPerWeek`, using `TRI_AVG_SESSION_HOURS` + `TRI_MAX_SESSIONS_PER_DISCIPLINE` exported from `plan_engine.triathlon.ts`), regenerates `clone.wks` via `generateTriathlonPlan`, and carries the historical activity log over by week index so current fitness is unchanged. `forecastTriWithDelta` then reads `predictTriathlonRace(clone).totalSec`; `goalChanceTriWithDelta` reads `runTriForecastSim(clone, 2000, goalSec).goalProbability`. Commit writes the bumped volume to the onboarding record and re-runs `initializeSimulator` (the only path that rebuilds the generated tri weeks). New wizard step ordering: tri flow is now `… → review → initializing → tri-plan-forecast → main-view`, mirroring running's `initializing → plan-preview-v2`.

### HYROX slot ids and MTL (`src/workouts/plan_engine.hyrox.ts`, `src/state/hyrox-plan-regen.ts`, `src/calculations/mtl.ts`, 2026-10-06)

`generateWeekSessions` stamps `W{week}-{type}-{idx}` ids with `stampTriWorkoutIds` (`plan_engine.triathlon.ts:698`), so every `wk.triWorkouts` session in triathlon, cycling and HYROX has an id; HYROX Add session uses `adhoc-` ids. `HYROX_GENERATOR_VERSION` was 14 for this change; it is 16 since the `c5f4a7f` merge, which sits above both branches' independent bumps (note in `plan_engine.hyrox.ts:58`), and the regen also carries `raceClosing`. `applyHyroxGeneratorRegen` (`hyrox-plan-regen.ts:198`, called from `main.ts`) regenerates on a version bump, carries `adhoc-` and `holiday-` sessions, and `rekeyNameKeyedHyroxSlots` (`:77`) moves pre-v14 name-keyed `rated` / `garminActuals` / `garminMatched` / `gpsRecordings` entries to the new ids (unique name to that id; a shared name to the session on the activity's start day; otherwise the activity goes to Activity Review and a bare rating stays under the name). MTL: `isMtlSessionCompleted(wk, w)` (`mtl.ts:107`, match link or `wk.garminActuals[w.id || w.n]`) is the completion test for `computeWeekActualMTL` / `computeWeekActualMTLByDiscipline`, the Stats and Readiness MTL cards and the MTL page; the HYROX effort multiplier's under-duration guard reads the same slot record (`wk.garminActuals[matchedActivityId ?? id]`). `computeMTLFitnessFatigue` starts both EMAs at the observed baseline (`observedBaselineWeeklyMTL`). `computeMtlAcwr` / `hyroxMtlAcwr` (`:358`, `:367`) is the only source for the readiness `mtlAcwr` input (Home, Readiness, daily coach), the Stats Load ratio row and tiles and the MTL page; it returns `ratio: null` with reason 'history' until 14 days of plan weeks are complete, or 'lowChronic' below `MTL_ACWR_MIN_CHRONIC` (15). `computeMtlChronicVsPlan` / `hyroxMtlChronicVsPlan` (`:402`, `:415`) feed the race projection's "Training fitness" factor and staleness Signal 2. The stored `hyroxConfig.mtlCTL` / `mtlATL` snapshot is refreshed at launch and still read by the Forecast chip detail (ISSUE-340). `hyroxConfig.weeklyActualMTL` has no writer or reader (type field kept).

### Triathlon suggestion pipeline (`src/calculations/tri-suggestion-*.ts`, 2026-10-06/07)

Planning side. `collectTriSuggestions` (`tri-suggestion-aggregator.ts:90`) reads current = `wks[s.w - 1]`, next = `wks[s.w]`, previous = `wks[s.w - 2]` (s.w is 1-based) and merges rows on one session (`oneRowPerSession`). `applyTriSuggestions` (`tri-suggestion-apply.ts:98`) applies each session at most once per batch. `canApplyTriSuggestion` (`:338`) is the single gate shared by proposal and apply (planned minutes required; a swap or downgrade needs a ladder, or an `OFF_LADDER_DOWNGRADE_RUNG` landing rung for a downgrade). `isTriQualitySession` (`:300`) is the quality classifier both detectors use. `raisesPlannedLoad` (`:235`) refuses an off-ladder step that would add planned TSS, judged by `loadForRung` rate at the session's minutes. `triDowngradeTssReduction` (`:276`) is the TSS a downgrade takes off (stored load minus the landing load), used by the overload builders. Pricing helpers live in `src/workouts/rung-load.ts` (`loadForRung`, `loadForTriRun`); tri run paces retarget from `triRunEasyPaceSec` (`src/workouts/tri-run-pace.ts:39`). Notify-once: `tri-suggestion-handled.ts` (`isOpenForTriSuggestion`, `Week.triSuggestionsHandled`). The volume-ramp detector is off (`TRI_VOLUME_RAMP_SUGGESTIONS_LIVE`). HYROX does not run this pipeline (`main.ts` gates on eventType 'triathlon'). Tri per-discipline fitness inputs: `triActivityTss` (`tri-benchmarks-from-history.ts:1057`; iTRIMP → `normalizeiTrimp`, else minutes × `TL_PER_MIN[ratedRpe ?? 5]`), `withTriRatedRpe` / `triRatedRpeByGarminId` (the rating `computeWeekRawTSS` reads), `inAppGpsRunActivities` (`:970`), `manualDoneTriActivities` (`:910`), and `triLoadObservedDays` (`:868`) → `triConfig.fitness.loadObservedDays` → `observedDisciplineLoad` / `perDisciplineAcwrRaw` (`fitness-model.triathlon.ts:146`, `:167`).

### Continuous Mode

Non-event users. 4-week block cycling: base → build → intensify → deload. Optional benchmark check-ins at block boundaries. `s.continuousMode = true`, `s.blockNumber` tracks current block. The deload is the block's 4th ('taper') week for the engine, the long-run ramp hold, the weekly load target and strength (`isRunningDeloadWeek`, `plan_engine.ts:241`, 2026-10-08). `isRaceWeek` is false in continuous mode, so no block week gets the race-week primer or loses its long run.

### Race plan shape, sharpening block and race calendar (`plan_engine.ts`, `phases.ts`, `sharpening-block.ts`, `race-week-layout.ts`, `race-day-rules.ts`, 2026-10-06 to 08)

Planning side, except where noted. SCIENCE_LOG §CT to §CX, and §CZ for the stored-plan race weeks (2026-10-08).

- **Replay**: `planWeekSessions(ctx)` = `buildWeekSessions(ctx, nominalHistory(ctx))`. `nominalHistory` (`plan_engine.ts:719`) replays weeks 1 to k−1 from the static plan inputs only (no effort score, ACWR status, CTL ratio or forced deload) and returns `PrescribedWeek { longMin, totalMin, qualityCount, runMins, easyMin }[]`, memoised in a module map keyed by every static input plus the phase list and the block start (32 plans, entries never stale). Cross-week rules read it: the 10% long-run ceiling (`longRunCeilingMin`), deload backstops, taper long run, block chain budgets, `taperMakeupRoom`. `PlanContext` gains optional `planPhases` (`s.wks.map(w => w.ph)`, used when its length equals `totalWeeks`, else `resolvePlanPhases` falls back to `computeRunningPlanPhases` or, in continuous mode, `computePlanPhases`), `continuousMode`, `sharpening` and `liveLongRunCapMin`. `PlanShapeInputs` is `PlanContext` without the per-week fields and levers; `runningPlanShapeInputs(s)` reads it from state exactly as `generateWeekWorkouts` does (`planEngineStateInputs` moved here from generator.ts and is re-exported there). `plannedRunMinutesByWeek(inputs)` exposes the replay to tracking (race-day durability); `plannedPeakWeeklyKm(inputs)` is the forecast's volume anchor (a block's own peak pre-taper week); `extraRunAddsQualitySession` backs the "Add a run a week" label.
- **Race week**: `isRaceWeek(weekIndex, totalWeeks, continuousMode)` = the final training week of a non-continuous plan, shared by the running engine, the generator's ACWR ease-back exemption, the week-debrief preview, the triathlon engine and its scheduler (`scheduleTriathlonWeek(..., raceWeek)` keeps Sunday free, finds the long run with `isLongRun` and, since 2026-10-08, never seats one discipline twice on a day: a session with no free day is left out), and the HYROX engine (`generateWeekSessions(..., raceWeek)`: taper kinds, no brick, no assessment, `RACE_WEEK_EXCLUDED_STATIONS`, with or without a race date). In running, race week keeps the primer whenever it holds a run: `buildWeekSessions` sets the race-week quality limit to 1, skips the ACWR-caution swap and the deload backstop there, and `assembleBlockTaperWeek` seats the primer whatever its reference week held (`plan_engine.ts:1222`, `:1403`, `:1796`). The triathlon race week takes the week before's per-discipline counts (`triRaceWeekCounts`, which reuses the week sizing `triWeekSizing`). `applyHoursBudget` caps easy runs at the week's long run and trims the long run only by the overflow.
- **Sharpening block**: `buildWeekSessions` routes `!continuousMode && isSharpeningBlock(rd, totalWeeks)` to `buildSharpeningWeek` (loaded rows via `assembleBlockLoadedWeek`, taper weeks via `assembleBlockTaperWeek`; `BlockWeekRow` carries budgets, long-run target and hold, hours cap). Inputs: `s.sharpenBlock` (frozen start, `buildSharpenBlockState`), `sharpeningInputsFromState`, the live cap `liveSharpeningLongRunCapMin(s, week, { nextWeekPreview })` (weeks reached, once a run is logged after build). `planEngineStateInputs` gives a block the continuous fallback (`s.wkm`, archetype 'unknown') when nothing is synced. `isSharpeningDeloadWeek` is shared with `planned-week-target.ts`.
- **Calendar**: `raceWeekLayout(planStartISO, raceDateISO)` returns `{ calendarWeeks, trainingWeeks, closingWeek, raceDayOfWeek, raceDayIndex }`; race week holds race day − `RACE_WEEK_ANCHOR_DAYS` (3). `planTrainingWeeks(s)` = `s.tw` minus a trailing `raceClosing` week; every weeks-to-race input reads it (engine horizon, phases, `runningPlanShapeInputs`, race-day durability window, `refreshBlendedFitness`, the Monte Carlo cone, renderer, preview, `rate()`, strength benefit). Calendar consumers ("Week N of M", navigation, week advance, persistence checks, Plan complete) keep `s.tw`. `planRaceLayout(s)` (running) and `storedPlanRaceLayout(tw, planStart, raceDate)` (triathlon, cycling, HYROX) return null when the stored length does not match the layout, which switches the placement rules off for pre-layout plans. `racePlanCalendarWeeks` is the stored-mode plan length (setup steps and initializers); `calculateWeeksUntil` is no longer a plan-length source. `planCompletionDue(s)` gates the end-of-plan trigger, the final-week 'complete' debrief and the plan summary. `planTaperWeeks(s)` feeds every running forecast taper input. Tracking: `raceForecastHorizonISO(s, raceISO)` is the stored-mode forecast horizon (Sunday before race day with a closing week), read by the triathlon, HYROX (predictor and projection) and cycling predictors.
- **Placement**: `applyRaceDayRules(workouts, { weekIndex, layout, firstScheduleDow, toEasy })` (rules 1 to 4) runs in `generateWeekWorkouts` after `assignDefaultDays` and in the week-debrief preview; rule 5 lives in `isTaperCarryBlocked` (events.ts skip and rollover), `filterTaperMakeups` and `fitTaperEasyMakeups` (generator). `dropSessionsOnOrAfterRaceDay` and `clearStoredPlanRaceWindow(workouts, { weekIndex, layout, isLongSession, isHard?, firstScheduleDow, dayNames, onDrop? })` serve the triathlon and HYROX generators (2026-10-08 additions: `raceWeekPrimerDow(layout, weekIndex, homeDow, firstScheduleDow)` gives running rule 2's primer day for a home day, null when no day 3 to 5 days out exists; the triathlon `triWeekForRace` runs `placeStoredPlanRaceWeekPrimer` before rule 1 and `spaceStoredPlanQualityRuns` after the race window; HYROX passes `raceWeekDays` as the `allowedDays` of `scheduleHyroxWeek`, which leaves out a session with no free allowed day) (`generateTriathlonPlan` / `regenerateTriathlonWeek`, `generateHyroxPlan` / `regenerateHyroxWeek`); the triathlon `onDrop` fills `Week.raceWindowCut`, which `plannedDoseWorkouts` in `tri-volume-by-discipline.ts` adds back for the forecast while the public look-aheads keep the plan as scheduled. The four full-plan triathlon regen sites (main.ts launch regen, activity-detail `regenerateTriPlan`, events `rebakeFutureWeeksInPlace`, benchmark-tests-card) copy `raceWindowCut` with the week; the launch regens (main.ts for triathlon, `applyHyroxGeneratorRegen` for HYROX) also copy `raceClosing`.
- **Triathlon scheduler fallbacks (every week, 2026-10-08)**: `placeByPreference` (`scheduler.triathlon.ts:176`) takes an `allowed(day, w)` predicate (a run never takes a day holding the long run or the brick, tracked in `runAnchoredDays`), a `noDoubles` flag (race week) and `overCap(day, w)`. Order: (1) preferred day with capacity and no same-discipline collision; (2) weekend day, same test; (3) weekend day with capacity, collision allowed; (3b) a run that is not a commute takes the run-free day it overshoots least; (4) preferred day with capacity, collision allowed; (5) the day with fewest sessions, weekend first. Commutes skip step 3b. `TRI_BIKE_QUALITY_DOW` (Tuesday) is the primer's home day.
- **Race-day card** (`src/ui/race-day-card.ts`, display only): `planRaceDateISO(s)` reads the race date each generator uses (`runningRaceDateISO`, `triConfig.raceDate`, `hyroxConfig.raceDate`; null for continuous and Just-Track), `raceDayInfo` places it with `raceWeekLayout`, and `raceDayInWeek` / `raceDayToday` / `raceDayCardHtml` feed `buildWorkoutCards` (`plan-view.ts`), the triathlon and HYROX `renderDay`, and Home's `buildRestOrRaceDayHero`. Nothing is written to `s.wks`.
- **Layering note**: `generator.ts` imports `firstTrackedDow` from `src/ui/workout-status.ts` (a pure function, but a workouts → ui import).

### Recent race effort and the engine floor (`prediction-inputs.ts`, `blended-fitness.ts`, 2026-10-08)

Tracking side. SCIENCE_LOG §CY. `computePredictionInputs(runs).recentRun` is the newest run in the 8-week window whose pace is below median × `RACE_FILTER_RATIO` (0.85, `prediction-inputs.ts:76`), the same test that removes races from Tanda's P; null when the window holds only training runs. Consumers: `blendPredictions` (`predictFromRecent`), the §BZ engine floor in `initializeSimulator` and `refreshBlendedFitness`, `demonstratedPBFloor`, the triathlon run-leg blend (`race-prediction.triathlon.ts:1382`), the Stats `liveRec` and the forecast breakdown, each falling back to `s.rec` when it is null. The triathlon cold-start cap (`blended-fitness.ts:717`) reads `recentRun` without the `s.rec` fallback and lifts only on `pbDerivedVdot`, a race anchor, a non-null `recentRun` or a medium-or-better HR fit. The engine VDOT (`s.v`) feeds the ability band, plan volume, long runs and the forecast; paces read `s.lt` when it is set (`gp(vdot, lt)`), and `recomputeLT` derives `s.lt` from `getPhysiologicalVdot`, so the triathlete cap does not reach paces (ISSUE-372).

### Scheduler (`src/workouts/scheduler.ts`)

`assignDefaultDays()` rules: long run → Sunday, quality sessions → Tue/Thu, easy runs fill remaining slots. The long run is identified by `isLongRun(w)` (the generator's `longRun` stamp), so the fast-finish long run (`t: 'progressive'`) lands on the long-run day (2026-10-05, audit X5). `checkConsecutiveHardDays()` validates no back-to-back hard days. Users can override via drag-and-drop → stored in `wk.workoutMoves`.

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

### Screenshot Activity Import (`src/data/screenshotImport.ts`, `src/data/screenshotCapture.ts`, `src/data/screenshotOcr.ts`)

Hybrid OCR → AI vision pipeline for users who can only share a screenshot of their run summary. Two engines converge on the same `ParsedScreenshotActivity` contract; `screenshotActivityToRow()` then produces a `GarminActivityRow` (no polyline, no per-second streams) that flows through the standard `matchAndAutoComplete` → `applyPBsFromRows` → `refreshBlendedFitness` → `healMissingITrimp` tail — i.e. screenshot runs drive the plan exactly like file imports, minus GPS-only signals.

**Engines**:
- **On-device Apple Vision** (`@mosaic/screenshot-ocr` plugin, `src/data/screenshotOcr.ts`). iOS-only, free, runs first. `VNRecognizeTextRequest` at `.accurate` with `usesLanguageCorrection` off; row-grouped output reconstructs splits-table lines.
- **Cloud Claude vision fallback** (`supabase/functions/screenshot-vision`). JWT-auth, per-user 25/day, $10/day global cap. Used when OCR confidence is low / fields missing, and unconditionally on web (no native engine).

**Orchestration**: `runHybridParse(imageBase64, { ocr, aiFallback, aiImage })` in `screenshotCapture.ts` — engines injected so the decision logic is unit-testable. `decideNeedsAI(parsed)` + `pickBetterParse(ocr, ai)` are pure helpers. AI is skipped when OCR is already high-confidence (cost path: $0 when possible). Client downscales screenshots to 1280px JPEG @ q=0.6 via canvas before the AI call to keep payload and cost bounded.

**Optional HR-chart path**: the edge function gained a `mode: 'summary' | 'hr_chart'` field. In `hr_chart` mode Claude is prompted to read the chart's time + HR axes and sample the curve at ~minute intervals, returning `{ hrSeries: [{tSec, hr}] }`. The series is folded into the parsed activity at commit. `commitScreenshotActivity` then builds a `ScreenshotEnrichmentContext` (RHR / max HR / zones / sex from state) so `screenshotActivityToRow` can run the canonical `computeHREnrichment` from `activityEnrichment.ts` — the same helper FIT imports use. Net: screenshot-sourced runs reach real iTRIMP + maxHR + HR-zone breakdown, not the heal-pass avgHR-only estimate.

**UI**: `openScreenshotImportModal()` (`src/ui/screenshot-import-modal.ts`) — three-step glass overlay (pick → read → confirm). The confirm step lets the user edit date / distance / duration / avg HR and exposes the optional "Add HR chart for per-minute detail" picker (skippable). Mirrors `openImportActivityModal`'s `onComplete` contract so onboarding can reveal Continue + the guest-sync nudge.

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

**Excess Load Card** (`src/ui/excess-load-card.ts`): `renderExcessLoadCard` and `wireExcessLoadCard` have no caller, so the card is not rendered (ISSUE-325). The excess reaches users through the Plan tab's Adjust-week strip and the carry-over card, both of which call `triggerExcessLoadAdjustment`.

**Slot rules (2026-10-06)**: `getWeekWorkoutsForReview` (`activity-review.ts:82`) returns no slots in Just-Track, `wk.triWorkouts` in HYROX and triathlon, and the Plan's resolved week (`resolveWeekWorkouts`) in running. Every auto-match goes through `matchItemToSlot` (`:219`), which holds `findMatchingWorkout` to `isActivityCompatibleWithSlot` (`matching.ts:81`); `matching-screen.ts isCompatible` delegates to the same rule for taps and pre-assignments. `isRunSlot` (`matching.ts:44`) covers `RUN_WORKOUT_TYPES` and `hyrox_run_*`; `isRunClassActivity` (`:61`) is true for 'run' only, so the walk class is never run-compatible. `resolveSportForActivity` (`sport-picker-modal.ts:194`) costs the walk class as the raw type's own sport. Cross-training overflow in triathlon and HYROX goes through `redirectToTriSuggestionFlow` (logged as adhoc entries; triathlon then runs the tri aggregator, HYROX continues to the RPE prompt). **Previous-week carry-over**: at `loadState` time, any `unspentLoadItems` in `wks[w-2]` that are not already in `wks[w-1]` (by `garminId`) are moved into the current week, ensuring items not resolved before advancing a week are not silently lost.

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

### BYOK AI Coach (`src/coach/`)

Conversational coaching layer powered by the user's own Anthropic API key (zero cost to Mosaic).

**Load numbers in the context (2026-10-06)**: `buildPlanSkeleton` gives running weeks `actual_tss` = `computeWeekActualTSS` (past and current week; null for future) and prices HYROX weeks with `getPlannedDayTSSContext(state, week).plannedWeekTSS`; the triathlon branch still sums `aerobic + anaerobic`. `fitness_trend.planned_week_tss` is the signal A weekly target in every mode (tri and HYROX: `coach-context-builder.ts`, pinned for race week by `ea80faf`). The triathlon context pairs `tss_8_weeks` from `historicWeeklyRawTSS` (signal B) with signal A weekly figures (ISSUE-333).

**Data flow:**
```
Account view → storeApiKey() → @capacitor/preferences (iOS Keychain)
renderCoachView() → hasApiKey() → AI mode OR classic rules-based mode

AI mode:
  buildCoachContext(state)           — sanitized JSON of 4–8w pacing, readiness, plan
  buildSystemPrompt(context)         — ~1000-char coach persona + hard rules
  streamCoachChat(messages, ctx, key)
    → POST /functions/v1/coach-chat  — Supabase JWT + X-Anthropic-Key header
    → coach-chat edge function       — validates JWT, rate-limits (30/day), proxies to Anthropic
    → Anthropic claude-sonnet-4-6    — streaming SSE response
    → yields StreamChunks: text | tool_use | done | error
  UI: text chunks → streaming brief; tool_use → validateAndBuildPendingChange() → Apply card
  Apply button → applyPendingChange() → mutates wk.triWorkouts or wk.workoutMods → saveState()
```

**Security layers:**
- `sanitizeField()` — strips HTML, collapses newlines, rejects injection patterns from all user-controlled strings before any LLM payload
- `validateAndBuildPendingChange()` — validates every tool call parameter against actual plan state; silently returns null on invalid (no Apply card rendered)
- `Apply required` — no state mutation without explicit user tap
- `X-Anthropic-Key` never logged, stored server-side, or echoed; used once per request and discarded
- Supabase JWT required on every edge function call; rate limit is per-user-id
- `@capacitor/preferences` = iOS Keychain (encrypted, device-sandboxed)

**State fields added (`src/types/state.ts`):**
- `anthropicApiKeyStored?: boolean` — presence flag only; actual key lives in Keychain
- `coachConsentGiven?: boolean` — one-time Anthropic data disclosure accepted

**Coach tools (4):** `swap_workout`, `reduce_workout`, `skip_workout`, `adjust_intensity` — fixed parameter enums, all validated before Apply card renders.

**Classic fallback** (no key): `computeDailyCoach()` stance + `primaryMessage` headline + rule-based signals. Same quality — not a degraded experience.

**Supabase edge function** (`supabase/functions/coach-chat/`): BYOK variant of `coach-narrative`. Key differences: uses `X-Anthropic-Key` request header, returns streaming SSE, supports tool use, no global spend cap, 30-calls/day rate limit via `coach_chat_usage` table, 30s timeout.

**DB table required:** `coach_chat_usage(user_id, date, call_count)` + `increment_coach_chat_usage(uid, today)` RPC function. See migration SQL in `supabase/migrations/` (deploy before enabling coach-chat edge function in production).

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
| `docs/AI_STRATEGY.md` | AI Coach monetisation strategy — tier model, economics, pending Tier 2 decisions, Stripe/IAP tradeoffs |
