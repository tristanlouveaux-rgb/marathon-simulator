# Non-Event Continuous Training — Design Specification

> Source: GPT research conversation (Feb 2026)
> Purpose: Architecture map + design decisions for non-event training mode

---

## 1. Non-Event Architecture Map

### State & Flow

**Entry Point:** `src/ui/wizard/steps/training-goal.ts`

**Logic:** Currently "fakes" a race goal for non-event users. `trainingForEvent: false` triggers a proxy assignment:
- Focus 'speed' → `raceDistance: '5k'`, `planDuration: 8 weeks`
- Focus 'endurance' → `raceDistance: 'half'`, `planDuration: 12 weeks`
- **Issue:** This forces a finite timeline on an infinite goal.

**Plan Construction:**
- `src/workouts/generator.ts` (`initializeWeeks`): Creates a fixed array of `Week` objects based on `totalWeeks`.
- `src/workouts/plan_engine.ts` (`planWeekSessions`): Uses `weekIndex` to determine Phase (Base/Build/Peak/Taper) linearly.

**Progression Logic:**
- `src/ui/events.ts` (`next()`): Advances `s.w` (current week).
- **Termination:** When `s.w > s.tw`, it calls `complete()`, showing a "Training Complete" screen. There is no looping or extension logic.

### Loading & Fitness

**Load Calculation:** `src/workouts/load.ts` (`calculateWorkoutLoad`) & `src/cross-training/universalLoad.ts` (`computeUniversalLoad`).

**Fitness Update:**
- `src/ui/events.ts` (`rate()`): Updates VDOT (`s.v`) based on adherence (`wk.wkGain`), NOT performance.
- `wkGain` is derived from the "Training Horizon" model (`training-horizon.ts`), which assumes a fixed race date.
- Real fitness changes (e.g. valid test result) only happen via manual input in `updateFitness()` (`events.ts`), which calls `physiology-tracker.ts`.

---

## 2. Existing Concepts to Reuse

- **Phases:** `trainingPhase` ('base', 'build', 'peak', 'taper') exists in `types/training.ts` and `plan_engine.ts`. We can introduce a 'maintenance' or 'test' phase.
- **Injury "Freeze":** `src/ui/events.ts` already has logic to "freeze" the plan week (`s.w`) while accumulating "Rehab Weeks" (`s.rehabWeeksDone`). Similar logic can "hold" a user in a continuous cycle.
- **Forecast Model:** `src/calculations/predictions.ts` (`calculateLiveForecast`) works for non-event users (showing "Performance Forecast").
- **Cross-Training:** `src/cross-training` is robust and handles "Run Replacement Credit" which can slot into any week type.

---

## 3. Minimum Edit Set

| File | Change |
|------|--------|
| `src/ui/wizard/steps/training-goal.ts` | For non-event users, set `planDurationWeeks` to a generic block size (e.g., 4 or 6) or a flag `isContinuous: true`. Don't force a fake 'half' marathon if avoidable. |
| `src/workouts/plan_engine.ts` | Extract phase logic so we can generate a "Base Block" or "Test Week" on demand. Add `generateBenchmarkWeek()`. |
| `src/ui/events.ts` (Looping) | Update `next()`: If `isContinuous && s.w == s.tw`, do NOT call `complete()`. Instead: archive current block, generate next block (3 weeks Build + 1 week Test), append to `s.wks`, increment `s.tw`. |
| `src/ui/events.ts` (Feedback) | Update `rate()`: If workout type is test/benchmark, calculate VDOT from actual result and call `updateFitness()` internally. |
| `src/ui/main-view.ts` | Hide "Week X of Y" for non-event. Show "Week X of Current Block" or "Continuous Training". |

---

## 4. Recommended Minimal-Diff Design

### A. Continuous Cycles (The "Block" Approach)

Instead of rewriting the engine to be truly infinite, treating it as auto-appending blocks is the smallest diff.

- **Structure:** 4-week repeating blocks (3 Build + 1 Recovery/Test).
- **Implementation:** In `next()`, when approaching end of plan, append 4 new weeks.
- **State:** Add `s.blockType` ('base', 'build', 'peak') to toggle focus.

### B. Benchmark Testing

- **Workout Type:** Add `benchmark` or reuse `test_run`.
- **In Plan:** The 4th week of every block is a "Test Week".
- **Workout:** "5km Time Trial" (Speed focus) or "20min Tempo Test" (Endurance).
- **Result:** When user rates this workout, capture the result (Time/Pace). Trigger `recordMeasurement` in `physiology-tracker.ts`. Recalculate VDOT. Next block's paces adjust automatically.

### C. UI Gating

- **Flag:** Use `s.onboarding.trainingForEvent === false`.
- **Changes:**
  - Header: "Continuous Improvement" instead of "Goal: Sub-4 Marathon"
  - Timeline: "Maintaining & Building" instead of "12 weeks to go"

---

## 5. Benchmark System Design (4-Tier)

### Principles
1. **Optional:** benchmark is always a button, never required. If skipped → plan continues normally.
2. **Auto-pull first:** if a relevant run comes from Garmin/Strava (`CrossActivity.fromGarmin === true` + sport === running) during the benchmark window, we use it.
3. **Submax defaults for most users:** avoid all-out time trials unless user explicitly chooses "Race simulation".

### Benchmark Menu (User-Facing Options)

#### A) "Easy Check-in" (submax, low stress)
- **Goal:** Track aerobic progress without smashing legs.
- **What:** "30 min easy–steady" and compare pace at similar effort.
- **Scoring:** Detect a ~25–40 min run with mostly aerobic load (or RPE 4–6) and track pace/HR drift.
- **UX copy:** "Easy Check-in (recommended): a steady run that won't wreck you. We'll track if your pace is improving at the same effort."

#### B) "Threshold Check" (moderate, best signal for most)
- **Goal:** Approximate LT progress.
- **Option 1 (classic):** 20-min comfortably hard.
- **Option 2 (safer):** 2 × 10 minutes with 2 min easy jog (less intimidating).
- **Scoring:** Use pace for the 20 min segment as a proxy; update LT pace / "vdot_lt" track.
- **UX copy:** "Threshold Check: 20 minutes 'comfortably hard' (or 2×10). Great signal for fitness without an all-out race."

#### C) "Speed Check" (harder, but short)
- **Goal:** VO2-ish + speed.
- **Option 1:** 3km time trial (less scary than 5k).
- **Option 2:** 12-minute Cooper test (distance in 12 minutes).
- **Scoring:** Convert result to a "5k/3k equivalent" and update vdot_pb/recent.
- **UX copy:** "Speed Check: short and sharp. Choose 3km TT or 12-minute test."

#### D) "Race Simulation" (all-out; explicitly opt-in)
- **Goal:** Cleanest single-point benchmark but highest cost.
- **Options:** 5k TT / 10k TT (only show for intermediate+).
- **UX copy:** "Race Simulation (optional): highest accuracy, highest fatigue. Only do this if you're fresh and keen."

### Smart Defaults (focus × experienceLevel)

| Experience | Speed Focus | Endurance Focus | Balanced |
|-----------|------------|-----------------|----------|
| total_beginner / beginner / novice | Easy Check-in | Easy Check-in | Easy Check-in |
| intermediate | Speed Check (12-min or 3k) | Threshold Check (2×10 or 20-min) | Threshold Check |
| advanced / competitive | 3k TT | 20-min threshold | Rotate threshold and speed every other block |

### Auto-Pull from Garmin/Strava

Since Garmin runs land as `CrossActivity` in `s.crossActivities`:
- **Benchmark window:** The last week of the block (or any week tagged as benchmark week).
- **Search criteria:**
  - `fromGarmin === true`
  - normalized sportKey === 'running'
  - `week === currentWeek`
- If no match → offer "Log it manually" or "Skip".

---

## 6. Key Constraints

- **No lap/segment data:** `CrossActivity` only stores aggregate totals. Benchmarks must be whole-activity.
- **Training Focus stored at:** `s.onboarding.trainingFocus` — type: `'speed' | 'endurance' | 'both'`
- **Do not change cross-training math.**
- **Do not require lap parsing.**
- **Avoid refactors; prefer additive flags/branches.**

---

## 7. Data Pipeline Map

- **Ingestion:** `cross-training/suggester.ts` → `buildCrossTrainingPopup`
- **Normalization:** `cross-training/universalLoad.ts`
- **Storage:** `s.crossActivities` (in state)
- **Plan Integration:** `workouts/generator.ts` → `generateWeekWorkouts` injects activities into week workouts array
- **`fromGarmin`:** Already respected in `universalLoad.ts` (Tier 1 load source)

---

## 8. Open Questions

1. **VDOT Decay:** Currently, VDOT only goes up (or stays flat) via `wkGain`. Do we need logic for "detraining" if they start skipping? (Currently adherence just reduces the gain, doesn't subtract).
2. **Phase selection:** How does a non-event user switch from "Base" to "Speed"? Manual toggle? (Profile → Edit Runner Type is heavy).
