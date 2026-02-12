# Architecture: Mosaic Training Simulator

> Marathon training plan simulator with adaptive weekly generation, injury management,
> cross-training integration, GPS tracking, and strength training support.
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
| `calculations/` | VDOT, paces, predictions, fatigue, physiology | `vdot.ts`, `paces.ts`, `predictions.ts`, `fatigue.ts`, `training-horizon.ts`, `physiology-tracker.ts` | `cv()`, `vt()`, `gp()`, `blendPredictions()`, `calculateLiveForecast()`, `getRunnerType()`, `applyTrainingHorizonAdjustment()` |
| `injury/` | Phase-based injury management + workout adaptation | `engine.ts` | `applyInjuryAdaptations()`, `evaluatePhaseTransition()`, `recordPainLevel()`, `analyzeTrend()` |
| `cross-training/` | Universal load model, workout matching, suggestions | `universalLoad.ts`, `matcher.ts`, `load-matching.ts`, `suggester.ts` | `computeUniversalLoad()`, `applyCrossTrainingToWorkouts()`, `buildCrossTrainingPopup()`, `applyAdjustments()` |
| `gps/` | GPS tracking, split detection, recording persistence | `tracker.ts`, `geo-math.ts`, `split-scheme.ts`, `persistence.ts` | `GpsTracker` (class), `haversineDistance()`, `filterJitter()`, `buildSplitScheme()` |
| `recovery/` | Morning check-in, sleep/readiness scoring | `engine.ts` | `computeRecoveryStatus()`, `sleepQualityToScore()`, `RecoveryEntry`, `RecoveryLevel` |
| `ui/` | Dashboard, renderer, events, wizard, modals | `main-view.ts`, `renderer.ts`, `events.ts`, `wizard/controller.ts` | `renderMainView()`, `render()`, `next()`, `rate()`, `skip()`, `initWizard()` |
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

Core fields grouped by concern:

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

Phase-based recovery: `active`, `injuryPhase` (see phases below), `currentPain` (0-10), `history` (pain entries), `capacityTestsPassed`, `returnToRunLevel` (1-8), `zeroPainWeeks`, `graduatedReturnWeeksLeft`.

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

1. Add the type string to workout generation in `plan_engine.ts` or create a dedicated generator (see `gym.ts` as example)
2. The `Workout.t` field is a free string — no enum to update
3. Add load calculation support in `workouts/load.ts` if the type has distinct aerobic/anaerobic profile
4. The injury engine (`injury/engine.ts`) auto-handles unknown types via its `adaptWorkoutForInjury()` fallback — but add explicit handling if the type needs special injury behaviour
5. The scheduler (`scheduler.ts`) places non-run workouts on remaining free days after runs are assigned

### `generateWeekWorkouts()` call signature

15 positional params. The last ~8 are optional. Called from `renderer.ts:render()`:

```ts
generateWeekWorkouts(
  phase, runsPerWeek, raceDistance, runnerType,
  previousSkips, commuteConfig, injuryState, recurringActivities,
  fitnessLevel, hrProfile, easyPaceSecPerKm,
  weekIndex, totalWeeks, vdot, gymSessionsPerWeek
)
```

When `weekIndex` and `totalWeeks` are provided, uses the new `planWeekSessions()` path. Otherwise falls back to the legacy `rules_engine.ts`.

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

Six-phase clinical progression: **acute → rehab → test_capacity → return_to_run → graduated_return → resolved**. Each phase generates its own weekly workout plan (or adapts the normal plan). Phase transitions are driven by pain history trends and capacity test results. The `graduated_return` phase (2-week check-in) bridges return_to_run and full resolution — easy runs pass through, hard sessions get RPE-capped and distance-reduced 20%. Detraining model applies negative `wkGain` during injury phases (-0.15 acute to -0.03 graduated_return). Pain >= 4 triggers regression to the previous phase.

### Cross-Training Engine (`src/cross-training/`)

Universal load currency: any activity → `computeUniversalLoad()` → aerobic/anaerobic load + fatigue cost + run replacement credit (RRC). Three data tiers: Garmin (Tier A), HR-only (Tier B), RPE-only (Tier C with uncertainty penalty). RRC is saturated (non-linear scaling) and goal-adjusted. Load matching via `vibeSimilarity()` finds which running workout a cross-training session most closely replaces. Weekly budget system caps how much running can be replaced/adjusted. User sees a suggestion popup with Keep/Reduce/Replace options.

#### Cross-Training Log → Plan Apply Pipeline (`events.ts` ~L1080–1418)

Full flow when a user logs a cross-training activity:

```
1. User submits sport/duration/RPE form
2. events.ts builds a CrossActivity object
3. workouts = generateWeekWorkouts(...)          — fresh from generator, names are "Easy Run" etc.
4. Slot matching (L1119-1134):
   - If a planned cross-training slot matches the sport → fill slot → handle excess
   - If a generic sport slot exists → fill that → handle excess
   - Otherwise → full run suggestion flow (step 5)
5. Re-apply existing mods (L1315-1335):
   - Loop wk.workoutMods, find each workout by name + dayOfWeek, apply status/d/t/load
   - This prevents double-spending (already-replaced runs get status='replaced', load=0)
6. workoutsToPlannedRuns(workouts, paces)        — converts to PlannedRun[] for suggester
   - workoutId = w.n (original generator name, e.g. "Easy Run")
   - dayIndex = w.dayOfWeek ?? array_index (fallback)
7. buildCrossTrainingPopup(ctx, plannedRuns, activity)
   - computeUniversalLoad() → FCL + RRC
   - computeSeverity() → light/heavy/extreme
   - buildCandidates() → sorted by vibeSimilarity
   - buildReduceAdjustments() → downgrades + distance reductions (no replacements)
   - buildReplaceAdjustments() → interleaved: replace 1 → reduce 1 → replace 1...
8. showSuggestionModal(popup, ...) → user picks Replace & Reduce / Reduce / Keep
9. applyAdjustments(workouts, adjustments, sport, paces)  — in suggester.ts
   - Creates copies: workouts.map(w => ({...w}))
   - Matches by w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex
   - Replace → status='replaced', d='0km (replaced)', originalDistance saved
   - Downgrade → preserves structure (intervals stay intervals at lower pace)
   - Reduce → lowers distance
10. Store mods in wk.workoutMods[] (L1377-1395):
    - name = w.n (original generator name), dayOfWeek, status, newDistance, newType, etc.
11. saveState() + render()
```

**Key invariant**: Adjustment `workoutId` and `dayIndex` come from the generator's `w.n` and `w.dayOfWeek`. These must match when applying. The renderer renames duplicates ("Easy Run" → "Easy Run 1") AFTER applying mods, so mods always store/match original generator names.

#### Load Currency (detailed)

| Term | Meaning | Source |
|------|---------|--------|
| FCL (Fatigue Cost Load) | How much fatigue the cross-training adds | `computeUniversalLoad().fatigueCostLoad` |
| RRC (Run Replacement Credit) | Budget for how much running load can be reduced/replaced | `computeUniversalLoad().runReplacementCredit` |

Severity thresholds (FCL relative to weekly run load):
- **Light**: FCL < 25% of weekly run load → max 1 adjustment
- **Heavy**: FCL 25-55% → max 2 adjustments
- **Extreme**: FCL ≥ 55% → max 3 adjustments

RRC is the **spending budget** for adjustments. Each adjustment "costs" its load reduction:
- Replace costs the full workout's weighted load (must have budget ≥ workout load)
- Downgrade costs the delta between original and downgraded load
- Reduce costs proportional to km removed

The interleave algorithm (in `buildReplaceAdjustments`): replace pool sorted cheapest-first (easy runs before quality). Loop alternates: replace 1 → downgrade/reduce 1 → replace 1... Natural scaling: small RRC = just reduce, medium = replace + reduce, large = replace + reduce + replace.

#### Downgrade Ladder

```
vo2/intervals → threshold → marathon_pace → easy
hill_repeats  → threshold
race_pace     → marathon_pace
progressive   → marathon_pace (but applyAdjustments converts to plain easy long run)
mixed         → marathon_pace
```

**Steady pace**: When threshold is downgraded, the actual pace shown is halfway between easy and threshold: `(paces.e + paces.t) / 2`. Labelled "steady" (not "marathon pace") because true MP is not a meaningful reduction from threshold.

#### Workout Load Calculation (`workouts/load.ts`)

`calculateWorkoutLoad(type, description, intensityPct, easyPaceSecPerKm)`:
- Parses description for duration (intervals with time, km distances, simple Xmin)
- Multi-line descriptions: strips WU/CD lines, parses main set, adds WU/CD time at easy pace
- RPE → load-per-minute rate from `LOAD_PER_MIN_BY_INTENSITY` table
- Total load = duration × rate, split by aerobic/anaerobic profile per workout type
- **Critical**: description format changes MUST be reflected here or stored loads will be wrong

### GPS Tracking (`src/gps/`)

`GpsTracker` class is a state machine: idle → acquiring → tracking → paused → stopped. Provider abstraction: `native-provider.ts` (Capacitor), `web-provider.ts` (browser geolocation), `mock-provider.ts` (dev). Points are jitter-filtered (`filterJitter()`), distances computed via Haversine. Split detection from workout descriptions via `buildSplitScheme()` (regex-parses "8x400m @ 5K" etc.). Recordings persisted to localStorage with an index.

### Recovery & Deload (`src/recovery/engine.ts`)

Morning check-in: sleep score + Garmin readiness + HRV status → `computeRecoveryStatus()` → green/yellow/orange/red level. Trend escalation (2 of 3 days low → escalate). Non-green triggers an adjustment modal: user can downgrade a hard workout, reduce distance, or flag a run as easy. Plan engine has built-in deload weeks via `isDeloadWeek()` based on ability band (every 3rd–4th week).

### Gym Integration (`src/workouts/gym.ts`)

`generateGymWorkouts()` produces running-specific strength sessions. Phase-aware templates: heavy in base, explosive in build, maintenance in peak, activation in taper. Three ability tiers: beginner (bodyweight), novice (light weights), full (barbell). Session count scales down through phases. Deload weeks reduce by 1 session + lower RPE. Injury-aware: no gym in acute/rehab/test_capacity, light return session in return_to_run (levels 5+). Gym workouts are additive — never replace running sessions.

### Continuous Mode

For non-event users. 4-week block cycling (base → build → intensify → deload) with optional benchmark check-ins at block boundaries. `s.continuousMode = true`, `s.blockNumber` tracks current block. Benchmark types: easy check-in, threshold check, speed check, race simulation.

### Scheduler (`src/workouts/scheduler.ts`)

`assignDefaultDays()` places workouts using rules: long run → Sunday, quality sessions (threshold, VO2, intervals) → Tue/Thu, easy runs fill remaining slots. Hard workout separation is enforced — `checkConsecutiveHardDays()` validates. Gym and cross-training workouts slot into remaining free days. Users can override via drag-and-drop → `moveWorkoutToDay()` → stored in `wk.workoutMoves`.

### Renderer Workout Lifecycle (`src/ui/renderer.ts`)

Every `render()` call regenerates workouts from scratch and re-applies persisted state. Order matters:

```
1. generateWeekWorkouts(...)        — fresh Workout[] with original names ("Easy Run")
2. Apply stored mods (wk.workoutMods)
   - Match by: w.n === mod.name && w.dayOfWeek === mod.dayOfWeek
   - Sets status, d, t, rpe, recalculates loads
   - MUST happen before rename (step 3) because mods store original generator names
3. Deduplicate names
   - Count occurrences of each w.n
   - If >1, rename: "Easy Run" → "Easy Run 1", "Easy Run 2"
   - Assigns w.id for completion tracking
4. Append adhoc workouts (wk.adhocWorkouts)
5. Append passed capacity tests
6. Apply workout moves (wk.workoutMoves) — drag-and-drop day reassignments
7. Render calendar view (weekly grid) + detailed workout list
```

**Display states for workout cards:**
- **Planned** (default): normal card with RPE target, forecast load, pace info
- **Replaced** (`status='replaced'`): cyan border, "RUN REPLACED" banner, original description struck through, no forecast load shown
- **Reduced** (`status='reduced'`): sky border, "LOAD DOWNGRADE" banner, shows original + new description
- **Completed** (rated): green border, "Done" badge with RPE rating
- **Skipped**: amber/red border with skip count messaging

### Workout Description Format (`workouts/intent_to_workout.ts`)

Multi-line format for sessions with warm-up/cool-down (VO2, threshold):
```
Line 1: 1km warm up (5:30/km+)
Line 2: 5×3min @ 3:47/km (~790m), 2 min recovery between sets
Line 3: 1km cool down (5:30/km+)
```

Single-line for simple workouts (easy, long):
```
10km (5:30/km+)
```

**Important**: Any change to description format must also update:
- `workouts/load.ts` — duration parsing for load calculation
- `workouts/parser.ts` — `parseWorkoutDescription()` for distance extraction
- `ui/renderer.ts` — calendar compact view extraction (strips WU/CD for display)

---

## Spec Docs (deep-dive references)

| Doc | Covers |
|-----|--------|
| `docs/recovery-deloading-spec.md` | Recovery scoring, deload logic, adjustment rules |
| `docs/non-event-design-spec.md` | Continuous mode, block cycling, benchmarks |
| `docs/TECH_SPECS.md` | Technical specifications |
| `docs/ENGINE_AUDIT.md` | Engine audit findings |
| `docs/FORECAST_MATRIX_AUDIT.md` | Prediction model audit |
| `docs/claude_master_plan.md` | Original feature roadmap |
| `docs/context_handoff.md` | Context handoff notes |

---

## Changelog

### 2026-02-11

#### 1. Workout Description Overhaul (`intent_to_workout.ts`, `renderer.ts`, `parser.ts`)

**Problem**: VO2/Threshold descriptions showed pace twice: `5×3min @ 3:47/km pace (3:47/km)`. Labels embedded zone names + pace, and the description template also had `@ pace`.

**Fix**: Stripped zone names from labels (VO2/threshold now just show the pace value). Added `fmtDist()` helper for distance hints (under 1km = meters, else km). New format: `5×3min @ 3:47/km (~790m), 2 min recovery between sets`.

**WU/CD for short sessions**: Added `wucdKm()` helper — if a session is under 30 min total, calculates equal warm-up/cool-down distances at easy pace so runners never go out for less than 30 min. Math: `deficit = 30 - sessionTime`, each side = `ceil(deficit/2 / easyPace)`. Descriptions are now multi-line with `\n` separators:
```
1km warm up (5:30/km+)
5×3min @ 3:47/km (~790m), 2 min recovery between sets
1km cool down (5:30/km+)
```

**Renderer changes**: `\n` → `<br>` in expanded cards. Added `fmtTimeRange()` for ±10% time estimates left of RPE (longer runs get 5-10 min extra slack at top end). Calendar shows main set only for VO2/Threshold (strips WU/CD, `/km`, `(~790m)`). All workout types use 3-line calendar layout: bold name / grey description / RPE.

#### 2. Cross-Training Downgrade Structure Preservation (`suggester.ts`)

**Problem**: `applyAdjustments()` was converting ALL downgrades to flat `Xkm @ paceLabel` format. This destroyed interval structure (3×8min → "7.9km at Marathon") and turned progressive long runs into harder workouts ("13km easy + 3km at MP" → "16km @ marathon pace").

**Fix**: `applyAdjustments()` now inspects the original description format:
- Progressive/fast-finish (`/last\s+\d/`) → plain easy long run (removes the fast finish)
- Intervals (`/\d+×\d/`) → same reps and duration at lower pace with actual pace shown
- Continuous time-at-pace (`/^\d+min\s*@/`) → same time at lower pace
- Fallback → simple distance @ new pace

Added `paces?: Paces` parameter to `applyAdjustments` so actual pace values (e.g. `4:30/km`) appear in descriptions instead of generic labels.

#### 3. Replace vs Reduce — Interleaved Algorithm (`suggester.ts`)

**Problem**: Both "Replace & Reduce" and "Reduce" options showed the same downgrades. The old `buildReplaceAdjustments` only replaced at "extreme" severity; for "heavy" it fell through to downgrade-only, making the two choices identical.

**First attempt**: Two-pass (replacements first, then reductions) — replaced both easy runs and left nothing for quality downgrades.

**Final fix**: Interleaved algorithm. Replace pool sorted by cost (cheapest first). While loop alternates: replace 1 workout → reduce/downgrade 1 workout → replace 1... This naturally scales with budget: small RRC = just reduce, medium = replace + reduce, large = replace + reduce + replace. Each replacement requires `remainingLoad >= runLoad` (must fully cover).

#### 4. Load Currency Root Cause (`load.ts`)

**Problem**: Debug logging revealed stored workout loads were wildly wrong — VO2 stored at 20 instead of 135, Threshold at 31 instead of 126. This made 60min RPE 7 rugby look like it could replace 2+ workouts when it shouldn't.

**Root cause**: `calculateWorkoutLoad()` parsed `1km` from the warm-up line ("1km warm up") instead of the main set, because the new multi-line description format (from fix #1) put WU on line 1.

**Fix**: Added multi-line handler to `load.ts` that:
1. Detects `\n`-separated descriptions where line 1 contains "warm up"
2. Strips WU/CD lines, uses middle line as main set
3. Parses main set for intervals/time/km
4. Adds WU/CD time at easy pace

After fix: severity dropped from "extreme" to "heavy" (correct), Replace & Reduce showed 1 replacement + 1 downgrade instead of 3.

#### 5. Easy Run Replacement Not Applying (`renderer.ts`)

**Problem**: Easy runs showed as "Replace" in the modal correctly, but after applying, the plan didn't change. VO2 downgrades worked fine.

**Root cause**: The renderer had two steps in the wrong order:
1. **Step 1 (rename)**: Duplicate names deduplicated — "Easy Run" → "Easy Run 1", "Easy Run 2"
2. **Step 2 (apply mods)**: Look for `w.n === mod.name` where `mod.name = "Easy Run"`

After rename, no workout has `w.n === "Easy Run"` — they're all "Easy Run 1" etc. VO2 worked because it had a unique name (no rename).

**Fix**: Swapped the order — apply mods first (when names still match), then rename for display. This is now documented in the Renderer Workout Lifecycle section above.

#### 6. Steady Pace for Threshold Downgrades (`suggester.ts`, `suggestion-modal.ts`)

**Problem**: When threshold was downgraded to marathon_pace, the displayed pace was MP — which is close to threshold and felt like an upgrade, not a reduction.

**Fix**: Calculated `steadyPaceSec = (paces.e + paces.t) / 2` — a pace halfway between easy and threshold. When `originalType === 'threshold'` and `newType === 'marathon_pace'`, the description shows the steady pace value (e.g. `4:30/km`) labelled "(steady)" instead of "(marathon pace)". The workout type stays `marathon_pace` internally (no new type needed) but the actual pacing flows through to the description so parser/renderer pick it up.

Updated `paceForType()` and `paceLabelForType()` in `applyAdjustments` to accept `origType` parameter. Updated 3 description builders in `buildCrossTrainingPopup` via shared `downgradePaceLabel()` helper. Updated `suggestion-modal.ts` detail text.

#### 7. Replaced Workout UX (`renderer.ts`, `suggestion-modal.ts`)

**Problem**: Replaced workouts showed "LOAD COVERED" (confusing), "0km (replaced)" as description (confusing — user expects to see original distance), and "Forecast load: A0 / An0" (useless).

**Fix**:
- Banner: "LOAD COVERED" → **"RUN REPLACED"**
- Calendar status: "Covered" → **"Replaced"**
- Description (expanded card): shows original description struck through + "(replaced)" in cyan
- Description (calendar): shows original description struck through + mod reason in cyan
- Forecast load: **hidden entirely** for replaced workouts
- `suggestion-modal.ts`: `originalType === 'threshold'` downgrades show "steady pace" label

#### 8. Architecture Documentation

Added detailed sections covering the full cross-training pipeline (11-step flow with file/line references), load currency mechanics (FCL/RRC/severity thresholds/budget spending), downgrade ladder, workout load calculation gotchas, renderer lifecycle (correct ordering of mods → rename → adhoc → moves), workout description format spec, and which files must stay in sync when formats change.

### 2026-02-10
- Added strength training integration: `gym.ts` with phase-aware templates, 3 ability tiers (beginner/novice/full), deload + injury filtering, scheduler support for gym workout placement
- Added `graduated_return` injury phase (2-week bridge between return_to_run and resolved)
- Detraining model during injury — negative wkGain per phase replaces old flat-zero approach
- Three-option exit prompt from return_to_run: full return / ease me back in / not yet
- Graduated return check-in modal with pain slider and live decision preview
- Volume selector in onboarding for gym sessions (0-3/week)

### 2026-02-09
- Functioning model with full plan generation, injury system, cross-training integration
- Recovery engine (morning check-in, sleep/readiness/HRV scoring)
- Continuous mode with 4-week block cycling and benchmark check-ins

### 2026-02-05
- Cross-training preview works without auto-apply (user confirms via popup)
- Schema migration v2 (runner type semantics fix: Speed/Endurance swap)

### Pre-Feb 2026
- Initial codebase: onboarding wizard, VDOT engine, plan generation, injury system
- GPS tracking with provider abstraction and split detection
- Universal load model for cross-training
- Physiology tracker with adaptation ratio
- Training horizon model with guardrails
