import type { PBs, RecentRun, RaceDistance, RunnerType } from '@/types';
import type { OnboardingState } from '@/types/onboarding';
import { rdKm, tv, cv } from './vdot';
import { getAbilityBand } from './fatigue';
import { applyTrainingHorizonAdjustment } from './training-horizon';
import type { HRVdotResult } from './effort-calibrated-vdot';

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
 * HR-calibrated predictor — turns an effort-calibrated VDOT (from the Swain
 * regression across the last 8 weeks of HR-tagged runs) into a race-time
 * prediction at the target distance via Daniels' VDOT → time inversion.
 *
 * The confidence tier from `HRVdotResult` is consumed by `blendPredictions`
 * to set the weight on this signal, so we don't need to re-derive it here.
 */
export function predictFromHR(targetDist: number, hr: HRVdotResult | null | undefined): number | null {
  if (!hr || hr.vdot == null || hr.confidence === 'none') return null;
  return predictFromVO2(targetDist, hr.vdot);
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

/**
 * Tanda (2011) marathon predictor from training volume and mean pace.
 *
 *   T_marathon (min) = 11.03 + 98.46 × exp(−0.0053 × K) + 0.387 × P
 *
 * K = mean weekly running km (8-week window preferred, 4-week floor).
 * P = mean training pace in seconds per km across all runs in that window.
 *
 * Validated on 46 recreational-to-sub-elite marathoners, r = 0.91, SEE ~3 min.
 * Ref: Tanda G (2011) "Prediction of marathon performance time on the basis
 * of training indices." J Human Sport & Exercise 6(3).
 *
 * Marathon only — not applicable to 5K/10K/HM.
 * Returns null when volume is below 4 km/wk (out-of-sample; formula breaks down
 * at truly zero running) or above 120 km/wk (saturation region, untested).
 */
export function predictFromVolume(
  targetDist: number,
  weeklyRunKm: number | undefined,
  avgPaceSecPerKm: number | undefined,
): number | null {
  if (targetDist !== 42195) return null;
  if (weeklyRunKm == null || avgPaceSecPerKm == null) return null;
  if (weeklyRunKm < 4 || weeklyRunKm > 120) return null;
  if (avgPaceSecPerKm < 180 || avgPaceSecPerKm > 480) return null;

  // Clamp K to Tanda's training sample range (roughly 30–100 km/wk). Below 30
  // the formula extrapolates — still physiologically sensible (more volume =
  // faster) but less calibrated. We allow down to 4 km/wk but flag the extrapolation
  // via a small conservatism: soft-clamp K at 10 on the low end so the exponential
  // term doesn't dominate unrealistically.
  const K = Math.max(weeklyRunKm, 10);
  const P = avgPaceSecPerKm;

  const T_min = 11.03 + 98.46 * Math.exp(-0.0053 * K) + 0.387 * P;
  return T_min * 60; // convert to seconds
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
  weeklyRunKm?: number,
  avgPaceSecPerKm?: number,
  volumeMeta?: { weeksCovered: number; paceConfidence: 'high' | 'medium' | 'low' | 'none'; isStale: boolean },
  hrVdot?: HRVdotResult | null,
): number | null {
  // Base weights: Prioritize CURRENT fitness indicators
  const hasRecent = recentRun && recentRun.t > 0;

  // HR-calibrated VDOT (Swain regression across 8w of HR-tagged runs).
  // Treated as a separate predictor alongside LT/VO2 because it uses a
  // different physiological signal (steady-state effort response) and is
  // thus a valuable independent input in the weighted mean — not a
  // replacement for either LT or VO2. See docs/SCIENCE_LOG.md.
  const hasHR = hrVdot && hrVdot.vdot != null && hrVdot.confidence !== 'none';

  // Marathon-only Tanda predictor (volume + mean pace). Weighted heavily because
  // it is the only outcome-calibrated predictor in the blend (r=0.91 vs 46
  // marathoners; Tanda 2011). When unavailable, its weight redistributes to LT.
  let baseWeights: Record<number, { recent?: number; pb: number; lt: number; vo2: number; tanda?: number; hr?: number }>;
  if (hasRecent) {
    baseWeights = {
      5000:  { recent: 0.25, pb: 0.10, lt: 0.30, vo2: 0.20, hr: 0.15 },
      10000: { recent: 0.25, pb: 0.10, lt: 0.35, vo2: 0.15, hr: 0.15 },
      21097: { recent: 0.25, pb: 0.10, lt: 0.40, vo2: 0.10, hr: 0.15 },
      42195: { recent: 0.15, pb: 0.05, lt: 0.30, vo2: 0.10, tanda: 0.30, hr: 0.10 },
    };
  } else {
    baseWeights = {
      5000:  { pb: 0.20, lt: 0.35, vo2: 0.30, hr: 0.15 },
      10000: { pb: 0.20, lt: 0.40, vo2: 0.25, hr: 0.15 },
      21097: { pb: 0.15, lt: 0.50, vo2: 0.20, hr: 0.15 },
      42195: { pb: 0.10, lt: 0.40, vo2: 0.10, tanda: 0.30, hr: 0.10 },
    };
  }

  const w = { ...(baseWeights[targetDist] || baseWeights[42195]) } as { recent?: number; pb: number; lt: number; vo2: number; tanda?: number; hr?: number };

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
  const tHR = hasHR ? predictFromHR(targetDist, hrVdot) : null;

  // Scale HR weight by confidence tier. Matches Tanda's confidence-gating
  // pattern: low-confidence signals shouldn't carry full weight, but their
  // information is still worth ~1/3 of a high-confidence signal.
  if (w.hr != null) {
    if (!hasHR || tHR == null) {
      // Redistribute HR weight to LT (same pattern as Tanda fallback).
      w.lt = w.lt + w.hr;
      w.hr = 0;
    } else {
      const confidenceFactor = hrVdot!.confidence === 'high' ? 1.0
        : hrVdot!.confidence === 'medium' ? 0.7
        : /* low */ 0.4;
      const shed = w.hr * (1 - confidenceFactor);
      w.hr = w.hr * confidenceFactor;
      // Shed weight goes proportionally to LT (the next-best fitness-ceiling predictor).
      w.lt = w.lt + shed;
    }
  }
  // Gate Tanda on sample-size confidence: needs ≥4 weeks of history AND at
  // least 'medium' pace confidence (≥4 training runs across ≥3 weeks). Below
  // that threshold, P and K are too noisy to trust and Tanda can over- or
  // under-predict by minutes. When gated out, weight redistributes to LT.
  const tandaTrusted = !volumeMeta
    || (volumeMeta.weeksCovered >= 4
        && (volumeMeta.paceConfidence === 'high' || volumeMeta.paceConfidence === 'medium')
        && !volumeMeta.isStale);
  const tTanda = tandaTrusted
    ? predictFromVolume(targetDist, weeklyRunKm, avgPaceSecPerKm)
    : null;

  // Tanda handles volume-sensitivity at marathon directly; applying the low-
  // volume LT/VO2 weight discount too would double-penalise. Keep the discount
  // for shorter distances (no Tanda coverage) only.
  if (targetDist !== 42195) {
    const watchTrust = lowVolumeDiscount(targetDist, weeklyRunKm);
    if (watchTrust < 1.0 && tPB != null) {
      const ltShed = w.lt * (1 - watchTrust);
      const vo2Shed = w.vo2 * (1 - watchTrust);
      w.lt = w.lt * watchTrust;
      w.vo2 = w.vo2 * watchTrust;
      w.pb = w.pb + ltShed + vo2Shed;
    }
  }

  // If Tanda unavailable (missing inputs, out-of-range, or non-marathon),
  // redistribute its weight onto LT — the next-best fitness-ceiling predictor.
  if (w.tanda != null && tTanda == null) {
    w.lt = w.lt + w.tanda;
    w.tanda = 0;
  }

  const wRecent = tRecent && hasRecent ? (w.recent || 0) : 0;
  const wPB = tPB ? w.pb : 0;
  const wLT = tLT ? w.lt : 0;
  const wVO2 = tVO2 ? w.vo2 : 0;
  const wTanda = tTanda ? (w.tanda || 0) : 0;
  const wHR = tHR ? (w.hr || 0) : 0;
  const totW = wRecent + wPB + wLT + wVO2 + wTanda + wHR;

  if (totW === 0) return null;

  let sum = 0;
  if (tRecent && hasRecent) sum += wRecent * tRecent;
  if (tPB) sum += wPB * tPB;
  if (tLT) sum += wLT * tLT;
  if (tVO2) sum += wVO2 * tVO2;
  if (tTanda) sum += wTanda * tTanda;
  if (tHR) sum += wHR * tHR;

  return sum / totW;
}
