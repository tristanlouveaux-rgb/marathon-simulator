/**
 * HYROX goal-back-calculation.
 *
 * **Side**: tracking + planning. Inverts the prediction: given a target
 * finish time, what per-station and per-run-pace times does the athlete need?
 *
 * Algorithm (headroom-weighted distribution per ISSUE-196):
 *   1. Compute total gain needed: prediction.totalSec - targetSec, less what
 *      the Roxzone gives at the goal (opts.roxzoneTargetSec).
 *   2. For each component (8 stations + run pace bucket), compute headroom =
 *      current - floor.
 *   3. Distribute gain proportional to headroom share.
 *   4. If allocated gain exceeds a component's headroom, cap at floor and
 *      redistribute the excess to remaining components.
 *   5. If total headroom can't cover the gain, flag as 'unrealistic'.
 *
 * Floors (opts.floors): the athlete's own field, per format and sex or
 * doubles division (hyroxCompetitiveFloors in hyrox-results.ts; the pair's
 * times for doubles), passed by hyroxGoalBackCalcOptions (hyrox-race-plan.ts).
 * Per component: the median split of the top 1% of finishers while the
 * forecast is slower than it; once the forecast is at or past that median,
 * the fastest split the cohort's table publishes (its p1 row, opts.floors
 * .fastest), never the forecast itself, so a top-band athlete keeps headroom.
 * The floors are venue-neutral results, so headroom is measured on the
 * forecast's venue-neutral lines: each floor carries the line's own venue
 * seconds (station adjustedSec - baseSec; the run, runSec less the pre-venue
 * run). Without opts.floors the legacy floors stand:
 * `STATION_SEED_TIMES_SEC['competitive']` (Open, sexes pooled) x the line's
 * doubles ratio, and `HYROX_RUN_PACE_MIN_SEC_KM` x 8.
 *
 * Roxzone: held at the forecast's unless opts.roxzoneTargetSec gives the
 * Roxzone at the goal (the race plan scales it with finish time from the
 * real results). It never absorbs more than the whole gain, and never goes
 * below its tier floor (the cohort's top-1% Roxzone median, or its fastest
 * published Roxzone once the forecast is at or past that median), and a
 * floor never lifts it above the forecast's own Roxzone. When every
 * other component sits at its floor and the goal is still out of reach, the
 * Roxzone gives up to its own floor, so the fastest time the floors allow
 * (achievedSec) is the floor sum whatever the goal.
 */

import type { HyroxPrediction } from './race-prediction.hyrox';
import type { HyroxStation } from '@/types/triathlon';
import { STATION_SEED_TIMES_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';

export interface GoalStationTarget {
  station: HyroxStation;
  currentSec: number;
  targetSec: number;
  deltaSec: number; // negative = needs to get faster
  source: 'calibrated' | 'seed';
}

export interface GoalRunPaceTarget {
  /** Current pace per km, blended across 8 legs (pre-fatigue, pre-venue). */
  currentSecKm: number;
  targetSecKm: number;
  deltaSecKm: number;
}

/** One tier of floors, venue-neutral, in the forecast lines' own terms (the
 *  pair's time for doubles). */
export interface GoalBackCalcFloorTier {
  stationSec: Partial<Record<HyroxStation, number>>;
  /** The 8 run legs together. */
  runSec: number;
  /** The Roxzone floor. Without it the Roxzone has no floor beyond the
   *  whole-gain clamp. */
  roxzoneSec?: number;
}

/** Floors from the athlete's own field: the top-1% medians, and the fastest
 *  published split for a component the forecast already has at or past its
 *  median. */
export interface GoalBackCalcFloors extends GoalBackCalcFloorTier {
  fastest?: GoalBackCalcFloorTier;
}

export interface GoalBackCalcOptions {
  floors?: GoalBackCalcFloors;
  /** Roxzone at the goal. Default: held at the forecast's. */
  roxzoneTargetSec?: number;
}

export interface GoalBackCalcResult {
  feasibility: 'already_on_pace' | 'achievable' | 'stretch' | 'unrealistic';
  gainNeededSec: number;
  totalHeadroomSec: number;
  stationTargets: GoalStationTarget[];
  runPaceTarget: GoalRunPaceTarget;
  /** Roxzone at the goal: the forecast's, or opts.roxzoneTargetSec. */
  roxzoneSec: number;
  /** Total of (run + stations + roxzone) at the calculated targets — should
   *  equal targetTotalSec for achievable goals; less than target for unrealistic
   *  ones (caller can surface the gap). */
  achievedSec: number;
  /** Remaining gap when the gain is unachievable from headroom alone. */
  shortfallSec: number;
  /** Caveat copy if any (e.g. "this is a stretch goal, most athletes..."). */
  caveat: string | null;
  /** 'cohort': floors from the athlete's own field (opts.floors); 'legacy':
   *  the pooled Open competitive seed and the run-pace minimum. */
  floorSource: 'cohort' | 'legacy';
}

interface ComponentSlot {
  kind: 'station' | 'run';
  station?: HyroxStation;
  currentSec: number;
  floorSec: number;
}

export function computeGoalBackCalc(
  prediction: HyroxPrediction,
  targetTotalSec: number,
  opts: GoalBackCalcOptions = {},
): GoalBackCalcResult {
  const stationLines = prediction.stations;
  const currentRunSec = prediction.runSec; // post-venue, post-fatigue
  const floors = opts.floors;
  const floorSource: GoalBackCalcResult['floorSource'] = floors ? 'cohort' : 'legacy';
  const totalGain = prediction.totalSec - targetTotalSec;
  // The tier for one component: the top-1% median while the venue-neutral
  // forecast is slower than it, else the fastest published split.
  const tierFloor = (neutralSec: number, median: number, fastest: number | undefined): number =>
    neutralSec > median ? median : (fastest ?? median);
  // The run's venue seconds: runSec less the pre-venue run (rawSec is the
  // pre-venue run + stations + Roxzone; the Roxzone takes no venue factor).
  const rawRunSec = prediction.rawSec - stationLines.reduce((sum, l) => sum + l.baseSec, 0) - prediction.roxzoneSec;
  const runVenueSec = prediction.courseFactors?.length && rawRunSec > 0 ? currentRunSec - rawRunSec : 0;
  // Roxzone floor (no venue factor), never above the forecast's own Roxzone.
  const roxzoneFloorSec = floors?.roxzoneSec != null
    ? Math.min(prediction.roxzoneSec, tierFloor(prediction.roxzoneSec, floors.roxzoneSec, floors.fastest?.roxzoneSec))
    : null;
  // Roxzone at the goal, never absorbing more than the whole gain and never
  // below its floor.
  let roxzoneSec = opts.roxzoneTargetSec != null && totalGain > 0
    ? Math.max(opts.roxzoneTargetSec, prediction.roxzoneSec - totalGain, roxzoneFloorSec ?? -Infinity)
    : prediction.roxzoneSec;

  // Floor for the run: the field's tier floor plus the run's venue seconds,
  // else 8 legs at the legacy minimum pace.
  const runFloorSec = floors
    ? tierFloor(currentRunSec - runVenueSec, floors.runSec, floors.fastest?.runSec) + runVenueSec
    : HYROX_RUN_PACE_MIN_SEC_KM * 8;

  // Component slots. Each row gets a `currentSec` and a `floorSec`. We
  // distribute the gain proportionally to headroom across these.
  const slots: ComponentSlot[] = [
    { kind: 'run', currentSec: currentRunSec, floorSec: runFloorSec },
    ...stationLines.map(line => ({
      kind: 'station' as const,
      station: line.station,
      currentSec: line.adjustedSec,
      // Cohort floors are already in the line's terms (tiered on the
      // venue-neutral line, plus the line's venue seconds). Legacy floors are
      // singles seed times; a doubles line is the pair's time, so its floor
      // scales by the same doubles ratio (teamRatio, absent = 1).
      floorSec: floors?.stationSec[line.station] != null
        ? tierFloor(line.baseSec, floors.stationSec[line.station]!, floors.fastest?.stationSec[line.station])
          + (line.adjustedSec - line.baseSec)
        : STATION_SEED_TIMES_SEC.competitive[line.station] * (line.teamRatio ?? 1),
    })),
  ];

  // The gain run and stations must find, measured from the components' own
  // sum (the forecast rounds the run and each station line separately, so
  // their sum can sit a few seconds off totalSec, and measuring from totalSec
  // left an achievable goal a few seconds short: 'unrealistic'), less what
  // the Roxzone gives at the goal.
  const componentsSec = currentRunSec
    + stationLines.reduce((sum, l) => sum + l.adjustedSec, 0)
    + prediction.roxzoneSec;
  const gainNeeded = Math.max(0, componentsSec - targetTotalSec - (prediction.roxzoneSec - roxzoneSec));

  // Already on pace. No work needed.
  if (totalGain <= 0) {
    return {
      feasibility: 'already_on_pace',
      gainNeededSec: 0,
      totalHeadroomSec: 0,
      stationTargets: stationLines.map(l => ({
        station: l.station,
        currentSec: l.adjustedSec,
        targetSec: l.adjustedSec,
        deltaSec: 0,
        source: l.source,
      })),
      runPaceTarget: {
        currentSecKm: currentRunSec / 8,
        targetSecKm: currentRunSec / 8,
        deltaSecKm: 0,
      },
      roxzoneSec,
      achievedSec: prediction.totalSec,
      shortfallSec: 0,
      caveat: null,
      floorSource,
    };
  }

  // Compute headroom per slot. Negative headroom (current already at/below
  // floor) clamps to zero. That slot can't contribute.
  const headrooms = slots.map(s => Math.max(0, s.currentSec - s.floorSec));
  const totalHeadroom = headrooms.reduce((sum, h) => sum + h, 0);

  // Distribute the gain proportionally. If a slot's allocated gain exceeds
  // its headroom, cap at floor and redistribute the excess. Loop until
  // converged or all slots are capped.
  const allocated = new Array<number>(slots.length).fill(0);
  let remainingGain = Math.min(gainNeeded, totalHeadroom);
  const capped = new Array<boolean>(slots.length).fill(false);

  // Bounded loop. Each iteration either fully allocates or caps at least
  // one slot. Max iterations = slot count.
  for (let iter = 0; iter < slots.length + 1 && remainingGain > 0.5; iter += 1) {
    const remainingHeadroom = headrooms.reduce(
      (sum, h, i) => sum + (capped[i] ? 0 : Math.max(0, h - allocated[i])),
      0,
    );
    if (remainingHeadroom <= 0) break;

    // Capture the gain to allocate THIS iteration once. Without this the
    // per-slot share formula uses a `remainingGain` that decreases as we
    // walk slots, so later slots get less than their proportional share
    // and we end up under-allocating each iteration.
    const iterationGain = remainingGain;
    let cappedThisRound = false;
    let consumedThisIter = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (capped[i]) continue;
      const slotRemaining = headrooms[i] - allocated[i];
      const share = (slotRemaining / remainingHeadroom) * iterationGain;
      const newAllocated = allocated[i] + share;
      if (newAllocated >= headrooms[i] - 0.01) {
        // Cap at floor; the leftover goes to the next iteration.
        const actuallyTaken = headrooms[i] - allocated[i];
        allocated[i] = headrooms[i];
        consumedThisIter += actuallyTaken;
        capped[i] = true;
        cappedThisRound = true;
      } else {
        allocated[i] = newAllocated;
        consumedThisIter += share;
      }
    }
    remainingGain -= consumedThisIter;
    if (!cappedThisRound) break; // converged. No overshoot to redistribute
  }

  // Build per-component targets.
  const runSlot = slots[0];
  const runAllocated = allocated[0];
  const runTargetSec = runSlot.currentSec - runAllocated;
  const runPaceTarget: GoalRunPaceTarget = {
    currentSecKm: runSlot.currentSec / 8,
    targetSecKm: runTargetSec / 8,
    deltaSecKm: -(runAllocated / 8),
  };

  const stationTargets: GoalStationTarget[] = stationLines.map((line, idx) => {
    const slotIdx = idx + 1; // slots[0] is run
    const alloc = allocated[slotIdx];
    return {
      station: line.station,
      currentSec: line.adjustedSec,
      targetSec: line.adjustedSec - alloc,
      deltaSec: -alloc,
      source: line.source,
    };
  });

  let achievedSec = runTargetSec
    + stationTargets.reduce((sum, t) => sum + t.targetSec, 0)
    + roxzoneSec;
  // Run and stations all at their floors and the goal still out of reach:
  // the Roxzone gives up to its own floor, so the fastest time the floors
  // allow is the floor sum, whatever the goal.
  if (totalGain > 0 && roxzoneFloorSec != null && achievedSec - targetTotalSec > 0.5 && roxzoneSec > roxzoneFloorSec) {
    const give = Math.min(achievedSec - targetTotalSec, roxzoneSec - roxzoneFloorSec);
    roxzoneSec -= give;
    achievedSec -= give;
  }
  // Shortfall = achieved - target when we couldn't get fast enough (achieved > target).
  // The reverse direction (achieved < target, i.e. achieved is faster than asked)
  // is impossible because we cap allocations at headroom.
  const shortfallSec = (achievedSec - targetTotalSec) > 0.5
    ? Math.round(achievedSec - targetTotalSec)
    : 0;

  let feasibility: GoalBackCalcResult['feasibility'];
  let caveat: string | null = null;
  if (shortfallSec > 0) {
    feasibility = 'unrealistic';
    caveat = floors
      ? `No realistic combination of station and run gains reaches this time. Every station${floors.roxzoneSec != null ? ', the run and the Roxzone' : ' and the run'} would have to be faster than top-1% level in your field. Pick a more achievable goal or extend training time.`
      : `No realistic combination of station and run-pace gains reaches this time. The estimate uses the competitive population floor across all stations and run pace. Pick a more achievable goal or extend training time.`;
  } else if (gainNeeded > totalHeadroom * 0.7) {
    feasibility = 'stretch';
    caveat = 'Most athletes would need 6+ months of focused training to hit a goal this aggressive.';
  } else {
    feasibility = 'achievable';
  }

  return {
    feasibility,
    gainNeededSec: gainNeeded,
    totalHeadroomSec: totalHeadroom,
    stationTargets,
    runPaceTarget,
    roxzoneSec,
    achievedSec,
    shortfallSec,
    caveat,
    floorSource,
  };
}
