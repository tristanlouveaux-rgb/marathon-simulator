/**
 * Triathlon / cycling per-discipline fitness prices a session without heart
 * rate on the canonical table, as the weekly and daily load numbers do.
 *
 * Regression (Tristan, 2026-10-06; Load Currency Law): estimateTss in
 * tri-benchmarks-from-history.ts valued an activity with no iTRIMP on a private
 * per-minute scale (swim 0.9, bike 1.0, run 1.1, other 0.6). The same unrated
 * hour read 54 / 60 / 66 / 36 TSS in tri fitness (CTL, ATL, cross-training
 * ATL, readiness) and 69 in computeWeekRawTSS (TL_PER_MIN[5]), and a rating was
 * ignored. triActivityTss now reads TL_PER_MIN at the rated RPE, RPE 5 when
 * unrated, and the launch refresh attaches each synced activity's rating
 * (withTriRatedRpe) the way Signal B reads it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TL_PER_MIN } from '@/constants';
import { computeWeekRawTSS, normalizeiTrimp, setAthleteNormalizer } from '@/calculations/fitness-model';
import {
  triActivityTss,
  estimateDirectPerDisciplineCTLFromActivities,
  estimatePerDisciplineCTLFromActivities,
  withTriRatedRpe,
  triRatedRpeByGarminId,
  inAppGpsRunActivities,
} from './tri-benchmarks-from-history';
import { CTL_TAU_DAYS, ATL_TAU_DAYS } from '@/constants/triathlon-constants';
import type { GarminActual, Week } from '@/types/state';

beforeEach(() => setAthleteNormalizer()); // population normalizer

const REF = '2026-10-07T12:00:00.000Z';
const START = '2026-10-07T08:00:00.000Z'; // same day as REF: no decay

/** A synced activity row as loadActivitiesFromDB returns it, no heart rate. */
function row(garminId: string, activityType: string, minutes: number, extra: Partial<GarminActual> = {}): GarminActual {
  return {
    garminId, activityType, startTime: START, durationSec: minutes * 60, distanceKm: 0,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, ...extra,
  } as GarminActual;
}

/** Day-0 contribution as the EMA sums store it ((tss / tau) x 7, 0.1 precision). */
const atDay0 = (tss: number, tau: number) => Math.round((tss / tau) * 7 * 10) / 10;

describe('triActivityTss: heart-rate-less sessions on the canonical table', () => {
  it('an unrated hour is TL_PER_MIN[5] x 60 for every sport (was 54 / 60 / 66 / 36)', () => {
    for (const type of ['LAP_SWIMMING', 'CYCLING', 'RUNNING', 'HIIT']) {
      expect(triActivityTss(row('x', type, 60)), type).toBeCloseTo(60 * TL_PER_MIN[5], 6);
    }
  });

  it('a rated session is priced at its rated row', () => {
    expect(triActivityTss({ ...row('x', 'CYCLING', 60), ratedRpe: 7 })).toBeCloseTo(60 * TL_PER_MIN[7], 6);
    expect(triActivityTss({ ...row('x', 'HIIT', 45), ratedRpe: 3 })).toBeCloseTo(45 * TL_PER_MIN[3], 6);
  });

  it('heart rate (iTRIMP) still wins over any rating', () => {
    expect(triActivityTss({ ...row('x', 'CYCLING', 60, { iTrimp: 9000 }), ratedRpe: 9 })).toBe(normalizeiTrimp(9000));
  });

  it('per-discipline CTL / ATL and cross-training ATL read the canonical value', () => {
    const direct = estimateDirectPerDisciplineCTLFromActivities(
      [row('a', 'CYCLING', 60), row('b', 'LAP_SWIMMING', 60), row('c', 'HIIT', 60)], REF,
    );
    const hour = 60 * TL_PER_MIN[5];
    expect(direct.bike.ctl).toBe(atDay0(hour, CTL_TAU_DAYS));
    expect(direct.swim.atl).toBe(atDay0(hour, ATL_TAU_DAYS));
    expect(direct.crossTrainingAtl).toBe(atDay0(hour, ATL_TAU_DAYS));
    // Matrix version (race-prediction inputs, fitness history) shares the valuation.
    const matrix = estimatePerDisciplineCTLFromActivities([row('a', 'CYCLING', 60)], REF);
    expect(matrix.bike.ctl).toBe(atDay0(hour, CTL_TAU_DAYS));
  });
});

describe('tri fitness and Signal B agree on the same heart-rate-less activity', () => {
  function weekWith(rated?: number): Week {
    return {
      w: 1,
      garminActuals: { 'W1-bike-0': row('strava-1', 'CYCLING', 60) },
      rated: rated == null ? {} : { 'W1-bike-0': rated },
    } as unknown as Week;
  }

  for (const rated of [undefined, 4, 7]) {
    it(`slot ${rated == null ? 'unrated' : `rated ${rated}`}: computeWeekRawTSS == tri per-activity TSS`, () => {
      const wk = weekWith(rated);
      const [dbRow] = withTriRatedRpe([row('strava-1', 'CYCLING', 60)], [wk]);
      expect(Math.round(triActivityTss(dbRow))).toBe(computeWeekRawTSS(wk, wk.rated));
    });
  }
});

describe('triRatedRpeByGarminId: the RPE Signal B prices each activity at', () => {
  it('reads the rating under the record key; unrated records are left out', () => {
    const wks = [{
      garminActuals: { slotA: row('g1', 'CYCLING', 60), slotB: row('g2', 'RUNNING', 40) },
      rated: { slotA: 6, slotB: 'skip' },
    }] as unknown as Week[];
    const m = triRatedRpeByGarminId(wks);
    expect(m.get('g1')).toBe(6);
    expect(m.has('g2')).toBe(false);
  });

  it("a strength session's own RPE tag wins over the slot rating", () => {
    const wks = [{
      garminActuals: { gym: row('g3', 'STRENGTH_TRAINING', 50, { rpe: 8 }) },
      rated: { gym: 5 },
    }] as unknown as Week[];
    expect(triRatedRpeByGarminId(wks).get('g3')).toBe(8);
  });

  it('a logged adhoc session counts only when no record holds the activity', () => {
    const wks = [{
      garminActuals: { slotA: row('g4', 'CYCLING', 60) },
      adhocWorkouts: [
        { id: 'garmin-g4', t: 'cross', n: 'Ride', d: '60min', r: 7, rpe: 7 },
        { id: 'garmin-g5', t: 'cross', n: 'Padel', d: '90min', r: 6, rpe: 6 },
      ],
      rated: {},
    }] as unknown as Week[];
    const m = triRatedRpeByGarminId(wks);
    expect(m.has('g4')).toBe(false); // the record is unrated: Signal B prices it at RPE 5
    expect(m.get('g5')).toBe(6);
  });

  it('withTriRatedRpe leaves unrated activities untouched', () => {
    const a = row('g9', 'CYCLING', 60);
    const [out] = withTriRatedRpe([a], [{ garminActuals: {}, rated: {} } as unknown as Week]);
    expect(out).toBe(a);
  });
});

describe('in-app GPS runs carry their rating into tri fitness', () => {
  it('a rated phone-recorded run is priced at its rated row', () => {
    const wks = [{
      garminActuals: { 'W1-easy-0': row('guided-gps_abc', 'RUNNING', 50) },
      rated: { 'W1-easy-0': 6 },
    }] as unknown as Week[];
    const [run] = inAppGpsRunActivities(wks);
    expect(run.ratedRpe).toBe(6);
    expect(triActivityTss(run)).toBeCloseTo(50 * TL_PER_MIN[6], 6);
  });
});
