/**
 * HYROX goal-back-calculation.
 *
 * **Side**: tracking + planning. Inverts the prediction: given a target
 * finish time, what per-station and per-run-pace times does the athlete need?
 *
 * Algorithm (headroom-weighted distribution per ISSUE-196):
 *   1. Compute total gain needed: prediction.totalSec - targetSec.
 *   2. For each component (8 stations + run pace bucket), compute headroom =
 *      current - floor. Floor for stations = `competitive` band seed;
 *      floor for run pace = HYROX_RUN_PACE_MIN_SEC_KM × 8 legs.
 *   3. Distribute gain proportional to headroom share.
 *   4. If allocated gain exceeds a component's headroom, cap at floor and
 *      redistribute the excess to remaining components.
 *   5. If total headroom can't cover the gain, flag as 'unrealistic'.
 *
 * No new constants — `STATION_SEED_TIMES_SEC['competitive']` and
 * `HYROX_RUN_PACE_MIN_SEC_KM` are reused as practical floors.
 *
 * Roxzone is held constant — it's a small slice (~3 min on a 75-min total)
 * and not really trainable in isolation.
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

export interface GoalBackCalcResult {
  feasibility: 'already_on_pace' | 'achievable' | 'stretch' | 'unrealistic';
  gainNeededSec: number;
  totalHeadroomSec: number;
  stationTargets: GoalStationTarget[];
  runPaceTarget: GoalRunPaceTarget;
  /** Roxzone is held at current — listed for completeness. */
  roxzoneSec: number;
  /** Total of (run + stations + roxzone) at the calculated targets — should
   *  equal targetTotalSec for achievable goals; less than target for unrealistic
   *  ones (caller can surface the gap). */
  achievedSec: number;
  /** Remaining gap when the gain is unachievable from headroom alone. */
  shortfallSec: number;
  /** Caveat copy if any (e.g. "this is a stretch goal — most athletes…"). */
  caveat: string | null;
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
): GoalBackCalcResult {
  const stationLines = prediction.stations;
  const currentRunSec = prediction.runSec; // post-venue, post-fatigue
  const roxzoneSec = prediction.roxzoneSec;

  // Floor for run pace = 8 legs at the band-elite minimum.
  const runFloorSec = HYROX_RUN_PACE_MIN_SEC_KM * 8;

  // Component slots — each row gets a `currentSec` and a `floorSec`. We
  // distribute the gain proportionally to headroom across these.
  const slots: ComponentSlot[] = [
    { kind: 'run', currentSec: currentRunSec, floorSec: runFloorSec },
    ...stationLines.map(line => ({
      kind: 'station' as const,
      station: line.station,
      currentSec: line.adjustedSec,
      floorSec: STATION_SEED_TIMES_SEC.competitive[line.station],
    })),
  ];

  const gainNeeded = prediction.totalSec - targetTotalSec;

  // Already on pace — no work needed.
  if (gainNeeded <= 0) {
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
    };
  }

  // Compute headroom per slot. Negative headroom (current already at/below
  // floor) clamps to zero — that slot can't contribute.
  const headrooms = slots.map(s => Math.max(0, s.currentSec - s.floorSec));
  const totalHeadroom = headrooms.reduce((sum, h) => sum + h, 0);

  // Distribute the gain proportionally. If a slot's allocated gain exceeds
  // its headroom, cap at floor and redistribute the excess. Loop until
  // converged or all slots are capped.
  const allocated = new Array<number>(slots.length).fill(0);
  let remainingGain = Math.min(gainNeeded, totalHeadroom);
  const capped = new Array<boolean>(slots.length).fill(false);

  // Bounded loop — each iteration either fully allocates or caps at least
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
    if (!cappedThisRound) break; // converged — no overshoot to redistribute
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

  const achievedSec = runTargetSec
    + stationTargets.reduce((sum, t) => sum + t.targetSec, 0)
    + roxzoneSec;
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
    caveat = `This target requires ~${shortfallSec}s of gain beyond what's realistic from the population floor across all stations and run pace. Pick a more achievable goal or extend training time.`;
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
  };
}
