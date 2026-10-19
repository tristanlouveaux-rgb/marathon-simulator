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
 *    division, the pair's times for doubles) and the Roxzone at the goal
 *    scaled from the forecast's by the real results (below).
 *  - Goal slower than (or equal to) the forecast: each component is the
 *    forecast's, eased by how finishers at the goal time differ from
 *    finishers at the forecast time (hyroxPeerSplitsAt, segment by segment),
 *    then scaled to sum to the goal.
 *  - No goal: the forecast is the plan's target.
 *
 * Roxzone at the goal: forecast Roxzone x peer Roxzone at the goal / peer
 * Roxzone at the forecast (hyroxPeerSplitsAt in the target's cohort). Finishers
 * at 1:20 spend far less time in the Roxzone than finishers at 1:40, so it is
 * no longer held constant; the ratio keeps the forecast's own Roxzone when the
 * goal equals the forecast.
 *
 * Run legs: the goal run total split with the forecast's per-leg fatigue model
 * (prediction.runLegs[].fatigueMultiplier, PER_STATION_FATIGUE_RATE_BY_BAND),
 * so a goal leg and its forecast leg differ only by the goal, never by shape.
 *
 * Race clock: whole seconds, legs rounded so they sum exactly to the plan
 * total. The Roxzone is spread evenly around the 8 stations, half before and
 * half after each one (the last half lands at the finish), so the clock after
 * Wall Balls is the finish time.
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

export interface HyroxRacePlanLeg {
  kind: 'run' | 'station';
  /** "Run 3", "Sled Pull". */
  label: string;
  /** 1 to 8: run k, or the k-th station. */
  legNumber: number;
  station?: HyroxStation;
  /** Goal split, whole seconds. */
  goalSec: number;
  /** Race clock at the end of the leg, whole seconds. */
  clockSec: number;
  /** The forecast's own split (predictHyroxRace), whole seconds. */
  forecastSec: number;
}

export interface HyroxRacePlanCheckpoint {
  /** "Run 1" to "Run 8", then "Finish". */
  label: string;
  clockSec: number;
}

export interface HyroxRacePlan {
  /** The athlete's goal, or the forecast when no goal is set. */
  goalSec: number;
  goalSource: 'goal' | 'forecast';
  /** predictHyroxRace().totalSec. */
  forecastSec: number;
  /** What the splits sum to: the goal, or for an unrealistic goal the fastest
   *  the floors allow (back-calc achievedSec). */
  planSec: number;
  feasibility: GoalBackCalcResult['feasibility'];
  shortfallSec: number;
  /** 16 legs in race order. */
  legs: HyroxRacePlanLeg[];
  roxzone: { goalSec: number; forecastSec: number };
  /** Race clock after each run, then the finish. */
  checkpoints: HyroxRacePlanCheckpoint[];
  isDoubles: boolean;
  cohort: HyroxResultsCohort;
}

/**
 * The options computeGoalBackCalc reads for this athlete: floors from the
 * athlete's own field and the Roxzone at the goal. The one source for the
 * race plan and the goal modal, so both show the same targets.
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
    ...(floors ? { floors: { stationSec: floors.stationSec, runSec: floors.runSec } } : {}),
    ...(roxzoneTargetSec != null ? { roxzoneTargetSec } : {}),
  };
}

/** The forecast's Roxzone scaled to the goal by the real results: forecast x
 *  peer Roxzone at the goal / peer Roxzone at the forecast. Null without a
 *  peer table. */
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

/** The fastest finish the floors allow for this forecast: each component at
 *  its floor, or at the forecast where that is already faster. The goal
 *  modal's plausibility threshold for reading "1:05" as hours. */
export function hyroxGoalFloorSec(state: SimulatorState, prediction: HyroxPrediction): number {
  const cohort = hyroxCohortForState(state);
  const floors = hyroxCompetitiveFloors(cohort);
  if (!floors) return 0;
  const stations = prediction.stations.reduce(
    (sum, l) => sum + Math.min(l.adjustedSec, floors.stationSec[l.station] ?? l.adjustedSec),
    0,
  );
  return Math.min(prediction.runSec, floors.runSec) + stations + Math.min(prediction.roxzoneSec, floors.roxzoneSec);
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

/**
 * The race plan for the athlete's goal (hyroxConfig.targetFinishTimeSec), or
 * for the forecast when no goal is set. `prediction` is predictHyroxRace's
 * result for the same state; its numbers fill the forecast columns as is.
 */
export function buildHyroxRacePlan(state: SimulatorState, prediction: HyroxPrediction): HyroxRacePlan {
  const target = state.hyroxConfig?.targetFinishTimeSec;
  const goalSource: HyroxRacePlan['goalSource'] = target != null && target > 0 ? 'goal' : 'forecast';
  const goalSec = goalSource === 'goal' ? (target as number) : prediction.totalSec;
  const cohort = hyroxCohortForState(state);
  const isDoubles = isHyroxDoublesFormat(state.hyroxConfig?.format);

  let comps: Components;
  let planSec = goalSec;
  let feasibility: GoalBackCalcResult['feasibility'] = 'already_on_pace';
  let shortfallSec = 0;
  if (goalSec < prediction.totalSec) {
    const back = computeGoalBackCalc(prediction, goalSec, hyroxGoalBackCalcOptions(state, prediction, goalSec));
    feasibility = back.feasibility;
    shortfallSec = back.shortfallSec;
    const stationSec = {} as Record<HyroxStation, number>;
    for (const st of HYROX_STATION_ORDER) {
      stationSec[st] = back.stationTargets.find(t => t.station === st)?.targetSec ?? 0;
    }
    comps = { runSec: back.runPaceTarget.targetSecKm * 8, stationSec, roxzoneSec: back.roxzoneSec };
    if (back.feasibility === 'unrealistic') planSec = back.achievedSec;
  } else if (goalSource === 'goal') {
    comps = easedComponents(prediction, cohort, goalSec);
  } else {
    comps = forecastComponents(prediction);
  }
  const planTotal = Math.round(planSec);
  comps = scaleComponents(comps, planTotal);

  // Run legs with the forecast's own fatigue shape.
  const mults = prediction.runLegs.length === 8
    ? prediction.runLegs.map(l => l.fatigueMultiplier)
    : new Array(8).fill(1);
  const multSum = mults.reduce((a, b) => a + b, 0);
  const runLegs = mults.map(m => comps.runSec * (m / multSum));

  // Race order: run k, station k. Round so the 17 values sum to the plan.
  const values: number[] = [];
  for (let k = 0; k < 8; k++) {
    values.push(runLegs[k], comps.stationSec[HYROX_STATION_ORDER[k]]);
  }
  values.push(comps.roxzoneSec);
  const whole = roundToTotal(values, planTotal);
  const roxzoneGoal = whole[16];
  // Roxzone around each station: half before, half after.
  const shares = roundToTotal(new Array(8).fill(roxzoneGoal / 8), roxzoneGoal);
  const before = shares.map(sh => Math.floor(sh / 2));
  const after = shares.map((sh, i) => sh - before[i]);

  const legs: HyroxRacePlanLeg[] = [];
  const checkpoints: HyroxRacePlanCheckpoint[] = [];
  let clock = 0;
  for (let k = 0; k < 8; k++) {
    if (k > 0) clock += after[k - 1];
    const runSec = whole[2 * k];
    clock += runSec;
    const fcLeg = prediction.runLegs[k];
    legs.push({
      kind: 'run', label: `Run ${k + 1}`, legNumber: k + 1,
      goalSec: runSec, clockSec: clock,
      forecastSec: fcLeg ? Math.round(fcLeg.durationSec) : Math.round(prediction.runSec / 8),
    });
    checkpoints.push({ label: `Run ${k + 1}`, clockSec: clock });
    const st = HYROX_STATION_ORDER[k];
    const stSec = whole[2 * k + 1];
    clock += before[k] + stSec;
    if (k === 7) clock += after[7];
    legs.push({
      kind: 'station', label: STATION_DISPLAY[st].name, legNumber: k + 1, station: st,
      goalSec: stSec, clockSec: clock,
      forecastSec: Math.round(prediction.stations.find(l => l.station === st)?.adjustedSec ?? 0),
    });
  }
  checkpoints.push({ label: 'Finish', clockSec: clock });

  return {
    goalSec,
    goalSource,
    forecastSec: prediction.totalSec,
    planSec: planTotal,
    feasibility,
    shortfallSec,
    legs,
    roxzone: { goalSec: roxzoneGoal, forecastSec: Math.round(prediction.roxzoneSec) },
    checkpoints,
    isDoubles,
    cohort,
  };
}
