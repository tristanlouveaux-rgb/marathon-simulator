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
    };
  }
  // Unknown sport: use conservative defaults
  return {
    mult: 1.0,
    runSpec: 0.35,
    recoveryMult: 1.0,
    noReplace: [] as string[],
    extendedModel: undefined,
  };
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

  // TIER A: Garmin data available?
  if (
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
