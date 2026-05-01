/**
 * universalLoad.ts
 * ================
 * Computes a universal load currency for any logged activity.
 *
 * Three tiers:
 * - TIER A (Garmin): Use aerobic_load + anaerobic_load directly
 * - TIER B (HR-only): Compute TRIMP-like load from time-in-zone
 * - TIER C (RPE-only): Estimate from duration * RPE * sport factors
 *
 * Outputs:
 * - fatigueCostLoad (FCL): drives reductions/downgrades (NOT saturated)
 * - runReplacementCredit (RRC): drives replacements (saturated + goal-adjusted)
 */

import type { RaceDistance, SportKey } from '@/types';
import type {
  ActivityInput,
  UniversalLoadResult,
  DataTier,
  ZonesConfig,
  HRZoneData,
} from './universal-load-types';
import { SPORTS_DB } from '@/constants';
import { normalizeSport } from './activities';
import {
  TAU,
  CREDIT_MAX,
  TIER_A_CONFIDENCE,
  TIER_B_CONFIDENCE_FULL,
  TIER_B_CONFIDENCE_PARTIAL,
  TIER_C_CONFIDENCE_HIGH_RPE,
  TIER_C_CONFIDENCE_MID_RPE,
  RPE_UNCERTAINTY_PENALTY,
  LOAD_PER_MIN_BY_RPE,
  RPE_AEROBIC_SPLIT,
  HR_ZONE_WEIGHTS,
  EASY_LOAD_PER_KM,
  MAX_EQUIVALENT_EASY_KM,
  getActiveFraction,
  computeGoalFactor,
} from './universal-load-constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function defaultRpe(rpe: number | undefined | null): number {
  return rpe == null ? 5 : clamp(Math.round(rpe), 1, 10);
}

/**
 * Saturation curve: caps how much "credit" a single session can provide.
 * credit = CREDIT_MAX * (1 - exp(-rawRRC / TAU))
 */
function saturateCredit(rawRRC: number): number {
  return CREDIT_MAX * (1.0 - Math.exp(-rawRRC / TAU));
}

/**
 * Get sport configuration with safe defaults.
 */
function getSportConfig(sportKey: SportKey | string) {
  const config = SPORTS_DB[sportKey as SportKey];
  if (config) {
    return {
      mult: config.mult,
      runSpec: config.runSpec,
      recoveryMult: config.recoveryMult ?? 1.0,
      noReplace: config.noReplace,
      extendedModel: config.extendedModel,
      impactPerMin: config.impactPerMin ?? 0,
    };
  }
  // Unknown sport: use conservative defaults
  return {
    mult: 1.0,
    runSpec: 0.35,
    recoveryMult: 1.0,
    noReplace: [] as string[],
    extendedModel: undefined,
    impactPerMin: 0,
  };
}

// ---------------------------------------------------------------------------
// TIER A+: iTRIMP (Individual TRIMP from HR stream — highest accuracy)
// ---------------------------------------------------------------------------

/**
 * Convert iTRIMP value to aerobic/anaerobic split using sport profile.
 *
 * iTRIMP from `src/calculations/trimp.ts` is seconds-weighted Banister TRIMP
 * (Σ Δt_sec × HRR × e^(β·HRR)) so a 1-hour session lands at iTRIMP ≈ 5000–10000.
 * Every other consumer in the codebase converts this to TSS-equivalent units
 * via `iTrimp × 100 / 15000` (1 hour at threshold ≈ 15000 iTRIMP ≈ 100 TSS).
 * We do the same here BEFORE applying sport multiplier — without it, baseLoad
 * is ~150× too large, blowing up FCL/RRC, slamming `equivalentEasyKm` into its
 * 25 km cap, and falsely flagging any HR-tracked cross-training session as
 * "Very heavy training load". See `tri-benchmarks-from-history.ts` for the
 * same normalisation rule (and a prior incident comment).
 */
function computeTierAPlus(
  iTrimp: number,
  sportMult: number,
  runSpec: number,
  explanations: string[]
): { aerobic: number; anaerobic: number; confidence: number } {
  const tssEquivalent = (iTrimp * 100) / 15000;
  const baseLoad = tssEquivalent * sportMult;

  // Split aerobic/anaerobic: use a fixed 85/15 split as iTRIMP doesn't
  // distinguish zones — it is purely a cardiovascular load signal.
  const aerobicFrac = 0.85;
  const aerobic = baseLoad * aerobicFrac;
  const anaerobic = baseLoad * (1 - aerobicFrac);

  void runSpec; // Available for future use in RRC override

  explanations.push(`iTRIMP-based load (second-by-second HR stream, highest accuracy). Base load: ${baseLoad.toFixed(1)}.`);

  return { aerobic, anaerobic, confidence: 0.95 };
}

// ---------------------------------------------------------------------------
// TIER A: Garmin/Firstbeat Data
// ---------------------------------------------------------------------------

function computeTierA(
  garminAerobic: number,
  garminAnaerobic: number,
  explanations: string[]
): { aerobic: number; anaerobic: number; confidence: number } {
  explanations.push('Using Garmin/Firstbeat load data (high accuracy).');
  return {
    aerobic: garminAerobic,
    anaerobic: garminAnaerobic,
    confidence: TIER_A_CONFIDENCE,
  };
}

// ---------------------------------------------------------------------------
// TIER B: HR-only (Time-in-Zone)
// ---------------------------------------------------------------------------

function computeTierB(
  input: ActivityInput,
  zonesConfig: ZonesConfig | undefined,
  explanations: string[]
): { aerobic: number; anaerobic: number; confidence: number } | null {
  const zones = input.hrZones;
  if (!zones) return null;

  // Check if we have meaningful zone data
  const totalZoneTime =
    zones.zone1Minutes +
    zones.zone2Minutes +
    zones.zone3Minutes +
    zones.zone4Minutes +
    zones.zone5Minutes;

  if (totalZoneTime < 5) return null; // Not enough data

  // TRIMP-like calculation with zone weights [1,2,3,4,5]
  const [w1, w2, w3, w4, w5] = HR_ZONE_WEIGHTS;

  // Aerobic: Z1-Z3 contribute to aerobic capacity
  const aerobicLoad =
    zones.zone1Minutes * w1 +
    zones.zone2Minutes * w2 +
    zones.zone3Minutes * w3;

  // Anaerobic: Z4-Z5 contribute to anaerobic capacity
  const anaerobicLoad = zones.zone4Minutes * w4 + zones.zone5Minutes * w5;

  // Determine confidence based on data completeness
  const coverageRatio = totalZoneTime / input.durationMin;
  const confidence =
    coverageRatio >= 0.9 ? TIER_B_CONFIDENCE_FULL : TIER_B_CONFIDENCE_PARTIAL;

  explanations.push(
    `Computed from HR zones: ${Math.round(totalZoneTime)}min tracked ` +
      `(${Math.round(coverageRatio * 100)}% coverage).`
  );

  if (zones.zone4Minutes + zones.zone5Minutes > 30) {
    explanations.push(
      `High-intensity: ${Math.round(zones.zone4Minutes + zones.zone5Minutes)}min in Z4-Z5.`
    );
  }

  return { aerobic: aerobicLoad, anaerobic: anaerobicLoad, confidence };
}

// ---------------------------------------------------------------------------
// TIER C: RPE-only Estimation
// ---------------------------------------------------------------------------

function computeTierC(
  input: ActivityInput,
  sportKey: SportKey,
  sportMult: number,
  explanations: string[]
): { aerobic: number; anaerobic: number; confidence: number } {
  const rpe = defaultRpe(input.rpe);
  const durationMin = input.durationMin;

  // Step 1: Base load from RPE table
  const lpm = LOAD_PER_MIN_BY_RPE[rpe] ?? 2.0;
  let rawLoad = durationMin * lpm;

  // Step 2: Apply sport multiplier
  rawLoad *= sportMult;

  // Step 3: Apply active fraction (intermittent sports discount)
  const activeFraction = getActiveFraction(sportKey);
  rawLoad *= activeFraction;

  // Step 4: Apply RPE-only uncertainty penalty
  rawLoad *= RPE_UNCERTAINTY_PENALTY;

  // Step 5: Split aerobic/anaerobic based on RPE bands
  const aerobicPct = RPE_AEROBIC_SPLIT[rpe] ?? 0.85;
  const aerobicLoad = rawLoad * aerobicPct;
  const anaerobicLoad = rawLoad * (1 - aerobicPct);

  // Confidence varies by RPE (mid-range is most reliable)
  const confidence =
    rpe >= 5 && rpe <= 7 ? TIER_C_CONFIDENCE_MID_RPE : TIER_C_CONFIDENCE_HIGH_RPE;

  // Build explanation
  const sportLabel = sportKey.replace(/_/g, ' ');
  explanations.push(
    `Estimated from ${durationMin}min ${sportLabel} at RPE ${rpe}.`
  );
  if (activeFraction < 0.8) {
    explanations.push(
      `Adjusted for intermittent nature (${Math.round(activeFraction * 100)}% active time).`
    );
  }
  explanations.push(
    'RPE-only estimate; for more accuracy, use a heart rate monitor.'
  );

  return { aerobic: aerobicLoad, anaerobic: anaerobicLoad, confidence };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Compute universal load from any activity input.
 *
 * @param input - The logged activity data
 * @param goalDistance - The runner's goal race distance
 * @param zonesConfig - Optional HR zone configuration
 * @returns UniversalLoadResult with FCL, RRC, confidence, and explanations
 */
export function computeUniversalLoad(
  input: ActivityInput,
  goalDistance: RaceDistance = 'half',
  zonesConfig?: ZonesConfig
): UniversalLoadResult {
  const explanations: string[] = [];

  // Normalize sport and get config
  const sportKey = normalizeSport(input.sport) as SportKey;
  const config = getSportConfig(sportKey);

  // Determine which tier to use (highest quality first)
  let aerobicLoad: number;
  let anaerobicLoad: number;
  let confidence: number;
  let tier: DataTier;

  // TIER A+: iTRIMP available (second-by-second HR stream — highest accuracy)
  if (input.iTrimp != null && input.iTrimp > 0) {
    const tierAPlus = computeTierAPlus(
      input.iTrimp,
      config.mult,
      config.runSpec,
      explanations
    );
    aerobicLoad = tierAPlus.aerobic;
    anaerobicLoad = tierAPlus.anaerobic;
    confidence = tierAPlus.confidence;
    tier = 'itrimp';
  }
  // TIER A: Garmin data available?
  else if (
    input.fromGarmin &&
    input.garminAerobicLoad != null &&
    input.garminAnaerobicLoad != null &&
    (input.garminAerobicLoad > 0 || input.garminAnaerobicLoad > 0)
  ) {
    const tierA = computeTierA(
      input.garminAerobicLoad,
      input.garminAnaerobicLoad,
      explanations
    );
    aerobicLoad = tierA.aerobic;
    anaerobicLoad = tierA.anaerobic;
    confidence = tierA.confidence;
    tier = 'garmin';
  }
  // TIER B: HR zone data available?
  else {
    const tierB = computeTierB(input, zonesConfig, explanations);
    if (tierB) {
      aerobicLoad = tierB.aerobic;
      anaerobicLoad = tierB.anaerobic;
      confidence = tierB.confidence;
      tier = 'hr';
    }
    // TIER C: RPE-only fallback
    else {
      const tierC = computeTierC(input, sportKey, config.mult, explanations);
      aerobicLoad = tierC.aerobic;
      anaerobicLoad = tierC.anaerobic;
      confidence = tierC.confidence;
      tier = 'rpe';
    }
  }

  // Base load is sum of aerobic + anaerobic
  const baseLoad = aerobicLoad + anaerobicLoad;

  // ---------------------------------------------------------------------------
  // FATIGUE COST LOAD (FCL)
  // ---------------------------------------------------------------------------
  // FCL = baseLoad * recoveryMult
  // NOT saturated - fatigue should remain "real" to drive reductions/downgrades
  const fatigueCostLoad = baseLoad * config.recoveryMult;

  // ---------------------------------------------------------------------------
  // RUN REPLACEMENT CREDIT (RRC)
  // ---------------------------------------------------------------------------
  // RRC_raw = baseLoad * runSpec
  let rrcRaw = baseLoad * config.runSpec;

  // Apply goal-distance adjustment (spec: marathon/hm favor aerobic, 5k/10k allow anaerobic)
  const anaerobicRatio = baseLoad > 1e-9 ? anaerobicLoad / baseLoad : 0;
  const goalFactor = computeGoalFactor(anaerobicRatio, goalDistance);
  rrcRaw *= goalFactor;

  // Apply saturation curve (prevents massive sessions from linearly deleting the week)
  const runReplacementCredit = saturateCredit(rrcRaw);

  // ---------------------------------------------------------------------------
  // IMPACT LOAD (musculoskeletal / leg stress)
  // ---------------------------------------------------------------------------
  // Simple linear model: durationMin × sport's impact-per-minute factor.
  // Running impact is km-based and handled separately by calculateWorkoutLoad().
  const impactLoad = input.durationMin * config.impactPerMin;

  // ---------------------------------------------------------------------------
  // Extended model (future: decoupled fitness/fatigue scoring)
  // ---------------------------------------------------------------------------
  // When extendedModel is present, read its fields for downstream consumers.
  // Legacy FCL/RRC formulas remain the sole scoring path for now.
  if (config.extendedModel) {
    const { aerobicTransfer, anaerobicTransfer, impactLoading } = config.extendedModel;
    // TODO: wire into decoupled scoring when ready
    void aerobicTransfer;
    void anaerobicTransfer;
    void impactLoading;
  }

  // ---------------------------------------------------------------------------
  // Equivalence for UI messaging
  // ---------------------------------------------------------------------------
  const equivalentEasyKm = Math.min(
    MAX_EQUIVALENT_EASY_KM,
    Math.round((runReplacementCredit / EASY_LOAD_PER_KM) * 10) / 10
  );

  if (goalFactor < 1.0) {
    explanations.push(
      `Adjusted for ${goalDistance} goal: lower credit for anaerobic-heavy session.`
    );
  } else if (goalFactor > 1.0) {
    explanations.push(
      `Bonus for ${goalDistance} goal: higher credit for anaerobic-heavy session.`
    );
  }

  return {
    aerobicLoad: Math.round(aerobicLoad * 10) / 10,
    anaerobicLoad: Math.round(anaerobicLoad * 10) / 10,
    baseLoad: Math.round(baseLoad * 10) / 10,
    fatigueCostLoad: Math.round(fatigueCostLoad * 10) / 10,
    runReplacementCredit: Math.round(runReplacementCredit * 10) / 10,
    impactLoad: Math.round(impactLoad * 10) / 10,
    tier,
    confidence: Math.round(confidence * 100) / 100,
    sportKey,
    sportMult: config.mult,
    recoveryMult: config.recoveryMult,
    runSpec: config.runSpec,
    explanations,
    equivalentEasyKm,
  };
}

// ---------------------------------------------------------------------------
// Extreme Session Detection
// ---------------------------------------------------------------------------

import {
  EXTREME_WEEK_PCT,
  EXTREME_HR_ZONE2_PLUS_MIN,
  EXTREME_RPE_DURATION_MIN,
  EXTREME_RPE_LEVEL,
} from './universal-load-constants';

/**
 * Determine if an activity qualifies as an "extreme session".
 * Extreme sessions can trigger up to 3 modifications instead of 2.
 *
 * Triggers:
 * - FCL >= 0.55 * plannedWeeklyRunLoad
 * - HR-only: time in Z2+ >= 150 minutes
 * - RPE-only: duration >= 120 AND rpe >= 7
 */
export function isExtremeSession(
  loadResult: UniversalLoadResult,
  input: ActivityInput,
  plannedWeeklyRunLoad: number
): boolean {
  // Condition 1: FCL >= 0.55 * weekly load
  if (
    plannedWeeklyRunLoad > 0 &&
    loadResult.fatigueCostLoad >= EXTREME_WEEK_PCT * plannedWeeklyRunLoad
  ) {
    return true;
  }

  // Condition 2: HR-only with lots of Z2+ time
  if (loadResult.tier === 'hr' && input.hrZones) {
    const z2PlusTime =
      input.hrZones.zone2Minutes +
      input.hrZones.zone3Minutes +
      input.hrZones.zone4Minutes +
      input.hrZones.zone5Minutes;
    if (z2PlusTime >= EXTREME_HR_ZONE2_PLUS_MIN) {
      return true;
    }
  }

  // Condition 3: RPE-only with long duration + high intensity
  if (loadResult.tier === 'rpe') {
    const rpe = defaultRpe(input.rpe);
    if (input.durationMin >= EXTREME_RPE_DURATION_MIN && rpe >= EXTREME_RPE_LEVEL) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Workout Type Classification (Phase B v3)
// ---------------------------------------------------------------------------

/** Intensity thresholds for iTRIMP-based classification (can be personalised per athlete) */
export interface IntensityThresholds {
  /** TSS/hr upper bound for easy zone (default 70) */
  easy: number;
  /** TSS/hr upper bound for tempo/threshold zone (default 95) — above this = vo2/interval */
  tempo: number;
  calibratedFrom?: number;
}

/** Classification result for a cross-training activity */
export interface WorkoutClassification {
  /** Intensity profile — maps to planned run types for matching */
  type: 'easy' | 'threshold' | 'vo2';
  /** Estimated TSS for this activity */
  tss: number;
  /** Running-equivalent TSS (tss × sport.runSpec) — for comparing against planned run load */
  runningEquivTSS: number;
  /** Method used — for transparency in UI */
  method: 'itrimp' | 'zones' | 'profile';
}

/**
 * Classify workout intensity using iTRIMP.
 *
 * Normalisation: iTRIMP × 100 / 15000 ≈ TSS
 * (≈55 TSS for easy 60min, ≈85 TSS for tempo 60min, ≈120+ for intervals)
 * Classifier then uses TSS/hr against thresholds.
 */
export function classifyByITrimp(
  iTrimp: number,
  durationMin: number,
  thresholds?: IntensityThresholds
): { type: 'easy' | 'threshold' | 'vo2'; tss: number; tssPerHour: number } {
  const tss = (iTrimp * 100) / 15000;
  const tssPerHour = durationMin > 0 ? tss * (60 / durationMin) : 0;
  const easyUpper = thresholds?.easy ?? 70;
  const tempoUpper = thresholds?.tempo ?? 95;
  const type =
    tssPerHour < easyUpper ? 'easy' :
    tssPerHour < tempoUpper ? 'threshold' :
    'vo2';
  return { type, tss, tssPerHour };
}

/**
 * Classify workout intensity using HR zone distribution.
 * For steady-state sports (cycling, padel, swimming) where zone data is reliable (≥ 20min total).
 */
export function classifyByZones(hrZones: HRZoneData): {
  type: 'easy' | 'threshold' | 'vo2';
  baseRatio: number;
  threshRatio: number;
  intensityRatio: number;
} {
  const total =
    hrZones.zone1Minutes + hrZones.zone2Minutes + hrZones.zone3Minutes +
    hrZones.zone4Minutes + hrZones.zone5Minutes;
  if (total === 0) {
    return { type: 'easy', baseRatio: 1, threshRatio: 0, intensityRatio: 0 };
  }
  const baseRatio = (hrZones.zone1Minutes + hrZones.zone2Minutes) / total;
  const threshRatio = hrZones.zone3Minutes / total;
  const intensityRatio = (hrZones.zone4Minutes + hrZones.zone5Minutes) / total;
  const type =
    intensityRatio > 0.30 ? 'vo2' :
    threshRatio > 0.40 ? 'threshold' :
    'easy';
  return { type, baseRatio, threshRatio, intensityRatio };
}

/**
 * Classify a cross-training activity's workout type using the best available data.
 *
 * Decision tree (spec §6.2):
 * 1. Use iTRIMP when: sport is intermittent, OR high-HR proportion > 15%, OR < 20min zone data
 * 2. Use zone distribution for steady-state sports with ≥ 20min HR data
 * 3. Profile fallback — defaults to easy
 */
export function classifyWorkoutType(input: {
  sport: SportKey | string;
  durationMin: number;
  iTrimp?: number | null;
  hrZones?: HRZoneData;
  thresholds?: IntensityThresholds;
}): WorkoutClassification {
  const sportKey = normalizeSport(input.sport) as SportKey;
  const sportEntry = SPORTS_DB[sportKey as SportKey];
  const config = getSportConfig(sportKey);
  const isIntermittent = sportEntry?.intermittent ?? false;

  const totalZoneMin = input.hrZones
    ? input.hrZones.zone1Minutes + input.hrZones.zone2Minutes + input.hrZones.zone3Minutes +
      input.hrZones.zone4Minutes + input.hrZones.zone5Minutes
    : 0;
  const highHRRatio =
    totalZoneMin > 0
      ? (input.hrZones!.zone4Minutes + input.hrZones!.zone5Minutes) / totalZoneMin
      : 0;

  const hasITrimp = input.iTrimp != null && input.iTrimp > 0;
  // Use iTRIMP when: sport is intermittent, high-HR spike proportion > 15%, or < 20min zone data
  const useITrimp = hasITrimp && (isIntermittent || highHRRatio > 0.15 || totalZoneMin < 20);
  const useZones = !useITrimp && input.hrZones != null && totalZoneMin >= 20;

  let type: 'easy' | 'threshold' | 'vo2';
  let tss: number;
  let method: 'itrimp' | 'zones' | 'profile';

  if (useITrimp) {
    const result = classifyByITrimp(input.iTrimp!, input.durationMin, input.thresholds);
    type = result.type;
    tss = result.tss;
    method = 'itrimp';
  } else if (useZones) {
    const result = classifyByZones(input.hrZones!);
    type = result.type;
    // Estimate TSS from zone distribution when iTRIMP absent (TSS/min × duration)
    const intensityFactor = type === 'easy' ? 0.55 : type === 'threshold' ? 0.85 : 1.1;
    tss = input.durationMin * intensityFactor;
    method = 'zones';
  } else {
    // No HR data — safe default
    type = 'easy';
    tss = input.durationMin * 0.55;
    method = 'profile';
  }

  return { type, tss, runningEquivTSS: tss * config.runSpec, method };
}
