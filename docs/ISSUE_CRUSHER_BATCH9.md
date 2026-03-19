# Issue Crusher — Batch 9 (Calculations, Units, & UI Logic)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH9.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 8 merged. All 42 TypeScript errors were fixed in a previous session.

---

## MANDATORY READING

Read before writing code:
1. `CLAUDE.md` — Commands, conventions, doc maintenance rules
2. `docs/PRINCIPLES.md` — Signal model (A/B/C), protection hierarchy
3. `docs/OPEN_ISSUES.md` — Current issue state (specifically Priority Order table)
4. `docs/MODEL.md` — Math: VDOT, CTL/ATL, iTRIMP, ACWR, Signal A/B/C (critical for ISSUE-85)

## RULES

1. **One issue at a time.** Fully fix, test, document, commit before the next.
2. **Don't scope-creep.** Log related bugs in OPEN_ISSUES.md, don't fix them now.
3. **Commit after EVERY issue.** Format: `fix(issue-XX): desc`
4. **Update docs**: OPEN_ISSUES.md, CHANGELOG.md, FEATURES.md after every issue.
5. **Quality gates**: `npx tsc --noEmit` + `npx vitest run` before every commit.
6. **Never modify test files to make tests pass.**

---

## CURRENT BATCH

Fix these issues **in this order**. Stop when you've completed all of them or hit 90 minutes.

### 1. ISSUE-88: km/mile unit tag not working (P1)
- **Files**: `src/ui/account-view.ts` (toggle), `src/utils/format.ts` (`formatKm`), plus all call sites in `src/ui/home-view.ts`, `src/ui/stats-view.ts`, `src/ui/activity-detail.ts`.
- **Bug**: The km/mile toggle is in settings and `formatKm` exists, but the UI is still hardcoded with `"km"` strings everywhere. The user preference is ignored.
- **Fix**: 
  1. Retrieve `s.unitPref` (defaults to 'km').
  2. Find hardcoded `"km"` strings in the UI rendering functions.
  3. Replace them with calls to `formatKm(distance, s.unitPref, decimals)`.

### 2. ISSUE-87: Two Load Safety bars on Stats (P2)
- **Files**: `src/ui/stats-view.ts`
- **Bug**: There are two duplicate `Load Safety` bars being rendered in the Recovery card (one around line 1016, another around line 1175).
- **Fix**: Remove the redundant second Load Safety entry that lacks the contextual explanation style. Keep the first one.

### 3. ISSUE-85 & ISSUE-83: CTL 222 (Inflated) and TSS looks wrong (P1 Critical)
- **Files**: `src/calculations/fitness-model.ts` (CTL/ATL EMA computation, `computeWeekTSS`, `computeWeekRawTSS`)
- **Bug**: A user with a 3:12 marathon (Trained/Performance) is showing an "Elite" CTL of 222.
- **Root Cause Hypotheses**:
  1. High cross-training/gym iTRIMP values are driving CTL up without proper normalisation against running.
  2. `CTL_DECAY` (`Math.exp(-7/42)`) might not sufficiently clear out high-volume anomaly weeks.
  3. Signal B (raw TSS) might be bleeding into the Signal A (CTL) calculation path somewhere.
- **Fix**: 
  1. Audit the CTL calculation. Ensure ONLY Signal A (run-specific, runSpec-discounted) load feeds into CTL.
  2. Ensure cross-training load (gym, tennis, etc.) correctly applies the `runSpec` discount before hitting the CTL accumulator.
  3. If the math is functionally correct, consider adjusting the `runSpec` multipliers for heavy-load non-running sports in `src/constants/sports.ts` if they are disproportionately inflating CTL.

### 4. ISSUE-86: Reduce recommendation 32% cut for 2% overshoot is disproportionate (P1)
- **Files**: `src/ui/suggestion-modal.ts` (headline copy + reduction calc)
- **Bug**: The modal headline says "2% above normal load" (which actually means 2% above the 1.6x safety ceiling). However, the recommended cut is fixed/huge (e.g., cutting an 8km run to 5.4km), regardless of how small the overshoot is.
- **Fix**:
  1. Fix the headline copy so it doesn't sound like a "minor 2% volume excess" (e.g., "Load ratio is just above the safe ceiling (1.63 vs 1.60)").
  2. Change the reduction algorithm: the cut distance should be proportional to the target TSS reduction required to bring ACWR back to exactly 1.6x. Do not use a hard-coded fraction. Small overshoot = gentle nudge; large overshoot = significant cut.

### 5. ISSUE-89: Activity load card "93 TSS estimated" confusing (P2)
- **Files**: `src/ui/activity-review.ts` or `src/ui/excess-load-card.ts`
- **Bug**: For activities without HR data, it says "estimated", which erodes trust.
- **Fix**: Keep the label but explain *why*. Change the text to something like "93 TSS (no HR data — based on duration)" so it's clear the estimation is due to missing heart rate information.

---

## WHEN DONE

1. Run `npx tsc --noEmit` — clean
2. Run `npx vitest run` — all pass
3. Run `npx vite build` — must compile
4. Output summary table with issue, status, commit hash, notes
5. Update OPEN_ISSUES.md with ✅ status for each fixed issue
