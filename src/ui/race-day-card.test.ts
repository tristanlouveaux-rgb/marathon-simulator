// @vitest-environment jsdom
/**
 * Race day shows a race-day card in every mode (visual QA 2026-10-08,
 * scenarios marathon16-race, tri-wednesday, hyrox).
 *
 * Before: the race day of running race week and of the triathlon, cycling and
 * HYROX final week read "Rest", and Home showed "Rest Day" on race day.
 *
 * The card is display only: it never enters a week's workout list, adds no
 * planned load, and rendering it leaves the plan untouched.
 *
 * Plans come from the real initializers (initializeSimulator,
 * initializeTriathlonSimulator, initializeCyclingSimulator,
 * initializeHyroxSimulator) and render through the real plan views.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/state/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { initializeSimulator } from '@/state/initialization';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { initializeCyclingSimulator } from '@/state/initialization.cycling';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getMutableState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';
import { renderPlanView } from './plan-view';
import { renderTriathlonPlanViewAtWeek } from './triathlon/plan-view';
import { renderHyroxPlanView } from './hyrox/plan-view';
import { buildTodayWorkout, buildTodayWorkoutTriathlon, buildTodayWorkoutHyrox } from './home-view';
import { resolveWeekWorkouts } from './week-resolve';
import { resolveTriWeekWorkouts } from './triathlon/week-resolve.triathlon';
import { raceDayInfo, raceDayInWeek, raceDayToday, planRaceDateISO } from './race-day-card';
import { planTrainingWeeks } from '@/workouts/race-week-layout';

// Plans start Monday 5 October 2026 (onboarding that Monday).
const PLAN_MONDAY = new Date(2026, 9, 5, 10, 0);
const pad = (n: number) => String(n).padStart(2, '0');
/** Day `dow` (0 = Monday) of plan week `week`, YYYY-MM-DD. */
function planDay(week: number, dow: number): string {
  const d = new Date(2026, 9, 5 + (week - 1) * 7 + dow);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function at(date: Date): void {
  vi.setSystemTime(date);
}

function finish(): SimulatorState {
  const s = getMutableState();
  s.planCreatedAt = s.planStartDate;
  s.hasCompletedOnboarding = true;
  return s;
}

function marathon16(): SimulatorState {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km', detectedWeeklyKm: 35, weeklyVolumeConfirmed: true,
    athleteArchetype: { archetype: 'consistent-runner' },
  });
  const r = initializeSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'running',
    trainingForEvent: true, raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: { k10: 2700 },
  } as OnboardingState);
  expect(r.success).toBe(true);
  return finish();
}

function tri703(race: string): SimulatorState {
  resetState();
  const r = initializeTriathlonSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate', customRaceDate: race,
  } as OnboardingState);
  expect(r.success).toBe(true);
  return finish();
}

function cycling160(race: string): SimulatorState {
  resetState();
  const r = initializeCyclingSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate', customRaceDate: race,
  } as OnboardingState);
  expect(r.success).toBe(true);
  return finish();
}

function hyrox(race: string): SimulatorState {
  resetState();
  const r = initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, customRaceDate: race,
  } as OnboardingState);
  expect(r.success).toBe(true);
  return finish();
}

/** The race-day cards on the rendered page. */
function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-race-day-card]'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(PLAN_MONDAY);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('running: QA scenario marathon16-race', () => {
  it('race week (week 16) shows the race-day card on Sunday instead of "Rest"; other weeks show none', () => {
    const s = marathon16();
    const race = planDay(16, 6);
    expect(planRaceDateISO(s)).toBe(race);
    expect(raceDayInfo(s)).toMatchObject({ dateISO: race, week: 16, dayOfWeek: 6, title: 'Marathon' });
    expect(raceDayInfo(s)!.detail).toBe('42.2 km · 24 Jan 2027');

    const before = JSON.stringify(s.wks);
    s.w = 16;
    renderPlanView();
    const found = cards();
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toContain('Race day');
    expect(found[0].textContent).toContain('Marathon');
    expect(found[0].textContent).toContain('42.2 km · 24 Jan 2027');
    // The Sunday strip no longer reads "Rest"; the card follows it.
    const sunday = document.getElementById('plan-day-6')!;
    expect(sunday.textContent).not.toContain('Rest');
    expect(sunday.nextElementSibling?.hasAttribute('data-race-day-card')).toBe(true);

    // Display only: no workout on race day, the plan untouched by rendering.
    expect(resolveWeekWorkouts(s, 16).some((w: any) => w.dayOfWeek === 6)).toBe(false);
    expect(JSON.stringify(s.wks)).toBe(before);

    s.w = 15;
    document.body.innerHTML = '<div id="app-root"></div>';
    renderPlanView();
    expect(cards()).toHaveLength(0);
  });

  it('Home on race day shows the race, not "Rest Day"', () => {
    const s = marathon16();
    s.w = 16;
    at(new Date(2027, 0, 24, 8, 0));
    expect(raceDayToday(s)?.dateISO).toBe('2027-01-24');
    const html = buildTodayWorkout(s);
    expect(html).toContain('Race day · 42.2 km · 24 Jan 2027');
    expect(html).toContain('Marathon');
    expect(html).not.toContain('Rest Day');
    // The day before is a normal rest day.
    at(new Date(2027, 0, 23, 8, 0));
    expect(raceDayToday(s)).toBeNull();
  });

  it('a picked race shows its name', () => {
    const s = marathon16();
    s.selectedMarathon = { id: 'x', name: 'Seville Marathon', city: 'Seville', country: 'ES', date: planDay(16, 6), distance: 'marathon' };
    expect(raceDayInfo(s)).toMatchObject({ title: 'Seville Marathon', detail: 'Marathon · 42.2 km · 24 Jan 2027' });
  });
});

describe('triathlon: QA scenario tri-wednesday (70.3, Wednesday race in week 7)', () => {
  it('the closing week shows the card on Wednesday; race week (week 6) shows none', () => {
    const race = planDay(7, 2);
    const s = tri703(race);
    expect(s.tw).toBe(7);
    expect(planTrainingWeeks(s)).toBe(6);
    expect(raceDayInWeek(s, 7)).toMatchObject({ dayOfWeek: 2, title: '70.3 triathlon' });
    expect(raceDayInfo(s)!.detail).toBe('1.9 km swim, 90 km bike, 21.1 km run · 18 Nov 2026');

    const before = JSON.stringify(s.wks);
    renderTriathlonPlanViewAtWeek(7, s.w);
    const found = cards();
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toContain('70.3 triathlon');
    // The Wednesday row holds the card and no "Rest" tag.
    const wedRow = found[0].closest('.tri-day-row') as HTMLElement;
    expect(wedRow.getAttribute('data-tri-day-drop')).toBe('2');
    expect(wedRow.textContent).not.toContain('Rest');
    // Display only.
    expect(resolveTriWeekWorkouts(s, 7)).toHaveLength(0);
    expect(JSON.stringify(s.wks)).toBe(before);

    document.body.innerHTML = '<div id="app-root"></div>';
    renderTriathlonPlanViewAtWeek(6, s.w);
    expect(cards()).toHaveLength(0);
  });

  it('a Sunday race: the card sits on Sunday of race week; Home shows it on race day', () => {
    const race = planDay(6, 6);
    const s = tri703(race);
    expect(s.tw).toBe(6);
    renderTriathlonPlanViewAtWeek(6, s.w);
    expect(cards()).toHaveLength(1);
    expect((cards()[0].closest('.tri-day-row') as HTMLElement).getAttribute('data-tri-day-drop')).toBe('6');

    s.w = 6;
    at(new Date(2026, 10, 15, 8, 0));
    const html = buildTodayWorkoutTriathlon(s);
    expect(html).toContain('Race day · 1.9 km swim, 90 km bike, 21.1 km run · 15 Nov 2026');
    expect(html).not.toContain('Rest Day');
  });
});

describe('cycling (triathlon engine)', () => {
  it('160 km event on a Saturday: the card names the event distance', () => {
    const race = planDay(8, 5);
    const s = cycling160(race);
    expect(raceDayInfo(s)).toMatchObject({ week: 8, dayOfWeek: 5, title: '160 km', detail: '28 Nov 2026' });
    renderTriathlonPlanViewAtWeek(8, s.w);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain('160 km');
  });
});

describe('HYROX: QA scenario hyrox (Saturday race in week 12)', () => {
  it('race week shows the card on Saturday instead of "Rest"; Home shows it on race day', () => {
    const race = planDay(12, 5);
    const s = hyrox(race);
    expect(raceDayInfo(s)).toMatchObject({ week: 12, dayOfWeek: 5, title: 'HYROX', detail: 'Open Singles · 26 Dec 2026' });

    const before = JSON.stringify(s.wks);
    s.w = 12;
    renderHyroxPlanView();
    const found = cards();
    expect(found).toHaveLength(1);
    const satRow = found[0].closest('.hx-day-row') as HTMLElement;
    expect(satRow.getAttribute('data-hx-day-drop')).toBe('5');
    expect(satRow.textContent).not.toContain('Rest');
    expect(resolveTriWeekWorkouts(s, 12).some(w => w.dayOfWeek === 5)).toBe(false);
    expect(JSON.stringify(s.wks)).toBe(before);

    at(new Date(2026, 11, 26, 8, 0));
    const html = buildTodayWorkoutHyrox(s);
    expect(html).toContain('Race day · Open Singles · 26 Dec 2026');
    expect(html).not.toContain('Rest Day');
  });
});

describe('no race date, no card', () => {
  it('continuous and Just-Track plans have no race day', () => {
    const s = marathon16();
    expect(raceDayInfo({ ...s, continuousMode: true })).toBeNull();
    expect(raceDayInfo({ ...s, trackOnly: true })).toBeNull();
  });
});
