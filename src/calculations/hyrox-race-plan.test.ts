import { describe, expect, it } from 'vitest';
import { predictHyroxRace } from './race-prediction.hyrox';
import {
  buildHyroxRacePlan,
  hyroxForecastRaceClock,
  hyroxGoalBackCalcOptions,
  hyroxRoxzoneAtGoalSec,
  roundToTotal,
} from './hyrox-race-plan';
import { computeGoalBackCalc } from './hyrox-goal-back-calc';
import { hyroxCompetitiveFloors, hyroxCohortForState } from './hyrox-results';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';

function buildState(
  overrides: Partial<NonNullable<SimulatorState['hyroxConfig']>> = {},
  topLevel: Partial<SimulatorState> = {},
): SimulatorState {
  return {
    biologicalSex: 'female',
    ...topLevel,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1000,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
  } as unknown as SimulatorState;
}

function planFor(state: SimulatorState) {
  const prediction = predictHyroxRace(state)!;
  return { prediction, plan: buildHyroxRacePlan(state, prediction) };
}

/** The fastest time the cohort floors allow (venue-neutral state): per
 *  component the top-1% median while the forecast is slower, else the p1
 *  split, and never above the forecast's own. */
function tieredFloorSum(s: SimulatorState, p: ReturnType<typeof predictHyroxRace> & object): number {
  const f = hyroxCompetitiveFloors(hyroxCohortForState(s))!;
  const tier = (cur: number, med: number, fast: number) => Math.min(cur, cur > med ? med : fast);
  return tier(p.runSec, f.runSec, f.fastest.runSec)
    + HYROX_STATION_ORDER.reduce((a, st) => a + tier(p.stations.find(l => l.station === st)!.adjustedSec, f.stationSec[st], f.fastest.stationSec[st]), 0)
    + tier(p.roxzoneSec, f.roxzoneSec, f.fastest.roxzoneSec);
}

const RACE_ORDER = [
  'Run 1', 'SkiErg', 'Run 2', 'Sled Push', 'Run 3', 'Sled Pull', 'Run 4', 'Burpee Broad Jumps',
  'Run 5', 'Row Erg', 'Run 6', 'Farmer Carry', 'Run 7', 'Sandbag Lunges', 'Run 8', 'Wall Balls',
];

describe('buildHyroxRacePlan: shape and clock', () => {
  it('16 legs in race order plus the Roxzone', () => {
    const { plan } = planFor(buildState());
    expect(plan.legs.map(l => l.label)).toEqual(RACE_ORDER);
    expect(plan.legs.filter(l => l.kind === 'station').map(l => l.station)).toEqual(HYROX_STATION_ORDER);
    expect(plan.roxzone.splitSec).toBeGreaterThan(0);
  });

  it('legs and Roxzone sum to the goal; the clock ends on it', () => {
    const state = buildState();
    const fc = predictHyroxRace(state)!.totalSec;
    const s = buildState({ targetFinishTimeSec: fc - 240 });
    const { plan } = planFor(s);
    expect(plan.basis).toBe('goal');
    expect(plan.goalSec).toBe(fc - 240);
    expect(plan.feasibility).not.toBe('unrealistic');
    const sum = plan.legs.reduce((a, l) => a + l.splitSec, 0) + plan.roxzone.splitSec;
    expect(sum).toBe(fc - 240);
    expect(plan.planSec).toBe(fc - 240);
    expect(plan.legs[15].clockSec).toBe(fc - 240);
    expect(plan.checkpoints[plan.checkpoints.length - 1]).toEqual({ label: 'Finish', clockSec: fc - 240 });
  });

  it('the clock is each leg added to the last, with the Roxzone shared around the stations', () => {
    const { plan } = planFor(buildState({ targetFinishTimeSec: 5300 }));
    let prev = 0;
    let roxSeen = 0;
    plan.legs.forEach((l, i) => {
      const gap = l.clockSec - prev - l.splitSec;
      expect(gap).toBeGreaterThanOrEqual(0);
      // No Roxzone before Run 1.
      if (i === 0) expect(gap).toBe(0);
      roxSeen += gap;
      prev = l.clockSec;
    });
    expect(roxSeen).toBe(plan.roxzone.splitSec);
    // Checkpoints are the run clocks.
    plan.checkpoints.slice(0, 8).forEach((c, k) => expect(c.clockSec).toBe(plan.legs[2 * k].clockSec));
  });

  it('no goal: the splits are the forecast\'s own lines and Roxzone; the clock carries the rounding remainder', () => {
    for (const hx of [{}, { format: 'open_doubles' as const, division: 'mixed' as const }, { venueId: 'mexico-city-exh' }]) {
      const { plan, prediction } = planFor(buildState(hx));
      expect(plan.basis).toBe('forecast');
      expect(plan.goalSec).toBeNull();
      expect(plan.feasibility).toBeNull();
      expect(plan.planSec).toBe(prediction.totalSec);
      expect(plan.legs[15].clockSec).toBe(prediction.totalSec);
      plan.legs.filter(l => l.kind === 'run').forEach((l, k) => expect(l.splitSec).toBe(prediction.runLegs[k].durationSec));
      plan.legs.filter(l => l.kind === 'station').forEach(l => {
        expect(l.splitSec).toBe(prediction.stations.find(x => x.station === l.station)!.adjustedSec);
      });
      const lines = plan.legs.reduce((a, l) => a + l.splitSec, 0);
      // The Roxzone row is the forecast's own number (Where you sit plots
      // it); the clock's Roxzone is the remainder, within the lines' rounding.
      expect(plan.roxzone.splitSec).toBe(Math.round(prediction.roxzoneSec));
      expect(hyroxForecastRaceClock(prediction).roxzoneSec).toBe(prediction.totalSec - lines);
      expect(Math.abs(prediction.totalSec - lines - plan.roxzone.splitSec)).toBeLessThanOrEqual(8);
    }
  });
});

describe('one forecast race clock', () => {
  it('hyroxForecastRaceClock is the no-goal plan\'s clock', () => {
    const { plan, prediction } = planFor(buildState({ venueId: 'mexico-city-exh' }));
    const fc = hyroxForecastRaceClock(prediction);
    expect(fc.legs.map(l => l.clockSec)).toEqual(plan.legs.map(l => l.clockSec));
    expect(fc.legs.map(l => l.splitSec)).toEqual(plan.legs.map(l => l.splitSec));
    expect(fc.totalSec).toBe(prediction.totalSec);
  });
});

describe('buildHyroxRacePlan: same source as the forecast', () => {
  it('forecast splits are predictHyroxRace\'s own numbers', () => {
    const { plan, prediction } = planFor(buildState({ targetFinishTimeSec: 5000 }));
    expect(plan.forecastSec).toBe(prediction.totalSec);
    plan.legs.filter(l => l.kind === 'run').forEach((l, k) => expect(l.forecastSec).toBe(prediction.runLegs[k].durationSec));
    plan.legs.filter(l => l.kind === 'station').forEach(l => {
      expect(l.forecastSec).toBe(prediction.stations.find(x => x.station === l.station)!.adjustedSec);
    });
    // The Roxzone is the forecast's own; the 17 forecast lines sum to the
    // forecast within the lines' own rounding (the clock ends on it exactly).
    expect(plan.roxzone.forecastSec).toBe(Math.round(prediction.roxzoneSec));
    expect(Math.abs(plan.legs.reduce((a, l) => a + l.forecastSec, 0) + plan.roxzone.forecastSec - prediction.totalSec)).toBeLessThanOrEqual(8);
  });
});

describe('buildHyroxRacePlan: run fade', () => {
  it('goal run legs follow the forecast\'s per-leg fatigue model, not a flat split', () => {
    const { plan, prediction } = planFor(buildState({ targetFinishTimeSec: 5200 }));
    const runs = plan.legs.filter(l => l.kind === 'run').map(l => l.splitSec);
    expect(runs[7]).toBeGreaterThan(runs[0]);
    for (let k = 1; k < 8; k++) expect(runs[k]).toBeGreaterThanOrEqual(runs[k - 1]);
    const m = prediction.runLegs.map(l => l.fatigueMultiplier);
    expect(runs[7] / runs[0]).toBeCloseTo(m[7] / m[0], 2);
  });
});

describe('floors from the real results, per sex and division', () => {
  it('a woman\'s floors are the Open Singles women\'s top-1% medians, a man\'s the men\'s', () => {
    const w = buildState();
    const m = buildState({}, { biologicalSex: 'male' });
    const pw = predictHyroxRace(w)!;
    const pm = predictHyroxRace(m)!;
    const fw = hyroxGoalBackCalcOptions(w, pw, pw.totalSec - 300).floors!;
    const fm = hyroxGoalBackCalcOptions(m, pm, pm.totalSec - 300).floors!;
    expect(fw.stationSec).toEqual(hyroxCompetitiveFloors({ format: 'open_singles', sex: 'female' })!.stationSec);
    expect(fm.stationSec).toEqual(hyroxCompetitiveFloors({ format: 'open_singles', sex: 'male' })!.stationSec);
    expect(fw.roxzoneSec).toBe(hyroxCompetitiveFloors({ format: 'open_singles', sex: 'female' })!.roxzoneSec);
    expect(fw.runSec).toBeGreaterThan(fm.runSec);
  });

  it('an aggressive goal holds every station at or above its floor', () => {
    const s = buildState({ targetFinishTimeSec: 4300 });
    const p = predictHyroxRace(s)!;
    const opts = hyroxGoalBackCalcOptions(s, p, 4300);
    const r = computeGoalBackCalc(p, 4300, opts);
    expect(r.floorSource).toBe('cohort');
    for (const t of r.stationTargets) expect(t.targetSec).toBeGreaterThanOrEqual(opts.floors!.stationSec[t.station]! - 0.01);
  });

  it('Pro Singles reads the Pro field\'s floors', () => {
    const s = buildState({ format: 'pro_singles' }, { biologicalSex: 'male' });
    const p = predictHyroxRace(s)!;
    const f = hyroxGoalBackCalcOptions(s, p, p.totalSec - 200).floors!;
    expect(f.runSec).toBe(hyroxCompetitiveFloors({ format: 'pro_singles', sex: 'male' })!.runSec);
  });
});

describe('the top band keeps headroom (review 3: every faster goal read unrealistic)', () => {
  const cases: Array<[string, SimulatorState]> = [
    ['Open Singles man, competitive band (seeds = the top-1% medians)', buildState({ athleteBand: 'competitive' }, { biologicalSex: 'male' })],
    ['Open Singles woman, competitive band', buildState({ athleteBand: 'competitive' })],
    // A 1:05:00 woman's forecast (review 3: 3692 s): competitive seeds and a
    // 3:32/km run, well past her field's top-1% run median.
    ['Open Singles woman whose forecast is under her field\'s top-1% median', buildState({
      athleteBand: 'competitive', previousHyroxTimeSec: 3900, hyroxPreviousTimeFormat: 'open_singles', hyroxRunPaceSecKm: 212,
    })],
  ];

  it('the fixtures are what they say: stations at the top-1% medians; the third forecast past them', () => {
    for (const [, s] of cases) {
      const p = predictHyroxRace(s)!;
      const f = hyroxCompetitiveFloors(hyroxCohortForState(s))!;
      for (const st of HYROX_STATION_ORDER) expect(p.stations.find(l => l.station === st)!.adjustedSec).toBeCloseTo(f.stationSec[st], 0);
    }
    const pf = predictHyroxRace(cases[2][1])!;
    const fw = hyroxCompetitiveFloors({ format: 'open_singles', sex: 'female' })!;
    expect(pf.totalSec).toBe(3692);
    expect(pf.totalSec).toBeLessThan(fw.totalSec);
    expect(pf.runSec).toBeLessThan(fw.fastest.runSec);
  });

  it('goals 30 to 120 s faster are achievable or a stretch, never unrealistic, in the race plan and the goal modal path', () => {
    for (const [name, base] of cases) {
      const p = predictHyroxRace(base)!;
      for (const gain of [30, 60, 120]) {
        const goal = p.totalSec - gain;
        const back = computeGoalBackCalc(p, goal, hyroxGoalBackCalcOptions(base, p, goal));
        expect([name, gain, back.feasibility]).not.toEqual([name, gain, 'unrealistic']);
        expect(['achievable', 'stretch']).toContain(back.feasibility);
        const plan = buildHyroxRacePlan({ ...base, hyroxConfig: { ...base.hyroxConfig!, targetFinishTimeSec: goal } } as SimulatorState, p);
        expect(plan.basis).toBe('goal');
        expect(plan.legs[15].clockSec).toBe(goal);
      }
    }
  });

  it('a component at or past its top-1% median is floored at the cohort\'s p1 split, never above it', () => {
    const [, base] = cases[0];
    const p = predictHyroxRace(base)!;
    const f = hyroxCompetitiveFloors(hyroxCohortForState(base))!;
    const r = computeGoalBackCalc(p, p.totalSec - 5000, hyroxGoalBackCalcOptions(base, p, p.totalSec - 5000));
    expect(r.feasibility).toBe('unrealistic');
    for (const t of r.stationTargets) expect(t.targetSec).toBeCloseTo(f.fastest.stationSec[t.station], 0);
    expect(r.runPaceTarget.targetSecKm * 8).toBeCloseTo(f.fastest.runSec, 0);
    expect(r.roxzoneSec).toBeCloseTo(f.fastest.roxzoneSec, 0);
  });

  it('at a venue, the floors carry the forecast line\'s own venue seconds', () => {
    const s = buildState({ venueId: 'mexico-city-exh' });
    const p = predictHyroxRace(s)!;
    const f = hyroxCompetitiveFloors(hyroxCohortForState(s))!;
    const r = computeGoalBackCalc(p, 3000, hyroxGoalBackCalcOptions(s, p, 3000));
    expect(r.feasibility).toBe('unrealistic');
    for (const t of r.stationTargets) {
      const line = p.stations.find(l => l.station === t.station)!;
      expect(t.targetSec).toBeCloseTo(f.stationSec[t.station] + (line.adjustedSec - line.baseSec), 6);
    }
    expect(r.runPaceTarget.targetSecKm * 8).toBeGreaterThan(f.runSec);
  });
});

describe('Roxzone at the goal', () => {
  it('scales with the goal from the real results; equal to the forecast at the forecast', () => {
    const s = buildState();
    const p = predictHyroxRace(s)!;
    const cohort = hyroxCohortForState(s);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec)).toBeCloseTo(p.roxzoneSec, 6);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec - 600)!).toBeLessThan(p.roxzoneSec);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec + 600)!).toBeGreaterThan(p.roxzoneSec);
  });

  it('never below the cohort\'s tier Roxzone floor unless the forecast\'s own is', () => {
    const cases: Array<[Partial<NonNullable<SimulatorState['hyroxConfig']>>, Partial<SimulatorState>]> = [
      [{}, {}], [{ athleteBand: 'competitive' }, {}], [{}, { biologicalSex: 'male' }],
      [{ format: 'open_doubles', division: 'mixed' }, {}], [{ format: 'pro_singles' }, { biologicalSex: 'male' }],
    ];
    for (const [hx, top] of cases) {
      const base = buildState(hx, top);
      const p = predictHyroxRace(base)!;
      const f = hyroxCompetitiveFloors(hyroxCohortForState(base))!;
      // The tier floor: the median while the forecast is slower, else p1.
      const floor = p.roxzoneSec > f.roxzoneSec ? f.roxzoneSec : f.fastest.roxzoneSec;
      const lowest = Math.min(floor, p.roxzoneSec);
      for (const goal of [2800, 3300, 3600, 3900, 4200, p.totalSec - 600, p.totalSec - 60]) {
        const r = computeGoalBackCalc(p, goal, hyroxGoalBackCalcOptions(base, p, goal));
        expect(r.roxzoneSec).toBeGreaterThanOrEqual(lowest - 1e-6);
        const plan = buildHyroxRacePlan(buildState({ ...hx, targetFinishTimeSec: goal }, top), p);
        // Whole-second rounding can take a second off.
        expect(plan.roxzone.splitSec).toBeGreaterThanOrEqual(Math.floor(lowest) - 1);
      }
    }
  });
});

describe('goal slower than the forecast', () => {
  it('eases every component and still sums to the goal', () => {
    const base = buildState();
    const fc = predictHyroxRace(base)!.totalSec;
    const { plan } = planFor(buildState({ targetFinishTimeSec: fc + 600 }));
    expect(plan.feasibility).toBe('already_on_pace');
    expect(plan.basis).toBe('goal');
    expect(plan.legs[15].clockSec).toBe(fc + 600);
    plan.legs.forEach(l => expect(l.splitSec).toBeGreaterThanOrEqual(l.forecastSec - 1));
    expect(plan.roxzone.splitSec).toBeGreaterThan(plan.roxzone.forecastSec);
  });
});

describe('unrealistic goals', () => {
  it('are flagged; the splits fall back to the forecast\'s own lines and the clock ends on the forecast', () => {
    const { plan, prediction } = planFor(buildState({ targetFinishTimeSec: 3000 }));
    expect(plan.feasibility).toBe('unrealistic');
    expect(plan.goalSec).toBe(3000);
    expect(plan.shortfallSec).toBeGreaterThan(0);
    expect(plan.basis).toBe('forecast');
    expect(plan.planSec).toBe(prediction.totalSec);
    expect(plan.legs[15].clockSec).toBe(prediction.totalSec);
    plan.legs.forEach(l => expect(l.splitSec).toBe(l.forecastSec));
  });

  it('the fastest time the floors allow does not depend on the goal: the floor sum', () => {
    for (const [hx, top] of [[{}, {}], [{ athleteBand: 'competitive' }, {}], [{}, { biologicalSex: 'male' }]] as const) {
      const s = buildState(hx, top);
      const p = predictHyroxRace(s)!;
      const floorSum = tieredFloorSum(s, p);
      for (const goal of [2800, 3000, 3300]) {
        const r = computeGoalBackCalc(p, goal, hyroxGoalBackCalcOptions(s, p, goal));
        expect(r.feasibility).toBe('unrealistic');
        expect(r.achievedSec).toBeCloseTo(floorSum, 0);
        expect(r.shortfallSec).toBe(Math.round(floorSum - goal));
      }
    }
  });

  it('just inside the floor sum the Roxzone gives up to its floor: a stretch, not unrealistic', () => {
    const s = buildState({}, { biologicalSex: 'male' });
    const p = predictHyroxRace(s)!;
    const f = hyroxCompetitiveFloors(hyroxCohortForState(s))!;
    const r = computeGoalBackCalc(p, f.totalSec, hyroxGoalBackCalcOptions(s, p, f.totalSec));
    expect(r.feasibility).toBe('stretch');
    expect(r.achievedSec).toBeCloseTo(f.totalSec, 0);
    expect(r.roxzoneSec).toBeGreaterThanOrEqual(Math.min(p.roxzoneSec, f.roxzoneSec));
  });

  it('an achievable goal is never flagged by the forecast\'s own rounding', () => {
    // Venue factors leave fractional lines; the components can sum a few
    // seconds off totalSec. Measured from the components, a goal a minute
    // under the forecast is achievable.
    // Mexico City, a man: the lines sum 1 s over totalSec (measured from
    // totalSec this goal read 'unrealistic', 1 s short).
    for (const venueId of ['london-excel', 'madrid-ifema', 'mexico-city-exh', undefined]) {
      for (const biologicalSex of ['female', 'male'] as const) {
        const s = buildState({ venueId }, { biologicalSex });
        const fc = predictHyroxRace(s)!.totalSec;
        const { plan } = planFor(buildState({ venueId, targetFinishTimeSec: fc - 60 }, { biologicalSex }));
        expect(plan.feasibility).toBe('achievable');
        expect(plan.legs[15].clockSec).toBe(fc - 60);
      }
    }
  });
});

describe('stretch goals', () => {
  it('carry the back-calculation\'s caveat (the goal modal\'s own line) and still sum to the goal', () => {
    const s = buildState({}, { biologicalSex: 'male' });
    const f = hyroxCompetitiveFloors(hyroxCohortForState(s))!;
    const { plan } = planFor(buildState({ targetFinishTimeSec: f.totalSec + 120 }, { biologicalSex: 'male' }));
    expect(plan.feasibility).toBe('stretch');
    expect(plan.caveat).toBeTruthy();
    expect(plan.basis).toBe('goal');
    expect(plan.legs[15].clockSec).toBe(f.totalSec + 120);
  });
});

describe('doubles', () => {
  it('reads the pair\'s division: floors and splits are the pair\'s times', () => {
    const s = buildState({ format: 'open_doubles', division: 'mixed' });
    const p = predictHyroxRace(s)!;
    const opts = hyroxGoalBackCalcOptions(s, p, p.totalSec - 300);
    expect(opts.floors!.stationSec).toEqual(hyroxCompetitiveFloors({ format: 'open_doubles', sex: 'mixed' })!.stationSec);
    const plan = buildHyroxRacePlan(buildState({ format: 'open_doubles', division: 'mixed', targetFinishTimeSec: p.totalSec - 300 }), p);
    expect(plan.isDoubles).toBe(true);
    expect(plan.cohort).toEqual({ format: 'open_doubles', sex: 'mixed' });
    // Forecast column: the pair's station lines.
    plan.legs.filter(l => l.kind === 'station').forEach(l => {
      expect(l.forecastSec).toBe(p.stations.find(x => x.station === l.station)!.adjustedSec);
    });
    expect(plan.legs[15].clockSec).toBe(p.totalSec - 300);
  });

  it('women\'s and men\'s pairs read their own division floors', () => {
    const w = buildState({ format: 'pro_doubles', division: 'women' });
    const pw = predictHyroxRace(w)!;
    const f = hyroxGoalBackCalcOptions(w, pw, pw.totalSec - 100).floors!;
    expect(f.runSec).toBe(hyroxCompetitiveFloors({ format: 'pro_doubles', sex: 'female' })!.runSec);
  });
});

describe('roundToTotal', () => {
  it('whole numbers that sum to the total, each within 1 of its value', () => {
    const v = [10.4, 20.4, 30.2, 39.0];
    const r = roundToTotal(v, 100);
    expect(r.reduce((a, b) => a + b, 0)).toBe(100);
    r.forEach((x, i) => expect(Math.abs(x - v[i])).toBeLessThan(1));
  });
});
