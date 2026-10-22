// @vitest-environment jsdom
/**
 * The weekly load breakdown values each activity by the weekly total's rule
 * and sums to it (2026-10-22, E4).
 *
 * computeLoadBreakdown (Plan load sheet, Load & Taper, Just-Track week detail)
 * kept its own rule: iTRIMP, else minutes at the rating, with no strength
 * override, and no double-day bonus. A rated strength session with heart rate
 * showed its roughly 20 TSS iTRIMP against 107 in the total
 * (computeWeekRawTSS). It now calls signalBActualTSS / signalBAdhocTSS, and the
 * week's double-day bonus is its own segment, last.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { computeLoadBreakdown, DOUBLE_DAY_SEGMENT_LABEL } from './home-view';
import { computeWeekRawTSS, normalizeiTrimp } from '@/calculations/fitness-model';
import { computeWeekDoubleDayBonus } from '@/calculations/double-day';
import { TL_PER_MIN } from '@/constants';
import type { Week } from '@/types';

const PLAN_START = '2026-09-28';
const day = (i: number, h = 12) => new Date(2026, 8, 28 + i, h, 0, 0);

function record(id: string, i: number, min: number, extra: Record<string, unknown> = {}) {
  return {
    garminId: id, startTime: day(i).toISOString(), durationSec: min * 60, distanceKm: 0,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, ...extra,
  };
}

function week(): Week {
  return {
    w: 1, ph: 'base', skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    rated: { 'hx-density': 8, 'gym-1': 7, 'ride-1': 'skip' },
    garminActuals: {
      'hx-density': record('guided-manual-hx-density', 0, 60, { activityType: 'OTHER', displayName: 'Station Density' }) as any,
      'gym-1': record('gym-1', 1, 60, { activityType: 'STRENGTH_TRAINING', avgHR: 120, iTrimp: 3000, displayName: 'Strength' }) as any,
      'ride-1': record('ride-1', 2, 90, { activityType: 'CYCLING', displayName: 'Cycling' }) as any,
      'run-1': record('run-1', 3, 45, { activityType: 'RUNNING', avgHR: 150, iTrimp: 9000, workoutName: 'Easy Run' }) as any,
    },
    adhocWorkouts: [
      { id: 'manual-padel-1', t: 'cross', n: 'Padel', d: '60min', r: 6, rpe: 6, dayOfWeek: 4 } as any,
    ],
  } as unknown as Week;
}

const sum = (wk: Week) => computeLoadBreakdown(wk, wk.rated ?? {}, PLAN_START).reduce((a, seg) => a + seg.tss, 0);
const seg = (wk: Week, label: string) => computeLoadBreakdown(wk, wk.rated ?? {}, PLAN_START).find(x => x.label === label);

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

describe('load breakdown: the weekly total\'s per-activity rule', () => {
  it('a rated strength session with heart rate counts its strength override', () => {
    expect(seg(week(), 'Strength')!.tss).toBeCloseTo(60 * TL_PER_MIN[7], 6); // was normalizeiTrimp(3000)
  });

  it('a rated HR-less session counts its rating; a skip is no rating', () => {
    expect(seg(week(), 'Station Density')!.tss).toBeCloseTo(60 * TL_PER_MIN[8], 6);
    expect(seg(week(), 'Cycling')!.tss).toBeCloseTo(90 * TL_PER_MIN[5], 6);
    expect(seg(week(), 'Running')!.tss).toBeCloseTo(normalizeiTrimp(9000), 6);
    expect(seg(week(), 'Padel')!.tss).toBeCloseTo(60 * TL_PER_MIN[6], 6);
  });

  it('the segments sum to computeWeekRawTSS (one activity a day: no bonus row)', () => {
    const wk = week();
    expect(seg(wk, DOUBLE_DAY_SEGMENT_LABEL)).toBeUndefined();
    expect(Math.round(sum(wk))).toBe(computeWeekRawTSS(wk, wk.rated, PLAN_START));
  });

  it('a double day: the bonus is its own segment, last, and the segments sum to the total', () => {
    const wk = week();
    // The gym session moves onto day 0, three hours after the HYROX session.
    (wk.garminActuals as any)['gym-1'].startTime = day(0, 15).toISOString();
    const bonus = computeWeekDoubleDayBonus(wk, PLAN_START);
    expect(bonus).toBeGreaterThan(0);
    const segs = computeLoadBreakdown(wk, wk.rated, PLAN_START);
    const last = segs[segs.length - 1];
    expect(last.label).toBe(DOUBLE_DAY_SEGMENT_LABEL);
    expect(last.doubleDay).toBe(true);
    expect(last.tss).toBe(bonus);
    expect(last.durationMin).toBe(0);
    expect(Math.round(sum(wk))).toBe(computeWeekRawTSS(wk, wk.rated, PLAN_START));
  });

  it('an adhoc entry dedups by its garmin- prefix only, as the total does', () => {
    const wk = week();
    wk.adhocWorkouts = [
      ...(wk.adhocWorkouts ?? []),
      // A synced entry whose record carries the same garmin id: counted once.
      { id: 'garmin-run-1', t: 'cross', n: 'Run', d: '45min', r: 5, iTrimp: 9000 } as any,
    ];
    expect(Math.round(sum(wk))).toBe(computeWeekRawTSS(wk, wk.rated, PLAN_START));
  });
});
