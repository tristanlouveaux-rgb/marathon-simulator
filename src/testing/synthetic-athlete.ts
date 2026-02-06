/**
 * Synthetic Athlete Generator
 * ===========================
 *
 * Generates mathematically coherent synthetic athlete data for audit testing.
 * All PBs, LT pace, VO2, and recent runs are derived from a single anchor VDOT
 * using deterministic formulas that can be verified.
 *
 * AUDIT PRINCIPLE: Every number must have an explicit derivation path.
 *
 * KEY FORMULAS:
 * 1. PBs: T(d) = T_anchor * (d / d_anchor)^b  [Riegel power law]
 * 2. LT Pace: 60-minute race pace at VDOT (Daniels T-pace definition)
 * 3. VO2: Treated as equal to VDOT (engine assumption)
 * 4. Recent Run: Time at specified distance for VDOT ± diff
 *
 * SOURCE FILES:
 * - tv(), cv(): src/calculations/vdot.ts
 * - calculateFatigueExponent(), getRunnerType(): src/calculations/fatigue.ts
 */

import type { PBs, RecentRun, RunnerType } from '@/types';
import { tv, cv } from '@/calculations/vdot';
import { calculateFatigueExponent, getRunnerType } from '@/calculations/fatigue';

/** Standard race distances in meters */
export const DISTANCES = {
  k5: 5000,
  k10: 10000,
  half: 21097,
  marathon: 42195,
} as const;

/** Synthetic athlete configuration */
export interface SyntheticAthleteConfig {
  /** Anchor VDOT - defines the baseline fitness level */
  baseVdot: number;

  /** Target fatigue exponent for PB generation */
  bTarget: number;

  /** Anchor distance in km (default: 5) */
  anchorDistanceKm?: number;

  /** LT VDOT offset from base (default: 0) */
  ltVdotDiff?: number;

  /** VO2/VDOT offset from base (default: 0) */
  vo2VdotDiff?: number;

  /** Recent run configuration */
  recentRun?: {
    distanceKm: number;
    vdotDiff: number;
    weeksAgo: number;
  } | null;
}

/** Generated synthetic athlete data */
export interface SyntheticAthlete {
  /** Configuration used to generate this athlete */
  config: SyntheticAthleteConfig;

  /** Personal bests in seconds */
  pbs: PBs;

  /** Derived fatigue exponent from PBs */
  bEstimated: number;

  /** Derived runner type from b_estimated */
  runnerType: RunnerType;

  /** LT pace in seconds per km (Daniels T-pace) */
  ltPaceSecPerKm: number | null;

  /** VO2max value (treated as VDOT by engine) */
  vo2max: number | null;

  /** Recent run if configured */
  recentRun: RecentRun | null;

  /** Audit trail showing derivation of each value */
  derivations: Record<string, string>;
}

/** Coherence check result */
export interface CoherenceReport {
  /** Is the athlete data internally consistent? */
  isCoherent: boolean;

  /** Individual checks */
  checks: {
    name: string;
    passed: boolean;
    expected: number | string;
    actual: number | string;
    tolerance?: number;
    message: string;
  }[];

  /** Summary message */
  summary: string;
}

/**
 * Compute LT pace as 60-minute race pace at given VDOT.
 *
 * This matches the Anti-Gravity / Daniels definition of threshold pace:
 * the pace you can sustain for approximately 60 minutes in a race.
 *
 * METHOD: Binary search to find distance where tv(distKm, vdot) ≈ 3600 sec
 *
 * @param vdot - Target VDOT for LT pace calculation
 * @returns LT pace in seconds per km
 */
export function computeLtPaceFromVdot60min(vdot: number): number {
  const targetTimeSec = 3600; // 60 minutes

  // Binary search for distance where race time = 60 minutes at this VDOT
  let lowKm = 5;    // Minimum realistic 60-min distance
  let highKm = 25;  // Maximum realistic 60-min distance

  for (let i = 0; i < 50; i++) {
    const midKm = (lowKm + highKm) / 2;
    const timeAtMid = tv(vdot, midKm);

    if (Math.abs(timeAtMid - targetTimeSec) < 1) {
      // Found it - return pace
      return targetTimeSec / midKm;
    }

    if (timeAtMid < targetTimeSec) {
      // Time too fast, need longer distance
      lowKm = midKm;
    } else {
      // Time too slow, need shorter distance
      highKm = midKm;
    }
  }

  // Return best estimate
  const distKm = (lowKm + highKm) / 2;
  return targetTimeSec / distKm;
}

/**
 * Find the distance (in km) that takes targetTimeSec at given VDOT.
 * Useful for understanding what the LT distance is.
 */
export function findDistanceForTime(vdot: number, targetTimeSec: number): number {
  let lowKm = 1;
  let highKm = 50;

  for (let i = 0; i < 50; i++) {
    const midKm = (lowKm + highKm) / 2;
    const timeAtMid = tv(vdot, midKm);

    if (Math.abs(timeAtMid - targetTimeSec) < 1) {
      return midKm;
    }

    if (timeAtMid < targetTimeSec) {
      lowKm = midKm;
    } else {
      highKm = midKm;
    }
  }

  return (lowKm + highKm) / 2;
}

/**
 * Generate PBs using Riegel power law from anchor time.
 *
 * FORMULA: T(d) = T_anchor * (d / d_anchor)^b
 *
 * This ensures the derived b from these PBs matches bTarget.
 *
 * @param anchorTimeSec - Time at anchor distance
 * @param anchorDistanceMeters - Anchor distance in meters
 * @param bTarget - Target fatigue exponent
 * @returns PBs object
 */
export function generatePbsFromAnchor(
  anchorTimeSec: number,
  anchorDistanceMeters: number,
  bTarget: number
): PBs {
  const pbs: PBs = {};

  // Generate each PB using Riegel formula
  pbs.k5 = anchorTimeSec * Math.pow(DISTANCES.k5 / anchorDistanceMeters, bTarget);
  pbs.k10 = anchorTimeSec * Math.pow(DISTANCES.k10 / anchorDistanceMeters, bTarget);
  pbs.h = anchorTimeSec * Math.pow(DISTANCES.half / anchorDistanceMeters, bTarget);
  pbs.m = anchorTimeSec * Math.pow(DISTANCES.marathon / anchorDistanceMeters, bTarget);

  return pbs;
}

/**
 * Create a synthetic athlete with mathematically coherent data.
 *
 * DERIVATION CHAIN:
 * 1. baseVdot → anchor time via tv(anchorDistKm, baseVdot)
 * 2. anchor time + bTarget → all PBs via Riegel
 * 3. PBs → bEstimated via calculateFatigueExponent()
 * 4. bEstimated → runnerType via getRunnerType()
 * 5. baseVdot + ltVdotDiff → ltPaceSecPerKm via computeLtPaceFromVdot60min()
 * 6. baseVdot + vo2VdotDiff → vo2max (direct, as engine treats VO2 = VDOT)
 * 7. recentRun VDOT → recentRun time via tv()
 */
export function createSyntheticAthlete(config: SyntheticAthleteConfig): SyntheticAthlete {
  const {
    baseVdot,
    bTarget,
    anchorDistanceKm = 5,
    ltVdotDiff = 0,
    vo2VdotDiff = 0,
    recentRun: recentConfig = null,
  } = config;

  const derivations: Record<string, string> = {};
  const anchorDistanceMeters = anchorDistanceKm * 1000;

  // Step 1: Compute anchor time from VDOT
  const anchorTimeSec = tv(baseVdot, anchorDistanceKm);
  derivations['anchorTime'] = `tv(${baseVdot}, ${anchorDistanceKm}) = ${anchorTimeSec.toFixed(2)}s [vdot.ts:tv()]`;

  // Step 2: Generate PBs using Riegel power law
  const pbs = generatePbsFromAnchor(anchorTimeSec, anchorDistanceMeters, bTarget);
  derivations['pbs.k5'] = `${anchorTimeSec.toFixed(2)} * (5000/${anchorDistanceMeters})^${bTarget} = ${pbs.k5!.toFixed(2)}s`;
  derivations['pbs.k10'] = `${anchorTimeSec.toFixed(2)} * (10000/${anchorDistanceMeters})^${bTarget} = ${pbs.k10!.toFixed(2)}s`;
  derivations['pbs.h'] = `${anchorTimeSec.toFixed(2)} * (21097/${anchorDistanceMeters})^${bTarget} = ${pbs.h!.toFixed(2)}s`;
  derivations['pbs.m'] = `${anchorTimeSec.toFixed(2)} * (42195/${anchorDistanceMeters})^${bTarget} = ${pbs.m!.toFixed(2)}s`;

  // Step 3: Derive b from generated PBs (should match bTarget)
  const bEstimated = calculateFatigueExponent(pbs);
  derivations['bEstimated'] = `calculateFatigueExponent(pbs) = ${bEstimated.toFixed(4)} [fatigue.ts:calculateFatigueExponent()]`;

  // Step 4: Derive runner type from estimated b
  const runnerType = getRunnerType(bEstimated);
  derivations['runnerType'] = `getRunnerType(${bEstimated.toFixed(4)}) = "${runnerType}" [fatigue.ts:getRunnerType()]`;

  // Step 5: Compute LT pace from VDOT + offset
  let ltPaceSecPerKm: number | null = null;
  if (ltVdotDiff !== null) {
    const ltVdot = baseVdot + ltVdotDiff;
    ltPaceSecPerKm = computeLtPaceFromVdot60min(ltVdot);
    const ltDistKm = findDistanceForTime(ltVdot, 3600);
    derivations['ltPaceSecPerKm'] = `60min race pace at VDOT ${ltVdot} = ${ltPaceSecPerKm.toFixed(2)}s/km (${ltDistKm.toFixed(2)}km in 60min)`;
  }

  // Step 6: Compute VO2max (engine treats as VDOT)
  let vo2max: number | null = null;
  if (vo2VdotDiff !== null) {
    vo2max = baseVdot + vo2VdotDiff;
    derivations['vo2max'] = `baseVdot + vo2VdotDiff = ${baseVdot} + ${vo2VdotDiff} = ${vo2max}`;
  }

  // Step 7: Generate recent run if configured
  let recentRun: RecentRun | null = null;
  if (recentConfig) {
    const recentVdot = baseVdot + recentConfig.vdotDiff;
    const recentTimeSec = tv(recentVdot, recentConfig.distanceKm);
    recentRun = {
      d: recentConfig.distanceKm,
      t: recentTimeSec,
      weeksAgo: recentConfig.weeksAgo,
    };
    derivations['recentRun'] = `tv(${recentVdot}, ${recentConfig.distanceKm}) = ${recentTimeSec.toFixed(2)}s, ${recentConfig.weeksAgo} weeks ago`;
  }

  return {
    config,
    pbs,
    bEstimated,
    runnerType,
    ltPaceSecPerKm,
    vo2max,
    recentRun,
    derivations,
  };
}

/**
 * Validate that synthetic athlete data is internally coherent.
 *
 * CHECKS:
 * 1. bEstimated ≈ bTarget (within tolerance)
 * 2. Implied VDOT from anchor PB matches baseVdot
 * 3. Runner type semantics are consistent
 */
export function coherenceReport(athlete: SyntheticAthlete): CoherenceReport {
  const checks: CoherenceReport['checks'] = [];
  const { config, pbs, bEstimated, runnerType } = athlete;

  // Check 1: b estimation accuracy
  const bTolerance = 0.01;
  const bDiff = Math.abs(bEstimated - config.bTarget);
  checks.push({
    name: 'b_estimation',
    passed: bDiff <= bTolerance,
    expected: config.bTarget,
    actual: bEstimated,
    tolerance: bTolerance,
    message: bDiff <= bTolerance
      ? `bEstimated ${bEstimated.toFixed(4)} matches bTarget ${config.bTarget} within tolerance`
      : `bEstimated ${bEstimated.toFixed(4)} differs from bTarget ${config.bTarget} by ${bDiff.toFixed(4)}`,
  });

  // Check 2: Implied VDOT from 5k PB matches baseVdot
  const vdotFrom5k = cv(DISTANCES.k5, pbs.k5!);
  const vdotTolerance = 0.5;
  const vdotDiff = Math.abs(vdotFrom5k - config.baseVdot);
  checks.push({
    name: 'vdot_5k_coherence',
    passed: vdotDiff <= vdotTolerance,
    expected: config.baseVdot,
    actual: vdotFrom5k,
    tolerance: vdotTolerance,
    message: vdotDiff <= vdotTolerance
      ? `VDOT from 5k PB (${vdotFrom5k.toFixed(2)}) matches baseVdot (${config.baseVdot}) within tolerance`
      : `VDOT from 5k PB (${vdotFrom5k.toFixed(2)}) differs from baseVdot (${config.baseVdot}) by ${vdotDiff.toFixed(2)}`,
  });

  // Check 3: Implied VDOTs from other PBs (for logging, not strict pass/fail)
  const vdotFrom10k = cv(DISTANCES.k10, pbs.k10!);
  const vdotFromHalf = cv(DISTANCES.half, pbs.h!);
  const vdotFromMarathon = cv(DISTANCES.marathon, pbs.m!);

  checks.push({
    name: 'vdot_10k_implied',
    passed: true, // Info only
    expected: config.baseVdot,
    actual: vdotFrom10k,
    message: `VDOT implied by 10k PB: ${vdotFrom10k.toFixed(2)} (diff: ${(vdotFrom10k - config.baseVdot).toFixed(2)})`,
  });

  checks.push({
    name: 'vdot_half_implied',
    passed: true, // Info only
    expected: config.baseVdot,
    actual: vdotFromHalf,
    message: `VDOT implied by HM PB: ${vdotFromHalf.toFixed(2)} (diff: ${(vdotFromHalf - config.baseVdot).toFixed(2)})`,
  });

  checks.push({
    name: 'vdot_marathon_implied',
    passed: true, // Info only
    expected: config.baseVdot,
    actual: vdotFromMarathon,
    message: `VDOT implied by M PB: ${vdotFromMarathon.toFixed(2)} (diff: ${(vdotFromMarathon - config.baseVdot).toFixed(2)})`,
  });

  // Check 4: Runner type semantic verification
  // CRITICAL AUDIT: Verify that the label matches the intended semantics
  // "Speed" = better at short distances = MORE fade = HIGHER b
  // "Endurance" = better at long distances = LESS fade = LOWER b
  const fadeRatio = Math.log(pbs.m! / pbs.k5!) / Math.log(DISTANCES.marathon / DISTANCES.k5);

  // Expected semantics (user requirement):
  // Speed: b > 1.12 (high fade, relatively slower at long distances)
  // Endurance: b < 1.06 (low fade, relatively faster at long distances)
  // Balanced: 1.06 <= b <= 1.12

  // Current engine getRunnerType():
  // b < 1.06 → 'Speed'
  // b > 1.12 → 'Endurance'
  // This is INVERTED relative to intended semantics!

  const expectedSemanticType = bEstimated > 1.12 ? 'Speed' :
                               bEstimated < 1.06 ? 'Endurance' :
                               'Balanced';

  const semanticsMatch = (
    (expectedSemanticType === 'Speed' && runnerType === 'Speed') ||
    (expectedSemanticType === 'Endurance' && runnerType === 'Endurance') ||
    (expectedSemanticType === 'Balanced' && runnerType === 'Balanced')
  );

  // Note: Current engine has inverted labels, so this check will FAIL for Speed/Endurance
  // This is intentional - it documents the bug
  checks.push({
    name: 'runner_type_semantics',
    passed: semanticsMatch,
    expected: expectedSemanticType,
    actual: runnerType,
    message: semanticsMatch
      ? `Runner type "${runnerType}" correctly matches b=${bEstimated.toFixed(4)} semantics`
      : `SEMANTIC INVERSION: b=${bEstimated.toFixed(4)} should be "${expectedSemanticType}" but engine returns "${runnerType}"`,
  });

  // Add detailed fade analysis
  checks.push({
    name: 'fade_analysis',
    passed: true, // Info only
    expected: `b=${config.bTarget}`,
    actual: `fade=${fadeRatio.toFixed(4)}`,
    message: `Fade ratio (ln(Tm/T5k)/ln(Dm/D5k)) = ${fadeRatio.toFixed(4)}, higher = more endurance loss over distance`,
  });

  const isCoherent = checks.filter(c => !c.passed && c.name !== 'runner_type_semantics').length === 0;

  return {
    isCoherent,
    checks,
    summary: isCoherent
      ? 'Synthetic athlete is mathematically coherent (note: runner type semantic issue documented separately)'
      : 'Synthetic athlete has coherence issues: ' + checks.filter(c => !c.passed).map(c => c.name).join(', '),
  };
}

/**
 * Format time in seconds to mm:ss or hh:mm:ss string.
 */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Print a synthetic athlete summary for debugging.
 */
export function printAthleteSummary(athlete: SyntheticAthlete): void {
  const { config, pbs, bEstimated, runnerType, ltPaceSecPerKm, vo2max, recentRun, derivations } = athlete;

  console.log('\n=== SYNTHETIC ATHLETE ===');
  console.log(`Base VDOT: ${config.baseVdot}`);
  console.log(`Target b: ${config.bTarget}`);
  console.log(`Estimated b: ${bEstimated.toFixed(4)}`);
  console.log(`Runner Type: ${runnerType}`);
  console.log('\nPBs:');
  console.log(`  5k:  ${formatTime(pbs.k5!)} (${pbs.k5!.toFixed(1)}s)`);
  console.log(`  10k: ${formatTime(pbs.k10!)} (${pbs.k10!.toFixed(1)}s)`);
  console.log(`  HM:  ${formatTime(pbs.h!)} (${pbs.h!.toFixed(1)}s)`);
  console.log(`  M:   ${formatTime(pbs.m!)} (${pbs.m!.toFixed(1)}s)`);

  if (ltPaceSecPerKm) {
    console.log(`\nLT Pace: ${formatTime(ltPaceSecPerKm)}/km`);
  }

  if (vo2max) {
    console.log(`VO2max (as VDOT): ${vo2max}`);
  }

  if (recentRun) {
    console.log(`\nRecent Run: ${recentRun.d}km in ${formatTime(recentRun.t)}, ${recentRun.weeksAgo} weeks ago`);
  }

  console.log('\n--- Derivations ---');
  Object.entries(derivations).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
}
