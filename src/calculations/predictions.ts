import type { PBs, RecentRun, RaceDistance, RunnerType } from '@/types';
import type { OnboardingState } from '@/types/onboarding';
import { rdKm, tv, cv } from './vdot';
import { getAbilityBand } from './fatigue';
import { applyTrainingHorizonAdjustment } from './training-horizon';

/** Skip adherence summary for penalty calculation */
export interface SkipSummary {
  missedLongRuns: number;
  missedQualityWorkouts: number;
  completedWorkouts: number;
  totalWorkouts: number;
}

/**
 * Calculate time penalty from skipped workouts.
 * Long runs: +0.5% per miss. Quality workouts: +0.3% per miss.
 * General adherence <80%: +2% total penalty.
 * @returns Penalty as a multiplier (e.g. 1.02 = 2% slower)
 */
export function calculateAdherencePenalty(summary: SkipSummary): number {
  let penaltyPct = 0;

  // Long run misses: +0.5% each
  penaltyPct += summary.missedLongRuns * 0.5;

  // Quality workout misses: +0.3% each
  penaltyPct += summary.missedQualityWorkouts * 0.3;

  // General adherence check
  if (summary.totalWorkouts > 0) {
    const adherence = summary.completedWorkouts / summary.totalWorkouts;
    if (adherence < 0.8) {
      penaltyPct += 2.0;
    }
  }

  return 1 + penaltyPct / 100;
}

/**
 * PB predictor - uses all-time PBs to predict target distance
 * @param targetDist - Target distance in meters
 * @param pbs - Personal bests
 * @param b - Fatigue exponent
 * @returns Predicted time in seconds, or null
 */
export function predictFromPB(targetDist: number, pbs: PBs, b: number): number | null {
  const avail: { d: number; t: number }[] = [];
  if (pbs.k5) avail.push({ d: 5000, t: pbs.k5 });
  if (pbs.k10) avail.push({ d: 10000, t: pbs.k10 });
  if (pbs.h) avail.push({ d: 21097, t: pbs.h });
  if (pbs.m) avail.push({ d: 42195, t: pbs.m });

  if (avail.length === 0) return null;

  // Find closest distance
  avail.sort((a, c) => Math.abs(a.d - targetDist) - Math.abs(c.d - targetDist));
  const anchor = avail[0];

  const safeB = Math.min(b, 1.15); // Cap extreme fatigue exponents
  return anchor.t * Math.pow(targetDist / anchor.d, safeB);
}

/**
 * Recent run predictor with recency decay blending
 * @param targetDist - Target distance in meters
 * @param recentRun - Recent race/time trial
 * @param pbs - Personal bests
 * @param b - Fatigue exponent
 * @returns Predicted time in seconds, or null
 */
export function predictFromRecent(
  targetDist: number,
  recentRun: RecentRun | null,
  pbs: PBs,
  b: number
): number | null {
  if (!recentRun || !recentRun.t || recentRun.t <= 0) return null;

  const recentDist = recentRun.d * 1000; // Convert km to meters
  const weeksAgo = recentRun.weeksAgo || 0;

  // Project recent run to target distance
  const safeB = Math.min(b, 1.08); // Cap penalty at 1.08 (Speed Type limit)
  const T_recent = recentRun.t * Math.pow(targetDist / recentDist, safeB);

  // Get all-time PB prediction for comparison
  const T_pb = predictFromPB(targetDist, pbs, b);

  if (!T_pb) {
    // No PB to blend with, just use recent
    return T_recent;
  }

  // Recency decay: blend recent with PB based on how old it is
  let alpha: number;
  if (weeksAgo <= 2) alpha = 0.85;       // Very fresh - trust it heavily
  else if (weeksAgo <= 6) alpha = 0.70;  // Recent - trust it moderately
  else if (weeksAgo <= 12) alpha = 0.50; // Getting old - equal weight
  else alpha = 0.20;                      // Stale - trust PB more

  return alpha * T_recent + (1 - alpha) * T_pb;
}

/**
 * LT predictor with runner-type and tier-aware multipliers.
 *
 * Multipliers convert LT pace (threshold/~60min effort) to predicted race pace.
 * Lower multiplier = faster predicted time.
 *
 * Crossover effect:
 * - Speed (high b): lower 5K mult, higher marathon mult
 * - Endurance (low b): higher 5K mult, lower marathon mult
 *
 * Tier effect (marathon only):
 * Elite/performance runners sustain closer to LT pace over marathon distance
 * (better fat oxidation, glycogen sparing, pacing). Recreational/beginner
 * runners lose more efficiency. Supported by critical speed research showing
 * faster marathoners sustain ~93% critical speed vs ~79% for slower runners.
 * 5K/10K/HM multipliers are stable across tiers.
 *
 * @param targetDist - Target distance in meters
 * @param ltPaceSecPerKm - LT pace in seconds per km
 * @param runnerType - Runner type string
 * @param athleteTier - Athlete tier for marathon-specific adjustment
 * @returns Predicted time in seconds, or null
 */
export function predictFromLT(
  targetDist: number,
  ltPaceSecPerKm: number | null,
  runnerType: string,
  athleteTier?: string
): number | null {
  if (!ltPaceSecPerKm) return null;

  // 5K/10K/HM: stable across tiers, literature-supported ranges
  const mult: Record<number, Record<string, number>> = {
    5000: { speed: 0.92, balanced: 0.935, endurance: 0.95 },
    10000: { speed: 0.98, balanced: 0.995, endurance: 1.01 },
    21097: { speed: 1.03, balanced: 1.045, endurance: 1.06 },
  };

  // Marathon: tier-aware. Research shows marathon pace = 104-114% of LT pace,
  // with fitter athletes closer to the low end (Daniels tables, critical speed
  // studies). Beginners lose more efficiency over 42K (fuelling, pacing, EIMD).
  const marathonMult: Record<string, Record<string, number>> = {
    high_volume:  { speed: 1.08, balanced: 1.06, endurance: 1.04 },
    performance:  { speed: 1.08, balanced: 1.06, endurance: 1.04 },
    trained:      { speed: 1.10, balanced: 1.08, endurance: 1.06 },
    recreational: { speed: 1.12, balanced: 1.10, endurance: 1.08 },
    beginner:     { speed: 1.14, balanced: 1.115, endurance: 1.09 },
  };

  const runnerTypeLower = runnerType ? runnerType.toLowerCase() : 'balanced';

  // Find closest canonical distance
  let distKey = targetDist;
  const canonical = [5000, 10000, 21097, 42195];
  if (!mult[distKey] && distKey !== 42195) {
    distKey = canonical.reduce((best, d) => Math.abs(d - targetDist) < Math.abs(best - targetDist) ? d : best);
  }

  let m: number;
  if (distKey === 42195) {
    // Derive tier from LT pace (running-specific) rather than using athleteTier
    // directly, which may reflect total cross-training CTL and overestimate
    // marathon-specific endurance. LT pace at ~60min effort → approximate VDOT
    // via 10K equivalent, then map to tier.
    const ltVdot = cv(10000, ltPaceSecPerKm * 10);
    const runTier = ltVdot >= 60 ? 'high_volume'
      : ltVdot >= 52 ? 'performance'
      : ltVdot >= 45 ? 'trained'
      : ltVdot >= 38 ? 'recreational'
      :                'beginner';
    const tierMult = marathonMult[runTier] || marathonMult.recreational;
    m = tierMult[runnerTypeLower] ?? 1.10;
  } else {
    m = mult[distKey]?.[runnerTypeLower] ?? 1.0;
  }

  return ltPaceSecPerKm * (targetDist / 1000) * m;
}

/**
 * VO2/VDOT predictor using Daniels equations
 * @param targetDist - Target distance in meters
 * @param targetVDOT - Target VDOT
 * @returns Predicted time in seconds, or null
 */
export function predictFromVO2(targetDist: number, targetVDOT: number | null): number | null {
  if (!targetVDOT) return null;

  const dVO2 = (v: number) => -4.60 + 0.182258 * v + 0.000104 * v * v;
  const dFrac = (t: number) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  const vdot = (ts: number) => {
    const tm = ts / 60;
    const v = targetDist / tm;
    return dVO2(v) / dFrac(tm);
  };

  let lo = (targetDist / 500) * 60;
  let hi = (targetDist / 50) * 60;

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const calc = vdot(mid);
    if (Math.abs(calc - targetVDOT) < 0.01) return mid;
    calc < targetVDOT ? hi = mid : lo = mid;
  }

  return (lo + hi) / 2;
}

export interface ForecastResult {
  forecastVdot: number;
  forecastTime: number;
}

/**
 * Shared forecast calculation used by both initialization and assessment.
 * Wraps applyTrainingHorizonAdjustment with standard parameters.
 */
export function calculateForecast(
  baselineVdot: number,
  sessionsPerWeek: number,
  state: OnboardingState,
  runnerType: RunnerType,
): ForecastResult {
  const targetDistStr = (state.raceDistance || 'half') as RaceDistance;
  const abilityBand = getAbilityBand(baselineVdot);

  const horizon = applyTrainingHorizonAdjustment({
    baseline_vdot: baselineVdot,
    target_distance: targetDistStr,
    weeks_remaining: state.planDurationWeeks,
    sessions_per_week: sessionsPerWeek,
    runner_type: runnerType,
    ability_band: abilityBand,
    taper_weeks: targetDistStr === 'marathon' ? 3 : 2,
    experience_level: state.experienceLevel || 'intermediate',
    hm_pb_seconds: state.pbs.h,
  });

  const forecastVdot = baselineVdot + horizon.vdot_gain;
  const raceDistKm = rdKm(targetDistStr);
  return { forecastVdot, forecastTime: tv(forecastVdot, raceDistKm) };
}

export interface LiveForecastParams {
  currentVdot: number;
  targetDistance: RaceDistance;
  weeksRemaining: number;
  sessionsPerWeek: number;
  runnerType: RunnerType;
  experienceLevel?: string;
  weeklyVolumeKm?: number;
  hmPbSeconds?: number;
  ltPaceSecPerKm?: number;
  adaptationRatio?: number;
}

/**
 * Single source of truth for forecast calculation.
 * Used by renderer (live dashboard), plan-preview (onboarding), and init.
 */
export function calculateLiveForecast(p: LiveForecastParams): ForecastResult {
  const abilityBand = getAbilityBand(p.currentVdot);
  const wr = p.weeksRemaining;

  const horizon = applyTrainingHorizonAdjustment({
    baseline_vdot: p.currentVdot,
    target_distance: p.targetDistance,
    weeks_remaining: wr,
    sessions_per_week: p.sessionsPerWeek,
    runner_type: p.runnerType,
    ability_band: abilityBand,
    taper_weeks: Math.max(1, Math.ceil(wr * 0.15)),
    experience_level: p.experienceLevel || 'intermediate',
    weekly_volume_km: p.weeklyVolumeKm,
    hm_pb_seconds: p.hmPbSeconds,
    lt_pace_sec_per_km: p.ltPaceSecPerKm,
  });

  let adjustedGain = horizon.vdot_gain;
  if (p.adaptationRatio && p.adaptationRatio !== 1.0) {
    adjustedGain *= p.adaptationRatio;
  }

  const forecastVdot = p.currentVdot + adjustedGain;
  const raceDistKm = rdKm(p.targetDistance);
  return { forecastVdot, forecastTime: tv(forecastVdot, raceDistKm) };
}

/**
 * Low-volume detraining adjustment for watch-derived fitness.
 *
 * Garmin/Apple LT and VO2 estimates update only from running activities,
 * so they stay elevated after training stops. Coyle 1984 and Mujika &
 * Padilla 2000 show meaningful endurance loss by week 2-3 of inactivity,
 * with fractional utilization (the marathon-critical term in Joyner &
 * Coyle 2008's decomposition) decaying faster than VO2max itself.
 *
 * Effect strengthens with distance: marathon LT/VO2 predictions overstate
 * fitness most when running volume is low because marathon pace is set by
 * fractional utilization, which is the most training-sensitive term.
 * 5K/10K are more VO2-limited and less affected.
 *
 * @param weeklyRunKm  4-week running-km average; undefined = no adjustment
 * @returns multiplier in [0, 1] applied to LT + VO2 weights; complement
 *          shifts onto PB (the peak-fitness anchor).
 */
function lowVolumeDiscount(targetDist: number, weeklyRunKm?: number): number {
  if (weeklyRunKm == null) return 1.0;

  // Distance sensitivity: marathon hit hardest, 5K barely touched.
  const distSensitivity =
    targetDist >= 42195 ? 1.0 :
    targetDist >= 21097 ? 0.7 :
    targetDist >= 10000 ? 0.4 :
    /* 5K */              0.2;

  // Volume bands (running-km/wk): below 20 we start discounting, below 10 max.
  let severity: number;
  if (weeklyRunKm >= 30)      severity = 0.0;
  else if (weeklyRunKm >= 20) severity = 0.15;
  else if (weeklyRunKm >= 10) severity = 0.30;
  else                        severity = 0.45;

  return 1 - severity * distSensitivity;
}

export function blendPredictions(
  targetDist: number,
  pbs: PBs,
  ltPace: number | null,
  vo2max: number | null,
  b: number,
  runnerType: string,
  recentRun: RecentRun | null,
  athleteTier?: string,
  weeklyRunKm?: number
): number | null {
  // Base weights: Prioritize CURRENT fitness indicators
  const hasRecent = recentRun && recentRun.t > 0;

  let baseWeights: Record<number, { recent?: number; pb: number; lt: number; vo2: number }>;
  if (hasRecent) {
    // 4 predictors: Recent, PB, LT, VO2
    baseWeights = {
      5000: { recent: 0.30, pb: 0.10, lt: 0.35, vo2: 0.25 },
      10000: { recent: 0.30, pb: 0.10, lt: 0.40, vo2: 0.20 },
      21097: { recent: 0.30, pb: 0.10, lt: 0.45, vo2: 0.15 },
      42195: { recent: 0.25, pb: 0.05, lt: 0.55, vo2: 0.15 }
    };
  } else {
    // 3 predictors: PB, LT, VO2
    baseWeights = {
      5000: { pb: 0.20, lt: 0.40, vo2: 0.40 },
      10000: { pb: 0.20, lt: 0.45, vo2: 0.35 },
      21097: { pb: 0.15, lt: 0.60, vo2: 0.25 },
      42195: { pb: 0.10, lt: 0.70, vo2: 0.20 }
    };
  }

  const w = { ...(baseWeights[targetDist] || baseWeights[42195]) };

  // Apply gradual recency decay based on how old the recent run is
  if (hasRecent && w.recent) {
    const weeksAgo = recentRun!.weeksAgo || 0;
    let recencyFactor = 1.0;

    if (weeksAgo <= 2) recencyFactor = 1.0;
    else if (weeksAgo <= 4) recencyFactor = 0.85;
    else if (weeksAgo <= 6) recencyFactor = 0.65;
    else if (weeksAgo <= 8) recencyFactor = 0.40;
    else recencyFactor = 0.15;

    if (recencyFactor < 1.0) {
      const recentReduction = w.recent * (1 - recencyFactor);
      w.recent = w.recent * recencyFactor;
      w.lt = w.lt + recentReduction * 0.7;
      w.pb = w.pb + recentReduction * 0.3;
    }
  }

  const tRecent = predictFromRecent(targetDist, recentRun, pbs, b);
  const tPB = predictFromPB(targetDist, pbs, b);
  const tLT = predictFromLT(targetDist, ltPace, runnerType, athleteTier);
  const tVO2 = predictFromVO2(targetDist, vo2max);

  // Low-volume detraining: watch LT/VO2 stay elevated without running.
  // Shift weight from LT+VO2 onto PB proportionally to the discount.
  const watchTrust = lowVolumeDiscount(targetDist, weeklyRunKm);
  if (watchTrust < 1.0 && tPB != null) {
    const ltShed = w.lt * (1 - watchTrust);
    const vo2Shed = w.vo2 * (1 - watchTrust);
    w.lt = w.lt * watchTrust;
    w.vo2 = w.vo2 * watchTrust;
    w.pb = w.pb + ltShed + vo2Shed;
  }

  let wRecent = tRecent && hasRecent ? (w.recent || 0) : 0;
  let wPB = tPB ? w.pb : 0;
  let wLT = tLT ? w.lt : 0;
  let wVO2 = tVO2 ? w.vo2 : 0;
  const totW = wRecent + wPB + wLT + wVO2;

  if (totW === 0) return null;

  let sum = 0;
  if (tRecent && hasRecent) sum += wRecent * tRecent;
  if (tPB) sum += wPB * tPB;
  if (tLT) sum += wLT * tLT;
  if (tVO2) sum += wVO2 * tVO2;

  return sum / totW;
}
