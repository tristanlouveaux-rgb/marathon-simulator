// @vitest-environment jsdom
/**
 * "Plan complete" never shows on or before race day.
 *
 * Before: fireDebriefIfReady's end-of-plan trigger opened the final week's
 * 'complete' debrief on the first launch where s.w >= s.tw, with no date check.
 * Its CTA read "View plan summary" and led to "Plan complete." plus "Start a
 * new plan" on race eve (a Tuesday race, launched on the closing week's
 * Monday) or six days before a Sunday race (launched on race week's Monday).
 * The Sunday auto-show and the Wrap up week button reached the same screen.
 *
 * Now a running race plan's completion screen waits until race day is behind
 * the local calendar (planCompletionDue). Checked through the real
 * initializeSimulator for races on every weekday, a sharpening block and a
 * full plan, launched on every day of the last two calendar weeks and the
 * Monday after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('./renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer')>()),
  render: vi.fn(),
  log: vi.fn(),
}));
vi.mock('@/ui/main-view', () => ({ renderMainView: vi.fn() }));
vi.mock('@/ui/wizard/controller', () => ({ resetOnboarding: vi.fn() }));

import { fireDebriefIfReady, showWeekDebrief } from './week-debrief';
import { isWeekPendingDebrief } from './welcome-back';
import { initializeSimulator } from '@/state/initialization';
import { getMutableState, getState, setState, resetState } from '@/state/store';
import { planCompletionDue } from '@/workouts/race-week-layout';
import { addCalendarDays, calendarDayNumber } from '@/utils/local-date';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types';

const COMPLETION_TEXT = ['Plan complete', 'View plan summary', 'Start a new plan'];

function onboarding(o: Partial<OnboardingState>): OnboardingState {
  return {
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: 'marathon',
    runsPerWeek: 4,
    pbs: { k10: 2700 },
    experienceLevel: 'intermediate',
    ...o,
  } as OnboardingState;
}

function at(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 10, 0);
}

/** Every text the debrief shows, clicking Continue through the analysis to the last screen. */
function clickThrough(): string {
  let seen = document.body.textContent ?? '';
  for (let i = 0; i < 3; i++) {
    const btn = document.getElementById('debrief-continue') as HTMLButtonElement | null;
    if (!btn) break;
    btn.click();
    vi.advanceTimersByTime(20_000);
    seen += document.body.textContent ?? '';
  }
  return seen;
}

/** Build a plan on Wednesday 7 October 2026 for `raceISO`, as a frozen copy. */
function buildPlan(raceISO: string, rd: 'marathon' | 'half'): SimulatorState {
  resetState();
  vi.setSystemTime(at('2026-10-07'));
  const weeks = Math.ceil((calendarDayNumber(raceISO) - calendarDayNumber('2026-10-05') + 1) / 7);
  const r = initializeSimulator(onboarding({ raceDistance: rd, customRaceDate: raceISO, planDurationWeeks: weeks }));
  expect(r.success).toBe(true);
  const s = getMutableState() as any;
  s.hasCompletedOnboarding = true;
  return JSON.parse(JSON.stringify(getState()));
}

/** Launch on `todayISO` with every earlier week debriefed, then run one debrief path. */
function launch(plan: SimulatorState, todayISO: string, path: 'launch' | 'sunday'): { text: string; w: number; tw: number } {
  document.body.innerHTML = '';
  setState(JSON.parse(JSON.stringify(plan)));
  vi.setSystemTime(at(todayISO));
  const s = getMutableState() as any;
  const calWeek = Math.floor((calendarDayNumber(todayISO) - calendarDayNumber(s.planStartDate)) / 7) + 1;
  s.w = Math.min(calWeek, s.tw);
  s.lastDebriefWeek = s.w - 1;
  s.lastCompleteDebriefWeek = s.w - 1;
  if (path === 'launch') fireDebriefIfReady(isWeekPendingDebrief());
  else showWeekDebrief(s.w, 'complete'); // Sunday auto-show and Wrap up week
  return { text: clickThrough(), w: s.w, tw: s.tw };
}

// Races in the week of Monday 16 November 2026 (blocks) and of Monday 14 December 2026 (full half plans).
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CASES: Array<{ label: string; rd: 'marathon' | 'half'; weekMonday: string }> = [
  { label: 'marathon sharpening block', rd: 'marathon', weekMonday: '2026-11-16' },
  { label: 'full half-marathon plan', rd: 'half', weekMonday: '2026-12-14' },
];

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('planCompletionDue', () => {
  it('a running race plan completes only after race day; plans without a race date are not gated', () => {
    const race = { selectedMarathon: null, onboarding: { customRaceDate: '2026-11-17' } };
    expect(planCompletionDue(race, '2026-11-16')).toBe(false);
    expect(planCompletionDue(race, '2026-11-17')).toBe(false);
    expect(planCompletionDue(race, '2026-11-18')).toBe(true);
    expect(planCompletionDue({ continuousMode: true, onboarding: { customRaceDate: '2026-11-17' } }, '2026-11-01')).toBe(true);
    expect(planCompletionDue({ eventType: 'triathlon', onboarding: { customRaceDate: '2026-11-17' } }, '2026-11-01')).toBe(true);
    expect(planCompletionDue({ onboarding: { customRaceDate: null } }, '2026-11-01')).toBe(true);
  });
});

for (const c of CASES) {
  describe(`${c.label}: Plan complete never shows on or before race day`, () => {
    for (let d = 0; d < 7; d++) {
      const raceISO = addCalendarDays(c.weekMonday, d);
      it(`${WEEKDAYS[d]} race (${raceISO}), launched each day of the last two calendar weeks and the Monday after`, () => {
        const plan = buildPlan(raceISO, c.rd);
        const raceDay = calendarDayNumber(raceISO);
        const tw = plan.tw;
        const finalMonday = addCalendarDays(plan.planStartDate!, (tw - 1) * 7);
        // The last calendar week holds race day.
        expect(raceDay - calendarDayNumber(finalMonday)).toBeGreaterThanOrEqual(0);
        expect(raceDay - calendarDayNumber(finalMonday)).toBeLessThan(7);

        let completedAfterRace = 0;
        for (let i = -7; i <= 7; i++) {
          const today = addCalendarDays(finalMonday, i);
          const onOrBefore = calendarDayNumber(today) <= raceDay;
          for (const path of ['launch', 'sunday'] as const) {
            const r = launch(plan, today, path);
            if (path === 'sunday') expect(r.text, `debrief rendered on ${today}`).toContain(`Week ${r.w}`);
            const shown = COMPLETION_TEXT.filter(t => r.text.includes(t));
            if (onOrBefore) {
              expect(shown, `${path} on ${today} (race ${raceISO}, week ${r.w} of ${r.tw})`).toEqual([]);
            } else if (r.w >= r.tw) {
              // After race day the final week's debrief closes the plan.
              expect(r.text, `${path} on ${today} (race ${raceISO})`).toContain('Plan complete');
              completedAfterRace++;
            }
          }
        }
        expect(completedAfterRace).toBeGreaterThan(0);
      });
    }
  });
}
