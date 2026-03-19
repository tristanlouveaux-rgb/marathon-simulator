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

### ✅ ISSUE-08: Training Load vs Plan bar unlabelled *(resolved 2026-03-09)*
The "More detail" section on Stats already shows `${currentTSS} / ${Math.round(plannedTSS)}` label on the Total Load vs Plan bar, plus the Distance vs Plan bar. Both bars have clear labels and actual/planned values. No additional changes needed.

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

### ✅ ISSUE-19: Home page load bars confusing *(resolved 2026-03-09)*
Home page load bars already have: label ("Training Load (TSS)"), actual/planned values (`tssActual / tssPlan TSS`), colour coding (grey <70%, green ≤105%, amber >plan), and overflow label (+X%) when over target. The 88%-wide bar acts as the 100% reference. No further changes needed.

---

### ⚠️ ISSUE-20: Activity card km splits don't match Strava *(fix deployed 2026-03-12 — needs device test on next run)*
**Root cause**: Previous implementation computed km splits from raw GPS streams using our own interpolation. Strava's app shows splits from `splits_metric` on the detailed activity — computed server-side with GPS smoothing. The two algorithms produce different values.
**Fix applied + deployed**: Standalone mode now calls `/activities/{id}` to get `splits_metric` directly. Pace = `moving_time * 1000 / distance` sec/km per split (exact match to Strava). Stream-based computation stays as fallback. Cached runs with no km_splits also get fetched on next sync.
**Note on historic runs**: Runs already cached in DB with stream-based splits won't auto-correct. To fix all historic splits: run `UPDATE garmin_activities SET km_splits = NULL WHERE source = 'strava' AND activity_type = 'RUNNING';` in Supabase SQL editor, then sync again.
**To confirm**: Complete a new run → sync Strava → open the activity → km splits should match Strava's app exactly.

---

### ✅ ISSUE-21: AI-sounding copy throughout the app *(fixed 2026-03-08)*
Rewrote recovery labels ("How are you feeling?" / "Feeling good" / "Feeling rough"), removed 🏃 emoji + "Today's planned run" → "Today", welcome-back bullets → plain sentences, wizard runner-type → direct voice.

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

### ✅ ISSUE-27: Sync Strava button on Plan page — wrong location *(confirmed resolved)*
**Status**: Already resolved. Sync Strava lives in `account-view.ts` (rendered via `renderStravaEnrichCard` and `renderStravaStandaloneCard`). It does not appear in `plan-view.ts` or `buildPlanActionStrip`. No code change needed.

---

### ✅ ISSUE-28: Cannot edit historic weeks *(confirmed on device 2026-03-12)*
**Fix applied**:
- `data-week-num` added to "Mark Done" and "Skip" buttons in `plan-view.ts` — buttons now know which week they live in
- Click handlers pass `targetWeek` to `rate()` and `skip()` in `events.ts`
- Past week edits use a minimal path: just sets `wk.rated[workoutId]`, no VDOT/week-advance side effects
- Skip on past week = mark as skipped in-place, no push to next week
- Strava/Garmin-matched sessions stay read-only (green "Synced" badge, no buttons)
- Auto-push on "Complete week": before advancing, shows "X sessions weren't completed — Move to next week / Drop them"

---

### ✅ ISSUE-29: VDOT not tracked over time and poorly explained *(fixed 2026-03-04)*
`vdotHistory` added to state. Sparkline + change note + ⓘ explanation added to stats-view.ts.

---

### ✅ ISSUE-46: VDOT physioAdj reset button *(fixed 2026-03-04)*
"Reset VDOT calibration" button added to Advanced card in `account-view.ts`.
Sets `physioAdj = 0`, saves state, shows 3s confirmation. Real fix is ISSUE-48.

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

### ✅ ISSUE-51: Cross-training load management v2 *(fixed 2026-03-08)*
All 4 bugs confirmed resolved by code inspection:
1. Blocking modal now only fires at Tier 3 (ACWR caution/high) — `activity-review.ts:1524-1538`
2. Tier 1 (auto-absorb <15 TSS) and Tier 2 (nudge card 15–40 TSS) implemented in `excess-load-card.ts`
3. Excess card surfaces carry-over items on-demand via "Adjust Plan" button
4. Timing sensitivity: `mergeTimingMods()` wired in `activitySync.ts:52`, `timing-check.ts` fully built

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

### 📌 ISSUE-47: What-if sandbox / training scenario simulator *(scoped — ON HOLD)*
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

### ✅ ISSUE-30: Load metrics have no reference point *(resolved 2026-03-09)*
Stats Recovery and Progress cards now have position bars with zone labels (Fresh/Neutral/Fatigued, tier labels for CTL). VDOT sparkline shows progression. Position bars provide sufficient context — no additional copy needed.

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

### ✅ ISSUE-34: RPE → pacing logic *(resolved 2026-03-09, merged into ISSUE-60)*
RPE capture was already built (`wk.effortScore`, `wk.rated`, `wo.rpe`). Week-end debrief (ISSUE-60) surfaces effortScore and offers rpeAdj pacing adjustment. No new capture screen built — existing per-session RPE rating is the input.

---

### ISSUE-35: HR vs expected HR — use to adjust future workouts *(Build 1+2+3 ✅ ALL COMPLETE)*
**Design confirmed (2026-03-11)**:

**Build 1 — HR Effort + Pace Adherence Signal** ✅ COMPLETE (2026-03-12):
- `computeHREffortScore()` compares avgHR to target HR zone → `hrEffortScore` on GarminActual
- `computePaceAdherence()` compares actual pace to VDOT target → `paceAdherence` on GarminActual
- Blended into `wk.effortScore`: quality sessions weight pace 35%, easy runs 15%, HR fills the rest
- Enrichment backfill adds both scores to existing actuals on next sync
- Future weeks show adaptive note with context-aware detail
- All 8 plan engine factors verified wired and composing correctly

**Build 2 — HR Drift** ✅ COMPLETE (2026-03-12):
- `computeHRDrift()` in `stream-processor.ts` + inline in edge fn
- Strips 10% warmup, splits in half, compares avg HR. Requires ≥20 min + ≥60 valid HR points.
- Only computed for DRIFT_TYPES (running variants). Stored in DB `hr_drift` column + `GarminActual.hrDrift`.
- Drift > 5% on easy/long adds bonus to effort score (capped +1.0 RPE-equiv). Surfaced in adaptive note.
- Migration: `20260312_hr_drift.sql`. Edge fn needs redeploy.

**Build 3 — Intelligent Workout Commentary** ✅ COMPLETE (2026-03-12):
- `generateWorkoutInsight()` in `src/calculations/workout-insight.ts` — rules-based priority system, coaching/direct tone, 2–3 sentences
- Picks top 2-3 insights by priority from: pace adherence (quality vs easy), HR effort score, HR drift, split consistency (CV, negative split, late fade), HR zone distribution
- Rendered as "Coach's Notes" card on activity detail screen (below training load, above stats grid)
- All activity types — runs get full analysis, cross-training gets HR effort + load commentary
- Only shows when there's something useful to say (no empty/generic filler)

**Dependency chain**: Build 1 → Build 2 (enriches effort score) → Build 3 (consumes all signals)

**Deploy checklist (Build 1+2):**
1. `supabase db push` (or run `20260312_hr_drift.sql` manually) — adds `hr_drift` column
2. `supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje`
3. Build + deploy client (`npx tsc && npx vite build`)

**Testing (not yet verified on device):**
- [ ] Sync a Strava run → check localStorage `wks[N].garminActuals[workoutId]` has `hrEffortScore`, `paceAdherence`, and `hrDrift` (drift only on runs ≥20 min)
- [ ] View a future week in Plan tab → should see adaptive note card below the header
- [ ] Run 2–3 weeks with data → compare workout durations week-to-week. If you consistently ran harder than planned, future weeks should show slightly shorter durations (up to 15% via effortMultiplier)
- [ ] Deliberately run a threshold session slower than target pace → on next week advance, effort score should reflect it and scale down next week's sessions
- [ ] Check edge fn logs for `[Backfill]` / `[Standalone]` — `hr_drift` should appear in upserts
- [ ] Tap into a completed run → "Coach's Notes" card should appear below training load with 2-3 sentences
- [ ] Tap into a cross-training activity → should see HR effort commentary (if HR data exists)
- [ ] Tap into an activity with no HR/pace data → no Coach's Notes card (graceful absence, not empty card)

**UX note:** With Build 3 complete, all three signals (HR effort, pace adherence, HR drift) are now user-visible via "Coach's Notes" on the activity detail screen. The adaptive note on future weeks (Build 1) + commentary on past workouts (Build 3) together make the system's intelligence transparent.

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

### ✅ ISSUE-40: Edit week entry point needs rethinking *(fixed 2026-03-08)*
Resolved by ISSUE-28 fix: ✎ button moved from current week to past week headers.

---

### ISSUE-41: HR analysis of completed workouts should inform future session intensity *(merged into ISSUE-35)*
**Status**: Merged — all 4 requirements covered by ISSUE-35 Build 1–3 plan. RPE capture (ISSUE-34) already resolved.

---

### ✅ ISSUE-42: TSS showing 97/90 after one tennis session *(fixed 2026-03-05)*
**Root cause**: Off-by-one in historicWeeklyTSS (current partial week included, shifting all entries). Combined with ISSUE-68 dedup fix. Both resolved by ISSUE-57 fix.

---

### ✅ ISSUE-43: Historic week view should show actual activity days, not planned layout *(fixed 2026-03-08)*
**Symptom**: Once a week is matched and completed, the plan view still shows the original planned
session slots rather than which day you actually did each activity.
**Fix**: For completed past weeks, render activities on the day they were actually performed
(use activity date from `adhocWorkouts` or matched session), not the planned day.

---

### ✅ ISSUE-44: Race time forecast display on Stats *(fixed 2026-03-08)*
Collapsible "Forecast times" section added to Stats Advanced area. Shows 5K, 10K, Half, Marathon times from VDOT. Gated on ≥4 weeks of data. Combined with ISSUE-62.

---

### ✅ ISSUE-45: Week load on plan page should be a bar, not a text line *(fixed 2026-03-05, combined with ISSUE-26)*

---

### ✅ ISSUE-56: "Reduce one session" language replaced with load-based copy *(fixed 2026-03-05)*
**Fixed locations**:
- `stats-view.ts`: "High load this week. Consider swapping one session for rest." → "Shorten or ease your remaining sessions."
- `suggestion-modal.ts`: "Consider reducing at least one session." → "Consider reducing intensity or duration of remaining sessions."
- `home-view.ts`: "Reduce one session this week." → "Shorten or ease remaining sessions."

---

### ✅ ISSUE-58: Sleep card on Home → build dedicated Recovery section *(resolved 2026-03-08)*
Recovery system was already fully built. Blocker was expired Garmin token (ISSUE-70). Now that token refresh is implemented (Group A), sleep/HRV data will flow again and recovery ring, recovery modal, and readiness sub-score all activate automatically. Verify after deploying garmin-refresh-token edge function.

---

### ✅ ISSUE-59: Maintenance gym session on Home — not expandable, poorly labeled *(fixed 2026-03-05)*
Gym workout names now get "Gym Session" appended if not already present. Exercises (from `d` field, newline-separated) render as a `<details>` expandable list in the Home card.

---

### ✅ ISSUE-39: Welcome back message shows incorrectly *(fixed 2026-03-05)*
**Root cause**: `WELCOME_BACK_MIN_HOURS` was 20, allowing the modal to fire if the user opened the app less than 24h before the week rolled over.
**Fix**: Raised `WELCOME_BACK_MIN_HOURS` from 20 → 24 in `welcome-back.ts`. Modal also gated on daily calendar key and actual missed-week detection (returns 0 if still in current week).

---

### ✅ ISSUE-60: Week-end debrief *(fixed 2026-03-09, ISSUE-34 merged)*
`src/ui/week-debrief.ts` built. Shows phase badge + "Week N complete", load % vs planned, distance, CTL delta, effort pacing adjustment (reads `wk.effortScore`, applies `rpeAdj` adjustment capped at ±0.5 VDOT). "Finish week" button added to plan page current week header. Auto-triggers on app open after week advance (guarded by `lastDebriefWeek`).

---

### ISSUE-61: LT pace / VDOT improvement should update race forecast and plan *(logged 2026-03-04)*
**Symptom**: If a user's LT pace or VDOT improves (detected from Strava or Garmin), there's no mechanism to update the race forecast time or re-pace future sessions.
**Design**: When VDOT changes by >2pts, recalculate race time estimate and offer to re-pace the remaining plan. Confirmation-gated — never auto-changes paces without user input.
**Priority**: P3 — significant build, depends on ISSUE-48 (efficiency trend algorithm fix) being stable first.

---

### ✅ ISSUE-62: Race time forecast in general fitness mode *(fixed 2026-03-08)*
Combined with ISSUE-44. "Forecast times" collapsible section added to Stats page. Shows 5K, 10K, Half, Marathon. Gated on ≥4 weeks data. Copy: "Based on your current fitness".

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

### ISSUE-71: Remove "Simulate Race" button from Stats *(P2)* — ✅ FIXED 2026-03-09
**Fix**: Deleted `buildRaceSimulatorEntry()` and click handler from `stats-view.ts`.

---

### ISSUE-72: Stats page "Your Numbers" should split into Recovery vs Running *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Split into **Progress card** (Running Fitness CTL + VDOT) and **Recovery card** (Freshness TSB + Short-Term Load ATL + Load Safety ACWR). Both always visible, no accordion needed.

---

### ISSUE-73: "Dig Deeper" and "Your Numbers" hierarchy is confusing *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Killed "Dig Deeper" accordion — Distance and Zones charts promoted as tabs in the main chart card alongside Load. "Your Numbers" replaced by Progress + Recovery cards (ISSUE-72). Remaining advanced content under a "More detail" toggle.

---

### ISSUE-74: Running Fitness and VDOT info (i) buttons don't work *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Added inline info boxes in `buildOnePositionBar()` so (i) buttons toggle the explanation text directly below the bar.

---

### ISSUE-75: Running fitness appears to improve despite no recent running *(P2)* — ✅ FIXED 2026-03-09
**Fix**: `wkGain` adherence now only counts running workouts (filters out gym/cross-training names via `NON_RUN_KW` list in `events.ts`).

---

### ✅ ISSUE-76: Garmin historic HR/sleep backfill *(fixed 2026-03-09)*
`supabase/functions/garmin-backfill/index.ts` built. Pulls dailies (resting HR, max HR, HRV, stress, VO2max), sleep scores, and HRV from Garmin Health API for N weeks. Upserts into `daily_metrics` + `sleep_summaries` (idempotent). Called from `triggerGarminBackfill()` in `supabaseClient.ts` on both Garmin-only and Strava+Garmin startup paths.
**Pipeline fix (2026-03-09)**: `sync-physiology-snapshot` had a `const days` variable shadowing bug (Deno runtime crash). Fixed by renaming to `mergedDays`. Also added explicit `user_id` filters to all DB queries (defense in depth alongside RLS) and diagnostic logging. Column names confirmed to match `garmin-backfill` write schema.

---

### ISSUE-77: Activities not sorted by time within a week *(P1)* — ✅ FIXED 2026-03-09
**Fix**: Sort activities by `garminActual.startTime` descending in `plan-view.ts`.

---

### ISSUE-78: "952% of my week" — prorated baseline broken on Monday *(P1)* — ✅ FIXED 2026-03-09
**Fix**: "This Week" card now shows progress as "X% · actual/target TSS" using Signal B baseline (weekly average). Resets each Monday — always current week actual vs full weekly target.

---

### ISSUE-79: plannedTSS is not based on historic load *(P1, architectural)* — ✅ FIXED 2026-03-09
**Fix**: New `computePlannedWeekTSS()` in `fitness-model.ts` — uses MEDIAN of `historicWeeklyTSS` as baseline (not EMA), with tier-aware phase multipliers. Wired into stats-view, plan-view, and home-view. See PRINCIPLES.md §Planned Load Model.

---

### ✅ ISSUE-81: Remove welcome-back modal *(fixed 2026-03-09)*
`showWelcomeBackModal` trigger removed from `main.ts`. `detectMissedWeeks()` + `recordAppOpen()` still called. `welcome-back.ts` file preserved (its state logic may still be referenced) but modal never fires.

---

### ✅ ISSUE-80: Recovery score bar in Stats Recovery card *(fixed 2026-03-09)*
`computeRecoveryScore()` added to `readiness.ts` — HRV 45% / Sleep 35% / RHR 20%, all relative to user's 28-day personal baseline. `buildRecoveryCard()` in `stats-view.ts` shows position bar + clickable sub-bars (Sleep, HRV, Resting HR with sparklines). Gated on `hasData` (≥3 days of `physiologyHistory`). Shows "Connect a watch" placeholder when no data.

---

### ✅ ISSUE-82: "How are you feeling?" check-in is mandatory, should be optional *(fixed 2026-03-09)*
**Fix**: Removed auto-triggered `showRecoveryLogModal()` from startup. The `checkRecoveryAndPrompt` function no longer shows a manual check-in when no Garmin data exists — it silently returns. Both startup `checkRecoveryAndPrompt()` calls removed from `main.ts`.

---

### ✅ ISSUE-83: TSS value looks wrong — shows 107% / 245/330 *(resolved 2026-03-09, shared root cause with ISSUE-85)*
**Root cause**: The inflated numbers shared a root cause with ISSUE-85 — cross-training iTRIMP was accumulated into `wk.actualTSS` without runSpec discount, and `computeWeekTSS` returned the cached (corrupted) value. The ISSUE-85 fix (always recompute from raw data, apply runSpec) resolves this. Signal B computation path (used by home "This Week" card) was audited and found correct: dedup in place, same signal both sides (D4), `signalBBaseline` from proper edge fn average.

---

### ISSUE-84: HR zones chart is visually ugly *(P2)* `[ui-ux-pro-max]`
**Symptom**: HR zone bars (stacked horizontal) look rough — likely font size, spacing, colour contrast, or proportions are off. User finds them unpleasant to read.
**Design**: Cleaner zone bar: consistent height, readable zone labels (Z1–Z5), time per zone, muted base colours with accent highlight for the dominant zone. Review against activity card and Stats chart styling for consistency.
**Files**: `src/ui/stats-view.ts` (zone chart), `src/ui/activity-review.ts` (per-activity zones).

---

### ✅ ISSUE-85: Running Fitness (CTL) shows 222 — inflated, not calibrated to real athlete level *(fixed 2026-03-09)*
**Symptom**: User has a 3:12 marathon (solidly recreational/trained), but CTL reads 222 which the tier system labels as "Elite" (200+). This is wrong and erodes trust in the whole fitness model.
**Root cause (hypotheses)**:
1. CTL computed from raw iTRIMP without proper normalisation — 1 hour of backcountry skiing or Hyrox inflates it disproportionately relative to running
2. `CTL_DECAY` constant may be too slow, causing CTL to accumulate without decay
3. `historicWeeklyTSS` baseline fed into CTL includes Signal A values (runSpec-discounted) in some paths and raw Signal B in others — inconsistency inflates the number
4. VDOT-to-CTL expected range: a 3:12 marathoner (~VDOT 48–52) would have CTL ~60–90 in a trained training block, not 222
**Action**: Audit the CTL EMA computation in `fitness-model.ts`, verify `CTL_DECAY` (`e^(-7/42)`), check which signal feeds `ctlBaseline`, and review tier thresholds — they may need recalibration against real runner populations.
**Impact**: High — CTL feeds athlete tier, ACWR baseline, plannedTSS, and cross-training tier thresholds. A 222 CTL corrupts all downstream calculations.

---

### ✅ ISSUE-86: Reduce/Replace recommendation is wildly disproportionate to stated load *(fixed 2026-03-12)*
**Root cause (bug 1 — misleading headline)**: `pctAbove` was computed as `(ratio/safeUpper − 1) × 100` — the excess above the safety ceiling, not above baseline. "2% above your normal load" actually meant 2% above the 1.6× ceiling (i.e. 63% above baseline). Rule 1 zoneAdvice had the same error.
**Root cause (bug 2 — oversized cut)**: Synthetic activity duration had a `Math.max(20, …)` floor. A 3% ceiling overshoot (6 TSS excess) computed 7 min, got bumped to 20 min, inflating the load budget ~3× and pushing the cut near the 40% cap.
**Fix (bug 1)**: Added `pctAboveBaseline = Math.round((ratio − 1) × 100)` in `suggestion-modal.ts`. `humanConsequence` now references baseline, not ceiling. When pctAboveCeiling ≤ 5%, copy reads "Your load is just above the safe ceiling (1.63× vs 1.60×). A small adjustment is enough." Rule 1 zoneAdvice updated to use baseline %.
**Fix (bug 2)**: Changed floor from `Math.max(20, …)` → `Math.max(5, …)` in `main-view.ts` — keeps cut proportional to actual TSS excess for small overages.

---

### ISSUE-107: Verify "Wrap up week" Sunday behaviour on an actual Sunday *(P3)*
**What to check**: The "Wrap up week" pill in the plan header and the auto-show of the end-of-week debrief card are gated on `ourDay() === 6` (Sunday). Since this was built mid-week, it could not be tested on a Sunday.
**On the next Sunday, verify**:
1. "Wrap up week" pill appears in plan header on the current week
2. Debrief card auto-fires once (on first plan-view render that day), then not again
3. ✕ closes without advancing week; pill stays visible so user can re-open
4. "Complete week →" advances to the next week correctly
5. After completing, pill no longer shows (week marked completed)
**Files**: `src/ui/week-debrief.ts` (`shouldShowSundayDebrief`), `src/ui/plan-view.ts` (`buildWrapUpWeekBtn`, `renderPlanView` Sunday trigger).

---

### ✅ ISSUE-87: Two "Load Safety" bars on Stats — kill the second one *(fixed 2026-03-12)*
**Fix**: Removed the duplicate Load Safety bar from `stats-view.ts`.

---

### ISSUE-89: Sleep debt tracker *(P2)*
**Feature**: Show cumulative sleep deficit vs 7h/night target in the sleep detail sheet and/or Stats sleep section.
- "You're 3h 20m short of your 7h/night target this week" — computed from `sleepDurationSec` across last 7 days in `physiologyHistory`
- Threshold: 7h/night (25 200 sec). Weekly debt = `7 × 25 200 − sum(actualDurationSec)`, capped at 0 if in surplus
- Surface in: sleep sheet below the stage bars, and optionally the sleep insight sentence if debt > 3h
- **Depends on**: `sleepDurationSec` being populated (requires Garmin Connect sync to fill stages migration)

---

### ⚠️ ISSUE-88: km/mile unit tag not working *(partial — session killed mid-work, 2026-03-12)*

**Root cause**: `formatKm` was only wired in a handful of spots. The majority of distance displays were hardcoded `.toFixed(1) km` without reading `s.unitPref`.

**What IS done** (code in working tree, not yet committed):
- `formatKm` wired in: `plan-view.ts` (`buildWorkoutExpandedDetail`, `buildActivityLog`, `buildWorkoutCards`), `home-view.ts` (`buildTodayWorkout`, `buildNoWorkoutHero`, `buildRecentActivity`), `stats-view.ts` (distance card, Distance vs Plan bar, Running km label), `activity-detail.ts`, `activity-review.ts`, `suggestion-modal.ts`, `matching-screen.ts`, `gps-panel.ts`
- `account-view.ts` toggle wired — persists to state, re-renders on change
- All 779 tests pass, `npx tsc --noEmit` clean

**What is STILL hardcoded (remaining work)**:
1. `week-debrief.ts:209` — `${distanceKm} km` → needs `formatKm(distanceKm, unitPref)`
2. `record-view.ts:159,162` — live recording distance: `toFixed(1) km` and target distance label
3. `gps-completion-modal.ts:75` — post-run summary: `${actualDistKm.toFixed(1)} / ${plannedDistKm.toFixed(1)} km`
4. `suggestion-modal.ts:299` — km gap line: `${kmGap} km`
5. `wizard/steps/strava-history.ts:155,183` — `${avgKm} km/week` (onboarding; lower priority)
6. **Pace display** — `fp()`, `formatPace()`, all `M:SS/km` strings still hardcoded. Needs a `formatPace(secPerKm, unitPref)` that converts to `/mi` when in miles mode (sec/km × 1.60934 for the number; label `/mi` not `/km`). Affects: `plan-view.ts:145`, `activity-detail.ts:25`, `gps-panel.ts:33,71,213`, `stats-view.ts:940,1434`, `main-view.ts:659,849,853,1085`, `renderer.ts:475,528`, `strava-detail.ts:266,269`

**Nothing committed yet** — all session work is unsaved in the working tree.

---

---

### ISSUE-90: LT Threshold not surfaced in setup; no Garmin auto-pull *(P2)*
**Symptom**: Users need to manually input their LT HR from a Garmin device, which is non-obvious — most don't know where to find it. The app doesn't guide them.
**Design**:
1. Add in-setup guidance: where to find LT HR on Garmin (Physio True Up or LT test) with a screenshot/diagram.
2. Longer term: pull it automatically via the Garmin edge function (dailies or physio endpoint already returns `lactateThresholdBpm`).
**Files**: `src/ui/wizard/` (setup steps), `supabase/functions/garmin-webhook/` or `sync-physiology-snapshot`.

---

### ISSUE-91: Plan restart generates a different running profile — nondeterministic *(P2)*
**Symptom**: Restarting the plan (clearing state and going through wizard again) produces a different running profile and plan structure than the first time, even with the same inputs.
**Root cause**: Unknown — wizard initialisation may use non-deterministic logic or rely on stale state not fully cleared.
**Files**: `src/ui/wizard/`, `src/state/persistence.ts`, plan generation logic.

---

### ISSUE-92: Onboarding should display historic load scan before confirming plan *(P3)*
**Symptom**: The setup wizard never shows users proof that their training history was understood. Users have no confidence the plan is calibrated to them.
**Design**: After Strava backfill completes, show a summary screen: "We found X activities over N weeks · Average weekly load: Y TSS · Your ramp rate: Z%." Then let them confirm or adjust before the plan starts. Mirrors what a real coach would do.
**Files**: `src/ui/wizard/steps/initializing.ts`, `src/data/stravaSync.ts`.

---

### ✅ ISSUE-93: 8W / 16W / All chart tabs confusing *(fixed 2026-03-12)*
**Fix**: Removed "All" tab (or renamed/clarified) in `stats-view.ts`.

---

### ⚠️ ISSUE-94: Activity card map too zoomed out *(fix applied 2026-03-12 — needs device test)*
**Fix applied**: `drawPolylineOnCanvas` in `strava-detail.ts` now filters decoded coords where `|lat| < 1 && |lng| < 1` before computing bounds. Canvas hidden entirely if no valid points remain.
**To test**: open an activity with a map — it should zoom tightly to where you actually ran. If it previously showed a world-scale zoom, it should now show the local route. If the polyline was entirely garbage, the map card disappears rather than showing a broken view.

---

### ISSUE-95: Injury icon inconsistency — heart on some screens, emoji on others *(P2)*
**Symptom**: The injury/risk indicator uses a heart icon in some places and an unrelated emoji in others. Inconsistent iconography erodes trust and confuses users.
**Fix**: Standardise to a single icon everywhere (e.g. a shield or warning triangle). Remove any emoji used as a UI icon.
**Files**: `src/ui/home-view.ts`, `src/ui/plan-view.ts`, `src/ui/stats-view.ts`.

---

### ISSUE-96: "Start Run" goes to a blank record screen; should pre-load today's session *(P2)*
**Symptom**: Tapping "Start Run" on the Home page navigates to the record view, but the planned workout is not pre-loaded. The user has to tap "Go" again with no context about what they should be running.
**Fix**: Pass today's planned workout (distance, target pace, session description) into the record view when navigating from "Start Run" on the Home page.
**Files**: `src/ui/home-view.ts`, `src/ui/record-view.ts`, `src/ui/gps-events.ts`.

---

### ISSUE-97: Home load graph is confusing — candidate for removal *(P2)*
**Symptom**: The load bar chart on the Home page doesn't read clearly to users. It may duplicate information already shown in the load bars or Stats page.
**Decision needed**: Either redesign with a clear axis, legend, and explanation — or remove it and rely on the Stats page for load history.
**Files**: `src/ui/home-view.ts`.

---

### ISSUE-98: Activity card shows total load only — no split by sport type *(P2)*
**Symptom**: The load figure on activity cards is a single number (e.g. "93 TSS") with no breakdown. Users want to see e.g. "40 TSS Running / 53 TSS Tennis" to understand where the load came from.
**Fix**: Add a sport-type breakdown row to the activity load card when the week contains multiple sport types.
**Files**: `src/ui/activity-review.ts`, `src/ui/excess-load-card.ts`.

---

### ✅ ISSUE-99: Load on Plan page doesn't match load on Stats page *(fixed 2026-03-12)*
Both views now read from the same computation path.

---

### ✅ ISSUE-100: Injury risk label wording inconsistency — "Low" vs "Manageable" *(fixed 2026-03-12)*
**Fix**: Unified risk label vocabulary across all views (home, stats, renderer).

---

### ISSUE-102: Cross-training load missing from wk.actualTSS — fix applied, untested *(P1)*
**Symptom**: ACWR / injury risk is run-only. Padel, gym, surf, cycling contributed 0 to `wk.actualTSS`, making fatigue calculations blind to cross-training load.
**Root cause**: `addAdhocWorkout` and `addAdhocWorkoutFromPending` in `activity-matcher.ts` pushed workouts to `wk.adhocWorkouts` but never accumulated Signal B TSS onto `wk.actualTSS`. Matched runs (high-confidence path, line 533) correctly added TSS; the adhoc paths did not.
**Fix applied**: Both functions now compute raw iTRIMP TSS (Signal B, no runSpec) and add to `wk.actualTSS`. Covers all 6 call sites in `activity-review.ts`.
**Caveat**: Fix is forward-looking — activities already in `wk.adhocWorkouts` from before this fix are NOT retroactively added to `wk.actualTSS`. Clear state + re-sync to fully validate.
**Test**: Accept a pending cross-training activity → check `wks[w-1].actualTSS` in localStorage. Should increase by that session's TSS.
**Status**: ⚠️ Code deployed, not yet confirmed on device.

---

### ✅ ISSUE-104: HR target label implies whole session is Z4, including warm up/cool down *(fixed 2026-03-11)*
**Fix**: `buildWorkoutExpandedDetail` in `plan-view.ts` now detects warm up/cool down structure (checks for "warm up" in `w.d`) and appends "· main set" to the HR target label. Simple sessions show "Z4" alone; structured sessions show "Z4 · main set".

---

### ✅ ISSUE-106: Cross-training planned TSS inflated ~7× vs actual iTRIMP scale *(fixed 2026-03-12)*
**Root cause**: `TL_PER_MIN` is calibrated for running HR responses. Cross-training at the same RPE produces lower HR → lower iTRIMP → much lower actual TSS. A historical weekly→daily scale shift compounded this — displayed planned (103) vs actual (14) was consistently misleading for cross-training.
**Fix**: Cross-training planned TSS now uses `computeCrossTrainTSSPerMin()` (median iTrimp-based TSS/min from user's own history, in `fitness-model.ts`). Fallback when < 2 samples: `TL_PER_MIN[rpe] × sportRunSpec` (e.g. 0.40 for generic_sport). Planned vs actual bars suppressed for matched cross-training in both plan-view and activity-detail — RPE→HR mapping unreliable for non-running sports. Future unmatched cross-training still shows `~X TSS` using corrected formula. Running unchanged. `general_sport` alias added to `SPORTS_DB` so "General Sport" placeholders resolve correctly.

---

### ✅ ISSUE-103: Planned TSS in workout detail uses wrong scale *(fixed 2026-03-11)*
**Root cause**: `calculateWorkoutLoad()` used `LOAD_PER_MIN_BY_INTENSITY` (Garmin scale) for planned TSS; actual TSS used `TL_PER_MIN` (app scale). ~74% inflation on the planned side.
**Fix**: Replaced `calculateWorkoutLoad()` with a direct `TL_PER_MIN`-based computation at the top of `buildWorkoutExpandedDetail`. Both the "Planned Load" (future sessions) and "Training Load" planned vs actual bars now share a single `plannedTSS` on the correct scale.

---

### ISSUE-105: Garmin webhook 401 fix — needs device test *(P1, fix deployed 2026-03-12)*
**Root cause**: `garmin-webhook` was missing from `supabase/config.toml`. Supabase defaulted to `verify_jwt = true`, rejecting every Garmin push with 401. Sleep, dailies, and HRV data stopped flowing ~3 weeks ago.
**Fix applied**: Added `[functions.garmin-webhook] verify_jwt = false` to `config.toml`. Redeployed with `--no-verify-jwt`. JWT verification confirmed OFF in Supabase dashboard.
**To confirm fixed**: After next morning Garmin watch sync, check: (1) invocations tab shows 200s, (2) `sleep_summaries` has today's row with `duration_sec`/`deep_sec`/`rem_sec` populated, (3) `daily_metrics` has today's resting HR and stress.
**Files**: `supabase/config.toml`, `supabase/functions/garmin-webhook/index.ts`, `docs/GARMIN.md`.

---

## Priority Order

| Priority | Issue | Group | Effort | Impact |
|---|---|---|---|---|
| ✅ | ISSUE-79: plannedTSS not based on historic load | Arch | Large | Critical |
| ✅ | ISSUE-78: Prorated baseline broken on Monday | Stats | Small | High |
| ✅ | ISSUE-77: Activities not sorted by time | Plan | Small | High |
| ✅ | ISSUE-76: Garmin historic backfill | Edge fn | Medium | High |
| ✅ | ISSUE-81: Welcome-back modal removed | main.ts | Small | High |
| ✅ | ISSUE-80: Recovery score bar | Stats | Medium | High |
| ✅ | ISSUE-60: Week-end debrief | UI | Medium | High |
| ✅ | ISSUE-74: Info buttons don't work on Stats | Stats | Small | High |
| ✅ | ISSUE-73: Dig Deeper / Your Numbers hierarchy | Stats | Medium | High |
| ✅ | ISSUE-72: Split Your Numbers into Recovery/Running | Stats | Medium | High |
| ✅ | ISSUE-71: Remove Simulate Race button | Stats | Small | Low |
| ✅ | ISSUE-75: Running fitness improves without running | Calc | Medium | High |
| ✅ | ISSUE-20: Activity card UX | Cards | Medium | High |
| ✅ | ISSUE-19: Home load bars | Home | — | High |
| ✅ | ISSUE-08: Training Load bar unlabelled | Stats | — | High |
| P2 | ISSUE-89: Sleep debt tracker | Sleep sheet | Small | Medium |
| ⚠️ | ISSUE-88: km/mile tag not working — distances done, pace + 4 screens remain | Format | Small | High |
| ✅ | ISSUE-87: Two Load Safety bars — kill second one | Stats | Small | Medium |
| ✅ | ISSUE-106: Cross-training planned TSS inflated — historical calibration + bar suppression | Calc/UI | Small | High |
| ⚠️ | ISSUE-105: Garmin webhook 401 — fix deployed, needs device test | Edge fn | — | Critical |
| ✅ | ISSUE-86: Reduce recommendation 32% cut for 2% overshoot — disproportionate | Modal | Small | High |
| P1 | ISSUE-85: CTL 222 — inflated, corrupts all downstream calcs | Calc | Medium | Critical |
| P1 | ISSUE-83: TSS 245/330 — looks wrong, needs audit | Calc | Small | High |
| P2 | ISSUE-82: "How are you feeling?" check-in should be optional | Home | Small | Medium |
| P2 | ISSUE-84: HR zones chart visually ugly | Stats/Cards | Small | Medium |
| P2 | ISSUE-29: VDOT history | Stats | Medium | High |
| 🔨 | ISSUE-35: HR effort signal + drift + commentary (3 builds) | Feature | Large | High |
| P3 | ISSUE-33: 2 workouts/day | Feature | Medium | Low |
| P3 | ISSUE-37: Illness mode | Feature | Large | Medium |
| P3 | ISSUE-11: Auto-slot load | Feature | Large | Medium |
| ✅ | ISSUE-99: Plan page load ≠ Stats page load | Calc | Small | High |
| ✅ | ISSUE-100: Injury risk label "Low" vs "Manageable" mismatch | Copy | Small | Medium |
| P2 | ISSUE-90: LT Threshold setup guidance + Garmin pull | Setup | Medium | Medium |
| P2 | ISSUE-91: Plan restart nondeterministic profile | Wizard | Small | Medium |
| ✅ | ISSUE-93: 8W/16W/All tabs confusing | Stats | Small | Low |
| P2 | ISSUE-94: Activity maps too zoomed out, attribution clutter | Cards | Small | Medium |
| P2 | ISSUE-95: Injury icon inconsistency (heart vs emoji) | UI | Small | Low |
| P2 | ISSUE-96: Start Run goes to blank record screen | Home | Small | Medium |
| P2 | ISSUE-97: Home load graph confusing — remove? | Home | Small | Medium |
| P2 | ISSUE-98: Activity card no load split by type | Cards | Small | Medium |
| P3 | ISSUE-92: Onboarding historic load scan before plan start | Wizard | Medium | High |


---

## Architectural Considerations

These are not bugs or features — they are design decisions to revisit as the product grows.

### CONSIDERATION-01: localStorage as primary store vs Supabase as source of truth

**Current architecture**: localStorage is primary (fast, offline-first). Supabase is a backup — `user_plan_settings` table is written on every `saveState()` and read only when localStorage is empty (plan lost / new device).

**Why this is fine for now**: Capacitor (mobile) localStorage persists until uninstall. The backup means no user ever loses their plan. Single-device usage is the norm.

**When to revisit**: When users request multi-device sync (phone + tablet, phone + web). At that point, flip the architecture: Supabase becomes the source of truth, localStorage becomes a read-through cache. The data flows already exist — it's a meaningful but not huge refactor.

**Do not build this until a real user asks for it.**
