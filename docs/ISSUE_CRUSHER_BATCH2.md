# Issue Crusher — Batch 2 (Load Calculation + Features)

> **How to use**: After Batch 1 is merged, swap this into `ISSUE_CRUSHER.md`'s CURRENT BATCH section.
> Or run: `claude "Read docs/ISSUE_CRUSHER_BATCH2.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 1 should be complete and merged first.

---

## MANDATORY READING (same as Batch 1)

Read before writing code:
1. `docs/PRINCIPLES.md`
2. `docs/OPEN_ISSUES.md`
3. `docs/MODEL.md`
4. `docs/LOAD_MODEL_PLAN.md` — **required for this batch** (load calculation + Phase 10)
5. `CLAUDE.md`

## RULES

Same rules as `docs/ISSUE_CRUSHER.md`. Read them. Follow them.

---

## CURRENT BATCH

### 1. ISSUE-57 + ISSUE-42: Week load calculation errors
- **Files**: `src/calculations/fitness-model.ts` (computeWeekRawTSS, computeWeekTSS), `src/ui/stats-view.ts`, `src/data/stravaSync.ts`
- **Bug**: Week of 25 Feb shows near-zero load. After one tennis session, stats showed 97/90 TSS but tennis was only 69. Historic load bleeding across week boundaries.
- **Steps**:
  1. Add diagnostic logging to `computeWeekRawTSS` to trace which activities contribute per week
  2. Verify week boundary calculation (check how week start date is computed)
  3. Check if `historicWeeklyTSS` items are indexed off-by-one  
  4. Check if activities from adjacent weeks are leaking via date comparison bugs
  5. Fix the root cause
  6. Remove diagnostic logging before commit

### 2. ISSUE-16: Skipped workouts not pushing to next week in general fitness mode
- **Files**: Search for skip logic in `src/ui/events.ts`, `src/workouts/generator.ts`, `src/ui/plan-view.ts`
- **Bug**: Race mode correctly pushes skipped workouts to next week. General fitness mode doesn't — skipped sessions counted as 0-load completions, tanking VDOT.
- **Fix**: General fitness skip must mirror race mode: skip → push to next week → skip again → user manually drops.
- **Verification**: Check that VDOT is not fed 0-load from skipped sessions.

### 3. ISSUE-48: Cardiac Efficiency Trend fires incorrectly on easy runs
- **Files**: `src/calculations/physiology-tracker.ts` — look for `estimateFromEfficiencyTrend` or similar
- **Bug**: "Slower pace on easy run" interpreted as "declining fitness." Easy runs SHOULD be slower. Algorithm must compare pace:HR ratio, not pace alone.
- **Fix**:
  1. Only use Z2 HR data points
  2. Trend pace:HR ratio, not pace alone
  3. Require >10% ratio change before firing
  4. The −5.0 clamp (ISSUE-14) limits damage but doesn't fix the root cause

### 4. ISSUE-9: Injury risk and Reduce/Replace modal disconnected
- **Files**: `src/ui/home-view.ts` (injury risk card), `src/ui/suggestion-modal.ts`
- **Bug**: "Injury Risk: Low" in one place, scary reduce/replace modal elsewhere. No connection.
- **Fix**: Injury risk card should summarise what drove risk this week and link to reduce/replace action when ACWR is elevated.

### 5. ISSUE-10: Reduce/Replace modal copy too technical
- **Files**: `src/ui/suggestion-modal.ts`
- **Bug**: "70% aero / 30% anaero", "Balanced runner" — jargon.
- **Fix**: Lead with human consequence. "This session is as taxing as a 25km run. Your body needs recovery before your next hard effort." Save numbers for secondary detail.

### 6. ISSUE-31: KM/Mile toggle
- **Files**: `src/ui/account-view.ts` (settings), `src/types/state.ts`, all distance display points
- **Build**:
  1. Add `unitPref: 'km' | 'mi'` to `SimulatorState` (default 'km')
  2. Add toggle in Account/Settings view
  3. Create `formatDistance(km: number, pref: UnitPref): string` utility
  4. Replace hardcoded km displays across the app

### 7. ISSUE-32: Training phases not visible in plan
- **Files**: `src/ui/plan-view.ts`
- **Bug**: Phase labels (base, build, peak, taper) used to be visible, now hard to find.
- **Fix**: Restore phase label in plan week headers. User should always know which phase they're in.

### 8. ISSUE-26 + ISSUE-45: Total load on plan page as bar
- **Files**: `src/ui/plan-view.ts`, `src/ui/home-view.ts` (for bar component reference)
- **Bug**: Plan page doesn't show week's total TSS. ISSUE-45: should be a bar, not text.
- **Fix**: Add visual bar (same style as home page) showing planned TSS, actual TSS to date, % complete.

### 9. ISSUE-27: Sync Strava button on wrong page
- **Files**: `src/ui/plan-view.ts`, `src/ui/account-view.ts`
- **Bug**: Sync Strava appears on plan page. Doesn't belong there.
- **Fix**: Move to Account/Settings. Remove from plan page.

---

## WHEN DONE

Same as Batch 1: run quality gates, output summary table, explain any blocked issues.
