# Triathlon Prediction Calibration

How the triathlon predictor is calibrated against real-world race-finish data.

## What's calibrated

Three things, all derived from public Kaggle datasets:

1. **Per-location course factors** — replaces hand-tuned `CourseProfile` multipliers (climate, altitude, elevation, wind, swim type) with measured leg-pace ratios per race location, when high-quality empirical data exists.

2. **Split-distribution sanity bounds** — for each total finish-time bin, the empirical mean and standard deviation of swim/bike/run leg fractions. Used to detect predictions whose leg proportions fall outside the realistic distribution.

3. **Per-race transition averages** — for each race × level bin, the average T1 / T2 / T1+T2 of finishers in that bin. Replaces the hand-tuned `T1_SEC_BY_SLIDER` / `T2_SEC_BY_SLIDER` defaults at race-prediction time. 70.3 carries separable T1 and T2 columns; IM carries combined T1+T2 only (derived as `overall − swim − bike − run`). Bin key is `swim + bike + run`, not finish time, so the bin is independent of transition skill itself.

## What's NOT calibrated

- The athlete's *finish time* itself. Public data is finish-time-only — there's no linked training history. Predictions still come from physiology-based models (FTP, CSS, VDOT, blended fitness) calibrated against published literature.
- The bike-to-run pace discount (5 to 11 percent). To calibrate this we'd need matched (open marathon time, IM marathon split) pairs per athlete, which the public datasets don't provide.
- The race-readiness penalty curve. Same constraint — needs linked training-volume to outcome data.

## Datasets

| Dataset | Source | Records | Years | Schema |
|---|---|---|---|---|
| 70.3 | [Kaggle aiaiaidavid](https://www.kaggle.com/datasets/aiaiaidavid/ironman-703-race-data-between-2004-and-2020) | 840k finishes | 2004 to 2020 | Single CSV, times in seconds |
| IM 140.6 | [Kaggle miguswong](https://www.kaggle.com/datasets/miguswong/ironman-140-6-results-dataset-2002-2024) | 1.09M finishes (850k after PRO + finisher filters) | 2002 to 2024 | Three relational CSVs (races, results, series) |
| **Total** | | **~1.93M raw, 1.33M effective** | 2002 to 2024 | |

"Effective" = after filtering pros, DNFs, and athletes with too few races for the IM athlete-fixed-effects estimator.

## Method

### Course factors (Tier B)

For each race location, compute multiplicative factors `(swim, bike, run)` where 1.0 means "average pace," > 1.0 means "slower than typical" (hard course), < 1.0 means "faster than typical." Two estimators:

**IM (athlete fixed effects).** The IM dataset has `athleteID`. For each athlete who raced multiple times, compute their pace at each location relative to their own multi-race average. Then average those relative paces across all athletes who raced at a given location.

```
factor(L) = mean over athletes_at_L of (athlete's pace at L / athlete's multi-race average pace)
```

This removes field-talent bias — Kona and Worlds in St George don't get tagged "easy" just because pros race there.

**70.3 (age-group × gender stratification).** No `athleteID` available, so we stratify by `(gender, ageGroup)`:

```
For each bucket b (e.g., 40-44 M):
  globalMean_b   = mean leg time across all 70.3 finishers in b
  locationMean_b = mean leg time at L for finishers in b
  ratio_b        = locationMean_b / globalMean_b

factor(L) = mean of ratio_b across buckets with ≥ 10 finishers at L
```

Less precise than fixed effects but still talent-controlled.

### Confidence tiers

| n (finishers) | Confidence |
|---|---|
| ≥ 1000 | high |
| 200 to 999 | medium |
| 50 to 199 | low |
| < 50 | insufficient (dropped) |

The runtime predictor uses empirical factors when confidence is high or medium, and falls back to the physical-model factors (climate / altitude / elevation / wind / swim type) for low or missing entries. New races without empirical data still work via the physical model.

### Sanity caps

Factors below 0.75 or above 1.40 are clamped, with the underlying race flagged. These outliers are usually data errors (course shortened, weather cancellation, swim shortened to non-wetsuit) rather than real course difficulty.

### Distribution table (Tier A)

For each distance, total finishes are binned (15-min bins for 70.3, 30-min for IM). Per bin: mean and SD of swim, bike, run fractions of total time. The runtime validator can flag any prediction whose leg fraction is more than 2 SD outside the empirical distribution for its predicted total time.

## Sample findings

**Top 5 hardest IM bike legs** (highest bikeFactor):
1. Ironman World Championship St George — bike 1.089
2. Ironman St George — bike 1.082
3. Ironman Lanzarote — bike 1.082
4. Ironman Lake Tahoe — bike 1.077
5. Ironman Alaska — bike 1.061

**Top 5 hardest 70.3 bike legs**:
1. IRONMAN 70.3 Connecticut — bike 1.244
2. IRONMAN 70.3 Dun Laoghaire — bike 1.209
3. IRONMAN 70.3 UK — bike 1.196
4. IRONMAN 70.3 Edinburgh — bike 1.172
5. IRONMAN 70.3 Silverman — bike 1.148

**Top 5 hardest 70.3 run legs** (heat / humidity / altitude):
1. IRONMAN 70.3 Subic Bay — run 1.258
2. IRONMAN 70.3 Goa — run 1.226
3. IRONMAN 70.3 Davao Philippines — run 1.223
4. IRONMAN 70.3 Saipan — run 1.210
5. IRONMAN 70.3 Connecticut — run 1.208

These match coach-community consensus about hard courses, derived purely from finishers' splits with no human input.

## Limitations

- **No outcome calibration of the level.** The level (whether a 5:40 prediction for athlete X is correct) is set by physiology models. Calibration only validates the *split proportions* and per-race difficulty.
- **Per-band targets and readiness penalty constants** (sigmoid k, max penalty, closure weeks) are still picked by feel and literature rather than fit to outcome data. Tightening these requires linked training-history → finish-time data, which public sources don't provide.
- **Fields drift over time.** A race that became "harder" after a course change shows the average across all years. We currently don't weight by recency.
- **Year-on-year weather variation** is averaged out. A typically-cool race that was 35°C in 2018 contributes that one bad year's slowness to the lifetime mean.

## Regenerating the calibration

```
NODE_OPTIONS='--max-old-space-size=4096' npx tsx src/validation/run-calibration.ts
```

Reads `validation/data/*.csv` (gitignored — re-download from Kaggle), writes:

- `src/constants/empirical-course-factors.json`
- `src/constants/empirical-split-distributions.json`
- `src/constants/empirical-transition-distributions.json`

Both JSON files are checked in. Production runtime never reads the raw CSVs.

## File map

- `src/validation/dataset-loader.ts` — streaming CSV parser, schema-agnostic loader
- `src/validation/distribution.ts` — Tier A distribution computation + validator
- `src/validation/course-factors.ts` — Tier B course-factor estimators (IM fixed effects, 70.3 stratified)
- `src/validation/transition-distributions.ts` — per-(race, level bin) transition averages
- `src/validation/run-calibration.ts` — main runner, emits the JSON outputs
- `src/calculations/empirical-course-factors.ts` — runtime lookup helper (course factors)
- `src/calculations/empirical-transitions.ts` — runtime lookup helper (transitions)
- `src/calculations/race-prediction.triathlon.ts` — integration site (line ~530 for course factors, ~645 for transitions)

## Sources

- [Kaggle: Ironman 70.3 races 2004 to 2020](https://www.kaggle.com/datasets/aiaiaidavid/ironman-703-race-data-between-2004-and-2020) — David at aiaiaidavid
- [Kaggle: Ironman 140.6 Results 2002 to 2024](https://www.kaggle.com/datasets/miguswong/ironman-140-6-results-dataset-2002-2024) — miguswong
- [CoachCox IM Stats](https://www.coachcox.co.uk/imstats/) — Russ Cox, original scrape source for both datasets
- Bassett DR, Howley ET (2000). Limiting factors for maximum oxygen uptake. *Med Sci Sports Exerc*.
- Coyle EF (1984). Substrate utilization during exercise. *Am J Clin Nutr*.
- Friel J (2018). *The Triathlete's Training Bible* 4th ed.
