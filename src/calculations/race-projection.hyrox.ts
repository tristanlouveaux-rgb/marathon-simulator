/**
 * HYROX race-day projection.
 *
 * **Side of the line**: tracking. Projects current prediction forward to race
 * day, factoring in training volume, sessions/week, plan adherence to date,
 * MTL CTL trend, and taper proximity. Mirrors the triathlon `buildProjection`
 * approach. See `race-prediction.triathlon.ts:340` for the parent pattern.
 *
 * The current `predictHyroxRace()` answers "if you raced today". This module
 * projects that forward via percentage adjustments, returning:
 *   - `projectedTotalSec`. Race-day estimated finish
 *   - `factors`. Itemised contributions for transparency
 *   - `confidenceRangeSec`. Symmetric ±band around the projection
 *
 * Confidence: medium-low. The factor weights are heuristic (anchored on
 * running/triathlon horizon-model parameters, with HYROX-specific scaling
 * applied to MTL CTL). They will sharpen as real outcome data lands.
 */

import type { SimulatorState, PhysiologyDayEntry } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import type { AbilityBand as RunAbilityBand } from '@/types/training';
import type { HyroxPrediction } from './race-prediction.hyrox';

/** Map triathlon-domain AbilityBand to the running-horizon band space.
 *  `total_beginner` collapses to `beginner`; `competitive` collapses to `elite`. */
function toRunAbilityBand(b: AbilityBand): RunAbilityBand {
  switch (b) {
    case 'total_beginner': return 'beginner';
    case 'competitive':    return 'elite';
    default:               return b;
  }
}
import {
  HYROX_WEEKLY_SESSIONS,
  HYROX_TAPER_DAYS,
  HYROX_MTL_CAP,
} from '@/constants/hyrox-constants';
import { applyTrainingHorizonAdjustment } from './training-horizon';
import { bandFromVdot } from './hyrox-staleness';
import { runInjuryBuildWeeks } from './hyrox-injury';

export interface HyroxProjectionFactor {
  /** Display name. */
  name: string;
  /** Time delta in seconds (negative = faster, positive = slower). */
  deltaSec: number;
  /** Plain-language explanation surfaced in the confidence panel. */
  explanation: string;
}

export interface HyroxProjection {
  /** Race-day projected total finish time. */
  projectedTotalSec: number;
  /** Today's total (passthrough from prediction). */
  currentTotalSec: number;
  /** Net delta from current to projected (negative = expected to get faster). */
  improvementSec: number;
  /** Itemised factor list for the confidence-panel breakdown. */
  factors: HyroxProjectionFactor[];
  /** Symmetric confidence range around projectedTotalSec, e.g. [low, high]. */
  confidenceRangeSec: [number, number];
  /** Number of weeks until the race (or 0 if no race date / past). */
  weeksRemaining: number;
  /** Per-component breakdown of the improvement allocation. */
  byDiscipline: {
    run:      { currentSec: number; projectedSec: number; deltaSec: number };
    stations: { currentSec: number; projectedSec: number; deltaSec: number };
    roxzone:  { currentSec: number; projectedSec: number; deltaSec: number };
  };
}

/**
 * Half-width (as a fraction of the finish time) of the forecast confidence
 * band. Single source of truth for both the projection's `confidenceRangeSec`
 * and the hero's "likely range" caption, so the two never diverge.
 *
 * Base ±4% reflects the irreducible day-to-day and pacing variance of a HYROX
 * finish. It widens with weeks-out (more time for fitness to drift from the
 * model) and with low calibration (seed-based estimates are less certain than
 * the athlete's measured station times).
 */
export function hyroxForecastBandPct(
  confidence: 'high' | 'medium' | 'low',
  weeksRemaining: number,
): number {
  let pct = 0.04;
  if (weeksRemaining > 4)  pct += 0.01;
  if (weeksRemaining > 12) pct += 0.01;
  if (confidence === 'low')    pct += 0.02;
  if (confidence === 'medium') pct += 0.01;
  return pct;
}

/** Days between two ISO dates. Negative if `to` is before `from`. */
function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO).getTime();
  const b = new Date(toISO).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Compute weeks remaining to the race. Returns 0 if no race date or race already past.
 */
function computeWeeksRemaining(state: SimulatorState): number {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const days = daysBetween(today, raceDate);
  if (days <= 0) return 0;
  return days / 7;
}

/**
 * Approximate per-band CTL anchor. The expected MTL CTL (daily-equivalent ÷7
 * EMA of weeklyMTL) for an athlete training at band-default volume.
 * Below this anchor the athlete is undertrained for their declared band; above,
 * they have headroom. Anchors are ~70% of the band's MTL cap, divided by 7.
 */
function expectedMtlCtl(band: AbilityBand): number {
  return (HYROX_MTL_CAP[band] * 0.70) / 7;
}

/**
 * Compute a readiness score (0..1) from physiologyHistory.
 * Combines HRV trend (28-day baseline vs 7-day mean), sleep score, and RHR trend.
 * Returns 0.5 for "neutral" when data is missing.
 */
function computeReadinessScore(physio: PhysiologyDayEntry[] | undefined): number | null {
  if (!physio || physio.length < 14) return null;
  const recent7 = physio.slice(-7);
  const baseline28 = physio.slice(-28);

  // HRV trend: recent vs baseline.
  const hrvRecent = recent7.map(p => p.hrvRmssd).filter((v): v is number => typeof v === 'number');
  const hrvBaseline = baseline28.map(p => p.hrvRmssd).filter((v): v is number => typeof v === 'number');
  let hrvFactor = 0.5;
  if (hrvRecent.length >= 3 && hrvBaseline.length >= 7) {
    const r = hrvRecent.reduce((s, v) => s + v, 0) / hrvRecent.length;
    const b = hrvBaseline.reduce((s, v) => s + v, 0) / hrvBaseline.length;
    if (b > 0) {
      const ratio = r / b;
      hrvFactor = Math.max(0, Math.min(1, 0.5 + (ratio - 1) * 2.5));
    }
  }

  // Sleep score: 7-day mean (Garmin scale 0–100).
  const sleepRecent = recent7.map(p => p.sleepScore).filter((v): v is number => typeof v === 'number');
  let sleepFactor = 0.5;
  if (sleepRecent.length >= 3) {
    const mean = sleepRecent.reduce((s, v) => s + v, 0) / sleepRecent.length;
    sleepFactor = Math.max(0, Math.min(1, mean / 100));
  }

  // RHR trend: recent vs baseline (lower = better).
  const rhrRecent = recent7.map(p => p.restingHR).filter((v): v is number => typeof v === 'number');
  const rhrBaseline = baseline28.map(p => p.restingHR).filter((v): v is number => typeof v === 'number');
  let rhrFactor = 0.5;
  if (rhrRecent.length >= 3 && rhrBaseline.length >= 7) {
    const r = rhrRecent.reduce((s, v) => s + v, 0) / rhrRecent.length;
    const b = rhrBaseline.reduce((s, v) => s + v, 0) / rhrBaseline.length;
    if (b > 0) {
      const ratio = r / b;  // <1 = recent lower = better
      rhrFactor = Math.max(0, Math.min(1, 0.5 + (1 - ratio) * 5));
    }
  }

  // Weighted blend: HRV 50%, sleep 25%, RHR 25%.
  return hrvFactor * 0.5 + sleepFactor * 0.25 + rhrFactor * 0.25;
}

/**
 * Compute plan adherence ratio (0..1) for the last N completed weeks.
 * Counts completed station/brick/run sessions vs planned, excluding the current week.
 */
function computeAdherence(state: SimulatorState, lookbackWeeks: number = 3): number {
  const wks = state.wks ?? [];
  const currentIdx = (state.w ?? 1) - 1;
  const startIdx = Math.max(0, currentIdx - lookbackWeeks);
  let plannedCount = 0;
  let completedCount = 0;
  for (let i = startIdx; i < currentIdx; i++) {
    const wk: any = wks[i];
    if (!wk) continue;
    const planned = (wk.triWorkouts ?? []).length;
    const completed = (wk.garminActuals ?? []).length;
    plannedCount += planned;
    completedCount += Math.min(completed, planned);
  }
  if (plannedCount === 0) return 1.0;
  return Math.min(1, completedCount / plannedCount);
}

/**
 * Build a race-day projection from the current prediction.
 *
 * Unified model (2026-05-20): the per-discipline horizon projections from
 * `predictHyroxRace` (`prediction.projection`) are the source of truth for
 * what training does to each component. The factor model below adds reality-
 * vs-declared-plan adjustments (MTL trajectory, plan adherence, taper
 * readiness, recovery signals) as a single uniform percentage modifier on
 * top of the horizon-projected sum.
 *
 *   disciplineHorizonTotal
 *     = runHorizonProjectedSec        (VDOT horizon on the 8 km run portion)
 *     + stationsHorizonProjectedSec   (Σ per-station `applyHyroxStationHorizon`)
 *     + roxzoneHorizonProjectedSec    (`applyHyroxRoxzoneHorizon`)
 *
 *   projectedTotalSec = disciplineHorizonTotal × (1 + factorPct)
 *
 * Per-discipline `byDiscipline.{run,stations,roxzone}.projectedSec` apply the
 * same multiplier, so the headline equals the sum of the three. That fixes
 * the prior divergence where per-station rows promised a stations gain that
 * the proportionally-allocated factor model could not reflect.
 *
 * Factor list semantics: each factor's `deltaSec` is its individual
 * contribution to `improvementSec`. Sum of `factors[].deltaSec` equals
 * `improvementSec` (modulo rounding). Horizon factors (run/stations/roxzone
 * fitness trajectory) are emitted alongside the modulator factors (training
 * fitness, weekly volume, adherence, taper bonus, race-day readiness) for
 * full transparency.
 */
export function buildHyroxProjection(state: SimulatorState, prediction: HyroxPrediction): HyroxProjection {
  const hx = state.hyroxConfig!;
  const band = hx.athleteBand;
  const factors: HyroxProjectionFactor[] = [];
  const currentTotalSec = prediction.totalSec;
  const weeksRemaining = computeWeeksRemaining(state);

  // ── Step 1: per-discipline horizon projections ─────────────────────────
  // Stations + roxzone come straight from `prediction.projection` (computed
  // inside `predictHyroxRace` via `buildStationProjection`). Run uses the
  // VDOT horizon: there's no station-class curve for "running an 8 km race
  // portion", so we map to a 10k VDOT projection.
  let runHorizonProjectedSec = prediction.runSec;
  let runHorizonImprovementPct = 0;
  let runSessions = 0;
  if (weeksRemaining > 0 && state.v > 0) {
    const runVdotBand = toRunAbilityBand(bandFromVdot(state.v) ?? band);
    runSessions = (hx.runsPerWeek ?? 0) + 0.5 * (hx.bricksPerWeek ?? 0);
    // Injury debit: the run portion only banks build time for the weeks the
    // athlete can run. A blocked run → 0 build weeks → no projected run gain.
    // Unchanged when there is no active injury (returns full weeksRemaining).
    const runBuildWeeks = runInjuryBuildWeeks(state.injuryState, weeksRemaining);
    const runHorizon = applyTrainingHorizonAdjustment({
      baseline_vdot: state.v,
      target_distance: '10k',
      weeks_remaining: runBuildWeeks,
      sessions_per_week: runSessions,
      runner_type: state.typ ?? 'Balanced',
      ability_band: runVdotBand,
      // Use default HYROX_TAPER_WEEKS so the run portion gets the same
      // per-discipline taper handling that the per-station and roxzone
      // horizons already apply internally. Taper lives in the horizon
      // models. The factor model below handles reality adjustments only.
      weekly_volume_km: state.wkm,
    });
    runHorizonImprovementPct = runHorizon.improvement_pct;
    runHorizonProjectedSec = prediction.runSec * (1 - runHorizonImprovementPct / 100);
  }

  const stationsHorizonProjectedSec = prediction.projection
    ? prediction.projection.stations.reduce((s, st) => s + st.projectedSec, 0)
    : prediction.stationsSec;
  const roxzoneHorizonProjectedSec = prediction.projection
    ? prediction.projection.roxzone.projectedSec
    : prediction.roxzoneSec;

  const disciplineHorizonTotal =
    runHorizonProjectedSec + stationsHorizonProjectedSec + roxzoneHorizonProjectedSec;

  // Surface each horizon contribution as a factor row so the breakdown sums
  // back to improvementSec. Skip when |delta| < 1s.
  const runHorizonDelta      = runHorizonProjectedSec      - prediction.runSec;
  const stationsHorizonDelta = stationsHorizonProjectedSec - prediction.stationsSec;
  const roxzoneHorizonDelta  = roxzoneHorizonProjectedSec  - prediction.roxzoneSec;
  if (Math.abs(runHorizonDelta) >= 1) {
    factors.push({
      name: 'Running fitness trajectory',
      deltaSec: Math.round(runHorizonDelta),
      explanation: `Projected VDOT gain over ${weeksRemaining.toFixed(1)} weeks at ${runSessions.toFixed(1)} run sessions/wk (counting bricks at 0.5). Applied to the 8 km run portion.`,
    });
  }
  if (Math.abs(stationsHorizonDelta) >= 1 && prediction.projection) {
    const sessions = prediction.projection.plannedSessionsPerWeek;
    factors.push({
      name: 'Stations fitness trajectory',
      deltaSec: Math.round(stationsHorizonDelta),
      explanation: `Per-station horizon at ${sessions.toFixed(1)} HYROX sessions/wk for ${weeksRemaining.toFixed(1)} weeks. Sum of the per-class projections shown in the Station-order view.`,
    });
  }
  if (Math.abs(roxzoneHorizonDelta) >= 1) {
    factors.push({
      name: 'Roxzone trajectory',
      deltaSec: Math.round(roxzoneHorizonDelta),
      explanation: `Transition-economy gain over ${weeksRemaining.toFixed(1)} weeks. Roxzone benefits from race-pace familiarity and transition rehearsal.`,
    });
  }

  // ── Step 2: factor model (uniform percentage modifier) ─────────────────
  // These are reality-vs-plan adjustments. Not training-effect estimates.
  // Each contribution is a bounded percentage; their signed sum is the
  // multiplier applied to `disciplineHorizonTotal`. Express each factor's
  // own deltaSec against `disciplineHorizonTotal` so the factor list sums
  // back to `improvementSec`.
  let factorPct = 0;

  // Factor: MTL CTL fitness vs band anchor.
  const expected = expectedMtlCtl(band);
  const runCtl     = hx.runMtlCTL     ?? 0;
  const stationCtl = hx.stationMtlCTL ?? 0;
  const brickCtl   = hx.brickMtlCTL   ?? 0;
  const splitTotalCtl = runCtl + stationCtl + brickCtl;
  const actualCtl = splitTotalCtl > 0 ? splitTotalCtl : (hx.mtlCTL ?? 0);
  if (expected > 0 && actualCtl > 0) {
    const ratio = actualCtl / expected;
    // ratio > 1 = trained above band = expected to be faster → negative pct.
    const ctlPct = -Math.max(-0.05, Math.min(0.05, (ratio - 1) * 0.10));
    factorPct += ctlPct;
    const splitNote = splitTotalCtl > 0
      ? ` Run ${runCtl.toFixed(1)} · stations ${stationCtl.toFixed(1)} · brick ${brickCtl.toFixed(1)}.`
      : '';
    factors.push({
      name: 'Training fitness',
      deltaSec: Math.round(ctlPct * disciplineHorizonTotal),
      explanation: (ratio >= 1.0
        ? `MTL chronic load (${actualCtl.toFixed(1)}) is above the ${band} band anchor (${expected.toFixed(1)}). Training above your declared level.`
        : `MTL chronic load (${actualCtl.toFixed(1)}) is below the ${band} band anchor (${expected.toFixed(1)}). Currently undertrained for your target.`) + splitNote,
    });
  }

  // Factor: sessions per week vs band default.
  const defaults = HYROX_WEEKLY_SESSIONS[band];
  const expectedSessions = defaults.runs + defaults.stations + defaults.bricks;
  const actualSessions = (hx.runsPerWeek ?? defaults.runs)
                        + (hx.stationSessionsPerWeek ?? defaults.stations)
                        + (hx.bricksPerWeek ?? defaults.bricks);
  if (expectedSessions > 0) {
    const sessionRatio = actualSessions / expectedSessions;
    // ratio > 1 = more sessions = faster → negative pct.
    const sessionPct = -Math.max(-0.03, Math.min(0.03, (sessionRatio - 1) * 0.06));
    const sessionSec = sessionPct * disciplineHorizonTotal;
    if (Math.abs(sessionSec) >= 5) {
      factorPct += sessionPct;
      factors.push({
        name: 'Weekly volume',
        deltaSec: Math.round(sessionSec),
        explanation: `${actualSessions} sessions/week vs band default of ${expectedSessions}.`,
      });
    }
  }

  // Factor: plan adherence.
  const adherence = computeAdherence(state);
  if (adherence < 0.95) {
    const adherencePct = (1 - adherence) * 0.04;  // 0..4% slowdown
    factorPct += adherencePct;
    factors.push({
      name: 'Plan adherence',
      deltaSec: Math.round(adherencePct * disciplineHorizonTotal),
      explanation: `Completed ${Math.round(adherence * 100)}% of planned sessions in the last 3 weeks.`,
    });
  }

  // Taper is owned by the horizon models (per-class for stations, distance-
  // appropriate for run, generic for roxzone). No separate "Taper bonus"
  // factor. That would double-count what the horizon models already include.

  // Factor: race-day readiness (HRV / sleep / RHR). Taper window only.
  const taperWindowWeeks = HYROX_TAPER_DAYS[band] / 7;
  if (weeksRemaining > 0 && weeksRemaining <= taperWindowWeeks * 1.5) {
    const readinessScore = computeReadinessScore(state.physiologyHistory);
    if (readinessScore != null) {
      const readinessPct = (0.5 - readinessScore) * 0.04;  // poor readiness → slower
      const readinessSec = readinessPct * disciplineHorizonTotal;
      if (Math.abs(readinessSec) >= 5) {
        factorPct += readinessPct;
        const readinessLabel = readinessScore >= 0.7 ? 'high' : readinessScore <= 0.35 ? 'low' : 'moderate';
        factors.push({
          name: 'Race-day readiness',
          deltaSec: Math.round(readinessSec),
          explanation: `Recovery signals over the last 7 days indicate ${readinessLabel} readiness. HRV, sleep, and resting HR vs baseline.`,
        });
      }
    }
  }

  // ── Step 3: apply uniform multiplier per discipline ────────────────────
  // The same factorPct multiplies each discipline's horizon-projected value,
  // so the headline equals the sum of byDiscipline.X.projectedSec.
  const multiplier = 1 + factorPct;
  const runProjectedSec      = Math.round(runHorizonProjectedSec      * multiplier);
  const stationsProjectedSec = Math.round(stationsHorizonProjectedSec * multiplier);
  const roxzoneProjectedSec  = Math.round(roxzoneHorizonProjectedSec  * multiplier);

  const projectedTotalSec = runProjectedSec + stationsProjectedSec + roxzoneProjectedSec;

  const byDiscipline = {
    run:      { currentSec: prediction.runSec,      projectedSec: runProjectedSec,      deltaSec: runProjectedSec      - prediction.runSec },
    stations: { currentSec: prediction.stationsSec, projectedSec: stationsProjectedSec, deltaSec: stationsProjectedSec - prediction.stationsSec },
    roxzone:  { currentSec: prediction.roxzoneSec,  projectedSec: roxzoneProjectedSec,  deltaSec: roxzoneProjectedSec  - prediction.roxzoneSec },
  };

  // ── Confidence range ───────────────────────────────────────────────────
  // Band half-width comes from the shared `hyroxForecastBandPct` helper so the
  // hero's "likely range" caption and this projection band stay identical.
  const basePct = hyroxForecastBandPct(prediction.confidence, weeksRemaining);
  const halfRange = projectedTotalSec * basePct;
  const confidenceRangeSec: [number, number] = [
    Math.round(projectedTotalSec - halfRange),
    Math.round(projectedTotalSec + halfRange),
  ];

  return {
    projectedTotalSec: Math.round(projectedTotalSec),
    currentTotalSec,
    improvementSec: Math.round(projectedTotalSec - currentTotalSec),
    factors,
    confidenceRangeSec,
    weeksRemaining,
    byDiscipline,
  };
}
