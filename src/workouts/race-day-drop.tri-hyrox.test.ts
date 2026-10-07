import { describe, it, expect } from 'vitest';
import { generateTriathlonPlan } from './plan_engine.triathlon';
import { generateHyroxPlan } from './plan_engine.hyrox';
import { dropSessionsOnOrAfterRaceDay } from './race-day-rules';
import type { SimulatorState } from '@/types';

/**
 * Mirror of the running race-day rule 1 for the stored-plan modes (approved
 * default Q15: triathlon, cycling on the tri engine, and HYROX get the
 * taper-first phases and "nothing on or after race day" now; their race-week
 * content is a follow-up). Plan week 1 starts Monday 5 October 2026.
 */

const START = '2026-10-05';

function triState(tw: number, raceDate: string): SimulatorState {
  return {
    schemaVersion: 3, eventType: 'triathlon', w: 1, tw, v: 0, iv: 0, rpeAdj: 0, expectedFinal: 0,
    rd: 'marathon', epw: 9, rw: 3, gs: 0, wkm: 0, pbs: {}, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null, currentFitness: null, forecastTime: null,
    typ: 'Balanced', b: 1.1, wks: [], pac: { e: 300, t: 240, i: 220, m: 270, r: 180 }, skip: [], timp: 0,
    planStartDate: START,
    triConfig: {
      distance: '70.3', timeAvailableHoursPerWeek: 10,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 }, bike: { hasPowerMeter: false }, swim: { cssSecPer100m: 100 },
      weeksToRace: tw, raceDate,
    },
  } as unknown as SimulatorState;
}

function hyroxState(tw: number, raceDate: string): SimulatorState {
  return {
    schemaVersion: 3, eventType: 'hyrox', w: 1, tw, v: 0, iv: 0, rpeAdj: 0, expectedFinal: 0,
    rd: 'marathon', epw: 9, rw: 3, gs: 0, wkm: 0, pbs: {}, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null, currentFitness: null, forecastTime: null,
    typ: 'Balanced', b: 1.1, wks: [], pac: { e: 300, t: 240, i: 220, m: 270, r: 180 }, skip: [], timp: 0,
    planStartDate: START,
    hyroxConfig: {
      athleteBand: 'intermediate', weeklyHoursAvailable: 8, stationAccess: 'full_gym',
      raceDate, format: 'open', mtlCap: 60,
    },
  } as unknown as SimulatorState;
}

const dayIndex = (week: number, dow: number | undefined) => (week - 1) * 7 + (dow ?? 0);

describe('dropSessionsOnOrAfterRaceDay', () => {
  it('drops race day and later in the week holding the race; leaves earlier weeks alone', () => {
    const ws = [0, 2, 4, 5, 6].map(d => ({ dayOfWeek: d }));
    // Race Saturday 14 November = week 6, day 5.
    expect(dropSessionsOnOrAfterRaceDay(ws, 6, START, '2026-11-14').map(w => w.dayOfWeek)).toEqual([0, 2, 4]);
    expect(dropSessionsOnOrAfterRaceDay(ws, 5, START, '2026-11-14')).toBe(ws);
    expect(dropSessionsOnOrAfterRaceDay(ws, 6, START, undefined)).toBe(ws);
  });
});

describe('triathlon and HYROX: nothing generated on or after race day', () => {
  it('a Saturday triathlon: no session on race day; earlier weeks unchanged', () => {
    const withRace = generateTriathlonPlan(triState(6, '2026-11-14'));
    const raceDay = dayIndex(6, 5);
    for (const wk of withRace) {
      for (const w of wk.triWorkouts ?? []) {
        expect(dayIndex(wk.w, w.dayOfWeek), `wk${wk.w} ${w.n}`).toBeLessThan(raceDay);
      }
    }
    const noRace = generateTriathlonPlan(triState(6, ''));
    expect(withRace.slice(0, 5).map(w => w.triWorkouts?.length)).toEqual(noRace.slice(0, 5).map(w => w.triWorkouts?.length));
    // Without the race date the scheduler puts a session on that Saturday.
    expect((noRace[5].triWorkouts ?? []).some(w => w.dayOfWeek === 5)).toBe(true);
  });

  it('a Thursday HYROX race: race week keeps only Monday to Wednesday', () => {
    const weeks = generateHyroxPlan(hyroxState(6, '2026-11-12'));
    const raceWeek = weeks[5].triWorkouts ?? [];
    for (const w of raceWeek) expect(w.dayOfWeek ?? 0, w.n).toBeLessThan(3);
    const noRace = generateHyroxPlan(hyroxState(6, ''));
    expect(weeks.slice(0, 5).map(w => w.triWorkouts?.length)).toEqual(noRace.slice(0, 5).map(w => w.triWorkouts?.length));
    expect((noRace[5].triWorkouts ?? []).some(w => (w.dayOfWeek ?? 0) >= 3)).toBe(true);
  });
});
