# Prediction Engine Audit & Reference

This document provides a comprehensive breakdown of the marathon simulator's prediction engine. It covers the core mathematical models, terminology, and code implementations.

## 1. Core Mathematical Models

### VDOT (O2 Cost)
**Source**: `src/calculations/vdot.ts`

The VDOT calculation uses two main functions: `cv` (Calculate VDOT) and `vt` (VDOT to Time).

#### Code Implementation
```typescript
/**
 * Calculate VDOT from distance and time
 * @param meters - Distance in meters
 * @param seconds - Time in seconds
 * @returns VDOT value
 */
export function cv(meters: number, seconds: number): number {
  const tm = seconds / 60;
  const v = meters / tm;  // velocity in m/min
  const vo2 = -4.6 + 0.182258 * v + 0.000104 * v * v;
  const p = 0.8 + 0.1894393 * Math.exp(-0.012778 * tm) + 0.2989558 * Math.exp(-0.1932605 * tm);
  return Math.max(vo2 / p, 15);
}

/**
 * Calculate race time from VDOT and distance
 * Uses bisection method to solve the inverse of cv()
 */
export function vt(km: number, vdot: number): number {
  const meters = km * 1000;
  let tLow = km * 2.5 * 60;   // 2:30/km pace (fast bound)
  let tHigh = km * 15 * 60;   // 15:00/km pace (slow bound)
  // ... bisection logic ...
  return (tLow + tHigh) / 2;
}
```

### Riegel's Formula (Fatigue)
**Source**: `src/calculations/fatigue.ts`

Fatigue resistance is modeled using the exponent `b` in Riegel's equation.

#### Code Implementation
```typescript
/**
 * Calculate fatigue exponent (b) from personal bests
 * Uses linear regression on log-transformed data
 */
export function calculateFatigueExponent(pbs: PBs): number {
  // ... (log transformation logic) ...
  // Returns slope of log-log plot
  return num / den;
}

/**
 * Get runner type from fatigue exponent
 */
export function getRunnerType(b: number): RunnerType {
  if (!b || isNaN(b)) return 'Balanced';
  if (b < 1.06) return 'Speed';      // Decays fast
  if (b > 1.12) return 'Endurance';  // Holds pace well
  return 'Balanced';
}
```

#### Term Definitions
- **Fatigue Exponent (`b`)**: The slope of the runner's speed decay. Higher `b` means *less* decay (better endurance). Note: In standard Riegel, higher usually means more fatigue, but our implementation flips or adjusts this interpretation in `getRunnerType`.
  - **Speed Type**: `b < 1.06`. Great at short output, fades at Marathon.
  - **Endurance Type**: `b > 1.12`. Marathon pace is very close to 5k pace.

## 2. Prediction Logic

**Source**: `src/calculations/predictions.ts`

The blended prediction engine combines multiple signals. The weighting logic is dynamic based on target distance and data freshness.

#### Code Implementation
```typescript
export function blendPredictions(
  targetDist: number, 
  pbs: PBs, 
  ltPace: number | null, 
  vo2max: number | null, 
  b: number, 
  runnerType: string, 
  recentRun: RecentRun | null
): number | null {
  
  // 1. Define Weights
  // Example for 5k with Recent Run available:
  // recent: 0.30, pb: 0.10, lt: 0.35, vo2: 0.25
  
  // 2. Adjust for Recency Decay
  if (hasRecent) {
    const weeksAgo = recentRun.weeksAgo;
    let recencyFactor = 1.0;
    if (weeksAgo <= 2) recencyFactor = 1.0;
    else if (weeksAgo <= 6) recencyFactor = 0.65; // Decays
    // ...
    
    // Redistribute lost weight to LT (70%) and PB (30%)
    const recentReduction = w.recent * (1 - recencyFactor);
    w.recent = w.recent * recencyFactor;
    w.lt = w.lt + recentReduction * 0.7;
    w.pb = w.pb + recentReduction * 0.3;
  }
  
  // 3. Calculate Components
  const tRecent = predictFromRecent(targetDist, recentRun, pbs, b);
  const tPB = predictFromPB(targetDist, pbs, b);
  const tLT = predictFromLT(targetDist, ltPace, runnerType);
  const tVO2 = predictFromVO2(targetDist, vo2max);

  // 4. Weighted Sum
  return (w.recent*tRecent + w.pb*tPB + w.lt*tLT + w.vo2*tVO2) / totalWeight;
}
```

#### Term Definitions
- **`predictFromRecent`**: Uses Riegel to project a recent race time to the target distance.
- **`predictFromLT`**: Uses the runner's Threshold Pace and applies a multiplier based on Runner Type (e.g. Speed types get a worse multiplier for long distance).
- **`predictFromVO2`**: Pure engine score from `vdot.ts`.
- **`recencyFactor`**: How much we trust the Recent Run. 100% at 2 weeks, drops to 15% after 8 weeks.

## 3. Training Horizon (Forecasts)

**Source**: `src/calculations/training-horizon.ts`

Calculates the percentage improvement (`improvement_pct`) over a training block.

#### Code Implementation
```typescript
export function applyTrainingHorizonAdjustment(params: TrainingHorizonInput): TrainingHorizonResult {
  // 1. Get Parameters (from constants/training-params.ts)
  const max_gain = TRAINING_HORIZON_PARAMS.max_gain_pct[dist][ability];
  const tau = TRAINING_HORIZON_PARAMS.tau_weeks[dist][ability];
  
  // 2. Week Factor (Time Decay)
  // 1 - e^(-weeks / tau)
  const week_factor = (1 - Math.exp(-weeks_eff / tau));

  // 3. Session Factor (Volume)
  // Logistic curve: 1 / (1 + e^(-k * (sessions - ref)))
  const session_factor = 1 / (1 + Math.exp(-k * (sessions_per_week - ref_sessions)));

  // 4. Calculate Improvement
  let improvement_pct = max_gain * type_mod * week_factor * session_factor * exp_factor;

  // 5. Apply Guardrails (Caps)
  improvement_pct = applyGuardrails(baseline_vdot, improvement_pct, ...);

  return { vdot_gain: baseline_vdot * (improvement_pct / 100), ... };
}
```

#### Term Definitions
- **`max_gain_pct`**: The theoretical limit of improvement for a specific distance and ability (e.g., 6.0% for 5k Intermediate).
- **`tau_weeks`**: The time constant. Controls how quickly the runner approaches their max potential.
- **`percentage_improvement`**: The final output. If this is 5.0%, the runner's VDOT increases by 5%.
- **`applyGuardrails`**: A safety function that hard-caps improvement if the runner lacks the experience level (e.g., "Intermediate" cannot run sub-3 marathon without specific overrides).

## 4. Glossary for Matrix Terms

- **Runner Type**: Defined in `src/calculations/fatigue.ts`. Controlled by `b` (Fatigue Exponent).
- **LT Profile**: Refers to the `ltPace` input in `blendPredictions`.
  - **Aligned**: `ltPace` matches the standard Daniels VDOT table pace for the runner's baseline.
  - **Strong**: `ltPace` is faster (corresponds to VDOT+2).
- **Recent Perf**: Refers to the `recentRun` object in `blendPredictions`.
- **Confidence**: Mapped to the `alpha` (weighting) variable in `predictFromRecent`.
- **Forecast**: The output of `applyTrainingHorizonAdjustment`.
- **Max Theoretical**: The value `TRAINING_HORIZON_PARAMS.max_gain_pct[dist][ability]`.
