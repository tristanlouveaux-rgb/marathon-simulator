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
import { HYROX_TAPER_DAYS } from '@/constants/hyrox-constants';
import { applyTrainingHorizonAdjustment } from './training-horizon';
import { hyroxMtlChronicVsPlan, isMtlSessionCompleted } from './mtl';
import { bandFromVdot } from './hyrox-staleness';
import { runInjuryBuildWeeks } from './hyrox-injury';
import { raceForecastHorizonISO } from '@/workouts/race-week-layout';
import { hyroxImprovementCeiling } from './hyrox-results';
import { doublesTotalInSinglesTermsSec, hyroxDoublesTablesForState } from './hyrox-doubles';
import { isHyroxDoublesFormat, resolveHyroxAthleteSex } from './hyrox-division';

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

/**
 * The forecast's likely range, exactly as the Forecast hero shows it
 * ("Likely X–Y"): the forecast ± hyroxForecastBandPct of it (the band widens
 * with weeks to race day and with lower calibration). One source for the
 * hero and the goal feasibility grading (hyroxGoalBackCalcOptions), so a goal
 * reads "inside your forecast's likely range" only when the hero's range
 * contains it.
 */
export function hyroxLikelyRangeSec(
  state: SimulatorState,
  prediction: Pick<HyroxPrediction, 'totalSec' | 'confidence'>,
): [number, number] {
  const pct = hyroxForecastBandPct(prediction.confidence, computeWeeksRemaining(state));
  const half = prediction.totalSec * pct;
  return [Math.round(prediction.totalSec - half), Math.round(prediction.totalSec + half)];
}

/** Days between two ISO dates. Negative if `to` is before `from`. */
function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO).getTime();
  const b = new Date(toISO).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Weeks of training remaining: to the end of race week (raceForecastHorizonISO;
 * the Sunday before race day when a Monday to Wednesday race has a closing
 * week, which holds only the race). Returns 0 if no race date or race week is
 * over.
 */
function computeWeeksRemaining(state: SimulatorState): number {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const days = daysBetween(today, raceForecastHorizonISO(state, raceDate));
  if (days <= 0) return 0;
  return days / 7;
}

/** True while race day is still ahead (calendar days, the closing week included). */
function raceStillAhead(state: SimulatorState): boolean {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return false;
  return daysBetween(new Date().toISOString().slice(0, 10), raceDate) > 0;
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
 * A completion is a planned slot that holds a record (isMtlSessionCompleted,
 * the same test the MTL sums use). Unplanned (adhoc) records in garminActuals
 * do not count: they used to fill the numerator and could hide missed
 * planned sessions (audit 2026-10-12).
 */
function computeAdherence(state: SimulatorState, lookbackWeeks: number = 3): number {
  const wks = state.wks ?? [];
  const currentIdx = (state.w ?? 1) - 1;
  const startIdx = Math.max(0, currentIdx - lookbackWeeks);
  let plannedCount = 0;
  let completedCount = 0;
  for (let i = startIdx; i < currentIdx; i++) {
    const wk = wks[i];
    if (!wk) continue;
    const plannedWorkouts = wk.triWorkouts ?? [];
    const planned = plannedWorkouts.length;
    // garminActuals is Record<workoutId, GarminActual>, NOT an array: count the
    // planned slots that hold a record, keyed by slot id. Reading `.length`
    // off the record once turned completedCount into NaN and silently
    // disabled the factor (NaN < 0.95 is false); keep `wk` typed.
    const completed = plannedWorkouts.filter(w => isMtlSessionCompleted(wk, w)).length;
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
 * fitness, adherence, race-day readiness) for full transparency.
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

  // Factor: chronic MTL against the chronic MTL the plan prescribed (reality
  // against plan, like every modulator here). Canonical computation:
  // mtl.ts computeMtlChronicVsPlan, which the staleness model's MTL signal also
  // reads. The anchor used to be 70% of the band's MTL cap, but the generator
  // prescribes about 57% of cap in base (intermediate), so a fully compliant
  // athlete read as undertrained and took up to +5% once f2 let completions
  // reach chronic MTL. Withheld behind computeMtlAcwr's history guard (weeks 1
  // and 2), where the EMA start rests on one week. Same slope (0.10) and clamp
  // (±5%) as before. Completed MTL counts plan sessions only, so the ratio is
  // at most 1 and the factor only ever slows the projection.
  const mtlVsPlan = hyroxMtlChronicVsPlan(state);
  if (mtlVsPlan?.ratio != null) {
    const ratio = mtlVsPlan.ratio;
    // ratio > 1 = more chronic load than prescribed = faster → negative pct.
    const ctlPct = -Math.max(-0.05, Math.min(0.05, (ratio - 1) * 0.10));
    const ctlSec = ctlPct * disciplineHorizonTotal;
    if (Math.abs(ctlSec) >= 1) {
      factorPct += ctlPct;
      const pctOfPlan = Math.round(ratio * 100);
      factors.push({
        name: 'Training fitness',
        deltaSec: Math.round(ctlSec),
        explanation: `Chronic MTL is ${pctOfPlan}% of the load the plan prescribed through week ${mtlVsPlan.completedWeeks}. ${ratio > 1 ? 'Load to date is above plan.' : 'Completed load to date is below plan.'}`,
      });
    }
  }

  // No "Weekly volume" factor. Sessions per week already drive the horizon
  // projections above (stations: plannedHyroxSessionsPerWeek; run: runs +
  // half the bricks), so a second ±3% for configured sessions against the band
  // default counted the same volume twice and leaned high-session plans
  // faster (audit 2026-10-12).

  // Factor: plan adherence.
  const adherence = computeAdherence(state);
  // Guard the factor on a finite value. A non-finite adherence must not silently
  // skip the debit the way the Record-vs-array bug did.
  if (Number.isFinite(adherence) && adherence < 0.95) {
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

  // Factor: race-day readiness (HRV / sleep / RHR). Taper window only. It
  // reads recovery, not training, so it holds until race day: through a
  // closing week too, where the training horizon is already 0.
  const taperWindowWeeks = HYROX_TAPER_DAYS[band] / 7;
  if (raceStillAhead(state) && weeksRemaining <= taperWindowWeeks * 1.5) {
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

  // Factor: improvement ceiling from the results (tracking side). The
  // projected gain to race day may not exceed what the top quarter of repeat
  // HYROX athletes achieved over a comparable gap: the 75th percentile of the
  // first-to-latest improvement, venue-relative, grouped by the mean of both
  // races so regression to the mean is out (hyroxImprovementCeiling,
  // HYROX_S79_IMPROVEMENT). Applied last, over every factor, as the same
  // uniform modifier, so the factor list still sums to improvementSec.
  // Optimistic end of what the data supports: the median repeat athlete
  // improves about 4%, the ceiling sits at the upper quartile.
  const hxFormat = hx.format ?? 'open_singles';
  const singlesTotalSec = isHyroxDoublesFormat(hxFormat)
    ? doublesTotalInSinglesTermsSec(currentTotalSec, hyroxDoublesTablesForState(state))
    : currentTotalSec;
  const ceiling = weeksRemaining > 0 && currentTotalSec > 0
    ? hyroxImprovementCeiling({
        format: hxFormat,
        sex: resolveHyroxAthleteSex(state.biologicalSex, hx.division),
        singlesTotalSec,
        weeksRemaining,
      })
    : null;
  if (ceiling && disciplineHorizonTotal > 0) {
    const uncapped = disciplineHorizonTotal * (1 + factorPct);
    const floorSec = currentTotalSec * (1 - ceiling.pct / 100);
    if (uncapped < floorSec) {
      const ceilingPct = floorSec / disciplineHorizonTotal - (1 + factorPct);
      factorPct += ceilingPct;
      const months = ceiling.cell.gapHalfSeasons === 'all' ? null : ceiling.cell.gapHalfSeasons * 6;
      factors.push({
        name: 'Results ceiling',
        deltaSec: Math.round(ceilingPct * disciplineHorizonTotal),
        explanation: `Gain held to ${ceiling.pct.toFixed(1)}%. A quarter of ${ceiling.cell.n.toLocaleString('en-US')} repeat HYROX athletes improved more than that${months ? ` over about ${months} months` : ''}, relative to each event's median.`,
      });
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
