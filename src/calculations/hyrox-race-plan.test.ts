import { describe, expect, it } from 'vitest';
import { predictHyroxRace } from './race-prediction.hyrox';
import {
  buildHyroxRacePlan,
  hyroxGoalBackCalcOptions,
  hyroxGoalFloorSec,
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

const RACE_ORDER = [
  'Run 1', 'SkiErg', 'Run 2', 'Sled Push', 'Run 3', 'Sled Pull', 'Run 4', 'Burpee Broad Jumps',
  'Run 5', 'Row Erg', 'Run 6', 'Farmer Carry', 'Run 7', 'Sandbag Lunges', 'Run 8', 'Wall Balls',
];

describe('buildHyroxRacePlan: shape and clock', () => {
  it('16 legs in race order plus the Roxzone', () => {
    const { plan } = planFor(buildState());
    expect(plan.legs.map(l => l.label)).toEqual(RACE_ORDER);
    expect(plan.legs.filter(l => l.kind === 'station').map(l => l.station)).toEqual(HYROX_STATION_ORDER);
    expect(plan.roxzone.goalSec).toBeGreaterThan(0);
  });

  it('legs and Roxzone sum to the goal; the clock ends on it', () => {
    const state = buildState();
    const fc = predictHyroxRace(state)!.totalSec;
    const s = buildState({ targetFinishTimeSec: fc - 240 });
    const { plan } = planFor(s);
    expect(plan.goalSource).toBe('goal');
    expect(plan.feasibility).not.toBe('unrealistic');
    const sum = plan.legs.reduce((a, l) => a + l.goalSec, 0) + plan.roxzone.goalSec;
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
      const gap = l.clockSec - prev - l.goalSec;
      expect(gap).toBeGreaterThanOrEqual(0);
      // No Roxzone before Run 1.
      if (i === 0) expect(gap).toBe(0);
      roxSeen += gap;
      prev = l.clockSec;
    });
    expect(roxSeen).toBe(plan.roxzone.goalSec);
    // Checkpoints are the run clocks.
    plan.checkpoints.slice(0, 8).forEach((c, k) => expect(c.clockSec).toBe(plan.legs[2 * k].clockSec));
  });

  it('no goal: the forecast is the target, its splits fill both columns', () => {
    const { plan, prediction } = planFor(buildState());
    expect(plan.goalSource).toBe('forecast');
    expect(plan.goalSec).toBe(prediction.totalSec);
    expect(plan.legs[15].clockSec).toBe(prediction.totalSec);
    plan.legs.filter(l => l.kind === 'station').forEach(l => {
      expect(Math.abs(l.goalSec - l.forecastSec)).toBeLessThanOrEqual(1);
    });
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
    expect(plan.roxzone.forecastSec).toBe(Math.round(prediction.roxzoneSec));
  });
});

describe('buildHyroxRacePlan: run fade', () => {
  it('goal run legs follow the forecast\'s per-leg fatigue model, not a flat split', () => {
    const { plan, prediction } = planFor(buildState({ targetFinishTimeSec: 5200 }));
    const runs = plan.legs.filter(l => l.kind === 'run').map(l => l.goalSec);
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

describe('Roxzone at the goal', () => {
  it('scales with the goal from the real results; equal to the forecast at the forecast', () => {
    const s = buildState();
    const p = predictHyroxRace(s)!;
    const cohort = hyroxCohortForState(s);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec)).toBeCloseTo(p.roxzoneSec, 6);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec - 600)!).toBeLessThan(p.roxzoneSec);
    expect(hyroxRoxzoneAtGoalSec(cohort, p, p.totalSec + 600)!).toBeGreaterThan(p.roxzoneSec);
  });
});

describe('goal slower than the forecast', () => {
  it('eases every component and still sums to the goal', () => {
    const base = buildState();
    const fc = predictHyroxRace(base)!.totalSec;
    const { plan } = planFor(buildState({ targetFinishTimeSec: fc + 600 }));
    expect(plan.feasibility).toBe('already_on_pace');
    expect(plan.legs[15].clockSec).toBe(fc + 600);
    plan.legs.forEach(l => expect(l.goalSec).toBeGreaterThanOrEqual(l.forecastSec - 1));
    expect(plan.roxzone.goalSec).toBeGreaterThan(plan.roxzone.forecastSec);
  });
});

describe('unrealistic goals', () => {
  it('are flagged; the splits stop at the floors and the clock ends at that time', () => {
    const { plan } = planFor(buildState({ targetFinishTimeSec: 3000 }));
    expect(plan.feasibility).toBe('unrealistic');
    expect(plan.shortfallSec).toBeGreaterThan(0);
    expect(plan.planSec).toBeGreaterThan(3000);
    expect(plan.legs[15].clockSec).toBe(plan.planSec);
    expect(plan.planSec - plan.goalSec).toBeCloseTo(plan.shortfallSec, -1);
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

describe('hyroxGoalFloorSec', () => {
  it('is the cohort floors, or the forecast where that is faster', () => {
    const s = buildState();
    const p = predictHyroxRace(s)!;
    const f = hyroxCompetitiveFloors({ format: 'open_singles', sex: 'female' })!;
    const floor = hyroxGoalFloorSec(s, p);
    expect(floor).toBeLessThan(p.totalSec);
    expect(floor).toBeGreaterThanOrEqual(f.runSec + Object.values(f.stationSec).reduce((a, b) => a + b, 0) - 1 - 600);
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
