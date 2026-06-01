/**
 * Monte Carlo forecast simulator. Running race mode.
 *
 * Runs N trials of the next training block, varying three sources of
 * uncertainty around the deterministic training-horizon mean:
 *
 *   1. VDOT improvement. Sampled around horizon's `improvement_pct`
 *                              with relative sigma 0.35 (training response
 *                              is inherently noisy; Joyner & Coyle 2008,
 *                              Bouchard 2011 individual variance).
 *   2. Adherence. Clipped normal on [0.5, 1.0], mean 0.92,
 *                              sigma 0.10. Caps how much of the predicted
 *                              gain the athlete actually realises.
 *   3. Race-day form factor. N(1.0, 0.025) on pace, clipped to ±7%.
 *                              Weather, fuelling, gut, taper landing.
 *
 * Each trial produces a per-week race-time projection plus a race-day
 * outcome with the form multiplier applied. Percentiles (p10/p25/p50/
 * p75/p90) are computed across trials per week, ready for a fan-chart.
 *
 * The simulator is seeded (RNG = mulberry32(42 + currentWeek)) so the
 * displayed cone is stable across renders within the same plan week —
 * users don't see "the chart re-rolling" on every tab visit.
 *
 * Returns null when there isn't enough state to simulate (no race
 * distance, no VDOT, no plan weeks remaining).
 */

import type { SimulatorState, RaceDistance, AbilityBand, RunnerType } from '@/types';
import { applyTrainingHorizonAdjustment, getPlanPrescribedMeanWeeklyKm } from './training-horizon';
import { vt, rdKm } from './vdot';
import { getAbilityBand } from './fatigue';

export interface ForecastSimWeek {
  week: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface ForecastSimResult {
  /** Includes the current week (band starts here) through the race week. */
  weeks: ForecastSimWeek[];
  raceDay: { p10: number; p25: number; p50: number; p75: number; p90: number };
  trialCount: number;
  /** Probability the trial finishes ≤ goal; null if no goal set. */
  goalProbability: number | null;
  /** Caller's canonical point estimate (`s.forecastTimeAdjusted`) for cross-checking. */
  pointEstimate: number;
}

// ── RNG (seeded for stable display) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(rng: () => number, mean: number, sd: number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function smoothstep(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p * p * (3 - 2 * p);
}

// ── Simulator ────────────────────────────────────────────────────────────────

/**
 * @param goalSec  Optional user-set goal time in seconds. When provided,
 *                 `goalProbability` is computed as P(race-day trial ≤ goalSec).
 *                 When null/0, `goalProbability` is null in the result.
 *                 NOTE: never derive this from `s.initialBaseline`. That's the
 *                 model's initial prediction, not a user-set goal.
 */
export function runMarathonForecastSim(
  s: SimulatorState,
  trialCount: number = 2000,
  goalSec: number | null = null,
  // Explicit race-day anchor for "what-if" scenarios (e.g. the goal overlay
  // showing the chance with N extra sessions/week). When provided, the cone
  // centres on THIS forecast instead of the stored `s.forecastTime`, so the
  // simulated chance and the caller's displayed forecast move together. The
  // caller passes the forecast it computed for the hypothetical session count.
  forecastOverrideSec: number | null = null,
): ForecastSimResult | null {
  if (!s.rd) return null;
  const currentVdot = s.blendedEffectiveVdot ?? s.v;
  if (!currentVdot || currentVdot <= 0) return null;

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));
  const weeksRemaining = Math.max(0, totalWeeks - currentWeek);
  const distKm = rdKm(s.rd as RaceDistance);

  // Deterministic mean improvement from the training-horizon model.
  // Mirror the Training chip in race-forecast-fingerprint.ts: include
  // commute days in the session count, and derive weekly volume from the
  // plan-prescribed dose. Previously this read raw `s.epw ?? s.rw` (which
  // excludes commute) and `s.wkm` (a stale heuristic from onboarding's
  // runsPerWeek), so the math ran on fewer sessions and less volume than
  // the chip displayed. Producing systematically pessimistic forecasts
  // for commute-aware athletes.
  const baseSessions = s.epw ?? s.rw ?? 3;
  const commuteSessions = s.commuteConfig?.enabled
    ? (s.commuteConfig.commuteDaysPerWeek ?? 0)
    : 0;
  const sessions = baseSessions + commuteSessions;
  const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessions, s.rd as RaceDistance, {
    baselineKm: s.detectedWeeklyKm,
    archetype: s.athleteArchetype?.archetype,
    totalWeeks,
    taperWeeks: (s.rd as RaceDistance) === 'marathon' ? 3 : 2,
  }) ?? s.wkm;
  const abilityBand: AbilityBand = getAbilityBand(currentVdot);
  const runnerType: RunnerType = (s.typ ?? 'Balanced') as RunnerType;

  const horizon = applyTrainingHorizonAdjustment({
    baseline_vdot: currentVdot,
    target_distance: s.rd as RaceDistance,
    weeks_remaining: weeksRemaining,
    sessions_per_week: sessions,
    runner_type: runnerType,
    ability_band: abilityBand,
    experience_level: s.onboarding?.experienceLevel || 'intermediate',
    weekly_volume_km: planMeanKm,
    weekly_volume_hours: s.onboarding?.weeklyTrainingHours,
    hm_pb_seconds: s.pbs?.h || undefined,
    lt_pace_sec_per_km: s.lt || undefined,
  });

  // Apply the same adaptation-ratio multiplier the deterministic path uses.
  const adaptationMul = s.adaptationRatio && s.adaptationRatio > 0 ? s.adaptationRatio : 1.0;
  const meanImprovementPct = horizon.improvement_pct * adaptationMul;

  // Sigma: 50% relative on the improvement (Bouchard 2011 individual variance is
  // ~30–40% on aerobic adaptation, plus injury/illness/life noise pushes the
  // real-world spread wider). Floor at 0.8 absolute pct so even small mean
  // improvements still produce a visible cone over the build.
  const sigmaImprovementPct = Math.max(0.8, Math.abs(meanImprovementPct) * 0.50);

  // Adherence model.
  const meanAdherence = 0.90;
  const sigmaAdherence = 0.12;

  // Race-day form factor. Pace multiplier. ±2.5% σ, clipped ±7%.
  const meanForm = 1.0;
  const sigmaForm = 0.025;

  const rng = mulberry32(42 + currentWeek);

  // **Median = headline by construction.**
  //
  // Earlier the sim tried to reconstruct calculateLiveForecast's anchoring
  // internally (blended-anchor minus bare-VDOT-delta). That broke because
  // the headline passes the *raw* blend as the anchor (pre-calibration,
  // pre-durability) while `s.blendedRaceTimeSec` is the *adjusted* blend
  // (post-calibration, post-durability). The two anchors differed by the
  // calibration + durability adjustments, leaving a 7–10 minute gap between
  // sim median and the displayed headline.
  //
  // The cleaner construction: don't reconstruct the headline. *Use* it
  // directly as the trajectory, then express each trial's deviation from
  // the median trial as a pure-VDOT seconds delta and add it.
  //
  //   trialWeekSec = headlineWeekSec + (trialBareWeekSec − medianBareWeekSec)
  //
  // - Median trial deviates by 0 → exactly the headline.
  // - Other trials deviate by their bare-VDOT spread, which preserves the
  //   variance widening as the cone moves toward race day.
  // - Form factor is symmetric around 1.0 so median × 1.0 = headline.
  // - Calibration / durability / course factors are all baked into the
  //   headline trajectory once. No need to apply them per trial.

  const bareTodaySec = vt(distKm, currentVdot);
  // Deterministic median trajectory. What the cone collapses to in the
  // absence of any sampled variance. Used as the reference for per-trial
  // deviation.
  const medianFinalVdot = currentVdot * (1 + meanImprovementPct / 100);
  const bareMedianFinalSec = vt(distKm, medianFinalVdot);

  // **Anchor the cone to the forecast the UI actually displays.**
  //
  // `forecastTimeAdjusted ?? forecastTime` is the canonical headline — it
  // already bakes in calibration bias, shoe boost, and course factors. The cone
  // MUST centre on it, otherwise "goal == forecast" doesn't read ~50%.
  // (A prior attempt recomputed the race-day anchor from the blend + the sim's
  // own horizon; that drifted ~2.5 min slower than the displayed forecast
  // because the recompute omitted calibration/shoe/course, so goal == forecast
  // read ~32%.)
  //
  // Fallback: when the stored forecast is missing OR slower than today (a stale
  // forecast left behind when today's blend was later refreshed faster — e.g.
  // PBs that outpace synced-run VDOT, which made the cone predict *regression*
  // and collapse the goal probability to <5%), derive race-day from today's
  // blend minus the horizon delta so the cone still slopes the right way.
  // Course factors are reapplied as a pure adjusted/raw ratio in that path.
  const headlineTodaySec = s.blendedRaceTimeSec ?? 0;
  const horizonDeltaSec = bareTodaySec - bareMedianFinalSec;
  const courseRatio = (s.forecastTime && s.forecastTimeAdjusted && s.forecastTime > 0)
    ? s.forecastTimeAdjusted / s.forecastTime
    : 1;
  const blendDerivedRaceDaySec = headlineTodaySec > 0
    ? (headlineTodaySec - horizonDeltaSec) * courseRatio
    : 0;
  const overrideProvided = forecastOverrideSec != null && forecastOverrideSec > 0;
  const displayedForecastSec = overrideProvided
    ? forecastOverrideSec
    : (s.forecastTimeAdjusted ?? s.forecastTime ?? 0);
  // Trust the displayed forecast when it represents improvement (≤ today + 1s
  // float margin). A forecast slower than today is the stale/divergent case.
  // An explicit override is always trusted — it is the caller's computed
  // forecast for the scenario being simulated.
  const forecastIsCoherent = displayedForecastSec > 0
    && (overrideProvided || headlineTodaySec <= 0 || displayedForecastSec <= headlineTodaySec + 1);
  const headlineRaceDaySec = forecastIsCoherent ? displayedForecastSec : blendDerivedRaceDaySec;
  const haveHeadlineAnchor = headlineRaceDaySec > 0;

  // Trial loop. trials[trialIdx][weekIdx] = race-time at that week (current..race).
  const trials: number[][] = [];
  for (let trial = 0; trial < trialCount; trial++) {
    const improvementPct = normalSample(rng, meanImprovementPct, sigmaImprovementPct);
    const adherence = clamp(normalSample(rng, meanAdherence, sigmaAdherence), 0.5, 1.0);
    const formFactor = clamp(normalSample(rng, meanForm, sigmaForm), 0.93, 1.07);

    // adherenceMul / meanAdherence pins E[multiplier] ≈ 1.0 so variance widens
    // the cone without shifting its centre.
    const adherenceMul = adherence / meanAdherence;
    const trialFinalVdot = currentVdot * (1 + (improvementPct / 100) * adherenceMul);
    const bareTrialFinalSec = vt(distKm, trialFinalVdot);

    const trialWeeks: number[] = [];
    const steps = weeksRemaining;
    // Form factor ramps in smoothly over the last 8 weeks so the cone widens
    // organically as race day approaches (taper landing, weather forecast,
    // fuelling, gut). Intensity 0 at >8 weeks out, 1 at race day.
    const FORM_RAMP_WEEKS = 8;
    for (let w = 0; w <= steps; w++) {
      const p = steps > 0 ? w / steps : 1;
      const shapedP = smoothstep(p);

      // Trial and median trajectories in bare-VDOT seconds. The difference
      // is the trial's deviation from the median trial at this week.
      const bareTrialWeekSec = bareTodaySec + (bareTrialFinalSec - bareTodaySec) * shapedP;
      const bareMedianWeekSec = bareTodaySec + (bareMedianFinalSec - bareTodaySec) * shapedP;
      const deviationSec = bareTrialWeekSec - bareMedianWeekSec;

      // Headline trajectory. Interpolated today → race-day in headline space.
      // Falls back to bare-VDOT when no headline is available (cold-start).
      const headlineWeekSec = haveHeadlineAnchor
        ? headlineTodaySec + (headlineRaceDaySec - headlineTodaySec) * shapedP
        : bareMedianWeekSec;

      // Apply form factor (symmetric, median = 1.0) as the final multiplier
      // so race-day execution variance grows independently of horizon spread.
      const weeksToRace = steps - w;
      const formIntensity = Math.max(0, Math.min(1, (FORM_RAMP_WEEKS - weeksToRace) / FORM_RAMP_WEEKS));
      const effectiveFormFactor = 1 + (formFactor - 1) * formIntensity;

      trialWeeks.push((headlineWeekSec + deviationSec) * effectiveFormFactor);
    }
    trials.push(trialWeeks);
  }

  // **Headline alignment.** The deterministic median trial equals the
  // headline by construction, but the *empirical* race-day median across
  // 2000 samples drifts ~10–40 s because formFactor at race day perturbs
  // each trial independently. Shift-align so the empirical race-day p50
  // lands exactly on the headline. Today (w=0) is unshifted; the shift
  // ramps in via the same smoothstep used for the deterministic trajectory,
  // preserving cone width.
  if (weeksRemaining > 0 && haveHeadlineAnchor) {
    const raceDayTimes = trials.map(t => t[weeksRemaining]).sort((a, b) => a - b);
    const empiricalMed = percentile(raceDayTimes, 0.50);
    const shiftAtRace = headlineRaceDaySec - empiricalMed;
    if (Math.abs(shiftAtRace) > 0.5) {
      for (const t of trials) {
        for (let w = 0; w <= weeksRemaining; w++) {
          const p = w / weeksRemaining;
          t[w] += shiftAtRace * smoothstep(p);
        }
      }
    }
  }

  // Percentiles per week.
  const weekResults: ForecastSimWeek[] = [];
  for (let w = 0; w <= weeksRemaining; w++) {
    const times = trials.map(t => t[w]).sort((a, b) => a - b);
    weekResults.push({
      week: currentWeek + w,
      p10: percentile(times, 0.10),
      p25: percentile(times, 0.25),
      p50: percentile(times, 0.50),
      p75: percentile(times, 0.75),
      p90: percentile(times, 0.90),
    });
  }

  const raceDay = weekResults[weekResults.length - 1];

  const goalProbability = goalSec && goalSec > 0
    ? trials.filter(t => t[weeksRemaining] <= goalSec).length / trialCount
    : null;

  const pointEstimate = s.forecastTimeAdjusted ?? s.forecastTime ?? s.blendedRaceTimeSec ?? 0;

  return {
    weeks: weekResults,
    raceDay: { p10: raceDay.p10, p25: raceDay.p25, p50: raceDay.p50, p75: raceDay.p75, p90: raceDay.p90 },
    trialCount,
    goalProbability,
    pointEstimate,
  };
}

function percentile(sortedAsc: number[], pct: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = pct * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}
