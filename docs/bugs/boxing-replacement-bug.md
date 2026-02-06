# BUG REPORT — ACTIVITY LOGGING CAUSES UNINTENDED PLAN MUTATION

## Context
- App: Marathon Simulator
- Feature: Activity logging / cross-training equivalence
- Page: Plan / Dashboard
- Date: 2026-02-03 ~21:19 JST

## Repro Steps
1. Log a new activity:
   - Sport: Boxing
   - Duration: 60 minutes
   - RPE: 5
2. System computes equivalence (~2.4km easy run).
3. UI displays “View changes (3)”.
4. User clicks “View changes”.

## Observed Behaviour
- “View changes” does nothing (no preview shown).
- System automatically:
  - Marks 4 workouts as completed or replaced
  - Replaces cycling workouts (which should never be replaced by boxing)
  - Marks 2 workouts as “replaced by boxing”
  - Marks 2 workouts as “done”
- Distance replaced shows 0km despite replacements.
- User never explicitly confirmed applying changes.

## Expected Behaviour
- Logging an activity should:
  - Create an activity record only
  - Compute proposed plan adjustments
  - Never mutate plan state without explicit confirmation
- Cycling workouts must never be replaced by boxing.
- “View changes” must open a preview and do nothing else.
- No workouts should be auto-completed or replaced.

## Severity
Critical — silent plan corruption.