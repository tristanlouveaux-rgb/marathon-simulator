/**
 * Tests for the v2 cross-training overload detector.
 *
 * v2 changes from v1:
 *  - Returns `CrossTrainingOverloadResult` with per-discipline `options`
 *    instead of a single target workout.
 *  - Severity vocabulary: 'heavy' | 'extreme' (not 'caution' | 'warning').
 *  - Membership filter (anything not in triWorkouts is overload), so a
 *    planned `cross`/`gym` session in the plan no longer trips the detector.
 *  - Recommended discipline = highest remaining planned TSS.
 *  - Per-discipline floor enforcement via `computeTriDisciplineFloorTSS`.
 *
 * Original incident (89-min tennis, ≈25 km easy running equivalent) is now
 * pinned across two layers: the iTRIMP scale invariant in
 * `universalLoad.test.ts`, and the tri-mode redirect path here.
 */

import { describe, it, expect } from 'vitest';
import { detectCrossTrainingOverload } from './tri-cross-training-overload';
import type { SimulatorState } from '@/types/state';

function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [],
    ...overrides,
  } as unknown as SimulatorState;
}

/**
 * A canonical week with planned tri workouts spread across disciplines:
 *   Mon: 60 min run threshold (110 TSS, quality)
 *   Wed: 45 min swim endurance (70 TSS)
 *   Sat: 4 h bike endurance (220 TSS)
 *   Sun: 90 min run long (110 TSS)
 *  Total = 510 TSS.
 *  Bike has the most planned TSS (220) — recommended target by default.
 */
function canonicalTriWeek() {
  return {
    triWorkouts: [
      { id: 'mon-r', t: 'threshold', n: 'Run threshold', d: '60min', r: 8, discipline: 'run', aerobic: 80, anaerobic: 30, dayOfWeek: 0, estimatedDurationMin: 60 },
      { id: 'wed-s', t: 'swim_endurance', n: 'Swim endurance', d: '45min', r: 4, discipline: 'swim', aerobic: 60, anaerobic: 10, dayOfWeek: 2, estimatedDurationMin: 45 },
      { id: 'sat-b', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 200, anaerobic: 20, dayOfWeek: 5, estimatedDurationMin: 240 },
      { id: 'sun-r', t: 'long', n: 'Long run', d: '90min', r: 6, discipline: 'run', aerobic: 100, anaerobic: 10, dayOfWeek: 6, estimatedDurationMin: 90 },
    ],
  } as any;
}

describe('detectCrossTrainingOverload — gating', () => {
  it('returns null in running mode', () => {
    expect(detectCrossTrainingOverload(state({ eventType: 'running' }))).toBeNull();
  });

  it('returns null when current week has no triWorkouts', () => {
    expect(detectCrossTrainingOverload(state({ wks: [{ triWorkouts: [] } as any] }))).toBeNull();
  });

  it('returns null when planned tri TSS is zero', () => {
    const s = state({
      wks: [{
        triWorkouts: [{ id: 'r1', t: 'easy', n: 'R', d: '30min', r: 4, discipline: 'run' }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s)).toBeNull();
  });

  it('returns null when no cross-training in the week', () => {
    expect(detectCrossTrainingOverload(state({ wks: [canonicalTriWeek()] }))).toBeNull();
  });

  it('does NOT fire below the 15% threshold', () => {
    // 510 TSS planned + 60 TSS tennis = 11.7% — below threshold.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '60min', r: 5, iTrimp: 9000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });
});

describe('detectCrossTrainingOverload — severity tiers', () => {
  it("fires as 'heavy' between 15% and 25%", () => {
    // 510 TSS planned + 100 TSS tennis = 19.6% → heavy.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('heavy');
    expect(r!.crossTrainingTSS).toBe(100);
  });

  it("escalates to 'extreme' above 25%", () => {
    // 510 TSS planned + 200 TSS tennis = 39.2% → extreme.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'big-tennis', t: 'cross', n: 'tennis', d: '180min', r: 7, iTrimp: 30000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('extreme');
    expect(r!.crossTrainingTSS).toBe(200);
  });
});

describe('detectCrossTrainingOverload — recommended discipline', () => {
  it('recommends the discipline with the most remaining planned TSS', () => {
    // Bike has 220 TSS (most), so bike should be recommended.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.recommendedDiscipline).toBe('bike');
  });

  it('flips recommendation when remaining shifts (e.g. completed sessions)', () => {
    // Mark Saturday's bike as completed → remaining bike = 0; remaining run = 210; recommended = run.
    const wk = canonicalTriWeek();
    wk.triWorkouts.find((w: any) => w.id === 'sat-b').status = 'completed';
    const s = state({
      wks: [{
        ...wk,
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.recommendedDiscipline).toBe('run');
  });

  it('returns null when the recommended discipline has no remaining TSS', () => {
    // Every workout completed → no recommendation possible.
    const wk = canonicalTriWeek();
    wk.triWorkouts.forEach((w: any) => { w.status = 'completed'; });
    const s = state({
      wks: [{
        ...wk,
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });
});

describe('detectCrossTrainingOverload — per-discipline options', () => {
  it('populates all three discipline options', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.options.swim).toBeDefined();
    expect(r!.options.bike).toBeDefined();
    expect(r!.options.run).toBeDefined();
  });

  it('reports remaining TSS per discipline', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.options.bike.remainingTSS).toBe(220);
    expect(r!.options.run.remainingTSS).toBe(220); // mon-r 110 + sun-r 110
    expect(r!.options.swim.remainingTSS).toBe(70);
  });

  it('builds reduce mods for the recommended discipline', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    const bikeReduce = r!.options.bike.reduceMods;
    expect(bikeReduce.length).toBeGreaterThan(0);
    expect(bikeReduce[0].discipline).toBe('bike');
    expect(bikeReduce[0].action).toBe('trim_volume'); // sat-b is endurance
    expect(bikeReduce[0].tssReduction).toBeGreaterThan(0);
  });

  it("builds replace mods that include a 'swap_easy' for the first quality session", () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'big', t: 'cross', n: 'tennis', d: '180min', r: 7, iTrimp: 30000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    const runReplace = r!.options.run.replaceMods;
    // Run has a quality session (mon-r threshold) — first replace mod should swap it.
    const swap = runReplace.find(m => m.action === 'swap_easy');
    expect(swap).toBeDefined();
    expect(swap!.workoutId).toBe('mon-r');
  });
});

describe('detectCrossTrainingOverload — membership filter (plan-vs-extra)', () => {
  it('does NOT count a planned cross-training session in triWorkouts', () => {
    // Planned 'cross' workout in tri plan with discipline=undefined.
    // Per "anything in your plan is in your plan", this should NOT trigger overload.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        triWorkouts: [
          ...canonicalTriWeek().triWorkouts,
          { id: 'planned-gym', t: 'cross', n: 'Strength', d: '45min', r: 6, aerobic: 30, anaerobic: 10, dayOfWeek: 1 },
        ],
        // The planned session also lands in adhocWorkouts via the matcher (id matches).
        adhocWorkouts: [{ id: 'planned-gym', t: 'cross', n: 'Strength', d: '45min', r: 6, iTrimp: 6000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });

  it('does count an off-plan adhoc whose id is not in triWorkouts', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis-not-in-plan', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).not.toBeNull();
  });
});

describe('detectCrossTrainingOverload — TSS dedup (regression)', () => {
  // v1 bug fixed earlier today: addAdhocWorkoutFromPending writes to BOTH
  // wk.adhocWorkouts AND wk.garminActuals at the same id, so the detector
  // double-counted. Pin the fix.

  it('does not double-count an item present in both adhocWorkouts and garminActuals', () => {
    const adhocId = 'garmin-tennis-1';
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: adhocId, t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
        garminActuals: {
          [adhocId]: {
            garminId: 'tennis-1', durationSec: 5400, distanceKm: 0,
            avgPaceSecKm: null, avgHR: 150, maxHR: 175, calories: 600,
            iTrimp: 15000, activityType: 'TENNIS',
          },
        },
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.crossTrainingTSS).toBe(100); // 15000/150, NOT 200
  });

  it('still counts an actual when it has no twin in adhocWorkouts', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [],
        garminActuals: {
          'orphan-tennis': {
            garminId: 'tennis-99', durationSec: 5400, distanceKm: 0,
            avgPaceSecKm: null, avgHR: 152, maxHR: 178, calories: 800,
            iTrimp: 15000, activityType: 'TENNIS',
          },
        },
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.crossTrainingTSS).toBe(100);
  });

  it('does NOT count tri-discipline-matched actuals as cross-training', () => {
    // An actual whose id matches a triWorkouts id (e.g. a synced run that
    // was matched to mon-r) is part of the plan and shouldn't double-count.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        garminActuals: {
          'mon-r': {
            garminId: 'run-99', durationSec: 3600, distanceKm: 12,
            avgPaceSecKm: 300, avgHR: 145, maxHR: 165, calories: 700,
            iTrimp: 15000, activityType: 'RUNNING',
          },
        },
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });
});

describe('detectCrossTrainingOverload — modifiable filter', () => {
  it('skips skipped/replaced/completed workouts from candidate sets', () => {
    const wk = canonicalTriWeek();
    wk.triWorkouts.find((w: any) => w.id === 'mon-r').status = 'replaced';
    const s = state({
      wks: [{
        ...wk,
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    // Run reduce mods should NOT include mon-r (it's replaced).
    const runMods = r!.options.run.reduceMods;
    expect(runMods.find(m => m.workoutId === 'mon-r')).toBeUndefined();
  });

  it('skips workouts whose dayOfWeek is before today', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    // Today is Friday (dow=4) — Mon (0), Wed (2) are in the past.
    const r = detectCrossTrainingOverload(s, 4);
    const runMods = r!.options.run.reduceMods;
    expect(runMods.find(m => m.workoutId === 'mon-r')).toBeUndefined();
    // Sun (6) should still be a candidate.
    expect(runMods.find(m => m.workoutId === 'sun-r')).toBeDefined();
  });
});

describe('detectCrossTrainingOverload — floor enforcement', () => {
  it('flags belowFloor when reductions would breach the floor', () => {
    // Single small-volume discipline (bike with 100 TSS planned, 100% remaining).
    // Floor at 65% = 65 TSS. Heavy severity allows 1-2 mods totalling up to ~30 TSS
    // (15% of 100 + 25% of 100, depending on action). Should NOT trigger belowFloor
    // for normal heavy load.
    const wkLowVol = {
      triWorkouts: [
        { id: 'b1', t: 'bike_endurance', n: 'Bike', d: '90min', r: 5, discipline: 'bike', aerobic: 90, anaerobic: 10, dayOfWeek: 5, estimatedDurationMin: 90 },
      ],
    };
    const s = state({
      // Heavy load: 100 TSS bike + 25 TSS tennis = 25% overshoot (heavy).
      wks: [{ ...wkLowVol, adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '30min', r: 6, iTrimp: 3750 }] }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    // Reduce mods on bike: trim 15% of 100 = 15 TSS. Remaining after = 85 TSS, floor = 65.
    // 85 > 65 → not below floor.
    expect(r!.options.bike.belowFloor).toBe(false);
  });

  it('returns floor=0 in taper phase (no floor protection)', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        ph: 'taper',
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.options.bike.floorTSS).toBe(0);
    expect(r!.options.run.floorTSS).toBe(0);
    expect(r!.options.swim.floorTSS).toBe(0);
  });
});
