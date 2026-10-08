// @vitest-environment jsdom
/**
 * The Plan header names the week being viewed, in every mode (visual QA,
 * 2026-10-08). Running reads the viewed week (plan-view.ts "Week N of M").
 * Before the fix the triathlon and HYROX headers read the live week (s.w), so
 * previewing week 3 read "Week 1 of 7" under week 3's phase label.
 *
 * Real initializers (initializeTriathlonSimulator, initializeHyroxSimulator),
 * real plan views in jsdom; persistence is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import { renderTriathlonPlanViewAtWeek } from './triathlon/plan-view';
import { renderHyroxPlanView } from './hyrox/plan-view';

const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers({ toFake: ['Date'] });
  // Thursday 8 October 2026: plan week 1 starts Monday 5 October.
  vi.setSystemTime(new Date('2026-10-08T12:00:00'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  resetState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const heroText = () => document.getElementById('app-root')!.textContent ?? '';

describe('Plan header shows the viewed week', () => {
  it('triathlon: previewing week 3 reads "Week 3 of 7" with week 3\'s phase', () => {
    initializeTriathlonSimulator({
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: '2026-11-18',
    } as OnboardingState);
    const s = getState();
    expect(s.w).toBe(1);
    expect(s.tw).toBe(7);
    renderTriathlonPlanViewAtWeek(3, s.w);
    const text = heroText();
    expect(text).toContain('Week 3 of 7');
    expect(text).not.toContain('Week 1 of 7');
    expect(text).toContain(capitalize(s.wks[2].ph));
    // The live week still reads its own number.
    renderTriathlonPlanViewAtWeek(1, s.w);
    expect(heroText()).toContain('Week 1 of 7');
  });

  it('HYROX: tapping the week 5 pill reads "Week 5 of 12" with week 5\'s phase', () => {
    initializeHyroxSimulator({
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8, customRaceDate: '2026-12-26',
    } as OnboardingState);
    const s = getState();
    expect(s.w).toBe(1);
    expect(s.tw).toBe(12);
    renderHyroxPlanView();
    expect(heroText()).toContain('Week 1 of 12');
    const pill = document.querySelector<HTMLElement>('[data-hx-week-nav="5"]');
    expect(pill).not.toBeNull();
    pill!.click();
    const text = heroText();
    expect(text).toContain('Week 5 of 12');
    expect(text).not.toContain('Week 1 of 12');
    expect(text).toContain(capitalize(s.wks[4].ph));
  });
});
