Note: we have had a persistence problem of open issues not being correctly logged after long conversations. Going forward can we make it clear with answers to all questions put in here in order to most clearly reflect desired set up
# Open Issues

> **Workflow**: Tristan logs raw bugs/observations in `.claude/TL thoughts`.
> Claude reads that file, triages, and maintains this structured list.
> P1 = broken or actively misleading · P2 = confusing/unclear · P3 = missing feature/future
> **UX overhaul items** are tagged `[ui-ux-pro-max]` — handled via that skill in a dedicated session.

---

## P1 — Bugs (broken or actively misleading)

### ✅ ISSUE-01: Stats chart current week near-zero despite high total TSS *(fixed 2026-03-04)*
Removed `garmin-` filter from `computeWeekRawTSS` (Signal B) in `fitness-model.ts`.
Signal A (`computeWeekTSS`) retains the filter — correct. Added `w.rpe ?? w.r ?? 5` fallback.

---

### ✅ ISSUE-02: CTL range card uses wrong scale *(fixed 2026-03-04)*
Replaced broken bar (max 120) with 5-pill Garmin-style tier row in `stats-view.ts`.
Tiers: Beginner 0–50 / Recreational 50–100 / Trained 100–150 / Performance 150–200 / Elite 200+.
Active tier highlighted. Plain-language sentence below. Sparkline Y-axis now zooms to actual range.

---

### ✅ ISSUE-03: ⓘ info buttons don't work on iOS *(fixed 2026-03-04)*
Added `touchstart` listeners (with `preventDefault`) alongside `click` in `stats-view.ts`.
All ⓘ buttons now have 44×44pt touch targets enforced via inline style.

---

### ✅ ISSUE-04: Injury Risk shows red bar but label says "Low" *(fixed 2026-03-04)*
Bar now uses solid colour matching status label (`home-view.ts`, `stats-view.ts`). Verify on device.

---

### ✅ ISSUE-05: "This Week" card shows -74% on Tuesday *(fixed 2026-03-04)*
Baseline now prorated by day of week in `stats-view.ts`. Sub-label reads "Wednesday · week in progress".
Sat/Sun uses full baseline. -74% on Tuesday is gone.

---

### ✅ ISSUE-13: Strava pace doesn't match app *(fixed 2026-03-04)*
Root cause: `elapsed_time` used for pace instead of `moving_time` (excludes pauses).
Fixed in all three sync loops in `sync-strava-activities/index.ts`. `duration_sec` kept as
`elapsed_time` for iTRIMP (correct — total physiological time). Requires edge function redeploy.

---

### ✅ ISSUE-14: VDOT declining sharply *(fixed 2026-03-04)*
**Root cause**: Cardiac Efficiency Trend estimator (fires on week advance) computed a slower LT
from recent easy runs with declining cardiac efficiency, setting `physioAdj` negative.
Compounded by Garmin LT sync writing stale `lt_pace_sec_km` unconditionally.
**Fixes**: `physioAdj` clamped to −5.0 max. Garmin LT rejected if derived VDOT is >8pts from `s.v`.
**Note**: Existing `physioAdj` value not auto-reset — may need manual recalibration button (ISSUE-46).

---

### ✅ ISSUE-15: Session count shows wrong denominator *(fixed 2026-03-04)*
Denominator now calls `generateWeekWorkouts()` and counts all non-rest sessions including
general sport placeholders and adhoc additions. Fixed in `home-view.ts`.

---

### ISSUE-16: Skipped workouts — general fitness mode not pushing to next week
**Confirmed design**:
- Race/marathon mode: skip → pushed to next week → skip again → drops + impacts predicted time. ✅ Already built.
- General fitness mode: MUST match — skip → pushed to next week → skip again → user manually drops.
- Currently general fitness may not do this, which is likely causing VDOT to decline (skipped sessions counted as 0-load completions).

**Fix**: Audit general fitness skip logic and align with race mode behaviour.
**Suspected VDOT link**: If skipped sessions feed into VDOT as bad runs, this would explain the ~5% decline.

---

### ✅ ISSUE-17: Deload week check-in suggested all-out effort *(fixed 2026-03-05)*
**Root cause**: `renderBenchmarkPanel` / `buildBenchmarkPanel` showed hard check-in options (threshold, speed, race sim) without gating on week type.
**Fix**: Added `isDeloadWeek` check in both `main-view.ts` and `plan-view.ts`. Benchmark panel now returns '' entirely on deload weeks — no check-in prompt shown.

---

## P1 — Bugs (broken or actively misleading)

### ISSUE-53: Moving a workout on the Plan tab does not update the Home view
**Symptom**: Drag-and-drop reordering on the Plan tab updates `wk.workoutMoves` and re-renders the plan, but the Home tab still shows the workout at its original scheduled day. Today's session card and the day timeline on Home are not recalculated on re-render after a move.
**Root cause**: Home view reads the default generated workouts without applying `wk.workoutMoves`. The plan view applies moves during `getPlanHTML` but Home view (`buildTodayCard` / equivalent) does not.
**Priority**: P1 — confusing when user reschedules today's session and home still shows the old one.

---

### ✅ ISSUE-54: Two "Running Fitness" sections in suggestion modal *(fixed 2026-03-05)*
**Root cause**: Resolved during 2026-03-04 jargon cleanup — runner type boilerplate and aero/anaero split sections (which included "Running Fitness" context) were removed from the modal. Current `suggestion-modal.ts` contains no duplicate "Running Fitness" block.

---

### ✅ ISSUE-55: Injury risk mismatch — elevated on Stats, Low on Home *(fixed 2026-03-04)*
**Root cause**: `buildSignalBars` in `home-view.ts` called `computeACWR` without `atlSeed`, while `buildAdvancedSection` in `stats-view.ts` inflated ATL seed by `1 + min(0.1 × gymSessions, 0.3)`. Result: gym-heavy athletes saw different ACWR values on Home vs Stats.
**Fix**: Added identical `atlSeed` calculation to `buildSignalBars` in `home-view.ts`. Both views now call `computeACWR` with the same arguments.

---

### ISSUE-57: Week of 25 Feb still shows near-zero load *(logged 2026-03-04)*
**Symptom**: After fixes to ISSUE-01 and ISSUE-42, the week of 25 Feb still shows almost no load in the chart. Activities from that week appear to not be contributing to the TSS total.
**Root cause**: May be the same root cause as ISSUE-42 (historic load bleeding in wrong direction, or activities not being matched to the correct week). Or the week predates the `historicWeeklyTSS` calculation window. Needs investigation.
**Related**: ISSUE-42 (TSS 97/90 confusion). Both suggest load calculation has systematic errors for certain weeks.
**Fix**: Add diagnostic logging to `computeWeekRawTSS` to trace which activities are included per week. Verify week boundary calculation.
**Priority**: P1 — misleading chart, makes recent history look inactive.

---

## P2 — UX / Clarity (confusing but not technically broken)

### ISSUE-06: Plan-view TSS badge → weekly summary card `[ui-ux-pro-max]`
**Symptom**: "59 Run · 334 Total" chip in week header — users don't know what it means.

**Design**: Replace with a collapsible post-week debrief card. Show Signal A vs Signal B,
a plain-language sentence ("Heavy cross-training week — running fitness contribution was low"),
and ACWR impact going into next week.

---

### ISSUE-07: Running Fitness sparkline flat with no ranges `[ui-ux-pro-max]`
**Symptom**: Line is flat near top. CTL 182 ↓ with no context about what 182 means.

**Fix**: Zoom Y-axis to actual variation range. Add tier bands as background colours.
Show "Performance level" prominently. Add trend context: "+7 pts in 4 weeks."

---

### ISSUE-08: Training Load vs Plan bar unlabelled `[ui-ux-pro-max]`
**Symptom**: Green and orange bar with no legend or numbers. User can't interpret it.

**Fix**: Add "X / Y TSS" label, explain green (on track) vs orange (above target),
add a plain-language sentence.

---

### ISSUE-09: Injury risk and Reduce/Replace modal are disconnected
**Symptom**: User sees "Injury Risk: Low" in one place but a scary reduce/replace modal elsewhere.
No connection between the two.

**Fix**: Injury risk card should summarise what drove the risk this week (per-session contribution)
and link directly to the reduce/replace action when ACWR is elevated.

---

### ISSUE-10: Reduce/Replace modal copy is too technical
**Symptom**: "70% aero / 30% anaero", "Balanced runner · Balanced volume/intensity reduction" —
jargon without context.

**Fix**: Lead with the human consequence. "This session is as taxing as a 25km run.
Your body needs recovery before your next hard effort." Save the numbers for secondary detail.

---

### ✅ ISSUE-18: "Hyrox" in user-facing copy *(fixed 2026-03-04)*
Replaced with "heavy load sports" in `stats-view.ts`. Sport-type constants left unchanged.

---

### ISSUE-19: Home page load bars confusing `[ui-ux-pro-max]`
**Symptom**: The bar charts on the home page "make no sense." No labels, no reference, no scale.

**Fix**: Either properly label them (what does each bar represent? what's the y-axis unit?)
or replace with a simpler signal (e.g. a single "training load this week" number with colour coding).

---

### ISSUE-20: Activity card UX — maps, HR zones, KM splits all broken or ugly
**Symptom**:
- Maps too zoomed out, not matched to Strava zoom level
- HR zones displayed in confusing format
- KM splits are "lumpy bars" that don't read well
- Planned vs actual — should this just be TSS?

**Fix** `[ui-ux-pro-max]`: Redesign the activity detail card. Maps should zoom to the actual
route bounding box. HR zones as a horizontal stacked bar (not separate bars). KM splits as
a clean pace-per-km chart. Planned vs actual: show both TSS and a pace comparison.

---

### ISSUE-21: AI-sounding copy throughout the app
**Symptom**: Generic text like "Recovery: Low", bullet-point suggestions that feel auto-generated,
"Today's planned run" with emoji — doesn't feel human.

**Fix**: Audit all dynamic copy strings. Rewrite in a direct, personal voice. Remove unnecessary
labels and emoji from data cards.

---

### ✅ ISSUE-22: Sync jumps to home; no feedback *(fixed 2026-03-04)*
Button now shows "Syncing..." (disabled), then "Synced ✓" for 2.5s on success or "Sync failed"
on error. Does not auto-navigate. Fixed in `plan-view.ts`.

---

### ISSUE-23: "17w average" hardcoded label bug *(decision resolved 2026-03-04)*
**Decision**: 8W / 16W / Full tabs stay as-is. "Full" is correct — history will grow beyond 16W as the user keeps using the app. "Full" rename stands.
**Remaining fix**: Stats bars show "your usual 17w average" — hardcoded week count is wrong. Should say "your running base" or derive dynamically from actual history length.
**File**: `stats-view.ts`

---

### ISSUE-24: "Building baseline" / "Calibrating intensity zones" shown when data exists
**Symptom**: App shows baseline/calibration messages even when weeks of Strava data is available.

**Fix**: Gate these messages on actual data absence. If `historicWeeklyTSS.length >= 4`
and `intensityThresholds` are set, never show these placeholder messages.

---

### ✅ ISSUE-25: Missing "Go to current week" button *(fixed 2026-03-04)*
"→ This week" button added to `plan-view.ts`, visible when browsing past weeks. Hides on current week.
"Review this week" still pending — connected to ISSUE-06 post-week debrief card.

---

### ISSUE-26: Total load for the week not visible on Plan page
**Symptom**: Plan page doesn't show the week's total TSS or load anywhere prominent.

**Fix**: Add a week-level load summary — either in the header or as a card above sessions.
Should show planned TSS, actual TSS to date, and % complete.

---

### ISSUE-27: Sync Strava button on Plan page — wrong location
**Symptom**: Sync Strava appears in plan mode. Doesn't belong there — it's a data action,
not a planning action.

**Fix**: Move to Account/Profile tab or a persistent settings area. Remove from plan page.

---

### ISSUE-28: Cannot edit historic weeks
**Symptom**: Past weeks are read-only. User can't correct a missed session or adjust load retroactively.

**Fix needed**: Define what "editing" a past week means. At minimum, allow marking a session
as completed/skipped retroactively and re-running load calculations for that week.

---

### ✅ ISSUE-29: VDOT not tracked over time and poorly explained *(fixed 2026-03-04)*
`vdotHistory` added to state. Sparkline + change note + ⓘ explanation added to stats-view.ts.

---

### ✅ ISSUE-46: VDOT physioAdj reset button *(fixed 2026-03-04)*
"Reset VDOT calibration" button added to Advanced card in `account-view.ts`.
Sets `physioAdj = 0`, saves state, shows 3s confirmation. Real fix is ISSUE-48.

---

### ISSUE-47: What-if sandbox / training scenario simulator *(scoped, ready to build)*
**Confirmed design:**
- Entry: dedicated "Sandbox" tab opened from Stats page
- Read-only: never touches the real plan
- Real-time recomputation as sliders change

**Toggleable inputs (5 sliders/controls):**
1. Weekly km — volume modifier
2. Pace — faster/slower than plan (% modifier)
3. Perceived difficulty — RPE slider (1–10)
4. HR above/below expected — affects efficiency/VDOT estimation
5. Weeks until race

**Outputs that update in real time:** projected race time, VDOT trajectory, CTL/fitness curve, injury risk (ACWR).
**Architecture**: New `src/ui/sandbox-view.ts`. Read-only sim copy of state, "Reset to current plan" button.

---

### ISSUE-48: Cardiac Efficiency Trend algorithm fires incorrectly on easy runs
**Root cause**: Algorithm reads "slower pace on easy run" as "declining fitness" without normalising for HR.
Easy runs SHOULD be slower. Must compare pace:HR ratio, not pace alone.
6:00/km at 125bpm = better efficiency than 5:30/km at 140bpm — current code may get this backwards.
**Current damage**: A recovery week with chill easy runs can tank VDOT 2+ points.
**Fix needed**: Rewrite `estimateFromEfficiencyTrend()` to:
1. Only use Z2 HR data points
2. Trend pace:HR ratio, not pace alone
3. Require >10% ratio change for statistical significance before firing
4. Use detailed HR stream data when available (connects to ISSUE-41)
The −5.0 clamp (ISSUE-14) limits damage but doesn't fix the algorithm.

---

### ✅ ISSUE-49: docs/MODEL.md *(written 2026-03-04)*
See `docs/MODEL.md` — covers VDOT, physioAdj, Signal A/B/C, iTRIMP, CTL/ATL/TSB, ACWR.
Includes "why does X look wrong?" quick-reference table.

---

### ISSUE-50: Load chart footnote missing
**From original test plan (Test 4)**: Main 8-week chart needs a faint footnote:
"History from Strava · current week includes all training at full physiological weight"
Never implemented. Add to chart footer area in `stats-view.ts`.

---

### 📌 ISSUE-47: What-if sandbox — ON HOLD, come back to this
Fully scoped (see ISSUE-47). Ready to plan and build when prioritised.

---

### ISSUE-51: Cross-training load management v2 — full rebuild needed
**Root cause diagnosis (2026-03-04)**:
The current system has three concrete bugs plus a design gap:

1. **Blocking modal fires too eagerly** — any overflow activity triggers a blocking popup.
   Should only fire at Tier 3 (ACWR caution/high). Small excess should auto-adjust (Tier 1)
   or show a nudge card (Tier 2).

2. **Excess from matched cross slots is invisible** — when an activity fills a plan `cross`
   slot, the load is absorbed silently with no excess check. A 3hr padel that matches a slot
   looks identical to a 45min padel. The system should compare actual vs expected slot load.

3. **Previous-week excess not included in automatic modal** — `autoProcessActivities` computes
   suggestions for current overflow only, ignoring `unspentLoadItems` carried from prior weeks.
   Only the manual "Adjust Plan" button on the Excess Load Card includes carry-over items.

4. **No timing sensitivity** — a heavy cross-training session the day before a quality session
   doesn't trigger any plan adjustment. The weekly total is checked but not day-of-week proximity.

**Design spec**: See `FEATURES.md §18b` (Cross-Training Load Management v2) and
`PRINCIPLES.md` (Resolved Design Decisions 2026-03-04). Full build plan in those docs.

**Files to modify**: `src/ui/activity-review.ts`, `src/data/activitySync.ts`,
`src/ui/excess-load-card.ts`, `src/calculations/fitness-model.ts`, and new
`src/cross-training/timing-check.ts`. New edge function mode in `sync-strava-activities`.

---

### ✅ ISSUE-52: Signal B weekly baseline — edge function gap *(fixed 2026-03-04)*
**Problem**: `historicWeeklyRawTSS` (raw iTRIMP per week, no runSpec) doesn't exist.
The Strava edge function `history` mode returns Signal A (runSpec-discounted) only.
Until fixed, Tier 1/2 excess thresholds have no accurate baseline to compare against.

**Fix**: New `sport-history` mode on `sync-strava-activities` edge function.
Groups `garmin_activities` by week, sums raw iTRIMP, returns `weeklyRawTSS[]` + per-sport breakdown.
**Fallback**: Signal A × 1.4 proxy (conservative) until this ships.

**Files**: `supabase/functions/sync-strava-activities/index.ts` + state field
`historicWeeklyRawTSS` in `src/types/state.ts`.

---

### ISSUE-47: What-if sandbox / training scenario simulator *(scoped, ready to build)*
**Confirmed design:**
- Entry: dedicated "Sandbox" tab opened from Stats page
- Read-only: never touches the real plan
- Real-time recomputation as sliders change

**Toggleable inputs (5 sliders/controls):**
1. Weekly km — volume modifier (e.g. 30–90km range)
2. Pace — faster/slower than plan (% modifier, e.g. −10% to +15%)
3. Perceived difficulty — how hard sessions feel (RPE 1–10 slider)
4. HR above/below expected — modifier on HR data (affects efficiency/VDOT estimation)
5. Weeks until race — countdown (affects taper logic and peaking point)

**Outputs that update in real time:**
- Projected race time
- VDOT trajectory (sparkline forward)
- CTL/fitness curve projection
- Injury risk (ACWR projection)

**Architecture**: New `src/ui/sandbox-view.ts`. Takes current `AppState` as baseline, creates
a simulated copy with modifications applied, runs forecast functions against the sim state.
No writes to actual state. A "Reset to current plan" button restores defaults.

**Fix**: Add VDOT sparkline over plan weeks. Add a tap-to-explain tooltip: "VDOT is a measure
of your running fitness — higher means faster across all distances." Flag suspicious drops.

---

### ISSUE-30: Load metrics (CTL, ATL, form) have no reference point or scale
**Symptom**: Stats page shows numbers but no context for what's good/bad/normal. User says
"Running fitness 100/100 feels wrong."

**Fix** `[ui-ux-pro-max]`: Every metric needs a reference: a range bar, a peer comparison sentence,
or a tier label. Numbers alone are meaningless.

---

### ISSUE-31: No KM/Mile toggle
**Scoping confirmed**: Toggle lives in (1) onboarding/setup and (2) Settings/Account page.
Should apply globally to all distance displays across the app.
**Symptom**: All distances shown in km. No way to switch to miles.

**Fix**: Add a unit preference in setup and settings. Store in state. Apply across all distance
display points.

---

### ISSUE-32: Phases have taken a back seat — not visible in plan
**Symptom**: Training phases (base, build, peak, taper) used to be more prominent but are
now hard to find or not clearly shown.

**Fix**: Restore phase label visibility in plan week headers. User should always know which
phase they're in and why their sessions look the way they do.

---

## P3 — New Features / Future

### ISSUE-33: Can't plan 2 workouts on one day
**Note**: Determine if this was ever supported. If not, it's a feature request. Low priority
until plan page UX is settled.

---

### ISSUE-34: Force RPE capture after runs and use it to adjust future sessions
**Design**: After completing a run, prompt for RPE (1–10). Store it. If RPE was very high for
an easy run, flag potential overtraining. If very low, consider upgrading next session.
Connects to HR drift analysis (ISSUE-35).

---

### ISSUE-35: HR vs expected HR — use to adjust future workouts
**Design**: After a run is synced from Strava/Garmin, compare actual HR against expected HR
for the planned pace. HR drift within a session is especially useful. Feed this into VDOT
recalculation and future session intensity. High priority conceptually but needs research.

---

### ISSUE-36: Garmin sleep data — edge function needed
**Design**: Build a Garmin sleep data edge function. Feed into a "you're feeling fresh — go
bigger?" nudge, and into reduce/replace logic. High potential impact, significant build effort.

---

### ISSUE-37: Illness mode
**Design**: User can flag they're recovering from illness. App suspends load targets for N days,
shows a "return to training" ramp-up on recovery. No plan adjustments during illness.

---

### ISSUE-38: Race simulator / race mode inaccessible
**Symptom**: User doesn't know how to get to the race simulator. Should be surfaced from Stats page.

**Fix**: Add a clear entry point — a button on Stats ("Simulate race day") that opens the simulator.

---

### ⚠️ ISSUE-40: Edit week entry point needs rethinking *(revisit)*
Current week already has native editing — the ✎ button added to current week header is redundant.
The real need is ISSUE-28 (historic weeks). The pencil should move to past week views, not current.
TODO: remove the ✎ button from current week; add to past week views when ISSUE-28 is implemented.

---

### ISSUE-41: HR analysis of completed workouts should inform future session intensity
**Status**: Confirmed P3 — significant build. Needs:
1. HR drift detection within a run (HR rising for same pace = fatigue)
2. Comparison of actual HR vs expected HR for planned pace/effort
3. Feedback loop into next week's session intensity targets
4. Connects to RPE capture (ISSUE-34) — both feed the same adaptation engine.
Defer until RPE capture (ISSUE-34) is implemented first.

---

### ISSUE-42: TSS showing 97/90 after one tennis session (tennis = 69 load)
**Symptom (2026-03-04)**: After one tennis session, the stats/plan bar showed 97/90 TSS.
Tennis added 69 load. Where does 97 come from? Either historic load is bleeding into this week,
the bar is counting something extra, or the calculation is wrong.
**Additional symptom**: Week of 25 Feb shows near-zero load despite activity data existing (see ISSUE-57 — same root cause suspected).
**Investigate**: Is `computeWeekRawTSS` double-counting? Is historic Strava load being included?

---

### ISSUE-43: Historic week view should show actual activity days, not planned layout
**Symptom**: Once a week is matched and completed, the plan view still shows the original planned
session slots rather than which day you actually did each activity.
**Fix**: For completed past weeks, render activities on the day they were actually performed
(use activity date from `adhocWorkouts` or matched session), not the planned day.

---

### ISSUE-44: "Simulate race day" — misunderstood, needs clarification
**Symptom**: Agent added a "Simulate race day →" button pointing to the Race Prediction card.
That is NOT what was asked. User wants a way to switch into Race/Simulation mode — a separate mode
where they can explore race scenarios, see projected outcomes, try different training assumptions.
**Decision needed**: Confirm exact scope of "race mode" / "simulation mode" with user before building entry point.
**Status**: The incorrectly-placed button has been removed. Awaiting clarification.

---

### ISSUE-45: Week load on plan page should be a bar, not a text line
**Symptom**: Agent added "Week load: 47 TSS planned · 31 so far" as a text line.
User wants a visual bar identical to the home page load bar.
**Fix**: Replace text line with same bar component used on home page.

---

### ISSUE-56: "Reduce one session" language doesn't account for variable training days *(logged 2026-03-04)*
**Symptom**: Somewhere in the app (stats page or reduce/replace modal — location TBC) it says something like "118% — reduce one session." This is wrong: people don't train the same days each week, so counting sessions is meaningless. Should compare total load vs planned load only.
**Fix**: Replace session-count language with total-load comparison: "Your load this week is 118% of plan." Remove all references to "reduce N sessions" — instead suggest reducing intensity or duration of remaining sessions.
**Location to verify**: Check `stats-view.ts` and `suggestion-modal.ts` for the exact wording.
**Priority**: P2 — confusing copy, not technically broken.

---

### ISSUE-58: Sleep card on Home page — doesn't belong there *(logged 2026-03-04)*
**Symptom**: The Home page shows a Sleep card. This doesn't belong on the primary training view. User wants a dedicated Recovery page (sleep, check-in, injury flag).
**Status**: P3 — the recovery edge function may not be fully connected. Needs investigation before building the Recovery view.
**Immediate fix**: Hide/remove the sleep card from Home if the data behind it is incomplete or fake.
**Full fix**: Build a Recovery section (separate tab or expandable card) with sleep, RPE check-in, and injury flag — once edge function connectivity is confirmed.

---

### ISSUE-59: Maintenance gym session on Home — not expandable, poorly labeled *(logged 2026-03-04)*
**Symptom**: A session labeled "Maintenance" appears on the Home page with no expandable detail and no clear indication it's a gym session.
**Fix**: Label should read "Maintenance Gym Session". Tapping it should expand to show what the session involves (exercises, load, duration estimate). Consistent with other session cards.
**Priority**: P2 — unhelpful label, no detail on tap.

---

### ISSUE-39: Welcome back message shows incorrectly
**Symptom**: "Welcome back" greeting appears even when the user hasn't been away.

**Fix**: Gate on time-since-last-open (e.g. > 24 hours). If no recent Strava activities,
consider a "No recent training logged — did you train offline?" prompt instead.

---

### ISSUE-60: Week completion overview / debrief *(logged 2026-03-04)*
**Symptom**: When a week completes, there's no summary — user doesn't know if it was a build week, deload week, how load compared to plan, etc.
**Design**: On week advance, show a brief debrief: "Build week complete · You hit 94% of planned load · Fitness up 3pts." One screen, 3–4 stats, then a "What's next week?" preview.
**Priority**: P3 — nice-to-have, defer until plan page UX is settled.

---

### ISSUE-61: LT pace / VDOT improvement should update race forecast and plan *(logged 2026-03-04)*
**Symptom**: If a user's LT pace or VDOT improves (detected from Strava or Garmin), there's no mechanism to update the race forecast time or re-pace future sessions.
**Design**: When VDOT changes by >2pts, recalculate race time estimate and offer to re-pace the remaining plan. Confirmation-gated — never auto-changes paces without user input.
**Priority**: P3 — significant build, depends on ISSUE-48 (efficiency trend algorithm fix) being stable first.

---

### ISSUE-62: Race time forecast in general fitness mode *(logged 2026-03-04)*
**Confirmed design**: Show estimated race times (5k, 10k, half marathon) in the Stats page under a collapsible "Forecast times" section. Only show after ≥4 weeks of Strava data. Informational only — no plan changes.
**Priority**: P3 — low effort once VDOT is stable, but defer until data quality is confirmed.

---

### ISSUE-63: HR-based ATL inflation for gym sessions *(logged 2026-03-04)*
**Context**: ISSUE-55 (injury risk mismatch) is caused partly by Stats using a flat 10%/gym-session ATL multiplier. This is wrong — gym load should inflate ATL based on actual HR data from those sessions, not a flat percentage.
**Design**: When a gym/cross-training session has HR data (iTRIMP), use that iTRIMP to seed ATL directly instead of a flat multiplier. This is the correct physiological model.
**Prerequisite for**: ISSUE-55 (injury risk consistency across Stats + Home).
**Priority**: P2 — blocked by ISSUE-41 (HR analysis pipeline). Build after HR stream data is reliably available.

---

### ISSUE-11: Auto-slot cross-training load before week completes
**Design**: When Signal B load is below weekly target AND user has unused cross-training capacity,
suggest adding a session. Non-blocking nudge card.

---

### ISSUE-12: Day-before impact warning (Signal C)
**Status**: Deferred. Connected to ISSUE-09.

---

## Priority Order

| Priority | Issue | Group | Effort | Impact |
|---|---|---|---|---|
| P1 | ISSUE-13: Strava pace mismatch | Calc | Small | High |
| P1 | ISSUE-01: RPE sessions missing from chart | Calc | Medium | High |
| P1 | ISSUE-15: Session count wrong (1/2) | Plan | Small | Medium |
| P1 | ISSUE-05: Tuesday -74% no context | Stats | Small | High |
| P1 | ISSUE-03: ⓘ buttons broken on iOS | Stats | Small | High |
| P1 | ISSUE-14: VDOT sharp decline | Calc | Medium | High |
| P1 | ISSUE-17: Deload week bad check-in | Calc | Small | Medium |
| P1 | ISSUE-02: CTL ranges wrong scale | Stats | Small | Medium |
| P2 | ISSUE-18: "Hyrox" in copy | Copy | Small | Medium |
| P2 | ISSUE-21: AI-sounding copy | Copy | Small | Medium |
| P2 | ISSUE-22: Sync UX | Plan | Small | Medium |
| P2 | ISSUE-24: Stale baseline messages | Data | Small | Medium |
| P2 | ISSUE-25: Missing nav buttons | Plan | Small | Medium |
| P2 | ISSUE-27: Sync button wrong page | Plan | Small | Low |
| P2 | ISSUE-26: Total load not on plan page | Plan | Small | Medium |
| P2 | ISSUE-29: VDOT history | Stats | Medium | High |
| P2 | ISSUE-08: Load bar unlabelled | Stats `[ux]` | Small | Medium |
| P2 | ISSUE-07: Fitness chart flat | Stats `[ux]` | Medium | Medium |
| P2 | ISSUE-30: Metrics need reference | Stats `[ux]` | Medium | High |
| P2 | ISSUE-19: Home load bars | Home `[ux]` | Medium | High |
| P2 | ISSUE-20: Activity card UX | Cards `[ux]` | Large | High |
| P2 | ISSUE-06: Badge → summary card | Plan `[ux]` | Large | High |
| P2 | ISSUE-28: Edit historic weeks | Plan | Large | Medium |
| P2 | ISSUE-31: KM/Mile toggle | Global | Medium | Medium |
| P2 | ISSUE-32: Phases hidden | Plan | Medium | Medium |
| P3 | ISSUE-34: RPE after runs | Feature | Large | High |
| P3 | ISSUE-35: HR vs expected | Feature | Large | High |
| P3 | ISSUE-38: Race simulator entry | UX | Small | Medium |
| P3 | ISSUE-39: Welcome back logic | UX | Small | Low |
| P3 | ISSUE-33: 2 workouts/day | Feature | Medium | Low |
| P3 | ISSUE-37: Illness mode | Feature | Large | Medium |
| P3 | ISSUE-36: Garmin sleep | Feature | XL | High |
| P3 | ISSUE-11: Auto-slot load | Feature | Large | Medium |
