/**
 * HYROX MTL load ratio from a cold start (review of cross-mode fix f2).
 *
 * f2 made HYROX completions count toward actual MTL. That switched on the MTL
 * acute:chronic ratio, which Home and Readiness pass to computeReadiness as
 * `mtlAcwr` and Stats shows as its "Load ratio" row. Both EMAs started at 0,
 * as if every week before plan week 1 was a rest week. A plan-compliant athlete
 * read 3.06 / 2.44 / 1.93 / 1.82 / 1.68 in weeks 2 to 6 (intermediate), so the
 * readiness MTL floor held Home at Ease Back through most of the base phase.
 *
 * The fix mirrors running's rolling load ratio for unrecorded days
 * (computeRollingLoadRatio): weeks before the plan are missing, not rest, and
 * are valued at the athlete's own mean weekly MTL; the ratio is withheld until
 * ROLLING_ACWR_MIN_OBSERVED_DAYS of plan weeks are complete.
 *
 * Real generator for every band, real computeMTLFitnessFatigue as main.ts
 * runs it, real computeReadiness. Sessions are completed through slot records,
 * the record HYROX Mark as Done, quick done and the matcher write.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { computeMTLFitnessFatigue, computeMTLFitnessFatigueByDiscipline, computeMTLFitnessFatigueSeries, hyroxMtlAcwr } from './mtl';
import { computeReadiness } from './readiness';
import { ROLLING_ACWR_MIN_OBSERVED_DAYS } from './fitness-model';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const BANDS: AbilityBand[] = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner', 'total_beginner'];

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
    garminId: `guided-manual-${w.id}`,
    startTime: null,
    distanceKm: 0,
    durationSec: (w.estimatedDurationMin ?? 0) * 60,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
  };
}

const byDay = (wk: Week): Workout[] =>
  [...(wk.triWorkouts ?? [])].sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));

/** The main.ts launch refresh: hyroxConfig.mtlCTL / mtlATL for the current week. */
function refreshLikeMain(s: SimulatorState): void {
  const { mtlCTL, mtlATL } = computeMTLFitnessFatigue(s.wks, s.w - 1);
  s.hyroxConfig!.mtlCTL = mtlCTL;
  s.hyroxConfig!.mtlATL = mtlATL;
}

/**
 * Home / Readiness call with every non-MTL signal neutral, fed the MTL ratio
 * the way the views read it (hyroxMtlAcwr). Returns the readiness result.
 */
function readinessWithMtl(s: SimulatorState) {
  return computeReadiness({ tsb: 0, acwr: 1, ctlNow: 50, weeksOfHistory: 8, mtlAcwr: hyroxMtlAcwr(s)?.ratio ?? null });
}

interface Sample { band: AbilityBand; week: number; phase: string; when: 'mid' | 'end'; ratio: number | null; floor: string | null }

/** Plan-compliant athlete: every earlier week complete; the current week half done, then fully done. */
function complianceSamples(band: AbilityBand, lastWeek: number): Sample[] {
  const s = hyroxState(band);
  const out: Sample[] = [];
  for (let week = 1; week <= lastWeek; week++) {
    s.w = week;
    const wk = s.wks[week - 1];
    const sessions = byDay(wk);
    const half = Math.ceil(sessions.length / 2);
    sessions.slice(0, half).forEach(w => complete(wk, w));
    refreshLikeMain(s);
    out.push({ band, week, phase: wk.ph, when: 'mid', ratio: hyroxMtlAcwr(s)?.ratio ?? null, floor: readinessWithMtl(s).hardFloor });
    sessions.slice(half).forEach(w => complete(wk, w));
    refreshLikeMain(s);
    out.push({ band, week, phase: wk.ph, when: 'end', ratio: hyroxMtlAcwr(s)?.ratio ?? null, floor: readinessWithMtl(s).hardFloor });
  }
  return out;
}

describe('HYROX MTL load ratio for a plan-compliant athlete', () => {
  it('base phase, every band, weeks 1 to 8: the readiness MTL floor never fires', () => {
    const fired = BANDS.flatMap(b => complianceSamples(b, 8))
      .filter(x => x.phase === 'base' && x.floor === 'mtlLoad');
    expect(fired).toEqual([]);
  });

  it(`withholds the ratio until ${ROLLING_ACWR_MIN_OBSERVED_DAYS} days of plan weeks are complete`, () => {
    const minWeeks = ROLLING_ACWR_MIN_OBSERVED_DAYS / 7;
    for (const b of BANDS) {
      const samples = complianceSamples(b, minWeeks + 1);
      for (const x of samples.filter(x => x.week <= minWeeks)) {
        expect(x.ratio, `${b} week ${x.week} ${x.when}`).toBeNull();
        expect(x.floor).not.toBe('mtlLoad');
      }
      expect(samples.filter(x => x.week === minWeeks + 1).every(x => x.ratio != null)).toBe(true);
    }
  });

  it('never reaches the Ease Back level (ratio above 1.5) across the full 16-week plan', () => {
    const over = BANDS.flatMap(b => complianceSamples(b, 16)).filter(x => x.ratio != null && x.ratio > 1.5);
    expect(over).toEqual([]);
  });

  it('the ratio, the chronic and acute values and the stored main.ts values come from one computation', () => {
    const s = hyroxState('intermediate');
    for (let week = 1; week <= 6; week++) {
      s.w = week;
      byDay(s.wks[week - 1]).forEach(w => complete(s.wks[week - 1], w));
    }
    refreshLikeMain(s);
    const r = hyroxMtlAcwr(s)!;
    expect(r.chronic).toBe(s.hyroxConfig!.mtlCTL);
    expect(r.acute).toBe(s.hyroxConfig!.mtlATL);
    expect(r.ratio).toBeCloseTo(r.acute / r.chronic, 12);
    const series = computeMTLFitnessFatigueSeries(s.wks, s.w - 1);
    expect(series).toHaveLength(6);
    expect(series[5]).toEqual({ mtlCTL: r.chronic, mtlATL: r.acute }); // the MTL page's trend ends on the printed numbers
    const split = computeMTLFitnessFatigueByDiscipline(s.wks, s.w - 1);
    expect(split.runMtlCTL + split.stationMtlCTL + split.brickMtlCTL + split.ergMtlCTL).toBeCloseTo(r.chronic, 9);
    expect(split.runMtlATL + split.stationMtlATL + split.brickMtlATL + split.ergMtlATL).toBeCloseTo(r.acute, 9);
  });
});

describe('HYROX MTL load ratio still reports a real ramp', () => {
  it('easy runs only for four weeks, then every session in week 5: the floor holds readiness at Ease Back', () => {
    const s = hyroxState('intermediate');
    for (let week = 1; week <= 4; week++) {
      s.w = week;
      byDay(s.wks[week - 1]).filter(w => w.n === 'Easy Run').forEach(w => complete(s.wks[week - 1], w));
    }
    s.w = 5;
    byDay(s.wks[4]).forEach(w => complete(s.wks[4], w));
    refreshLikeMain(s);

    const r = hyroxMtlAcwr(s)!;
    expect(r.ratio).not.toBeNull();
    expect(r.ratio!).toBeGreaterThan(1.5);
    const result = readinessWithMtl(s);
    expect(result.hardFloor).toBe('mtlLoad');
    expect(result.score).toBe(34);
  });

  it('is HYROX only', () => {
    const s = hyroxState('intermediate');
    s.eventType = 'triathlon';
    expect(hyroxMtlAcwr(s)).toBeNull();
  });
});
