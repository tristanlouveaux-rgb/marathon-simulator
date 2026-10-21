/**
 * Today's strain and the weekly total value each activity with one rule (D9,
 * 2026-10-21).
 *
 * computeTodaySignalBTSS priced an activity record with no iTRIMP that is not
 * a rated strength session at RPE 5 whatever its rating, while the weekly total
 * (computeWeekRawTSS, signalBActualTSS) used the rating. A 60-minute HR-less
 * session rated 8 read 69 TSS on the day and 133 in the week. Both now call
 * signalBActualTSS / signalBAdhocTSS.
 */
import { describe, it, expect } from 'vitest';
import { computeTodaySignalBTSS, computeWeekRawTSS, normalizeiTrimp } from './fitness-model';
import { TL_PER_MIN } from '@/constants';
import { localDateKey } from '@/utils/local-date';
import type { Week } from '@/types/state';

// Monday 28 Sep 2026 to Sunday 4 Oct 2026, local noon starts.
const day = (i: number) => new Date(2026, 8, 28 + i, 12, 0, 0);
const key = (i: number) => localDateKey(day(i));

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
      // HYROX station session completed in-app: no heart rate, rated 8.
      'hx-density': record('guided-manual-hx-density', 0, 60, { activityType: 'OTHER' }) as any,
      // Gym session with heart rate, rated 7: Signal B's strength override.
      'gym-1': record('gym-1', 1, 60, { activityType: 'STRENGTH_TRAINING', avgHR: 120, iTrimp: 3000 }) as any,
      // HR-less ride rated 'skip': no rating, RPE 5.
      'ride-1': record('ride-1', 2, 90, { activityType: 'CYCLING' }) as any,
      // Run with iTRIMP, unrated.
      'run-1': record('run-1', 3, 45, { activityType: 'RUNNING', avgHR: 150, iTrimp: 9000 }) as any,
    },
    adhocWorkouts: [
      { id: 'manual-padel-1', t: 'cross', n: 'Padel', d: '60min', r: 6, rpe: 6, dayOfWeek: 4 } as any,
    ],
  } as unknown as Week;
}

describe('day and week price an activity the same way', () => {
  it('a rated HR-less session reads its rating on the day, as in the week', () => {
    const wk = week();
    expect(computeTodaySignalBTSS(wk, key(0))).toBe(Math.round(60 * TL_PER_MIN[8])); // 133, was 69
  });

  it('each rule on its own day', () => {
    const wk = week();
    expect(computeTodaySignalBTSS(wk, key(1))).toBe(Math.round(60 * TL_PER_MIN[7])); // strength override
    expect(computeTodaySignalBTSS(wk, key(2))).toBe(Math.round(90 * TL_PER_MIN[5])); // 'skip' is no rating
    expect(computeTodaySignalBTSS(wk, key(3))).toBe(Math.round(normalizeiTrimp(9000)));
    expect(computeTodaySignalBTSS(wk, key(4))).toBe(Math.round(60 * TL_PER_MIN[6])); // manual adhoc entry
  });

  it('the seven days sum to the weekly total (one activity a day, no double-day bonus)', () => {
    const wk = week();
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => computeTodaySignalBTSS(wk, key(i)));
    const sum = days.reduce((a, b) => a + b, 0);
    // Each day rounds on its own; the week rounds once.
    expect(Math.abs(sum - computeWeekRawTSS(wk, wk.rated))).toBeLessThanOrEqual(3);
  });
});
