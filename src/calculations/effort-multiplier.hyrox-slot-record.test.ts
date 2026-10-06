/**
 * HYROX effort multiplier: the under-duration guard reads the session's slot record.
 *
 * f1 gave HYROX sessions ids, and hyroxTrailingEffortScore skips id-less
 * sessions, so the multiplier went live for HYROX with v14 (SCIENCE_LOG §AU).
 * Its under-duration guard read wk.garminActuals[matchedActivityId], which
 * HYROX never sets: the matcher, GPS runs, Mark as Done and quick done key the
 * record by the slot id. The guard saw nothing, so a week of sessions cut to
 * half length and rated easy raised the multiplier to 1.15 and week 2
 * regenerated at 235 planned minutes instead of 220.
 *
 * Real generator, real regenerateHyroxWeek. Records are written the way the
 * HYROX completion paths write them: under the slot id.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState } from '@/state/store';
import { generateHyroxPlan, regenerateHyroxWeek, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { TRI_EFFORT_MULT_BOUNDS } from '@/constants/triathlon-constants';
import { hyroxEffortMultiplier, hyroxTrailingEffortScore } from './effort-multiplier.hyrox';
import type { SimulatorState, Week, Workout } from '@/types/state';

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
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

const plannedRpe = (w: Workout): number => (w as { rpe?: number }).rpe ?? w.r!;
const weekMinutes = (wk: Week): number =>
  (wk.triWorkouts ?? []).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);

/** Rate every week-1 session `rpeDelta` from plan and write its slot record at `durationShare` of planned. */
function rateWeekOne(s: SimulatorState, rpeDelta: number, durationShare: number): void {
  const wk = s.wks[0];
  wk.rated = {};
  wk.garminActuals = {};
  for (const w of wk.triWorkouts ?? []) {
    wk.rated[w.id!] = plannedRpe(w) + rpeDelta;
    wk.garminActuals[w.id!] = {
      garminId: `guided-manual-${w.id}`, startTime: null, distanceKm: 0,
      durationSec: (w.estimatedDurationMin ?? 0) * 60 * durationShare,
      avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
    };
  }
  s.w = 2;
}

describe('HYROX effort multiplier on a real plan', () => {
  it('generated sessions carry ids and no match link, so records sit on the slot key', () => {
    const s = hyroxState();
    for (const w of s.wks[0].triWorkouts ?? []) {
      expect(w.id).toBeTruthy();
      expect(w.matchedActivityId).toBeUndefined();
    }
  });

  it('sessions rated easy but cut to half length leave the multiplier at 1.0', () => {
    const s = hyroxState();
    const plannedWeek2 = weekMinutes(s.wks[1]);
    rateWeekOne(s, -3, 0.5);
    expect(hyroxTrailingEffortScore(s)).toBe(0);
    expect(hyroxEffortMultiplier(s)).toBe(1);
    expect(weekMinutes(regenerateHyroxWeek(s, 2)!)).toBe(plannedWeek2);
  });

  it('a genuine easy rating at full duration still raises next week', () => {
    const s = hyroxState();
    const plannedWeek2 = weekMinutes(s.wks[1]);
    rateWeekOne(s, -3, 1);
    expect(hyroxTrailingEffortScore(s)).toBe(-3);
    expect(hyroxEffortMultiplier(s)).toBe(TRI_EFFORT_MULT_BOUNDS[1]);
    expect(weekMinutes(regenerateHyroxWeek(s, 2)!)).toBeGreaterThan(plannedWeek2);
  });

  it('a hard rating on a cut-short session still lowers next week (the guard only clamps easy ratings)', () => {
    const s = hyroxState();
    rateWeekOne(s, +2, 0.5);
    expect(hyroxTrailingEffortScore(s)).toBe(2);
    expect(hyroxEffortMultiplier(s)).toBeCloseTo(0.9, 10);
  });
});
