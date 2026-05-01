# Mosaic Features

Plain-English description of every feature, where to find the code, and test status.
Update the status column after running `npx vitest run`.

---

## Triathlon Mode (MVP — behind `eventType === 'triathlon'` flag)

Triathlon is a fully-separate mode selected at onboarding. Running users are unaffected. See `docs/TRIATHLON.md` §18 for the canonical decisions backing this implementation.

### T1. Triathlon Onboarding (wizard fork)
**What it does**: New mode tile on the goals step routes triathlon users through a single consolidated `triathlon-setup` screen that collects distance (70.3 / IM), race date, weekly hours, volume split across swim/bike/run, three self-rating sliders (1–5 per discipline), bike FTP + power-meter toggle, and swim CSS (or 400m test time that derives CSS). On completion, initialises `triConfig` and generates the plan.
**Key files**: `src/ui/wizard/steps/goals.ts`, `src/ui/wizard/steps/triathlon-setup.ts`, `src/ui/wizard/controller.ts`, `src/state/initialization.triathlon.ts`
**Tests**: — (UI) ⚠️ Manual test only

### T2. Triathlon Plan Engine
**What it does**: Generates a full per-phase plan (base → build → peak → taper) with swim, bike, run, brick, and optional gym sessions for each week. Per-discipline hours derived from `triConfig.timeAvailable × phaseMultiplier × volumeSplit`. Sessions chosen by phase + skill.
**Key files**: `src/workouts/plan_engine.triathlon.ts`, `src/workouts/scheduler.triathlon.ts`, `src/workouts/swim.ts`, `src/workouts/bike.ts`, `src/workouts/brick.ts`
**Tests**: `src/workouts/plan_engine.triathlon.test.ts` — ✅ Passing (8 tests)

### T3. Multi-sport Transfer Matrix
**What it does**: Every activity contributes to its own discipline's CTL and ATL at 1.0, and to other disciplines at reduced weights (§18.3). Generalises the old `runSpec` discount to support any sport. Drives per-discipline CTL when a padel / ski / strength session lands on the activity log.
**Key files**: `src/constants/transfer-matrix.ts`, `src/calculations/fitness-model.triathlon.ts`
**Tests**: `src/calculations/fitness-model.triathlon.test.ts` — ✅ Passing (10 tests)

### T4. Per-discipline CTL / ATL / TSB
**What it does**: Independent 42-day CTL + 7-day ATL tracks for swim, bike, run. Combined CTL is a weighted sum (COMBINED_CTL_WEIGHTS). Per-discipline ACWR for discipline-specific overload detection. Same Banister 1975 exponential-decay EMAs as running mode.
**Key files**: `src/calculations/fitness-model.triathlon.ts`
**Tests**: covered in T3 tests ✅

### T5. Swim / Bike TSS
**What it does**: Swim TSS uses cubed IF (water drag ∝ v³; Toussaint & Beek 1992). Bike TSS uses squared IF when power meter present; HR-reserve fallback otherwise.
**Key files**: `src/calculations/triathlon-tss.ts`
**Tests**: `src/calculations/triathlon-tss.test.ts` — ✅ Passing (13 tests)

### T6. Triathlon Race Prediction
**What it does**: Predicts total race time and per-leg splits. Swim uses CSS + 5s/100m race-pace offset (Dekerle 2002). Bike derives speed from FTP × race IF or skill fallback. Run uses VDOT (Daniels) plus a 5% (70.3) or 11% (IM) pace fatigue discount (Bentley 2007, Landers 2008). T1/T2 estimated from skill slider. Confidence band ±8–10%. Sprint and Olympic times shown as side-effects.
**Key files**: `src/calculations/race-prediction.triathlon.ts`, `src/ui/triathlon/race-forecast-card.ts`
**Tests**: — ⚠️ Not yet covered

### T7. Discipline-aware Activity Matcher + Brick Detection
**What it does**: Matches synced swim / bike / run activities to planned `triWorkouts` — discipline first, then same-day, then nearest duration. Brick detector flags bike → run pairs where the run starts within 30 min of bike end (§18.1).
**Key files**: `src/calculations/activity-matcher.triathlon.ts`, `src/calculations/brick-detector.ts`
**Tests**: `src/calculations/brick-detector.test.ts` — ✅ Passing (5 tests). Matcher ⚠️ not yet covered.

### T8. Triathlon UI (Plan / Home / Stats)
**What it does**: Three views with a dedicated minimal tab bar. Plan shows day-by-day cards with discipline-coloured stripes (swim teal, bike clay, run sage), and supports drag-and-drop reorder within the week — drop a card on another card to swap days, drop on the day-header strip to stack onto that day, or drop on an empty rest row to move there. Bricks are atomic single workouts so they always move as one. Home shows today's workouts, per-discipline fitness bars with CTL/ATL readout, race forecast, and upcoming sessions. Stats holds three things only — race forecast (with bike & aero setup grouped under Course Factors), Adaptation (per-discipline response ratio; hidden when no signal yet), and Progress (per-discipline CTL trend chart, tap for detail; hidden until 2+ weeks of history). Earlier readiness/benchmarks/training-load cards moved to Home, Account, and the Load page respectively.
**Key files**: `src/ui/triathlon/plan-view.ts`, `src/ui/triathlon/home-view.ts`, `src/ui/triathlon/stats-view.ts`, `src/ui/triathlon/tab-bar.ts`, `src/ui/triathlon/workout-card.ts`, `src/ui/triathlon/race-forecast-card.ts`, `src/ui/triathlon/colours.ts`
**Tests**: — (UI) ⚠️ Manual test only

### T9. Benchmark test prompts + confidence-tiered estimators
**What it does**: "Refine your benchmarks" cards pinned to the top of the triathlon plan view surface a CSS test (paired 400m + 200m, Smith-Norris) and an FTP test (20-min Coggan) when the auto-derived value is low-confidence. Cards self-suppress when the user's swim or ride history already supports a `'medium'`-or-better estimate, so users with rich power/swim data aren't nagged. Each card opens a compact result modal that writes the entered times directly into `triConfig.{swim,bike}` with `cssSource/ftpSource = 'user'` and confidence `'high'` so the launch refresh never overwrites a real test result. Stats and account benchmark cells show an inline "estimate · do the test" hint when the persisted CSS/FTP confidence is low/none. Wizard review CSS row hedges its caption based on the same tier.
**Key files**: `src/ui/triathlon/benchmark-tests-card.ts` (test prompts), `src/calculations/tri-benchmarks-from-history.ts` (`CssEstimate.confidence`, `FtpEstimate.confidence`), `src/main.ts` (launch-time refresh writes confidence), `src/state/initialization.triathlon.ts` (wizard write-path), `src/ui/account-view.ts` (benchmarks grid + estimate-confidence hints — the prior `benchmarkCell`/`cssCellHint`/`ftpCellHint` helpers in `src/ui/triathlon/stats-view.ts` were removed on 2026-04-30 when the Stats benchmarks card was retired in favour of Account → Benchmarks), `src/ui/wizard/steps/review.ts` (CSS / FTP captions)
**Tests**: `src/calculations/tri-benchmarks-from-history.test.ts` — ✅ Passing (52 tests including 12 new confidence-tier scenarios)

### T10. Triathlon Progress detail page
**What it does**: Mirrors the running stats Progress detail in tri mode. Opens from a "Progress" card on the tri stats page. Range toggle (4w / 12w / All / Forecast). Charts: per-discipline CTL lines (daily-equivalent ÷7), three separate weekly km charts (swim / bike / run), one weekly TSS chart with three lines (swim/bike/run colours from `colours.ts`), FTP trend, CSS trend. All-time tile shows lifetime swim/bike/run km plus session counts. Forecast tab extends km + TSS using `triWorkouts` from the next 8 weeks (dashed continuation). FTP/CSS history is captured via `appendFtpSample` / `appendCssSample` whenever main.ts auto-derives a new value or a user enters one in onboarding — one entry per day, latest wins, 256-entry cap. Tracking-only data; no calculation reads from these arrays.
**Key files**: `src/ui/triathlon/progress-detail-view.ts`, `src/ui/triathlon/stats-view.ts` (Progress card + wiring), `src/calculations/tri-benchmark-history.ts` (history append helpers), `src/types/triathlon.ts` (`BikeBenchmarks.ftpHistory`, `SwimBenchmarks.cssHistory`), `src/main.ts` and `src/state/initialization.triathlon.ts` (history capture sites)
**Tests**: — (UI) ⚠️ Manual test only

### T11. Not yet built (deferred)
- Discipline-aware sync pipeline (stravaSync/garminSync route swim/bike activities into `state.triConfig.fitness` via `rebuildTriFitnessFromActivities`). The calculation modules are ready; the write-side plumbing is the remaining hook.
- Suggestion-modal cross-discipline ACWR extensions (§18.5).
- Injury engine discipline-shift behaviour (§18.6).
- Express onboarding via Strava (pre-populate CSS/FTP/PBs from history — §18.9).
- Targets editing from the stats page UI (§18.8).
- Guided runs for bike/swim (v2).

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

The blended prediction (`refreshBlendedFitness`) combines Tanda (2011) marathon regression, VDOT-from-PBs, LT pace, and VO2max into a single weighted race time. Confidence scales with how many recent runs fed the blend. The blended effective VDOT is written back to `s.v` so plan generation and pace derivation always use the live value (except in taper/deload weeks where `s.v` is held — Mujika & Padilla 2000). `getEffectiveVdot(s)` layers RPE and physio adjustments on top.

Three surfaces expose the prediction. (1) **Home race-forecast card** (race mode only): distance label, predicted finish time, target time, and signed delta vs target (e.g. `+13 min` / `On pace` / `−4 min`). Tap opens the full-page forecast view. (2) **Race forecast full-page** (`src/ui/race-forecast-view.ts`): hero ring coloured by delta-to-goal, Started/Now/Forecast stat row, line chart of race-time progression (`vdotHistory → tv(vdot, rdKm(s.rd))`) with dashed projection to `s.forecastTime` at week `s.tw` and horizontal goal reference line. If the forecast lags the goal by ≥ 20 min and the athlete isn't in taper, an "Add a quality session" CTA bumps `s.rw + s.epw` and re-runs `refreshBlendedFitness` in place. (3) **Plan race-prediction row** shows Initial · Forecast with the signed delta subline. (4) **Stats race-estimate table** repeats the signed delta inline on the row matching `s.rd`.

**Key files**: `src/calculations/predictions.ts`, `src/calculations/blended-fitness.ts`, `src/calculations/effective-vdot.ts`, `src/ui/race-forecast-view.ts`, `src/ui/home-view.ts` (`buildRaceForecastCard`), `src/testing/forecast-matrix.ts`
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

### 6b. Lactate Threshold Derivation (own engine, decoupled from Garmin)
**What it does**: When Garmin's watch-side LT reading is missing, stale, or gated, the app derives its own LT pace + LTHR from three blended methods: Daniels T-pace from VDOT (88% vVO2max), Critical Speed from race-distance PBs (LT = 0.93 × CS), and empirical detection from sustained tempo efforts (20+ min runs, 85–92% HRmax band, decoupling <5%). Outlier guards exclude treadmill, hot weather, hilly runs, and unsteady pacing.

**State integration**: `recomputeLT(s)` runs after every physio + activity sync. Priority chain: `s.ltOverride` > fresh Garmin reading (<60d) > blended derived. When Garmin and our derived value differ by >10s/km, a `s.ltSuggestion` is set so the LT detail page can prompt the user to choose; `s.lt` is not silently overwritten in that case.

**Stats UI**: The LT metric detail page (Stats → LT card) shows the active value with provenance + confidence chip, a per-method breakdown (pace and weight contribution), the Garmin sparkline when present, the conflict-resolution prompt, and slider overrides for pace + LTHR with reset-to-derived.

**Workout pacing**: `s.lt` flows into `paces.gp(vdot, ltPace)` so threshold workouts and pace zones use the resolved value automatically.

**Key files**: `src/calculations/lt-derivation.ts`, `src/data/ltSync.ts`, `src/ui/stats-view.ts → buildLTMetricPage`
**Tests**: `src/calculations/lt-derivation.test.ts` — ✅ Passing (29 tests)
**Science**: `docs/SCIENCE_LOG.md → Lactate Threshold Derivation` (Daniels, Jones & Vanhatalo, Nixon et al. 2021, Friel)

---

### 7. HR & Efficiency Scoring
**What it does**: When you log a workout with heart rate data, the app cross-checks your RPE (how hard it felt) against your HR to detect whether you're getting fitter, fatigued, or under cardiovascular stress. This nudges your future paces slightly up or down.

**Logic**: Low RPE + Low HR = efficiency signal (paces get a tiny bit faster). Low RPE + High HR = cardiovascular strain (dampens the easy-day signal). High RPE + High HR = struggle (slows future paces). High RPE + Low HR during intervals = central fatigue.

**Key file**: `src/calculations/heart-rate.ts`
**Tests**: `src/calculations/efficiency.test.ts` — ✅ Passing

### 7b. HR Effort + Pace Adherence → Plan Engine (ISSUE-35 Build 1)
**What it does**: Every synced run gets two objective scores: (1) HR effort score — how hard it was relative to the target HR zone (from Strava HR data), and (2) pace adherence — how close actual pace was to target pace from VDOT tables. These blend into the weekly `effortScore` alongside RPE, which the plan engine uses to scale future workout durations.

**Weighting**: Quality sessions (threshold, VO2, marathon pace) weight pace at 35% — missing pace targets on hard workouts is the strongest signal. Easy runs weight pace at only 15%. HR fills the gap between RPE and reality.

**User-facing**: Future weeks in the plan show an adaptive note explaining workouts will adjust, with context ("you missed pace targets on recent quality sessions").

**Key files**: `src/calculations/heart-rate.ts` (`computeHREffortScore`), `src/calculations/activity-matcher.ts` (`computePaceAdherence`, `getHREffort`, `getPaceAdherence`), `src/ui/events.ts` (blended effort score), `src/ui/plan-view.ts` (`buildAdaptiveNote`)
**Tests**: ⚠️ No dedicated tests yet — logic verified via existing 756 tests passing

---

### 7c. Workout Commentary — Coach's Notes (ISSUE-35 Build 3)
**What it does**: Every completed activity gets 2-3 sentences of coaching commentary on its detail screen. Rules-based — picks the most relevant insights from pace adherence, HR effort, HR drift, split patterns (negative split, late fade, evenness), and HR zone distribution.

**HR drift surfaces (added 2026-04-15)**:
- **Activity detail copy** (`workout-insight.ts`): drift >8% on easy/long runs (not quality) triggers a layman's explanation — heat, dehydration, fatigue, or pace too aggressive.
- **Pre-long-run nudge** (`daily-coach.ts → computeLongRunDriftNote`): when today is a long run and recent long runs have drifted, the coach suggests earlier fuelling and pace control. Surfaced under the coach message in Readiness view.
- **Easy-pace commentary** (`daily-coach.ts → detectEasyDriftPattern`): when easy runs over the last 3 weeks drift >5% on average, the week debrief adds a note that easy pace may be too close to aerobic threshold.
- **Aerobic Durability chart** (`stats-view.ts → buildDurabilityChart`): Stats → Progress card showing drift over last 12 weeks (easy/long only) with 4-session rolling mean and threshold bands.
- **Marathon fade-risk badge** (`stats-view.ts → computeMarathonFadeRisk`): Race Estimates card pill on the Marathon row — Low/Moderate/High based on long-run drift at goal MP.

**Tone**: Direct, coaching voice. Not robotic, not sycophantic. Praises good execution, flags issues with actionable context ("consider starting more conservatively"), explains how the plan adapts.

**Works for all activity types** — runs get pace/split/drift analysis, cross-training gets HR effort + load commentary.

**Key files**: `src/calculations/workout-insight.ts` (`generateWorkoutInsight`), `src/ui/activity-detail.ts` (renders "Coach's Notes" card)
**Tests**: ⚠️ No dedicated tests yet

---

## Training Plan

---

### 7d. Just-Track Mode
**What it does**: Onboarding path for users who want activity tracking only, with no training plan generated. The user picks "Just track" on the fitness focus picker (4th row, after Endurance / Speed / Balanced). Under the hood they get the same infrastructure as any non-event `continuousMode` user — one rolling week that extends on calendar advance — with plan generation suppressed and prescription UI hidden. Sync (Strava / Garmin / Apple), GPS recording, activity matching, physiology polling, readiness, CTL/ACWR all run unchanged.

Upgrading to a plan later is a one-tap action from Home or Plan: `upgradeFromTrackOnly()` clears the flag, preserves accumulated CTL / synced activities / physiology, and relaunches the wizard at the goals step.

**What's hidden in track-only mode**: today-workout card, Coach/Check-in buttons, race-forecast card, week progress display, Stats Progress card (plan adherence), phase labels everywhere.

**What's kept**: readiness ring (informational), weekly volume card, recent activity feed, Stats Fitness card (CTL/VDOT — derived from actuals).

**Daily load target**: `CTL / 7 × readinessMultiplier` (readiness 80+ → ×1.3, 60–79 → ×1.0, 40–59 → ×0.7, <40 → ×0.3). Today's actual TSS rendered with Gabbett-band colour — green ≤1.3× CTL, amber 1.3–1.5, red >1.5 (Gabbett 2016 injury-risk sweet spot). Suppressed below `ctlBaseline < 20` with a "sync more history" empty state. Full rationale in `docs/SCIENCE_LOG.md → "Just-Track Daily Load Target"`.

**Plan tab**: retrospective log only — current week's activity-by-day detail plus a rolling history list of prior weeks (distance / sessions / TSS per row). No forward planning.

**Week debrief**: auto-triggers on Sunday / Monday as usual, but shows `showTrackOnlyRetrospective` — compact this-vs-last-week deltas on distance, sessions, TSS, CTL, recovery average. No plan-adherence language.

**Wizard flow**: welcome → goals (pick "Just track" tile directly) → connect-strava → review → initializing (short-circuits, skips race-target / schedule / physiology / runner-type / plan-preview) → main-view. The "Just track" tile sets `onboarding.trackOnly=true` and `initializeSimulator` takes the trackOnly branch.

**Readiness + strain detail views**: opening the readiness ring or strain breakdown on track-only home renders without the plan-comparison section (`generateWeekWorkouts` gated on `!s.trackOnly`, and `coachingText` / status labels in strain-view adapt for trackOnly). The HRV / sleep / RHR composite still computes; `plannedDayTSS` stays 0.

**Account-view safety**: Change-Runner-Type button hidden for trackOnly. Reset-Plan relabels to "Reset tracking history". "Switch to tracking only" button in Advanced lets plan-mode users opt into track mode without losing CTL/history. "Recurring activities" row in Training section lets users remove sports post-onboarding.

**Plan → track transition**: race-complete banner on home when `selectedMarathon.date < today` offers a one-tap switch. `downgradeToTrackOnly()` in `wizard/controller.ts` is the underlying function (inverse of `upgradeFromTrackOnly`). Both mode flips go through the `initializing` step with a mode-change guard so `initializeSimulator` re-runs cleanly.

**Polish (2026-04-24)**: First-launch orientation line under hero when no data. Sleep-log affordance under readiness ring. "Create a plan" demoted from full-width button to muted link. Daily-target card: "target" → "sustainable" to de-prescribe. Unified empty-state copy: "Connect Strava or record a run" across all cards. Record tab copy branches: "Record a run" instead of "Just Run — we'll fit it into your plan".

**Key files**: `src/state/initialization.ts` (trackOnly branch), `src/ui/welcome-back.ts` (calendar extension), `src/ui/home-view.ts` (`getTrackOnlyHomeHTML`, `buildTrackOnlyDailyTarget`, "Tracking" pill), `src/ui/plan-view.ts` (`getTrackOnlyPlanHTML`), `src/ui/stats-view.ts` (track-only summary branch), `src/ui/readiness-view.ts` + `src/ui/strain-view.ts` (trackOnly guards on `generateWeekWorkouts`), `src/ui/account-view.ts` (button guards), `src/ui/events.ts` (`showResetModal` copy), `src/ui/week-debrief.ts` (`showTrackOnlyRetrospective`), `src/ui/wizard/controller.ts` (`upgradeFromTrackOnly`, trackOnly branches in `nextStep()`).
**State**: `s.trackOnly: boolean`, `s.onboarding.trackOnly: boolean`, `TrainingFocus` includes `'track'`.
**Tests**: Manual — typecheck passes, pre-existing test suite unchanged. End-to-end smoke path documented in `.claude/plans/dazzling-knitting-sun.md` — not yet browser-tested.

---

### 8. Plan Generator
**What it does**: Builds the full weekly workout schedule — which runs, at what pace, for how long — based on your training phase (base/build/peak/taper), runs per week, race distance, and runner type.

**Key files**: `src/workouts/generator.ts`, `src/workouts/plan_engine.ts`
**Tests**: `src/workouts/generator.test.ts` — ✅ Passing

---

### 8b. Float Workouts
**What it does**: Adds float fartlek and float long run workouts to training plans for half-marathon and marathon distances. Float workouts use moderate-effort "float" recovery (at approximately marathon pace) instead of jogging between hard reps. This trains lactate clearance under sustained load, mimicking race-day metabolic demands.

**Who gets them**: Half-marathon and marathon plans, build and peak phases only, intermediate ability band or above. Endurance-type runners get a 1.15x priority bias (they benefit most from practicing moderate-effort running). Speed-type runners get 0.90x (lower priority). Hybrid athletes qualify at intermediate level.

**Formats**:
- Float fartlek: hard reps at 10K effort with float recovery at MP (e.g. 6x3min @ 10K, 2min float @ MP). Four rotating variants.
- Float long run (Balanced/Endurance marathon only): alternating MP and float segments over 24 to 28km.

**Science**: Moderate-effort recovery trains MCT1/MCT4 lactate transporters (Brooks 2009). Sustained blood lactate at 2 to 3 mmol/L during float segments forces aerobic adaptation under mild acidosis. Marathon specificity: fractional VO2max utilisation correlates with performance (Coyle 2007). Canova's "special block" approach for elite marathon prep.

**Key files**: `src/workouts/plan_engine.ts` (FLOAT_VARIANTS, floatWorkMinutes), `src/workouts/intent_to_workout.ts` (float case), `src/constants/workouts.ts` (library entries + load profile), `src/workouts/rules_engine.ts` (priority/bias/phase)
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

### 12b. Running Plan Adherence
**What it does**: Tracks what percentage of planned runs have been completed across all completed weeks. A run counts as completed if a matched Strava activity covers ≥95% of the target distance (post-reduction if the run was reduced). Cross-training and ad-hoc runs are excluded. Current in-progress week is excluded entirely so the number doesn't drop every Monday. Pushed workouts are excluded from their source week and scored in the week they land in.

**Key file**: `src/calculations/plan-adherence.ts` (`computePlanAdherence`), `src/ui/home-view.ts` (`buildAdherenceRow`)
**Tests**: `src/calculations/plan-adherence.test.ts` — ✅ 7 passing

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

### 15b. Illness Mode
**What it does**: When the user reports illness via the check-in overlay, an `illnessState` is saved to state. An amber banner appears on both the Home and Plan tabs showing day count, severity ("Still running" / "Full rest"), and reassurance that skipped workouts won't count against adherence. The plan itself is not mutated — the user continues to drag/skip workouts as normal. Illness clears when the user taps "Mark as recovered" / "Recovered". During an active illness week, the VDOT week-advance adherence multiplier is bypassed (treated as 100%) so skipped runs don't compound with reduced training load.

**Key files**: `src/ui/illness-modal.ts` (modal + clearIllness), `src/ui/plan-view.ts` (buildIllnessBanner), `src/ui/home-view.ts` (buildIllnessBanner), `src/ui/checkin-overlay.ts` (wires Ill button), `src/ui/events.ts` (adherence gate), `src/types/state.ts` (illnessState field)
**State**: `illnessState: { startDate, severity: 'light'|'resting', active: boolean }`
**Tests**: ❌ None yet

---

### 15c. Holiday Mode
**What it does**: When the user reports a holiday via the check-in overlay, a multi-step questionnaire collects dates, running plans ("yes/maybe/no"), and holiday type (relaxation/active/working). The system then:
- Shifts quality sessions within 2 days of holiday start forward (pre-holiday shift)
- Replaces workouts during holiday with advisory text based on running plans (rest, optional easy run, or easy-only)
- Shows a blue banner on Home and Plan views with day count, run status, and "End holiday" / "Generate session" buttons
- "Generate session" creates an ad-hoc easy run at 60% of normal session distance
- On holiday end (by date or manual): welcome-back modal analyzes actual TSS logged during holiday, classifies activity level (very active >70%, moderate 30-70%, sedentary <30%), builds 1-3 bridge weeks with scaled workouts, applies VDOT detraining
- Taper overlap: warned during questionnaire, taper weeks never modified by bridge rebuild
- Multiple holidays supported per training block via `holidayHistory`

**Key files**: `src/ui/holiday-modal.ts` (questionnaire, mods, banners, welcome-back), `src/ui/plan-view.ts` (banner + mods), `src/ui/home-view.ts` (banner), `src/ui/checkin-overlay.ts` (wires Holiday button), `src/main.ts` (holiday end detection on launch), `src/types/state.ts` (holidayState + holidayHistory)
**State**: `holidayState: { startDate, endDate, canRun, holidayType, active, preHolidayShifts?, welcomeBackShown?, preHolidayWeeklyTSS? }`, `holidayHistory: Array<{ startDate, endDate, holidayType, actualTSSRatio? }>`
**Tests**: ✅ `src/ui/holiday-modal.test.ts` — 27 tests covering parseKmFromDesc, isWeekInHoliday, getHolidayDaysForWeek, applyHolidayMods, applyBridgeMods_renderTime

---

### 15b. Session Generator

Ad-hoc workout generation from plan view. Two-step modal: pick session type then set distance or time.

- Session types: Easy, Long, Threshold, VO2 Intervals, Marathon Pace, Progressive
- Distance/time toggle with slider, secondary estimate (time from distance or vice versa)
- Generates structured workouts via `intentToWorkout` (warm-up/cool-down, paces from VDOT, interval reps)
- Added as `adhoc-*` prefixed workout in current week's `adhocWorkouts`
- Excluded from TSS calculations (suggestions, not completed activity)
- Also used by holiday banner "Generate session" button (replaces the old holiday-only chooser)

**Key files**: `src/ui/session-generator.ts`
**Tests**: ❌ None yet

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

**Recovery tier (2026-04-15)**: Intensity ladder extends to a new `'recovery'` workout type (zone 1, RPE 3, easy pace + ~43 s/km, reduced load profile). When the km floor blocks a distance cut on an all-easy week, the suggester downgrades easy → recovery instead — preserves volume, absorbs excess load. Constants provisional pending Tristan sign-off (see `SCIENCE_LOG`).

**Budget-cap fix (2026-04-15, ISSUE-137)**: Previously, a tightly capped reduction budget (small overshoot vs. large RRC) could shrink `effectiveRRC` below `minLoadThreshold`, silently suppressing all Reduce adjustments — even when a tempo remained that could have been downgraded. Now guarantees at least one quality downgrade attempt; first adjustment records its true `loadReduction` even if it overshoots budget (controlled overshoot preferred to silent suppression). Modal copy also updated: explanation banner when no reductions are possible; "Recommended" green moves from Keep → Push when that path is available.

**Km floor nudge (plan-view card)**: When running km has been below the phase floor for 2+ weeks and ACWR is safe, a card shows at the top of the plan view. If cross-training reduced runs this week, the card explains the tension (load high, km low) and offers per-run buttons to partially restore reduced easy runs. Users choose which run to extend. Cap: never exceed original pre-reduction distance. Non-reduced easy runs can be extended up to 20% (1.5 to 5km). Gated by ACWR safe (injury prevention takes priority).

**Key files**: `src/cross-training/suggester.ts`, `src/ui/suggestion-modal.ts`, `src/ui/plan-view.ts` (km nudge card)
**Tests**: `src/cross-training/suggester.test.ts`, `src/cross-training/universalLoad.test.ts` (classifier tests), `src/cross-training/matcher.test.ts`, `src/cross-training/boxing-bug.test.ts`, `src/cross-training/km-budget.test.ts` — ✅ Passing

---

### 18b. Cross-Training Load Management v2 *(designed 2026-03-04 — partially built)*

> Replaces the current "overflow → blocking modal" pattern with a tiered,
> baseline-relative, timing-aware system. See PRINCIPLES.md for the "why."
>
> **Update 2026-03-12**: Signal B baseline data (`historicWeeklyRawTSS`,
> `signalBBaseline`, `sportBaselineByType`) is now populated from the Strava edge
> function. The plan bar and excess detection are being redesigned — see
> `docs/specs/LOAD_BUDGET_SPEC.md` for the full Load Budget specification which
> supersedes the baseline/excess sections below.

#### Signal B weekly baseline — ✅ DATA EXISTS

- `historicWeeklyRawTSS` — populated from Strava edge function `history` mode
- `signalBBaseline` — computed in `stravaSync.ts` as **median** of weekly rawTSS (resistant to injury gaps)
- `sportBaselineByType` — per-sport average session TSS + frequency/week
- No proxy fallbacks needed — real Signal B data flows from the edge function

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

#### Tier 2 — Nudge card (15–40 TSS excess) — ✅ BUILT

- Amber card: *"32 TSS above your usual week · Adjust plan"*
- Detects from total week Signal B vs `computePlannedSignalB()` — matching irrelevant.
- [Adjust Plan] → reduce/replace modal with `reductionTSS = excess × weightedRunSpec × recoveryMultiplier`.
- [Dismiss] → two-tap; writes a suppression mod so card hides for the rest of the week.

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

#### Strava sport-history edge function — ✅ RESOLVED

The `history` mode on `sync-strava-activities` already returns both `totalTSS` (Signal A)
and `rawTSS` (Signal B) per week, plus `sportBreakdown` with per-sport raw TSS. No
separate `sport-history` mode needed.

**Tests to write**: timing check unit tests; baseline delta computation; Tier 1 auto-apply
distance reduction formula; Load Budget integration tests (per LOAD_BUDGET_SPEC §9).

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
**What it does**: Live workout recording. State machine: idle → acquiring signal → tracking → paused → stopped. Computes distance in real time using Haversine math, filters GPS jitter, and stores the full route. Speed-based auto-pause stops the clock after 5s below 0.5 m/s and resumes after 3s above 1.5 m/s.

**Key files**: `src/gps/tracker.ts`, `src/gps/geo-math.ts`
**Tests**: `src/gps/tracker.test.ts`, `src/gps/geo-math.test.ts` — ✅ Passing

---

### 20a. Guided Runs (phone coaching)
**What it does**: Voice and haptic coaching during a tracked structured run. Parses the workout into a step timeline (warm-up, work reps, recovery, cool-down), drives it forward from tracker ticks, and speaks cues: "Go. Threshold rep 1 of 5. 3 minutes at 4:15 per kilometre." Per-km splits are announced on paced work ("Kilometre 3. 4:15. On pace." / "… 7 seconds fast. Ease this one." / "… 7 seconds behind target."). A vertically centred rest overlay shows a big countdown, the next rep preview, and +30s / Skip rest buttons. Off by default; toggled in Account → Preferences.

**Key files**: `src/guided/timeline.ts`, `src/guided/engine.ts`, `src/guided/voice.ts`, `src/guided/haptics.ts`, `src/guided/controller.ts`, `src/guided/adherence.ts`, `src/ui/guided-overlay.ts`, `src/utils/wake-lock.ts`
**Tests**: `src/guided/*.test.ts` (65 tests), `src/utils/wake-lock.test.ts` (11 tests) — ✅ Passing

After a guided run, a "Pace adherence" summary card in the completion modal shows how many splits landed on pace (±5 sec/km), how many were fast or slow, and the average deviation in seconds.

**Keep screen on**: A Screen Wake Lock is acquired while guided mode is active so the browser does not throttle the 1s tick interval when the phone auto-locks. Toggled in Account → Preferences ("Keep screen on", default on; disabled with a "Not supported on this browser" sub-label when the API is missing, e.g. Safari pre-16.4). Web-only interim until the Capacitor shell gains `@capacitor-community/keep-awake`.

---

### 21. Split Detection
**What it does**: Reads the workout description to build a split scheme — e.g. "8×400m @ 5K pace" becomes 8 target splits of 400m each. The GPS tracker uses this to tell you when you've completed each rep and whether you're on pace. `buildSplitScheme` is a thin adapter over `buildTimeline` so the voice coach and on-screen splits can never disagree about what the workout contains.

**Key file**: `src/gps/split-scheme.ts` (derives from `src/guided/timeline.ts`)
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

### Account & Authentication

**What it does**: Mosaic uses Supabase Auth. New users are silently signed in via `supabase.auth.signInAnonymously()` on first launch — no auth wall during onboarding. Users can upgrade to a real email/password account later from a Home banner or the Account view.

**Anonymous-user data risk**: An anonymous Supabase session is tied to the device's `localStorage`. Uninstalling, switching phones, or clearing app data wipes the user — and with them all linked rows in `garmin_tokens`, `daily_metrics`, `sleep_summaries`, `garmin_activities`. There's no email to recover from.

**Guest-account upgrade prompt**: `s.isGuestAccount` is refreshed on every `launchApp()` from `supabase.auth.getUser().is_anonymous`.
- **Home banner** (`buildGuestAccountBanner` in `home-view.ts`): one-time, dismissible. Fires only when the user is a guest AND has at least one completed activity in the live plan. Dismiss flag (`s.guestBannerDismissed`) persists.
- **Account view section** (`renderGuestAccountSection` in `account-view.ts`): persistent. Visible whenever the user is a guest, regardless of dismiss state.
- Both CTAs route to `renderAuthView({ upgradeGuest: true })`.

**Auth view (`auth-view.ts`)** in upgrade mode:
- Defaults to sign-up; submits via `supabase.auth.updateUser({ email, password })` which converts the anonymous user **in place** — same `auth.users.id`, all data preserved. (`signUp()` would create a new user_id and orphan the guest data.)
- Sign-in tab shows a yellow warning that signing into an existing account leaves guest data behind.
- "Not now" cancel returns to Home without changing auth state.

**Test status**: ✅ — typecheck + 1146 tests pass; in-app behaviour pending manual verification on device.

---

### 23. Wearable Activity Sync & Review (Garmin + Apple Watch + Strava)
**What it does**: On startup, syncs recent workouts and matches them to the current week's planned workouts. Matched activities are auto-completed with a derived RPE, then the user is prompted with an RPE slider (1-10) to rate how hard each matched run felt. The slider defaults to the auto-derived RPE; dismissing keeps the auto value. Overflow activities surface for manual plan adjustment.

**Data source strategy** — two separate concerns:
- **Activity source** (what happened): Strava if connected, otherwise Garmin webhook or Apple Watch
- **Biometric source** (physiology — VO2max, LT, HRV, sleep, resting HR): always the wearable (Garmin or Apple Watch), independent of Strava. Source routing uses `connectedSources` state field with accessor functions in `src/data/sources.ts`.

**Strava path** (`s.stravaConnected`): `syncStravaActivities()` → `sync-strava-activities` Edge Function. Fetches activity list + full HR streams; computes iTRIMP. Activity IDs namespaced as `"strava-{id}"`. Garmin users who also have Strava use this path for activities AND get a Garmin physiology sync in parallel. Apple Watch users who have Strava get Strava for activities AND HealthKit for physiology in parallel.

**Garmin-only path** (`!s.stravaConnected`, physiology source `'garmin'`): `syncActivities()` → `sync-activities` Edge Function (28-day lookback). Activities arrive via Garmin Health API webhook → Supabase `garmin_activities` table.

**Apple Watch activity path**: `syncAppleHealth()` → `@capgo/capacitor-health` → `Health.queryWorkouts()` on-device (iOS native only; no-op on web). Workout IDs namespaced as `"apple-…"` to prevent dedup collisions.

**Apple Watch physiology path** ✅: `syncAppleHealthPhysiology()` → `@capgo/capacitor-health` → `Health.readSamples()` for sleep stages, HRV (SDNN), resting HR, steps. Converts to `PhysiologyDayEntry[]` and stores in `s.physiologyHistory`. Sleep score computed from stage breakdown (duration 55%, deep 25%, REM 20%). Runs on launch for Apple Watch users (both Apple-only and Strava+Apple Watch).

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

**Excess Load Card** (`src/ui/excess-load-card.ts`): amber card on the Training tab when total week Signal B exceeds `computePlannedSignalB()` by 15–40 TSS (Tier 2). Detection is from the full week picture — whether activities matched plan slots or not is irrelevant. Shows TSS over target and [Adjust Plan] / [Dismiss] buttons. "Adjust Plan" triggers reduce/replace modal using total excess × weightedRunSpec × recoveryMultiplier. Tier 1 (≤15 TSS): auto-suppressed. Tier 3 (>40 TSS): blocking modal fires instead.

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
**What it does**: For runners who aren't training toward a specific race. Instead of a fixed plan ending on race day, the app cycles through repeating 4-week blocks (base → build → intensify → deload). Optional benchmark check-ins at the start of each new block (post-deload, when freshest) measure progress.

**Key files**: `src/workouts/plan_engine.ts` (block cycling), `src/state/initialization.ts`
**Tests**: `src/ui/continuous-mode.test.ts` — ✅ Passing

**Benchmark check-in UI** (in `src/ui/benchmark-overlay.ts`): Centered overlay shown on post-deload weeks (week 5, 9, 13, ...). Selecting a check-in type generates a structured workout via `intentToWorkout` (same as session generator) and adds it to the week's plan. Four states in the plan-view card: prompt (open overlay), workout added (awaiting completion), recorded (from watch), skipped. No manual entry — results come from watch/Strava data after the workout is completed.

---

### 25. State Persistence
**What it does**: Saves and restores the entire app state (your plan, ratings, injury history, settings) to the device's local storage. Includes schema migrations so old saved states upgrade cleanly when the app updates.

**Supabase backup**: Every `saveState()` call also fires a background upsert to `user_plan_settings` (Supabase). On login, if localStorage is empty (wipe, reinstall, new device), the app silently restores from this backup before rendering — no user action required. Large re-fetchable arrays (`historicWeeklyTSS`, `physiologyHistory`, etc.) are excluded from the snapshot and rebuilt from Strava/Garmin on first sync.

**Key files**: `src/state/persistence.ts`, `src/data/planSettingsSync.ts`
**Tests**: `src/state/persistence.test.ts` — ✅ Passing

---

### 26. Missed Week Detection + Week-End Debrief (3-Step Flow)
**What it does**: On app open after a missed week, `detectMissedWeeks()` silently applies VDOT detraining and advances the plan pointer (no modal). At week end, a 3-step debrief flow fires (once per week, guarded by `lastDebriefWeek`):

**Step 1 — Week Summary**:
- Phase badge + "Week N complete"
- Training load % vs planned, distance km, Running Fitness delta (CTL direction)
- Coach signal pills (Effort, Load, Fitness, HR drift) + coach narrative copy
- CTA: "Generate next week" (complete mode) or "Continue" (review mode)

**Step 2 — Analysis Animation** (~2.5s):
- Progress bar fills across the modal top
- Stepped checklist ticks through: HR data, pace vs HR targets, RPE feedback, training load, recovery signals, plan generation
- Transitions to Step 3 on completion

**Step 3 — Suggested Plan**:
- Shows next week's generated sessions with type badges (Easy, Long, Tempo, VO2, MP)
- "Adjustments applied" card listing what changed: effort scaling, ACWR-driven quality reduction, long run capping, volume changes
- Toggle between "Adjusted plan" (with effort/ACWR context) and "Standard plan" (vanilla)
- Accept button proceeds to uncompleted session handling, then advances the week

Three trigger paths: user taps "Wrap up week" in the plan page, auto-trigger on Sunday, or auto-trigger on app open after week advance.

**Key files**: `src/ui/week-debrief.ts`, `src/ui/welcome-back.ts` (state logic only), `src/main.ts`, `src/workouts/plan_engine.ts` (plan generation + effortMultiplier)
**Tests**: ⚠️ No automated tests

---

### 27. Training Load (TL) + Performance Management Chart (PMC)
**What it does**: Computes Signal A (run-equivalent) and Signal B (raw physiological) TSS per week. Displays CTL/ATL/TSB (fitness/fatigue/form) in the Stats tab. CTL = Signal A (42-day EMA of run-equiv load); ATL = Signal B (7-day EMA of total load including cross-training at full weight). ACWR = Signal B ATL / Signal A CTL — correctly flags cross-training-heavy weeks.

**Three-signal model**:
- **Signal A** (`computeWeekTSS`): run-equivalent TSS with runSpec discount. Used for CTL, replace/reduce decisions, race prediction.
- **Signal B** (`computeWeekRawTSS`): raw physiological TSS, no runSpec discount. Used for ATL, ACWR injury risk, "This Week" load card.
- **Signal C** (`wk.actualImpactLoad`): musculoskeletal impact. Computed, not yet surfaced in UI.

**Stats Tab** (redesigned 2026-03-19 — three-pillar architecture: Progress · Fitness · Readiness):

**Opening screen** — four stacked sections, each card taps into a single-scroll detail page (no tabs inside detail pages):
- **Progress card**: Race mode → horizontal arc/timeline (plan start → race day) + forecast finish badge + on-track pill. General fitness mode → tier progress bar showing % to next tier (Building/Foundation/Trained/Well-Trained/Performance/Elite based on CTL daily-equivalent)
- **Fitness card**: Compact VO2 Max sparkline + current value (device when available, VDOT fallback labelled "est.") + tier label; taps into Fitness detail
- **Readiness card**: Single Freshness scale bar (gradient zones) with properly positioned floating marker at actual TSB value; taps into Readiness detail
- **Summary** (flat, no tap-through): Race predictions (Marathon/Half/10K/5K from `vt()`) in race mode; Training paces (Easy/MP/Threshold/VO2max from `fp()`) in both modes

**Progress detail page** (single scroll):
- Phase Timeline bar (colour-coded Base/Build/Peak/Taper bands, dot at current week)
- Training Load line chart (Signal B TSS, 8w/16w/all toggle)
- Running Distance line chart (same toggle)
- CTL line chart (Signal A 42-day running fitness, same toggle)

**Fitness detail page** (single scroll):
- Scale bars: Running Fitness (CTL daily-equiv), VO2 Max (device preferred, VDOT fallback), Lactate Threshold — all with ⓘ info buttons
- VO2 Max trend line chart (8w/16w/all toggle)
- Race forecast detail, Forecast times, Training paces

**Readiness detail page** (single scroll):
- Scale bars (Training Load section): Freshness (TSB), Short-Term Load (ATL), Load Safety (ACWR), Fitness Momentum
- Freshness trend line chart with zone bands (8w/16w/all toggle)
- Recovery & Physiology (expanded — no accordion): Recovery Score bar, Sleep sparkline, HRV sparkline, RHR sparkline

**Scale bar marker fix**: marker is a `left: pct%` positioned vertical bar inside position:relative container. ⓘ info icon is next to the row title, not on the bar.

**Key functions**:
- `src/ui/stats-view.ts` — `buildProgressCard_Opening()`, `buildFitnessCard_Opening()`, `buildReadinessCard_Opening()`, `buildSummarySection()`, `buildProgressDetailPage()`, `buildFitnessDetailPage()`, `buildReadinessDetailPage()`

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
- `src/workouts/generator.ts` — `generateWeekWorkouts()` effortScore + acwrStatus params (wired from all call sites)
- `src/calculations/fitness-model.ts` — `getTrailingEffortScore()` shared helper (trailing RPE from last 2 weeks)
- `src/ui/renderer.ts`, `home-view.ts`, `plan-view.ts`, `events.ts`, `main-view.ts`, `activity-review.ts`, `recording-handler.ts`, `timing-check.ts` — all pass effortScore + acwrStatus to `generateWeekWorkouts`
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
- **Recovery** (20%, greyed out if no watch) — composite of HRV (50%), Last Night Sleep (25%), Sleep History 7d avg (25%). All sleep inputs z-scored against 28-day personal baseline internally; display shows raw Garmin/Apple scores. RHR acts as override only (cap when elevated >= 2 SD).

**Safety floors** (hard caps applied last, regardless of other signals):
- ACWR > 1.5 → score ≤ 39 (Ease Back); ACWR 1.3–1.5 → score ≤ 59 (Manage Load)
- Sleep < 45 → score ≤ 59; Sleep < 60 → score ≤ 74
- Sleep bank > 5h deficit → score ≤ 59; > 3h → score ≤ 74
- **Strain 50–100%** → floor slides linearly 100→59 (session in progress)
- **Strain 100–130%** → score ≤ 59 (daily target hit)
- **Strain > 130%** → score ≤ 39 (well exceeded target)
- **Leg load >= 20** → score ≤ 54 (Manage Load — moderate eccentric/impact damage)
- **Leg load >= 60** → score ≤ 34 (Ease Back — heavy EIMD, 72-96h recovery window)

**Today's Strain Score** (ring label renamed from "Strain"):
- Today's Signal B TSS ÷ day's target TSS × 100.
- Target = today's planned workout TSS (estimated from RPE × TL_PER_MIN × duration). On rest days (planned sessions = 0), target is 0 — no baseline fallback applied.
- Rest day: ring shows "Rest day" in grey; if any activity logged, shows "X TSS logged" sub-label. No % on rest days.
- 100% = you've completed what was planned. > 100% = went beyond plan. < 100% = session in progress.
- Colours: grey (rest/0%) → amber (partial) → green (on target) → red (exceeded).
- **Strain ring is tappable** → opens `src/ui/strain-view.ts` (full-screen detail page).

**Strain detail page** (`src/ui/strain-view.ts`) — answers "What did I do today and how hard was it?":
- Terracotta/orange gradient header with animated SVG ring (orange gradient, 1.4s cubic-bezier). Rest days show "Rest day" with grey ring.
- 7-day week position bars: one row per day (Mon–Sun) of the current plan week. Each row shows day label, horizontal bar with actual TSS filled against planned TSS track, today highlighted in orange, future days show ghost track only.
- Activity timeline for the selected date (from `garminActuals`); tapping a row opens a detail overlay (duration, HR, TSS, kCal).
- Steps placeholder card: "Daily steps / — / Garmin steps coming soon".
- Date picker: tapping the header date reveals a scrollable row of the last 7 days.
- Info (`?`) button opens a strain explainer overlay (Signal B, thresholds table).
- Back button returns to Home. No tab bar on this page (iPhone sub-page pattern).

**Sentence logic**: A single `primaryMessage` from `computeDailyCoach()` replaces the old separate readiness sentence + HRV banner. Priority chain: injury/illness blockers → strain complete/exceeded → **leg-load hard floor (surfaces `readiness.legLoadNote`)** → ACWR spike → combined sleep + HRV → poor sleep → deep HRV drop → sleep debt → ACWR caution → moderate sleep/HRV → recovery driving signal → recent cross-training → session in progress → taper phase → HRV elevated → positive conditions (fresh/safe/good recovery with workout-aware copy) → CTL trend → week RPE → TSB/ACWR matrix fallback. Every tier produces workout-aware copy (references today's planned session name, hard vs easy). Hard-floor signals (leg-load, ACWR) are routed by `readiness.hardFloor` *before* sleep-debt copy, so the message always explains whatever is actually capping the score.

**Score → label**: 80–100 Ready to Push (green) · 60–79 On Track (blue) · 40–59 Manage Load (amber) · 0–39 Ease Back (red). When ACWR > 1.5 hard floor is active, label overrides to **Overreaching** (red).

**Home layout (triangle)**: Readiness ring top-centre (120px, larger), Sleep + Strain rings side by side below (100px each). Tapping Readiness ring opens `readiness-view.ts`. Tapping Sleep opens `sleep-view.ts`. Tapping Strain opens `strain-view.ts`. The Freshness/Load Ratio/Recovery pill row has been moved off the home page into `readiness-view.ts`.

**Adjust button**: Shown below the sentence when readiness ≤ 59 **and** the click handler has something to do. For most driving signals: ACWR caution/high, unspent cross-training load, or at least one unrated run anywhere in the remaining week (the future-week check is needed because plan-engine moves can slide a hard session into today). For `legLoad` specifically: the remaining-run check tightens to an unrated *hard* session (`isHardWorkout(w.t)`) so the button only shows when there's a real impact target to defer or downgrade — otherwise "Protect the legs" has nothing to act on. Hidden when no target. Text varies by driving signal (Adjust plan / Reduce session load / Take it lighter today / Protect the legs / Keep consistency).

**Coach advisory note**: rendered when `coach.workoutMod === 'downgrade'` or `'skip'`. Strict advisory copy — no claim that a change has been made to the plan, since the workout description is unchanged. `'downgrade'` → *"Go easier today."*; `'skip'` → *"Consider rest today."*. On the Plan today-row the lead clause is followed by `coach.primaryMessage`. On the Home today card only the lead clause renders, because the readiness-ring card directly below already carries the full `primaryMessage` as its sentence — repeating it would be double messaging.

**Readiness detail page** (`src/ui/readiness-view.ts`): Opens from the Readiness ring. Sky-gradient design (same as recovery-view). Shows composite ring at top (animated, dynamic colour), readiness sentence, driving factor callout (when a hard floor is active, including a leg-fatigue callout linking to the detail page when `hardFloor === 'legLoad'`), and sub-signal cards: Freshness (TSB daily-equivalent + zone + "to baseline" hours pill using stacked session recovery), Load Ratio (ACWR ratio + status + acute/chronic TSS breakdown, highlighted when driving), Recovery (score/100 + explanation + "View detail" link to recovery-view). Back button returns to home.

**Leg Fatigue** (card on Rolling Load, detail page): The mechanical/localised load signal, distinct from cardiovascular TSS. Cap and soft taper applied directly in `computeReadiness()`: `>= 60` → cap 34 (Ease Back), `>= 20` → cap 54 (Manage Load), linear soft taper across 10–20 so the threshold isn't a cliff. Always-visible card at the top of Rolling Load shows current decayed total, status (Fresh / Light / Moderate / Heavy), and a one-line interpretation. Tap opens the detail page.

**Running included in Leg Fatigue (added 2026-04-25)**: Runs now contribute to leg load via `distanceKm × effortMultiplier(rpe)` (RPE-tier multiplier reused from `IMPACT_PER_KM`). RPE comes from the logged `wk.rated[id]` if available, else HR-derived Karvonen mapping — handles bonked runs correctly. RBE discount is suppressed for hard runs (RPE ≥ 7) since maximal-effort EIMD is novel stress. Backfill runs through `reconcileRecentLegLoads()` on launch and after activity sync. See `docs/SCIENCE_LOG.md → Running Leg Load` for derivation.

**Leg Fatigue detail page** (`src/ui/leg-load-view.ts`, added 2026-04-15): Opens from the Leg Fatigue card on Rolling Load or from the Readiness callout banner. Bronze sky-gradient palette to distinguish from the other detail pages. Hero ring uses a piecewise mapping (MODERATE = 30%, HEAVY = 70%, extreme 120+ = 100%) so reload beyond HEAVY still reads as worse. Shows a 7-day decay timeline with MODERATE/HEAVY threshold zones and a 4-day forward projection, "floor releases" + "fully fresh" hour projections, a per-session contributors list (raw load, decayed-remaining, half-life, reload penalty), and an explainer of the EIMD-based model with constants and citations. Driven by the `computeLegLoadBreakdown()` helper exported from `readiness.ts`.

**No Jargon Policy**: ATL/CTL/TSB/ACWR never shown in user-facing copy. Info sheets use both: "Running Fitness (CTL)", "Freshness (TSB)", etc.

**Key files**:
- `src/calculations/readiness.ts` — `computeReadiness()`, `readinessColor()`, `drivingSignalLabel()`
- `src/calculations/daily-coach.ts` — `computeDailyCoach()`, `derivePrimaryMessage()` (unified sentence logic)
- `src/calculations/fitness-model.ts` — `computeTodaySignalBTSS()`, `computePlannedDaySignalBTSS()`, `computeDayTargetTSS()`, `computePassiveTSS()`, `calibrateTssPerActiveMinute()`
- `src/ui/home-view.ts` — `buildReadinessRing()`, ring tap handlers
- `src/ui/readiness-view.ts` — Readiness detail page (new)
- `src/ui/leg-load-view.ts` — Leg Fatigue detail page (new 2026-04-15) — decay timeline, contributors, projections
- `src/ui/rolling-load-view.ts` — hosts the permanent Leg Fatigue card
- `src/ui/rolling-load-view.ts` — Rolling Load detail page: 28-day angular chart + 7-day zone bars + zone balance
- `docs/strain.md` — strain design doc + gap register

**Tests**: ✅ 26 tests (`src/calculations/readiness.test.ts`) — all edge cases, safety floor, driving signal, recovery integration, deload/taper scenarios. ⚠️ No tests yet for `computeTodaySignalBTSS` or `computePlannedDaySignalBTSS`.

---

### 31. Sleep Detail View

**What it does**: Full-screen dark-theme sleep detail opened by tapping the sleep sparkline on Home or Stats. Shows last night's quality score, duration, stage breakdown (Deep / REM / Light / Awake), HRV + RHR metric tiles, a consultant-tone insight card, 7-night score trend, and a sleep bank.

**Stage quality labels**: Each stage row shows a quality label (Excellent / Good / Low / Normal / Elevated) derived from population norms:
- Deep (SWS): <13% Low, 13–20% Good, >20% Excellent
- REM: <15% Low, 15–22% Good, >22% Excellent
- Awake: ≤8% Normal, >8% Elevated
- Light: no label (residual stage)

**Stage vs 7-day insight** (`getStageInsight()`): Compares today's REM and Deep percentages to the 7-day rolling average from `physiologyHistory`. Falls back to population norms if < 3 prior nights with stage data. Example output: "REM 11% — below your 18% 7-day average. Central fatigue risk is elevated on quality sessions today."

**Sleep target** (`deriveSleepTarget()`): user-configured `sleepTargetSec` if set, otherwise the median of the last 30 nights, clamped to [7h, 9h]. Floor anchored to Van Dongen 2003; ceiling to NSF/Hirshkowitz 2015. Returns 7h fallback below 5 nights of history. Per-night target adds a load bonus (`+0.25 min/TSS`, tier-capped) on top of the base.

**Sleep Bank** (`getSleepBank()`): 7-night rolling sum of `(actual_sleep − sleep_target)`. Used internally as input to recovery and readiness scoring. Display surfaces use the cumulative debt instead.

**Cumulative sleep debt** (`computeSleepDebt()` / `computeSleepDebtSeries()`): exponential-decay debt with capped surplus credit. 7-day half-life, 0.5 surplus-credit ratio, 60-min/night surplus cap. Headline number on the Sleep page; tier classification (`classifySleepDebt()`) drives the colour gradient through emerald → slate → amber → orange → red.

**Sleep debt outlook** (`computeSleepDebtOutlook()`): turns the static debt number into a trajectory.
- Trend — debt vs 7 series-entries ago (clearing or growing)
- Days-to-clear — forward simulation using last-7-night avg actual sleep, returns days until debt drops into "on track" tier (< 45m), or null if not clearing
- Spike attribution — single nights with shortfall > 2h, contribution decayed via `shortfall × DEBT_DECAY^(days_since)` and capped at total debt
- Personal-norm comparison — 30-day rolling mean of debt series (≥14 entries required); today's debt classified `above`/`below`/`on_par` against this baseline using `max(30 min, 15% of typical)` tolerance. Independent relative colour (amber/emerald/slate) — lets chronic short-sleepers see whether *this* week is worse than *their* week, without conflating with the population-anchored absolute tier.
Surfaces in the cumulative-debt card as two lines under the headline:
1. **Status** (relative-coloured): personal-norm comparison — *"Above your typical 2h 23m — sleep is worse than usual."*
2. **Context** (slate): driver · trend · ETA combined with `·` separators. Driver phrasing adapts to the spike ratio: `> 0.7` reads "mostly from Sun's short night"; `0.3–0.7` quantifies as "1h 30m from 2 short nights"; `< 0.3` drops the driver segment so chronic gap is the story.

**Sleep bank floor on readiness**: Feeds into `computeReadiness()` as `sleepBankSec`. A 3h deficit caps readiness at 74; a 5h deficit caps at 59. Only applied when ≥ 3 nights of data available.

**Key files**:
- `src/calculations/sleep-insights.ts` — `stageQuality()`, `getSleepBank()`, `fmtSleepBank()`, `fmtSleepDebt()`, `deriveSleepTarget()`, `computeSleepDebt()`, `computeSleepDebtSeries()`, `computeSleepDebtOutlook()`, `classifySleepDebt()`, `getStageInsight()`, `buildSleepBankLineChart()`
- `src/ui/home-view.ts` — `showSleepSheet()` (full dark UI)
- `src/calculations/readiness.ts` — `sleepBankSec` floor in `computeReadiness()`

**Tests**: ⚠️ No unit tests for new functions yet.

---

### Coach

**What it does** (reframed 2026-04-24, rules-only): A "Coach" pill in the Home and Plan headers opens the Coach sub-page. The page leads with a stance pill (Ready to Push / On Track / Manage Load / Ease Back) and the single-sentence `primaryMessage` from the rules engine, followed by a "Why this call" card that translates blockers and key signals into short evidence bullets. Below that, stacked cards for Recovery (sleep, HRV, sleep debt), Fitness (CTL + trend, week TSS, 4-week trend), This week (effort + load pills), and Status (injury, illness, check-in). Optional session-drift and sleep-pattern narratives appear when relevant. The daily "How do you feel today?" prompt sits at the bottom. Sky-background palette varies by stance (mint / deepBlue / amber / rose) so the page colour signals state at a glance, matching the Sleep / Recovery / Readiness design language.

**Aggregator**: `computeDailyCoach(state)` gathers TSB/ACWR/sleep/HRV/RPE/week-load/injury/illness into a `CoachState` and derives a `stance` (`push | normal | reduce | rest`), `blockers` array, `primaryMessage`, `sessionNote`, `sleepInsight`, and `workoutMod` (`none | downgrade | skip`, derived from stance). Priority hierarchy: injury / resting illness override everything → ACWR overload → sleep deficit → readiness score. Stance uses the readiness-label vocabulary.

**Tiered illness**: `illnessState.severity === 'resting'` forces stance to `rest`; `'light'` caps stance at `reduce` (drops `push`/`normal` down, leaves `reduce`/`rest` alone). Illness cap is applied before the feeling modifier so a `good` feeling on a light illness day still returns `reduce`.

**Daily feeling modifier**: `s.todayFeeling` (one-tap `struggling | ok | good | great`, stored with today's ISO date, expires at end of day) shifts the base stance. `struggling` drops one level (push → normal → reduce → rest); `good`/`great` promote only `normal → push`, gated on `blockers.length === 0` AND `readiness.score >= 75` (Primed threshold sourced from `readiness.ts`). `ok` is a no-op. Science: athlete self-report is a well-validated fatigue indicator (Saw 2016 meta-analysis). See `docs/SCIENCE_LOG.md`.

**LLM narrative: deferred.** `supabase/functions/coach-narrative/index.ts` remains in the repo as dormant scaffolding (JWT auth, rate limiting, spend cap, field allowlisting already hardened) but is not deployed and not called from the client. The rules layer is the product's moat; the LLM narrative added cosmetic prose only. Next LLM scope, when revisited, is "Ask the coach" (a chatbot that explains plans and recovery), not the narrative paragraph. See `docs/BRAIN.md` for the preserved design reference.

**Key files**:
- `src/calculations/daily-coach.ts` — aggregator + `CoachState` / `CoachSignals` types
- `src/ui/coach-view.ts` — Coach sub-page (stance hero, "Why this call" explanation, stacked signal cards, feeling prompt)
- `supabase/functions/coach-narrative/index.ts` — dormant LLM edge function (do not deploy)

**Tests**: ✅ `src/calculations/daily-coach.test.ts` — 20 cases covering stance → workoutMod mapping, illness tiering (resting/light), daily feeling modifier transitions, and `getTodayFeeling` end-of-day expiry.

---

### Coach workout modifier (today's card)

**What it does**: When today's coach stance is `reduce` or `rest`, a muted bordered note appears alongside today's workout row on both Home and Plan. `reduce` shows "Downgraded." + `coach.primaryMessage`; `rest` shows "Consider rest today." + `coach.primaryMessage`. The workout content is not changed — the athlete sees the advisory and chooses whether to act on it. On `normal` or `push` stance the note is omitted. Only renders on today's row; past and future days are unaffected. Suppressed when the session is already rated, skipped, or replaced.

**Derivation**: `workoutMod` now lives on `CoachState` and is computed inside `computeDailyCoach` from the final stance (`rest → skip`, `reduce → downgrade`, otherwise `none`), matching `docs/BRAIN.md §How it affects the plan`. Both view files read `coach.workoutMod` directly — the duplicated `deriveWorkoutMod` helpers have been removed. Reason text comes from `coach.primaryMessage`, which the rules engine already writes as a user-ready sentence.

**Key files**:
- `src/ui/home-view.ts` — `buildTodayWorkout(s, coach?)` appends the note below the card
- `src/ui/plan-view.ts` — `buildWorkoutCards` appends a bordered sub-row inside today's card

**Tests**: ⚠️ No automated tests

---

## Activity Detail Page

**What it does**: Full-page view for a single synced activity (Garmin or Strava). Shows a stats grid (distance, time, pace, avg HR, max HR, calories), HR zone bars with time breakdown, km splits with pace-coloured bar chart, and an OSM route map (if polyline is available). For cross-training activities, an "Activity" row sits between hero and stats and lets the user reclassify the sport when the auto-classification is wrong (most commonly generic "cardio" activities like kitesurfing, SUP, or sailing). Reclassify triggers a live delta on week load, impact, and leg fatigue, and saves a persistent name mapping so future syncs of same-named activities auto-apply. Accessible from:
- Plan tab → Activity Log rows (plan-matched activities)
- Plan tab → inline actMatchRow on workout cards
- Plan tab → "View full activity →" link in expanded card detail
- Home tab → Recent activity rows (garmin-backed only)

**Key file**: `src/ui/activity-detail.ts`
**Related**: `src/ui/strava-detail.ts` (`drawPolylineOnCanvas` now exported); `src/ui/sport-picker-modal.ts` (picker + `reclassifyActivity` + `resolveSportForActivity` used by sync)
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
