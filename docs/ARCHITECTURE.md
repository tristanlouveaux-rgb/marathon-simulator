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
| `state/` | Central store + persistence + plan initialization | `store.ts`, `initialization.ts`, `persistence.ts` | `getState()`, `getMutableState()`, `updateState()`, `loadState()`, `saveState()`, `initializeSimulator()` |
| `workouts/` | Plan generation, scheduling, gym workouts | `generator.ts`, `plan_engine.ts`, `scheduler.ts`, `gym.ts`, `load.ts` | `generateWeekWorkouts()`, `planWeekSessions()`, `assignDefaultDays()`, `generateGymWorkouts()`, `calculateWorkoutLoad()` |
| `calculations/` | VDOT, paces, predictions, fatigue, physiology | `vdot.ts`, `paces.ts`, `predictions.ts`, `fatigue.ts`, `training-horizon.ts`, `physiology-tracker.ts`, `heart-rate.ts` | `cv()`, `vt()`, `gp()`, `blendPredictions()`, `calculateLiveForecast()`, `getRunnerType()`, `applyTrainingHorizonAdjustment()` |
| `injury/` | Phase-based injury management + workout adaptation | `engine.ts` | `applyInjuryAdaptations()`, `evaluatePhaseTransition()`, `recordPainLevel()`, `analyzeTrend()` |
| `cross-training/` | Universal load model, workout matching, suggestions | `universalLoad.ts`, `matcher.ts`, `load-matching.ts`, `suggester.ts` | `computeUniversalLoad()`, `applyCrossTrainingToWorkouts()`, `buildCrossTrainingPopup()`, `applyAdjustments()` |
| `gps/` | GPS tracking, split detection, recording persistence | `tracker.ts`, `geo-math.ts`, `split-scheme.ts`, `persistence.ts` | `GpsTracker` (class), `haversineDistance()`, `filterJitter()`, `buildSplitScheme()` |
| `recovery/` | Morning check-in, sleep/readiness scoring | `engine.ts` | `computeRecoveryStatus()`, `sleepQualityToScore()`, `RecoveryEntry`, `RecoveryLevel` |
| `ui/` | Dashboard, renderer, events, wizard, modals | `main-view.ts`, `renderer.ts`, `events.ts`, `wizard/controller.ts`, `activity-review.ts`, `welcome-back.ts` | `renderMainView()`, `render()`, `next()`, `rate()`, `skip()`, `initWizard()`, `showActivityReview()`, `detectMissedWeeks()`, `showWelcomeBackModal()` |
| `constants/` | Static config, protocols, sport DB, training params | `index.ts`, `injury-protocols.ts`, `sports.ts`, `training-params.ts` | `INJURY_PROTOCOLS`, `SPORTS_DB`, `TRAINING_HORIZON_PARAMS` |
| `types/` | All TypeScript interfaces and type unions | `state.ts`, `injury.ts`, `onboarding.ts`, `training.ts`, `activities.ts`, `gps.ts` | `SimulatorState`, `Workout`, `InjuryState`, `OnboardingState`, `TrainingPhase` |
| `data/` | Static data (marathon events list) | `marathons.ts` | Marathon event catalog |
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
    → computes VDOT from PBs (cv()), runner type (getRunnerType())
    → generates paces (gp()), predictions (blendPredictions())
    → builds initial s.wks[] array with phase assignments
  → SimulatorState ready → renderMainView()
```

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
| VDOT/fitness | `v` (starting VDOT), `iv` (initial), `rpeAdj`, `expectedFinal` |
| Race config | `rd` (race distance), `rw` (runs/week), `gs` (gym sessions), `epw` (exercises/week), `wkm` (weekly km) |
| PBs & recent | `pbs` (PBs object), `rec` (RecentRun) |
| Physiology | `lt` (LT pace sec/km), `vo2` (VO2max), `maxHR`, `restingHR` |
| Race times | `initialBaseline`, `currentFitness`, `forecastTime` |
| Runner profile | `typ` (RunnerType), `b` (fatigue exponent) |
| Training data | `pac` (Paces), `skip` (skip tracking), `timp` (time impact) |
| Injury | `injuryState` (InjuryState), `rehabWeeksDone`, `lastMorningPainDate` |
| Continuous mode | `continuousMode`, `blockNumber`, `benchmarkResults` |
| Recovery | `recoveryHistory` (RecoveryEntry[]), `lastRecoveryPromptDate` |
| Onboarding | `onboarding` (OnboardingState), `hasCompletedOnboarding` |

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

Wizard data: `name`, `raceDistance`, `trainingForEvent`, `runsPerWeek`, `gymSessionsPerWeek`, `experienceLevel`, `pbs`, `ltPace`, `vo2max`, `continuousMode`, `recurringActivities`.

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
| `s.timp` | Total time impact (skips) | `number` |
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

15 positional params. Called from `renderer.ts:render()`:

```ts
generateWeekWorkouts(
  phase, runsPerWeek, raceDistance, runnerType,
  previousSkips, commuteConfig, injuryState, recurringActivities,
  fitnessLevel, hrProfile, easyPaceSecPerKm,
  weekIndex, totalWeeks, vdot, gymSessionsPerWeek
)
```

When `weekIndex` and `totalWeeks` are provided, uses `planWeekSessions()`. Otherwise falls back to the legacy `rules_engine.ts`.

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

**Three data tiers**: Garmin (Tier A), HR-only (Tier B), RPE-only (Tier C, with uncertainty penalty).

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
- Split detection: `buildSplitScheme()` parses workout descriptions (e.g. "8×400m @ 5K pace") into split targets
- Recordings persisted to localStorage with an index

### Recovery & Deload (`src/recovery/engine.ts`)

Morning check-in: sleep score + Garmin readiness + HRV status → `computeRecoveryStatus()` → green/yellow/orange/red.

- Trend escalation: 2 of 3 days low → escalate level
- Non-green triggers adjustment modal: downgrade hard workout / reduce distance / flag as easy
- Plan engine has built-in deload weeks via `isDeloadWeek()` (every 3rd–4th week by ability band)

### Gym Integration (`src/workouts/gym.ts`)

Phase-aware strength templates:
- Base: heavy compound lifts
- Build: explosive power
- Peak: maintenance
- Taper: activation only

Three ability tiers: beginner (bodyweight), novice (light weights), full (barbell). Deload weeks reduce by 1 session + lower RPE. Gym workouts never replace running sessions.

**Injury handling**: no gym in acute/rehab/test_capacity; light return session in return_to_run (level 5+).

### Garmin Activity Sync (`src/data/activitySync.ts`, `src/calculations/activity-matcher.ts`)

Fire-and-forget on boot: `syncActivities()` calls the `sync-activities` Edge Function (14-day lookback), then `matchAndAutoComplete()` processes results.

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

## Spec Docs

| Doc | Covers |
|-----|--------|
| `docs/FEATURES.md` | Full feature list with plain-English descriptions and test status |
| `docs/CHANGELOG.md` | Session-by-session change history |
| `docs/recovery-deloading-spec.md` | Recovery scoring, deload logic, adjustment rules |
| `docs/non-event-design-spec.md` | Continuous mode, block cycling, benchmarks |
| `docs/TECH_SPECS.md` | Technical specifications |
| `docs/ENGINE_AUDIT.md` | Engine audit findings |
| `docs/FORECAST_MATRIX_AUDIT.md` | Prediction model audit |
