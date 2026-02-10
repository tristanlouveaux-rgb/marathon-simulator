# Handover: Honest Forecast + Graduated Return Phase

## What Changed (Latest)

### 1. Detraining Model During Injury (`src/ui/events.ts`)

Previously `wkGain = 0` during injury — VDOT stayed flat, hiding real fitness loss. Now uses phase-aware detraining:

| Phase | wkGain/week | Rationale |
|-------|------------|-----------|
| Acute | -0.15 | No activity, full detraining |
| Rehab | -0.10 | Cross-training offsets ~1/3 |
| Test Capacity | -0.10 | Similar to rehab |
| Return to Run | -0.05 | Some running offsets ~2/3 |
| Graduated Return | -0.03 | Near-normal training, minimal loss |

The forecast now honestly reflects fitness decay during injury weeks.

### 2. New `graduated_return` Phase

**Type changes** (`src/types/injury.ts`):
- `InjuryPhase` union now includes `'graduated_return'` between `return_to_run` and `resolved`
- `InjuryState` has new field `graduatedReturnWeeksLeft: number` (default 2)

**Engine** (`src/injury/engine.ts`):
- Added to `PHASE_ORDER`, `PHASE_TO_RECOVERY`, `evaluatePhaseTransition`, and `applyInjuryAdaptations`
- Workout adaptation: easy runs pass through unchanged; hard sessions (vo2, intervals, threshold, race_pace, hill_repeats, tempo, long) get RPE capped at 4 and distance reduced by 20%
- Auto-resolves when `graduatedReturnWeeksLeft` hits 0; regresses to `return_to_run` if pain >= 4

### 3. Three-Option Exit Prompt (`src/ui/injury/modal.ts`)

After 2 consecutive zero-pain weeks in return-to-run, users now see 3 choices instead of 2:
1. **"Yes, full return"** — immediate `markAsRecovered()`
2. **"Yes, ease me back in"** — enters `graduated_return` with 2-week countdown
3. **"Not yet"** — stays in recovery

### 4. Graduated Return Check-In Modal (`src/ui/injury/modal.ts`)

New `openGraduatedReturnCheckIn()` modal with:
- "Week X of 2" indicator
- Pain slider (0-10)
- Live decision preview
- Logic: pain <= 1 decrements weeks; pain 2-3 holds; pain >= 4 regresses to return-to-run

### 5. UI Updates

- **`src/ui/main-view.ts`**: Recovery panel shows "Graduated Return" in cyan with "Week X of 2" countdown
- **`src/ui/injury/modal.ts`**: Phase label added to banner display
- **`src/ui/events.ts`**: Injury gate routes `graduated_return` to the new check-in modal

## Files Modified

| File | What |
|------|------|
| `src/types/injury.ts` | Phase type, field, default |
| `src/injury/engine.ts` | Phase order, transition logic, workout adaptations, recovery mapping |
| `src/ui/injury/modal.ts` | 3-option exit prompt, graduated return check-in modal, phase label |
| `src/ui/events.ts` | Detraining model replacing `wkGain=0`, graduated_return routing |
| `src/ui/main-view.ts` | Phase label + week countdown in recovery panel |

## How to Test

1. `npx vite build` — passes clean
2. Enter injury mode, progress to return-to-run, report 0 pain for 2 weeks — 3-option prompt appears
3. Choose "ease me back in" — workouts generate with hard sessions RPE-capped and distance-reduced, easy runs unchanged
4. Weekly check-in appears during graduated return
5. 2 clean weeks (pain <= 1) — auto-resolves
6. Pain >= 4 — regresses to return-to-run
7. During any injury phase, forecast decreases slightly each week (detraining)

---

## Previous Handover: Response-Gated Return-to-Run Bugs

### Bug 1: Double-click to complete week when injured

**Problem**: User clicks "Complete Week" -> injury check-in modal opens -> user fills it in -> page reloads -> user has to click "Complete Week" AGAIN to actually advance.

**Root cause**: In `src/ui/events.ts:next()`, when `injuryCheckedIn` is false, it opens the modal and `return`s. The modal's `handleSaveInjury()` sets `injuryCheckedIn = true` and calls `window.location.reload()`. After reload, `next()` hasn't been called.

**Status**: Fixed. `handleSaveInjury()` now calls `next()` directly when `wasAlreadyActive` is true, instead of reloading.

### Bug 2: No visible plan progression despite pain falling

**Root cause**: Phase transitions need enough pain history entries. The check-in modal now calls `evaluatePhaseTransition()` after recording pain.

### Bug 3: Phase labels show continuous-mode names during race plans

**Root cause**: `getPhaseLabel()` boolean flag. Check `isInBlockCyclingPhase(s)` vs `s.continuousMode`.

## Architecture Notes

- `handleSaveInjury()` in modal.ts distinguishes initial report from weekly update via `wasAlreadyActive`
- `openReturnToRunGateModal()` is the gate modal for return_to_run phase
- `openGraduatedReturnCheckIn()` is the new check-in modal for graduated_return phase
- `evaluateReturnToRunGate()` returns progress/hold/regress decisions
- `applyGateDecision()` applies the decision to state
- RPE during injury has zero VDOT impact (imp=0 in events.ts)
- Detraining values are applied in the injury block of `next()`, and the normal progression branch skips overwriting them
