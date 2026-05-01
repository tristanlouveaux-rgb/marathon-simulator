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

## Triathlon cross-training overload detector (2026-04-30)

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

Reuses the existing `applyTrainingHorizonAdjustment` with `target_distance: 'marathon'` (IM) or `'half'` (70.3). The marathon constants in `TRAINING_HORIZON_PARAMS` are anchored to Daniels' tables and Tanda 2011 (see existing §"Tanda Marathon Predictor"). Adherence and adaptation are applied as additional multipliers on top.

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
- **Baldassarre R et al. (2017)** *Front Physiol* 8:294 — open-water vs pool review.

```
wetsuit-lake           = 1.00 (baseline)
non-wetsuit-lake       = 1.04 (+4% drag without wetsuit)
ocean                  = 1.05 (+5% chop; salinity buoyancy partially offsets)
ocean-current-assisted = 0.97 (−3%; e.g. Roth canal, favourable Kona years)
river                  = 1.00 (direction-dependent; neutral default)
```

**Limitations**: river swims and ocean conditions vary year to year. The neutral defaults are deliberately conservative.

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

**Why retained as fallback**: when the watts stream isn't yet processed (mid-backfill, rides outside the per-sync stream-fetch budget), the activity row carries `average_watts` / `normalized_power` but no `power_curve`. Rather than show "--", the new estimator falls back to the freshest real-meter ride's whole-ride NP × 1.00 within 12 weeks, tagged `confidence: 'low'`.

---

## FTP from Mean-Max Power Curve — Top-1 within 12 Weeks (2026-04-28)

**Context**: Whole-ride NP averages over the entire activity, so any 20-min FTP test embedded inside a longer ride is invisible to the previous estimator. The fix is to read the *mean-max power curve* — best sustained watts over fixed time windows — directly from the watts stream, then apply Coggan's window-specific multipliers to whichever window gave the strongest signal.

**Pipeline**:

1. **Stream fetch** (edge function `sync-strava-activities` step 5e): per sync, rank cycling rides by `weighted_average_watts` DESC, filter to `device_watts=true` within the last 26 weeks, take top 15. For each, fetch `/activities/{id}/streams?keys=watts,time` and run a sliding-window mean-max for windows `[600, 1200, 1800, 3600]` seconds. Store as `garmin_activities.power_curve = { p600, p1200, p1800, p3600 }`. Budget: 15 streams/sync. The "highest whole-ride NP" pre-rank is the cheapest proxy for "ride contains a hard interval" — a 90-min Z2 ride at NP 180 W cannot hide a 310 W effort.
2. **Per-ride candidate** (`estimateFTPFromBikeActivities`): for each ride with a `powerCurve`, compute
   ```
   candidate = max(p600 × 0.92, p1200 × 0.95, p1800 × 0.97, p3600 × 1.00)
   ```
   Whichever window produced the strongest signal wins for that ride. Real-meter only — `deviceWatts !== true` rides are excluded from the curve path entirely.
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
