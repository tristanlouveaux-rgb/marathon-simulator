# Load Fix Designs

Diagnosis, design and adversarial review for each fix Tristan asked for. All written against `main` (c3bb015). See the chat note: `main` is not the latest code, so re-validate each design on the source-of-truth branch before implementing.

# 1. Cut sizing: how it works today and its history
## Cut sizing audit: how big each run cut is and why

## Short answer

- **Is the design proportional?** Partly. The live code works out a load budget from the session, then cuts `km = budget ÷ planned load per km`. That step is proportional (`suggester.ts:577-579`). A fuller proportional algorithm is written up in `docs/specs/Load-Reduction-Methodology.md` §6, but it was never built.
- **What decides the cut size today:** mostly the fixed caps, not the work done.
  - Caps per run: easy −40% on Reduce and −50% on Replace; long −25% and −30%.
  - The number of runs touched is 1, 2 or 3, set by severity.
  - There is a 4 km floor on easy runs.
  - Quality sessions drop one step, whatever the load.
- **Both suspects are to blame, and each one breaks it on its own:**
  1. **Raw-iTRIMP unit bug.** With HR, the budget is about 75 times the planned-run scale. Every HR session, even a 5-minute spin, is rated "extreme", so the caps and the 3-run limit decide everything.
  2. **Caps.** Even without HR, the budget passes 40% of an 8 km easy run after about 20 minutes of moderate cycling. From 20 to 240 minutes the cut is the same 3.2 km.
- **Fixing only the unit bug** would make HR sessions behave like the no-HR rows below: still flat at −40% from about 20 minutes.
- **Two smaller scale errors make it worse:**
  - The "saturation" curve multiplies small credits by up to 1.875.
  - `EASY_LOAD_PER_KM = 12`, but planned easy runs are about 7.4 load per km.
- **One path really is proportional:** the Tier 1 silent auto-reduce (`activity-review.ts:1779-1792`), which cuts `excess ÷ 5.52` km. It only applies to 15 TSS or less.

---

## 1. What decides the size today

### How the size is worked out (`buildCrossTrainingPopup`, `suggester.ts:890-1070`)

| Step | Code | What it does to size |
|---|---|---|
| Load tier | `universalLoad.ts:274` checks iTRIMP first | Any session with HR goes to Tier A+. |
| Tier A+ load | `universalLoad.ts:106` `baseLoad = iTrimp * sportMult` | Raw iTRIMP, about 150 per TSS, is used directly. Planned runs from `workouts/load.ts` are about 1.2 load per minute, or 7.3–7.4 per km at 6:00/km. |
| Tier C load (no HR) | `universalLoad.ts:200-212` | Duration × `LOAD_PER_MIN_BY_RPE` × sport mult × active fraction × 0.80. Same scale as planned runs. |
| Fatigue cost (FCL) | `universalLoad.ts:330` | baseLoad × recoveryMult. Drives severity. |
| Run replacement credit (RRC) | `universalLoad.ts:336-344` | baseLoad × runSpec × goalFactor, then the curve `1500·(1−e^(−x/800))`. Its slope at zero is 1.875, so for normal sessions it amplifies instead of capping. |
| Equivalent km | `universalLoad.ts:367-371` | `min(25, RRC/12)`. |
| Severity | `suggester.ts:287-301` | FCL ÷ weekly planned load: 0.25 or more is heavy, 0.55 or more is extreme. Without HR, 90 min at RPE 6 or more is heavy, and 120 min at RPE 7 or more is extreme. |
| Number of runs touched | `suggester.ts:186-188, 490-492` | 1, 2 or 3 by severity. |
| Recovery top-up | `suggester.ts:1024-1025` | RRC × (mult − 1), capped at `20*15` load. |
| Overshoot cap | `suggester.ts:1031-1046` | budget × `maxReductionTSS / (eqKm × pace × 0.92)`. If that fraction is 0.35 or less, only 1 run is touched; if 0.65 or less and severity is extreme, 2 runs. |
| Easy cut (Reduce) | `suggester.ts:577-608` | `min(budget/loadPerKm, 0.40·km, floor slack)`, then a 4 km floor. Cuts under 0.5 km are skipped. |
| Long cut (Reduce, heavy or extreme only) | `suggester.ts:633-655` | `min(budget/loadPerKm, 0.25·km)`. The floor is 10 km, or 85% of the run when the weekly floor is active. Cuts under 1 km are skipped. |
| Quality sessions | `suggester.ts:539-570` | One step down, all or nothing. The first one may exceed the budget (ISSUE-137, `:555`). |
| Replace path | `suggester.ts:776, 804, 836-856` | Easy 50% and long 30% caps. A run is deleted whenever the remaining budget ≥ its load. |
| Which run is cut | `suggester.ts:415-448, 513-518` | Ranked by similarity. Speed runners only get easy runs sorted first. |

### Callers

| Caller | Call | Inputs that matter |
|---|---|---|
| `activity-review.ts:1222` applyReview (overflow) | `(ctx, weekRuns, act)` | iTRIMP is summed from pending items (`:1938-1940`). No cap. ctx has no `runnerType`. |
| `activity-review.ts:1776-1812` autoProcess Tier 1 | not the suggester | Proportional `excess/5.52` km, only for ≤ 15 TSS. |
| `activity-review.ts:1845` autoProcess modal | `(ctx, weekRuns, act)` | Only fires when ACWR is caution or high. No cap. |
| `excess-load-card.ts:370` | `(…, recoveryMultiplier, excess)` | Real iTRIMP, or a synthetic `iTrimp = excess*150` with `dur = excess*2` (`:330-332`). |
| `excess-load-card.ts:460` carry-over | `(…, recoveryMultiplier)` | No overshoot cap. |
| `main-view.ts:2312` triggerACWRReduction | `(…, 1.0, overshootTSS, maxAdjustments)` | `maxAdjustments = 1` when the ratio is 5% or less above the ceiling (`:2311`). The synthetic path has no overshoot cap (`:2220-2226`). |
| `events.ts:1756, :1882` manual log | `(ctx, runs, act)` | Always Tier C, since `createActivity` gets no iTRIMP (`:1633`). |
| `gps/recording-handler.ts:174` | `('extra_run', …)` | Tier C with runSpec 1.0. |

---

## 2. Probe results

Probes were run with vitest. All probe files are deleted and git status is clean. HR rides assume iTRIMP = TSS × 150, the code's own 15000 normaliser.

"Ref km" is an illustration only: session TSS × cycling runSpec 0.55 ÷ 5.52 TSS/km (the Tier 1 conversion). It is not a recommendation.

### A. Generated week: build week 5 of 16, marathon, 5 runs, easy pace 6:00/km

The week has two 8 km easy runs (load 60 each, 7.4 per km), a 13 km fast-finish long run typed `progressive`, a 5 km marathon-pace run and a float session parsed as 2 km. Weekly run load is 495. Cycling at 60 TSS per hour.

| Ride | Ref km | No HR: severity | No HR: Reduce | No HR: Replace | HR: severity and Reduce | HR: Replace |
|---|---|---|---|---|---|---|
| 15 min | 1.5 | light | −2.4 (8→5.6) | −2.4 | **extreme**: −6.4 (both easy runs 8→4.8) plus fast finish removed | **−16 km** (both easy runs deleted) |
| 20 min | 2.0 | light | −3.2 (cap) | −3.2 | same as 15 min | same |
| 30 min | 3.0 | light | −3.2 | −4.0 | same | same |
| 60 min | 6.0 | light | −3.2 | −8 (run deleted) | same | same |
| 120 min | 12 | heavy | −3.2 plus one downgrade | −8 plus downgrade | same | same |
| 240 min | 24 | heavy | −3.2 plus one downgrade | −8 plus downgrade | same | same |

With HR, the 60-minute ride has FCL 6,413 against a weekly load of 495, and RRC is 1,487 with the equivalent pinned at 25 km.

### C. Hand-built week: easy runs of 6, 12 and 10 km, a 10 km threshold, a 22 km long run (weekly load 576)

- **Cycling without HR, RPE 6:**
  - 10, 20 and 30 min each cut 2.0 km (6→4, the 4 km floor).
  - 45 min cuts 4.0 km (10→6) and 60 min cuts 4.8 km (12→7.2).
  - 90 min cuts 10.3 km (long run 22→16.5 plus 12→7.2).
  - 120 min cuts only 5.5 km (threshold downgrade plus long run −25%).
  - 300 min cuts 10.8 km (three easy runs at the cap).
  - The cut goes down from 90 to 120 minutes. The only scaling left is that a bigger session is ranked closer to a bigger run.
- **Swimming** (runSpec 0.20) is the only sport that scales for the first hour: 0.7, 1.3, 2.0, 2.9 and 3.9 km for 10 to 60 minutes.
- **Cycling with HR:** 5, 10, 30, 120 and 300 minutes all give exactly −10.8 km on Reduce and −23 km on Replace.
- **Severity with HR:** about 2 TSS of iTRIMP already counts as heavy, and about 4 TSS as extreme.

### B. Excess-load and ACWR paths (the overshoot cap)

Same 60-minute ride, varying week overshoot:

| Overshoot TSS | No HR, Reduce | HR, Reduce |
|---|---|---|
| 2 | −0.6 | −2.9 |
| 5 | −1.4 | −3.2 (cap) |
| 10 | −2.9 | −3.2 |
| 20 | −3.2 (cap); Replace −4.0 | −3.2 |
| 30 | −3.2; **Replace deletes the 8 km run** | −3.2 |
| 60 | −3.2 | −6.4 (2 runs) |
| 90 or more | −3.2 | −6.4 plus downgrade; Replace −17 km |

- **Conversion per TSS of overshoot:**
  - Without HR: 12/(6×0.92) = 2.17 load, or 0.29 km per TSS. That is about 1.6 times the Tier 1 rate of 0.18 km.
  - With HR: the equivalent km is clamped at 25, so the full-credit TSS is pinned at 138 while the budget is about 1,487. That gives about 1.46 km per TSS, roughly 8 times too much.
- **The cut ignores the sport in this path.** At an 8 TSS overshoot, swimming, cycling, extra_run and soccer all cut 2.3–2.4 km: runSpec cancels out of `RRC × excess / (RRC/12 × 5.52)`. LOAD_BUDGET_SPEC §5 asks for `excess × weightedRunSpec × recoveryMultiplier`, but `computeWeightedRunSpec` (`excess-load-card.ts:219`) is never called.
- **Synthetic excess (no items):** a 5 TSS overshoot cuts 2.1 km, and 10 TSS or more hits the cap.
- **ACWR path with `maxAdjustments = 1`:** overshoots of 5, 20 and 60 TSS all give the same −3.2 km.
- **Recovery multiplier:** 1.5 and 1.0 give identical output, because the cap binds.
- **GPS extra run (no HR):** a 20-minute RPE 4 run gets a budget worth 6.6 km, capped at 3.2 km. Its RRC (49) is higher than its own load (26).

---

## 3. History: was it built proportional, and what broke it?

Git history only starts on 2026-03-05 (root commit a2e3941). That commit already contains the 0.40, 0.25, 0.5 and 0.3 caps and the methodology spec. `git log -S "runKm * 0.40"` returns only a2e3941. No CHANGELOG, SCIENCE_LOG or spec entry records where the caps came from or why. `universalLoad.ts` has not changed since the root commit.

| Date | Evidence | What happened |
|---|---|---|
| Before git | `docs/research/cross-training-replacement-code.md:530-536` | Python reference design, proportional: `trim = clamp(0.15 + 0.25·min(2, credit/run_load), 0.15, 0.60)`, long runs ×0.45 clamped to 0.10–0.35. "ratio=1 → ~40% trim": 40% was the midpoint, not a ceiling. |
| 2026-02-11 | CHANGELOG:2974 | TypeScript interleaved budget algorithm, "naturally scales with budget". This is where 40% became a hard ceiling (inference: the caps are in the root commit, and this is the last recorded change to the sizing logic). |
| 2026-02-23 | CHANGELOG:2906 | "Runner-Type Proportional Load Reduction" was only a Speed-runner sort order (`suggester.ts:513-518`). The methodology spec is that day's design doc: its §3, §8, §9 and §10 shipped the same day (CHANGELOG:2888-2933). Its §5 weight matrix and §6 algorithm never shipped. None of the §6 pieces exist in `src`: volume/intensity weights, pro-rata share, 30-minute floor, fractional step split, 60% long-run floor. Its file table (line 350) still says `suggester.ts` implements it. |
| 2026-02-24 | CHANGELOG:2422-2433 | iTRIMP was plumbed into `buildCrossTrainingPopup`, which feeds `computeTierAPlus` raw. **From then on, the HR path lost proportionality.** |
| 2026-03-12 | ISSUE_CRUSHER_BATCH9:57-64 asked for a cut "proportional to the target TSS… Do not use a hard-coded fraction" | The ISSUE-86 fix (OPEN_ISSUES:983) only changed a synthetic-duration floor from 20 to 5 min. The caps stayed, and the issue was marked fixed. |
| 2026-04-10 | CHANGELOG:596-599 describes `budgetCapFraction = overshootTSS / activityTSS` | That name exists nowhere in `src`. What shipped (bd8d6f8) is `maxReductionTSS / (eqKm × pace × 0.92)`, which uses the 25 km-clamped equivalent. |
| 2026-04-15 | 7f8f030 (ISSUE-137) | The first adjustment may now exceed the budget. |

Other copies of the 40% figure are dead code:
- `planSuggester.ts:387`: `clamp(remaining/runLoad, 0.15, 0.40)`. Its export is never called.
- `LOAD_BUDGET_CONFIG.maxAdjustmentPct 0.40` (`sports.ts:181`) is used only by `load-matching.ts` and `matcher.ts`, which nothing calls (`renderer.ts:14`).

No test checks that the cut grows with session size, and none sends iTRIMP through `computeUniversalLoad` or the suggester.

---

## 4. Constants involved and where each comes from

| Constant | Location | Source |
|---|---|---|
| Easy cut cap on Reduce, 0.40 | `suggester.ts:579` | **Not documented anywhere.** In the Python design, 40% was the trim at ratio 1, not a cap. |
| Easy cut cap on Replace, 0.5 | `:776` | **Not documented anywhere.** |
| Long cut cap on Reduce, 0.25 | `:639` | **Not documented anywhere.** The spec says the long-run floor is 60% (Methodology:250). |
| Long cut cap on Replace, 0.3 | `:804` | **Not documented anywhere.** |
| Long-run floor 0.85 when the weekly floor is active | `:643, :806` | CHANGELOG 2026-04-07 only. No rationale. |
| `MIN_EASY_KM` 4, `MIN_LONG_KM` 10 | `:169-170` | Python design and `universal-load-constants.ts:41,44`. The spec says a 30-minute floor instead. |
| `LONG_MIN_FRAC` 0.65 | `universal-load-constants.ts:47` | Used only by the dead `planSuggester.ts`. |
| Minimum cut 0.5 km (easy) and 1.0 km (long); `minLoadThreshold` 5 | `:605, 611, 649, 495` | **Not documented anywhere.** |
| Runs touched 1, 2, 3 | `:186-188` | `MAX_MODS_*` constants and the Python design (3). The spec's first principle rejects severity tiers (Methodology:12). |
| Severity thresholds 0.25 and 0.55 | `:291, 297` | Code comment "spec says", and `EXTREME_WEEK_PCT`. No literature. |
| No-HR severity triggers: 90 min at RPE 6, 120 min at RPE 7 | `:292, 298` | `EXTREME_RPE_*` constants. The 90/6 rule has no source. |
| Runs kept: 0.55 fraction, minimum 2 | `:182-183` | Python design used 0.5 and a minimum of 1. |
| Quality downgrade RPEs 8/7/6 → 4/6/7 | `:541-544` | **Not documented anywhere.** |
| Anaerobic weight 1.50 | `:162` | Python design. Conflicts with `ANAEROBIC_WEIGHT 1.15` (`sports.ts:160`). |
| Recovery top-up guardrail `20*15` | `:1025` | 20 TSS is in LOAD_BUDGET_SPEC §6. "15 load units per TSS" has **no source** and is wrong on every scale. |
| Easy pace fallback 360 s/km; 0.92 TSS/min | `:1032-1033` | 0.92 = `TL_PER_MIN[4]` (in code). |
| Severity dampening at 0.35 and 0.65 | `:1040-1043` | **Not documented anywhere.** |
| `maxAdjustments = 1` at 5% or less above the ceiling | `main-view.ts:2311` | Matches the modal copy. No rationale. |
| iTRIMP × sport mult (no normaliser) | `universalLoad.ts:106` | The formula is in SCIENCE_LOG:692, but the unit is wrong. |
| 85/15 aerobic split (Tier A+) | `universalLoad.ts:110` | SCIENCE_LOG lists it as a known limitation. |
| `TAU` 800, `CREDIT_MAX` 1500 | `universal-load-constants.ts:83,86` | Python design. SCIENCE_LOG:748 assumes raw values of 500–800, but Tier C produces about 10–150. |
| `EASY_LOAD_PER_KM` 12 | `:228` | **Not documented anywhere.** Planned easy runs are about 7.4. |
| `MAX_EQUIVALENT_EASY_KM` 25 | `:231` | A display cap that is also used in the budget conversion. |
| goalFactor 1.05−0.20r and 0.95+0.20r | `:216-219` | SCIENCE_LOG:756. |
| Tier C tables (per-minute rates, 0.80 penalty, active fractions); `SPORTS_DB` mult, runSpec, recoveryMult | constants and `sports.ts` | SCIENCE_LOG:770-830 ("expert estimates"). |
| Unknown sport defaults: mult 1.0, runSpec 0.35 | `universalLoad.ts:78-86` | **Not documented anywhere.** Hit by the synthetic `cross_training` and `running` activities. |
| Tier 1: ≤ 15 TSS; `TL_PER_MIN[4] × 6`; keep ≥ 1 km | `activity-review.ts:1779-1792` | PRINCIPLES:154 and LOAD_BUDGET_SPEC. The 6 min/km is hardcoded, while planned easy runs are RPE 3 at the athlete's own pace. |
| Synthetic `excess*150` iTRIMP and `excess*2` minutes | `excess-load-card.ts:330-332` | 150 is the inverse of 15000 (in code). "×2" is a "rough estimate" with no source. |
| ACWR synthetic: `max(50, ctl)`, 55 TSS/h, 5-minute minimum, `TYPE_RPE` table, 0.85 pace factor | `main-view.ts:2222-2226, 2283-2288` | 55 is about `TL_PER_MIN[4]×60`; the 5-minute minimum comes from ISSUE-86. The rest has **no source**. |

---

## 5. Decisions for you (no numbers proposed, per CLAUDE.md)

1. **Which currency the suggester sizes in.** One option is a conversion factor for iTRIMP → load units; no such constant exists in the code. The other is switching the suggester to TSS, which is the goal stated in LOAD_SYSTEM_SPEC §1.
2. **Which proportional rule is the source of truth.** The docs disagree on which signal to use:
   - Methodology §6: FCL ratio × planned load, shared across runs, with runner-type weights.
   - LOAD_BUDGET_SPEC §5: Signal A, `excess × weightedRunSpec × recovery`.
   - Tier 1: Signal B, `excess ÷ TSS per km`.
3. **What the caps are for.** Should they stay as safety ceilings only? If so, which values, and from what source?
4. **The saturation curve.** Keep it as a cap for very large sessions only? Today it multiplies normal sessions by up to 1.875.
5. **Floors.** Easy: 4 km or 30 minutes? Long run: 60%, 65%, 75% or 85%?
6. **Cut order.** PRINCIPLES:189 says "reduce easy volume first". The code ranks by similarity, and FEATURES says intensity comes first for Balanced and Endurance runners.

Files: `/home/user/marathon-simulator/src/cross-training/suggester.ts`, `/home/user/marathon-simulator/src/cross-training/universalLoad.ts`, `/home/user/marathon-simulator/src/cross-training/universal-load-constants.ts`, `/home/user/marathon-simulator/src/ui/excess-load-card.ts`, `/home/user/marathon-simulator/src/ui/main-view.ts`, `/home/user/marathon-simulator/src/ui/activity-review.ts`, `/home/user/marathon-simulator/docs/specs/Load-Reduction-Methodology.md`, `/home/user/marathon-simulator/docs/specs/LOAD_BUDGET_SPEC.md`, `/home/user/marathon-simulator/docs/research/cross-training-replacement-code.md`
# 2. Cut sizing: recommended design (judge)
## Proportional cut sizing: three designs compared, recommendation and plan

No repo files were changed. I ran three probe files (`src/calculations/zz_probe_cutcmp{,2,3}_q8m3.test.ts`) through the real `generateWeekWorkouts`, `estimateWorkoutDurMin`, `TL_PER_MIN`, `workoutsToPlannedRuns`, `applyAdjustments`, `computeUniversalLoad` and `buildCrossTrainingPopup`, then deleted them. `git status` is clean.

## 1. Verdict

I recommend a **merge**, with the tss-currency design as the base.

- **Currency and pricing (from tss-currency):**
  - Everything is priced in TSS.
  - A session is priced exactly the way the week load bar prices it.
  - Planned runs are priced with the same function as the plan cards and the daily targets.
- **Ledger (from science-first):** each workout change records the TSS it absorbed and which activities it came from. This is what stops the same overflow session being cut twice, which is what Tristan asked for.
- **Weekly ceiling (from science-first):** a cumulative cap on how much running cross-training can displace in a week, sourced from Tanaka (see D12).
- **Protection order (as restore-spec and tss-currency read PRINCIPLES):** easy km first, then long-run km, then one quality step. The quality step is the last rung on every path and may never exceed the remaining budget.
- **Small footprint (from restore-spec):** keep the `SuggestionPopup` shape and the `buildCrossTrainingPopup` entry point, so `suggestion-modal.ts` barely changes.
- **Rejected:** restore-spec's currency (load units converted through k(rpe)). See P2 and P3 below.

## 2. Conflicts settled by probes and code reading

| # | Question | Finding | Evidence |
|---|---|---|---|
| P1 | Easy-run price: 3.90 TSS/km (tss-currency) or 5.52 (science-first)? | Both are right for the RPE they assume. The generator sets easy and long runs to RPE 3 (`intent_to_workout.ts:54-55, :76-77`), which gives 8 km = 48 min × 0.65 = 31.2 TSS. `TL_PER_MIN` is calibrated with easy and long at RPE 4 (`sports.ts:4-9`), which gives 44.2. That is a 1.42× difference in km cut per TSS. Decision D6. | probe |
| P2 | Is restore-spec's "60-min no-HR ride = 39.3 TSS" right? | That figure is Tier C load (68.4) converted back to TSS. The week load bar counts the same ride as 60 × 1.15 = 69 TSS (`computeWeekRawTSS` adhoc path). The two differ by 43%. restore-spec's `excess / signalBTSS` would divide by a different number from the one that produced `excess`. | probe |
| P3 | Is k(rpe) a clean iTRIMP-to-load conversion? | No. Measured k is 1.667, 1.778, 1.846, **1.630**, 1.739, 1.724, 1.966, 2.027, 2.0, 2.0 for RPE 1–10, so it is not monotonic. The planned-run side also keeps `ANAEROBIC_WEIGHT_SUGGESTER` 1.5 (`suggester.ts:162`), and `computeWorkoutWeightedLoad` (`:464-471`) ignores easy pace and falls back to 5.5 min/km (`load.ts:25`). Load units stay mixed even after restore-spec's fix. | probe |
| P4 | Do downgrades lower planned TSS? | Only fast-finish long runs do (`suggester.ts:1313`). Callers store `newRpe: mw.rpe` (`activity-review.ts:1273`). MP → "26min @ 6:00/km (easy)" stays at 37.7 TSS when it should be 16.9. Float → MP stays at 53.4 when it should be 43.5. | probe |
| P5 | Does Replace delete quality sessions? | Yes. For every HR ride from 5 to 150 TSS (week 5), Replace deletes an 8 km easy run **and the Marathon Pace session**. The pool at `suggester.ts:730-736` excludes only long runs. | probe |
| P6 | Is the long run always typed `long`? | No. In fast-finish weeks (5 and 8 of 16), it is `progressive` at RPE 5. Today every HR ride turns "13km: last 3 @ MP" into a plain 13 km easy run. Its average price is 6.90 TSS/km, but the easy part it would be cut from is 4.02 TSS/km. | probe |
| P7 | Does the plan bar drop by what the modal claims (tss-currency)? | Only per-workout planned TSS (`plan-view.ts:191-213`) and the daily targets (`computePlannedDaySignalBTSS`) drop. The weekly bar's target is `computePlannedSignalB` (`fitness-model.ts:848`), which is history-based and unaffected by cuts. The generator does not read it. | code |
| P8 | Can the same session be cut twice today? | Yes, in three ways (see the three rows below). Only a ledger fixes the first two. Applying mods and merging them in place fixes the third. | code |
| P8a | | After an overflow-modal cut (mods tagged `Garmin:`), the excess card still renders. Only `Auto:` mods suppress it (`excess-load-card.ts:127`). With no unspent items left, it builds a synthetic `excess*150` activity (`:330-332`) and cuts again. | code |
| P8b | | After a Tier 1 auto-cut, `unspentLoadItems` stay in state, so the ACWR button sizes a second cut from them (`main-view.ts:2208`). | code |
| P8c | | The review and ACWR flows build candidates from the plan without mods (`activity-review.ts:69-81`, `main-view.ts:2166-2191`) and append new mods. `renderer.ts:298-317` applies them last-wins, so a second cut **overwrites** the first instead of adding to it. | code |
| P9 | What does the ACWR path aim for today? | Two targets in one function. With unspent items, it compares the projected week against `plannedSignalB` (`main-view.ts:2270-2297`). Without items, it uses `(ratio − safeUpper) × max(50, ctl)`, which is roughly acute − safeUpper × chronic (`:2221-2226`). | code |
| P10 | Does the timing check protect quality sessions? | Only threshold, VO2 and long (`timing-check.ts:29`). It uses its own TSS table and a fixed 15000 normaliser (`:85-94`). MP, float and progressive have no fatigue protection. This undermines science-first's plan to protect quality only through the timing check. | code |
| P11 | Is the carry-over path live? | `_triggerCarryoverToNextWeek` (`excess-load-card.ts:428`) has no callers. It is dead. | grep |
| P12 | Do the runSpec values match the research doc? | runSpec will now set cut size directly. `running.md` §7.1 gives cycling 60–75% and rowing 70–85%. SPORTS_DB has 0.55 and 0.35. | docs |
| P13 | Is the weekly km-floor slack computed correctly? | No. `allPlannedKm` sums only unrated runs (`suggester.ts:1060`) but is compared with a whole-week floor, so mid-week slack is understated. | code |

## 3. Comparison

| Criterion | restore-spec | tss-currency | science-first |
|---|---|---|---|
| **Units** | Weak. Load units via k(rpe) (P3). A no-HR session disagrees with the load bar by 43% (P2). | Strong. TSS end to end, with the same formula as `computeWeekRawTSS` and the card pricer. | Good. TSS, but keeps the 0.80 RPE-only discount and goalFactor, so HR and no-HR sessions of equal TSS diverge by about 20%. |
| **Proportionality** | Linear up to the floors. | Linear up to the floors. The optional overshoot clip (its D2) is non-proportional. | Linear up to the floors and the 30% ceiling. |
| **Science** | Signal A. The k ratio has no derivation. | Banister additivity plus Signal A. | Best write-up: separates displacement (Signal A) from fatigue (Signal B), and cites Tanaka and the taper literature. |
| **New unsourced constants** | None, but it keeps the similarity weights and the 1.5 anaerobic weight. | None. | One: the ceiling value, taken from a sourced range. |
| **Blast radius** | About 60–80 lines, the smallest. But it leaves the synthetic paths, the mods-not-applied bug (P8c), the stale RPE (P4) and quality in the Replace pool (P5), so proportional cuts still get overwritten. | Large: a new allocator, all callers, and the 15000 sweep. | Largest: a ledger type, timing-check work, and a plan_engine phase 2. |
| **Testability** | Moderate. | Best: TSS removed per adjustment must equal the price before minus the price after. | Good: ledger idempotency. |
| **Fit with the docs** | Follows the hierarchy but not the currency. LOAD_BUDGET_SPEC §5 sizes in TSS. | Fits PRINCIPLES:54-80 and LOAD_BUDGET_SPEC §5, §6 and §11. | Excludes quality sessions from session and excess cuts, against PRINCIPLES:67-76 and :201 ("volume + intensity"). |
| **Stops double counting** | No. | Partly (P8c only). | Yes. |

## 4. (a) Final algorithm

### Why it is defensible (for the SCIENCE_LOG entry)

- **Additivity.** Banister's impulse-response model is linear in daily load, and TSS is additive. TSS here is athlete-normalised iTRIMP, using Coggan's rule that 1 hour at LTHR = 100.
- **What a session is worth to running.** Its credit is TSS × runSpec (Signal A). Sources: PRINCIPLES:24-33 and :54-64, the SCIENCE_LOG entry "Signal A vs Signal B", and LOAD_BUDGET_SPEC §5 and §11 ("Detect with Signal B, reduce with Signal A", :282).
- **Order.** Cuts follow PRINCIPLES:67-76.
- **Floors.** These are protection rules, not sizing rules.
- **Known weaknesses:**
  - runSpec values are expert estimates, and some disagree with `running.md` (P12).
  - Planned runs are priced by RPE (D6).
  - The model is linear with no diminishing returns. The floors and the ceiling bound it instead.
  - Tanaka's 20–30% refers to volume, and here it is applied to TSS.

### The rule

Remove the session's running-equivalent TSS from the week's remaining runs, at each run's own TSS per km. Cut easy runs first, then the long run, then one quality step. Anything the floors block is shown to the user and never forced onto another session.

```ts
// fitness-model.ts: the one pricing module
iTrimpToTSS(it, norm?) = it * 100 / (norm ?? _athleteNorm)           // export of :289
sessionTSS(x)          = x.iTrimp > 0 ? iTrimpToTSS(x.iTrimp)
                       : x.durationMin * (TL_PER_MIN[round(x.rpe ?? 5)] ?? 1.15)   // same as computeWeekRawTSS
priceWorkoutTSS(w, b)  = replaced or skipped ? 0
                       : estimateWorkoutDurMin(w, b) * TL_PER_MIN[round(pricingRpe(w))]   // D6
// computePlannedDaySignalBTSS and plan-view.ts:191-213 both call priceWorkoutTSS

// cross-training/cut-budget.ts (new, pure functions)
A            = sum over items NOT in ledger.ids of sessionTSS(i) * runSpec(i)   // D2-D5: no sportMult, no goalFactor, no 0.80
topUp(x, m)  = min(x * (m - 1), 20)                                              // LOAD_BUDGET_SPEC §6
ledger(wk)   = { ids: union of mod.xtSourceIds, absorbed: sum of mod.xtTSS }    // D13
ceilLeft     = CEIL * sum of priceWorkoutTSS(original week runs) - ledger.absorbed   // D12
sessionB     = min(A + topUp(A, rec), ceilLeft)
excessB      = min(max(0, E*wRS + topUp(E*wRS, rec) - ledger.absorbed), ceilLeft)
               // E = computeWeekRawTSS + carry - computePlannedSignalB (unchanged)
               // wRS = weighted runSpec over ALL week items, incl. no-HR items and runs (1.0)
acwrB        = max(0, projectWeekSignalB(planWithMods) - target)   // 1:1, target per D7; no top-up, no ceiling
tier1        = excessB when E <= 15, applied silently through allocate('reduce')

// suggester.ts: allocateCut replaces buildReduceAdjustments and buildReplaceAdjustments
allocate(B, runs /* unrated, today or later (D16), plan WITH mods */, mode):
  rem = B;  keep = max(2, ceil(0.55 * n))
  slack = weeklyFloorActive ? doneKm + sum(runs.km) - floorKm : Infinity     // fixes P13
  for r in easy runs, soonest after the session first (D15):
    if mode == 'replace' && rem >= r.tss && runsLeft > keep && r.km <= slack && sport allows:
      replace r; continue
    newKm = round1(r.km - min(rem / r.tssPerKm, r.km - EASY_FLOOR, slack))  // D10
    if (r.km - newKm) >= 0.5: reduce r (type unchanged); rem -= cutKm * r.tssPerKm
  for r in long runs (t == 'long' OR the Long Run slot, incl. fast-finish; D29):
    floor = max(10, F(acwrStatus) * r.originalKm)                             // D11
    rate  = TSS/km of a plain long run of the same length
    cut at least 1.0 km; keep the type and the "last N @ MP" tail
  for q in quality runs, by D9 order, skipping any already stepped or carrying a Timing: mod:
    q2 = one rung down, with the generator's RPE for the new type
    delta = price(q) - price(q2)
    if 0 < delta <= rem: downgrade q; rem -= delta                            // D8: never overshoot
  return { adjustments (each with tss), removedTSS: B - rem, unabsorbedTSS: max(0, rem) }

// display only
severity         = sessionTSS * recMult / sum of price(weekRuns); labels at 0.25 / 0.55
equivalentEasyKm = B / (TSS per km of the first easy run)    // the 25 km clamp is gone
```

**Properties:**
- The budget is linear in session TSS.
- Removed TSS never goes down as the budget grows. The proof is short. The fill order is fixed. Consider the first run or step that the larger budget takes and the smaller one skips. At that point the smaller budget's remaining TSS is already below what that run or step would remove, so its total can never catch up.
- The same garminId, or the same excess, is never absorbed twice.

### Worked example

Setup:
- Week 5 of 16, marathon build, 5 runs, easy pace 6:00/km.
- Plan: easy 8 km at 31.2 TSS, twice (3.90 TSS/km); fast-finish long 13 km; Marathon Pace 26 min; float session.
- Week total: 243.2 TSS.
- HR cycling on Monday. Easy floor 4 km, long floor 85%, generator-RPE pricing.

| Ride TSS | Credit (TSS) | Today (the same for every ride size) | Proposed |
|---|---|---|---|
| 5 | 2.8 | "extreme": both easy runs 8→4.8 and the fast finish flattened. Replace deletes an easy run **and** the MP session. | easy 8→7.3 |
| 10 | 5.5 | same | 8→6.6 |
| 20 | 11.0 | same | 8→5.2 |
| 30 | 16.5 | same | 8→4 |
| 45 | 24.8 | same | 8→4, 8→5.7 |
| 60 | 33.0 | same | 8→4, 8→4 (1.8 TSS left over) |
| 90 | 49.5 | same | + long 13→11 with the fast finish kept, + float→MP |
| 150 | 82.5 | same | + MP→easy (12.6 TSS left over; with the 30% ceiling the budget is 73.0 and 3.0 is left over) |

**Other results from the probes:**
- **Sport at equal TSS (40 TSS, week 6):**

  | Sport | runSpec | Km cut |
  |---|---|---|
  | swimming | 0.20 | 2.1 |
  | strength or rowing | 0.35 | 3.6 |
  | cycling | 0.55 | 5.6 |
  | extra run | 1.0 | 10.1 |

- **Excess path:** 5, 15 and 30 TSS × 0.55 cut 0.7, 2.1 and 4.0 km.
- **ACWR path, 1:1:** 10, 30 and 60 TSS cut 2.6 km, 7.7 km, and 12 km plus one step.
- **Pricing easy and long at RPE 4 (D6):** the 60-TSS ride cuts 6.0 km instead of 8.0.
- **Long-run floor at 60% (D11):** the 90-TSS ride cuts the long run 14→10 km instead of 14→11.9 km.

## 5. (b) Implementation plan (in order, keeping `tsc` and `vitest` green at each step)

0. **Prerequisites from the same batch:**
   - The false-high ACWR fix (B1). It feeds `acwrStatus`, the floor switch and D7.
   - The max-HR fix, which feeds the normaliser.
   - Sizing never reads `computeWeekTSS`, so the Signal A double-count fix is independent of this work.

1. **`fitness-model.ts`:**
   - Export `iTrimpToTSS` (from `:289`).
   - Add `sessionTSS` and `priceWorkoutTSS`, and make `computePlannedDaySignalBTSS` (`:630-639`) call `priceWorkoutTSS`.
   - Add `projectWeekSignalB`, moving the logic from `main-view.ts:2270-2297` and replacing `TYPE_RPE` and the 0.85 factor with the pricer.

2. **New `src/cross-training/cut-budget.ts`:**
   - `runEquivTSS`, `recoveryTopUp`, `readLedger`, `ceilingLeft`, `sessionBudget`, `excessBudget` and `acwrBudget`.
   - `weightedRunSpec`, which replaces `excess-load-card.ts:219-253`. It includes no-HR items and matched runs, and uses the normaliser.

3. **New shared week-plan module (must not import `plan-view.ts`):**
   - `getCurrentWeekPlan(s, offset)`: the generator call from `plan-view.ts:1565` with mods applied the way `renderer.ts:298-317` applies them (including `newRpe`), skipping `Timing:` mods.
   - `upsertCrossTrainingMods(wk, modified, adjustments, {reason, sourceIds})`: merge by name and day, keep the first `originalDistance`, add up `xtTSS` and union `xtSourceIds`.
   - Replace `getWeekWorkoutsForReview` (`activity-review.ts:69-81`), `getWeekWorkoutsForACWR` (`main-view.ts:2166-2191`) and the excess card's `getWeekWorkouts` (`:41-66`) with it.

4. **`types/state.ts:108-119` `WorkoutMod`:** add `xtTSS?` and `xtSourceIds?`.

5. **`suggester.ts`:**
   - `PlannedRun` (`:42-51`): add `plannedTSS`, `tssPerKm`, `isLongRun`, `originalKm`, `isPastDay` and a reference to the workout.
   - `workoutsToPlannedRuns` (`:1201-1238`): price every run. Drop the `aerobic/35` km estimate.
   - Add `allocateCut`.
   - Delete:
     - `buildReduceAdjustments` and `buildReplaceAdjustments`, with the caps at `:579`, `:639`, `:776` and `:804` and the recovery fallback at `:584-602`.
     - The `MAX_ADJUSTMENTS_*` constants.
     - Similarity ranking as a sizing input (`:173-179`). Classification stays for display.
     - The `TAU` saturation constants.
     - `computeWorkoutWeightedLoad`.
     - Lines `:1021-1047` and `:1068`.
   - `buildCrossTrainingPopup(ctx, runs, activity, {budgetTSS, sourceIds, recoveryMultiplier})`: return the same shape plus `budgetTSS`, `removedTSS` and `unabsorbedTSS`. `loadReduction` now means TSS.
   - `applyAdjustments`:
     - A downgrade sets `rpe` and `r` from the generator's RPE map. Export it from `intent_to_workout.ts` rather than copying the numbers.
     - A long-run cut keeps its type (today it becomes `'easy'` at `:666` and `:819`) and keeps the fast-finish tail.
     - Descriptions stay `"Xkm (was Ykm)"` with no space, so the parser can read them.

6. **`universalLoad.ts`:**
   - `computeTierAPlus` (`:99-119`) uses `iTrimpToTSS` and drops `sportMult`.
   - Add `sessionTSS` and `runEquivTSS` to the result type (`universal-load-types.ts:70-86`).
   - `classifyByITrimp` (`:495`) uses the normaliser.

7. **Callers:**
   - **`activity-review.ts` review and modal paths (`:1222`, `:1845`):**
     - Size the budget per item. `buildCombinedActivity` stays for the headline only.
     - Build candidates from the plan with mods applied, and merge mods with source IDs.
     - Lines `:1294` and `:1902` use `iTrimpToTSS`.
   - **`activity-review.ts` Tier 1 (`:1776-1812`):**
     - Use `excessB` against `plannedSignalB`, then `allocateCut('reduce')`.
     - Record the mod with `xtTSS` and source IDs.
     - Delete the hardcoded 5.52 TSS/km (`:1787`) and the 1 km minimum (`:1789`).
   - **`excess-load-card.ts`:**
     - One path, `excessB`, whether or not there are unspent items.
     - Delete the synthetic activity (`:326-333`) and the dead carry-over function (`:428-493`).
   - **`main-view.ts:2193-2330`:**
     - Use `acwrB`.
     - Delete the synthetic "running" activity, `TYPE_RPE`, `max(50, ctl)`, the 55 TSS/h conversion, the 5-minute minimum and `maxAdjustments` (D27).
   - **`recording-handler.ts:174` and `events.ts:1756, :1882`:** update to the new signature. `events.ts` is reachable only through the legacy `window.logActivity` (`renderer.ts:1557`).
   - **`suggestion-modal.ts`:**
     - The equivalent-km line (`:143-146`).
     - A new unabsorbed-TSS line, following the UI copy rules.
     - `cardioCoveredPct` (`:267-270`) uses an unsourced 4.5 load/km. Recompute it in TSS or remove it.

8. **15000 sweep on sizing paths:**
   - Replace the hardcoded 15000 at `timing-check.ts:89, :94`, `excess-load-card.ts:222, :367`, `main-view.ts:2325` and `activity-review.ts:1294, :1902`.
   - Grep again afterwards. List the display-only sites explicitly, per the CLAUDE.md cross-cutting rule.

9. **Docs:**
   - SCIENCE_LOG:
     - New entry: "Proportional Cut Sizing (TSS)".
     - Edit Tier A+ (`:692`), Saturation (`:735`, retired from sizing), Goal factor (`:756`) and iTRIMP Normalisation (`:1525`).
     - Add the `estimateWorkoutDurMin` pace factors, which are in code only.
   - FEATURES: remove "intensity first for Balanced/Endurance".
   - CHANGELOG and ARCHITECTURE (`PlannedRun`, `WorkoutMod`, the new modules).
   - OPEN_ISSUES: note the effect on ISSUE-86, 137 and 138. Do not mark anything fixed.

## 6. (c) Decisions for Tristan

### Blocking: answer these before coding

1. **D1. Currency.**
   - (a) TSS end to end. **Recommended.**
   - (b) Load units converted through k(rpe) (P2, P3).
2. **D2. HR sessions: drop the sport multiplier?**
   - (a) Drop it. **Recommended.** Signal B and PRINCIPLES' Signal A don't apply it. SCIENCE_LOG:692 must change.
   - (b) Keep it.
3. **D3. How to price a no-HR session.**
   - (a) Duration × `TL_PER_MIN[rpe]`, the same as the week load bar. **Recommended.** Foster's session-RPE already covers rest periods, so an active-fraction discount counts them twice.
   - (b) Tier C (mult × active fraction), and apply the same in Signal B.
4. **D4. Keep the 0.80 RPE-only discount on credit?**
   - (a) Drop it, so equal-TSS HR and no-HR sessions give identical cuts. **Recommended.**
   - (b) Keep it, so the app cuts 20% less when it is unsure.
5. **D5. Keep goalFactor?**
   - (a) Drop it from sizing. **Recommended.** With HR data the aerobic split is fixed at 85/15, so goalFactor is a constant 1.02 (marathon) or 0.98 (5k).
   - (b) Keep it.
6. **D6. What RPE prices planned easy and long runs?**
   - (a) The generator's RPE 3 (0.65 TSS/min), as the cards show today.
   - (b) RPE 4 (0.92), the `TL_PER_MIN` calibration point, which Tier 1, the ACWR path and the timing check already use. **Recommended**, applied in the shared pricer so cards and cuts agree.
   - (c) The athlete's measured easy-run TSS per minute, falling back to (b).

   Illustration: an easy run at 60–65% of heart-rate reserve, with LTHR at about 85%, works out to 0.73–0.87 TSS/min with this normaliser. Option (a) gives 1.42× larger km cuts than (b).
7. **D7. ACWR path.**
   - (a) Remove Signal B 1:1 until the projected week is back to `plannedSignalB`, today's with-items target. **Recommended for now**, because it does not depend on B1.
   - (b) Remove 1:1 until the projected week is under `safeUpper × chronic`. This is what the ACWR button promises. Revisit it after B1 ships.
   - (c) Discount by runSpec, as LOAD_BUDGET_SPEC §5 says for "any tier".
8. **D8. Quality sessions on the session and excess paths.**
   - (a) The last rung on every path, taken only when the step's TSS fits in what is left. **Recommended**, per PRINCIPLES:67-76 and :201. This supersedes the ISSUE-137 fix: Reduce shows "unabsorbed" instead of an oversized downgrade.
   - (b) ACWR path only, as science-first proposes (weak, see P10).
   - (c) Keep the ISSUE-137 rule that the first step may exceed the budget.
9. **D9. Which quality session steps down first.**
   - (a) PRINCIPLES order: threshold-type sessions (threshold, race pace, float, mixed, MP) first, VO2, intervals and hills last. **Recommended.** MP→easy stays allowed as the existing ladder's last rung.
   - (b) `workoutPriorityForRace` (`suggester.ts:324-333`), which steps VO2 before threshold for marathoners.
10. **D10. Easy-run floor.**
    - (a) 4 km (`MIN_EASY_KM`, in code).
    - (b) 30 minutes at the athlete's easy pace, as in Methodology:186 and :253. **Recommended**, because it scales with the runner.
11. **D11. Long-run floor, measured from the original distance.**
    - (a) Today: 10 km or 85%, whichever is longer, while ACWR is safe or low; a flat 10 km otherwise.
    - (b) 10 km or 85% while safe or low; 10 km or 60% while caution or high. **Recommended.** The 60% is from Methodology:250.
    - (c) A single 65% (`LONG_MIN_FRAC`).
12. **D12. Weekly displacement ceiling.**
    - (a) None, floors only.
    - (b) 30% of the week's planned running TSS, on the session and excess paths, counted across all sessions through the ledger. **Recommended.** Tanaka gives 20–30% (`running.md` §7.2), and 0.30 already sits unused at `sports.ts:180`.
    - (c) 20% or 25%.
13. **D13. Ledger.**
    - (a) Add `xtTSS` and `xtSourceIds` to `WorkoutMod`, and net budgets against what has already been absorbed. **Recommended**, and required so overflow sessions are not counted twice.
    - (b) No ledger.
14. **D14. Clip session cuts at the week's projected overshoot (tss-currency D2)?**
    - (a) No. **Recommended.** Generator run TSS and `computePlannedSignalB` are independent models (the generator never reads the target), so the clip would swing between cutting nothing and cutting everything. Habitual sessions belong in recurring slots.
    - (b) Yes.
15. **D15. Which easy run is cut first.**
    - (a) The soonest after the session. **Recommended.** SCIENCE_LOG:844 gives a 48-hour leg-load half-life, and this retires 7 unsourced similarity weights.
    - (b) The current similarity score.
    - (c) Spread pro-rata, as in Methodology §6.
16. **D16. Unrated runs on days already past.**
    - (a) Leave them out of the pool. **Recommended.** Cutting a run that did not happen absorbs nothing.
    - (b) Keep them in, as today (`excess-load-card.ts:79`).
17. **D17. What Replace can remove.**
    - (a) Easy runs only. **Recommended** (see P5).
    - (b) As today.

### Not blocking: the recommended option is the default unless you say otherwise

18. **Minimum cut and rounding.**
    - (a) Keep 0.1 km rounding and minimum cuts of 0.5 km (easy) and 1.0 km (long) (`suggester.ts:605, :613, :649`). These are undocumented. **Recommended.**
    - (b) Round to 0.5 km, as in Methodology:187.
19. **Where the recovery top-up applies.**
    - (a) Session and excess paths only. **Recommended.**
    - (b) All paths.
20. **Severity labels (0.25 / 0.55, no literature).**
    - (a) Keep them as display-only, and drop the no-HR triggers (90 min at RPE 6, 120 min at RPE 7). **Recommended.**
    - (b) Remove the labels.
21. **ISSUE-138 easy-to-recovery fallback.** It removes 0 TSS under TSS pricing: both are RPE 3 and `estimateWorkoutDurMin` has no recovery pace.
    - (a) Drop it from the allocator. **Recommended.**
    - (b) Keep it as a non-budget option.
22. **runSpec for an unknown sport, currently 0.35** (`universalLoad.ts:82`, `fitness-model.ts:359, :390, :869`, `activity-review.ts:1291, :1899`).
    - (a) Use `generic_sport` at 0.40 from SPORTS_DB. **Recommended.**
    - (b) Keep 0.35.
23. **The 0.7 fallback in `computeWeightedRunSpec`** (`excess-load-card.ts:252`).
    - (a) Remove the need for it by weighting over all items, with runs at 1.0. **Recommended.**
    - (b) Keep it.
24. **Tier 1's "keep at least 1 km"** (`activity-review.ts:1789`).
    - (a) Use the D10 easy floor instead. **Recommended.**
    - (b) Keep 1 km.
25. **Tier 1's baseline.**
    - (a) `computePlannedSignalB`, the same as the excess card. **Recommended.**
    - (b) `s.signalBBaseline`, as today.
26. **Default easy pace when none is known.**
    - (a) 5.5 min/km, the pricer's default. **Recommended.**
    - (b) 6.0 min/km (`suggester.ts:1203`).
27. **`maxAdjustments = 1` when ACWR is at most 5% over** (`main-view.ts:2311`).
    - (a) Delete it; a 1:1 budget is already small. **Recommended.**
    - (b) Keep it.
28. **runSpec against `running.md` §7.1** (P12).
    - (a) A separate science review. **Recommended.**
    - (b) Align to the lower bounds of the `running.md` ranges now.
29. **Fast-finish long run.**
    - (a) Treat it as the long run: cut from its easy portion and keep the finish. **Recommended.** This changes `suggester.test.ts:164`.
    - (b) Treat it as quality and never cut it.
30. **Runs preserved: at least 2, or 55% of the week, whichever is more.**
    - (a) Keep it. **Recommended.**
    - (b) Use the Python design's 50% and at least 1.
31. **Excess card hidden after any `Auto:` mod** (`excess-load-card.ts:127`).
    - (a) Replace this with ledger netting, so a later, larger excess still shows. **Recommended.**
    - (b) Keep it.
32. **Pace factors in `estimateWorkoutDurMin`** (0.82, 0.73, 0.78, 0.87, 1.03; `fitness-model.ts:604-609`). They are in code only and now price cuts. Float has no factor here, although `load.ts` uses 0.85.
    - (a) Accept them, document them in SCIENCE_LOG, and add float at 0.85 from `load.ts`. **Recommended.**
    - (b) Review them first.

## 7. (d) Test plan

New files `src/cross-training/proportional-cut.test.ts` and `src/calculations/workout-pricing.test.ts`. The allocator tests are table-driven over generated weeks 5, 6 and 7 of 16, with 3–6 runs a week, for marathon, half and 10k.

**Pricing:**
1. `iTrimpToTSS`: 1 hour at LTHR = 100, and the normaliser can be injected.
2. `sessionTSS` equals what `computeWeekRawTSS` counts for the same adhoc session, with and without HR.
3. Summing `priceWorkoutTSS` over a day equals `computePlannedDaySignalBTSS`. Replaced and skipped runs price at 0. `"Xkm (was Ykm)"` parses as X.

**Unit-bug regression:**

4. A 60-TSS HR ride has severity "light" in a roughly 213-TSS week.
5. An HR session and a no-HR session of equal TSS produce identical adjustments.

**Proportionality:**

6. Removed TSS never decreases across a 5–200 TSS sweep, in both modes.
7. Until a floor binds, removed TSS stays within 0.05 km × the run's rate of the budget, and doubling the session doubles the km.
8. At equal TSS, cuts rank swim < rowing = strength < cycling < extra run.

**Protection:**

9. No quality step while any easy or long run is above its floor.
10. A step is taken only when it fits. Quality is never replaced or shortened.
11. The long run is never replaced, keeps its type and fast-finish tail, and never goes below a floor computed from its original distance.
12. The weekly km floor counts completed km. The preserve-runs rule and `noReplace` hold.

**Accounting:**

13. For every adjustment, `adjustment.tss` equals the price before minus the price after `applyAdjustments`. This covers the downgrade RPE fix (P4).
14. Replace never removes more than the budget, and only removes easy runs.

**Double counting (Tristan's ask):**

15. The same garminId processed twice gets a budget of 0 the second time.
16. The excess card after an overflow-modal cut is netted by what was absorbed.
17. Tier 1 followed by the ACWR button does not double-cut.
18. Two sessions hitting the same easy run add up (original − cut 1 − cut 2); the second does not overwrite the first (P8c).
19. The ceiling accumulates across two sessions.

**Paths:**

20. Excess budget = excess × wRS, with the top-up capped at 20 TSS, and wRS includes no-HR items.
21. ACWR removes 1:1, cuts nothing when the projection is on target, and never builds a synthetic activity.

**Existing tests to update:**
- `km-budget.test.ts`: the budget field changes.
- `boxing-bug.test.ts:230, :242`.
- `universalLoad.test.ts`: Tier A+ and the `MAX_MODS` assertions.
- `suggester.test.ts:164`: fast-finish behaviour, per D29.

**On device** (required before any issue is marked fixed):
- HR rides of 20, 60 and 150 TSS through the review modal.
- The excess card after a modal cut.
- The ACWR button.
- The Tier 1 toast.
- The unabsorbed line and the km/mi toggle on the new copy.

**Main behaviour changes users will see:**
- HR users get much smaller cuts for small sessions.
- Replace stops deleting quality sessions.
- The runSpec values and the D6 pricing choice now show up directly in km.
- 3–4-run weeks will often show an unabsorbed remainder, so the modal copy must state it plainly.
# 3. Cut sizing: adversarial review
**VERDICT: approve the direction, but don't code the design as written.**

The core is sound and matches PRINCIPLES.md:24-33 and LOAD_BUDGET_SPEC §5-6: TSS as the one currency, Signal A = TSS × runSpec, a fixed protection order, and removing the hard caps. The two hard problems are that the design doesn't deliver its own central promise, and that four blockers make its test plan fail:

- **Broken promise.** The claim is "one currency, same answer, nothing absorbed twice." In fact the excess path and the session path size the same session differently (R1). And the claim that sessions are priced "exactly as the week load bar prices them" is false for sessions without HR (R2).
- **Blockers:**
  - No-HR cross-training is badly overpriced (R3).
  - The pricer disagrees with the allocator for fast-finish long runs (R4).
  - The ledger stored on merged mods is corrupted by paths the plan never mentions (R5).
  - In taper weeks the quality session becomes the first thing cut (R7).

One probe file (`src/calculations/zz_probe_advrev_k7p2.test.ts`) was run and deleted. `git status` is clean and no repo files changed.

## Probe results against the design's claims

| Claim | Result |
|---|---|
| Week 5/16, 5 runs: easy 31.2, MP 37.7, float 53.4, fast-finish 89.7, total 243.2 | Confirmed |
| P4: downgrades keep the old RPE | Confirmed. MP→"26min @ 6:00/km (easy)" keeps t=easy, rpe 6 and 37.7 TSS. Float→MP keeps rpe 7 and 53.4. |
| "sessionTSS = what `computeWeekRawTSS` counts" | **False for no-HR cross-training.** A 60-min no-HR adhoc at RPE 3 and at RPE 7 both give 69 in the bar (see R2). |
| Allocator accounting for the fast-finish long run | **Inconsistent.** Price goes 13 km → 89.7 and 11 km → 75.9, a delta of 13.8. The allocator books 2 km × 4.02 = 8.0 (R4). |
| A replaced run prices at 0 | Today it is "0km (replaced)" → duration 1 → 1 TSS a day (B11). The design fixes this. |
| `workoutsToPlannedRuns` km | Undercounts quality sessions: Float 6×3 = 2 km (about 30 min real), MP 26 min = 4.7 km (R6). |
| Taper week 15 | Easy runs 5 km ×3 at 19.5 each, long 10 km at 40.2, threshold 2×12 at 69.4 (R7). |

## Required changes

**R1. Size the excess path from items, not from `E × wRS − ledger`.**
- **Dilution.** `wRS` averages runSpec over *all* week items, including on-plan runs at 1.0. So excess caused by a ride gets converted at about 0.8–0.9, not 0.55. Example: runs are 60% of the week's Signal B so far. Then wRS = 0.82, and the same ride cuts about 49% more via the plan strip than via the modal.
  - LOAD_BUDGET_SPEC §5's text says "weight by each activity's contribution to the excess". Its formula doesn't do that.
- **Double netting.** E is actual-to-date (`getWeeklyExcess`, `fitness-model.ts:699-707`). Once a reduced run is completed, E already includes the cut, and subtracting `ledger.absorbed` again under-cuts. Example: a 60-TSS ride, 31.2 absorbed, the reduced runs done, and the long run done 18 TSS hard. Then excessB = 46.8 × 0.9 − 31.2 = 10.9, against a true unabsorbed 1.8 + 18 = 19.8.
- **Not a displacement measure.** E ignores the runs still to come, so mid-week it doesn't measure how much running a session displaced.
- **Fix:** budget = Σ over unabsorbed items of (sessionTSS × runSpec), plus matched-run surplus (actual − `priceWorkoutTSS(planned)`) at 1.0. Use E (and ACWR) only to decide *whether* to prompt.

**R2. Make sessionTSS match the bar, or fix the bar in the same batch.**
- `addAdhocWorkoutFromPending` creates a `garminActuals['garmin-<id>']` twin (`activity-matcher.ts:1137-1150`).
- `wk.rated['garmin-<id>']` is never set, so `computeWeekRawTSS` (`fitness-model.ts:417-433`) prices every no-HR cross-training session at RPE 5 (1.15/min). The adhoc copy with its derived RPE is then deduped away.
- GPS runs fall back to a 30-min default (`parseDurMinFromDesc`, `:294-297`; B9).
- Test #2 fails as written. This extends B14 to cross-training, which the audit only covered for runs.

**R3. No-HR non-running pricing needs its own decision (D3/D4 are too narrow).**
- TL_PER_MIN is calibrated on running (`sports.ts:4-9`). Once sportMult, active fraction and the 0.80 are dropped, a no-HR 60-min walk costs 39 TSS at RPE 3 and 69 at RPE 5. The app's own normaliser gives about 16 TSS/h for walking at an assumed 35% HRR.
- `deriveRPE` gives STRENGTH_TRAINING and INDOOR_CARDIO RPE 6, which is 87 TSS/h (`activity-matcher.ts:261`). Apple sessions are all no-HR (audit D4), so Apple users are hit hardest.
- **Fix:** use the existing `computeCrossTrainTSSPerMin(wks, sport)` (`fitness-model.ts:723`, already used at `plan-view.ts:201`) as the first no-HR fallback. Fall back to TL_PER_MIN only when there are fewer than 2 samples.
- **Add C7 as a prerequisite.** Per-item runSpec comes from appType buckets (`mapAppTypeToSport`, `activity-matcher.ts:998-1006`: only ride, swim, walk and gym are mapped; everything else is generic_sport 0.40). Meanwhile Signal A and wRS use `normalizeSport(w.n)`, so one session can get two different runSpecs. The design's sport table (swim 0.20, rowing 0.35, cycling 0.55) is mostly unreachable today.

**R4. Price fast-finish and progressive runs by segment, and store the slot.**
- `priceWorkoutTSS` prices "13km: last 3 @ MP" at RPE 5 over 78 min, which is 6.90/km. That is 72% above the 4.02/km easy rate the allocator removes at. Test #13 breaks, and the ceiling denominator and severity are inflated.
- **Fix:** price the easy part at the long pace factor with the generator's long RPE, and the tail at the MP factor with MP RPE. These are existing constants, so no new numbers.
- Long-run detection: the only marker is the name `'Long Run (Fast Finish)'` (`intent_to_workout.ts:64-70`). The mid-week "Progressive Run" has the same `t`. Persist `slot` on the Workout rather than matching on the name.

**R5. The ledger can't live as numbers on merged mods.**
- **Writers that corrupt it:**
  - KmNudge rewrites an XT-reduced mod's `newDistance` in place (`plan-view.ts:2598-2604`). The km come back but xtTSS stays.
  - "Timing accepted:" is not matched by `isTimingMod`. It is written from raw-plan values (`plan-view.ts:2676-2688`), as are Recovery mods (`events.ts:2356+`). Both override the XT cut last-wins (`renderer.ts:298-317`).
  - The renderer also applies Timing mods' `status:'planned'` over a reduced run.
- **Removers work by prefix or name:**
  - Re-review strips `Garmin:` (`activity-review.ts:247`).
  - Tier-1 undo strips `Auto:` (`plan-view.ts:2653`).
  - The undo sheet strips all non-`Auto:` mods for a name (`:2676`).
  - `window.undoWorkoutMod` (`renderer.ts:88`), clearGarmin (`:72`) and the migration in `persistence.ts:285` also remove mods.
  - "Merge by name and day" makes each of these remove too much or too little.
- **Fix:**
  - Keep one entry per source (delta and source ids) and compose them at render.
  - *Derive* absorbed TSS as price(original) − price(current).
  - List every writer and remover in the plan.
  - Build Timing mods from the plan with mods applied (A3).

**R6. Allocator pseudo-code bugs.**
- `slack` is computed once and never decremented, so two easy cuts can breach the weekly floor. The long-run branch ignores slack.
- Replace doesn't decrement `rem` or `runsLeft`.
- `n` in `keep` is undefined.
- Floor km comes from `workoutsToPlannedRuns`, which undercounts quality sessions (see probe). Use duration-based km instead.

**R7. Taper and race week: no quality steps.**
- `computeRunningFloorKm` returns 0 in taper (`fitness-model.ts:1231`).
- With D10(b) (30 min = 5 km) and MIN_LONG_KM 10, taper week 15 has zero volume slack. A 25-TSS ride (credit 13.75) steps the threshold session down: 69.4 → about 56.6, a delta of 12.9.
- That contradicts Bosquet 2007 in `running.md` §9.1 ("reduce volume, not intensity"). Show the remainder as unabsorbed instead.

**R8. Fix the right UI surfaces.**
- `renderExcessLoadCard` and `wireExcessLoadCard` have no callers, so P8a's "card still renders" and D31 target dead code.
- The live surfaces are:
  - `buildAdjustWeekRow` (`plan-view.ts:1856-1893`), shown whenever E > 15 with no suppression.
  - `buildCarryOverCard` (`:1720`).
  - The readiness "Adjust session" button, which calls `triggerACWRReduction` (`home-view.ts:2057-2068`).
- Drive their visibility from the netted budget, and delete the dead card in the same pass.

**R9. Specify the shared week-plan module correctly.**
- `plan-view.ts:1565` is `showRecoveryAdjustModal`, not the plan view. The displayed plan comes from `getPlanHTML` (`:1914-1919`), which also passes `forceDeload` for holiday weeks. No cut path does.
- Apply mods first, then `workoutMoves`, so D15/D16 ordering is correct while mods still match on the original day. `strain-view.ts:228-244` does it the other way round.
- P7 overclaims. Home (`home-view.ts:760-781`), readiness (`readiness-view.ts:155-174`) and coach (`daily-coach.ts:129-161`) build daily targets **without** mods, so cuts don't lower them. Adopt the shared module there too.

**R10. Fix the test plan and the worked example.**
- Test #4 is wrong under D6(a): 60 × 0.95 / 213.3 = 0.27, which is "heavy". It is "light" only under D6(b), about 262.7 → 0.22.
- Tests #2 and #13 fail until R2 and R4 land.
- The headline table uses a 4 km floor and RPE-3 pricing, not the recommended D6(b)/D10(b). Under the recommended defaults, the 60-TSS ride gives 8→5 and 8→5.

**R11. Present D6, D7 and D14 as one coupled decision.**
- D6 changes easy and long prices by 1.42×, and those prices feed `projectWeekSignalB`.
- `acwrB = projection − plannedSignalB` compares against a history-based target. The design itself calls that target independent of the generator (P7, D14). So acwrB can be non-zero with no cross-training at all, or zero despite large cross-training.
- The argument used to reject D14 applies equally to D7(a) and to E.
- The ACWR path also has no ceiling. Either cap it with the same ceiling or prefer D7(b) once B1 ships.

**R12. Complete the prerequisites and correct the framing.**
- **Add to the prerequisites:**
  - B12: the sex-blind normaliser makes female HR TSS about 19% low against sex-neutral planned-run prices, so women get smaller cuts.
  - C7 (see R3).
  - B14 extended to cross-training (R2).
  - A3 (Timing mods built from the raw plan).
- **Framing:** Tristan's "overflow counted twice" ask is B3, the missing garminId dedup in the `computeWeekTSS` unspent loop (`fitness-model.ts:381-392`). The ledger fixes double *cutting*. Both need to ship; don't present the ledger as the answer to his ask.

**R13. Define the recovery terms.**
- Apply the top-up once per decision, not per item. The spec §6 guardrail is +20 TSS total, and per-item sizing would allow N × 20.
- Define `rec`. Today only the excess path passes `computeRecoveryTrend` (`excess-load-card.ts:271`); review, modal and ACWR pass 1.0.
- Say whether the `recMult` in severity is the sport's `recoveryMult` or the trend multiplier.

**R14. Surface these as explicit decisions for Tristan.**
- Dropping runner-type ordering: Speed runners currently cut volume first (`suggester.ts:524-529`). The plan only mentions it as a FEATURES edit.
- Injury mode: today the long run can be replaced in injury mode (`suggester.ts:315`), but test #11 says "never replaced".
- Methodology conflicts with itself: `:250` gives a 60% long-run floor, but `:251` says the long run gets "no volume cut". D10(b) also borrows the 30-min floor from `:186` but not the rule at `:190` (replace the run when the floor binds).

**R15. Fix copy that contradicts the design.**
- "Push to next week" (`suggestion-modal.ts:432`) and "Apply to next week" (`:368`, which just closes with 'keep' at `:508`) change nothing in next week's plan.
- The "already at minimum…push it to next week" paragraph (`:390-393`) will now show often in 3–4-run weeks.
- The new "unabsorbed" line must not promise carry-over.

## Optional improvements
- Record source IDs for sessions where the user chose Keep, so the Adjust strip doesn't prompt again for the same load.
- After cumulative cuts, "(was Ykm)" should show the original distance. Today `applyAdjustments` sets `originalDistance = workout.d` (`suggester.ts:1346`).
- Parse float recoveries (B15) so float prices are right. Threshold→"steady" is priced as MP.
- Guard `equivalentEasyKm` when no easy run remains; use the easy rate derived from pace.
- The GPS (`recording-handler.ts:154-196`) and `events.ts` paths should adopt the shared plan module and the D16 filter, not just the new signature.
- D12 corrections:
  - `LOAD_BUDGET_CONFIG.maxReplacementPct` is used, but only by dead code (`load-matching.ts:125` via `matcher.ts`, which has no production caller per `renderer.ts:14`). Its comment has no citation.
  - Tanaka's 20–30% is the cross-training *share of total volume*. That is a different quantity from TSS displaced relative to planned running; document how one maps to the other.
- Monotonicity: the greedy "take it if it fits" proof holds (I checked the first-divergence argument). The only exception is up to 0.05 km of rounding overshoot, which test #7 already tolerates.

## Invented-constant check
- Every number in the design traces to code or docs, or is flagged as a decision: D10/11/12/18/20/22/30/32 and the spec's 20 TSS and E ≤ 15.
- No unflagged inventions found.
- **Caution on R4:** its segment pricing must reuse the existing pace factors (`fitness-model.ts:604-609`) and the generator's RPEs (`intent_to_workout.ts`), not new values.
# 4. Max HR: design
## Max HR fix: inventory, intended method, fix design and decisions

This is a read-only analysis. No repo files were changed. My two probe files (`src/calculations/zz_probe_maxhr_7db4.test.ts` and `..._7db4b.test.ts`) were run and then deleted. Four other untracked `zz_probe_cutsize_*.test.ts` files are in `src/calculations/`. They are not mine, and I did not touch them.

## 0. Summary

- **What the docs say versus what shipped.** The documented method is the median of the top 5 session max HRs (CHANGELOG 2026-04-07). It never shipped.
  - The code before commit `45d18ea` used the all-time peak.
  - `45d18ea` added `floor(n*0.95)` in three server places and one client place. That rule returns the maximum whenever n ≤ 20.
  - Standalone Strava sync applies it to 5 rows only, so it always returns the peak.
- **Five sources write `s.maxHR`, with no precedence between them.** The Garmin physiology sync overwrites a value the user typed. The Strava-only and Apple path derives a value once and then locks it.
- **Stored iTRIMP and stored `hr_zones` are never recomputed, and the max/resting HR used is not recorded on the row.** A later max HR change therefore splits history into two scales.
  - Probe numbers: iTRIMP at a true max of 188 is 1.54× iTRIMP at a spiked 216.
  - Training steadily, with the acute week on the new scale and 21 of 28 days on the old one: ACWR = 1.54 / ((1.54 + 3) / 4) = **1.36**. That is a false "caution", because `recreational` safeUpper is 1.35 (fitness-model.ts:915-921).
  - The reverse change gives a false **0.71**, which reads as "low".
  - So any fix that changes max HR must rescore the whole ACWR/CTL window at once. Otherwise the fix itself creates a false high injury risk.
- **A per-activity HR histogram (seconds per bpm) recomputes iTRIMP exactly.**
  - Probe: relative difference below 1e-9 against the stream formula, across three (rest, max) pairs.
  - About 0.3–0.8 KB per row.
  - Zero extra Strava calls for new activities, one call per existing stream-processed row.
  - Recommended.

---

## 1. Inventory

### 1a. Where max HR is derived

| # | Location | Method | Inputs / defects |
|---|---|---|---|
| D1 | `supabase/functions/sync-strava-activities/index.ts:984-1019` (standalone) | `order(max_hr desc).limit(5)`, then `floor(n*0.95)` | Returns `sorted[4]`, the all-time peak (probe: `[216,191,190,189,188]` → 216). With fewer than 5 rows it takes the median. With none it uses `daily_metrics.max_hr ?? 190` (:1017). Comment :984 still says "median of top 5". Used only when the client sends no `max_hr_override` (:1004). |
| D2 | same file, `:718-752` (backfill) | all rows, `floor(n*0.95)` | Runs **before** this invocation upserts anything (:720 vs :833/:916), so the first backfill sees an empty table and uses 190. No dedup. Unordered select, so PostgREST's row cap applies. |
| D3 | `supabase/functions/sync-physiology-snapshot/index.ts:73-79, 141-151` | all rows, `floor(n*0.95)`, median below 5 | Garmin and Strava copies of the same session are both counted. All activity types. Returned as envelope `maxHR` (:162). |
| D4 | `src/data/stravaSync.ts:142-157` | p95 of the last 28 days of standalone rows, filter `100 < hr < 230`, needs ≥3 | Runs only `if (!s.maxHR)`, so it is locked forever. With 20 or fewer rows it is the single highest reading. Does not call `setAthleteNormalizer`. |
| D5 | `src/calculations/heart-rate.ts:59-62` | `220 − age` (Fox) | Zone fallback. |
| D6 | `src/calculations/activity-matcher.ts:227-228` (`deriveRPE`) | `maxHR \|\| 220 − age`; `restingHR \|\| 55` | Auto-RPE fallback. |
| D7 | `garmin-webhook/index.ts:159` (activity `max_hr`), `:205` and `garmin-backfill/index.ts:189` (`daily_metrics.max_hr`) | raw Garmin values | The daily value is **that day's peak**. It is used as the max HR fallback in D1/D2 (:750, :1017). On a rest day it can sit well below true max. |
| D8 | Strava `max_heartrate` → `garmin_activities.max_hr` (index.ts:856, :903, :1218) | Strava instantaneous max sample | Carries every sensor spike straight into D1–D4. |

### 1b. Where `s.maxHR` and `s.restingHR` are written

| Writer | File:line | Behaviour |
|---|---|---|
| Wizard, fitness-data step | `src/ui/wizard/steps/fitness-data.ts:225-246` | User entry, validated 100–240. Goes to `s.onboarding`. |
| Wizard, physiology step | `src/ui/wizard/steps/physiology.ts:232-244` (autofill from D3), `:287-299` (save) | An autofilled value saved unchanged is indistinguishable from a typed one. |
| Plan init / Rebuild | `src/state/initialization.ts:216-217`; called from `account-view.ts:853, 1318` | `s.maxHR = onboarding.maxHR`. A Rebuild overwrites a later Account edit, because Account Save does not update `s.onboarding`. |
| Account Save | `src/ui/account-view.ts:747-765` | Writes `s.maxHR` and `s.restingHR`. Does **not** call `setAthleteNormalizer`, and does not trigger any recompute. |
| Strava derive | `src/data/stravaSync.ts:145-156` | One-time lock (D4). |
| Garmin physiology sync | `src/data/physiologySync.ts:125-128` (max), `:118-121` (resting = newest day) | Overwrites unconditionally, including a user value. Called from main.ts:425/438/465/472, sleepPoller.ts:56 (every 3 min until sleep lands), readiness-view.ts:550, home-view.ts:1419, main-view.ts:2686/2692, account-view.ts:954/956, and the wizard. Returns early for users with no Garmin data (:97). |
| Apple physiology | `src/data/appleHealthSync.ts:305` | Resting HR = newest HealthKit day. Never sets max HR. `setAthleteNormalizer` is imported (:31) but only main.ts calls it. |

### 1c. Consumers

| Consumer | File:line | Max/resting source | Notes |
|---|---|---|---|
| Stream iTRIMP (Strava) | `sync-strava-activities/index.ts:37-57`; called at :815, :1132 | D1/D2 or override; rest = `daily_metrics` newest `?? 55` (:734, :1002) | The client never sends resting HR. Stored permanently: the cached row is returned as-is (:1099-1104; backfill skips at :766, :880). |
| Summary iTRIMP (Strava) | index.ts:59-71; :822, :844, :889, :1138, :1164 | same | same |
| Stored `hr_zones` (%max 60/70/80/90) | index.ts:74-96; :816, :1133 | same | Also never recomputed. They feed history zones (:514-523), `getDailyLoadHistory`, cross-training classification (`universalLoad.ts:147, 436-441, 510-576`) and the zone bars. |
| Client summary iTRIMP | `activity-matcher.ts:385-397` (`resolveITrimp`); enrich loop `:531-583`; `healMissingITrimp` `:1066-1098` | `s.maxHR`, `s.restingHR` | Garmin-webhook rows (no DB iTRIMP) are recomputed on every sync for the 28-day window (`activitySync.ts:26-32`). Older weeks keep stale values. The enrich loop overwrites `actual.iTrimp` from DB rows, but not `adhocWorkouts[].iTrimp`. The sanity check `>3 TSS/min` on a fixed 15000 is at :537-541. |
| Normaliser | `fitness-model.ts:265-291`; set at main.ts:146, 393, 411, 428, 467 | `s.ltHR`, `s.restingHR`, `s.maxHR` | Differs from 15000 only when Garmin supplies an LTHR. β is fixed at 1.92, while iTRIMP uses 1.67 for female athletes. |
| History TSS / baselines | index.ts:497-507 (fixed 15000) → `stravaSync.ts:252-276` | DB iTRIMP | `ctlBaseline` and `signalBBaseline` (the ACWR pre-plan seed) are rebuilt only at onboarding or when history is thin (main.ts:486-489). |
| Zone estimate from avg HR | `fitness-model.ts:1086-1095`; `rolling-load-view.ts:297` | `s.maxHR` | |
| Auto-RPE | `activity-matcher.ts:212-245`; call sites :462, :687, :760, :868; `activity-review.ts:107-126` | `s.maxHR \|\| 220−age`, `restingHR \|\| 55` | Writes `wk.rated` (:760). |
| HR effort score / insight | `activity-matcher.ts:190-202`; `workout-insight.ts:352-362`; `activity-detail.ts:314` | Karvonen | |
| Workout HR targets (user-facing) | `main-view.ts:1575`, `renderer.ts:282`, `activity-matcher.ts:310` (generator), `plan-view.ts:216-221` | Karvonen / LTHR | A 216 spike moves prescribed Z2 up by about 15 bpm. |
| `rate()` HR logic | `src/ui/events.ts:454-459, 516-521, 554-559` | **`lthr: s.lt`**, which is LT *pace* in sec/km (state.ts:334); also `s.onboarding.maxHR` at :457 | New defect. With pace around 270, `calculateZones` takes the LTHR branch (heart-rate.ts:45) and zones come out at about 175–300 bpm. Latent today: the only avgHR caller is the `sync-activity` listener (renderer.ts:1611-1641), and nothing dispatches that event. |
| Display only | main-view.ts:897-970 ("Peak HR (7d)", daily peak), stats-view.ts:1648, activity-detail.ts:111, strain-view.ts:120, plan-view.ts:2755 | | |
| Apple activities | `appleHealthSync.ts:409-410` | none | `avg_hr` and `max_hr` are always null. The `heartRate` permission is requested (:46) but never read. |

---

## 2. Intended method and methods already in code or docs

- **Intended method.** CHANGELOG.md:906-910 (2026-04-07) says "median of the top 5 activity max HRs" in standalone, backfill and physiology snapshot, "should shift from 216 to ~191".
  - `git log -S` shows this CHANGELOG text and the p95 code landed together in `45d18ea` (2026-04-08, "includes prior uncommitted work").
  - The code before that commit used the all-time peak (`limit(1)`).
  - The same entry says "ACWR ratios unaffected (both sides scale equally)". That is false while stored rows are never rescored.
- **SCIENCE_LOG.** There is no entry for how max HR is estimated.
  - :305 says of iTRIMP: "no outlier filtering for erroneous spikes".
  - :426-428 and :1313: 220−age (Fox 1971), standard error around 10–12 bpm.
  - :570-585: the LTHR normaliser and the 15000 fallback.
  - :1312: "Default resting HR of 55 bpm may be far from actual".
- **Constants already in code** (usable without inventing anything):

| Constant | Where |
|---|---|
| top 5, median | CHANGELOG 2026-04-07 |
| p95 (`floor(n*0.95)`) | D1–D4 |
| minimum sample 5 (server) / 3 (client) | index.ts:741, stravaSync.ts:149 |
| plausibility filter `100 < hr < 230` | stravaSync.ts:148 |
| manual-entry range 100–240 | account-view.ts:752, physiology.ts:294, fitness-data.ts:236 |
| resting HR range 30–120 (wizard) vs 30–100 (Account) | inconsistent |
| 220 − age | heart-rate.ts:61, activity-matcher.ts:227 |
| default max 190 | index.ts:750, :1017 |
| default resting 55 | index.ts:734, :1002, activity-matcher.ts:228 |
| duplicate window, 2 min on start time | index.ts:462-475 (history mode) |
| 28-day window | stravaSync.ts:27; resting HR baseline at stats-view.ts:2464 and :2836; `physiologyHistory` slice(-28) |
| heal caps | 10 (standalone calories, :1106), 15 (backfill calories), 99 (`STREAM_BUDGET`, :759) |
| Strava limit per the code comment | 100 requests / 15 min (:1023) |

---

## 3. Fix design

### 3.1 Estimator

**Recommendation:** median of the top 5 **deduplicated** session peaks, all-time, filtered to the existing `100 < hr < 230`. This is the documented method, with the dedup it was missing.

**Why:**

- Peaks seen in training are a lower bound on true max, because true max is rarely reached in training.
- Sensor artefacts sit above true max: optical cadence lock, static on a strap, wrist-flexion spikes during strength or HIIT sessions.
- An order statistic across sessions balances the two errors. The median of 5 tolerates up to two bad sessions.
- The cost is a downward bias when fewer than three sessions reached true max. In the probe, −4 bpm gives +7.6% iTRIMP and −8 bpm gives +16%.
- The p95 rule has no fixed breakdown point: for n ≤ 20 it is simply the maximum.

**Probe results (synthetic data):**

- 5-row standalone case: p95 = 216, median of top 5 = 190.
- Duplicated rows: `[216×2, 191×2, 188×2, …]` gives a median of 191; after dedup it is 188.
- Two duplicated spikes: 205 without dedup, 198 with it.

**Query:** `select start_time, max_hr, source … order by max_hr desc limit 10`. The limit of 10 is 5 sessions × 2 copies (Garmin plus Strava). Then dedup on the 2-minute start window and take the median of the first five. Ordering and limiting also avoids the silent truncation that the current unordered select risks.

**Where it runs:** one pure helper, used by standalone, backfill and physiology snapshot, returning `{ value, n, peaks: [{start_time, bpm, garmin_id}] }`. The client stops deriving its own value, so the block at stravaSync.ts:142-157 goes.

- Edge functions currently inline everything ("no imports in Deno edge", index.ts:34). Either add `supabase/functions/_shared/`, or mirror a tested helper from `src/calculations/max-hr.ts`.
- Mirroring keeps vitest coverage.

### 3.2 Dedup

- Garmin webhook rows (numeric `garmin_id`, `source` null) and Strava rows (`strava-…`) come from the same FIT file and share the same max.
- Reuse the 2-minute rule from history mode.
- When a pair collapses, keep one value: prefer the row with a histogram, then Strava, then Garmin. Their values are near-identical anyway.
- Apple rows are not in the database. If they are added later (decision 11), the same rule covers them.

### 3.3 Precedence and source flag

Add these to state:

- `s.maxHRSource: 'user' | 'derived' | 'age' | 'default'`
- `s.maxHRDerived?: { value, n, peaks, computedAt }`
- the same pair for resting HR (`'user' | 'wearable'`)

The effective value is the first available of: user, then derived (n ≥ minimum), then 220 − age, then 190.

- **Setting `'user'`:** Account Save sets `'user'` and must also update `s.onboarding.maxHR`, so that Rebuild does not clobber it (initialization.ts:217). The wizard sets `'user'` only when the typed value differs from the autofilled one.
- **Respecting it:** `physiologySync.ts:125-128` and the new Strava path write `s.maxHRDerived` always, but write `s.maxHR` only when the source is not `'user'`.
- **Sending it:** keep sending `max_hr_override`, and add a `resting_hr_override`. The server then never estimates on its own when the client has a value.
- **Account screen:** shows the effective value, its source, and the derived value with the peaks it came from.

### 3.4 When to re-derive

- Recompute the estimate on every sync that returns rows. It is one indexed query of 10 rows.
- Because bpm are integers, a top-5 median moves only when a new session enters the top five. No hysteresis is needed.
- If the effective tuple (max, resting, sex) changes, run the rescore pipeline in 3.6. The same pipeline runs on Account Save, which today also misses the normaliser refresh.

### 3.5 Resting HR

**Current state:**

- The server uses the newest `daily_metrics` row, or 55. The client never sends a value.
- Strava-only and Apple users are always scored at 55. HealthKit's value (appleHealthSync.ts:305) stays in state and never reaches the server.
- The client uses the newest day.
- So a single bad night changes every Garmin-only iTRIMP in the 28-day window (enrich loop).

**Recommendation:** use the median of the last 28 days of daily resting HR. That window already exists for resting HR baselines. Banister's resting HR is a stable baseline; using a single day's value mixes recovery state into the load number.

**Sensitivity (probe):**
- 10 bpm of resting HR error ≈ 5.8% of iTRIMP.
- With the LTHR normaliser it is about 2% of TSS.

### 3.6 Stored iTRIMP and zones computed with an old max HR

**How much the max HR error matters (probe, 60-minute session, resting 50, LTHR 170):**

| Normaliser | 188 (true) | 216 (spike) | Effect |
|---|---|---|---|
| Fixed 15000 (Strava-only, Apple, Garmin without LTHR) | 77.6 TSS | 50.3 TSS | −35%, roughly 1:1 with iTRIMP |
| LTHR normaliser on the same max HR as the stored iTRIMP | 70.0 TSS | 72.4 TSS | +3%, mostly cancels |
| LTHR normaliser, but stored iTRIMP on the old max HR | 70.0 TSS | 45.4 TSS | full error returns |

- Consistency matters more than accuracy for Garmin-with-LTHR users. Accuracy matters for everyone else.
- A max HR set too low inflates hard sessions: 180 vs 188 gives +20%.

**Design:**

1. **Provenance columns** on `garmin_activities`: `itrimp_max_hr`, `itrimp_rest_hr`, `itrimp_sex`, `itrimp_tier` (`'hist' | 'summary'`). Stale rows then become queryable. Today, for legacy rows, the tuple used is unknown: it could be 190, a p95, or an override.
2. **A DB-only rescore mode** (`mode: 'rescore'`), with no Strava calls. For each row whose provenance differs from the target tuple:
   - with a histogram: exact iTRIMP and zones;
   - else with `avg_hr`: summary iTRIMP;
   - write the provenance.
3. **Client refresh by id across all weeks.** A new select returns `{garmin_id, itrimp, hr_zones}` for every `garminActuals` and `adhocWorkouts` id. Today only the 28-day enrich window heals, and adhoc iTRIMP never does. Then re-run `fetchStravaHistory` to rebuild `signalBBaseline` and `ctlBaseline`, since the seed is on the old scale. Then call `setAthleteNormalizer`.
4. **Switch atomically.** Change the effective tuple in state only after the server confirms that every row in the last 28 days is on the new tuple or is summary-tier. Otherwise the ACWR mixing in §0 appears.
5. **Legacy stream rows with no histogram.** There are four options:

| Option | Accuracy (probe) | Cost | Problem |
|---|---|---|---|
| Re-stream | exact, and produces the histogram | 1 Strava call per row | uses shared rate limit |
| Rescale by avg-HR summary ratio | ≤0.6% steady sessions; up to 9% on extreme 30:30 intervals | 0 calls | needs the old tuple, which legacy rows lack |
| Replace with summary iTRIMP | 2–36% low on interval sessions | 0 calls | discards stream information |
| Leave stale | — | 0 calls | keeps mixing scales |

   **Recommendation:** re-stream, most recent first, and gate the tuple switch on the 28-day window only.

### 3.7 HR histogram option

**Schema.** Mirrors the `km_splits integer[]` precedent:

```sql
ALTER TABLE garmin_activities
  ADD COLUMN IF NOT EXISTS hr_hist_lo     smallint,   -- bpm of bin 0
  ADD COLUMN IF NOT EXISTS hr_hist        integer[],  -- seconds per 1-bpm bin from hr_hist_lo
  ADD COLUMN IF NOT EXISTS hr_hist_status text,       -- 'ok' | 'no_hr' | NULL (not attempted)
  ADD COLUMN IF NOT EXISTS itrimp_max_hr  smallint,
  ADD COLUMN IF NOT EXISTS itrimp_rest_hr smallint,
  ADD COLUMN IF NOT EXISTS itrimp_sex     text,
  ADD COLUMN IF NOT EXISTS itrimp_tier    text;
```

**How the bins are built.** Use exactly the dt rule in `calculateITrimp`: each interval `dt = t[i] − t[i−1]` goes to `hr[i]`, and intervals with dt ≤ 0 are skipped.

- Keep bins at or below resting HR, so that any future resting HR can be applied.
- iTRIMP is then `Σ sec_b · HRR_b · e^(β·HRR_b)` over the bins. Zones in any scheme are sums of bins against bpm thresholds.
- This also allows the app's Karvonen/LTHR zones later (audit item C9).

**Size:**
- Probe: a 60-minute session including a 216 spike had 80 dense bins: 220 bytes as JSON, about 344 bytes as `int4[]`.
- Hard upper bound is 201 bins (30–230 bpm), about 0.8 KB.
- A 1 Hz HR plus time stream stored raw would be about 29 KB per hour, 35–80× larger.

**Strava rate limit:**
- **New activities cost nothing extra.** The stream is already fetched (index.ts:803-806, :1117-1121).
- **Existing rows cost one `streams?keys=heartrate,time` call each.** Run this through the drift-heal path at :1184-1203, after fixing it:
  - add `hr_drift` and `hr_hist_status` to the cached select at :1028;
  - `await` the updates at :1177 and :1197, which currently use `void …` and never run;
  - one fetch then writes the histogram, drift, rescored iTRIMP/zones and provenance.
- **Stop infinite retries.** Set `hr_hist_status='no_hr'` when the stream has no heart rate, so rows are not re-streamed forever. Today a null `hr_zones` refetches the stream on every sync.
- **Shared budget.** Strava applies limits per application, across all athletes. Fixing the drift heal frees budget the app wastes today: every cached run of 20 minutes or more is re-streamed on every sync.
- **Order and cap.** Most recent first, a per-sync cap (decision 10), and stop on the first 429.

**Backfill of existing rows by source:**

| Source | How | Strava calls |
|---|---|---|
| Strava stream rows | re-stream as above | 1 per row |
| Strava avg-HR-only rows | optional re-stream | 1 per row; also upgrades them from summary to stream tier (fixes 8–36% under-count on intervals) |
| Garmin rows | `activity_details.json_data` is stored raw (garmin-webhook/index.ts:384-399). If it carries per-sample heart rate (check one real row), build histograms from it. This would also give Garmin-only users stream-tier iTRIMP. | 0 |
| Apple | `Health.readSamples({dataType:'heartRate', startDate, endDate, limit})` per workout (plugin 8.2.16 supports it). Depends on the Apple sync fixes (`isNativeiOS`, and so on). | 0 |

**Limitations:**
- No time order, so no drift (already stored separately) and no rolling-window peaks. Those can be computed at ingest if wanted.
- The pause-gap attribution is baked in. Tristan is not worried about pause gaps; if that handling ever changes, rows need a re-stream.
- Apple's roughly 5-second, fractional samples round to 1-bpm bins, an error of at most 0.5 bpm.

### 3.8 Suggested order of work

1. Migration. Ingest writes the histogram and provenance. Fix the drift heal (select, await, `no_hr` sentinel).
2. Rescore mode, client refresh by id, history refresh, normaliser refresh, and the atomic switch.
3. The new estimator, source flags, resting-HR override and resting-HR baseline. Remove D4, remove the `daily_metrics.max_hr` fallback, and make physiologySync respect `'user'`.
4. Garmin details histograms, Apple HealthKit histograms.
5. Adjacent: `events.ts` `lthr: s.lt` → `s.ltHR`. Sex-specific β in the normaliser (SCIENCE_LOG:584 already lists it as a limitation).

**Tests:**
- estimator: a spike, duplicates, n below the minimum, the bounds;
- histogram iTRIMP and zones equal the stream results;
- a `'user'` value is never overwritten;
- ACWR is unchanged by a tuple change once rescored;
- no mixing when the tuple switch is gated.

**Docs:** a SCIENCE_LOG entry ("Max HR and resting HR estimation"); a new CHANGELOG bullet noting the 2026-04-07 entry never shipped (add it, don't rewrite the old entry); FEATURES; ARCHITECTURE for the new columns and modes. Absolute TSS will shift for most users, so the changelog should say so.

---

## 4. Decisions for Tristan

| # | Decision | Recommendation |
|---|---|---|
| 1 | Estimator | Median of the top 5 deduped session peaks, as documented. Alternative: the second-highest peak, which tolerates one bad session and has less downward bias. |
| 2 | Minimum sample, and what to use below it | n ≥ 5, which the "top 5" method implies. Below that, use 220 − age if age is known, otherwise 190, and mark it provisional. Histograms let provisional scores be rescored later. |
| 3 | Time window | All-time (top-10 query). There is no max HR window constant to use; the 28 days in D4 exists only because of how D4 was built. |
| 4 | Activity types included | All HR-bearing types. The robust statistic absorbs outliers, and cross-training peaks are lower. Alternative: exclude STRENGTH and HIIT because of wrist-flexion artefacts. |
| 5 | Per-activity peak metric | Instantaneous `max_hr` for now. A "sustained peak" from the histogram needs a seconds threshold you would have to set. It removed a 5-second spike in the probe, but it cannot catch cadence lock. |
| 6 | A user value versus a higher derived value | Never overwrite automatically. Show both on the Account screen. Any prompt margin needs your number. |
| 7 | Resting HR estimator | Median of the last 28 days of daily values, sent to the server. |
| 8 | Rescore history with the current tuple, or with the value in force on each date | Current tuple, for one consistent scale in ACWR and CTL. |
| 9 | Legacy stream rows without a histogram | Re-stream, most recent first. Gate the switch on the 28-day window. |
| 10 | Re-stream cap per sync | Reuse the existing heal cap of 10 (index.ts:1106). The number is your call. |
| 11 | Apple rows | Write them to `garmin_activities` so there is one rescore path, once the Apple sync fixes land. |
| 12 | Zone scheme when rescoring | Keep %max 60/70/80/90 in this fix. Moving to Karvonen/LTHR (audit C9) is separate. |
| 13 | Rescore trigger | Any change in the integer tuple. The rescore is DB-only and cheap. |
| 14 | Fix `events.ts` `lthr: s.lt` now | Yes. It is latent, but a one-line fix. |

**SQL to check the estimator on real data.** Replace `<uid>` with the user id:

```sql
with r as (
  select start_time, max_hr, coalesce(source,'garmin') src, activity_type,
         start_time - lag(start_time) over (order by start_time) gap
  from garmin_activities
  where user_id = '<uid>' and max_hr between 101 and 229)
select start_time::date, activity_type, src, max_hr
from r where gap is null or gap >= interval '2 minutes'
order by max_hr desc limit 15;
```
# 4. Max HR: adversarial review
## Adversarial review: max-HR diagnosis and fix design

## VERDICT: sound with changes

The diagnosis is mostly accurate. Three parts of the design are the right approach:
- the per-activity HR histogram,
- provenance columns on each row,
- building the rescore infrastructure before switching the estimator.

The switch protocol does not work as written, though. Old iOS builds would adopt the new value with no rescore. Existing sync paths would leak rescored values into state before the switch. The re-stream path never reaches rows older than 28 days. For users with a Garmin LTHR, ACWR still moves after a perfect rescore because history mode uses a different normaliser.

My probe (`src/calculations/zz_probe_maxhr_adv9.test.ts`) was run and then deleted. The untracked `zz_probe_ovrv_5c21.test.ts` belongs to another agent. I left it alone.

---

## A. Checked and correct (keep these)

- **The p95 rule returns the maximum for n ≤ 20.** It is `floor(n*0.95)` at `sync-strava-activities/index.ts:743, 1011`, `sync-physiology-snapshot/index.ts:146` and `stravaSync.ts:150`. The standalone query takes 5 rows (`:999`), so it returns the peak.
- **D4 locks the value once set.** `if (!s.maxHR)` at `stravaSync.ts:145`.
- **Physiology sync overwrites unconditionally.** `physiologySync.ts:125-128`.
- **`void supabase…update()` never runs** (`:1177, :1197`). supabase-js v2 builders are thenables and only send the request when awaited.
- **`events.ts:456` passes `lthr: s.lt`**, which is LT pace (`state.ts:334`), not a heart rate.
- **β is fixed at 1.92 in the normaliser** (`fitness-model.ts:270`).
- **Account Save** (`account-view.ts:747-765`) neither sets the normaliser nor recomputes anything.
- **The CHANGELOG entry and the p95 code landed together** in `45d18ea`. The text "median of top 5" never shipped.
- **Things to keep in the design:**
  - the histogram (exact, small, no extra Strava calls for new activities);
  - provenance columns;
  - re-streaming rather than replacing with summary iTRIMP;
  - `'user'` precedence, with Account Save also writing to `s.onboarding`;
  - infrastructure first, estimator second;
  - a new CHANGELOG bullet rather than rewriting the old one;
  - decisions 6, 8 (max HR only), 10 and 12, all correctly handed to Tristan.
- **No invented constants.** Every number is either already in code or flagged as a decision.

## B. Facts that are wrong or overstated

1. **The summary overstates how widely the standalone estimator (D1) applies.** It runs only when the client sends no override (`index.ts:1004`). The client always sends `s.maxHR` (`stravaSync.ts:36, 553`).
   - Garmin users actually run on D3, which is p95 over all rows, counting Garmin and Strava copies of the same session twice. For n > 20 that is **not** the maximum.
   - D1 mainly affects the first sync of Strava-only users.
2. **Backfill does not "use 190".** It uses `daily_metrics.max_hr ?? 190` (`:750`), and only when there is no override and no rows. For a Garmin user that fallback is the newest day's daily peak, which on a rest day can be very low.
3. **Rebuild clobbers a later Account edit only when `onboarding.maxHR` is truthy** (`initialization.ts:217`).
4. **"Never recomputed" is too strong.** The `>3 TSS/min` check recomputes absurd values, in state only (`activity-matcher.ts:537-541`). Backfill also reprocesses `cachedBasic` rows that have no iTRIMP.
5. **Adding `hr_drift` to the select at `:1028` is not enough.** `cachedMap` (`:1034-1039`) copies only itrimp, hr_zones, km_splits and calories, so `cached.hr_drift` (`:1104, :1186`) is always undefined. Both places need the field.
6. **"One indexed query" is unverified.** No migration creates an index on `garmin_activities(user_id, max_hr)`. It doesn't matter at per-user scale.
7. **"Hard upper bound 201 bins" is not a hard bound.** Samples are not clamped. A 0-bpm dropout stretches a dense array down to 0. `calculateHRZones` counts dropouts in z1 (`:88-93`), so the histogram must keep them to reproduce zones exactly.
8. **Baselines are also rebuilt by the manual backfill button** (`account-view.ts:806, 813`), not only at onboarding or thin history.
9. **"No hysteresis is needed" holds only if the tuple is max HR alone.** See required change 13.

## C. Required changes

1. **Version skew: bundled iOS builds.** `capacitor.config.ts` has `webDir: 'dist'` and no `server.url`, so installed builds carry their own JS and will not update with the edge functions.
   - Old `physiologySync` writes the envelope `maxHR` straight into `s.maxHR` (`:125-128`). If the server changes what that field means, every old build adopts the new estimate with no rescore. That produces exactly the false-high ACWR case in §0.
   - **Fix:** leave the `maxHR` field's value as it is and add a new field, e.g. `maxHREstimate: {value, n, peaks}`.
   - The standalone response is a bare array (`index.ts:1257`), and the client drops anything else (`stravaSync.ts:40`). The estimate cannot be added there. Strava-only users never reach the envelope, because physiology sync returns early at `physiologySync.ts:97`.
   - **Specify a delivery channel.** Either a new `mode: 'hr_profile'`, or an opt-in request flag that switches the response to an envelope.
   - **Specify the deploy order:** migration, then additive edge functions, then client.
2. **§3.3 and §3.6 contradict each other.**
   - §3.3 has `physiologySync` and the Strava path write `s.maxHR` whenever the source is not `'user'`.
   - §3.6 step 4 changes the tuple only after the server confirms.
   - **Fix:** those paths write only `s.maxHRDerived`. One orchestrator makes the switch.
   - **Put change detection in that one module.** `syncPhysiologySnapshot` alone has 13 call sites: main.ts ×4, sleepPoller ×1, readiness ×1, account ×2, main-view ×2, home ×1, wizard ×1. Most of them never call `setAthleteNormalizer`.
3. **The switch is not atomic. Existing paths leak rescored values into state before it happens.**
   - The enrich loop overwrites `actual.iTrimp` from any row the server returns (`activity-matcher.ts:531-583`).
   - The standalone path returns `cached.itrimp` (`index.ts:1099-1104`).
   - At launch the app runs several syncs concurrently: `main.ts:401` (Strava), `:425` (physiology) and `:489` (backfill).
   - So a DB rescore reaches the 28-day window before the tuple, normaliser and seed switch, which gives the same mixing described in §0.
   - **Fix:** stamp provenance on returned rows and on each state entry (e.g. `iTrimpTuple`). Only accept values whose stamp matches the current tuple, or hold a sync lock during the switch.
   - Per-entry stamps also make the switch resumable after the app is killed or the network drops mid-refresh.
4. **The gate never converges while a switch is pending.** During the transition, new ingests use the old override, so "every 28-day row on the new tuple" keeps getting broken.
   - **Fix:** say either that the rescore re-runs after each ingest, or that ingest scores at the pending target tuple. Histograms make both possible.
5. **Re-streaming never reaches most legacy rows.**
   - The drift heal sits inside the standalone loop over the Strava list for the last 28 days (`:1061`). It is gated by `DRIFT_TYPES && durationSec >= 1200` (`:1186`).
   - Once `hr_drift` is actually selected, runs that already have drift (every run ingested since `20260312_hr_drift`) never enter it.
   - Backfill skips `cachedWithZones` (`:765-766`).
   - **Result:** cross-training, runs under 20 minutes, and every row older than 28 days never get a histogram. CTL, the 16-week history, the seed and `ctlBaseline` stay on mixed scales.
   - **Fix:** add a dedicated histogram heal keyed on `hr_hist_status IS NULL`, and run it in backfill mode too, most recent first, with a cap.
6. **Heals must stop, and be gated on an "attempted" marker, not on `hr_drift IS NULL`.**
   - `calculateHRDrift` returns null for valid HR streams: fewer than 60 non-zero samples after the 10% trim, or a span under 1200 s (`:162-174`). Those rows would be re-streamed forever even after the select and await fixes.
   - The km_splits heal (`:1170-1181`) fetches detail every sync, forever, for runs with an empty `splits_metric`. It competes for the same budget.
   - `if (cached?.hr_zones)` (`:1099`) and backfill's `cachedWithZones` must both treat `hr_hist_status='no_hr'` as cached.
7. **The history normaliser does not match the client's, so the proposed test "ACWR unchanged once rescored" fails for LTHR users.**
   - History mode uses a fixed 15000 (`index.ts:497-507`). Plan days use `_athleteNorm` (`fitness-model.ts:289, 516`).
   - Probe (rest 50, LTHR 170), `norm/15000`:

     | Max HR | norm/15000 |
     |---|---|
     | 216 | 0.695 |
     | 191 | 1.047 |
     | 188 | 1.108 |

   - With steady training and every row perfectly rescored, day-14 ACWR is **1.18 at 216** and **0.95 at 188**.
   - `signalBBaseline` is also compared with in-plan Signal B at `activity-review.ts:1778`.
   - **Fix:** normalise history on the client's normaliser (return raw iTRIMP sums, or pass the normaliser in). Otherwise, state the exception. Either way, baselines shift for LTHR users, which is a decision for Tristan.
8. **The rescore misses several state targets.**
   - `garminPending[].iTrimp/hrZones` (`state.ts:171-172`). Pending items are kept for re-review (`:274`), and re-review copies `item.iTrimp` back (`activity-review.ts:974, 1064`; `activity-matcher.ts:489, 507, 1131, 1149`).
   - `wk.actualTSS`, which is accumulated at match time on the fixed 15000 scale (`activity-matcher.ts:517-521`). It is read at `events.ts:1023`, `main-view.ts:1921, 2004`, `holiday-modal.ts:388, 919` and `sleep-view.ts:221`.
   - `extendedHistory*` (`stravaSync.ts:588-596`).
   - **Zones never reach state today.** Both patch paths fill zones only when they are missing (`activity-matcher.ts:581`, `stravaSync.ts:72, 84`). The refresh must overwrite them.
   - **Garmin-only rows have no DB iTRIMP.** The client computes it. The refresh must recompute summary iTRIMP locally for all weeks from `GarminActual.avgHR/durationSec`.
9. **Re-running `fetchStravaHistory` re-tiers the athlete.** It re-derives `s.athleteTier` from `ctlBaseline` (`stravaSync.ts:306-314`).
   - A 1.5× scale change can move the tier, and with it ACWR `safeUpper` (`fitness-model.ts:915-921`).
   - It also rebuilds `sportBaselineByType`.
   - Whether a rescore may re-tier the athlete is a decision for Tristan.
10. **Writing iTRIMP to Garmin rows flips history dedup winners.**
    - History dedup keeps the higher iTRIMP (`index.ts:470-472`).
    - Only the Strava copy has `hr_zones`, so the zone history would fall back to estimates.
    - **Fix:** use one dedup preference (histogram, then Strava, then Garmin) in both history mode and the estimator. Alternatively, never write iTRIMP to non-Strava rows.
11. **The estimator argument only covers n ≤ 20.**
    - An all-time median of the top 5 breaks down after **3 artefact sessions ever**. p95 breaks down only when artefacts exceed 5% of sessions.
    - Probe: 300 sessions, true max 188. With 0 to 2 spikes it returns 188. With 3 spikes it returns 205. p95 stayed at 186 to 187.
    - Where p95 falls, by row count: n ≤ 20 is the maximum, n = 40 the 2nd highest, 60 the 3rd, 100 the 5th, 200 the 10th.
    - So for Garmin users with long histories (and D3 double-counts), the new estimator is **at least as high as the current value**. It can adopt artefacts the current code rejects, which lowers their TSS: the opposite of the CHANGELOG's intent.
    - **Before choosing:** extend the SQL to show the current effective value (p95 over all rows, duplicates included) next to the proposal and the 2nd-highest, on Tristan's data.
    - **Make the window a decision.** Existing constants are the 16-week backfill default (`:653`) and the 52-week cap (`:446`).
    - **Decision 4's rationale points the other way.** For a top-order statistic, the lower peaks of other types never count, so non-running types can only add upward artefacts.
12. **`limit 10` assumes at most 2 copies per session.** Decision 11 (writing Apple rows) makes 3 copies possible, and dedup would then leave fewer than 5 sessions.
    - **Fix:** dedup in SQL.
    - Adjacency dedup needs rows sorted by `start_time` first. History dedup compares only with the last kept row (`:466-468`).
13. **Resting HR needs different handling.**
    - A 28-day rolling median moves often. Under decision 13 ("any integer change"), each move triggers a whole-history rescore, a history refresh and a tier re-derivation.
    - Resting HR is a real training adaptation, not a measurement error, so "current tuple for all history" is weaker science for it.
    - **Fix:** add hysteresis or freeze the value (the threshold is Tristan's number), or score each date with the resting HR in force then. Keep max HR on the current tuple.
14. **State migration is missing.**
    - Existing `s.maxHR` has no source. Defaulting to `'derived'` overwrites user values; defaulting to `'user'` locks spiked values in.
    - **Fix:** specify the rule in `migrateState`/`loadState` (`persistence.ts:34, 227+`), e.g. mark it `'legacy'` and show a one-time reconciliation on the Account screen.
    - `onboarding.maxHR` holds the old autofilled D3 value, and `initialization.ts:216-217` copies it back on every Rebuild. Gate that copy by source.
    - Soft reset (`persistence.ts:479-510`) keeps only `onboarding` and drops the new fields. Resting HR has the same problem.
15. **Missing tests:**
    - migration of the source flag for each case;
    - Rebuild and soft reset keep `'user'`;
    - old-client compatibility (the `maxHR` field value is unchanged; the standalone response is still an array);
    - estimator with 3 copies, with fewer than 5 deduped sessions, and with all rows filtered out;
    - heals stop: a row with HR but null drift is not re-streamed, and a `no_hr` row is skipped by both standalone and backfill;
    - histogram with dropouts, samples above 230, dt ≤ 0, and one sample;
    - the rescore is idempotent, converges while ingests run concurrently, and the enrich loop rejects entries with a mismatched stamp;
    - history-normaliser consistency.

    Also reword the ACWR test to "equals ACWR computed from scratch at the new tuple". Invariance holds only for uniform training, because hard sessions scale differently from easy ones.

## D. Optional improvements

- **Share code instead of mirroring it.** Put the estimator and histogram code in a `supabase/functions/_shared/` module with no URL imports, and import it from both Deno and vitest. iTRIMP is already duplicated, and no edge-function tests exist.
- **Check Strava's daily cap, not just the 15-minute one.** To my knowledge Strava's default read limit is about 1,000 requests per day per application; confirm in the Strava developer dashboard. The legacy re-stream is shared across all users.
- **Apple HR samples arrive at irregular intervals.** The dt rule needs a maximum gap, which is Tristan's number.
- **Minor range mismatch.** The server accepts an override only if it is `> 100` (`:437`), while Account accepts exactly 100.
- **Adopting a client-side 190 default is a behaviour change.** Today `resolveITrimp` returns null when there is no max HR, and those sessions fall back to RPE-based TSS.
- **Coordinate with the cut-size fix.** `universalLoad.ts:106` uses raw iTRIMP, so any max HR change moves cut sizes directly.
- **Unify every fixed-15000 conversion with the client normaliser:** `timing-check.ts:89, 94`, `activity-matcher.ts:519` and the calibration at `stravaSync.ts:503`.
- **Refresh by date range, not by id list.** `.in('garmin_id', ids)` across all weeks can hit URL length limits for long histories.
- **Tell users which scale they are on.** Show "provisional" on the Account screen, and expect a visible step at the 28-day boundary in history charts until old rows are re-streamed.
# 5. Overflow double count and Signal A: design
## Signal A double count and runSpec bypass: fix design

## 1. Verdict

Both bugs are real. I reproduced them with a probe test (now deleted).

- **Overflow double count.** An overflow cross-training activity is stored three times: in `garminActuals['garmin-<id>']` (the "twin"), in `adhocWorkouts['garmin-<id>']` and in `unspentLoadItems` (garminId `<id>`). `computeWeekTSS` counts the twin at full weight. It then adds the unspent item again as `min × 1.15 × runSpec`, because that loop has no garminId dedup (`src/calculations/fitness-model.ts:382-392`).
  - Probe, 60-min ride at iTRIMP 9000: Signal A 98, Signal B 60. Signal A should never exceed Signal B.
- **runSpec bypass.** Every flow that accepts a synced non-run activity writes a `garminActuals` entry. The loop at `fitness-model.ts:324-338` counts every entry at raw TSS with no runSpec. The adhoc twin, the only place runSpec was applied (`:341-368`), is then skipped by the dedup. So synced cross-training counts at runSpec 1.0 in Signal A.
- **Two more double counts the brief did not list:**
  - `buildDailySignalBTSS` (`src/calculations/sleep-insights.ts:350-378`) counts every adhoc activity with a twin twice. Its `seenGarminIds` is created after the garminActuals loop and never seeded from it. Probe: 120 instead of 60 for that ride's day. This feeds sleep target and sleep debt.
  - The legacy `updateLoadChart` (`src/ui/main-view.ts:1664-1705`) counts overflow three times: twin as "run" TSS, plus unspent × 0.35 with no dedup, plus adhoc × runSpec with no dedup. It is only reachable right after onboarding.
- **Orphans.** × remove (`src/ui/events.ts:2436-2490`) deletes the adhoc entry and the twin but leaves the unspent item. Today that orphan still counts in Signal A (38), weekly Signal B (69), daily Signal B (69) and the per-sport breakdown.

**Recommended fix:**
- Unspent load items become decision records only. They never add load to any total.
- runSpec is chosen by what the watch recorded (activityType, falling back to displayName), not by which plan slot the activity filled.
- One shared iterator per week returns each real activity exactly once. Every load total uses it.
- No state migration is needed. Classification happens when the numbers are computed.

## 2. The invariant

For any week and any signal (weekly A, weekly B, daily B for strain/ACWR, per-sport breakdown, sleep daily load):

1. Each completed activity contributes exactly once. The key is `garminId` for synced activities, or the adhoc `id` for in-app GPS or manual entries.
2. `unspentLoadItems` contribute **0** for every reason (`overflow`, `surplus_run`, `unmatched`). They only point at activities, or parts of activities, that are already counted.
3. `computeWeekTSS(wk) ≤ computeWeekRawTSS(wk)` for every week, because runSpec ≤ 1.
4. Emptying `unspentLoadItems` does not change A or B.

## 3. Current state, function by function

| Function | Double count? | Other issue |
|---|---|---|
| `computeWeekTSS` `fitness-model.ts:308-395` | **Yes**: unspent loop has no dedup (`:382`) | **Bypass**: garminActuals counted with no runSpec (`:324-338`). Actuals branch ignores `norm` (`:332`); no numeric effect today, since no caller passes it. |
| `computeWeekRawTSS` `:408-479` | No: dedup at `:470` | Orphan unspent items count (`:466-476`) |
| `computeTodaySignalBTSS` `:492-570` | No: dedup at `:557`; surplus never matches because its `date` is a full ISO string | Orphans with `date === today` count (`:555-561`) |
| `getDailyLoadHistory` `:994-1105` | No: uses `computeTodaySignalBTSS` plus its own dedup | Inherits orphans |
| `computeLoadBreakdown` `src/ui/home-view.ts:148-257` | **Yes**: surplus counted on top of the full run (`:236-252`, audit B20: Running 216 vs headline 133) | Orphans count. Can't be unit-tested: importing home-view in node fails (`supabaseUrl is required`, then `window is not defined`). |
| `buildDailySignalBTSS` `sleep-insights.ts:350-378` | **Yes**: twin plus adhoc (probe: 120 vs 60) | Actuals without iTRIMP count 0 |
| `updateLoadChart` `main-view.ts:1551` | **Yes, three times**: `:1668-1689` plus the adhoc loop | Legacy view |
| `buildDayTSSMap` `src/cross-training/timing-check.ts:115-133` | No: max per day, not a sum | none |
| `activitiesForDate` `src/ui/strain-view.ts:91-125` | No: global dedup | none |
| `computeWeightedRunSpec` `src/ui/excess-load-card.ts:218-251` | No | Its own run heuristic: a walk in a run slot has a pace, so it is treated as a run (1.0) |
| `computeCrossTrainTSSPerMin` `fitness-model.ts:723-765` | No | Same heuristic, copied |

**Where the twins come from.** Every synced non-run path writes one:
- `src/calculations/activity-matcher.ts:498` (stale pending), `:555` (enrich), `:694` (past week), `:1140` (`addAdhocWorkoutFromPending`)
- Slot matches with no adhoc entry: `src/ui/activity-review.ts:1054`, `:1096`, `:1154`, `:1635`, `:1682`, `:1721`

## 4. Design

### 4a. Unspent items are never load

Every unspent item is backed by an activity that is already counted:

- **`overflow`**: created by `populateUnspentLoadItems` (`activity-review.ts:708-731`), always together with `addAdhocWorkoutFromPending` (`:1754-1760`, and the matching-screen path via `updatedChoices = 'log'`, `:350` and `:583`). That call writes the adhoc entry and the twin.
- **`surplus_run`** (`activity-matcher.ts:810-828`, `activity-review.ts:995-1010`): a slice of a run already counted in full in `garminActuals[slotId]`. Its id is `<id>_surplus`, so garminId dedup can never catch it. The reason-based skip was the only guard, and `computeLoadBreakdown` lacks it.
- **`unmatched`**: declared in the type (`src/types/state.ts:246`) but never created.

So no reason needs its own handling in load functions. The rule is simply "never count". The distinction only matters on decision surfaces (e.g. `main-view.ts:2362` filters surplus when naming the cross-training cause). This also matches what already happens to past weeks: at week advance, `persistence.ts:370-390` and `events.ts:1085` move or clear the items. Today that makes a week's Signal A drop after the fact. After the fix it doesn't move.

### 4b. Classifier: runSpec comes from the activity, not the slot

Create a new pure module, `src/calculations/activity-types.ts`, with no `@/state` or `@/ui` imports. `fitness-model` cannot import `activity-matcher`, because that imports `@/state` and `@/ui/renderer` (`activity-matcher.ts:6,13`).
- Move `mapGarminType` (`activity-matcher.ts:40-111`, currently private; export it), `formatActivityType` (`:919-995`) and `mapAppTypeToSport` (`:998-1007`) into the new module.
- Re-export them from activity-matcher so existing imports keep working.

```ts
export interface SportClass { isRun: boolean; sport: SportKey | null; via: 'activityType'|'displayName'|'workoutName'|'adhoc'|'slot'|'legacy-default' }

const DEFAULT_CROSS_RUNSPEC = 0.35;                        // existing fallback, fitness-model.ts:359/:390
const NON_RUN_WORKOUT_TYPES = new Set(['cross','gym','strength','rest']); // fitness-model.ts:350
const SLOT_ID_RE = /^W\d+-([a-z_]+)-\d+$/;                  // generator.ts:241 `W${wk}-${typeKey}-${idx}`
const LABEL_TO_TYPE = /* built once from the moved label table; first entry wins */;
const labelToActivityType = (l: string) => { const c = l.replace(/ \((Garmin|Strava)\)$/, '');
  return LABEL_TO_TYPE[c] ?? c.toUpperCase().replace(/[\s-]+/g, '_'); };

export function classifyActivityType(t: string): Omit<SportClass,'via'> {
  const T = t.toUpperCase(); const app = mapGarminType(T);
  if (app === 'run') return { isRun: true, sport: 'extra_run' };
  const byLabel = normalizeSport(formatActivityType(T));          // Tennis, Yoga, Hike, Rowing, Elliptical…
  if (byLabel in SPORTS_DB) return { isRun: false, sport: byLabel };
  const byBucket = normalizeSport(mapAppTypeToSport(app));        // ride→cycling, walk→walking, gym→strength, other→generic_sport
  return { isRun: false, sport: byBucket in SPORTS_DB ? byBucket : null };
}
export function classifyAdhoc(w: Workout): SportClass {
  if (!NON_RUN_WORKOUT_TYPES.has(w.t ?? 'cross')) return { isRun: true, sport: 'extra_run', via: 'adhoc' };
  return { ...classifyActivityType(labelToActivityType(w.n ?? '')), via: 'adhoc' };
}
export function classifyActual(key: string, a: GarminActual, wk?: Week): SportClass {
  if (a.activityType) return { ...classifyActivityType(a.activityType), via: 'activityType' };            // R1
  if (a.displayName && !a.workoutName)                                                                    // R2: cross/gym slot fills, incl. walk→run slot
    return { ...classifyActivityType(labelToActivityType(a.displayName)), via: 'displayName' };
  if (a.workoutName) return { isRun: true, sport: 'extra_run', via: 'workoutName' };                      // R3: every run-match site sets it
  const adhoc = key.startsWith('garmin-') ? wk?.adhocWorkouts?.find(w => w.id === key) : undefined;       // R4
  if (adhoc) return classifyAdhoc(adhoc);
  const slot = key.match(SLOT_ID_RE)?.[1];                                                                // R5
  if (slot === 'gym')   return { isRun: false, sport: 'strength', via: 'slot' };                          // existing gym→strength (plan-view.ts:204)
  if (slot === 'cross') return { isRun: false, sport: 'generic_sport', via: 'slot' };
  return { isRun: true, sport: 'extra_run', via: 'legacy-default' };                                      // R6: keeps today's 1.0
}
export const signalARunSpec = (c: SportClass) =>
  c.isRun ? SPORTS_DB.extra_run.runSpec : (c.sport ? SPORTS_DB[c.sport].runSpec : DEFAULT_CROSS_RUNSPEC);
```

**Why these rules hold for the data that exists:**
- Run-match sites always set `workoutName` and `activityType`: `activity-matcher.ts:786`, `activity-review.ts:953`, `:1587`.
- Cross and gym slot fills always set `displayName` and never `workoutName`.
- All four twin writers set `activityType`.
- The matcher has had `workoutName` and `displayName` since its first commit (a2e3941, 2026-03-05). `activityType` on matcher runs arrived with ea47286 (2026-03-19). So R6 should be practically unreachable.

**Self-healing.** Strava sync adds `activityType` to slot actuals that lack it (`src/data/stravaSync.ts:99-101`), and the enrich pass creates twins (`activity-matcher.ts:548-573`). Both run within the 28-day window, so most recent entries end up on R1.

**Walk in a run slot.** R2 or R1 gives walking (0.30), hiking (0.45) or rowing (0.35). The slot does not matter.

**Gym slots.**
- 'Strength' resolves to strength (0.35).
- 'HIIT' is not a SPORTS_DB key, so it falls to the gym bucket, which is strength (0.35).

**Classifier output (probe), all runSpecs from `SPORTS_DB`:**
- RUNNING → 1.0
- Cycling types (CYCLING, INDOOR_CYCLING, MOUNTAIN_BIKING) → 0.55
- WALKING → 0.30, HIKING → 0.45, KAYAKING / GOLF → 0.30 (walking bucket)
- STRENGTH_TRAINING / HIIT → 0.35
- YOGA → 0.10, TENNIS → 0.50, SWIMMING → 0.20
- ELLIPTICAL → 0.65, STAIR_CLIMBING → 0.55
- CARDIO / INDOOR_CARDIO → 0.40, ROCK_CLIMBING → 0.15
- NORDIC_SKIING / ALPINE_SKIING → 0.40 (generic_sport; see decisions)
- ULTRA_RUN → 0.40 (see decisions)

### 4c. Shared iterator (the structural guarantee)

Add this to `fitness-model.ts` or the new module:

```ts
export interface WeekActivity { key: string; garminId: string|null; actual?: GarminActual; adhoc?: Workout; startTime: string|null; cls: SportClass }
/** Every real completed activity in the week, once. garminActuals win over adhoc twins.
 *  unspentLoadItems are never returned. */
export function listWeekActivities(wk: Week): WeekActivity[] {
  const out: WeekActivity[] = []; const seen = new Set<string>();
  for (const [key, a] of Object.entries(wk.garminActuals ?? {})) {
    if (a.garminId) { if (seen.has(a.garminId)) continue; seen.add(a.garminId); }
    out.push({ key, garminId: a.garminId ?? null, actual: a, startTime: a.startTime ?? null, cls: classifyActual(key, a, wk) });
  }
  for (const w of wk.adhocWorkouts ?? []) {
    if (w.id?.startsWith('holiday-') || w.id?.startsWith('adhoc-')) continue;       // existing skip, fitness-model.ts:441
    const gid = (w.id?.startsWith('garmin-') ? w.id.slice(7) : null) ?? (w as any).garminId ?? null;
    if (gid) { if (seen.has(gid)) continue; seen.add(gid); }
    out.push({ key: w.id ?? w.n, garminId: gid, adhoc: w, startTime: (w as any).garminTimestamp ?? null, cls: classifyAdhoc(w) });
  }
  return out;
}
```

Each consumer keeps its **current** TSS formula in this pass: rated-RPE vs RPE-5 fallback, the 15000 vs athlete normaliser, and duration parsing. Only which activities are counted, and the runSpec, change. Unifying the formulas belongs to audit B14 and the normaliser-mismatch finding. Keeping them separate means those numbers don't move in this change.

### 4d. Changes per function

1. **`computeWeekTSS`**: loop over `listWeekActivities`.
   - Actuals: `raw × signalARunSpec(cls)`.
   - Adhoc entries: only `garmin-` ids, which keeps today's Signal A scope; see B9 below. Apply `signalARunSpec(classifyAdhoc(w))`.
   - Delete the unspent loop (`:370-392`) and the date-window code.
   - Pass `norm` in the actuals branch too.
2. **`computeWeekRawTSS`**: use the iterator. Delete `:457-476`.
3. **`computeTodaySignalBTSS`**: use the iterator with the existing date rules (`startTime`, `garminTimestamp`, and `dayOfWeek` for non-garmin adhoc). Delete `:554-561`.
4. **`getDailyLoadHistory`**: build `activities` from the same iterator, so it can no longer disagree with its own `tss`. The name/duration fuzzy dedup at `:1067` can go.
5. **`computeLoadBreakdown`**:
   - Move it to a pure module such as `src/calculations/load-breakdown.ts`, re-exported from home-view, so it can be tested.
   - Use the iterator and delete `:228-252`. This fixes B20 and orphans.
6. **`buildDailySignalBTSS`**: iterate `listWeekActivities` per week. Keep its per-entry formula, but once an activity has been visited, don't let its twin count again.
7. **`updateLoadChart`** (`main-view.ts`):
   - Delete the unspent loops at `:1636-1641` and `:1685-1689`.
   - Replace the run/cross split (`:1664-1705`) with iterator plus `cls.isRun` plus `signalARunSpec`.
8. **Optional, same classifier:** `computeWeightedRunSpec` (`excess-load-card.ts:218-251`), `computeCrossTrainTSSPerMin` (`:723-765`), and the four copies of the run-km heuristic:
   - `home-view.ts:76-85`
   - `persistence.ts:302-306`
   - `stats-view.ts:212-221`
   - `main-view.ts:2349-2356`

### 4e. Write-site hygiene

Add `activityType: item.activityType` to `activity-review.ts:1054`, `:1096`, `:1154`, `:1635`, `:1682` and `:1721`, so new entries hit R1. `:1096` also lacks `startTime`, `iTrimp` and `hrZones`: that is the D3 daily-load hole for Garmin and Apple users.

Adding `iTrimp` at `:1096`, `:1154`, `:1587`, `:1635`, `:1682` and `:1721` switches new activities from an RPE estimate to HR-based load. That is a magnitude change, so I'd do it separately.

### 4f. Cleaning up stale records (decision surfaces, not totals)

- **`removeGarminActivity`** (`events.ts:2436`): drop unspent items with garminId `id` or `id_surplus`.
- **Unmark**: `unrateWorkout` (`src/ui/renderer.ts:96`) and plan-view (`:2518-2533`) should drop `id_surplus`.
- **Re-review undo** (`activity-review.ts:235-237`): also drop `${id}_surplus` and delete the stale `garminActuals['garmin-'+id]` twin.
- **Surplus writers** (`activity-matcher.ts:827`, `activity-review.ts:1009`): append only if the garminId is not already present. This fixes B19: the "228 TSS from 3 extra activities" modal.
- **`mapAppTypeToSport('run')`** returns `'run'`, which is not a SportKey. The modal therefore sizes an unmatched-run overflow as `generic` 0.35. Map it to `'extra_run'`: an existing key, not a new number.

### 4g. Mixed-signal consumers that must change in the same PR

The bypass accidentally hid these. Fixing Signal A exposes them. Probe: 300 run + 2 × 100 ride per week, 8 weeks.

- **Home momentum** (`home-view.ts:710-721`, shown at `:936` and `:1229`):
  - `ctlHistory[0]` is Signal B (same-signal, through the last completed week). `ctlHistory[1]` is Signal A for **the same week**, and the gap between them is weighted ×4.
  - Momentum score 146 → 360 (threshold 7.5). Heavy cross-trainer: 220 → 540. The label reads "Building" permanently.
  - It is already wrong today, and gets worse after the fix.
- **Daily coach `ctlTrend`** (`src/calculations/daily-coach.ts:199-205`): same B-vs-A comparison.
- **Stats Injury Risk sparkline** (`src/ui/stats-view.ts:2279`) plots Signal B ATL / Signal A CTL, while the headline above it is rolling Signal B / Signal B.
  - Steady state goes from 1.05 to 1.22.
  - Heavy cross-trainer (150 run + 3 × 100 ride): 1.09 → **1.43, orange**, while the headline says Safe. That is a false high injury-risk signal: switch the sparkline to a per-week same-signal series (a series version of `computeSameSignalTSB`).
- **Stats Freshness sparkline** (`stats-view.ts:2137`): Signal A CTL minus Signal B ATL, which goes more negative (TSB/7 moves from -3.4 to -12.9). Switch it to same-signal as well.

## 5. Tests to add (none exist today)

**`src/calculations/activity-types.test.ts`:**
- `classifyActivityType` table for the types listed in 4b. Assert against `SPORTS_DB[x].runSpec`; don't hardcode the numbers.
- One fixture per rule R1 to R6:
  - Walk in `W1-easy-0` with only `displayName: 'Walk'` → walking. The same entry after heal (`activityType: 'WALKING'`) → walking.
  - Gym slot 'HIIT' → strength.
  - Run slot with only `workoutName` → run.
  - `garmin-X` key with no activityType → falls through to the adhoc entry.
  - Empty `W1-long-0` → run.

**`src/calculations/fitness-model.test.ts`**, new block "one activity counted once per signal", using fixtures shaped like the real write sites:
1. **Overflow ride** (twin + adhoc + unspent, iTRIMP 9000): A = 33 (60 × `SPORTS_DB.cycling.runSpec`, rounded), B = 60, daily B = 60. **A and B are identical with `unspentLoadItems = []`.** This is the "not counted twice" regression test.
2. **Orphan unspent item only**: A = 0, B = 0, daily B = 0.
3. **Surplus run** (20 km run, iTRIMP 20000): A = B = 133 with 0, 1 or 3 surplus items.
4. **Unmatched-run overflow** (unspent `sport: 'run'`): A = B = 50. Today A is 68.
5. **Tennis cross slot**, `displayName` only, RPE 5: B = 69, A = 35 (69 × `SPORTS_DB.tennis.runSpec`, rounded).
6. **Walk in run slot**, RPE 3: B = 39, A = 12.
7. **Matched run**: A = B.
8. **Twinless legacy adhoc** 'Cycling': A = 33, B = 60.
9. **Adhoc listed before its twin**: counted once.
10. **Two garminActuals entries with the same garminId** (stale twin plus slot entry after re-review): counted once.
11. **Property test** over a mix of the above:
    - A ≤ B.
    - Removing unspent items changes nothing.
    - With iTRIMP-bearing fixtures, Σ over the 7 days of `computeTodaySignalBTSS` = weekly B.
12. **`computeFitnessModel`** over 8 weeks of 300 run + 2 × 100 ride: `actualTSS` 410, `rawTSS` 500 (today 500 / 500).

**Other tests:**
- **`sleep-insights.test.ts`**: overflow ride day = 60, not 120. A past-week auto-logged run (adhoc without iTRIMP plus twin with iTRIMP) = twin value only.
- **`getDailyLoadHistory`** (fake timers): each garminId appears once, and the `tss` of each entry is the sum of its activities.
- **`load-breakdown.test.ts`** (after the extraction): surplus and orphan add 0, and the segments sum to `computeWeekRawTSS`.
- **Momentum / sparkline helpers** (once pure): a steady cross-trainer reads "Stable" and a ratio of about 1.0.

## 6. User-facing numbers that will change

Past weeks recompute on the first render after the update. The CTL history will shift once for anyone with synced cross-training.

| Where | Change (probe) |
|---|---|
| Stats Running Fitness: CTL line, CTL card band (`:2929`), CTL page (`:1851`), fitness detail (`:1776`) | Drops for cross-trainers. CTL/7 68.0 → 58.6. Heavy cross-trainer 59.2 → 45.0, which drops one band (Well-Trained → Trained). |
| Week debrief "Running fitness" value and delta (`src/ui/week-debrief.ts:110-116`) | Lower for cross-trainers. |
| Coach `tssPct` (`daily-coach.ts:261-273`) | e.g. 122% → 100% of plan. The planned side is edge-computed Signal A with runSpec, so the two sides now agree. |
| Home momentum, coach `ctlTrend`, Stats sparklines | Wrong direction unless 4g ships with this change (see above). |
| Signal A of individual sessions | Overflow ride 98 → 33. Tennis slot 69 → 35. Walk in run slot 39 → 12. HIIT gym slot 65 → 23. Runs unchanged. |
| Orphans (× removed, item left behind) | Disappear from weekly B, plan bar, excess, ATL, same-signal TSB, strain and rolling ACWR (−1.15 × minutes each). |
| Load & Taper per-sport breakdown | Running row loses its surplus (216 → 133). Stacked bar matches the headline. |
| Sleep target / debt | Daily load halves on days with adhoc-logged activities (120 → 60). |
| Legacy load chart (`main-view`) | Triple count removed. |
| Weekly Signal A history | No longer drops retroactively at week advance. |

**Unchanged:** rolling ACWR and the injury-risk headline for normal activities, readiness, freshness headline, Signal B plan bar and excess detection (apart from orphans), VDOT, race predictions, athlete tier.

## 7. Decisions for Tristan

Everything below uses only existing tables. These are mapping choices, not new constants.

1. **HIIT** maps to strength (0.35) in the client. The edge function and PRINCIPLES.md say 0.30. Keep 0.35, or add an alias?
2. **Skiing types** (NORDIC_SKIING, BACKCOUNTRY_SKIING, ALPINE_SKIING) and DANCE, SQUASH, BADMINTON miss `SPORTS_DB` and fall to generic_sport (0.40). Add aliases to the existing skiing / dancing / tennis keys?
3. **Garmin run subtypes** (ULTRA_RUN, STREET_RUNNING, INDOOR_RUNNING, OBSTACLE_RUN; audit C10): add them to the `mapGarminType` run case. Otherwise they drop from 1.0 to 0.40 in Signal A for Garmin-webhook users.
4. **WHEELCHAIR_PUSH_RUN**: `mapGarminType` calls it a walk, while the `includes('RUN')` heuristics call it a run. Which is right?
5. **Unresolvable cross-training fallback**: 0.35 (`computeWeekTSS`) or 0.40 (`plan-view.ts:208`, `main-view.ts:1594`)? Pick one.
6. **R6 (unidentifiable legacy entry)**: I recommend 1.0, which matches today's behaviour.
7. **Momentum / ctlTrend**: all Signal A (my recommendation, since it describes fitness direction) or all Signal B?

## 8. Adjacent issues this fix does not change

- **B9**: GPS and "Mark as done" runs count 0 in Signal A.
- **B8**: benchmark phantom load.
- **D3**: walk-type activities still *complete* run slots and add km. Only their load is fixed here.
- **D1**: pending items count 0 until reviewed.
- **C5**: UTC vs local week boundaries.
- **B18**: `wk.actualTSS` stays add-only and mixed. It is still read first at `events.ts:1023` and `holiday-modal.ts:388` / `:919`.
- **runspec-duplication**: the edge `getRunSpec` table and `SPORTS_DB` still disagree, so a smaller CTL step at plan start remains.

## 9. Docs to update with the code

- **`docs/SCIENCE_LOG.md`** ("Signal A vs Signal B"):
  - The once-per-signal invariant.
  - runSpec comes from the recorded activity, not the slot.
  - Unspent items are not load.
  - Limitations: the table mismatch and the label/bucket fallbacks.
- **`docs/FEATURES.md`**:
  - The line near `:628` still says unspent items count with runSpec; correct it.
  - Tests ⚠️ → ✅ once the tests land.
- **`docs/ARCHITECTURE.md`**: the new module and `listWeekActivities`.
- **`docs/CHANGELOG.md`**: add the entry.
- **`docs/OPEN_ISSUES.md`**: open a new issue. It stays unfixed until you've confirmed it on device.

The probe test (`src/calculations/zz_probe_sigA_7db4.test.ts`) is deleted, and no other file was changed. `src/calculations/zz_probe_acwr_cov7731.test.ts` is another session's probe; I left it alone.
# 5. Overflow double count and Signal A: adversarial review
**VERDICT: sound with changes**

Both bugs are real and I reproduced them. The core of the design is right: unspent items stop counting as load, one iterator per week, a pure classifier module, and the mixed-signal consumers ship in the same PR. Twelve changes are needed before it ships. Three of them are regressions the design as written would cause (R1, R2, R3). R4 is an overflow double count the design sets aside, even though Tristan asked for exactly this.

I ran a probe test at `src/calculations/zz_probe_ovrv_5c21.test.ts`. It is deleted and `git status` is clean. No other file was touched.

Probe, 60‑min overflow ride stored as twin + adhoc + unspent:

| Case | Signal A | Weekly Signal B | Sleep daily (`buildDailySignalBTSS`) | `computeTodaySignalBTSS` |
|---|---|---|---|---|
| With HR (iTRIMP 9000) | 98 | 60 | 120 | 60 |
| No HR | 107 | 69 | 69 (from the adhoc only) | n/a |
| No HR, twin only (what the design's iterator would pass on) | n/a | n/a | **0** | n/a |

### What is correct and should be kept
- The overflow double count at `fitness-model.ts:382-392` (no garminId dedup) and the runSpec bypass at `:324-338` are confirmed.
- The sleep double count at `sleep-insights.ts:350-378` is confirmed: `seenGarminIds` is only created after the garminActuals loop.
- The surplus row in `computeLoadBreakdown` is confirmed: `home-view.ts:236-252` has no `reason` skip, and the `_surplus` id can never dedup.
- The triple count in `updateLoadChart` is confirmed.
- Orphans left by × remove (`events.ts:2436-2490`) are confirmed.
- "Unspent items are never load" and invariant 4 (emptying them changes nothing) are the right rule.
- `fitness-model` must not import `activity-matcher`, which pulls in `@/state` and `@/ui/renderer` (`activity-matcher.ts:6,13`). A pure `activity-types.ts` with re-exports is right.
- §4g is correct and essential. Momentum (`home-view.ts:710-722`), coach `ctlTrend` (`daily-coach.ts:199-206`), and the Stats ACWR and TSB sparklines (`stats-view.ts:2279-2287`, `:2137-2146`) all mix Signal B with Signal A. Fixing Signal A alone would create a false high injury-risk sparkline.
- The write-site facts check out:
  - Run matches set `workoutName` and `activityType` (`activity-matcher.ts:778-783`, `activity-review.ts:966-967`, `:1598-1599`).
  - All four twin writers set `activityType` (`:510`, `:568`, `:706`, `:1151`).
  - Cross and gym fills set `displayName` and never `workoutName`.
- No constants are invented. Every runSpec comes from `SPORTS_DB`, and the fallbacks are raised as decisions.
- Line citations are accurate apart from small nits: the `computeWeekRawTSS` dedup is at `:472-475`, not `:470`.

### Required changes

1. **The sleep daily load would drop to 0 for activities without HR.**
   - In the design's iterator the twin wins, and `buildDailySignalBTSS` scores an actual with no iTRIMP as 0 (`sleep-insights.ts:357-360`). The adhoc, which today supplies `garminDurationMin × TL_PER_MIN[rpe]` (69 in the probe), is then skipped.
   - This hits every Apple Watch user (HR is not read) and Strava activities with no HR stream.
   - Fix: when a twin and an adhoc share a garminId, `WeekActivity` should carry both (`actual` and `adhoc`). Consumers then use `actual.iTrimp ?? adhoc.iTrimp` and fall back to the adhoc RPE estimate. Add a test: twin without iTRIMP plus adhoc with RPE gives the adhoc value, not 0.

2. **`LABEL_TO_TYPE` "first entry wins" gives different runSpecs depending on which rule fires.** A round-trip probe over every label key and every `mapGarminType` case found:
   - `MOUNTAIN_BIKING`: R1 gives cycling 0.55. The label "Mountain Bike" maps back to `MOUNTAINBIKERIDE`, which gives generic 0.40.
   - `PADDLEBOARDING`: R1 gives walking 0.30. "Paddleboard" maps back to `STANDUPPADDLING`, which gives generic 0.40.
   - `HIGHINTENSITYINTERVALTRAINING`: R1 gives generic 0.40, the label gives strength 0.35.

   Strava's heal adds `activityType` later (`stravaSync.ts:99-101`), moving an entry from R2 to R1. A past week's Signal A would then change on a later sync.
   - Fix: build the reverse map preferring keys that `mapGarminType` explicitly recognises.
   - Add a property test: for every key K, `classifyActivityType(K) === classifyActivityType(labelToActivityType(formatActivityType(K)))`.

3. **R1 overrides R3 even when the type string is unknown.** `RUN`, `ULTRA_RUN`, `INDOOR_RUNNING`, `STREET_RUNNING`, `UNKNOWN` and `WORKOUT` all classify as generic_sport 0.40 (probe). That happens even when `workoutName` proves the activity filled a run slot, for example a user placing it on a run slot in the matching screen, written at `:1096`.
   - Fix: apply R1 only when `mapGarminType` has an explicit case for the type, or when the label is in `SPORTS_DB`. Otherwise fall through to R2 and R3.
   - Decision 3 (run subtypes) is a blocker, not optional. Adding those subtypes to `mapGarminType` also changes matcher routing: they would auto-match run slots instead of queueing as cross-training. That behaviour change needs its own sign-off.

4. **Overflow is still counted twice in `wk.actualTSS`, and the design defers it as "B18".**
   - `addAdhocWorkoutFromPending` adds raw TSS (`activity-matcher.ts:1163`).
   - The modal decision then adds runSpec TSS again (`activity-review.ts:1904`, and `:1296` after `:1281`).
   - This is read first at `holiday-modal.ts:388` and `:919` (post-holiday activity level) and `events.ts:1023` (`carriedTSS`). It is also read at `main-view.ts:1921` and `:2004`, and `sleep-view.ts:221`.
   - Tristan explicitly asked that overflow not be counted twice. Either switch these reads to `computeWeekTSS` / `computeWeekRawTSS` in this PR, or get his explicit deferral.

5. **Drop §4f's `mapAppTypeToSport('run') → 'extra_run'` from this PR.** It is not only relabelling:
   - It feeds `buildCombinedActivity` (`activity-review.ts:1929`), which calls `createActivity('extra_run')` and enters the cross-training matcher's extra_run replace path (`cross-training/matcher.ts:76`, `:168`).
   - It also feeds `applyAdjustments` (`:1253`, `:1866`), the excess card's `sport` (`excess-load-card.ts:285`) and `recordLegLoad`.
   - That changes cut sizing, which is the separate cut-sizing area. Coordinate it there.

6. **The weekly-EMA fallback in `computeACWR` still mixes signals (`fitness-model.ts:1185-1194`).** When `signalBSeed == null` it divides Signal B ATL by Signal A CTL. Lowering Signal A raises that ratio, which is a false high injury risk.
   - It is reachable only when `planStartDate` is missing (`:1152`).
   - Switch it to `computeSameSignalTSB(ctlSeed)`, and qualify §6's "rolling ACWR unchanged".

7. **Momentum and `ctlTrend`: correct the diagnosis and pin down the window.**
   - `ctlHistory[1]` is `metrics[len-5]`, not "the same week". The weighted score telescopes to 4·h0 − (h1+h2+h3+h4), so the "4/3/2/1 newest-first" comment at `:713` and `:718` does not describe what is computed.
   - Home uses completed weeks for Signal B (`:708`), but the coach uses `s.w`, which includes the partial current week (`daily-coach.ts:199`). For "all Signal A", use completed weeks for both. Otherwise readings drop every Monday.
   - Decision 7 must mention B9: all-Signal-A momentum ignores GPS and manual runs, so GPS-only users would read "Declining".
   - Extract momentum and the sparkline series as pure functions and test them now, not "once pure".

8. **§4e has side effects the design doesn't list.**
   - Adding `activityType` at the write sites flips the run-km heuristics: `home-view.ts:79-85`, `stats-view.ts:215-217`, `persistence.ts:303-306` and `excess-load-card.ts:233`. A walk in a run slot stops counting as running km for new Garmin entries, which contradicts "D3 unchanged". List it in §6 and §8.
   - Adding iTRIMP at `:1096` is not a separate magnitude change. The enrich pass already writes it on the next sync (`activity-matcher.ts:578`).

9. **Pass `norm` to both Signal A and Signal B actuals, or to neither.** Changing only A breaks A ≤ B as soon as a caller passes `norm`.

10. **"Every unspent item is backed by a counted activity" is not guaranteed for older saved state.**
    - Before 45d18ea (2026-04-08), the auto-process Tier‑1 silent-reduce path and the no-modal path created unspent items without an adhoc entry.
    - The stale-pending resolver (bd8d6f8, 2026-04-14; `activity-matcher.ts:432-525`) only repairs items still in `garminPending` with `__pending__`.
    - Add a one-off diagnostic before claiming "no migration": count unspent overflow items that have no actual or adhoc but whose `garminMatched` entry still exists.
    - Also note a first-load side effect. `persistence.ts:368-375` wipes all of `currWk.unspentLoadItems` when `prevExcess <= 0`. Removing orphans can make `prevExcess` fall to 0 or below.

11. **Complete the list of consumers.**
    - Add the plan-level breakdown sheet (`home-view.ts:263-283`, aggregating `computeLoadBreakdown`) to §6.
    - The aero/anaero loop in `updateLoadChart` (`main-view.ts:1604-1641`) also counts twins raw against a runSpec-weighted plan. Put it on the iterator too, not only the run/cross split.
    - `computeLoadBreakdown` needs `sportColor` moved with it or injected.

12. **Tests to add or tighten.**
    - The regressions in 1 and 3, and the round-trip test in 2.
    - The ACWR fallback in 6.
    - The Σ-daily = weekly-B property test must use fixtures that have both `startTime` and iTRIMP, and must say that `:1096` entries break it in production until healed.

### Optional improvements
- **Sparkline and headline from one model.** Build the Stats ACWR sparkline from `computeRollingLoadRatio` with an `asOf` date parameter, rather than a weekly same-signal EMA. Its last point would then equal the headline.
- **Decision 5 is effectively already decided.** In the sketched classifier, `DEFAULT_CROSS_RUNSPEC` (0.35) is unreachable, because the `other` bucket always resolves to generic_sport (0.40). Unresolvable names therefore move from today's 0.35 (`fitness-model.ts:359`) to 0.40. Also add the R5 mapping of a cross slot to generic_sport to the decisions list.
- **Apple interaction.** `appleHealthSync.ts` `mapWorkoutType` defaults every unmapped workout to `WALKING` (`:84`), so R1 would put all of them at walking 0.30. Fix that mapping first or together.
- **Global dedup in sleep load.** `buildDailySignalBTSS` sums by date across all weeks. Use one seen-set across weeks.
- **Small cleanups.**
  - Use `w.rpe ?? w.r ?? 5` in Signal A to match Signal B.
  - Delete the unused `ctlFourWeeksAgo` at `stats-view.ts:707`.
  - Update `computeFitnessModel`'s `planStartDate` doc (`:1244`).
  - `wk.unspentLoad` feeds a VDOT bonus only in `cross-training/matcher.ts:408`, which is dead code. VDOT really is unaffected.
# 6. False high injury risk (ACWR): design
## ACWR false "high" injury risk: diagnosis and fix

## Summary

- **Root cause confirmed.** `computeRollingLoadRatio` (`src/calculations/fitness-model.ts:931-967`) fills pre-plan days with `signalBSeed/7`, which is 0 when `s.signalBBaseline` is undefined (:940). From plan day 14 the 14-day guard (:944) no longer applies, and chronic is still `28-day sum / 4` (:965). A steady load then reads 1.56 to 2.0, labelled 'high', on days 14 to 17.
- **Recommended fix.** Days before the plan with no data are no longer counted as rest. They get the athlete's own average daily load from the days of the 28-day window that are more than 7 days back and fall inside the plan. This adds no new constants, and seeded users see no change (identical to machine precision in a probe over 60 days). A steady load now reads 1.0, and a real doubling reads 1.60 'high', the same as a correct seed would give.
- **The same zero-seed problem is elsewhere too, and the core fix does not cover it:**
  - the injury-risk weekly trend chart (4.1, 3.1, 2.4, 2.0 for steady training)
  - the stats ACWR trend chart
  - the rolling-load view, which passes the wrong seed
  - freshness (TSB) in readiness, which holds readiness near 30, labelled 'Ease Back', for weeks

Probe file created and deleted. No repo files modified; the working tree is clean.

---

## 1. Who actually lacks `s.signalBBaseline`

`signalBBaseline` is written in only one place: `fetchStravaHistory` (`src/data/stravaSync.ts:264-277`). It is set to the median of completed weeks with `rawTSS > 0`, otherwise `undefined`.

| Cohort | Seeded by plan day 14? | Evidence |
|---|---|---|
| New user via wizard (Strava is mandatory since 598ff5f, 2026-04-09) | **Usually, but not at onboarding.** The wizard fetch reads an empty `garmin_activities` table. The seed arrives at the first cold launch after onboarding. | Continue is disabled until Strava connects (`wizard/steps/fitness.ts:26-30,129-131`). The OAuth callback only redirects, with no backfill (`strava-auth-callback/index.ts:124`). On the OAuth return, `stravaConnected` is set asynchronously (`main.ts:369-371`), so the synchronous checks at `main.ts:397` and `:487` both skip sync and backfill. At the strava-history step, `fetchStravaHistory(8)` then returns `[]` (`stravaSync.ts:235`) and shows "Couldn't load history" (`strava-history.ts:88-110`). The next cold launch runs `backfillStravaHistory(16)` (`main.ts:486-489`), which calls `fetchStravaHistory(16)`. |
| Strava user with no activity in the 16 weeks before the plan | Only if a cold launch happens between day 7 and day 14. Backfill re-runs on every launch while history is under 8 weeks, so completed plan week 1 becomes the seed. | `main.ts:486`; `completedRows` includes in-plan weeks (`stravaSync.ts:250`) |
| Strava user whose backfill call fails on every launch before day 14 | **No.** On a throw, `fetchStravaHistory` is never called. | `stravaSync.ts:547-600` (catch) |
| iOS user whose WebView is never cold-started before day 14 | **No.** Same path as the rows above. | `main.ts:486-489` only runs at startup |
| Legacy Garmin-only, Apple-only or phone users (onboarded before 2026-04-09) | **Never.** No code path calls the history fetch for them. | Apple branch `main.ts:386-395`, Garmin-only branch `:451-480` |
| Simulator mode | Never | `fitness.ts:30`, `main.ts:28` |
| "I'll enter manually" at the history step | No effect: the seed was already written by the fetch | `strava-history.ts:208-218` |

Phone-only users mostly get 'unknown': rated workouts without device data are not counted by `computeTodaySignalBTSS` (:492-572), so chronic stays below 1.

## 2. Other seed sources, and how callers pass seeds

**Other seed sources: none usable without inventing numbers.**
- **`ctlBaseline`**: set in the same call (`stravaSync.ts:258-263`), so it covers the same users. It is also Signal A (running-equivalent), so it is the wrong signal, and it is an EMA started at 0. It is never above 0 when `signalBBaseline` is missing.
- **`historicWeeklyRawTSS`**: same source and same users. It is also undated: `weekStart` is dropped at `stravaSync.ts:252`, and weeks with no activity are omitted server-side (`sync-strava-activities/index.ts:483-491`).
- **Garmin `daily_metrics`**: holds resting_hr, max_hr, stress_avg, vo2max, steps and hrv only (`garmin-backfill/index.ts:185-193`). There is no load field. `garmin-backfill` pulls dailies and sleep, not activities (:1-11). Garmin activities land in `garmin_activities` only from connection onward (`garmin-webhook/index.ts:149`).
- **Onboarding inputs**: runs, gym sessions, sports per week and recurring activities (`wizard/steps/volume.ts:161-207`). There are no km or duration inputs. Converting these to TSS needs per-session constants that do not exist.
- **Plan week-1 planned TSS**: circular, because it assumes the athlete was already on the plan. It would also hide a real ramp, and B2 prices easy and long runs about 30% low.

**All 21 `computeACWR` / `computeRollingLoadRatio` call sites.** These all pass the same arguments: tier `s.athleteTierOverride ?? s.athleteTier`, `s.ctlBaseline ?? undefined`, `s.planStartDate`, atlSeed `(ctlBaseline??0)*(1+min(0.1*gs,0.3))`, and `s.signalBBaseline ?? undefined`. No caller passes `norm`. `ctlSeed` and `atlSeed` only matter in the weekly-EMA fallback.
- `events.ts:1096`: week advance, stamps `scheduledAcwrStatus` (the plan cut)
- `events.ts:1653`: passes `activityWeek` as currentWeek
- `events.ts:2523`: km nudge, fires only on 'safe'
- `renderer.ts:270`: the live status goes to the generator at :291, so there is a second, live plan-cut path
- `home-view.ts:704`, `:2063`
- `main-view.ts:1729`, `:1953`, `:2200`, `:2303`
- `activity-review.ts:1213`, `:1825` (modal escalation), `:1843`
- `excess-load-card.ts:351`, `:452`
- `gps/recording-handler.ts:172`
- `daily-coach.ts:198`
- `readiness-view.ts:80`
- `stats-view.ts:705`, `:2727`
- `injury-risk-view.ts:276`, plus `:279` which calls `computeRollingLoadRatio` directly

**Out of line: `rolling-load-view.ts:280-283` and `:487`.**
- They pass `atlSeed`, which is derived from Signal A times the gym factor, as `signalBSeed`.
- They use `s.athleteTier` without the override.
- `getDailyLoadHistory` at `:297` is also seeded with `atlSeed`.

Probe results: with `ctlBaseline` 180 and gs 2 this view reads 1.18 while the rest of the app reads 1.04. Without `ctlBaseline` the seed is 0, and it shows 2.0 'High' on day 14.

CHANGELOG 2026-04-16 says a `computeReadinessACWR(s)` helper centralises this call. It does not exist in `src`, and neither does `computeLiveSameSignalTSB`.

## 3. Options evaluated (probe numbers)

Setup: recreational tier (safe up to 1.35, caution up to 1.55). Weekly pattern Mon to Sun is 0/50/40/60/0/40/100 (290 per week), and 290 is the true pre-plan load.

| Scenario | Current, no seed | Average over days with data | **Fill from own earlier days (recommended)** | Correct seed |
|---|---|---|---|---|
| Steady, day 14 | **2.00 high** | 1.07 | 1.10 | 1.04 |
| Steady, day 17 | **1.59 high** | 1.02 | 1.02 | 1.01 |
| Steady, day 19 | 1.51 caution | 1.08 | 1.08 | 1.05 |
| Constant 60/day, days 14 to 17 | 1.87 / 1.75 / 1.65 / 1.56, all high | 1.00 | 1.00 | 1.00 |
| Week 3 at 1.5x, day 20 | 1.71 high | 1.29 | 1.33 | 1.33 |
| Week 3 at 2x, day 20 | 2.00 high | **1.50 caution (under-read)** | **1.60 high** | 1.60 high |
| Week 3 at 2x, day 18 | 2.00 high | 1.36 | 1.45 | 1.40 |
| Week 1 empty, day 14 | 4.00 | 2.14 | 4.00 | n/a |

- **Average over days with data.** Chronic is the mean over the in-plan days times 7. This is still the coupled ratio (this week is part of the 28-day average) over a shorter window, so this week makes up 7/n of chronic. Real spikes are compressed: the ratio can't exceed 2.0 at 14 days, and a 2x spike reads one band low. Lolli et al. (2019) describe this coupling effect.
- **Recommended: fill from the athlete's own earlier days.** Pre-plan days with no seed get the mean daily load of the days inside the plan that are more than 7 days back. This comes out as chronic = (A + 3B)/4, so ratio = 4U/(U+3), where A is this week's load, B the athlete's normal weekly load and U = A/B (this week against the athlete's normal week). In plain terms: it measures this week against the athlete's own observed baseline, then puts the result on the same 28-day scale the tier thresholds and seeded users already use. Windt & Gabbett (2019) show the two forms of the ratio map onto each other deterministically for fixed windows. With a correct seed it gives the same result, and with a seed or a full 28 days of data it matches the current output exactly.
- **Return 'unknown' until 28 days of data.** There are no false readings. But it loses the 2x-spike detection on days 18 to 26 for unseeded users. It also switches off the km floor in the cross-training suggester, which treats 'unknown' like an elevated reading (`suggester.ts:500-501`, `:714-715`).
- **Seed from another source.** Nothing usable (see section 2).

**How the rest of the app treats 'unknown' today:**
- `events.ts:1102-1112` clears the stamp; the km nudge needs 'safe' (:1118).
- `plan_engine.ts:323-324,347` only acts on caution or high.
- `renderer.ts:291` turns it into `undefined`.
- `daily-coach.ts:367` maps it to 'safe'.
- In readiness, ratio 0 gives the maximum safety score with no hard floor (`readiness.ts:305,363-369`).
- `activity-review.ts:1826` skips the blocking modal.

**Limitations of the recommended option.**
- On day 14 the baseline is only 8 days, so the mix of weekdays adds some noise (1.10 against a true 1.04).
- It assumes pre-plan load was similar to early-plan load.
- In-plan days with no recorded data still count as rest. B9 (GPS runs and manual completions don't count toward load) can therefore still produce a high reading if week 1 has gaps.
- The coupled-ratio caveat is unchanged.

## 4. Recommended code change

**`src/calculations/fitness-model.ts`: replace `computeRollingLoadRatio` (:924-967)**

```ts
/**
 * Rolling 7-day acute and 28-day chronic Signal B load. chronic = 28-day sum / 4 (weekly avg),
 * acute = last 7 days (inside the 28-day window: coupled ratio, Hulin 2014 / Gabbett 2016).
 * Pre-plan days: with a seed, signalBSeed / 7. Without a seed there is no data for them; they are
 * filled with the mean daily load of the observed days 8–28 back (the athlete's own baseline)
 * instead of 0. Equivalent to the uncoupled ratio mapped to the 28-day coupled scale, C = 4U/(U+3).
 * Returns null with no seed and < 14 days of plan data.
 * @param asOf evaluate the window ending on this date (trend charts)
 */
export function computeRollingLoadRatio(
  wks: Week[], planStartDate: string, signalBSeed?: number, norm?: number, asOf?: Date,
): { acute: number; chronic: number; coveredDays: number } | null {
  const now = asOf ? new Date(asOf) : new Date();
  now.setHours(12, 0, 0, 0);
  const planStart = new Date(planStartDate + 'T12:00:00');
  const seedDaily = signalBSeed != null && signalBSeed > 0 ? signalBSeed / 7 : 0;
  const hasSeed = seedDaily > 0;

  const daysSincePlanStart = Math.floor((now.getTime() - planStart.getTime()) / 86400000);
  if (daysSincePlanStart < 14 && !hasSeed) return null;

  // index 0 = 27 days ago; null = pre-plan day with no data (not a rest day)
  const daily: (number | null)[] = [];
  for (let daysAgo = 27; daysAgo >= 0; daysAgo--) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];
    const weekIdx = Math.floor(Math.floor((d.getTime() - planStart.getTime()) / 86400000) / 7);
    if (weekIdx < 0) daily.push(hasSeed ? seedDaily : null);
    else if (weekIdx >= wks.length) daily.push(seedDaily);           // post-plan: unchanged
    else daily.push(computeTodaySignalBTSS(wks[weekIdx], dateStr, null, norm));
  }

  const acute = daily.slice(-7).reduce<number>((a, v) => a + (v ?? 0), 0);
  const baseline = daily.slice(0, 21).filter((v): v is number => v != null);
  if (baseline.length === 0) return null;
  const baselineDaily = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const chronic = daily.reduce<number>((a, v) => a + (v ?? baselineDaily), 0) / 4;
  return { acute, chronic, coveredDays: daily.filter(v => v != null).length };
}
```

**`computeACWR` (:1152-1154).** Stop falling through to the weekly-EMA fallback. That fallback starts at 0 and gave 2.02 'high' on day 10 when `s.w = 5`:

```ts
    const rolling = computeRollingLoadRatio(wks, planStartDate, signalBSeed, norm);
    if (!rolling) return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };
```

Also correct the docstring. It says "requires at least 3 weeks", but the rolling path starts at 14 days.

**Same-change call-site fixes**
- `rolling-load-view.ts:280-283` and `:487`: use `s.athleteTierOverride ?? s.athleteTier`, and pass `s.signalBBaseline ?? undefined` as the 7th argument.
- `rolling-load-view.ts:297`: pass `s.signalBBaseline ?? undefined` to `getDailyLoadHistory`.

**New test file `src/calculations/acwr-rolling.test.ts`.** These cases were validated against an exact copy of the new function in the probe.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeACWR, computeRollingLoadRatio } from './fitness-model';
import type { Week } from '@/types/state';

const PLAN_START = '2026-06-01'; // Monday
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().split('T')[0]; };
function buildWeeks(tssForDay: (day: number) => number, lastDay = 60): Week[] {
  const wks = Array.from({ length: 16 }, (_, i) => ({ w: i + 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0, garminActuals: {} })) as unknown as Week[];
  for (let day = 0; day <= lastDay; day++) {
    const tss = tssForDay(day); if (tss <= 0) continue;
    const date = addDays(PLAN_START, day);
    wks[Math.floor(day / 7)].garminActuals![`a${day}`] = { garminId: `g${day}`, startTime: `${date}T08:00:00Z`,
      distanceKm: 10, durationSec: 3600, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
      iTrimp: (tss * 15000) / 100, activityType: 'RUNNING' } as any;
  }
  return wks;
}
const atPlanDay = (day: number) => { vi.useFakeTimers(); vi.setSystemTime(new Date(addDays(PLAN_START, day) + 'T09:00:00Z')); };
afterEach(() => vi.useRealTimers());
const PATTERN = [0, 50, 40, 60, 0, 40, 100];

describe('rolling ACWR without a Signal B seed', () => {
  it('unknown before plan day 14', () => {
    atPlanDay(13);
    expect(computeACWR(buildWeeks(() => 60), 2, 'recreational', undefined, PLAN_START, 0, undefined).status).toBe('unknown');
  });
  it('steady training reads 1.0 on days 14–26 (was 1.56–1.87 high)', () => {
    const wks = buildWeeks(() => 60);
    for (let day = 14; day <= 26; day++) {
      atPlanDay(day);
      const a = computeACWR(wks, 3, 'recreational', undefined, PLAN_START, 0, undefined);
      expect(a.ratio).toBeCloseTo(1, 9); expect(a.status).toBe('safe');
      vi.useRealTimers();
    }
  });
  it('genuine spike still detected and matches a correct seed', () => {
    const wks = buildWeeks(d => (d < 14 ? 40 : 80));
    atPlanDay(20);
    const noSeed = computeACWR(wks, 3, 'recreational', undefined, PLAN_START, 0, undefined);
    const seeded = computeACWR(wks, 3, 'recreational', undefined, PLAN_START, 0, 280);
    expect(noSeed.ratio).toBeCloseTo(1.6, 9); expect(noSeed.status).toBe('high');
    expect(noSeed.ratio).toBeCloseTo(seeded.ratio, 9);
  });
  it('unknown, not the zero-seeded EMA, when s.w runs ahead of the calendar', () => {
    atPlanDay(10);
    expect(computeACWR(buildWeeks(d => PATTERN[d % 7]), 5, 'recreational', undefined, PLAN_START, 0, undefined).status).toBe('unknown');
  });
});

describe('rolling ACWR unchanged where data covers the window', () => {
  it('seeded: seed/7 pre-plan fill, chronic = sum / 4', () => {
    atPlanDay(3);
    const r = computeRollingLoadRatio(buildWeeks(() => 60), PLAN_START, 350)!;
    expect(r.acute).toBeCloseTo(3 * 50 + 4 * 60, 9);
    expect(r.chronic).toBeCloseTo((24 * 50 + 4 * 60) / 4, 9);
  });
  it('no seed, day 27+: plain 28-day sum / 4', () => {
    atPlanDay(30);
    const r = computeRollingLoadRatio(buildWeeks(d => PATTERN[d % 7]), PLAN_START, undefined)!;
    let sum = 0, acute = 0;
    for (let d = 3; d <= 30; d++) { sum += PATTERN[d % 7]; if (d >= 24) acute += PATTERN[d % 7]; }
    expect(r.acute).toBe(acute); expect(r.chronic).toBeCloseTo(sum / 4, 9);
  });
  it('asOf evaluates the window ending on that date', () => {
    const wks = buildWeeks(d => (d < 14 ? 40 : 52));
    const viaAsOf = computeRollingLoadRatio(wks, PLAN_START, undefined, undefined, new Date(addDays(PLAN_START, 20) + 'T09:00:00Z'));
    atPlanDay(20);
    expect(viaAsOf).toEqual(computeRollingLoadRatio(wks, PLAN_START, undefined));
  });
});
```

**Behaviour changes to expect:**
- Unseeded users on days 14 to 26 now read 'safe'. The false week-3 cut, the ring cap and 'Overreaching' label, the "Load spike" coach line and the Tier-3 modal all disappear.
- The km-floor nudge (`events.ts:1118`, `:2525`) can now fire for these users.
- An existing false `scheduledAcwrStatus` stamp clears itself at the next week advance, so no migration is needed.

## 5. When a seed exists but the days just before the plan were real rest

The seed hides a genuine return-from-break spike. Probe: 290 per week with a 2-week break right before the plan.

| Plan day | Seeded reading | True reading |
|---|---|---|
| 7 | 1.04 safe | 2.15 high |
| 10 | 1.01 safe | 2.06 high |
| 14 | 1.04 safe | 2.00 high |

The break is dropped twice:
1. The history edge function emits no row for weeks with no activity (`index.ts:483-491`).
2. The median then drops zero weeks (`stravaSync.ts:268`). `detectedWeeklyKm` (`:301-304`) also skips them, so the plan starts at the pre-break volume too.

**Follow-up fix (not in this change): keep dated history.**
- Keep `weekStart`, which the edge function already returns (`index.ts:282`) and `stravaSync.ts:252` drops.
- Fill each pre-plan day with its own calendar week's `rawTSS/7`, and 0 for a week inside the fetched window that has no row.
- Separate issue: history uses a fixed 15000 normaliser (`index.ts:505-507`), but plan days use the personal one (`fitness-model.ts:281-291`). That mismatch already affects the seed fill.

## 6. The same zero-fill elsewhere

- **`getDailyLoadHistory`** (:994-1018): pre-plan days become 0 bars without a seed, or flat synthetic `seed/7` bars with one. Fix: `continue` for `weekIdx < 0` when there is no seed, so the chart starts at plan start.
- **Rolling-load view**: wrong seed argument and missing tier override (section 2). Its 1.3/0.8 label cutoffs (:287-296) ignore the tier.
- **Injury-risk view**:
  - The hero ratio (:276) and the acute/chronic figures (:279) are fixed by the core change.
  - **The weekly trend is not.** `getWeeklyAcwrHistory` (:91-111) uses an EMA seeded with `signalBBaseline ?? ctlBaseline ?? 0`.
  - With seed 0 and steady training it reads 4.12, 3.05, 2.41, 2.02, 1.76, 1.58, 1.45 and 1.36 over weeks 1 to 8. The bars are red, the commentary says "Load ratio above safe ceiling" (:143), and the hero text adds "the most recent completed week hit 2.4x" (:52-56).
  - Fix: evaluate `computeRollingLoadRatio(wks, planStartDate, signalBBaseline, undefined, weekEnd)` at each completed week's Sunday and skip nulls. That gives steady `— — 1 1 1 1 1 1`, and a 2x week 3 gives `— — 1.5 0.8 …`, the same model as the hero ratio.
- **Stats ACWR trend** (`stats-view.ts:2279-2287`): `computeFitnessModel` is seeded with 0 when no seed exists, and it mixes Signal A CTL with Signal B ATL, which inflates cross-trainers even when seeded. Same fix as the injury-risk trend.
- **Readiness**:
  - The ACWR hard floor and safety sub-score come from `computeACWR` and are fixed.
  - **TSB is not.** `computeSameSignalTSB` is seeded with `signalBBaseline ?? ctlBaseline ?? 0` (`home-view.ts:710`, `readiness-view.ts:83`, `stats-view.ts:699`, `daily-coach.ts:199`, `freshness-view.ts:73,268,582`).
  - With seed 0 the daily-equivalent TSB is -24, -21, -15 and -11 at weeks 2, 4, 6 and 8. The fitness sub-score is 1 to 20, against 39 when seeded, so readiness sits around 30 ('Ease Back') without recovery data.
  - An analogous no-constant fix: correct the zero-started EMA by dividing by `1 − decay^t` when there is no seed. Steady training then reads ratio 1.0 and TSB 0.

## 7. Decisions for Tristan

1. Choose the approach: fill from own earlier days (recommended), average over days with data, or 'unknown' until 28 days.
2. Choose the minimum history. Keep 14 days (the existing guard, `fitness-model.ts:944`) or use 21 (the existing "3 completed weeks" rule, `:1176`). Both numbers are already in the code.
3. Should 'unknown' keep the km floor active in `suggester.ts:500-501` / `:714-715`? It currently acts like 'high'.
4. In `getDailyLoadHistory`, should synthetic seeded pre-plan days also be dropped from the chart?
5. Follow-ups: dated pre-plan history and the normaliser mismatch; the TSB correction; the mixed signals in the stats trend. Optionally, add the `computeReadinessACWR(s)` helper the CHANGELOG describes, so the 21 hand-copied calls can't drift again.

## 8. Docs to update with the fix

- **`docs/SCIENCE_LOG.md`**:
  - Update the "Rolling 7d/28d" entry (:635-648) with the fill-from-own-days rule, the 4U/(U+3) equivalence and the limitations in section 3.
  - Correct the wording at :624 and :647. They call this ratio "uncoupled", but chronic includes this week's 7 days (`fitness-model.ts:964-965`), which makes it the coupled ratio.
- **`docs/CHANGELOG.md`**: add an entry for the fix. Also note that the 2026-04-16 entry's `computeReadinessACWR` and `computeLiveSameSignalTSB` are not in the code.
- **`docs/FEATURES.md`**: update the ACWR and injury-risk entries, and the test status for the new `acwr-rolling.test.ts`. No ACWR tests exist today.
- **`docs/OPEN_ISSUES.md`**: add or update the issue, but do not mark it fixed until Tristan has confirmed it on device.
# 6. False high injury risk (ACWR): adversarial review
**VERDICT: sound with changes**

The core diagnosis and the fill-from-own-days algorithm hold up against the code. Two things are wrong: the design has no protection against in-plan data gaps, and the Apple sync fix in this same workstream will trigger exactly that gap. Its scope and its tests also need correcting. The probe (`src/calculations/zz_probe_acwradv_k7q3.test.ts`) was created, run and deleted. The working tree is clean.

## What is correct and should be kept

- **Root cause.**
  - Without a seed, pre-plan days are filled with 0: `seedDaily` is set at `fitness-model.ts:940` and pushed at `:957-958`.
  - The 14-day guard is at `:944` and chronic = sum/4 is at `:965`.
  - Probe with constant 60/day on days 14 to 17 matches the design: 1.87, 1.75, 1.65, 1.56, all 'high'.
- **Algebra.** Chronic = (A+3B)/4, so the ratio is 4U/(U+3).
  - With 28 − (D+1) null days, the filled days plus the observed baseline days always sum to 21 × `baselineDaily`.
  - Windt & Gabbett (BJSM 2019) is the right citation for the coupled/uncoupled mapping.
- **Seeded users are unchanged.** With a seed there are no nulls in the window. From day 27 the output is identical: probe days 27 to 29, old and new both read 1.00.
- **Probe results for the new function** (Europe/London, UTC, LA, Tokyo):
  - Steady load reads 1.00 on days 14 to 26.
  - A 2x week 3 reads 1.60 at day 20, the same as with seed 280.
  - On day 14 before today's session is done, the current code reads 1.71 'high' and the new code 0.89 'safe'.
- **Removing the fallback is right.** With a seed, `computeRollingLoadRatio` never returns null. So in the rolling branch the EMA fallback (`:1172-1188`) is reached only by unseeded users, and it always starts from 0.
- **No new constants.** 14, 7, 28 and 4 already exist, and 21 = 28 − 7.
- **Facts confirmed:**
  - `rolling-load-view.ts:280-283`, `:487` and `:297` pass `atlSeed` as the Signal B seed.
  - `suggester.ts:500-501` and `:714-715` treat 'unknown' like an elevated reading, which turns the km floor off.
  - There are no ACWR tests.
  - `computeReadinessACWR` and `computeLiveSameSignalTSB` exist only in docs (commit 03a3072 touched only CHANGELOG).
  - SCIENCE_LOG `:624` and `:647` call the ratio "uncoupled", which is wrong: chronic includes the acute week.
  - The injury-risk weekly EMA seeded at 0 gives 4.12 in week 1. Arithmetic check: 0.632 / 0.153 = 4.13.

## Required changes

1. **Handle in-plan days with no data before a source's coverage starts. As it stands, the Apple fix will cause the same false 'high'.**
   - The design only treats `weekIdx < 0` as "no data".
   - Legacy Apple-only users have Apple as their activity source only when Strava is not connected (`sources.ts:22-33`, `main.ts:386`). Apple sync reads only 14 days back (`appleHealthSync.ts:122`).
   - Once `isNativeiOS` is fixed, these users (all long past plan day 28) will have 14 days of data in a 28-day window whose other 14 days are in-plan zeros.
   - Probe at plan day 100, data only on the last 14 days: current code 2.00 'high', new code 2.00 'high', seeded 2.00 'high'. It stays 'high' until about day 104.
   - That stamps `scheduledAcwrStatus = 'high'` at the next week advance (`events.ts:1103-1105`), caps readiness at 34 (`readiness.ts:363-365`) and triggers the Tier-3 modal.
   - The same happens for any source connected mid-plan (Garmin webhooks deliver activities only from connection onward), and for onboarding mid-week without a backfill. Probe with data starting on plan day 3: new code reads 1.39 'caution' at day 14. Starting day 6: 2.29 'high' at day 14, still 'high' at day 18.
   - Minimum fix: raise the Apple lookback to 28 days (the value already used at `stravaSync.ts:28`) in the Apple change, and ship it no earlier than this fix.
   - Better fix, and a decision for Tristan: record a per-source coverage-start date on the first successful sync, and treat in-plan days before it as `null` (seeded users: `seed/7`).
   - The design's limitation bullet ("B9") understates this. It should name this case explicitly.

2. **Drop the "no migration needed" claim, or add a small migration.**
   - A week that already carries a false stamp keeps its reduced quality sessions and its "Load spike detected" banner until the next advance, up to 7 days. The generator reads the stamp on every render (`plan-view.ts:1569`, `home-view.ts:579`, etc.).
   - Other leftovers persist too. If the user tapped "Keep" on the false warning, `acwrOverridden` stays set on that week (`main-view.ts:2390`, `:2549`), adding 1.15x ATL in the weekly TSB/EMA paths. Reductions they accepted stay in `workoutMods`.
   - Either say this explicitly, or re-check only `wks[s.w-1]` once, using `asOf` = that week's Monday, and clear the stamp and reason if the result is no longer caution or high. Which one is a decision for Tristan.

3. **Fix the scope and the call-site list.**
   - The stats ACWR trend (`stats-view.ts:2279`) is dead code. `buildInjuryRiskCard` is called only from `buildReadinessDetailPage` (:2481) and `buildStatsScroll` (:3037), and neither of those is ever called.
   - `stats-view.ts:705` sits in `buildReadinessCard_Opening`, which is also never called. It also uses `s.athleteTier` without the override (:703), so "all pass the same arguments" is false.
   - Remove the stats-trend fix from scope, or delete the dead code instead.
   - The count "21" also needs correcting: 21 `computeACWR` calls plus the direct call at `injury-risk-view:279`, of which 2 are dead.

4. **The rolling-load view change won't remove its false 'High'.**
   - The view reads only `acwr.atl` and `acwr.ctl` (`rolling-load-view.ts:285-294`, `:488-491`), so the tier-override change has no visible effect.
   - Its 'High' label and ring use a fixed 1.3/0.8, so a performance-tier athlete (safeUpper 1.45) still sees 'High' at 1.31.
   - Derive the label, pill and ring from `acwr.status` and `acwr.safeUpper`, which are already computed. Otherwise the drill-down disagrees with the Readiness card that links to it.

5. **Make the tests independent of timezone, and add the missing cases.**
   - `'T09:00:00Z'` fake time breaks the suite at UTC−10. Probe at Pacific/Honolulu: the day-14 steady case reads 0 ('unknown'), and the spike case reads 1.53 instead of 1.6.
   - Set the fake time to local noon instead: `new Date(y, m-1, d, 12)`.
   - Add a seeded-equivalence test over days 0 to 40 against the analytic value. This is what backs the "identical" claim; today only day 3 is tested.
   - Add a partial-coverage test that pins the known limitation from item 1.
   - "unknown before plan day 14" also passes on the current code, so it guards nothing. Keep it, but don't count it as a regression test.

6. **Treat the injury-risk trend rewrite as a change for every user, not just unseeded ones.**
   - Moving from the weekly EMA to rolling at each Sunday changes seeded users' bars. For a 2x week, the seeded EMA reads about 1.42 and rolling reads 1.60.
   - It also changes the accounting from `computeWeekRawTSS` to `computeTodaySignalBTSS`:
     - Garmin adhoc sessions without `garminTimestamp` are dropped.
     - GPS adhoc sessions are matched by weekday instead of getting the flat 30-minute estimate.
   - For unseeded users the "Not enough data" empty state lasts until week 4.
   - Move `getWeeklyAcwrHistory` into `fitness-model.ts` so it can be tested (`src/ui/**` has no tests) and add a test for it.

7. **Doc list is incomplete.**
   - `docs/MODEL.md` §5 (:141-160) still says "ACWR = ATL Signal B ÷ CTL 42-day Signal A".
   - `docs/FEATURES.md` `:588` and §28 `:644` say the ratio comes "from weekly TSS history".
   - The SCIENCE_LOG ACWR section lists ATL inflation multipliers (1.15, 1.10, 1.20) as if they apply to ACWR, but the rolling path ignores them. Correct that alongside the "uncoupled" wording.
   - `docs/ARCHITECTURE.md`: note the signature change (`asOf`, `coveredDays`).

8. **Say what happens in simulator mode.**
   - When `s.w` runs ahead of the calendar (the "Complete Week" button, `main-view.ts:336` and `:2555`, or simulator mode), the fallback is the only ACWR source. After the change it will always be 'unknown', so ACWR-driven plan cuts can't be exercised in the simulator.
   - Accepting that is reasonable, since the old reading was biased high, but it should be written down.

9. **Coordinate with the max-HR fix.**
   - If the max-HR fix recomputes stored `itrimp`, in-plan Signal B changes but `signalBBaseline` does not. It is refreshed only when history is thin (`main.ts:485-489`).
   - Seeded users on plan days 0 to 27 would then compare new-scale in-plan load against an old-scale seed.
   - Any iTRIMP recompute must also re-run `fetchStravaHistory`.

## Optional improvements

- **Baseline in whole weeks.** Average only the most recent 7k observed baseline days. That removes the weekday-mix bias: steady training then reads exactly 1.00 on every day (the design's day-14 value is 1.10) with no new constants. For the design's 2x-week example on day 18 this gives 1.34, against 1.45 for the design's fill and 1.40 with a correct seed.
- **Use or drop `coveredDays`.** No caller reads it. Either show "based on N days" on the injury-risk hero or remove it.
- **Use `asOf` at week advance.** At `events.ts:1096`, evaluate at the closed week's Sunday. Today the stamp uses a Tuesday-to-Monday window that includes the new week's partial day.
- **Threshold rounding.** `1.4 + 0.2 = 1.5999999999999999`, so a ratio of exactly 1.60 reads 'high' rather than 'caution' for the trained tier. Pre-existing.
- **TSB bias correction.** If it is pulled in, it must also cover the within-week daily decay loops (`readiness-view.ts:86-100`, `home-view`, `freshness-view`), not just `computeSameSignalTSB`. Cite the standard zero-start EMA bias correction.
- **Shared ACWR helper.** Add `computeReadinessACWR(s)` so the hand-copied call sites can't drift again.
- **Copy.** The reason strings at `events.ts:1104` and `:1107` contain em dashes, which the copy rules ban. Pre-existing.
- **Timezone bug.** `toISOString()` of local noon lands on the wrong date for UTC+13/+14 (New Zealand in summer). The Kiritimati probe shows the steady case drifting from 1.10 to 1.00. Out of scope, and the fix must change both the `startTime` side and the `dateStr` side.
# 7. Strava stream re-download: design
## Strava stream re-download: diagnosis and fix design

All citations are to `supabase/functions/sync-strava-activities/index.ts` unless another file is named.

## Short answer for Tristan

Yes, we can store it. The code already tries to store everything derived from a stream (`hr_zones`, `km_splits`, `hr_drift`). Streams get downloaded again because of three defects working together:

1. The cache query never reads `hr_drift` (:1028). The drift heal at :1186 therefore fires for every cached run of 20 minutes or more, on every sync.
2. The two heal writes use `void supabase…update()` (:1177, :1197). With supabase-js these requests are never sent. I confirmed this with a probe.
3. Nothing records that a stream has been processed. A row whose stream has no HR is stored with `hr_zones = null`, so it is streamed again on every sync (:1099, :1116, :1223).

The fix:
- Store a `stream_status` marker and a `detail_fetched_at` marker on each row.
- Also store a per-bpm HR histogram. It is a lossless summary for iTRIMP and %HRmax zones, so a max-HR change can recompute both with no Strava call.
- Await every write.
- Process new activities first, then heal a capped number of legacy rows.

Steady state after the fix is **1 Strava call per sync** (the list call), plus 2 calls once for each new HR activity.

---

## 1. Strava API calls today

### Standalone mode
This runs on every cold launch (`src/main.ts:402`), from the Sync button (`src/ui/main-view.ts:2685`), from the account buttons (`src/ui/account-view.ts:1148`, `:1167`), and after a Strava connect (`src/main.ts:378`). The window is 28 days (`src/data/stravaSync.ts:26-28`, default at :434).

| # | Call | Condition | Lines | Repeats with nothing new? |
|---|---|---|---|---|
| S1 | `POST /oauth/token` | Access token expired (6-hour tokens) | 638-645, 185-211 | Only when expired |
| S2 | `GET /athlete/activities?per_page=50&after=…` | Always. No pagination | 971-974 | Yes (this is the one call that's needed) |
| S3 | `GET /activities/{id}` (calories heal) | Cached row with zones, and calories null in the list, the DB row and the Garmin twin (:1097). At most 10 attempts per sync | 1106-1115 | Stops once Strava returns a number, because the `needsUpsert` upsert is awaited. Repeats forever if the detail has no calories |
| S4 | `GET /activities/{id}/streams?keys=heartrate,time[,distance,moving]` | Row missing **or `hr_zones` null** (no-HR activity, or an earlier 429) | 1099, 1116-1124 | **Forever for no-HR activities.** The upsert writes `hr_zones: null` again (:1223) |
| S5 | `GET /activities/{id}` | Paired with S4 when `isRun` or calories null | 1143-1155 | Paired with S4 |
| S6 | `GET /activities/{id}` (km_splits heal) | Cached run with zones and empty `km_splits`. No cap | 1171-1182 | **Forever.** The write at :1177 is `void`, so it is never sent. The same run can also trigger S3, which fetches the same endpoint again and throws away its `splits_metric` |
| S7 | `GET /activities/{id}/streams?keys=heartrate,time` (drift heal) | Cached `RUNNING` row with zones and `elapsed_time ≥ 1200`. No cap | 1186-1203 | **Forever, for three separate reasons:** (a) the select at :1028 omits `hr_drift` and the map type at :1032 has no such field, so `cached.hr_drift` is always `undefined`; (b) the write at :1197 is `void`; (c) a run where `calculateHRDrift` returns null (fewer than 120 samples, stream span under 1200 s, or under 60 valid samples, :162-170) is never marked. :1104 reads a property missing from the type, so `deno check` would reject it. The deploy evidently doesn't type-check |

Cost per sync with nothing new is `1 + R₂₀ + R_nosplit + min(10, C_nocal) + Σ_noHR (1 + [run or calories null])`. For a runner doing 5 runs of 20 minutes or more per week, that is about 21 calls per launch (the prior audit's probe agrees). A runner without HR pays 1 + 2 per run.

Two further points:
- Strava's rate limit is per application, so this cost is shared across all users. The code's own comment at :1022-1024 cites 100 requests per 15 minutes.
- I could not reach developers.strava.com from here. My understanding is that Strava returns `after=` queries oldest-first. If so, the one genuinely new activity is processed after all the heals and is the most likely to hit a 429.

### Backfill mode
This runs from `src/main.ts:486-489` on every launch while `historicWeeklyTSS.length < 8`, and from the account "Fetch/Refresh history" buttons (`src/ui/account-view.ts:806`, `:813`).

| # | Call | Condition | Lines | Repeats with nothing new? |
|---|---|---|---|---|
| B1 | `POST /oauth/token` | Expired | 638-645 | Only when expired |
| B2 | `GET /athlete/activities?per_page=200&page=k` | Always, paginated | 659-668 | Yes (needed) |
| B3 | Streams | Row not in `cachedWithZones` (zones null or all zero), activity has avg HR, athlete has an HR monitor, newest 99 only | 764-774, 803-807 | Yes, for any row whose zones are still null (earlier 429, or over the 99 budget) |
| B4 | `GET /activities/{id}` | Paired with **every** B3. `act.calories == null` is always true on list payloads, and runs always qualify anyway | 828-830 | Paired with B3. `STREAM_BUDGET = 99` counts activities, not calls, so up to 198 calls. That contradicts the "within 100 req/15 min" intent in `docs/CHANGELOG.md:2004` |
| B5 | `GET /activities/{id}` (calories heal) | Up to 15 of `needAvgHR` where the **list** `calories` is null. It never checks `cachedCalories`, so it matches every activity | 919-931 | **Yes, the same ≤15 activities on every backfill.** The awaited update at :927 doesn't check its error |

Some context for B5: the Strava list endpoint returns SummaryActivity. As far as I know SummaryActivity has no `calories` field; it only appears in DetailedActivity. I could not check this from the sandbox. The comment at :1096 does note that list calories are "often null".

---

## 2. Does `void supabase.from(...).update(...)` execute?

**No.** In `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts`, the builder implements `PromiseLike`. The HTTP request is created only inside `then()` (lines 99-130: `const _fetch = this.fetch; let res = _fetch(this.url…)`). `void expr` builds the query object and throws it away without calling `then()`.

The installed version is supabase-js/postgrest-js 2.96.0. The edge function imports `esm.sh/@supabase/supabase-js@2`, which uses the same lazy builder design.

I confirmed this with a probe (a fake `fetch` that records calls; the probe file has been deleted):
```
void sb.from('garmin_activities').update(...).eq(...).eq(...)  -> 0 requests after 50 ms
await sb.from('garmin_activities').update(...)                  -> 1 request (PATCH)
sb.rpc('increment_narrative_usage', …).then(() => {})           -> 1 request, sent synchronously inside then()
```

### Every fire-and-forget or unchecked write in `supabase/functions/**`

| Location | Pattern | Executes? | Effect |
|---|---|---|---|
| index.ts:1177 | `void supabase.from("garmin_activities").update({ km_splits })` | **Never** | Splits heal repeats every sync (bug since 2c4a217, 2026-03-19) |
| index.ts:1197 | `void supabase.from("garmin_activities").update({ hr_drift })` | **Never** | Drift heal repeats every sync (bug since bd8d6f8, 2026-04-14) |
| coach-narrative/index.ts:292-296, :299-307 | `.rpc(...).then(...)`, not awaited, then return | Request is sent, but completion isn't guaranteed if the worker shuts down after the response | Usage and spend counters can under-count. Fix with `await Promise.all([...])` or `EdgeRuntime.waitUntil(...)` |
| index.ts:205-210 | Awaited `strava_tokens` update, error ignored | Yes | Strava rotates refresh tokens. If this write fails silently, the next refresh uses a stale token |
| index.ts:927 | Awaited calories update, error ignored | Yes | Minor |
| index.ts:679-683, :1026-1030 | Cache `select`, **error ignored** | Yes | If the select fails, every activity is treated as uncached and all of them are streamed again. **This matters for deploy order** (see §5) |

All other `.from()` calls in the other functions are awaited. I grepped `garmin-*`, `strava-auth-*`, `sync-*` and `coach-narrative`.

---

## 3. Fix design

### 3.1 What to store
No existing column marks a stream as processed. The existing columns are `hr_zones` and `km_splits` (20260226120000), `itrimp` (20260224120000), `hr_drift` (20260312) and `elevation_gain_m` (20260405). The `garmin_activities` CREATE isn't in the migrations; the table was made outside them.

Derived products, each fetched once:
- **`hr_histogram jsonb`**: `{ "<bpm>": seconds }`. It is built with exactly the same `(hr[i], dt = t[i]−t[i−1])` pairing that `calculateITrimp` (:48-55) and `calculateHRZones` (:86-95) use. Both functions are sums over samples of *f(HR) × dt*, so summing by bpm bin gives exactly the same result for any rest, max and β.
  - Probe: 200 synthetic streams including pause gaps, dt = 0 duplicates and 0-bpm dropouts, × 5 (rest, max) pairs × 2 sexes. Worst relative iTRIMP error was 2.4e-14 (floating-point ordering). Zones were identical in 100% of cases. The largest histogram was 142 bins, 1,249 bytes of JSON.
  - This adds no new constant. A 1-bpm bin is the native resolution of integer HR streams (values are rounded).
  - It keeps current behaviour exactly, including pause-gap dt and 0 bpm counted in Z1.
  - It loses time order. Drift, splits and any future time-ordered metric must be computed when the stream is fetched.
- `hr_zones`, `hr_drift` and `km_splits` stay as they are: these columns are already read by history mode, `sync-activities` and the client.
- **`stream_status text`**: one of `'ok' | 'no_hr' | 'unavailable' | 'error'`. NULL means the new code hasn't processed the row. `ok`, `no_hr` and `unavailable` are terminal.
- **`detail_fetched_at timestamptz`**: the detail endpoint (calories, `splits_metric`) is called at most once per activity.
- **`itrimp_max_hr`, `itrimp_resting_hr smallint`**: the parameters the stored `itrimp` and `hr_zones` were computed with. The max-HR fix can use them to detect stale rows and recompute from the histogram with no Strava call. Rows without HR can be recomputed from the stored `avg_hr` and `duration_sec`.

Optional (Decision D3): a separate `activity_streams` table holding the raw arrays (time, HR, distance, moving). This would cover future time-ordered metrics such as pause-gap handling or decoupling. It costs tens of KB per activity, and Strava's API Agreement data-retention terms need checking first. I recommend not doing this by default.

I put the derived columns on `garmin_activities` rather than in a separate table. Every existing reader already queries that table with explicit column lists (:452, :599, `sync-activities/index.ts:26`), so the new jsonb column adds no cost to those queries and needs no join.

### 3.2 Migration: `supabase/migrations/20260929120000_strava_stream_cache.sql`
Use a 14-digit version: several existing files share 8-digit date prefixes.

```sql
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS hr_histogram      jsonb;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS stream_status     text;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS stream_fetched_at timestamptz;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS detail_fetched_at timestamptz;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS itrimp_max_hr     smallint;
ALTER TABLE garmin_activities ADD COLUMN IF NOT EXISTS itrimp_resting_hr smallint;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'garmin_activities_stream_status_chk') THEN
    ALTER TABLE garmin_activities ADD CONSTRAINT garmin_activities_stream_status_chk
      CHECK (stream_status IS NULL OR stream_status IN ('ok','no_hr','unavailable','error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_garmin_activities_stream_pending
  ON garmin_activities (user_id, start_time DESC)
  WHERE source = 'strava' AND (stream_status IS NULL OR stream_status = 'error');

-- One-time classification, zero API calls.
-- (a) Non-runs that Strava reported without HR can never yield an HR stream.
UPDATE garmin_activities SET stream_status = 'no_hr', stream_fetched_at = now()
 WHERE source = 'strava' AND stream_status IS NULL AND avg_hr IS NULL AND activity_type <> 'RUNNING';
-- (b) Detail endpoint already harvested.
UPDATE garmin_activities SET detail_fetched_at = now()
 WHERE source = 'strava' AND detail_fetched_at IS NULL AND calories IS NOT NULL
   AND (activity_type <> 'RUNNING' OR km_splits IS NOT NULL);
-- (c) ONLY IF Tristan picks Decision D2 option B (no legacy re-stream):
-- UPDATE garmin_activities SET stream_status = 'ok'
--  WHERE source = 'strava' AND stream_status IS NULL AND hr_zones IS NOT NULL;
```

### 3.3 Code changes

**New `supabase/functions/_shared/strava-stream.ts`.** This is pure TypeScript with no Deno APIs and no imports. Folders prefixed `_` are bundled but not deployed as functions.
- Move `calculateITrimp`, `calculateITrimpFromSummary`, `calculateHRZones`, `calculateKmSplits`, `calculateHRDrift` and `DRIFT_TYPES` here from :37-179.
- Add:
```ts
export function buildHRHistogram(hr: number[], t: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (let i = 1; i < hr.length; i++) {
    const dt = t[i] - t[i - 1]; if (dt <= 0) continue;
    const k = String(Math.round(hr[i])); h[k] = (h[k] ?? 0) + dt;
  }
  return h;
}
export function iTrimpFromHistogram(h, rest, max, sex?) { /* Σ sec·x·e^{βx}, x=(bpm−rest)/(max−rest), skip bpm<=rest; same β as :44 */ }
export function zonesFromHistogram(h, max) { /* same 0.60/0.70/0.80/0.90 cut-points as :90-94 */ }

export type StreamStatus = 'ok' | 'no_hr' | 'unavailable' | 'error';
const TERMINAL = new Set(['ok', 'no_hr', 'unavailable']);
export function planStravaWork(
  a: { isRun: boolean; hasAvgHR: boolean; caloriesKnown: boolean },
  row?: { stream_status: StreamStatus | null; detail_fetched_at: string | null },
) {
  const streamDone = row?.stream_status != null && TERMINAL.has(row.stream_status);
  const stream = !streamDone && (a.isRun || a.hasAvgHR);   // runs keep stream split fallback (today's :1157)
  const markNoHR = !streamDone && !stream;                 // non-run, no avg HR: mark with no call
  const detail = row?.detail_fetched_at == null && (a.isRun || !a.caloriesKnown); // today's :1143 rule, once
  const kind = !row ? 'new' : (stream || detail || markNoHR) ? 'heal' : 'none';
  return { kind, stream, markNoHR, detail, streamKeys: a.isRun ? 'heartrate,time,distance,moving' : 'heartrate,time' };
}
```

**`sync-strava-activities/index.ts`**
1. Import the shared module (`../_shared/strava-stream.ts`).
2. Make `stravaGet` (:218) throw a `StravaHttpError { status }`. Give it a per-invocation `{ calls, rateLimited }` budget. After the first 429, set `rateLimited` and make no more calls. Log `x-ratelimit-usage` and `x-ratelimit-limit` if present (I could not verify the header names).
3. Cache selects (:680-681, :1027-1028) must include `hr_drift, hr_histogram, stream_status, detail_fetched_at, itrimp_max_hr, itrimp_resting_hr`. Add `hr_drift` to the map type at :1032. **On a select error, return 500. Never fall through as if nothing were cached.**
4. Standalone loop (:1062-1255) becomes:
   - Plan every activity.
   - Sort newest first by `start_date`.
   - Run all `new` items first. Then run `heal` items until the heal budget (D1) is used up.
   - Stop all Strava calls on a 429.
   - Stream result handling: HR present gives `ok` and writes histogram, zones, iTRIMP, drift and the iTRIMP params. HR absent or misaligned gives `no_hr`. A 404 or 403 gives `unavailable`. A 429, 5xx or network error gives `error`, which is retried on a later sync inside the heal budget. A 401 aborts the sync without marking any rows.
   - Set `detail_fetched_at` after any successful detail call, and after a 404.
   - Delete the S3, S6 and S7 blocks (:1105-1115, :1170-1203). The planner covers them.
5. Writes:
   - New rows: keep the awaited full upsert (:1207-1230) and add the new columns.
   - Existing rows: `const { error } = await supabase.from('garmin_activities').update(patch).eq('garmin_id', id).eq('user_id', uid)` and log the error.
   - Don't batch heterogeneous patches into one bulk upsert. PostgREST uses the union of keys across the batch, so missing keys would null out columns.
6. Backfill:
   - Replace the `cachedWithZones` skip (:766) with the planner. Terminal rows cost 0 calls. Legacy rows with a null status get streamed once.
   - Make `STREAM_BUDGET = 99` count **calls** (stream + detail), which matches its documented intent.
   - Replace 7b (:918-933) with the planner's `detail` rule, based on `detail_fetched_at` and not on list calories.
   - In the avg-HR batch (:896-910), set `stream_status: 'no_hr'` for non-runs without avg HR.
7. At the end of each mode, log one summary line: `strava_calls=N new=… healed=… pending_heal=… rate_limited=… usage=…`.

**`coach-narrative/index.ts:292-307`**: `await Promise.all([...])`, or wrap the calls in `EdgeRuntime.waitUntil`.

No client change is needed. The response shape stays the same. One note for the max-HR fix: `src/data/stravaSync.ts:74` only patches `hrZones` when the actual has none, so zones recomputed for a new max HR won't reach existing actuals.

### 3.4 Expected calls after the fix
- Established user, nothing new: **1** (list), plus 1 per extra list page.
- New HR activity: 2, once. New no-HR non-run: 0 or 1 (detail only if calories are unknown), once.
- Legacy heal: at most D1 per sync, newest first, converging to 1. Probe with a cap of 10 and no migration (b) pre-marking: 17, 21, 11, 1, 1 calls over successive syncs. With (b), each heal costs 1 call.
- The 28-day window heals through standalone. Older rows heal through backfill: press "Refresh history" once or twice, 15 minutes apart.

---

## 4. Verifying without a live Strava account

1. **vitest** `src/calculations/strava-stream.test.ts`, importing `../../supabase/functions/_shared/strava-stream.ts`. `tsconfig` has `allowImportingTsExtensions: true`, and vitest includes `src/**/*.test.ts`. Tests:
   - (a) Histogram equivalence as a property test, as in my probe: `iTrimpFromHistogram(buildHRHistogram(hr,t),…)` equals `calculateITrimp(hr,t,…)` within 1e-12, and zones match exactly, including gaps, dt = 0 and 0 bpm.
   - (b) A `planStravaWork` truth table: new HR run gives stream+detail; `ok`+detail gives none; `no_hr` gives none; `error` gives heal; legacy null status gives heal; a no-HR non-run gives `markNoHR` with no stream.
   - (c) For call counting, move the standalone orchestration into `_shared/strava-standalone.ts` with injected `{ stravaGet, loadCache, writeRow }`. Test that sync 1 costs 2 per new HR activity, sync 2 costs exactly 1, a 429 injected at call k makes 0 further calls and writes no terminal status, and the next sync retries.
   - (d) A guard test that greps `supabase/functions/**/*.ts` for `/\bvoid\s+\w+\.(from|rpc)\(/` and fails if it finds a match.
2. **Optional local run** (Docker + Deno on Tristan's Mac): add a `STRAVA_API_BASE` env override (default `https://www.strava.com/api/v3`), then run `supabase start` and `supabase functions serve sync-strava-activities` against a stub server.
3. **After deploy, on Tristan's own account:**
   - Press Sync twice. In the Supabase dashboard (Edge Functions → sync-strava-activities → Logs), the second run should show `strava_calls=1` once heals finish.
   - Run this SQL:
     ```sql
     select stream_status, count(*) n, count(hr_histogram) hist, count(hr_drift) drift, count(detail_fetched_at) detail
     from garmin_activities where source='strava' and user_id='<uid>' group by 1 order by 1;
     ```
     Within 28 days there should be no `null` or `error` rows.
   - strava.com/settings/api shows the app's usage.

## 5. Deploy steps (I can't deploy from here)

```bash
supabase link --project-ref elnuiudfndsvtbfisaje      # ref from docs/OPEN_ISSUES.md:739
supabase migration list                               # check what's pending (20260303060000 notes past "applied but not run")
supabase db push                                      # or paste the SQL into the Dashboard SQL editor
## verify:
##   select column_name from information_schema.columns where table_name='garmin_activities'
##   and column_name in ('hr_histogram','stream_status','stream_fetched_at','detail_fetched_at','itrimp_max_hr','itrimp_resting_hr');
supabase functions deploy sync-strava-activities --project-ref elnuiudfndsvtbfisaje
supabase functions deploy coach-narrative --project-ref elnuiudfndsvtbfisaje   # if its rpc fix is included
```

**Run the migration before deploying the function.** If the function goes first, its select names columns that don't exist yet. The current code ignores select errors (:1026), so it would treat every activity as new and stream all of them again in one burst. The new code returns 500 in that case instead, but the order still matters. No app or Capacitor rebuild is needed.

## 6. Decisions for Tristan (numbers not already in the code)

- **D1. Heal budget per sync.** Existing values in the code: 10 (calories heal cap, :1106), 15 (backfill calories heal, :922), 99 (`STREAM_BUDGET`, :759), and the 100/15 min figure in the comment at :1023. My suggestion is to reuse 10 as the shared budget for all optional calls.
- **D2. Legacy rows.**
  - Option A: re-stream once, within the budget. This gets histograms for up to 16 weeks, so the max-HR fix can recompute stored iTRIMP exactly.
  - Option B: mark legacy rows `ok` with no calls (migration step (c)). Legacy rows then have no histogram, and the max-HR fix would need the avg-HR estimate for them.
  - I recommend A.
- **D3.** Whether to store raw streams in a separate table. This needs a check of Strava's API Agreement retention terms.
- **D4.** Whether iTRIMP parameters should be "as of the activity date" or "current". `restingHR` comes from the latest `daily_metrics` row (:1002), so it changes daily, and "current" would rewrite every row each day. This interacts with the max-HR fix.
- **D5 (optional).** A retry cap for `error` rows. Without one, retries are still bounded by D1 per sync.

## 7. Related problems found, outside this fix

- Standalone uses `per_page=50` with no pagination (:971-974). If Strava returns `after=` results oldest-first, anyone with more than 50 activities in 28 days never syncs their newest ones.
- When the list call returns 429, the function returns 500. The client swallows it (`src/data/stravaSync.ts:186-188`) and the UI still shows "Synced".
- `fetchExtendedHistory` (`src/data/stravaSync.ts` ~:612-625, called from `src/ui/stats-view.ts:3099`) expects an array. History mode returns `{ rows, _debug }` (:577), so this path silently does nothing.

## Docs the implementer must update (CLAUDE.md rules)

- `docs/CHANGELOG.md`
- `docs/FEATURES.md` (Strava sync section and test status)
- `docs/ARCHITECTURE.md` (the `_shared` module, the new columns, and the fetch-once data flow)
- `docs/SCIENCE_LOG.md`: add a "HR histogram as lossless iTRIMP/zone input" entry next to "iTRIMP Calculation" (:278). It should state what the histogram preserves (the dt pairing, pause gaps, 0-bpm dropouts in Z1) and that it loses time order.
- `docs/OPEN_ISSUES.md`: open a new ISSUE entry. Don't mark it fixed until Tristan has confirmed it on device.

My probe files (`zz_probe_voidwrite_7db4`, `zz_probe_hrhist_7db4`, `zz_probe_plan_7db4`) are deleted, and I changed no repo files. `src/calculations/zz_probe_apple_q7.test.ts` belongs to another agent and I left it in place.
# 7. Strava stream re-download: adversarial review
**VERDICT: sound with changes**

The diagnosis holds up against the code. The fix design has gaps in the backfill path and in how it writes to existing rows. As written, it would destroy stored zones and splits and silently rewrite historical iTRIMP. All citations are to `supabase/functions/sync-strava-activities/index.ts` unless another file is named.

## What is correct and should be kept

- **`void` writes never run.** In `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts` (2.96.0), the fetch is created only inside `then()`. So `:1177` and `:1197` never send anything.
- **Drift is never read from the cache.** The select at `:1028` has no `hr_drift`, the map type at `:1032` has no such field, and `:1104` reads it anyway. The drift heal at `:1186` therefore fires on every sync. The km_splits heal at `:1171` has no cap. No-HR rows are re-streamed forever (`:1099`, `:1116`, `:1223`).
- **The histogram is lossless.** My own probe (integer HR, pause gaps, dt = 0, 0 bpm, fractional max HR) matched iTRIMP to within 1.9e-14 relative error, and zones matched exactly.
- **The bulk-upsert warning is correct.** `PostgrestQueryBuilder.ts:383` defaults `defaultToNull` to true, and `:413-416` sends the union of keys across the batch.
- **Keep these as proposed:**
  - Return 500 when the cache select fails.
  - Run the migration before deploying the function.
  - Flag D1 to D5 for Tristan rather than choosing numbers.
  - Make `STREAM_BUDGET` count calls.
  - The §7 side findings are all confirmed. `fetchExtendedHistory` (`src/data/stravaSync.ts:615-625`) expects an array but gets `{rows,_debug}` (`:577`). `per_page=50` has no pagination (`:971`). The unawaited `.rpc().then()` calls are at `coach-narrative/index.ts:292-307`.

## Required changes

1. **Backfill would wipe zones on legacy rows that go over budget.** The design replaces the `cachedWithZones` skip (`:766`) with the planner. A legacy row with real zones and a null status that doesn't fit in `STREAM_BUDGET` then falls into `needAvgHR` (`:771-773`). The avg-HR batch writes `hr_zones: null, km_splits: null` (`:907`) and overwrites `itrimp` with the avg-HR estimate. The `:880` skip only protects rows in `cachedBasic`, not rows with zones. Halving the budget to count calls makes this more likely: a runner with 7 activities a week has about 112 rows in 16 weeks.
   - Fix: rows that exist and are deferred or terminal must never enter `needAvgHR`. Simplest rule: keep today's `cachedWithZones` skip in backfill for legacy rows with non-null `hr_zones` (see item 10).

2. **The avg-HR batch must exclude rows that already exist, and must not mix key sets.**
   - Today, every backfill already nulls `km_splits` on no-HR runs (`:880`, `:907`), and the next standalone re-stream restores it. Once `no_hr` and `detail_fetched_at` are terminal, nothing restores it, so those splits are lost for good.
   - The design's own step 6 adds `stream_status: 'no_hr'` to only some rows in this bulk upsert. By the union-of-keys rule, every other row in that batch gets its `stream_status` set to NULL.
   - Fix: the batch should only insert new rows, and every row should carry the same explicit key set. Existing rows should get per-row `update(patch)` calls.

3. **Error paths must never null out derived columns on existing rows.** In backfill, the stream `catch` (`:842-846`) falls through to the full upsert (`:849-867`). That writes `hr_zones: null`, `km_splits: null` and `hr_drift: null`, and overwrites `itrimp` with the avg-HR estimate. The planner sends legacy rows down this path, so one 429 during a heal destroys good data.
   - For any existing row: on `error`, patch only `{stream_status:'error'}`.
   - When the stream comes back with no HR, or misaligned, but the stored `hr_zones` is non-null: set the status only, and don't clear anything.
   - Apply this rule in both modes.

4. **Legacy heals must not silently rewrite stored iTRIMP or zones.** The client overwrites `actual.iTrimp` on every sync whenever the value differs (`src/calculations/activity-matcher.ts:577`). It does not recompute `wk.actualTSS`. Under D2 option A, a heal recomputes with today's `daily_metrics` resting HR (`:1002`) and the current max HR. That shifts historical load for 28 days of matched actuals as a side effect.
   - Rule: for rows with non-null `hr_zones`, the heal writes only `hr_histogram`, `hr_drift` (if null) and `stream_status`.
   - It leaves `itrimp`, `hr_zones`, `itrimp_max_hr` and `itrimp_resting_hr` untouched. The last two stay NULL, meaning "parameters unknown".
   - Recomputing belongs to the max-HR fix and D4. Only overwrite `itrimp` and `hr_zones` when the stored `hr_zones` was null (the row came from the avg-HR fallback).

5. **Keep the response in Strava's order.** Processing newest-first is fine, but `rows` must go back to the client in list order. The matcher walks `weekRows` in order (`activity-matcher.ts:674`). It removes each matched slot from `unratedWorkouts` (around `:832-833`) and caps `runAutoCompletions` (`:758`). Reversing the order changes which run claims which planned slot. It also changes the order of `garminPending` in the review UI.

6. **Say what happens to new activities that don't get processed** (after a 429, or over budget).
   - They must still be upserted with summary fields, the avg-HR iTRIMP (as today at `:1161-1165`), `stream_status = 'error'` and `detail_fetched_at = null`.
   - They must still appear in the response.
   - Also say whether "new" items are budgeted at all. As written, only heals are.

7. **Define the budget unit as calls.** The design's probe figures of 17 and 21 calls exceed 1 + 10. So that probe counted items, and a heal costs up to 2 calls (stream + detail). State the unit for D1 explicitly. Also say that the first syncs after deploy cost about the same as today.

8. **A 403 must not be terminal.** Only a 404 should give `unavailable`. A scope or permission problem returns 403 for every activity and would permanently mark all rows. Treat 403 like 401 (abort, mark nothing), or as `error`.

9. **Standalone and backfill run at the same time on launch.** `src/main.ts:402` and `:486-489` both fire without being sequenced. With the planner, both would heal the same legacy rows, doubling the calls and racing each other's writes. Fix: backfill skips heals for activities inside the standalone window. That is the existing 28 days (`:434`, `src/data/stravaSync.ts:26-28`), so no new number is needed.

10. **Put the app-wide cost of option A to Tristan before recommending it.** The 100 requests per 15 minutes cited at `:1023` and `docs/CHANGELOG.md:2004` is shared by every user of the app. A backfill heal of more than 100 legacy rows at `STREAM_BUDGET = 99` uses the whole app's 15-minute budget for one user, and every existing user would do this after deploy.
    - Default: option A applies to the 28-day standalone window only, within D1.
    - Backfill keeps treating rows with `hr_zones` as done.

11. **Column types.**
    - `itrimp_max_hr` and `itrimp_resting_hr` as `smallint` are unsafe. A user-entered max HR is `+input` (`src/ui/account-view.ts:750`) and can be fractional. Postgres rejects `185.5` for `smallint`, so the whole upsert fails and the row is re-streamed on every sync, which is the bug being fixed. Use `real`.
    - Store the sex/β used, or document that changing sex invalidates the stored values.

12. **Fact corrections.**
    - B5 is not capped at 15. `calHealed` only increments when the detail returns calories (`:926-929`), so it can call once for every `needAvgHR` row.
    - S3's cap of 10 only counts successful fetches (`:1113`). Failed calls (e.g. 429s) don't count.
    - The client line is `stravaSync.ts:84`, not `:74`.
    - `stream_fetched_at` is set by migration (a) but never read or written by the code. Use it or drop it.
    - No query uses `idx_garmin_activities_stream_pending`, because every lookup is `.in('garmin_id', …)`. Drop it.

13. **Missing tests.**
    - Backfill:
      - an over-budget legacy row stays unchanged;
      - terminal rows never reach the avg-HR batch;
      - the error patch only sets the status;
      - every row in a batch has the same key set.
    - Response order is preserved.
    - A 403 marks no rows.
    - Guard (d)'s regex `/\bvoid\s+\w+\.(from|rpc)\(/` misses `void supabase` followed by `.from(` on the next line. It also misses bare unawaited statements, which are just as much a no-op. Use a multiline or AST check.

## Optional improvements

- **Histogram keys.** Key bins by the exact value, or assert `Number.isInteger`. In my probe, rounding fractional HR gave up to 0.45% iTRIMP error and zone mismatches; exact keys gave 5.7e-15. Strava HR streams are integers in practice, so this only removes an assumption.
- **Fewer calls for no-HR runs.** Use the list's `has_heartrate` field and fetch the detail first for runs. Then stream only if there is HR or `splits_metric` is empty. That saves one call per new no-HR run.
- **Rate-limit logging.** Also log the `X-ReadRateLimit-*` headers, and mention Strava's daily read limit alongside the 15-minute one. I believe it is 1,000 per day but could not verify it from here.
- **Retry cap (D5).** An attempts counter column would give D5 something to count.
- **Filters and batching.** Use `garmin_id LIKE 'strava-%'` rather than only `source='strava'`; Garmin webhook rows have a NULL source. Split the `.in()` into chunks for 52-week backfills.
- **Separate the coach-narrative change.** Ship it as its own commit and deploy.
- **Coordinate with the max-HR fix.** Confirm that the max-HR design actually reads `hr_histogram`. Otherwise option A spends Strava calls for nothing.

My probe file `src/calculations/zz_probe_srd_rev9.test.ts` is deleted and I changed no repo files. `zz_probe_acwradv_k7q3.test.ts` belongs to another agent and I left it in place.
# 8. Apple Watch sync: design
## Apple Watch sync diagnosis (`src/data/appleHealthSync.ts` and everything it touches)

## 1. Bottom line

Apple Watch sync has never run on a device. Workouts and physiology are both dead, and three separate blockers stack on top of each other. Fixing only the first one exposes the other two.

1. **Platform check always fails** (certain). `isNativeiOS()` reads `window.Capacitor.platform`. Capacitor 8 never sets that property, so both sync functions return straight away.
2. **Authorization request always fails** (certain). `ALL_READ_TYPES` includes `'appleExerciseTime'`, which the plugin's Swift code rejects. That rejects the whole `requestAuthorization` call, so every workout and physiology sync throws. `'workouts'` is also never requested, so `queryWorkouts` would return nothing even if auth succeeded.
3. **The app may crash on launch** once 1 and 2 are fixed (the crash is certain if the key is missing; whether it is missing is uncertain). `ios/` is gitignored and `docs/WorkoutWatch.md:481-487` (2026-04-14) says `NSHealthShareUsageDescription` and the HealthKit entitlement are missing. iOS kills the app if `requestAuthorization` runs without that Info.plist key, and boot calls it for every Apple user.

Once data flows, these become live:
- **Double counting for every current Apple user.** Onboarding requires Strava, but Account → Apple Watch → Sync still calls `syncAppleHealth()`.
- **Physiology dates are off by one day** in UTC+ time zones. Tristan's commits are +0200.
- **Sleep before midnight is dropped.**
- **HRV is cut off** to roughly the oldest 2 weeks (likely; depends on how many readings the watch takes per day).
- **Physiology values freeze** after the first sync of each day.
- **No heart rate is read** for any workout.
- **Strength, HIIT, yoga and team sports are recorded as walks.**
- **The review queue is never opened** after a sync.

No repo files were modified. The probe test I wrote was run and then deleted (`git status` is clean).

---

## 2. Findings

### 2.1 Platform detection

| # | Finding | Evidence | Certainty |
|---|---|---|---|
| A1 | `isNativeiOS()` returns `(window as any)?.Capacitor?.platform === 'ios'` | `src/data/appleHealthSync.ts:40-42`, used at `:99` and `:158` | Certain |
| A2 | Capacitor 8.0.1 never sets `.platform`. The native side creates `window.Capacitor = { DEBUG, isLoggingEnabled, Plugins: {} }`. The native bridge only adds `getPlatform` and `isNativePlatform` functions. Core adds the same functions. The public type has no `platform` member. | `node_modules/@capacitor/ios/Capacitor/Capacitor/JSExport.swift:19`; `.../assets/native-bridge.js:833-838`; `node_modules/@capacitor/core/dist/index.js:28-38,45-48,186-188`; `node_modules/@capacitor/core/types/definitions.d.ts:2-37` | Certain from source |
| A3 | Capacitor has been ^8.0.1 since the first commit that added it (a2e3941). So this check has never passed on a device. | `git log -p package.json` | Certain |
| A4 | Probe with the real `@capacitor/core` and `window.webkit.messageHandlers.bridge` present: `getPlatform()='ios'`, `isNativePlatform()=true`, `window.Capacitor.platform=undefined`. `syncAppleHealth()` made 0 plugin calls and `syncAppleHealthPhysiology()` returned `false`. | probe P1 | Certain (probe) |
| A5 | No other file uses the bad check. `guided/voice.ts:13-15`, `guided/keep-awake.ts:14,33`, `guided/background-location.ts:35`, `guided/haptics.ts:43` and `gps/providers/index.ts:15` all use `Capacitor.isNativePlatform()` or `utils/platform.ts`. The correct helper is `isIOS()` at `src/utils/platform.ts:13-19`. | grep | Certain |

The prior audit said Apple passive strain is "reachable from committed code" (its B10). That is wrong today because of A1, but it becomes true once A1 is fixed.

### 2.2 Native project configuration (can't be checked from here)

- `ios/` is in `.gitignore`, so Info.plist and entitlements aren't in the repo.
- `docs/WorkoutWatch.md:481-487` lists these as missing: `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`, a `.entitlements` file with `com.apple.developer.healthkit`, and possibly the App ID capability.
- CHANGELOG 2026-04-16 (`docs/CHANGELOG.md:26-32`) added motion and audio keys to Info.plist but no HealthKit keys.
- The plugin README (`node_modules/@capgo/capacitor-health/README.md:57-67`) requires the HealthKit capability plus both usage-description keys.
- Without `NSHealthShareUsageDescription`, `HKHealthStore.requestAuthorization` throws an uncaught exception ("NSHealthShareUsageDescription must be set in the app's Info.plist…") and the app terminates. Without the entitlement, the request fails with a missing-entitlement error.
- **Sequencing risk:** if the platform fix ships without these, every Apple user's app crashes on launch.

### 2.3 What the installed plugin actually offers (`@capgo/capacitor-health` 8.2.16)

**Methods** (`ios/Sources/HealthPlugin/HealthPlugin.swift:9-20`, `dist/esm/definitions.d.ts:137-201`):
- `isAvailable`, `requestAuthorization`, `checkAuthorization`
- `readSamples`, `saveSample`, `queryWorkouts`, `queryAggregated`
- `getPluginVersion`, and two Android-only no-ops

**Data types** (Swift enum `Health.swift:152-163`):
- Accepted: `steps, distance, calories, heartRate, weight, sleep, respiratoryRate, oxygenSaturation, restingHeartRate, heartRateVariability`, plus the special read type `'workouts'`.
- The parser (`Health.swift:637-653`) handles `'workouts'` and throws `invalidDataType` for anything else.
- `requestAuthorization` catches that error and rejects the call (`Health.swift:312-342` → `HealthPlugin.swift:32-40`).
- **`appleExerciseTime` is not supported anywhere.** `queryAggregated` also rejects it (`Health.swift:714`, which uses `parseDataType` at `:630-635`).
- The README says `'workouts'` must be requested explicitly (`README.md:177-187`). The TypeScript union omits it (`definitions.d.ts:1`), which is why the code needed `as any`. The same `as any` casts at `appleHealthSync.ts:61` and `:182` also hid the invalid `appleExerciseTime` from `tsc`.

**Workout payload** (`Health.swift:890-929`):
- Fields: `workoutType`, `duration` (whole seconds from `HKWorkout.duration`), `startDate`, `endDate`, optional `totalEnergyBurned` (kcal) and `totalDistance` (m), `sourceName`, `sourceId`, and `metadata`.
- Metadata keeps only String or NSNumber values. So `HKIndoorWorkout` survives as `"1"`/`"0"`, but `HKElevationAscended`, `HKAverageMETs` and weather (all HKQuantity) are dropped.
- **Missing:** workout UUID, any heart rate, route, and the raw activity type.

**Workout type strings** (`Health.swift:103-149`):
- Returned: `running, cycling, walking, swimming, yoga, strengthTraining, hiking, tennis, basketball, soccer, americanFootball, baseball, crossTraining, elliptical, rowing, stairClimbing, waterFitness, waterPolo, waterSports, wrestling, other`.
- `traditionalStrengthTraining` comes back as **`strengthTraining`** (`:115-117`).
- Every other HealthKit type (HIIT, functional strength, core, pilates, dance, and so on) comes back as **`other`** (`:146-147`).
- `traditionalStrengthTraining` is never returned.

**Heart rate per workout:** yes, via `readSamples({dataType:'heartRate', startDate: w.startDate, endDate: w.endDate, ascending:true, limit})`.
- The predicate is the plain overlap `predicateForSamples(withStart:end:options:[])` (`Health.swift:369`). Each sample carries `value` (bpm), start/end and `sourceId` (`:433-446`).
- The default limit is 100 (`:371`), which is far too few for a workout. Passing `limit: 0` goes to `HKSampleQuery(limit: 0)`, and 0 is `HKObjectQueryNoLimit` (likely; verify on device).
- An Apple engineer says HealthKit condenses older first-party workout HR into series samples (`count > 1`), readable at full resolution only through `HKQuantitySeriesSampleQuery`, which the plugin doesn't expose. The docs scope this to workouts "at least a few months old". Our lookback is 28 days, so individual samples are expected (likely; verify the sample count on device).

**Dates:**
- Output strings come from `ISO8601DateFormatter` with its default GMT time zone (`Health.swift:284-287`). So every `startDate` is UTC with a `Z` suffix.
- Input must include fractional seconds. `toISOString()` does, so that part is fine.
- `queryWorkouts` silently falls back to "last 24 h" on an unparseable date (`:846`).

**Authorization check:**
- `checkAuthorization` uses `getRequestStatusForAuthorization` (`Health.swift:606-621`). That only reports whether the prompt was shown, never whether read access was granted (HealthKit hides read denial).
- So the log at `appleHealthSync.ts:165-169` is misleading.

**Pagination:**
- The anchor is the last workout's `endDate` (`Health.swift:933-941`). With `ascending:false`, the next page starts again from the oldest workout. Pagination is broken for descending order; this only matters above the 100-workout limit.

### 2.4 From plugin output to `GarminActivityRow` (`convertToActivityRow`, `appleHealthSync.ts:393-416`)

| Field or aspect | Problem | Certainty |
|---|---|---|
| Type (`:72-86`) | `strengthTraining`, `yoga`, `tennis`, `soccer`, `basketball`, `americanFootball`, `baseball`, all water sports, `wrestling` and **`other` (HIIT, functional strength, pilates, dance…)** fall to `'WALKING'`. The `traditionalStrengthTraining` case can never fire. `crossTraining` becomes `STRENGTH_TRAINING` (gym), whereas Garmin maps `CROSS_TRAINING` to `'other'` (`activity-matcher.ts:40-111`). The indoor flag is ignored, so treadmill runs and indoor rides aren't distinguished. Probe P3 confirmed `strengthTraining`, `yoga`, `soccer` and `other` all become `WALKING`. Downstream, `'walk'` is matched as a run (prior audit D3). | Certain |
| Duration | `Int(workout.duration)`. HealthKit derives this from start/end and pause events, so it is likely active time. Consistent with moving-time pace. | Likely |
| Distance | `HKWorkout.totalDistance` in metres. Fine; verify it is populated on current iOS. | Likely |
| HR | `avg_hr`, `max_hr` and `iTrimp` are always null (`:409-410`). `hrZones` and `hrDrift` are absent. `resolveITrimp` (`activity-matcher.ts:385-396`) therefore returns null, and load is duration × `TL_PER_MIN[rpe]`, with RPE taken from the planned slot or a type heuristic (`deriveRPE`, `activity-matcher.ts:213-265`). | Certain |
| iTRIMP normaliser dependency | Once HR is attached, Apple rows get an iTrimp and enter `computeTierAPlus`, which uses raw, un-normalised iTrimp (the audit finding). Apple cross-training would then be sized 'extreme' like HR-tracked Strava rides. **Sequence the HR ingestion after the universalLoad normalisation fix.** | Certain |
| IDs (`:400`) | `apple-${sourceId}-${startDate}` is stable (`sourceId` is always sent, `Health.swift:912-913`). There is no UUID. Different sources for the same physical workout get different IDs. | Certain |
| Dedup vs Strava | Only `garminMatched` IDs are deduped (`activity-matcher.ts:418-428,614-617`). There is no start-time dedup across sources. **Live paths:** (a) Account → Apple Watch → Sync calls `syncAppleHealth()` even when Strava is connected (`account-view.ts:976-980`). The Apple row renders whenever physiology is Apple (`:174,203`), which covers every current Apple user because onboarding requires Strava (`wizard/steps/fitness.ts:44-66,176-181`). (b) After a Strava disconnect (`account-view.ts:1133`) the activity source becomes `'apple'` (`sources.ts:22-30`) and 28 days of Strava-imported sessions come back as Apple rows. (c) Inside HealthKit: Garmin Connect, Strava and other apps can write copies of the same workout. Strava imports Apple Workout-app sessions through Health when "Automatic Uploads" is on. The existing 2-minute start window at `supabase/functions/sync-strava-activities/index.ts:465-477` can be reused. | Certain (a, b); likely (c) |
| Lookback | 14 days (`:122`) versus 28 days in Strava and Garmin (`stravaSync.ts:26-27`, `activitySync.ts:26-27`). | Certain |
| Elevation, route, splits | Not available from the plugin. | Certain |
| `render()` gating (`:106-107`) | `matchAndAutoComplete` returns an object (`activity-matcher.ts:412-415`), so `if (changed)` is always true and every sync re-renders. | Certain |

### 2.5 Physiology (`syncAppleHealthPhysiology`, `:157-314`)

| # | Problem | Evidence | Certainty |
|---|---|---|---|
| P1 | The `appleExerciseTime` aggregate rejects inside `Promise.all`, so the whole physiology sync fails even if auth is fixed | `:177-183`; `Health.swift:714` | Certain |
| P2 | **UTC date keys.** Keys come from `iso.split('T')[0]` on GMT strings (`:198,206,212,225,234`). Steps and exercise buckets are anchored at local midnight (`Health.swift:744`), which in UTC+ zones serialises as 22:00Z or 23:00Z the previous day. So **every steps value, and resting HR keyed by the sample's start time, lands a day early**, and today's steps never appear. Probe in Europe/Paris: 27 Sep bucket keyed `2026-09-26`, 28 Sep keyed `2026-09-27`, RHR keyed `2026-09-27`. New York was correct. | probe P4 | Certain for UTC+ users |
| P3 | **Sleep before midnight is dropped.** `if (endHour >= 12) continue` (`:196`) excludes every segment ending 12:00–23:59 local, which includes the start of the main night where most deep sleep occurs. Probe, 22:30→06:30 night (480 min): New York stored 420 min. Paris stored 300 min on the 28th plus a phantom 120-min "night" on the 27th (sleepScore 61), because segments ending 00:00–02:00 local have a UTC date of the 27th. | probe P4 | Certain |
| P4 | Sleep samples from all sources are summed: iPhone `inBed`/`asleep`, Watch stages, and third-party apps. There is no source selection or overlap union (`:190-201,320-337`). | code | Certain (mechanism); size depends on the user |
| P5 | **HRV cut off.** `limit:100, ascending:true` (`:180`) returns the oldest 100 samples. At 8 per day, the probe had HRV only for 1–13 Sep (13 of 28 days). Readiness then loses recent HRV. Sleep uses `limit:2000, ascending:true` (`:178`), which would drop the most recent nights first if hit. | probe P4 | Mechanism certain; trigger depends on samples per day (device check) |
| P6 | **Values freeze.** The merge `{ ...entry, ...prev, ...pickDefined(entry, prev) }` (`:294`) keeps `prev` for every field already set. Today's steps and exercise minutes stay at the first sync of the day, and late-arriving sleep stages or RHR never replace earlier partial values. Probe: steps stayed at 3000 after a re-sync that returned 12000. | probe P4 | Certain |
| P7 | `s.restingHR` is taken from the last entry (`:304-305`). That entry is usually today's steps-only entry with no RHR, so RHR rarely updates. | code | Certain |
| P8 | HRV per day is "last value wins" among daytime SDNN spot readings. It is then multiplied by `SDNN_TO_RMSSD = 1.28` (`:147,219`). That constant is not in `docs/SCIENCE_LOG.md` (only `CHANGELOG.md:864`). The commonly cited short-term norms reproduced in Shaffer and Ginsberg 2017 (Nunan et al. 2010: SDNN about 50 ms, RMSSD about 42 ms) have RMSSD *below* SDNN, which contradicts a ×1.28 factor. The factor only matters for the absolute thresholds in `rmssdToHrvStatus` (`src/recovery/engine.ts:125-130`); z-scored HRV is unaffected. | code, docs | Science needs Tristan's review; the ratio is uncertain |
| P9 | Garmin-only sync buttons are shown to Apple users. Home's sleep "Sync" (`home-view.ts:1344,1412-1422`) and Readiness's "Sync" (`readiness-view.ts:345-348,545-553`) call `syncPhysiologySnapshot`, and the copy says "no Garmin data yet". For an Apple user who previously had Garmin, this would replace `s.physiologyHistory` with stale Garmin rows (`physiologySync.ts:163-186`). | code | Certain (mechanism) |

### 2.6 Sync orchestration

**Boot (`src/main.ts:382-397`):**
- Activity source `'apple'`: `syncAppleHealth()` and `syncAppleHealthPhysiology(28)` run concurrently. Workout sync never schedules a Home refresh.
- `ensureAuthorization` sets `_authRequested` only after an `await` (`appleHealthSync.ts:60-63`), so concurrent callers can issue two `requestAuthorization` calls. The race is certain from the code; the iOS impact is uncertain. My concurrency probe was inconclusive because of module-reset interference.

**Strava + Apple physiology (`main.ts:397-414`):**
- Only physiology from HealthKit. This is correct; workouts come from Strava.

**Foreground resume (`main.ts:605-622`):**
- Apple users get physiology only. New Watch workouts arrive only on cold launch or a manual Sync.

**Account → Apple Watch → Sync (`account-view.ts:969-990`):**
- Always runs `syncAppleHealth()`, which causes the Strava duplicates in 2.4.
- Both sync functions swallow their errors, so it always reports "Sync complete — activities, sleep, and recovery updated." That is a false success on web, when denied, or on error, and the em dash breaks the copy rules.

**Home "Sync" (`main-view.ts:2672-2710`):**
- Dead code. `wireEventHandlers()` (`:2521`) is never called and `renderMainView` delegates to the plan view (`:53-56`). This matches the prior audit.

**Missing post-sync steps (certain):**
- Garmin (`activitySync.ts:47-71`) and Strava (`stravaSync.ts:159-182`) both run `mergeTimingMods`, `resetPendingModalGuard` and `processPendingCrossTraining`, including when no rows come back.
- Apple runs none of them (`appleHealthSync.ts:98-113`) and returns early on zero workouts (`:103`).
- Result: current-week non-runs and unmatched runs sit at `'__pending__'` with zero load, and timing mods are never recomputed (prior audit D1).

**Other gaps:**
- *Max HR:* Apple physiology never sets `s.maxHR`. The p95 derivation is Strava-only (`stravaSync.ts:139-157`). Apple-only users have max HR only from manual entry, so iTRIMP (`resolveITrimp`) and %HRmax zones need a manual value or the max-HR workstream's derivation.
- *Account "Change" button (`account-view.ts:1088-1092`):* clears `wearable` but not `connectedSources.physiology`, which `getPhysiologySource` reads first (`sources.ts:42-44`). New-onboarding Apple users can't switch away. Certain.
- *Apple row status:* always shows a green "Syncs automatically" (`account-view.ts:293-308`) and hides the Strava row for Apple + Strava users (`:203`).
- *Source labels:* Apple actuals are labelled "Garmin" at `plan-view.ts:261,856` and `activity-detail.ts:73`. `renderer.ts:1304-1309` already has the right helper.

### 2.7 Build blocker for device testing

`npx tsc --noEmit` currently fails on the committed tree:
- `@capacitor/haptics` missing
- `@capacitor-community/keep-awake` missing
- `GuidedCueLogEntry` not exported

These packages are not in `package.json`, so `npm run build:ios` fails on a clean checkout. Tristan's machine may have uncommitted installs.

---

## 3. Probe results (deleted after running)

The fake plugin mirrored the Swift validation, sort, limit and GMT formatting.

| Probe | Result |
|---|---|
| P1: real Capacitor 8 core, iOS bridge present | `getPlatform()='ios'`, `.platform=undefined`, 0 plugin calls, physiology returns `false` |
| P2: `.platform` forced to `'ios'` | Both syncs throw `Unsupported health data type: appleExerciseTime.` Read list sent: `calories, distance, heartRate, sleep, restingHeartRate, heartRateVariability, steps, appleExerciseTime`. `workouts` not included. |
| P3: auth forced to succeed | `strengthTraining`, `yoga`, `other`, `soccer` → `WALKING`; `crossTraining` and `traditionalStrengthTraining` → `STRENGTH_TRAINING`; `avg_hr` null and `iTrimp` undefined on every row |
| P4: physiology, Paris | Sleep 300 of 480 min on the wake date plus a phantom 120-min night the day before. Steps and RHR a day early. HRV only 1–13 Sep. Steps frozen at 3000 after re-sync with 12000. |
| P4: physiology, New York | Sleep 420 of 480 min (pre-midnight hour lost). Date keys correct. HRV cut off and value freeze the same as Paris. |

---

## 4. Prioritised fix plan

### P0: make it run at all. Ship together and in this order.

**P0.0 Native project (Tristan, in Xcode, before any JS change ships).**
- Signing & Capabilities → **+ HealthKit** (creates `App.entitlements` with `com.apple.developer.healthkit`).
- Add both usage keys to `ios/App/App/Info.plist`.
- Suggested copy, in the consultant tone with no em dash: *"Mosaic reads workouts, heart rate, sleep, heart rate variability, resting heart rate and steps from Apple Health to calculate training load and recovery."* The update key's string should say Mosaic does not write data. It is still needed because the plugin binary contains write APIs.
- Run `npx cap sync ios` and confirm `"HealthPlugin"` appears in `ios/App/App/capacitor.config.json` `packageClassList`.

**P0.1 Platform check** (`appleHealthSync.ts:39-42`):
```ts
import { isIOS } from '@/utils/platform';
// delete isNativeiOS(); replace both call sites (:99, :158) with isIOS()
```

**P0.2 Authorization** (`:44-65`): fix the read list, remove `as any`, run a single shared auth request, and check availability.
```ts
import type { HealthDataType, Workout, HealthSample, SleepState } from '@capgo/capacitor-health';
type HealthApi = typeof import('@capgo/capacitor-health')['Health'];

// 'workouts' is accepted by Swift (Health.swift:637-653) but missing from the TS union (definitions.d.ts:1).
const READ_TYPES = ['workouts', 'heartRate', 'restingHeartRate', 'heartRateVariability',
  'sleep', 'steps', 'calories', 'distance'] as unknown as HealthDataType[];

let _authPromise: Promise<HealthApi> | null = null;
function ensureAuthorization(): Promise<HealthApi> {
  if (!_authPromise) {
    _authPromise = (async () => {
      const { Health } = await import('@capgo/capacitor-health');
      const avail = await Health.isAvailable();
      if (!avail.available) throw new Error(avail.reason ?? 'HealthKit unavailable');
      await Health.requestAuthorization({ read: READ_TYPES });
      return Health;
    })();
    _authPromise.catch(() => { _authPromise = null; }); // allow retry after a failure
  }
  return _authPromise;
}
```
Also delete the misleading `checkAuthorization` block (`:163-169`).

**P0.3 Physiology must survive one failing query** (`:177-183`):
- Drop the `appleExerciseTime` call (decision D2).
- Replace `Promise.all` with `Promise.allSettled`, reading `r.status === 'fulfilled' ? r.value.samples : []` for each result.

**P0.4 Strava guard.** Without this, P0.1 makes double counting live for every current Apple user.
```ts
// top of syncAppleHealth():
if (getState().stravaConnected) return { ok: true, reason: 'strava-is-source', workouts: 0, changed: false };
```
In the `account-view.ts:976-980` handler:
```ts
const sNow = getState();
const [act, phys] = await Promise.all([
  sNow.stravaConnected
    ? syncStravaActivities().then(r => ({ ok: true, workouts: r.processed }))
    : syncAppleHealth(),
  syncAppleHealthPhysiology(28),
]);
// build syncResultMsg from act.ok / phys.ok. No em dash in the copy.
```

**P0.5 Post-sync steps.** This mirrors `stravaSync.ts:159-182`. New imports: `resetPendingModalGuard` and `processPendingCrossTraining` from `./activitySync`, `mergeTimingMods` from `@/cross-training/timing-check`, `getState` from `@/state`.
```ts
export interface AppleSyncResult { ok: boolean; reason?: 'not-ios' | 'strava-is-source' | 'error'; workouts: number; changed: boolean; error?: string }

export async function syncAppleHealth(): Promise<AppleSyncResult> {
  if (!isIOS()) return { ok: false, reason: 'not-ios', workouts: 0, changed: false };
  if (getState().stravaConnected) return { ok: true, reason: 'strava-is-source', workouts: 0, changed: false };
  try {
    const Health = await ensureAuthorization();
    const workouts = await fetchRecentWorkouts(Health);            // 28-day lookback (P1.6)
    const rows = await buildRows(Health, workouts);                // mapping + HR + dedup (P1.4–P1.5)
    const result = rows.length ? matchAndAutoComplete(rows) : { changed: false, pending: [] };
    const s = getMutableState();
    const wk = s.wks?.[s.w - 1];
    if (wk && mergeTimingMods(s, wk)) saveState();
    if (result.changed) render();
    if (!document.getElementById('activity-review-overlay') && !document.getElementById('suggestion-modal')) resetPendingModalGuard();
    processPendingCrossTraining();                                  // also on zero rows
    console.log(`[AppleHealthSync] ${workouts.length} workouts, ${rows.length} rows, changed=${result.changed}`);
    return { ok: true, workouts: rows.length, changed: result.changed };
  } catch (err) {
    console.warn('[AppleHealthSync] Sync failed:', err);
    return { ok: false, reason: 'error', workouts: 0, changed: false, error: String(err) };
  }
}
```
- Change `syncAppleHealthPhysiology` to return `{ ok, days, reason? }` in the same way.
- Update callers at `main.ts:388,390,408,619` and `account-view.ts:978-979`.
- In `main.ts:388`, use `syncAppleHealth().then(r => { if (r.changed) scheduleHomeRefresh(); })`.

### P1: correct data once it flows

**P1.1 Local-date keys for physiology** (`:198,206,212,225,234`):
```ts
function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```
- This matches Garmin's `calendarDate` semantics.
- Separate cross-cutting issue for Tristan: the app keys "today" by UTC in 81 places (`toISOString().split('T')[0]`). Between local midnight and UTC midnight in UTC+ zones, Home still reads the previous local day. That affects Garmin too and is out of scope here.

**P1.2 Sleep night attribution and a single source.** Replace `:190-201`.
```ts
// Wake date: segments ending before local noon belong to that date. Segments ending at/after noon
// belong to the NEXT morning's night instead of being dropped (same noon boundary as today).
function wakeDateKey(endIso: string): string {
  const end = new Date(endIso);
  if (end.getHours() >= 12) end.setDate(end.getDate() + 1);
  return localDateKey(end.toISOString());
}
// Group by wakeDate → sourceId; per night keep the one source with the most asleep seconds
// (computeSleepStageDurations deep+rem+light) instead of summing iPhone + Watch + third-party.
```
- This adds no new constant. Daytime naps would fold into the following night (decision D3).
- Also query with `ascending:false` and `limit: 0` (P1.3).

**P1.3 Query limits:**
- HRV (`:180`) and sleep (`:178`): use `limit: 0` (all samples).
- HRV daily value (currently the last reading of the day): decision D4.

**P1.4 Merge policy** (`:289-301`) and RHR (`:304-305`):
```ts
const appleOwns = getPhysiologySource(s) === 'apple';   // import from '@/data/sources'
const next = !prev ? entry : appleOwns ? { ...prev, ...entry } : { ...prev, ...pickDefined(entry, prev) };
...
const withRhr = [...entries].reverse().find(e => e.restingHR != null);
if (withRhr) s.restingHR = withRhr.restingHR!;
```

**P1.5 Type mapping.** Replace `:72-86`. Target strings are ones `mapGarminType` and `formatActivityType` already know.
```ts
function mapWorkoutType(w: Workout): string {
  const indoor = w.metadata?.HKIndoorWorkout === '1';
  switch (w.workoutType) {
    case 'running':  return indoor ? 'TREADMILL_RUNNING' : 'RUNNING';
    case 'cycling':  return indoor ? 'INDOOR_CYCLING' : 'CYCLING';
    case 'walking':  return 'WALKING';
    case 'hiking':   return 'HIKING';
    case 'swimming': return 'SWIMMING';
    case 'strengthTraining':
    case 'traditionalStrengthTraining': return 'STRENGTH_TRAINING';
    case 'crossTraining': return 'CROSS_TRAINING';   // decision D5 (currently gym)
    case 'yoga':       return 'YOGA';
    case 'tennis':     return 'TENNIS';
    case 'basketball': return 'BASKETBALL';
    case 'soccer':     return 'SOCCER';
    case 'americanFootball': return 'FOOTBALL';
    case 'elliptical': return 'ELLIPTICAL';
    case 'rowing':     return 'ROWING';
    case 'stairClimbing': return 'STAIR_CLIMBING';
    default: return 'WORKOUT';  // plugin collapses HIIT, functional strength, pilates, dance… into 'other'
  }
}
```
- Separating HIIT from pilates needs a plugin patch (P2.4).
- `ROWING` → `'walk'` → matched as a run is an existing, source-agnostic bug (`activity-matcher.ts` walk group, audit D3).

**P1.6 Heart rate per workout.** Sequence after the universalLoad normalisation fix. Fetch only for rows not already in any week's `garminMatched`, so the cost stays bounded.
```ts
import { calculateITrimp } from '@/calculations/trimp';

// %HRmax edges identical to supabase/functions/sync-strava-activities/index.ts:79-96
function zonesFromStream(hr: number[], t: number[], maxHR: number) {
  const z = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (let i = 1; i < hr.length; i++) {
    const dt = t[i] - t[i - 1]; if (dt <= 0) continue;
    const p = hr[i] / maxHR;
    if (p < 0.60) z.z1 += dt; else if (p < 0.70) z.z2 += dt; else if (p < 0.80) z.z3 += dt; else if (p < 0.90) z.z4 += dt; else z.z5 += dt;
  }
  return z;
}

async function attachHeartRate(Health: HealthApi, w: Workout, row: GarminActivityRow): Promise<number> {
  const { samples } = await Health.readSamples({ dataType: 'heartRate', startDate: w.startDate,
    endDate: w.endDate, limit: 0 /* HKObjectQueryNoLimit */, ascending: true });
  const own = samples.filter(x => x.sourceId === w.sourceId);        // decision D7
  const use = own.length >= 2 ? own : samples;                        // 2 = calculateITrimp minimum (trimp.ts:46)
  if (use.length < 2) return use.length;
  const t0 = Date.parse(use[0].startDate);
  const hr = use.map(x => x.value);
  const t = use.map(x => (Date.parse(x.startDate) - t0) / 1000);
  let wSum = 0, dtSum = 0;
  for (let i = 1; i < hr.length; i++) { const dt = t[i] - t[i - 1]; if (dt > 0) { wSum += hr[i] * dt; dtSum += dt; } }
  row.avg_hr = dtSum > 0 ? Math.round(wSum / dtSum) : null;          // same dt rule as calculateITrimp
  row.max_hr = Math.round(Math.max(...hr));
  const s = getState();
  if (s.restingHR && s.maxHR) {                                       // same gate as resolveITrimp; decision D6
    const sex = s.biologicalSex === 'male' || s.biologicalSex === 'female' ? s.biologicalSex : undefined;
    row.iTrimp = calculateITrimp(hr, t, s.restingHR, s.maxHR, sex);
    row.hrZones = zonesFromStream(hr, t, s.maxHR);
  }
  return use.length;   // log alongside duration for the device density check
}
```
- Optional: port `calculateHRDrift` (`sync-strava-activities/index.ts:158-179`) for run types.
- Log `samples.length / duration`. If recent workouts return very few samples, the series-sample path needs a plugin patch.

**P1.7 Cross-source dedup** in `buildRows`. The constant is sourced from existing code.
```ts
const SAME_ACTIVITY_WINDOW_MS = 2 * 60 * 1000; // sync-strava-activities/index.ts:469
// 1. processedStarts: Map<id, startMs> from every week's garminActuals (garminId/startTime),
//    garminPending (garminId/startTime), adhocWorkouts (id.slice('garmin-'.length)/garminTimestamp).
// 2. Keep rows whose garmin_id is already processed (matcher skips them anyway).
// 3. Sort new rows: HR present first, then longer duration.
// 4. Drop a new row if its start is within the window of any processed start with a different id,
//    or of a new row already kept.
```
This covers the Strava-disconnect transition, HealthKit copies from multiple sources, and an earlier-processed copy versus a new copy that has HR.

**P1.8 Lookback and resume:**
- `fetchRecentWorkouts`: 28 days (`:122`), `ascending: true`.
- `main.ts:618-622`: when `getActivitySource(s) === 'apple'`, also call `syncAppleHealth()`. The existing 5-minute throttle at `:609-611` covers it.

### P2: UX, science and robustness

1. **UI** (do the CLAUDE.md UI pre-flight first):
   - Show the Strava row under the Apple row when Strava is connected (`account-view.ts:203`).
   - The "Change" button should also clear `connectedSources` (`:1090`).
   - The Apple row status should come from the last sync result, not a hardcoded green dot.
   - Home and Readiness "Sync" should call `syncAppleHealthPhysiology(7)` for Apple users and drop "Garmin" from the copy.
   - Use the `renderer.ts:1304` source helper at `plan-view.ts:261,856` and `activity-detail.ts:73`.
   - Move the HealthKit prompt to the Apple Watch button in the wizard (`fitness.ts:176-181`) so it appears in context.
2. **Science** (`docs/SCIENCE_LOG.md` entries are required):
   - Apple HR-stream iTRIMP: same Banister/Morton model and dt rule as Strava.
   - Sleep night attribution rule.
   - HRV aggregation method.
   - Re-examine `SDNN_TO_RMSSD = 1.28` (P8).
3. **Tests:** turn the probe into `src/data/appleHealthSync.test.ts` with a fake plugin that matches the Swift behaviour. Cover the type validation that caught `appleExerciseTime`, GMT output, sort and limit, per-type mapping, local-date keys, sleep attribution, merge, dedup, and the Strava guard.
4. **Plugin patch** (local package, same pattern as `ios-plugins/guided-voice`, or patch-package). Return:
   - workout `uuid`
   - raw `workoutActivityType.rawValue` (recovers HIIT, pilates and the rest)
   - `appleExerciseTime`
   - `HKWorkout.statistics(for: heartRate)` average and max (cheap and immune to series condensing)
   - elevation from metadata
   - Also fix descending pagination.
5. **Docs:** add a new ISSUE in `OPEN_ISSUES.md`, a CHANGELOG entry, and FEATURES.md Apple status. Per CLAUDE.md, don't mark it fixed until it has been tested on a device.

---

## 5. Decisions for Tristan (no numbers invented)

- **D1:** Should HealthKit be an activity source at all while onboarding requires Strava? My recommendation: HealthKit workouts only when Strava is not connected. That is P0.4, and `sources.ts:18-22` already says "Strava always wins".
- **D2:** `appleExerciseTime` (Exercise ring feeding `activeMinutes` and passive strain) is impossible with this plugin. Drop it (steps-only passive strain for Apple), or patch the plugin (P2.4)? Note that restoring it makes the prior audit's B10 passive-strain mismatch live for Apple users.
- **D3:** Daytime naps. Fold them into the following night (P1.2 default, no new constant)? Or exclude sessions ending between noon and some evening cut-off time you provide?
- **D4:** HRV daily value: the last reading (current), the mean over that night's sleep window (closest to Garmin's overnight HRV), or the daily mean? Also, should the ×1.28 SDNN→RMSSD factor stay?
- **D5:** Apple `crossTraining`: gym, which matches planned gym sessions (current), or `CROSS_TRAINING` → other (Garmin parity)?
- **D6:** Apple-only users with no `s.maxHR`: keep iTRIMP and zones null (the current `resolveITrimp` rule), or feed Apple `max_hr` values into whatever max-HR method the max-HR fix adopts? The Strava p95 at `stravaSync.ts:139-157` shouldn't be copied, since that method is itself under review.
- **D7:** HR samples: prefer the workout's own source and fall back to all sources (P1.6), or accept all sources?

---

## 6. Device test checklist (iPhone paired with an Apple Watch; Safari → Develop → device → console)

**Build and configuration**
0. `npx tsc --noEmit` is clean. It currently fails on haptics, keep-awake and `GuidedCueLogEntry`.
1. `npx cap sync ios`. `ios/App/App/capacitor.config.json` `packageClassList` contains `HealthPlugin`.
2. Xcode shows the HealthKit capability. `App.entitlements` has `com.apple.developer.healthkit = YES`. Info.plist has both `NSHealth*UsageDescription` keys.

**Permissions and platform**
3. Fresh install, Apple Watch user: a single HealthKit sheet appears listing Workouts, Heart Rate, Resting HR, HRV, Sleep, Steps (plus Active Energy and Distance). There is no crash and no `Unsupported health data type` in the console.
4. In the console, `Capacitor.getPlatform()` returns `'ios'`. Sync logs show a workout count above 0 after recording a workout.

**Workouts**
5. Record a 20+ min outdoor run on the Watch and open the app.
   - Log shows HR samples and duration. Record the ratio: that's the density check for series samples.
   - avg and max HR match the Fitness app within about 1–2 bpm.
   - Distance and duration match. iTRIMP and zones are present if `s.maxHR` and `s.restingHR` are set.
6. Workout types:

   | Recorded on the Watch | Expected in Mosaic |
   |---|---|
   | Indoor run | Treadmill Run |
   | Traditional Strength | Strength |
   | HIIT | "Workout", not Walk |
   | Yoga | Yoga |

   Also check that none of these takes a planned run slot.
7. A current-week non-run triggers the review or auto-process flow straight after sync, without opening Account.
8. Strava + Apple user: record one Watch run with Strava auto-upload on. Tap Account Sync. There is exactly one activity, and the week's TSS doesn't double.
9. Disconnect Strava and relaunch. Last month's sessions are not duplicated.
10. A Watch workout recorded while the app was backgrounded appears on returning to the app (more than 5 minutes later).

**Physiology**
11. Sleep: last night's total and stages match Health → Sleep ("Time Asleep"; Core/Deep/REM) within a few minutes, including a bedtime before midnight. No phantom night appears on the previous date.
12. Steps: after 22:00 and after 00:30 local, `JSON.parse(localStorage.marathonSimulatorState).physiologyHistory.slice(-3)` shows today's steps on today's local date and matching the Health app. Re-sync later in the day and the value updates.
13. HRV: entries exist for each of the last 3 days. Count the total HRV samples over 28 days from the log (tells us whether the old limit of 100 was being hit).
14. Resting HR: `s.restingHR` equals the Health app's latest resting HR.

**Denial and web**
15. Denial path: turn off all Mosaic reads in Settings → Health → Data Access & Devices. Sync reports no data instead of "Sync complete", and the app doesn't crash.
16. Web or desktop: Account Sync reports that Apple Health isn't available, not success.

---

## 7. Certain vs uncertain

**Certain (source-verified or probe):**
- `.platform` never set.
- `appleExerciseTime` rejects auth and the aggregate query.
- `'workouts'` not requested.
- Wrong type mapping and plugin type strings.
- No HR; `render()` always fires; 14-day lookback.
- Account Sync ignores Strava.
- No post-sync steps.
- UTC keys, pre-midnight sleep exclusion, merge freeze, `restingHR` from the wrong entry.
- Wrong source labels; "Change" button no-op.
- Home "Sync" handler is dead; tsc fails.

**Uncertain (needs the device or your local `ios/`):**
- Whether Info.plist and entitlements are still missing. If they are, the crash is certain.
- HR sample density and whether recent workout HR comes back as individual samples.
- `limit: 0` being treated as no limit.
- `HKWorkout.duration` excluding pauses.
- `totalDistance` and energy populated on current iOS.
- `HKIndoorWorkout` metadata passing through as `"1"`.
- HRV samples per day (whether the 100 limit truncates).
- Contiguity of Watch sleep stages and multi-source overlap in real data.
- iOS behaviour with two concurrent `requestAuthorization` calls.
- Scientific validity of the 1.28 SDNN→RMSSD factor.

Sources:
- [Apple Developer Forums: queried heart rate samples in the past (condensed series, count > 1)](https://developer.apple.com/forums/thread/677861)
- [Search result summary of Apple's "Accessing condensed workout samples" doc (applies to workouts at least a few months old)](https://developer.apple.com/documentation/healthkit/workouts_and_activity_rings/accessing_condensed_workout_samples)
- [Apple Developer Forums: requestAuthorization crash without NSHealthShareUsageDescription](https://developer.apple.com/forums/thread/128771)
- [Apple Developer Forums: App Store Connect missing NSHealthUpdateUsageDescription](https://developer.apple.com/forums/thread/695864)
- [Apple docs: HKWorkout.duration](https://developer.apple.com/documentation/healthkit/hkworkout/1615240-duration)
- [Strava Help Center: Apple Health and Strava (Automatic Uploads imports Apple Workout app activities)](https://support.strava.com/hc/en-us/articles/216917527-Health-App-and-Strava)
# 8. Apple Watch sync: adversarial review
**VERDICT: sound with changes**

The diagnosis holds up against the code. I re-checked every blocker: `JSExport.swift:19` and `native-bridge.js` never set `.platform`, `Health.swift:637-653` rejects `appleExerciseTime`, `'workouts'` is never requested, and the local-midnight bucket anchor plus GMT formatter in `Health.swift:285-286,744` explain the UTC day shift. Where the design goes wrong is sequencing, one merge regression it would introduce, and a first-sync double count it doesn't see. The `git status` tree is clean; my probe was deleted.

## Correct, keep as is

- **Platform fix.** A1–A5, and switching to `isIOS()` from `src/utils/platform.ts:13-19`.
- **Auth fix.** Correct read list, a single shared `_authPromise`, the `isAvailable()` check, and deleting the `checkAuthorization` block.
- **Physiology resilience.** `Promise.allSettled` is available (the tsconfig lib is ES2020).
- **Strava guard (P0.4).** Consistent with `sources.ts:22-23` ("Strava always wins").
- **Post-sync steps (P0.5).** Mirrors `stravaSync.ts:159-182` and `activitySync.ts:36-71`, including the zero-rows case.
- **Physiology diagnoses.** UTC keys, pre-midnight sleep drop, HRV limit, merge freeze and the wrong-entry `restingHR` source (`appleHealthSync.ts:196,198,180,294,304-305`) are all confirmed. The `render()`-always-fires bug (`:106-107`) and the 14-day lookback (`:122`) are confirmed too.
- **Constants are all sourced from existing code.**
  - Zone edges 0.60/0.70/0.80/0.90: `sync-strava-activities/index.ts:79-96`.
  - 2-minute dedup window: `index.ts:469`.
  - 28-day lookback: `stravaSync.ts:26-27`.
  - Minimum of 2 HR samples: `trimp.ts:46`.
  - Nothing new is invented.
- **HR sequencing.** Doing HR ingestion (P1.6) only after the universalLoad normalisation fix is right.
- **UI bugs.** The "Change" button bug (`account-view.ts:1089-1092`), the source labels (`plan-view.ts:261,856`, `activity-detail.ts:73`), the helper at `renderer.ts:1304-1309`, and the Garmin-only Sync buttons are all confirmed.
- **Decisions D1–D7 and the device checklist.**

## Required changes

1. **Ship the physiology fixes (P1.1–P1.4) and decision D4 in the same build as P0.1. Ship P1.5 and P1.7 in it too.**
   - Every current Apple user has Strava plus Apple physiology (`wizard/steps/fitness.ts:130-131,176-181`). So P0.1 switches physiology on for all of them at once, and today nothing flows.
   - With P0 alone, readiness would take in partial nights, steps a day early, and "last daytime SDNN spot reading" HRV.
   - The HRV hard floor compares that single latest value (`home-view.ts:738-739`) against the all-history mean. A drop above 20% caps readiness at 74; above 30% it caps at 54 (`readiness.ts:378-381`).
   - Low sleep scores can trip the sleep cap below 60 (`readiness.ts:372-373`).
   - This would create false "Manage Load" days that don't exist today.
   - For users whose activity source is Apple, P1.5 must ship too: without it, strength, yoga and HIIT become walks and take run slots (audit D3, `matching.ts:52`).

2. **The P1.4 merge policy would introduce a regression.** `since = now − days` keeps the current time of day (`appleHealthSync.ts:171-173`).
   - The steps predicate is `.strictStartDate` from `since` (`Health.swift:785`), so the first day's bucket is partial. The first night is also cut off.
   - With `{...prev, ...entry}`, every 7-day foreground resync (`main.ts:619`) would overwrite that boundary day's full steps, sleep and HRV with partial values.
   - Fix, with no new constants:
     - Start the window at local midnight `days` ago; the steps buckets already anchor there (`Health.swift:744`).
     - Start the sleep query at noon the day before, reusing the existing noon boundary.
     - Only overwrite dates the window fully covers. Use `pickDefined` for the boundary date.

3. **The first Apple workout sync double-counts sessions the user already logged by hand.** Probe confirmed this:
   - A past-week slot already rated manually is excluded from `unratedWorkouts` (`activity-matcher.ts:663-666`).
   - The Apple run then falls to the "past week unmatched → adhoc" path (`activity-matcher.ts:~868-875`). That adds `actualTSS` (`:1047-1051`) and inflates CTL/ATL/ACWR, which is a false-high injury-risk path.
   - P1.8 widens this to 28 days. P1.7 can't catch it because manual ratings carry no start time.
   - This needs a new decision (D8). One option: on the first Apple workout sync, import only current-week rows, or skip past-week rows on days with a rated slot that has no `garminActual`. Persist a first-sync timestamp marker.

4. **Resume sync (P1.8) combined with P0.5 would nag.** P0.5 calls `resetPendingModalGuard()` and `processPendingCrossTraining()` unconditionally. On resume, that re-opens Activity Review for any unreviewed pending item every 5 minutes or more. Strava never syncs on resume.
   - On resume, don't reset the guard, and only process when `result.pending.length > 0`. Keep full Strava parity for boot and manual sync.

5. **Facts to correct in the design.**
   - **(a) Strava disconnect isn't reachable today for Apple users.** `account-view.ts:203` renders only `renderAppleRow()`. The Strava "Remove" buttons (`:328`, `:351`) live only in the Strava rows. The design's own P2.1 ("show the Strava row under Apple") makes it reachable, so P1.7 must land before or with P2.1. The "certain (b)" rating should be downgraded.
   - **(b) The ×1.28 factor doesn't reach any live threshold.**
     - `rmssdToHrvStatus` is reached only through `buildRecoveryEntryFromPhysio` ← `checkRecoveryAndPrompt` (`main.ts:525`), which has no caller.
     - Readiness uses relative drops (`readiness.ts:378-381`) and z-scores (`:644-662`), which don't depend on scale.
     - So the factor only changes displayed milliseconds and baselines mixed across sources when a user switches Garmin and Apple. Keep D4, but correct the rationale.
   - **(c) P1.5's claim that the targets are "already known" is partly wrong.** `ELLIPTICAL`, `STAIR_CLIMBING` and `WORKOUT` aren't in `mapGarminType`; they default to `'other'`, which is acceptable. `STAIR_CLIMBING` isn't in `formatActivityType`; it falls back to generic formatting. Pin these outcomes in tests.
   - **(d) Build reproducibility.**
     - `ios-plugins/guided-voice` isn't in git either (not in `git ls-files`, not in `package.json`).
     - Committed `capacitor.config.ts` still has `com.marathon.simulator` / "Marathon Simulator". `CHANGELOG.md` 2026-04-16 says `com.mosaic.training` / Mosaic.
     - P0.0 must enable HealthKit on the App ID actually in use. Warn that running `cap sync` from a clean checkout bakes in the wrong appId.

6. **Resting HR overwrites a value the user entered.**
   - Users can enter resting HR (`account-view.ts:751-756`). Both the current `:305` and the new P1.4 overwrite it unconditionally.
   - This is the same class of bug as the max-HR overwrite. Adopt whatever override policy the max-HR workstream chooses; this is a policy decision (D9), not a number.
   - It matters for load because the client-side iTRIMP fallback and enrich path use `s.restingHR` (`activity-matcher.ts:385-396`, `:512-518`).

7. **Sleep source selection in P1.2.**
   - Choosing "the source with the most asleep seconds" can pick a third-party app that writes unstaged `asleep` over the Watch's staged data. Deep and REM then become 0, which removes up to 45 points (weights 0.25 + 0.20, `appleHealthSync.ts:363`).
   - Instead, prefer the source that reports stages, then break ties by asleep seconds.
   - Also add to D3: folding at noon moves the tail of a lie-in past noon into the next night.

8. **P0.4 reintroduces a false success.** The Strava branch returns `ok: true` unconditionally, but `syncStravaActivities` swallows errors and returns `{processed:0}` (`stravaSync.ts:186-189`). Either surface `ok` from it, or word the message neutrally.

9. **P1.6 never backfills HR for rows processed before it ships.** It fetches HR only for unprocessed rows, and the enrich loop only acts when a row carries an iTrimp or zones (`activity-matcher.ts:494-507`). Apple rows ingested in the gap between P0 and P1.6 stay HR-less forever.
   - Decide between leaving them, or a one-time fetch for Apple actuals with no `avgHR`. Note the enrich path rewrites `actual.iTrimp`, so past load changes.
   - This only affects Apple-only users.

10. **P1.8 query order.** `ascending:true` with `limit:100` drops the newest workouts when there are more than 100. Use `ascending:false`, or `limit:0` and sort in JS.

11. **Testing constraints.** Vitest runs with `environment: 'node'` (`vite.config.ts`) and neither jsdom nor happy-dom is installed.
    - P0.5's `document.getElementById` needs `vi.stubGlobal('document', …)`. Mock `@/utils/platform` and `@capgo/capacitor-health`.
    - Add tests for:
      - boundary-day merge (item 2)
      - first sync over a manually rated slot (item 3)
      - no review re-popup on resume (item 4)
      - Account handler branching
      - `zonesFromStream` matching the edge function's `calculateHRZones`
      - the type-mapping table
      - sleep source preference (item 7)

12. **Docs.**
    - `docs/FEATURES.md:488` marks Apple physiology ✅, but it has never run. Downgrade it now, per the CLAUDE.md test-status rule.
    - Fold the plugin patch (P2.4) into the existing ISSUE-132 rather than opening a new issue.
    - Add SCIENCE_LOG entries as the design lists.

## Optional improvements

- **Request only what's needed.** Ask for HealthKit types per configuration: no `'workouts'` for Strava users, and no `calories`/`distance` unless a device test shows `HKWorkout` totals need them. That is better data minimisation and helps App Review. HealthKit prompts again only for newly added types.
- **Where HR code lives.** Put `zonesFromStream` in `src/calculations/` next to `trimp.ts`, and use a loop instead of `Math.max(...hr)`.
- **Priority of HR ingestion.** Every current Apple user gets workouts from Strava, so P1.6 only helps Apple-only users. Rank it below the physiology fixes.
- **Copy and colour rules.** The Home and Readiness "Sync" links use `var(--c-accent)` (`home-view.ts:1344`, `readiness-view.ts:347`), which breaks the CLAUDE.md navigation-colour rule. Fix them in the P2.1 pass.
- **First prompt for existing users.** They will get the HealthKit sheet at boot with no context. Consider a single in-app line first.
- **Dead code.** Delete the unused `main-view.ts:2672-2710` handler and `checkRecoveryAndPrompt` so they don't mislead future audits.
# 9. Anything else to be concerned about (ranked)
## Other concerns, ranked by what a typical Strava-connected marathon runner actually sees

Scope: the 57 audit findings minus the six fixes already planned (max HR, cut sizing / A1, B3 plus the Signal A bypass, B1, C1, and the Apple D-series). I re-checked items 0 to 8 myself in code, plus B10 and B5. Probe tests were written at `src/calculations/zz_probe_rank_k3.test.ts`, run, and deleted. The working tree is clean.

## 0. Check this before fixing anything: the CHANGELOG describes code that is not in the repo

This is not one of the 57 findings. It is the likeliest reason Tristan said "I thought that's how we built it".

- **24 missing functions.** The April 15–16 CHANGELOG sections name 24 functions that don't exist in `src/` or `supabase/`. `git log --all -S` finds none of them either, though this clone is shallow (last 50 commits).
- **Some of them are fixes for findings in this list:**
  - `computeLiveSameSignalTSB` and `computeReadinessACWR` are described at `docs/CHANGELOG.md:113-114` as the fix for Home, Readiness and coach TSB disagreeing (B4, item 4 below).
  - `computeTodayStrainTSS` (`CHANGELOG.md:241`) is the fix for B10.
  - `deriveAthleteTier` (`:227`) is the fix for tier going stale (related to B5).
  - `computeRenderedWorkouts` (`:289`) is a shared pipeline for applying mods.
  - `blended-fitness.ts` and `effective-vdot.ts` were meant to remove `wkGain`. `wkGain` still has 24 references in `src`.
  - `isAutoPaused` and `setAutoPauseEnabled` also appear in the CHANGELOG but not in the code.
- **Where the commits went.** Commit `03a3072` (2026-04-16) added 276 CHANGELOG lines but only the guided-runs code. HEAD `c3bb015` is the same commit as `origin/main`.
- **Same pattern as max HR.** The "median of top 5" fix was also documented but never committed.
- **What to do:** before starting the planned fixes, check Tristan's local machine for unpushed commits, stashes or other branches. Otherwise the fixes get written twice and will conflict when the lost work is pushed.

## Ranked list

**1. B2: planned easy and long runs are priced at RPE 3, so an on-plan easy day reads as overreaching.**
- **The mismatch.** Easy and long runs are generated with `rpe: 3` (`src/workouts/intent_to_workout.ts:54-55, 76-77`). The day target is minutes × `TL_PER_MIN[3]` = 0.65/min, about 39 TSS/h (`fitness-model.ts:630-639`). The actual comes from iTRIMP.
- **What the runner sees.** Above 130% of target the readiness score is capped at 34, "Ease Back" (`readiness.ts:402-411`), and the Home copy says the load was well exceeded. This happens 3 to 5 days every week.
- **Interaction with the max HR fix, computed** for an 8 km / 44 min easy run at 142 bpm, resting HR 50, 15000 normaliser:
  - With a spiked max HR of 216, the run scores **99%** of plan.
  - With the true max of 188, it scores **148%**.
  - So the spike currently hides B2. Fixing max HR will turn every on-plan easy day into "Ease Back" for exactly those users. B2 has to ship with or before the max HR fix.
- **How to fix it.** Reprice only the planned TSS. Don't change `w.rpe`: `rate()` compares the rated RPE against the expected one (`events.ts:~450`, `rpeDif = rpe - expected`), so changing it would move effort scores and VDOT.
- **Decision for Tristan: which rate.**
  - Option 1: RPE 4 (0.92/min), which is already used as the easy rate in `main-view.ts:2284` and the Tier-1 `EASY_TSS_PER_KM` (`activity-review.ts:1787`).
  - Option 2: derive the rate from the Z2 target HR through the same iTRIMP formula. This needs no new constants.
- **Related.** B15 has the same symptom on float days: float recoveries are not parsed, so 8×2 floats are planned about 47% low.

**2. The fast-finish long run is scheduled on Tuesday and Sunday is left empty. This affects every plan every third week.**
- **Cause.** The audit mentions this only as an aside under A4. `assignDefaultDays` finds the long run by `t === 'long'` only (`src/workouts/scheduler.ts:41`). The fast-finish variant is typed `'progressive'` (`intent_to_workout.ts:62-69`), so it goes into the quality pool.
- **Probe.**
  - Weeks 2, 5, 8, 11 and 14 of a 16-week plan put "Long Run (Fast Finish)" on day 1 (Tuesday), with nothing on Sunday.
  - This held for Balanced, Endurance and Speed plans at 4 to 6 runs a week, and for half, 10K and 5K plans.
  - The variant cycles every 3 weeks (`plan_engine.ts:351`).
- **Knock-on effects.**
  - The run gets none of the long-run protections: the suggester's long-run rules, the timing check, and the replace exclusion.
  - A runner who does it on Sunday anyway has no Sunday slot for Strava to match.
- **Status.** Not in OPEN_ISSUES. It doesn't depend on any planned fix and is cheap to fix.

**3. A2, A3 and A15: plan changes are computed from the unmodified plan, and the last one written wins.**
- **Cause.** `getWeekWorkoutsForReview` regenerates the week with no `workoutMods` (`activity-review.ts:69-81`). The review flow sizes adjustments against that and appends a new mod (`:1205-1209`, `:1252-1274`). The renderer applies mods in order and overwrites `status` and `d` each time (`plan-view.ts:1931-1951`).
- **Effect of stacking.** A later small session can reset an earlier bigger cut, or bring back a replaced run.
- **Timing suggestions.**
  - `mergeTimingMods` rebuilds suggestions from the raw plan and appends them last (`timing-check.ts:234-268`).
  - An accepted suggestion is saved as `'Timing accepted:'`, which `isTimingMod` doesn't recognise (`plan-view.ts:2683`). So the same suggestion comes back on the next sync.
  - Apply writes no `newRpe`.
- **Interaction with the cut-sizing fix.** With proportional cuts, small sessions produce small cuts, and those overwrite larger earlier ones. This has to be fixed in the same pass:
  - feed the suggester the week with mods applied;
  - replace a workout's existing mod instead of appending another.

**4. B4: on the same Home screen, the coach sentence and the readiness ring come from different TSB values.**
- **Cause.** The coach runs `computeSameSignalTSB(wks, s.w, …)` (`daily-coach.ts:199, 203`). The Home ring uses `s.w-1` (`home-view.ts:709-710`). The function applies a full week of decay to the in-progress week (`fitness-model.ts:1310-1330`).
- **Probe.** 5 steady weeks at 360 TSS, then a Monday with nothing logged yet:
  - coach TSB +172 (+24.6 a day), readiness 77 "Primed";
  - Home ring TSB 0, readiness 50 "Manage Load".
- **Where it shows.** The Home sentence is `coach.primaryMessage` (`home-view.ts:863-864`), and the coach modal and the LLM narrative get the inflated TSB. The gap is widest early in the week, every week. It is display only: `stance` is read only by `coach-modal.ts:164`.
- **Link to item 0.** The missing `computeLiveSameSignalTSB` was described as the fix for this.
- **Interaction.** The B1 seed fix touches the same seed argument (`signalBBaseline ?? ctlBaseline ?? 0`).

**5. A11 and A10: weekly load targets don't follow the plan through deload and taper weeks.**
- **Deload weeks.** Nothing ever sets `ph` to `'deload'`, so the 0.65–0.70 deload multipliers are never used. Deload weeks get the build or base target while the plan engine cuts volume to 0.80–0.90.
- **Taper weeks.** Every caller except Stats passes `weekInPhase` as undefined, so every taper week, race week included, targets 0.85 (`fitness-model.ts:775-779, 822-826`). Taper sessions are scaled 0.50–0.70.
- **What the runner sees.**
  - Following a deload or taper exactly shows about 10–40% "under plan" on the Plan bar and in the debrief.
  - Below −25% the debrief classes the week as under plan (`coach-insight.ts:54-58`).
- **Phantom carry (A10).** `computeDecayedCarry` judges earlier weeks against the current week's lower taper target (`fitness-model.ts:662-690`). So the first taper week starts at about 80/340 TSS before any training.
- **Frequency.** Every runner hits deload weeks every 3 to 6 weeks, plus the taper.
- **Interaction.** If the new cut sizing is proportional against a weekly target, this target has to be right first.

**6. C8: the Strava edge function computes iTRIMP with a resting HR of 55, not the athlete's own.**
- **Evidence.** `restingHR = physioRow?.resting_hr ?? 55` (`sync-strava-activities/index.ts:1001`, and `:734` in backfill). The client sends only `biological_sex` and `max_hr_override` (`stravaSync.ts:31-37`).
- **Who is affected.** Every Strava-only user and every Strava + Apple user.
- **Size.** Easy sessions for a runner with resting HR 45 read about 8–11% low. With resting HR 65 they read 10–14% high.
- **Interaction.** Fold this into the max HR fix. It is the same request payload, and the same "stored iTRIMP is never recomputed" problem applies. If that fix adds a recompute, it should trigger on a resting HR change as well as a max HR change.

**7. C5: the app mixes UTC dates with the phone's local time.**
- **Evidence.**
  - Plan week comes from the UTC date (`activity-matcher.ts:366-377`).
  - Weekday comes from local `getDay()` (`:118-121`).
  - Home's "today" is `toISOString()` (`home-view.ts:727`).
- **US users.**
  - From 17:00–20:00 local, Home's "today" becomes tomorrow's date.
  - Evening runs land on the next day in the daily strain.
  - A Sunday-evening long run is rated into next week's slot.
- **Australian users.** Monday runs before 10:00 are rated against last week's Monday slot.
- **UK users.** Only 00:00–01:00 BST, so it is invisible in UK testing. Its rank depends on where the users are.
- **Interaction.** None with the planned fixes.

**8. B10: turning on Apple Health will switch on the rest-day passive-load bug.**
- **Cause.** `syncAppleHealthPhysiology` sits behind the same broken `isNativeiOS()` check (`appleHealthSync.ts:157-158`). Once the Apple fix lands, Exercise-ring minutes feed Home's actual at 0.45 TSS/min (`fitness-model.ts:563-570`). Readiness (`readiness-view.ts:153`) and the coach don't include it.
- **What the runner sees.** About 40 minutes of brisk walking on a rest day gives "High load on a rest day". Before a run, Home can already show "Ease Back".
- **Two more consequences of the Apple fix.**
  - For Strava users, workouts never sync from Apple: Strava is always the activity source (`sources.ts:22`, `main.ts:386-397`). The fix only turns on physiology for them.
  - Apple physiology overwrites `s.restingHR`, including a value the user typed in (`appleHealthSync.ts:305`). This is the same pattern as the Garmin max HR overwrite.

**9. B5 and B6: the starting fitness baseline is too low, so the athlete tier reads low.**
- **Cause.** The EMA starts at 0 over only 8 to 16 fetched weeks (`stravaSync.ts:257-263`). With 8 weeks it reaches 0.74 of the true steady value, with 16 weeks 0.93.
- **Effect.** The tier sits about one band low (`:306-315`). Tier sets the ACWR safe upper limit and the phase multipliers.
- **Gap weeks (B6).** Weeks with no activity are dropped, which inflates the seed after a break.
- **What the runner sees.** An early "fitness rising" trend that is only the EMA catching up.
- **Interaction.** The B1 fix will pick a seed. If it falls back to `ctlBaseline`, this error carries into ACWR. After the Signal A fix, `ctlBaseline` also has to be on the same basis as in-plan Signal A.

**10. C6 and C4: two edge-function problems to fix while working on C1.**
- **C6.** The standalone sync fetches one page of 50 with no pagination (`index.ts:971-974`). Strava returns oldest-first with `after=`. Above 50 activities in 28 days (for example a watch that auto-uploads walks), the newest activities never reach the current week.
- **C4.** Two uploads of the same session (for example Zwift plus a watch) are both counted. History mode already collapses rows that start within 2 minutes of each other; standalone mode doesn't.
- **Why now.** Both live in the same function C1 touches.

**11. B11: Home targets ignore accepted plan changes.**
- **Evidence.** Home, Readiness and the coach apply only `workoutMoves`, not `workoutMods` (`home-view.ts:760-771`). The Strain view does apply them, and prices a replaced run at 1 TSS.
- **Effect.** After a Reduce or Replace, the two screens disagree about today's target.
- **Interaction.** More, and more accurate, cuts from the cut-sizing fix mean more of these mismatches.

**12. B12: female TSS is about 19% low against RPE-based targets.**
- **Cause.** iTRIMP uses β 1.67 for women, but the normaliser (the 15000 fixed value and the LTHR-based one) always uses 1.92 (`fitness-model.ts:265-271`).
- **Who is affected.** All female users. The tier is also placed low.
- **Interaction.** This partly offsets B2 for women today, so calibrate the B2 repricing and B12 together.

**13. C15: "Rebuild Plan from Strava Data" moves activities into the wrong weeks.**
- **Cause.** It copies old weeks onto the rebuilt plan by array index (`account-view.ts:841-869`). It also drops pending, adhoc and unspent items.
- **Who hits it.** It is rare in normal use and needs a deliberate tap. But it destroys data, and Tristan testing the app is the likeliest person to trigger it.

## Must be handled inside the planned fixes

These will otherwise break or re-surface as soon as the planned fixes land.

- **A5, with the A1 fix.** Once iTRIMP is normalised, HR-tracked sessions fall where `saturateCredit` amplifies credit (`universalLoad.ts:60-62`; TAU 800, CREDIT_MAX 1500). A 60-TSS ride then gives raw 33 but credit 61 (1.84x), which cancels the 0.55 runSpec discount.
- **C7, with the A1 fix.** Today, raw iTRIMP saturation hides the sport being collapsed to a generic bucket:
  - rowing is treated as walking;
  - yoga and soccer as generic sport;
  - an unplanned run falls back to runSpec 0.35.
  - After the A1 fix these differences start driving cuts for HR-tracked sessions too.
- **A6, with "proportional to work done".** The severity denominator and the km floor use only the runs still unrated. So the same session escalates from light to heavy late in the week.
- **A8, A7, A9 and A12, in the same cut engine.**
  - A8: a long run that has been cut is retyped as easy and loses its long-run protections.
  - A7: the recovery downgrade changes load only because of a pace-basis mismatch.
  - A9: the silent Tier-1 trim uses the flat baseline, not the phase target.
  - A12: combined RPE depends on how many items there are.
- **C9, with the max HR fix.** Edge-function zones are %maxHR bands and decide which session gets cut.
- **B17, with the B1 fix.** The Rolling Load view seeds ACWR with `atlSeed`, which is Signal A based. Fix the seed in both places or the drill-down will disagree with the headline.
- **B13 and B16, with the Signal A fix.** Both read Signal A:
  - B13: the Stats 16w/All chart uses ×1.4, a constant with no source that PRINCIPLES.md forbids.
  - B16: the coach modal's week-load row compares a partial week against a full-week target.

## Safe to ignore for now

| Finding | Why it can wait |
|---|---|
| B7 | The ACWR override has no effect; `recoveryDebt` is never set. |
| B8 | Continuous mode only. |
| B9 | In-app GPS runs count as zero load. Revisit if guided runs become the main way to record. I did not verify end-to-end that the guided-runs flow uses this path. |
| B14 | No-HR daily RPE only. |
| B18, B19, B20 | Legacy or display-only bookkeeping. |
| A13, A14, A16 | Narrow windows, need Apply, or copy only. |
| C2, C3 | Only after the user removes or reconnects Strava. |
| C10 to C14 | Garmin-only users with no Strava. Onboarding requires Strava. |
| D5 | Refuted by one reviewer; the planned Apple fix covers it anyway. |

Audit report: `load-accounting-audit.md` (same folder)
# Appendix: the three competing cut-sizing designs

## Design: restore-spec
### Proportional cut sizing: restore the documented design, fixing only units and caps

No repo files were changed. The single probe (`src/calculations/zz_probe_propcut_r9q4.test.ts`) was deleted, and `git status` is clean. Every number below comes from probe runs through the real `calculateWorkoutLoad`, `workoutsToPlannedRuns`, `computeUniversalLoad` and `buildCrossTrainingPopup`, with an inline prototype of the proposed algorithm.

#### 0. Summary

- **What the docs agree on.** The documents disagree on details, but all of them size the total cut by the same quantity: **the session's running-equivalent load** (Signal A = session load × runSpec).
  - PRINCIPLES.md:26-31 says Signal A is "Used for: Replace & Reduce decisions".
  - LOAD_BUDGET_SPEC.md:144 has `reductionTSS = excess × weightedRunSpec × recoveryMultiplier`.
  - Load-Reduction-Methodology.md §1/§2 builds its FCL from a "sport_transfer_factor" that it describes the way runSpec is described.
  - The code already computes this quantity: `rrcRaw` at universalLoad.ts:336-341, before saturation.
- **What breaks proportionality today:**
  - Raw iTRIMP enters the load currency unconverted.
  - The saturation curve has slope 1.875 at small values.
  - The per-run % caps.
  - The severity-based limit of 1/2/3 runs touched.
  - The severity gate on long-run cuts.
  - The overshoot cap is computed through the 25-km-clamped `equivalentEasyKm`.
- **The design:**
  - The budget is the unsaturated `rrcRaw`, with iTRIMP converted to load units using a ratio built only from two tables already in the code.
  - Remove every cap that is a size cap.
  - Keep only protection floors, which come from the Methodology and existing code.
  - Cut in PRINCIPLES protection order.
  - Result: no new constants, and about 60–80 changed lines in `universalLoad.ts` and `suggester.ts`.

#### 1. The algorithm

##### Plain English

1. **Measure the session in the plan's own currency.** Planned runs are scored in `calculateWorkoutLoad` units (Methodology §4, line 108).
   - HR sessions: iTRIMP → TSS (the athlete normaliser) → load units, using `LOAD_PER_MIN_BY_INTENSITY[rpe] / TL_PER_MIN[rpe]`. This is the exact inverse of the conversion the app already uses to show planned TSS (main-view.ts:1588, renderer.ts:1073).
   - No-HR sessions: unchanged (Tier C is already in load units).
2. **The budget is the session's running-equivalent load**: `baseLoad × runSpec × goalFactor`, not saturated. A 2× bigger session gives a 2× bigger budget.
3. **Excess and ACWR paths.** Scale that budget by `min(1, overshootTSS / sessionTSS)`. This is the formula CHANGELOG.md:599 says shipped on 2026-04-10, but it never did. The result equals `excess × runSpec` in load units, which is LOAD_BUDGET_SPEC §5.
4. **Recovery top-up.** `budget × (recoveryMult − 1)`, capped at 20 TSS converted with the same ratio (LOAD_BUDGET_SPEC §6).
5. **Spend the budget in protection order** (PRINCIPLES.md:66-73, :189; LOAD_BUDGET_SPEC §5 "Protection hierarchy"). Each run is cut until the budget is used or the run hits its floor:
   1. Easy runs first, in similarity order.
   2. Then the long run, shortened only.
   3. Then quality sessions, one step down, and only if the remaining budget covers the whole step.
   - New distances round to 0.5 km (Methodology:187).
6. **Whatever the floors block is reported as unabsorbed.** It is never forced onto another run. The modal already falls back to Push/Keep.

##### Pseudo-code

```
// universalLoad.ts
tierAPlus(iTrimp, rpe):
  tssB = normalizeiTrimp(iTrimp)                            // fitness-model.ts:289, athlete normaliser
  k    = LOAD_PER_MIN_BY_INTENSITY[rpe] / TL_PER_MIN[rpe]   // plan load units per TSS at this intensity
  base = tssB * k            // [* sportMult only if D1 = keep]
  return aerobic 0.85*base, anaerobic 0.15*base, tssB, k

computeUniversalLoad adds:
  signalBTSS        = tier=='itrimp' ? tssB : baseLoad * TL_PER_MIN[rpe] / LOAD_PER_MIN_BY_RPE[rpe]
  loadPerTSS        = tier=='itrimp' ? k    : LOAD_PER_MIN_BY_RPE[rpe] / TL_PER_MIN[rpe]
  runEquivalentLoad = baseLoad * runSpec * goalFactor        // == rrcRaw, NOT saturated

// suggester.ts buildCrossTrainingPopup
A      = load.runEquivalentLoad      (or budgetTSS * load.loadPerTSS for synthetic callers)
frac   = maxReductionTSS != null ? min(1, maxReductionTSS / load.signalBTSS) : 1
base   = A * frac
budget = base + min(base * (recoveryMultiplier - 1), 20 * load.loadPerTSS)
severity = computeSeverity(...)      // headline/copy only; no longer limits size

reduce(budget):
  for run in [easy runs by similarity] ++ [long] ++ [quality, least protected first]:
    if run.type in {easy, long}:
      lpk   = runLoad / km
      floor = easy ? EASY_FLOOR_KM                                        // D2
                   : max(MIN_LONG_KM, (floorActive ? 0.85 : 0.60) * km)   // D3
      newKm = max(floor, round05(km - min(remaining/lpk, km - floor, floorSlack())))
      if km - newKm >= 0.5: emit reduce; remaining -= (km - newKm) * lpk
    else if quality and not alreadyDowngraded:
      delta = load(type) - load(downgradeType(type))
      if remaining >= delta: emit downgrade; remaining -= delta          // D5: no overshoot
  unabsorbed = remaining

replace(budget): existing interleave (replace 1 → reduce 1), same floors, no % caps,
                 replace only if remaining >= runLoad, pool = easy runs only (D6)
```

**Why this is defensible.**
- **Banister impulse-response.** The model is linear in load, so a compensating cut should also be linear in the session's load. Flat caps and severity buckets are not supported by the model; Methodology principle 1 rejects them explicitly (line 12).
- **Signal A is conserved.** Removing the session's Signal A from the remaining runs keeps the week's running-specific load, and so the planned ramp against Signal A CTL, where the plan put it.
- **Signal B is handled elsewhere.** The part runSpec does not transfer (TSS × (1 − runSpec)) is left to the Signal B excess and ACWR paths.
- **Floors are protection rules** (minimum session, long-run structure). They are not sizing rules.

**Known weaknesses:**
- runSpec values are expert estimates (SCIENCE_LOG:770). They now set the size directly; before, the caps hid them.
- The per-RPE ratio k is not monotonic: 1.846 at RPE 3, 1.630 at RPE 4, 1.739 at RPE 5. That shows the two tables were not calibrated together, and misreading the session's RPE shifts the budget by up to about ±12%.
- Tier A+ keeps its fixed 85/15 aerobic/anaerobic split.
- The model is linear, with no diminishing returns for very long sessions (see D9).

#### 2. Functions that change

| File:line | Change |
|---|---|
| `universalLoad.ts:99-119` `computeTierAPlus` | New signature `(iTrimp, rpe, explanations)` with the conversion above. Drop `sportMult` per D1. |
| `universalLoad.ts:274-285` | Pass `defaultRpe(input.rpe)` into Tier A+. |
| `universalLoad.ts:322-344` | Return `signalBTSS`, `loadPerTSS` and `runEquivalentLoad` (= `rrcRaw` from :336-341). `saturateCredit` is no longer used for sizing. |
| `universalLoad.ts:369-372` | `equivalentEasyKm` is no longer used for sizing. The suggester recomputes it as `A / (easy load per km)`, taken from the week's first easy `PlannedRun`, or from `calculateWorkoutLoad('easy','10km',30,ctx.easyPaceSecPerKm)/10` when there is none. This retires `EASY_LOAD_PER_KM = 12`. |
| `universal-load-types.ts` `UniversalLoadResult` | Add the 3 fields. |
| `fitness-model.ts:289` | Export `normalizeiTrimp`. No import cycle: fitness-model imports only types, constants, `activities` and `readiness`. |
| `suggester.ts:490-492`, `:705-707` | Delete the severity → 1/2/3 limit on runs touched. |
| `suggester.ts:513-518` | Put volume first for every runner type: easy, then long, then quality (D4). |
| `suggester.ts:549-555` | Downgrade only if `remaining >= delta`. Remove the ISSUE-137 overshoot (D5). |
| `suggester.ts:578-611` | Replace the easy cap `runKm*0.40` with the easy floor and 0.5 km rounding. |
| `suggester.ts:633-649` | Remove the `severity !== 'light'` gate, the `*0.25` cap and the 1.0 km minimum. Long-run floor per D3. |
| `suggester.ts:776, :800-811` | Same for Replace (remove `*0.5`, `*0.3`, the severity gate and the 1.0 km minimum). Replace pool at `:730-736` becomes easy runs only (D6). |
| `suggester.ts:944, :1021-1047` | Budget from `runEquivalentLoad`. The recovery guardrail becomes `20 * loadPerTSS`, replacing `20*15`. The cap becomes the dimensionless fraction. Delete the dampening at `:1039-1044`. |
| `suggester.ts:1068` | `budgetWasCapped = frac < 1 \|\| maxAdjustments != null`, which keeps the "no replacements when capped" rule. |
| `suggester.ts:890-915` | Add an optional `budgetTSS` parameter, used only by synthetic callers. Optionally add `reductionBudget` and `unabsorbedLoad` to the payload. |

| Caller | Change |
|---|---|
| `activity-review.ts:1222`, `:1845` | None required. D10 recommends per-item budgets. |
| `activity-review.ts:1779-1792` (Tier 1) | D8: `excess × computeWeightedRunSpec(wk) / (TL_PER_MIN[easyRun.rpe] × s.pac.e/60)`. Today it is `excess / (TL_PER_MIN[4]×6)`, which ignores sport, uses RPE 4 while planned easy runs are RPE 3 (intent_to_workout.ts:54), and hardcodes a 6:00/km pace. |
| `excess-load-card.ts:326-333` (synthetic) | Pass `budgetTSS = excess × computeWeightedRunSpec(wk)`. That function exists at `:219` but is never called; this is LOAD_BUDGET_SPEC §5 literally. Today the synthetic `'cross_training'` activity gets the undocumented unknown-sport runSpec 0.35 (universalLoad.ts:80-86). |
| `excess-load-card.ts:370` | None. `excess` now works through the fraction. |
| `excess-load-card.ts:460` (carry-over) | Pass the decayed carried TSS as `maxReductionTSS`. Today it is uncapped, so next week absorbs the full session rather than the carried amount. |
| `main-view.ts:2220-2226` (synthetic) | Pass `budgetTSS = excessTSS`, with runSpec per D7. |
| `main-view.ts:2312` | None. `maxAdjustments = 1` stays so the modal copy is still true. It rarely binds, because a ≤5% overshoot gives a small budget anyway. |
| `events.ts:1756`, `:1882`; `recording-handler.ts:174` | None. These are Tier C and automatically proportional. The GPS extra-run anomaly (credit 49 > own load 26) disappears with saturation removed. |

#### 3. Fixing the raw-iTRIMP unit bug

```
tssB     = iTrimp * 100 / athleteNormaliser        // SCIENCE_LOG:568, Coggan hrTSS; fallback 15000
k(rpe)   = LOAD_PER_MIN_BY_INTENSITY[rpe] / TL_PER_MIN[rpe]
baseLoad = tssB * k(rpe)
```

- **Where `rpe` comes from.** It is already on every activity. For synced items it is HR-derived (`deriveItemRPE` → activity-matcher.ts:226-240); on the combined activity it is a duration-weighted average.
- **Measured k values:** 1.667, 1.778, 1.846, 1.630, 1.739, 1.724, 1.966, 2.027, 2.000, 2.000 for RPE 1–10.
- **Effect on a 60-TSS HR ride:**
  - baseLoad goes from 6,750 to **104.3**, in the same currency as an 8 km easy run (59.5) and a week total of 414.
  - FCL/week falls from 15.5 to 0.24, so severity goes from "extreme" to "light".
  - Similarity ranking (`LOAD_SMOOTHING` 30) works again for HR sessions.
- **Why the athlete normaliser.** `computeWeekRawTSS` (fitness-model.ts:429/449) uses it, so the excess-path fraction `excess / signalBTSS` is in one scale. The UI sites that hardcode 15000 are an existing inconsistency (risk R5).
- **Tier A** (Garmin aerobic/anaerobic loads) cannot be reached from any caller: all 7 `createActivity` calls pass `undefined` loads.
- **Tier B** (zone minutes only, no iTRIMP) gets `signalBTSS` through the Tier C inverse. That is approximate; see R7.

#### 4. Constants

| Constant | Where | Status |
|---|---|---|
| `TL_PER_MIN` | sports.ts:11-22 | SOURCED (SCIENCE_LOG "Sport-Specific Constants", calibration checks) |
| `LOAD_PER_MIN_BY_INTENSITY` | sports.ts:165-176 | SOURCED ("Garmin-calibrated"; SCIENCE_LOG "Workout Load Profiles") |
| `LOAD_PER_MIN_BY_RPE` (Tier C inverse) | universal-load-constants.ts:139-150 | SOURCED (SCIENCE_LOG:806). Differs from the table above by ≤8% (NEEDS TRISTAN: merge later) |
| iTRIMP normaliser / 15000 fallback | fitness-model.ts:265-291 | SOURCED (SCIENCE_LOG:568) |
| `mult`, `runSpec`, `recoveryMult` | SPORTS_DB, sports.ts:47-73 | SOURCED ("expert estimates"). **runSpec now sets cut size directly.** |
| goalFactor 1.05−0.20r / 0.95+0.20r | universal-load-constants.ts:209-221 | SOURCED (SCIENCE_LOG:756) |
| Tier C active fraction, 0.80 penalty | universal-load-constants.ts:93-127 | SOURCED (SCIENCE_LOG:713) |
| Tier A+ 85/15 split | universalLoad.ts:110 | SOURCED as a known limitation (SCIENCE_LOG) |
| Recovery multiplier 1.00/1.15/1.30/1.50, +20 TSS guardrail | LOAD_BUDGET_SPEC.md:192-205 | SOURCED |
| Easy floor: 30 min at easy pace **or** `MIN_EASY_KM` 4 | Methodology:186 / suggester.ts:169 | Both SOURCED. **NEEDS TRISTAN (D2)** |
| Long-run floor 60% | Methodology:250 | SOURCED |
| Long-run floor 85% when weekly km floor active | suggester.ts:643, CHANGELOG:1204 | Existing, no rationale. **NEEDS TRISTAN (D3)** |
| `MIN_LONG_KM` 10 | suggester.ts:170 | SOURCED (Python design) |
| 0.5 km resolution, which also gives the "skip cuts < 0.5 km" rule | Methodology:187 | SOURCED (previously undocumented, same number) |
| Weekly km floor | fitness-model.ts:1225, CHANGELOG:2045 | SOURCED, unchanged |
| Preserve ≥ max(2, ceil(0.55·n)) runs | suggester.ts:182-183 | Unchanged; the Python design had 0.5/1. NEEDS TRISTAN (not blocking) |
| Severity 0.25 / 0.55 | suggester.ts:291/297 | Copy only now. No literature; NEEDS TRISTAN only if the copy matters |

**Removed from sizing:**
- The 0.40 / 0.5 / 0.25 / 0.3 caps.
- `MAX_ADJUSTMENTS_*` 1/2/3.
- Dampening at 0.35 / 0.65.
- `20*15`.
- `EASY_LOAD_PER_KM` 12.
- `MAX_EQUIVALENT_EASY_KM` 25 in the budget.
- The 0.92 and 360 in `fullRrcTSS`.
- `TAU` / `CREDIT_MAX` (saturation).
- The 1.0 km long-cut minimum.
- `minLoadThreshold` 5 in the reduce loop (the 0.5 km rule replaces it).

**No new constants are introduced.**

#### 5. Protecting quality sessions and the long run

- **Quality sessions:**
  - They are reached only after every easy run is at its floor and the long run is at its floor.
  - A quality session drops at most one step (`downgradeType`), and only when the remaining budget covers the whole step, so there is no overshoot.
  - A quality session is never removed in Reduce. In Replace, the pool is easy runs only (D6; PRINCIPLES "Quality workouts are never auto-removed").
  - When a hard session falls the day before a quality run, the downgrade comes from the existing timing check (`timing-check.ts`), not from the budget.
- **Long run:**
  - Shortened only, after easy runs, down to max(10 km, 60%), or 85% while ACWR is safe/low.
  - Never replaced (`canReplaceWorkout`, suggester.ts:315, plus the pool filter at `:731`).
  - Never downgraded in intensity: `long` is not a quality type.
- **Not restored, and why:**
  - Methodology §5 runner-type × sport weights: PRINCIPLES.md:189 (newer) says to cut easy volume first "regardless of cross-training intensity type" (D4).
  - §6 Step 3 fractional step split: substantial new code in `applyAdjustments` (D9).
  - §6 pro-rata spreading across runs: the existing greedy fill matches PRINCIPLES Tier 1 "nearest easy run" (D11).
  - The Methodology "2 protected runs, no volume cut" (:251) contradicts its own :250 and PRINCIPLES:72; flagged, not followed.

#### 6. Worked examples

**The week:** marathon plan, easy pace 6:00/km, Balanced runner. Weekly km floor 20.
- Easy 8 km: load 59.5, which is 7.44 per km.
- Threshold 10 km: load 199.0. Its one-step downgrade is worth 45.5.
- Long 20 km: load 155.5, which is 7.78 per km.
- Week total: 414.

**The columns:**
- "Safe" means ACWR safe: the weekly floor is active and the long-run floor is 85%.
- "Caution" means ACWR caution or high: the long-run floor is 60%.
- The easy floor is 30 minutes (5 km).
- "Today" uses the current code, under ACWR safe.

| Session | Signal B / Signal A TSS | Budget (load) ≈ easy km | Today, Reduce | Proposed, safe | Proposed, caution |
|---|---|---|---|---|---|
| 30-min easy spin, HR, ~20 TSS (RPE 3) | 20 / 11.2 | 20.7 ≈ 2.8 | "Very heavy": easy 8→4.8, long 20→17, threshold→MP | easy 8→5 (**−3 km**) | same |
| 45-min HIIT, HR, ~50 TSS (RPE 6; gym→strength, runSpec 0.35) | 50 / 17.9 | 30.8 ≈ 4.1 | same as the spin | easy 8→5, long 20→19 (**−4 km**) | same |
| 60-min ride, no HR, RPE 5 | 39.3 / 22.1 | 38.4 ≈ 5.2 | easy 8→4.8 (−3.2 km, capped) | easy 8→5, long 20→18 (**−5 km**) | same |
| 60-min ride, HR, ~60 TSS (RPE 5) | 60 / 33.7 | 58.5 ≈ 7.9 | same as the spin | easy 8→5, long 20→17 (**−6 km**; about 1.7 km-eq unabsorbed) | easy 8→5, long 20→15.5 (**−7.5 km**) |
| 2-h hard ride, HR, ~150 TSS (RPE 6) | 150 / 84.2 | 145.1 ≈ 19.5 | same as the spin | −6 km + threshold→steady (54 load unabsorbed) | easy 8→5, long 20→12, threshold→steady (**−11 km + 1 step**) |

**How it scales:**
- **Budgets are strictly linear.** Km cuts rise monotonically with Signal A until floors bind.
- **Today every HR session gives the identical result:** −6.2 km plus a downgrade. The Replace option deletes the easy run for all of them.

**Sweep: HR cycling at RPE 5, caution.**

| Session TSS | 5 | 10 | 15 | 20 | 30 | 45 | 60 | 90 | 120 | 150 |
|---|---|---|---|---|---|---|---|---|---|---|
| Km cut | 0.5 | 1.5 | 2 | 2.5 | 4 | 6 | 7.5 | 11 | 11 | 11 + step |

- Today the result is −6.2 km plus a downgrade at every value.
- Under safe, the week tops out at −6 km from 45 TSS.
- **With the 4 km easy floor (D2):**
  - The 60-TSS ride cuts 7 km under safe (7.5 km under caution, unchanged).
  - HIIT becomes easy 8→4 only.
- **If `sportMult` is kept on the HR path (D1):** the 60-TSS cycling budget drops to 43.9 load, about 5.9 km, and HIIT rises to 33.9.

**Excess path.** The 60-TSS HR ride is the unspent item; caution.

| Overshoot TSS | 5 | 10 | 20 | 40 | 60 or more |
|---|---|---|---|---|---|
| Km cut | 0.5 | 1.5 | 2.5 | 5 (easy −3, long −2) | 7.5 |

- 60 or more is capped at the ride's own Signal A.
- That is about 0.13 easy-km per TSS for cycling, 0.24 for `extra_run` and 0.05 for swimming. **The sport now matters in this path.** Today it cancels out: every sport gave 2.3–2.4 km at 8 TSS.
- Tier 1 today gives 0.18 km/TSS regardless of sport. Under D8 it would give 0.14 km/TSS for cycling.

#### 7. Risks and tests

**Risks:**
- **R1. Visible changes to cut sizes.**
  - HR users get much smaller cuts for small sessions, and larger cuts at the top end when ACWR is elevated.
  - No-HR 60-min rides go from −3.2 to −5 km.
  - runSpec values, never validated, now drive the cut size.
- **R2. Floors saturate small weeks.** Unabsorbed load needs surfacing; add `unabsorbedLoad` so the modal can show Push/Keep.
- **R3. Mixed batches are undercounted.** `buildCombinedActivity` (activity-review.ts:1938-1940) drops no-HR items when any item has HR, and applies the dominant sport's runSpec to everything. The fix is to sum budgets per item (D10).
- **R4. Two downgrades on one session.** A timing-check mod and a budget downgrade can land on the same quality session. Skip runs that carry a `Timing:` mod.
- **R5. Normaliser mismatch.** UI TSS labels use 15000 while the budget uses the athlete normaliser, a difference of about 10–20% on labels.
- **R6. HR and no-HR disagree on the same ride.** Tier C rates a 60-min RPE-5 ride at 39 TSS against 60 with HR, so no-HR users get about 35% smaller cuts. This is a calibration issue that already exists.
- **R7. Tier B has no sourced TSS conversion.**
- **R8. The ISSUE-138 recovery fallback likely does nothing.** Easy→recovery has near-zero delta because both use RPE 3 at a slower pace (8 km: 59.5 vs ~59.9). Unrelated to this change, but it will surface once caps stop masking things.
- **R9. Existing tests that change.**
  - `km-budget.test.ts` uses `popup.runReplacementCredit` as the budget; move it to the new `reductionBudget`.
  - The ISSUE-137 tolerance at `:162` tightens under D5.
  - The boxing equivalent-km band in `boxing-bug.test.ts:242` still passes (about 3.5 km).

**Tests to add:**
1. Tier A+ `baseLoad == tssB × k(rpe)`, compared against a hand-computed value.
2. Budget is linear: doubling iTRIMP doubles the budget (no saturation).
3. Km removed never decreases across a 5–200 TSS sweep.
4. While no floor binds, `|used − budget| ≤ 0.5 km × lpk`.
5. No quality downgrade while any easy run is above its floor.
6. A downgrade never exceeds the remaining budget.
7. The long run is only cut after easy runs reach their floor, never goes below its floor, and is never replaced.
8. Excess path: the budget equals `A × min(1, excess/signalBTSS)`, and at equal excess the cut ranks swim < cycle < extra_run.
9. The recovery extra is ≤ `20 × loadPerTSS`.
10. A 20-TSS HR spin has severity 'light'.
11. `equivalentEasyKm` equals the km cut when no floor binds.
12. The synthetic paths produce budgets proportional to `budgetTSS`.

#### 8. Decisions for you

1. **D1.** Drop `sportMult` on the HR path?
   - Recommended: drop. The Python reference (cross-training-replacement-code.md:78) says mult "scales RPE-based load estimate". PRINCIPLES Signal A is iTRIMP × runSpec, which also matches the week accounting at activity-review.ts:1294.
   - SCIENCE_LOG:692 currently documents keeping it.
2. **D2.** Easy floor: 30 minutes (Methodology) or 4 km (current)?
3. **D3.** Long-run floor while ACWR is safe: 85% (current) or 60% (Methodology)?
4. **D4.** Volume first for every runner type (PRINCIPLES), or restore the Methodology §5 runner-type split? FEATURES.md:290 currently says intensity first for Balanced and Endurance runners.
5. **D5.** Drop the ISSUE-137 "first downgrade may exceed budget" allowance? Recommended: yes.
6. **D6.** Limit the Replace pool to easy runs only?
7. **D7.** ACWR synthetic path: runSpec-discounted budget (LOAD_BUDGET_SPEC) or removing Signal B 1:1 so the week actually returns under the ceiling?
8. **D8.** Align Tier 1 with runSpec and the plan's easy-run TSS per km?
9. **D9.** Build the Methodology Step 3 fractional split later? Do you want diminishing returns for very long sessions? That would need TAU re-derived in load units; no number is proposed.
10. **D10.** Sum budgets per item for multi-activity batches?
11. **D11.** Greedy fill (keep) or Methodology pro-rata spreading?
## Design: tss-currency
### Proportional cut sizing in one currency (TSS)

#### 0. Summary

- **The rule.** Price the session and every planned run in TSS. The TSS to remove is the session's running-equivalent TSS, which is Signal B × runSpec. Each run's cut in km is that TSS divided by the run's own TSS per km. An easy run is replaced only when the TSS still to remove is at least that run's full TSS. After that come the floors and the protection order. There are no percentage caps and no count of runs by severity.
- **Checked with the real functions** (probe: `estimateWorkoutDurMin`, `TL_PER_MIN`, `workoutsToPlannedRuns`, `applyAdjustments`, and the current `buildCrossTrainingPopup` for the "before" numbers).
  - **Today:** every HR session from 5 to 200 TSS gets the same result: "extreme", easy run 8→4.8 km, long run 20→17 km, threshold downgraded.
  - **With this design:** the removed TSS rises with the session. It is 2.7, 5.5, 8.2, 10.9, 15.6, 22.0, 27.7 and 55.1 TSS. The rest is reported as "not absorbed" rather than dropped silently.
- **Files.** Probe files `zz_probe_tsscut7d/7e` were deleted. `src/calculations/zz_probe_propcut_r9q4.test.ts` belongs to another agent and was not touched. No other file was modified.

---

#### 1. The algorithm

##### Why it holds up (for SCIENCE_LOG)

- **Common unit.** TSS is Banister/Morton iTRIMP normalised with Coggan's hrTSS rule: 1 hour at LTHR = 100 (SCIENCE_LOG:568-588, `computeAthleteNormalizer` fitness-model.ts:264).
- **Loads add up.** The Banister impulse-response model is linear in daily load. Taking X TSS of running out of the week offsets X TSS of added running-equivalent load in both the fitness sum and the fatigue sum.
- **How much a session replaces.** This is Signal A (TSS × runSpec). That follows PRINCIPLES.md:59 (the "Replace a run with cross-training? → A" row), SCIENCE_LOG:1542-1550 and LOAD_BUDGET_SPEC §5 and §11 ("Detect with Signal B, reduce with Signal A").
- **Weak points:**
  - runSpec values are expert estimates (SCIENCE_LOG:802).
  - Equal TSS does not mean equal adaptation: intensity spread and specificity differ.
  - Planned runs are priced by their planned RPE, not measured (see risk R1).
  - Linear substitution has no built-in diminishing returns. The floors do that job instead.

##### In plain English

1. **Measure the session in TSS (Signal B).**
   - With HR: iTRIMP × 100 ÷ the athlete's normaliser.
   - Without HR: minutes × `TL_PER_MIN[rpe]`.
   - These are the same formulas `computeWeekRawTSS` uses, so the cut matches the week's load bar.
2. **Work out the TSS to remove.** Each caller does this in one line:
   - **Session paths** (Activity Review, manual log, GPS extra run): Σ session TSS × that sport's runSpec. Optionally capped at the week's projected Signal B overshoot (D2).
   - **Excess card and Tier 1:** excess × weightedRunSpec, per LOAD_BUDGET_SPEC §5. Plus a recovery top-up of at most 20 TSS (§6).
   - **ACWR card:** acute − safeUpper × chronic, with no runSpec discount (D1).
3. **Price each remaining planned run in TSS** with the plan bar's own formula: `estimateWorkoutDurMin × TL_PER_MIN[rpe]`. TSS per km = run TSS ÷ planned km.
4. **Spend the TSS in the protection order** (PRINCIPLES.md:69-76):
   - **Easy runs.** Cut km = remaining ÷ TSS per km, down to the easy floor. In Replace mode, delete the run whole if remaining ≥ its TSS.
   - **Long run.** Distance only, down to the long-run floor. Its type stays `long`.
   - **Quality sessions.** One step down in intensity, only if the TSS that step saves is no more than what remains. Never replaced and never shortened.
5. **Return the adjustments, the TSS removed, and the TSS left over.** The modal shows the left-over TSS.

##### Pseudo-code

```ts
// fitness-model.ts: one pricer for sessions and one for plans
iTrimpToTSS(it, norm?)        = it * 100 / (norm ?? _athleteNorm)             // today's private normalizeiTrimp, :289
sessionSignalBTSS(x, norm?)   = x.iTrimp > 0 ? iTrimpToTSS(x.iTrimp, norm)
                                : x.durationMin * (TL_PER_MIN[round(x.rpe ?? 5)] ?? 1.15)   // mirrors :448-454, :476
priceWorkoutTSS(w, baseMinKm) = (w.status==='replaced'||w.status==='skip') ? 0
                                : estimateWorkoutDurMin(w, baseMinKm) * (TL_PER_MIN[round(w.rpe ?? w.r ?? 5)] ?? 1.15)  // body of :630-639

// Callers: TSS to remove
sessionRemove  = min( Σ_i sessionSignalBTSS(item_i) * runSpec(item_i),  projectedOvershootB ?? ∞ )   // D2
excessRemove   = base + min(base * (recoveryMult - 1), 20)
                   where base = min(excess, Σ itemB || excess) * weightedRunSpec
acwrRemove     = max(0, acute - safeUpper * chronic)                                                 // D1

// suggester.ts: allocator (replaces buildReduceAdjustments and buildReplaceAdjustments)
allocate(removeTSS, runs /* priced, plan WITH mods applied */, mode, ctx):
  rem   = removeTSS
  slack = floorActive ? (completedRunKmThisWeek + Σ runs.km) - ctx.floorKm : ∞   // A6: whole week
  keep  = max(MIN_PRESERVED_RUNS, ceil(plannedCount * PRESERVE_RUN_FRACTION)); left = plannedCount
  for r in easyRuns ordered by days after the session (D6):
     if rem <= 0: break
     if mode=='replace' && rem >= r.tss && left > keep && canReplace(r) && r.km <= slack:
        emit replace(r); rem -= r.tss; slack -= r.km; left--; continue
     cut = min(rem / r.tssPerKm, r.km - MIN_EASY_KM, slack); newKm = round1(r.km - cut); cut = r.km - newKm
     if cut < 0.5: continue
     emit reduce(r, newKm, type unchanged); rem -= cut * r.tssPerKm; slack -= cut
  for r in longRun (r.isLongRun):
     cut = min(rem / r.tssPerKm, r.km - LONG_FLOOR(r), slack) ... skip if cut < 1.0
     emit reduce(r, newKm, newType = 'long'); rem -= cut * r.tssPerKm
  for q in quality ordered by D5:
     d = downgradeWorkout(q.workout)                 // same transform applyAdjustments applies, rpe = generator RPE of new type
     delta = q.tss - priceWorkoutTSS(d)
     if delta <= 0 || delta > rem: continue          // never remove more than asked
     emit downgrade(q, d); rem -= delta
  return { adjustments, removedTSS: removeTSS - rem, unabsorbedTSS: max(0, rem) }
```

**Invariant (test it):** for every adjustment, the TSS removed equals `priceWorkoutTSS(before) − priceWorkoutTSS(after applyAdjustments)`. The plan bar then drops by exactly what the modal claims.

---

#### 2. What changes (file:line)

##### Core

| File:line | Change |
|---|---|
| `src/calculations/fitness-model.ts:289` | Export `normalizeiTrimp` as `iTrimpToTSS`, so every sizing path uses the athlete normaliser. |
| `fitness-model.ts:630-639` | Extract `priceWorkoutTSS` from `computePlannedDaySignalBTSS` and have the day function loop over it. Replaced or skipped runs price at 0. Today `'0km (replaced)'` parses as a 1-minute run. |
| `fitness-model.ts` (new) | `sessionSignalBTSS`, as above. |
| `fitness-model.ts` (new) | `projectedWeekOvershootB`. It moves the logic at main-view.ts:2273-2297 and replaces its `TYPE_RPE` table and 0.85 pace factor with `priceWorkoutTSS`. |
| `src/cross-training/universalLoad.ts:99-119, :256-400` | Tier A+ becomes `tss = iTrimpToTSS(iTrimp)`, with no sportMult. Add `tss` and `runEquivTSS = tss × runSpec` to the result. FCL, RRC, saturation and `equivalentEasyKm` (:330-344, :369-372) stop driving sizing. The aerobic/anaerobic split is kept for classification only. |
| `src/cross-training/suggester.ts:42-51, :1201-1238` | `PlannedRun` gains `plannedTSS`, `tssPerKm`, `isLongRun` and a reference to its `workout`. `isLongRun` also covers `'Long Run (Fast Finish)'` and `'Float Long Run'`, per audit A8. |
| `suggester.ts:478-881` | `buildReduceAdjustments` and `buildReplaceAdjustments` become the single `allocate(mode)`. This removes the 0.40, 0.5, 0.25 and 0.3 caps (:579, :776, :639, :804), `MAX_ADJUSTMENTS_*` (:186-188), the downgrade RPE table (:541-544, :752-755), the severity gate on long runs (:633, :800) and the easy→recovery "downgrade" (:584-602). That last one is a zero-TSS change in this currency: both are RPE 3 and `estimateWorkoutDurMin` has no recovery pace. |
| `suggester.ts:890-1194` | `buildCrossTrainingPopup` takes `removeTSS` instead of `recoveryMultiplier`, `maxReductionTSS` and `maxAdjustments`. Delete :1021-1057 (the `20*15` top-up, the 0.92 cap, the 0.35 and 0.65 damping) and :1068-1073. `computeSeverity` (:277-301) only sets the headline, as B × recoveryMult ÷ the whole week's planned run TSS. `equivalentEasyKm` = A ÷ the athlete's easy TSS per km. |
| `suggester.ts:1300-1343` | A downgrade writes `rpe` and `r` using the generator RPE for the new type. Today only the fast-finish branch at :1313 does, so `newRpe` keeps 7 and the plan bar never drops. |
| `suggester.ts:666, :819` | A long-run cut keeps `newType = originalType`. |
| `universal-load-constants.ts:83, :86, :228, :231` | TAU, CREDIT_MAX, `EASY_LOAD_PER_KM` and `MAX_EQUIVALENT_EASY_KM` are no longer used for sizing. |

##### Callers

| File:line | Change |
|---|---|
| `src/ui/activity-review.ts:1918-1956` (`buildCombinedActivity`) | Price each item on its own. Today, if any item has HR, the no-HR items contribute 0 (:1938-1940). |
| `activity-review.ts:1222`, `:1845` | Pass `sessionRemove`. |
| `activity-review.ts:1294`, `:1902` | Replace the hardcoded 15000 with `iTrimpToTSS`. |
| `activity-review.ts:1776-1816` (Tier 1) | Call `allocate(reduce)` on the first easy run with `excess × wRS`, instead of `excess ÷ (TL_PER_MIN[4] × 6)`. |
| `src/ui/excess-load-card.ts:281-335` | Per-item TSS. The synthetic `excess*150` and `excess*2` (:330-332) go. |
| `excess-load-card.ts:219-253` | Call `computeWeightedRunSpec`, which is currently never called. Replace its 15000 at :222. |
| `excess-load-card.ts:366-370` | Pass `excessRemove`. |
| `excess-load-card.ts:428-492` | `_triggerCarryoverToNextWeek` has no callers. Delete it. |
| `src/ui/main-view.ts:2202-2235, :2270-2312, :2325` | ACWR path uses `acwrRemove`. Delete `max(50, ctl)`, the 55 TSS/h conversion, the 5-minute minimum, `TYPE_RPE` and `maxAdjustments`. |
| `src/ui/events.ts:1756`, `:1882` | Manual log, no HR: `sessionSignalBTSS(dur, rpe) × runSpec`. |
| `src/gps/recording-handler.ts:174` | Extra run, runSpec 1.0. |
| `src/ui/suggestion-modal.ts:145-146` | Equivalent-km copy, plus a line for unabsorbed TSS. |
| All callers | Build `weekRuns` from the plan **with workoutMods applied** (audit A2: `getWeekWorkoutsForReview`, `getWeekWorkoutsForACWR`), and upsert mods by name+day instead of appending. |

##### Existing tests that change

- `src/cross-training/km-budget.test.ts`: load-unit budgets.
- `boxing-bug.test.ts:230`: expects "2–3 km"; the new result is 69 × 0.25 ÷ 3.9 = 4.4 km.
- `universalLoad.test.ts`: Tier detection, goal factor, extreme, and the MAX_MODS assertions.

---

#### 3. Fixing the raw-iTRIMP unit bug

- **What is wrong.** `computeTierAPlus` (universalLoad.ts:106) uses `iTrimp * sportMult` raw, about 150 per TSS. That is compared with planned loads of about 7.4 per km. With the normaliser, a 60-TSS ride scores 60, not 6,413 FCL.
- **What to change.**
  - Use `iTrimpToTSS(iTrimp)` with the module athlete normaliser, the same one `computeWeekRawTSS` uses.
  - Drop sportMult on HR data. mult stands in for intensity per minute when there is no HR, and HR already measures that. Signal B does not apply it either (fitness-model.ts:449).
- **Other sizing paths with a hardcoded 15000** also move to the helper: activity-review.ts:1294 and :1902, excess-load-card.ts:222 and :367, main-view.ts:2325, universalLoad.ts:495. For the display-only sites (plan-view.ts:253, home-view.ts:135) and the grep-then-re-grep check, follow CLAUDE.md "Cross-cutting".
- **No HR.** Use `durationMin × TL_PER_MIN[rpe]`, the Signal B fallback. The Tier C mult × active fraction × 0.80 path, Tier B zone weights and Tier A Firstbeat loads are not in TSS units and stop sizing cuts. Every suggester caller already passes `undefined` Garmin loads.
- **Parity test.** An HR session and a no-HR session with the same TSS must produce identical adjustments.

---

#### 4. Constants

##### Used by the new design

| Constant | Value | Status |
|---|---|---|
| `TL_PER_MIN` | 0.30 … 3.00 | SOURCED sports.ts:11-22, SCIENCE_LOG:790 |
| Pace factors in `estimateWorkoutDurMin` | 0.82, 0.73, 0.78, 0.87, 1.03 | SOURCED fitness-model.ts:604-609 (code only; add a SCIENCE_LOG entry) |
| Planned RPE by type | easy/long 3, thr 7, vo2 8, MP 6, prog 5, float 7/6 | SOURCED intent_to_workout.ts:55-175 |
| Downgrade ladder | vo2→thr→MP→easy | SOURCED suggester.ts:339-353, SCIENCE_LOG:48 |
| iTRIMP normaliser | athlete value, fallback 15000 | SOURCED fitness-model.ts:264-291, SCIENCE_LOG:568 |
| No-HR session rate | TL_PER_MIN[rpe], rpe default 5, missing-index fallback 1.15 | SOURCED fitness-model.ts:452, :476, :636 |
| runSpec, recoveryMult | SPORTS_DB | SOURCED sports.ts:48-72, SCIENCE_LOG:770 (expert estimates) |
| Replace when remove ≥ run TSS (1.0) | 1.0 | SOURCED suggester.ts:842 (`REPLACE_THRESHOLD 0.95` in constants is dead) |
| Recovery multiplier | 1.00 / 1.15 / 1.30 / 1.50 | SOURCED LOAD_BUDGET_SPEC §6, readiness.ts:496-499 |
| Recovery top-up cap | 20 TSS (the ×15 is dropped) | SOURCED LOAD_BUDGET_SPEC §6 |
| Weekly running floor | `computeRunningFloorKm` | SOURCED fitness-model.ts:1225 |
| Preserve runs | 0.55, minimum 2 | SOURCED suggester.ts:182-183 |
| Severity (headline only) | 0.25 / 0.55; no-HR 90 min/RPE 6, 120 min/RPE 7 | SOURCED suggester.ts:291-298 (no literature) |
| Tier 1 limit | ≤ 15 TSS | SOURCED PRINCIPLES:154, LOAD_BUDGET_SPEC §4 |
| ACWR safeUpper | TIER_ACWR_CONFIG | SOURCED SCIENCE_LOG:590 |
| `MIN_EASY_KM` | 4 km | SOURCED in code (suggester.ts:169); **NEEDS TRISTAN** because Methodology:253 says 30 min |
| Long-run floor | 10 km / 0.85 / 0.65 / 0.60 | **NEEDS TRISTAN** (D3) |
| Minimum cut | 0.5 km easy, 1.0 km long; 0.1 km rounding | code only (suggester.ts:605, :649, :613), **NEEDS TRISTAN** to confirm; Methodology:187 rounds to 0.5 km |
| Unknown-sport runSpec | 0.35 | **NEEDS TRISTAN** (universalLoad.ts:82, fitness-model.ts:356) |
| `computeWeightedRunSpec` fallback | 0.7 | **NEEDS TRISTAN** (excess-load-card.ts:252) |
| Tier 1 "keep ≥ 1 km" | 1 km vs 4 km | **NEEDS TRISTAN** (activity-review.ts:1789) |
| Default easy pace | 5.5 min/km (fitness-model.ts:630) vs 6.0 (suggester.ts:1203) | **NEEDS TRISTAN**: pick one |

##### Removed from sizing

- The 0.40, 0.5, 0.25 and 0.3 caps.
- Severity run counts 1, 2 and 3.
- Damping at 0.35 and 0.65.
- 0.92 and `20*15`.
- TAU 800 and CREDIT_MAX 1500.
- `EASY_LOAD_PER_KM` 12 and the 25 km clamp.
- sportMult on iTRIMP.
- Tier C 0.80, active fraction and `LOAD_PER_MIN_BY_RPE` (for sizing).
- goalFactor (D10).
- The downgrade RPE table 8/7/6 → 4/6/7.
- `excess*150` and `excess*2`.
- 55 TSS/h, the 5-minute minimum, `TYPE_RPE`, 0.85 and `max(50, …)`.
- `TL_PER_MIN[4] × 6`.

---

#### 5. How quality sessions and the long run are protected

- **Order.** Easy km first, then long-run km, then quality intensity (PRINCIPLES.md:69-76, 189-191). Nothing further down is touched until everything above is at its floor or replaced.
- **Quality sessions.**
  - One step down only. Never replaced (`canReplaceWorkout` plus pool filters, suggester.ts:314-318 and :730-736). Never shortened.
  - All or nothing, and only when the step's ΔTSS is no more than what remains. The first-adjustment overshoot from ISSUE-137 (:555) goes.
  - The step's TSS comes from pricing the actual rewritten workout. For the 10 km threshold session in the examples, stepping down to "steady" at RPE 6 saves 27.5 TSS. So only a session whose running-equivalent is at least about 27.5 TSS above the easy and long capacity reaches it.
- **Long run.**
  - Distance only, down to its floor (D3), with at least 1 km per cut.
  - Never replaced unless injuryMode (:315).
  - Keeps type `long`, fixing A8 (today the type becomes `easy` and every protection is lost).
  - Identified by `isLongRun`, which also catches fast-finish and float long runs.
- **Week level.**
  - The weekly km floor applies while ACWR is safe or low (:500-501). Slack counts km already run this week, not only the remaining runs (A6).
  - `preserveRunCountMin` and each sport's `noReplace` list still apply.
- **Honesty.** Anything the floors block is returned as `unabsorbedTSS` and shown to the user.

---

#### 6. Worked examples

##### The week

Marathon plan, easy pace 6:00/km, all runs unrated. ACWR is safe, so the weekly floor is on: 19 km (mid tier, week 8 of 16) against 38 km planned, so it does not bind. The long-run floor is the current code rule, max(10, 0.85 × 20) = 17 km. Sessions are on Monday, and the rest of the week is on target, so the D2 cap does not bind.

| Run (priced with the real functions) | Minutes | RPE | TSS | TSS per km |
|---|---|---|---|---|
| Easy, 8km | 48.0 | 3 | 31.2 | 3.90 |
| Threshold, 2km warm up + 36 min @ 5:13 (~6.9 km) + 2km cool down = 10.0 km | 57.9 | 7 | 103.1 | 10.31 |
| Long run, 20km | 123.6 | 3 | 80.3 | 4.02 |

Weekly planned run TSS is 214.7. Stepping the threshold session down to "10km @ 5:37/km (steady)" at RPE 6 saves 27.5 TSS.

##### The five sessions

| Session | B | runSpec | A = TSS to remove | Today (Reduce / Replace) | New Reduce | New Replace |
|---|---|---|---|---|---|---|
| 30-min easy spin, HR | 20 | 0.55 | 11.0 | extreme, eq 25 km: easy 8→4.8, long 20→17, threshold→MP / easy deleted, long 20→17, threshold→MP | easy 8→5.2 (−10.9) | same |
| 60-min ride, HR | 60 | 0.55 | 33.0 | same as above | easy 8→4, long 20→17 (−27.7; 5.3 left) | easy deleted (−31.2; 1.8 left) |
| 60-min ride, no HR, RPE 5 | 69.0 | 0.55 | 38.0 | light: easy 8→4.8 / easy deleted | easy 8→4, long 20→17 (−27.7; 10.3 left) | easy deleted, long 20→18.3 (−38.0) |
| 2-h hard ride, HR | 150 | 0.55 | 82.5 | same as the HR rows above | easy 8→4, long 20→17, threshold→steady (−55.1; 27.4 left) | easy deleted, long 20→17, threshold→steady (−70.7; 11.8 left) |
| 45-min HIIT, HR (as crossfit) | 50 | 0.40 | 20.0 | same as the HR rows above | easy 8→4, long 20→18.9 (−20.0) | same |

- **Equivalent easy km** (A ÷ 3.9): 2.8, 8.5, 9.7, 21.2 and 5.1 km. Today it shows 25, 25, 5.9, 25 and 25.
- **Headline severity:** light, heavy, heavy, extreme, heavy.
- **If the long-run floor were 10 km** (it is 10 km when ACWR is caution or high):
  - 60-min HR ride, Reduce: easy 8→4, long 20→15.7 (−32.9).
  - 60-min no-HR ride, Reduce: long 20→14.4 (−38.0).
  - 2-h ride, Reduce: long 20→10 (−55.8). The threshold session is not touched because 26.7 TSS remain, which is less than its 27.5 step.
- **Sweep with HR rides, Reduce mode:**

| Ride TSS | 5 | 10 | 15 | 20 | 30 | 40 | 60 | 90 | 120 | 150 | 200 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TSS removed | 2.7 | 5.5 | 8.2 | 10.9 | 15.6 | 22.0 | 27.7 | 27.7 | 55.1 | 55.1 | 55.1 |

  - Up to 30 TSS the cut is exactly proportional (A = TSS × 0.55). From 30 TSS the floors decide.
  - Today every one of these rides gets 6.2 km plus a threshold downgrade.
- **Other paths:**
  - **Excess card** (excess 25 TSS from the 60-min HR ride). Today: easy 8→4.8, the same at any recovery multiplier. New: 25 × 0.55 = 13.75 TSS, so easy 8→4.5. At recovery multiplier 1.3: +4.1 TSS, so easy 8→4 with 2.3 TSS left.
  - **ACWR card** (ratio 1.50 vs 1.35, chronic 200 per week, so 30 TSS). Today: a synthetic 33-min "running" session, rated light, easy 8→4.8. New: easy 8→4 (−15.6) and long 20→16.4 (−14.5).

---

#### 7. Risks and tests

##### Risks

- **R1. Planned runs are under-priced** (audit B2). Easy and long runs are priced at RPE 3 = 0.65 TSS/min, but the athlete's own Z2 running measures about 0.74–1.1. So each TSS to remove turns into 14–70% too many km. The allocator must use the same pricer as the plan bar; fix the price there (D8).
- **R2. Suggestions are built from the unmodified plan** (A2). Proportional cuts get overwritten, and a replaced run can come back, unless the plan is priced with mods applied and mods are upserted.
- **R3. Max HR and normaliser.** Stored iTRIMP used the max HR at sync time, while the normaliser uses the current `s.maxHR`, `ltHR` and `restingHR`. When max HR changes, every session's TSS shifts and cuts scale with it, and `garmin_activities.itrimp` is never recomputed. This depends on the max-HR fix.
- **R4. False-high ACWR** (B1: ACWR 1.7 from zero-filled pre-plan days). The ACWR path would make a proportional cut to a wrong number. Land B1 first.
- **R5. Sport mapping.** HIIT has no SPORTS_DB key (runSpec falls to 0.35), and the Apple app mis-types sessions. A wrong runSpec gives a wrong cut. This depends on the Apple fix.
- **R6. Behaviour change for users.**
  - HR users see much smaller cuts; today everything is "extreme".
  - No-HR long sessions see larger cuts because the caps are gone.
  - Replace can remove less TSS than Reduce because of all-or-nothing steps (at 120 TSS: 43.3 vs 55.1).
- **R7. Past-day unrated runs are still eligible** (excess-load-card.ts:79-83). Cutting them removes TSS that was never going to be run (D15).
- **R8. Fast-finish and float long runs** are priced at their whole-run average RPE. Cutting km there removes average TSS per km, not easy TSS per km.
- **R9. Parser limits.** Reduced descriptions must stay "Xkm (was Ykm)". A rewrite to "X km" with a space is unparseable (A14). A downgraded warm-up and cool-down are repriced at the new pace and RPE.
- **R10. Overflow counted once.** Keep garminId dedup when summing items. The Signal A double count (B3) is a separate fix.

##### Tests to add

1. `priceWorkoutTSS` sums to `computePlannedDaySignalBTSS`, and a replaced run prices at 0.
2. Monotonic: removed TSS never goes down as the session grows, in both modes. Removed TSS ≤ TSS to remove, allowing for 0.1 km rounding. Below the floors, removed ≈ A.
3. HR/no-HR parity at equal TSS. Doubling the normaliser halves the cut.
4. Sports at equal TSS cut in the ratio 0.20 : 0.55 : 1.00 (swimming, cycling, extra run) until the floors bind.
5. Plan-bar invariant for reduce, replace and downgrade. This fails today for downgrades because `newRpe` is not updated.
6. Protection:
   - quality is never replaced or shortened;
   - the long run keeps type `long` and stays above its floor;
   - the weekly floor counts completed km;
   - `preserveMin` and `noReplace` hold.
7. The excess, Tier 1 and ACWR formulas as specified, including the 20 TSS recovery cap.
8. Two sessions in a row: the second is priced from the already-modified plan.
9. Mixed items (HR and no HR): both are counted.

---

#### Decisions for Tristan

| # | Decision | Recommendation |
|---|---|---|
| D1 | What each path removes | Sessions and excess: TSS × runSpec (as documented). ACWR: acute − safeUpper × chronic, in full. Alternative for ACWR: keep today's week-overshoot cap. |
| D2 | Cap session cuts at the week's projected Signal B overshoot? | Yes. Habitual cross-training is already inside `computePlannedSignalB`, so it should not cut runs. |
| D3 | Long-run floor | Pick one: 60% (Methodology), 65%, 85% (current when the weekly floor is on) or 10 km. |
| D4 | Easy floor | Pick one: 4 km or 30 min. |
| D5 | What comes after easy runs | PRINCIPLES says long-run km before quality intensity, with VO2 last. `workoutPriorityForRace` (suggester.ts:324-333) instead protects the long run most for marathoners and downgrades VO2 before threshold. Pick one. |
| D6 | Which easy run first | Soonest after the session (recommended), or the current similarity score or runner-type rule. |
| D7 | Quality step bigger than what remains | Skip it (recommended). Or build the Methodology §6 fractional split. |
| D8 | Planned-run price | Keep TL_PER_MIN[RPE], or use the athlete's measured TSS/min per run type (the `computeCrossTrainTSSPerMin` pattern, fitness-model.ts:723-751). |
| D9 | Saturation curve | Drop it. |
| D10 | goalFactor | Drop it. With iTRIMP the split is fixed at 85/15, so it is a constant. |
| D11–D17 | Smaller items | Unknown-sport runSpec 0.35; the 0.7 fallback; `max(50, ctl)` (delete); Tier 1 1 km vs 4 km; default easy pace; minimum-cut and rounding values; whether the recovery multiplier applies on every path. |
## Design: science-first
### Proportional cut sizing after cross-training: design

#### Short answer

- **One currency: TSS.** The suggester currently mixes three scales: raw iTRIMP, Tier C "load" and planned-run `LOAD_PER_MIN_BY_INTENSITY` load. The design sizes everything in TSS instead:
  - HR sessions use the existing athlete normaliser (1 h at LTHR = 100).
  - No-HR sessions use `TL_PER_MIN`.
  - Planned runs use `estimateWorkoutDurMin × TL_PER_MIN`.
  - This fixes the raw-iTRIMP bug without inventing an iTRIMP-to-load factor.
- **Two different quantities drive cuts, and they must not be mixed:**
  - **Displacement (Signal A).** `credit = TSS × runSpec × goalFactor` is the running-specific aerobic stimulus the session already delivered. It sizes cuts after a session and on the excess path. It takes volume only.
  - **Fatigue (Signal B).** This drives the ACWR path at 1:1, because a TSS of running removed lowers acute Signal B by exactly 1 TSS. Fatigue is also what downgrades quality sessions, through the ACWR path and the existing timing check.
- **The % caps go.** Easy −40%/−50% (`suggester.ts:579, :776`), long −25%/−30% (`:639, :804`), severity-based run counts (`:186-188`) and the saturation curve (`universalLoad.ts:60-62`) are removed. In their place:
  - per-run floors;
  - the existing weekly km floor;
  - one literature-sourced weekly ceiling: cross-training may displace at most 20 to 30% of the week's planned running (Tanaka 1994, `running.md §7.2`; 0.30 already in code at `sports.ts:180`);
  - a per-session ledger, so the same session is never credited twice.
- **Result:**
  - On the example week (easy pace 6:00/km), 1 TSS of credit removes 0.18 km of easy running.
  - Cuts are 2.0, 3.2, 5.6, 6.0 and 11.0 km for the five sessions, against 6.2 km plus a threshold downgrade for every HR session today.
  - In a 5-run week the km-per-TSS ratio stays constant at 0.18 up to the ceiling.

---

#### 1. Physiology: what a cross-training session should displace

##### 1.1 Aerobic stimulus: displaced through runSpec (Signal A)

- **Evidence of partial transfer.** Cycling raises running VO2max but not running economy (Millet et al. 2002; Tanaka 1994; `running.md §7.1`).
- **What runSpec means.** It is defined as the share of a session that "contributes to running-specific adaptation" (`PRINCIPLES.md:26-33`; `sports.ts:47-71`; `SCIENCE_LOG` "Sport-Specific Constants").
- **What this implies.** A session worth T TSS delivered T × runSpec TSS of running-equivalent stimulus. Removing up to that much planned *aerobic* running leaves the week's running stimulus (Signal A) at plan. That is the proportional quantity Tristan described: the cut equals the work done, discounted by how running-like it was.
- **Goal factor.** `computeGoalFactor` (`universal-load-constants.ts:209-221`; `SCIENCE_LOG:756`) is kept as a small ±5–15% aerobic/anaerobic adjustment.
- **Decision rule already on record:** "Detect with Signal B, reduce with Signal A" (`LOAD_BUDGET_SPEC.md:282`; decision matrix at `PRINCIPLES.md:54-64`).

##### 1.2 Fatigue: not a displacement, handled by Signal B

- In the Banister model every session adds to the fatigue impulse, whatever the sport (Banister 1975; Busso 2003). Signal B counts it at full weight (`PRINCIPLES.md:35-41`).
- The non-transferable part, T × (1 − runSpec), should **not** cut more running by default. If it did, a 60-TSS strength session would delete about 11 km of running.
- That fatigue reaches the plan only through the two existing fatigue mechanisms:
  - **ACWR path.** Cut Signal B 1:1 until the projected week is under the ACWR ceiling. The ceiling is `safeUpper × chronic` (`fitness-model.ts:915-921`, `:931-972`; Gabbett 2016, with the Lolli 2019 caveat in `SCIENCE_LOG` "ACWR").
  - **Day-proximity timing check** (`timing-check.ts`). It is the mechanism that downgrades a quality session after a hard day (`PRINCIPLES.md:161-181`).

##### 1.3 Why intensity sessions are protected from displacement

- Intensity is what maintains fitness while volume falls. Taper evidence: reduce volume, keep intensity and frequency (Bosquet et al. 2007; Mujika & Padilla 2003; `running.md §9.1, §9.3`).
- Cross-training does not deliver running-specific economy or pace work (Millet 2002).
- `PRINCIPLES.md:183-206` resolves this explicitly:
  - "always preserve quality sessions; reduce easy volume first";
  - "never credit the football toward [a missed threshold]".
- **Conflict flagged.** `LOAD_SYSTEM_SPEC.md §6.4-6.5` (2026-03-02) offers "full replace" of a zone-matched tempo run. `PRINCIPLES` (2026-03-04) is later and supersedes it. The design follows PRINCIPLES.

##### 1.4 Why the long run comes last and has a floor

- The long run's specific stimulus (time on feet, musculoskeletal durability) is only partly delivered by non-weight-bearing work. runSpec already discounts it.
- The protection hierarchy puts "long run: reduce distance" second, after easy runs (`PRINCIPLES.md:67-80`).
- Replacement is already blocked outside injury mode (`suggester.ts:315`).

##### 1.5 Order of cuts among easy runs

- The next upcoming easy run is cut first. Residual session fatigue is highest in the next 48 h (leg-load half-life of 48 h, `SCIENCE_LOG` "Leg Load Decay"; ATL τ = 7 d).
- This also changes the fewest runs.
- The alternative is pro-rata across runs (`Load-Reduction-Methodology.md:180-188`). This is a decision for Tristan.

##### 1.6 Weak points to log

- runSpec values are expert estimates. Cycling at 0.55 sits below the 60–75% range in `running.md §7.1`.
- Tanaka's 20–30% refers to training *volume*, not TSS.
- iTRIMP under-reads short anaerobic bursts (`running.md §2.1`), so HIIT credit is conservative.
- Tier A+ uses a fixed 85/15 aerobic split (`universalLoad.ts:110`).
- Floors are coaching convention, not literature.

---

#### 2. The algorithm

##### 2.1 Plain English

1. Price every activity item separately in TSS. HR sessions use the athlete-normalised iTRIMP. No-HR sessions use duration × `TL_PER_MIN[rpe]`, which is the same number that feeds the weekly load bar (`fitness-model.ts:453`).
2. Turn each item into running-equivalent credit: TSS × runSpec × goal factor, with the existing 0.80 discount when RPE is the only data.
3. Choose the budget by entry point:
   - **After a session:** the sum of its credit.
   - **Excess card or silent auto-reduce:** the unplanned excess (capped at the unconsumed session TSS) × the weighted runSpec.
   - **ACWR:** the Signal B TSS over the ACWR ceiling, 1:1.
4. For the session and excess paths:
   - add the recovery-trend top-up, capped at +20 TSS;
   - cap the total at 30% of the week's planned running TSS, minus what has already been displaced this week.
5. Remove the budget from easy runs, nearest upcoming first. Each run goes down to its floor, converting TSS to km at that run's own TSS per km.
6. If budget remains, shorten the long run down to its floor. It keeps its type `long`.
7. **Replace option:** an easy run whose whole TSS fits inside the budget can be removed, as long as the minimum run count and the weekly km floor still hold.
8. **ACWR path only:** if budget still remains after volume, step quality sessions down one rung, least protected first, pricing each step by its TSS drop.
9. Anything left over is reported as "not absorbed". It is never forced into a quality session.
10. Record on each mod the TSS removed and the session IDs it came from (the ledger).

##### 2.2 Pseudo-code

```ts
// ---------- 1. one currency (Signal B TSS per item) ----------
function itemTSS(it, norm): { tssB, ar, rpeOnly } {
  if (it.iTrimp > 0)          tssB = it.iTrimp * 100 / norm;          // fitness-model normaliser
  else                        tssB = it.durationMin * TL_PER_MIN[it.rpe]; // == computeWeekRawTSS no-HR path
  ar = it.hrZones ? (z4+z5)/Σz                                         // derived, no constant
     : it.iTrimp  ? 0.15                                               // universalLoad.ts:110 (known limitation)
     :              1 - RPE_AEROBIC_SPLIT[it.rpe];
  rpeOnly = !(it.iTrimp > 0);
}
// ---------- 2. running-equivalent credit (Signal A) ----------
credit(it) = tssB * runSpec(it.sport) * computeGoalFactor(ar, raceGoal)
           * (rpeOnly ? RPE_UNCERTAINTY_PENALTY : 1);

// ---------- 3. budget ----------
const fresh = items.filter(i => !ledger.creditedIds.has(i.garminId));
let B = 0;
if (mode === 'session') B = Σ credit(fresh);
if (mode === 'excess')  B = min(excessB, Σ tssB(fresh)) * (Σ credit(fresh) / Σ tssB(fresh)); // matched runs: runSpec 1
if (mode === 'acwr')    B = max(0, projectedWeekB - acwr.safeUpper * acwr.chronic);
if (mode !== 'acwr') {
  B += min(B * (recoveryMult - 1), 20);                        // LOAD_BUDGET_SPEC §6
  B  = min(B, DISPLACE_CEIL * weekPlannedRunTSS - ledger.weekDisplacedTSS);
}
if (B <= 0) return noChange;

// ---------- 4. candidate runs: current week WITH mods applied ----------
runs = weekWithMods.filter(r => unrated(r) && r.day >= today)
       .map(r => ({ ...r, tss: plannedWorkoutTSS(r), tssPerKm: plannedWorkoutTSS(r)/r.km }));
// plannedWorkoutTSS = estimateWorkoutDurMin(w, pac.e/60) * TL_PER_MIN[rpe(w)]

// ---------- 5. Replace option (easy only) ----------
if (choice === 'replace')
  for (r of easy(runs).sortBy(daysAfter(session)))
    if (r.tss <= B && runsLeft > preserveMin && weeklyFloorAllows(r.km)) { remove(r); B -= r.tss; }

// ---------- 6. volume ----------
for (r of easy(runs).sortBy(daysAfter(session))) cut(r, EASY_FLOOR(r));
if (B > 0) for (r of runs.filter(isLong)) cut(r, max(MIN_LONG_KM, F_LONG * r.originalKm));

function cut(r, floorKm) {
  let maxKm = r.km - floorKm;
  if (weeklyFloorActive) maxKm = min(maxKm, weekKm - reducedKm - weekFloorKm);
  const km = round1(min(B / r.tssPerKm, maxKm));
  if (km < MIN_CUT_KM[r.type]) return;
  emit({ action: 'reduce', run: r, newKm: r.km - km, newType: r.type /* long stays long */,
         tss: km * r.tssPerKm, sourceIds: fresh.ids });
  B -= km * r.tssPerKm;
}

// ---------- 7. intensity: ACWR mode only ----------
if (mode === 'acwr')
  for (q of quality(runs).sortBy(leastProtectedFirst)) {
    if (B < MIN_CUT_KM.easy * easyTssPerKm) break;
    const delta = plannedWorkoutTSS(q) - plannedWorkoutTSS(stepDown(q));  // one rung, generator RPEs
    emit({ action: 'downgrade', run: q, tss: delta }); B -= delta;
  }

// ---------- 8. report ----------
return { adjustments, creditTSS, absorbedTSS, unabsorbedTSS: max(0, B),
         equivalentEasyKm: Σcredit / easyTssPerKm };
```

---

#### 3. What changes (functions and callers)

##### 3.1 Core functions

| File:line | Function | Change |
|---|---|---|
| `src/calculations/fitness-model.ts:289-291` | `normalizeiTrimp` (private) | Export it, e.g. as `iTrimpToTSS`, so sizing uses the athlete normaliser (`:265-272`, `:281-286`). |
| `src/calculations/fitness-model.ts:583-639` | `estimateWorkoutDurMin`, `computePlannedDaySignalBTSS` | Add an exported `plannedWorkoutTSS(w, baseMinPerKm)` and reuse it in `computePlannedDaySignalBTSS`. |
| `src/cross-training/universalLoad.ts:99-119` | `computeTierAPlus` | Replace `baseLoad = iTrimp * sportMult` (`:106`) with TSS via the normaliser. `sportMult` is dropped for HR data (decision D3). |
| `src/cross-training/universalLoad.ts` (new) | `computeSessionCredit(items, ctx)` | Implements steps 1–2 per item and returns `{tssB, credit, ar, tier}`. |
| `src/cross-training/universalLoad.ts:336-344, :60-62, :369-372` | RRC, `saturateCredit`, `equivalentEasyKm` | Removed from sizing. `equivalentEasyKm = credit / easyTssPerKm`, which drops `EASY_LOAD_PER_KM 12` and the 25 km clamp from the budget. |
| `src/cross-training/universalLoad.ts:495` | `classifyByITrimp` | Use the normaliser instead of 15000. |
| `src/cross-training/suggester.ts:42-51` | `PlannedRun` | Add `rpe`, `plannedTSS`, `tssPerKm`, `originalKm`. |
| `src/cross-training/suggester.ts:1201-1238` | `workoutsToPlannedRuns` | Compute TSS with `plannedWorkoutTSS` and the runner's pace. Drop the `aerobic/35` km guess (`:1220-1222`). |
| `src/cross-training/suggester.ts:890-1194` | `buildCrossTrainingPopup` | New options object `{mode, budgetTSS?, recoveryMultiplier, maxAdjustments?, weekPlannedRunTSS, ledger}`. Delete `20*15` (`:1025`), the capFraction and dampening block (`:1031-1047`), and severity-driven counts. Severity becomes a display-only `tssB / weekPlannedRunTSS`. |
| `src/cross-training/suggester.ts:478-685` | `buildReduceAdjustments` | Replace with the step 6 `distributeVolumeCut`. No quality downgrades in session or excess mode. Remove 0.40 (`:579`) and 0.25 (`:639`). |
| `src/cross-training/suggester.ts:691-881` | `buildReplaceAdjustments` | Steps 5 and 6. The Replace pool is easy runs only (today it includes quality, `:730-735`). Remove 0.5 (`:776`) and 0.3 (`:804`). |
| `src/cross-training/suggester.ts:666, :819` | long-run reduce | Keep `newType` as `'long'`, not `'easy'` (audit A8). |
| `src/cross-training/suggester.ts:464-471` | `computeWorkoutWeightedLoad` | Replace with `plannedWorkoutTSS` using the easy pace (audit A7). |
| `src/cross-training/suggester.ts:1358` | `applyAdjustments` load recalc | Pass `paces.e`. |
| `src/types/state.ts:108-119` | `WorkoutMod` | Add `xtCreditTSS?: number; xtSourceIds?: string[]` (the ledger). |

##### 3.2 Callers

| Caller | Mode and budget | Other required change |
|---|---|---|
| `activity-review.ts:1222` (`applyReview` overflow) | `session`, per-item credit. | Replace `buildCombinedActivity` (`:1918-1956`), which picks one dominant sport, with per-item items. Candidate runs need mods applied: `getWeekWorkoutsForReview` (`:69-81`) ignores mods (audit A2). Reuse `excess-load-card.ts:41-66 getWeekWorkouts`. |
| `activity-review.ts:1776-1812` (Tier 1 silent) | `excess`, run through `distributeVolumeCut`. | Remove the hardcoded `EASY_TSS_PER_KM = TL_PER_MIN[4]×6` (`:1787`) and the 1 km floor (`:1789`). Use `computePlannedSignalB` as the target, not `signalBBaseline` (audit A9). |
| `activity-review.ts:1845` (autoProcess, ACWR caution/high) | `acwr`. | Same candidate-run fix as above. |
| `excess-load-card.ts:259-420` (`triggerExcessLoadAdjustment`, call at `:370`) | `excess`. Weighted runSpec via `computeWeightedRunSpec` (`:219`, currently never called), switched to the normaliser (`:222`). | Delete the synthetic `excess*150` / `excess*2` activity (`:326-333`) and the RPE derived from summed aerobic (`:288-289`, audit A12). |
| `excess-load-card.ts:423-493` (carry-over, `:460`) | `excess`, budget = carried excess × weighted runSpec. | It has no cap today. |
| `main-view.ts:2193-2330` (`triggerACWRReduction`, `:2312`) | `acwr`: `projectedWeekB − safeUpper×chronic`. | Delete the synthetic "running" activity (`:2220-2226`). Replace the `TYPE_RPE` table and 0.85 factor (`:2283-2288`) with `plannedWorkoutTSS`. Keep `maxAdjustments` (`:2311`) as a caller override only. |
| `gps/recording-handler.ts:174`, `events.ts:1756, :1882` | `session` (extra_run has runSpec 1.0). | `events.ts` is unreachable legacy per the audit. |
| `timing-check.ts:85-94` | not a sizing path | Replace its private `TSS_PER_MIN` table and the fixed 15000 with the shared TSS function, so "yesterday's TSS" uses the same scale. |
| `plan_engine.ts:316-324` (week-advance ACWR: −1/−2 quality) | Phase 2. | The same `acwr` rule could apply to next week: volume first, quality last. Today this path cuts intensity first, the opposite of `PRINCIPLES.md:67-80`. |

**Docs to update when implemented:**
- `SCIENCE_LOG`: a new entry, a rewrite of "Saturation Curve", and the "Universal Load" Tier A+ formula.
- `FEATURES`, `CHANGELOG`, and `ARCHITECTURE` (for the `PlannedRun` and `WorkoutMod` fields).

---

#### 4. The raw-iTRIMP unit fix inside this design

**The bug.** `computeTierAPlus` feeds raw iTRIMP (about 150 per TSS) into a pipeline whose planned runs are about 1.2–1.5 load units per minute (`universalLoad.ts:106`).

**The fix.** The sizing pipeline never compares iTRIMP with load units:

- **HR sessions:** `tssB = iTrimp × 100 / normalizer`. The normaliser is `3600·HRR_LT·e^(1.92·HRR_LT)`, with 15000 as fallback (`fitness-model.ts:265-272`; `SCIENCE_LOG` "Athlete Normalizer", Coggan hrTSS).
- **Planned runs:** `estimateWorkoutDurMin × TL_PER_MIN[rpe]`, the same scale (`sports.ts:4-10` calibration notes).
- **No-HR sessions:** `durationMin × TL_PER_MIN[rpe]`, the same scale.

No new constant is needed. The alternative, an iTRIMP-to-load factor, does not exist in code, and the load-to-TSS ratio is not constant across RPE (0.5/0.30 = 1.67 at RPE 1 versus 4.5/2.22 = 2.03 at RPE 8). So TSS is the only defensible common unit. It is also the unification goal in `LOAD_SYSTEM_SPEC.md §1`.

**Same fix elsewhere (cross-cutting audit).** The hardcoded 15000 in load-sizing paths should switch to the normaliser:
- `excess-load-card.ts:222, :367`
- `main-view.ts:2325`
- `activity-review.ts:1294, :1902`
- `timing-check.ts:89, :94`
- `universalLoad.ts:495`
- Display-only sites `main-view.ts:1614, :1676, :1697` should be checked too.

---

#### 5. Constants

##### 5.1 Constants the design uses

| # | Constant | Value | Status |
|---|---|---|---|
| 1 | iTRIMP normaliser | per athlete, fallback 15000 | **SOURCED**: `fitness-model.ts:265-272`; SCIENCE_LOG "Athlete Normalizer" |
| 2 | `TL_PER_MIN` (TSS/min by RPE) | 0.30 … 3.00 | **SOURCED**: `sports.ts:11-22`; SCIENCE_LOG "SPORTS_DB" |
| 3 | runSpec per sport | e.g. cycling 0.55, strength 0.35 | **SOURCED**: `sports.ts:47-71` (expert estimates; ranges in `running.md §7.1`) |
| 4 | Unknown-sport runSpec | 0.35 | **NEEDS TRISTAN**: code only (`universalLoad.ts:82`, `fitness-model.ts:365`), undocumented. The alternative is the existing `generic_sport` entry, 0.40 (`sports.ts:71`). |
| 5 | Goal factor | 1.05 − 0.20r / 0.95 + 0.20r | **SOURCED**: `universal-load-constants.ts:209-221`; SCIENCE_LOG:756 |
| 6 | Anaerobic ratio source | zones → derived; iTRIMP → 0.15; RPE → `RPE_AEROBIC_SPLIT` | **SOURCED**: `universalLoad.ts:110` (known limitation); `universal-load-constants.ts:165-176` |
| 7 | RPE-only discount | 0.80 | **SOURCED**: `universal-load-constants.ts:93`; SCIENCE_LOG:733. **NEEDS TRISTAN**: keep it? Signal B does not apply it. |
| 8 | Weekly displacement ceiling | 0.30 × planned week run TSS | **SOURCED** range 20–30% (`running.md §7.2`, Tanaka 1994); 0.30 is in code (`sports.ts:180`, currently dead). **NEEDS TRISTAN** to confirm the value. |
| 9 | Recovery multiplier | 1.00 / 1.15 / 1.30 / 1.50 | **SOURCED**: `readiness.ts:496-499`; LOAD_BUDGET_SPEC §6 |
| 10 | Recovery top-up cap | +20 TSS | **SOURCED**: LOAD_BUDGET_SPEC §6 (replaces the unsourced `20*15`) |
| 11 | Easy run floor | 4 km, or 30 min at easy pace | **NEEDS TRISTAN**: both are sourced. 4 km is in `suggester.ts:169` and `universal-load-constants.ts:41`; 30 min is in `Load-Reduction-Methodology.md:186, :253`. |
| 12 | Long run floor | max(10 km, F × original km) | 10 km is **SOURCED** (`suggester.ts:170`). F is **NEEDS TRISTAN**: 0.60 (Methodology:250), 0.65 (`LONG_MIN_FRAC`, `universal-load-constants.ts:47`) or 0.85 (`suggester.ts:643`). |
| 13 | Minimum meaningful cut | 0.5 km easy, 1.0 km long; round to 0.1 km | In code (`suggester.ts:605, :611, :649, :613`), rationale undocumented. **NEEDS TRISTAN**. Methodology rounds to 0.5 km. |
| 14 | Weekly running km floor, off at ACWR caution/high | 10–35 km | **SOURCED**: `fitness-model.ts:1225-1237`; `suggester.ts:500-501`; LOAD_SYSTEM_SPEC §5.6 |
| 15 | Replace rule | budget ≥ run TSS | Logical definition, matches current `suggester.ts:842`. `REPLACE_THRESHOLD 0.95` (`universal-load-constants.ts:16`) is unused. |
| 16 | Runs preserved | max(2, ceil(0.55 × n)) | In code (`suggester.ts:182-183`). The Python design used 0.5 and 1. Kept unchanged. |
| 17 | RPE used to price easy/long runs | 3 (generator) or 4 | **NEEDS TRISTAN**, tied to audit B2. RPE 3 is at `intent_to_workout.ts:54-55, :76-77`. RPE 4 is the table's easy calibration (`sports.ts:6`), Tier 1 (`activity-review.ts:1787`) and `main-view.ts:2283`. RPE 3 makes cuts 1.42× larger per TSS. |
| 18 | Pace multipliers per type | 0.73 … 1.03 | **SOURCED**: `fitness-model.ts:604-609` (same as planned TSS) |
| 19 | Downgrade target RPE | MP 6, threshold 7 | **SOURCED**: generator RPEs (`intent_to_workout.ts:91, :135`), replacing the undocumented `suggester.ts:541-544` |
| 20 | Quality protection order (ACWR mode) | least protected first | **NEEDS TRISTAN**: `PRINCIPLES.md:67-80` (VO2 last) conflicts with `workoutPriorityForRace` (`suggester.ts:324-333`, marathon: VO2 before threshold) |
| 21 | ACWR ceiling | `safeUpper` by tier | **SOURCED**: `fitness-model.ts:915-921`; SCIENCE_LOG "ACWR" |
| 22 | Tier 1 / Tier 2 triggers | ≤15 / 15–40 TSS | **SOURCED**: `PRINCIPLES.md:150-156`; LOAD_BUDGET_SPEC §4 (not changed) |
| 23 | Severity labels (display only) | 0.25 / 0.55 of week TSS | In code (`suggester.ts:291, :297`; `EXTREME_WEEK_PCT`). **NEEDS TRISTAN** if kept. No longer affects sizing. |
| 24 | Timing-check tiers (quality fatigue path) | 50 / 75 / 100 / 125 TSS; 0 / 10 / 15 / 25% | In code (`timing-check.ts:30, :58-63`), CHANGELOG:930 only, not in SCIENCE_LOG. Not changed by this design, but flagged. |
| 25 | No-HR sport mult × active fraction | — | **NEEDS TRISTAN**: dropped here to match Signal B (`fitness-model.ts:453`). If kept, apply it to Signal B too. |

##### 5.2 Constants removed from sizing

- Caps 0.40, 0.25, 0.5 and 0.3.
- `MAX_ADJUSTMENTS` 1/2/3 by severity.
- Dampening at 0.35 and 0.65.
- `20*15`.
- `TAU` 800 and `CREDIT_MAX` 1500.
- `EASY_LOAD_PER_KM` 12 and the 25 km equivalent cap.
- `ANAEROBIC_WEIGHT_SUGGESTER` 1.5 (in sizing).
- The no-HR severity rules (90 min at RPE 6, 120 min at RPE 7).
- The synthetic `excess*150` iTRIMP and `excess*2` minutes.
- The ACWR synthetic activity: `max(50, ctl)`, 55 TSS/h, `TYPE_RPE`, 0.85.
- `sportMult` on HR data (decision D3).

---

#### 6. How quality sessions and the long run are protected

##### 6.1 Quality sessions

(threshold, vo2, intervals, hill_repeats, race_pace, marathon_pace, mixed, progressive, float)

1. They are never in the pool for session or excess cuts, for any runner type. This changes current behaviour: Balanced and Endurance runners get a downgrade first today (`suggester.ts:513-518, :539-570`).
2. They are never replaced (today possible, `suggester.ts:730-735`).
3. They are downgraded only by fatigue signals:
   - **ACWR mode:** after easy and long volume are exhausted; one rung; priced as the TSS difference.
   - **Timing check:** Signal B of 50 TSS or more the day before.
4. Prerequisite fixes in the timing check:
   - `QUALITY_TYPES` misses marathon_pace, float and progressive (audit A4, `timing-check.ts:29`).
   - The long-run "downgrade" to `'marathon'` raises intensity (A4).
   - Timing mods override cross-training reductions (A3).

##### 6.2 Long run

1. It is cut only after all easy capacity is used.
2. Its floor is computed from the **original** km, so repeated sessions cannot ratchet it down (audit A8 cascade).
3. It keeps type `long`.
4. It is never replaced outside injury mode (`suggester.ts:315`).
5. The weekly km floor applies when ACWR is safe or low.
6. **Open question:** the fast-finish long run is typed `progressive`. Under this design it counts as quality and is never cut, so in weeks 2/5/8/11/14 the long run offers no spill capacity. See D9.

---

#### 7. Worked examples

##### 7.1 Assumptions

- **Goal and pace:** marathon; easy pace 6:00/km.
- **Session timing:** Monday session; ACWR safe; weekly km floor 17 km (`computeRunningFloorKm(320, 5, 16, 'build')`), which does not bind here.
- **Floors:** easy floor 4 km; long floor 65% (`LONG_MIN_FRAC`), with the 85% alternative shown.
- **Pricing:** runs priced at RPE 4 (D2).
- **The week:**

| Run | Duration | Planned TSS | Per km |
|---|---|---|---|
| Easy Run 8 km (Tue) | 48 min × 0.92 | 44.2 | 5.52 TSS/km |
| Threshold "2 km WU / 30 min @ 4:55 / 2 km CD" (Thu), about 10 km | 54 min × 1.78 | 96.1 | — |
| Long Run 20 km (Sun) | 123.6 min × 0.92 | 113.7 | 5.69 TSS/km |
| **Week** | | **254.0** | 30% ceiling = **76.2** |

All numbers below come from vitest probes calling the real `estimateWorkoutDurMin`, `TL_PER_MIN`, `computeGoalFactor`, `RPE_AEROBIC_SPLIT` and `buildCrossTrainingPopup`. The probes have been deleted and `git status` is clean.

##### 7.2 Five sessions: proposed versus today

| Session | TSS (B) | runSpec | Goal factor (× RPE-only discount) | Credit | Budget | Proposed Reduce | Total cut | Proposed Replace | Today (same week) |
|---|---|---|---|---|---|---|---|---|---|
| 30-min easy spin, HR | 20 | 0.55 | 1.02 | 11.2 | 11.2 | Easy 8→6.0 | **2.0 km** | same | "extreme". Easy 8→4.8, Long 20→17, Threshold→MP. Replace **deletes** the easy run. |
| 45-min HIIT, HR (HIIT → gym → strength, `activity-matcher.ts:52`, `sports.ts:126`) | 50 | 0.35 | 1.02 | 17.9 | 17.9 | Easy 8→4.8 | **3.2 km** | same | identical to the spin row |
| 60-min ride, no HR, RPE 5 | 60×1.15 = 69 | 0.55 | 1.02 × 0.80 | 31.0 | 31.0 | Easy 8→4.0, Long 20→18.4 | **5.6 km** | same (31 < 44.2) | "light". Easy 8→4.8. Replace deletes the easy run. |
| 60-min ride, HR | 60 | 0.55 | 1.02 | 33.7 | 33.7 | Easy 8→4.0, Long 20→18.0 | **6.0 km** | same | identical to the spin row |
| 2-h hard ride, HR | 150 | 0.55 | 1.02 | 84.2 | **76.2** (ceiling) | Easy 8→4.0, Long 20→13.0 | **11.0 km** (14.3 TSS not absorbed) | Easy removed, Long 20→14.4 (13.6 km) | identical to the spin row |

- **Long floor at 85% instead:** the 2-h ride gives Easy 8→4.0 and Long 20→17.0, 7.0 km (37.1 TSS not absorbed). Replace gives 11.0 km. The other rows do not change.
- **Easy/long priced at RPE 3 instead:** 5.52 becomes 3.90 TSS/km. The spin then cuts 2.9 km, and the 60-min HR ride cuts 8.5 km at floor 65%.
- **Scaling today versus proposed.** Today every HR session gets the same output, 6.2 km plus a threshold downgrade, whether it was 20 or 150 TSS. Proposed cuts rise monotonically with the work done: 2.0, 3.2, 5.6, 6.0 and 11.0 km. Only floors and the literature ceiling stop the growth.
- **Fatigue path (separate, unchanged).** If the session fell the day before Thursday's threshold:
  - the 60-TSS ride, the 50-TSS HIIT and the 69-TSS no-HR ride (after the shared-TSS fix) each give one step down with no distance cut;
  - the 150-TSS ride gives two steps and −25% (`timing-check.ts:58-63`);
  - the 20-TSS spin gives nothing.

##### 7.3 The same credits in a 5-run week (why the 3-run week flattens)

The week is easy 8 (Tue), easy 10 (Wed), threshold (Thu), easy 8 (Sat) and long 20 (Sun): 353.4 TSS, with a ceiling of 106.0.

| Credit | Cuts | Total | km per TSS |
|---|---|---|---|
| 11.2 | 8→6.0 | 2.0 km | 0.179 |
| 17.9 | 8→4.8 | 3.2 km | 0.179 |
| 31.0 | 8→4.0, 10→8.4 | 5.6 km | 0.181 |
| 33.7 | 8→4.0, 10→7.9 | 6.1 km | 0.181 |
| 84.2 | 8→4.0, 10→4.0, 8→4.0, Long 20→18.8 | 15.2 km | 0.181 |

The cut is exactly proportional to the work done until floors or the ceiling bind.

##### 7.4 Excess path (Tier 1 silent and Tier 2 "Adjust plan")

Cycling excess, credit = excess × 0.55 × 1.02.

| Excess (TSS) | Today | Proposed |
|---|---|---|
| 5 | 0.9 km | 0.5 km |
| 10 | 1.8 km | 1.0 km |
| 15 | 2.7 km | 1.5 km |
| 30 | 3.2 km (Tier 2, cap-bound per the diagnosis) | 3.0 km |

- Today's Tier 1 ignores the sport (runSpec). The proposed sizing follows `LOAD_BUDGET_SPEC §5`.
- Excess from harder matched runs has runSpec 1.0, so it is cut at about 1:1.

##### 7.5 ACWR path

Signal B 1:1 against `projectedWeekB − safeUpper × chronic`; weekly km floor off. Threshold→MP removes 15.2 TSS (96.1 → 81.0).

| Overshoot | Long floor 65% | Long floor 85% |
|---|---|---|
| 20 | Easy 8→4.4 | Easy 8→4.4 |
| 40 | Easy 8→4.0, Long 20→16.8 | Easy 8→4.0, Long 20→17.0 (0.9 TSS not absorbed) |
| 60 | Easy 8→4.0, Long 20→13.3 | Easy 8→4.0, Long 20→17.0, Threshold→MP (5.7 not absorbed) |
| 80 | Easy 8→4.0, Long 20→13.0, Threshold→MP (2.9 not absorbed) | as at 60, with 25.7 not absorbed |

Today, with `maxAdjustments = 1`, overshoots of 5, 20 and 60 TSS all give −3.2 km (diagnosis §2B).

---

#### 8. Risks and dependencies

1. **Other fixes this design depends on:**
   - **B1 (Signal B seed 0 → false high ACWR).** The ACWR budget uses `chronic`. A falsely low chronic value makes the overshoot, and so the cut, falsely large.
   - **Max HR / normaliser.** p95 locking, overwrites and stored iTRIMP not being recomputed (C14) move HR-session TSS, and credit follows. B12 (female normaliser about 19% low) under-credits women.
   - **B2 / D2 (easy runs priced at RPE 3).** The per-km conversion must use the same scale as the executed run, or cuts are 1.42× too large.
   - **A2 (flows ignore existing mods).** Without mods applied, a small second session resurrects a replaced run and the ledger drifts from the plan.
   - **A3/A4 (timing check).** Quality protection now rests on it.
2. **Behaviour change users will notice.** HR users see much smaller cuts, and the session popup no longer downgrades quality. FEATURES currently describes "intensity first for Balanced/Endurance", so it needs updating.
3. **Unabsorbed remainder in 3-run weeks.** Large sessions hit floors. The modal must say so plainly, e.g. "14 TSS not absorbed. Long run and threshold kept." Otherwise the cut looks disproportionate.
4. **Habitual unplanned sessions.** A regular undeclared ride triggers a cut every week, while `plannedSignalB` already expects it. The existing mitigation is to declare it as a recurring activity so it fills a cross slot (`Load-Reduction-Methodology.md:78-90`).
5. **Ledger migration.** Existing mods have no `xtCreditTSS`. Deriving it from `originalDistance`/`newDistance` × tssPerKm avoids giving existing users a fresh ceiling.
6. **Tier C changes.** Without active fraction, a 90-min padel session at RPE 6 is 130 TSS rather than about 78 on the old scale (D4).
7. **Circular imports.** `suggester.ts → fitness-model.ts` is safe: `fitness-model` imports only `cross-training/activities` from that folder.
8. **Tests that assert old semantics will need rewriting:** `km-budget.test.ts` (RRC as budget) and `boxing-bug.test.ts:230`. The latter still passes: 69 × 0.25 × 1.02 × 0.8 = 14.1 TSS → 2.5 km.

---

#### 9. Tests to add

New file `src/cross-training/proportional-cut.test.ts`:

1. **Unit parity (guards the raw-iTRIMP regression).** An HR session with `iTrimp = X × norm / 100` and a no-HR session with `duration × TL_PER_MIN[rpe] = X` give equal `tssB`. Their budgets differ only by the RPE-only discount and the goal factor.
2. **Monotonic and proportional.** Cycling from 5 to 200 TSS gives total cut TSS that never decreases. Below floors and the ceiling, it equals the credit to within 0.1 km of rounding. Doubling the TSS doubles the km.
3. **Sport sensitivity.** Equal-TSS swim, ride and extra_run give cuts ordered by runSpec. This fixes diagnosis B, "sport ignored".
4. **Quality untouched in session and excess modes.** No adjustment on quality types. Replace never removes quality or long.
5. **Long run.** Cut only after easy capacity is used; type stays `long`; never below `max(10, F × originalKm)`; a second session cannot push it below the floor.
6. **Weekly ceiling is cumulative.** After a first session uses 60 of a 76 TSS ceiling, a second session's budget is 16.
7. **Ledger idempotency.** The same garminId processed twice gives a budget of 0 the second time. A Tier 1 cut followed by the review modal does not double-cut (audit A13).
8. **Excess mode.** A 15-TSS cycling excess gives 1.5 km at 6:00/km. Excess from harder matched runs uses runSpec 1.0.
9. **ACWR mode.** Budget is 1:1; volume before intensity; one rung per session; the downgrade is priced by the TSS difference; no adjustments when the projection is at or under the ceiling.
10. **Floors.** The weekly km floor holds when ACWR is safe or low and is ignored at caution or high. The easy floor holds.
11. **Recovery top-up** is capped at +20 TSS.
12. **Display.** `equivalentEasyKm` equals credit / easy TSS per km, and equals the km cut when nothing binds.
13. **Mods-applied input (A2 regression).** A replaced run is not resurrected by a later 20-min spin.

---

#### Decisions for Tristan

- **D1.** Is the weekly displacement ceiling 0.30 (in code and at the top of Tanaka's range), or 0.20–0.25?
- **D2.** Price easy and long runs at RPE 4, which matches how executed runs are measured, or at the generator's RPE 3? This is tied to audit B2.
- **D3.** Drop `sportMult` for HR-based sessions? Recommended, because Signal B does not apply it.
- **D4.** For no-HR sessions, drop sport mult and active fraction to match Signal B, or apply them in both places?
- **D5.** Keep the 0.80 RPE-only discount on credit?
- **D6.** Easy floor: 4 km or 30 min at easy pace?
- **D7.** Long-run floor fraction: 0.60, 0.65 or 0.85?
- **D8.** Order among easy runs: nearest upcoming first (recommended) or pro-rata (Methodology §6)?
- **D9.** Should the fast-finish long run (`progressive`) be cut like a long run (cut the easy portion, keep the finish) or stay fully protected?
- **D10.** In ACWR mode, which quality session is downgraded first: follow PRINCIPLES (VO2 last) or `workoutPriorityForRace` (for a marathon, VO2 before threshold)?
- **D11.** Unknown-sport runSpec: keep 0.35 or use `generic_sport` at 0.40?
- **D12.** Confirm that the Methodology §5 runner-type volume/intensity weights (0.35/0.65 etc., no literature source) are not implemented, and that the session popup is volume-only for all runner types.
- **D13.** Keep the 0.5 km / 1.0 km minimum cuts and 0.1 km rounding, or round to 0.5 km?

Files referenced: `/home/user/marathon-simulator/src/cross-training/suggester.ts`, `/home/user/marathon-simulator/src/cross-training/universalLoad.ts`, `/home/user/marathon-simulator/src/cross-training/universal-load-constants.ts`, `/home/user/marathon-simulator/src/cross-training/timing-check.ts`, `/home/user/marathon-simulator/src/calculations/fitness-model.ts`, `/home/user/marathon-simulator/src/ui/activity-review.ts`, `/home/user/marathon-simulator/src/ui/excess-load-card.ts`, `/home/user/marathon-simulator/src/ui/main-view.ts`, `/home/user/marathon-simulator/src/workouts/plan_engine.ts`, `/home/user/marathon-simulator/src/constants/sports.ts`, `/home/user/marathon-simulator/src/types/state.ts`, `/home/user/marathon-simulator/docs/specs/Load-Reduction-Methodology.md`, `/home/user/marathon-simulator/docs/specs/LOAD_BUDGET_SPEC.md`, `/home/user/marathon-simulator/docs/PRINCIPLES.md`, `/home/user/marathon-simulator/docs/research/running.md`, `/home/user/marathon-simulator/docs/SCIENCE_LOG.md`.