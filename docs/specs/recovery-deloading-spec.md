# Recovery-Based Intelligent Deloading — v1 Spec

## Location
This document: `docs/recovery-deloading-spec.md`

## Goal
If a user has low recovery (bad sleep, low Garmin readiness, concerning HRV), show ONE
prompt per day offering options to adjust TODAY's planned workout. Mirrors the cross-training
adjustment UX: user gets options, chooses, then we apply edits to today's workout.

Works in both **Race mode** and **General Fitness mode**.

## Architecture

```
┌──────────────────┐     ┌───────────────────────┐     ┌──────────────────┐
│  Data Sources     │────▶│  Recovery Engine       │────▶│  UI Layer        │
│  - Manual input   │     │  src/recovery/engine.ts│     │  main-view.ts    │
│  - Garmin (future)│     │                       │     │  events.ts       │
│  - Apple Watch    │     │  computeRecoveryStatus │     │                  │
│    (sleep only)   │     │  trend detection       │     │  Recovery pill   │
└──────────────────┘     └───────────────────────┘     │  Input modal     │
                                                        │  Adjust modal    │
                                                        │  Recovery log    │
                                                        └──────────────────┘
                                                               │
                                                               ▼
                                                     ┌──────────────────┐
                                                     │  Adjustment      │
                                                     │  Application     │
                                                     │  (reuses cross-  │
                                                     │  training path)  │
                                                     │  applyAdjustments│
                                                     │  → wk.workoutMods│
                                                     └──────────────────┘
```

### Key Principle
This is NOT a new load engine. It's a UI-triggered plan edit driven by recovery signals.
We reuse the existing `applyAdjustments` from `src/cross-training/suggester.ts` and store
modifications in `wk.workoutMods` — the same persistence path as cross-training edits.

## Files

| File | Role | New/Modified |
|------|------|-------------|
| `src/recovery/engine.ts` | Recovery scoring engine | **NEW** |
| `src/recovery/engine.test.ts` | Engine tests | **NEW** |
| `src/types/state.ts` | State schema additions | Modified |
| `src/ui/main-view.ts` | Recovery pill, modals, log panel | Modified |
| `src/ui/events.ts` | Adjustment application logic | Modified |
| `docs/recovery-deloading-spec.md` | This document | **NEW** |

## Data Model

### RecoveryEntry (in engine.ts)
```typescript
interface RecoveryEntry {
  date: string;              // YYYY-MM-DD
  sleepScore: number;        // 0-100 (manual: Great=90, Good=70, Poor=45, Terrible=25)
  readiness?: number;        // 0-100 (Garmin readiness, when available)
  hrvStatus?: 'balanced' | 'low' | 'unbalanced' | 'strained'; // Garmin HRV
  source: 'garmin' | 'manual';
}
```

### SimulatorState additions (in state.ts)
```typescript
recoveryHistory?: RecoveryEntry[];     // Rolling history (engine keeps last 7)
lastRecoveryPromptDate?: string;       // ISO date — one-prompt-per-day guard
```

## Scoring Rules (engine.ts)

### Thresholds
| Metric | Green | Yellow | Orange trigger | Red trigger |
|--------|-------|--------|---------------|-------------|
| Sleep score | ≥ 70 | 50–69 | n/a (trend) | < 30 |
| Readiness (Garmin) | ≥ 60 | 40–59 | 30–39 | < 30 |
| HRV status (Garmin) | balanced | — | low / unbalanced | strained |

### Escalation Rules
- **Green**: All metrics within healthy range → no action
- **Yellow**: One metric below threshold → gentle "Tap to adjust" pill
- **Orange**: Escalated from yellow IF 2 of last 3 days were yellow/red → recommend adjusting
- **Orange**: Readiness 30–39 (direct)
- **Orange**: HRV low or unbalanced (direct)
- **Red**: Sleep < 30 OR readiness < 30 OR HRV strained → strongly recommend

### Trend Rule
Single bad night → yellow (not orange). Only escalates to orange if pattern detected
(2 of last 3 days had sleep < 50). This prevents overreacting to one bad night.

## UI Flows

### 1. Recovery Pill (main-view.ts, after injury banner)
Renders in header area for ALL users (race + general fitness):

| State | Pill appearance | Action |
|-------|----------------|--------|
| No data today | "Recovery: Log today" (gray) | Opens input modal |
| Data + green | "Recovery: Good" (green dot) | No action |
| Data + yellow/orange/red, not prompted | "Recovery: Low — Tap to adjust" (colored) | Opens adjust modal |
| Data + already prompted today | Small status dot only | No action |

### 2. Manual Input Modal (showRecoveryInputModal)
```
┌─────────────────────────────┐
│  How did you sleep?         │
│  Quick check-in to optimize │
│  today's training.          │
│                             │
│  [Great]   Slept well       │
│  [Good]    Normal night     │
│  [Poor]    Restless/short   │
│  [Terrible] Barely slept    │
│                             │
│  Skip                       │
└─────────────────────────────┘
```
Maps: Great→90, Good→70, Poor→45, Terrible→25.
If score < 70: immediately opens adjustment modal.
If score ≥ 70: pill turns green, no further action.

### 3. Adjustment Modal (showRecoveryAdjustModal)
```
┌─────────────────────────────┐
│  [Recovery: Low]            │
│                             │
│  • Poor sleep (45/100)      │
│  • 2 of last 3 days low     │
│                             │
│  Today: Threshold Run       │
│                             │
│  [Downgrade to Easy]  ★Rec  │
│  Keep distance, lower RPE   │
│                             │
│  [Reduce Distance]          │
│  Cut by 20%, keep type      │
│                             │
│  [Ignore]                   │
│  Keep plan unchanged        │
│                             │
│  Dismiss                    │
└─────────────────────────────┘
```

### 4. Recovery Log Panel (left column, after Profile)
Shows last 7 days as colored dots + "Log Today" button.
Works in both Race and General Fitness mode.

## Adjustment Application (events.ts)

### applyRecoveryAdjustment(type, dayOfWeek)
1. Generate this week's workouts via `generateWeekWorkouts`
2. Re-apply existing `wk.workoutMods` so we don't double-modify
3. Find workouts matching today's `dayOfWeek` (exclude cross/strength/rest/replaced)
4. Build `Adjustment[]` compatible with cross-training system:
   - **Downgrade**: action='downgrade', newType='easy', keep distance
   - **Reduce**: action='reduce', newDistanceKm = original × 0.8 (min 3km)
5. Apply via `applyAdjustments(workouts, adjustments, 'recovery')`
6. Store in `wk.workoutMods` (same persistence as cross-training)
7. Set `s.lastRecoveryPromptDate = today`
8. `saveState()` + `render()`

### Impact on Race Time
In race mode, reduced load affects VDOT gain through the existing adherence mechanism
in `next()` (events.ts line ~452): `adherence = completedCount / expectedCount`. We do NOT
draw attention to this — no "you hurt your goal" language. Recovery is positive.

## Test Plan (engine.test.ts)

| Test | Input | Expected |
|------|-------|----------|
| Good sleep → green | sleepScore: 85 | status: 'green', shouldPrompt: false |
| Poor sleep → yellow | sleepScore: 55 | status: 'yellow', shouldPrompt: true |
| Very poor sleep → red | sleepScore: 20 | status: 'red', shouldPrompt: true |
| Trend escalation | today: 55, history: [40, 45] | status: 'orange' (2/3 days low) |
| No trend escalation | today: 55, history: [80, 45] | status: 'yellow' (only 1/3 low) |
| Strained HRV → red | hrvStatus: 'strained' | status: 'red' |
| Low readiness → orange | readiness: 35 | status: 'orange' |
| No data → green | null | status: 'green', shouldPrompt: false |
| Ignore = no changes | (verify in integration) | 0 workoutMods added |
| Downgrade = correct edit | (verify in integration) | workout.t changes to 'easy' |
| Reduce = correct edit | (verify in integration) | workout distance × 0.8 |

## Day-of-Week Mapping
JavaScript `getDay()` returns 0=Sunday. Our workout system uses 0=Monday, 6=Sunday.
Conversion: `jsDay === 0 ? 6 : jsDay - 1`

## One-Prompt-Per-Day Guard
`s.lastRecoveryPromptDate` stores ISO date (YYYY-MM-DD). If it matches today, the
adjustment modal is NOT shown again. The pill still shows status but without "Tap to adjust".

## Future: Garmin Integration
When Garmin API is connected:
1. On dashboard load, fetch today's readiness/HRV/sleep from Garmin
2. Create a `RecoveryEntry` with `source: 'garmin'` and real scores
3. Push to `s.recoveryHistory`
4. The engine + UI work identically — no code changes needed in engine/UI
5. The pill auto-populates instead of requiring manual input

Entry point for Garmin data: `src/recovery/engine.ts: createGarminRecoveryEntry()`
(stub provided, flesh out during Garmin integration sprint)

## For Handoff
If another Claude agent picks this up:
1. Read this spec first
2. Key files: `src/recovery/engine.ts` (scoring), `src/ui/main-view.ts` (UI),
   `src/ui/events.ts` (adjustment application)
3. The recovery system reuses the cross-training adjustment path —
   see `applyAdjustments` in `src/cross-training/suggester.ts`
4. State is persisted via `wk.workoutMods` and `s.recoveryHistory`
5. Tests are in `src/recovery/engine.test.ts`
