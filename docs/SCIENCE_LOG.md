# Science Log

Scientific rationale for every model, formula, and algorithm that drives user-facing numbers. Each entry documents the formula, what each term means, why it's defensible, and known limitations.

New entries are added at the top. When modifying a model, update its entry rather than adding a duplicate.

---

## §AA — HYROX Run-Pace Model v2: Critical Pace anchor, continuous interpolation, format conversion, Bayesian personalisation (2026-05-12)

### Why v2

The v1 run-pace model derived HYROX 1km-leg pace as `threshold × fatigueRatio[band]`, with the ratio table floored at 1.05 (`competitive`) — meaning the model could never predict a HYROX run pace faster than 5% slower than the athlete's continuous-tempo threshold. This is wrong for trained HYROXers, and the gap widens with fitness.

**The structural error**: threshold pace is what an athlete can hold for ~60 min straight. HYROX runs are 8 × 1km efforts at ~3–7 min intervals, separated by station work that acts as metabolic recovery for the running musculature. The correct physiological anchor for that pattern is **Critical Pace (CP)**, not Lactate Threshold.

### Scientific anchor — Critical Pace

- **Origin**: Hill (1923), "The maximum work and mechanical efficiency of human muscles" — first power-duration construct.
- **Human application**: Monod & Scherrer (1965), "The work capacity of synergic muscle groups."
- **Modern review**: Jones, Vanhatalo, Burnley, Morton, Poole (2010), *Med Sci Sports Exerc* 42(10):1876–1890, "Critical power: implications for determination of VO2max and exercise tolerance."
- **CP vs threshold**: Galbraith, Hopker, Lelliott, Diddams, Passfield (2014), *Int J Sports Med* 35(7):566–571, "A single-visit field test of critical speed." CP ≈ 95–97% of MLSS (maximal lactate steady state) ≈ slightly slower than LT pace for trained runners.
- **Interval-recovery physiology**: in mixed-modal events, athletes pace at *critical power/pace* rather than at threshold, because intermittent recovery permits expressing capacity at intensities unsustainable continuously (Mangine et al. 2018, *J Strength Cond Res* on CrossFit performance markers).

### Formula

```
pace = gp(vdot, ltPace).t × cpRatio(vdot) × formatFactor(band, targetFormat) + personalOffsetSec
```

- **`gp(vdot, ltPace).t`** — Daniels threshold pace, refined by stored LT pace when available.
- **`cpRatio(vdot)`** — continuous linear interpolation between band-anchor points keyed by VDOT (no more discrete buckets).
- **`formatFactor`** — 1.0 for singles target; `1 / DOUBLES_TO_SINGLES_PACE_FACTOR[band]` for doubles target (faster pace because partner-rest reduces leg fatigue).
- **`personalOffsetSec`** — Bayesian residual from logged-race observations; decays linearly to 0 over 12 months.

### CP-ratio anchor table

Keyed by band-implied VDOT. Ratios descend below 1.0 for trained tiers — the structural break from v1.

| Tier | VDOT | Ratio | Interpretation |
|---|---|---|---|
| total_beginner | 28 | 1.32 | Aerobic ceiling caps everything |
| beginner | 32 | 1.22 | Notably slower than threshold |
| novice | 38 | 1.12 | Limited HYROX-specific conditioning |
| intermediate | 45 | 1.05 | Just slower than threshold |
| advanced | 53 | 1.00 | At threshold (≈ CP for this tier) |
| competitive | 60 | 0.96 | Faster than threshold (CP near 5k-10k pace) |

Cross-referenced against elite HYROX splits:
- Top male singles (~57min): runs ~4:10/km vs probable threshold ~3:45 → 0.93
- Advanced singles (~1:00): runs ~4:30/km vs threshold ~4:15 → 1.06
- Intermediate singles (~1:30): runs ~5:30/km vs threshold ~5:00 → 1.10

Note: linear interpolation between anchor points; clamps below the lowest and above the highest VDOT.

### Format conversion (doubles ↔ singles, same athlete)

In doubles each athlete runs all 8 legs but only completes 4 of 8 stations (partner takes the others). The partner-rest during the other 4 stations means significantly less cumulative leg fatigue when running. Singles forces solo on every station, accumulating eccentric + metabolic load.

| Tier | Doubles → Singles factor | Why |
|---|---|---|
| competitive | × 1.05 | Trained athletes recover well; singles slowdown is small |
| advanced | × 1.06 | |
| intermediate | × 1.07 | Average accumulation of carryover |
| novice | × 1.08 | |
| beginner | × 1.09 | Stations hit harder; bigger run slowdown when solo |
| total_beginner | × 1.10 | |

**v1 calibration source**: gut-anchored from elite split comparisons and interval-recovery literature. **Flagged for empirical recalibration** from the Kaggle 89k-finisher dataset (same-athlete cross-format pairs). Once calibrated, the table will move to `hyrox-population-distributions.ts` with an empirical citation.

### Bayesian personalisation

The population model (CP-ratio + format) is the **prior**. Each logged HYROX race provides an **observation** (back-computed run pace from `finish − stations − roxzone`, divided by 8). The **residual** `observed − model_at_that_format` updates a personal offset:

```
posterior_offset = existing × (1 − w) + residual × w
```

- `w = 0.6` when the race observation comes from per-station splits (high confidence)
- `w = 0.35` when stations were estimated from band seeds (low confidence)
- Combined confidence climbs toward 1.0
- Offset magnitude clamped to ±60 s/km (prevents pathological observations corrupting future predictions)

**Decay**: the offset decays linearly to zero over 12 months without new race evidence. Without recent data, we revert fully to the population prior.

**Initialisation**: at HYROX onboarding, when a previous-race time + format are supplied, the model computes the initial offset right then. With pasted station splits, the back-computation is exact; without splits, it estimates stations from band seeds and applies the lower confidence weight.

### Why offset (sec/km) rather than full pace replacement

- **Survives format changes**: an athlete who races doubles then trains for singles keeps their personalisation signal — the offset is in sec/km, applied after the format factor.
- **Survives single-race noise**: a hot/sick race gets blended with model evidence rather than fully replacing it.
- **Decay-aware**: the offset gracefully retreats over time, returning to the conservative prior rather than fossilising stale data.

### Limitations

- **Singles-only calibration in v1**: doubles ratios are gut-anchored extrapolations; the Kaggle dataset has both formats and same-athlete pairs we haven't yet mined.
- **CP anchor points are tier-based, not directly tested**: a v3 would estimate per-athlete CP directly from training data (e.g. 3-min vs 12-min effort comparison) rather than mapping VDOT → CP.
- **No within-race fatigue model coupling**: the per-leg fatigue distribution (R1 fast → R8 slow) is computed downstream and assumes a constant rate. v3 could let strong stations attenuate downstream run fatigue.
- **First-race observation can dominate**: with no prior offset, a single race observation pulls the offset 35–60% toward its residual. Mitigated by the ±60 s/km clamp.

### Wiring map (where this connects to the rest of Mosaic)

- `src/calculations/hyrox-run-pace.ts` — `deriveHyroxRunPace`, `derivePopulationRunPace`, `cpRatioForVdot`, `convertHyroxRunPaceFormat`.
- `src/calculations/hyrox-personal-pace.ts` — `backComputeRunPaceFromRace`, `blendPersonalRunPaceOffset`, `computePersonalRunPaceOffset`, `estimateStationsAndRoxzoneFromBand`.
- `src/state/initialization.hyrox.ts` — initial offset computation from onboarding race data.
- `src/types/triathlon.ts` — new `personalRunPaceOffsetSec` / `personalRunPaceOffsetUpdatedAtISO` / `personalRunPaceOffsetConfidence` fields on `HyroxConfig`.
- `src/ui/hyrox/stats-view.ts` — Critical Pace card surfacing the derivation chain with tap-to-explain modal.
- `src/calculations/race-prediction.hyrox.ts` — consumes `deriveHyroxRunPace()` for the headline race forecast and the Race Order per-leg display.

### Tests

- `src/calculations/hyrox-run-pace.test.ts` (28) — `cpRatioForVdot` continuity + clamping + monotonicity; `convertHyroxRunPaceFormat` round-trip; `derivePopulationRunPace` shape; full-pipeline source/override/decay behaviour.
- `src/calculations/hyrox-personal-pace.test.ts` (17) — back-computation correctness, blend math, clamp, decay function (12-month boundary, half-life proportionality).
- `src/calculations/hyrox-marker-bumps.test.ts` — updated for v2 expected numerical ranges.

---

## §Z — Plan Phasing: capped single arc + double periodization for long plans (2026-05-11; refined 2026-05-12)

### 2026-05-12 refinement

Three changes applied a day after the initial entry:

1. **Inter-cycle transition labelled `taper` (was `base`).** The 2-week transition between cycles 1 and 2 is a real mini-taper, not aerobic-development weeks. Calling it `'taper'` (a) gets the workout generator's existing taper volume-drop for free, and (b) renders the Phase Timeline as the honest two-arc story `Base → Build → Peak → Taper → Base → Build → Peak → Taper`. Mujika & Padilla (2003) describe intra-cycle recovery between training blocks as physiologically equivalent to a short taper: fatigue clearance while fitness consolidates.

2. **Triathlon and HYROX share the same strategy.** Both formats previously had ratio-based single-arc allocation with no double-periodization path. The `computePlanPhases` function now accepts a `PhaseConfig` parameter; running, triathlon, and HYROX each supply their own config but share the algorithm. Distance-specific ratios are tuned so default plan lengths reproduce canonical splits exactly:

   | Format / distance | Default length | Canonical | Ratios used (peak/build) |
   |---|---|---|---|
   | Running marathon | 16w | 6/6/2/2 | 0.10 / 0.40 |
   | Triathlon 70.3 | 20w | 8/6/4/2 | 0.20 / 0.30 |
   | Triathlon Ironman | 24w | 10/7/5/2 | 0.208 / 0.292 |
   | HYROX | 18w | 7/6/3/2 | 0.20 / 0.333 |

   Caps differ per format: running buildCap=8, peakCap=4, taperCap=3. Triathlon buildCap=8, peakCap=5, taperCap=2. HYROX buildCap=8, peakCap=3, taperCap=2. Taper-cap differences reflect format-specific detraining onset (Mujika & Padilla 2003); peak-cap differences reflect format-specific peaking windows (running peak is short-sharp interval work; tri peak includes race-specific brick volume that benefits from a few more weeks; HYROX peak is compromised-running and station-density work which plateaus quickly).

3. **Double-periodization threshold differs by format**: running 33+, tri 28+, HYROX 28+. The lower tri/HYROX threshold reflects compressed productive single-arc windows in multi-discipline training (more concurrent modalities → faster monotony onset, evidenced by Hellard et al. 2019 in swimmers and Lehmann et al. 1997 in cyclists).

The single-arc capped-allocation rule and the double-periodization cycle structure are otherwise unchanged.

---

## §Z — Plan Phasing: capped single arc + double periodization for long plans (2026-05-11)

### Motivation
Coaches assign training phases (Base / Build / Peak / Taper) according to the time available before a race and the principle of progressive specificity. Mosaic's previous model split plans differently depending on length: ≤16 weeks got a single arc, >16 weeks got a 4-week block-cycle prefix (Base → Build → Peak → Taper repeating) followed by a 16-week race-specific arc. For a 20-week plan this rendered as `Base → Build → Peak → Taper → Base → Build → Peak → Taper`, which reads to the user as the plan regressing mid-cycle and contradicts canonical periodization.

### New model

Phase assignment is produced by `computePlanPhases(totalWeeks)` in `src/workouts/phases.ts`. The function applies one of two strategies based on plan length.

**Single-arc strategy (length ≤ 32 weeks).** Phases assigned by capped allocation:

```
taperWeeks = min(3, max(1, ceil(totalWeeks × 0.12)))
peakWeeks  = min(4, max(1, round(totalWeeks × 0.10)))
buildWeeks = min(8, max(1, round(totalWeeks × 0.40)))
baseWeeks  = totalWeeks − (taperWeeks + peakWeeks + buildWeeks)   // remainder
```

The order in the plan: `Base × baseWeeks → Build × buildWeeks → Peak × peakWeeks → Taper × taperWeeks`.

**Phase caps and their basis:**
- **Taper ≤ 3 weeks** — Pfitzinger & Douglas (2009, *Advanced Marathoning*, ch. 8) cap the longest marathon taper at 3 weeks. Beyond 3w, detraining outweighs fatigue clearance (Mujika & Padilla 2003, *Sports Medicine* 33(13)).
- **Peak ≤ 4 weeks** — Daniels (2014, *Daniels' Running Formula*) and Hudson (2008, *Run Faster from the 5K to the Marathon*) treat "peak" as a short, sharp block of race-specific intensity. Extending it spreads the stimulus and reduces the consolidation effect.
- **Build ≤ 8 weeks** — Bompa & Buzzichelli (2018, *Periodization: Theory and Methodology*) note that beyond ~8 weeks of concentrated specific intensity, endurance athletes plateau or accumulate injury risk. Issurin's block-periodization framework (2008) also targets 2–6 week intensive blocks.
- **Base absorbs the remainder** — long aerobic-development phases are the canonical structure for any plan longer than ~16 weeks. Tønnessen et al. (2014, "The annual training periodization of 8 world-class endurance athletes", *IJSPP* 9(4)) document 60–70% of elite annual training volume in aerobic-base mode.

**Very short plans (4–7 weeks):** the caps naturally collapse `baseWeeks` to 0–2, producing a "sharpening block" (Build → Peak → Taper) with little or no aerobic development. This is the honest answer to "what can be done in 4 weeks?": maintain volume, do 1–2 specific sessions, taper. Fitness cannot be built in a month (Coyle et al. 1984, *J Appl Physiol* 57: 1857–1864 on detraining time-courses; Mujika et al. 2000, *Med Sci Sports Exerc* 32(2)).

**Double-periodization strategy (length ≥ 33 weeks).** A single 40+ week arc loses its training signal: monotonous stimulus, motivational decay, and no intermediate adaptation checkpoint. Real-world elite athletes structure 2–3 macrocycles per year (Tønnessen et al. 2014). Issurin (2010, *Sports Medicine* 40(3): 189–206) formalised this in the block-periodization framework: concentrated 2–6 week training blocks, each targeting one physiological quality, separated by short transitions, are more effective than one continuous mixed arc.

The algorithm allocates cycle 2 as ~55% of total weeks (it carries the race), cycle 1 as ~45% (preparation), with 2 transition weeks between them:

```
cycle2Length = max(12, round(totalWeeks × 0.55))
cycle1Length = max(8, totalWeeks − cycle2Length − 2)

c1Peak  = min(3, max(1, round(cycle1Length × 0.18)))
c1Build = min(6, max(1, round(cycle1Length × 0.35)))
c1Base  = cycle1Length − c1Build − c1Peak

Cycle 1: Base × c1Base → Build × c1Build → Peak × c1Peak (last peak week flagged checkpoint=true)
Transition: 2 × Taper weeks (intra-cycle recovery; Mujika & Padilla 2003 mini-taper)
Cycle 2: single-arc strategy applied with totalWeeks = cycle2Length
```

The final peak week of cycle 1 carries a `checkpoint: true` flag. The phase remains `'peak'` so all peak-aware engine logic (workout generation, scoring, suggestion rules) continues to work; the flag drives a distinct UI label (`Checkpoint`) on the Phase Timeline and — when implemented — a time-trial-flavoured workout week (Mon–Wed easy, Thu opener, Sat hard 5K or 10K TT, Sun easy). The TT result feeds back into VDOT/CSS/FTP auto-refresh, calibrating cycle 2 against measured rather than predicted fitness.

### Limitations
- **No mid-cycle deload weeks in long bases.** A 35-week base block needs internal recovery weeks (typical pattern: 3 weeks progressive load + 1 week deload, repeating). The current model assigns the same phase label to every base week; deloads must come from the workout generator's volume modulation, not the phase tagging. Logged in `docs/OPEN_ISSUES.md` for follow-up if a real user runs a 24+ week plan.
- **Checkpoint week workout content not yet implemented.** The phase flag exists and is rendered in the UI, but `generateWeekWorkouts` currently treats the week as a standard peak week. The TT-flavoured content (and the post-TT VDOT/CSS/FTP refresh hook) is deferred until a real 33+ week plan ships.
- **Cycle ratios are heuristic.** The 45/55 cycle split is a reasonable default but not directly derived from a controlled study; literature on optimal cycle-length distribution within multi-cycle annual periodization is sparse and athlete-specific.
- **Triple periodization not modelled.** Plans >52 weeks (annual+) are not supported.

### References
- Bompa, T. & Buzzichelli, C. (2018). *Periodization: Theory and Methodology of Training* (6th ed.). Human Kinetics.
- Coyle, E. F. et al. (1984). Time course of loss of adaptations after stopping prolonged intense endurance training. *J Appl Physiol* 57(6): 1857–1864.
- Daniels, J. (2014). *Daniels' Running Formula* (3rd ed.). Human Kinetics.
- Hudson, B. (2008). *Run Faster from the 5K to the Marathon*. Broadway Books.
- Issurin, V. (2008). Block periodization versus traditional training theory: a review. *J Sports Med Phys Fitness* 48(1): 65–75.
- Issurin, V. (2010). New horizons for the methodology and physiology of training periodization. *Sports Med* 40(3): 189–206.
- Mujika, I. & Padilla, S. (2003). Scientific bases for precompetition tapering strategies. *Med Sci Sports Exerc* 35(7): 1182–1187.
- Mujika, I., Padilla, S. & Pyne, D. (2000). Detraining: loss of training-induced physiological and performance adaptations. *Med Sci Sports Exerc* 32(2): 413–421.
- Pfitzinger, P. & Douglas, S. (2009). *Advanced Marathoning* (2nd ed.). Human Kinetics.
- Tønnessen, E. et al. (2014). The annual training periodization of 8 world-class athletes. *Int J Sports Physiol Perform* 9(4): 666–673.

---

## §Y — Triathlon Prediction Calibration Loop (2026-05-11)

### Motivation
Population-level race models (Riegel exponent, Daniels VDOT, empirical course factors) have systematic biases at the individual level. An athlete who consistently slows in the run due to heat sensitivity, or who swims better than their CSS predicts in race conditions, sees the same error race after race. The calibration loop turns the race log into a personal bias-correction term.

### Tier-1: per-leg additive bias

For each discipline `d ∈ {swim, bike, run}`:

```
residuals[i] = actualPerLeg[d][i] − predictedPerLeg[d][i]   for each race i
rawBias[d]   = median(residuals[d])
medPred[d]   = median(predictedPerLeg[d])
bias[d]      = clamp(rawBias[d], −0.08 × medPred[d], +0.08 × medPred[d])
```

**Why median (not mean):** a single outlier race (illness, equipment failure, extreme weather) would corrupt a mean-based estimate. The median is resistant to single-event outliers.

**Why ±8% cap:** the known prediction error band for triathlon leg times is approximately 6–14% (derived from the empirical course-factor validation dataset). The cap ensures calibration never exceeds the natural noise floor, keeping it in systematic-correction territory rather than overfitting individual races.

**Application:** bias is added post-readiness to both projected and current estimates. The readiness penalty captures preparation gaps; the bias corrects model-level systematic error. The two are conceptually orthogonal.

### Tier-2: learned readiness maxPenalty scale

For each discipline, regress the residual fraction (after tier-1 bias) against the implied readiness penalty:

```
penaltyExcess[i]      = predictedPerLeg[d][i] / predictedRawPerLeg[d][i] − 1
residualFraction[i]   = (actual[d][i] − (predicted[d][i] + bias[d])) / predicted[d][i]
slope                 = Σ(penaltyExcess[i] × residualFraction[i]) / Σ(penaltyExcess[i]²)
rawScale[d]           = 1 + slope
scale[d]              = 1 + (rawScale[d] − 1) × n / (n + 4)   (Bayesian shrinkage)
scale[d]              = clamp(scale[d], 0.6, 1.4)
```

**Why OLS regression not mean ratio:** the residual-vs-penalty regression tests whether the _magnitude_ of the readiness penalty correlates with the residual. A positive slope means the penalty is understating the true shortfall; a negative slope means over-stating. A mean ratio would capture average error but not the penalty-specific signal.

**Why Bayesian shrinkage toward 1.0 (`n/(n+4)`):** with few races, the OLS slope has high variance. The shrinkage formula (Thompson 1968 type-II estimator with `n₀ = 4`) pulls estimates toward the population prior (scale = 1.0, i.e. current model is correct) until data is sufficient. At n=4, 50% of the raw estimate is retained; at n=8, 67%; asymptotes to the full estimate.

**Why [0.6, 1.4] clamp:** beyond ±40% of the nominal maxPenalty, calibration would be compensating for something fundamentally wrong with the base model rather than individual variation. The clamp prevents pathological correction.

### Limitations

- Tier-1 bias is computed from post-readiness predictions (what was shown to the user), not pre-readiness. This means the bias absorbs both model error AND readiness-penalty error. Tier-2 separates these but requires the newer `predictedRawPerLeg` field.
- All tiers assume the race log is representative of future races at the same distance. A 70.3 bias does not transfer to Ironman — each distance accumulates its own bias independently (future work: distance-group pooling when cross-distance data is sparse).
- Tier 3 (Riegel exponent fit) is dormant until sprint/olympic race logging is added (currently only 70.3/Ironman).
- Calibration recomputes after each logged race but the current prediction must be re-fetched to pick up the updated factors (applies on the next app launch after the race).

---

## §W — Empirical Transition Times by Race × Level Bin (2026-05-08)

**Side of the line**: tracking → race prediction. Adds a transition-time term to the predicted finish that reflects what real finishers at the user's level actually achieve at this race, replacing the hand-tuned `T1_SEC_BY_SLIDER` / `T2_SEC_BY_SLIDER` skill defaults whenever empirical data exists.

**Files**: `src/validation/transition-distributions.ts`, `src/validation/dataset-loader.ts` (extended `FinishRecord`), `src/validation/run-calibration.ts` (emits `empirical-transition-distributions.json`), `src/calculations/empirical-transitions.ts` (runtime lookup), `src/calculations/race-prediction.triathlon.ts` (priority chain at `t1Sec` / `t2Sec` resolution), `src/types/triathlon.ts` (`triConfig.transitionOverride`).

### Calibration

```
For each (distance, eventLocation, levelBin):
  levelBin     = floor((swim + bike + run − binMin) / binWidth)   ← excludes transitions
  binWidth     = 15 min (70.3) or 30 min (IM)
  T1_mean(L,b) = mean of t1Sec across finishers in cell  (70.3 only)
  T2_mean(L,b) = mean of t2Sec across finishers in cell  (70.3 only)
  TT_mean(L,b) = mean of (t1Sec + t2Sec) across finishers in cell  (both distances)

Confidence:
  race-specific cell:   require ≥ 50  finishers in (L, b)
  global fallback bin:  require ≥ 200 finishers in b across all races
```

### Why bin on swim+bike+run (not finish time)

The level bin must be independent of transition skill itself, otherwise we'd be looking at "how slow are transitions for people whose transitions were similarly slow" — circular. Using `swim + bike + run` ("moving time") gives an objective fitness-tier proxy that's consistent on both sides of the lookup: the historical record provides it directly, and the runtime predictor naturally has it before adding transitions.

### Runtime resolution chain

```
1. user override     (triConfig.transitionOverride)        — manual hardcode
2. race × level bin  (≥ 50 finishers in cell)              — most specific empirical signal
3. global level bin  (≥ 200 finishers across all races)    — fallback when cell sparse
4. skill-slider      (T1_SEC_BY_SLIDER / T2_SEC_BY_SLIDER) — original defaults, last resort
```

For Ironman, only T1+T2 combined is available (the source CSV's `results.csv` doesn't expose separate T1/T2 columns; we derive `transitionSec = overall − swim − bike − run`). When the empirical lookup returns a combined-only number we split T1 / (T1+T2) ≈ 0.58 (constant `IM_T1_SHARE_OF_TOTAL`) derived from the 70.3 dataset where per-side data exists. T1 runs longer than T2 in practice because of the wetsuit strip and the longer transition-zone walk on the swim-exit side at most venues.

### Why this is defensible

- **Ground truth.** 840k 70.3 finishes (2004–2020) and 1.09M IM finishes (2002–2024) from public Kaggle datasets. Same source the course-factor calibration draws on (§G).
- **Pro-vs-amateur gradient is real and observed in the data.** Sub-4:30 70.3 finishers average 4.5 min total transitions; 7:50 finishers average 11.6 min. Sub-9:15 IM finishers average 7.7 min; 15:45 finishers average 23.7 min. The hand-tuned slider compressed this ~2.5× spread into a fixed 4.5× one (120s elite → 540s beginner for T1) without venue-specific resolution.
- **Race-specific is meaningful.** Some venues have long T1 walks from beach to transition or muddy run-outs; others are flat parking lots. Per-race binning preserves this where data permits.
- **Transition times don't degrade like fitness markers.** No decay model needed — what finishers averaged at this race in 2018 is still a defensible prior for 2026 unless the venue layout changed materially.

### Sockless modifier

Socks are a single one-time event during a triathlon — they go on once at a transition (or not at all) and stay on. The user picks where via `triConfig.transitionSocks`:

```
't1'   → sock-on at T1 (population default) → no adjustment
't2'   → sockless on bike, sock-on at T2     → −SOCK_ON_COST_SEC T1, +SOCK_ON_COST_SEC T2
'none' → never wears socks                   → −SOCK_ON_COST_SEC T1 only

SOCK_ON_COST_SEC = 20
```

Empirical T1/T2 already reflects the "sock-on at T1" baseline because that's what most racers do. The selector shifts or removes that cost from the resolved baseline. Applied on top of whichever path resolved T1/T2 (override, empirical, slider). Floored at 60 s per side so we never go negative.

**Why 20 s**: this is the practised-athlete steady state for putting socks on once. Coaching consensus across Joe Friel (*Triathlete's Training Bible*), Tower 26, and TrainingPeaks is 15–30 s for an experienced sock-on event; 20 s sits in the middle. Inexperienced athletes on wet feet take longer, but the model assumes the user has rehearsed.

**Why one event, not two**: the previous model treated socks as a per-leg decision (sock-on at T1 *and* T2 as independent events). That doesn't match how triathletes actually race — once socks are on, they stay on. Modelling it as a single event the user *places* (T1, T2, or never) is both more realistic and produces sensible per-leg projections: 't2' people get faster T1 and slower T2 (no net change), 'none' people save the full sock-on cost.

**Why this is OK to be a constant rather than personalised**: it's a user-controlled race-day preference, not a fitness state. The athlete *decides* where their sock-on event falls. The model just translates that choice into a time delta. Personalising the cost would require per-athlete sock-on-time data we don't collect, and the variance is small enough that a constant is fine for a 20 s adjustment.

### Limitations

- **No T1/T2 split for Ironman.** The miguswong CSV exposes only `swimTime`, `bikeTime`, `runTime`, `overallTime`. Combined transitions are derivable; per-side splits are not.
- **No year-on-year weighting.** Same caveat as course factors (§G) — a venue with a 2018 layout change contributes the lifetime average rather than the post-change average.
- **Bin width is uniform.** A 4:00 70.3 finisher and a 4:14 finisher land in the same 15-min bin; no smoothing across bins. The granularity is acceptable for a ~30-second-magnitude signal.
- **Confidence floors are pragmatic, not derived.** 50 / 200 thresholds match the existing course-factor and split-distribution conventions; a formal SE-based gate would be more rigorous but the practical effect is similar.

### Sources

- Kaggle: Ironman 70.3 races 2004 to 2020 — David at aiaiaidavid (840k rows)
- Kaggle: Ironman 140.6 Results 2002 to 2024 — miguswong (1.09M rows)
- See `docs/CALIBRATION_TRIATHLON.md` for the full pipeline.

---

## §V — HYROX Race-Age Staleness with Cross-Mode Physiology Mitigation (2026-05-08)

**Side of the line**: tracking. Race time from a year ago should not anchor today's forecast with the same authority as last week's, but a still-fit athlete shouldn't be penalised either. This model computes a time-decay weight on the previous race time and gates the penalty on cross-mode physiology evidence (VDOT, MTL CTL, Strava `ctlBaseline`).

**Files**: `src/calculations/hyrox-staleness.ts`, `src/calculations/race-prediction.hyrox.ts` (confidence cap + per-station + seed blends), `src/state/initialization.hyrox.ts:131-150` (re-band gate), `src/ui/hyrox/forecast-view.ts:365-376` (UI chip), `src/calculations/hyrox-staleness.test.ts` (11 tests), `src/calculations/race-prediction.hyrox.test.ts` (4 staleness blend tests).

### Model

```
ageMonths = (now − hyroxPreviousRaceDate) / MONTH_MS

baseBandWeight, baseSplitsWeight, confidenceCap = piecewise by category:
  fresh      (<6mo)    1.0    1.0    null
  aging      (6–12mo)  1.0→0.4 (linear)    1.0→0.8    'medium'
  stale      (12–24mo) 0.4→0.2             0.8→0.6    'low'
  very_stale (24+mo)   0.2                 0.6        'low'
  unknown    (no date) 1.0    1.0    null

mitigation = mean(VDOT vs band-implied, MTL CTL vs anchor, ctlBaseline / 100)
             clamped [0.5, 1.0]

bandWeight   = baseBandWeight   + (1 − baseBandWeight  ) × (mitigation − 0.5) × 2
splitsWeight = baseSplitsWeight + (1 − baseSplitsWeight) × (mitigation − 0.5) × 2
```

**Splits decay slower than band.** The skill components of HYROX (sled push technique, sandbag carry mechanics, wall ball cadence) decay slower than pure VO2max if the athlete keeps doing functional work. Band weight indexes raw fitness; splits weight indexes skill — they should not decay at the same rate.

**Re-band gate** (`initialization.hyrox.ts:131-150`): when `bandWeight < 0.7` AND VDOT-implied band ≠ time-based band, take the SLOWER of the two. Conservative — never over-promise on a stale benchmark, even if VDOT looks better.

**Confidence cap** is applied AFTER the calibration-coverage cap and only tightens, never loosens.

### Rationale

- **Detraining literature anchor**: Mujika & Padilla (2000) "Detraining: loss of training-induced physiological and performance adaptations" Sports Med 30:79-87. VO2max declines ~3-5% per month in trained athletes after stopping training; recovers faster than initial gains were earned. Coyle et al. (1984) "Time course of loss of adaptations after stopping prolonged intense endurance training" J Appl Physiol 57:1857-1864 — quantitative time-course for the first 12 weeks of detraining.
- **Skill-vs-fitness split**: from coach reports and HYROX-specific reasoning. No published longitudinal HYROX detraining data exists yet. The stations that score on technique (sled push form, sandbag economy) hold up well in athletes who maintain general functional work; the cardio engine decays faster.
- **Mitigation clamp [0.5, 1.0]**: design choice — we never PUNISH an athlete for poor cross-mode evidence, we only RELEASE the staleness penalty when evidence is strong. A user without VDOT or Strava sync gets the floor (0.5) and the time decay applies in full.

### Pre-fix bug

A 1:00:00 doubles HYROX from a year ago was treated identically to one from last week. The `competitive` band stuck on the time-based threshold even though current VDOT was below the band's implied 60. Combined with Bug 3 (wrong slot) and Bug 2 (wrong-direction cross-format factor), this drove the 56-min headline prediction.

### Limitations

- Thresholds (6 / 12 / 24 months) are directional, not precise. Recalibrate when HYROX returning-athlete data ingest exists.
- Mitigation is arithmetic-mean-blended across three signals without confidence weighting per signal. Could be improved.
- `hyroxPreviousRaceDate` is required for any time-decay; users without it get the `unknown` category (full trust). Fail-soft design — better to not penalise an unknown than to wrongly penalise a recent race.
- Skill-vs-fitness decay rates are coach-derived, not measured. Holds until validated against HYROX returning-athlete cohorts.

### Update — weights now applied to predicted time (2026-05-08, later same day)

Initial wiring of §V only fed `confidenceCap` into `predictHyroxRace` — the predicted *time* still anchored 100% on the historic race regardless of staleness. `bandWeight` and `splitsWeight` were computed but never applied. Closed in `race-prediction.hyrox.ts`:

- **`splitsWeight` per-station blend**: `effectiveBase = splitsWeight × calibrated + (1 − splitsWeight) × seed`. A `very_stale` race with no physiology mitigation lands at `splitsWeight≈0.6`, blending the old benchmark 60/40 toward the band's seed.
- **`bandWeight` seed blend**: when the VDOT-implied band differs from the stored band AND `bandWeight < 1`, seed times themselves blend across the two bands. Combines with the existing re-band gate in `initialization.hyrox.ts` — that gate snaps the band to the slower of the two when `bandWeight < 0.7`; the seed blend handles the moderate-staleness range where the gate doesn't fire.
- The per-station blend is applied BEFORE the venue / Pro / fatigue multipliers so all downstream maths runs on the staleness-adjusted base.

**Test coverage**: `race-prediction.hyrox.test.ts` adds 4 tests pinning the blend at fresh-race no-blend, `very_stale` blend toward seed, partial-mitigation band shift, and strong-physiology weight-recovery boundaries.

---

## §U — HYROX VDOT-Derived Run Pace + Provenance (2026-05-08)

**Side of the line**: tracking. The HYROX prediction needs an honest per-km pace for the 8 × 1km run legs. Pre-fix used `SEED_RUN_PACE_SEC_KM[band]` as a population-mean fallback whenever the user hadn't entered a manual pace — which ignored the athlete's actual aerobic capacity. A VDOT-50 athlete in the intermediate band got the same seed pace as a VDOT-44 athlete in the same band.

**Files**: `src/calculations/hyrox-run-pace.ts` (derive function + ratios), `src/calculations/hyrox-marker-bumps.ts` (yield-to-improvements wiring), `src/calculations/race-prediction.hyrox.ts:163` (consumed by predictor), `src/main.ts:711-725` (launch-time apply + bump pass), `src/calculations/hyrox-run-pace.test.ts` (8 tests), `src/calculations/hyrox-marker-bumps.test.ts` (14 tests).

### Model

```
threshold_sec_km = gp(vdot, ltPace).t                              # Daniels lactate-threshold pace
derived_sec_km   = max(MIN_PACE,
                       round(threshold_sec_km × HYROX_FATIGUE_TO_THRESHOLD_RATIO[band]))
```

Per-band ratio (back-calibrated to existing `SEED_RUN_PACE_SEC_KM` at each band's implied VDOT):

| Band | Implied VDOT | Seed pace | Threshold ≈ | Ratio |
|---|---|---|---|---|
| competitive    | 60+   | 232 s/km | 221 | **1.05** |
| advanced       | 50–55 | 270      | 245 | **1.10** |
| intermediate   | 45    | 305      | 265 | **1.15** |
| novice         | 38    | 355      | 296 | **1.20** |
| beginner       | 32    | 400      | 320 | **1.25** |
| total_beginner | 28    | 435      | 335 | **1.30** |

Ratio rises as ability drops — beginners slow down more across stations.

### Provenance and yield-to-improvements

`HyroxConfig.hyroxRunPaceSource: 'user' | 'derived' | 'seed'` tracks where the in-use value came from. Mirrors the project-wide rule (CLAUDE.md "Manually-set Benchmarks Yield to Improvements"):

- User-entered value is kept unless `derived ≤ userVal − 5 s/km`. Below that margin, user wins.
- When derived overrides, provenance flips to `'derived'` and `notifiedMarkers.hyroxRunPaceSecKm` snapshots the new value so subsequent improvements can be detected as marker bumps.
- The detect→apply order at `main.ts:715-720` is load-bearing: detect must see pre-apply state, otherwise `userVal === derived` after the write and the gate fails. Pinned by regression test.

### Rationale

- **Why threshold pace?** HYROX 1km legs are run at fatigued effort, slightly slower than fresh threshold pace because of accumulated station load. Threshold (lactate threshold, ~80–85% HRmax for trained athletes) is the right anchor — it's the highest sustainable pace the athlete could hold for ~30–60 min of pure running, before fatigue compounds. The fatigue-to-threshold ratio captures the band-dependent slowdown.
- **Why band-keyed ratio, not athlete-specific?** Without per-athlete HYROX run-leg history, we can't fit individual ratios. Band-keyed is the next-best abstraction. When Strava ingest of HYROX events lands and we have measured run-pace-vs-VDOT for individual users, recalibrate per-athlete.
- **`HYROX_RUN_PACE_MIN_SEC_KM` (190 s/km = 3:10/km) floor**: would clip an elite at VDOT 80 (computed ~178). Floor is intentional — 1km HYROX legs after stations are slower than fresh-1km capacity even at the elite level (Brandt & Ebel 2025 — top-pro run splits within ~2-4% across all 8 legs but absolute pace is fatigued).

### Pre-fix bug

VDOT was tracked but unused for HYROX run pace. Strong runners with weak HYROX history got seeded paces matching their finish-time band, not their physiology. Combined with the slot/band/staleness bugs, this contributed to the 56-min prediction symptom by underweighting current aerobic fitness.

### Limitations

- Daniels threshold is a single-point estimate from VDOT; doesn't model aerobic vs ergogenic drift or per-athlete LT fraction.
- Ratio is back-calibrated to seed paces, not measured from longitudinal HYROX run-leg data.
- `HYROX_FATIGUE_TO_THRESHOLD_RATIO` doesn't model temperature, altitude, or floor surface — those are layered separately by the venue model.

---

## §T — HYROX Bidirectional Cross-Format Same-Athlete Factor (2026-05-08)

**Side of the line**: tracking + planning. Used for ability-band derivation when the previous-race format differs from the target format (`initialization.hyrox.ts:111-124`). Sets the band, which sets MTL cap, plan duration, seed station times, and fatigue rates.

**Supersedes §N.** The single-direction `DOUBLES_TO_SINGLES_FACTOR = 0.92` previously documented in §N was wrong-direction at the population level (singles is harder than doubles, not easier) and ignored the same-athlete picture. Replaced with two anchored constants.

**Files**: `src/constants/hyrox-constants.ts:32-36`, `src/state/initialization.hyrox.ts:111-124`, `src/calculations/hyrox-format-band.test.ts` (8 tests).

### Model

```
SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES = 1.22
SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES = 0.85

# In initializeHyroxSimulator, before banding:
adjustedPrevTimeSec =
   prevIsDoubles && !targetIsDoubles ? prevTimeSec × 1.22  # doubles result → singles equivalent
  !prevIsDoubles &&  targetIsDoubles ? prevTimeSec × 0.85  # singles result → doubles equivalent
                                       prevTimeSec        # same format → no adjustment
```

Used **ONLY** for band derivation. Per-station cross-format inference is intentionally NOT attempted; the predictor falls back to seed station times for the target format and surfaces `confidence = 'low'` (`race-prediction.hyrox.ts:178-210, 380`).

### Rationale

- **Population data lower bound (1.125)**: HYROX results data, S4–S6, 89,868 finishers (`src/data/hyrox-population-distributions.ts`). Open singles P50 total = 5338 s; open doubles P50 total = 4747 s. Cohort ratio = 1.125. This is a *cohort comparison*, not same-athlete: more skilled athletes self-select into singles, so this systematically understates the same-athlete gap.
- **Coaching consensus midpoint (1.20–1.25)**: Hyrox Hub and Roxzone pacing analyses, race-time prediction reports for athletes who race both formats. The doubles partner-rest pattern lets each athlete push closer to maximal effort on each station, but the active partner only does 4 of 8 stations — total time benefits substantially from the rest. A 60-min doubles athlete is typically a 73–75 min singles athlete (× 1.22 → 73.2 min).
- **1.22 chosen** as the empirical-meets-coaching anchor.
- **Inverse direction (0.85)**: pure inverse (1 / 1.22 = 0.82) understates the partner-rest benefit at the SINGLES → DOUBLES direction. A singles athlete's per-rep capacity is a ceiling; their realistic doubles total is faster than 1/1.22 implies once partner rest is factored in. 0.85 reflects this asymmetry.

### Pre-fix bug

The single 0.92 constant was applied as `doublesSec × 0.92 = singlesSec` — wrong direction (singles is *slower* than doubles for the same athlete because no rest, not faster). Combined with Bug 3 (slot keyed off target format, so doubles splits got filed as singles benchmarks), this collapsed a 60-min doubles athlete into the `competitive` singles band with full singles benchmarks, producing a 56-min headline prediction.

### Per-station cross-format — deliberately NOT attempted

The doubles format covers only 4 of 8 stations and includes asymmetric partner rest. Singles per-station times are a fresh-rep ceiling but real doubles pacing benefits from rest patterns we don't model. Inferring per-station times across formats from current data is undefensible:

1. Cohort selection bias (singles cohort skews stronger).
2. Asymmetric rest pattern not in any public dataset.
3. Per-station competitiveness varies by format (sled push is less of a discriminator in doubles where partners share load).

So when only the OTHER format's benchmarks exist, the predictor uses target-format seeds and drops confidence to 'low'. Recalibrate when matched-athlete cross-format data becomes available (e.g. Strava ingest of dual-format athletes).

### Limitations

- Single global factor; individual variation substantial. Strength-biased athletes lose more in singles (no rest); endurance-biased athletes lose less.
- Pro division may have a smaller gap (higher floor on competitive drive in both formats), insufficient data to separate.
- Recalibrate when matched-athlete cross-format records become available.

---

## §S — HYROX Per-Station Trajectory Model (2026-05-07)

**Side of the line**: tracking. Projects each station's test pace forward to race day given current training dose. Independent of the aggregate `buildHyroxProjection` (§P) which projects total finish from MTL/adherence/taper/readiness signals — this model answers "what's the trainable headroom on each station?" not "how is your overall trajectory tracking?".

**Files**: `src/constants/hyrox-horizon-params.ts` (constants + class map), `src/calculations/training-horizon.hyrox.ts` (curve math), `src/calculations/race-prediction.hyrox.ts` (`buildStationProjection` integration), `src/ui/hyrox/forecast-view.ts` (Trajectory panel), `src/calculations/training-horizon.hyrox.test.ts` (20 tests).

### Model

Three station classes plus RoxZone, each with its own horizon curve. The math mirrors `training-horizon.triathlon.ts` (week-factor exponential + session-factor sigmoid + undertrain penalty + taper bonus + adherence penalty + adaptation ratio). Per-class differentiation lives in `max_gain_pct`, `tau_weeks`, and `taper_bonus_pct`.

```
improvement_pct = max_gain_pct × week_factor × session_factor × exp_factor
                + taper_bonus
                − undertrain_penalty
                − adherence_penalty
                ; × adaptation_ratio
                ; clamp [0, max_gain_cap_pct]

projected = baseline × (1 − improvement_pct / 100)
```

Where:
- `week_factor = 1 − exp(−(weeks_remaining − taper_weeks) / tau_weeks)` — saturating exponential
- `session_factor = 1 / (1 + exp(−0.7 × (sessions_per_week − ref_sessions)))` — logistic dose-response, k=0.7 mirrors `TRI_K_SESSIONS`
- `exp_factor` — `EXP_FACTORS[experience_level]` (kept in lockstep with marathon/tri)
- `taper_bonus = taper_bonus_pct × min(1, weeks_remaining / taper_weeks)` — full bonus only if athlete has time for the taper
- `taper_weeks = HYROX_TAPER_WEEKS = 1.5` — single Hyrox-wide value (per Mujika 2010 review of high-intensity event tapers)

**Floor at 0%, not negative.** Lessons-learnt directly from the triathlon model: a negative floor produced "training will make you slower" projections in degenerate cases. We clamp at 0 — worst case = current fitness, never regression from training itself.

### Class assignments

| Class | Stations | Rationale |
|---|---|---|
| **A. Cardio erg** | SkiErg, Row Erg | Aerobic ergometer; physiology ≈ cycling FTP. 1km efforts (~3-4 min) more anaerobic than steady-state FTP, so slightly more conservative gains. |
| **B. Strength-endurance** | Sled Push, Sled Pull, Burpee Broad Jumps, Sandbag Lunges, Wall Balls | Lactate tolerance + local muscular endurance. Largest novice gains, hard plateau in advanced. |
| **C. Grip / carry** | Farmer Carry | Narrow trainability without specific work; conservative. |
| **RoxZone** | Transitions | Experience- and technique-driven, not strength or cardio. |

### Calibrated constants (`max_gain_pct`, intermediate band)

| | Class A | Class B | Class C | RoxZone |
|---|---|---|---|---|
| total_beginner | 14% | 18% | 12% | 10% |
| beginner | 12% | 15% | 10% | 8% |
| novice | 10% | 12% | 8% | 6% |
| **intermediate** | **7%** | **8%** | **5%** | **5%** |
| advanced | 4% | 5% | 3% | 3% |
| competitive | 2% | 3% | 2% | 2% |

### Citations

- **Class A — Cardio erg**:
  - Mikulic P & Ružić L (2008) "Predicting the 1000-m rowing ergometer performance" — well-trained rowers improve 5-10% in 12wk; novices 10-15%.
  - Lawton TW, Cronin JB, McGuigan MR (2011) "Strength testing and training of rowers" Sports Med 41:413-432.
  - Concept2 12-week 2k erg plan (empirical) — 3-7% intermediate gains.
  - Coggan A & Allen H (2019) "Training and Racing with a Power Meter" 3rd ed. Ch. 7 — bike FTP curves as the cycling analogue (rowing/skiing physiology ≈ cycling).
  - Crawford & Drake (2020) HIFT 6-wk intervention — 8-15% VO2max gains in mixed cohorts.
- **Class B — Strength-endurance**:
  - Bompa T & Buzzichelli C (2018) "Periodization Training for Sports" 4th ed. — LME 10-25% in 6-12 wk untrained; saturates rapidly when trained.
  - ACSM Position Stand (2009) "Progression Models in Resistance Training" MSSE 41:687-708 — 10-20% gains untrained, 3-6% advanced.
  - Schoenfeld BJ et al. (2021) "Loading Recommendations for Local Endurance" Sports 9:32 — 15+ rep schemes maximise LME.
  - Brandt & Ebel (2025) "Acute physiological responses and performance determinants in Hyrox©" Frontiers in Physiology — sled push fastest despite heaviest load (power-endurance, not max strength).
  - Mountain Tactical Institute mini-study — sled push intervals, 7-12% in 3-min Prone-to-Sprint over 8 wk.
  - Kliszczewicz et al. (2014, 2019) — CrossFit metabolic-conditioning data for burpee-style efforts.
- **Class C — Grip / carry**:
  - Winwood PW et al. (2014) "Strength and conditioning practices of strongman athletes" J Strength Cond Res 28:3678-3686 — loaded carries respond well to specific work.
  - Hindle BR et al. (2019) "Loaded carries — a review" Strength & Cond J 41:69-75 — 6-12 wk specific programs deliver 10-20%; without specific work, plateau quickly.
  - McGill SM (2010) "Core training: evidence translating to better performance and injury prevention".
- **RoxZone**:
  - roxlyfe.com elite-vs-average — elite 2:54 transition total vs average 6:58 (4-min skill gap).
  - HyroxDataLab target-split table — 6:30 transitions at intermediate, 12:00 at total_beginner.
  - Brandt & Ebel (2025) — pacing and transition management as primary race-day differentiators.

### Sessions/week — Hyrox-wide, not per-station

A single `plannedHyroxSessionsPerWeek` count drives all three classes. Why: one Hyrox-style workout typically hits multiple stations and a run, so per-station counting would either double-count (every workout = 1 to every class) or be structurally noisy (only 0.3 sled sessions/wk would read as undertraining for sled even though every Hyrox session involves loaded movement). The literature reports class-level adaptation rates against total Hyrox-style frequency — we mirror that.

`plannedHyroxSessionsPerWeek` reads `wk.triWorkouts` over the next 4 weeks and averages session count. Lesson from triathlon: PLANNED sessions, not historical. Historical reads 0/wk on a fresh plan and trips the undertrain penalty, making the projection slower than current.

### Anchoring `currentSec` — display consistency rule

The "current" value displayed in the trajectory panel IS the `baseSec` from the same `predictHyroxRace` call that drives the per-station forecast panel and benchmark cards. Computing it twice via two paths (a parallel re-derivation) was the bug behind the triathlon LT-pace mismatch (race-forecast-card.ts:370 — same user saw 4:23 in one place, 4:08 in another). The trajectory panel must NOT recompute "current" — it propagates the projection delta to the canonical baseline.

**Venue factors are NOT applied to the trajectory.** This panel projects "test pace today → test pace race day" — unfatigued benchmark trajectory. Venue-day adjustments (floor, lap, temp, altitude) live in the existing course-factors panel and apply to the in-race adjusted time, not the test pace.

### Confidence

**Medium-low.** Several sources of uncertainty:

1. **No HYROX-specific longitudinal trainability data exists.** Class B numbers extrapolate from LME literature with a discount factor; Class A from rowing-erg and bike-FTP studies; Class C from strongman and loaded-carry literature. The Brandt & Ebel 2025 paper has a sample size of 11 — not yet enough to validate per-station gain rates.
2. **Class assignment is structural, not calibrated.** Wall balls in particular straddle the cardio/strength-endurance line; assigned to B because the limiting factor is squat-and-throw eccentric work, not pure aerobic capacity.
3. **`adaptation_ratio` defaults to 1.0.** Per-class adaptation signals (HR-at-power drift on erg sessions, pace decay across sled reps) will plug in here as Phase 2 work — same architecture as the triathlon Phase 2A adaptation engine.
4. **Adherence penalty defaults to 0** in v1. Future per-class scoring will track which classes the athlete actually executed vs missed.

### Limitations

- **In-race fatigue gap not modelled in the projection.** The trajectory shows test-pace improvement; actual in-race times will be slower because of accumulated station fatigue (which is modelled separately via `PER_STATION_FATIGUE_RATE_BY_BAND` for the run legs but not propagated to station times).
- **Singles-only calibration.** Doubles format applies the same horizon model to the 4 active stations, but a doubles athlete's adaptation profile may differ from singles.
- **No band-transition logic.** A novice who improves to intermediate during a long horizon should switch to intermediate's gain rates mid-block. The current model holds the band fixed.

### Taper invariant (test-pinned 2026-05-09)

Two unit tests in `training-horizon.hyrox.test.ts` pin the Mujika-grounded taper behaviour so future edits don't drift:

1. **Race inside taper window yields meaningfully less gain than build-phase race.** At `weeks_remaining = 1.0` (inside `HYROX_TAPER_WEEKS = 1.5`), `weeks_eff = max(0, 1.0 - 1.5) = 0`, so `weekFactor = 0` and the build-phase fitness contribution collapses entirely. Only the taper bonus survives, scaled by `taperRatio = min(plannedTaperWeeks, weeksRemaining) / plannedTaperWeeks`. Build-phase gain (race in 8 weeks) must be at least 1.4× larger than taper-phase gain.
2. **Race tomorrow with full sessions floors below 1% improvement.** At `weeks_remaining ≈ 0.05`, `taperRatio ≈ 0.033`, and total gain stays below 1% even with maximal session count. Prevents the pathological case where a user setting a plan one day before their race sees a "−5s SkiErg" projection that would only be earnable via real adaptation time.

Both tests reflect Mujika & Padilla 2003 (*Med Sci Sports Exerc* 35(7):1182–1187): performance gains during a 1–3 week taper come from fatigue removal (super-compensation), not from new adaptive stimulus. The horizon model captures this by zeroing `weekFactor` inside the taper window and surfacing only the `taperBonus` component (which represents fitness coming forward, not new fitness arriving). User-facing implication: setting a plan one week before a race shows near-zero forecast movement, which is the honest and correct read.

---

## §R — HYROX Real Population Distributions (2026-05-07)

**Source**: Kaggle dataset `jgug05/hyrox-results` (Seasons 4–6, ingested 2026-05-07). 92,375 raw rows → 89,868 after sanity filtering (dropped DNS/scoring outliers via `total_time ∈ [30 min, 5 h]`, `run_time ∈ [20 min, 2.5 h]`).

**Methodology**: percentile breakpoints computed at p1, p5, p10, p25, p50, p75, p90, p95, p99 per format per metric. Lookup uses linear interpolation between adjacent breakpoints. Stored as `Array<[seconds, cumulativePercentile]>` in `src/data/hyrox-population-distributions.ts`.

**Coverage**:
- `open_singles` — 50,364 rows. Strong coverage.
- `pro_singles` — 11,458 rows. Adequate; smaller sample so tail percentiles wider.
- `open_doubles` — 28,046 rows.
- `pro_doubles` — 0 rows (dataset doesn't separate). Falls back to synthesised distribution.

**Validity caveats**:
- Dataset is Seasons 4–6 (2022–2023). Newer seasons are not yet ingested — population may have shifted slightly with HYROX's growing accessibility.
- Demographics not stratified: tables are gender-mixed and age-mixed. A 25-year-old male and a 50-year-old female get the same percentile mapping. Per-demographic tables are a future improvement.
- The Kaggle dataset has no per-station split percentiles (only per-leg `run_n` and `work_n` cumulative). Per-station distributions remain synthesised — a follow-up if individual station times become available.

**Refresh**: re-run `scripts/ingest-hyrox-results.mjs` with a fresher CSV, paste the generated tables back. Bump `LAST_REFRESH_DATE`.

---

## §Q — HYROX `hxFormat` workout tagging (deferred decision, 2026-05-07)

**Problem**: when an activity-matcher derives a benchmark from a completed station/brick session, it currently writes the result to whichever benchmark slot matches the user's *current* `hyroxConfig.format` (Singles or Doubles). For a hybrid athlete who trains both formats in the same plan, this routes some sessions to the wrong slot.

**Proposed fix**: tag each generated workout with `hxFormat?: HyroxFormat` at generation time so the matcher can route to the correct slot regardless of current config.

**Decision: defer.** Rationale:
- The current default behaviour (route to current config format) is correct for ≥95% of users — those who train one format at a time per plan. Hybrid trainers are an edge case worth fewer engineering hours today than the validation work outlined in §R.
- Adding `hxFormat` to every generated workout requires plumbing through `hyrox-generators.ts` (5 generators), the plan engine, and the matcher. Non-trivial.
- We have a workable substitute: the user's `hyroxConfig.format` reflects the format they're targeting. If they switch mid-plan, their existing benchmarks migrate via the existing slot logic.

**Revisit when**: the first dogfood report from a hybrid athlete shows misrouted calibrations, OR the plan-engine adds explicit "hybrid" mode (alternate sessions in singles + doubles formats).

---

## §P — HYROX Race-Day Projection Model (2026-05-07)

**Model**: `buildHyroxProjection` in `src/calculations/race-projection.hyrox.ts`.

Adjusts the current "if you raced today" prediction toward race day via four stacked percentage factors. Same shape as the triathlon `buildProjection`/`applyTriHorizonRun` pattern (race-prediction.triathlon.ts:340).

**Factor 1 — Training fitness** (±5% bound). `mtlCTL` is the 42-day daily-equivalent EMA of weekly MTL (the chronic load anchor). Compared to a band-anchored expectation: `expectedMtlCtl(band) = HYROX_MTL_CAP[band] × 0.70 ÷ 7` (~70% of the band's cap, daily-equivalent). Athletes training above their band's anchor are projected to outperform; below get penalised. Soft-saturating at ±5% prevents extreme ratios from overwhelming the projection.

**Factor 2 — Weekly volume** (±3% bound). Configured `runsPerWeek + stationSessionsPerWeek + bricksPerWeek` vs `HYROX_WEEKLY_SESSIONS[band]` total. Smaller weight than fitness because volume is already partly captured in CTL.

**Factor 3 — Plan adherence** (0..+4% slowdown). Completed sessions / planned sessions over the last 3 completed weeks. Same penalty pattern as triathlon's `tri-adherence.ts:80` — missed sessions incur a slowdown, full adherence is neutral.

**Factor 4 — Taper bonus** (up to −1.5% improvement). Fires when race is within taper window (`HYROX_TAPER_DAYS[band] ÷ 7`). Mirrors triathlon's `taperRatio × taperBonus` logic from `training-horizon.triathlon.ts:131`. Magnitude of 1.5% is conservative — running's taper bonus is per-band (Bompa & Haff 2009: 0.5–3% gain), and HYROX's mixed-modal nature (eccentric stations + aerobic running) suggests the lower end of that range.

**Confidence range** (`confidenceRangeSec: [low, high]`). Base ±4% widens with weeks-remaining (+1% past 4 weeks, +1% past 12 weeks — uncertainty grows with horizon) and with prediction confidence (low = +2%, medium = +1%). Tighter ranges for high-confidence near-term predictions; wider for low-calibration far-out projections.

**Known limitations**:
- Factor weights are heuristic, anchored on running/triathlon horizon-model parameters rather than HYROX-specific outcome data.
- The expected-CTL anchor assumes 70% of cap as a "trained athlete on band" benchmark — not directly observed from population data.
- No discipline-split CTL (we don't separately track run CTL vs station CTL) — would require extending `mtlHistory` similar to triathlon's `fitnessHistory.{swimCtl, bikeCtl, runCtl}`. Listed as a follow-up.
- Race-day fatigue interaction with venue factors not modelled separately — projection is applied to current total, then venue factors are already in that total via `predictHyroxRace`.

**Side**: tracking. Surfaced on the forecast view; not used for plan generation.

---

## §O — HYROX Prediction Confidence Model (2026-05-07)

**Model**: `confidence: 'high'|'medium'|'low'` computed in `predictHyroxRace` (`src/calculations/race-prediction.hyrox.ts`).

**Rules**:
- `high`: ≥6 calibrated stations AND venue selected. Rationale: most of the prediction is driven by measured data; the remaining 1–2 seed stations contribute <15% of station time; venue-specific course factors are applied.
- `medium`: ≥3 calibrated stations. More than half the station time is anchored; run pace may still be seed-derived.
- `low`: <3 calibrated stations. Prediction is largely driven by ability-band seed times derived from population averages. Suitable as a rough benchmark only.

**Known limitations**: confidence does not account for calibration recency (a 6-month-old benchmark may be outdated), for format-conversion bias (doubles→singles via the 0.92 factor introduces additional uncertainty), or for venue extrapolation accuracy.

**Side**: tracking (prediction, not planning).

---

## §N — HYROX Doubles→Singles Time Conversion Factor (2026-05-07) — SUPERSEDED by §T

> ⚠️ **Superseded 2026-05-08.** The 0.92 constant documented here was wrong-direction at the population level (singles is harder for the same athlete, not easier) and produced a chain of broken predictions for cross-format users. Replaced by bidirectional same-athlete factors `SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES = 1.22` / `SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES = 0.85`, used only for band derivation. Per-station cross-format inference is no longer attempted — the predictor falls back to target-format seeds with `confidence = 'low'`. See §T for the current model. This entry is preserved for historical context only.

**Model**: `DOUBLES_TO_SINGLES_FACTOR = 0.92` in `src/constants/hyrox-constants.ts`.

Applied when predicting a singles finish and the athlete only has doubles benchmarks: `estimatedSinglesSec = doublesSec × 0.92`.

**Rationale**: Doubles athletes alternate station completion with a partner. The waiting partner accumulates metabolic fatigue but the active athlete can push closer to maximal effort on each station. However, competitive pacing in doubles format differs from open singles — athletes often pace conservatively on shared stations to manage team strategy. Comparison of HYROX results data (HyroxDataLab, 2023–2025) for athletes competing in both formats at similar fitness levels shows singles per-station times averaging ~8% faster than their corresponding doubles times. The 0.92 factor encodes this gap. Applied only to seed-unfilled slots when cross-format estimation is needed; when both singles and doubles benchmarks exist, the matching slot is used directly.

**Inverse (singles→doubles)**: not converted — singles times represent unrestricted capacity and are used as a conservative ceiling for doubles prediction.

**Known limitations**: the 0.92 factor is a global average; individual variation is substantial (particularly for strength-biased vs. endurance-biased athletes). Pro division doubles may have a different ratio (smaller gap, due to higher competitive drive) but insufficient data to separate.

**Side**: tracking (prediction).

---

## Route Safety Rating — 300m Endpoint Trim (2026-05-07)

**Model**: `trimRouteEnds(points, trimMeters=300)` in `src/gps/anonymize-route.ts`

**What it does**: Strips the first and last ~300m of a GPS route before storing it in Supabase, so that the start and end points (which typically coincide with a runner's home, workplace, or car park) cannot be reverse-geocoded to an address.

**Why 300m**:
- A typical urban residential block is 80–150m (Gehl 2010, London street network median). A 300m strip clears 2+ full blocks in the worst case, taking the visible endpoint well into an anonymous mid-street or park segment.
- Google Street View accuracy is ~10m; 300m puts the nearest stored point outside the resolution window at which a casual observer could identify a house frontage.
- Long-distance runs are minimally affected: a 5km run retains ~88% of its route (9.4/10 km net after both ends trimmed). Shorter runs approaching 600m total are returned as null and not stored.

**Known limitations**:
- Cul-de-sac or dead-end routes may still reveal the endpoint even after trimming if the truncated polyline terminates near a unique street stub. Nothing in this model prevents that. Acceptable limitation for v1.
- The trim is cumulative-distance based (Haversine), not time-based. Slow walks at the start/end cover less physical distance per second, so the trim is always a spatial guarantee, not a temporal one.
- No simplification pass is applied — the full point density is retained inside the trim bounds. This is intentional: higher fidelity data for future aggregation. Storage cost is low (typical road run ~1,000 points after compression by Capacitor GPS provider).

**Files**: `src/gps/anonymize-route.ts`, `supabase/migrations/20260507000001_route_safety_ratings.sql`

### Companion Research Documents

For the full literature review, evidence synthesis, confidence levels, and bibliography behind the models documented here, see:

- **Running**: `docs/research/running.md` — load quantification, periodization, physiological adaptation, strength integration, cross-training transfer, tapering
- **Triathlon**: `docs/TRIATHLON.md` — per-discipline TSS, impulse-response model, concurrent training, bike-to-run transition science, taper protocols
- **HYROX**: `docs/research/hyrox.md` — three-dimensional load model (aerobic/anaerobic/MTL), station taxonomy, concurrent training, replacement matrix

This log documents **formulas and implementation**. The research docs document **why those formulas are defensible**.

---

## Empirical course-factor calibration from race-finish data (2026-05-07)

**Where**: `src/validation/{dataset-loader, course-factors, distribution, run-calibration}.ts`, `src/calculations/empirical-course-factors.ts`, `src/calculations/race-prediction.triathlon.ts` (course-factor source picker, ~line 530).

**The problem.** Hand-tuned course factors (climate × altitude × elevation × wind × swim type) capture the *physics* of why a course is hard but miss everything a finisher's split actually encodes — specific roads, prevailing winds at race time, exact bike-leg gradient profile, micro-climate, athlete acclimatisation effects. We had no calibration step against actual race outcomes.

**The fix (Tier B — what we built).** For each race location, compute multiplicative factors `(swim, bike, run)` from real splits. The factors are talent-controlled to remove the "fast races attract fast athletes" confound:

- **IM data** (~850k finishes after PRO + finisher filters, 2002 to 2024) has `athleteID`. Each athlete who appears at multiple races contributes their pace at race L relative to their own multi-race average. The location's factor is the mean of those athlete-relative ratios. Athletes with only one race contribute nothing (no within-athlete contrast available). The mean of the relative ratio across the global population is approximately 1.0 by construction; values > 1.0 mean "athletes raced slower at this location vs their personal average," i.e., a hard course.

- **70.3 data** (~840k finishes, 2004 to 2020) has no athlete ID. We stratify by `(gender, ageGroup)`: for each race, compute the mean leg time per `(M, 40-44)` bucket, divide by the global mean for that bucket, average those ratios across all buckets present at the race. Less precise than fixed effects but still talent-controlled.

**Mathematical defensibility.** Athlete fixed effects is the gold standard for removing unobserved heterogeneity in panel data (Wooldridge 2010). Stratification is the next-best thing when athlete identity isn't available; the bucket-level controls (gender, age band) capture the dominant talent-distribution differences across races.

**Sanity validation.** The math finds what the coaching community already knows:

- Top hardest IM bikes: World Championship St George (1.089), regular St George (1.082), Lanzarote (1.082), Lake Tahoe (1.077), Alaska (1.061) — the textbook hardest IMs in the world.
- Top hardest 70.3 bikes: Connecticut (1.244), Dun Laoghaire (1.209), UK (1.196), Edinburgh (1.172), Silverman (1.148) — all famously hilly.
- Top hardest 70.3 runs: Subic Bay (1.258), Goa (1.226), Davao (1.223), Saipan (1.210) — all tropical heat-killers.

These rankings emerge entirely from finishers' splits with no human input. Strong external validity for the methodology.

**Confidence tiering.** ≥ 1000 finishers → high; 200 to 999 → medium; 50 to 199 → low (drop); < 50 → insufficient (drop). Runtime predictor uses empirical when high/medium; falls back to physical (climate × altitude × elevation × wind × swim type) for low/missing/new races. Physical model is preserved as the safety net — it works for any race with a `CourseProfile` regardless of dataset coverage.

**Sanity caps.** Factors clamped to `[0.75, 1.40]`. Outliers usually represent data errors (course shortened due to weather, swim cancelled or shortened to non-wetsuit). Two clamped entries flagged: Ironman North Carolina (bike 0.750 — 2016 only, weather-shortened), Ironman Alaska (swim 0.750 — likely shortened or non-wetsuit).

**Tier A distribution table** is also built from the same datasets but separately. For each total-time bin (15-min for 70.3, 30-min for IM), it stores mean and SD of each leg's fraction of total time. The runtime helper `validateAgainstDistribution(prediction)` returns z-scores per leg, flagging any leg outside ±2 SD of the empirical mean for the prediction's total-time bin. Useful for catching predictions that are individually plausible but proportionally wrong (e.g., 2:30 swim in a 5:30 70.3 — too long even if 2:30 swim is plausible in isolation).

**What this DOES NOT calibrate.**
- The prediction's *level* — that's still set by physiology models (FTP, CSS, VDOT, blended fitness regressions vs published literature).
- The bike-to-run pace discount (5 to 11 percent). To calibrate this we'd need linked (open marathon, IM marathon split) pairs per athlete, which the public data doesn't provide.
- The race-readiness penalty curve. Same constraint — needs linked training-volume to outcome data.

**Limitations.**
- Empirical factors are time-averaged. A race held under unusually hot conditions in a specific year contributes that bad year's slowness to the lifetime mean. We don't currently weight by recency or weather.
- 70.3 stratification is less precise than IM fixed effects. A small race with unusual age-group mix can produce noisy factors even at "high confidence" sample sizes.
- Course changes mid-history (e.g., Ironman Frankfurt course revisions over 20 years) are averaged through. A future enhancement could use only data from years with stable course profiles.
- IM athlete-fixed-effects estimator drops athletes with only one race. About 30% of records get filtered this way, reducing effective sample from 1.93M raw to 1.33M.

**References**:
- Kaggle dataset, aiaiaidavid (2021) "Ironman 70.3 races 2004 to 2020". https://www.kaggle.com/datasets/aiaiaidavid/ironman-703-race-data-between-2004-and-2020
- Kaggle dataset, miguswong (2024) "Ironman 140.6 Results 2002 to 2024". https://www.kaggle.com/datasets/miguswong/ironman-140-6-results-dataset-2002-2024
- CoachCox IM Stats — original scrape source. https://www.coachcox.co.uk/imstats/
- Wooldridge JM (2010). *Econometric Analysis of Cross Section and Panel Data* 2nd ed. MIT Press.
- Friel J (2018). *The Triathlete's Training Bible* 4th ed. VeloPress.

---

## Race-readiness model upgrade: per-band targets, weighted score, sigmoid penalty, cross-discipline transfer, gap-aware closure (2026-05-07)

**Where**: `src/constants/race-readiness-targets.ts`, `src/calculations/specific-endurance-penalty.ts`, `src/calculations/race-readiness.ts`, `src/calculations/race-prediction.triathlon.ts`.

**The problem.** The original race-readiness model (2026-05-06) used a single intermediate-band target table, an unweighted geometric mean of `volumeRatio × longestRatio`, a linear `1 + (1 − score/100) × maxPenalty` curve, no cross-discipline transfer, and a fixed closure window. Five practical failure modes:

1. A beginner triathlete with the same weekly volume as an intermediate gets identical readiness scores — but they shouldn't (a beginner's *target* is lower).
2. Sprint and IM both weight volume and longest equally — but a sprint athlete doesn't need 4-hour rides, while an IM athlete does.
3. Linear penalty over-penalises athletes who are 80% ready and under-penalises athletes who are 30% ready.
4. A fit cyclist starting triathlon training gets zero credit for cycling's substantial cardiac transfer to running readiness.
5. A near-ready athlete is treated as needing the full closure window even though most of the gap is already closed.

**The five fixes (one pass).**

### 1. Per-band targets

Five Daniels bands (`beginner / novice / intermediate / advanced / elite`) instead of intermediate-only. Per-band volume multipliers `{0.55, 0.75, 1.00, 1.25, 1.45}` and longest multipliers `{0.70, 0.85, 1.00, 1.15, 1.25}`. Volume scales aggressively with band (Daniels VDOT plans show ~2.6× ratio elite-to-beginner weekly volume); longest-session scales less aggressively (race demands set the floor — even a beginner IM athlete must have done a 3-4hr ride). `getReadinessAbilityBand(state, discipline)` resolves per-discipline band: VDOT for run (Daniels), FTP for bike (Coggan tier approximation at ~70kg), CSS for swim.

**Defensible because**: Daniels (2014) publishes intermediate-vs-elite weekly volume ratios for marathon plans (~1.45× elite / 0.75× novice ≈ Friel's coaching consensus for triathlon). Per-discipline bands respect the empirical reality that a triathlete can be advanced on bike but novice on swim — concurrent training literature (Millet & Vleck 2000) confirms training-age and ceiling differ across modalities even within the same athlete.

### 2. Per-distance weighted geometric mean

Score `= volumeRatio^vW × longestRatio^lW × 100`. Weights:

| Distance | volume W | longest W | Rationale |
|---|---|---|---|
| Sprint | 0.70 | 0.30 | Race < 1.5h fits within glycolytic capacity — volume more important than long-session prep. |
| Olympic | 0.60 | 0.40 | Slight shift toward longest as race exceeds 2h. |
| 70.3 | 0.50 | 0.50 | Balanced — both weekly base AND specific peak prep matter equally. |
| Ironman | 0.40 | 0.60 | Longest-heavy — fractional utilization decay (Coyle 1984; Mujika & Padilla 2000) means race-distance-specific 4hr+ rides + 2hr+ runs are non-negotiable. |
| 5K / 10K | 0.70 / 0.60 | 0.30 / 0.40 | Mirrors Sprint/Olympic. |
| Half / Marathon | 0.50 / 0.40 | 0.50 / 0.60 | Mirrors 70.3/IM. |

**Defensible because**: Coyle's fractional-utilization decay literature shows endurance prep matters more as race duration increases. Friel (2018) coaching consensus is identical: short-course athletes can compensate for missing long sessions with more total volume; IM athletes cannot.

### 3. Sigmoid penalty curve

`penaltyShare = 1 / (1 + exp(k × (50 − score)))`, with `k = 0.08`. Anchor points at `k=0.08`:

| Score | penaltyShare | Interpretation |
|---|---|---|
| 90 | 0.04 | Near-ready: only 4% of maxPenalty applied |
| 70 | 0.17 | On track: small but real penalty |
| 50 | 0.50 | Building: half of maxPenalty (curve midpoint) |
| 30 | 0.83 | Underprepared: most of maxPenalty applied |
| 10 | 0.96 | Not ready |
| 0 | 0.98 | Asymptotic toward 1.0 |

**Defensible because**: training adaptation is non-linear (Banister-Calvert IRF, Mujika 2009 detraining curves). The "last 20%" of readiness costs more than the first 50% — an athlete who has done all the long work but missed two weeks of base volume is much closer to ready than the score-arithmetic suggests. Linear curves over-penalise the strong-but-incomplete athlete.

### 4. Cross-discipline transfer

`CROSS_DISCIPLINE_TRANSFER[from][to]` matrix:

|  | → swim | → bike | → run |
|---|---|---|---|
| **swim** | 1.00 | 0.10 | 0.10 |
| **bike** | 0.05 | 1.00 | 0.30 |
| **run** | 0.05 | 0.25 | 1.00 |

Two-pass: first compute raw readiness per discipline; then for each target discipline, set `volumeRatio = sum over all sources of (transferFactor × source's raw volumeRatio)`. Capped at 1.2 (matches base ratio cap).

**Defensible because**:
- **Bassett & Howley (2000)** — VO2max adaptations are ~70-85% central/cardiac, partially shared across endurance modalities. Sets the upper bound on transfer (full transfer impossible because peripheral adaptations remain mode-specific).
- **Tanaka (1995)** — meta-review of cross-training: ~50% of cycling-specific cardiac adaptations transfer to running; reverse direction less. Calibrates the bike→run = 0.30 weight.
- **Mutton et al. (1993)** — direct cycling-to-running transfer measurement: ~30-40% of cycling-induced VO2max gain showed up in running performance. Anchors bike→run.
- **Loy et al. (1995)** — cross-training maintenance during injury: 25-50% of endurance can be maintained via the alternate modality, supporting symmetric ~25-30% transfer between cycling and running.
- **Millet & Vleck (2000)** — concurrent training in triathlon: swim is technique-bound and arm/leg mechanical separation makes peripheral transfer minimal. Justifies 0.05-0.10 transfer ratios involving swim.

The asymmetry (bike→run > run→bike) reflects that running's high impact load and economy demand more peripheral specificity than cycling's smoother load.

### 5. Gap-aware closure window

`effectiveClosureWeeks = closureWeeks × sqrt(max(0, 1 − currentScore/100))`. Then `tau = effectiveClosureWeeks / 3`, `timeFactor = 1 − exp(−usefulWeeks / tau)`.

For Ironman with `closureWeeks = 12`:

| currentScore | effectiveClosureWeeks |
|---|---|
| 0 | 12.0 (full window — worst-case starting point) |
| 30 | 10.0 |
| 50 | 8.5 |
| 80 | 5.4 (45% of full) |
| 90 | 3.8 |

**Defensible because**: closure is non-linear in starting position. The first 50 points of readiness gain require base-building from scratch (months of progressive overload, Issurin 2008 block periodization); the last 20 points are sharpening of an existing platform (Bompa & Buzzichelli 2015). `sqrt(gapFraction)` captures this — gap of 0.2 needs only `sqrt(0.2) ≈ 0.45` of the full window. Without this scaling, the model claimed a near-ready athlete needed 12 more weeks of full-dose training to close a 10-point gap, which contradicts both literature and intuition.

**Combined effect on the canonical case** (Tristan, IM target, ~5 hrs/wk current bike, FTP 295W → bike band = advanced):

- Old model: bike score 35/100, linear penalty 1.10 (full maxPenalty 0.15 × 0.65 gap fraction)
- New model: bike score 52/100 (advanced-band target = 11.25 hrs vs 5 hrs actual; longestRatio more forgiving; cross-credit from run pulls volume up), sigmoid penalty 1.07 (50% of maxPenalty)

A reasonable softening: still penalised for low recent volume, but no longer arithmetically wrong about how prepared he is.

**Limitations**:
- Per-band multipliers (0.55-1.45×) are calibrated to running literature; bike/swim per-band targets are an extrapolation. Friel doesn't publish per-band tables for swim/bike — only intermediate. Confidence: medium for run, lower for swim/bike.
- Cross-discipline transfer factors are anchored to literature but assume equal recent training quality across disciplines. A user logging 10 hrs/wk of soft-pedalled commute cycling shouldn't get the same bike→run credit as a user logging 10 hrs/wk of structured cycling. v1 doesn't differentiate; future work could weight by intensity distribution (Seiler polarized model).
- The sigmoid `k=0.08` is a clean S-curve but isn't empirically calibrated against outcome data. It replaces a worse linear default; tuning against finish-time outcomes would be the next step.
- Gap-aware closure assumes physiological adaptation rate is constant and only the *gap* changes — true to first order but ignores that adaptations also slow at higher fitness levels (Issurin's "ceiling effect").

**References (full)**:
- Bassett DR, Howley ET (2000). Limiting factors for maximum oxygen uptake and determinants of endurance performance. *Med Sci Sports Exerc* 32(1):70-84.
- Bompa TO, Buzzichelli C (2015). *Periodization Training for Sports* 3rd ed. Human Kinetics.
- Coyle EF (1984). Substrate utilization during exercise in active people. *Am J Clin Nutr* 61(suppl):968S-979S.
- Daniels J (2014). *Daniels' Running Formula* 3rd ed. Human Kinetics.
- Friel J (2018). *The Triathlete's Training Bible* 4th ed. VeloPress.
- Issurin VB (2008). Block periodization vs traditional training theory: a review. *J Sports Med Phys Fitness* 48(1):65-75.
- Loy SF, Hoffmann JJ, Holland GJ (1995). Benefits and practical use of cross-training in sports. *Sports Med* 19(1):1-8.
- Millet GP, Vleck VE (2000). Physiological and biomechanical adaptations to the cycle-to-run transition in Olympic triathlon. *Br J Sports Med* 34(5):384-90.
- Mujika I, Padilla S (2000). Detraining: loss of training-induced physiological and performance adaptations. Part I. *Sports Med* 30(2):79-87.
- Mujika I (2009). *Tapering and Peaking for Optimal Performance*. Human Kinetics.
- Mutton DL, Loy SF, Rogers DM, Holland GJ, Vincent WJ, Heng M (1993). Effect of run vs combined cycle/run training on VO2max and running performance. *Med Sci Sports Exerc* 25(12):1393-7.
- Tanaka H (1995). Effects of cross-training: transfer of training effects on VO2max between cycling, running and swimming. *Sports Med* 17(5):330-9.

---

## Adhoc activity RPE: signal channel separation (2026-05-06)

**Where**: `src/ui/events.ts:967-982` (effortScore), `src/ui/activity-review.ts` (modal save handler), `src/calculations/fitness-model.ts:1632-1655` (recovery countdown fallback).

**The problem.** Three distinct adhesion-to-plan vs body-stress channels were tangled into one code path:
1. **Plan adherence** — "did the user execute the *prescribed* workout harder/easier than expected" → `effortScore` → drives next week's `effortMultiplier`.
2. **Physiological load** — "how much total stress is the athlete carrying" → TSS / iTRIMP / ACWR → drives recovery countdown, `actualTSS`, sleep debt.
3. **Subjective fatigue** — "how brutal did this feel" → user RPE rating.

Cross-training (Padel, climbing, strength) has no plan reference. The prior implementation summed adhoc deviations into `effortScore` with a fabricated `expected = 5`, so a cross-training rating polluted plan-adherence signal. Separately, no-HR cross-training read into the recovery countdown only as raw `durationSec / 60`, ignoring intensity entirely — a brutal 90-min Padel rated 9/10 with no HR stream contributed identically to a 90-min walk.

**The fix is signal separation, not signal blending.**

- **Plan adherence** (channel 1): iterate planned workouts only; require explicit `expected = wo.rpe ?? wo.r` (no fallback). Adhocs are excluded by construction. Mirrors `effort-multiplier.triathlon.ts:54-58` which was already correct in tri mode.
- **Physiological load** (channel 2): for HR-tracked activities (most users with watches), `iTrimp` from Garmin/Strava remains canonical — RPE rating is informational only. For no-HR activities, the rated RPE writes back into `workout.rpe`/`workout.r` and recomputes `aerobic`/`anaerobic` via `calculateWorkoutLoad`. Both paths converge on the same downstream consumers (Signal A/B at `fitness-model.ts:1149` already reads `w.rpe ?? w.r`; recovery countdown now mirrors that pattern at line 1637; tri overload at `tri-cross-training-overload.ts:316` reads `w.aerobic + anaerobic`). One number, one source.
- **Subjective fatigue** (channel 3): every activity gets an RPE prompt now — runs, gym, cross-training. Stored in `wk.rated[id]` and displayed on the activity card.

**Why HR-canonical for HR users.** Coggan & Allen 2019 (cycling) and Borg 1982 (perceived exertion) both establish that for steady-state effort, HR-derived load is more reliable than self-rated RPE — RPE conflates psychological state, environmental conditions, and recent food intake with intensity. For intermittent activities (stop-start sports, strength) HR misses CNS load and RPE is *more* reliable — but those activities also tend to lack reliable HR streams (no chest strap, drift on optical sensors during grip work). So the heuristic "trust HR if present, RPE if not" tracks the underlying signal quality.

**Why we don't blend** (e.g., `0.6 × HR_load + 0.4 × RPE_load`). RPE has high inter-day variance and habituation effects (athletes who "always rate 7" inflate, athletes who "tough it out at 4" understate). Letting RPE shift HR-derived load would introduce noise into ACWR — a metric that needs week-to-week stability for its `1.3 / 1.5` thresholds to be meaningful. The blend would help no one and hurt the disciplined HR users who are the majority.

**Limitations.**
1. **Rating bias.** Athletes who systematically rate high will see inflated load (and consequently softer next-week plans) when they have no HR data. We have no calibration mechanism yet.
2. **Mid-rating switching.** If a user added a watch mid-history, old no-HR weeks have RPE-derived load and new weeks have HR-derived; CTL ramp through that boundary may show a small visible step. Not corrected.
3. **`TL_PER_MIN` table.** The recovery-countdown fallback uses `TL_PER_MIN[rpe]` which is calibrated against running. Cross-training RPE → `TL_PER_MIN` mapping is approximate; a strength session at RPE 8 produces different physiological strain than a 10K run at RPE 8.

**Tests.** 1480/1480 passing. No existing tests guarded the prior `|| 5` fallback or the run-only push gate, so no expectations needed updating.

---

## Specific endurance penalty + race-readiness surface (2026-05-06)

**Where**: `src/calculations/specific-endurance-penalty.ts` (per-discipline math), `src/calculations/race-readiness.ts` (tri-shaped aggregator), `src/constants/race-readiness-targets.ts` (Friel volume tables). Applied in `predictTriathlonRace` to the `current` ("today") prediction only.

**Problem.** The triathlon prediction engine treats fitness markers (FTP, CSS, VDOT) as standalone capability — assumes the athlete can sustain those for the full race distance. That's true for *physiological capacity* but false for *endurance preparation*. An IM is 8-12 hours of work; without specific volume the athlete will:
- Blow up on the bike (no muscular endurance for 6+ hours at IM-pace power)
- Walk the marathon (no glycogen storage / heat tolerance / running economy for 42km off the bike)
- Struggle on the swim (no open-water 3.8km familiarity)

Markers are necessary but not sufficient. Diagnostic case: 3:09 marathon-PB + FTP 295W + CSS 2:22 athlete predicted as 12:32 IM "today" — but volume is low and athlete correctly intuited they couldn't actually do that.

**Mechanism.** Two signals per discipline:

1. **Recent weekly volume** — endurance reservoir (sustained training base over 8 weeks)
   - Run: km/wk from `prediction-inputs.ts:weeklyKm`
   - Bike/swim: hours/wk from `tri-volume-by-discipline.ts:recentHoursByDiscipline`

2. **Longest single session** — specific peak preparation, also serves as recency proxy via 12-week window (any session counted is ≤ 84 days old)
   - All three disciplines: from `tri-volume-by-discipline.ts:longestSessionByDiscipline`

**Combined via geometric mean** to produce a 0-100 readiness score:

```
volumeRatio  = clamp(actual_weekly_volume / required_weekly_volume, 0, 1.2)
longestRatio = clamp(longest_session_hours / required_longest_hours, 0, 1.2)
score        = sqrt(volumeRatio × longestRatio) × 100   (capped at 100)

penaltyMultiplier = 1 + (1 - score/100) × MAX_PENALTY_BY_DISTANCE
```

**Why geometric mean.** Both signals are genuinely required per Friel coaching consensus. No amount of long sessions makes up for missing weekly volume; no amount of weekly volume substitutes for race-distance-specific peaks. Multiplicative combination correctly punishes asymmetric weakness — an athlete with 100% volume but 0% peak prep correctly scores 0, not the 50 an arithmetic mean would give. Athletes with balanced shortfall (e.g., 80% volume + 80% peak) score 80, matching the empirical "balanced gap" intuition.

**Why scale penalty by distance.** Sprint barely volume-sensitive (race fits within glycolytic capacity); IM massively so (fractional utilization decays per Coyle 1984 + Mujika 2000):

| Distance | MAX_PENALTY_BY_DISTANCE | Rationale |
|---|---|---|
| Sprint | 0.03 | ~1 hour race; aerobic limits matter less than peak power |
| Olympic | 0.05 | ~2-3 hours; moderate volume sensitivity |
| 70.3 | 0.10 | ~5-6 hours; volume meaningfully shapes outcome |
| IM | 0.15 | 8-12 hours; volume is the dominant predictor |

**PB-recency factor (run discipline only).** Race PBs validate full-distance capability beyond what training data alone shows. Reduces the penalty's *excess* (the part above 1.0) by a recency factor:

| PB age | Recency factor |
|---|---|
| < 365 days | 0.5 (recent PB demonstrates current capability) |
| 365-730 days | 0.75 (partial demonstration) |
| > 730 days OR no PB | 1.0 (full penalty) |

Bike/swim don't have an equivalent PB framework today — their 12-week longest-session window provides the recency signal naturally. Could extend to bike/swim races later (e.g., recent IM completion → reduce IM-bike penalty for IM target) but adds complexity; deferred to v2.

**Volume targets** (calibrated to Friel 2018 *Triathlete's Training Bible* 4th ed., intermediate-band):

| Distance | Swim hrs/wk | Bike hrs/wk | Run km/wk | Long swim h | Long ride h | Long run h |
|---|---|---|---|---|---|---|
| Sprint | 1.0 | 2.0 | 17.5 | 0.5 | 1.5 | 1.0 |
| Olympic | 1.5 | 3.5 | 30 | 0.65 | 2.5 | 1.5 |
| 70.3 | 2.0 | 5.5 | 42 | 0.85 | 3.0 | 1.75 |
| IM | 3.0 | 9.0 | 60 | 1.2 | 4.5 | 2.5 |

**Application — penalty applies to `current` only.** The triathlon prediction computes both:
- `projected` (race-day, with plan execution) — uses plan-prescribed dose, full readiness by definition
- `current` (today, with actual training) — gets the per-discipline penalty applied to each leg

This is the right architectural separation. The plan ramps volume; by race day the athlete will meet targets; readiness scores will climb to 90+ as training progresses; live "today" prediction updates upward each week. The improvement narrative gets bigger: honest baseline (today reflects actual prep) + same projection = bigger improvement gap. Coaching narrative goes from "10 minutes faster after 24 weeks" to "1+ hour faster" for low-volume athletes.

**Limitations.**

- Penalty fires once per discipline regardless of *how* it's applied. A user might be fully prepared for the bike but under-prepared for the swim — currently the bike leg time isn't penalised in that case (correct), but a holistic "you might struggle on race day" warning isn't surfaced beyond the per-discipline score.
- Doesn't model cross-training transfer. A cyclist starting tri training has bike fitness that partially transfers to swim/run aerobic base; the current model doesn't credit this.
- Bands are step-function on age (PB recency) and on distance (penalty cap). Smoother (continuous) functions would be more elegant but the discontinuities are at sensible boundaries (1y/2y for PB; race distance is already discrete).
- Marathon-specificity (running-side penalty in `predictions.ts`) is NOT migrated to use the unified framework. Different conceptual basis (Coyle 1984 detraining-decay vs Friel 2018 training-volume target). Documented as parallel implementation. Future merge would require choosing which conceptual basis wins — out of scope.

**Confidence.** High for the mechanism (Friel + Skinner are gold-standard tri references; the marathon-specificity precedent worked). Medium-high for the volume target calibration — Friel's tables are intermediate-band averages, real users span a wider range of training quality. Medium for the `MAX_PENALTY_BY_DISTANCE` bands — chosen pragmatically to land predictions within ±5% of empirical reality for cross-trained returning triathletes; not derived from a single calibrated dataset.

**Sources**: Friel J (2018) *The Triathlete's Training Bible* 4th ed., VeloPress (Tables 7.1, 8.x); Coyle EF (1984) "Time course of loss of adaptations after stopping prolonged intense endurance training" *J Appl Physiol* 57:1857-1864; Mujika I & Padilla S (2000) "Detraining: loss of training-induced physiological and performance adaptations" *Sports Med* 30:79-87; Joyner MJ & Coyle EF (2008) "Endurance exercise performance: the physiology of champions" *J Physiol* 586:35-44; Skinner JS, Strudwick coaching observations on IM endurance-volume correlation.

---

## Triathlon short-plan phase compression (2026-05-06)

**Where**: `phasesForLen(distance, totalWeeks)` in `src/constants/triathlon-constants.ts`, consumed by `phaseForWeek` in `src/workouts/plan_engine.triathlon.ts`.

**Problem.** `PHASE_WEEKS` defines canonical phase lengths for the default plan (Ironman 10/7/5 + 2 taper = 24 weeks; 70.3 8/6/4 + 2 taper = 20 weeks). When the user picked a race date with less runway, `phaseForWeek` still tested `weekIndex ≤ base` against the canonical base length, so a 6-week Ironman plan put the athlete in *base phase* for all 6 weeks — no race-specific work and no taper.

**Compression rule.** When `totalWeeks` falls below the canonical sum, allocate weeks in priority order **taper > peak > build > base**:

1. **Taper** = `clamp(ceil(totalWeeks × 0.10), 1, 2)` weeks. The floor of 1 week is non-negotiable — race week itself functions as a taper. The ceiling of 2 weeks reflects the canonical taper window: meta-analyses show fitness gains plateau between 7–14 days of reduced volume and detraining starts to bite beyond two weeks (Mujika & Padilla 2003 review of 27 taper studies; Bosquet, Montpetit, Arvisais & Mujika 2007 meta-analysis of 50 studies).

2. **Peak** = `max(1, round(remaining × peakRatio))` where `peakRatio = canonicalPeak / (canonicalBase + canonicalBuild + canonicalPeak)`. Race-specific high-intensity work is the last phase to drop because it produces the largest fitness gains in the final mesocycle (Issurin 2010 block periodization).

3. **Build** = `max(0, round(remaining × buildRatio))`. Allowed to compress to zero on very short plans because lactate-threshold work, while valuable, is in the same energetic family as race-specific peak work — the peak phase covers most of build's role under compression.

4. **Base** = `remaining − peak − build` (non-negative, takes the rounding residual). Base is sacrificed first because an athlete signing up for a race typically already has aerobic foundation; the race-prep window is the bottleneck.

**Resulting phase splits for Ironman**:

| Total | Base | Build | Peak | Taper |
|-------|------|-------|------|-------|
| 24 (default) | 10 | 7 | 5 | 2 |
| 12    | 5    | 3     | 2    | 2     |
| 8     | 3    | 2     | 2    | 1     |
| 6     | 2    | 2     | 1    | 1     |
| 4     | 1    | 1     | 1    | 1     |
| 2     | 0    | 0     | 1    | 1     |
| 1     | 0    | 0     | 0    | 1     |

**Defensibility.** Three principles are doing the work:

- **Athletes self-select for the runway they bring.** A user picking a 6-week IM is implicitly declaring they have the aerobic base already; it's the time-to-race that is short, not the foundation. Compressing base before peak respects what the user is actually telling us.
- **Taper effects are sharp.** 14-day taper reduces volume 41–60% and produces 0.5–6.0% performance improvement in trained endurance athletes (Mujika & Padilla 2003). The 1-week floor preserves part of this effect even on extreme short plans; the 2-week cap prevents the taper from spilling into useful training time.
- **Peak floor at 1.** Race-specific work transfers more directly to race performance than any other phase. A plan with non-zero training weeks but zero peak weeks is a worse plan than the same total weeks with at least one peak week.

**Limitations.**
- Compression preserves the *shape* of a periodised plan but cannot reproduce the *physiological adaptations* of a longer plan. A 4-week Ironman plan has the right phase ordering, but the absolute fitness level achievable in 4 weeks is a fraction of what 24 weeks delivers.
- The peak-floor-at-1 rule means a 1-week plan is pure taper (race week only); a 2-week plan gets 1 peak + 1 taper. There is no "warm-up" phase below 2 weeks; this is intentional but unusual.
- We do not currently surface a "this plan is below the recommended runway" warning to the user. Adding one (e.g. < 8 weeks for IM, < 6 weeks for 70.3) is a worthwhile follow-up.

**Citations.**
- Mujika, I., & Padilla, S. (2003). Scientific bases for precompetition tapering strategies. *Medicine & Science in Sports & Exercise*, 35(7), 1182–1187.
- Bosquet, L., Montpetit, J., Arvisais, D., & Mujika, I. (2007). Effects of tapering on performance: a meta-analysis. *Medicine & Science in Sports & Exercise*, 39(8), 1358–1365.
- Issurin, V. B. (2010). New horizons for the methodology and physiology of training periodization. *Sports Medicine*, 40(3), 189–206.

---

## Run by Feel — unstructured run as a discrete workout type (2026-05-06)

**Where**: `src/types/training.ts` (`'vibes'` in WorkoutType — internal type identifier; user-facing name is "Run by Feel"), `src/workouts/intent_to_workout.ts` (`'vibes'` in SlotType), `src/ui/session-generator.ts` (renderVibes + openVibesScienceModal), `src/ui/plan-view.ts` (buildVibesRunNudgeCard, build-phase only), `src/ui/triathlon/plan-view.ts` (mirrored card + Add session button).

**What it is.** A user-selectable workout type with a fixed two-step spec: (1) Run 5km at easy pace, put on good music, take photos of cool things, enjoy. (2) If at 5km you want to stop, stop. Otherwise keep running. Always additive (never replaces a planned workout). Available in the ad-hoc session generator across all modes that have a run leg (excluded from cycling, which is not a standalone mode).

**Product POV.** Mosaic plans get prescriptive on purpose, but listening to your body is part of pacing too, and it's a skill that prescriptive plans can blunt. Run by Feel is a session for practising it.

**Why it's defensible.** Five converging lines of evidence:

1. **Fartlek (Holmér, 1937).** "Speed play" in Swedish. The original unstructured-pace method. Eight decades of evidence (including modern controlled studies on self-paced running) show that self-selected intensity produces strong physiological adaptation, often comparable to prescribed intervals at matched RPE. The runner integrates terrain, fatigue, and motivation in real time, which is plausibly closer to optimal than any external prescription.

2. **Central governor model (Noakes, 2001; Tucker & Noakes, 2009).** The brain regulates effort by holding back muscular reserves anticipated for "the planned effort". When the prescribed effort is removed, the cognitive frame shifts and the safety margin can be partially released. Field observations of pacing strategies (and Tristan's own half marathon PB on a no-watch Run by Feel, the founder anecdote we surface in the UI) fit this model directly.

3. **Flow state (Csikszentmihalyi, 1990; Jackson, 1996).** Removing the cognitive load of pace-monitoring lowers sympathetic arousal. Lower sympathetic activation improves running economy (Kayser, 2003), meaning cheaper oxygen cost at the same pace. This is mechanism, not just vibes (sorry).

4. **Persistence hunting and Born to Run (McDougall, 2009; Lieberman & Bramble, 2004).** Humans evolved as endurance runners over evolutionary timescales. The Lieberman/Bramble persistence-hunting argument supplies the deeper "why": running is a behaviour we're built for, and self-paced running engages that adaptation more naturally than metronomic interval work.

5. **Self-determination theory (Deci & Ryan, 1985; Teixeira et al., 2012 in exercise contexts).** Autonomy-supportive sessions improve adherence and effort tolerance over a full training cycle. A coach-prescribed "be unstructured" is a contradiction in terms; the autonomy element is load-bearing, which is why we surface this as a *discoverable* feature (nudge once per build phase, then user-elected) rather than auto-scheduling it.

**Why build phase specifically (not base).** Base phase is already low-stress and high-volume; psychological load is low. Build phase is where structural fatigue is highest, prescription is tightest, and the psychological release valve has the most marginal value (Kellmann's recovery-stress framework). Surfacing the nudge in build, once per phase per plan, maximises both feature discovery and physiological/psychological benefit.

**Load model.** No special handling. TSS is computed retroactively from the actual when Strava/Garmin lands, identical to any other activity. As an extra session on top of planned mileage, weekly TSS will go above plan target. That's the correct behaviour (user-elected extra load, not a plan-engine prescription).

**Limitations / honesty.**
- The "PB on a Run by Feel" effect is well-documented anecdotally but the controlled-study evidence is thinner. We surface it as one of five converging arguments, not the central claim.
- The 5km minimum is a defensible floor (covers the ~15–20 min flow-state onset window from Csikszentmihalyi/Jackson) but isn't individually calibrated. For very new runners 5km may itself be the workout; for elite athletes it's trivial. We accept this as a feature, not a bug; the threshold is the *commitment* point.
- We do not currently track Run by Feel sessions as a distinct activity class in the load model. They land as whatever Strava/Garmin classifies them (typically `Run`), which is correct for load accounting but means we can't analyse "how Run by Feel sessions compare to planned runs" without manual labelling. Possible follow-up if the feature gets used.

**Citations.**
- Holmér, G. (1937). Träna effektivare. (original fartlek formulation, Swedish.)
- Noakes, T. D. (2001). *Lore of Running* (4th ed.). Human Kinetics.
- Tucker, R., & Noakes, T. D. (2009). The physiological regulation of pacing strategy during exercise: a critical review. *British Journal of Sports Medicine*, 43(6).
- Csikszentmihalyi, M. (1990). *Flow: The Psychology of Optimal Experience*. Harper & Row.
- Jackson, S. A. (1996). Toward a conceptual understanding of the flow experience in elite athletes. *Research Quarterly for Exercise and Sport*, 67(1).
- Kayser, B. (2003). Exercise starts and ends in the brain. *European Journal of Applied Physiology*, 90(3-4).
- McDougall, C. (2009). *Born to Run*. Knopf.
- Lieberman, D. E., & Bramble, D. M. (2004). Endurance running and the evolution of Homo. *Nature*, 432.
- Deci, E. L., & Ryan, R. M. (1985). *Intrinsic Motivation and Self-Determination in Human Behavior*. Plenum.
- Teixeira, P. J., et al. (2012). Exercise, physical activity, and self-determination theory: a systematic review. *International Journal of Behavioral Nutrition and Physical Activity*, 9.
- Kellmann, M. (2010). Preventing overtraining in athletes in high-intensity sports and stress/recovery monitoring. *Scandinavian Journal of Medicine & Science in Sports*, 20(s2).

---

## Horizon ceiling recalibration: structured-plan calibration across modes (2026-05-06)

**Where**: `src/constants/training-params.ts` (running), `src/constants/triathlon-horizon-params.ts` (swim/bike/tri-run), `src/calculations/training-horizon.ts` and `src/calculations/training-horizon.triathlon.ts` (EXP_FACTORS, k_sessions defaults).

**Problem.** The horizon model's `max_gain_pct × week_factor × session_factor × type_modifier × exp_factor + taper_bonus − undertrain_penalty` formula multiplies several attenuating factors together. With ceilings calibrated to flat-volume "typical season" averages, the multiplicative compounding produced predictions that systematically under-stated what athletes following structured periodised plans empirically achieve.

For the diagnostic case — 3-session/wk marathon plan, 44 weeks, returning intermediate athlete, recent marathon PB — the model projected ~5 min improvement. Pfitzinger 18-week intermediate plans empirically deliver 7-11 min improvement over the *shorter* horizon for similar starting points. The 44-week version of that periodisation should deliver more, not less.

**Recalibration philosophy.** Mosaic generates structured periodised plans (long runs, threshold/intervals, build/peak/taper). The horizon ceilings should reflect outcomes at that level of structure, not the cross-quality "typical season" averages most coaching references publish:

- **Pfitzinger 2009** *Advanced Marathoning*: intermediate-plan empirical outcomes 5-7% per cycle for marathon
- **Daniels 2014** *Daniels' Running Formula*: Q-plan VDOT improvements 6-8% per cycle for half/10K/5K at intermediate level
- **Coggan 2019** *Training and Racing with a Power Meter* Ch.7: structured-plan intermediate cyclists see 8-12% FTP/season (the published "typical season" 6% is the cross-quality average; engaged-athlete band is 8-12)
- **Costa 2010** sub-elite age-group swim data: 3% CSS/season for *technique-acquired* athletes; **Maglischo 2003** + **Toussaint & Hollander 1994** show beginners learning proper stroke see 10-15% CSS/season from technique alone
- **Mujika & Padilla 2003** + **Coyle 1985** detraining/retraining studies: returning athletes regain capacity 1.5-2× faster than novices reach it (satellite cell pools, capillary density, mitochondrial enzyme persistence)

**Specific changes.**

```
TRAINING_HORIZON_PARAMS.max_gain_pct (running):
  marathon intermediate: 5.5 → 7.0   advanced: 4.5 → 5.5
  half intermediate:     8.0 → 8.5   advanced: 6.0 → 6.5
  10K intermediate:      7.0 → 7.5   advanced: 5.0 → 5.5
  5K intermediate:       6.0 → 6.5   advanced: 4.0 → 4.5
  beginner / novice / elite: minor proportional bumps where data supports

SWIM_HORIZON_PARAMS.max_gain_pct (triathlon swim):
  beginner: 6.0 → 9.0    novice: 4.5 → 6.5
  intermediate / advanced / elite: unchanged (Costa/Pyne calibration holds)

BIKE_HORIZON_PARAMS.max_gain_pct (triathlon bike):
  intermediate: 6.0 → 8.0   advanced: 3.5 → 4.5

RUN_HORIZON_PARAMS_703 / RUN_HORIZON_PARAMS_IM (triathlon run):
  Mirror running half / marathon respectively — kept in lockstep

EXP_FACTORS.returning (both running and triathlon):
  1.15 → 1.35 (Mujika & Padilla 2003, Coyle 1985 retraining advantage)

k_sessions / TRI_K_SESSIONS (logistic steepness):
  1.0 → 0.7 (flatter response — better matches Pfitzinger 4-session vs
  5-session empirical outcomes ~70% ratio, not the 21% k=1.0 produced)
```

**Why each change is defensible.**

- **max_gain_pct bumps**: each new value lies within the published-data range for athletes following structured plans. The previous values were at the lower bound of those ranges; new values are at the upper-mid bound. Conservative interpretation: still honest, less under-promising.
- **`returning` 1.15 → 1.35**: Mujika & Padilla (2003) review shows returning trained athletes recover 60-80% of peak capacity within first 4-6 weeks of resumed training, vs novice rate of 30-40%. The 1.35 ratio (35% boost over `intermediate`) approximates this 1.5-2× re-adaptation rate observed empirically.
- **`k_sessions` 1.0 → 0.7**: At ref_sessions = 5.5 (marathon intermediate), the k=1.0 curve makes 4-session plans worth 27% of the max gain a 5-session plan would deliver. Empirically (Pfitzinger 4-session vs 5-session 18-week plans) the ratio is ~70%. k=0.7 produces ~50% — still penalises lower frequency but proportionally to what published data shows.

**Effect on diagnostic case** (3-session marathon, 44w, returning intermediate, recent PB):
- Pre-recalibration: improvement_pct ≈ 2.3% → ~5 min
- Post-recalibration: improvement_pct ≈ 4-5% → ~10-12 min

Combined with marathon-specificity penalty (still firing at recency-scaled magnitude): honest baseline + meaningful gain, matching Pfitzinger empirical outcomes for engaged athletes following structured plans.

**Hyrox skipped** — separate prediction architecture in `race-prediction.hyrox.ts`. Will recalibrate in a dedicated pass with appropriate Hyrox-specific empirical data.

**Limitations.**

- Bands still don't differentiate between *plan adherence levels*. A user who follows the plan loosely will see less gain than the model predicts; a meticulous athlete may exceed it. The model assumes ~80% adherence (typical of Pfitzinger / Daniels published outcomes).
- Bumping ceilings affects ALL users of those bands — a pure-Daniels-VDOT user with no structured plan would still see the new (higher) prediction, even though they're not following structured periodisation. Acceptable trade-off because Mosaic always generates periodised plans; users not following our plans aren't in scope.
- The cross-discipline transfer (bike fitness contributing to run gain in concurrent training) isn't modelled here — each discipline's horizon is computed independently. Real triathletes get some compound benefit from concurrent training; the current model under-states this.
- ~~Doesn't capture *engagement decay*~~ — **addressed 2026-05-06**: swim engagement penalty now inflates the projected CSS baseline by up to 12.5% when weeksActive=0, anchored to `CSS_DETRAINING_PER_4WK`. See "Swim Engagement Penalty — Projected CSS Baseline" entry.

**Confidence**: high for running (Pfitzinger / Daniels are gold-standard published references), high for bike (Coggan equivalent for cycling), medium-high for swim beginner band (Maglischo is canonical but published swim-progression data is thinner than running). `returning` factor and `k_sessions` softening are well-grounded in retraining and dose-response literature respectively.

---

## Per-rep interval analysis (2026-05-06)

**Where**: `src/calculations/rep-detection.ts` (detection), `src/calculations/rep-adherence.ts` (scoring), inline copies in `supabase/functions/sync-strava-activities/index.ts` (server-side detection during sync).

**Problem.** Whole-session averages dilute the signal of a structured interval session. A 5×5min @ FTP ride averaged across warmup + reps + cooldown reads as IF ~0.7 even when every rep was on target; an 8×400m track session averaged across the whole hour reads as easy because warmup + recoveries dominate the duration. The plan engine reads those whole-session averages and concludes the athlete didn't hit the prescribed intensity, when in fact they nailed every rep.

**Two-stage approach**:

### Stage 1 — Detection

**Lap-based (primary for run, fallback for bike).** Strava `/laps` returns one entry per user-pressed lap or auto-generated split. Algorithm:

1. Filter laps with `durationSec ≥ 15s` and `distanceM > 0` (drops accidental beeps).
2. Reject **uniform auto-lap**: if `CoV(distanceM) < 0.08`, every lap is essentially the same length — the hallmark of a bike computer auto-lapping every km/mile. Real interval sets have warmup + cooldown + rest laps of different lengths (CoV typically > 0.15). Threshold 0.08 chosen empirically — comfortably above noise floor of identical-length laps, comfortably below user-pressed structure.
3. Compute pace per lap. Sort by pace ascending.
4. Find the **largest gap** in the sorted-pace sequence. If the gap exceeds `1.0 × σ` of the lap-pace distribution (σ-normalised so the threshold is invariant to absolute pace), the laps before the gap are reps; the rest are warmup/cooldown/recovery.
5. Re-sort the rep set into chronological order by `lap_index`.

The σ-gap test is the load-bearing heuristic. It separates "laps that share the rep-effort cluster" from "laps that don't." 1.0σ ≈ a 16-percentile separation — generous enough to catch genuine interval structure (where reps are typically 30-60% faster than recoveries), strict enough to reject easy runs that happened to contain a single fast km.

**Stream-based (fallback for run, primary for bike)**:

- *Run pace stream*: 30s rolling pace; baseline = median of moving samples; threshold = `baseline - 30 sec/km`. Reps = contiguous segments below threshold for ≥30s. The `-30 sec/km` offset (versus a percentage) is calibrated so easy-run pace variability (~5-15 sec/km) doesn't hallucinate reps; track session reps are typically 60-120 sec/km faster than the user's easy pace.
- *Bike power stream*: 10s rolling watts; baseline = median; threshold = `max(baseline + 50W, baseline × 1.4)`. The dual condition handles both low-baseline athletes (where +50W is a meaningful step) and high-baseline athletes (where 40% over baseline is the better cutoff). Reps = contiguous segments above threshold for ≥30s. Power has near-zero physiological lag and step changes are sharp at transitions, making it a much cleaner rep signal than HR or pace for cycling.

**Sport routing** (top-level `detectReps`):
- *Run*: laps first → stream fallback. Most lap-aware watches (Garmin, Coros, Apple) auto-detect track laps; users on basic devices don't get rep markers, so streams are needed.
- *Bike*: power stream first → laps fallback. Bike computers (Wahoo, Garmin Edge) commonly default to auto-1km laps regardless of what the rider did, so trusting laps would hallucinate reps. Power stream is more reliable when present.

**Limits**:
- `MIN_REPS = 3`, `MAX_REPS = 40`. <3 reps isn't a meaningful "set"; >40 is usually noise from a bike computer auto-lapping every 10s during a track session.
- Detection is **conservative by design** — the cost of "no rep table" on a real interval session is low (the user still sees km splits, HR zones, pace), but the cost of false-positive reps on an easy run is high (misleading commentary, polluted effort multiplier).

### Stage 2 — Adherence scoring

**Prescription parsing.** Regex extracts the rep pattern (`8×400m`, `5×5min`, `10×1km`) from the workout description. Distance and duration units handled (m, km, mi, s, sec, min). Used for transparency in the UI ("Prescribed: 8×400m"); scoring works without it.

**Target resolution**:
- *Run*: `gp(vdot, ltPace)` returns the canonical pace zones; `getPaceForZone(workoutType, paces)` picks the right one (interval, threshold, etc.). Returns null for non-interval types so easy runs don't get scored as reps.
- *Bike*: `BIKE_TARGET_IF[workoutType] × FTP`. Reuses the same intensity-factor table as `tri-effort-scoring.ts` (Coggan & Allen 2019 anchors) for consistency between session-level and rep-level scoring.

**Per-rep adherence**:
- Run: `paceSecKm / targetPaceSecKm`. Lower sec/km = faster, so adherence > 1.0 = slower than target (under-cooked). Band: ±5% (≈9 sec/km on a 3:00/km interval).
- Bike: `avgWatts / targetWatts`. Higher watts = stronger, so adherence > 1.0 = above target. Band: per-session-type from `BIKE_ADHERENCE_BAND`.

**Aggregate**:
- `inBand`: count of reps inside the per-rep band.
- `fadePct`: `(last_half_mean - first_half_mean) / first_half_mean × 100`. For run pace (where higher = slower), positive = fade. For bike watts (where higher = stronger), the sign is flipped so positive always means "got worse over the set" — keeps commentary thresholds (≥3% noticeable, ≥6% significant) directionally consistent across disciplines.
- `avgAdherence`: mean of per-rep adherences. Feeds the effort-multiplier integration: `repAdherenceToEffortDev = (avgAdherence - 1.0) × 10`, mapping 10% off-target to 1 RPE point — same scale as `hrEffortScore` and `powerAdherence` use for the existing 60/40 RPE/objective blend.

**Effort-multiplier integration**:
- *Bike* (`effort-multiplier.triathlon.ts:triTrailingEffortScore`): rep-level adherence wins over whole-session `powerAdherence` when reps are scorable (≥60% of detected reps had a parseable target). Falls back to `powerAdherence` → `hrEffortScore` → pure RPE.
- *Run* (`events.ts`): rep-level deviation replaces the HR-effort signal in the 60/40 RPE/objective blend when present. The HR-effort signal is still tracked for `wk.hrEffort` summary (used by coach view).

**Why this is defensible**:
1. **Lap-based detection mirrors what coaches do.** A coach reviewing a Strava workout looks at the lap table and visually clusters fast vs slow laps. The σ-gap heuristic encodes that: the largest separation in the pace distribution is where "reps" end and "everything else" begins.
2. **Power-stream detection is the standard cycling analysis primitive.** Coggan & Allen (Training and Racing with a Power Meter, 3rd ed.) describe identifying intervals via power-step analysis; the rolling-window + threshold approach used here is the textbook method.
3. **Per-rep scoring resolves a known dilution problem.** Comparing whole-session NP / IF to a workout target is fine for steady-state efforts (Sweet Spot, FTP test) but breaks for interval sessions where warmup + recovery dominate the duration. Rep-level scoring is the discipline's accepted answer; this implementation just brings it into our adaptation loop.

**Known limitations**:
- The σ-gap detector misses **fartlek and progression sessions** where there's no clean fast/slow bimodal structure. Acceptable — those aren't rep sessions in the traditional sense.
- The detector misses **structure changes within a session** (e.g. "5×3min then 5×1min"). Returns the union of fast laps as one rep set. Future work: cluster within the rep set by pace/distance to surface "rep type 1" / "rep type 2" sub-tables.
- The bike-stream detector smooths over **30/30s on/off micros** because the 10s smoothing window blurs transitions. Slow-pace 30s reps register; sharp transitions don't. Future work: shorten the smoothing window when an interval-typed prescription is detected.
- **No swim support** in v1. Pool swim sessions don't have continuous distance/time streams the same way; lap structure exists but is harder to interpret without sport-specific heuristics.
- **Backfill is NOT re-run.** Detection only fires for new activities going forward through the standalone path; historical activities will pick up `repData` if they're re-synced (e.g. user manually triggers a backfill or the activity gets re-processed).

---

## PB-recency scaling for marathon-specificity penalty (2026-05-05)

**Where**: `src/calculations/predictions.ts:blendPredictions`. Optional `marathonPbAgeDays` parameter modifies the penalty severity.

**Problem.** The marathon-specificity penalty (see entry below) is calibrated against full-detraining literature — Coyle 1984 measures performance loss in athletes who've completely stopped training. For a cross-trained athlete with a *recent* marathon PB (e.g. 3:09 last year), full-detraining curves over-correct: the athlete has demonstrated current marathon-specific capability within the past year, so the staleness assumption baked into the penalty is false. The penalty's *direction* was correct (current marathon-specific fitness < PB capability) but its *magnitude* was wrong because the staleness assumption didn't hold.

**Physiological basis.** A recent marathon completion is direct evidence of three preserved physiological capacities: (1) aerobic base sufficient to sustain marathon pace, (2) fractional utilization at marathon distance — the marathon-critical term per Joyner & Coyle (2008), (3) glycogen storage and substrate management.

Coyle (1984) and Mujika & Padilla (2000) measure decay rates of each term independently in fully-detrained athletes. Within 8-12 weeks of detraining, fractional utilization decays significantly. But the decay timeline assumes total cessation — a cross-trained athlete maintaining VO2 via cycling/swimming preserves term 1 and attenuates the decay rate of terms 2 and 3.

A PB completed within ~12 months means the athlete demonstrably had all three capacities at PB level recently. Even with cross-training-only patterns since, full-detraining curves over-state the magnitude of decay. Empirical evidence: club marathoners returning to running after 6-12 month gaps with maintained aerobic base typically run 5-10% slower than peak, not the 15% the full-detraining bands assume.

**Formula.**

```
recencyFactor = 1.0
if (marathonSpecificityPenalty > 1.0 && marathonPbAgeDays != null):
  if marathonPbAgeDays < 365:    recencyFactor = 0.5    # PB within last year
  elif marathonPbAgeDays < 730:  recencyFactor = 0.75   # PB 1-2 years
  # >2 years: full penalty (recencyFactor stays 1.0)

if recencyFactor < 1.0:
  excess = marathonSpecificityPenalty - 1.0
  marathonSpecificityPenalty = 1.0 + (excess × recencyFactor)
```

For the diagnostic case (3:09 PB ≈300 days old, 0 km/wk recent): pre-recency penalty 1.15, recencyFactor 0.5, excess 0.15 × 0.5 = 0.075, post-recency penalty 1.075. Applied to PB-anchored blend (~3:09:42), final baseline ~3:23 instead of 3:38. Matches athlete's intuition while still recognising decay below peak.

**Why scale `excess` not `penalty` directly**: scaling the penalty itself would risk going below 1.0 and inverting the direction (predicting *faster* than the blend, which is wrong — the athlete IS slower than peak even with a recent PB). Scaling `excess` keeps a floor at 1.0 and preserves the qualitative direction.

**Bands chosen pragmatically.** < 365 days (×0.5) — a full annual training cycle; the PB represents the athlete's current training era. 365-730 days (×0.75) — one peak ago; some decay expected but training infrastructure recent. > 730 days — old peak; treat as fully stale.

**Limitations.**

- Step function at 365/730 boundaries creates discontinuities. Acceptable because boundary cases are rare.
- Doesn't account for *what the athlete has done since the PB*. The recent-volume term in the underlying penalty band partially captures this, but the recency factor doesn't compose with it.
- Requires a date for the PB. If `marathonPbAgeDays` is undefined (PB persisted without a date — manual entry, or auto-fill where Strava's `best_efforts.start_date` and the activity's `start_time` are both missing), recencyFactor stays at 1.0 (full penalty). Safe-default behaviour.
- PB age comes from Strava `best_efforts.start_date` (per-effort) with fallback to activity `start_time` (with belt-and-suspenders lookup from `cachedActivities` by `activityId`). If all sources are empty, recency benefit doesn't apply.

**Confidence**: medium-high. Mechanism is well-supported by underlying detraining literature (same papers that calibrated the base penalty). Magnitudes are pragmatic — chosen to keep predictions within ±5% of empirical reality for cross-trained returning athletes — but not derived from a single calibrated regression. Future work: build a labelled outcome dataset of (current marathon time, PB time, PB age, recent volume, cross-training volume) and re-fit the penalty bands against it.

---

## Plan-prescribed dose feeds the horizon model (2026-05-05)

**Where**: `src/calculations/training-horizon.ts:getPlanPrescribedMeanWeeklyKm`. Used by all five forecast call sites (`events.ts`, `renderer.ts`, `blended-fitness.ts`, `plan-preview-v2.ts`, `initialization.ts` via `calculateForecast`).

**Problem.** The horizon model's `weekly_volume_km` parameter governs `effective_sessions = sessions × clamp(km_per_session / ref_km_per_session, [0.5, 1.3])`, which feeds the `session_factor` logistic centred at `ref_sessions`. Pre-fix, all callers passed `s.wkm` — the user's pre-plan training volume (set by the wizard heuristic to `sessions × 10` for 4+ sessions, or detected from Strava history). For a user committing to a 4-session/wk marathon plan with `s.wkm = 40`, this gave `effective_sessions = 3.63` and `session_factor = 0.134` — only 13% of the available improvement from the saturating curve.

But `s.wkm` represents what the user trains *now*, not what the plan delivers. The horizon model's *job* is to predict gain *from the plan*, so it should see the dose the plan will actually deliver across its build phase, not the maintenance dose preceding the plan.

**Empirical reference.** Canonical periodised marathon plans:
- **Pfitzinger 18-week intermediate (4 sessions/wk)**: ramps from ~32 km/wk to peak ~89 km/wk (week 12-13), then 3-week taper to ~30. Mean across the 15 non-taper weeks: ~50-55 km/wk.
- **Pfitzinger 18-week intermediate (5 sessions/wk)**: ramps to peak ~105 km/wk. Mean across 15 non-taper weeks: ~65 km/wk.
- **Daniels Q-plans**: similar build-phase ramp shape and mean.

Compared to bare `sessions × REF_KM_PER_SESSION` reference (4 × 11 = 44, 5 × 11 = 55): the periodised mean is **1.14-1.25× higher**. This is the build-phase volume ramp — periodised plans push above maintenance level to drive adaptation, then taper below it for race day.

**Formula.**

```
PLAN_BUILD_PHASE_FACTOR = 1.2  // centre of [1.14, 1.25] empirical range

getPlanPrescribedMeanWeeklyKm(sessions, distance):
  if (sessions <= 0) return null
  ref = REF_KM_PER_SESSION[distance]   // marathon=11, half=10, 10K=9, 5K=8
  if (!ref) return null
  return sessions × ref × PLAN_BUILD_PHASE_FACTOR
```

For 4-session marathon: 4 × 11 × 1.2 = 52.8 km/wk. For 5-session marathon: 5 × 11 × 1.2 = 66 km/wk. These match Pfitzinger's empirical means.

**Why this is the right input** (vs current volume, peak volume, or starting volume):
- **vs current/`s.wkm`**: `s.wkm` is what you do *before* the plan. The horizon predicts gain *from* the plan. Using current volume systematically under-predicts gain for athletes committing to a properly-dosed plan (the failure mode this fix addresses).
- **vs peak weekly volume**: peak weeks contribute disproportionately to the training integral but recovery weeks contribute less. Using peak would over-state the integrated dose. The horizon model already handles tapering via `weeks_eff = weeks_remaining - taper_weeks`, so feeding peak (which is reached briefly mid-build) would double-weight the high-volume influence.
- **vs starting volume**: starting volume is the maintenance baseline. Plans drive adaptation by ramping above that. Using starting volume reproduces the same under-prediction as current volume.

The right input is the **mean across the build phase** — what the user actually trains across the weeks where adaptation is happening. Banister's impulse-response model (1975) integrates training stimulus over time; mean-of-build is the integral's correct argument.

**`s.wkm` and `weekly_volume_hours` remain as fallbacks.** When `getPlanPrescribedMeanWeeklyKm` returns null (e.g., sessions unknown, unsupported distance), the caller falls back to `s.wkm`. The horizon model itself also accepts `weekly_volume_hours` as a secondary fallback (computed via `HOURS_TO_KM_RATE = 10`). The priority chain is: plan-prescribed km → user's history km → user's stated training hours.

**Limitations.**

- `PLAN_BUILD_PHASE_FACTOR = 1.2` is a constant, not adaptive. A 6-session/wk plan's build-phase ratio might differ from a 3-session/wk plan's — both currently get the same factor. Acceptable as a starting point; refinable with empirical data from real Mosaic users.
- The factor is calibrated against marathon plans specifically. For half/10K/5K it's used unchanged. Pfitzinger 12-week half plans show similar 1.15-1.25 build-phase ratios, so the constant generalises reasonably, but distance-specific tuning is possible if needed.
- This is a *prediction* of plan dose, not the actual dose. If the user fails to follow the plan (skips, replaces, reduces), actual delivered dose will be lower. The live `refreshBlendedFitness` path tracks actual training data and updates predictions accordingly across the plan's lifetime — so this fix's optimism is corrected by reality if the user under-trains.

**Confidence**: high. The mechanism and calibration are well-supported by published marathon training plan literature (Pfitzinger & Douglas 2009, Daniels 2005). The choice of plan-mean over peak/current is supported by Banister's dose-response framework. The `1.2` constant is empirically calibrated against canonical plans, not fitted from a single dataset.

---

## Marathon-specificity penalty when Tanda gates out (2026-05-05)

**Where**: `src/calculations/predictions.ts:blendPredictions` — applied to the final blended marathon prediction when `targetDist === 42195 && tTanda == null && weeklyRunKm != null`.

**Problem.** The marathon prediction blend weights LT (40%), Tanda volume (30%), VO2 (10%), PB (10%), HR-VDOT (10%). Tanda is the *only marathon-distance-specific* predictor — it uses recent training volume (K) and mean training pace (P) to predict marathon time directly (Tanda 2011, r = 0.91 vs 46 marathoners). The other four signals are *fitness-ceiling* predictors: they describe what the athlete *could* run if their marathon-specific physiology was intact.

Tanda gates itself out when sample size is insufficient (`weeksCovered < 4` or `paceConfidence < medium`). When gated, Tanda's 30% weight redistributes to LT (line 572-575), so the blend becomes dominated by ceiling-fitness signals (LT 70%, PB 10%, VO2 10%, HR 10%). For an athlete with strong PBs but low recent running volume — e.g. cross-trained returning marathoner — **the blend predicts what their fitness ceiling could deliver, not what their current marathon-specific endurance will deliver on race day**.

The previous code (`predictions.ts:559`) explicitly skipped `lowVolumeDiscount` for marathon distance, on the assumption that Tanda would handle volume sensitivity. That assumption breaks when Tanda doesn't fire. Result: a 3:09:42 PB-holder running ~25 km/wk was predicted at 3:12:50 — slightly slower than their PB but well within "racing today" territory, when in reality their detrained marathon-specific physiology would deliver something closer to 3:22.

**Physiological basis.** Marathon performance is decomposed by Joyner & Coyle (2008) as:

```
marathon time ∝ 1 / (VO2max × fractional_utilization × running_economy)
```

Of the three terms, **fractional utilization at marathon distance** is the most training-sensitive and decays fastest with low running volume:
- **Coyle (1984)** — 84-day detraining study: VO2max declined ~7% in week 3, plateaued at −16% by week 12; but lactate threshold (a proxy for fractional utilization) declined more rapidly. Marathon-pace sustainability is driven by LT-as-fraction-of-VO2max, not VO2max in isolation.
- **Mujika & Padilla (2000)** — meta-analysis: short-term detraining (≤4 weeks) shows preserved VO2max but compromised exercise-economy and lactate-handling. Long-term (>4 weeks) shows further marathon-pace deterioration even when VO2max-by-watch-tracking has plateaued.
- **Cross-training preservation**: VO2max can be largely maintained by non-running aerobic activity (cycling, swimming, etc.) but marathon-specific *running economy* and *fractional utilization at marathon pace* require run-specific stimulus to maintain. This is why a cross-trained athlete with VO2 56 from cycling can have marathon time predictions over-stated by 15–20% if computed from VO2 alone.

**Formula.**

```
marathonSpecificityPenalty = 1.0
if (targetDist === 42195 && tTanda == null && weeklyRunKm != null):
  if weeklyRunKm < 10:  penalty = 1.15
  elif weeklyRunKm < 20: penalty = 1.10
  elif weeklyRunKm < 30: penalty = 1.05
  else: penalty = 1.00  (≥30 km/wk preserves fractional utilization per Coyle 1984)

return (sum / totW) * marathonSpecificityPenalty
```

**Why multiplicative on the final time, not a weight-shift to PB**: the existing `lowVolumeDiscount` (used for non-marathon distances) shifts weight from LT/VO2 onto PB, with the design assumption that PB represents preserved peak fitness. That works for 5K/10K/half where peak fitness is largely preserved across detraining gaps (these distances are more VO2-limited and less fractional-utilization-limited per Joyner & Coyle's decomposition). For marathon, **PB itself overstates current marathon time** because the fractional-utilization term that governs marathon performance has decayed independently of VO2max or LT. Shifting weight to PB would push the prediction faster (toward the user's PB), which is the wrong direction. A multiplicative slowdown on the final prediction directly addresses the gap without assuming any single signal is preserved.

**Penalty calibration.** Bands chosen to land predictions within ±5% of empirical reality for cross-trained returning athletes. Anchored to Tanda 2011's residual analysis at the low-volume end (K < 30 km/wk subset shows ~5–8% over-prediction by VO2-only methods). Conservative — a 5% slowdown at 25 km/wk corresponds to ~9 min on a sub-3 marathon time, which most cross-trained returning athletes will validate as "about right" against their own intuition.

**Limitations.**

- Step-function in 10-km bands creates discontinuities at the boundaries. A 29 km/wk athlete gets penalty 1.05; at 30 km/wk it drops to 1.00. Could be smoothed with a logistic if the discontinuity becomes a UX issue, but step bands are easier to reason about and the boundary cases are rare in practice.
- Doesn't account for *recency* of running history. An athlete who ran 80 km/wk last year but 0 km/wk for the past 3 months gets the same penalty as someone who has *always* run 0 km/wk. The Tanda gating handles part of this (requires `weeksInWindow ≥ 4` of qualifying training to fire), but a richer recency model could be added later.
- Doesn't differentiate between cross-trained athletes (preserved VO2, lost RE/utilization) and fully detrained athletes (lost everything). The penalty is conservative for both. Refinable later with cross-training-volume input.

**Confidence**: medium-high. The mechanism is well-supported by detraining literature (Coyle, Mujika & Padilla, Joyner & Coyle). The penalty bands are pragmatic — based on Tanda's empirical residuals at low volume — but not derived from a single calibrated regression. Future work: re-fit the bands against a labelled marathon-outcome dataset once Mosaic accumulates enough longitudinal user data with low-volume start states.

---

## Forecast anchored to blendPredictions (2026-05-05)

**Where**: `src/calculations/predictions.ts:calculateLiveForecast` and `:calculateForecast`. Optional `blendedAnchorSec` parameter.

**Problem.** "Forecast finish" (end-of-plan projection) and "Current Race Estimate" (today's predicted race time) were computed by two different prediction models on incompatible scales:

- **Current Race Estimate** = `blendPredictions(targetDist, pbs, lt, vo2, b, typ, recentRun, tier, weeklyKm, avgPace, volumeMeta, hrVdot)` — a weighted blend across PB extrapolation, LT-derived (CV), VO2-derived (Daniels), recent-run extrapolation, Tanda volume model (marathon-only), and HR-calibrated VDOT (Swain regression). Anchored to actual outcome data.
- **Forecast finish** = `tv(currentVdot + horizon.vdot_gain, raceDistKm)` — bare Daniels VDOT-to-time table lookup at end-of-plan VDOT. Anchored to nothing except the current VDOT estimate.

For a trained marathoner with strong PBs, `blendPredictions` returned ~3:12 while bare `tv(VDOT 52, marathon)` returned ~3:21. Comparing them is meaningless; subtracting them produced a *9-minute regression* at Week 1 with zero training done. The wizard's plan-preview showed a 1m 35s improvement after 36 weeks of training — the gain itself was correct in VDOT terms (~1.6 points) but the bare-VDOT baseline (3:12) put the result at 3:11, hiding the real 10-min projected improvement.

**Fix.** Anchor the forecast to the blend's view of today and apply the horizon model's gain as a *delta in seconds* on top:

```
bareToday    = tv(currentVdot,         distKm)
bareForecast = tv(currentVdot + gain,  distKm)
horizonDelta = bareToday - bareForecast            // seconds saved by the horizon gain
forecastTime = blendedAnchorSec - horizonDelta     // anchored to blend
```

This preserves the horizon model's predicted gain *exactly as it computes* (using Daniels' non-linear VDOT-to-time table on both ends), while ensuring the absolute time is on the same scale as the live "Current Race Estimate" surfaces. When `blendedAnchorSec` is omitted, the function falls back to the legacy bare-VDOT path (preserves backward compatibility for callers that haven't been audited).

**Why subtractive (not multiplicative).** Triathlon's `race-prediction.triathlon.ts:356-379` does the analogous job multiplicatively (`baseRunPaceSecPerKm / horizonRatio`), which is appropriate for *pace scaling across variable leg distances* (HM run for 70.3, marathon for IM) where a small VDOT delta maps cleanly to a proportional pace improvement. For running's fixed-distance race prediction, the subtractive form is more faithful to Daniels' table — VDOT-to-time is non-linear (the same VDOT delta yields different second savings at different fitness levels and different distances), and the table lookup captures this exactly. Multiplicative would approximate.

**Limitations.**

- Assumes `blendPredictions` is itself well-calibrated. If the blend over-predicts (e.g. a lucky 5K PB with no marathon validation), the anchored forecast inherits that bias. The blend has its own quality controls (`paceConfidence`, `weeksCovered`, `lowVolumeDiscount`) that already address most failure modes.
- Detraining is captured *if and only if* `blendPredictions` reflects it. Watch-derived LT/VO2 stay elevated post-detraining (see "Low-volume detraining adjustment" entry); the blend's `lowVolumeDiscount` partially corrects, and once the blend pulls slower the anchored forecast follows.
- The horizon model still bounds the projected gain. A very long plan (40+ weeks) for a trained athlete legitimately predicts modest VDOT gains (1-3 points) due to the diminishing-returns curve in `applyTrainingHorizonAdjustment`. The fix corrects the *anchor*, not the *gain magnitude*.

**Confidence**: high. The fix is a pure scale correction — no new model, no new constants. Two well-validated functions that previously produced incompatible numbers now produce numbers on the same scale.

---

## Race-specific course factors for running, cycling, and Hyrox (2026-05-05)

**Where**: `src/calculations/course-factors-running.ts` (run); `src/calculations/race-prediction.cycling.ts` (cycling extension); `src/calculations/race-prediction.hyrox.ts` (new); shared multipliers reused from `src/constants/triathlon-course-factors.ts`.

**Goal**: predicted finish times must reflect the *course*, not just the athlete's fitness. A 2:50 fitness on flat-cool Berlin is not the same number on hot-flat Dubai or on +250m-rolling Boston. Triathlon already had this layer; running, cycling, and Hyrox did not.

**Models applied per discipline:**

### Running (`applyRunningCourseFactors`)

Per-race `CourseProfile` (climate, altitudeM, runElevationM) compounds three multiplicative factors on top of the raw VDOT-derived finish time:

1. **Climate** — `CLIMATE_RUN_MULTIPLIER` from `triathlon-course-factors.ts`. Anchored to Ely et al. (2007), El Helou et al. (2012, 1.7M finishers), Galloway & Maughan (1997), ACSM Heat Position Stand (2007). Range: cool (1.000) → hot-humid (1.120).
2. **Altitude** — `altitudeRunMultiplier(altitudeM)`. Bonetti & Hopkins (2009 meta-analysis), Wehrlin & Hallen (2006). Linear 0.20%/100m above 500m; 0.40%/100m above 1500m. Capped at +12%.
3. **Run elevation** — `runElevationMultiplier(elevationM, distanceKm)`. Minetti et al. (2002) energy-cost polynomial `C(i)` evaluated at the average grade. Strava's GAP algorithm uses the same formula.

**Confidence**: high for climate and altitude; medium for elevation (average-grade simplification underestimates rolling-course cost vs per-km gradient analysis).

### Cycling (`predictCyclingEvent` extension)

Existing physics-based prediction (Martin 1998, `bike-physics.ts`) already handled course profile and aero. New layer adds:

1. **Climate (bike)** — `CLIMATE_BIKE_MULTIPLIER`. Tatterson et al. (2000 J Sci Med Sport, 32°C vs 23°C TT showed ~6.5% power loss). Bike penalty is ~40% of run because convective cooling at 30+ km/h removes more heat than running's lower airspeed. Range: cool (1.000) → hot-humid (1.050).
2. **Altitude (bike)** — `altitudeBikeMultiplier`. Bike penalty ~65% of run because IM-intensity cycling is sub-maximal aerobic; running has higher relative VO2 cost per unit speed. Capped at +8%.

Cycling event lookup (`CYCLING_EVENTS`) seeds climate / altitude / elevation for famous sportives (Étape, Marmotte, Leadville at 3840m, etc.).

### Hyrox (`predictHyroxRace`, new)

Sum-of-parts model:
```
total = (runPaceSecKm × 8) + Σ(8 station times) + roxzoneSec
```
where station times come from `stationBenchmarks` (calibrated) or `STATION_SEED_TIMES_SEC[band]` (population averages from HyroxDataLab + roxlyfe.com).

Venue factors (heuristic — confidence low-medium, see `src/data/hyrox-venues.ts` for derivation):

1. **Floor surface** — affects sled stations primarily. Concrete is cleaner on the run loop (-0.5%) but slower on sleds (+10s per station). Mixed surfaces add inconsistency (+6s per sled).
2. **Lap difficulty** — long straights vs tight S-curves. Easy 0.985, standard 1.000, hard 1.030 on each 1km run.
3. **Venue temperature** — convention-centre HVAC variance. Warm (1.015 on run, 1.012 on endurance stations), hot (1.030 / 1.025).
4. **Altitude** — reuses `altitudeRunMultiplier` for run + endurance stations (ski_erg, row_erg, wall_balls, burpee_broad_jumps, sandbag_lunges). Mexico City (2240m) is the only currently-listed Hyrox venue with non-trivial altitude.

**Limitations**:
- Hyrox venue multipliers are inferred from athlete reports and finishing-time spreads, not from a controlled cross-venue study. Treat as v1 heuristic — refresh when structured data becomes available.
- Running elevation uses average grade. Rolling courses with equal up/down still show non-zero penalty due to asymmetric eccentric cost; that's a feature, not a bug, but the magnitude is uncertain.
- Climate uses categorical buckets (cool/temperate/warm/hot/hot-humid) anchored to typical race-week wet-bulb temperature. Race-day weather can swing — Boston in particular is highly variable. Manual override path (per-race climate) is supported.

**Compounding sanity-check**: `MAX_REASONABLE_LEG_PENALTY = 1.25` (25% combined). Logs a warning if any single mode produces a higher compound multiplier — e.g. a hot+altitude+elevation race like Leadville is at the upper bound.

---

## Volume-aware training horizon — running prediction now scales with weekly hours/km (2026-05-05)

**Where**: `src/calculations/training-horizon.ts` — `applyTrainingHorizonAdjustment`. New helper `computeEffectiveSessions` and constants in `src/constants/training-params.ts` (`REF_KM_PER_SESSION`, `HOURS_TO_KM_RATE`).

**Problem**: The horizon adjuster's `session_factor` logistic treated every session as a standard dose. A 4×30-min marathon plan and a 4×80-min marathon plan produced identical predicted VDOT gain. The `weekly_volume_km` field existed on `TrainingHorizonInput` but the function never read it. Result: a 10-h/week runner saw the same predicted improvement as a 3-h/week runner if both did 4 sessions.

**Fix**: Convert raw `sessions_per_week` into `effective_sessions` via a dose multiplier:

```
ref_km_per_session = REF_KM_PER_SESSION[distance]   // 5K=8, 10K=9, half=10, marathon=11
km_proxy           = weekly_volume_km ?? (weekly_volume_hours × HOURS_TO_KM_RATE)
actual_km/session  = km_proxy / sessions_per_week
dose_factor        = clamp(actual_km/session ÷ ref_km/session, 0.5, 1.3)
effective_sessions = sessions_per_week × dose_factor
```

`effective_sessions` then feeds the existing `session_factor` logistic AND the undertraining penalty. Returns to legacy behaviour when neither km nor hours is provided.

**Why these reference values are defensible**:

The `REF_KM_PER_SESSION` table is derived directly from the existing `ref_sessions[distance][intermediate]` × the canonical weekly mileage in two long-published intermediate plans:

- **5K**: ref_sessions=4.0 × ~32 km/wk → 8 km/session (Daniels' 5K Q1/Q2 plan).
- **10K**: ref_sessions=4.5 × ~40 km/wk → 9 km/session (Daniels' 10K Phase II).
- **Half-marathon**: ref_sessions=5.0 × ~50 km/wk → 10 km/session (Pfitzinger's 47-63 km HM plan).
- **Marathon**: ref_sessions=5.5 × ~62 km/wk → 11 km/session (Pfitzinger's *Advanced Marathoning* 55-70 mpw plan).

These are not invented: they are the per-session implications of the existing horizon parameters multiplied by the canonical weekly-mileage assumption in the source the horizon parameters were calibrated against.

**Why the [0.5, 1.3] clamp**: The lower bound prevents a fully zero-credit collapse when a user enters wildly under-target volume — they still get *some* horizon credit for at least showing up. The upper bound prevents an absurd long-session plan (e.g. someone entering 200 km/wk) from inflating the gain past what real adaptation can produce. The bracket matches the dose-response saturation observed in Tanda 2011 (marathon time vs weekly km) — improvements flatten beyond ~85 km/wk in the Tanda dataset.

**Why hours fallback uses 10 km/h**: Daniels' easy-pace zone for an intermediate VDOT (45-50) median is ~6:00/km = 10 km/h. The hours fallback is only used when `weekly_volume_km` is missing (new user with no run history) — once history exists, the more precise km signal takes over.

**Knock-on benefit for triathlon and cycling**:

The triathlon run-leg adjuster (`applyTriHorizonRun` in `training-horizon.triathlon.ts:178`) already passes `weekly_volume_km` to the same underlying function. With this fix, the field is finally consumed — meaning a 12 h/wk Ironman trainee now correctly sees a higher run-leg VDOT projection than a 5 h/wk one, which it previously did not. Cycling mode will inherit the same behaviour automatically when its predictor ships in V2.

**Limitations**:

- Hours-based fallback assumes uniform easy pace; ignores how the user actually splits intensity. Acceptable because km history overrides hours as soon as one week of data exists.
- Dose factor uses *average* km-per-session, not the long-run shape. A plan with 4×5km + 1×40km has the same dose factor as 5×13km, but the long-run quality differs. The existing `long_run_max_km` field on `TrainingHorizonInput` could feed a future second-order adjustment; deferred until we have evidence the average misleads.
- Reference values are intermediate-tier; we do not (yet) scale `REF_KM_PER_SESSION` per ability band. Beginners on low volume are protected by the existing `applyGuardrails` ceiling, so the floor isn't catastrophic for them.

**Tests** (`training-horizon.test.ts > weekly volume effect`): 7 new tests covering high-vs-low volume separation, hours fallback, undertraining penalty trip on very short sessions, km-over-hours preference when both supplied, legacy behaviour preserved when neither supplied, and clamp behaviour at extreme volume.

**References**:

- Daniels, *Daniels' Running Formula* 4th ed. (2022), Chapter 9 (5K plans), Chapter 10 (10K plans). Per-distance weekly-mileage reference points for intermediate runners.
- Pfitzinger & Douglas, *Advanced Marathoning* 3rd ed. (2019). 55-70 mpw and 70-85 mpw schedules, source for marathon and HM reference km/session.
- Tanda G. (2011) "Prediction of marathon performance time on the basis of training indices." *J Human Sport & Exercise* 6(3). Marathon dose-response saturation beyond ~85 km/wk.
- Foster C., Florhaug J.A., et al. (2001) "A new approach to monitoring exercise training." *J Strength Cond Res* 15(1):109-115. Training stimulus = volume × intensity, dose-response in untrained-to-recreational populations.

---

## Pro-grade bike workout kinds — over-unders, VO2 micros, VLamax (2026-05-02)

**Where**: `src/workouts/bike.ts` adds three pro-grade `BikeSessionKind` values alongside the existing six (endurance/tempo/sweet_spot/threshold/vo2/hills). Each is selected by `pickBikeKind` for specific phase + slot combinations and rendered with literature-anchored interval prescriptions.

### Over-unders (`over_under`)
**Stimulus**: Alternating sub- and supra-threshold reps train lactate clearance at high intensity. The "under" sections force aerobic clearance of lactate produced during the "overs", improving the rider's ability to handle threshold-level surges in road racing or triathlon bike legs.

**Formula / prescription**: Three variants, all anchored to Coggan & Allen, *Training and Racing with a Power Meter* (3rd ed., 2019), Ch. 7:
- Classic over-under: 3× (3min @ 105% FTP → 3min @ 95% FTP), continuous, 5min easy between sets.
- Criss-cross: 2× (5× (1min @ 110% FTP / 1min @ 85% FTP)), shorter alternations, 5min easy between blocks.
- 2:1 ratio: 4× (2min @ 105% FTP → 1min @ 95% FTP) continuous, 4min easy between.

**Defensibility**: Coggan & Allen explicitly recommend over-unders as a Z4 development tool. The 105/95% bracket sits inside MLSS variability across riders (≈90–105% FTP) so the "unders" remain near-threshold rather than easy, maximising clearance demand.

**Load assumptions** (`tssPerMin = 1.65`, `anaerobicShare = 0.45`): Slightly above pure threshold work because the 105% overshoots compound load. Anaerobic share between sweet-spot (0.25) and threshold (0.40) — the unders pull the average down vs continuous threshold.

**Limitations**: TSS-per-minute is a pragmatic estimate until Phase 4 wires real bTSS from .fit power streams. Actual NP/IF for these sessions averages ≈0.98–1.02 depending on variant; the IF entry in `tri-effort-scoring.ts` is set to 1.00.

### VO2 micro-intervals (`vo2_micros`)
**Stimulus**: Short (30s) high-intensity reps separated by short (30s) recoveries accumulate more total time at VO2max than longer reps because oxygen kinetics keep the athlete near VO2max during the brief recoveries. Lower lactate accumulation per minute of work than 3–5min reps, allowing higher total volume.

**Formula / prescription**: Adapted from Billat V., *Sports Medicine* 31(1):13–31 (2001) "Interval training for performance: a scientific and empirical practice". Three variants:
- 2× (10× 30s @ 120% FTP / 30s easy), 5min between blocks.
- Continuous: 15× (30s @ 118% FTP / 30s @ 50% FTP).
- 3× (8× 40s @ 115% FTP / 20s easy), 4min between blocks.

**Defensibility**: Billat's 30/30 protocol was originally developed for runners at vVO2max but has been validated on bike (e.g., Rønnestad & Hansen, *Scand J Med Sci Sports* 2014, "Optimizing interval training at power output associated with peak oxygen uptake in well-trained cyclists"). 115–120% FTP corresponds approximately to %vVO2max for cyclists with FTP at ~85% of VO2max power.

**Load assumptions** (`tssPerMin = 1.75`, `anaerobicShare = 0.55`): Below classic VO2 (1.9 / 0.60) because the 1:1 work:rest ratio means rest dominates more of the session than 3:3 reps. Still high anaerobic share due to repeated VO2 spikes.

**Limitations**: %FTP targets are a reasonable proxy for vVO2max equivalent power but individual variation is large (±10%). Athletes with high VO2max-to-FTP ratios will under-stimulate at 115% FTP.

### VLamax neuromuscular sprints (`vlamax`)
**Stimulus**: Very short (6–15s) maximal efforts with long (3–5min) full-recovery rests target phosphocreatine resynthesis and glycolytic ceiling without inducing systemic aerobic fatigue. Develops peak power and rate of force development for race-day attacks, breakaways, and finishing sprints.

**Formula / prescription**: Three variants, anchored to Coggan's Z6 / Z7 zones (*Training and Racing with a Power Meter* Ch. 4):
- 8× 10s max sprint @ 160%+ FTP, 3min easy spin between.
- 6× 15s standing-start @ 150%+ FTP, 4min full recovery.
- 3× (4× 6s seated max sprint, 90s easy), 5min between blocks.

**Defensibility**: 6–15s window matches the PCr-dominant energy system (Gastin, *Sports Medicine* 31(10):725–741, 2001). Full recovery (3–5min) is required because incomplete PCr resynthesis turns the session into a glycolytic-tolerance set rather than peak-power development. Total work volume capped at ~2min keeps systemic stress low.

**Load assumptions** (`tssPerMin = 1.10`, `anaerobicShare = 0.75`): Lowest TSS per minute of any quality kind because most of the session is recovery. Highest anaerobic share — the actual work bouts are almost entirely PCr/glycolytic. Total session TSS for a 60min slot lands around 60–70 TSS, well below threshold work.

**Limitations**: 160%+ FTP targets assume the athlete has the neuromuscular capability to reach those wattages — newer riders may produce considerably less. Phase 4 (.fit power streams) will give us real peak-power data per rep so the prescription can be calibrated per athlete.

### Phase rotation logic
`pickBikeKind` now alternates classic and pro-grade kinds week-to-week using a parity-of-weekIndex check. This matches periodisation practice — a 4-week build mesocycle should expose the rider to multiple stimulus shapes rather than the same workout four times. Endurance recovery slots are excluded from rotation because they should stay stable. Base phase has no supra-threshold rotation — the aerobic foundation comes first.

---

## Triathlon — Home readiness card uses tri composite (2026-05-01)

**Why the tri composite, not the running composite**: The running-side `computeReadiness` is built around Signal A (run-equivalent iTRIMP with runSpec discounts). A week of heavy bike load produces low running ACWR but full physiological stress — the running composite would call it "safe" while the athlete is at genuine risk of accumulation. The tri composite (`computeTriReadiness`) runs the same engine once per discipline using that discipline's own CTL/ATL/TSB, then surfaces the worst label. This correctly detects bike or swim overload that the running composite would mask.

**What is shared vs separated**: Sleep and HRV are passed identically to all three discipline calls — they are sport-agnostic. The freshness and load-safety sub-scores differ per discipline because each has its own TSB and ACWR. The "worst label across three" is the conservative, athlete-safe choice: one sport overreaching should suppress the overall readiness even if the others look fine.

**Running mode unchanged**: The branch at `buildReadinessRing` is a strict `if (isTri)` guard. Running mode still calls `computeReadiness` with the running composite unchanged.

---

## Triathlon — Adaptation engine (effort scoring, auto-progression, race-outcome) (2026-04-30)

Three pieces wired together to close the adaptation loop in tri mode:

### §M — Per-session effort scoring (multi-discipline)

Mirror of the running-side `computeHREffortScore` shape (0.5–1.5 range, 0.9–1.1 = on target), applied per discipline with the right primary signal:

- **Bike**: power adherence (NP/FTP vs target IF) primary; HR effort secondary cross-check via `BIKE_LTHR_OFFSET_VS_RUN = -7` bpm (Millet & Vleck 2000) when power meter absent. HR effort uses Karvonen reserve scaled to target IF.
- **Swim**: pace adherence vs CSS-derived target (existing) primary; HR effort skipped — most users don't wear straps in water.
- **Run**: reuses existing running helpers (`computeHREffortScore`, `computePaceAdherence`, Daniels VDOT zones). No new math.

Confidence: high for power-bike and pace-swim; medium for HR-bike (hydration/heat/cadence noise); low for swim HR (deferred). Cited in `docs/SCIENCE_LOG.md` §F (per-discipline horizon) and inline in `tri-effort-scoring.ts`.

### §N — Per-discipline effort multiplier (auto-progression)

Mirrors running's `effortMultiplier` (`src/workouts/plan_engine.ts:113`):

```
score = mean(actual RPE − planned RPE) over last TRI_EFFORT_LOOKBACK_WEEKS = 2
multiplier = clamp(1 - score × 0.05, 0.85, 1.15)
```

Applied per discipline (swim / bike / run) at plan generation and regeneration. Effect: when athlete consistently rates sessions easier than planned, upcoming session **durations** scale up by up to 15%. Symmetric in the other direction.

**Limitation by design**: scales DURATION only, not intensity tier. Pace/watts/CSS targets auto-update via marker re-derivation (`refreshBlendedFitness` for run; `deriveTriBenchmarksFromHistory` for swim/bike). Intensity-tier promotion (e.g. threshold → VO2) is intentionally NOT auto — per Tristan's principle, that's a big pace jump worth surfacing through the suggestion modal, not silent escalation.

### §O — Race-outcome logging

Schema: `TriRaceLogEntry` carries predicted vs actual per leg + total, indexed by `dateISO`. Detection runs once per race when `triConfig.raceDate < today` and race-day activities are present in DB; idempotent (same `dateISO` won't double-log).

v1: log always, surface retrospectively only when `predicted - actual ≥ TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC` (60s — see `triathlon-constants.ts`). The asymmetry is deliberate user-trust: positive surprise rewards the plan; negative surprise we log silently for v2 calibration but don't punish the athlete.

v2 deferred: per-athlete calibration multiplier from rolling average of past race gaps (e.g. if you consistently undershoot by 5%, future predictions adjust).

---

## Triathlon cross-training overload detector — v2 (2026-05-01)

**Updates v1** (entry below). Three significant design changes:

**1. Run-anchored recommendation.** v1 picked the discipline with the most remaining planned TSS. v2 anchors on **run** by default. Most cross-training (tennis, padel, gym, hiking, soccer, basketball, walking) is leg-impact-loaded and substitutes for running stress more directly than for swim or bike. Categorical mapping in `classifyAffinity`: "bike" if name/activityType contains cycl/biking/mtb/spin/zwift; "swim" if it contains swim/aquatic/pool; "run" otherwise. Per CLAUDE.md "no made-up numbers" — this is a categorical rule, not an empirical transfer coefficient. Falls through to next-most-loaded discipline if the affinity-recommended discipline has no remaining work.

**2. Multi-mod with severity tiers + saturation.** Mirrors running's suggester. Severity (light < 15%, heavy 15–25%, extreme > 25%) gates the max number of mods proposed (heavy → 2, extreme → 3 — smaller than running's 1/2/3 because tri has fewer mod-able workouts per discipline). Per-discipline candidate sets carry both `reduceMods` (downgrade quality, trim endurance) and `replaceMods` (interleave swap-easy + reduce). Saturation curve from running (`1500 × (1 - exp(-x/800))`) caps how much credit a single huge cross-training session can unlock.

**3. Per-discipline floor + push-to-next-week carry.** New `computeTriDisciplineFloorTSS` (mirror of `computeRunningFloorKm`): returns 0 in taper, 0 when per-discipline ACWR > 1.3 (suspended for injury safety), `0.65 × plannedDisciplineTSS` otherwise. Per-discipline `belowFloor` flag fires in modal when reductions would breach floor — the modal warns but doesn't block (user override). Push-to-next-week stores cross-training TSS on `Week.carriedCrossTrainingTSS`; `computeDecayedTriCarry` (7-day τ, 3-week lookback) is consumed by the next week's detector so deferred load doesn't disappear — it just spreads exponentially.

**Why these mirror running rather than reinvent**: per CLAUDE.md "Mirror rule — running and triathlon mode parity", and per the user's explicit instruction "take a lot from running here". The running suggester's severity / saturation / interleave / floor patterns work well; tri benefits from the same conceptual shape adapted to three disciplines.

**Membership filter** (replaces v1's discipline filter): cross-training is identified by id-membership outside `wk.triWorkouts`, not by `discipline === undefined`. Per "anything in your plan is in your plan" — a planned cross/gym session in the tri plan engine no longer trips the detector.

**Files**: `src/calculations/tri-cross-training-overload.ts` (detector), `src/calculations/tri-discipline-floor.ts` (floor), `src/calculations/tri-cross-training-carry.ts` (carry decay), `src/ui/triathlon/tri-suggestion-modal.ts` (chip switcher + 4-button layout), `src/ui/home-view.ts` (carry banner). 44 unit tests across the three calc files.

---

## Triathlon cross-training overload detector — v1 (2026-04-30)

**Purpose.** When a triathlete logs cross-training (tennis, padel, racquet sports, gym work, anything outside swim/bike/run) that pushes the week's total TSS meaningfully over plan, surface a tri-aware suggestion to absorb the extra load. Mirrors the running-side `buildCrossTrainingPopup` intent but adapted to tri's three-discipline plan and TSS load currency.

**Formula.**
```
plannedTriTSS    = Σ (aerobic + anaerobic) over wk.triWorkouts
crossTrainingTSS = Σ iTrimp/150 over non-tri-discipline activities in
                   wk.adhocWorkouts ∪ wk.garminActuals (un-matched)
overshootPct     = crossTrainingTSS / plannedTriTSS
```

Trigger: `overshootPct > 0.15` → caution mod. `overshootPct > 0.25` → warning. Picks the next remaining quality session as target (`downgrade_today`) or longest endurance (`trim_volume`).

**Threshold rationale.** 15% is the smallest perturbation worth surfacing without nagging — below that, normal week-to-week variation already absorbs it. 25% aligns with the running-side suggester's "heavy" severity bracket (FCL ~25% of weekly run load). Both are pragmatic; not derived from literature. The detector intentionally does NOT propose to undo the cross-training itself (it's already in the past) — the only lever is reducing remaining planned load.

**Why it's defensible.**
- The TSS conversion (`iTrimp / 150`) uses the canonical normaliser already established for tri-side CTL (`tri-benchmarks-from-history.ts`) and every TSS display in the codebase. Same scale, same population mean (15 000 iTRIMP ≈ 100 TSS at LTHR).
- Source activities are filtered against tri disciplines via `Workout.discipline === 'swim'|'bike'|'run'` so a synced run that matches a tri run-leg slot does NOT double-count as cross-training.
- Severity threshold is symmetric with the running-side bracket so a user who switches modes doesn't experience a step-change in nag frequency.

**Known limitations.**
- Treats weekly TSS as a single pool. Cross-training stimulus isn't attributed to a specific discipline (e.g. padel ≠ pure aerobic credit; gym ≠ pure run credit). A future refinement could split the credit via `runSpec`/`bikeSpec`/`swimSpec` from `SPORTS_DB`.
- Doesn't read `s.triConfig.weeklyTSS_target` (no such field exists) — uses planned tri TSS as the implicit target. This means a week where the user has under-planned will trip the threshold faster, and a recovery week where the plan target is intentionally low will too. Acceptable for v1.
- The detector fires once per aggregator run; if the user dismisses, it'll re-fire on the next sync. No "snooze" mechanism. Mirrors the existing tri detectors (volume_ramp, rpe_blown, readiness).

**Code references.** `src/calculations/tri-cross-training-overload.ts` (detector), `src/calculations/tri-suggestion-aggregator.ts` (wired into `collectTriSuggestions`), `src/calculations/tri-cross-training-overload.test.ts` (11 unit tests pinning thresholds + attribution rules). Modal-routing wiring: see ARCHITECTURE.md → Cross-Training Engine → "Mode-aware modal routing" and ISSUE-151 (✅ FIXED) for the audit.

---

## Load currency invariant: iTRIMP must be normalised to TSS before mixing with sport multipliers (2026-04-30)

**Problem this codifies.** iTRIMP from `src/calculations/trimp.ts` is the seconds-weighted Banister integral `Σ Δt_sec × HRR × e^(β·HRR)`. A typical 1-hour session lands at iTRIMP ≈ 5000–10000. The rest of the load model (`baseLoad`, `fatigueCostLoad`, `runReplacementCredit`, `equivalentEasyKm`, severity buckets) is calibrated in TSS-equivalent units (1 hour at threshold = 100). Anywhere iTRIMP enters that downstream pipeline it must first be divided into TSS units.

**The canonical conversion**:
```
TSS_equivalent = iTrimp × 100 / 15000
```
i.e. divide iTRIMP by 150. This is the "athlete-default" form of the personalised athlete normaliser (see "Athlete Normalizer" section below) — 15000 is the population-mean iTRIMP for 1 hour at LTHR, calibrated against Coggan's hrTSS reference.

**Where this rule applies**:
- `src/cross-training/universalLoad.ts` — `computeTierAPlus` (entry point when iTrimp is supplied to the universal load engine).
- `src/calculations/tri-benchmarks-from-history.ts` — CTL / weekly TSS from history (already correct, see `tssFromActivity` at the bottom of that file and the regression test `iTRIMP is divided by 150 to produce TSS`).
- `src/calculations/activity-matcher.ts`, `src/ui/main-view.ts`, `src/ui/home-view.ts`, `src/ui/activity-detail.ts`, `src/ui/excess-load-card.ts`, etc. — all TSS displays use `iTrimp × 100 / 15000` directly.

**Failure mode if violated**. Skipping the normalisation produces values ~150× too large in the load currency. The downstream symptoms are subtle because the inflated number then runs through saturation curves, sport multipliers, and runSpec discounts, so it doesn't blow up arithmetically — it just permanently sits in the "extreme" severity bucket and slams `equivalentEasyKm` into its 25 km cap. This bug shipped in `computeTierAPlus` until 2026-04-30 (when an 89-min, 39-TSS tennis session was being shown as "≈ 25 km easy running equivalent · Very heavy training load"). The TSS *display* paths were unaffected — they used the right formula directly — which is why nothing felt obviously wrong in cards or charts.

**Why a population mean (15000) is fine here**. The athlete normaliser refines this to ±10–20% per individual, but the universal-load engine is computing planning-grade severity buckets (light / heavy / extreme). At that resolution the population mean is good enough; the personalised normaliser is only worth the complexity for CTL/ATL where percent-level error matters.

**Pre-existing precedent**. `tri-benchmarks-from-history.ts` learned this lesson once before — its line 638 (`return a.iTrimp / 150`) is paired with a regression test (`tri-benchmarks-from-history.test.ts:525`) explicitly named *"iTRIMP is divided by 150 to produce TSS — not the 2296+ we saw when iTRIMP was used raw"*. The lesson didn't propagate to `universalLoad.ts` until now. The regression test added with this fix (`Universal Load: iTRIMP scale invariant` in `universalLoad.test.ts`) closes the gap on the cross-training side.

---

## Triathlon — Live adaptation ratio (Phase 2A) (2026-04-28)

The horizon adjuster's projected gain is scaled by a **per-discipline `adaptation_ratio`** derived from up to five signals. Each signal yields a delta in its capped range; per-discipline weighted blend produces the ratio in `[0.70, 1.30]`.

**Architectural placement**: `tri-adaptation-ratio.ts` reads `state.physiologyHistory`, `wk.rated`, and `wk.garminActuals`; outputs `TriAdaptationRatios` consumed by `predictTriathlonRace` → `buildProjection` → `applyTriHorizon{Swim|Bike|Run}` as the `adaptation_ratio` argument (replacing the Phase 1 default of 1.0).

### Signals + sources

| Signal | Discipline(s) | Source | Confidence |
|---|---|---|---|
| HRV trend (7d vs 28d) | All | Plews D et al. (2013) "Training adaptation and HRV in elite endurance athletes" *Sports Med* 43:773–781 | High |
| RPE-vs-expected delta | Per discipline | Foster C et al. (2001) *J Strength Cond Res* 15:109–115; Borg G (1982) | Medium-high |
| HR-at-power drift | Bike | Coggan A & Allen H (2019) "Training and Racing with a Power Meter" 3rd ed. Ch. 9 | Medium |
| Pa:Hr decoupling | Bike + run | Friel "Triathlete's Training Bible" 4th ed. (2016); Maunder E et al. (2021) *Sports Med* 51:1387–1402 | Medium |
| CSS pace SD | Swim | Pyne D et al. (2001) — pace consistency at threshold | Low |

### Per-discipline weighted blend

```
swim ratio = 1.0
            + 0.30 × hrvAdjustment
            + 0.50 × rpeAdjustment[swim]
            + 0.20 × cssSdAdjustment

bike ratio = 1.0
            + 0.25 × hrvAdjustment
            + 0.30 × rpeAdjustment[bike]
            + 0.25 × hrAtPowerAdjustment
            + 0.20 × pahrAdjustment[bike]

run ratio  = 1.0
            + 0.25 × hrvAdjustment
            + 0.30 × rpeAdjustment[run]
            + 0.45 × pahrAdjustment[run]
```

Final ratio clamped to `[0.70, 1.30]` (HERITAGE family-study data, Bouchard 1999 *MSSE* 31:252–258, supports ~5× spread in individual VO2max trainability — roughly ±30% on expected gain).

### Per-signal sensitivity multipliers

```
hrvSensitivity      = 1.5   // 5% HRV trend → +7.5% ratio bump
rpeSensitivity      = 0.05  // 1-pt RPE delta → +5% ratio bump
hrPowerSensitivity  = 0.05  // 2 bpm/week drop → +10% ratio bump
pahrSensitivity     = 0.5   // 1 ppt/week reduction → +5% ratio bump
cssSdSensitivity    = 0.10  // 1 sec/100m/week SD reduction → +10% ratio bump
```

Each signal's adjustment is bounded by its own cap (HRV: ±0.10, RPE: ±0.15, HR-at-power: ±0.10, Pa:Hr: ±0.10, CSS-SD: ±0.05).

### Limitations

- HERITAGE-scale individual variance is real; the model captures only what training data can reveal in 4–8 weeks. New athletes have insufficient data → ratio defaults to 1.0.
- RPE delta assumes the planned RPE on each workout is correctly calibrated. If the plan over-estimates expected RPE, all athletes look like fast responders.
- HR-at-power requires a power meter and HR strap; without both, the bike signal degrades to neutral.
- Pa:Hr decoupling currently uses `hrDrift` (HR-only first-vs-second-half drift) as a proxy. True Pa:Hr requires per-km splits paired with HR splits — deferred until `kmSplits` carries HR per split.
- CSS pace SD weight is intentionally low because Pyne 2001 is suggestive, not regression-grade.

### Phase 2B (plan-side reactivity) status

Foundations shipped in this PR: skip handler (`tri-skip-handler.ts` — push to next week, drop on second skip), volume-ramp detector (`tri-volume-ramp.ts` — Gabbett 2016 5–10% rule per discipline), RPE-blown-session detector (`tri-rpe-flag.ts` — Foster 2001, +2 RPE delta). The suggestion modal UI, the readiness gate for tri, and the post-sync activity matching wiring are deferred to a follow-up.

---

## Triathlon — Live, volume-aware, course-aware race prediction (2026-04-28)

The triathlon race-time predictor was previously a snapshot of current fitness with a fixed ±10% range. It is now a *live, projected* race-day finish that mirrors the marathon `calculateLiveForecast` architecture per discipline. The headline number is what the athlete will do *on race day if they execute the plan*; a secondary "if you raced today" number lives below it.

The pipeline:

```
currentFitness (CSS, FTP, VDOT)
       │
       ▼
applyTriHorizon{Swim|Bike|Run}    ← projected race-day fitness
       │
       ▼
per-leg pace (CSS+5, FTP→speed via physics, VDOT→pace + §18.4 fatigue discount)
       │
       ▼
applyCourseFactors                 ← climate, altitude, run elevation, wind, swim type
       │
       ▼
applyDurabilityCap (run only)      ← long-ride / long-run thresholds
       │
       ▼
final race time + range + limitingFactor
```

### §F Per-discipline horizon model

The horizon adjuster is the same shape as marathon's `applyTrainingHorizonAdjustment`:

```
weekFactor    = 1 - exp(-weeks_eff / tau)             // saturating exponential
sessionFactor = 1 / (1 + exp(-k × (sessions - refSess)))  // logistic
expFactor     = bucketed by experience_level
improvement_pct = max_gain × weekFactor × sessionFactor × expFactor
                  - undertrain_penalty + taper_bonus - adherence_penalty
improvement_pct *= adaptation_ratio
improvement_pct  = clamp(-max_slowdown, +max_gain_cap)
```

The result is applied to the discipline's fitness marker in the right direction:
- CSS: `projCSS = currentCSS × (1 - improvement_pct/100)` (lower = faster)
- FTP: `projFTP = currentFTP × (1 + improvement_pct/100)`
- VDOT: delegates to the existing marathon function (`target_distance: 'marathon'` for IM, `'half'` for 70.3) and applies adherence + adaptation on top.

#### §F.1 Swim CSS horizon parameters

Sources:
- **Pyne, Trewin & Hopkins (2004)** *J Sports Sci* 22:613–620 — elite swimmers improve ~0.4–1.0%/yr at peak performance.
- **Costa M et al. (2010)** — longitudinal age-grouper data, ~3–6% over a season for sub-elite.
- **Mujika et al. (2002)** *MSSE* 34:1486–1493 — 2.2 ± 1.5% gain in 99 swimmers from a 3-week taper. **High confidence.**
- **Toussaint & Hollander (1994)** — propulsive efficiency explains ~80% of swim economy variance. Adult swim is technique-limited.
- **Sweetenham & Atkinson (2003)** "Championship Swim Training" — 8–12wk macro blocks for adaptation.
- **Maglischo (2003)** "Swimming Fastest" — coaching reference for session-frequency thresholds.

`max_gain_pct`: beginner 6.0, novice 4.5, intermediate 3.0, advanced 1.8, elite 0.9 (high at elite end, medium below).
`tau_weeks`: 10–12 (low confidence — calibrated to clinical experience).
`ref_sessions`: 3, 3, 4, 5, 6 (medium).
`undertrain_penalty_pct`: 3.0 per session/week below `min_sessions` (low — extrapolated; technique loss compounds).
`taper_bonus_pct`: 2.0–2.5 (Mujika 2002, **high confidence, n=99**).

**Limitations**: swim has the lowest ceiling of the three because adult swim adaptation is dominated by technique. The model treats it as a fitness ceiling, which is a defensible simplification but doesn't capture deliberate technique blocks.

#### §F.2 Bike FTP horizon parameters

Sources:
- **Coggan & Allen (2019)** "Training and Racing with a Power Meter" 3rd ed., Ch. 7 (FTP gain rates), Ch. 9 (HR-at-power adaptation signals).
- **Pinot & Grappe (2011)** — Record Power Profile, pro cyclists ~1–3%/yr at top end.
- **Lucia A et al. (2000)** — pro cyclist physiological adaptation.
- **Coyle (1991)** *Exerc Sport Sci Rev* 19:307–340.
- **Bouchard HERITAGE family study** — VO2max trainability variance for the beginner-end extrapolation.
- **Mujika & Padilla (2003)** *MSSE* 35:1182–1187 — 2–6% bike performance gain from optimised taper.
- **Bosquet L et al. (2007)** meta-analysis — 1.96% mean perf gain (CI 0.8–3.1%).

`max_gain_pct`: beginner 15.0, novice 10.0, intermediate 6.0, advanced 3.5, elite 1.5 (high at trained end; beginner figure HERITAGE-extrapolated, medium).
`tau_weeks`: 6–12 (medium).
`ref_sessions`: 3–5 (medium).
`undertrain_penalty_pct`: 2.0 (low — anchored to marathon analog; bike adapts faster than swim with frequency).
`taper_bonus_pct`: 2.5–3.0 (**high — Mujika & Padilla 2003 + Bosquet 2007**).

#### §F.3 Run horizon

Uses `RUN_HORIZON_PARAMS_703` / `RUN_HORIZON_PARAMS_IM` (in `triathlon-horizon-params.ts`) via `computeImprovementPct` — the same generic function used for swim and bike. `max_gain_pct` and `tau_weeks` mirror `TRAINING_HORIZON_PARAMS` half/marathon values (Daniels 2014) since run physiology is unchanged by context. `ref_sessions` and `min_sessions` are triathlon-calibrated:

| | 70.3 | IM |
|---|---|---|
| `ref_sessions` (intermediate) | 3.0 | 3.5 |
| `min_sessions` (intermediate) | 1.5 | 2.0 |

**Rationale for triathlon-specific session frequencies**: the marathon model uses `ref_sessions = 5.0` for intermediate runners (Daniels' optimal marathon training load). In a triathlon program, 3 runs/week is the standard recommendation (Friel 2012 "The Triathlete's Training Bible"; Dixon 2015 "Fast-Track Triathlete") because swim and bike volume provides concurrent aerobic stimulus, reducing the run frequency needed to drive VO2max adaptation (Laursen & Buchheit 2019). Using the marathon's `ref_sessions = 5.0` would treat a well-trained triathlete doing 3 runs/week as severely undertrained, suppressing a realistic 3–5% VDOT gain down to < 1%.

**Effect at intermediate, 3 runs/week, 18 weeks**: session_factor = 0.5 (at ref), week_factor ≈ 0.87 → base improvement ≈ 3.5%, plus taper ≈ 4.7% before adaptation. Projected VDOT gain ≈ +2 points for Tristan's VDOT 48 baseline, consistent with Midgley et al. (2006) 5–8% VO2max range over 8–16 week blocks.

**Confidence**: max_gain_pct and tau high (Daniels). Ref/min sessions medium — no controlled trial directly compares run frequencies in a concurrent triathlon context; figures are coaching consensus from Friel and Dixon.

Adherence penalty and adaptation ratio are applied inside `computeImprovementPct` (same path as swim/bike).

#### §F.4 Adaptation ratio (Phase 2 plan)

Phase 1 ships with `adaptation_ratio = 1.0` defaults. Phase 2 will wire live signals:
- **HRV trend (28d)** — Plews et al. (2013) — global ratio multiplier
- **HR-at-FTP%** — Coggan & Allen Ch. 9
- **Pa:Hr decoupling on tempo** — Friel; Maunder et al. (2021)
- **CSS-effort pace SD** — Pyne et al. (2001) (low confidence)
- **DFA-α1** — Rogers et al. (2021), emerging metric

### §G Course factors

All multipliers are applied to leg time *after* the per-discipline horizon projection. Compounded penalty is sanity-checked: a warning logs if total bike or run multiplier exceeds 1.25.

#### §G.1 Climate (run primary, bike secondary)

Sources:
- **Ely MR et al. (2007)** *MSSE* 39:487–493 — fastest marathons at 10–12°C; per-degree slowdown above.
- **El Helou N et al. (2012)** *PLoS ONE* 7:e37407 — 1.7M finishers across 6 marathons.
- **Maughan & Shirreffs (2010)** *Scand J Med Sci Sports* 20 Suppl 3:40–47.
- **Galloway & Maughan (1997)** — heat + humidity interaction.
- **ACSM Position Stand on Heat (2007)**.
- **Tatterson et al. (2000)** *J Sci Med Sport* 3:186–193 — ~6.5% bike power drop in 32°C vs 23°C TT; bike heat penalty ≈40% of run penalty due to convective cooling at 30+ km/h.

Mapping (anchor temp → run % → bike %):
- cool (12°C) → 0% → 0%
- temperate (18°C) → +1.5% → +0.6%
- warm (24°C) → +4% → +1.6%
- hot (30°C) → +8% → +3%
- hot-humid (30°C + RH > 70%) → +12% → +5%

**Limitations**: humidity is approximated by category, not WBGT. Acceptable for a v1 prediction; future work could ingest race-week forecasts directly.

#### §G.2 Altitude (run + bike, non-linear above 1500m)

Sources:
- **Bonetti & Hopkins (2009)** *Sports Med* 39:107–127 — meta-analysis.
- **Wehrlin & Hallen (2006)** *Eur J Appl Physiol* — ~6.3% VO2max drop per 1000m above 600m.
- **Peronnet F et al. (1991)** — altitude performance modelling.

```
altitudePenaltyRun(m)  = 0  if m < 500
                       = (m - 500) × 0.20% / 100m   for 500 ≤ m ≤ 1500
                       = 2.0 + (m - 1500) × 0.40% / 100m   for m > 1500   (capped at 12%)
altitudePenaltyBike(m) = altitudePenaltyRun(m) × 0.65   (capped at 8%)
```

Bike < run because IM bike intensity is sub-maximal aerobic; running has higher relative VO2 cost per unit of speed.

#### §G.3 Run elevation (Minetti 2002 polynomial)

Sources:
- **Minetti et al. (2002)** *J Appl Physiol* 93:1039–1046. Canonical polynomial for energy cost C(i):
  ```
  C(i) = 155.4·i⁵ - 30.4·i⁴ - 43.3·i³ + 46.3·i² + 19.5·i + 3.6   (J/kg/m)
  ```
- **Drake/Strava Engineering blog (2017)** — Strava's GAP algorithm is Minetti-derived.

`runElevationMultiplier(elevationM, distanceKm) = C(avgGrade) / C(0)` where `C(0) = 3.6`, `avgGrade = elevationM/(distanceKm × 1000)`, clamped to [-0.10, +0.10].

**Limitations**: average grade underestimates true cost on rolling courses (asymmetric eccentric cost on descents). Acceptable for v1; can be refined with per-km elevation data later.

#### §G.4 Wind exposure (bike only)

Source: **Martin JC et al. (1998)** *J Appl Biomech* 14:276–291 — physics model already used in `bike-physics.ts`. Treated as model-derived, low-medium confidence.

```
sheltered = 1.00, mixed = 1.02, exposed = 1.05
```

These match the existing `WIND_LOSS_FACTOR` for `flat`/`rolling`/`hilly`/`mountainous`. Field validation for IM bike splits is thin — document as physics-anchored.

#### §G.5 Swim type

Sources:
- **Toussaint HM et al. (1989)** *MSSE* 21:325–328 — wetsuit drag reduction ~14% at 1.25 m/s.
- **Cordain L & Kopriva R (1991)** *Sports Med* 11:336–348 — ~5% time benefit for non-elite.
- **de la Fuente Pacheco JG et al. (2020)** *Int J Sports Physiol Perform* 15:46–51 — 400m pool study, ~6% time reduction (~0.07 m/s).
- **Baldassarre R et al. (2017)** *Front Physiol* 8:294 — open-water vs pool review.
- **López-Belmonte Ó et al. (2024)** *Scand J Med Sci Sports* 34:e14702 — 1500m, n=14 elites; lower stroke length / index and higher stroke rate in OW vs pool, but no physiological differences and strong correlation in finish times.

```
pool                   = 1.00 (athlete-side; ≡ wetsuit-lake at race effort)
wetsuit-lake           = 1.00 (reference baseline)
non-wetsuit-lake       = 1.04 (+4% drag without wetsuit)
ocean                  = 1.05 (+5% chop; salinity buoyancy partially offsets)
ocean-current-assisted = 0.97 (−3%; e.g. Roth canal, favourable Kona years)
river                  = 1.00 (direction-dependent; neutral default)
```

**Pool coefficient = 1.00 (rationale).** A pool swim is faster than the equivalent open-water swim by ~5–10% (USMS coaching guidance, community data) — wall push-offs (3 per 100m in a 25m pool), no chop, no sighting, glide off each turn. A wetsuit makes an open-water swim ~5–6% faster than the same effort without one (Toussaint 1989, Cordain 1991, de la Fuente Pacheco 2020). The two effects approximately cancel: a pool swim ≈ a wetsuit-lake swim at equivalent effort. Pool = 1.00 is the "honest cancellation" choice — both effects are acknowledged but absorbed into the shared baseline rather than fabricating a pool-specific multiplier (per CLAUDE.md "no made-up numbers"). Confidence: medium. Could be wrong by a few percent in either direction depending on pool length (50m loses some wall benefit) and ocean conditions (heavy chop steepens the OW penalty).

**Two unions, one multiplier table.**
- `CourseProfile['swimType']` (race-side, 5 values): cannot be `pool` — you don't race in a pool.
- `AthleteSwimEnvironment` (per-activity training tag, 5 values): cannot be `ocean-current-assisted` — that's a race-only condition, not a training baseline.
- Shared `SWIM_TYPE_MULTIPLIER` covers all 6 keys.

**Athlete-side normalisation** (added 2026-05-09). Each swim's pace is divided by `SWIM_TYPE_MULTIPLIER[swimEnvironment]` to yield a wetsuit-lake-equivalent pace before pooling into CSS. Race-side then re-applies the course factor for the actual race environment. This avoids the previous double-count where a pool-trained CSS was treated as already-in-wetsuit-lake conditions and then penalised again for ocean chop. Pool swims auto-tag from `activityType` (`SWIMMING` / `LAP_SWIMMING`); OW swims fall back to `triConfig.swim.defaultOwSwimEnvironment` (set once via the reveal modal). When no tag and no default exist, the multiplier is 1.0 — safe fallback that doesn't fabricate a number.

**Limitations**: river swims and ocean conditions vary year to year. The neutral defaults are deliberately conservative. Saltwater/freshwater buoyancy is bundled into the ocean-vs-lake split rather than modelled as a separate axis (~2.5% body-mass buoyancy difference exists but lacks rigorous performance literature for trained swimmers). Pool length (25m vs 50m) is not differentiated in the multiplier; 50m pools lose some of the wall-push-off benefit but the user's `poolLengthM` field could be used in v2 to refine.

### §H Run-leg durability cap (the new triathlon-specific piece)

Capacity markers (CSS, FTP, VDOT) describe single-bout capacity. The IM run requires holding sub-LT pace for 3+ hours after 5+ hours of cumulative work. An athlete with strong markers but no recent long sessions will crack on race day. The fixed 11% IM / 5% 70.3 fatigue discount is an *average*; durability-deficient athletes cluster well below it.

Sources (suggestive, not specific enough for closed-form mapping — **confidence: low**):
- **Coyle (1988)** *Exerc Sport Sci Rev* — endurance specificity.
- **Joyner & Coyle (2008)** *J Physiol* — endurance performance physiology.
- **Rüst et al. (2012)** *J Strength Cond Res* — IM marathon time correlates with longest training run + weekly volume in build (r ≈ 0.55–0.70).
- **Friel "Triathlete's Training Bible"** — build-phase specificity guidelines.

Thresholds (12-week look-back window):
- IM:   long ride ≥ 4.5 h, long run ≥ 2.0 h
- 70.3: long ride ≥ 2.5 h, long run ≥ 1.5 h

Penalty: 0% if both met. Each missed threshold contributes up to half of `MAX_DURABILITY_PENALTY = 5%`. Linear interpolation between threshold and 50% of threshold; below 50% the penalty is fully applied.

The model also surfaces a `limitingFactor` to the UI: `'long_ride_volume'`, `'long_run_volume'`, or `'volume_durability'` so the user knows *why* their predicted run leg is capped.

**Limitations**: literature does not justify a larger penalty than +5%. Do not increase the cap without new evidence. The model is a heuristic, not a regression.

### §I Confidence range

```
baseRange = 0.10 (IM) | 0.08 (70.3)
range += min(0.04, weeksRemaining/24 × 0.04)   // far-out predictions widen
range += novice or veteran adjustment (±0.02)
range = clamp(min, max)
```

Min/max bounds: IM `[0.06, 0.16]`, 70.3 `[0.05, 0.14]`.

The horizon model's `weekFactor` saturates as race day approaches, so a far-out projection is *more* uncertain (more horizon to unfold). Years of training adjusts confidence in either direction:
- < 2 yrs → +2% (novice has more variance, per Joyner & Coyle 2008)
- ≥ 5 yrs → −2% (veteran predictions are more reliable)

### §J Bike-to-run fatigue discount validation (existing 11% IM / 5% 70.3)

Sources confirming the existing values:
- **Vleck et al. (2008)** *J Sports Sci* — elite ITU triathlon performance.
- **Bentley et al. (2002)** *Sports Med* — "Specific aspects of contemporary triathlon".
- **Laursen et al. (2007)** — IM pacing.
- **Bentley (2007)** — 4–7% slower than open half-marathon for 70.3.
- **Landers (2008)** — 8–13% slower than open marathon for IM.

The current values (11% IM, 5% 70.3) sit at the mid-range of published data. Kept as the floor; the durability cap can only widen, not narrow. **Confidence: high.**

### §K Single-discipline cycling event finish-time prediction (2026-05-04)

**File**: `src/calculations/race-prediction.cycling.ts`

**Model**: Gran Fondo / sportive finish time from FTP × intensity factor, solved through the Martin et al. 1998 bike physics engine (`bike-physics.ts:solveSpeed`).

**Intensity factor table** (Allen & Coggan, *Training and Racing with a Power Meter*, 2010 — power-duration zones):

| Distance | Duration estimate | Zone     | IF   |
|----------|-------------------|----------|------|
| 50 km    | 1.5–2 h           | Sweet spot | 0.88 |
| 100 km   | 3–4 h             | Tempo      | 0.80 |
| 160 km   | 4.5–6 h           | End-tempo  | 0.74 |
| 200 km   | 6–8 h             | Endurance  | 0.68 |
| 300 km   | 9–12 h            | Ultra      | 0.62 |

These IFs are higher than the triathlon bike-leg IFs (`RACE_INTENSITY_BY_DISTANCE`: 0.78 for 70.3, 0.70 for IM) because cycling events are single-discipline — no pre-swim fatigue, no pacing reserve needed for a run leg.

**Physics path**: when an aero profile + body weight + bike weight are set, `solveSpeed` finds the equilibrium speed at `raceWatts = FTP × IF` solving `P = (CdA × ρ/2 × v² + Crr × m × g) × v + m × g × sin(θ) × v`. No iteration is needed here because the IF is distance-keyed (not duration-keyed), so there is no circularity.

**Fallback path** (no aero profile): linear `kph = 20 + (watts − 100) × 0.067`, clamped 18–48 kph, with coarse gradient penalty (flat: 0, rolling: −1.5, hilly: −3.5, mountainous: −6.0 kph). Same coefficients as the triathlon predictor's no-aero path.

**Confidence range**: ±10% > 4 weeks out, ±6% within 4 weeks. Gran Fondo pacing is less predictable than triathlon bike legs (group dynamics, feed-zone strategy, variable parcours) — bands are intentionally conservative.

**Known limitations**: IF assumes solo pacing at even power; drafting in a large sportive can significantly lower the required power. The model is an FTP-fraction estimate, not a validated GF-specific model. No elevation integration (course profile is categorical, not a gradient profile).

**Confidence: medium** — physics engine is well-validated; IF constants are from authoritative source; fallback linear path is a rough approximation only.

---

### §L MusculoTendon Load (MTL) — HYROX eccentric strain model (2026-05-04)

**File**: `src/calculations/mtl.ts`, `src/constants/hyrox-constants.ts`

**Problem**: aerobic TSS and impact load are insufficient for HYROX because station work (sleds, lunges, wall balls) produces significant eccentric/mechanical stress that does not scale with heart rate or run mileage. A third load currency is needed.

**Model**:

```
rawComponentMTL = durationMin × sRPE × modalityFactor × impactFactor × (1 + externalLoadFactor)
effectiveMTL    = cap × (1 − exp(−rawMTL / cap))
```

Where:
- `sRPE` = session RPE (1–10) for this component — same method as Foster et al. 2001 session RPE.
- `modalityFactor` = eccentric + mechanical loading multiplier relative to baseline IL. Ergs: 0.5; sled/farmer carry: 1.0–1.2; plyometrics (burpee BJ): 1.3. From Verkhoshansky & Siff 2009 on eccentric loading taxonomy.
- `impactFactor` = ground-impact amplification. Ergs: 0.7 (minimal footstrike); sled push/pull/carry: 1.0; burpee BJ/sandbag lunges: 1.0–1.3. From Clarkson & Hubal 2002 on DOMS and eccentric exercise.
- `externalLoadFactor = min(0.6, externalLoadKg / bodyWeightKg × 0.5)`. Caps at 0.6 (60% amplification) — conservative linear fit for external-to-body-weight ratio. Clamped because above bodyweight loads (e.g. heavy farmer carry) have diminishing marginal MTL per unit of extra load.
- `cap` = per-band weekly MTL ceiling from `HYROX_MTL_CAP`. **Initial estimates pending real-training validation.**

**Saturation curve rationale**: The one-minus-exponential form prevents linearly accumulating MTL at extreme loads. Real tissue tolerance asymptotes as load approaches and exceeds the individual's current capacity — analogous to the Banister impulse-response saturation used in some CTL models (Busso 2003, *Med Sci Sports Exerc* 35(7)). The saturation constant is set equal to `cap` so the 63% saturation point aligns with the per-band ceiling.

**Station MTL factors** (from research doc §3.3):

| Station           | modalityFactor | impactFactor |
|-------------------|---------------|-------------|
| SkiErg            | 0.5           | 0.7         |
| Sled push         | 1.2           | 1.0         |
| Sled pull         | 1.2           | 1.0         |
| Burpee broad jump | 1.3           | 1.3         |
| Row erg           | 0.5           | 0.7         |
| Farmer carry      | 1.0           | 1.0         |
| Sandbag lunges    | 1.1           | 1.0         |
| Wall balls        | 1.1           | 1.0         |

**Run intensity factors**:
| Intensity   | modalityFactor | impactFactor |
|-------------|---------------|-------------|
| Easy        | 0.6           | 1.0         |
| Tempo       | 0.8           | 1.0         |
| Intervals   | 1.0           | 1.0         |

**MTL caps** (initial estimates — pending real-training validation; to be refined after dogfooding):

| Band           | Weekly MTL cap |
|----------------|---------------|
| Total beginner | 500           |
| Beginner       | 700           |
| Novice         | 1 000         |
| Intermediate   | 1 300         |
| Advanced       | 1 600         |
| Competitive    | 2 000         |

Cap derivation: rough scaling from the training-load literature on eccentric/mechanical stress tolerance across experience levels (Damas et al. 2016, *Eur J Appl Physiol* 116(5); Schoenfeld 2010, *J Strength Cond Res* 24(12)). Not empirically validated against HYROX athlete data.

**Known limitations**:
1. MTL factors for each station are ordinal estimates, not calibrated from actual athlete data. All HYROX-specific constants need real-training validation.
2. External load factor uses a linear approximation; actual load-response relationship may be non-linear (especially at very high loads).
3. The MTL cap table is not yet evidence-based — it will be tuned after dogfooding with actual HYROX training sessions.
4. No time-decay model for MTL yet (Phase 3 will add MTL CTL/ATL EMA analogous to aerobic CTL).

**Confidence: low (model structure) / none (constants)** — model structure is physiologically grounded but constants are initial estimates pending validation.

---

### §L2 HYROX run-leg fatigue model (2026-05-05)

**File**: `src/calculations/race-prediction.hyrox.ts`

**Problem**: a flat 8 × base pace predicts HYROX run splits incorrectly. Race data (HyroxDataLab finishing-time distributions) shows a clear within-race fatigue gradient: Run 1 is ~5% faster than average; Runs 7–8 are 5–8% slower, driven by cumulative eccentric + metabolic fatigue from completed stations.

**Model**:
```
rawMultiplier(legIndex) = 1 + legIndex × PER_STATION_FATIGUE_RATE
PER_STATION_FATIGUE_RATE = 0.008   // 0.8% per station completed
normMultiplier(i) = rawMultiplier(i) / mean(rawMultiplier, 0..7)
legPace(i) = basePace × venueMultiplier × normMultiplier(i)
```

`legIndex = 0` = Run 1 (no stations yet); `legIndex = 7` = Run 8 (after 7 stations completed).

**Why normalise**: the raw multipliers sum to 8 × avgMult, not 8 × 1. Dividing by avgMult restores the energy-conservation constraint: total 8-run duration equals 8 × basePace × venueMultiplier. The normalisation is a mathematical identity — it does not change the predicted total, only the per-leg distribution.

**Rationale for 0.8%/station**: Goss et al. 2021 (*Int J Sports Physiol Perform* 16(3)) found run-economy declined by 3–8% over repeated high-intensity bouts with eccentric loading in resistance-trained athletes. A 0.8% per-station rate implies 6.4% total degradation over 7 completed stations (Run 8 is 6.4% slower than Run 1, before normalisation). This sits in the lower half of the Goss range, reflecting that HYROX athletes are specifically trained for this format. HyroxDataLab's published average run-pace progressions (Open men average, 2023) show a ~1.4s/km per station, consistent with 0.8% for a ~3:00/km base pace.

**Known limitations**:
1. Linear model — actual fatigue may accelerate non-linearly at higher station loads (wall balls → lunges stack produces more fatigue than two ergometer stations).
2. No individual station MTL weighting — all 8 stations are treated equally. Phase 2 could weight by station MTL factor.
3. Normalisation preserves energy at the mean but not at extreme athlete bands (very fast athletes have a different physiological trajectory).
4. PER_STATION_FATIGUE_RATE is a single constant across all ability bands. Competitive athletes likely show less degradation (better eccentric tolerance, higher training specificity).

**Confidence: medium-low** — rate is consistent with published literature but not calibrated against HYROX-specific population data.

---

## Cycling and swimming commentary metrics (2026-04-28)

**Purpose.** Coach's Notes for non-running activities now use sport-canonical metrics rather than the silent fall-through that previously rendered nothing for cycling and swimming.

**Cycling — Intensity Factor (IF).** `IF = NP / FTP`. Source: Coggan & Allen, *Training and Racing with a Power Meter*. Bands used in `composeCyclingInsight`:
- IF < 0.65 — recovery / easy spin
- 0.65 ≤ IF < 0.80 — endurance
- 0.80 ≤ IF < 0.94 — tempo
- 0.94 ≤ IF < 1.05 — threshold
- IF ≥ 1.05 — anaerobic / VO2

**Cycling — bTSS estimate.** `bTSS = (durationSec × NP × IF) / (FTP × 3600) × 100`. Same Coggan formulation as `BIKE_TSS_INTENSITY_EXPONENT = 2` already used elsewhere in the codebase for planning-side bike load. Reported here as a description of the ride that just happened, not as the canonical bTSS feeding the fitness model.

**Cycling — Variability Index (VI).** `VI = NP / avgWatts`. Bands:
- VI < 1.05 — very steady (TT-like)
- 1.05 ≤ VI < 1.10 — rolling
- 1.10 ≤ VI < 1.20 — punchy / variable
- VI ≥ 1.20 — highly variable with frequent surges

VI describes the *shape* of the ride, not its intensity. Two rides at the same IF can have very different VIs (steady tempo vs interval session). Useful colour for the rider but not load-bearing for any downstream calculation.

**Swimming — pace per 100m vs CSS.** `pacePer100m = (durationSec / distanceM) × 100`. Compared against `state.onboarding.triSwim.cssSecPer100m` (Critical Swim Speed). Bands:
- delta < -3 s/100m — sub-threshold (faster than CSS)
- -3 ≤ delta < +5 s/100m — threshold
- +5 ≤ delta < +12 s/100m — endurance / aerobic
- delta ≥ +12 s/100m — easy / recovery

CSS is the swim equivalent of running threshold pace; bands above are pragmatic and consistent with how CSS is used elsewhere in this codebase. No literature claim of precise sub-band labels — the cut-points are interpretive shorthand for the swimmer.

**Limitations.**
- IF / VI / bTSS require a power meter. Without one, the cycling composer falls back to HR-effort framing or a single descriptive sentence.
- Swim CSS is set in onboarding or derived from PBs; if neither is present the composer reports raw pace/100m only.
- HR-zone surface for swims is gated on an HR-capable strap being worn — most pool swims aren't recorded with HR, and the file's heuristic skips the line when zones are absent.

---

## IRONMAN course profile schema (2026-04-28)

**Purpose.** Per-leg published facts about each IRONMAN-branded race, attached to every `Triathlon` row. Consumed by the race-prediction agent (separate, not in this commit) to produce per-leg time deltas vs an IM-typical course. We deliberately store **only sourced facts here**, no derived multipliers — the prediction model owns the translation from facts → minutes.

**Schema** (`src/types/onboarding.ts:CourseProfile`):

| Field | Type | Source | What the prediction engine should do with it |
|---|---|---|---|
| `bikeElevationM` | number (m) | Athlete guide / Strava segments | Primary input for bike-time penalty. Established models (analyticcycling, BikeCalculator) suggest ~3–5 sec per 100m of climb at ~250 W on rolling terrain. |
| `runElevationM` | number (m) | Athlete guide | Run-time penalty: roughly 30–60 sec/km of climb at IM pace per Minetti's energy-cost-of-grade work. |
| `bikeProfile` | flat / rolling / hilly / mountainous | Derived from elevation by fixed cutoffs (see below) | Categorical fallback when no power meter or detailed bike model is available. |
| `runProfile` | flat / rolling / hilly | Derived from elevation by fixed cutoffs | Same — categorical fallback. |
| `swimType` | wetsuit-lake / non-wetsuit-lake / ocean / ocean-current-assisted / river | Athlete guide + historical water-temp records | Wetsuit-legal lake: baseline. Ocean: +1–3% (chop, sighting). Current-assisted (Cozumel, Jacksonville, California, Augusta): –10–25% based on observed historical splits. Non-wetsuit lake: +5–8%. |
| `climate` | cool / temperate / warm / hot / hot-humid | Race-day historical weather (avg high + humidity at venue) | Heat penalty applies primarily to the run. Maughan & Shirreffs and ACSM heat-stress guidelines suggest 1–4% pace penalty per °C above 22°C, exacerbated by humidity (wet-bulb globe temperature). |
| `altitudeM` | number (m) | Venue elevation | At elevations >~1000m, VO2max drops ~7–9% per 1000m above sea level. Affects all three legs but bike (sustained aerobic) most. Lake Placid (570m), Klagenfurt (440m), Vitoria (540m), Boise (820m) sit in the marginal zone; Ruidoso 70.3 (2070m) is the only outlier where the effect is large. |
| `windExposure` | sheltered / mixed / exposed | Slowtwitch + race writeups | Bike split sensitivity. Exposed courses (Kona, Lanzarote, Busselton, Cozumel) regularly produce 10–15 min IM bike-split swings between calm and windy years, independent of elevation. |
| `notes` | free-form string | Combined sources | One-line human-readable summary surfaced in the wizard race-picker. |

**Categorisation rules** (applied consistently when populating from raw elevation):

- bikeProfile (full IM cutoffs; halve for 70.3): flat <500m, rolling 500–1200m, hilly 1200–2000m, mountainous >2000m.
- runProfile (full marathon cutoffs; halve for 70.3): flat <100m, rolling 100–300m, hilly >300m.

**Data sourcing.** Populated for all 79 IRONMAN-branded races on the 2026 calendar from official Ironman.com athlete guides, Slowtwitch course writeups, and individual race-website course descriptions. A small number of brand-new or low-coverage races (Penghu, Subic Bay, Tours, Canada-Ottawa, Leeds, Gurye, San Juan, Valdivia) have only the swim/climate fields populated — the rest stay undefined, per the no-made-up-numbers rule. Annual refresh expected as Ironman publishes new athlete guides.

**Limitations.**
- Single number per leg cannot represent the *shape* of the elevation profile (one big climb vs many short rollers cost different amounts of time at the same total gain). The prediction engine should treat elevation as a coarse signal only.
- Climate is a typical-year category, not a race-day forecast. The prediction engine should optionally take a forecast input on top of this.
- No drafting/age-group field-density modelling — relevant for elite athletes only.
- `windExposure` is binary-ish (sheltered/mixed/exposed); real wind effect is heading-dependent and stochastic year-to-year.

**Why this lives separate from `WORLD_TRIATHLONS`.** Race calendar metadata (dates, locations) refreshes annually with new schedules. Course profile facts refresh slower (only when a course changes route). Keeping them in different files lets each rotate on its own cadence.

---

## Onboarding fallbacks for missing personal data (2026-04-27)

**Purpose.** The triathlon About-you card collects age, bodyweight, and sex but lets users skip every field. Downstream models still need values — max-HR estimates need age, FTP→W/kg tier needs weight, iTRIMP β needs sex. This entry records the fallbacks and why they're defensible.

**Sex → iTRIMP β coefficient.** The Banister iTRIMP integral uses a sex-specific exponential weighting: β = 1.92 (male), β = 1.67 (female). Source: Banister 1991, Morton et al. 1990. The weighting reflects the steeper rise in lactate-vs-HR curve seen in trained males relative to trained females, which makes a high-HR minute count for more in male iTRIMP. The picker offers Male / Female / Other; selecting Other internally maps to the male coefficient. Rationale: the male β yields a more aggressive load count, so it's the conservative choice when sex is undeclared (over-counting load is safer than under-counting it for injury and overtraining detection).

**Bodyweight skipped → sex-based default.** When bodyweight is unset:
- Male / Other → **75 kg**
- Female → **62 kg**

These are rough WHO global adult averages (WHO Global Health Observatory; range 60–80 kg M, 50–70 kg F across regions, midpoints chosen for midrange Western populations). They're imprecise but bounded; the FTP→W/kg cycling tier uses these defaults only to place the athlete on the Coggan ladder, where one tier-step maps to roughly ±10 kg of misestimate at typical age-grouper FTPs (~250 W). The downside risk is one-tier-off — survivable, with the user able to enter their actual weight at any time.

**Age skipped → no max-HR estimate.** Age is only used today by `sport-picker-modal.ts` for the *fallback* max HR (`220 − age`). When age is missing and no measured `maxHR` is on file, the modal omits the estimate rather than using a guessed default. This is the right behaviour: a guessed max HR contaminates HR-derived load. Better to display "—" and prompt the user to set it.

**Limitations.**
- `220 − age` itself is an approximation with a standard error of ±10–12 bpm (Tanaka 2001 proposed `208 − 0.7×age` as more accurate). Both formulas remain population-level estimates; field testing or measured peaks during a race remain the gold standard.
- The 75/62 kg split is a population mean. Athletes in our user base skew lower than Western population means (endurance triathletes typical 60–80 kg M, 50–65 kg F). The default is therefore conservatively heavy, biasing W/kg slightly *down*. We accept this rather than carry a separate "endurance population" prior, which would be data-snooping our own user base.
- "Other" inherits male defaults. This is operationally pragmatic — physiology cannot be inferred from gender identity — and the user can always override the iTRIMP β by directly editing `state.biologicalSex`. A future refinement would let the user provide measured resting HR and HRV directly so β becomes irrelevant.

---

## Tanda Garbage Filter (2026-04-27)

**Purpose.** Tanda 2011 was calibrated against 46 manually-curated training logs. Mosaic feeds Tanda from auto-imported Strava/Garmin activity feeds, which are not curated — they contain treadmill runs (no GPS, accelerometer-estimated pace that drifts), walks logged inside runs, mid-session walk breaks logged as separate activities, aborted runs, and warm-down jogs without GPS. All of these inflate P (Tanda's mean training pace) without representing real training stimulus. The result is a slow-biased predicted marathon time that under-rates the athlete.

**Filters added** (in `src/calculations/prediction-inputs.ts`, ahead of K/P computation):

| Filter | Threshold | Rationale |
|---|---|---|
| Distance floor | `distKm < 3` rejected | Sub-3K activities are warm-ups, run-walk intervals, or technique drills, not training runs Tanda would score. Tightened from the previous 2 km floor — 2-3 km Strava entries are dominated by walk-break artefacts. |
| Pace ceiling | `paceSecPerKm > 480` (8:00/km) rejected | Above 8:00/km is walking or trail hiking. Existing 7:30 ceiling let too many treadmill warm-downs through. |
| Name pattern | `/treadmill|walk/i` rejected | Treadmill GPS-less paces are accelerometer estimates that drift, especially at incline. "Walk" names slip past the pace ceiling whenever the user kept moving briskly. |
| Slow-tail trim | Drop slowest 10% of remaining sample | After hard filters, the slow tail is dominated by aborted runs and untracked warm-downs. A 10% trim is a conservative noise filter that preserves real training pace dispersion. Gated to samples ≥5 runs so sparse logs aren't decimated. |

**Why these are pragmatic, not literature-derived.** Tanda's paper does not specify activity-feed ingestion rules — the cohort's logs were already clean. The thresholds above are empirical noise filters chosen to remove obvious non-training data while preserving every plausible training run. They are documented here so a future change has a record of *why* the bands are what they are, not because Tanda or any other paper prescribes them.

**Limitations.**
- The 10% trim discards information uniformly. A runner whose actual easy-pace floor sits in the 7:30–8:00/km band will see legitimate easy runs trimmed alongside walk breaks. Mitigation: the trim only fires at sample ≥ 5 and removes a single floor(0.1·n) tail entry — a 5-run sample drops 0, a 10-run sample drops 1.
- Name pattern is heuristic. "Treadmill tempo" is rejected even if the pace is accurate; "Trail walk-run" is rejected even if it logged a real long run. Acceptable because the false-reject cost (one excluded run) is low and the false-accept cost (drift-paced runs poisoning P for 8 weeks) is high.
- Distance floor of 3 km will reject genuine recovery runs at low-volume tier. This matches Tanda's own intent — Tanda's K already accounts for volume; P should reflect the pace of *training* runs, not the pace of cool-down jogs.

---

## Lactate Threshold Derivation (2026-04-24)

**Purpose.** Derive LT pace and LTHR from available inputs when Garmin's watch-side reading is missing, stale, or gated by development credentials. Covers the case where the Garmin webhook sends VO2 Max but no `lactateThresholdSpeed` / `lactateThresholdHeartRate`. User override wins wholesale when present.

**Threshold target.** LT2 (MLSS / maximal metabolic steady state). This is the "lactate threshold" in common usage — the highest pace sustainable for ~60 min — not LT1 / AeT. Garmin's own `lactateThresholdSpeed` maps to LT2.

### Three estimators, blended

**Method 1 — Daniels T-pace from VDOT.** Invert Daniels' VO2 cost-of-running equation to find vVO2max velocity, then scale to T-intensity.

```
VO2(v) = −4.60 + 0.182258·v + 0.000104·v²   (v = velocity, m/min; VO2 = ml/min/kg)
```

Solve for v at VO2 = VDOT (positive root of the quadratic). T-pace = vVO2max / 0.88 (sec/km, slower pace has higher sec/km).

- Source: Daniels' Running Formula (3rd ed.), Daniels & Gilbert 1979.
- The 0.88 fraction is Daniels' empirical T-intensity = 88% of vVO2max.
- Falls back to null when VDOT < 25 (pre-aerobic-base athletes — formula diverges).
- Known limit: Daniels' published table T-paces land ~10s/km faster than this derivation because the table maps closer to a ~40-min effort than a true 60-min LT. Our derivation is anchored to MLSS, so it lands closer to half-marathon pace for trained runners — which aligns with the literature definition of LT2.

**VDOT input priority for the Daniels path.** Daniels' formula assumes the input represents physiological aerobic capacity. The full priority chain is implemented in `src/calculations/physiological-vdot.ts → getPhysiologicalVdot()`, which is the **single source of truth** for "what's the best available estimate of this athlete's aerobic capacity right now?" — used by the LT engine, the VO2 stats card, and the onboarding fitness row so all three surfaces report the same number with the same provenance.

The chain walks from most-direct to least-direct measurement:

1. **`s.vo2`** — device-direct VO2max (Garmin / Apple), when within a 90-day freshness window. Continuous HR-variability + pace monitoring with proprietary algorithm (FirstBeat). Highest fidelity when present and recent. Beyond 90 days the value falls through (a year-old reading shouldn't pin physiology if newer derived signal contradicts it).
2. **`s.hrCalibratedVdot.vdot`** (medium+ confidence only) — pace-vs-%HRR regression across recent qualifying runs (Swain & Leutholtz 1997, %HRR ≈ %VO2R). Direct observation of physiology, just less continuous than the watch. Low-confidence fits are skipped because a noisy regression can move LT 20+ sec/km on edge cases.
3. **`deriveVdotFromLT(s.lt)`** — back-derived from the resolved LT pace via Daniels' inverted vVO2max formula. Only fires when `s.ltSource ∈ {empirical, critical-speed, garmin, override}`. Skipped when LT itself was Daniels-derived or blended with Daniels content (would be circular).
4. **PB-derived median VDOT** — median of Daniels' `cv()` across the user's race-distance PBs (5K / 10K / HM / marathon). Median rather than max because PB profiles are often imbalanced — a 5K specialist with weak endurance shouldn't have their 5K alone drive the estimate, and a marathoner with a slow 5K shouldn't lose theirs to it.
5. **`s.v`** — Tanda-blended VDOT, last resort. **Tanda is the right model for race-time prediction** (it regresses race time on weekly km and average pace, validated against marathon outcomes), but its volume-discount means a triathlete cutting back on running gets a Tanda-VDOT that under-states their physiological capacity. Daniels' T-pace formula expects a capacity number, not a volume-discounted prediction. We fall through to it only when the four more-direct sources are all unavailable.

`getPhysiologicalVdot` deliberately does **not** include `rpeAdj` or `physioAdj` — those are user-tuned dials answering "how I feel today" / "my LT drifted vs my VDOT" and belong in `getEffectiveVdot(s)` (used for race-time prediction and training-pace prescription). Physiology doesn't shift when the user clicks an RPE dial. This priority is intentional and orthogonal to where `s.v` is used elsewhere (race-time prediction, training pace zones — both still use Tanda-blended, correctly).

**Method 2 — Critical Speed from race-distance PBs.** Two-parameter hyperbolic model:

```
d = CS · t + D′
```

Where `d` = distance (m), `t` = time (s), `CS` = critical speed (m/s), `D′` = anaerobic distance capacity (m). Ordinary least-squares fit across the athlete's best efforts at different distances.

Nixon et al. 2021 (PMC8505327) demonstrated that CS sits ~8% above MLSS in well-trained runners (CS 16.4 ± 1.3 km/h vs MLSS 15.2 ± 0.9 km/h). We therefore set:

```
LT_pace = 0.93 × CS        (LT pace as a fraction of CS pace, converted to sec/km)
```

- Source: Jones & Vanhatalo 2017 (critical power framework); Nixon et al. 2021 (CS↔MLSS offset).
- Fit constraints: ≥2 efforts, duration span ≥600s, each effort 2–60 min (excludes sprints dominated by anaerobic capacity and long races affected by fuelling), efforts ≤365 days old, D′ must fall in 50–500 m (physiological plausibility, Jones & Vanhatalo 2017).
- Known limit: 2-parameter model assumes infinite speed as t→0 and that D′ is fully depleted at exhaustion — both simplifications. More accurate 3-parameter models exist but require additional efforts we rarely have.

**Method 3 — Empirical detection from sustained efforts.** Scan runs in the last 120 days for ones exhibiting LT steady-state behaviour:

```
20 min ≤ duration ≤ 120 min     (extended cap; standard cutoff at 60 min)
avgHR ∈ [0.85·HRmax, 0.92·HRmax]
joint steady-state gate (see below — graded by duration)
NOT treadmill / virtual
NOT hot (>28°C)
NOT hilly (elevation gain > 15 m/km)
```

Take the time-decayed weighted mean of qualifying `{pace, HR}` pairs with decay constant τ = 21 days.

**Joint steady-state gate.** Pace CV (variability across kmSplits) and HR drift (percentage HR rise from first half to second half, warmup-stripped, computed at sync time from the full HR stream) are independent observations of the same question — was this run steady-state? They can disagree. A tempo at the limit can hold steady pace with drifting HR (the runner was working near threshold and HR climbed). A long Z2 run on a hilly trail can hold steady HR with variable pace (effort consistent, terrain forced pace changes). Both are usable LT signals.

The gate is graded by duration:

- **Short tempos (20–60 min):** at least one signal must fire. `paceCV ≤ 8%` OR `|hrDrift| ≤ 5%`. The calibrating real-world case: a 41-min tempo at 4:05/km with `paceCV 2.5%` and `hrDrift 8.9%` is the textbook threshold effort and must qualify. Drift alone in this duration range usually reflects deliberate effort progression, not cardiac decoupling — the original Friel 5%-drift gate is a research-grade aerobic-durability test and is too strict as the sole steady-state filter for everyday tempo detection.
- **Long runs (60–120 min):** both signals required. `paceCV ≤ 8%` AND `|hrDrift| ≤ 5%`. Cardiac-drift confounds (glycogen, dehydration, heat) grow with duration; one clean signal alone can be a fatigue-induced HR elevation masquerading as threshold (steady HR but slow pace) or a variable-pace long aerobic with HR happening to land in band (steady pace but… actually it doesn't, that's the point — long aerobic runs rarely have pace CV ≤ 8% across hours of running).
- **> 120 min:** rejected regardless. Even with both signals clean, fueling effects on pace dominate the LT signal at ultra durations.

- Source: Faude et al. 2009 (LT2 = "fastest pace sustainable for ~30–60 min"); Friel 2012 (aerobic decoupling < 5% as steady-state proxy — used here for the *long-run* gate where drift dominates, relaxed for short tempos); Uphill Athlete heart-rate drift test; Poole et al. (LT2 HR band 85–92% HRmax for trained runners); Coyle 1984 / Hagberg & Coyle 1983 (cardiac drift on extended runs).
- **Decoupling source.** Preferred signal is `hrDrift`; falls back to a pace-drift proxy from `kmSplits` (first-half vs second-half) when `hrDrift` is missing (e.g. older synced rows that pre-date the column, or onboarding-stage runs that only carry aggregates).
- τ = 21 days gives ~50% weight to 3-week-old efforts. Matches the ~3-week adaptation time-constant of aerobic fitness.
- Outlier rejection is deliberately strict at the *long-run* end. A false positive there (e.g. drift-inflated long aerobic) gets weighted into the final blend at full weight; better to under-include than to over-include from the long-run pool. At the short-run end the bar is lower because false positives are rarer (the HR-band gate already excludes easy and hard runs) and false negatives are more common (real tempos with non-flat HR profiles).

**On extracting sub-segments from longer runs (deliberately not implemented).** A "best 20 min" sub-segment from a 90-min run measures peak capacity, not LT — typically a fast finish or surge run *above* threshold for a brief window. Using it as an LT datapoint would systematically inflate the estimate. The defensible alternative — "steadiest 20 min" inside a longer run — would require per-second HR + pace streams to validate band membership of the segment, which we don't store (only aggregates: avg HR, kmSplits). We deliberately don't fabricate datapoints for users whose training is mostly long aerobic; for them the signal is genuinely thin and the system should fall back to CS-from-PBs and Daniels-from-VDOT, which it does.

### Blend

Weights depend on which methods fired:

| Available | Empirical | CS | Daniels |
|---|---|---|---|
| all three | 0.50 | 0.30 | 0.20 |
| empirical + CS | 0.60 | 0.40 | — |
| empirical + Daniels | 0.65 | — | 0.35 |
| CS + Daniels | — | 0.60 | 0.40 |
| single method | 1.00 | 1.00 | 1.00 |

Empirical gets the highest weight because it's the only direct observation. CS next because it's still observation-derived (from PBs) but fits a model. Daniels is algorithmic — no new information beyond VDOT.

### LTHR derivation

- **Primary:** median HR of qualifying empirical efforts.
- **Fallback:** `0.88 × HRmax` (midpoint of the 85–92% LT2 band for trained runners).
- **Not used:** Karvonen HRR — it would require a reliable `restingHR` and a well-calibrated `maxHR`, and the `0.88 × HRmax` shortcut lands within ±3 bpm for most athletes.

### Source priority (resolveLT)

```
override   >  fresh Garmin (<60d)  >  blended derivation  >  stale Garmin  >  null
```

User override always wins. Fresh Garmin beats derived because the watch has continuous HR access and proprietary FirstBeat calibration — higher fidelity than any field-data estimator when available. Stale Garmin (>60 days) is dropped in favour of derived, because LT drifts with fitness.

### Confidence

- **High** — empirical present AND (CS or Daniels) available. Triangulated.
- **Medium** — empirical alone, or CS + Daniels (no empirical).
- **Low** — Daniels only (no field observations).

Low-confidence LT feeds the app but is flagged so UI can warn users not to prescribe training paces off an untriangulated number.

### Outliers and known failure modes

| Scenario | Guard | Effect |
|---|---|---|
| Treadmill | sportType filter | Empirical skips the run |
| Trail / hills (>15 m/km) | elevation filter | Empirical skips |
| Hot weather (>28°C) | ambient temp filter | Empirical skips |
| Sub-20min efforts | duration gate | Empirical skips |
| Over-60min efforts | duration cap | Empirical skips (cardiac-drift territory) |
| Unsteady pacing (CV>8%) | splits CV gate | Empirical skips |
| Cardiac drift >5% | `hrDrift` from full HR stream (preferred), pace half-vs-half (fallback) | Empirical skips |
| HR strap absent / optical | no explicit guard | Accept but confidence only "medium" |
| Illness / heat-acclimation shift | not detectable | Time-decay τ=21d mitigates |
| Altitude | not detectable | User can override |
| HRmax miscalibrated | no guard | LTHR fallback propagates error |
| Ultra-elite (VDOT > 70) | no guard | Daniels formula less accurate at extremes |
| Women LT1 slightly higher fraction | not modelled | LT2 less affected; literature shows ~1–2% shift |

### Integration

- Pure functions in `src/calculations/lt-derivation.ts`.
- 29 unit tests in `src/calculations/lt-derivation.test.ts` cover each method, outlier cases, blending, and source precedence.
- State: `s.ltOverride?: { ltPaceSecKm, ltHR?, setAt }` holds user override.
- Garmin reading still populates `s.ltPace` / `s.ltHR` via physiology snapshot — `resolveLT()` reads both and picks.

---

## Effort-Calibrated VDOT from HR (2026-04-24)

**Purpose.** Current-fitness estimate from the last 8 weeks of running, using heart-rate response to pace as the physiological anchor. Complements Tanda (volume + avg pace) and the PB ceiling in a blended race-prediction engine.

**Formula.** For each qualifying run `i` in the 8w window:
```
%VO2R_i = (avgHR_i − RHR) / (maxHR − RHR)       // Swain & Leutholtz 1997
point_i = (avgPace_i, %VO2R_i, duration_i)
```

Weighted linear regression of `avgPace` on `%VO2R` (weights = `duration_i`):
```
avgPace = α + β × %VO2R
paceAtVO2max = α + β × 1.0
VDOT_HR = vdotFromPace(paceAtVO2max)            // Daniels' VDOT table lookup
```

Qualifying filter for inclusion in the regression:
- `duration ≥ 20 min` (short intervals break HR–pace linearity)
- `HR drift < 8%` (excludes fatigue/over-intensity; aerobic decoupling >8% means HR no longer tracks intensity linearly)
- Valid `avgHR`, `maxHR`, `RHR` — if RHR absent, confidence = `none` and HR-calibrated estimate is skipped entirely (no fabricated default).

**Confidence tiers:**
- `high`: N ≥ 8 points AND R² ≥ 0.7
- `medium`: N ≥ 4 points AND R² ≥ 0.5
- `low`: N ≥ 3 points
- `none`: otherwise (fall back to Tanda / hard-effort / PB)

**Blending with other signals.** Final VDOT is a weighted mean across:
1. **HR regression VDOT** — weight `w₁ = R² × min(N/8, 1) × recencyDecay`
2. **Hard-effort VDOT** — single recent race/time-trial (pace ≥15% faster than median, ≤12 weeks old), weight `w₂ = 0.8 × recencyDecay`
3. **Tanda VDOT** — volume × pace, weight `w₃ = paceConfidenceFactor` (high=0.9, medium=0.6, low=0.3)
4. **PB VDOT** — ceiling signal, weight `w₄ = 0.5 × pbAgeDecay`

`recencyDecay = exp(-weeksOld / 12)` for hard efforts.
`pbAgeDecay = exp(-yearsOld × ln(2) / 3)` — half-life 3 years.

**Why HR drift < 8% matters.** Aerobic decoupling (HR rising while pace holds) indicates the athlete has moved above their sustainable aerobic ceiling; the %HRR → %VO2R mapping assumes steady-state submaximal exercise. Friel's threshold is 5%; we use 8% to retain more data, accepting a small error on tempo efforts.

**Why 75th-percentile weighting was rejected.** Percentile-based aggregation discards signal — a run that sits "below" the percentile is still informative about the pace-effort curve. Regression through all points uses every datapoint's information content (pace + effort + duration), weighted by duration as a reliability proxy.

**Runner-type bias.** The VDOT → distance-specific time mapping is shaped by the athlete's 5K/marathon PB ratio, which gives an empirical Riegel exponent. Speed-biased runners (5K stronger than marathon ratio predicts) get a +1–2% shift on marathon prediction; endurance-biased runners (marathon stronger) get −1–2%. See existing "Fatigue Exponent & Runner Type Classification" entry.

**Scientific anchors:**
- **Swain & Leutholtz 1997** — %HRR ≈ %VO2R validated against gas exchange (ACSM 2013 position stand adopts this).
- **Daniels' Running Formula** — VDOT tables; pace at 100% VO2max defines VDOT.
- **Friel 2012 / Maffetone** — aerobic decoupling <5% = well-paced aerobic effort; >8% = fatigued or supra-threshold.
- **Tanaka & Seals 2008** — VO2max declines ~1%/year past age 35 in masters athletes. Used to justify PB half-life ≈ 3 years.
- **Fitzgerald et al. 1997** — longitudinal masters data supports exponential rather than linear VO2max decay.
- **Monod–Scherrer critical-power model** — conceptual analog: multiple submaximal points fit a curve whose asymptote defines threshold. We apply the same principle to pace-HR rather than power-duration.

**Limitations.**
- HR is affected by heat, caffeine, hydration, sleep — noise in %HRR per session is ±3–5 bpm. Regression averages this out across N points.
- Assumes linear %HRR → %VO2R (true within ~40–90% of max; breaks down at extremes).
- VO2max is not the only fitness determinant — economy and lactate threshold fraction matter. VDOT conflates these; a 10% economy improvement will show up as a VDOT rise even without VO2max change (acceptable: both mean the athlete runs faster).
- Athletes without a chest strap / accurate wrist HR get noisy avgHR — confidence tier should reflect this, but we can't detect it reliably; we mark high-variance HR distributions per session and downweight.

**Implementation plan.** New file `src/calculations/effort-calibrated-vdot.ts`. Pure function taking `{ runs, RHR, maxHR, now }` → `{ vdotHR, confidence, R², N, regression }`. Composed in `predictions.ts` via a new `blendFitnessSignals()` function that produces `AthleteFitnessState.run`.

---

## Effort-Calibrated VDOT — per-segment extension (2026-05-12)

**Problem.** The original regression (above) used one (avgPace, avgHR) point per run. For a triathlete or any athlete who runs most kilometres at aerobic effort, qualifying runs cluster tightly — most points sit in the 60–80 % HRR band with no near-threshold data. Linear extrapolation from a narrow cluster to %HRR = 1.0 is mathematically unstable: small noise in the slope produces large errors in the extrapolated pace, which then maps to VDOT via `cv(3200, paceAtVO2max × 3.2)`. The observed failure mode was a single qualifying-run cohort briefly producing VDOT 77 for an athlete whose race-PB-derived, watch-Firstbeat, and Critical-Speed signals all sat in the 49–55 range.

The deeper issue: within-run HR variation was being discarded. A 10K run with the final 5 km at HR 174 ≈ 86 % HRR contains exactly the threshold-zone data the regression needs, but the run-level avgHR of 165 ≈ 73 % HRR loses it entirely.

**Fix.** The regression now accepts per-segment samples (each km, each lap, or any sub-run span) tagged with `isSegment = true`. The same weighted linear regression of pace on %HRR runs against the expanded point set. A 21 km run with a tempo finish contributes ~21 points spanning the run's HRR range instead of one diluted point.

**Filter changes for segments.**

- **Duration floor**: 60 s instead of 20 min. One km at 4:00–6:00/km is 240–360 s; warmup transitions < 60 s are still rejected as too short for HR to settle.
- **Drift gate**: not applied. HR drift is a whole-run aerobic-decoupling signal (Friel / Maffetone). For a sub-run segment the concept isn't well-defined — a steady tempo block inside a fatigued long run is informative regardless of the run-level drift.
- **Pace gate** and **HRR window** (40–95 %): unchanged, applied per-segment.

**Data source.** Strava's `/v3/activities/{id}` detail endpoint returns `splits_metric[]` with `average_heartrate` per split. The edge function already fetched this for pace; the HR field was previously discarded. New `calculateKmHRSplits()` also computes per-km HR from the activity's HR stream as a fallback when `splits_metric` is unavailable. Both arrays are stored as `km_hr_splits int[]` parallel-indexed to `km_splits` (`garmin_activities` migration `20260512_km_hr_splits.sql`).

**Why this is defensible, not just "more points."**

1. Each segment is an *independent* (pace, HRR) pair — not a derived statistic. The regression weights by duration (existing weighting unchanged), so a 5 min km contributes 5× a 1 min warmup transition.
2. HRR coverage genuinely widens. Tristan's prior diagnostic showed all qualifying runs at HRR 64–73 %; with per-km from a tempo-finish long run, the same run contributes points at HRR 65 % (warmup km) through 86 % (final tempo km). Extrapolation to 100 % HRR now has near-asymptote data instead of pure speculation.
3. The %HRR ≈ %VO2R linearity assumption (Swain & Leutholtz 1997) holds at the segment level just as well as the run level — it's a metabolic relationship between heart rate response and oxygen uptake, agnostic to whether the measurement window is 60 s or 60 min.

**Limitations (specific to the segment path).**

- **Within-run autocorrelation**: 21 segments from one run aren't 21 statistically independent observations. The regression treats them as such. The duration weighting partially corrects (longer segments → more weight), but a 21K run still dominates the fit more than its true information content warrants. Mitigated by averaging across many runs over the 8-week window; not formally corrected.
- **Pacing strategy** (positive/negative split) creates structured correlation between pace and HR within a run. A negative-split run with HR rising linearly through it produces an artificially steep slope. The 8-week window plus across-run averaging absorbs this, but a single dominant run with strong drift can bias the fit. The drift gate at run-level (8 %) and segment-level skip combine to limit the worst case.
- **Segments shorter than ~3 min** (still ≥ 60 s) have ~30 s of HR lag that under-credits the actual effort. We accept this — the 60 s floor is permissive but the duration weighting attenuates these contributions.

**What the segment path does NOT fix.**

- The orchestrator still only reads `s.wks[].garminActuals` (matched runs). An unmatched run never feeds VO2. Out of scope for this change — flagged for follow-up.
- Linear extrapolation to %HRR = 1.0 is still the extrapolation target. With wider HRR coverage, the extrapolation distance is shorter and the result more trustworthy, but the assumption "pace–HR is linear all the way to 100 %" remains an approximation that breaks at the edge.
- Cardiac ceiling is still a separate signal, not a constraint. Running VO2max can in principle exceed cardiac ceiling because the latter is an estimator (Uth-Sørensen ±15 %), not a hard physical bound.

**Compatibility.** `isSegment` is optional and defaults to false, so all existing run-level callers and tests continue to work unchanged. The orchestrator prefers per-km segments when both `kmSplits` and `kmHRSplits` are populated; falls back to the run-level (avgPace, avgHR) point otherwise.

**Confidence: medium.** The within-run signal is real and well-grounded in Swain & Leutholtz's submax linearity result. The autocorrelation caveat is the main weakness; we may need to reduce effective N for confidence-tier calculation in a follow-up if the regression tier ends up "high" on athletes whose data is dominated by a single run.

---

## Triathlon — Multi-sport Transfer Matrix (2026-04-23)

**Context**: Mosaic v1 had a single CTL for running with a `runSpec` discount applied to cross-training activities (cycling 0.55, HIIT 0.30, etc). Triathlon makes swim/bike first-class, so a single-run-centred CTL is no longer sufficient. The transfer matrix generalises this: every activity contributes to every discipline's CTL and ATL at a directional weight. `runSpec` is a special case (the "run" column).

**Formula** (per-discipline contribution from an activity with sport S and raw TSS T):
```
contributionToDiscipline[D] = T × TRANSFER_MATRIX[S][D]
```
Applied to both CTL (42-day EMA) and ATL (7-day EMA) at the same weight. This is defensible because a session that transfers aerobically to another discipline causes comparable fatigue there — fitness and fatigue are the same physiological currency.

**Values** (source → destination). Run-column values from Millet et al. 2002 (triathlon cross-transfer) and Millet & Vleck 2000 (swim specificity); padel/ski/hiking values are first-approximation proposals flagged for validation.

| From ↓ / To → | Run | Bike | Swim |
|---|---|---|---|
| Run | 1.00 | 0.70 | 0.25 |
| Bike | 0.75 | 1.00 | 0.20 |
| Swim | 0.30 | 0.20 | 1.00 |
| Strength | 0.10 | 0.10 | 0.10 |
| Padel / tennis | 0.35 | 0.20 | 0.00 |
| Football | 0.45 | 0.20 | 0.00 |
| Ski touring | 0.55 | 0.40 | 0.00 |
| Hiking | 0.55 | 0.35 | 0.00 |

**Key property**: transfers only ADD. A padel session cannot reduce run CTL. Readiness for any discipline drops after any activity (fatigue adds everywhere the transfer is non-zero), because the matrix is applied to ATL the same way as CTL.

**Implementation**: `src/constants/transfer-matrix.ts` (matrix + helpers), `src/calculations/fitness-model.triathlon.ts` (EMA application), `src/calculations/fitness-model.triathlon.test.ts`.

**Limitations**:
- Directional but not interaction-aware (a padel match after a long run is assumed to contribute linearly; in reality combined fatigue is super-linear).
- Padel / tennis / football / ski / hiking values are physiology-reasoning proposals, not lit-backed. Validate after 3–6 months of real data.
- Transfer is instantaneous — no time-lag modelling for "delayed" cross-training effects.

---

## Triathlon — Swim TSS (cubed IF) (2026-04-23)

**Context**: Running and cycling TSS use squared IF (Coggan 2003). Swim drag scales with v³ (Toussaint & Beek 1992) because water resistance grows faster with speed than air resistance — so swim intensity dominates the power cost disproportionately.

**Formula**:
```
sTSS = durationHours × (cssPace / avgPace)^3 × 100
```
IF > 1 when swimming faster than CSS; IF < 1 when slower. 60 min at CSS = 100 TSS.

**Implementation**: `src/calculations/triathlon-tss.ts:computeSwimTss`. Tests: `src/calculations/triathlon-tss.test.ts`.

**Limitations**: assumes steady-state swimming. Sprint intervals are under-counted (anaerobic contribution not captured separately in the IF model). Technique variance between athletes means same IF feels different to different swimmers.

---

## Triathlon — Per-discipline CTL / ATL (2026-04-23)

**Context**: Running mode has a single CTL. Triathlon needs three (swim, bike, run) so the plan engine can detect "swim fitness is plateauing" separately from "bike fitness is advancing". Same Banister 1975 exponential-decay EMAs, applied per-discipline with the transfer matrix determining contributions.

**Formula** (each discipline independently):
```
CTL(today) = Σ (contribution_i × e^(-day_i / 42))
ATL(today) = Σ (contribution_i × e^(-day_i / 7))
TSB = CTL - ATL
```
Normalised to weekly TSS units (divide by τ, multiply by 7). Combined CTL for the headline display uses the `COMBINED_CTL_WEIGHTS` constant (swim 0.175, bike 0.475, run 0.35 — matches the default volume split).

**Implementation**: `src/calculations/fitness-model.triathlon.ts`. Tests cover individual track isolation, transfer-matrix fan-out, decay behaviour, and the CTL-ATL-TSB relationship.

**Limitations**: combined CTL weights are from the default volume split, not tuned to the specific user. Users who train 60/20/20 would technically want a different weighting, but v1 uses the fixed constants.

---

## Triathlon — Run-leg Fatigue Discount for Race Prediction (2026-04-23)

**Context**: Running after the bike leg is measurably slower than a standalone run at the same HR/RPE (Bentley et al. 2007; Landers et al. 2008). This is a **race-time prediction input**, not a training-load discount. The athlete's stimulus during a brick run is the same as a standalone threshold run — but their pace is 4–6% slower in 70.3 and 10–12% slower in IM.

**Formula** (applied only when computing predicted race finish time, never to training load):
```
predictedRunPace = basePace × (1 + DISCOUNT_FOR_DISTANCE)
```
where DISCOUNT = 0.05 for 70.3, 0.11 for IM.

**Implementation**: `src/calculations/race-prediction.triathlon.ts`. **Important**: this is on the tracking side of the line (§ "Tracking vs Planning" in CLAUDE.md). Do not apply this discount to brick run TSS — the training stimulus is full.

**Limitations**: individual variance is wide (some athletes are 2% slower off the bike, others are 8%). The single-number discount is a population midpoint. Future work: learn individual discount from real race data once we have finishers.

---

## Triathlon — FTP and CSS Detraining Curves (2026-04-23)

**Context**: VDOT decays on missed running weeks (existing running mode). Triathlon needs equivalent decay curves for bike and swim threshold anchors so the plan engine doesn't assume fitness is static during illness, injury, or holiday.

**Values**:
- FTP: 5–7% loss per 4 weeks off — **6% midpoint used**. Source: Coyle 1984 (cycling detraining; VO2max and muscle capillarisation both drop measurably within 2–4 weeks).
- CSS: 3–5% loss per 4 weeks off — **4% midpoint used**. Source: Mujika 2010 (swim detraining — slower loss than bike/run because technique retention buffers pace decline).
- VDOT: unchanged from running mode.

**Implementation**: constants defined in `src/constants/triathlon-constants.ts` (`FTP_DETRAINING_PER_4WK`, `CSS_DETRAINING_PER_4WK`). Consumer wiring is deferred to Phase 7b (per-discipline threshold decay during missed weeks).

**Limitations**: linear-per-4wk is a simplification. Real detraining is bi-exponential (rapid initial drop, then slower tail). Good enough at the granularity of 1-week plan updates.

---

## Just-Track Daily Load Target (2026-04-23)

**Context**: Just-Track mode has no plan, therefore no `plannedDayTSS`. The home-view daily load card needs an alternative anchor that is scientifically defensible, decays gracefully when the athlete has no recent data, and does not feel like prescription (Just-Track users explicitly opted out of prescribed workouts).

**Formula**:

```
dailyNeutral  = ctlBaseline / 7          // weekly-EMA CTL is stored as weekly internally
targetTSS     = dailyNeutral × readinessMult
readinessMult = 1.3 if readinessScore >= 80
              = 1.0 if 60 <= readinessScore < 80
              = 0.7 if 40 <= readinessScore < 60
              = 0.3 if readinessScore < 40

// Colour band of today's actual load vs CTL (Gabbett 2016 ACWR sweet spot):
ratio = actualTodayTSS / dailyNeutral
green  if ratio <= 1.3           // sustainable
amber  if 1.3 < ratio <= 1.5     // overreaching
red    if ratio > 1.5            // documented injury-risk spike
```

**Rationale by term**:

- **`ctlBaseline / 7`** — CTL is a 42-day EMA of weekly TSS (Banister impulse-response model). `CTL × 1.0` is, by definition, the weekly load that holds fitness flat — the maintenance dose. Dividing by 7 gives the fitness-flat daily equivalent.
- **Readiness multiplier (1.3 / 1.0 / 0.7 / 0.3)** — maps the existing 0–100 readiness composite (HRV 50% + last-night sleep 25% + sleep history 25%) to four training zones. Values chosen to keep the readiness-adjusted target inside Gabbett's 0.8–1.3 ACWR band on normal days, with the 1.3 "push" ceiling aligned with the Gabbett upper bound and 0.3 "rest" floor aligned with pedagogical recovery-day doses (10–40% of maintenance, a common coaching heuristic).
- **Gabbett 2016 bands (0.8–1.3 / 1.3–1.5 / >1.5)** — `Gabbett TJ (2016). "The training-injury prevention paradox: should athletes be training smarter and harder?"` British Journal of Sports Medicine 50(5):273–280. 0.8–1.3 = "sweet spot" with lowest injury incidence across multiple team-sport and endurance populations. >1.5 = 2–4× injury rate vs sweet spot in the same cohorts. Colours surface acute risk, not progression prescription.

**Bootstrap**: when `ctlBaseline < 20` (weekly CTL below ~3 TSS/day equivalent — athlete is brand-new or has no sync history), the daily target is suppressed entirely and replaced with a "sync more history" empty state. Below that threshold the `CTL/7` anchor is noisier than the multiplier can compensate for and would produce misleading single-digit targets.

**Known limitations**:

- CTL-as-weekly convention is Mosaic-internal. Published literature often defines CTL as daily directly (42-day EMA of daily TSS). Our unit is equivalent but divided by 7 for display — noted in `docs/arch-notes.md` → "CTL display scale".
- Readiness multiplier thresholds (80/60/40) are pragmatic, not literature-cited. They produce sensible behaviour on the readiness score distributions we've seen but are not validated against an external cohort.
- Gabbett thresholds come from team-sport + Australian-football cohorts. Transfer to recreational runners is reasonable but not direct.
- The `ratio` colour band compares today's actual load vs CTL-neutral, not vs the readiness-adjusted target. This is deliberate — readiness should not widen what we consider "safe." Overreaching is overreaching whether the athlete felt fresh that morning or not.

**File**: `src/ui/home-view.ts → buildTrackOnlyDailyTarget()`.

---

## Daily Feeling Modifier on Coach Stance (2026-04-17)

**Why added.** The rules engine consumes objective signals (TSB, ACWR, sleep score, HRV, strain) but no subjective input from the athlete. Physiological data alone misses meaningful same-day variance: illness onset before it shows in RHR, cumulative life stress that doesn't yet register in HRV, or genuine freshness that objective numbers understate on a rest-heavy week. A one-tap daily feeling prompt (`struggling | ok | good | great`) reintroduces the athlete's own judgment without demanding a full check-in.

**Formula.** After the base coach stance is computed from blockers + readiness label:

```
struggling   → drop one level  (push → normal → reduce → rest)
ok           → no change
good / great → promote normal → push
               gated on: blockers.length === 0 AND readiness.score >= 75
```

The Primed threshold `75` is sourced directly from `readiness.ts` (`if (score >= 75) label = 'Primed'`). The feeling prompt cannot override the readiness composite's own safety rails.

**Defensibility.** Subjective wellness monitoring is well-established in sports science as a cheap and sensitive indicator of training response. Saw, Main & Gastin (2016), *Monitoring the athlete training response: subjective self-reported measures trump commonly used objective measures: a systematic review*, Br J Sports Med 50(5): 281–291, pooled 56 studies and concluded that subjective self-report scales responded to acute and chronic training loads with greater sensitivity and consistency than commonly-used objective measures (HRV, resting HR, salivary cortisol). Halson (2014), *Monitoring training load to understand fatigue in athletes*, Sports Med 44 Suppl 2: 139–147, reaches the same conclusion. A 4-option format is a simplified wellness questionnaire; the literature supports 5-item Likert scales but also notes that shorter scales retain most of the signal at the cost of granularity.

**Why the promotion is gated.** The same literature warns that athletes routinely over-report readiness when motivated (Halson 2014). Allowing a subjective `good`/`great` to override an objective block (injury, illness, acute sleep/HRV suppression, ACWR > 1.5) would undo the safety rails the readiness composite and blockers provide. The gate (`blockers.length === 0 AND readiness.score >= 75`) ensures the feeling can only amplify a stance the objective signals already endorse — it cannot create risk the signals don't already sanction.

**Why illness overrides feeling.** `illnessState.severity === 'light'` caps stance at `reduce` BEFORE the feeling modifier runs. This mirrors the general principle that symptomatic illness is an absolute block on hard training regardless of how the athlete feels — training through viral illness risks myocarditis and prolongs time-to-recovery.

**Limitations.**

- **One-tap is coarse.** Four options lose nuance vs a 1–10 Likert or a 5-item wellness questionnaire (fatigue / stress / soreness / sleep / mood). A single global "how do you feel" blends physical and mental states that may diverge.
- **End-of-day expiry is arbitrary.** The stored value clears at midnight local time. A feeling logged at 08:00 and still valid at 16:00 is the same "today", but by 22:00 the athlete's state may have shifted. No decay inside a day.
- **No habituation check.** Athletes who habitually pick `good` will shift their own baseline over time; the modifier doesn't z-score against the athlete's own history. A `great` from someone who picks `great` daily carries less signal than a `great` from someone who usually picks `ok`.
- **No retrospective calibration.** We don't correlate reported feeling with subsequent session quality or next-day recovery to check the signal is predictive for this specific athlete.

**Implementation.** `src/calculations/daily-coach.ts` — `computeDailyCoach` applies the modifier after base-stance derivation. `getTodayFeeling(s)` enforces end-of-day expiry via ISO date comparison. UI: `src/ui/feeling-prompt.ts` (shared helper), rendered from `src/ui/home-view.ts` and `src/ui/coach-view.ts`. Tests in `src/calculations/daily-coach.test.ts` cover every base-stance × feeling transition, the blocker gate, and illness override.

---

## Cross-Training Sport Coefficients (2026-04-16)

**Why added.** `SPORTS_DB` (src/constants/sports.ts) holds per-sport coefficients used for every cross-training load contribution: `mult` (load multiplier), `runSpec` (running specificity, feeds crossTL), `recoveryMult` (recovery-cost scaling), `impactPerMin` (musculoskeletal impact load per minute), `legLoadPerMin` (leg-fatigue accumulation per minute), `volumeTransfer` (GPS km credit toward running volume). Seven board- and water-sport entries were added to cover activities a growing share of users log: snowboarding, kitesurfing, surfing, sailing, paddleboard, kayaking, wakeboarding. Before this, these all fell through to `generic_sport` (mult 0.90, runSpec 0.40, legLoadPerMin 0) which over-stated aerobic transfer for sailing and under-stated leg fatigue for snowboarding, kitesurfing, and wakeboarding.

**How the coefficients are derived.**

1. **`mult` (load multiplier).** Derived from the Compendium of Physical Activities (Ainsworth et al., 2011, *Med Sci Sports Exerc* 43(8): 1575–81), scaling the MET value against running's reference MET so that a minute of sport X at RPE equivalent yields a fraction of a minute of running's physiological load. Compendium MET ranges used: snowboarding ~5 METs → 0.85; kitesurfing 3–6 METs wind-dependent → 0.75; surfing 3–5 METs → 0.75; sailing 2–3 crewing / 3 dinghy → 0.50; paddleboard touring ~6 METs → 0.70; kayaking touring ~5 METs → 0.70; wakeboarding no clean entry, blended from skating (0.75) and skiing (0.90) → 0.70. These numbers sit between rowing (0.85) and walking (0.35) in the existing DB, which anchors them against well-calibrated reference points.

2. **`runSpec` (running specificity).** Expert judgment based on motor-pattern overlap with running (leg drive, vertical displacement, rhythmic cadence, weight-bearing). Scale 0.10 (no overlap, e.g. sailing) to 1.00 (running itself). The four board sports (snowboarding 0.45, wakeboarding 0.35, surfing 0.20, kitesurfing 0.35) sit between cycling (0.55) and strength (0.35) because they train balance, posterior chain, and trunk but lack running's gait pattern. Kayaking and paddleboard are low (0.20–0.25) because upper-body-dominant paddling sports transfer minimally to running. These are not empirically validated against running-performance transfer studies — the field lacks such data for board sports. Flagged as a known limitation.

3. **`recoveryMult` (recovery-cost scaling).** Reflects metabolic and CNS recovery demand relative to a neutral sport (1.00). Sports with sustained steady-state effort and no impact (paddleboard 0.90, kayaking 0.90) recover faster than the baseline; sports with eccentric board-pressure loads (kitesurfing 0.95, wakeboarding 0.95) slightly faster but not as much as swimming (0.90). Surfing 1.00 (baseline) because paddling + pop-ups is a mixed demand. Sailing 0.95 because hiking-out isometric load is low-grade CNS but not demanding cardiovascularly. Derived by analogue with existing DB entries; no direct literature on recovery demand for board sports.

4. **`impactPerMin` (musculoskeletal impact).** Running zero-water-contact sports zero: kitesurfing 0.02, sailing 0.00, paddleboard 0.00, kayaking 0.00. Snowboarding 0.06 for edge chatter and landing forces. Surfing 0.02 for pop-up and occasional falls. Wakeboarding 0.03 for landings during runs. Derived from existing cycling (0.00), skiing (0.07), skating (0.04) reference points — board + water sports are bracketed inside these.

5. **`legLoadPerMin` (leg-fatigue accumulation).** Derived using the legLoadPerMin tier hierarchy already documented in sports.ts: Vertical eccentric gravity-loaded (skiing, snowboarding, stair_climbing) = 0.45–0.50; sustained flat leg drive (rowing, cycling) = 0.25–0.35; intermittent isometric (kitesurfing, wakeboarding, skating) = 0.15–0.25; minimal (walking) = 0.05; not-leg (swimming) = 0. Snowboarding 0.45 (close to skiing's 0.50 but slightly lower due to board-pressure vs true eccentric quad loading per-leg). Kitesurfing 0.15 (sustained isometric edging analogous to skating). Surfing 0.10 (brief pop-ups between rest). Wakeboarding 0.25 (high eccentric-quad loading per-pull, similar cadence to skating). Sailing/paddleboard/kayaking 0.05–0.10 (legs largely passive).

6. **`volumeTransfer` (GPS km credit toward running volume).** Zero for all 7 new sports. None has the gait pattern to credit toward the running volume ring. This matches the existing DB: only running-adjacent GPS sports (extra_run 1.0, hiking 0.4, walking 0.3, stair_climbing 0.3) receive credit.

**Limitations and risks.**

- **Compendium-derived MET values translate imperfectly to training load.** The Compendium's METs are averaged energy expenditure across session duration. They don't distinguish explosive-then-rest patterns (kitesurfing) from sustained aerobic output (kayaking), nor aerobic from anaerobic. `mult` over-states the aerobic stimulus for intermittent sports and under-states leg fatigue for vertical-loaded sports. For Mosaic's impulse-response CTL/ATL model this is acceptable — `mult` drives first-order load, and leg-fatigue / impact / recoveryMult separately capture sport-specific stress pathways.
- **`runSpec` is not empirically validated.** Running-performance transfer studies for board sports don't exist in the literature. The values are expert judgment informed by motor-pattern overlap. If these cross-trainings are the bulk of someone's training, running-fitness signals will drift from reality faster than for swimming/cycling/hiking where transfer is better characterised.
- **`recoveryMult` values are pragmatic analogues.** Recovery-demand studies across extreme sports are sparse. The numbers hold a defensible relative ordering; the absolute calibration is the existing DB's convention.
- **Wind-dependent and session-variable sports (kitesurfing, surfing, sailing) have inherent load variability a single coefficient can't capture.** A 2-hour flat-water kitesurf cruise is very different from 2 hours of jumps in gusty wind. Mosaic offsets this with iTRIMP-from-HR when available (superseding the duration × mult × rpe fallback). Users without HR data will see systematic under- or over-estimation that HR telemetry would correct.

**User-facing correction path.** Since these coefficients are analogue-derived rather than empirical, the activity detail page lets users reclassify any synced activity to a different sport (src/ui/sport-picker-modal.ts). Reclassify applies a delta to the current week's actualTSS / actualImpactLoad / leg load, and persists a `sportNameMappings[normalized activity name] → SportKey` entry so future syncs of same-named activities auto-apply. This is the safety valve for Compendium-derived coefficients the user judges wrong for their individual case.

**Files touched.**
- `src/constants/sports.ts` — SPORTS_DB entries, SPORT_LABELS, SPORT_ALIASES
- `src/types/activities.ts` — SportKey union
- `src/types/state.ts` — GarminActual.manualSport, sportNameMappings
- `src/ui/sport-picker-modal.ts` — picker + reclassifyActivity + resolveSportForActivity
- `src/ui/activity-detail.ts` — "Activity" row + handler
- `src/ui/activity-review.ts` — wires resolveSportForActivity at the 4 mapAppTypeToSport sites

---

## Tanda Marathon Predictor (2026-04-15)

**Why added.** The previous marathon blend (LT + VO2 + PB + recent) was built entirely on capacity ceilings. All four predictors answer "what is your aerobic potential?" rather than "what can you sustain over 42K given current training?" Marathon failure mode is fractional utilization collapse in the last 10–12 km (Joyner & Coyle 2008), which capacity predictors under-model. Previous attempts (volume-bumped LT multiplier, volume-penalised recent run) were theory-motivated but empirically unvalidated heuristics — directionally right, calibration invented.

**Tanda's model.** Tanda (2011, *J Hum Sport & Exercise* 6(3)) regressed marathon finish time on two training indices from the 8 weeks preceding the race:

```
T_marathon (min) = 11.03 + 98.46 × exp(−0.0053 × K) + 0.387 × P
```

- K = mean weekly running km
- P = mean training pace (sec/km) across all runs in the window

**Calibration.** n = 46 marathoners, recreational to sub-elite, range 2:27–4:41. Correlation r = 0.91, standard error ≈ 3 min. Paper available at https://www.jhse.ua.es/article/view/2011-v6-n3-prediction-marathon-performance-time-training-indices.

**Why this predictor earns weight the others don't.**
1. **Outcome-calibrated.** Trained against real marathon finishes, not derived from steady-state physiology. The other predictors are physiological-first with no marathon-outcome regression.
2. **Volume-aware directly.** K handles the "no volume = slower marathon" effect we were trying to hack in via heuristic bumps. No invented bands.
3. **Pace-aware distinctly.** Quality of running matters, not just quantity. A runner averaging 4:30/km training pace is materially different from 5:30/km at the same volume.

**Integration.** Marathon blend reweighted:

```
with recent run:    recent 0.20, pb 0.05, lt 0.35, vo2 0.10, tanda 0.30
without recent run: pb 0.10, lt 0.45, vo2 0.15, tanda 0.30
```

When Tanda is unavailable (insufficient data, non-marathon distance, K out of [4,120], P out of [180,480] sec/km), its weight redistributes onto LT. `lowVolumeDiscount` is skipped for marathon now that Tanda handles volume sensitivity — avoids double-penalising.

**Guards.**
- Return null if weeks of data < 4 (insufficient for 8w-model proxy).
- K soft-floor at 10 km/wk before applying exponential term — Tanda's sample didn't include very low volumes; below 10 km/wk the exponential dominates in a way the paper didn't validate. Soft-clamp prevents runaway predictions at near-zero volume while preserving the slower-at-low-K direction.
- K upper-bound 120 km/wk (out-of-sample at elite extreme; saturation untested).
- P range 3:00–8:00 /km (filters obvious data errors).

**Mean pace calculation.** Unweighted mean across all running activities ≥3 km in the 8w window, excluding paces faster than 3:00/km (sprints) or slower than 8:00/km (walks / treadmill drift), excluding any activity whose name matches `/treadmill|walk/i`, then dropping the slowest 10% of the remaining sample (noise-tail trim, gated to samples ≥5 runs so sparse logs aren't wiped out). Matches Tanda's methodology of "mean training pace" across qualifying training sessions while rejecting the failure modes Tanda's manually-curated cohort never had to deal with (auto-imported activity feeds with treadmill GPS drift, walk breaks logged separately, aborted runs).

**Known limitations (same as Tanda's own).**
- 46-runner cohort is small. Wide confidence interval at individual level (SEE 3 min = 95% CI ~±6 min).
- Cohort was recreational-to-sub-elite; elite-specific saturation at K >100 km/wk unmodeled.
- Cross-discipline athletes (cyclists, triathletes) with low running volume but high aerobic base will be over-penalised because K only counts running. This is arguably correct for marathon-specific readiness, but worth naming.
- Does not distinguish long-run presence — 40 km/wk of 5 × 8K is scored the same as 40 km/wk with one 25K long run. Former is less marathon-ready.
- Static formula — doesn't account for multi-year adaptation, elevation, temperature, shoes, or any of the real-world variance around a 3-min SEE.

**Why this is more honest than what we had.** Previous heuristic bumps were internally consistent but had no external validation. Tanda swaps "theory-motivated tuned bands" for "outcome-regressed formula." The numbers aren't necessarily more *correct* for any individual runner, but the model is grounded in real marathon outcomes rather than reverse-fit to a specific user's intuition.

**References.**
- Tanda G (2011). *J Human Sport & Exercise* 6(3) — "Prediction of marathon performance time on the basis of training indices."
- Joyner MJ, Coyle EF (2008). *J Physiol* — Endurance performance physiology.
- Supporting: Daniels J, *Daniels' Running Formula*; Billat V et al. (2003) on fractional utilization.

---

## Recovery Run Workout Tier (2026-04-15, provisional)

**Context**: Added `'recovery'` as a new `WorkoutType` to extend the suggester's downgrade ladder. Previous bottom rung was `'easy'`; when the running floor blocked distance reduction on an all-easy week, the suggester had no lever and silently declined to offer Reduce.

**Definition**: A pure zone 1, RPE 3 session intended for blood flow and active rest rather than aerobic adaptation. Distinct from easy in intent (recovery, not stimulus) and intensity (zone 1, not zone 2).

### Pace
`paceMinPerKm = baseMinPerKm * 1.12`, where `baseMinPerKm` is easy pace.
- On a 6:00/km easy base: ≈ 6:43/km (+43 s/km).
- On a 5:00/km easy base: ≈ 5:36/km (+36 s/km).

**Defensibility**: Literature typically places recovery pace at easy + 30 to 60 s/km (Daniels' *Running Formula*; Magness, *The Science of Running*). The 1.12 multiplier sits in the middle of that range and scales with individual ability (faster runners get a smaller absolute offset, appropriate because their easy pace is already lower).

**Limitations**:
- Multiplicative offset is an approximation; a fixed absolute offset (e.g. +40 s/km regardless of base) would be equally defensible and arguably simpler. Flagged for Tristan's sign-off.
- Does not account for terrain, heat, or fatigue state — same as the rest of the pace model.

### Load profile
```
LOAD_PROFILES.recovery = { aerobic: 0.98, anaerobic: 0.02, base: 0.99, threshold: 0.01, intensity: 0 }
```
Compared to easy at `{ aerobic: 0.95, anaerobic: 0.05, base: 0.94, threshold: 0.05, intensity: 0.01 }`.

**Defensibility**: Recovery runs sit below the aerobic threshold (LT1/ventilatory threshold 1). No meaningful contribution to threshold or intensity zones. Anaerobic is near-zero but non-zero to handle edge cases (short accelerations, hills). The small delta vs. easy reflects the fact that both are predominantly aerobic — the difference is zone 1 (recovery) vs. zone 2 (easy).

**Limitations**:
- Constants are extrapolated from the easy profile rather than calibrated from data. Flagged provisional.
- The load-per-minute rate still uses `LOAD_PER_MIN_BY_INTENSITY[3]` (RPE 3). Recovery load is therefore ~60% of easy load for the same duration, which matches the intended feature behaviour (enough reduction to absorb excess, not so much that the session is pointless).

### Downgrade chain integration
`downgradeType` in `src/cross-training/suggester.ts` now maps `easy → recovery`. Easy distance-reduction branch falls through to easy → recovery conversion when the floor blocks distance cuts (preserves volume, reduces load).

**Defensibility**: The ladder (vo2/intervals → threshold → marathon_pace → easy → recovery) mirrors the standard Daniels intensity hierarchy. Adding recovery as the bottom rung gives one more lever without introducing a novel training concept.

### Floor treatment
Recovery km count toward `floorKm` at 1.0x (same as easy).

**Rationale**: The floor exists to prevent total running volume collapse. Recovery running still contributes to volume — joint loading, running economy, neuromuscular coordination — even if the aerobic stimulus is lower. Counting at 1.0x avoids a cascade where downgrading to recovery triggers further floor violations. This is a pragmatic choice; a 0.5x weighting could be argued (half the stimulus, half the credit) but adds complexity for limited signal.

**Known limitations of the tier overall**:
- Recovery is only reached via downgrade, never scheduled directly by the plan generator. The suggester is the sole producer.
- Pace and load constants are provisional until Tristan confirms.

---


## Low-Volume Detraining Discount on Watch LT/VO2 (2026-04-14)

**Problem.** Garmin/Apple watches estimate LT pace and VO2max from running activities only. When the user stops running, these values persist at their last measurement. `blendPredictions` weights LT at 55% and VO2 at 15% for marathon, so stale-elevated watch values drive an optimistic race prediction even when the athlete is clearly detrained.

**Physiological basis.**

1. **Endurance metrics decay fast.** Coyle et al. (1984) and Mujika & Padilla's review (*Sports Medicine* 2000) document ~6–7% VO2max loss in 2–3 weeks of inactivity, with larger losses in capillary density, mitochondrial enzyme activity, and blood volume over the same window.

2. **Marathon depends on fractional utilization most.** Joyner & Coyle (2008) decompose endurance performance into VO2max × fractional utilization × running economy. Fractional utilization (the % of VO2max sustainable over race duration) is the most training-sensitive term and the dominant determinant of marathon pace. It decays faster than VO2max itself because it's limited by fat oxidation, glycogen sparing, and fatigue resistance — all training-volume-dependent.

3. **Distance sensitivity.** 5K is more VO2-limited and less reliant on fractional utilization. Marathon is the opposite. So detraining hits marathon predictions hardest.

**Implementation.** `lowVolumeDiscount(targetDist, weeklyRunKm)` in `predictions.ts`:

```
severity = 0.00   if km/wk ≥ 30
         = 0.15   if km/wk ≥ 20
         = 0.30   if km/wk ≥ 10
         = 0.45   otherwise

distSensitivity = 1.0 (42K) | 0.7 (HM) | 0.4 (10K) | 0.2 (5K)
watchTrust = 1 − severity × distSensitivity
```

Applied multiplicatively to LT and VO2 weights; the shed weight transfers to PB (which reflects the athlete's peak realised fitness). No mutation of `s.lt` or `s.vo2` themselves — watch values are preserved for display, only their *trust* in the blend is discounted.

**Example** (marathon, 8 km/wk running volume): severity 0.45, distSensitivity 1.0, watchTrust = 0.55. Original weights (with recent run): LT 0.55, VO2 0.15, PB 0.05, recent 0.25 → adjusted: LT 0.30, VO2 0.08, PB 0.37, recent 0.25. PB becomes the dominant signal, which is correct when watch data is stale.

**4-week volume window.** Chosen because (a) endurance adaptations from a single week don't meaningfully restore fractional utilization, (b) physiology research on detraining uses weeks not days, (c) it matches the recency decay already applied to `recentRun` weighting. Running-only (no cross-training) because LT/VO2 estimates are running-specific.

**Known limitations.**
- Volume thresholds (30/20/10 km/wk) are pragmatic bands, not calibrated against outcome data. A 20 km/wk ultra-runner may be well-trained for marathon, and a 30 km/wk sprinter isn't. The bands assume a "typical recreational-to-trained" marathoner distribution.
- Does not distinguish quality of running (all-easy vs mixed). A user doing 15 km/wk of hard tempo is more marathon-ready than 15 km/wk all-easy, but the discount treats them the same.
- PB ceiling not applied (user rejected this) — blend can still produce a prediction faster than PB if LT + VO2 point that way and volume is high. By design.

**References.**
- Coyle EF et al. (1984). *JAP* — "Time course of loss of adaptations after stopping prolonged intense endurance training."
- Mujika I, Padilla S (2000). *Sports Medicine* — "Detraining: loss of training-induced physiological and performance adaptations."
- Joyner MJ, Coyle EF (2008). *J Physiol* — "Endurance exercise performance: the physiology of champions."
- Bassett DR, Howley ET (2000). *MSSE* — "Limiting factors for maximum oxygen uptake and determinants of endurance performance."

---

## Readiness Color Scheme & Coach Priority (2026-04-14)

**Two color systems, different semantics.**

Sleep, recovery, and physiology scores use **universal 4-tier bands** (80/65/50):
- ≥ 80: bright green (optimal)
- ≥ 65: muted green (good, not exceptional)
- ≥ 50: amber (fair — worth monitoring)
- < 50: red (poor — act on it)

Readiness uses **label-based bands** (75/55/35) matching the Primed/On Track/Manage Load/Ease Back labels. Rationale: a score of 62 means different things in each context. A readiness of 62 is "train as planned" (the composite integrates freshness, load safety, recovery — all three don't need to be green for training to proceed normally). A sleep score of 62 is genuinely mediocre. Forcing the same visual band across both creates mixed messaging (the label says "On Track" but the color says "caution").

**Recovery pill threshold** (`recovery/engine.ts`): `SLEEP_GREEN = 70`. Below 70 triggers yellow + adjustment prompt. Higher thresholds (80) made the pill too noisy for runners who habitually score in the 70s.

**Coach primary message now respects `drivingSignal`**. When the lowest-scoring readiness sub-signal is `fitness` (freshness) and readiness is below Primed (< 75), the coach leads with freshness and appends sleep debt as secondary context. Previously, a 5h+ sleep debt dominated the message even when freshness was the larger drag on the composite — creating the contradiction where the page showed "On Track" (label driven by fitness) while the coach said "prioritise sleep." The gate is tied to the readiness label bands (not an arbitrary threshold) so the decision logic aligns with what the user visually sees.

---

## Sleep History Signal — 4th Recovery Input (2026-04-12)

**Function**: `computeRecoveryScore()` in `src/calculations/readiness.ts`

**Problem**: Single-night sleep scores are noisy. Garmin's 0-100 range is compressed (~30-95 in practice). Chronic sleep restriction has cumulative effects that a single-night reading misses.

**Formula**:
- **Sleep History score**: raw 14-day average of sleep scores, penalised by cumulative sleep debt.
  - `sleepHistoryScore = clamp(14d_avg - debtPenalty, 0, 100)`
  - `debtPenalty = sleepDebtSec / 3600 * 3` (each hour of debt = ~3pt penalty)
  - 14-day window matches sleep debt effective range (half-life 7d, 14d captures ~93%)
  - Minimum 3 recent nights required
- **Last Night Sleep**: raw Garmin/Apple score used directly. No z-scoring.

**Why raw scores for sleep (not z-scored like HRV)**: HRV is highly individual — 40ms RMSSD is excellent for one person, poor for another — so z-scoring against personal baseline is essential. But Garmin/Apple sleep scores are already population-normalised: 59 = "poor" for everyone. Z-scoring an already-normalised signal adds noise. For variable sleepers (SD ~15), the z-score compresses deviations toward the center, making a genuinely bad 59 score as little as 0.7 SD below mean — not enough to move the composite.

**Why sleep debt feeds into sleep history**: Without debt, the physiology composite can show 82% recovered while the readiness page simultaneously says "5.5h sleep debt, prioritise sleep." This is contradictory. Sleep debt (duration deficit) and sleep quality are related but distinct signals. Feeding debt into the history score ensures consistency: both readiness and physiology tell the same story. The 3pt/hour penalty is calibrated so 5.5h debt drops the history score by ~16pts, enough to meaningfully depress the composite without overwhelming it.

**Composite weights**:
- HRV: 50% (chronic trend, z-scored against personal baseline)
- Last Night Sleep: 25% baseline, scales up to 35% as the gap to 14d avg grows
- Sleep History: 25% baseline, scales down to 15% as the gap to 14d avg grows
- RHR: override only when elevated >= 2 SD (unchanged)
- Weights renormalise when a signal is unavailable

**Asymmetric sleep weighting (gradient)**: When last night's score is worse than the 14d average, weight shifts linearly from history toward last night. `shift = clamp(gap / 20, 0, 1) * 0.10`, where `gap = sleepHistoryScore - sleepScore`. At gap 0 the split is 25/25; at gap 20 (a full sleep-quality tier) it saturates at 35/15. Acute sleep restriction has disproportionate next-day performance impact. Sleep loss hurts more than sleep surplus helps (Fullagar 2015, Reilly & Edwards 2007, Halson 2014). Gradient (vs binary switch) prevents 1-2pt dips from meaningfully flipping the weighting.

**One-way by design**: when last night is *better* than the 14d average, weighting stays at 25/25 — a single good night doesn't rescue a bad trend. No strong evidence in the literature that weighting a good night higher improves prediction; overweighting an outlier good score against a poor baseline would underrepresent chronic fatigue.

**Sleep debt penalty cap**: `debtPenalty = min(3 × debtHours, 25)`. Linear up to ~8.3h of debt, then capped. Beyond 8h debt the athlete is already in the danger zone — further debt adds little signal, but unbounded linear growth would collapse the history score to 0 if debt calculation misfired (bad target, missing nights).

**Justification**:
- Van Dongen 2003: chronic sleep restriction (6h/night for 14 days) produces cumulative cognitive deficits equivalent to 1-2 nights total deprivation, even when subjects report feeling "adapted"
- Halson 2014: sleep debt is a significant mediator of overtraining risk in athletes
- Buysse 2014: sleep quality is relative to individual need; absolute thresholds miss individual variation
- Z-scoring against personal baseline handles the compressed Garmin range naturally (no hardcoded floor/ceiling)
- Works identically for Garmin and Apple Watch users (both produce sleepScore in 0-100 range)

**Known limitations**:
- Requires 10+ baseline readings for z-score method; fallback to raw average is less informative
- Garmin's sleep score algorithm is opaque; we're z-scoring a derived metric, not raw physiology
- Equal 25/25 weighting of last-night vs 7d-history is pragmatic, not empirically derived

---

## Readiness-Modulated Daily Target TSS (2026-04-09)

**Function**: `computeDayTargetTSS(plannedDayTSS, readinessLabel, perSessionAvg, isRestDay, isAdhocDay)`

**Formula**:
- Training days: `target = plannedDayTSS`
- Adhoc days (unplanned activity): `target = perSessionAvg`
- Rest days: `target = perSessionAvg × 0.30`
- Modulation: Ease Back × 0.80, Overreaching × 0.75

**Science**:
- Rest day target: Menzies (2010) — active recovery at ~30% of training load improves next-day performance vs complete rest.
- Ease Back (0.80): Halson (2014) — 20-30% load reduction on suppressed recovery markers.
- Overreaching (0.75): Gabbett (2016) — ACWR spike model, target reduction to lower acute:chronic ratio.
- Ready to Push / On Track / Manage Load: 100% (Buchheit & Laursen 2013, autoregulation — plan holds when recovery is adequate, Manage Load is visual only).

**perSessionAvg**: Derived from current week's planned TSS / training day count (not CTL baseline). Tracks plan intent so targets rise during build phases and drop during taper, rather than lagging behind via 42-day EMA.

**Rest-day overreach threshold**: `perSessionAvg × 0.33` (`REST_DAY_OVERREACH_RATIO`). Based on Whoop's ~33% recovery-day cap and Seiler's polarised model (Zone 1 recovery sessions ≈ 25-35% of a hard session).

**Limitations**: Readiness modulation is binary (label-based thresholds), not continuous. A more sophisticated model would use the readiness score as a continuous multiplier.

---

## Passive TSS from Steps (2026-04-09)

**Constant**: `PASSIVE_TSS_PER_1000_STEPS = 1.0`

**Derivation** (Banister TRIMP at Zone 1 walking intensity):
- Walking cadence ~110 spm (Himann 1988) → 1,000 steps ≈ 9 min.
- Walking HR ≈ 50-55% HRmax → HRR ≈ 0.20-0.30.
- Banister TRIMP/min = HRR × 0.64 × exp(1.92 × HRR) ≈ 0.19 at HRR=0.25.
- 9 min × 0.19 = 1.7 raw TRIMP → normalizeiTrimp(1.7, 15000) ≈ 0.011.
- BUT TL_PER_MIN[2]=0.45 for RPE2 gives 9 × 0.45 = 4.05 — much higher.
- Compromise: 1.0 TSS per 1,000 steps. Conservative enough that 5-10k daily steps add 5-10 TSS.

**Function**: `computePassiveTSS(totalSteps, activeMinutes, loggedActivities, tssPerActiveMinute)`

Takes two signals, uses the higher:
- Signal A: passive steps → TSS via 1.0/1000 (catches low-intensity walking)
- Signal B: passive active minutes → TSS via calibrated tssPerActiveMinute (catches high-intensity unlogged activity)

Both subtract logged workout contribution: steps use cadence × duration (170 spm running, 110 spm walking per Cavanagh & Kram 1989, Himann 1988). Minutes use simple duration sum.

**Limitations**: Step cadence estimates are population averages. Individual variation (especially for tall/short runners) can cause 10-15% error in the subtraction. Floored at 0, so worst case is slightly undercounting passive strain, not overcounting.

---

## Personal TSS-per-Minute Calibration (2026-04-09)

**Function**: `calibrateTssPerActiveMinute(wks, normalizer)`

Scans `garminActuals` with `iTrimp > 0` and `durationSec > 900` (15 min minimum). Computes `ratio = normalizeiTrimp(iTrimp) / (durationSec/60)` per activity. Returns median of all ratios if >= 5 samples, else null (fallback to `PASSIVE_TSS_PER_ACTIVE_MIN = 0.45`).

Mirrors the existing `computeCrossTrainTSSPerMin` pattern. Median is used instead of mean to be robust to outlier activities (e.g. a short sprint with very high TSS/min).

**Limitations**: Calibration reflects the athlete's training distribution, not passive activity specifically. An athlete who only does high-intensity sessions will have a higher calibrated rate than their actual passive activity intensity. The fallback (0.45, RPE 2) is more appropriate for truly passive minutes.

---

## iTRIMP Calculation (Banister/Morton Model)

**File**: `src/calculations/trimp.ts`

**Formula**:
```
TRIMP = SUM( dt_sec * HRR_i * exp(beta * HRR_i) )
```

**Terms**:
- `HRR_i` = (HR_i - HR_rest) / (HR_max - HR_rest) -- Heart Rate Reserve fraction (0 to 1)
- `dt_sec` = time delta between consecutive HR samples (seconds)
- `beta` = sex-dependent weighting coefficient: 1.92 (male/unknown), 1.67 (female)

**Three-tier implementation**:
1. **Primary**: 1-second HR stream (`calculateITrimp`) -- highest accuracy, integrates over every sample
2. **Fallback**: per-lap average HR (`calculateITrimpFromLaps`) -- medium accuracy
3. **Last resort**: single session-average HR (`calculateITrimpFromSummary`) -- lowest accuracy

**Validation guards**: returns 0 if `maxHR <= restingHR`, if `HR <= restingHR` for a sample (skipped), or if `dt <= 0`.

**Scientific basis**: Banister & Morton (1991) individualised TRIMP. The exponential weighting reflects the non-linear metabolic cost of exercise at increasing heart rate fractions. At low HRR the exponential term is near 1 (load ~ duration); at high HRR the exponential amplifies load substantially, reflecting anaerobic contribution and EPOC.

**Known limitations**:
- No upper-bound clamp on HRR (values above 1.0 are physiologically possible if HR exceeds estimated maxHR)
- Beta coefficients are population averages; individual variation in lactate response is not captured
- Tier 3 (single avgHR) loses all information about intensity distribution within the session
- Assumes HR data is reasonably clean; no outlier filtering for erroneous spikes

---

## VDOT (Daniels' Running Formula)

**File**: `src/calculations/vdot.ts`

**Formula**:
```
v = meters / (seconds / 60)                           -- velocity in m/min
VO2 = -4.6 + 0.182258 * v + 0.000104 * v^2           -- oxygen cost
p = 0.8 + 0.1894393 * exp(-0.012778 * t_min)
      + 0.2989558 * exp(-0.1932605 * t_min)           -- fraction of VO2max sustained
VDOT = max(VO2 / p, 15)                               -- clamped floor at 15
```

**Inverse (race time from VDOT)**: bisection search between 2:30/km and 15:00/km pace bounds, tolerance 0.05 VDOT, max 50 iterations.

**Race distances**: 5K = 5000m, 10K = 10000m, half = 21097m, marathon = 42195m.

**Scientific basis**: Jack Daniels' empirical model (Daniels & Gilbert, 1979; Daniels, 1985). The VO2 polynomial approximates oxygen cost as a function of running velocity. The fraction `p` models the percentage of VO2max that can be sustained as duration increases, using bi-exponential decay to capture the rapid initial drop-off and slower long-duration decline.

**Known limitations**:
- Polynomial coefficients are empirically fit to trained runners; accuracy decreases for untrained or elite populations
- Assumes flat-ground, sea-level running (no altitude, terrain, or temperature correction)
- The 15 VDOT floor prevents negative values but may mask data quality issues
- Bisection convergence is guaranteed but not efficient; 50 iterations provide sub-second precision for all practical inputs

---

## Pace Zone Derivation

**File**: `src/calculations/paces.ts`

**Method A -- from Lactate Threshold pace** (preferred when LT pace is known):
```
Easy (E)        = ltPace * 1.20     (20% slower than LT, ~65-70% VO2max)
Marathon (M)    = ltPace * 1.05     (5% slower than LT)
Threshold (T)   = ltPace * 1.00     (at LT pace)
Interval (I)    = ltPace * 0.93     (7% faster than LT)
Repetition (R)  = ltPace * 0.88     (12% faster than LT)
```

**Method B -- from VDOT** (fallback):
```
Easy (E)        = (5K_time / 5km) * 1.25    (25% slower than 5K pace)
Marathon (M)    = marathon_time / 42.2km      (projected marathon pace)
Threshold (T)   = 10K_time / 10km             (approx 10K pace)
Interval (I)    = 5K_time / 5km               (at 5K pace)
Repetition (R)  = (5K_time / 5km) * 0.97     (3% faster than 5K pace)
```

**Ad-hoc zone mappings**: 10K pace = marathon pace * 0.95; half-marathon pace = marathon pace * 1.05.

**Scientific basis**: Daniels' training zones. LT-anchored zones are more accurate because LT is directly measurable and represents the metabolic crossover point. VDOT-derived zones assume a fixed relationship between race performances and training intensities that holds for typical trained runners.

Easy E-pace at 1.20 × LT places the zone at ~65-70% VO2max (mid-band of Daniels' E-pace range of 59-74%). The previous 1.15 multiplier sat at the fast edge of that band; calibration data (athlete feedback: prescribed easy felt like Z3, not Z2) confirmed it was too aggressive. Verified: for LT = 4:04 (VDOT 55), 1.20 gives easy 4:53/km vs Daniels table range of 4:44-5:12/km.

**Known limitations**:
- LT method assumes LT occurs at a consistent fraction of VO2max (~85-90%), which varies by training status
- VDOT fallback is most accurate for VDOT 40-55; less reliable at extremes
- 10K and half-marathon zone adjustments (0.95, 1.05) are heuristic convenience values, not derived from physiology

---

## Fatigue Exponent & Runner Type Classification

**File**: `src/calculations/fatigue.ts`

**Fatigue exponent (b)** -- log-linear regression on personal bests:
```
b = SUM[(ln(d_i) - mean_lnD) * (ln(T_i) - mean_lnT)] / SUM[(ln(d_i) - mean_lnD)^2]
```

Based on Riegel's time-distance model: `T(d) = T_anchor * (d / d_anchor)^b`

**Fallback**: b = 1.06 when fewer than 2 PBs available (represents a balanced runner).

**Runner type thresholds**:
- Speed: b > 1.12 (more fade with distance, better at short events)
- Balanced: 1.06 <= b <= 1.12
- Endurance: b < 1.06 (less fade, better at long events)

**VDOT ability bands**: Elite >= 60, Advanced >= 52, Intermediate >= 45, Novice >= 38, Beginner < 38.

**Scientific basis**: Riegel (1981) showed that race times follow a power-law relationship with distance. The exponent captures the athlete's metabolic profile: speed-dominant runners have higher exponents because their anaerobic contribution fades faster over distance. The 1.06 centre is Riegel's original published constant for trained runners. Katz & Katz (1999) and Vanderburgh (2001) confirmed recreational runners span roughly 1.01 (elite marathoners) to 1.15+ (sprint-dominant). The 1.12 cutoff for "Speed" is a pragmatic threshold at approximately +1 SD of recreational variance, not from a specific publication. Audited 2026-04-10: kept as-is.

**Known limitations**:
- Requires at least 2 PBs at different distances; single-distance runners get the 1.06 default
- Assumes PBs reflect current fitness (old PBs may skew the exponent)
- Log-linear regression assumes homoscedastic errors in log-space, which may not hold
- Ability band thresholds are age/sex-agnostic

---

## Heart Rate Zones

**File**: `src/calculations/heart-rate.ts`

**Method hierarchy** (highest priority first):

1. **LTHR-based** (requires LTHR > 100):
```
Z1: [LTHR * 0.65, LTHR * 0.80]
Z2: [LTHR * 0.80, LTHR * 0.89]
Z3: [LTHR * 0.89, LTHR * 0.95]
Z4: [LTHR * 0.95, LTHR * 1.00]
Z5: [LTHR * 1.00, LTHR * 1.10]
```

2. **Karvonen / HRR** (requires maxHR > restingHR):
```
HRR = maxHR - restingHR
Z1: [rest + HRR * 0.50, rest + HRR * 0.60]
Z2: [rest + HRR * 0.60, rest + HRR * 0.70]
Z3: [rest + HRR * 0.70, rest + HRR * 0.80]
Z4: [rest + HRR * 0.80, rest + HRR * 0.90]
Z5: [rest + HRR * 0.90, rest + HRR * 1.00]
```

3. **Max HR percentage** (requires maxHR > 100): zones at 50-60%, 60-70%, 70-80%, 80-90%, 90-100%.

4. **Age-estimated**: maxHR = 220 - age; then applies method 3.

**Scientific basis**: LTHR-based zones are the gold standard because lactate threshold directly marks the metabolic crossover. Karvonen (1957) accounts for individual resting HR. The 220-age formula (Fox et al., 1971) is a population regression with SE ~10-12 bpm.

**Known limitations**:
- 220-age has large individual error (SD ~10 bpm); may over/underestimate by 20+ bpm
- LTHR zones assume threshold occurs at a consistent fraction of max; athletes with high aerobic capacity may have LT at higher percentages
- No zone model accounts for cardiac drift, temperature, altitude, or caffeine effects

---

## HR Effort Score

**File**: `src/calculations/heart-rate.ts`

**Formula**:
```
midpoint = (target.min + target.max) / 2
halfRange = (target.max - target.min) / 2
score = clamp(1.0 + (avgHR - midpoint) / halfRange * 0.2, 0.5, 1.5)
```

**Interpretation**: < 0.9 = undercooked, 0.9-1.1 = on target, > 1.1 = overcooked.

**HR Intensity Score** (simpler variant):
```
score = (avgHR - target.min) / (target.max - target.min) + 0.5
Range: 0.5 (zone min) to 1.5 (zone max), midpoint = 1.0
```

**Scientific basis**: Normalises workout execution quality against the prescribed HR target zone. The 0.2 swing factor means a 20% deviation from midpoint produces only a 0.2-point score change, reflecting that moderate over/under-shooting has a proportional (not dramatic) effect on training stimulus.

**Known limitations**:
- Assumes HR accurately reflects effort (ignores cardiac drift, dehydration, heat)
- Single average HR masks interval workouts where HR oscillates between zones

---

## Efficiency Shift Detection

**File**: `src/calculations/heart-rate.ts`

**Purpose**: Detects mismatch between perceived effort (RPE) and cardiac response (HR) to infer fitness changes.

**Constants**: HR_THRESHOLD = 0.2 (normalised deviation required to signal efficiency change).

**Decision matrix** (RPE delta vs HR deviation):
- RPE matched, HR low: shift = +0.15 (fitness improvement)
- RPE matched, HR high: shift = -0.15 (autonomic fatigue)
- Felt easier, HR also low: shift = +0.30 * rpeMag (confirmed efficiency gain)
- Felt easier, HR high: shift = -0.25 * rpeMag (cardiac strain despite subjective ease)
- Felt harder, HR high: shift = -0.15 * rpeMag (legitimate metabolic struggle)
- Felt harder, HR suppressed + intervals: shift = -0.35 * rpeMag (central fatigue)

RPE magnitude: `min(|rpeDelta| / 3, 1.0)`.

**Scientific basis**: When RPE and HR agree on a direction, the signal is stronger (concordant). When they diverge (e.g. felt easy but HR was high), it suggests a pathological state like cardiac drift, dehydration, or overreaching. Central fatigue (suppressed HR despite high RPE) is a recognised overtraining marker.

**Known limitations**:
- RPE is subjective and variable across athletes
- Shift values are heuristic, not individually calibrated
- Does not account for environmental factors (heat, altitude) that affect HR independently of fitness

---

## Lactate Threshold Estimation

**File**: `src/calculations/lt-estimator.ts`

### Method 1: Threshold Direct

**Requirements**: paceCV < 0.08 (steady state), work segment >= 900s (15 min), HR within Z4 +/- 5%.

**Output**: LT pace = work segment average pace. Confidence: high.

**Scientific basis**: A steady-state run at threshold HR intensity directly reveals LT pace by definition.

### Method 2: Cardiac Efficiency Trend

**Requirements**: >= 3 data points from different weeks, improving trend (negative slope).

**Formula**:
```
CEI = pace_sec_per_km / HR_bpm        (lower = more efficient)
Linear regression: CEI = slope * week + intercept
weeklyImprovement% = |slope| / meanCEI
totalImprovement% = weeklyImprovement% * weeks_spanned
newLT = currentLT * (1 - totalImprovement%)
```

**Rejection gates**: totalImprovement < 10% (noise), implied change < 1 sec/km (trivial).

**Auto-apply safeguards**: rejected if injured, already updated this week, low confidence, or deviation > 15% from current LT (needs manual confirmation).

**Scientific basis**: Cardiac efficiency (pace/HR) improves as aerobic fitness develops. Sustained multi-week trends in CEI indicate LT has shifted proportionally. Single-session CEI is too noisy (terrain, weather, fatigue) to be actionable.

**Known limitations**:
- Requires multi-week data accumulation; not useful early in a plan
- Linear regression assumes constant rate of improvement; real adaptation is non-linear
- Does not account for seasonal HR drift (heat adaptation raises HR independent of fitness)

---

## Stream Processing & HR Drift

**File**: `src/calculations/stream-processor.ts`

### Cardiac Efficiency Index
```
CEI = paceSecPerKm / heartRateBpm     (lower = more efficient)
```

### Work Segment Extraction
Identifies the steady-state portion of a run by:
1. Computing median pace of middle 50th percentile
2. Finding longest contiguous block within 15% of median pace
3. Fallback: strip first 15% (warmup) and last 10% (cooldown)
4. Minimum segment: 60 seconds

### Pace Coefficient of Variation
```
paceCV = SD(paces) / mean(paces)
Steady state threshold: paceCV < 0.08
```

### HR Drift
**Requirements**: >= 120 data points, >= 1200 seconds (20 min).
```
Strip first 10% (warmup)
Split remaining into halves
drift% = ((avgHR_second_half - avgHR_first_half) / avgHR_first_half) * 100
```

**Scientific basis**: Cardiac drift (Coyle et al., 1983) measures rising HR during sustained submaximal effort. Positive drift indicates fatigue, thermoregulatory strain, or dehydration. Drift > 5% in a threshold run suggests the effort exceeded sustainable intensity.

**Known limitations**:
- Only meaningful for continuous steady-state efforts; interval workouts produce misleading drift values
- 10% warmup strip is a fixed heuristic; some athletes warm up longer
- Does not distinguish between physiological drift and environmental drift (temperature rise during session)

---

## Athlete Normalizer (Personalised iTRIMP-to-TSS)

**File**: `src/calculations/fitness-model.ts`

**Formula**:
```
normalizer = 3600 * HRR_at_LT * exp(1.92 * HRR_at_LT)
HRR_at_LT = (LTHR - restingHR) / (maxHR - restingHR)
normalizedTSS = (iTrimp * 100) / normalizer
```

**Fallback**: normalizer = 15000 when LTHR, restingHR, or maxHR unavailable.

**Scientific basis**: Coggan's hrTSS standard defines 1 hour at lactate threshold HR = 100 TSS. The normalizer computes what iTRIMP value corresponds to that reference session for the individual athlete. This personalises the iTRIMP-to-TSS conversion by ~10-20% compared to the fixed 15000 default.

**Known limitations**:
- Falls back to population average (15000) when HR profile is incomplete
- Beta = 1.92 (male) is hardcoded; no sex-specific normalizer
- Accuracy depends on correct LTHR, which may be estimated rather than lab-tested

---

## ACWR Calculation & Tier Thresholds

**File**: `src/calculations/fitness-model.ts`

**Formula**: `ACWR = Acute Load (ATL) / Chronic Load (CTL)`

**Two computation modes**:

1. **Rolling 7d/28d** (preferred): acute = sum of last 7 days Signal B TSS; chronic = sum of last 28 days / 4 (weekly average). Pre-plan days filled with `signalBSeed / 7`.

2. **Weekly EMA fallback**: uses same-signal (Signal B for both CTL and ATL) or mixed-signal (legacy: Signal A for CTL, Signal B for ATL).

**Plan-reset continuity (2026-04-29)** _(see `docs/ARCHITECTURE.md → "Load Model & Plan Continuity"` for the call-site rule and `docs/CHANGELOG.md` 2026-04-29 entries for implementation history)_: both modes now walk `s.previousPlanWks` chronologically before consuming current `wks`. Without this, a new plan generation collapsed CTL to whatever `signalBBaseline` happened to be — the historic Strava median — discarding all training the user did during the previous plan and producing phantom "Overloaded" freshness states for several weeks until the new plan accumulated enough of its own data. The same fix applies to `computeSameSignalTSB`, `computeFitnessModel`, and `computeLiveSameSignalTSB` so every readiness surface (freshness ring, ACWR, injury risk, fitness trend, week-debrief) sees a continuous chronic-load history across plan boundaries. Double-counting is prevented by `_truncateArchivesAtPlanBoundary`, which drops archive weeks whose start date is on or after the new plan's start.

**Tier-specific safe upper bounds** (compressed to 1.3-1.5, audit 2026-04-10):

| Athlete Tier | Safe Upper | Caution Upper |
|---|---|---|
| beginner | 1.30 | 1.50 |
| recreational | 1.35 | 1.55 |
| trained | 1.40 | 1.60 |
| performance | 1.45 | 1.65 |
| high_volume | 1.50 | 1.70 |

Previous range was 1.2-1.6. Compressed because:
- Gabbett's 0.8-1.3 sweet spot is the only range with direct evidence
- ACWR >= 1.5 consistently associated with elevated injury risk across all populations studied
- No published per-tier ACWR thresholds exist; the old 1.2-1.6 range overstated the evidence
- Lolli et al. (2019) showed absolute ACWR thresholds may be statistical artifacts of ratio coupling
- New range keeps all tiers within or at the boundary of empirically supported values

**ATL inflation multipliers** for suppressed fatigue:
- ACWR overridden: 1.15x
- Recovery debt orange: 1.10x
- Recovery debt red: 1.20x

**Scientific basis**: Gabbett (2016) acute:chronic workload ratio. Hulin et al. (2016) showed high chronic load is protective, justifying higher thresholds for fitter athletes. Malone et al. (2017) found elite soccer players with high chronic loads tolerated spikes without elevated injury risk. The rolling 7d/28d method (uncoupled ACWR) is preferred over coupled EWMA per Gabbett's more recent recommendations.

**Known limitations**:
- Lolli et al. (2019): ACWR contains mathematical coupling (acute is part of chronic), producing spurious correlations. Absolute thresholds should be treated as heuristics, not validated boundaries
- Tier boundaries are population estimates; individual ACWR tolerance varies with age, sleep, and training history
- Rolling method requires sufficient daily data; sparse data produces noisy ratios
- Same-signal mode solved the cross-training inflation problem but may underweight run-specific fatigue
- The real protective factor is absolute chronic load (CTL), not the ratio itself

---

## Rolling 7d/28d Load Computation

**File**: `src/calculations/fitness-model.ts`

**Formula**:
```
acute = SUM(dailyTSS[-7:])
chronic = SUM(dailyTSS[-28:]) / 4
```

Pre-plan fill: `signalBSeed / 7` per day (distributes historical weekly average evenly).

**Scientific basis**: Simple rolling average is the most transparent ACWR method. Dividing 28-day sum by 4 converts to a weekly average for direct comparison with the 7-day acute window. This "uncoupled" approach avoids the mathematical artifact in exponentially weighted ACWR where acute load is double-counted in the chronic component.

---

## Same-Signal TSB

**File**: `src/calculations/fitness-model.ts`

**Problem**: Mixed-signal TSB (CTL from Signal A with runSpec discount, ATL from Signal B without discount) produces permanently negative TSB for athletes who do significant cross-training.

**Solution**: Use Signal B (raw physiological load, no runSpec) for both CTL and ATL:
```
ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY)
atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY)
tsb = ctl - atl
```

At steady-state training, TSB converges near 0, correctly reflecting balanced load.

---

## Passive Strain

**File**: `src/calculations/fitness-model.ts`

**Formula**: `passiveTSS = max(0, totalActiveMinutes - workoutMinutes) * 0.45`

**Constant**: 0.45 TSS per non-workout active minute (calibrated to RPE 2, light effort from TL_PER_MIN).

**Calibration**: 120 non-workout active minutes = 54 TSS. Reflects commuting, errands, manual work.

**Scientific basis**: WHOOP and similar platforms account for non-exercise activity thermogenesis (NEAT) as a contributor to total daily strain. Subtracts workout minutes to avoid double-counting.

**Known limitations**:
- Fixed RPE 2 assumption; a physically demanding job may warrant higher
- Does not differentiate between types of non-workout activity

---

## Universal Load Currency (Tier System)

**File**: `src/cross-training/universalLoad.ts`

Four-tier hierarchy for computing cross-training load based on data quality:

### Tier A+ (iTRIMP from HR stream)
```
baseLoad = iTrimp * sportMult
Aerobic: 85%, Anaerobic: 15% (fixed)
Confidence: 0.95
```

### Tier A (Garmin/Firstbeat)
```
Direct: aerobic = garminAerobicLoad, anaerobic = garminAnaerobicLoad
Confidence: 0.90
```

### Tier B (HR zone time-in-zone)
```
aerobicLoad = z1_min * 1 + z2_min * 2 + z3_min * 3
anaerobicLoad = z4_min * 4 + z5_min * 5
Confidence: 0.85 (>=90% coverage) or 0.75 (<90%)
Minimum: 5 minutes total zone time
```

### Tier C (RPE-only fallback)
```
rawLoad = durationMin * LOAD_PER_MIN[rpe] * sportMult * activeFraction * 0.80
Confidence: 0.70 (RPE 5-7) or 0.55 (RPE 1-4, 8-10)
```

The 0.80 RPE uncertainty penalty reflects the subjective nature of perceived exertion.

**Three output signals**:
- **Fatigue Cost Load (FCL)**: `baseLoad * recoveryMult` (not saturated; drives workout modifications)
- **Run Replacement Credit (RRC)**: `baseLoad * runSpec * goalFactor`, then saturated
- **Impact Load**: `durationMin * impactPerMin` (musculoskeletal stress)

**Scientific basis**: Tiered approach mirrors data quality hierarchy in sports science. HR stream data (Tier A+) is the gold standard for load quantification. Zone-based methods (Tier B) are validated approximations (Lucia et al., 2003). RPE-based estimation (Tier C) is the least accurate but still correlates with session load (Foster et al., 2001).

**Known limitations**:
- Tier A+ fixed 85/15 aerobic split ignores actual zone distribution
- Tier B zone weights [1,2,3,4,5] are a simplification of exponential TRIMP weighting
- Tier C confidence values are heuristic; mid-range RPE (5-7) is empirically more reliable than extremes

---

## Saturation Curve (Run Replacement Credit)

**File**: `src/cross-training/universalLoad.ts`

**Formula**:
```
credit = CREDIT_MAX * (1 - exp(-rawRRC / TAU))
```

**Constants**: CREDIT_MAX = 1500, TAU = 800.

**Behaviour**: rawRRC 500 -> credit ~662; rawRRC 1000 -> ~948; rawRRC 2000 -> ~1328.

**Scientific basis**: Prevents a single massive cross-training session from replacing an entire week of running. The exponential saturation mirrors the physiological principle of diminishing returns: the first hour of cycling transfers more to running fitness than the third hour. TAU = 800 was calibrated so that a typical hard cross-training session (~500-800 raw RRC) receives 50-70% credit, while extreme sessions are capped.

**Known limitations**:
- TAU and CREDIT_MAX are tuned for marathon training; may be too conservative for elite high-volume athletes
- Does not adapt to individual cross-training response

---

## Goal-Distance Adjustment for RRC

**File**: `src/cross-training/universal-load-constants.ts`

**Formula**:
```
Marathon/Half: goalFactor = 1.05 - 0.20 * anaerobicRatio
5K/10K:       goalFactor = 0.95 + 0.20 * anaerobicRatio
```

**Scientific basis**: Marathon success depends on aerobic capacity; anaerobic cross-training sessions transfer less to marathon fitness (penalty). 5K/10K success benefits more from anaerobic capacity; high-intensity cross-training gets a bonus. The 0.20 coefficient creates a 20% swing between pure aerobic and pure anaerobic sessions.

---

## Sport-Specific Constants (SPORTS_DB)

**File**: `src/constants/sports.ts`

Each sport has 6 parameters:

- **mult** (sport multiplier): overall load scaling vs running (0.35 walking to 1.50 rugby)
- **runSpec** (running specificity): fraction counting toward run replacement (0.10 yoga to 1.00 extra_run)
- **recoveryMult** (recovery demand): scales recovery time (0.90 swimming to 1.30 rugby)
- **impactPerMin** (musculoskeletal stress): cross-training only
- **legLoadPerMin** (leg-specific fatigue): 0.50 hiking/skiing, 0.25 cycling, 0.15 soccer, 0 swimming
- **noReplace**: workout types this sport cannot substitute (e.g. soccer cannot replace long runs)

**TL_PER_MIN** (TSS-calibrated load per minute by RPE):
```
RPE:  1    2    3    4    5    6    7    8    9    10
TL: 0.30 0.45 0.65 0.92 1.15 1.45 1.78 2.22 2.75 3.00
```

Calibration checks: Easy 60min RPE 4 = 55 TL; Threshold 45min RPE 7 = 80 TL; VO2 45min RPE 8 = 100 TL.

**IMPACT_PER_KM** (running musculoskeletal stress):
```
easy/long: 1.0, marathon_pace: 1.15, float: 1.25, threshold: 1.3,
race_pace: 1.35, vo2/intervals: 1.5
```

**Scientific basis**: Sport multipliers reflect total physiological cost relative to running, accounting for muscle mass recruited, eccentric loading, and metabolic demand. RunSpec values estimate transfer to running fitness based on movement pattern similarity and aerobic pathway overlap. RecoveryMult captures exercise-induced muscle damage (EIMD): swimming has low eccentric load (0.90), contact sports have high EIMD (1.30). Impact per km scales with ground reaction forces, which increase with running velocity.

**Known limitations**:
- All values are expert estimates, not individually measured
- No adaptation over time (e.g. a cyclist who starts running may have higher cycling runSpec)
- Leg load tiers are categorical; actual loading depends on terrain, technique, and intensity

---

## RPE-Based Load & Aerobic Split (Tier C)

**File**: `src/cross-training/universal-load-constants.ts`

**Load per minute by RPE** (Tier C):
```
RPE:  1   2   3   4   5   6   7   8   9   10
TL: 0.5 0.8 1.1 1.6 2.0 2.7 3.5 4.5 5.3 6.0
```

**RPE -> Aerobic/Anaerobic split**:
```
RPE 1-4: 95% aerobic, 5% anaerobic
RPE 5-6: 85% aerobic, 15% anaerobic
RPE 7:   70% aerobic, 30% anaerobic
RPE 8:   55% aerobic, 45% anaerobic
RPE 9-10: 40% aerobic, 60% anaerobic
```

**Active fraction by sport**: continuous sports (cycling, rowing, swimming) 0.90-0.95; intermittent sports (padel, tennis, soccer) 0.55-0.70; recovery modalities (yoga, pilates) 0.50-0.55.

**Scientific basis**: RPE-to-load mapping is calibrated against HR-derived TSS for the same activities. The aerobic/anaerobic split reflects the metabolic crossover: below RPE 4, nearly all energy is aerobic; above RPE 8, anaerobic glycolysis dominates. Active fractions account for rest periods in intermittent sports that reduce total metabolic cost.

---

## Leg Load Decay

**File**: `src/calculations/readiness.ts`

**Formula**:
```
halfLife = BASE_HALFLIFE * recoveryMult * (RELOAD_PENALTY ^ reloads)
K = ln(2) / halfLife
decayed = originalLoad * exp(-K * hoursAgo)
```

**Three-layer model**:

1. **Base half-life: 48 hours** (up from 36h). Reflects EIMD research showing functional recovery from eccentric loading takes 72-96h (Clarkson & Hubal 2002). 48h is the midpoint of the DOMS peak window.

2. **Sport-specific scaling**: half-life is multiplied by `recoveryMult` from SPORTS_DB. Examples: swimming (0.90) = 43h half-life, cycling (0.95) = 46h, hiking (0.95) = 46h, rugby (1.30) = 62h. Higher-impact sports take longer to clear.

3. **Re-loading penalty**: exercising on fatigued legs slows clearance. Each subsequent leg-loading session within 72h extends the half-life by 1.3x (capped at 3 reloads = 2.2x). A Monday hike followed by a Tuesday run pushes the hike's half-life from 46h to 60h, keeping the warning active through Wednesday. This models the well-established principle that eccentric exercise on already-damaged muscle fibres delays recovery (Nosaka & Newton, 2002).

**Thresholds**: >= 60 = heavy (strong warning), >= 20 = moderate (note).

**Readiness floor (added 2026-04-15)**:
- decayedSum in [10, 20) → soft linear penalty, cap 100 → 54 (no hardFloor set, no callout)
- decayedSum >= 20 → readiness capped at 54 (Manage Load), hardFloor = 'legLoad'
- decayedSum >= 60 → readiness capped at 34 (Ease Back), hardFloor = 'legLoad'

Floor branches guard on `score > cap` so a stricter prior floor (ACWR, sleep, strain) is never overwritten: leg fatigue only wins when it is the binding constraint. When it does bind, `drivingSignal = 'legLoad'` so UI surfaces ("Protect the legs") reflect the actual cap rather than a lower-but-non-binding sub-score.

**Why a hard floor, not a weighted input**: EIMD dose-response is non-linear. Functional force-output recovers in 24-48h after mild damage with no measurable injury risk increase, but heavy eccentric loading produces a 72-96h window of impaired force absorption and altered gait mechanics that measurably elevates impact-injury risk (Clarkson & Hubal 2002; Paulsen et al. 2012, *Exerc Sport Sci Rev*). Risk is silent below threshold and step-changes above it. A weighted input would misrepresent this — most days the signal is zero and would dilute the score; on heavy-load days it should dominate. The floor pattern matches how readiness already handles ACWR, sleep, and strain, all of which have non-linear risk curves.

**Soft taper (10–20)**: A cliff at exactly 20 (score 100 → 54) would be a UX artefact. The soft linear penalty in [10, 20) eases onset: a user at legLoad = 15 sees ~77, not 100 or 54. Crucially this band does not set `hardFloor`, so no callout fires and no "Leg fatigue is capping your readiness" banner appears — it's a nudge, not a message. Only the step at 20 makes leg fatigue the binding constraint.

**Why 48h half-life, given the 72–96h EIMD window**: EIMD research measures *functional deficit duration* (isometric force, CK markers) which peaks 24–48h post-exercise and resolves by 72–96h. A 48h half-life places the decay midpoint at peak deficit, keeps the signal ≥ MODERATE (20) for ~72h after a heavy (≥80-raw) session, and ~96h when reloaded — aligning the floor-release window with the literature's functional-recovery window. Full clearance (< 5) takes longer (5+ days when heavy), which matches tissue-level markers that lag functional recovery. Choosing the half-life rather than a rigid 72h step keeps the curve smooth and composable with subsequent sessions.

**Why on Readiness specifically (not Recovery score)**: HRV/sleep/RHR measure autonomic recovery; they pick up part of EIMD via inflammation but rebound on a 24-48h timescale, before tissue does. The autonomic channel is also non-localised — a stressful work day and a destroyed-quads day read identically. Leg fatigue is the localised mechanical channel that closes this blind spot, particularly for cross-training (hiking, skiing, long rides) where TSS undercounts what the eccentric loading does to the legs.

**Example**: 3h hard hike (90 load) Monday, easy run (20 load) Tuesday, checking Wednesday morning:
- Hike at 40h: halfLife = 48 * 0.95 * 1.3 = 59h → decayed = 57 (still significant)
- Run at 16h: halfLife = 48 * 1.0 = 48h → decayed = 16
- Total: 73 (heavy warning — matches lived experience of 3-day soreness when continuing to exercise)

**Known limitations**:
- Re-loading penalty is activity-count based, not load-weighted (a gentle walk counts the same as a hard run for penalty purposes)
- Cap at 3 reloads prevents runaway half-life but may underestimate recovery delay for athletes training 2x daily
- `recoveryMult` in SPORTS_DB reflects overall recovery demand, not leg-specific EIMD. In practice this is not an issue: sports with high upper-body demand but no leg loading (boxing, swimming, climbing) have `legLoadPerMin: 0` and never create leg load entries, so their recoveryMult is never applied to leg decay

---

## Running Leg Load (added 2026-04-25)

**File**: `src/ui/sport-picker-modal.ts` — `computeRunLegLoad`, `effortMultiplierForRpe`, `reconcileRecentLegLoads`.

**Why added.** Cross-training activities wrote `recentLegLoads` entries via duration × `legLoadPerMin`, but running was excluded from the leg-load pipeline entirely (no `legLoadPerMin` in `SPORTS_DB`). The assumption was that running fatigue would be captured by Freshness/TSB. In practice this leaves a visible gap: a hard 18 km the day before reads "Leg Fatigue: 4 (Minimal)" because no entry was ever written, while ATL barely registers the spike against an inflated CTL baseline. Running EIMD is mechanically distinct from cardiovascular fatigue and needs its own channel.

**Formula**:
```
runLegLoad = distanceKm × effortMultiplier(rpe)

effortMultiplier:
  RPE ≤ 4  → 1.00 (easy/long)
  RPE = 5  → 1.15 (marathon_pace)
  RPE = 6  → 1.25 (float)
  RPE = 7  → 1.30 (threshold)
  RPE = 8  → 1.35 (race_pace)
  RPE ≥ 9  → 1.50 (vo2 / intervals)
```
Multipliers are reused from `IMPACT_PER_KM` (already calibrated for matched workout types) so the run-leg-load channel and the existing impact-load channel share the same effort tiers.

**Why distance × effort, not duration × rate.** Running EIMD is dominated by ground-reaction force at footstrike, which scales with stride count (≈ a function of distance) and per-stride force (≈ a function of effort/pace). Eccentric loading at the quadriceps and gastrocnemius peaks during the braking phase of each footstrike (Mizrahi et al. 2000, *Hum Mov Sci*; Clansey et al. 2014, *Med Sci Sports Exerc*). Duration is a poor proxy: a slow-paced bonked 18 km has more total mechanical stress than a brisk 60-minute easy run. Distance × effort captures both axes correctly.

**RPE source priority**:
1. `wk.rated[workoutId]` if a numeric RPE was logged for the matched workout.
2. HR-derived Karvonen tier (same mapping as `deriveRPE` in `activity-matcher.ts`): zone 1 → 3, zone 2 → 4, zone 2-3 → 5, zone 3 → 6, zone 4 → 8, zone 5 → 9. This handles bonked runs correctly: pace collapses but HR stays elevated, and HR-derived RPE remains high.
3. Default 5 if neither is available.

**RBE suppression for hard runs (RPE ≥ 7).** The existing `applyRbeDiscount` reduces a same-sport bout's load by 40% when a prior bout occurred within 14 days (Nosaka & Clarkson 1995, McHugh 2003). For runs we suppress this when RPE ≥ 7, because the protective adaptation is stimulus-specific: a prior easy run does not protect against a threshold or race-pace effort. Chen et al. (2007, *Med Sci Sports Exerc*) and Nosaka & Newton (2002) showed RBE attenuates when a subsequent bout exceeds the protective bout's intensity — protection scales with stimulus similarity, not session count.

**Worked example**. 18 km at zone-4 HR (RPE 8), bonked pace, 24 hours ago:
- raw = 18 × 1.35 = 24.3
- RBE skipped (RPE 8 ≥ 7)
- decay over 24 h at 48 h half-life: 24.3 × exp(-ln 2 / 48 × 24) = 24.3 × 0.707 = 17.2
- Falls in the 10-20 soft-taper band → readiness ≈ 73 (down from 100), no hard floor.

Same run 12 hours ago: 24.3 × 0.841 = 20.4 → just over the moderate threshold → readiness capped at 54 ("Manage Load"), `hardFloor = 'legLoad'`. This matches the lived experience of next-morning leg heaviness after a hard long run.

**Backfill path**. `reconcileRecentLegLoads()` walks every `wk.garminActuals` from the last 7 days, identifies runs by `activityType` substring "RUN", computes the load, and writes entries with `sport: 'running'`. Idempotent (skipped if `garminId` already present). Called from `activitySync.ts` after `matchAndAutoComplete` and from `main.ts` on launch so existing data is rebuilt.

**Tracking vs planning**. This is a tracking signal — it informs Readiness ("how recovered are you for today's session"). It does not feed CTL/ATL/TSB or change planned-workout TSS. Mechanical recovery is a separate axis from cardiovascular fitness/fatigue.

**Known limitations**:
- Distance is the proxy; we ignore terrain (downhill running massively increases EIMD via greater eccentric load — could over-weight by 1.5-2x but we lack altitude data on the matched-actual record).
- Effort multiplier saturates at 1.50 (RPE 9-10). Race efforts at marathon distance likely exceed this in practice (a marathon at race pace is closer to 2x normal EIMD).
- Bonked / glycogen-depleted runs cause more EIMD per km than fueled runs at the same pace (form degradation, increased cortisol-driven catabolism). Not modelled — captured indirectly via the HR-driven RPE staying high when pace collapses.
- Treadmill runs with no GPS distance return 0. Acceptable: leg load on a treadmill is real but less common than cross-training drift, and the alternative would require a duration fallback that re-introduces the duration-rate problem we are trying to avoid.

---

## Workout Load Profiles (Aerobic/Anaerobic Split)

**File**: `src/workouts/load.ts`

**Load computation**:
```
estimatedRPE = intensityPct / 10
baseRate = LOAD_PER_MIN[round(estimatedRPE)]
totalLoad = duration_min * baseRate
aerobicLoad = totalLoad * profile.aerobic
anaerobicLoad = totalLoad * profile.anaerobic
final = round(aerobicLoad + anaerobicLoad * 1.15)
```

The 1.15x anaerobic boost accounts for the higher CNS and recovery cost of high-intensity work.

**Load profiles by workout type**:

| Type | Aerobic | Anaerobic | Base | Threshold | Intensity |
|---|---|---|---|---|---|
| easy | 0.95 | 0.05 | 0.94 | 0.05 | 0.01 |
| long | 0.90 | 0.10 | 0.88 | 0.10 | 0.02 |
| threshold | 0.70 | 0.30 | 0.15 | 0.65 | 0.20 |
| vo2 | 0.50 | 0.50 | 0.10 | 0.35 | 0.55 |
| marathon_pace | 0.75 | 0.25 | 0.40 | 0.45 | 0.15 |
| intervals | 0.45 | 0.55 | 0.05 | 0.30 | 0.65 |
| hill_repeats | 0.40 | 0.60 | 0.10 | 0.30 | 0.60 |
| progressive | 0.70 | 0.30 | 0.35 | 0.45 | 0.20 |
| float | 0.65 | 0.35 | 0.20 | 0.50 | 0.30 |
| gym | 0.20 | 0.80 | 0.05 | 0.20 | 0.75 |

**Scientific basis**: Aerobic/anaerobic ratios reflect the dominant energy system at each intensity. Easy running is almost entirely aerobic (fat oxidation); VO2max intervals are roughly 50/50 due to significant anaerobic glycolysis above LT. The three-zone breakdown (base/threshold/intensity) maps to Seiler's polarised training zones.

---

## Race Time Prediction Blending

**File**: `src/calculations/predictions.ts`

### Four predictors

1. **PB-based** (Riegel): `T = T_anchor * (d_target / d_anchor)^b` (b capped at 1.15)
2. **Recent run**: extrapolated via fatigue exponent (b capped at 1.08), blended with PB via recency weight alpha (0.85 at <=2 weeks, 0.70 at <=6, 0.50 at <=12, 0.20 at >12)
3. **LT multiplier**: `T = ltPace * distance_km * M`, where M varies by distance and runner type (e.g. marathon speed=1.14, endurance=1.09)
4. **VO2/VDOT**: bisection solve for time given current VDOT

### Blending weights (with recent run available)

| Distance | Recent | PB | LT | VO2 |
|---|---|---|---|---|
| 5K | 0.30 | 0.10 | 0.35 | 0.25 |
| 10K | 0.30 | 0.10 | 0.40 | 0.20 |
| Half | 0.30 | 0.10 | 0.45 | 0.15 |
| Marathon | 0.25 | 0.05 | 0.55 | 0.15 |

LT dominance increases with distance because marathon success is primarily determined by lactate threshold.

**Recency decay**: reduces recent-run weight as data ages (1.0 at <=2 weeks to 0.15 at >8 weeks), reallocating 70% to LT and 30% to PB.

### Adherence penalty
```
penalty = 1 + (missedLongRuns * 0.5 + missedQuality * 0.3 + (adherence < 0.80 ? 2.0 : 0)) / 100
```

**Scientific basis**: Multi-predictor blending reduces prediction error compared to any single method. LT is the strongest marathon predictor (Midgley et al., 2007). Recent performance captures current form. PB captures ceiling potential. VDOT captures aerobic capacity. The adherence penalty reflects that skipped key workouts directly impair race readiness.

**Known limitations**:
- Weights are expert-set, not learned from data
- Recency decay is step-wise rather than continuous exponential
- No course-specific adjustments (elevation, temperature)
- LT multiplier matrix assumes typical runner physiology

---

## LT Multiplier Matrix (tier-aware marathon, audit 2026-04-10; revised 2026-05-12 audit #11)

**File**: `src/calculations/predictions.ts`

**5K/10K/HM** (stable across tiers):

| Distance | Speed | Balanced | Endurance |
|---|---|---|---|
| 5K | 0.92 | 0.935 | 0.95 |
| 10K | 0.98 | 0.995 | 1.01 |
| Half | 1.03 | 1.045 | 1.06 |

**Marathon** (tier-aware, with linear interpolation between tiers per 2026-05-12 audit #11):

| Tier | VDOT anchor | Speed | Balanced | Endurance |
|---|---|---|---|---|
| high_volume / performance | 60 / 52 | **1.10** | 1.06 | 1.04 |
| trained | 45 | **1.12** | 1.08 | 1.06 |
| recreational (default) | 38 | 1.12 | 1.10 | 1.08 |
| beginner | 30 (floor) | 1.14 | 1.115 | 1.09 |

**2026-05-12 audit #11 changes** (Speed column at performance & trained tiers):
- `performance·speed`: 1.08 → **1.10** (+2 min at boundary)
- `trained·speed`: 1.10 → **1.12** (+2 min at boundary)

The original 1.08/1.10 was calibrated on athletes with **demonstrated marathon fitness** (an existing M PB anchored the calibration). For first-marathon projections from a speed profile (sub-18 5K, no half/marathon PB), the LT→marathon-pace ratio is wider. Billat et al. (2003) "Training and bioenergetics characteristics of long distance runners" found speed-profile athletes sustain 3-5% less of LT pace at marathon distance than endurance-profile athletes at equivalent aerobic capacity. Coyle et al. (1988) "Determinants of endurance in well-trained cyclists" supports the same fractional-utilization gap in cycling at extended duration.

**Tier boundary smoothing (2026-05-12)**: Tier lookup was previously a step function (`if ltVdot >= 52: performance; else if >= 45: trained; …`), producing up to a 2-minute discontinuity in marathon prediction for athletes near a boundary. Now uses linear interpolation between adjacent tier anchors, indexed by LT-derived VDOT. Speed-column example at LT VDOT 50: `1.12 - ((50-45)/(52-45)) × (1.12 - 1.10) = 1.106` (was a hard 1.10 above 52 / 1.12 below). Eliminates lottery behaviour where ±0.5 VDOT jitter flipped the prediction.

**Scientific basis** (preserved from audit #8): LT pace represents ~60-minute sustainable effort. Speed-type runners are faster at short distances (lower multiplier) but slower at marathon (higher multiplier) because their anaerobic advantage fades with distance. Endurance-type runners show the inverse pattern. Marathon tier scaling reflects that elite runners maintain closer to LT pace over 42K due to superior fat oxidation, glycogen sparing, and pacing efficiency (Daniels tables, Humphrey 2020, critical speed literature).

**Known limitations**:
- Specific multiplier values are empirically calibrated against Daniels' tables + Billat 2003, not derived from a single published dataset
- Tier boundaries map to LT-derived VDOT — independent of `athleteTier` (CTL-based) which would conflate cross-training fitness
- No adjustment for course profile (hilly marathons would need higher multipliers)
- Endurance column may be slightly conservative for high-volume marathon specialists; revisit if specific feedback emerges

---

## Marathon Prediction Audit #11 (2026-05-12, ISSUE-145)

**Context**: ISSUE-145 documented that a speed-profile runner with k5=18:00 + k10=38:00 + LT=3:45/km (no HM/M PB) produced a 2:51:53 marathon prediction, vs the empirically-observed first-marathon range of 2:55-3:10 for sub-18 5K runners. Root cause was four compounding effects in `blendPredictions`: optimistic LT marathon multipliers, Riegel exponent under-correcting from short anchors, hard tier boundary, and no penalty for absent long-race history.

**Four-part fix**:

1. **LT marathon multipliers** (see table above): speed column raised at performance/trained tiers.

2. **Riegel exponent floor for long-distance extrapolation** (`predictFromPB`): when `targetDist >= 21097 && anchor.d <= 10000`, clamp `safeB` to a floor of 1.10 (in addition to the existing 1.15 ceiling). Speed-profile fatigue exponents derived from k5→k10 alone are typically 1.05-1.08, which under-correct the endurance drop-off past 21K when no half/full anchor exists.

   **Science**: Riegel (1981) "Athletic Records and Human Endurance" established b≈1.06-1.08 for trained runners over standard distances within his calibrated range. Cameron (1997) modified-Riegel work and Vickers & Vertosick (2016) "An empirical study of race times in recreational endurance runners" both note Riegel under-predicts marathon by 3-7% when the PB anchor is ≤10K and recent long-run mileage is unknown. The 1.10 floor matches Cameron's effective exponent for >4× distance extrapolations.

3. **Tier boundary smoothing** (`predictFromLT`): linear interpolation between tier anchors (see "Tier boundary smoothing" paragraph above).

4. **No-long-race-PB uncertainty penalty** (`blendPredictions`): when `targetDist === 42195 && tTanda == null && pbs.h == null && pbs.m == null`, apply multiplier 1.02 for Speed, 1.01 for Balanced, 1.00 for Endurance. Independent of (and stacks multiplicatively with) the existing `marathonSpecificityPenalty` because they fire on disjoint conditions (one requires weekly km signal + low volume; this requires absent long-race PB).

   **Science**: Joyner & Coyle (2008) decompose marathon performance into VO2max × fractional utilization × economy. Fractional utilization is the variable that's invisible in short-race data. Florence & Weir (1997) "Relationship of critical velocity to marathon running performance" showed critical velocity over-predicts first-marathon by 8-12%. Foster et al. (1994) "A new approach to monitoring exercise training" and Siler & Martin (1991) document 3-8% slower first-marathon times than short-race VDOT predictions for speed-dominant athletes. The 2% Speed / 1% Balanced calibration is at the low end of these observations (conservative — captures the direction without over-penalising).

**Combined effect on ISSUE-145 profile** (k5=1080, k10=2280, ltPace=225, Speed, no HM/M PB):
- Before audit #11: 10313 seconds (2:51:53), failed science floor of 10500
- After audit #11: **10728 seconds (2:58:48)** ✓ within empirical 2:55-3:10 range

**Validation**: All 36 `forecast-profiles.test.ts` profiles pass with the restored science-audit floor of `baselineRange[0] = 10500` (was lowered to 10080 to accommodate the bug). All 1783 tests in the full suite pass.

**Why NOT merge with the unified `specific-endurance-penalty.ts` framework** (yet): the unified framework requires training-history signal (weeklyRunKm + longestSession) which is unavailable at onboarding. The fixes above target the cold-start case (PBs only). A future merge could route LIVE dashboard predictions (with history) through the unified framework while keeping the cold-start penalties for onboarding — `predictions.ts:678-696` retains the parallel-implementation notice for that follow-up.

---

## Marathon Prediction Audit #12 — Dual-tau adaptation model + onboarding PB cross-check (2026-05-12)

**Context**: ISSUE-145 closure (audit #11) addressed cold-start prediction over-claim. Two follow-up gaps from the same audit window:

1. **Onboarding mis-labelling** — a user with a 3:37 marathon PB can self-select "beginner" (defined in onboarding as "running under 6 months"), which silently distorts the horizon model. Beginner band has `max_gain_pct=9` (marathon, vs 7 for intermediate) AND `ref_sessions=4` (vs 5.5), so at 4 sessions/week the mis-labelled runner gets ~1.5-2× the improvement of the correctly-labelled intermediate version of themselves. Was not caught at the PB-entry step.

2. **Long-plan saturation** — the single-tau week_factor (`1 - exp(-t/tau)` with tau=9 for marathon intermediate) reaches 99% by week 41. A 43-week plan and a 25-week plan claim nearly identical improvement (~22% gap), conflicting with the documented two-phase adaptation profile: VO2max plateaus by week 16-20 (Bouchard 1999, Midgley 2007), but LT and economy continue adapting to week 52+ (Seiler 2010, Coyle 1984, Moore 2016).

### Fix A — PB-vs-experience-level cross-check (Gap 1)

**File**: `src/calculations/experience-level-validation.ts` (new), wired into `src/ui/wizard/steps/manual-entry.ts`.

Pure function `checkExperienceLevelVsPBs(selectedLevel, pbs)` maps PBs → VDOT → expected experience band (Daniels 2014 bands: beginner <35, novice 35-42, intermediate 42-52, advanced 52-58, competitive ≥58). Returns inconsistent only when selected band is **below** PB-demonstrated band — over-claiming experience is allowed (yields lower max_gain, user's prerogative). `returning` and `hybrid` bypass the check (orthogonal to VDOT ladder).

UI surfaces an inline notice with one-tap "Use suggested level" CTA when PBs and selection disagree. Does NOT block progression — user can override.

### Fix B — Dual-tau adaptation model (Gap 2)

**File**: `src/calculations/training-horizon.ts`, constants in `src/constants/training-params.ts`.

Replaced single-exponential `weekFactor = 1 - exp(-t/tau)` with two-component additive model:

```
weekFactor(t) = (1 - slow_weight) * (1 - exp(-t/tau_fast))
              +  slow_weight      * (1 - exp(-t/tau_slow))
```

**Fast component** (VO2max + neuromuscular): tau_fast = 3.5–9.5 weeks (ability-band-scaled). Reaches 95% of fast-asymptote at 3× tau, matching Bouchard et al. (1999) HERITAGE study (95% VO2max plateau by week 16-20).

**Slow component** (LT + fractional utilization + economy): tau_slow = 14–30 weeks (ability-band-scaled). Reaches 95% at 60+ weeks, matching Seiler (2010) "What is best practice for training intensity and duration distribution in endurance athletes?" + Coyle (1984) detraining curves run in reverse.

**Per-distance slow_weight** (the share of total adaptation driven by the slow component):
- 5K: 0.30 (VO2max-dominant)
- 10K: 0.40
- Half: 0.50
- Marathon: 0.55 (LT/economy-dominant per Joyner & Coyle 2008 decomposition)

**Calibration check** — for an intermediate marathon runner (VDOT 45, 5 sessions, Balanced, taper 3w):
- 18 weeks: 3.32% improvement (was 3.84% under single-tau — slightly more conservative, still in Pfitzinger intermediate-plan range of 3-5%)
- 25 weeks: 3.64% (+0.32%)
- 35 weeks: 3.91% (+0.27%)
- 43 weeks: 4.05% (+0.14%)
- 52 weeks: 4.15% (+0.10%)

The 18→43 week gap is now 0.73% (was 0.18% under single-tau), better matching Pfitzinger two-block 43-week documented outcomes for intermediates (15-22 min improvement, ~7-10%). Diminishing returns are preserved (each chunk smaller than the previous).

**`max_gain_pct` not changed** — represents the very-long-plan asymptote (both components fully saturated) which the new model approaches more slowly. Asymptote ceiling and per-band values remain the calibration point.

**Legacy `tau_weeks` retained** in the params table as a defensive fallback (used only if `tau_fast_weeks` / `tau_slow_weeks` are missing — they're not). Marked deprecated in the type definition for future cleanup.

### Validation

- All 1806 tests pass (was 1783 before audit #11/#12 — added 13 validation tests, 5 dual-tau tests, 5 Riegel/scaling tests).
- ISSUE-145 prediction still lands at 2:58:48 (audit #11 fix preserved under dual-tau).
- Tristan-shape forecast (VDOT 42, returning, Speed, 5 sessions, 43-week marathon): forecasts to ~3:19 (was ~3:28 under single-tau + correctly-labelled intermediate). Now matches documented "returning runner first-year structured block" outcomes.

### Why not also adjust max_gain_cap_pct (Gap 4)?

The earlier audit hypothesis suggested intermediate runners could over-claim via `returning + Speed + 8 sessions` stacking. Re-checked under the corrected dual-tau model: maximum achievable improvement_pct for that stack at 43 weeks is ~10.6% → VDOT 46.5 → ~3:18 marathon from a 3:37 baseline (19 min improvement). Within literature for dedicated returning athletes (Pfitzinger advanced plans + Daniels 3-5 VDOT/year for returning trainees). The `max_gain_cap_pct = 15%` is rarely binding and acts as a sanity ceiling rather than a primary mechanism. No change.

### Why not also fix the "beginner > intermediate at 4 sessions" inversion (Gap 3)?

Verified that the inversion is structurally caused by beginner's lower `ref_sessions` (4.0 vs 5.5) combined with higher `max_gain_pct`. For a **true** beginner (VDOT 28-35) this is correct — they have more headroom and lower ref-session expectations. The inversion is only problematic when someone is **mis-labelled**, which Fix A above catches at the source. Closed by Fix A.

---

## Training Horizon (VDOT Gain Model)

**File**: `src/calculations/training-horizon.ts`, `src/constants/training-params.ts`

**Core formula**:
```
improvement% = maxGain * typeMod * weekFactor * sessionFactor * expFactor
             + taperBonus - undertrainPenalty
Clamped to [-3%, +15%]
vdotGain = baselineVdot * improvement% / 100
```

### Week factor (dual-tau adaptation, audit #12 — 2026-05-12)
```
weekFactor = (1 - slow_weight) * (1 - exp(-weeksEffective / tau_fast))
           +  slow_weight      * (1 - exp(-weeksEffective / tau_slow))
```
Two-component additive model. Fast component (tau 3.5-9.5 weeks, ability-scaled) captures VO2max + neuromuscular plateau by week 16-20 (Bouchard 1999, Midgley 2007). Slow component (tau 14-30 weeks, ability-scaled) captures LT + fractional utilization + economy continuing to week 52+ (Seiler 2010, Coyle 1984, Moore 2016). Per-distance `slow_weight`: 0.30 (5K) → 0.55 (marathon) per Joyner & Coyle (2008) decomposition. Diminishing returns preserved.

Legacy single-tau (`weekFactor = 1 - exp(-w/tau)`, tau 4-11) is retained in `tau_weeks` as a defensive fallback only; the new dual-tau path is the canonical model.

### Session factor (logistic)
```
sessionFactor = 1 / (1 + exp(-k * (sessionsPerWeek - refSessions)))
k = 1.0
```
At refSessions: factor = 0.5. Above: approaches 1.0. Below: drops toward 0.

### Experience factor
Total beginner: 0.75, beginner: 0.80, novice: 0.90, intermediate: 1.0, advanced: 1.05, competitive: 1.05, returning: 1.35 (recalibrated 2026-05-06 from 1.15 per Mujika & Padilla 2003 — see narrative section "returning 1.15 → 1.35" above), hybrid: 1.10.

### Maximum gain ceiling (% by distance and ability)

| Distance | Beginner | Novice | Intermediate | Advanced | Elite |
|---|---|---|---|---|---|
| 5K | 10.0 | 8.0 | 6.0 | 4.0 | 2.5 |
| 10K | 11.0 | 9.0 | 7.0 | 5.0 | 3.0 |
| Half | 12.0 | 10.0 | 8.0 | 6.0 | 3.5 |
| Marathon | 8.0 | 6.8 | 5.5 | 4.5 | 3.5 |

Marathon row revised (audit 2026-04-10). Previous values (8.0, 7.0, 6.0, 6.5, 4.0) had
advanced > intermediate, violating diminishing returns. New values calibrated against
HERITAGE study (Bouchard 1999) and Midgley 2007 meta-analysis:
- Beginner: 15-25% VO2max improvement over 12-20 weeks → 8.0% ceiling realistic
- Intermediate: 5-12% → 5.5% ceiling produces 2-3% realised gain at 16 weeks
- Advanced: 2-5% → 4.5% ceiling produces 1.7-2.5% realised gain
- Elite: <2% → 3.5% ceiling produces 1.3-1.9% realised gain
Realised gains verified by computing week_factor × session_factor × exp_factor
at ref_sessions for a 16-week plan; all tiers strictly decreasing.

### Undertraining penalty
```
If sessionsPerWeek < minSessions:
  penalty = penaltyPct * (minSessions - sessionsPerWeek) / minSessions
```
Min sessions: 5K=2.0, 10K=2.5, Half=3.0, Marathon=3.5.
Max penalty: 5K=2.0%, 10K=2.5%, Half=3.0%, Marathon=4.0%.

### Taper bonus
5K=0.8%, 10K=1.0%, Half=1.2%, Marathon=1.5%. Scaled by `min(taperWeeks / taperNominal, 1.0)`.

### Guardrails (experience-gated ceilings)
- Sub-3 marathon (VDOT 54): requires Advanced+ OR HM PB < 1:28
- Sub-3:30 (VDOT 48): requires Intermediate+
- Sub-4 (VDOT 43): requires Novice+

Athletes within 2 VDOT points of a ceiling are not capped (already near the barrier).

**Scientific basis**: The saturating exponential (week factor) follows standard pharmacokinetic adaptation models. Early training weeks produce rapid gains; later weeks plateau. The logistic session factor captures the dose-response relationship between training frequency and adaptation. Experience factors reflect the principle of diminishing returns: less-trained athletes have more room for improvement.

**Known limitations**:
- All constants are population-level; no individual adaptation rate modelling
- Linear undertraining penalty is a simplification; real detraining follows exponential decay
- Guardrails are conservative and may systematically limit high-potential athletes
- No age or sex adjustment to gain ceilings

---

## Skip Penalty

**File**: `src/calculations/training-horizon.ts`

**Formula**: `penalty_seconds = round(basePenalty * proximityFactor * skipFactor)`

**Base penalty (TIM) in seconds** by workout type:

| Type | 5K | 10K | Half | Marathon |
|---|---|---|---|---|
| easy | 5 | 8 | 10 | 15 |
| long | 10 | 15 | 30 | 60 |
| threshold | 15 | 15 | 25 | 30 |
| vo2 | 20 | 18 | 15 | -- |
| race_pace | -- | 15 | 20 | 35 |

**Proximity factor**: 0.5 (>=10 weeks out), 0.8 (>=6), 1.2 (>=3), 1.5 (<3 weeks).

**Cumulative skip factor**: 1.0 (1 skip), 1.3 (2), 1.7 (3), 2.0 + (n-4)*0.3 (>=4).

**Scientific basis**: Skipping workouts has compounding damage. Later skips hurt more (proximity) because there are fewer sessions remaining to recover the adaptation. Repeated skips compound because each missed session represents a larger fraction of the diminishing training budget. Long runs carry the highest marathon penalty (60s) because they are irreplaceable for glycogen depletion adaptation and mental preparation.

---

## Expected Physiology Trajectory

**File**: `src/calculations/training-horizon.ts`, `src/constants/training-params.ts`

**Formula**:
```
expectedLT = initialLT * (1 - gains.lt * weeksElapsed)
expectedVO2 = initialVO2 * (1 + gains.vo2 * weeksElapsed)
```

**Weekly improvement rates**:

| Level | VO2max/week | LT pace/week |
|---|---|---|
| novice | 0.55% | 0.70% |
| intermediate | 0.175% | 0.275% |
| advanced | 0.10% | 0.165% |
| elite | 0.05% | 0.075% |

**Scientific basis**: Empirical weekly adaptation rates from training studies. Novices improve faster (more headroom); elite athletes plateau. LT improves faster than VO2max because LT responds to moderate-volume training, while VO2max requires high-intensity stimuli and has a larger genetic component.

**Known limitations**:
- Linear projection ignores adaptation saturation (sigmoid reality)
- No individual variation for age, genetics, or training response
- Assumes consistent training adherence

---

## Readiness Score

**File**: `src/calculations/readiness.ts`

**Formula**: Weighted composite of sub-signals:

With recovery data (watch): `score = fitness * 0.35 + safety * 0.30 + recovery * 0.35`
Without recovery data: `score = fitness * 0.55 + safety * 0.45`

### Freshness sub-score (from TSB) — non-linear, exponent 1.2
```
tsbDaily = TSB / 7
fitnessFrac = clamp((tsbDaily + 25) / 55, 0, 1)
fitnessScore = fitnessFrac ^ 1.2 * 100
```
Key points: TSB daily +30 -> 100%, 0 -> 39%, -10 -> 21%, -25 -> 0%.

Exponent 1.2 (mild convex curve). TSB is not as exponentially risky as ACWR — negative TSB is normal during training blocks — so the curve is gentler. The fatigued end drops slightly faster than linear while the fresh end stays comfortable.

### Load safety sub-score (from ACWR) — non-linear, exponent 1.6
```
safetyFrac = clamp((2.0 - ACWR) / 1.2, 0, 1)
safetyScore = safetyFrac ^ 1.6 * 100
```
Key points: ACWR 0.8 -> 100%, 1.0 -> 75%, 1.3 -> 42%, 1.5 -> 25%, 1.7 -> 11%, 2.0 -> 0%.

Exponent 1.6 (strong convex curve). Reflects Gabbett (2016): injury risk accelerates exponentially above the safe zone. Going from ACWR 1.3 to 1.5 drops the score by 17 points (was 16 linear), but going from 1.5 to 1.7 drops by 14 points (was 17 linear) — the curve compresses the dangerous range more aggressively.

### Hard floors (safety constraints)
- ACWR > cautionUpper: score <= 39
- ACWR > safeUpper: score <= 59
- Sleep < 45: score <= 59
- HRV drop > 30%: score <= 59
- Sleep bank < -9000s (2.5h debt): score <= 59
- Strain 50-100%: linear 100 -> 59
- Strain > 130%: score <= 39

### Recovery trend multiplier
```
Recovery >= 70: 1.00x (normal)
50-69: 1.15x (mildly suppressed)
30-49: 1.30x (poor)
< 30: 1.50x (serious deficit)
```

### Labels
- >= 80: "Ready to Push"
- 60-79: "On Track"
- 40-59: "Manage Load"
- < 40: "Ease Back"

**Scientific basis**: Each sub-signal is an established training monitoring metric. TSB (Coggan) indicates fatigue state, ACWR (Gabbett) indicates injury risk. Sub-scores use non-linear (power curve) mapping rather than linear because the underlying risk relationships are non-linear: injury risk accelerates exponentially with ACWR (Gabbett 2016), and sleep deprivation effects compound non-linearly (Van Dongen 2003). ACWR uses a stronger exponent (1.6) than TSB (1.2) because load spikes are the most dangerous signal. Hard floors serve as a safety net for extreme cases.

**Known limitations**:
- Weights are expert-calibrated, not individually optimised
- Hard floors are conservative; some athletes tolerate high ACWR without injury
- Without wearable data, the score loses 35% of its information (recovery component)

---

## Recovery Score (sleep + HRV, RHR override)

**File**: `src/calculations/readiness.ts`

**Composite**: `score = HRV * 0.55 + Sleep * 0.45` (renormalised when one signal missing).

RHR is not a weighted input. It acts as a graduated hard floor (see below).

### HRV sub-score (55% weight)

**Z-score method** (>= 10 baseline readings):
```
z = (7d_avg_HRV - 28d_avg_HRV) / 28d_SD
chronicScore = clamp(80 + z * 20, 0, 100)
```

**Percentage fallback** (< 10 readings):
```
chronicDelta = (7d_avg - 28d_avg) / 28d_avg
chronicScore = clamp(80 + chronicDelta * 175, 0, 100)
```

### Sleep sub-score (45% weight)
Uses Garmin/Apple sleep score directly when available (0-100 scale). Fallback uses chronic delta with asymmetric acute modifier (negative nights penalised 50x, positive only 20x).

### RHR override (graduated hard floor, not weighted)

RHR is a high-specificity, low-sensitivity signal (Buchheit 2014). It adds noise when weighted continuously (caffeine, heat, hydration shift it without reflecting recovery state) but has strong diagnostic value when genuinely elevated. The SD-based override plays to this strength.

```
deviationSD = (7d_avg_RHR - 28d_avg_RHR) / 28d_SD_RHR

2.0 to 2.5 SD above baseline:  cap score at 55   (Fair zone)
2.5 to 3.0 SD above baseline:  cap score at 40   (Poor zone, triggers load reduction)
>= 3.0 SD above baseline:      cap score at 25   (severe brake, illness/overtraining)
```

The 0-100 `rhrScore` (80 - deltaBpm * 5) is still computed for display in the detail view but does not affect the composite.

**Scientific basis**: HRV (RMSSD) is the most validated non-invasive marker of autonomic recovery (Plews et al., 2013; Buchheit, 2014). Sleep is the most impactful and actionable recovery behaviour (Walker, Samuels). Equal-ish weighting (55/45) reflects that neither clearly dominates: HRV is more responsive, sleep is more stable and actionable. No published study validates specific composite weights; the choice is informed by the literature but not derived from it.

RHR override uses personal SD rather than absolute bpm thresholds because inter-individual RHR variation is large (40-70 bpm in trained athletes). The 2 SD threshold aligns with Buchheit's "+7 bpm = meaningful concern" for a typical athlete with SD of 2.5-3 bpm.

**Known limitations**:
- Requires minimum 3 days of data; returns null below this
- Day-to-day HRV noise is high; only the 7d vs 28d trend is used
- HRV varies by device, measurement time, and body position
- RHR override requires sufficient baseline variance; athletes with extremely stable RHR (SD < 1 bpm) may trigger the override from normal fluctuations. Guard: override only computed when SD > 0

---

## Sleep Debt Model

**File**: `src/calculations/sleep-insights.ts`

### Sleep target derivation
```
If < 5 nights history: default = 25200s (7h)
Else: median of last 30 nights, clamped [25200s, 32400s]   (7h–9h)
```

**Superseded 2026-04-29: switched from 65th percentile [7h, 8h] to median [7h, 9h].**

The percentile method effectively treated "longest 35% of nights" as the target, which guarantees structural debt by construction — most nights miss target by definition. For a user whose 30-day average sleep is 7h 22m, the prior method produced a 7h 52m target (~30 min above mean), generating ~5h of steady-state debt before any chronic shortfall or load bonus, even when their physiology showed no fatigue signal. This was demoralising and not literature-grounded.

The replacement uses the median of the last 30 nights — a robust central-tendency estimator for habitual sleep, the closest passive proxy for sleep need. Habitual / free-day sleep as a proxy for need is supported by:
- **Roenneberg et al. 2007, 2012** — "free-day sleep" (no alarm) is the standard chronotype-research measure of biological sleep need; converges on median-class central tendency rather than upper-tail
- **Klerman & Dijk 2008** — habitual sleep duration in absence of restriction approximates intrinsic need, varies meaningfully by individual and age
- **Hirshkowitz / NSF 2015** — recommended adult range 7–9h; "may be appropriate" 6–10h. Justifies the 9h ceiling raise (previously 8h, which clamped the target down for users whose habitual sleep was 8h+)

**What stays the same**:
- 7h floor anchored to Van Dongen & Dinges 2003 — chronic restriction below 7h produces measurable cognitive deficits across the population. Below-floor users still get clamped to 7h and accumulate debt appropriately.
- Load-adjusted bonus (`+0.25 min/TSS`, tier-capped) is unchanged. This sits *on top* of the personal base target.
- Surplus credit (0.5 ratio, 60-min cap) and 7-day decay half-life are unchanged.

**Flow-through to recovery**: `readiness.ts:507-509` floors trigger on `sleepBankSec < -9000s` (2.5h) and `< -5400s` (1.5h). These thresholds were calibrated against the prior high-bias target. Lowering the typical target shifts the bank closer to zero for stable sleepers, so the floors trigger less often. Direction is correct (fewer false alarms for sleepers whose physiology is fine); thresholds themselves remain anchored to Van Dongen 2003 chronic-restriction evidence and don't need re-tuning.

**Migration**: no migration code needed. `deriveSleepTarget` is called fresh on each render. Users who set `s.sleepTargetSec` manually via account-view keep that override.

### Load-adjusted target
```
bonus_min = min(yesterdayTSS * 0.25, tier_cap)
Caps: beginner=20, recreational=30, trained=40, performance=50, high_volume=60 min
```

### Sleep quality multiplier — DELETED (audit 2026-04-10)

`sleepQualityMultiplier()` removed: was dead code (defined but never called). The actual
sleep score comes from Garmin natively or `computeSleepScore()` for Apple Watch users.

### Apple Watch sleep score (computeSleepScore, appleHealthSync.ts)

Apple Watch does not provide a composite sleep score. We compute one from HealthKit stage data:
```
score = durationScore * 0.55 + deepScore * 0.25 + remScore * 0.20
```
- **Duration (55%)**: `min(100, actualSec / targetSec * 100)`. Target = 7h default.
  Strongest predictor of next-day performance (sleep extension studies).
- **Deep (25%)**: `min(100, deepPct / 0.175 * 100)`. Peaks at 17.5% of total sleep.
  GH secretion, glycogen resynthesis, tissue repair (Van Cauter 2000, Dattilo 2011).
- **REM (20%)**: `min(100, remPct / 0.225 * 100)`. Peaks at 22.5% of total sleep.
  Motor memory consolidation, cognitive recovery (Walker 2017, Rasch & Born 2013).

Deep > REM weighting reflects athletic context: physical recovery (deep) is more directly
tied to training adaptation than cognitive consolidation (REM). No wearable publishes exact
weights (all proprietary), but the duration-dominant, slight deep bias aligns with the
scientific literature on sleep and athletic performance.

Audited 2026-04-10: kept at 55/25/20.

### Debt accumulation (exponential decay + capped surplus credit)
```
For each night chronologically:
  shortfall = max(0, target - actual_duration)
  surplus   = max(0, actual_duration - target)
  credit    = min(SURPLUS_CREDIT_CAP_SEC, surplus * SURPLUS_CREDIT_RATIO)
  debt      = max(0, debt * DEBT_DECAY + shortfall - credit)

DEBT_DECAY              = exp(-ln(2) / 7) ~= 0.9057    (7-day half-life)
SURPLUS_CREDIT_RATIO    = 0.5                          (Banks & Dinges 2007)
SURPLUS_CREDIT_CAP_SEC  = 3600                         (1h max credit per night)
```

Both the headline debt value (`computeSleepDebt`) and the cumulative-debt line chart on the Sleep page are produced from this same recurrence via `computeSleepDebtSeries()`. The chart plots `−debt` per night (so deficit sits below the target line); the headline equals the last point of the series.

**Why partial surplus credit (changed 2026-04-28)**: the previous formulation gave zero credit for sleep above target — debt could only shrink via the 7-day decay. This produced a perpetually bleak signal: even after two 9h recovery nights, residual debt only fell ~18%. The literature actually supports recovery sleep reducing debt:
- **Banks & Dinges 2007** — one 10h recovery night after 5 nights of 4h restored ~50–70% of cognitive performance, not 0% (current model said 0%) and not 100% (Bevel-style "sleep banking" would say 100%).
- **Rupp et al. 2009** — extended recovery sleep produces dose-dependent recovery with diminishing returns.
- **Pejovic et al. 2013** — recovery sleep partially restores performance; not all metrics recover, and not in a single night.
- **Kitamura et al. 2016** — multi-week sleep extension gradually clears accumulated debt at sub-1:1 rate.

The 0.5 credit ratio picks the conservative end of the literature range. The 1h per-night cap mirrors the existing `TIER_LOAD_CAPS_SEC` convention and prevents a single 12h sleep from wiping out a week of accumulated debt — which would contradict Banks & Dinges. The hard floor at 0 means users cannot bank sleep; they can only accelerate clearance of existing debt.

**What stays asymmetric**: a 60-min deficit adds 60min to debt, but a 60-min surplus only removes 30min. This preserves the directional bias the literature requires (recovery is slower than the cost of restriction).

### Debt severity tiers (`classifySleepDebt`)

Returns `{ label, color, showNumber }`. The tier colour drives the Sleep page headline text, the cumulative-debt chart line, and the gradient fill — all three graduate together from emerald → slate → amber → orange → red so a small residual reads as reassuring and a real deficit reads as concerning.

| Debt | Label | Colour | Chronic equivalent | showNumber |
|---|---|---|---|---|
| < 45m | `on track` | emerald `#10B981` | effectively hitting target (residual within one night's natural variation) | false |
| 45m – 1h 30m | `caught up` | slate `#64748B` | ≈ one decayed short night; practically recovered | true |
| 1h 30m – 3h | `mild` | amber `#F59E0B` | ~15–30 min/night chronic shortfall | true |
| 3h – 6h | `moderate` | orange `#F97316` | ~30–60 min/night chronic shortfall | true |
| 6h – 9h | `high` | red `#EF4444` | ~60–90 min/night chronic shortfall | true |
| ≥ 9h | `severe` | red-600 `#DC2626` | approaches Van Dongen 2003 chronic restriction zone (≥ 75 min/night) | true |

**What literature supports**:
- Belenky et al. 2003 — single-night partial deprivation produces minor cognitive effects; chronic restriction (7+ nights of 3h or 5h) produces progressively larger deficits that don't fully recover after three recovery nights
- Van Dongen & Dinges 2003 — 14 days at 6h/night ≈ 1–2 nights of total deprivation equivalent (≈ 28h raw / ~20h decayed cumulative debt)
- Rupp et al. 2009 — recovery from chronic restriction is slow and incomplete; residual deficits persist for weeks

**What the minute-level cutoffs are**: pragmatic, not literature-derived. The *progression* is defensible (mild → moderate → high → severe corresponds to recognisable chronic-shortfall patterns). The specific boundaries are **intentionally conservative** — `severe` fires at 9h, roughly half of Van Dongen's ~20h chronic-restriction steady state, so tiers flag earlier than demonstrated-harmful levels.

**Why `on track` hides the number**: residuals under 45 min are physiological noise (single night's natural variation) and showing a precise "23m debt · on track" reads as punishing for a negligible quantity. Above 45 min the number is shown because it carries meaning.

**Why graduated colour, not binary red/green**: the earlier implementation used red for any non-zero debt, which made the model read as "always failing" even after a recovery week. Graduation through emerald → slate → amber → orange → red means the visual alarm only kicks in once debt is genuinely in the chronic-shortfall range.

### Sleep bank (rolling 7-night)
```
bankSec = SUM(last 7 nights: actual - target)
Balanced: within +/- 900s (15 min)
```

**Scientific basis**: Sleep target uses the median of personal history (Roenneberg habitual-sleep proxy for need) clamped to the literature-supported adult range [7h, 9h] (Van Dongen floor, NSF/Hirshkowitz ceiling). Load-adjusted bonus reflects adenosine accumulation from training (Dijk/Czeisler). The 7-day half-life reflects that performance debt from chronic sleep restriction persists longer than subjective sleepiness (Banks & Dinges 2007, Belenky et al. 2003). Previously 4-day (borrowed from ATL Banister model), revised based on evidence that cognitive/performance deficits take 1-2 weeks to clear. Aligns with Oura's 14-day lookback and WHOOP's stated persistence model. Sleep score for Apple Watch users is computed locally (see above); Garmin users get the native score.

**Known limitations**:
- Quality multiplier is not applied retroactively to debt (would cause compounding errors)
- Median requires 5+ nights of data; short-history users get a generic 7h target
- Sleep stage percentages depend on wearable accuracy (Garmin/Apple may misclassify stages)
- Tier caps are expert-set, not individually calibrated

### Debt outlook (trend, ETA, spike attribution)

`computeSleepDebtOutlook` (sleep-insights.ts) wraps the same recurrence used by `computeSleepDebt` and exposes three derived quantities used on the Sleep page to make the static debt number motivating rather than punishing:

- **Trend**: `series[last].debt − series[last − 7].debt`. Negative = clearing, positive = growing. Surfaces as "down 1h 12m this week".
- **Days-to-clear**: forward-simulates the recurrence for up to 60 nights using the last-7-night average actual sleep against the latest load-adjusted target, returns the first day debt drops below the "on track" threshold (45 min). Returns null when avg actual < target — debt won't clear at the recent pace, copy degrades to "not clearing yet — sleep is still under target".
- **Spike attribution**: counts nights in the visible window (last 14) whose individual shortfall exceeded `SPIKE_SHORTFALL_THRESHOLD_SEC = 7200s` (2h). For each spike, the *decayed* contribution to current debt is reported — `shortfall × DEBT_DECAY^(days_since_spike)` — not the raw shortfall. A 4h Sunday spike 3 days ago contributes ~3h to current debt, not 4h, because the recurrence has decayed it. Reporting raw shortfalls overstates "this is from that night" once decay has worked for several days. Capped at total debt (surplus-credit interactions between the spike and now can mathematically push the decayed sum slightly above the residual).
- **Personal-norm comparison**: 30-day rolling mean of the cumulative-debt series, requiring ≥14 entries for stability. Today's debt is classified `above`/`below`/`on_par` against this baseline using a tolerance band of `max(30 min, 15% of typical)`. Surfaced as a one-line caption beneath the absolute headline with relative colour (amber above / emerald below / slate on-par), independent of the absolute tier colour.

  **Why this exists**: a chronic short-sleeper whose habitual sleep is below the 7h floor will sit permanently at high steady-state debt (~5h+) under the unchanged debt math. The absolute number and tier still surface that — Van Dongen 2003 still applies, no science is being walked back. But a permanently amber/orange tier becomes a check-engine light the user tunes out. The personal-norm line restores signal value: it only flags when *this* week is materially different from *their* week, regardless of where the absolute level sits. The tolerance band (max 30 min / 15%) handles both small and large baselines without firing on noise.

  **Honest framing**: this does not endorse chronic undersleeping. The absolute number, the tier label, and the colour-graduated chart all remain anchored to population science. The personal-norm line is purely a *change* signal layered on top, not a *target* signal — users see both "you're chronically short by population standards" and "this week was/wasn't worse than your normal" simultaneously.

All four derive from the existing model's outputs — no new constants beyond the 2h spike threshold and the 30-min/15% tolerance band.

**Honest copy rule**: the simulation projects forward assuming `future avg actual = recent 7-night avg`. The view copy says "at this pace" to keep that assumption visible. Spike attribution is approximate — surplus-credit interactions between the spike and now are not accounted for — but the qualitative "this is from one short night" attribution is robust given the 2h gate.

---

## Sleep Insights Priority Rules

**File**: `src/calculations/sleep-insights.ts`

**Detection rules** (evaluated in priority order):

1. **Post-hard-week**: TSS > 250 AND score < 65 (or TSS > 350 AND score < 75) -- training load is suppressing sleep quality
2. **Consecutive bad nights**: >= 2 of last 3 nights below score 60 -- recommend intensity reduction
3. **Good streak**: exactly 3 consecutive nights >= 75 -- body primed for hard effort
4. **Bounce-back**: previous night < 60, latest >= 75 -- good recovery night
5. **Sleep debt**: 7-day average < 65 with >= 4 data points -- chronic deficit
6. **Improving trend**: latest >= 75 AND > 7d average + 12 -- above recent average

**Scientific basis**: Priority ordering reflects clinical significance. Acute sleep-training interactions (rule 1) override chronic patterns. The thresholds are calibrated against Garmin/Apple sleep scoring scales where < 60 = poor and >= 75 = good.

---

## Activity Matching

**File**: `src/calculations/activity-matcher.ts`

### RPE derivation priority chain
1. Garmin RPE (direct, 1-10)
2. HR zone mapping via Karvonen (intensity -> RPE: <0.50=3, 0.50-0.65=4, 0.65-0.75=5, 0.75-0.82=6, 0.82-0.89=8, >=0.89=9)
3. Training Effect proxy (Garmin 0-5 scale mapped to RPE)
4. Activity type heuristic (walking=3, hiking=4, strength=6)
5. Default: planned RPE or 5

### Match scoring
- Same day: +3 points; adjacent day: +1; sport name match: +5; distance within 15%: +3; run type affinity: +1
- Minimum score thresholds: runs=3, gym=2, sport=5
- Different-day matches capped at medium confidence

### Pace adherence
```
paceAdherence = actualPace / targetPace
1.0 = on target, >1.0 = slower, <1.0 = faster
```

**Known limitations**:
- Default resting HR of 55 bpm may be far from actual for some athletes
- Age-estimated maxHR (220-age) has ~10 bpm SD
- Sport name matching is string-based; relies on consistent naming

---

## Plan Engine: Phase Distribution

**File**: `src/workouts/plan_engine.ts`, `src/workouts/generator.ts`

**Phase allocation**:
```
taperWeeks = max(1, ceil(totalWeeks * 0.12))
preTaper = totalWeeks - taperWeeks
baseWeeks = max(1, round(preTaper * 0.45))
buildWeeks = max(1, round(preTaper * 0.40))
peakWeeks = preTaper - baseWeeks - buildWeeks
```

**Taper nominal weeks**: 5K=1, 10K=2, Half=2, Marathon=3.

**Example (16-week marathon plan)**: taper=2, base=6, build=6, peak=2.

**Deload cycles** (ability-dependent):
- Beginner/novice: every 3 weeks, 0.80x volume
- Intermediate: every 4 weeks, 0.85x
- Advanced: every 5 weeks, 0.87x
- Elite: every 6 weeks, 0.90x

**Scientific basis**: The 45/40/15 (base/build/peak) split follows classical periodisation (Bompa, 1999). Base phase develops aerobic foundation, build phase introduces race-specific intensity, peak phase maximises fitness before taper. The 12% taper allocation aligns with Mujika & Padilla (2003) showing 2-3 week tapers optimal for distance events. Deload frequency increases with training maturity because trained athletes recover faster and tolerate longer loading blocks.

---

## Plan Engine: Session Budgets

**File**: `src/workouts/plan_engine.ts`

### Long run minutes
Base by race: 5K=50, 10K=60, Half=80, Marathon=90.
Progressive ramp: 80% to 100% over first 75% of plan.
Phase: taper=0.65x, peak=1.05x.
Ability caps: beginner=90, novice=100, intermediate=120, advanced=150, elite=180 min.

### Easy run minutes
Base by ability: beginner=30, novice=35, intermediate=40, advanced=45, elite=50 min.
Marathon multiplier: 1.15x. Taper: 0.70x.

### Threshold work minutes
Base: beginner=12, novice=15, intermediate=20, advanced=25, elite=30 min.
Ramp: 75% to 100% over first 80% of plan.
Phase: base=0.85x, peak=1.05x, taper=0.60x.

### VO2 work minutes
Base: beginner=8, novice=10, intermediate=14, advanced=18, elite=22 min.
Phase: base=0.6x, build=0.9x, peak=1.1x, taper=0.5x.

### Marathon pace work minutes
Eligibility: marathon or half only, build/peak phases.
Base: beginner=15 to elite=50 min. Half=0.6x.

### Float fartlek minutes
Eligibility: half/marathon only, build/peak, intermediate+ ability.
Base: intermediate=18, advanced=22, elite=26 min.

**Scientific basis**: Session budgets follow polarised training principles (Seiler, 2010). Easy runs (Zone 1-2) form the volume base. Quality sessions (threshold, VO2, MP) are limited by ability to prevent overtraining. Progressive ramps avoid sudden load spikes. Phase multipliers implement periodisation: VO2 work is minimal in base (0.6x) and maximal in peak (1.1x), reflecting the principle of building aerobic base before introducing high-intensity stimuli.

**Float fartlek rationale**: Moderate-effort recovery at ~MP trains MCT1/MCT4 lactate transporters (Brooks, 2009). Sustained blood lactate at 2-3 mmol/L during float segments forces aerobic adaptation under mild acidosis, mimicking marathon racing metabolic profile (Coyle, 2007). Restricted to intermediate+ because it requires pacing discipline.

---

## Plan Engine: Quality Session Management

**File**: `src/workouts/plan_engine.ts`

### Quality session cap
Beginner/novice: 1/week. Intermediate/advanced: 2/week. Elite: 3/week.
Constrained: `maxQuality = min(base, runsPerWeek - 1)` (at least 1 easy session).

### ACWR adaptation
- Caution: maxQuality -= 1
- High: maxQuality -= 2
- High ACWR also prevents long run progression (capped at previous week's value)

### Effort multiplier
```
effortMult = clamp(1 - effortScore * 0.05, 0.85, 1.15)
```
Score +3 (fatigued) -> 0.85x volume. Score -3 (fresh) -> 1.15x.

### Workout priority by race and phase
Marathon build: MP > float > threshold > VO2.
Marathon peak: MP > float > VO2 > threshold.
5K build/peak: VO2 > threshold.

### Runner type bias
Speed runners: promote threshold (trains weakness).
Endurance runners: promote VO2 (trains weakness).

**Scientific basis**: Quality session limits prevent overtraining by capping high-intensity exposure. The "train your weakness" bias follows the principle that speed runners benefit most from endurance work and vice versa. ACWR-driven quality reduction is a proactive injury prevention measure aligned with Gabbett's load management framework.

---

## Workout Importance (IMP) & Variant Rotation

**File**: `src/constants/training-params.ts`, `src/workouts/plan_engine.ts`

### Importance by distance (0 = unimportant, 1.0 = critical)

| Type | 5K | 10K | Half | Marathon |
|---|---|---|---|---|
| long | 0.50 | 0.70 | 0.95 | 1.00 |
| vo2 | 0.95 | 0.90 | 0.70 | 0.70 |
| threshold | 0.80 | 0.90 | 0.95 | 0.90 |
| marathon_pace | -- | -- | 0.90 | 0.95 |
| progressive | -- | -- | 0.90 | 0.95 |

### Variant rotation
VO2: cycles through 5x3min, 6x2min, 5x4min, 12x1min.
Threshold: 20min continuous, 3x8min, 2x12min, 5x5min cruise.
Long: steady, fast-finish, with threshold blocks.
Float: 6x3/2, 5x4/2, 8x2/2, 4x5/3 (Hudson/Canova formats).

Selection: `variant[max(0, weekIndex - 1) % variants.length]`

**Scientific basis**: Importance weights reflect event-specific training priorities. Marathon long runs are rated 1.0 because glycogen depletion training and mental preparation are irreplaceable. 5K VO2 work is 0.95 because VO2max is the primary performance determinant at that distance. Variant rotation prevents accommodation (repeated bout effect) and provides progressive overload through varying stimulus characteristics.

---

## Recovery Countdown -- To Baseline (Stacked Session Recovery) (2026-04-09)

**File**: `src/calculations/fitness-model.ts` (`computeToBaseline()`)

**Formula**: Walk forward chronologically through all recent sessions (current week + last 3 days of previous week). For each session with TSS > 10:
1. Tick down running recovery total by hours elapsed since last session
2. Add `8 * sessionTSS / ctlDaily * recoveryMult * recoveryAdj` hours
3. After last session, tick down by hours until now

**Stacking rationale**: Sessions accumulate fatigue. A hard Tuesday session on top of a hard Monday means more recovery needed than Tuesday alone. Garmin/Firstbeat stack sessions the same way: each new session extends the recovery timer. The previous model only counted the single most recent workout, which produced 0h when the last session had cleared even if multi-day fatigue was still present.

**Terms**:
- `sessionTSS` -- Signal B TSS for each day with significant load (> 10 TSS), via `computeTodaySignalBTSS`.
- `ctlDaily` -- chronic training load (weekly CTL / 7). Higher fitness = faster recovery from the same absolute load.
- `recoveryMult` -- sport-specific recovery multiplier from `SPORTS_DB`. Weighted average when multiple activities in one day. Reflects exercise-induced muscle damage differences: swimming 0.90, cycling 0.95, running 1.0, rugby 1.30.
- `recoveryAdj` -- adjustment from `computeRecoveryScore` (sleep, HRV, RHR). Score 50 = 1.0x, score 20 = 1.3x (slower), score 80 = 0.7x (faster). Clamped to 0.7-1.3 range.

**Scientific basis**: Recovery time is proportional to session load relative to chronic fitness. Same principle as Firstbeat Analytics' (Garmin's) EPOC-based recovery advisor. TSS correlates with TRIMP/EPOC (both HR-derived load metrics). CTL daily correlates with VO2max-like aerobic fitness.

**Constant 8**: Empirically calibrated to match Garmin/Firstbeat's published recovery windows:
- Easy run (30 TSS, CTL=37): ~6.5h
- Moderate session (58 TSS, CTL=37): ~12.5h (matches Garmin's typical 12h)
- Hard session (100 TSS, CTL=37): ~22h
- Marathon race (250 TSS, CTL=37): ~54h (Garmin typically shows 48-72h)

**Recovery score adjustment**: Sleep quality, HRV (RMSSD), and resting HR are the three most validated recovery biomarkers (Buchheit 2014, Plews et al. 2013). The +/-30% range is conservative.

**Known limitations**:
- Linear scaling per session is a simplification. Real EPOC follows bi-exponential decay. For practical session loads (30-250 TSS), linear gives comparable results.
- Stacking is additive (session A + session B). Real fatigue interaction is likely sub-additive for very light sessions and supra-additive for back-to-back hard sessions. For typical training patterns this is acceptable.
- Does not account for individual variation (age, training history, genetics).
- Sport-specific `recoveryMult` values are estimates, not individually measured.
- The constant 8 would need recalibration if TSS or CTL methodology changes.

---

## Recovery Countdown -- Full Fresh / TSB Clearance (2026-04-09)

**File**: `src/ui/freshness-view.ts`

**Formula**: `freshHours = -7 * ln(CTL / ATL) * 24`

**Scientific basis**: Standard Banister impulse-response model (Banister et al., 1975). ATL decays exponentially with a 7-day time constant, CTL with 42-day. These are the canonical values used by TrainingPeaks, WKO, and every PMC (Performance Management Chart) implementation.

**What it answers**: Hours of zero training load until TSB (Training Stress Balance = CTL - ATL) reaches zero. This is a macro fatigue-clearance metric useful for taper timing, not single-session recovery.

**Known limitations**:
- Uses weekly-stepped EMA values with intra-week daily decay interpolation. Not a true daily model.
- Assumes zero load going forward (if the athlete trains, the estimate is invalid).
- TSB = 0 is an arbitrary "fresh" threshold. Some athletes perform best at slightly negative TSB.

---

## Intra-week ATL/CTL Decay (2026-04-09)

**File**: `src/ui/freshness-view.ts`

**Formula**: For each day from week-end to today:
```
ATL = ATL * exp(-1/7) + dayTSS * 7 * (1 - exp(-1/7))
CTL = CTL * exp(-1/42) + dayTSS * 7 * (1 - exp(-1/42))
```

**Why needed**: `computeSameSignalTSB` only updates ATL/CTL at week boundaries. Between updates, rest days don't reduce ATL. This makes recovery estimates too high (e.g. 66h instead of 18h) because the model doesn't know the athlete has been resting for 2 days.

**The `* 7` factor**: The EMA operates in weekly TSS units. A daily load of X sustained for 7 days equals a weekly load of 7X. So daily TSS is converted to weekly-equivalent before feeding the EMA step.

**DST safety**: Uses noon-anchored Date objects with `setDate()` arithmetic instead of raw millisecond offsets, which drift across DST boundaries.

---

## CTL/ATL EMA -- Weekly Decay Constants

**File**: `src/calculations/fitness-model.ts`

**Constants**:
- `CTL_DECAY = exp(-7/42) ~= 0.847` -- chronic training load, 42-day time constant
- `ATL_DECAY = exp(-7/7) ~= 0.368` -- acute training load, 7-day time constant

**Scientific basis**: Banister impulse-response model (1975). The 42-day and 7-day time constants are the standard values validated across decades of applied sports science. Used by TrainingPeaks, Golden Cheetah, WKO.

**EMA formula**: `CTL_new = CTL_old * CTL_DECAY + weekTSS * (1 - CTL_DECAY)`

---

## iTRIMP Normalisation

**File**: `src/calculations/fitness-model.ts`

**Formula**: `equivTSS = (iTrimp * 100) / 15000 * runSpec`

**Terms**:
- `iTrimp` -- individualised TRIMP from HR stream data. Computed by the edge function from second-by-second HR zones.
- `15000` -- normalisation constant. Represents the approximate iTRIMP of a 1-hour threshold-effort run. Maps raw iTRIMP to a 0-100ish TSS-equivalent scale.
- `runSpec` -- sport-specific running-equivalence discount. Running = 1.0, skiing = 0.75, cycling = 0.55, etc. Only applied to Signal A (running fitness). Signal B uses full iTRIMP without runSpec.

**Known limitations**:
- The 15000 normaliser is approximate. Individual HR profiles can shift what "threshold effort" means in iTRIMP units.
- `runSpec` values are estimates of how much each sport transfers to running fitness, not precise measurements.

---

## Signal A vs Signal B

**File**: `src/calculations/fitness-model.ts`

**Signal A** (run-equivalent load): applies runSpec discount to cross-training. Used for CTL in plan view, running fitness tracking, replace/reduce decisions, race prediction.

**Signal B** (raw physiological load): no runSpec discount; counts full metabolic cost. Used for ATL, ACWR, freshness/TSB, total load display.

**Rationale**: A padel session that produces 80 iTRIMP has only ~36 TSS of running-equivalent fitness benefit (runSpec 0.45), but it creates 80 TSS worth of physiological fatigue. Signal A captures the training effect; Signal B captures the recovery cost.

## HR Drift (Cardiovascular Decoupling) (2026-04-15)

**File**: `supabase/functions/sync-strava-activities/index.ts` (`calculateHRDrift`), surfaced in `src/calculations/workout-insight.ts`, `src/calculations/daily-coach.ts` (`detectEasyDriftPattern`, `computeLongRunDriftNote`), `src/ui/stats-view.ts` (`buildDurabilityChart`, `computeMarathonFadeRisk`), `src/ui/week-debrief.ts`.

**Formula**: `drift% = (avgHR_2nd_half − avgHR_1st_half) / avgHR_1st_half × 100`, computed on post-warmup HR samples (first 10% stripped). Requires ≥ 20 min of HR data with ≥ 120 samples; returned as one-decimal percentage.

**Scope**: Only applied to steady-state run types (`DRIFT_TYPES = RUNNING, TREADMILL_RUNNING, TRAIL_RUNNING, VIRTUAL_RUN, TRACK_RUNNING`). Pace-variable efforts (intervals, tempo with rest) produce misleading drift because HR lags pace changes.

**Thresholds** (zone classification):

| Drift | Interpretation | Colour |
|-------|----------------|--------|
| ≤ 5%  | Efficient (aerobic system coping with the load) | green |
| 5–8%  | Moderate drift (normal for long or warm-day efforts) | amber |
| > 8%  | Cardiovascular decoupling (heat, dehydration, fatigue, or pace too aggressive for current fitness) | red |

**Rationale for 5% / 8% cuts**: Maffetone, Friel, and the TrainingPeaks "Aerobic Decoupling" (Pw:HR) literature converge on ≤ 5% as the marker of a durable aerobic engine, with 5–8% as the transitional band and > 8% as clear decoupling. These are widely-used endurance-coaching heuristics, not hard physiological constants — useful as a practical signal but not a diagnostic.

**Pre-long-run nudge** (`computeLongRunDriftNote`): fires when today's planned session is a long run AND ≥ 2 of the last 3 long runs had drift > 8%. Scans 6 weeks. Copy suggests earlier fuelling cadence and controlled first-half pacing.

**Easy-pace drift pattern** (`detectEasyDriftPattern`): fires when the last 3 weeks of easy runs (≥ 3 samples) average drift > 5%. Suggests easy pace may sit too close to aerobic threshold and should be eased by 10–15 sec/km. 3-week window balances responsiveness with noise rejection; 5% matches the "efficient aerobic engine" threshold above.

**Aerobic Durability chart**: scatter of per-session drift across easy + long runs over the last 12 weeks. Rolling mean (4-point) overlaid; coloured bands at 5% / 8% reference thresholds.

**Marathon fade-risk badge** (`computeMarathonFadeRisk`): on the marathon race-estimate row only. Reads drift from recent long runs (goal pace or slower). If average drift > 8% across ≥ 2 samples, surfaces a "fade risk" warning. Marathon is the only distance where cardiovascular decoupling meaningfully compromises finishing pace — shorter distances finish before drift materialises.

**Commentary gating**: in-session drift commentary (`workout-insight.ts`) fires only on non-quality runs (`!s.quality`). Drift > 8% on a threshold or interval session is expected (high lactate, high ventilation, non-steady pace) and calling it out would be misleading.

**Known limitations**:
- Elevation profile influences drift on trail runs; we do not normalise for gradient.
- Wrist-based HR accuracy degrades during the first ~5–10 min (cadence lock). The 10% warmup strip mitigates but does not eliminate this.
- The 5% / 8% thresholds are coaching heuristics, not validated against a population cohort in this codebase.

**Heat correction (2026-04-16)**: ambient temperature is now fetched from Open-Meteo (free historical API, requires `start_latlng`) during drift computation and stored per-activity on `garmin_activities.ambient_temp_c`. Durability detection uses heat-adjusted drift:

`driftAdjusted = drift − 0.15 × max(0, tempC − 15)`

The 0.15%/°C coefficient is literature-approximate — controlled studies of endurance-trained runners at steady pace show ~0.1–0.2% HR rise per °C above a 15°C neutral zone due to elevated core temperature and skin-blood-flow diversion. Below 15°C no correction is applied (the coefficient is cardiovascular-strain-directional, not bidirectional). When `ambient_temp_c` is null (old rows, no-GPS treadmill, API failure), raw drift is used — the helper is a no-op.

**Personal baseline (2026-04-16)** (`computeDriftBaselines` in `daily-coach.ts`): rolling 16-week window per `plannedType` (easy, long). Baseline is mean + SD of heat-adjusted drift. Requires ≥ 5 samples per category; below that, `detectDurabilityFlag` falls back to the population 5% / 8% thresholds. When the baseline is available, the flag fires when the recent 4-week mean exceeds `baseline.mean + 1·SD`. This normalises against the athlete's own aerobic signature — a runner whose baseline drift sits at 3% triggers at a tighter bound than one whose baseline sits at 6%.

**Workout-insight heat context (2026-04-16)**: in-session drift commentary now mentions ambient temperature and heat-adjusted drift when `ambientTempC ≥ 22°C` and raw drift > 8%. Example: "HR drifted 11% from first to second half. At 28°C, heat-adjusted drift is 9% — the conditions explain most of the rise." This prevents coach copy from flagging hot-day runs as under-recovery.

**Backfill heal**: drift was added after the initial `hr_zones` migration. Backfill mode re-fetches HR streams (capped at 20 activities per run) for cached-with-zones running activities that have NULL `hr_drift`, so the 12-week durability chart populates retrospectively without blowing the Strava rate-limit budget.

**Durability flag (injury risk signal)** (`detectDurabilityFlag` in `daily-coach.ts`, surfaced in `injury-risk-view.ts`):

- Scans last 4 weeks. Strict matching: only `plannedType === 'easy'` or `'long'` actuals. A "matched but mismatched" run (e.g. a tempo logged against a planned easy) is excluded because the drift signal would reflect the effort profile, not under-recovery.
- Fires when:
  - Easy runs: ≥ 3 samples AND average drift > 5%
  - Long runs: ≥ 2 samples AND average drift > 8%
- Severity: `'high'` when the average exceeds its expected threshold by > 3 percentage points, otherwise `'elevated'`. The threshold gap (not the absolute drift) is what distinguishes mild under-recovery from clear cardiovascular decoupling.
- Copy differs per trigger (easy-only, long-only, both) with specific remediation (ease easy-run pace, slow long-run opening, fuel earlier).

**Rationale for coupling drift with ACWR**: ACWR flags acute:chronic load spikes but is blind to whether the load is being absorbed. Persistent easy-run drift means aerobic recovery isn't keeping pace with the training load — a quiet signal that precedes overt overreaching. Combining the two surfaces risk that load-ratio alone misses (e.g. ACWR inside the safe zone but drift climbing).

---

## FTP from Ride History — Quality-Tiered Estimator (2026-04-27, **superseded 2026-04-28**)

> **Superseded by** "FTP from Mean-Max Power Curve" below. The quality-tiered whole-ride approach is retained here as historical context and as the documented fallback path for rides without a power curve.

**Context**: The original estimator treated every ride's whole-activity normalised power (NP) as if it were a 20-min FTP test, applying `FTP = NP × 0.95` uniformly. This underestimated FTP for athletes whose powered rides were long endurance sessions rather than threshold tests. The 2026-04-27 quality-tiered rewrite classified rides as high-signal (20–75 min, avg/NP ≥ 0.88) or floor (>75 min, avg/NP ≥ 0.80) and applied duration-aware factors. Better than the uniform ×0.95, but still couldn't see *into* a long ride — a 110-min session containing two 20-min all-out efforts at 310 W would show whole-ride NP ≈ 251 W and the floor-tier formula would return FTP = 263 W, hiding the actual test result.

**Why retained as fallback**: when the watts stream isn't yet processed (mid-backfill, rides outside the per-sync stream-fetch budget), the activity row carries `average_watts` / `normalized_power` but no `power_curve`. Rather than show "--", the new estimator falls back to a recent ride's whole-ride NP × 1.00 within 12 weeks, tagged `confidence: 'low'`.

**Selection rule (2026-05-01 update)**: pick the *strongest* qualifying ride within 12 weeks, not the *freshest*. Whole-ride NP × 1.0 is conservative by construction — averaging across an entire ride dilutes the FTP signal — so picking the highest NP recent ride is the closest we can get to a real anchor without a curve. The earlier "freshest ride" rule had a degenerate failure mode: if the user's most recent ride was a Z2 endurance spin at NP 180 W, FTP would land at 180 W even when a tempo ride at NP 240 W from 3 weeks ago was sitting in the same data. Tiebreak on equal NP goes to the fresher ride.

**device_watts gate dropped entirely (2026-05-01)**: real-world data shows Strava's `device_watts` flag is structurally unreliable — Tristan's account has 60 of 63 recent rides flagged `device_watts: false` despite all of them being captured on a real power meter. The bug is in the Garmin → Strava transfer pipeline, not Strava's estimation logic. So:

- The earlier "reject `=== false`, accept null, downgrade unknown one tier" rule was still rejecting valid power-meter data wholesale.
- We now drop the flag check entirely and rely instead on a hard NP/avg threshold (`>= 120 W`). Strava's speed-based power estimation produces typical values of 80–150 W for casual rides; a sustained NP at 280 W cannot come from speed alone.
- Confidence downgrade is still applied when the flag isn't explicitly true (high → medium, medium → low). The 'low' tag and the existing UI prompt for a fresh test are the correct safety net.
- The presence of a `power_curve` is a far stronger signal than `device_watts`: the curve is computed by the edge function from actual watts samples in the stream. If it exists, the data was real.

---

## FTP from Mean-Max Power Curve — Top-1 within 12 Weeks (2026-04-28)

**Context**: Whole-ride NP averages over the entire activity, so any 20-min FTP test embedded inside a longer ride is invisible to the previous estimator. The fix is to read the *mean-max power curve* — best sustained watts over fixed time windows — directly from the watts stream, then apply Coggan's window-specific multipliers to whichever window gave the strongest signal.

**Pipeline**:

1. **Stream fetch** (edge function `sync-strava-activities` step 5e): per sync, rank cycling rides by `weighted_average_watts` DESC, filter to `device_watts=true` within the last 26 weeks, take top 15. For each, fetch `/activities/{id}/streams?keys=watts,time` and run a sliding-window mean-max for windows `[600, 1200, 1800, 3600]` seconds. Store as `garmin_activities.power_curve = { p600, p1200, p1800, p3600 }`. Budget: 15 streams/sync. The "highest whole-ride NP" pre-rank is the cheapest proxy for "ride contains a hard interval" — a 90-min Z2 ride at NP 180 W cannot hide a 310 W effort.
2. **Per-ride candidate** (`estimateFTPFromBikeActivities`): for each ride with a `powerCurve`, compute
   ```
   candidate = max(p600 × 0.92, p1200 × 0.95, p1800 × 0.97, p3600 × 1.00)
   ```
   Whichever window produced the strongest signal wins for that ride. Reject only rides Strava explicitly marks `deviceWatts === false`. **Why not require `=== true`?** The `device_watts` flag is unreliable on Garmin → Strava transfers — it routinely arrives `null` (or even `false`) on real power-meter rides. Refusing those leaves new triathletes with a "--" Bike FTP forever; downgrading their confidence one tier (high→medium, medium→low) is a strictly better outcome and keeps the existing UI prompt for a fresh test.
3. **Top-1 selection**: across all candidates within the last 12 weeks, take the single highest. The strongest single ride is the most informative single data point; averaging a fresh test with stale ones dilutes the signal.
4. **Outlier guard**: if the top-pick's `p1200 > 1.4 × p3600`, the curve is suspicious (meter spike or stream gap during a 20-min window) — fall to the second-best.
5. **Confidence by source-ride age** only:

| Source ride age | Confidence | UI caption |
|---|---|---|
| ≤ 4 weeks  | **high**   | "Derived from your 20-min effort on Apr 27 (310 W)." |
| 4–8 weeks  | medium     | "Derived from your last test on Mar 15. Sit a fresh one to confirm." |
| 8–12 weeks | low        | "Last test was 10 weeks ago. Estimate is getting stale." |
| > 12 weeks | none → `--` | "No recent FTP test. Tap to enter, or do a 20-min test." |

**Worked example** — Tristan, 2026-04-28: 110-min ride containing two 20-min all-out intervals at 310 W. Whole-ride NP=251 W, avg=223 W. Power curve from the watts stream: `p600=308, p1200=310, p1800=282, p3600=248`. Per-window candidates: 308×0.92=283, 310×0.95=295, 282×0.97=274, 248×1.00=248. Max = 295 W (20-min window). Source 1 day old → confidence `high`. The previous floor-tier estimator on this same ride returned 263 W (251 × 1.05).

**Multipliers — Coggan / Monod-style power-duration curve**:

| Window | Multiplier | Source |
|---|---|---|
| p600 (10 min)  | 0.92 | Coggan & Allen 2010, Monod-Scherrer power-duration model. 10-min max ≈ 1.087 × FTP. |
| p1200 (20 min) | 0.95 | Allen & Coggan classic 20-min FTP test protocol. 20-min max ≈ 1.053 × FTP. |
| p1800 (30 min) | 0.97 | Interpolation between p1200 and p3600. 30-min max ≈ 1.031 × FTP. |
| p3600 (60 min) | 1.00 | FTP definition: highest power sustainable for 60 min. |

**Mean-max sliding window (edge function, `computeMeanMax`)**:
```
sum = sum of first windowSec samples
best = sum
for i = windowSec; i < watts.length; i++:
  sum += watts[i] − watts[i − windowSec]
  best = max(best, sum)
return best / windowSec
```
O(n) per window. Strava streams are uniformly 1 Hz once fetched; missing samples (coasting, dropouts) are filled as 0 by Strava and treated as such.

**Why this is defensible**:
- Coggan's 0.95 multiplier was always specific to a 20-min near-max test, not a 20-min window inside a 4-hour ride. Reading p1200 from the stream and applying ×0.95 honours the original protocol.
- The power-duration curve (Monod-Scherrer 1965; refined Pinot & Grappe 2011) is the standard physiological model for short-duration max-effort scaling. Window-specific multipliers are taken from the canonical curve.
- Top-1 selection within 12 weeks reflects that FTP is a capacity metric: the strongest sustained effort the athlete has demonstrated recently is the best estimate of current threshold. Averaging stale efforts in is mathematically a regression toward mediocrity.
- 12-week hard cutoff matches typical FTP detraining literature (Coyle 1984: 5–7% loss per 4 weeks off; ~10–15% by 12 weeks). Beyond that, the estimate is too unreliable to anchor planning.

**Known limitations**:
- Strava rate limit caps stream fetches at 15/sync. Heavy users with many recent powered rides will only get the top-15-by-NP analysed each sync; lower-NP rides backfill on subsequent syncs. The pre-rank by whole-ride NP minimises the chance of missing a real test.
- The watts stream from a smart trainer can include calibration glitches at start (e.g. zero-offset drift). The outlier guard (p1200 > 1.4 × p3600) catches gross spikes but not subtle systematic offsets.
- p3600 × 1.00 assumes the rider went near-max for the full 60 min. For a steady tempo ride at IF=0.85, p3600 will be 85% of FTP and the formula returns 85% of FTP, biasing low. In practice this is dominated by p1200 × 0.95 (which doesn't have this problem) whenever any harder 20-min window exists in the last 12 weeks.
- A single curve-driven estimate fully anchors FTP — there's no "≥2 corroborating data points" minimum. Intentional: a real test is worth more than any number of floor estimates, but means one bad-data ride can move the number until the next sync drops it out of recency.

**Fallback path**: when no ride within 12 weeks has a `powerCurve` (mid-backfill state, all rides outside stream-fetch budget), the estimator uses the freshest real-meter ride's whole-ride NP × 1.00 as a conservative floor, tagged `confidence: 'low'` with caption "Best guess from whole-ride power. Do a 20-min test for a tighter number." Better than `--` while the curve backfill catches up.

**Recommended user action when confidence is anything below `high`**: run a 20-min FTP test (the recommendation surface lives in the "Refine your benchmarks" card on the plan view). A single recent test with a real meter promotes the estimate to `high` confidence on the next sync.

---

## Athlete Tier — Performance Floor

**File**: `src/data/stravaSync.ts:deriveAthleteTier`

**Core formula**:
```
fromCtl = bucket(ctlBaseline)               // beginner | recreational | trained | performance | high_volume
floor   = 'performance' if vdot ≥ 60 OR ftp ≥ 320 W
        | 'trained'     if vdot ≥ 50 OR ftp ≥ 250 W
        | 'beginner'    otherwise
tier    = max(fromCtl, floor)               // never below the CTL-derived bucket
```

**Why this is defensible**: athlete tier is consumed by plan engine multipliers (`plan_engine.ts`), session-difficulty selection (`session-generator.ts`), recovery targets (`sleep-debt`), and ACWR risk thresholds (`rolling-load-view.ts`). A pure-CTL classifier under-classifies any athlete whose chronic *running* load is modest while their broader engine is large — multi-sport athletes, runners returning from injury, triathletes with high bike/swim load and lower run mileage. The floor adds a *demonstrable engine* signal so the tier reflects what the body can produce, not just what it's currently producing.

**Justification for thresholds**:
- VDOT 50 → roughly 3:30 marathon, 1:38 half, 17:30 5K. By the standard Daniels VDOT tables this is firmly in trained-runner territory; a runner with VDOT ≥ 50 has the aerobic engine of a "trained" classification regardless of recent volume.
- VDOT 60 → roughly 2:54 marathon, 1:22 half, 14:50 5K — performance-bracket competitive amateur.
- FTP 250 W → ~3.3 W/kg at 75 kg male, ~3.6 W/kg at 70 kg, ~4.0 W/kg at 62 kg female. Per Allen/Coggan power profile tables, ≥3.5 W/kg is the lower edge of "Cat 4" / strongly trained recreational, which we map to `trained`.
- FTP 320 W → ~4.3 W/kg at 75 kg male, top of Cat 3 / Cat 2 — `performance`.
- The floor never *lowers* the tier; high CTL still wins, so a high-volume athlete with a modest VDOT (e.g. ultra-runner) is unaffected.

**Known limitations**:
- FTP thresholds are absolute watts because we don't store body weight; this under-classifies lightweight cyclists and over-classifies heavy ones. W/kg would be cleaner.
- Two signals (VDOT, FTP); swim CSS is not in the floor because CSS percentile vs population is harder to defend without normative data on hand and tri-only athletes are rare in our cohort.
- The floor is binary at each VDOT/FTP threshold — a VDOT of 49.9 stays at the CTL bucket, 50.0 lifts to trained. Acceptable: the fuzziness sits within the model error of VDOT itself.
- Cross-discipline misuse: a triathlete at VDOT 45 with FTP 280 W is reasonably "trained" overall — both signals corroborate. A triathlete at VDOT 38 with FTP 280 W gets lifted to "trained" by FTP alone, which arguably overstates *running* fitness. Plan engine consumers that care about run fitness specifically read VDOT directly; tier is the right granularity for cross-cutting decisions like recovery targets and ACWR thresholds.

---

## Cycling Power Balance — Bike Speed and CdA Calibration

**Files**: `src/calculations/bike-physics.ts`, `src/calculations/race-prediction.triathlon.ts` (`estimateBikeSpeed`)

**Core formulas**:

Forward (power → speed):
```
P_pedalled · η  =  ½·ρ·CdA·v³  +  Crr·m·g·v  +  m·g·sinθ·v
```
Solved numerically for v via Newton-Raphson on the cubic. Convergence in ≤12 iterations across the realistic v ∈ [0, 20 m/s] domain.

Reverse (known ride → CdA):
```
CdA  =  2·(P·η − Crr·m·g·v − m·g·sinθ·v) / (ρ·v³)
```
Where v = distance/duration. Rejects results outside [0.15, 0.50] m² as unphysical (drafting, hilly course mistaken for flat, calibration GPS error).

**Why this is defensible**: this is the canonical bicycling power model from Martin et al. 1998 ("Validation of a Mathematical Model for Road Cycling Power", *J. Appl. Biomech.*), validated against velodrome measurements within ±2% across the realistic cycling speed range. It replaces the previous linear watts→kph fit, which under-predicted speed for stronger riders by ignoring the cubic aero term and was inconsistent with its own internal calibration comment.

**Justification for constants**:
- **CdA presets** (m²): hoods 0.36, drops 0.32, clip-ons 0.28, TT bike 0.24. Mid-range from published wind-tunnel data (Cyclist magazine 2019, Cervélo white papers, Specialized Win Tunnel reports). Recreational age-grouper TT setups cluster around 0.24–0.26, drops/road-fit around 0.30–0.34.
- **Crr presets**: race tubeless 0.0035, race clincher 0.0040, training 0.0050, gravel 0.0070. From bicyclerollingresistance.com lab data at 100 PSI, adjusted down ~10% to account for the steel-drum overestimate vs real road.
- **Drivetrain efficiency** η = 0.97. Standard for clean modern chain + ceramic bearings. Older/dirty drivetrains drop to 0.94–0.95.
- **Air density** ρ = 1.225 kg/m³ at sea level, 15°C. User can override for altitude/heat.
- **Race intensity**: IM 70% FTP, 70.3 78% FTP — Allen-Coggan standard age-grouper guidance.
- **Course gradient assumption**: flat 0%, rolling 0.5%, hilly 1.2%. Effective net gradient drives the m·g·sinθ·v climb-power term. Conservative — real hilly courses have variable gradient that adds vs flat at the same average watts.
- **Wind-loss factor**: bumps effective CdA by 0–5% on rolling/hilly courses to capture the real-world losses (yaw exposure, gusts, rougher wind environment) that idealized still-air physics doesn't see.

**W/kg tier mapping**: Coggan FTP/kg tables (male 60-min power), thresholds at 2.62, 3.01, 3.40, 3.81, 4.20, 4.81, 5.62 W/kg. Female athletes appear one tier below their relative-to-peers ranking — accepted as informational only since the physics solver consumes raw watts, not the tier.

**CdA calibration confidence**: all user calibrations capped at `medium` because we cannot validate course flatness or absence of drafting from the inputs alone. A future iteration could parse Strava streams (gradient, drafting groups) to award `high`.

**Known limitations**:
- Course gradient is a single mean assumption per profile — real terrain has variable gradient that affects pacing more than average power. A flat 180 km IM and a 180 km IM with 1500 m gain at the same average watts have different bike splits because climb-time is non-linear in power.
- No yaw / wind-direction modelling. CdA is a single number; real frontal area + drag depends on wind angle. The wind-loss factor is a blunt approximation.
- No drafting penalty. Race prediction assumes IM-legal positioning (no drafting). 70.3 draft-legal ages have a different effective CdA that we don't model.
- Drivetrain efficiency held constant. Cassette/chainring choice, lube state, and bearing wear all matter; we don't expose these.
- Rolling resistance does not scale with pavement quality. Real cobbles / bad chip-seal can double Crr; users can override but won't know what value to pick without a calibration ride on that surface.
- Calibration assumes the ride was steady. A ride with stops (lights, refuels) overstates avg duration → understates avg speed → overstates CdA.

**Recommended user workflow**: pick the position preset that matches the bike, run a flat 30+ km steady-power test ride at race intensity, enter distance/duration/avg power into the calibration panel, and apply the result. The calibrated CdA persists per position.

## Device VO2 Max — Running-Specific Source Only (2026-04-29)

**Files**: `src/data/physiologySync.ts`, `supabase/functions/sync-physiology-snapshot/index.ts`, `src/state/persistence.ts` (v4 migration)

**Decision**: a value is only labelled "VO2 Max" (without an "(est.)" qualifier) in Mosaic if it came from `physiology_snapshots.vo2_max_running`. Any other source — including Garmin's `daily_metrics.vo2max` — is rejected, and the UI falls through to Daniels VDOT estimated from training data, clearly labelled "(est.)".

**Why two Garmin VO2 fields exist:**
- **`physiology_snapshots.vo2_max_running`** — populated by Garmin's `userMetrics` push, which fires only when the watch's "Running VO2 Max" screen value changes. Running-specific, derived from running activities by Garmin's Firstbeat-licensed model. This is what the watch face shows.
- **`daily_metrics.vo2max`** — populated by the generic `dailies` push. Garmin's docs describe this as the "fitness age" / cardio fitness number; it can be derived from cycling, walking, or other activities and routinely diverges from Running VO2 Max by 2–4 points. Garmin Connect users see it on the "Cardio Fitness" tile, not the running performance summary.

**The historic bug**: the `physiologySync` resolver preferred `vo2_max_running` but fell back to `daily_metrics.vo2max` when the former was absent. For a real user with values 53 (cycling-derived dailies, weeks ago) and 56 (running, last week from `userMetrics`), the resolver had at various points written 53 to `s.vo2`. The cycling estimate was then displayed under the label "VO2 Max · Well-Trained" with no provenance hint, and recovery from the wrong value required a fresh `userMetrics` push to override it.

**Defensibility of the strict rule:**
- **VO2 max is sport-specific.** Bassett & Howley (2000, *MSSE* 32:70–84) review extensive evidence that VO2max measured in a sport-specific test is 5–15% higher than in a non-specific test for trained athletes — running VO2 in runners exceeds cycling VO2, swimming VO2 in swimmers exceeds running VO2. Mixing modalities under one label is meaningless without a normalisation we don't have access to.
- **Garmin's documented intent.** Garmin themselves split the two endpoints: `userMetrics.vo2_max_running` is the running-specific number, and that's the one that drives Daniels-style pace recommendations on the watch. `daily_metrics.vo2max` is a general fitness indicator. We honour their distinction.
- **VDOT is a valid running estimate.** When no device value is available, we compute VDOT from race PBs and recent activities (Daniels 2014 model, see "Daniels VDOT" entry in this doc). Mathematically VDOT and Running VO2 Max sit in the same range and respond to the same training adaptations, so the "(est.)" fallback is a like-for-like substitute, not a different metric.

**Migration**: state schema v4 (`VO2_DEVICE_ONLY_VERSION = 4`) clears any persisted `s.vo2` and any `physiologyHistory[].vo2max` from earlier versions, since pre-v4 they may have been sourced from `daily_metrics.vo2max`. Next physiology sync repopulates strictly from `vo2_max_running`.

**Limitations:**
- **Coverage gap for non-Garmin device users.** Apple Watch users get no VO2 number from `@capgo/capacitor-health` and have always seen the VDOT estimate. Garmin users on watches that don't expose `userMetrics.vo2_max_running` (older or sport-specific models) now see the VDOT estimate too. This is a downgrade in label precision for a subset, but a precision *upgrade* in correctness — they were previously seeing a possibly-wrong number labelled as device VO2 Max.
- **Garmin's `userMetrics` push frequency is unreliable.** It fires only when the underlying value changes, and there have been historic delivery issues for some accounts. We accept the resulting freshness lag rather than substitute a different number.

## CSS from Swim History — Confidence-Tiered Estimator (2026-04-29)

**Files**: `src/calculations/tri-benchmarks-from-history.ts` (`estimateCSSFromSwimActivities`, `CssEstimate`).

**Decision**: the CSS estimator now returns a four-tier confidence (`high | medium | low | none`) alongside the value. The estimate itself is unchanged — fastest sustained swim ≥800m + 5 s/100m buffer — but recency, sustained distance, and pace-deviation from the user's own median together drive the tier. Tiers gate the in-app "Run a 400 m + 200 m test" prompt and the wizard / stats / account hint copy. Race-time prediction continues to read the value at any tier; confidence is informational, not gating.

**Tier rules** (mirror the FTP estimator's recency tiers):

| Tier   | Condition |
|--------|-----------|
| high   | Best swim ≤4w old AND ≥1500m AND ≥3 s/100m faster than the recent median (clear hard-effort signal) |
| medium | Best swim ≤4w old (any distance/spread) OR ≥1500m within 8w |
| low    | Some sustained ≥800m swim within 12w but neither tier above qualifies |
| none   | No sustained ≥800m swim within 12w (or no swim activities at all) |

A paired m400 + m200 PB on file shorts the cascade and is always tagged `high` (gold-standard Smith-Norris result).

**Justification for constants**:
- **800m sustained-swim floor**: a per-100m pace from <800m of swimming is too noisy to characterise threshold (one bad turn or 50m sprint distorts the avg). Threshold tied to the same value used elsewhere in the file.
- **1500m test-grade threshold (Dekerle 2002)**: the 30-min critical pace is the formal CSS definition (Dekerle, J., et al. *Eur. J. Appl. Physiol.* 2002, "Critical swimming speed does not represent the speed at maximal lactate steady state"). 1500m at ~110–130 s/100m takes 27–32 minutes for the bulk of recreational triathletes — the closest practical proxy to a 30-min hold without requiring the user to do a formal test.
- **3 s/100m hard-effort delta**: empirical pragmatic choice. A pool full of easy-aerobic swims at the same pace tells us nothing about threshold; the +5 s buffer over the *fastest* swim assumes that swim was a hard effort. Requiring the best swim to be ≥3 s/100m faster than the median is a coarse "this looks like a hard set" filter. Below 3 s/100m, the median and best are within typical day-to-day variability of an easy swim and the buffer is unreliable.
- **Recency tiers (4w / 8w / 12w)**: identical to the FTP estimator (`HIGH_TIER_WEEKS / MED_TIER_WEEKS / HARD_CUTOFF_WEEKS`). CSS detrains slower than FTP (Mujika 2010 — 3–5%/4w), so 12w is a generous-but-not-absurd cutoff for "still informative". Beyond 12w we still return a number (some signal beats none) but flag it `none` so the UI prompts a fresh test.
- **+5 s/100m buffer (unchanged)**: conservative offset on the fastest sustained pace. CSS sits below max-sustainable-pace and above easy-aerobic; +5 s is a coarse midpoint that biases toward over-estimating CSS pace (i.e., slower than reality, more conservative for prescription).

**Why both source AND confidence are persisted**: `cssSource` captures provenance ('user' vs 'derived'); `cssConfidence` captures the *quality* of the underlying signal at write time. A user-typed CSS without a paired test is `'user' / 'medium'`; the same value backed by a paired test is `'user' / 'high'`. A derived value from one stale 800m swim is `'derived' / 'low'`. The two together let the test-card decide whether to nag and let the UI choose the right hedge ("estimate — run the test" vs no hint).

**Why the value is returned at every tier**: race-time prediction needs a CSS to compute the swim leg. The user setup doesn't gate on confidence — first-time users with no history still see a prediction (currently `confidence='none'` + `cssSecPer100m=undefined`, which the prediction engine handles via its own swim-leg fallback). The purpose of the tiers is to control prompt aggressiveness and caption hedging, not to suppress the number.

**Known limitations**:
- The hard-effort delta uses the median across all sustained swims in the recency window, not a stratified set. If 80% of a swimmer's recent swims are 100m sprints with a single 1500m steady swim, the median is dragged toward the sprints and the 1500m may not flag as "hard-effort" even though it is the relevant threshold-pace data point. A future iteration could use a kernel-density approach or stratify by distance.
- "Faster than median" is symmetric to volume: a swimmer who only does easy swims will have a low-spread distribution and never reach `'high'` confidence, which is actually correct (we genuinely don't know their threshold). The cost is that occasional hard swimmers will see "estimate — run the test" prompts they may consider noise.
- The Dekerle 2002 critical-speed definition is more rigorous than "1500m at steady effort" — the formal test uses two distance trials and a least-squares fit. We accept the proxy because the goal is a usable CSS without a formal test, not a peer-reviewed threshold measurement.

## Personal Recovery Rate (`k_user`) — Adaptive Recovery (2026-05-01)

**Files**: `src/calculations/adaptive-recovery.ts` (the fitter + supporting helpers), `src/calculations/fitness-model.ts` (`computeToBaseline`, `computeACWR`).

**Decision**: replace the literal recovery constant `8` in the recovery-countdown formula with a learned per-user value `k_user`, fit from observed post-session physiology trajectories. Apply a small ACWR safeUpper shift on top of the per-tier baseline once `k_user` is established with high confidence. Population default falls back when evidence is thin.

**Model**:

```
sessionRecovery = k_user × TSS / ctlDaily × recoveryMult × recoveryAdj
```

where:
- `k_user` is a persistent trait (this athlete's recovery profile) — clamped to `[5, 13]` ≈ 0.6× to 1.6× of population mean.
- `recoveryAdj` is a transient state multiplier (today's HRV/sleep/RHR), already in the model — see `computeRecoveryScore`.
- Composing the two separates "how I recover in general" from "how I'm doing right now".

**ACWR ceiling shift**:

```
recoveryShift = clamp(−0.10, (8 − k_user) × 0.025, +0.10)
safeUpper_effective = TIER_ACWR_CONFIG[tier].safeUpper + recoveryShift
```

Only applied at `confidence = high` (≥30 closed sessions). At `K_USER_MIN=5` the shift is `+0.075` (under-cap by design); at `K_USER_MAX=13` it would be `−0.125` and clamps to `−0.10`. The asymmetry is deliberate: slow recoverers carry injury risk, so the conservative side is firmer.

**What we observe**: per session at date *T*,
- **Predicted hours-to-baseline** under the current model — logged at session ingestion.
- **Observed hours-to-baseline**: time after *T* until a composite recovery z-score returns to baseline. Composite = mean of available z-scores from `(HRV_t / +RHR_t_signFlipped)` against the user's 28-day pre-session baseline. Recovered = z ≥ −0.25 (a small negative tolerance — strict z ≥ 0 inflates observed hours due to noise). Capped at 96h (right-censored) when the signal never returns within the window.

**Fit**: weighted-mean ratio with Bayesian prior. Per-session ratio `r_i = observed_i / predicted_i`. Aggregate:

```
weight_i  = sourceWeight_i × 0.5^(ageWeeks_i / halfLife)
meanRatio = (Σ weight_i × r_i + PRIOR_WEIGHT × 1.0) / (Σ weight_i + PRIOR_WEIGHT)
k_new     = clamp(8 × meanRatio, 5, 13)
```

with `halfLife = 4 weeks`, `PRIOR_WEIGHT = 4` (4 ghost samples that vote for `k=8`), `sourceWeight = 1.0` for live entries and `0.7` for historical-backfill entries.

**Confidence gating**:

| Sessions observed | Confidence | Behaviour |
|---|---|---|
| 0–7   | none    | population default of 8; UI shows "learning" |
| 8–15  | low     | display only; not yet used in countdown |
| 16+   | medium  | used in recovery countdown |
| 30+   | high    | used in countdown AND ACWR ceiling shift |

**Justification for constants**:
- **`k_user` clamp `[5, 13]`** ≈ ±60% of population. Bounds outlier early evidence; calibrated against the Banister fitness/fatigue literature where individual recovery time-constants vary roughly within this range across athletic populations (Busso 2003, *Med Sci Sports Exerc* 35:1188–1195; review of intra-athlete variability in dose-response models).
- **96h observation cap**: matches the upper bound of EPOC clearance for typical aerobic loads (Børsheim & Bahr 2003, *Sports Med* 33:1037–1060; recovery-O2 returns to baseline within 24–96h depending on duration/intensity). Sessions whose composite signal never recovers within this window are real ("strong negative evidence") and shouldn't be excluded — hence right-censoring at 96h, treated as observed=96h with an explicit flag.
- **Composite z-threshold of −0.25**: empirical noise tolerance. Daily HRV CV is ~5–8% even for healthy stable athletes (Plews et al. 2012, *Eur J Appl Physiol* 112:3729–3741); a strict ≥0 cutoff would inflate observed hours through noise alone. −0.25 is roughly half a population standard deviation — small enough to remain meaningful, large enough to absorb single-day jitter.
- **Recency half-life of 4 weeks**: matches the CTL EMA half-life used elsewhere in the model (`CTL_DECAY` corresponds to 42-day τ ≈ 6w half-life; we use 4w here because recovery-rate plasticity should track training adaptations, not lag them). Plews & Buchheit's monitoring guidance argues the recovery profile shifts within ~4–6w of meaningful training-load change.
- **Bayesian prior of 4 ghost samples**: deliberately heavy-handed for low-N stability. Until ≥16 real sessions accumulate, the prior dominates the fit (4 prior + ≤16 real, evenly weighted) — keeps `k_user` close to 8 while evidence is thin. Once N=16, the prior drops to ~20% of the weighted mass, letting data dominate.
- **Confidence floors (8 / 16 / 30)**: 16 ≈ 4–6 weeks of typical training matches the existing precedent for HRV baseline (`Score improves after 10 nights of data` in `recovery-view.ts`). 30 is the standard "law of large numbers" threshold below which a sample mean's standard error dominates. The countdown gate is at 16 because a wrong countdown is mostly informational; the ACWR ceiling gate is at 30 because a wrong ceiling could license excess load and carry injury risk.
- **Historical-backfill weight of 0.7**: historical sessions reconstructed from physiology + activity history lack the RPE / check-in corrections of live sessions, so they carry less signal. The 0.7× downweight is a pragmatic discount — strong enough to let live evidence dominate as it accumulates, light enough to seed personalisation on day one rather than waiting weeks.
- **Ceiling-shift coefficient `0.025` / shift cap `±0.10`**: the per-tier ACWR bands span 1.30 → 1.50 (a 0.20 range across the five tiers). Shift cap of 0.10 = half a tier's worth — meaningful but not enough to leapfrog tiers. Coefficient `0.025` × `(8 − k_user)` produces ±0.075 across most of the user range, with the clamp catching the outermost slow-recoverer band.

**Defensibility of the overall approach**:
- The model is a single-parameter Bayesian update on top of an existing physiologically-grounded formula. We aren't introducing a new physiological theory; we're fitting one constant from observed data with a population-anchored prior.
- The fit composes cleanly with `recoveryAdj` (transient) — no double-counting. Concretely: if a user has chronically low HRV but recovers quickly when their HRV is at *their* baseline, the transient `recoveryAdj` captures the chronic depression; `k_user` captures the recovery-rate trait independent of state.
- The composite z-score is signal-conservative: requiring HRV (or RHR with sign flip) to return to baseline before declaring recovery uses the same metrics that validated published recovery-monitoring frameworks (Plews/Buchheit; Flatt & Esco 2016).

**Known limitations**:
- **No causal model.** The fit measures observed correlation between session load and physiology return-time. If a user's HRV is depressed by external factors (heat, alcohol, illness) on observation days, the fit pulls `k_user` slow even though the session itself isn't responsible. Heat correction exists for HR drift but not for HRV; a future refinement could exclude observation days flagged as travel/illness.
- **Day-resolution physiology.** HRV and RHR are once-per-day (morning measurement). The minimum observable recovery is 24h. A session that genuinely recovers in 12h reads as 24h to the model, biasing `k_user` slow for fast recoverers. Probably washes in the EMA but worth noting.
- **Single-dimensional learning.** A unified `k_user` doesn't separate by workout type. RPE-vs-expected on the next session is captured in the entry shape (`rpeNextSession`) for a future per-type extension, but the MVP fits a single rate. Cycling vs running recovery time-constants differ in published literature (Skiba 2014, GoldenCheetah W'/CP model docs); this is a known approximation.
- **Population prior is research-cohort-derived.** The Banister-class evidence comes mostly from highly-trained athlete cohorts in a few labs. The clamp `[5, 13]` is generous but the prior weight may produce bias for users whose true `k_user` is outside the typical range. The 30-session high-confidence floor mitigates by letting data eventually dominate.
- **Right-censoring is symmetric in the fit** — a session that never recovers in 96h contributes ratio = 96h / predicted, which can drag the fit toward the slow-recoverer side. Correct in the limit but may under-estimate fast recoverers if their high-load sessions consistently censor. A future refinement could weight censored entries below uncensored.


---

## Swim Engagement Penalty — Projected CSS Baseline (2026-05-06)

**File**: `src/calculations/race-prediction.triathlon.ts` (`buildProjection`, swim section).

**Problem**: the prior `specificEndurancePenalty` framework applies a readiness penalty to the "if you raced today" current swim time. By design it leaves the projected (race-day) path unpenalised — the comment in `specific-endurance-penalty.ts` reads "race-day projection uses the plan's prescribed dose and gets full readiness by definition." This is correct for the volume dimension (the plan restores long-session readiness), but incorrect for the **baseline dimension**: a swimmer who measured CSS 2:22 a year ago and hasn't swum since does not start the plan from that CSS — technique decay has already degraded their actual starting point.

**The fix**: inflate the `baseline` passed to `applyTriHorizonSwim` when `disciplineConfidence.swim.weeksActive` is low. `weeksActive` is a proxy for how long the athlete has been away from swimming (12-week window, so 0 weeks active ≈ 12+ weeks off). The detraining rate is `CSS_DETRAINING_PER_4WK = 0.04` (4% per 4-week block, midpoint of Mujika 2010's 3–5%/4wk for swim). Number of equivalent detraining periods:

| weeksActive | Proxy weeks-off | Periods (÷4) | Multiplier |
|-------------|-----------------|--------------|------------|
| 0           | ~12wk           | 3            | 1.04³ ≈ 1.125 (+12.5%) |
| 1–2         | ~8wk            | 2            | 1.04² ≈ 1.082 (+8.2%)  |
| 3–5         | ≤6wk            | 0            | 1.0 (band demotion handles) |
| ≥6          | consistent      | 0            | 1.0 (no penalty) |

The compounding `(1 + r)^n` form mirrors how CSS detraining accumulates — each 4-week block degrades the previous result, not an absolute baseline.

**Why not double-count with band demotion**: `demoteBandByVolume` reduces the improvement *ceiling* (how fast gains accrue from the inflated starting point). The engagement penalty sets a worse *starting point*. Both are needed: the ceiling reduction says "your adaptation rate is slower" (you've lost training economy); the baseline inflation says "where you're starting is worse than the CSS number suggests" (you've lost fitness). They operate on different dimensions and compound correctly.

**Why not penalise the displayed CSS**: `out.swimCss.current` always reflects the measured value so the UI is truthful about the last test. Only the internal `effectiveCssBaseline` is inflated.

**Limitations**:
- `weeksActive` only covers the 12-week fitnessHistory window. A user who swam 13 weeks ago but not since would still show `weeksActive=0` and take the full penalty, which is appropriate.
- The proxy (0 active ≈ 12 weeks off) is conservative — some users may have swum 6 weeks ago and still show `weeksActive=0` if that single session didn't register a non-zero swimCtl. The penalty over-corrects for them slightly. Acceptable given the alternative (no penalty on genuinely stale baselines).
- Swim PB recency (analogous to `marathonPbAgeDays` in `blendPredictions`) is not implemented. A recent open-water race or time trial could reduce the penalty magnitude the same way a recent marathon PB reduces the run specificity penalty. Deferred to v2.

**User-set CSS exemption (2026-05-09)**: when `tri.swim.cssSource === 'user'` (athlete typed the value in manually), `swimDetrain4wkPeriods` is forced to 0 — the inflation does not fire regardless of `weeksActive`. Rationale: the engagement penalty is a *staleness* model. A measured CSS from 12 months ago really is stale. A CSS the user just typed in is a fresh ground-truth snapshot — they're telling the system "this is what I can do today", and the model has no grounds to project that backwards on the strength of "no swims logged this month". A real case prompted this: a user manually set CSS to 2:00/100m, raced one week later, and the projected race-day CSS came out as 2:15/100m (+12.5% inflation). The displayed projection contradicted what the user had just told the system. Derived CSS values (paired-PB inference, etc.) still receive the inflation when sparse — the assumption that staleness compounds away from training only holds when the value was inferred from old history, not when freshly declared.

---

## Cross-Modal VO2max (2026-05-01)

**Goal**: produce a defensible per-discipline VO2max estimate that gives users credit for cross-training (padel, tennis, football, cycling, etc.), and let them toggle between Mosaic's estimate and the device-reported value.

**Three-estimator decomposition** (`src/calculations/vo2-orchestrator.ts`):

1. **Running** — effort-calibrated VDOT (already in `effort-calibrated-vdot.ts`): pace-vs-%VO2R linear regression of recent qualifying runs, evaluated at %VO2R = 1.0, then mapped through Daniels' VDOT table. Anchors: Swain & Leutholtz 1997 *MSSE* 29:837–843; Daniels' Running Formula 4th ed. Confidence: high when N ≥ 8 with R² ≥ 0.7.

2. **Cycling** — ACSM cycle-ergometry (`cycling-vo2.ts`):
   ```
   VO2max ≈ 10.8 × (FTP_W / mass_kg) + 7
   ```
   ACSM Guidelines for Exercise Testing and Prescription, 11th ed. (2022). Validated by Hawley & Noakes 1992 *Eur J Appl Physiol* 65:79–83 in trained cyclists (R² > 0.9 for peak power → VO2max). Body weight defaults to sex-specific values (75 kg M / 62 kg F) when unset; default-weight estimates are confidence-downgraded one tier (kg error injects ±2 ml/kg/min).

3. **Cardiac ceiling** (modality-agnostic) — Uth-Sørensen (`cardiac-ceiling.ts`):
   ```
   VO2max ≈ 15.3 × HRmax_observed / HRrest
   ```
   Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. The constant 15.3 was derived from regression on trained runners and validated against gas-exchange testing (±10–15% accuracy). Aggregates HR exposure across **every** aerobic activity — running, cycling, padel, tennis, football, etc. — so cross-training contribution to cardiac fitness shows up here.
   Confidence: high when ≥ 8 sessions across ≥ 2 sports. Single-sport HRmax tends to under-state (a habitually slow runner who never spikes HR).

**Lift logic** — the bit that makes cross-training count toward running VO2max:

For each modality (running, cycling), the displayed estimate is
```
modality_VO2 = max(direct_estimate, cardiac_ceiling × peripheral_transfer)
```
where `peripheral_transfer ∈ [0.70, 1.0]` is the time-weighted sum of source-specific transfer coefficients across the user's last 8 weeks (`peripheral-transfer.ts`).

**Why a separate transfer table from `runSpec`** (load-discount): the two answer different questions. `runSpec` asks "how much of this training stress equals running stress?" — for ACWR / CTL purposes. Peripheral transfer asks "how much of this athlete's cardiac fitness shows up as VO2max in modality X?" — for capacity. VO2max transfer is much higher than load transfer because the central (cardiac) component of VO2max is fully shared across modalities while training stress is not (Bassett & Howley 2000, *MSSE* 32:70–84 — cardiac output explains 70–85% of VO2max variance between trained individuals).

**Transfer coefficients** (running target):

| Source modality            | Transfer | Citation                            |
|----------------------------|----------|-------------------------------------|
| Running (identity)         | 1.00     | —                                   |
| Weight-bearing intermittent (soccer, rugby, basketball, tennis, padel) | 0.92 | Hoff et al. 2002 *MSSE* 34:1925–1931; Aughey et al. 2014 *Sports Med* 44:929–957 |
| Cycling                    | 0.88     | Millet et al. 2009 *Sports Med* 39:179–206 |
| Other aerobic (rowing, hiking, stair climbing, elliptical) | 0.85–0.90 | Compromise per population data |
| Swimming                   | 0.75     | Holmér 1972 *J Appl Physiol* 33:502–509 |
| Static / non-cardiac (yoga, pilates, climbing) | 0.70 | Conservative floor |

Cycling-target table is symmetric (running source 0.88, etc.). Numbers are population means from cross-modal VO2max studies in trained athletes — individual variance is real, but exposing the source breakdown in the UI lets users see where the number comes from.

**Headline = highest of running, cycling, cardiac**. Reflects the cardiac ceiling the user has best demonstrated. A pure cyclist's headline is their cycling VO2; a triathlete's headline is whichever discipline they've trained hardest.

**Source toggle** (`s.vo2Source: 'mosaic' | 'device'`): defaults to `'mosaic'` with auto-fallback to device value when Mosaic confidence < medium. Pinning to `'device'` uses Garmin/Apple's reading regardless of our estimate quality. The priority chain in `physiological-vdot.ts` honours this preference.

**Recompute cost ≈ 2 ms** per launch. Pure local computation over already-loaded state (last 8 weeks of activities, ~20–50 rows). Triggered from `main.ts` after `setAthleteNormalizer` and again after `syncPhysiologySnapshot` resolves (in case fresh RHR/HRmax changed inputs).

**Known limitations**:

- **HRmax determination dominates the cardiac-ceiling error.** We use observed peak HR across recent training, not a maximal effort test. Users who never go truly maximal will under-estimate; we never over-credit. The 8-week window plus duration filter (≥ 60s) screens stray monitor spikes.
- **HRrest staleness.** Depends on Garmin/Apple sync. Stale RHR (post-illness, dehydration, alcohol) shifts the ratio. We use the value as synced; future refinement could use a 28-day rolling RHR.
- **Uth-Sørensen accuracy is ±10–15%** per the original study — wider than the running pace/HR regression (~5%). That's why direct running estimate wins when it's high-confidence.
- **Transfer coefficients are population means.** Individual variance in cross-modal VO2max transfer is real (untrained legs in a runner-turned-cyclist may transfer below 0.88 initially; a multi-sport athlete may transfer above 0.92). The drill-down exposes the source breakdown so users can sanity-check.
- **Modality-state interaction.** A fatigued runner may show low HR (parasympathetic suppression) or high HR (sympathetic drive). The 8-week window smooths this but doesn't eliminate it.
- **Swimming estimator deferred.** Modality is too specific (technique-bound) and HR signal is poor underwater. We don't display a swim VO2 even when the user does swim.

**References used**:

- Bassett & Howley 2000, *MSSE* 32:70–84. Limiting factors for maximum oxygen uptake and determinants of endurance performance.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Estimation of VO2max from the ratio between HRmax and HRrest.
- ACSM Guidelines for Exercise Testing and Prescription, 11th ed. (2022).
- Hawley & Noakes 1992, *Eur J Appl Physiol* 65:79–83. Peak power output predicts VO2max in trained cyclists.
- Swain & Leutholtz 1997, *MSSE* 29:837–843. Heart rate reserve is equivalent to %VO2 reserve.
- Daniels, Daniels' Running Formula, 4th ed. (2022).
- Millet, Vleck, Bentley 2009, *Sports Med* 39:179–206. Physiological differences between cycling and running.
- Hoff, Wisløff, Engen, Kemi, Helgerud 2002, *MSSE* 34:1925–1931. Soccer specific aerobic endurance training.
- Aughey, Falloon, Stanley 2014, *Sports Med* 44:929–957. Aerobic fitness in court-based intermittent sports.
- Holmér 1972, *J Appl Physiol* 33:502–509. Oxygen uptake during swimming in the trained athlete.

---

## Cross-Modal VO2max — lift removed (2026-05-02)

**Walk-back of the 2026-05-01 spec.** Earlier today we shipped a cardiac-ceiling lift: each modality's displayed VO2max was `max(direct_estimate, cardiac_ceiling × peripheral_transfer)`, intended to give cross-training credit. Tested against real user data (cyclist with FTP 295W, mixed running history), it produced misleading numbers — cycling displayed at 62 ml/kg/min when the user's FTP-direct ACSM value was ~50, with the gap entirely from the cardiac × transfer route.

**Why the lift was wrong.**

The cross-training contribution to running VO2max is **already captured implicitly** by the running pace–HR regression. A heart trained by padel/tennis/cycling pumps at a lower HR for a given pace; that shows up directly in the `pace + HR` observations the Daniels regression consumes. Adding `cardiac_ceiling × transfer_coefficient` on top of the regression layered cardiac contribution **on top of itself**, producing systematic inflation.

The original user intuition — "padel makes me a better runner, the app should reflect that in VO2max" — is correct biology. The error was thinking VO2max needed a *new mechanism* to capture it. Two existing mechanisms already do:

1. **Signal A iTRIMP** (rs-discounted load): padel contributes to run-equivalent CTL via the existing load discount system. This is the right place for "cross-training counts toward your training stress."
2. **Daniels VDOT regression**: a padel-built heart shows up as faster pace at given HR during runs. The regression doesn't care where the cardiac fitness came from.

The peripheral-transfer table (cycling 0.88, padel 0.92, swimming 0.75 etc., from Hoff 2002 / Millet 2009 / Holmér 1972) was real literature — those coefficients describe trained-athlete cross-modal VO2max transfer. But applying them as a runtime lift treats the cardiac ceiling as an *additive* signal when it's actually the *upstream limit* of what the modality regression already approximates.

**What stayed.**

- Per-modality direct estimators (running effort-calibrated VDOT, cycling ACSM)
- Cardiac ceiling computation (Uth-Sørensen) — surfaced as "Cardiovascular potential," informational only, never blended into modality numbers
- Headline = max of measured modalities, with cardiac as tier-2 fallback (anti-decay for HR-only-sport athletes), and `getPhysiologicalVdot()` as final floor (LT/PB/Tanda)
- Source toggle (Mosaic / Device)
- HRmax 220 sensor cap (sensor-glitch filter, defensible)
- Cardiac VO2 cap at 85 ml/kg/min — kept pragmatically, but flagged as a non-derived clamp; future work could replace it with extrapolation-warning UI when above 76 (Uth-Sørensen's calibration ceiling)

**What was removed.**

- `liftFromCardiac()` function in `vo2-orchestrator.ts`
- `peripheral-transfer.ts` and its test (whole module deleted)
- The `cardiac-lifted` value of `VO2Estimate.source`
- The cardiac × peripheral_transfer logic for both running and cycling

**Future-proofing note for next session.** If a future agent considers reintroducing some form of cross-modal lift: don't, unless you have evidence the running regression is *under*-counting cardiac contribution (it isn't — the regression sees the actual HR signal). The right way to surface "your overall fitness exceeds what running data alone shows" is the cardiac ceiling row, displayed as informational context. Don't blend it back into the modality numbers.

**References (kept here for the historical record, in case the lift question recurs):**

- Bassett & Howley 2000, *MSSE* 32:70–84. Limiting factors for VO2max.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Uth-Sørensen formula.
- ACSM Guidelines, 11th ed. (2022). Cycle ergometry equation.
- Daniels' Running Formula, 4th ed. (2022). VDOT regression and pace-VO2 relationship.
- Swain & Leutholtz 1997, *MSSE* 29:837–843. %HRR ≈ %VO2R.
- Hoff et al. 2002, *MSSE* 34:1925–1931. Soccer aerobic transfer (referenced for population transfer mean — no longer applied as runtime coefficient).
- Millet, Vleck, Bentley 2009, *Sports Med* 39:179–206. Cross-modal cycling/running VO2max (same — informational only now).
- Holmér 1972, *J Appl Physiol* 33:502–509. Swimming VO2max.

## Cross-Training VO2max (2026-05-06)

**Problem.** Cardiac ceiling (Uth-Sørensen `15.3 × HRmax/HRrest`) tells us how high the heart *can* go, but not how much aerobic work the athlete *sustains*. A rugby player who briefly hits 195 bpm in a sprint has the same cardiac ceiling as one who holds 175 bpm for 60 minutes; their aerobic capacities are very different. A user playing touch rugby twice a week wants visible credit for that fitness in their VO2max picture, separate from the per-modality run/bike numbers and separate from the peak-only cardiac ceiling.

**Method.** Per qualifying cross-training session (non-run, non-bike, ≥ 20 min, avg HR ≥ 75% HRmax):

1. `%HRR = (avgHR − RHR) / (HRmax − RHR)` — heart rate reserve fraction sustained.
2. Convert to fractional VO2 reserve via Swain & Leutholtz (1997, *MSSE* 29:837–843):
   `%VO2R ≈ %HRR`. The linear identity holds well across 40–85% with ~5% drift outside that band, accepted.
3. Anchor to cardiac ceiling: `sessionVO2 = cardiacCeiling × %VO2R × durationFactor`, where `durationFactor = min(1, durationMin / 30)` credits sustain. A 20-min session counts at 0.67×; a 30+ min session at 1.0×. Beyond 30 min, no further credit — sustain is sustain, longer doesn't make VO2max bigger.
4. Aggregate via trimmed mean (drop bottom 25%, mean of remainder) across qualifying sessions. Robust to occasional weak sessions that pass the gate.

**Why this is additive over cardiac ceiling.** Cardiac ceiling is a one-shot peak ratio. Cross-training is sustained fraction × ceiling × duration credit. They measure different physiology — peak vs sustained — and the cross-training estimate is by construction ≤ cardiac ceiling.

**Why this does not lift running or cycling.** Same rationale as the 2026-05-02 lift removal: the running VDOT regression already credits cardiac contribution implicitly because a heart trained by rugby pumps at a lower HR-for-pace during runs. Adding a cross-training lift on top would double-count. The cross-training estimate is additive (fourth surface) not blended (no impact on running/cycling/headline).

**Confidence model.**
- `low` — 3–4 qualifying sessions
- `medium` — 5–7 qualifying sessions
- `high` — 8+ qualifying sessions across ≥ 2 distinct sport types

Hidden entirely (`vo2 = null`, reason `'insufficient-sessions'`) below 3 sessions. Sport diversity gates the high tier because a single sport's HR profile is idiosyncratic — touch rugby's stop-start nature averages low even when capacity is high.

**Known limitations.**
- HR-only methods cannot distinguish aerobic capacity from running economy or cardiovascular drift. This is a *fitness proxy*, not a lab measure.
- Swain's linear %HRR↔%VO2R holds best in 40–85%; pushed beyond, drifts ~5%.
- Cardiac ceiling anchor inherits Uth-Sørensen's ±10–15% accuracy band — the cross-training estimate is therefore at best ±15%.
- Mode-of-effort matters: a session with intervals above LT plus easy recovery averages to a moderate %HRR even though aerobic stress is much higher than the average suggests. v1 accepts this — it under-credits intervals, which is the safer error.

**Files.** `src/calculations/cross-training-vo2.ts`, `src/calculations/vo2-orchestrator.ts` (wired in after cardiac), `src/types/state.ts` (added `crossTraining: VO2Estimate` and `'sustained-hr-cross-training'` source), `src/ui/vo2max-card.ts` (4th row + detail section).

**References.**
- Swain & Leutholtz 1997, *MSSE* 29:837–843. %HRR ≈ %VO2R linear identity.
- Uth, Sørensen, Overgaard, Pedersen 2004, *Eur J Appl Physiol* 91:111–115. Cardiac ceiling formula used as anchor.
- Bassett & Howley 2000, *MSSE* 32:70–84. Modality-independence of central cardiovascular capacity.

## HYROX Population Percentiles (2026-05-06)

**Purpose.** Maps a predicted HYROX finish time to "faster than X% of finishers" for the population comparison card in `src/ui/hyrox/stats-view.ts`.

**Data source.** HyroxDataLab global race database (700k+ finishers, Open and Pro divisions combined). Percentile breakpoints extracted from published cumulative finish-time distributions (hyroxdatalab.com, accessed 2026). Values are gender-mixed Open-division midpoints; Pro division table scaled proportionally (~15% faster for men, ~12% for women, self-selected field).

**Method.** Piecewise linear interpolation between anchor breakpoints. Each anchor `[finishTimeSec, cumulativePercentile]` represents "X% of finishers are at or below this time." "Faster than Y%" = 100 − cumulativePercentile at the user's time. Rounded to integer percent for display.

**Open division anchor points (gender-mixed):**
- 45 min → 0th pctile (WR territory)
- 60 min → 5th (sub-1h, competitive band)
- 80 min → 15th (advanced)
- 100 min → 35th (intermediate)
- 120 min → 60th (novice)
- 150 min → 80th
- 180 min → 90th
- 240 min → 98th
- 360 min → 100th

**Pro division:** same shape, compressed ~15% across the time axis (self-selected faster field).

**Known limitations.**
- Gender-mixed distribution hides meaningful male/female splits (men average ~15% faster than women at the same relative effort for HYROX format). The display is still valid as a rough population comparison, but a male sub-90-min finisher is in a different percentile vs the male-only field.
- Age-group effects are not modelled. Masters (50+) and juniors anchor in different parts of the distribution.
- Doubles format uses the Open table as a proxy (dedicated Doubles-only distribution not available from published data). Accuracy is lower for Doubles.
- Distribution shape varies by event location — major city events (London, Frankfurt) attract faster fields than regional events. The table uses a global aggregate.

**Files.** `src/calculations/hyrox-population.ts` (new), `src/ui/hyrox/stats-view.ts` (consumes).

## VO2 Resolver Audit (2026-05-07)

**Purpose.** Systematic audit of `getPhysiologicalVdot` resolver chain (`src/calculations/physiological-vdot.ts:144`) and supporting sync paths before adding conflict-surfacing UI (WS-2b).

**Findings — pass/fail per check:**

| # | Check | Result |
|---|---|---|
| A | `cv(5000, 1200)` = 49.81 | PASS [49.5–50.1] |
| A | `cv(21097.5, 5400)` = 50.98 | PASS (Daniels formula gives ~51 for HM @ 1:30:00, not ~56 — audit plan had wrong expected range) |
| A | `cv(42195, 11400)` = 50.21 | PASS (marathon @ 3:10:00 → VDOT ~50.2 per Daniels) |
| A | `cv(10000, 2400)` = 51.94 | PASS (10K @ 40:00 → VDOT ~51.9 — same pace as 5K@20:00 but longer effort yields higher VDOT by design) |
| B | `pbDerivedVdot` median with 5K 18:00 (VDOT 56.3) + M 4:00 (VDOT 37.9) = 47.1 | PASS (median 47.1 ≠ max 56.3) |
| C | Staleness gate for Garmin users who stop running | **BUG FOUND — see below** |
| D | `hrCalibratedVdot` confidence gate at n=2 | PASS (< 3 points → `'none'`, not 'medium') |
| E | Display surfaces use `getPhysiologicalVdot()` not raw `state.v` | PASS (all four UI surfaces confirmed) |
| F | TRUSTED_LT_SOURCES excludes `'blended'` | PASS (line 71, confirmed correct) |

**Bug found (C): Garmin staleness leak for triathletes who stop running.**

`deviceVo2AgeDays()` checked `physiologyHistory[].vo2max` for the freshness gate. `physiologyHistory` is built from `daily_metrics.vo2max` (Garmin's generic cardio estimate, can update from cycling). But `s.vo2` is set from `physiology_snapshots.vo2_max_running` (running-specific, only updates from outdoor running activity). For a triathlete who switches to pure cycling or takes an injury break: `daily_metrics.vo2max` keeps updating → `physiologyHistory` has recent vo2max entries → `deviceVo2AgeDays()` returns 0 → `isDeviceFresh = true` → stale `s.vo2` (from months-old running) is used as "fresh".

**Fix applied:** Added `s.vo2UpdatedAt?: string` (ISO date) to `SimulatorState`. Stamped whenever `s.vo2` is written:
- `physiologySync.ts:127` — Garmin `physiology_snapshots.vo2_max_running` path
- `appleHealthSync.ts:167` — Apple HealthKit VO2max path

`deviceVo2AgeDays()` now prefers `s.vo2UpdatedAt` and falls back to the `physiologyHistory` scan for legacy state (maintains "don't drop a valid number on a missing-timestamp technicality" policy for existing users).

**Note on Daniels `cv()` expected ranges.** The audit plan had incorrect VDOT ranges for HM, marathon, and 10K. These came from confusing Daniels performance-equivalence tables (what time a VDOT=55 athlete runs) with the inverse (what VDOT does a given performance imply). The formula is correct: HM @ 1:30:00 → VDOT ~51 (that's what a half-marathon specialist at that pace implies, not what a 5K@20:00 runner implies for their HM). Cross-verified against `vdot.test.ts` (31 tests, all passing).

**Files.** `src/types/state.ts` (new `vo2UpdatedAt` field), `src/data/physiologySync.ts` (stamp on write), `src/data/appleHealthSync.ts` (stamp on write), `src/calculations/physiological-vdot.ts` (updated `deviceVo2AgeDays` to prefer `vo2UpdatedAt`).

## Triathlon Bike/Swim PB-Recency Cross-Credit (2026-05-07)

**Problem.** `computeDisciplineReadiness` reduced the run leg's readiness penalty when the athlete had a recent standalone race PB (e.g., recent half marathon → lighter 70.3 run penalty). Bike and swim legs got no equivalent credit — a triathlete who finished an IM 6 months ago could still face full bike/swim readiness penalties as if they'd never raced those legs.

**Method.** Scan `triConfig.raceLog` for completed triathlon entries where `actualPerLeg[discipline] > 0`. For each qualifying entry, look up a cross-credit weight from `TRI_DISTANCE_CROSS_CREDIT[fromDistance][targetDistance][discipline]`. Apply the same age-decay bands (`RUN_PB_RECENCY_BANDS`) as the run side, scaled by cross-credit weight:

```
effectiveFactor = 1 − (1 − bandFactor) × crossCreditWeight
penaltyMultiplier = 1 + (penaltyMultiplier − 1) × effectiveFactor
```

Where:
- `bandFactor = 0.5` for race < 1 year ago, `0.75` for 1-2 years, `1.0` for > 2 years (from `RUN_PB_RECENCY_BANDS`)
- `crossCreditWeight` from `TRI_DISTANCE_CROSS_CREDIT` (0 to 1.0)

**Cross-credit weights (TRI_DISTANCE_CROSS_CREDIT):**

Richer-counts-for-shorter principle: a longer race fully credits shorter target distances. Reverse direction uses partial credit.

| From \ To | IM | 70.3 | Olympic | Sprint |
|---|---|---|---|---|
| IM | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| 70.3 | 0.6/0.6/0.5 | 1.0/1.0/1.0 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| Olympic | 0.3/0.3/0.3 | 0.6/0.6/0.5 | 1.0/1.0/1.0 | 1.0/1.0/1.0 |
| Sprint | 0.2/0.2/0.2 | 0.3/0.3/0.3 | 0.7/0.7/1.0 | 1.0/1.0/1.0 |

(Values are swim/bike/run for each cell.)

**Scientific rationale for partial reverse credit (Coyle 1984).** Fractional utilization of VO2max decays with duration — a sprint-distance bike leg (~30 min) and an IM bike leg (~5 hours) require qualitatively different pacing and substrate metabolism. Completing a sprint proves basic bike endurance but not the specific aerobic sustainability needed at IM pace. Run cross-credit from sprint→olympic stays at 1.0 because Daniels VDOT equivalence is well-validated across shorter run distances.

**Known limitations.**
- Entries before this feature shipped do not have `actualPerLeg` from the new schema extensions (WS-1 adds `predictedRawPerLeg` separately). Cross-credit reads `actualPerLeg` from existing entries — this works on all existing raceLog entries which already store `actualPerLeg`.
- Only triathlon distances are in raceLog today (no standalone bike TT or open-water swim results). The credit is therefore only applied when the user has completed a full triathlon event.
- Olympic and sprint distances are not currently logged to raceLog (only 70.3 and IM). Those rows of the cross-credit table are forward-compatible placeholders.

**Files.** `src/constants/race-readiness-targets.ts` (new `TRI_DISTANCE_CROSS_CREDIT`), `src/calculations/specific-endurance-penalty.ts` (unified recency block + `readTriRaceRecencyDays`), `src/ui/triathlon/race-readiness-detail.ts` (extended copy).

---

## §M — HYROX Band-Scaled Run-Leg Fatigue Model

**Problem.** A constant per-station fatigue rate (0.8%/station) applied to all athletes regardless of ability is not realistic. Elite athletes hold pace nearly flat across all 8 run legs; beginners show significant deterioration by run 7–8.

**Model.** Fatigued pace = base pace × (1 + legIndex × perStationFatigueRate), normalised so total run time = 8 × base pace (energy conservation). The per-station rate is band-scaled:

| Band | Rate (singles) | Notes |
|---|---|---|
| competitive | 0.4%/station | HyroxDataLab: top-10 finishers within ~2–4% across all 8 legs |
| advanced | 0.5%/station | |
| intermediate | 0.6%/station | |
| novice | 0.7%/station | ~5.6% total drift from leg 1 → leg 8 |
| beginner | 0.9%/station | |
| total_beginner | 1.1%/station | ~8.8% total drift — consistent with age-group 2h+ finishers |

Doubles format: rate × 0.5 (athletes alternate stations; waiting partner accumulates metabolic cost but not full eccentric load).

**Scientific basis.** HYROX finishing-time distributions (HyroxDataLab / roxlyfe.com) show that run-leg decline scales with performance level. Goss 2021 (repeated high-intensity bouts and run-economy decline) supports the mechanistic model. Bi-exponential EPOC decay would be more accurate but requires integrating station-specific eccentric load over time — too complex for v1.

**Known limitations.** Rate constants are from population distributions, not individual calibration. Normalisation to 8 × base pace is a simplification — the true energy balance accounts for increased HR, glycolytic contribution, and ventilatory drift. Values pending real-race validation.

**Files.** `src/constants/hyrox-constants.ts` (`PER_STATION_FATIGUE_RATE_BY_BAND`), `src/calculations/race-prediction.hyrox.ts` (model application), `src/ui/hyrox/forecast-view.ts` (chart rendering).

---

## Triathlon Race Prediction — Taper Invariant (2026-05-08)

**Problem.** A user set an Ironman 1 week away and the forecast showed projected swim +13:32 *slower* and projected run −14:02 *faster* than today. Both deltas are physiologically nonsensical over a 7-day horizon — taper consolidates fitness, it doesn't build or destroy it (Mujika 2002).

**Root cause — two divergence sources, neither scaled by `weeksRemaining`.**

1. *Swim engagement penalty (asymmetric).* When `weeksActive ≤ 2`, the predictor inflated the swim CSS baseline by up to +12% (Mujika 2010 detraining model: technique decays at 3–5%/4w without water time). The inflation was applied *only to the projected race-time call* — the "today" call kept the literal stale CSS measurement. Net effect: today=2:22 (fictional), projected=2:40 (realistic) → +13:32 phantom slowdown.

2. *Durability cap relaxation (unconditional).* The projected race-time call passed `projectedLongestSession.{bike,run} = DURABILITY_THRESHOLDS[distance].long{Ride,Run}Sec` regardless of `weeksRemaining`. The "today" call passed actual longest sessions. With `MAX_DURABILITY_PENALTY = 0.05`, this produced up to a 5% phantom run speedup. 5% × 4:40:38 = 14:02 ✓ — matches the observed delta exactly.

**Invariant introduced.** When the race is inside the discipline's taper window (`weeksRemaining ≤ TRI_TAPER_WEEKS[discipline][distance]`), `projected` per-leg must equal `current` per-leg within ±30s. Locked by the test `race-prediction.triathlon.test.ts → race inside taper window: projected per-leg matches current within 30s`.

**Two distinct fix shapes.**

- *Stale-measurement adjustments (engagement penalty)* represent a TODAY truth — the literal measurement is fiction; the user's real today CSS is worse. Applied symmetrically to BOTH `current` and `projected` calls via a shared `EffectiveBaselines` object returned from `buildProjection`. The displayed `projection.swimCss.current` keeps the literal value for transparency.

- *Plan-execution credits (durability cap relaxation)* represent fitness the plan *will deliver* over `weeksRemaining`. Scaled by per-discipline `executionFactor = 1 − penaltyShare` (the same closure math the existing race-readiness penalty uses). With 1-week IM in full taper → `executionFactor = 0` → projected longest session = actual longest session → no relaxation.

`projectedLongestSession.{bike,run} = lerpDurability(actual, threshold, executionFactor)`

where `lerpDurability(a, t, f) = a + max(0, t − a) × clamp(f, 0, 1)` — never reduces an athlete who already exceeds the threshold.

**Scientific basis.** Mujika 2002 (*Med Sci Sports Exerc* "Scientific bases for precompetition tapering strategies") — taper of 1–3 weeks consolidates fitness without building it. Mujika 2010 (*Br J Sports Med*) — detraining 3–5%/4w without specific stimulus. Per-discipline taper durations from `TRI_TAPER_WEEKS` (Friel 2018 *Triathlete's Training Bible*: swim taper longest because technique consolidation needs more time, bike shortest).

**Known limitations.** The taper invariant assumes `usefulWeeks = max(0, weeksRemaining − taperWeeks)` is the right way to model "no plan-execution time available." This already drives the race-readiness penalty closure share, so applying the same factor to durability cap relaxation keeps the model coherent. If future divergence sources are added between projected and current race-time calls, they must also be gated through `executionFactor` to preserve the invariant.

**Files.** `src/calculations/race-prediction.triathlon.ts` (reordered penalty-share computation, added `lerpDurability`, threaded `EffectiveBaselines` through `buildProjection`), `src/calculations/race-prediction.triathlon.test.ts` (new invariant test).

---

## §T — Triathlon prediction model improvements (2026-05-12)

### §T1 — Brick-adapted run-leg fatigue discount (ISSUE-200)

**Formula**: `fatigueDiscount = baseDiscount × (1 − brickAdaptation × BRICK_MAX_DISCOUNT_REDUCTION)`

Where:
- `baseDiscount` = `RUN_FATIGUE_DISCOUNT_70_3 = 0.05` or `RUN_FATIGUE_DISCOUNT_IRONMAN = 0.11` (Bentley 2007; Landers 2008)
- `brickAdaptation` = recency-weighted brick count / `BRICK_FULL_ADAPT_COUNT (12)`, clamped [0, 1]
- Recency weighting: exponential decay, half-life 4 weeks (recent bricks count more)
- `BRICK_MAX_DISCOUNT_REDUCTION = 0.40` — cap at 40% reduction; elite triathletes still fade even with high brick volume

**Science**: Millet & Vleck 2000 (*Med Sci Sports Exerc*): "Performance changes in world-class triathletes during a `race-pace` triathlon simulation" — observed that brick-trained athletes exhibit significantly attenuated run-leg performance decrement compared to non-brick-trained controls with equivalent fitness markers.

**Known limitations**: Adaptation curve is modelled as exponential to saturation; real adaptation is likely sigmoidal. `BRICK_FULL_ADAPT_COUNT = 12` is a midpoint of the 10–15 session range reported by Millet & Vleck. Overestimates adaptation for athletes who do bricks inconsistently across a training cycle.

---

### §T2 — Run-specific VDOT in horizon scaling (ISSUE-188)

**Change**: Horizon-scaling denominator uses `runDerivedCurrentVdot = cv(runDistM, blendedOpenSec)` instead of `args.state.v`.

**Rationale**: `args.state.v` is the blended VDOT, which bike cross-training can inflate. Using the run-specific current VDOT as denominator makes the scaling explicitly run-anchored. Since `applyTriHorizonRun` applies a percentage improvement (not absolute), the ratio is numerically equivalent for normal operation. The change guards against future modifications that might decouple the numerator from the run-specific baseline.

**Cross-training transfer**: Cycling does build aerobic capacity (VO2max, cardiac output) that genuinely transfers to running (40–70% efficiency per Mujika 2011 cross-training review). The blended VDOT is not wrong — bike fitness correctly flows into the primary `blendPredictions` path. This fix only clarifies the horizon-scaling step.

**Known limitations**: The equivalence holds only when `applyTriHorizonRun` returns a percentage improvement. If future horizon models return absolute VDOT gains, the denominator choice becomes meaningful.

---

### §T3 — Open-water swim deficit scaled by athlete OW experience (ISSUE-186)

**Formula**: `owPenaltyFraction = owBasePenalty × (1 − owAdaptation)`

Where:
- `BASE_OW_PENALTY_NON_WETSUIT = 0.05` — 5% for novice swimmer in non-wetsuit race
- `BASE_OW_PENALTY_WETSUIT = 0.02` — 2% for novice swimmer in wetsuit race (wetsuit buoyancy offsets OW inefficiency)
- `owAdaptation = 1 − exp(−effectiveCount / OW_ADAPT_HALF_SESSIONS)` — asymptotic curve
- `OW_ADAPT_HALF_SESSIONS = 5` — 5 effective sessions for 63% adaptation (most gains in first 5–10 sessions)
- `effectiveCount` from last 26 weeks; sessions older than 12 weeks count at 0.5

**Science**:
- Veiga et al. 2013 (*Int J Sports Physiol Perform*): pool-to-OW deficit ~5% for non-wetsuit, primarily from sighting (zigzag path adds ~2–3% distance equivalent), no turn walls, and mass-start contact
- Toussaint et al. 2002 (*J Biomech*): wetsuit buoyancy reduces drag and partially restores the pool-to-OW deficit, narrowing it to ~2%
- Adaptation: most OW-specific gains (efficient sighting lines, drafting, mass-start positioning) acquired within 10–15 OW swims

**Known limitations**: Strava `OPEN_WATER_SWIMMING` sport label is not universally applied; athletes who record OW swims as generic `SWIMMING` won't accumulate adaptation. Recency weighting uses a simple threshold (< 12 weeks = full, else 0.5) rather than continuous decay.

---

### §T4 — Heat acclimatisation discount on climate penalty (ISSUE-190)

**Formula**: 
```
discountFraction = max(0, 0.5 × (1 − tempGap / 15))
where tempGap = raceAnchorTemp − trainingTempC
runDiscount = baseRunSec × (CLIMATE_RUN_MULTIPLIER[climate] − 1.0) × discountFraction
bikeDiscount = baseBikeSec × (CLIMATE_BIKE_MULTIPLIER[climate] − 1.0) × discountFraction
```

Applied after course factors as athlete-level correction (subtracted from post-multiplier leg times).

**Anchors**: raceAnchorTemp from `CLIMATE_ANCHOR_TEMP_C` (cool=12°C, warm=24°C, hot=30°C). Training temp from `ambientTempC` on recent activities (Open-Meteo, 4-week window, minimum 4 readings required).

**Science**: Lorenzo & Cheuvront 2010 (*Eur J Appl Physiol*): 10–14 days of heat acclimatisation (HA) preserves 3–5% performance in hot conditions via plasma volume expansion, cardiovascular adaptation, and improved sweat rate. A Singapore-based athlete racing IM Vietnam carries effectively no net heat penalty; a Stockholm-based athlete carries the full penalty.

**50% cap rationale**: HA research shows near-complete restoration for well-acclimatised athletes in moderate heat, but humidity adds a residual effect (sweat rate limits) that HA can't fully overcome. Capping at 50% discount is conservative and defensible.

**Known limitations**: `ambientTempC` is only populated for outdoor runs/rides with GPS start location. Athletes without temperature data receive no discount regardless of training environment. Does not model humidity acclimatisation separately (hot-humid category receives same formula as hot).

---

### §T5 — Marathon PB depth credit on IM run leg (ISSUE-191)

**Formula**: `marathonDepthMultiplier = 1.0 − depthCredit × recencyFactor`

Where:
- `depthCredit = clamp((4:30 − pbTime) / (4:30 − 2:45), 0, 1) × MAX_MARATHON_DEPTH_CREDIT`
- `MAX_MARATHON_DEPTH_CREDIT = 0.04` (4% pace benefit at sub-2:45; confirmed by Tristan 2026-05-12)
- Credit onset at sub-4:30, full credit at sub-2:45 — smooth linear between
- `recencyFactor`: < 2yr = 1.0, 2–4yr = 0.6, > 4yr = 0.3 (old PBs represent past capacity)
- IM run leg only (not 70.3 — HM duration insufficient for durability headroom to dominate)

**Science**: Laursen & Rhodes 2001 (*Sports Med*) triathlon physiology review: marathon-experienced athletes demonstrate materially better IM marathon pacing through (a) durability — operating at lower % of ceiling at IM marathon intensity, (b) glycogen-sparing economy at prolonged aerobic effort, and (c) pacing experience managing fatigue across the second half. Two athletes at VDOT 52 can have 2:50 vs 3:50 marathon PBs; the 2:50 athlete runs the IM marathon well within their durability zone.

**4% calibration**: At VDOT 52, a 2:45 marathoner vs a 4:30 marathoner at the same blended VDOT — the gap in expected IM run time is approximately 7–10 min empirically. 4% of a 2:50 IM run split ≈ 6.8 min, at the low end of this range. Conservative but defensible. Tristan confirmed 4% after reviewing the 5-min example.

**Known limitations**: PB date stored in `state.onboarding.pbDates.m` (ISO string) — if absent, full recency is assumed. Does not model the interaction between marathon depth credit and the brick adaptation discount (both reduce the net run penalty independently). Combined effect is multiplicative, which may slightly over-benefit athletes with both high brick volume and a fast marathon PB.
