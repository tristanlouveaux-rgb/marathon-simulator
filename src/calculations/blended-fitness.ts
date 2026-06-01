/**
 * Blended fitness refresh. Single source of truth for the race-time prediction
 * that drives the stats view, onboarding summary, and (Step 6) plan-engine
 * pace derivation.
 *
 * Invocation points:
 *   1. End of onboarding, after `backfillStravaHistory` returns per-run data.
 *   2. Weekly rollover (`next()` in `events.ts`) after auto-LT update.
 *
 * Writes `s.blendedRaceTimeSec`, `s.blendedEffectiveVdot`,
 * `s.blendedLastRefreshedISO`. Reads are O(1) everywhere else. No component
 * re-runs the blend on render.
 */

import type { SimulatorState, RaceDistance } from '@/types';
import { blendPredictions, calculateLiveForecast } from './predictions';
import { getPlanPrescribedMeanWeeklyKm } from './training-horizon';
import { computePredictionInputs, type RunActivityInput } from './prediction-inputs';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import { cv, tv, rdKm } from './vdot';
import { recomputeLT } from '@/data/ltSync';
import { computeRunCalibration, applyRunCalibrationBias } from './run-calibration';
import { getLongestRunSec, applyLongRunCap, type RunDurabilityResult } from './run-durability';
import { effectiveVo2max } from './physiological-vdot';
import { getDisciplineCapacity } from '@/injury/engine';
import { injuryAdjustedBuildWeeks } from './injury-recovery';

const DIST_M: Record<RaceDistance, number> = {
  '5k': 5000,
  '10k': 10000,
  'half': 21097,
  'marathon': 42195,
};

/**
 * Assemble `RunActivityInput[]` from whichever sources are available in the
 * current state. Preference order:
 *   - `s.wks[].garminActuals` (live sync. Authoritative for returning users)
 *   - `s.onboardingRunHistory` (seeded by backfill response. First-session data)
 * Both may coexist for a user mid-onboarding; we merge and let the dedup in
 * `computePredictionInputs` collapse overlaps.
 */
export function collectRunsFromState(s: SimulatorState): RunActivityInput[] {
  const runs: RunActivityInput[] = [];
  const weeks = s.wks ?? [];
  for (const wk of weeks) {
    const actuals = (wk as { garminActuals?: Record<string, unknown> }).garminActuals;
    if (!actuals) continue;
    for (const val of Object.values(actuals)) {
      const a = val as {
        activityType?: string; startTime?: string; distanceKm?: number; durationSec?: number;
        activityName?: string; avgHR?: number | null; hrDrift?: number | null;
      };
      const aType = (a.activityType || '').toUpperCase();
      if (aType !== 'RUNNING' && !aType.includes('RUN')) continue;
      if (!a.startTime || !a.distanceKm || !a.durationSec) continue;
      runs.push({
        startTime: a.startTime,
        distKm: a.distanceKm,
        durSec: a.durationSec,
        activityName: a.activityName,
        activityType: a.activityType,
        avgHR: a.avgHR ?? null,
        hrDrift: a.hrDrift ?? null,
      });
    }
  }
  if (s.onboardingRunHistory && s.onboardingRunHistory.length > 0) {
    for (const r of s.onboardingRunHistory) runs.push(r);
  }
  return runs;
}

const STANDARD_DISTANCES: RaceDistance[] = ['5k', '10k', 'half', 'marathon'];

/**
 * Predict finish time at every standard race distance (5K / 10K / half /
 * marathon) from current fitness, independent of any target race. Used by the
 * "just training" forecast view, where the user has no goal event but still
 * wants to see what they could run today.
 *
 * Each distance runs the SAME pipeline as the targeted `refreshBlendedFitness`
 * blend — calibration bias, then long-run durability cap, then the carbon-shoe
 * boost — so a distance shown here matches what the targeted forecast would
 * show if that distance were the goal (CLAUDE.md: two numbers that mean the
 * same thing come from the same source). Returns null for a distance the blend
 * cannot estimate (no usable signal), so the caller can render an empty tile.
 *
 * Read-only: computes from state but writes nothing back. Safe to call on every
 * render.
 */
export function predictStandardDistances(s: SimulatorState): Record<RaceDistance, number | null> {
  const empty: Record<RaceDistance, number | null> = { '5k': null, '10k': null, 'half': null, 'marathon': null };
  if (!s.pbs || !s.b) return empty;
  // Just-Track users without PBs have {} for s.pbs and the default s.b — no
  // real signal to blend. Mirror the guard in refreshBlendedFitness.
  if (s.trackOnly && Object.keys(s.pbs).length === 0) return empty;

  const runs = collectRunsFromState(s);
  const inputs = computePredictionInputs(runs);
  const hrVdot = computeHRCalibratedVdot(runs, s.restingHR ?? null, s.maxHR ?? null);
  const calibration = computeRunCalibration(s.runRaceLog);
  const longestRunSec = getLongestRunSec(s, 12);

  const marathonPbDateISO = s.onboarding?.pbDates?.m;
  const marathonPbAgeDays = marathonPbDateISO
    ? Math.max(0, Math.floor((Date.now() - new Date(marathonPbDateISO).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined;
  // Carbon-plated racing flats: flat 3% pace boost (Hoogkamer 2018). Mirrors
  // the targeted-forecast treatment so the toggle moves both views the same way.
  const shoeMul = s.shoeKind === 'supershoes' ? 0.97 : 1.0;

  const out: Record<RaceDistance, number | null> = { ...empty };
  for (const dist of STANDARD_DISTANCES) {
    const blended = blendPredictions(
      DIST_M[dist],
      s.pbs,
      s.lt ?? null,
      effectiveVo2max(s),
      s.b,
      (s.typ ?? 'Balanced').toLowerCase(),
      inputs.recentRun ?? s.rec ?? null,
      s.athleteTier ?? undefined,
      inputs.weeklyKm,
      inputs.avgPaceSecPerKm ?? undefined,
      { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
      hrVdot,
      marathonPbAgeDays,
    );
    if (!blended || blended <= 0 || !isFinite(blended)) { out[dist] = null; continue; }
    const calibrated = applyRunCalibrationBias(blended, dist, calibration);
    const durability = applyLongRunCap(longestRunSec, dist);
    out[dist] = calibrated * durability.multiplier * shoeMul;
  }
  return out;
}

/**
 * Append (or overwrite, dedup by week+date) a VDOT history point from the
 * current effective VDOT. Drives the VDOT sparkline and the standard-distance
 * forecast trend. Idempotent within a (week, date); keeps the last 20 points.
 * No-ops when there is no usable VDOT.
 */
export function recordVdotHistoryPoint(s: SimulatorState): void {
  if (!s.v || s.v <= 0) return;
  const effectiveVdot = s.v + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const weekNum = s.w ?? 1;
  const hist = s.vdotHistory ?? [];
  const existingIdx = hist.findIndex(h => h.week === weekNum && h.date === today);
  const entry = { week: weekNum, vdot: Math.round(effectiveVdot * 10) / 10, date: today };
  if (existingIdx >= 0) hist[existingIdx] = entry; else hist.push(entry);
  s.vdotHistory = hist.slice(-20);
}

export interface StandardForecastDetail {
  predictedSec: number | null;
  vdot: number | null;
  /** LT pace (sec/km) — the heaviest-weighted single predictor in the blend. */
  ltSecPerKm: number | null;
  weeklyKm: number | null;
  durabilityMultiplier: number;
  durabilityCapped: boolean;
  calibrationBiasSec: number | null;
  calibrationRaceCount: number;
  /** Predicted finish time at this distance per recorded week (raw VDOT-derived trajectory). */
  trend: { date: string; value: number }[];
}

/**
 * Per-distance detail for the no-target-race forecast drill-down. The headline
 * `predictedSec` comes from the same canonical `predictStandardDistances` blend
 * (so it equals the grid tile); the `trend` is the raw VDOT-derived trajectory
 * reconstructed from `vdotHistory` (faster = lower time), mirroring how the
 * targeted forecast chart shows fitness trajectory separately from the adjusted
 * headline. Read-only.
 */
export function getStandardForecastDetail(s: SimulatorState, dist: RaceDistance): StandardForecastDetail {
  const predictedSec = predictStandardDistances(s)[dist];

  const inputs = computePredictionInputs(collectRunsFromState(s));
  const weeklyKm = inputs.weeklyKm > 0 ? inputs.weeklyKm : (s.detectedWeeklyKm ?? null);

  const durability = applyLongRunCap(getLongestRunSec(s, 12), dist);

  const calibration = computeRunCalibration(s.runRaceLog);
  const bias = calibration.perDistanceBiasSec?.[dist];

  const distKm = rdKm(dist);
  const trend = (s.vdotHistory ?? [])
    .filter(h => h.vdot && h.vdot > 0 && h.date)
    .map(h => ({ date: h.date!, value: tv(h.vdot, distKm) }));

  return {
    predictedSec,
    vdot: s.v && s.v > 0 ? s.v : null,
    ltSecPerKm: s.lt && s.lt > 0 ? s.lt : null,
    weeklyKm,
    durabilityMultiplier: durability.multiplier,
    durabilityCapped: durability.multiplier > 1.0001,
    calibrationBiasSec: bias != null ? bias : null,
    calibrationRaceCount: calibration.basedOnRaceCount ?? 0,
    trend,
  };
}

/**
 * Recompute the blended race-time prediction for `s.rd` and cache it on state.
 * Idempotent. Safe to call any time. Does nothing and returns false if
 * required inputs are missing.
 */
export function refreshBlendedFitness(s: SimulatorState): boolean {
  // Compute + cache HR-calibrated VDOT first, independent of the full blend.
  // The onboarding review screen needs this even before race distance is set,
  // so we pre-cache before the early-return guards below. This write is
  // load-bearing for onboarding's fitness display. Main.ts always invokes
  // refreshBlendedFitness on launch, so the cache is never stale at runtime.
  const runsAll = collectRunsFromState(s);
  const hrVdot = computeHRCalibratedVdot(runsAll, s.restingHR ?? null, s.maxHR ?? null);
  s.hrCalibratedVdot = {
    vdot: hrVdot.vdot,
    confidence: hrVdot.confidence,
    n: hrVdot.n,
    r2: hrVdot.r2,
    reason: hrVdot.reason,
    alpha: hrVdot.alpha,
    beta: hrVdot.beta,
    points: hrVdot.points,
  };

  // Pre-blend reconciliation: when no race distance has been picked yet
  // (onboarding) and HR-calibrated confidence is medium+, write the value to
  // s.v so the rest of the app shows the same number as the review row.
  // Skip at low confidence. Too noisy to overwrite a PB-derived seed.
  // Once race distance is set, the post-guard blend below takes over and this
  // is overwritten with the full blended VDOT. Mid-plan we never hit this
  // branch because s.rd is set.
  if (!s.rd && hrVdot.vdot != null && (hrVdot.confidence === 'high' || hrVdot.confidence === 'medium')) {
    s.v = hrVdot.vdot;
  }

  // Recompute LT pace from PBs + maxHR + sustained Strava efforts, even if no
  // race distance is set yet. Daniels (from VDOT) and critical-speed (from PBs)
  // both fire without HR data, so a Strava-only user gets a usable s.lt
  // immediately on backfill. When Garmin LT later pushes via syncPhysiologySnapshot,
  // the priority chain in resolveLT() upgrades to it automatically.
  try {
    recomputeLT(s);
  } catch (e) {
    console.warn('[refreshBlendedFitness] recomputeLT failed:', e);
  }

  if (!s.rd || !s.pbs || !s.b) {
    // No target race (just-training): still record a VDOT history point so the
    // standard-distance forecast trend fills in over time. The full-blend path
    // below records its own point at the end, so only do it here when bailing
    // specifically for a missing race distance.
    if (!s.rd) recordVdotHistoryPoint(s);
    return false;
  }
  // Just-Track users without PBs have {} for s.pbs (truthy, slips past the
  // guard above) and the default s.b=1.06. blendPredictions would then clobber
  // s.v with a stale default. Bail instead.
  if (s.trackOnly && Object.keys(s.pbs).length === 0) return false;
  const targetDistM = DIST_M[s.rd];
  if (!targetDistM) return false;

  const runs = runsAll;
  const inputs = computePredictionInputs(runs);

  // Pass `inputs.weeklyKm` directly (including 0) so blendPredictions can
  // distinguish "explicit zero recent training" from "no volume signal at all".
  // The marathon-specificity penalty (Tanda-gated path) only fires when an
  // explicit signal is present, so passing the actual computed value (even 0)
  // is the right behaviour. A user with 145 historical runs but zero in the
  // 8-week window genuinely has zero recent training, which is signal, not noise.
  // Marathon PB age scales the penalty: recent PB → demonstrated capability →
  // lighter penalty.
  const marathonPbDateISO = s.onboarding?.pbDates?.m;
  const marathonPbAgeDays = marathonPbDateISO
    ? Math.max(0, Math.floor((Date.now() - new Date(marathonPbDateISO).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined;
  const blended = blendPredictions(
    targetDistM,
    s.pbs,
    s.lt ?? null,
    effectiveVo2max(s),
    s.b,
    (s.typ ?? 'Balanced').toLowerCase(),
    inputs.recentRun ?? s.rec ?? null,
    s.athleteTier ?? undefined,
    inputs.weeklyKm,
    inputs.avgPaceSecPerKm ?? undefined,
    { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
    hrVdot,
    marathonPbAgeDays,
  );

  if (!blended || blended <= 0 || !isFinite(blended)) return false;

  // Apply per-user calibration bias (tier 1: per-distance additive bias from
  // ≥2 logged races at the same distance). Computed fresh on every refresh
  // so newly logged races take effect immediately. Capped at ±8% of median
  // predicted to keep one outlier from skewing future predictions.
  const calibration = computeRunCalibration(s.runRaceLog);
  s.runCalibration = calibration;
  const calibratedBlend = applyRunCalibrationBias(blended, s.rd, calibration);

  // Long-run durability cap. Applies a multiplicative penalty when the
  // longest recent run is below the distance-specific threshold (orthogonal
  // to the volume-based marathon-specificity penalty inside blendPredictions
  //. Both can fire). Stored on state for the Durability chip drill-down.
  const longestRunSec = getLongestRunSec(s, 12);
  const durability: RunDurabilityResult = applyLongRunCap(longestRunSec, s.rd);
  s.runDurability = durability;
  const durabilityAdjustedBlend = calibratedBlend * durability.multiplier;

  s.blendedRaceTimeSec = durabilityAdjustedBlend;
  s.blendedEffectiveVdot = cv(targetDistM, durabilityAdjustedBlend);
  s.blendedLastRefreshedISO = new Date().toISOString();

  // Push the blended VDOT into s.v so plan generation and pace derivation
  // reflect reality, not the Week-1 linear projection. Exception: during taper
  // and deload weeks (both share `ph === 'taper'`), volume is deliberately cut
  //. Recomputing would read the reduction as detraining and pull predictions
  // slower, when the science says fitness is maintained (Mujika & Padilla 2000).
  // Hold s.v at its pre-taper value until we exit the low-volume phase.
  const currentWeek = (s.wks ?? [])[(s.w ?? 1) - 1];
  const inTaperOrDeload = currentWeek?.ph === 'taper';
  // During active injury where running is fully blocked (run capacity 0), the
  // PB/HR blend reflects pre-injury fitness. Writing it back would undo the
  // weekly VDOT decay applied by advanceWeekToToday. Allow it to write again
  // once the user returns to any running (capacity > 0). Reads capacity (not the
  // legacy canRun enum) so it stays correct with the per-discipline sliders.
  const injuryState = (s as any).injuryState;
  const injuryBlockingRun = injuryState?.active && getDisciplineCapacity(injuryState, 'run') === 0;
  if (!inTaperOrDeload && !injuryBlockingRun) {
    s.v = s.blendedEffectiveVdot;
  }

  // Recompute end-of-plan forecast from the fresh baseline so s.expectedFinal
  // tracks reality instead of being frozen at onboarding.
  const weeksRemaining = Math.max(1, (s.tw ?? 0) - ((s.w ?? 1) - 1));
  if (s.rd && s.typ && weeksRemaining > 0) {
    try {
      // Include commute days so the live forecast matches what the
      // Training chip on the forecast page displays. `s.epw` is built
      // from structured running + cross-training; commute runs are real
      // running stimulus and are added here per the chip-mirror rule.
      const baseSessions = s.epw ?? s.rw ?? 3;
      const commuteSessions = s.commuteConfig?.enabled
        ? (s.commuteConfig.commuteDaysPerWeek ?? 0)
        : 0;
      const sessionsForHorizon = baseSessions + commuteSessions;
      const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessionsForHorizon, s.rd, {
        baselineKm: s.detectedWeeklyKm,
        archetype: s.athleteArchetype?.archetype,
        totalWeeks: s.tw,
        taperWeeks: s.rd === 'marathon' ? 3 : 2,
      });
      // Injury-aware: build from the return date, not flat. A current run
      // restriction debits its recovery weeks so the forecast doesn't credit
      // build during weeks the athlete cannot run. Mirrors the tri predictor.
      const effectiveWeeksRemaining = injuryAdjustedBuildWeeks((s as any).injuryState, 'run', weeksRemaining);
      const { forecastVdot, forecastTime } = calculateLiveForecast({
        currentVdot: s.v,
        targetDistance: s.rd,
        weeksRemaining: effectiveWeeksRemaining,
        sessionsPerWeek: sessionsForHorizon,
        runnerType: s.typ as Parameters<typeof calculateLiveForecast>[0]['runnerType'],
        experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
        weeklyVolumeKm: planMeanKm ?? s.wkm,
        weeklyVolumeHours: s.onboarding?.weeklyTrainingHours,
        hmPbSeconds: s.pbs?.h || undefined,
        ltPaceSecPerKm: s.lt || undefined,
        adaptationRatio: s.adaptationRatio,
        blendedAnchorSec: blended,
      });
      s.expectedFinal = forecastVdot;
      // Calibration bias applies to the projection (systematic prediction
      // error doesn't disappear by race day). Durability cap does NOT —
      // the forecast represents end-of-plan fitness, which assumes the
      // plan delivers the required long runs before race day. Mirrors the
      // tri engine's "execution factor" treatment (race-prediction.triathlon).
      const calibrated = applyRunCalibrationBias(forecastTime, s.rd, calibration);
      // Race-day footwear boost. Carbon-plated racing flats (Vaporfly,
      // Alphafly, Adios Pro, Endorphin Elite) deliver ~3% running-economy
      // improvement at marathon pace (Hoogkamer 2018, mean 2.7–4.2%, taken
      // here as a flat 3%). Applied last so any downstream course-factors
      // pass picks up the boosted forecastTime and propagates it to
      // forecastTimeAdjusted automatically.
      const shoeMul = s.shoeKind === 'supershoes' ? 0.97 : 1.0;
      s.forecastTime = calibrated * shoeMul;
    } catch {
      // Leave expectedFinal untouched on any forecast failure.
    }
  }

  // Record a history entry so the VDOT sparkline shows the weekly refresh.
  // Dedup by (week, date). RefreshBlendedFitness can fire multiple times
  // per boot (app launch + onboarding + weekly rollover).
  recordVdotHistoryPoint(s);

  return true;
}
