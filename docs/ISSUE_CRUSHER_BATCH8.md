# Issue Crusher — Batch 8 (Plan Page Fixes + Edit Weeks)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH8.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 7 merged (P1 bug fixes).
> **Context**: Plan page edit weeks is a stub, delete buttons missing on adhoc activities, and related plan-page fixes.

---

## MANDATORY READING

Read before writing code:
1. `CLAUDE.md` — Commands, conventions, doc maintenance rules
2. `docs/PRINCIPLES.md` — Signal model (A/B/C), protection hierarchy
3. `docs/OPEN_ISSUES.md` — Current issue state

## RULES

1. **One issue at a time.** Fully fix, test, document, commit before the next.
2. **Don't scope-creep.** Log related bugs in OPEN_ISSUES.md, don't fix them now.
3. **Commit after EVERY issue.** Format: `fix(issue-XX): desc` or `feat(plan): desc`
4. **Update docs**: OPEN_ISSUES.md, CHANGELOG.md, FEATURES.md after every issue.
5. **Quality gates**: `npx tsc --noEmit` + `npx vitest run` before every commit.
6. **Never modify test files to make tests pass.**

---

## 1. Delete button missing on adhoc/unmatched activities (NEW — ISSUE-90)

**Symptom**: Matched activities in the activity log have a × delete button, but adhoc garmin/strava activities (the "Logged" ones) do not. Users cannot remove incorrectly logged or duplicate activities.

**Root cause**: In `plan-view.ts` `buildActivityLog()`, the matched activities section (lines 476-492) includes a `plan-remove-garmin` button at line 489. The adhoc garmin section (lines 496-526) has no such button.

**Fix**:
1. In `buildActivityLog()`, find the adhoc garmin loop (starts at line 496: `for (const w of adhocGarmin)`)
2. Add a × delete button inside the `<div style="display:flex;align-items:center;gap:6px">` block (after the tag badge, before the closing `</div>`)
3. The button needs `class="plan-remove-garmin"` and `data-garmin-id="${escapeHtml(rawId)}"` — the rawId is already computed at line 498 as `(w.id || '').slice('garmin-'.length)`
4. The existing handler at line 2266 (`document.querySelectorAll('.plan-remove-garmin')`) will automatically pick it up — no new handler needed
5. Also check: the `removeGarminActivity()` function in `events.ts:2316` searches `wk.garminMatched` for the garminId. For adhoc activities that were never matched (they went straight to `adhocWorkouts`), the garminId won't be in `garminMatched`. The function needs a fallback: if not found in `garminMatched`, search `wk.adhocWorkouts` for an entry with `id === 'garmin-' + garminId` and remove it directly.

**Verification**: After fix, adhoc "Logged" activities should show a × button. Tapping it should prompt "Remove this activity?" and remove it from state.

**Files**: `src/ui/plan-view.ts` (add button), `src/ui/events.ts` (fix `removeGarminActivity` fallback)

---

## 2. Edit weeks pencil button is a stub (ISSUE-28 — needs real implementation)

**Symptom**: The pencil button (✎) on past weeks shows a bottom sheet that says "Tap a session card to mark it as done or skipped" with just a Close button. It doesn't actually enable editing on the cards. This is a placeholder from the initial implementation.

**Current code**:
- Button rendered at `plan-view.ts:1966` (only shown when `viewWeek < s.w`)
- Handler at `plan-view.ts:2026` creates a bottom sheet with static text + Close button — no actual edit mode

**Design** (confirmed with user):
- Pencil should toggle session cards into an **editable state** for past weeks
- Users should be able to: mark sessions as done (enter RPE), mark as skipped, retroactively
- Watch-synced sessions (with garminActual data) stay read-only — show "Synced from Strava/Garmin" badge
- Changes should **immediately recalculate the fitness model** (CTL/ATL/VDOT from that week forward)
- Show a confirmation: "Changes will recalculate your fitness numbers from this week forward. Continue?" before applying

**Implementation plan**:

### Step 2a: Add edit mode state
- Add a module-level `let _editMode = false;` variable in `plan-view.ts` (similar to `_viewWeek`)
- When pencil is clicked, set `_editMode = true` and re-render

### Step 2b: Modify workout cards for edit mode
- In `buildWorkoutCards()`, when `_editMode === true` AND `viewWeek < s.w`:
  - For non-synced sessions (no garminActual): show action buttons:
    - If not yet rated: show "Done" button (triggers RPE input) + "Skip" button
    - If already rated/skipped: show current status with an "Undo" option
  - For synced sessions: show the existing read-only "Synced from Strava/watch" badge (line 337-342), no edit buttons
- The RPE input can be a simple 1-5 row of buttons (like the existing completion RPE flow)

### Step 2c: Wire up rate/skip for past weeks
- The existing `rate()` function in `events.ts` already handles RPE recording — it writes to `wk.rated[workoutId]`
- The existing `skip()` function marks a workout as skipped
- Both should work on past weeks with no changes needed — they operate on `s.wks[weekIdx]` by ID
- After rate/skip, call `saveState()` and re-render

### Step 2d: Recalculate fitness model on edit
- After any edit to a past week's rated/skip state:
  1. Show confirmation dialog: "This will recalculate your fitness from week N forward. Continue?"
  2. If confirmed, the fitness model already recalculates from `wk.rated` on every render (confirmed in OPEN_ISSUES.md ISSUE-28 notes)
  3. Call `saveState()` → re-render → the new CTL/ATL/VDOT values propagate automatically

### Step 2e: Update the pencil button UI
- When `_editMode` is true: change pencil to a "Done editing" button (e.g. checkmark or "✓ Done")
- Clicking "Done editing" sets `_editMode = false` and re-renders
- Keep the pencil visible on ALL past weeks (user confirmed: don't kill it)

**Files**: `src/ui/plan-view.ts` (main changes), `src/ui/events.ts` (may need to expose `rate`/`skip` for past weeks if they have a current-week guard)

---

## 3. "Finish week" button shows wrong week's debrief

**Symptom**: The "Finish week" button on the current week (plan-view.ts line 1967) calls `showWeekDebrief(curWeek - 1)` — this shows the debrief for the PREVIOUS week, not the current one. It should advance the current week and then show its debrief.

**Current code** (plan-view.ts:2046-2053):
```typescript
document.getElementById('plan-finish-week-btn')?.addEventListener('click', () => {
    const curWeek = (getState() as any).w ?? 1;
    if (curWeek > 1) {
      import('@/ui/week-debrief').then(({ showWeekDebrief }) => {
        showWeekDebrief(curWeek - 1);
      });
    }
  });
```

**Fix**:
1. The "Finish week" button should:
   a. Show the debrief for the CURRENT week (`curWeek`, not `curWeek - 1`)
   b. Then advance the week pointer (call `next()` or increment `s.w++`)
   c. Save state and re-render
2. Alternatively, if the intent is that "Finish week" should trigger `next()` (which does the full week completion flow including s.w++), then wire it to call `next()` and let `next()` handle everything including the debrief trigger.
3. Check: does `next()` already show a debrief? If yes, just wire the button to `next()`. If no, add `showWeekDebrief(s.w)` before `s.w++` inside `next()`.

**Files**: `src/ui/plan-view.ts`, `src/ui/events.ts`

---

## 4. "Complete Week" button gated on all sessions rated — too strict

**Symptom**: The "Complete Week" button (`plan-complete-week-btn`) in `buildPlanActionStrip()` only appears when ALL non-rest sessions have been rated (line 864: `allDone = completedCount >= totalCount`). In practice, users have unrated sessions because activities auto-matched from Garmin but RPE wasn't manually entered. The button never appears.

**Current code** (plan-view.ts:857-868):
```typescript
const rated = wk?.rated ?? {};
const totalCount = workouts.filter((w: any) => w.t !== 'rest').length;
const completedCount = Object.values(rated).filter(v => typeof v === 'number' && v > 0).length;
const allDone = completedCount >= totalCount && totalCount > 0;
if (allDone && !(wk as any)?.weekCompleted) btns.push(...);
```

**Fix**:
1. Count Garmin-matched activities as "done" even without RPE rating. A session is "done" if:
   - It has a numeric RPE rating in `wk.rated`, OR
   - It has a garmin actual match in `wk.garminActuals`
2. Change the `completedCount` logic to include garmin-matched sessions
3. Consider: should the button also appear after the calendar week has passed (i.e. it's now a past week)? If `advanceWeekToToday()` already moved `s.w` past this week, the button won't show because `buildPlanActionStrip` returns '' for non-current weeks. This may need revisiting alongside Fix 2 (edit weeks).

**Files**: `src/ui/plan-view.ts`

---

## 5. Activity log only shows on current week

**Symptom**: The activity log section (garmin actuals, adhoc activities, pending items) may not render for past weeks. Users browsing past weeks should see their activity log.

**Investigation**:
1. Check `buildActivityLog()` — does it filter by `viewWeek === currentWeek` anywhere?
2. The pending banner already gates on `viewWeek === currentWeek` (line 446) which is correct
3. The "Review" button gates on `viewWeek === currentWeek` (line 438) — also correct
4. But check if the function is even CALLED for past weeks in the main render function

**Fix**: Ensure `buildActivityLog()` is called regardless of past/current week. The pending banner and review button already self-gate. The matched/adhoc activity list should show for all weeks.

**Files**: `src/ui/plan-view.ts`

---

## WHEN DONE

1. Run `npx tsc --noEmit` — clean
2. Run `npx vitest run` — all pass
3. Run `npx vite build` — must compile
4. Output summary table with issue, status, commit hash, notes
5. Update OPEN_ISSUES.md with ✅ status for each fixed issue
