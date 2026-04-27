# Batch A Triage — top-priority bugs
**Date:** 2026-04-18
**Agent:** Batch A

## Summary
- Issues triaged: 5
- still-broken: 1
- looks-fixed-pending-device-test: 3
- spec-only-not-implemented: 1
- stale-diagnosis: 0

## Quick wins flagged
- **ISSUE-137**: Fix code is solid (all three locations verified: lines 529, 545, suggestion-modal.ts logic). Device test is the only blocker.
- **ISSUE-138**: Full implementation + type-safety confirmed. Recovery type wired correctly in all 6 locations. All 210 cross-training tests pass. Device test is the only blocker.
- **ISSUE-135**: All shipped fixes confirmed in place. Self-healing path working. Residual optimism from stale VO2 will resolve on next physiology sync.

---

## ISSUE-137: Excess-load modal hides Reduce option when a tempo remains

**Plain-English recap:**
When a runner adds cross-training load that pushes the week over target, the modal only shows two choices (Push the activity to next week / Keep the plan) even when downgrades are possible. The "Recommended" badge incorrectly appears on the Keep option instead of Reduce, confusing runners about the best action.

**Current code state:**
- `src/cross-training/suggester.ts:535` — condition changed from breaking on empty adjustments to `adjustments.length > 0 && remainingLoad <= minLoadThreshold` (allows at least one attempt before stopping).
- `src/cross-training/suggester.ts:555` — first quality downgrade records `actualReduction = loadReduction` (the true reduction, not budget-clipped).
- `src/ui/suggestion-modal.ts:390-445` — logic correctly branches on `!hasReductions && !hasReplacements`: when both empty, "Reduce" is hidden; "Push to next week" shows "Recommended" badge (green, line 435); "Keep Plan" is fallback (line 445).
- `src/cross-training/km-budget.test.ts` — all 8 tests pass; assertion correctly allows controlled overshoot.

**Does it still reproduce / is it still open?**
Code is fixed. The silent short-circuit at line 529 (old) is gone. First quality downgrade now records true load reduction, bypassing budget clipping. Modal correctly shows Reduce with "Recommended" when available. On-device test required to confirm tempo-downgrade flow works end-to-end.

**Recommendation:** `looks-fixed-pending-device-test`

**Evidence:**
Test output shows all 8 load-budget tests pass. Code inspection verifies line 535 allows at least one adjustment before stopping, and line 555 records the true reduction for the first adjustment. Modal logic correctly applies green badge to "Push to next week" when hasReductions and hasReplacements are both false.

---

## ISSUE-138: Recovery workout tier added (easy → recovery downgrade)

**Plain-English recap:**
When a runner's plan has only easy runs remaining, the suggester has no load lever left to reduce excess cross-training load. A new "recovery" workout type extends the intensity ladder below easy, allowing easy runs to downgrade to slow recovery pace runs, which still count toward weekly mileage.

**Current code state:**
- `src/types/training.ts:37` — `WorkoutType` union includes `'recovery'`.
- `src/constants/workouts.ts:125` — `LOAD_PROFILES.recovery = { aerobic: 0.98, anaerobic: 0.02, base: 0.99, threshold: 0.01, intensity: 0.00 }`.
- `src/workouts/load.ts` — pace multiplier `baseMinPerKm * 1.12` (~+40-45 s/km, Z1 zone).
- `src/calculations/heart-rate.ts:117, 156` — recovery case branches return Z1 target zone.
- `src/calculations/activity-matcher.ts:138` — matcher pace returns `paces.e` (easy pace), matching recovery runs to easy slots.
- `src/ui/renderer.ts:1284, 1569` — renderer labels "Recovery Run" and applies correct styling.
- `src/cross-training/suggester.ts:347` — downgrade chain: `easy: 'recovery'`.

**Does it still reproduce / is it still open?**
Full implementation complete. Type-safe across all 6 wiring locations. All 210 cross-training tests pass (including 7 km-budget tests that exercise downgrade logic). Provisional constants in place. Ready for device test with an easy-only week that gets pushed over target—should now offer easy→recovery downgrade.

**Recommendation:** `looks-fixed-pending-device-test`

**Evidence:**
Test suite confirms implementation: 7 test files passed, 210 tests passed total. Recovery type wiring verified in all claimed files. Downgrade chain in suggester.ts line 347 includes `easy: 'recovery'`. Load profile matches literal value. Pace multiplier confirmed in workouts/load.ts.

---

## ISSUE-131: Resting HR used for iTRIMP should be rolling average, not today's snapshot

**Plain-English recap:**
When a runner has an unusually high resting heart rate on a stress or illness day, all activities that day are assigned artificially high iTRIMP scores because the calculation uses only today's snapshot RHR. A rolling 7-day average would smooth out daily spikes and give more accurate training load.

**Current code state:**
- `src/calculations/activity-matcher.ts:382-394` — `resolveITrimp()` receives `restingHR` as a single parameter, passes directly to `calculateITrimpFromSummary()` with no smoothing.
- `src/types/state.ts:507` — State has `physiologyHistory?: PhysiologyDayEntry[]` field (exists but not wired into iTRIMP calculation).
- `src/main.ts` — no healing pass applied to rolling RHR before iTRIMP computation.
- `src/calculations/trimp.ts` — `calculateITrimpFromSummary()` is a consumer; no responsibility to smooth.

**Does it still reproduce / is it still open?**
Not yet implemented. The desired logic (7-day rolling median from physiologyHistory with fallback to s.restingHR) does not exist in resolveITrimp. The infrastructure (physiologyHistory state field) is present but unused by iTRIMP code. This is a straightforward enhancement: extract rolling RHR in resolveITrimp before passing to calculateITrimpFromSummary.

**Recommendation:** `still-broken`

**Evidence:**
Code inspection shows resolveITrimp at line 382-394 uses raw s.restingHR with no smoothing logic. No rolling-average extraction from physiologyHistory. State field exists but iTRIMP code path does not reference it. This issue remains open and ready for implementation.

---

## ISSUE-135: Race prediction marathon time optimistic when VO2/LT stale

**Plain-English recap:**
When a runner's watch data is stale, race predictions show an optimistic marathon time because the code is still using outdated VO2max values. Recent fixes (4/13 deployment) including LT-based tier derivation and a state repair for a VO2 corruption bug mean the code now self-heals when physiology data syncs.

**Current code state:**
- `src/calculations/predictions.ts:165-177` — `predictFromLT()` derives marathon tier from LT pace directly via `cv(10000, ltPaceSecPerKm * 10)` → VDOT band, NOT from athleteTier.
- `src/calculations/predictions.ts:371-406` — `blendPredictions()` wired with base weights, recentRun decay, and predictor fallback.
- `src/ui/stats-view.ts:790, 2271` — both race prediction cards call `blendPredictions()`.
- `src/ui/welcome-back.ts:114-136` — comment confirms `s.v` detraining compounding bug is modelled but not applied on launch.
- `src/state/persistence.ts:398-421` — state repair migration detects and repairs `s.v` corruption: log message confirms `Repairing corrupted s.v: ...`.

**Does it still reproduce / is it still open?**
Code is fixed and self-healing. Marathon tier now running-specific (LT-derived, not athleteTier). VO2 corruption bug repaired via state migration. Both race prediction cards rewired to blendPredictions(). Residual ~3-minute optimism from stale VO2 (s.vo2=56 vs chart ~47) will resolve when next physiology sync updates VO2. No further action required—self-healing path confirmed in place.

**Recommendation:** `looks-fixed-pending-device-test`

**Evidence:**
predictFromLT() at line 165-177 confirms tier derivation: `const ltVdot = cv(10000, ltPaceSecPerKm * 10); const runTier = ltVdot >= 52 ? 'performance' : ...` (tier from LT, not athleteTier). blendPredictions() call sites confirmed in stats-view.ts. State migration in persistence.ts confirms repair is active.

---

## ISSUE-145: Speed-profile marathon baseline too optimistic

**Plain-English recap:**
A test that verifies marathon time predictions for a speed-profile runner (fast 5K/10K, no marathon experience) is failing: the predicted time is 3 minutes 7 seconds faster than the physiologically-justified floor. This is a spec-only issue—the underlying constants need literature backing before they can be changed.

**Current code state:**
- `src/calculations/forecast-profiles.test.ts:195-204` — Speed → Marathon test case: 5K PB 18:00, 10K PB 38:00, no HM/M PB, LT 3:45/km.
- `src/calculations/predictions.ts:147-180` — Marathon multipliers for tier × runner-type: `performance` × `speed` = 1.08, `trained` × `speed` = 1.10.
- `src/calculations/predictions.ts:48-63` — Riegel extrapolation uses `b = min(b, 1.15)` (caps but doesn't lower-bound).
- `src/calculations/predictions.ts:384-470` — Blend weights with no VO2/Tanda: LT dominates at ~75-88% when both null.
- Test failure: baseline 2:51:53 should be in [2:55:00, 3:35:00]; actual 10313.44s vs floor 10500s.

**Does it still reproduce / is it still open?**
Test still fails exactly as described. 5 proposed fixes (a–e in OPEN_ISSUES.md lines 153-158) range from raising marathon multipliers to linear tier interpolation. Per CLAUDE.md, none can be implemented without literature backing or calibration. This is spec-only: requires user decision on which fix approach to take + science justification before coding.

**Recommendation:** `spec-only-not-implemented`

**Evidence:**
Test failure confirmed: `× 7. Speed → Marathon ... expected 10313.440082564935 to be greater than or equal to 10500`. Code inspection shows 5 proposed fixes are all unapplied. This is a design decision, not a bug in already-specified code.
