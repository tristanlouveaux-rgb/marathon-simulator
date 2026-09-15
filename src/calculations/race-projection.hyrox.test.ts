import { describe, expect, it } from 'vitest';
import { buildHyroxProjection } from './race-projection.hyrox';
import { predictHyroxRace } from './race-prediction.hyrox';
import type { SimulatorState } from '@/types/state';

function buildState(overrides: Partial<SimulatorState['hyroxConfig']> = {}, extra: Partial<SimulatorState> = {}): SimulatorState {
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
      stationSessionsPerWeek: 2,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
    w: 1,
    wks: [],
    ...extra,
  } as unknown as SimulatorState;
}

describe('buildHyroxProjection', () => {
  it('returns same time when no factors fire', () => {
    const s = buildState();
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    // No race date → weeksRemaining = 0, no taper bonus.
    // No mtlCTL → no fitness factor. Default sessions match band → no volume factor.
    // No history → adherence = 1.0 → no penalty.
    expect(proj.projectedTotalSec).toBe(p.totalSec);
    expect(proj.factors.length).toBe(0);
  });

  it('applies a fitness bonus when MTL CTL is above band anchor', () => {
    const s = buildState({ mtlCTL: 200 });  // intermediate anchor ~ 130
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.improvementSec).toBeLessThan(0);
    const fitnessFactor = proj.factors.find(f => f.name === 'Training fitness');
    expect(fitnessFactor).toBeDefined();
    expect(fitnessFactor!.deltaSec).toBeLessThan(0);
  });

  it('applies a fitness penalty when MTL CTL is below band anchor', () => {
    const s = buildState({ mtlCTL: 50 });  // below intermediate anchor
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.improvementSec).toBeGreaterThan(0);
    const fitnessFactor = proj.factors.find(f => f.name === 'Training fitness');
    expect(fitnessFactor!.deltaSec).toBeGreaterThan(0);
  });

  it('applies a taper bonus via the horizon models when race is within taper window', () => {
    const tomorrow7d = new Date();
    tomorrow7d.setDate(tomorrow7d.getDate() + 7);
    const raceDate = tomorrow7d.toISOString().slice(0, 10);
    // Planned sessions need to be in `wks` for `plannedHyroxSessionsPerWeek`
    // to return >0. Without them, the horizon's undertraining penalty
    // cancels the taper bonus.
    const triWorkouts = Array(6).fill(null).map((_, i) => ({ d: i, t: 'run', m: 'Easy 5km', km: 5 }));
    const wks = [{ triWorkouts }, { triWorkouts }, { triWorkouts }, { triWorkouts }];
    const s = buildState({ raceDate }, { wks } as unknown as Partial<SimulatorState>);
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    // Taper is owned by the per-discipline horizon models. No separate
    // "Taper bonus" factor. The stations + roxzone horizons apply their
    // per-class taper bonus when inside the window, so the headline
    // projection is faster than today.
    expect(proj.improvementSec).toBeLessThan(0);
    expect(proj.factors.find(f => f.name === 'Taper bonus')).toBeUndefined();
    const stationsTraj = proj.factors.find(f => f.name === 'Stations fitness trajectory');
    expect(stationsTraj).toBeDefined();
    expect(stationsTraj!.deltaSec).toBeLessThan(0);
  });

  it('attributes a running-fitness gain to the run discipline via VDOT horizon', () => {
    const eightWeeks = new Date();
    eightWeeks.setDate(eightWeeks.getDate() + 8 * 7);
    const raceDate = eightWeeks.toISOString().slice(0, 10);
    const s = buildState({ raceDate }, { v: 50, wkm: 50, typ: 'Balanced' } as Partial<SimulatorState>);
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    // Run portion should project faster than today.
    expect(proj.byDiscipline.run.projectedSec).toBeLessThan(p.runSec);
    // A "Running fitness trajectory" factor should appear in the breakdown.
    const runTraj = proj.factors.find(f => f.name === 'Running fitness trajectory');
    expect(runTraj).toBeDefined();
    expect(runTraj!.deltaSec).toBeLessThan(0);
  });

  it('does not project a run-fitness gain when the race has already passed', () => {
    const s = buildState({}, { v: 50, wkm: 50 } as Partial<SimulatorState>);  // no raceDate
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.byDiscipline.run.deltaSec).toBe(0);
    expect(proj.factors.find(f => f.name === 'Running fitness trajectory')).toBeUndefined();
  });

  it('reconciles: projectedTotalSec equals sum of byDiscipline projections', () => {
    // Race in 8 weeks, planned sessions present, VDOT set → all three
    // horizons fire and the factor model has work to do.
    const eightWeeks = new Date();
    eightWeeks.setDate(eightWeeks.getDate() + 8 * 7);
    const raceDate = eightWeeks.toISOString().slice(0, 10);
    const triWorkouts = Array(6).fill(null).map((_, i) => ({ d: i, t: 'run', m: 'Easy 5km', km: 5 }));
    const wks = [{ triWorkouts }, { triWorkouts }, { triWorkouts }, { triWorkouts }];
    const s = buildState(
      { raceDate, mtlCTL: 200 },
      { v: 50, wkm: 50, typ: 'Balanced', wks } as unknown as Partial<SimulatorState>,
    );
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const sumOfDisciplines =
      proj.byDiscipline.run.projectedSec +
      proj.byDiscipline.stations.projectedSec +
      proj.byDiscipline.roxzone.projectedSec;
    expect(proj.projectedTotalSec).toBe(sumOfDisciplines);
  });

  it('reconciles: byDiscipline.stations roughly matches the per-station horizon sum', () => {
    // Without any factor modulator firing, byDiscipline.stations equals the
    // raw horizon sum exactly. With modulators, they differ by `factorPct ×
    // stationsHorizon`. Either way, the per-station rows the UI shows must
    // be the same series fed into byDiscipline.stations.
    const eightWeeks = new Date();
    eightWeeks.setDate(eightWeeks.getDate() + 8 * 7);
    const raceDate = eightWeeks.toISOString().slice(0, 10);
    const triWorkouts = Array(6).fill(null).map((_, i) => ({ d: i, t: 'run', m: 'Easy 5km', km: 5 }));
    const wks = [{ triWorkouts }, { triWorkouts }, { triWorkouts }, { triWorkouts }];
    const s = buildState({ raceDate }, { wks } as unknown as Partial<SimulatorState>);
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(p.projection).toBeDefined();
    const perStationSum = p.projection!.stations.reduce((sum, st) => sum + st.projectedSec, 0);
    // No MTL CTL, default sessions, perfect adherence, taper at 8w-out is
    // fully outside the readiness window → factorPct ≈ 0. byDiscipline.
    // stations should equal perStationSum within ±2s rounding tolerance.
    expect(Math.abs(proj.byDiscipline.stations.projectedSec - perStationSum)).toBeLessThanOrEqual(2);
  });

  it('reconciles: sum of factors[].deltaSec equals improvementSec', () => {
    // Transparency contract. The factor breakdown the UI shows must sum to
    // the headline delta. With MTL above anchor, run horizon, and station
    // horizon all firing, the breakdown should still close.
    const eightWeeks = new Date();
    eightWeeks.setDate(eightWeeks.getDate() + 8 * 7);
    const raceDate = eightWeeks.toISOString().slice(0, 10);
    const triWorkouts = Array(6).fill(null).map((_, i) => ({ d: i, t: 'run', m: 'Easy 5km', km: 5 }));
    const wks = [{ triWorkouts }, { triWorkouts }, { triWorkouts }, { triWorkouts }];
    const s = buildState(
      { raceDate, mtlCTL: 200 },
      { v: 50, wkm: 50, typ: 'Balanced', wks } as unknown as Partial<SimulatorState>,
    );
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const factorSum = proj.factors.reduce((s, f) => s + f.deltaSec, 0);
    // Multiple Math.round calls per factor row → tolerance of ±factor count.
    expect(Math.abs(factorSum - proj.improvementSec)).toBeLessThanOrEqual(proj.factors.length);
  });

  it('confidence range widens for far-out races and low confidence', () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 16 * 7);
    const raceDate = farFuture.toISOString().slice(0, 10);
    const s = buildState({ raceDate }); // no calibration → low confidence
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const halfRange = (proj.confidenceRangeSec[1] - proj.confidenceRangeSec[0]) / 2;
    // Base 4% + 1% (>4w) + 1% (>12w) + 2% (low conf) = 8% → halfRange ≈ 8% of total
    expect(halfRange).toBeGreaterThan(p.totalSec * 0.06);
  });
});

// ─── Plan adherence factor ──────────────────────────────────────────────────
// Regression cover for the Record-vs-array defect: `wk.garminActuals` is
// Record<workoutId, GarminActual>, so the old `(wk.garminActuals ?? []).length`
// read undefined, Math.min(undefined, planned) produced NaN, and the consumer's
// `adherence < 0.95` was false for NaN — silently dropping the entire factor.
// A `const wk: any` cast hid it from tsc. These tests assert the factor actually
// fires, so a regression cannot pass by doing nothing.
describe('buildHyroxProjection — plan adherence', () => {
  /** N planned sessions, M of them matched to a synced actual. */
  function week(planned: number, completed: number) {
    const garminActuals: Record<string, any> = {};
    for (let i = 0; i < completed; i++) {
      garminActuals[`w${i}`] = { garminId: `strava-${i}`, durationSec: 1800 };
    }
    return {
      triWorkouts: Array.from({ length: planned }, (_, i) => ({ id: `w${i}`, t: 'station' })),
      garminActuals,
    };
  }

  // currentIdx = w - 1 = 4; startIdx = max(0, 4 - 3) = 1 → weeks at index 1,2,3.
  const atWeek5 = (wks: any[]) => ({ w: 5, wks });

  it('fires a slowdown when half the planned sessions were completed', () => {
    const s = buildState({}, atWeek5([week(4, 4), week(4, 2), week(4, 2), week(4, 2), week(4, 0)]));
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const f = proj.factors.find(x => x.name === 'Plan adherence');
    expect(f).toBeDefined();                    // NaN adherence would omit it entirely
    expect(Number.isFinite(f!.deltaSec)).toBe(true);
    expect(f!.deltaSec).toBeGreaterThan(0);     // missed sessions slow you down
    expect(f!.explanation).toContain('50%');    // 6 of 12 across the lookback
  });

  it('adds no adherence factor when every planned session was completed', () => {
    const s = buildState({}, atWeek5([week(3, 3), week(3, 3), week(3, 3), week(3, 3), week(3, 0)]));
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(proj.factors.find(x => x.name === 'Plan adherence')).toBeUndefined();
  });

  it('applies the full penalty when nothing was completed', () => {
    const s = buildState({}, atWeek5([week(3, 0), week(3, 0), week(3, 0), week(3, 0), week(3, 0)]));
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    const f = proj.factors.find(x => x.name === 'Plan adherence');
    expect(f).toBeDefined();
    expect(f!.explanation).toContain('0%');
    // 4% of the predicted total, the documented ceiling for this factor.
    expect(f!.deltaSec).toBeCloseTo(p.totalSec * 0.04, 0);
  });

  it('never yields a non-finite projected time', () => {
    const s = buildState({}, atWeek5([week(4, 2), week(0, 0), week(4, 4), week(2, 1), week(4, 0)]));
    const p = predictHyroxRace(s)!;
    const proj = buildHyroxProjection(s, p);
    expect(Number.isFinite(proj.projectedTotalSec)).toBe(true);
    expect(Number.isFinite(proj.improvementSec)).toBe(true);
  });
});
