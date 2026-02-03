# Master Implementation Prompt for Claude
> **Instructions:** Copy and paste this entire block into your Claude session to authorize the full upgrade.

***

**Project Directive: "Activate the Sleeping Giants"**

**Context:**
Our codebase contains advanced logic for Injury Management, Goal Nudging, and Qualification metrics, but they are currently "sleeping" — either disconnected or blocked by legacy code. We need to wake them up.

**The Mission:**
Refactor the application to fully utilize the advanced engines we have built.

---

### **Phase 1: The Critical Unblock (Injury Engine)**
**Target:** `src/workouts/generator.ts`
**Issue:** A legacy "Early Return" block prevents the new 5-phase `src/injury/engine.ts` from running.
**Tasks:**
1.  **Delete** the legacy early return block in `generateWeekWorkouts` (lines ~35-42).
2.  **Delete** the legacy `generateRehabWeek` function.
3.  **Ensure** the final workout lists are passed through `applyInjuryAdaptations` (imported from `@/injury/engine`).

### **Phase 2: Connect the "Honesty" Engine (Nudges)**
**Target:** `src/ui/weekly-summary.ts` (or equivalent dashboard component)
**Issue:** `src/calculations/nudges.ts` implements the "Durability Matrix" (Case A/B/C) but is **never called** (0 references).
**Tasks:**
1.  **Import** `decideMilestone` from `@/calculations/nudges`.
2.  **Call it** in the weekly summary view using the user's current metrics (Forecast, Long Run Distance).
3.  **Display** the result:
    *   **Case A (Green)**: "Target Realistic" badge.
    *   **Case B (Amber)**: "Fitness Good / Durability Low" warning.
    *   **Case C (Yellow)**: "Exploratory" status.

### **Phase 3: Verify the "Runner Type" Logic (Fatigue)**
**Target:** `src/types/runner.ts` / `src/state/initialization.ts`
**Issue:** `src/calculations/fatigue.ts` calculates the `fatigueExponent` (b), but we must ensure this *actually* alters the training plan.
**Tasks:**
1.  **Verify** that `runnerType` in the global state is derived from `calculateFatigueExponent(pbs)`.
2.  **Verify** that `src/workouts/generator.ts` uses this `runnerType` to select different workouts (e.g., 'Speed' type gets different intervals than 'Endurance' type).
3.  **Fix Threshold Mismatch**: Align `getRunnerType` and `gt()` thresholds in `fatigue.ts` to ensure consistent typing across views.

### **Phase 4: Structural Integrity Fixes**
**Target:** `src/queries/events.ts` and `src/types/injury.ts`
**Issues:**
1.  **Fake Progress**: `src/queries/events.ts` (line ~408) uses a hardcoded `0.06` VDOT gain instead of the real training horizon model.
2.  **Schizophrenic Injury State**: `injuryPhase` (new) and `recoveryPhase` (old) exist simultaneously in `types/injury.ts`, causing state conflicts.
**Tasks:**
1.  **Refactor** `events.ts` to use `applyTrainingHorizonAdjustment` for actual VDOT progression.
2.  **Unify** the injury state model: Deprecate `recoveryPhase` and fully migrate to `injuryPhase` as the single source of truth.

---

**Definition of Done:**
1.  **Injury**: Setting an injury to pain level 6 *correctly* triggers the "Acute Phase" (72h rest) from the new engine, NOT the generic rehab week.
2.  **Nudges**: The Dashboard shows a "Durability Status" badge based on my long run progress.
3.  **Architecture**: `generator.ts` is lean and delegates complex logic to `engine.ts`.

### **Phase 5: "Just Run" Mode (Unstructured)**
**Target:** `src/ui/main-view.ts` (Dashboard)
**Context:** Users need a way to log runs that aren't part of the plan (e.g., shakeouts, mental resets).
**Tasks:**
1.  **Add "Just Run" Button**: Prominent button on the dashboard (near "Start Tracker").
2.  **Bypass Plan Logic**: When clicked, start the GPS tracker immediately without associating it with a planned workout ID.
3.  **Log as Unstructured**: Ensure the save logic flags this as `unstructured: true` so it counts towards load but doesn't mess up "Planned vs Actual" adherence scores.

***
