import { describe, expect, it } from 'vitest';
import { createDefaultInjuryState } from '@/types/injury';
import type { InjuryState } from '@/types/injury';
import type { SimulatorState } from '@/types/state';
import { HYROX_STATION_REGION, stationInjuryBuildWeeks, runInjuryBuildWeeks, injuryWithResumeFallback } from './hyrox-injury';
import { buildHyroxProjection } from './race-projection.hyrox';
import { predictHyroxRace } from './race-prediction.hyrox';

/** Active injury with per-discipline capacity + resume weeks set. */
function injury(overrides: Partial<InjuryState>): InjuryState {
  return { ...createDefaultInjuryState(), active: true, injuryPhase: 'rehab', ...overrides };
}

function buildState(
  overrides: Partial<SimulatorState['hyroxConfig']> = {},
  extra: Partial<SimulatorState> = {},
): SimulatorState {
  return {
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1300,
      mtlHistory: [],
      runsPerWeek: 3,
      // The intermediate band default (HYROX_WEEKLY_SESSIONS: 3 runs, 1
      // station session, 1 brick since 2026-10-12), so no volume factor fires.
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
    w: 1,
    wks: [],
    ...extra,
  } as unknown as SimulatorState;
}

/** Race 8 weeks out with planned sessions so every horizon fires. */
function eightWeekState(extraHx: Partial<SimulatorState['hyroxConfig']> = {}, injuryState?: InjuryState): SimulatorState {
  const d = new Date();
  d.setDate(d.getDate() + 8 * 7);
  const raceDate = d.toISOString().slice(0, 10);
  const triWorkouts = Array(6).fill(null).map((_, i) => ({ d: i, t: 'run', m: 'Easy 5km', km: 5 }));
  const wks = [{ triWorkouts }, { triWorkouts }, { triWorkouts }, { triWorkouts }];
  return buildState(
    { raceDate, ...extraHx },
    { v: 50, wkm: 50, typ: 'Balanced', wks, injuryState } as unknown as Partial<SimulatorState>,
  );
}

describe('HYROX_STATION_REGION', () => {
  it('classifies every station', () => {
    expect(HYROX_STATION_REGION.ski_erg).toBe('upper');
    expect(HYROX_STATION_REGION.sled_push).toBe('lower');
    expect(HYROX_STATION_REGION.sandbag_lunges).toBe('lower');
    expect(HYROX_STATION_REGION.sled_pull).toBe('full');
    expect(HYROX_STATION_REGION.row_erg).toBe('full');
    expect(HYROX_STATION_REGION.wall_balls).toBe('full');
    expect(Object.keys(HYROX_STATION_REGION)).toHaveLength(8);
  });
});

describe('stationInjuryBuildWeeks', () => {
  it('returns full weeks with no active injury', () => {
    expect(stationInjuryBuildWeeks(undefined, 'ski_erg', 10)).toBe(10);
    const inactive = { ...createDefaultInjuryState(), active: false };
    expect(stationInjuryBuildWeeks(inactive, 'sled_push', 10)).toBe(10);
  });

  it('debits an upper station for an upper-body injury, leaves lower stations alone', () => {
    const inj = injury({
      runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 100,
      resumeWeeksByDiscipline: { upperLoad: 4 },
    });
    // ski_erg (upper): 10 - 4*(1-0) = 6
    expect(stationInjuryBuildWeeks(inj, 'ski_erg', 10)).toBe(6);
    // sled_push (lower): no lowerLoad window → unaffected
    expect(stationInjuryBuildWeeks(inj, 'sled_push', 10)).toBe(10);
  });

  it('debits a lower station for a lower-body injury, leaves upper stations alone', () => {
    const inj = injury({
      runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: 0,
      resumeWeeksByDiscipline: { lowerLoad: 5 },
    });
    expect(stationInjuryBuildWeeks(inj, 'sled_push', 10)).toBe(5);   // lower
    expect(stationInjuryBuildWeeks(inj, 'ski_erg', 10)).toBe(10);    // upper, unaffected
  });

  it('debits a full-body station by the worse of upper/lower', () => {
    const inj = injury({
      runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 50,
      resumeWeeksByDiscipline: { upperLoad: 4, lowerLoad: 4 },
    });
    // upper adj = 10 - 4*(1-0) = 6 ; lower adj = 10 - 4*(1-0.5) = 8 ; worse = 6
    expect(stationInjuryBuildWeeks(inj, 'sled_pull', 10)).toBe(6);
  });

  it('blocks all build for a fully-blocked region (capacity 0, full window)', () => {
    const inj = injury({ upperLoadCapacity: 0, resumeWeeksByDiscipline: { upperLoad: 10 } });
    expect(stationInjuryBuildWeeks(inj, 'ski_erg', 10)).toBe(0);
  });

  it('partial debit at reduced capacity', () => {
    const inj = injury({ upperLoadCapacity: 50, resumeWeeksByDiscipline: { upperLoad: 4 } });
    // 10 - 4*(1-0.5) = 8
    expect(stationInjuryBuildWeeks(inj, 'ski_erg', 10)).toBe(8);
  });
});

describe('injuryWithResumeFallback', () => {
  it('returns the input untouched when no active injury', () => {
    expect(injuryWithResumeFallback(undefined)).toBeUndefined();
    const inactive = { ...createDefaultInjuryState(), active: false };
    expect(injuryWithResumeFallback(inactive)).toBe(inactive);
  });

  it('fills a restricted discipline that lacks an explicit window (protocol midpoint)', () => {
    // general protocol typicalRecoveryWeeks {1,4} → midpoint 3.
    const inj = injury({ type: 'general', upperLoadCapacity: 0 }); // no resumeWeeksByDiscipline
    const eff = injuryWithResumeFallback(inj)!;
    expect(eff.resumeWeeksByDiscipline?.upperLoad).toBe(3);
  });

  it('does not overwrite an explicit window', () => {
    const inj = injury({ type: 'general', upperLoadCapacity: 0, resumeWeeksByDiscipline: { upperLoad: 6 } });
    expect(injuryWithResumeFallback(inj)!.resumeWeeksByDiscipline?.upperLoad).toBe(6);
  });

  it('leaves full-capacity disciplines alone', () => {
    const inj = injury({ type: 'general', upperLoadCapacity: 0, lowerLoadCapacity: 100, runCapacity: 100 });
    const eff = injuryWithResumeFallback(inj)!;
    expect(eff.resumeWeeksByDiscipline?.lowerLoad).toBeUndefined();
    expect(eff.resumeWeeksByDiscipline?.run).toBeUndefined();
  });
});

describe('debit fires WITHOUT an explicit resume window (protocol fallback)', () => {
  it('stationInjuryBuildWeeks debits an upper station for a blocked arm and no window', () => {
    const inj = injury({ type: 'general', upperLoadCapacity: 0, lowerLoadCapacity: 100, runCapacity: 100 });
    // fallback 3 weeks, fully blocked → 10 - 3 = 7
    expect(stationInjuryBuildWeeks(inj, 'ski_erg', 10)).toBe(7);
    // lower station untouched
    expect(stationInjuryBuildWeeks(inj, 'sled_push', 10)).toBe(10);
  });

  it('runInjuryBuildWeeks debits a blocked run with no window', () => {
    const inj = injury({ type: 'general', runCapacity: 0, upperLoadCapacity: 100, lowerLoadCapacity: 100 });
    expect(runInjuryBuildWeeks(inj, 10)).toBe(7);
  });
});

describe('buildHyroxProjection injury integration', () => {
  it('a blocked run removes the projected run gain', () => {
    const healthy = buildHyroxProjection(eightWeekState(), predictHyroxRace(eightWeekState())!);
    expect(healthy.byDiscipline.run.deltaSec).toBeLessThan(0); // run improves when healthy

    const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 8 } });
    const sInjured = eightWeekState({}, inj);
    const injured = buildHyroxProjection(sInjured, predictHyroxRace(sInjured)!);
    expect(injured.byDiscipline.run.deltaSec).toBe(0); // blocked all 8 weeks → no gain
  });

  it('an upper-body injury reduces the projected stations gain', () => {
    const sHealthy = eightWeekState();
    const healthy = buildHyroxProjection(sHealthy, predictHyroxRace(sHealthy)!);
    const healthyStationsGain = healthy.byDiscipline.stations.deltaSec; // negative

    const inj = injury({
      runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 100,
      resumeWeeksByDiscipline: { upperLoad: 8 },
    });
    const sInjured = eightWeekState({}, inj);
    const injured = buildHyroxProjection(sInjured, predictHyroxRace(sInjured)!);

    // Upper + full stations lose their build → smaller (less negative) gain.
    expect(injured.byDiscipline.stations.deltaSec).toBeGreaterThan(healthyStationsGain);
  });

  it('an arm injury with NO explicit resume window still reduces the projected stations gain', () => {
    // Reproduces the "forecast doesn't change at all" report: capacity set but
    // no resume weeks captured. The protocol fallback must still debit.
    const sHealthy = eightWeekState();
    const healthy = buildHyroxProjection(sHealthy, predictHyroxRace(sHealthy)!);

    const inj = injury({ type: 'general', upperLoadCapacity: 0, lowerLoadCapacity: 100, runCapacity: 100 });
    delete inj.resumeWeeksByDiscipline; // explicitly no captured window
    const sInjured = eightWeekState({}, inj);
    const injured = buildHyroxProjection(sInjured, predictHyroxRace(sInjured)!);

    expect(injured.byDiscipline.stations.deltaSec).toBeGreaterThan(healthy.byDiscipline.stations.deltaSec);
  });

  it('no injury leaves the projection identical to the healthy path', () => {
    const s1 = eightWeekState();
    const s2 = eightWeekState({}, { ...createDefaultInjuryState(), active: false });
    const p1 = buildHyroxProjection(s1, predictHyroxRace(s1)!);
    const p2 = buildHyroxProjection(s2, predictHyroxRace(s2)!);
    expect(p2.projectedTotalSec).toBe(p1.projectedTotalSec);
  });
});
