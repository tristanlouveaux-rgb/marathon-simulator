/**
 * The HYROX beginner load step reads only ratings the athlete entered (lane
 * H2b review). Tracking side feeding a planning rule.
 *
 * The step follows strength-progression's suggestNextWeight: a station climbs
 * one plate when the last station session holding it was rated easier than
 * its target RPE. Before the fix the load memory read wk.rated, which also
 * holds deriveRPE's estimate when a synced HIIT recording fills a station
 * slot. A technique session with 2 min rest after every set averages a low
 * heart rate (heart-rate reserve under 0.5 reads RPE 3), so a beginner's
 * loads climbed every time a station recurred in base and build without the
 * athlete rating anything.
 *
 * Real initializer, real matchAndAutoComplete, real completeStrengthSession
 * (guided 1-tap RPE through events.ts rate()). The renderer and saveState are
 * stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getMutableState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Workout } from '@/types';
import type { HyroxStation } from '@/types/triathlon';
import { generateHyroxPlan } from './plan_engine.hyrox';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { athleteRatedRpe, noteRatingSource } from '@/calculations/athlete-rating';
import { completeStrengthSession } from '@/guided/strength-complete';
import { isInAppActual } from '@/calculations/in-app-activity';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

const MS_DAY = 86400000;

/** A beginner woman's 16-week plan whose week 6 is the current week: week 5
 *  (base, both sleds at 50% of race weight) is the week before. */
function beginnerAtWeek6(): SimulatorState {
  resetState();
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox',
    hyroxFormat: 'open_singles', experienceLevel: 'intermediate', triTimeAvailableHoursPerWeek: 5,
    planDurationWeeks: 16, customRaceDate: null, previousHyroxTimeSec: 8662, hyroxPreviousTimeFormat: 'open_singles',
    biologicalSex: 'female',
  } as OnboardingState);
  const s = getMutableState();
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const start = new Date(monday.getTime() - 5 * 7 * MS_DAY);
  s.planStartDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  s.w = 6;
  s.maxHR = 190;
  s.restingHR = 60;
  return s;
}

const tech = (s: SimulatorState, w: number) => s.wks[w - 1].triWorkouts!.find(x => x.t === 'hyrox_station_technique')!;
const loadsOf = (w: Workout | undefined): Partial<Record<HyroxStation, number>> => Object.fromEntries(
  (w?.hyroxComponents ?? []).filter(c => c.loadKg != null).map(c => [c.type, c.loadKg!]),
);

/** A synced HIIT recording of week 5's technique session on its planned day. */
function hiitRow(s: SimulatorState, over: Partial<GarminActivityRow> = {}): GarminActivityRow {
  const t = tech(s, 5);
  const [y, m, d] = s.planStartDate!.split('-').map(Number);
  const day = new Date(y, m - 1, d + 4 * 7 + (t.dayOfWeek ?? 0), 12, 0, 0);
  return {
    garmin_id: 'strava-hiit-1', activity_type: 'HIIT', activity_name: 'Station work', start_time: day.toISOString(),
    duration_sec: Math.round((t.estimatedDurationMin ?? 30) * 60), distance_m: 0, avg_pace_sec_km: null,
    // Heart-rate reserve (110 - 60) / (190 - 60) = 0.38: deriveRPE reads RPE 3.
    avg_hr: 110, max_hr: 140, calories: null, aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null,
    ...over,
  } as GarminActivityRow;
}

/** Week 6's technique session after a rebuild. */
const week6Loads = (s: SimulatorState) => loadsOf(generateHyroxPlan(s)[5].triWorkouts!.find(x => x.t === 'hyrox_station_technique'));

describe('the beginner load step reads the athlete\'s own rating', () => {
  it('a week-5 station slot auto-matched with an HR-derived RPE 3 holds the week-6 loads', () => {
    const s = beginnerAtWeek6();
    const t = tech(s, 5);
    expect(loadsOf(t)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
    matchAndAutoComplete([hiitRow(s)]);
    expect(s.wks[4].rated[t.id!]).toBe(3);
    expect(athleteRatedRpe(s.wks[4], t.id!)).toBeUndefined();
    expect(week6Loads(s)).toMatchObject({ sled_push: 50, sled_pull: 37.5 });
  });

  it('a guided 1-tap RPE of 3 on the same slot climbs each of its stations one plate', () => {
    const s = beginnerAtWeek6();
    completeStrengthSession(tech(s, 5), { rpe: 3, targetWeek: 5 });
    expect(athleteRatedRpe(s.wks[4], tech(s, 5).id!)).toBe(3);
    expect(week6Loads(s)).toMatchObject({ sled_push: 52.5, sled_pull: 40 });
  });

  it('the guided rating stays when the watch recording of the same session syncs later', () => {
    const s = beginnerAtWeek6();
    const t = tech(s, 5);
    completeStrengthSession(t, { rpe: 3, targetWeek: 5 });
    const inApp = s.wks[4].garminActuals![t.id!];
    expect(isInAppActual(inApp)).toBe(true);
    // The watch read the session harder (RPE 6 by heart-rate reserve 0.77).
    matchAndAutoComplete([hiitRow(s, { start_time: inApp.startTime!, avg_hr: 160 })]);
    expect(s.wks[4].garminActuals![t.id!].garminId).toBe('strava-hiit-1');
    expect(s.wks[4].rated[t.id!]).toBe(3);
    expect(week6Loads(s)).toMatchObject({ sled_push: 52.5, sled_pull: 40 });
  });

  it('a watch self-reported RPE of 3 is the athlete\'s own and climbs', () => {
    const s = beginnerAtWeek6();
    matchAndAutoComplete([hiitRow(s, { avg_hr: 160, garmin_rpe: 3 })]);
    expect(athleteRatedRpe(s.wks[4], tech(s, 5).id!)).toBe(3);
    expect(week6Loads(s)).toMatchObject({ sled_push: 52.5, sled_pull: 40 });
  });
});

describe('athleteRatedRpe', () => {
  it('counts an entry only while wk.rated still holds the athlete\'s number', () => {
    const wk = { rated: {} as Record<string, number | 'skip'> };
    wk.rated.a = 3;
    noteRatingSource(wk, 'a', 'user');
    expect(athleteRatedRpe(wk, 'a')).toBe(3);
    // A writer that does not note its source supersedes the entry.
    wk.rated.a = 4;
    expect(athleteRatedRpe(wk, 'a')).toBeUndefined();
    // A derived rating clears it; a skip never counts.
    wk.rated.a = 3;
    noteRatingSource(wk, 'a', 'derived');
    expect(athleteRatedRpe(wk, 'a')).toBeUndefined();
    wk.rated.b = 'skip';
    noteRatingSource(wk, 'b', 'user');
    expect(athleteRatedRpe(wk, 'b')).toBeUndefined();
    expect(athleteRatedRpe(undefined, 'a')).toBeUndefined();
  });
});
