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

### ✅ ISSUE-16: Skipped workouts — general fitness mode not pushing to next week *(fixed 2026-03-05)*
**Root cause**: In `continuousMode` (general fitness), second skip auto-dropped with a race-time penalty (`s.timp`) that has no meaning outside a race plan. First skip correctly pushes to next week in both modes. **Fix**: Second skip in `continuousMode` now shows a "Drop It / Keep It" confirmation dialog instead of auto-dropping. Race-time penalty only applied in race mode (`!s.continuousMode`). VDOT decline link: primarily caused by ISSUE-48 (efficiency trend), not skip logic.

---

### ✅ ISSUE-17: Deload week check-in suggested all-out effort *(fixed 2026-03-05)*
**Root cause**: `renderBenchmarkPanel` / `buildBenchmarkPanel` showed hard check-in options (threshold, speed, race sim) without gating on week type.
**Fix**: Added `isDeloadWeek` check in both `main-view.ts` and `plan-view.ts`. Benchmark panel now returns '' entirely on deload weeks — no check-in prompt shown.

---

## P1 — Bugs (broken or actively misleading)

### ✅ ISSUE-53: Moving a workout on the Plan tab does not update the Home view *(fixed 2026-03-05)*
**Root cause**: `buildTodayWorkout` and `buildNoWorkoutHero` in `home-view.ts` applied `workoutMods` but not `workoutMoves`. Today's session was found by `dayOfWeek` before moves were applied.
**Fix**: Added `workoutMoves` loop (identical to plan-view.ts) in both `buildTodayWorkout` and the "next workout" finder in `buildNoWorkoutHero`.

---

### ✅ ISSUE-54: Two "Running Fitness" sections in suggestion modal *(fixed 2026-03-05)*
**Root cause**: Resolved during 2026-03-04 jargon cleanup — runner type boilerplate and aero/anaero split sections (which included "Running Fitness" context) were removed from the modal. Current `suggestion-modal.ts` contains no duplicate "Running Fitness" block.

---

### ✅ ISSUE-55: Injury risk mismatch — elevated on Stats, Low on Home *(fixed 2026-03-04)*
**Root cause**: `buildSignalBars` in `home-view.ts` called `computeACWR` without `atlSeed`, while `buildAdvancedSection` in `stats-view.ts` inflated ATL seed by `1 + min(0.1 × gymSessions, 0.3)`. Result: gym-heavy athletes saw different ACWR values on Home vs Stats.
**Fix**: Added identical `atlSeed` calculation to `buildSignalBars` in `home-view.ts`. Both views now call `computeACWR` with the same arguments.

---

### ✅ ISSUE-57: Week of 25 Feb still shows near-zero load *(fixed 2026-03-05)*
**Root cause**: The edge function history mode always includes the current in-progress week as the last row. `fetchStravaHistory` was storing all rows (including the partial current week) into `historicWeeklyTSS`. This caused an off-by-one shift: the previous completed week appeared at the wrong position in the chart, and Fix 4's `planWeekIdx` lookup in `getChartData` missed it. **Fix**: Both `fetchStravaHistory` and `backfillStravaHistory` now filter with `r.weekStart < thisMondayISO` before storing to all historicWeekly* arrays and extendedHistory* arrays.

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

### ✅ ISSUE-09: Injury risk and Reduce/Replace modal are disconnected *(fixed 2026-03-05)*
**Root cause**: ACWR risk caption in `home-view.ts` gave no context about what drove the spike; no top-contributor attribution.
**Fix**: `buildSignalBars()` now identifies the top-contributing activity (highest Signal B TSS) from `garminActuals` + `adhocWorkouts`. ACWR caution/high captions include the top contributor name and a "Tap to adjust your training plan" CTA that routes to the suggestion modal.

---

### ✅ ISSUE-10: Reduce/Replace modal copy is too technical *(fixed 2026-03-05)*
**Root cause**: `acwrHeader` in `suggestion-modal.ts` led with "Your ACWR is 1.45× — 21% above your 6-week baseline" — technical ratio with no human meaning.
**Fix**: Rewrote to lead with human consequence: "You've been training X% harder than usual this week. Your body needs extra recovery before your next hard effort." ACWR ratio preserved in the expandable "See details" panel. Titles changed to "Heavy training week" / "Load building up".

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

### ✅ ISSUE-23: "17w average" hardcoded label bug *(fixed 2026-03-05)*
Legend label already reads "Your running base" (stats-view.ts line 242). No hardcoded week count visible in current code.

---

### ✅ ISSUE-24: "Building baseline" / "Calibrating intensity zones" shown when data exists *(fixed 2026-03-05)*
**Fix**: All "Building baseline" gates raised from `< 3` to `< 4` weeks in `stats-view.ts` and `main-view.ts`. "Calibrating intensity zones" already gated on `thresh.calibratedFrom > 0` (only shows during active partial calibration).

---

### ✅ ISSUE-25: Missing "Go to current week" button *(fixed 2026-03-04)*
"→ This week" button added to `plan-view.ts`, visible when browsing past weeks. Hides on current week.
"Review this week" still pending — connected to ISSUE-06 post-week debrief card.

---

### ✅ ISSUE-26 + ISSUE-45: Week load visual bar on Plan page *(fixed 2026-03-05)*
**Root cause**: Load was shown as a text line ("Week load: 47 TSS planned · 31 so far") — hard to read at a glance.
**Fix**: Replaced text line with a visual progress bar (same style as home page) showing planned TSS vs actual TSS. Shown for current and future weeks; past weeks already show the TSS badge. Bar turns accent-coloured as the week progresses.

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

### ✅ ISSUE-48: Cardiac Efficiency Trend fires incorrectly on easy runs *(fixed 2026-03-05)*
**Root cause**: Efficiency data collection in `events.ts` did not check HR zone — recovery runs (<Z2) and aerobic-threshold runs (>Z2) polluted the trend. **Fix (1)**: Added Z2 gate in `recordEfficiencyPoint` call — only records when `avgHR` is within `effZones.z2.min..z2.max × 1.05`. **Fix (2)**: Added `totalImprovementPct < 0.10` guard in `estimateFromEfficiencyTrend()` — ignores week-to-week variance of <10%. CEI = pace/HR was already correct (lower = more efficient). physioAdj clamp (-5.0) remains as safety net.

---

### ✅ ISSUE-49: docs/MODEL.md *(written 2026-03-04)*
See `docs/MODEL.md` — covers VDOT, physioAdj, Signal A/B/C, iTRIMP, CTL/ATL/TSB, ACWR.
Includes "why does X look wrong?" quick-reference table.

---

### ✅ ISSUE-50: Load chart footnote missing *(already present)*
Footnote `"History from Strava · current week includes all training at full physiological weight"` is already rendered at line 265 of `stats-view.ts:buildLoadHistoryChart`. No code change needed.

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

### ✅ ISSUE-31: No KM/Mile toggle *(fixed 2026-03-05)*
**Fix**: Added `unitPref: 'km' | 'mi'` to `SimulatorState`. Added `formatKm(km, pref, decimals)` utility to `src/utils/format.ts`. Added "Preferences" card in `account-view.ts` with km/mi segmented control. Updated distance displays in `home-view.ts` (weekly distance bar), `stats-view.ts` (distance card, Distance vs Plan bar, Running km label), and `activity-detail.ts` (Distance stat). Toggle persists in state, re-renders on change.

---

### ✅ ISSUE-32: Phases have taken a back seat — not visible in plan *(fixed 2026-03-05)*
**Root cause**: Phase label was rendered as faint uppercase text alongside the date range — same styling, easy to miss.
**Fix**: Phase now renders as a colour-coded badge (blue=Base, orange=Build, red=Peak, green=Taper) in the plan week header, next to the date range. `phaseBadge()` helper added to `plan-view.ts`.

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

### ✅ ISSUE-42: TSS showing 97/90 after one tennis session *(fixed 2026-03-05)*
**Root cause**: Off-by-one in historicWeeklyTSS (current partial week included, shifting all entries). Combined with ISSUE-68 dedup fix. Both resolved by ISSUE-57 fix.

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

### ✅ ISSUE-45: Week load on plan page should be a bar, not a text line *(fixed 2026-03-05, combined with ISSUE-26)*

---

### ✅ ISSUE-56: "Reduce one session" language replaced with load-based copy *(fixed 2026-03-05)*
**Fixed locations**:
- `stats-view.ts`: "High load this week. Consider swapping one session for rest." → "Shorten or ease your remaining sessions."
- `suggestion-modal.ts`: "Consider reducing at least one session." → "Consider reducing intensity or duration of remaining sessions."
- `home-view.ts`: "Reduce one session this week." → "Shorten or ease remaining sessions."

---

### ISSUE-58: Sleep card on Home page — doesn't belong there *(logged 2026-03-04)*
**Symptom**: The Home page shows a Sleep card. This doesn't belong on the primary training view. User wants a dedicated Recovery page (sleep, check-in, injury flag).
**Status**: P3 — the recovery edge function may not be fully connected. Needs investigation before building the Recovery view.
**Immediate fix**: Hide/remove the sleep card from Home if the data behind it is incomplete or fake.
**Full fix**: Build a Recovery section (separate tab or expandable card) with sleep, RPE check-in, and injury flag — once edge function connectivity is confirmed.

---

### ✅ ISSUE-59: Maintenance gym session on Home — not expandable, poorly labeled *(fixed 2026-03-05)*
Gym workout names now get "Gym Session" appended if not already present. Exercises (from `d` field, newline-separated) render as a `<details>` expandable list in the Home card.

---

### ✅ ISSUE-39: Welcome back message shows incorrectly *(fixed 2026-03-05)*
**Root cause**: `WELCOME_BACK_MIN_HOURS` was 20, allowing the modal to fire if the user opened the app less than 24h before the week rolled over.
**Fix**: Raised `WELCOME_BACK_MIN_HOURS` from 20 → 24 in `welcome-back.ts`. Modal also gated on daily calendar key and actual missed-week detection (returns 0 if still in current week).

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

### ✅ ISSUE-64: Production build blocked — 42 TypeScript errors *(fixed 2026-03-05)*
**Root cause**: Multiple sources: (1) `src/scripts/` and `src/testing/` not excluded from tsconfig so offline audit scripts were compiled; (2) `import.meta.env` lacked type declarations (missing `vite-env.d.ts`); (3) `InjuryType` narrowed after tests were written (`'overuse'` removed, `'general'` added); (4) `'passed'` not in `Workout['status']` union (dead code path); (5) `window.rateCapacityTest` not in `Window` interface declaration; (6) ~60 lines of unreachable code in `initializing.ts` after early `return` caused null-index errors.
**Fix**: Added `tsconfig.json` exclude for scripts/testing; created `src/vite-env.d.ts`; updated test fixtures to `type: 'general'` and `'pain_free_walk'`; cast `(w as any).status === 'passed'` in renderer; added `rateCapacityTest` to Window interface; deleted unreachable block in `initializing.ts`.

---

### ✅ ISSUE-65: GPS split scheme — per-km splits never shown during runs *(fixed 2026-03-05)*
**Root cause**: `buildKmSplits()` was defined in `split-scheme.ts` but never called. Simple distance (`"8km"`) and distance-at-pace (`"20km @ MP"`) branches both returned a single segment instead of per-km splits. Progressive runs had per-km splits for the fast portion but a single block for the easy portion. A general `Xkm [description]` catch-all was also missing.
**Fix**: Wired `buildKmSplits()` into simple distance, dist@pace, progressive easy portion, and added a `/^(\d+\.?\d*)km\b/i` catch-all for descriptions like "5km warmup jog". All 5 failing tests now pass (714 total, 0 failures).

---

### ✅ ISSUE-66: ACWR atlSeed missing from 9 of 12 call sites *(fixed 2026-03-05)*
**Root cause**: ISSUE-55 fix applied `atlSeed` (gym-inflation correction) only to `buildSignalBars` in `home-view.ts`. Nine other `computeACWR` call sites — including the "On Track" status pill, click-handler routing, Stats trend sentence, reduce/replace modal trigger, ACWR inline panel, load bar zones, week-complete handler, and activity-review gating — computed ACWR without the correction.
**Fix**: Added `atlSeed = ctlBaseline × (1 + min(0.1 × gymSessions, 0.3))` before all 9 missing call sites across `home-view.ts`, `main-view.ts`, `stats-view.ts`, `renderer.ts`, `events.ts`, `activity-review.ts`. Also added missing `planStartDate` to `stats-view.ts:428`.

---

### ✅ ISSUE-67: Recovery bar direction inverted *(fixed 2026-03-05)*
**Root cause**: `home-view.ts` used `width: ${100 - recoveryPct}%` — good sleep (85%) showed a narrow 15% bar; bad sleep (30%) showed a wide 70% bar. Combined with the green→red left-to-right gradient, poor recovery appeared as a wide green bar.
**Fix**: Changed to `width: ${recoveryPct}%`. Wide = good, narrow = poor.

---

### ✅ ISSUE-68: `computeWeekTSS` (Signal A) missing garminId deduplication *(fixed 2026-03-05)*
**Root cause**: `computeWeekRawTSS` (Signal B) deduplicated via `seenGarminIds` Set to prevent double-counting activities in both `garminActuals` and `adhocWorkouts`. `computeWeekTSS` (Signal A) had no such dedup, so matched runs that also appeared as adhoc entries could inflate Signal A TSS — plausible root cause of ISSUE-42/57.
**Fix**: Added identical `seenGarminIds` dedup logic to `computeWeekTSS`, mirroring the pattern from `computeWeekRawTSS`.

---

### ✅ ISSUE-69: Suggestion modal ACWR details panel always visible *(fixed 2026-03-05)*
**Root cause**: `suggestion-modal.ts:222` had inline style `display:none;...;display:flex` — the second declaration immediately overrode the first, so the panel was always shown. The "See details" toggle did nothing on first load.
**Fix**: Removed `display:none;` from the inline style, keeping `display:flex` as the default. The toggle JS handles visibility.

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
