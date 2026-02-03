# Context Restoration Prompt
> **Instructions for User:** Copy and paste this ENTIRE block into your new Claude session. It is optimized to be low-token but high-context.

***

**System Context: Marathon Simulator Refactor**

**1. Project State**
We are refactoring a marathon training app. We have just updated the architecture to use a "Physio-Grade" injury system, but the legacy code is blocking it.

**2. Key Architectural Definitions (from PRD)**
*   **Physio-Grade Injury System**: A 5-phase recovery model (`Acute` -> `Rehab` -> `Test Capacity` -> `Return to Run` -> `Resolved`) managed by `src/injury/engine.ts`.
*   **The Conflict**: The workout generator currently overrides this with a "dumb" check (if pain > 4, return generic rehab).

**3. Immediate Task: Unblock the Injury Engine**
A legacy "Early Return" block in `src/workouts/generator.ts` is preventing the new engine from running.

**Your Job:**
Refactor `src/workouts/generator.ts` to defer specific decision-making to the `injury/engine.ts` module.

**Steps:**
1.  **Open** `src/workouts/generator.ts` and `src/injury/engine.ts`.
2.  **DELETE** the "Early Return" block in `generator.ts` (lines ~35-41) that intercepts injury cases.
3.  **DELETE** the legacy `generateRehabWeek` function at the bottom of `generator.ts`.
4.  **VERIFY** that `applyInjuryAdaptations` is called at the end of `generateWeekWorkouts` (it should already be there).
5.  **Outcome**: `generator.ts` should generate a standard week, and let `applyInjuryAdaptations` (the smart engine) decide if it needs to be replaced with rehab/rest.

**Files to Contextualize:**
- `src/workouts/generator.ts` (Target for refactor)
- `src/injury/engine.ts` (Source of truth for logic)
- `PRD.md` (Reference if needed)

***
