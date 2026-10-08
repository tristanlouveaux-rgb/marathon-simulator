/**
 * Race week keeps the §CE primer whenever it holds a run (visual QA 2026-10-08,
 * scenario "fewer-runs"; SCIENCE_LOG §CE, §CV.4, §CW.2).
 *
 * Before: a sharpening block on a tight budget (4 runs chosen, about 15 km a
 * week synced, a 2-hour weekly target, a marathon 5 weeks out) held two 25-min
 * easy runs in race week and no primer. The block's taper seated the primer only
 * when its reference week (the last loaded week) held a quality session, and the
 * binding hours target had unseated every quality session there. The primer
 * (27 min) fits the time of the easy run it replaces.
 *
 * Built with the real initializer the onboarding wizard calls
 * (initializeSimulator) and read through the Plan tab's resolver
 * (resolveWeekWorkouts), so the scheduler and the race-day rules are included.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

import { initializeSimulator } from './initialization';
import { getMutableState, resetState } from './store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { RaceDistance, SimulatorState } from '@/types';
import { resolveWeekWorkouts } from '@/ui/week-resolve';
import { planTrainingWeeks, raceWeekLayout } from '@/workouts/race-week-layout';
import { isQualityRun, PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT } from '@/workouts/race-day-rules';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorageMock.clear(); });

const DAY_MS = 86400000;
const NON_RUN = new Set(['gym', 'strength', 'cross', 'cross_training', 'rest']);
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Monday 5 October 2026, 10:00 local: the plan starts that day. */
function atPlanMonday(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 5, 10, 0));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** `weeks` weeks of synced runs: [dayOffsetInWeek, km, min], starting 2 days ago. */
function history(weekRuns: Array<[number, number, number]>): NonNullable<SimulatorState['onboardingRunHistory']> {
  const rows: Array<{ startTime: string; distKm: number; durSec: number; activityType: string }> = [];
  for (let k = 0; k < 4; k++) {
    for (const [off, km, min] of weekRuns) {
      const d = new Date(Date.now() - (2 + k * 7 + off) * DAY_MS);
      d.setHours(8, 0, 0, 0);
      rows.push({ startTime: d.toISOString(), distKm: km, durSec: min * 60, activityType: 'RUNNING' });
    }
  }
  return rows as NonNullable<SimulatorState['onboardingRunHistory']>;
}

interface Build {
  raceDistance: RaceDistance; raceDate: string; weeks: number; runsPerWeek: number;
  weeklyKm: number; weekRuns: Array<[number, number, number]>; hours?: number;
}

function build(b: Build): SimulatorState {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km', detectedWeeklyKm: b.weeklyKm, stravaHistoryAccepted: true,
    athleteArchetype: { archetype: 'consistent-runner' },
    onboardingRunHistory: history(b.weekRuns),
  });
  const r = initializeSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'running',
    trainingForEvent: true, raceDistance: b.raceDistance, selectedRace: null, hasSmartwatch: true,
    customRaceDate: b.raceDate, planDurationWeeks: b.weeks, runsPerWeek: b.runsPerWeek,
    experienceLevel: 'intermediate', pbs: { k10: 2700 }, weeklyTrainingHours: b.hours,
  } as OnboardingState);
  expect(r.success).toBe(true);
  const s = getMutableState();
  // Onboarded on the plan's Monday: a full week 1.
  s.planCreatedAt = s.planStartDate;
  s.hasCompletedOnboarding = true;
  return s;
}

const raceWeekRuns = (s: SimulatorState) =>
  resolveWeekWorkouts(s, planTrainingWeeks(s)).filter((w: any) => !NON_RUN.has(w.t));

const FEWER_RUNS: Array<[number, number, number]> = [[0, 10, 58], [3, 5, 29]];
const STEADY_40: Array<[number, number, number]> = [[0, 18, 100], [2, 8, 45], [4, 8, 45], [5, 6, 34]];

describe('race week keeps the primer on a tight budget', () => {
  it('QA scenario fewer-runs: race week holds the primer and one easy run, not two easy runs', () => {
    atPlanMonday();
    const s = build({
      raceDistance: 'marathon', raceDate: '2026-11-08', weeks: 5, runsPerWeek: 4,
      weeklyKm: 15, weekRuns: FEWER_RUNS, hours: 2,
    });
    expect(s.sharpenBlock).toBeDefined();
    expect(planTrainingWeeks(s)).toBe(5);
    const runs = raceWeekRuns(s);
    const primers = runs.filter((w: any) => isQualityRun(w));
    expect(primers.map((w: any) => w.n), runs.map((w: any) => `${w.dayName} ${w.n}`).join(', ')).toEqual(['Threshold 3×2']);
    // The primer took one easy run's place: still two runs, no long run.
    expect(runs).toHaveLength(2);
    expect(runs.filter((w: any) => w.t === 'easy')).toHaveLength(1);
    // 3 to 5 days before the Sunday race.
    const layout = raceWeekLayout(s.planStartDate!, '2026-11-08')!;
    const daysOut = layout.raceDayIndex - ((planTrainingWeeks(s) - 1) * 7 + primers[0].dayOfWeek);
    expect(daysOut).toBeGreaterThanOrEqual(PRIMER_MIN_DAYS_OUT);
    expect(daysOut).toBeLessThanOrEqual(PRIMER_MAX_DAYS_OUT);
  });
});

describe('every race weekday, 1 to 6 runs a week, sharpening blocks and full plans', () => {
  // Monday 5 October 2026 + (weeks - 1) * 7 + dow: race day in the plan's final calendar week.
  const LENGTHS: Array<[RaceDistance, number[]]> = [['marathon', [2, 5, 7, 12]], ['half', [3, 8]]];
  const PEOPLE: Array<{ label: string; weeklyKm: number; weekRuns: Array<[number, number, number]>; hours?: number }> = [
    { label: '15 km, 2 h', weeklyKm: 15, weekRuns: FEWER_RUNS, hours: 2 },
    { label: '40 km', weeklyKm: 40, weekRuns: STEADY_40 },
  ];

  it('race week holds exactly one primer, 3 to 5 days out, whenever it holds a run; none with 1 run a week', () => {
    atPlanMonday();
    const bad: string[] = [];
    let n = 0;
    for (const [rd, lengths] of LENGTHS) for (const weeks of lengths) for (const p of PEOPLE)
      for (let rw = 1; rw <= 6; rw++) for (let dow = 0; dow < 7; dow++) {
        const raceDate = isoOf(new Date(2026, 9, 5 + (weeks - 1) * 7 + dow));
        const s = build({ raceDistance: rd, raceDate, weeks, runsPerWeek: rw, weeklyKm: p.weeklyKm, weekRuns: p.weekRuns, hours: p.hours });
        const layout = raceWeekLayout(s.planStartDate!, raceDate)!;
        const runs = raceWeekRuns(s);
        const primers = runs.filter((w: any) => isQualityRun(w));
        const label = `${rd} ${weeks}wk${s.sharpenBlock ? ' block' : ''} ${p.label} ${rw}/wk race dow ${dow}: ${runs.map((w: any) => `${w.dayName} ${w.n}`).join(', ') || 'no runs'}`;
        n++;
        if (rw === 1) { if (runs.length > 0) bad.push(label); continue; }
        if (runs.length === 0 || primers.length !== 1) { bad.push(label); continue; }
        const daysOut = layout.raceDayIndex - ((layout.trainingWeeks - 1) * 7 + primers[0].dayOfWeek);
        if (daysOut < PRIMER_MIN_DAYS_OUT || daysOut > PRIMER_MAX_DAYS_OUT) bad.push(`${label} (primer ${daysOut} days out)`);
      }
    expect(n).toBe(504);
    expect(bad.slice(0, 5), `${bad.length} violations`).toEqual([]);
  });
});
