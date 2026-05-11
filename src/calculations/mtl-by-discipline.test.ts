import { describe, expect, it } from 'vitest';
import {
  computeWeekMTLByDiscipline,
  computeMTLFitnessFatigueByDiscipline,
  computeWeekActualMTL,
  computeWeekActualMTLByDiscipline,
  computeMTLFitnessFatigue,
} from './mtl';
import type { Week, Workout } from '@/types/state';

// All fixture workouts are treated as completed (matched to an activity) so
// the EMA functions credit them. The discipline-split CTL/ATL was switched to
// read actuals only (2026-05-11) — see SCIENCE_LOG / CHANGELOG.
function workout(discipline: 'run' | 'station' | 'brick', mtl: number): Workout {
  return {
    id: `w-${Math.random()}`,
    n: 'test',
    t: 'easy',
    discipline,
    musculoTendonLoad: mtl,
    matchedActivityId: 'stub-activity',
  } as unknown as Workout;
}

function week(triWorkouts: Workout[]): Week {
  return {
    w: 1, ph: 'base',
    triWorkouts,
    rated: {}, skip: [], cross: [],
    wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

describe('computeWeekMTLByDiscipline', () => {
  it('buckets workouts by discipline', () => {
    const wk = week([
      workout('run', 30),
      workout('run', 50),
      workout('station', 200),
      workout('brick', 150),
    ]);
    const result = computeWeekMTLByDiscipline(wk);
    expect(result.run).toBe(80);
    expect(result.station).toBe(200);
    expect(result.brick).toBe(150);
  });

  it('treats unknown discipline as run (fallback)', () => {
    const wk = week([
      { id: 'x', n: 'test', t: 'easy', musculoTendonLoad: 40 } as unknown as Workout,
    ]);
    const result = computeWeekMTLByDiscipline(wk);
    expect(result.run).toBe(40);
    expect(result.station).toBe(0);
    expect(result.brick).toBe(0);
  });

  it('returns zeros for an empty week', () => {
    const wk = week([]);
    const result = computeWeekMTLByDiscipline(wk);
    expect(result).toEqual({ run: 0, station: 0, brick: 0 });
  });
});

describe('computeMTLFitnessFatigueByDiscipline', () => {
  it('produces separate CTL/ATL per discipline', () => {
    const weeks: Week[] = [
      week([workout('run', 100), workout('station', 500)]),
      week([workout('run', 100), workout('station', 500)]),
      week([workout('run', 100), workout('station', 500)]),
      week([workout('run', 100), workout('station', 500)]),
    ];
    const r = computeMTLFitnessFatigueByDiscipline(weeks, 3);
    // After 4 identical weeks the EMA should approach steady state.
    // Daily-equivalent values (÷7) — exact values depend on EMA decay.
    expect(r.runMtlCTL).toBeGreaterThan(0);
    expect(r.stationMtlCTL).toBeGreaterThan(r.runMtlCTL);  // 500 > 100
    expect(r.brickMtlCTL).toBe(0);  // no brick workouts
    expect(r.runMtlATL).toBeGreaterThan(0);
    expect(r.stationMtlATL).toBeGreaterThan(r.runMtlATL);
  });

  it('CTL stays below ATL when load is rising (recent weeks heavier)', () => {
    const weeks: Week[] = [
      week([workout('station', 100)]),
      week([workout('station', 100)]),
      week([workout('station', 500)]),
      week([workout('station', 500)]),
    ];
    const r = computeMTLFitnessFatigueByDiscipline(weeks, 3);
    expect(r.stationMtlATL).toBeGreaterThan(r.stationMtlCTL);
  });

  it('respects currentWeekIndex limit', () => {
    const weeks: Week[] = [
      week([workout('run', 1000)]),  // huge load
      week([workout('run', 0)]),
      week([workout('run', 0)]),
    ];
    const r0 = computeMTLFitnessFatigueByDiscipline(weeks, 0);
    const r2 = computeMTLFitnessFatigueByDiscipline(weeks, 2);
    // CTL after just week 0 should be higher than after weeks 0+1+2 (since weeks 1-2 are zero-load).
    expect(r0.runMtlATL).toBeGreaterThan(r2.runMtlATL);
  });
});

// ── Actual (matched-only) computation ────────────────────────────────────────

describe('computeWeekActualMTL', () => {
  it('only counts workouts with a matchedActivityId', () => {
    const wk = week([
      workout('run', 50),                // matched (fixture default)
      { id: 'unmatched', n: '', t: '', discipline: 'station', musculoTendonLoad: 999 } as unknown as Workout,
    ]);
    expect(computeWeekActualMTL(wk)).toBe(50);
  });

  it('returns 0 when nothing is matched', () => {
    const wk = week([
      { id: 'a', n: '', t: '', discipline: 'station', musculoTendonLoad: 200 } as unknown as Workout,
    ]);
    expect(computeWeekActualMTL(wk)).toBe(0);
  });
});

describe('computeWeekActualMTLByDiscipline', () => {
  it('buckets only matched workouts', () => {
    const wk = week([
      workout('station', 200),
      workout('run', 80),
      { id: 'u', n: '', t: '', discipline: 'brick', musculoTendonLoad: 999 } as unknown as Workout,
    ]);
    const r = computeWeekActualMTLByDiscipline(wk);
    expect(r.station).toBe(200);
    expect(r.run).toBe(80);
    expect(r.brick).toBe(0);
  });
});

describe('computeMTLFitnessFatigue uses actuals', () => {
  it('returns 0 when no workouts are matched (fresh user)', () => {
    const weeks: Week[] = [
      week([{ id: 'u1', n: '', t: '', discipline: 'station', musculoTendonLoad: 500 } as unknown as Workout]),
      week([{ id: 'u2', n: '', t: '', discipline: 'station', musculoTendonLoad: 500 } as unknown as Workout]),
    ];
    const r = computeMTLFitnessFatigue(weeks, 1);
    expect(r.mtlCTL).toBe(0);
    expect(r.mtlATL).toBe(0);
  });

  it('credits matched workouts in the EMA', () => {
    const weeks: Week[] = [
      week([workout('station', 500)]),
      week([workout('station', 500)]),
    ];
    const r = computeMTLFitnessFatigue(weeks, 1);
    expect(r.mtlCTL).toBeGreaterThan(0);
    expect(r.mtlATL).toBeGreaterThan(0);
  });
});
