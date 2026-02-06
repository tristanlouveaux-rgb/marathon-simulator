# Forecast Matrix Audit Documentation

## Overview

This document explains the exact origin of each number in the forecast matrix audit system. It distinguishes between **synthetic inputs** (values we construct for testing) and **engine outputs** (values computed by the production prediction engine).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         SYNTHETIC INPUTS (Test Data)                      │
├──────────────────────────────────────────────────────────────────────────┤
│  baseVdot (45)  →  anchor 5k time  →  PBs via Riegel  →  bEstimated     │
│  bTarget (1.03/1.09/1.15)                                                │
│  ltVdotDiff (-2/0/+2)  →  LT pace (60-min race pace)                     │
│  vo2VdotDiff (0)  →  VO2max (treated as VDOT)                            │
│  recentRun config  →  recent run time via tv()                           │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         ENGINE FUNCTIONS (Production)                     │
├──────────────────────────────────────────────────────────────────────────┤
│  calculateFatigueExponent(pbs)  →  bEstimated                            │
│  getRunnerType(b)  →  runnerType                                         │
│  blendPredictions(...)  →  blendedPredictionSec                          │
│  cv(targetDist, blendedTime)  →  startVdot                               │
│  applyTrainingHorizonAdjustment(...)  →  vdot_gain, improvement_pct      │
│  tv(forecastVdot, targetDist)  →  forecastTime                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## File Locations

| Component | File | Function(s) |
|-----------|------|-------------|
| VDOT calculations | `src/calculations/vdot.ts` | `cv()`, `tv()`, `rd()` |
| Fatigue exponent | `src/calculations/fatigue.ts` | `calculateFatigueExponent()`, `getRunnerType()` |
| Prediction blending | `src/calculations/predictions.ts` | `blendPredictions()`, `predictFromPB()`, `predictFromLT()`, `predictFromVO2()`, `predictFromRecent()` |
| Training horizon | `src/calculations/training-horizon.ts` | `applyTrainingHorizonAdjustment()` |
| Training parameters | `src/constants/training-params.ts` | `TRAINING_HORIZON_PARAMS`, `TAPER_NOMINAL` |
| Synthetic athlete | `src/testing/synthetic-athlete.ts` | `createSyntheticAthlete()`, `computeLtPaceFromVdot60min()` |
| Forecast matrix | `src/testing/forecast-matrix.ts` | `runForecastMatrix()`, `runScenario()` |
| Semantic tests | `src/testing/runner-type-semantics.test.ts` | Test suite |

## Derivation Chain (Step by Step)

### Step 1: Anchor Time from VDOT

**Input:** `baseVdot` (e.g., 45)

**Function:** `tv(baseVdot, 5)` from `vdot.ts`

**Output:** Anchor 5k time in seconds

**Code path:**
```typescript
// vdot.ts:57
export function tv(vdot: number, km: number): number {
  return vt(km, vdot);  // Bisection search
}
```

**Example:** `tv(45, 5) = 1242.5s` (20:42)

### Step 2: PB Generation via Riegel Power Law

**Input:** Anchor time, anchor distance, `bTarget`

**Formula:** `T(d) = T_anchor * (d / d_anchor)^b`

**Output:** PBs for 5k, 10k, half, marathon

**Code path:**
```typescript
// synthetic-athlete.ts:generatePbsFromAnchor()
pbs.k5 = anchorTimeSec * Math.pow(5000 / anchorDistanceMeters, bTarget);
pbs.k10 = anchorTimeSec * Math.pow(10000 / anchorDistanceMeters, bTarget);
pbs.h = anchorTimeSec * Math.pow(21097 / anchorDistanceMeters, bTarget);
pbs.m = anchorTimeSec * Math.pow(42195 / anchorDistanceMeters, bTarget);
```

### Step 3: Fatigue Exponent Estimation

**Input:** PBs

**Function:** `calculateFatigueExponent(pbs)` from `fatigue.ts`

**Method:** Linear regression on `ln(distance)` vs `ln(time)`

**Output:** `bEstimated`

**Code path:**
```typescript
// fatigue.ts:9-31
// Uses least squares regression: b = Σ((lnD - mean)(lnT - mean)) / Σ((lnD - mean)²)
```

**Coherence check:** `|bEstimated - bTarget| < 0.01`

### Step 4: Runner Type Classification

**Input:** `bEstimated`

**Function:** `getRunnerType(b)` from `fatigue.ts`

**Output:** `'Speed'`, `'Balanced'`, or `'Endurance'`

**Code path:**
```typescript
// fatigue.ts:47-52
export function getRunnerType(b: number): RunnerType {
  if (!b || isNaN(b)) return 'Balanced';
  if (b < 1.06) return 'Speed';     // ⚠️ INVERTED
  if (b > 1.12) return 'Endurance'; // ⚠️ INVERTED
  return 'Balanced';
}
```

**⚠️ SEMANTIC INVERSION:** See [Runner Type Semantics Issue](#runner-type-semantics-issue) below.

### Step 5: LT Pace Calculation

**Input:** `baseVdot + ltVdotDiff`

**Method:** Find distance where `tv(distance, ltVdot) ≈ 3600s` (60 minutes)

**Output:** `ltPaceSecPerKm = 3600 / distanceKm`

**Code path:**
```typescript
// synthetic-athlete.ts:computeLtPaceFromVdot60min()
// Binary search for distance where race time = 60 minutes
```

**Definition:** This matches Daniels' threshold pace definition - the pace sustainable for ~60 minutes.

### Step 6: Prediction Blending

**Inputs:** PBs, LT pace, VO2max, b, runnerType, recentRun

**Function:** `blendPredictions()` from `predictions.ts`

**Method:**
1. Calculate individual predictions from each source
2. Apply distance-specific weights
3. Apply recency decay for recent run
4. Weighted average

**Output:** Blended predicted time in seconds

**Code path:**
```typescript
// predictions.ts:250-322
// Weight tables for 5k:
// With recent: { recent: 0.30, pb: 0.10, lt: 0.35, vo2: 0.25 }
// Without:    { pb: 0.20, lt: 0.40, vo2: 0.40 }
```

### Step 7: Start VDOT from Blended Time

**Input:** Blended prediction time, target distance

**Function:** `cv(targetDistMeters, blendedTimeSec)` from `vdot.ts`

**Output:** `startVdot`

**Code path:**
```typescript
// vdot.ts:12-18
export function cv(meters: number, seconds: number): number {
  const tm = seconds / 60;
  const v = meters / tm;
  const vo2 = -4.6 + 0.182258 * v + 0.000104 * v * v;
  const p = 0.8 + 0.1894393 * Math.exp(-0.012778 * tm) + 0.2989558 * Math.exp(-0.1932605 * tm);
  return Math.max(vo2 / p, 15);
}
```

### Step 8: Training Horizon Forecast

**Inputs:** startVdot, targetDistance, weeksRemaining, sessionsPerWeek, runnerType, abilityBand, etc.

**Function:** `applyTrainingHorizonAdjustment()` from `training-horizon.ts`

**Method:**
1. Look up parameters from `TRAINING_HORIZON_PARAMS`
2. Calculate `week_factor = 1 - exp(-weeks_eff / tau)`
3. Calculate `session_factor = 1 / (1 + exp(-k * (sessions - ref)))`
4. Apply `type_modifier` based on runner type
5. Apply experience factor
6. Calculate `improvement_pct`
7. Apply guardrails
8. Convert to `vdot_gain = baseline_vdot * (improvement_pct / 100)`

**Output:** `vdot_gain`, `improvement_pct`, components breakdown

**Code path:**
```typescript
// training-horizon.ts:10-108
```

### Step 9: Forecast Time

**Input:** `forecastVdot = startVdot + vdot_gain`

**Function:** `tv(forecastVdot, targetDistKm)` from `vdot.ts`

**Output:** Predicted race time after training

---

## Runner Type Semantics Issue

### The Problem

The current `getRunnerType()` function labels are **inverted** relative to the intended user-facing semantics.

### Mathematical Definition

The **fatigue exponent** `b` (Riegel exponent) represents how much time increases as distance increases:

```
T(d) = T_anchor * (d / d_anchor)^b
```

- **Higher b** = time increases MORE as distance increases = MORE "fade" = relatively WORSE at long distances
- **Lower b** = time increases LESS as distance increases = LESS "fade" = relatively BETTER at long distances

### User Requirement

> "Speed" = relatively better at SHORT distances
> "Endurance" = relatively better at LONG distances

Therefore:
- **High b → "Speed"** (more fade = worse at long = better at short)
- **Low b → "Endurance"** (less fade = better at long)

### Current Engine Behavior

```typescript
// fatigue.ts:47-52
if (b < 1.06) return 'Speed';     // ← WRONG: low b should be Endurance
if (b > 1.12) return 'Endurance'; // ← WRONG: high b should be Speed
```

### Impact

This inversion affects the `type_modifier` bonus in `applyTrainingHorizonAdjustment()`:

```typescript
// training-params.ts:30-35
type_modifier: {
  '5k': { Speed: 0.90, Balanced: 1.00, Endurance: 1.15 },
  'marathon': { Speed: 1.15, Balanced: 1.00, Endurance: 0.90 }
}
```

The intent is "train your weakness":
- Speed types get bonus for marathon training
- Endurance types get bonus for 5k training

But with inverted labels:
- A low-fade athlete (true Endurance, labeled "Speed") training for marathon gets a 1.15x bonus when they should get 0.90x
- A high-fade athlete (true Speed, labeled "Endurance") training for 5k gets a 1.15x bonus when they should get 0.90x

### Recommended Fix

**Option 1: Swap labels in `getRunnerType()` (Recommended)**

```typescript
export function getRunnerType(b: number): RunnerType {
  if (!b || isNaN(b)) return 'Balanced';
  if (b < 1.06) return 'Endurance';  // Low fade = better at long
  if (b > 1.12) return 'Speed';      // High fade = better at short
  return 'Balanced';
}
```

No changes needed to `type_modifier` table since it already has correct semantic intent.

---

## Synthetic vs Engine Outputs

### Synthetic Inputs (We Control)

| Value | Source | Purpose |
|-------|--------|---------|
| `baseVdot` | Config | Anchor fitness level |
| `bTarget` | Config | Controls runner type |
| `ltVdotDiff` | Config | LT pace offset from base |
| `vo2VdotDiff` | Config | VO2 offset from base |
| `recentRun.vdotDiff` | Config | Recent performance offset |
| `recentRun.weeksAgo` | Config | Recency of recent run |

### Engine Outputs (Production Code)

| Value | Function | File |
|-------|----------|------|
| `bEstimated` | `calculateFatigueExponent()` | fatigue.ts |
| `runnerType` | `getRunnerType()` | fatigue.ts |
| `blendedPredictionSec` | `blendPredictions()` | predictions.ts |
| `startVdot` | `cv()` | vdot.ts |
| `vdot_gain` | `applyTrainingHorizonAdjustment()` | training-horizon.ts |
| `improvement_pct` | `applyTrainingHorizonAdjustment()` | training-horizon.ts |
| `forecastTime` | `tv()` | vdot.ts |

---

## Running the Audit

### Via npm test

```bash
npm test -- --run src/testing/runner-type-semantics.test.ts
```

### Via script (to be added)

```bash
npx tsx src/testing/run-forecast-matrix.ts
```

### Expected Output

The matrix runner outputs:
1. A formatted text table showing all scenarios
2. Detailed breakdown for first 3 scenarios
3. Derivation chain documentation
4. JSON blob for programmatic analysis

---

## Coherence Checks

The audit verifies:

1. **b estimation accuracy:** `|bEstimated - bTarget| < 0.01`
2. **VDOT coherence:** VDOT implied by 5k PB matches baseVdot within 0.5
3. **Runner type semantics:** Documents the semantic inversion (intentionally fails)
4. **Fade analysis:** Verifies fade ratio matches expected Riegel exponent

---

## Changelog

- **2024-02-05:** Initial audit system created
  - Added `src/testing/synthetic-athlete.ts`
  - Added `src/testing/forecast-matrix.ts`
  - Added `src/testing/runner-type-semantics.test.ts`
  - Documented runner type semantic inversion issue
  - Recommended fix: swap labels in `getRunnerType()`
