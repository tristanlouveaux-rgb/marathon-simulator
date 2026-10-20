/**
 * HYROX race plan: the 16 legs in race order plus the Roxzone, each with the
 * goal split, the race clock at the end of the leg, and the forecast's own
 * split alongside.
 *
 * Side of the line: tracking and planning. The forecast columns describe
 * (predictHyroxRace's own numbers, never recomputed here); the goal columns
 * prescribe race-day pacing.
 *
 * Goal splits:
 *  - Goal faster than the forecast: computeGoalBackCalc (headroom-weighted),
 *    with floors from the athlete's own field (hyroxCompetitiveFloors: the
 *    median split of the top 1% of finishers, per format and sex or doubles
 *    division, the pair's times for doubles; the field's fastest published
 *    split, its p1 row, for a component the forecast already has at or past
 *    that median; headroom measured on the venue-neutral lines) and the
 *    Roxzone at the goal scaled from the forecast's by the real results
 *    (below).
 *  - Goal slower than (or equal to) the forecast: each component is the
 *    forecast's, eased by how finishers at the goal time differ from
 *    finishers at the forecast time (hyroxPeerSplitsAt, segment by segment),
 *    then scaled to sum to the goal.
 *  - No goal, or a goal the floors cannot reach ('unrealistic'): the splits
 *    are the forecast's own lines (hyroxForecastRaceClock), so the page never
 *    lists splits that sum to neither the goal nor the forecast.
 *
 * Roxzone at the goal: forecast Roxzone x peer Roxzone at the goal / peer
 * Roxzone at the forecast (hyroxPeerSplitsAt in the target's cohort). Finishers
 * at 1:20 spend far less time in the Roxzone than finishers at 1:40, so it is
 * no longer held constant; the ratio keeps the forecast's own Roxzone when the
 * goal equals the forecast. It is floored by the same tier rule as the run
 * and the stations (the cohort's top-1% Roxzone median, or its p1 Roxzone
 * once the forecast is at or past that median), never above the forecast's.
 *
 * Run legs: the goal run total split with the forecast's per-leg fatigue model
 * (prediction.runLegs[].fatigueMultiplier, PER_STATION_FATIGUE_RATE_BY_BAND),
 * so a goal leg and its forecast leg differ only by the goal, never by shape.
 *
 * Race clock (hyroxRaceClock, the one clock for every surface: the Forecast
 * tab's Race order card reads hyroxForecastRaceClock too): whole seconds,
 * legs rounded so they sum exactly to the plan total. The Roxzone is spread
 * evenly around the 8 stations, half before and half after each one (the last
 * half lands at the finish), so the clock after Wall Balls is the finish time.
 * Official splits time the Roxzone around each station in the same way.
 *
 * Doubles: the forecast is already in the pair's terms (each station mapped
 * through the doubles quantile mapping, the run at the pair's pace since
 * partners run every leg together), and the floors and peers read the
 * doubles division's own tables, so every number here is the pair's.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';
import type { HyroxPrediction } from './race-prediction.hyrox';
import { computeGoalBackCalc, type GoalBackCalcOptions, type GoalBackCalcResult } from './hyrox-goal-back-calc';
import {
  hyroxCohortForState,
  hyroxCompetitiveFloors,
  hyroxPeerSplitsAt,
  type HyroxResultsCohort,
  type HyroxPeerSegment,
} from './hyrox-results';
import { isHyroxDoublesFormat } from './hyrox-division';
import { HYROX_STATION_ORDER, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';

export interface HyroxRaceClockLeg {
  kind: 'run' | 'station';
  /** "Run 3", "Sled Pull". */
  label: string;
  /** 1 to 8: run k, or the k-th station. */
  legNumber: number;
  station?: HyroxStation;
  /** The leg's split, whole seconds. */
  splitSec: number;
  /** Race clock at the end of the leg, whole seconds. */
  clockSec: number;
}

export interface HyroxRacePlanCheckpoint {
  /** "Run 1" to "Run 8", then "Finish". */
  label: string;
  clockSec: number;
}

/** 16 legs in race order with the race clock, the Roxzone, the checkpoints. */
export interface HyroxRaceClock {
  legs: HyroxRaceClockLeg[];
  roxzoneSec: number;
  /** Race clock after each run, then the finish. */
  checkpoints: HyroxRacePlanCheckpoint[];
  /** The finish: the legs and the Roxzone together. */
  totalSec: number;
}

export interface HyroxRacePlanLeg extends HyroxRaceClockLeg {
  /** The forecast's own split for this leg (hyroxForecastRaceClock). */
  forecastSec: number;
}

export interface HyroxRacePlan {
  /** The athlete's goal; null when none is set. */
  goalSec: number | null;
  /** What the splits are: the goal's, or the forecast's own lines (no goal,
   *  or a goal the floors cannot reach). */
  basis: 'goal' | 'forecast';
  /** predictHyroxRace().totalSec. */
  forecastSec: number;
  /** What the splits sum to: the goal, or the forecast. */
  planSec: number;
  /** The goal against the floors; null without a goal. */
  feasibility: GoalBackCalcResult['feasibility'] | null;
  shortfallSec: number;
  /** The back-calculation's caveat (stretch and unrealistic goals). */
  caveat: string | null;
  /** 16 legs in race order. */
  legs: HyroxRacePlanLeg[];
  roxzone: { splitSec: number; forecastSec: number };
  /** Race clock after each run, then the finish. */
  checkpoints: HyroxRacePlanCheckpoint[];
  isDoubles: boolean;
  cohort: HyroxResultsCohort;
}

/**
 * The options computeGoalBackCalc reads for this athlete: floors from the
 * athlete's own field (run, stations and Roxzone) and the Roxzone at the
 * goal. The one source for the race plan and the goal modal, so both show
 * the same targets.
 */
export function hyroxGoalBackCalcOptions(
  state: SimulatorState,
  prediction: Pick<HyroxPrediction, 'totalSec' | 'roxzoneSec'>,
  goalSec: number,
): GoalBackCalcOptions {
  const cohort = hyroxCohortForState(state);
  const floors = hyroxCompetitiveFloors(cohort);
  const roxzoneTargetSec = hyroxRoxzoneAtGoalSec(cohort, prediction, goalSec);
  return {
    ...(floors ? { floors: { stationSec: floors.stationSec, runSec: floors.runSec, roxzoneSec: floors.roxzoneSec, fastest: floors.fastest } } : {}),
    ...(roxzoneTargetSec != null ? { roxzoneTargetSec } : {}),
  };
}

/** The forecast's Roxzone scaled to the goal by the real results: forecast x
 *  peer Roxzone at the goal / peer Roxzone at the forecast. Null without a
 *  peer table. computeGoalBackCalc floors it (GoalBackCalcFloors.roxzoneSec). */
export function hyroxRoxzoneAtGoalSec(
  cohort: HyroxResultsCohort,
  prediction: Pick<HyroxPrediction, 'totalSec' | 'roxzoneSec'>,
  goalSec: number,
): number | null {
  const atGoal = hyroxPeerSplitsAt(cohort, goalSec);
  const atForecast = hyroxPeerSplitsAt(cohort, prediction.totalSec);
  if (!atGoal || !atForecast || !(atForecast.segments.roxzone > 0)) return null;
  return prediction.roxzoneSec * (atGoal.segments.roxzone / atForecast.segments.roxzone);
}

/** Round non-negative values to whole numbers that sum to `total` (largest
 *  remainder). */
export function roundToTotal(values: number[], total: number): number[] {
  const floors = values.map(v => Math.floor(v));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = values
    .map((v, i) => ({ i, r: v - Math.floor(v) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  const out = [...floors];
  for (let j = 0; left > 0 && order.length > 0; j = (j + 1) % order.length, left--) out[order[j].i] += 1;
  // Only when the values sum above `total`: take from the largest.
  while (left < 0) {
    const iMax = out.indexOf(Math.max(...out));
    if (out[iMax] <= 0) break;
    out[iMax] -= 1;
    left += 1;
  }
  return out;
}

/**
 * The race clock for whole-second splits: run k then station k, the Roxzone
 * spread evenly over the 8 station visits, half before and half after each
 * (the last half lands at the finish).
 */
export function hyroxRaceClock(
  runLegsSec: readonly number[],
  stationSec: Readonly<Record<HyroxStation, number>>,
  roxzoneSec: number,
): HyroxRaceClock {
  const shares = roundToTotal(new Array(8).fill(roxzoneSec / 8), roxzoneSec);
  const before = shares.map(sh => Math.floor(sh / 2));
  const after = shares.map((sh, i) => sh - before[i]);
  const legs: HyroxRaceClockLeg[] = [];
  const checkpoints: HyroxRacePlanCheckpoint[] = [];
  let clock = 0;
  for (let k = 0; k < 8; k++) {
    if (k > 0) clock += after[k - 1];
    const runSec = runLegsSec[k] ?? 0;
    clock += runSec;
    legs.push({ kind: 'run', label: `Run ${k + 1}`, legNumber: k + 1, splitSec: runSec, clockSec: clock });
    checkpoints.push({ label: `Run ${k + 1}`, clockSec: clock });
    const st = HYROX_STATION_ORDER[k];
    const stSec = stationSec[st] ?? 0;
    clock += before[k] + stSec;
    if (k === 7) clock += after[7];
    legs.push({ kind: 'station', label: STATION_DISPLAY[st].name, legNumber: k + 1, station: st, splitSec: stSec, clockSec: clock });
  }
  checkpoints.push({ label: 'Finish', clockSec: clock });
  return { legs, roxzoneSec, checkpoints, totalSec: clock };
}

/**
 * The forecast's race clock: predictHyroxRace's own lines as they are (each
 * run leg's durationSec, each station's adjustedSec), the Roxzone taking the
 * rounding remainder (totalSec minus the 16 lines) so the clock ends on the
 * forecast. The one forecast clock: the race plan and the Forecast tab's Race
 * order card both read it.
 */
export function hyroxForecastRaceClock(
  prediction: Pick<HyroxPrediction, 'totalSec' | 'runSec' | 'runLegs' | 'stations'>,
): HyroxRaceClock {
  const runLegsSec = Array.from({ length: 8 }, (_, k) => {
    const leg = prediction.runLegs[k];
    return Math.round(leg ? leg.durationSec : prediction.runSec / 8);
  });
  const stationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) {
    stationSec[st] = Math.round(prediction.stations.find(l => l.station === st)?.adjustedSec ?? 0);
  }
  const lines = runLegsSec.reduce((a, b) => a + b, 0) + HYROX_STATION_ORDER.reduce((a, st) => a + stationSec[st], 0);
  const roxzoneSec = Math.max(0, Math.round(prediction.totalSec) - lines);
  return hyroxRaceClock(runLegsSec, stationSec, roxzoneSec);
}

interface Components {
  runSec: number;
  stationSec: Record<HyroxStation, number>;
  roxzoneSec: number;
}

function forecastComponents(prediction: HyroxPrediction): Components {
  const stationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) {
    stationSec[st] = prediction.stations.find(l => l.station === st)?.adjustedSec ?? 0;
  }
  return { runSec: prediction.runSec, stationSec, roxzoneSec: prediction.roxzoneSec };
}

function componentsSum(c: Components): number {
  return c.runSec + HYROX_STATION_ORDER.reduce((a, st) => a + c.stationSec[st], 0) + c.roxzoneSec;
}

function scaleComponents(c: Components, totalSec: number): Components {
  const sum = componentsSum(c);
  const k = sum > 0 ? totalSec / sum : 1;
  const stationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) stationSec[st] = c.stationSec[st] * k;
  return { runSec: c.runSec * k, stationSec, roxzoneSec: c.roxzoneSec * k };
}

/** Goal slower than the forecast: each component eased by the peer ratio
 *  between the goal and the forecast, segment by segment. */
function easedComponents(prediction: HyroxPrediction, cohort: HyroxResultsCohort, goalSec: number): Components {
  const fc = forecastComponents(prediction);
  const atGoal = hyroxPeerSplitsAt(cohort, goalSec);
  const atForecast = hyroxPeerSplitsAt(cohort, prediction.totalSec);
  const ratio = (seg: HyroxPeerSegment): number =>
    atGoal && atForecast && atForecast.segments[seg] > 0 ? atGoal.segments[seg] / atForecast.segments[seg] : 1;
  const stationSec = {} as Record<HyroxStation, number>;
  for (const st of HYROX_STATION_ORDER) stationSec[st] = fc.stationSec[st] * ratio(st);
  return { runSec: fc.runSec * ratio('run_total'), stationSec, roxzoneSec: fc.roxzoneSec * ratio('roxzone') };
}

/** Whole-second splits for components summing to `totalSec`: the run split
 *  over the 8 legs with the forecast's own per-leg fatigue shape. */
function clockForComponents(prediction: HyroxPrediction, comps: Components, totalSec: number): HyroxRaceClock {
  const scaled = scaleComponents(comps, totalSec);
  const mults = prediction.runLegs.length === 8
    ? prediction.runLegs.map(l => l.fatigueMultiplier)
    : new Array(8).fill(1);
  const multSum = mults.reduce((a, b) => a + b, 0);
  const runLegs = mults.map(m => scaled.runSec * (m / multSum));
  // Race order: run k, station k, then the Roxzone. Round so the 17 values
  // sum to the total.
  const values: number[] = [];
  for (let k = 0; k < 8; k++) values.push(runLegs[k], scaled.stationSec[HYROX_STATION_ORDER[k]]);
  values.push(scaled.roxzoneSec);
  const whole = roundToTotal(values, totalSec);
  const stationSec = {} as Record<HyroxStation, number>;
  HYROX_STATION_ORDER.forEach((st, k) => { stationSec[st] = whole[2 * k + 1]; });
  return hyroxRaceClock(Array.from({ length: 8 }, (_, k) => whole[2 * k]), stationSec, whole[16]);
}

/**
 * The race plan for the athlete's goal (hyroxConfig.targetFinishTimeSec), or
 * the forecast's own lines when no goal is set or the goal is out of reach.
 * `prediction` is predictHyroxRace's result for the same state; its numbers
 * fill the forecast column as they are.
 */
export function buildHyroxRacePlan(state: SimulatorState, prediction: HyroxPrediction): HyroxRacePlan {
  const target = state.hyroxConfig?.targetFinishTimeSec;
  const goalSec = target != null && target > 0 ? target : null;
  const cohort = hyroxCohortForState(state);
  const isDoubles = isHyroxDoublesFormat(state.hyroxConfig?.format);
  const forecast = hyroxForecastRaceClock(prediction);

  let clock = forecast;
  let basis: HyroxRacePlan['basis'] = 'forecast';
  let feasibility: HyroxRacePlan['feasibility'] = null;
  let shortfallSec = 0;
  let caveat: string | null = null;
  if (goalSec != null && goalSec < prediction.totalSec) {
    const back = computeGoalBackCalc(prediction, goalSec, hyroxGoalBackCalcOptions(state, prediction, goalSec));
    feasibility = back.feasibility;
    shortfallSec = back.shortfallSec;
    caveat = back.caveat;
    if (back.feasibility !== 'unrealistic') {
      const stationSec = {} as Record<HyroxStation, number>;
      for (const st of HYROX_STATION_ORDER) {
        stationSec[st] = back.stationTargets.find(t => t.station === st)?.targetSec ?? 0;
      }
      const comps = { runSec: back.runPaceTarget.targetSecKm * 8, stationSec, roxzoneSec: back.roxzoneSec };
      clock = clockForComponents(prediction, comps, Math.round(goalSec));
      basis = 'goal';
    }
  } else if (goalSec != null) {
    feasibility = 'already_on_pace';
    basis = 'goal';
    if (goalSec > prediction.totalSec) {
      clock = clockForComponents(prediction, easedComponents(prediction, cohort, goalSec), Math.round(goalSec));
    }
  }

  const legs: HyroxRacePlanLeg[] = clock.legs.map((l, i) => ({ ...l, forecastSec: forecast.legs[i].splitSec }));
  return {
    goalSec,
    basis,
    forecastSec: prediction.totalSec,
    planSec: clock.totalSec,
    feasibility,
    shortfallSec,
    caveat,
    legs,
    roxzone: { splitSec: clock.roxzoneSec, forecastSec: forecast.roxzoneSec },
    checkpoints: clock.checkpoints,
    isDoubles,
    cohort,
  };
}
