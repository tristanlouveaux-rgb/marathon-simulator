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
import { cv } from './vdot';
import { recomputeLT } from '@/data/ltSync';
import { computeRunCalibration, applyRunCalibrationBias } from './run-calibration';
import { getLongestRunSec, applyLongRunCap, type RunDurabilityResult } from './run-durability';

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

  if (!s.rd || !s.pbs || !s.b) return false;
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
    s.vo2 ?? null,
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
  // During active injury where running is stopped (canRun='no'), the PB/HR
  // blend reflects pre-injury fitness. Writing it back would undo the weekly
  // VDOT decay applied by advanceWeekToToday. Allow it to write again once
  // the user returns to running (canRun='limited'|'yes').
  const injuryState = (s as any).injuryState;
  const injuryBlockingRun = injuryState?.active && injuryState?.canRun === 'no';
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
      const { forecastVdot, forecastTime } = calculateLiveForecast({
        currentVdot: s.v,
        targetDistance: s.rd,
        weeksRemaining,
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
      s.forecastTime = applyRunCalibrationBias(forecastTime, s.rd, calibration);
    } catch {
      // Leave expectedFinal untouched on any forecast failure.
    }
  }

  // Record a history entry so the VDOT sparkline shows the weekly refresh.
  // Dedup by (week, date). RefreshBlendedFitness can fire multiple times
  // per boot (app launch + onboarding + weekly rollover).
  const effectiveVdot = s.v + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const weekNum = s.w ?? 1;
  const hist = s.vdotHistory ?? [];
  const existingIdx = hist.findIndex(h => h.week === weekNum && h.date === today);
  const entry = { week: weekNum, vdot: Math.round(effectiveVdot * 10) / 10, date: today };
  if (existingIdx >= 0) {
    hist[existingIdx] = entry;
  } else {
    hist.push(entry);
  }
  s.vdotHistory = hist.slice(-20);

  return true;
}
