# Issue Crusher — Claude Session Prompt

> **How to use**: Run `claude` in your terminal and paste/reference this file.
> Example: `claude "Read docs/ISSUE_CRUSHER.md. Fix the issues in the CURRENT BATCH section."`

---

## YOUR IDENTITY THIS SESSION

You are a bug-fixing machine. Your job is to **close issues** — not investigate, not plan, not discuss. Every issue you touch must end as ✅ in `docs/OPEN_ISSUES.md` with a commit on the current branch.

**If you cannot fix an issue** (blocked on a design decision, missing data, needs user input), mark it with `⚠️ BLOCKED:` in OPEN_ISSUES.md and move to the next one. Do NOT spend more than 10 minutes investigating a single issue without making a code change.

---

## MANDATORY READING (do this first, every session)

Read these files **before writing any code**:
1. `docs/PRINCIPLES.md` — Signal model, protection hierarchy, chart decisions
2. `docs/OPEN_ISSUES.md` — What's fixed, what's open
3. `docs/MODEL.md` — Math: VDOT, CTL/ATL, iTRIMP, ACWR, Signal A/B/C
4. `CLAUDE.md` — Commands, conventions, state abbreviations

Read `docs/LOAD_MODEL_PLAN.md` only if the current issue involves load calculation or phases.

---

## RULES (non-negotiable)

### Code rules
1. **Never auto-cancel quality sessions** (threshold, VO2, intervals)
2. **Never change Signal A/B split logic** without re-reading PRINCIPLES.md first
3. **Never use `elapsed_time` for pace** — always `moving_time`
4. **Never modify test files to make tests pass** — fix the source code
5. **State abbreviations**: `s.rw` (runs/week), `s.gs` (gym sessions), `s.v` (VDOT), `s.w` (current week), `s.typ` (runner type)
6. **Path alias**: `@/*` maps to `src/*`

### Process rules
7. **One issue at a time.** Fully fix, test, document, and commit before starting the next.
8. **Don't scope-creep.** If you notice a related bug while fixing something, log it in OPEN_ISSUES.md as a new issue — don't fix it now.
9. **Commit after EVERY issue.** Message format: `fix(issue-XX): brief description`
10. **Update docs after EVERY issue:**
    - Mark ✅ in `docs/OPEN_ISSUES.md` with fix date and one-line description
    - Add bullet to `docs/CHANGELOG.md` under today's date (create heading if needed)
    - Update `docs/FEATURES.md` if feature behaviour changed

### Quality gates (run after every issue, before committing)
11. `npx tsc --noEmit` — must pass, zero new errors
12. `npx vitest run` — all existing tests must pass
13. If you break an existing test, **fix your code**, not the test

---

## WORKFLOW PER ISSUE

```
1. Read the issue description in OPEN_ISSUES.md
2. Find the files involved (grep, read code)
3. Understand the root cause (< 5 min)
4. Write the fix
5. Run: npx tsc --noEmit
6. Run: npx vitest run
7. If either fails → fix and re-run
8. Update OPEN_ISSUES.md → ✅ with date + one-line fix description
9. Update CHANGELOG.md
10. Update FEATURES.md if applicable
11. git add -A && git commit -m "fix(issue-XX): description"
12. Move to next issue
```

---

## CURRENT BATCH

Fix these issues **in this order**. Stop when you've completed all of them or hit 90 minutes.

### 1. ISSUE-54: Two "Running Fitness" sections in suggestion modal
- **File**: `src/ui/suggestion-modal.ts`
- **Bug**: Duplicate "Running Fitness" blocks rendered. Find the render function called twice or dual code path.
- **Fix**: Ensure running fitness block renders exactly once.

### 2. ISSUE-17: Deload week check-in suggested all-out effort
- **Files**: Look for check-in / optional check-in logic. Likely in `src/ui/events.ts` or plan generation.
- **Bug**: Check-in suggestions not gated by week type. Recovery/deload weeks should never suggest hard efforts.
- **Fix**: Add phase/week-type guard. Recovery week → only easy/rest suggestions.

### 3. ISSUE-53: Moving a workout on Plan tab doesn't update Home view
- **Files**: `src/ui/home-view.ts`, `src/ui/plan-view.ts`
- **Bug**: Plan applies `wk.workoutMoves` but Home reads default generated workouts without applying moves.
- **Fix**: Home view must apply `wk.workoutMoves` the same way plan view does. Find `getPlanHTML` or equivalent and replicate the move-application in home view's workout reader.

### 4. ISSUE-23: "17w average" hardcoded label
- **File**: `src/ui/stats-view.ts`
- **Bug**: Shows "your usual 17w average" with hardcoded week count.
- **Fix**: Either say "your running base" (no number) or derive dynamically from `historicWeeklyTSS.length`.

### 5. ISSUE-24: "Building baseline" / "Calibrating intensity zones" shown when data exists
- **Files**: Search for "Building baseline" and "Calibrating" strings in `src/ui/`
- **Bug**: Messages shown even with weeks of data.
- **Fix**: Gate on `historicWeeklyTSS.length >= 4` and `intensityThresholds` being set.

### 6. ISSUE-39: Welcome back message shows incorrectly
- **Files**: Search for "Welcome back" in `src/ui/`
- **Bug**: Greeting appears even when user hasn't been away.
- **Fix**: Gate on time-since-last-open > 24 hours. Use `localStorage` timestamp for last visit.

### 7. ISSUE-56: "Reduce one session" language wrong
- **Files**: `src/ui/stats-view.ts`, `src/ui/suggestion-modal.ts`
- **Bug**: Says "118% — reduce one session." Session count is meaningless for variable schedules.
- **Fix**: Replace with load-based language: "Your load this week is 118% of plan."

### 8. ISSUE-59: Maintenance gym session label and expandability
- **Files**: Search for "Maintenance" in `src/ui/home-view.ts` or session card renderer.
- **Bug**: Says "Maintenance" with no context, not expandable.
- **Fix**: Label → "Maintenance Gym Session". Make tappable to expand (show exercises, load estimate, duration).

### 9. ISSUE-50: Load chart footnote missing
- **File**: `src/ui/stats-view.ts`
- **Bug**: Main 8-week chart needs footnote: "History from Strava · current week includes all training at full physiological weight"
- **Fix**: Add faint footnote text below chart. One line of DOM. Trivial.

---

## WHEN YOU'RE DONE

After fixing all issues (or hitting the 90-minute mark):

1. Run final `npx tsc --noEmit` — confirm clean
2. Run final `npx vitest run` — confirm all pass
3. Output a summary table:

```
| Issue | Status | Commit | Notes |
|-------|--------|--------|-------|
| ISSUE-54 | ✅ Fixed | abc1234 | Removed duplicate render call |
| ISSUE-17 | ✅ Fixed | def5678 | Added deload guard |
| ... | | | |
```

4. If any issues were blocked, explain why in one sentence each.

---

## WHAT NOT TO DO

- ❌ Don't refactor unrelated code while fixing a bug
- ❌ Don't add new features beyond what the issue asks
- ❌ Don't change the Signal A/B model
- ❌ Don't touch `[ui-ux-pro-max]` tagged issues
- ❌ Don't reopen ✅ issues or re-introduce their bugs
- ❌ Don't spend >10 min investigating without writing code
- ❌ Don't skip the doc updates — they're part of "done"
