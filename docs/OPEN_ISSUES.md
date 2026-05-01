Note: we have had a persistence problem of open issues not being correctly logged after long conversations. Going forward can we make it clear with answers to all questions put in here in order to most clearly reflect desired set up
# Open Issues

> **Workflow**: Tristan logs raw bugs/observations in `.claude/TL thoughts`.
> Claude reads that file, triages, and maintains this structured list.
> P1 = broken or actively misleading · P2 = confusing/unclear · P3 = missing feature/future
> **UX overhaul items** are tagged `[ui-ux-pro-max]` — handled via that skill in a dedicated session.

---

## 🔴 TOP PRIORITY — Next session

### ISSUE-151: Triathlon mode shows the running suggestion modal for cross-training overload *(P2, 2026-04-30)* — **🟡 awaiting in-app confirmation**

**Status**: Code changes shipped 2026-04-30 (see CHANGELOG). Per CLAUDE.md issue-tracking workflow, do not mark `✅ FIXED` until Tristan has confirmed the fix in-app on a real Ironman setup. To verify: in tri mode, sync (or manually log) a cross-training session of ~80–90 min that pushes the week ~20% over plan — expect the **tri** suggestion modal (per-discipline mod, no "easy running equivalent" copy), not the running modal.

**What changed**:
1. New detector `src/calculations/tri-cross-training-overload.ts` — fires when cross-training TSS > 15% of planned weekly tri TSS.
2. Wired into `tri-suggestion-aggregator.ts` as a fourth detector (source: `'cross_training_overload'`).
3. Mode-aware modal routing — running modal suppressed in tri mode at: `activity-review.ts` (both `showSuggestionModal` callsites + new `redirectToTriSuggestionFlow` helper), `events.ts:logActivity`, `main-view.ts:triggerACWRReduction`, `excess-load-card.ts:triggerExcessLoadAdjustment` (defensive). `gps/recording-handler.ts:196` deliberately untouched (run-only, see CHANGELOG entry for rationale).
4. 11 unit tests + 1 aggregator integration test pinning thresholds and the running/tri routing.

**Once Tristan confirms in-app**: change status to `✅ FIXED` and move to the resolved section.

---

### ISSUE-152: Triathlon — real-world dogfooding before next feature push *(P1, 2026-04-30)*

**Context**: Across the last few sessions we've shipped a substantial body of triathlon work — race prediction (Phases 1, 2A, 2B), course-aware scoring, durability cap, suggestion modal, sync-time activity matching, per-session HR effort scoring (bike + swim), `triEffortMultiplier` auto-progression, race-outcome logging, marker-bump toasts, and the end-of-week debrief modal. 1234 tests pass. **None of it has been validated against real-world activity data over multiple weeks.**

**Why this is a P1**: Tristan is doing an actual 24-week IM build. The next high-leverage move isn't another feature — it's noticing what's wrong, missing, or annoying when the system runs against real activity, real RPE ratings, real marker bumps. We've built faster than we've validated.

**What "doing this" looks like**:
1. Use the app daily for 1–2 weeks of actual training.
2. Each time something feels off (prediction stale, multiplier didn't apply, marker bump didn't surface, debrief modal said something weird, a session's RPE didn't propagate), dump it in `.claude/TL thoughts`.
3. Next session: triage TL thoughts into discrete issues, fix the top 5.

**Concrete things to watch for**:
- Marker-bump toast actually fires on a real CSS / FTP / VDOT improvement
- Effort multiplier visibly changes session durations after 2 consecutive easy-rated weeks
- End-of-week debrief fires on Monday morning with sensible content
- Suggestion modal fires when expected (volume-ramp, RPE-blown, readiness)
- Race-day handling once the user actually races

**No code change required.** This is a process item — once we have field data, we'll know what's worth building.

---

### ISSUE-153: Triathlon — completed-efforts tracking page (mirror running's pattern) *(P2, 2026-04-30)*

**Context**: Running mode has a tracking surface that shows completed sessions vs planned (effort scores, pace adherence, HR drift per session). Triathlon has none of that — a completed `triWorkout` shows `status='completed'` in state but the user has no surface to review their week of completed sessions per discipline.

**Why this matters**: It's the largest user-facing gap remaining in tri mode. The Stats page shows the forecast and adaptation; the Load page shows training load; but neither shows "here are the sessions I actually did, how I rated them, and how my HR / pace tracked vs planned".

**What it looks like**:
- New tri view (likely `src/ui/triathlon/tri-tracking-view.ts`) accessible from Stats or Plan
- Per-week list of completed sessions grouped by discipline
- Each row: workout name, planned vs actual duration, RPE rated, `hrEffortScore` (if available), `paceAdherence` (if available)
- Sparkline of effort trend per discipline (RPE deviation week-over-week)

**Mirror reference**: Running's progress views (`src/ui/triathlon/progress-detail-view.ts` for visual style, plus running's activity history surfaces). Per CLAUDE.md mirror rule, structure should match.

**Estimated**: ~3–4 hours.

---

### ISSUE-154: Triathlon — manual brick tagging *(P3, 2026-04-30)*

**Context**: Brick auto-detection (`detectBricks` in `src/calculations/brick-detector.ts`) pairs a bike followed by a run within 30 minutes. Some users record bike + run as a *single* Strava activity (sport: brick or multi-sport) — auto-detection misses these.

**Fix**: Let the user manually tag two activities as a brick pair from the activity-detail modal. Store linkage on `garminActuals.brickPairId` (UUID generated on tag); `runTriActivityMatching` checks `brickPairId` first, falls through to auto-detection.

**Files involved**:
- `src/types/state.ts`: add `GarminActual.brickPairId?: string` (optional per iOS-ship rule)
- `src/ui/activity-detail.ts`: add "Tag as brick" action + picker for partner activity
- `src/main.ts → runTriActivityMatching`: read `brickPairId` before falling through to `detectBricks`

**Estimated**: ~1–2 hours.

---

### ISSUE-155: Triathlon — per-discipline rawTSS routing for non-power-meter cyclists *(P3, 2026-04-30)*

**Context**: `computeBikeTssFromHr` (HR-based bike TSS) and `computeSwimTss` (pace-based swim TSS) exist in `src/calculations/triathlon-tss.ts:71–86` and `:30–40` but are never called. Currently in tri mode, bike and swim activities don't reach per-discipline CTL because `rawTSS` computation is gated to running activities (`activity-matcher.ts:605`).

**Effect**: Users without a power meter get less accurate per-discipline CTL/ATL/Form readings. The display falls back to whatever the matrix-based estimator produces, which is conservative.

**Fix**: extend `activity-matcher.ts` so in tri mode:
- Bike with power → `computeBikeTssFromPower` (squared IF) — already exists
- Bike with HR only → `computeBikeTssFromHr`
- Swim with pace → `computeSwimTss` (cubic IF, Toussaint 1992)
- Result writes to `garminActuals.rawTSS` for tri mode (parallel to running)

**Estimated**: ~2 hours. Tests should verify HR-only bike TSS values match the published Coggan zones.

---

### ISSUE-149: iOS build — remaining wiring + on-device verification *(P1, 2026-04-27)*

**Context**: iOS platform scaffold landed 2026-04-16 (ISSUE-134/136). Voice plugin, haptics adapter, Info.plist, bundle rename to Mosaic are all in code. But the build has never run on a physical device.
**Remaining items**:
1. **On-device test.** Open Xcode (`npx cap open ios`), sign with a Team, build to iPhone. Verify: voice over silent switch, voice while screen locked, music ducking (Spotify/Apple Music), haptic ticks on step transitions.
2. **Wire `keep-awake` into Record tab.** `src/guided/keep-awake.ts` has `enableScreenAwake()`/`disableScreenAwake()` but they are not called anywhere. Hook into `startTracking`/`stopTracking` in `src/ui/gps-events.ts` when a guided run is active.
3. **Wire `BackgroundGeolocation.ready(GUIDED_RUN_LOCATION_CONFIG)`.** Config object is in `src/guided/background-location.ts`. Needs a call site in the tracker bootstrap that uses Transistorsoft on native and falls back to `navigator.geolocation` on web.
4. **Xcode signing.** `com.mosaic.training` bundle ID is set but no Team / provisioning profile selected yet.
5. **App icon + launch screen.** Still Capacitor placeholder assets.
**See also**: `docs/IOS_SETUP.md` "Remaining work" section for the full checklist.
**Files**: `src/ui/gps-events.ts`, `src/guided/keep-awake.ts`, `src/guided/background-location.ts`, `ios/App/App/Assets.xcassets/`.

---

### ISSUE-150: Gym programme overhaul — Whoop-level UX from onboarding to tracking *(P2, 2026-04-27)*

**Problem**: The gym module is the weakest part of the app. A single `gs` field set at onboarding, hardcoded templates that repeat weekly with no progression, synced WEIGHT_TRAINING activities that don't tick off planned sessions, no exercise customisation, no strength tracking, and second-class UI treatment in both Home and Plan views.
**Full spec**: `docs/GYM_PROGRAMME_SPEC.md` — contains the complete question set (39 items across 11 categories) that must be answered before implementation starts.
**Scope categories**:
1. Positioning (support-for-running vs second pillar)
2. Scope/ambition (progressive overload vs enhanced templates)
3. Onboarding inputs (equipment, 1RMs, goals, preferences)
4. Programme design (progression model, periodisation, mobility blocks)
5. In-session UX (live logging vs mark-done, rest timer, live screen)
6. Run plan integration (scheduling constraints, mid-plan changes)
7. Activity matching (auto-complete planned slots from synced data)
8. Load/fatigue model (Signal A/B treatment, recovery impact)
9. UI surfaces (drill-down view, home card, plan row, strength history)
10. Edge cases (non-WEIGHT_TRAINING gym, detraining, injury downgrade)
11. Direction (greenfield spec vs incremental evolution)
**Current state**: `src/workouts/gym.ts` (templates), `src/types/state.ts:324` (`gs` field), `src/ui/wizard/steps/volume.ts:45-56` (onboarding), `src/ui/home-view.ts:1674-1758` (home card), `src/ui/plan-view.ts:471-473` (plan row), `src/calculations/activity-matcher.ts:473-492` (matching).
**Next step**: Tristan answers the spec questions in `docs/GYM_PROGRAMME_SPEC.md`, then we build a phased implementation plan.

---

### ISSUE-148: Recurring activities — add flow in Account *(P3, 2026-04-25)*

**Problem**: Account → Training → Recurring activities only supports remove (× per row). Users can't add a new recurring sport without re-onboarding via Reset.
**Why deferred**: Add flow needs the same sport-picker / duration / intensity picker that lives in `wizard/steps/schedule.ts`. Lifting that into a reusable modal is non-trivial — separate task.
**Files**: `src/ui/account-view.ts` (`showRecurringActivitiesModal`), `src/ui/wizard/steps/schedule.ts` (sport picker logic to extract).
**Workaround**: Reset (Account → Advanced → Reset) and re-onboard. Existing PBs / physiology / Strava connection are preserved by `softResetState`.

---

### ✅ ISSUE-147: Just-Track mode — synced activities don't surface in local feed *(resolved 2026-04-23)*

**Resolved by the Just-Track redesign** (CHANGELOG 2026-04-23). Option (a) chosen: `initializeSimulator` now seeds a rolling 1-week bucket and `advanceWeekToToday` extends it one week per calendar week. Sync pipeline writes into `wk.garminActuals` unchanged. Activity feed, recent activity, and weekly summaries now populate identically to planned users.

---

### ✅ ISSUE-129: plan-view.ts uncommitted work wiped by `git checkout --` *(reconstructed 2026-03-22)*
**What happened**: Claude ran `git checkout -- src/ui/plan-view.ts` to undo cosmetic changes, destroying all uncommitted work.
**Fix**: All code reconstructed. Illness banner (`buildIllnessBanner`), running km bar (`weekKmBar`), week overview / coach insight pills (`buildWeekOverview`), and check-in button all confirmed present in `plan-view.ts`. CLAUDE.md updated with hard rule against `git checkout --`.

---

### ISSUE-137: Excess-load modal hides Reduce option when a tempo remains *(P1, fix pending confirmation — 2026-04-15)*

**Problem**: When extra cross-training load pushes the week over target, the modal only shows Push / Keep — even when a tempo or other quality workout is still on the plan. "Recommended" green appears on Keep with no explanation.
**Root cause**: `suggester.ts:1002-1018` caps the reduction budget by `capFraction = maxReductionTSS / fullRrcTSS`. When the overshoot is small relative to the full run-replacement credit, `effectiveRRC` drops below `minLoadThreshold` (5 load units). `buildReduceAdjustments` then short-circuits at line 529 before any candidate is evaluated, silently returning zero adjustments.
**Fix applied**:
- `suggester.ts:529`: only break when at least one adjustment has been proposed.
- `suggester.ts:545`: first quality downgrade records its true `loadReduction` instead of a tiny budget-clipped number (controlled overshoot preferred to silent suppression).
- `suggestion-modal.ts`: when `!hasReductions && !hasReplacements`, show an explanation banner and move the "Recommended" green from Keep → Push (carrying forward is the better default; Keep is the fallback).
- `km-budget.test.ts`: assertion loosened to allow overshoot by ≤ single largest adjustment's load.
**Status**: Awaiting Tristan to reproduce on-device with the screenshot scenario (5 cross-training activities, tempo remaining) and confirm Reduce now appears.

---

### ISSUE-138: Recovery workout tier added (easy → recovery downgrade) *(P2, provisional constants — 2026-04-15)*

**Problem**: When remaining runs are all already at or near the running floor and all easy, the suggester has no lever to absorb excess load — Reduce returns empty.
**Fix applied**: Introduced a new `'recovery'` `WorkoutType` as the bottom of the intensity ladder. `downgradeType` chain extended: `… → marathon_pace → easy → recovery`. Easy distance-reduction branch now falls back to an easy → recovery conversion when the floor blocks a km cut (preserves distance, reduces load). Recovery counts toward `floorKm` at 1.0x (simplest — movement is movement).
**Wiring**: Type def (`types/training.ts`), load profile (`constants/workouts.ts`), pace in `workouts/load.ts`, HR zone (`heart-rate.ts` → Z1), matcher pace (`activity-matcher.ts`), renderer colour (`renderer.ts`).
**Provisional constants flagged for review** (written while Tristan was away; see `docs/SCIENCE_LOG.md`):
  - `LOAD_PROFILES.recovery = { aerobic: 0.98, anaerobic: 0.02, base: 0.99, threshold: 0.01, intensity: 0 }` — extrapolated from easy (0.95/0.05/…).
  - Pace multiplier `baseMinPerKm * 1.12` — ≈ +43 s/km on a 6:00/km easy base. Middle of the +30 to +60 s/km literature range for recovery runs. Tristan to confirm or override.
**Status**: Type-safe, all cross-training tests pass. Needs on-device test (easy-only week that gets pushed over target — expect Reduce to offer easy → recovery) and sign-off on the two provisional constants.

---

### ISSUE-133: HR drift not computed for activities — "HR during sessions" always shows "—" *(P3)*

**Problem**: The "HR during sessions" signal in the week debrief always shows "—" because `hrDrift` is `undefined` on all garminActuals.
**Root cause**: `hrDrift` comes from `row.hrDrift` in the DB, which is populated by the edge function during Strava sync. The edge function either doesn't compute HR drift for all activities, or doesn't store it in the DB column.
**Desired behaviour**: For steady-state runs >20 minutes with HR stream data, compute drift (second-half avg HR / first-half avg HR) in the edge function and store in `garmin_activities.hr_drift`.
**Impact**: "HR during sessions" signal in debrief and plan-view week overview. Low priority since it's one of five signals and the others now work.
**Files**: `supabase/functions/sync-strava-activities/index.ts` (needs drift computation), `src/calculations/activity-matcher.ts` (reads `row.hrDrift`).

---

### ISSUE-131: Resting HR used for iTRIMP should be a rolling average, not today's snapshot *(P2)*

**Problem**: `s.restingHR` holds a single daily snapshot value. On days where resting HR spikes (illness, stress, poor sleep), iTRIMP is computed with an inflated resting HR, which compresses HRR and understates load for all activities that day.
**Root cause**: `calculateITrimpFromSummary` receives `s.restingHR` directly. There is no smoothing applied before the value enters the formula.
**Desired behaviour**: Use a 7-day rolling median (or EMA) of `restingHR` values from `s.physiologyHistory` as the baseline for iTRIMP computation. Fall back to `s.restingHR` if insufficient history.
**Impact**: Affects every HR-based TSS figure — activity detail, fitness model CTL/ATL, ACWR, strain view.
**Files**: `src/calculations/activity-matcher.ts` (`resolveITrimp`), `src/main.ts` (heal pass), `src/calculations/trimp.ts` (no change needed — consumer responsibility).

---

### ISSUE-130: Coach — LLM narrative deferred, Phase 2 signals still to wire *(deferred 2026-04-24)*

**Status**: The LLM narrative half of this issue is **deferred until paying users exist**. The rules-layer half (the actual Coach surface) is built and live via `src/ui/coach-view.ts`.

**What shipped**:
- `src/calculations/daily-coach.ts` — `computeDailyCoach(state)` aggregates all signals into `CoachState` (stance, blockers, primaryMessage, sessionNote, workoutMod). This IS the "Brain".
- `src/ui/coach-view.ts` — Sleep-style sub-page (sky hero, stacked cards, "Why this call" evidence bullets, Recovery / Fitness / This week / Status). No LLM fetch.
- Coach button in Home header + Plan header.

**What's deferred (do not deploy)**:
- `supabase/functions/coach-narrative/index.ts` stays in the repo as dormant scaffolding but is not deployed and not called from the client. The infra cost (GDPR consent modal, subscription plumbing, server-side rate limiting, Anthropic TOS review, Apple privacy nutrition label update) is not justified pre-revenue. The rules layer already delivers the synthesis the LLM was meant to provide. See `docs/BRAIN.md` for the preserved design reference.
- Next LLM scope when revisited (threshold: ~100 paying users): **"Ask the coach" chatbot**, not the narrative paragraph. Explaining plans and recovery is a different and more valuable product than restating the rules layer in prose.

**Phase 2 signals still worth wiring (rules-layer work, no LLM)**:
- VDOT history sparkline (no history stored yet — needs `vdotHistory` array populated on week advance)
- Weekly aerobic efficiency trend across last 4 weeks (aggregate `hrDrift` from `garminActuals`)
- Previous-week carry-forward: if last week's stance was `reduce`/`rest`, this week starts discounted to prevent whiplash

---

### ISSUE-135: Race prediction marathon time optimistic when VO2/LT stale *(P3, partially addressed)*

**Symptom**: Race Predictions marathon showed 3:07 for a user with a 3:12 PB who hasn't been running much. Now lands at ~3:09 after fixes, which the user has accepted as reasonable given stale watch data.

**What shipped (2026-04-13)**:
- **Marathon tier now running-specific**: `predictFromLT` derives the marathon multiplier tier from LT pace itself (`cv(10000, ltPace * 10)` → VDOT band) rather than from `athleteTier` (total cross-training CTL). Previously cross-trained athletes got "high_volume" tier (1.06 mult) regardless of running fitness.
- **Recent run auto-derived from garminActuals**: Blend now uses the most recent running activity rather than the stale onboarding `s.rec`.
- **Card relabeled** "Current Race Estimates" with subtitle "Estimated finish times if racing today" so users understand it's current-fitness, not end-of-plan.
- `s.v` compounding detraining bug fixed (51.4 → 24.5 corruption); state repair migration added.
- LT physiology sync will self-heal now that `s.v` is repaired (±8 VDOT deviation guard no longer rejects).
- Rewired both Race Prediction cards to `blendPredictions()` (LT/VO2/PB/recent blend) instead of pure VDOT-to-time.

**Rejected approaches** (do not revisit without discussion):
- **PB ceiling** — user explicitly: "I don't want a cap at PB that's not the point". Blended prediction can legitimately be faster than PB if the evidence (LT, VO2, recent pace) supports it.
- **HR-scaled recent run extrapolation** — tested and made marathon worse (scaled-up 10K projects too aggressively over 42K). Reverted to raw garminActual data.

**What remains**:
- Residual 3:09 optimism likely comes from stale VO2 (`s.vo2=56` vs chart shows ~47). Will resolve when physiology sync updates VO2 from the watch (self-healing path in place now that `s.v` is correct).
- Could optionally reduce VO2 weight when no recent running activity in last ~2 weeks, but probably not worth it if the self-heal works.

**Files**: `src/calculations/predictions.ts`, `src/ui/stats-view.ts`, `src/ui/welcome-back.ts`, `src/state/persistence.ts`

---

### ISSUE-145: Speed-profile marathon baseline too optimistic *(P1, logged 2026-04-16, not acted on)*

**Symptom**: `forecast-profiles.test.ts > Per-profile pipeline tests > 7. Speed → Marathon` has been failing since the science-audit change that raised the lower bound of the expected baseline range. One test fails, 35 in the same file pass.

**Exact failure**:
```
baseline 2:51:53 should be in [2:55:00, 3:35:00]:
expected 10313.44 to be greater than or equal to 10500
```
Predicted baseline marathon time is **~3 minutes 7 seconds faster** than the assertion floor. Not a crash — the pipeline returns a valid number — but it's outside the expected-physiological-range the science audit laid down.

**Profile under test** (`forecast-profiles.test.ts:195`):
- 5K PB 18:00 (`k5:1080`) · 10K PB 38:00 (`k10:2280`) · no half-marathon or marathon PB
- LT pace 3:45/km (`ltPace:225`) · no VO2max · no recent race
- `confirmedRunnerType: 'Speed'` · intermediate · 5 runs/wk · 20-week plan
- Expected baseline range `[2:55:00, 3:35:00]` — comment on line 202 says lower bound was raised by science audit #8 (tier-aware LT multiplier)

**Root-cause diagnosis** (investigated in this session):
The baseline comes from `blendPredictions()` in `predictions.ts`. With this input vector:
- `predictFromPB(42195, pbs, b=1.077)` → extrapolates 10K PB to 42195m via Riegel with `b≈1.077`. Yields **~2:59:00**. Riegel under-penalises speed runners at marathon distance because `b` computed from k5→k10 only doesn't capture the endurance-specific drop-off past 21K.
- `predictFromLT(42195, 225, 'Speed', tier)` → derives tier from `cv(10000, 2250)` ≈ VDOT 51-52, which sits **right on the 'trained' (≥45) / 'performance' (≥52) boundary**. At `performance · speed` the multiplier is **1.08** → **~2:50:53**. At `trained · speed` it's **1.10** → **~2:54:03**. Tiny numerical jitter in `cv()` decides which side of the boundary you land on.
- `predictFromVO2` returns `null` (profile has no vo2max).
- `predictFromVolume` (Tanda) returns `null` (no `weeklyRunKm` / `avgPaceSecPerKm` passed in).

Because VO2 and Tanda are both null, the no-recent marathon base weights `{pb: 0.10, lt: 0.45, vo2: 0.15, tanda: 0.30}` collapse to just `pb=0.10 + lt=0.75` (Tanda's weight is explicitly redistributed to LT on line 460-463; VO2's weight just shrinks the denominator). **LT predictor ends up carrying 88% of the blend.** Under `performance` tier this produces `0.10·10745 + 0.75·10253` normalised by 0.85 = **10311s = 2:51:51** — matches the failing assertion (`10313.44`).

**Summary of what's wrong**:
1. The `predictFromLT` marathon multiplier at `performance · speed` (1.08) is too aggressive for a speed-profile runner with no half-marathon or marathon PB. A true "sub-18 5K, never raced past 10K" speed runner typically first-marathons in 2:55–3:10, not 2:51. The multiplier was calibrated on runners whose marathon fitness has been demonstrated, not extrapolated.
2. `predictFromPB`'s Riegel extrapolation with `b` derived from k5→k10 alone under-corrects the endurance drop-off over 21–42K. `safeB = min(b, 1.15)` caps extreme cases but doesn't lower-bound for speed runners. Speed runners need a *higher* fatigue exponent when extrapolating past HM distance without a long-race PB anchor.
3. The blend weights leave LT at 75% (plus VO2's 15% effectively available when VO2 is null) when both VO2 and Tanda are missing. No safety net against an optimistic LT predictor.
4. The performance/trained tier boundary at VDOT=52 is a hard cutoff that flips the marathon mult from 1.10 → 1.08 with a ~2 minute discontinuity. Linear interpolation between tiers (rather than a step function) would reduce boundary jitter.

**Why the test is set up this way**: The science audit (see `SCIENCE_LOG.md` on tier-aware LT multipliers, search "audit #8") raised the lower bound of the Speed → Marathon baseline range to 10500 precisely to encode the "no marathon history = more endurance uncertainty" physiological reality. The test is correct about the range. The code's predictors are the bit that's optimistic.

**User impact**: A runner onboarding with a fast 5K/10K but no marathon experience will see a slightly optimistic first-marathon prediction. They may pace off this estimate on race day and blow up. The error is **~3 minutes** at the `performance` tier boundary and **~30 seconds** at `trained`. Both are within "wrong but plausible" range for race-day pacing decisions.

**Possible fixes (pick one or combine)**:
a. Raise `marathonMult['performance']['speed']` from 1.08 to 1.10, `marathonMult['trained']['speed']` from 1.10 to 1.12. Reduces optimism by 200-300s directly.
b. Add a "no HM/M PB" penalty: when `pbs.h == null && pbs.m == null` and `targetDist === 42195`, apply an extra 2-3% multiplier to both `predictFromPB` and `predictFromLT` outputs to encode endurance uncertainty.
c. Cap `predictFromPB`'s closest-anchor selection: when extrapolating past 21K with only 5K/10K anchors, blend toward a fallback safe exponent rather than using `b` from just two short distances.
d. Smooth the tier boundary: linear interpolation of `marathonMult` between tier cut-points instead of a step function.
e. When both VO2 and Tanda are null and `targetDist === 42195`, bump `w.pb` and dampen `w.lt` so LT doesn't dominate.

**Why not act now**:
- Per `CLAUDE.md`: "Never invent constants, multipliers, thresholds, or fallback values". Raising 1.08 → 1.10 needs either literature backing or a calibration pass against a runner cohort.
- Per `CLAUDE.md` scientific-defensibility rules: any change requires stating the physiological basis, justifying the new constant, and logging in `SCIENCE_LOG.md`.
- This is a full science-audit item, not a quick fix. Deserves a dedicated session.

**Files implicated**: `src/calculations/predictions.ts` (lines 147-180 marathon multipliers, 48-63 `predictFromPB`, 384-470 `blendPredictions` weights). Test: `src/calculations/forecast-profiles.test.ts:195-204`. Science log entry to update: `docs/SCIENCE_LOG.md` (the "tier-aware LT multiplier / audit #8" section).

**Related**: ISSUE-135 (marathon optimism from stale VO2) — different root cause (physiology not updated) but same user-facing symptom (race prediction too fast).

---

### ISSUE-146: Activity matcher should suggest best-fit workout when no exact match *(P3, 2026-04-17)*

**Problem**: When a completed run doesn't neatly match a planned workout, it falls through to "unmatched". The user gets no credit and no feedback on what the run most closely resembled.
**Desired behaviour**: When the primary matcher fails, run a fallback scoring pass across all remaining planned sessions for the week. Score by distance delta, avg pace vs target zone, and avg HR vs expected zone. Present the best-fit suggestion as "Looks like this was your [Tempo]?" with a one-tap confirm. Include a "None of these" default action so a poor match doesn't get auto-assigned.
**Gate**: Require a minimum match score threshold before surfacing a suggestion. A sloppy mixed-pace run should stay unmatched rather than being mislabelled (protects adherence tracking and VDOT).
**Files**: `src/calculations/activity-matcher.ts` (scoring function), `src/ui/activity-review.ts` (suggestion UI in the review flow).

---

### Read `docs/STATS_REDESIGN.md` before suggesting any to-do list

When Tristan asks "what should we work on?" or "what's next?" or requests a to-do list — **direct him to `docs/STATS_REDESIGN.md` first**. The stats page redesign is the #1 priority. Walk through the suggested next session agenda in that file:

1. Pick a design direction (A, B, C, or D)
2. Define the 5-second test — what 3 things should a runner know after 5 seconds
3. Sketch the summary page layout before touching any code
4. Decide on depth model (single scroll vs current 2-level cards)
5. Implement, then review with the reviewer agent

Do not skip to other issues until a direction is chosen and the redesign is underway.

---

## 🔵 Tested & Confirmed (2026-04-08)

All items in this section have been confirmed working on device.

### ✅ ISSUE-130: Unmatched activities showing in strain but not in timeline *(confirmed 2026-04-08)*
**Fix**: Overflow items added to `adhocWorkouts` via `addAdhocWorkoutFromPending`, `garminMatched` set. `seenGarminIds` dedup prevents double-counting.
**Files**: `src/ui/activity-review.ts`

---

### ✅ ISSUE-128: Recovery advice sheet — session-specific actions *(confirmed 2026-04-08)*
**Fix**: Adjust sheet detects today's quality session, shows "Convert to easy run" / "Move to [Day]", back-to-back flag, generic fallback rows.
**Files**: `src/ui/home-view.ts`

---

### ✅ ISSUE-126: REM sleep data missing — field name mismatch *(confirmed 2026-04-08)*
**Fix**: Webhook checks both `remSleepInSeconds` and `remSleepDurationInSeconds`. Light sleep also captured.
**Files**: `supabase/functions/garmin-webhook/index.ts`, `src/ui/home-view.ts`

---

### ✅ ISSUE-94: Activity card map too zoomed out *(confirmed 2026-04-08)*
**Fix**: `drawPolylineOnCanvas` filters garbage coords. Canvas hidden if no valid points remain.
**Files**: `strava-detail.ts`

---

### ✅ ISSUE-102: Cross-training load missing from wk.actualTSS *(confirmed 2026-04-08)*
**Fix**: `addAdhocWorkout` + `addAdhocWorkoutFromPending` accumulate Signal B TSS onto `wk.actualTSS`.
**Files**: `src/ui/activity-review.ts`

---

### ✅ ISSUE-105: Garmin sleep/backfill not pulling *(confirmed 2026-04-08)*
**Fix**: 12-hour TTL replaces permanent guard. Old key migrated on first run.
**Files**: `src/data/supabaseClient.ts`

---

### ✅ ISSUE-107: Verify "Wrap up week" Sunday behaviour *(confirmed 2026-04-08)*
**Fix**: Sunday debrief pill, auto-fire once, dismiss/reopen, week advance all working.
**Files**: `src/ui/week-debrief.ts`, `src/ui/plan-view.ts`

---

### ✅ ISSUE-114: Recovery staleness gate *(confirmed 2026-04-08)*
**Fix**: `computeRecoveryScore` returns `dataStale: true` when physiology >3 days old. Grey "Sync Garmin" pill on Home, amber message on Stats.
**Files**: `src/calculations/readiness.ts`, `src/ui/home-view.ts`, `src/ui/stats-view.ts`

---

### ✅ ISSUE-115: Stats page redesign v2 *(confirmed 2026-04-08)*
**Fix**: 3-card layout with inline sparklines. VDOT sparkline in fitness detail. Readiness = single scroll. Zones chart removed.
**Files**: `src/ui/stats-view.ts`

---

### ✅ ISSUE-125: Underload system — km floor nudge + carry-over fixes *(confirmed 2026-04-08)*
**Fix**: Green nudge card for km floor, false carry-over cleared at week advance, carry-over card tap fixed.
**Files**: `src/ui/plan-view.ts`, `src/ui/events.ts`, `src/state/persistence.ts`, `src/ui/excess-load-card.ts`

---

### ✅ ISSUE-124: Home recent activity — dates + unmatched display *(confirmed 2026-04-08)*
**Fix**: Actual dates shown (e.g. "Mon 17 Mar"). Unmatched items show amber pill, tap opens review.
**Files**: `src/ui/home-view.ts`

---

### ISSUE-133: Alpine skiing (and other sports) shows "Estimated" TSS — iTrimp not computed from Strava HR *(P2)*

**Problem**: Strava HR data is available for alpine/backcountry skiing sessions, but the matching screen and activity log show "Estimated" TSS rather than "HR-based". The TSS falls back to `durationMin × TL_PER_MIN[rpe]`, which overestimates load for long ski sessions (~500 TSS for a 6h ski vs the correct ~30–50 iTrimp-based TSS).

**Root cause**: `resolveITrimp` in `activity-matcher.ts` computes iTRIMP from `row.avg_hr + row.duration_sec` when HR is available. But the Strava edge function may not be returning `avg_hr` for non-running activities, or the computed `iTrimp` field from the edge function is null for ski/cross-training activity types.

**Effect**: Total week Signal B TSS (shown as 663 / 310 on home view) is significantly overestimated for weeks with high ski volume, and the TSS bar looks alarming when it may be accurate.

**Fix needed**: Verify that `avg_hr` is returned from the edge function for ski activities, and that `resolveITrimp` correctly falls back to `calculateITrimpFromSummary` when `row.iTrimp = null` but `row.avg_hr` is populated.

---

### ✅ ISSUE-136: Garmin step count never populates in `daily_metrics.steps` — FIXED 2026-04-14

**Root cause**: Garmin's webhook dailies payload uses field name `steps`, not `totalSteps`. The `totalSteps` field is only used by the REST pull / backfill endpoint. The webhook was storing `d.totalSteps ?? null`, which was always undefined → NULL.

**Fix**: `handleDailies` now reads `d.steps ?? d.totalSteps ?? d.stepsCount` as the step value. Also added `active_calories` (`d.activeKilocalories`), `active_minutes` (`d.moderateIntensityDurationInSeconds + d.vigorousIntensityDurationInSeconds`, fallback `d.activeDurationInSeconds`), and `highly_active_minutes` (`d.vigorousIntensityDurationInSeconds`). Confirmed on-device: steps flowing to strain view.

**Related**: `sync-today-steps` edge function rewritten to read directly from `daily_metrics` (previously called Garmin epoch API which returned `401 app_not_approved`). Webhook is now the single source of truth for steps.

---

### ISSUE-134: Garmin LT threshold not syncing — `userMetrics` push not enabled *(P2, blocked)*

**Status 2026-04-14**: Confirmed still broken. `lt_thresholds` table is entirely empty. `physiology_snapshot_daily.lt_pace_sec_per_km` is NULL across every row. Garmin webhook logs show only `dailies` and `stressDetails` pushes — zero `userMetrics` pushes have ever arrived.

**Blocked on**: Garmin developer portal access (Tristan flagged ongoing portal access issues on 2026-04-14). The app/dev console needs the **User Metrics** push subscription enabled. The webhook handler (`garmin-webhook/index.ts` line 59, `handleUserMetrics`) and the DB tables are wired correctly — we just never receive the payload.

**Once portal access is restored**:
1. Enable the **User Metrics** data type / push subscription for the app in developer.garmin.com
2. Trigger a qualifying Garmin activity (or wait for Garmin to recompute)
3. Verify `[garmin-webhook] Physiology snapshot saved` appears in webhook logs
4. Verify `physiology_snapshots.lactate_threshold_pace` populates

**Edge function prep already done**: `sync-physiology-snapshot` queries the latest `physiology_snapshots` row without a date filter (deployed 2026-04-07), so once data lands in the table it will pull through to state immediately regardless of how infrequently Garmin pushes.

**Files**: Garmin developer portal (external, blocked), `supabase/functions/garmin-webhook/index.ts` (handler exists), `supabase/functions/sync-physiology-snapshot/index.ts` (updated), `src/data/physiologySync.ts` (updated).

---

## 🟡 To Be Discussed

Issues where a design decision is needed before any code work.

### ISSUE-33: Can't plan 2 workouts on one day
**Question**: Was this ever supported, or has it never been built?
**Decision needed**: Confirm whether this is a regression (fix it) or a new feature request (scope it properly). Low priority until plan page UX is settled.

---

### ISSUE-97: Home load graph — remove or redesign?
**Decision needed**: The load bar chart on Home doesn't read clearly. Options:
- **Remove it** — rely on Stats page for load history
- **Redesign** — add a clear axis, legend, and explanation
**Files**: `src/ui/home-view.ts`. Connected to ISSUE-108 (daily loop / Home hierarchy).

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

### ✅ ISSUE-06: Plan-view TSS badge → weekly summary card *(fixed)*
**Symptom**: "59 Run · 334 Total" chip in week header — users don't know what it means.
**Fix**: Replaced with a proper load progress bar (`weekLoadBar`) showing actual/planned TSS with tap-to-expand breakdown. Old chip removed.

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

### ✅ ISSUE-20: Activity card km splits match Strava *(fixed + confirmed)*
Standalone mode uses `splits_metric` from Strava API directly (exact match). Stream-based computation retained as fallback.

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

### ISSUE-132: Garmin daily steps as background load signal in Today's Load *(P3)*
**Motivation**: A rest day with 18,000 steps is physiologically different from a sedentary rest day. Steps are a proxy for non-structured activity (standing, walking, general movement) that contributes meaningfully to daily fatigue but isn't captured by structured training alone.
**Design**:
- Pull `totalSteps` from the Garmin Health API dailies endpoint (already partially wired via `syncPhysiologySnapshot` — confirm field availability).
- Convert to a Signal B contribution: steps × a per-step load factor (TBD — do not invent; confirm with Tristan once data lands).
- Show as a "Steps" placeholder card on the Today's Load detail page until Garmin data is available. When available, replace placeholder with actual step count and TSS contribution.
- Do not include steps in Signal A (running fitness) — steps are background load only.
**Files**: `supabase/functions/sync-physiology-snapshot/index.ts`, `src/types/state.ts` (add `dailySteps?` to `PhysiologyDayEntry`), `src/ui/strain-view.ts`.
**Blocked by**: Garmin steps pull not yet implemented.

---

### ✅ ISSUE-133b: Freshness and Injury Risk detail pages — parity with Recovery *(confirmed 2026-04-23)*
**Fix**: Both detail pages already built — `freshness-view.ts` and `injury-risk-view.ts` — with Recovery-parity design language (sub-score rows, sparklines, plain-language advice). Confirmed on device.
**Files**: `src/ui/freshness-view.ts`, `src/ui/injury-risk-view.ts`.
**Note**: This issue was numbered 133 alongside the HR-drift ISSUE-133. Suffixed as 133b during 2026-04-18 triage to disambiguate.

---

### ISSUE-115: Holiday mode *(P3)* — IMPLEMENTED, bugs fixed 2026-04-09
**Status**: Feature fully built. Audit on 2026-04-09 found and fixed: bridge mods wiped on app restart (main.ts cleanup too aggressive), forceDeload flags not cleaned on short-holiday cancel or manual end, hardcoded km units in session chooser (now uses formatKm/formatPace), pre-holiday shift range off by one, parseKmFromDesc returning warm-up km instead of total for structured descriptions.
**Files**: `src/ui/holiday-modal.ts`, `src/main.ts`, `src/ui/plan-view.ts`, `src/ui/home-view.ts`, `src/ui/checkin-overlay.ts`, `src/types/state.ts`.

---

### ISSUE-123: HR zones / LT threshold should auto-pull from Garmin, not require manual input *(P2)*
**Symptom**: HR threshold and zone boundaries are currently entered via a manual input button. Users don't know their LT HR and won't enter it — so zones default to generic estimates.
**Root cause**: The Garmin Health API returns `lactateThresholdBpm` in the physiology/dailies endpoint. This is already the correct value; we just aren't reading it automatically.
**Design**:
- On Garmin connect / first sync: auto-populate `lt_hr`, HR zones, and max HR from the Garmin physiology endpoint. No user action required.
- Show the pulled values as read-only in Account (e.g. "LT HR: 162 bpm — from Garmin").
- Provide a manual override toggle: "Override Garmin value" — exposes the input field. User-entered value takes precedence.
- If Garmin returns no value and no manual entry exists, fall back to age-based estimate (current behaviour) and label it "Estimated".
**Files**: `supabase/functions/sync-physiology-snapshot/index.ts` (read `lactateThresholdBpm`), `src/ui/account-view.ts` (display + override toggle), `src/state/store.ts` (source field: `'garmin' | 'manual' | 'estimated'`).

---

### ISSUE-116: Email Garmin for Auth API access *(P2 — external action required)*
**Context**: Garmin's Health API requires OAuth2 partner approval. Current implementation may rely on a workaround or limited-access token that could break.
**Action needed**: Email Garmin developer support to formally request Health API partner access and OAuth2 credentials. This is a business/admin task, not a code task.
**Impact if not done**: Garmin sleep, HRV, and dailies sync (ISSUE-76, ISSUE-105) are at risk if the current auth approach is outside approved use.

---

### ISSUE-117: "Preview week" copy should say it will be based on last week *(P2)*
**Symptom**: When a user looks ahead at a future plan week, the UI implies the week is already fully planned. In reality, durations, load, and pacing are generated as a factor of the preceding week's actual load and effort.
**Design**: Change "Preview" language to something like "Based on last week — your plan adapts as you train." Add a sub-label on future week headers: "Estimated from last week's load." Remove any language that implies exact sessions are fixed in advance.
**Files**: `src/ui/plan-view.ts` (week header, preview badge).

---

### ISSUE-118: Be more explicit about load matching *(P2)*
**Symptom**: When a Strava/Garmin activity is matched to a planned session, users don't understand what "matched" means — did it count? Was the load accepted? How does it affect the plan?
**Design**: On matched activity cards, add a brief explanation: e.g. "Matched to Tuesday's run — load counted toward your week." If a session was over/under target, show a one-line delta: "12% harder than planned." This closes the loop for users who wonder if the sync did anything.
**Files**: `src/ui/plan-view.ts`, `src/ui/activity-review.ts`.

---

### ISSUE-119: Onboarding should be clearer about what the app actually does *(P2)*
**Symptom**: New users finish setup without understanding the core promise: the app builds a personalised plan from their actual training history, adapts week to week based on how they train, and uses their watch data to adjust load. This is never stated plainly.
**Design**: Add a single "Here's how it works" screen (3 bullets max) early in onboarding — before asking for Strava/Garmin connection. E.g.:
- "Your plan is built from your real training history — not a generic template."
- "Each week adapts based on how hard you actually trained."
- "Connect Strava or Garmin so we can see your runs."
**Files**: `src/ui/wizard/` (add a step before or during the connection prompt).

---

### ISSUE-120: Check-in button — includes illness, injury, and general feeling *(P3)*
**Symptom**: There is no lightweight daily check-in for subjective wellbeing. The app has no way to know if a user is ill, injured, or just feeling flat — it can only infer from HR and load data.
**Design**: A daily check-in button on the Home screen (optional, soft nudge). Options: "Feeling good / Feeling okay / Feeling rough / Ill / Injured." If "Ill" or "Injured": surfaces ISSUE-37 illness mode or a rest-day suggestion. If "Rough": adjusts today's session intensity with a soft note. Check-in data stored in state; feeds into ACWR/readiness commentary.
**Files**: `src/ui/home-view.ts`, `src/state/store.ts` (daily check-in field), `src/calculations/readiness.ts`.

---

### ISSUE-121: Zone 2 explainer — what Kipchoge's Z2 looks like and why it matters *(P3)*
**Design**: Add a contextual info button ("ⓘ") above the Zone 2 section in Stats HR zones chart. Tapping it opens an inline explanation:
- What Zone 2 actually feels like (conversational pace, nasal breathing)
- Why it's the foundation of aerobic fitness (fat oxidation, mitochondrial density)
- The Kipchoge angle: elite athletes do 80%+ of volume in Z2 — but paired with structured tempo work
- Caution: Z2 alone without quality sessions plateaus quickly
Keep it short (4–5 sentences). Tone: coaching, not lecture.
**Files**: `src/ui/stats-view.ts` (HR zones chart section).

---

### ISSUE-122: Onboarding should ask for training goals *(P3)*
**Symptom**: Onboarding asks for current fitness level and race target but never asks *why* the user is training. A user training for Hyrox has completely different needs from someone who just wants to get fit or lose weight.
**Design**: Add a goal-selection step in the wizard. Options (multi-select allowed):
- Run faster (speed)
- Run further (distance / endurance)
- Get fit / improve health
- Just run (no specific goal)
- Build strength
- Get in shape / lose weight
- Hyrox
- Triathlon
Selected goals influence: plan tone/copy, cross-training weighting, benchmark suggestions, and coaching language. Hyrox/Triathlon selections unlock sport-specific load logic.
**Files**: `src/ui/wizard/` (new goal step), `src/state/store.ts` (goals field), `src/types/state.ts`.

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

### ✅ ISSUE-36: Garmin sleep data — edge function needed *(superseded by ISSUE-76)*
**Fix**: `garmin-backfill/index.ts` fetches sleep data from Garmin Health API (`/wellness-api/rest/sleeps`) and upserts into `sleep_summaries`. Built as part of ISSUE-76 (Garmin historic backfill).

---

### ✅ ISSUE-37: Illness mode *(fixed)*
**Fix**: Full illness mode built. `illness-modal.ts` for flagging illness, `illnessStart` tracked in state, illness banners in home-view and plan-view with severity badges ("Still running" / "Full rest"), "Recovered" button clears state.

---

### ✅ ISSUE-38: Race simulator / race mode inaccessible *(resolved)*
**Fix**: Race simulation is accessible via the benchmark picker in `events.ts` (gated behind experience level, hidden for beginner/novice). ISSUE-71 removed the standalone Stats button as intended. Entry point now lives in the check-in flow.

---

### ✅ ISSUE-40: Edit week entry point needs rethinking *(fixed 2026-03-08)*
Resolved by ISSUE-28 fix: ✎ button moved from current week to past week headers.

---

### ✅ ISSUE-41: HR analysis of completed workouts should inform future session intensity *(merged into ISSUE-35, all builds complete)*
**Fix**: All 4 functions built and wired: `computeHREffortScore` (heart-rate.ts), `computePaceAdherence` (activity-matcher.ts), `computeHRDrift` (stream-processor.ts), `generateWorkoutInsight` (workout-insight.ts). Imported and active in renderer.ts and activity-detail.ts.

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

### ✅ ISSUE-63: HR-based ATL inflation for gym sessions *(fixed)*
**Fix**: `computeWeekRawTSS` in fitness-model.ts uses actual `iTrimp` values from every activity including gym/cross-training, normalised via `normalizeiTrimp`. Gym sessions with HR streams feed directly into ATL. The flat-percentage multiplier path is now only an additive adjustment for check-in recovery debt and ACWR overrides, not a replacement for iTRIMP accounting.

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

### ✅ ISSUE-84: HR zones chart is visually ugly *(obsolete — chart removed)*
**Status**: The standalone HR zones chart no longer exists in `stats-view.ts`. Zone data is shown as compact inline bars in activity detail only. Original issue is moot.

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


### ✅ ISSUE-87: Two "Load Safety" bars on Stats — kill the second one *(fixed 2026-03-12)*
**Fix**: Removed the duplicate Load Safety bar from `stats-view.ts`.

---

### ✅ ISSUE-89: Sleep debt tracker *(fixed)*
**Fix**: `computeSleepDebt` in `sleep-insights.ts` implements exponential decay with a 4-day half-life. Rendered in `sleep-view.ts` as a sleep debt sub-label and dedicated HTML section.

---

### ✅ ISSUE-88: km/mile unit tag not working *(fixed 2026-03-19)*
**Fix**: `formatKm` wired across all distance display sites (`plan-view.ts`, `home-view.ts`, `stats-view.ts`, `activity-detail.ts`, `activity-review.ts`, `suggestion-modal.ts`, `matching-screen.ts`, `gps-panel.ts`, `week-debrief.ts`, `record-view.ts`, `gps-completion-modal.ts`). `account-view.ts` toggle persists to state and re-renders. Pace display (`formatPace`) also wired for `/mi` conversion. Confirmed by user.

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


### ✅ ISSUE-95: Injury icon inconsistency — heart on some screens, emoji on others *(resolved)*
**Fix**: No emoji-based injury/risk icons found in `src/ui/`. All injury risk rendering uses CSS colour tokens (`var(--c-warn)`, `#EF4444`, `#F59E0B`) and text labels. Issue either already fixed or never manifested in current code.

---

### ✅ ISSUE-96: "Start Run" pre-loads today's session *(fixed)*
Today's planned workout (distance, target pace, session description) is passed into the record view when navigating from "Start Run" on the Home page. Confirmed working.

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
| ✅ | ISSUE-89: Sleep debt tracker | Sleep sheet | Small | Medium |
| ✅ | ISSUE-88: km/mile unit tag — all distances + pace wired | Format | Small | High |
| ✅ | ISSUE-87: Two Load Safety bars — kill second one | Stats | Small | Medium |
| ✅ | ISSUE-106: Cross-training planned TSS inflated — historical calibration + bar suppression | Calc/UI | Small | High |
| ✅ | ISSUE-94, 102, 105, 107, 114, 115, 124, 125, 126, 128, 130: all confirmed 2026-04-08 | — | — | — |
| ✅ | ISSUE-86: Reduce recommendation 32% cut for 2% overshoot — disproportionate | Modal | Small | High |
| ✅ | ISSUE-85: CTL 222 — inflated, corrupts all downstream calcs | Calc | Medium | Critical |
| ✅ | ISSUE-83: TSS 245/330 — resolved (shared root cause with ISSUE-85) | Calc | Small | High |
| ✅ | ISSUE-82: "How are you feeling?" check-in — made optional | Home | Small | Medium |
| ✅ | ISSUE-84: HR zones chart — removed (obsolete) | Stats/Cards | Small | Medium |
| ✅ | ISSUE-29: VDOT history | Stats | Medium | High |
| ✅ | ISSUE-35: HR effort signal + drift + commentary (all 3 builds complete) | Feature | Large | High |
| 🟡 | ISSUE-33: 2 workouts/day — see **To Be Discussed** section | — | — | — |
| ✅ | ISSUE-37: Illness mode | Feature | Large | Medium |
| P3 | ISSUE-11: Auto-slot load | Feature | Large | Medium |
| ✅ | ISSUE-99: Plan page load ≠ Stats page load | Calc | Small | High |
| ✅ | ISSUE-100: Injury risk label "Low" vs "Manageable" mismatch | Copy | Small | Medium |
| P2 | ISSUE-90: LT Threshold setup guidance + Garmin pull | Setup | Medium | Medium |
| P2 | ISSUE-91: Plan restart nondeterministic profile | Wizard | Small | Medium |
| ✅ | ISSUE-93: 8W/16W/All tabs confusing | Stats | Small | Low |
| ✅ | ISSUE-95: Injury icon inconsistency — no emoji found, clean | UI | Small | Low |
| ✅ | ISSUE-96: Start Run goes to blank record screen | Home | Small | Medium |
| 🟡 | ISSUE-97: Home load graph — remove or redesign? — see **To Be Discussed** | — | — | — |
| P2 | ISSUE-98: Activity card no load split by type | Cards | Small | Medium |
| P3 | ISSUE-92: Onboarding historic load scan before plan start | Wizard | Medium | High |
| P2 | ISSUE-123: HR zones / LT threshold auto-pull from Garmin, manual as override | Account/Edge fn | Small | High |
| P2 | ISSUE-116: Email Garmin for Auth API access (external action) | Admin | — | Critical |
| P2 | ISSUE-117: Preview week copy → "based on last week" | Plan | Small | Medium |
| P2 | ISSUE-118: Load matching explainer on matched activity cards | Cards | Small | Medium |
| P2 | ISSUE-119: Onboarding — explain what the app does | Wizard | Small | High |
| ~~P3~~ | ~~ISSUE-115: Holiday mode~~ | ~~Feature~~ | ~~Medium~~ | ~~High~~ | Implemented + bugs fixed 2026-04-09 |
| P3 | ISSUE-120: Check-in button (illness / injury / feeling) | Home | Medium | High |
| P3 | ISSUE-121: Zone 2 explainer with Kipchoge context | Stats | Small | Medium |
| P3 | ISSUE-122: Onboarding goal-selection step | Wizard | Medium | High |


---

## Product Improvements — Competing at the Top

> Strategic product bets — features that move us from "solid training app" to genuinely competing with polished products like BEVEL. Not bugs, not UX polish. These are the things that make a runner *choose* this app over the competition.

---

### ISSUE-108: Daily loop — Home screen must be compelling to open every morning *(P2)*
**Problem**: A training app lives or dies by the daily habit. If opening the app doesn't immediately give a clear, motivating answer to "what do I do today?" — users drift away.
**Design goal**: In under 3 seconds, the home screen should show: today's workout with clear context, a single load/readiness signal, and one actionable coaching insight. No noise.
**Current gap**: Home has multiple cards, load bars, a graph, and a recovery bar — but no clear hierarchy. The most important thing (today's session) competes with everything else.
**Files**: `src/ui/home-view.ts`. Connected to ISSUE-97 (home load graph removal).

---

### ISSUE-109: Plan explainability — tell the runner *why* today's workout is this *(P3)*
**Problem**: Plans feel generic. A runner sees "8km @ easy pace" and has no idea if this is recovery, base building, or filling a volume target. BEVEL and coaching apps explain the why.
**Design**: Each workout card should carry a one-sentence coach rationale, e.g. "Build phase week 3 — aerobic base before threshold work starts next week." Derived from phase, week position, and VDOT relative to target.
**Impact**: Makes the plan feel intelligent and personalised, not a generic schedule. Builds trust that the algorithm understands you.
**Files**: `src/ui/plan-view.ts`, `src/ui/home-view.ts`, plan generation logic.

---

### ISSUE-110: Race day narrative — predicted time *and* what it takes to go faster *(P3)*
**Problem**: We show a predicted marathon time (e.g. 3:12) but don't make it actionable. A runner wants to know: *what would it take to run 3:05?*
**Design**: Below the predicted time, a single coaching sentence: "To run sub-3:10, you'd need ~4 more weeks at your current load + one extra threshold session per week." Derived from VDOT → pace mapping and plan headroom. Makes the product aspirational and coaching-forward rather than just descriptive.
**Files**: `src/ui/stats-view.ts` (forecast section), `src/calculations/fitness-model.ts`.

---

### ISSUE-111: Onboarding — prove calibration before the plan starts *(P2)*
**Problem**: When a new user finishes setup, they have no confidence the plan is actually built for them. They don't see the training history that was scanned, the load level detected, or why the plan looks the way it does.
**Design**: After Strava/Garmin backfill, show a "We found you" summary screen before confirming the plan — e.g. "Based on your last 12 weeks: avg 47 km/week · load trending up · your strongest day is Tuesday." Then confirm. This is what a real coach does in their first session.
**Connected to**: ISSUE-92 (historic load scan screen). ISSUE-111 is the broader onboarding hook — ISSUE-92 is the specific data summary screen.
**Files**: `src/ui/wizard/steps/initializing.ts`, `src/data/stravaSync.ts`.

---


### ISSUE-112: Coherent visual design pass *(P2)* `[ui-ux-pro-max]`
**Problem**: Screens have been built feature-by-feature. The result is inconsistent card styling, mixed icon languages, varying font weights, and a home/stats split that doesn't feel like one product.
**Design goal**: One coordinated session with `ui-ux-pro-max` to establish a consistent card system, typography scale, colour use, and icon vocabulary — then apply it across all screens.
**Known rough spots**: HR zones chart (ISSUE-84), home load graph (ISSUE-97), activity cards, stats recovery card, plan week headers.
**Files**: Most of `src/ui/`. Tackle as a single pass, not file by file.

---

### ISSUE-128: Sleep analysis should use 7-day rolling window, not today's snapshot *(P2)*

**Problem**: The sleep view and any sleep-derived signals (sleep score, debt, recovery) currently reflect only tonight's / last night's sleep. A single night is noisy — one unusually short night tanks the score, one good night looks like full recovery.
**Root cause**: Sleep analysis is computed from the latest `physiologyHistory` entry rather than averaging across the recent window.
**Fix**: All sleep metrics shown to the user (sleep duration, score, debt, HRV trend) should be derived from a 7-day rolling average. Single-night data can still appear as a detail, but the headline figures and any coaching decisions should use the rolling window.
**Files**: `src/calculations/sleep-insights.ts`, `src/ui/sleep-view.ts`, `src/ui/home-view.ts` (sleep card)

---

### ISSUE-127: REM sleep analysis — surface insights and training impact *(P3)*
**Motivation**: Once REM data is reliably flowing (ISSUE-126), there's a coaching signal here. REM is the sleep stage most sensitive to overtraining and stress; low REM correlates with poor cognitive recovery and elevated cortisol. It's a more actionable signal than total duration.
**Design**:
- **Stage breakdown on Home sleep card**: show Deep / REM / Light / Awake as labelled bars with % of total (already partially built — needs REM data to populate)
- **REM trend sparkline on Stats recovery card**: 7-day rolling REM % (target: 20–25% of total sleep). Trend down = flag
- **Coaching insight**: if REM% < 15% for 3+ consecutive nights, show a recovery card note: "Your REM sleep has been low this week — this can blunt training adaptation. Prioritise sleep consistency."
- **Training load link**: compare REM% against weekly TSS. Surfaces "Your hardest weeks correlate with lower REM — your body is working hard." Adds a layer of intelligence between load and recovery
- **Dependency**: ISSUE-126 must be confirmed working first (REM data in DB)
**Files**: `src/ui/home-view.ts` (sleep card), `src/ui/stats-view.ts` (recovery card), `src/calculations/readiness.ts` (REM% signal into recovery score)

---

### ISSUE-113: Shareable moments *(P3)*
**Problem**: Every hard workout, milestone week, or PB prediction is a potential share moment. Currently there's no way to export or share anything. BEVEL and Strava capitalise heavily on this for organic growth.
**Design**: Shareable cards for: week completed (load + distance summary), new VDOT high, predicted race time improvement, long run PB. Native share sheet via Capacitor. Optional — never forced.
**Files**: New `src/ui/share-card.ts`. Capacitor Share plugin.

---

### ✅ ISSUE-133: Guided runs — skip/extend desync the tracker's SplitScheme *(P1, fixed 2026-04-15)*
**What**: `GuideController.skipStep()` and `extendCurrentStep(sec)` mutated the engine's `Timeline` but not the tracker's `SplitScheme`, so splits/per-km cues/adherence drifted after a user tapped "Skip rest" or "+30s".
**Fix**: Added public `skipSegment()` and `extendSegment(sec)` on `GpsTracker`. `GuideController.skipStep()` / `extendCurrentStep()` now accept an optional tracker adapter and advance both representations in lockstep. `gps-events.ts` exposes `guidedSkipStep()` / `guidedExtendCurrentStep()` helpers wired from the rest overlay (via dynamic import to break the cycle).
**Status**: Typecheck + 122 tests pass. Still needs on-device confirmation during a real interval session. ISSUE-137 (single parser) is the longer-term architectural fix.
**Files**: `src/gps/tracker.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`, `src/ui/guided-overlay.ts`.

---

### ✅ ISSUE-134: Guided runs — iOS WKWebView blockers (voice, haptics, silent switch) — FIXED 2026-04-16 (pending on-device verification)
**What was**: Voice + haptic stack had never been tested on a real iPhone. Web Speech unreliable in WKWebView, `navigator.vibrate` silent on iOS, silent switch muted everything.
**Fix shipped**:
- App renamed to Mosaic (`com.mosaic.training`). `Info.plist` gained `NSMotionUsageDescription` and `audio` in `UIBackgroundModes` so voice can keep speaking while the screen is locked.
- `@capacitor/haptics` installed and wired as a runtime adapter inside `src/guided/haptics.ts`. Native → `Haptics.impact` (Taptic Engine), browsers → `navigator.vibrate`. Existing tests unaffected — the injectable `HapticAdapter` interface is preserved.
- New local SPM plugin `@mosaic/guided-voice` at `ios-plugins/guided-voice/`, Swift target `ios/Sources/GuidedVoicePlugin/GuidedVoicePlugin.swift`. Wraps `AVSpeechSynthesizer`; activates `AVAudioSession(.playback, .voicePrompt, [.duckOthers, .mixWithOthers])` around every utterance — `.playback` overrides the silent switch. Deactivates with `.notifyOthersOnDeactivation` on the delegate finish / cancel callback.
- `src/guided/voice.ts` routes `speak()`/`cancel()` through `registerPlugin<GuidedVoicePlugin>('GuidedVoice')` when `Capacitor.isNativePlatform()`; Web Speech is the browser fallback. `composePhrase` stays pure so tests pass unchanged.
- Plugin registered as a proper local npm package (`npm install file:./ios-plugins/guided-voice`) so `npx cap sync ios` auto-adds it to `packageClassList` and to `CapApp-SPM/Package.swift`. Keeping the Swift file inline under `CapApp-SPM/Sources/` would have been silently stripped on every sync.
**Pending on-device verification** per CLAUDE.md rule: install on iPhone, flip the silent switch, lock the screen mid-run, confirm voice + haptics fire and music ducks.
**Files**: `capacitor.config.ts`, `ios/App/App/Info.plist`, `ios/App/App.xcodeproj/project.pbxproj`, `src/guided/haptics.ts`, `src/guided/voice.ts`, `ios-plugins/guided-voice/**`, `docs/IOS_SETUP.md`.

---

### ✅ ISSUE-135: Guided runs — cues fire late or not at all when screen is locked *(P1, interim fix 2026-04-16)*
**What**: The tracker's 1s `setInterval` (which drives engine updates) is throttled heavily when the webview is backgrounded or the screen is locked. The user pockets the phone and voice cues stop. This defeats the guided experience for the majority of the run.
**Interim fix (web-only)**: Screen Wake Lock API acquired inside `startTracking` when a `GuideController` is created and `guidedKeepScreenOn !== false` (default ON). Released on `stopTracking` (both branches), `disableActiveGuide`, and when the user toggles it off. Re-acquires automatically on `visibilitychange → visible` since browsers release the lock on tab-hide. Graceful no-op on unsupported browsers (Safari pre-16.4). New Account → Preferences toggle ("Keep screen on") below the voice-rate slider, disabled with "Not supported on this browser" sub-label when the API is missing.
**Follow-up**: FUTURE-03 Live Activity / Capacitor `@capacitor-community/keep-awake` on native shells will supersede this when the phone is pocketed.
**Files**: `src/utils/wake-lock.ts` (new), `src/utils/wake-lock.test.ts` (new, 11 tests), `src/ui/gps-events.ts`, `src/ui/account-view.ts`, `src/types/state.ts`.

---

### ✅ ISSUE-136: Guided runs — music ducking not implemented *(P2, fixed 2026-04-16 via ISSUE-134 native plugin)*
**Fix**: `GuidedVoicePlugin.swift` activates `AVAudioSession` with category `.playback`, mode `.voicePrompt`, and options `[.duckOthers, .mixWithOthers]` before each utterance and deactivates with `.notifyOthersOnDeactivation` on finish / cancel. On iOS the app will dip Spotify/Apple Music while the voice speaks and restore it after. Web fallback (`SpeechSynthesisUtterance`) has no ducking equivalent — speech plays over music at full volume as it did before, but this is only the development path.
**Status**: Implemented in code. Needs on-device confirmation that ducking behaves as expected against Apple Music and Spotify.
**Files**: `ios-plugins/guided-voice/ios/Sources/GuidedVoicePlugin/GuidedVoicePlugin.swift`, `src/guided/voice.ts` (native bridge via `@capacitor/core registerPlugin('GuidedVoice')`).

---

### ✅ ISSUE-137: Guided runs — two parsers for one workout description *(P2, architectural, fixed 2026-04-16)*
**Fix**: `buildSplitScheme` is now a thin adapter over `buildTimeline`. The split scheme is derived by walking the `Timeline` steps and mapping: rep → single paced segment, recovery → untimed segment with `durationSeconds`, warmup/cooldown → single paced segment at easy pace, single-block distance/time work → per-km splits, progressive (2-step easy+fast) → per-km easy + per-km "Fast km N of M". Timeline was extended to cover formats split-scheme already handled but timeline did not: (1) literal paces `"4:49/km"` in interval time / distance-at-pace expressions, (2) optional `(~790m)` / `(~3.2km)` parentheticals after zone tokens, (3) `{N}km <descriptor>` forms like `"5km warmup jog"`. New anti-regression test in `integration.test.ts` iterates every split-scheme test input and asserts the timeline is non-empty + structured where expected + all paced segments trace back to a timeline step pace.
**Files**: `src/guided/timeline.ts`, `src/gps/split-scheme.ts`, `src/guided/integration.test.ts`, `docs/ARCHITECTURE.md`.

---

### ✅ ISSUE-138: Guided runs — rest overlay leaks on tab navigation *(P2, fixed 2026-04-15)*
**Fix**: `tab-bar.ts` delegated click handler unmounts the guided overlay on any non-Record tab. `record-view.ts` re-mounts the overlay on re-entry if a `GuideController` is still active (the controller re-emits / `mountGuidedOverlay` re-renders immediately when the current step is recovery).
**Files**: `src/ui/tab-bar.ts`, `src/ui/record-view.ts`.

---

### ✅ ISSUE-139: Guided runs — mid-run settings changes silently ignored *(P3, fixed 2026-04-15)*
**Fix**: `gps-events.ts` exposes `disableActiveGuide()` and `setActiveGuideSplitAnnouncements(bool)`. Account toggles now forward to the active controller (destroy on "Off", forward split toggle live). Re-enabling mid-run still requires stopping and restarting (fresh `GuideController` needs a workout+paces, which only `startTracking` holds).
**Files**: `src/ui/gps-events.ts`, `src/ui/account-view.ts`.
**Files**: `src/ui/account-view.ts` (toggle handlers), `src/ui/gps-events.ts` (export a control surface).

---

### ✅ ISSUE-140: Guided runs — adherence uses one tolerance for every step type *(P3, fixed 2026-04-15)*
**Fix**: `ADHERENCE_TOLERANCE_BY_KIND` map: work ±4, warmup/cooldown ±10, other ±5 (recovery is always untimed). `classifyPace` takes a kind argument; `summariseAdherence` passes the categorised kind through. Tests updated for the new bands.
**Files**: `src/guided/adherence.ts`, `src/guided/adherence.test.ts`.

---

### ✅ ISSUE-141: Guided runs — end-to-end integration test missing *(P2, fixed 2026-04-15)*
**Fix**: `src/guided/integration.test.ts` drives a single structured workout description through both parsers (`buildTimeline` + `buildSplitScheme`) and asserts they produce compatible work-rep counts, that the controller emits `stepStart` cues in strictly increasing step order and reaches `timelineComplete`, that the cue log captures every emitted event, and that `summariseAdherence` classifies synthetic splits correctly under the new per-kind tolerances. Uncovered the exact seam ISSUE-137 warns about: the initial test description ("…60s recovery") failed `buildSplitScheme` silently — confirmed the need for a single parser but tangential to this test.
**Files**: `src/guided/integration.test.ts` (new, 4 tests).

---

### ✅ ISSUE-142: Guided runs — speech rate hard-coded to 1.0 *(P3, fixed 2026-04-15)*
**Fix**: Added `guidedVoiceRate` to state (0.8–1.4, default 1.0). Slider in Account → Preferences below the two toggles; value saved on change, forwarded live to the active `VoiceCoach` via `GuideController.setVoiceRate`. `VoiceCoach.setRate` clamps to the valid range.
**Files**: `src/types/state.ts`, `src/ui/account-view.ts`, `src/guided/voice.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`.

### ✅ ISSUE-143: Guided runs — +30s has no cap *(P3, fixed 2026-04-15)*
**Fix**: Engine records `originalDurationSec` on first extend; caps extensions at 2× original. `extendCurrentStep` now returns the actual seconds applied so the tracker's SplitScheme stays in sync even when clipped. Overlay's +30s button is disabled (faded, `cursor:not-allowed`) when remaining allowance < 30s.
**Files**: `src/guided/timeline.ts`, `src/guided/engine.ts`, `src/guided/controller.ts`, `src/ui/guided-overlay.ts`.

### ✅ ISSUE-144: Guided runs — no observability for in-run cues *(P3, fixed 2026-04-15)*
**Fix**: `GuideController` now pushes every `CueEvent` into a 100-entry ring buffer (`getCueLog()`), tagged with timestamp, run-elapsed seconds, step idx/label and event type. `stopTracking()` attaches the log to the `GpsRecording` as the optional `cueLog` field. Not surfaced in UI — debug-only, available on the stored recording for support diagnostics.
**Files**: `src/types/gps.ts`, `src/guided/controller.ts`, `src/ui/gps-events.ts`.

---

### ISSUE-132: Apple Watch — extend HealthKit plugin for advanced metrics *(P3, future build)*
**What**: `@capgo/capacitor-health` does not expose several HealthKit data types that Apple Watch captures and Garmin doesn't (or does worse). These need a plugin contribution or fork to access.
**Data to add**:
- **Wrist temperature** (`HKQuantityType.appleSleepingWristTemperature`) — deviation from baseline. Early overtraining/illness signal (same signal that makes Oura valuable). Series 8+ only.
- **Running Power** (`HKQuantityType.runningPower`) — native on Apple Watch since watchOS 9. Better load metric than pace on hilly terrain. Would need a new load model path alongside iTRIMP.
- **Running form metrics** — ground contact time (`runningGroundContactTime`), stride length (`runningStrideLength`), vertical oscillation (`runningVerticalOscillation`). Injury risk indicators and running economy signals. Series 6+.
- **HR Recovery rate** — how fast HR drops post-exercise. Strong fitness/fatigue indicator.
- **SpO2 + Respiratory Rate** — already in the plugin's `HealthDataType` enum but not currently read. Useful once an illness/overtraining detection model is built to consume them.
**Blocked by**: Plugin limitation (need to extend `HealthDataType` enum and add native Swift queries). No consumer logic exists yet in the readiness/fitness model for these signals.
**Files**: `@capgo/capacitor-health` (plugin fork or PR), `src/data/appleHealthSync.ts`, `src/types/state.ts` (new fields on `PhysiologyDayEntry`), readiness model (new illness detection), fitness model (running power load path).

---

| Priority | Issue | Effort | Impact |
|---|---|---|---|
| P2 | ISSUE-108: Daily loop / Home hierarchy | Medium | Critical |
| P2 | ISSUE-111: Onboarding calibration proof | Medium | High |
| P2 | ISSUE-112: Visual design coherence pass | Large | High |
| P3 | ISSUE-109: Plan explainability — workout why | Medium | High |
| P3 | ISSUE-110: Race narrative — what it takes to go faster | Medium | High |
| P3 | ISSUE-113: Shareable moments | Medium | Medium |
| P2 | ISSUE-128: Sleep analysis — 7-day rolling window, not today's snapshot | Low | High |
| P3 | ISSUE-127: REM sleep analysis — stage breakdown, trend, training link | Medium | High |
| P3 | ISSUE-132: Apple Watch advanced metrics (temp, power, form, SpO2) | Large | High |

---

## Future Builds — Major Feature Tracks

> These are standalone product tracks with their own design docs. Not bugs, not polish. Each one is a multi-week build that expands the product into a new capability.

---

### FUTURE-01: Workout to Watch — Garmin + Apple Watch Push

**Doc**: [`docs/WorkoutWatch.md`](WorkoutWatch.md)

**What**: Push structured workouts (warm-up, intervals, targets, cool-down) to Garmin watches via the Training API so users execute them with live pace/HR guidance on the wrist. Apple Watch via WorkoutKit as Phase 2.

**Why it matters**: The app generates detailed structured workouts but users currently have no way to follow them live during execution. This is the gap between "training plan" and "coaching platform". Every competitor (TrainingPeaks, Garmin Coach, COROS) syncs to the watch.

**Garmin path (Phase 1, ~7-10 days)**:
- OAuth already built. Same Bearer token works for Training API.
- New edge function: `garmin-push-workout` (create + schedule)
- New mapper: `src/garmin/workout-mapper.ts` (SplitScheme to Garmin JSON)
- UI: "Send to Garmin" per workout + "Send Week" in plan header
- Prerequisite: enable "Workout Import" permission on Garmin Developer Portal consumer key

**Apple Watch path (Phase 2, ~9-12 days)**:
- Custom Capacitor plugin (Swift) bridging WorkoutKit
- HealthKit entitlements currently missing from iOS project (must fix first)
- WorkoutKit available iOS 17+ / watchOS 10+

**Status**: Design doc complete. Ready to build.

---

### FUTURE-03: Guided Runs — Lock-Screen Live Activity (iOS) + Foreground Notification (Android)

**What**: Surface a live-updating lock-screen view for a tracked run. On iOS this is ActivityKit / Live Activity (step in, duration, pace, next rep) with Dynamic Island support. On Android this is a persistent foreground-service notification with the same content.

**Why it matters**: The in-app guided-runs build (voice cues, rest overlay, engine, haptics) is complete and end-to-end wired. The remaining gap is glanceability: during a run the user locks the phone and loses access to the current step, remaining distance, or next rep. Competitors (Strava, Nike Run Club, Garmin Connect) all offer this. Without it, the guided experience only works phone-in-hand.

**iOS path (~5–7 days)**:
- Add a Widget Extension target in Xcode (must be done in Xcode, not Capacitor CLI)
- SwiftUI views for the Lock Screen and Dynamic Island presentations
- Small custom Capacitor plugin (Swift) exposing `startActivity`, `updateActivity({step, remaining, pace, next})`, `endActivity` to JS
- Wire calls from `GuideController` or `gps-events.ts` on step transitions + tick
- Live Activity requires iOS 16.1+

**Android path (~4–6 days, deferred until Android is in scope)**:
- `npm install @capacitor/android` + `npx cap add android` (scaffolds ~50 files)
- Reuse `@transistorsoft/capacitor-background-geolocation` foreground service notification (already bundled), OR write a custom Capacitor plugin for a dedicated "guided run" notification with live text
- Update notification title/body on step transitions

**Status**: Parked. Android is not a current priority. iOS Live Activity is a future build — in-app guided runs (step 5 of the original 8-step plan) is shipped. Steps 6 (Android notification) and 7 (iOS Live Activity) are now unified under this FUTURE entry.

---

### FUTURE-02: Triathlon Mode — Multi-Sport Plan Engine

**Doc**: [`docs/TRIATHLON.md`](TRIATHLON.md)

**What**: Extend the plan engine to generate swim/bike/run training plans for 70.3 and Ironman distances. Per-discipline fitness tracking, brick sessions, multi-sport weekly scheduling.

**Why it matters**: The adaptive engine, load model, and activity sync infrastructure are sport-agnostic. Triathlon is the natural expansion. The user base overlaps heavily (marathon runners who move to triathlon). No competitor does adaptive triathlon plans well.

**Key components**:
- Race profiles: 70.3 and Ironman with distance/time targets
- Per-discipline load tracking: swim CTL, bike CTL, run CTL (Signal A per sport)
- Workout library: swim sets (CSS-based), bike sessions (FTP-based), brick workouts
- Scheduler: multi-sport week layout respecting recovery between disciplines
- Activity matching: Strava/Garmin already classify swim/bike/run — matching logic extends
- Onboarding: swim CSS, bike FTP, existing run VDOT — three calibration paths

**Architecture impact**: Plan generator needs sport-aware workout templates. Fitness model needs per-discipline CTL/ATL. State schema adds `swimFTP`, `bikeFTP`, discipline-level metrics. UI needs discipline tabs or filters on plan/stats views.

**Status**: Full architecture doc written. Planning phase. Blocked on: confirming demand signal from users.

---

### FUTURE-03: The Brain — AI Coaching Intelligence

**Doc**: [`docs/BRAIN.md`](BRAIN.md)

**What**: A central coaching coordinator (`daily-coach.ts`) that collates all signals (sleep, HRV, load, injury, illness, ACWR) into a single `CoachState` — the authoritative answer to "what should I do today?". Optional LLM layer generates a coaching narrative paragraph.

**Why it matters**: The app collects rich signal (sleep, HRV, load, injury, HR drift, RPE) but each system fires in isolation. No single function answers "given everything we know, what's the coaching stance for today?" This is what makes a coach valuable — connecting signals that individually seem fine but together indicate a problem.

**Key components**:
- `daily-coach.ts` (rules-based coordinator) — **Phase 1 built**, computes stance/blockers/alerts
- Coach modal — **built**, surfaces readiness ring + 5 signal rows + narrative card
- `coach-narrative` edge function (Haiku LLM call) — **built but not deployed**
- Phase 0 hardening: JWT auth, server-side rate limiting, spend cap, input validation — **not started**
- Phase 2: subjective daily feeling, VDOT history trend, aerobic efficiency trend, REM% signal
- Paywall: LLM narrative is premium. Rules-based stance is free.

**Status**: Phase 1 built. Needs edge function deployment, hardening (Phase 0), and paywall infrastructure before going live.

---

### FUTURE-04: Plan Swap — Change Goal Without Losing Progress

**What**: Allow users to switch plans (e.g. marathon to half, race mode to general fitness, or change race date) without losing accumulated physiology state (CTL, VDOT, historicWeeklyTSS, readiness history, Strava cache).

**Why it matters**: Users' goals change. Injury, schedule shift, or a new race means they need a different plan. Currently the only option is a full reset. The physiology state is already decoupled from the plan object (`s.wks`), so preserving progress is mostly about regenerating `s.wks` for the new goal while carrying forward fitness data.

**Open design questions**:
- Three swap types with different UX: (1) change race distance (marathon to half), (2) change race date (recompute phases), (3) switch modes (general fitness to race mode or vice versa). Which to support first?
- Should the current week's completed workouts carry into the new plan, or does the swap start fresh from "this week"?
- UI: settings page toggle, or a dedicated "Change Plan" flow?

**Status**: Needs design decisions before build.

---

### FUTURE-05: Block Summary — Training Phase Completion Report

**What**: When a user finishes a training block (phase), surface a summary of what they did, how fitness changed, and what's next.

**Why it matters**: Users complete base/build/peak/taper phases with no acknowledgement or reflection. A phase-end summary closes the loop, builds trust in the system, and primes the user for what's ahead.

**Open design questions**:
- Trigger: phase-end (base to build, build to peak, etc.) is the most defensible since phases already exist in the plan engine. Full plan completion (race day) is a second trigger.
- Content: volume/intensity summary, CTL delta, VDOT delta, adherence %, key workouts, coach narrative?
- Format: modal overlay, dedicated page, or push notification?

**Status**: Needs design decisions before build.

---

| Track | Doc | Effort | Status | Dependencies |
|---|---|---|---|---|
| FUTURE-01: Workout to Watch | [`WorkoutWatch.md`](WorkoutWatch.md) | 7-10 days (Garmin), 9-12 days (Apple) | Design complete, ready to build | Garmin: Workout Import permission. Apple: HealthKit entitlements |
| FUTURE-02: Triathlon Mode | [`TRIATHLON.md`](TRIATHLON.md) | Large (multi-week) | Architecture doc written, planning | User demand signal |
| FUTURE-03: The Brain | [`BRAIN.md`](BRAIN.md) | Phase 0-1: 1 week. Phase 2+: ongoing | Phase 1 built, needs deployment + hardening | Anthropic API key, paywall infra |
| FUTURE-04: Plan Swap | — | Medium | Needs design | — |
| FUTURE-05: Block Summary | — | Small–Medium | Needs design | — |

---

## Architectural Considerations

These are not bugs or features — they are design decisions to revisit as the product grows.

### CONSIDERATION-01: localStorage as primary store vs Supabase as source of truth

**Current architecture**: localStorage is primary (fast, offline-first). Supabase is a backup — `user_plan_settings` table is written on every `saveState()` and read only when localStorage is empty (plan lost / new device).

**Why this is fine for now**: Capacitor (mobile) localStorage persists until uninstall. The backup means no user ever loses their plan. Single-device usage is the norm.

**When to revisit**: When users request multi-device sync (phone + tablet, phone + web). At that point, flip the architecture: Supabase becomes the source of truth, localStorage becomes a read-through cache. The data flows already exist — it's a meaningful but not huge refactor.

**Do not build this until a real user asks for it.**
