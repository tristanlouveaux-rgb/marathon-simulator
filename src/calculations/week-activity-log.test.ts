import { describe, it, expect } from 'vitest';
import { collectWeekActivities, disciplineFromType } from './week-activity-log';
import type { Week } from '@/types';

// Minimal Week factory — only the fields the gatherer reads.
function wk(over: Partial<Week>): Week {
  return { w: 1, ph: 'base', rated: {}, wkGain: 0, ...(over as any) } as Week;
}

describe('disciplineFromType', () => {
  it('maps raw activity types to disciplines', () => {
    expect(disciplineFromType('RUNNING')).toBe('run');
    expect(disciplineFromType('TRAIL_RUNNING')).toBe('run');
    expect(disciplineFromType('CYCLING')).toBe('bike');
    expect(disciplineFromType('INDOOR_CYCLING')).toBe('bike');
    expect(disciplineFromType('ride')).toBe('bike');
    expect(disciplineFromType('OPEN_WATER_SWIMMING')).toBe('swim');
    expect(disciplineFromType('Tennis')).toBeNull();
    expect(disciplineFromType(null)).toBeNull();
    expect(disciplineFromType(undefined)).toBeNull();
  });
});

describe('collectWeekActivities', () => {
  it('returns [] for an undefined week or an empty week', () => {
    expect(collectWeekActivities(undefined)).toEqual([]);
    expect(collectWeekActivities(wk({}))).toEqual([]);
  });

  it('marks a plan-slot match "matched" with discipline + slot name', () => {
    const w = wk({
      garminActuals: {
        'W1-Mon-Easy': {
          garminId: 'strava-1', startTime: '2026-05-20T08:00:00Z',
          distanceKm: 8, durationSec: 2400, avgPaceSecKm: 300, avgHR: 140,
          workoutName: 'Easy Run', displayName: 'Morning Run', activityType: 'RUNNING',
        } as any,
      },
    });
    const [e] = collectWeekActivities(w);
    expect(e.badge).toBe('matched');
    expect(e.discipline).toBe('run');
    expect(e.name).toBe('Morning Run');
    expect(e.slotName).toBe('Easy Run');
    expect(e.durationMin).toBe(40);
    expect(e.source).toBe('actual');
  });

  it('shows an orphaned garmin-* actual as "logged", or "excess" when flagged', () => {
    const base = {
      garminId: 'strava-9', startTime: '2026-05-21T08:00:00Z',
      distanceKm: 5, durationSec: 1800, avgPaceSecKm: 360, avgHR: 130,
      displayName: 'Extra Ride', activityType: 'CYCLING',
    } as any;
    const logged = collectWeekActivities(wk({ garminActuals: { 'garmin-strava-9': base } }));
    expect(logged[0].badge).toBe('logged');
    expect(logged[0].discipline).toBe('bike');

    const excess = collectWeekActivities(wk({
      garminActuals: { 'garmin-strava-9': base },
      unspentLoadItems: [{ garminId: 'strava-9' }] as any,
    }));
    expect(excess[0].badge).toBe('excess');
  });

  it('dedups a garmin-* actual that still has a live adhoc workout (renders the adhoc once)', () => {
    const w = wk({
      garminActuals: {
        'garmin-strava-7': { garminId: 'strava-7', startTime: '2026-05-22T08:00:00Z', distanceKm: 6, durationSec: 2100, avgPaceSecKm: 350, avgHR: 0 } as any,
      },
      adhocWorkouts: [
        { id: 'garmin-strava-7', n: 'Lunch Run', t: 'easy', garminDistKm: 6, garminDurationMin: 35, garminTimestamp: '2026-05-22T08:00:00Z', activityType: 'RUNNING' } as any,
      ],
    });
    const entries = collectWeekActivities(w);
    expect(entries.length).toBe(1);
    expect(entries[0].source).toBe('adhoc');
    expect(entries[0].name).toBe('Lunch Run');
    expect(entries[0].discipline).toBe('run');
  });

  it('includes pending (unreviewed) activities flagged in garminMatched', () => {
    const w = wk({
      garminMatched: { 'p-1': '__pending__' },
      garminPending: [
        { garminId: 'p-1', activityType: 'WALKING', appType: 'walk', startTime: '2026-05-23T08:00:00Z', durationSec: 1200, distanceM: 2000, avgHR: 100, maxHR: 120, aerobicEffect: null, anaerobicEffect: null, garminRpe: null, calories: null } as any,
      ],
    });
    const [e] = collectWeekActivities(w);
    expect(e.badge).toBe('pending');
    expect(e.source).toBe('pending');
    expect(e.key).toBe('pending-p-1');
  });

  it('does not include pending items that are no longer flagged __pending__', () => {
    const w = wk({
      garminMatched: { 'p-2': 'W1-Mon-Easy' },
      garminPending: [
        { garminId: 'p-2', activityType: 'RUNNING', appType: 'run', startTime: '2026-05-23T08:00:00Z', durationSec: 1200, distanceM: 4000, avgHR: 140, maxHR: 160, aerobicEffect: null, anaerobicEffect: null, garminRpe: null, calories: null } as any,
      ],
    });
    expect(collectWeekActivities(w)).toEqual([]);
  });

  it('sorts entries newest first', () => {
    const w = wk({
      garminActuals: {
        'garmin-a': { garminId: 'a', startTime: '2026-05-20T08:00:00Z', distanceKm: 5, durationSec: 1800, avgPaceSecKm: null, avgHR: null, displayName: 'Older' } as any,
        'garmin-b': { garminId: 'b', startTime: '2026-05-25T08:00:00Z', distanceKm: 5, durationSec: 1800, avgPaceSecKm: null, avgHR: null, displayName: 'Newer' } as any,
      },
    });
    const names = collectWeekActivities(w).map(e => e.name);
    expect(names).toEqual(['Newer', 'Older']);
  });
});
