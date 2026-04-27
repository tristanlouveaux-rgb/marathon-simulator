# Changelog

Session-by-session record of significant changes. Most recent first.

---

## 2026-04-27 — Triathlon FTP estimator: quality tiers + recency decay

- **Bug** (`src/calculations/tri-benchmarks-from-history.ts → estimateFTPFromBikeActivities`): The previous algorithm applied Coggan's `FTP = NP × 0.95` rule uniformly to every powered ride. For long endurance rides this systematically *underestimated* FTP — Tristan's 247-min steady ride at NP=250W produced an FTP candidate of 238W, which is lower than what he had just sustained for 4 hours.
- **Fix**: Quality-tier the rides before deriving.
  - **High-signal** (20–75 min, vi ≥ 0.88, near-max steady): NP × {0.95 ≤30min, 0.97 30–50min, 1.00 >50min}.
  - **Floor** (>75 min, vi ≥ 0.80, steady long ride): NP × {1.05 75–150min, 1.10 150–300min, 1.20 >300min}.
  - **Drop** (vi < 0.80, surge-y ride): NP isn't diagnostic of sustained capacity — exclude.
- **Recency**: weight = `exp(-weeksOld / 12)`, hard cutoff at 52 weeks. Old rides no longer anchor current FTP.
- **Pool selection**: high-signal beats floor; mix only across the chosen pool.
- **Confidence tier surfaced**: `high` (≤12w high-signal), `medium` (≤26w high-signal or ≥2 ≤12w floors), `low`, `none`. Logged on every boot in the `[tri] benchmarks refreshed from history` line so it's visible whether FTP rests on recent data.
- **Tests**: rewrote the FTP test cases for the new tier logic and added a regression test using the real 5-ride DB snapshot that surfaced the bug. Full suite: 1083 passing, 0 failing.
- **Science**: full rationale + Coggan citations + known limitations in `docs/SCIENCE_LOG.md → FTP from Ride History`.

## 2026-04-27 — LT card: provenance caption + Edit button

- **Stats LT bar** (`src/ui/stats-view.ts`): Added a subtle caption under the LT bar — *"May differ from your watch reading. Edit if you'd rather use a value you trust."* — plus an inline "Edit" button that opens the LT detail page (sliders + reset). Removed the `ltHistory.length > 3` gate so the detail page is always reachable, even before watch history accumulates.
- **Brand-neutral copy**: replaced "Garmin watch" / "Garmin" labels with "Watch" / "watch" across the LT detail page (provenance caption, methods row, conflict-pick button, sparkline header) — Apple Watch users push physiology too.
- **Override flow-through**: Save / Reset / conflict-pick handlers now refresh `s.pac = gp(getEffectiveVdot(m), m.lt)` after `recomputeLT`, so threshold/easy/marathon pace zones, workout descriptions, and `blendPredictions` race-time forecasts pick up the new LT immediately. Added an inline note on the override card explaining the flow-through.

## 2026-04-25 — Session generator: effort picker + pace guidance

- **What changed** (`src/ui/session-generator.ts`): Step 2 now includes an effort picker for Easy Run and Long Run sessions (Zone 2 / Steady / Threshold). Each tier shows the actual pace from `s.pac` (easy/marathon/threshold). A one-line load status derived from ACWR pre-selects the appropriate tier and shows copy like "Elevated load. Zone 2 or steady is appropriate." For structured sessions (threshold, VO2, marathon pace, progressive), a fixed "Target pace" row replaces the picker. Time and distance estimates in the secondary info update to reflect the selected effort pace. RPE on the generated workout is overridden to match (3 / 5 / 7).

## 2026-04-25 — Sport name mapping no longer overrides explicit Strava type

- **Bug**: New activities were displayed as kitesurfing despite Strava clearly tagging them as Run/Ride/etc. Reclassifying one of them to rugby then flipped *every* "kitesurfing" activity to rugby.
- **Root cause** (`src/ui/sport-picker-modal.ts`): `getEffectiveSport` and `resolveSportForActivity` consulted `sportNameMappings[normalizedName]` *before* deriving from the Strava activityType. Every reclassification wrote a name → sport entry, so a single past mistake on a generic name (e.g. Strava catch-all "Workout") silently overrode every same-named activity. Reclassifying one kitesurf overwrote the same key, flipping the lot.
- **Fix**: Trust Strava when its type is unambiguous. Name mapping is only consulted when `deriveSportFromActivityType` returns `generic_sport`. Symmetrically, `reclassifyActivity` now only persists a name mapping when the original derived type was `generic_sport` — per-activity `manualSport` still scopes the user's correction to that one activity.
- **Follow-up**: even with the read-side fix, reclassifying a generic-typed activity (Strava "Workout"/CARDIO) still flipped every same-named activity, because Strava reuses generic names across unrelated sessions. Removed the `sportNameMappings` auto-write entirely — reclassification is now strictly per-activity via `manualSport`. Recurring auto-classification, if ever wanted, must be an explicit opt-in.
- **Cleanup** (`src/main.ts`): one-time boot migration `_sportNameMappingsResetV2` wipes the table on next launch (supersedes v1, which still allowed writes for ambiguous types). Per-activity `manualSport` overrides are preserved.

## 2026-04-25 — Running included in Leg Fatigue (distance × effort)

- **Bug**: Hard 18 km the day before reads "Leg Fatigue 4 (Minimal)" — runs were never written to `recentLegLoads`. The cross-training pipeline was the only writer, and `SPORTS_DB` had no `legLoadPerMin` for running.
- **Fix** (`src/ui/sport-picker-modal.ts`): `computeLegLoad` now dispatches to a run path when the activity is a run. Run leg load = `distanceKm × effortMultiplier(rpe)`, where the multiplier is sourced from `IMPACT_PER_KM` (easy 1.00 → vo2 1.50). RPE comes from `wk.rated[workoutId]` if logged, else HR-derived Karvonen mapping (handles bonked runs correctly: pace collapses but HR stays elevated).
- **RBE suppressed for hard runs** (RPE ≥ 7). Maximal-effort EIMD is novel stress; protection from prior easy runs does not transfer (Chen et al. 2007). Cross-training and easy runs continue to receive the standard 0.6× discount.
- **Backfill wiring**: `reconcileRecentLegLoads()` extended to detect runs and bucket them under `sport: 'running'`. Called from `activitySync.ts` after `matchAndAutoComplete` and from `main.ts` on launch so existing matched-but-unrecorded runs populate without manual intervention.
- **State**: Added `'running'` to `SportKey` union and corresponding entries in `SPORTS_DB` (`legLoadPerMin` deliberately omitted — runs use the new km-based path) and `SPORT_LABELS`.
- **Worked example**: 18 km at zone-4 HR (RPE 8), 24 h ago → raw 24.3, decayed 17.2 → readiness ~73 (soft taper). At 12 h ago → 20.4 → readiness capped at 54 (Manage Load), `drivingSignal = 'legLoad'`.
- **Why TSB/Freshness wasn't changed**: 7-day half-life ATL is canonical Banister; the 163 TSS spike does correctly register as -3 daily-TSB, the math is right. The fatigue gap was the missing leg-load channel, not the freshness curve.
- **Science**: docs/SCIENCE_LOG.md → "Running Leg Load" entry. Cites Mizrahi 2000 and Clansey 2014 for footstrike mechanics, Chen 2007 + Nosaka & Newton 2002 for RBE intensity-specificity.

## 2026-04-25 — Wire LT derivation into state + Stats override UI

- **New module** (`src/data/ltSync.ts`): `recomputeLT(s)` orchestrates the LT derivation engine against state. Builds `BestEffortInput`s from PBs and `SustainedEffortInput`s from `garminActuals`, calls `resolveLT()`, and applies the result. When the latest Garmin reading and our blended derivation differ by >10s/km, it stores `s.ltSuggestion` instead of overwriting — surfaced as a conflict prompt on the LT detail page.
- **State** (`src/types/state.ts`): Added `ltSuggestion`, `ltUpdatedAt`, `ltSource`, `ltConfidence`, `garminLT`. `s.lt` now flows through `resolveLT()` (override > fresh Garmin <60d > blended derived).
- **Sync hooks** (`src/data/physiologySync.ts`, `src/data/activitySync.ts`): Replaced the inline `s.lt = …` with a single call to `recomputeLT()`. Also recomputes after activity sync so new runs unlock empirical LT detection.
- **Stats LT detail page** (`src/ui/stats-view.ts → buildLTMetricPage`): Provenance caption + confidence chip, methods breakdown card (each method's pace and weight), Garmin-reading sparkline, conflict-resolution card when sources disagree, and override sliders (pace and HR) with reset-to-derived. The override persists as `s.ltOverride` and wins over Garmin/derived.
- **Tests**: All 29 LT derivation tests still pass after the wiring.

## 2026-04-25 — Surface HR-calibrated VDOT in onboarding

- **Onboarding review screen** (`src/ui/wizard/steps/review.ts`): The VDOT row now reads "Current fitness (VDOT)" and surfaces the HR-calibrated number when available. Sub-caption explains the method explicitly — *"Measured from your heart rate response to pace across N steady runs (long enough with stable HR) in the last 8 weeks. {tier} confidence."* Low-confidence variant marks the figure as a rough estimate. The previous "Add a resting HR in your profile" copy (which asked users to act on a profile they hadn't reached) is replaced with a calibration-pending fallback: *"We'll calibrate this from your heart rate once your physiology data syncs."*
- **Physiology sync during onboarding** (`src/ui/wizard/steps/review.ts`, `triathlon-setup.ts`): Wizard now fires `syncPhysiologySnapshot(28)` before the Strava backfill so RHR + maxHR are available for the regression on first onboarding. Strava-only users without Garmin still see the calibration-pending fallback.
- **Triathlon onboarding** (`src/ui/wizard/steps/triathlon-setup.ts`): "What we found" card now surfaces the HR-calibrated run VDOT alongside CSS, FTP, and CTL, with the same method + confidence copy as the running flow.
- **State cache + reconciliation** (`src/types/state.ts`, `src/calculations/blended-fitness.ts`): Added `s.hrCalibratedVdot` (vdot, confidence, n, r2, reason). Populated by `refreshBlendedFitness` *before* the early-return guards so the review screen sees it when race distance isn't set yet. When confidence is medium+ and `s.rd` is unset, `s.v` is also overwritten to keep the figure consistent across screens until the full blend kicks in mid-plan.
- **Triathlon handoff** (`docs/TRIATHLON_HANDOFF.md`): Documented the onboarding-surface pattern — one row per sport, calibrated value + confidence + plain-language method, low-confidence variant, calibration-pending fallback. Triathlon agent to mirror for FTP and CSS.
- **Tests** (`src/calculations/blended-fitness.test.ts`): New 5-test suite covers the pre-guard cache write, s.v reconciliation rules, low-confidence guard, no-RHR path, and stale-entry overwrite.
- **Order-of-operations fix** (`src/ui/wizard/steps/review.ts`): Wizard now runs `backfillStravaHistory` → `syncPhysiologySnapshot` → explicit `refreshBlendedFitness(getMutableState())` before rendering. Previous order ran physio first (empty activity envelope, maxHR didn't load) then backfill's internal refresh fired without RHR/maxHR, leaving the cache as `{confidence: 'none', reason: 'no-rhr'}` and showing the bland fallback caption.
- **Plan-preview surface** (`src/ui/wizard/steps/plan-preview-v2.ts`): "Starting VDOT" row now has a method sub-caption mirroring the review screen tiers, and the info popup explains how the user's specific number was measured (HR-calibrated regression with N, R², confidence tier) instead of only quoting Daniels generically.

## 2026-04-24 — Fix: Strava-upgraded activities showing as Garmin in Recent list

- **Root cause A** (`src/calculations/activity-matcher.ts`): The Strava upgrade loop that replaces a Garmin-sourced `garminActuals` entry with richer Strava data was not updating `activityType` or `displayName`. The entry kept its old Garmin sport type (e.g. `WORKOUT`) even after upgrade.
- **Root cause B** (`src/ui/home-view.ts`): `buildRecentActivity` was skipping the `garminActuals` entry in favor of the `adhocWorkout` entry when both had the same key. Since `adhocWorkouts` still had old Garmin display data (`n = 'Workout'`), the upgraded Strava version was invisible.
- **Fix 1** (`activity-matcher.ts`): Strava upgrade loop now also copies `activityType` and `displayName` from the Strava row, and updates the corresponding `adhocWorkout.n` to match.
- **Fix 2** (`home-view.ts` / `buildRecentActivity`): Flipped dedup priority — `garminActuals` wins over `adhocWorkouts` for the same key. Adhoc entries are skipped when `garminActuals` has a richer entry.
- **Fix 3** (`home-view.ts` / `computeLoadBreakdown`, `fitness-model.ts` / `computeWeekTSS`, `computeWeekRawTSS`, `computeTodaySignalBTSS`): All TSS-computing loops now skip `adhocWorkouts` entries when `garminActuals` already has the same key (prevents double-counting TSS after a Strava upgrade).

---

## 2026-04-25 — Fix: Strava upgrade loop corrupted by garminPending overwrite

- **Root cause**: In `matchAndAutoComplete`, after the garminActuals upgrade fires (replacing a Garmin-webhook actual with richer Strava data), the garminPending section immediately overwrote `garminMatched["strava-X"] = "__pending__"` because matched runs also appear in garminPending. This corrupt mapping caused the re-enrich loop to skip the actual on future syncs, and could cause the main matching loop to re-process the Strava row as a new activity (creating a duplicate adhoc entry in past weeks).
- **Fix 1 (`src/calculations/activity-matcher.ts`)**: After the garminActuals upgrade, add `globalProcessed.add(row.garmin_id)` so the main matching loop excludes this row from `newRows`. The garminPending section now runs in a separate guard branch that updates the pending item's garminId (cosmetic) but does NOT touch `garminMatched`.
- **Fix 2 (`src/data/stravaSync.ts`)**: Added a defensive "Strava always wins" pass after `matchAndAutoComplete`. Iterates all Strava rows by start_time ±10 min against all weeks' garminActuals. Any Garmin-sourced actual with a matching Strava row is force-upgraded (garminId, polyline, hrZones, kmSplits, pace etc.) and `garminMatched` is set to the correct slot. This self-heals existing state where a prior sync corrupted the mapping.

---

## 2026-04-25 — Activity detail coach: high-HR and TSS-historical commentary

- **`src/calculations/workout-insight.ts`**: Two new signals added to `gatherSignals`.
  - `hrPctMax`: avgHR as a fraction of known maxHR. When >= 0.87, the narrative explicitly names the bpm and percentage instead of the generic "HR was elevated" sentence. >= 0.90 gets "near race-effort intensity" language.
  - `weeksAgoHigherTSS`: scans all prior run actuals (via `allActuals` passed from state) to find the last time a run hit >= current TSS. When found and >= 3 weeks ago, adds "Highest-load run in X weeks at N TSS." sentence.
- **`InsightOptions`** extended with `allActuals?: GarminActual[]`.
- **`src/ui/activity-detail.ts`**: extracts `allActuals` from `s.wks` and passes to `generateWorkoutInsight`.

---

## 2026-04-25 — Lactate threshold derivation (decouples us from Garmin)

- **New `src/calculations/lt-derivation.ts`** blends three scientifically-grounded methods into a single LT pace + LTHR estimate:
  1. **Daniels T-pace from VDOT** — invert Daniels' VO2 cost-of-running equation for vVO2max, scale by 0.88.
  2. **Critical Speed from race-distance PBs** — 2-parameter hyperbolic fit `d = CS·t + D′`, LT = 0.93 × CS (Nixon et al. 2021 CS↔MLSS offset).
  3. **Empirical detection from sustained efforts** — runs ≥20 min, HR in 85–92% HRmax band, pace CV <8%, decoupling <5%, with outlier guards for treadmill, heat (>28°C), hills (>15 m/km gain), and unsteady pacing.
- **Blend weights** depend on which methods fire: empirical 0.5 / CS 0.3 / Daniels 0.2 when all three; 1.0 when single method only.
- **LTHR** prefers empirical median; falls back to 0.88 × HRmax (literature midpoint of LT2 band).
- **`resolveLT()` selector** orders sources: `override > fresh Garmin (<60d) > derived > stale Garmin > null`. Lets fresh watch readings override our derivation when available, but our derivation always backstops.
- **`s.ltOverride` field** added to state — user-entered LT pace + optional LTHR + ISO `setAt`. Wins outright when present.
- **29 unit tests** cover each method, outlier rejection, blending, and source precedence.
- **Full science write-up** in `docs/SCIENCE_LOG.md → Lactate Threshold Derivation` — formula derivations, citations (Daniels, Jones & Vanhatalo, Nixon, Friel, Faude, Poole), confidence model, outlier failure-mode table.
- **Not yet wired into UI** — see "next steps" below. Calculation lives standalone until UX placement is agreed.

---

## 2026-04-24 — Effort-calibrated VDOT from HR

- **New signal in the race-prediction blend.** Historically `blendPredictions` weighed recent run / PB / LT / VO2 / Tanda. Today we add a sixth signal: **effort-calibrated VDOT** computed from the last 8 weeks of HR-tagged runs via the Swain & Leutholtz 1997 %HRR ≈ %VO2R relationship. Each qualifying run contributes a point `(pace, %VO2R, duration)`, weighted linear regression fits `pace = α + β·%VO2R`, and extrapolation to `%VO2R = 1.0` gives the athlete's current vVO2max, converted to VDOT via Daniels' tables.
- **Qualifying filter** — duration ≥ 20 min (Swain validated on steady submax), HR drift < 8% (excludes fatigue / supra-threshold per Friel), pace 3:00–7:30 /km, %HRR in [40%, 95%]. Physiological sanity guard rejects non-negative β (inverted HR-pace curve → noisy data).
- **No fabricated constants**: if resting HR or max HR are missing, the HR-calibrated VDOT returns null with `confidence: 'none'` and its weight redistributes to LT — matches the same fallback pattern used for Tanda when volume is insufficient.
- **Weight scaling** — HR weight is scaled by confidence tier (high 1.0, medium 0.7, low 0.4); shed weight flows to LT. At marathon: base HR weight is 10% (recent-run path) or 15% (standalone path), and 15% for 5K/10K/HM.
- **Files**: new `src/calculations/effort-calibrated-vdot.ts` (pure function, 15 tests), extended `RunActivityInput` with optional `avgHR`/`hrDrift`, wired into `blendPredictions` + `blended-fitness.ts`. Onboarding path also carries HR — the edge function's `runs` response now includes `avgHR` from Strava's list endpoint.
- **Science log**: new entry "Effort-Calibrated VDOT from HR" documents the formula, Swain+Daniels+Friel+Tanaka anchors, blending weights, and known limitations.
- **Triathlon handoff**: `docs/TRIATHLON_HANDOFF.md` updated — the bike/swim prediction engines the triathlon agent builds should mirror the same four-signal blend (HR-cal + hard effort + Tanda analog + PB) with identical confidence+recency weighting.

## 2026-04-24 — Triathlon week advancement un-stuck

- **Root cause**: Triathlon users had `s.w` permanently frozen at week 1. `advanceWeekToToday` applies a `debriefCap = lastCompleteDebriefWeek + 1` to ensure running users complete a plan-preview debrief before advancing. Triathlon has no plan-preview debrief, so `lastCompleteDebriefWeek` was never updated and the cap held `s.w` at 1 forever. Activities from week 2 onwards went into `wks[1]` but `buildRecentActivity` only shows `wks[s.w-1]` and `wks[s.w-2]` — so they were invisible.
- **`initialization.triathlon.ts`**: now sets `planStartDate` (Monday of current week) explicitly on init, and seeds `lastCompleteDebriefWeek = 0` + `_debriefGateV3 = true` so the migration never clobbers the anchor.
- **`welcome-back.ts` `advanceWeekToToday`**: triathlon users use `debriefCap = Infinity` — they advance freely with no debrief gate.
- **`main.ts`**: the debrief gate rollback (`_ms.w = lastComplete + 1`) is also skipped for `eventType === 'triathlon'`.

## 2026-04-24 — Strava always wins over Garmin

- **`sync-activities` edge function**: added `polyline`, `elevation_gain_m`, `km_splits`, `hr_drift`, `ambient_temp_c` to the SELECT (previously omitted, so Strava-enriched fields never reached the app). Added dedup: any Garmin row whose start time is within ±10 min of a Strava row is suppressed before returning — Strava is canonical.
- **`activity-matcher.ts` — Strava upgrade loop**: when a Strava row arrives for an activity that was previously matched via Garmin webhook (same ±10 min start time), the existing `garminActuals` entry is fully replaced with the richer Strava data (HR zones, iTRIMP, polyline, etc.). Also upgrades `garminPending` items. `garminMatched` is updated to register the Strava ID so re-syncs don't create a duplicate.
- **`CLAUDE.md`**: added "Strava is the Canonical Activity Source" rule.

## 2026-04-24

- **Garmin webhook — `activity_details` 42P10 fix.** Every `activityDetails` push was failing because `activity_details.garmin_id` had no unique constraint — the `ON CONFLICT` target was invalid. Applied `ALTER TABLE activity_details ADD CONSTRAINT activity_details_garmin_id_key UNIQUE (garmin_id)` directly in Supabase. Migration `20260310000001_activity_details_constraint.sql` existed locally but had never been applied to prod. See `docs/GARMIN.md → 2026-04-24`.
- **Garmin dev credentials — VO2 Max now flowing.** Confirmed `userMetrics` push landed with `vo2Max: 55` on the development consumer key. Previous assumption that dev tier suppressed all VO2/LT fields was outdated. Whether LT pace / HR are permanently dev-gated or just hadn't refreshed in this payload cycle is **unconfirmed** — Garmin's public docs don't specify field-level gating. `docs/GARMIN.md → 2026-04-24 OPEN` entry reframes this as an open question and includes a support-contact draft.
- **`src/ui/home-view.ts`** — "How did you sleep last night?" card no longer shown when sleep data is already available from any source. Condition changed from `noWatch && !manualToday` to `sleepScore == null && !manualToday`, so the manual prompt only appears when there is genuinely no sleep signal.

## 2026-04-24 — Post-run RPE modal: matched to monochrome overlay pattern

The RPE prompt that appears after a Strava sync used a flat card with a bright-blue `var(--c-accent)` Save button and 12px-radius buttons — visually adrift from the new onboarding/plan-preview overlays.

- **`src/ui/activity-review.ts`** — card gains Apple 3-layer shadow, 20px radius, white surface, `rgba(0,0,0,0.06)` border. Title pattern mirrors milestone/VDOT overlays: small uppercase "LOG EFFORT" label + 18px title + muted 13px subline. Save becomes black `#0A0A0A` pill with the same inset highlight + drop shadow as the review/plan-preview CTAs. Skip becomes a bordered white pill.
- **Slider colour** — dropped the green/amber/red traffic-light accent (`rpeColorVar` helper removed). Slider, value, and label all sit in `var(--c-black)` / `var(--c-muted)`. The RPE number is the data; colour was redundant signal, and three non-neutral hues broke the monochrome aesthetic next to the new pill CTAs.

## 2026-04-24 — Running no-event path: distinct title, prediction hidden, focus-driven pacing

The Running tile → No event path silently fell back to a half-marathon target: `initializeSimulator` ran `state.raceDistance || 'half'`, so `s.rd='half'` even though the user picked a focus-based (non-event) plan. Plan-preview then rendered "X weeks to Half Marathon" with a PREDICTED FINISH hero, and home title leaked the generic "Fitness Plan".

- **`src/state/initialization.ts`** — `targetDistStr` for `trainingForEvent === false` now derives from focus: endurance → half, speed → 5K, balanced → 10K. Keeps a valid pacing reference for workout generation (MP/HMP zones) without pretending the user picked a race.
- **`src/ui/wizard/steps/plan-preview-v2.ts`** — branches on `s.continuousMode`. Subtitle reads "Ongoing · Endurance focus." or "12-week block · Speed focus." depending on `state.continuousMode`. Hero swaps PREDICTED FINISH + time for a focus-summary card (label, one-line blurb, "No race target. Rolling plan…" caption). Milestone popup suppressed. Prediction-updates-weekly note rewritten to "Your plan adapts weekly…".
- **`src/ui/home-view.ts` + `src/ui/main-view.ts`** — `getHomePlanName` / `getPlanName` now return "Speed Plan" / "Endurance Plan" / "Balanced Plan" for continuous-mode users based on `s.onboarding?.trainingFocus`, falling back to "Fitness Plan" when focus is absent.
- **`src/ui/wizard/steps/initializing.ts`** — short-circuit gains a `runningSettingsChanged` check alongside the triathlon one. Flipping event Y/N or changing focus (which remaps `targetDistStr`) now forces a full reinit on wizard re-entry; previously the initializing screen skipped reinit whenever `wks.length > 0` and left `s.rd` stale.

Known narrow gap: swapping between two races at the *same* distance (e.g. London Marathon → Berlin Marathon) won't currently trip `runningSettingsChanged` because `expectedRd` stays identical. `s.selectedMarathon` / `s.tw` (from weeksUntil) would then be stale. Low impact because normal Edit-Settings flows change mode or distance, not same-distance race pick.

## 2026-04-24 — Triathlon↔running reinit: clear stale event fields

Selecting a running race (e.g. Edinburgh half) after a prior triathlon test kept surfacing "Ironman" on home and "24 weeks to Marathon" on plan-preview. Two compounding leaks:

- **`src/ui/wizard/steps/initializing.ts`** — mid-plan short-circuit (`wks.length > 0 && !modeChanged && !triSettingsChanged`) skipped `initializeSimulator` entirely when switching training modes, so the running wizard never rewrote state. Added `trainingModeChanged = (state.trainingMode === 'triathlon') !== (rt.eventType === 'triathlon')` to force full reinit on the flip.
- **`src/state/initialization.ts`** — running init path never cleared `s.eventType` or `s.triConfig`. Now explicitly sets `s.eventType = 'running'` and `s.triConfig = undefined` alongside `s.trackOnly = false`. `s.rd = 'marathon'` from the triathlon placeholder is already overwritten by `targetDistStr`.

## 2026-04-24 — PB detail-fetch: pace-sorted distance bands

Distance-desc sorting captured the marathon + half PBs but missed 5K/10K PBs from older standalone races (a 2024 18:00 5K race is shorter than a routine 2026 tempo run, so it fell outside the "longest 60" window).

- **`supabase/functions/sync-strava-activities/index.ts`** — best_efforts candidates now bucketed by distance band (4–8 / 8–15 / 18–28 / ≥40 km) and ranked by pace ascending within each. Takes fastest 12 per band (8 for marathons). Total ~44 fetches per session, comfortably under Strava's 100/15-min limit. First-pass covers all four PB distances; remaining activities fill in on subsequent launches.
- **`src/ui/wizard/steps/review.ts`** — PB row order 5K → 10K → Half → Marathon (was 10K → Half → Marathon → 5K). REST query `limit=200` → `1000` so older PB-bearing runs aren't truncated for high-volume users (200 rows only covers ~20 weeks when activity density is 10+/week).

## 2026-04-24 — Strava backfill: 429-tolerant + distance-prioritised PB fetch

- **`supabase/functions/sync-strava-activities/index.ts`** — activity-list paginator now catches 429 mid-loop and proceeds with whatever pages it got. Previously a single 429 on page 3 threw 500, wasting the already-fetched 400 activities.
- **`BEST_EFFORTS_BUDGET` 300 → 60** — Strava's limit is ~100 req / 15 min, so 300 was fantasy. Budget now sized to leave headroom for list pagination + drift/temp heal loops that share the same window.
- **Detail-fetch ordering**: candidates sorted by distance descending before slicing. Marathon PB lives in the longest run, half PB in the longest few, so all four onboarding PBs are captured even if the loop truncates. Previous start-time ordering dropped older (often more PB-rich) runs first on rate-limit.
- **`src/ui/wizard/steps/review.ts`** — volume caption "N runs in 16 weeks" → "N runs in your history" to match the 3-year scan.

## 2026-04-24 — Webhook handlers + `docs/WEBHOOKS.md`

Partner Verification diagnosis: Garmin's portal tests require `deregistration` and `userPermissionsChange` endpoints to be enabled and receive valid 200s. Our webhook had no handlers for either, nor for `stressDetails` (which was arriving silently and confusing the log stream).

- **`supabase/functions/garmin-webhook/index.ts`**
  - `handleDeregistrations` — deletes the `garmin_tokens` row for the user on consent revoke. Physiology data in other tables is preserved.
  - `handleUserPermissions` — logs the new permission set. No automatic action since tokens stay valid; Garmin just stops sending revoked categories.
  - `handleStressDetails` — acknowledges payloads (not stored; app uses `daily_metrics.stress_avg` instead). Prevents silent drops.
  - Three new top-level key routes wired in `Deno.serve`: `stressDetails`, `deregistrations`, `userPermissions`.

- **New: `docs/WEBHOOKS.md`** — single source of truth for the Garmin webhook. Every payload type mapped to handler + DB target, production verification test table with current pass/fail state, key design rules (idempotency, null-safety, field-name drift), deployment checklist, debugging checklist.

- **`CLAUDE.md`** — Key Docs table gains a `WEBHOOKS.md` row.
- **`docs/GARMIN.md`** — cross-linked to the new webhook doc at the top.

Diagnosis this session also established that dev-tier credentials (`client_id 1057f911-...`) suppress VO2 Max / Lactate Threshold fields from `userMetrics` payloads. Real data only flows once Garmin issues a production key, which requires passing all four Partner Verification tests. Currently failing three (Endpoint Setup, Endpoint Coverage, Active User) — next step is enabling the two new endpoints in Garmin's Portal and recording a HR-tracked run to populate the activity coverage tests.

---

## 2026-04-24 — Account: Garmin reconnect path when Strava is connected

After a user disconnects Garmin while Strava remains connected, the Account view previously hid the Garmin tile entirely — `useStravaStandalone` evaluated true and the groupCard only rendered the Strava row, leaving no affordance to reconnect. Two fixes:

- **`src/ui/account-view.ts`** — Strava-standalone card now renders the Strava row *plus* a Garmin row (reusing `renderGarminRow()`, which already handles the not-connected state with a Connect button). `checkGarminStatus()` guard widened: runs unless Apple is the explicit physiology source, so the Connect/Sync/Remove labelling stays accurate.
- **`src/main.ts`** — `?garmin=connected` OAuth callback now writes `wearable: 'garmin'` to state. Previously only the toast and re-render fired, which left `hasPhysiologySource(state, 'garmin')` false after reconnect, skipping the physiology/VO2/LT sync branch on next launch. This is why reconnection wouldn't pull VO2 back even after a clean OAuth round-trip.

Reconnect flow: Account → Connect Garmin → OAuth → return → state flips to Garmin + Strava-enrich card, and the launch branch for `hasPhysiologySource(state, 'garmin')` starts running again.

---

## 2026-04-24 — Just-Track polish pass + plan↔track switching

Holistic pass on Just-Track to make it a first-class mode rather than a bare-bones escape hatch. Five view audits, five small home/stats tweaks, three structural additions (recurring-activities editor, upgrade welcome note, plan↔track transition).

**View audits**

- **`src/ui/record-view.ts`** — idle-state copy branches on `s.trackOnly`: "Record a run" + "Start a run. We'll log distance, pace, and heart rate." replaces "Just Run" + "we'll fit it into your plan automatically."
- **`src/ui/readiness-view.ts`** — `freshnessExplanation` copy that said "Training as planned" now reads "Normal training today is fine" (mode-neutral).
- **`src/ui/strain-view.ts`** — status label "High for a rest day" reframes as "High load today" for trackOnly (no plan means no concept of rest-vs-training days). `coachingText` helper gained a `trackOnly` param for future use.

**Home (`src/ui/home-view.ts → getTrackOnlyHomeHTML`)**

- First-launch orientation: when the user has no CTL, no watch data, and no wks-recorded activity, the hero subcopy flips to "Connect Strava or record your first run to start seeing data." instead of "Tracking only. No plan generated."
- Sleep-log affordance: small "Log sleep" link under the readiness ring → opens `showManualSleepPicker`. Reintroduces manual sleep entry without reintroducing the full Check-in flow.
- "Create a plan" demoted from a full-width glass button to a muted underlined link at the bottom. Track-only is a first-class mode, not a funnel step.
- Daily-target card: "target 42" → "sustainable 42" (with tooltip explaining it's CTL-anchored, not a prescription).
- Unified empty-state copy: "Connect Strava or record a run" is the single CTA across daily-target / volume / load cards.

**End-of-plan → track-only transition (new)**

- **`src/ui/wizard/controller.ts → downgradeToTrackOnly()`** — inverse of `upgradeFromTrackOnly`. Flips `onboarding.trackOnly=true`, sends user through initializing; the mode-change guard (previously added) triggers `initializeSimulator`'s trackOnly branch which rewrites `s.wks` as a rolling one-week bucket. Preserves `s.ctlBaseline`, PBs, physiology, Strava / Garmin / Apple connections.
- **Account → Advanced → "Switch to tracking only"** — button visible only when `!s.trackOnly`. Opens a confirm modal, then calls `downgradeToTrackOnly()`.
- **Home race-complete banner** (`buildRaceCompleteBanner`): shows above today-workout when `selectedMarathon.date < today && !s.trackOnly && !s.continuousMode && !s.racePastPromptDismissed`. Offers "Switch to tracking" button + × dismiss. Dismiss flags on state so banner stops firing.

**Upgrade welcome note (`src/ui/wizard/steps/plan-preview-v2.ts`)**

- When `s.ctlBaseline >= 20` (athlete has meaningful baseline fitness from prior tracking or Strava history), the plan-preview screen now shows: "Starting with X TSS/day of baseline fitness from your recent training. Your plan is pitched to continue from there, not restart you."

**Recurring activities editor (`src/ui/account-view.ts`)**

- New "Training" section shown only when `s.recurringActivities.length > 0`. Tap opens a modal listing each entry with a × remove button. Fixes the "soccer is legacy" UX where users couldn't clean up old onboarding picks without devtools. Adding new activities is still onboarding-only for this iteration.

All changes typecheck. ISSUE-148 to be filed for "Recurring activities — add flow in Account" follow-up.

---

## 2026-04-24 — Triathlon MVP shipped (overnight build)

Full first-pass triathlon mode end-to-end. Running mode untouched. Opt-in via the new Triathlon tile on the goals step. See `docs/TRIATHLON.md` §18 for the spec and `docs/MORNING_SUMMARY.md` for the hands-on guide.

Committed in 7 phases on `triathlon-mvp` branch:

1. **Phase 1 — Types + state + migration + skeleton** (`feat(triathlon): phase 1`). Adds `eventType`, `triConfig`, `Workout.discipline`, `Workout.brickSegments`, `Week.triWorkouts`. Migration v2→v3 defaults existing users to `eventType='running'`. New files: `src/types/triathlon.ts`, `src/constants/transfer-matrix.ts`, `src/constants/triathlon-constants.ts`, `src/state/initialization.triathlon.ts`, `src/workouts/plan_engine.triathlon.ts`.
2. **Phase 2 — Wizard fork** (`feat(triathlon): phase 2`). Triathlon tile on goals routes to a new consolidated `triathlon-setup` step (distance, race date, weekly hours, 3-way volume split picker, three self-rating sliders, bike FTP + power-meter toggle, swim CSS or 400m test). Controller routes triathlon: goals → triathlon-setup → initializing → main-view.
3. **Phase 3 — Plan engine + scheduler + libraries** (`feat(triathlon): phase 3`). Full 20-week 70.3 and 24-week IM generation. New files: `plan_engine.triathlon.ts` (generation), `scheduler.triathlon.ts` (multi-sport day layout + two-a-day + brick placement), `swim.ts`, `bike.ts`, `brick.ts`. Workouts stored on `Week.triWorkouts`.
4. **Phase 4 — Per-discipline fitness + TSS + race prediction** (`feat(triathlon): phase 4`). `triathlon-tss.ts` (cubed-IF swim, squared-IF bike, HR fallback), `fitness-model.triathlon.ts` (per-discipline CTL/ATL via transfer matrix, combined CTL), `race-prediction.triathlon.ts` (per-leg + total + confidence band + sprint/Olympic side-effects).
5. **Phase 5 — UI** (`feat(triathlon): phase 5`). `src/ui/triathlon/` with plan view (day-by-day discipline-coloured cards), home view (today + fitness bars + race forecast), stats view (per-discipline CTL/ATL/TSB + volume + ACWR), reusable workout-card and race-forecast-card. Minimal 3-tab nav (Plan / Home / Stats). Main-view forks on `eventType`.
6. **Phase 6 — Matcher + brick detector** (`feat(triathlon): phase 6`). `activity-matcher.triathlon.ts` (discipline-first matching with same-day + nearest-duration fallback), `brick-detector.ts` (30-min bike→run window). Pure functions; sync-pipeline wiring deferred.
7. **Phase 7 — Tests + docs** (this entry). 36 new passing tests covering swim/bike TSS, per-discipline fitness + transfer matrix, brick detection, and plan-engine output shape. FEATURES.md gains a Triathlon Mode section (T1–T9). ARCHITECTURE.md module map + state abbreviations updated. SCIENCE_LOG.md entries for the transfer matrix, cubed swim TSS, per-discipline CTL, run-leg pace discount, and FTP/CSS detraining curves.

Running-mode regression: test suite 985/986 (the 1 failure pre-existed on `main` — `forecast-profiles.test.ts Speed → Marathon`, unrelated to triathlon work). Typecheck clean throughout.

What's live but untested on device:
- Onboarding end-to-end into the triathlon plan view
- Plan view, home view, stats view, race forecast

What's deferred (punch list at the end of `docs/MORNING_SUMMARY.md`):
- Sync pipelines writing into `triConfig.fitness` (math is ready; plumbing left)
- Cross-discipline ACWR suggestion-modal extensions
- Injury engine discipline-shift
- Strava express-onboarding path
- Targets editing from stats page

## 2026-04-24 — Garmin backfill/reconcile rate-limit hardening

- **Root cause confirmed**: what appeared as persistent 502s from `apis.garmin.com/wellness-api/rest/backfill/*` was in fact Garmin's app-wide 100-req/min rate limit, sometimes raw 429 ("Too many request: Limit 100 per 1 minute") and sometimes wrapped by Cloudflare as an HTML 502 page. Cron + manual sync + localStorage-reset reloads were bursting 3–4 parallel requests per invocation and compounding inside the rolling window.
- **`supabase/functions/garmin-backfill/index.ts`** — requests now serialized (300ms between dailies → sleeps → hrv → userMetrics) instead of `Promise.all`. Response now returns `ok: allOk` and a new `rateLimited` boolean so the client can distinguish throttle from real success and stop locking in the migration guard on failure.
- **`supabase/functions/garmin-reconcile/index.ts`** — same serialization (300ms between dailies → sleeps → userMetrics). Existing throttle detection (`isThrottle`) already bails the run on 429/403/502/503; now the burst rate is cut 3x.
- **`src/data/supabaseClient.ts`** — added shared `mosaic_garmin_cooldown_until` localStorage key (120s window). `triggerGarminBackfill`, `triggerGarminReconcile`, and `refreshRecentSleepScores` all check it before firing and set it when the edge function reports `rateLimited`. `refreshRecentSleepScores` was a hidden amplifier: it runs on every launch when today's sleep is missing and hit garmin-backfill with `weeks:1` regardless of state. Migration guard in `triggerGarminBackfill` now only sets on true success (previously set regardless because edge function returned `ok:true`). `resetGarminBackfillGuard` clears the cooldown too.
- **Net effect**: a stuck-in-rate-limit state now self-heals in 2 minutes instead of requiring manual localStorage clearing. Multiple rapid sync taps no longer spiral the count. Partial failures no longer corrupt the one-shot-backfill guard.

## 2026-04-23 — Triathlon spec locked (no code yet)

- **`docs/TRIATHLON.md` §18 added** — consolidated every open-question decision from the spec-review session into a single "Locked Decisions" section. Where §18 contradicts earlier content, §18 wins. Covers: per-discipline + combined CTL, separate `plan_engine.triathlon.ts`, power-optional bike load (HR fallback), 30-min brick detection window, blessed training constants (swim TSS cubed IF, 10% weekly volume cap, 0.8–1.3 ACWR, 5%/11% run fatigue discounts for race prediction only, FTP/CSS detraining curves from Coyle/Mujika), multi-sport transfer matrix replacing `runSpec` discounts, suggestion-modal extensions for per-discipline and cross-discipline load spikes, injury engine discipline-shift behaviour, triathlete self-rating sliders (1–5 per discipline) replacing `s.typ`, always-race-mode scope, express onboarding path via Strava history for v1.
- **`CLAUDE.md`** — added "Tracking vs Planning" principle. A number used for race-time prediction (tracking) does not automatically apply to training-load calculation (planning). Motivated by the brick run fatigue discussion: 5–11% bike-to-run pace discount is a prediction input, not a stimulus discount.
- **Feature-impact audit** — ran a full 60-row audit (Explore agent) mapping every existing subsystem to a triathlon question + proposed answer. 33 features reuse-as-is or minor extension, 19 major refactors, 8 new subsystems (most deferred to v2). Audit informed §18 decisions.
- **No code changes this session.** Next step: Phase 1 PR (types + state schema + migration + skeleton triathlon plan-engine entry point, running mode untouched).

## 2026-04-24 — Onboarding UX punch list pass

- **`review.ts`** — PB subline now shows only the activity name, drops the date suffix. Removed the now-unused `formatSourceDate` helper.
- **`manual-entry.ts`** — Focus ring on PB/volume inputs matches the welcome baseline (layered inset + lift shadow). PB inputs get inline validation on blur: invalid strings turn the border red and reveal a "Use format mm:ss / h:mm:ss" hint. Valid or empty re-hides it.
- **`runner-type.ts`** — Card wrapped in the glass pattern (rgba-white + blur + Apple three-layer shadow) instead of flat `var(--c-surface)`. Added the radial-light background behind the card so the screen matches welcome / goals.
- **`initializing.ts`** — Added the radial-light background overlay so the loader stops feeling like a bare system screen.
- **`plan-preview-v2.ts`** — CTA sized to 50px height / 25px radius to match every other wizard CTA (was 52 / 26).
- **`goals.ts`** — Disabled mode tiles (Hyrox, Triathlon) now dim to 55% opacity so "Coming soon" reads as non-interactive.
- **`schedule.ts`** — "Add another" button hides once every sport in the catalogue has been added, instead of leaving an empty picker open.
- **`race-target.ts`** — Race rows now render a monochrome landmark SVG when the race id or city matches a known entry. Ten seed landmarks: London (Tower Bridge), Berlin (Brandenburg Gate), Boston (Zakim Bridge), NYC (Empire State), Chicago (Willis Tower), Tokyo (Tokyo Tower), Paris (Eiffel), Valencia (Hemisfèric), Sydney (Opera House), Amsterdam (canal gables). Two-letter monogram remains the fallback for races without a landmark.

## 2026-04-24 — Brain retired, Coach sub-page rewritten rules-only

- **`src/ui/coach-view.ts` (new)** — Replaces `brain-view.ts`. Same Sleep-style design language (sky-background hero, cream body, stacked white cards with the standard two-layer shadow). Structure: stance pill + primary message hero, "Why this call" explanation card (blocker + signal bullets translating the stance into evidence), Recovery / Fitness / This week / Status cards, optional session-drift and sleep-pattern narratives, feeling prompt. Sky palette varies by stance (mint for push, deepBlue for normal, amber for reduce, rose for rest) so the page colour signals state at a glance.
- **`src/ui/brain-view.ts` deleted** — the "Brain" as specced was an LLM-narrative layer. The rules-based synthesis the LLM was meant to deliver is already done by `daily-coach.ts`, so the LLM fetch, 6h localStorage cache, daily call counter, skeleton states, and signals accordion are all removed. The `coach-narrative` edge function stays in `supabase/functions/` as dormant scaffolding for future work.
- **`docs/BRAIN.md`** — prefaced with a status banner stating the Brain is the rules layer (`daily-coach.ts`) and the LLM narrative is deferred until paying users exist. The body of the doc is preserved as design reference. Next LLM scope, when revisited, is "Ask the coach" (chatbot), not the rules-over-narrative paragraph.
- **Wiring** — `home-view.ts` and `plan-view.ts` now import `renderCoachView` from `./coach-view`. `feeling-prompt.ts` comment + `daily-coach.ts` inline comments updated to reference `coach-view`.
- **Motivation (from this session)** — the user's read: the original Brain thesis ("unite disparate signals") has been delivered by the rules layer, the LLM narrative adds cosmetic stitching only, and the Coach button was inconsistent with Check-in (full-page takeover vs compact modal, three names for one thing: Coach button, Brain view, daily-coach calc). Resolved by committing to "Coach" across button + view + file, and matching the established sub-page design pattern used by Sleep / Recovery / Readiness.

## 2026-04-24 — Onboarding cleanup: legacy step files deleted

- **Deleted 15 unused wizard step files**: `activities`, `assessment`, `background`, `commute`, `event-selection`, `fitness-data`, `fitness`, `frequency`, `pbs`, `performance`, `physiology`, `plan-preview`, `strava-history`, `training-goal`, `volume`. These were all leftovers from the pre-rewrite flow with no live call sites.
- **`src/types/onboarding.ts`** — pruned `OnboardingStep` union to the 11 active steps (welcome, goals, connect-strava, manual-entry, review, race-target, schedule, plan-preview-v2, initializing, runner-type, main-view).
- **`src/ui/wizard/renderer.ts`** — removed 15 dead imports and switch cases. File is now 100 lines shorter.
- **`src/ui/wizard/controller.ts`** — removed `physiology` from `STEP_ORDER` (physiology editing already lives on the Account page via the Edit Profile button and wearable sync). Added migration guard in `initWizard`: if persisted state points at a deleted step, bump the user to `goals` (or `welcome` if no name yet).
- **`src/ui/account-view.ts`** — Edit Profile button now jumps to the `review` step (the PBs + volume editor in the new flow) instead of the deleted `pbs` step.

## 2026-04-23 — Onboarding photos: sharper + smaller

- Swapped Page 2 mode-tile photos (Running/Hyrox/Triathlon/Just-track) from 2816×1536 PNGs (~9 MB each) to 1400-wide JPEGs at 92% quality (~350 KB each). 25× smaller, noticeably crisper at the ~440×150 tile size — browser downscaling is much closer to 1:1.
- Removed the `.mode-grain` overlay and the `contrast(1.05)` filter. Photos are now grayscale-only; the bottom vignette remains for label readability.
- Added `image-rendering: -webkit-optimize-contrast` to `.mode-img`.

## 2026-04-23 — Fix: Edit Plan Back button broken

- **`src/ui/events.ts`** — `editSettings()` was setting `currentStep = 'assessment'` (legacy step absent from `STEP_ORDER`), so `canGoBack()` returned false and the Back button was non-functional. Changed re-entry step to `'goals'`.

## 2026-04-23 — Onboarding PB auto-fill: 3-year Strava scan, all rows editable

- **`supabase/functions/sync-strava-activities/index.ts`** — backfill weeks cap raised 52 → 156 (3y). `BEST_EFFORTS_BUDGET` 80 → 300 so the detail fetch loop covers ~3 years of weekly running. HR-stream work still capped at the most-recent 99 via `STREAM_BUDGET`, so older runs only cost one best_efforts detail call each.
- **`src/ui/wizard/steps/review.ts`** — `ACTIVITY_LOOKBACK_DAYS` 182 → 1095 (3y) so the DB read picks up the older best_efforts. All four PB rows (5K / 10K / half / marathon) are now editable; 5K was previously read-only. Subheader now says "Personal bests show the last 3 years. Tap any row to enter an older PB." so users know they can override.
- **`src/calculations/pbs-from-history.ts`** — normalise Strava's best_effort name before map lookup (`"Half-Marathon"` → `"halfmarathon"`). Previously only exact strings `"Half Marathon"` / `"5k"` matched, so runs with the hyphenated name were silently dropped.
- **`supabase/migrations/20260418_add_best_efforts.sql`** — applied to prod. The column had existed in the repo for a week but `db push` was never run, so the REST `select=…,best_efforts` query returned 400 and review.ts silently diverted to manual entry.

## 2026-04-23 — Just-Track: wizard wiring, view guards, account safety

Ship-readiness pass on top of the Just-Track redesign earlier today. Covered by plan `dazzling-knitting-sun.md`.

- **`src/ui/wizard/controller.ts`**
  - `nextStep()` adds a `currentStep==='race-target' && trackOnly` branch that jumps straight to `initializing`, skipping `schedule` + `physiology` + plan-preview. Track-only users no longer walk screens that don't apply to them.
  - Belt-and-braces `while` loop now also skips `schedule` / `physiology` (in addition to `runner-type` / `assessment` / `plan-preview` / `plan-preview-v2`) for trackOnly.
  - `upgradeFromTrackOnly()` now clears `s.wks=[]`, `s.w=1`, `s.tw=0` alongside the mode flip. Fixes a bug where `initializing.ts:89`'s mid-plan guard (`wks.length > 0`) short-circuited plan generation post-upgrade, leaving the user with no plan. CTL / athlete tier / historic volume / PBs / physiology all preserved — skeleton week buckets are the only loss, and they resync from `garmin_activities`.
- **`src/ui/readiness-view.ts:131-135`** — `generateWeekWorkouts(…)` call now skipped when `s.trackOnly`. Previously the readiness detail page was generating a fake "planned" comparison against stale defaults (`rd='half'`, `v=50`, `pac=undefined`), poisoning `plannedDayTSS` maths.
- **`src/ui/strain-view.ts:222-226, 424-428`** — same guard at both call sites. Track-only users now see strain-view with zero-plan comparison instead of fabricated data.
- **`src/ui/account-view.ts`**
  - Change-Runner-Type button hidden for trackOnly (previously calling it re-ran `initializeSimulator()`, which reset the rolling week bucket — destructive and misleading since there's no plan to rebuild). `s.typ` also now renders as `—` instead of the stale `'Balanced'` default when trackOnly.
  - Reset-Plan row relabels to "Reset tracking history" for trackOnly.
- **`src/ui/events.ts`** — `showResetModal()` adapts title / body / CTA copy based on `s.trackOnly`: "Reset tracking history" + "clear your tracked weeks and activity history" instead of plan language.
- **`src/ui/home-view.ts`** — "Tracking" pill added to the track-only home header (left-aligned, next to the account initials button) so the mode is visually unambiguous.

**What's still pending (not blocking ship)**: race-target step is now in `STEP_ORDER` so the front door exists, but the end-to-end wizard path hasn't been manually tested in a browser — typecheck clean only. See plan `dazzling-knitting-sun.md` "Smoke-path verification" for the manual walkthrough needed before calling it done.

---

## 2026-04-23 — Just-Track redesign (rolling bucket, not empty state)

Supersedes the 2026-04-22 entry. First attempt short-circuited `s.wks=[]` and `s.w=0`, which cascaded into view guards everywhere and broke GPS recording / blended-fitness on every launch. Reframed: track-only is the same infrastructure as any non-event `continuousMode` user — one rolling week that extends on the calendar — with plan generation suppressed and prescription UI hidden.

- **`src/state/initialization.ts`** — trackOnly branch rewritten. Seeds `s.wks = [{ w:1, ph:'base', ... }]`, `s.w=1`, `s.tw=1`, `s.continuousMode=true`. PBs optional; VDOT computed if present, else defaults stay. Activity sync, GPS, physiology, CTL, readiness all work unchanged. Strava-detected weekly km seeds `s.wkm`.
- **`src/ui/welcome-back.ts`** — `advanceWeekToToday` now branches on `s.trackOnly` and extends one week at a time with `ph:'base'` (phase is a plan concept, harmless placeholder for trackOnly). Planned continuous users still get 4-week base/build/peak/taper blocks.
- **`src/ui/home-view.ts`** — `getTrackOnlyHomeHTML`:
  - No today-workout, no race-forecast, no Coach/Check-in buttons.
  - New `buildTrackOnlyDailyTarget(s)` card. Anchor: `CTL / 7 × readinessMultiplier`. Readiness mapping: 80+→×1.3 / 60-79→×1.0 / 40-59→×0.7 / <40→×0.3. Today's actual TSS rendered with Gabbett-band colour (green ≤1.3× CTL, amber 1.3-1.5, red >1.5). Suppressed below `ctlBaseline < 20` with a "sync more history" empty state. Full rationale in `docs/SCIENCE_LOG.md` → "Just-Track Daily Load Target".
  - `buildReadinessRing(s)` retained — it's informational, not prescriptive.
  - Weekly volume card from `historicWeeklyKm` (this-week + 8-bar sparkline).
  - `buildSyncActions(s)` + `buildRecentActivity(s)` unchanged.
  - "Create a plan" upgrade button.
- **`src/ui/plan-view.ts`** — track-only plan tab shows the current week's activity-by-day detail, a rolling history list of prior weeks (distance/sessions/TSS per row), and a "Create a plan" card at the bottom. No forward planning.
- **`src/ui/week-debrief.ts`** — `showWeekDebrief` branches on `s.trackOnly` to `showTrackOnlyRetrospective`, a compact modal showing this-week vs last-week deltas on distance, sessions, TSS, CTL, recovery average. Same auto-trigger paths (Monday / Sunday) apply. No plan-adherence language, no "next week" preview.
- **`src/ui/stats-view.ts`** — trackOnly suppresses the Progress (plan-adherence) card; keeps Fitness card (CTL/VDOT trend) since those are derived from actuals.
- **`src/ui/wizard/steps/race-target.ts`** — "Just track" as the 4th focus option (Endurance / Speed / Balanced / Just track). Selecting it sets `trainingFocus='track'`, `trackOnly=true`, clears race date/selection, forces `continuousMode=true`.
- **`src/ui/wizard/controller.ts`** — `nextStep()` skips runner-type / assessment / plan-preview for trackOnly and lands on main-view via `completeOnboarding()`. `upgradeFromTrackOnly()` clears the flag and relaunches the wizard at goals while preserving synced activities / physiology / CTL.
- **`docs/SCIENCE_LOG.md`** — new entry documenting the CTL/7 × readiness anchor and Gabbett band colouring.

**ISSUE-147** (prior note that synced activities land nowhere for trackOnly users) — resolved by the rolling-week redesign.

---

## 2026-04-23 — Garmin backfill switched to nightly server-side reconcile

- **Problem** — `triggerGarminBackfill` was running on every app launch with a 2-hour throttle. With thousands of users opening the app in the morning, that burned through Garmin's 100-req/min app-wide rate limit (keyed on our client ID, shared across all users), producing the 429 storms observed during testing. The launch-time call was also load-bearing on the OAuth-return flow, so deleting it outright would break first-connect history catch-up.
- **`src/data/supabaseClient.ts` `triggerGarminBackfill`** — throttle changed from "every 2h" to "exactly once per OAuth connect". Skip condition is now `migrated && lastRun > 0`. `resetGarminBackfillGuard()` (called from the Garmin connect buttons in `account-view.ts` and `wizard/steps/fitness.ts`) still clears both stamps, so the next launch after OAuth fires a single 8-week backfill. Migration key bumped to `v7-one-shot-backfill` so existing users reset cleanly. `main.ts` launch call sites are untouched — they now no-op on every subsequent launch.
- **`supabase/functions/garmin-reconcile/index.ts`** (new) — nightly reconcile job. In cron mode (authed by `x-cron-secret` header against `RECONCILE_CRON_SECRET` env), finds users who have a `garmin_tokens` row but no `daily_metrics` row for yesterday (UTC), refreshes OAuth tokens as needed, and fires a small `/backfill/dailies` + `/backfill/sleeps` window (3 days). Paced at 2s between users × 2 parallel requests ≈ 60 req/min, comfortably under the 100/min Garmin cap. On 429 the run stops and the next cycle resumes. In user mode (authed by user JWT) reconciles a single user — used by the manual Resync button in Account settings.
- **`supabase/migrations/20260423_garmin_reconcile_cron.sql`** (new) — enables `pg_cron` + `pg_net`, unschedules any prior `garmin-reconcile-nightly` entry, reschedules it at `0 4 * * *` (04:00 UTC daily) via `net.http_post`. Reads `supabase_url` and `reconcile_cron_secret` from `vault.decrypted_secrets`. One-time setup documented in the migration header: create both vault secrets and set `RECONCILE_CRON_SECRET` on the edge function before the cron can authenticate.
- **`supabase/config.toml`** — `[functions.garmin-reconcile] verify_jwt = false` registered. The function does its own auth (cron secret OR Supabase user JWT).
- **Net effect** — live data still flows in via the webhook (unchanged). Launch-time rate storm gone. Dropped-webhook days silently reconciled overnight. First-connect history catch-up still works via the one-shot launch backfill after OAuth.

## 2026-04-23 — Readiness copy: sleep debt leads, freshness sentence gated on real TSB

- **`src/calculations/daily-coach.ts`** — heavy sleep debt (`|sleepBankHours| > 5`) now leads the readiness sentence unconditionally, not only when `drivingSignal === 'recovery'`. The recoveryFloor in `readiness.ts` caps the score when sleep debt is heavy, so surfacing freshness or load as the driver misdiagnosed the actual constraint. Case: 6.6h sleep debt + TSB −1 was reading "Freshness is below normal. 6.6h sleep debt compounds recovery." while the Freshness drill-down on the same screen said "Session fatigue cleared, normal training can continue."
- **Fitness-branch gating** — the freshness-driven copy (`"Freshness is below normal"` / `"Fatigue is building"` / `"Fatigue is high"`) now requires `tsb <= -5`. The non-linear fitness sub-score reads ~39 at neutral TSB, so `drivingSignal === 'fitness'` was firing at TSB ≈ 0 and producing copy that contradicted the Freshness card. Below the threshold the selector falls through to other tiers.
- The `debtSuffix` on the fitness branch is removed (the sleep-debt block above owns that message now; the branch now only fires at genuinely negative TSB).
- **Sleep-debt copy no longer asserts "Light session today"** — `trainedToday = todayTSS > 0` fires on any logged activity (a walk, 19 TSS of background strain), so the old copy told users they'd trained when they hadn't. The `trained && !sessionHeavy` case now collapses into the generic "Prioritise sleep tonight" branch. Only `sessionHeavy` (actualTSS > 1.2 × daily CTL) keeps the session-specific phrasing.

## 2026-04-23 — Strava backfill: best_efforts prioritised, budget raised

- **`supabase/functions/sync-strava-activities/index.ts`** — best_efforts heal block moved from step 7c (last, after drift / temp / calorie loops had spent the Strava 100-req/15-min budget) to step 5c (first, right after the full-stream processing loop). `BEST_EFFORTS_BUDGET` raised from 20 → 80.
- **Why** — onboarding review fills 5K / 10K / half / marathon PBs from `best_efforts`. With the 20-cap + tail position, a first-time user with 30+ runs in the lookback would see partial or empty PBs on the review page and get diverted to manual entry with nothing auto-filled. PBs on day one are more valuable than healing drift / temperature / calorie on older rows — those can fill in on subsequent syncs without the user noticing.
- **Deploy required**: `supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje`.
- **`src/ui/wizard/steps/review.ts`** — diagnostic `console.log` added inside the post-backfill branch so next test prints `rows=… running=… withBestEfforts=… detectedWeeklyKm=…` + the `cachedPbSources` object. Remove once PB auto-fill is confirmed reliable across test accounts.

## 2026-04-23 — Onboarding follow-ups: deeper Strava backfill, race catalogue + thumbnails, hybrid-athlete restored

- **`src/ui/wizard/steps/goals.ts`** — "Just track" tile moved to the bottom of the mode list, below Hyrox and Triathlon. It's a terminal choice, not a training-mode peer, so it reads better last.
- **`src/ui/wizard/steps/review.ts`** — review step now calls `backfillStravaHistory(26)` instead of `syncStravaActivities()` (28 days). The 28-day window missed race PBs from earlier in the year; a 26-week backfill populates `best_efforts` for every running activity in the half-year lookback so the review page can surface 10K / half / marathon PBs. `ACTIVITY_LOOKBACK_DAYS` raised from 120 to 182 so the DB read matches.
- **Review loading screen** — three stage messages so the 20–30s backfill isn't a silent freeze: "Connecting to Strava…" → "Reading your recent runs…" → "Pulling out your personal bests…". Spinner + "This can take 20 to 30 seconds on first connect" subline added.
- **`src/ui/wizard/steps/manual-entry.ts`** — `hybrid` experience level restored ("Hybrid athlete / Fit from other sports, low miles"), matching the legacy `background.ts` option. `rules_engine.ts` and `welcome-back.ts` already branch on `hybrid`, so the plan has been accepting the signal — the wizard just stopped asking for it.
- **`src/data/marathons.ts`** — May–August 2026 half gap filled with 10 events (Leeds, Hackney, Edinburgh, Liverpool, Oslo, Helsinki, Sandown, Reykjavík, Bristol, Nottingham). Marathon catalogue extended with Copenhagen, Stockholm, Helsinki, Reykjavík, Frankfurt, Dublin. Dates match each race's real 2026 calendar slot.
- **`src/ui/wizard/steps/race-target.ts`** — `getMarathonsByDistance` now receives `minWeeksFor(state.raceDistance)` (4wk for half / 5K / 10K, 8wk for marathon) instead of the hard-coded 8-week default. Halfs inside the 4–8 week window are reachable.
- **Race row thumbnails** — every race card has a 56×56 left-side thumbnail. `renderRaceThumb()` uses `race.imageUrl` when set (greyscale photo + vignette); otherwise a deterministic charcoal gradient keyed off the race id with a 2-letter monogram from the city name. Real photos can be dropped into `src/assets/races/<id>.jpg` and wired via `Marathon.imageUrl` with no rendering-side changes.

## 2026-04-23 — Onboarding data-flow + aesthetics pass

- **`src/main.ts` Strava OAuth sync** — `syncStravaActivities()` is now called unconditionally on OAuth return, not gated behind `onMainView`. Previous gate meant a mid-wizard connect returned to connect-strava without actually pulling any activities, so the review page ran on an empty cache and diverted to manual entry.
- **`src/ui/wizard/steps/review.ts`** — mount now awaits `syncStravaActivities()` before calling `fetchRecentActivities()`, so the PB auto-fill reads fresh `best_efforts` rather than whatever happened to be cached. Insufficient-data branch now persists any partial PBs already found via `updateOnboarding({ skippedStrava: true, pbs: partialPbs })` (keyed by `.timeSec`), so users who skip to manual entry don't lose the one or two PBs Strava did surface. Continue handler folds `cachedPbSources` into `state.pbs` before advancing.
- **`src/ui/wizard/steps/physiology.ts`** — auto-pulls from `syncPhysiologySnapshot(1)` on mount when all four values are empty (and not in simulator mode). `setIfEmpty` pattern for `ltPace`, `vo2max`, `restingHR`, `maxHR` so user-entered values are never clobbered.
- **`src/ui/wizard/steps/runner-type.ts`** — auto-skip added for users with <2 distinct PBs on file: classification is noise below that threshold, the engine already defaults to Balanced and recalibrates from real race entries. Spectrum and type buttons rewritten to monochrome only (charcoal fill + thin border for selected, white with faint border for unselected). Marker-offset bug fixed by collapsing to a single element with `transform:translateX(-50%)` — the previous nested `left:${pct}%` was applying the offset twice.
- **`src/ui/wizard/steps/schedule.ts`** — active-row restructured into three stacked sections: sport title + remove X, frequency stepper labelled "Sessions per week", duration slider with "N min" readout. The 28px circular X replaces the underlined "Remove" link so sport removal is a deliberate target rather than a body-text affordance.
- **`src/ui/wizard/controller.ts`** — manual-entry and review back-navigation both land on `goals` (not connect-strava / review), breaking the auto-advance loop where connect-strava re-advances on a live Strava session and review re-diverts when data is thin.

## 2026-04-23 — Onboarding flow fixes: tap-to-advance mode picker, event Y/N on race-target, stepper flash, OAuth gating

- **`src/ui/wizard/steps/goals.ts`** — stripped to a pure 4-tile mode picker (Running / Just track / Hyrox / Triathlon). Tap a tile = commit + advance. No Continue button, no Change pill, no event Y/N, no distance/focus/race selection on this page. "Just track" is now its own mode tile that writes `trainingMode:'fitness' + trainingFocus:'track' + trackOnly:true + continuousMode:true` and rides the Just-Track skip logic already in controller.ts.
- **`src/ui/wizard/steps/race-target.ts`** — absorbed the event Y/N segmented pair at the top of the running block. Gate: `trainingForEvent===null` shows only Y/N; "Yes" reveals distance + event/custom-date picker; "No" reveals a running-mode focus picker (endurance / speed / balanced, no "track" since that's a mode) plus Ongoing/Set-duration. Auto-skips the whole page when `trackOnly===true`.
- **`src/ui/wizard/steps/race-target.ts` stepper flash** — weeks minus/plus no longer call `rerender()`. They patch the readout text, minus/plus `disabled + opacity`, and the Continue button's disabled state in place. The previous full rebuild was visibly flashing the whole page on each click.
- **`src/main.ts` OAuth return** — Strava/Garmin OAuth callbacks now route to account-view only when the user is actually on `main-view` (`state.onboarding.currentStep === 'main-view'`). A user mid-wizard who had previously completed onboarding was being dropped out of the wizard into account-view after connecting Strava; they now stay on the connect-strava step and auto-advance.

## 2026-04-23 — Week debrief defers until activities are assigned

- **`src/ui/week-debrief.ts`** — new `hasUnresolvedActivityAssignments(weekNum)` and `fireDebriefIfReady(pendingDebrief)` exports. The auto-debrief no longer fires when the target week has `garminMatched[id] === '__pending__'` entries or when the matching overlay (`#activity-review-overlay`) is open. The summary card would otherwise display incomplete load (the screenshot case: Week 9 showed 157 TSS / -71% vs plan while three Cardio activities were still sitting in the tray waiting to be placed).
- **`src/main.ts`** — both launch branches (holiday-back and normal) now call `fireDebriefIfReady(pendingDebrief)` instead of showing the debrief directly. Same semantics when nothing is pending; deferred when matching is in-flight.
- **`src/data/activitySync.ts`** — after `showActivityReview` / `autoProcessActivities` resolve, `fireDebriefIfReady` is re-run so the debrief pops once the user saves or cancels out of the matching screen. This covers the launch-race where strava sync opens the matching overlay and the launch-path debrief is suppressed.
- **`src/ui/activity-review.ts`** — `showActivityReview` now removes any mounted `#week-debrief-modal` before creating its overlay. Symmetric with `fireDebriefIfReady`'s `#activity-review-overlay` check — closes the remaining race where the debrief's dynamic import resolves before strava sync queues new `__pending__` items. Matching always wins; debrief re-fires from `onReviewDone`.

## 2026-04-22 — Garmin webhook userMetrics handler hardened

- **`supabase/functions/garmin-webhook/index.ts` `handleUserMetrics`** — root cause of persistent null VO2: Garmin was pushing userMetrics events where the documented field `vo2MaxRunning` was sometimes missing (occasionally present as `vo2Max`), and some events contained only `{userId, calendarDate}` with no actual metrics. Old handler read only `m.vo2MaxRunning` and unconditionally upserted, turning every empty event into an all-null `physiology_snapshots` row that masked the real VO2 behind four days of nulls.
- Fix: accept `vo2MaxRunning ?? vo2Max` (matches the backfill-side interface), skip the upsert entirely when all three metrics are null (preserves any existing good row), and log the raw payload so future field-name drift is diagnosable from edge function logs.
- **Flow confirmation from Supabase logs**: `daily_metrics` rows arrive by webhook with correct `resting_hr`/`max_hr` but `vo2max` always null (Garmin dailies only stamp vo2Max on change days). `physiology_snapshots` is the canonical source; once Garmin pushes a userMetrics event with real data the new handler will upsert it and `sync-physiology-snapshot` will pick it up on the next launch.

## 2026-04-22 — Page 2 restructure: Fitness folded into Running

- **`src/ui/wizard/steps/goals.ts`** — Fitness mode tile removed. Tile grid is now Running / Hyrox / Triathlon. Picking Running opens a "Training for an event?" Yes/No selector. Yes → distance → event picker (existing race flow). No → focus picker (Endurance / Speed / Balanced / Just track — order matches `race-target.ts`). Just-track stays reachable on the currently-live flow via this picker; legacy `trainingMode === 'fitness'` state is migrated on read to running-with-no-event so existing users aren't stranded.
- **Why** — "Fitness" was really "Running without a target race". Two tiles doing overlapping work muddied the grid. Folding the decision inside Running keeps the mode list tied to sports and puts all non-race intent under one focus picker.
- **`docs/ONBOARDING_PLAN.md`** — Locked decisions extended with the new tile structure.
- **`src/ui/wizard/steps/goals.ts`** — removed the `0.55` opacity mask on disabled tiles; the "Coming soon" badge carries the signal alone so all tiles read at full brightness.
- **Hyrox + Triathlon imagery** — editorial B&W photos added (`src/assets/onboarding/hyrox.png`, `triathlon.png`).

## 2026-04-22 — Just-Track mode (activity tracking without a plan)

- **`src/types/onboarding.ts`** — `TrainingFocus` extended to `'speed' | 'endurance' | 'both' | 'track'`. `trackOnly?: boolean` added to `OnboardingState` (default false). Picking "Just track" on the fitness focus picker sets `trainingFocus='track'` and `trackOnly=true`, clears `customRaceDate` / `selectedRace`, and forces `continuousMode=true`.
- **`src/types/state.ts`** — `trackOnly?: boolean` added to `SimulatorState`, mirroring the onboarding flag so views branch without reading `s.onboarding`.
- **`src/state/initialization.ts`** — `initializeSimulator()` short-circuits at the top when `state.trackOnly`: sets `s.trackOnly=true`, `s.wks=[]`, `s.w=0`, `s.tw=0`, `s.continuousMode=true`, persists PBs / physiology / recurring activities if present, saves and returns early before plan generation. The normal plan path now also explicitly sets `s.trackOnly=false` so a user who upgrades gets a clean slate.
- **`src/ui/wizard/steps/race-target.ts`** — fitness focus picker shows four rows in the locked order: Endurance / Speed / Balanced / Just track. Picking "Just track" hides the target-date block.
- **`src/ui/wizard/controller.ts`** — `nextStep()` branches on `currentStep==='initializing' && trackOnly`: call `completeOnboarding()` then `goToStep('main-view')`, skipping runner-type / assessment / plan-preview. A belt-and-braces `while` loop skips any of those steps if reached via the sequential path. New `upgradeFromTrackOnly()` export clears `trackOnly` + `hasCompletedOnboarding`, preserves name / Strava / physiology, and relaunches the wizard at the goals step.
- **`src/ui/home-view.ts`** — `getHomeHTML()` routes to `getTrackOnlyHomeHTML(s)` when `s.trackOnly`. Track-only layout: sky-gradient background, initials button, hero "Hi, {Name} / Activity tracking. No plan, no workouts.", a "Create a plan" upgrade card, `buildSyncActions(s)` and `buildRecentActivity(s)` (both safe with empty `s.wks`). Today-workout, Coach, Check-in, readiness ring, race-forecast widgets are suppressed.
- **`src/ui/plan-view.ts`** — `renderPlanView()` short-circuits to `getTrackOnlyPlanHTML()` when `s.trackOnly`. Empty state: "No plan / You're tracking activities only." + "Create a plan" CTA that calls `upgradeFromTrackOnly()`.
- **`src/ui/stats-view.ts`** — `buildStatsSummary()` suppresses Progress + Fitness cards in track-only mode (both read plan-derived fields). Only the activity summary block renders (already returns `''` when race-mode forecasts aren't computable).
- **Known follow-up** — Strava/Garmin activity matching currently writes into `wk.garminActuals`. Track-only users have `s.wks=[]`, so synced activities land server-side (`garmin_activities`) but won't surface in the local activity feed until the sync pipeline is adapted to create a rolling tracking week or use a plan-independent store. Flagged in OPEN_ISSUES.md.

## 2026-04-18 — Onboarding Pages 5/6/7 drafted (overnight)

- **`src/ui/wizard/steps/race-target.ts`** (new, draft) — Page 5 mode-branched. Running: distance pills (5K/10K/Half/Marathon), race picker (half/marathon) with custom-date toggle, plan-duration stepper (5K/10K). Fitness: focus picker (speed/balanced/endurance) + optional target date. Hyrox/Triathlon auto-skip. Clones `goals.ts` aesthetic (`shadow-ap`, `scRise`-style entry animation, monochrome, no accent colour). Not wired into controller.
- **`src/ui/wizard/steps/schedule.ts`** (new, draft) — Page 6 merges legacy `frequency.ts` + `activities.ts`. Runs-per-week pills (1-7, matches legacy range), gym-sessions pills (0-3), and a multi-select sport picker with per-activity frequency steppers. Writes `runsPerWeek`, `gymSessionsPerWeek`, `recurringActivities`, `activeLifestyle`, keeps legacy `sportsPerWeek` in sync. Not wired into controller.
- **`src/ui/wizard/steps/plan-preview-v2.ts`** (new, draft) — Page 7 visual-consistency rewrite of legacy `plan-preview.ts`. Preserves `calculateLiveForecast`, `findNearestMilestone`, `completeOnboarding()` contract. Replaces tinted green hero card with white monochrome finish-time card + plan summary rows. Milestone overlay re-centered per UX_PATTERNS. Not wired into controller.
- See `docs/ONBOARDING_OVERNIGHT_SUMMARY.md` for preview instructions, open TODO(tristan) items, and risk flags.

## 2026-04-18 — Onboarding Page 4 (Review / magic-moment) built

- **`src/ui/wizard/steps/review.ts`** (new) — "Here's what we found" review screen that renders after Connect Strava. Single scrollable column of editable rows: weekly volume, 10K/Half/Marathon/5K PBs (with "Berlin Marathon · Oct 2024" style source captions), read-only VDOT, runner-type picker. Tap any row to inline-edit in place (no modal, no bottom sheet). Activities fetched directly from `garmin_activities` via Supabase REST, PBs derived via `readPBsFromHistory`. Volume writes to `state.detectedWeeklyKm`, PBs write to `onboarding.pbs`, runner type writes to both `onboarding.confirmedRunnerType` and `state.typ`. If fewer than 12 running activities OR no volume OR no PBs are found, the step silently diverts the user to the manual-entry fallback (sets `skippedStrava: true`) — no intermediate "sorry" screen.
- Controller wiring for the new step deliberately left untouched per task brief — Tristan to wire routing next pass.

## 2026-04-18 — Onboarding glass buttons + Page 2 running photo

- **Page 2 imagery** — dropped the editorial B&W running photo into the Running mode tile (`src/assets/onboarding/running.png`). `goals.ts` sets `imageUrl` on the Running tile; `background-position: 60% 20%` keeps subject head in frame under the tile's grayscale + contrast filter. Hyrox / Triathlon / Fitness still use placeholder gradients.
- **Glass buttons across shipped onboarding screens** — pages 1 (welcome), 2 (goals), manual-entry fallback, and the shared `renderBackButton` all now use `.m-btn-glass`. Goals' segmented label-pill + arrow-chip CTA collapsed into a single glass pill with an inline arrow icon. On page 2, the four mode tiles now carry the glass three-layer shadow + inner highlight, and every interactive sub-control (distance pills, focus pills, race cards, mode-change "Change", week +/- steppers, selected-mode header) uses `.m-btn-glass--inset`. Strava-orange CTA on page 3 retained as the locked branded exception.
- **`docs/ONBOARDING_PLAN.md`** — added "Button style" to Locked decisions so future pages default to glass without re-asking.

## 2026-04-18 — Glass button system (`.m-btn-glass`)

- **`src/styles.css`** — new `.m-btn-glass` utility: frosted white (0.55 alpha), `backdrop-filter: blur(20px) saturate(1.4)`, Apple three-layer shadow stack, inner highlight, pill radius. `:active` uses `scale(0.985)` + subtle inset shadow for a tactile dent (120ms transition). Also `.m-btn-glass--inset` variant with a calmer two-layer shadow for buttons nested inside elevated cards.
- **`docs/UX_PATTERNS.md`** — documented as the default interactive button for taps, with usage rules (onboarding CTAs, home actions, modal confirms) and when not to use it (muted nav links, destructive confirms). Two-level rule: default for hero/background contexts, `--inset` when nested in a card.
- **Applied to:** Home header Coach / Check-in buttons, Readiness "Adjust plan" CTA (inset), Home Today "Done · View" x2 (inset), Sync Activities, Record view Pause/Resume, Injury modal Cancel buttons x4 (inset), GPS completion modal Keep / Close (inset). Primary black CTAs (Start, Save, Confirm) and destructive red buttons (Stop, Discard) unchanged — glass is for the tactile secondary, black stays as the unambiguous primary.

## 2026-04-18 — Strava `best_efforts` pipeline for PB auto-fill

- **`supabase/migrations/20260418_add_best_efforts.sql`** (new) — adds `best_efforts jsonb` column to `garmin_activities`. Stores Strava's `best_efforts` array verbatim (only RUNNING activities populate it).
- **`supabase/functions/sync-strava-activities/index.ts`** — backfill mode now captures `best_efforts` for RUNNING activities. The existing full-stream detail fetch (already made per-run for calories + splits) picks up `best_efforts` at no extra cost. A new step 7c (`BEST_EFFORTS_BUDGET = 20` per backfill, most-recent first) heals older runs that were stored before the column existed. Skips activities whose `best_efforts` is already non-null in DB. Select in step 2 widened to `best_efforts` so `cachedWithBestEfforts` can be built. Detail endpoint failures fall back to no best_efforts rather than breaking the backfill.
- **`src/calculations/pbs-from-history.ts`** (new) — `readPBsFromHistory(activities)` walks each activity's `best_efforts`, returns the fastest time per canonical distance (5k / 10k / half / marathon). New `PBsWithSource` return type carries `{ timeSec, activityId, startDate, activityName }` so onboarding can show attribution ("3:12 · Berlin Marathon, Oct 2024"). Uses `elapsed_time` (matches Strava's displayed PB, consistent with chip-timed race times). Accepts both camelCase and snake_case field names.

## 2026-04-18 — Onboarding Page 3 (Connect Strava) built

- **`src/ui/wizard/steps/connect-strava.ts`** (new) — standalone Strava connect screen matching the Page 2 aesthetic: light cream background, radial highlight, progress dots (3 of 7), photo-ready B&W placeholder slot (170px, grain + vignette + watermark), Apple 3-layer shadow. Primary CTA is Strava orange (`#FC4C02`, 52px pill) — the one permitted non-neutral on the screen, since it is the permission grant for a branded third-party. Secondary action is a muted underlined "Enter manually" text link (no colour, no border, per CLAUDE.md). OAuth flow mirrors `fitness.ts` — calls `strava-auth-start` edge function and redirects. On mount, `isStravaConnected()` is checked; if already linked, the step silently advances via `window.wizardNext()` with no intermediate confirmation screen.
- **`src/types/onboarding.ts`** — added `skippedStrava?: boolean` to `OnboardingState` (default `false`) so the controller can route users who chose manual entry to the compressed fallback step.
- Controller wiring for step order deliberately left untouched — will be rewired once Page 4 (Review) and the manual-entry fallback land.

## 2026-04-18 — Onboarding manual-entry fallback screen

- **`src/ui/wizard/steps/manual-entry.ts`** (new) — single compressed screen shown when the user taps "Enter manually" on the Connect Strava step. Collapses three legacy steps (background / volume / PBs) into one: experience pills (6 options from `RunnerExperience`), four optional PB inputs (5K / 10K / Half / Marathon) with `mm:ss` or `h:mm:ss` parsing, and one weekly-volume input that respects `state.unitPref` (label toggles `km / week` / `mi / week`; value stored to `state.detectedWeeklyKm` always in km). All fields optional. Continue commits whatever was entered and calls `window.wizardNext()`. Aesthetic mirrors `goals.ts`: cream background, Apple 3-layer shadow on cards, rounded pills, monochrome black CTA (not accent). Controller wiring deferred to a separate pass.

## 2026-04-17 — Garmin backfill rewritten to use webhook push model

- **`supabase/functions/garmin-backfill/index.ts`** — replaced day-by-day GET pulls of `/wellness-api/rest/{dailies,sleeps,hrv,userMetrics}` with single POSTs to the `/backfill/{type}` endpoints. The pull endpoints require a Consumer Pull Token (CPT); without a valid CPT every pull returned `InvalidPullTokenException` and silently produced 0 rows. Garmin's backfill POST endpoints accept the user bearer alone and deliver data asynchronously via the existing `garmin-webhook` function. Function now returns 202 status per data type rather than upserting synchronously.
- **`src/data/supabaseClient.ts` `triggerGarminBackfill`** — updated log to show per-type request statuses (`dailies=202 sleeps=202 hrv=202 userMetrics=202`) and surface any error bodies returned by Garmin. Migration key bumped to `v6-webhook-backfill` so all clients re-run once after the deploy.
- **Flow change**: data no longer lands on the same launch as the backfill call. First launch queues the webhook pushes; a subsequent launch (minutes later) reads the freshly-arrived rows from `daily_metrics` / `sleep_summaries` / `physiology_snapshots` via `syncPhysiologySnapshot`.

## 2026-04-17 — Onboarding Page 2 (Training Goal) rebuilt

- **`src/ui/wizard/steps/goals.ts`** rewritten as a 4-tile mode picker: Running, Hyrox, Triathlon, Fitness. Vertical full-bleed tiles (104px tall), B&W placeholder gradient + subtle grain + vignette, 18px label + 12px sub. Hyrox and Triathlon are non-clickable with a "Coming soon" pill badge (triathlon research lives in `docs/TRIATHLON.md`; Hyrox flow not yet built). Running and Fitness are live. Editorial B&W imagery will land later — swap `ModeTile.bg` to `background-image: url(...)` when nano banana assets are generated.
- **Selected state**: white ring (2px inner + 2px outer dark) + check chip top-right + staggered rise-in animation (`g-rise` keyframe with 50ms cascade).
- **Segmented Continue CTA**: glossy black label pill + separate circular arrow chip, 8px gap. Both get a `:active` dent (`translateY(1px)` + reduced shadow) so the button visibly presses in. Disabled state fades + disables pointer events.
- **Detail picker preserved below tiles** so plan generation keeps working until Page 5 ships: Running → distance grid + week selector (5k/10k) or inline event list (half/marathon); Fitness → focus (Speed / Balanced / Endurance).
- **`src/types/onboarding.ts`** — added `trainingMode?: 'running' | 'hyrox' | 'triathlon' | 'fitness' | null` to `OnboardingState`. Legacy `trainingForEvent` is auto-patched alongside (`running → true`, `fitness → false`) so downstream steps keep working unchanged.
- **`src/ui/wizard/renderer.ts`** — killed the injected top banner ("This takes a little longer than most running apps…"). `shouldShowBanner` block and DOM injection removed. Any stale `#onboarding-banner` element is still cleaned up on each render as a safeguard.
- Onboarding progress dots remain 2 of 7.

## 2026-04-17 — Brain reframed to LLM-first, signal-hash cache

- **`src/ui/brain-view.ts`** — Full page restructure. The three-sentence LLM paragraph is now the hero (17px, line-height 1.55, no card). The stance shows as a small pill above the paragraph instead of a giant label + ring. The daily feeling prompt sits directly below the paragraph. All previous dashboard sections (This week / Recovery / Fitness / Status / session note / sleep insight) collapse into one "Show signals" accordion, closed by default. While the LLM is loading, the hero shows a 3-line pulsing skeleton; on failure it silently renders the rules-based `primaryMessage` in the same slot with identical styling.
- **`supabase/functions/coach-narrative/index.ts`** — New system prompt enforces Verdict / Why / Action three-sentence structure, uses only the existing readiness vocabulary, explicitly bans motivational filler and em dashes, and states that the rules engine already set `stance` so the LLM only explains and prescribes. `max_tokens` raised from 200 to 400 so the three sentences actually fit.
- **Enriched payload** — `buildCoachSignalsPayload(coach)` in `daily-coach.ts` produces a flat ~18-field object including today's planned workout (title, description, plannedTss, plannedDurationMin), `todayFeeling`, `hrvPctVsBaseline`, and `primaryMessageFallback`. Previous payload missed today's workout entirely, which is why Actions could never be concrete.
- **Signal-hash skip (zero-cost cache)** — Edge function now SHA-256-hashes the canonicalised (sorted-key) payload, looks up `coach_narrative_cache(user_id PK, signals_hash, narrative, created_at)`, and returns the stored narrative without an Anthropic call when the hash matches within 24h. Per-user quota is NOT incremented on cache hits.
- **Client cache TTL** raised 4h to 6h. HTTP round-trip saver only; the server-side cache is the authoritative layer now.
- **New migration** `supabase/migrations/20260417_coach_narrative_cache.sql` creates the cache table with RLS (users read own row, service_role writes).
- **`daily-coach.ts`** — `CoachSignals` extended with `todayWorkoutDescription`, `todayPlannedTSS`, `todayPlannedDurationMin`, `todayFeeling`. `StrainContext.todayPlannedWorkout` is now populated by `deriveStrainContext` and surfaces through to `CoachSignals`, replacing the broken `(s as any)._cachedWorkouts` lookup that never populated.

## 2026-04-17 — Readiness post-session copy warmed up

- **`src/calculations/daily-coach.ts`** — `derivePrimaryMessage` Tier 1 lines rewritten to feel less clinical. "Daily load target reached (78 TSS). Training is complete for today." → "Solid session today (78 TSS). Rest up and recover." Overreach tier: "Big session logged … Daily target well exceeded — recovery is the priority …" → "Big session today (344 TSS). Rest up and prioritise recovery for the next 24 hours." Also removed the forbidden em dash from the overreach message.
- **`src/calculations/daily-coach.ts` + `src/ui/readiness-view.ts` + `src/ui/home-view.ts`** — Readiness ring sublabel now swaps to "Recovery" (≥100% strain) or "Recovering" (≥130% overreach) when low readiness is session-driven. Centralised in `derivePostSessionLabel()` and exposed via `CoachState.ringLabel` so Home and the Readiness detail view stay in sync automatically. Guarded against sleep/HRV/ACWR/legLoad hard floors (those keep the original "Manage Load" / "Ease Back" / "Overreaching" label because the session isn't the cause). Adhoc/rest-day sessions with no planned target also trigger the swap by comparing `actualTSS` to daily CTL, so a big kitesurf on an unplanned day flips the label the same way a completed long run would. When the swap fires, `CoachSignals.readinessLabel` is rewritten too, so the LLM narrative edge function and any downstream stance copy see the warm label rather than the clinical one.

## 2026-04-17 — Leg Fatigue view cleanup + relabel propagation

- **`src/ui/leg-load-view.ts`** — Decay Timeline chart rewritten as a canonical area chart per `docs/UX_PATTERNS.md`: past load (solid fill 0.18 + 1.5px stroke) and 4-day decay projection (fill 0.07 + dashed stroke, opacity 0.5). Removed the session dots, inner SVG `<text>` axis labels (moved to absolute-positioned spans outside the SVG), "Now" vertical bar (replaced with a very muted dashed split marker per forecast-continuation pattern), threshold zone fills, and in-chart threshold dashed lines — the chart now reads clean.
- **Projection card removed** (Floor releases / Fully fresh / "1.3x per reload" copy). The decay timeline already communicates the same thing visually. Unused `projectClearHours`/`projectFreshHours`/`fmtHours` helpers deleted.
- **Recent Sessions card simplified** — dropped jargon (`raw 25.7 (rate 0.15/min)`, `7.9 remaining (100%)`, `Half-life Xh`, `clearance delayed by N sessions`). Each row now shows sport label, relative time, clock, and a plain-English status (`still loading legs` / `mostly cleared` / `cleared`) tiered by per-session decay fraction.
- **Background palette → sage** (new `SKY_PALETTES.sage` in `src/ui/sky-background.ts`): muted green-grey, evokes tissue recovery without the alarm of red or the warmth of bronze/amber. `bronze` retained for backwards compat.
- **Relabel propagation fixes**:
  - `src/ui/home-view.ts` Recent list — activity rows now read the user-effective sport label (respects `manualSport` override) instead of the raw `activityType`. A relabelled "Cardio → Kitesurfing" activity now shows as "Kitesurfing" in Recent.
  - `src/ui/activity-detail.ts` title — when `manualSport` is set, the big header uses the sport label instead of the raw Strava `workoutName`/`displayName` (which often reads "Cardio").
  - `src/ui/sport-picker-modal.ts` `reclassifyActivity` — no longer early-returns when the activity isn't matched to a week. Week-scoped TSS/impact deltas only apply when a week is found, but the `recentLegLoads` push + `manualSport` + `sportNameMappings` write now always run.
  - `src/ui/sport-picker-modal.ts` new `reconcileRecentLegLoads()` — idempotent pass over `garminActuals` that backfills missing `recentLegLoads` entries (keyed by `garminId`) for auto-synced cross-training. `recordLegLoad` is only called from the review flow, so silent auto-matches (e.g. a second kitesurf auto-resolved via a prior `sportNameMappings` entry) never pushed a leg-load row. Called on every `renderLegLoadView` open. Root cause of "only one kitesurfing activity shows in leg load".
- **Readiness detail: Leg Fatigue card positioning.** Moved to the bottom of the sub-score column (after rolling-load), "View →" label dropped so it matches the other cards visually, and the tap handler rebound from the old `rdn-leg-load-callout` id to the new `rdn-card-leg-load` card id — the card was unclickable before this fix.

## 2026-04-17 — Garmin backfill: auto-refresh expired access tokens

- **`supabase/functions/garmin-backfill/index.ts`** now checks `garmin_tokens.expires_at` and refreshes the access token in-place before making any Garmin API call (5-minute buffer). Previously the function read whatever `access_token` was stored — if it had expired, every Garmin call returned 502/empty bodies (observed: 0 daily rows, 0 sleep rows, `/backfill/userMetrics` → 502). This silently failed because we treated the empty response as "Garmin returned nothing" instead of "auth is dead."
- On successful refresh, the new access + refresh tokens and `expires_at` are written back to `garmin_tokens` before the backfill continues.
- Client migration key bumped to `v4-token-autorefresh` so every user re-runs backfill on next launch once the new edge function is live.

## 2026-04-17 — VO2 hydration: walk back to most recent non-null + clear stale seed

- **`src/data/physiologySync.ts`** — Garmin's dailies endpoint only stamps `vo2Max` on days when the value changes; the latest row is usually null even when earlier days in the same window have the real current reading. Hydration now walks backwards through `rows` to find the most recent non-null `vo2max` (logged as `latestDailyVo2=N@YYYY-MM-DD`).
- **Stale seed now cleared when there's no device VO2 anywhere.** If Garmin returns daily rows but none carry `vo2max`, *and* `physiology_snapshots` has no userMetrics row, `s.vo2` is set to `undefined` so the UI falls back to `computeCurrentVDOT()` instead of pinning the wizard-seed value forever. Guarded by `rows.length > 0` so users without Garmin connected keep their wizard seed.

## 2026-04-17 — Daily feeling + tiered illness wired into the coach

- **`src/calculations/daily-coach.ts`** — Promoted `workoutMod` from a local view helper to a real field on `CoachState`. Derived from final stance (`rest → skip`, `reduce → downgrade`, else `none`), matching the mapping in `docs/BRAIN.md`. Removed the duplicated `deriveWorkoutMod` helpers in `home-view.ts` and `plan-view.ts` — both now read `coach.workoutMod` directly. Added `getTodayFeeling(s)` helper that returns the stored value only when its date equals today's ISO, handling end-of-day expiry in one place.
- **Tiered illness** — `illnessState.severity === 'resting'` forces stance to `rest`; `'light'` caps the stance at `reduce` (drops `push`/`normal` down, leaves `reduce`/`rest` as-is). Illness cap is applied before the feeling modifier, so a `good` feeling on a light illness day still returns `reduce`.
- **Daily feeling modifier** — After base stance is computed, `s.todayFeeling` can shift it: `struggling` drops one level (push → normal → reduce → rest); `good`/`great` promote only `normal → push`, gated on `blockers.length === 0` AND `readiness.score >= 75` (Primed threshold from `readiness.ts`). `ok` is a no-op. Rationale logged in `docs/SCIENCE_LOG.md`.
- **`src/ui/feeling-prompt.ts` (new)** — Shared HTML/handler helper used by both `home-view` and `brain-view` so the "How do you feel today?" prompt is rendered consistently. Four pill buttons (Struggling / Ok / Good / Great), border-only styling, no emoji, no accent colour. Home variant uses CSS vars; Brain variant uses the sub-page palette.
- **Home placement** — Prompt appears under the Coach/Check-in button row. Opt-in only — no forced modal on app open.
- **Tests** — New `src/calculations/daily-coach.test.ts` (20 cases, all passing). Covers stance → workoutMod mapping, illness tiering (resting/light), feeling modifier (struggling drops at each base level, ok no-ops, good/great promote only under the Primed threshold, blockers prevent promotion, illness overrides feeling boost), and `getTodayFeeling` end-of-day expiry.

## 2026-04-17 — Coach workout modifier on today's card

- **`src/ui/home-view.ts` and `src/ui/plan-view.ts`** — Today's workout now surfaces the coach's stance as an inline advisory. When `CoachState.stance` is `reduce`, the row appends "Downgraded. {primaryMessage}" in a bordered muted row; when `rest`, it appends "Consider rest today. {primaryMessage}". Stance `normal` or `push` renders nothing. The workout content is not silently altered — the athlete sees the suggestion and decides.
- **Scope** — Only today's row renders the note. Past and future days are untouched. Suppressed when the session is already rated, skipped, or replaced. `computeDailyCoach(s)` is called once per render at the top of `getHomeHTML` / `buildWorkoutCards` (plan view skips the call entirely when the viewed week isn't the current week or today falls outside the range).
- **Derivation** — `stance → workoutMod` mapping follows `docs/BRAIN.md` (`rest → skip`, `reduce → downgrade`, `normal`/`push → none`). `deriveWorkoutMod` lives in each view; `daily-coach.ts` is untouched.

## 2026-04-17 — Garmin backfill throttle reworked (self-heals after code changes)

- **`src/data/supabaseClient.ts` `triggerGarminBackfill`** — The v1 throttle set a 12-hour lock whenever the edge function returned `days: 0, sleepDays: 0`. If Garmin's API returned transient empties (pre-morning watch sync or brief outage), the app wouldn't retry for half a day — and when client code added new Garmin endpoints (e.g. the userMetrics backfill request), existing users stayed locked out until the timer naturally expired.
- **Replaced with a "last run" timestamp + migration key.** Throttle now fires at most once per 2 hours regardless of API outcome. A `mosaic_garmin_backfill_migration` key tracks which code version last ran; bumping the constant (currently `v2-userMetrics`) forces every user's next launch to re-run backfill, so future Garmin endpoint additions propagate without manual intervention.
- **Legacy keys (`mosaic_garmin_backfill_empty`, `mosaic_garmin_backfill_empty_until`) removed on boot.** `resetGarminBackfillGuard()` updated to clear both the new and old keys.

## 2026-04-17 — Race forecast fixes: trajectory, ring palette, stats cleanup

- **`src/ui/race-forecast-view.ts`** — "Started" now anchored from `s.iv` (initial VDOT at plan start), not from the first `vdotHistory` entry. Synthetic week-1 chart point injected from `s.iv` when no early history exists, so the chart always shows the full plan trajectory. Ring palette switched from green-default to amber-default (red when >15 min off-track). Green tier removed.
- **`src/ui/stats-view.ts`** — Removed `buildRaceProgressDetail` card. It mixed `currentFitness` (potentially different-distance scale) with `initialBaseline` (goal-distance scale), producing nonsensical comparisons like "40:09" next to "3:15:00". The full-page race forecast view is now the canonical surface.

## 2026-04-17 — Stats Fitness card: full chart on opening view

- **`src/ui/stats-view.ts` `buildFitnessCard_Opening`** — Replaced the 40 px mini sparkline with the same full line chart (`buildVO2LineChart` / `buildVdotLineChart`) used on the Fitness detail page, plus the change-note ("↓ N pts since …"). The opening card now shows the VO2 Max / VDOT trend at 90 px with axis date labels, matching the detail view. `buildMiniVO2Sparkline` and `buildMiniVdotSparkline` deleted — no longer referenced.

## 2026-04-17 — Welcome screen: back to open layout, stronger copy

- Dropped the enclosing plane from the earlier three-z-level rebuild — the panel read like a modal and killed the hero's spaciousness. Kept the two things from that pass that were doing real work: the subtle z1 radial light, and the staggered entrance animation.
- **Copy**: subheadline → **"Running, strength, sport, and recovery. All accounted for."** (concrete, rhythmic, consultant tone). CTA → **"Build my plan"** (was "Are you ready?" — slogan, not an action). Four bullet proof-list → **single centered trust row**: "Science-backed · Recovery-informed · Personalized from your data".
- Form and CTA still use the frosted input + glossy black pill depth treatment from the earlier pass. MOSAIC stays flat black.

## 2026-04-17 — Onboarding welcome: three z-level rebuild + copy overhaul

- **`src/ui/wizard/steps/welcome.ts`** — Rebuilt around three z-levels:
  - **z1 (background)**: flat warm off-white with a subtle centered radial light (`radial-gradient(ellipse 720px 560px at 50% 42%, rgba(255,255,255,0.6) → transparent)`) so the page feels lit, not flat.
  - **z2 (content plane)**: barely visible contained surface around the central stack — `rgba(255,255,255,0.4)` + `backdrop-filter:blur(6px)` + 1px `rgba(0,0,0,0.035)` border + very diffuse shadow. Reads as a faint plane, not a card.
  - **z3 (interactive)**: frosted name input + glossy black CTA with their own soft elevation. Focus/active states defined via a local `<style>` block for pseudo-classes.
- **Motion**: local `wRise` keyframe (0.8s cubic-bezier), staggered entrance — brand → tagline → input → CTA → sign-in → bullets.
- **Copy rewrite**:
  - "INTELLIGENT TRAINING" → **"Training that adapts"**
  - "Your personalized path to peak performance" → **"Your plan updates with load, recovery and every sport you play"**
  - Three dot-bullets ("Science-backed · Adaptive · Personal") replaced with a 4-item list: **Built on proven training principles / Recovery and load-informed / Personalized from your data / Science-backed coaching logic**, below the content plane.
  - "Powered by VDOT methodology" footer line removed. ⚡ demo-fill stays.
- **`src/ui/wizard/steps/background.ts`** — Selection pills (running background options, Yes/No commute) replaced 2px hard borders with two surfaces: `PILL_UNSELECTED` (frosted white + blur + soft shadow) and `PILL_SELECTED` (glossy black + inner highlight + deep shadow). Selected pills invert text to `#FDFCF7` and checkmark to light. Continue button matches the glossy-black CTA.
- **Scope**: welcome + background only. Other wizard steps pending review.

## 2026-04-17 — Sign-in link on onboarding welcome screen

- **`src/ui/wizard/steps/welcome.ts`** — Added "Already have an account? Sign in" link under the CTA. Clicking clears the simulator-mode flag, calls `supabase.auth.signOut()`, then renders the auth view. Lets users whose local state was wiped (e.g. by the persistence validator's broken-data auto-clear) get back to the login form without a manual localStorage reset.

## 2026-04-17 — Brain sub-page replaces Coach modal

- **`src/ui/brain-view.ts` (new)** — Full-page coaching view reached from the Coach pill on Home and Plan. Structure: stance hero (Ready to Push / On Track / Manage Load / Ease Back) with the `primaryMessage`, LLM narrative card, then plain-row sections for This week (Effort + Load pills), Recovery (Readiness, Sleep, HRV, Sleep bank), Fitness (CTL + trend, weekly TSS, 4-week trend), Status (injury/illness/check-in), and a daily "How do you feel today?" prompt.
- **Daily feeling prompt** — 4-button tap (`Struggling / Ok / Good / Great`) writes `s.todayFeeling = { value, date }` and shows the chosen value with a `change` affordance for the rest of the day. State field added to `SimulatorState`.
- **Narrative rate-limit + cache** — ported from the old coach-modal: 3 calls/day, 4-hour `localStorage` cache, rules-based `primaryMessage` fallback on error or limit.
- **Wiring** — `home-view.ts` and `plan-view.ts` now dynamic-import `renderBrainView` from the Coach pill handler. `onBack` returns to the opener.
- **`src/ui/coach-modal.ts` deleted** — superseded by the sub-page. ARCHITECTURE.md page table + navigation graph updated to list `brain-view.ts` and remove the Coach modal entry.

## 2026-04-17 — Sport reclassification on activity detail page

- **Problem.** "Cardio" activities (kitesurfing, other unknown sports logged under Strava/Garmin's generic cardio bucket) fell through `mapAppTypeToSport → 'generic_sport'`, so load was computed with `runSpec 0.40 / impactPerMin 0.04 / legLoadPerMin 0`. Leg fatigue from a 2-hour kitesurf stayed at zero.
- **`src/ui/sport-picker-modal.ts` (new)** — Centered modal listing every sport in `SPORT_LABELS` (alphabetised, `extra_run` and `hybrid_test_sport` excluded). Current sport highlighted with a tick. Resolves with the chosen `SportKey` or null on cancel.
- **`reclassifyActivity(actual, newSport)`** — Computes old vs new `crossTL` / `impactLoad` / `legLoadPerMin × minutes`, applies the delta to the owning week's `actualTSS` and `actualImpactLoad`, removes the old `recentLegLoads` entry (matched by new `garminId` field) and appends a new one. Sets `actual.manualSport` and saves `s.sportNameMappings[normalized(activityName)] = newSport` so future syncs of same-named activities auto-apply.
- **`getEffectiveSport(actual)`** — Sport resolution for display and calcs. Precedence: `manualSport` override → `s.sportNameMappings` by normalized activity name → `deriveSportFromActivityType` (keyword match on raw Garmin/Strava type) → `generic_sport`.
- **`src/ui/activity-detail.ts`** — New "Activity" row between hero and stats, rendered only for non-running actuals. Prominent copy "Tap to choose the right activity" when sport is `generic_sport`; muted "Tap to change" when a specific sport is resolved. Tap opens `showSportPicker`, then calls `reclassifyActivity` and re-renders.
- **`src/ui/activity-review.ts`** — Four `mapAppTypeToSport` sites (unspent load item, remainingCross adjustments, overflow adjustments, `buildCombinedActivity`) now go through `resolveSportForActivity(name, appTypeSport, rawActivityType)` so a saved mapping auto-applies at sync time.
- **Types.** `GarminActual.manualSport?: SportKey`, `recentLegLoads[].garminId?: string`, `SimulatorState.sportNameMappings?: Record<string, SportKey>`.
- **SCIENCE_LOG entry added** ("Cross-Training Sport Coefficients") for the seven board/water sports introduced with this feature and the pragmatic derivations behind their coefficients.

## 2026-04-17 — Strain week bars include passive TSS

- **`src/ui/strain-view.ts`** — `getWeekBarDays` now computes `actualTSS` via `computeTodayStrainTSS` (logged + passive excess from steps) instead of `computeTodaySignalBTSS` (logged only). Previously the ring could read "18 TSS" from background activity while the same day's week bar showed "—", since the bar only counted recorded activities. The two surfaces now agree.

## 2026-04-16 — Home STRAIN ring green while building toward target

- **`src/ui/home-view.ts`** — The small home STRAIN ring used `var(--c-caution)` (amber) whenever today's TSS was below `target.lo`, so light days displayed an orange arc and TSS number even though the strain drill-down page rendered the same load as green (strain-view's segment logic paints `0 → target.lo` in `#34C759`). Swapped the below-target branch to `var(--c-ok)` so the home ring matches the drill-down page: green while building, amber only when rest-day overreaching or load exceeded. The "Building" / "Light" labels stay the same.

## 2026-04-16 — Race forecast surface: Home card + full-page chart, modal removed

- **`src/ui/prediction-breakdown.ts` deleted.** The "Why this prediction?" modal launched from `cv-tile`, `fc-tile`, the Stats race-estimate row, and the wizard plan-preview "Why this time ›" link is gone. It rendered "—" for users without enough run history (most onboarding states) and duplicated the Stats forecast table in a less informative format.
- **`src/ui/home-view.ts`** — New `buildRaceForecastCard(s)` placed between today's-workout and readiness ring, race mode only (`!s.continuousMode && s.rd && s.initialBaseline`). Shows distance label, large predicted finish time, target time, and signed delta vs target ("On pace" / `+N min` / `−N min`, U+2212 minus). Tap opens the new race forecast page.
- **`src/ui/race-forecast-view.ts` (new)** — Full-page forecast view modelled on `rolling-load-view.ts`. Hero ring (gradient amber → red as forecast lags goal, fill = % through plan), Started · Now · Forecast stat row, line chart of race-time progression at `s.rd`. Solid stroke for `s.vdotHistory` actuals (converted via `tv(vdot, rdKm(s.rd))`), dashed continuation to `s.forecastTime` at week `s.tw`, horizontal dashed reference line at `s.initialBaseline` with HTML "Goal" label in the right gutter. "Add a quality session" CTA appears when not in taper, `s.epw < 7`, and forecast lags goal by ≥ 20 min — bumps `s.rw + s.epw` then re-runs `refreshBlendedFitness` (mirrors the `goal-add-session` lever in plan-view). Race-day pacing disclaimer footnote.
- **`src/ui/main-view.ts`** — Plan predictions row trimmed from 3 to 2 columns. "Current" column dropped (was driven by `s.currentFitness`, the same number the stats page already shows on the race row). Forecast column now carries the signed-delta subline ("+13 min vs target" / "On pace vs target"). `cv-tile` and `fc-tile` IDs and their (now-removed) modal handlers gone.
- **`src/ui/stats-view.ts`** — Race-estimate row matching `s.rd` now renders an inline signed delta ("+13 min" / "On pace") to the left of the time, race mode only. Other distances stay unannotated. The `.race-est-row` no longer opens the deleted modal.
- Delta convention: `forecast − goal` (positive = slower, negative = faster). Always uses Unicode minus `\u2212`, not a hyphen.

## 2026-04-16 — Running VO2 Max alignment with Garmin Connect

- **`supabase/functions/garmin-backfill/index.ts`** now fetches `/wellness-api/rest/userMetrics` in parallel with dailies/sleep/HRV and upserts into `physiology_snapshots` (`vo2_max_running`, `lactate_threshold_pace`, `lt_heart_rate`). Previously the backfill only touched `daily_metrics.vo2max` (the crude dailies field) and relied on live webhook `userMetrics` pushes for the running-specific value; since those events are sporadic, state could stay stale for weeks when Garmin Connect had updated. Response JSON gains `physiologyDays` count.
- **Webhook backfill request added.** `/userMetrics` requires a partner Consumer Pull Token (CPT); when the CPT in Supabase secrets is missing or invalid, the pull silently returns zero rows. `garmin-backfill` now also fires `POST /wellness-api/rest/backfill/userMetrics?summaryStartTimeInSeconds=…&summaryEndTimeInSeconds=…` (with `Content-Length: 0` — Garmin rejects the POST as 411 without it) at the end of each run. This asks Garmin to deliver historic userMetrics through the normal webhook path, which `handleUserMetrics` in `garmin-webhook/index.ts` already writes to `physiology_snapshots`. Fallback runs even without a CPT, so the Running VO2 Max pipeline is self-healing as long as the webhook subscription in the Garmin Developer Portal is enabled. Response JSON gains `userMetricsBackfillStatus` (HTTP status returned by Garmin).
- **VO2 priority flipped** in both `supabase/functions/sync-physiology-snapshot/index.ts` (merge step) and `src/data/physiologySync.ts` (client hydration). `physiology_snapshots.vo2_max_running` (running-specific, from `userMetrics`) now wins over `daily_metrics.vo2max` (generic dailies value that can include cycling/cardio estimates and diverges from what Garmin Connect shows under "Running VO2 Max"). Previously the generic value took precedence, so a correct `vo2_max_running` row could be masked by a stale cross-sport dailies value. `s.vo2`, `s.lt`, and `s.ltHR` all hydrate from this fixed chain.

## 2026-04-16 — Sleep debt chart aligned to headline value

- **Sleep page cumulative debt chart no longer contradicts its own headline.** `src/calculations/sleep-insights.ts` now exports `computeSleepDebtSeries()` — the per-night trajectory of the same exponential-decay recurrence (`debt = debt × 0.9057 + max(0, target − actual)`) used by `computeSleepDebt()`. The latter now delegates to the series (returning the last element), so headline and chart share one source of truth.
- **`src/ui/sleep-view.ts`** — Replaced the naive "sum of (actual − target) over last 7 nights" chart data with `computeSleepDebtSeries(...).slice(-7)` plotted as `−debt`. The chart's last point now equals the headline value exactly. Surpluses no longer cancel debt 1-for-1 (matches Rupp 2009 / Arnal 2015 evidence that recovery sleep is less efficient than arithmetic implies). Chart will drift up toward the target line with good nights, not snap back to it.
- **Debt chart Y-axis anchored at 0.** Added optional `anchorZeroAtTop` to `buildSleepBankLineChart` so the target line sits at the top of the chart and the line below reads as magnitude-of-deficit (previously the auto-scaled axis compressed the range and under-sold the depth).
- **Gradient fill + hour reference guides.** `buildSleepBankLineChart` gained two more options: `fillToTargetGradient` (vertical red gradient from target down to the line, 0.05 → 0.28 alpha — deeper = darker, without becoming garish) and `hourReferenceLines` (faint dashed guides at −1h, −2h, −3h, −4h, then every 2h beyond, each labelled on the right). `parseColorToRgb()` helper handles hex/rgb inputs for the gradient stops.
- **Severity tier label on the headline.** New `classifySleepDebt()` maps the debt value to `mild` / `moderate` / `high` / `severe` (bands calibrated to steady-state nightly shortfall — see SCIENCE_LOG). Rendered as a small muted grey suffix next to "4h 14m debt" so the user can read the severity at a glance without parsing the number.

## 2026-04-17 — Sleep debt: graduated colour + softer low-end framing

- **`classifySleepDebt()` reworked to return `{ label, color, showNumber }`.** Previously returned `string | null` with the low end just hidden. Now returns a full tier object so the headline, chart line, and gradient fill can all graduate through the same colour.
- **Revised bands and copy.** Low states are reassuring, not silent: `< 45m` → `On track` (emerald, no number), `45m – 1h 30m` → `caught up` (slate), then `mild` (amber) / `moderate` (orange) / `high` (red) / `severe` (red-600). Removes the "always failing" feel the red-on-any-debt binary produced. See `docs/SCIENCE_LOG.md` for the full table and the literature support for the progression vs the pragmatic cutoffs.
- **`src/ui/sleep-view.ts`** — Headline now reads `{value} · {tier}` when debt ≥ 45m and just the tier label when below that. Chart line colour + gradient fill both use `debtTier.color`, so a `mild` deficit paints the chart amber, not red.
- **Sleep score bar chart colours by quality.** `scoreTrendChart` now uses the same `scoreColor(score)` helper as the hero ring — ≥ 75 green, 55–74 purple, < 55 orange — so the 7-night view reads as three tiers at a glance instead of uniform purple.

## 2026-04-16 — iOS platform bootstrap (ISSUE-134)

- **App renamed to Mosaic.** Bundle id `com.mosaic.training`, display name `Mosaic`. Updated `capacitor.config.ts`, the baked `ios/App/App/capacitor.config.json`, `Info.plist` `CFBundleDisplayName`, the location usage strings, and `PRODUCT_BUNDLE_IDENTIFIER` in both Debug and Release configs of `App.xcodeproj/project.pbxproj`.
- **Haptics routed through `@capacitor/haptics` on native.** `src/guided/haptics.ts` now selects its default adapter at runtime: native (Taptic Engine via `Haptics.impact`) when `Capacitor.isNativePlatform()`, navigator.vibrate in browsers. Patterns are emulated by chaining `impact` calls on setTimeout — short ticks map to `ImpactStyle.Light`, longer pulses to `.Medium`. The injectable `HapticAdapter` interface is preserved so controller tests are unaffected.
- **Info.plist: motion + audio background.** Added `NSMotionUsageDescription` ("Mosaic uses motion data to detect steps and cadence while you run.") and added `audio` to `UIBackgroundModes` so the `GuidedVoice` plugin can speak with the screen locked.
- **GuidedVoice plugin packaged locally.** Moved the Swift source from `ios/App/CapApp-SPM/Sources/CapApp-SPM/` to a standalone local npm package at `ios-plugins/guided-voice/` (with its own `Package.swift`). `npm install file:./ios-plugins/guided-voice` registers it so `npx cap sync ios` auto-detects the plugin (`packageClassList` now includes `GuidedVoicePlugin`). Keeping the plugin inline to the app would have been silently stripped on every sync.
- **Screen keep-awake adapter.** `src/guided/keep-awake.ts` — thin wrapper over `@capacitor-community/keep-awake` with a browser `navigator.wakeLock` fallback. Not yet wired into the Record tab; ISSUE-135 owns that call site.
- **BackgroundGeolocation config helper.** `src/guided/background-location.ts` — exports `GUIDED_RUN_LOCATION_CONFIG` (the recommended `@transistorsoft/capacitor-background-geolocation` options for guided runs: `preventSuspend: true`, `locationAuthorizationRequest: 'Always'`, `foregroundService: true`, and the "Guided run in progress" notification). No call site yet — attaches to the tracker bootstrap when that lands.

## 2026-04-16 — Guided runs: music ducking + parser/wake-lock fragilities

- **Music ducking lands natively (ISSUE-136).** `GuidedVoicePlugin.swift` wraps AVSpeechSynthesizer and activates `AVAudioSession(.playback, .voicePrompt, [.duckOthers, .mixWithOthers])` around every utterance, deactivating with `.notifyOthersOnDeactivation` on finish / cancel. Spotify and Apple Music dip while the voice speaks and restore after. JS side already routes through the native bridge when `Capacitor.isNativePlatform()`.
- **Wake-lock concurrent-acquire guard.** `src/utils/wake-lock.ts` tracks a `pending` promise during a `wakeLock.request('screen')` round-trip; a second `acquireWakeLock` call while the first is in flight awaits the same promise instead of issuing a duplicate request.
- **Progressive run role tag.** `Step.role: 'progressive-easy' | 'progressive-fast'` set by `buildTimeline` on the two halves of a progressive run (e.g. `"21km: last 5 @ HM"`). `buildSplitScheme` reads the role instead of sniffing step shape (length-2, easy→work). A future 3-step progressive will not silently fall back to generic per-km labels.
- **SplitScheme cleanups.** Adapter reads `step.repIdx` for recovery rep numbers (no more label-regex extraction) and uses a new `buildTimelineFromDesc(desc, paces)` helper instead of fabricating a `Workout` object. Recovery steps in `timeline.ts` now carry `repIdx` / `repTotal`.
- **Voice coach comment updated** — the stale "ducking not handled here" note removed; replaced with a brief summary of the native-vs-web split.

## 2026-04-16 — HR drift: heat correction + personal baseline

- **`supabase/migrations/20260416_ambient_temp.sql`** — New `garmin_activities.ambient_temp_c` column. Populated during drift computation via Open-Meteo historical weather (free, no API key). NULL when the activity has no `start_latlng` or the fetch fails.
- **`supabase/functions/sync-strava-activities/index.ts`** — `fetchAmbientTemp` helper hits Open-Meteo archive (≥ 6 days old) or forecast `past_days=7` (recent). Wired into all three drift compute sites; excludes `TREADMILL_RUNNING`. Stored alongside `hr_drift` on every upsert. Backfill heal pass refetches temp for cached running rows missing it (20-activity cap).
- **`src/types/state.ts`**, **`src/calculations/activity-matcher.ts`**, **`src/data/stravaSync.ts`** — `ambientTempC` propagated through the state pipeline.
- **`src/calculations/daily-coach.ts`** — Added `heatAdjust(drift, tempC)` using the literature-approximate `drift − 0.15 × max(0, tempC − 15)` correction. Added `computeDriftBaselines(s)` returning per-category (easy, long) 16-week rolling mean + SD of heat-adjusted drift (≥ 5 samples required). `detectDurabilityFlag` now heat-adjusts every sample and, when a personal baseline exists, triggers at `baseline.mean + 1·SD` instead of the population 5% / 8% thresholds. Body copy now states whether the flag is based on the athlete's own rolling baseline or the fallback population thresholds.
- **`src/calculations/workout-insight.ts`** — `Signals` now carries `ambientTempC` and `hrDriftAdjusted`. Drift commentary at lines 256–263 mentions heat-adjusted drift when `ambientTempC ≥ 22°C` and raw drift > 8% — prevents hot-day runs from reading as aerobic under-recovery in coach copy.
- **`docs/SCIENCE_LOG.md`** — Heat correction coefficient, cold-weather no-op rule, personal baseline window + sample thresholds documented.

## 2026-04-16 — HR drift feeds injury risk + durability chart empty state

- **`src/calculations/daily-coach.ts`** — Added `detectDurabilityFlag(s)` → `DurabilityFlag | null`. Scans last 4 weeks, only counts `plannedType === 'easy'` or `'long'` actuals (strict matching — intervals/tempo excluded because drift there is expected). Fires when easy runs average > 5% drift (≥ 3 samples) or long runs average > 8% drift (≥ 2 samples). Severity = `'high'` when avg drift exceeds expected by > 3 percentage points, else `'elevated'`.
- **`src/ui/injury-risk-view.ts`** — New "Durability Signal" card between the ACWR coaching block and Acute vs Chronic. Amber for elevated, red for high. Copy distinguishes easy-drift, long-drift, and both-elevated cases with specific remediation (ease off easy pace, slow long-run openers, fuel earlier).
- **`src/ui/stats-view.ts`** — Aerobic Durability chart empty state rewritten: now shows `N of 4` progress when partial, and explains the restriction (steady-state running only, intervals and cross-training excluded). Helps users with many activities but few easy/long runs understand why the chart is empty.
- **`docs/SCIENCE_LOG.md`** — Durability flag thresholds and scan window documented in the HR Drift section.

## 2026-04-16 — Rolling load: remove "Last 7 days" activity breakdown

- **`src/ui/rolling-load-view.ts`** — Dropped the per-activity list at the bottom of the rolling load page. The 28-day chart, 7-day zone bars, leg fatigue card, and 4-week zone balance remain. `buildActivityList` helper removed.

## 2026-04-15 — Guided runs: seven follow-ups hardened (ISSUE-133/138/139/140/141/142/143/144)

- **Skip / +30s stay in sync with the tracker (ISSUE-133).** `GpsTracker` now exposes `skipSegment()` and `extendSegment(sec)`. `GuideController.skipStep()` / `extendCurrentStep()` take an optional tracker adapter and advance both representations in lockstep; `gps-events.ts` wires the adapter from the rest overlay via dynamic import. Removes the silent drift between the engine's `Timeline` and the tracker's `SplitScheme` on any skip or extend.
- **Rest overlay no longer leaks across tabs (ISSUE-138).** The delegated tab-bar click handler unmounts the overlay on any non-Record tab. `record-view.ts` re-mounts it on re-entry if a `GuideController` is still active — the controller's `mountGuidedOverlay` short-circuit renders the overlay immediately when the current step is recovery.
- **Mid-run settings changes take effect live (ISSUE-139).** Account toggles for "Guided runs" and "Per-km splits" now forward to the active controller via `disableActiveGuide()` and `setActiveGuideSplitAnnouncements()`. Turning guided off mid-run stops the voice and removes the overlay; turning splits off silences per-km callouts without affecting step cues.
- **+30s capped at 2× original step duration (ISSUE-143).** Engine records `originalDurationSec` on first extend and clips subsequent extensions. `extendCurrentStep` returns the actual seconds applied so the tracker stays consistent when the cap binds. Overlay's +30s button is faded / `cursor:not-allowed` once remaining allowance < 30s.
- **Adherence tolerance per step kind (ISSUE-140).** `ADHERENCE_TOLERANCE_BY_KIND` — work ±4, warmup/cooldown ±10, other ±5 (recovery is already untimed). `classifyPace` takes a kind argument and `summariseAdherence` passes it through. Post-run retrospective no longer flags a 5 s/km drift on an easy warm-up as "off pace" while letting a 5 s/km miss on a rep slide.
- **Speech rate is now user-configurable (ISSUE-142).** `guidedVoiceRate` on state (0.8–1.4, default 1.0). Slider lives in Account → Preferences below the two guided toggles; changes are forwarded live to the active `VoiceCoach` via `GuideController.setVoiceRate` and clamped to the valid range.
- **Cue ring buffer for support diagnostics (ISSUE-144).** `GuideController` pushes every `CueEvent` into a 100-entry buffer annotated with run-elapsed time and step label. `stopTracking` attaches the buffer to the `GpsRecording` as the optional `cueLog` field. No UI surface — purely for reproducing voice-timing reports.
- **End-to-end integration test added (ISSUE-141).** `src/guided/integration.test.ts` drives a structured workout through both parsers (`buildTimeline` + `buildSplitScheme`) and asserts compatible work-rep counts, monotonic `stepStart` emission, `timelineComplete`, cue-log capture, and adherence classification under the new per-kind bands. Caught a silent `buildSplitScheme` parse miss on "60s recovery" — reinforces ISSUE-137 (single parser).
- Guided test count: 58 → 64.

## 2026-04-15 — Leg fatigue surfaced as readiness signal: detail page + hard floor + soft taper

- **Leg fatigue now caps readiness directly.** Previously the decayed `legLoadTotal` only produced a text note (`legLoadNote`) shown inside the Home Injury Risk popover; the readiness score itself ignored it. Cross-training that crushed the legs but barely moved TSS (a long hike, heavy ski day) read as Primed because HRV and TSB were untouched. New hard floors in `src/calculations/readiness.ts`: `legLoadTotal >= 60` caps at 34 (Ease Back), `>= 20` caps at 54 (Manage Load). Between 10 and 20 a soft linear taper runs (cap 100 → 54) so crossing the MODERATE threshold isn't a cliff. Same threshold-floor pattern as ACWR/sleep/strain; calibrated against EIMD research (Clarkson & Hubal 2002; Paulsen 2012) — non-linear risk curve, silent below light, step-change above heavy. Rationale and citations in `docs/SCIENCE_LOG.md`.
- **`legLoadTotal` exposed on `ReadinessResult`** alongside the existing `legLoadNote`. New `hardFloor: 'legLoad'` value when the leg-fatigue floor is the binding constraint. `DrivingSignal` gets a `'legLoad'` member so Home and `daily-coach.ts` surface a leg-fatigue-specific prompt ("Protect the legs") when the floor is active, rather than pinning on a lower but non-binding sub-score.
- **Floor precedence**: the leg-load branches guard with `score > cap`, so a stricter prior floor (ACWR, sleep, strain) is never overwritten. Only fires when it is the strictest constraint.
- **New Leg Fatigue detail page** (`src/ui/leg-load-view.ts`). Modelled on the other readiness detail pages with a new `bronze` sky palette in `src/ui/sky-background.ts`. Hero ring uses a piecewise mapping so MODERATE (20) sits at ~30%, HEAVY (60) at ~70%, extreme (120+) fills the ring — prevents "90 looks like 60". Shows: 7-day decay timeline with threshold zones, "floor releases" + "fully fresh" projections, per-session contributors with raw/decayed split and reload penalty, and an explainer of the EIMD model. Uses the new exported `computeLegLoadBreakdown()` helper which returns per-entry decay including `halfLifeH` and `reloads`.
- **Card home is Rolling Load, not Readiness.** Leg fatigue is load (mechanical channel), so the permanent card lives at the top of `src/ui/rolling-load-view.ts`, always visible. Readiness shows only a compact callout banner under the ring when `hardFloor === 'legLoad'` ("Leg fatigue is capping your readiness. View →") that links to the detail page.
- **Timestamp bug fixed**: `recordLegLoad` in `src/ui/activity-review.ts` now records the most-recent underlying activity's actual `startTime` instead of `Date.now()`. Previously a backfilled activity from days ago would have its decay clock reset to now, underestimating clearance time.
- `LEG_LOAD_MODERATE` and `LEG_LOAD_HEAVY` are exported from `readiness.ts` so the detail page and rolling-load card draw threshold lines from the same constants the floor uses.

## 2026-04-16 — Guided runs: single parser for workout descriptions (ISSUE-137)

- **`buildSplitScheme` now derives from `buildTimeline`.** The two parsers ran independently against `workout.d` and silently diverged: an integration test caught `"3×3min @ threshold, 60s recovery"` producing a valid timeline but zero split-scheme segments. The split scheme is now a thin adapter that walks the `Timeline` steps and maps each one to a `SplitSegment`: rep work → single paced segment, recovery → untimed segment with `durationSeconds` (plus an easy-pace jog-distance fallback to preserve the tracker's distance-advance path), warm-up/cool-down → single paced segment at easy pace, single-block distance/time work (`20km @ MP`, `8km`, `20min @ threshold`) → per-km splits at the target pace, progressive 2-step (`21km: last 5 @ HM`) → per-km easy + per-km "Fast km N of M". Adding a new workout format now only requires extending `parseMainSet` in `timeline.ts`.
- **Timeline widened to close audit gaps** so `buildSplitScheme` can delegate without losing formats: literal paces like `"4:49/km"` in interval-time and distance-at-pace expressions, optional `(~790m)` / `(~3.2km)` parentheticals after zone tokens, and `{N}km <descriptor>` forms like `"5km warmup jog"` / `"8km easy"` now parse. All 15 existing timeline tests still pass unchanged.
- **Anti-regression test in `src/guided/integration.test.ts`.** Iterates every split-scheme test input and asserts the timeline is non-empty, `isStructured === true` for structured workouts, and that every paced segment's `targetPace` traces back to a timeline step's `targetPaceSec`. Prevents the two views drifting apart again.
- **All 128 tests in `src/gps/` + `src/guided/` pass.** No `SplitScheme` / `SplitSegment` type changes — downstream consumers (`gps-events.ts`, `record-view.ts`, `tracker.ts`) are untouched.

## 2026-04-16 — Screen Wake Lock during guided runs (ISSUE-135 interim)

- **`src/utils/wake-lock.ts`** — new module wrapping the Screen Wake Lock API. `acquireWakeLock()` requests a `'screen'` sentinel; `releaseWakeLock()` releases and clears it. A single `visibilitychange` listener re-acquires the lock when the document returns to visible (browsers release on tab-hide). `isWakeLockSupported()` reports API availability. All failures swallowed with `console.warn`; never throws to the caller. 11 unit tests in `src/utils/wake-lock.test.ts` cover acquire, release, double-acquire idempotency, re-acquire on visibility, unsupported-browser no-op, request and release error swallowing.
- **Lifecycle wired in `src/ui/gps-events.ts`.** `startTracking` acquires the lock only when a `GuideController` is created (guided mode active) and `s.guidedKeepScreenOn !== false`. `stopTracking` releases it in both the saved-recording and the discarded-short-recording branches. `disableActiveGuide()` also releases it so turning guided off mid-run drops the lock immediately.
- **Account → Preferences toggle.** New "Keep screen on" segmented pill below the voice-rate slider, modelled on the existing split-announcements toggle. Sub-label: "Prevents the screen locking mid-run so voice cues stay active. Uses more battery." On unsupported browsers the buttons render disabled with a "Not supported on this browser" sub-label. Toggle handler forwards live to an active guided run: turning on acquires immediately if a controller is running; turning off releases immediately.
- **State field** `guidedKeepScreenOn?: boolean` added to `src/types/state.ts` next to the other guided-run preferences. Default treated as ON; only `=== false` opts out.
- **Scope**: web interim. A future Capacitor migration will swap this for `@capacitor-community/keep-awake` in the iOS/Android shells.

## 2026-04-16 — "Why this prediction?" modal + refresh polish

- **New `src/ui/prediction-breakdown.ts` — tappable explanation modal** wired to every race-time prediction surface. Shows the distance + time, a goal delta in race mode (forecast faster / on pace / slower, with minutes), the inputs that fed the blend in plain language (runs counted, PBs, LT pace, VO2, weekly volume), a confidence tier with a "what would raise it" note, a taper note when `ph === 'taper'` (explains the held prediction per Mujika & Padilla), and an "Add a quality session" CTA that mirrors the goal-feasibility lever. No Tanda math, no percentages, no formulas — consultant tone per CLAUDE.md UI Copy rules.
- **Tap targets wired.** Stats Race Estimates rows (each distance, `src/ui/stats-view.ts`) show a `›` chevron and pass the explicit distance + blended time. Home "Current" and "Forecast" tiles (`src/ui/main-view.ts`, handlers in `src/ui/home-view.ts`) pass `framing: 'today'` vs `framing: 'forecast'` so the sub-headline matches what the user tapped (the inline-onclick tooltip hack on "Current" is gone). Onboarding `plan-preview.ts` adds a "Why this time ›" link under the predicted finish.
- **Modal polish.** Vertically centered per `docs/UX_PATTERNS.md → Overlays and Modals`, backdrop `rgba(0,0,0,0.45)`, neutral palette, no accent colour on secondary link, close button in `var(--c-faint)`. Gracefully handles missing predictions and stale data (`isStale === true` surfaces as "Limited — recent data is stale").
- **`refreshBlendedFitness` appends a deduped entry to `s.vdotHistory`** so the sparkline tracks the weekly blended refresh. The earlier attempt to also write `s.currentFitness` was reverted: `renderer.ts` writes `tv(getEffectiveVdot(s), dist)` on every render, and since `s.v` now holds the blended VDOT, that live value already reflects the blend plus any fresh `rpeAdj`/`physioAdj`. Writing in two places only introduced thrash.
- **Refresh order in `next()` swapped.** `refreshBlendedFitness` now runs *before* `applyAutoLTUpdate` so physioAdj is calibrated against the fresh `s.v` rather than last week's stale baseline. Prevents a one-week residual after each auto-LT update.
- **Goal-feasibility CTA bumps both `rw` and `epw`.** Previously only `epw` — but `computeRenderedWorkouts` reads `s.rw` for session count, so the plan wouldn't visually update. Now matches the onboarding milestone-accept lever.
- **Goal-feasibility banner suppressed during taper.** When `currentWeek.ph === 'taper'` the "Add a session" CTA would be useless with 2-3 low-volume weeks left.
- **Modal goal block suppressed during taper** when direction is 'slower'. The `taperNote` already explains the held forecast; the delta copy ("X min slower than goal") would contradict it directly below. 'match' and 'faster' variants remain accurate and are kept.

## 2026-04-16 — Kill wkGain trajectory; s.v tracks live blended VDOT; goal-feasibility nudge

- **wkGain accumulator removed from all 13 fitness read-sites.** `s.v` was always seeded at onboarding and never changed; the weekly climb was synthesised by summing `wkGain` per week (a linear projection toward `s.expectedFinal`). That climb ignored reality — if the runner was fitter or slower than the straight line predicted, the pre-drawn trajectory won anyway. Replaced by writing the blended race-prediction VDOT back into `s.v` on every weekly refresh (`refreshBlendedFitness` in `src/calculations/blended-fitness.ts`). Effective VDOT for paces, forecasts, and matcher is now `s.v + rpeAdj + physioAdj` via a single helper `getEffectiveVdot(s)` (`src/calculations/effective-vdot.ts`). Sites updated: `stats-view`, `main-view`, `renderer`, `activity-matcher`, `events.ts` (8 sites including `recordVdotHistory`, `applyAutoLTUpdate`, `complete`, physio calibration × 3). `wk.wkGain` remains on week state for cosmetic display only.
- **Taper/deload freeze.** During any week where `ph === 'taper'` (covers race taper and continuous-mode deload), `s.v` is not rewritten. Volume is deliberately cut in those weeks; recomputing the blend would read the cut as detraining and slow the prediction, contradicting Mujika & Padilla (2000) — fitness is maintained across a 2-to-3 week taper. Reference: science entry in `docs/SCIENCE_LOG.md`.
- **`s.expectedFinal` now recomputed weekly.** Previously frozen at onboarding. `refreshBlendedFitness` now re-runs `calculateLiveForecast` with the fresh `s.v` and remaining weeks, so the end-of-plan projection tracks actual training response. `s.forecastTime` updated alongside.
- **Boot-time migration in `src/main.ts`.** On launch after `advanceWeekToToday`, dynamically imports and calls `refreshBlendedFitness(s)` so existing users see current fitness on first load, not the Week-1 baseline left behind by the dropped `wkGain` model.
- **Goal-feasibility banner on plan view.** When `forecastTime − initialBaseline > 20 min` in race mode, a banner surfaces the gap in plain language ("Forecast finish 3:28 is 16 min slower than your goal of 3:12") and offers an "Add a quality session" CTA that bumps `s.epw` by 1 (capped at 7) and triggers a fresh blended refresh. 20-min threshold is pragmatic: smaller deltas sit inside race-day variance (weather, fuelling, pacing). Implemented as `buildGoalFeasibilityBanner` in `src/ui/plan-view.ts`.

## 2026-04-16 — Readiness score consistency across all surfaces

- **Home and Readiness pages now show the same score.** Home ring used the week-end TSB snapshot from `computeSameSignalTSB`, while Readiness applied intra-week daily decay through today. After a sync that added load to the current week the two diverged (e.g. 57 on Home vs 62 on Readiness).
- New shared helper `computeLiveSameSignalTSB()` in `src/calculations/fitness-model.ts` seeds from the completed-week snapshot then applies daily ATL/CTL decay using `computeTodaySignalBTSS()` for each elapsed day. Used by `home-view.ts`, `readiness-view.ts`, `freshness-view.ts`, and `daily-coach.ts` — replaces the inline decay loops that were copy-pasted across all four.
- New `computeReadinessACWR(s)` centralises the canonical ACWR call (tier override, atlSeed derivation, signalBBaseline). Same three views + daily-coach use it — one source of truth for any future arg change.
- Readiness detail page now uses the live `liveTSB.ctl` (not the stale week-end snapshot) for the To-Baseline CTL reference, keeping recovery-hours math consistent with the readiness score.

## 2026-04-16 — Distinct sky palettes per readiness sub-page

- Readiness, Freshness and Recovery (Physiology) all shared the same `blue` sky background, so tapping between cards felt visually identical. Each sub-page now has its own shade so the reader can tell them apart.
- Added `mint`, `lavender`, `amber` palettes to `src/ui/sky-background.ts` (kept existing entries for backwards compat). Mapping: Freshness → mint, Recovery → lavender, Injury Risk (Load Ratio) → amber. Readiness keeps blue as the hub.
- **Ring/dial colours now match the page tint** on pages where the metric has no genuine "good/bad" axis. Rolling Load ring + ratio pill use deep-blue when in the normal range (was green), only flipping to red on overload. Sleep view ring uses purple across the whole non-poor range (was green ≥75 / purple 55–74), only flipping to amber when score <55. Pages where colour carries information (Freshness TSB zones, Strain, Physiology composite) are unchanged.

## 2026-04-16 — Home sleep ring: today-only, refresh prompt when missing

- Home sleep ring no longer falls back to the most-recent sleep entry when today's Garmin sleep score is missing. Previously `src/ui/home-view.ts` used a `latestWithSleep` fallback that surfaced e.g. yesterday's 80 as today's ring value, which misattributed the score to the wrong day.
- When watch is connected and today's score is absent, the ring now shows `—` with `Sync watch` subtext. Tapping the ring triggers `refreshRecentSleepScores()` + `syncPhysiologySnapshot(7)` (the same 1-week refresh used on launch), then re-renders home. Older entries remain in `physiologyHistory` attached to their own date — they just aren't displayed as today's value.
- Sleep duration caption on the ring is also today-only (was sourced from the same stale fallback).

## 2026-04-16 — Readiness score consistency

- **Home and Readiness pages now show the same score.** Previously the home ring used the week-end TSB snapshot from `computeSameSignalTSB`, while the Readiness detail page applied intra-week daily decay through today. After a sync that added load to the current week, the two diverged (e.g. 57 on Home vs 62 on Readiness).
- New shared helper `computeLiveSameSignalTSB()` in `src/calculations/fitness-model.ts` seeds from the completed-week snapshot then applies daily ATL/CTL decay using `computeTodaySignalBTSS()` for each elapsed day. Both `home-view.ts` and `readiness-view.ts` now call it for the TSB input to `computeReadiness()`.

## 2026-04-15 — HR drift: four new surfaces (durability graph, fade risk, easy-pace commentary, pre-long-run nudge)

- **Pre-long-run nudge** (`src/calculations/daily-coach.ts`, rendered in `src/ui/readiness-view.ts`). New `computeLongRunDriftNote()` scans last 6 weeks of `plannedType === 'long'` actuals. Fires when ≥2 of the last 3 have drift >8%. Adds a pre-session line under the coach message suggesting earlier fuelling and pace control. New `sessionNote: string | null` field on `CoachState`.
- **Easy-pace commentary** (`detectEasyDriftPattern()` in `daily-coach.ts`, rendered in `src/ui/week-debrief.ts`). Scans last 3 weeks for `plannedType === 'easy'` actuals; fires when ≥3 samples and mean drift >5%. Appears as a second paragraph in the week debrief coach narrative card. Signal: easy pace may be sitting too close to aerobic threshold.
- **Aerobic Durability chart** (`buildDurabilityChart()` in `src/ui/stats-view.ts`). New card in Stats → Progress detail page below the CTL chart. Shows per-session drift points (colour-coded by zone) with a 4-session rolling mean overlay. Last 12 weeks, easy + long runs only (quality sessions excluded — drift there carries no durability signal). Reference bands at 5% and 8%. Header shows current mean and trend direction.
- **Marathon fade-risk badge** (`computeMarathonFadeRisk()` in `stats-view.ts`). New pill on the Marathon row in the Race Estimates card. Computes mean drift of long runs (≥90 min) in last 4 weeks whose pace falls within ±15 sec/km of the forecast MP. Badge reads `Fade risk: Low/Moderate/High` (>5% = mod, >8% = high). Doesn't modify the predicted time — additive context only.

## 2026-04-15 — Guided runs: pace adherence summary (step 8 of 8 complete)

- New `src/guided/adherence.ts` with pure `summariseAdherence(splits)` — classifies every paced split as on-pace / fast / slow (±5 sec/km tolerance, matching live coaching) and returns aggregate counts, signed mean deviation, and hit-rate fraction.
- New compact "Pace adherence" card rendered in the post-run completion modal and the recording-detail view (`src/ui/gps-completion-modal.ts`): "N of M splits on pace — X%", plus a sub-line showing fast/slow counts and average deviation in seconds. Neutral styling, no colour, no emoji.
- 8 adherence tests + 58 guided tests total passing. Typecheck clean.
- Steps 6 (Android foreground notification) and 7 (iOS Live Activity) parked in OPEN_ISSUES as FUTURE-03. The guided-runs arc (timeline → engine → voice/haptics → overlay → adherence) is complete end-to-end.

## 2026-04-15 — Guided runs: settings toggles + rest overlay (step 5 of 8 complete)

- **Settings** (`src/ui/account-view.ts`, Preferences group): two new rows, each using the same segmented km/mi toggle pattern. "Guided runs" (Off / On, default Off) controls `s.guidedRunsEnabled`. "Per-km splits" (Off / On, default On) controls `s.guidedSplitAnnouncements` — runners turn off when Strava or Garmin already announces splits.
- **Rest overlay** (`src/ui/guided-overlay.ts`): vertically centred card using the canonical overlay pattern (`fixed inset-0 z-50 flex items-center justify-center`, `rgba(0,0,0,0.45)` backdrop, `max-w-sm`, `p-5`). During recovery steps, shows "Recover" label, big countdown (72px tabular-nums), the step label, a `Next: {label · duration · pace}` preview of the upcoming work rep, and two bordered buttons: `+30s` (calls `extendCurrentStep(30)`) and `Skip rest` (calls `skipStep()`). Neutral styling only, no accent colour.
- Wired into `startTracking()` / `stopTracking()` in `gps-events.ts`: overlay mounts when the guide is instantiated, updates countdown from `getProgress(data)` on every tracker tick, and unmounts on stop or `timelineComplete`.
- 114 tests pass (50 guided + 64 others touched); typecheck clean.

---

## 2026-04-15 — Guided runs: controller + tracker wiring (step 5 of 8, partial)

- New `src/guided/controller.ts` — `GuideController` facade composing `GuideEngine` + `VoiceCoach` + `HapticsCoach`. Single constructor takes a `Workout` + `Paces`; exposes `start()` / `update(data)` / `skipStep()` / `extendCurrentStep(sec)` / `destroy()`, and `onCue()` for UI overlay subscriptions.
- Wired into `startTracking()` in `src/ui/gps-events.ts`: when `s.guidedRunsEnabled` is true and the workout is structured, a `GuideController` is instantiated and gets `update(data)` on every tracker tick. `stopTracking()` calls `destroy()` to cancel speech and detach listeners.
- New state fields: `s.guidedRunsEnabled` (master toggle, default off) and `s.guidedSplitAnnouncements` (per-km voice, default on; users turn off if Strava/Garmin is already speaking).
- New `getActiveGuideController()` export for future overlay UI.
- 3 controller tests + 50 guided tests total passing. Typecheck clean.
- **Deferred to next slice**: settings toggle UI, rest-overlay with "next up" preview, skip/+30s controls on recovery screen.

---

## 2026-04-15 — Guided runs: voice + haptic coaches (step 4 of 8)

- New `src/guided/voice.ts` with a pure `composePhrase(event, opts)` text function plus a `VoiceCoach` class using the Web Speech API. Phrase rules: `Go. {label}. {duration} at {pace} per kilometre.` on work start, `Recover. {N} seconds easy.` on recovery, `Thirty seconds. Next up: …` at T-30s. Per-km splits: `Kilometre X. Y:ZZ. On pace.` / `… N seconds fast. Ease this one.` / `… N seconds behind target.` (neutral tone for slow). Easy-step splits stay silent unless the runner is too fast. Mid-rep `paceCheck` speaks `Ease back.` / `Pick it up.` on short intervals.
- `splitAnnouncements` setting toggle lets users mute per-km voice when Strava/Garmin is already announcing.
- New `src/guided/haptics.ts` with pluggable `HapticAdapter` (navigator.vibrate default; Capacitor haptics adapter to be swapped in on iOS). Patterns: double buzz on work start, triple on step end, single tick per silent countdown second, long final buzz on completion.
- 14 voice tests + 47 total guided tests pass. Types clean.

---

## 2026-04-15 — Guided runs: GuideEngine (step 3 of 8)

- New `src/guided/engine.ts` drives a `Timeline` forward from tracker updates. Emits cue events (`stepStart`, `stepHalfway`, `stepNextPreview`, `stepCountdown`, `stepEnd`, `timelineComplete`) the voice/haptic/UI layers subscribe to.
- Naturally follows tracker pause (manual or auto) because `GpsLiveData.elapsed` and `totalDistance` are frozen during pause — no extra wiring needed.
- Recovery steps emit a `stepNextPreview` at T-30s so the voice coach can announce the upcoming rep. Duration-based steps emit a silent 5-4-3-2-1 countdown for haptic cues.
- Manual controls: `skipStep()` and `extendCurrentStep(sec)` for UI skip/"+30s rest" buttons.
- 10 vitest cases: 45 total guided+tracker tests passing.

---

## 2026-04-15 — Guided runs: tracker auto-pause (step 2 of 8)

- `GpsTracker` gains speed-based auto-pause: stop after 5s of mean speed <0.5 m/s, resume after 3s of mean speed >1.5 m/s. Thresholds are named constants at the top of `src/gps/tracker.ts`.
- New events `onAutoPause` / `onAutoResume` and `isAutoPaused()` query method. `setAutoPauseEnabled(boolean)` toggles at runtime; disabling while auto-paused triggers immediate resume.
- Manual pause clears the auto flag — a manually paused session requires a manual resume.
- 6 new vitest cases: 30/30 tracker tests pass.

---

## 2026-04-15 — Guided runs: timeline builder (step 1 of 8)

- New `src/guided/timeline.ts` converts a planned `Workout` into an ordered `Step[]` (warmup, work, recovery, cooldown), drawing pace targets from existing VDOT-derived `Paces` via `getPaceForZone`. No invented constants — every pace comes from the existing pace table.
- Handles: simple distance, long runs, time intervals (min/s rest), distance intervals in m/mi/km, long km intervals, progressive fast-finish, distance/time at zone, explicit M:SS/km pace, mixed paces, and multi-line warmup/cooldown wrappers.
- 15 vitest cases covering each format. First step of the guided-runs build (`docs/GUIDED_RUNS_PLAN.md`).

---

## 2026-04-15 — "Running Fitness" → "Running Load" rename

- CTL bar renamed across UI. The old label conflated training load (what CTL measures) with aerobic capability (what VO2/LT measure), which misread low-km weeks for a fit runner as "Foundation fitness". New label matches what the number is: a rolling average of run-equivalent training load.
- Sites updated: `stats-view.ts` (bar title, drill-down header, info texts, explainer copy, historic chart title), `main-view.ts` (legacy help card), `home-view.ts` (momentum title + subtitle), `coach-insight.ts` (pill label), `week-debrief.ts` (debrief row label).
- Wizard copy referring to "running fitness" as a general VDOT/aerobic concept was left untouched — only CTL-specific references renamed.

---

## 2026-04-15 — Fitness card sparkline: remove end dot

- Removed the trailing endpoint circle from the Fitness card mini sparklines (`buildMiniVO2Sparkline`, `buildMiniVdotSparkline` in `src/ui/stats-view.ts`). Line + area fill only.

---

## 2026-04-15 — Strain view: Garmin sync hint on empty today

- When viewing today's Strain and no step data exists yet, the steps card now reads "Garmin hasn't pushed today's data yet. Refresh the Garmin Connect app to sync." instead of the generic "No step data for this day". Past days keep the original copy.

---

## 2026-04-15 — Strava history trim + athlete tier recompute (bug fixes)

- **`historicWeeklyRawTSS` not trimmed in backfill path**: `backfillStravaHistory` sliced `historicWeeklyTSS/Km/Zones` to the last 8 weeks but never trimmed `historicWeeklyRawTSS`, leaving it at 15+ entries. Consumers indexing both arrays by week were reading mismatched data. Fixed in `src/data/stravaSync.ts` — all four `historicWeekly*` arrays now sliced from the same `last8` array.
- **`athleteTier` went stale**: tier was only recomputed inside `fetchStravaHistory`, which is cache-skipped on most launches. Users whose `ctlBaseline` had been corrected (e.g. post-222 Elite bug) kept the old tier indefinitely. Extracted `deriveAthleteTier(ctlBaseline)` helper in `stravaSync.ts`; launch-time migration in `main.ts` now recomputes on every launch from the current `ctlBaseline`.

---

## 2026-04-15 — Readiness drill-down back buttons return to Readiness

- Strain and Recovery (Physiology) detail pages now honour the opener when opened from Readiness. Previously their back buttons always returned Home regardless of entry point, while Freshness/Load Ratio/Rolling Load/Sleep History already routed back to Readiness.
- `renderStrainView` and `renderRecoveryView` gained an optional `onBack` parameter (stored in a module-local latch so date-pill re-renders preserve it). Readiness card taps pass `() => renderReadinessView()`; Home ring taps pass `() => renderHomeView()`.

---

## 2026-04-15 — Today's Strain TSS unified across Home/Readiness/Strain

- **Root cause**: three different strain-TSS computations. Home passed `todayPhysio` to `computeTodaySignalBTSS` (logged + active-minute passive). Readiness passed nothing (logged only, matched by coincidence). Strain added `passiveExcess` from steps on top. Same day rendered 79 on Home/Readiness and 98 on Strain.
- **Fix**: added `computeTodayStrainTSS(wk, date, physioEntry, tssPerActiveMinute)` in `src/calculations/fitness-model.ts` as the single source of truth. Wraps `computeTodaySignalBTSS` (logged + minute-based passive) and adds the step-based passive excess when step-derived TSS exceeds minute-derived TSS. All three views now call it.
- **Sites updated**: `home-view.ts:758`, `readiness-view.ts:153` (now reads `todayPhysio` locally), `strain-view.ts:189–216` (replaced inline math with the helper; kept `passiveExcess` for the "passive TSS from background activity" caption).

---

## 2026-04-15 — Tanda marathon predictor

- **Added Tanda (2011) predictor for marathon**: new `predictFromVolume()` uses the formula `T = 11.03 + 98.46×exp(−0.0053×K) + 0.387×P` where K = 8-week mean weekly running km and P = km-weighted mean training pace. Validated on 46 marathoners (r=0.91, SEE ~3 min) — the only outcome-calibrated predictor in the blend. Marathon only; returns null for other distances or when K ∈ [4,120] and P ∈ [180,480] sec/km guard fails.
- **Reverted the heuristic volume bumps** on `predictFromLT` (marathon tier multiplier) and `predictFromRecent` (pace penalty) added earlier today. They were theory-motivated but empirically unvalidated; Tanda replaces both with a single research-backed mechanism.
- **Marathon blend weights**: with recent run: `recent 0.20, pb 0.05, lt 0.35, vo2 0.10, tanda 0.30`. Without recent: `pb 0.10, lt 0.45, vo2 0.15, tanda 0.30`. If Tanda unavailable, its weight redistributes onto LT.
- **`lowVolumeDiscount` now skips marathon** — Tanda handles volume-sensitivity directly, so applying the LT/VO2 weight discount as well would double-penalise. Still applies to HM/10K/5K where Tanda has no coverage.
- **Source-agnostic `computePredictionInputs()`** in `src/calculations/prediction-inputs.ts`: single pure function computing K (weekly km), P (mean training pace with race-outlier filter), recent-run, sample-size confidence, and staleness from any list of run activities. Used by both Stats view (garminActuals) and will back onboarding (Strava scraped history) — one code path, no drift.
- **Confidence gating**: Tanda only applied when `weeksCovered ≥ 4`, `paceConfidence ≥ medium` (≥4 runs across ≥3 weeks), and not stale (>28 days since last run). Below threshold, weight redistributes to LT. Prevents over-penalising a fit runner on a low-volume week and protects against the one-run-after-a-break edge case.
- **Dedup widened to 5-min buckets** to catch Strava/Garmin dual-logs where GPS-start and watch-start can differ by 1–2 minutes.
- **Science log**: full rationale, calibration details, limitations, and why Tanda is more externally valid than the heuristics it replaces — `docs/SCIENCE_LOG.md`.
- **Tests**: 19 new vitest cases across `prediction-inputs.test.ts` (10 — walk/sprint filter, 5-min dedup, race outlier, stale guard, confidence tiers, new-user window shrink) and `predict-from-volume.test.ts` (9 — Tanda paper reference points, input guards, 4 `blendPredictions` gating cases). All 42 prediction tests pass.

## 2026-04-15 — Blended fitness cache (onboarding + weekly refresh)

- **New `src/calculations/blended-fitness.ts`** (`refreshBlendedFitness()`): single entry point that collects `RunActivityInput[]` from `garminActuals` + `onboardingRunHistory`, runs `computePredictionInputs` → `blendPredictions` for `s.rd`, and caches `s.blendedRaceTimeSec` / `s.blendedEffectiveVdot` / `s.blendedLastRefreshedISO`. Consumers read O(1) — no re-blending on render.
- **Backfill edge function now returns per-run summary.** Added `runs` array to the backfill response (`startTime`, `distKm`, `durSec`, `activityType`, `activityName`) for all RUNNING activities. Client stashes to `s.onboardingRunHistory` and calls `refreshBlendedFitness` so the marathon prediction shown at the end of onboarding already incorporates Tanda — no need to wait a week for standalone sync to fill `garminActuals`.
- **Weekly rollover refresh.** `next()` in `src/ui/events.ts` now calls `refreshBlendedFitness` after auto-LT update. Blended prediction recomputes once per week advance; not on every render or activity sync.
- **Onboarding seeds the cache** with the wizard-only blend immediately (`initialization.ts`), then backfill upgrades it with Tanda inputs when per-run history lands.
- **New state fields** in `src/types/state.ts`: `blendedRaceTimeSec`, `blendedEffectiveVdot`, `blendedLastRefreshedISO`, `onboardingRunHistory`.
- **Not yet wired**: Step 6 — plan engine consuming `s.blendedEffectiveVdot` for pace derivation when it differs from `s.v`.

## 2026-04-15 — Readiness: "On Track" recoloured light blue

- `readinessColor()` in `src/calculations/readiness.ts` now returns a new `--c-info` token (light blue #7FB4E8) for `On Track` instead of `--c-ok-muted`. A 59 score sitting near the bottom of the 55–74 band was rendering in celebratory green, which overstated the signal. Primed stays green, Manage Load stays amber, Ease Back/Overreaching stays red. New token added to `src/styles.css` rather than reusing `--c-accent` (reserved for form-submission CTAs per CLAUDE.md).

---

## 2026-04-15 — Chart sizing: tablet/wide viewports no longer render oversized SVGs

- **Root cause**: several SVG charts used `viewBox` + `width:100%` with no explicit `height`. Browsers scale the SVG proportionally to the viewBox aspect ratio, so a 300×60 viewBox on a 900px-wide tablet card rendered ~180px tall. Affected the stats-view Fitness card sparkline (`buildMiniVO2Sparkline` / `buildMiniVdotSparkline`), the VO2 Max detail chart (`buildVO2LineChart`), and the recovery-view Detailed Metrics HRV/RHR charts.
- **Fix**: added explicit pixel `height` and `preserveAspectRatio="none"` on each SVG so they fill the card width but cap vertical size. Stroke paths use `vector-effect="non-scaling-stroke"` to stay crisp under horizontal stretch.
- **VO2 Max detail endpoint label**: the `<text>` showing the latest value (e.g. "51") lived inside the SVG and scaled with the viewBox, appearing huge on wide viewports. Removed — the big number above the chart is not redundant. Also moved the first/last date labels out of the SVG into an HTML row below.
- **VO2 Max chart — dots removed**: per-point `<circle>` markers became thin ellipses under `preserveAspectRatio="none"` and made the line look broken into segments. Dropped them. The chart now mirrors the recovery-view HRV/RHR detail style: smooth area + 2.5px rounded stroke with a linear-gradient fill, no markers.
- **Recovery tiles (HRV / Resting HR)**: killed the tiny 40px sparklines that conveyed little beyond the existing trend arrow and "+22% vs baseline" text. Replaced with a new `baselineRangeBar` — a slim horizontal pill showing the current value's position inside the 28-day min/max range, with a tick at the baseline average and min/avg/max labels below. More informative per vertical pixel.
- **Sleep Bank / Sleep Debt trend charts** (`buildSleepBankLineChart`): same unbounded-SVG issue, rendered ~300px tall on wide viewports. Capped at `height="100"` with `preserveAspectRatio="none"` + non-scaling strokes. Dropped the endpoint circle marker since it distorts into an ellipse when the SVG is stretched horizontally; the line naturally terminates at the latest point.
- **VO2 Max chart draw-on animation gap**: `animateChartDrawOn` sets `stroke-dasharray = path.getTotalLength()` for the draw-on effect, then transitions `stroke-dashoffset` to 0. With `vector-effect="non-scaling-stroke"`, dash-arrays are interpreted in screen pixels rather than user units — so a 320 user-unit dash ended partway across a ~900px wide chart, leaving a visible gap mid-line. Fixed by clearing `strokeDasharray`/`strokeDashoffset` on `transitionend` (with setTimeout fallback), so the final state is a solid line.

---

## 2026-04-15 — Plan drag-and-drop: localized rerender, no page flash

- Drag-and-drop reorder within a week no longer triggers a full `renderPlanView()` — which rebuilt the whole page including the header bars, weekly totals, and banners above the list, producing a visible flash.
- New `rerenderWeekListLocal(viewWeek)` replaces innerHTML of only the new `#plan-week-list` container and re-wires card-descendant handlers via `wireCardScopedHandlers(root, viewWeek)`. Same-week day reorders don't change weekly totals (TSS, km, counts), so the header stays correct without rebuilding.
- Extracted `computeRenderedWorkouts(s, viewWeek)` (mods + moves + illness + holiday + bridge pipeline) from `getPlanHTML` so full and localized renders share one source of truth.
- Scoped rewire binds to `root.querySelectorAll(...)` so `.plan-act-open` elements in the activity log (outside the list) keep their original listeners and aren't double-bound.

---

## 2026-04-15 — Strain ring: green dominant, red anchored at target; warm-red sky

- `strain-view.ts` ring scale changed from `ringMax = max(target.hi × 2, actual × 1.25)` to `max(target.hi × 1.1, actual × 1.08)`. With this, `target.hi` sits at ~91% of the ring when inside target (green dominates), and when exceeded the ring caps out around ~93% fill — a deliberate gap stays at the top.
- Rounded caps now rendered as explicit SVG `<circle>` overlays at the exact start/end positions, instead of `stroke-linecap="round"`. The round cap on the mask stroke was wrapping CCW past 12 o'clock (~5° angular overshoot), which read as a second green patch sitting to the left of the top gap. Mask now uses `stroke-linecap="butt"` and two small filled circles paint the caps in their correct colours.
- New `red` palette added to `sky-background.ts` (warm coral/red at the same saturation as the existing `teal` palette). Strain view switched from `teal` to `red` — effort page now reads warm instead of cool. Teal palette retained for backwards compat.

---

## 2026-04-15 — Excess-load modal: Reduce available on tempo weeks + recovery tier

- **Budget-cap bug (ISSUE-137)**: `suggester.ts` `buildReduceAdjustments` silently returned zero adjustments when the overshoot was small relative to the full run-replacement credit — `effectiveRRC` fell below the 5-load threshold and the loop short-circuited before any candidate was considered. Fixed by breaking only after at least one adjustment is proposed, and allowing the first quality downgrade's true `loadReduction` (controlled overshoot is preferable to silently hiding the Reduce option).
- **Modal copy (ISSUE-137)**: when no reductions or replacements are possible, the suggestion modal now shows an explanation banner ("remaining runs already at minimum intensity and distance") and moves the green "Recommended" pill from Keep → Push. Keep is only recommended when Push isn't available.
- **Recovery workout tier (ISSUE-138)**: new `'recovery'` `WorkoutType`. Extends the downgrade ladder (`… → marathon_pace → easy → recovery`) so the suggester can absorb excess load on all-easy weeks where the running floor blocks distance reduction. Easy → recovery preserves distance but cuts load (zone 1 only, RPE 3, pace ≈ easy + 43 s/km). Wired through load profile, pace, HR zone (Z1), matcher, and renderer colour. `LOAD_PROFILES.recovery` and the pace multiplier (1.12) are provisional and flagged for Tristan's sign-off.
- **Test**: `km-budget.test.ts` budget-consumption assertion loosened to allow overshoot by ≤ largest single adjustment's load (matches the new first-adjustment semantics).
- **Past-day unrated runs stay reducible (ISSUE-137 follow-up)**: `filterRemainingWorkouts` in `excess-load-card.ts` previously excluded runs whose scheduled day had passed, even if unrated — so a Friday excess-load modal couldn't see Wednesday's un-logged tempo. Now the filter is unrated-only; past-day unrated runs stay eligible so the user can replan the rest of the week. `workoutDateMs` helper removed (no remaining callers).
- **Redundant copy suppressed**: the new "remaining runs at minimum" banner and the green "Recommended" on Push only fire now when the candidate list is empty due to floor constraints — not when the suggester has already surfaced the blue `noMatchingRun` / `alreadyCompletedMatch` forward-apply banner. Avoids two competing calls-to-action in the same modal.

---

## 2026-04-14 — HR drift heal-on-read for pre-migration activities

- **Root cause**: activities cached before migration `20260312_hr_drift.sql` have `hr_zones` populated but `hr_drift = NULL`. The standalone sync path short-circuits on `cached?.hr_zones` and returns `hrDrift: null` without re-fetching the stream, so existing activities never get drift backfilled even after the column was added.
- **Fix**: added a heal-on-read block in `supabase/functions/sync-strava-activities/index.ts` (mirrors the existing `km_splits` heal pattern). When `cached.hr_zones` is set but `cached.hr_drift` is null and activity type is in `DRIFT_TYPES` with duration ≥ 20 min, re-fetch the HR stream, compute drift, patch DB, and return it on the row. Client-side patching in `src/data/stravaSync.ts` and `src/calculations/activity-matcher.ts` already handles null→value backfill on actuals.
- **Coach copy**: the `>8%` drift sentence in `workout-insight.ts` now only fires on easy/long runs (gated on `!s.quality`) and explains drift in layman's terms — rising HR at steady pace points to heat, dehydration, fatigue, or pace too aggressive. On quality sessions (intervals/threshold/tempo) drift >8% is expected and the callout is suppressed.

## 2026-04-14 — Readiness: strain card always visible, 130% bucket fixed, coach mentions big session

- Today's Strain card now renders unconditionally (previously hidden when `todaySignalBTSS === 0`). Zero-activity states: planned day shows `0% / Not started / "Planned session not yet logged."`; rest day shows `0 TSS / Rest day / "Scheduled rest day. No activity expected."`
- Fixed green-at-130% bug. Strain pct is now rounded before bucketing, so the displayed `130%` correctly lands in the `Exceeded / warn` state instead of `Complete / ok`. Same rounding applied to adhoc pct and to the daily-coach `sp >= 130` branch.
- Coach top-line sentence now references actual TSS when the session is done or exceeded: "Big session logged (344 TSS). Daily target well exceeded — recovery is the priority for the next 24 hours." instead of the generic "Daily load target reached."
- Files: `src/ui/readiness-view.ts`, `src/calculations/daily-coach.ts`.

## 2026-04-14 — Readiness cards: consistent value presentation

- Standardised all six sub-signal cards on the 7-Day Rolling Load blueprint: `[24px/600 number+unit] [13px #94A3B8 status word]`, optional `[12px TEXT_S metadata line]`, then the description paragraph.
- Dropped the 32px/300 thin-numeric style previously used by Strain, Freshness, Physiology, and Sleep History.
- Freshness: removed the pill for "to baseline"; it is now a plain metadata line. Load Ratio: swapped so the ratio (e.g. `1.15×`) is the headline and the label (`Optimal`) is the muted status. Physiology and Sleep History: added status words (`Strong`/`Moderate`/`Low`/`Poor`).
- Files: `src/ui/readiness-view.ts`.

## 2026-04-14 — Garmin steps + active minutes now flow to strain (ISSUE-136 fixed)

- **Webhook `handleDailies` now stores steps correctly**: Garmin's webhook payload uses field name `steps`, not `totalSteps` (the latter is REST/backfill only). Accept all three aliases (`steps ?? totalSteps ?? stepsCount`). Also captures `active_calories` (`activeKilocalories`), `active_minutes` (`moderateIntensityDurationInSeconds + vigorousIntensityDurationInSeconds`), and `highly_active_minutes` (`vigorousIntensityDurationInSeconds`). Confirmed on-device: strain view now shows step counts.
- **`sync-today-steps` edge function**: rewritten to read directly from `daily_metrics` instead of calling Garmin's epoch API (which returned `401 app_not_approved`). Webhook is now the single source of truth for steps.
- **LT threshold (ISSUE-134)**: confirmed still blocked. `lt_thresholds` empty; `physiology_snapshot_daily.lt_pace_sec_per_km` all NULL; zero `userMetrics` pushes have ever arrived. Blocked on Garmin developer portal access to enable User Metrics subscription.

## 2026-04-14 — Strain timeline rows open full activity detail page

- Tapping a Timeline row on the Strain view now navigates to the full activity detail page instead of a small overlay with summary stats. Back button returns to Strain view. `ActivityDetailSource` extended with `'strain'`. Removed dead `showActivityDetail` overlay in `src/ui/strain-view.ts`; routing added in `src/ui/activity-detail.ts`.

## 2026-04-14 — Strain ring: colour blend + rounded caps + sweep-in reveal

- Single SVG holds both the grey track AND a round-capped coloured arc. The arc is built with an SVG `<mask>`: a stroked circle with `stroke-linecap="round"` defines the visible region; an `<foreignObject>` containing a `conic-gradient` div is clipped by that mask, so the ring gets native rounded caps at BOTH ends and smooth colour blending along its path.
- Wide 20° blend zones at each segment junction (green↔orange and orange↔red interpolate over ~40° each).
- Classic stroke-dashoffset reveal restored: dashoffset animates from arc-length to 0 over 1.4s, so the arc draws clockwise from 12 o'clock. Caps move with the arc natively — no separate DOM cap elements, no floating dots, no positioning drift.
- `src/ui/strain-view.ts`.

## 2026-04-14 — HR drift heal-on-read for pre-migration activities

- **Root cause**: activities cached before migration `20260312_hr_drift.sql` have `hr_zones` populated but `hr_drift = NULL`. The standalone sync path short-circuits on `cached?.hr_zones` and returns `hrDrift: null` without re-fetching the stream, so existing activities never get drift backfilled even after the column was added.
- **Fix**: added a heal-on-read block in `supabase/functions/sync-strava-activities/index.ts` (mirrors the existing `km_splits` heal pattern). When `cached.hr_zones` is set but `cached.hr_drift` is null and activity type is in `DRIFT_TYPES` with duration ≥ 20 min, re-fetch the HR stream, compute drift, patch DB, and return it on the row. Client-side patching in `src/data/stravaSync.ts` and `src/calculations/activity-matcher.ts` already handles null→value backfill on actuals.

## 2026-04-14 — Debrief gating: week no longer advances until "Accept plan"

- **Week advance now gated on completing the full debrief flow.** New state field `lastCompleteDebriefWeek` is set only when the user clicks "Accept plan" in step 3 (plan preview). `advanceWeekToToday()` clamps `s.w` to `lastCompleteDebriefWeek + 1`, so dismissing the debrief (X) keeps it pending and re-fires on next launch. `src/ui/welcome-back.ts`, `src/ui/week-debrief.ts`, `src/types/state.ts`.
- **Auto-fire pending debrief in complete mode.** `main.ts` checks `isWeekPendingDebrief()` on launch and opens the debrief with `mode='complete'` so the user gets the full summary → animation → plan preview flow, not the review variant.
- **One-time migration (`_debriefGateV3`)** reseeds `lastCompleteDebriefWeek = max(0, lastDebriefWeek - 1)` and rolls `s.w` back to the pending week so users previously auto-advanced past an incomplete debrief see it again.
- **Fixed stacked-modal bug** where `renderHomeView()` re-triggered the debrief on every render, mounting duplicate `#week-debrief-modal` nodes and breaking click handlers (the user saw the modal but couldn't click "Generate next week"). `showWeekDebrief` now bails if a modal is already mounted, and the home-view auto-trigger was removed (launch-time trigger in `main.ts` is sufficient).
- **Removed dead `_handleUncompletedSessions` branch.** `wk.workouts` is never populated on the Week object so the "Move to next week / Drop them" UI never rendered — accept handler now calls `_closeAndRecord` directly.

## 2026-04-14 — Color standardisation + coach commentary ties to driving signal

- **Strain ring now blends colours + sweeps in on open**: single `conic-gradient` masked to ring shape with wide 18° blend zones at each junction and 4° soft fades at each end. Mask uses feathered radial-gradient stops so the inner/outer ring edges are anti-aliased (no hard outline). Clockwise sweep reveal from 12 o'clock via a registered `@property --strain-arc` animated 0→1, which scales every conic-gradient stop. `src/ui/strain-view.ts`.
- **Universal 4-tier colors for sleep/recovery scores**: ≥ 80 bright green, ≥ 65 muted green, ≥ 50 amber, < 50 red. `--c-ok-muted` now `#6EC867` (more saturated than prior `#93D18B`). Applied across home rings, physiology mini-rings, recovery log dots, sleep cards, coach modal.
- **Readiness ring keeps its own label-based color scheme** (Primed=bright green, On Track=muted green, Manage Load=amber, Ease Back/Overreaching=red) with thresholds 75/55/35 — different from sleep/recovery because the semantics differ (score 62 = "train as planned" for readiness, but only "mediocre sleep" for sleep score).
- **Recovery pill threshold relaxed**: `SLEEP_GREEN` in `recovery/engine.ts` dropped from 80 back to 70 so sleep scores in the 70s no longer trigger yellow + adjustment prompt.
- **Coach primary message respects driving signal**: when freshness is the weakest readiness sub-score (`drivingSignal === 'fitness'`), the coach leads with freshness and appends sleep debt as secondary context. Previously, a 5h+ sleep debt would dominate the message even when freshness was the bigger drag on the composite score. Eliminates mixed messaging between readiness page (showed "On Track") and coach copy (said "prioritise sleep").
- **Removed debug console.log** from `computeRecoveryScore` in `readiness.ts`.
- **Sleep History card is now tappable**: opens the Sleep detail view with back returning to Readiness. `src/ui/readiness-view.ts`.
- **Sleep History debt matches Sleep detail view**: card previously showed a 7-night simple bank (e.g. "0.9h debt") while the Sleep detail view showed the load-adjusted cumulative debt with exponential decay (e.g. "5h 30m debt"). Card now calls `computeSleepDebt(...)` so both surfaces show the same number. The simple bank still feeds the recovery score (unchanged). `src/ui/readiness-view.ts`.

## 2026-04-13 — Stats page cleanup + rolling load chart alignment

- **Total Load chart**: removed misleading "avg" and "ease" reference lines (were comparing Signal A ctlBaseline against Signal B chart data). Removed dashed lines. Clean tick labels at every step (100, 200, 300, 400).
- **Progress stats**: added Total Distance, Fastest 5k, Fastest 10k, Fastest Half Marathon rows. PB rows only appear when a qualifying run exists. Times estimated from avg pace on runs covering at least that distance.
- **Rolling load chart**: aligned to stats page format. Added area fill, matched grid line style, removed "avg" reference line, added draw-on animation, matched container structure (padding-right gutter, percentage-based y-axis labels).

## 2026-04-13 — Debrief gated on completion + HR effort signal fixes

- **Week advance gated on debrief**: `advanceWeekToToday()` no longer advances `s.w` past a week that hasn't been debriefed (`lastDebriefWeek + 1` cap). Debrief always opens in `complete` mode with the full flow (summary, animation, plan preview).
- **`tempo` added to `getWorkoutHRTarget`**: was falling through to `default: undefined`, causing `hrEffortScore = null`. Also added `recovery`, `steady`, `test_run`, and a general Z2-3 fallback for unknown types.
- **RPE and HR effort split into two signals**: `WeekSignals.hrEffort` added, `computeWeekSignals` takes 5 params, debrief/plan-view/daily-coach all updated. Separate `rpeEffort` and `hrEffort` stored on Week object.
- **Debrief RPE fix**: was iterating empty `wk.workouts` (never populated). Now calls `generateWeekWorkouts()` to get the correct expected RPE per workout.
- **Debrief HR on-the-fly computation**: if `hrEffortScore` is null on a garminActual, computes it from `avgHR` + workout type + HR zones.
- **ISSUE-133 logged**: `hrDrift` not computed by edge function for most activities.

## 2026-04-13 — Fix compounding VDOT detraining + blend race predictions

- **Compounding detraining bug**: `advanceWeekToToday()` applied detraining using the full calendar gap even when `s.w` was clamped to plan length. Every app launch past plan end re-applied the full gap, dropping `s.v` from 51.4 to 24.5. Fix: use `actualAdvance` (weeks `s.w` actually moved), not raw gap.
- **State repair**: one-time migration detects `s.v < 0.9 * s.iv`, resets to `s.iv`, then applies one correct round of detraining for inactive weeks (wkGain = 0).
- **Race Predictions now use blended model**: Both Race Predictions cards (stats summary and standalone) now use `blendPredictions()` which weights LT pace (55-70%), VO2max (15-20%), PBs, and recent runs. Previously used pure VDOT-to-time (Daniels), ignoring watch data entirely. Falls back to VDOT when no watch/PB data available.
- **Marathon LT multiplier now running-specific**: `predictFromLT` was using `athleteTier` (derived from total cross-training CTL) to pick the marathon multiplier, putting cross-trained athletes into "high_volume" tier with the most aggressive 1.06 multiplier even if their running fitness didn't justify it. Now derives the marathon-only tier from LT pace itself via `cv(10000, ltPace * 10)` mapped to VDOT bands (≥60 high_volume, ≥52 performance, ≥45 trained, ≥38 recreational, else beginner). 5K/10K/HM multipliers unchanged (already stable across tiers).
- **Recent run auto-derived from garminActuals**: Race Prediction cards now pick the most recent running activity from `garminActuals` rather than the stale onboarding `s.rec` value. Ensures recent Strava/Garmin runs feed the blend even if the user never edited their "recent run" field post-onboarding.
- **Card labels clarified**: "Race Predictions" → "Current Race Estimates" with subtitle "Estimated finish times if racing today", so users understand these are current-fitness estimates, not end-of-plan targets.
- **Low-volume detraining discount on watch LT/VO2**: Watches estimate LT and VO2max from running activities only and don't decay these values when training stops. `blendPredictions` now accepts a 4-week running-km average and reduces LT + VO2 weights (transferring weight to PB) based on volume bands, scaled by distance sensitivity (marathon hit hardest, 5K barely). Rationale in `docs/SCIENCE_LOG.md` — Coyle 1984, Mujika & Padilla 2000, Joyner & Coyle 2008 on fractional utilization decay.

## 2026-04-13 — RPE and HR effort split into separate signals

- **Two distinct coaching signals**: Perceived effort (RPE) and Heart rate effort are now independent signals in `WeekSignals`, the week debrief, Plan page overview, and daily coach. Previously blended into a single `effortScore`.
- **New `hrEffort` field on WeekSignals**: `'overcooked' | 'on-target' | 'undercooked' | null`, computed from average `hrEffortScore` across running garminActuals.
- **`computeWeekSignals` now takes 5 params**: `(rpeScore, avgHrEffortScore, tssPct, ctlDelta, avgHrDrift)`. All callers updated (plan-view, daily-coach, week-debrief).
- **Debrief signal pills**: now show 5 rows (Perceived effort, Heart rate effort, Training volume, Running fitness, HR during sessions) with neutral fallback when data is unavailable.
- **RPE/HR divergence coaching**: `getCoachCopy` detects when RPE and HR disagree (e.g. "Runs felt hard but HR stayed in zone") and provides specific coaching insight.
- **Separate storage on Week**: `rpeEffort` (pure RPE deviation) and `hrEffort` (average hrEffortScore) now stored alongside the legacy blended `effortScore` in events.ts week-advance flow.
- **Em-dash cleanup**: all user-facing copy in coach-insight.ts rewritten to use periods instead of em-dashes per style guide.
- **`high-over` load signal restored**: pill map and coach copy now correctly handle `tssPct > 30` ("Well above plan", red).

## 2026-04-13 — Fitness check-in redesign (continuous mode)

- **Timing changed**: check-in now triggers on the first week of a new block (post-deload, week 5/9/13/...) instead of during the deload week itself. This is when the athlete is freshest and a fitness test is most meaningful.
- **Workout generation replaces manual entry**: selecting a check-in type now generates a structured workout (via `intentToWorkout`, same as the session generator) and adds it to the current week's plan. No more manual pace/distance entry modal.
- **New overlay**: `benchmark-overlay.ts` provides a centered modal with clean post-deload context. Auto-triggers on post-deload weeks if no benchmark recorded yet.
- **Simplified plan-view and home-view cards**: inline option pickers replaced with compact status cards that open the overlay. States: prompt, workout added, completed, skipped.
- **Removed bottom-sheet entry modals** from both plan-view and main-view.

## 2026-04-13 — Fix compounding VDOT detraining bug

- **Root cause**: `advanceWeekToToday()` applied detraining using the full calendar gap even when `s.w` was clamped to plan length. When the user was past the end of their plan, every app launch re-applied the full gap's detraining to `s.v`, compounding the loss. `s.v` dropped from 51.4 to 24.5 (race predictions showed 5:32 marathon instead of ~3:12).
- **Fix**: detraining now uses `actualAdvance` (weeks `s.w` actually moved forward), not the raw calendar gap. When clamped, `actualAdvance = 0` and no detraining fires.
- **State repair**: one-time migration detects `s.v < 0.9 * s.iv`, resets to `s.iv`, then applies one correct round of detraining for inactive weeks (wkGain = 0).

## 2026-04-13 — Stats chart standardisation + draw-on animation

- **Garmin webhook now stores steps**: `handleDailies` was missing `steps: d.totalSteps` — webhook stored HR, stress, VO2max but silently dropped step count. Historical steps only came from backfill; daily webhook pushes had no steps. Fixed and deployed.

- **Y-axis labels added** to Running Distance, CTL, TSB, and ACWR charts. Previously had grid lines but no numbers.
- **Reference line labels** added to Total Load chart: "avg" and "ease" in the y-axis gutter next to their dashed lines.
- **ACWR threshold labels** — 1.3 and 1.5 reference values shown in the y-axis gutter with matching colours.
- **TSB reference labels** — key values (-10, 0, +15) shown in the y-axis gutter.
- **Sharp angular lines** — replaced bezier-smoothed curves (`smoothAreaPath`) with sharp polylines across all Stats/Physiology charts. Weekly data now matches the angular style defined in UX_PATTERNS.
- **Slate strokes** — swapped all inline `rgba(99,149,255,...)` blue chart colours to shared constants (`CHART_STROKE=#64748B`, `CHART_FILL`, `CHART_FILL_LIGHT`, `CHART_STROKE_DIM`). Semantic colours (green CTL, red/amber ACWR) unchanged.
- **Grid lines** — added `chartGridLines()` helper. Load, forecast, distance, CTL, and ACWR charts now show subtle horizontal grid lines (`rgba(0,0,0,0.05)`, 0.5px).
- **Y-axis gutter** — charts with y-axis labels now use `padding-right:36px` on the wrapper with `right:0` labels (was `right:4px` without padding). Label font: 9px, `#94A3B8`.
- **Removed `preserveAspectRatio="none"`** from all 15 SVG chart instances. Charts now scale proportionally from viewBox.
- **`stroke-linejoin="round"`** added to all chart line paths for consistent angular rendering.
- **Sparkline draw-on animation** — chart line paths with `class="chart-draw"` animate via `stroke-dashoffset` on page load (1.2s ease-out). `animateChartDrawOn()` called after each detail page render and range toggle.

## 2026-04-13 — Home page hero redesign and layout restructure

- **Hero header** — centered layout matching Plan page: "[Name]'s [Plan Type]" at 48px/700, phase at 17px/700, week at 14px/500. Race countdown as frosted glass pill top-right (when in race mode). Profile avatar top-right.
- **Card reorder** — Today's Workout first, then Readiness. This Week progress bars moved to Plan page (current week only).
- **"Done" pill restyled** — removed green `m-pill-ok` background, replaced with neutral frosted glass bordered pill matching app design system.
- **This Week on Plan** — full progress card (sessions, distance, TSS bars) now renders on Plan page for the current week, replacing the simpler km/load bars. Past/future weeks keep the compact bars.

## 2026-04-12 — Shared watercolour background + dark→light conversion

- **Shared sky-background module** — `src/ui/sky-background.ts` with 6 palettes (blue, indigo, teal, deepBlue, slate, grey) and parameterized drift animation. All detail pages now use `buildSkyBackground()` instead of inline SVG.
- **Rolling Load** — dark gradient hero replaced with deepBlue watercolour. Header, ring container, and ring text converted from white-on-dark to dark-on-light with frosted inner circle.
- **Load & Taper** — dark slate gradient replaced with slate watercolour. Full dark→light conversion: header, ring, text.
- **Injury Risk** — inline watercolour SVG (40+ lines) replaced with shared module call (`grey` palette). Animation CSS added.
- **Sleep, Strain** — converted in prior pass (indigo, teal palettes).
- **Physiology, Readiness, Freshness** — already light; switched to shared module (blue palette).

## 2026-04-12 — Sleep History as 4th recovery signal

- **Recovery composite reweighted** — HRV 50%, Last Night Sleep 25%, Sleep History 25% (was HRV 55%, Sleep 45%). RHR remains override-only.
- **Sleep History signal** — 14-day rolling average of sleep scores, penalised by cumulative sleep debt (~3pts per hour of debt). Raw Garmin/Apple scores used directly (no z-scoring, unlike HRV).
- **Asymmetric sleep weighting** — when last night is worse than history avg, weight shifts to 35/15 (last night/history) from 25/25. Acute sleep loss has disproportionate next-day impact (Fullagar 2015, Reilly & Edwards 2007).
- **Sleep debt feeds into recovery composite** — ensures physiology and readiness pages tell the same story. No more "82% recovered" alongside "5.5h debt, prioritise sleep."
- **4th mini-ring on Physiology detail page** — "Sleep Hist" ring shows debt-adjusted score alongside HRV, Sleep, and RHR sub-scores. Home page stays at 3 rings.
- **Sleep History card on readiness detail page** — shows debt-adjusted score with 14d avg context and debt callout.
- **Science log updated** — Van Dongen 2003, Halson 2014, Fullagar 2015, Reilly & Edwards 2007, Walsh/IOC 2021 cited.

## 2026-04-13 — Load breakdown dedup and label fixes

- **Running label normalization** — "Run", "Trail Run", "Treadmill Run", "Virtual Run", "Track Run" all merge under "Running" in the load breakdown bar. Previously "Run" and "Running" appeared as separate rows.
- **Adhoc workout dedup fix** — load breakdown now checks `garminId` property directly on adhoc workouts, not just the `garmin-` id prefix. Prevents double-counting when a run exists in both garminActuals and adhocWorkouts.
- **Surplus run label fix** — surplus distance items no longer leak the planned workout description (e.g. "Threshold 5x5 +9.0km surplus") as the sport label. Now merges under "Running".

## 2026-04-13 — Home page hero and layout redesign

- **Hero header** — replaced "Mosaic" brand header with personalised "[Name]'s [Plan Type]" (e.g. "Tristan's Marathon Plan") at 28px/700. Phase label and week number below. Dynamic: reads `onboarding.name`, `rd`, and `continuousMode` from state.
- **Race countdown in hero** — if in race mode, countdown shows as a frosted glass pill (top-right) with race name below the week line. Separate race countdown card removed.
- **Card reorder** — Today's Workout first, then Readiness, then This Week. Previously: This Week, Readiness, Today's Workout.
- **Action buttons** — Coach and Check-in moved below the title block. Profile avatar stays top-right.
- **Card styling** — all cards switched from warm beige (`#F5F0E8`/`#F7F5F0`) to white `#fff`. SVG circles removed from This Week, kept on Today's Workout. Side margins unified to 16px.
- **Background** — full-page light blue sky gradient (`#C5DFF8 → #FAF9F6`), frosted glass buttons. Same visual language as Plan page.

## 2026-04-12 — Strain ring multi-colour segments + glass effect

- **Strain ring redesign** — ring now uses 3 colour segments: green (below target range), orange (inside target range), red (above target range). Replaces the previous single-colour fill + dashed target marker approach. Each segment animates in sequence on load.
- **Glass container** — ring container updated to a clearer glass effect: lower background opacity (`0.08`), stronger blur (`40px`), subtle inner glow, reduced border opacity.
- **Info overlay updated** — "Target Marker" section replaced with "Ring Colours" explaining the green/orange/red scheme.

## 2026-04-12 — Design token standardisation

- **`docs/UX_PATTERNS.md`** — Codified Physiology page as the canonical design reference. Added typography scale, ring size standard (hero r=46, mini r=20), spacing standards (card padding 16px, hero height 480px), and flagged legacy values.
- **Text colours standardised** to `#0F172A` / `#64748B` / `#94A3B8` (slate family) across all views. Replaced legacy `#111`/`#555`/`#999` in strain-view, `#2C3131`/`#6B7280`/`#9CA3AF` in rolling-load-view, load-taper-view, activity-detail, and inline instances in sleep-view and home-view.
- **Hero ring radius** standardised to 46 (was 57) in sleep-view, strain-view, readiness-view, rolling-load-view, load-taper-view.
- **Hero metric font** standardised to 48px/700 across all pages (was 36px/300 in sleep, 42px/300 in strain/readiness, 36px/300 in rolling-load/load-taper).
- **Page title weight** standardised to 700 (was 600 in sleep-view, strain-view).
- **Section heading** in strain-view updated from 15px/600 to 17px/700 to match Physiology.
- **Load-taper hero height** fixed from 460px to 480px.
- **Ring SVG structure** standardised across all pages: container 220×220, viewBox `0 0 100 100`, center 50,50, stroke-width 8 (matching Physiology). Previously varied: Readiness was 160×160 container, Sleep used 160×160 SVG with 80,80 center, Strain/Rolling Load used 180×180 SVG with 65,65 center and stroke-width 12.

## 2026-04-12 — HRV baseline consistency fix

- **`src/calculations/daily-coach.ts`** — Coach nudge HRV percentage now uses the same formula as the recovery card: 7-day average vs 28-day baseline. Previously used last-night value vs all-time mean, causing contradictions (e.g. card shows +9%, nudge shows -22%).

## 2026-04-12 — RPE rating system

- **`src/ui/activity-detail.ts`** — New RPE card on activity detail page. Shows current rating (colour-coded green/amber/red matching the canonical RPE scale) or "Tap to rate" if unrated. Tapping opens a slider overlay (1-10) that saves to `wk.rated[workoutId]`.
- **`src/ui/activity-review.ts`** — RPE prompt now also shown for excess (unmatched) runs, not just slot-matched ones. Both auto-process and batch-review paths updated. Slider colour now tracks effort level (green 1-3, amber 4-6, red 7-10). Fixed hardcoded `km` unit in prompt to use `formatKm()`.
- **`src/ui/events.ts`** — `effortScore` computation now includes adhoc `garmin-` runs so excess-run RPE ratings feed into weekly debrief signals and plan adjustments.
- **`src/ui/home-view.ts`**, **`src/ui/plan-view.ts`** — Pass `workoutId` through to `renderActivityDetail` so the RPE card appears on activities opened from both views.

## 2026-04-12 — Plan tab full rebuild (round 2)

- **Hero background** — phase-keyed dark gradient (slate for base, brown for build, rose for peak, blue-grey for taper). Rolling hills SVG, warm glow orbs, bottom fade to `--c-bg`. Matches the design language of Sleep, Load/Taper, Rolling Load.
- **TSS progress ring** — 100px ring in the hero showing actual vs planned TSS. Animates on mount. White stroke below 70%, full white at 70%+, green at 100%.
- **Header** — "Week 8 / 10" as 28px white hero text. Phase label + date range as subtle white-on-dark text below. Nav arrows and profile as frosted glass buttons (`backdrop-filter:blur`).
- **Action buttons** — Coach, Check-in, Wrap up week as frosted glass pills on the hero. Review past week and + Add session as secondary CARD-shadow buttons below the hero. Removed uniform pill row.
- **Week Overview removed** — collapsible section with coach copy killed entirely.
- **Status clarity** — "Logged" now shows green, "Missed" shows amber, both at 600 weight. Distinguishable at a glance.
- **Workout card spacing** — equal 15px vertical padding on all rows including rest days.
- **Progress bars** — in their own CARD-shadow card below the hero.
- **Staggered floatUp** — all sections animate in with `plan-fade` class.

### Previous round (same date)
- **Calendar strip** — removed. 7 coloured circle dots + click-to-scroll handler + `DAY_LETTER` constant deleted.
- **Workout rows** — collapsed 7 status colours (green/blue/amber for Done/Today/Missed/Adjusted/Replaced/Skipped/Upcoming) into 1 accent: warm terracotta `#C4553A` on Today only. All past/future labels use neutral `var(--c-faint)`. Done rows get slightly stronger `var(--c-muted)` presence. Green dot on matched activities removed, caution/orange on undo/timing-mod/replaced removed.
- **Workout cards** — flat `border-top` rows converted to individual CARD shadow cards (`box-shadow`, `border-radius:16px`, `margin:6px 16px`) with staggered `floatUp` animation.
- **Banners** — all 7 (carry-over, km-nudge, adjust-week, illness, injury, morning-pain, benchmark) rebuilt to use shared `PLAN_CARD_STYLE` constant. Removed: gradient accent bars, tinted backgrounds (amber/green/blue), 6-colour injury phase configs, multi-colour pain level, sun icon box, emoji in benchmarks, green "Recovered" buttons. All now neutral white card with shadow.
- **Activity log** — wrapped in a card. Coloured dots (ok/caution/accent) and badges (Matched green, Excess amber, Pending amber) all neutralised to muted pills.
- **Page container** — `max-width:480px;margin:0 auto` added.
- **Header buttons** — `flex-wrap:wrap` added to right button row for iPhone, so Coach/Check-in/nav pills wrap cleanly.

## 2026-04-12 — Fix Garmin daily metrics not reaching the app

- **Symptom**: daily metrics (RHR, HRV, VO2max, stress) not showing in app despite Garmin webhook pushing data successfully. Sleep unaffected.
- **Root cause**: migration `20260407_daily_metrics_steps.sql` (adding `steps`, `active_calories`, `active_minutes`, `highly_active_minutes` to `daily_metrics`) was never applied to prod. `sync-physiology-snapshot`'s SELECT included these columns, so the query errored, returning zero daily metrics rows. Sleep was unaffected (separate query on `sleep_summaries`). Backfill also failed silently on every upsert, triggering the 12h throttle guard.
- **DB fix (applied manually)**: ran `20260407_daily_metrics_steps.sql` and `20260408_coach_narrative_limits.sql` against prod.
- **`src/main.ts`** — Detects `?garmin=connected` query param (set by `garmin-auth-callback` redirect) and clears the backfill throttle guard + Garmin cache on return. Strips the param from the URL afterward. Bumped both `triggerGarminBackfill(4)` calls to `triggerGarminBackfill(8)` (the edge function max).
- **`src/ui/account-view.ts`** — "Connect Garmin" button now calls `resetGarminBackfillGuard()` before redirecting to OAuth.
- **`src/ui/wizard/steps/fitness.ts`** — Same guard-clear added to wizard Garmin connect button.

## 2026-04-11 — Debounce home re-renders on startup

- **Symptom**: on launch, the home view visibly refreshed 3–5 times in quick succession before settling.
- **Root cause**: `main.ts` fired an initial `renderHomeView()` after `advanceWeekToToday`, then each async sync (Strava activities, `syncTodaySteps`, `syncPhysiologySnapshot`, `refreshRecentSleepScores`) triggered its own full re-render as it landed. For a Strava+Garmin user, up to five sequential renders ran in the first few seconds, each visible as a flicker.
- **`src/main.ts`** — Added `scheduleHomeRefresh()`, a 150 ms trailing-edge debounce around `renderHomeView()`. All twelve post-sync call sites (startup chains + `visibilitychange` handler) now go through it; the initial launch render still calls `renderHomeView()` directly so first paint is unchanged. The cascade of post-sync refreshes now collapses into a single render.

## 2026-04-11 — Breakdown card: distinct blue shades per activity

- **`src/ui/home-view.ts`** — Previously, the weekly load breakdown used `sportColor()` which gave the same grey fallback to any activity that wasn't in the hard-coded sport map ("HIIT", "Alpine Skiing", "Run", plus most adhoc workout titles), while matched running slots were forced to `#3b82f6`. The result was three or four rows painted with one of two colours. Added `breakdownShade(index)` exporting a 7-step monochromatic blue ramp (`#1e3a8a` → `#bfdbfe`). Segments are already sorted descending by TSS, so the largest row gets the darkest shade.
- **`src/ui/load-taper-view.ts`** — `buildBreakdownCard` remaps `seg.color` through `breakdownShade` before rendering the stacked bar, legend, and per-row bars. Keeps the "one data hue" rule (all shades of blue) while giving each row a distinct step.
- **`src/ui/home-view.ts`** — `showPlanLoadBreakdownSheet` applies the same remap after sort so the plan-wide breakdown matches.

## 2026-04-11 — Load & Taper ring shows true % when over target

- **`src/ui/load-taper-view.ts`** — `barPct` was clamped to `Math.min(100, ...)` before rendering the "X% of target" label, so a week at 345 TSS against a 268 target displayed "100% of target" instead of "129%". The clamp has been moved to `ringPct` only (ring arc still caps visually at 100%); the text label now shows the true percentage.

## 2026-04-11 — ACWR modal: attribution, severity, and copy alignment

- **`src/ui/main-view.ts`** — `crossTrainingCause` (Rule 3) was picking `wk.unspentLoadItems[0]` — the first item in insertion order. When a user did multiple cross-training sessions in the same week (e.g. padel + gym), the copy could attribute the load spike to whichever was stored first. Now sorts by `aerobic + anaerobic` and picks the heaviest non-running item. Surplus-run items are explicitly excluded — those are mechanical (Rule 2), not cross-training (Rule 3).
- **`src/ui/main-view.ts`** — When ACWR is only marginally above the ceiling (≤5%, e.g. 1.52× vs 1.5×), `triggerACWRReduction` now passes `maxAdjustments: 1` to `buildCrossTrainingPopup`. Previously, the modal header said "A small adjustment is enough" but the Reduce option listed 2+ changes (easy-run trim + quality downgrade) — a direct contradiction. Now a single small cut is suggested, matching the copy.
- **`src/cross-training/suggester.ts`** — New `maxAdjustments?: number` parameter on `buildCrossTrainingPopup`. Overrides severity-based adjustment count: `1` forces light severity (single adjustment), `2` caps extreme at heavy. Also suppresses replace-option alternatives (small overshoots shouldn't trigger full run replacements).
- **`src/ui/suggestion-modal.ts`** — All 5 rules rewritten to be action-agnostic. Rules 1, 2, 4, 5 previously prescribed specific adjustment counts ("Cut intervals first. Threshold sessions next", "Shorten the long run and one easy run", "Replacing one interval session"), which created contradictions whenever the suggester output a different count (especially when `maxAdjustments: 1` forces a single adjustment). Each rule now describes the CAUSE and direction (intensity first / volume first) and leaves specifics to the cards. Em dashes removed throughout per the writing style guide. `humanConsequence` high-status copy reworded to drop "Your body needs" (wellness-app tone).

## 2026-04-11 — Fix blank-page crash from malformed pending activities

- **Symptom**: on launch, the app flashed for a second then went completely blank.
- **Root cause**: `syncStravaActivities` → `processPendingCrossTraining` → `showActivityReview` creates a full-screen `activity-review-overlay` backdrop *before* building its content. A legacy Strava pending item had `activityType === undefined` (first crash) and another had `garminId === undefined` (second crash). `formatActivityType(undefined).replace(...)` and `escHtml(undefined).replace(...)` both threw. The caller's `.catch(() => {})` swallowed the error, but the empty cream overlay stayed in the DOM covering the entire screen.
- **`src/data/activitySync.ts`** — `processPendingCrossTraining` now drops malformed pending items (missing `garminId`, `activityType`, or `startTime`) upstream with a `console.warn`. These items can't be rendered or assigned; dropping them is safer than carrying them forward.
- **`src/ui/activity-review.ts`** — `showActivityReview` now wraps `showMatchingEntryScreen` in try/catch. If anything in the matching UI throws, the full-screen overlay is torn down instead of left as an invisible blank backdrop. Prevents this entire class of bug from producing a blank page.
- **`src/calculations/activity-matcher.ts`** — `formatActivityType` accepts `string | null | undefined`, returns `'Activity'` for nullish input. Protects ~30 call sites.
- **`src/ui/matching-screen.ts`** — `escHtml` accepts `string | null | undefined`, returns empty string for nullish input.
- **`src/main.ts`** — Global safety net: `window.error` and `window.unhandledrejection` listeners now log the error and tear down any orphaned full-screen overlays (currently `activity-review-overlay`). Defence-in-depth so a future crash in fire-and-forget syncs (which all use silent `.catch(() => {})`) can never produce a blank page again.

## 2026-04-10 — Week debrief: circular progress + smarter plan toggle

- **`src/ui/week-debrief.ts`** — Analysis animation now uses an SVG circular progress ring (r=32, stroke-linecap round) that fills to 100% as the checklist completes. The centre shows a live percentage. Replaces the flat linear bar.
- **Adjusted/Standard toggle now only appears when plans are *visibly* different.** The previous gate was `changes.length > 0`, which triggered on things like "volume scaled down 8%" — real in minutes, but invisible once distances round to the nearest km. New gate is `visiblyDifferent = perWorkoutAnnotations.some(a => a !== '')`, so the toggle only shows when at least one workout has a meaningful change (type swap or ≥1km difference). When plans render identically the user sees a single plan with a "No adjustments needed" note.
- **Dev helper**: `__previewAdjustedPlan(effort, acwrStatus)` exposed on `window` — call from devtools to preview a genuinely different plan (default: effort=2.5, acwr=caution) without waiting for real hard weeks to accumulate.

## 2026-04-12 — Plan Adherence: standalone calc + tests

- **`src/calculations/plan-adherence.ts`** — Extracted adherence logic into a standalone pure function (`computePlanAdherence`). Regenerates each past week's plan, applies workoutMods for reductions, matches against garminActuals with ≥95% distance threshold. Pushed workouts excluded from source week. Stats-view now uses the same function instead of its old crude `totalRuns / (rw × weeks)` calc.
- **`src/calculations/plan-adherence.test.ts`** — 7 tests: empty state, threshold constant, current week exclusion, pushed workouts, reduced-down targets, completion counting.

## 2026-04-10 — Running Plan Adherence on Home

- **`src/ui/home-view.ts`** — "Plan Adherence" row in the This Week progress card. Shows cumulative % of planned runs completed across all completed weeks. Current in-progress week excluded entirely. Cross-training and ad-hoc runs excluded.

## 2026-04-10 — RPE rating prompt after Strava sync

- **`src/ui/activity-review.ts`** — After Strava/Garmin activities are matched to planned workouts, a lightweight RPE slider overlay (1-10) now prompts the user to rate how hard each matched run felt. Defaults to the auto-derived RPE from HR/Garmin data. Dismissing or tapping "Skip" keeps the auto value. Tapping "Save" writes the user's ratings to `wk.rated[workoutId]`, improving the effortScore signal used in weekly debrief and plan adjustments.
- Wired into both `applyReview` (batch review flow) and `autoProcessActivities` (single-activity auto-match flow).

## 2026-04-10 — Activity log sorted by date

- **`src/ui/plan-view.ts`** — Activity log items (matched, adhoc/excess, pending) were rendered in three separate unsorted loops. Collected all items into a single array with `startTime` timestamps and sort ascending before rendering, so activities always appear in chronological order.

## 2026-04-10 — Overshoot-only reduction budget for cross-training

- **Problem**: suggestion modal offered aggressive reductions (replace easy run + downgrade both quality sessions) even when cross-training only slightly exceeded target. The full RRC (run replacement credit) was used regardless of how much overshoot existed.
- **Fix**: `budgetCapFraction` parameter added to `buildCrossTrainingPopup`. Callers compute `overshootTSS / activityTSS` and cap the reduction budget proportionally. If projected week TSS (current + remaining runs) only exceeds target by 20 TSS but the activity contributed 80 TSS, the budget is capped at 25% of RRC. Both `triggerACWRReduction` (main-view.ts) and `triggerExcessLoadAdjustment` (excess-load-card.ts) pass the cap.
- **Summary text updated**: modal now communicates "Adjustments bring your week back to ~268 TSS target" so the user understands why specific reductions are proposed.

## 2026-04-10 — UI overhaul: Home page (#10)

- **Design system alignment**: all cards use inline CARD shadow (no borders), section labels 12px weight-600 (removed `m-sec-label` ALL-CAPS)
- **Staggered floatUp animations** on all sections (header, progress bars, readiness, workout hero, race countdown, recent activity)
- **max-width 480px** wrapper on all content
- **Race countdown moved to top** (position 3, after banners) in race mode; stays below workout in general fitness mode
- **Workout hero circles** opacity boosted for more visible pattern (0.18→0.28 etc.)
- **View plan button** colour fixed: `var(--c-muted)` instead of `var(--c-accent)` (navigation link rule)
- **Dead code removed**: `showLoadBreakdownSheet` (~160 lines, replaced by Load/Taper page navigation), unused `bar()` function
- All Tailwind utility classes in section builders replaced with inline styles for consistency

## 2026-04-10 — Fix: calories fallback in Strava sync edge function

- All three Strava sync paths (standalone, backfill HR-stream, backfill avg-HR batch) now fall back to cached DB calories when Strava returns null
- Client-side `stravaSync.ts` patch copies DB calories onto existing garminActuals during sync

## 2026-04-10 — Week-end debrief: 3-step flow (Summary → Analysis → Plan Preview)

- **Refactored** `week-debrief.ts` from a single-screen modal into a 3-step flow
- **Step 1**: Week summary with metrics (distance, training load, running fitness) and coach signal pills — CTA triggers analysis
- **Step 2**: Analysis animation (~2.5s) with progress bar and stepped checklist ticking through HR data, RPE, training load, recovery, and plan generation
- **Step 3**: Suggested plan showing next week's sessions with type badges. "Adjustments applied" card lists what changed (effort scaling, ACWR quality reduction, long run capping). Toggle between adjusted and standard plan. Accept proceeds to week advance.
- Generates two plans via `planWeekSessions()`: adjusted (with trailing effortScore + ACWR) and standard (vanilla). Diffs computed automatically for change annotations.
- Pacing adjustment (rpeAdj) now applied automatically when effortScore is significantly off (no checkbox — integrated into the adjusted plan flow)

## 2026-04-10 — Fix: calories coverage across all activity types

- **Bug**: Strava list endpoint (`/athlete/activities`) often returns null calories. Only runs had a detail fetch (for splits), so non-runs never got calories from Strava.
- **Fix (standalone)**: detail endpoint (`/activities/{id}`) now fetched for all new activities when calories is null (not just runs). One extra call per new activity, cached activities skip it entirely. Also reads calories from the detail response for runs (was ignored before).
- **Fix (fallback)**: all three sync paths (backfill HR-stream, backfill avg-HR batch, standalone) fall back to cached DB calories when Strava returns null
- Client-side `stravaSync.ts` patch copies DB calories onto existing garminActuals during sync
- DB coverage before fix: RUNNING 6/20, HIIT 12/25, SKIING 1/15, TENNIS 0/12
- **Backfill mode**: detail endpoint now fetched for calories in HR-stream loop (piggybacked on existing per-activity calls) and avg-HR batch (capped at 15)
- **Standalone heal**: cached activities missing calories get a detail fetch (capped at 10 per sync)
- **Adhoc workout patch**: `garminCalories` on adhoc workout objects now patched via start_time matching

## 2026-04-10 — Fix: multi-activity "0 TSS" + summary simplification + below-target guard

- **Bug 1**: multi-activity summary showed "generated 0 TSS" while simultaneously showing 25km equiv and "Very heavy" severity. Root cause: `getWeeklyExcess()` returns `max(0, weekTotal - baseline)`, which is 0 when below target. Fix: compute TSS from the items' own iTrimp/duration instead.
- **Bug 2**: suggestion modal offered run reductions even when week TSS was below target and completing remaining runs wouldn't exceed it. Root cause: `triggerACWRReduction` fired on any unspent items regardless of week load context. Fix: added guard in `triggerACWRReduction` — projects `currentTSS + carried + remainingRunTSS` vs `plannedSignalB`; skips the modal if projected total stays within target.
- **Summary simplified**: removed per-workout impact text from summary paragraph (redundant with "View changes" sections). Multi: "33 TSS from 2 extra activities, equivalent to 25.0 km easy running." Single: "50 min padel. Consider adjusting your plan."

## 2026-04-10 — Science audit #10: Marathon max gain ceiling

- **Full marathon row** in `max_gain_pct` revised: 8.0, 7.0, 6.0, 6.5, 4.0 → 8.0, 6.8, 5.5, 4.5, 3.5
- Old advanced (6.5%) was higher than intermediate (6.0%), violating diminishing returns
- New values calibrated against HERITAGE study and Midgley 2007 meta-analysis; realised gains verified to be strictly decreasing across all tiers
- Forecast profile test #7 (Speed → Marathon) baseline range adjusted for combined effect of audit #8 (LT mult) and #10
- All 819 tests passing

## 2026-04-10 — Science audit #9: Sleep quality weights

- **Deleted dead `sleepQualityMultiplier`** function (60/40 REM/Deep) — was never called
- Actual sleep score comes from Garmin natively or `computeSleepScore` for Apple Watch (55% duration, 25% deep, 20% REM)
- Apple Watch weights audited and kept: duration-dominant with slight deep bias aligns with athletic recovery literature
- SCIENCE_LOG updated with Apple Watch scoring rationale

## 2026-04-10 — UI overhaul: Activity Detail page

- **Design system alignment**: stats grid cells use CARD shadow (no borders), all section labels use 12px weight-600 (removed ALL-CAPS `m-sec-label`)
- **Staggered entrance animations** on every section (stats, load, map, HR zones, splits, coach)
- **Tab bar** added (Home highlighted)
- **Max-width 480px** content wrapper
- **Colour tokens**: consistent `TEXT_M`, `TEXT_S`, `TEXT_L` throughout
- **No hero background** (functional drill-down page, matches Home/Plan pattern)
- **File**: `src/ui/activity-detail.ts`

## 2026-04-10 — Science audit #8: LT multiplier matrix tier-aware marathon

- **Marathon LT multipliers** now vary by athlete tier (was single row for all athletes)
- Elite/performance: 1.04-1.08, trained: 1.06-1.10, recreational: 1.08-1.12, beginner: 1.09-1.14
- 5K/10K/HM multipliers unchanged (stable across fitness levels)
- Rationale: research shows marathon pace = 104-114% of LT pace, with fitter athletes at the low end
- Optional `athleteTier` param added to `predictFromLT` and `blendPredictions`
- All 23 prediction tests passing

## 2026-04-10 — Science audit #6: ACWR tier thresholds compressed

- **ACWR safe upper bounds** compressed from 1.2-1.6 to 1.3-1.5 range
- Beginner 1.30, recreational 1.35, trained 1.40, performance 1.45, high_volume 1.50
- Rationale: no published per-tier ACWR thresholds exist; old range overstated the evidence. New range stays within Gabbett's 0.8-1.3 sweet spot (beginners) to the 1.5 danger threshold (elite)
- Lolli et al. 2019 limitation documented: absolute ACWR thresholds may be ratio coupling artifacts
- All 33 readiness tests passing

## 2026-04-10 — UI overhaul: Load & Taper detail page + breakdown integration

- **Weekly Load Breakdown sheet eliminated** — content (sport rows, stacked bar, carry, target footer) integrated directly into the Load & Taper page as the first card after the ring
- **Home TSS row** and **Plan load bar** now navigate to Load & Taper page instead of opening the sheet overlay
- **Warm earth hero background** with rolling plains SVG landscape, matching the per-page theme system
- **Progress ring** showing weekly TSS completion (amber gradient, green at 100%, grey when low)
- **Phase badge pill** centered below ring (Base/Build/Peak/Taper with phase colour)
- **Card system aligned** to design system: 16px radius, dual shadow, no borders
- **Entrance animations** with staggered floatUp per card
- **Tab bar** added (Home highlighted)
- **Max-width 480px** content wrapper
- **Copy cleanup**: removed em dashes, replaced with periods/commas per UI copy rules
- **Removed ALL-CAPS** from section headers inside cards (kept only for the "Plan structure" label above the phase cards)
- **File**: `src/ui/load-taper-view.ts`

## 2026-04-10 — Readiness: tier-aware safety, new labels, recalibrated floors

- **Tier-aware safety sub-score** — ACWR-to-score mapping now anchored to athlete's personal `safeUpper` (was fixed at 2.0 ceiling). Same ACWR gives different scores for different tiers: ACWR 1.35 = comfortable for elite (safeUpper 1.6), concerning for beginner (safeUpper 1.2).
- **New labels** — "Ready to Push" renamed to "Primed" (aligns with Garmin's "Prime" terminology). Thresholds recalibrated for non-linear curves: Primed >= 75, On Track >= 55, Manage Load >= 35, Ease Back < 35.
- **Dark green for Primed** — new CSS variable `--c-ok-strong` (#15803D) distinguishes Primed from On Track visually.
- **Hard floors recalibrated** — all caps shifted to match new label boundaries (54 = top of Manage Load, 34 = top of Ease Back, 74 = below Primed). Recovery floor base lowered from 40 to 35.
- **Files**: `src/calculations/readiness.ts`, `src/ui/coach-modal.ts`, `src/ui/strain-view.ts`, `src/calculations/daily-coach.ts`, `src/calculations/fitness-model.ts`, `src/styles.css`

## 2026-04-10 — Fix: Readiness page freshness now uses live intra-week TSB

- **Bug**: Readiness page showed end-of-last-completed-week TSB (e.g. -22), while Freshness detail page applied intra-week daily ATL/CTL decay to show live value (e.g. -13). The two pages disagreed.
- **Fix**: Readiness page now applies the same intra-week decay logic (daily ATL/CTL step with current-week load), so both pages show the same live freshness.
- **File**: `src/ui/readiness-view.ts`

## 2026-04-10 — Strain system cleanup: plan-based targets, readiness passthrough, overreach threshold

- **perSessionAvg** now derived from current week's planned TSS (not CTL baseline). Tracks plan intent: build phases prescribe higher targets, taper phases lower ones. Changed in `home-view.ts`, `strain-view.ts`, `readiness-view.ts`, `daily-coach.ts`.
- **Readiness label** now passed through from home/readiness views to strain detail page. Target modulation and marker colour (amber/red) now work correctly for today. Past days still show unmodulated targets.
- **Rest-day overreach threshold** changed from 50% to 33% of per-session average. Constant `REST_DAY_OVERREACH_RATIO` (0.33) centralised in `fitness-model.ts`, replaces 4 hardcoded `* 0.5` sites. Aligned with Whoop's ~33% recovery-day cap and Seiler's polarised model.
- **COUPLING tag** added to passive TSS excess calculation in `strain-view.ts` to flag tight dependency on `computeTodaySignalBTSS`.
- **Home strain ring** "not started" state now shows em dash instead of target range (target communicated visually by dashes on ring arc).

## 2026-04-10 — Readiness sub-scores: non-linear power curves

- **Fitness sub-score** now uses power curve (exponent 1.2) instead of linear mapping. TSB daily 0 = 39% (was 45%), TSB -10 = 21% (was 27%). Mild non-linearity — fatigued end drops faster while fresh end stays comfortable.
- **Safety sub-score** now uses power curve (exponent 1.6). ACWR 1.3 = 42% (was 58%), ACWR 1.5 = 25% (was 42%). Strong non-linearity reflecting Gabbett's finding that injury risk accelerates exponentially above the safe zone.
- **Weights unchanged** at 35/30/35. The dynamism comes from the curved sub-scores, not shifting weights. Hard floors remain as a safety net.
- **Files**: `src/calculations/readiness.ts`

## 2026-04-10 — Fix: stale pending activities disappearing from log

- **Bug**: Non-run activities (skiing, HIIT, etc.) queued as `__pending__` in the current week would become invisible if the week advanced before the user reviewed them. `globalProcessed` prevented reprocessing, `processPendingCrossTraining` only checks the current week, and the pending banner only renders for the current week.
- **Fix**: `matchAndAutoComplete` now scans past weeks for stale `__pending__` items on every sync and auto-resolves them as adhoc workouts with garminActuals entries, so they appear in the activity log and count toward load.
- **Fix**: Activity log duplicates + wrong badges. `addAdhocWorkoutFromPending` creates both `adhocWorkouts` and `garminActuals` entries with the same `garmin-*` key. The log rendered both (once "Matched", once "Excess"). Now: if a `garmin-*` key has a matching adhocWorkout, only the adhoc loop renders it (correct badge). If the adhoc was removed via ×, the garminActuals loop renders it as Logged/Excess (not "Matched"). Same dedup applied to Home RECENT list. Load counting in `fitness-model.ts` was already deduped via `seenGarminIds`.
- **Files**: `src/calculations/activity-matcher.ts`, `src/ui/plan-view.ts`, `src/ui/home-view.ts`

## 2026-04-10 — Leg load decay: 3-layer model

- **Base half-life raised from 36h to 48h** — better matches EIMD functional recovery window (72-96h, Clarkson & Hubal 2002). 48h is the DOMS peak midpoint.
- **Sport-specific scaling** — half-life multiplied by `recoveryMult` from SPORTS_DB. Swimming (0.90) = 43h, cycling (0.95) = 46h, rugby (1.30) = 62h. Higher-impact sports take longer to clear.
- **Re-loading penalty** — exercising on fatigued legs extends the half-life by 1.3x per subsequent session within 72h (capped at 3 reloads = 2.2x max). A hike Monday + run Tuesday pushes the hike's effective half-life from 46h to 60h, keeping the warning active through Wednesday. Models the principle that eccentric exercise on damaged fibres delays recovery.
- **Files**: `src/calculations/readiness.ts`

## 2026-04-09 — Sleep debt half-life: 4 days to 7 days

- **DEBT_DECAY changed** from `exp(-ln(2)/4)` (4-day half-life) to `exp(-ln(2)/7)` (7-day half-life). Debt now clears more slowly: a 2-hour deficit takes ~7 days of full sleep to halve, not 4.
- **Rationale**: 4-day was borrowed from ATL Banister model, not sleep science. Banks & Dinges (2007) and Belenky et al. (2003) show performance deficits from chronic restriction persist well beyond 3-4 days of recovery. Oura uses 14-day lookback, WHOOP states debt "follows you for days." 7-day half-life means 2-week-old debt is at 25%, aligning with industry 14-day windows.
- **Files**: `src/calculations/sleep-insights.ts`

## 2026-04-09 — Recovery score: RHR as SD-based override, not weighted input

- **RHR removed from weighted composite** — recovery score now `HRV * 0.55 + Sleep * 0.45` (was HRV 0.45 + Sleep 0.35 + RHR 0.20). RHR is a high-specificity, low-sensitivity signal (Buchheit 2014) that adds noise when weighted continuously but has strong diagnostic value when genuinely elevated.
- **Graduated RHR hard floor** — when 7d avg RHR is elevated above 28-day baseline by >= 2 SD, recovery score is capped: 2.0-2.5 SD -> cap 55, 2.5-3.0 SD -> cap 40, >= 3.0 SD -> cap 25. Uses personal SD (not absolute bpm) to handle inter-individual variation (e.g. athlete with 41-48 bpm normal range has SD ~2.5, so 2 SD trigger = ~49 bpm).
- **rhrOverride field** added to `RecoveryScoreResult` — contains `deviationSD` and `cap` when override is active, so UI and coach narrative can explain why the score is capped.
- **Coach narrative updated** — system prompt now describes the new model.
- **Files**: `src/calculations/readiness.ts`, `supabase/functions/coach-narrative/index.ts`

## 2026-04-09 — Strain target + passive strain + ring redesign

- **Strain ring redesign** — ring now shows absolute TSS with auto-scaling (`ringMax = max(2 × target, actual × 1.25)`) instead of percentage fill. White target marker dot on the ring arc at the target position. Marker turns amber on Manage Load, red on Ease Back/Overreaching. Inner content shows actual TSS number + "Target X TSS" label.
- **Readiness-modulated daily target** — new `computeDayTargetTSS()` function. Training days: 100% of planned TSS. Ease Back: 80%. Overreaching: 75%. Rest days: 30% of per-session average. Adhoc days: per-session average.
- **Passive strain from steps** — new `computePassiveTSS()` takes two signals (steps + active minutes), uses the higher. Subtracts logged workout steps (170 spm running, 110 spm walking) and duration to prevent double-counting. 1 TSS per 1,000 passive steps.
- **Personal TSS calibration** — `calibrateTssPerActiveMinute()` computes median TSS/min from 5+ logged activities. Stored as `s.tssPerActiveMinute`. Called on startup.
- **Apple Watch exercise minutes** — syncs `appleExerciseTime` (Exercise ring) via HealthKit, stored as `activeMinutes` in physiologyHistory. Same field Garmin epoch data uses.
- **Steps card on strain page** — replaces the placeholder with actual step count from physiologyHistory + passive TSS attribution.
- **Files**: `src/calculations/fitness-model.ts`, `src/ui/strain-view.ts`, `src/data/appleHealthSync.ts`, `src/main.ts`, `src/types/state.ts`

---

## 2026-04-09 — Session generator (general purpose)

- **Generate session on plan view** — new "Generate session" button below workout cards (current week only). Two-step modal: pick session type (Easy, Long, Threshold, VO2 Intervals, Marathon Pace, Progressive) then set distance or time via slider. Generates structured workouts via `intentToWorkout` with warm-up/cool-down, paces from VDOT, and interval structure. Replaces the holiday-only session chooser.
- **Holiday "Generate session" now uses the same modal** — available on all holiday modes including "no running planned".
- **Holiday mods skip user-generated sessions** — `applyHolidayMods` no longer converts `holiday-*` sessions back to rest/optional. Sessions the user deliberately created are preserved.
- **One generated session per day per type** — generating on a day that already has a holiday-generated session replaces it instead of stacking duplicates.
- **Adhoc sessions skipped in TSS** — `adhoc-*` prefixed sessions (like `holiday-*`) are suggestions, not completed activity. Excluded from `computeWeekRawTSS`, `computeTodaySignalBTSS`, and `getDailyLoadHistory`.
- **Files**: `src/ui/session-generator.ts` (new), `src/ui/plan-view.ts`, `src/ui/holiday-modal.ts`, `src/calculations/fitness-model.ts`, `src/ui/home-view.ts`

## 2026-04-09 — Stacked session recovery ("To Baseline") + freshness label clarity

- **Session recovery now stacks** all recent sessions (current week + last 3 days of previous week) instead of only counting the last workout. Walk-forward model: each session adds `8 × TSS / ctlDaily × recoveryMult × recoveryAdj` hours to a running total, with elapsed time ticking down between sessions. Matches Garmin/Firstbeat stacking behaviour.
- **Readiness pill linked** to the same stacked baseline number (was a separate TSB-to-minus-3 calculation that produced a confusingly similar but different number).
- **Freshness page ring labels** renamed: "Recovery"/"Last session" to "To Baseline"/"Session fatigue", "Full Fresh"/"Fatigue clearance" to "Fully Clear"/"All fatigue".
- **Status headline** now distinguishes "At Baseline" (session fatigue cleared, accumulated load still elevated) from "Fully Fresh" (TSB non-negative). Fixes confusing "Recovered" label when TSB is deeply negative.
- **Shared `computeToBaseline()`** extracted to `fitness-model.ts` so both readiness and freshness views use identical logic.
- **Files**: `src/calculations/fitness-model.ts`, `src/ui/freshness-view.ts`, `src/ui/readiness-view.ts`

## 2026-04-09 — Coach narrative: scientific context + missing signals

- **System prompt now explains every signal** the LLM receives: how readiness is a weighted composite with hard floors, that TSB is weekly (divide by 7 for daily-equivalent), that ACWR safe thresholds are tier-dependent, that HRV is z-scored against a 28-day personal baseline (not absolute), sleep bank semantics, CTL trend meaning, and week TSS interpretation.
- **Two new rules** added: always divide TSB by 7 before judging freshness; consider athlete tier when interpreting ACWR.
- **Three new signals** wired through to the LLM: `athleteTier` (so it can interpret ACWR thresholds correctly), `recoveryScore` (composite HRV/sleep/RHR score), and `acwrSafeUpper` (the tier-specific safe threshold, shown inline with the ACWR value).
- **Files**: `supabase/functions/coach-narrative/index.ts`, `src/calculations/daily-coach.ts`

## 2026-04-09 — SCIENCE_LOG.md comprehensive backfill

- **Backfilled ~30 entries** covering every calculation, model, and formula in the codebase. Previously had 7 entries (recovery countdown, TSB clearance, intra-week decay, CTL/ATL EMA, iTRIMP normalisation, readiness score, recovery score). Now covers: iTRIMP calculation, VDOT (Daniels), pace zones, fatigue exponent, HR zones, effort scoring, efficiency shift detection, LT estimation, stream processing, athlete normalizer, ACWR, rolling load, same-signal TSB, passive strain, universal load currency (all 4 tiers), saturation curve, goal-distance adjustment, SPORTS_DB constants, RPE load/split, leg load decay, workout load profiles, race prediction blending, LT multiplier matrix, training horizon (VDOT gain), skip penalty, expected physiology trajectory, sleep debt model, sleep insights, activity matching, plan engine phases, session budgets, quality session management, workout importance, variant rotation, Signal A vs B.
- **Files**: `docs/SCIENCE_LOG.md`

## 2026-04-09 — Holiday mode audit fixes

- **Bridge mods survive restart** — `main.ts` cleanup was wiping `_holidayBridgeScale`, `weekAdjustmentReason`, and `__holiday_bridge__` workoutMods on every launch, making post-holiday bridge weeks a single-session illusion. Cleanup now only removes during-holiday artifacts (adhoc sessions, forceDeload), preserving deliberate post-holiday plan adjustments.
- **forceDeload cleanup on all end paths** — Extracted `clearForceDeloadFlags()` helper. Short-holiday cancel, long-holiday manual end, and auto-detection on launch all now clean forceDeload flags from holiday weeks. Previously only `cancelScheduledHoliday` did this.
- **Unit-aware session chooser** — Holiday session chooser labels now use `formatKm()` and `formatPace()` instead of hardcoded `km` and `/km`. Workout descriptions use internal `Nkm` format (converted by `fmtDesc` at render time).
- **Pre-holiday shift range** — Fixed off-by-one: quality sessions 2 days before holiday start are now eligible for shifting (was only 1 day before).
- **parseKmFromDesc sums structured descriptions** — For descriptions like `1km warm up + 8km threshold + 1km cool down`, now returns 10km total instead of 1km (the first match). Prevents bridge scaling from producing 0.7km workouts.
- **Replaced `window.location.reload()` with re-renders** — all four reload paths now use dynamic `import('./plan-view')` or caller-supplied `onComplete` callback. Home-view callers pass `renderHomeView`, plan-view callers get `renderPlanView` by default.
- **`generateWorkoutsForWeek` helper** — extracted the 12-parameter `generateWeekWorkouts` call into a single helper. Reduces fragility if the generator signature changes.
- **Test coverage** — 27 tests in `src/ui/holiday-modal.test.ts` covering parseKmFromDesc, isWeekInHoliday, getHolidayDaysForWeek, applyHolidayMods, applyBridgeMods_renderTime.
- **Files**: `src/ui/holiday-modal.ts`, `src/main.ts`, `src/ui/plan-view.ts`, `src/ui/home-view.ts`

## 2026-04-09 — Holiday TSS leak fix + session-based recovery countdown + full fresh

- **Holiday TSS leak fix** — `computeTodaySignalBTSS` and `getDailyLoadHistory` were missing the `holiday-` prefix filter on adhoc workouts. Holiday-generated suggestion sessions (which are not real activity) were counted toward daily strain TSS, inflating the Strain page number. Added `if (w.id?.startsWith('holiday-')) continue;` to both functions, matching the existing filter in `computeWeekRawTSS`.
- **Files**: `src/calculations/fitness-model.ts`

## 2026-04-09 — Session-based recovery countdown + full fresh

- **Recovery ring** — replaced the old TSB-clearance countdown (which used the 7-day ATL time constant and always showed multi-day estimates) with a session-based recovery model: `recoveryHours = 8 × lastSessionTSS / ctlDaily × recoveryMult × recoveryAdj`, minus hours already elapsed since the session. Scales linearly with load relative to fitness, matching EPOC-based models (Garmin/Firstbeat) across the full intensity range (easy ~6h, moderate ~12h, race ~54h).
- **Sport-specific recovery** — uses weighted-average `recoveryMult` from SPORTS_DB for the last session's activities (e.g. swimming 0.9, cycling 0.95, rugby 1.3). Weights by each activity's iTRIMP contribution.
- **Recovery score adjustment** — when physiology data is available (sleep, HRV, RHR), adjusts recovery time by up to ±30%. Poor recovery (score 20) slows recovery 1.3×; good recovery (score 80) speeds it 0.8×.
- **Dynamic ring colours** — both rings transition from red (high remaining) through amber to green (near recovered) based on progress percentage.
- **Full Fresh ring** — hours until TSB reaches 0 (ATL decays to CTL). Useful for taper planning, not single-session recovery.
- **Intra-week ATL decay** — ATL/CTL now updated day-by-day within the current week using daily EMA steps, fixing the issue where week-boundary-only updates ignored rest days. DST-safe date arithmetic (noon anchoring, `setDate` instead of ms offsets).
- **Files**: `src/ui/freshness-view.ts`

## 2026-04-08 — Start Workout button on plan view workout cards

- **Start Workout as primary CTA** — Running workout cards in the expanded detail now show a "Start Workout" button (play icon + blue primary style) that launches GPS tracking via `window.trackWorkout()`. "Mark as Done" and "Skip" demoted to inline text links below.
- **Header Start button expanded** — The compact Start button on the card header now appears for all current-week running workouts (was today-only). Also now correctly passes workout name/desc to the tracker (was launching empty).
- **Gym/cross-training unchanged** — Non-running workouts keep "Mark Done" as primary since GPS tracking doesn't apply.
- **Files**: `src/ui/plan-view.ts`

## 2026-04-08 — Manual sleep input for no-watch users + greyed recovery rings

- **Manual sleep card** — Users without a connected watch see a "How did you sleep last night?" card on the home view with four one-tap options: Great (90), Good (70), Poor (45), Terrible (25). Saves to `recoveryHistory` with `source: 'manual'`. Card collapses to a "Sleep logged" confirmation after entry. Reappears next day.
- **Greyed recovery rings** — Sleep and Physiology rings on home view show at 35% opacity with "Log below" / "Connect watch" text when no physiology source is connected and no data exists. After manual entry, rings fill in with the logged score.
- **Condition**: Only triggers when `getPhysiologySource(s) === undefined` (no watch connected at all). Apple Watch and Garmin users are unaffected.
- **Files**: `src/ui/home-view.ts`

## 2026-04-08 — Fix: adhoc cross-training activities missing HR zone data

- **Fix: adhoc cross-training missing HR zones** — Activities stored only as `adhocWorkouts` (past-week cross-training, user-reviewed pending items) had no `garminActuals` entry, so HR zone data from Strava was lost. The 4-Week Load Focus card misattributed these to Low Aerobic. Fix: both `addAdhocWorkout` (past weeks) and `addAdhocWorkoutFromPending` (current week) now also create a `garminActuals` entry with `avgHR`, `hrZones`, `iTrimp`. The enrich loop also backfills missing entries for existing state.
- **Files**: `activity-matcher.ts`, `fitness-model.ts`

---

## 2026-04-08 — Holiday mode

- **New: Holiday mode** — Full holiday management via check-in overlay. Multi-step questionnaire (dates, running plans, holiday type), pre-holiday quality session shifting, render-time workout replacement during holiday, "Generate session" button for ad-hoc easy runs, blue banner on Home + Plan views, post-holiday welcome-back modal with TSS analysis and bridge week generation, taper overlap warning, VDOT detraining on return, multiple holiday support via `holidayHistory`.
- **Files**: `holiday-modal.ts` (new), `checkin-overlay.ts`, `plan-view.ts`, `home-view.ts`, `main.ts`, `welcome-back.ts`, `state.ts`, `FEATURES.md`

---

## 2026-04-08 — Apple Watch full physiology sync + wearable source abstraction

- **New: `syncAppleHealthPhysiology()`** — Reads sleep stages (deep/REM/light/awake), HRV (SDNN), resting HR, and steps from HealthKit via `@capgo/capacitor-health` `readSamples()`. Converts to `PhysiologyDayEntry[]` and stores in `s.physiologyHistory`, same shape as the Garmin pipeline. Apple Watch users now get sleep insights, readiness scores, and recovery data.
- **New: `connectedSources` state field** — Separates activity source (Strava, Garmin, Apple, phone) from physiology source (Garmin, Apple, Whoop, Oura). Legacy `s.wearable` field preserved for backwards compatibility. New accessor functions in `src/data/sources.ts`: `getActivitySource()`, `getPhysiologySource()`, `hasPhysiologySource()`, `getSyncLabel()`.
- **Fix: Apple Watch launch sync** — Previously only called `syncAppleHealth()` (activities). Now also calls `syncAppleHealthPhysiology(28)` + re-renders home view + resets normalizer. Strava+Apple Watch users get Strava for activities and HealthKit for physiology.
- **Fix: "Sync Now" button** — Apple Watch sync now includes physiology. Success message updated from "check your plan for updated activities" to "activities, sleep, and recovery updated."
- **Fix: main-view sync** — Sync button now triggers Apple physiology sync when physiology source is Apple (previously only Garmin).
- **Fix: misleading empty states** — Recovery cards in home-view and stats-view no longer say "Connect a Garmin" when an Apple Watch is already connected. Shows "No recovery data yet" with context-appropriate sync instructions.
- **Sleep score from HealthKit** — HealthKit has no native sleep score. Computed from stage breakdown: duration vs 7h target (55%), deep sleep proportion vs 17.5% ideal (25%), REM proportion vs 22.5% ideal (20%). Scale 0-100 matching Garmin range.
- **HRV SDNN→RMSSD conversion** — Apple Watch reports HRV as SDNN; our model (readiness, `rmssdToHrvStatus()`) expects RMSSD. Applied conversion factor of 1.28 (Shaffer & Ginsberg 2017, nocturnal short-term recordings, range 1.2-1.4). Ensures Apple Watch HRV values land in the same absolute range as Garmin RMSSD so thresholds and trend scoring work correctly.
- **Nap filtering** — Sleep samples ending after noon are excluded to prevent daytime naps inflating the night's sleep total.
- **Single HealthKit auth prompt** — Combined all data type requests (workouts + sleep + HRV + RHR + steps) into one `ensureAuthorization()` call, cached per session.
- **Permission check** — `checkAuthorization()` called before reading; logs denied types so we can distinguish "no data" from "permission revoked".
- **Files**: `appleHealthSync.ts`, `sources.ts` (new), `state.ts`, `main.ts`, `main-view.ts`, `account-view.ts`, `home-view.ts`, `stats-view.ts`, `wizard/steps/fitness.ts`

## 2026-04-08 — Readiness ACWR floor now tier-aware

- **Fix: mixed messages on load ratio** — The readiness hard floor used hardcoded ACWR thresholds (1.3/1.5) while the Load Ratio card used tier-adjusted thresholds from `TIER_ACWR_CONFIG`. A performance-tier athlete at 1.46× saw "Optimal" on the card but a red "primary constraint" banner from readiness. Now both use the same `safeUpper` / `safeUpper + 0.2` thresholds from the athlete's tier config.
- **Files**: `readiness.ts` (new `acwrSafeUpper` input field, tier-aware floor logic), `readiness-view.ts`, `daily-coach.ts`, `home-view.ts`, `stats-view.ts` (all thread `acwr.safeUpper` through)

## 2026-04-07 — Float workouts for half-marathon and marathon plans

- **New workout type: `float`** — Float fartlek and float long run sessions added to the plan engine. Hard reps at 10K effort with moderate "float" recovery at marathon pace instead of jogging. Trains lactate clearance under sustained load (Brooks 2009, Canova special block approach).
- **Eligibility**: Half-marathon and marathon distances, build and peak phases, intermediate+ ability. Endurance runners get higher priority (1.15x bias), speed runners lower (0.90x). Hybrid athletes qualify at intermediate level.
- **Four rotating variants**: 6x3/2, 5x4/2, 8x2/2, 4x5/3 (reps x hard min / float min). Balanced and endurance marathon runners also get a float long run variant (alternating 3km MP / 2km float).
- **Load profile**: 65% aerobic / 35% anaerobic, zone split 20% base / 50% threshold / 30% intensity. RPE 7. HR target Z3 to Z4.
- **Files**: `plan_engine.ts`, `intent_to_workout.ts`, `constants/workouts.ts`, `rules_engine.ts`, `load.ts`, `heart-rate.ts`

## 2026-04-07 — Rolling Load page: zone charts + chart fix

- **`src/ui/rolling-load-view.ts`** — Fixed 28-day line chart: increased height (120→150px), gradient fill, grid lines, fewer date labels, baseline label on right. Added two new zone chart sections:
  - **Exercise Load** (Garmin photo 5): 7-day stacked vertical bars, each day split into anaerobic (pink), high aerobic (orange), low aerobic (cyan). Y-axis scale, legend.
  - **4-Week Load Focus** (Garmin photos 1 & 7): 3 horizontal bars showing 28-day zone totals with dashed target range overlays. Diagnosis headline ("High Aer. Shortage" / "Balanced" etc.). Load-weighted zone split (TSS proportional to time in zone, not just time).
- **`src/calculations/fitness-model.ts`** — Extended `DailyLoadEntry` with `zoneLoad` (lowAerobic/highAerobic/anaerobic) and per-activity `hrZones`. `getDailyLoadHistory()` now computes load-weighted zone breakdown per day from activity HR zone data.

## 2026-04-07 — Rolling Load drill-down page

- **`src/ui/rolling-load-view.ts`** (new) — Full detail page for 7-day rolling load. 28-day sharp angular line chart (no bezier smoothing), dashed baseline at 28-day average, open circle on today. Below the chart: activity breakdown for the last 7 days with name, duration, and TSS.
- **`src/calculations/fitness-model.ts`** — New `getDailyLoadHistory()` returns 28 daily entries with per-day activity breakdown (garminActuals + adhocWorkouts).
- **`src/ui/readiness-view.ts`** — Removed explanation text from Rolling Load card. Card now taps through to the new detail page.

## 2026-04-07 — Fix: step sync was nuking HRV and Resting HR from DB

- **`supabase/functions/sync-today-steps/index.ts`** — **Data loss bug.** The upsert wrote only step columns, which caused Supabase to null out `resting_hr` and `hrv_rmssd` on the same row. Fixed: uses `update` (step columns only) with insert fallback, so webhook-written HRV/RHR data is preserved.
- **`src/ui/recovery-view.ts`** — HRV and RHR now fall back to the most recent entry with data when today's entry lacks them (e.g. before Garmin's morning sync). Sleep does NOT fall back — it's date-specific.

## 2026-04-07 — Display VO2 Max instead of VDOT

- **`src/ui/stats-view.ts`** — Fitness card, aerobic capacity bar, fitness detail chart, and metric page now show device VO2 Max (from Garmin/Strava) as the primary number. Falls back to computed VDOT labelled "(est.)" when no device data exists. Values shown as whole numbers (rounded). VDOT remains in the engine for pace calculations.
- **`src/ui/main-view.ts`** — Continuous mode fitness grid: merged VDOT + VO2 Max cells into a single "VO2 Max" cell (device value preferred, VDOT fallback).

## 2026-04-07 — Fix: max HR outlier poisoning all iTRIMP/TSS calculations

- **`supabase/functions/sync-strava-activities/index.ts`** — Both standalone and backfill modes used the all-time highest `max_hr` from any activity. A single wrist-sensor spike (e.g. 216 bpm) anchored the HRR denominator, compressing all iTRIMP values by ~34%. Fixed: now takes the **median of the top 5** activity max HRs. Should shift from 216 to ~191, increasing TSS across all activities.
- **`supabase/functions/sync-physiology-snapshot/index.ts`** — Same fix: top-5 median instead of all-time peak for the `maxHR` returned to the client.
- **Impact**: ACWR ratios unaffected (both sides scale equally). Absolute TSS numbers will be ~30-50% higher after recalibration, closer to Garmin.

## 2026-04-07 — Readiness: 7-day rolling load card

- **`src/ui/readiness-view.ts`** — Added "7-Day Rolling Load" card below Physiology on readiness detail. Shows total Signal B TSS from last 7 days, labelled High/Normal/Low relative to 28-day average. Does not affect readiness score, provides context.

## 2026-04-07 — Overreaching: rename Injury Risk to Load Ratio, add driving factor callout, hours countdown

- **`src/calculations/readiness.ts`** — Added `'Overreaching'` label when ACWR > 1.5 hard floor is active (was generic "Ease Back"). Added `hardFloor` field to `ReadinessResult` tracking which safety floor is constraining the score.
- **`src/ui/readiness-view.ts`** — Renamed "Injury Risk" card to "Load Ratio". Labels changed: Safe→Optimal, Elevated→High, High Risk→Very High. Card now shows acute/chronic TSS numbers (e.g. "7d: 320 TSS / 28d avg: 195 TSS"). Added red driving factor callout below ring when ACWR is the constraint. Fatigue decay shows hours when < 72h (e.g. "~43h") as a styled pill instead of plain "~2 days" text.
- **`src/ui/injury-risk-view.ts`** — Header renamed to "Load Ratio". Zone reference labels updated to match (Low, Optimal, High, Very High).
- **`src/ui/home-view.ts`** — Pill sheet title renamed from "Load Safety (Injury Risk)" to "Load Ratio".
- **`src/ui/stats-view.ts`** — Stats card label renamed from "Injury Risk" to "Load Ratio".
- **`src/ui/freshness-view.ts`** — Replaced plain "Fatigue clears in ~2 days" text with a countdown circle (hours when < 72h, days otherwise). Circle drains as recovery progresses. Added recovery status detection: "Recovering as Expected" when resting, "Recovery Paused" when session logged today, "Recovery Delayed" when yesterday's session added significant load.
- **`src/ui/injury-risk-view.ts`** — Zone labels updated throughout: Low Load→Low, Safe→Optimal, Elevated→High, High Risk→Very High. Ring gradient colours aligned to new labels. Coaching text updated.
- **`src/ui/home-view.ts`** — Safety label in pill sheet updated: Safe→Optimal, Elevated→High, High Risk→Very High.

## 2026-04-07 — Fix: timing suggestion "hard session yesterday" triggered by wrong day + tier recalibration

- **`src/cross-training/timing-check.ts`** — `dayOfWeekFromISO` returned the raw calendar diff from the plan's week start date, but the scheduler always uses 0=Monday. If `planStartDate` was not a Monday, activity days were misaligned with workout days (e.g. Monday's Alpine Skiing mapped to Tuesday's index), causing false "hard session yesterday" suggestions. Fixed by remapping the diff to the scheduler's 0=Monday convention.
- **`src/cross-training/timing-check.ts`** — Raised `SIGNAL_B_TRIGGER` from 30 to 50 TSS. 30 TSS caught light sessions (brisk walks, short easy bikes) that don't meaningfully impair next-day quality. Recalibrated tiers: 50 to 74 = 1 step down, no distance cut; 75 to 99 = 1 step + 10% shorter; 100 to 124 = 2 steps + 15%; 125+ = 2 steps + 25%. Two-step downgrades now only trigger at genuinely hard sessions (100+).
- **`src/cross-training/timing-check.ts`** — Timing check now carries over Sunday TSS from the previous week. A heavy Sunday session now correctly triggers a suggestion on Monday's quality workout.

## 2026-04-07 — Remove: load status pill from home weekly summary

- **`src/ui/home-view.ts`** — Removed the ACWR-based status pill (Load Balanced / Load Rising / Load Spike / Load Building) from the "This Week" card. The default "Load Balanced" state added visual noise without actionable info. Load details live on the strain/recovery pages.

## 2026-04-07 — Coach commentary: trained/untrained + heavy/light branching, single source of truth

- **`src/calculations/daily-coach.ts`** — Every tier in `derivePrimaryMessage` now branches on `trained` (session already logged) and `sessionHeavy` (actual TSS > 1.2x daily CTL). When trained + light: acknowledges ("Light session was the right call"). When trained + heavy on poor signals: flags it ("Hard session on poor recovery blunts adaptation"). When not yet trained: forward-looking advice as before. Added `actualTSS` to `StrainContext`. ACWR messages use natural phrasing ("Training load spiking (1.64x)") instead of jargon.
- **`src/calculations/daily-coach.ts`** — Added `deriveStrainContext(s)`: auto-computes strain context from state when none is passed. Coach-modal and readiness-view now get correct trained/heavy signals without manually building `StrainContext`.
- **`src/ui/coach-modal.ts`** — Fallback narrative now uses `coach.primaryMessage` instead of `readiness.sentence`.
- **`src/ui/readiness-view.ts`** — Removed hardcoded sentence overrides (4 branches duplicating home-view logic). Now uses `computeDailyCoach(s).primaryMessage` as single source of truth.
- **`src/ui/home-view.ts`** — Passes `todaySignalBTSS` as `actualTSS` in `StrainContext`.
- **`src/ui/home-view.ts`** — Populates `actualActivityLabel` from today's garminActuals `displayName` or adhoc workout name.

## 2026-04-07 — Fix: timing suggestion "hard session yesterday" triggered by wrong day

- **`src/cross-training/timing-check.ts`** — `dayOfWeekFromISO` returned the raw calendar diff from the plan's week start date, but the scheduler always uses 0=Monday. If `planStartDate` was not a Monday, activity days were misaligned with workout days (e.g. Monday's Alpine Skiing mapped to Tuesday's index), causing false "hard session yesterday" suggestions. Fixed by remapping the diff to the scheduler's 0=Monday convention.

## 2026-04-07 — Fix: readiness strain card shows "0% No Activity" for adhoc sessions

- **`src/ui/readiness-view.ts`** — When a matched activity existed on a day with no planned workout, `matchedActivityToday` made `isRestDay` false but `strainPct` was 0 (no plan to compare against), so the card showed "0% No Activity". Added `matchedActivityToday && !hasPlannedWorkout` branch mirroring home-view's adhoc logic: shows TSS value with Light/Moderate/Optimal/High label based on `adhocPct` (vs per-session average).

## 2026-04-07 — Unified primary message (replaces readiness sentence + HRV banner)

- **`src/calculations/daily-coach.ts`** — Added `primaryMessage` to `CoachState`. New `derivePrimaryMessage()` function uses full priority chain: injury/illness blockers, strain status, ACWR, combined sleep + HRV, sleep debt, recovery driving signal, recent cross-training, phase context, CTL trend, HRV elevation, and positive "go" conditions. Accepts `StrainContext` from the view layer.
- **`src/ui/home-view.ts`** — Replaced separate `readinessSentence` block + `buildDailyHeadline()` function with single `computeDailyCoach(s, strainCtx).primaryMessage`. Removed ~190 lines of duplicated signal computation. HRV banner card no longer renders as a separate section.

## 2026-04-07 — Freshness scoring overhaul + fatigue decay projection

- **`src/calculations/readiness.ts`** — Freshness sub-score formula widened: daily TSB -25 maps to 0 (was -6), daily -10 maps to ~27 (was 0). Prevents -1 and -25 from scoring identically. More granular differentiation across the fatigued range.
- **`src/ui/readiness-view.ts`** — Freshness commentary rewritten with 7 tiers (was 4). Copy now reflects actual severity: "Legs may feel heavy. Easy effort recommended" at -8, "Expect sore legs" at -15. Added fatigue decay projection line: "Fatigue clears in ~N days with easy training or rest" computed from ATL decay constant.
- **`src/ui/readiness-view.ts`** — Freshness zone labels updated: Fresh, Recovering (-3), Fatigued (-8), Heavy (-15), Overloaded (-25), Overreaching (<-25).
- **`src/ui/home-view.ts`** — Freshness zones and action copy updated to match readiness-view. Scale bar labels updated.
- **`src/calculations/readiness.test.ts`** — Test TSB inputs adjusted for new formula range. All 33 tests pass.

## 2026-04-07 — Injury Risk detail page

- **`src/ui/injury-risk-view.ts`** (new) — Injury Risk detail page following same design language as freshness/recovery views. Ring shows ACWR ratio + zone label. Cards: coaching text with acute/chronic TSS values, acute vs chronic horizontal gauges, 8-week ACWR bar chart with safe zone band, zone reference (tier-aware safe ceiling), "How It Works" card with science backing (Gabbett 2016, Blanch & Gabbett 2016, Hulin et al. 2014).
- **`src/ui/readiness-view.ts`** — Injury Risk card now navigates to the new injury-risk-view instead of strain-view.
- **`src/calculations/fitness-model.ts`** — Exported `computeRollingLoadRatio` for use by the injury risk detail page.

## 2026-04-07 — Strain model: zone-based display, per-session average, no "X/Y target"

- **All strain views** — Strain no longer displays as "44 / 103 target". Instead shows actual TSS + a zone label appropriate to the day type:
  - **Planned workout day**: zones relative to planned TSS (Below target / On target / Complete / Exceeded)
  - **Matched/adhoc activity day**: zones relative to per-session average, CTL / training days (Light / Moderate / Optimal / High)
  - **Rest day**: zone = good by default, overreaching if activity exceeds 50% of per-session avg
- Per-session average uses CTL divided by the number of training days in the week (not /7 which dilutes with rest days). With CTL=195 and 4 training days, per-session avg = 49 TSS.
- Rest-day overreach threshold = 50% of per-session avg (~24 TSS) instead of 33% of CTL/7 (which was 9 TSS, too sensitive).

## 2026-04-07 — Readiness card layout: hero ring + rename Recovery to Physiology

- **`src/ui/home-view.ts`** — Readiness ring is now the hero (140px, top centre). Sleep, Strain, and Physiology (renamed from Recovery) sit in a single row of three smaller rings (80px) below it. Clarifies that Readiness is the composite score and the others are contributing signals.
- "Recovery" label renamed to "Physiology" on the ring, pill, and pill sheet title to avoid confusion with Readiness.

---

## 2026-04-07 — Sleep target includes exercise load bonus

- **`src/ui/sleep-view.ts`** — "Tonight's target" now includes today's exercise load bonus on top of base + debt recovery. Displays as "+ N min from high exercise load" in the breakdown line. Load bonus was already factored into the debt calculation but was missing from the displayed target.

---

## 2026-04-07 — Intra-day step sync

- **`supabase/functions/sync-today-steps/index.ts`** — new edge function. Fetches today's Garmin epoch summaries (15-min windows), sums `steps`, upserts into `daily_metrics.steps`. Fast: single 24h window, called on launch and foreground resume.
- **`supabase/migrations/20260407_daily_metrics_steps.sql`** — adds `steps int` column to `daily_metrics`.
- **`supabase/functions/garmin-backfill/index.ts`** — now also captures `totalSteps` from dailies for historic step data.
- **`supabase/functions/sync-physiology-snapshot/index.ts`** — now selects and returns `steps` per day.
- **`src/types/state.ts`** — `PhysiologyDayEntry` gains `steps?: number`.
- **`src/data/physiologySync.ts`** — new `syncTodaySteps()` function. Updates today's entry in `s.physiologyHistory`. Steps threaded through the `syncPhysiologySnapshot` mapping.
- **`src/main.ts`** — `syncTodaySteps()` called on Garmin launch (both Strava+Garmin and Garmin-only paths). `visibilitychange` listener re-calls it on foreground resume, throttled to 5 min.
- **`src/ui/home-view.ts`** — strain ring now shows today's step count below the TSS number (display only — step→TSS conversion constant not yet confirmed).

---

## 2026-04-07 — Ad-hoc activities shown on Home hero card + wizard banner fix

- **TSB seed consistency fix** — Readiness view, home view, stats view, and daily coach all used `s.ctlBaseline` as the seed for `computeSameSignalTSB`, while the freshness detail page used `s.signalBBaseline ?? s.ctlBaseline`. This caused the freshness number to differ between the readiness card (-13) and the freshness detail page (-10). All 5 call sites now use the same seed: `s.signalBBaseline ?? s.ctlBaseline ?? 0`.

- **`src/ui/wizard/renderer.ts`** — Fixed onboarding banner ("holistic picture of you") staying stuck on screen after returning to plan from Edit Plan. The `position:fixed` banner and return button were appended to `document.body` but never removed when exiting the wizard. Both exit paths now clean them up.

- **`src/ui/home-view.ts`** — Hero card now shows completed ad-hoc/matched activities on rest days. When no planned workout exists for today, checks `garminActuals` and `adhocWorkouts` for activities with today's `YYYY-MM-DD` prefix on `startTime`/`garminTimestamp` (same pattern as readiness ring's `matchedActivityToday`). Shows activity name, duration, distance, and "Done · View" instead of "Rest Day".

## 2026-04-06 — Strain: matched-activity detection + CTL-based overreach threshold

- **`home-view.ts`, `strain-view.ts`, `readiness-view.ts`** — Restored matched-activity fallback: when `generateWeekWorkouts` produces zero workouts for today but `garminActuals` has a matched activity (e.g. skiing matched to General Sport slot), the day is correctly identified as a training day with the matched workout's planned TSS as target. Previously, removing the fallback caused matched days to show as rest days.
- **`home-view.ts`, `strain-view.ts`, `readiness-view.ts`** — Rest-day overreach threshold now uses chronic daily load (`ctlBaseline / 7`, 8-week EMA) instead of this week's `avgTrainingDayTSS` (4-day sample from one week). 33% of chronic daily load is a stable, individual-specific boundary.

## 2026-04-06 — Freshness detail page + readiness card navigation

- **`src/ui/freshness-view.ts`** (new) — Freshness detail page following recovery/strain design language. Sky-blue watercolour background, blue palette. Ring shows TSB value + zone label. Cards: coaching text, 8-week TSB bar chart with per-week values and commentary, fitness vs fatigue horizontal gauges (CTL/ATL with explanation), zone reference card.
- **`src/ui/readiness-view.ts`** — All four readiness cards now have "View detail" links. Freshness → freshness-view, Injury Risk → strain-view, Strain → strain-view, Recovery → recovery-view (existing).

## 2026-04-07 — Coach insight rewrite: derived insights for all run types

- **`src/calculations/workout-insight.ts`** — Full rewrite of insight engine. All run types now share: split-half pacing story (fade/negative/even with numbers), elevation gradient as HR context, TSS vs plan comparison, HR drift tied to pacing. Type-specific rules (quality pace adherence, easy HR) are concise and only fire when they add info not on screen. Effort mismatch (easy label, hard effort) suppresses "easy run" lecturing.
- **`src/ui/activity-detail.ts`** — Elevation gain shown in stats grid when available.
- **Edge function + pipeline** — `total_elevation_gain` from Strava stored in DB, wired through `GarminActivityRow` → `GarminActual` → workout insight.

## 2026-04-06 — Strain rest-day model overhaul + week index fix

- **`src/ui/strain-view.ts`** — Fixed week index mismatch: strain detail used `weekIdxForDate` which could disagree with `s.w - 1` (home view's authoritative index). Today's date now uses `s.w - 1`, fixing "Rest day" ring when activities exist and wrong TSS in week bars.
- **`src/ui/strain-view.ts`** — Rest-day strain no longer shows "below target". Two states only: good (default) or overreaching (>33% of avgTrainingDayTSS, per Whoop/Seiler/TrainingPeaks consensus). Ring stays empty unless overreaching.
- **`src/ui/strain-view.ts`** — Future days in "This week" bars no longer show predicted TSS numbers. Ghost tracks only, no labels.
- **`src/ui/home-view.ts`** — Matching rest-day strain model: ring shows "Active rest" (green) or "Overreaching" (warning) instead of computing strain % against avgTrainingDayTSS. Training-day strain unchanged (actual vs planned).

## 2026-04-06 — Rolling ACWR, TSB cliff-drop fix, wk1 dummy data cleanup

- **`src/calculations/fitness-model.ts`** — ACWR now uses a true rolling 7-day (acute) / 28-day (chronic) window over actual daily TSS via `computeRollingLoadRatio`. No weekly-bucket artifacts: a half marathon on Saturday is fully reflected on Sunday, and a partial week no longer cliff-drops the ratio. Pre-plan days filled with `signalBSeed / 7` as daily baseline. Falls back to weekly EMA when `planStartDate` is unavailable. Also fixed an off-by-one where `computeSameSignalTSB` used `currentWeek + 1`, inadvertently including the next plan week (0 actuals).
- **`src/ui/readiness-view.ts`** — TSB (Freshness) computed from completed weeks only (`s.w - 1`), avoiding partial-week "Fresh" artifacts. ACWR picks up the rolling approach automatically.
- **`src/main.ts`** — One-time cleanup: if wk1 rawTSS exceeds 800 (dummy test data), clears garminActuals/adhocWorkouts/unspentLoadItems so the EMA seed is the only baseline.

## 2026-04-06 — Review remembers slot assignments + carry-over card fix

- **`src/ui/activity-review.ts`** — `openActivityReReview` now saves previous `garminMatched` slot assignments to `_savedSlotAssignments` before undoing. `showMatchingEntryScreen` uses these to override auto-proposed pairings, so re-review opens with previous assignments intact instead of re-auto-matching. Cleaned up after apply or cancel.
- **`src/ui/plan-view.ts`** — Review button restored to call `openActivityReReview` when all items are processed. Previous attempt blocked re-review entirely; now re-review works but remembers assignments.
- **`src/ui/plan-view.ts`** — Carry-over card ("Unresolved load from last week") now filters unspentLoadItems by date, only showing items whose date falls before the current week's start. Current-week excess items no longer trigger the carry-over card.

## 2026-04-06 — Make excess/logged activities clickable in activity log

- **`src/ui/plan-view.ts`** — Adhoc activities (tagged "Excess" or "Logged") in the plan view activity log were not clickable. Added `plan-adhoc-open` click handler that builds a `fakeActual` from the adhoc workout data and opens the activity detail view, matching the existing behaviour for matched activities. Added chevron arrow indicator.

## 2026-04-06 — Fix readiness score mismatch between home and detail page

- **`src/ui/readiness-view.ts`** — Readiness detail page was not computing `strainPct`, so it showed the uncapped composite score (e.g. 74) while the home view applied the strain floor (e.g. 39 when daily load exceeded target). Added the same strain % computation so both views produce identical readiness scores.

## 2026-04-06 — Excess load overhaul: label, persistence, HR data, continuous carry-forward

- **Multi-activity label fix** (`excess-load-card.ts`, `main-view.ts`) — Modal no longer labels a ski+run mix as "798 min extra run". When `unspentLoadItems` spans multiple sports, sport normalises to `cross_training`. Summary rewritten: "Your N extra activities generated X TSS, equivalent to Y km easy running."
- **HR data instead of RPE** (`excess-load-card.ts`, `main-view.ts`) — Combined activity now looks up actual iTRIMP from `garminActuals`/`adhocWorkouts` by garminId. Previously discarded the HR data and estimated from RPE, producing "Estimated" tier badge when HR stream was available.
- **Keep Plan preserves TSS** (`excess-load-card.ts`, `main-view.ts`) — "Keep Plan" no longer clears `unspentLoadItems`. Previously clearing them removed activities from `computeWeekRawTSS`, silently dropping the week's TSS. Items now persist until the user applies reductions or the week advances.
- **Persistent plan strip** (`plan-view.ts`) — `buildAdjustWeekRow` redesigned as a slim amber strip below the day pills ("X TSS excess — to be allocated / Adjust plan"). Always visible while excess > 15 TSS.
- **Continuous carry-forward** (`fitness-model.ts`) — New `computeDecayedCarry(wks, currentWeek)` computes decayed excess from all previous weeks using `CTL_DECAY` per week. `getWeeklyExcess` now accepts optional `carriedLoad` parameter, added to the actual side. Training load no longer resets at week boundaries.
- **Carry-forward wired into all excess checks** (`plan-view.ts`, `excess-load-card.ts`, `main-view.ts`, `activity-review.ts`, `home-view.ts`) — All `getWeeklyExcess` call sites (except `persistence.ts` migration and `events.ts` week-advance which compute `carriedTSS` itself) now pass `computeDecayedCarry` so the excess strip, activity log, and adjustment modal all reflect residual load.
- **Load breakdown sheet** (`home-view.ts`) — "Carried from previous weeks: N TSS" row added between sport segments and planned target footer, visible when carry > 0.

## 2026-04-06 — Excess load: fix double-counting, label unit mismatch, and object permanence

- **`src/calculations/fitness-model.ts`** — `computeWeekTSS` and `computeWeekRawTSS` now skip `unspentLoadItems` with `reason === 'surplus_run'`. Surplus items represent the extra km on a matched run, but the full activity is already counted in `garminActuals`. Counting it again inflated the week total (e.g. 353 instead of ~270).
- **`src/ui/plan-view.ts`** — Activity log "+X excess TSS" label now computes from `getWeeklyExcess(wk, plannedSignalB)` (real TSS units) instead of `wk.unspentLoad` (aerobic-effect scores). The two metrics are on different scales, causing the label to show 274 while the header showed 43.
- **`src/ui/plan-view.ts`** — Review button no longer calls `openActivityReReview` (which undoes all matches) when all pending items are already processed. Tapping Review after completing a review now does nothing, preserving the matched state.

## 2026-04-06 — ACWR: same-signal fix for cross-training athletes (ISSUE-85)

- **`src/calculations/fitness-model.ts`** — `computeACWR` now accepts optional `signalBSeed` (7th param). When provided, both CTL and ATL are seeded and updated using Signal B (raw physiological TSS, no runSpec discount) via `computeSameSignalTSB`. Previously CTL used Signal A (runSpec-discounted) while ATL used Signal B — a mixed-signal mismatch that caused ACWR to read artificially low for cross-training athletes. New `'low'` status for `ratio < 0.8` distinguishes genuine deload from no-history `'unknown'`.
- **All 15 call sites** (`home-view.ts`, `stats-view.ts`, `readiness-view.ts`, `main-view.ts`, `events.ts`, `activity-review.ts`, `renderer.ts`, `daily-coach.ts`) — pass `s.signalBBaseline ?? undefined` as `signalBSeed`. Falls back to legacy mixed-signal when Strava history not yet synced.

## 2026-04-06 — Activity review: object permanence + surplus load for manual matches

- **`src/ui/plan-view.ts`** — Review button now calls `showActivityReview` (no undo) when there are still `__pending__` items, and only calls `openActivityReReview` (full undo/re-show) when everything is already processed. Previously always called `openActivityReReview`, which undid all decisions on every tap.
- **`src/ui/activity-review.ts`** — Manual run matching in `applyReview` now computes a surplus `UnspentLoadItem` when actual km > 30% over planned km, matching the `matchAndAutoComplete` auto-match path. Surplus flows to `wk.unspentLoad` and `wk.unspentLoadItems`. Imported `calculateWorkoutLoad` from `@/workouts/load`.

## 2026-04-06 — Activity log: show stats for Logged/Excess adhoc items

- **`src/ui/plan-view.ts`** — fixed stats display for Logged/Excess activities in the plan activity log. `garminActuals` is keyed by plan slot ID, not garminId, so the previous lookup always returned undefined for adhoc items. Stats now read directly from the fields stored by `addAdhocWorkoutFromPending` (`garminDistKm`, `garminDurationMin`, `garminAvgHR`). Pace computed from those fields when available.

## 2026-04-06 — Strain ring: fix "Rest" shown when activity matched to a different-day slot

- **`src/ui/home-view.ts`**, **`src/ui/strain-view.ts`** — when `plannedDayTSS === 0` but `garminActuals` contains a matched activity for today, fall back to computing planned TSS from the matched workout (regardless of its scheduled `dayOfWeek`). Prevents "Rest / 118 TSS" when the user did their planned run on a different calendar day than it was scheduled.
- Added `estimateWorkoutDurMin` import to `strain-view.ts`; added same to `home-view.ts`.

## 2026-04-05 — Activity log: show stats for Logged/Excess adhoc items

- **`src/ui/plan-view.ts`** — fixed stats display for Logged/Excess activities in the plan activity log. `garminActuals` is keyed by plan slot ID, not garminId, so the previous lookup always returned undefined for adhoc items. Stats now read directly from the fields stored by `addAdhocWorkoutFromPending` (`garminDistKm`, `garminDurationMin`, `garminAvgHR`). Pace computed from those fields when available.

## 2026-04-05 — Strain target: apply workoutMods in strain-view so ring matches plan card

- **`src/ui/strain-view.ts`** — both the ring target path (`computeStrainData`) and the week bars path (`buildWeekBarData`) now apply `wk.workoutMods` (distance/type/RPE changes from auto-reduce) after `workoutMoves`. Previously only day moves were applied, causing the ring to use the original workout distance while the plan card used the reduced one.
- Added `isTimingMod` import from `@/cross-training/timing-check` to mirror the plan-view mod-application logic exactly.

## 2026-04-05 — Strain target: fix planned TSS to match plan card

- **`src/calculations/fitness-model.ts`** — extracted `estimateWorkoutDurMin(w, baseMinPerKm)` from `plan-view.ts`. Handles km-based descriptions (converts via pace by workout type), interval formats, and `min`-pattern fallback. Updated `computePlannedDaySignalBTSS` to accept `baseMinPerKm` param and use `estimateWorkoutDurMin` instead of the old `parseDurMinFromDesc` 30-min fallback.
- **`src/ui/home-view.ts`**, **`src/ui/strain-view.ts`** — all `computePlannedDaySignalBTSS` call sites now pass `s.pac?.e ? s.pac.e / 60 : 5.5` so the strain target matches the plan card TSS exactly.
- **`src/ui/plan-view.ts`** — `plannedTSS` now uses shared `estimateWorkoutDurMin` instead of inline duplicate logic.

## 2026-04-05 — Activity sync: ring fill on rest days + run review prompt + TSS dedup

- **`src/ui/strain-view.ts`** — rest-day ring now fills when actual TSS > 0. Reference = average planned TSS across training days this week (so 100% = "matched a typical training day load"). Previously strainPct was hard-clamped to 0 on rest days.
- **`src/ui/home-view.ts`** — same fix applied to the home-view ring (same formula, same reference).
- **`src/data/activitySync.ts`** — `isBatchSync` now returns `true` when any pending item is a run, routing it to Activity Review instead of silent auto-processing.
- **`src/calculations/activity-matcher.ts`** — `matchAndAutoComplete`: added skip guard at top of row loop — activities with a final `garminMatched` entry (not `'__pending__'`) are skipped on re-sync. Prevents `wk.actualTSS` double-accumulation and duplicate adhocWorkouts.
- **`src/calculations/activity-matcher.ts`** — `addAdhocWorkout`: added dedup check matching the existing guard in `addAdhocWorkoutFromPending`.

## 2026-04-05 — Excess load modal: "Push to next week" button

- **`src/ui/suggestion-modal.ts`** — `showSuggestionModal` now accepts an optional `onPushToNextWeek` callback (6th param). When provided, renders a "Push to next week" bordered button between Reduce and Keep Plan.
- **`src/ui/excess-load-card.ts`** — `triggerExcessLoadAdjustment` passes the carryover callback so the modal shows all 3 options: Reduce (future workouts only), Push to next week, Keep Plan.

## 2026-04-05 — Sleep score: use Garmin directly, drop chronic/acute formula

- **`src/calculations/readiness.ts`** — sleep sub-score now uses Garmin's 0–100 score as-is (most recent entry in history). Removed the chronic/acute relative formula (7d avg vs 28d baseline, asymmetric acute modifier). Garmin's score is already population-normalised; the relative layer was distorting a signal the user already sees in the Garmin app.
- Two readiness tests updated to reflect the new pass-through behaviour.

## 2026-04-05 — Recovery scoring: baseline anchor 65 → 80, RHR switched to absolute bpm

- **`src/calculations/readiness.ts`** — changed the neutral anchor from 65 to 80 across all three sub-scores (HRV, sleep, RHR). "At your personal baseline" now scores 80 — reflecting that normal metrics mean ready to train, not merely adequate.
- **`src/calculations/readiness.ts`** — RHR scoring switched from percentage-based to absolute bpm deviation (Buchheit 2014): `80 − deltaBpm × 5`. At baseline → 80, −5 bpm → 100, +4 bpm → 60, +7 bpm → 45. Previous percentage formula was overshooting small deviations.
- **`src/calculations/readiness.ts`** — zone thresholds updated: Excellent ≥80, Good 65–79, Fair 45–64, Poor <45.

## 2026-04-05 — Home readiness: triangle layout + new Readiness detail page

- **`src/ui/home-view.ts`** — Readiness section redesigned to triangle layout: Readiness ring top-centre (120px, larger), Sleep + Strain rings side by side below (100px). Freshness/Injury Risk/Recovery pill row removed from home view.
- **`src/ui/home-view.ts`** — Tapping the Readiness ring now opens the new `readiness-view.ts` instead of `recovery-view.ts`. Adjust button moved to below the sentence (no longer inside the pills wrapper).
- **`src/ui/readiness-view.ts`** — New detail page (sky-gradient design, same as recovery-view). Shows animated composite ring, readiness sentence, and three sub-signal cards: Freshness (TSB + zone), Injury Risk (ACWR + status), Recovery (score/100 + "View detail ›" link). Back button returns to home.

## 2026-04-04 — Recovery page: sub-scores row + honest HRV badge

- **`src/ui/recovery-view.ts`** — added sub-score row (HRV / Sleep / RHR) directly under the recovery ring so the composite is legible.
- **`src/ui/recovery-view.ts`** — HRV tile badge now reflects the chronic signal (7d avg vs 28d baseline, the same signal feeding the score): green "Normal" when score ≥ 65, amber "Slightly suppressed" when 45–64, amber "Below personal norm" when < 45. Previously showed a green tick whenever today's HRV was above the 7-day avg, which contradicted the composite score.
- **`src/ui/recovery-view.ts`** — added acute context line under the HRV badge: "Today +32% vs 7-day avg" — explains today's reading without it overriding the chronic story.

## 2026-04-04 — HRV scoring: science-based z-score method + readiness recovery floor

- **`src/calculations/readiness.ts`** — HRV score now uses a SD/z-score method (Plews/Flatt/Buchheit) when ≥ 10 baseline readings are available. `z = (7d avg − 28d avg) / 28d SD`, mapped to score via `65 + z × 20`. Fallback to the previous percentage method for the first ~10 nights of data. Added `hrvDataSufficient: boolean` to `RecoveryScoreResult`.
- **`src/calculations/readiness.ts`** — added sliding recovery floor to `computeReadiness`: `floor = 40 + (recoveryScore × 0.60)`. Prevents "Ready to Push" (≥80) when recovery is below ~67, and keeps readiness in "On Track" (≤63) when recovery is 38.
- **`src/ui/recovery-view.ts`** — HRV tile shows "Score improves after 10 nights of data" note when the z-score method is not yet active.

## 2026-04-04 — Fix: readiness composite now uses the full recovery score (HRV + sleep + RHR)

- **`src/calculations/readiness.ts`** — added `precomputedRecoveryScore` to `ReadinessInput`. When provided, it replaces the internal sleep-only formula as the recovery sub-signal. `sleepScore` is still used for the safety floor checks (sleep < 60 cap etc.).
- **`src/ui/home-view.ts`** (both call sites), **`src/ui/stats-view.ts`**, **`src/calculations/daily-coach.ts`** — `computeRecoveryScore` is now called before `computeReadiness` and its result passed in. This ensures the Recovery value that influences the readiness composite is the same value shown to the user (HRV 45% + sleep 35% + RHR 20%), eliminating the contradiction where Recovery 38/100 could coexist with Readiness 91.

---

## 2026-04-03 — Fix: unmatched activities showing in strain but not in timeline

- **`src/ui/activity-review.ts`** (`autoProcessActivities`) — run and cross-training overflow items (no matching plan slot) are now logged as adhoc workouts AND `garminMatched` is set, matching the existing gym overflow behaviour. Previously they only went to `unspentLoadItems`, which meant: (1) they showed in the strain ring TSS but were invisible in the activity timeline, and (2) `garminMatched` was never set so they were re-processed on every app launch. `seenGarminIds` dedup in `computeTodaySignalBTSS` prevents double-counting when both adhoc and unspentLoadItems entries exist.

---

## 2026-04-03 — Fix: today's hero card shows real activity name when matched to Strava

- **`src/ui/home-view.ts`** (`buildTodayWorkout`) — when the plan slot is matched to a Strava/Garmin actual, the hero title now uses `formatActivityType(actual.activityType)` instead of the plan slot name (e.g. "Alpine Skiing" instead of "General Sport 2"). Planned description is suppressed when a real activity exists (it would be wrong, e.g. "90min general sport" for a ski session). Duration and distance are taken from the actual when available. "Done" pill becomes a tappable "Done · View" button that opens the activity detail page.

---

## 2026-04-03 — Feature: Today's Strain page rebuild + rest day target fix

- **`src/ui/strain-view.ts`** — rebuilt page structure. Removed 7-day mins, 7-day kCal sparkline cards, and coaching card. Added 7-day week position bars (one row per day Mon–Sun of the current plan week, actual TSS filled against planned TSS track, today in orange, future days ghost track). Added steps placeholder card ("Daily steps / — / Garmin steps coming soon"). Page title and ring label renamed from "Strain" to "Today's Strain"; ALL-CAPS `text-transform` removed from ring label. Rest day behaviour: if `computePlannedDaySignalBTSS` returns 0, ring shows "Rest day" in grey with "X TSS logged" sub-label if any activity; no % shown on rest days.
- **`src/ui/strain-view.ts` (`getStrainForDate`)** — removed baseline fallback for target TSS. Rest days (planned sessions = 0) now return `targetTSS = 0` and `isRestDay = true`. Historical date lookup now resolves the correct plan week via `weekIdxForDate` instead of always using today's week.
- **`src/ui/home-view.ts`** — fixed rest-day target bug: `targetTSS` no longer falls back to `signalBBaseline ÷ 7` when `plannedDayTSS === 0` (was showing 103 TSS target on rest days). Ring content now shows "Rest day / X TSS logged" instead of "X / 103 target" when exercising on a rest day. Label above ring renamed from "Strain" to "Today's Strain".

---

## 2026-04-03 — Feature: sleep ring on home page

- **`src/ui/home-view.ts`** — added sleep ring between Readiness and Strain rings. Shows sleep score (0–100) with sleep duration below. Tapping navigates to the sleep detail page. All three rings shrunk from 120px to 100px (viewBox unchanged) to fit the 3-ring row.

---

## 2026-04-02 — Feature: leg load fatigue signal

- **`src/types/activities.ts`** — added `legLoadPerMin?: number` to `SportConfig`
- **`src/constants/sports.ts`** — populated `legLoadPerMin` for all sports across 4 tiers: vertical sports (hiking/skiing/stair_climbing = 0.50), sustained flat leg (rowing = 0.35, cycling/elliptical = 0.25), intermittent (skating/soccer/etc = 0.10–0.18), minimal (walking = 0.05). Not-leg sports (swimming, boxing, etc) have no value (0).
- **`src/types/state.ts`** — added `recentLegLoads` array to persist leg load entries with sport label and timestamp
- **`src/calculations/readiness.ts`** — added `recentLegLoads` input, 36-hour half-life exponential decay, and `legLoadNote` output. Note triggers at decayed sum >20 (moderate) or >60 (heavy).
- **`src/ui/activity-review.ts`** — `recordLegLoad()` called at both cross-training save points; stores load + sport label + timestamp in state, trimming to last 7 days
- **`src/ui/home-view.ts`** — `legLoadNote` passed to `PillSheetData` and rendered in the Injury Risk pill pop-up when leg fatigue is elevated

---

## 2026-04-02 — Fix: activity matching, strain load, and strain activity list

- **`src/calculations/fitness-model.ts` (`computeTodaySignalBTSS`)** — garmin-prefixed adhoc workouts were unconditionally skipped, so log-only and unmatched activities contributed 0 to today's strain. Now filtered by `garminTimestamp` (same field `addAdhocWorkoutFromPending` writes) with garminId dedup to prevent double-counting vs `unspentLoadItems`.
- **`src/ui/strain-view.ts` (`activitiesForDate`)** — only read `garminActuals`; garmin-prefixed adhoc workouts (unmatched / log-only) were invisible to the strain view activity list. Now also iterates `adhocWorkouts`, converts them to `GarminActual` shape using the stored `garminTimestamp` / `garminDistKm` / `garminDurationMin` / `garminAvgHR` fields, with garminId dedup across both sources.
- **`src/ui/activity-review.ts` (`openActivityReReview`)** — added `weekNum` parameter (1-based); function previously always operated on the current week (`s.w - 1`). Previous-week unmatched items are now handled: the plan window has passed so they are silently logged as adhoc and cleared from the pending list without showing the full review UI. Also: `unspentLoadItems` is now cleared per-item during the undo pass (preventing stale load entries from a previous review round), included in the Cancel snapshot/restore, and restored correctly on cancel.
- **`src/ui/home-view.ts`** — unmatched activity rows now carry `data-week-num`; click handler reads it and passes the correct week to `openActivityReReview` so previous-week items can be resolved. Click handler also now passes `renderHomeView` as `onDone` so the user lands back on the home view (with the items cleared) rather than the plan view after completing the review.

## 2026-04-07 — Floor-aware reductions in cross-training suggester

- **`src/cross-training/suggester.ts`** — `buildReduceAdjustments` and `buildReplaceAdjustments` now enforce a weekly running km floor. When ACWR is safe or low, distance reductions and replacements stop once total planned running hits the floor. When ACWR is caution or high, the floor is bypassed (injury prevention takes priority). Long runs get extra protection: floor keeps at least 85% of original distance. `AthleteContext` gains optional `floorKm` and `acwrStatus` fields.
- **`src/calculations/fitness-model.ts`** — Extracted `computeRunningFloorKm()` (was duplicated in events.ts). Takes marathon pace, current week, total weeks.
- **All call sites** (`events.ts`, `main-view.ts`, `activity-review.ts`, `excess-load-card.ts`, `recording-handler.ts`) now pass `floorKm` and `acwrStatus` to `buildCrossTrainingPopup`.

## 2026-04-07 — Km floor nudge redesign

- **`src/ui/plan-view.ts`** — Redesigned km floor nudge card. When cross-training reduces runs but running km is below floor, card explains the tension ("Load high, km low") and shows per-run extend buttons. User chooses which easy run to top up. Reduced runs can restore up to original; unreduced easy runs get up to 20%. Gated by ACWR safe. Button targeting uses workout name + day (not array index) for stability.
- **`src/ui/events.ts`** — `maybeInitKmNudge()` stores `{ floorKm, hasReductions }` signal. Candidates computed at render time.
- **`src/ui/main-view.ts`** — Removed home-view `stat-km-floor-nudge` (consolidated to plan view).

## 2026-04-02 — Fix: Reduce button unresponsive in suggestion modal

- **`src/ui/suggestion-modal.ts`** — `stopPropagation` was attached to all clicks inside `<details>` elements, blocking button clicks when "View changes" was expanded. Changed to only stop propagation on `<summary>` toggle clicks. Reduce (and Replace) buttons now respond correctly when the adjustment list is expanded.

## 2026-03-26 — Strain detail page (new iPhone-native design language)

- **`src/ui/strain-view.ts`** — new full-screen strain detail page. Terracotta/orange gradient header with glowing orbs, animated SVG ring (orange gradient fill), 7-day rolling stat cards (minutes + kCal with sparklines), factual rules-based coaching card, and activity timeline. Date picker shows last 7 rolling days. Info button opens a strain explainer overlay. Timeline rows open an activity detail overlay (duration, distance, HR, TSS, calories). Back button returns to Home.
- **`src/ui/home-view.ts`** — added `id="home-strain-ring"` + `cursor:pointer` to the strain ring container. Wired click handler → `renderStrainView()`. Strain ring is now tappable.

## 2026-03-26 — Sleep stage analysis + sleep bank readiness floor

- **`src/calculations/sleep-insights.ts`** — added `stageQuality()`: population-norm quality labels (Excellent/Good/Low/Normal/Elevated) for Deep, REM, and Awake stages. Added `getStageInsight()`: consultant-tone insight comparing today's REM/Deep to 7-day personal average; falls back to population norms when < 3 nights of history.
- **`src/calculations/readiness.ts`** — added `sleepBankSec?: number | null` to `ReadinessInput`. Sleep bank floor: > 3h deficit caps score at 74, > 5h caps at 59.
- **`src/ui/home-view.ts`** — `showSleepSheet` redesigned as a full-screen dark UI with quality labels on stage bars, REM/Deep vs 7-day insight card, and sleep bank line chart. All three `computeReadiness` call sites now pass `sleepBankSec` (requires >= 3 nights of data).
- **`src/ui/stats-view.ts`** — `computeReadiness` call now passes `sleepBankSec`.

## 2026-03-25 — Sleep bank redesign

- **`src/types/state.ts`** — added `sleepTargetSec?: number` field; user-set sleep target override.
- **`src/calculations/sleep-insights.ts`** — added `deriveSleepTarget()`: 75th percentile of last 30 nights (requires 14+), fallback 7.5h. Changed `getSleepBank()` window from 7 to 14 nights. Default target changed from 8h to 7.5h. Added `buildSleepBankLineChart()`: clean line chart with dashed zero baseline and terminal dot, replaces the flat area chart.
- **`src/ui/home-view.ts`** — sleep bank now uses `s.sleepTargetSec ?? deriveSleepTarget()` as the baseline. Chart replaced with `buildSleepBankLineChart`. "vs 8h/night" label now shows the actual target (e.g. "vs 7h 30m/night"). Minimum nights to show headline raised from 1 to 3.
- **`src/ui/stats-view.ts`** — readiness computation now uses effective sleep target.
- **`src/ui/account-view.ts`** — new "Sleep target" row in Preferences. Shows current target and source (Custom / From your history / Default). Edit mode with hours and minutes inputs (15-min steps). "Use history" button clears the override and reverts to derived target.

## 2026-03-25 — Sleep history access from Recovery pill sheet

- **`src/ui/home-view.ts`** — Recovery pill sheet sleep row now navigates to sleep history even when today's Garmin sleep has not arrived yet, as long as there are past nights in `physiologyHistory`. Previously the row was completely unresponsive (and showed no pointer cursor) when `noGarminSleepToday && !manualSleepScore`. Added `hasHistoricSleep` to `PillSheetData` and threaded it from the pill click handler.

## 2026-03-25 — Strain Score fixes

- **`src/calculations/fitness-model.ts`** — added `computePlannedDaySignalBTSS(workouts, dayOfWeek)`. Estimates Signal B TSS for a day's planned workouts using RPE × TL_PER_MIN × duration (same fallback logic as `computeTodaySignalBTSS`). No runSpec discount — Signal B is full physiological load.
- **`src/ui/home-view.ts` (`buildReadinessRing`)** — strain target now uses today's planned workout TSS when the plan has sessions scheduled, falling back to `signalBBaseline ÷ 7` on rest days. Fixes the bug where a hard-day target (e.g. 120 TSS long run) was being compared against a flat daily average (~40 TSS), making readiness floor at Manage Load before the session was done.
- **`src/ui/home-view.ts` (`buildReadinessRing`)** — readiness sentence is now strain-aware. Strain ≥ 130% → "Daily load exceeded target…"; ≥ 100% → "Daily target hit. Training is complete for today."; any training → "Session logged. Rest for the remainder of the day." TSB/ACWR matrix sentence only shown when no training has occurred. Removed motivational padding from the old `trainedToday` fallback.
- **`src/ui/home-view.ts`** — `trainedToday` now derived from `todaySignalBTSS > 0` (covers both garminActuals and adhocWorkouts) instead of inspecting garminActuals alone.
- **`src/calculations/readiness.ts`** — `strainPct` now destructured at the top of `computeReadiness` with all other inputs (was accessed as `input.strainPct` inconsistently).
- **`docs/strain.md`** — new design doc covering the strain model, target logic, readiness interaction, and known gaps.

---

## 2026-03-22 — Coach Brain (Phase 1)

- **`src/calculations/daily-coach.ts`** — new central aggregator. `computeDailyCoach(state)` collates all signals (TSB, ACWR, sleep, HRV, RPE, week load, injury, illness) and returns a `CoachState` with `stance`, `blockers`, `alertLevel`, and a fully structured `CoachSignals` payload ready for the LLM.
- **`supabase/functions/coach-narrative/index.ts`** — new edge function. Accepts `CoachSignals`, calls `claude-haiku-4-5-20251001`, returns a 2–3 sentence coaching paragraph. System prompt enforces direct/factual tone (no motivational padding, inline bold numbers, no emoji).
- **`src/ui/coach-modal.ts`** — Coach overlay with readiness ring (SVG arc, same pattern as Home ring), signal rows (freshness, load safety, sleep, HRV, week load), and LLM narrative card. Client-side rate limit: 3 calls/day with 4-hour cache in localStorage (`mosaic_coach_narrative_cache`). Cached narrative shown when limit is reached.
- **"Coach" button** added to Home header (between Check-in and account) and Plan header (current week only, before Check-in). Same pill style as Check-in.
- **`docs/BRAIN.md`** — architecture spec for the central coaching brain concept.

## 2026-03-22

- **Low readiness modal**: converted static option cards (Rest today, Reorder the week, Reduce intensity) into clickable buttons. Rest closes the modal; Reorder navigates to plan view; Reduce intensity calls `applyRecoveryAdjustment` (downgrade for hard sessions, easyflag for easy runs). Added `todayAnyWorkout` detection so the reduce action works even when no hard session is scheduled.

## 2026-03-22 — Daily Headline Narrative (Bevel-inspired)

- **`buildDailyHeadline(s)`** added to `home-view.ts` — rules-based 2-sentence insight card on the Home tab, above the readiness ring.
- Synthesises 7 signals in priority order: recovery debt (red → orange), HRV delta vs 7-day average, sleep streak (poor nights), recent cross-training load (last 48h, from `garminActuals` + `adhocWorkouts`), ACWR status.
- Each rule produces a headline + contextual body that differs based on whether today's session is hard or easy.
- Returns `''` when nothing notable — no noise card shown when conditions are fine.
- **`docs/BEVEL.md`** created: full competitive analysis, feature wishlist (sleep stages, Sleep Bank, strain, daily narrative, HRV trends, chatbot), UX notes from Bevel screenshots.
- **`docs/UX_PATTERNS.md`**: three new sections — Daily Insight Card anatomy, Recovery Metric Tiles, Sleep Stage Breakdown Rows.

## 2026-03-22 — Forecast chart redesign + visual constraints

- **Forecast load chart**: replaced multi-colour bar chart with a continuous area chart — historical TSS (solid blue) flows into planned TSS (dashed blue, lighter fill). Phase labels (Base/Build/Peak/Taper) appear as small grey text under each future week's date tick. No legend, no categorical colouring.
- **CTL chart**: removed all intermediate dots; line-only with no point markers.
- **UX_PATTERNS.md**: added `Visual Constraints` section (max 2 colours, no decorative elements) and `Chart type rules` (ban bar charts for time-series; forecast continuation pattern).
- **CLAUDE.md**: added pre-flight step 4 — "Visual constraints checked" before any UI code.

## 2026-03-22 — Stats: CTL "Learn more" page

- **CTL Learn more page**: Added "Learn more →" button to the Running Fitness Trend (CTL) chart in the Progress detail page. Tapping opens a full sub-page explaining what CTL measures, how it's calculated (including cross-training discounts), a range table with 6 tiers (Building → Elite, using the actual code thresholds at 20/40/58/75/95), how to build CTL safely, and what to expect during taper. Back button returns to the Progress detail page. Current tier highlighted inline.

## 2026-03-22 — Stats: HRV baseline spectrum, dot removal, sleep neutral bars, chart clean-up

- **HRV card redesigned**: Area chart replaced with Garmin-style baseline spectrum. Computes 28-day mean ± 1 stddev as a personal normal range, marks 7-day avg on the spectrum. Status label: Balanced / Low / High. Area chart kept below for trend context. Color changed to neutral gray.
- **Dots removed**: End-of-line dots removed from ACWR trend chart and `buildPhysioChartWithBaseline`. Clean lines only.
- **ACWR reference line labels removed**: Lines at 1.3/1.5 kept, labels stripped — spectrum bar above already explains the zones.
- **Sleep bars neutral**: Uniform `rgba(0,0,0,0.18)` instead of red/green per score. Zone label below headline retains color.
- **HRV + RHR cards**: Removed `cursor:pointer` and `SCROLL_CHEVRON` — no click-through exists for these cards.

## 2026-03-22 — Illness mode

- **Illness modal**: Check-in → Ill now opens a real modal asking "Still running (reduced intensity)" or "Full rest". Sets `illnessState` on state.
- **Illness banner (Plan + Home)**: Amber banner with thermometer icon, day counter, severity pill, and reassurance copy. "Mark as recovered" / "Recovered" button clears state.
- **Adherence gate**: During illness, VDOT week-advance adherence multiplier bypassed (treated as 1.0) — skips don't compound fitness reduction with an artificial penalty.
- **No plan mutation**: Workouts untouched; user drags/skips as normal.

---

## 2026-03-22 — Stats page polish: color reduction, section breaks, sleep, TSB

- **Color reduction**: All big metric numbers (Freshness, Injury Risk, HRV, RHR, Sleep, CTL) now always render in `var(--c-black)`; color preserved only for the zone/status badge below.
- **Spectrum bar labels**: Removed all zone labels from the bar row — now shows only the active zone label below the bar (cleaner, no crowding).
- **TSB chart flat line**: Y-axis now data-driven (data range + 30% padding) instead of fixed ±30 span. Chart now shows variation clearly.
- **"Overreached" → "Well Rested"**: TSB > +12 (daily-equiv) relabelled to "Well Rested"; color updated to green.
- **Section breaks in Readiness detail**: "Load" and "Recovery" section dividers added above Freshness/Injury Risk and HRV/RHR/Sleep groups.
- **Section breaks in Stats opening screen**: Thin divider lines added between Progress / Fitness / Readiness cards.
- **Sleep card**: Now merges `recoveryHistory` manual sleep entries for dates Garmin hasn't filled. Entire card is tappable → opens sleep sheet.
- **Sleep detail button removed**: The floating "Sleep detail →" button on the Readiness detail page and in `buildRecoveryAccordionBody` removed. Sleep access is now via tapping the card.

## 2026-03-22 — Redesign: Readiness detail page card layout

- **`src/ui/stats-view.ts`** — All five metric cards (Freshness, Injury Risk, HRV, Resting HR, Sleep) + Running Fitness card redesigned: value moved from 16px right-aligned to 30px/weight-300 left-aligned headline; zone label below value in matching color; card title now 11px uppercase with letter-spacing; time window label (8-week / 7 days / 7 nights) in top-right with chevron replacing the old value cluster; padding 16px → 20px for breathing room; captions 10px → 11px.
- **`buildInlineSpectrumBar`**: bar height 6px → 8px, border-radius 3px → 4px, zone labels 8px → 9px, label row height 18px → 20px.
- **`buildACWRTrendChart`**: removed redundant 1.0 reference line; replaced unlabelled threshold lines with labeled "Elevated 1.3" / "High Risk 1.5"; removed SVG `<text>` element (distorted by `preserveAspectRatio="none"`) and deleted the 3 variables that only served it.

---

## 2026-03-22 — Fix: run activities logged via review screen now count as runs for load

- **`src/calculations/activity-matcher.ts`** (`addAdhocWorkoutFromPending`): fixed `t` always being `'cross'` — now correctly uses `'easy'` when `item.appType === 'run'`, matching the behaviour of `addAdhocWorkout`.
- **`src/calculations/fitness-model.ts`** (`computeWeekTSS`): adhoc workouts with a run `t` type (`easy`, `long`, `tempo`, etc.) now use `runSpec=1.0` regardless of the activity display name. Fixes activities like "General Sport 1" that were runs but got Signal A load computed at the default `0.35` cross-training discount.

## 2026-03-22 — Stats: flat metric cards on Readiness detail (revised)

- Stats landing kept as original 3-pillar cards. New flat metric scroll now lives inside Readiness detail page.
- `buildReadinessDetailPage()` replaced accordion with flat cards: Freshness · Injury Risk · HRV · Resting HR · Sleep.
- `buildACWRTrendChart()`: reference labels moved from SVG text to HTML spans to fix scaling distortion. Dots removed except last point.
- `buildPhysioChartWithBaseline()`: removed distorted floating SVG "avg" label.

## 2026-03-22 — Stats: flat metric dashboard redesign

- **`src/ui/stats-view.ts`**: Replaced the 3-pillar opening screen (Progress / Fitness / Readiness cards) with a flat single-scroll layout. Each metric is a self-contained card: header row (title + value + trend arrow + chevron), spectrum bar above the chart (where applicable), fully-labelled chart, 1-line context note.
- New cards: Freshness (TSB) · Injury Risk (ACWR) · HRV (RMSSD) · Resting HR · Sleep · Running Fitness (CTL). Plan Progress card retained at top.
- New `buildInlineSpectrumBar()`: compact 6px bar with white gap marker and zone labels — used for Freshness, Injury Risk, Running Fitness.
- New `buildDailyLineChartGap()`: gap-aware 7-day line chart. Null entries render as a visual break (M/L path split) with a faint dash tick. Dashed baseline reference for HRV and RHR. Hi/lo Y-axis labels.
- HRV and RHR cards show 7-day gap-aware line; trend arrow (green ↑ for HRV, green ↓ for RHR); 7-day and 28-day avg in context line.
- Sleep card reuses existing `buildBarChart` from sleep-insights. CTL card reuses `buildCTLLineChart`.
- Detail pages (Readiness, Fitness, Progress) unchanged — still reachable by tapping cards. Wiring updated in `renderStatsView`.

## 2026-03-22 — Fix: new week shown as fully missed after Sunday wrap-up

- **`src/ui/plan-view.ts`** (`buildCalendarStrip`, `buildWorkoutCards`): Added `weekHasStarted` guard. When the user wraps up the week on Sunday and `s.w` advances to the next week (which starts Monday), the day-of-week index check `dayIdx < today` was marking Mon–Sat as "Missed" immediately. Fix: if the new week's start date is after today, no days are past.

## 2026-03-22 — Recovery card: stale sleep suppression + manual sleep entry

- **`src/calculations/readiness.ts`**: Added `suppressSleepIfNotToday` option to `computeRecoveryScore`. When today's Garmin sleep entry is absent and no manual entry exists, `sleepScore` is set to null — excluded from the composite and the bar is hidden entirely.
- **`src/calculations/readiness.ts`**: Sleep acute modifier now only applies when `lastNightSleepDate === today`. Removed `isSleepDataPending()` dependency from label logic.
- **`src/ui/home-view.ts`**: When no sleep data for today, the Sleep sub-score bar is suppressed. Only the "No sleep data from Garmin yet · Log manually" prompt shows in that section.
- **`src/ui/home-view.ts`**: Added `showManualSleepPicker()` — centred overlay (per UX_PATTERNS.md) with a 1–10 number grid (×10 → 0–100 score). Saves to `recoveryHistory` with `source: 'manual'`, injected before `computeRecoveryScore`.
- **`docs/UX_PATTERNS.md`**: Added "Overlays and Modals" section — always centred, never bottom-anchored.
- **`CLAUDE.md`**: Added overlay positioning rule with UX_PATTERNS.md reference.

## 2026-03-22 — Stats: Forecast tab on Total Load (TSS) chart

- **`src/ui/stats-view.ts`**: Added `'forecast'` to `ChartRange` type. New `buildForecastLoadChart()` renders a bar chart of planned TSS for each remaining week in the plan, with bars coloured by training phase (blue=Base, orange=Build, purple=Peak, yellow=Taper). Current week bar is fully opaque with a dashed "Now" marker; future weeks at 70% opacity. Phase legend shown below chart.
- Added `buildProgressRangeToggle()` — a variant of the range pill that includes an additional "Forecast" button. Used in the Progress detail page instead of `buildRangeToggle`.
- `wireProgressRangeButtons`: early-returns on `'forecast'` to show the forecast chart without touching km/CTL charts.

## 2026-03-21 — Fix: run matched to General Sport slot now labelled "Run" and counted in running km

- **`src/ui/activity-review.ts`**: Store `activityType` in `GarminActual` for runs matched via the review/matching screen (was only set on the auto-complete path). Both run-matching call sites updated.
- **`src/ui/home-view.ts`**: Updated `isRunKey` to accept an optional `activityType` arg — checks activity type first, falls back to slot-key keyword scan. Updated km filter and activity log `isRun` check to pass `activityType`. Activity label now prefers `formatActivityType(activityType)` over slot name so a run matched to a cross slot shows "Run" not "General Sport 1".
- **`src/ui/stats-view.ts`**: `runKmFromWeek` updated same way — checks `activityType` before keyword scan.
- **`src/state/persistence.ts`**: Migration `isRunKey` updated to check `activityType`.

## 2026-03-21 — Readiness detail page: accordion redesign

- **`src/ui/stats-view.ts`**: Replaced the old "Recovery & Physiology + Training Load slabs" layout with 3 accordion rows matching the home page order: **Freshness → Injury Risk → Recovery**. Each row shows the current value + coloured zone bar. Tap to expand: Freshness shows 8-week TSB trend; Injury Risk shows 8-week ACWR trend (with 1.0/1.3/1.5 reference lines); Recovery shows Sleep (bar chart + detail button), HRV (area chart with 28-day baseline reference line + value label), Resting HR (same). HRV chart now clearly titled "HRV (RMSSD)" with personal average shown. Removed dead `buildTSBMetricPage`, `buildRecoveryPhysiologySection`, and old readiness wire functions.

## 2026-03-21 — Background sleep poller + accurate sleep date label

- **`src/ui/home-view.ts`**: Sleep label in recovery pill sheet now shows "Last night" only when `lastNightSleepDate` is today or yesterday. Older data shows the actual date (e.g. "19 Mar: 54/100") so stale data is immediately obvious. `lastNightSleepDate` added to `PillSheetData` and wired from `recoveryResult2`.

## 2026-03-21 — Background sleep poller

- **`src/data/sleepPoller.ts`** (new): polls `syncPhysiologySnapshot(7)` every 3 minutes when today's sleep score is absent. Self-terminates when data arrives or after 6 hours. Exports `startSleepPollerIfNeeded()` and `isSleepDataPending()`.
- **`src/main.ts`**: calls `startSleepPollerIfNeeded()` at the end of both Garmin sync branches (Strava+Garmin and Garmin-only) so polling begins immediately after launch if sleep is missing.
- **`src/ui/stats-view.ts`**: readiness card sleep section shows a grey "Waiting for Garmin to send sleep data" label when `isSleepDataPending()` is true and today's score hasn't arrived yet. When data arrives the poller re-renders the active view automatically.

## 2026-03-20 — Recovery advice sheet: specific session actions

- **`src/ui/home-view.ts`**: `showRecoveryAdviceSheet()` now detects today's unrated quality session. If found: shows session-specific "Convert to easy run" / "Run by feel" button (calls `applyRecoveryAdjustment('downgrade')`) and "Move to [Day]" button (writes `wk.workoutMoves`, saves, re-renders). Back-to-back detection: if yesterday was a rated hard session, surfaces a warning. Generic rest/reorder/reduce rows shown only when no quality session is detected today. Imports added: `getMutableState`, `saveState`, `isHardWorkout`, `applyRecoveryAdjustment`.
- **`CLAUDE.md`**: Added UI Copy writing style guide (consultant tone, no wellness padding, reference examples, anti-pattern table).
- **Fix**: Removed `|| true` debug hack from Adjust button; added ACWR gate so the button routes to `triggerACWRReduction()` only when ACWR is elevated or unspent items exist.

## 2026-03-20 — Week debrief "Continue" now navigates to Plan

- **`src/ui/week-debrief.ts`**: Fixed `_closeAndRecord` in `review` mode — was calling `renderHomeView()`, now uses dynamic import to call `renderPlanView()`. Dynamic import required to avoid circular dependency (`plan-view.ts` → `week-debrief.ts`).
- **`CLAUDE.md`**: Added Navigation Rules section documenting this pattern.

## 2026-03-20 — Load & Taper page

- **`src/ui/load-taper-view.ts`** (new): Full-page Load & Taper view. Shows this week's TSS bar + "See breakdown →" button (opens existing modal), TSS range explainer (150/350/500 thresholds), all four plan phases with descriptions (Base/Build/Peak/Taper) with the current phase highlighted, and a "Why taper makes you faster" science card. Back button returns to plan or home.
- **`src/ui/plan-view.ts`**: `plan-load-bar-row` click now navigates to the Load & Taper page instead of opening the inline modal.
- **`src/ui/home-view.ts`**: `home-tss-row` click now navigates to the Load & Taper page instead of opening the inline modal.

## 2026-03-20 — Stats page full redesign: three-pillar architecture (Progress · Fitness · Readiness)

- **`src/ui/stats-view.ts`**: Complete rewrite of the Stats page. Opening screen now shows four stacked sections: Progress card, Fitness card, Readiness card, and a flat Summary section. Each of the three primary cards taps into a dedicated single-scroll detail page with no tabs inside. Progress card shows a race-mode arc/timeline with forecast finish + on-track pill, or a fitness-mode tier progress bar for non-race users. Fitness card shows compact VDOT sparkline + VDOT value + tier label. Readiness card shows a Freshness scale bar with a properly positioned floating marker (`left: pct%` via absolute positioning — the ⓘ info icon is moved to the row title, no longer anchored to the bar left edge). Progress detail page has Phase Timeline, Training Load line chart, Running Distance line chart, and CTL line chart — all with 8w/16w/all range toggle. Fitness detail page has scale bars (Running Fitness/Aerobic Capacity/Lactate Threshold), a VDOT trend line chart with range toggle, plus race forecast and training paces. Readiness detail page has scale bars for Freshness/Short-Term Load/Load Safety/Fitness Momentum, a Freshness trend line chart with zone bands, and a Recovery & Physiology section rendered fully expanded (no accordion). All charts use SVG line/area — no bar charts anywhere. Summary section shows race predictions (Marathon/Half/10K/5K) in race mode and training paces in both modes. Scale bars now use raw TSB units (-60 to +40) per spec; ATL scale extended to 150 to match spec. Removed: old "This Week" summary card, old "Fitness" summary card with CTL number, old "More detail" accordion, Zones tab, zone stack chart.

## 2026-03-19 — Feature: Week Overview + coach insight + future week draft treatment

- **`src/calculations/coach-insight.ts`** (new): `computeWeekSignals` — maps effortScore, tssPct, ctlDelta, HR drift → 4 signal states. `getSignalPills` — coloured pill data for UI. `getCoachCopy` — 9-case RPE×Load decision tree with secondary modifiers (fitness direction, HR drift); returns `null` for novel/sparse combinations. `getFutureWeekCopy` — VDOT + phase + race proximity sentence for future weeks; race note guarded by `hasRace` flag. `PILL_COLORS` exported for shared use. Thresholds aligned with existing debrief logic (±1.0).
- **`src/ui/plan-view.ts`**: "Week Overview" / "About this week" expandable toggle added below load bar. Current/past weeks: signal pills (Effort, Load, Fitness, Aerobic) + coach paragraph. Future weeks: VDOT + Phase + Load + Race chips; detailed copy naming each factor (fitness, load budget, block structure, race proximity); card list at 75% opacity; "Draft · distances ±10% · paces update weekly" banner. `fmtDescRange` helper rewrites workout descriptions with ±10% distance ranges on future week cards. `Mark as Done` / `Skip` buttons hidden for future weeks. Chevron animates on expand/collapse. Coach block hidden when effort adjustment prompt is already showing to avoid duplicate messaging.
- **`src/ui/week-debrief.ts`**: Coach block (signal pills + paragraph) injected between metrics rows and effort adjustment prompt. Hidden when `showPacing` is true (effort prompt takes precedence). Uses shared `PILL_COLORS` and existing `tssPct` — no recomputation.

## 2026-03-19 — Fix: readiness TSB and ACWR now include current week's actuals

- **`src/calculations/fitness-model.ts`**: `computeSameSignalTSB` and `computeACWR` now extend their loop by 1 to include the current in-progress week (`limit = currentWeek + 1` capped at `wks.length`). Previously, today's completed activities (garminActuals, adhocWorkouts) were invisible to ATL — so Freshness stayed "+20 Fresh" and ACWR stayed low regardless of what the athlete had done that day. `computeWeekRawTSS` only counts synced actuals, so the value is 0 when nothing has been done and correctly reflects completed load once activities sync.

---

## 2026-03-19 — Stats page redesign v2 (area charts, less navigation, race status)

- **`src/ui/stats-view.ts`**: `buildMiniTSSSparkline` converted from bars to smooth area/line (SVG path via `smoothAreaPath`). New `buildMiniVdotSparkline` for Fitness summary card — shows VDOT trend as a small area chart inline. New `buildRaceStatusBanner` for race mode users — Starting/Today/Forecast grid + progress bar shown inside the Fitness card. `buildReadinessSummaryCard` now shows TSB, ACWR, and sleep score as inline data rows. New `buildVdotSparklineLarge` (full-width, 72px, area fill) for the Fitness detail page. `buildFitnessDetailPage` now leads with VDOT sparkline above progress bars. `buildThisWeekDetailPage`: Load/Distance/Zones tab switcher killed — single load chart + 8w/16w toggle only; distance shown as stat below chart. `buildReadinessDetailPage`: segmented control removed — Training Load + Recovery on single scroll. `wireChartTabs`: simplified to range-only (no chart type tabs).

---

## 2026-03-19 — Garmin backfill guard: permanent → 12h TTL

- **`src/data/supabaseClient.ts`**: Replaced the permanent `mosaic_garmin_backfill_empty` localStorage guard with a 12-hour TTL (`mosaic_garmin_backfill_empty_until`). **Root cause of recurring sleep not pulling**: the old guard fired permanently on the first app launch of the day (often before the morning watch sync completes), blocking all subsequent backfill attempts. The new guard expires after 12 hours so the next launch retries — after the watch has synced. Old permanent guard key is cleared on first run of the new code (migration). On success with >0 rows, guard is cleared entirely so every launch checks for fresh data.

---

## 2026-03-19 — Home: activity dates + unmatched activity display

- **`src/ui/home-view.ts`**: Recent activity list now shows actual dates (e.g. "Mon 17 Mar") instead of "Last week"/"This week", using `act.startTime` for garminActuals and `w.garminTimestamp` for adhoc workouts. Unmatched activities (garminPending items with `__pending__` state) now surface in the Recent section with an amber "Unmatched" pill tag; tapping opens the activity review flow via `window.openActivityReReview()`.

---

## 2026-03-19 — Stats page redesign (3-card Whoop-style layout)

- **`src/ui/stats-view.ts`**: Replaced cluttered multi-section layout with 3 clean summary cards ("This Week", "Fitness", "Readiness"), each tapping to a full detail page. Tier pill removed — replaced by VDOT + direction arrow (↑→↓). ACWR pill only shows when elevated/high. Readiness driving signal pill only when score < 60. "This Week" detail: Load / Distance / Zones chart + 8w/16w range. "Fitness" detail: progress bars + VDOT history + forecast times. "Readiness" detail: segmented control (Training Load | Sleep & HRV). `computeReadiness`, `readinessColor`, `drivingSignalLabel` added to imports.

---

## 2026-03-12 — Load Budget Spec: total-week Signal B excess model

- **`src/calculations/fitness-model.ts`**: New `computePlannedSignalB()` = `computePlannedWeekTSS()` + sum of `sportBaselineByType[sport].avgSessionRawTSS × sessionsPerWeek`. Plan bar and excess detection now compare Signal B vs Signal B (no cross-signal mismatch).
- **`src/calculations/readiness.ts`**: New `computeRecoveryTrend(history, days=5)` → returns recovery multiplier (1.0/1.15/1.30/1.50) based on 5-day HRV/sleep/RHR composite. Degrades to 1.0 without watch data.
- **`src/data/stravaSync.ts`**: `signalBBaseline` now uses **median** of weekly rawTSS (was simple average). Resistant to injury/rest weeks dragging the baseline down.
- **`src/ui/plan-view.ts`**: Plan bar target switches from `computePlannedWeekTSS()` to `computePlannedSignalB()`. Adjust week row now triggers on total week Signal B excess > 15 TSS (was: only when unspentLoadItems present).
- **`src/ui/home-view.ts`**: Load breakdown sheet uses `computePlannedSignalB()` for target. Footer now shows composite: Running planned / Cross-training expected / Total target.
- **`src/ui/excess-load-card.ts`**: Completely reworked. Detection now uses total week Signal B vs `computePlannedSignalB()` — matching is irrelevant. Card shows at Tier 2 (15–40 TSS excess). `triggerExcessLoadAdjustment()` computes `reductionTSS = excess × weightedRunSpec × recoveryMultiplier`. Removed unspent-items popup and leg-impact sheet (dead in new model). Dismiss now writes a suppression mod instead of clearing items.
- **`src/cross-training/suggester.ts`**: `buildCrossTrainingPopup()` accepts optional `recoveryMultiplier` param. Inflates `runReplacementCredit` (capped at +20 TSS equivalent guardrail per spec §6).

---

## 2026-03-12 — Time-based recovery segments with countdown UI

- **`src/types/gps.ts`**: Added `durationSeconds?: number` to `SplitSegment`. When set, segment advances by elapsed time rather than distance.
- **`src/gps/split-scheme.ts`**: Recovery segments in `buildIntervalScheme` and `buildTimeIntervalScheme` now use `{ distance: 0, durationSeconds: restSeconds }` instead of an estimated distance. `totalDistance` correctly excludes recovery (distance 0).
- **`src/gps/tracker.ts`**: `checkSplitBoundary()` branches on `durationSeconds` vs `distance` for advancement. `getCurrentSplitData()` now populates `elapsed` for the in-progress segment. New `tick()` method called by the 1-second timer so time-based segments auto-advance without needing a GPS point.
- **`src/ui/gps-events.ts`**: 1-second timer now calls `activeTracker.tick()` before reading live data.
- **`src/ui/record-view.ts`**: Recovery segment card shows "X left — Walk or light jog". In the last 5 seconds, displays a large `5 4 3 2 1` countdown. Segment list shows formatted duration (e.g. "90s", "2:00") for time-based segments instead of distance.

---

## 2026-03-12 — ISSUE-86: Fix disproportionate Reduce/Replace recommendation

- **`src/ui/suggestion-modal.ts`**: Added `pctAboveCeiling` and `pctAboveBaseline` — the former is excess above the safety ceiling (was the only value, wrongly labelled "above your normal load"), the latter is `(ratio − 1) × 100` = actual load vs baseline. `humanConsequence` now references baseline. When ceiling overshoot ≤ 5%, copy reads "Your load is just above the safe ceiling (1.63× vs 1.60×). A small adjustment is enough." Rule 1 zoneAdvice updated to use baseline %.
- **`src/ui/main-view.ts`**: Lowered synthetic activity duration floor from `Math.max(20, …)` → `Math.max(5, …)` when synthesising ACWR-excess load. Eliminates 3× inflation for small overages (e.g. 6 TSS excess → 7 min, no longer bumped to 20 min).

---

## 2026-03-12 — Fix: TSS mismatch between home bar and Weekly Load Breakdown modal

- **`src/ui/home-view.ts`**: `buildProgressBars` now always uses `computePlannedWeekTSS` for the TSS target — removes the `signalBBaseline` fallback which ignored phase multipliers (was showing 230 instead of 165 on current week).
- **`src/main.ts`**: After `syncStravaActivities()` and `syncActivities()` complete, re-renders the home view if it is still active (`#home-tss-row` in DOM). Previously the home TSS bar was stale (rendered before sync ran), causing the displayed actual to diverge from the modal.

---

## 2026-03-12 — ISSUE-106: Cross-training planned TSS: historical calibration + hide misleading bars

- **`src/calculations/fitness-model.ts`**: Added `computeCrossTrainTSSPerMin(wks, sportKey)` — scans garminActuals across all weeks, computes median TSS/min for a given sport using iTrimp-based TSS (`iTrimp * 100 / 15000`). Returns null if < 2 samples.
- **`src/ui/plan-view.ts`**: For `w.t === 'cross'` or `w.t === 'gym'`, planned TSS now uses: (1) historical iTrimp rate × duration when ≥2 samples exist; (2) `TL_PER_MIN[rpe] × durMin × sportRunSpec` as fallback (e.g. 0.40 for generic_sport) — avoids ~7× inflation vs iTrimp scale. Running sessions unchanged.
- **`src/ui/plan-view.ts`**: Planned vs actual load bars suppressed for matched cross-training sessions — RPE-assumed HR rarely matches actual sport HR, making the comparison misleading. Future unmatched cross-training still shows `~X TSS` estimate using corrected formula.
- **`src/ui/plan-view.ts`**: `data-planned-tss` set to 0 for cross-training when opening activity-detail — no planned bar shown there either.

---

## 2026-03-12 — ISSUE-20: km splits now sourced from Strava splits_metric

- **`supabase/functions/sync-strava-activities/index.ts`** (standalone mode): For new runs, calls `/activities/{id}` to get `splits_metric` directly from Strava. Pace = `moving_time * 1000 / distance` sec/km per split — exact match to Strava's displayed splits. Falls back to stream-based `calculateKmSplits` if the detail fetch fails.
- Same file: Cached runs with `km_splits: null` now fetch `splits_metric` on next sync and patch the DB.
- ISSUE-28 confirmed on device, marked ✅.

---

## 2026-03-12 — ISSUE-88: km/mile toggle now applies everywhere

- **`src/ui/plan-view.ts`**: Added `import { formatKm }` from `@/utils/format`. Updated all hardcoded `".toFixed(1) km"` distance displays in `buildWorkoutExpandedDetail`, `buildActivityLog` (added `getState()` call), and `buildWorkoutCards` to use `formatKm(km, s.unitPref ?? 'km')`. Handles string-typed `distKm` defensively.
- **`src/ui/home-view.ts`**: Updated `buildTodayWorkout` (Distance meta item), `buildNoWorkoutHero` (next workout label), and `buildRecentActivity` (activity feed rows) to use `formatKm` with `s.unitPref`.
- Docs: Marked ISSUE-88, ISSUE-87, ISSUE-100, ISSUE-93 ✅ fixed. Removed ISSUE-89 (TSS "estimated") and ISSUE-101 (recovery bar) as confirmed resolved.

---

## 2026-03-12 — ISSUE-28: Retroactive RPE editing + auto-push uncompleted sessions

- **`src/ui/plan-view.ts`**: Added `data-week-num="${viewWeek}"` to both `plan-action-mark-done` buttons and the `plan-action-skip` button in `buildWorkoutCards()`. Click handlers now read `el.dataset.weekNum` and pass it to `rate()` / `skip()` as `targetWeek`.
- **`src/ui/events.ts`** (`rate()`): Added optional `targetWeek?: number` param. For past weeks (`targetWeek < s.w`), records `wk.rated[workoutId] = rpe` and returns early — skipping VDOT/rpeAdj/LT updates.
- **`src/ui/events.ts`** (`skip()`): Added optional `targetWeek?: number` param. For past weeks, marks the session as 'skip' in-place (no push to next week).
- **`src/ui/week-debrief.ts`**: Added `_handleUncompletedSessions()` — called from the "Complete week →" button before `_closeAndRecord`. Finds sessions that are unrated AND not already in the week's skip list. If any exist, replaces the CTA area with a two-button prompt ("Move to next week" / "Drop them"). "Move to next week" pushes each session to `wks[weekNum].skip` using the standard skip entry structure. CTA button wrapped in `<div id="debrief-cta-area">` to enable inline replacement.

---

## 2026-03-12 — Sleep sheet polish

- **`sleep-insights.ts`** (`BarChartEntry`): Added optional `subLabel` field — rendered as a small row below the day name. Used for duration labels ("7h 22m") under each nightly bar.
- **`home-view.ts`** (`showSleepSheet`): Duration subLabels now appear under each bar in the 7-night chart. Added derived **Light sleep** bar (duration − deep − REM − awake). Added **stages placeholder** when score is present but stages are null: *"Duration and stage breakdown will appear after your next Garmin Connect sync."*
- **`docs/OPEN_ISSUES.md`**: Logged ISSUE-89 — sleep debt tracker (P2 future build).

---

## 2026-03-12 — Sleep UI overhaul

- **`sleep-insights.ts`**: Added `sleepScoreLabel()`, `getSleepContext()` (vs personal history + 7–9h population target), and `buildBarChart()` — clean filled bar chart renderer used across sleep screens.
- **`home-view.ts`**: New `showSleepSheet()` — score + duration side-by-side with contextualisation (avg, best, vs target), Deep/REM/Awake stage bars, 7-night filled bar chart, stale-data banner ("Data last synced DD/MM. Open Garmin Connect to resync.").
- **`home-view.ts`** (recovery modal): Sleep row now shows last night's raw score as rawLine. Composite one-liner added. Sleep row is clickable → opens sleep sheet directly. "View full breakdown in Stats" renamed "Sleep detail" and opens sheet instead of navigating to Stats.
- **`stats-view.ts`**: Replaced `buildPhysioMiniChart` sparklines with `buildBarChart` clean filled bar charts for Sleep, HRV, and Resting HR. Sleep section now shows inline bar chart + Sleep detail button.
- **`format.ts`**: Added `fmtDateUK()` — formats YYYY-MM-DD as DD/MM (UK format).
- **`main-view.ts`**: Sleep dot history uses DD/MM date labels.

---

## 2026-03-12 — Feature: Intelligent Workout Commentary (ISSUE-35 Build 3)

- **`workout-insight.ts`**: New `generateWorkoutInsight()` — rules-based engine picks top 2-3 coaching insights from: pace adherence, HR effort score, HR drift, split consistency (CV, negative split, late fade), and HR zone distribution. Coaching/direct tone, all activity types.
- **`activity-detail.ts`**: "Coach's Notes" card rendered below training load on the activity detail screen. Only appears when there's something useful to say.

---

## 2026-03-12 — Feature: HR drift computed from Strava HR streams (ISSUE-35 Build 2)

- **`stream-processor.ts`**: New `computeHRDrift()` — splits HR stream in half (after stripping 10% warmup), compares avg HR. Only for runs ≥ 20 min with ≥ 60 valid HR points.
- **Edge function** (`sync-strava-activities`): Inline `calculateHRDrift()` added. Computed for running types alongside iTRIMP/hrZones. Stored in DB `hr_drift` column. Returned in response rows.
- **DB migration**: `20260312_hr_drift.sql` — adds `hr_drift real` column to `garmin_activities`.
- **Client data flow**: `GarminActivityRow.hrDrift` → `GarminActual.hrDrift` during matching. Enrichment backfill + stravaSync patching.
- **Effort score**: Drift > 5% on easy/long runs adds bonus deviation (capped at +1.0 RPE-equivalent) to blended effort score.
- **Adaptive note**: Future weeks surface high drift context.

---

## 2026-03-12 — Feature: Sleep morning re-sync + null tap target + REM bar

- **Morning re-sync** (`supabaseClient.ts`): new `refreshRecentSleepScores()` bypasses backfill guard, calls `garmin-backfill` with `weeks=1`. Triggered from `main.ts` after physiology sync when today's sleep score is missing — picks up Garmin's server-computed score (available 1–4h post-wake).
- **Null tap target**: "Sleep —" chip always shown when watch is connected, even when today's score is pending. Tapping it opens the sleep sheet showing yesterday's data and history.
- **REM bar**: added to sleep detail sheet alongside deep sleep (purple) and awake time.

---

## 2026-03-12 — Feature: Sleep detail sheet + Garmin sleep stages pipeline

- **Migration** `20260311120000_sleep_stages.sql`: adds `duration_sec`, `deep_sec`, `rem_sec`, `awake_sec` to `sleep_summaries` table.
- **`garmin-webhook`**: removed broken `qualifierKey` string fallback + estimation fallback; now stores Garmin's real score (or null) plus all 4 stage durations.
- **`garmin-backfill`**: updated `GarminSleep` interface and upsert to include stage fields.
- **`sync-physiology-snapshot`**: selects and returns all 4 stage fields in merged day rows.
- **`PhysiologyDayEntry`**: added `sleepDurationSec`, `sleepDeepSec`, `sleepRemSec`, `sleepAwakeSec` fields.
- **`physiologySync.ts`**: maps new stage fields from DB rows.
- **`sleep-insights.ts`** (new): training-linked insight generator — post-hard-week, bad streak, good streak, bounce-back, debt, trend.
- **`home-view.ts`**: sleep score in recovery caption is now coloured + clickable; opens `showSleepSheet()` bottom sheet with score, duration, deep/awake bars, 7-night chips, and insight.
- **`stats-view.ts`**: sleep row shows 7-day average + insight sentence + "Full sleep breakdown" button.

---

## 2026-03-12 — Feature: HR effort + pace adherence signals feed plan engine (ISSUE-35 Build 1)

- **HR Effort Score**: `computeHREffortScore()` in `heart-rate.ts` — compares actual avgHR (from Strava) to target HR zone for the workout type. Score: 0.8 = undercooked, 1.0 = on target, 1.2 = overcooked. Stored on `GarminActual.hrEffortScore`.
- **Pace Adherence**: `computePaceAdherence()` in `activity-matcher.ts` — actual pace / target pace ratio. 1.0 = nailed it, >1.0 = slower than target. Stored on `GarminActual.paceAdherence`. Target pace derived from VDOT tables per workout type.
- **Blended effort score**: `events.ts` now blends RPE + HR + pace into `wk.effortScore`. Quality sessions (threshold, VO2, MP) weight pace at 35%; easy runs at 15%. Missing pace on quality work is the strongest signal.
- **Enrichment backfill**: Existing matched activities get `hrEffortScore` and `paceAdherence` retroactively computed on next sync.
- **Adaptive plan note**: Future weeks in plan-view show a note explaining workouts adjust based on effort, HR, pace, and load safety. Includes context-aware detail (e.g. "you missed pace targets on recent quality sessions").
- **Plan engine verified**: All 8 factors (phase, VDOT, deload, effort, ACWR, injury, runner type, race distance) confirmed wired and composing correctly.

---

## 2026-03-11 — Fix: Wire effortScore + acwrStatus into all generateWeekWorkouts() call sites

- **`src/calculations/fitness-model.ts`**: Exported `getTrailingEffortScore()` (was local to `renderer.ts`) — computes trailing RPE from last 2 completed non-injury weeks
- **15 call sites wired**: `home-view.ts` (3), `plan-view.ts` (2), `events.ts` (5), `renderer.ts` (1), `main-view.ts` (1), `activity-review.ts` (1), `recording-handler.ts` (1), `timing-check.ts` (1) — all now pass `effortScore` and `wk.scheduledAcwrStatus`
- **Effect**: plan engine's duration scaling (5–15% reduction when RPE runs high) and quality session stripping (when ACWR elevated) now active everywhere, not just the main renderer

---

## 2026-03-11 — UX: Training Readiness clarity pass

- **Momentum pill** (`home-view.ts`): removed raw CTL number ("Fitness 280"), now shows just `→ Stable` / `↗ Building` / `↘ Declining`
- **Momentum detail sheet** (`home-view.ts`): replaced raw CTL comparison with plain English explanation of what Momentum means and why it's part of Training Readiness; added "See Stats" nudge
- **Stats card header** (`stats-view.ts`): renamed "Recovery" → "Training Readiness" for consistency with home page heading — the card contains Freshness, Load Safety, and ACWR alongside watch recovery data
- **Stats Momentum bar** (`stats-view.ts`): added Momentum position bar to the Training Readiness card — shows 4-week CTL trend as Building/Stable/Declining with info tooltip explaining what it means. Subtitle shows "Running Fitness: X → Y over 4 weeks" tying it to the CTL bar in the Progress card above
- **Pill sheet "View in Stats" button** (`home-view.ts`): all readiness pill popups (Freshness, Load Safety, Momentum, Recovery) now have a "View full breakdown in Stats" button at the bottom that closes the popup and navigates to the Stats tab

---

## 2026-03-11 — Feature: Durable plan backup + auto-restore from Supabase

- **`supabase/migrations/20260311_user_plan_settings.sql`**: new `user_plan_settings` table with RLS — one row per user, stores a full plan state snapshot
- **`src/data/planSettingsSync.ts`**: `savePlanSettings()` (fire-and-forget backup after every save) + `restorePlanFromSupabase()` (called only when localStorage is empty)
- **`src/state/persistence.ts`**: `saveState()` now triggers `savePlanSettings()` automatically
- **`src/main.ts`**: `launchApp()` made async; if localStorage is empty on login, silently restores from Supabase before rendering anything
- Large re-fetchable arrays excluded from snapshot (`historicWeeklyTSS`, `physiologyHistory`, etc.) — these are rebuilt from Strava/Garmin sync on first load
- Fixes the scenario where an agent or browser wipe resets the plan and the user has to manually re-enter their start date

---

## 2026-03-11 — UX: Account page redesign (iOS Settings / Whoop style)

- **`account-view.ts`**: Full HTML generation rewrite. All logic, handlers, and element IDs preserved.
  - **Profile header**: centered avatar (initials), display name, athlete tier badge
  - **Section labels**: small-caps, muted, above each group — Connected Apps · Profile · Preferences · Training History · Plan · Advanced
  - **Grouped rows**: single rounded card per section with hairline dividers between rows (no individual cards per item)
  - **Connected app rows**: inline status dot + sublabel; Sync/Remove pill buttons in trailing position
  - **Profile group**: Gender · Runner type · PBs grid · Edit Profile row
  - **Preferences group**: Distance toggle · Max HR · Resting HR · Save button — all as clean rows
  - **Training History group**: avg TSS, km/wk, tier as value rows; Rebuild + Sync History CTAs at bottom
  - **Advanced group**: Reset VDOT · Recover Plan (collapsible `<details>`) · Reset Plan — all in one card
  - **Pending activities**: compact alert banner at top of page (not a separate card)
  - **Sign Out / Exit Simulator**: full-width button at bottom, not in a card
  - Added `sectionLabel()`, `groupCard()`, `rowDivider()`, `chevron()`, `statusDot()`, `iconBox()`, `pillBtn()` helper functions to eliminate repeated inline style boilerplate

---

## 2026-03-10 — Feature: iTRIMP intensity calibration wired to matched plan sessions

- **`state.ts`**: Added `plannedType?: string | null` to `GarminActual` — stores the plan workout type at match time (e.g. `'easy'`, `'long'`, `'threshold'`, `'vo2'`).
- **`activity-matcher.ts`**: Auto-match path now stores `plannedType: match.matchedWorkout.t` on the `GarminActual` at high-confidence match time.
- **`activity-review.ts`**: Manual match paths (both the interactive review flow and the auto-assign past-week flow) now store `plannedType: classifyByName(workoutId)` for run matches, using the workout name as the label source.
- **`stravaSync.ts`**: Added `calibrateFromState()` — reads matched actuals from state, maps `plannedType` → calibration zone via `TYPE_TO_ZONE` table, and applies per-zone guard rails (easy >95 TSS/hr rejected, tempo >160 rejected) to catch mislabelled sessions (e.g. half marathon matched to easy run slot). `calibrateIntensityThresholds()` now calls `calibrateFromState()` first; falls back to the edge-fn (Strava activity name) path only if state has insufficient data. Both paths merge and share `applyCalibration()`.
- **`stats-view.ts`**: Calibration banner hidden until user has ≥5 completed tracked runs (garminActuals with iTrimp > 0 + duration > 10min). "labelled sessions" copy replaced with "matched sessions".

---

## 2026-03-10 — Feature: Load Breakdown Sheet on Home tab

- **`home-view.ts`**: Tapping the "Training Load (TSS)" row on the home page now opens a bottom sheet instead of navigating to Stats. Sheet shows: total TSS vs target, a stacked horizontal bar coloured by sport, per-sport rows with duration + mini-bar + TSS, and a planned target footer. Breakdown mirrors Signal B (full physiological cost, no runSpec discount) and uses the same dedup logic as `computeWeekRawTSS`. Sources: `garminActuals` (runs), `adhocWorkouts` (cross-training), `unspentLoadItems` (overflow).

---

## 2026-03-10 — Fix: Recovery sheet missing Sleep and HRV bars

- **`garmin-backfill/index.ts`**: Fixed Garmin Health API endpoint format — changed `startDate`/`endDate` string params to `startEpoch`/`endEpoch` Unix timestamps (seconds), which is what the API actually accepts. Old format silently returned zero dailies/sleep rows. Added diagnostic logging of sample response shape (keys + field values) so future failures are visible in Supabase function logs.
- **`physiologySync.ts`**: Increased stored history from 7 → 28 days (`.slice(-28)`). `computeRecoveryScore` needs ≥3 HRV readings in its 28-day baseline window; 7 days wasn't enough when HRV data is sparse.
- **`main.ts`**: Updated both `syncPhysiologySnapshot(7)` calls to `syncPhysiologySnapshot(28)` so the edge function actually fetches and returns 28 days of data.
- **Deployed**: `garmin-backfill` redeployed to `elnuiudfndsvtbfisaje`.

---

## 2026-03-10 — Fix: Cross-training load missing from wk.actualTSS

- **`addAdhocWorkout` + `addAdhocWorkoutFromPending`** (`activity-matcher.ts`): Both functions now accumulate Signal B TSS (raw iTRIMP, no runSpec) onto `wk.actualTSS` after adding the workout to `wk.adhocWorkouts`. Fixes ACWR being run-only — padel, gym, surf, cycling now feed fatigue correctly. Covers all six `activity-review.ts` call sites via the shared function.

---

## 2026-03-10 — Progress Card: 3-Bar Fitness System + CTL Scale Alignment

- **Progress card 3-bar system** (`stats-view.ts`): Replaced old 2-bar (CTL + VDOT) with 3 bars — Running Fitness (CTL), Aerobic Capacity (VDOT/VO2max), Lactate Threshold (LT pace). Each bar has inline ⓘ info text.
- **CTL ÷7 display scale** (`stats-view.ts`, `home-view.ts`): All CTL/ATL/TSB display values divided by 7 to match TrainingPeaks daily-equivalent scale. Internal math unchanged (weekly EMA). ATL and TSB also ÷7 in recovery card and "more detail" section.
- **6-zone Coggan CTL system** (`stats-view.ts`): Replaced 4-zone system with 6 zones — Building (<20), Foundation (20-40), Trained (40-58), Well-Trained (58-75), Performance (75-95), Elite (≥95) — matching TP community benchmarks and physiological breakpoints.
- **Aerobic Capacity bar** (`stats-view.ts`): Uses Daniels VDOT (`s.v`) for position; sex-calibrated ACSM zones (male/female breakpoints differ by ~7-10 pts). Garmin VO2max (`s.vo2`) shown as subtitle if available.
- **Lactate Threshold bar** (`stats-view.ts`): LT pace (`s.lt`, sec/km) mapped to 0-100 score (male: 360→0, 160→100; female: 380→0, 180→100). Formatted as min:ss/km. LT HR + % of max HR shown as subtitle when `s.ltHR` is available.
- **`subtitle` wired in `buildOnePositionBar`** (`stats-view.ts`): Optional secondary line rendered below zone labels.
- **athleteTier thresholds corrected** (`stravaSync.ts`): Thresholds updated to weekly-scale equivalents (beginner<140, recreational<280, trained<455, performance<630, high_volume≥630).

---

## 2026-03-09 — Batch 6: Recovery Pipeline + Week Debrief + Activity Card

- **Garmin backfill edge function** (`supabase/functions/garmin-backfill/index.ts`): Pulls N weeks of historic dailies (resting HR, max HR, HRV, stress, VO2max) + sleep from Garmin Health API. Upserts into `daily_metrics` + `sleep_summaries`. Idempotent. Called on startup in both Garmin-only and Strava+Garmin paths (ISSUE-76).
- **`triggerGarminBackfill()`** (`supabaseClient.ts`): Fire-and-forget wrapper for the backfill edge function (ISSUE-76).
- **Recovery Score** (`readiness.ts`): `computeRecoveryScore()` — composite 0–100 from HRV 45% / Sleep 35% / RHR 20%, all relative to user's 28-day personal baseline. Requires ≥3 days data (ISSUE-80).
- **Recovery card with watch data** (`stats-view.ts`): `buildRecoveryCard()` shows Recovery Score position bar + clickable sub-bars (Sleep, HRV, Resting HR with 14-day sparklines). "Connect a watch" placeholder when no data (ISSUE-80).
- **Welcome-back modal killed** (`main.ts`): `showWelcomeBackModal` trigger removed. `detectMissedWeeks()` + `recordAppOpen()` still run for state advancement (ISSUE-81).
- **Week-end debrief** (`src/ui/week-debrief.ts`): New modal sheet — phase badge, load % vs planned, distance, CTL delta, effort pacing adjustment (reads `wk.effortScore`, applies `rpeAdj` cap ±0.5). "Finish week" button added to plan page current week header. Auto-triggers on app open (guarded by `lastDebriefWeek`) (ISSUE-60, ISSUE-34 merged).
- **Activity card stats grid** (`activity-detail.ts`): Fixed 5-cell 3-column grid (Distance, Time, Avg Pace, Avg HR, Max HR) with `—` for missing fields instead of silently omitting them (ISSUE-20).
- **ISSUE-08, ISSUE-19, ISSUE-30 verified resolved**: Stats training bars and home load bars already had labels + values + colour coding. Position bars already have zone labels. No code changes needed.

---

## 2026-03-09 — Stats Page Restructure (ISSUE-72 + ISSUE-73)

- **Chart tabs** (`stats-view.ts`): Main chart card now has Load/Distance/Zones tabs at the top, replacing the hidden "Dig Deeper" accordion. All three charts are first-class, accessible with one tap.
- **Progress card** (`stats-view.ts`): New card with Running Fitness (CTL) and VDOT position bars — the "how am I improving?" section.
- **Recovery card** (`stats-view.ts`): New card with Freshness (TSB), Short-Term Load (ATL), and Load Safety (ACWR) position bars — the "am I recovering?" section.
- **Killed "Dig Deeper"** (`stats-view.ts`): Removed the old accordion and its chart switcher. Distance and Zones charts promoted to main chart card tabs.
- **Killed "Your Numbers" monolith** (`stats-view.ts`): The single 5-bar card split into focused Progress and Recovery cards.
- **"More detail" toggle** (`stats-view.ts`): Replaces "Your Numbers" accordion. Contains training bars, metrics row, ACWR gradient bar, and all folded sections.
- **No hardcoded zone splits** (`stats-view.ts`): Current week zone data returns zeros when no real HR data exists (previously fell back to 60/28/12 hardcoded split).

## 2026-03-08 — Historic Week Editing

- **Edit button on past weeks** (`plan-view.ts`): The ✎ button now appears on past week headers (`viewWeek < s.w`) instead of only the current week. Sheet message updated to explain past-week editing.
- **Past-week RPE / skip buttons** (`plan-view.ts`): `buildWorkoutExpandedDetail` now accepts `currentWeek` param. For past weeks, Mark Done and Skip buttons are enabled — same as current week — unless the workout has a `garminActual` match.
- **Synced-from-watch guard** (`plan-view.ts`): Workouts matched to a Garmin/Strava activity show a "Synced from watch/Strava" read-only label instead of action buttons when viewing a past week.
- **Activity day placement** (`plan-view.ts`): `buildWorkoutCards` now pre-computes effective day-of-week from `garminActual.startTime` for each workout. Cards appear in the day column when the activity was actually performed, not the originally planned day.

## 2026-03-08 — Garmin Token Refresh System

- **New edge function** (`supabase/functions/garmin-refresh-token/index.ts`): Accepts user JWT, looks up `refresh_token` from `garmin_tokens`, calls Garmin OAuth2 token endpoint with `grant_type=refresh_token`, updates DB with new tokens + `expires_at`.
- **Auto-refresh on connect check** (`src/data/supabaseClient.ts`): `isGarminConnected()` now queries `expires_at` — if expired, calls `refreshGarminToken()` before returning. New exported `refreshGarminToken()` function.
- **Account page health info** (`src/ui/account-view.ts`): Garmin card shows "Connected · Last sync: [date]" (from latest `daily_metrics.day_date`) when healthy, or "Token expired" (amber dot) when refresh fails.
- **Webhook logging** (`supabase/functions/garmin-webhook/index.ts`): `handleDailies()` and `handleSleeps()` now log successful upserts with user ID and date.

## 2026-03-08 — Copy Audit (ISSUE-21)

- **Recovery labels** (`main-view.ts`): "Recovery: Log today" → "How are you feeling?", "Recovery: Good" → "Feeling good", "Recovery: Low — Tap to adjust" → "Feeling rough — tap to adjust".
- **Plan today card** (`plan-view.ts`): Removed 🏃 emoji, "Today's planned run" → "Today".
- **Welcome-back modal** (`welcome-back.ts`): Bullet-point copy → plain sentences without `•` prefix.
- **Wizard runner-type** (`runner-type.ts`): "Based on your personal bests, we've assessed your running style." → "Here's your running style, based on your race times."

## 2026-03-08 — Forecast Times Section

- **Forecast times** (`stats-view.ts`): New collapsible section in Stats Advanced area showing predicted 5K, 10K, Half Marathon, and Marathon times based on current VDOT. Uses `vt()` from `vdot.ts`. Gated on ≥4 weeks of historic TSS data or `stravaHistoryFetched`. Appears before Race Prediction fold.

## 2026-03-05 — Training Readiness TSB Signal Fix (Batch 3.2)

- **Root cause fixed** (`fitness-model.ts`): Cross-trainers were getting permanently negative TSB because the mixed-signal model uses Signal A (runSpec-discounted) for CTL but Signal B (full physiological) for ATL — creating a structural gap that shows as chronic fatigue even at steady state. This is correct for load management but wrong for readiness.
- **`computeSameSignalTSB()`** (`fitness-model.ts`): New exported function. Uses Signal B for both CTL and ATL with the same seed, so steady-state TSB converges near 0. ATL inflation from `acwrOverridden`/`recoveryDebt` still applied. `CTL_DECAY` and `ATL_DECAY` constants exported.
- **Wired in readiness ring** (`home-view.ts`): `buildReadinessRing` and the pill info sheet handler both now compute `tsb` and `ctlNow` from `computeSameSignalTSB` instead of the mixed-signal model. Original metrics still used for `ctlFourWeeksAgo` (momentum signal).
- **Tests** (`fitness-model.test.ts` new, `readiness.test.ts`): 6 new `computeSameSignalTSB` unit tests (null, steady-state, spike, light week, seed, decay constants) + 2 readiness integration tests for cross-trainer scenario. **748 total tests passing**.

## 2026-03-05 — Training Readiness UX Polish (Batch 3.1)

- **ISSUE 1** (`home-view.ts`): Driving signal pill now has coloured left border (`border-left: 3px solid var(--c-warn)`) and "⬇ Main factor" label — user immediately sees which sub-metric is pulling the score down.
- **ISSUE 2** (`home-view.ts`): Each pill (`data-pill="fitness|safety|momentum|recovery"`) is individually tappable. Tap opens a bottom-sheet info sheet with: current value, zone label, plain-English explanation, scale bar with position marker, and "What to do" advice. Event propagation stopped so pill tap doesn't also toggle the card.
- **ISSUE 3** (`home-view.ts`): Removed flawed "second tap = action" behaviour. Ring card now just toggles pills open/closed. When readiness ≤ 59 an "Adjust today's session" button appears inside the pills panel — text varies by driving signal (Swap to easy run / Reduce session load / Take it lighter today / Keep consistency). Button routes to `triggerACWRReduction()`.
- **ISSUE 4** (`home-view.ts`): Momentum pill sub-caption changed from "CTL 195" → "Fitness 195" — no jargon.
- **ISSUE 5** (`home-view.ts`): Deleted `buildSignalBars()` and `buildSparkline()` dead code (~220 lines).
- **ISSUE 6** (`home-view.ts`): Recovery pill value colour now reflects actual score (amber < 65, red < 40) instead of always green.

## 2026-03-05 — Training Readiness Ring + No Jargon cleanup

- **Training Readiness Ring** (`src/calculations/readiness.ts`, `src/ui/home-view.ts`): New composite 0–100 score on the Home page. Four sub-signals: Freshness (TSB), Load Safety (ACWR), Momentum (CTL trend), Recovery (sleep/HRV when available). Safety floor: ACWR > 1.5 caps score ≤ 39, ACWR 1.3–1.5 caps ≤ 59. Labels: Ready to Push / On Track / Manage Load / Ease Back. Ring tap expands sub-metric pills; second tap triggers reduction or Stats. Replaced `buildSignalBars()` + `buildSparkline()`. **26 tests** all passing.
- **Bug fix** (`readiness.ts`): `clamp()` argument order was wrong (`clamp(0, 100, expr)` → always returned 100). Fixed to `clamp(expr, 0, 100)` — sub-scores now computed correctly.
- **No Jargon** (`src/ui/main-view.ts`, `src/ui/stats-view.ts`): Renamed all user-facing jargon per spec. "Injury Risk" → "Load Safety" (plan tab bar + info sheet). "Fitness (CTL)" → "Running Fitness (CTL)". "Fatigue (ATL)" → "Short-Term Load (ATL)". "Form (TSB)" → "Freshness (TSB)". "Fitness, Fatigue & Form" → "Running Fitness, Load & Freshness". "High risk" → "High Risk" (capitalised, injury language removed).
- **Stats page "Your Numbers"** (`src/ui/stats-view.ts`): 5 Garmin-style horizontal position bars added to the "Advanced" section (renamed "Your Numbers"): Running Fitness, Short-Term Load, Freshness, VDOT, Load Safety — each with zone segments and a marker pin.

## 2026-03-05 — Batch 2: load calc, skip logic, cardiac efficiency, injury link, modal copy, km/mi, phases, plan bar, sync button

- **ISSUE-57/42**: `stravaSync.ts` — `fetchStravaHistory` and `backfillStravaHistory` now filter out the current in-progress week before storing to `historicWeeklyTSS` / `historicWeeklyRawTSS` / `historicWeeklyKm` / `historicWeeklyZones`. The edge function always returns the current partial week; storing it caused an off-by-one shift that made Fix 4 in `getChartData` backfill the wrong plan week. Near-zero load for the most recent completed week is now correctly shown.
- **ISSUE-16**: `events.ts` — General fitness / continuous mode second skip now shows "Drop It / Keep It" confirmation dialog instead of silently auto-dropping. Race-time penalty (`s.timp`) only applied in race mode. First skip (push to next week) was already correct in both modes.
- **ISSUE-48**: `events.ts` + `lt-estimator.ts` — Cardiac Efficiency Trend now only records Z2 HR data points (gate added before `recordEfficiencyPoint`). Added >10% improvement significance threshold in `estimateFromEfficiencyTrend()`. This prevents recovery-pace easy runs and aerobic-threshold runs from polluting the trend and causing spurious VDOT decline.
- **ISSUE-09**: `home-view.ts` — ACWR risk caption now identifies and names the top-contributing activity (highest Signal B TSS) from `garminActuals` + `adhocWorkouts`. High/caution captions include top contributor and "Tap to adjust your training plan" CTA.
- **ISSUE-10**: `suggestion-modal.ts` — `acwrHeader` rewrites lead sentence from ACWR ratio to human consequence ("You've been training X% harder than usual"). Titles changed to "Heavy training week" / "Load building up". ACWR ratio preserved in the "See details" panel.
- **ISSUE-31**: `state.ts` + `format.ts` + `account-view.ts` + `home-view.ts` + `stats-view.ts` + `activity-detail.ts` — KM/Mile toggle. Added `unitPref: 'km' | 'mi'` to state, `formatKm()` utility, Preferences card with segmented control in Account. Distance displays updated across all key views.
- **ISSUE-32**: `plan-view.ts` — Phase now shows as a colour-coded badge (Base=blue, Build=orange, Peak=red, Taper=green) in the plan week header next to the date. Added `phaseBadge()` + `PHASE_COLORS` helpers.
- **ISSUE-26/45**: `plan-view.ts` — Replaced "Week load: X TSS planned · Y so far" text with a visual progress bar (accent bar, planned vs actual TSS). Shown for current and future weeks; past weeks retain the TSS badge.
- **ISSUE-27**: Confirmed already resolved — Sync Strava was never in plan-view; it lives correctly in account-view.ts. Marked as done in OPEN_ISSUES.md.

## 2026-03-05 — Bug batch 2: build unblocked, GPS splits, ACWR consistency, recovery bar, TSS dedup

- **ISSUE-64**: Unblocked production build — 42 TS errors → 0. `tsconfig.json` now excludes `src/scripts/` + `src/testing/`. Created `src/vite-env.d.ts` for `import.meta.env` types. Fixed `InjuryType` (`'overuse'` → `'general'`) and `CapacityTestType` (`'walk_10min'` → `'pain_free_walk'`) in test fixtures. Cast renderer's `(w as any).status === 'passed'` to preserve capacity test badge. Added `rateCapacityTest` to `Window` interface. Deleted 60-line unreachable block in `initializing.ts`.
- **ISSUE-65**: GPS per-km splits now work — wired `buildKmSplits()` into simple distance, dist@pace, progressive easy portion, and added `Xkm [description]` catch-all. 5 failing GPS tests → all 714 passing.
- **ISSUE-66**: ACWR `atlSeed` now consistent across all 12 call sites — applied gym-inflation formula to 9 missing sites in `home-view.ts`, `main-view.ts`, `stats-view.ts`, `renderer.ts`, `events.ts`, `activity-review.ts`. Added missing `planStartDate` to `stats-view.ts:428`.
- **ISSUE-67**: Recovery bar direction fixed — was `100 - recoveryPct` (wide = bad), now `recoveryPct` (wide = good).
- **ISSUE-68**: `computeWeekTSS` (Signal A) now deduplicates by `garminId` — prevents double-counting activities in both `garminActuals` and `adhocWorkouts`. Likely root cause of ISSUE-42/57.
- **ISSUE-69**: Suggestion modal ACWR details panel — removed duplicate `display:none` that immediately overrode `display:flex`. Toggle now works correctly.

## 2026-03-05 — Issue batch 1: deload week check-in guard + doc fixes

- **ISSUE-54** (already resolved): Confirmed duplicate "Running Fitness" sections in suggestion modal were removed in 2026-03-04 jargon cleanup. No code change needed.
- **ISSUE-17**: `main-view.ts` + `plan-view.ts` — benchmark panel now returns `''` on deload weeks. Added `isDeloadWeek` + `abilityBandFromVdot` checks to `renderBenchmarkPanel` / `buildBenchmarkPanel`. Hard efforts (threshold, speed, race sim) never presented on recovery/deload weeks.
- **ISSUE-53**: `home-view.ts` — `buildTodayWorkout` and "next workout" finder now apply `wk.workoutMoves` before searching by day. Moving a workout on Plan tab now correctly reflects in Home view today card and upcoming label.
- **ISSUE-23**: Confirmed already fixed — stats chart legend reads "Your running base" (no hardcoded week count).
- **ISSUE-39**: `welcome-back.ts` — `WELCOME_BACK_MIN_HOURS` raised from 20 → 24. Welcome back modal now suppressed if app was opened within the last 24 hours.
- **ISSUE-56**: `stats-view.ts`, `suggestion-modal.ts`, `home-view.ts` — replaced all "reduce one session" copy with load-based language ("shorten or ease remaining sessions", "reducing intensity or duration").
- **ISSUE-24**: `stats-view.ts` + `main-view.ts` — "Building baseline" gate raised from `< 3` to `< 4` weeks. "Calibrating intensity zones" already properly gated.
- **ISSUE-59**: `home-view.ts` — gym session Home card now appends "Gym Session" to name if missing. Exercises (newline-separated in workout `d` field) render as a `<details>` expandable list below the workout title.
- **ISSUE-50** (already present): Load chart footnote confirmed at `stats-view.ts:265`. No code change.

## 2026-03-04 — Stats chart fixes: single area, range slicing, Monday anchoring, near-zero fallback, Signal A running chart

- **Fix 1** `buildLoadHistoryChart`: removed fake aerobic/intensity split (was hardcoded 88%/12% when zone data absent). Replaced with a single clean blue area (`rgba(99,149,255)`). Legend simplified to "Total load (all sports)" + ref line entries only.
- **Fix 2** `getChartData`: range slicing now applied before appending current week — `8w` slices to last 8, `16w` to last 16, `all` unsliced. `histWeekCount` reflects the sliced length.
- **Fix 3** `buildLoadHistoryChart`: week labels now anchored to Monday of the current ISO week. Rightmost label still shows today's date.
- **Fix 4** `getChartData`: for any of the last 4 hist entries where TSS < 5 (Strava edge fn gap), falls back to live `computeWeekRawTSS` from plan data. Fixes near-zero display for Feb 25 week.
- **Fix 5** `buildRunningFitnessChart`: replaced flat CTL-only sparkline with weekly Signal A area chart (green). CTL now a dashed reference line overlay. Caption updated. x-axis uses same Monday-anchor.

## 2026-03-04 — Phase 10: Adjust Week button + carry-over card in plan-view

- `plan-view.ts`: Added `buildAdjustWeekRow()` — context-sensitive button ("Adjust week / Review session changes / Resolve X TSS extra load") shown when `hasPendingExcess || hasUnacceptedTimingMods`. Wired to `triggerExcessLoadAdjustment()`.
- `plan-view.ts`: Added `buildCarryOverCard()` — orange card at top of plan list when `wk.hasCarriedLoad && !wk.carryOverCardDismissed`. Tap → `triggerExcessLoadAdjustment()`; dismiss × → sets `wk.carryOverCardDismissed = true`.
- `persistence.ts`: Sets `currWk.hasCarriedLoad = true` when unresolved load items are carried from previous week.
- `excess-load-card.ts`: Exported `triggerExcessLoadAdjustment` so plan-view can import it directly.
- `home-view.ts`: Removed "Adjust week →" button and its event handler — button now lives exclusively in plan-view. Caption ("You have unresolved cross-training load this week.") retained.
- `types/state.ts`: Added `hasCarriedLoad?: boolean` and `carryOverCardDismissed?: boolean` to `Week` interface (done in previous session).

## 2026-03-04 — Fix: TSS signal consistency (B1/B2/B3/B5/B6)

- **B1** `home-view.ts` `buildProgressBars`: switched `tssActual` from `computeWeekTSS` (Signal A) to `computeWeekRawTSS` (Signal B) — home load bar now shows honest total physiological load per PRINCIPLES.md
- **B2** `stats-view.ts` `getChartData`: 8-week Training Load chart now uses Signal B throughout. Uses `historicWeeklyRawTSS` when available, falls back to `historicWeeklyTSS × 1.4` proxy (PRINCIPLES.md sanctioned). Eliminates false spike caused by stitching Signal A history with Signal B current week.
- **B3** `home-view.ts` `buildSignalBars`: added same `atlSeed` inflator as `buildAdvancedSection` in `stats-view.ts`. Home and Stats now compute ACWR identically — closes ISSUE-55.
- **B5** `plan-view.ts`: switched `_actualTSS` (plan load line) from Signal B to Signal A — both sides of "X planned · Y so far" are now run-equivalent, apples-to-apples.
- **B6** `stats-view.ts`: renamed "Zones" tab to "Running Zones" — makes clear this chart shows run-derived data only (stays Signal A per design).

## 2026-03-04 — Fix: TSS double-count in computeWeekRawTSS (ISSUE-42)

- **Bug fix** `fitness-model.ts` `computeWeekRawTSS()`: added `seenGarminIds` Set to deduplicate
  across all three sources (`garminActuals`, `adhocWorkouts`, `unspentLoadItems`). Previously,
  after a cross-training session was approved via the suggestion modal it landed in `adhocWorkouts`
  AND contributed to `wk.actualTSS`; `computeWeekRawTSS` (called by Stats page and ACWR) would
  then recount it from `adhocWorkouts`, inflating the displayed TSS by ~28–40 TSS for a typical
  tennis/HIIT session. The dedup check strips the `garmin-` prefix from adhoc workout IDs to
  match the raw garminId stored in `garminActuals` and `unspentLoadItems`.

## 2026-03-04 — Phase 8 + 9: Tier 1 auto-reduce + Tier 2 card reframe

- **New** `getWeeklyExcess(wk, baseline, planStartDate)` exported from `fitness-model.ts`:
  Signal B total for the week minus `signalBBaseline`. Returns 0 if no baseline set.
- **Tier 1 auto-reduce** (`activity-review.ts` `autoProcessActivities`): when excess ≤ 15 TSS
  above baseline, the nearest unrated easy run is silently reduced (distance via ~5.5 TSS/km at
  RPE4). Stores `WorkoutMod` with `modReason: "Auto: …"` and `autoReduceNote`. `unspentLoadItems`
  remain in state so undo works.
- **Plan card** (`plan-view.ts`): auto-reduced easy runs show a note row below the card header
  with the reduction summary and an **Undo** button. Undo removes all `Auto:` mods; excess card
  reappears automatically.
- **Tier 2 card** (`excess-load-card.ts`): hidden when Tier 1 `Auto:` mod exists; hidden when
  excess is <15 TSS or >40 TSS (baseline known); label reframed to `"X TSS above your usual
  weekly load"` instead of `"X TSS unspent"`.
- **`WorkoutMod`** interface: added optional `autoReduceNote?: string`.

## 2026-03-04 — Phase 7: Timing check — day-proximity quality session downgrade

- **New** `src/cross-training/timing-check.ts`: `applyTimingDowngradesFromWorkouts()` scans
  each unrated quality session (threshold/vo2/long) and checks if a Signal B ≥ 30 TSS activity
  was completed the day before (dayOfWeek - 1 mod 7). If so, generates a WorkoutMod:
  threshold → marathon pace, vo2 → threshold, long → −15% km (if Signal B ≥ 50 TSS).
  `mergeTimingMods()` integrates with state — generates workouts via `generateWeekWorkouts`,
  replaces old Timing: mods in `wk.workoutMods`, returns true if anything changed.
- **Wired** into `activitySync.ts` and `stravaSync.ts`: `mergeTimingMods()` called after each
  sync, saves state only when mods changed.
- **Plan card** (`plan-view.ts`): amber badge "Adjusted — hard session yesterday" shown on
  affected unrated quality sessions. Expanded detail panel shows explanation + adjusted pace
  label + "Move this session to a different day for full intensity." note.
- Mods are computed fresh every sync — automatically clear when activity or session is rescheduled.
- modReason in `wk.workoutMods` now also patched onto workout object during `getPlanHTML()`.

## 2026-03-04 — Signal B baseline: edge function + state fields

- **Edge function** (`sync-strava-activities`): `history` mode now returns `rawTSS` (Signal B)
  alongside existing `totalTSS` (Signal A). New `getRawFallbackTSS()` computes raw physiological
  load without runSpec discount for no-HR activities. Sport breakdown now includes `rawTSS` and
  `sessionCount` per sport per week. Deployed to `elnuiudfndsvtbfisaje`.
- **State** (`src/types/state.ts`): Added `historicWeeklyRawTSS`, `signalBBaseline`,
  `sportBaselineByType` fields.
- **Client** (`src/data/stravaSync.ts`): `fetchStravaHistory()` now populates all three new
  state fields. `signalBBaseline` = simple 8-week average of raw weekly TSS. `sportBaselineByType`
  = per-sport avg session rawTSS + sessions/week (Phase 2 calibration data, not yet consumed).
  Backward-compatible: `rawTSS ?? totalTSS` fallback if old edge fn cached response used.
- **Closes ISSUE-52** (Signal B edge function gap). ISSUE-51 (v2 rebuild) next.

## 2026-03-04 — Cross-training load management v2 design

- **Design session**: Diagnosed and documented the reduce/replace logic gaps (ISSUE-51, ISSUE-52).
- **PRINCIPLES.md**: Added "Cross-Training Load Management — Excess & Reduction Logic" section
  with three-tier response model, Signal B baseline definition, timing sensitivity rules,
  high-intensity sport handling, quality session independence, and "Adjust Week" UX moment.
- **FEATURES.md**: Added §18b spec for full v2 rebuild — not yet built.
- **OPEN_ISSUES.md**: Added ISSUE-51 (v2 rebuild), ISSUE-52 (Signal B edge function gap).

## 2026-03-04 — VDOT bug fix + history display

- **physioAdj clamp** (`events.ts`): All code paths that set `s.physioAdj` now clamp the value to `Math.max(-5.0, rawAdj)`. A physioAdj below -5.0 is implausible and was causing VDOT to drop 2.5 pts when stale LT data triggered `applyAutoLTUpdate`.
- **`applyAutoLTUpdate` warning log**: Added `console.warn` when the clamp fires so debugging is easier in future.
- **`syncPhysiologySnapshot` LT sanity check** (`physiologySync.ts`): If the Garmin-supplied `lt_pace_sec_km` would imply a VDOT more than 8 pts from `s.v`, it is silently skipped and logged. Prevents stale Garmin LT measurements from corrupting `s.lt`.
- **VDOT history** (`state.ts`, `events.ts`): Added `vdotHistory?: Array<{week, vdot, date}>` to `AppState`. `recordVdotHistory()` helper appended after every VDOT-changing event: `rate()` (when RPE changes VDOT), `applyAutoLTUpdate()`, `updateFitness()`, `recordBenchmark()`, and `next()` (week advance). Capped at last 20 entries.
- **VDOT sparkline + change note** (`stats-view.ts`): `buildFoldedPaces` now shows a SVG sparkline of `vdotHistory` below the VDOT number. Shows colour-coded change note: "↓ X pts since [date]" or "↑ X pts" or "Steady". Helpers: `buildVdotSparkline()`, `buildVdotChangeNote()`.
- **VDOT info button** (`stats-view.ts`): Added `buildInfoIcon('vdot')` next to "Current VDOT" label. Tapping reveals an inline explanation. Added `'vdot'` entry to `INFO_TEXTS`.

---

## 2026-03-03 — Signal A/B round 2: narrative/bar fixes, ATL seed, dual badge

- **Narrative sentence** switched to Signal B (`computeWeekRawTSS`) — drives "should I rest?" decisions, must use raw fatigue not running-equiv
- **"Total Load vs Plan" bar** in Advanced: switched to Signal B, renamed, added "Includes runs, gym & cross-training at full physiological weight" note
- **Load chart current week**: Signal B; historical bars remain Signal A (edge fn deferred); legend footnote explains the mix
- **ATL seed split**: `computeFitnessModel` + `computeACWR` now take optional `atlSeed` param. Callers pass `ctlBaseline × (1 + 0.1 × gymSessions)` capped at 1.3×. Cross-training-heavy athletes start with elevated ACWR from day 1
- **"This Week" card**: sub-label → "vs your running base"; no-baseline label → "total load (runs + gym + sport)"
- **Plan-view badge**: shows `X run · Y total` when Signal B > Signal A × 1.15; `title` tooltip explains both numbers

---

## 2026-03-03 (continued) — Garmin physiology pipeline fixes + all-time Max HR

- **`sync-physiology-snapshot` response shape changed** — now returns `{ days, maxHR }` envelope; `maxHR` is the all-time peak across all `garmin_activities` (Garmin + Strava), not today's daily value.
- **`physiologySync.ts` updated** — `callEdgeFunction` typed as `PhysiologyResponse`; `data.maxHR` applied to `s.maxHR` (replaces per-day `latest.max_hr`); `rows` extracted from `data.days`.
- **Physiology charts: min 3 data points** — `miniChart()` in both `main-view.ts` and `stats-view.ts` now shows "Building history…" until 3+ valid values exist (was 2).

---

## 2026-03-03 — Signal A/B load model split + stats two-chart redesign

- **`computeWeekRawTSS()` added** (`fitness-model.ts`) — Signal B function: same as `computeWeekTSS` but removes `runSpec` discount from adhoc cross-training and unspent load items. Skips `actualTSS` fast-path (stored value is Signal A). Raw iTRIMP for garminActuals unchanged.
- **`computeFitnessModel()` ATL split** — CTL now uses Signal A (run-equivalent, `computeWeekTSS`); ATL now uses Signal B (total physiological, `computeWeekRawTSS`). ACWR ratio = Signal B fatigue / Signal A fitness. Cross-training weeks now correctly raise ACWR.
- **`FitnessMetrics` extended** — added `rawTSS: number` field (Signal B for each week).
- **`strength` runSpec 0.30 → 0.35** (`sports.ts`) — compound leg work has partial but real transfer to running; Signal B (ATL) is unaffected by runSpec.
- **Stats: Running Fitness chart** (`stats-view.ts`) — new `buildRunningFitnessChart()` renders a green CTL sparkline below the summary cards. Shows current CTL value + trend arrow.
- **Stats: This Week card** — switched `currentTSS` to `computeWeekRawTSS` (Signal B — honest total week fatigue).
- **Stats: Advanced labels** — "Fitness (CTL)" → "Running Fitness (CTL)" + sub-label "run-equivalent · 42-day avg"; ATL sub-label "total load · 7-day avg"; updated ⓘ tooltips explaining Signal A/B split.
- **Stats: CTL range card** — new gradient bar (0–120 scale) in Advanced section showing Beginner/Recreational/Trained/Performance/Elite bands with verbal explanation.
- **Stats: Legend rename** — "Aerobic TSS" → "Aerobic (all sports)"; "Anaerobic TSS" → "High intensity".
- **Plan view: week TSS badge** — completed week headers now show a muted `XX TSS` chip (Signal A, run-equivalent). Future weeks show nothing.
- **`docs/PRINCIPLES.md`** — added Initialization Principle section (aerobic base gap, Signal B history gap TODO, conversion framing).
- **`docs/LOAD_MODEL_PLAN.md`** — created tracking document with per-phase status, testing instructions, and deferred items.

---

## 2026-03-03 — Garmin physiology card: all 6 metrics, trend arrows, tap-to-expand graph

- **Physiology card rewritten** (`renderPhysiologyCard` in `main-view.ts`) — now shows all 6 Garmin metrics: Resting HR, Max HR, HRV (RMSSD), VO2max, LT Pace, LT Heart Rate. Each metric conditionally renders only when data is present.
- **Trend arrows** — each metric compares latest value against the 7-day rolling average and shows a coloured ↑/↓ arrow (green = improving, red = declining; direction aware of whether higher is better per metric).
- **Dot sparkline** — existing 7-dot history row kept; dot size encodes relative position in range.
- **Tap-to-expand SVG chart** — each metric row is a `<details>/<summary>` element. Tapping opens an inline SVG polyline chart of the 7-day history with date labels.
- **`PhysiologyDayEntry` extended** (`state.ts`) — added `maxHR`, `ltPace`, `ltHR` fields.
- **History mapping updated** (`physiologySync.ts`) — maps `max_hr`, `lt_pace_sec_km`, `lt_heart_rate` from edge fn response into history entries.
- **`buildFoldedRecovery` updated** (`stats-view.ts`) — adds Max HR, LT Pace, LT HR to the 2-column metrics grid in the stats Recovery & Physiology fold.

---

## 2026-03-03 — Garmin pipeline: critical 401 fix, resolveUserId fallback, LT heart rate wired through

- **Root cause: garmin-webhook returning 401 on every Garmin push** — Supabase edge functions require a JWT by default. Garmin Health API is an external server with no Supabase JWT, so every webhook POST was rejected with 401 before reaching any code. All Garmin data (dailies, sleeps, userMetrics) has been silently dropped. Redeployed `garmin-webhook --no-verify-jwt` to allow unauthenticated POSTs from Garmin's servers.
- **`resolveUserId` fallback** — added `access_token` secondary lookup in case `garmin_user_id` was never stored by auth callback (silent try/catch failure). Now tries stable Garmin user ID first, then OAuth token.
- **LT heart rate wired through** — `physiology_snapshots.lt_heart_rate` was stored by webhook but never queried. Added to `sync-physiology-snapshot` select, `PhysiologyRow` interface, `PhysiologySnapshot` return type, state assignment (`s.ltHR`), and `SimulatorState.ltHR`.

---

## 2026-03-03 — TSS: fix carry-over unspentLoadItems inflating current week load

- **`unspentLoadItems` date attribution fixed** — items carried over from previous weeks (via `loadState` carry-over logic) were being counted in the current week's `computeWeekTSS`, inflating TSS (e.g. 170 shown vs ~30 actual). Added `planStartDate?` param to `computeWeekTSS`, `computeFitnessModel`, and `computeACWR`. When provided, `unspentLoadItems` are filtered to only those whose `date` falls within the week's 7-day window (`planStartDate + (w-1)*7` to `+7`). Carry-over items retain their original dates so they correctly contribute to the week they occurred in. All callers updated to pass `s.planStartDate`.
- **ACWR now correctly elevated by historic overflow** — week 2's overflow load (Tennis, Bouldering, Run) now counts in week 2's TSS → ATL is appropriately elevated going into week 3 → ACWR suggests reducing if needed.

---

## 2026-03-03 — Home view: fix session count, make TSS row tappable

- **Session count bug fixed** — "Sessions" in the "This Week" card was always 0 when activities were synced from Strava/Garmin, because it only counted `wk.rated` entries (RPE ratings). Strava/Garmin sync writes to `wk.garminActuals` and sets `wk.actualTSS` without touching `wk.rated`, causing TSS to be e.g. 131 while sessions showed 0. Fixed: `sessionsDone` now takes the max of synced sessions (`wk.garminActuals` keys + garmin-/strava-prefixed adhocWorkouts) and rated sessions, so whichever source has data wins.
- **TSS row tappable** — "Training Load (TSS)" row in the "This Week" card now navigates to the Stats tab on tap, so users can see the activity breakdown that makes up that number. Added a subtle → arrow indicator.

---

## 2026-03-03 — History mode dedup: fix Garmin+Strava double-counting

- **Double-counted activities fixed** — `history` mode in `sync-strava-activities` was summing both the Garmin webhook row (`garmin_id = "12345"`, no iTRIMP) and the Strava backfill row (`garmin_id = "strava-12345"`, with iTRIMP) for the same physical workout. Added a deduplication pass over the sorted rows: activities with start times within 2 minutes are collapsed into one, keeping the row with iTRIMP (Strava-processed) over the duration-fallback Garmin row. Logs `[History] Deduped N duplicate rows` when overlap is detected. This was inflating the peak week TSS (712 shown vs ~465 expected).

---

## 2026-03-03 — Garmin pipeline fixes: resolveUserId fallback, LT heart rate wired through

- **`resolveUserId` silent-drop bug fixed** — webhook `resolveUserId` only looked up by `garmin_user_id`. If the auth callback's `/user/id` fetch failed (swallowed by try/catch), `garmin_user_id` was never stored → every incoming webhook payload resolved to `null` → all Garmin data silently dropped (webhook still returns 200 to avoid Garmin retries). Added `access_token` fallback: if `garmin_user_id` lookup misses, tries `.eq("access_token", identifier)` so data is matched even without the stable Garmin user ID.
- **LT heart rate wired through** — `physiology_snapshots.lt_heart_rate` (stored by webhook's `handleUserMetrics`) was never queried. Fixed `sync-physiology-snapshot` edge function to select and return it. Added `lt_heart_rate` to `PhysiologyRow` in `physiologySync.ts` and apply to `s.ltHR`. Added `ltHR?: number` to `SimulatorState`.
- **`PhysiologySnapshot` return type updated** — `ltHR: number | null` added alongside existing `vo2`, `restingHR`, `maxHR`, `ltPace`.

---

## 2026-03-03 — Stats chart: Y-axis scale, peak annotation, distance chart range fix; backfill HR rounding fix

- **Y-axis TSS scale** — load history chart now shows TSS value labels (e.g. 100, 200, 300…) as absolute-positioned HTML overlays on the chart. Labels use rounded tick steps based on the max value so they're always legible.
- **Peak week annotation** — the highest-TSS week in the chart now shows its TSS value in orange above the peak (e.g. "465 TSS"). Makes it easy to verify spikes visually.
- **Distance chart respects range** — `buildDistanceAreaChart` now accepts `range` param; when 16w/All is selected in the main range toggle, the distance chart in "Dig deeper" uses `extendedHistoryKm` instead of the 8-week `historicWeeklyKm`. Switching the range also refreshes the distance chart.
- **Backfill HR float bug fixed** — Strava returns `average_heartrate` and `max_heartrate` as floats (e.g. `120.1`) but `garmin_activities.avg_hr/max_hr` are `smallint`. Every backfill upsert for 74 activities was failing with "invalid input syntax for type smallint". Now rounds to `Math.round()` in all three upsert paths (step 6 full-stream, step 7 avg-HR batch, standalone). Edge function deployed.

## 2026-03-03 — Strava history: actual HR zone data for chart accuracy (round 4)

- **History mode uses real HR zone data** — the history mode query now fetches `hr_zones` and uses the actual per-second zone distribution (z1-z5) when available, instead of always estimating from TSS/hr intensity. For activities processed with full Strava HR streams (most runs), the chart now accurately shows exactly how much time was spent in each zone. Falls back to `estimateZoneProfile` for activities that only have avg_heartrate.
- **Debug log enhanced** — zone classification source now shown in `[History:row]` logs as `(hr)` for actual zones or `(est)` for estimated.
- **MOUNTAIN_BIKING type fixes** — `getRunSpec` now correctly returns 0.55 (was falling through to 0.40 generic since "MOUNTAIN_BIKING" doesn't contain "CYCLING" or "RIDE"). `getSportLabel` now returns "cycling" instead of "other". `getDurationFallbackTSS` now 0.40 TSS/min explicitly (same as road cycling).
- **Edge function deployed** (`sync-strava-activities`).

---

## 2026-03-03 — Strava history: diagnostics, zone classification fix, and backfill improvements (round 3)

- **`rawTSS` bug fixed** — history mode crashed with `ReferenceError: rawTSS is not defined` on line 434 due to variable rename during Load System refactor. Every history fetch since that commit was silently failing → chart was stuck on old cached state.
- **All-zero hr_zones no longer blocks re-processing** — activities stored without HR data get `{z1:0,…z5:0}` in DB which is truthy, so they were stuck in `cachedWithZones` forever. Backfill now checks if zone values sum > 0; all-zero → `cachedBasic` so next backfill re-attempts avg_heartrate iTRIMP.
- **Standalone + backfill upserts store `hr_zones: null`** instead of all-zero object when no HR stream is available — prevents future stuck activities.
- **Zone classification uses raw (pre-rs-discount) iTRIMP intensity** — previously, HIIT/Hyrox/climbing showed as aerobic because their rs-discounted equivTSS/hr was < 70. Now `estimateZoneProfile` uses raw iTRIMP TSS/hr so high-intensity cross-training correctly shows orange (anaerobic) bars.
- **`cachedBasic` skip fix** — activities in DB without iTRIMP were permanently skipped on re-backfill; now only skip if `cachedBasic` AND has iTRIMP.
- **`activity_name` saved** — added to standalone and both backfill upserts so iTRIMP calibration can work.
- **Activity type re-upsert in backfill** — new step 8 force-updates `activity_type` + `activity_name` for ALL Strava activities, fixing stale types stored by old edge fn versions (e.g. `CARDIO` → `BACKCOUNTRY_SKIING`).
- **Per-week Strava log** — backfill now logs `[Backfill:strava] Week YYYY-MM-DD: N activities` for every week Strava API returns, enabling direct comparison with DB history to find gaps.
- **Per-activity history log** — history mode logs every activity with type, duration, iTRIMP, equivTSS, zone classification.
- **`backfillStravaHistory` populates extended history** — after a 16-week backfill, `extendedHistoryTSS/Km/Zones` are also populated so the stats "16w" button works immediately without a second round-trip.
- **`historicWeeklyTSS` trimmed to last 8 weeks** after backfill (extended history holds the full 16w).
- **Startup threshold raised** — auto-backfill triggers when `historicWeeklyTSS.length < 8` (was < 3).

---

## 2026-03-03 — Fix silent upsert failures blocking backfill from storing activities

- **Root cause identified** — `activity_name` column included in all `garmin_activities` upserts (standalone + backfill modes) but the DB migration had not been applied to production. Supabase returns an error from upsert but without error checking the code silently incremented the counter and continued, so every backfill "processed" 79 activities without storing any.
- **Fix** — removed `activity_name` from all upserts in both standalone and backfill modes. Added explicit error checking (`const { error } = await supabase.upsert(...)`) with `console.error` so future failures are visible in edge function logs.
- **Calibrate mode guarded** — if the `activity_name` column is missing, calibrate returns `[]` instead of a 500 error.
- **Standalone mode fixed** — also removed `activity_name` from SELECT cache query and single-column backfill update; upsert errors now logged.
- **Edge function deployed** — `sync-strava-activities` redeployed. On next backfill run, activities will actually persist to DB and history will expand beyond 2 weeks.
- **Migration note** — `20260302_activity_name.sql` still needs to be applied via the Supabase Dashboard SQL editor to re-enable calibrate mode. One-liner: `ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS activity_name text;`

---

## 2026-03-03 — Strava history backfill: fetch 16 weeks of real HR-based load

- **New edge function `backfill` mode** — fetches all Strava activities for the last 16 weeks (paginated), detects HR monitor usage, fetches full HR streams for most-recent ≤99 uncached activities (staying within Strava's 100 req/15 min limit), uses `avg_heartrate → calculateITrimpFromSummary` for the rest. All results upserted to `garmin_activities`.
- **`backfillStravaHistory(weeks)`** in `stravaSync.ts` — client wrapper that calls `backfill` mode then re-runs `fetchStravaHistory` to refresh state. Idempotent (already-cached activities skipped).
- **Auto-trigger on startup** — `main.ts` now calls `backfillStravaHistory(16)` instead of `fetchStravaHistory(8)` when Strava connected + history not yet fetched.
- **Account view buttons** — "Load History" and "Refresh History" buttons both now call `backfillStravaHistory(16)`. Refresh no longer needs to reset `stravaHistoryFetched` flag.

---

## 2026-03-03 — Load history chart now shows full training timeline (pre-plan history + plan weeks)

- **Full timeline in load chart** — `getChartData` in `stats-view.ts` now includes ALL completed plan weeks (real `garminActuals` data) between the pre-plan Strava history and the current week. Previously the chart skipped plan weeks 1..s.w-2, showing only Strava history + current week.
- **Strava overlap trimmed** — Strava history weeks that fall inside the plan period are stripped (the plan week actuals are more accurate); only genuinely pre-plan Strava weeks are prepended.
- **Distance chart aligned** — `buildDistanceAreaChart` applies the same logic so the distance view also reflects completed plan km.
- **`NON_RUN_KW_CHART` extracted** — moved to module-level constant and shared by `getChartData` / `buildDistanceAreaChart` via a `runKmFromWeek()` helper.

---

## 2026-03-03 — Chart polish: labels, baseline reliability, 16w "no history" state

- **Home page bar labels readable** — "Sessions / Distance / Training Load (TSS)" labels changed from `text-[10px] color:faint` (invisible on mobile) to `text-[11px] color:muted`
- **CTL reference lines hidden until 4+ weeks** — "Your usual" and "Ease back" lines now only show when `histWeekCount >= 4`; below that a note explains "Baseline builds from week 4 — reference lines will appear then". Prevents misleading tiny-CTL reference lines from a 2-week history.
- **"Your usual" legend shows week count** — label now reads "Your usual (8wk avg)" so users understand what it's based on
- **16w/All shows "no more history" message** — when extended fetch returns same or fewer weeks as the 8w default, chart stays as-is and an inline note shows "X weeks synced so far — more history will appear as you keep training"
- **Zone alignment bug fixed** — `historicWeeklyZones` could be undefined from old state, causing zones array misalignment with TSS array (wrong bar getting coloured). `getChartData` now pads zones to exactly match TSS length with `null` entries; chart uses 88% aerobic fallback for null entries
- **Minimum intensity floor** — aerobic TSS is capped at 88% of total to ensure the orange (anaerobic) layer is always visually detectable, even for easy-only training weeks where zone estimation gives 99% aerobic

---

## 2026-03-03 — Load history chart fixes + distance area chart

- **Chart labels fixed** — all charts (load history, distance, zone) now show real calendar dates computed backwards from today, not plan week offsets. Historic Strava data shows correct calendar weeks.
- **TSS units labelled** — load chart legend now says "Aerobic TSS" / "Anaerobic TSS"
- **Reference lines labelled clearly** — legend now has two separate entries with matching dashed-line icons: "Your usual" (dark dashed) and "Ease back" (amber dashed), replacing the confusing combined label
- **Distance chart → smooth area** — Dig Deeper distance tab converted from bar chart to smooth stacked area chart (same style as load history); shows running km vs plan target reference line; calendar dates on x-axis
- **Zone bar initial state fixed** — Training tab TSS + Volume bars no longer show as solid red blocks on first render; parent background now provides the danger-zone colour and the `flex-1` fill div is removed

---

## 2026-03-02 — Spec gaps addressed + Load History Chart

- **Load History Chart (§12.9)** — stacked area SVG chart on Stats page replacing bar chart; aerobic (base+threshold, blue) / anaerobic (intensity, orange) areas; smooth bezier curves; time range selector (8w / 16w / All) fetches extended history on demand; CTL baseline + ease-back reference lines; dig-deeper accordion now shows distance/zones only
- **`historicWeeklyZones` stored** — `fetchStravaHistory()` now persists zone breakdown (base/threshold/intensity) per week; `fetchExtendedHistory()` added for 16w/52w on-demand fetches
- **Minimum running km floors (§5.6)** — goal-time-scaled weekly floor (sub-3:30 → 35km peak, 3:30–4:30 → 25km, 4:30+ → 18km); linear ramp early→peak; nudge shown in volume bar after 2 consecutive weeks below floor
- **5-rule plain language reduction logic (§8)** — ACWR modal header now picks specific copy based on: consecutive intensity weeks (Rule 4), cross-training cause (Rule 3), km spike (Rule 2), intensity-heavy week (Rule 1), or general load buildup (Rule 5); `ACWRModalContext` extended with `kmSpiked`, `crossTrainingCause`, `consecutiveIntensityWeeks`
- **"Already completed" + "no matching run" modal flows (§6.5)** — `SuggestionPayload` gains `alreadyCompletedMatch` and `noMatchingRun` fields; `buildCrossTrainingPopup` detects these edge cases; modal renders contextual panel with [Apply to next week] / [Log load only] buttons
- **Supabase deployment** — `supabase/migrations/20260302_activity_name.sql` applied; edge function redeployed with `history` / `calibrate` / `standalone` modes all live

---

## 2026-03-02 — Workout card data restoration (post-UX overhaul)

The new plan-view/activity-detail UI dropped several data fields that existed in the old renderer. Restored:

- [x] **TSS badge in Garmin/Strava match banner** — `TSS: XX` shown next to distance/pace/HR; computed from `iTrimp` (HR-based) or falls back to `duration × TL_PER_MIN[rpe]`
- [x] **Planned vs actual load comparison** — two-row bar in expanded card (planned grey bar vs actual green/amber/red bar); replaces the zone-profile bars when actual data exists; planned zone profile shown as fallback
- [x] **km splits sparkline inline** — compact vertical-bar chart in the expanded card below HR zones; bars colour-coded green→amber→red by relative pace, inverted so faster = taller
- [x] **Training effect badges** — aerobic/anaerobic effect (Garmin 1–5 scale) shown as labelled chips ("Maintaining", "Improving", etc.) in both the inline banner and the full-page detail
- [x] **Training Load section on full-page `activity-detail.ts`** — large TSS figure with HR-based/estimated label, planned vs actual bars + diff % when `plannedTSS` is passed from the call site; training effect chips below

---

## 2026-03-02 — ACWR-aware week generation + iTRIMP calibration

- `types/state.ts`: Added `Week.scheduledAcwrStatus?` — stores ACWR status at week-advance time so the generator can be seeded without recomputing
- `ui/events.ts`: `next()` now sets `nextWk.scheduledAcwrStatus` ('high'/'caution') alongside `weekAdjustmentReason`; clears it when ACWR is safe
- `ui/main-view.ts`: All three `generateWeekWorkouts()` calls for the current week now pass `wk.scheduledAcwrStatus` — workouts are actually reduced (not just the banner) when ACWR is elevated
- `supabase/migrations/20260302_activity_name.sql`: Added `activity_name` column to `garmin_activities`
- `supabase/functions/sync-strava-activities/index.ts`: Saves `act.name` (Strava workout title) on upsert; new `calibrate` mode returns individually-labelled running activities for iTRIMP threshold calibration
- `data/stravaSync.ts`: Added `calibrateIntensityThresholds(weeks)` — fetches labelled runs, classifies by name keywords, computes personal easy/tempo TSS/hr thresholds, stores on `s.intensityThresholds`; automatically called (non-blocking) at end of `fetchStravaHistory()`
- `ui/stats-view.ts`: Added `buildCalibrationStatus()` — shows calibration count in Advanced section ("Calibrating…" / "Calibrated from N sessions")

## 2026-03-01 — Recovery Check-In Feature

- `recovery/engine.ts`: Added `rmssdToHrvStatus(rmssd)` — maps RMSSD (ms) to `'balanced'|'low'|'unbalanced'|'strained'`; exported
- `data/physiologySync.ts`: Added `buildRecoveryEntryFromPhysio(physio)` — converts `PhysiologyDayEntry` to `RecoveryEntry`; Garmin stress inverted to readiness
- `main.ts`: Added `checkRecoveryAndPrompt(s)` — called after `syncPhysiologySnapshot(7)` resolves; finds today's physio entry, builds entry + computes status; shows manual check-in if no Garmin data; shows `showRecoveryAdjustModal` if orange/red; respects `lastRecoveryPromptDate` one-per-day guard
- `ui/plan-view.ts`: Replaced 4-option sleep quality modal with 1–10 colour-graded numeric tap UI; `handleRecoveryScoreInput` maps score×10 to sleepScore; history capped at 30; sets `lastRecoveryPromptDate`; `showRecoveryAdjustModal` now exported
- `types/state.ts`: Added `recoveryDebt?: 'orange' | 'red'` to `Week`
- `calculations/fitness-model.ts`: ATL multiplier now stacks `acwrOverridden` (1.15×), orange debt (1.10×), red debt (1.20×) — takes the max
- `ui/home-view.ts`: Recovery row shows HRV status dot (colour from RMSSD), resting HR sub-caption with ↑/↓ vs 7-day avg, "Self-reported" caption when manual entry was made today
- `recovery/engine.test.ts`: Added 2 new `rmssdToHrvStatus` tests (all 17 engine tests passing)

## 2026-03-01 — Home screen: tappable signal bars + injury indicator

**Feature parity audit — changes made:**
- `home-view.ts` `buildSignalBars`: Injury Risk and Recovery rows now have `cursor:pointer` and IDs (`home-injury-risk-row`, `home-recovery-row`)
- When `isInjuryActive()`: Injury Risk row replaced with amber "In Recovery" pill + caption; tap opens `openInjuryModal()`
- When not injured: Injury Risk row (ACWR bar) tap opens `triggerACWRReduction()` (plan softening modal)
- Recovery row tap opens `showRecoveryLogModal()` (sleep quality bottom sheet)
- `triggerACWRReduction` exported from `main-view.ts`; `showRecoveryLogModal` exported from `plan-view.ts`
- `isInjuryActive` imported into `home-view.ts` for injury state check

**Still in Plan tab only (not yet on Home):**
- Morning pain check-in (worse/same/better) — shown when injured
- Capacity test UI (Had Pain / Pain-Free) — on injury test workout cards
- Recovery 7-day dot log panel
- Excess Load card / ACWR zone carry banner

---

## 2026-03-01 — Light/Beige palette conversion: main-view.ts

- Converted all Tailwind dark-palette color classes (`bg-gray-*`, `text-white`, `text-gray-*`, `bg-emerald-*`, `text-emerald-*`, `bg-amber-*`, `bg-red-*`, `bg-blue-*`, etc.) to CSS variable inline styles using the design system (`var(--c-bg)`, `var(--c-surface)`, `var(--c-black)`, `var(--c-muted)`, `var(--c-faint)`, `var(--c-border)`, `var(--c-ok)`, `var(--c-caution)`, `var(--c-warn)`, `var(--c-accent)`)
- Updated: header, week navigator, week progress bars, zone bands, ACWR bar, carry banner, lightened week banner, benchmark panel, recovery pill, recovery log, physiology card, all modals (benchmark entry, recovery input, recovery adjust, runner type, styled confirm, ACWR info sheet, TSS info sheet), spinner overlay, toast
- Dynamic color expressions (injured header, phase labels, pain/canRun indicators) converted from Tailwind class interpolations to inline style interpolations
- `setZoneProgress()` updated to set `style.background` instead of className
- `dots()` helper updated to embed color as inline style; call sites pass CSS color values instead of Tailwind class names
- DOM querySelector fixed: `h3.text-sm.font-medium.text-white` → `h3.text-sm.font-medium` (text-white class removed)
- Zero new TypeScript errors introduced

## 2026-03-01 — Phase C2 + C3: History-informed onboarding & adaptive plan rebuild

**ctlBaseline wiring fix (5 callsites):**
- `renderer.ts`, `events.ts`, `main-view.ts` (3×): pass `s.ctlBaseline ?? undefined` as 4th arg to `computeACWR()` — previously these paths started CTL from 0 even when Strava history was available

**Phase C2 — History-informed onboarding:**
- `stravaSync.ts fetchStravaHistory()`: after computing `ctlBaseline`, derives and sets `s.athleteTier` from CTL ranges (beginner <30 / recreational 30–60 / trained 60–90 / performance 90–120 / high_volume 120+)
- `fitness.ts`: 3rd device option "Strava" added (grid-cols-3); Strava connect card with OAuth button; pre-saves `currentStep: 'strava-history'` before redirect so wizard resumes correctly
- New `src/ui/wizard/steps/strava-history.ts`: wizard step shown after Strava OAuth — loading spinner → history summary (avg TSS/km, detected tier, tier description, plan start km, "Use this" / "Enter manually"); inline tier picker via "Change" link
- `OnboardingStep` type: `'strava-history'` added
- `controller.ts`: `strava-history` added to STEP_ORDER after `fitness`; `nextStep()` and `previousStep()` skip it for non-Strava users
- `wizard/renderer.ts`: `renderStravaHistory` case added
- `state.ts`: `stravaHistoryAccepted?: boolean` added to `SimulatorState`

**Phase C3 — Adaptive plan rebuild:**
- `initialization.ts`: if `s.stravaHistoryAccepted && s.detectedWeeklyKm`, override `s.wkm` (weekly km target) with the detected value at plan init time — plan starts at the athlete's actual training volume instead of a runs/week lookup
- `account-view.ts`: "Training History" card shown when Strava connected; displays avg TSS/week, avg km/week, detected tier; "Rebuild Plan with Strava Data" button runs full re-init, preserves existing garminActuals/ratings, then navigates home; "Refresh History" and "Load History" buttons

## 2026-02-28 — Feature parity: Porting missing features to new tab UX

Restored all interactive features that were orphaned when `renderMainView()` became a one-liner delegate to `renderPlanView()`.

**plan-view.ts:**
- Injury banner + Report/Recover buttons: `buildInjuryBanner()`, `buildInjuryHeaderBtn()` — full-width card with gradient accent, pain level, phase, can-run badge, medical disclaimer for return phases; circular icon in header when healthy
- Morning pain check-in: `buildMorningPainCheck()` — once-per-day card with Worse/Same/Better grid; animated in-place feedback on selection
- Capacity test buttons: "Had Pain" / "Pain-Free!" grid on injury capacity test workout cards
- Recovery status pill: `buildRecoveryPill()` — 4 states (no data, green, low+CTA, already prompted)
- Recovery adjust modal: `showRecoveryAdjustModal()` — bottom-sheet with adjustments (run by feel / downgrade / reduce) for poor sleep; `markRecoveryPrompted()` suppresses re-prompt
- Recovery log panel: `buildRecoveryLogPanel()` — 7-day dot history card (green/amber/orange/red by score); "Log today"/"Update ✓" button
- Benchmark check-in panel: `buildBenchmarkPanel()` — optional fitness check-in on benchmark weeks; Garmin auto-detect; `showBenchmarkEntryModal()` bottom-sheet for manual entry (pace/distance/time)

**account-view.ts:**
- Change Runner Type: "Change" link next to runner type label → `showRunnerTypeModal()` (bottom-sheet picker with 3 types); confirmation dialog when plan already started; `applyRunnerTypeChange()` rebuilds plan via `initializeSimulator()`

**stats-view.ts:**
- VDOT &amp; Paces section: enhanced `buildFoldedPaces()` → "VDOT &amp; Paces" — hero VDOT tile with % change badge + "Started at X" sub-label, inline explainer of what VDOT means, paces grid below

## 2026-02-27 — UX Redesign + Load System UI convergence

**Phase 1 — CTL seeding fix**:
- `computeACWR` + `computeFitnessModel` gain optional `ctlSeed?` param — seeds CTL/ATL from Strava history instead of starting from 0
- All `computeACWR` calls in `home-view.ts` and `stats-view.ts` now pass `s.ctlBaseline`
- `main.ts`: calls `fetchStravaHistory(8)` on startup when Strava connected + history not yet fetched, re-renders home on complete

**Phase 2 — Stats Tab full redesign**:
- Complete rewrite of `stats-view.ts` — light theme CSS vars throughout (no dark Tailwind)
- Above fold: "Your last 8 weeks" heading + narrative sentence (3×3 matrix: direction × ACWR status)
- 8-week Training Load SVG bar chart with zone bands (Optimal green shading, "Ease back" threshold line, dashed "Your usual" baseline)
- Two summary cards: "This Week" (±% vs usual + plain-English copy) + "Distance" (km vs plan)
- "Dig deeper" accordion: chart view switcher (Training Load / Distance / Zones), 3 explainer bullets, 8-week summary row
- "Advanced" accordion (persisted open state): distance + load vs plan bars, CTL/ATL/TSB/ACWR metrics grid, ⓘ tap-to-expand inline explanations, ACWR gradient bar with tier label
- Folded sub-sections (light theme): Race Prediction, Current Paces, Recovery & Physiology, Phase Timeline

**Phase 3 — Home sparkline**:
- `buildSparkline(s)` added to `home-view.ts` — 36px mini 8-bar chart below injury risk bar
- Same zone colouring as Stats chart; baseline dashed line; tap → navigates to Stats tab
- Placeholder "Baseline builds in week 4" when no history

**Phase 4 — Suggestion modal Phase B v3 header**:
- `CrossTrainingModalContext` interface + optional 5th param on `showSuggestionModal`
- When provided: renders sport emoji + name + duration, HR-based load + effort type (Easy/Tempo/Interval from `classifyWorkoutType`), matched run name/km, cardio covered % + running km gap with inline tap-to-expand explanations

## 2026-02-27 — Plan tab overhaul: matching flow, visual hierarchy, card detail

**Matching flow fix (critical)**:
- `isDone` now includes `!!garminAct` — workouts paired via activity review now show as "Logged" (green) instead of "Missed"
- `garminAct` lookup moved before `isDone` calculation throughout `buildWorkoutCards`

**Visual hierarchy**:
- Colour-coded left border stripe: green = Logged/Done, blue = Today, amber = Missed, none = Upcoming
- "Missed" label now amber (`var(--c-caution)`) not grey faint — clearly distinguishable from "Upcoming"
- Status shows "Logged" when matched via Garmin/Strava, "Done" when manually rated
- Name no longer fades on completion (only fades on Skip/Replace)
- Garmin banner in expanded detail uses green background (success) not blue

**Expanded card detail enriched**:
- Route map canvas rendered inline when garminActual has polyline — lazy-loaded on expand
- HR zone bars + legend shown when hrZones available (actual data, not estimate)
- Planned load profile (3 bars: Base/Threshold/Intensity) shown for every workout type
- "Move to day" buttons at bottom — 7 day buttons; active day highlighted blue; fixes Sat/Sun drag issue

**Activity Log**:
- Header now shows "X matched" count and "+Y excess TSS" in amber when unspentLoad > 0

## 2026-02-27 — Activity detail + drag-and-drop restore

- **New `src/ui/activity-detail.ts`**: Full-page activity detail view with stats grid (distance/time/pace/HR/maxHR/calories), HR zone bars + legend, km splits with pace-coloured bars, OSM route map canvas (via `drawPolylineOnCanvas`). Back button returns to plan or home.
- **`strava-detail.ts`**: Exported `drawPolylineOnCanvas` (previously unexported) for use in activity-detail.
- **Plan tab — activity click-through**: Activity Log rows (plan-matched garminActuals) and adhoc garmin rows are now tappable with chevron arrow; the inline actMatchRow sub-row on workout cards is also tappable. All navigate to activity-detail. "View full activity →" link added inside expanded card garmin banner.
- **Plan tab — drag-and-drop**: Workout cards now have `draggable="true"` and `data-day-of-week`. HTML5 DnD handlers wire dragstart/dragover/drop — dropping card A onto card B swaps their days via `wk.workoutMoves`. Day moves applied in `getPlanHTML` before rendering.
- **Home tab — activity click-through**: Recent activity rows backed by garminActuals get `home-act-row` class with `data-workout-key`/`data-week-num`; click navigates to activity-detail. Rows without detail (adhoc) show no chevron and no click.
- **Zero new TS errors** in modified files.

## 2026-02-26 — Plan tab: route back to main-view (restore full functionality)

- **Architecture correction**: Plan tab routes back to `renderMainView()` in all views (home, stats, record, account). `plan-view.ts` is parked — it was a partial reimplementation that lost drag-drop, historic week editing, RPE modals, workout names, strava-detail expansion, skip/makeup logic, ACWR bars, GPS recordings, benchmark UI, and more.
- All 'plan' tab navigations restored to full functionality via main-view
- `plan-view.ts` kept as a future starting point for a proper redesign with complete feature parity

## 2026-02-26 — Plan tab: expandable cards, activity log, font fix

- **Inter font loaded** via Google Fonts preconnect in index.html; removed dark Tailwind override on body tag
- **Workout cards expandable**: tap any row to expand inline detail — shows description, Garmin/Strava sync banner with stats, Mark Done / Skip / Unmark buttons. Chevron rotates on expand.
- **Mark Done / Skip / Unrate** wired directly to `rate()`, `skip()`, `getMutableState()` from events.ts — re-renders plan-view after action (no navigation away)
- **Activity Log section** below workout cards: matched activities (garminActuals), adhoc Garmin activities, pending items banner with count; Review button calls `openActivityReReview()` directly
- **Remove garmin (×)** on both the expanded card banner and activity log rows — calls `removeGarminActivity()`
- **All nav routes to 'plan' tab** updated: home-view, stats-view, record-view, account-view all point to `renderPlanView()`

## 2026-02-26 — Phase 1 & 2 UX Redesign (Home tab + Plan tab)

- **New design system** (`styles.css`): Full CSS custom-property system — cream bg (`#FDFCF7`), Inter font, powder-blue accent (`#4E9FE5`), card/pill radii, progress bars, pills, signal bars, type scale
- **New tab structure** (`tab-bar.ts`): 4 tabs — Home | Plan | Record | Stats; Account moved to header avatar
- **Home tab** (`home-view.ts` NEW): Week progress bars, ACWR injury risk bar, today's workout hero card, race countdown, recent activity, sync actions; geometric SVG art behind workout hero
- **Plan tab** (`plan-view.ts` NEW): Week calendar strip, Vergia-style workout card list, week navigation (< > buttons, keyboard arrows, touch swipe); delegates complex operations (rate/advance) to main-view.ts
- **Wired all views** to route 'plan' tab to `renderPlanView()` instead of `renderMainView()` (`home-view.ts`, `stats-view.ts`, `record-view.ts`, `account-view.ts`)
- **Font/contrast fix**: `--c-muted` `#888` → `#555`, `--c-faint` `0.38` → `0.52` for legibility on web

## 2026-02-26 — Strava HR zone caching (fix rate-limit zone loss)

- **Root cause**: Edge function fetched Strava HR streams for ALL 50 activities on EVERY sync, burning the 100 req/15 min rate limit. Activities later in the batch got `hrZones: null`, which persisted in `garminActuals` and triggered "Zone split estimated — HR stream data unavailable" even though the activity came from Strava.
- **Fix — DB caching**: New `hr_zones jsonb` + `km_splits integer[]` columns in `garmin_activities` (migration `20260226_garmin_activities_zones.sql`). Edge function now does a single bulk `SELECT` of existing rows before the loop; activities that already have `hr_zones` in DB skip the stream fetch entirely and return cached data. Stream is only fetched the **first time** an activity is seen.
- **DB writes optimised**: Upsert only fires when fresh stream data was fetched (`needsUpsert` flag), reducing write amplification on every sync.
- **`stravaSync.ts` patch loop**: Comment clarified — the `!actual.hrZones` guard is intentional and correct; the second sync now returns real zones from DB so the patch fires and fills in activities that missed zones on first sync.

## 2026-02-26 — Synced activities display fixes (round 2)

- **`formatActivityType` missing entries**: Added `WORKOUT: 'Workout'`, `CARDIO: 'Cardio'`, `KICKBOXING`, `ELLIPTICAL`, `STAIRSTEPPER`. Fixes "workout" (lowercase via fallback) showing for Strava activities that were stored with `activity_type = "WORKOUT"`.
- **hrZones + startTime on all GarminActual creation sites**: All 6 sites in `activity-review.ts` (manual review assignments, auto-process for runs/gym/cross) now copy `item.hrZones` and `item.startTime` into `GarminActual`. Fixes "Zone split estimated" showing for cross-training and manually-reviewed activities.
- **`stravaSync.ts` patch loop extended**: Now loops over ALL weeks (not just current week) and also patches `startTime` and `displayName` — so activity labels like "HIIT" update correctly on next sync after edge function redeployment, without requiring the user to delete and re-add.
- **`removeGarminActivity` cross-week search**: Now searches ALL weeks' `garminMatched` to find the activity (not just current week). Fixes cases where a past-week activity's × button silently did nothing. Also correctly filters `adhocWorkouts` by both the adhoc id (`garmin-{id}`) AND the workoutId, so matched plan-slot runs are properly cleaned up.

## 2026-02-26 — Synced activities display fixes

- **Edge function `sport_type`**: `sync-strava-activities` now uses Strava's `sport_type` field first (more specific, e.g. "HIIT") before falling back to `type` ("Workout"). Added mappings for `workout` → `CARDIO`, `pilates`, `boxing`, `elliptical`, `stairstepper`. Fixes HIIT activities showing as "Workout".
- **`hrZones` on `GarminActual`**: `activity-matcher.ts` now copies `row.hrZones` directly into the `GarminActual` when auto-completing a run. Previously hrZones were only patched on a subsequent `stravaSync.ts` resync, causing the "Zone split estimated" message to show even for Strava-connected users after first sync.
- **`startTime` on `GarminActual`**: Added `startTime?: string` to `GarminActual` type (`state.ts`); `activity-matcher.ts` now stores `row.start_time` in matched run actuals for date display.
- **Source badge**: `renderGarminSyncedSection` now derives the activity source from the `garminId` prefix (`strava-` → Strava badge, `apple-` → Apple Watch badge, numeric → Garmin badge) instead of checking `stravaId`. All three activity types (matched, adhoc, pending) now show a source badge.
- **Unified format**: All synced activities (matched plan slots, ad-hoc, pending review) now show: Source badge · Name · Distance · Pace · HR · Date · Calories. Helpers `getActivitySource()`, `sourceBadge()`, `fmtActivityDate()` added in renderer.
- **Adhoc structured data**: `addAdhocWorkout()` and `addAdhocWorkoutFromPending()` now store `garminDistKm`, `garminDurationMin`, `garminAvgHR`, `garminCalories`, `garminAvgPace` as extended properties on the workout object. Name no longer includes "(Garmin)" suffix (replaced by source badge).
- **Zone split message**: Changed "Zone split estimated — connect Strava for HR-accurate data" to "Zone split estimated — HR stream data unavailable" (neutral, accurate for all data sources).

## 2026-02-26 — Strava-first activity sync architecture

- **New data source strategy**: Strava is now always the activity source when connected (regardless of wearable). Garmin/Apple Watch continues as the biometric source (VO2max, LT, HRV, sleep, resting HR). For users without Strava, Garmin webhook remains the activity source.
- **`supabase/functions/sync-strava-activities/index.ts`**: Removed enrich mode entirely. Single standalone path — fetches activity list + HR streams, computes iTRIMP + HR zones + km splits, upserts into `garmin_activities` with `source='strava'`. Fixed `garmin_daily_metrics` → `daily_metrics` table name for physiology lookup (was using wrong table, causing fallback to 55/190 defaults for all iTRIMP calculations).
- **`src/data/stravaSync.ts`**: Removed all enrich mode code. `syncStravaActivities()` now always runs standalone and returns `{ processed: number }`. Patches `hrZones`, `kmSplits`, `polyline` onto `garminActuals` after matching.
- **`src/main.ts`**: Boot sync routing updated — if `s.stravaConnected`, calls Strava for activities + Garmin physio for Garmin wearable users. Garmin-only branch no longer calls Strava enrichment. Strava connected toast updated to "syncing activities".
- **`src/ui/main-view.ts`**: Sync button now shows for all users (not hidden for `wearable === 'strava'`). Label updated: "Sync Strava" / "Sync Garmin" / "Sync Apple Watch" based on `s.stravaConnected` then `s.wearable`. Handler routes to Strava when connected.
- **`src/ui/account-view.ts`**: Sync Now button uses same routing. "Pair Strava HR" section renamed to "Re-sync activities" with orange styling matching Strava brand. Handler uses `{ processed }` return type.
- **`supabase/migrations/20260226_garmin_activities_source.sql`**: Adds nullable `source` text column to `garmin_activities` (needed for Strava standalone upsert).
- **`supabase/migrations/20260226_sleep_and_activity_details.sql`**: Creates `sleep_summaries` and `activity_details` tables (were missing from DB schema, causing 400 errors on physiology sync and lap detail sync).
- **`src/data/activitySync.ts`**: Fixed early return bug — `processPendingCrossTraining()` is now called even when the DB returns 0 rows, so stuck `__pending__` items surface on sync.

## 2026-02-26 — Stats page plain-English rewrite (Volume & Load section)

- **`src/ui/stats-view.ts` `buildLoadVolumeHTML`**: Complete rewrite of the Volume & Load section:
  - Removed confusing week-on-week TL delta badge (`-418`) — replaced with plain-English context ("28% less than last week")
  - "Leg Stress" card now only appears when `impactLoad > 0` — no more "None / Musculoskeletal impact (0 units)"
  - History bar charts: hidden until 4+ completed weeks; labels upgraded from `text-[8px]` to `text-[10px]`; bar values sit above bars not below; note explains what the chart shows
  - PMC redesign ("Training Balance" heading): CTL → "Fitness / 42-day base", ATL → "Fatigue / 7-day load", TSB → "Form / Fresh|Neutral|Fatigued". Plain-English explanation of what each means
  - ACWR section in PMC: taller bar (h-2), "this week vs your baseline" label, "Rest / ▲ safe limit / Overload" axis labels
  - Athlete tier: "Safe load increase: up to X% above your baseline" instead of raw ACWR number
- **`src/ui/main-view.ts`**: Training tab TSS split bar now uses 8-week rolling max as scale anchor — stops the ◆ baseline marker jumping when one outlier week sets a huge scale. Added `computeWeekTSS` import.

## 2026-02-26 — Stats + Training tab UX polish

- **`src/ui/stats-view.ts`**: Reordered stats page — Fitness (PMC) and Load/Volume now appear second/third, before Race Prediction. Previously required scrolling past paces/insights to reach training metrics.
- **`src/ui/stats-view.ts`**: PMC "Building baseline" state when < 4 weeks data — suppresses misleading "Fatigued · TSB -99" label (ATL is naturally high early in training); TSB grid cell shows "—" with a plain-English explanation instead.
- **`src/ui/main-view.ts`**: ◆ Baseline label added to legend row on Training tab TSS split bar — was an unlabelled grey diamond.

## 2026-02-26 — Bug fix: Load chart now updates when navigating weeks

- **`src/ui/main-view.ts`**: `updateViewWeek()` now calls `updateLoadChart({ ...s, w: viewWeek })` after every week change. Previously the TSS split bar, Running Volume bar, zone bars, and load numbers stayed frozen on the week you were on when the page loaded.

## 2026-02-26 — Phase B v2: Override Debt, Volume Bars, Carry Tracking, acwrStatus Wiring

- **`src/types/activities.ts`**: Added `volumeTransfer?: number` and `intermittent?: boolean` to `SportConfig` interface.
- **`src/types/state.ts`**: Added `carriedTSS?` and `acwrOverridden?` to `Week`.
- **`src/constants/sports.ts`**: Added `volumeTransfer` (GPS km credit toward running volume bar) and `intermittent` flag to all `SPORTS_DB` entries. Soccer/rugby: 0.7, extra_run: 1.0, hiking: 0.4, cycling/swimming/padel/tennis: 0.
- **`src/calculations/fitness-model.ts`**: Synthetic ATL debt — when `wk.acwrOverridden` is true, ATL computation uses 1.15× the actual TSS, making ACWR appear elevated even after load returns to normal. CTL stays accurate.
- **`src/ui/events.ts`**: Imported `computeACWR`/`computeWeekTSS` from fitness-model. In `next()`: (1) computes zone carry tracking (stores `wk.carriedTSS` when actual TSS > planned × 1.10, with HR zone breakdown); (2) computes ACWR and sets `weekAdjustmentReason` on the incoming week when elevated.
- **`src/ui/renderer.ts`**: `generateWeekWorkouts()` main render call now receives `acwrStatus` from `computeACWR` — plan engine reduces quality sessions when ACWR is elevated.
- **`src/ui/main-view.ts`** (Volume bars): "This Week" TSS bar now splits running (blue) + cross-training (purple) with a CTL baseline marker (◆). New Running Volume row shows running km (blue) + GPS cross-training km (grey-blue, weighted by `volumeTransfer`), with planned km and baseline marker. "Your cross-training is covering fitness load" nudge when run km is zero but cross-training load is healthy.
- **`src/ui/main-view.ts`** (override debt): "Dismiss" button added next to "Reduce this week" — sets `wk.acwrOverridden = true`. Selecting "Keep" in the reduction modal also sets this flag.
- **`src/ui/main-view.ts`** (over-plan % trigger, §5.2): "Reduce this week" button now appears when actual TSS > ~planned × 1.20 even when ACWR is safe/unknown. Button text changes to describe the over-plan %.
- **`src/ui/main-view.ts`** (injury risk label, §5.3): Escalating label below ACWR bar: Safe=hidden, Caution=Moderate amber, High=High red, 1 override=High + override note, 2+ overrides=Very High/Extreme.
- **`src/ui/main-view.ts`** (carry banner, §5.4): Amber collapsible banner above workouts when prior weeks' `carriedTSS` sums (with CTL decay × 0.85/week) to ≥ 8 TSS. Tap-to-expand shows per-week breakdown with decay factor.

## 2026-02-26 — Phase B: ACWR Injury Risk System

- **`src/calculations/fitness-model.ts`**: Added `computeACWR()`, `AthleteACWR` interface, `AthleteACWRStatus` type, and `TIER_ACWR_CONFIG` table (5 athlete tiers with safe-upper ACWR thresholds and labels).
- **`src/types/state.ts`**: Added `athleteTier?` and `athleteTierOverride?` to `SimulatorState`; `weekAdjustmentReason?` to `Week` (surfaced as a banner when the plan engine lightens a week due to ACWR).
- **`src/workouts/plan_engine.ts`**: Added `acwrStatus?` to `PlanContext`. When `caution`: reduces `maxQuality` by 1 (replaces one hard session with easy). When `high`: reduces by 2 and caps long run at previous week's distance. ACWR note propagated to session `notes` field.
- **`src/workouts/generator.ts`**: Added `acwrStatus?` param (passed through to `planWeekSessions`).
- **`src/ui/suggestion-modal.ts`**: Added `ACWRModalContext` interface and optional 4th param to `showSuggestionModal()`. Renders a collapsible context header at the top of the modal explaining the load spike when ACWR is caution/high.
- **`src/ui/main-view.ts`**: Retired `excess-load-card` (removed import, render call, and `wireExcessLoadCard()`). Added ACWR bar in "This Week" panel (below zone bars) — shows ratio, colour-coded gradient bar with safe-threshold marker, status text. Added "Reduce this week" button (caution/high only) → opens suggestion modal with ACWR context. Added `updateACWRBar()`, `updateLightenedWeekBanner()`, `triggerACWRReduction()`, `showACWRInfoSheet()` functions. Lightened-week banner above workouts when `weekAdjustmentReason` is set.
- **`src/ui/stats-view.ts`**: Expanded PMC section — now shows ACWR ratio (prominent number), colour-coded status, bar with safe-threshold marker, 3-metric grid (CTL/ATL/TSB), athlete tier badge with override indicator.

## 2026-02-26 — Zone Mini-Bars on Cards + Cross-Training Planned Load Fix

- **`src/ui/renderer.ts`** (activity cards): Completed activity cards now show zone mini-bars (Base / Threshold / Intensity) with a number alongside, replacing the single-line `38b · 18t · 4i` shorthand. When no HR zone data (no Strava sync), shows "Estimated" badge inline and a footnote explaining to connect Strava for accurate data.
- **`src/ui/main-view.ts`** (planned load): Cross-training planned workouts (`w.t === 'cross'`) now have `SPORTS_DB[sport].runSpec` applied when computing planned weekly TSS, preventing sports like swimming (runSpec 0.20) or tennis (0.50) from inflating the planned target the same as an equivalent running session. Default runSpec 0.40 used for unknown sports.

## 2026-02-25 — Phase A Fixes: Zone Bars + Card Zones

- **`src/ui/main-view.ts`** (zone bars): Zone bars now show each zone as a % of total actual TSS, not relative to each other. Base bar = 179/369 = 49% wide, etc. Subtitle changed to "Zone distribution of actual TSS". Bars thickened to h-1.5.
- **`src/ui/renderer.ts`** (activity cards): Completed activity cards now show zone breakdown inline with TSS: `TSS: 115 · 80b · 25t · 10i · Strava HR`. Uses real hrZones data when available; falls back to workout type profile. Imported `LOAD_PROFILES` for fallback. Zone labels use shorthand (b/t/i) to fit inline.
- **`src/ui/main-view.ts`** (TSS info sheet): Added explanation that planned TSS for cross-training may exceed actual because the plan doesn't apply a running-specificity discount, whereas Strava HR data does.

## 2026-02-25 — Phase A Fixes: Zone Sum + Over-Plan Display

- **`src/ui/renderer.ts`** (Planned TSS): Fixed zone values not summing to the total — now derives `plannedTSS` as sum of zone parts (base+threshold+intensity) rather than from `loads.total` which had an extra 1.15× anaerobic multiplier applied.
- **`src/ui/main-view.ts`** (TSS bar): Bar still caps at 100% width visually, but now shows a `+X% over plan` label (orange) when actual exceeds plan, and `X% of plan` (grey) when below 80%. Added `stat-load-pct` element to HTML template.

## 2026-02-25 — TSS UX Polish

- **`src/ui/main-view.ts`**: Added `?` button next to "TSS" label → opens bottom sheet explaining TSS, reference points (~55 easy 60min, ~80 threshold, ~100 race), and 3 zones (base/threshold/intensity). Replaced text-only zone labels with visual mini-bars (blue/amber/orange) with numbers on the right — bars scale relative to the largest zone.
- **`src/ui/renderer.ts`**: Replaced "Planned load: X aerobic · Y anaerobic" on unrated workout cards with "Planned TSS: X · base / threshold / intensity" breakdown in TSS-scale values. Imports `LOAD_PER_MIN_BY_INTENSITY` for FCL→TSS conversion.
- **`src/ui/excess-load-card.ts`**: Added `?` button next to leg impact label → opens bottom sheet explaining what leg impact means, which sports cause which level, and what to do about high impact.

## 2026-02-25 — Phase A: TSS Rename + 3-Zone Display

- **`src/types/activities.ts`** (`WorkoutLoad`): Added `base?`, `threshold?`, `intensity?` fields (Z1+Z2 / Z3 / Z4+Z5 split) alongside existing `aerobic`/`anaerobic` (kept for cross-training matcher backward compat).
- **`src/constants/workouts.ts`** (`LOAD_PROFILES`): Added 3-zone fields to every workout type profile (e.g. easy = `{base:0.94, threshold:0.05, intensity:0.01}`).
- **`src/workouts/load.ts`** (`calculateWorkoutLoad`): Now populates `base`, `threshold`, `intensity` fields in returned `WorkoutLoad`.
- **`src/types/state.ts`**: Renamed `actualTL` → `actualTSS` on `Week` interface.
- **`src/calculations/fitness-model.ts`**: Renamed `computeWeekTL` → `computeWeekTSS`; `FitnessMetrics.actualTL` → `actualTSS`; added `computeWeekTL` backward-compat alias; `computeWeekTSS` reads `wk.actualTSS` first, falls back to `wk.actualTL` for migration.
- **`src/calculations/activity-matcher.ts`**: `wk.actualTL` → `wk.actualTSS`.
- **`src/data/stravaSync.ts`**: All `wk.actualTL` → `wk.actualTSS`.
- **`src/ui/activity-review.ts`**: Both `wk3.actualTL` → `wk3.actualTSS`.
- **`src/ui/main-view.ts`**: "Training Load" label → "TSS"; `hw.actualTL` → `hw.actualTSS`; `updateLoadChart()` now computes 3-zone breakdown (actualBase/actualThreshold/actualIntensity) using hrZones data when available, otherwise workout-type profile; replaced aerobic/anaerobic sublabels with "X base · Y threshold · Z intensity" labels; load numbers now use `Math.round()` not `.toFixed(1)`.
- **`src/ui/renderer.ts`**: "Training load: X TL" → "TSS: X" on activity cards.
- **`src/ui/stats-view.ts`**: `computeWeekTL` → `computeWeekTSS` import + call sites.
- **`src/ui/excess-load-card.ts`**: "TL" → "TSS" throughout.

## 2026-02-25 — Unified Load Display (TL everywhere)

- **`src/ui/main-view.ts`**: "Activity Load" renamed "Training Load". `updateLoadChart()` now computes planned/actual in TL units (same scale as individual activity cards). Planned uses `TL_PER_MIN / LOAD_PER_MIN_BY_INTENSITY` scale factor applied to `calculateWorkoutLoad()` output. Actual matched runs use iTRIMP normalisation or `durationSec × TL_PER_MIN[rpe]`, split by workout type via `LOAD_PROFILES`. Unspent cross-training items use `durationMin × TL_PER_MIN[5] × 0.35`. Sublabels show "X aerobic · Y anaerobic" in TL units with explanatory subtitle.
- **`src/ui/excess-load-card.ts`**: Added `itemTL()` helper computing TL as `durationMin × TL_PER_MIN[5] × runSpec`. Card body now shows total TL with explanatory text instead of aerobic/anaerobic bars. Popup shows TL per item instead of per-item bars.

## 2026-02-25 — Load System Audit: hrZones Pipeline + impactLoad + UI Tier Badge

- **`src/types/state.ts`** (`GarminPendingItem`): Added `hrZones?` field so HR zone data can flow from the Garmin edge function through the activity review pipeline.
- **`src/types/activities.ts`** (`CrossActivity`): Added `hrZones?` field so zone data is available when building the suggestion popup.
- **`src/calculations/activity-matcher.ts`** (`GarminActivityRow`): Added optional `hrZones?` field; all 3 `GarminPendingItem` builders now copy `row.hrZones ?? null`.
- **`src/ui/activity-review.ts`** (`buildCombinedActivity`): Aggregates HR zone times (in seconds) across all pending items that have zone data, sets `combined.hrZones`.
- **`src/cross-training/universal-load-types.ts`**: Added `impactLoad: number` to `UniversalLoadResult`; updated `crossActivityToInput()` to convert `hrZones` from `{z1..z5}` (seconds) to `HRZoneData` (minutes).
- **`src/cross-training/universalLoad.ts`**: `getSportConfig()` now returns `impactPerMin`; `computeUniversalLoad()` computes `impactLoad = durationMin × impactPerMin` and includes it in the result.
- **`src/cross-training/suggester.ts`**: `buildCrossTrainingPopup()` now passes `hrZones` (converted) to `computeUniversalLoad()` so Tier B (HR Zones) is reached when zone data is available. `SuggestionPayload` gained `tier`, `aerobicLoad`, `anaerobicLoad`, `impactLoad` fields; `buildCrossTrainingPopup()` returns them.
- **`src/ui/suggestion-modal.ts`**: Shows a data tier badge ("HR Stream" / "Garmin" / "HR Zones" / "Estimated"), aerobic/anaerobic percentage split, and leg impact label (No / Low / Moderate / High) below the main load badge.
- **`src/ui/excess-load-card.ts`**: Added leg impact label computed from `SPORTS_DB[sport].impactPerMin × durationMin` for each unspent item.

## 2026-02-25 — Strava Activity Detail: HR Zones, Km Splits, Route Map

- **`supabase/functions/sync-strava-activities/index.ts`**: Enrich mode now computes and returns HR zones (time in Z1–Z5 using Karvonen/HRR thresholds), km splits for runs (from Strava distance+time stream via linear interpolation), and route polyline (`map.summary_polyline`). Match tolerance widened from ±5 min to ±10 min to catch HIIT and gym sessions. Activity type (`activity_type`) now included in `garmin_activities` query so distance stream is fetched only for runs. Deployed.
- **`src/types/state.ts`** (`GarminActual`): Added `hrZones?`, `kmSplits?`, `polyline?` optional fields.
- **`src/data/stravaSync.ts`**: Enrich client patches `hrZones`, `kmSplits`, `polyline` onto `garminActuals` alongside existing `iTrimp`/`stravaId`. `StravaEnrichResult` interface extended to match new response shape. `strava_id` fallback to `'strava-{garminId}'` ensures badge always shows even with older deployments.
- **`src/ui/renderer.ts`** (`renderGarminSyncedSection`): Each matched activity row is now tap-to-expand. Expanded panel shows: stacked HR zone bar (Z1 blue → Z5 red) with per-zone time legend, km split grid (pace per km in M:SS), and canvas route map. Added `fmtZoneTime()` helper.
- **`src/ui/strava-detail.ts`** *(new)*: `toggleStravaDetail()` expand/collapse handler registered on `window`. Includes Google encoded polyline decoder (no external deps) and canvas renderer that draws the route in purple with green/red start/end dots.
- **`src/main.ts`**: Imports `strava-detail.ts` to register `window.toggleStravaDetail` at app startup.

## 2026-02-25 — Activity Review Loop Fixes (Round 2)

- **`src/ui/activity-review.ts`** (`openActivityReReview`): Snapshots `rated`, `garminActuals`, `garminMatched`, `adhocWorkouts`, and `workoutMods` before undoing pairings. Passes an `onCancel` callback to `showActivityReview` → `showReviewScreen` → Cancel button. Pressing Cancel now restores state exactly as it was before the modal opened — no pairings lost.
- **`src/ui/activity-review.ts`** (`showActivityReview`, `showReviewScreen`): Added optional `onCancel?: () => void` parameter. Cancel button calls `onCancel` if provided, otherwise falls back to `onComplete` (first-time flow unchanged).
- **`src/ui/events.ts`** (`next()`): Fixed "1 workout to do" false positive on complete week. Old logic compared `Object.keys(wk.rated).length` (all rated items including gym/sports) against `s.rw` (configured run days) — incompatible units. New logic generates the actual week workouts upfront, filters to run-type workouts only, and counts those without a `wk.rated` entry. Auto-skip code reuses the same `weekWorkouts`/`unrated` computation.
- **`src/ui/renderer.ts`** (`renderGarminSyncedSection`): Section now stays visible when activities are in `garminPending` with `__pending__` status (user cancelled the review before applying). Pending items render with a yellow/amber "pending review" badge so the Review button in the header remains accessible.

## 2026-02-25 — Activity Review Loop Fixes (Round 1)

- **Root cause found**: `__editThisWeek` (the "Edit this week" amber button on past-week views) was wiping all Garmin state (`garminMatched`, `garminActuals`, `garminPending`). After the reload, `syncActivities()` treated all activities as new, re-queued them as `__pending__`, and immediately fired the activity review — even though everything was already paired.
- **`src/ui/main-view.ts`** (`__editThisWeek`): Simplified to only set `ms.w = viewWeek` and reload. No state is cleared. Existing pairings, ratings, and plan state are fully preserved. The activity review will only fire if there are genuinely unprocessed (`__pending__`) items — not for already-paired activities.
- **`src/calculations/activity-matcher.ts`**: Auto-matched runs are now also pushed to `wk.garminPending` so `openActivityReReview()` can find and un-rate them during a manual re-review.
- **`src/ui/activity-review.ts`**: `populateUnspentLoadItems()` deduplicates by `garminId` — prevents excess load from growing on repeated re-reviews.
- **`src/ui/activity-review.ts`**: `applyReview()` guards against overwriting an already-confirmed match in the run loop — prevents the "workout shows done but not linked to Garmin data" symptom.

## 2026-02-24 (Round 21 — Load System Overhaul: TL, Impact Load, CTL/ATL/TSB)

- **`src/types/state.ts`**: Added `actualTL?: number` and `actualImpactLoad?: number` to `Week` interface (TSS-calibrated training load and musculoskeletal impact stress per week)
- **`src/types/activities.ts`**: Added `tl?: number` and `impactLoad?: number` to `WorkoutLoad`; added `impactPerMin?: number` to `SportConfig`
- **`src/constants/sports.ts`**: Added `TL_PER_MIN` table (RPE 1–10 → TSS-calibrated TL per minute); added `IMPACT_PER_KM` table (run intensity → impact per km); added `impactPerMin` to every `SPORTS_DB` entry; both tables exported
- **`src/calculations/fitness-model.ts`** *(new)*: `computeWeekTL()` — computes weekly TL from `actualTL` (fast path), iTRIMP, or RPE fallback; `computeFitnessModel()` — CTL/ATL/TSB using 42-day/7-day EMA
- **`src/calculations/activity-matcher.ts`**: Fixed `extraRunLoad` bug (raw Garmin TE 0–5 replaced by TSS-calibrated TL accumulation on `wk.actualTL`); removed meaningless `aerobic`/`anaerobic` Garmin TE fields from `addAdhocWorkout`; added `wk.actualImpactLoad` accumulation for matched runs
- **`src/ui/activity-review.ts`**: Added cross-training TL and impact load storage (`wk.actualTL`, `wk.actualImpactLoad`) at both `applyAdjustments` call sites (regular cross-training + overflow handlers)
- **`src/ui/stats-view.ts`**: Replaced `computeWeekLoad` (Garmin TE) with `computeWeekTL`; replaced "Aerobic/Anaerobic TE / 5 max" display with Actual TL / Planned TL / Impact Load; added `buildPMCHTML()` — PMC chart with CTL/ATL/TSB bars; called from `getStatsHTML`
- **`src/ui/main-view.ts`**: Fixed load history chart to use `hw.actualTL ?? hw.extraRunLoad ?? 0` (correct scale for new data, graceful fallback for historical weeks)

## 2026-02-24 (Round 20 — Strava OAuth integration end-to-end)

- **`supabase/config.toml`**: Added `verify_jwt = false` for `strava-auth-start`, `strava-auth-callback`, `sync-physiology-snapshot`, `sync-activities`, `sync-activity-details`, `sync-strava-activities` — required because Supabase project uses ES256 JWT signing which the edge function gateway cannot verify with HS256; functions do their own auth via `auth.getUser()`
- **`supabase/functions/strava-auth-start/index.ts`**: Strip trailing slash from `SUPABASE_URL`; use `STRAVA_CALLBACK_URL` env var for redirect_uri with fallback
- **`supabase/functions/strava-auth-callback/index.ts`**: Same redirect_uri fix for token exchange
- **`src/data/supabaseClient.ts`**: Fixed `getValidSession()` to check `expires_at` before returning cached session — previously returned expired tokens without refreshing
- **`supabase/migrations/20260224_strava_oauth.sql`**: Ran via SQL Editor — created `strava_auth_requests`, `strava_tokens` tables and added `itrimp` column to `garmin_activities`
- **Deployed**: `strava-auth-start`, `strava-auth-callback`, `sync-strava-activities`, `sync-activity-details`, `sync-physiology-snapshot`, `sync-activities` all deployed to production

## 2026-02-24 (Round 19 — Fix week navigation resetting to current week)

- **`src/ui/main-view.ts`**: Added module-level `_persistedViewWeek` so the viewed week survives `renderMainView()` re-renders; `wireEventHandlers` now initialises `viewWeek` from the persisted value and saves it on every navigation; `updateViewWeek(viewWeek)` at end of `wireEventHandlers` replaces the separate `render()` call in `renderMainView`; `setOnWeekAdvance` clears `_persistedViewWeek` so a real week advance returns to the new current week

## 2026-02-24 (Round 18 — RPE only for runs)

- **`src/ui/renderer.ts`**: Non-running workouts (cross, strength, rest, gym) now show a simple "Mark as done" / "Unmark as done" button instead of an RPE 1-10 grid; RPE badge removed from their card headers; "Done" badge shows no RPE number; running workouts unchanged; `isRunWorkout` flag added alongside `isCompleteRest`

## 2026-02-24 (Round 17 — Planned/Completed workout split + GPS load fix)

- **`src/gps/recording-handler.ts`**: Fixed `createActivity('run', ...)` → `createActivity('extra_run', ...)` so impromptu GPS runs correctly route through SPORTS_DB load pipeline
- **`src/ui/renderer.ts`**: Split workout list into "This Week's Plan" (unrated) and "Completed" (rated) sections; completed Quick Runs move from Just Run banner into Completed section; `renderWorkoutList` no longer injects its own `<h4>` header; GPS recordings div moved to call site to avoid duplication

## 2026-02-24 (Round 16 — Strava onboarding + iTRIMP plumbing)

- **`src/types/onboarding.ts`**: Extended `watchType` union to include `'strava'`; added `biologicalSex?: 'male' | 'female' | 'prefer_not_to_say'`
- **`src/types/state.ts`**: `GarminPendingItem` — added `iTrimp?: number | null`; `SimulatorState.biologicalSex` union extended to include `'prefer_not_to_say'`
- **`src/types/activities.ts`**: `CrossActivity` — added `iTrimp?: number | null`
- **`src/cross-training/activities.ts`**: `createActivity()` — added optional `iTrimp` parameter; spreads onto returned object
- **`src/ui/wizard/steps/fitness.ts`**: Added Strava as a third device picker option (3-col grid); wires `watch-strava` click handler; checks `isStravaConnected()` for connection badge; `btn-wizard-strava` triggers `strava-auth-start` OAuth flow
- **`src/ui/wizard/steps/physiology.ts`**: Added biological sex selector (Male / Female / Prefer not to say) at top; Strava users see connection status + connect button; Garmin users see a "Connect Strava for better load data" nudge banner
- **`src/state/initialization.ts`**: Maps `onboarding.biologicalSex` → `s.biologicalSex`
- **`src/calculations/activity-matcher.ts`**: `GarminActivityRow` — added `iTrimp?`; both pending item builders copy `row.iTrimp`
- **`src/cross-training/universal-load-types.ts`**: `crossActivityToInput()` — maps `act.iTrimp` → `ActivityInput.iTrimp`
- **`src/cross-training/suggester.ts`**: `buildCrossTrainingPopup()` — passes `iTrimp: activity.iTrimp` to `computeUniversalLoad()`
- **`src/ui/activity-review.ts`**: `buildCombinedActivity()` — sums iTRIMP across pending items; passes to `createActivity()`
- **`src/data/stravaSync.ts`**: Passes `biological_sex: s.biologicalSex` in both standalone and enrich mode calls

---

## 2026-02-24 — Impromptu GPS run: match + load pipeline

- **`src/gps/recording-handler.ts`**: Impromptu runs (no name match) now go through a two-stage flow instead of just saving an adhoc entry.
  1. **Smarter match**: `findMatchingWorkout()` is called with the run's actual distance + day-of-week against unrated, non-replaced planned runs. If a match is found, a confirmation dialog ("Assign to [Workout Name]?") lets the user assign it — calling `rate()` on that planned workout.
  2. **Load logic fallback**: If no match or the user declines, the run is saved as an adhoc entry and `createActivity('run', ...)` is run through `buildCrossTrainingPopup` + `showSuggestionModal` so the extra load can adjust the week's plan (reduce/replace/keep).
  - `modReason` for GPS-sourced mods uses `GPS: ${workoutName}` prefix.

---

## 2026-02-24 — Physiology wizard step split

### Refactor: Split fitness step into Garmin connect + physiology data pages
- `src/types/onboarding.ts`: added `'physiology'` to `OnboardingStep`
- `src/ui/wizard/controller.ts`: inserted `'physiology'` between `fitness` and `initializing` in `STEP_ORDER`
- `src/ui/wizard/steps/fitness.ts`: stripped LT/VO2/HR fields; "No watch" now calls `goToStep('initializing')` to skip physiology; "Continue" just persists wearable and advances
- `src/ui/wizard/steps/physiology.ts` (new): LT pace, VO2 max, Resting HR, Max HR fields; "Sync from Garmin" button calls `isGarminConnected()` + `syncPhysiologySnapshot(1)` and populates fields with result count feedback; "Skip for now" advances without saving; "Continue" validates and saves
- `src/ui/wizard/renderer.ts`: registered `renderPhysiology` for the new step

---

## 2026-02-24 (Bug fix — Edit Settings return button)

- **`src/ui/wizard/steps/assessment.ts`**: Added "← Return to my plan" button on the assessment step when accessed mid-plan via "Edit Settings". Detects `isMidPlan` via `getState().wks.length > 0`. Button restores `hasCompletedOnboarding = true` and navigates directly to `renderMainView()` without touching the plan. Back button hidden in mid-plan mode (irrelevant to navigate further back into the wizard). Button appears in all three assessment layouts: non-event, forecast-only, and plan-selection.

---

## 2026-02-24 (Round 15 — Strava + iTRIMP)

### Feature: Strava Integration + iTRIMP Training Load

- **`src/calculations/trimp.ts`** (new): Pure iTRIMP math module — three tiers: `calculateITrimp` (1-second HR stream), `calculateITrimpFromLaps` (per-lap avgHR), `calculateITrimpFromSummary` (single avgHR). β = 1.92 (male/unknown) | 1.67 (female). 20 unit tests all passing.
- **`supabase/migrations/20260224_strava_oauth.sql`** (new): `strava_auth_requests`, `strava_tokens` tables with RLS. `ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS itrimp float`.
- **`supabase/functions/strava-auth-start/`** (new): Mirrors `garmin-auth-start`. Initiates Strava OAuth2 PKCE flow; stores ephemeral state in `strava_auth_requests`.
- **`supabase/functions/strava-auth-callback/`** (new): Exchanges code for Strava tokens, stores in `strava_tokens`, redirects to app with `?strava=connected`.
- **`supabase/functions/sync-strava-activities/`** (new): Handles `standalone` (fetches activities + HR streams → `garmin_activities` upsert) and `enrich` (matches existing activities by start_time ±5 min → updates `itrimp` column). Includes inline token refresh.
- **`src/data/stravaSync.ts`** (new): Client-side orchestration. Standalone mode feeds into `matchAndAutoComplete()` pipeline. Enrich mode patches `wk.garminActuals[].iTrimp`.
- **`src/data/supabaseClient.ts`**: Added `isStravaConnected()` and `resetStravaCache()` following the Garmin pattern.
- **`src/types/state.ts`**: `wearable` now includes `'strava'`. Added `biologicalSex?: 'male' | 'female'`. Added `GarminActual.iTrimp?: number | null`.
- **`src/cross-training/universal-load-types.ts`**: Added `iTrimp` field to `ActivityInput`. Extended `DataTier` with `'itrimp'`.
- **`src/cross-training/universalLoad.ts`**: Added **Tier A+** — iTRIMP fires before Garmin Training Effect when `input.iTrimp > 0`. Confidence: 0.95.
- **`src/main.ts`**: Added `wearable === 'strava'` sync branch; Garmin+Strava enrich branch (fire-and-forget); `?strava=connected` redirect handler with toast + account nav.
- **`src/ui/account-view.ts`**: Strava standalone card, Strava HR enrichment card (connect/disconnect/sync), biological sex selector.

---

## 2026-02-24 (Round 14d)

### Fix: GPS runs now enter the plan + completedKm uses actual distances (`src/gps/recording-handler.ts`, `src/ui/events.ts`)

- **Unmatched GPS runs** (e.g. "Just Run", or any run whose name doesn't match a scheduled workout): now added to `wk.adhocWorkouts` on save, linked via `wk.gpsRecordings`, and `rate()` is called (expected RPE 5, type easy). The run is visible on the training week card with a "View Run" button and counts toward adherence and VDOT feedback.
- **completedKm now uses GPS actual distance**: the week-advance loop checks `wk.gpsRecordings[workoutId]` → `loadGpsRecording()` → `recording.totalDistance` before falling back to the planned description distance. Garmin actuals still take priority.
- **Adhoc workouts counted in completedKm**: the week-advance loop now also iterates `wk.adhocWorkouts` (excluding Garmin-sourced entries), so GPS-only runs contribute to the week's km total.

---

## 2026-02-24 (Round 14c)

### Fix: GPS completion modal always shows + discard confirmation (`src/gps/tracker.ts`, `src/ui/gps-events.ts`, `src/gps/recording-handler.ts`, `src/ui/gps-completion-modal.ts`)

- **Timer fix**: `startTime` is now set in `GpsTracker.start()` immediately after GPS permission is granted, not when the first accurate GPS point arrives. Previously the timer showed 00:00 indefinitely on desktop/web (where location accuracy is typically >30m, failing the threshold), and on slow GPS lock. Now the elapsed counter ticks from the moment the user presses Run.
- **Save modal fix**: `stopTracking()` now shows the completion modal/save option when `elapsed > 5s`, even if `totalDistance = 0` (GPS never locked). Previously any run with <10m of tracked distance was silently discarded with no feedback.
- **recording-handler.ts**: No longer bails silently when no matching scheduled workout is found. Now passes `workout: null` to the modal — which shows "Save Run" instead of "Complete Workout" and skips the planned-vs-actual section. Run is still saved to GPS recordings.
- **gps-completion-modal.ts**: `CompletionData.workout` is now nullable. Button row is rendered dynamically via `showMainButtons()` with a shared `currentSaveBtn` reference so RPE selection correctly enables the save button even after returning from discard confirmation.
- **Discard confirmation**: Clicking "Discard" now shows an inline "This run won't be saved. Are you sure?" prompt with "Keep" / "Yes, Discard" — no accidental data loss.

---

## 2026-02-24 (Round 14b)

### Fix + UX: Interval live UI — parsing + phase visibility (`src/gps/split-scheme.ts`, `src/ui/record-view.ts`)

**split-scheme.ts:**
- `resolvePace(zone, paces)`: resolves literal `m:ss/km` pace strings (e.g. `4:49/km`) as well as zone names; used throughout scheme builders.
- `timeIntervalMatch` regex now tolerates optional `(~dist)` parenthetical between zone and rest: correctly parses `"6×2min @ 4:49/km (~790m), 2 min recovery between sets"` → 6 Rep + 5 Recovery segments.
- New `contTimeMatch` handler for `"Nmin @ pace/zone (~dist)"` (continuous threshold/VO2/MP blocks without reps) → single segment.
- `buildTimeIntervalScheme` uses `resolvePace` instead of `getPaceForZone` → handles literal paces from `intentToWorkout`.
- `distAtPaceMatch` updated to `[\w\-:./]+` zone group (tolerates literal paces).

**record-view.ts — Interval UI redesign:**
- **Phase badge** (`rec-phase-badge`) top-right of header: WARM UP (amber) / INTERVAL (blue) / RECOVERY (gray) / COOL DOWN (emerald) / TEMPO (orange); updates on every segment change.
- **Current segment block** moved ABOVE the segment list: label + remaining distance (large) + target pace / "jog / recover".
- **Segment list** now fills remaining flex space (`flex-1 min-h-0`) so it's always fully visible — no fixed max-height.

---

## 2026-02-24 (Round 14)

### Feature: "Edit this week" plan mode in Training tab (`src/ui/main-view.ts`)
- When viewing a past week via the week slider/arrows, the viewing indicator now shows an **"Edit this week"** button
- Clicking it permanently sets `s.w` to the viewed week, clears that week's `garminMatched`/`garminActuals`/`garminPending` and garmin-sourced `adhocWorkouts`, then reloads
- On reload, Garmin sync treats that week as current → activities queue in `garminPending` → review modal fires as normal
- Button wired via `window.__editThisWeek` closure, updated each time `updateViewWeek()` runs

---

## 2026-02-24 (Round 13)

### Fix: Supabase data pipeline — VO2max, LT, max HR not flowing through
- **`garmin_tokens` migration** (`20260219_garmin_oauth2.sql`): added `garmin_user_id text UNIQUE` column + index — without it, `resolveUserId()` in the webhook returns null for every user and nothing gets stored
- **New migration** `20260224_physiology_and_maxhr.sql`: creates `physiology_snapshots` table (LT + VO2max running), adds `max_hr int` column to `daily_metrics`, backfills `garmin_user_id` for existing installs
- **garmin-webhook**: added `handleUserMetrics()` — handles Garmin `userMetrics` push which carries `lactateThresholdSpeed` (m/s → converted to sec/km) and `vo2MaxRunning`; also added `max_hr` to `handleDailies` upsert
- **sync-physiology-snapshot edge function**: now selects and returns `max_hr` from `daily_metrics` so `physiologySync.ts` can update `s.maxHR`

---

## 2026-02-24 (Round 12)

### Feature: Re-review previous week button in Account → Recover Plan (`src/ui/account-view.ts`)
- New "Re-review Week N-1 Activities" button appears inside the Recover Plan card when `s.w > 1`
- Clears the previous week's `garminMatched`, `garminActuals`, `garminPending`, and Garmin-sourced `adhocWorkouts` + run ratings
- Steps `s.w` back by 1 so the re-sync treats that week as current — activities queue into `garminPending` for the normal review modal instead of being silently auto-processed
- After reviewing, user taps "Complete Week" to advance back to the current week

---

## 2026-02-24 (Round 11)

### Fix: Garmin wizard — connected state + auto-populate (`src/ui/wizard/steps/fitness.ts`, `src/data/physiologySync.ts`)
- "Connect Garmin" button now checks `isGarminConnected()` on mount; shows "✓ Garmin Connected" green badge once connected (no more loop)
- After connection detected, calls `syncPhysiologySnapshot(1)` and copies VO2, resting HR, max HR, LT pace into wizard form fields automatically
- `physiologySync.ts`: LT pace (`lt_pace_sec_km`) from Garmin now wired to `s.lt` (was fetched but silently dropped)

---

## 2026-02-24 (Round 10b)

### Feature: Record tab — phased bar UI for tempo/progressive runs (`src/ui/record-view.ts`, `src/gps/split-scheme.ts`)
- **Three distinct live UIs** now based on workout structure:
  - **Simple** — single-pace run (easy, long, freerun): unchanged
  - **Phased** — multiple named phases, no recovery gaps (WU + tempo + CD, progressive): segmented horizontal bar showing all phases proportionally; current phase fills as you run; colour: emerald (done) / blue (current) / gray (upcoming); labels below bar. Current phase block + 4-stat row below.
  - **Interval** — has null-pace recovery segments: full scrollable segment list (unchanged)
- `isPhasedWorkout(scheme)` helper: true when scheme has multiple distinct non-null paces and no null-pace segments.
- `distAtPaceMatch` and `simpleDistMatch` in `buildSingleLineScheme` now produce a **single segment** (not km-by-km) so the tempo middle block appears as one bar, not 13 tiny slices.
- `patchPhasedStats`: updates elapsed/dist/pace/avg + inner phase fill width every tick; triggers full `renderRecordView()` re-render on phase completion (rare, cheap).
- Phase bar short labels: "Warm Up" → "WU", "Cool Down" → "CD", "Easy" stripped for compactness.

---

## 2026-02-24 (Round 10)

### Feature: Pending Activities card + Review Now button (`src/ui/account-view.ts`)
- New blue card in Account tab appears when `wk.garminPending` has unprocessed items (hidden otherwise)
- Lists up to 5 pending activities (type, duration, distance, date) with "+N more" overflow
- "Review Now" button: navigates to Training tab then calls `processPendingCrossTraining()` with 150ms delay, re-opening the full activity review modal
- Fixes "accidentally dismissed review modal" — no need for a full re-sync

---

## 2026-02-24 (Round 9)

### Fix: Plan weeks always start on Monday
- `src/state/initialization.ts`: `planStartDate` now set to `getMondayOf(today)` instead of today's raw date
- `src/state/persistence.ts`: `getMondayOf` exported; `loadState` snaps any existing non-Monday `planStartDate` to Monday on load (one-time migration for existing users)

---

## 2026-02-24 (Round 8)

### Rename: "Generic Sport" → "General Sport"
- Updated display label in `src/constants/sports.ts` (`generic_sport` key)
- Updated all UI references: renderer.ts dropdown, events.ts slot-matching logic and log messages, wizard steps (frequency.ts, volume.ts)
- Internal key `generic_sport` unchanged

---

## 2026-02-24 (Round 7)

### Feature: Plan Recovery card in Account tab (`src/ui/account-view.ts`)
- New amber "Recover Plan" card always visible in the Account tab
- Date picker for original plan start date (pre-filled with a sensible guess based on current week)
- Week number input (pre-filled with current `s.w`)
- On "Restore & Re-sync": sets `planStartDate`, `s.w`, `hasCompletedOnboarding = true`; clears `garminMatched`/`garminActuals`/`garminPending` across all weeks so the next Garmin sync re-processes all activities from the last 28 days
- Page reloads automatically after 800ms; sync fires on boot as normal

### Bug fix: Edit Settings resets plan (`src/ui/events.ts`, `src/ui/wizard/steps/assessment.ts`, `src/ui/wizard/renderer.ts`)
- **Root cause**: `hasCompletedOnboarding` was never set to `true` in the current wizard flow (assessment → main-view path never calls `completeOnboarding()`). So the `isMidPlan` guard in assessment.ts evaluated as `false` even for mid-plan users, allowing `initializeSimulator()` to fire on "Harder Plan" click.
- **`editSettings()` fix**: now also sets `hasCompletedOnboarding = false` so that on reload, `initWizard()` correctly routes to the assessment step (instead of `renderMainView()` bypassing the wizard).
- **`isMidPlan` guard fix** (`assessment.ts`): changed from `currentState.hasCompletedOnboarding && currentState.w > 1` to just `currentState.w > 1` — the week counter is the reliable mid-plan indicator.
- **Mid-plan "Harder Plan" path**: when `isMidPlan`, only updates `s.rw` in-place (no `initializeSimulator` call), preserving all progress.
- **`transitionToMainView()` fix** (`wizard/renderer.ts`): now sets `hasCompletedOnboarding = true` before rendering main view, so future reloads correctly bypass the wizard and `detectMissedWeeks()` works.

---

## 2026-02-24 (Round 6b)

### Bug fix: Split scheme multi-line / WU+CD / progressive segment grouping (`src/gps/split-scheme.ts`)
- **Root cause**: Multi-line workout descriptions (WU + main set + CD) fell through all regexes to `anyDistMatch`, grabbed the first `Xkm` (WU distance), called `buildKmSplits` with `null` pace → two 1km segments with null targetPace → wrongly shown as Structured UI with "km 1 (recovery), km 2 (recovery)".
- **Fix**: `buildSplitScheme` detects `\n` and delegates to `buildMultiLineScheme`: extracts WU (`Xkm warm up …`) and CD (`Xkm cool down …`) as single labeled segments at easy pace; finds the main set line and parses it with `buildSingleLineScheme`; assembles `[WU] + [mainSet] + [CD]`.
- **Progressive fix**: easy portion is now one `"Xkm Easy"` segment instead of km-by-km splits. Fast portion still km-by-km.
- `buildSingleLineScheme` extracted as a named helper for reuse by `buildMultiLineScheme`.
- `timeIntervalMatch` regex zone group broadened to `[\w\-:./]+` to tolerate literal pace strings like `3:47/km`.

---

## 2026-02-24 (Round 6)

### Redesign: Record tab live run UI v2 (`src/ui/record-view.ts`)
- Added `isStructuredWorkout(scheme)` helper: returns true if any segment has `targetPace === null` (recovery) or segments have more than one distinct target pace; easy/long runs with uniform km splits now correctly use Simple UI.
- **Simple UI**: REC dot + workout name, target pace context line, large elapsed time, progress bar with "X.XX / Y.YY km" label (when total distance known), current/avg pace row, Pause + Stop.
- **Structured UI**: header with workout name + "Seg N/T" counter; full scrollable segment list (`rec-segment-list`, `overflow-y-auto max-h-52`); density adapts (≤6 segments → spacious two-line rows, >6 → compact single-line rows); icons ✓ emerald / ● blue / · gray; current row highlighted with blue bg. Current segment block shows remaining distance (large) + target pace. 4-column stats row (elapsed | km total | pace | avg). Pause + Stop.
- `lastCompletedIdx` module var resets to -1 on each `renderRecordView()`; `patchStructuredStats` auto-scrolls current row into view when a split completes.
- `patchSimpleStats` now also updates `rec-progress` bar width on each tick.
- Removed old 4-segment sliding-window strip (`renderSegmentStrip` / `patchStructuredStats` windowed re-render).

---

## 2026-02-24 (Round 5)

### Feature: Record tab live run UI + universal Track Run navigation (`src/ui/record-view.ts`, `src/ui/gps-events.ts`)
- Every "Track Run" button (plan workout cards, Just Run, Record tab Start Run) now navigates to the Record tab instead of staying on the Plan tab with inline GPS.
- `window.trackWorkout` dynamically imports and calls `renderRecordView()` after `startTracking()` completes.
- Added `activeScheme` module var in `gps-events.ts` to store the built split scheme; exported via `getActiveSplitScheme()`.
- Added `setOnTrackingTick()` / `onTrackingTickCb` — called every second by the timer interval so the Record tab can patch its own DOM without full re-renders.
- Record tab renders two distinct live layouts: **Simple** (large time + 4-stat grid) for unstructured runs, **Structured** (segment flow strip + elapsed/distance/pace) for interval/threshold/progressive workouts.
- Segment flow strip shows a sliding window of 4 segments: ✓ done, ● current with km-remaining and target pace, · upcoming.
- Tick handler is deregistered (`setOnTrackingTick(null)`) when the user navigates away from the Record tab, preventing stale DOM writes.

---

## 2026-02-24 (Round 4)

### Removed Training Log UI panel (`src/ui/main-view.ts`, `src/ui/renderer.ts`)
- The "Training Log" card was an in-memory debug console (cleared on every reload) showing internal Garmin sync messages. All useful information is now visible in the "Synced from Garmin" section and plan workout cards. `log()` now writes to `console.log` for dev tools debugging.

### Bug fix: "Synced from Garmin" section shows clean run names, hides ugly IDs and non-run activities (`src/ui/renderer.ts`, `src/ui/activity-review.ts`, `src/types/state.ts`)
- Added `workoutName` field to `GarminActual` and populated it at run match write sites with the human-readable slot name (e.g. "Easy Run", "Long Run").
- Section now shows matched runs using `workoutName` (e.g. "Easy Run · 7.3 km · 5:12/km · HR 142") instead of the internal ID ("W1-easy-0").
- Cross-training and gym matched activities are filtered out of the section — they are already visible as modified plan slots above. Only run-type matched and adhoc entries appear.
- "Synced from Garmin" section now shows for any week with matched or unmatched Garmin runs.

### Bug fix: "Synced from Garmin" section now shows matched plan activities too (`src/ui/renderer.ts`)
- Previously the section only showed adhoc (unmatched) activities with `garmin-` id prefix. Activities matched to plan slots went into `garminActuals` and were invisible in the log. Now both matched (showing workout name, distance, pace, HR, "matched" badge) and unmatched (with RPE + remove button) appear. The section shows for any week that has either.

### Bug fix: Km stats now show run-only distances and correct weekly scope (`src/state/persistence.ts`, `src/ui/renderer.ts`, `src/ui/stats-view.ts`, `src/ui/main-view.ts`)
- All garminActuals km calculations now filter to run-type slots only (exclude cross/gym/strength/rest/tennis/swim/bike/etc. by workout ID keyword). Previously all activity distances were summed regardless of type.
- Retroactive `completedKm` correction in `loadState` uses the same run-only filter.
- Home dashboard stat renamed "Total Km Run" → "Km This Week" and now shows only the current week's run km (live), not a cumulative total. 11km for a week where 11km of running was logged.

### Bug fix: Past week completedKm retroactively corrected from garminActuals on load (`src/state/persistence.ts`)
- `completedKm` was stored using planned km from workout descriptions. On every `loadState`, past weeks that have `garminActuals` entries now have their `completedKm` recomputed from actual Garmin distances, so all stats (total km, bar chart, etc.) reflect what was actually run.
- "Runs rated" renamed to "Runs completed" in stats tab volume card.

### Bug fix: Stats tab volume card now shows true total km and includes current week (`src/ui/stats-view.ts`)
- "Block total" renamed to "Total km" and now includes the current week's km (past `completedKm` + current `garminActuals` sum).
- Bar chart extended to include the current week as a brighter bar.

### Bug fix: Total km stat now uses actual Garmin distance instead of planned (`src/ui/events.ts`, `src/ui/renderer.ts`, `src/ui/main-view.ts`)
- All three km-summing code paths were parsing planned distance from `wo.d` (e.g. "10km"). Now each checks `wk.garminActuals[wId].distanceKm` first and only falls back to the description if no Garmin actual exists.
- `events.ts`: `wk.completedKm` stored on week advance now uses actual distance — this fixes stats-view and all past-week totals.
- `renderer.ts`: current-week live `stat-km` element also uses actuals.
- `main-view.ts`: `_computeTotalKm` (VDOT panel "Total Distance") now uses stored `wk.completedKm` for past weeks (avoiding redundant regeneration) and checks garminActuals for the current week.

### Bug fix: HR target pill hidden for completed runs (`src/ui/renderer.ts`)
- The target HR zone pill was shown even after a run was rated/completed. Added `&& !rtd` so it only appears on planned (not-yet-done) workouts.

### Bug fix: "Start Run" button hidden for Garmin-logged runs (`src/ui/renderer.ts`)
- Garmin-completed runs had `rtd` set but no `gpsRecId`, so the GPS block showed "Start Run" instead of nothing. Fixed by adding `&& !rtd` to the `else if (!viewOnly)` guard — the button is now only shown for workouts that haven't been rated/completed yet.

---

## 2026-02-24 (Round 3)

### Apple Watch / HealthKit sync implemented (`src/data/appleHealthSync.ts`, `src/ui/wizard/steps/fitness.ts`, `src/ui/account-view.ts`, `src/main.ts`)
- Replaced the dead `capacitor-health-kit` package stub with a full implementation using `@capgo/capacitor-health` (`Health.requestAuthorization` + `Health.queryWorkouts`).
- Apple Watch workouts are converted to the same `GarminActivityRow` shape and fed into `matchAndAutoComplete()` — identical pipeline to Garmin.
- Users choose their wearable (Garmin or Apple Watch) during onboarding (fitness wizard step) and in the Account view. The choice is mutually exclusive and stored as `s.wearable: 'garmin' | 'apple'`.
- `src/main.ts` launch sync branches on `s.wearable`: Apple Watch → `syncAppleHealth()`, Garmin → existing `isGarminConnected()` path.
- Account view is now device-aware: shows an Apple Watch card (Sync Now + Switch Device) when `s.wearable === 'apple'`, otherwise the existing Garmin card.
- New state fields: `SimulatorState.wearable?: 'garmin' | 'apple'` and `OnboardingState.watchType?: 'garmin' | 'apple'`.

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
