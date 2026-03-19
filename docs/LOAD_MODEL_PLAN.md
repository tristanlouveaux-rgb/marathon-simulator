# Load Model Plan — Signal A/B Split + Stats Two-Chart Redesign

> Progress tracker for the load model rebuild. Each phase lists what was done,
> how to test it, and what the user should see.

---

## Phase 1: Core Computation — Split ATL/CTL ✅

**What changed:**

- Added `computeWeekRawTSS()` to `src/calculations/fitness-model.ts`
  — same as `computeWeekTSS` but removes the `* runSpec` multiplier in
  the `adhocWorkouts` and `unspentLoadItems` loops. Skips `actualTSS`
  fast-path (stored value is Signal A; raw always recomputes).

- Added `rawTSS` field to `FitnessMetrics` interface.

- Updated `computeFitnessModel()` weekly loop:
  - CTL uses `computeWeekTSS` (Signal A — run-equivalent) — **unchanged**
  - ATL uses `computeWeekRawTSS` (Signal B — total physiological load) — **new**

**How to verify:**
1. Open browser console on any plan week with cross-training (gym, cycling, etc.)
2. `const {computeWeekTSS, computeWeekRawTSS} = await import('/src/calculations/fitness-model.ts')`
3. Grab a week with adhoc cross-training from `getState().wks`
4. `computeWeekRawTSS(wk, {})` should return a **higher** value than `computeWeekTSS(wk, {})`
   — the gap is the runSpec discount being removed.

**What the user should see:**
- ACWR (load ratio) is now higher for weeks with heavy cross-training
- A Hyrox sim or heavy gym week now correctly spikes the risk indicator

---

## Phase 2: Stats Page — Two Charts ✅

### 2a. Chart label rename ✅

- Legend: "Aerobic TSS" → "Aerobic (all sports)", "Anaerobic TSS" → "High intensity"

### 2b. Running Fitness chart ✅

- New `buildRunningFitnessChart()` function added to `src/ui/stats-view.ts`
- Shows CTL (Signal A, 42-day running fitness EMA) as a green line chart
- Appears below the "This Week" + "Distance" summary cards
- Displays current CTL value + trend arrow (↑/→/↓)

**What the user should see:**
- A small green sparkline card labelled "Running Fitness" below the summary cards
- CTL number with trend direction (↑ if fitness is building)
- Caption: "42-day running fitness trend · higher = better prepared for race day"

### 2c. This Week card — Signal B ✅

- `currentTSS` in the "This Week" card now uses `computeWeekRawTSS()` (Signal B)
- The `±%` vs baseline comparison is now honest: raw fatigue vs Signal A CTL baseline

### 2d. Advanced section — labels + context ✅

- "Fitness (CTL)" → "Running Fitness (CTL)" with sub-label "run-equivalent · 42-day avg"
- "Fatigue (ATL)" → "Fatigue (ATL)" with sub-label "total load · 7-day avg"
- Updated ⓘ tooltips explaining the Signal A/B split in plain English
- Added **Running Fitness Level** range card: gradient bar (0–120 scale) with tier labels
  (Beginner / Recreational / Trained / Performance / Elite) + verbal explanation
- ACWR card footer now explains: "Fatigue includes all training. A Hyrox or heavy gym week
  correctly raises this even if you barely ran."

**What the user should see:**
- Metrics grid shows sub-labels for CTL and ATL
- Clicking ⓘ on CTL or ATL shows a plain-English explanation of Signal A vs B
- Below the metrics grid: a coloured range bar showing where their CTL sits (e.g. "Trained")
- ACWR injury risk card has an explanatory sentence at the bottom

---

## Phase 3: SPORTS_DB — Strength runSpec ✅

**What changed:**
- `src/constants/sports.ts`: `strength` runSpec `0.30` → `0.35`

**Rationale:** Compound leg work (squats, deadlifts) has partial but real transfer to
running economy and injury resilience. Signal B (ATL) is unaffected.

---

## Phase 4: Plan View — Weekly Load Badge ✅

**What changed:**
- `src/ui/plan-view.ts`: Added `computeWeekTSS` import
- Week header now shows TSS chip for completed weeks: e.g. `59 TSS` (muted badge)
- Future weeks show nothing (no planned TSS chip for unstarted weeks)

**What the user should see:**
- When viewing a past week: a small grey chip next to the phase label showing `XX TSS`
- Current week and future weeks: no chip

---

## Phase 5: Documentation ✅

- Added **Initialization Principle** section to `docs/PRINCIPLES.md`:
  - Explains the aerobic base gap (Signal A under-estimates cross-training athletes)
  - Documents the Signal B history gap (edge function currently only returns Signal A)
  - Defers code change until Signal B history data is available from edge function

---

## Round 2 Fixes (post-critical-audit) ✅

After a critical adversarial review, the following additional bugs and gaps were fixed:

### Bug fixes
- **Narrative sentence** (`buildNarrativeSentence`): switched to `computeWeekRawTSS` — narrative drives "should I rest?" decisions which are Signal B territory
- **"Training Load vs Plan" bar** in Advanced section: switched to `computeWeekRawTSS` — coaches need honest total load, not just running-equiv. Renamed to "Total Load vs Plan". Added explainer: "Includes runs, gym & cross-training at full physiological weight"
- **Load chart current week**: switched `getChartData()` current week to `computeWeekRawTSS`. Historical bars remain Signal A from Strava (edge fn update deferred). Legend footnote added: "History from Strava · current week includes all training at full physiological weight"

### ATL seed (cross-training-heavy athletes)
- Added optional `atlSeed` param to `computeFitnessModel()` and `computeACWR()`
- Callers pass `atlSeed = ctlBaseline × (1 + 0.1 × gymSessions)` capped at 1.3×
  - 0 gym sessions: ATL seed = CTL seed (pure runner, Signal A ≈ Signal B)
  - 1 gym/week: 1.1× — slight uplift
  - 2 gym/week: 1.2×
  - 3+ gym/week: 1.3× — cross-training-heavy athlete
- Effect: ACWR starts above 1.0 for gym-heavy athletes, correctly flagging elevated fatigue from day 1

### Labels and explanations
- "This Week" card: sub-label changed from "above/below your usual" → "vs your running base"
- "Total load (runs + gym + sport)" label when no baseline yet
- Plan badge: shows both `X run · Y total` when Signal B > Signal A × 1.15 (meaningfully different)
- Badge has `title` tooltip explaining: "Running-equivalent: X · Total body load: Y (includes gym & cross-training at full weight)"

### How to verify Round 2 fixes
1. Open stats page for a week with gym sessions — "Training Load vs Plan" bar should be higher than before (includes full gym load)
2. Narrative sentence: a Hyrox week should say "Load has spiked" / "High load this week" rather than "Lighter week"
3. Plan view past week with cross-training: badge shows `40 run · 95 total` style format
4. Stats Advanced → hover over badge with gym sessions: tooltip explains both numbers
5. `computeACWR` with `s.gs = 3`: ATL starts at CTL × 1.3 so ACWR is ~1.3 from week 1

---

## Out of Scope (Deferred)

- **Signal B historical data from edge function**: ✅ DONE — see Phase 6 below.

- **Signal C (impact) surfacing**: `wk.actualImpactLoad` is computed but not displayed.
  Proposed: day-before warning card on plan view.

- **Nudge card for adding runs**: when fatigue low + running volume below minimum.

- **ACWR attribution**: "Your Hyrox contributed X TSS to this week's load." needs
  per-activity Signal B breakdown in the fatigue tooltip.

---

---

## Phase 6: Signal B Baseline from Strava History ✅ *(2026-03-04)*

**What changed:**
- `supabase/functions/sync-strava-activities/index.ts`: `history` mode now computes
  `rawTSS` (Signal B) per activity — `(iTRIMP × 100) / 15000` with no runSpec discount.
  New `getRawFallbackTSS()` with per-sport physiological rates (cycling 0.60, football 0.60,
  tennis/padel 0.55, walking 0.30, etc.). Sport breakdown now includes `rawTSS` + `sessionCount`.
  Deployed to edge function `elnuiudfndsvtbfisaje`.
- `src/types/state.ts`: Added `historicWeeklyRawTSS`, `signalBBaseline`, `sportBaselineByType`.
- `src/data/stravaSync.ts`: `fetchStravaHistory()` populates all three. `signalBBaseline` =
  8-week simple average of raw TSS. `sportBaselineByType` = per-sport avg session rawTSS +
  sessions/week (Phase 2 calibration data, not yet consumed by reduction logic).

**How to verify:**
```js
// Browser console after Strava sync:
const s = JSON.parse(localStorage.getItem('marathonSimulatorState'));
console.log('Signal B baseline:', s.signalBBaseline);      // e.g. 95 (raw TSS/week)
console.log('Raw TSS per week:', s.historicWeeklyRawTSS);  // e.g. [88, 102, 91, ...]
console.log('Sport baselines:', s.sportBaselineByType);    // e.g. { padel: { avgSessionRawTSS: 38, sessionsPerWeek: 1.2 } }

// Force re-fetch if stale:
const s2 = JSON.parse(localStorage.getItem('marathonSimulatorState'));
delete s2.stravaHistoryFetched; delete s2.signalBBaseline;
localStorage.setItem('marathonSimulatorState', JSON.stringify(s2)); location.reload();
```

**What to see:**
- `[StravaHistory]` console log shows `Signal B baseline: X` alongside CTL baseline
- `signalBBaseline` should be ≥ `ctlBaseline` (raw load is always ≥ running-equiv load)
- `sportBaselineByType` has entries for each non-running sport in the history window

---

## Phase 7: Timing Check — Day-Proximity → Quality Session Downgrade ✅ *(2026-03-04)*

**Why first after Phase 6:** Doesn't need the Signal B baseline. Purely computational.
High-impact for runners doing sport the day before a quality session. No UI needed beyond
a plan card label — wires into the existing `workoutMods` system.

**What to build:**

1. **New file**: `src/cross-training/timing-check.ts`
   - Export `applyTimingDowngrades(wk: Week, allWorkouts: Workout[]): WorkoutMod[]`
   - Logic:
     - For each **unrated** quality session this week (type `threshold`, `vo2`, `long`):
       - Get its `dayOfWeek`
       - Find any completed activity (garminActuals or adhocWorkouts) with Signal B ≥ 30 TSS
         whose recorded day is `sessionDay - 1` (mod 7)
       - If found: return a `WorkoutMod` with `status: 'downgraded'`, intensity reduced
         - `threshold` → marathon pace (`newType: 'marathon'`)
         - `vo2` → threshold pace (`newType: 'threshold'`)
         - `long` → reduce distance by 15% if triggering activity Signal B ≥ 50 TSS
       - `modReason`: `"Timing: hard session day before"`
   - If user reschedules the session to a different day, re-run and mods clear automatically
     (they're computed fresh, not persisted — but we store them as workoutMods for display)

2. **Wire into** `src/data/activitySync.ts` and `src/data/stravaSync.ts`:
   - After any activity syncs and matches, call `applyTimingDowngrades()`
   - Merge resulting mods into `wk.workoutMods` (replacing any previous Timing: mods)

3. **Plan card display** (`src/ui/plan-view.ts`):
   - When a workout has a `modReason` starting with `"Timing:"`, show explanation badge:
     `"Adjusted — hard session yesterday"`
   - Tap for detail sheet: `"You trained hard yesterday. Session adjusted to marathon pace.
     Move this session to a different day for full intensity."`

**How to verify:**
- Log a cross-training activity (>30 TSS) on a Monday
- Check that Tuesday's threshold run shows a downgrade mod in the plan view
- Move the threshold run to Thursday — mod should clear

**Files to touch:**
- `src/cross-training/timing-check.ts` (new)
- `src/data/activitySync.ts`
- `src/data/stravaSync.ts`
- `src/ui/plan-view.ts`

---

## Phase 8: Tier 1 — Auto-Apply Small Excess ✅

**Condition:** This week's Signal B to date exceeds `signalBBaseline` by ≤ 15 TSS
AND the excess comes from a matched or overflow cross-training activity.

**What to build:**

1. **Computation** (`src/calculations/fitness-model.ts` or new helper):
   - `computeWeekSignalBToDate(wk)` — sum raw TSS of all activities recorded so far this week
   - `getWeeklyExcess(wk, s)` → `computeWeekSignalBToDate(wk) - (s.signalBBaseline ?? 0)`

2. **Auto-apply logic** (`src/ui/activity-review.ts` — `autoProcessActivities`):
   - After matching, if excess ≤ 15 TSS: find nearest unrated easy run
   - Compute distance reduction: `excessTSS → easy km` via existing `equivalentEasyKm` formula
   - Apply as a `WorkoutMod` silently (no popup)
   - Store a note on the overflow item or adhoc entry: `autoReduceNote: "Easy run reduced by 1.2km · 18 TSS accounted for"`

3. **Activity card display** (`src/ui/plan-view.ts` or `src/ui/activity-detail.ts`):
   - Show the note beneath the activity card in small muted text
   - Tap to undo: removes the WorkoutMod, re-queues excess as Tier 2

**How to verify:**
- With `signalBBaseline` of ~80, log a cross-training activity adding ~10 TSS excess
- Nearest easy run should have its distance reduced silently
- A note should appear under the activity card
- Tap undo → distance restores, Tier 2 nudge card appears

---

## Phase 9: Tier 2 — Nudge Card Refactor ✅

**Condition:** Cumulative unresolved excess is 15–40 TSS above `signalBBaseline`.

**What to build:**

Refactor `src/ui/excess-load-card.ts`:

1. Change framing from raw TSS total → delta above baseline:
   - Old: `"34 TSS unspent"`
   - New: `"34 TSS above your usual weekly load · Adjust week"`

2. Only show Tier 2 card when `weeklyExcess` is in the 15–40 TSS range.
   Below 15: Tier 1 handles it. Above 40 or ACWR elevated: Tier 3 (existing modal).

3. Remove the blocking modal trigger from `autoProcessActivities` for non-ACWR excess.
   The card is the entry point now. Blocking modal only when ACWR is caution/high.

**How to verify:**
- Log cross-training that puts excess in 15–40 TSS range
- Amber card appears on Training tab with delta framing
- No blocking modal fires
- Tapping card opens reduce/replace flow as before

---

## Phase 10: "Adjust Week" Button + Week-Start Carry-Over Card ⬜

**What to build:**

1. **"Adjust Week" button** (`src/ui/main-view.ts` or plan-view):
   - Appears as a persistent row beneath the session list when Tier 2/3 excess or timing mods exist
   - Taps into combined reduce/replace flow (existing `triggerExcessLoadAdjustment` +
     timing mod summary)
   - Replaces the current ad-hoc "Adjust Plan" button on the excess load card

2. **Week-start carry-over card** (`src/ui/main-view.ts`):
   - On week advance (`next()` in `events.ts`), if `prevWk.unspentLoadItems` is non-empty:
     - Show a top-of-Training-tab card:
       `"Last week had 28 TSS of unresolved load · See how it affects this week"`
     - Tapping opens the Adjust Week flow
     - Dismissable with one tap (sets `wk.carryOverCardDismissed = true`)
   - Existing carry-over persistence logic in `persistence.ts` already moves items — this
     is purely a UI card on top of that

**How to verify:**
- Dismiss a Tier 2 card without adjusting, advance the week
- Week-start carry-over card should appear at top of Training tab
- Dismiss the card → gone, excess load card still shows the items

---

## Typecheck + Build

```bash
npx tsc --noEmit   # must pass with no new errors
npx vite build     # optional: verify bundle compiles
```
