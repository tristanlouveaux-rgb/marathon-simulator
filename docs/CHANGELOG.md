# Changelog

Session-by-session record of significant changes. Most recent first.

---

## 2026-03-05 — Batch 2: load calc, skip logic, cardiac efficiency, injury link, modal copy, km/mi, phases, plan bar, sync button

- **ISSUE-57/42**: `stravaSync.ts` — `fetchStravaHistory` and `backfillStravaHistory` now filter out the current in-progress week before storing to `historicWeeklyTSS` / `historicWeeklyRawTSS` / `historicWeeklyKm` / `historicWeeklyZones`. The edge function always returns the current partial week; storing it caused an off-by-one shift that made Fix 4 in `getChartData` backfill the wrong plan week. Near-zero load for the most recent completed week is now correctly shown.
- **ISSUE-16**: `events.ts` — General fitness / continuous mode second skip now shows "Drop It / Keep It" confirmation dialog instead of silently auto-dropping. Race-time penalty (`s.timp`) only applied in race mode. First skip (push to next week) was already correct in both modes.
- **ISSUE-48**: `events.ts` + `lt-estimator.ts` — Cardiac Efficiency Trend now only records Z2 HR data points (gate added before `recordEfficiencyPoint`). Added >10% improvement significance threshold in `estimateFromEfficiencyTrend()`. This prevents recovery-pace easy runs and aerobic-threshold runs from polluting the trend and causing spurious VDOT decline.
- **ISSUE-09**: `home-view.ts` — ACWR risk caption now identifies and names the top-contributing activity (highest Signal B TSS) from `garminActuals` + `adhocWorkouts`. High/caution captions include top contributor and "Tap to adjust your training plan" CTA.
- **ISSUE-10**: `suggestion-modal.ts` — `acwrHeader` rewrites lead sentence from ACWR ratio to human consequence ("You've been training X% harder than usual"). Titles changed to "Heavy training week" / "Load building up". ACWR ratio preserved in the "See details" panel.
- **ISSUE-31**: `state.ts` + `format.ts` + `account-view.ts` + `home-view.ts` + `stats-view.ts` + `activity-detail.ts` — KM/Mile toggle. Added `unitPref: 'km' | 'mi'` to state, `formatKm()` utility, Preferences card with segmented control in Account. Distance displays updated across all key views.

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
