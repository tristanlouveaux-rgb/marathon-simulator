/**
 * Blended fitness refresh — single source of truth for the race-time prediction
 * that drives the stats view, onboarding summary, and (Step 6) plan-engine
 * pace derivation.
 *
 * Invocation points:
 *   1. End of onboarding, after `backfillStravaHistory` returns per-run data.
 *   2. Weekly rollover (`next()` in `events.ts`) after auto-LT update.
 *
 * Writes `s.blendedRaceTimeSec`, `s.blendedEffectiveVdot`,
 * `s.blendedLastRefreshedISO`. Reads are O(1) everywhere else — no component
 * re-runs the blend on render.
 */

import type { SimulatorState, RaceDistance } from '@/types';
import { blendPredictions, calculateLiveForecast } from './predictions';
import { computePredictionInputs, type RunActivityInput } from './prediction-inputs';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import { cv } from './vdot';

const DIST_M: Record<RaceDistance, number> = {
  '5k': 5000,
  '10k': 10000,
  'half': 21097,
  'marathon': 42195,
};

/**
 * Assemble `RunActivityInput[]` from whichever sources are available in the
 * current state. Preference order:
 *   - `s.wks[].garminActuals` (live sync — authoritative for returning users)
 *   - `s.onboardingRunHistory` (seeded by backfill response — first-session data)
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
 * Idempotent — safe to call any time. Does nothing and returns false if
 * required inputs are missing.
 */
export function refreshBlendedFitness(s: SimulatorState): boolean {
  // Compute + cache HR-calibrated VDOT first, independent of the full blend.
  // The onboarding review screen needs this even before race distance is set,
  // so we pre-cache before the early-return guards below. This write is
  // load-bearing for onboarding's fitness display — main.ts always invokes
  // refreshBlendedFitness on launch, so the cache is never stale at runtime.
  const runsAll = collectRunsFromState(s);
  const hrVdot = computeHRCalibratedVdot(runsAll, s.restingHR ?? null, s.maxHR ?? null);
  s.hrCalibratedVdot = {
    vdot: hrVdot.vdot,
    confidence: hrVdot.confidence,
    n: hrVdot.n,
    r2: hrVdot.r2,
    reason: hrVdot.reason,
  };

  // Pre-blend reconciliation: when no race distance has been picked yet
  // (onboarding) and HR-calibrated confidence is medium+, write the value to
  // s.v so the rest of the app shows the same number as the review row.
  // Skip at low confidence — too noisy to overwrite a PB-derived seed.
  // Once race distance is set, the post-guard blend below takes over and this
  // is overwritten with the full blended VDOT. Mid-plan we never hit this
  // branch because s.rd is set.
  if (!s.rd && hrVdot.vdot != null && (hrVdot.confidence === 'high' || hrVdot.confidence === 'medium')) {
    s.v = hrVdot.vdot;
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

  const blended = blendPredictions(
    targetDistM,
    s.pbs,
    s.lt ?? null,
    s.vo2 ?? null,
    s.b,
    (s.typ ?? 'Balanced').toLowerCase(),
    inputs.recentRun ?? s.rec ?? null,
    s.athleteTier ?? undefined,
    inputs.weeklyKm || undefined,
    inputs.avgPaceSecPerKm ?? undefined,
    { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
    hrVdot,
  );

  if (!blended || blended <= 0 || !isFinite(blended)) return false;

  s.blendedRaceTimeSec = blended;
  s.blendedEffectiveVdot = cv(targetDistM, blended);
  s.blendedLastRefreshedISO = new Date().toISOString();

  // Push the blended VDOT into s.v so plan generation and pace derivation
  // reflect reality, not the Week-1 linear projection. Exception: during taper
  // and deload weeks (both share `ph === 'taper'`), volume is deliberately cut
  // — recomputing would read the reduction as detraining and pull predictions
  // slower, when the science says fitness is maintained (Mujika & Padilla 2000).
  // Hold s.v at its pre-taper value until we exit the low-volume phase.
  const currentWeek = (s.wks ?? [])[(s.w ?? 1) - 1];
  const inTaperOrDeload = currentWeek?.ph === 'taper';
  if (!inTaperOrDeload) {
    s.v = s.blendedEffectiveVdot;
  }

  // Recompute end-of-plan forecast from the fresh baseline so s.expectedFinal
  // tracks reality instead of being frozen at onboarding.
  const weeksRemaining = Math.max(1, (s.tw ?? 0) - ((s.w ?? 1) - 1));
  if (s.rd && s.typ && weeksRemaining > 0) {
    try {
      const { forecastVdot, forecastTime } = calculateLiveForecast({
        currentVdot: s.v,
        targetDistance: s.rd,
        weeksRemaining,
        sessionsPerWeek: s.epw ?? s.rw ?? 3,
        runnerType: s.typ as Parameters<typeof calculateLiveForecast>[0]['runnerType'],
        experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
        weeklyVolumeKm: s.wkm,
        hmPbSeconds: s.pbs?.h || undefined,
        ltPaceSecPerKm: s.lt || undefined,
        adaptationRatio: s.adaptationRatio,
      });
      s.expectedFinal = forecastVdot;
      s.forecastTime = forecastTime;
    } catch {
      // Leave expectedFinal untouched on any forecast failure.
    }
  }

  // Record a history entry so the VDOT sparkline shows the weekly refresh.
  // Dedup by (week, date) — refreshBlendedFitness can fire multiple times
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
