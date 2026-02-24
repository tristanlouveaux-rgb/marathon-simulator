# Changelog

Session-by-session record of significant changes. Most recent first.

---

## 2026-02-24 (Round 2)

### "Reduced due to strength" modReason still appearing from excess load card path (`src/ui/excess-load-card.ts`)
- **Bug**: `triggerExcessLoadAdjustment` used `mw.modReason || \`Excess load: ${sportLabel}\`` — `applyAdjustments` always sets `mw.modReason` to `"Reduced due to ${sportName}"`, so the fallback label never fired and the wrong format was stored.
- **Fix**: Changed to always use `` `Garmin: ${sportLabel}` `` (same pattern as the activity-review.ts fix), ensuring `openActivityReReview` cleanup filter (`startsWith('Garmin:')`) works for excess-load-card-sourced mods.

### Old "Reduced due to strength / due to gym" workout mods cleaned up on load (`src/state/persistence.ts`)
- **Bug**: Mods from before the modReason prefix fix were persisted in state with the wrong format (`"Reduced due to strength"`, `"Downgraded from threshold to steady due to strength"`). These can't be cleaned up by re-review (wrong prefix) and corrupt the workout card display.
- **Fix**: Added a one-time cleanup block in `loadState` that removes any `WorkoutMod` whose `modReason` contains `"due to strength"` or `"due to gym"`. Saves to localStorage only if something changed.

### Previous week's unresolved excess load carries over to current week (`src/state/persistence.ts`)
- **Bug**: `unspentLoadItems` is per-week. If the user advanced from week N to N+1 without dismissing/adjusting excess load, those items were invisible on the current-week Training tab (excess load card only renders `s.wks[s.w - 1]`).
- **Fix**: Added carry-over block in `loadState`: if `wks[w-2].unspentLoadItems` has items not already in `wks[w-1].unspentLoadItems` (checked by `garminId`), they're moved into the current week and cleared from the previous week. Idempotent — safe to run on every load.

### Sync Garmin guard now unblocks when suggestion modal is orphaned (`src/data/activitySync.ts`)
- **Bug**: The `_pendingModalActive` reset in `syncActivities` only checked for `activity-review-overlay` absence. If `suggestion-modal` was somehow orphaned (e.g. native iOS back gesture), the flag would remain stuck and future syncs silently returned early.
- **Fix**: Extended the check to `!document.getElementById('activity-review-overlay') && !document.getElementById('suggestion-modal')` — resets the flag only when neither modal is open.

---

## 2026-02-24

### "Reduced due to strength" modReason no longer appears on random workouts (`src/ui/activity-review.ts`)
- **Bug**: When all overflow cross-training items had `appType === 'other'`, the fallback `?? 'gym'` caused `normalizeSport('gym')` = `'strength'`, so `applyAdjustments` set `modReason = "Reduced due to strength"` on random workouts with no strength workout in the log. Additionally, `mw.modReason || \`Garmin: ${sportLabel}\`` always resolved to `mw.modReason` (since `applyAdjustments` always sets it), so the `"Garmin:"` prefix never made it into the stored mod — meaning the cleanup filter in `openActivityReReview` (which uses `startsWith('Garmin:')`) could never find and remove these mods.
- **Fix**: Changed fallback from `?? 'gym'` to `?? 'other'` in `applyReview`. Changed `modReason` in both `applyReview` and `autoProcessActivities` to always use `` `Garmin: ${sportLabel}` `` (dropped the `mw.modReason ||` prefix) so the cleanup filter works correctly.

### Today's workout not appearing after "Sync Garmin" when modal was previously cancelled (`src/data/activitySync.ts`)
- **Bug**: If the user cancelled the activity review modal earlier in the same session, `_pendingModalActive` was stuck at `true`. Subsequent calls to `processPendingCrossTraining()` — including via "Sync Garmin" — returned immediately at the guard, so newly synced activities were never surfaced. (Module-level JS state persists for the full app session on iOS Capacitor; only force-quit resets it.)
- **Fix**: In `syncActivities()`, before calling `processPendingCrossTraining()`, reset `_pendingModalActive = false` if `document.getElementById('activity-review-overlay')` is absent. Safe guard: if a review is already open the overlay exists and we don't reset.

---

## 2026-02-23 (Activity Matching UX Fixes)

### Matching screen: overflow items start in tray, not Excess Load bucket; excess load now correct; re-review choices preserved (`src/ui/matching-screen.ts`, `src/ui/activity-review.ts`)
- **Bug 1 (UX)**: No message telling the user that matches were pre-populated. Fixed: added "Suggested matches applied — move anything around if needed" subtitle to header.
- **Bug 2 (overflow placement)**: Unmatched activities were pre-assigned to the Excess Load bucket in the matching screen rather than sitting in the tray for the user to manually place. Fixed: overflow items now initialise as `null` (tray). The unassigned hint explains "confirm to send to Excess Load".
- **Bug 3 (no excess load after confirm)**: Tray-leftover items (null assignment) were not fed into `reductionItems` on confirm, so `populateUnspentLoadItems` was called with an empty list and `wk.unspentLoadItems` stayed empty. Fixed: `handleConfirm` now treats `val === null` identically to `val === 'reduction'` — both route to excess load.
- **Bug 4 (re-review auto log-only)**: After confirming, `applyReview` saved `updatedChoices` (which had reduction items changed to 'log') into `garminReviewChoices`. On re-review those items appeared as 'log only'. Fixed: the matching-screen confirm callback now saves the original `choices` to `garminReviewChoices` first; `applyReview` skips overwriting `garminReviewChoices` when `confirmedMatchings` is provided.
- **Cosmetic**: Confirm button is always green — unassigned items are valid (they become excess load), so grey/disabled styling was misleading.

### Cancel on activity review no longer blocks future syncs (`src/ui/activity-review.ts`)
- **Bug**: Pressing Cancel on either the intro screen or review screen left `_pendingModalActive = true` permanently (for the session). All subsequent calls to `processPendingCrossTraining()` — including via the "Sync Garmin" button — returned immediately at the guard check, so activities could never be reviewed again without force-quitting the app.
- **Fix**: Both cancel handlers (`#ar-cancel-intro` and `#ar-cancel`) now call `onComplete()` instead of `render()` directly. Since `onComplete` from `processPendingCrossTraining` resets the flag and calls `render()`, behaviour is identical except the guard is correctly released. Activities remain in `wk.garminPending` as `'__pending__'` so they re-appear on the next sync.



### Gym overflow no longer triggers run-reduction modal (`src/ui/activity-review.ts`)
- **Bug**: When HIIT/gym activities couldn't find a planned gym slot, they fell into `gymOverflow` → `remainingCross`, which went through `buildCrossTrainingPopup` and suggested reducing running sessions "due to strength" (because `normalizeSport('gym')` = `'strength'`). This is semantically wrong — gym sessions don't substitute for aerobic running load.
- **Fix**: In both `applyReview` and `autoProcessActivities`, gym overflow is now handled separately: each item is logged as an adhoc workout without triggering the cross-training load modal. Only true cross-training overflow (sports, rides, etc.) triggers plan reduction suggestions.

### Matched gym/cross slots now show activity name (`src/ui/activity-review.ts`, `src/ui/renderer.ts`, `src/types/state.ts`)
- **Bug**: When a planned "Gym" or "Cross Training" slot was matched to a Garmin activity (e.g. HIIT, Tennis), the slot card just showed "Done" and a duplicate adhoc card ("HIIT (Garmin)") appeared alongside it.
- **Fix**: Slot matches for gym and cross now store `garminActuals` with a `displayName` field (like run slots already did), without creating a duplicate adhoc card. In the renderer: calendar cards show "→ Tennis" / "→ HIIT" status labels, gym detail cards show the activity name + duration/HR, cross detail cards show a "Matched: Tennis" orange banner. Added `displayName?: string` to `GarminActual` type.
- Also improved garmin ID detection in renderer to use `garminActuals.garminId` for all slot types (not just workoutMod-based detection).

### Tap occupied matching screen slot → return to tray (`src/ui/matching-screen.ts`)
- **Fix**: Tapping an occupied slot card with no activity selected now deassigns that activity back to the tray. Previously it did nothing (`return` early). Added "Tap to return to tray" hint on occupied slots when nothing is selected.

---

## 2026-02-23 (Matching Week Boundary Fixes — Round 3)

### Smarter planStartDate derivation + garmin data reset (`src/state/persistence.ts`)
- Old formula `today − (w−1)×7` assumed today is the *first* day of week `w`. But when the user completes week `w` on its final day (e.g., Monday is day 1 of the next real calendar week), the formula is off by 7 days. This caused week boundaries to be wrong by an entire week.
- New `derivePlanStartDate()`: scans all weeks' `garminPending` and adhoc workout timestamps to find the earliest recorded Garmin activity, then anchors: `planStartDate = Monday(earliestActivity) − (w−1) × 7`. Falls back to Monday of today if no activity timestamps exist.
- New `clearGarminData()`: when `planStartDate` is first derived (was missing), clears all garmin matching data across every week (`garminMatched`, `garminActuals`, `garminPending`, `garminReviewChoices`, `unspentLoadItems`, garmin adhoc workouts, and Garmin-auto-completed RPE ratings). The next sync redistributes everything to the correct weeks via the week-aware matching code.

---

## 2026-02-23 (Matching Week Boundary Fixes — Round 2)

### Week-aware date label in navigator (`src/ui/main-view.ts`)
- The `<p>` showing the date range ("Mon 17 Feb – Sun 23 Feb") had no DOM ID. `updateViewWeek` couldn't update it, so the date stayed frozen at the initial render's week.
- Added `id="week-date-label"` to the element and wired `updateViewWeek` to update it via `getWeekDateLabel(s, viewWeek)` on every navigation step.

### Week-aware activity matching rebuilt (`src/calculations/activity-matcher.ts`)
- `matchAndAutoComplete` always wrote to `wks[s.w - 1]` (current week) and used a single date window. With the "last 7 days" fallback (when `planStartDate` was missing), all recent activities landed in the current week regardless of which plan week they actually belonged to.
- Rebuilt: activities are now grouped by their correct plan week using `weekIndexForDate()` (derived from `planStartDate`), then processed against that week's data.
- `regenerateWeekWorkouts` now takes an explicit `weekIdx` parameter (instead of using `s.w`) so VDOT, skips, and trailing effort are correct for the target week.
- Past-week cross-training: logged as adhoc directly in that week (no modal — the week is done).
- Past-week unmatched runs: logged as adhoc in that week.
- Current-week cross-training / low-confidence runs: still queued for user review via Activity Review (unchanged).

## 2026-02-23 (Matching Week Boundary Fixes)

### `planStartDate` never derived for existing v2 users (`src/state/persistence.ts`)
- The derivation of `planStartDate` was inside `migrateState()` but below the early-return for users already on schema v2. As a result, any user who had been on schema v2 before `planStartDate` was added never got it set, causing week dates to not show in the UI and the date-range filter to fall back to "last 7 days".
- Fixed by moving the derivation into `loadState()` as an always-run block (independent of schema version). Saves the derived date back to localStorage immediately.

### Cross-week activity re-matching (`src/calculations/activity-matcher.ts`)
- `matchAndAutoComplete` only checked the current week's `wk.garminMatched` when de-duplicating incoming rows. After advancing a week, activities already matched in previous weeks were invisible to this check, re-appeared as "new", and could be re-queued for the current week if their date fell within the new week's window.
- Fixed by building a global set of all garmin IDs processed in any week across `s.wks` before filtering. Any ID present in any week's `garminMatched` is excluded.

---

## 2026-02-23 (Activity Review UX Polish — Round 2)

### Matching Screen — bucket contents visible + removable (`src/ui/matching-screen.ts`)
- Items in the **Excess Load** and **Log Only** buckets now shown as chips inside their bucket.
- Tapping a chip (× button) returns that activity to the tray (unassigned); re-select and re-assign to a slot.
- Original review-screen "Log Only" items shown as non-removable static chips (no ×); manually-sent items have ×.
- Bucket click handler guards against chip taps (stopPropagation → chip click handled separately).
- Log-only (review-screen `choices === 'log'`) items removed from the tray entirely — they're already in the log-only bucket.
- Tray section renamed "Select Activity"; shows "X in slots ✓" count.
- Added `weekLabel?: string` param to `showMatchingScreen`; shown in header under "Assign Activities".

### Week/Date Header everywhere
- **Activity Review header** (`src/ui/activity-review.ts`): shows "Week 4 of 10 · Mon 17 – Sun 23 Feb" below the title.
- **Matching Screen header**: shows same label (computed + passed from activity-review.ts).
- Computed from `planStartDate + (w-1)*7`.

### Garmin Activities Filtered to Current Week (`src/data/activitySync.ts`)
- `processPendingCrossTraining` now computes current week date range from `planStartDate` and filters `unprocessed` to only items within that range. Prevents activities from previous weeks appearing in the review.

### Excess Load Card Always Visible (`src/ui/excess-load-card.ts`)
- When `unspentLoadItems` is empty, renders a subtle grey empty-state card ("No overflow — all activities matched to plan slots") so the section is always visible and the user can confirm the feature is wired correctly.

---

## 2026-02-23 (Activity Review UX Polish)

### Choice Persistence (`src/ui/activity-review.ts`)
- Integrate/Log choices now persist on refresh: `showActivityReview` falls back to `wk.garminReviewChoices` when no explicit `savedChoices` provided.
- Toggle changes are saved to `wk.garminReviewChoices` + `saveState()` immediately, not just on Apply.

### Matching Screen Improvements (`src/ui/matching-screen.ts`)
- Slot cards now ordered by day of week (Mon→Sun).
- Slot cards show actual calendar dates ("Mon 23 Feb") when `weekStartDate` is available; `activity-review.ts` computes and passes this from `planStartDate + (w-1)*7`.
- Activity tray sorted by type: runs first → gym → cross/other, then chronologically.
- Assigned activities disappear from tray to save space; re-tapping an occupied slot bumps the old activity back to the tray.
- Tray shows "X assigned ✓" count header; shows "All activities assigned ✓" when tray is empty.
- Activity cards show actual date ("Mon 23 Feb") from `item.startTime`.
- `showMatchingScreen` signature gains optional `weekStartDate?: Date` param (non-breaking).

### Toast Animation (`tailwind.config.js`)
- Added `fade-in` keyframe and `animate-fade-in` animation so toast slides in from below.

---

## 2026-02-23 (Activity Matching UX Redesign)

### UnspentLoadItem Type (`src/types/state.ts`)
- Added `UnspentLoadItem` interface: `garminId`, `displayName`, `sport`, `durationMin`, `aerobic`, `anaerobic`, `date`, `reason`.
- Added `unspentLoadItems?: UnspentLoadItem[]` to `Week` interface alongside existing `unspentLoad: number`.

### Assignment Toast (`src/ui/toast.ts` — NEW)
- `showAssignmentToast(lines)` renders a floating dark card above the tab bar with one line per assignment.
- Lines format: `"Activity → Workout Day"`, `"Activity → Excess load"`, `"Activity → Logged (no plan impact)"`.
- Auto-dismisses after 5s; tap anywhere on toast to dismiss early. Replaces any existing toast.

### Excess Load Card (`src/ui/excess-load-card.ts` — NEW)
- `renderExcessLoadCard(wk)` returns empty string if no `unspentLoadItems`; otherwise renders a persistent amber card on the Training tab.
- Shows aerobic + anaerobic mini-bars, [Adjust Plan] and [Dismiss] (two-tap) buttons.
- Tapping card body opens `showExcessLoadPopup()` listing each UnspentLoadItem with mini-bars.
- `triggerExcessLoadAdjustment()` builds a combined activity from all items, calls existing `buildCrossTrainingPopup()` + `showSuggestionModal()` flow, then clears items on decision.
- Wired into `main-view.ts` via `renderExcessLoadCard()` + `wireExcessLoadCard()`.

### Matching Screen (`src/ui/matching-screen.ts` — NEW)
- `showMatchingScreen(overlay, pending, choices, pairings, allWorkouts, onConfirm, onBack)` replaces the dropdown-based `showMatchingConfirmation()`.
- Horizontal scrollable slot cards (week workout slots) + horizontal activity tray + Reduction and Log-only buckets.
- Tap activity to select (blue highlight), tap slot to assign (compatibility check), tap bucket to send there.
- Pre-populated from `proposeMatchings()` — overflow items start in Reduction bucket.
- Compatible types enforced: run→run slots, gym→gym slots, cross→cross slots; incompatible taps ignored.
- Confirm callback returns `(confirmedMatchings, reductionItems, logonlyItems)`.

### Activity Review Redesign (`src/ui/activity-review.ts`)
- `showReviewScreen()` ar-apply handler now routes ≥2 integrate items to `showMatchingScreen()` instead of `showMatchingConfirmation()`.
- `populateUnspentLoadItems()`: adds reduction-bucket items to `wk.unspentLoadItems`.
- `buildAssignmentLines()`: builds toast-ready strings for all pending items.
- `autoProcessActivities()`: now calls `showAssignmentToast()` after all assignments; overflow items get added to `unspentLoadItems` before showing suggestion modal; on modal dismiss, unspentLoadItems remain (excess load card fallback); on modal confirm, clears overflow items from unspentLoadItems.
- Removed local `ProposedPairing` interface (moved to `matching-screen.ts` as shared type).

---

## 2026-02-23

### Plan Start Date & Week Date Range (`renderer.ts`, `state/`)
- Added `planStartDate` to state, set on first render if absent.
- Week header now shows the actual Mon–Sun date range (e.g. "17–23 Feb") derived from `planStartDate + (w-1)*7`.
- Calendar columns labelled Mon/Tue/.../Sun instead of generic day numbers.

### Auto-Process Single Garmin Activities (`ui/activity-review.ts`, `data/activitySync.ts`)
- When exactly one activity is pending and the match confidence is high, the review screen is bypassed and the activity is applied automatically with a brief toast notification.
- Multi-activity batches still go through the full review flow.

### Matching Confirmation Screen (`ui/activity-review.ts`)
- For batches of ≥2 "integrate" activities, a new intermediate screen appears between the integrate/log choices and `applyReview`.
- Each activity is shown with a dropdown pre-populated with the algorithm's proposed workout pairing.
- First dropdown option is always "⚠ No slot — load adjustment modal" (overflow).
- Users can reassign any pairing before confirming.
- "← Back" re-renders the review screen in-place (overlay reuse, no layout shift).
- On confirm, `applyReview` receives a `confirmedMatchings: Map<string, string | null>` that overrides all auto-matching; the day-proximity generic cross-slot heuristic is skipped when this map is present.
- New helpers: `proposeMatchings()` (dry-run of matching logic), `activityEmoji()`, `workoutTypeShort()`.

### Runner-Type Proportional Load Reduction (`cross-training/suggester.ts`, `ui/events.ts`, `ui/activity-review.ts`)
- Added optional `runnerType?: 'Speed' | 'Endurance' | 'Balanced'` to `AthleteContext`.
- Speed runners: `buildReduceAdjustments` sorts candidates volume-first (easy runs cut before quality downgrades).
- Endurance/Balanced: existing intensity-first behaviour preserved.
- Both `events.ts` call sites and the `activity-review.ts` ctx construction pass `s.typ`.

### Workout Card Labels + Undo Button (`ui/renderer.ts`)
- Detail card banner: "RUN REPLACED" → "Replaced by HIIT" / "Reduced — Tennis (45min)". Strips "Garmin: " prefix from `modReason` before display.
- Calendar compact status label: "Replaced" → "→ HIIT".
- Calendar cyan sub-line: shows activity name without prefix.
- Undo button in the banner calls `window.openActivityReReview()` to reopen the review modal.
- New test file `src/ui/renderer-labels.test.ts` (19 tests) covering all three label helpers — all passing.

### Welcome Back / Missed Week Detection (`ui/welcome-back.ts`, `main.ts`)
- `detectMissedWeeks()`: computes number of full weeks elapsed since the plan's current week end date.
- `showWelcomeBackModal(weeksGap, onComplete)`: modal shown once per calendar day (guarded via localStorage) when the user returns after ≥1 missed week.
- Applies VDOT detraining: ~1.2%/week for weeks 1–2, ~0.8%/week thereafter (diminishing compound).
- 3+ week gaps: sets training phase to `'base'`.
- Experience-level awareness: shows fitness-data-focused messaging for competitive/elite/hybrid/returning users.
- Wired into `launchApp()` in `main.ts`; fires before `renderMainView()`.

### Load Modal Improvements (`ui/suggestion-modal.ts`)
- Runner type context line: "Speed runner · Volume cuts prioritised — quality sessions protected".
- Equivalent easy km badge: "≈ 8.4 km easy running equivalent".
- Improved downgrade detail text: "Keep 8km — drop to steady pace (MP–easy midpoint)".
- Warnings rendered in amber (`text-amber-500`).

---

## 2026-02-12

### Phase Transition Fixes (`engine.ts`)
- **Acute phase gate**: Was using a 72-hour real-time gate (`ACUTE_PHASE_MIN_HOURS`). In the simulator users click through weeks so 72 hours never passes. Fixed: `canProgressFromAcute()` now also accepts `state.history.length >= 2` (one weekly check-in after initial report).
- **Pain regression**: Added general regression at the top of `evaluatePhaseTransition()`. Pain ≥ 7 in any non-acute phase → back to acute. Pain ≥ 4 in test_capacity / return_to_run / graduated_return → regress one phase via `applyPhaseRegression()`.

### Graduated Return Workout Descriptions (`engine.ts`, `intent_to_workout.ts`, `renderer.ts`)
- Rewrote graduated return downgrade in `applyInjuryAdaptations()` to handle multi-line descriptions correctly.
- `extractLines()` splits on `\n`, separates WU/CD from main set. `stripMainSet()` strips both zone-labeled and bare paces.
- Marathon Pace and progressive workouts now downgrade to "steady" pace (halfway between easy and threshold), not "easy".
- Distances rounded to nearest 10m (`fmtDist()`: `Math.round(km * 100) * 10`).
- Long Run (Fast Finish) → "Steady Run". Marathon Pace → "Steady Pace".

### Complete Rest UI Scoping (`renderer.ts`)
- `w.t === 'rest'` check was too broad — suppressed rating UI for ALL rest workouts. Added `isCompleteRest` flag that only matches workouts containing "RICE", "No physical activity", or "Complete rest" in their description.

### Cross-Training Suggester for Downgraded Workouts (`generator.ts`, `suggester.ts`)
- **Stale loads**: `generateWeekWorkouts()` calculated loads before `applyInjuryAdaptations()`. Fixed by adding a load recalculation loop after injury adaptations.
- **Invisible workouts**: `buildCandidates()` was filtering out `status: 'reduced'` workouts. Added `alreadyDowngraded` field to `PlannedRun`. Reduced workouts now appear with a -0.50 similarity penalty.
- Excluded `return_run`, `capacity_test`, and `gym` from cross-training candidate pool.

---

## 2026-02-11

### Workout Description Overhaul (`intent_to_workout.ts`, `renderer.ts`, `parser.ts`)
- VO2/Threshold descriptions no longer show pace twice.
- New multi-line format: `1km warm up\n5×3min @ 3:47/km (~790m)\n1km cool down`.
- `wucdKm()` helper adds WU/CD if session is under 30 min.
- Calendar compact view shows main set only for VO2/Threshold.

### Load Calculator Fix (`load.ts`) — Critical
- `calculateWorkoutLoad()` was parsing `1km` from the warm-up line, giving VO2 a load of ~20 instead of ~135.
- Fixed: multi-line handler strips WU/CD lines, parses main set, adds WU/CD time at easy pace.

### Cross-Training Downgrade Structure Preservation (`suggester.ts`)
- `applyAdjustments()` now inspects the original description format. Intervals stay as intervals at lower pace; progressive runs become plain easy long runs.
- Added `paces?: Paces` parameter so actual pace values appear in descriptions.

### Replace vs Reduce — Interleaved Algorithm (`suggester.ts`)
- Replaced the old two-pass algorithm. New interleaved: replace 1 → reduce/downgrade 1 → replace 1... Naturally scales with budget.

### Easy Run Replacement Fix (`renderer.ts`)
- Apply stored mods before deduplicating names. Previously mods stored "Easy Run" but the lookup happened after rename to "Easy Run 1" etc.

### Steady Pace for Threshold Downgrades (`suggester.ts`, `suggestion-modal.ts`)
- Threshold downgrades show steady pace = `(paces.e + paces.t) / 2` rather than true marathon pace.

### Replaced Workout UX (`renderer.ts`)
- "LOAD COVERED" → "RUN REPLACED". Shows original description struck through. Forecast load hidden for replaced workouts.

---

## 2026-02-10

- Gym integration: `gym.ts` with phase-aware templates, 3 ability tiers, deload + injury filtering.
- `graduated_return` injury phase (2-week bridge between return_to_run and resolved).
- Detraining model during injury — negative `wkGain` per phase.
- Three-option exit from return_to_run: full return / ease back in / not yet.
- Volume selector in onboarding for gym sessions (0–3/week).

---

## 2026-02-09

- Functioning model: full plan generation, injury system, cross-training integration.
- Recovery engine (morning check-in, sleep/readiness/HRV scoring).
- Continuous mode with 4-week block cycling and benchmark check-ins.

---

## Pre-February 2026

- Initial codebase: onboarding wizard, VDOT engine, plan generation, injury system.
- GPS tracking with provider abstraction and split detection.
- Universal load model for cross-training.
- Physiology tracker with adaptation ratio.
- Training horizon model with guardrails.
