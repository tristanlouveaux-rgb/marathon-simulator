# 🧠 Marathon Simulator: Context Index & Repo Map
> **Usage:** Paste this ENTIRE file into Claude at the start of a session.
> **Goal:** Maximum context with minimum tokens.

---

## 1. The Core Architecture (Cognitive Map)

### **A. The Brain (`src/workouts/`)**
*   **`generator.ts`** -> `generateWeekWorkouts(phase, runnerType, injuryState)`
    *   *Role:* The pure function that builds the weekly schedule.
    *   *Key Dependencies:* `src/injury/engine.ts` (filters workouts).
*   **`scheduler.ts`** -> `assignDefaultDays(workouts)`
    *   *Role:* Decides *when* runs happen (e.g., Long Run = Sunday).

### **B. The Body (`src/ui/`)**
*   **`main-view.ts`** -> The monolithic dashboard controller.
    *   *Role:* Handles user input, rendering, and state updates.
    *   *Key State:* `s.w` (Current Week), `s.v` (VDOT), `s.injuryState`.
*   **`events.ts`** -> Event handlers for buttons (Skip, Rate, Injure).

### **C. The Physio Engine (`src/injury/`)**
*   **`engine.ts`** -> `applyInjuryAdaptations(workouts, injuryState)`
    *   *Role:* The "Physio-Grade" logic. Modifies plan based on `injuryPhase`.

### **D. The Math (`src/calculations/`)**
*   **`nudges.ts`** -> `decideMilestone(snapshot)` (Durability Matrix).
*   **`fatigue.ts`** -> `calculateFatigueExponent(pbs)` (Runner Type).
*   **`training-horizon.ts`** -> `applyTrainingHorizonAdjustment` (VDOT Gain).

---

## 2. Condensed Type Definitions (Read-Only Memory)
*Claude, use these types to write code without needing to see the file.*

```typescript
// src/types/injury.ts
type InjuryPhase = 'acute' | 'rehab' | 'test_capacity' | 'return_to_run' | 'resolved';

interface InjuryState {
  active: boolean;
  currentPain: number; // 0-10
  injuryPhase: InjuryPhase;
  acutePhaseStartDate: string | null; // ISO Date
  capacityTestsPassed: string[]; // e.g., 'single_leg_hop'
  history: { date: string; pain: number }[];
}

// src/types/training.ts
type RaceDistance = '5k' | '10k' | 'half' | 'marathon';
type RunnerType = 'Speed' | 'Balanced' | 'Endurance';
type TrainingPhase = 'base' | 'build' | 'peak' | 'taper';

interface Workout {
  t: 'easy'|'long'|'interval'|'threshold'|'cross'|'rest'|'test_run';
  n: string; // Name
  d: string; // Description (e.g. "50min @ 5:00/km")
  rpe: number; // Target RPE
  status?: 'planned'|'completed'|'skipped';
}
```

---

## 3. Protocol: How to Interact
**User:** "I want to implement the 'Just Run' button."
**Claude:** "Checking Index...
1.  I need **`src/ui/main-view.ts`** to add the button UI.
2.  I need **`src/ui/events.ts`** to handle the click.
3.  I see `Workout` type in the Index, so I don't need `src/types/state.ts`.
-> Please show me only **`main-view.ts`** and **`events.ts`**."
