/**
 * HYROX chronic MTL is judged against the plan's prescription, not a band anchor.
 *
 * f2 let HYROX completions reach chronic MTL. That switched on two consumers
 * that compared it with 70% of the band's MTL cap: the race projection's
 * "Training fitness" factor and the staleness model's MTL mitigation signal.
 * The generator prescribes about 57% of cap in base (intermediate), so a fully
 * compliant athlete read as undertrained: +5% in week 1 (one week of EMA),
 * then +2.8 to 3.0% through weeks 2 to 6, with the copy "Currently
 * undertrained for your target", and a 0.35 mitigation signal that released
 * less of the staleness penalty.
 *
 * Both now read mtl.ts computeMtlChronicVsPlan: chronic MTL from completed
 * sessions against the chronic MTL the plan prescribed for the same completed
 * weeks, behind computeMtlAcwr's history guard. Real generator for every band,
 * the stored MTL values refreshed as main.ts does, real predictHyroxRace and
 * buildHyroxProjection, real computeHyroxStaleness.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import {
  computeMTLFitnessFatigue, computeMTLFitnessFatigueByDiscipline, computeMtlChronicVsPlan, hyroxMtlChronicVsPlan,
} from './mtl';
import { ROLLING_ACWR_MIN_OBSERVED_DAYS } from './fitness-model';
import { predictHyroxRace } from './race-prediction.hyrox';
import { buildHyroxProjection } from './race-projection.hyrox';
import { computeHyroxStaleness } from './hyrox-staleness';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const BANDS: AbilityBand[] = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner', 'total_beginner'];
const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function hyroxState(band: AbilityBand): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28'; // a Monday
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

/** The slot record a HYROX completion writes (wk.garminActuals[id]). */
function complete(wk: Week, w: Workout): void {
  wk.garminActuals ??= {};
  wk.garminActuals[w.id!] = {
    garminId: `guided-manual-${w.id}`, startTime: null, distanceKm: 0,
    durationSec: (w.estimatedDurationMin ?? 0) * 60,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
  };
}

/** The main.ts launch refresh of the stored MTL values. */
function refreshLikeMain(s: SimulatorState): void {
  const idx = s.w - 1;
  const { mtlCTL, mtlATL } = computeMTLFitnessFatigue(s.wks, idx);
  const split = computeMTLFitnessFatigueByDiscipline(s.wks, idx);
  Object.assign(s.hyroxConfig!, { mtlCTL, mtlATL, ...split });
}

/** Plan-compliant athlete at `week`: every session of every week through `week` completed. */
function compliantAt(band: AbilityBand, week: number): SimulatorState {
  const s = hyroxState(band);
  for (let i = 0; i < week; i++) (s.wks[i].triWorkouts ?? []).forEach(w => complete(s.wks[i], w));
  s.w = week;
  refreshLikeMain(s);
  return s;
}

describe('race projection: a plan-compliant athlete is not undertrained', () => {
  it('every band, weeks 1 to 7 with every session completed: no slower Training fitness factor, no undertrained copy', () => {
    const hits: string[] = [];
    for (const band of BANDS) {
      for (let week = 1; week <= 7; week++) {
        const s = compliantAt(band, week);
        const proj = buildHyroxProjection(s, predictHyroxRace(s)!);
        const f = proj.factors.find(x => x.name === 'Training fitness');
        if (f && (f.deltaSec > 0 || /undertrained/i.test(f.explanation))) hits.push(`${band} wk${week} +${f.deltaSec}s`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('a real shortfall still slows the projection once the history guard opens', () => {
    const s = hyroxState('intermediate');
    for (let i = 0; i < 5; i++) (s.wks[i].triWorkouts ?? []).filter(w => w.discipline === 'run').forEach(w => complete(s.wks[i], w));
    s.w = 6;
    refreshLikeMain(s);
    const cmp = hyroxMtlChronicVsPlan(s)!;
    expect(cmp.ratio!).toBeLessThan(1);
    const f = buildHyroxProjection(s, predictHyroxRace(s)!).factors.find(x => x.name === 'Training fitness');
    expect(f).toBeDefined();
    expect(f!.deltaSec).toBeGreaterThan(0);
    expect(f!.explanation).toContain(`${Math.round(cmp.ratio! * 100)}% of the load the plan prescribed through week 5`);
  });
});

describe('staleness: the MTL signal does not mark a plan-compliant athlete down', () => {
  /** Race 9 months ago; VDOT 5 above the band-implied value, so Signal 1 reads exactly 1.0. */
  function staleState(week: number): SimulatorState {
    const s = compliantAt('intermediate', week);
    s.v = 50; // intermediate implies 45
    s.ctlBaseline = undefined;
    s.hyroxConfig!.hyroxPreviousRaceDate = new Date(Date.now() - 9 * MONTH_MS).toISOString().slice(0, 10);
    return s;
  }

  it('after the history guard opens, a compliant athlete scores the at-plan value 0.5 (mean with VDOT 1.0 = 0.75)', () => {
    for (let week = 3; week <= 7; week++) {
      expect(computeHyroxStaleness(staleState(week)).physiologyMitigation, `week ${week}`).toBeCloseTo(0.75, 10);
    }
  });

  it('withholds the MTL signal while the history guard is closed', () => {
    for (const week of [1, 2]) {
      expect(computeHyroxStaleness(staleState(week)).physiologyMitigation, `week ${week}`).toBe(1);
    }
  });
});

describe('computeMtlChronicVsPlan', () => {
  it('reads exactly 1 for a compliant athlete, and its actual side is the stored chronic at the last completed week', () => {
    for (const band of BANDS) {
      const s = compliantAt(band, 6);
      const cmp = computeMtlChronicVsPlan(s.wks, s.w - 1);
      expect(cmp.reason).toBe('ok');
      expect(cmp.completedWeeks).toBe(5);
      expect(cmp.ratio).toBe(1);
      expect(cmp.actual).toBe(computeMTLFitnessFatigue(s.wks, 4).mtlCTL);
    }
  });

  it('leaves the current, partial week out: a compliant athlete on day 1 of a week still reads 1', () => {
    const s = hyroxState('intermediate');
    for (let i = 0; i < 4; i++) (s.wks[i].triWorkouts ?? []).forEach(w => complete(s.wks[i], w));
    s.w = 5; // nothing done yet in week 5
    expect(computeMtlChronicVsPlan(s.wks, s.w - 1).ratio).toBe(1);
  });

  it(`is withheld until ${ROLLING_ACWR_MIN_OBSERVED_DAYS} days of plan weeks are complete`, () => {
    const s = hyroxState('intermediate');
    expect(computeMtlChronicVsPlan(s.wks, 0)).toMatchObject({ ratio: null, reason: 'history' });
    expect(computeMtlChronicVsPlan(s.wks, 1)).toMatchObject({ ratio: null, reason: 'history' });
    expect(computeMtlChronicVsPlan(s.wks, ROLLING_ACWR_MIN_OBSERVED_DAYS / 7).reason).not.toBe('history');
  });

  it('is HYROX only', () => {
    const s = compliantAt('intermediate', 6);
    s.eventType = 'triathlon';
    expect(hyroxMtlChronicVsPlan(s)).toBeNull();
  });
});
