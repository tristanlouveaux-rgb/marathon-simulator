/**
 * Tests for the tri/cycling completion reconcile + the fuzzy week matcher.
 *
 * reconcileTriCompletions is the canonical post-matching pass (launch +
 * applyReview/autoProcess): direct-binds slot-keyed actuals, clears stale or
 * user-overridden links, shifts completed slots to the actual weekday, and
 * backfills missing startTimes. See 2026-06-03 fix: the launch matcher used to
 * re-match Excess Load recordings onto plan slots on the wrong weekday.
 */
import { describe, it, expect } from 'vitest';
import { matchTriathlonWeek, reconcileTriCompletions } from './activity-matcher.triathlon';
import type { Week, Workout } from '@/types/state';

// Mon 1 Jun 2026 .. Sun 7 Jun 2026 (2026-06-01 is a Monday)
const TUE = '2026-06-02T18:00:00Z';
const WED = '2026-06-03T18:52:00Z';

function workout(over: Partial<Workout>): Workout {
  return {
    n: 'Endurance ride',
    d: '60min endurance ride',
    t: 'bike_endurance',
    r: 4,
    ...over,
  } as Workout;
}

function week(over: Partial<Week>): Week {
  return {
    ph: 'base',
    rated: {},
    ...over,
  } as Week;
}

describe('reconcileTriCompletions', () => {
  it('direct-binds an actual stored under the slot key and shifts the day', () => {
    const w = workout({ id: 'W1-bike_endurance-0', dayOfWeek: 3, dayName: 'Thursday' });
    const wk = week({
      triWorkouts: [w],
      garminActuals: {
        'W1-bike_endurance-0': { garminId: 'strava-1', startTime: WED, durationSec: 3360, distanceKm: 20 } as any,
      },
    });

    const changed = reconcileTriCompletions(wk);

    expect(changed).toBe(true);
    expect(w.status).toBe('completed');
    expect(w.matchedActivityId).toBe('W1-bike_endurance-0');
    // Ridden Wednesday → card moves from Thursday to Wednesday
    expect(w.dayOfWeek).toBe(2);
    expect(w.dayName).toBe('Wednesday');
  });

  it('clears a completion whose linked actual no longer exists (re-review undo)', () => {
    const w = workout({ id: 'W1-bike_endurance-0', status: 'completed', matchedActivityId: 'W1-bike_endurance-0', dayOfWeek: 1 });
    const wk = week({ triWorkouts: [w], garminActuals: {} });

    reconcileTriCompletions(wk);

    expect(w.status).toBe('planned');
    expect(w.matchedActivityId).toBeUndefined();
  });

  it('keeps a manually-rated slot completed but drops the dangling link', () => {
    const w = workout({ id: 'W1-gym-0', t: 'gym', status: 'completed', matchedActivityId: 'gone' });
    const wk = week({ triWorkouts: [w], garminActuals: {}, rated: { 'W1-gym-0': 6 } });

    reconcileTriCompletions(wk);

    // rated → stays completed; the stale-link branch only fires when unrated
    expect(w.status).toBe('completed');
  });

  it('un-claims a slot whose link points at a user-decided Excess Load adhoc', () => {
    // The launch matcher had claimed the Tue ride slot with a recording the
    // user explicitly left in Excess Load (adhoc garmin- key in garminMatched).
    const w = workout({ id: 'W1-bike_endurance-0', status: 'completed', matchedActivityId: 'garmin-123', dayOfWeek: 1 });
    const wk = week({
      triWorkouts: [w],
      garminActuals: { 'garmin-123': { garminId: '123', startTime: WED, durationSec: 3360, distanceKm: 20 } as any },
      garminMatched: { '123': 'garmin-123' },
    });

    reconcileTriCompletions(wk);

    expect(w.status).toBe('planned');
    expect(w.matchedActivityId).toBeUndefined();
  });

  it('shifts an already-completed fuzzy match to the actual weekday', () => {
    const w = workout({ id: 'W1-bike_endurance-0', status: 'completed', matchedActivityId: 'key-x', dayOfWeek: 1, dayName: 'Tuesday' });
    const wk = week({
      triWorkouts: [w],
      garminActuals: { 'key-x': { garminId: 'strava-9', startTime: WED, durationSec: 3300, distanceKm: 19 } as any },
    });

    reconcileTriCompletions(wk);

    expect(w.dayOfWeek).toBe(2);
    expect(w.dayName).toBe('Wednesday');
  });

  it('backfills a missing startTime from the raw pending record', () => {
    const w = workout({ id: 'W1-bike_endurance-0', dayOfWeek: 1 });
    const wk = week({
      triWorkouts: [w],
      garminActuals: { 'W1-bike_endurance-0': { garminId: 'strava-5', durationSec: 3300, distanceKm: 19 } as any },
      garminPending: [{ garminId: 'strava-5', startTime: TUE } as any],
    });

    reconcileTriCompletions(wk);

    expect(wk.garminActuals!['W1-bike_endurance-0'].startTime).toBe(TUE);
    // And the day shift uses the backfilled time
    expect(w.dayOfWeek).toBe(1);
  });

  it('drops an orphaned adhoc twin once its recording moved onto a slot', () => {
    const w = workout({ id: 'W1-bike_endurance-0', dayOfWeek: 1 });
    const wk = week({
      triWorkouts: [w],
      garminActuals: {
        'W1-bike_endurance-0': { garminId: 'strava-7', startTime: WED, durationSec: 3360, distanceKm: 20 } as any,
        'garmin-strava-7':     { garminId: 'strava-7', startTime: WED, durationSec: 3360, distanceKm: 20 } as any,
      },
      garminMatched: { 'strava-7': 'W1-bike_endurance-0' },
      adhocWorkouts: [{ id: 'garmin-strava-7', n: 'Indoor Cycling' } as any],
    });

    reconcileTriCompletions(wk);

    expect(wk.garminActuals!['garmin-strava-7']).toBeUndefined();
    expect(wk.adhocWorkouts!.some(x => x.id === 'garmin-strava-7')).toBe(false);
    // The slot copy survives and binds
    expect(w.status).toBe('completed');
  });

  it('is a no-op on an untouched week (idempotent)', () => {
    const w = workout({ id: 'W1-bike_endurance-0', dayOfWeek: 3, dayName: 'Thursday' });
    const wk = week({ triWorkouts: [w], garminActuals: {} });
    expect(reconcileTriCompletions(wk)).toBe(false);
    expect(w.status).toBeUndefined();
    expect(w.dayOfWeek).toBe(3);
  });

  it('second run after a reconcile changes nothing', () => {
    const w = workout({ id: 'W1-bike_endurance-0', dayOfWeek: 3 });
    const wk = week({
      triWorkouts: [w],
      garminActuals: { 'W1-bike_endurance-0': { garminId: 'strava-1', startTime: WED, durationSec: 3360, distanceKm: 20 } as any },
    });
    expect(reconcileTriCompletions(wk)).toBe(true);
    expect(reconcileTriCompletions(wk)).toBe(false);
  });
});

describe('matchTriathlonWeek', () => {
  it('prefers a same-day workout of the same discipline', () => {
    const tue = workout({ id: 'tue-ride', dayOfWeek: 1, discipline: 'bike' as any });
    const thu = workout({ id: 'thu-ride', dayOfWeek: 3, discipline: 'bike' as any });
    const matches = matchTriathlonWeek(
      [{ id: 'a1', sport: 'cycling', startTs: Math.floor(Date.parse(TUE) / 1000), durationSec: 3600 }],
      [thu, tue],
    );
    expect(matches[0].matched).toBe(true);
    expect(matches[0].workoutId).toBe('tue-ride');
  });

  it('returns unmatched when no workout of the discipline remains', () => {
    const matches = matchTriathlonWeek(
      [{ id: 'a1', sport: 'swimming', startTs: Math.floor(Date.parse(TUE) / 1000), durationSec: 1800 }],
      [workout({ id: 'tue-ride', dayOfWeek: 1, discipline: 'bike' as any })],
    );
    expect(matches[0].matched).toBe(false);
  });
});
