/**
 * The AI coach plan skeleton reports each week's actual load from that week's
 * activities (computeWeekActualTSS, the Plan bar's Signal B), not from the
 * retired add-only wk.actualTSS running total (audit B18, item F6).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildPlanSkeleton } from '../coach-context-builder';
import { computeWeekActualTSS, setAthleteNormalizer, getAthleteNormalizer } from '@/calculations/fitness-model';
import { getDefaultState } from '@/state/store';
import type { GarminActual, SimulatorState, Week } from '@/types';

beforeEach(() => setAthleteNormalizer());

function week(w: number, actuals: Record<string, GarminActual> = {}): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
    garminActuals: actuals,
  } as Week;
}

function run(garminId: string, tss: number): GarminActual {
  return {
    garminId,
    startTime: '2026-09-15T07:00:00.000Z',
    distanceKm: 10,
    durationSec: 3000,
    avgPaceSecKm: 300,
    avgHR: 150,
    maxHR: 170,
    calories: null,
    iTrimp: (tss * getAthleteNormalizer()) / 100,
    activityType: 'RUNNING',
  } as GarminActual;
}

describe('buildPlanSkeleton: running actual_tss is derived from the week activities', () => {
  it('past and current weeks carry their Signal B; a stale stored total and future weeks do not leak', () => {
    const s: SimulatorState = getDefaultState();
    s.eventType = undefined as any;
    s.w = 2;
    s.wks = [
      week(1, { 'W1-easy-0': run('strava-1', 70) }),
      week(2, { 'W2-easy-0': run('strava-2', 40) }),
      week(3),
    ];
    (s.wks[0] as any).actualTSS = 240; // re-reviewed three times under the old running total
    (s.wks[2] as any).actualTSS = 55;  // a legacy value on a future week

    const skel = buildPlanSkeleton(s);
    expect(skel[0].actual_tss).toBe(70);
    expect(skel[0].actual_tss).toBe(computeWeekActualTSS(s.wks[0], s.planStartDate));
    expect(skel[1].actual_tss).toBe(40); // current week: load so far
    expect(skel[2].actual_tss).toBeNull();
  });
});
