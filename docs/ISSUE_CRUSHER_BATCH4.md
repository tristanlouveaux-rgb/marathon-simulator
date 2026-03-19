# Issue Crusher — Batch 4 (Copy Cleanup, Historic Weeks, Race Forecast, Recovery)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH4.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 3.2 merged. All P1 bugs resolved.
> **Context**: Clearing the remaining non-UX open issues. Mix of copy audit, historic week editing,
> race time forecast, and laying the groundwork for the Recovery section.

---

## MANDATORY READING

1. `docs/OPEN_ISSUES.md` — current issue list (reference for acceptance criteria)
2. `src/ui/plan-view.ts` — historic week rendering (issues 28, 40, 43)
3. `src/ui/home-view.ts` — sleep card removal (issue 58)
4. `src/ui/stats-view.ts` — race forecast dropdown (issues 44, 62)

## RULES

1. **No jargon in user-facing copy.** CTL, ATL, TSB, ACWR, iTRIMP never appear in UI strings.
2. **No auto-navigation.** Never redirect the user without an explicit tap.
3. **Read-only guard on Strava-matched sessions.** If a workout has a `garminActuals` entry, it cannot be re-rated by the user — the data came from the watch.
4. Quality gates: `npx tsc --noEmit` + `npx vitest run` before every commit.
5. Update `docs/CHANGELOG.md` and `docs/FEATURES.md` when done.

---

## GROUP A — Copy Audit (ISSUE-21)

**Goal**: Audit and rewrite the most obviously AI/generic copy strings. Focus on labels that feel automated, impersonal, or jargon-heavy. Do NOT touch logic — copy changes only.

### ISSUE A-1 — "Recovery:" labels in main-view.ts

**File**: `src/ui/main-view.ts`

**Find and replace** these strings:
- `Recovery: Log today` → `Log how you're feeling`
- `Recovery: Good` → `Feeling good`
- `Recovery: Low — Tap to adjust` → `Feeling tired — tap to ease today`

Search for the `Recovery:` prefix pattern. Do not change variable names or logic — only the string literals passed to the DOM.

---

### ISSUE A-2 — "Today's planned run" label in plan-view.ts

**File**: `src/ui/plan-view.ts`

**Find**: `Today's planned run`
**Replace**: `Today` (the day label above already contextualises it)

Also find any `🏃` emoji next to this label and remove it. Keep emoji inside activity type icons (e.g. in `formatActivityType`) — only remove it from the plan header card.

---

### ISSUE A-3 — Bullet-point copy in welcome-back.ts

**File**: `src/ui/welcome-back.ts`

The welcome-back modal uses `•` bullet points that read like auto-generated tips. Rewrite in plain, direct language without bullets. Example rewrites:

- `• Light detraining effect — your fitness is largely preserved` → `Your fitness is largely intact.`
- `• Plan continues from today's week, no structural changes` → `Pick up where you left off.`
- `• Moderate detraining detected` → `You've lost a little fitness — nothing serious.`
- `• Keep early sessions comfortable to ease back in` → `Keep the first session easy.`
- `• Plan jumps to today's week` → (can be removed — already implied)
- `• Aerobic base has reduced — intensity targets are for reference only` → `Your aerobic base has dipped. Use pace targets as a guide, not a rule.`
- `• This week is treated as a return / base week (reduced volume)` → `This week's volume is reduced to ease you back in.`
- `• Run by feel; don't chase pace targets` → `Run by feel — don't worry about pace.`

Rewrite as `<p>` sentences instead of bullet items. Remove the `bullets.map()` pattern if it exists; output sentences directly in the modal body.

---

### ISSUE A-4 — "Based on your personal bests" in wizard

**File**: `src/ui/wizard/steps/runner-type.ts`

**Find**: `Based on your personal bests, we've assessed your running style.`
**Replace**: `Here's how your times translate to a running profile.`

Scan for any other wizard copy that leads with "Based on your..." or "We've analysed..." and rewrite in second-person direct voice.

---

## GROUP B — Historic Week Editing (ISSUE-28 + ISSUE-40)

**Goal**: Allow users to retroactively mark past week sessions as completed (with RPE) or skipped. Fitness model already recalculates from `wk.rated` on every render — no extra step needed.

### ISSUE B-1 — Understand the read-only gate

**File**: `src/ui/plan-view.ts`

Before making changes, read the section that renders past week workout cards. Find where the current week (`s.w`) is used to decide whether workout cards are interactive. The gate is likely a condition like `weekIdx < s.w - 1` or `isPastWeek`.

Map out: what exactly becomes non-interactive in past weeks? Buttons? The whole card? The rating input?

---

### ISSUE B-2 — Move the ✎ button to past weeks (ISSUE-40)

**File**: `src/ui/plan-view.ts`

Currently the ✎ (edit) button appears in the **current week** header. This is wrong — the current week is already editable natively. The pencil should appear on **past week** headers only.

1. Remove the ✎ button from the current week header render.
2. Add it to the past week header render. Past weeks = any `weekIdx < s.w - 1` when browsing with the week navigator.
3. Tapping ✎ on a past week should unlock that week's cards for rating/skipping. Store the unlocked weekIdx in a local variable (no state needed — it resets on re-render).

---

### ISSUE B-3 — Unlock past week cards for retroactive editing

**File**: `src/ui/plan-view.ts`

When a past week is in "edit mode" (user tapped ✎):

1. **Sessions without a `garminActuals` entry** — render a compact inline RPE picker (1–10) or a "Mark skipped" button. On confirm, write `wk.rated[workoutId] = rpe` (or -1 for skipped) and call `saveState()` + `render()`.

2. **Sessions WITH a `garminActuals` entry** — render as read-only with a small label: `"Synced from watch — can't edit"`. Do not allow re-rating.

3. **Already-rated sessions** — show the existing RPE with a small "Edit" link that re-opens the picker.

Keep the UI minimal — a bottom sheet or inline picker, not a full modal. The goal is correcting data, not a rich editing experience.

---

### ISSUE B-4 — Historic week shows planned layout, not actual days (ISSUE-43)

**File**: `src/ui/plan-view.ts`

**Symptom**: Past weeks render sessions on their *planned* day of week, not the day they were actually performed.

**Fix**: For weeks where `weekIdx < s.w - 1` (completed past weeks):
- If a session has a `garminActuals` entry, extract the actual date from `garminActuals[workoutId].startTime` and render it under the actual day-of-week.
- If no `garminActuals` entry exists (session was manually rated or skipped), keep the planned day.

Implementation note: `new Date(startTime).getDay()` gives you the JS day (0=Sun). Convert to Mon-based index with `(jsDay + 6) % 7`. You may need to reorder the rendered cards by actual day when in past-week view.

---

## GROUP C — Race Time Forecast (ISSUE-62 + ISSUE-44)

**Goal**: Show projected race times (5k, 10k, half, marathon) as a collapsible section on the Stats page. Informational only — no plan changes. Only show after ≥4 weeks of Strava data.

### ISSUE C-1 — Race forecast section in stats-view.ts

**File**: `src/ui/stats-view.ts`

**Placement**: Add a collapsible card below the VDOT sparkline section, titled **"Forecast times"**.

**Data source**: Use `s.v` (current VDOT). The VDOT-to-pace conversion already exists in `src/calculations/paces.ts` — use `gp(vdot, lt)` or equivalent to derive pace at each distance.

**Gate**: Only render if `(s.historicWeeklyTSS?.length ?? 0) >= 4`. Below that threshold, don't show the section at all.

**Distances to show**: 5k, 10k, half marathon, marathon (and optionally the user's target race distance if set).

**Format** (collapsed by default, `<details>` element):
```
Forecast times  ▸

5K        22:14
10K       46:01
Half      1:41:30
Marathon  3:31:45
```

Use `formatTime(totalSeconds)` helper if it exists, or write a simple `hh:mm:ss` formatter inline.

**No race-mode references.** This appears in general fitness mode too. Copy: "Based on your current fitness score." No CTL/VDOT jargon exposed.

---

## GROUP D — Recovery Section Foundation (ISSUE-58)

**Goal**: Remove the sleep card from Home. Lay the groundwork for a dedicated Recovery section. First session focuses on removal + investigation; full Recovery view is a separate session.

### ISSUE D-1 — Remove sleep card from Home

**File**: `src/ui/home-view.ts`

Find the sleep/recovery card render in `home-view.ts`. Remove it from the Home tab render entirely. The card should not appear on the main training view.

If the sleep card HTML is in a separate function (e.g. `buildSleepCard()` or `buildRecoveryCard()`), just stop calling it — do not delete the function itself, as it will move to the Recovery view later.

---

### ISSUE D-2 — Investigate recovery data pipeline

After removing the card, log what data is actually available:

1. Is `s.sleepScore` populated with real data? Check `src/data/physiologySync.ts` — does it call a Garmin sleep edge function?
2. Is there a `sync-physiology-snapshot` edge function? Read `supabase/functions/sync-physiology-snapshot/index.ts` and check what fields it returns.
3. Document findings in a comment block at the top of the new recovery section (or in OPEN_ISSUES.md under ISSUE-58).

**Output**: A brief note in OPEN_ISSUES.md under ISSUE-58 confirming: "Sleep data is live / Sleep data is not flowing — build RPE check-in first."

---

### ISSUE D-3 — Add "Recovery" section stub to Stats or as a new tab

**Scope**: Minimal stub only. Create a visible entry point for the Recovery section so it's not lost.

**Option A** (preferred if tab count allows): Add a "Recovery" tab to the bottom nav. For now it shows: sleep score (if live), a placeholder "Log RPE" button (not wired), and injury flag (not wired). Label: "Recovery".

**Option B** (fallback): Add a collapsible "Recovery" card at the bottom of the Home tab. Same content as above.

Ask yourself: how many tabs exist in the bottom nav? If ≥5, use Option B. If ≤4, use Option A.

Do NOT build the full RPE logging flow in this session — that's ISSUE-34 and a separate build. Just create the skeleton so Recovery has a home in the app.

---

## WHEN DONE

1. `npx tsc --noEmit` — zero errors
2. `npx vitest run` — all pass
3. `npx vite build` — clean build
4. Summary table:

| Issue | Status | Notes |
|---|---|---|
| ISSUE-21 (copy) | ✅/⚠️ | List any copy you couldn't find/change |
| ISSUE-28 (edit historic) | ✅/⚠️ | Note if any edge cases deferred |
| ISSUE-40 (edit button) | ✅ | |
| ISSUE-43 (actual days) | ✅/⚠️ | |
| ISSUE-44 + ISSUE-62 (race forecast) | ✅ | |
| ISSUE-58 (sleep card removed) | ✅ | Note data pipeline finding |

Update `docs/OPEN_ISSUES.md` to mark resolved issues ✅. Update `docs/CHANGELOG.md` with a 2026-03-08 entry.
