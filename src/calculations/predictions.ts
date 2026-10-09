import { planTaperWeeks } from '@/workouts/race-week-layout';
import type { PBs, RecentRun, RaceDistance, RunnerType } from '@/types';
import type { OnboardingState } from '@/types/onboarding';
import { rdKm, tv, cv } from './vdot';
import { getAbilityBand } from './fatigue';
import { applyTrainingHorizonAdjustment, getPlanPrescribedMeanWeeklyKm } from './training-horizon';
import { TAPER_NOMINAL } from '@/constants/training-params';
import type { HRVdotResult } from './effort-calibrated-vdot';
import type { PbAgeWeights, PbKey } from './physiological-vdot';
import { applyRunningCourseFactors } from './course-factors-running';

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
 * Returns the user's PB at the EXACT target distance (within 1%), or null.
 * Used as a demonstrated-performance floor: the blend must not predict slower
 * than a time the athlete has actually run at this distance, absent positive
 * evidence of detraining. A marathon PB does NOT floor a half prediction (and
 * vice versa) — only same-distance PBs qualify.
 */
function exactDistancePB(targetDist: number, pbs: PBs): { key: PbKey; t: number } | null {
  const candidates: { key: PbKey; d: number; t: number | undefined }[] = [
    { key: 'k5', d: 5000, t: pbs.k5 },
    { key: 'k10', d: 10000, t: pbs.k10 },
    { key: 'h', d: 21097, t: pbs.h },
    { key: 'm', d: 42195, t: pbs.m },
  ];
  for (const { key, d, t } of candidates) {
    if (t && t > 0 && Math.abs(d - targetDist) / d < 0.01) return { key, t };
  }
  return null;
}

/**
 * Demonstrated-PB floor (2026-06-15).
 *
 * A PB at the EXACT target distance is a demonstrated performance. A prediction
 * must never come out slower than it UNLESS we have positive evidence the athlete
 * has lost that fitness. The penalties in the prediction pipeline (marathon-
 * specificity, long-run durability cap) exist to correct a *returning* athlete or
 * a short-anchor extrapolation; they must not override a stated same-distance PB
 * for a brand-new user with no contradicting data.
 *
 * "No training data" is NOT evidence of detraining. Two things ARE:
 *   1. A *measured* weekly-volume signal below the maintenance floor (30 km/wk —
 *      the cutoff above which the marathon-specificity penalty treats fractional-
 *      utilization decay as negligible, Coyle 1984). A volume figure ESTIMATED
 *      from runs/week (`weeklyRunKmIsEstimate`) does NOT count: an assumption may
 *      size a soft penalty but must never override a demonstrated PB — that is the
 *      exact "assumption beats fact" error this floor exists to prevent.
 *   2. A recent run/race that itself projects SLOWER than the PB at the target
 *      distance — direct evidence of reduced current fitness (e.g. a returning
 *      runner whose 1:28 half PB is contradicted by a recent 24:00 5K).
 *
 * When either holds, the floor stands down and the penalised blend is trusted.
 *
 * PB age (2026-10-09): `ctx.pbAgeWeights` carries the age weight of each PB
 * (`pbAgeWeight`, SCIENCE_LOG §T5 bands). Callers pass it only when they hold
 * current running data (a measured weekly volume); with no data an old PB still
 * floors (§BV). A same-distance PB whose age weight is below 1 (older than two
 * years) is past capacity, not a demonstrated current performance, so the
 * floor stands down; the PB keeps its reduced weight in the blend (the PB
 * predictor in `blendPredictions`) and in the §BZ engine floor. Kept binary so
 * the floor stays idempotent (callers apply it inside the blend and again after
 * the durability cap).
 * Limitation: a genuinely stale PB with no measured volume and no recent run is
 * still trusted as the floor — we prefer optimism over telling an athlete they
 * are slower than a proven time with zero supporting evidence. A typed PB has
 * no date and never ages.
 *
 * Pure function. Idempotent: flooring an already-floored value is a no-op, so it
 * is safe to call again after an externally-applied penalty (e.g. the durability
 * cap that callers multiply on after blendPredictions).
 */
export function demonstratedPBFloor(
  timeSec: number,
  targetDist: number,
  pbs: PBs,
  ctx: { weeklyRunKm?: number; weeklyRunKmIsEstimate?: boolean; recentRun?: RecentRun | null; b: number; pbAgeWeights?: PbAgeWeights },
): number {
  const exact = exactDistancePB(targetDist, pbs);
  if (exact == null || timeSec <= exact.t) return timeSec;
  const exactPb = exact.t;
  if ((ctx.pbAgeWeights?.[exact.key] ?? 1) < 1) return timeSec;

  const lowVolumeEvidence =
    ctx.weeklyRunKm != null && ctx.weeklyRunKm < 30 && !ctx.weeklyRunKmIsEstimate;
  const tRecent = ctx.recentRun && ctx.recentRun.t > 0
    ? predictFromRecent(targetDist, ctx.recentRun, pbs, ctx.b)
    : null;
  const recentContradictsPb = tRecent != null && tRecent > exactPb;

  if (lowVolumeEvidence || recentContradictsPb) return timeSec;
  return exactPb;
}

/** The PB `predictFromPB` extrapolates from: the one closest in distance to
 *  the target (ties keep 5K, 10K, half, marathon order). Null without PBs. */
function pbAnchor(targetDist: number, pbs: PBs): { key: PbKey; d: number; t: number } | null {
  const avail: { key: PbKey; d: number; t: number }[] = [];
  if (pbs.k5) avail.push({ key: 'k5', d: 5000, t: pbs.k5 });
  if (pbs.k10) avail.push({ key: 'k10', d: 10000, t: pbs.k10 });
  if (pbs.h) avail.push({ key: 'h', d: 21097, t: pbs.h });
  if (pbs.m) avail.push({ key: 'm', d: 42195, t: pbs.m });

  if (avail.length === 0) return null;

  // Find closest distance
  avail.sort((a, c) => Math.abs(a.d - targetDist) - Math.abs(c.d - targetDist));
  return avail[0];
}

/**
 * PB predictor - uses all-time PBs to predict target distance
 * @param targetDist - Target distance in meters
 * @param pbs - Personal bests
 * @param b - Fatigue exponent
 * @returns Predicted time in seconds, or null
 */
export function predictFromPB(targetDist: number, pbs: PBs, b: number): number | null {
  const anchor = pbAnchor(targetDist, pbs);
  if (anchor == null) return null;

  // Cap extreme fatigue exponents at 1.15 (ceiling. Prevents over-penalising
  // extreme endurance profiles).
  //
  // 2026-05-12 audit: add a floor of 1.10 when extrapolating from a short
  // anchor (≤10K) to half-marathon or longer. Speed-profile runners (b≈1.05-
  // 1.08 derived from k5→k10) under-correct at marathon distance because the
  // endurance drop-off past 21K is not captured by short-race ratios. Cameron
  // (1997) and Riegel (1981) both note that extrapolations >4× the anchor
  // distance require b≥1.10 for trained runners. SCIENCE_LOG.md audit #11.
  let safeB = Math.min(b, 1.15);
  if (targetDist >= 21097 && anchor.d <= 10000) {
    safeB = Math.max(safeB, 1.10);
  }
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
  //
  // 2026-05-12 audit: speed-column multipliers raised by 0.02 across performance
  // and trained tiers. The original calibration was based on runners with
  // demonstrated marathon fitness; for speed-profile runners with no marathon
  // history the LT→marathon pace ratio is wider (Billat et al. 2003. Speed
  // runners sustain 3-5% less of LT pace at marathon distance than endurance
  // runners at equivalent aerobic capacity). See SCIENCE_LOG.md audit #11.
  const marathonMult: Record<string, Record<string, number>> = {
    high_volume:  { speed: 1.10, balanced: 1.06, endurance: 1.04 },
    performance:  { speed: 1.10, balanced: 1.06, endurance: 1.04 },
    trained:      { speed: 1.12, balanced: 1.08, endurance: 1.06 },
    recreational: { speed: 1.12, balanced: 1.10, endurance: 1.08 },
    beginner:     { speed: 1.14, balanced: 1.115, endurance: 1.09 },
  };

  // Tier ordering and VDOT cut-points for linear interpolation between tiers.
  // The previous step function flipped the multiplier by 0.02 at hard cut-points
  // (VDOT 45 trained→performance, VDOT 52 performance→high_volume), producing
  // up to a 2-min discontinuity in marathon prediction for athletes near a
  // boundary. Linear interpolation between the two nearest tiers smooths this.
  // 2026-05-12 audit: SCIENCE_LOG.md audit #11.
  const tierAnchors: { name: string; vdot: number }[] = [
    { name: 'beginner',     vdot: 30 },  // floor anchor
    { name: 'recreational', vdot: 38 },
    { name: 'trained',      vdot: 45 },
    { name: 'performance',  vdot: 52 },
    { name: 'high_volume',  vdot: 60 },  // ceiling anchor
  ];

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

    // Linear interpolation between adjacent tier anchors. Clamps at the two
    // endpoints (≤beginner anchor or ≥high_volume anchor) so extreme values
    // stay at the boundary multiplier.
    let lower = tierAnchors[0];
    let upper = tierAnchors[tierAnchors.length - 1];
    for (let i = 0; i < tierAnchors.length - 1; i++) {
      if (ltVdot >= tierAnchors[i].vdot && ltVdot <= tierAnchors[i + 1].vdot) {
        lower = tierAnchors[i];
        upper = tierAnchors[i + 1];
        break;
      }
    }
    const lowerMult = marathonMult[lower.name]?.[runnerTypeLower] ?? marathonMult.recreational[runnerTypeLower] ?? 1.10;
    const upperMult = marathonMult[upper.name]?.[runnerTypeLower] ?? marathonMult.recreational[runnerTypeLower] ?? 1.10;
    const span = upper.vdot - lower.vdot;
    const t = span > 0 ? Math.max(0, Math.min(1, (ltVdot - lower.vdot) / span)) : 0;
    m = lowerMult + t * (upperMult - lowerMult);
  } else {
    m = mult[distKey]?.[runnerTypeLower] ?? 1.0;
  }

  return ltPaceSecPerKm * (targetDist / 1000) * m;
}

/**
 * HR-calibrated predictor. Turns an effort-calibrated VDOT (from the Swain
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
 * Marathon only. Not applicable to 5K/10K/HM.
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
  // the formula extrapolates. Still physiologically sensible (more volume =
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
  /** Raw VDOT-derived finish time before any course adjustment. */
  forecastTime: number;
  /** Finish time after applying course factors (climate/altitude/elevation).
   * Only present when a course profile was supplied. Equals forecastTime otherwise. */
  forecastTimeAdjusted?: number;
  /** Itemised course factors that produced the adjustment (for UI). */
  courseFactors?: import('./course-factors-running').RunningCourseFactor[];
}

/**
 * Shared forecast calculation used by both initialization and assessment.
 * Wraps applyTrainingHorizonAdjustment with standard parameters.
 *
 * `blendedAnchorSec` (optional): when supplied, the forecast is anchored to the
 * blended race-prediction time and the horizon model's gain is applied as a
 * delta on top. Keeps the projected end-of-plan time on the same scale as the
 * live "Current Race Estimate" surfaces. See `calculateLiveForecast` for the
 * full rationale.
 */
export function calculateForecast(
  baselineVdot: number,
  sessionsPerWeek: number,
  state: OnboardingState,
  runnerType: RunnerType,
  blendedAnchorSec?: number,
  rampCtx?: { baselineKm?: number; archetype?: import('./athlete-archetype').Archetype },
): ForecastResult {
  const targetDistStr = (state.raceDistance || 'half') as RaceDistance;
  const abilityBand = getAbilityBand(baselineVdot);
  // The plan's taper (the split initializeWeeks builds for these weeks), so the
  // forecast's taper is the plan's (planTaperWeeks before the weeks exist).
  const taperWeeks = state.trainingForEvent === false
    ? (TAPER_NOMINAL[targetDistStr] ?? 2)
    : (planTaperWeeks({ tw: state.planDurationWeeks, rd: targetDistStr }) ?? TAPER_NOMINAL[targetDistStr] ?? 2);

  // Plan-prescribed mean weekly km. Sessions × ref-km × build-phase factor.
  // Represents what the periodised plan WILL deliver across its build phase,
  // not the user's pre-plan maintenance volume. When the caller threads
  // baseline + archetype through `rampCtx`, the function integrates over the
  // archetype-gated ramp instead of using the flat formula. See
  // getPlanPrescribedMeanWeeklyKm for the dual-mode logic.
  const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessionsPerWeek, targetDistStr, {
    baselineKm: rampCtx?.baselineKm,
    archetype: rampCtx?.archetype,
    totalWeeks: state.planDurationWeeks,
    taperWeeks,
  });

  const horizon = applyTrainingHorizonAdjustment({
    baseline_vdot: baselineVdot,
    target_distance: targetDistStr,
    weeks_remaining: state.planDurationWeeks,
    sessions_per_week: sessionsPerWeek,
    runner_type: runnerType,
    ability_band: abilityBand,
    taper_weeks: taperWeeks,
    experience_level: state.experienceLevel || 'intermediate',
    cross_trained: state.crossTrainedBackground === true,
    weekly_volume_km: planMeanKm ?? undefined,
    weekly_volume_hours: state.weeklyTrainingHours,
    hm_pb_seconds: state.pbs.h,
    strength_sessions_per_week: state.gymSessionsPerWeek,
  });

  const forecastVdot = baselineVdot + horizon.vdot_gain;
  const raceDistKm = rdKm(targetDistStr);
  const bareForecastTime = tv(forecastVdot, raceDistKm);

  let forecastTime: number;
  if (blendedAnchorSec != null && blendedAnchorSec > 0) {
    const bareToday = tv(baselineVdot, raceDistKm);
    const horizonDeltaSec = bareToday - bareForecastTime;
    forecastTime = blendedAnchorSec - horizonDeltaSec;
  } else {
    forecastTime = bareForecastTime;
  }

  return { forecastVdot, forecastTime };
}

export interface LiveForecastParams {
  currentVdot: number;
  targetDistance: RaceDistance;
  weeksRemaining: number;
  sessionsPerWeek: number;
  runnerType: RunnerType;
  experienceLevel?: string;
  /** Athlete is fit from non-running aerobic sport — applies the cross-trained
   *  forecast premium. Sourced from `s.onboarding?.crossTrainedBackground`. */
  crossTrained?: boolean;
  /** History-derived weekly running km. Primary dose signal for the horizon. */
  weeklyVolumeKm?: number;
  /** User-stated weekly training hours (onboarding). Fallback when km is zero. */
  weeklyVolumeHours?: number;
  hmPbSeconds?: number;
  ltPaceSecPerKm?: number;
  /** Planned strength sessions per week (s.gs). Future-projection economy gain. */
  strengthSessionsPerWeek?: number;
  adaptationRatio?: number;
  /**
   * Today's race time as predicted by `blendPredictions` at the target distance.
   * When supplied, the forecast is anchored to this time and the horizon model's
   * gain is applied as a delta on top, keeping the forecast on the same scale as
   * the "Current Race Estimate" surfaces. When omitted, the forecast falls back
   * to bare `tv(currentVdot+gain, dist)` (legacy behaviour). Only safe when the
   * caller knows `currentVdot` is already the blended-equivalent VDOT and the
   * downstream display does not compare against a blended baseline.
   */
  blendedAnchorSec?: number;
  /**
   * Race-day durability multiplier (>= 1) from the long runs the plan prescribes
   * (`raceDayDurabilityMultiplier`, src/calculations/race-day-durability.ts). The
   * forecast is end-of-plan fitness on the assumption that the plan is followed,
   * so durability is judged on the plan's own long runs. Every running forecast
   * caller passes it. Omitted = 1 (no running race plan).
   */
  raceDayDurabilityMultiplier?: number;
  /** The plan's race-taper weeks (planTaperWeeks). Omitted = TAPER_NOMINAL. */
  taperWeeks?: number;
  /** Race-day course profile (climate/altitude/elevation). When supplied,
   * the result includes `forecastTimeAdjusted` + `courseFactors`. */
  courseProfile?: import('@/types/onboarding').CourseProfile;
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
    taper_weeks: p.taperWeeks ?? TAPER_NOMINAL[p.targetDistance] ?? Math.max(1, Math.ceil(wr * 0.15)),
    experience_level: p.experienceLevel || 'intermediate',
    cross_trained: p.crossTrained === true,
    weekly_volume_km: p.weeklyVolumeKm,
    weekly_volume_hours: p.weeklyVolumeHours,
    hm_pb_seconds: p.hmPbSeconds,
    lt_pace_sec_per_km: p.ltPaceSecPerKm,
    strength_sessions_per_week: p.strengthSessionsPerWeek,
  });

  let adjustedGain = horizon.vdot_gain;
  if (p.adaptationRatio && p.adaptationRatio !== 1.0) {
    adjustedGain *= p.adaptationRatio;
  }

  const forecastVdot = p.currentVdot + adjustedGain;
  const raceDistKm = rdKm(p.targetDistance);
  const bareForecastTime = tv(forecastVdot, raceDistKm);

  // Anchor to the blended view of today's fitness when supplied. The horizon
  // model's predicted gain is converted from VDOT delta to a seconds delta via
  // Daniels' table on both ends, then subtracted from the blended anchor. This
  // keeps "Forecast finish" and "Current Race Estimate" on the same scale, so
  // the projected end-of-plan time is always anchored to whatever blendPredictions
  // says the athlete can run today, not to bare tv(currentVdot, dist).
  let forecastTime: number;
  if (p.blendedAnchorSec != null && p.blendedAnchorSec > 0) {
    const bareToday = tv(p.currentVdot, raceDistKm);
    const horizonDeltaSec = bareToday - bareForecastTime;
    forecastTime = p.blendedAnchorSec - horizonDeltaSec;
  } else {
    forecastTime = bareForecastTime;
  }

  // Long-run durability on race day, from the plan's prescribed long runs.
  const durabilityMult = p.raceDayDurabilityMultiplier;
  if (durabilityMult != null && Number.isFinite(durabilityMult) && durabilityMult > 1) {
    forecastTime *= durabilityMult;
  }

  if (p.courseProfile) {
    const adj = applyRunningCourseFactors(forecastTime, p.courseProfile, raceDistKm);
    return {
      forecastVdot,
      forecastTime,
      forecastTimeAdjusted: adj.adjustedSec,
      courseFactors: adj.factors,
    };
  }

  return { forecastVdot, forecastTime };
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
 * Cross-training offset (2026-06-15): the discount assumes the watch markers
 * are stale because the athlete stopped *aerobic* training. That assumption is
 * wrong for a heavy cross-trainer — cycling/rowing/swimming maintain VO2max and
 * LT (central cardiovascular adaptations transfer across modalities; Mujika &
 * Padilla 2000, Bassett & Howley 2000), so the markers are genuinely current.
 * We therefore soften the discount in proportion to aerobic cross-training, but
 * ONLY for sub-marathon targets (see SCIENCE_LOG §BV cross-training): running
 * economy and neuromuscular specificity do NOT transfer and still degrade, and
 * the marathon is set by run-specific fractional utilization + durability, which
 * cross-training cannot substitute. The caller already gates this to
 * targetDist !== 42195, but the cap is bounded so it can never fully erase the
 * discount even for a short race (the residual is un-maintained economy).
 *
 * @param weeklyRunKm  4-week running-km average; undefined = no adjustment
 * @param crossSessions  effective aerobic cross-training sessions/week
 *   (intensity-weighted, the same `effectiveCrossSessions` the plan uses).
 * @returns multiplier in [0, 1] applied to LT + VO2 weights; complement
 *          shifts onto PB (the peak-fitness anchor).
 */
// Cross-training can offset at most 60% of the low-running discount. Running
// economy explains ~30-40% of distance-running performance at a given VO2max
// (Conley & Krahenbuhl 1980; Saunders 2004) and does NOT transfer from cycling/
// rowing, so ~40% of the discount must remain.
export const CROSS_MAINTENANCE_CAP = 0.6;
// Full aerobic maintenance is reached at ~3 effective aerobic sessions/week —
// the established minimum to MAINTAIN VO2max during reduced running (Hickson
// 1985; Mujika & Padilla 2000). Linear ramp to the cap → 0.2 per session.
export const CROSS_MAINTENANCE_PER_SESSION = CROSS_MAINTENANCE_CAP / 3;

function lowVolumeDiscount(targetDist: number, weeklyRunKm?: number, crossSessions?: number): number {
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

  // Cross-training keeps the aerobic markers current → soften the severity.
  if (crossSessions && crossSessions > 0 && severity > 0) {
    const maintenance = Math.min(CROSS_MAINTENANCE_CAP, crossSessions * CROSS_MAINTENANCE_PER_SESSION);
    severity *= (1 - maintenance);
  }

  return 1 - severity * distSensitivity;
}

/**
 * How much aerobic cross-training is currently improving a sub-marathon
 * prediction, as a fractional speed credit (0 when none). Drives the
 * cross-training recognition copy so the note reflects the REAL effect rather
 * than a guess: it is exactly the difference the `crossSessions` argument makes
 * to `lowVolumeDiscount`. Returns 0 for the marathon (the offset never applies
 * there — running-specific endurance does not transfer; the long-run guard is
 * held) and 0 when running volume is high enough that no discount fires.
 */
export function crossTrainingPredictionCredit(
  targetDist: number,
  weeklyRunKm?: number,
  crossSessions?: number,
): number {
  if (!crossSessions || crossSessions <= 0) return 0;
  if (targetDist >= 42195) return 0;
  const withCross = lowVolumeDiscount(targetDist, weeklyRunKm, crossSessions);
  const withoutCross = lowVolumeDiscount(targetDist, weeklyRunKm, 0);
  // Both are multipliers ≤ 1 (a penalty). Cross-training raises the multiplier
  // toward 1, so the delta is the fraction of finish time it gives back.
  return Math.max(0, withCross - withoutCross);
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
  /**
   * Age (in days) of the activity that produced the marathon PB. When supplied
   * and the marathon-specificity penalty fires (Tanda gated out, low recent
   * volume), the penalty severity scales with PB recency: a recent PB is
   * *demonstrated current capability*, so the penalty (which assumes PB might
   * be stale) is reduced. Bands: <365d → ×0.5, 365-730d → ×0.75, >730d → full.
   */
  marathonPbAgeDays?: number,
  /**
   * True when `weeklyRunKm` was estimated from runs/week rather than measured
   * (synced history or a user-typed weekly km). Estimated volume still sizes the
   * marathon-specificity penalty, but it must not let the demonstrated-PB floor
   * stand down — an assumption may not override a proven same-distance time.
   */
  weeklyRunKmIsEstimate?: boolean,
  /**
   * Effective aerobic cross-training sessions/week (intensity-weighted; the
   * same `effectiveCrossSessions` the plan computes). Softens the short-distance
   * low-volume discount only — never the marathon penalty or durability cap, as
   * running economy and run-specific endurance do not transfer. See
   * lowVolumeDiscount.
   */
  crossTrainingSessions?: number,
  /**
   * Age weight of each PB (`pbAgeWeight`, physiological-vdot.ts; SCIENCE_LOG §T5
   * bands: up to 2 years 1.0, 2 to 4 years 0.6, over 4 years 0.3). Callers pass
   * it only when they hold current running data (a measured weekly volume), so
   * with no data an old PB keeps full weight (§BV). It scales the PB
   * predictor's weight (the anchor PB's age; the other predictors renormalise
   * in proportion) and stands the same-distance PB floor down for a PB older
   * than two years (demonstratedPBFloor). Stored and displayed PBs never change.
   */
  pbAgeWeights?: PbAgeWeights,
): number | null {
  // Base weights: Prioritize CURRENT fitness indicators
  const hasRecent = recentRun && recentRun.t > 0;

  // HR-calibrated VDOT (Swain regression across 8w of HR-tagged runs).
  // Treated as a separate predictor alongside LT/VO2 because it uses a
  // different physiological signal (steady-state effort response) and is
  // thus a valuable independent input in the weighted mean. Not a
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
    const watchTrust = lowVolumeDiscount(targetDist, weeklyRunKm, crossTrainingSessions);
    if (watchTrust < 1.0 && tPB != null) {
      const ltShed = w.lt * (1 - watchTrust);
      const vo2Shed = w.vo2 * (1 - watchTrust);
      w.lt = w.lt * watchTrust;
      w.vo2 = w.vo2 * watchTrust;
      w.pb = w.pb + ltShed + vo2Shed;
    }
  }

  // If Tanda unavailable (missing inputs, out-of-range, or non-marathon),
  // redistribute its weight onto LT. The next-best fitness-ceiling predictor.
  if (w.tanda != null && tTanda == null) {
    w.lt = w.lt + w.tanda;
    w.tanda = 0;
  }

  // PB age (2026-10-09). An old PB speaks less for current capacity: scale the
  // PB predictor's weight by the anchor PB's age weight, applied after every
  // other redistribution so it acts on the PB's final share. The shed weight is
  // not handed to one predictor: the weighted mean renormalises over the rest
  // in proportion. (LT, the usual destination of a shed, is often derived from
  // the same PBs through critical speed or the PB-median Daniels input, and
  // would hand the PB its weight back.)
  if (pbAgeWeights && tPB != null) {
    const anchor = pbAnchor(targetDist, pbs);
    const ageW = anchor ? (pbAgeWeights[anchor.key] ?? 1) : 1;
    if (ageW < 1) w.pb = w.pb * ageW;
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

  // Marathon-specificity correction: when Tanda is gated out at marathon target,
  // the remaining signals (PB, LT, VO2, HR) all over-predict marathon time for
  // low-volume athletes. Tanda is the ONLY marathon-distance-specific predictor
  // in the blend (P+K from recent training → finish time, Tanda 2011 r=0.91 vs
  // 46 marathoners). Without it, the prediction is "what your fitness CEILING
  // could deliver", not "what your specific endurance will deliver TODAY".
  //
  // Decay rationale: marathon time = VO2max × fractional utilization × running
  // economy (Joyner & Coyle 2008). Fractional utilization is the marathon-
  // critical term and decays fastest with low running volume (Coyle 1984;
  // Mujika & Padilla 2000). VO2max can stay elevated from cross-training;
  // fractional utilization at marathon distance is purely run-specific. So an
  // athlete with a strong PB but low recent running volume will see their
  // PB/LT/VO2-derived prediction over-state their *current* marathon fitness
  // even though those signals are individually accurate.
  //
  // Penalty bands tuned to land predictions within ±5% of empirical reality
  // for cross-trained returning athletes (calibrated against Tanda 2011's
  // residual analysis at the low-volume end).
  // ── Marathon-specificity penalty (inline, retained as-is) ──────────────
  // PARALLEL IMPLEMENTATION NOTICE (2026-05-06):
  // A unified per-discipline race-readiness framework now exists at
  // `src/calculations/specific-endurance-penalty.ts`, used by triathlon to
  // penalise predictions for low-volume athletes across swim/bike/run.
  //
  // We deliberately do NOT call the unified framework from here. The two
  // models measure conceptually different things:
  //   - This inline code: detraining-decay thresholds per Coyle 1984 +
  //     Mujika 2000. "Have you fallen below the maintenance volume that
  //     prevents specific-endurance decay?" Threshold: 30 km/wk.
  //   - Unified framework: training-volume targets per Friel 2018 IM/70.3
  //     plans. "Have you met the volume an intermediate plan prescribes?"
  //     Target: 65 km/wk for marathon.
  //
  // Both are scientifically valid; they answer different coaching questions.
  // The unified framework is currently used by triathlon predictions only.
  // A future refactor could merge them, but that's a calibration call (not
  // a clean replacement). Would require choosing which conceptual basis
  // wins, and may shift existing marathon predictions. Out of scope for
  // the 2026-05-06 unified-framework work.
  let marathonSpecificityPenalty = 1.0;
  // Only fire when we have an explicit volume signal. `weeklyRunKm == null`
  // means "no signal" (don't change behaviour), `weeklyRunKm === 0` means
  // "explicitly zero recent training" (penalty fires at max). Callers must
  // pass the actual zero rather than converting it to undefined.
  if (targetDist === 42195 && tTanda == null && weeklyRunKm != null) {
    if (weeklyRunKm < 10)      marathonSpecificityPenalty = 1.15;
    else if (weeklyRunKm < 20) marathonSpecificityPenalty = 1.10;
    else if (weeklyRunKm < 30) marathonSpecificityPenalty = 1.05;
    // ≥30 km/wk: even without Tanda firing, fractional utilization decay risk
    // is minimal (Coyle 1984 shows preserved marathon performance at ≥30 mi/wk
    // maintenance volume).

    // PB-recency scaling: a recent marathon PB is demonstrated current
    // capability, so the staleness assumption baked into the penalty (Coyle
    // 1984's full-detraining curves) over-corrects. Scale the penalty's
    // *excess* (the part above 1.0) by a recency factor. This keeps the
    // direction right while reducing magnitude for athletes who have proven
    // recent capability. Step bands at 1y / 2y boundaries.
    let recencyFactor = 1.0;
    if (marathonSpecificityPenalty > 1.0 && marathonPbAgeDays != null) {
      if (marathonPbAgeDays < 365)      recencyFactor = 0.5;   // PB within last year. Demonstrated current capability
      else if (marathonPbAgeDays < 730) recencyFactor = 0.75;  // PB 1-2 years. Partial demonstration
      // >2 years: full penalty (recencyFactor stays at 1.0)
    }
    if (recencyFactor < 1.0) {
      const excess = marathonSpecificityPenalty - 1.0;
      marathonSpecificityPenalty = 1.0 + excess * recencyFactor;
    }

    if (marathonSpecificityPenalty > 1.0) {
      console.log(`[blendPredictions] marathon-specificity penalty fired: weeklyKm=${weeklyRunKm.toFixed(1)}, pbAgeDays=${marathonPbAgeDays ?? 'unknown'}, recencyFactor=${recencyFactor.toFixed(2)} → penalty ${marathonSpecificityPenalty.toFixed(3)}× (Tanda gated out)`);
    }
  }

  // ── No-long-race-PB uncertainty penalty (2026-05-12 audit, ISSUE-145) ──
  //
  // Cold-start onboarding case: a runner with 5K/10K PBs but no half-marathon
  // or marathon time has demonstrated VO2max/LT capacity but NOT fractional
  // utilization at marathon distance. Florence & Weir (1997) showed critical
  // velocity over-predicts first-marathon by 8-12%; Vickers & Vertosick (2016)
  // showed Riegel under-predicts marathon by 3-7% when the anchor is ≤10K and
  // recent long-run mileage is low; Foster et al. (1994) and Siler & Martin
  // (1991) document the same pattern for speed-dominant athletes specifically.
  //
  // This penalty is multiplicative on the final blended prediction. It is
  // INDEPENDENT of `marathonSpecificityPenalty` above. The two penalties fire
  // on disjoint conditions:
  //   - marathonSpecificityPenalty: weeklyRunKm signal exists AND volume is low
  //   - this penalty: no long-race PB exists (cold-start / first marathoner)
  // Both can fire simultaneously (worst case: stack multiplicatively). Tanda
  // gating: if Tanda is producing a prediction, it already captures marathon-
  // specific endurance from training data, so skip this penalty.
  //
  // Magnitude calibrated to land speed-profile first-marathoners in the
  // empirically-observed 2:55-3:10 range for a sub-18 5K runner (rather than
  // the 2:48-2:51 the bare LT/PB blend produces). SCIENCE_LOG.md audit #11.
  let noLongRacePenalty = 1.0;
  if (targetDist === 42195
      && tTanda == null
      && pbs.h == null
      && pbs.m == null) {
    const rt = (runnerType || '').toLowerCase();
    if (rt === 'speed')           noLongRacePenalty = 1.02; // +2%
    else if (rt === 'endurance')  noLongRacePenalty = 1.00; // endurance profile already favours marathon
    else                          noLongRacePenalty = 1.01; // balanced / unknown: +1%
  }

  if (noLongRacePenalty > 1.0) {
    console.log(`[blendPredictions] no-long-race-PB penalty fired: runnerType=${runnerType}, hasHmPb=${pbs.h != null}, hasMPb=${pbs.m != null}, tTanda=${tTanda != null} → penalty ${noLongRacePenalty.toFixed(3)}× (no demonstrated marathon endurance)`);
  }

  const penalised = (sum / totW) * marathonSpecificityPenalty * noLongRacePenalty;

  // Never predict slower than a demonstrated same-distance PB without positive
  // detraining evidence. See demonstratedPBFloor for the full rationale.
  const result = demonstratedPBFloor(penalised, targetDist, pbs, { weeklyRunKm, weeklyRunKmIsEstimate, recentRun, b, pbAgeWeights });
  if (result !== penalised) {
    console.log(`[blendPredictions] demonstrated-PB floor: penalised blend ${penalised.toFixed(0)}s slower than same-distance PB ${result.toFixed(0)}s with no detraining evidence → floored to PB`);
  }

  return result;
}
