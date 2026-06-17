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
import { blendPredictions, calculateLiveForecast, predictFromVO2, demonstratedPBFloor, predictFromRecent } from './predictions';
import { computePeakWeeklyKm } from '@/workouts/plan_engine';
import { getPlanPrescribedMeanWeeklyKm, applyTrainingHorizonAdjustment } from './training-horizon';
import { getAbilityBand } from './fatigue';
import type { RunnerType } from '@/types/training';
import { computePredictionInputs, resolveWeeklyKmSignal, type RunActivityInput } from './prediction-inputs';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import { cv, tv, rdKm } from './vdot';
import { recomputeLT } from '@/data/ltSync';
import { computeRunCalibration, applyRunCalibrationBias } from './run-calibration';
import { getLongestRunSec, applyLongRunCap, type RunDurabilityResult } from './run-durability';
import { effectiveVo2max, resolveRunningVdot, hasRunningFitnessSignal, pbDerivedVdot, raceAnchorVdot } from './physiological-vdot';
import { estimateRunPaceFromSkill } from './race-prediction.triathlon';
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
/**
 * Shared inputs for a standard-distance prediction, built once from state so
 * the grid (all four distances) and a single drill-down compute from exactly
 * the same signal. Null when there is no usable blend signal at all.
 */
type BlendArgs = Parameters<typeof blendPredictions>;
interface StandardPredictionContext {
  pbs: BlendArgs[1];
  lt: BlendArgs[2];
  vo2: BlendArgs[3];
  b: BlendArgs[4];
  typ: BlendArgs[5];
  recentRun: BlendArgs[6];
  athleteTier: BlendArgs[7];
  weeklyKm: BlendArgs[8];
  avgPaceSecPerKm: BlendArgs[9];
  quality: BlendArgs[10];
  hrVdot: BlendArgs[11];
  marathonPbAgeDays: BlendArgs[12];
  weeklyKmIsEstimate: BlendArgs[13];
  crossTrainingSessions: BlendArgs[14];
  calibration: ReturnType<typeof computeRunCalibration>;
  longestRunSec: number;
  shoeMul: number;
  /**
   * Resolved running-fitness VDOT (`resolveRunningVdot`). Used as a last-resort
   * predictor when the weighted blend produces nothing (e.g. a training-only
   * athlete with a VDOT but no PBs, LT, device VO2, or recent runs to blend).
   * Fed through the same Daniels `predictFromVO2` model the blend's VO2 slot
   * uses, so the Forecast can show whenever the Stats VO2 bar shows. Always
   * present when the context is built (the build gate requires a usable VDOT).
   */
  fallbackVdot: number | null;
}

/** Ordered stages of a single standard-distance prediction. `finalSec` equals
 *  the grid tile / hero (same computation), so a waterfall built from these
 *  reconciles to the headline by construction. */
export interface StandardPredictionStages {
  /** Capacity blend (VDOT / LT / PB / recent-run), before any adjustment. */
  blendedSec: number;
  /** After per-distance calibration bias from logged races. */
  calibratedSec: number;
  /** Long-run durability multiplier (≥ 1.0). */
  durability: RunDurabilityResult;
  /** Carbon-shoe multiplier (0.97 = supershoes, 1.0 = standard). */
  shoeMul: number;
  /** Final adjusted finish: calibratedSec × durability × shoeMul. */
  finalSec: number;
}

function buildStandardPredictionContext(s: SimulatorState): StandardPredictionContext | null {
  // Canonical gate: build a context iff there is a usable running-fitness VDOT.
  // This is the SAME predicate the Stats "VO2 Max" bar gates on, so the two
  // surfaces can never disagree about whether the athlete has data. The old gate
  // keyed on PBs (`!s.pbs` / trackOnly-without-PBs), which blocked exactly the
  // training-only athletes the no-target-race Forecast was built for even when
  // they had a real VDOT. The `fallbackVdot` below lets the blend predict from
  // that VDOT alone (Daniels model) when no PB/LT/recent/device signal exists.
  if (!hasRunningFitnessSignal(s)) return null;

  const runs = collectRunsFromState(s);
  const inputs = computePredictionInputs(runs);
  const marathonPbDateISO = s.onboarding?.pbDates?.m;
  return {
    pbs: s.pbs ?? {},
    lt: s.lt ?? null,
    vo2: effectiveVo2max(s),
    b: s.b ?? 0,
    typ: (s.typ ?? 'Balanced').toLowerCase(),
    recentRun: inputs.recentRun ?? s.rec ?? null,
    athleteTier: s.athleteTier ?? undefined,
    // Best-available volume signal with provenance — MUST mirror initialization.ts
    // so the post-onboarding refresh doesn't re-break the no-data fix. MEASURED =
    // synced history (weeksCovered>0) or a typed weekly km. Otherwise ESTIMATE from
    // runs/week (same `freqVolumeEstimate` family the plan uses), which sizes the
    // soft penalty but must not override a demonstrated PB (see demonstratedPBFloor).
    ...(() => {
      const measuredKm = inputs.weeksCovered > 0
        ? resolveWeeklyKmSignal(inputs, s.detectedWeeklyKm)
        : ((s.detectedWeeklyKm ?? 0) > 0 ? s.detectedWeeklyKm! : null);
      const rpw = s.rw ?? 0;
      const freqEstimate = rpw <= 0 ? null
        : rpw <= 3 ? rpw * 10 : rpw === 4 ? 40 : rpw === 5 ? 50 : rpw === 6 ? 60 : 70;
      return {
        weeklyKm: (measuredKm != null ? measuredKm : freqEstimate) ?? undefined,
        weeklyKmIsEstimate: measuredKm == null && freqEstimate != null,
      };
    })(),
    // Effective aerobic cross-training sessions/week, derived from persisted
    // totals (epw = runs + cross). Softens the short-distance discount only.
    crossTrainingSessions: Math.max(0, (s.epw ?? 0) - (s.rw ?? 0)),
    avgPaceSecPerKm: inputs.avgPaceSecPerKm ?? undefined,
    quality: { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
    hrVdot: computeHRCalibratedVdot(runs, s.restingHR ?? null, s.maxHR ?? null),
    // Carbon-plated racing flats: flat 3% pace boost (Hoogkamer 2018). Mirrors
    // the targeted-forecast treatment so the toggle moves both views the same way.
    shoeMul: s.shoeKind === 'supershoes' ? 0.97 : 1.0,
    marathonPbAgeDays: marathonPbDateISO
      ? Math.max(0, Math.floor((Date.now() - new Date(marathonPbDateISO).getTime()) / (24 * 60 * 60 * 1000)))
      : undefined,
    calibration: computeRunCalibration(s.runRaceLog),
    longestRunSec: getLongestRunSec(s, 12),
    fallbackVdot: resolveRunningVdot(s),
  };
}

/** Run one distance through the full staged pipeline. Returns null when the
 *  blend cannot produce a usable estimate. */
function predictDistanceStaged(ctx: StandardPredictionContext, dist: RaceDistance): StandardPredictionStages | null {
  let blended = blendPredictions(
    DIST_M[dist],
    ctx.pbs,
    ctx.lt,
    ctx.vo2,
    ctx.b,
    ctx.typ,
    ctx.recentRun,
    ctx.athleteTier,
    ctx.weeklyKm,
    ctx.avgPaceSecPerKm,
    ctx.quality,
    ctx.hrVdot,
    ctx.marathonPbAgeDays,
    ctx.weeklyKmIsEstimate,
    ctx.crossTrainingSessions,
  );
  // Last-resort: the weighted blend found no usable predictor (no PB, LT, recent
  // run, device VO2, or HR-calibrated signal) but the athlete still has a
  // resolved running VDOT. Predict from that VDOT alone via the Daniels model
  // (the same `predictFromVO2` the blend's VO2 slot uses — its parameter IS a
  // VDOT). This only fires when the blend is empty, so it never double-counts a
  // signal already in the blend. Keeps the Forecast in lock-step with the Stats
  // VO2 bar, which shows from the same resolved VDOT.
  if ((!blended || blended <= 0 || !isFinite(blended)) && ctx.fallbackVdot != null) {
    blended = predictFromVO2(DIST_M[dist], ctx.fallbackVdot);
  }
  if (!blended || blended <= 0 || !isFinite(blended)) return null;
  const calibratedSec = applyRunCalibrationBias(blended, dist, ctx.calibration);
  const durability = applyLongRunCap(ctx.longestRunSec, dist);
  // Floor each distance at its demonstrated same-distance PB after cap + shoe
  // adjustment (parity with the headline refresh and initialization).
  const finalSec = demonstratedPBFloor(
    calibratedSec * durability.multiplier * ctx.shoeMul,
    DIST_M[dist],
    ctx.pbs,
    {
      weeklyRunKm: ctx.weeklyKm ?? undefined,
      weeklyRunKmIsEstimate: ctx.weeklyKmIsEstimate,
      recentRun: ctx.recentRun,
      b: ctx.b,
    },
  );
  return {
    blendedSec: blended,
    calibratedSec,
    durability,
    shoeMul: ctx.shoeMul,
    finalSec,
  };
}

export function predictStandardDistances(s: SimulatorState): Record<RaceDistance, number | null> {
  const empty: Record<RaceDistance, number | null> = { '5k': null, '10k': null, 'half': null, 'marathon': null };
  const ctx = buildStandardPredictionContext(s);
  if (!ctx) return empty;

  const out: Record<RaceDistance, number | null> = { ...empty };
  for (const dist of STANDARD_DISTANCES) {
    const stages = predictDistanceStaged(ctx, dist);
    out[dist] = stages ? stages.finalSec : null;
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
  /** Longest single run in the last 12 weeks (seconds); 0 = no run history found. */
  durabilityLongestRunSec: number;
  /** Distance-specific long-run threshold the prediction compares against (seconds). */
  durabilityThresholdSec: number;
  calibrationBiasSec: number | null;
  calibrationRaceCount: number;
  /** Predicted finish time at this distance per recorded week (raw VDOT-derived trajectory). */
  trend: { date: string; value: number }[];
  /** Ordered prediction stages (capacity → calibration → durability → shoes).
   *  `finalSec` equals `predictedSec`, so a waterfall built from these
   *  reconciles to the hero. Null when the blend produced no estimate. */
  stages: StandardPredictionStages | null;
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
  const ctx = buildStandardPredictionContext(s);
  const stages = ctx ? predictDistanceStaged(ctx, dist) : null;
  const predictedSec = stages ? stages.finalSec : null;

  const inputs = computePredictionInputs(collectRunsFromState(s));
  const weeklyKm = inputs.weeklyKm > 0 ? inputs.weeklyKm : (s.detectedWeeklyKm ?? null);

  // Durability comes from the staged result when available (same longest-run
  // read), otherwise compute directly for the no-blend case so the UI still
  // has threshold context.
  const durability = stages ? stages.durability : applyLongRunCap(getLongestRunSec(s, 12), dist);

  const calibration = ctx ? ctx.calibration : computeRunCalibration(s.runRaceLog);
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
    durabilityLongestRunSec: durability.longestRunSec,
    durabilityThresholdSec: durability.thresholdSec,
    calibrationBiasSec: bias != null ? bias : null,
    calibrationRaceCount: calibration.basedOnRaceCount ?? 0,
    trend,
    stages,
  };
}

export interface ForecastProjectionPoint {
  /** Weeks ahead of today. 0 = current fitness. */
  weeksAhead: number;
  /** Raw VDOT-derived finish time (sec) at this point. */
  value: number;
}

/**
 * Project the raw VDOT-derived finish time forward `weeks` weeks of continued
 * training, for the no-target-race forecast ("what you could run if you hold
 * the plan"). Returns one point per week (0..weeks); index 0 is today, so the
 * series joins the historical trend line continuously.
 *
 * **Side of the line**: tracking-adjacent — it answers "what will the training
 * you're already doing yield", using the same horizon model the targeted
 * forecast uses, not a new prescription.
 *
 * **Model**: `applyTrainingHorizonAdjustment` (the saturating-logistic VDOT-gain
 * model, SCIENCE_LOG §AB) with `taper_weeks: 0` — there is no race to taper
 * into, so the taper bonus must not inflate the gain. Dose = recent weekly km
 * (what the user is actually training), sessions = `s.rw`. Anchored on the same
 * effective VDOT the latest `vdotHistory` point uses (`s.v + rpeAdj + physioAdj`)
 * so the dashed projection meets the solid trajectory at "now".
 *
 * Returns null when there is no VDOT or no training dose to project along (a
 * just-track user with no plan has nothing to project) — the caller hides the
 * projection in that case.
 */
export function getStandardForecastProjection(
  s: SimulatorState,
  dist: RaceDistance,
  weeks: number,
): ForecastProjectionPoint[] | null {
  if (!s.v || s.v <= 0 || weeks <= 0) return null;
  const sessionsPerWeek = s.rw ?? 0;
  if (sessionsPerWeek <= 0) return null; // not following a plan: nothing to project

  const anchorVdot = s.v + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0);
  const distKm = rdKm(dist);
  const abilityBand = getAbilityBand(anchorVdot);
  const runnerType = (s.typ ?? 'Balanced') as RunnerType;

  // Dose = PLAN-prescribed weekly volume, not recent km. "If you hold the plan"
  // means training at the plan's dose, so mirror the targeted forecast
  // (calculateForecast / §AI): sessions × REF_KM_PER_SESSION × build factor.
  const planKm = getPlanPrescribedMeanWeeklyKm(sessionsPerWeek, dist) ?? undefined;
  const horizonParams = (weeksRemaining: number) => ({
    baseline_vdot: anchorVdot,
    target_distance: dist,
    weeks_remaining: weeksRemaining,
    sessions_per_week: sessionsPerWeek,
    runner_type: runnerType,
    ability_band: abilityBand,
    taper_weeks: 0,
    // Bug fix (2026-06-16): the no-target standard forecast was dropping
    // experience_level entirely, so it silently defaulted to 'intermediate'
    // (1.0) — a returning/advanced/hybrid athlete's exp_factor never applied
    // here, unlike the targeted forecast (race-forecast-simulation.ts:140).
    experience_level: s.onboarding?.experienceLevel || 'intermediate',
    cross_trained: s.onboarding?.crossTrainedBackground === true,
    weekly_volume_km: planKm,
    hm_pb_seconds: s.pbs?.h,
    lt_pace_sec_per_km: s.lt ?? undefined,
    strength_sessions_per_week: s.gs,
  });

  // Total gain the plan's volume supports over the full horizon (the ceiling),
  // floored at 0 — "holding the plan" is at minimum maintenance, never slower.
  // The ceiling honestly reflects under-volume (a low-volume plan → smaller
  // total gain), per Pfitzinger/Daniels volume-shortened deficits.
  const full = applyTrainingHorizonAdjustment(horizonParams(weeks));
  const totalGain = Math.max(0, full.vdot_gain);
  const wfN = full.components.week_factor || 1;

  // Shape the gain across weeks with the model's OWN dual-tau saturation
  // (`week_factor`, SCIENCE_LOG §BA): adaptation rises fastest early and
  // decelerates toward the ceiling (Hickson 1981; Joyner & Coyle 2008). We
  // distribute `totalGain` by `week_factor(w) / week_factor(N)` rather than
  // calling the model per-week and flooring each — the latter produced a
  // dead-flat start then a kink, because the constant undertrain penalty
  // delayed the onset of a positive net gain. Under-volume belongs on the
  // ceiling (totalGain), not on adaptation onset.
  const out: ForecastProjectionPoint[] = [{ weeksAhead: 0, value: tv(anchorVdot, distKm) }];
  for (let w = 1; w <= weeks; w++) {
    const wf = applyTrainingHorizonAdjustment(horizonParams(w)).components.week_factor;
    const shape = wfN > 0 ? Math.min(1, wf / wfN) : w / weeks;
    out.push({ weeksAhead: w, value: tv(anchorVdot + totalGain * shape, distKm) });
  }
  return out;
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

  // Pass the resolved weekly-km signal: history-derived when the 8-week
  // window has any coverage (including an explicit 0 — a user with 145
  // historical runs but zero in the window genuinely has zero recent
  // training, which is signal, not noise), falling back to the user's typed
  // manual-entry volume (s.detectedWeeklyKm) only when the scrape found
  // nothing at all. See resolveWeeklyKmSignal. Marathon PB age scales the
  // penalty: recent PB → demonstrated capability → lighter penalty.
  const marathonPbDateISO = s.onboarding?.pbDates?.m;
  const marathonPbAgeDays = marathonPbDateISO
    ? Math.max(0, Math.floor((Date.now() - new Date(marathonPbDateISO).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined;
  // Volume signal with provenance — mirror initialization.ts so this refresh
  // (which runs at the review step, even for manual users) does not re-break the
  // no-data fix by passing a phantom 0. MEASURED = history (weeksCovered>0) or a
  // typed weekly km; otherwise ESTIMATE from runs/week (sizes the soft penalty,
  // never overrides a demonstrated PB). Cross-training from epw−rw.
  const measuredKm = inputs.weeksCovered > 0
    ? resolveWeeklyKmSignal(inputs, s.detectedWeeklyKm)
    : ((s.detectedWeeklyKm ?? 0) > 0 ? s.detectedWeeklyKm! : null);
  const rpw = s.rw ?? 0;
  const freqEstimate = rpw <= 0 ? null
    : rpw <= 3 ? rpw * 10 : rpw === 4 ? 40 : rpw === 5 ? 50 : rpw === 6 ? 60 : 70;
  const blended = blendPredictions(
    targetDistM,
    s.pbs,
    s.lt ?? null,
    effectiveVo2max(s),
    s.b,
    (s.typ ?? 'Balanced').toLowerCase(),
    inputs.recentRun ?? s.rec ?? null,
    s.athleteTier ?? undefined,
    (measuredKm != null ? measuredKm : freqEstimate) ?? undefined,
    inputs.avgPaceSecPerKm ?? undefined,
    { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
    hrVdot,
    marathonPbAgeDays,
    measuredKm == null && freqEstimate != null,
    Math.max(0, (s.epw ?? 0) - (s.rw ?? 0)),
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
  // Floor at any demonstrated same-distance PB after the cap (mirror of
  // initialization.ts): the cap and calibration bias must not push the anchor
  // slower than a proven time absent detraining evidence. Estimated volume does
  // not count as evidence (see demonstratedPBFloor).
  const durabilityAdjustedBlend = demonstratedPBFloor(
    calibratedBlend * durability.multiplier,
    targetDistM,
    s.pbs,
    {
      weeklyRunKm: (measuredKm != null ? measuredKm : freqEstimate) ?? undefined,
      weeklyRunKmIsEstimate: measuredKm == null && freqEstimate != null,
      recentRun: inputs.recentRun ?? s.rec ?? null,
      b: s.b,
    },
  );

  s.blendedRaceTimeSec = durabilityAdjustedBlend;

  // ── Engine vs race-readiness separation (ISSUE-297, RC1) ──────────────────
  // `durabilityAdjustedBlend` is a *race-readiness* time: it carries the
  // marathon-specificity / low-volume penalties that correctly slow a marathon
  // run off thin running volume. Back-deriving a VDOT from it and writing that
  // into the global engine (`s.v`) conflates "engine capacity" (VO2/VDOT, proven
  // by the athlete's PBs) with "marathon readiness" (capacity x volume/durability).
  // That buries a strong engine — a 20:00 5K (VDOT ~50) collapses to ~40 off
  // 8 km/wk — and the buried value then feeds training paces, plan generation and
  // the race-day forecast. It is the root of the non-reproducible, too-slow
  // predictions in ISSUE-297.
  //
  // The engine is therefore floored at demonstrated cross-distance capacity
  // (`pbDerivedVdot`, a PB-median that is immune to the refresh feedback loop).
  // The floor stands down ONLY on demonstrated recent slowness — a recent run
  // that projects below capacity. Low TRAINING VOLUME is deliberately NOT
  // engine-decay evidence here: it limits race readiness (already modelled on the
  // prediction and the forecast), not aerobic capacity. This is the intended
  // difference from `demonstratedPBFloor`, whose low-volume branch governs the
  // same-distance race prediction. Volume thus moves the prediction and the
  // forecast, never the capacity number — keeping the engine a pure function of
  // demonstrated fitness (deterministic across refreshes).
  const penalisedVdot = cv(targetDistM, durabilityAdjustedBlend);
  const capacityVdot = pbDerivedVdot(s);
  let engineVdot = penalisedVdot;
  if (capacityVdot != null && capacityVdot > penalisedVdot) {
    const recentForEngine = inputs.recentRun ?? s.rec ?? null;
    const tRecentAtTarget = recentForEngine && recentForEngine.t > 0
      ? predictFromRecent(targetDistM, recentForEngine, s.pbs, s.b)
      : null;
    const recentVdot = tRecentAtTarget != null && tRecentAtTarget > 0
      ? cv(targetDistM, tRecentAtTarget)
      : null;
    const recentDemonstratesSlowness = recentVdot != null && recentVdot < capacityVdot;
    if (!recentDemonstratesSlowness) {
      engineVdot = capacityVdot;
      console.log(`[refreshBlendedFitness] engine floored at PB capacity: penalised VDOT ${penalisedVdot.toFixed(1)} buried below demonstrated capacity ${capacityVdot.toFixed(1)} with no recent-run evidence of slowness → engine held at capacity (readiness penalty stays on blendedRaceTimeSec/forecast only)`);
    }
  }

  // ── Race-validated anchor (recent real race run leg) ──────────────────────
  // A real race run leg — fatigue-discounted to a fresh-run equivalent — is the
  // strongest race-validated running signal. For triathletes the watch VO2max
  // (effectiveVo2max, fed into the blend above) is inflated by cycling/swimming
  // and overstates running fitness. Symptom: a 1:55-half triathlete with a watch
  // VO2max of 56 has no running PBs (capacityVdot null), so the floor above can't
  // pull the watch-driven blend down, and s.v collapses to ~56 → easy/threshold/
  // marathon paces all far too fast. The race must win while recent.
  //
  // The race both FLOORS the engine (demonstrated capacity) and CAPS a watch-
  // inflated engine DOWN to the race — UNLESS standalone running evidence (a PB
  // median, or a recent run that projects at/above the race) corroborates the
  // higher value. Capacity floor at a standalone PB stays the "better event"
  // override the user asked for; an un-corroborated watch reading yields.
  const raceAnchor = raceAnchorVdot(s, new Date());
  if (raceAnchor != null) {
    const raceVdot = raceAnchor.vdot;
    if (raceVdot > engineVdot) {
      engineVdot = raceVdot;  // floor: never below demonstrated race capacity
    } else if (engineVdot > raceVdot) {
      // Engine sits above the race. Keep the lift only if standalone running
      // evidence supports it; otherwise it is an un-corroborated watch reading.
      const recentForCap = inputs.recentRun ?? s.rec ?? null;
      const tRecentAtTarget = recentForCap && recentForCap.t > 0
        ? predictFromRecent(targetDistM, recentForCap, s.pbs, s.b)
        : null;
      const recentCapVdot = tRecentAtTarget != null && tRecentAtTarget > 0
        ? cv(targetDistM, tRecentAtTarget)
        : null;
      const standaloneAbove = (capacityVdot != null && capacityVdot >= raceVdot)
        || (recentCapVdot != null && recentCapVdot >= raceVdot);
      if (!standaloneAbove) {
        console.log(`[refreshBlendedFitness] engine capped at race-validated VDOT ${raceVdot.toFixed(1)} (was ${engineVdot.toFixed(1)}; watch/blend uncorroborated by running PBs or recent runs)`);
        engineVdot = raceVdot;
      }
    }
  }

  // ── Cold-start skill-slider cap (triathlon, no running-specific signal) ────
  // With no PB capacity, no race anchor, no recent run, and no medium+ HR-vs-pace
  // calibration, the engine is driven purely by an uncorroborated watch VO2max —
  // which overstates RUNNING fitness for triathletes (cycling/swimming build it,
  // so the watch number isn't run-specific). Symptom: a watch VO2max of 56 with
  // no running data predicts a sub-3:00 marathon for a self-described mid-pack
  // runner. Cap the engine at the athlete's own run skill-slider self-assessment
  // (a running-specific self-report) so it can't run away. The watch VO2max stays
  // the displayed number and re-enters the blend the instant any real running
  // signal lands (PB pulled from Strava/Apple, a logged run, a race). No new
  // constants — reuses estimateRunPaceFromSkill's existing per-level pace table.
  // The cap only bites when the watch exceeds the self-rating, so a genuinely fast
  // self-rated triathlete (skill 5) is not pulled down. Running mode is untouched
  // (no triConfig.skillRating).
  const triRunSkill = s.triConfig?.skillRating?.run;
  const hasRunSpecificSignal = capacityVdot != null
    || raceAnchor != null
    || (inputs.recentRun != null && inputs.recentRun.t > 0)
    || (hrVdot?.vdot != null && (hrVdot.confidence === 'high' || hrVdot.confidence === 'medium'));
  if (triRunSkill && !hasRunSpecificSignal) {
    const skillMarathonPace = estimateRunPaceFromSkill(triRunSkill as 1 | 2 | 3 | 4 | 5, 'ironman');
    const skillVdot = cv(42195, skillMarathonPace * 42.195);
    if (skillVdot > 0 && engineVdot > skillVdot) {
      console.log(`[refreshBlendedFitness] cold-start: no running-specific signal → engine capped at run skill-slider VDOT ${skillVdot.toFixed(1)} (was ${engineVdot.toFixed(1)}, uncorroborated watch). Provisional until real running data lands.`);
      engineVdot = skillVdot;
    }
  }

  s.blendedEffectiveVdot = engineVdot;
  s.blendedLastRefreshedISO = new Date().toISOString();
  s.blendedFromEstimate = measuredKm == null && freqEstimate != null;

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

      // ── Forecast anchor = race time at the PLANNED PEAK volume (ISSUE-297) ──
      // The forecast answers "what can you run when the plan has built you up?",
      // so the volume-dependent penalties must be evaluated at the volume the
      // plan actually delivers, not today's pre-plan maintenance volume. Anchoring
      // on the today-blend (`blended`) only subtracted the small engine-gain delta,
      // leaving the ~40-min low-volume penalty in place forever — the plan ramped
      // the athlete but the forecast never knew.
      //
      // Two-term model: cumulative training dose drives the ENGINE gain (the
      // build-phase mean `planMeanKm`, fed to the horizon below); race-approach
      // sustained volume drives marathon-specific endurance (the PEAK the plan
      // holds, fed to the penalty here). `computePeakWeeklyKm` is the exact
      // destination the plan engine ramps toward, read with the same capacity VDOT
      // and easy pace the plan uses, so the forecast credits precisely the mileage
      // the plan builds — no more (a thin beginner whose plan only reaches the
      // 20-30 km band keeps the residual penalty), no less.
      const peakKm = (s.rw ?? 0) > 0
        ? computePeakWeeklyKm({
            runsPerWeek: s.rw!,
            raceDistance: s.rd,
            fitnessLevel: s.onboarding?.experienceLevel || 'intermediate',
            totalWeeks: s.tw ?? 16,
            vdot: s.v ?? engineVdot,
            easyPaceSecPerKm: s.pac?.e,
          })
        : null;
      // Re-run the SAME prediction pipeline at peak volume. Raw blend only:
      // calibration is applied to forecastTime below, and the durability cap is
      // intentionally omitted from the forecast (it assumes the plan delivers the
      // long runs). `false` for the estimate flag: the planned peak is a
      // projection target, not an estimate of current training.
      const peakBlend = (peakKm != null && peakKm > 0)
        ? blendPredictions(
            targetDistM,
            s.pbs,
            s.lt ?? null,
            effectiveVo2max(s),
            s.b,
            (s.typ ?? 'Balanced').toLowerCase(),
            inputs.recentRun ?? s.rec ?? null,
            s.athleteTier ?? undefined,
            peakKm,
            inputs.avgPaceSecPerKm ?? undefined,
            { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
            hrVdot,
            marathonPbAgeDays,
            false,
            Math.max(0, (s.epw ?? 0) - (s.rw ?? 0)),
          )
        : null;
      const forecastAnchorSec = (peakBlend != null && peakBlend > 0) ? peakBlend : blended;
      // Publish the peak-volume anchor so OTHER forecast surfaces that recompute
      // live (renderer.ts, plan-preview) credit the volume ramp too, instead of
      // anchoring on the penalised today-time `blendedRaceTimeSec` (ISSUE-297 —
      // the forecast-display facet). Without this, the engine reads correct but
      // the displayed forecast stays buried near today.
      s.forecastBlendAnchorSec = forecastAnchorSec;

      const { forecastVdot, forecastTime } = calculateLiveForecast({
        currentVdot: s.v,
        targetDistance: s.rd,
        weeksRemaining: effectiveWeeksRemaining,
        sessionsPerWeek: sessionsForHorizon,
        runnerType: s.typ as Parameters<typeof calculateLiveForecast>[0]['runnerType'],
        experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
        crossTrained: s.onboarding?.crossTrainedBackground === true,
        weeklyVolumeKm: planMeanKm ?? s.wkm,
        weeklyVolumeHours: s.onboarding?.weeklyTrainingHours,
        hmPbSeconds: s.pbs?.h || undefined,
        ltPaceSecPerKm: s.lt || undefined,
        strengthSessionsPerWeek: s.gs,
        adaptationRatio: s.adaptationRatio,
        blendedAnchorSec: forecastAnchorSec,
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
