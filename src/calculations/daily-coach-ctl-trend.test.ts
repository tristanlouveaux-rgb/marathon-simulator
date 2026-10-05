/**
 * The coach's fitness trend compares like with like (audit X7 consumer check).
 *
 * ctlNow is the live same-signal CTL (Signal B). The value four weeks back used
 * to come from the Signal A CTL, which discounts cross-training by runSpec, so a
 * steady cross-trainer read as "building" (or "dipped" while Signal A double-
 * counted overflow). Both ends now come from Signal B with the same seed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeDailyCoach, type StrainContext } from './daily-coach';
import { SPORTS_DB } from '@/constants';
import { getAthleteNormalizer, setAthleteNormalizer } from './fitness-model';
import type { SimulatorState, Week, GarminActual, Workout, UnspentLoadItem } from '@/types';

const PLAN_START = '2026-03-02';   // Monday of week 1
const TODAY = '2026-04-27';        // Monday of week 9: 8 completed weeks, nothing logged this week

const REST_STRAIN: StrainContext = {
  strainPct: 0,
  isRestDay: true,
  isRestDayOverreaching: false,
  trainedToday: false,
  todayIsHard: false,
  upcomingHard: null,
  recentCrossTraining: null,
  actualTSS: 0,
};

function isoDay(offset: number): string {
  const d = new Date(PLAN_START + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** iTRIMP that normalises to `tss`: the exact inverse of normalizeiTrimp. */
const itrimpFor = (tss: number) => tss * getAthleteNormalizer() / 100;

function overflowRide(id: string, day: string): { key: string; actual: GarminActual; adhoc: Workout; unspent: UnspentLoadItem } {
  const key = `garmin-${id}`;
  const startTime = `${day}T08:00:00Z`;
  return {
    key,
    actual: {
      garminId: id, startTime, distanceKm: 40, durationSec: 100 * 60, avgPaceSecKm: null,
      avgHR: 135, maxHR: 160, calories: null, iTrimp: itrimpFor(100), hrZones: null,
      displayName: 'Cycling', activityType: 'CYCLING',
    } as GarminActual,
    adhoc: {
      id: key, t: 'cross', n: 'Cycling', d: '40.0km in 100min', r: 5, rpe: 5,
      garminTimestamp: startTime, garminDurationMin: 100, iTrimp: itrimpFor(100),
    } as unknown as Workout,
    unspent: {
      garminId: id, displayName: 'Cycling', sport: 'cycling', durationMin: 100,
      aerobic: 1.5, anaerobic: 0.5, date: day, reason: 'overflow',
    } as UnspentLoadItem,
  };
}

function trainingWeek(w: number, withRides: boolean): Week {
  const off = (w - 1) * 7;
  const garminActuals: Record<string, GarminActual> = {
    [`W${w}-long-0`]: {
      garminId: `strava-run-${w}`, startTime: `${isoDay(off + 6)}T07:00:00Z`, distanceKm: 40, durationSec: 3 * 3600,
      avgPaceSecKm: 270, avgHR: 150, maxHR: 170, calories: null, iTrimp: itrimpFor(300), hrZones: null,
      workoutName: 'Long Run', activityType: 'RUNNING',
    } as GarminActual,
  };
  const adhocWorkouts: Workout[] = [];
  const unspentLoadItems: UnspentLoadItem[] = [];
  if (withRides) {
    for (const [i, d] of [2, 4].entries()) {
      const r = overflowRide(`strava-ride-${w}-${i}`, isoDay(off + d));
      garminActuals[r.key] = r.actual;
      adhocWorkouts.push(r.adhoc);
      unspentLoadItems.push(r.unspent);
    }
  }
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals, adhocWorkouts, unspentLoadItems,
  } as unknown as Week;
}

/** 8 identical completed weeks, an empty current week, seeds equal to that steady load. */
function steadyState(withRides: boolean): SimulatorState {
  const weekly = withRides ? 300 + 2 * 100 : 300;
  const weeklyA = withRides ? 300 + 2 * 100 * SPORTS_DB.cycling.runSpec : 300;
  const wks = [...Array.from({ length: 8 }, (_, i) => trainingWeek(i + 1, withRides)), trainingWeek(9, false)];
  wks[8].garminActuals = {};
  return {
    w: 9, tw: 16, v: 45, iv: 45, rpeAdj: 0, expectedFinal: 48, rd: 'marathon', epw: 5, rw: 4, wkm: 50,
    pbs: {}, rec: null, lt: null, vo2: null, initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null, typ: 'balanced', b: 1.06, pac: { e: 330 }, skip: [], timp: 0,
    physiologyHistory: [],
    historicWeeklyTSS: Array(8).fill(Math.round(weeklyA)),
    ctlBaseline: Math.round(weeklyA),
    signalBBaseline: weekly,
    planStartDate: PLAN_START,
    wks,
  } as unknown as SimulatorState;
}

describe('Coach fitness trend uses one signal at both ends', () => {
  beforeEach(() => { setAthleteNormalizer(); vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00`)); });
  afterEach(() => { vi.useRealTimers(); });

  it('a steady cross-trainer (same run + rides every week) reads flat', () => {
    const c = computeDailyCoach(steadyState(true), REST_STRAIN);
    expect(c.signals.ctlTrend).toBe('flat');
  });

  it('a steady runner reads flat', () => {
    const c = computeDailyCoach(steadyState(false), REST_STRAIN);
    expect(c.signals.ctlTrend).toBe('flat');
  });

  it('a runner who doubled the last four weeks reads up', () => {
    const s = steadyState(false);
    for (let w = 5; w <= 8; w++) {
      const a = Object.values(s.wks[w - 1].garminActuals!)[0];
      a.iTrimp = itrimpFor(600);
    }
    const c = computeDailyCoach(s, REST_STRAIN);
    expect(c.signals.ctlTrend).toBe('up');
  });
});
