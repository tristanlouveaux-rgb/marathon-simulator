/**
 * HYROX completions reach the MTL signal (cross-mode audit f2).
 *
 * computeWeekActualMTL counted only triWorkouts carrying `matchedActivityId`,
 * which only the triathlon matcher and the cross-source twin rebind set. The
 * HYROX matcher, Mark as Done and quick done key an activity record by the
 * slot (`wk.garminActuals[id || n]`) instead, so HYROX actual MTL read 0 however
 * much the athlete trained: the Stats MTL card stayed empty, the MTL readiness
 * term never switched on, and every week advance stamped ctlRatio = 0, which
 * clamped the next week toward deload volume.
 *
 * Real generator, real matchAndAutoComplete, real resolveMtlAdherence and
 * regenerateHyroxWeek. saveState and the renderer are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { generateHyroxPlan, regenerateHyroxWeek, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { matchAndAutoComplete, type GarminActivityRow } from './activity-matcher';
import { computeWeekActualMTL, computeWeekActualMTLByDiscipline, computeWeekMTL, resolveMtlAdherence } from './mtl';
import type { SimulatorState, Week, Workout } from '@/types/state';

const PLAN_START = '2026-09-28'; // a Monday

/** An intermediate HYROX plan from the band defaults the onboarding initializer uses. */
function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = PLAN_START;
  s.w = 1;
  s.tw = 16;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    generatorVersion: HYROX_GENERATOR_VERSION,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

/** A synced activity for a planned session: on its day (local noon), at its planned duration. */
function rowFor(w: Workout, garminId: string): GarminActivityRow {
  const isRun = w.discipline === 'run';
  return {
    garmin_id: garminId,
    activity_type: isRun ? 'RUNNING' : 'HIIT',
    start_time: new Date(2026, 8, 28 + (w.dayOfWeek ?? 0), 12, 0, 0).toISOString(),
    duration_sec: (w.estimatedDurationMin ?? 0) * 60,
    distance_m: 0,
    avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null,
  };
}

const plannedMinutes = (wk: Week | null): number =>
  (wk?.triWorkouts ?? []).reduce((sum, w) => sum + (w.estimatedDurationMin ?? 0), 0);

/**
 * Week advance, the HYROX re-anchor step of events.next() (events.ts, "Load-gap
 * re-anchor"): stamp next week's ctlRatio only when behind, then move on and
 * re-bake the new current week.
 */
function advanceAndRegenerateWeek2(s: SimulatorState): Week | null {
  const m = resolveMtlAdherence(s, 1);
  if (m.valid && m.ratio < 1) s.wks[1].ctlRatio = m.ratio; else delete s.wks[1].ctlRatio;
  s.w = 2;
  return regenerateHyroxWeek(s, 2);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('HYROX actual MTL counts sessions completed through the HYROX paths', () => {
  it('three sessions matched by matchAndAutoComplete sum to their planned MTL', () => {
    setState(hyroxState());
    const wk = getMutableState().wks[0];
    const picks = ['Tempo Run', 'Station Circuit', 'Easy Run'].map(n => wk.triWorkouts!.find(w => w.n === n)!);
    expect(picks.every(w => (w.musculoTendonLoad ?? 0) > 0)).toBe(true);

    matchAndAutoComplete(picks.map((w, i) => rowFor(w, `strava-${i}`)));

    for (const w of picks) expect(wk.garminActuals?.[w.id!]).toBeDefined();
    expect(picks.some(w => w.matchedActivityId)).toBe(false); // the HYROX matcher keys by slot only
    const expected = picks.reduce((sum, w) => sum + w.musculoTendonLoad!, 0);
    expect(computeWeekActualMTL(wk)).toBeCloseTo(expected, 6); // was 0
    const split = computeWeekActualMTLByDiscipline(wk);
    expect(split.run + split.station + split.brick).toBeCloseTo(expected, 6);
  });

  it('a fully completed week reads on plan: ratio >= 1, no ctlRatio stamp, week 2 keeps its planned volume', () => {
    setState(hyroxState());
    const s = getMutableState();
    const wk1 = s.wks[0];
    const fullWeek2 = plannedMinutes(s.wks[1]);
    matchAndAutoComplete(wk1.triWorkouts!.map((w, i) => rowFor(w, `strava-W1-${i}`)));
    expect(wk1.triWorkouts!.every(w => wk1.garminActuals?.[w.id!])).toBe(true);
    expect(computeWeekActualMTL(wk1)).toBeCloseTo(computeWeekMTL(wk1), 6);

    const m = resolveMtlAdherence(s, 1);
    expect(m.valid).toBe(true);
    expect(m.ratio).toBeGreaterThanOrEqual(1); // was 0

    const week2 = advanceAndRegenerateWeek2(s);
    expect(s.wks[1].ctlRatio).toBeUndefined();
    // 223 min since lane H3b (station seeds are real band medians); 220
    // before, and cut to 172 before the completion fix.
    expect(plannedMinutes(week2)).toBe(fullWeek2);
    expect(fullWeek2).toBe(223);
  });

  it('a week with nothing done still reads 0 and still re-anchors next week down', () => {
    setState(hyroxState());
    const s = getMutableState();
    const fullWeek2 = plannedMinutes(s.wks[1]);
    expect(computeWeekActualMTL(s.wks[0])).toBe(0);

    const week2 = advanceAndRegenerateWeek2(s);
    expect(s.wks[1].ctlRatio).toBe(0);
    expect(plannedMinutes(week2)).toBeLessThan(fullWeek2);
  });

  it('a matched station session keeps no parallel accumulator: the slot record is the only source', () => {
    setState(hyroxState());
    const st = getMutableState();
    const wk = st.wks[0];
    const circuit = wk.triWorkouts!.find(w => w.n === 'Station Circuit')!;

    matchAndAutoComplete([rowFor(circuit, 'strava-st')]);

    expect(wk.garminActuals?.[circuit.id!]).toBeDefined();
    // hyroxConfig.weeklyActualMTL had a writer (this branch) and no reader.
    expect(st.hyroxConfig!.weeklyActualMTL).toBeUndefined();
    expect(computeWeekActualMTL(wk)).toBeCloseTo(circuit.musculoTendonLoad!, 6);
  });

  it('a session rated done with no activity record stays uncounted', () => {
    const s = hyroxState();
    const wk = s.wks[0];
    const easy = wk.triWorkouts!.find(w => w.n === 'Easy Run')!;
    wk.rated[easy.id!] = 4;
    expect(computeWeekActualMTL(wk)).toBe(0);
  });
});
