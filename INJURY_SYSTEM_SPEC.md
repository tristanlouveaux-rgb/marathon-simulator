# Intelligent Injury Management System - Implementation Prompt

This document serves as the **Logic Specification** and **Integration Prompt** for adding the Intelligent Injury System into the Marathon Simulator codebase (`src`).

## 1. Core Objectives
- Capture user injury state (Type, Pain Level 0-10, Functional Ability).
- Adapt the training plan dynamically based on injury rules.
- Integrate cross-training alternatives (Swim/Bike) seamlessly.
- Implement a "Gradual Return-to-Run" (Walk/Run) protocol.

## 2. New Data Models (`src/types/injury.ts`)

```typescript
export type InjuryType = 
  | 'knee_pain' | 'shin_splints' | 'achilles' | 'plantar_fasciitis' 
  | 'hip_groin' | 'stress_fracture' | 'other';

export type FunctionalStatus = 
  | 'normal'        // Full capacity
  | 'pain_run'      // Can run but with pain (reduce intensity)
  | 'pain_walk'     // Can only walk (no impact)
  | 'no_load';      // Complete rest (no weight bearing)

export interface InjuryState {
  isActive: boolean;
  type: InjuryType;
  painLevel: number; // 0-10
  status: FunctionalStatus;
  diagnosis?: string; // Optional physio/medical notes
  startDate: Date;
  lastAssessmentDate: Date;
}
```

## 3. Adaptation Logic (`src/calculations/injury-adapter.ts`)

### Rule Engine
1.  **High Severity (Pain >= 6 OR Status = 'no_load')**:
    -   **Action**: Replace ALL runs.
    -   **Target**: Cross-Training (Swim/Bike) if allowed, otherwise REST.
    -   **Nudge**: "Pain is high. Focus on recovery. Swapped run for cross-training."

2.  **Moderate Severity (Pain 3-5 OR Status = 'pain_walk')**:
    -   **Action**: Replace Impact Runs.
    -   **Target**: Low Impact Cardio (Elliptical/Cycling) or Walk/Run intervals.
    -   **Nudge**: "Let's reduce impact. Try a walk/run or cycle today."

3.  **Low Severity (Pain 1-2 OR Status = 'pain_run')**:
    -   **Action**: Reduce Intensity/Volume.
    -   **Target**: Easy Runs only (No Speed/Intervals). Cut distance by 30-50%.
    -   **Nudge**: "Keep it easy. Stop if pain increases."

4.  **Phased Return (Status improving)**:
    -   **Protocol**: Graded Return-to-Run (Runna/Prehab style).
    -   **Step 1**: Walk 5min, Run 1min (Repeat).
    -   **Step 2**: Walk 3min, Run 2min.
    -   **Step 3**: Continuous Easy Run (short).

## 4. System Integration Points

### A. Workout Generator (`src/workouts/generator.ts`)
-   **Hook**: Inside `generateWeekWorkouts`.
-   **Logic**: Check `InjuryState`. If active, pass the week's workouts through `InjuryAdapter`.
-   **Output**: Modified workout list (e.g., "5km Easy" -> "30min Cycle").

### B. UI Components (`src/ui/injury`)
1.  **Injury Modal**: Form to log/update injury status.
    -   Inputs: Pain Slider (0-10), Type Select, "Can I run?" toggle.
2.  **Status Banner**: Persistent dashboard element showing "Injury Mode Active".
3.  **Daily Check-in**: Prompt before/after workouts: "Pain level today?"

### C. Cross-Training (`src/cross-training`)
-   Leverage existing `matcher.ts` logic to calculate equivalent load for swapped activities (e.g., 5km Run Load = 45min Bike Load).

## 5. User Flows & Nudges
-   **On Log**: "You've flagged a knee issue. We've switched your intervals to a gentle cycle."
-   **On Recovery**: "Pain score dropped to 1! Ready to try a 10min Walk/Run?"
-   **Physio Input**: "Your physio note says 'No running until Friday'. Plan updated."
