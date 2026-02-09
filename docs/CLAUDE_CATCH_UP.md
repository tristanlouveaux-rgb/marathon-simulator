# Claude Catch-Up: Marathon Simulator Architecture Document

## 1. Project Overview & Vision

The Marathon Simulator, internally known as "Mosaic Training Simulator," is a sophisticated, cross-platform mobile application aimed at providing highly personalized and adaptive marathon training plans. Its core vision, as articulated in the Product Requirements Document (PRD), is to be the "most intelligent, adaptive training platform" by offering superior personalization, dynamic responsiveness to real-life variables (such as injuries and cross-training), and deep integration with the athlete's full training ecosystem. The underlying philosophy centers on forecasting physiological improvements (VO2max, Lactate Threshold Pace) and dynamically adjusting training plans based on real-time data and a comparison of actual versus expected progress.

## 2. Core Technologies

*   **Frontend:** Vanilla TypeScript/JavaScript with direct DOM manipulation. (Note: PRD mentions React, but implementation uses vanilla JS).
*   **Styling:** Tailwind CSS for a utility-first approach to styling.
*   **Mobile Runtime:** Capacitor for cross-platform deployment to iOS and Android.
*   **State Management:** Custom, in-memory global state (`SimulatorState`) persisted to `localStorage`.
*   **Build Tool:** Vite.
*   **Testing Framework:** Vitest (indicated by `vite.config.ts` and `.test.ts` files).
*   **Geolocation:** Utilizes Capacitor's native geolocation capabilities (e.g., `@transistorsoft/capacitor-background-geolocation`).

## 3. High-Level Architecture

The application follows a clear separation of concerns, built around a central, mutable `SimulatorState` object. This state is initialized via an onboarding wizard, then drives a complex adaptive engine that generates and modifies weekly training plans. User interactions (logging activities, rating RPE, reporting pain, tracking runs) feed back into the state, triggering recalculations and adaptations. The UI dynamically reflects these changes.

**Key Data Flow Overview:**

1.  **Initialization/Onboarding:** User input collects initial profile and goals, which `initializeSimulator` processes to create a baseline `SimulatorState` and a first-pass training plan.
2.  **State Persistence:** The entire `SimulatorState` is saved to/loaded from `localStorage`, with robust schema migration.
3.  **Weekly Plan Generation:** The `Generator` (`src/workouts`) uses the current `SimulatorState` (VDOT, runner type, phase, injury status, etc.) to produce a week's worth of workouts.
4.  **Adaptation Layers:** This generated plan is then iteratively adapted by:
    *   **Injury Engine:** Can override/modify workouts based on active injury phases or pain trends.
    *   **Cross-Training Matcher/Suggester:** Adjusts running workouts based on logged non-running activities and a "universal load" metric.
5.  **UI Rendering:** The `Renderer` (`src/ui`) displays the adapted plan, current metrics, and interactive elements.
6.  **User Interaction:** Users complete/rate workouts, track runs (GPS), log activities, and provide feedback, updating the `SimulatorState` and restarting the adaptation cycle.

## 4. Detailed Module Breakdown

### 4.1. `src/state` - Core Application State Management

*   **Purpose:** Manages the single source of truth for the application's data (`SimulatorState`) and handles its persistence and versioning.
*   **Key Files:**
    *   `store.ts`: Defines `SimulatorState` interface (comprehensive, includes all user data, plan details, metrics), `defaultState`, and provides `getState()`, `updateState()`, `setState()`, `resetState()` for controlled access. Also manages `crossActivities`.
    *   `persistence.ts`: Handles `localStorage` interactions (`STATE_KEY`, `CROSS_KEY`).
        *   `loadState()`: Retrieves state, performs `validateState()` (checks for corruption) and `migrateState()` (applies schema upgrades, notably `RunnerType` semantic fix and the **General Fitness phase progression fix**).
        *   `saveState()`: Stores current `SimulatorState` to `localStorage`.
        *   `clearState()`, `hasSavedState()`.
*   **Inputs:** User input from UI, system-generated data.
*   **Outputs:** Global `SimulatorState`.
*   **Algorithms/Patterns:** Singleton-like state object, facade pattern for state access, versioned schema migration.

### 4.2. `src/calculations` - Physiological & Performance Engine

*   **Purpose:** Implements the core mathematical and physiological models for runner performance, training response, and predictions.
*   **Key Files:**
    *   `vdot.ts`: Implements Daniels' Running Formula for `cv()` (calculating VDOT from race performance) and `vt()`/`tv()` (predicting race time from VDOT). Foundational for all pace and prediction logic.
    *   `fatigue.ts`: Calculates **fatigue exponent (`b`)** from user PBs (linear regression on log-transformed data). Uses `b` to classify `getRunnerType()` ('Speed', 'Balanced', 'Endurance'). Also `getAbilityBand()`/`inferLevel()` from VDOT.
    *   `physiology-tracker.ts`: Implements "Physiology Improvement Tracker."
        *   `calculateExpectedPhysiology()`: Models expected LT/VO2max gains over time using a linear approximation with `PHYSIOLOGY_GAINS` (from constants) and `AbilityBand`.
        *   `computeAdaptationRatio()`: Compares `PhysiologyMeasurement` (observed) against `ExpectedPhysiology` to derive a smoothed `adaptationRatio` using exponential smoothing.
        *   `assessAdaptation()`: Provides user-friendly status ('excellent', 'slow') and messages based on `adaptationRatio`.
        *   `projectPhysiology()`: Projects future LT/VO2max using the current `adaptationRatio`.
    *   `training-horizon.ts`: Models **Non-Linear Training Horizon**.
        *   `applyTrainingHorizonAdjustment()`: Calculates VDOT gain using saturating exponential (`week_factor`), `session_factor`, `runner_type`, `experience_level`. Includes `undertrain_penalty` and `taper_bonus`.
        *   `applyGuardrails()`: Crucial function to cap VDOT gain based on `experience_level` and PBs to prevent unrealistic "stretch goals."
        *   `calculateSkipPenalty()`: Quantifies time penalty for missed workouts based on type, proximity to race, and cumulative skips.
    *   `predictions.ts`: The "Performance Prediction Engine."
        *   `predictFromPB()`, `predictFromRecent()`, `predictFromLT()`, `predictFromVO2()`: Individual prediction models.
        *   `blendPredictions()`: Combines these models using weighted averages (weights vary by `targetDist`, `recentRun` presence, and apply recency decay).
        *   `calculateLiveForecast()`: Incorporates `applyTrainingHorizonAdjustment()` to provide the final `forecastVdot` and `forecastTime`.
    *   `paces.ts`: `gp()` generates pace zones (easy, threshold, interval, marathon, repetition) from VDOT or (preferably) LT pace. `getPaceForZone()` retrieves specific paces.
    *   `heart-rate.ts`: (Briefly seen) Calculates HR zones and target HR for workouts.
*   **Inputs:** `SimulatorState` (PBs, VDOT, runner type, current week, total weeks, etc.), activity data (for `physiology-tracker`).
*   **Outputs:** VDOT, runner type, predicted race times, paces, adaptation ratio, VDOT gains.
*   **Algorithms/Patterns:** Mathematical modeling, linear regression, exponential smoothing, weighted averages, state-dependent logic.

**Recent Intelligent Adaptation (Calibration):**
The `rpeAdj` (RPE Adjustment) value now directly influences future workout generation. In `renderer.ts`, the `currentVDOT` (including RPE feedback and training gains) is passed to `generateWeekWorkouts`. This creates a closed-loop system where:
- **"Too Easy" ratings** → Faster target paces and higher volume in future weeks.
- **"Too Hard" ratings** → Slower target paces and automatic volume reduction.
- **Pace Calibration**: Future workout cards use week-specific adjusted paces rather than static initial paces.

### 4.3. `src/workouts` - Training Plan Generation & Scheduling

*   **Purpose:** Orchestrates the creation, detailing, and scheduling of weekly training plans, incorporating all adaptive logic.
*   **Key Files:**
    *   `plan_engine.ts`: The high-level weekly planner.
        *   `planWeekSessions()`: Main function generating `SessionIntent`s. Considers `vdot`, `runnerType`, `phase`, `raceDistance`, `runsPerWeek`.
        *   **General Fitness Phasing**: Now standardized to an evidence-backed 4-week mesocycle: **Base → Build → Intensify → Deload**.
        *   Applies `abilityBandFromVdot()`, `isDeloadWeek()`, `qualityCap()`.
        *   Calculates workout durations (`longRunMinutes()`, `easyRunMinutes()`, etc.) dynamically based on `weekIndex`, `phase`, `ability`, `raceDistance`.
        *   Determines `workoutPriority()` (race/phase-specific) and applies `applyRunnerTypeBias()`.
        *   Uses `VO2_VARIANTS`, `THRESH_VARIANTS`, `LONG_VARIANTS` for workout structure rotation.
    *   `generator.ts`: Turns `SessionIntent`s into detailed `Workout` objects.
        *   `generateWeekWorkouts()`: Main function. Calls `planWeekSessions()` (or `rules_engine.ts` as fallback).
        *   Converts `SessionIntent` to `Workout` via `intentToWorkout()` (from `intent_to_workout.ts`).
        *   Adds makeup runs for `previousSkips`.
        *   Adds `commute` runs (`src/workouts/commute.ts`) and `recurringActivities`.
        *   Calculates `calculateWorkoutLoad()` (from `load.ts`) for each workout.
        *   Applies `applyInjuryAdaptations()` (from `src/injury/engine.ts`).
        *   Assigns default days using `src/workouts/scheduler.ts:assignDefaultDays()`.
    *   `scheduler.ts`: Assigns workouts to specific days.
        *   `assignDefaultDays()`: Uses smart rules (Long Run Sunday, Quality Tue/Thu) to spread out workouts, managing `HARD_WORKOUT_TYPES`.
        *   `checkConsecutiveHardDays()`: Validates schedule for safe recovery.
        *   `moveWorkoutToDay()`.
    *   `load.ts`: `calculateWorkoutLoad()` quantifies physiological load (aerobic/anaerobic) from workout type, duration, and intensity (RPE). Handles various duration string formats.
    *   `commute.ts`: `getCommuteDistance()` calculates distance for commute runs.
    *   `rules_engine.ts`: (Older component, now largely superseded by `plan_engine.ts` for primary generation). `generateOrderedRunSlots()` defines high-level workout types for a week based on prioritization.
    *   `feedback.ts`, `parser.ts`, `intent_to_workout.ts`: Other utilities for feedback, parsing workout descriptions, and generating workout objects from intents.
*   **Inputs:** `SimulatorState` (current week, VDOT, runner type, race details, injury state, cross-training activities).
*   **Outputs:** Detailed `Workout` objects for the week, assigned to days, with calculated loads and injury adaptations.
*   **Algorithms/Patterns:** Rule-based expert system, dynamic programming (for plan generation/adaptation), object factory (for workouts).

### 4.4. `src/cross-training` - Multi-Sport Integration

*   **Purpose:** Integrates non-running activities into the training load, quantifying their impact and proposing running plan adaptations.
*   **Key Files:**
    *   `universalLoad.ts`: **Core "universal load currency" engine.**
        *   `computeUniversalLoad()`: Calculates `aerobicLoad`, `anaerobicLoad`, `fatigueCostLoad` (FCL - raw fatigue, not saturated), and `runReplacementCredit` (RRC - saturated and goal-adjusted for running equivalent) for any `ActivityInput`.
        *   Supports 3 tiers of data: Garmin (Tier A), HR-only (Tier B), RPE-only (Tier C with uncertainty penalty).
        *   `saturateCredit()`: Applies non-linear scaling to RRC (prevents single huge session from linearly replacing many runs).
        *   `computeGoalFactor()`: Adjusts RRC based on `goalDistance` and anaerobic ratio.
        *   `isExtremeSession()`: Identifies very high-load activities.
    *   `load-matching.ts`: Uses universal load metrics to match and budget.
        *   `vibeSimilarity()`: Compares aerobic/anaerobic profiles of cross-training activity and running workouts to find best matches.
        *   `calculateLoadBudget()`: Determines `replacementBudget` and `adjustmentBudget` for the week (considering previous week's load decay), limiting how much can be replaced/adjusted.
        *   `calculateReduction()`, `reduceWorkoutDistance()`.
    *   `matcher.ts`: Orchestrates applying cross-training impact.
        *   `applyCrossTrainingToWorkouts()`: Main function. Iteratively processes `CrossActivity` against `modifiedWorkouts` using `loadBudget`.
        *   `findBestWorkoutMatch()`: Selects optimal running workout to modify based on `vibeSimilarity` and constraints (e.g., long runs cannot be fully replaced).
        *   `applyWorkoutModification()`: Modifies workout status ('replaced', 'reduced'), distance, or type.
        *   `calculateCrossTrainingBonus()`: Awards VDOT bonus for accumulated "overflow" cross-training load.
    *   `suggester.ts`: Generates user-facing "SuggestionPopup" for cross-training impact.
        *   `buildCrossTrainingPopup()`: Uses `computeUniversalLoad()`, `computeSeverity()`, `buildCandidates()`, `buildReduceAdjustments()`, `buildReplaceAdjustments()` to construct headline, summary, `ChoiceOutcome`s (Keep, Reduce, Replace) with detailed `Adjustment`s.
        *   `applyAdjustments()`: Applies user-confirmed `Adjustment`s to workout objects.
    *   `activities.ts`: Utility for `normalizeSport()`, `getRPEMult()`, `rpeFactor()`, `weightedLoad()`, `intensityProfile()`, `isHardDay()`, `canTouchWorkout()`.
*   **Inputs:** `CrossActivity` objects (manual, synced, GPS-recorded), `SimulatorState` (planned workouts, race goal).
*   **Outputs:** Modified running `Workout` objects, `crossTrainingSummary`, `crossTrainingBonus`, `SuggestionPopup` for user.
*   **Algorithms/Patterns:** Multi-tiered data processing, weighted scoring, exponential decay (saturation), budgeting, rule-based matching.

### 4.5. `src/injury` - Intelligent Injury Management System

*   **Purpose:** Provides a "physio-grade" adaptive response to injuries, dynamically managing training load, prescribing recovery protocols, and guiding return to running.
*   **Key Files:**
    *   `engine.ts`: The central injury intelligence.
        *   **MODULE 1: Trend Analysis:**
            *   `recordPainLevel()`: Stores pain history.
            *   `analyzeTrend()`: Detects `acute_spike` (triggers emergency rest), `chronic_plateau` (triggers rehab block), and `improving`/`worsening`/`stable` trends.
            *   `applyEmergencyShutdown()`, `applyRehabBlock()`.
        *   **MODULE 2: Injury-Specific Prescriptions:**
            *   `adaptWorkoutForInjury()`: Modifies single workouts based on `InjuryState` and `INJURY_PROTOCOLS` (from constants). Removes banned types, replaces with cross-training, reduces intensity/volume.
        *   **MODULE 3: Graded Exposure "Test Run" Protocol:**
            *   `createTestRunWorkout()`, `evaluateTestRunResult()`, `applyTestRunResult()`, `requiresTestRun()`: Manages diagnostic test runs for safe return to activity.
        *   **MODULE 4: Physio-Grade Phase Management:**
            *   Implements the 5-Phase Recovery Model (`acute`, `rehab`, `test_capacity`, `return_to_run`, `resolved`).
            *   `applyPhaseRegression()`, `applyPhaseProgression()`: Manages transitions between phases.
            *   `checkPainLatency()`: Detects increased pain post-activity, triggering regression.
            *   `canProgressFromAcute()`, `hasPassedRequiredCapacityTests()`, `recordCapacityTest()`: Criteria and functions for phase progression.
            *   `recordMorningPain()`: Updates pain for latency tracking.
            *   `evaluatePhaseTransition()`: Orchestrates phase transitions.
            *   `generateAcutePhaseWorkouts()`, `generateRehabPhaseWorkouts()`, `generateCapacityTestSession()`, `generateReturnToRunWorkouts()`: Generates *entire weekly plans* for specific injury phases.
        *   `applyAdvancedInjuryLogic()`, `applyInjuryAdaptations()`: Main orchestrators. `applyInjuryAdaptations()` uses the phase system to either replace the entire week's workouts or apply `applyAdvancedInjuryLogic()` for workout-level adaptations within the 'resolved' phase.
*   **Inputs:** `InjuryState` (pain levels, history, current phase), `Workout` objects.
*   **Outputs:** Modified `Workout` objects, updated `InjuryState`, `warnings`, `recommendations`.
*   **Algorithms/Patterns:** State machine (recovery phases), rule-based expert system, trend analysis, graded exposure protocols.

### 4.6. `src/gps` - GPS Tracking & Analysis

*   **Purpose:** Acquires, processes, and persists GPS data for activity tracking.
*   **Key Files:**
    *   `tracker.ts`: The central `GpsTracker` class.
        *   Acts as a state machine ('idle' -> 'acquiring' -> 'tracking' -> 'paused' -> 'stopped').
        *   Uses a `GpsProvider` (abstracted) for platform-specific access.
        *   `handlePoint()`: Processes incoming `GpsPoint`s, applies `filterJitter()` (`geo-math.ts`), accumulates `haversineDistance()` (`geo-math.ts`).
        *   `checkSplitBoundary()`: Detects and records `GpsSplit`s based on `SplitScheme` (`split-scheme.ts`).
        *   Provides `GpsLiveData` updates.
    *   `geo-math.ts`: Mathematical primitives.
        *   `haversineDistance()`: Calculates distance between lat/lng using Haversine formula.
        *   `calculatePace()`, `rollingPace()`.
        *   `filterJitter()`: Removes erroneous GPS points (accuracy, implied speed thresholds).
    *   `split-scheme.ts`: `buildSplitScheme()` parses workout descriptions (e.g., "8x400m @ 5K") using regex to generate structured `SplitSegment`s with `targetPace` for the `GpsTracker`.
    *   `persistence.ts`: Saves/loads `GpsRecording` objects to/from `localStorage` using an indexing system.
    *   `providers/`: Directory containing concrete `GpsProvider` implementations.
        *   `types.ts`: Defines `GpsProvider` interface.
        *   `native-provider.ts`: Capacitor integration for mobile GPS.
        *   `web-provider.ts`: Browser `navigator.geolocation` API.
        *   `mock-provider.ts`: For testing and development.
*   **Inputs:** Raw GPS data, workout descriptions, `GpsProvider` implementations.
*   **Outputs:** `GpsPoint` history, `GpsSplit`s, `GpsLiveData`, `GpsRecording` objects.
*   **Algorithms/Patterns:** State machine, Haversine formula, filtering, text parsing with regex.

### 4.7. `src/ui` - User Interface Layer

*   **Purpose:** Renders the application, handles user interactions, and visually presents the adaptive plan and metrics.
*   **Key Files:**
    *   `main.ts`: Application entry point. Bootstraps, loads state, and decides whether to `initWizard()` or `renderMainView()`.
    *   `renderer.ts`: Main UI renderer for the dashboard.
        *   `render()`: Generates weekly workout list, prediction updates, warnings, cross-training summaries.
        *   `renderCalendar()`: Calendar view with drag-and-drop for workouts.
        *   `renderWorkoutList()`: Detailed workout cards with RPE rating, track run buttons.
        *   `injectPaces()`: Replaces generic pace tokens with actual calculated paces.
        *   `renderCrossTrainingForm()`: Manual logging form.
        *   `setupSyncListener()`: Attaches listener for external activity sync.
    *   `main-view.ts`: Manages the overall dashboard HTML structure and top-level interactions.
        *   `renderMainView()`: Generates header, week navigator, prediction panels, control buttons.
        *   Integrates `renderInjuryBanner()`, `renderMorningPainCheck()`, `renderBenchmarkPanel()`.
        *   `wireEventHandlers()`: Attaches diverse event listeners for week navigation, plan controls, injury reporting, profile edits, benchmark entry.
    *   `gps-panel.ts`: Renders GPS-specific UI.
        *   `renderInlineGpsHtml()`, `updateInlineGps()`: Real-time GPS data display within workout cards.
        *   `refreshRecordings()`, `renderRecordingsList()`: Displays past GPS recordings.
    *   `events.ts`: (High-level abstraction) Handles event triggers for "Complete Week" (`next()`), "Reset" (`reset()`), "Edit Settings" (`editSettings()`), "Track Run" (`trackWorkout()`), "Log Activity" (`logActivity()`).
    *   `sync-modal.ts`: Manages the UI for proposing matches between external activities and planned workouts.
    *   `explanations.ts`: Provides modals for explanations (e.g., RPE, MP).
    *   `wizard/`: 
        *   **Reactive Validation Pattern**: Recent updates to `goals.ts` introduce direct DOM manipulation for "live" UI feedback (e.g., updating the weeks counter or continue button state) without a full re-render, optimizing mobile performance.
        *   **State Syncing**: Uses `updateOnboarding()` for persistent state and `getOnboardingState()` for immediate reactive checks.

**Future Architecture (Nudges & Durability):**
`src/calculations/nudges.ts` contains the **Durability Matrix** logic ("Honesty over Hype"). It evaluates race goals against structural durability (long run distance) and engine fitness (HM-equivalent pace). While the mathematical cases (Realistic, Conditional, Exploratory) are implemented, the UI widget integration is currently a work-in-progress.

*   **Inputs:** `SimulatorState`, user clicks/inputs.
*   **Outputs:** Dynamically rendered HTML, updated `SimulatorState`.
*   **Algorithms/Patterns:** Direct DOM manipulation, event delegation, conditional rendering, UI component-based design, **Reactive DOM updating**.

### 4.8. `src/constants` - Configuration & Static Data

*   **Purpose:** Centralizes static configuration, physiological parameters, database-like sport definitions, and UI strings. This promotes configurability and easier updates to scientific models.
*   **Key Files:**
    *   `index.ts`: General constants.
    *   `injury-protocols.ts`: Definitions for `INJURY_PROTOCOLS`, `INJURY_THRESHOLDS`, `TEST_RUN_PROTOCOL`. Crucial for `src/injury/engine.ts`.
    *   `physiology.ts`: `PHYSIOLOGY_GAINS`, `ADAPTATION_THRESHOLDS`, `ADAPTATION_MESSAGES`. Used by `src/calculations/physiology-tracker.ts`.
    *   `sports.ts`: `SPORTS_DB` (sport multipliers, run specificity, recovery, replacement rules), `SPORT_ALIASES`, `SPORT_LABELS`. Used extensively by `src/cross-training`.
    *   `training-params.ts`: `TRAINING_HORIZON_PARAMS`, `TAPER_NOMINAL`. Critical for `src/calculations/training-horizon.ts`.
    *   `workouts.ts`: `WO` (Workout Objects - likely for fallback/legacy), `LONG_RUN_DISTANCES`. Used by `src/workouts`.
*   **Inputs:** None (static data).
*   **Outputs:** Configuration values, lookup tables.

### 4.9. `src/types` - Type Definitions

*   **Purpose:** Provides a consistent and strict type system across the entire application, enhancing code quality and maintainability.
*   **Key Files:**
    *   `index.ts`: Aggregates and re-exports many common types.
    *   `activities.ts`: `CrossActivity`, `IntensityProfile`.
    *   `gps.ts`: `GpsPoint`, `GpsSplit`, `GpsLiveData`, `GpsRecording`, `GpsTrackingStatus`.
    *   `injury.ts`: `InjuryState`, `InjuryAdaptation`, `RecoveryPhase`, `InjuryPhase`, `TrendAnalysis`, `TestRunWorkout`, `CapacityTestType`, etc. Extensive types for the complex injury engine.
    *   `onboarding.ts`: `OnboardingState`, `OnboardingStep`, `Marathon`, `RecurringActivity`.
    *   `runner-experience_temp.ts`: Possibly temporary types related to runner experience.
    *   `state.ts`: Defines the central `SimulatorState`, `WorkoutLoad`, `Paces`, `Week`, `Workout`. Also `STATE_SCHEMA_VERSION`.
    *   `training.ts`: `RaceDistance`, `RunnerType`, `TrainingPhase`, `AbilityBand`.
*   **Inputs:** None.
*   **Outputs:** Type interfaces and enums.

## 5. Key Data Flows (Textual Flowcharts)

As previously described, here are the textual representations of the core data flows:

### 5.1. Flowchart 1: Application Initialization & Onboarding Flow

**Trigger:** User launches the application.

**Sequence:**

1.  **Stage: Application Bootstrap (`src/main.ts:bootstrap()`)**
    *   **Input:** Application launch event.
    *   **Process:**
        *   Attempt to load `SimulatorState` from `localStorage` (`src/state/persistence.ts:loadState()`).
        *   Check `state.hasCompletedOnboarding`.
    *   **Output:** `SimulatorState` (loaded or default), decision on onboarding status.

2.  **Decision: Has Onboarding Completed?**
    *   **Condition:** `state.hasCompletedOnboarding` is `true` or `false`.

    **IF TRUE (Onboarding Complete):**
    *   **Action:** Proceed to **Stage: Render Main Application View**.

    **IF FALSE (Onboarding Not Complete):**
    *   **Action:** Proceed to **Stage: Initialize Onboarding Wizard**.

3.  **Stage: Initialize Onboarding Wizard (`src/ui/wizard/controller.ts:initWizard()`)**
    *   **Input:** `SimulatorState` (either freshly initialized or partially saved).
    *   **Process:**
        *   If `state.onboarding` is empty, initialize `defaultOnboardingState`.
        *   Set `state.onboarding.currentStep` to 'welcome' (or a previously saved step).
        *   Call `src/ui/wizard/renderer.ts:renderStep()` for the current step.
    *   **Output:** Rendered "Welcome" step UI (or previous incomplete step), updated `SimulatorState` with `onboarding` context.

4.  **Stage: User Progresses Through Onboarding Steps (`src/ui/wizard/steps/*`, `controller.ts`, `renderer.ts`)**
    *   **Input:** User interaction (button clicks, form submissions) on current step, `SimulatorState`.
    *   **Process (Loop):**
        *   **UI:** `src/ui/wizard/renderer.ts:renderStep()` displays step UI (e.g., `renderGoals()`, `renderBackground()`).
        *   **Input Collection:** User enters data (e.g., name, race distance, PBs, cross-training preferences).
        *   **State Update:** `src/ui/wizard/controller.ts:updateOnboarding()` saves user input to `state.onboarding`.
        *   **Validation:** (Implicit in some steps, e.g., race date validation).
        *   **Navigation:**
            *   User clicks "Next" -> `controller.ts:nextStep()` advances to next in `STEP_ORDER`.
            *   User clicks "Back" -> `controller.ts:previousStep()` (skips processing steps).
        *   **Special Step: 'initializing' (`src/ui/wizard/steps/initializing.ts`)**
            *   **Input:** Full `onboarding` state.
            *   **Process:** Calls `src/state/initialization.ts:initializeSimulatorFromOnboarding()` which:
                *   Generates initial VDOT, paces, predictions.
                *   Generates the full initial `s.wks` (training plan).
                *   Stores these in the main `SimulatorState`.
            *   **Output:** Fully populated initial training plan and metrics in `SimulatorState`.
        *   **Special Step: 'assessment' (`src/ui/wizard/steps/assessment.ts`)**
            *   **Input:** Calculated predictions and plan.
            *   **Process:** Presents plan summary, offers "stretch goals."
            *   **Output:** User confirmation of plan/goals, final `onboarding` state.
    *   **Output:** Fully populated `SimulatorState` including initial plan, `state.hasCompletedOnboarding` set to `true`.

5.  **Stage: Render Main Application View (`src/ui/main-view.ts:renderMainView()`)**
    *   **Input:** Fully initialized `SimulatorState`.
    *   **Process:**
        *   Generates the main dashboard HTML structure (`getMainViewHTML()`).
        *   Calls `src/ui/renderer.ts:render()` to populate current week's workouts.
        *   Attaches event handlers for dashboard interactions (week navigation, controls, injury reporting, etc.).
    *   **Output:** Main dashboard UI displayed to the user.

### 5.2. Flowchart 2: Weekly Training Plan Generation & Adaptation Flow

**Trigger:** Application needs to display the current week's training plan (e.g., on app launch, after completing previous week, after user changes settings, after injury update).

**Sequence:**

1.  **Stage: Retrieve Current State & Context (`src/ui/renderer.ts:render()`, `src/ui/main-view.ts:renderMainView()`)**
    *   **Input:** `SimulatorState` (from `getState()`), current `s.w` (current week index), `s.tw` (total weeks).
    *   **Process:** Access current week's `wk` object from `s.wks`.
    *   **Output:** `wk` (current week's base data), `SimulatorState`.

2.  **Stage: Calculate Current Fitness Metrics (`src/ui/renderer.ts:render()`)**
    *   **Input:** `SimulatorState` (including `s.v`, `s.rpeAdj`, `s.wks[i].wkGain`, `s.rd`, `s.b`, `s.onboarding`).
    *   **Process:**
        *   Compute `currentVDOT` (baseline VDOT + accumulated gains + RPE adjustment).
        *   Calculate `currentFitness` (race time from `currentVDOT`).
        *   Calculate `forecast` (future race time) using `src/calculations/predictions.ts:calculateLiveForecast()` (which incorporates `src/calculations/training-horizon.ts:applyTrainingHorizonAdjustment()` and `adaptationRatio`).
        *   Determine `s.pac` (current paces) using `src/calculations/paces.ts:gp(currentVDOT, s.lt)`.
    *   **Output:** Updated `currentVDOT`, `currentFitness`, `forecast`, `s.pac`.

3.  **Stage: Generate Base Weekly Workouts (`src/workouts/generator.ts:generateWeekWorkouts()`)**
    *   **Input:** `wk.ph` (current phase), `s.rw` (runs per week), `s.rd` (race distance), `s.typ` (runner type), `previousSkips`, `s.commuteConfig`, `s.recurringActivities`, `s.onboarding.experienceLevel`, `currentVDOT`, `s.w`, `s.tw`, `s.pac.e`.
    *   **Process:**
        *   Calls `src/workouts/plan_engine.ts:planWeekSessions()`:
            *   Determines `AbilityBand` from `currentVDOT`.
            *   Checks for `isDeloadWeek`.
            *   Calculates `maxQuality`.
            *   Calculates workout durations (`longRunMinutes()`, `easyRunMinutes()`, etc.) based on `ability`, `phase`, `weekIndex`.
            *   Determines `workoutPriority()` (race-specific, phase-specific, `runnerTypeBias`).
            *   Generates `SessionIntent`s.
        *   For each `SessionIntent`, converts it to a `Workout` object using `src/workouts/intent_to_workout.ts:intentToWorkout()`.
        *   Adds `previousSkips` as "makeup" workouts.
        *   Adds `commute` runs and `recurringActivities`.
        *   Calculates `aerobic` and `anaerobic` loads for each workout using `src/workouts/load.ts:calculateWorkoutLoad()`.
        *   Attaches HR targets using `src/calculations/heart-rate.ts`.
        *   Assigns default days using `src/workouts/scheduler.ts:assignDefaultDays()`.
    *   **Output:** List of `Workout` objects for the week (`wos`), potentially with default days assigned and loads calculated.

4.  **Stage: Apply Injury Adaptations (`src/injury/engine.ts:applyInjuryAdaptations()`)**
    *   **Input:** `wos` (generated workouts), `injuryState` (from `s`).
    *   **Process:**
        *   `evaluatePhaseTransition()`: Checks current `injuryPhase` and pain trends to determine if a phase transition (progression/regression) is needed.
        *   **Decision: Current Injury Phase?** (e.g., 'acute', 'rehab', 'test_capacity', 'return_to_run', 'resolved').
            *   **IF 'acute' / 'rehab' / 'test_capacity' / 'return_to_run':** Completely replaces `wos` with phase-specific workouts (`generateAcutePhaseWorkouts()`, etc.).
            *   **IF 'resolved' (and low pain):** Calls `applyAdvancedInjuryLogic()` to adapt `wos` on a workout-by-workout basis using `adaptWorkoutForInjury()`.
                *   `adaptWorkoutForInjury()`: Removes banned workout types, replaces with cross-training, reduces intensity/volume based on `recoveryPhase`.
    *   **Output:** Adapted list of `Workout` objects, potentially a new `injuryState`, `warnings`, `recommendations`.

5.  **Stage: Apply Stored Workout Modifications (`src/ui/renderer.ts:render()`)**
    *   **Input:** Adapted `wos`, `wk.workoutMods`, `wk.workoutMoves`, `wk.adhocWorkouts`.
    *   **Process:**
        *   Applies modifications (status, distance, type, RPE) stored in `wk.workoutMods` (from user-confirmed cross-training suggestions or direct edits). Recalculates loads if modified.
        *   Appends `adhocWorkouts` (e.g., from "Just Run" feature).
        *   Applies `wk.workoutMoves` (user-moved workouts) to reassign `dayOfWeek`.
    *   **Output:** Final list of `Workout` objects (`wos`) for display.

6.  **Stage: Render Workouts & Dashboard (`src/ui/renderer.ts:render()`, `src/ui/main-view.ts:getMainViewHTML()`)**
    *   **Input:** Final `wos`, `wk`, `s`, `s.pac`, calculated `currentFitness`, `forecast`, `currentVDOT`.
    *   **Process:**
        *   Update prediction/progress panels.
        *   Generate warning messages (`checkConsecutiveHardDays`).
        *   Render `renderCalendar()` (with drag-and-drop).
        *   Render `renderWorkoutList()` (detailed workout cards with RPE buttons, Track Run buttons, Skip buttons).
        *   Render current paces.
        *   Render cross-training form.
        *   Refresh GPS recordings list (`src/ui/gps-panel.ts:refreshRecordings()`).
    *   **Output:** Fully rendered main application dashboard with the current week's adaptive training plan.

### 5.3. Flowchart 3: Activity Tracking & Impact Flow

**Trigger:** User starts a run via "Track Run" button or logs an activity manually/via sync.

**Sequence:**

1.  **Stage: Initiate Activity Tracking / Log Activity**
    *   **Decision 1a: User Clicks "Start Run" (`src/ui/renderer.ts:attachTrackRunHandlers()`, `src/ui/events.ts:trackWorkout()`)**
        *   **Input:** `workoutName`, `workoutDescription`.
        *   **Process:**
            *   Create/initialize `GpsTracker` (`src/gps/tracker.ts`).
            *   Call `gpsTracker.start()`.
            *   Set `activeWorkoutName`.
        *   **Output:** `GpsTracker` instance in 'acquiring' state, UI reflects tracking start.
    *   **Decision 1b: User Logs Manual Activity (`src/ui/renderer.ts:renderCrossTrainingForm()`, `src/ui/events.ts:logActivity()`)**
        *   **Input:** `sport`, `durationMin`, `rpe`, `aerobicLoad`, `anaerobicLoad`.
        *   **Process:**
            *   Creates a `CrossActivity` object (`src/cross-training/activities.ts:createActivity()`).
            *   Proceeds to **Stage: Process Logged Activity for Adaptations**.
        *   **Output:** `CrossActivity` object.
    *   **Decision 1c: External Activity Syncs (`src/ui/renderer.ts:setupSyncListener()`)**
        *   **Input:** `CustomEvent('sync-activity', detail: ExternalActivity)`.
        *   **Process:**
            *   Calls `src/calculations/matching.ts:findMatchingWorkout()` to match against planned workouts.
            *   If matched, calls `src/ui/sync-modal.ts:showMatchProposal()` for user confirmation.
        *   **Output:** If matched and confirmed, proceeds to **Stage: Process Logged Activity for Adaptations** (with `ExternalActivity` treated as `CrossActivity` for load). If unmatched, dispatches `sync-activity-unmatched`.

2.  **Stage (GPS Path): Real-time GPS Tracking (`src/gps/tracker.ts`, `src/gps/geo-math.ts`, `src/gps/split-scheme.ts`, `src/ui/gps-panel.ts`)**
    *   **Input:** Raw GPS points from `GpsProvider`, `SplitScheme` for the workout.
    *   **Process (Loop for each GPS point):**
        *   **`tracker.ts:handlePoint()`:**
            *   `filterJitter()` (removes bad points).
            *   `haversineDistance()` (accumulates `totalDistance`).
            *   `checkSplitBoundary()` (detects splits, records `GpsSplit`).
        *   **`tracker.ts:notify()`:** Dispatches `GpsLiveData`.
        *   **`src/ui/gps-panel.ts:updateInlineGps()`:** Updates UI with `totalDistance`, `elapsed`, `currentPace`, `splits`.
    *   **Output:** Live GPS data displayed, accumulated `totalDistance`, `elapsed`, `GpsPoint`s, `GpsSplit`s.

3.  **Stage (GPS Path): Stop Tracking (`src/gps/tracker.ts:stop()`, `src/ui/events.ts:gpsStop()`)**
    *   **Input:** User stops tracking.
    *   **Process:**
        *   `gpsTracker.stop()`.
        *   Calculate `GpsRecording` data (total distance, time, avg pace, all points, splits).
        *   `src/gps/persistence.ts:saveGpsRecording()`: Persists `GpsRecording` to `localStorage`.
        *   Proceed to **Stage: Process Logged Activity for Adaptations**.
    *   **Output:** `GpsRecording` object.

4.  **Stage: Process Logged Activity for Adaptations (`src/ui/events.ts:logActivity()`, `src/cross-training/suggester.ts:buildCrossTrainingPopup()`)**
    *   **Input:** `CrossActivity` (manual/synced) OR `GpsRecording` (converted to `CrossActivity` equivalent), `SimulatorState`.
    *   **Process:**
        *   **`src/cross-training/universalLoad.ts:computeUniversalLoad()`:** Calculate `recoveryCostLoad` (FCL) and `runReplacementCredit` (RRC) for the activity (using Tier A, B, or C).
        *   **`src/cross-training/suggester.ts:computeSeverity()`:** Determine impact severity ('light', 'heavy', 'extreme').
        *   **`src/cross-training/suggester.ts:buildCandidates()`:** Identify potential running workouts to modify based on `vibeSimilarity` and prioritization.
        *   **`src/cross-training/suggester.ts:buildReduceAdjustments()` / `buildReplaceAdjustments()`:** Generate specific `Adjustment`s (downgrade, reduce distance, replace) within the `runReplacementCredit` budget.
        *   **`src/cross-training/suggester.ts:buildCrossTrainingPopup()`:** Creates a structured `SuggestionPopup` payload for the UI.
    *   **Output:** `SuggestionPopup` object with `severity`, `headline`, `summary`, `equivalentEasyKm`, `recoveryCostLoad`, `runReplacementCredit`, and `ChoiceOutcome`s.

5.  **Decision: User Response to Adaptation Suggestion (`src/ui/sync-modal.ts:showMatchProposal()`, `src/ui/events.ts:logActivity()`)**
    *   **Condition:** User selects 'keep', 'reduce', or 'replace' from the `SuggestionPopup`.

    **IF User Chooses 'KEEP':**
    *   **Action:** No plan changes applied.
    *   **Output:** `SimulatorState` unchanged (except `GpsRecording` saved if applicable).

    **IF User Chooses 'REDUCE' or 'REPLACE':**
    *   **Action:** Apply Adjustments.
    *   **Process:** `src/cross-training/suggester.ts:applyAdjustments()`:
        *   Iterate through selected `Adjustment`s.
        *   Modify `status`, `distance`, `type`, `RPE`, `modReason` of relevant workouts in `wk.workoutMods`.
        *   Recalculate `aerobic` and `anaerobic` loads for modified workouts.
        *   Update `wk.crossTrainingSummary` (track `workoutsReplaced`, `workoutsReduced`, `budgetUtilization`).
        *   Update `wk.crossTrainingBonus` if there's load overflow.
        *   `src/state/persistence.ts:saveState()`.
    *   **Output:** Updated `SimulatorState` with modified training plan for the week.

6.  **Final Stage: Re-render Main Application View**
    *   **Input:** Updated `SimulatorState`.
    *   **Process:** `src/ui/main-view.ts:renderMainView()` is called, which in turn calls `src/ui/renderer.ts:render()`.
    *   **Output:** Main dashboard UI is updated to reflect the plan modifications, cross-training impact, or newly logged activity.
