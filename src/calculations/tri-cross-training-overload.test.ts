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
import { detectCrossTrainingOverload, type OverloadAdjustment } from './tri-cross-training-overload';
import { applyTriSuggestions } from './tri-suggestion-apply';
import { markTriSuggestionsHandled } from './tri-suggestion-handled';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import type { SimulatorState } from '@/types/state';
import { TL_PER_MIN } from '@/constants';
import { computeWeekRawTSS } from './fitness-model';
import { isTriQualitySession } from './tri-suggestion-apply';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { getDefaultState } from '@/state/store';

// s.w is 1-based (store.ts default w: 1): the current week is wks[s.w - 1], so
// these fixtures put the week under test at wks[0] with w: 1.
function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
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
 *  Bike has the most planned TSS (220). Recommended target by default.
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
    // 510 TSS planned + 60 TSS tennis = 11.7%. Below threshold.
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

describe('detectCrossTrainingOverload — recommended discipline (run-anchored)', () => {
  it('anchors on run for default cross-training (tennis = leg-impact, run-affinity)', () => {
    // Tennis is leg-impact-loaded → run-affinity → recommend run, even though
    // bike has more remaining planned TSS (220 vs 220 for run, but tied tests
    // would otherwise prefer bike under the old "most-loaded" heuristic).
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.recommendedDiscipline).toBe('run');
  });

  it('anchors on run for gym/strength (also leg-impact)', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'gym', t: 'cross', n: 'strength', d: '60min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)!.recommendedDiscipline).toBe('run');
  });

  it('overrides to bike when cross-training is clearly cycling', () => {
    // Extra Zwift / cycling session → bike-affinity → recommend bike.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'zwift', t: 'cross', n: 'cycling', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)!.recommendedDiscipline).toBe('bike');
  });

  it('overrides to swim when cross-training is clearly swimming', () => {
    // Extra pool swim outside the plan → swim-affinity → recommend swim.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'extra-swim', t: 'cross', n: 'swimming', d: '60min', r: 5, iTrimp: 15000 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)!.recommendedDiscipline).toBe('swim');
  });

  it('falls through to bike when run-affinity is recommended but run has no remaining work', () => {
    // Tennis (run-affinity) but all run sessions are completed → fall through
    // to next-most-loaded discipline. Bike has 220 TSS remaining.
    const wk = canonicalTriWeek();
    wk.triWorkouts.filter((w: any) => w.discipline === 'run').forEach((w: any) => { w.status = 'completed'; });
    const s = state({
      wks: [{
        ...wk,
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r!.recommendedDiscipline).toBe('bike');
  });

  // Never a pop-up with nothing to act on (Tristan, 2026-10-21). A 62 TSS load
  // on a 400 TSS week (15.5%) unlocks a 58.2 TSS budget. The threshold run's
  // downgrade takes 69 and its swap 137: neither fits, and quality sessions are
  // never trimmed, so run has work but no change.
  const thresholdRun = { id: 'mon-r', t: 'threshold', n: 'Run threshold', d: '90min', r: 8, discipline: 'run', aerobic: 150, anaerobic: 50, dayOfWeek: 0, estimatedDurationMin: 90 };
  const longRide = { id: 'sat-b', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 180, anaerobic: 20, dayOfWeek: 5, estimatedDurationMin: 240 };

  it('passes over a discipline with work but no change, to the next in affinity order with one', () => {
    const s = state({
      wks: [{
        triWorkouts: [thresholdRun, longRide],
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 62 * 150 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0)!;
    expect(r).not.toBeNull();
    expect(r.options.run.remainingTSS).toBe(200);
    expect(r.options.run.reduceMods).toEqual([]);
    expect(r.options.run.replaceMods).toEqual([]);
    expect(r.recommendedDiscipline).toBe('bike');
    expect(r.options.bike.reduceMods).toMatchObject([{ workoutId: 'sat-b', action: 'trim_volume' }]);
  });

  it('returns null when no discipline has a change, even with planned work left', () => {
    // Same week and load share without the ride: 200 TSS planned, 31 TSS of
    // tennis (15.5%, budget 30.1). The run's downgrade (69) does not fit.
    const s = state({
      wks: [{
        triWorkouts: [thresholdRun],
        adhocWorkouts: [{ id: 'tennis', t: 'cross', n: 'tennis', d: '45min', r: 6, iTrimp: 31 * 150 }],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });

  it('returns null when ALL disciplines have no remaining TSS', () => {
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
    // Run has a quality session (mon-r threshold). First replace mod should swap it.
    const swap = runReplace.find(m => m.action === 'swap_easy');
    expect(swap).toBeDefined();
    expect(swap!.workoutId).toBe('mon-r');
  });

  it('Replace & Reduce is empty when it would hold no swap (it would repeat Reduce)', () => {
    // Bike holds only the long endurance ride: nothing to swap, so the replace
    // set would be the same trim as Reduce. Run holds the threshold session.
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [{ id: 'big', t: 'cross', n: 'tennis', d: '180min', r: 7, iTrimp: 30000 }],
      }] as any,
    });
    const r = detectCrossTrainingOverload(s, 0)!;
    expect(r.options.bike.reduceMods.length).toBeGreaterThan(0);
    expect(r.options.bike.replaceMods).toEqual([]);
    expect(r.options.run.replaceMods.some(m => m.action === 'swap_easy')).toBe(true);
    // Every non-empty replace set holds a swap.
    for (const d of ['swim', 'bike', 'run'] as const) {
      const set = r.options[d].replaceMods;
      if (set.length) expect(set.some(m => m.action === 'swap_easy'), d).toBe(true);
    }
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

describe('detectCrossTrainingOverload — planned adhoc sessions are plan (isPlannedAdhocId)', () => {
  // adhocWorkouts also holds sessions injected into the plan: user-added
  // (adhoc-), injury capability offers (adhoc-cap-, adhoc-strength-), holiday
  // replacements (holiday-) and benchmark check-ins (benchmark-). Signal B
  // skips them; so does the detector, with any done record under the same id.
  for (const id of ['adhoc-1', 'adhoc-cap-bike-1', 'adhoc-strength-1', 'holiday-run-1', 'benchmark-5k-1']) {
    it(`${id} with a stamped load adds nothing`, () => {
      const s = state({
        wks: [{
          ...canonicalTriWeek(),
          adhocWorkouts: [{ id, t: 'cross', n: 'Planned session', d: '90min', r: 6, aerobic: 170, anaerobic: 30 }],
        }] as any,
      });
      expect(detectCrossTrainingOverload(s, 0)).toBeNull();
    });

    it(`${id} with a Mark as Done record under the same key adds nothing`, () => {
      const s = state({
        wks: [{
          ...canonicalTriWeek(),
          adhocWorkouts: [{ id, t: 'cross', n: 'Planned session', d: '90min', r: 6 }],
          garminActuals: {
            [id]: {
              garminId: `manual-${id}`, startTime: '2026-10-20T12:00:00.000Z', durationSec: 5400, distanceKm: 0,
              avgPaceSecKm: null, avgHR: 150, maxHR: 170, calories: null, iTrimp: 30000, activityType: 'TENNIS',
            },
          },
        }] as any,
      });
      expect(detectCrossTrainingOverload(s, 0)).toBeNull();
    });
  }

  it('a synced activity beside a planned adhoc session still counts', () => {
    const s = state({
      wks: [{
        ...canonicalTriWeek(),
        adhocWorkouts: [
          { id: 'holiday-run-1', t: 'easy', n: 'Holiday run', d: '60min', r: 4, aerobic: 55, anaerobic: 0 },
          { id: 'garmin-tennis-1', t: 'cross', n: 'tennis', d: '90min', r: 6, iTrimp: 15000 },
        ],
      }] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)?.crossTrainingTSS).toBe(100);
  });
});

describe('detectCrossTrainingOverload — activities with no stored load are valued (Signal B rule)', () => {
  // A GPS-recorded extra run: the adhoc entry carries no load and its activity
  // record has iTrimp null (recording-handler saveAsAdhoc, buildGpsRunActual).
  // It counted 0: pass 1 marked the id counted, pass 2 skipped the record.
  const gpsRun = (id: string, min: number, rpe: number) => ({
    adhoc: { id, n: 'Run', d: `${(min / 6).toFixed(1)}km`, r: 5, t: 'easy' },
    actual: {
      garminId: `inapp-${id}`, startTime: '2026-10-20T07:00:00.000Z', distanceKm: min / 6, durationSec: min * 60,
      avgPaceSecKm: 360, avgHR: null, maxHR: null, calories: null, iTrimp: null, hrZones: null,
      activityType: null, plannedType: null, rpe, displayName: 'Run',
    },
  });

  it('a 90-min GPS extra run rated 5 counts 90 x TL_PER_MIN[5]', () => {
    const r1 = gpsRun('9b2c7f0e-gps', 90, 5);
    const wk = {
      ...canonicalTriWeek(),
      adhocWorkouts: [r1.adhoc],
      garminActuals: { [r1.adhoc.id]: r1.actual },
      rated: { [r1.adhoc.id]: 5 },
    };
    const r = detectCrossTrainingOverload(state({ wks: [wk] as any }), 0);
    expect(r).not.toBeNull();
    expect(r!.crossTrainingTSS).toBe(Math.round(90 * TL_PER_MIN[5])); // 104
    expect(r!.recommendedDiscipline).toBe('run'); // an extra run is run-affinity
  });

  it('the rating sets the row: the same run rated 7 counts 90 x TL_PER_MIN[7]', () => {
    const r1 = gpsRun('9b2c7f0e-gps', 90, 7);
    const wk = {
      ...canonicalTriWeek(),
      adhocWorkouts: [r1.adhoc],
      garminActuals: { [r1.adhoc.id]: r1.actual },
      rated: { [r1.adhoc.id]: 7 },
    };
    expect(detectCrossTrainingOverload(state({ wks: [wk] as any }), 0)?.crossTrainingTSS)
      .toBe(Math.round(90 * TL_PER_MIN[7]));
  });

  it('Signal B and the detector give an unmeasured activity the same figure', () => {
    const r1 = gpsRun('9b2c7f0e-gps', 90, 5);
    const extras = { adhocWorkouts: [r1.adhoc], garminActuals: { [r1.adhoc.id]: r1.actual }, rated: { [r1.adhoc.id]: 5 } };
    const signalB = computeWeekRawTSS({ w: 1, ...extras } as any, extras.rated);
    const r = detectCrossTrainingOverload(state({ wks: [{ ...canonicalTriWeek(), ...extras }] as any }), 0);
    expect(r!.crossTrainingTSS).toBe(signalB);
  });

  it('a manual entry with no load and no record counts its minutes at its RPE', () => {
    const wk = {
      ...canonicalTriWeek(),
      adhocWorkouts: [{ id: 'manual-legacy-1', t: 'cross', n: 'padel', d: '90min', r: 6, rpe: 6 }],
    };
    expect(detectCrossTrainingOverload(state({ wks: [wk] as any }), 0)?.crossTrainingTSS)
      .toBe(Math.round(90 * TL_PER_MIN[6]));
  });

  it('an activity record with no iTRIMP and no adhoc twin counts its minutes', () => {
    const wk = {
      ...canonicalTriWeek(),
      garminActuals: {
        'garmin-tennis-nohr': {
          garminId: 'tennis-nohr', startTime: '2026-10-20T18:00:00.000Z', durationSec: 5400, distanceKm: 0,
          avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'TENNIS',
        },
      },
    };
    expect(detectCrossTrainingOverload(state({ wks: [wk] as any }), 0)?.crossTrainingTSS)
      .toBe(Math.round(90 * TL_PER_MIN[5]));
  });

  it('a rated gym session with heart rate counts the strength override, as Signal B does (D9)', () => {
    // An activity record with no adhoc twin: pass 2. Its HR-based iTRIMP is
    // small (20 TSS); Signal B counts 60 x TL_PER_MIN[7] for a rated strength
    // session, and so does the detector now.
    const extras = {
      garminActuals: {
        'garmin-gym-1': {
          garminId: 'gym-1', startTime: '2026-10-20T18:00:00.000Z', durationSec: 3600, distanceKm: 0,
          avgPaceSecKm: null, avgHR: 120, maxHR: 150, calories: null, iTrimp: 3000, activityType: 'STRENGTH_TRAINING',
        },
      },
      rated: { 'garmin-gym-1': 7 },
    };
    const r = detectCrossTrainingOverload(state({ wks: [{ ...canonicalTriWeek(), ...extras }] as any }), 0);
    expect(r!.crossTrainingTSS).toBe(Math.round(60 * TL_PER_MIN[7])); // 107, was 20
    expect(r!.crossTrainingTSS).toBe(computeWeekRawTSS({ w: 1, ...extras } as any, extras.rated as any));
  });

  it('a stored load still wins: stamped aerobic + anaerobic is not re-valued', () => {
    const wk = {
      ...canonicalTriWeek(),
      adhocWorkouts: [{ id: 'garmin-ride-1', t: 'cross', n: 'cycling', d: '90min', r: 6, aerobic: 85, anaerobic: 15 }],
      garminActuals: {
        'garmin-ride-1': {
          garminId: 'ride-1', startTime: '2026-10-20T08:00:00.000Z', durationSec: 5400, distanceKm: 40,
          avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'CYCLING',
        },
      },
    };
    expect(detectCrossTrainingOverload(state({ wks: [wk] as any }), 0)?.crossTrainingTSS).toBe(100);
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
    // Today is Friday (dow=4). Mon (0), Wed (2) are in the past.
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

describe('detectCrossTrainingOverload — reads the week the user is in (s.w is 1-based)', () => {
  // Regression: the detector indexed wks[s.w], which is NEXT week under the
  // store convention (store.ts default w: 1, current week = wks[s.w - 1]).
  // Extra padel logged this week never produced a proposal for this week.
  const padel = { id: 'padel', t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp: 33000 }; // 220 TSS

  it('220 TSS of padel in the current week (wks[0], w: 1) fires an overload', () => {
    const s = state({
      w: 1,
      wks: [
        { ...canonicalTriWeek(), adhocWorkouts: [padel] },
        canonicalTriWeek(), // next week: planned only, no cross-training
      ] as any,
    });
    const r = detectCrossTrainingOverload(s, 0);
    expect(r).not.toBeNull();
    expect(r!.crossTrainingTSS).toBe(220);
    expect(r!.plannedTriTSS).toBe(510);
    // The proposal acts on this week's sessions.
    expect(r!.options.run.reduceMods.map(m => m.workoutId)).toContain('mon-r');
  });

  it('cross-training in next week (wks[1]) does not fire for the current week', () => {
    const s = state({
      w: 1,
      wks: [
        canonicalTriWeek(),
        { ...canonicalTriWeek(), adhocWorkouts: [padel] },
      ] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();
  });

  it('mid-plan: w: 3 reads wks[2]', () => {
    const s = state({
      w: 3,
      wks: [
        canonicalTriWeek(),
        canonicalTriWeek(),
        { ...canonicalTriWeek(), adhocWorkouts: [padel] },
        canonicalTriWeek(),
      ] as any,
    });
    expect(detectCrossTrainingOverload(s, 0)?.crossTrainingTSS).toBe(220);
  });
});

// ─── Notify-once: an answered overload is not proposed again ───────────────
// Regression (review of a1): once the detector read the current week, the
// overload modal re-fired on every launch. After Reduce the re-priced plan made
// the overshoot RISE and the same sessions were proposed again (isModifiable
// let 'reduced' through); Keep stored nothing; Push left the load in this week.

describe('detectCrossTrainingOverload — answered proposals', () => {
  const padel = (id: string, iTrimp: number) => ({ id, t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp });
  const asMods = (adj: OverloadAdjustment[]): TriSuggestionMod[] => adj.map((a, i) => ({
    id: `xt_${i}`, source: 'cross_training_overload', discipline: a.discipline,
    headline: a.workoutLabel, body: '', severity: 'caution', targetWorkoutId: a.workoutId, action: a.action,
  }));

  it('sessions an accepted Reduce changed are not proposed again', () => {
    const s = state({ w: 1, wks: [{ ...canonicalTriWeek(), adhocWorkouts: [padel('padel', 33000)] }] as any });
    const r = detectCrossTrainingOverload(s, 0)!;
    const reduced = r.options.run.reduceMods.map(m => m.workoutId);
    expect(reduced).toEqual(['mon-r', 'sun-r']);
    expect(applyTriSuggestions(s, asMods(r.options.run.reduceMods)).applied).toBe(2);

    // Even without the answered stamp, the reduced sessions are no longer targets.
    const again = detectCrossTrainingOverload(s, 0);
    for (const d of ['swim', 'bike', 'run'] as const) {
      const ids = [...(again?.options[d].reduceMods ?? []), ...(again?.options[d].replaceMods ?? [])].map(m => m.workoutId);
      expect(ids).not.toContain('mon-r');
      expect(ids).not.toContain('sun-r');
    }
    // They still count toward the run's remaining planned load, at the new load.
    const wk = s.wks![0] as any;
    const runLoad = wk.triWorkouts.filter((w: any) => w.discipline === 'run')
      .reduce((a: number, w: any) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
    expect(again?.options.run.remainingTSS).toBe(Math.round(runLoad));
  });

  it('an answered load is not proposed again; a new session is judged on its own', () => {
    const s = state({ w: 1, wks: [{ ...canonicalTriWeek(), adhocWorkouts: [padel('padel', 33000)] }] as any });
    const r = detectCrossTrainingOverload(s, 0)!;
    expect(r.crossTrainingTSS).toBe(220);
    markTriSuggestionsHandled(s, { crossTrainingTSS: r.crossTrainingTSS }); // e.g. Keep
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();

    // A small session afterwards (40 TSS, 8% of plan) is below the threshold on its own.
    (s.wks![0] as any).adhocWorkouts.push(padel('padel-2', 6000));
    expect(detectCrossTrainingOverload(s, 0)).toBeNull();

    // A second big session (220 TSS) fires, built on the unanswered load only.
    (s.wks![0] as any).adhocWorkouts.push(padel('padel-3', 33000));
    const next = detectCrossTrainingOverload(s, 0);
    expect(next).not.toBeNull();
    expect(next!.crossTrainingTSS).toBe(260); // 40 + 220, the 220 answered earlier is out
  });
});

// ─── Quality sessions are never trimmed (Tristan, 2026-10-21, D3) ──────────
// The builders' rule, kept by decision: a quality session takes a downgrade or
// a swap, never a trim. When neither fits the budget the session gets no
// proposal (no trim fallback), and the pop-up moves to a discipline with a
// change (D1).

describe('detectCrossTrainingOverload — quality sessions are never trimmed', () => {
  it('generated plans: every proposed trim targets a non-quality session', () => {
    let trims = 0;
    for (const distance of ['olympic', 'ironman']) {
      const base = {
        ...getDefaultState(), eventType: 'triathlon', w: 1, tw: 20, v: 50,
        pac: { e: 300, t: 250, i: 230, m: 275, r: 200 }, wks: [],
        triConfig: {
          distance, timeAvailableHoursPerWeek: 10, volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 }, bike: { hasPowerMeter: true, ftp: 220 }, swim: { cssSecPer100m: 100 }, weeksToRace: 20,
        },
      } as unknown as SimulatorState;
      base.wks = generateTriathlonPlan(base);
      for (let wi = 0; wi < base.wks.length; wi += 3) {
        for (const pct of [0.16, 0.45]) for (const sport of ['tennis', 'cycling', 'swimming']) {
          const s = structuredClone(base);
          s.w = wi + 1;
          const planned = (s.wks[wi].triWorkouts ?? []).reduce((a, w) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
          s.wks[wi].adhocWorkouts = [{ id: 'xt', t: 'cross', n: sport, d: '90min', r: 6, iTrimp: pct * planned * 150 } as any];
          const o = detectCrossTrainingOverload(s, 0);
          if (!o) continue;
          const byId = new Map((s.wks[wi].triWorkouts ?? []).map(w => [w.id, w]));
          for (const d of ['swim', 'bike', 'run'] as const) {
            for (const m of [...o.options[d].reduceMods, ...o.options[d].replaceMods]) {
              if (m.action !== 'trim_volume') continue;
              trims += 1;
              expect(isTriQualitySession(byId.get(m.workoutId)!), `${distance} wk${wi + 1} ${m.workoutLabel}`).toBe(false);
            }
          }
        }
      }
    }
    expect(trims).toBeGreaterThan(50);
  });
});
