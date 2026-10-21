# HYROX cross-training adaptation: recommended design

Date: 2026-10-20. Design only: nothing is built. Answers ISSUE-332 with option (b). ISSUE-332 is not marked fixed until Tristan has confirmed it on a device.

**How this was put together.** It starts from the fact map (`docs/audits/agent-outputs/2026-10-20-hyrox-cross-training-map.md`), three candidate designs and two reviews. The base is Design 3, "smallest safe shippable", which had the best average review score (6.5 of 10, against 6.0 for Design 1 "mirror triathlon" and 5.25 for Design 2 "HYROX-native"). Grafted in:
- from Design 1: exact pricing of each change, the Home button, Push to next week;
- from Design 2: a sport-aware give-way order, station work never paying for aerobic credit, and easing the next day's quality run as an option;
- from Review 2: a cut sized to the extra load in place of a fixed 15% trim.

Claims the reviews disproved are left out. Section 6.4 lists them so they are not reintroduced.

**Line references.** "(h2b)" means the worktree `/Users/tristanlouveaux/Documents/mosaic-wt/lane-h2b` (branch fix/hyrox-h2b, HYROX generator v19). Every other reference is the main checkout. Build after lane-h2b merges: main has no `hyrox-session-shape.ts` and is still at `HYROX_GENERATOR_VERSION` 18 (`src/workouts/plan_engine.hyrox.ts:284`), and this design needs h2b's `hyroxPlannedTss` and `hyroxSessionPlannedTss`. Re-check every (h2b) line number after the merge.

---

## 1. Recommendation in plain English

**What the athlete sees.** A football match, a long ride or a padel session syncs from Apple Health, Strava or Garmin, or is logged by hand. Mosaic adds its training load to the week. When sports outside the plan add 15% or more on top of the planned HYROX week, one pop-up appears in the middle of the screen, before the usual "how hard was it" prompt:

```
Load outside the plan
Cycling, 120 min, added 110 TSS this week.

Easy Erg, Wed: 40 to 20 min        −18 TSS
Easy Run, Thu: 45 to 20 min        −23 TSS

Long run, quality run and station sessions stay as planned.

[ Reduce ]  [ Keep ]
[ Push to next week ]
```

- **Reduce** shortens the sessions listed. Nothing in the plan changes until it is tapped.
- **Keep** changes nothing. The ride still counts toward fitness, fatigue and the load ratio, as it does today.
- **Push to next week** changes nothing now. The load is counted in next week's check instead, fading over about a week (founder call 2).
- Closing the pop-up counts as Keep, so the same load never asks twice. If the app is closed mid-question, the Home "Reduce session load" button stays until the load is answered.
- Below 15%, nothing pops up. The activity is logged and counted, as today.

**What changes in the week.** Only easy aerobic filler gives way: standalone easy erg sessions and plain easy runs get shorter, never below 20 minutes, and they keep their day and their easy effort. The cut is sized to the extra load (never more than the load itself) and touches at most 2 sessions, or 3 when the extra load is above 25% of the week.

**Which goes first.**
- After a sport with ground impact (football, padel, an extra run, a hike), easy runs shorten before the easy erg. The erg is the one session with no impact, so it is the one to keep.
- After a sport without impact (cycling, swimming, rowing), the easy erg shortens first. That is the order the HYROX plan itself uses when a week is too big.

**What never changes.** The long run, the quality run (tempo or intervals), every station session, brick and race simulation, the assessment, strength work and commute runs. Football and cycling do not train sled, carry or wall-ball work, so another sport never buys station work off the week.

**Why it cannot break HYROX's own rules.** It only shortens easy sessions. Weekly musculotendon load (MTL) can only fall, so the MTL cap holds. No session moves or gets harder, so the 48-hour eccentric spacing and "no two hard days in a row" hold. A taper keeps its runs, and the long run stays the week's longest. The plan generator does not change, so no generator version bump is needed.

**Example.** A 2-hour easy ride is about 110 TSS (120 min at 0.92 TSS a minute, the easy-effort rate). Take a week where that is 15% or more of the plan, holding a 40-min easy erg and a 45-min easy run. A fixed 15% trim would take about 12 TSS off. The recommended cut takes both sessions to 20 minutes, about 41 TSS.

**What it does not do yet.**
- Football does not count toward MTL. The model has no numbers for other sports (section 3).
- A hard match the day before a tempo run does not ease the tempo run in the first release. That is recommended as the second step (founder call 3).
- No session is dropped whole (Replace, founder call 2), and no station or strength work is cut.

---

## 2. Detection and load valuation

### 2.1 Which activities count as "outside the plan"

Reuse the triathlon detector's sum, `computeCrossTrainingTSS` (`src/calculations/tri-cross-training-overload.ts:272-313`), exported, with two fixes that apply to both modes in their own commit.

- **Plan membership by id.** An activity whose id is in `wk.triWorkouts` is plan (`:276-278`). In HYROX every record of a planned session is keyed by its slot id: matched runs and stations, Mark as Done, quick-done station records, commute runs (h2b `src/calculations/mtl.ts:91-108`, `isMtlSessionCompleted`). So done plan sessions are never counted as extra.
- **Fix A: planned adhoc ids are plan.** Ids for which `isPlannedAdhocId` is true (`src/workouts/planned-adhoc.ts:23`) are skipped in both passes: user-added `adhoc-` sessions, injury capability offers `adhoc-cap-` and `adhoc-strength-` (`src/ui/injury/modal.ts:590`, `:617`), holiday and benchmark sessions. Signal B already applies this rule (`src/calculations/fitness-model.ts:615`). Capability offers add 0 in triathlon today: they carry no load, and pass 1 marks their id counted before its zero check (`:292-294`), so the Mark-as-Done twin is skipped (`:304`). Fix A keeps that true once Fix B lands, and stops a holiday or benchmark session with a stamped load from counting as overload in triathlon.
- **Fix B: an activity with no stored load is valued, not dropped.** A GPS-recorded extra run carries no load on its adhoc entry (`src/gps/recording-handler.ts:185-191`), and its activity record has `iTrimp: null` (`src/calculations/in-app-activity.ts:367`). Pass 1 marks its id counted before the zero check (`:292-294`) and pass 2 then skips the twin (`:304`, `:306`), so it counts 0 today. Value it with Signal B's own per-activity rule: rated RPE, strength override, iTRIMP, else duration × `TL_PER_MIN` at the rated RPE or RPE 5 (`fitness-model.ts:592-606`). Extract that rule from `computeWeekRawTSS` into one exported helper that both call, so the two cannot drift.
- **Per-activity output.** Return each counted activity (id, TSS, and sport from `resolveActualSport`, `src/cross-training/activities.ts:169`, or `resolveAdhocSport`, `:195`) next to the total. HYROX needs it for the give-way order (4.3). Triathlon keeps its `byAffinity` split.

### 2.2 How each activity is valued (Load Currency Law)

- An adhoc entry's `aerobic + anaerobic` is already canonical TSS, stamped at ingest by `addAdhocWorkoutFromPending` (`src/calculations/activity-matcher.ts:2321-2344`): `normalizeiTrimp` when iTRIMP exists, else `calculateWorkoutLoad`.
- An activity record with iTRIMP is read through `normalizeiTrimp` (`tri-cross-training-overload.ts:307`, `:316`). Never `/15000` or `/150`.
- No consumer rescales. There is no sport-specificity discount (`runSpec`) in HYROX; section 9 says why.
- The figure is the activity's own load. It is not the week's Signal B total, which adds a double-day bonus (`fitness-model.ts:640`) and applies its strength override to every strength record (`:595-599`). The pop-up shows only the detector's figure, so no second, different "week load" number appears.

### 2.3 The comparison

- **Unanswered load** = this week's outside-the-plan TSS, plus decayed pushed load from earlier weeks (`computeDecayedTriCarry`, `src/calculations/tri-cross-training-carry.ts:36`), minus load already answered this week (`answeredCrossTrainingTSS`, `src/calculations/tri-suggestion-handled.ts:49`). These are the triathlon detector's steps (`tri-cross-training-overload.ts:168-189`).
- **Planned week** = `hyroxPlannedTss(wk.triWorkouts)` (h2b `src/workouts/plan_engine.hyrox.ts:465`): every session except commute runs, each at `hyroxSessionPlannedTss` (h2b `src/workouts/hyrox-session-shape.ts:126-139`). The triathlon detector sums `aerobic + anaerobic` instead (`:162`), which is 0 for HYROX because the HYROX generator never stamps those fields. That is why the triathlon detector could never fire in HYROX, even without its mode gate (`:154`).
- **Fires** when unanswered ÷ planned is 0.15 or more. Above 0.25 the case is "extreme". At most 2 sessions change, 3 when extreme (`tri-cross-training-overload.ts:44`, `:47`, `:50-51`; exported and imported, never copied). Reusing these for HYROX is founder call 4.
- `hyroxPlannedTss`'s total is not the Home planned-day total: the Home pricer skips skipped and rated-skip sessions and sizes minutes with `estimateTriWorkoutMin` (h2b `src/ui/planned-day-tss.ts:104-134`). The two share the per-session rate only. The pop-up therefore shows the added TSS and the per-change TSS, never a planned-week total.

### 2.4 How much the plan may give back (the budget)

budget = TAU × (1 − e^(−unanswered ÷ TAU)), with TAU 491 (`src/cross-training/universal-load-constants.ts:104`), computed by `saturateCredit` (`src/cross-training/universalLoad.ts:72`, exported for this). The curve has slope 1 at zero, so the cut can never exceed the load ("a credit can't exceed its load"; anchor 4 at `src/calculations/load-currency-anchors.test.ts:144-150`). It is the curve running uses, and the one triathlon moves to in commit 1 (6.1). Triathlon's current 1500 / 800 curve (`tri-cross-training-overload.ts:54-55`, `:200`) has slope 1.875 at zero and is not reused.

### 2.5 When it stays quiet

Not HYROX; no current week; unanswered load below 15% of the planned week; no eligible session above 20 minutes (4.1); or the suggestion overlay or the activity review overlay is already open.

### 2.6 Side of the line

Planning. The detector reads tracked load and prescribes. It is pure: it never writes MTL, the load ratio, adherence or any other state. Only an accepted Reduce or Push changes state.

---

## 3. MTL and eccentric treatment

### 3.1 Other sports add no MTL in v1

- MTL factors exist only for HYROX stations and run intensities (h2b `src/constants/hyrox-constants.ts:256`, `:269`). `computeComponentMTL` (h2b `mtl.ts:37-63`) returns 0 for anything else. Pricing football, padel or cycling into MTL needs new numbers (section 9).
- MTL from other sports would move tracked numbers on several surfaces: the MTL load ratio (`computeMtlAcwr`, h2b `mtl.ts:364`), chronic MTL against plan (`:408`) and the MTL-gap re-anchor of next week's hours (`resolveMtlAdherence`, `:446`). A planning feature must not move those.
- **Rejected: Design 2's partial MTL for off-plan runs and rows.** It priced a whole run at one RPE band, while the generator prices a quality run per segment, with the warm-up at RPE 4 (h2b `src/workouts/hyrox-generators.ts:330-387`). And `computeWeekMTL` keeps a skipped plan run's MTL (h2b `mtl.ts:86-89`), so a run done in place of a skipped one counted twice and could set off cap trims that were not needed.
- **Honest limitation.** Leg load does not cover football's tissue cost either. Soccer is 0.15 leg load a minute (`src/constants/sports.ts:94`), so a 90-minute match is 13.5, under `LEG_LOAD_MODERATE` 20 (`src/calculations/readiness.ts:65`), and HYROX hides the readiness action button (`src/ui/home-view.ts:1309-1317`). v1 gives aerobic relief, not tissue relief. The sport-aware order (4.3) and the day-after option (4.7) are partial answers. `SCIENCE_LOG.md` must say so.

### 3.2 Accepted changes keep MTL honest

- A shortened easy run or easy erg is one block at RPE 4, and `computeComponentMTL` is linear in minutes. Scaling its MTL by new ÷ old minutes therefore gives exactly what the generator would (h2b `hyrox-generators.ts:385-387` for the run, `:575-604` for the erg).
- Planned weekly MTL (`computeWeekMTL`, h2b `mtl.ts:86`) can only fall, so `HYROX_MTL_CAP` (h2b `hyrox-constants.ts:187`, enforced by `enforceMTLCap`, h2b `plan_engine.hyrox.ts:597`) holds without being read.
- Planned and completed MTL fall together, so `resolveMtlAdherence` (h2b `mtl.ts:446-470`) does not read an accepted cut as missed training and does not lower next week's hours.

### 3.3 Eccentric spacing and hard days

- v1 never moves a session, adds a station or raises an intensity. Easy runs and easy erg are neither hard (`isHighIntensity`, h2b `src/workouts/scheduler.hyrox.ts:46`) nor eccentric (`isEccentricSession`, `:70`). The 48-hour eccentric rule and the no-adjacent-hard-days rule (hierarchy level 1, h2b `plan_engine.hyrox.ts:3420-3440`) therefore hold by construction.
- v1 does not treat a sport as a hard or eccentric day. The day-after option is 4.7 (founder call 3). An eccentric sport list is in section 9.

---

## 4. Plan actions and the order they apply in

### 4.1 Which sessions may change

A session in the current week's `wk.triWorkouts` that:
- has an id and falls today or later;
- is open (`isOpenForTriSuggestion`, `tri-suggestion-handled.ts:29`): not completed, skipped, replaced or already reduced (by an earlier accept, or by the Adjust overlay, `src/ui/workout-adjust-overlay.ts:517`);
- is not done by record (`isMtlSessionCompleted`, h2b `mtl.ts:108`) and has no `wk.rated` entry;
- is not an illness or holiday session, a planned adhoc id or a commute run;
- is a standalone easy erg (`isHyroxEasyErg`, `src/workouts/hyrox-easy-erg.ts:26`) or a plain easy run (`isPlainEasyRun`, h2b `plan_engine.hyrox.ts:561`, to be exported);
- is longer than 20 minutes (`HYROX_RUN_FLOOR_MIN`, h2b `hyrox-constants.ts:690`, documented there as the floor of both easy runs and easy erg sessions).

### 4.2 Never touched

- The long run (`isHyroxLongRun`, h2b `scheduler.hyrox.ts:82`) and the quality run: hierarchy step 3a (h2b `plan_engine.hyrox.ts:3468-3472`).
- Station sessions, bricks, mini bricks, the race simulation and the assessment: steps 3b and 3c (`:3473-3474`). Another sport does not train sled, carry or wall-ball capacity, so aerobic credit never buys station work off the week. Station work gives way only to the MTL cap, which v1 cannot trip.
- Strength sessions and strength blocks (step 3d', `:3477-3484`), for the same reason.
- Commute runs: the athlete's travel, outside the plan's own load (h2b `plan_engine.hyrox.ts:443-451`).
- Every session's day and intensity.

### 4.3 The order

- **Default.** The hierarchy gives way in reverse order, "e, d', d, c" (h2b `plan_engine.hyrox.ts:3492`): easy erg (e) first, then easy runs (d). Strength (d') and station work (c) are skipped (4.2).
- **Sport-aware swap.** When most of the unanswered load comes from a sport with ground impact, easy runs give way before easy erg. After football the erg is the one session with no impact and no eccentric phase (Review 1's main objection to Designs 1 and 3).
  - "Impact" means a running activity (`isRunSport`, `activities.ts:204`; the running row's `impactPerMin` is 0 at `sports.ts:104` because running impact is counted per km) or any sport whose `impactPerMin` is above 0 (field at `src/types/activities.ts:52`). Examples: soccer 0.12 (`sports.ts:94`) and padel 0.05 (`:120`), against cycling 0.00 (`:99`), swimming 0.00 (`:98`) and rowing 0.00 (`:106`).
  - With several sports, the bucket holding more unanswered TSS decides. Pushed load counts as impact, as triathlon attributes its carry to running (`tri-cross-training-overload.ts:174-178`). This mirrors triathlon's affinity pick (`pickRecommendedDiscipline`, `:239`).
  - It is a yes/no test on existing data, not a tuned number. Log it in `SCIENCE_LOG.md`.
- Within a group, nearest day first, as triathlon orders its candidates (`sortByDayThenQuality`, `:523`).

### 4.4 How much each session shortens (founder call 1)

- **Recommended: sized to the load.**
  1. Take the first 2 eligible sessions in the order above (3 when extreme).
  2. Shorten the sessions of the first group (easy erg, or easy runs after an impact sport) together toward 20 minutes, in whole minutes, until the cut reaches the budget (2.4) or the group is at 20 minutes.
  3. Then do the same with the next group.
  4. Stop at the budget, or when every chosen session is at 20 minutes.

  This is the method `enforceMTLCap` uses to shorten easy runs (h2b `plan_engine.hyrox.ts:605-614`), counted in TSS instead of MTL, and rounded down so the total never passes the budget.
- **Alternative: fixed trim.** Each chosen session is 15% shorter (`TRIM_DURATION_FACTOR` 0.85, `src/calculations/tri-suggestion-apply.ts:77`), skipped when that lands under 20 minutes. At 0.92 TSS a minute, one trim of a 40 to 60 minute easy session removes about 5.5 to 8 TSS. Two or three trims therefore offset 11 to 25 TSS against a 60 to 150 TSS sport, which Review 1 judged too small to matter.
- **Exact pricing, either way.** Each change's `tssReduction` = `hyroxSessionPlannedTss(before)` − `hyroxSessionPlannedTss(after)`, computed on the same object the apply step writes. The modal line and the plan change come from one computation. (Triathlon books a flat 15% of planned load at `tri-cross-training-overload.ts:411` while its apply step makes its own cut, so the two can disagree.)

### 4.5 Apply

New `src/calculations/hyrox-cross-training-apply.ts`, `applyHyroxCrossTraining(state, changes)`. It stays out of `tri-suggestion-apply.ts` so triathlon's gate and trim stay untouched. (Design 3's commute branch in `canApplyTriSuggestion` would have changed triathlon commute runs, which triathlon plans carry: `src/workouts/plan_engine.triathlon.ts:1574`.)

- Finds each session by id in the current week. One change per session per batch, as triathlon guards (`tri-suggestion-apply.ts:102-106`).
- Re-checks eligibility and that the session still has the minutes the preview used. Otherwise it skips the session.
- Writes through a new pure helper, `withHyroxEasyMinutes(w, minutes)`, in h2b `hyrox-generators.ts` beside `withHyroxRounds` (`:411`):
  - `estimatedDurationMin` becomes the new minutes; f = new ÷ old;
  - `musculoTendonLoad` × f;
  - on a run, the run component's `distanceM`, `durationSec` and `mtl` × f, so `hyroxRunLengthKm` (`:281`), which the single-run rule reads, stays true;
  - the leading "N min" (and the "~X km" on a run) rewritten in the generator's own format. Not `scaleDescriptionProportional`: it writes "38min" and "6.2km", and ISSUE-336(d) records its misreads.
- Keeps id, day, type and RPE. Sets status `'reduced'` (shown as Adjusted on HYROX cards: `src/ui/workout-status.ts:56`, `:243`; `src/ui/hyrox/plan-view.ts:552`), stamps `originalName`, and sets `modReason` to "Shortened for cross-training load."
- The detector and the apply step call the same preview function.

### 4.6 Keep, Push and closing

- **Keep** and **closing the pop-up** record the load as answered (`markTriSuggestionsHandled`, `tri-suggestion-handled.ts:64`). No plan change. This follows triathlon's current rule. If ISSUE-337 changes what closing means for triathlon, HYROX follows.
- **Push** (founder call 2) adds the answered TSS to `wk.carriedCrossTrainingTSS`, as `src/ui/triathlon/tri-suggestion-modal.ts:143-154` does, and records it as answered. Next week's check adds it back, decayed with a 7-day constant over at most 3 weeks (`tri-cross-training-carry.ts:21`, `:25`; about 37% after one week, per its comment at `:23-24`). Push matters most for the weekend match, when only the protected long run is left this week.

### 4.7 Second step, if founder call 3 is B: ease the quality run the day after a hard sport

- **Trigger:** outside-the-plan load of 50 TSS or more (running's day-after trigger, `SIGNAL_B_TRIGGER`, `src/cross-training/timing-check.ts:54`) on the day before an open tempo or interval run in the same week.
- **Change:** that run becomes an easy run of the same length, built by `generateHyroxRun` (h2b `hyrox-generators.ts:286`) as the engine's own `toEasy` does (h2b `plan_engine.hyrox.ts:2114-2117`), from `hx.athleteBand`, `hx.hyroxRunPaceSecKm` and `state.bodyWeightKg`, the inputs the engine reads (`:1283-1285`, `:1699`).
- **Shown** as a separate tick row under the Reduce section. The modal already holds two sections that commit separately (`tri-suggestion-modal.ts:13-16`). The row does not count toward the 2 or 3 change limit, and it is answered once, by its own id.
- **Not covered:** station sessions. Easing a race-pace station session to technique needs the engine's `makeStation`, a closure (h2b `plan_engine.hyrox.ts:2118`). A 48-hour rule for stations needs the eccentric sport list (section 9).
- Mirrors running's day-after downgrade and triathlon's `downgrade_today`. Running's TSS tiers (`timing-check.ts:75-80`) are not mirrored: a HYROX quality run has one easier kind, the easy run.
- Hard and eccentric flags can only fall, and MTL falls.

### 4.8 Why every HYROX rule still holds

| Rule | Why it holds |
|---|---|
| MTL weekly cap | Changes only lower `musculoTendonLoad` |
| 48 h eccentric spacing, no adjacent hard days | No session moves; no session gets harder (4.7 only makes one easier) |
| Quality run and long run protected | Never eligible for a cut (4.7, if chosen, eases the quality run and never shortens it) |
| Week's last station session protected | No station work is eligible |
| Trim order (easy erg, easy runs, station work) | Followed, stopping before station work |
| Taper keeps its run count; taper floors | Nothing is dropped; only easy sessions shorten, never below 20 min |
| Single-run rule; long run is the longest | Only non-long runs shorten |
| `HYROX_GENERATOR_VERSION` bump trap | No generated output changes (new exports and one pure helper only) |

---

## 5. UI and triggers

### 5.1 UI pre-flight (for the implementer)

Read `docs/UX_PATTERNS.md` and the CLAUDE.md copy rules first. Patterns modelled: the overload section of `showTriSuggestionModal` (`tri-suggestion-modal.ts:225-339`) for header, rows and buttons, and its generic row (`:393-412`) for the 4.7 row. Visual constraints: no severity pill, no chips, no tinted backgrounds, no icons, no all-caps labels. The only coloured element is the existing Reduce button, a commit button as in triathlon (`:260-264`). Existing surface check: no HYROX surface shows "load added by other sports" today, so nothing is duplicated. Run `npm run lint:ui` after the edit.

### 5.2 The modal

- Reuse `showTriSuggestionModal` (`tri-suggestion-modal.ts:40`): centred overlay (`:63-69`), plan changes only inside button handlers (`:116-154`), and a backdrop close that answers the load (`:81-89`).
- Add an optional `hyroxOverload` field to `TriSuggestionMod` (`src/calculations/tri-suggestion-aggregator.ts:39-71`). When present, the modal renders a HYROX section: header line, rows, protected line, then Reduce, Keep and Push. Triathlon's `overloadOptions` type stays untouched. That avoids the cross-mode refactor Review 2 measured (19 sites in the triathlon overload tests index `options.swim/bike/run`).
- Reduce calls `applyHyroxCrossTraining`. Keep, Push and the backdrop reuse triathlon's handlers.
- A new collector, `collectHyroxCrossTrainingSuggestions(state)`, returns a `TriSuggestionBundle` holding the HYROX row only. Triathlon's other detectors do not run in HYROX (`detectRpeBlownSession` is not mode-gated).

### 5.3 Copy (consultant tone, no em dashes)

- Title: "Load outside the plan"
- Line: "Cycling, 120 min, added 110 TSS this week." Up to two activities by name, then "and N more".
- Rows: "Easy Erg, Wed: 40 to 20 min" and "Easy Run, Thu: 45 to 20 min", each with "−N TSS" in muted text.
- Protected line: "Long run, quality run and station sessions stay as planned."
- Buttons: "Reduce", "Keep", "Push to next week".
- 4.7 row: headline "Thu Tempo Run: easy run, same 45 min", body "Cycling the day before."
- Manual log subtitle in HYROX (`src/ui/log-activity-overlay.ts:46-49`): "A session done outside the plan. Its load counts toward the week and can shorten upcoming easy sessions."
- No planned-week total, no percentage, no MTL figure.

### 5.4 Triggers

One helper, `maybeShowHyroxCrossTrainingModal()` in a new `src/ui/hyrox/hyrox-cross-training-prompt.ts`. It checks for HYROX, skips when an overlay is open, collects, shows, and re-renders after a change.

1. **Automatic sync.** Apple, Strava and Garmin all reach `autoProcessActivities` (`src/data/activitySync.ts:247`, `:286`; `src/ui/activity-review.ts:1894`). Call the helper right after the overflow is logged and saved (`activity-review.ts:2119`), before the Tier-1 trim (`:2121`) and the load-ratio gate (`:2186-2201`). Then show the toast, render and run the RPE prompt, and return. Today the HYROX redirect at `:2221` runs only when the load ratio is at caution or high, so in a normal week a sync would never show the pop-up.
2. **Batch review.** `applyReview` reaches `redirectToTriSuggestionFlow` at `:1531`. Its HYROX branch (`:193-196`) awaits the helper, then runs `afterHyroxLog` (the RPE prompt).
3. **Manual log.** `submitAdhocForMode` (`log-activity-overlay.ts:173-206`) calls the helper after saving, for HYROX.
4. **GPS extra run.** The multi-sport branch (`recording-handler.ts:215-220`) calls the helper for HYROX. The run only has load to judge after Fix B (2.1).
5. **Home backstop.** `home-view.ts:1243-1246` builds the HYROX bundle. `showAdjustButton` (`:1309-1317`) is true in HYROX when the bundle holds a change, with the label "Reduce session load". The click handler (`:3315-3330`) opens the modal.

No `main.ts` change. Widening the launch gate at `main.ts:2091` would be dead code: its only caller, `refreshTriPredictionAfterSync`, returns for every mode except triathlon (`:1783`) and runs only after a Strava sync (`:1531`). The Home button is the backstop.

### 5.5 Notify-once

- Every exit (Reduce, Keep, Push, backdrop) adds the shown TSS to `wk.triSuggestionsHandled.crossTrainingTSS` (`tri-suggestion-handled.ts:64-79`). Re-launches and Home re-renders never re-pop it. A later activity is judged on its own increment. The record lives on the week and resets with it.
- The 4.7 row is answered by its id (`modIds`).
- Order: pop-up first, RPE prompt second, as running (`activity-review.ts:1540-1611`) and triathlon do. For an activity without heart rate, the RPE answer can re-price it afterwards (`activity-review.ts:2115-2116`). The extra load can only pop up on its own if it crosses 15% by itself.

### 5.6 Cards after a change

Shortened sessions show the existing Adjusted chip and their `modReason`. If Push ships, show the carry banner in HYROX too (`buildTriCarryBanner`, `home-view.ts:2834-2846`, called at `:2815`). Its amber tint predates the Visual Constraints: switch it to the neutral bordered style when it gains HYROX, and run the UI lint.

---

## 6. Files and tests

### 6.1 Commit order

0. Wait for lane-h2b to merge. Re-verify every (h2b) line number.
1. **Triathlon fix, own commit.** Replace the 1500 / 800 curve (`tri-cross-training-overload.ts:54-55`, `:200`) with the exported `saturateCredit`. Overload trims say "Manage load" instead of "Volume ramp trim" (`tri-suggestion-apply.ts:591`). Add a load-currency anchor: the overload budget never exceeds the unanswered TSS. Add a `SCIENCE_LOG.md` entry. Triathlon budgets fall (50 TSS unlocks about 47 TSS of cuts instead of 91), though the change limits usually bind first. Re-run the triathlon suites.
2. **Shared detector fixes, both modes.** Export `computeCrossTrainingTSS` and the thresholds; Fix A; Fix B with the shared Signal B helper; per-activity output.
3. **HYROX engine exports, no output change.** `withHyroxEasyMinutes` in `hyrox-generators.ts`; export `isPlainEasyRun` (as `isHyroxPlainEasyRun`). If importing `plan_engine.hyrox` from a calculations module causes an import cycle or a load-order (TDZ) crash, move `hyroxPlannedTss` into `hyrox-session-shape.ts` and re-export it. No `HYROX_GENERATOR_VERSION` bump (19 at h2b `plan_engine.hyrox.ts:424`); the unchanged plan snapshot and rules tests prove it.
4. **HYROX detector and apply.**
5. **UI and triggers.**
6. **If founder call 3 is B:** the day-after row.
7. **Docs:** `FEATURES.md`; `CHANGELOG.md`; `ARCHITECTURE.md` (new modules, HYROX data flow); `SCIENCE_LOG.md` (overload denominator, budget curve, give-way order and impact test, MTL exclusion and its limitation); `OPEN_ISSUES.md` ISSUE-332 (built, not fixed until device-confirmed); `DEVICE_TESTS.md` (pop-up before the RPE prompt on a real sync).

### 6.2 Files

Main checkout:
- `src/calculations/tri-cross-training-overload.ts`: commits 1 and 2.
- `src/cross-training/universalLoad.ts`: export `saturateCredit` (`:72`).
- `src/calculations/fitness-model.ts`: extract the per-activity Signal B valuation (`:592-606`) into an exported helper used by `computeWeekRawTSS` and the detector.
- `src/calculations/tri-suggestion-apply.ts`: overload trim reason only (`:572-593`).
- `src/calculations/hyrox-cross-training.ts` (new): `detectHyroxCrossTraining`, `collectHyroxCrossTrainingSuggestions`, the preview function.
- `src/calculations/hyrox-cross-training-apply.ts` (new): `applyHyroxCrossTraining`.
- `src/calculations/tri-suggestion-aggregator.ts`: optional `hyroxOverload` on `TriSuggestionMod` (type only).
- `src/ui/triathlon/tri-suggestion-modal.ts`: HYROX section.
- `src/ui/hyrox/hyrox-cross-training-prompt.ts` (new): the trigger helper.
- `src/ui/activity-review.ts`: `:193-196`, and after `:2119`.
- `src/ui/log-activity-overlay.ts`: `:46-49`, `:173-206`.
- `src/gps/recording-handler.ts`: `:215-220`.
- `src/ui/home-view.ts`: `:1243-1246`, `:1309-1317`, `:2815`, `:2834-2846`, `:3315-3330`.
- `src/types/state.ts`: no new fields. Update the comments on `carriedCrossTrainingTSS` and `triSuggestionsHandled` (`:734`, `:738`), which now serve HYROX too. Shared file: dump a /tmp patch first.

From lane-h2b, after the merge:
- `src/workouts/hyrox-generators.ts`: `withHyroxEasyMinutes`.
- `src/workouts/plan_engine.hyrox.ts`: export `isPlainEasyRun`.
- `src/workouts/hyrox-session-shape.ts`: only if `hyroxPlannedTss` has to move.

### 6.3 Tests

Detector (`src/calculations/hyrox-cross-training.test.ts`, new):
- Null in running and triathlon. Null below 15% of `hyroxPlannedTss`. Fires at 15% with a limit of 2, and above 25% with a limit of 3. A HYROX week with no `aerobic/anaerobic` stamps still fires.
- Activity set: `adhoc-cap-`, `adhoc-strength-`, `adhoc-`, `holiday-` and `benchmark-` ids add 0, with or without stamped load and with a Mark-as-Done record under the same key. `garmin-`, `garmin-manual-` and GPS recording ids count. A GPS extra run with no iTRIMP counts its Signal B figure.
- Eligibility: only easy erg and plain easy runs above 20 minutes. Never the long run, a tempo or interval run, a technique or race-pace station session, a brick, mini brick, race simulation, assessment, strength session or commute run, a past day, a session done by record, a rated, reduced, skipped or replaced session, an illness or holiday session, or a planned adhoc id.
- Order: cycling puts easy erg first. Football, padel and an extra run put easy runs first. Mixed sports follow the larger bucket. Nearest day first within a group.
- Size: total cut ≤ budget ≤ unanswered TSS. Every changed session is at least 20 minutes. At most 2 or 3 sessions change. (If founder call 1 is A: each cut is 15%, skipped below the floor.)
- Pricing: each `tssReduction` equals `hyroxSessionPlannedTss(before)` − `hyroxSessionPlannedTss(after)` of the applied session.
- Purity: state is deep-equal before and after detection and collection.
- Notify-once: after `markTriSuggestionsHandled({ crossTrainingTSS })` the detector returns null. A later activity fires on its own increment. Pushed load shows up next week through `computeDecayedTriCarry`.

Apply (`src/calculations/hyrox-cross-training-apply.test.ts`, new):
- Easy run: duration, `musculoTendonLoad` and the run component match `generateHyroxRun` at the new minutes (to rounding). The description's minutes and km follow. Id, day, type and RPE are kept. Status is `'reduced'` and the reason is set.
- Easy erg: MTL scales exactly by new ÷ old. Description minutes follow. No components are added.
- A session that changed since the preview is skipped. One change per session per batch.
- `resolveMtlAdherence` gives ratio 1 after an accepted cut when the remaining sessions are done.

Invariants: a property test over generated plans (every band, the hours grid, doubles, base, build, peak, deload, taper and race week), applying every proposal. `computeWeekMTL` does not rise. No day changes. The hard and eccentric sets (`isHighIntensity`, `isEccentricSession`) are unchanged (or smaller, with 4.7). The run count is unchanged. The long run is still the longest run. Every changed session is at least 20 minutes. Long run, quality run, station, brick, race simulation, assessment and strength sessions are deep-equal to before.

Modal (`src/ui/triathlon/tri-suggestion-modal.test.ts`): the HYROX section has no chips and no pill. Reduce applies through `applyHyroxCrossTraining`. Keep, Push and the backdrop each record the TSS. Push writes `carriedCrossTrainingTSS`. Nothing changes before Reduce. The triathlon layouts are unchanged.

Triggers:
- `src/ui/plan-changes-running-only.test.ts:308-321`: rewrite. The running modal is still never called and no `workoutMods` are written, the ride is logged once, and the HYROX overlay opens before the RPE prompt with the load ratio at both 'safe' and 'high'.
- `:336`: keep (no `Auto:` mod on a commute run).
- `:362`: rewrite. The Home button shows in HYROX only when the HYROX bundle holds a change.
- Manual log, GPS extra run and batch review in HYROX open the overlay above the threshold. Below it, toast only.

Triathlon regressions: all triathlon suggestion suites pass after commits 1 and 2. The new anchor holds from 10 to 900 TSS. Overload trims read "Manage load". Holiday and benchmark sessions no longer count as overload. A triathlon GPS extra run now counts.

Generator guard: `generateHyroxPlan` output is byte-identical, and `HYROX_GENERATOR_VERSION` is unchanged.

Gates: `npx tsc --noEmit`, `npx vitest run`, `npm run lint:ui`.

### 6.4 Traps the reviews found (do not reintroduce)

- Widening `main.ts:2091` does nothing for HYROX: its only caller returns at `:1783`, and it runs only after a Strava sync.
- `activity-review.ts:2221` sits behind the load-ratio gate (`:2186-2201`). In a safe week it is never reached.
- GPS extra runs count 0 in the shared detector until Fix B.
- Capability offers do not count as overload in triathlon today (Design 2 said they did).
- `hyroxPlannedTss`'s total is not the Home planned-day total. Only the per-session rate is shared.
- `enforceMTLCap` never trims easy erg; erg is sized after the cap (h2b `plan_engine.hyrox.ts:568-570`). The erg-first order comes from the hierarchy (`:3492`).
- The Adjust overlay never rescales HYROX MTL (`applyObjectScale`, `workout-adjust-overlay.ts:453-520`, writes no `musculoTendonLoad`), contrary to the fact map. Adjacent bug, separate fix.
- The rollover rebake (`src/ui/events.ts:830-844`, run at `:1343`) rebuilds from the new current week and never touches the week where a cut was accepted. The real exposure is the version-bump regen (h2b `src/state/hyrox-plan-regen.ts:282`, which keeps only `adhoc-` and `holiday-` ids, `:87`) and the injury regen (`src/ui/injury/modal.ts:504-505`).
- `toEasy`, `toTechnique` and the cap's run remake are closures inside the week builder (h2b `plan_engine.hyrox.ts:2103-2118`), not exportable as they are. v1 needs none of them; 4.7 calls `generateHyroxRun` directly.
- The detector's activity figure differs from the week's Signal B total (double-day bonus).
- An activity set limited to `garmin-` ids misses GPS runs (`recording.id`) and legacy `manual-` entries.
- `SPORTS_DB.intermittent` also flags boxing and martial arts, which carry no leg load (`sports.ts:108`, `:110`). It is not used as a hard-day flag.

---

## 7. Every number used

| Number | What it does here | Source | Status |
|---|---|---|---|
| 0.15 | Unanswered ÷ planned at which the pop-up fires | `OVERLOAD_THRESHOLD`, `tri-cross-training-overload.ts:44` | Reused from triathlon; founder call 4 |
| 0.25 | Above it, "extreme": 3 changes allowed | `EXTREME_THRESHOLD`, `tri-cross-training-overload.ts:47` | Reused; founder call 4 |
| 2 / 3 | Most sessions changed (heavy / extreme) | `MAX_MODS_HEAVY`, `MAX_MODS_EXTREME`, `tri-cross-training-overload.ts:50-51` | Reused from triathlon |
| 491 TSS | Budget curve constant (slope 1 at zero) | `TAU`, `universal-load-constants.ts:104` | Reused from running |
| 20 min | Shortest easy run and easy erg | `HYROX_RUN_FLOOR_MIN`, h2b `hyrox-constants.ts:690` | Existing HYROX floor |
| RPE 4 | Effort of easy runs and easy erg, which sets their price | `HYROX_EASY_RPE`, h2b `hyrox-constants.ts:669` | Existing |
| 0.92 TSS/min | Price of an easy minute | `TL_PER_MIN[4]`, `sports.ts:19`, via `plannedTssPerMin` (`sports.ts:65-69`) and `hyroxSessionPlannedTss` (h2b `hyrox-session-shape.ts:126-139`) | Existing |
| 0.85 / 0.15 | Aerobic / anaerobic split of a measured activity at ingest (summed back here, no effect) | `activity-matcher.ts:2334-2335` | Existing, unchanged |
| RPE 5, `TL_PER_MIN` rows, distance × 6 | Valuing an activity with no stored load (Fix B) | `fitness-model.ts:600-605` | Existing Signal B rule, shared |
| 0 (`impactPerMin` above 0) | Impact or no-impact sport, for the order | field `types/activities.ts:52`; values `sports.ts:94-133`; runs by `isRunSport`, `activities.ts:204` | Yes/no test on existing data; log in SCIENCE_LOG |
| 0.85 | Fixed trim (only if founder call 1 is A) | `TRIM_DURATION_FACTOR`, `tri-suggestion-apply.ts:77` | Reused; founder call 1 |
| 7 days / 3 weeks | Push decay constant and lookback | `ATL_TAU`, `MAX_LOOKBACK_WEEKS`, `tri-cross-training-carry.ts:21`, `:25` | Reused; founder call 2 |
| 5 TSS | Carry banner hidden below it | `home-view.ts:2836` | Existing |
| 50 TSS | Day-after trigger (4.7 only) | `SIGNAL_B_TRIGGER`, `timing-check.ts:54` | Reused from running; founder call 3 |
| 500 to 2000 MTL by band | MTL cap; not read, holds because MTL only falls | `HYROX_MTL_CAP`, h2b `hyrox-constants.ts:187-194` | Existing |
| 19 | Generator version, unchanged | `HYROX_GENERATOR_VERSION`, h2b `plan_engine.hyrox.ts:424` | No bump |
| Eccentric sport list | Which sports trigger the 48 h rule | none | NEEDS A DECISION (founder call 3, option C) |
| Per-sport MTL factors | Other sports in MTL | none | NEEDS A DECISION (section 9) |

The figures in the examples (a 110 TSS ride, cuts of 12 and 41 TSS) are worked from the rows above. They are illustrations, not constants.

---

## 8. Founder calls

**1. When another sport adds load, how much of the week should give way?**
- A. A fixed 15% off up to 2 or 3 easy sessions, as triathlon does. For the 2-hour ride example, about 12 TSS comes off.
- B. Enough to match the extra load: easy erg and easy runs shorten toward 20 minutes until the cut matches it, the plan's own way of shortening easy runs. Same example: about 41 TSS. **Recommended.** A fixed trim offsets about a tenth of a typical match or long ride, so the pop-up would change little.

**2. Which choices should the pop-up offer?**
- A. Reduce and Keep.
- B. Reduce, Keep and Push to next week. **Recommended.** A weekend match often lands when only the protected long run is left in the week, so Reduce has nothing to shorten. Push counts the load in next week's check instead, and it is already built for triathlon.
- C. B plus Replace: drop one whole easy session the sport stood in for. This needs a new "replaced by activity" marker, because the card would otherwise read Skipped, and a change to how planned load is priced. Better as a follow-up.

**3. After a hard sport, should Mosaic offer to ease the next day's hard HYROX session?**
- A. No. Other sports only shorten easy sessions.
- B. Yes, for the quality run only. When the sport was 50 TSS or more, offer to make the next day's tempo or interval run an easy run of the same length. Station sessions stay as planned. **Recommended**, as the second step after v1. It mirrors running and triathlon, needs no new number, and is the main change a coach makes after a match.
- C. B plus the 48-hour rule for station work. Football, rugby, basketball and any sport you name would also ease next-day lunge, burpee and wall-ball work. This needs your list of the sports that count.

**4. When should the pop-up appear?**
- A. As soon as unanswered load from other sports reaches 15% of the planned HYROX week, right after the sync or the manual log, with the Home "Reduce session load" button as a backstop. **Recommended.** It is triathlon's rule, and it asks once per batch of new load.
- B. Only from 25% (triathlon's "extreme" level). Fewer pop-ups, but a single 90-minute session in a big week would often pass without one.
- C. Never pop up; Home button only. The quietest option, but most athletes would never find it.

---

## 9. Out of scope / later

- **Other sports in MTL.** Needs per-sport factors that do not exist. For scale, the existing formula puts a 90-minute match at RPE 7 at 630 MTL if treated as interval running (48% of the intermediate cap of 1300), or 378 as easy running (29%) (h2b `mtl.ts:37-63`, `hyrox-constants.ts:187-194`, `:269-273`). Whether off-plan runs and rows should enter tracked MTL is a related decision: it would move the MTL readiness floor and let chronic MTL exceed the plan.
- **48-hour eccentric rule for other sports** (founder call 3, option C). Needs the list. Candidates from existing data: soccer, rugby and basketball (intermittent, `sports.ts:94-96`); hiking, skiing and stair climbing (the vertical, eccentric leg-load tier). Padel, tennis and snowboarding are undecided.
- **Replace** (if not chosen now). Use a distinct marker, not status `'skipped'`, which reads Skipped (`workout-status.ts:57`) and counts as skipped in adherence. Never set `estimatedDurationMin` to 0: duration then falls back to the description's minutes (`src/ui/triathlon/week-resolve.triathlon.ts:78-90`). `'replaced'` belongs to the AI coach swap and stays priced (h2b `planned-day-tss.ts:104-109`). Upside: a dropped session's MTL set to 0 would also stop the MTL-gap re-anchor reading a football week with a skipped session as detraining.
- **Station rounds, the technique session and strength giving way to other sports.** Left out on physiology (4.2). Revisit only if dogfooding shows easy-only cuts give too little relief.
- **Sport-specificity discount** (running's `runSpec`, for example soccer 0.40 at `sports.ts:94`). Not used: `runSpec` measures how well a sport replaces running, while the first HYROX cut is often an erg, and the founder's brief says other sports count as training. HYROX mirrors triathlon: full TSS, capped by the slope-1 curve.
- **Net of skipped sessions.** All three designs measure against the full planned week. An athlete who skipped HYROX sessions and played football can still be offered cuts.
- **Keeping accepted cuts through a regeneration.** A version-bump or injury regeneration restores the sessions while the load stays answered. Triathlon has the same exposure. For v2, record accepted changes on the week (Design 2's `wk.hyroxCrossAdjustments`) and re-apply them by session id and type.
- **Recurring sports planned in.** A weekly match placed as a fixed scheduler occupant. Generator change, so it needs a `HYROX_GENERATOR_VERSION` bump.
- **A Sunday sport against Monday's quality run** (next week's plan).
- **Legacy `window.logActivity` leak.** In HYROX it falls into the running generator (`src/ui/events.ts:1914`, `:1969`; exposed at `:2943` and `src/ui/renderer.ts:1587`). Separate fix.
- **Excess items nothing reads.** `populateUnspentLoadItems` still runs for HYROX (`activity-review.ts:2107`).
- **Triathlon gaps found on the way (mirror rule).** Triathlon also never pops up on a safe-ratio automatic sync (same gate) or on a manual log. Fix it the same way, as its own task.
- **Adjust overlay MTL bug** (6.4).
