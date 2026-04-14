# Science Log

Scientific rationale for every model, formula, and algorithm that drives user-facing numbers. Each entry documents the formula, what each term means, why it's defensible, and known limitations.

New entries are added at the top. When modifying a model, update its entry rather than adding a duplicate.

### Companion Research Documents

For the full literature review, evidence synthesis, confidence levels, and bibliography behind the models documented here, see:

- **Running**: `docs/research/running.md` — load quantification, periodization, physiological adaptation, strength integration, cross-training transfer, tapering
- **Triathlon**: `docs/TRIATHLON.md` — per-discipline TSS, impulse-response model, concurrent training, bike-to-run transition science, taper protocols
- **HYROX**: `docs/research/hyrox.md` — three-dimensional load model (aerobic/anaerobic/MTL), station taxonomy, concurrent training, replacement matrix

This log documents **formulas and implementation**. The research docs document **why those formulas are defensible**.

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

## Volume-Scaled Marathon LT Multiplier (2026-04-15)

**Problem.** Fractional utilization at marathon pace — how high a % of VO2max/LT you can hold for 2.5+ hours — is trained primarily by long runs and sustained weekly running volume. A fit athlete (e.g. 4:12/km LT) who stopped running cannot sustain the same fraction of LT over 42K as a fully trained athlete with the same LT value. The existing marathon LT multiplier in `predictFromLT` varied by tier (derived from LT pace) but was blind to current running volume — so a detrained-but-historically-fast athlete got the aggressive 1.06 multiplier regardless of recent km.

**Physiological basis.**

Joyner & Coyle (2008) decompose marathon performance as:

```
Marathon pace ≈ VO2max × fractional_utilization × running_economy
```

Fractional utilization is the most volume-sensitive term. Research across ability levels shows elites sustain ~85-88% VO2max at marathon pace versus ~70-75% for undertrained runners. The differentiator is not VO2max or LT ceiling — those are aerobic capacity markers — but the ability to defend pace in the final 10-12 km, which requires glycogen-sparing fat oxidation, muscular fatigue resistance, and pacing discipline. All volume-dependent.

Coyle (1984) shows rapid decline in these specific adaptations with inactivity (capillary density, mitochondrial enzyme activity, glycogen storage), faster than VO2max itself.

**Implementation.** In `predictFromLT`, after picking the LT-derived tier multiplier, apply a volume bump:

```
weeklyRunKm ≥ 50 → +0.00   (fully volume-trained, tier multiplier unchanged)
weeklyRunKm ≥ 30 → +0.02   (moderate training, mild penalty)
weeklyRunKm ≥ 15 → +0.05   (light training, meaningful fractional-utilization cost)
weeklyRunKm < 15 → +0.08   (essentially untrained for marathon distance)

m = min(tierMult + volBump, 1.14)  // capped at beginner tier max
```

Example: a 4:12/km LT athlete (tier "performance", balanced type) is normally multiplier 1.06 → 3:07 marathon. At 10 km/wk running volume they get 1.14 → 3:22 marathon. Same aerobic ceiling, ~15 minutes slower because they cannot hold it.

**Why bands not a formula.** Research gives us the shape (inverse exponential saturation) but not a validated functional form across the low-volume range. Bands are transparent and clamped; a formula would imply spurious precision.

**Scope.** Marathon only (`targetDist === 42195`). 5K/10K/HM fractional utilization is less volume-sensitive — those races are more VO2-limited and less dependent on fat oxidation or glycogen defense. Their LT multipliers remain stable across volumes.

**Interaction with low-volume weight discount.** The existing `lowVolumeDiscount` shifts LT+VO2 weight onto PB at low volume. For marathon, LT and volume adjustment now both move the prediction slower, but in different ways: (a) volume makes the LT prediction itself slower, (b) weight shift reduces LT's influence on the blend. Compounding is modest (~1-2 min) and directionally correct — both expressing "marathon-specific readiness is compromised."

**Known limitations.**
- Volume bands (50/30/15 km/wk) are pragmatic, not outcome-calibrated.
- Doesn't distinguish long-run presence specifically — 30 km/wk of 5 × 6K runs is different from 30 km/wk with one 20K run. Former is arguably less marathon-ready.
- Caps at 1.14 even at truly zero volume; real marathons at zero training could blow up 4:00+. Cap prevents absurd predictions but means the model under-penalises at the extreme low end.

**References.**
- Joyner MJ, Coyle EF (2008). *J Physiol* — "Endurance exercise performance: the physiology of champions."
- Coyle EF et al. (1984). *JAP* — Detraining loss of adaptations.
- Billat V et al. (2003). *MSSE* — Fractional utilization differences between marathon tiers.
- Daniels J. *Daniels' Running Formula* (3rd ed.) — Marathon pace = 84-88% vVO2max tables, implicitly volume-tiered.

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
Easy (E)        = ltPace * 1.15     (15% slower than LT)
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

**Example**: 3h hard hike (90 load) Monday, easy run (20 load) Tuesday, checking Wednesday morning:
- Hike at 40h: halfLife = 48 * 0.95 * 1.3 = 59h → decayed = 57 (still significant)
- Run at 16h: halfLife = 48 * 1.0 = 48h → decayed = 16
- Total: 73 (heavy warning — matches lived experience of 3-day soreness when continuing to exercise)

**Known limitations**:
- Re-loading penalty is activity-count based, not load-weighted (a gentle walk counts the same as a hard run for penalty purposes)
- Cap at 3 reloads prevents runaway half-life but may underestimate recovery delay for athletes training 2x daily
- `recoveryMult` in SPORTS_DB reflects overall recovery demand, not leg-specific EIMD. In practice this is not an issue: sports with high upper-body demand but no leg loading (boxing, swimming, climbing) have `legLoadPerMin: 0` and never create leg load entries, so their recoveryMult is never applied to leg decay

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

## LT Multiplier Matrix (tier-aware marathon, audit 2026-04-10)

**File**: `src/calculations/predictions.ts`

**5K/10K/HM** (stable across tiers):

| Distance | Speed | Balanced | Endurance |
|---|---|---|---|
| 5K | 0.92 | 0.935 | 0.95 |
| 10K | 0.98 | 0.995 | 1.01 |
| Half | 1.03 | 1.045 | 1.06 |

**Marathon** (tier-aware):

| Tier | Speed | Balanced | Endurance |
|---|---|---|---|
| high_volume / performance | 1.08 | 1.06 | 1.04 |
| trained | 1.10 | 1.08 | 1.06 |
| recreational (default) | 1.12 | 1.10 | 1.08 |
| beginner | 1.14 | 1.115 | 1.09 |

Previously a single row (speed 1.14, balanced 1.115, endurance 1.09) applied to all athletes. Research shows marathon pace = 104-114% of LT pace, with fitter athletes closer to the low end. Critical speed studies show faster marathoners sustain ~93% of critical speed vs ~79% for slower runners, indicating the LT-to-race-pace relationship is strongly fitness-dependent at marathon distance. 5K/10K/HM multipliers are stable across tiers because the efficiency gap narrows at shorter distances.

**Scientific basis**: LT pace represents ~60-minute sustainable effort. Speed-type runners are faster at short distances (lower multiplier) but slower at marathon (higher multiplier) because their anaerobic advantage fades with distance. Endurance-type runners show the inverse pattern. The crossover effect reflects metabolic specialisation. Marathon tier scaling reflects that elite runners maintain closer to LT pace over 42K due to superior fat oxidation, glycogen sparing, and pacing efficiency (Daniels tables, Humphrey 2020, critical speed literature).

**Known limitations**:
- Specific multiplier values are empirically calibrated against Daniels' tables, not derived from a single published dataset
- Tier boundaries map to `athleteTier` from CTL, which is itself an estimate
- No adjustment for course profile (hilly marathons would need higher multipliers)

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

### Week factor (saturating exponential)
```
weekFactor = 1 - exp(-weeksEffective / tau)
```
Tau ranges from 4 (beginner 5K) to 11 (elite marathon). Captures diminishing returns.

### Session factor (logistic)
```
sessionFactor = 1 / (1 + exp(-k * (sessionsPerWeek - refSessions)))
k = 1.0
```
At refSessions: factor = 0.5. Above: approaches 1.0. Below: drops toward 0.

### Experience factor
Total beginner: 0.75, beginner: 0.80, novice: 0.90, intermediate: 1.0, advanced: 1.05, competitive: 1.05, returning: 1.15, hybrid: 1.10.

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
Else: 65th percentile of last 30 nights, clamped [25200s, 28800s]
```

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

### Debt accumulation (exponential decay)
```
For each night chronologically:
  debt = debt * DEBT_DECAY + max(0, target - actual_duration)
DEBT_DECAY = exp(-ln(2) / 7) ~= 0.9057    (7-day half-life)
```

### Sleep bank (rolling 7-night)
```
bankSec = SUM(last 7 nights: actual - target)
Balanced: within +/- 900s (15 min)
```

**Scientific basis**: Sleep target uses the 65th percentile of personal history to capture individual physiological need (not population mean). Load-adjusted bonus reflects adenosine accumulation from training (Dijk/Czeisler). The 7-day half-life reflects that performance debt from chronic sleep restriction persists longer than subjective sleepiness (Banks & Dinges 2007, Belenky et al. 2003). Previously 4-day (borrowed from ATL Banister model), revised based on evidence that cognitive/performance deficits take 1-2 weeks to clear. Aligns with Oura's 14-day lookback and WHOOP's stated persistence model. Sleep score for Apple Watch users is computed locally (see above); Garmin users get the native score.

**Known limitations**:
- Quality multiplier is not applied retroactively to debt (would cause compounding errors)
- 65th percentile requires 5+ nights of data; short-history users get a generic 7h target
- Sleep stage percentages depend on wearable accuracy (Garmin/Apple may misclassify stages)
- Tier caps are expert-set, not individually calibrated

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
